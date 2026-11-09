// Codex（codex app-server）と ACP（Cursor・Gemini・OpenCode・Copilot・Amp・Pi）のカードの承認・質問・btw・金額
const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { execFileSync } = require('node:child_process');
const { Store } = require('../src/store');
const { AgentManager } = require('../src/agent');
const providers = require('../src/providers');
const { codexApprovalPolicy, codexCommand, acpToolInput, acpPlanMode, acpModelId, optionIds } = require('../src/agent-rpc');

const FAKE_CLI = path.join(__dirname, 'fake-agent-cli.js');

function setup(t, env = {}, settings = {}) {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'kanban-rpc-'));
  const repo = path.join(tmp, 'repo');
  fs.mkdirSync(repo);
  const g = (...a) => execFileSync('git', a, { cwd: repo });
  g('init', '-q', '-b', 'main');
  fs.writeFileSync(path.join(repo, 'README.md'), 'hello\n');
  g('add', '.');
  g('-c', 'user.name=t', '-c', 'user.email=t@t', 'commit', '-qm', 'init');
  const bin = (name, pre) => {
    const p = path.join(tmp, name);
    fs.writeFileSync(p, `#!/bin/sh\nexec "${process.execPath}" "${FAKE_CLI}" ${pre} "$@"\n`, { mode: 0o755 });
    return p;
  };
  const log = path.join(tmp, 'rpc.log');
  const saved = { ...process.env };
  // ACP のアダプタ（amp-acp）は CLI とは別のコマンドなので、PATH から探される
  const binDir = path.join(tmp, 'bin');
  fs.mkdirSync(binDir);
  fs.writeFileSync(path.join(binDir, 'amp-acp'), `#!/bin/sh\nexec "${process.execPath}" "${FAKE_CLI}" amp-acp "$@"\n`, { mode: 0o755 });
  Object.assign(process.env, { FAKE_RPC: '1', FAKE_RPC_LOG: log, FAKE_ARGS_LOG: path.join(tmp, 'args.log'), PATH: `${binDir}${path.delimiter}${process.env.PATH}` }, env);
  t.after(() => {
    process.env = saved;
  });
  const store = new Store(path.join(tmp, 'data', 'board.json'));
  Object.assign(store.settings, {
    repoPath: repo,
    codexPath: bin('codex', 'codex'),
    cursorPath: bin('cursor-agent', 'cursor'),
    geminiPath: bin('gemini', 'gemini'),
    opencodePath: bin('opencode', 'opencode'),
    copilotPath: bin('copilot', 'copilot'),
    ampPath: bin('amp', 'amp'),
    maxParallel: 3,
    enabledAgents: ['claude', 'codex', 'cursor', 'gemini', 'opencode', 'copilot', 'amp'],
    specCheck: false,
    ...settings,
  });
  const agents = new AgentManager(store, { mcpScript: path.join(__dirname, '..', 'src', 'permission-mcp.js'), mcpDir: path.join(tmp, 'data', 'mcp'), nodeBin: process.execPath });
  const sent = () => (fs.existsSync(log) ? fs.readFileSync(log, 'utf8').trim().split('\n').map((l) => JSON.parse(l)) : []);
  return { agents, store, sent, tmp };
}

function waitFor(pred, ms = 10000) {
  return new Promise((resolve, reject) => {
    const t0 = Date.now();
    const iv = setInterval(() => {
      const v = pred();
      if (v) {
        clearInterval(iv);
        resolve(v);
      } else if (Date.now() - t0 > ms) {
        clearInterval(iv);
        reject(new Error('timeout'));
      }
    }, 20);
  });
}

test('rpcKindOf: Codex は許可を聞くモードだけ、Cursor は acp で始めた会話か新しい会話だけ', () => {
  assert.strictEqual(providers.rpcKindOf('codex', 'default'), 'codex');
  assert.strictEqual(providers.rpcKindOf('codex', 'acceptEdits'), 'codex');
  assert.strictEqual(providers.rpcKindOf('codex', 'plan'), null);
  assert.strictEqual(providers.rpcKindOf('codex', 'bypassPermissions'), null);
  assert.strictEqual(providers.rpcKindOf('cursor', 'plan'), 'acp');
  assert.strictEqual(providers.rpcKindOf('cursor', 'default', { sessionId: 's', sessionVia: 'acp' }), 'acp');
  assert.strictEqual(providers.rpcKindOf('cursor', 'default', { sessionId: 's' }), null, '-p の会話は acp で続きができない');
  assert.strictEqual(providers.rpcKindOf('antigravity', 'default'), null);
  assert.strictEqual(providers.rpcKindOf('droid', 'default'), null);
});

