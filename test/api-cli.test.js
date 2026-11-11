// CLI・MCP から使う API（src/api-server.js）・CLI（src/kanban-cli.js）・MCP（src/api-mcp.js）・wtk の設置（src/cli-shim.js）
const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawn } = require('node:child_process');
const { PassThrough } = require('node:stream');

const { ApiServer, API_CHANNELS, LOCAL_ONLY_CHANNELS, writeDiscovery, clearDiscovery, discoveryFile } = require('../src/api-server');
const { ApiClient, dataDir, readDiscovery, appLaunchCommand, cleanUrl, requestJson } = require('../src/api-client');
const { parseArgs, repoForCwd, run } = require('../src/kanban-cli');
const { handleMessage, serve, TOOLS } = require('../src/api-mcp');
const { createApiOps, taskSummary } = require('../src/api-ops');
const cliShim = require('../src/cli-shim');
const { cliArgsStart, cliRelaunch, RELAUNCH_ENV } = require('../src/launch-mode');

const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), 'wtk-'));

// invoke が受けた呼び出しを記録する、小さなボード
function fakeBoard() {
  const calls = [];
  const tasks = [{ id: 'a1', title: 'First', status: 'review', agent: 'claude', repoPath: '/r', pendingPermissions: 1, pendingQuestions: 0 }];
  const invoke = async (channel, arg, who) => {
    calls.push({ channel, arg, who });
    if (channel === 'api:status') return { currentRepo: '/r', repos: [{ path: '/r', running: 0, review: 1, attention: 1 }] };
    if (channel === 'api:tasks') return tasks;
    if (channel === 'api:task') return { ...tasks[0], prompt: 'do it', permissions: [{ reqId: 'p1', toolName: 'Bash', summary: 'ls' }], questions: [], subtasks: null };
    if (channel === 'api:create') return { ids: ['n1'], tasks: [{ id: 'n1', title: arg.title || 'New', status: arg.start ? 'running' : 'todo', agent: 'claude' }] };
    if (channel === 'board:get') return { settings: { repoPath: '/r', mobileDevices: [{ tokenHash: 'x' }], apiDevices: [{ tokenHash: 'y' }] }, cards: [] };
    if (channel === 'card:discard') return undefined;
    if (channel === 'api:pairCode') return { code: 'ABCD2345', expiresAt: Date.now() + 60000, port: 1 };
    if (channel === 'card:logs') return [{ t: 1, kind: 'text', text: 'hello' }];
    return null;
  };
  return { calls, invoke };
}

async function startServer(o = {}) {
  const board = fakeBoard();
  const server = new ApiServer({ port: 0, invoke: board.invoke, appVersion: '9.9.9', ...o });
  await server.start(0);
  return { server, board, url: `http://127.0.0.1:${server.port}` };
}

test('API: 同じ PC のトークンで呼べる。トークンなし・違うトークンは 401', async () => {
  const { server, board, url } = await startServer({ localToken: 'local-secret' });
  try {
    const st = await requestJson(`${url}/api/v1/invoke`, { method: 'POST', token: 'local-secret', body: { channel: 'api:status' } });
    assert.strictEqual(st.currentRepo, '/r');
    assert.strictEqual(board.calls[0].who.local, true);
    await assert.rejects(requestJson(`${url}/api/v1/invoke`, { method: 'POST', body: { channel: 'api:status' } }), (e) => e.status === 401);
    await assert.rejects(requestJson(`${url}/api/v1/invoke`, { method: 'POST', token: 'nope', body: { channel: 'api:status' } }), (e) => e.status === 401);
    const s = await requestJson(`${url}/api/v1/session`, { token: 'local-secret' });
    assert.strictEqual(s.appVersion, '9.9.9');
    assert.ok(s.channels.includes('api:pairCode'));
  } finally {
    await server.stop();
  }
});

