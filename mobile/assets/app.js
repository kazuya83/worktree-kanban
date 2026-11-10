/* global I18n, tr, MobileApi, MobileMarkdown, MobileChat, BoardModel */
// スマホ用の画面（ペアリング・ボード・タスクの詳細・承認と質問・タスクを作る・通知）。
// サーバーからの文字列は textContent で入れる（innerHTML は使わない）。Markdown は markdown-dom.js が DOM を組み立てる
(function () {
  'use strict';
  const BM = BoardModel;
  const $ = (id) => document.getElementById(id);
  const COL_KEY = 'worktreeKanban.mobile.column';
  const IMG_TYPES = new Set(['image/png', 'image/jpeg', 'image/gif', 'image/webp']);
  const DIFF_MAX_LINES = 4000;

  // ---------------- 小さな道具 ----------------

  // h('div.cls', { onclick, title, ... }, 子...)。文字の子は textContent として入る
  function h(sel, props, ...kids) {
    const [tag, ...classes] = String(sel).split('.');
    const el = document.createElement(tag || 'div');
    if (classes.length) el.className = classes.join(' ');
    if (props) {
      for (const [k, v] of Object.entries(props)) {
        if (v === undefined || v === null || v === false) continue;
        if (k === 'class') el.className = [el.className, v].filter(Boolean).join(' ');
        else if (k === 'text') el.textContent = String(v);
        else if (k.startsWith('on') && typeof v === 'function') el[k] = v;
        else if (k === 'dataset') Object.assign(el.dataset, v);
        else if (k === 'value' || k === 'checked' || k === 'disabled' || k === 'type' || k === 'name' || k === 'placeholder' || k === 'rows' || k === 'selected') el[k] = v;
        else el.setAttribute(k, v === true ? '' : String(v));
      }
    }
    append(el, kids);
    return el;
  }
  function append(el, kids) {
    for (const k of kids.flat(Infinity)) {
      if (k === null || k === undefined || k === false || k === '') continue;
      el.appendChild(typeof k === 'object' && k.nodeType ? k : document.createTextNode(String(k)));
    }
    return el;
  }
  function clear(el) {
    while (el.firstChild) el.removeChild(el.firstChild);
    return el;
  }

  // モノクロのアイコン（24x24 の線）
  const ICONS = {
    back: ['M15 18l-6-6 6-6'],
    bell: ['M6 8a6 6 0 0 1 12 0c0 7 3 9 3 9H3s3-2 3-9', 'M10.3 21a1.94 1.94 0 0 0 3.4 0'],
    plus: ['M12 5v14', 'M5 12h14'],
    send: ['M22 2L11 13', 'M22 2l-7 20-4-9-9-4z'],
    stop: ['M7 7h10v10H7z'],
    play: ['M7 4l13 8-13 8z'],
    check: ['M20 6L9 17l-5-5'],
    x: ['M18 6L6 18', 'M6 6l12 12'],
    question: ['M12 2a10 10 0 1 0 0 20a10 10 0 1 0 0-20', 'M9.1 9a3 3 0 0 1 5.8 1c0 2-3 3-3 3', 'M12 17h.01'],
    alert: ['M10.3 3.9L1.8 18a2 2 0 0 0 1.7 3h17a2 2 0 0 0 1.7-3L13.7 3.9a2 2 0 0 0-3.4 0z', 'M12 9v4', 'M12 17h.01'],
    lock: ['M5 11h14v10H5z', 'M8 11V7a4 4 0 0 1 8 0v4'],
    folder: ['M3 7a2 2 0 0 1 2-2h4l2 2h8a2 2 0 0 1 2 2v9a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2z'],
    wrench: ['M14.7 6.3a4 4 0 0 0-5.4 5.4L3 18l3 3 6.3-6.3a4 4 0 0 0 5.4-5.4l-2.5 2.5-2.4-.6-.6-2.4z'],
    logout: ['M9 21H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h4', 'M16 17l5-5-5-5', 'M21 12H9'],
    edit: ['M12 20h9', 'M16.5 3.5a2.1 2.1 0 0 1 3 3L7 19l-4 1 1-4z'],
    pause: ['M8 5v14', 'M16 5v14'],
    chat: ['M21 15a2 2 0 0 1-2 2H7l-4 4V5a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2z'],
    terminal: ['M3 5h18v14H3z', 'M7 10l3 2-3 2', 'M13 15h4'],
    branch: ['M6 3v12', 'M18 9a3 3 0 1 0 0-6a3 3 0 1 0 0 6', 'M6 21a3 3 0 1 0 0-6a3 3 0 1 0 0 6', 'M18 9a9 9 0 0 1-9 9'],
  };
  function icon(name, cls) {
    const NS = 'http://www.w3.org/2000/svg';
    const svg = document.createElementNS(NS, 'svg');
    svg.setAttribute('viewBox', '0 0 24 24');
    svg.setAttribute('aria-hidden', 'true');
    svg.setAttribute('class', `ic${cls ? ` ${cls}` : ''}`);
    for (const d of ICONS[name] || []) {
      const p = document.createElementNS(NS, 'path');
      p.setAttribute('d', d);
      svg.appendChild(p);
    }
    return svg;
  }
  const NOTIF_ICON = { done: 'check', review: 'check', failed: 'alert', conflict: 'alert', question: 'question', permission: 'lock', schedule: 'alert' };

  function toast(msg, kind = 'error') {
    const t = $('toast');
    t.textContent = String(msg || '');
    t.className = `toast ${kind}`;
    clearTimeout(toast.timer);
    toast.timer = setTimeout(() => t.classList.add('hidden'), kind === 'error' ? 6000 : 2500);
  }
  // 操作を送る。押したボタンは終わるまで押せなくする。失敗は知らせる（401 はペアリングの画面に戻るので知らせない）
  async function run(fn, okMsg, btn) {
    if (btn) btn.disabled = true;
    try {
      const r = await fn();
      if (okMsg) toast(okMsg, 'ok');
      return r === undefined ? true : r;
    } catch (err) {
      if (!(err && err.status === 401)) toast((err && err.message) || String(err));
      return undefined;
    } finally {
      if (btn && btn.isConnected) btn.disabled = false;
    }
  }
  const invoke = (channel, arg) => S.client.invoke(channel, arg);

  function elapsed(since) {
    if (!since) return '';
    const s = Math.max(0, Math.floor((Date.now() - since) / 1000));
    if (s < 60) return tr('{s}秒', { s });
    if (s < 3600) return tr('{m}分{s}秒', { m: Math.floor(s / 60), s: s % 60 });
    return tr('{h}時間{m}分', { h: Math.floor(s / 3600), m: Math.floor((s % 3600) / 60) });
  }
  function timeAgo(t) {
    const s = Math.max(0, Math.floor((Date.now() - t) / 1000));
    if (s < 60) return tr('たった今');
    if (s < 3600) return tr('{n}分前', { n: Math.floor(s / 60) });
    if (s < 86400) return tr('{n}時間前', { n: Math.floor(s / 3600) });
    return new Date(t).toLocaleString(I18n.locale());
  }
  const logTime = (e) => (e && e.t ? new Date(e.t).toLocaleTimeString(I18n.locale()) : '');
  const folderName = (p) => String(p || '').replace(/[\\/]+$/, '').split(/[\\/]/).pop() || String(p || '');
  const nearBottom = (el) => el.scrollHeight - el.scrollTop - el.clientHeight < 80;

  // 言語: セッションの言語、無ければブラウザの言語
  function navigatorLanguage() {
    const list = (navigator.languages && navigator.languages.length ? navigator.languages : [navigator.language || 'en']).map((x) => String(x).toLowerCase());
    for (const l of list) {
      const code = l.split('-')[0];
      if (I18n.isLanguage(code)) return code;
    }
    return I18n.DEFAULT_LANGUAGE;
  }
  function setLanguage(code) {
    const next = I18n.isLanguage(code) ? code : navigatorLanguage();
    const changed = next !== I18n.getLanguage();
    I18n.setLanguage(next);
    document.documentElement.lang = next;
    return changed;
  }

  // ---------------- 状態 ----------------

  const readCol = () => {
    try {
      return localStorage.getItem(COL_KEY) || '';
    } catch {
      return '';
    }
  };
  const S = {
    client: null,
    loaded: false, // ボードを一度でも読めたか
    session: null,
    board: { settings: {}, cards: [], notifications: [], repoTabs: [] },
    model: BM.model([]),
    screen: '',
    col: readCol(),
    selected: null,
    tab: 'chat',
    logs: new Map(),
    logsVersion: new Map(),
    logsLoading: new Map(),
    chat: null, // ログのタブの項目（1件ずつ足す）
    chatSig: '',
    actionsSig: '',
    headSig: '',
    diff: null,
    conn: 'off', // off / connecting / open / retry
    unsubscribe: null,
    edit: null, // 編集しているカード（作る画面を編集に使う）
    notifSeen: new Set(),
    hiddenAt: 0,
  };
  const card = (id) => S.model.card(id);

  function setBoard(board) {
    if (!board || typeof board !== 'object' || !Array.isArray(board.cards)) return;
    S.loaded = true;
    S.board = { settings: {}, notifications: [], repoTabs: [], ...board };
    if (!S.board.settings) S.board.settings = {};
    S.model = BM.model(S.board.cards, S.board.boardColumns && S.board.boardColumns.config);
    // セッションの言語が無いとき（古いアプリ）は、ボードの設定の言語を使う
    if (!(S.session && S.session.language) && S.board.settings.language && setLanguage(S.board.settings.language)) renderAll();
  }

  // ---------------- 画面の切り替え（戻るボタンで戻れるように、深い画面は履歴に積む） ----------------

  const SCREENS = ['pair', 'board', 'detail', 'create', 'notif'];
  function show(name) {
    if (S.screen === 'notif' && name !== 'notif') leaveNotifications();
    S.screen = name;
    for (const s of SCREENS) $(`${s}Screen`).classList.toggle('hidden', s !== name);
    document.body.dataset.screen = name;
  }
  function go(name, extra = {}) {
    history.pushState({ screen: name, ...extra }, '');
    route({ screen: name, ...extra });
  }
  function back() {
    if (history.state && history.state.screen && history.state.screen !== 'board') history.back();
    else route({ screen: 'board' });
  }
  function route(st) {
    if (!S.client || !S.client.hasToken()) return showPair();
    const name = (st && st.screen) || 'board';
    if (name === 'detail' && st.id && card(st.id)) return openDetail(st.id);
    if (name === 'create') return openCreate(st.edit ? card(st.edit) : null);
    if (name === 'notif') return openNotifications();
    S.selected = null;
    show('board');
    renderBoard();
  }
  window.addEventListener('popstate', (e) => route(e.state));

  function renderAll() {
    if (S.screen === 'pair') return renderPair();
    if (S.screen === 'board') return renderBoard();
    if (S.screen === 'detail') {
      S.headSig = '';
      S.actionsSig = '';
      S.chatSig = '';
      return renderDetail();
    }
    if (S.screen === 'notif') return renderNotifications();
    if (S.screen === 'create') return openCreate(S.edit ? card(S.edit) : null);
  }

  // ---------------- ペアリング ----------------

  let pairError = '';
  let pairBusy = false;
  function showPair(msg) {
    stopEvents();
    if (msg) pairError = msg;
    show('pair');
    renderPair();
  }
  function renderPair() {
    const root = clear($('pairScreen'));
    const input = h('input.pair-code', {
      id: 'pairCode',
      type: 'text',
      inputmode: 'text',
      autocomplete: 'one-time-code',
      autocapitalize: 'characters',
      autocorrect: 'off',
      spellcheck: 'false',
      maxlength: '12',
      placeholder: 'ABCD2345',
      'aria-label': tr('ペアリングコード'),
    });
    const btn = h('button.btn.primary.block', { type: 'submit', disabled: pairBusy, text: pairBusy ? tr('つないでいます…') : tr('つなぐ') });
    const form = h(
      'form.pair-form',
      {
        onsubmit: (e) => {
          e.preventDefault();
          doPair(input.value);
        },
      },
      h('label.field', null, h('span', { text: tr('ペアリングコード（8 文字）') }), input),
      btn,
    );
    append(root, [
      h(
        'div.pair',
        null,
        h('img.pair-logo', { src: '/assets/icon-192.png', alt: '', width: '72', height: '72' }),
        h('h1', { text: 'Worktree Kanban' }),
        h('p.muted', { text: tr('デスクトップのアプリに出ているペアリングコードを入れてください。QR コードを読み取ったときは、自動で入ります。') }),
        form,
        pairError ? h('p.error-text', { role: 'alert', text: pairError }) : null,
        h('p.muted.small', { text: tr('このブラウザに、ログインの情報（トークン）を保存します。共用の端末では使わないでください。') }),
      ),
    ]);
  }
  async function doPair(raw) {
    const code = String(raw || '').replace(/[\s-]+/g, '').toUpperCase();
    if (code.length !== 8) {
      pairError = tr('コードは 8 文字です');
      return renderPair();
    }
    pairBusy = true;
    pairError = '';
    if (S.screen === 'pair') renderPair();
    try {
      await S.client.pair(code, MobileApi.deviceNameFromUA(navigator.userAgent));
      pairBusy = false;
      history.replaceState({ screen: 'board' }, '');
      await startApp();
    } catch (err) {
      pairBusy = false;
      pairError = (err && err.status === 0) ? tr('つながりませんでした。電波とアドレスを確かめてください') : (err && err.message) || String(err);
      show('pair');
      renderPair();
    }
  }

  // ---------------- 起動とイベント ----------------

  async function loadSession() {
    try {
      S.session = await S.client.session();
      if (S.session && setLanguage(S.session.language)) renderAll();
    } catch {
      /* つながらないときは、イベントがつながったときに読み直す */
    }
  }
  async function loadBoard() {
    try {
      setBoard(await invoke('board:get'));
    } catch (err) {
      if (!(err && err.status === 401)) toast((err && err.message) || String(err));
      return;
    }
    afterBoardChanged();
  }
  async function startApp() {
    S.selected = null;
    show('board');
    renderBoard();
    await loadSession();
    startEvents();
  }
  function startEvents() {
    stopEvents();
    S.conn = 'connecting';
    renderConn();
    S.unsubscribe = S.client.subscribe(onEvent, {
      onOpen: () => {
        S.conn = 'open';
        renderConn();
        // 切れていたあいだの変化は届いていないので、つながるたびに取り直す
        if (!S.session) loadSession();
        loadBoard();
        if (S.selected && S.logs.has(S.selected)) reloadLogs(S.selected);
      },
      onClose: () => {
        S.conn = 'retry';
        renderConn();
        if (!S.loaded && S.screen === 'board') renderBoard();
      },
    });
  }
  function stopEvents() {
    if (S.unsubscribe) S.unsubscribe();
    S.unsubscribe = null;
    S.conn = 'off';
  }
  function onEvent(name, data) {
    if (name === 'board:changed') {
      setBoard(data);
      afterBoardChanged();
    } else if (name === 'card:log' && data && data.id && data.entry) onLog(data.id, data.entry);
    // パソコンのアプリで、スマホからのターミナルの許可を変えた: 入口のボタンを出し直す
    else if (name === 'session:changed') loadSession().then(renderAll);
  }
  function afterBoardChanged() {
    if (S.screen === 'board') renderBoard();
    else if (S.screen === 'detail') {
      const c = card(S.selected);
      if (!c) {
        toast(tr('このタスクはボードから無くなりました'), 'info');
        return back();
      }
      renderDetail();
      ensureLogsFresh(c);
      markSeenIfOpen(c);
    } else if (S.screen === 'notif') renderNotifications();
    renderBellCount();
  }

  // 画面に戻ったとき: 裏で回線が切れていることがあるので、しばらく隠れていたら繋ぎ直す
  document.addEventListener('visibilitychange', () => {
    if (document.hidden) {
      S.hiddenAt = Date.now();
      return;
    }
    if (S.unsubscribe && S.hiddenAt && Date.now() - S.hiddenAt > 10000) S.unsubscribe.reconnect();
    S.hiddenAt = 0;
    const c = card(S.selected);
    if (S.screen === 'detail' && c) markSeenIfOpen(c);
  });

  // ---------------- ボード ----------------

  function renderConn() {
    const dot = document.querySelector('.conn-dot');
    if (!dot) return;
    dot.className = `conn-dot c-${S.conn}`;
    dot.title = S.conn === 'open' ? tr('つながっています') : S.conn === 'retry' ? tr('つなぎ直しています…') : tr('つないでいます…');
  }
  function renderBellCount() {
    const unread = (S.board.notifications || []).filter((n) => !n.read).length;
    document.querySelectorAll('.bell-count').forEach((el) => {
      el.textContent = unread > 99 ? '99+' : String(unread);
      el.classList.toggle('hidden', !unread);
    });
  }
  function bellButton() {
    return h('button.icon-btn.bell', { type: 'button', 'aria-label': tr('通知'), title: tr('通知'), onclick: () => go('notif') }, icon('bell'), h('span.bell-count.hidden'));
  }

  function repoTabsList() {
    const repo = S.board.settings.repoPath || '';
    const list = (S.board.repoTabs || []).filter((t) => t && t.path).map((t) => ({ ...t, remote: !!t.remote, active: 'active' in t ? !!t.active : t.path === repo }));
    if (repo && !list.some((t) => t.active)) list.push({ path: repo, running: 0, attention: 0, review: 0, active: true });
    return list;
  }
  async function switchRepo(t, btn) {
    const remote = S.board.remoteSession && S.board.remoteSession.role === 'client';
    const ok = await run(() => invoke('repo:switchTab', remote ? { path: t.path, remote: !!t.remote } : { path: t.path }), null, btn);
    if (ok !== undefined) await loadBoard();
  }

  function defaultColumn() {
    const m = S.model;
    const cols = m.columns();
    const withAttn = cols.find((col) => m.columnCards(col.key).some((c) => m.needsYou(c)));
    if (withAttn) return withAttn.key;
    // 動いている → レビュー → Todo の段階の列で、カードがあるもの
    for (const stage of ['running', 'review']) {
      const col = cols.find((x) => x.stage === stage && m.columnCards(x.key).length);
      if (col) return col.key;
    }
    return (cols.find((x) => x.stage === 'todo') || cols[0] || {}).key || '';
  }

  // パソコンのアプリで「スマホからのターミナルを許可」にしているか（ターミナルは別の画面 terminal.html）
  function terminalAllowed() {
    return !!(S.session && S.session.terminal);
  }
  // タスクのターミナルを開けるか（git のタスクは worktree ができてから）
  function cardTerminalReady(c) {
    return BM.isNoGit(c) || BM.isChat(c) ? !!c.repoPath : !!c.worktreePath;
  }

  function renderBoard() {
    const root = $('boardScreen');
    const list = root.querySelector('.card-list');
    const scroll = list ? list.scrollTop : 0;
    const prevCol = root.dataset.col;
    clear(root);
    const tabs = repoTabsList();
    const head = h(
      'header.topbar',
      null,
      h(
        'div.repo-tabs',
        { role: 'tablist' },
        tabs.length
          ? tabs.map((t) =>
              h(
                'button.repo-tab',
                { type: 'button', role: 'tab', 'aria-selected': String(t.active), class: t.active ? 'active' : '', title: t.path, onclick: (e) => !t.active && switchRepo(t, e.currentTarget) },
                icon('folder'),
                h('span.repo-name', { text: folderName(t.path) }),
                !t.active && t.attention ? h('span.pill.warn', { text: String(t.attention), title: tr('あなたの対応を待っているタスクが {attention} 件あります', { attention: t.attention }) }) : null,
                !t.active && t.running ? h('span.pill.run', { text: String(t.running), title: tr('動いているタスクが {running} 件あります', { running: t.running }) }) : null,
                !t.active && t.review ? h('span.pill.review', { text: String(t.review), title: tr('レビュー中のタスクが {review} 件あります', { review: t.review }) }) : null,
              ),
            )
          : h('span.muted.small', { text: tr('リポジトリがありません') }),
      ),
      h('span.conn-dot'),
      terminalAllowed() ? h('button.icon-btn', { type: 'button', 'aria-label': tr('ターミナル'), title: tr('ターミナル'), onclick: () => (location.href = '/terminal.html') }, icon('terminal')) : null,
      bellButton(),
      h('button.icon-btn', { type: 'button', 'aria-label': tr('ログアウト'), title: tr('ログアウト'), onclick: logout }, icon('logout')),
    );
    root.appendChild(head);
    if (!S.loaded) {
      root.appendChild(h('p.muted.pad.center', { text: S.conn === 'retry' ? tr('つながりません。つなぎ直しています…') : tr('読み込んでいます…') }));
      renderConn();
      renderBellCount();
      return;
    }
    if (!S.board.settings.repoPath) {
      root.appendChild(h('div.empty', null, h('h2', { text: tr('リポジトリが開かれていません') }), h('p.muted', { text: tr('デスクトップのアプリでリポジトリを開くと、ここにタスクが出ます。') })));
      renderConn();
      renderBellCount();
      return;
    }
    const m = S.model;
    const cols = m.columns();
    if (!S.col || !cols.some((c) => c.key === S.col)) S.col = defaultColumn();
    const colTabs = h(
      'nav.col-tabs',
      { role: 'tablist' },
      cols.map((col) => {
        const cards = m.columnCards(col.key);
        const attn = cards.some((c) => m.needsYou(c));
        return h(
          'button.col-tab',
          {
            type: 'button',
            role: 'tab',
            class: S.col === col.key ? 'active' : '',
            'aria-selected': String(S.col === col.key),
            onclick: () => {
              S.col = col.key;
              try {
                localStorage.setItem(COL_KEY, col.key);
              } catch {
                /* 覚えられなくてもよい */
              }
              renderBoard();
            },
          },
          h('span', { text: col.label() }),
          h('span.count', { text: String(cards.length) }),
          attn ? h('span.attn-dot', { title: tr('あなたの対応を待っているタスクがあります') }) : null,
        );
      }),
    );
    root.appendChild(colTabs);
    const cards = m.columnCards(S.col);
    const unread = BM.unreadCardIds(S.board.notifications);
    const curCol = cols.find((x) => x.key === S.col) || {};
    const emptyText = () => (curCol.stage === 'todo' ? tr('右下の「＋」からタスクを作れます') : tr('なし'));
    // レーンが2つ以上ある列は、レーンごとに見出しを付けて上下に区切る
    const body =
      curCol.lanes && curCol.lanes.length > 1
        ? curCol.lanes.map((l) => {
            const cs = cards.filter((c) => m.laneOf(c) === l.id);
            return h('section.lane-sec', null, h('h3.lane-title', null, h('span', { text: l.name }), h('span.count', { text: String(cs.length) })), cs.length ? cs.map((c) => cardEl(c, unread)) : h('p.muted.pad.center.small', { text: tr('なし') }));
          })
        : cards.length
          ? cards.map((c) => cardEl(c, unread))
          : h('p.muted.pad.center', { text: emptyText() });
    const listEl = h('div.card-list', null, body);
    root.appendChild(listEl);
    root.appendChild(h('button.fab', { type: 'button', 'aria-label': tr('新しいタスク'), title: tr('新しいタスク'), onclick: () => go('create') }, icon('plus')));
    root.dataset.col = S.col;
    if (prevCol === S.col) listEl.scrollTop = scroll;
    renderConn();
    renderBellCount();
  }

  function cardEl(c, unreadIds) {
    const m = S.model;
    const [bcls, blabel] = m.badge(c);
    const waiting = m.needsYou(c);
    const unread = m.isUnreadChat(c, S.selected) || unreadIds.has(c.id);
    const el = h(
      'article.card',
      { class: `s-${c.status}${waiting ? ' attn' : ''}`, tabindex: '0', onclick: () => go('detail', { id: c.id }) },
      h(
        'div.card-top',
        null,
        h('span.badge', { class: `b-${bcls}`, text: blabel }),
        unread ? h('span.unread-chip', { text: tr('未読') }) : null,
        c.status === 'running' && c.startedAt ? h('span.elapsed', { dataset: { since: String(c.startedAt) }, text: elapsed(c.startedAt) }) : null,
        c.costUsd ? h('span.cost', { text: `$${Number(c.costUsd).toFixed(2)}` }) : null,
      ),
      h('div.card-title', { text: c.title || '' }),
      c.error && c.status === 'failed' ? h('div.card-err', { text: c.error }) : null,
      c.lastMessage && !waiting ? h('div.card-msg', { text: MobileMarkdown.plain(c.lastMessage) }) : null,
      BM.isSpecPending(c) ? h('div.card-msg.card-spec', { text: tr('内容が詰まっていないので、開発を開始できません。開いて質問に答えてください') }) : null,
      BM.hasSubtaskProposal(c) ? h('div.card-msg.card-spec', { text: tr('サブタスクに分けて進めることを提案しています。開いて、サブタスクでやるかを選んでください') }) : null,
      quickQuestionEl(c),
      quickPermissionEl(c),
      BM.isInterrupted(c) ? h('div.quick', null, h('button.btn.primary', { type: 'button', onclick: stop((e) => run(() => invoke('card:resume', c.id), tr('再開しました'), e.currentTarget)) }, icon('play'), tr('再開'))) : null,
      c.branch ? h('div.card-meta', null, icon('branch'), h('span', { text: String(c.branch).replace(/^agent\//, '') })) : null,
    );
    return el;
  }
  // カードを開かずにボタンを押す
  const stop = (fn) => (e) => {
    e.stopPropagation();
    fn(e);
  };

  // ボードのカード: 1問だけの単一選択なら、その場で答えられる
  function quickQuestionEl(c) {
    const req = (c.questions || [])[0];
    if (!req || !Array.isArray(req.questions) || !req.questions.length) return null;
    const q = req.questions[0];
    const opts = Array.isArray(q.options) ? q.options : [];
    const quick = req.questions.length === 1 && !q.multiSelect && opts.length && opts.length <= 4;
    return h(
      'div.qbox',
      null,
      h('div.q-title', null, icon('question'), h('span', { text: `${q.header ? `${q.header}: ` : ''}${q.question || ''}` })),
      h(
        'div.quick',
        null,
        quick
          ? [
              ...opts.map((o) => h('button.btn', { type: 'button', title: o.description || '', text: o.label, onclick: stop((e) => run(() => invoke('card:answer', { id: c.id, reqId: req.id, answers: { [q.question]: o.label } }), tr('回答しました'), e.currentTarget)) })),
              h('button.btn.ghost', { type: 'button', text: tr('その他…'), onclick: stop(() => go('detail', { id: c.id })) }),
            ]
          : h('button.btn.primary', { type: 'button', text: tr('回答する（{n}問）', { n: req.questions.length }), onclick: stop(() => go('detail', { id: c.id })) }),
      ),
    );
  }
  // ボードのカード: 最初の承認待ちだけを短く
  function quickPermissionEl(c) {
    const reqs = c.permissions || [];
    if (!reqs.length) return null;
    const r = reqs[0];
    return h(
      'div.perm.compact',
      null,
      h('div.perm-title', null, icon('alert'), h('span', { text: tr('承認待ち: ') }), h('b', { text: r.toolName || '' })),
      r.summary ? h('code.perm-summary', { text: r.summary }) : null,
      h(
        'div.quick',
        null,
        h('button.btn.allow', { type: 'button', text: tr('許可'), onclick: stop((e) => answerPermission(c, r, 'allow', '', e.currentTarget)) }),
        h('button.btn.deny', { type: 'button', text: tr('拒否'), onclick: stop((e) => answerPermission(c, r, 'deny', '', e.currentTarget)) }),
      ),
      reqs.length > 1 ? h('div.muted.small', { text: tr('ほか {n} 件の承認待ち', { n: reqs.length - 1 }) }) : null,
    );
  }
  function answerPermission(c, r, decision, message, btn) {
    return run(() => invoke('card:permission', { id: c.id, reqId: r.id, decision, message: message || '' }), decision === 'deny' ? tr('拒否しました') : tr('許可しました'), btn);
  }

  async function logout() {
    if (!confirm(tr('この端末からログアウトしますか？もう一度使うには、ペアリングし直します。'))) return;
    stopEvents();
    try {
      await S.client.logout();
    } catch {
      /* サーバーに届かなくても、手元のトークンは消えている */
    }
    S.logs.clear();
    S.logsVersion.clear();
    S.board = { settings: {}, cards: [], notifications: [], repoTabs: [] };
    S.model = BM.model([]);
    S.loaded = false;
    pairError = '';
    history.replaceState(null, '');
    showPair();
  }

  setInterval(() => {
    document.querySelectorAll('.elapsed[data-since]').forEach((el) => (el.textContent = elapsed(Number(el.dataset.since))));
  }, 1000);

  // ---------------- タスクの詳細 ----------------

  function openDetail(id) {
    const c = card(id);
    if (!c) return route({ screen: 'board' });
    const fresh = S.selected !== id || S.screen !== 'detail';
    S.selected = id;
    if (fresh) {
      S.tab = 'chat';
      S.headSig = '';
      S.actionsSig = '';
      S.chatSig = '';
      S.chat = null;
      S.diff = null;
      buildDetail();
    }
    show('detail');
    renderDetail();
    markSeenIfOpen(c);
    if (!S.logs.has(id)) reloadLogs(id);
    else ensureLogsFresh(c);
  }

  // 詳細の骨組み（上の段・タブ・本文・下の入力欄）。中身は renderDetail で入れる
  function buildDetail() {
    const root = clear($('detailScreen'));
    const input = h('textarea.composer-input', { id: 'followInput', rows: 1 });
    input.addEventListener('input', () => autoGrow(input));
    const sendBtn = h('button.send-btn', { type: 'button', id: 'followBtn', 'aria-label': tr('送信'), title: tr('送信'), onclick: () => sendFollow(sendBtn) }, icon('send'));
    append(root, [
      h(
        'header.topbar.detail-top',
        null,
        h('button.icon-btn', { type: 'button', 'aria-label': tr('戻る'), title: tr('戻る'), onclick: back }, icon('back')),
        h('div.d-title', null, h('span.badge', { id: 'dBadge' }), h('h1', { id: 'dTitle' })),
        bellButton(),
      ),
      h('div.d-actions', { id: 'dActions' }),
      h('nav.seg', { id: 'dTabs', role: 'tablist' }),
      h('main.d-body', { id: 'dBody' }, h('div.chat-log', { id: 'dLog' }), h('div.d-attn', { id: 'dAttn' })),
      h('footer.composer', null, h('div.composer-mode.muted.small', { id: 'followMode' }), h('div.composer-row', null, input, sendBtn)),
    ]);
  }
  function autoGrow(el) {
    el.style.height = 'auto';
    el.style.height = `${Math.min(el.scrollHeight, Math.round(window.innerHeight * 0.35))}px`;
  }

  function renderDetail() {
    const c = card(S.selected);
    if (!c || !$('dBody')) return;
    renderBellCount();
    renderDetailHead(c);
    renderTabs(c);
    renderComposer(c);
    renderAttention(c);
    if (S.tab === 'chat') renderChatTab(c);
    else if (S.tab === 'diff' && !S.diff) loadDiff(c);
  }

  function renderDetailHead(c) {
    const m = S.model;
    const sig = JSON.stringify([I18n.getLanguage(), c.status, c.title, c.interrupted, c.afterDone, m.badge(c), m.canMove(c, 'done'), m.canMove(c, 'review'), c.worktreePath, terminalAllowed()]);
    if (sig === S.headSig) return;
    S.headSig = sig;
    const [bcls, blabel] = m.badge(c);
    const badge = $('dBadge');
    badge.className = `badge b-${bcls}`;
    badge.textContent = blabel;
    $('dTitle').textContent = c.title || '';
    const s = c.status;
    const btns = [];
    if (BM.isInterrupted(c)) btns.push(h('button.btn.primary', { type: 'button', onclick: (e) => run(() => invoke('card:resume', c.id), tr('再開しました'), e.currentTarget) }, icon('play'), tr('再開')));
    if (s === 'todo' && !BM.isInterrupted(c)) btns.push(h('button.btn.primary', { type: 'button', onclick: (e) => run(() => invoke('card:start', c.id), tr('開始しました'), e.currentTarget) }, icon('play'), tr('開始')));
    if (s === 'todo' && !BM.isChat(c)) btns.push(h('button.btn', { type: 'button', onclick: () => go('create', { edit: c.id }) }, icon('edit'), tr('編集')));
    if (s === 'running' || s === 'queued')
      btns.push(
        h('button.btn.danger', {
          type: 'button',
          onclick: (e) => {
            if (confirm(tr('「{title}」のエージェントを止めますか？', { title: c.title || '' }))) run(() => invoke('card:stop', c.id), tr('停止しました'), e.currentTarget);
          },
        }, icon('stop'), tr('停止')),
      );
    if (m.canMove(c, 'done'))
      btns.push(
        h('button.btn', {
          type: 'button',
          onclick: (e) => {
            const msg = !BM.isNoGit(c) && c.worktreePath
              ? tr('「{title}」を、マージせずに完了にします。worktree とブランチ {v} は残すので、あとで「レビュー」の列へ戻して続けられます。よろしいですか？', { title: c.title, v: c.branch || '' })
              : tr('「{title}」を完了にしますか？', { title: c.title || '' });
            if (confirm(msg)) run(() => invoke('card:move', { id: c.id, to: 'done' }), tr('完了にしました'), e.currentTarget);
          },
        }, icon('check'), tr('完了にする')),
      );
    if (terminalAllowed() && cardTerminalReady(c)) btns.push(h('button.btn', { type: 'button', onclick: () => (location.href = `/terminal.html#card=${encodeURIComponent(c.id)}`) }, icon('terminal'), tr('ターミナル')));
    if (m.canMove(c, 'review')) btns.push(h('button.btn', { type: 'button', onclick: (e) => run(() => invoke('card:move', { id: c.id, to: 'review' }), tr('レビューに戻しました'), e.currentTarget) }, tr('レビューに戻す')));
    const box = clear($('dActions'));
    append(box, btns);
    box.classList.toggle('hidden', !btns.length);
  }

  function renderTabs(c) {
    const nav = $('dTabs');
    const tabs = [
      ['chat', tr('チャット')],
      ['log', tr('ログ')],
    ];
    if (!BM.isChat(c) && !BM.isNoGit(c)) tabs.push(['diff', tr('差分')]);
    if (!tabs.some((t) => t[0] === S.tab)) setTab('chat');
    const sig = JSON.stringify([I18n.getLanguage(), S.tab, tabs]);
    if (nav.dataset.sig === sig) return;
    nav.dataset.sig = sig;
    clear(nav);
    for (const [key, label] of tabs) {
      nav.appendChild(h('button.seg-btn', { type: 'button', role: 'tab', class: S.tab === key ? 'active' : '', 'aria-selected': String(S.tab === key), text: label, onclick: () => setTab(key) }));
    }
  }
  function setTab(tab) {
    if (S.tab === tab) return;
    S.tab = tab;
    S.chatSig = '';
    S.chat = null;
    const c = card(S.selected);
    if (!c) return;
    renderTabs(c);
    const attn = $('dAttn');
    attn.classList.toggle('hidden', tab === 'diff');
    if (tab === 'chat') renderChatTab(c);
    else if (tab === 'log') renderLogTab(c);
    else if (tab === 'diff') {
      S.diff = null;
      loadDiff(c);
    }
    const body = $('dBody');
    if (tab !== 'diff') body.scrollTop = body.scrollHeight;
    else body.scrollTop = 0;
  }

  // ---- ログ ----

  async function reloadLogs(id) {
    const c = card(id);
    const version = c ? c.logsVersion : undefined;
    const cur = S.logsLoading.get(id);
    if (cur && cur.version === version) return cur.promise;
    const flight = { version };
    flight.promise = (async () => {
      let logs;
      try {
        logs = await invoke('card:logs', id);
      } catch (err) {
        if (!(err && err.status === 401)) toast((err && err.message) || String(err));
        logs = null;
      }
      if (S.logsLoading.get(id) !== flight) return;
      S.logsLoading.delete(id);
      if (!Array.isArray(logs)) return;
      S.logs.set(id, logs);
      S.logsVersion.set(id, version);
      if (S.selected === id && S.screen === 'detail') {
        S.chatSig = '';
        S.chat = null;
        const now = card(id);
        if (!now) return;
        if (S.tab === 'chat') renderChatTab(now, true);
        else if (S.tab === 'log') renderLogTab(now, true);
        // 読んでいるあいだに版が進んでいたら、もう一度
        if (now.logsVersion !== version) reloadLogs(id);
      }
    })();
    S.logsLoading.set(id, flight);
    return flight.promise;
  }
  function ensureLogsFresh(c) {
    if (!c || !S.logs.has(c.id)) return;
    if (S.logsVersion.get(c.id) !== c.logsVersion) reloadLogs(c.id);
  }
  function onLog(id, entry) {
    if (!S.logs.has(id)) return;
    const c = card(id);
    // 戻したあとは版が進んでいる。読み直す前に足すと、捨てたログの末尾に新しい行が残る
    if (c && S.logsVersion.get(id) !== c.logsVersion) return;
    S.logs.get(id).push(entry);
    if (S.selected !== id || S.screen !== 'detail' || !c) return;
    if (S.tab === 'log') appendLog(c, entry);
    else if (S.tab === 'chat') renderChatTab(c);
  }

  const agentNameOf = (c, agent) => (agent && agent !== BM.agentOf(c) ? BM.agentShort(agent) : BM.whoShort(c, agent));
  function chatHead(c, agent, e) {
    return h('div.c-head', null, h('b.c-name', { text: agentNameOf(c, agent) }), h('span.c-time', { text: logTime(e) }));
  }
  function mdEl(text) {
    const box = h('div.md');
    box.appendChild(MobileMarkdown.render(document, text || '', { copyLabel: tr('コピー') }));
    return box;
  }
  function imagesEl(images) {
    if (!Array.isArray(images) || !images.length) return null;
    return h(
      'div.log-imgs',
      null,
      images.map((im) =>
        im && IMG_TYPES.has(im.mediaType) && typeof im.data === 'string' && /^[A-Za-z0-9+/]+=*$/.test(im.data)
          ? h('img.log-img', { src: `data:${im.mediaType};base64,${im.data}`, alt: tr('画像') })
          : h('span.muted.small', { text: tr('画像（{v}）', { v: (im && im.omitted) || tr('表示できません') }) }),
      ),
    );
  }
  function attachmentsEl(list) {
    if (!Array.isArray(list) || !list.length) return null;
    return h('div.attach-files', null, list.map((a) => h('span.attach-chip', { text: a && a.name ? a.name : '' })));
  }
  function chatItemEl(c, it, open) {
    const e = it.entry;
    const agent = BM.agentOf(c);
    if (it.type === 'user') return h('div.c-row.c-user', null, h('div.c-bubble', { title: logTime(e) }, e.skill ? h('div.c-skill', { text: `/${e.skill}` }) : null, mdEl(e.text), imagesEl(e.images), attachmentsEl(e.attachments)));
    if (it.type === 'assistant') return h('div.c-row.c-agent', null, it.head ? chatHead(c, it.agent || agent, e) : null, h('div.c-text', null, mdEl(e.text), imagesEl(e.images)));
    if (it.type === 'tool') {
      const r = it.result;
      const [name, arg] = e ? MobileChat.splitTool(e.text) : [tr('ツールの結果'), ''];
      const err = r && r.kind === 'tool_error';
      const det = h(
        'details.c-tool',
        { class: err ? 'err' : '' },
        h('summary', null, icon('wrench'), h('span.c-tool-name', { text: name }), h('span.c-tool-arg', { text: arg }), err ? h('span.c-tool-st', { text: tr('エラー') }) : null),
        r && r.text ? h('pre.c-tool-out', { text: r.text }) : h('div.c-tool-out.muted.small', { text: r ? tr('（出力はありません）') : tr('（結果はまだありません）') }),
      );
      if (open) det.open = true;
      return h('div.c-row.c-agent.c-toolrow', null, it.head ? chatHead(c, it.agent || agent, e || r) : null, det, r ? imagesEl(r.images) : null);
    }
    const k = e.kind;
    const NOTE = { result: 'check', error: 'alert', question: 'question', permission: 'lock' };
    const body = k === 'question' || k === 'result' ? mdEl(e.text) : h('span.c-note-x', { text: e.text || '' });
    return h('div.c-note', { class: `k-${String(k || '').replace(/[^a-z_]/g, '')}`, title: logTime(e) }, NOTE[k] ? icon(NOTE[k]) : null, body, imagesEl(e.images));
  }

  function renderChatTab(c, force) {
    const box = $('dLog');
    if (!box) return;
    const body = $('dBody');
    const logs = S.logs.get(c.id);
    const running = c.status === 'running';
    const items = logs ? MobileChat.final(logs, BM.agentOf(c), running) : [];
    const last = items[items.length - 1];
    const sig = JSON.stringify([I18n.getLanguage(), !!logs, running, items.length, last && last.entry && last.entry.t, last && last.entry && String(last.entry.text || '').length]);
    if (!force && sig === S.chatSig) return;
    S.chatSig = sig;
    const stick = nearBottom(body) || !box.childNodes.length;
    clear(box);
    if (!logs) box.appendChild(h('p.muted.pad.center', { text: tr('読み込んでいます…') }));
    else if (!items.length && !running) box.appendChild(h('p.muted.pad', { text: BM.isChat(c) ? tr('まだ会話はありません。') : tr('まだ返事はありません。「開始」を押すと {v} が動き出します。', { v: BM.agentLabel(BM.agentOf(c)) }) }));
    for (const it of items) box.appendChild(chatItemEl(c, it, false));
    if (running) box.appendChild(h('div.c-note.k-working', null, h('span.spinner'), h('span.c-note-x', { text: tr('{v} が作業しています…（途中の様子は「ログ」で見られます）', { v: BM.whoShort(c) }) })));
    if (stick) body.scrollTop = body.scrollHeight;
  }
  function renderLogTab(c) {
    const box = $('dLog');
    if (!box) return;
    const body = $('dBody');
    const logs = S.logs.get(c.id);
    clear(box);
    if (!logs) {
      box.appendChild(h('p.muted.pad.center', { text: tr('読み込んでいます…') }));
      S.chat = null;
      return;
    }
    const items = MobileChat.build(logs, BM.agentOf(c));
    S.chat = { id: c.id, items };
    for (const it of items) box.appendChild(chatItemEl(c, it, false));
    if (!items.length) box.appendChild(h('p.muted.pad', { text: tr('まだログはありません') }));
    body.scrollTop = body.scrollHeight;
  }
  // 実行中に届いたログを1件ずつ足す（ツールの結果は、呼び出しの折りたたみの中に入れ直す）
  function appendLog(c, entry) {
    const box = $('dLog');
    if (!box || !S.chat || S.chat.id !== c.id) return renderLogTab(c);
    const body = $('dBody');
    const stick = nearBottom(body);
    const r = MobileChat.push(S.chat.items, entry, BM.agentOf(c));
    if (!r) return;
    const lastEl = box.lastElementChild;
    if (r.op === 'replace' && lastEl && lastEl.classList.contains('c-row')) {
      const open = !!lastEl.querySelector('details[open]');
      box.replaceChild(chatItemEl(c, r.item, open), lastEl);
    } else {
      const empty = box.querySelector('p.muted.pad');
      if (empty) empty.remove();
      box.appendChild(chatItemEl(c, r.item, false));
    }
    if (stick) body.scrollTop = body.scrollHeight;
  }

  // 開いている会話に返事が来ていたら、読んだことにする（既読にできなくてもエラーにはしない）
  const markSeenFailed = new Set();
  function markSeenIfOpen(c) {
    if (!c || !BM.isChat(c) || !c.unread || BM.isActive(c) || document.hidden || markSeenFailed.has(c.id)) return;
    markSeenFailed.add(c.id);
    invoke('card:markSeen', c.id).then(
      () => markSeenFailed.delete(c.id),
      () => {},
    );
  }

  // ---- 差分 ----

  async function loadDiff(c) {
    const box = $('dLog');
    $('dAttn').classList.add('hidden');
    clear(box).appendChild(h('p.muted.pad.center', { text: tr('読み込んでいます…') }));
    const id = c.id;
    let text;
    try {
      text = c.worktreePath || c.status === 'done' ? await invoke('card:diff', id) : '';
    } catch (err) {
      if (!(err && err.status === 401)) toast((err && err.message) || String(err));
      text = null;
    }
    if (S.selected !== id || S.tab !== 'diff') return;
    S.diff = { id, text };
    clear(box);
    if (text === null) return box.appendChild(h('p.muted.pad', { text: tr('差分を読めませんでした') }));
    if (!String(text || '').trim()) return box.appendChild(h('p.muted.pad', { text: tr('変更はまだありません') }));
    const lines = String(text).split('\n');
    const pre = h('pre.diff');
    for (const line of lines.slice(0, DIFF_MAX_LINES)) {
      const cls = /^diff --git /.test(line) ? 'd-file' : /^(\+\+\+|---) /.test(line) ? 'd-meta' : /^@@/.test(line) ? 'd-hunk' : line[0] === '+' ? 'd-add' : line[0] === '-' ? 'd-del' : '';
      pre.appendChild(h('span', { class: cls, text: `${line}\n` }));
    }
    box.appendChild(h('button.btn.ghost.small', { type: 'button', text: tr('読み直す'), onclick: () => loadDiff(card(id) || c) }));
    box.appendChild(pre);
    if (lines.length > DIFF_MAX_LINES) box.appendChild(h('p.muted.small.pad', { text: tr('長いので、最初の {n} 行だけを出しています。全体はデスクトップのアプリで見てください。', { n: DIFF_MAX_LINES }) }));
  }

  // ---- あなたの操作を待っているもの（承認・質問・仕様の確認・回答待ち・サブタスク・中断・エラー） ----

  function renderAttention(c) {
    const box = $('dAttn');
    if (!box) return;
    const m = S.model;
    const kids = BM.hasSubtasks(c) ? c.subtasks.items.map((x) => {
      const k = x.cardId ? card(x.cardId) : null;
      return [x.key, x.state, x.title, k && k.status, k && m.subtaskNeedsCheck(k)];
    }) : [];
    const sig = JSON.stringify([I18n.getLanguage(), c.id, c.status, c.error, c.interrupted, c.conflict, c.permissions, c.questions, c.specState, c.specQuestions, c.awaitingReply, c.subtaskProposal, c.subtasks && c.subtasks.phase, kids, m.subtaskNeedsCheck(c), c.afterDone]);
    box.classList.toggle('hidden', S.tab === 'diff');
    if (sig === S.actionsSig) return;
    const body = $('dBody');
    const stick = nearBottom(body);
    const grew = !box.childNodes.length;
    S.actionsSig = sig;
    clear(box);
    const who = BM.agentShort(BM.agentOf(c));
    const s = c.status;
    if (BM.isInterrupted(c)) box.appendChild(interruptedEl(c));
    else if (c.error && (s === 'failed' || s === 'review')) box.appendChild(h('div.d-error', { text: c.error }));
    if (c.conflict && !c.conflict.resolving) box.appendChild(h('div.box.warn', null, h('b', null, icon('alert'), tr('{target} とコンフリクトしています', { target: c.conflict.target || '' })), h('small', { text: tr('コンフリクトの解消は、デスクトップのアプリで行ってください。') })));
    if (m.subtaskNeedsCheck(c)) {
      box.appendChild(h('div.box', null, h('small', { text: tr('差分タブで変更を確かめてから取り込んでください。直してほしいときは、下の欄から追加の指示を送れます。') }), h('button.btn.primary', { type: 'button', onclick: (e) => run(() => invoke('subtasks:approve', c.id), tr('取り込みました'), e.currentTarget) }, tr('親のタスクに取り込む'))));
    }
    for (const r of c.permissions || []) box.appendChild(permissionEl(c, r));
    for (const req of c.questions || []) box.appendChild(questionFormEl(c, req, who));
    if (BM.isSpecPending(c)) {
      const qs = BM.specQuestions(c);
      box.appendChild(h('div.box.spec', null, h('b', null, icon('question'), tr('内容が詰まっていないので、開発を開始できません')), h('small', { text: qs ? tr('このすぐ下のフォームで {who} の質問に答えて、仕様を詰めてください。', { who }) : tr('下の欄で、上の {who} の質問に答えて仕様を詰めてください。', { who }) })));
      if (qs) box.appendChild(specFormEl(c, qs, who));
    } else if (BM.hasSubtaskProposal(c)) box.appendChild(subtaskProposalEl(c, who));
    else if (c.awaitingReply && (s === 'review' || s === 'failed')) {
      box.appendChild(h('div.box', null, h('b', null, icon('chat'), tr('{who} が質問しています', { who })), h('small', { text: tr('下の欄に答えを書いて送ると、同じ会話の続きから進めます。') })));
    }
    if (BM.hasSubtasks(c)) box.appendChild(subtaskListEl(c));
    if (stick || (grew && box.childNodes.length)) body.scrollTop = body.scrollHeight;
  }

  function interruptedEl(c) {
    const it = c.interrupted || {};
    const how = it.kind === 'queued' ? tr('待機中だった指示を、そのままもう一度渡して始めます。') : c.sessionId ? tr('同じ会話の続きとして、中断したところから作業を続けてもらいます。') : tr('最後に渡した指示で、もう一度始めます。');
    return h(
      'div.box.warn',
      null,
      h('b', null, icon('pause'), tr('アプリの終了で中断されました')),
      it.at ? h('span.muted.small', { text: new Date(it.at).toLocaleString(I18n.locale()) }) : null,
      h('small', { text: how }),
      h('div.row', null, h('button.btn.primary', { type: 'button', onclick: (e) => run(() => invoke('card:resume', c.id), tr('再開しました'), e.currentTarget) }, icon('play'), tr('再開'))),
    );
  }

  function permissionEl(c, r) {
    const reason = h('input.deny-reason', { type: 'text', placeholder: tr('拒否する理由（任意・{v} に伝わります）', { v: BM.agentShort(BM.agentOf(c)) }) });
    return h(
      'div.perm',
      null,
      h('div.perm-title', null, icon('alert'), h('span', { text: tr('承認待ち: ') }), h('b', { text: r.toolName || '' })),
      r.summary ? h('code.perm-summary', { text: r.summary }) : null,
      r.detail ? h('details', null, h('summary', { text: tr('入力の全文') }), h('pre', { text: r.detail })) : null,
      reason,
      h(
        'div.row',
        null,
        h('button.btn.allow', { type: 'button', text: tr('許可'), onclick: (e) => answerPermission(c, r, 'allow', '', e.currentTarget) }),
        h('button.btn.deny', { type: 'button', text: tr('拒否'), onclick: (e) => answerPermission(c, r, 'deny', reason.value.trim(), e.currentTarget) }),
        h('button.btn.ghost', { type: 'button', text: tr('常に許可'), title: tr('このタスクでは {toolName} を今後も自動で許可', { toolName: r.toolName || '' }), onclick: (e) => answerPermission(c, r, 'always', '', e.currentTarget) }),
      ),
    );
  }

  // 質問ひとつずつの選択肢と自由入力。collect() で { 質問: 答え } を返す（複数選択は「, 」でつなぐ）
  let formSeq = 0;
  function questionItems(questions) {
    const seq = ++formSeq;
    const rows = questions.map((q, i) => {
      const opts = Array.isArray(q.options) ? q.options : [];
      const name = `q${seq}-${i}`;
      const type = q.multiSelect ? 'checkbox' : 'radio';
      const other = opts.length ? h('input.q-other', { type: 'text', placeholder: tr('自由に入力') }) : h('textarea.q-other', { rows: 2, placeholder: tr('自由に入力') });
      const inputs = [];
      const el = h(
        'div.q-item',
        null,
        h('div.q-head', null, q.header ? h('span.q-chip', { text: q.header }) : null, h('span', { text: q.question || '' }), q.multiSelect && opts.length ? h('span.muted.small', { text: tr('（複数選べます）') }) : null),
        opts.length
          ? h(
              'div.q-opts',
              null,
              opts.map((o) => {
                const inp = h('input', { type, name, value: o.label });
                inputs.push(inp);
                return h('label.q-opt', null, inp, h('span', null, h('b', { text: o.label }), o.description ? h('small', { text: o.description }) : null));
              }),
              (() => {
                const inp = h('input', { type, name, value: '__other__' });
                inputs.push(inp);
                other.addEventListener('focus', () => {
                  if (type === 'radio') inp.checked = true;
                });
                return h('label.q-opt.other', null, inp, h('span', null, h('b', { text: tr('その他') }), other));
              })(),
            )
          : other,
      );
      return { q, el, inputs, other };
    });
    const collect = () => {
      const answers = {};
      for (const r of rows) {
        const text = r.other.value.trim();
        const picked = r.inputs.filter((x) => x.checked).map((x) => x.value);
        const vals = picked.filter((v) => v !== '__other__');
        if (text && (picked.includes('__other__') || !vals.length || r.q.multiSelect)) vals.push(text);
        answers[r.q.question] = vals.join(', ');
      }
      return answers;
    };
    return { els: rows.map((r) => r.el), collect };
  }

  function questionFormEl(c, req, who) {
    const qs = Array.isArray(req.questions) ? req.questions : [];
    const f = questionItems(qs);
    return h(
      'div.qform',
      null,
      h('div.q-title', null, icon('question'), tr('{v2} からの質問', { v2: who })),
      f.els,
      h(
        'div.row',
        null,
        h('button.btn.primary', { type: 'button', text: tr('回答する'), onclick: (e) => run(() => invoke('card:answer', { id: c.id, reqId: req.id, answers: f.collect() }), tr('回答しました'), e.currentTarget) }),
        h('button.btn.ghost', { type: 'button', text: tr('答えずに続ける'), title: tr('{v} に、妥当だと思う方法で進めてもらいます', { v: who }), onclick: (e) => run(() => invoke('card:answer', { id: c.id, reqId: req.id, answers: null }), tr('そのまま続けてもらいます'), e.currentTarget) }),
      ),
    );
  }

  function specFormEl(c, qs, who) {
    const f = questionItems(qs);
    const note = h('textarea.q-note', { rows: 2, placeholder: tr('ほかに伝えたいことがあれば') });
    const can = BM.canSendFollow(c);
    const send = async (auto, btn) => {
      const answers = auto ? {} : f.collect();
      const n = note.value.trim();
      if (!auto && !n && !Object.values(answers).some(Boolean)) return toast(tr('どれかの質問に答えてください（すべて任せるときは「おまかせで進める」）'));
      await run(() => invoke('card:send', { id: c.id, message: BM.specAnswerMessage(qs, answers, n, auto), skill: null }), auto ? tr('おまかせで進めてもらいます') : tr('回答を送りました'), btn);
    };
    return h(
      'div.qform.spec-qform',
      null,
      h('div.q-title', null, icon('question'), tr('仕様の質問に答える')),
      f.els,
      h('div.q-item', null, h('div.q-head', { text: tr('補足（任意）') }), note),
      h(
        'div.row',
        null,
        h('button.btn.primary', { type: 'button', disabled: !can, text: tr('回答して送る'), onclick: (e) => send(false, e.currentTarget) }),
        h('button.btn.ghost', { type: 'button', disabled: !can, text: tr('おまかせで進める'), title: tr('答えていない質問は、{v4} に妥当な案で決めてもらいます', { v4: who }), onclick: (e) => send(true, e.currentTarget) }),
      ),
      h('small.muted', { text: tr('答えていない質問は「おまかせ」として送ります。下の欄に文章で書いて送ってもかまいません。') }),
    );
  }

  function subtaskProposalEl(c, who) {
    const items = c.subtaskProposal.items || [];
    const merge = (S.board.settings || {}).subtaskMerge === 'review' ? 'review' : 'auto';
    return h(
      'div.box.spec',
      null,
      h('b', null, icon('branch'), tr('{who} が、{n} 個のサブタスクに分けて進めることを提案しています', { who, n: items.length })),
      h('ol.sub-list', null, items.map((x) => h('li', null, h('b', { text: x.title || '' }), x.prompt ? h('div.muted.small', { text: x.prompt }) : null))),
      h('small', { text: tr('名前や指示を直すときは、デスクトップのアプリで行ってください。ほかの分け方にしてほしいときは、下の欄に文章で書いて送ってください。') }),
      h(
        'div.row',
        null,
        h('button.btn.primary', { type: 'button', onclick: (e) => run(() => invoke('subtasks:accept', { id: c.id, items, merge, createIssues: false }), tr('サブタスクを始めました'), e.currentTarget) }, icon('play'), tr('サブタスクでやる')),
        h('button.btn', { type: 'button', text: tr('分けずに進める'), onclick: (e) => run(() => invoke('subtasks:decline', c.id), tr('分けずに進めてもらいます'), e.currentTarget) }),
      ),
    );
  }

  const SUB_STATE = () => ({ pending: tr('未着手'), running: tr('作業中'), review: tr('取り込み済み'), merged: tr('完了'), done: tr('完了（取り込まず）'), skipped: tr('取りやめ') });
  function subtaskListEl(c) {
    const m = S.model;
    const startable = !BM.isActive(c) && c.status !== 'done' && !c.conflict;
    const items = c.subtasks.items;
    const det = h(
      'details.box.subtasks',
      null,
      h('summary', { text: tr('サブタスク（{n}）', { n: items.length }) }),
      items.map((x) => {
        const k = x.cardId && x.state === 'running' ? card(x.cardId) : null;
        const label = k ? m.badge(k)[1] : SUB_STATE()[x.state] || String(x.state || '');
        return h(
          'div.sub-item',
          null,
          h('div.sub-head', null, h('span.badge', { class: k ? `b-${m.badge(k)[0]}` : `b-${x.state === 'merged' ? 'done' : 'todo'}`, text: label }), h('b', { text: x.title || '' })),
          h(
            'div.row',
            null,
            k ? h('button.btn.small', { type: 'button', text: tr('開く'), onclick: () => go('detail', { id: k.id }) }) : null,
            x.state === 'pending' && startable ? h('button.btn.small', { type: 'button', onclick: (e) => run(() => invoke('subtasks:startOne', { id: c.id, key: x.key }), tr('サブタスクを開始しました'), e.currentTarget) }, icon('play'), tr('開始')) : null,
            k && m.subtaskNeedsCheck(k) ? h('button.btn.small.primary', { type: 'button', text: tr('取り込む'), onclick: (e) => run(() => invoke('subtasks:approve', k.id), tr('取り込みました'), e.currentTarget) }) : null,
          ),
        );
      }),
    );
    det.open = BM.subtasksRunning(c) || c.status === 'todo';
    return det;
  }

  // ---- 下の入力欄（実行中は btw、終わったあとは追加指示） ----

  function renderComposer(c) {
    const mode = BM.composerMode(c);
    const input = $('followInput');
    const btn = $('followBtn');
    const who = BM.agentShort(BM.agentOf(c));
    const nonClaude = BM.agentOf(c) !== 'claude';
    const ph =
      mode === 'btw'
        ? c.status === 'running' && (c.questions || []).length
          ? tr('{v} が質問の返事を待っています。送ると、質問への返事として渡します', { v: who })
          : c.status === 'queued'
          ? tr('待機中なので、開始するときの指示に付け足します')
          : nonClaude
            ? tr('今の作業は続け、終わったあとに追加指示として送ります')
            : tr('作業を止めずに、実行中のエージェントに伝えます')
        : mode === 'send'
          ? BM.isChat(c)
            ? tr('メッセージを送る。同じ会話の続きとして話せます')
            : BM.isSpecPending(c)
              ? tr('質問への答えを書く。分からないところは「おまかせ」と書いてもかまいません')
              : c.awaitingReply
                ? tr('{v} への回答を書く', { v: who })
                : c.status === 'done'
                  ? tr('完了したタスクについて話す。ファイルは変えずに答えます')
                  : tr('追加の指示を送る。同じセッションの続きとして動きます')
          : c.afterDone
            ? tr('返事が来たら、続きを話せます')
            : c.status === 'todo'
              ? tr('開始すると、終わったあとに追加の指示を送れます')
              : tr('エージェントの作業中は送れません');
    input.placeholder = ph;
    input.disabled = mode === 'off';
    btn.disabled = mode === 'off';
    $('followMode').textContent = mode === 'btw' ? tr('btw（作業中に差し込む）') : '';
    $('followMode').classList.toggle('hidden', mode !== 'btw');
  }
  async function sendFollow(btn) {
    const c = card(S.selected);
    const input = $('followInput');
    const msg = input.value.trim();
    if (!c || !msg) return;
    const mode = BM.composerMode(c);
    let ok;
    if (mode === 'btw') ok = await run(() => invoke('card:btw', { id: c.id, text: msg }), tr('送りました'), btn);
    else if (mode === 'send') ok = await run(() => invoke('card:send', { id: c.id, message: msg, skill: null }), null, btn);
    else return;
    if (ok !== undefined) {
      input.value = '';
      autoGrow(input);
    }
  }

  // ---------------- タスクを作る（編集にも使う） ----------------

  let skillsCache = null;
  async function loadSkills() {
    if (skillsCache) return skillsCache;
    try {
      const list = await invoke('skills:list');
      skillsCache = Array.isArray(list) ? list : [];
    } catch {
      skillsCache = [];
    }
    return skillsCache;
  }

  function openCreate(editCard) {
    S.edit = editCard ? editCard.id : null;
    show('create');
    const root = clear($('createScreen'));
    const settings = S.board.settings || {};
    const title = h('input', { id: 'nTitle', type: 'text', placeholder: tr('例: ログイン画面にパスワード表示ボタンを追加'), value: editCard ? editCard.title || '' : '' });
    const prompt = h('textarea', { id: 'nPrompt', rows: 8, placeholder: tr('やってほしいことを具体的に書いてください。テストの実行方法なども書いておくと確実です。'), value: editCard ? editCard.prompt || '' : '' });
    const skill = h('select', { id: 'nSkill' }, h('option', { value: '', text: tr('使わない') }));
    let skillValue = editCard ? editCard.skill || '' : settings.defaultSkill || '';
    if (skillValue) skill.appendChild(h('option', { value: skillValue, text: `/${skillValue}`, selected: true }));
    loadSkills().then((list) => {
      if (!skill.isConnected) return;
      const cur = skill.value;
      clear(skill).appendChild(h('option', { value: '', text: tr('使わない') }));
      const names = new Set(list.map((x) => x && x.name).filter(Boolean));
      if (cur && !names.has(cur)) skill.appendChild(h('option', { value: cur, text: `/${cur}` }));
      for (const s of list) if (s && s.name) skill.appendChild(h('option', { value: s.name, text: `/${s.name}`, title: s.description || '' }));
      skill.value = cur;
    });
    skill.onchange = () => (skillValue = skill.value);
    const fields = [
      h('label.field', null, h('span', { text: tr('タイトル（省略すると指示の1行目）') }), title),
    ];
    let agent = null;
    let readOnly = null;
    let autoStart = null;
    if (!editCard) {
      const choice = BM.agentChoices(settings);
      agent = h(
        'select',
        { id: 'nAgent' },
        choice.groups.map((g) => h('optgroup', { label: g.label }, g.options.map((o) => h('option', { value: o.value, text: o.label, disabled: !!o.disabled, selected: o.value === choice.value && !o.disabled })))),
      );
      if (choice.value) agent.value = choice.value;
      fields.push(h('label.field', null, h('span', { text: tr('エージェント') }), agent));
    }
    fields.push(h('label.field', null, h('span', { text: tr('エージェントへの指示') }), prompt));
    fields.push(h('label.field', null, h('span', { text: tr('スキル') }), skill));
    if (!editCard) {
      readOnly = h('input', { type: 'checkbox', id: 'nReadOnly' });
      autoStart = h('input', { type: 'checkbox', id: 'nStart', checked: true });
      fields.push(h('label.check', null, readOnly, h('span', { text: tr('ソースを変更しない（調べもの・SQL などの生成だけ）') })));
      fields.push(h('label.check', null, autoStart, h('span', { text: tr('作成したらすぐに開始する') })));
    }
    const ok = h('button.btn.primary.block', { type: 'submit', text: editCard ? tr('保存') : tr('作成') });
    const form = h(
      'form.create-form',
      {
        onsubmit: async (e) => {
          e.preventDefault();
          if (!prompt.value.trim() && !title.value.trim()) return toast(tr('指示を書いてください'));
          if (editCard) {
            const r = await run(() => invoke('card:update', { id: editCard.id, title: title.value, prompt: prompt.value, skill: skill.value || null }), tr('保存しました'), ok);
            if (r !== undefined) back();
            return;
          }
          const id = await run(
            () => invoke('card:create', { title: title.value, prompt: prompt.value, autoStart: autoStart.checked, skill: skill.value || null, agent: agent.value, readOnly: readOnly.checked || undefined }),
            null,
            ok,
          );
          if (id === undefined || typeof id !== 'string') return;
          // board:changed は少し遅れて届くので、まだ無ければ取り直してから開く
          if (!card(id)) await loadBoard();
          history.replaceState({ screen: 'detail', id }, '');
          if (card(id)) openDetail(id);
          else route({ screen: 'board' });
        },
      },
      fields,
      ok,
    );
    append(root, [
      h('header.topbar', null, h('button.icon-btn', { type: 'button', 'aria-label': tr('戻る'), title: tr('戻る'), onclick: back }, icon('back')), h('h1.top-title', { text: editCard ? tr('タスクを編集') : tr('新しいタスク') })),
      h('main.scroll.pad', null, form),
    ]);
  }

  // ---------------- 通知 ----------------

  function openNotifications() {
    S.selected = null;
    show('notif');
    S.notifSeen = new Set();
    renderNotifications();
  }
  // 閉じるときに、開いているあいだに見た通知を既読にする（デスクトップのベルと同じ）
  function leaveNotifications() {
    const ids = [...S.notifSeen].filter((id) => (S.board.notifications || []).some((n) => n.id === id && !n.read));
    S.notifSeen = new Set();
    if (ids.length) run(() => invoke('notifications:read', { ids }));
  }
  function renderNotifications() {
    const root = $('notifScreen');
    const prev = root.querySelector('.scroll');
    const top = prev ? prev.scrollTop : 0;
    clear(root);
    const list = S.board.notifications || [];
    const unread = list.filter((n) => !n.read).length;
    for (const n of list) if (!n.read) S.notifSeen.add(n.id);
    append(root, [
      h(
        'header.topbar',
        null,
        h('button.icon-btn', { type: 'button', 'aria-label': tr('戻る'), title: tr('戻る'), onclick: back }, icon('back')),
        h('h1.top-title', { text: tr('通知') }),
        unread ? h('button.btn.ghost.small', { type: 'button', text: tr('すべて既読'), onclick: (e) => run(() => invoke('notifications:read', {}), null, e.currentTarget) }) : null,
        list.length ? h('button.btn.ghost.small', { type: 'button', text: tr('すべて消す'), onclick: (e) => confirm(tr('通知をすべて消しますか？')) && run(() => invoke('notifications:clear', {}), null, e.currentTarget) }) : null,
      ),
      h('main.scroll', null, list.length ? list.map(notifEl) : h('p.muted.pad.center', { text: tr('通知はまだありません') })),
    ]);
    root.querySelector('.scroll').scrollTop = top;
  }
  function notifEl(n) {
    const alive = !!card(n.cardId);
    const open = () => {
      if (!alive) return;
      if (!n.read) run(() => invoke('notifications:read', { ids: [n.id] }));
      S.notifSeen.delete(n.id);
      history.replaceState({ screen: 'detail', id: n.cardId }, '');
      openDetail(n.cardId);
    };
    const action =
      n.action && !n.actedAt && alive
        ? h('button.btn.primary.small', {
            type: 'button',
            text: n.actionLabel || tr('実行'),
            onclick: stop(async (e) => {
              const r = await run(() => invoke('notifications:act', { id: n.id }).then((v) => v || {}), null, e.currentTarget);
              const to = (r && r.cardId) || n.cardId;
              if (r === undefined || !to) return;
              if (!card(to)) await loadBoard();
              if (card(to)) {
                history.replaceState({ screen: 'detail', id: to }, '');
                openDetail(to);
              }
            }),
          })
        : n.action && n.actedAt
          ? h('span.muted.small', { text: tr('対応済み') })
          : null;
    return h(
      'div.notif',
      { class: `${n.read ? '' : 'unread'}${alive ? ' link' : ''}`, onclick: open },
      h('span.notif-icon', null, icon(NOTIF_ICON[n.kind] || 'bell')),
      h('div.notif-main', null, h('div.notif-title', { text: n.title || '' }), n.body ? h('div.notif-body', { text: MobileMarkdown.plain(n.body) }) : null, h('div.notif-foot', null, h('span.muted.small', { text: n.t ? timeAgo(n.t) : '' }), action)),
      h('button.icon-btn.notif-x', { type: 'button', 'aria-label': tr('この通知を消す'), title: tr('この通知を消す'), onclick: stop((e) => run(() => invoke('notifications:clear', { ids: [n.id] }), null, e.currentTarget)) }, icon('x')),
    );
  }

  // ---------------- 画面全体のクリック（コードのコピー・画像の拡大） ----------------

  document.addEventListener('click', (e) => {
    const b = e.target.closest && e.target.closest('.md-copy');
    if (b) {
      const code = b.parentElement.querySelector('pre.md-code code');
      const text = code ? code.textContent : '';
      const done = () => {
        b.textContent = tr('コピーしました');
        setTimeout(() => (b.textContent = tr('コピー')), 1500);
      };
      if (navigator.clipboard && navigator.clipboard.writeText) navigator.clipboard.writeText(text).then(done, () => toast(tr('コピーできませんでした')));
      else toast(tr('コピーできませんでした'));
      return;
    }
    const img = e.target.closest && e.target.closest('.log-img');
    if (img) {
      const ov = h('div.img-overlay', { onclick: () => ov.remove() }, h('img', { src: img.src, alt: '' }));
      document.body.appendChild(ov);
    }
  });

  // ---------------- 起動 ----------------

  // QR コードのリンク（#pair=<code>）。コードは1回だけ使えるので、すぐに URL から消す
  function pairFromHash() {
    const m = /(?:^#|&)pair=([^&]+)/.exec(location.hash || '');
    if (!m) return false;
    history.replaceState(null, '', location.pathname + location.search);
    let code = '';
    try {
      code = decodeURIComponent(m[1]);
    } catch {
      code = m[1];
    }
    pairError = '';
    show('pair');
    renderPair();
    doPair(code);
    return true;
  }

  function init() {
    setLanguage(navigatorLanguage());
    let storage = null;
    try {
      storage = window.localStorage;
      storage.getItem('x');
    } catch {
      storage = null; // プライベートブラウズなどで使えないときは、この画面のあいだだけ覚える
    }
    S.client = MobileApi.createClient({ baseUrl: '', storage: storage || undefined });
    S.client.onUnauthorized((err) => {
      S.session = null;
      S.selected = null;
      S.logs.clear();
      S.logsVersion.clear();
      S.loaded = false;
      S.board = { settings: {}, cards: [], notifications: [], repoTabs: [] };
      S.model = BM.model([]);
      history.replaceState(null, '');
      showPair(err && err.code === 'no_token' ? '' : (err && err.message) || tr('もう一度ペアリングしてください'));
    });
    // 開いている画面に、あとから QR コードのリンクを開いたとき
    window.addEventListener('hashchange', pairFromHash);
    if (pairFromHash()) return;
    if (S.client.hasToken()) {
      history.replaceState({ screen: 'board' }, '');
      return startApp();
    }
    showPair();
  }
  init();
})();
