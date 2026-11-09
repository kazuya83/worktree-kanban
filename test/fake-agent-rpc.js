// テスト用の偽 codex app-server / 偽 ACP の CLI（cursor-agent acp・gemini --experimental-acp・opencode acp・copilot --acp・amp-acp・pi-acp）。
// 本物と同じ形で話し、touch-approved.txt を作るコマンドの許可を聞いて、許可されたらファイルを作る
//（形は Codex 0.167.0・Cursor 2026.11.05 の実機のやりとりと、ACP の仕様を写したもの）
// FAKE_RPC_FLOW で動きを変える:
//   ask: 選択肢の質問をする（Codex は item/tool/requestUserInput、ACP は cursor/ask_question）
//   btw: 作業の途中で btw を待つ（Codex は turn/steer、ACP は session/cancel のあと次のターン）
// FAKE_ACP_MODES / FAKE_ACP_MODELS: session/new の modes.availableModes / models.availableModels（JSON）
// FAKE_ACP_COST: ターンの終わりに知らせる会話の合計金額（usage_update）
// FAKE_ACP_ARG: この引数がないときは ACP を話さずに終わる（版によって引数が違う CLI を試す）
const fs = require('fs');
const readline = require('readline');

const log = (o) => process.env.FAKE_RPC_LOG && fs.appendFileSync(process.env.FAKE_RPC_LOG, `${JSON.stringify(o)}\n`);
const out = (o) => process.stdout.write(`${JSON.stringify(o)}\n`);
const THREAD = '01a1b259-9848-79a0-aeff-73cafc4a7399';
const SESSION = '1c90448d-0b6f-44bd-96e6-eba7e8118472';

const FLOW = process.env.FAKE_RPC_FLOW || '';
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function run(kind, args) {
  if (process.env.FAKE_ACP_ARG && kind !== 'codex' && !args.includes(process.env.FAKE_ACP_ARG)) process.exit(2);
  let nextServerId = 100;
  const waiting = new Map();
  const ask = (method, params, jsonrpc) =>
    new Promise((resolve) => {
      const id = nextServerId++;
      waiting.set(id, resolve);
      out({ ...(jsonrpc ? { jsonrpc: '2.0' } : {}), id, method, params });
    });
  const write = (name) => fs.writeFileSync(name, 'x');
  const jsonrpc = kind !== 'codex';
  const notes = {}; // こちらへのお知らせ（session/cancel など）を待つ
  const handlers = kind === 'codex' ? codex(ask, write) : acp(ask, write, args, notes);
  readline.createInterface({ input: process.stdin }).on('line', async (line) => {
    if (!line.trim()) return;
    const m = JSON.parse(line);
    log(m);
    if (m.method == null) {
      waiting.get(m.id)?.(m.result);
      return;
    }
    if (m.id == null) {
      notes[m.method]?.(m.params);
      return;
    }
    const h = handlers[m.method];
    if (!h) {
      out({ ...(jsonrpc ? { jsonrpc: '2.0' } : {}), id: m.id, error: { code: -32601, message: 'not found' } });
      return;
    }
    const base = { ...(jsonrpc ? { jsonrpc: '2.0' } : {}), id: m.id };
    await h(m.params || {}, (result) => out({ ...base, result }), (error) => out({ ...base, error }));
  });
  process.stdin.on('end', () => process.exit(0));
}

function codex(ask, write) {
  const note = (method, params) => out({ method, params });
  const turnId = 'turn-1';
  let steered = null;
  const done = (threadId, text) => {
    note('item/completed', { item: { type: 'agentMessage', id: 'm', text }, threadId, turnId });
    note('turn/completed', { threadId, turn: { id: turnId, status: 'completed' } });
  };
  return {
    'turn/steer': (p, reply, fail) => {
      if (p.expectedTurnId !== turnId) return fail({ code: -32602, message: 'no active turn' });
      reply({ turnId });
      steered?.(p.input.map((x) => x.text).join(''));
    },
    initialize: (_p, reply) => reply({ userAgent: 'fake', platformOs: 'macos' }),
    'thread/start': (_p, reply) => reply({ thread: { id: THREAD }, model: 'fake-model' }),
    'thread/resume': (p, reply) => reply({ thread: { id: p.threadId }, model: 'fake-model' }),
    'turn/start': async (p, reply) => {
      reply({ turn: { id: turnId, status: 'inProgress' } });
      if (process.env.FAKE_RPC_CRASH) process.exit(3);
      if (FLOW === 'ask') {
        const r = await ask('item/tool/requestUserInput', { threadId: p.threadId, turnId, itemId: 'q1', questions: [{ id: 'color', header: '色', question: 'どの色？', isOther: true, isSecret: false, options: [{ label: '赤', description: 'red' }, { label: '青', description: 'blue' }] }] });
        done(p.threadId, `答え: ${JSON.stringify(r.answers)}`);
        return;
      }
      if (FLOW === 'btw') {
        const said = await new Promise((r) => (steered = r));
        done(p.threadId, `受け取りました: ${said.split('\n').pop()}`);
        return;
      }
      if (process.env.FAKE_RPC_FAIL) {
        note('turn/completed', { threadId: p.threadId, turn: { id: turnId, status: 'failed', error: { message: 'model exploded' } } });
        return;
      }
      const command = "/bin/zsh -lc 'touch approved.txt'";
      const commandActions = [{ type: 'unknown', command: 'touch approved.txt' }];
      note('item/started', { item: { type: 'commandExecution', id: 'c1', command, commandActions, status: 'inProgress' }, threadId: p.threadId, turnId });
      const r = await ask('item/commandExecution/requestApproval', { threadId: p.threadId, turnId, itemId: 'c1', command, commandActions, cwd: process.cwd(), reason: 'because' });
      if (r.decision === 'accept') write('approved.txt');
      const status = r.decision === 'accept' ? 'completed' : 'declined';
      note('item/completed', { item: { type: 'commandExecution', id: 'c1', command, commandActions, status, exitCode: status === 'completed' ? 0 : null, aggregatedOutput: status === 'completed' ? 'ok' : null }, threadId: p.threadId, turnId });
      const changes = [{ path: `${process.cwd()}/edited.txt`, kind: { type: 'add' }, diff: 'one\n' }];
      note('item/started', { item: { type: 'fileChange', id: 'f1', changes, status: 'inProgress' }, threadId: p.threadId, turnId });
      const f = await ask('item/fileChange/requestApproval', { threadId: p.threadId, turnId, itemId: 'f1', reason: null, grantRoot: null });
      if (f.decision === 'accept') write('edited.txt');
      note('item/completed', { item: { type: 'fileChange', id: 'f1', changes, status: f.decision === 'accept' ? 'completed' : 'declined' }, threadId: p.threadId, turnId });
      note('turn/plan/updated', { threadId: p.threadId, turnId, plan: [{ step: 'do it', status: 'completed' }] });
      note('item/completed', { item: { type: 'agentMessage', id: 'm', text: 'できました' }, threadId: p.threadId, turnId });
      note('turn/completed', { threadId: p.threadId, turn: { id: turnId, status: 'completed' } });
    },
  };
}