test('API: 決めたチャンネルだけ。設定やターミナルは 403。秘密の設定は返さない', async () => {
  const { server, url } = await startServer({ localToken: 't' });
  try {
    for (const ch of ['settings:update', 'terminal:open', 'repo:choose', 'mobile:pair']) {
      await assert.rejects(requestJson(`${url}/api/v1/invoke`, { method: 'POST', token: 't', body: { channel: ch } }), (e) => e.status === 403, ch);
    }
    const b = await requestJson(`${url}/api/v1/invoke`, { method: 'POST', token: 't', body: { channel: 'board:get' } });
    assert.strictEqual(b.settings.mobileDevices, undefined);
    assert.strictEqual(b.settings.apiDevices, undefined);
    assert.ok(API_CHANNELS.has('card:merge') && API_CHANNELS.has('card:discard') && API_CHANNELS.has('api:create'));
  } finally {
    await server.stop();
  }
});

test('API: Origin の付いた（ブラウザからの）リクエストは断る', async () => {
  const { server } = await startServer({ localToken: 't' });
  try {
    const status = await new Promise((resolve, reject) => {
      const req = require('node:http').request({ host: '127.0.0.1', port: server.port, path: '/api/v1/session', headers: { Authorization: 'Bearer t', Origin: 'https://evil.example' } }, (res) => {
        res.resume();
        resolve(res.statusCode);
      });
      req.on('error', reject);
      req.end();
    });
    assert.strictEqual(status, 403);
  } finally {
    await server.stop();
  }
});

test('API: ペアリングコードでほかの PC のトークンをもらう。コードは 1 回だけ。ほかの PC は端末の管理を使えない', async () => {
  let saved = null;
  const { server, url } = await startServer({ localToken: 't', onDevices: (d) => (saved = d) });
  const dir = tmp();
  try {
    await assert.rejects(new ApiClient({ dir }).login({ url, code: 'WRONG' }), (e) => e.status === 403, 'コードを出す前');
    const { code } = server.refreshPairCode();
    const client = new ApiClient({ dir, env: {} });
    const r = await client.login({ url, code: code.toLowerCase(), name: 'laptop' });
    assert.strictEqual(r.url, url);
    assert.strictEqual(saved.length, 1);
    assert.strictEqual(saved[0].name, 'laptop');
    assert.ok(!JSON.stringify(saved).includes(JSON.parse(fs.readFileSync(path.join(dir, 'cli-login.json'), 'utf8')).token), 'トークンそのものは保存しない');
    if (process.platform !== 'win32') assert.strictEqual(fs.statSync(path.join(dir, 'cli-login.json')).mode & 0o077, 0, '本人だけが読める');
    // 同じコードはもう使えない
    await assert.rejects(new ApiClient({ dir: tmp() }).login({ url, code }), (e) => e.status === 403);
    // 保存したトークンで呼べる（login のほうが同じ PC のアプリより先）
    const s = await new ApiClient({ dir, env: {} }).session();
    assert.strictEqual(s.local, false);
    assert.strictEqual(s.via, 'login');
    assert.ok(!s.channels.some((c) => LOCAL_ONLY_CHANNELS.has(c)));
    await assert.rejects(new ApiClient({ dir, env: {} }).invoke('api:pairCode'), (e) => e.status === 403);
    // logout で端末が消え、手元のトークンも消える
    const out = await new ApiClient({ dir, env: {} }).logout();
    assert.strictEqual(out.removed, true);
    assert.strictEqual(server.status().devices.length, 0);
    assert.ok(!fs.existsSync(path.join(dir, 'cli-login.json')));
  } finally {
    await server.stop();
  }
});

test('API: 間違えたコードを何回も試すと、コードを無効にする', async () => {
  const { server, url } = await startServer({ localToken: 't' });
  try {
    const { code } = server.refreshPairCode();
    for (let i = 0; i < 5; i++) await assert.rejects(requestJson(`${url}/api/v1/pair`, { method: 'POST', body: { code: 'ZZZZZZZZ' } }));
    await assert.rejects(requestJson(`${url}/api/v1/pair`, { method: 'POST', body: { code } }), (e) => e.status === 403);
  } finally {
    await server.stop();
  }
});

test('api.json: 本人だけが読める形で書き、自分が書いたものだけを消す。動いていないプロセスのものは読まない', () => {
  const dir = tmp();
  writeDiscovery(dir, { pid: process.pid, port: 1234, token: 'x' });
  if (process.platform !== 'win32') assert.strictEqual(fs.statSync(discoveryFile(dir)).mode & 0o077, 0);
  assert.strictEqual(readDiscovery(dir).port, 1234);
  assert.strictEqual(readDiscovery(dir, { alive: () => false }), null);
  clearDiscovery(dir, process.pid + 1);
  assert.ok(fs.existsSync(discoveryFile(dir)), 'ほかのプロセスのものは消さない');
  clearDiscovery(dir);
  assert.ok(!fs.existsSync(discoveryFile(dir)));
});

