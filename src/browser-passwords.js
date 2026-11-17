// 内蔵ブラウザ（詳細の「ブラウザ」タブ）で入れたパスワードを覚えて、次に開いたときに入れる。
// - パスワードは OS の安全な保存先（Electron の safeStorage）の鍵で暗号化して userData/browser-passwords.json に保存する。
//   safeStorage が使えなければ保存しない（平文では保存しない）
// - パスワードを扱うのはメインプロセスだけ。画面（レンダラー）には、サイトとユーザー名しか渡さない
// - ページに入れるスクリプト（WATCH_SCRIPT）は、ページの JS とは別の世界（isolated world）で動かす。
//   ページの JS からは、入れるパスワードや関数を横取りできない
// - サイトは「スキーム + ホスト名」で見分ける（ポートは見ない）。タスクごとに開発サーバーのポートが違っても、
//   同じ localhost のログインを使えるように。127.0.0.1・[::1] は localhost と同じサイトにする
const fs = require('fs');
const path = require('path');
const { tr } = require('../renderer/i18n');

const VERSION = 1;
const MARK = '__worktree_kanban_password__:';
const WORLD_ID = 1729; // ページに入れるスクリプトの世界（ページの JS とは別）
const MAX_FIELD = 1000; // ユーザー名・パスワードの長さの上限

const LOOPBACK = new Set(['localhost', '127.0.0.1', '[::1]', '::1']);

// URL から、パスワードを覚えるサイトの名前を作る。http(s) 以外は覚えない（''）
function siteKey(url) {
  let u;
  try {
    u = new URL(String(url || ''));
  } catch {
    return '';
  }
  if (u.protocol !== 'http:' && u.protocol !== 'https:') return '';
  const host = LOOPBACK.has(u.hostname) || u.hostname.endsWith('.localhost') ? 'localhost' : u.hostname;
  if (!host) return '';
  return `${u.protocol}//${host}`;
}

// console に書かれた1行から、パスワードのスクリプトの知らせを取り出す（印がなければ null）
function parseMessage(message) {
  const s = String(message || '');
  if (!s.startsWith(MARK)) return null;
  let v;
  try {
    v = JSON.parse(s.slice(MARK.length));
  } catch {
    return null;
  }
  if (!v || typeof v !== 'object') return null;
  if (v.kind === 'fill') return { kind: 'fill', url: String(v.url || '') };
  if (v.kind !== 'save') return null;
  const username = typeof v.username === 'string' ? v.username.trim().slice(0, MAX_FIELD) : '';
  const password = typeof v.password === 'string' ? v.password : '';
  if (!password || password.length > MAX_FIELD) return null;
  return { kind: 'save', url: String(v.url || ''), username, password };
}

class BrowserPasswords {
  /** @param {{ file: string, safeStorage: object }} p  safeStorage は Electron のもの（テストでは差し替える） */
  constructor({ file, safeStorage }) {
    this.file = file;
    this.safeStorage = safeStorage;
    this.data = null;
  }

  // 暗号化できるか。Linux で鍵の保管先が無いときの basic_text は、固定の鍵で隠すだけなので使わない
  available() {
    const s = this.safeStorage;
    if (!s || !s.isEncryptionAvailable()) return false;
    return !(typeof s.getSelectedStorageBackend === 'function' && s.getSelectedStorageBackend() === 'basic_text');
  }

  load() {
    if (this.data) return this.data;
    let raw = null;
    try {
      raw = JSON.parse(fs.readFileSync(this.file, 'utf8'));
    } catch {
      /* まだ無い・壊れている */
    }
    const logins = raw && Array.isArray(raw.logins) ? raw.logins.filter((x) => x && typeof x.site === 'string' && typeof x.password === 'string') : [];
    const never = raw && Array.isArray(raw.never) ? raw.never.filter((x) => typeof x === 'string') : [];
    this.data = { logins, never };
    return this.data;
  }

  write() {
    fs.mkdirSync(path.dirname(this.file), { recursive: true });
    const tmp = `${this.file}.tmp`;
    fs.writeFileSync(tmp, JSON.stringify({ version: VERSION, ...this.data }), { mode: 0o600 });
    fs.renameSync(tmp, this.file);
  }

  // 画面に出す一覧（パスワードは入れない）
  list() {
    const d = this.load();
    return {
      available: this.available(),
      logins: d.logins.map((x) => ({ site: x.site, username: x.username || '', updatedAt: x.updatedAt || 0 })),
      never: [...d.never],
    };
  }