test('rpcKindOf: Gemini・OpenCode・Copilot は ACP、Amp・Pi はアダプタで「すべて自動で許可」のときだけ', () => {
  for (const a of ['gemini', 'opencode', 'copilot']) {
    for (const m of ['plan', 'acceptEdits', 'default', 'bypassPermissions']) assert.strictEqual(providers.rpcKindOf(a, m), 'acp', `${a} ${m}`);
    assert.strictEqual(providers.rpcKindOf(a, 'default', { sessionId: 's' }), null, 'ふだんの起動で始めた会話は、そのまま続ける');
  }
  for (const a of ['amp', 'pi']) {
    assert.strictEqual(providers.rpcKindOf(a, 'bypassPermissions'), 'acp');
    assert.strictEqual(providers.rpcKindOf(a, 'acceptEdits'), null, '止めるツールを渡せないので、コマンドが動かないように');
    assert.strictEqual(providers.rpcKindOf(a, 'plan'), null);
    assert.strictEqual(providers.rpcCommand(a), `${a}-acp`);
  }
  assert.strictEqual(providers.rpcCommand('gemini'), null);
  assert.strictEqual(providers.rpcVariants('gemini'), 2);
  assert.ok(providers.rpcSessionModel('opencode'));
  assert.ok(!providers.rpcSessionModel('gemini'));
});

test('rpcArgs: ACP の CLI ごとの引数', () => {
  assert.deepStrictEqual(providers.rpcArgs('gemini', { mode: 'acceptEdits', model: 'g', includeDirs: ['/a', '/b'] }), ['--experimental-acp', '--skip-trust', '--approval-mode', 'auto_edit', '-m', 'g', '--include-directories', '/a,/b']);
  assert.deepStrictEqual(providers.rpcArgs('gemini', { variant: 1 }), ['--acp', '--skip-trust']);
  assert.deepStrictEqual(providers.rpcArgs('copilot', { mode: 'acceptEdits', model: 'm', includeDirs: ['/a'] }), ['--acp', '--allow-tool=write', '--model=m', '--add-dir=/a']);
  assert.deepStrictEqual(providers.rpcArgs('copilot', { mode: 'bypassPermissions' }), ['--acp', '--allow-all']);
  assert.deepStrictEqual(providers.rpcArgs('opencode', { mode: 'default' }), ['acp']);
  assert.deepStrictEqual(providers.rpcArgs('amp', { mode: 'bypassPermissions' }), []);
  assert.throws(() => providers.rpcArgs('droid', {}));
});

test('acpPlanMode / acpModelId / optionIds', () => {
  assert.strictEqual(acpPlanMode({}), 'plan', 'モードの一覧がなければ plan を試す');
  assert.strictEqual(acpPlanMode({ modes: { availableModes: [{ id: 'build' }, { id: 'plan', name: 'Plan' }] } }), 'plan');
  assert.strictEqual(acpPlanMode({ modes: { availableModes: [{ id: 'architect', name: 'Planning' }] } }), 'architect');
  assert.strictEqual(acpPlanMode({ modes: { availableModes: [{ id: 'default' }, { id: 'yolo' }] } }), null);
  const res = { models: { availableModels: [{ modelId: 'anthropic/claude-sonnet-4', name: 'Claude Sonnet 4' }, { modelId: 'openai/gpt-5', name: 'GPT-5' }] } };
  assert.strictEqual(acpModelId(res, 'openai/gpt-5'), 'openai/gpt-5');
  assert.strictEqual(acpModelId(res, 'gpt-5'), 'openai/gpt-5');
  assert.strictEqual(acpModelId(res, 'Claude Sonnet 4'), 'anthropic/claude-sonnet-4');
  assert.strictEqual(acpModelId(res, 'nope'), null);
  const opts = [{ id: 'r', label: '赤' }, { id: 'b', label: '青' }, { id: 'x', label: 'A, B' }];
  assert.deepStrictEqual(optionIds(opts, '赤'), ['r']);
  assert.deepStrictEqual(optionIds(opts, '赤, 青'), ['r', 'b']);
  assert.deepStrictEqual(optionIds(opts, 'A, B'), ['x']);
  assert.strictEqual(optionIds(opts, '緑がいい'), null);
});

