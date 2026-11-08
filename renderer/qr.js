// QR コードを作る（外部のパッケージを使わない）。スマホをつなぐときの URL を、設定画面に QR で出すため
// - 文字は UTF-8 のバイト（byte モード）、誤り訂正は M、型番は 1〜40 から入る大きさのいちばん小さいもの
// - 作り方は ISO/IEC 18004 の手順どおり（データ → Reed-Solomon → 並べ替え → 配置 → マスク）
// レンダラ（<script>）とテスト（require）の両方から使う
(function (root, factory) {
  const api = factory();
  if (typeof module === 'object' && module.exports) module.exports = api;
  else root.QR = api;
})(typeof globalThis !== 'undefined' ? globalThis : this, function () {
  // 誤り訂正 M の、型番ごとの「1 ブロックの誤り訂正の語数」と「ブロックの数」（添字 0 は使わない）
  const ECC_PER_BLOCK = [-1, 10, 16, 26, 18, 24, 16, 18, 22, 22, 26, 30, 22, 22, 24, 24, 28, 28, 26, 26, 26, 26, 28, 28, 28, 28, 28, 28, 28, 28, 28, 28, 28, 28, 28, 28, 28, 28, 28, 28, 28];
  const NUM_BLOCKS = [-1, 1, 1, 1, 2, 2, 4, 4, 4, 5, 5, 5, 8, 9, 9, 10, 10, 11, 13, 14, 16, 17, 17, 18, 20, 21, 23, 25, 26, 28, 29, 31, 33, 35, 37, 38, 40, 43, 45, 47, 49];
  const FORMAT_BITS_M = 0; // 形式情報での M の値

  const getBit = (x, i) => ((x >>> i) & 1) !== 0;

  function utf8Bytes(text) {
    const s = String(text);
    if (typeof TextEncoder !== 'undefined') return Array.from(new TextEncoder().encode(s));
    return Array.from(Buffer.from(s, 'utf8'));
  }

  // 型番の、データと誤り訂正を置けるモジュールの数（機能パターンを除く）
  function numRawDataModules(ver) {
    let result = (16 * ver + 128) * ver + 64;
    if (ver >= 2) {
      const numAlign = Math.floor(ver / 7) + 2;
      result -= (25 * numAlign - 10) * numAlign - 55;
      if (ver >= 7) result -= 36;
    }
    return result;
  }

  function numDataCodewords(ver) {
    return Math.floor(numRawDataModules(ver) / 8) - ECC_PER_BLOCK[ver] * NUM_BLOCKS[ver];
  }

  // GF(2^8)（原始多項式 0x11D）の掛け算
  function gfMul(x, y) {
    let z = 0;
    for (let i = 7; i >= 0; i--) {
      z = (z << 1) ^ ((z >>> 7) * 0x11d);
      z ^= ((y >>> i) & 1) * x;
    }
    return z & 0xff;
  }

  function rsDivisor(degree) {
    const result = new Array(degree).fill(0);
    result[degree - 1] = 1;
    let r = 1;
    for (let i = 0; i < degree; i++) {
      for (let j = 0; j < result.length; j++) {
        result[j] = gfMul(result[j], r);
        if (j + 1 < result.length) result[j] ^= result[j + 1];
      }
      r = gfMul(r, 0x02);
    }
    return result;
  }

  function rsRemainder(data, divisor) {
    const result = new Array(divisor.length).fill(0);
    for (const b of data) {
      const factor = b ^ result.shift();
      result.push(0);
      for (let i = 0; i < divisor.length; i++) result[i] ^= gfMul(divisor[i], factor);
    }
    return result;
  }

  // データの語に誤り訂正を足し、ブロックをまたいで並べ替える
  function addEccAndInterleave(data, ver) {
    const numBlocks = NUM_BLOCKS[ver];
    const eccLen = ECC_PER_BLOCK[ver];
    const rawCodewords = Math.floor(numRawDataModules(ver) / 8);
    const numShort = numBlocks - (rawCodewords % numBlocks);
    const shortLen = Math.floor(rawCodewords / numBlocks);
    const divisor = rsDivisor(eccLen);
    const blocks = [];
    for (let i = 0, k = 0; i < numBlocks; i++) {
      const dat = data.slice(k, k + shortLen - eccLen + (i < numShort ? 0 : 1));
      k += dat.length;
      const ecc = rsRemainder(dat, divisor);
      if (i < numShort) dat.push(0);
      blocks.push(dat.concat(ecc));
    }
    const out = [];
    for (let i = 0; i < blocks[0].length; i++) {
      blocks.forEach((block, j) => {
        // 短いブロックに足した詰め物（0）は飛ばす
        if (i !== shortLen - eccLen || j >= numShort) out.push(block[i]);
      });
    }
    return out;
  }

  function alignmentPositions(ver) {
    if (ver === 1) return [];
    const numAlign = Math.floor(ver / 7) + 2;
    const step = ver === 32 ? 26 : Math.ceil((ver * 4 + 4) / (numAlign * 2 - 2)) * 2;
    const result = [6];
    for (let pos = ver * 4 + 17 - 7; result.length < numAlign; pos -= step) result.splice(1, 0, pos);
    return result;
  }

  // データ（byte モード）を語の列にする
  function encodeData(bytes, ver) {
    const bits = [];
    const put = (val, len) => {
      for (let i = len - 1; i >= 0; i--) bits.push((val >>> i) & 1);
    };
    put(0x4, 4);
    put(bytes.length, ver <= 9 ? 8 : 16);
    for (const b of bytes) put(b, 8);
    const capacity = numDataCodewords(ver) * 8;
    put(0, Math.min(4, capacity - bits.length));
    put(0, (8 - (bits.length % 8)) % 8);
    for (let pad = 0xec; bits.length < capacity; pad ^= 0xec ^ 0x11) put(pad, 8);
    const words = [];
    for (let i = 0; i < bits.length; i += 8) {
      let w = 0;
      for (let j = 0; j < 8; j++) w = (w << 1) | bits[i + j];
      words.push(w);
    }
    return words;
  }

  function chooseVersion(byteLen) {
    for (let ver = 1; ver <= 40; ver++) {
      const needBits = 4 + (ver <= 9 ? 8 : 16) + byteLen * 8;
      if (needBits <= numDataCodewords(ver) * 8) return ver;
    }
    return 0;
  }

  const MASKS = [
    (x, y) => (x + y) % 2 === 0,
    (x, y) => y % 2 === 0,
    (x) => x % 3 === 0,
    (x, y) => (x + y) % 3 === 0,
    (x, y) => (Math.floor(x / 3) + Math.floor(y / 2)) % 2 === 0,
    (x, y) => ((x * y) % 2) + ((x * y) % 3) === 0,
    (x, y) => (((x * y) % 2) + ((x * y) % 3)) % 2 === 0,
    (x, y) => (((x + y) % 2) + ((x * y) % 3)) % 2 === 0,
  ];

  class Matrix {
    constructor(ver) {
      this.ver = ver;
      this.size = ver * 4 + 17;
      this.modules = Array.from({ length: this.size }, () => new Array(this.size).fill(false));
      this.isFunction = Array.from({ length: this.size }, () => new Array(this.size).fill(false));
    }

    setFunc(x, y, dark) {
      this.modules[y][x] = dark;
      this.isFunction[y][x] = true;
    }

    drawFunctionPatterns() {
      const n = this.size;
      for (let i = 0; i < n; i++) {
        this.setFunc(6, i, i % 2 === 0);
        this.setFunc(i, 6, i % 2 === 0);
      }
      this.drawFinder(3, 3);
      this.drawFinder(n - 4, 3);
      this.drawFinder(3, n - 4);
      const pos = alignmentPositions(this.ver);
      const k = pos.length;
      for (let i = 0; i < k; i++) {
        for (let j = 0; j < k; j++) {
          if ((i === 0 && j === 0) || (i === 0 && j === k - 1) || (i === k - 1 && j === 0)) continue;
          for (let dy = -2; dy <= 2; dy++) for (let dx = -2; dx <= 2; dx++) this.setFunc(pos[i] + dx, pos[j] + dy, Math.max(Math.abs(dx), Math.abs(dy)) !== 1);
        }
      }
      this.drawFormatBits(0); // 場所を確保する（あとで本物で上書き）
      this.drawVersion();
    }

    drawFinder(x, y) {
      for (let dy = -4; dy <= 4; dy++) {
        for (let dx = -4; dx <= 4; dx++) {
          const dist = Math.max(Math.abs(dx), Math.abs(dy));
          const xx = x + dx;
          const yy = y + dy;
          if (xx >= 0 && xx < this.size && yy >= 0 && yy < this.size) this.setFunc(xx, yy, dist !== 2 && dist !== 4);
        }
      }
    }

    drawFormatBits(mask) {
      const data = (FORMAT_BITS_M << 3) | mask;
      let rem = data;
      for (let i = 0; i < 10; i++) rem = (rem << 1) ^ ((rem >>> 9) * 0x537);
      const bits = ((data << 10) | rem) ^ 0x5412;
      const n = this.size;
      for (let i = 0; i <= 5; i++) this.setFunc(8, i, getBit(bits, i));
      this.setFunc(8, 7, getBit(bits, 6));
      this.setFunc(8, 8, getBit(bits, 7));
      this.setFunc(7, 8, getBit(bits, 8));
      for (let i = 9; i < 15; i++) this.setFunc(14 - i, 8, getBit(bits, i));
      for (let i = 0; i < 8; i++) this.setFunc(n - 1 - i, 8, getBit(bits, i));
      for (let i = 8; i < 15; i++) this.setFunc(8, n - 15 + i, getBit(bits, i));
      this.setFunc(8, n - 8, true);
    }

    drawVersion() {
      if (this.ver < 7) return;
      let rem = this.ver;
      for (let i = 0; i < 12; i++) rem = (rem << 1) ^ ((rem >>> 11) * 0x1f25);
      const bits = (this.ver << 12) | rem;
      for (let i = 0; i < 18; i++) {
        const bit = getBit(bits, i);
        const a = this.size - 11 + (i % 3);
        const b = Math.floor(i / 3);
        this.setFunc(a, b, bit);
        this.setFunc(b, a, bit);
      }
    }

    drawCodewords(words) {
      const n = this.size;
      let i = 0;
      for (let right = n - 1; right >= 1; right -= 2) {
        if (right === 6) right = 5;
        for (let vert = 0; vert < n; vert++) {
          for (let j = 0; j < 2; j++) {
            const x = right - j;
            const upward = ((right + 1) & 2) === 0;
            const y = upward ? n - 1 - vert : vert;
            if (!this.isFunction[y][x] && i < words.length * 8) {
              this.modules[y][x] = getBit(words[i >>> 3], 7 - (i & 7));
              i++;
            }
          }
        }
      }
    }

    applyMask(mask) {
      const f = MASKS[mask];
      for (let y = 0; y < this.size; y++) {
        for (let x = 0; x < this.size; x++) {
          if (!this.isFunction[y][x] && f(x, y)) this.modules[y][x] = !this.modules[y][x];
        }
      }
    }

    // 読み取りにくさの点数（小さいほどよい）。マスクを選ぶのに使う
    penalty() {
      const n = this.size;
      const m = this.modules;
      let score = 0;
      const line = (get) => {
        let s = 0;
        let run = 1;
        for (let i = 1; i <= n; i++) {
          if (i < n && get(i) === get(i - 1)) run++;
          else {
            if (run >= 5) s += 3 + (run - 5);
            run = 1;
          }
        }
        // 1:1:3:1:1 の並び（前後に白が 4 つ）
        const str = Array.from({ length: n }, (_, i) => (get(i) ? '1' : '0')).join('');
        const padded = `0000${str}0000`;
        for (const pat of ['00001011101', '10111010000']) {
          for (let idx = padded.indexOf(pat); idx >= 0; idx = padded.indexOf(pat, idx + 1)) s += 40;
        }
        return s;
      };
      for (let y = 0; y < n; y++) score += line((x) => m[y][x]);
      for (let x = 0; x < n; x++) score += line((y) => m[y][x]);
      for (let y = 0; y < n - 1; y++) {
        for (let x = 0; x < n - 1; x++) {
          const c = m[y][x];
          if (c === m[y][x + 1] && c === m[y + 1][x] && c === m[y + 1][x + 1]) score += 3;
        }
      }
      let dark = 0;
      for (let y = 0; y < n; y++) for (let x = 0; x < n; x++) if (m[y][x]) dark++;
      const total = n * n;
      score += Math.floor(Math.abs(dark * 20 - total * 10) / total) * 10;
      return score;
    }
  }

  // text を QR の行列（true が黒）にする。入らない長さなら例外
  function encode(text) {
    const bytes = utf8Bytes(text);
    const ver = chooseVersion(bytes.length);
    if (!ver) throw new Error('QR: text is too long');
    const words = addEccAndInterleave(encodeData(bytes, ver), ver);
    const mx = new Matrix(ver);
    mx.drawFunctionPatterns();
    mx.drawCodewords(words);
    let best = 0;
    let bestScore = Infinity;
    for (let mask = 0; mask < 8; mask++) {
      mx.applyMask(mask);
      mx.drawFormatBits(mask);
      const s = mx.penalty();
      if (s < bestScore) {
        best = mask;
        bestScore = s;
      }
      mx.applyMask(mask); // 元に戻す（XOR なので 2 回で戻る）
    }
    mx.applyMask(best);
    mx.drawFormatBits(best);
    return { version: ver, size: mx.size, mask: best, modules: mx.modules };
  }

  // SVG の文字列にする（周りに 4 モジュールの余白）。色は CSS で変えられるよう、黒の部分を 1 つの path にする
  function toSvg(text, { border = 4, dark = '#000', light = '#fff' } = {}) {
    const qr = encode(text);
    const dim = qr.size + border * 2;
    const parts = [];
    for (let y = 0; y < qr.size; y++) {
      for (let x = 0; x < qr.size; x++) if (qr.modules[y][x]) parts.push(`M${x + border},${y + border}h1v1h-1z`);
    }
    const esc = (s) => String(s).replace(/[^#0-9a-zA-Z(),.% ]/g, '');
    return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${dim} ${dim}" shape-rendering="crispEdges"><rect width="100%" height="100%" fill="${esc(light)}"/><path d="${parts.join('')}" fill="${esc(dark)}"/></svg>`;
  }

  return { encode, toSvg, _internal: { numDataCodewords, chooseVersion, rsRemainder, rsDivisor, alignmentPositions } };
});
