// 承認のやりとりができる起動のしかた（1行1つの JSON-RPC）で、エージェントの CLI を動かす
//
//   Codex: codex app-server（独自の JSON-RPC。"jsonrpc" の欄はない）
//   ACP（Agent Client Protocol）: cursor-agent acp / gemini --experimental-acp / opencode acp / copilot --acp /
//          amp-acp / pi-acp（起動のしかたは providers.js の ACP_LAUNCH）
//
// どれも「stdin / stdout で話し続ける → エージェントが、操作の前にこちらへ許可を聞いてくる」形。
// 許可は permit() に、選択肢の質問は ask() に渡すので、Claude Code と同じカードの承認・質問になる。
//   質問: Codex は item/tool/requestUserInput、Cursor は独自の cursor/ask_question（ACP の標準にはまだない）
//   btw: Codex は turn/steer で作業の途中に足す。ACP は途中に足せないので、session/cancel で止めて、btw を次のターンとして送る
//   金額: ACP の usage_update の cost（会話の合計）を { type: 'cost' } で渡す
// 出力は providers.js と同じ共通の形（アクション）に直して emit() に渡す。

const { createParser, todoItems, trunc } = require('./providers');
const { tr } = require('../renderer/i18n');

const JSONRPC_METHOD_NOT_FOUND = -32601;

function errorText(err) {
  if (!err) return '';
  const data = err.data && typeof err.data === 'object' ? err.data.message : err.data;
  return String(data || err.message || err);
}

// 行き来の土台: id の付いた問い合わせと、エージェントからの問い合わせ（requests）・お知らせ（onNotify）を振り分ける
class Rpc {
  constructor({ write, jsonrpc, requests, onNotify }) {
    this.write = write;
    this.jsonrpc = jsonrpc;
    this.requests = requests;
    this.onNotify = onNotify;
    this.nextId = 1;
    this.waiting = new Map();
    this.closed = false;
  }

  frame(m) {
    if (this.closed) return;
    this.write(`${JSON.stringify(this.jsonrpc ? { jsonrpc: '2.0', ...m } : m)}\n`);
  }

  call(method, params) {
    const id = this.nextId++;
    this.frame({ id, method, params });
    return new Promise((resolve, reject) => this.waiting.set(id, { resolve, reject }));
  }

  notify(method, params) {
    this.frame({ method, ...(params ? { params } : {}) });
  }

  async onMessage(m) {
    if (!m || typeof m !== 'object') return;
    if (m.method && m.id != null) {
      const h = this.requests[m.method];
      if (!h) {
        this.frame({ id: m.id, error: { code: JSONRPC_METHOD_NOT_FOUND, message: `Method not found: ${m.method}` } });
        return;
      }
      try {
        this.frame({ id: m.id, result: await h(m.params || {}) });
      } catch (err) {
        this.frame({ id: m.id, error: { code: -32000, message: errorText(err) } });
      }
      return;
    }
    if (m.method) {
      this.onNotify(m.method, m.params || {});
      return;
    }
    const w = this.waiting.get(m.id);
    if (!w) return;
    this.waiting.delete(m.id);
    if (m.error) w.reject(new Error(errorText(m.error)));
    else w.resolve(m.result || {});
  }

  close(reason) {
    this.closed = true;
    for (const w of this.waiting.values()) w.reject(new Error(reason || 'closed'));
    this.waiting.clear();
  }
}

const allowed = (d) => !!d && d.behavior === 'allow';

// ---------- Codex（codex app-server） ----------

// 権限モードごとの動かし方。app-server で動かすのは、途中で許可を聞く必要があるモードだけ
//   default:     コマンドもファイルの変更も毎回聞く
//   acceptEdits: worktree の中の編集と sandbox の中のコマンドはそのまま動き、そこから出るときだけ聞く
//                （Codex は読み取りも cat などのコマンドで行うので、コマンドを毎回聞くと動かなくなる）
function codexApprovalPolicy(mode) {
  if (mode === 'default') return { approvalPolicy: 'untrusted', sandbox: 'workspace-write' };
  if (mode === 'acceptEdits') return { approvalPolicy: 'on-request', sandbox: 'workspace-write' };
  return null;
}