test('rpcArgs: Cursor のすべて許可とモデルは起動の引数で渡す', () => {
  assert.deepStrictEqual(providers.rpcArgs('codex', {}), ['app-server']);
  assert.deepStrictEqual(providers.rpcArgs('cursor', { mode: 'default' }), ['acp']);
  assert.deepStrictEqual(providers.rpcArgs('cursor', { mode: 'bypassPermissions', model: 'gpt-5' }), ['--force', '--approve-mcps', '--model', 'gpt-5', 'acp']);
});

test('codexApprovalPolicy: 毎回確認と sandbox の外だけ確認', () => {
  assert.deepStrictEqual(codexApprovalPolicy('default'), { approvalPolicy: 'untrusted', sandbox: 'workspace-write' });
  assert.deepStrictEqual(codexApprovalPolicy('acceptEdits'), { approvalPolicy: 'on-request', sandbox: 'workspace-write' });
  assert.strictEqual(codexApprovalPolicy('plan'), null);
});

test('codexCommand: シェルで包まれたコマンドの中身を出す', () => {
  assert.strictEqual(codexCommand({ command: "/bin/zsh -lc 'ls'", commandActions: [{ command: 'ls' }] }), 'ls');
  assert.strictEqual(codexCommand({ command: "/bin/zsh -lc 'a && b'", commandActions: [{ command: 'a' }, { command: 'b' }] }), "/bin/zsh -lc 'a && b'");
  assert.strictEqual(codexCommand({ command: ['git', 'status'] }), 'git status');
});

test('acpToolInput: 種類から名前を決める', () => {
  assert.deepStrictEqual(acpToolInput({ kind: 'execute', title: '`ls -la`' }), { name: 'Bash', input: { command: 'ls -la' } });
  assert.deepStrictEqual(acpToolInput({ kind: 'edit', title: 'Edit', locations: [{ path: '/a/b' }] }), { name: 'Edit', input: { file_path: '/a/b' } });
  assert.strictEqual(acpToolInput({ kind: 'other', title: 'mcp: foo' }).name, 'Tool: mcp: foo');
  assert.strictEqual(acpToolInput({ kind: 'other', title: 'AskUserQuestion' }).name, 'Tool: AskUserQuestion', 'カードの特別な名前にならない');
});

test('isAllowedTool: 許可しておくツールの書き方', () => {
  const list = ['Bash(npm test:*)', 'Bash(git status)', 'WebFetch'];
  const bash = (command) => providers.isAllowedTool(list, 'Bash', { command });
  assert.ok(bash('npm test'));
  assert.ok(bash('npm test -- x'));
  assert.ok(bash('git status'));
  assert.ok(!bash('git status -s'));
  assert.ok(!bash('npm testing'));
  assert.ok(!bash('npm test; rm -rf x'), 'つないだコマンドは通さない');
  assert.ok(!bash('npm test && rm x'));
  assert.ok(!bash('npm test $(rm x)'));
  assert.ok(providers.isAllowedTool(list, 'WebFetch', { url: 'x' }));
  assert.ok(!providers.isAllowedTool(list, 'Edit', { file_path: 'x' }));
});

test('Codex: 毎回確認ではコマンドと編集がカードに出て、許可すると動く', async (t) => {
  const { agents, store, sent } = setup(t);
  store.settings.permissionMode = 'default';
  const [c] = agents.createTask({ title: 'cx', prompt: 'やって', agent: 'codex' });
  agents.start(c.id);
  await waitFor(() => c.permissions.length === 1);
  assert.strictEqual(c.permissions[0].toolName, 'Bash');
  assert.match(c.permissions[0].summary, /^touch approved\.txt$/);
  agents.answerPermission(c.id, c.permissions[0].id, 'allow');
  await waitFor(() => c.permissions.length === 1 && c.permissions[0].toolName === 'Edit');
  assert.match(c.permissions[0].summary, /edited\.txt$/);
  agents.answerPermission(c.id, c.permissions[0].id, 'allow');
  await waitFor(() => c.status === 'review');
  assert.strictEqual(c.lastText, 'できました');
  assert.strictEqual(c.sessionVia, 'codex');
  assert.ok(c.todos.items.some((x) => x.text === 'do it'));
  const start = sent().find((m) => m.method === 'thread/start' && !m.params.ephemeral);
  assert.strictEqual(start.params.approvalPolicy, 'untrusted');
  assert.strictEqual(start.params.sandbox, 'workspace-write');
  assert.deepStrictEqual(sent().filter((m) => m.result && m.result.decision).map((m) => m.result.decision), ['accept', 'accept']);
  assert.ok(fs.existsSync(path.join(c.worktreePath, 'approved.txt')) || (await agents.diff(c.id)).includes('approved.txt'));
});

