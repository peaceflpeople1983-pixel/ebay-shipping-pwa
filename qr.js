/**
 * qr.js — QR コードを作る小さな自前の部品 (2026-11-18 メルカリ入荷照合・外部からの取得なし)
 *
 *   QR.matrix(text)                 → 0/1 の二次元配列 (余白なし・[行][列]・1=黒)
 *   QR.svg(text, { sizeMm, margin }) → SVG 文字列 (黒の矩形だけ・print-color-adjust: exact)
 *   QR.version(text)                → 使う版 (1〜10)
 *
 * 仕様: バイトモード (UTF-8)・誤り訂正 M・版 1〜10 (入る最小の版)・マスクは規格の減点 (N1〜N4) で自動選択。
 * 減点の数え方とマスク評価時の形式情報の扱いは Python の qrcode (8.x) と同じにしてあり、
 * tests/test_qr.js が Python qrcode の行列と全マス一致を確かめる。
 * ブラウザ (<script src="qr.js">) と Node (require) の両方で使える。
 */
const QR = (function () {
  'use strict';

  // ---- 誤り訂正 M のブロック構成: [ブロック数, 総コード語数, データコード語数] ----
  const RS_BLOCKS_M = {
    1: [[1, 26, 16]],
    2: [[1, 44, 28]],
    3: [[1, 70, 44]],
    4: [[2, 50, 32]],
    5: [[2, 67, 43]],
    6: [[4, 43, 27]],
    7: [[4, 49, 31]],
    8: [[2, 60, 38], [2, 61, 39]],
    9: [[3, 58, 36], [2, 59, 37]],
    10: [[4, 69, 43], [1, 70, 44]]
  };
  const ALIGN_POS = {
    1: [], 2: [6, 18], 3: [6, 22], 4: [6, 26], 5: [6, 30], 6: [6, 34],
    7: [6, 22, 38], 8: [6, 24, 42], 9: [6, 26, 46], 10: [6, 28, 50]
  };
  const EC_M_BITS = 0; // 形式情報の誤り訂正レベル M = 00
  const MAX_VERSION = 10;

  // ---- GF(256) (原始多項式 0x11D) ----
  const EXP = new Array(512);
  const LOG = new Array(256);
  (function () {
    let x = 1;
    for (let i = 0; i < 255; i++) { EXP[i] = x; LOG[x] = i; x <<= 1; if (x & 0x100) x ^= 0x11D; }
    for (let i = 255; i < 512; i++) EXP[i] = EXP[i - 255];
  })();
  function gmul(a, b) { return (a === 0 || b === 0) ? 0 : EXP[LOG[a] + LOG[b]]; }
  function rsGenerator(n) {
    let g = [1];
    for (let i = 0; i < n; i++) {
      const next = new Array(g.length + 1).fill(0);
      for (let j = 0; j < g.length; j++) {
        next[j] ^= g[j];
        next[j + 1] ^= gmul(g[j], EXP[i]);
      }
      g = next;
    }
    return g;
  }
  function rsEncode(data, ecCount) {
    const gen = rsGenerator(ecCount);
    const buf = data.concat(new Array(ecCount).fill(0));
    for (let i = 0; i < data.length; i++) {
      const coef = buf[i];
      if (coef === 0) continue;
      for (let j = 0; j < gen.length; j++) buf[i + j] ^= gmul(gen[j], coef);
    }
    return buf.slice(data.length);
  }

  // ---- UTF-8 ----
  function utf8(text) {
    const s = String(text == null ? '' : text);
    const out = [];
    for (let i = 0; i < s.length; i++) {
      let c = s.charCodeAt(i);
      if (c >= 0xD800 && c <= 0xDBFF && i + 1 < s.length) {
        const d = s.charCodeAt(i + 1);
        if (d >= 0xDC00 && d <= 0xDFFF) { c = 0x10000 + ((c - 0xD800) << 10) + (d - 0xDC00); i++; }
      }
      if (c < 0x80) out.push(c);
      else if (c < 0x800) out.push(0xC0 | (c >> 6), 0x80 | (c & 63));
      else if (c < 0x10000) out.push(0xE0 | (c >> 12), 0x80 | ((c >> 6) & 63), 0x80 | (c & 63));
      else out.push(0xF0 | (c >> 18), 0x80 | ((c >> 12) & 63), 0x80 | ((c >> 6) & 63), 0x80 | (c & 63));
    }
    return out;
  }

  function dataCodewords(v) { return RS_BLOCKS_M[v].reduce((s, b) => s + b[0] * b[2], 0); }
  function countBits(v) { return v < 10 ? 8 : 16; } // バイトモードの文字数指示子
  function chooseVersion(nBytes) {
    for (let v = 1; v <= MAX_VERSION; v++) {
      if (4 + countBits(v) + nBytes * 8 <= dataCodewords(v) * 8) return v;
    }
    throw new Error('QR: 文字が長すぎます (版10・誤り訂正M・バイトモードの上限 ' + (dataCodewords(10) - 3) + ' バイト)');
  }

  // ---- データ → 最終コード語列 ----
  function buildCodewords(bytes, v) {
    const bits = [];
    const put = (val, len) => { for (let i = len - 1; i >= 0; i--) bits.push((val >>> i) & 1); };
    put(4, 4);                       // バイトモード 0100
    put(bytes.length, countBits(v));
    bytes.forEach(b => put(b, 8));
    const limit = dataCodewords(v) * 8;
    for (let i = 0; i < 4 && bits.length < limit; i++) bits.push(0); // 終端
    while (bits.length % 8) bits.push(0);
    const data = [];
    for (let i = 0; i < bits.length; i += 8) {
      let b = 0; for (let j = 0; j < 8; j++) b = (b << 1) | bits[i + j]; data.push(b);
    }
    const PAD = [0xEC, 0x11];
    for (let i = 0; data.length < dataCodewords(v); i++) data.push(PAD[i % 2]);
    // ブロックに分けて RS
    const dcBlocks = [], ecBlocks = [];
    let off = 0;
    RS_BLOCKS_M[v].forEach(([n, total, dc]) => {
      for (let k = 0; k < n; k++) {
        const d = data.slice(off, off + dc); off += dc;
        dcBlocks.push(d);
        ecBlocks.push(rsEncode(d, total - dc));
      }
    });
    const out = [];
    const maxDc = Math.max.apply(null, dcBlocks.map(b => b.length));
    const maxEc = Math.max.apply(null, ecBlocks.map(b => b.length));
    for (let i = 0; i < maxDc; i++) dcBlocks.forEach(b => { if (i < b.length) out.push(b[i]); });
    for (let i = 0; i < maxEc; i++) ecBlocks.forEach(b => { if (i < b.length) out.push(b[i]); });
    return out;
  }

  // ---- 機能パターン (null = データ領域) ----
  function blank(v) {
    const n = v * 4 + 17;
    const m = [];
    for (let i = 0; i < n; i++) m.push(new Array(n).fill(null));
    const probe = (row, col) => {
      for (let r = -1; r <= 7; r++) {
        if (row + r < 0 || row + r >= n) continue;
        for (let c = -1; c <= 7; c++) {
          if (col + c < 0 || col + c >= n) continue;
          const on = (r >= 0 && r <= 6 && (c === 0 || c === 6)) || (c >= 0 && c <= 6 && (r === 0 || r === 6)) ||
            (r >= 2 && r <= 4 && c >= 2 && c <= 4);
          m[row + r][col + c] = on ? 1 : 0;
        }
      }
    };
    probe(0, 0); probe(n - 7, 0); probe(0, n - 7);
    const pos = ALIGN_POS[v];
    for (let i = 0; i < pos.length; i++) {
      for (let j = 0; j < pos.length; j++) {
        const row = pos[i], col = pos[j];
        if (m[row][col] !== null) continue;
        for (let r = -2; r <= 2; r++) for (let c = -2; c <= 2; c++) {
          m[row + r][col + c] = (r === -2 || r === 2 || c === -2 || c === 2 || (r === 0 && c === 0)) ? 1 : 0;
        }
      }
    }
    for (let r = 8; r < n - 8; r++) if (m[r][6] === null) m[r][6] = (r % 2 === 0) ? 1 : 0;
    for (let c = 8; c < n - 8; c++) if (m[6][c] === null) m[6][c] = (c % 2 === 0) ? 1 : 0;
    return m;
  }

  function bchDigit(d) { let k = 0; while (d !== 0) { k++; d >>>= 1; } return k; }
  function bchTypeInfo(data) {
    const G15 = 0x537, G15_MASK = 0x5412;
    let d = data << 10;
    while (bchDigit(d) - bchDigit(G15) >= 0) d ^= (G15 << (bchDigit(d) - bchDigit(G15)));
    return ((data << 10) | d) ^ G15_MASK;
  }
  function bchTypeNumber(data) {
    const G18 = 0x1F25;
    let d = data << 12;
    while (bchDigit(d) - bchDigit(G18) >= 0) d ^= (G18 << (bchDigit(d) - bchDigit(G18)));
    return (data << 12) | d;
  }

  // test=true のとき形式情報・型番情報・暗モジュールを全部「白」で置く (Python qrcode のマスク評価と同じ)
  function placeTypeInfo(m, test, mask) {
    const n = m.length;
    const bits = bchTypeInfo((EC_M_BITS << 3) | mask);
    for (let i = 0; i < 15; i++) {
      const mod = (!test && ((bits >> i) & 1) === 1) ? 1 : 0;
      if (i < 6) m[i][8] = mod;
      else if (i < 8) m[i + 1][8] = mod;
      else m[n - 15 + i][8] = mod;
    }
    for (let i = 0; i < 15; i++) {
      const mod = (!test && ((bits >> i) & 1) === 1) ? 1 : 0;
      if (i < 8) m[8][n - i - 1] = mod;
      else if (i < 9) m[8][15 - i - 1 + 1] = mod;
      else m[8][15 - i - 1] = mod;
    }
    m[n - 8][8] = test ? 0 : 1;
  }
  function placeTypeNumber(m, test, v) {
    const n = m.length;
    const bits = bchTypeNumber(v);
    for (let i = 0; i < 18; i++) {
      const mod = (!test && ((bits >> i) & 1) === 1) ? 1 : 0;
      m[Math.floor(i / 3)][i % 3 + n - 8 - 3] = mod;
      m[i % 3 + n - 8 - 3][Math.floor(i / 3)] = mod;
    }
  }

  const MASKS = [
    (i, j) => (i + j) % 2 === 0,
    (i, j) => i % 2 === 0,
    (i, j) => j % 3 === 0,
    (i, j) => (i + j) % 3 === 0,
    (i, j) => (Math.floor(i / 2) + Math.floor(j / 3)) % 2 === 0,
    (i, j) => (i * j) % 2 + (i * j) % 3 === 0,
    (i, j) => ((i * j) % 2 + (i * j) % 3) % 2 === 0,
    (i, j) => ((i * j) % 3 + (i + j) % 2) % 2 === 0
  ];

  function mapData(m, data, mask) {
    const n = m.length;
    const fn = MASKS[mask];
    let inc = -1, row = n - 1, bitIndex = 7, byteIndex = 0;
    for (let col0 = n - 1; col0 > 0; col0 -= 2) {
      let col = col0;
      if (col <= 6) col -= 1;
      for (;;) {
        for (let k = 0; k < 2; k++) {
          const c = col - k;
          if (m[row][c] === null) {
            let dark = false;
            if (byteIndex < data.length) dark = ((data[byteIndex] >>> bitIndex) & 1) === 1;
            if (fn(row, c)) dark = !dark;
            m[row][c] = dark ? 1 : 0;
            bitIndex--;
            if (bitIndex === -1) { byteIndex++; bitIndex = 7; }
          }
        }
        row += inc;
        if (row < 0 || row >= n) { row -= inc; inc = -inc; break; }
      }
    }
  }

  function makeImpl(v, data, test, mask) {
    const m = blank(v);
    placeTypeInfo(m, test, mask);
    if (v >= 7) placeTypeNumber(m, test, v);
    mapData(m, data, mask);
    return m;
  }

  // ---- 減点 (N1〜N4) ----
  function penalty(m) {
    const n = m.length;
    let p = 0;
    // N1: 同色が5個以上続く (行・列) → 3 + (長さ-5)
    for (let r = 0; r < n; r++) {
      let prev = m[r][0], len = 0;
      for (let c = 0; c < n; c++) {
        if (m[r][c] === prev) len++;
        else { if (len >= 5) p += len - 2; len = 1; prev = m[r][c]; }
      }
      if (len >= 5) p += len - 2;
    }
    for (let c = 0; c < n; c++) {
      let prev = m[0][c], len = 0;
      for (let r = 0; r < n; r++) {
        if (m[r][c] === prev) len++;
        else { if (len >= 5) p += len - 2; len = 1; prev = m[r][c]; }
      }
      if (len >= 5) p += len - 2;
    }
    // N2: 2×2 の同色 → 3
    for (let r = 0; r < n - 1; r++) {
      for (let c = 0; c < n - 1; c++) {
        const v = m[r][c];
        if (v === m[r][c + 1] && v === m[r + 1][c] && v === m[r + 1][c + 1]) p += 3;
      }
    }
    // N3: 1:1:3:1:1 + 4 白 (10111010000 / 00001011101) → 40
    const isPat = (g) => !g(1) && g(4) && !g(5) && g(6) && !g(9) &&
      ((g(0) && g(2) && g(3) && !g(7) && !g(8) && !g(10)) ||
       (!g(0) && !g(2) && !g(3) && g(7) && g(8) && g(10)));
    for (let r = 0; r < n; r++) {
      for (let c = 0; c < n - 10; c++) if (isPat(k => m[r][c + k] === 1)) p += 40;
    }
    for (let c = 0; c < n; c++) {
      for (let r = 0; r < n - 10; r++) if (isPat(k => m[r + k][c] === 1)) p += 40;
    }
    // N4: 黒の割合が 50% から 5% 離れるごとに 10
    let dark = 0;
    for (let r = 0; r < n; r++) for (let c = 0; c < n; c++) dark += m[r][c];
    const percent = dark / (n * n);
    p += Math.floor(Math.abs(percent * 100 - 50) / 5) * 10;
    return p;
  }

  function encode(text) {
    const bytes = utf8(text);
    const v = chooseVersion(bytes.length);
    const data = buildCodewords(bytes, v);
    let best = 0, bestP = 0;
    for (let mask = 0; mask < 8; mask++) {
      const p = penalty(makeImpl(v, data, true, mask));
      if (mask === 0 || bestP > p) { bestP = p; best = mask; }
    }
    return { version: v, mask: best, modules: makeImpl(v, data, false, best) };
  }

  function matrix(text) { return encode(text).modules; }
  function version(text) { return chooseVersion(utf8(text).length); }

  /**
   * SVG 文字列 (黒の矩形だけ・横に続く黒は1つの矩形にまとめる)
   * @param {string} text
   * @param {{sizeMm?:number, margin?:number}} opt sizeMm=余白込みの一辺(mm・既定 28) / margin=余白のマス数(既定 4)
   */
  function svg(text, opt) {
    opt = opt || {};
    const sizeMm = (opt.sizeMm > 0) ? opt.sizeMm : 28;
    const margin = (opt.margin >= 0) ? Math.floor(opt.margin) : 4;
    const m = matrix(text);
    const n = m.length;
    const w = n + margin * 2;
    const rects = [];
    for (let r = 0; r < n; r++) {
      let c = 0;
      while (c < n) {
        if (m[r][c] !== 1) { c++; continue; }
        let e = c;
        while (e < n && m[r][e] === 1) e++;
        rects.push('<rect x="' + (c + margin) + '" y="' + (r + margin) + '" width="' + (e - c) + '" height="1"/>');
        c = e;
      }
    }
    return '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ' + w + ' ' + w + '" width="' + sizeMm + 'mm" height="' + sizeMm + 'mm"' +
      ' shape-rendering="crispEdges" style="display:block;-webkit-print-color-adjust:exact;print-color-adjust:exact;">' +
      '<g fill="#000">' + rects.join('') + '</g></svg>';
  }

  return { matrix: matrix, svg: svg, version: version, _encode: encode, _penalty: penalty };
})();

if (typeof module !== 'undefined' && module.exports) module.exports = QR;
