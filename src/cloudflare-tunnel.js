// cloudflared を起動・停止して、127.0.0.1 のポートを外の HTTPS の URL につなぐ
// quick: アカウントなしで https://<ランダム>.trycloudflare.com をもらう（起動するたびに URL が変わる）
// named: Cloudflare のダッシュボードで作ったトンネルのトークンで、決まったホスト名につなぐ
// cloudflared が落ちたら、指数バックオフで起動し直す。トークンは環境変数でだけ渡し、表示する文には入れない
const fs = require('fs');
const path = require('path');
const childProcess = require('child_process');
const { EventEmitter } = require('events');
const { tr } = require('../renderer/i18n');

const DOWNLOAD_URL = 'https://developers.cloudflare.com/cloudflare-one/connections/connect-networks/downloads/';
const URL_TIMEOUT_MS = 30 * 1000;
const MIN_BACKOFF_MS = 1000;
const MAX_BACKOFF_MS = 60 * 1000;
const KILL_WAIT_MS = 5000;
const TAIL_LINES = 5;

function isFile(p) {
  try {
    return fs.statSync(p).isFile();
  } catch {
    return false;
  }
}

// よくあるインストール先（PATH に入っていないとき用）
function commonPaths(platform, env) {
  if (platform === 'win32') {
    const pf = env.ProgramFiles || env.PROGRAMFILES || 'C:\\Program Files';
    const pf86 = env['ProgramFiles(x86)'] || env['PROGRAMFILES(X86)'] || 'C:\\Program Files (x86)';
    const list = [path.win32.join(pf, 'cloudflared', 'cloudflared.exe'), path.win32.join(pf86, 'cloudflared', 'cloudflared.exe')];
    const local = env.LOCALAPPDATA || env.LocalAppData;
    if (local) list.push(path.win32.join(local, 'Microsoft', 'WinGet', 'Links', 'cloudflared.exe'));
    return list;
  }
  if (platform === 'darwin') return ['/opt/homebrew/bin/cloudflared', '/usr/local/bin/cloudflared'];
  return ['/usr/bin/cloudflared', '/usr/local/bin/cloudflared'];
}

// cloudflared のフルパスを探す: 設定のパス → PATH → よくある場所。見つからなければ null
function findCloudflared(setting, { platform = process.platform, env = process.env, exists = isFile } = {}) {
  const p = platform === 'win32' ? path.win32 : path.posix;
  const exts = platform === 'win32' ? ['.exe', '.cmd', '.bat', ''] : [''];
  const pathDirs = String(env.PATH || env.Path || '').split(platform === 'win32' ? ';' : ':').filter(Boolean);
  const inPath = (name) => {
    for (const dir of pathDirs) {
      for (const e of exts) {
        const c = p.join(dir, name + e);
        if (exists(c)) return c;
      }
    }
    return null;
  };
  const given = String(setting || '').trim().replace(/^"(.*)"$/, '$1');
  if (given) {
    if (given.includes('/') || given.includes('\\')) {
      for (const e of exts) if (exists(given + e)) return given + e;
    } else {
      const hit = inPath(given);
      if (hit) return hit;
    }
  }
  const hit = inPath('cloudflared');
  if (hit) return hit;
  for (const c of commonPaths(platform, env)) if (exists(c)) return c;
  return null;
}

// OS ごとの入れ方。自動ではダウンロードしない（コマンドと公式の案内ページを見せるだけ）
function installHint(platform = process.platform) {
  if (platform === 'darwin') {
    const command = 'brew install cloudflared';
    return { command, url: DOWNLOAD_URL, note: tr('ターミナルで次を実行して cloudflared を入れてください: {command}', { command }) };
  }
  if (platform === 'win32') {
    const command = 'winget install --id Cloudflare.cloudflared';
    return { command, url: DOWNLOAD_URL, note: tr('PowerShell かコマンドプロンプトで次を実行して cloudflared を入れてください: {command}', { command }) };
  }
  return {
    command: '',
    url: DOWNLOAD_URL,
    note: tr('Cloudflare の公式パッケージ（.deb / .rpm、または pkg.cloudflare.com のリポジトリ）で cloudflared を入れてください。入れ方は案内ページにあります: {url}', { url: DOWNLOAD_URL }),
  };
}

