// リポジトリで共有する設定（.worktree-kanban/settings.json）
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { execFileSync } = require('child_process');
const StoreLib = require('../src/store');
const { Store, DEFAULT_SETTINGS, SHARED_KEYS, SHARED_SPEC, REPO_SETTING_KEYS, applySharedSettings, noteSharedOverrides, clearSharedOverrides, repoSettingsOf, switchRepoSettings, sharedInfoOf, isSharedScript, isScriptApproved, approveScript, cleanPortStart, cleanPortCount, pickRepoSettings } = StoreLib;
const Shared = require('../src/shared-settings');
const { AgentManager } = require('../src/agent');
const { isProxyChannel } = require('../src/remote');

const FAKE = path.join(__dirname, 'fake-claude.js');
const posixOnly = { skip: process.platform === 'win32' };
const fresh = (over = {}) => ({ ...DEFAULT_SETTINGS, statusMapping: { ...DEFAULT_SETTINGS.statusMapping }, repoSettings: {}, sharedRepos: {}, ...over });
const tmpDir = () => fs.mkdtempSync(path.join(os.tmpdir(), 'worktree-kanban-shared-'));
const writeFile = (repo, obj) => {
  fs.mkdirSync(path.join(repo, Shared.SHARED_DIR), { recursive: true });
  fs.writeFileSync(path.join(repo, Shared.SHARED_DIR, Shared.SHARED_FILE), typeof obj === 'string' ? obj : JSON.stringify(obj));
};

test('共有する項目は、プロジェクトごとの設定のすべて（origin から決める codeHost と前の版の項目を除く）とポート', () => {
  for (const k of ['setupScript', 'teardownScript', 'runScript', 'baseBranch', 'integration', 'relayFlows', 'customAgents', 'competes', 'portStart', 'portCount']) assert.ok(SHARED_KEYS.includes(k), k);
  assert.ok(!SHARED_KEYS.includes('codeHost'));
  assert.ok(!SHARED_KEYS.includes('competeCustomAgents'));
  assert.ok(SHARED_KEYS.every((k) => REPO_SETTING_KEYS.includes(k)));
  assert.strictEqual(Shared.SHARED_REL, '.worktree-kanban/settings.json');
});

test('parseShared: settings の中の、知っている項目で型の合うものだけを使う', () => {
  const r = Shared.parseShared(JSON.stringify({ version: 1, settings: { setupScript: 'npm ci', portCount: 4, specCheck: 'yes', unknown: 1, codeHost: 'gitlab' } }), SHARED_SPEC);
  assert.deepStrictEqual(r.values, { setupScript: 'npm ci', portCount: 4 });
  assert.deepStrictEqual(r.ignored.sort(), ['codeHost', 'specCheck', 'unknown']);
  // settings の段がなければ、上の段をそのまま使う（version は無視）
  const flat = Shared.parseShared('﻿{"version":1,"runScript":"npm run dev"}', SHARED_SPEC);
  assert.deepStrictEqual(flat.values, { runScript: 'npm run dev' });
  assert.deepStrictEqual(flat.ignored, []);
  assert.throws(() => Shared.parseShared('[1]', SHARED_SPEC));
  assert.throws(() => Shared.parseShared('{', SHARED_SPEC));
});

test('readShared / writeShared: ファイルがない・壊れている・書き出して読み戻す', () => {
  const repo = tmpDir();
  assert.deepStrictEqual(Shared.readShared(repo, SHARED_SPEC).exists, false);
  writeFile(repo, '{ broken');
  const bad = Shared.readShared(repo, SHARED_SPEC);
  assert.strictEqual(bad.exists, true);
  assert.ok(bad.error);
  const rs = { ...pickRepoSettings({ setupScript: 'npm ci', portStart: 31000 }), codeHost: 'gitlab' };
  const file = Shared.writeShared(repo, rs, SHARED_KEYS);
  assert.strictEqual(file, path.join(repo, '.worktree-kanban', 'settings.json'));
  const text = fs.readFileSync(file, 'utf8');
  assert.ok(text.endsWith('\n'));
  const doc = JSON.parse(text);
  assert.strictEqual(doc.version, 1);
  assert.strictEqual(doc.settings.setupScript, 'npm ci');
  assert.strictEqual(doc.settings.codeHost, undefined, 'origin から決める項目は書かない');
  const back = Shared.readShared(repo, SHARED_SPEC);
  assert.strictEqual(back.error, '');
  assert.deepStrictEqual(Object.keys(back.values).sort(), [...SHARED_KEYS].sort());
  assert.strictEqual(back.values.portStart, 31000);
});

