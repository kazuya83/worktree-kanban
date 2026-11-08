// 常駐モード（--headless）: 起動の指定・トークンの読み込み・同時起動のロック
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const h = require('../src/headless');
const { SecretStore } = require('../src/secrets');
const trackers = require('../src/trackers');
const { Store } = require('../src/store');

const tmpDir = () => fs.mkdtempSync(path.join(os.tmpdir(), 'wk-headless-'));
const posix = process.platform !== 'win32';

test('--headless か環境変数で常駐モードになる。--remote-host と --secrets-file も読む', () => {
  assert.deepStrictEqual(h.parseHeadlessOptions(['/app/worktree-kanban'], {}), { headless: false, remoteHost: null, secretsFile: '' });
  assert.strictEqual(h.parseHeadlessOptions(['/app/x', '--headless'], {}).headless, true);
  assert.strictEqual(h.parseHeadlessOptions(['/app/x'], { WORKTREE_KANBAN_HEADLESS: '1' }).headless, true);
  assert.strictEqual(h.parseHeadlessOptions(['/app/x'], { WORKTREE_KANBAN_HEADLESS: '0' }).headless, false);
  // argv[0]（exe）は見ない
  assert.strictEqual(h.parseHeadlessOptions(['--headless'], {}).headless, false);
  assert.deepStrictEqual(h.parseHeadlessOptions(['/app/x', '--headless', '--remote-host'], {}).remoteHost, { port: null });
  assert.deepStrictEqual(h.parseHeadlessOptions(['/app/x', '--remote-host=17900'], {}).remoteHost, { port: 17900 });
  assert.deepStrictEqual(h.parseHeadlessOptions(['/app/x', '--remote-host', '17900'], {}).remoteHost, { port: 17900 });
  assert.deepStrictEqual(h.parseHeadlessOptions(['/app/x', '--remote-host', '--no-sandbox'], {}).remoteHost, { port: null }, '次のフラグは値にしない');
  assert.strictEqual(h.parseHeadlessOptions(['/app/x', '--secrets-file=/etc/wk.env'], {}).secretsFile, '/etc/wk.env');
  assert.strictEqual(h.parseHeadlessOptions(['/app/x'], { WORKTREE_KANBAN_SECRETS_FILE: '/srv/wk.env' }).secretsFile, '/srv/wk.env');
});

test('秘密の名前から環境変数の名前を作る', () => {
  assert.strictEqual(h.envNameFor('tracker:slack:botToken'), 'WORKTREE_KANBAN_SLACK_BOT_TOKEN');
  assert.strictEqual(h.envNameFor('tracker:slack:appToken'), 'WORKTREE_KANBAN_SLACK_APP_TOKEN');
  assert.strictEqual(h.envNameFor('tracker:linear:apiKey'), 'WORKTREE_KANBAN_LINEAR_API_KEY');
  assert.strictEqual(h.envNameFor('mobile:namedTunnelToken'), 'WORKTREE_KANBAN_MOBILE_NAMED_TUNNEL_TOKEN');
  // 登録してあるサービスの秘密は、どれも別の名前になる
  const names = trackers.list().flatMap((p) => (p.configFields || []).filter((f) => f.type === 'secret').map((f) => trackers.secretName(p.id, f.name)));
  assert.ok(names.length >= 2);
  const envs = names.map(h.envNameFor);
  assert.strictEqual(new Set(envs).size, envs.length);
  for (const e of envs) assert.match(e, /^WORKTREE_KANBAN_[A-Z0-9_]+$/);
});

test('KEY=VALUE のファイルを読む（# の行・export・引用符）', () => {
  const env = h.parseEnvText(['# コメント', '', 'export WORKTREE_KANBAN_SLACK_BOT_TOKEN="xoxb-1"', "WORKTREE_KANBAN_SLACK_APP_TOKEN='xapp-2'", 'WORKTREE_KANBAN_LINEAR_API_KEY = lin_3 ', 'これは読めない行'].join('\n'));
  assert.deepStrictEqual(env, { WORKTREE_KANBAN_SLACK_BOT_TOKEN: 'xoxb-1', WORKTREE_KANBAN_SLACK_APP_TOKEN: 'xapp-2', WORKTREE_KANBAN_LINEAR_API_KEY: 'lin_3' });
});

