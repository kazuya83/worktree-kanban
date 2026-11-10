// cloudflared で 127.0.0.1 のポートを外の HTTPS の URL につなぐ（src/cloudflare-tunnel.js）
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const I18n = require('../renderer/i18n');
const { CloudflareTunnel, findCloudflared, installHint, parseQuickUrl, normalizeHostname, redact, DOWNLOAD_URL } = require('../src/cloudflare-tunnel');

const FAKE = path.join(__dirname, 'fake-cloudflared.js');
const TOKEN = 'eyJhIjoiMTIzNDU2Nzg5MCIsInQiOiJhYmNkZWYiLCJzIjoic2VjcmV0LXNlY3JldCJ9';

function tmpDir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'ak-cf-'));
}

function readLog(file) {
  if (!fs.existsSync(file)) return [];
  return fs.readFileSync(file, 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l));
}

// node で偽の cloudflared を動かす（Windows でも node.exe なのでそのまま起動できる）
function fakeTunnel(env, opts = {}) {
  const base = { ...process.env };
  delete base.TUNNEL_TOKEN;
  return new CloudflareTunnel({
    command: process.execPath,
    prefixArgs: [FAKE],
    mode: 'quick',
    localPort: 17831,
    urlTimeoutMs: 5000,
    minBackoffMs: 50,
    maxBackoffMs: 400,
    env: { ...base, ...env },
    ...opts,
  });
}

function waitFor(cond, ms = 5000) {
  return new Promise((resolve, reject) => {
    const started = Date.now();
    const tick = () => {
      if (cond()) return resolve();
      if (Date.now() - started > ms) return reject(new Error('timeout'));
      setTimeout(tick, 20);
    };
    tick();
  });
}

const alive = (pid) => {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
};

test('trycloudflare の URL を読み取る（api.trycloudflare.com は除く）', () => {
  assert.strictEqual(parseQuickUrl('INF Requesting new quick Tunnel on https://api.trycloudflare.com...'), null);
  assert.strictEqual(parseQuickUrl('ERR Post "https://api.trycloudflare.com/tunnel" x\nINF |  https://shy-cat-blue.trycloudflare.com  |'), 'https://shy-cat-blue.trycloudflare.com');
  assert.strictEqual(parseQuickUrl('https://Abc-1.TryCloudflare.com/'), 'https://abc-1.trycloudflare.com');
  assert.strictEqual(parseQuickUrl('http://x.trycloudflare.com'), null);
  assert.strictEqual(parseQuickUrl('https://x.trycloudflare.com.evil.example'), 'https://x.trycloudflare.com');
  assert.strictEqual(parseQuickUrl(''), null);
});

test('named のホスト名: https:// を付け、末尾の / を外す', () => {
  assert.strictEqual(normalizeHostname('kanban.example.com'), 'https://kanban.example.com');
  assert.strictEqual(normalizeHostname(' https://kanban.example.com/ '), 'https://kanban.example.com');
  assert.strictEqual(normalizeHostname('kanban.example.com//'), 'https://kanban.example.com');
  assert.strictEqual(normalizeHostname(''), '');
});

test('トークンを伏せる', () => {
  assert.strictEqual(redact(`token ${TOKEN} end`, TOKEN), 'token *** end');
  assert.doesNotMatch(redact(`x ${TOKEN}`, ''), /eyJ/, 'トークンを知らなくても、それらしい文字列は伏せる');
  assert.strictEqual(redact('--token abc123 run', ''), '--token *** run');
});