test('クライアント: アプリが動いていなければ常駐モードで起動し、api.json ができるまで待つ', async () => {
  const dir = tmp();
  const spawned = [];
  const spawnImpl = (file, args, opts) => {
    spawned.push({ file, args, opts });
    // 少しあとで、起動したアプリが api.json を書く
    setTimeout(() => writeDiscovery(dir, { pid: process.pid, port: 4321, token: 'tok', mode: 'headless' }), 20);
    return { on() {}, unref() {} };
  };
  const logs = [];
  const client = new ApiClient({ dir, env: { WORKTREE_KANBAN_APP: '/apps/wk', ELECTRON_RUN_AS_NODE: '1' }, spawnImpl, sleep: (ms) => new Promise((r) => setTimeout(r, Math.min(ms, 10))), onLog: (l) => logs.push(l) });
  const t = await client.connect();
  assert.strictEqual(t.url, 'http://127.0.0.1:4321');
  assert.strictEqual(t.token, 'tok');
  assert.strictEqual(spawned.length, 1);
  assert.strictEqual(spawned[0].file, '/apps/wk');
  assert.ok(spawned[0].args.includes('--headless') && spawned[0].args.includes('--api'));
  assert.strictEqual(spawned[0].opts.detached, true);
  assert.strictEqual(spawned[0].opts.env.ELECTRON_RUN_AS_NODE, undefined, 'アプリとして起動する');
  assert.ok(logs[0].includes('headless'));
});

test('クライアント: 同時に起動した別のアプリにロックを取られて終わったら、そちらの起動を待つ', async () => {
  const dir = tmp();
  const spawnImpl = () => {
    const handlers = {};
    setTimeout(() => {
      // 先に起動した別のアプリがロックを持っていて、こちらは断られて終わる
      fs.writeFileSync(path.join(dir, 'instance.json'), JSON.stringify({ pid: process.pid, mode: 'headless' }));
      handlers.exit?.(1);
      setTimeout(() => writeDiscovery(dir, { pid: process.pid, port: 5555, token: 't' }), 30);
    }, 5);
    return { on: (ev, fn) => (handlers[ev] = fn), unref() {} };
  };
  const client = new ApiClient({ dir, env: { WORKTREE_KANBAN_APP: '/x' }, spawnImpl, sleep: (ms) => new Promise((r) => setTimeout(r, Math.min(ms, 10))) });
  assert.strictEqual((await client.connect()).url, 'http://127.0.0.1:5555');
});

test('クライアント: アプリは動いているが API を止めているときは、2つ目を起動せずに知らせる。--no-start なら起動しない', async () => {
  const dir = tmp();
  fs.writeFileSync(path.join(dir, 'instance.json'), JSON.stringify({ pid: process.pid, mode: 'desktop', startedAt: 1 }));
  const spawnImpl = () => assert.fail('起動しない');
  await assert.rejects(new ApiClient({ dir, env: { WORKTREE_KANBAN_APP: '/x' }, spawnImpl }).connect(), (e) => e.code === 'API_OFF');
  // 起動したばかりなら、API ができるのを待つ
  const dir3 = tmp();
  fs.writeFileSync(path.join(dir3, 'instance.json'), JSON.stringify({ pid: process.pid, mode: 'headless', startedAt: Date.now() }));
  setTimeout(() => writeDiscovery(dir3, { pid: process.pid, port: 6666, token: 't' }), 30);
  const c3 = new ApiClient({ dir: dir3, env: {}, spawnImpl, sleep: (ms) => new Promise((r) => setTimeout(r, Math.min(ms, 10))) });
  assert.strictEqual((await c3.connect()).url, 'http://127.0.0.1:6666');
  const dir2 = tmp();
  await assert.rejects(new ApiClient({ dir: dir2, env: { WORKTREE_KANBAN_APP: '/x' }, spawnImpl, autoStart: false }).connect(), (e) => e.code === 'NOT_RUNNING');
});