  isNever(site) {
    return this.load().never.includes(site);
  }

  findIndex(site, username) {
    return this.load().logins.findIndex((x) => x.site === site && (x.username || '') === (username || ''));
  }

  // 保存するかを聞くべきか: 'new'（新しい）・'update'（パスワードが変わった）・''（聞かない）
  offerKind(site, username, password) {
    if (!site || !password || this.isNever(site) || !this.available()) return '';
    const i = this.findIndex(site, username);
    if (i < 0) return 'new';
    return this.decrypt(this.data.logins[i]) === password ? '' : 'update';
  }

  save(site, username, password) {
    if (!site || !password) throw new Error(tr('保存するパスワードがありません'));
    if (!this.available()) throw new Error(tr('このマシンでは OS の安全な保存先を使えないので、パスワードを保存できません（平文では保存しません）'));
    const d = this.load();
    const entry = { site, username: username || '', password: this.safeStorage.encryptString(password).toString('base64'), updatedAt: Date.now() };
    const i = this.findIndex(site, username);
    if (i >= 0) d.logins.splice(i, 1);
    d.logins.unshift(entry); // 新しいものを先に（入れるときは先頭を使う）
    d.never = d.never.filter((s) => s !== site);
    this.write();
  }

  remove(site, username) {
    const i = this.findIndex(site, username);
    if (i < 0) return false;
    this.data.logins.splice(i, 1);
    this.write();
    return true;
  }

  setNever(site, on) {
    const d = this.load();
    d.never = d.never.filter((s) => s !== site);
    if (on) d.never.push(site);
    this.write();
  }

  decrypt(entry) {
    try {
      return this.safeStorage.decryptString(Buffer.from(entry.password, 'base64'));
    } catch {
      return '';
    }
  }

  // ページに入れるログイン（いちばん新しく使ったもの）。無ければ null
  credentialFor(site) {
    if (!site || !this.available()) return null;
    const x = this.load().logins.find((e) => e.site === site);
    if (!x) return null;
    const password = this.decrypt(x);
    return password ? { username: x.username || '', password } : null;
  }
}