// `/bin/zsh -lc 'touch a'` のように包まれたコマンドから、中身だけを出す
function codexCommand(p) {
  const action = Array.isArray(p.commandActions) && p.commandActions.length === 1 ? p.commandActions[0] : null;
  if (action && typeof action.command === 'string' && action.command) return action.command;
  if (Array.isArray(p.command)) return p.command.join(' ');
  return String(p.command || '');
}

// app-server の項目を、codex exec --json の形に直す（読み取りは codexParser と同じものを使う）
function codexItem(item) {
  if (!item) return {};
  switch (item.type) {
    case 'agentMessage':
      return { id: item.id, type: 'agent_message', text: item.text };
    case 'commandExecution': {
      const declined = item.status === 'declined';
      const failed = declined || item.status === 'failed' ? 'failed' : item.status;
      const output = declined ? tr('ユーザーが拒否しました') : item.aggregatedOutput;
      return { id: item.id, type: 'command_execution', command: codexCommand(item), status: failed, exit_code: item.exitCode, aggregated_output: output };
    }
    case 'fileChange':
      if (item.status === 'declined') return {};
      return { id: item.id, type: 'file_change', changes: (item.changes || []).map((c) => ({ path: c.path, kind: (c.kind && c.kind.type) || c.kind })) };
    case 'mcpToolCall':
      return { id: item.id, type: 'mcp_tool_call', server: item.server, tool: item.tool, arguments: item.arguments, status: item.status, error: item.error };
    case 'webSearch':
      return { id: item.id, type: 'web_search', query: item.query };
    default:
      return {};
  }
}

function codexSession(o) {
  const { emit, permit, finish } = o;
  const parser = createParser('codex', { summarize: o.summarize });
  const changes = new Map(); // 項目の ID → 変更するファイル（承認の問い合わせには入っていない）
  const feed = (ev) => emit(parser.onEvent(ev));
  const policy = codexApprovalPolicy(o.mode);
  let threadId = null;
  let turnId = null; // 動いているターン（btw を turn/steer で足す先）
  let turnDone = false;

  const rpc = new Rpc({
    write: o.write,
    jsonrpc: false,
    requests: {
      'item/commandExecution/requestApproval': async (p) => {
        const d = await permit({ toolName: 'Bash', input: { command: codexCommand(p), cwd: p.cwd, reason: p.reason || undefined } });
        return { decision: allowed(d) ? 'accept' : 'decline' };
      },
      'item/fileChange/requestApproval': async (p) => {
        const files = changes.get(p.itemId) || [];
        const input = { file_path: files.join(', ') || p.grantRoot || tr('（不明）'), files, reason: p.reason || undefined };
        const d = await permit({ toolName: 'Edit', input });
        return { decision: allowed(d) ? 'accept' : 'decline' };
      },
      'item/permissions/requestApproval': async (p) => {
        const d = await permit({ toolName: 'Permissions', input: { description: p.reason || tr('追加の権限'), permissions: p.permissions } });
        return { permissions: allowed(d) ? p.permissions : {}, scope: 'turn' };
      },
      // 選択肢の質問は、カードの質問のフォームに出す。答えずに続けるときは空の答えを返す
      'item/tool/requestUserInput': async (p) => {
        const qs = (Array.isArray(p.questions) ? p.questions : []).filter((q) => q && q.id && q.question);
        if (!qs.length || !o.ask) return { answers: {} };
        const got = await o.ask(qs.map((q) => ({ question: String(q.question), header: String(q.header || ''), multiSelect: false, options: Array.isArray(q.options) ? q.options : [] })));
        const answers = {};
        if (got) for (const q of qs) if (got[q.question]) answers[q.id] = { answers: [got[q.question]] };
        return { answers };
      },
      'mcpServer/elicitation/request': async () => ({ action: 'decline', content: null }),
    },
    onNotify(method, p) {
      switch (method) {
        case 'item/started':
          if (p.item && p.item.type === 'fileChange') changes.set(p.item.id, (p.item.changes || []).map((c) => c.path));
          feed({ type: 'item.started', item: codexItem(p.item) });
          break;
        case 'item/completed':
          feed({ type: 'item.completed', item: codexItem(p.item) });
          break;
        case 'turn/plan/updated': {
          const items = todoItems(p.plan);
          if (items) emit([{ type: 'todos', items }]);
          break;
        }
        case 'error':
          if (p.willRetry) break;
          if (p.error && p.error.message) emit([{ type: 'log_error', text: p.error.message }]);
          break;
        case 'turn/completed': {
          const t = p.turn || {};
          turnId = null;
          turnDone = true;
          if (t.status === 'failed') finish((t.error && t.error.message) || tr('ターンが失敗しました'));
          else finish(null);
          break;
        }
        default:
          break;
      }
    },
  });

  return {
    rpc,
    flush: () => parser.flush(),
    async start() {
      await rpc.call('initialize', { clientInfo: { name: 'worktree-kanban', title: 'Worktree Kanban', version: o.version || '0' }, capabilities: { experimentalApi: false } });
      rpc.notify('initialized');
      const params = { cwd: o.cwd, ...policy, ...(o.model ? { model: o.model } : {}) };
      const started = o.sessionId ? await rpc.call('thread/resume', { threadId: o.sessionId, ...params }) : await rpc.call('thread/start', params);
      threadId = started.thread && started.thread.id;
      if (!threadId) throw new Error(tr('Codex の会話を始められませんでした'));
      emit([{ type: 'session', id: threadId, model: started.model }]);
      const r = await rpc.call('turn/start', { threadId, input: [{ type: 'text', text: o.prompt, text_elements: [] }] });
      // ターンが終わったと先に知らせが来ていれば、もう足せない
      if (r.turn && r.turn.id && !turnDone) turnId = r.turn.id;
    },
    // 動いているターンに、作業を止めずに指示を足す（btw）。足せないときは false
    interject(text, btwId) {
      if (!threadId || !turnId) return false;
      rpc.call('turn/steer', { threadId, input: [{ type: 'text', text, text_elements: [] }], expectedTurnId: turnId }).then(
        () => o.delivered && o.delivered(btwId),
        (err) => o.undelivered && o.undelivered(btwId, err.message),
      );
      return true;
    },
  };
}

