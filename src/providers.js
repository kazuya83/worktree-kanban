// エージェント CLI（Claude Code / Codex CLI / Antigravity CLI / Gemini CLI / Cursor CLI / OpenCode / Copilot CLI / Amp / Pi / Droid）の一覧と、
// Claude Code 以外の起動のしかた・出力の読み取り
//
// どの CLI も「作業フォルダで起動 → 指示を渡す → 1行1つの JSON（JSONL）でイベントを出す」形で動かす。
// 指示は stdin で渡す（Cursor CLI・Copilot CLI は、ドキュメントどおり引数で渡す。AGENTS の promptArg）。
// 出力は CLI ごとに形が違うので、ここで共通の形（アクション）に直して agent.js に渡す:
//   { type: 'session', id, model? }        会話（セッション）の ID が分かった
//   { type: 'text', text }                  エージェントの発言
//   { type: 'tool', name, summary }         ツールの呼び出し
//   { type: 'tool_result', text, error }    ツールの結果
//   { type: 'todos', items }                エージェントの TODO リスト（進捗タブに出す。todoItems の形）
//   { type: 'log_error', text }             続けられるエラー（ログに出すだけ）
//   { type: 'result', error? }              1ターンが終わった（error があれば失敗）
//
// Claude Code は承認（--permission-prompt-tool）や実行中のメッセージ（btw）に対応しているので、
// これまでどおり agent.js の中で直接扱う
//
// Codex（codex app-server）と、ACP に対応した CLI（Cursor・Gemini・OpenCode・Copilot、アダプタがあれば Amp・Pi）の
// カードの承認・質問・btw・金額は、agent-rpc.js が JSON-RPC で話す。
// 動かす手前で使えるかを確かめ、使えない版は、ここの buildArgs の起動のしかたに戻す

const fs = require('fs');
const os = require('os');
const path = require('path');
const { tr } = require('../renderer/i18n');

const AGENTS = {
  claude: { label: 'Claude Code', short: 'Claude', defaultCmd: 'claude', pathKey: 'claudePath', modelKey: 'model' },
  codex: { label: 'Codex CLI', short: 'Codex', defaultCmd: 'codex', pathKey: 'codexPath', modelKey: 'codexModel' },
  antigravity: { label: 'Antigravity CLI', short: 'Antigravity', defaultCmd: 'agy', pathKey: 'antigravityPath', modelKey: 'antigravityModel' },
  gemini: { label: 'Gemini CLI', short: 'Gemini', defaultCmd: 'gemini', pathKey: 'geminiPath', modelKey: 'geminiModel' },
  cursor: { label: 'Cursor CLI', short: 'Cursor', defaultCmd: 'cursor-agent', pathKey: 'cursorPath', modelKey: 'cursorModel', promptArg: true },
  opencode: { label: 'OpenCode', short: 'OpenCode', defaultCmd: 'opencode', pathKey: 'opencodePath', modelKey: 'opencodeModel' },
  copilot: { label: 'Copilot CLI', short: 'Copilot', defaultCmd: 'copilot', pathKey: 'copilotPath', modelKey: 'copilotModel', promptArg: true },
  amp: { label: 'Amp', short: 'Amp', defaultCmd: 'amp', pathKey: 'ampPath', modelKey: 'ampModel' },
  pi: { label: 'Pi', short: 'Pi', defaultCmd: 'pi', pathKey: 'piPath', modelKey: 'piModel' },
  droid: { label: 'Droid', short: 'Droid', defaultCmd: 'droid', pathKey: 'droidPath', modelKey: 'droidModel' },
};
const AGENT_IDS = Object.keys(AGENTS);

function isAgent(a) {
  return Object.prototype.hasOwnProperty.call(AGENTS, a);
}
function agentLabel(a) {
  return (AGENTS[a] || AGENTS.claude).label;
}
function agentShort(a) {
  return (AGENTS[a] || AGENTS.claude).short;
}
function agentCommand(settings, a) {
  const d = AGENTS[a] || AGENTS.claude;
  return String((settings && settings[d.pathKey]) || '').trim() || d.defaultCmd;
}
// 指示を引数で渡す CLI か（そうでなければ stdin で渡す）
function promptViaArg(a) {
  return !!(AGENTS[a] && AGENTS[a].promptArg);
}
function agentModel(settings, a) {
  const d = AGENTS[a] || AGENTS.claude;
  return String((settings && settings[d.modelKey]) || '').trim();
}

// 権限モード（Claude Code の名前）。設定の「権限モード」と、CLI・MCP でタスクごとに選ぶもの
const PERMISSION_MODES = ['default', 'acceptEdits', 'plan', 'bypassPermissions'];
// 権限モードの指定を、知っている名前に直す（知らなければ空）。大文字・小文字やハイフンの違いは許す
function cleanPermissionMode(v) {
  const k = String(v || '').trim().toLowerCase().replace(/[-_\s]/g, '');
  if (!k) return '';
  if (k === 'bypass' || k === 'yolo') return 'bypassPermissions';
  return PERMISSION_MODES.find((m) => m.toLowerCase() === k) || '';
}

// 権限モード（Claude Code の名前）を、それぞれの CLI のやり方に直す。
// Antigravity / Gemini はカードでの承認に対応していないので、自動で許可されない操作は CLI 側で止められる。
// Codex / Cursor は agent-rpc.js で動かすとカードで承認できる（下は、それが使えないときの起動のしかた）
function codexPolicy(mode) {
  if (mode === 'bypassPermissions') return { bypass: true };
  return { sandbox: mode === 'plan' ? 'read-only' : 'workspace-write' };
}
function geminiApproval(mode) {
  return { plan: 'plan', bypassPermissions: 'yolo', acceptEdits: 'auto_edit', default: 'default' }[mode] || 'auto_edit';
}
// Antigravity CLI はヘッドレスだと確認を出せないので、許可されない操作はその場で拒否される（待ち続けない）。
// accept-edits なら worktree の中のファイルは書ける。コマンドは settings.json の permissions.allow に書いたものだけ動く。
// default はファイルの変更も拒否されるので、Gemini の default と同じく、変更させたくない会話などで使う
function antigravityPolicy(mode) {
  if (mode === 'plan') return ['--mode', 'plan'];
  if (mode === 'bypassPermissions') return ['--dangerously-skip-permissions'];
  if (mode === 'default') return [];
  return ['--mode', 'accept-edits'];
}
// Cursor CLI はヘッドレス（-p）だと、--force がないとファイルの変更を提案するだけで書かない。
// 「計画だけ」は plan モード（読み取りのみ）、それ以外は --force で変更を書かせる（cli-config.json の deny は守られる）
function cursorPolicy(mode) {
  if (mode === 'plan') return ['--mode', 'plan'];
  if (mode === 'bypassPermissions') return ['--force', '--approve-mcps'];
  return ['--force'];
}

// Claude Code 以外の CLI は、カードで承認できない操作を CLI 側の許可で決める。
// 「ファイル編集は自動・コマンドは確認」「毎回確認」では、確認が要る操作はヘッドレスだと断られるので、
// もともと確認なしでコマンドを動かす CLI（OpenCode / Amp / Pi）は、コマンドを止めて動かす。
// Issue・Slack から作ったタスクは「すべて許可」にならない（acceptEdits で動く）ので、外の人の指示からコマンドが動かないようにするためでもある