test('クライアント: --url にはトークンが要る。URL は http:// を補う', async () => {
  await assert.rejects(new ApiClient({ dir: tmp(), env: {}, url: '127.0.0.1:1' }).connect(), /token/);
  assert.strictEqual(cleanUrl('127.0.0.1:47821/'), 'http://127.0.0.1:47821');
  assert.strictEqual(cleanUrl('https://x.example'), 'https://x.example');
});

test('クライアント: データの場所と、起動するアプリのコマンド', () => {
  assert.strictEqual(dataDir({}, 'darwin', '/Users/me'), '/Users/me/Library/Application Support/agent-kanban');
  assert.strictEqual(dataDir({ XDG_CONFIG_HOME: '/c' }, 'linux', '/home/me'), path.join('/c', 'agent-kanban'));
  assert.strictEqual(dataDir({ WORKTREE_KANBAN_DATA_DIR: '/d' }, 'linux', '/home/me'), '/d');
  assert.deepStrictEqual(appLaunchCommand({ WORKTREE_KANBAN_APP: '/e', WORKTREE_KANBAN_APP_ARGS: '["/app"]' }, { platform: 'darwin', versions: {} }), { file: '/e', args: ['/app', '--headless', '--api'] });
  assert.deepStrictEqual(appLaunchCommand({}, { execPath: '/exe', versions: { electron: '1' }, platform: 'linux' }), { file: '/exe', args: ['--headless', '--api', '--no-sandbox'] });
  assert.strictEqual(appLaunchCommand({}, { execPath: '/usr/bin/node', versions: {}, platform: 'linux' }), null, 'ふつうの node では exe が分からない');
});

test('CLI: 引数の読み方', () => {
  assert.deepStrictEqual(parseArgs(['create', 'fix', 'it', '--start', '--repo', '/r', '--title=T']), { pos: ['create', 'fix', 'it'], opts: { start: true, repo: '/r', title: 'T' } });
  assert.deepStrictEqual(parseArgs(['send', 'a1', '--', '--not-a-flag']).pos, ['send', 'a1', '--not-a-flag']);
  assert.throws(() => parseArgs(['tasks', '--repo']), /needs a value/);
});

test('CLI: タスクを作るときは、開いていない git リポジトリの中なら、そのリポジトリにする', async () => {
  const { defaultRepo } = require('../src/kanban-cli');
  const client = { connect: async () => ({ kind: 'local' }), invoke: async () => ({ repos: [{ path: '/work/app' }] }) };
  assert.strictEqual(await defaultRepo(client, {}, { cwd: '/other/proj/src', gitCommonDir: () => '/other/proj/.git' }), '', '一覧などは開いているタブ');
  assert.strictEqual(await defaultRepo(client, {}, { forCreate: true, cwd: '/other/proj/src', gitCommonDir: () => '/other/proj/.git' }), '/other/proj');
  assert.strictEqual(await defaultRepo(client, {}, { forCreate: true, cwd: '/tmp', gitCommonDir: () => '' }), '');
  assert.strictEqual(await defaultRepo(client, { repo: 'sub' }, { cwd: '/base' }), path.resolve('/base', 'sub'));
});

test('CLI: 今のフォルダを含むリポジトリ。worktree の中なら元のリポジトリ', () => {
  const repos = [{ path: '/work/app' }, { path: '/work/app-docs' }];
  assert.strictEqual(repoForCwd(repos, '/work/app/src', () => ''), '/work/app');
  assert.strictEqual(repoForCwd(repos, '/work/app-docs', () => ''), '/work/app-docs');
  assert.strictEqual(repoForCwd(repos, '/work/app.worktrees/abc', () => '/work/app/.git'), '/work/app');
  assert.strictEqual(repoForCwd(repos, '/elsewhere', () => ''), '');
});

// CLI のコマンドを、フェイクのクライアントで動かす
function fakeClient(kind = 'local') {
  const board = fakeBoard();
  return { board, client: { invoke: (ch, arg) => board.invoke(ch, arg, {}), connect: async () => ({ kind }), session: async () => ({ appVersion: '1', mode: 'desktop', url: 'u', via: kind }) } };
}

