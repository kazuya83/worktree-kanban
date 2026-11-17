// 内蔵ブラウザで覚えるパスワード（src/browser-passwords.js）
const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const vm = require('node:vm');
const { EventEmitter } = require('node:events');
const BP = require('../src/browser-passwords');

// 差し替えの safeStorage（逆さにするだけ。平文で保存していないことを確かめるため）
const fakeSafe = (on = true) => ({
  isEncryptionAvailable: () => on,
  encryptString: (s) => Buffer.from(`enc:${[...s].reverse().join('')}`),
  decryptString: (b) => [...b.toString().slice(4)].reverse().join(''),
});
const tmpFile = () => path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'wk-bp-')), 'browser-passwords.json');

test('siteKey: ポートは見ず、localhost・127.0.0.1・[::1] を同じサイトにする。http(s) 以外は覚えない', () => {
  assert.strictEqual(BP.siteKey('http://localhost:20010/login'), 'http://localhost');
  assert.strictEqual(BP.siteKey('http://127.0.0.1:3000/'), 'http://localhost');
  assert.strictEqual(BP.siteKey('http://[::1]:8080/'), 'http://localhost');
  assert.strictEqual(BP.siteKey('https://app.example.com:8443/a'), 'https://app.example.com');
  assert.notStrictEqual(BP.siteKey('http://example.com/'), BP.siteKey('https://example.com/'));
  assert.strictEqual(BP.siteKey('file:///etc/passwd'), '');
  assert.strictEqual(BP.siteKey('about:blank'), '');
  assert.strictEqual(BP.siteKey('not a url'), '');
});

test('parseMessage: 印の付いた行だけを読み、空のパスワードは捨てる', () => {
  assert.deepStrictEqual(BP.parseMessage(`${BP.MARK}{"kind":"save","url":"http://a/","username":" me ","password":"pw"}`), { kind: 'save', url: 'http://a/', username: 'me', password: 'pw' });
  assert.deepStrictEqual(BP.parseMessage(`${BP.MARK}{"kind":"fill","url":"http://a/"}`), { kind: 'fill', url: 'http://a/' });
  assert.strictEqual(BP.parseMessage(`${BP.MARK}{"kind":"save","password":""}`), null);
  assert.strictEqual(BP.parseMessage(`${BP.MARK}{broken`), null);
  assert.strictEqual(BP.parseMessage('{"kind":"save","password":"x"}'), null);
});

test('保存・読み出し: 暗号化して保存し、一覧にはパスワードを出さない', () => {
  const file = tmpFile();
  const s = new BP.BrowserPasswords({ file, safeStorage: fakeSafe() });
  assert.strictEqual(s.offerKind('http://localhost', 'me', 'secret'), 'new');
  s.save('http://localhost', 'me', 'secret');
  assert.ok(!fs.readFileSync(file, 'utf8').includes('secret'));
  assert.strictEqual(fs.statSync(file).mode & 0o777, 0o600);
  assert.strictEqual(s.offerKind('http://localhost', 'me', 'secret'), '');
  assert.strictEqual(s.offerKind('http://localhost', 'me', 'other'), 'update');
  const again = new BP.BrowserPasswords({ file, safeStorage: fakeSafe() });
  assert.deepStrictEqual(again.credentialFor('http://localhost'), { username: 'me', password: 'secret' });
  const list = again.list();
  assert.strictEqual(JSON.stringify(list).includes('secret'), false);
  assert.deepStrictEqual(list.logins.map((x) => [x.site, x.username]), [['http://localhost', 'me']]);
  assert.strictEqual(again.remove('http://localhost', 'me'), true);
  assert.strictEqual(again.credentialFor('http://localhost'), null);
});

test('いちばん新しく保存したログインを入れる。「保存しない」サイトでは聞かない', () => {
  const s = new BP.BrowserPasswords({ file: tmpFile(), safeStorage: fakeSafe() });
  s.save('http://localhost', 'a', '1');
  s.save('http://localhost', 'b', '2');
  assert.strictEqual(s.credentialFor('http://localhost').username, 'b');
  s.setNever('https://x.example', true);
  assert.strictEqual(s.offerKind('https://x.example', 'me', 'pw'), '');
  assert.deepStrictEqual(s.list().never, ['https://x.example']);
  s.save('https://x.example', 'me', 'pw'); // 保存したら「保存しない」から外す
  assert.deepStrictEqual(s.list().never, []);
});