test('findCloudflared: 設定のパス → PATH → よくある場所の順に探す', () => {
  const mac = { platform: 'darwin', env: { PATH: '/usr/bin:/custom/bin' } };
  const has = (...files) => (p) => files.includes(p);
  // 設定のパスがあれば最優先
  assert.strictEqual(findCloudflared('/opt/cf/cloudflared', { ...mac, exists: has('/opt/cf/cloudflared', '/custom/bin/cloudflared', '/opt/homebrew/bin/cloudflared') }), '/opt/cf/cloudflared');
  // 設定のパスが無ければ PATH
  assert.strictEqual(findCloudflared('/nope/cloudflared', { ...mac, exists: has('/custom/bin/cloudflared', '/opt/homebrew/bin/cloudflared') }), '/custom/bin/cloudflared');
  // PATH に無ければよくある場所（mac は /opt/homebrew/bin が先）
  assert.strictEqual(findCloudflared('', { ...mac, exists: has('/opt/homebrew/bin/cloudflared', '/usr/local/bin/cloudflared') }), '/opt/homebrew/bin/cloudflared');
  assert.strictEqual(findCloudflared('', { ...mac, exists: has('/usr/local/bin/cloudflared') }), '/usr/local/bin/cloudflared');
  // 設定がコマンド名だけなら PATH から探す
  assert.strictEqual(findCloudflared('cf2', { ...mac, exists: has('/custom/bin/cf2', '/custom/bin/cloudflared') }), '/custom/bin/cf2');
  assert.strictEqual(findCloudflared('', { ...mac, exists: () => false }), null);
  // Linux
  const linux = { platform: 'linux', env: { PATH: '' } };
  assert.strictEqual(findCloudflared('', { ...linux, exists: has('/usr/bin/cloudflared', '/usr/local/bin/cloudflared') }), '/usr/bin/cloudflared');
  assert.strictEqual(findCloudflared('', { ...linux, exists: has('/usr/local/bin/cloudflared') }), '/usr/local/bin/cloudflared');
  assert.strictEqual(findCloudflared(null, { ...linux, exists: has('/opt/homebrew/bin/cloudflared') }), null, 'Linux では mac の場所を見ない');
});

test('findCloudflared: Windows は .exe を補い、Program Files と WinGet の Links を見る', () => {
  const env = { Path: 'C:\\Windows;C:\\tools', ProgramFiles: 'C:\\Program Files', 'ProgramFiles(x86)': 'C:\\Program Files (x86)', LOCALAPPDATA: 'C:\\Users\\k\\AppData\\Local' };
  const win = { platform: 'win32', env };
  const has = (...files) => (p) => files.includes(p);
  assert.strictEqual(findCloudflared('D:\\bin\\cloudflared', { ...win, exists: has('D:\\bin\\cloudflared.exe') }), 'D:\\bin\\cloudflared.exe');
  assert.strictEqual(findCloudflared('"D:\\bin\\cloudflared.exe"', { ...win, exists: has('D:\\bin\\cloudflared.exe') }), 'D:\\bin\\cloudflared.exe');
  assert.strictEqual(findCloudflared('', { ...win, exists: has('C:\\tools\\cloudflared.exe', 'C:\\Program Files\\cloudflared\\cloudflared.exe') }), 'C:\\tools\\cloudflared.exe');
  const order = ['C:\\Program Files\\cloudflared\\cloudflared.exe', 'C:\\Program Files (x86)\\cloudflared\\cloudflared.exe', 'C:\\Users\\k\\AppData\\Local\\Microsoft\\WinGet\\Links\\cloudflared.exe'];
  assert.strictEqual(findCloudflared('', { ...win, exists: has(...order) }), order[0]);
  assert.strictEqual(findCloudflared('', { ...win, exists: has(order[1], order[2]) }), order[1]);
  assert.strictEqual(findCloudflared('', { ...win, exists: has(order[2]) }), order[2]);
  const seen = [];
  findCloudflared('', { ...win, exists: (p) => (seen.push(p), false) });
  assert.ok(seen.indexOf('C:\\tools\\cloudflared.exe') < seen.indexOf(order[0]), 'PATH が先');
});

test('installHint: OS ごとの入れ方と公式の案内ページ', () => {
  assert.strictEqual(installHint('darwin').command, 'brew install cloudflared');
  assert.strictEqual(installHint('win32').command, 'winget install --id Cloudflare.cloudflared');
  assert.strictEqual(installHint('linux').command, '');
  assert.match(installHint('linux').note, /公式パッケージ/);
  for (const p of ['darwin', 'win32', 'linux']) assert.strictEqual(installHint(p).url, 'https://developers.cloudflare.com/cloudflare-one/connections/connect-networks/downloads/');
  assert.strictEqual(DOWNLOAD_URL, installHint('darwin').url);
});