test('CLI: タスクを作る（既定は Todo、--start で開始）。repo は今のフォルダから決める', async () => {
  const { board, client } = fakeClient();
  const r = await run(client, ['create', 'Fix', 'the', 'bug'], { title: 'T', agent: 'codex' });
  const c = board.calls.find((x) => x.channel === 'api:create');
  assert.strictEqual(c.arg.prompt, 'Fix the bug');
  assert.strictEqual(c.arg.start, false);
  assert.strictEqual(c.arg.agent, 'codex');
  assert.match(r.text, /n1/);
  await run(client, ['create', '-'], { start: true }, { readStdin: () => 'from stdin' });
  const c2 = board.calls.filter((x) => x.channel === 'api:create')[1];
  assert.strictEqual(c2.arg.prompt, 'from stdin');
  assert.strictEqual(c2.arg.start, true);
  await run(client, ['run-pipeline', 'Review', 'check', 'it'], {});
  const c3 = board.calls.filter((x) => x.channel === 'api:create')[2];
  assert.strictEqual(c3.arg.pipeline, 'Review');
  assert.strictEqual(c3.arg.start, true);
  assert.strictEqual(c3.arg.permissionMode, undefined, '指定がなければプロジェクトの設定');
  await run(client, ['create', 'go'], { bypass: true });
  assert.strictEqual(board.calls.filter((x) => x.channel === 'api:create')[3].arg.permissionMode, 'bypassPermissions');
  await run(client, ['create', 'go'], { 'permission-mode': 'plan' });
  assert.strictEqual(board.calls.filter((x) => x.channel === 'api:create')[4].arg.permissionMode, 'plan');
});

test('CLI: 承認は reqId を省くといちばん古いもの。削除は --yes が要る', async () => {
  const { board, client } = fakeClient();
  await run(client, ['approve', 'a1'], { always: true });
  const p = board.calls.find((x) => x.channel === 'card:permission');
  assert.deepStrictEqual(p.arg, { id: 'a1', reqId: 'p1', decision: 'always', message: undefined });
  await assert.rejects(run(client, ['delete', 'a1'], {}), /--yes/);
  assert.ok(!board.calls.some((x) => x.channel === 'card:discard'));
  await run(client, ['delete', 'a1'], { yes: true });
  assert.ok(board.calls.some((x) => x.channel === 'card:discard' && x.arg === 'a1'));
  await assert.rejects(run(client, ['move', 'a1', 'nowhere'], {}), /Usage/);
  await assert.rejects(run(client, ['frobnicate'], {}), /Unknown command/);
});

test('CLI: 一覧と、ほかの PC のアプリでは今のフォルダを見ない', async () => {
  const { board, client } = fakeClient('login');
  const r = await run(client, ['tasks'], {});
  assert.match(r.text, /a1 +review/);
  assert.match(r.text, /1 approval/);
  assert.strictEqual(board.calls.find((x) => x.channel === 'api:tasks').arg.repo, '');
  const logs = await run(client, ['logs', 'a1'], {});
  assert.match(logs.text, /text: hello/);
});

test('MCP: initialize・tools/list・tools/call。エラーは isError で返す', async () => {
  const { board, client } = fakeClient();
  const init = await handleMessage(client, { jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: '2025-06-18' } }, { version: '1.2.3' });
  assert.strictEqual(init.result.serverInfo.version, '1.2.3');
  assert.ok(init.result.capabilities.tools);
  assert.strictEqual(await handleMessage(client, { jsonrpc: '2.0', method: 'notifications/initialized' }), null);
  const list = await handleMessage(client, { jsonrpc: '2.0', id: 2, method: 'tools/list' });
  const names = list.result.tools.map((t) => t.name);
  for (const n of ['list_tasks', 'get_task', 'create_task', 'start_task', 'answer_approval', 'merge_task', 'create_pr', 'delete_task', 'list_pipelines', 'run_pipeline']) assert.ok(names.includes(n), n);
  for (const t of TOOLS) assert.strictEqual(t.inputSchema.type, 'object', t.name);
  const created = await handleMessage(client, { jsonrpc: '2.0', id: 3, method: 'tools/call', params: { name: 'create_task', arguments: { prompt: 'do', start: true } } });
  assert.ok(!created.result.isError);
  assert.match(created.result.content[0].text, /n1/);
  assert.strictEqual(board.calls.find((x) => x.channel === 'api:create').arg.start, true);
  await handleMessage(client, { jsonrpc: '2.0', id: 31, method: 'tools/call', params: { name: 'create_task', arguments: { prompt: 'do', permission_mode: 'bypassPermissions' } } });
  assert.strictEqual(board.calls.filter((x) => x.channel === 'api:create').at(-1).arg.permissionMode, 'bypassPermissions');
  const del = await handleMessage(client, { jsonrpc: '2.0', id: 4, method: 'tools/call', params: { name: 'delete_task', arguments: { id: 'a1' } } });
  assert.strictEqual(del.result.isError, true, 'confirm が無ければ消さない');
  assert.ok(!board.calls.some((x) => x.channel === 'card:discard'));
  const unknown = await handleMessage(client, { jsonrpc: '2.0', id: 5, method: 'nope' });
  assert.strictEqual(unknown.error.code, -32601);
});

