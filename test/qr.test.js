// スマホをつなぐ URL を出す QR コード（renderer/qr.js）を確かめる
// 行列のハッシュは、macOS の CoreImage（CIDetector）で読み戻して、元の文字に戻ることを確かめたときのもの
const test = require('node:test');
const assert = require('node:assert');
const crypto = require('crypto');
const QR = require('../renderer/qr');

const hash = (modules) => crypto.createHash('sha256').update(modules.map((r) => r.map((b) => (b ? 1 : 0)).join('')).join('\n')).digest('hex');

test('Reed-Solomon: 規格の例（HELLO WORLD 1-M）と同じ誤り訂正の語になる', () => {
  const data = [32, 91, 11, 120, 209, 114, 220, 77, 67, 64, 236, 17, 236, 17, 236, 17];
  const ecc = QR._internal.rsRemainder(data, QR._internal.rsDivisor(10));
  assert.deepStrictEqual(ecc, [196, 35, 39, 119, 235, 215, 231, 226, 93, 23]);
});

test('型番: 入るいちばん小さいものを選び、大きさは 4×型番+17', () => {
  assert.strictEqual(QR.encode('a').version, 1);
  assert.strictEqual(QR.encode('a').size, 21);
  // 1-M の byte モードは 14 バイトまで
  assert.strictEqual(QR._internal.chooseVersion(14), 1);
  assert.strictEqual(QR._internal.chooseVersion(15), 2);
  assert.strictEqual(QR.encode('x'.repeat(600)).version, 19);
  assert.throws(() => QR.encode('x'.repeat(3000)));
});

test('位置合わせのパターンの場所が規格の表と同じ', () => {
  assert.deepStrictEqual(QR._internal.alignmentPositions(1), []);
  assert.deepStrictEqual(QR._internal.alignmentPositions(7), [6, 22, 38]);
  assert.deepStrictEqual(QR._internal.alignmentPositions(32), [6, 34, 60, 86, 112, 138]);
});

test('3 つの角に位置検出パターンがある', () => {
  const { modules, size } = QR.encode('https://example.com/');
  const finder = (x0, y0) => {
    for (let y = 0; y < 7; y++) {
      for (let x = 0; x < 7; x++) {
        const ring = Math.max(Math.abs(x - 3), Math.abs(y - 3));
        assert.strictEqual(modules[y0 + y][x0 + x], ring !== 2, `(${x0 + x},${y0 + y})`);
      }
    }
  };
  finder(0, 0);
  finder(size - 7, 0);
  finder(0, size - 7);
});

test('読み取りを確かめた行列と同じになる（URL・日本語）', () => {
  const a = QR.encode('https://abc-def-ghi-jkl.trycloudflare.com/#pair=ABCD2345');
  assert.strictEqual(a.version, 4);
  assert.strictEqual(hash(a.modules), '7438175dc6f19f4ca69cec7c7d221de3db00cd935e8c542dcc86adc6b8e9a343');
  const b = QR.encode('日本語のテスト https://example.com/');
  assert.strictEqual(b.version, 3);
  assert.strictEqual(hash(b.modules), '522193ae9c06e5a49757accec7d153e13c7aaf0767da1aeda1e850b847991226');
});

test('toSvg: 余白つきの SVG を返し、色に変な文字を入れられない', () => {
  const svg = QR.toSvg('a', { dark: '#123"><script>', light: '#fff' });
  assert.match(svg, /^<svg [^>]*viewBox="0 0 29 29"/);
  assert.doesNotMatch(svg, /<script/);
});