test('トークンのファイルは、本人だけが読める（0600）ときだけ読む', { skip: !posix }, () => {
  const dir = tmpDir();
  const file = path.join(dir, 'headless.env');
  assert.strictEqual(h.readSecretsFile(file), null, '無ければ null');
  fs.writeFileSync(file, 'WORKTREE_KANBAN_SLACK_BOT_TOKEN=xoxb-1\n', { mode: 0o644 });
  fs.chmodSync(file, 0o644);
  assert.throws(() => h.readSecretsFile(file), /chmod 600/);
  fs.chmodSync(file, 0o640);
  assert.throws(() => h.readSecretsFile(file), /chmod 600/);
  fs.chmodSync(file, 0o600);
  assert.deepStrictEqual(h.readSecretsFile(file), { WORKTREE_KANBAN_SLACK_BOT_TOKEN: 'xoxb-1' });
  // 持ち主が違う
  assert.throws(() => h.readSecretsFile(file, { uid: process.getuid() + 1 }), /持ち主/);
  // Windows では権限を見ない
  fs.chmodSync(file, 0o644);
  assert.deepStrictEqual(h.readSecretsFile(file, { platform: 'win32' }), { WORKTREE_KANBAN_SLACK_BOT_TOKEN: 'xoxb-1' });
  assert.throws(() => h.readSecretsFile(dir), /ファイルではありません/);
});

test('常駐モードのトークンは 環境変数 → ファイル → 暗号化して保存したもの の順に読み、値はログに出さない', () => {
  const dir = tmpDir();
  const o = h.createSecretOverrides({
    env: { WORKTREE_KANBAN_SLACK_BOT_TOKEN: 'xoxb-env', WORKTREE_KANBAN_PORT: '20030' },
    file: '/x/headless.env',
    readFile: () => ({ WORKTREE_KANBAN_SLACK_BOT_TOKEN: 'xoxb-file', WORKTREE_KANBAN_SLACK_APP_TOKEN: 'xapp-file' }),
  });
  assert.strictEqual(o.get('tracker:slack:botToken'), 'xoxb-env');
  assert.strictEqual(o.source('tracker:slack:botToken'), 'env');
  assert.strictEqual(o.get('tracker:slack:appToken'), 'xapp-file');
  assert.strictEqual(o.source('tracker:slack:appToken'), 'file');
  assert.strictEqual(o.has('tracker:linear:apiKey'), false);
  const found = o.found(['tracker:slack:botToken', 'tracker:slack:appToken', 'tracker:linear:apiKey']);
  assert.strictEqual(found.length, 2);
  assert.ok(found.every((x) => !/xoxb|xapp/.test(x)), '値は出さない');
  assert.ok(!found.join().includes('WORKTREE_KANBAN_PORT'), '秘密でない環境変数は出さない');

  // 暗号化できないマシン（Linux のサーバー）でも、環境変数・ファイルの分は読める
  const s = new SecretStore({ file: path.join(dir, 'secrets.json'), safeStorage: { isEncryptionAvailable: () => false }, overrides: o });
  assert.strictEqual(s.has('tracker:slack:botToken'), true);
  assert.strictEqual(s.get('tracker:slack:botToken'), 'xoxb-env');
  assert.strictEqual(s.get('tracker:linear:apiKey'), '');
  assert.throws(() => s.set('tracker:linear:apiKey', 'lin'), /環境変数か、本人しか読めないトークンのファイル/);
  assert.strictEqual(s.delete('tracker:slack:botToken'), false, '環境変数・ファイルの分は消さない');
  assert.strictEqual(fs.existsSync(path.join(dir, 'secrets.json')), false);
});

test('読んだ秘密の環境変数は、エージェントに引き継がないよう、元の環境変数から消す', () => {
  const env = { WORKTREE_KANBAN_SLACK_BOT_TOKEN: 'xoxb-env', WORKTREE_KANBAN_PORT: '20030', PATH: '/bin' };
  const o = h.createSecretOverrides({ env });
  const removed = h.scrubSecretEnv(env, ['tracker:slack:botToken', 'tracker:slack:appToken']);
  assert.deepStrictEqual(removed, ['WORKTREE_KANBAN_SLACK_BOT_TOKEN']);
  assert.deepStrictEqual(env, { WORKTREE_KANBAN_PORT: '20030', PATH: '/bin' });
  assert.strictEqual(o.get('tracker:slack:botToken'), 'xoxb-env', '消したあとも読める');
});

test('連携は、環境変数のトークンを保存したものと同じように使う', async () => {
  const dir = tmpDir();
  const store = new Store(path.join(dir, 'board.json'));
  const o = h.createSecretOverrides({ env: { WORKTREE_KANBAN_SLACK_BOT_TOKEN: 'xoxb-env', WORKTREE_KANBAN_SLACK_APP_TOKEN: 'xapp-env' } });
  const secrets = new SecretStore({ file: path.join(dir, 'secrets.json'), safeStorage: { isEncryptionAvailable: () => false }, overrides: o });
  const t = new trackers.Trackers({ store, secrets });
  assert.strictEqual(t.hasSecret('slack', 'botToken'), true);
  assert.strictEqual(t.hasSecret('slack', 'appToken'), true);
  // 画面へ渡す一覧には、値ではなく「設定済み」だけが入る
  const listed = JSON.stringify(t.publicList());
  assert.ok(!listed.includes('xoxb-env') && !listed.includes('xapp-env'));
});