test('Codex: 拒否すると decline を返し、エージェントは続ける', async (t) => {
  const { agents, sent } = setup(t);
  const [c] = agents.createTask({ title: 'cx', prompt: 'やって', agent: 'codex' });
  agents.start(c.id);
  await waitFor(() => c.permissions.length === 1);
  agents.answerPermission(c.id, c.permissions[0].id, 'deny');
  await waitFor(() => c.permissions.length === 1 && c.permissions[0].toolName === 'Edit');
  agents.answerPermission(c.id, c.permissions[0].id, 'deny');
  await waitFor(() => c.status === 'review');
  assert.deepStrictEqual(sent().filter((m) => m.result && m.result.decision).map((m) => m.result.decision), ['decline', 'decline']);
  assert.ok(c.logs.some((l) => l.kind === 'tool_error'));
  assert.ok(!(await agents.diff(c.id)).includes('approved.txt'));
});

test('Codex: 常に許可はそのカードの中で覚える', async (t) => {
  const { agents, sent } = setup(t);
  const [c] = agents.createTask({ title: 'cx', prompt: 'やって', agent: 'codex' });
  c.alwaysAllow = ['Bash', 'Edit'];
  agents.start(c.id);
  await waitFor(() => c.status === 'review');
  assert.deepStrictEqual(sent().filter((m) => m.result && m.result.decision).map((m) => m.result.decision), ['accept', 'accept']);
});

test('Codex: 許可しておくツールに入っていれば聞かない', async (t) => {
  const { agents, sent } = setup(t, {}, { allowedTools: 'Bash(touch:*), Edit' });
  const [c] = agents.createTask({ title: 'cx', prompt: 'やって', agent: 'codex' });
  agents.start(c.id);
  await waitFor(() => c.status === 'review');
  assert.strictEqual(sent().filter((m) => m.result && m.result.decision).length, 2);
});

test('Codex: ターンの失敗は失敗にする', async (t) => {
  const { agents } = setup(t, { FAKE_RPC_FAIL: '1' });
  const [c] = agents.createTask({ title: 'cx', prompt: 'やって', agent: 'codex' });
  agents.start(c.id);
  await waitFor(() => c.status === 'failed');
  assert.match(c.error, /model exploded/);
});

test('Codex: ターンの途中で落ちたら失敗にする', async (t) => {
  const { agents } = setup(t, { FAKE_RPC_CRASH: '1' });
  const [c] = agents.createTask({ title: 'cx', prompt: 'やって', agent: 'codex' });
  agents.start(c.id);
  await waitFor(() => c.status === 'failed');
});

test('Codex: 計画だけは exec のまま', async (t) => {
  const { agents, store, tmp } = setup(t);
  store.settings.permissionMode = 'plan';
  const [c] = agents.createTask({ title: 'cx', prompt: 'コーデックスで作って', agent: 'codex' });
  agents.start(c.id);
  await waitFor(() => c.status === 'review');
  const calls = fs.readFileSync(path.join(tmp, 'args.log'), 'utf8').trim().split('\n').map((l) => JSON.parse(l));
  assert.ok(calls.some((x) => x.args[0] === 'exec'));
  assert.ok(!calls.some((x) => x.args.includes('app-server')));
});

