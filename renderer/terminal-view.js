// アプリの中のターミナルの画面（xterm.js）。シェル自体は main プロセスで動く（src/terminal.js）
//
// - タスク詳細の「ターミナル」タブ: そのタスクの worktree で開く（タスクごとに1つ）
// - 画面下のパネル: タスクと関係なく開く自由なターミナル（いくつでも）と、タスクのターミナルをサブタブで並べる
//
// 1つのターミナルの画面（xterm）は、同時には1か所にしか出せない。タブとパネルの両方で同じものを開いたときは、
// あとから出した側へ移し、もう一方には「〜で表示中」と「ここに表示」のボタンを出す。
// タブやパネルを閉じてもシェルは動いたまま（閉じるボタン・exit で終わる）。
(function (root) {
  const tr = (s, v) => (root.I18n ? root.I18n.tr(s, v) : s);
  const esc = (s) => String(s == null ? '' : s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);
  const isMac = /Mac/i.test((root.navigator && root.navigator.platform) || '');

  const PANEL_H_KEY = 'termPanelHeight';
  const PANEL_OPEN_KEY = 'termPanelOpen';
  const MIN_PANEL_H = 120;

  let api = null;
  let iconFn = () => '';
  let toast = () => {};
  let currentCard = () => null; // 今開いているタスク（パネルの「このタスク」用）
  const sessions = new Map(); // id → { id, info, term, fit, el, ro, exited, place }
  const panel = { open: false, active: null, list: [] }; // list: terminal:list の結果（ホストのものも含む）

  // ---- xterm の作成 ----
  function cssVar(name, def) {
    const v = getComputedStyle(document.documentElement).getPropertyValue(name).trim();
    return v || def;
  }
  function theme() {
    return {
      background: cssVar('--term-bg', '#0b0d12'),
      foreground: cssVar('--term-fg', '#e6e8ee'),
      cursor: cssVar('--accent', '#6d8bff'),
      selectionBackground: 'rgba(109, 139, 255, 0.35)',
    };
  }

  function hasXterm() {
    return typeof root.Terminal === 'function' && root.FitAddon && typeof root.FitAddon.FitAddon === 'function';
  }

  function makeSession(info) {
    const el = document.createElement('div');
    el.className = 'term-host';
    el.dataset.term = info.id;
    const term = new root.Terminal({
      cursorBlink: true,
      fontFamily: cssVar('--mono', 'Menlo, Consolas, monospace'),
      fontSize: 13,
      scrollback: 5000,
      allowProposedApi: false,
      macOptionIsMeta: true,
      theme: theme(),
    });
    const fit = new root.FitAddon.FitAddon();
    term.loadAddon(fit);
    const s = { id: info.id, info, term, fit, el, ro: null, exited: !!info.exited, place: null, opened: false, lastSize: '' };
    term.onData((d) => {
      if (s.exited) return;
      api.terminalWrite(s.id, d).catch(() => {});
    });
    // コピー: 選んでいるときの Ctrl+C（Mac は ⌘C）・Ctrl+Shift+C。貼り付け: Ctrl+V・Ctrl+Shift+V（ブラウザの貼り付けに任せる）
    term.attachCustomKeyEventHandler((e) => {
      if (e.type !== 'keydown') return true;
      const mod = isMac ? e.metaKey : e.ctrlKey;
      const k = e.key.toLowerCase();
      if (mod && k === 'c' && (term.hasSelection() || e.shiftKey)) {
        const sel = term.getSelection();
        if (sel) navigator.clipboard.writeText(sel).catch(() => {});
        return false;
      }
      if (mod && k === 'v') return false;
      if (isMac && e.metaKey) return false; // ⌘ のショートカット（⌘K など）はシェルへ送らない
      return true;
    });
    // ターミナルで打ったキー（Esc など）で、詳細を閉じるなどの画面のショートカットが動かないようにする
    el.addEventListener('keydown', (e) => e.stopPropagation());
    s.ro = new ResizeObserver(() => fitNow(s));
    s.ro.observe(el);
    sessions.set(s.id, s);
    if (info.scrollback) term.write(info.scrollback);
    if (s.exited) term.write(`\r\n\x1b[2m${tr('[シェルは終了しました]')}\x1b[0m\r\n`);
    return s;
  }

  function fitNow(s) {
    if (!s.el.isConnected || !s.el.clientWidth || !s.el.clientHeight) return;
    if (!s.opened) {
      s.term.open(s.el);
      s.opened = true;
    }
    try {
      s.fit.fit();
    } catch {
      return;
    }
    // 出したばかりのときは、打てるようにフォーカスする（大きさが決まるまでは xterm にフォーカスできない）
    if (s.wantFocus) {
      s.wantFocus = false;
      setTimeout(() => s.term.focus(), 0);
    }
    const size = `${s.term.cols}x${s.term.rows}`;
    if (size === s.lastSize || s.exited) return;
    s.lastSize = size;
    api.terminalResize(s.id, s.term.cols, s.term.rows).catch(() => {});
  }

  // 画面の大きさから、開くときの cols / rows を見積もる（開いたあと fit で合わせ直す）
  function guessSize(container) {
    const w = (container && container.clientWidth) || 800;
    const h = (container && container.clientHeight) || 300;
    return { cols: Math.max(20, Math.floor(w / 7.8)), rows: Math.max(5, Math.floor(h / 17)) };
  }

  // 開いた結果（info）から、画面のターミナルを作る（もうあれば、それを使う）
  function adopt(info) {
    const old = sessions.get(info.id);
    if (old) {
      old.info = { ...old.info, ...info };
      return old;
    }
    return makeSession(info);
  }

  function dispose(id) {
    const s = sessions.get(id);
    if (!s) return;
    sessions.delete(id);
    try {
      s.ro.disconnect();
      s.term.dispose();
    } catch {
      /* もう消えている */
    }
    s.el.remove();
  }

  // ---- どこに出すか ----
  // container に s の画面を出す。place: 'tab' | 'panel'
  function mount(s, container, place) {
    if (s.el.parentNode !== container) container.appendChild(s.el);
    s.place = place;
    s.wantFocus = true;
    requestAnimationFrame(() => fitNow(s));
  }

  function placeholder(container, s, where, onTake) {
    container.innerHTML = `<div class="term-empty"><p class="muted">${esc(where === 'tab' ? tr('このターミナルは、タスク詳細の「ターミナル」タブに出しています') : tr('このターミナルは、画面下のターミナルのパネルに出しています'))}</p><button class="btn" type="button" data-term-take>${esc(tr('ここに表示'))}</button></div>`;
    container.querySelector('[data-term-take]').onclick = onTake;
  }

  function messageHtml(text, buttons = '') {
    return `<div class="term-empty"><p class="muted">${esc(text)}</p>${buttons}</div>`;
  }

  // アプリの中で開けないとき: 「外部のターミナルで開く」
  function unavailableHtml() {
    return messageHtml(tr('このパソコンでは、アプリの中のターミナルを使えません（node-pty も python3 も見つかりませんでした）。OS のターミナルで開けます。'), `<button class="btn" type="button" data-term-ext>${iconFn('terminal')}${esc(tr('外部のターミナルで開く'))}</button>`);
  }

  async function openExternal(p) {
    try {
      await api.terminalOpenExternal(p);
    } catch (err) {
      toast((err && err.message) || String(err), true);
    }
  }

  async function isAvailable() {
    try {
      const a = await api.terminalAvailable();
      return !!(a && a.ok);
    } catch {
      return false;
    }
  }

  // ---- タスク詳細の「ターミナル」タブ ----
  // そのタスクでターミナルを開けるか（git のタスクは worktree ができてから。会話と git でないフォルダはそのフォルダ）
  function cardHasFolder(c) {
    if (!c) return false;
    return !!(c.noGit || c.kind === 'chat' ? c.repoPath : c.worktreePath);
  }

  function cardSession(cardId) {
    for (const s of sessions.values()) if (s.info.kind === 'card' && s.info.cardId === cardId && !s.exited) return s;
    return null;
  }

  async function openCard(c, container) {
    const old = cardSession(c.id);
    if (old) return old;
    const info = await api.terminalOpen({ kind: 'card', cardId: c.id, ...guessSize(container) });
    const s = adopt(info);
    refreshList();
    return s;
  }

  /** タスク詳細の body に、そのタスクのターミナルを出す */
  async function renderCardTab(body, c) {
    const box = document.createElement('div');
    box.className = 'term-tab';
    box.dataset.card = c.id;
    // 同じタスクのターミナルをもう出していれば、作り直さない（ボードが変わるたびに呼ばれる）
    const cur = body.querySelector(`.term-tab[data-card="${CSS.escape(c.id)}"]`);
    if (cur && cur.querySelector('.term-host')) return;
    body.innerHTML = '';
    body.appendChild(box);
    if (!hasXterm()) {
      box.innerHTML = messageHtml(tr('ターミナルの部品（xterm.js）を読み込めませんでした'));
      return;
    }
    if (!(await isAvailable())) {
      box.innerHTML = unavailableHtml();
      box.querySelector('[data-term-ext]').onclick = () => openExternal({ cardId: c.id });
      return;
    }
    if (!cardHasFolder(c)) {
      box.innerHTML = messageHtml(tr('開始すると worktree ができ、ここでターミナルを開けます'));
      return;
    }
    const existing = cardSession(c.id);
    if (existing && existing.place === 'panel' && panel.open && panel.active === existing.id) {
      placeholder(box, existing, 'panel', () => {
        mount(existing, box, 'tab');
        renderPanel();
      });
      return;
    }
    box.innerHTML = messageHtml(tr('ターミナルを開いています…'));
    try {
      const s = await openCard(c, box);
      if (!box.isConnected) return; // 開いているあいだに、別のタブ・タスクに切り替えた
      box.innerHTML = '';
      mount(s, box, 'tab');
      if (panel.open && panel.active === s.id) renderPanel();
    } catch (err) {
      box.innerHTML = messageHtml((err && err.message) || String(err));
    }
  }

  // ---- 画面下のパネル ----
  function panelEl(id) {
    return document.getElementById(id);
  }

  function savePanelState() {
    try {
      localStorage.setItem(PANEL_OPEN_KEY, panel.open ? '1' : '');
    } catch {
      /* 保存できなくてもよい */
    }
  }

  function setPanelHeight(h) {
    const max = Math.max(MIN_PANEL_H, window.innerHeight - 160);
    const v = Math.round(Math.min(max, Math.max(MIN_PANEL_H, h)));
    panelEl('termPanel').style.height = `${v}px`;
    try {
      localStorage.setItem(PANEL_H_KEY, String(v));
    } catch {
      /* */
    }
  }

  async function refreshList() {
    try {
      const list = await api.terminalList();
      panel.list = Array.isArray(list) ? list : [];
    } catch {
      panel.list = [];
    }
    // 一覧から消えた（閉じた・タスクを消した）ものは、画面からも消す
    const ids = new Set(panel.list.map((t) => t.id));
    for (const id of [...sessions.keys()]) if (!ids.has(id)) dispose(id);
    if (panel.active && !ids.has(panel.active)) panel.active = panel.list.length ? panel.list[panel.list.length - 1].id : null;
    if (panel.open) renderPanel();
  }

  function tabLabel(t) {
    const base = t.kind === 'card' ? t.title || tr('タスク') : t.title || t.shell || tr('ターミナル');
    return base;
  }

  function renderPanelTabs() {
    const tabs = panelEl('termTabs');
    tabs.innerHTML = panel.list
      .map((t) => {
        const cls = ['term-tabbtn', t.id === panel.active ? 'active' : '', t.exited ? 'exited' : ''].filter(Boolean).join(' ');
        const kind = t.kind === 'card' ? `<span class="term-kind">${esc(tr('タスク'))}</span>` : '';
        const host = t.remote ? `<span class="term-kind">${esc(tr('ホスト'))}</span>` : '';
        return `<div class="${cls}" data-term-sel="${esc(t.id)}" title="${esc(t.cwd || '')}" role="tab" aria-selected="${t.id === panel.active}">${iconFn('terminal')}${host}${kind}<span class="term-name">${esc(tabLabel(t))}</span><button type="button" class="term-x" data-term-close="${esc(t.id)}" title="${esc(tr('閉じる（シェルを終わらせます）'))}" aria-label="${esc(tr('閉じる'))}">${iconFn('x')}</button></div>`;
      })
      .join('');
    const c = currentCard();
    const btn = panelEl('termCardBtn');
    btn.classList.toggle('hidden', !c || !cardHasFolder(c));
  }

  async function renderPanel() {
    if (!panel.open) return;
    renderPanelTabs();
    const body = panelEl('termBody');
    if (!hasXterm()) {
      body.innerHTML = messageHtml(tr('ターミナルの部品（xterm.js）を読み込めませんでした'));
      return;
    }
    const t = panel.list.find((x) => x.id === panel.active);
    if (!t) {
      if (!(await isAvailable())) {
        body.innerHTML = unavailableHtml();
        body.querySelector('[data-term-ext]').onclick = () => openExternal({});
        return;
      }
      body.innerHTML = messageHtml(tr('ターミナルはまだありません。「＋」で開きます（今のリポジトリのフォルダで開きます）'), `<button class="btn" type="button" data-term-new>${iconFn('plus')}${esc(tr('新しいターミナル'))}</button>`);
      body.querySelector('[data-term-new]').onclick = () => newFree();
      return;
    }
    let s = sessions.get(t.id);
    if (!s) {
      // ほかの画面（スマホ・遠隔の操作側）で開いたもの・画面を読み直したあと: それまでの出力をもらってつなぐ
      try {
        s = adopt(await api.terminalAttach(t.id));
      } catch (err) {
        body.innerHTML = messageHtml((err && err.message) || String(err));
        return;
      }
    }
    if (s.place === 'tab' && s.el.isConnected && s.el.parentNode !== body) {
      placeholder(body, s, 'tab', () => {
        body.innerHTML = '';
        mount(s, body, 'panel');
        const tabBox = document.querySelector(`.term-tab[data-card="${CSS.escape(s.info.cardId || '')}"]`);
        if (tabBox) placeholder(tabBox, s, 'panel', () => {
          mount(s, tabBox, 'tab');
          renderPanel();
        });
      });
      return;
    }
    if (s.el.parentNode !== body) {
      body.innerHTML = '';
      mount(s, body, 'panel');
    } else fitNow(s);
  }

  async function newFree() {
    try {
      const info = await api.terminalOpen({ kind: 'free', ...guessSize(panelEl('termBody')) });
      adopt(info);
      panel.active = info.id;
      await refreshList();
      showPanel(true);
    } catch (err) {
      toast((err && err.message) || String(err), true);
    }
  }

  async function openCardInPanel() {
    const c = currentCard();
    if (!c) return;
    try {
      const s = await openCard(c, panelEl('termBody'));
      panel.active = s.id;
      if (s.place === 'tab' && s.el.isConnected) {
        // タブに出ているものは、パネルへ移す
        const tabBox = s.el.parentNode;
        mount(s, panelEl('termBody'), 'panel');
        placeholder(tabBox, s, 'panel', () => {
          mount(s, tabBox, 'tab');
          renderPanel();
        });
      }
      await refreshList();
      showPanel(true);
    } catch (err) {
      toast((err && err.message) || String(err), true);
    }
  }

  async function closeTerm(id) {
    try {
      await api.terminalClose(id);
    } catch (err) {
      toast((err && err.message) || String(err), true);
    }
    dispose(id);
    await refreshList();
  }

  function showPanel(open) {
    panel.open = open;
    panelEl('termPanel').classList.toggle('hidden', !open);
    const btn = panelEl('termBtn');
    if (btn) btn.classList.toggle('active', open);
    savePanelState();
    if (open) refreshList();
  }

  function togglePanel() {
    showPanel(!panel.open);
  }

  // ---- イベント ----
  function onData({ id, data } = {}) {
    const s = sessions.get(id);
    if (s && data) s.term.write(data);
  }

  function onExit({ id, code } = {}) {
    const s = sessions.get(id);
    if (!s || s.exited) return;
    s.exited = true;
    s.info.exited = true;
    const msg = code == null ? tr('[シェルは終了しました]') : tr('[シェルは終了しました（終了コード {code}）]', { code });
    s.term.write(`\r\n\x1b[2m${msg}\x1b[0m\r\n`);
    // タスクのタブで終わったら、もう一度開くボタンを出す
    if (s.place === 'tab' && s.el.parentNode) {
      const box = s.el.parentNode;
      if (!box.querySelector('[data-term-reopen]')) {
        const bar = document.createElement('div');
        bar.className = 'term-reopen';
        bar.innerHTML = `<button class="btn" type="button" data-term-reopen>${esc(tr('もう一度開く'))}</button>`;
        bar.querySelector('button').onclick = async () => {
          const c = currentCard();
          await closeTerm(s.id);
          if (c && box.isConnected) renderCardTab(box.parentNode, c);
        };
        box.appendChild(bar);
      }
    }
    refreshList();
  }

  /**
   * @param {object} o
   * @param {object} o.api  window.api
   * @param {(name: string) => string} [o.icon]
   * @param {(msg: string, isErr?: boolean) => void} [o.toast]
   * @param {() => object|null} [o.currentCard]
   */
  function init(o) {
    api = o.api;
    iconFn = o.icon || iconFn;
    toast = o.toast || toast;
    currentCard = o.currentCard || currentCard;
    api.onTerminalData(onData);
    api.onTerminalExit(onExit);
    let t = null;
    api.onTerminalChanged(() => {
      clearTimeout(t);
      t = setTimeout(refreshList, 150);
    });
    const p = panelEl('termPanel');
    if (!p) return;
    try {
      const h = parseInt(localStorage.getItem(PANEL_H_KEY), 10);
      if (h) setPanelHeight(h);
    } catch {
      /* */
    }
    panelEl('termNew').onclick = () => newFree();
    panelEl('termCardBtn').onclick = () => openCardInPanel();
    panelEl('termHide').onclick = () => showPanel(false);
    panelEl('termTabs').addEventListener('click', (e) => {
      const x = e.target.closest('[data-term-close]');
      if (x) {
        e.stopPropagation();
        closeTerm(x.dataset.termClose);
        return;
      }
      const sel = e.target.closest('[data-term-sel]');
      if (sel) {
        panel.active = sel.dataset.termSel;
        renderPanel();
      }
    });
    // 上の線をドラッグして高さを変える（ダブルクリックで元の高さ）
    const rz = panelEl('termResizer');
    rz.addEventListener('mousedown', (e) => {
      e.preventDefault();
      const startY = e.clientY;
      const startH = p.getBoundingClientRect().height;
      const move = (ev) => setPanelHeight(startH + (startY - ev.clientY));
      const up = () => {
        document.removeEventListener('mousemove', move);
        document.removeEventListener('mouseup', up);
        document.body.classList.remove('term-resizing');
      };
      document.body.classList.add('term-resizing');
      document.addEventListener('mousemove', move);
      document.addEventListener('mouseup', up);
    });
    rz.addEventListener('dblclick', () => {
      p.style.height = '';
      try {
        localStorage.removeItem(PANEL_H_KEY);
      } catch {
        /* */
      }
    });
    // Ctrl + `（Mac も Ctrl）でパネルを開け閉めする。ターミナルの中で押しても効くように、捕捉の段階で受け取る
    document.addEventListener(
      'keydown',
      (e) => {
        if (e.ctrlKey && !e.metaKey && !e.altKey && (e.key === '`' || e.code === 'Backquote')) {
          e.preventDefault();
          e.stopPropagation();
          togglePanel();
        }
      },
      true,
    );
    // テーマ（ライト・ダーク）が変わったら色を合わせる
    const mq = root.matchMedia && root.matchMedia('(prefers-color-scheme: light)');
    if (mq && mq.addEventListener) mq.addEventListener('change', () => {
      for (const s of sessions.values()) s.term.options.theme = theme();
    });
    try {
      if (localStorage.getItem(PANEL_OPEN_KEY)) showPanel(true);
    } catch {
      /* */
    }
  }

  // ボードが変わったとき（タスクを開いた・閉じた）: パネルの「このタスク」ボタンを合わせる
  function boardChanged() {
    if (panel.open) renderPanelTabs();
  }

  root.TerminalView = { init, renderCardTab, togglePanel, showPanel, boardChanged, refreshList, _sessions: sessions };
})(typeof window !== 'undefined' ? window : globalThis);