test('ファイルの値を当てる。今のリポジトリなら今の値も変わり、ほかの項目はそのまま', () => {
  const s = fresh({ repoPath: '/a', permissionMode: 'plan', setupScript: 'old' });
  const changed = applySharedSettings(s, '/a', { exists: true, values: { setupScript: 'npm ci', portCount: 3 } });
  assert.strictEqual(changed, true);
  assert.strictEqual(s.setupScript, 'npm ci');
  assert.strictEqual(s.portCount, 3);
  assert.strictEqual(s.permissionMode, 'plan');
  assert.strictEqual(s.repoSettings['/a'].setupScript, 'npm ci');
  assert.deepStrictEqual(sharedInfoOf(s, '/a').keys.sort(), ['portCount', 'setupScript']);
  // 同じ値なら変わらない
  assert.strictEqual(applySharedSettings(s, '/a', { exists: true, values: { setupScript: 'npm ci', portCount: 3 } }), false);
  // 開いていないリポジトリにも当てられる（今の値は変えない）
  applySharedSettings(s, '/b', { exists: true, values: { setupScript: 'make' } });
  assert.strictEqual(repoSettingsOf(s, '/b').setupScript, 'make');
  assert.strictEqual(s.setupScript, 'npm ci');
  // タブを切り替えても、当てた値のまま
  switchRepoSettings(s, '/b');
  assert.strictEqual(s.setupScript, 'make');
});

test('読めないファイルでは設定を変えない。ファイルを消したら、ファイルの項目の記録も消える（値はそのまま）', () => {
  const s = fresh({ repoPath: '/a' });
  applySharedSettings(s, '/a', { exists: true, values: { runScript: 'npm run dev' } });
  assert.strictEqual(applySharedSettings(s, '/a', { exists: true, values: {}, error: 'Unexpected token' }), false);
  assert.deepStrictEqual(sharedInfoOf(s, '/a').keys, ['runScript']);
  applySharedSettings(s, '/a', { exists: false, values: {} });
  assert.deepStrictEqual(sharedInfoOf(s, '/a').keys, []);
  assert.strictEqual(s.sharedRepos['/a'], undefined);
  assert.strictEqual(s.runScript, 'npm run dev');
});

test('画面で変えた項目は、この PC の上書きになり、ファイルが変わっても上書きのまま。戻すとファイルの値になる', () => {
  const s = fresh({ repoPath: '/a' });
  applySharedSettings(s, '/a', { exists: true, values: { setupScript: 'npm ci', integration: 'merge' } });
  const before = repoSettingsOf(s, '/a');
  s.setupScript = 'pnpm i'; // settings:update と同じく、今の値を書き換える
  s.integration = 'merge'; // 同じ値なら上書きにしない
  const added = noteSharedOverrides(s, '/a', before, repoSettingsOf(s, '/a'));
  assert.deepStrictEqual(added, ['setupScript']);
  assert.deepStrictEqual(sharedInfoOf(s, '/a').overrides, ['setupScript']);
  // ファイルが変わっても、上書きした項目はこの PC の値。ほかはファイルの値
  applySharedSettings(s, '/a', { exists: true, values: { setupScript: 'yarn', integration: 'pr' } });
  assert.strictEqual(s.setupScript, 'pnpm i');
  assert.strictEqual(s.integration, 'pr');
  assert.strictEqual(isSharedScript(s, '/a', 'setup'), false, '上書きしたスクリプトはこの PC のもの');
  clearSharedOverrides(s, '/a', ['setupScript']);
  applySharedSettings(s, '/a', { exists: true, values: { setupScript: 'yarn', integration: 'pr' } });
  assert.strictEqual(s.setupScript, 'yarn');
  assert.deepStrictEqual(sharedInfoOf(s, '/a').overrides, []);
  assert.strictEqual(isSharedScript(s, '/a', 'setup'), true);
  // ファイルから消えた項目の上書きは捨てる
  noteSharedOverrides(s, '/a', repoSettingsOf(s, '/a'), { ...repoSettingsOf(s, '/a'), integration: 'merge' });
  applySharedSettings(s, '/a', { exists: true, values: { setupScript: 'yarn' } });
  assert.deepStrictEqual(sharedInfoOf(s, '/a').overrides, []);
});