test('ロックを持っているのがデスクトップ版か常駐モードかを書き、動いていなければ無いものとする', () => {
  const dir = tmpDir();
  assert.strictEqual(h.readLockInfo(dir), null);
  h.writeLockInfo(dir, { mode: 'headless', version: '1.0.0' });
  const info = h.readLockInfo(dir);
  assert.strictEqual(info.mode, 'headless');
  assert.strictEqual(info.pid, process.pid);
  if (posix) assert.strictEqual(fs.statSync(h.lockInfoFile(dir)).mode & 0o777, 0o600);
  assert.strictEqual(h.readLockInfo(dir, { alive: () => false }), null, 'もう動いていないプロセス');
  // 他のプロセスのものは消さない
  h.clearLockInfo(dir, process.pid + 1);
  assert.ok(fs.existsSync(h.lockInfoFile(dir)));
  h.clearLockInfo(dir);
  assert.strictEqual(fs.existsSync(h.lockInfoFile(dir)), false);
  fs.writeFileSync(h.lockInfoFile(dir), '{"pid":"x","mode":"headless"}');
  assert.strictEqual(h.readLockInfo(dir), null, '壊れている');
});

test('2つ目の起動: デスクトップ版どうしは今までどおり前に出し、常駐モードが絡むときは理由を出して断る', () => {
  assert.deepStrictEqual(h.secondInstancePlan('desktop', null), { action: 'focus' });
  assert.deepStrictEqual(h.secondInstancePlan('desktop', { pid: 5, mode: 'desktop' }), { action: 'focus' });
  const d = h.secondInstancePlan('desktop', { pid: 5, mode: 'headless' });
  assert.strictEqual(d.action, 'refuse');
  assert.match(d.message, /常駐モード.*pid 5/);
  const a = h.secondInstancePlan('headless', { pid: 6, mode: 'desktop' });
  assert.strictEqual(a.action, 'refuse');
  assert.match(a.message, /デスクトップ版.*pid 6/);
  assert.match(h.secondInstancePlan('headless', { pid: 7, mode: 'headless' }).message, /もう動いています/);
  assert.strictEqual(h.secondInstancePlan('headless', null).action, 'refuse');
});

test('通知は1行のログにする', () => {
  const line = h.notificationLine({ title: '承認待ち: 直す', body: 'Bash\n  npm test' }, new Date(2026, 10, 8, 9, 5, 3));
  assert.strictEqual(line, '[2026-11-08 09:05:03] 承認待ち: 直す — Bash npm test');
  assert.strictEqual(h.notificationLine({ title: 'x' }, new Date(2026, 0, 1, 0, 0, 0)), '[2026-01-01 00:00:00] x');
});

test('main.js: 常駐モードではウィンドウ・ダイアログを出さず、ロックと終了を常駐モード向けにする', () => {
  const main = fs.readFileSync(path.join(__dirname, '..', 'main.js'), 'utf8');
  assert.match(main, /requestSingleInstanceLock\(\{ mode: appMode \}\)/);
  assert.match(main, /if \(HEADLESS\) await startHeadless\(\);\n\s+else createWindow\(\);/);
  assert.match(main, /\|\| quittingForUpdate \|\| HEADLESS\)/, '終了の確認を出さない');
  assert.match(main, /overrides: HEADLESS \? headlessSecretOverrides\(userData\) : null/);
  assert.match(main, /appendSwitch\('in-process-gpu'\)/);
  assert.match(main, /headlessLib\.scrubSecretEnv\(process\.env, known\)/);
  // ロックの前に MCP サーバーとしての起動を見分ける（承認の MCP は常駐モードでも使う）
  assert.ok(main.indexOf('isMcpLaunch(process.argv)') < main.indexOf('requestSingleInstanceLock'));
});

test('Linux の tar.gz に、常駐モードの起動スクリプトを入れる', () => {
  const pkg = JSON.parse(fs.readFileSync(path.join(__dirname, '..', 'package.json'), 'utf8'));
  assert.ok(pkg.build.linux.target.some((t) => t.target === 'tar.gz'));
  const extra = pkg.build.linux.extraFiles.find((f) => f.to === 'worktree-kanban-headless');
  const script = path.join(__dirname, '..', extra.from);
  const text = fs.readFileSync(script, 'utf8');
  assert.match(text, /--headless/);
  assert.match(text, /--no-sandbox/);
  if (posix) assert.ok(fs.statSync(script).mode & 0o100, '実行できる');
  for (const f of ['scripts/build-all.sh', 'scripts/after-merge-build.sh', 'scripts/release-local.sh']) {
    assert.match(fs.readFileSync(path.join(__dirname, '..', f), 'utf8'), /tar\.gz/, f);
  }
});
