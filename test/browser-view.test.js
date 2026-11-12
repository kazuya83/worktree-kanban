// 内蔵ブラウザ（詳細の「ブラウザ」タブ）とデザインモード
const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const root = path.join(__dirname, '..');
const read = (rel) => fs.readFileSync(path.join(root, rel), 'utf8');
const I18n = require('../renderer/i18n.js');
const BV = require('../renderer/browser-view.js');

test.afterEach(() => I18n.setLanguage('ja'));

test('previewUrl: タスクのポートから localhost の URL を作る', () => {
  assert.strictEqual(BV.previewUrl(20010), 'http://localhost:20010/');
  assert.strictEqual(BV.previewUrl('20010'), 'http://localhost:20010/');
  assert.strictEqual(BV.previewUrl(null), '');
  assert.strictEqual(BV.previewUrl(0), '');
  assert.strictEqual(BV.previewUrl(70000), '');
});

test('normalizeUrl: ポート番号・ホスト名だけでも開け、http(s) 以外は開かない', () => {
  assert.strictEqual(BV.normalizeUrl('3000'), 'http://localhost:3000/');
  assert.strictEqual(BV.normalizeUrl(':3000/admin'), 'http://localhost:3000/admin');
  assert.strictEqual(BV.normalizeUrl('localhost:5173/x?y=1'), 'http://localhost:5173/x?y=1');
  assert.strictEqual(BV.normalizeUrl('127.0.0.1:8080'), 'http://127.0.0.1:8080/');
  assert.strictEqual(BV.normalizeUrl('example.com'), 'http://example.com/');
  assert.strictEqual(BV.normalizeUrl('https://example.com/a'), 'https://example.com/a');
  assert.strictEqual(BV.normalizeUrl('  '), '');
  assert.strictEqual(BV.normalizeUrl('javascript:alert(1)'), '');
  assert.strictEqual(BV.normalizeUrl('file:///etc/passwd'), '');
  assert.strictEqual(BV.normalizeUrl('data:text/html,hi'), '');
});

test('parsePickMessage: 印の付いた console の行だけを読む', () => {
  assert.deepStrictEqual(BV.parsePickMessage(`${BV.PICK_MARK}{"tag":"button"}`), { tag: 'button' });
  assert.strictEqual(BV.parsePickMessage('{"tag":"button"}'), null);
  assert.strictEqual(BV.parsePickMessage(`${BV.PICK_MARK}{broken`), null);
  assert.strictEqual(BV.parsePickMessage(undefined), null);
});

test('captureRect: 部品のまわりを少し広げ、画面の中に収める', () => {
  const vp = { width: 800, height: 600 };
  assert.deepStrictEqual(BV.captureRect({ x: 100, y: 50, width: 200, height: 40 }, vp, 10), { x: 90, y: 40, width: 220, height: 60 });
  // 画面の端からはみ出す部品は、見えているところだけ
  assert.deepStrictEqual(BV.captureRect({ x: -50, y: 500, width: 1000, height: 300 }, vp, 10), { x: 0, y: 490, width: 800, height: 110 });
  // 見えていない・大きさがない部品は撮れない（画面全体を撮る）
  assert.strictEqual(BV.captureRect({ x: 900, y: 0, width: 10, height: 10 }, vp, 0), null);
  assert.strictEqual(BV.captureRect(null, vp), null);
});