test('quick: 出力から URL を読み取って running にし、url と status を出す', async () => {
  const dir = tmpDir();
  const log = path.join(dir, 'log');
  const t = fakeTunnel({ FAKE_CF_SUB: 'happy-day', FAKE_CF_LOG: log });
  const states = [];
  const urls = [];
  t.on('status', (s) => states.push(s.state));
  t.on('url', (u) => urls.push(u));
  try {
    const s = await t.start();
    assert.deepStrictEqual(s, { state: 'running', url: 'https://happy-day.trycloudflare.com', mode: 'quick', error: null });
    assert.deepStrictEqual(urls, ['https://happy-day.trycloudflare.com']);
    assert.deepStrictEqual(states, ['starting', 'running']);
    const [run] = readLog(log);
    assert.deepStrictEqual(run.args, ['tunnel', '--no-autoupdate', '--url', 'http://127.0.0.1:17831']);
    assert.strictEqual(run.hasToken, false, 'quick にはトークンを渡さない');
  } finally {
    await t.stop();
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('quick: 手元の環境変数に TUNNEL_TOKEN があっても渡さない', async () => {
  const dir = tmpDir();
  const log = path.join(dir, 'log');
  const t = fakeTunnel({ FAKE_CF_LOG: log, TUNNEL_TOKEN: TOKEN });
  try {
    await t.start();
    assert.strictEqual(readLog(log)[0].hasToken, false);
  } finally {
    await t.stop();
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('named: トークンは TUNNEL_TOKEN で渡し、引数には入れない。つながった印で running', async () => {
  const dir = tmpDir();
  const log = path.join(dir, 'log');
  const t = fakeTunnel({ FAKE_CF_MODE: 'named', FAKE_CF_LOG: log }, { mode: 'named', namedToken: TOKEN, namedHostname: 'kanban.example.com/' });
  const urls = [];
  t.on('url', (u) => urls.push(u));
  try {
    const s = await t.start();
    assert.deepStrictEqual(s, { state: 'running', url: 'https://kanban.example.com', mode: 'named', error: null });
    assert.deepStrictEqual(urls, ['https://kanban.example.com']);
    const [run] = readLog(log);
    assert.deepStrictEqual(run.args, ['tunnel', '--no-autoupdate', 'run']);
    assert.ok(!run.args.join(' ').includes(TOKEN));
    assert.strictEqual(run.hasToken, true);
    assert.strictEqual(run.tokenLength, TOKEN.length);
  } finally {
    await t.stop();
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('named: トークンかホスト名が無ければ起動しない', async () => {
  const noToken = fakeTunnel({}, { mode: 'named', namedHostname: 'a.example.com' });
  await assert.rejects(noToken.start(), /トークン/);
  assert.strictEqual(noToken.status().state, 'error');
  const noHost = fakeTunnel({}, { mode: 'named', namedToken: TOKEN });
  await assert.rejects(noHost.start(), /ホスト名/);
  const noPort = fakeTunnel({}, { localPort: 0 });
  await assert.rejects(noPort.start(), /ポート/);
});

test('落ちたら起動し直し、quick で URL が変わったら url を出し直す', async () => {
  const dir = tmpDir();
  const log = path.join(dir, 'log');
  const t = fakeTunnel({ FAKE_CF_SUB: 'turn', FAKE_CF_SEQ: path.join(dir, 'seq'), FAKE_CF_EXIT_AFTER: '150', FAKE_CF_LOG: log });
  const urls = [];
  const states = [];
  t.on('url', (u) => urls.push(u));
  t.on('status', (s) => states.push(s.state));
  try {
    await t.start();
    await waitFor(() => urls.length >= 3);
    assert.deepStrictEqual(urls.slice(0, 3), ['https://turn-1.trycloudflare.com', 'https://turn-2.trycloudflare.com', 'https://turn-3.trycloudflare.com']);
    assert.ok(states.includes('error'), '落ちたら error を知らせる');
    assert.ok(readLog(log).length >= 3);
  } finally {
    await t.stop();
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('すぐ落ちるときは、間隔を延ばしながら起動し直す（上限あり）', async () => {
  const dir = tmpDir();
  const log = path.join(dir, 'log');
  const t = fakeTunnel({ FAKE_CF_MODE: 'crash', FAKE_CF_LOG: log }, { minBackoffMs: 40, maxBackoffMs: 160 });
  const times = [];
  t.on('status', (s) => s.state === 'starting' && times.push(Date.now()));
  try {
    const s = await t.start();
    assert.strictEqual(s.state, 'error');
    assert.match(s.error, /終了コード 1/);
    assert.match(s.error, /failed to connect/, '出力の最後の数行を添える');
    await waitFor(() => times.length >= 5, 8000);
    const gaps = times.slice(1).map((x, i) => x - times[i]);
    assert.ok(gaps[0] >= 30, `1回目 ${gaps[0]}`);
    assert.ok(gaps[2] >= 140, `3回目は延びる ${gaps[2]}`);
    assert.ok(gaps[3] < 1500, `上限で止まる ${gaps[3]}`);
  } finally {
    await t.stop();
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('stop() で止まり、起動し直さない', async () => {
  const dir = tmpDir();
  const log = path.join(dir, 'log');
  const t = fakeTunnel({ FAKE_CF_LOG: log });
  try {
    await t.start();
    const [{ pid }] = readLog(log);
    assert.ok(alive(pid));
    await t.stop();
    assert.deepStrictEqual(t.status(), { state: 'stopped', url: null, mode: 'quick', error: null });
    await waitFor(() => !alive(pid));
    await new Promise((r) => setTimeout(r, 300));
    assert.strictEqual(readLog(log).length, 1, '止めたあとは起動し直さない');
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('起動し直しを待っているあいだに stop() したら、もう起動しない', async () => {
  const dir = tmpDir();
  const log = path.join(dir, 'log');
  const t = fakeTunnel({ FAKE_CF_MODE: 'crash', FAKE_CF_LOG: log }, { minBackoffMs: 200 });
  try {
    await t.start();
    await t.stop();
    await new Promise((r) => setTimeout(r, 400));
    assert.strictEqual(readLog(log).length, 1);
    assert.strictEqual(t.status().state, 'stopped');
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('URL が出なければ時間切れで error にし、プロセスを止めて起動し直す', async () => {
  const dir = tmpDir();
  const log = path.join(dir, 'log');
  const t = fakeTunnel({ FAKE_CF_MODE: 'silent', FAKE_CF_LOG: log }, { urlTimeoutMs: 300, minBackoffMs: 50 });
  try {
    const s = await t.start();
    assert.strictEqual(s.state, 'error');
    assert.match(s.error, /0\.3 秒たっても URL を出しませんでした/);
    // 重いときは、偽の cloudflared が記録を書く前に時間切れで止められることがあるので、記録が出るまで待つ
    await waitFor(() => readLog(log).length >= 1, 10000);
    const [{ pid }] = readLog(log);
    await waitFor(() => !alive(pid), 10000);
    await waitFor(() => readLog(log).length >= 2, 10000);
  } finally {
    await t.stop();
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('named で、つながった印が出なければ時間切れ', async () => {
  const t = fakeTunnel({ FAKE_CF_MODE: 'silent' }, { mode: 'named', namedToken: TOKEN, namedHostname: 'a.example.com', urlTimeoutMs: 200 });
  try {
    const s = await t.start();
    assert.strictEqual(s.state, 'error');
    assert.match(s.error, /Cloudflare につながりませんでした/);
    assert.ok(!s.error.includes(TOKEN));
  } finally {
    await t.stop();
  }
});

test('エラー文・status・イベントにトークンを入れない（出力にトークンが出ても伏せる）', async () => {
  const t = fakeTunnel({ FAKE_CF_MODE: 'crash', FAKE_CF_OUTPUT: `ERR bad token ${TOKEN} given` }, { mode: 'named', namedToken: TOKEN, namedHostname: 'a.example.com' });
  const seen = [];
  t.on('status', (s) => seen.push(JSON.stringify(s)));
  t.on('url', (u) => seen.push(u));
  try {
    const s = await t.start();
    assert.strictEqual(s.state, 'error');
    assert.match(s.error, /bad token \*\*\* given/);
    assert.ok(!JSON.stringify(t.status()).includes(TOKEN));
    for (const x of seen) assert.ok(!x.includes(TOKEN), x);
  } finally {
    await t.stop();
  }
});

test('cloudflared が無いときは、入れ方を添えたエラーにする', async () => {
  const t = new CloudflareTunnel({ command: path.join(os.tmpdir(), 'no-such-cloudflared-xyz'), localPort: 1, minBackoffMs: 5000, platform: 'darwin' });
  try {
    const s = await t.start();
    assert.strictEqual(s.state, 'error');
    assert.match(s.error, /見つかりません/);
    assert.match(s.error, /brew install cloudflared/);
  } finally {
    await t.stop();
  }
});

test('setOptions: 動いていれば新しい設定で起動し直す。止まっていれば設定を変えるだけ', async () => {
  const dir = tmpDir();
  const log = path.join(dir, 'log');
  const t = fakeTunnel({ FAKE_CF_LOG: log, FAKE_CF_SUB: 'first' });
  try {
    await t.setOptions({ localPort: 20000 });
    assert.strictEqual(readLog(log).length, 0, '止まっているあいだは起動しない');
    await t.start();
    assert.ok(readLog(log)[0].args.includes('http://127.0.0.1:20000'));
    const s = await t.setOptions({ localPort: 20001, mode: 'named', namedToken: TOKEN, namedHostname: 'b.example.com', env: { ...process.env, FAKE_CF_LOG: log, FAKE_CF_MODE: 'named' } });
    assert.deepStrictEqual(s, { state: 'running', url: 'https://b.example.com', mode: 'named', error: null });
    const runs = readLog(log);
    assert.strictEqual(runs.length, 2);
    assert.ok(!alive(runs[0].pid), '前のプロセスは止める');
    assert.deepStrictEqual(runs[1].args, ['tunnel', '--no-autoupdate', 'run']);
  } finally {
    await t.stop();
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('Windows ではプロセスを taskkill /T /F で止める', () => {
  const src = fs.readFileSync(path.join(__dirname, '..', 'src', 'cloudflare-tunnel.js'), 'utf8');
  assert.match(src, /execFile\('taskkill', \['\/pid', String\(child\.pid\), '\/T', '\/F'\]/);
});

test('表示文は en/es/fr/zh に訳があり、差し込みの名前が残らない', () => {
  const src = fs.readFileSync(path.join(__dirname, '..', 'src', 'cloudflare-tunnel.js'), 'utf8');
  const keys = [...src.matchAll(/\btr\(\s*('(?:\\'|[^'])*')/g)].map((m) => Function(`"use strict"; return ${m[1]};`)());
  assert.ok(keys.length >= 10);
  try {
    for (const code of ['en', 'es', 'fr', 'zh']) {
      I18n.setLanguage(code);
      for (const key of keys) {
        assert.strictEqual(I18n.has(key, code), true, `${code} ${key}`);
        const names = (key.match(/\{(\w+)\}/g) || []).sort();
        const got = (I18n.tr(key).match(/\{(\w+)\}/g) || []).sort();
        assert.deepStrictEqual(got, names, `${code} ${key}`);
      }
    }
    I18n.setLanguage('en');
    assert.match(installHint('darwin').note, /brew install cloudflared/);
    assert.doesNotMatch(installHint('linux').note, /[\u3040-\u30ff]/);
  } finally {
    I18n.setLanguage('ja');
  }
});
