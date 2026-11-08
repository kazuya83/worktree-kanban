// OpenCode / Copilot CLI / Amp / Pi / Droid: 起動の引数・出力の読み取り・タスクとしての流れ
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { execFileSync } = require('child_process');
const { Store } = require('../src/store');
const { AgentManager } = require('../src/agent');
const providers = require('../src/providers');

const FAKE_CLAUDE = path.join(__dirname, 'fake-claude.js');
const FAKE_CLI = path.join(__dirname, 'fake-agent-cli.js');
const NEW_AGENTS = ['opencode', 'copilot', 'amp', 'pi', 'droid'];

function setup(extra = {}) {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'worktree-kanban-more-'));
  const repo = path.join(tmp, 'repo');
  fs.mkdirSync(repo);
  const g = (...a) => execFileSync('git', a, { cwd: repo });
  g('init', '-q', '-b', 'main');
  fs.writeFileSync(path.join(repo, 'README.md'), 'hello\n');
  g('add', '.');
  g('-c', 'user.name=t', '-c', 'user.email=t@t', 'commit', '-qm', 'init');
  const bin = (name, script, pre = '') => {
    const p = path.join(tmp, name);
    fs.writeFileSync(p, `#!/bin/sh\nexec "${process.execPath}" "${script}" ${pre} "$@"\n`, { mode: 0o755 });
    return p;
  };
  const argsLog = path.join(tmp, 'args.log');
  process.env.FAKE_ARGS_LOG = argsLog;
  const store = new Store(path.join(tmp, 'data', 'board.json'));
  Object.assign(store.settings, {
    repoPath: repo,
    claudePath: bin('claude', FAKE_CLAUDE),
    ...Object.fromEntries(NEW_AGENTS.map((a) => [`${a}Path`, bin(a, FAKE_CLI, a)])),
    maxParallel: 3,
    enabledAgents: ['claude', ...NEW_AGENTS],
    specCheck: false,
    ...extra,
  });
  const agents = new AgentManager(store, { mcpScript: path.join(__dirname, '..', 'src', 'permission-mcp.js'), mcpDir: path.join(tmp, 'data', 'mcp'), nodeBin: process.execPath });
  const calls = (kind) => (fs.existsSync(argsLog) ? fs.readFileSync(argsLog, 'utf8').trim().split('\n').map((l) => JSON.parse(l)) : []).filter((x) => x.kind === kind);
  return { tmp, repo, store, agents, calls };
}

function waitFor(pred, ms = 10000) {
  return new Promise((resolve, reject) => {
    const t0 = Date.now();
    const iv = setInterval(() => {
      if (pred()) {
        clearInterval(iv);
        resolve();
      } else if (Date.now() - t0 > ms) {
        clearInterval(iv);
        reject(new Error('timeout'));
      }
    }, 20);
  });
}

const summarize = (x) => JSON.stringify(x);

test('5つのエージェントが一覧にあり、コマンドとモデルの設定の名前が決まっている', () => {
  for (const a of NEW_AGENTS) {
    assert.ok(providers.isAgent(a), a);
    assert.strictEqual(providers.AGENTS[a].pathKey, `${a}Path`);
    assert.strictEqual(providers.AGENTS[a].modelKey, `${a}Model`);
    assert.strictEqual(providers.agentCommand({}, a), a);
    assert.strictEqual(providers.agentCommand({ [`${a}Path`]: ' /x/y ' }, a), '/x/y');
    assert.strictEqual(providers.agentModel({ [`${a}Model`]: ' m1 ' }, a), 'm1');
    assert.strictEqual(providers.rpcKindOf(a, 'default'), null, 'カードでの承認には対応していない');
  }
  assert.deepStrictEqual(NEW_AGENTS.filter(providers.promptViaArg), ['copilot']);
  // 使うエージェントの並びは一覧の順
  assert.deepStrictEqual(providers.cleanEnabledAgents(['droid', 'opencode', 'claude', 'nope']), ['claude', 'opencode', 'droid']);
  const { Store: S } = require('../src/store');
  const st = new S(path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'wk-more-store-')), 'board.json'));
  for (const a of NEW_AGENTS) assert.strictEqual(st.settings[`${a}Path`], a);
});

