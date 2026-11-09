// CLI・MCP から、アプリの API（src/api-server.js）を呼ぶ（Electron にも、アプリの中のモジュールにも依存しない）
//
// つなぐ先の決め方（先にあるほうを使う）
//   1. --url / --token（WORKTREE_KANBAN_URL / WORKTREE_KANBAN_TOKEN）
//   2. login で保存した、ほかの PC のアプリ（userData/cli-login.json）。--local を付けたら使わない
//   3. 同じ PC のアプリ（userData/api.json）。動いていなければ、常駐モード（--headless）で起動して待つ
const fs = require('fs');
const os = require('os');
const path = require('path');
const http = require('http');
const https = require('https');
const { spawn } = require('child_process');

const DISCOVERY_FILE = 'api.json';
const LOGIN_FILE = 'cli-login.json';
const LOCK_INFO_FILE = 'instance.json';
const START_TIMEOUT_MS = 60 * 1000;
const REQUEST_TIMEOUT_MS = 10 * 60 * 1000; // マージなどは時間がかかる

class ApiError extends Error {
  constructor(message, { status = 0, code = '' } = {}) {
    super(message);
    this.status = status;
    this.code = code;
  }
}

// アプリのデータの場所（main.js の dataDir と同じ。WORKTREE_KANBAN_DATA_DIR で変えられる）
function dataDir(env = process.env, platform = process.platform, home = os.homedir()) {
  if (env.WORKTREE_KANBAN_DATA_DIR) return env.WORKTREE_KANBAN_DATA_DIR;
  if (platform === 'darwin') return path.join(home, 'Library', 'Application Support', 'agent-kanban');
  if (platform === 'win32') return path.join(env.APPDATA || path.join(home, 'AppData', 'Roaming'), 'agent-kanban');
  return path.join(env.XDG_CONFIG_HOME || path.join(home, '.config'), 'agent-kanban');
}

const pidAlive = (pid) => {
  try {
    process.kill(pid, 0);
    return true;
  } catch (err) {
    return !!err && err.code === 'EPERM';
  }
};