test('対応していない版は、確かめたうえで前の起動のしかたに戻す', async (t) => {
  const { agents, tmp } = setup(t, { FAKE_RPC: '' });
  const [c] = agents.createTask({ title: 'cx', prompt: 'コーデックスで作って', agent: 'codex' });
  agents.start(c.id);
  await waitFor(() => c.status === 'review');
  assert.ok(c.logs.some((l) => l.kind === 'system' && /承認のやりとりに対応していない/.test(l.text)));
  const calls = fs.readFileSync(path.join(tmp, 'args.log'), 'utf8').trim().split('\n').map((l) => JSON.parse(l));
  assert.ok(calls.some((x) => x.args[0] === 'exec'));
});

test('Cursor: コマンドがカードに出て、許可すると動く。会話は acp で続ける', async (t) => {
  const { agents, sent } = setup(t);
  const [c] = agents.createTask({ title: 'cu', prompt: 'やって', agent: 'cursor' });
  agents.start(c.id);
  await waitFor(() => c.permissions.length === 1);
  assert.strictEqual(c.permissions[0].toolName, 'Bash');
  assert.strictEqual(c.permissions[0].summary, 'touch approved.txt');
  assert.match(c.permissions[0].detail, /Not in allowlist/);
  agents.answerPermission(c.id, c.permissions[0].id, 'allow');
  await waitFor(() => c.status === 'review');
  assert.strictEqual(c.lastText, 'できました');
  assert.strictEqual(c.sessionVia, 'acp');
  assert.ok(c.logs.some((l) => l.kind === 'text' && l.text === '動かします'));
  assert.ok(c.logs.some((l) => l.kind === 'tool' && /^Bash/.test(l.text)));
  assert.ok(c.logs.some((l) => l.kind === 'tool_result' && l.text === 'ok'));
  assert.deepStrictEqual(sent().filter((m) => m.result && m.result.outcome).map((m) => m.result.outcome.optionId), ['allow-once']);

  // 追加指示: 前の会話を読み込んで続ける（流れてくる前の返事は出さない）
  agents.send(c.id, '続けて');
  await waitFor(() => c.permissions.length === 1);
  assert.ok(sent().some((m) => m.method === 'session/load' && m.params.sessionId === c.sessionId));
  assert.ok(!c.logs.some((l) => l.kind === 'text' && /前の返事/.test(l.text)));
  agents.answerPermission(c.id, c.permissions[0].id, 'deny');
  await waitFor(() => c.status === 'review');
  assert.strictEqual(sent().filter((m) => m.result && m.result.outcome).pop().result.outcome.optionId, 'reject-once');
});

test('Cursor: 会話を読み込めないときは新しい会話で始める', async (t) => {
  const { agents, sent } = setup(t, { FAKE_RPC_NO_LOAD: '1' });
  const [c] = agents.createTask({ title: 'cu', prompt: 'やって', agent: 'cursor' });
  c.sessionId = 'aaaaaaaa-0000-4000-8000-000000000000';
  c.sessionVia = 'acp';
  agents.start(c.id);
  await waitFor(() => c.permissions.length === 1);
  assert.ok(sent().some((m) => m.method === 'session/new'));
  assert.notStrictEqual(c.sessionId, 'aaaaaaaa-0000-4000-8000-000000000000');
  agents.answerPermission(c.id, c.permissions[0].id, 'allow');
  await waitFor(() => c.status === 'review');
});

test('Cursor: 計画だけは plan モードにする', async (t) => {
  const { agents, store, sent } = setup(t);
  store.settings.permissionMode = 'plan';
  const [c] = agents.createTask({ title: 'cu', prompt: 'やって', agent: 'cursor' });
  agents.start(c.id);
  await waitFor(() => c.permissions.length === 1);
  assert.ok(sent().some((m) => m.method === 'session/set_mode' && m.params.modeId === 'plan'));
  agents.answerPermission(c.id, c.permissions[0].id, 'deny');
  await waitFor(() => c.status === 'review');
});

test('Cursor: 途中で止まった理由は失敗として出す', async (t) => {
  const { agents } = setup(t, { FAKE_RPC_STOP: 'refusal' });
  const [c] = agents.createTask({ title: 'cu', prompt: 'やって', agent: 'cursor' });
  agents.start(c.id);
  await waitFor(() => c.permissions.length === 1);
  agents.answerPermission(c.id, c.permissions[0].id, 'allow');
  await waitFor(() => c.status === 'failed');
  assert.match(c.error, /refusal/);
});