function acp(ask, write, args, notes) {
  const note = (sessionId, update) => out({ jsonrpc: '2.0', method: 'session/update', params: { sessionId, update } });
  const json = (name) => (process.env[name] ? JSON.parse(process.env[name]) : undefined);
  const extra = () => ({ ...(json('FAKE_ACP_MODES') ? { modes: { currentModeId: 'x', availableModes: json('FAKE_ACP_MODES') } } : {}), ...(json('FAKE_ACP_MODELS') ? { models: { currentModelId: 'x', availableModels: json('FAKE_ACP_MODELS') } } : {}) });
  const cost = (s) => process.env.FAKE_ACP_COST && note(s, { sessionUpdate: 'usage_update', used: 1000, size: 200000, cost: { amount: Number(process.env.FAKE_ACP_COST), currency: 'USD' } });
  let turns = 0;
  return {
    initialize: (_p, reply) => reply({ protocolVersion: 1, agentCapabilities: { loadSession: true } }),
    'session/new': (_p, reply) => reply({ sessionId: SESSION, ...extra() }),
    'session/set_model': (_p, reply) => reply({}),
    'session/load': (p, reply, fail) => {
      if (process.env.FAKE_RPC_NO_LOAD) {
        fail({ code: -32602, message: 'Invalid params', data: { message: 'Session not found' } });
        return;
      }
      // 前の会話が流れてくる
      note(p.sessionId, { sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: '前の返事' } });
      reply({ ...extra() });
    },
    'session/set_mode': (_p, reply) => reply({}),
    'session/prompt': async (p, reply) => {
      const s = p.sessionId;
      turns++;
      const said = p.prompt.map((x) => x.text).join('');
      if (FLOW === 'ask') {
        const r = await ask('cursor/ask_question', { toolCallId: 'ask-1', title: '確認', questions: [{ id: 'q1', prompt: 'どの色？', options: [{ id: 'red', label: '赤' }, { id: 'blue', label: '青' }], allowMultiple: false }] }, true);
        note(s, { sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: `答え: ${JSON.stringify(r.outcome)}` } });
        reply({ stopReason: 'end_turn' });
        return;
      }
      if (FLOW === 'btw') {
        if (turns === 1) {
          note(s, { sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: '作業中' } });
          await new Promise((r) => (notes['session/cancel'] = r));
          reply({ stopReason: 'cancelled' });
          return;
        }
        note(s, { sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: `受け取りました: ${said.split('\n').pop()}` } });
        cost(s);
        reply({ stopReason: 'end_turn' });
        return;
      }
      if (args.includes('--force')) write('forced.txt');
      note(s, { sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: '動かします' } });
      const toolCallId = 'call-1\nfc_1';
      note(s, { sessionUpdate: 'tool_call', toolCallId, title: '`touch approved.txt`', kind: 'execute', status: 'pending', rawInput: { command: 'touch approved.txt' } });
      note(s, { sessionUpdate: 'tool_call_update', toolCallId, status: 'in_progress' });
      const r = await ask(
        'session/request_permission',
        {
          sessionId: s,
          toolCall: { toolCallId, title: '`touch approved.txt`', kind: 'execute', status: 'pending', content: [{ type: 'content', content: { type: 'text', text: 'Not in allowlist: touch' } }] },
          options: [
            { optionId: 'allow-once', name: 'Allow once', kind: 'allow_once' },
            { optionId: 'allow-always', name: 'Allow always', kind: 'allow_always' },
            { optionId: 'reject-once', name: 'Reject', kind: 'reject_once' },
          ],
        },
        true,
      );
      const ok = r.outcome.optionId === 'allow-once';
      if (ok) write('approved.txt');
      note(s, { sessionUpdate: 'tool_call_update', toolCallId, status: 'completed', ...(ok ? { rawOutput: { exitCode: 0, stdout: 'ok', stderr: '' } } : {}) });
      note(s, { sessionUpdate: 'plan', entries: [{ content: 'do it', priority: 'medium', status: 'completed' }] });
      note(s, { sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: 'できました' } });
      cost(s);
      await sleep(0);
      reply({ stopReason: process.env.FAKE_RPC_STOP || 'end_turn' });
    },
  };
}

module.exports = { run };