test('OS の安全な保存先が無ければ、保存しない（聞きもしない）', () => {
  const s = new BP.BrowserPasswords({ file: tmpFile(), safeStorage: fakeSafe(false) });
  assert.strictEqual(s.offerKind('http://localhost', 'me', 'pw'), '');
  assert.throws(() => s.save('http://localhost', 'me', 'pw'));
  const basic = { ...fakeSafe(), getSelectedStorageBackend: () => 'basic_text' };
  assert.strictEqual(new BP.BrowserPasswords({ file: tmpFile(), safeStorage: basic }).available(), false);
});

// <webview> の webContents の代わり
function fakeGuest(url) {
  const g = new EventEmitter();
  g.id = 7;
  g.url = url;
  g.getURL = () => g.url;
  g.runs = [];
  g.executeJavaScriptInIsolatedWorld = (world, scripts) => {
    g.runs.push({ world, code: scripts[0].code });
    return Promise.resolve();
  };
  return g;
}

test('attach: ページを開くたびに別の世界で見張りを入れ、保存するかは画面にユーザー名だけを知らせる', () => {
  const store = new BP.BrowserPasswords({ file: tmpFile(), safeStorage: fakeSafe() });
  const offers = [];
  const g = fakeGuest('http://localhost:20010/login');
  const w = BP.attach(g, { store, offer: (o) => offers.push(o) });
  g.emit('dom-ready');
  assert.strictEqual(g.runs[0].world, BP.WORLD_ID);
  assert.strictEqual(g.runs[0].code, BP.WATCH_SCRIPT);
  g.emit('console-message', { message: `${BP.MARK}${JSON.stringify({ kind: 'save', url: g.url, username: 'me', password: 'pw' })}` });
  assert.deepStrictEqual(offers, [{ webContentsId: 7, site: 'http://localhost', username: 'me', kind: 'new' }]);
  assert.deepStrictEqual(w.pending(), { site: 'http://localhost', username: 'me', password: 'pw' });
  // 知らせの URL が、ページが今いるサイトと違えば扱わない
  g.emit('console-message', { message: `${BP.MARK}${JSON.stringify({ kind: 'save', url: 'https://evil.example/', username: 'x', password: 'y' })}` });
  assert.strictEqual(offers.length, 1);
});

test('attach: 入れるのは、ページが今いるサイトで保存したものだけ（別のポートでも同じ localhost なら入れる）', () => {
  const store = new BP.BrowserPasswords({ file: tmpFile(), safeStorage: fakeSafe() });
  store.save('http://localhost', 'me', 'pw"x');
  const g = fakeGuest('http://localhost:20011/');
  BP.attach(g, { store, offer: () => {} });
  g.emit('console-message', { message: `${BP.MARK}${JSON.stringify({ kind: 'fill', url: g.url })}` });
  assert.strictEqual(g.runs.length, 1);
  assert.strictEqual(g.runs[0].world, BP.WORLD_ID);
  assert.strictEqual(g.runs[0].code, BP.fillScript({ username: 'me', password: 'pw"x' }));
  const other = fakeGuest('https://example.com/');
  BP.attach(other, { store, offer: () => {} });
  other.emit('console-message', { message: `${BP.MARK}${JSON.stringify({ kind: 'fill', url: other.url })}` });
  assert.strictEqual(other.runs.length, 0);
});

test('WATCH_SCRIPT は JS として読め、何度入れても1つだけ動く', () => {
  assert.doesNotThrow(() => new vm.Script(BP.WATCH_SCRIPT));
  assert.match(BP.WATCH_SCRIPT, /if \(g\.__wkPw\) return;/);
  assert.doesNotThrow(() => new vm.Script(BP.fillScript({ username: "a'b", password: '</script>"' })));
});

test('main.js: パスワードはメインプロセスで扱い、画面にはサイトとユーザー名だけを渡す', () => {
  const main = fs.readFileSync(path.join(__dirname, '..', 'main.js'), 'utf8');
  assert.match(main, /BrowserPasswordsLib\.attach\(guest/);
  assert.match(main, /handle\('browser:passwordAnswer'/);
  const preload = fs.readFileSync(path.join(__dirname, '..', 'preload.js'), 'utf8');
  assert.match(preload, /onBrowserPasswordOffer/);
  assert.strictEqual(require('../src/remote').isProxyChannel('browser:passwords'), false);
  assert.strictEqual(require('../src/remote').isLocalChannel('browser:passwords'), true);
});