// OpenCode: 計画だけは plan エージェント、すべて許可は --auto（deny 以外の確認を自動で許可）。
// それ以外は、設定（OPENCODE_CONFIG_CONTENT。ふだんの設定に重ねて読まれる）でコマンドを「確認」にする（ヘッドレスでは断られる）
function opencodePolicy(mode) {
  if (mode === 'plan') return ['--agent', 'plan'];
  if (mode === 'bypassPermissions') return ['--auto'];
  return [];
}
function opencodePermission(mode) {
  if (mode === 'bypassPermissions') return null;
  if (mode === 'default') return { bash: 'ask', edit: 'ask', webfetch: 'ask' };
  if (mode === 'plan') return { bash: 'ask', edit: 'deny' };
  return { bash: 'ask' };
}
// Copilot CLI: 確認が要る操作は、ヘッドレスだと断られる（待ち続けない）。
// 計画だけ → --plan、ファイル編集は自動 → write だけ許可、すべて許可 → --allow-all（ツール・パス・URL）
function copilotPolicy(mode) {
  if (mode === 'plan') return ['--plan'];
  if (mode === 'bypassPermissions') return ['--allow-all'];
  if (mode === 'acceptEdits') return ['--allow-tool=write'];
  return [];
}
// Amp: もともと確認なしでツールを使い、読み取りだけのモードもない。止めたいツールは設定の amp.tools.disable に書く。
// ふだんの設定（MCP など）を写した設定ファイルを作って --settings-file で渡す。
//   計画だけ → ファイルを変えるツールとコマンドを止める、ファイル編集は自動・毎回確認 → コマンドを止める、すべて許可 → --dangerously-allow-all
const AMP_EDIT_TOOLS = ['edit_file', 'create_file', 'undo_edit'];
const AMP_COMMAND_TOOLS = ['Bash'];
function ampSettingsFile(name, disable) {
  let base = {};
  try {
    const home = process.env.XDG_CONFIG_HOME || path.join(os.homedir(), '.config');
    const j = JSON.parse(fs.readFileSync(path.join(home, 'amp', 'settings.json'), 'utf8'));
    if (j && typeof j === 'object' && !Array.isArray(j)) base = j;
  } catch {
    /* 設定がなければ、止めるツールだけ */
  }
  const disabled = Array.isArray(base['amp.tools.disable']) ? base['amp.tools.disable'] : [];
  const file = path.join(os.tmpdir(), `worktree-kanban-amp-${name}-${process.pid}.json`);
  fs.writeFileSync(file, JSON.stringify({ ...base, 'amp.tools.disable': [...new Set([...disabled, ...disable])] }), { mode: 0o600 });
  return file;
}
function ampPolicy(mode) {
  if (mode === 'bypassPermissions') return ['--dangerously-allow-all'];
  if (mode === 'plan') return ['--settings-file', ampSettingsFile('plan', [...AMP_EDIT_TOOLS, ...AMP_COMMAND_TOOLS])];
  return ['--settings-file', ampSettingsFile('edits', AMP_COMMAND_TOOLS)];
}
// Pi: 承認のしくみがなく、使えるツールを --tools で決める。
// 計画だけ → 読み取りだけ、ファイル編集は自動・毎回確認 → コマンド（bash）なし、すべて許可 → 制限なし
function piPolicy(mode) {
  if (mode === 'bypassPermissions') return [];
  if (mode === 'plan') return ['--tools', 'read,grep,find,ls'];
  return ['--tools', 'read,edit,write,grep,find,ls'];
}
// Droid: 何も付けなければ読み取りだけ。--auto low はファイルの編集まで、medium はビルド・テスト・コミットなどまで。
// 許されない操作をしようとすると、その場で実行が終わる（待ち続けない）。
// コマンドを確認なしで動かさないように、ファイル編集は自動 → low、毎回確認 → 読み取りだけ（Antigravity の default と同じ）
function droidPolicy(mode) {
  if (mode === 'bypassPermissions') return ['--skip-permissions-unsafe'];
  if (mode === 'acceptEdits') return ['--auto', 'low'];
  return [];
}

// 起動するときに足す環境変数（CLI ごと。なければ {}）
function agentEnv(a, mode) {
  if (a === 'opencode') {
    const permission = opencodePermission(mode);
    return permission ? { OPENCODE_CONFIG_CONTENT: JSON.stringify({ permission }) } : {};
  }
  return {};
}

// ACP（Agent Client Protocol）で動かす起動のしかた。版によって引数が違うものは、上から順に試して、使えたものを覚える。
// cmd があるものは、CLI とは別のコマンド（ACP に直すアダプタ）を動かす
const ACP_LAUNCH = {
  cursor: [{ args: ['acp'] }],
  gemini: [{ args: ['--experimental-acp'] }, { args: ['--acp'] }],
  opencode: [{ args: ['acp'] }],
  copilot: [{ args: ['--acp'] }, { args: ['--acp', '--stdio'] }],
  amp: [{ cmd: 'amp-acp', args: [] }],
  pi: [{ cmd: 'pi-acp', args: [] }],
};
// アダプタは CLI の許可の設定（止めるツール）を渡せないので、もともと何でも許す「すべて自動で許可」のときだけ使う
const ACP_BYPASS_ONLY = new Set(['amp', 'pi']);
// モデルを起動の引数で渡せない CLI（ACP の session/set_model で会話に設定する）
const ACP_SESSION_MODEL = new Set(['opencode', 'amp', 'pi']);

// カードで承認できる起動のしかたの種類（なければ null）。
//   codex: 途中で許可を聞くモードだけ app-server で動かす（計画だけ・すべて許可は聞くことがない。会話は codex exec と共通）
//   ACP の CLI: acp とふだんの起動のしかたは会話の保存場所が別で、互いに続きができない。ふだんの起動で始めた会話は、そのまま続ける
function rpcKindOf(a, mode, { sessionId, sessionVia } = {}) {
  if (a === 'codex') return mode === 'default' || mode === 'acceptEdits' ? 'codex' : null;
  if (!ACP_LAUNCH[a]) return null;
  if (sessionId && sessionVia !== 'acp') return null;
  if (ACP_BYPASS_ONLY.has(a) && mode !== 'bypassPermissions') return null;
  return 'acp';
}
// 試す起動のしかたの数
function rpcVariants(a) {
  return a === 'codex' ? 1 : (ACP_LAUNCH[a] || []).length;
}
// CLI とは別に動かすコマンド（なければ null）
function rpcCommand(a, variant = 0) {
  const v = ACP_LAUNCH[a] && ACP_LAUNCH[a][variant];
  return (v && v.cmd) || null;
}
// ACP の会話にモデルを設定するか（起動の引数で渡せない CLI）
function rpcSessionModel(a) {
  return ACP_SESSION_MODEL.has(a);
}
function rpcArgs(a, { mode, model, includeDirs = [], variant = 0 } = {}) {
  if (a === 'codex') {
    return ['app-server'];
  }
  const v = ACP_LAUNCH[a] && ACP_LAUNCH[a][variant];
  if (!v) throw new Error(tr('このエージェントには対応していません: {a}', { a }));
  if (a === 'cursor') {
    // モデルは session/set_model だと版ごとの長い名前が要るので、起動の引数で渡す
    const args = mode === 'bypassPermissions' ? ['--force', '--approve-mcps'] : [];
    if (model) args.push('--model', model);
    args.push(...v.args);
    return args;
  }
  if (a === 'gemini') {
    // 許可を聞くかどうかは、ふだんと同じく --approval-mode で決める（聞くものはカードに出る）
    const args = [...v.args, '--skip-trust'];
    if (mode) args.push('--approval-mode', geminiApproval(mode));
    if (model) args.push('-m', model);
    if (includeDirs.length) args.push('--include-directories', includeDirs.join(','));
    return args;
  }
  if (a === 'copilot') {
    const args = [...v.args];
    if (mode === 'bypassPermissions') args.push('--allow-all');
    else if (mode === 'acceptEdits') args.push('--allow-tool=write');
    if (model) args.push(`--model=${model}`);
    for (const d of includeDirs) args.push(`--add-dir=${d}`);
    return args;
  }
  // OpenCode の許可は agentEnv（OPENCODE_CONFIG_CONTENT）で渡す。「確認」にしたものがカードに出る
  return [...v.args];
}