test('MCP: stdio で 1 行 1 メッセージ。stdin が閉じたら終わる', async () => {
  const { client } = fakeClient();
  const stdin = new PassThrough();
  const stdout = new PassThrough();
  let text = '';
  stdout.on('data', (c) => (text += c));
  const done = serve({ client, stdin, stdout, version: '1' });
  stdin.write(`${JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name: 'list_repos', arguments: {} } })}\n`);
  stdin.write('not json\n');
  stdin.end();
  await done;
  const lines = text.trim().split('\n').map((l) => JSON.parse(l));
  assert.strictEqual(lines.length, 2);
  assert.ok(lines.some((m) => m.id === 1 && /\/r/.test(m.result.content[0].text)));
  assert.ok(lines.some((m) => m.error && m.error.code === -32700));
});

test('api-ops: リポジトリを指定して読む・作る。画面のタブは切り替えない', async () => {
  const cards = [
    { id: 'c1', title: 'A', status: 'review', repoPath: '/r1', permissions: [{ id: 'p', toolName: 'Bash' }], prompt: 'x' },
    { id: 'c2', title: 'B', status: 'todo', repoPath: '/r2', prompt: 'y' },
  ];
  const created = [];
  const started = [];
  const store = {
    settings: { repoPath: '/r1', repoTabs: ['/r1', '/r2'] },
    cards,
    card: (id) => cards.find((c) => c.id === id),
    repoSettings: () => ({ relayFlows: [{ id: 'p1', name: 'Review', flow: { nodes: [1, 2] } }], relayFlowId: 'p1' }),
  };
  const agents = {
    publicCards: (repo) => cards.filter((c) => !repo || c.repoPath === repo),
    createTask: (o) => {
      created.push(o);
      const c = { id: 'n', title: o.title || 'n', status: 'todo', repoPath: o.repoPath };
      cards.push(c);
      return [c];
    },
    start: (id) => started.push(id),
  };
  const added = [];
  const ops = createApiOps({ store, agents, addRepo: async (d) => (added.push(d), `${d}-top`) });
  assert.deepStrictEqual(ops.tasks({}).map((t) => t.id), ['c1']);
  assert.deepStrictEqual(ops.tasks({ repo: '/r2/' }).map((t) => t.id), ['c2']);
  assert.deepStrictEqual(ops.tasks({ all: true, status: 'todo' }).map((t) => t.id), ['c2']);
  assert.throws(() => ops.tasks({ status: 'bogus' }), /bogus/);
  assert.strictEqual(ops.tasks({})[0].pendingPermissions, 1);
  assert.strictEqual(ops.task({ id: 'c1' }).permissions[0].reqId, 'p');
  assert.throws(() => ops.task({ id: 'zz' }));
  const r = await ops.create({ repo: '/r2', prompt: 'go', pipeline: 'review', start: true, permissionMode: 'bypassPermissions' });
  assert.strictEqual(created[0].permissionMode, 'bypassPermissions', '権限モードを渡す');
  assert.strictEqual(created[0].repoPath, '/r2');
  assert.strictEqual(created[0].agent, 'relay:p1', '名前（大文字小文字は問わない）で Pipeline を選ぶ');
  assert.deepStrictEqual(started, ['n']);
  assert.deepStrictEqual(r.ids, ['n']);
  await assert.rejects(ops.create({ prompt: 'go', pipeline: 'missing' }), /missing/);
  await assert.rejects(ops.create({ prompt: ' ' }));
  assert.deepStrictEqual(added, [], '開いているリポジトリはそのまま');
  await ops.create({ repo: '/new/repo', prompt: 'go' });
  assert.deepStrictEqual(added, ['/new/repo'], 'まだ開いていないリポジトリはタブに足す');
  assert.strictEqual(created.at(-1).repoPath, '/new/repo-top');
  assert.strictEqual(store.settings.repoPath, '/r1', 'タブはそのまま');
  assert.deepStrictEqual(ops.pipelines({}), [{ id: 'p1', name: 'Review', default: true, steps: 2 }]);
  assert.strictEqual(taskSummary({ id: 'x', status: 'todo' }).kind, 'task');
});