function readJsonFile(file) {
  try {
    return JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch {
    return null;
  }
}

// 同じ PC で動いているアプリの API（無い・もう動いていないなら null）
function readDiscovery(dir, { alive = pidAlive } = {}) {
  const info = readJsonFile(path.join(dir, DISCOVERY_FILE));
  if (!info || !Number.isInteger(info.pid) || !info.token || !Number.isInteger(info.port)) return null;
  return alive(info.pid) ? info : null;
}

// アプリが動いているか（API を止めていても分かる）
function readLockInfo(dir, { alive = pidAlive } = {}) {
  const info = readJsonFile(path.join(dir, LOCK_INFO_FILE));
  if (!info || !Number.isInteger(info.pid)) return null;
  return alive(info.pid) ? info : null;
}

function readLogin(dir) {
  const v = readJsonFile(path.join(dir, LOGIN_FILE));
  return v && typeof v.url === 'string' && typeof v.token === 'string' ? v : null;
}

function saveLogin(dir, login) {
  fs.mkdirSync(dir, { recursive: true });
  const file = path.join(dir, LOGIN_FILE);
  try {
    fs.unlinkSync(file);
  } catch {
    /* 無い */
  }
  fs.writeFileSync(file, JSON.stringify(login, null, 2), { mode: 0o600 });
  return file;
}

function clearLogin(dir) {
  try {
    fs.unlinkSync(path.join(dir, LOGIN_FILE));
    return true;
  } catch {
    return false;
  }
}

function cleanUrl(url) {
  let s = String(url || '').trim();
  if (!s) return '';
  if (!/^https?:\/\//i.test(s)) s = `http://${s}`;
  return s.replace(/\/+$/, '');
}

// HTTP で JSON を送る
function requestJson(url, { method = 'GET', token = '', body, timeoutMs = REQUEST_TIMEOUT_MS } = {}) {
  return new Promise((resolve, reject) => {
    let u;
    try {
      u = new URL(url);
    } catch {
      return reject(new ApiError(`Invalid URL: ${url}`));
    }
    const lib = u.protocol === 'https:' ? https : http;
    const data = body === undefined ? null : Buffer.from(JSON.stringify(body));
    const headers = { Accept: 'application/json' };
    if (token) headers.Authorization = `Bearer ${token}`;
    if (data) {
      headers['Content-Type'] = 'application/json';
      headers['Content-Length'] = data.length;
    }
    const req = lib.request(u, { method, headers }, (res) => {
      const chunks = [];
      res.on('data', (c) => chunks.push(c));
      res.on('end', () => {
        const text = Buffer.concat(chunks).toString('utf8');
        let json = null;
        try {
          json = JSON.parse(text);
        } catch {
          /* JSON でない */
        }
        if (!json || typeof json !== 'object') return reject(new ApiError(`Unexpected response (HTTP ${res.statusCode})`, { status: res.statusCode }));
        if (res.statusCode >= 400 || json.ok === false) return reject(new ApiError(json.error || `HTTP ${res.statusCode}`, { status: res.statusCode }));
        resolve(json.data);
      });
    });
    req.setTimeout(timeoutMs, () => req.destroy(new ApiError('Request timed out', { code: 'ETIMEDOUT' })));
    req.on('error', (err) => reject(err instanceof ApiError ? err : new ApiError(err.message, { code: err.code || '' })));
    if (data) req.write(data);
    req.end();
  });
}

// 常駐モードで起動するコマンド。
// WORKTREE_KANBAN_APP（と WORKTREE_KANBAN_APP_ARGS: JSON の配列）があればそれ、
// アプリの exe で（ELECTRON_RUN_AS_NODE で）動いているなら、その exe
function appLaunchCommand(env = process.env, { execPath = process.execPath, versions = process.versions, platform = process.platform } = {}) {
  let args = [];
  if (env.WORKTREE_KANBAN_APP_ARGS) {
    try {
      const v = JSON.parse(env.WORKTREE_KANBAN_APP_ARGS);
      if (Array.isArray(v)) args = v.map(String);
    } catch {
      /* 無視 */
    }
  }
  let file = env.WORKTREE_KANBAN_APP || '';
  if (!file && versions && versions.electron) file = execPath;
  if (!file) return null;
  // Linux: 展開しただけの tar.gz は Chromium のサンドボックスが使えない。常駐モードはページを開かないので外して動かす
  const extra = platform === 'linux' ? ['--no-sandbox'] : [];
  return { file, args: [...args, '--headless', '--api', ...extra] };
}

class ApiClient {
  /**
   * @param {{ url?: string, token?: string, local?: boolean, autoStart?: boolean, env?: object, dir?: string, onLog?: (line: string) => void,
   *           spawnImpl?: Function, now?: () => number, sleep?: (ms: number) => Promise<void>, startTimeoutMs?: number }} [o]
   */
  constructor(o = {}) {
    this.env = o.env || process.env;
    this.dir = o.dir || dataDir(this.env);
    this.url = cleanUrl(o.url || this.env.WORKTREE_KANBAN_URL || '');
    this.token = o.token || this.env.WORKTREE_KANBAN_TOKEN || '';
    this.local = !!o.local;
    this.autoStart = o.autoStart !== false;
    this.onLog = o.onLog || (() => {});
    this.spawnImpl = o.spawnImpl || spawn;
    this.now = o.now || Date.now;
    this.sleep = o.sleep || ((ms) => new Promise((r) => setTimeout(r, ms)));
    this.startTimeoutMs = o.startTimeoutMs || START_TIMEOUT_MS;
    this.target = null; // { url, token, kind: 'explicit'|'login'|'local' }
  }

  // つなぐ先を決める（同じ PC のアプリが動いていなければ起動する）
  async connect() {
    if (this.target) return this.target;
    if (this.url) {
      if (!this.token) throw new ApiError('A token is required with --url. Run "login" first, or set WORKTREE_KANBAN_TOKEN.');
      this.target = { url: this.url, token: this.token, kind: 'explicit' };
      return this.target;
    }
    if (!this.local) {
      const login = readLogin(this.dir);
      if (login) {
        this.target = { url: cleanUrl(login.url), token: login.token, kind: 'login' };
        return this.target;
      }
    }
    let info = readDiscovery(this.dir);
    if (!info) info = await this.startApp();
    this.target = { url: `http://127.0.0.1:${info.port}`, token: info.token, kind: 'local', mode: info.mode, version: info.version };
    return this.target;
  }

  // 同じ PC のアプリを常駐モードで起動して、API が使えるようになるまで待つ
  async startApp() {
    const lock = readLockInfo(this.dir);
    if (lock) {
      // 起動したばかり（API をまだ書いていない）なら、少し待つ
      if (this.now() - (Number(lock.startedAt) || 0) < this.startTimeoutMs) {
        const info = await this.waitForApi(() => null, '');
        if (info) return info;
      }
      // アプリは動いているのに API が無い: 設定で止めている（勝手に2つ目は起動しない）
      throw new ApiError(`Worktree Kanban is running (${lock.mode}, pid ${lock.pid}) but its API is turned off. Turn on "CLI / MCP" in the app's settings.`, { code: 'API_OFF' });
    }
    if (!this.autoStart) throw new ApiError('Worktree Kanban is not running. Start the app, or run without --no-start to start it in headless mode.', { code: 'NOT_RUNNING' });
    const cmd = appLaunchCommand(this.env);
    if (!cmd) throw new ApiError('Worktree Kanban is not running, and the app to start was not found. Set WORKTREE_KANBAN_APP to the app executable.', { code: 'NOT_RUNNING' });
    fs.mkdirSync(this.dir, { recursive: true });
    const logFile = path.join(this.dir, 'headless.log');
    this.onLog(`Starting Worktree Kanban in headless mode (log: ${logFile})`);
    const out = fs.openSync(logFile, 'a');
    const env = { ...this.env };
    delete env.ELECTRON_RUN_AS_NODE;
    const child = this.spawnImpl(cmd.file, cmd.args, { detached: true, stdio: ['ignore', out, out], env, windowsHide: true });
    let exited = null;
    child.on?.('exit', (code) => (exited = code));
    child.on?.('error', (err) => (exited = err));
    child.unref?.();
    fs.closeSync(out);
    const info = await this.waitForApi(() => exited, logFile);
    if (info) return info;
    throw new ApiError(`Timed out waiting for Worktree Kanban to start. See ${logFile}`, { code: 'START_FAILED' });
  }

  // api.json ができるまで待つ。来なければ null。起動した子が終わり、ほかのアプリも動いていなければエラー
  async waitForApi(exitedOf, logFile) {
    const until = this.now() + this.startTimeoutMs;
    while (this.now() < until) {
      const info = readDiscovery(this.dir);
      if (info) return info;
      const exited = exitedOf();
      // 同時に起動した別の wtk のアプリが先にロックを取った（こちらは断られて終わった）なら、そちらを待つ
      if (exited !== null && !readLockInfo(this.dir)) throw new ApiError(`Worktree Kanban exited while starting (${exited instanceof Error ? exited.message : `code ${exited}`}). See ${logFile}`, { code: 'START_FAILED' });
      if (!logFile && !readLockInfo(this.dir)) return null; // 待っていたアプリが終わった
      await this.sleep(300);
    }
    return null;
  }

  async invoke(channel, arg) {
    const t = await this.connect();
    return requestJson(`${t.url}/api/v1/invoke`, { method: 'POST', token: t.token, body: { channel, arg: arg === undefined ? null : arg } });
  }

  async session() {
    const t = await this.connect();
    return { ...(await requestJson(`${t.url}/api/v1/session`, { token: t.token })), url: t.url, via: t.kind };
  }

  // ほかの PC のアプリとペアリングして、トークンを保存する
  async login({ url, code, name = os.hostname() }) {
    const u = cleanUrl(url);
    if (!u) throw new ApiError('Give the URL of the app (for example http://127.0.0.1:47821 through an SSH tunnel).');
    if (!code) throw new ApiError('Give the pairing code shown in the app.');
    const r = await requestJson(`${u}/api/v1/pair`, { method: 'POST', body: { code, deviceName: name } });
    const file = saveLogin(this.dir, { url: u, token: r.token, deviceId: r.deviceId, expiresAt: r.expiresAt });
    return { url: u, deviceId: r.deviceId, expiresAt: r.expiresAt, file };
  }

  async logout() {
    const login = readLogin(this.dir);
    if (!login) return { removed: false };
    try {
      await requestJson(`${cleanUrl(login.url)}/api/v1/logout`, { method: 'POST', token: login.token, timeoutMs: 10000 });
    } catch {
      /* つながらなくても、手元のトークンは消す */
    }
    clearLogin(this.dir);
    return { removed: true, url: login.url };
  }
}

module.exports = { ApiClient, ApiError, dataDir, readDiscovery, readLockInfo, readLogin, saveLogin, clearLogin, cleanUrl, requestJson, appLaunchCommand, DISCOVERY_FILE, LOGIN_FILE };
