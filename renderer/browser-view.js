// 内蔵ブラウザ（タスクの開発サーバーのプレビュー）と、デザインモード（画面の部品をクリックして、その HTML・CSS・スクリーンショットをエージェントに渡す）
//
// 詳細パネルの「ブラウザ」タブ。タスクごとのポート（WORKTREE_KANBAN_PORT）の http://localhost:<port>/ を <webview> で開く。
// 上の「+」でタブを増やし、いくつものページを開ける。<webview> はタブごとに1つ作り、見ていないタブのものは隠すだけにする
// （作り直すと読み込み直しになるので、#browserPane に置いたままにし、詳細パネルのタブやブラウザのタブを切り替えても残す）。
// タブはタスクごとに覚えておき（アプリを開いているあいだだけ）、別のタスクを開くとそのタスクのタブに入れ替える。
// デザインモードでは、ページに小さなスクリプト（PICK_SCRIPT）を入れて、マウスの下の部品を枠で示し、クリックした部品の情報を
// console に印付きの JSON で書いてもらう（<webview> の console-message で受け取る）。スクリーンショットは capturePage で撮る。
// 「ペン」では、ページの上に線を描いて囲んだ範囲と、その中にある部品の HTML を同じように受け取り、線ごとスクリーンショットを撮る。
//
// 境界: window.BrowserView = {
//   init(deps)          renderer.js の部品（api・icon・esc・toast・run・canSendFollow・viewingHost）を受け取る
//   show(on)            タブを開いた・閉じた（ペインの表示と、詳細パネルを広げるかを切り替える）
//   render(c)           タブを描く（カードが変わったときだけ URL を開き直す）
//   update(c)           カードの状態が変わった（送れるかどうかの表示だけを直す）
// }
// テストからは純粋な関数（previewUrl・normalizeUrl・buildPickMessage・parsePickMessage・captureRect・tabLabel・PICK_SCRIPT）を使う
(function (root, factory) {
  const api = factory(root);
  if (typeof module === 'object' && module.exports) module.exports = api;
  else root.BrowserView = api;
})(typeof self !== 'undefined' ? self : this, function (root) {
  const i18n = typeof module === 'object' && module.exports ? require('./i18n.js') : root.I18n;
  function tr(key, vars) {
    if (i18n) return i18n.tr(key, vars);
    return vars ? String(key).replace(/\{(\w+)\}/g, (m, k) => (k in vars ? String(vars[k]) : m)) : key;
  }

  // <webview> のセッション。アプリの画面とは分け、ログインなどはアプリを再起動しても残す（main.js でも同じ名前で縛る）
  const PARTITION = 'persist:worktree-kanban-preview';
  const PICK_MARK = '__worktree_kanban_pick__:';
  const MAX_PICKS = 5;
  const MAX_HTML = 6000; // メッセージに入れる HTML の長さ（長いものは切る）
  const SHOT_PAD = 16; // スクリーンショットは部品のまわりも少し入れる
  const RETRY_MS = 3000;
  const MAX_RETRIES = 60; // 開発サーバーが立ち上がるのを、3秒ごとに3分まで待つ
  const MAX_TABS = 10; // 1つのタスクで開けるタブの数（<webview> はタブごとに作るので、増やしすぎない）

  // ---------------- 純粋な関数 ----------------

  function previewUrl(port) {
    const n = Number(port);
    return Number.isInteger(n) && n > 0 && n < 65536 ? `http://localhost:${n}/` : '';
  }

  // アドレス欄の入力を URL にする。ポート番号だけ・localhost:3000/x・ホスト名だけ でもよい。http(s) 以外は開かない
  function normalizeUrl(input) {
    let s = String(input || '').trim();
    if (!s) return '';
    if (/^\d{1,5}$/.test(s)) return previewUrl(s);
    if (/^:\d{1,5}(\/.*)?$/.test(s)) s = `localhost${s}`;
    if (!/^[a-z][a-z0-9+.-]*:\/\//i.test(s)) {
      if (/^[a-z][a-z0-9+.-]*:/i.test(s) && !/^[^/:]+:\d/.test(s)) return ''; // javascript: / file: などのスキーム
      s = `http://${s}`;
    }
    try {
      const u = new URL(s);
      return u.protocol === 'http:' || u.protocol === 'https:' ? u.href : '';
    } catch {
      return '';
    }
  }

  // console に書かれた1行から、デザインモードで選んだ部品を取り出す（印がなければ null）
  function parsePickMessage(message) {
    const s = String(message || '');
    if (!s.startsWith(PICK_MARK)) return null;
    try {
      const v = JSON.parse(s.slice(PICK_MARK.length));
      return v && typeof v === 'object' ? v : null;
    } catch {
      return null;
    }
  }

  // スクリーンショットを撮る範囲（部品のまわりを少し広げ、見えている画面の中に収める）。撮れないときは null（画面全体を撮る）
  function captureRect(rect, viewport, pad = SHOT_PAD) {
    if (!rect || !viewport) return null;
    const vw = Math.floor(Number(viewport.width) || 0);
    const vh = Math.floor(Number(viewport.height) || 0);
    const x0 = Math.max(0, Math.floor(rect.x - pad));
    const y0 = Math.max(0, Math.floor(rect.y - pad));
    const x1 = Math.min(vw, Math.ceil(rect.x + rect.width + pad));
    const y1 = Math.min(vh, Math.ceil(rect.y + rect.height + pad));
    if (!(vw > 0 && vh > 0) || x1 - x0 < 4 || y1 - y0 < 4) return null;
    return { x: x0, y: y0, width: x1 - x0, height: y1 - y0 };
  }

  function fence(lang, text) {
    const body = String(text || '');
    const ticks = body.includes('```') ? '````' : '```';
    return `${ticks}${lang}\n${body}\n${ticks}`;
  }

  function clip(s, n) {
    const t = String(s || '');
    return t.length > n ? `${t.slice(0, n)}\n<!-- ${tr('（長いので、ここまでにしました）')} -->` : t;
  }

  function rectLine(p) {
    const r = p.rect || {};
    return `- ${tr('位置と大きさ')}: x=${Math.round(r.x || 0)}, y=${Math.round(r.y || 0)}, ${Math.round(r.width || 0)}×${Math.round(r.height || 0)}px（${tr('画面の幅 {w}px', { w: Math.round((p.viewport && p.viewport.width) || 0) })}）`;
  }

  // ペンで囲んだ範囲: 範囲と、その中にある部品の HTML
  function areaSection(p, shotName, i) {
    const lines = [`### ${i + 1}. ${tr('ペンで囲んだ範囲')}`];
    if (p.url) lines.push(`- ${tr('ページ')}: ${p.url}`);
    lines.push(rectLine(p));
    if (shotName) lines.push(`- ${tr('スクリーンショット')}: ${shotName}（${tr('赤い線で囲んだところ')}）`);
    if (p.text) lines.push(`- ${tr('文字')}: ${String(p.text).replace(/\s+/g, ' ').trim()}`);
    const els = (p.elements || []).filter((x) => x && (x.selector || x.tag));
    if (els.length) {
      lines.push('', `${tr('囲んだ中にある部品')}:`);
      for (const x of els) lines.push(`- \`${String(x.selector || x.tag).replace(/`/g, "'")}\``);
      if (p.more > 0) lines.push(`- ${tr('ほか {n} 個', { n: p.more })}`);
      const html = els.filter((x) => x.html).map((x) => x.html).join('\n\n');
      if (html) lines.push('', 'HTML:', fence('html', clip(html, MAX_HTML)));
    }
    return lines.join('\n');
  }

  /**
   * エージェントに送るメッセージを作る
   * @param {string} text  ユーザーが書いた指示
   * @param {{ pick: object, shotName?: string }[]} picks  選んだ部品と、添付したスクリーンショットの名前
   */
  function buildPickMessage(text, picks) {
    const parts = [String(text || '').trim()];
    const list = (picks || []).filter((p) => p && p.pick);
    if (!list.length) return parts[0];
    parts.push(`## ${tr('内蔵ブラウザで選んだ画面の部品')}`);
    list.forEach(({ pick: p, shotName }, i) => {
      if (p.kind === 'area') {
        parts.push(areaSection(p, shotName, i));
        return;
      }
      const lines = [`### ${i + 1}. \`${String(p.selector || p.tag || '?').replace(/`/g, "'")}\``];
      if (p.url) lines.push(`- ${tr('ページ')}: ${p.url}`);
      lines.push(rectLine(p));
      if (shotName) lines.push(`- ${tr('スクリーンショット')}: ${shotName}`);
      if (p.text) lines.push(`- ${tr('文字')}: ${String(p.text).replace(/\s+/g, ' ').trim()}`);
      if (p.html) lines.push('', `HTML:`, fence('html', clip(p.html, MAX_HTML)));
      if (p.rules && p.rules.length) {
        const css = p.rules.map((x) => (x.source ? `/* ${x.source} */\n${x.css}` : x.css)).join('\n\n');
        lines.push('', `${tr('当たっている CSS のルール')}:`, fence('css', css));
      }
      if (p.styles && Object.keys(p.styles).length) {
        const css = Object.entries(p.styles).map(([k, v]) => `${k}: ${v};`).join('\n');
        lines.push('', `${tr('計算されたスタイル（主なもの）')}:`, fence('css', css));
      }
      parts.push(lines.join('\n'));
    });
    return parts.filter(Boolean).join('\n\n');
  }

  // ページに入れるスクリプト。何度入れても1つだけ動く。start / stop で切り替える。
  // クリックはページに渡さない（リンクやボタンが動かないように）。Esc でやめる
  const PICK_SCRIPT = `(() => {
  const MARK = ${JSON.stringify(PICK_MARK)};
  const g = window;
  if (g.__wkDesign) return g.__wkDesign;
  const PROPS = ['display','position','top','right','bottom','left','z-index','box-sizing','width','height','min-width','max-width','min-height','max-height','margin','padding','border','border-radius','outline','color','background-color','background-image','opacity','box-shadow','font-family','font-size','font-weight','font-style','line-height','letter-spacing','text-align','text-decoration','text-transform','white-space','overflow','gap','flex-direction','flex-wrap','justify-content','align-items','flex','grid-template-columns','grid-template-rows','transform','transition','cursor'];
  const KEEP = new Set(['display','position','width','height','color','font-size','font-family']);
  const EMPTY = new Set(['none','normal','auto','0px','0','rgba(0, 0, 0, 0)','static','visible','0s','start','stretch','0px none','0px none rgb(0, 0, 0)','1','nowrap normal','row','nowrap','0 1 auto','all','all 0s ease 0s','default','auto auto']);
  let box = null, label = null, on = false, cur = null, tool = 'pick';
  let ink = null, pen = null, drawing = false, pts = [];
  const ensure = () => {
    if (box && box.isConnected) return;
    box = document.createElement('div');
    box.setAttribute('data-worktree-kanban', '');
    box.style.cssText = 'position:fixed;pointer-events:none;z-index:2147483647;border:2px solid #4f8cff;background:rgba(79,140,255,.15);border-radius:2px;display:none;box-sizing:border-box';
    label = document.createElement('div');
    label.style.cssText = 'position:absolute;left:-2px;bottom:100%;margin-bottom:2px;background:#4f8cff;color:#fff;font:11px/1.6 ui-monospace,Menlo,monospace;padding:0 5px;border-radius:3px;white-space:nowrap;max-width:60vw;overflow:hidden;text-overflow:ellipsis';
    box.appendChild(label);
    (document.body || document.documentElement).appendChild(box);
  };
  const ours = (el) => el && el.closest && el.closest('[data-worktree-kanban]');
  const cssEsc = (s) => (window.CSS && CSS.escape ? CSS.escape(s) : String(s).replace(/[^a-zA-Z0-9_-]/g, '\\\\$&'));
  const part = (el) => {
    let s = el.tagName.toLowerCase();
    const cls = Array.from(el.classList || []).filter((c) => !/^(hover|focus|active)/.test(c)).slice(0, 2);
    if (cls.length) s += cls.map((c) => '.' + cssEsc(c)).join('');
    const p = el.parentElement;
    if (p) {
      const same = Array.from(p.children).filter((x) => x.tagName === el.tagName);
      if (same.length > 1) s += ':nth-of-type(' + (same.indexOf(el) + 1) + ')';
    }
    return s;
  };
  const selector = (el) => {
    const out = [];
    for (let e = el; e && e.nodeType === 1 && out.length < 6; e = e.parentElement) {
      if (e.id && document.querySelectorAll('#' + cssEsc(e.id)).length === 1) { out.unshift('#' + cssEsc(e.id)); break; }
      out.unshift(part(e));
      if (e === document.body) break;
    }
    return out.join(' > ');
  };
  const rulesOf = (el) => {
    const out = [];
    const walk = (rules, href) => {
      for (const r of Array.from(rules || [])) {
        if (out.length >= 20) return;
        if (r.selectorText) {
          let hit = false;
          try { hit = el.matches(r.selectorText); } catch (e) { hit = false; }
          if (hit) out.push({ css: r.cssText.length > 800 ? r.cssText.slice(0, 800) + ' …' : r.cssText, source: href });
        }
        if (r.cssRules && !r.selectorText) {
          const cond = r.conditionText || r.media && r.media.mediaText || r.name || '';
          if (r.media && window.matchMedia && cond && !matchMedia(cond).matches) continue;
          walk(r.cssRules, href);
        }
      }
    };
    for (const sheet of Array.from(document.styleSheets)) {
      let rules = null;
      try { rules = sheet.cssRules; } catch (e) { continue; } // 別のオリジンの CSS は読めない
      walk(rules, sheet.href ? sheet.href.replace(location.origin, '') : '<style>');
    }
    return out;
  };
  const stylesOf = (el) => {
    const cs = getComputedStyle(el);
    const out = {};
    for (const k of PROPS) {
      const v = cs.getPropertyValue(k);
      if (!v || (!KEEP.has(k) && EMPTY.has(v.trim()))) continue;
      if ((k === 'outline' || k === 'border') && / none\\b/.test(v)) continue;
      out[k] = v.trim();
    }
    return out;
  };
  const show = (el) => {
    ensure();
    const r = el.getBoundingClientRect();
    box.style.display = 'block';
    box.style.left = r.left + 'px';
    box.style.top = r.top + 'px';
    box.style.width = r.width + 'px';
    box.style.height = r.height + 'px';
    label.textContent = part(el) + '  ' + Math.round(r.width) + '×' + Math.round(r.height);
    label.style.bottom = r.top < 20 ? 'auto' : '100%';
    label.style.top = r.top < 20 ? '100%' : 'auto';
  };
  const hide = () => { if (box) box.style.display = 'none'; };
  // ペン: 画面いっぱいの透明な canvas に線を描く（クリックは受けない）。線はスクリーンショットを撮るまで残す
  const clearInk = () => { if (ink) ink.remove(); ink = null; pen = null; drawing = false; pts = []; };
  const ensureInk = () => {
    if (ink && ink.isConnected) return;
    const dpr = devicePixelRatio || 1;
    ink = document.createElement('canvas');
    ink.setAttribute('data-worktree-kanban', '');
    ink.width = Math.round(innerWidth * dpr);
    ink.height = Math.round(innerHeight * dpr);
    ink.style.cssText = 'position:fixed;left:0;top:0;width:' + innerWidth + 'px;height:' + innerHeight + 'px;pointer-events:none;z-index:2147483647';
    (document.body || document.documentElement).appendChild(ink);
    pen = ink.getContext('2d');
    pen.scale(dpr, dpr);
    pen.strokeStyle = '#ff3b30';
    pen.lineWidth = 3;
    pen.lineCap = 'round';
    pen.lineJoin = 'round';
  };
  const inPoly = (x, y) => {
    let hit = false;
    for (let i = 0, j = pts.length - 1; i < pts.length; j = i++) {
      const [xi, yi] = pts[i], [xj, yj] = pts[j];
      if ((yi > y) !== (yj > y) && x < ((xj - xi) * (y - yi)) / (yj - yi) + xi) hit = !hit;
    }
    return hit;
  };
  const SKIP = new Set(['script', 'style', 'link', 'meta', 'noscript', 'template', 'br', 'html', 'body', 'head', 'title']);
  // 囲んだ中にある部品（大部分が囲みの中に入っているもの。親が入っていれば子は入れない）
  const enclosed = (b) => {
    const found = [];
    if (!document.body) return found;
    for (const el of Array.from(document.body.getElementsByTagName('*'))) {
      if (found.length >= 50) break;
      const tag = el.tagName.toLowerCase();
      if (SKIP.has(tag) || ours(el)) continue;
      let r = el.getBoundingClientRect();
      if (r.width < 2 || r.height < 2 || r.right <= b.x || r.left >= b.x + b.width || r.bottom <= b.y || r.top >= b.y + b.height) continue;
      // 横いっぱいに広がるブロックでも、文字や中身が実際にあるところで判断する
      try {
        const range = document.createRange();
        range.selectNodeContents(el);
        const c = range.getBoundingClientRect();
        if (c.width >= 2 && c.height >= 2 && c.width * c.height < r.width * r.height) r = c;
      } catch (e) { /* そのまま */ }
      const ox = Math.min(r.right, b.x + b.width) - Math.max(r.left, b.x);
      const oy = Math.min(r.bottom, b.y + b.height) - Math.max(r.top, b.y);
      if (ox <= 0 || oy <= 0 || (ox * oy) / (r.width * r.height) < 0.6) continue;
      if (!inPoly(r.left + r.width / 2, r.top + r.height / 2)) continue;
      if (el.checkVisibility && !el.checkVisibility({ opacityProperty: true, visibilityProperty: true })) continue;
      if (found.some((f) => f.contains(el))) continue;
      found.push(el);
    }
    if (!found.length) {
      // 部品の一部だけを囲んだ: 囲みの真ん中にある部品を渡す
      const hits = document.elementsFromPoint ? document.elementsFromPoint(b.x + b.width / 2, b.y + b.height / 2) : [];
      const el = hits.find((x) => !ours(x) && !SKIP.has(x.tagName.toLowerCase()));
      if (el) found.push(el);
    }
    return found;
  };
  const finishInk = () => {
    if (!drawing) return;
    drawing = false;
    const xs = pts.map((p) => p[0]), ys = pts.map((p) => p[1]);
    const b = { x: Math.min(...xs), y: Math.min(...ys) };
    b.width = Math.max(...xs) - b.x;
    b.height = Math.max(...ys) - b.y;
    if (pts.length < 3 || (b.width < 8 && b.height < 8)) { clearInk(); return; }
    // 線を閉じる（どこを囲んだかがスクリーンショットで分かるように）
    pen.lineTo(pts[0][0], pts[0][1]);
    pen.stroke();
    const found = enclosed(b);
    const MAXEL = 8;
    const info = {
      kind: 'area',
      url: location.href,
      title: document.title,
      rect: b,
      viewport: { width: innerWidth, height: innerHeight },
      dpr: devicePixelRatio,
      text: found.map((el) => (el.innerText || el.textContent || '').trim()).filter(Boolean).join('\\n').slice(0, 300),
      elements: found.slice(0, MAXEL).map((el) => {
        const html = el.outerHTML || '';
        return { tag: el.tagName.toLowerCase(), selector: selector(el), text: (el.innerText || el.textContent || '').trim().slice(0, 120), html: html.length > 4000 ? html.slice(0, 4000) : html };
      }),
      more: Math.max(0, found.length - MAXEL),
    };
    requestAnimationFrame(() => requestAnimationFrame(() => console.log(MARK + JSON.stringify(info))));
  };
  const onDown = (e) => {
    block(e);
    if (tool !== 'pen' || e.button !== 0) return;
    clearInk();
    ensureInk();
    drawing = true;
    pts = [[e.clientX, e.clientY]];
    pen.beginPath();
    pen.moveTo(e.clientX, e.clientY);
  };
  const onDraw = (e) => {
    if (!drawing) return;
    if (!(e.buttons & 1)) return finishInk(); // 画面の外でボタンを離した
    const [lx, ly] = pts[pts.length - 1];
    if (Math.hypot(e.clientX - lx, e.clientY - ly) < 2) return;
    pts.push([e.clientX, e.clientY]);
    pen.lineTo(e.clientX, e.clientY);
    pen.stroke();
  };
  const onUp = (e) => {
    block(e);
    finishInk();
  };
  const onMove = (e) => {
    if (tool === 'pen') return;
    const el = e.target;
    if (!el || el.nodeType !== 1 || ours(el)) return;
    cur = el;
    show(el);
  };
  const block = (e) => { if (on) { e.preventDefault(); e.stopPropagation(); e.stopImmediatePropagation(); } };
  const onClick = (e) => {
    block(e);
    if (tool === 'pen') return;
    const el = cur && cur.isConnected ? cur : e.target;
    if (!el || el.nodeType !== 1 || ours(el)) return;
    const r = el.getBoundingClientRect();
    const html = el.outerHTML || '';
    const info = {
      url: location.href,
      title: document.title,
      tag: el.tagName.toLowerCase(),
      selector: selector(el),
      text: (el.innerText || el.textContent || '').trim().slice(0, 300),
      html: html.length > 20000 ? html.slice(0, 20000) : html,
      rect: { x: r.left, y: r.top, width: r.width, height: r.height },
      viewport: { width: innerWidth, height: innerHeight },
      dpr: devicePixelRatio,
      styles: stylesOf(el),
      rules: rulesOf(el),
    };
    hide(); // 枠を消してから知らせる（スクリーンショットに枠が写らないように）
    requestAnimationFrame(() => requestAnimationFrame(() => console.log(MARK + JSON.stringify(info))));
  };
  const onKey = (e) => {
    if (e.key !== 'Escape') return;
    block(e);
    clearInk();
    console.log(MARK + JSON.stringify({ cancel: true }));
  };
  const EVENTS = [['mousemove', onMove], ['mouseover', onMove], ['click', onClick], ['mousedown', block], ['mouseup', block], ['pointerdown', onDown], ['pointermove', onDraw], ['pointerup', onUp], ['dblclick', block], ['auxclick', block], ['contextmenu', block], ['selectstart', block], ['dragstart', block], ['keydown', onKey]];
  const api = {
    // t: 'pick'（クリックで部品を選ぶ）か 'pen'（ペンで囲む）。動いているときに呼ぶと、道具だけを切り替える
    start(t) { tool = t === 'pen' ? 'pen' : 'pick'; if (tool === 'pen') { hide(); cur = null; } else clearInk(); if (on) return; on = true; for (const [t, f] of EVENTS) addEventListener(t, f, true); document.documentElement.style.cursor = 'crosshair'; },
    stop() { clearInk(); if (!on) return; on = false; for (const [t, f] of EVENTS) removeEventListener(t, f, true); hide(); cur = null; document.documentElement.style.cursor = ''; },
    clearInk,
    get on() { return on; },
    get tool() { return tool; },
  };
  g.__wkDesign = api;
  return api;
})()`;

  // タブに出す名前: ページのタイトル → ホスト名と道筋 → 「新しいタブ」
  function tabLabel(tab) {
    const title = String((tab && tab.title) || '').trim();
    if (title) return title;
    const url = String((tab && tab.url) || '');
    if (url && url !== 'about:blank') {
      try {
        const u = new URL(url);
        const rest = `${u.pathname === '/' ? '' : u.pathname}${u.search}`;
        return `${u.host}${rest}`;
      } catch {
        return url;
      }
    }
    return tr('新しいタブ');
  }

  // ---------------- 画面 ----------------

  // タブ1つ: { id, url, title, failed（読み込めなかったときの { code, desc, url }）, retries, retryTimer, loading, el（<webview>） }
  // <webview> はタブごとに1つ作り、見えていないタブのものは隠すだけにする（切り替えても読み込み直さない）
  let d = null; // renderer.js から受け取る部品
  let tabSeq = 0;
  const st = {
    cardId: null,
    tabs: [], // 今のタスクのタブ
    active: '', // 見ているタブの id
    saved: new Map(), // カード ID → { tabs: [{ url, title }], active }（アプリを開いているあいだだけ）
    port: null,
    scripts: null, // api.scripts の結果
    scriptsFor: '', // どのカードのどの状態で読んだか
    design: false,
    tool: 'pick', // デザインモードの道具: 'pick'（クリックで部品を選ぶ）・'pen'（ペンで囲む）
    picks: [], // { pick, shot (data URL), name }
    visible: false,
    full: false, // 画面に大きく表示しているか（差分タブの大きな表示と同じ。タスクやタブを変えると戻す）
    built: false,
  };
  const $ = (id) => document.getElementById(id);
  const pane = () => $('browserPane');
  const cur = () => st.tabs.find((t) => t.id === st.active) || null;
  const curUrl = () => (cur() ? cur().url : '');
  const view = () => (cur() ? cur().el : null);
  const isActive = (t) => !!t && t.id === st.active;

  function init(deps) {
    d = deps;
    // Esc は、大きな表示を閉じるだけにする（詳細パネルは閉じない）。デザインモード中はデザインモードを先にやめる
    document.addEventListener(
      'keydown',
      (ev) => {
        if (ev.key !== 'Escape' || !st.full || document.querySelector('.img-overlay')) return;
        const modal = $('modal');
        if (modal && !modal.classList.contains('hidden')) return;
        if (st.design) setDesign(false);
        else setFull(false);
        ev.stopImmediatePropagation();
      },
      true,
    );
  }

  function cardLive(c) {
    return !!c && (c.status === 'running' || c.status === 'queued');
  }

  // 送り先と、送れるかどうか
  function sendMode(c) {
    if (!c) return { ok: false, hint: '' };
    if (d.canSendFollow(c)) return { ok: true, kind: 'send', hint: tr('追加の指示として、スクリーンショットと一緒に送ります') };
    if (cardLive(c)) return { ok: true, kind: 'btw', hint: tr('実行中なので btw として送ります（スクリーンショットは送れず、HTML と CSS だけを送ります）') };
    if (c.status === 'todo') return { ok: false, hint: tr('開始すると、終わったあとに送れるようになります') };
    return { ok: false, hint: tr('今は送れません') };
  }

  function build() {
    if (st.built) return;
    st.built = true;
    const p = pane();
    p.innerHTML = `
      <div class="bv-tabs">
        <div id="browserTabs" class="bv-tab-list" role="tablist"></div>
        <button type="button" class="icon bv-nav bv-tab-add" data-bv="newTab" title="${d.esc(tr('新しいタブを開く'))}" aria-label="${d.esc(tr('新しいタブを開く'))}">${d.icon('plus')}</button>
      </div>
      <div class="bv-bar">
        <button type="button" class="icon bv-nav" data-bv="back" title="${d.esc(tr('前のページに戻る'))}">${d.icon('arrowLeft')}</button>
        <button type="button" class="icon bv-nav" data-bv="forward" title="${d.esc(tr('次のページに進む'))}">${d.icon('arrowRight')}</button>
        <button type="button" class="icon bv-nav" data-bv="reload" title="${d.esc(tr('読み込み直す'))}">${d.icon('refresh')}</button>
        <input id="browserUrl" class="bv-url mono" spellcheck="false" autocomplete="off" placeholder="http://localhost:3000/" />
        <button type="button" class="btn small bv-design" data-bv="design" title="${d.esc(tr('画面の部品をクリックすると、その HTML・CSS とスクリーンショットをエージェントに渡せます（Esc でやめます）'))}">${d.icon('crosshair')}${d.esc(tr('デザインモード'))}</button>
        <button type="button" class="btn small bv-design" data-bv="pen" title="${d.esc(tr('画面をペンで囲むと、囲んだところのスクリーンショットと HTML をエージェントに渡せます（Esc でやめます）'))}">${d.icon('pen')}${d.esc(tr('ペン'))}</button>
        <button type="button" class="icon bv-nav" data-bv="full" title="${d.esc(tr('画面に大きく表示します'))}">${d.icon('maximize')}</button>
        <button type="button" class="icon bv-nav" data-bv="external" title="${d.esc(tr('いつものブラウザで開く'))}">${d.icon('external')}</button>
      </div>
      <div id="browserServer" class="bv-server muted small"></div>
      <div class="bv-stage" id="browserStage">
        <div id="browserNote" class="bv-note hidden"></div>
      </div>
      <div id="browserPicks" class="bv-picks hidden"></div>`;
    p.querySelectorAll('[data-bv]').forEach((b) => (b.onclick = () => onAction(b.dataset.bv)));
    const url = $('browserUrl');
    url.addEventListener('keydown', (e) => {
      if (e.key !== 'Enter' || e.isComposing) return;
      e.preventDefault();
      const u = normalizeUrl(url.value);
      if (!u) return d.toast(tr('開けない URL です'));
      navigate(u);
    });
    const list = $('browserTabs');
    list.addEventListener('click', (e) => {
      const x = e.target.closest('[data-tab-close]');
      if (x) {
        e.stopPropagation();
        closeTab(x.dataset.tabClose);
        return;
      }
      const t = e.target.closest('[data-tab]');
      if (t) activate(t.dataset.tab);
    });
    // 真ん中のボタンで閉じる（ふつうのブラウザと同じ）
    list.addEventListener('auxclick', (e) => {
      const t = e.button === 1 && e.target.closest('[data-tab]');
      if (!t) return;
      e.preventDefault();
      closeTab(t.dataset.tab);
    });
  }

  // タブを1つ作る（<webview> も作る）。まだ見せない
  function createTab(url, title) {
    const t = { id: `bt${++tabSeq}`, url: url || '', title: title || '', failed: null, retries: 0, retryTimer: null, loading: false, el: null };
    const stage = $('browserStage');
    const src = t.url || 'about:blank';
    stage.insertAdjacentHTML('afterbegin', `<webview class="bv-view bv-hidden" data-tab-view="${t.id}" partition="${PARTITION}" src="${d.esc(src)}" webpreferences="contextIsolation=yes, sandbox=yes"></webview>`);
    const w = stage.querySelector(`[data-tab-view="${t.id}"]`);
    t.el = w;
    w.addEventListener('did-navigate', (e) => onNavigated(t, e.url));
    w.addEventListener('did-navigate-in-page', (e) => e.isMainFrame && onNavigated(t, e.url));
    w.addEventListener('page-title-updated', (e) => {
      t.title = e.title || '';
      drawTabs();
    });
    w.addEventListener('did-start-loading', () => {
      t.loading = true;
      if (isActive(t)) drawBar();
    });
    w.addEventListener('did-stop-loading', () => {
      t.loading = false;
      if (isActive(t)) drawBar();
    });
    w.addEventListener('did-fail-load', (e) => {
      // -3 は読み込みの中断（次の移動が始まった）なので、失敗にしない
      if (!e.isMainFrame || e.errorCode === -3) return;
      t.failed = { code: e.errorCode, desc: e.errorDescription || '', url: e.validatedURL || t.url };
      if (isActive(t)) drawNote();
      scheduleRetry(t);
    });
    w.addEventListener('dom-ready', () => {
      // 読み込みに失敗したときのエラーの画面でも dom-ready は来るので、そのときは入れない
      if (isActive(t) && st.design && !t.failed && w.getURL() !== 'about:blank') inject(true);
    });
    w.addEventListener('console-message', (e) => {
      const pick = parsePickMessage(e.message);
      if (pick && isActive(t)) onPick(pick);
    });
    st.tabs.push(t);
    return t;
  }

  function dropTab(t) {
    clearTimeout(t.retryTimer);
    if (t.el) t.el.remove();
    t.el = null;
  }

  // 見るタブを変える。デザインモードは、見ているタブのページにだけ入れる
  function activate(id) {
    const next = st.tabs.find((t) => t.id === id);
    if (!next) return;
    const prev = cur();
    if (prev && prev !== next) {
      if (st.design) inject(false);
      clearTimeout(prev.retryTimer);
    }
    st.active = next.id;
    for (const t of st.tabs) if (t.el) t.el.classList.toggle('bv-hidden', t !== next);
    const input = $('browserUrl');
    if (input) input.value = next.url;
    if (st.design) {
      if (next.url) inject(true);
      else setDesign(false);
    }
    if (next.failed) scheduleRetry(next);
    drawTabs();
    drawBar();
    drawNote();
  }

  function newTab() {
    if (!st.cardId) return;
    if (st.tabs.length >= MAX_TABS) return d.toast(tr('開けるタブは {n} 個までです', { n: MAX_TABS }));
    const url = previewUrl(st.port);
    const t = createTab(url);
    activate(t.id);
    // ほかのページを開きたいときにすぐ打てるように、アドレス欄を選んでおく
    const input = $('browserUrl');
    if (input) {
      input.focus();
      input.select();
    }
  }

  function closeTab(id) {
    const i = st.tabs.findIndex((t) => t.id === id);
    if (i < 0 || st.tabs.length <= 1) return; // 最後の1つは閉じない
    const t = st.tabs[i];
    const wasActive = isActive(t);
    if (wasActive && st.design) setDesign(false);
    st.tabs.splice(i, 1);
    dropTab(t);
    if (wasActive) activate(st.tabs[Math.min(i, st.tabs.length - 1)].id);
    else drawTabs();
  }

  // did-navigate は、読み込みに成功したときだけ来る（失敗は did-fail-load）
  function onNavigated(t, url) {
    if (!url || url === 'about:blank' || /^chrome-error:/.test(url)) return;
    if (t.failed) {
      t.failed = null;
      t.retries = 0;
      clearTimeout(t.retryTimer);
      if (isActive(t)) drawNote();
    }
    t.url = url;
    drawTabs();
    if (!isActive(t)) return;
    const input = $('browserUrl');
    if (input && document.activeElement !== input) input.value = url;
    drawBar();
  }

  // 見ているタブで URL を開く
  function navigate(url) {
    const t = cur();
    if (!t) return;
    t.url = url;
    t.title = '';
    t.failed = null;
    t.retries = 0;
    clearTimeout(t.retryTimer);
    const input = $('browserUrl');
    if (input) input.value = url;
    drawNote();
    drawTabs();
    const w = t.el;
    if (!w) return;
    try {
      w.loadURL(url).catch(() => {}); // 失敗は did-fail-load で受け取る
    } catch {
      // まだ <webview> の準備ができていない: 準備ができたら src で開く
      w.src = url;
    }
  }

  // 開発サーバーが立ち上がるまで、見ているタブだけを読み込み直す
  function scheduleRetry(t) {
    clearTimeout(t.retryTimer);
    if (!st.visible || !isActive(t) || t.retries >= MAX_RETRIES || !t.failed) return;
    t.retryTimer = setTimeout(() => {
      if (!st.visible || !isActive(t) || !t.failed || document.hidden) return scheduleRetry(t);
      t.retries++;
      try {
        t.el.loadURL(t.failed.url || t.url).catch(() => {});
      } catch {
        // 次の機会にもう一度
      }
    }, RETRY_MS);
  }

  async function inject(on) {
    const w = view();
    if (!w) return;
    try {
      await w.executeJavaScript(on ? `${PICK_SCRIPT}.start(${JSON.stringify(st.tool)})` : `${PICK_SCRIPT}.stop()`);
    } catch {
      // ページがまだない・移動中: dom-ready でもう一度入れる
    }
  }

  // ペンの線は、スクリーンショットを撮ったら消す
  function clearInk() {
    const w = view();
    if (!w) return;
    try {
      w.executeJavaScript('window.__wkDesign && window.__wkDesign.clearInk()').catch(() => {});
    } catch {
      // ページがない
    }
  }

  async function onPick(pick) {
    if (pick.cancel) {
      setDesign(false);
      return;
    }
    if (!st.design) return clearInk();
    if (st.picks.length >= MAX_PICKS) {
      d.toast(tr('選べる部品は {n} 個までです', { n: MAX_PICKS }));
      clearInk();
      return;
    }
    let shot = '';
    try {
      const rect = captureRect(pick.rect, pick.viewport);
      const img = rect ? await view().capturePage(rect) : await view().capturePage();
      if (img && !img.isEmpty()) shot = img.toDataURL();
    } catch {
      // スクリーンショットが撮れなくても、HTML と CSS は渡す
    }
    if (pick.kind === 'area') clearInk();
    st.picks.push({ pick, shot, name: `design-${Date.now().toString(36)}-${st.picks.length + 1}.png` });
    drawPicks();
    const input = $('browserPickText');
    if (input) input.focus();
  }

  function setDesign(on, tool) {
    st.design = !!on;
    if (tool) st.tool = tool === 'pen' ? 'pen' : 'pick';
    inject(st.design);
    drawBar();
  }

  // <webview> の準備ができていない（dom-ready の前）と、メソッドは例外を投げる
  function ready() {
    const w = view();
    try {
      return !!w && !!w.getWebContentsId() && w.getURL() !== 'about:blank';
    } catch {
      return false;
    }
  }

  function onAction(kind) {
    const w = view();
    const t = cur();
    if (kind === 'back' && ready() && w.canGoBack()) w.goBack();
    else if (kind === 'forward' && ready() && w.canGoForward()) w.goForward();
    else if (kind === 'reload') {
      const u = curUrl() || previewUrl(st.port);
      if ((t && t.failed) || !ready()) {
        if (u) navigate(u);
      } else w.reload();
    } else if (kind === 'design' || kind === 'pen') {
      // 同じ道具のボタンでやめ、もう一方のボタンでは道具だけを切り替える
      const tool = kind === 'pen' ? 'pen' : 'pick';
      setDesign(!(st.design && st.tool === tool), tool);
    }
    else if (kind === 'newTab') newTab();
    else if (kind === 'full') setFull(!st.full);
    else if (kind === 'external' && curUrl()) {
      const u = curUrl();
      d.run(() => d.api.openExternal(u));
    }
    else if (kind === 'runScript' && st.cardId) startServer();
  }

  // 差分タブの大きな表示と同じく、#browserPane をそのまま画面いっぱいに広げ、後ろを暗くする。
  // <webview> は DOM の中で動かすと読み込み直すので、置き場所は変えずに CSS だけで広げる
  function backdrop() {
    let bd = $('browserBackdrop');
    const p = pane();
    if (!bd && p && p.parentNode) {
      bd = document.createElement('div');
      bd.id = 'browserBackdrop';
      bd.className = 'bv-backdrop hidden';
      bd.onmousedown = () => setFull(false);
      p.parentNode.insertBefore(bd, p);
    }
    return bd;
  }
  function setFull(on) {
    st.full = !!on && st.visible;
    applyFull();
  }
  function applyFull() {
    const p = pane();
    if (!p) return;
    p.classList.toggle('full', st.full);
    const bd = backdrop();
    if (bd) bd.classList.toggle('hidden', !st.full);
    const b = p.querySelector('[data-bv="full"]');
    if (b) {
      b.innerHTML = d.icon(st.full ? 'minimize' : 'maximize');
      b.title = st.full ? tr('大きな表示を閉じます（Esc）') : tr('画面に大きく表示します');
      b.classList.toggle('active', st.full);
    }
  }

  async function startServer() {
    const id = st.cardId;
    const data = await d.run(() => d.api.runScript(id, 'run'));
    if (!data || st.cardId !== id) return;
    st.scripts = data;
    st.port = data.port || st.port;
    drawServer();
    // サーバーが立ち上がるまでは繋がらないので、繋がるまで読み込み直す
    navigate(curUrl() || previewUrl(st.port));
  }

  function drawTabs() {
    const el = $('browserTabs');
    if (!el) return;
    const many = st.tabs.length > 1;
    el.innerHTML = st.tabs
      .map((t) => {
        const on = isActive(t);
        const label = tabLabel(t);
        const x = many
          ? `<button type="button" class="bv-tab-x" data-tab-close="${t.id}" title="${d.esc(tr('このタブを閉じる'))}" aria-label="${d.esc(tr('このタブを閉じる'))}">${d.icon('x')}</button>`
          : '';
        return `<div class="bv-tab${on ? ' active' : ''}" data-tab="${t.id}" role="tab" aria-selected="${on}" title="${d.esc(t.url ? `${label}\n${t.url}` : label)}"><span class="bv-tab-name">${d.esc(label)}</span>${x}</div>`;
      })
      .join('');
    const add = pane() && pane().querySelector('[data-bv="newTab"]');
    if (add) add.disabled = st.tabs.length >= MAX_TABS;
  }

  function drawBar() {
    const p = pane();
    if (!p || !st.built) return;
    const w = view();
    const t = cur();
    const ok = ready();
    p.querySelector('[data-bv="back"]').disabled = !(ok && w.canGoBack());
    p.querySelector('[data-bv="forward"]').disabled = !(ok && w.canGoForward());
    p.querySelector('[data-bv="reload"]').classList.toggle('spinning', !!(t && t.loading));
    for (const [key, tool] of [['design', 'pick'], ['pen', 'pen']]) {
      const b = p.querySelector(`[data-bv="${key}"]`);
      b.classList.toggle('primary', st.design && st.tool === tool);
      b.disabled = !curUrl();
    }
    p.querySelector('[data-bv="external"]').disabled = !curUrl();
    p.classList.toggle('designing', st.design);
  }

  function drawServer() {
    const el = $('browserServer');
    if (!el) return;
    const s = st.scripts;
    const running = s && s.run && s.run.running && s.run.kind === 'run';
    const parts = [];
    if (!st.port) parts.push(d.esc(tr('このタスクにはまだポートがありません。実行スクリプトを動かすと割り当てます')));
    if (running) parts.push(`<span class="bv-ok">${d.esc(tr('実行スクリプトが動いています'))}</span>`);
    else if (s && s.scripts && s.scripts.run) parts.push(`<button type="button" class="btn small" data-bv="runScript">${d.icon('play')}${d.esc(tr('実行スクリプトで開発サーバーを起動'))}</button>`);
    el.innerHTML = parts.map((x) => (x.startsWith('<') ? x : `<span>${x}</span>`)).join('');
    const b = el.querySelector('[data-bv="runScript"]');
    if (b) b.onclick = () => onAction('runScript');
  }

  function drawNote() {
    const el = $('browserNote');
    if (!el) return;
    const t = cur();
    const url = curUrl();
    let html = '';
    if (!url) {
      html = `<p>${d.esc(tr('開くページがありません。上のアドレス欄に URL かポート番号を入れてください'))}</p>`;
    } else if (t.failed) {
      const waiting = st.visible && t.retries < MAX_RETRIES;
      html = `<p><b>${d.esc(tr('ページを開けませんでした'))}</b></p>
        <p class="muted small mono">${d.esc(t.failed.url || url)}<br>${d.esc(t.failed.desc || String(t.failed.code))}</p>
        <p class="muted small">${d.esc(waiting ? tr('開発サーバーが動いていないかもしれません。立ち上がるまで、数秒ごとに読み込み直します') : tr('開発サーバーが動いているかを確かめてください'))}</p>
        <button type="button" class="btn small" data-note="retry">${d.icon('refresh')}${d.esc(tr('読み込み直す'))}</button>`;
    }
    el.innerHTML = html;
    el.classList.toggle('hidden', !html);
    const r = el.querySelector('[data-note="retry"]');
    if (r) r.onclick = () => navigate(t.failed ? t.failed.url || t.url : t.url);
  }

  function pickLabel(p) {
    return p.kind === 'area' ? tr('ペンで囲んだ範囲') : p.selector || p.tag || '';
  }
  function pickTitle(p) {
    if (p.kind !== 'area') return p.selector || '';
    return (p.elements || []).map((x) => x.selector || x.tag).filter(Boolean).join('\n');
  }
  function drawPicks() {
    const el = $('browserPicks');
    if (!el) return;
    if (!st.picks.length) {
      el.classList.add('hidden');
      el.innerHTML = '';
      return;
    }
    const prev = $('browserPickText');
    const text = prev ? prev.value : '';
    el.classList.remove('hidden');
    el.innerHTML = `
      <div class="bv-pick-list">${st.picks
        .map(
          (x, i) => `<span class="attach-chip bv-pick" title="${d.esc(pickTitle(x.pick))}">${x.shot ? `<img src="${x.shot}" alt="" />` : d.icon(x.pick.kind === 'area' ? 'pen' : 'image')}<span class="attach-name${x.pick.kind === 'area' ? '' : ' mono'}">${d.esc(pickLabel(x.pick))}</span><button type="button" class="chip-x" data-i="${i}" title="${d.esc(tr('外す'))}">×</button></span>`,
        )
        .join('')}</div>
      <div class="composer">
        <textarea id="browserPickText" rows="2"></textarea>
        <button type="button" class="composer-send" id="browserPickSend" title="${d.esc(tr('送信（Ctrl/⌘ + Enter）'))}" aria-label="${d.esc(tr('送信'))}">${d.icon('send')}</button>
      </div>
      <div class="bv-pick-foot"><span class="muted small" id="browserPickHint"></span><button type="button" class="btn small ghost" data-pick="clear">${d.esc(tr('選んだ部品をすべて外す'))}</button></div>`;
    const input = $('browserPickText');
    input.value = text;
    input.addEventListener('keydown', (e) => {
      if (e.key !== 'Enter' || e.isComposing || e.shiftKey || !(e.metaKey || e.ctrlKey)) return;
      e.preventDefault();
      sendPicks();
    });
    $('browserPickSend').onclick = sendPicks;
    el.querySelectorAll('.chip-x').forEach((b) => {
      b.onclick = () => {
        st.picks.splice(Number(b.dataset.i), 1);
        drawPicks();
      };
    });
    el.querySelector('[data-pick="clear"]').onclick = () => {
      st.picks = [];
      drawPicks();
    };
    drawSendState();
  }

  function drawSendState() {
    const c = d.card(st.cardId);
    const m = sendMode(c);
    const input = $('browserPickText');
    const btn = $('browserPickSend');
    const hint = $('browserPickHint');
    if (!input) return;
    input.placeholder = m.ok ? tr('この部品をどうしたいかを書く（例: もっと目立つ色にして、余白を広げて）') : m.hint;
    btn.disabled = !m.ok;
    if (hint) hint.textContent = m.ok ? m.hint : '';
  }

  async function sendPicks() {
    const c = d.card(st.cardId);
    const m = sendMode(c);
    const input = $('browserPickText');
    if (!c || !m.ok || !input) return;
    const text = input.value.trim();
    if (!text) {
      d.toast(tr('この部品をどうしたいかを書いてください'));
      input.focus();
      return;
    }
    const withShots = m.kind === 'send';
    const files = withShots
      ? st.picks.filter((x) => x.shot).map((x) => ({ name: x.name, mediaType: 'image/png', data: x.shot.slice(x.shot.indexOf(',') + 1) }))
      : [];
    const message = buildPickMessage(
      text,
      st.picks.map((x) => ({ pick: x.pick, shotName: withShots && x.shot ? x.name : '' })),
    );
    const id = c.id;
    const ok = await d.run(() => (m.kind === 'send' ? d.api.send(id, message, null, files.length ? files : undefined) : d.api.btw(id, message)).then(() => true));
    if (!ok) return;
    d.toast(tr('エージェントに送りました'), 'ok');
    if (st.cardId !== id) return;
    st.picks = [];
    drawPicks();
    setDesign(false);
  }

  async function loadScripts(c, { force = false } = {}) {
    const key = `${c.id}:${c.status}:${c.worktreePath || ''}`;
    if (!force && st.scriptsFor === key) return;
    st.scriptsFor = key;
    let data = null;
    try {
      data = await d.api.scripts(c.id);
    } catch {
      data = null;
    }
    if (st.cardId !== c.id) return;
    st.scripts = data;
    const port = (data && data.port) || null;
    const first = !st.port && port;
    st.port = port;
    drawServer();
    // ポートが分かったら、まだ何も開いていなければ開く
    if (first && !curUrl()) navigate(previewUrl(port));
  }

  function show(on) {
    st.visible = !!on;
    const p = pane();
    if (p) p.classList.toggle('hidden', !st.visible);
    const t = cur();
    if (!st.visible) {
      if (st.full) setFull(false); // 別のタブに移ったら、普通の表示に戻す
      if (t) clearTimeout(t.retryTimer);
      if (st.design) setDesign(false);
    } else if (t && t.failed) scheduleRetry(t);
  }

  // 今のタスクのタブを覚えておき、<webview> を片付ける
  function saveTabs() {
    if (!st.cardId) return;
    const tabs = st.tabs.filter((t) => t.url).map((t) => ({ url: t.url, title: t.title }));
    const i = st.tabs.filter((t) => t.url).findIndex((t) => isActive(t));
    if (tabs.length) st.saved.set(st.cardId, { tabs, active: Math.max(0, i) });
    else st.saved.delete(st.cardId);
  }

  function render(c) {
    if (!d || !c) return;
    build();
    const p = pane();
    if (d.viewingHost()) {
      // 遠隔操作中は、開発サーバーは接続先のマシンで動いているので、このマシンの localhost では開けない
      p.classList.add('bv-off');
      $('browserServer').innerHTML = '';
      const el = $('browserNote');
      el.innerHTML = `<p>${d.esc(tr('遠隔操作中は、接続先のマシンの開発サーバーを内蔵ブラウザで開けません'))}</p>`;
      el.classList.remove('hidden');
      return;
    }
    p.classList.remove('bv-off');
    if (st.cardId !== c.id) {
      // 別のタスクを開いた: 選んだ部品は前のタスクのものなので捨て、タブはそのタスクで開いていたものに入れ替える
      if (st.design) setDesign(false);
      if (st.full) setFull(false); // 別のタスクを開いたら、普通の表示で開く
      saveTabs();
      for (const t of st.tabs) dropTab(t);
      st.tabs = [];
      st.active = '';
      st.cardId = c.id;
      st.picks = [];
      st.port = null;
      st.scripts = null;
      st.scriptsFor = '';
      drawPicks();
      const saved = st.saved.get(c.id);
      const list = saved && saved.tabs.length ? saved.tabs : [{ url: '', title: '' }];
      for (const x of list) createTab(x.url, x.title);
      activate(st.tabs[Math.min((saved && saved.active) || 0, st.tabs.length - 1)].id);
    }
    drawTabs();
    drawBar();
    drawServer();
    drawSendState();
    loadScripts(c);
  }

  function update(c) {
    if (!d || !c || c.id !== st.cardId || !st.built) return;
    drawSendState();
    loadScripts(c);
  }

  return {
    PARTITION,
    PICK_MARK,
    PICK_SCRIPT,
    MAX_TABS,
    previewUrl,
    normalizeUrl,
    parsePickMessage,
    captureRect,
    buildPickMessage,
    tabLabel,
    init,
    show,
    render,
    update,
  };
});