// ---------- ACP（cursor-agent acp / gemini / opencode / copilot / amp-acp / pi-acp） ----------

function acpToolName(kind, title) {
  switch (kind) {
    case 'execute':
      return 'Bash';
    case 'edit':
    case 'delete':
    case 'move':
      return 'Edit';
    case 'read':
      return 'Read';
    case 'search':
      return 'Grep';
    case 'fetch':
      return 'WebFetch';
    default:
      // 名前はエージェント側が決める文字列なので、カードの特別な名前（AskUserQuestion など）にならないよう頭に付ける
      return `Tool: ${trunc(String(title || '').replace(/`/g, ''), 60)}`;
  }
}

// ツールの呼び出しを、カードに出す名前と入力に直す
function acpToolInput(call) {
  const raw = call.rawInput && typeof call.rawInput === 'object' ? call.rawInput : {};
  const title = String(call.title || '');
  const path = raw.path || raw.file_path || (Array.isArray(call.locations) && call.locations[0] && call.locations[0].path);
  const name = acpToolName(call.kind, title);
  const reason = (Array.isArray(call.content) ? call.content : []).map((c) => c && c.content && c.content.text).filter(Boolean).join('\n');
  const input = { ...raw };
  if (name === 'Bash') input.command = String(raw.command || title.replace(/^`|`$/g, ''));
  else if (path) input.file_path = String(path);
  else if (!Object.keys(input).length) input.description = title.replace(/`/g, '');
  if (reason) input.reason = reason;
  return { name, input };
}

function acpResultText(out) {
  if (typeof out === 'string') return out;
  if (!out || typeof out !== 'object') return '';
  return [out.stdout, out.stderr, out.output, out.content].filter((x) => typeof x === 'string' && x).join('\n');
}

// 計画だけで、エージェントに読み取りだけのモードがないときも許すツール
const READ_TOOLS = new Set(['Read', 'Grep', 'WebFetch']);

// ACP の会話のモードから、計画だけのモードを探す（一覧を返さない CLI は Cursor と同じ 'plan' を試す）
function acpPlanMode(res) {
  const list = res && res.modes && Array.isArray(res.modes.availableModes) ? res.modes.availableModes : null;
  if (!list) return 'plan';
  const m = list.find((x) => x && /plan/i.test(`${x.id || ''} ${x.name || ''}`));
  return m ? m.id : null;
}