test('OpenCode の起動の引数', () => {
  assert.deepStrictEqual(providers.buildArgs('opencode', { mode: 'acceptEdits' }), ['run', '--format', 'json']);
  // コマンドは「確認」にする（ヘッドレスでは断られる）。すべて許可なら設定は足さない
  const perm = (mode) => JSON.parse(providers.agentEnv('opencode', mode).OPENCODE_CONFIG_CONTENT).permission;
  assert.deepStrictEqual(perm('acceptEdits'), { bash: 'ask' });
  assert.strictEqual(perm('default').edit, 'ask');
  assert.deepStrictEqual(perm('plan'), { bash: 'ask', edit: 'deny' });
  assert.deepStrictEqual(providers.agentEnv('opencode', 'bypassPermissions'), {});
  for (const a of ['codex', 'copilot', 'amp', 'pi', 'droid']) assert.deepStrictEqual(providers.agentEnv(a, 'acceptEdits'), {});
  assert.deepStrictEqual(providers.buildArgs('opencode', { mode: 'plan', model: 'anthropic/claude-sonnet-4-5', sessionId: 'ses_1' }), ['run', '--format', 'json', '--agent', 'plan', '-m', 'anthropic/claude-sonnet-4-5', '-s', 'ses_1']);
  assert.deepStrictEqual(providers.buildArgs('opencode', { mode: 'bypassPermissions' }), ['run', '--format', 'json', '--auto']);
});

test('Copilot CLI の起動の引数（指示は -p で渡す）', () => {
  assert.deepStrictEqual(providers.buildArgs('copilot', { mode: 'acceptEdits', prompt: 'やって' }), ['--output-format', 'json', '--no-ask-user', '--allow-tool=write', '-p', 'やって']);
  assert.deepStrictEqual(providers.buildArgs('copilot', { mode: 'plan', model: 'gpt-5', sessionId: 's1', prompt: '-x', includeDirs: ['/att'] }), ['--output-format', 'json', '--no-ask-user', '--plan', '--model=gpt-5', '--resume=s1', '--add-dir=/att', '-p', ' -x']);
  assert.deepStrictEqual(providers.buildArgs('copilot', { mode: 'bypassPermissions', prompt: 'p' }).slice(3, 4), ['--allow-all']);
  assert.deepStrictEqual(providers.copilotPolicy('default'), []);
});

test('Amp の起動の引数（続きは threads continue。すべて許可でなければ、止めるツールを書いた設定ファイルで動かす）', () => {
  const edits = providers.buildArgs('amp', { mode: 'acceptEdits' });
  assert.deepStrictEqual(edits.slice(0, 3), ['-x', '--stream-json', '--settings-file']);
  assert.deepStrictEqual(JSON.parse(fs.readFileSync(edits[3], 'utf8'))['amp.tools.disable'], ['Bash'], 'ファイル編集は自動ならコマンドだけ止める');
  assert.deepStrictEqual(providers.buildArgs('amp', { mode: 'bypassPermissions', model: 'high', sessionId: 'T-abc' }), ['threads', 'continue', 'T-abc', '-x', '--stream-json', '--dangerously-allow-all', '--mode', 'high']);
  const plan = providers.buildArgs('amp', { mode: 'plan' });
  assert.strictEqual(plan[2], '--settings-file');
  const cfg = JSON.parse(fs.readFileSync(plan[3], 'utf8'));
  for (const t of ['edit_file', 'create_file', 'Bash']) assert.ok(cfg['amp.tools.disable'].includes(t), t);
});

test('Pi・Droid の起動の引数', () => {
  assert.deepStrictEqual(providers.buildArgs('pi', { mode: 'acceptEdits' }), ['--mode', 'json', '--tools', 'read,edit,write,grep,find,ls']);
  assert.deepStrictEqual(providers.buildArgs('pi', { mode: 'bypassPermissions' }), ['--mode', 'json']);
  assert.deepStrictEqual(providers.buildArgs('pi', { mode: 'plan', model: 'sonnet', sessionId: 'p1' }), ['--mode', 'json', '--tools', 'read,grep,find,ls', '--model', 'sonnet', '--session-id', 'p1']);
  assert.deepStrictEqual(providers.buildArgs('droid', { mode: 'plan' }), ['exec', '-o', 'stream-json']);
  assert.deepStrictEqual(providers.buildArgs('droid', { mode: 'default' }), ['exec', '-o', 'stream-json']);
  assert.deepStrictEqual(providers.buildArgs('droid', { mode: 'acceptEdits', model: 'gpt-5-codex', sessionId: 'd1' }), ['exec', '-o', 'stream-json', '--auto', 'low', '-m', 'gpt-5-codex', '-s', 'd1']);
  assert.deepStrictEqual(providers.buildArgs('droid', { mode: 'bypassPermissions' }), ['exec', '-o', 'stream-json', '--skip-permissions-unsafe']);
});

