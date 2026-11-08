/* global I18n, tr, MobileApi, Terminal, FitAddon */
// スマホのターミナルの画面（terminal.html）。シェルはパソコンのアプリで動き、ここは入出力をやりとりするだけ。
//   /terminal.html             … 開いているターミナルの一覧と「新しいターミナル」
//   /terminal.html#card=<id>   … そのタスクの worktree のターミナル（無ければ開く）
//   /terminal.html#id=<id>     … 開いているターミナルにつなぐ
// 出力は terminal:read（待ち受け型のポーリング）で読む。Cloudflare の Quick Tunnel ではイベントの流れが届かないことがあるため。
// サーバーからの文字列は textContent で入れる（innerHTML は使わない）
(function () {
  'use strict';
  const $ = (id) => document.getElementById(id);
  const READ_WAIT_MS = 15000;

  function h(sel, props, ...kids) {
    const [tag, ...classes] = String(sel).split('.');
    const el = document.createElement(tag || 'div');
    if (classes.length) el.className = classes.join(' ');
    for (const [k, v] of Object.entries(props || {})) {
      if (v === undefined || v === null || v === false) continue;
      if (k === 'text') el.textContent = String(v);
      else if (k.startsWith('on') && typeof v === 'function') el[k] = v;
      else if (k === 'type') el.type = v;
      else el.setAttribute(k, String(v));
    }
    for (const c of kids.flat()) if (c !== null && c !== undefined && c !== false) el.appendChild(typeof c === 'object' ? c : document.createTextNode(String(c)));
    return el;
  }
  function clear(el) {
    while (el.firstChild) el.removeChild(el.firstChild);
    return el;
  }
  function backIcon() {
    const NS = 'http://www.w3.org/2000/svg';
    const svg = document.createElementNS(NS, 'svg');
    svg.setAttribute('viewBox', '0 0 24 24');
    svg.setAttribute('aria-hidden', 'true');
    svg.setAttribute('class', 'ic');
    const p = document.createElementNS(NS, 'path');
    p.setAttribute('d', 'M15 18l-6-6 6-6');
    svg.appendChild(p);
    return svg;
  }
  function toast(msg, kind = 'error') {
    const t = $('toast');
    t.textContent = msg;
    t.className = `toast ${kind}`;
    clearTimeout(toast.timer);
    toast.timer = setTimeout(() => t.classList.add('hidden'), kind === 'error' ? 6000 : 2500);
  }
  function setLanguage(code) {
    const list = [code, ...(navigator.languages || [navigator.language || 'en'])].map((x) => String(x || '').toLowerCase().split('-')[0]);
    const next = list.find((c) => I18n.isLanguage(c)) || I18n.DEFAULT_LANGUAGE;
    I18n.setLanguage(next);
    document.documentElement.lang = next;
  }
  function errText(err) {
    return (err && err.message) || String(err);
  }

  let client = null;
  const invoke = (channel, arg) => client.invoke(channel, arg);
  const S = { term: null, fit: null, id: null, offset: 0, gen: 0, exited: false, ctrl: false, sending: '', inFlight: false, lastSize: '' };

  function goBack() {
    stopReading();
    if (history.length > 1) history.back();
    else location.href = '/';
  }

  function topbar(title, extra) {
    return h('header.topbar', null, h('button.icon-btn', { type: 'button', 'aria-label': tr('戻る'), title: tr('戻る'), onclick: goBack }, backIcon()), h('h1', { text: title }), extra || null);
  }

  function showMessage(title, text, actions) {
    const app = clear($('app'));
    app.appendChild(topbar(title));
    app.appendChild(h('div.term-msg', null, h('p.muted', { text }), actions || null));
  }

  // ---- 一覧 ----
  async function showList() {
    stopReading();
    const app = clear($('app'));
    const newBtn = h('button.btn.primary', { type: 'button', text: tr('新しいターミナル'), onclick: () => openNew(newBtn) });
    app.appendChild(topbar(tr('ターミナル')));
    const list = h('div.term-list');
    app.appendChild(list);
    list.appendChild(h('p.muted.small', { text: tr('パソコンのアプリで動いているシェルです。閉じても、パソコンのアプリで閉じるまでは動き続けます。') }));
    list.appendChild(newBtn);
    let items = [];
    try {
      items = await invoke('terminal:list');
    } catch (err) {
      list.appendChild(h('p.muted', { text: errText(err) }));
      return;
    }
    for (const t of items || []) {
      list.appendChild(
        h(
          'button.term-item',
          { type: 'button', onclick: () => (location.hash = `id=${encodeURIComponent(t.id)}`) },
          h('div.t-main', null, h('div.t-title', { text: `${t.kind === 'card' ? `${tr('タスク')}: ` : ''}${t.title || t.shell || ''}${t.exited ? ` (${tr('終了済み')})` : ''}` }), h('div.t-cwd', { text: t.cwd || '' })),
        ),
      );
    }
  }

  async function openNew(btn) {
    btn.disabled = true;
    try {
      const info = await invoke('terminal:open', { kind: 'free', cols: 60, rows: 20 });
      location.hash = `id=${encodeURIComponent(info.id)}`;
    } catch (err) {
      toast(errText(err));
      btn.disabled = false;
    }
  }

  // ---- ターミナル ----
  const KEYS = [
    ['Esc', '\x1b'],
    ['Tab', '\t'],
    ['Ctrl', 'ctrl'],
    ['↑', '\x1b[A'],
    ['↓', '\x1b[B'],
    ['←', '\x1b[D'],
    ['→', '\x1b[C'],
    ['^C', '\x03'],
    ['^D', '\x04'],
    ['^Z', '\x1a'],
    ['|', '|'],
    ['~', '~'],
    ['/', '/'],
    ['-', '-'],
  ];

  // 入力は1つずつ順に送る（同時に送ると、届く順が入れ替わることがある）
  function send(data) {
    if (!data || S.exited || !S.id) return;
    S.sending += data;
    flushSend();
  }
  async function flushSend() {
    if (S.inFlight || !S.sending) return;
    const data = S.sending;
    S.sending = '';
    S.inFlight = true;
    try {
      await invoke('terminal:write', { id: S.id, data });
    } catch (err) {
      toast(errText(err));
    } finally {
      S.inFlight = false;
      if (S.sending) flushSend();
    }
  }

  function input(d) {
    if (S.ctrl && d.length === 1) {
      S.ctrl = false;
      document.querySelector('.term-key[data-k="ctrl"]')?.classList.remove('on');
      const c = d.toUpperCase().charCodeAt(0);
      if (c >= 64 && c <= 95) return send(String.fromCharCode(c - 64));
    }
    send(d);
  }

  function fit() {
    if (!S.term || !S.fit) return;
    try {
      S.fit.fit();
    } catch {
      return;
    }
    const size = `${S.term.cols}x${S.term.rows}`;
    if (size === S.lastSize || S.exited) return;
    S.lastSize = size;
    invoke('terminal:resize', { id: S.id, cols: S.term.cols, rows: S.term.rows }).catch(() => {});
  }

  function mountTerminal(info) {
    const app = clear($('app'));
    S.id = info.id;
    S.offset = 0;
    S.exited = false;
    S.lastSize = '';
    const screen = h('div.term-screen');
    const keys = h('div.term-keys');
    for (const [label, seq] of KEYS) {
      keys.appendChild(
        h('button.term-key', {
          type: 'button',
          text: label,
          'data-k': seq === 'ctrl' ? 'ctrl' : null,
          onclick: (e) => {
            if (seq === 'ctrl') {
              S.ctrl = !S.ctrl;
              e.currentTarget.classList.toggle('on', S.ctrl);
            } else send(seq);
            S.term && S.term.focus();
          },
        }),
      );
    }
    const closeBtn = h('button.btn.ghost', {
      type: 'button',
      text: tr('閉じる'),
      onclick: async () => {
        if (!confirm(tr('このターミナルを閉じて、シェルを終わらせますか？'))) return;
        try {
          await invoke('terminal:close', { id: S.id });
        } catch (err) {
          toast(errText(err));
        }
        goBack();
      },
    });
    app.appendChild(topbar(`${info.kind === 'card' ? `${tr('タスク')}: ` : ''}${info.title || ''}`, closeBtn));
    app.appendChild(screen);
    app.appendChild(keys);
    if (S.term) S.term.dispose();
    S.term = new Terminal({ cursorBlink: true, fontSize: 12, scrollback: 3000, fontFamily: 'ui-monospace, SFMono-Regular, Menlo, monospace', theme: matchMedia('(prefers-color-scheme: light)').matches ? { background: '#fbfbfd', foreground: '#1b1e27', cursor: '#4b5bf0' } : { background: '#0b0d12', foreground: '#e6e8ee', cursor: '#7584ff' } });
    S.fit = new FitAddon.FitAddon();
    S.term.loadAddon(S.fit);
    S.term.open(screen);
    S.term.onData(input);
    fit();
    startReading();
    S.term.focus();
  }

  // 読む流れは1本だけ。止める・読み直すたびに gen を進め、古い流れは次の応答で終わる
  async function startReading() {
    const gen = ++S.gen;
    const id = S.id;
    const live = () => S.gen === gen && S.id === id;
    while (live()) {
      let r;
      try {
        r = await invoke('terminal:read', { id, offset: S.offset, wait: READ_WAIT_MS });
      } catch (err) {
        if (!live()) return;
        if (/not found/i.test(errText(err))) {
          S.term.write(`\r\n\x1b[2m${tr('[シェルは終了しました]')}\x1b[0m\r\n`);
          S.exited = true;
          return;
        }
        await new Promise((res) => setTimeout(res, 2000));
        continue;
      }
      if (!live()) return;
      if (r.reset) S.term.reset();
      if (r.data) S.term.write(r.data);
      S.offset = r.offset;
      if (r.exited) {
        S.exited = true;
        S.term.write(`\r\n\x1b[2m${r.exitCode == null ? tr('[シェルは終了しました]') : tr('[シェルは終了しました（終了コード {code}）]', { code: r.exitCode })}\x1b[0m\r\n`);
        return;
      }
    }
  }
  function stopReading() {
    S.gen++;
  }

  async function route() {
    stopReading();
    const params = new URLSearchParams(location.hash.slice(1));
    const cardId = params.get('card');
    const id = params.get('id');
    if (!cardId && !id) return showList();
    showMessage(tr('ターミナル'), tr('ターミナルを開いています…'));
    try {
      const info = cardId ? await invoke('terminal:open', { kind: 'card', cardId, cols: 60, rows: 20 }) : { id, ...((await invoke('terminal:list')) || []).find((t) => t.id === id) };
      if (!info || !info.id || (!cardId && !info.cwd)) throw new Error(tr('このターミナルは閉じられました'));
      mountTerminal(info);
    } catch (err) {
      showMessage(tr('ターミナル'), errText(err));
    }
  }

  async function init() {
    setLanguage('');
    let storage;
    try {
      storage = window.localStorage;
      storage.getItem('x');
    } catch {
      storage = undefined;
    }
    client = MobileApi.createClient({ baseUrl: '', storage });
    client.onUnauthorized(() => (location.href = '/'));
    if (!client.hasToken()) return (location.href = '/');
    try {
      const s = await client.session();
      setLanguage(s && s.language);
      if (s && s.terminal === false) return showMessage(tr('ターミナル'), tr('スマホからのターミナルは許可されていません（パソコンのアプリの「スマホから使う」で許可できます）'));
    } catch (err) {
      return showMessage(tr('ターミナル'), errText(err));
    }
    window.addEventListener('hashchange', route);
    window.addEventListener('resize', fit);
    if (window.visualViewport) window.visualViewport.addEventListener('resize', fit);
    // 隠れているあいだは読まない（戻ったら続きから読む）
    document.addEventListener('visibilitychange', () => {
      if (document.hidden) stopReading();
      else if (S.id && !S.exited && S.term) startReading();
    });
    route();
  }
  init();
})();