test('実行を止めると、待っている承認は取り消される', async (t) => {
  const { agents } = setup(t);
  const [c] = agents.createTask({ title: 'cu', prompt: 'やって', agent: 'cursor' });
  agents.start(c.id);
  await waitFor(() => c.permissions.length === 1);
  agents.stop(c.id);
  await waitFor(() => c.status === 'review');
  assert.strictEqual(c.permissions.length, 0);
});

test('Cursor: 前の版の -p の会話は -p で続ける', async (t) => {
  const { agents, tmp } = setup(t);
  const [c] = agents.createTask({ title: 'cu', prompt: 'カーソルで作って', agent: 'cursor' });
  c.sessionId = 'cursor-chat-1';
  agents.start(c.id);
  await waitFor(() => c.status === 'review');
  const calls = fs.readFileSync(path.join(tmp, 'args.log'), 'utf8').trim().split('\n').map((l) => JSON.parse(l));
  assert.ok(calls.some((x) => x.args.includes('-p') && x.args.includes('--resume')));
  assert.ok(!calls.some((x) => x.args.includes('acp')));
});

const rpcCalls = (tmp) => fs.readFileSync(path.join(tmp, 'args.log'), 'utf8').trim().split('\n').map((l) => JSON.parse(l));

test('Gemini: ACP で動かし、コマンドをカードで承認する。金額を足す', async (t) => {
  const { agents, sent, tmp } = setup(t, { FAKE_ACP_COST: '0.25' });
  const [c] = agents.createTask({ title: 'ge', prompt: 'やって', agent: 'gemini' });
  agents.start(c.id);
  await waitFor(() => c.permissions.length === 1);
  assert.strictEqual(c.permissions[0].toolName, 'Bash');
  agents.answerPermission(c.id, c.permissions[0].id, 'allow');
  await waitFor(() => c.status === 'review');
  assert.strictEqual(c.sessionVia, 'acp');
  assert.strictEqual(c.costUsd, 0.25);
  assert.ok(c.logs.some((l) => l.kind === 'result' && /\$0\.250/.test(l.text)));
  const run = rpcCalls(tmp).find((x) => x.kind === 'gemini' && x.args.includes('--approval-mode'));
  assert.ok(run.args.includes('--experimental-acp'));
  assert.deepStrictEqual(sent().filter((m) => m.result && m.result.outcome).map((m) => m.result.outcome.optionId), ['allow-once']);

  // 続きの会話: 合計が 0.4 になったら、増えた 0.15 だけ足す
  process.env.FAKE_ACP_COST = '0.4';
  agents.send(c.id, '続けて');
  await waitFor(() => c.permissions.length === 1);
  agents.answerPermission(c.id, c.permissions[0].id, 'allow');
  await waitFor(() => c.status === 'review' && c.logs.filter((l) => l.kind === 'result').length === 2);
  assert.strictEqual(Math.round(c.costUsd * 1000) / 1000, 0.4);
});

test('Gemini: 1つ目の引数で ACP を話さない版は、次の引数（--acp）で動かす', async (t) => {
  const { agents, tmp } = setup(t, { FAKE_ACP_ARG: '--acp' });
  const [c] = agents.createTask({ title: 'ge', prompt: 'やって', agent: 'gemini' });
  agents.start(c.id);
  await waitFor(() => c.permissions.length === 1);
  agents.answerPermission(c.id, c.permissions[0].id, 'allow');
  await waitFor(() => c.status === 'review');
  assert.ok(rpcCalls(tmp).some((x) => x.kind === 'gemini' && x.args[0] === '--acp' && x.args.includes('--approval-mode')));
});

test('OpenCode: 許可は環境変数で「確認」にしてカードに出し、モデルは会話に設定する', async (t) => {
  const models = JSON.stringify([{ modelId: 'anthropic/claude-sonnet-4', name: 'Sonnet' }]);
  const { agents, store, sent } = setup(t, { FAKE_ACP_MODELS: models });
  store.settings.opencodeModel = 'claude-sonnet-4';
  const [c] = agents.createTask({ title: 'oc', prompt: 'やって', agent: 'opencode' });
  agents.start(c.id);
  await waitFor(() => c.permissions.length === 1);
  agents.answerPermission(c.id, c.permissions[0].id, 'deny');
  await waitFor(() => c.status === 'review');
  const set = sent().find((m) => m.method === 'session/set_model');
  assert.strictEqual(set.params.modelId, 'anthropic/claude-sonnet-4');
});