// 出力から https://<sub>.trycloudflare.com を探す（api.trycloudflare.com などの決まった名前は除く）
const RESERVED_SUBDOMAINS = new Set(['api', 'www']);
function parseQuickUrl(text) {
  const re = /https:\/\/([a-z0-9-]+)\.trycloudflare\.com\b/gi;
  let m;
  while ((m = re.exec(String(text || '')))) {
    if (!RESERVED_SUBDOMAINS.has(m[1].toLowerCase())) return `https://${m[1].toLowerCase()}.trycloudflare.com`;
  }
  return null;
}

// named の公開ホスト名を URL にする: https:// が無ければ付け、末尾の / を外す
function normalizeHostname(host) {
  let h = String(host || '').trim();
  if (!h) return '';
  if (!/^https?:\/\//i.test(h)) h = `https://${h}`;
  return h.replace(/\/+$/, '');
}

const isConnected = (text) => /Registered tunnel connection/i.test(String(text || ''));

// トークン（と、トークンらしい長い文字列）を伏せる
function redact(text, token) {
  let s = String(text == null ? '' : text);
  if (token) s = s.split(token).join('***');
  return s.replace(/eyJ[A-Za-z0-9+/=_-]{20,}/g, '***').replace(/(--token[ =])\S+/gi, '$1***');
}

function cloudflaredArgs({ mode, localPort }) {
  if (mode === 'named') return ['tunnel', '--no-autoupdate', 'run'];
  return ['tunnel', '--no-autoupdate', '--url', `http://127.0.0.1:${localPort}`];
}

// Windows では子プロセスごと確実に止める（src/agent.js の killTree と同じやり方）
function killProcess(child, platform = process.platform) {
  if (!child || child.exitCode !== null || child.signalCode !== null) return;
  if (platform === 'win32' && child.pid) {
    childProcess.execFile('taskkill', ['/pid', String(child.pid), '/T', '/F'], { windowsHide: true }, () => {});
    return;
  }
  try {
    child.kill('SIGTERM');
  } catch {
    /* 終了済み */
  }
  setTimeout(() => {
    if (child.exitCode === null && child.signalCode === null) {
      try {
        child.kill('SIGKILL');
      } catch {
        /* 終了済み */
      }
    }
  }, KILL_WAIT_MS).unref();
}

class CloudflareTunnel extends EventEmitter {
  // command: cloudflared のパス。prefixArgs・spawn・env・platform・backoff はテストで差し替えるため
  constructor(opts = {}) {
    super();
    this.opts = {
      command: 'cloudflared',
      prefixArgs: [],
      mode: 'quick',
      localPort: 0,
      namedToken: '',
      namedHostname: '',
      urlTimeoutMs: URL_TIMEOUT_MS,
      minBackoffMs: MIN_BACKOFF_MS,
      maxBackoffMs: MAX_BACKOFF_MS,
      spawn: childProcess.spawn,
      env: process.env,
      platform: process.platform,
    };
    this._assign(opts);
    this.state = 'stopped';
    this.url = null;
    this.error = null;
    this.child = null;
    this.wanted = false; // start() されていて stop() されていない
    this.attempts = 0; // 続けて失敗した回数（バックオフに使う）
    this.retryTimer = null;
    this.readyTimer = null;
    this.lastEmittedUrl = null;
    this.waiters = []; // start() の Promise（running か error になったら返す）
  }

  _assign(opts) {
    for (const [k, v] of Object.entries(opts || {})) if (v !== undefined) this.opts[k] = v;
    this.opts.mode = this.opts.mode === 'named' ? 'named' : 'quick';
  }

  get mode() {
    return this.opts.mode;
  }

  status() {
    return { state: this.state, url: this.url, mode: this.opts.mode, error: this.error };
  }

  _set(patch) {
    const before = JSON.stringify(this.status());
    Object.assign(this, patch);
    if (this.error) this.error = redact(this.error, this.opts.namedToken);
    if (JSON.stringify(this.status()) === before) return;
    this.emit('status', this.status());
    if (this.url && this.url !== this.lastEmittedUrl) {
      this.lastEmittedUrl = this.url;
      this.emit('url', this.url);
    }
    if (this.state === 'running' || this.state === 'error' || this.state === 'stopped') {
      const w = this.waiters.splice(0);
      for (const resolve of w) resolve(this.status());
    }
  }

  // 設定を確かめる。問題があれば説明の文を返す
  _invalid() {
    const { mode, localPort, namedToken, namedHostname } = this.opts;
    if (mode === 'quick') {
      const port = Number(localPort);
      if (!Number.isInteger(port) || port < 1 || port > 65535) return tr('cloudflared につなぐポート番号が正しくありません');
      return null;
    }
    if (!String(namedToken || '').trim()) return tr('Cloudflare のトンネルのトークンを入れてください');
    if (!normalizeHostname(namedHostname)) return tr('Cloudflare のトンネルの公開ホスト名を入れてください（例: kanban.example.com）');
    return null;
  }

  // 起動する。running か error になったら status() を返す（error のあとも、裏で起動し直し続ける）
  start() {
    const bad = this._invalid();
    if (bad) {
      this.wanted = false;
      this._clearTimers();
      this._set({ state: 'error', url: null, error: bad });
      return Promise.reject(new Error(this.error));
    }
    if (this.wanted && this.state === 'running') return Promise.resolve(this.status());
    const p = new Promise((resolve) => this.waiters.push(resolve));
    if (this.wanted && (this.child || this.retryTimer)) return p; // もう起動中か、起動し直し待ち
    this.wanted = true;
    this.attempts = 0;
    this._launch();
    return p;
  }

  // 止める。起動し直しの予約も取り消す。プロセスが終わるまで待つ
  async stop() {
    this.wanted = false;
    this._clearTimers();
    const child = this.child;
    this.child = null;
    if (child) await this._killAndWait(child);
    this.lastEmittedUrl = null;
    this._set({ state: 'stopped', url: null, error: null });
  }

  // 設定を変える。動いていれば（起動し直し待ちも含む）新しい設定で起動し直す
  async setOptions(opts = {}) {
    this._assign(opts);
    if (!this.wanted) return this.status();
    this._clearTimers();
    const child = this.child;
    this.child = null;
    if (child) await this._killAndWait(child);
    this.lastEmittedUrl = null;
    this._set({ url: null });
    this.wanted = false;
    return this.start().catch(() => this.status());
  }

  _clearTimers() {
    clearTimeout(this.retryTimer);
    clearTimeout(this.readyTimer);
    this.retryTimer = null;
    this.readyTimer = null;
  }

  _killAndWait(child) {
    return new Promise((resolve) => {
      if (child.exitCode !== null || child.signalCode !== null || child._cfEnded) return resolve();
      const t = setTimeout(resolve, KILL_WAIT_MS + 1000);
      t.unref();
      child.once('exit', () => {
        clearTimeout(t);
        resolve();
      });
      killProcess(child, this.opts.platform);
    });
  }

  _env() {
    const env = { ...this.opts.env };
    // 手元の環境変数のトークンで quick が named に化けないよう、いったん消す
    delete env.TUNNEL_TOKEN;
    if (this.opts.mode === 'named') env.TUNNEL_TOKEN = String(this.opts.namedToken).trim();
    return env;
  }

  _launch() {
    this.retryTimer = null;
    if (!this.wanted) return;
    const { command, prefixArgs, mode, localPort, platform } = this.opts;
    const token = String(this.opts.namedToken || '').trim();
    const args = [...prefixArgs, ...cloudflaredArgs({ mode, localPort })];
    this._set({ state: 'starting', url: null, error: null });
    let child;
    try {
      child = this.opts.spawn(command, args, { env: this._env(), stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true });
    } catch (err) {
      this._fail(this._explainSpawn(err));
      return;
    }
    this.child = child;
    const lines = [];
    let pending = '';
    const tail = () => redact(lines.slice(-TAIL_LINES).join(' / '), token);
    const onData = (d) => {
      if (this.child !== child) return;
      const text = pending + d;
      const parts = text.split(/\r?\n/);
      pending = parts.pop().slice(-4000);
      for (const l of parts) if (l.trim()) lines.push(l.trim());
      if (lines.length > 50) lines.splice(0, lines.length - 50);
      if (mode === 'quick') {
        const url = parseQuickUrl(text);
        if (url) this._ready(url);
      } else if (isConnected(text)) {
        this._ready(normalizeHostname(this.opts.namedHostname));
      }
    };
    for (const s of [child.stdout, child.stderr]) {
      if (!s) continue;
      s.setEncoding('utf8');
      s.on('data', onData);
    }
    const ended = (message) => {
      if (child._cfEnded) return;
      child._cfEnded = true;
      if (this.child !== child) return; // stop() や setOptions() で止めたもの
      this.child = null;
      if (pending.trim()) lines.push(pending.trim());
      this._fail(message(tail()));
    };
    child.on('error', (err) => ended(() => this._explainSpawn(err)));
    child.on('exit', (code, signal) =>
      ended((last) => {
        const base = code != null ? tr('cloudflared が止まりました（終了コード {code}）', { code }) : tr('cloudflared が止まりました（{signal}）', { signal: signal || '?' });
        return last ? tr('{message}。最後の出力: {last}', { message: base, last }) : base;
      }),
    );
    clearTimeout(this.readyTimer);
    const ms = Number(this.opts.urlTimeoutMs) || URL_TIMEOUT_MS;
    this.readyTimer = setTimeout(() => {
      this.readyTimer = null;
      if (this.child !== child || this.state === 'running') return;
      const sec = Math.round(ms / 100) / 10;
      const base = mode === 'quick'
        ? tr('cloudflared が {sec} 秒たっても URL を出しませんでした', { sec })
        : tr('cloudflared が {sec} 秒たっても Cloudflare につながりませんでした（トークンと、ダッシュボードのトンネルの設定を確かめてください）', { sec });
      const last = tail();
      this.child = null;
      child._cfEnded = true;
      killProcess(child, platform);
      this._fail(last ? tr('{message}。最後の出力: {last}', { message: base, last }) : base);
    }, ms);
  }

  _explainSpawn(err) {
    if (err && err.code === 'ENOENT') {
      return tr('cloudflared が見つかりません（{command}）。{note}', { command: this.opts.command, note: installHint(this.opts.platform).note });
    }
    return tr('cloudflared を起動できませんでした: {message}', { message: (err && err.message) || String(err) });
  }

  _ready(url) {
    if (!url) return;
    if (this.state === 'running' && this.url === url) return;
    clearTimeout(this.readyTimer);
    this.readyTimer = null;
    this.attempts = 0;
    this._set({ state: 'running', url, error: null });
  }

  // 失敗を知らせて、バックオフのあとで起動し直す
  _fail(message) {
    clearTimeout(this.readyTimer);
    this.readyTimer = null;
    this._set({ state: 'error', url: null, error: message });
    if (!this.wanted) return;
    const { minBackoffMs, maxBackoffMs } = this.opts;
    const delay = Math.min(maxBackoffMs, minBackoffMs * 2 ** this.attempts);
    this.attempts += 1;
    clearTimeout(this.retryTimer);
    this.retryTimer = setTimeout(() => this._launch(), delay);
  }
}

module.exports = {
  CloudflareTunnel,
  findCloudflared,
  installHint,
  parseQuickUrl,
  normalizeHostname,
  cloudflaredArgs,
  redact,
  DOWNLOAD_URL,
};