test('Pipeline の3つの項目は、いっしょに上書きにする。一覧だけのファイルでも既定のフローがそろう', () => {
  const s = fresh({ repoPath: '/a' });
  const flows = [{ id: 'p1', name: 'Team', flow: { nodes: [{ id: 'start', type: 'start' }, { id: 'end', type: 'end' }], edges: [{ from: 'start', to: 'end' }] } }];
  applySharedSettings(s, '/a', { exists: true, values: { relayFlows: flows, relayFlowId: 'p1' } });
  assert.deepStrictEqual(s.relayFlows.map((p) => p.id), ['p1']);
  assert.strictEqual(s.relayFlowId, 'p1');
  assert.deepStrictEqual(s.relayFlow, s.relayFlows[0].flow);
  const before = repoSettingsOf(s, '/a');
  const added = noteSharedOverrides(s, '/a', before, { ...before, relayFlowId: 'other' });
  assert.deepStrictEqual(added.sort(), ['relayFlowId', 'relayFlows']);
  clearSharedOverrides(s, '/a', ['relayFlows']);
  assert.deepStrictEqual(sharedInfoOf(s, '/a').overrides, []);
});

test('共有ファイルのスクリプトの許可は、中身ごとに覚える', () => {
  const s = fresh({ repoPath: '/a' });
  applySharedSettings(s, '/a', { exists: true, values: { setupScript: 'npm ci' } });
  assert.strictEqual(isSharedScript(s, '/a', 'setup'), true);
  assert.strictEqual(isSharedScript(s, '/a', 'run'), false);
  assert.strictEqual(isScriptApproved(s, '/a', 'setup', 'npm ci'), false);
  approveScript(s, '/a', 'setup', 'npm ci');
  assert.strictEqual(isScriptApproved(s, '/a', 'setup', 'npm ci'), true);
  assert.strictEqual(isScriptApproved(s, '/a', 'setup', 'npm ci && curl evil'), false, '中身が変わったらもう一度確かめる');
  // 許可は board.json に残る（読み込み直しても）
  assert.ok(/^[0-9a-f]{64}$/.test(s.sharedRepos['/a'].approved.setup));
  assert.deepStrictEqual(StoreLib.cleanSharedRepos({ '/a': { keys: ['setupScript', 'nope'], overrides: ['runScript'], approved: { setup: 'x', run: s.sharedRepos['/a'].approved.setup } } }), { '/a': { keys: ['setupScript'], overrides: [], approved: { run: s.sharedRepos['/a'].approved.setup } } });
});

test('ポートの設定: 数は 1〜100、最初の番号は 1024〜（最後の組が 65535 を越えない）', () => {
  assert.strictEqual(cleanPortCount('5'), 5);
  assert.strictEqual(cleanPortCount(0), 1);
  assert.strictEqual(cleanPortCount(1000), 100);
  assert.strictEqual(cleanPortCount('x'), 10);
  assert.strictEqual(cleanPortStart(80), 1024);
  assert.strictEqual(cleanPortStart(70000, 10), 65526);
  assert.strictEqual(cleanPortStart('', 10), 20000);
  assert.deepStrictEqual([DEFAULT_SETTINGS.portStart, DEFAULT_SETTINGS.portCount], [20000, 10]);
  const rs = pickRepoSettings({ portStart: '41000', portCount: '4' });
  assert.deepStrictEqual([rs.portStart, rs.portCount], [41000, 4]);
});

test('遠隔操作からも、ホストのリポジトリの共有設定を扱える', () => {
  for (const ch of ['shared:status', 'shared:save', 'shared:revert', 'shared:approveScripts']) assert.ok(isProxyChannel(ch), ch);
});

test('Store: 読み込み直しても、ファイルの項目・上書き・許可が残る', () => {
  const dir = tmpDir();
  const file = path.join(dir, 'board.json');
  const store = new Store(file);
  store.settings.repoPath = '/a';
  store.applyShared('/a', { exists: true, values: { runScript: 'npm run dev' } });
  store.approveScript('/a', 'run', 'npm run dev');
  store.setRepoSettingsByUser('/a', { runScript: 'npm start' });
  assert.deepStrictEqual(store.sharedInfo('/a').overrides, ['runScript']);
  store.flush();
  const again = new Store(file);
  assert.deepStrictEqual(again.sharedInfo('/a').keys, ['runScript']);
  assert.deepStrictEqual(again.sharedInfo('/a').overrides, ['runScript']);
  assert.strictEqual(again.isScriptApproved('/a', 'run', 'npm run dev'), true);
  assert.strictEqual(again.settings.runScript, 'npm start');
});

// ---------- タスクでの動き ----------