test('Copilot: 計画だけのモードがないときは、読み取り以外をこちらで断る', async (t) => {
  const { agents, store, sent } = setup(t, { FAKE_ACP_MODES: JSON.stringify([{ id: 'agent', name: 'Agent' }]) });
  store.settings.permissionMode = 'plan';
  const [c] = agents.createTask({ title: 'co', prompt: 'やって', agent: 'copilot' });
  agents.start(c.id);
  await waitFor(() => c.status === 'review');
  assert.ok(!sent().some((m) => m.method === 'session/set_mode'));
  assert.deepStrictEqual(sent().filter((m) => m.result && m.result.outcome).map((m) => m.result.outcome.optionId), ['reject-once']);
  assert.strictEqual(c.permissions.length, 0);
});

test('Amp: 「すべて自動で許可」なら amp-acp で動かし、許可を聞かずに通す。ほかのモードはふだんの起動', async (t) => {
  const { agents, store, sent, tmp } = setup(t);
  store.settings.permissionMode = 'bypassPermissions';
  const [c] = agents.createTask({ title: 'am', prompt: 'やって', agent: 'amp' });
  agents.start(c.id);
  await waitFor(() => c.status === 'review');
  assert.strictEqual(c.sessionVia, 'acp');
  assert.deepStrictEqual(sent().filter((m) => m.result && m.result.outcome).map((m) => m.result.outcome.optionId), ['allow-once']);
  assert.ok(rpcCalls(tmp).some((x) => x.kind === 'amp-acp'));

  // 権限モードを変えると、ACP の会話は続けられないので新しい会話で始める
  store.settings.permissionMode = 'acceptEdits';
  agents.send(c.id, 'アンプで続けて');
  await waitFor(() => c.status === 'review' && c.logs.filter((l) => l.kind === 'result').length === 2);
  assert.ok(c.logs.some((l) => l.kind === 'system' && /ACP で始めたので/.test(l.text)));
  const last = rpcCalls(tmp).filter((x) => x.kind === 'amp').pop();
  assert.ok(last.args.includes('-x') && !last.args.includes('threads'));
});

test('Amp: amp-acp が使えなければ、ふだんの起動のしかたで動かす', async (t) => {
  const { agents, store } = setup(t, { FAKE_ACP_ARG: '--never' });
  store.settings.permissionMode = 'bypassPermissions';
  const [c] = agents.createTask({ title: 'am', prompt: 'アンプで作って', agent: 'amp' });
  agents.start(c.id);
  await waitFor(() => c.status === 'review');
  assert.ok(c.logs.some((l) => l.kind === 'system' && /amp-acp が見つからないか使えない/.test(l.text)));
});

test('Cursor: cursor/ask_question を質問カードに出し、選んだ選択肢の ID を返す', async (t) => {
  const { agents, sent } = setup(t, { FAKE_RPC_FLOW: 'ask' });
  const [c] = agents.createTask({ title: 'cu', prompt: 'やって', agent: 'cursor' });
  agents.start(c.id);
  await waitFor(() => (c.questions || []).length === 1);
  assert.strictEqual(c.questions[0].questions[0].question, 'どの色？');
  assert.deepStrictEqual(c.questions[0].questions[0].options.map((o) => o.label), ['赤', '青']);
  agents.answerQuestion(c.id, c.questions[0].id, { 'どの色？': '青' });
  await waitFor(() => c.status === 'review');
  const r = sent().find((m) => m.result && m.result.outcome && m.result.outcome.outcome);
  assert.deepStrictEqual(r.result.outcome, { outcome: 'answered', answers: [{ questionId: 'q1', selectedOptionIds: ['blue'] }] });
});

test('Cursor: 選択肢にない答えは、飛ばした理由として渡す', async (t) => {
  const { agents, sent } = setup(t, { FAKE_RPC_FLOW: 'ask' });
  const [c] = agents.createTask({ title: 'cu', prompt: 'やって', agent: 'cursor' });
  agents.start(c.id);
  await waitFor(() => (c.questions || []).length === 1);
  agents.answerQuestion(c.id, c.questions[0].id, { 'どの色？': '緑にして' });
  await waitFor(() => c.status === 'review');
  const r = sent().find((m) => m.result && m.result.outcome && m.result.outcome.outcome);
  assert.strictEqual(r.result.outcome.outcome, 'skipped');
  assert.match(r.result.outcome.reason, /どの色？ → 緑にして/);
});