// 設定の「許可しておくツール」（Bash(npm test:*) など）に入っている操作か。
// Claude Code は CLI 側で見るので、カードの承認を Worktree Kanban が受ける CLI のためのもの。
// 「Bash(npm test:*)」は前方一致なので、つないだコマンド（npm test; rm x）は通さない
function isAllowedTool(list, toolName, input) {
  const command = input && typeof input.command === 'string' ? input.command.trim() : '';
  for (const rule of list || []) {
    const m = /^([^()]+)(?:\((.*)\))?$/.exec(String(rule).trim());
    if (!m || m[1] !== toolName) continue;
    if (m[2] == null) return true;
    if (toolName !== 'Bash') continue;
    const prefix = /^(.*?)(?::\*|\s*\*)$/.exec(m[2]);
    if (!prefix) {
      if (command === m[2]) return true;
      continue;
    }
    if (/[;&|<>`$\n\r]/.test(command)) continue;
    if (command === prefix[1] || command.startsWith(`${prefix[1]} `)) return true;
  }
  return false;
}

/**
 * 起動する引数（指示は stdin で渡す。Cursor・Copilot は prompt を引数に入れる）
 * @param {'codex'|'antigravity'|'gemini'|'cursor'|'opencode'|'copilot'|'amp'|'pi'|'droid'} a
 * @param {{ mode?: string, model?: string, sessionId?: string|null, prompt?: string, includeDirs?: string[] }} o
 */
function buildArgs(a, { mode, model, sessionId, prompt, includeDirs = [] } = {}) {
  if (a === 'codex') {
    const args = ['exec'];
    if (sessionId) args.push('resume');
    args.push('--json', '--skip-git-repo-check');
    const p = codexPolicy(mode);
    // resume には --sandbox がないので、どちらでも使える -c で渡す（値は TOML として読めなければ文字列になる）
    if (p.bypass) args.push('--dangerously-bypass-approvals-and-sandbox');
    else args.push('-c', `sandbox_mode=${p.sandbox}`);
    if (model) args.push('-m', model);
    if (sessionId) args.push(sessionId);
    args.push('-'); // 指示は stdin から読む
    return args;
  }
  if (a === 'antigravity') {
    // stdin がパイプなら -p がなくても1回だけ動いて終わる。-p の空文字は「指示がない」エラーになるので付けない
    const args = ['--output-format', 'stream-json', ...antigravityPolicy(mode)];
    if (model) args.push('--model', model);
    if (sessionId) args.push('--conversation', sessionId);
    for (const d of includeDirs) args.push('--add-dir', d);
    return args;
  }
  if (a === 'gemini') {
    // stdin がパイプなら、ヘッドレス（対話しない）で動く。worktree は毎回新しいフォルダなので、信頼の確認は飛ばす
    const args = ['--output-format', 'stream-json', '--skip-trust', '--approval-mode', geminiApproval(mode)];
    if (model) args.push('-m', model);
    if (sessionId) args.push('--resume', sessionId);
    // 作業フォルダの外にある添付ファイルの置き場所も読めるようにする
    if (includeDirs.length) args.push('--include-directories', includeDirs.join(','));
    return args;
  }
  if (a === 'cursor') {
    // worktree は毎回新しいフォルダなので、ワークスペースの信頼の確認は飛ばす（--trust）
    const args = ['-p', '--output-format', 'stream-json', '--trust', ...cursorPolicy(mode)];
    if (model) args.push('--model', model);
    if (sessionId) args.push('--resume', sessionId);
    // 「-」で始まる指示はオプションとして読まれてしまうので、先頭に空白を入れる
    const p = String(prompt ?? '');
    args.push(p.startsWith('-') ? ` ${p}` : p);
    return args;
  }
  if (a === 'opencode') {
    // 指示は stdin から読む（引数がなければ、終わりまで読む）
    const args = ['run', '--format', 'json', ...opencodePolicy(mode)];
    if (model) args.push('-m', model);
    if (sessionId) args.push('-s', sessionId);
    return args;
  }
  if (a === 'copilot') {
    // -p で渡した指示で1回だけ動く。ヘッドレスでは聞き返せないので ask_user のツールは外す
    const args = ['--output-format', 'json', '--no-ask-user', ...copilotPolicy(mode)];
    if (model) args.push(`--model=${model}`);
    if (sessionId) args.push(`--resume=${sessionId}`);
    for (const d of includeDirs) args.push(`--add-dir=${d}`);
    // 「-」で始まる指示はオプションとして読まれてしまうので、先頭に空白を入れる
    const p = String(prompt ?? '');
    args.push('-p', p.startsWith('-') ? ` ${p}` : p);
    return args;
  }
  if (a === 'amp') {
    // -x（execute モード）で、指示は stdin から読む。続きは threads continue。モデルは選べないので、設定のモデルは --mode（low / medium / high / ultra など）に渡す
    const args = sessionId ? ['threads', 'continue', sessionId] : [];
    args.push('-x', '--stream-json', ...ampPolicy(mode));
    if (model) args.push('--mode', model);
    return args;
  }
  if (a === 'pi') {
    // --mode json で1回だけ動く。指示は stdin から読む。--session-id は、この作業フォルダの会話があれば続き、なければその ID で作る
    const args = ['--mode', 'json', ...piPolicy(mode)];
    if (model) args.push('--model', model);
    if (sessionId) args.push('--session-id', sessionId);
    return args;
  }
  if (a === 'droid') {
    // 指示は stdin から読む（引数で渡さなければ、終わりまで読む）
    const args = ['exec', '-o', 'stream-json', ...droidPolicy(mode)];
    if (model) args.push('-m', model);
    if (sessionId) args.push('-s', sessionId);
    return args;
  }
  throw new Error(tr('このエージェントには対応していません: {a}', { a }));
}

function trunc(s, n) {
  s = String(s ?? '');
  return s.length > n ? `${s.slice(0, n)}…` : s;
}

// ---------- エージェントの TODO リスト（進捗タブに出す） ----------
// CLI ごとに形が違うので、[{ text, status: 'pending'|'in_progress'|'completed' }] にそろえる
//   Claude Code: TodoWrite { todos: [{ content, status, activeForm }] }
//   Codex CLI:   item.type 'todo_list' { items: [{ text, completed }] }
//   Gemini CLI:  write_todos { todos: [{ description, status }] }
//   Cursor CLI:  todoToolCall / updateTodosToolCall { args: { todos: [{ content, status: 'TODO_STATUS_COMPLETED' など }] } }
//   OpenCode:    todowrite { todos: [{ content, status }] }
//   Amp:         todo_write { todos: [...] }（形は Claude Code と同じとみなす）
//   Droid:       TodoWrite { todos: [...] }
//   Copilot CLI / Pi は、出力に TODO の中身が入らない
const MAX_TODOS = 50;
const TODO_TOOL_NAMES = new Set(['todowrite', 'write_todos', 'writetodos', 'todo_write', 'update_todos', 'updatetodos', 'todo']);
function isTodoTool(name) {
  return TODO_TOOL_NAMES.has(String(name || '').trim().toLowerCase());
}
function todoStatus(v, completed) {
  if (completed === true) return 'completed';
  const s = String(v || '').toLowerCase().replace(/^todo_status_/, '');
  if (/^(completed?|done|finished|success)$/.test(s)) return 'completed';
  if (/^(in[_ -]?progress|active|running|doing|started)$/.test(s)) return 'in_progress';
  if (/^(cancell?ed|skipped)$/.test(s)) return 'cancelled';
  return 'pending';
}
/** @returns {{ text: string, status: string }[] | null} TODO リストでなければ null */
function todoItems(list) {
  if (!Array.isArray(list)) return null;
  const out = [];
  for (const t of list) {
    if (!t || typeof t !== 'object') continue;
    const status = todoStatus(t.status, t.completed);
    // 作業中のものは「〜しています」の形（Claude の activeForm）があればそれを出す
    const text = String((status === 'in_progress' && t.activeForm) || t.content || t.text || t.description || t.title || t.step || '').trim();
    if (!text) continue;
    out.push({ text: trunc(text, 200), status });
    if (out.length >= MAX_TODOS) break;
  }
  return out;
}
// ツールの呼び出しの入力から、TODO リストを取り出す（TODO のツールでなければ null）
function todosFromTool(name, input) {
  if (!isTodoTool(name) || !input || typeof input !== 'object') return null;
  return todoItems(input.todos || input.items);
}

// ---------- Codex CLI（codex exec --json） ----------
// thread.started / turn.started / item.started / item.updated / item.completed / turn.completed / turn.failed / error
function codexParser({ summarize }) {
  const started = new Set();
  const toolOf = (item) => {
    switch (item.type) {
      case 'command_execution':
        return { name: 'Bash', summary: trunc(item.command, 300) };
      case 'mcp_tool_call':
        return { name: `mcp ${[item.server, item.tool].filter(Boolean).join('.')}`, summary: summarize(item.arguments) };
      case 'web_search':
        return { name: 'WebSearch', summary: trunc(item.query, 300) };
      default:
        return null;
    }
  };
  return {
    onEvent(ev) {
      const out = [];
      const item = ev.item || {};
      // 計画（TODO リスト）は、作り直されるたびに最新の形で届く
      if (item.type === 'todo_list' && /^item\.(started|updated|completed)$/.test(ev.type)) {
        const items = todoItems(item.items);
        return items ? [{ type: 'todos', items }] : [];
      }
      switch (ev.type) {
        case 'thread.started':
          if (ev.thread_id) out.push({ type: 'session', id: String(ev.thread_id) });
          break;
        case 'item.started': {
          const t = toolOf(item);
          if (t) {
            started.add(item.id);
            out.push({ type: 'tool', ...t });
          }
          break;
        }
        case 'item.completed':
          if (item.type === 'agent_message' && String(item.text || '').trim()) out.push({ type: 'text', text: item.text });
          else if (item.type === 'file_change') {
            const files = (item.changes || []).map((x) => `${x.kind ? `${x.kind} ` : ''}${x.path}`).join(', ');
            out.push({ type: 'tool', name: 'Edit', summary: trunc(files, 300) });
          } else if (item.type === 'error' && item.message) out.push({ type: 'log_error', text: item.message });
          else {
            const t = toolOf(item);
            if (!t) break;
            if (!started.has(item.id)) out.push({ type: 'tool', ...t });
            started.delete(item.id);
            if (item.type === 'command_execution') {
              const failed = item.status === 'failed' || (item.exit_code != null && item.exit_code !== 0);
              out.push({ type: 'tool_result', text: trunc(item.aggregated_output || tr('（終了コード {code}）', { code: item.exit_code ?? '?' }), 1500), error: failed });
            } else if (item.type === 'mcp_tool_call') {
              const r = item.error ? item.error.message || JSON.stringify(item.error) : JSON.stringify(item.result ?? '');
              out.push({ type: 'tool_result', text: trunc(r, 1500), error: item.status === 'failed' || !!item.error });
            }
          }
          break;
        case 'turn.completed':
          out.push({ type: 'result' });
          break;
        case 'turn.failed':
          out.push({ type: 'result', error: (ev.error && ev.error.message) || tr('Codex がエラーで止まりました') });
          break;
        case 'error':
          if (ev.message) out.push({ type: 'log_error', text: ev.message });
          break;
        default:
          break;
      }
      return out;
    },
    flush() {
      return [];
    },
  };
}

// ---------- Gemini CLI（gemini --output-format stream-json） ----------
// init / message（assistant は少しずつ届く delta）/ tool_use / tool_result / error / result
function geminiParser({ summarize }) {
  let text = '';
  const flush = () => {
    const t = text;
    text = '';
    return t.trim() ? [{ type: 'text', text: t }] : [];
  };
  return {
    onEvent(ev) {
      switch (ev.type) {
        case 'init':
          return ev.session_id ? [{ type: 'session', id: String(ev.session_id), model: ev.model }] : [];
        case 'message':
          if (ev.role === 'assistant' && typeof ev.content === 'string') {
            if (ev.delta) text += ev.content;
            else return [...flush(), { type: 'text', text: ev.content }].filter((a) => String(a.text).trim());
          }
          return [];
        case 'tool_use': {
          const out = [...flush(), { type: 'tool', name: String(ev.tool_name || 'tool'), summary: summarize(ev.parameters) }];
          const todos = todosFromTool(ev.tool_name, ev.parameters);
          if (todos) out.push({ type: 'todos', items: todos });
          return out;
        }
        case 'tool_result': {
          const failed = ev.status === 'error';
          const body = failed && ev.error ? ev.error.message || '' : ev.output || '';
          return [...flush(), { type: 'tool_result', text: trunc(body || (failed ? tr('エラー') : 'ok'), 1500), error: failed }];
        }
        case 'error':
          return [...flush(), { type: 'log_error', text: String(ev.message || tr('エラー')) }];
        case 'result':
          if (ev.status && ev.status !== 'success') return [...flush(), { type: 'result', error: (ev.error && ev.error.message) || tr('エラー（{subtype}）', { subtype: ev.status }) }];
          return [...flush(), { type: 'result' }];
        default:
          return [];
      }
    },
    flush,
  };
}

// ---------- Antigravity CLI（agy --output-format stream-json） ----------
// init / step_update / result。ほかの CLI と違い、種類は type ではなく event に入っている。
// step_update は手順（step_index）ごとに ACTIVE → DONE / ERROR と進む。発言は text_delta を足していくと全文になる
const ANTIGRAVITY_TOOL_NAMES = { run_command: 'Bash', read_file: 'Read', view_file: 'Read', write_file: 'Write', write_to_file: 'Write', edit_file: 'Edit', replace_file_content: 'Edit', multi_replace_file_content: 'Edit', grep_search: 'Grep', find_by_name: 'Glob', list_dir: 'LS', search_web: 'WebSearch', read_url_content: 'WebFetch' };
function antigravityParser({ summarize }) {
  let text = '';
  const flush = () => {
    const t = text;
    text = '';
    return t.trim() ? [{ type: 'text', text: t }] : [];
  };
  const started = new Set();
  const ended = new Set();
  const toolOf = (u, info) => {
    const raw = String(u.tool_name || info.name || 'tool');
    const p = info.parameters;
    const target = p && typeof p === 'object' ? p.CommandLine ?? p.Path : null;
    return { name: ANTIGRAVITY_TOOL_NAMES[raw] || raw, summary: typeof target === 'string' ? trunc(target, 300) : summarize(p) };
  };
  return {
    onEvent(ev) {
      switch (ev.event) {
        case 'init':
          return ev.conversation_id ? [{ type: 'session', id: String(ev.conversation_id), model: ev.init && ev.init.model }] : [];
        case 'step_update': {
          const u = ev.step_update || {};
          if (u.step_type === 'agent_response') {
            if (typeof u.text_delta === 'string') text += u.text_delta;
            return [];
          }
          if (u.step_type !== 'tool') return [];
          const info = u.tool_info || {};
          const id = `${u.conversation_id || ''}:${u.step_index}`;
          if (ended.has(id)) return [];
          const out = [];
          if (!started.has(id)) {
            started.add(id);
            out.push(...flush(), { type: 'tool', ...toolOf(u, info) });
          }
          if (u.state === 'ACTIVE') return out;
          ended.add(id);
          const failed = u.state !== 'DONE' || !!info.error;
          const body = (info.error && info.error.message) || info.output || '';
          out.push({ type: 'tool_result', text: trunc(body || (failed ? tr('エラー') : 'ok'), 1500), error: failed });
          return out;
        }
        case 'result': {
          const r = ev.result || {};
          if (r.status && r.status !== 'SUCCESS') return [...flush(), { type: 'result', error: String(r.error || tr('エラー（{subtype}）', { subtype: r.status })) }];
          return [...flush(), { type: 'result' }];
        }
        default:
          return [];
      }
    },
    flush,
  };
}

// ---------- Cursor CLI（cursor-agent -p --output-format stream-json） ----------
// system(init) / user / assistant / tool_call(started・completed) / result
// tool_call は { shellToolCall: { args, result } } のように、ツールの種類ごとのキーに中身が入っている
const CURSOR_TOOL_NAMES = { shell: 'Bash', read: 'Read', write: 'Write', edit: 'Edit', delete: 'Delete', grep: 'Grep', glob: 'Glob', ls: 'LS', todo: 'TodoWrite', updateTodos: 'TodoWrite', webSearch: 'WebSearch', webFetch: 'WebFetch' };
function cursorParser({ summarize }) {
  let text = '';
  const flush = () => {
    const t = text;
    text = '';
    return t.trim() ? [{ type: 'text', text: t }] : [];
  };
  const started = new Set();
  const toolOf = (tc) => {
    if (!tc || typeof tc !== 'object') return null;
    const key = Object.keys(tc)[0];
    if (!key) return null;
    const body = tc[key] || {};
    if (key === 'function') {
      // ほかの種類のツール（MCP など）: { function: { name, arguments } }
      let args = body.arguments;
      try {
        if (typeof args === 'string') args = JSON.parse(args);
      } catch {
        /* 文字列のまま出す */
      }
      return { name: String(body.name || 'tool'), summary: typeof args === 'string' ? trunc(args, 300) : summarize(args), body };
    }
    const kind = key.replace(/ToolCall$/, '');
    const name = CURSOR_TOOL_NAMES[kind] || (key === 'mcpToolCall' ? `mcp ${[body.args && body.args.providerIdentifier, body.args && body.args.toolName].filter(Boolean).join('.')}`.trim() : kind);
    return { name, summary: summarize(body.args), body, kind };
  };
  const resultOf = (t) => {
    const r = (t.body && t.body.result) || {};
    if (r.success) {
      const ok = r.success;
      if (t.kind === 'shell') {
        const out = [ok.stdout, ok.stderr].filter((x) => String(x || '').trim()).join('\n');
        const failed = ok.exitCode != null && ok.exitCode !== 0;
        return { text: trunc(out || tr('（終了コード {code}）', { code: ok.exitCode ?? '?' }), 1500), error: failed };
      }
      if (typeof ok.content === 'string') return { text: trunc(ok.content, 1500), error: false };
      return { text: trunc(typeof ok === 'object' ? JSON.stringify(ok) : String(ok), 1500), error: false };
    }
    const bad = r.error || r.failure || r.rejected;
    if (bad) {
      const msg = typeof bad === 'string' ? bad : bad.message || bad.error || bad.reason || bad.stderr || JSON.stringify(bad);
      return { text: trunc(r.rejected ? tr('拒否されました: {msg}', { msg }) : msg, 1500), error: true };
    }
    return { text: 'ok', error: false };
  };
  const contentText = (m) => {
    const c = m && m.content;
    if (typeof c === 'string') return c;
    if (Array.isArray(c)) return c.filter((x) => x && x.type === 'text').map((x) => x.text || '').join('');
    return '';
  };
  return {
    onEvent(ev) {
      switch (ev.type) {
        case 'system':
          if (ev.subtype === 'init' && ev.session_id) return [{ type: 'session', id: String(ev.session_id), model: ev.model }];
          return [];
        case 'assistant':
          // 少しずつ届くことがあるので、ツールの呼び出しか終わりまでまとめる
          text += contentText(ev.message);
          return [];
        case 'tool_call': {
          const t = toolOf(ev.tool_call);
          if (!t) return [];
          const id = ev.call_id || '';
          const todos = t.name === 'TodoWrite' || isTodoTool(t.name) ? todoItems(t.body && t.body.args && (t.body.args.todos || t.body.args.items)) : null;
          if (ev.subtype === 'started') {
            started.add(id);
            return [...flush(), { type: 'tool', name: t.name, summary: t.summary }, ...(todos ? [{ type: 'todos', items: todos }] : [])];
          }
          if (ev.subtype === 'completed') {
            const out = flush();
            if (!started.has(id)) {
              out.push({ type: 'tool', name: t.name, summary: t.summary });
              if (todos) out.push({ type: 'todos', items: todos });
            }
            started.delete(id);
            out.push({ type: 'tool_result', ...resultOf(t) });
            return out;
          }
          return [];
        }
        case 'error':
          return [...flush(), { type: 'log_error', text: String(ev.message || (ev.error && ev.error.message) || tr('エラー')) }];
        case 'result':
          if (ev.is_error || (ev.subtype && ev.subtype !== 'success')) {
            const e = ev.error && typeof ev.error === 'object' ? ev.error.message : ev.error;
            return [...flush(), { type: 'result', error: String(e || ev.result || tr('エラー（{subtype}）', { subtype: ev.subtype || 'error' })) }];
          }
          return [...flush(), { type: 'result' }];
        default:
          return [];
      }
    },
    flush,
  };
}

// テキストを少しずつためて、ツールの呼び出しや終わりでまとめて出すための入れ物
function textBuffer() {
  let text = '';
  return {
    add(t) {
      text += t;
    },
    flush() {
      const t = text;
      text = '';
      return t.trim() ? [{ type: 'text', text: t }] : [];
    },
  };
}
// ツールの結果の content（文字列か [{ type: 'text', text }] の配列）を文字列にする
function contentString(c) {
  if (typeof c === 'string') return c;
  if (Array.isArray(c)) return c.map((x) => (typeof x === 'string' ? x : x && x.type === 'text' ? x.text || '' : '')).join('');
  if (c && typeof c === 'object') return typeof c.text === 'string' ? c.text : JSON.stringify(c);
  return c == null ? '' : String(c);
}
// コマンド・パスなど、ツールの入力のいちばん分かりやすいところを要約に使う
function toolSummary(input, summarize) {
  const p = input && typeof input === 'object' ? input : null;
  const target = p && (p.command ?? p.filePath ?? p.file_path ?? p.path ?? p.pattern ?? p.url ?? p.query);
  return typeof target === 'string' ? trunc(target, 300) : summarize(input);
}

// ---------- OpenCode（opencode run --format json） ----------
// どの行にも sessionID が入る。text は part ごとの全文、tool_use はツールが終わったとき（completed / error）に1回だけ届く。
// 成功の終わりの行はない（exit 0 で終わる）。失敗は error の行と exit 1
const OPENCODE_TOOL_NAMES = { shell: 'Bash', bash: 'Bash', read: 'Read', write: 'Write', edit: 'Edit', patch: 'Edit', glob: 'Glob', grep: 'Grep', list: 'LS', webfetch: 'WebFetch', websearch: 'WebSearch', todowrite: 'TodoWrite', task: 'Task', subagent: 'Task' };
function opencodeParser({ summarize }) {
  let session = null;
  let error = null;
  let stepped = false;
  return {
    onEvent(ev) {
      const out = [];
      if (!session && typeof ev.sessionID === 'string' && ev.sessionID) {
        session = ev.sessionID;
        out.push({ type: 'session', id: session });
      }
      const part = ev.part || {};
      switch (ev.type) {
        case 'text':
          if (String(part.text || '').trim()) out.push({ type: 'text', text: part.text });
          break;
        case 'tool_use': {
          const st = part.state || {};
          const raw = String(part.tool || 'tool');
          out.push({ type: 'tool', name: OPENCODE_TOOL_NAMES[raw] || raw, summary: toolSummary(st.input, summarize) });
          const todos = todosFromTool(raw, st.input);
          if (todos) out.push({ type: 'todos', items: todos });
          const exit = st.metadata && st.metadata.exit;
          const failed = st.status === 'error' || (exit != null && exit !== 0);
          const body = st.status === 'error' ? contentString(st.error) : contentString(st.output);
          out.push({ type: 'tool_result', text: trunc(body || (failed ? tr('エラー') : 'ok'), 1500), error: failed });
          break;
        }
        case 'step_finish':
          stepped = true;
          break;
        case 'error': {
          const e = ev.error || {};
          error = String(e.message || (e.data && e.data.message) || e.name || tr('エラー'));
          out.push({ type: 'log_error', text: error });
          break;
        }
        default:
          break;
      }
      return out;
    },
    // 終わりの行がないので、プロセスが終わったところで1ターンの終わりにする
    flush() {
      if (error) return [{ type: 'result', error }];
      return stepped ? [{ type: 'result' }] : [];
    },
  };
}

// ---------- Copilot CLI（copilot -p ... --output-format json） ----------
// { type, data } の形。発言は assistant.message（全文。少しずつの assistant.message_delta は読まない）、
// ツールは tool.execution_start / tool.execution_complete。会話の ID は最後の result の行にだけ入る
const COPILOT_TOOL_NAMES = { bash: 'Bash', shell: 'Bash', powershell: 'Bash', view: 'Read', read: 'Read', create: 'Write', write: 'Write', edit: 'Edit', str_replace_editor: 'Edit', glob: 'Glob', grep: 'Grep', web_fetch: 'WebFetch', web_search: 'WebSearch', update_todo: 'TodoWrite' };
function copilotParser({ summarize }) {
  const started = new Set();
  let error = null;
  const nameOf = (raw) => COPILOT_TOOL_NAMES[String(raw || '')] || String(raw || 'tool');
  return {
    onEvent(ev) {
      const d = ev.data || {};
      switch (ev.type) {
        case 'assistant.message':
          return String(d.content || '').trim() ? [{ type: 'text', text: String(d.content) }] : [];
        case 'tool.execution_start': {
          started.add(d.toolCallId);
          const out = [{ type: 'tool', name: nameOf(d.toolName), summary: toolSummary(d.arguments, summarize) }];
          const todos = todosFromTool(d.toolName, d.arguments);
          if (todos) out.push({ type: 'todos', items: todos });
          return out;
        }
        case 'tool.execution_complete': {
          const out = [];
          if (!started.has(d.toolCallId)) out.push({ type: 'tool', name: nameOf(d.toolName), summary: toolSummary(d.arguments, summarize) });
          started.delete(d.toolCallId);
          const exit = d.shellExecution && d.shellExecution.exitCode;
          const failed = d.success === false || (exit != null && exit !== 0);
          const body = d.success === false && d.error ? d.error.message || JSON.stringify(d.error) : contentString(d.result && (d.result.content ?? d.result.detailedContent ?? d.result));
          out.push({ type: 'tool_result', text: trunc(body || (failed ? tr('（終了コード {code}）', { code: exit ?? '?' }) : 'ok'), 1500), error: failed });
          return out;
        }
        case 'session.error':
          error = String(d.message || d.errorType || tr('エラー'));
          return [{ type: 'log_error', text: error }];
        case 'result': {
          const out = [];
          if (typeof ev.sessionId === 'string' && ev.sessionId) out.push({ type: 'session', id: ev.sessionId });
          if (ev.exitCode != null && ev.exitCode !== 0) out.push({ type: 'result', error: error || tr('エラー（{subtype}）', { subtype: `exit ${ev.exitCode}` }) });
          else out.push({ type: 'result' });
          return out;
        }
        default:
          return [];
      }
    },
    flush() {
      return [];
    },
  };
}

// ---------- Amp（amp -x --stream-json） ----------
// Claude Code と同じ形: system(init) / assistant（content に text と tool_use）/ user（tool_result）/ result。会話（スレッド）の ID は T-… の形
const AMP_TOOL_NAMES = { Bash: 'Bash', Read: 'Read', read: 'Read', create_file: 'Write', edit_file: 'Edit', undo_edit: 'Edit', Grep: 'Grep', grep: 'Grep', glob: 'Glob', list_directory: 'LS', web_search: 'WebSearch', read_web_page: 'WebFetch', todo_write: 'TodoWrite', todo_read: 'TodoRead', Task: 'Task' };
function ampParser({ summarize }) {
  const buf = textBuffer();
  let session = null;
  return {
    onEvent(ev) {
      const out = [];
      if (!session && typeof ev.session_id === 'string' && ev.session_id) {
        session = ev.session_id;
        out.push({ type: 'session', id: session, model: ev.model });
      }
      // サブエージェントの中の動きは、親のツールの呼び出しとしてまとめて見る
      if (ev.parent_tool_use_id) return out;
      switch (ev.type) {
        case 'assistant':
          for (const b of (ev.message && ev.message.content) || []) {
            if (!b) continue;
            if (b.type === 'text' && typeof b.text === 'string') buf.add(b.text);
            else if (b.type === 'tool_use') {
              const raw = String(b.name || 'tool');
              out.push(...buf.flush(), { type: 'tool', name: AMP_TOOL_NAMES[raw] || raw, summary: toolSummary(b.input, summarize) });
              const todos = todosFromTool(raw, b.input);
              if (todos) out.push({ type: 'todos', items: todos });
            }
          }
          // 発言はメッセージごとの全文なので、ここで出す
          out.push(...buf.flush());
          break;
        case 'user':
          for (const b of (ev.message && ev.message.content) || []) {
            if (b && b.type === 'tool_result') {
              const failed = !!b.is_error;
              out.push({ type: 'tool_result', text: trunc(contentString(b.content) || (failed ? tr('エラー') : 'ok'), 1500), error: failed });
            }
          }
          break;
        case 'result':
          if (ev.is_error || (ev.subtype && ev.subtype !== 'success')) {
            const e = ev.error && typeof ev.error === 'object' ? ev.error.message : ev.error;
            out.push({ type: 'result', error: String(e || ev.result || tr('エラー（{subtype}）', { subtype: ev.subtype || 'error' })) });
          } else out.push({ type: 'result' });
          break;
        default:
          break;
      }
      return out;
    },
    flush: () => buf.flush(),
  };
}

// ---------- Pi（pi --mode json） ----------
// 1行目が会話のヘッダ（type: session）。発言は message_update の text_delta を足していく。
// ツールは tool_execution_start / tool_execution_end。応答が失敗しても exit 0 なので、message_end の stopReason を見る。終わりは agent_settled
const PI_TOOL_NAMES = { bash: 'Bash', read: 'Read', edit: 'Edit', write: 'Write', grep: 'Grep', find: 'Glob', ls: 'LS' };
function piParser({ summarize }) {
  const buf = textBuffer();
  let error = null;
  let ended = false;
  const finish = () => {
    if (ended) return [];
    ended = true;
    return [...buf.flush(), error ? { type: 'result', error } : { type: 'result' }];
  };
  return {
    onEvent(ev) {
      switch (ev.type) {
        case 'session':
          return ev.id ? [{ type: 'session', id: String(ev.id) }] : [];
        case 'message_update': {
          const e = ev.assistantMessageEvent || {};
          if (e.type === 'text_delta' && typeof e.delta === 'string') buf.add(e.delta);
          return [];
        }
        case 'message_end': {
          const m = ev.message || {};
          if (m.role && m.role !== 'assistant') return [];
          if (['error', 'aborted'].includes(m.stopReason)) error = String(m.errorMessage || tr('エラー（{subtype}）', { subtype: m.stopReason }));
          else if (m.stopReason) error = null; // 自動のやり直しで続けられた
          return buf.flush();
        }
        case 'tool_execution_start':
          return [...buf.flush(), { type: 'tool', name: PI_TOOL_NAMES[ev.toolName] || String(ev.toolName || 'tool'), summary: toolSummary(ev.args, summarize) }];
        case 'tool_execution_end': {
          const failed = !!ev.isError;
          const body = contentString(ev.result && ev.result.content);
          return [{ type: 'tool_result', text: trunc(body || (failed ? tr('エラー') : 'ok'), 1500), error: failed }];
        }
        case 'auto_retry_end':
          if (ev.success === false) error = String(ev.finalError || tr('エラー'));
          return [];
        case 'agent_settled':
          if (ev.aborted && !error) error = tr('エラー（{subtype}）', { subtype: 'aborted' });
          return finish();
        default:
          return [];
      }
    },
    // agent_settled が来ないまま終わったときも、失敗が分かっていれば失敗にする
    flush: () => (!ended && error ? finish() : buf.flush()),
  };
}

// ---------- Droid（droid exec -o stream-json） ----------
// system(init) / message（全文）/ tool_call / tool_result / error / completion（成功したときだけ）
const DROID_TOOL_NAMES = { Execute: 'Bash', Read: 'Read', Create: 'Write', Edit: 'Edit', MultiEdit: 'Edit', ApplyPatch: 'Edit', Grep: 'Grep', Glob: 'Glob', LS: 'LS', WebSearch: 'WebSearch', FetchUrl: 'WebFetch', TodoWrite: 'TodoWrite' };
function droidParser({ summarize }) {
  let session = null;
  let error = null;
  let done = false;
  return {
    onEvent(ev) {
      const out = [];
      if (!session && typeof ev.session_id === 'string' && ev.session_id) {
        session = ev.session_id;
        out.push({ type: 'session', id: session, model: ev.type === 'system' ? ev.model : undefined });
      }
      switch (ev.type) {
        case 'message':
          if (ev.role === 'assistant' && String(ev.text || '').trim()) out.push({ type: 'text', text: String(ev.text) });
          break;
        case 'tool_call': {
          const raw = String(ev.toolName || ev.toolId || 'tool');
          out.push({ type: 'tool', name: DROID_TOOL_NAMES[raw] || raw, summary: toolSummary(ev.parameters, summarize) });
          const todos = todosFromTool(raw, ev.parameters);
          if (todos) out.push({ type: 'todos', items: todos });
          break;
        }
        case 'tool_result': {
          const failed = !!ev.isError;
          const body = failed && ev.error ? ev.error.message || JSON.stringify(ev.error) : contentString(ev.value);
          out.push({ type: 'tool_result', text: trunc(body || (failed ? tr('エラー') : 'ok'), 1500), error: failed });
          break;
        }
        case 'error':
          error = String(ev.message || tr('エラー'));
          out.push({ type: 'log_error', text: error });
          break;
        case 'completion':
          done = true;
          out.push({ type: 'result' });
          break;
        default:
          break;
      }
      return out;
    },
    // completion がないまま終わったときは、最後のエラーで失敗にする
    flush() {
      if (done || !error) return [];
      done = true;
      return [{ type: 'result', error }];
    },
  };
}

function createParser(a, opts = {}) {
  const o = { summarize: opts.summarize || ((x) => trunc(JSON.stringify(x ?? ''), 300)) };
  if (a === 'codex') return codexParser(o);
  if (a === 'antigravity') return antigravityParser(o);
  if (a === 'gemini') return geminiParser(o);
  if (a === 'cursor') return cursorParser(o);
  if (a === 'opencode') return opencodeParser(o);
  if (a === 'copilot') return copilotParser(o);
  if (a === 'amp') return ampParser(o);
  if (a === 'pi') return piParser(o);
  if (a === 'droid') return droidParser(o);
  throw new Error(tr('このエージェントには対応していません: {a}', { a }));
}

// ---------- オーケストレーション ----------

// Pipeline の初期値の「実装」「レビュー」を動かすエージェント。
// 今使えるエージェントの中から選ぶ（Codex と Claude Code なら Codex → Claude Code。1つだけなら両方その1つ）
function relayStepAgents(enabled) {
  const on = Array.isArray(enabled) && enabled.length ? enabled : ['codex', 'claude'];
  return [on.find((a) => a !== 'claude') || on[0], on.includes('claude') ? 'claude' : on[on.length - 1]];
}
// Pipeline（順番に引き継ぐ）の工程の初期値。呼んだときの言語で作る（新規インストールと、新しいリポジトリ）
function defaultRelaySteps(enabled) {
  const [impl, review] = relayStepAgents(enabled);
  return [
    { agent: impl, label: tr('実装'), instruction: tr('タスクの指示に沿って実装してください。必要ならテストも追加・実行してください。') },
    {
      agent: review,
      label: tr('レビュー'),
      instruction: tr('前の工程の変更をレビューしてください（git log / git diff でベースブランチからの変更を確かめられます）。バグ・抜け・テスト不足があれば直し、最後に何を確かめて何を直したかを短く報告してください。'),
    },
  ];
}
// 読み込み時の言語（テストは原文）で固めたもの。実行中に言語を変えたあとは defaultRelaySteps() を使う
const DEFAULT_RELAY_STEPS = defaultRelaySteps();
// 競争（同じタスクを複数のエージェントで並列に解く）の初期値
const DEFAULT_COMPETE_AGENTS = ['claude', 'codex'];

// 前の版の設定: Pipelineと競争は排他で、どちらか1つだけを使えた（'relay' / 'compete' / 'none'）。
// 今はどちらもいつでも設定でき、タスクを作るときに1つ選ぶ。読み込んだ値をそろえるためだけに残している
const ORCHESTRATIONS = ['relay', 'compete', 'none'];
function cleanOrchestration(v) {
  return ORCHESTRATIONS.includes(v) ? v : 'relay';
}

// 分岐の行き先: 'end'（終了してレビュー列へ）か、工程の番号（0 から）。それ以外（null など）は「次の工程」
const RELAY_MAX_LOOPS_DEFAULT = 3;
function cleanRelayTarget(v, map) {
  if (v === 'end') return 'end';
  if (v === null || v === undefined || v === '') return null;
  const n = Number(v);
  if (!Number.isInteger(n) || !map.has(n)) return null;
  return map.get(n);
}

// 設定から読んだPipelineの工程を整える（知らないエージェント・空の工程は落とす）
// 分岐（onPass / onFail）・戻る上限（maxLoops）は、判定する工程だけに残す。行き先は落とした工程の分だけ番号を詰める
function cleanRelaySteps(steps) {
  if (!Array.isArray(steps)) return [];
  const base = steps.map((x) => ({
    agent: isAgent(x && x.agent) ? x.agent : 'claude',
    label: trunc(String((x && x.label) || '').trim(), 30),
    instruction: trunc(String((x && x.instruction) || '').trim(), 4000),
    raw: x || {},
  }));
  // 元の番号 → 残した工程の番号
  const map = new Map();
  base.forEach((x, i) => {
    if ((x.label || x.instruction) && map.size < 8) map.set(i, map.size);
  });
  return base
    .filter((_, i) => map.has(i))
    .map(({ raw, ...x }, i) => {
      const out = { ...x, label: x.label || tr('工程{n}', { n: i + 1 }) };
      const onPass = cleanRelayTarget(raw.onPass, map);
      const onFail = cleanRelayTarget(raw.onFail, map);
      if (onPass !== null) out.onPass = onPass;
      if (onFail !== null) out.onFail = onFail;
      if (onPass !== null || onFail !== null) {
        const m = Number(raw.maxLoops);
        out.maxLoops = Number.isInteger(m) && m >= 1 ? Math.min(m, 10) : RELAY_MAX_LOOPS_DEFAULT;
      }
      return out;
    });
}
// 判定する工程か（合格・差し戻しで行き先が変わる）
function relayJudges(st) {
  return !!st && (st.onPass !== undefined || st.onFail !== undefined);
}
function cleanCompeteAgents(list) {
  const out = [];
  for (const a of Array.isArray(list) ? list : []) if (isAgent(a) && !out.includes(a)) out.push(a);
  return out;
}

// ---------- 競争の設定（プロジェクトごとに複数） ----------
// competes: [{ id, name, agents: ふつうのエージェント, customAgents: カスタムエージェントの ID }]
// タスクを作るときの値は「compete:<ID>」（「compete」だけなら一覧の先頭）
const COMPETE_PREFIX = 'compete:';
const RELAY_PREFIX = 'relay:';
const MAX_COMPETES = 20;
const COMPETE_NAME_MAX = 30;
const COMPETE_ID_RE = /^[A-Za-z0-9_-]{1,40}$/;
function isCompeteRef(v) {
  return v === 'compete' || (typeof v === 'string' && v.startsWith(COMPETE_PREFIX) && COMPETE_ID_RE.test(v.slice(COMPETE_PREFIX.length)));
}
function isRelayRef(v) {
  return v === 'relay' || (typeof v === 'string' && v.startsWith(RELAY_PREFIX) && v.length > RELAY_PREFIX.length);
}
// 整えた競争の一覧（ID・名前は重ならないようにする。カスタムエージェントは、あるものだけ）
function cleanCompetes(list, customAgents) {
  const ids = new Set((Array.isArray(customAgents) ? customAgents : []).map((x) => x && x.id).filter(Boolean));
  const out = [];
  for (const x of Array.isArray(list) ? list : []) {
    if (!x || typeof x !== 'object' || out.length >= MAX_COMPETES) continue;
    let id = COMPETE_ID_RE.test(String(x.id || '')) ? String(x.id) : '';
    while (!id || out.some((y) => y.id === id)) id = `k${require('crypto').randomBytes(4).toString('hex')}`;
    const base = [...String(x.name || '').trim()].slice(0, COMPETE_NAME_MAX).join('') || tr('競争');
    let name = base;
    for (let n = 2; out.some((y) => y.name === name); n++) name = `${base} ${n}`;
    const custom = [];
    for (const v of Array.isArray(x.customAgents) ? x.customAgents : []) {
      const cid = String(v || '').replace(/^custom:/, '');
      if (ids.has(cid) && !custom.includes(cid)) custom.push(cid);
    }
    out.push({ id, name, agents: cleanCompeteAgents(x.agents), customAgents: custom });
  }
  return out;
}
// 前の版の設定（アプリ全体の competeAgents と、プロジェクトごとの competeCustomAgents）から作る、競争の一覧
function legacyCompetes(agents, customIds) {
  return [{ id: 'default', name: tr('競争'), agents: cleanCompeteAgents(agents === undefined ? DEFAULT_COMPETE_AGENTS : agents), customAgents: Array.isArray(customIds) ? customIds : [] }];
}
// 「compete:<ID>」の競争（「compete」だけなら先頭）。なければ null
function competeOf(competes, ref) {
  const list = Array.isArray(competes) ? competes : [];
  if (ref === 'compete') return list[0] || null;
  return isCompeteRef(ref) ? list.find((x) => x.id === ref.slice(COMPETE_PREFIX.length)) || null : null;
}

// ---------- カスタムエージェント（プロジェクトごと） ----------
// 元にする CLI・モデルに、プロフィール（名前・アイコンと色・説明・振る舞いの指示）を持たせたもの。
// タスク・会話・Pipelineの工程・競争で、ふつうのエージェントの代わりに選べる。
// 選ぶときの値は「custom:<ID>」。タスクを作るときに中身（persona）をカードに写すので、あとで直したり消したりしても動いているタスクは変わらない
const MAX_CUSTOM_AGENTS = 30;
const CUSTOM_PREFIX = 'custom:';
const DEFAULT_CUSTOM_COLOR = '#6366f1';
const MODEL_RE = /^[A-Za-z0-9][A-Za-z0-9._:/@\[\]-]*$/;

function isCustomRef(v) {
  return typeof v === 'string' && v.startsWith(CUSTOM_PREFIX) && /^[A-Za-z0-9_-]{1,32}$/.test(v.slice(CUSTOM_PREFIX.length));
}
function customIdOf(v) {
  return isCustomRef(v) ? v.slice(CUSTOM_PREFIX.length) : '';
}
function cleanCustomModel(v) {
  const m = String(v || '').trim();
  return m && m.length <= 100 && MODEL_RE.test(m) ? m : '';
}
function cleanCustomColor(v) {
  const c = String(v || '').trim();
  return /^#[0-9a-fA-F]{6}$/.test(c) ? c.toLowerCase() : DEFAULT_CUSTOM_COLOR;
}
// アイコンは絵文字など短い文字（書記素で2つ・16 文字まで）
function cleanCustomIcon(v) {
  const s = String(v || '').trim().replace(/[\s<>"'`&]/g, '');
  if (!s) return '';
  const parts = typeof Intl !== 'undefined' && Intl.Segmenter ? [...new Intl.Segmenter('ja', { granularity: 'grapheme' }).segment(s)].map((x) => x.segment) : [...s];
  return parts.slice(0, 2).join('').slice(0, 16);
}

/**
 * 設定から読んだカスタムエージェントの一覧を整える（名前のないもの・ID が重なるものは落とす）
 * @returns {{ id: string, name: string, icon: string, color: string, description: string, instruction: string, agent: string, model: string }[]}
 */
function cleanCustomAgents(list) {
  const out = [];
  const ids = new Set();
  for (const x of Array.isArray(list) ? list : []) {
    if (!x || typeof x !== 'object' || out.length >= MAX_CUSTOM_AGENTS) continue;
    const name = trunc(String(x.name || '').trim(), 30);
    if (!name) continue;
    let id = String(x.id || '').trim();
    if (!/^[A-Za-z0-9_-]{1,32}$/.test(id) || ids.has(id)) {
      let n = out.length + 1;
      while (ids.has(`ca${n}`)) n++;
      id = `ca${n}`;
    }
    ids.add(id);
    out.push({
      id,
      name,
      icon: cleanCustomIcon(x.icon),
      color: cleanCustomColor(x.color),
      description: trunc(String(x.description || '').trim(), 200),
      instruction: trunc(String(x.instruction || '').trim(), 4000),
      agent: isAgent(x.agent) ? x.agent : 'claude',
      model: cleanCustomModel(x.model),
    });
  }
  return out;
}
function findCustomAgent(list, id) {
  const k = customIdOf(id) || String(id || '');
  return (Array.isArray(list) ? list : []).find((x) => x && x.id === k) || null;
}
// カードに写すプロフィール
function personaOf(ca) {
  if (!ca) return null;
  return { id: ca.id, name: ca.name, icon: ca.icon || '', color: ca.color || DEFAULT_CUSTOM_COLOR, description: ca.description || '', instruction: ca.instruction || '' };
}
// 指示に付けるプロフィールの説明（説明・振る舞いの指示がなければ名前だけ）
function personaNote(p) {
  if (!p || !p.name) return '';
  const lines = ['## あなたのプロフィール', `あなたはカスタムエージェント「${p.name}」です。${p.description ? `役割: ${p.description}` : ''}`.trim()];
  if (p.instruction) lines.push('', '### 振る舞いの指示（いつも守ってください）', p.instruction);
  return lines.join('\n');
}
function withPersona(p, prompt) {
  const note = personaNote(p);
  return note ? `${note}\n\n---\n\n${prompt}` : prompt;
}

// ---------- 使うエージェント ----------
// 設定でチェックを付けたエージェントだけを、タスク・会話・Pipeline・競争で選べるようにする（1つは必ず残す）
const DEFAULT_ENABLED_AGENTS = ['claude'];
function cleanEnabledAgents(list) {
  const out = cleanCompeteAgents(list).sort((a, b) => AGENT_IDS.indexOf(a) - AGENT_IDS.indexOf(b));
  return out.length ? out : [...DEFAULT_ENABLED_AGENTS];
}
function enabledAgents(settings) {
  return cleanEnabledAgents(settings && settings.enabledAgents);
}
function isEnabled(settings, a) {
  return enabledAgents(settings).includes(a);
}
// 新しいタスク・会話で最初から選んでおくエージェント（プロジェクトごとの設定）。
// 「custom:<ID>」ならこのプロジェクトのカスタムエージェント。消えた・元の CLI を使わない設定なら、使うエージェントの先頭
function defaultAgentRefOf(settings) {
  const list = enabledAgents(settings);
  const d = settings && settings.defaultAgent;
  if (isCustomRef(d)) {
    const ca = findCustomAgent(cleanCustomAgents(settings.customAgents), d);
    return ca && list.includes(ca.agent) ? d : list[0];
  }
  return list.includes(d) ? d : list[0];
}
// 新しいタスクで最初から選んでおくもの（defaultAgent）。1つのエージェント・カスタムエージェントのほかに、
// Pipeline「relay:<ID>」・競争「compete:<ID>」も選べる。消えたものなら、1つのエージェント（defaultAgentRefOf）に戻す
function defaultTaskRefOf(settings) {
  const d = settings && settings.defaultAgent;
  if (typeof d === 'string' && d.startsWith(RELAY_PREFIX)) {
    const id = d.slice(RELAY_PREFIX.length);
    // Pipeline の一覧がまだない（前の版の relayFlow だけの）設定では、その1つを「default」と呼ぶ
    const flows = Array.isArray(settings.relayFlows) && settings.relayFlows.length ? settings.relayFlows : settings.relayFlow ? [{ id: 'default' }] : [];
    if (flows.some((p) => p && p.id === id)) return d;
  }
  if (typeof d === 'string' && d.startsWith(COMPETE_PREFIX) && competeOf(settings.competes, d)) return d;
  return defaultAgentRefOf(settings);
}
// 最初から選んでおくエージェントの CLI（カスタムエージェントなら、その元にするエージェント）。比較・Pipelineの組み立てなど、アプリが頼む作業に使う
function defaultAgentOf(settings) {
  const ref = defaultAgentRefOf(settings);
  if (!isCustomRef(ref)) return ref;
  return findCustomAgent(cleanCustomAgents(settings.customAgents), ref).agent;
}

module.exports = {
  AGENTS,
  PERMISSION_MODES,
  cleanPermissionMode,
  AGENT_IDS,
  isAgent,
  agentLabel,
  agentShort,
  agentCommand,
  agentModel,
  promptViaArg,
  buildArgs,
  rpcKindOf,
  rpcArgs,
  rpcVariants,
  rpcCommand,
  rpcSessionModel,
  isAllowedTool,
  createParser,
  trunc,
  todoItems,
  todosFromTool,
  codexPolicy,
  antigravityPolicy,
  geminiApproval,
  cursorPolicy,
  opencodePolicy,
  agentEnv,
  copilotPolicy,
  ampPolicy,
  piPolicy,
  droidPolicy,
  defaultRelaySteps,
  DEFAULT_RELAY_STEPS,
  DEFAULT_COMPETE_AGENTS,
  cleanRelaySteps,
  relayJudges,
  RELAY_MAX_LOOPS_DEFAULT,
  cleanOrchestration,
  ORCHESTRATIONS,
  cleanCompeteAgents,
  COMPETE_PREFIX,
  MAX_COMPETES,
  COMPETE_NAME_MAX,
  isCompeteRef,
  isRelayRef,
  cleanCompetes,
  legacyCompetes,
  competeOf,
  defaultTaskRefOf,
  DEFAULT_ENABLED_AGENTS,
  cleanEnabledAgents,
  enabledAgents,
  isEnabled,
  defaultAgentOf,
  defaultAgentRefOf,
  MAX_CUSTOM_AGENTS,
  CUSTOM_PREFIX,
  DEFAULT_CUSTOM_COLOR,
  isCustomRef,
  customIdOf,
  cleanCustomAgents,
  findCustomAgent,
  personaOf,
  personaNote,
  withPersona,
};