test('buildPickMessage: 指示のあとに、選んだ部品の場所・HTML・CSS とスクリーンショットの名前を書く', () => {
  const pick = {
    url: 'http://localhost:20010/login',
    tag: 'button',
    selector: 'form.login > button.primary',
    text: 'ログイン\n する',
    html: '<button class="primary">ログイン する</button>',
    rect: { x: 10.4, y: 20.6, width: 120, height: 32 },
    viewport: { width: 1024, height: 700 },
    styles: { color: 'rgb(255, 255, 255)', 'font-size': '14px' },
    rules: [{ css: '.primary { color: white; }', source: '/src/app.css' }],
  };
  const msg = BV.buildPickMessage('  もっと大きくして ', [{ pick, shotName: 'design-1.png' }]);
  assert.ok(msg.startsWith('もっと大きくして\n\n## 内蔵ブラウザで選んだ画面の部品'));
  assert.match(msg, /### 1\. `form\.login > button\.primary`/);
  assert.match(msg, /- ページ: http:\/\/localhost:20010\/login/);
  assert.match(msg, /x=10, y=21, 120×32px/);
  assert.match(msg, /- スクリーンショット: design-1\.png/);
  assert.match(msg, /- 文字: ログイン する/);
  assert.match(msg, /```html\n<button class="primary">ログイン する<\/button>\n```/);
  assert.match(msg, /```css\n\/\* \/src\/app\.css \*\/\n\.primary \{ color: white; \}\n```/);
  assert.match(msg, /color: rgb\(255, 255, 255\);\nfont-size: 14px;/);
  // 選んだ部品がなければ指示だけ
  assert.strictEqual(BV.buildPickMessage('そのまま', []), 'そのまま');
  // スクリーンショットがなければ書かない（btw で送るとき）
  assert.doesNotMatch(BV.buildPickMessage('x', [{ pick }]), /スクリーンショット/);
});

test('buildPickMessage: 長い HTML は切り、``` を含む中身でもコードブロックが閉じる', () => {
  const html = `<pre>\`\`\`</pre>${'a'.repeat(10000)}`;
  const msg = BV.buildPickMessage('x', [{ pick: { selector: 'pre', html } }]);
  assert.match(msg, /````html\n/);
  assert.ok(msg.length < 8000);
  assert.match(msg, /長いので、ここまでにしました/);
});

test('buildPickMessage: 英語のときは見出しも英語になる', () => {
  I18n.setLanguage('en');
  const msg = BV.buildPickMessage('Bigger', [{ pick: { selector: 'h1', url: 'http://localhost:1/' }, shotName: 's.png' }]);
  assert.match(msg, /## Page elements selected in the built-in browser/);
  assert.match(msg, /- Page: http:\/\/localhost:1\//);
  assert.match(msg, /- Screenshot: s\.png/);
});

test('buildPickMessage: ペンで囲んだ範囲は、範囲・中にある部品・まとめた HTML を書く', () => {
  const pick = {
    kind: 'area',
    url: 'http://localhost:20010/',
    rect: { x: 40, y: 60, width: 300, height: 120 },
    viewport: { width: 1024, height: 700 },
    text: 'タイトル\n 説明',
    elements: [
      { tag: 'h1', selector: 'header > h1', html: '<h1>タイトル</h1>' },
      { tag: 'p', selector: 'header > p', html: '<p>説明</p>' },
    ],
    more: 3,
  };
  const msg = BV.buildPickMessage('ここを詰めて', [{ pick, shotName: 'design-a.png' }]);
  assert.match(msg, /### 1\. ペンで囲んだ範囲/);
  assert.match(msg, /x=40, y=60, 300×120px/);
  assert.match(msg, /- スクリーンショット: design-a\.png（赤い線で囲んだところ）/);
  assert.match(msg, /- 文字: タイトル 説明/);
  assert.match(msg, /囲んだ中にある部品:\n- `header > h1`\n- `header > p`\n- ほか 3 個/);
  assert.match(msg, /```html\n<h1>タイトル<\/h1>\n\n<p>説明<\/p>\n```/);
  // 部品を選んだものと混ぜても番号が続く
  const mixed = BV.buildPickMessage('x', [{ pick: { selector: 'nav' } }, { pick }]);
  assert.match(mixed, /### 1\. `nav`[\s\S]*### 2\. ペンで囲んだ範囲/);
});

test('PICK_SCRIPT は JavaScript として読め、何度入れても同じものを返す', () => {
  // ページの中で動かす: 最低限の window / document をまねる
  const listeners = [];
  const ctx = {
    console,
    addEventListener: (t, f) => listeners.push(t),
    removeEventListener: () => {},
    document: { documentElement: { style: {} }, styleSheets: [] },
  };
  ctx.window = ctx;
  vm.createContext(ctx);
  const a = vm.runInContext(BV.PICK_SCRIPT, ctx);
  const b = vm.runInContext(BV.PICK_SCRIPT, ctx);
  assert.strictEqual(a, b);
  assert.strictEqual(a.on, false);
  a.start();
  assert.strictEqual(a.on, true);
  assert.strictEqual(a.tool, 'pick');
  assert.ok(listeners.includes('click') && listeners.includes('keydown'));
  assert.ok(listeners.includes('pointerdown') && listeners.includes('pointermove') && listeners.includes('pointerup'));
  // 動いているときに呼ぶと、道具だけを切り替える（二重に登録しない）
  const n = listeners.length;
  a.start('pen');
  assert.strictEqual(a.tool, 'pen');
  assert.strictEqual(listeners.length, n);
  a.start('pick');
  assert.strictEqual(a.tool, 'pick');
  assert.strictEqual(ctx.document.documentElement.style.cursor, 'crosshair');
  a.stop();
  assert.strictEqual(a.on, false);
  assert.strictEqual(ctx.document.documentElement.style.cursor, '');
});

test('<webview> のセッション名は、画面と main.js で同じ。main.js は Node・プリロードを外し、http(s) だけを開く', () => {
  const main = read('main.js');
  assert.ok(main.includes(`const PREVIEW_PARTITION = '${BV.PARTITION}'`));
  assert.match(main, /webviewTag: true/);
  assert.match(main, /will-attach-webview/);
  assert.match(main, /delete prefs\.preload/);
  assert.match(main, /prefs\.nodeIntegration = false/);
  assert.match(main, /setWindowOpenHandler\(\(\{ url \}\)/);
  assert.ok(read('renderer/browser-view.js').includes('partition="${PARTITION}"'));
});

test('index.html: 「ブラウザ」タブと置き場所があり、文言の辞書を画面のスクリプトより先に読む', () => {
  const html = read('renderer/index.html');
  assert.match(html, /data-tab="browser"/);
  assert.match(html, /id="browserPane"/);
  const order = [...html.matchAll(/<script src="([^"]+)"/g)].map((m) => m[1]);
  assert.ok(order.indexOf('locales/browser.js') < order.indexOf('browser-view.js'));
  assert.ok(order.indexOf('browser-view.js') < order.indexOf('renderer.js'));
});

test('内蔵ブラウザの文言は4言語に訳され、差し込み名が一致する', () => {
  const src = read('renderer/browser-view.js');
  const keys = [...src.matchAll(/\btr\(\s*('(?:\\'|[^'])*')/g)].map((m) => Function(`return ${m[1]}`)());
  assert.ok(keys.length > 20);
  const names = (s) => [...String(s).matchAll(/\{(\w+)\}/g)].map((m) => m[1]).sort().join();
  for (const key of keys) {
    for (const lang of ['en', 'es', 'fr', 'zh']) {
      assert.strictEqual(I18n.has(key, lang), true, `${lang}: ${key}`);
      I18n.setLanguage(lang);
      assert.strictEqual(names(I18n.tr(key)), names(key), `${lang}: ${key}`);
    }
    I18n.setLanguage('ja');
  }
});

test('locales/browser.js は、ほかの辞書と同じキーを持たない（読み込む順で訳が変わらないように）', () => {
  const mine = Object.keys(vm.runInNewContext(`(${read('renderer/locales/browser.js').replace(/^[\s\S]*?\.add\(/, '').replace(/\);\s*$/, '')})`));
  const dir = path.join(root, 'renderer/locales');
  for (const f of fs.readdirSync(dir)) {
    if (f === 'browser.js' || !f.endsWith('.js')) continue;
    const s = fs.readFileSync(path.join(dir, f), 'utf8');
    for (const k of mine) assert.ok(!s.includes(`${JSON.stringify(k)}:`), `${f}: ${k}`);
  }
});