test('OpenCode の出力を共通の形に直す（終わりの行がないので、終わったところで結果にする）', () => {
  const p = providers.createParser('opencode', { summarize });
  assert.deepStrictEqual(p.onEvent({ type: 'step_start', sessionID: 'ses_1', part: {} }), [{ type: 'session', id: 'ses_1' }]);
  assert.deepStrictEqual(p.onEvent({ type: 'text', sessionID: 'ses_1', part: { type: 'text', text: 'やります' } }), [{ type: 'text', text: 'やります' }]);
  assert.deepStrictEqual(p.onEvent({ type: 'tool_use', sessionID: 'ses_1', part: { tool: 'shell', state: { status: 'completed', input: { command: 'npm test' }, output: 'fail', metadata: { exit: 1 } } } }), [
    { type: 'tool', name: 'Bash', summary: 'npm test' },
    { type: 'tool_result', text: 'fail', error: true },
  ]);
  const todo = p.onEvent({ type: 'tool_use', sessionID: 'ses_1', part: { tool: 'todowrite', state: { status: 'completed', input: { todos: [{ content: 'a', status: 'in_progress' }] }, output: '' } } });
  assert.deepStrictEqual(todo[1], { type: 'todos', items: [{ text: 'a', status: 'in_progress' }] });
  assert.deepStrictEqual(p.flush(), [], 'step_finish がまだなら結果は出さない');
  p.onEvent({ type: 'step_finish', sessionID: 'ses_1', part: {} });
  assert.deepStrictEqual(p.flush(), [{ type: 'result' }]);
  const q = providers.createParser('opencode', { summarize });
  assert.deepStrictEqual(q.onEvent({ type: 'error', sessionID: 's', error: { message: 'bad' } }), [{ type: 'session', id: 's' }, { type: 'log_error', text: 'bad' }]);
  assert.deepStrictEqual(q.flush(), [{ type: 'result', error: 'bad' }]);
});

test('Copilot CLI の出力を共通の形に直す（会話の ID は最後の result から）', () => {
  const p = providers.createParser('copilot', { summarize });
  assert.deepStrictEqual(p.onEvent({ type: 'assistant.message_delta', data: { deltaContent: 'や' } }), []);
  assert.deepStrictEqual(p.onEvent({ type: 'assistant.message', data: { content: 'やります' } }), [{ type: 'text', text: 'やります' }]);
  assert.deepStrictEqual(p.onEvent({ type: 'tool.execution_start', data: { toolCallId: 't', toolName: 'bash', arguments: { command: 'ls' } } }), [{ type: 'tool', name: 'Bash', summary: 'ls' }]);
  assert.deepStrictEqual(p.onEvent({ type: 'tool.execution_complete', data: { toolCallId: 't', success: true, shellExecution: { exitCode: 2 }, result: { content: 'x' } } }), [{ type: 'tool_result', text: 'x', error: true }]);
  assert.deepStrictEqual(p.onEvent({ type: 'tool.execution_complete', data: { toolCallId: 'u', toolName: 'edit', success: false, error: { message: 'denied' } } }), [
    { type: 'tool', name: 'Edit', summary: undefined },
    { type: 'tool_result', text: 'denied', error: true },
  ]);
  assert.deepStrictEqual(p.onEvent({ type: 'result', sessionId: 'abc-1', exitCode: 0 }), [{ type: 'session', id: 'abc-1' }, { type: 'result' }]);
  const q = providers.createParser('copilot', { summarize });
  q.onEvent({ type: 'session.error', data: { message: 'quota' } });
  assert.deepStrictEqual(q.onEvent({ type: 'result', sessionId: 's', exitCode: 1 }), [{ type: 'session', id: 's' }, { type: 'result', error: 'quota' }]);
});

test('Amp の出力を共通の形に直す（Claude Code と同じ形）', () => {
  const p = providers.createParser('amp', { summarize });
  assert.deepStrictEqual(p.onEvent({ type: 'system', subtype: 'init', session_id: 'T-1' }), [{ type: 'session', id: 'T-1', model: undefined }]);
  const a = p.onEvent({ type: 'assistant', session_id: 'T-1', message: { content: [{ type: 'text', text: '見ます' }, { type: 'tool_use', id: 'u', name: 'todo_write', input: { todos: [{ content: 'x', status: 'completed' }] } }] } });
  assert.deepStrictEqual(a, [{ type: 'text', text: '見ます' }, { type: 'tool', name: 'TodoWrite', summary: summarize({ todos: [{ content: 'x', status: 'completed' }] }) }, { type: 'todos', items: [{ text: 'x', status: 'completed' }] }]);
  assert.deepStrictEqual(p.onEvent({ type: 'user', session_id: 'T-1', message: { content: [{ type: 'tool_result', content: [{ type: 'text', text: 'no' }], is_error: true }] } }), [{ type: 'tool_result', text: 'no', error: true }]);
  assert.deepStrictEqual(p.onEvent({ type: 'assistant', session_id: 'T-1', parent_tool_use_id: 'u', message: { content: [{ type: 'text', text: 'sub' }] } }), [], 'サブエージェントの中の動きは出さない');
  assert.deepStrictEqual(p.onEvent({ type: 'result', subtype: 'error_max_turns', is_error: true, error: 'too many' }), [{ type: 'result', error: 'too many' }]);
});

