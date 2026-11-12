// 内蔵ブラウザ（タスクの開発サーバーのプレビュー）と、デザインモード（画面の部品をクリックして、その HTML・CSS・スクリーンショットをエージェントに渡す）
//
// 詳細パネルの「ブラウザ」タブ。タスクごとのポート（WORKTREE_KANBAN_PORT）の http://localhost:<port>/ を <webview> で開く。
// <webview> は作り直すと読み込み直しになるので、1つだけ作って #browserPane に置いたままにし、タブを切り替えても残す。
// デザインモードでは、ページに小さなスクリプト（PICK_SCRIPT）を入れて、マウスの下の部品を枠で示し、クリックした部品の情報を
// console に印付きの JSON で書いてもらう（<webview> の console-message で受け取る）。スクリーンショットは capturePage で撮る。
//
// 境界: window.BrowserView = {
//   init(deps)          renderer.js の部品（api・icon・esc・toast・run・canSendFollow・viewingHost）を受け取る
//   show(on)            タブを開いた・閉じた（ペインの表示と、詳細パネルを広げるかを切り替える）
//   render(c)           タブを描く（カードが変わったときだけ URL を開き直す）
//   update(c)           カードの状態が変わった（送れるかどうかの表示だけを直す）
// }
// テストからは純粋な関数（previewUrl・normalizeUrl・buildPickMessage・parsePickMessage・captureRect・PICK_SCRIPT）を使う
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
  const WIDE_KEY = 'browserWide';

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
      const r = p.rect || {};
      const lines = [`### ${i + 1}. \`${String(p.selector || p.tag || '?').replace(/`/g, "'")}\``];
      if (p.url) lines.push(`- ${tr('ページ')}: ${p.url}`);
      lines.push(`- ${tr('位置と大きさ')}: x=${Math.round(r.x || 0)}, y=${Math.round(r.y || 0)}, ${Math.round(r.width || 0)}×${Math.round(r.height || 0)}px（${tr('画面の幅 {w}px', { w: Math.round((p.viewport && p.viewport.width) || 0) })}）`);
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
  let box = null, label = null, on = false, cur = null;
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
  const onMove = (e) => {
    const el = e.target;
    if (!el || el.nodeType !== 1 || ours(el)) return;
    cur = el;
    show(el);
  };
  const block = (e) => { if (on) { e.preventDefault(); e.stopPropagation(); e.stopImmediatePropagation(); } };
  const onClick = (e) => {
    block(e);
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
    console.log(MARK + JSON.stringify({ cancel: true }));
  };
  const EVENTS = [['mousemove', onMove], ['mouseover', onMove], ['click', onClick], ['mousedown', block], ['mouseup', block], ['pointerdown', block], ['pointerup', block], ['dblclick', block], ['auxclick', block], ['contextmenu', block], ['keydown', onKey]];
  const api = {
    start() { if (on) return; on = true; for (const [t, f] of EVENTS) addEventListener(t, f, true); document.documentElement.style.cursor = 'crosshair'; },
    stop() { if (!on) return; on = false; for (const [t, f] of EVENTS) removeEventListener(t, f, true); hide(); cur = null; document.documentElement.style.cursor = ''; },
    get on() { return on; },
  };
  g.__wkDesign = api;
  return api;
})()`;

  // ---------------- 画面 ----------------

  let d = null; // renderer.js から受け取る部品
  const st = {
    cardId: null,
    url: '', // 今開いている URL
    urls: new Map(), // カード ID → 最後に開いていた URL（アプリを開いているあいだだけ）
    port: null,
    scripts: null, // api.scripts の結果
    scriptsFor: '', // どのカードのどの状態で読んだか
    design: false,
    picks: [], // { pick, shot (data URL), name }
    failed: null, // 読み込めなかったときの { code, desc }
    retries: 0,
    retryTimer: null,
    visible: false,
    built: false,
    loading: false,
  };
  const $ = (id) => document.getElementById(id);
  const pane = () => $('browserPane');
  const view = () => $('browserWebview');

  function init(deps) {
    d = deps;
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
      <div class="bv-bar">
        <button type="button" class="icon bv-nav" data-bv="back" title="${d.esc(tr('前のページに戻る'))}">${d.icon('arrowLeft')}</button>
        <button type="button" class="icon bv-nav" data-bv="forward" title="${d.esc(tr('次のページに進む'))}">${d.icon('arrowRight')}</button>
        <button type="button" class="icon bv-nav" data-bv="reload" title="${d.esc(tr('読み込み直す'))}">${d.icon('refresh')}</button>
        <input id="browserUrl" class="bv-url mono" spellcheck="false" autocomplete="off" placeholder="http://localhost:3000/" />
        <button type="button" class="btn small bv-design" data-bv="design" title="${d.esc(tr('画面の部品をクリックすると、その HTML・CSS とスクリーンショットをエージェントに渡せます（Esc でやめます）'))}">${d.icon('crosshair')}${d.esc(tr('デザインモード'))}</button>
        <button type="button" class="icon bv-nav" data-bv="wide" title="${d.esc(tr('詳細パネルを広げる・戻す'))}">${d.icon('maximize')}</button>
        <button type="button" class="icon bv-nav" data-bv="external" title="${d.esc(tr('いつものブラウザで開く'))}">${d.icon('external')}</button>
      </div>
      <div id="browserServer" class="bv-server muted small"></div>
      <div class="bv-stage">
        <webview id="browserWebview" partition="${PARTITION}" src="about:blank" webpreferences="contextIsolation=yes, sandbox=yes"></webview>
        <div id="browserNote" class="bv-note hidden"></div>
      </div>
      <div id="browserPicks" class="bv-picks hidden"></div>`;
    p.querySelectorAll('[data-bv]').forEach((b) => (b.onclick = () => onAction(b.dataset.bv)));
    const url = $('browserUrl');
    url.addEventListener('keydown', (e) => {
      if (e.key !== 'Enter') return;
      e.preventDefault();
      const u = normalizeUrl(url.value);
      if (!u) return d.toast(tr('開けない URL です'));
      navigate(u);
    });
    const w = view();
    w.addEventListener('did-navigate', (e) => onNavigated(e.url));
    w.addEventListener('did-navigate-in-page', (e) => e.isMainFrame && onNavigated(e.url));
    w.addEventListener('did-start-loading', () => {
      st.loading = true;
      drawBar();
    });
    w.addEventListener('did-stop-loading', () => {
      st.loading = false;
      drawBar();
    });
    w.addEventListener('did-fail-load', (e) => {
      // -3 は読み込みの中断（次の移動が始まった）なので、失敗にしない
      if (!e.isMainFrame || e.errorCode === -3) return;
      st.failed = { code: e.errorCode, desc: e.errorDescription || '', url: e.validatedURL || st.url };
      drawNote();
      scheduleRetry();
    });
    w.addEventListener('dom-ready', () => {
      // 読み込みに失敗したときのエラーの画面でも dom-ready は来るので、そのときは入れない
      if (st.design && !st.failed && w.getURL() !== 'about:blank') inject(true);
    });
    w.addEventListener('console-message', (e) => {
      const pick = parsePickMessage(e.message);
      if (pick) onPick(pick);
    });
  }

  // did-navigate は、読み込みに成功したときだけ来る（失敗は did-fail-load）
  function onNavigated(url) {
    if (!url || url === 'about:blank' || /^chrome-error:/.test(url)) return;
    if (st.failed) {
      st.failed = null;
      st.retries = 0;
      clearTimeout(st.retryTimer);
      drawNote();
    }
    st.url = url;
    if (st.cardId) st.urls.set(st.cardId, url);
    const input = $('browserUrl');
    if (input && document.activeElement !== input) input.value = url;
    drawBar();
  }

  function navigate(url) {
    st.url = url;
    if (st.cardId) st.urls.set(st.cardId, url);
    st.failed = null;
    st.retries = 0;
    clearTimeout(st.retryTimer);
    const input = $('browserUrl');
    if (input) input.value = url;
    drawNote();
    const w = view();
    if (!w) return;
    try {
      w.loadURL(url).catch(() => {}); // 失敗は did-fail-load で受け取る
    } catch {
      // まだ <webview> の準備ができていない: 準備ができたら src で開く
      w.src = url;
    }
  }

  function scheduleRetry() {
    clearTimeout(st.retryTimer);
    if (!st.visible || st.retries >= MAX_RETRIES || !st.failed) return;
    st.retryTimer = setTimeout(() => {
      if (!st.visible || !st.failed || document.hidden) return scheduleRetry();
      st.retries++;
      const w = view();
      try {
        w.loadURL(st.failed.url || st.url).catch(() => {});
      } catch {
        // 次の機会にもう一度
      }
    }, RETRY_MS);
  }

  async function inject(on) {
    const w = view();
    if (!w) return;
    try {
      await w.executeJavaScript(`${PICK_SCRIPT}.${on ? 'start' : 'stop'}()`);
    } catch {
      // ページがまだない・移動中: dom-ready でもう一度入れる
    }
  }

  async function onPick(pick) {
    if (pick.cancel) {
      setDesign(false);
      return;
    }
    if (!st.design) return;
    if (st.picks.length >= MAX_PICKS) {
      d.toast(tr('選べる部品は {n} 個までです', { n: MAX_PICKS }));
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
    st.picks.push({ pick, shot, name: `design-${Date.now().toString(36)}-${st.picks.length + 1}.png` });
    drawPicks();
    const input = $('browserPickText');
    if (input) input.focus();
  }

  function setDesign(on) {
    st.design = !!on;
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
    if (kind === 'back' && ready() && w.canGoBack()) w.goBack();
    else if (kind === 'forward' && ready() && w.canGoForward()) w.goForward();
    else if (kind === 'reload') {
      const u = st.url || previewUrl(st.port);
      if (st.failed || !ready()) {
        if (u) navigate(u);
      } else w.reload();
    } else if (kind === 'design') setDesign(!st.design);
    else if (kind === 'wide') setWide(!isWide());
    else if (kind === 'external' && st.url) d.run(() => d.api.openExternal(st.url));
    else if (kind === 'runScript' && st.cardId) startServer();
  }

  function isWide() {
    try {
      return localStorage.getItem(WIDE_KEY) === '1';
    } catch {
      return false;
    }
  }
  function setWide(on) {
    try {
      if (on) localStorage.setItem(WIDE_KEY, '1');
      else localStorage.removeItem(WIDE_KEY);
    } catch {
      // 覚えられないだけ
    }
    applyWide();
  }
  function applyWide() {
    const panel = $('detail');
    if (panel) panel.classList.toggle('browser-wide', st.visible && isWide());
  }

  async function startServer() {
    const id = st.cardId;
    const data = await d.run(() => d.api.runScript(id, 'run'));
    if (!data || st.cardId !== id) return;
    st.scripts = data;
    st.port = data.port || st.port;
    drawServer();
    // サーバーが立ち上がるまでは繋がらないので、繋がるまで読み込み直す
    navigate(st.urls.get(id) || previewUrl(st.port));
  }

  function drawBar() {
    const p = pane();
    if (!p || !st.built) return;
    const w = view();
    const ok = ready();
    p.querySelector('[data-bv="back"]').disabled = !(ok && w.canGoBack());
    p.querySelector('[data-bv="forward"]').disabled = !(ok && w.canGoForward());
    p.querySelector('[data-bv="reload"]').classList.toggle('spinning', st.loading);
    const design = p.querySelector('[data-bv="design"]');
    design.classList.toggle('primary', st.design);
    design.disabled = !st.url;
    p.querySelector('[data-bv="external"]').disabled = !st.url;
    p.querySelector('[data-bv="wide"]').classList.toggle('active', isWide());
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
    let html = '';
    if (!st.url) {
      html = `<p>${d.esc(tr('開くページがありません。上のアドレス欄に URL かポート番号を入れてください'))}</p>`;
    } else if (st.failed) {
      const waiting = st.visible && st.retries < MAX_RETRIES;
      html = `<p><b>${d.esc(tr('ページを開けませんでした'))}</b></p>
        <p class="muted small mono">${d.esc(st.failed.url || st.url)}<br>${d.esc(st.failed.desc || String(st.failed.code))}</p>
        <p class="muted small">${d.esc(waiting ? tr('開発サーバーが動いていないかもしれません。立ち上がるまで、数秒ごとに読み込み直します') : tr('開発サーバーが動いているかを確かめてください'))}</p>
        <button type="button" class="btn small" data-note="retry">${d.icon('refresh')}${d.esc(tr('読み込み直す'))}</button>`;
    }
    el.innerHTML = html;
    el.classList.toggle('hidden', !html);
    const r = el.querySelector('[data-note="retry"]');
    if (r) r.onclick = () => navigate(st.failed ? st.failed.url || st.url : st.url);
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
          (x, i) => `<span class="attach-chip bv-pick" title="${d.esc(x.pick.selector || '')}">${x.shot ? `<img src="${x.shot}" alt="" />` : d.icon('image')}<span class="attach-name mono">${d.esc(x.pick.selector || x.pick.tag || '')}</span><button type="button" class="chip-x" data-i="${i}" title="${d.esc(tr('外す'))}">×</button></span>`,
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
    if (first && !st.url) navigate(previewUrl(port));
  }

  function show(on) {
    st.visible = !!on;
    const p = pane();
    if (p) p.classList.toggle('hidden', !st.visible);
    applyWide();
    if (!st.visible) {
      clearTimeout(st.retryTimer);
      if (st.design) setDesign(false);
    } else if (st.failed) scheduleRetry();
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
      // 別のタスクを開いた: 選んだ部品は前のタスクのものなので捨てる
      st.cardId = c.id;
      st.picks = [];
      st.port = null;
      st.scripts = null;
      st.scriptsFor = '';
      st.url = '';
      if (st.design) setDesign(false);
      drawPicks();
      const saved = st.urls.get(c.id);
      if (saved) navigate(saved);
      else {
        clearTimeout(st.retryTimer);
        st.failed = null;
        const w = view();
        try {
          if (w.getURL() !== 'about:blank') w.loadURL('about:blank').catch(() => {});
        } catch {
          // まだ準備ができていない（about:blank のまま）
        }
        $('browserUrl').value = '';
        drawNote();
      }
    }
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
    previewUrl,
    normalizeUrl,
    parsePickMessage,
    captureRect,
    buildPickMessage,
    init,
    show,
    render,
    update,
  };
});