function setup(settings = {}, opts = {}) {
  const tmp = tmpDir();
  const repo = path.join(tmp, 'repo');
  fs.mkdirSync(repo);
  const g = (...a) => execFileSync('git', a, { cwd: repo, encoding: 'utf8' });
  g('init', '-q', '-b', 'main');
  fs.writeFileSync(path.join(repo, 'README.md'), 'hello\n');
  g('add', '.');
  g('-c', 'user.name=t', '-c', 'user.email=t@t', 'commit', '-qm', 'init');
  const fakeBin = path.join(tmp, 'claude');
  fs.writeFileSync(fakeBin, `#!/bin/sh\nexec "${process.execPath}" "${FAKE}" "$@"\n`, { mode: 0o755 });
  const store = new Store(path.join(tmp, 'data', 'board.json'));
  Object.assign(store.settings, { repoPath: repo, claudePath: fakeBin, maxParallel: 1, specCheck: false, permissionMode: 'bypassPermissions', ...settings });
  const agents = new AgentManager(store, { mcpScript: path.join(__dirname, '..', 'src', 'permission-mcp.js'), mcpDir: path.join(tmp, 'data', 'mcp'), nodeBin: process.execPath, ...opts });
  return { tmp, repo, store, agents };
}

async function waitFor(pred, ms = 15000) {
  const t0 = Date.now();
  for (;;) {
    const v = pred();
    if (v) return v;
    if (Date.now() - t0 > ms) throw new Error('timeout');
    await new Promise((r) => setTimeout(r, 20));
  }
}

function startTask(ctx, title = 't') {
  const c = ctx.agents.createCard({ title, prompt: 'hello', repoPath: ctx.repo });
  ctx.agents.start(c.id);
  return ctx.store.card(c.id);
}

test('共有ファイルのセットアップスクリプトは、許可しなければ動かさず、エージェントも始めない', posixOnly, async () => {
  const asked = [];
  const ctx = setup({}, { confirmScript: async (q) => (asked.push(q), false) });
  ctx.store.applyShared(ctx.repo, { exists: true, values: { setupScript: 'touch ran.txt' } });
  const c = startTask(ctx);
  await waitFor(() => c.status === 'failed' || c.status === 'error' || c.error);
  assert.strictEqual(asked.length, 1);
  assert.deepStrictEqual({ kind: asked[0].kind, script: asked[0].script, repoPath: asked[0].repoPath }, { kind: 'setup', script: 'touch ran.txt', repoPath: ctx.repo });
  assert.ok(!fs.existsSync(path.join(c.worktreePath, 'ran.txt')));
  assert.match(JSON.stringify(c.logs) + String(c.error || ''), /settings\.json/);
});

test('許可すると動かして覚え、同じ中身ならもう聞かない。中身が変わったらまた聞く', posixOnly, async () => {
  const asked = [];
  const ctx = setup({ maxParallel: 2 }, { confirmScript: async (q) => (asked.push(q.script), true) });
  ctx.store.applyShared(ctx.repo, { exists: true, values: { setupScript: 'touch ran.txt' } });
  // 同時に始めても、1回だけ聞く
  const a = startTask(ctx, 'a');
  const b = startTask(ctx, 'b');
  await waitFor(() => a.status === 'review' && b.status === 'review', 30000);
  assert.deepStrictEqual(asked, ['touch ran.txt']);
  assert.ok(fs.existsSync(path.join(a.worktreePath, 'ran.txt')));
  assert.strictEqual(ctx.store.isScriptApproved(ctx.repo, 'setup', 'touch ran.txt'), true);
  ctx.store.applyShared(ctx.repo, { exists: true, values: { setupScript: 'touch ran2.txt' } });
  const c = startTask(ctx, 'c');
  await waitFor(() => c.status === 'review', 30000);
  assert.deepStrictEqual(asked, ['touch ran.txt', 'touch ran2.txt']);
});

test('この PC で書いたスクリプトは、確かめずに動かす', posixOnly, async () => {
  let asked = 0;
  const ctx = setup({ setupScript: 'touch local.txt' }, { confirmScript: async () => (++asked, false) });
  const c = startTask(ctx);
  await waitFor(() => c.status === 'review', 30000);
  assert.strictEqual(asked, 0);
  assert.ok(fs.existsSync(path.join(c.worktreePath, 'local.txt')));
});

test('ポートは、プロジェクトの設定の番号から、設定した数ずつ割り当てる', async () => {
  const ctx = setup({ portStart: 42100, portCount: 3 });
  const a = ctx.agents.createCard({ title: 'a', prompt: 'hello', repoPath: ctx.repo });
  const b = ctx.agents.createCard({ title: 'b', prompt: 'hello', repoPath: ctx.repo });
  await ctx.agents.ensureDevPort(a);
  await ctx.agents.ensureDevPort(b);
  assert.ok(a.devPort >= 42100, String(a.devPort));
  assert.strictEqual(a.devPortCount, 3);
  assert.ok(Math.abs(a.devPort - b.devPort) >= 3, `${a.devPort} ${b.devPort}`);
  assert.strictEqual(ctx.agents.portEnv(a).WORKTREE_KANBAN_PORT_COUNT, '3');
});