test('wtk: macOS・Linux はアプリの exe を Node として動かす sh、AppImage は --kanban-cli、Windows は .cmd', () => {
  const mac = cliShim.shimPlan({ platform: 'darwin', home: '/Users/me', execPath: "/Applications/Worktree Kanban.app/Contents/MacOS/Worktree Kanban", script: '/A/app.asar.unpacked/src/kanban-cli.js', dataDir: "/Users/me/it's" });
  assert.strictEqual(mac.file, '/Users/me/.local/bin/wtk');
  assert.match(mac.content, /^#!\/bin\/sh/);
  assert.match(mac.content, /ELECTRON_RUN_AS_NODE=1/);
  assert.match(mac.content, /exec '\/Applications\/Worktree Kanban.app\/Contents\/MacOS\/Worktree Kanban' '\/A\/app.asar.unpacked\/src\/kanban-cli.js' "\$@"/);
  assert.match(mac.content, /'\/Users\/me\/it'\\''s'/, '引用符をエスケープする');
  assert.strictEqual(mac.mcp.mcpServers['worktree-kanban'].env.ELECTRON_RUN_AS_NODE, '1');
  assert.deepStrictEqual(mac.mcp.mcpServers['worktree-kanban'].args, ['/A/app.asar.unpacked/src/kanban-cli.js', 'mcp']);
  assert.match(mac.claudeAdd, /^claude mcp add-json worktree-kanban '/);
  const img = cliShim.shimPlan({ platform: 'linux', home: '/home/me', execPath: '/tmp/.mount_x/wk', appImage: '/home/me/.local/bin/worktree-kanban', script: '/tmp/.mount_x/s.js', dataDir: '/home/me/.config/agent-kanban' });
  assert.match(img.content, /exec '\/home\/me\/.local\/bin\/worktree-kanban' --kanban-cli "\$@"/);
  assert.ok(!img.content.includes('.mount_x'), 'AppImage の中の場所は書かない');
  const win = cliShim.shimPlan({ platform: 'win32', home: 'C:\\Users\\me', execPath: 'C:\\P\\Worktree Kanban.exe', script: 'C:\\P\\resources\\app.asar.unpacked\\src\\kanban-cli.js', dataDir: 'C:\\Users\\me\\AppData\\Roaming\\agent-kanban' });
  assert.strictEqual(win.file, 'C:\\Users\\me\\.local\\bin\\wtk.cmd');
  assert.match(win.content, /setlocal\r\nset "ELECTRON_RUN_AS_NODE=1"/);
  assert.match(win.content, /"C:\\P\\Worktree Kanban.exe" "C:\\P\\resources\\app.asar.unpacked\\src\\kanban-cli.js" %\*/);
});

test('wtk: 置く・古ければ書き直す・自分のものでないファイルは上書きしない', () => {
  const home = tmp();
  const plan = cliShim.shimPlan({ platform: 'linux', home, execPath: '/e1', script: '/s.js', dataDir: '/d' });
  assert.deepStrictEqual(cliShim.shimState(plan), { installed: false, current: false, ours: false });
  assert.strictEqual(cliShim.refreshShim(plan), false, '置いていなければ置かない');
  cliShim.installShim(plan);
  assert.deepStrictEqual(cliShim.shimState(plan), { installed: true, current: true, ours: true });
  if (process.platform !== 'win32') assert.ok(fs.statSync(plan.file).mode & 0o100, '実行できる');
  const moved = cliShim.shimPlan({ platform: 'linux', home, execPath: '/e2', script: '/s.js', dataDir: '/d' });
  assert.strictEqual(cliShim.refreshShim(moved), true);
  assert.match(fs.readFileSync(plan.file, 'utf8'), /'\/e2'/);
  fs.writeFileSync(plan.file, '#!/bin/sh\necho other\n');
  assert.throws(() => cliShim.installShim(moved), /not written by Worktree Kanban/);
  assert.strictEqual(cliShim.refreshShim(moved), false);
  assert.strictEqual(cliShim.onPath('/a/b', '/x:/a/b/:/y', 'linux'), true);
  assert.strictEqual(cliShim.onPath('C:\\A', 'c:\\a;D:\\', 'win32'), true);
});

test('launch-mode: --kanban-cli か kanban-cli.js で起動されたら、Node として CLI を起動し直す', () => {
  assert.strictEqual(cliArgsStart(['/app/wk', '--kanban-cli', 'tasks']), 2);
  assert.strictEqual(cliArgsStart(['C:\\P\\wk.exe', 'C:\\P\\resources\\app.asar.unpacked\\src\\KANBAN-CLI.JS', 'tasks']), 2);
  assert.strictEqual(cliArgsStart(['/app/wk', '--headless']), -1);
  assert.strictEqual(cliArgsStart(['/x/kanban-cli.js']), -1, 'exe 自体の名前は見ない');
  const re = cliRelaunch('/app/wk', ['/app/wk', '--some-chromium-flag', '--kanban-cli', 'mcp'], { PATH: 'p' }, '/s/kanban-cli.js', { WORKTREE_KANBAN_APP: '/img' });
  assert.deepStrictEqual(re.args, ['/s/kanban-cli.js', 'mcp']);
  assert.strictEqual(re.env.ELECTRON_RUN_AS_NODE, '1');
  assert.strictEqual(re.env.WORKTREE_KANBAN_APP, '/img');
  assert.strictEqual(re.env.PATH, 'p');
  assert.strictEqual(cliRelaunch('/app/wk', ['/app/wk', '--kanban-cli'], re.env, '/s'), null, '起動し直した子はその場で動く');
  assert.ok(RELAUNCH_ENV);
});

test('CLI と MCP を本物のプロセスで動かし、同じ PC のアプリ（api.json）につなぐ', async () => {
  const { server, board } = await startServer({ localToken: 'tok' });
  const dir = tmp();
  writeDiscovery(dir, server.discoveryInfo());
  const script = path.join(__dirname, '..', 'src', 'kanban-cli.js');
  const runCli = (args, input) =>
    new Promise((resolve, reject) => {
      const child = spawn(process.execPath, [script, ...args], { env: { ...process.env, WORKTREE_KANBAN_DATA_DIR: dir, WORKTREE_KANBAN_URL: '', WORKTREE_KANBAN_TOKEN: '' }, cwd: os.tmpdir() });
      let out = '';
      let err = '';
      child.stdout.on('data', (c) => (out += c));
      child.stderr.on('data', (c) => (err += c));
      child.on('error', reject);
      child.on('close', (code) => resolve({ code, out, err }));
      if (input) child.stdin.end(input);
      else child.stdin.end();
    });
  try {
    const st = await runCli(['status']);
    assert.strictEqual(st.code, 0, st.err);
    assert.match(st.out, /Worktree Kanban 9\.9\.9/);
    const json = await runCli(['tasks', '--json', '--repo', '/r']);
    assert.strictEqual(JSON.parse(json.out)[0].id, 'a1');
    const bad = await runCli(['delete', 'a1']);
    assert.strictEqual(bad.code, 1);
    assert.match(bad.err, /--yes/);
    const help = await runCli(['--help']);
    assert.match(help.out, /Usage: wtk/);
    const mcp = await runCli(['mcp'], `${JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name: 'get_task', arguments: { id: 'a1' } } })}\n`);
    assert.strictEqual(mcp.code, 0, mcp.err);
    const msg = JSON.parse(mcp.out.trim());
    assert.match(msg.result.content[0].text, /"reqId": "p1"/);
    assert.ok(board.calls.every((c) => c.who.local));
  } finally {
    await server.stop();
  }
});