test('Codex: item/tool/requestUserInput を質問カードに出して答える', async (t) => {
  const { agents } = setup(t, { FAKE_RPC_FLOW: 'ask' });
  const [c] = agents.createTask({ title: 'cx', prompt: 'やって', agent: 'codex' });
  agents.start(c.id);
  await waitFor(() => (c.questions || []).length === 1);
  assert.strictEqual(c.questions[0].questions[0].header, '色');
  agents.answerQuestion(c.id, c.questions[0].id, { 'どの色？': '赤' });
  await waitFor(() => c.status === 'review');
  assert.strictEqual(c.lastText, '答え: {"color":{"answers":["赤"]}}');
});

test('Codex: 答えずに続けると空の答えを返す', async (t) => {
  const { agents } = setup(t, { FAKE_RPC_FLOW: 'ask' });
  const [c] = agents.createTask({ title: 'cx', prompt: 'やって', agent: 'codex' });
  agents.start(c.id);
  await waitFor(() => (c.questions || []).length === 1);
  agents.answerQuestion(c.id, c.questions[0].id, null);
  await waitFor(() => c.status === 'review');
  assert.strictEqual(c.lastText, '答え: {}');
});

test('Codex: 実行中の btw は turn/steer で作業の途中に足す', async (t) => {
  const { agents, sent } = setup(t, { FAKE_RPC_FLOW: 'btw' });
  const [c] = agents.createTask({ title: 'cx', prompt: 'やって', agent: 'codex' });
  agents.start(c.id);
  await waitFor(() => sent().some((m) => m.method === 'turn/start') && c.status === 'running');
  await new Promise((r) => setTimeout(r, 100));
  const entry = agents.btw(c.id, 'テストも書いて');
  assert.strictEqual(entry.state, 'sent');
  await waitFor(() => c.status === 'review');
  assert.strictEqual(c.lastText, '受け取りました: テストも書いて');
  assert.strictEqual(c.btw[0].state, 'delivered');
  assert.strictEqual(sent().filter((m) => m.method === 'turn/start' && m.params.threadId).length, 1, '追加指示にはしない');
});

test('ACP: 実行中の btw は今のターンを止めて、次のターンとして送る', async (t) => {
  const { agents, sent } = setup(t, { FAKE_RPC_FLOW: 'btw', FAKE_ACP_COST: '0.1' });
  const [c] = agents.createTask({ title: 'ge', prompt: 'やって', agent: 'gemini' });
  agents.start(c.id);
  await waitFor(() => c.logs.some((l) => l.kind === 'system' && /セッション開始/.test(l.text)));
  await waitFor(() => sent().some((m) => m.method === 'session/prompt'));
  const entry = agents.btw(c.id, 'その API は使わないで');
  assert.strictEqual(entry.state, 'sent');
  await waitFor(() => c.status === 'review');
  assert.ok(sent().some((m) => m.method === 'session/cancel'));
  const prompts = sent().filter((m) => m.method === 'session/prompt');
  assert.strictEqual(prompts.length, 2);
  assert.match(prompts[1].params.prompt[0].text, /作業を一度止めました[\s\S]*その API は使わないで$/);
  assert.strictEqual(c.lastText, '受け取りました: その API は使わないで');
  assert.strictEqual(c.btw[0].state, 'delivered');
  assert.strictEqual(c.costUsd, 0.1);
});

test('いつもの起動のしかたで動いている CLI の btw は、終わったあとの追加指示にする', async (t) => {
  const { agents } = setup(t, { FAKE_RPC: '', FAKE_SLEEP: '1500' });
  const [c] = agents.createTask({ title: 'cx', prompt: 'コーデックスで作って', agent: 'codex' });
  agents.start(c.id);
  await waitFor(() => c.status === 'running' && c.sessionId);
  const entry = agents.btw(c.id, 'あとで');
  assert.strictEqual(entry.state, 'follow');
  await waitFor(() => c.btw[0].state === 'delivered');
});