// ページに入れるスクリプト（ページの JS とは別の世界で動かす。何度入れても1つだけ動く）。
// - ログインのフォームを送った（submit・送信ボタンのクリック・パスワード欄で Enter）ときに、ユーザー名とパスワードを知らせる
// - 空のパスワード欄が出てきたら、入れるパスワードを頼む（メインプロセスが __wkPwFill で入れる）
const WATCH_SCRIPT = `(() => {
  const MARK = ${JSON.stringify(MARK)};
  const g = window;
  if (g.__wkPw) return;
  g.__wkPw = true;
  const say = (v) => console.log(MARK + JSON.stringify(Object.assign({ url: location.href }, v)));
  const shown = (el) => !!el && el.isConnected && !el.disabled && (el.offsetWidth > 0 || el.offsetHeight > 0 || el.getClientRects().length > 0);
  const pwFields = (scope) => Array.from((scope || document).querySelectorAll('input[type="password"]')).filter(shown);
  const USER_TYPES = new Set(['text', 'email', 'tel', '']);
  const userFor = (pw) => {
    const scope = pw.form || document;
    const inputs = Array.from(scope.querySelectorAll('input')).filter((i) => USER_TYPES.has((i.getAttribute('type') || '').toLowerCase()) && shown(i));
    const named = inputs.find((i) => /username|email/i.test(i.autocomplete || ''));
    if (named) return named;
    // パスワード欄より前にある、いちばん近い文字の欄
    const before = inputs.filter((i) => i.compareDocumentPosition(pw) & Node.DOCUMENT_POSITION_FOLLOWING);
    return before.length ? before[before.length - 1] : null;
  };
  // 新しいパスワードの欄（確認の欄と同じ値）があればそれを、なければ最後に入れた欄を使う
  const pickPw = (list) => {
    const filled = list.filter((p) => p.value);
    if (!filled.length) return null;
    const twice = filled.find((p, i) => filled.some((q, j) => j !== i && q.value === p.value));
    return twice || filled[filled.length - 1];
  };
  let last = '';
  const report = (scope) => {
    const pw = pickPw(pwFields(scope));
    if (!pw) return;
    const u = userFor(pw);
    const username = u ? String(u.value || '').trim() : '';
    const key = username + '\\n' + pw.value;
    if (key === last) return;
    last = key;
    say({ kind: 'save', username, password: pw.value });
  };
  addEventListener('submit', (e) => report(e.target && e.target.querySelectorAll ? e.target : null), true);
  addEventListener('click', (e) => {
    const b = e.target && e.target.closest && e.target.closest('button, input[type="submit"], input[type="button"], [role="button"]');
    if (!b) return;
    const f = b.form || b.closest('form');
    report(f && pwFields(f).length ? f : null);
  }, true);
  addEventListener('keydown', (e) => {
    if (e.key !== 'Enter' || e.isComposing) return;
    const t = e.target;
    if (!t || t.tagName !== 'INPUT') return;
    report(t.form && pwFields(t.form).length ? t.form : null);
  }, true);
  // 入れるパスワードを頼む（入れた欄・頼んだ欄は覚えておき、同じ欄では二度頼まない）
  const seen = new WeakSet();
  let timer = 0;
  const ask = () => {
    timer = 0;
    const empty = pwFields().filter((p) => !p.value && !seen.has(p) && (p.autocomplete || '') !== 'new-password');
    if (!empty.length) return;
    for (const p of empty) seen.add(p);
    say({ kind: 'fill' });
  };
  const later = () => { if (!timer) timer = setTimeout(ask, 300); };
  const setValue = (el, v) => {
    const set = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value').set;
    set.call(el, v);
    el.dispatchEvent(new Event('input', { bubbles: true }));
    el.dispatchEvent(new Event('change', { bubbles: true }));
  };
  g.__wkPwFill = (username, password) => {
    const list = pwFields().filter((p) => !p.value && (p.autocomplete || '') !== 'new-password');
    for (const pw of list.slice(0, 1)) {
      const u = userFor(pw);
      if (u && !u.value && username) setValue(u, username);
      setValue(pw, password);
      last = (username || '') + '\\n' + password; // 入れたものをそのまま送っても、保存するかは聞かない
    }
  };
  ask();
  try { new MutationObserver(later).observe(document.documentElement, { childList: true, subtree: true, attributes: true, attributeFilter: ['type', 'style', 'class', 'hidden'] }); } catch (e) { /* 見張れない */ }
})()`;

function fillScript(cred) {
  return `window.__wkPwFill && window.__wkPwFill(${JSON.stringify(cred.username || '')}, ${JSON.stringify(cred.password || '')})`;
}

/**
 * 内蔵ブラウザの <webview>（guest）にパスワードの見張りを付ける
 * @param {Electron.WebContents} guest
 * @param {{ store: BrowserPasswords, offer: (o: { webContentsId: number, site: string, username: string, kind: string }) => void }} p
 * @returns {{ pending: () => object|null, clear: () => void }}
 */
function attach(guest, { store, offer }) {
  let pending = null; // 保存するかを聞いているログイン（パスワードはここにだけ置く）
  const inject = () => {
    try {
      guest.executeJavaScriptInIsolatedWorld(WORLD_ID, [{ code: WATCH_SCRIPT }]).catch(() => {});
    } catch {
      /* ページがない */
    }
  };
  guest.on('dom-ready', inject);
  guest.on('console-message', (e) => {
    const msg = parseMessage(e && e.message);
    if (!msg) return;
    // ページが今いるサイトのものだけを扱う（知らせに書かれた URL は、ページが変えられるので確かめに使うだけ）
    const site = siteKey(guest.getURL());
    if (!site || siteKey(msg.url) !== site) return;
    if (msg.kind === 'fill') {
      const cred = store.credentialFor(site);
      if (!cred || siteKey(guest.getURL()) !== site) return;
      try {
        guest.executeJavaScriptInIsolatedWorld(WORLD_ID, [{ code: fillScript(cred) }]).catch(() => {});
      } catch {
        /* ページがない */
      }
      return;
    }
    const kind = store.offerKind(site, msg.username, msg.password);
    if (!kind) return;
    pending = { site, username: msg.username, password: msg.password };
    offer({ webContentsId: guest.id, site, username: msg.username, kind });
  });
  guest.once('destroyed', () => {
    pending = null;
  });
  return {
    pending: () => pending,
    clear: () => {
      pending = null;
    },
  };
}

module.exports = { BrowserPasswords, siteKey, parseMessage, attach, WATCH_SCRIPT, fillScript, MARK, WORLD_ID };