test('Pi の出力を共通の形に直す（exit 0 でも stopReason で失敗が分かる）', () => {
  const p = providers.createParser('pi', { summarize });
  assert.deepStrictEqual(p.onEvent({ type: 'session', id: 'pi-1' }), [{ type: 'session', id: 'pi-1' }]);
  p.onEvent({ type: 'message_update', assistantMessageEvent: { type: 'text_delta', delta: 'a' } });
  p.onEvent({ type: 'message_update', assistantMessageEvent: { type: 'text_delta', delta: 'b' } });
  assert.deepStrictEqual(p.onEvent({ type: 'tool_execution_start', toolName: 'bash', args: { command: 'ls' } }), [{ type: 'text', text: 'ab' }, { type: 'tool', name: 'Bash', summary: 'ls' }]);
  assert.deepStrictEqual(p.onEvent({ type: 'tool_execution_end', toolName: 'bash', result: { content: [{ type: 'text', text: 'out' }] }, isError: false }), [{ type: 'tool_result', text: 'out', error: false }]);
  p.onEvent({ type: 'message_end', message: { role: 'assistant', stopReason: 'error', errorMessage: 'rate limit' } });
  assert.deepStrictEqual(p.onEvent({ type: 'agent_settled', aborted: false }), [{ type: 'result', error: 'rate limit' }]);
  assert.deepStrictEqual(p.flush(), []);
  const ok = providers.createParser('pi', { summarize });
  ok.onEvent({ type: 'message_update', assistantMessageEvent: { type: 'text_delta', delta: 'done' } });
  ok.onEvent({ type: 'message_end', message: { role: 'assistant', stopReason: 'stop' } });
  assert.deepStrictEqual(ok.onEvent({ type: 'agent_settled', aborted: false }), [{ type: 'result' }]);
});

test('Droid の出力を共通の形に直す（completion がなければ最後のエラーで失敗）', () => {
  const p = providers.createParser('droid', { summarize });
  assert.deepStrictEqual(p.onEvent({ type: 'system', subtype: 'init', session_id: 'd-1', model: 'm' }), [{ type: 'session', id: 'd-1', model: 'm' }]);
  assert.deepStrictEqual(p.onEvent({ type: 'message', role: 'user', text: '指示', session_id: 'd-1' }), []);
  assert.deepStrictEqual(p.onEvent({ type: 'message', role: 'assistant', text: 'やります', session_id: 'd-1' }), [{ type: 'text', text: 'やります' }]);
  assert.deepStrictEqual(p.onEvent({ type: 'tool_call', toolName: 'Execute', parameters: { command: 'npm test' }, session_id: 'd-1' }), [{ type: 'tool', name: 'Bash', summary: 'npm test' }]);
  assert.deepStrictEqual(p.onEvent({ type: 'tool_result', isError: true, error: { message: 'x' }, session_id: 'd-1' }), [{ type: 'tool_result', text: 'x', error: true }]);
  p.onEvent({ type: 'error', message: 'insufficient permission', session_id: 'd-1' });
  assert.deepStrictEqual(p.flush(), [{ type: 'result', error: 'insufficient permission' }]);
  const ok = providers.createParser('droid', { summarize });
  assert.deepStrictEqual(ok.onEvent({ type: 'completion', finalText: 'ok', session_id: 'd-2' }), [{ type: 'session', id: 'd-2', model: undefined }, { type: 'result' }]);
  assert.deepStrictEqual(ok.flush(), []);
});