// 設定のモデル名に合うモデルの ID を探す（「provider/model」の形でも、後ろだけで合わせる）
function acpModelId(res, model) {
  const list = res && res.models && Array.isArray(res.models.availableModels) ? res.models.availableModels : [];
  const want = String(model).toLowerCase();
  const hit = (pick) => list.find((m) => m && pick(String(m.modelId || '').toLowerCase(), String(m.name || '').toLowerCase()));
  const m = hit((id) => id === want) || hit((id, name) => name === want) || hit((id) => id.endsWith(`/${want}`) || id.split(/[/[]/)[0] === want);
  return m ? m.modelId : null;
}

// 質問の答え（複数選択は「, 」でつないだもの）を、選択肢の ID に直す。選択肢にない答え（自由入力）なら null
function optionIds(options, answer) {
  const a = String(answer || '').trim();
  const byLabel = (l) => options.find((x) => x.label === l);
  if (byLabel(a)) return [byLabel(a).id];
  const parts = a.split(/,\s*/).filter(Boolean);
  const ids = parts.map((l) => byLabel(l)).filter(Boolean).map((x) => x.id);
  return parts.length && ids.length === parts.length ? ids : null;
}

function acpSession(o) {
  const { emit, permit, finish } = o;
  const calls = new Map(); // toolCallId → そこまでに分かった中身
  let text = '';
  let replaying = false; // session/load の間は、前の会話が流れてくる
  let id = null;
  let planGuard = false; // 計画だけのモードがないので、こちらで読み取り以外を断る
  let cancelling = false; // btw のために今のターンを止めているところ
  let ended = false;
  const interjections = []; // 止めたあと、次のターンとして送る btw

  const flushText = () => {
    if (text.trim()) emit([{ type: 'text', text }]);
    text = '';
  };
  const showTool = (call) => {
    if (call.shown) return;
    call.shown = true;
    flushText();
    const { name, input } = acpToolInput(call);
    emit([{ type: 'tool', name, summary: o.summarize(input) }]);
  };
  const onUpdate = (u) => {
    switch (u.sessionUpdate) {
      case 'agent_message_chunk':
        if (u.content && u.content.type === 'text') text += u.content.text || '';
        break;
      case 'plan': {
        const items = todoItems(u.entries);
        if (items) emit([{ type: 'todos', items }]);
        break;
      }
      case 'usage_update': {
        // cost は会話の合計（ドル以外の通貨は足さない）
        const cost = u.cost;
        const amount = cost && Number(cost.amount);
        if (Number.isFinite(amount) && amount >= 0 && (!cost.currency || /^usd$/i.test(cost.currency))) emit([{ type: 'cost', sessionId: id, total: amount }]);
        break;
      }
      case 'tool_call':
      case 'tool_call_update': {
        const call = { ...(calls.get(u.toolCallId) || {}), ...u };
        calls.set(u.toolCallId, call);
        // 編集のパスなどは、最初の知らせには入っていない。動き始めるところで出す
        if (u.status === 'in_progress' || u.status === 'completed' || u.status === 'failed') showTool(call);
        if (u.status === 'completed' || u.status === 'failed') {
          const body = acpResultText(u.rawOutput);
          const failed = u.status === 'failed' || (u.rawOutput && u.rawOutput.exitCode != null && u.rawOutput.exitCode !== 0);
          if (body || failed) emit([{ type: 'tool_result', text: trunc(body || tr('（終了コード {code}）', { code: (u.rawOutput && u.rawOutput.exitCode) ?? '?' }), 1500), error: !!failed }]);
          calls.delete(u.toolCallId);
        }
        break;
      }
      default:
        break;
    }
  };

  // 権限モードで決まる答え（聞かなくてよければ { behavior }、聞くなら null）
  const decided = (name) => {
    if (o.mode === 'bypassPermissions') return { behavior: 'allow' };
    if (planGuard && !READ_TOOLS.has(name)) return { behavior: 'deny' };
    return null;
  };
  const CANCELLED = { outcome: { outcome: 'cancelled' } };

  const rpc = new Rpc({
    write: o.write,
    jsonrpc: true,
    requests: {
      'session/request_permission': async (p) => {
        if (cancelling) return CANCELLED;
        const known = calls.get(p.toolCall && p.toolCall.toolCallId) || {};
        const { name, input } = acpToolInput({ ...known, ...(p.toolCall || {}) });
        const d = decided(name) || (await permit({ toolName: name, input }));
        if (cancelling) return CANCELLED;
        const options = Array.isArray(p.options) ? p.options : [];
        const pick = (...kinds) => kinds.map((k) => options.find((x) => x.kind === k)).find(Boolean);
        // 「常に許可」はカードの中で覚える。CLI の設定には書き残さない
        const opt = allowed(d) ? pick('allow_once', 'allow_always') : pick('reject_once', 'reject_always');
        return opt ? { outcome: { outcome: 'selected', optionId: opt.optionId } } : CANCELLED;
      },
      // Cursor の選択肢の質問。選択肢にない答え（自由入力）は、飛ばした理由として渡す
      'cursor/ask_question': async (p) => {
        const qs = (Array.isArray(p.questions) ? p.questions : [])
          .filter((q) => q && q.id != null && q.prompt)
          .map((q) => ({ id: q.id, question: String(q.prompt), header: '', multiSelect: !!q.allowMultiple, options: (Array.isArray(q.options) ? q.options : []).map((x) => ({ id: x.id, label: String(x.label || ''), description: '' })) }));
        if (!qs.length || !o.ask || cancelling) return { outcome: { outcome: cancelling ? 'cancelled' : 'skipped' } };
        flushText();
        const got = await o.ask(qs.map(({ question, header, multiSelect, options }) => ({ question, header, multiSelect, options: options.map(({ label, description }) => ({ label, description })) })));
        if (cancelling) return CANCELLED;
        if (!got) return { outcome: { outcome: 'skipped', reason: 'The user skipped the questions. Continue as you see fit.' } };
        const answers = qs.map((q) => ({ questionId: q.id, selectedOptionIds: optionIds(q.options, got[q.question]) }));
        if (answers.every((x) => x.selectedOptionIds)) return { outcome: { outcome: 'answered', answers } };
        const said = qs.map((q) => `${q.question} → ${got[q.question] || ''}`).join('\n');
        return { outcome: { outcome: 'skipped', reason: `The user answered in their own words:\n${said}` } };
      },
    },
    onNotify(method, p) {
      if (method === 'session/update' && !replaying && p.update && (!id || p.sessionId === id)) onUpdate(p.update);
    },
  });

  return {
    rpc,
    flush() {
      flushText();
      return [];
    },
    // 今のターンを止めて、btw を次のターンとして送る（ACP は動いているターンに足せない）。送れないときは false
    interject(textIn, btwId) {
      if (!id || ended) return false;
      interjections.push({ text: textIn, btwId });
      if (!cancelling) {
        cancelling = true;
        rpc.notify('session/cancel', { sessionId: id });
      }
      return true;
    },
    async start() {
      await rpc.call('initialize', { protocolVersion: 1, clientCapabilities: {}, clientInfo: { name: 'worktree-kanban', version: o.version || '0' } });
      let res = null;
      if (o.sessionId) {
        replaying = true;
        try {
          res = await rpc.call('session/load', { sessionId: o.sessionId, cwd: o.cwd, mcpServers: [] });
          id = o.sessionId;
        } catch (err) {
          emit([{ type: 'log_error', text: tr('前の会話を読み込めなかったので、新しい会話で始めます: {message}', { message: err.message }) }]);
        }
        replaying = false;
      }
      if (!id) {
        res = await rpc.call('session/new', { cwd: o.cwd, mcpServers: [] });
        id = res.sessionId;
        if (!id) throw new Error(tr('会話を始められませんでした'));
      }
      emit([{ type: 'session', id }]);
      if (o.mode === 'plan') {
        const mode = acpPlanMode(res);
        if (mode) await rpc.call('session/set_mode', { sessionId: id, modeId: mode }).catch(() => (planGuard = true));
        else planGuard = true;
      }
      // モデルを起動の引数で渡せない CLI は、会話に設定する
      if (o.sessionModel) {
        const modelId = acpModelId(res, o.sessionModel);
        if (!modelId) emit([{ type: 'log_error', text: tr('モデル {model} が見つからないので、CLI の既定のモデルで動かします', { model: o.sessionModel }) }]);
        else await rpc.call('session/set_model', { sessionId: id, modelId }).catch((err) => emit([{ type: 'log_error', text: tr('モデルを {model} にできませんでした: {message}', { model: o.sessionModel, message: err.message }) }]));
      }
      let prompt = o.prompt;
      for (;;) {
        const r = await rpc.call('session/prompt', { sessionId: id, prompt: [{ type: 'text', text: prompt }] });
        flushText();
        cancelling = false;
        if (interjections.length) {
          const next = interjections.splice(0);
          for (const b of next) if (o.delivered) o.delivered(b.btwId);
          prompt = next.map((b) => b.text).join('\n\n');
          continue;
        }
        ended = true;
        const stop = r.stopReason;
        if (stop === 'end_turn' || stop === 'cancelled' || !stop) finish(null);
        else finish(tr('途中で止まりました（{reason}）', { reason: stop }));
        return;
      }
    },
  };
}

/**
 * @param {'codex'|'acp'} kind
 * @param {object} o
 *   write(text)               stdin に書く
 *   emit(actions)             共通の形のアクションを渡す
 *   permit({toolName,input})  カードで許可を聞く（{ behavior } を返す）
 *   ask(questions)            カードで選択肢の質問をする（質問文 → 答え を返す。答えずに続けるときは null）
 *   delivered(btwId)          btw をエージェントに渡した
 *   undelivered(btwId, msg)   btw を途中に足せなかった（Codex）
 *   done()                    ターンが終わった（CLI を閉じてよい）
 *   mode / model / sessionModel / sessionId / cwd / prompt / summarize / version
 *     sessionModel: 起動の引数で渡せないモデル（ACP の session/set_model で設定する）
 * @returns {{ start(): Promise<void>, onMessage(m): void, flush(): object[], close(): void, interject(text, btwId): boolean, ended: boolean }}
 */
function createRpcSession(kind, opts) {
  const state = { ended: false };
  const finish = (error) => {
    if (state.ended) return;
    state.ended = true;
    if (error) opts.emit([{ type: 'result', error }]);
    else opts.emit([{ type: 'result' }]);
    opts.done();
  };
  const impl = (kind === 'codex' ? codexSession : acpSession)({ ...opts, finish });
  return {
    get ended() {
      return state.ended;
    },
    start: () =>
      impl.start().catch((err) => {
        if (!state.ended && !impl.rpc.closed) finish(err.message);
      }),
    onMessage: (m) => impl.rpc.onMessage(m),
    flush: () => impl.flush(),
    interject: (text, btwId) => !state.ended && !impl.rpc.closed && impl.interject(text, btwId),
    close: (reason) => impl.rpc.close(reason),
  };
}

/**
 * この CLI が使えるかを、会話を始めずに確かめる（Codex は版によって app-server の形が違うので、実際に thread/start まで通す）
 * @returns {{ onMessage(m): void, close(): void, run: Promise<void> }} run は使えなければ reject する
 */
function probeRpc(kind, { write, cwd, version }) {
  const rpc = new Rpc({ write, jsonrpc: kind === 'acp', requests: {}, onNotify() {} });
  const steps = async () => {
    if (kind === 'acp') {
      const r = await rpc.call('initialize', { protocolVersion: 1, clientCapabilities: {}, clientInfo: { name: 'worktree-kanban', version: version || '0' } });
      if (typeof r.protocolVersion !== 'number') throw new Error('unknown protocol');
      return;
    }
    await rpc.call('initialize', { clientInfo: { name: 'worktree-kanban', title: 'Worktree Kanban', version: version || '0' }, capabilities: { experimentalApi: false } });
    rpc.notify('initialized');
    const r = await rpc.call('thread/start', { cwd, ephemeral: true });
    if (!r.thread || !r.thread.id) throw new Error('unknown protocol');
  };
  return { onMessage: (m) => rpc.onMessage(m), close: (reason) => rpc.close(reason), run: steps() };
}

module.exports = { createRpcSession, probeRpc, codexApprovalPolicy, codexCommand, codexItem, acpToolInput, acpPlanMode, acpModelId, optionIds };