// 本物と同じ形で出す偽の CLI で、タスクとして最後まで動くかを確かめる
const SESSION = {
  opencode: { re: /^ses_fake/, flag: (args, sid) => args[args.indexOf('-s') + 1] === sid },
  copilot: { re: /^copilot-sess-/, flag: (args, sid) => args.includes(`--resume=${sid}`) },
  amp: { re: /^T-fake-/, flag: (args, sid) => args[0] === 'threads' && args[1] === 'continue' && args[2] === sid },
  pi: { re: /^pi-sess-/, flag: (args, sid) => args[args.indexOf('--session-id') + 1] === sid },
  droid: { re: /^droid-sess-/, flag: (args, sid) => args[args.indexOf('-s') + 1] === sid },
};
for (const a of NEW_AGENTS) {
  test(`${providers.agentLabel(a)} のタスク: worktree で動いてコミットし、追加指示は同じ会話の続き`, async () => {
    const { agents, calls } = setup();
    const [c] = agents.createTask({ title: a, prompt: `${a} で作って`, agent: a });
    assert.strictEqual(c.agent, a);
    agents.start(c.id);
    await waitFor(() => c.status === 'review' || c.status === 'failed');
    assert.strictEqual(c.status, 'review', c.error || '');
    assert.match(c.sessionId, SESSION[a].re);
    assert.strictEqual(c.sessions[0].agent, a);
    assert.match(c.lastText, new RegExp(`${a} done`));
    assert.ok(c.logs.some((l) => l.kind === 'text' && l.agent === a && l.text === 'ファイルを作ります'));
    assert.ok(c.logs.some((l) => l.kind === 'result'));
    assert.match(await agents.diff(c.id), new RegExp(`${a} で作って`));
    const sid = c.sessionId;
    agents.send(c.id, 'もう1つ');
    await waitFor(() => c.status === 'review' && calls(a).length === 2);
    assert.ok(SESSION[a].flag(calls(a)[1].args, sid), JSON.stringify(calls(a)[1].args));
    assert.strictEqual(c.sessionId, sid);
  });

  test(`${providers.agentLabel(a)} のタスク: 失敗はエラー列に`, async () => {
    const { agents } = setup();
    const [c] = agents.createTask({ title: a, prompt: `[fail] ${a}`, agent: a });
    agents.start(c.id);
    await waitFor(() => c.status === 'failed');
    assert.strictEqual(c.error, `${a} boom`);
  });
}

test('OpenCode のタスクでは、作業フォルダを PWD でも渡し、権限モードに合わせた設定を環境変数で渡す', async () => {
  const { agents, tmp } = setup();
  // 受け取った PWD を書き出す偽の opencode
  const log = path.join(tmp, 'pwd.log');
  const p = path.join(tmp, 'opencode-pwd');
  fs.writeFileSync(p, `#!/bin/sh\nprintf '%s' "$OPENCODE_CONFIG_CONTENT" > "${log}.cfg"\nprintf '%s' "$PWD" > "${log}"\nexec "${process.execPath}" "${FAKE_CLI}" opencode "$@"\n`, { mode: 0o755 });
  agents.store.settings.opencodePath = p;
  const [c] = agents.createTask({ title: 'oc', prompt: '作って', agent: 'opencode' });
  agents.start(c.id);
  await waitFor(() => c.status === 'review');
  assert.strictEqual(fs.realpathSync(fs.readFileSync(log, 'utf8')), fs.realpathSync(c.worktreePath));
  assert.deepStrictEqual(JSON.parse(fs.readFileSync(`${log}.cfg`, 'utf8')), { permission: { bash: 'ask' } }, '権限モードに合わせた設定も渡す');
});

test('after-merge-build.sh は、新しいエージェントもそれぞれのやり方で動かす', { skip: process.platform === 'win32' }, () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'wk-more-amb-'));
  const sh = fs.readFileSync(path.join(__dirname, '..', 'scripts', 'after-merge-build.sh'), 'utf8');
  const fns = sh.slice(sh.indexOf('# ---- 使うエージェント ----'), sh.indexOf('run_once() {'));
  for (const n of NEW_AGENTS) fs.writeFileSync(path.join(dir, n), '#!/bin/sh\necho "$0 $*"\n', { mode: 0o755 });
  const run = (env) =>
    execFileSync('/bin/bash', ['-c', `set -u\nclaude_bin=claude\n${fns}\npick_agent || { echo none; exit 0; }\nrun_agent "$(skill_line)"`], {
      env: { PATH: `${dir}:/usr/bin:/bin`, ...env },
      encoding: 'utf8',
    });
  assert.match(run({}), /opencode run --auto .*SKILL\.md/);
  assert.match(run({ AFTER_MERGE_AGENT: 'copilot' }), /copilot -p .*SKILL\.md.* --allow-all --no-ask-user/);
  assert.match(run({ AFTER_MERGE_AGENT: 'amp' }), /amp -x .*SKILL\.md.* --dangerously-allow-all/);
  assert.match(run({ AFTER_MERGE_AGENT: 'pi' }), /pi -p .*SKILL\.md/);
  assert.match(run({ AFTER_MERGE_AGENT: 'droid' }), /droid exec --skip-permissions-unsafe .*SKILL\.md/);
});
