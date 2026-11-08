// 常駐モード（ウィンドウを開かずに動かす）。起動の判断・同時起動のロック・トークンの読み込みをまとめる（Electron に依存しない）
//
// 常駐モードでは、アプリの exe を --headless 付きで起動する。画面は出さず、次のものだけが動く
// - スケジューラ、Issue の監視、Slack からの開始と通知（承認・回答も Slack のボタンでできる）
// - 遠隔操作のホスト（--remote-host か、前回ホストを有効にしていたとき）と、スマホ用のサーバー（前回有効にしていたとき）
// 承認待ち・質問は、答えが来るまで待つ（勝手に許可も拒否もしない）。そのあいだ Slack に通知する
//
// トークン: Linux のサーバーなどで OS の安全な保存先（キーチェーン）が無いときのために、
// 常駐モードでは環境変数と、本人しか読めない（0600）ファイルからも読む。読む順は 環境変数 → ファイル → 暗号化して保存したもの
const fs = require('fs');
const path = require('path');
const { tr } = require('../renderer/i18n');

const HEADLESS_FLAG = '--headless';
const REMOTE_HOST_FLAG = '--remote-host';
const SECRETS_FILE_FLAG = '--secrets-file';
const ENV_HEADLESS = 'WORKTREE_KANBAN_HEADLESS';
const ENV_SECRETS_FILE = 'WORKTREE_KANBAN_SECRETS_FILE';
const ENV_PREFIX = 'WORKTREE_KANBAN_';
const DEFAULT_SECRETS_FILE = 'headless.env';
const LOCK_INFO_FILE = 'instance.json';
const MAX_SECRETS_FILE = 256 * 1024;

const truthy = (v) => /^(1|true|yes|on)$/i.test(String(v || '').trim());

// 「--name=value」か「--name value」の値。無ければ null、値なしの「--name」は ''
function flagValue(args, name) {
  for (let i = 0; i < args.length; i++) {
    const a = String(args[i]);
    if (a === name) {
      const next = args[i + 1];
      return next != null && !String(next).startsWith('-') ? String(next) : '';
    }
    if (a.startsWith(`${name}=`)) return a.slice(name.length + 1);
  }
  return null;
}

/**
 * 起動の引数と環境変数から、常駐モードの指定を読む
 * @param {string[]} argv process.argv
 * @param {object} env process.env
 * @returns {{ headless: boolean, remoteHost: null | { port: number|null }, secretsFile: string }}
 */
function parseHeadlessOptions(argv, env = {}) {
  const args = (argv || []).slice(1);
  const headless = args.includes(HEADLESS_FLAG) || truthy(env[ENV_HEADLESS]);
  const rh = flagValue(args, REMOTE_HOST_FLAG);
  let remoteHost = null;
  if (rh != null) {
    const n = parseInt(rh, 10);
    remoteHost = { port: rh === '' || !Number.isFinite(n) ? null : n };
  }
  const secretsFile = flagValue(args, SECRETS_FILE_FLAG) || String(env[ENV_SECRETS_FILE] || '');
  return { headless, remoteHost, secretsFile };
}

/**
 * 保存するときの秘密の名前 → 環境変数の名前
 *   tracker:slack:botToken → WORKTREE_KANBAN_SLACK_BOT_TOKEN
 *   mobile:namedTunnelToken → WORKTREE_KANBAN_MOBILE_NAMED_TUNNEL_TOKEN
 */
function envNameFor(secretName) {
  const parts = String(secretName || '')
    .replace(/^tracker:/, '')
    .split(/[:\-.]/)
    .filter(Boolean)
    .map((p) => p.replace(/([a-z0-9])([A-Z])/g, '$1_$2'));
  return ENV_PREFIX + parts.join('_').toUpperCase().replace(/[^A-Z0-9_]/g, '_');
}

// KEY=VALUE の行（# の行と空行は飛ばす。値の前後の " か ' は外す。export も許す）
function parseEnvText(text) {
  const out = {};
  for (const raw of String(text || '').split(/\r?\n/)) {
    const line = raw.trim();
    if (!line || line.startsWith('#')) continue;
    const m = line.match(/^(?:export\s+)?([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*)$/);
    if (!m) continue;
    let v = m[2].trim();
    if (v.length >= 2 && ((v[0] === '"' && v.endsWith('"')) || (v[0] === "'" && v.endsWith("'")))) v = v.slice(1, -1);
    out[m[1]] = v;
  }
  return out;
}

/**
 * トークンのファイルを読む。本人以外も読める・本人のものでないファイルは読まない（エラーにする）
 * @param {string} file
 * @param {{ platform?: string, uid?: number|null, fsImpl?: object }} [o]
 * @returns {object|null} 無ければ null
 */
function readSecretsFile(file, { platform = process.platform, uid = typeof process.getuid === 'function' ? process.getuid() : null, fsImpl = fs } = {}) {
  let st;
  try {
    st = fsImpl.statSync(file);
  } catch (err) {
    if (err && err.code === 'ENOENT') return null;
    throw err;
  }
  if (!st.isFile()) throw new Error(tr('トークンのファイルがファイルではありません: {file}', { file }));
  if (platform !== 'win32') {
    if ((st.mode & 0o077) !== 0) throw new Error(tr('トークンのファイルを本人以外も読めるので、読みませんでした。chmod 600 {file} を実行してください', { file }));
    if (uid != null && st.uid !== uid) throw new Error(tr('トークンのファイルの持ち主が、アプリを動かしているユーザーと違うので、読みませんでした: {file}', { file }));
  }
  if (st.size > MAX_SECRETS_FILE) throw new Error(tr('トークンのファイルが大きすぎます: {file}', { file }));
  return parseEnvText(fsImpl.readFileSync(file, 'utf8'));
}

/**
 * 環境変数とファイルから秘密を読む（SecretStore に渡す）
 * @param {{ env?: object, file?: string, readFile?: (file: string) => object|null }} o
 */
function createSecretOverrides({ env: given = {}, file = '', readFile = readSecretsFile } = {}) {
  const env = { ...given }; // 読んだあと、元の環境変数からは消す（scrubSecretEnv）ので写しを持つ
  const fromFile = file ? readFile(file) || {} : {};
  const lookup = (name) => {
    const key = envNameFor(name);
    if (env[key]) return { value: String(env[key]), source: 'env' };
    if (fromFile[key]) return { value: String(fromFile[key]), source: 'file' };
    return null;
  };
  return {
    file,
    has: (name) => !!lookup(name),
    get: (name) => lookup(name)?.value || '',
    source: (name) => lookup(name)?.source || '',
    // 渡した秘密の名前のうち、環境変数・ファイルにあるもの（起動のときに、どれを読んだかを出す。値は出さない）
    found: (names) => (names || []).filter((n) => !!lookup(n)).map((n) => `${envNameFor(n)}（${lookup(n).source === 'env' ? tr('環境変数') : tr('ファイル')}）`),
  };
}

// 秘密の環境変数を、アプリのプロセスの環境変数から消す。
// 残すと、アプリが起動するエージェント（claude など）やスクリプトに引き継がれ、エージェントから読めてしまうため
function scrubSecretEnv(env, names) {
  const removed = [];
  for (const n of names || []) {
    const key = envNameFor(n);
    if (Object.prototype.hasOwnProperty.call(env, key)) {
      delete env[key];
      removed.push(key);
    }
  }
  return removed;
}

// ---------- 同時起動のロック ----------
// ロックそのものは Electron の requestSingleInstanceLock。ここでは、ロックを持っているのが
// デスクトップ版か常駐モードかを userData/instance.json に書いて、後から起動した側が知らせられるようにする

function lockInfoFile(userData) {
  return path.join(userData, LOCK_INFO_FILE);
}

function writeLockInfo(userData, { pid = process.pid, mode, version = '' } = {}) {
  const file = lockInfoFile(userData);
  fs.mkdirSync(userData, { recursive: true });
  fs.writeFileSync(file, JSON.stringify({ pid, mode, version, startedAt: Date.now() }), { mode: 0o600 });
  return file;
}

const pidAlive = (pid) => {
  try {
    process.kill(pid, 0);
    return true;
  } catch (err) {
    return !!err && err.code === 'EPERM';
  }
};

// ロックを持っているプロセスの情報。読めない・もう動いていないなら null
function readLockInfo(userData, { alive = pidAlive } = {}) {
  try {
    const info = JSON.parse(fs.readFileSync(lockInfoFile(userData), 'utf8'));
    if (!info || !Number.isInteger(info.pid) || !['desktop', 'headless'].includes(info.mode)) return null;
    return alive(info.pid) ? info : null;
  } catch {
    return null;
  }
}

// 自分が書いたものだけを消す（後から起動した別のプロセスのものは消さない）
function clearLockInfo(userData, pid = process.pid) {
  const file = lockInfoFile(userData);
  try {
    const info = JSON.parse(fs.readFileSync(file, 'utf8'));
    if (info && info.pid === pid) fs.unlinkSync(file);
  } catch {
    /* 無い・壊れている */
  }
}

/**
 * 2つ目に起動されたとき（ロックを取れなかったとき）にどうするか
 * @param {'desktop'|'headless'} mode 今起動しようとしているほう
 * @param {object|null} holder readLockInfo の結果
 * @returns {{ action: 'focus'|'refuse', message?: string }}
 *   focus: 今までどおり、動いているデスクトップ版のウィンドウを前に出してもらう（何も出さずに終わる）
 *   refuse: message を出して終わる（終了コード 1）
 */
function secondInstancePlan(mode, holder) {
  if (mode === 'desktop') {
    if (holder && holder.mode === 'headless') return { action: 'refuse', message: tr('このマシンでは Worktree Kanban が常駐モードで動いています（pid {pid}）。デスクトップ版を開くには、先に常駐モードを止めてください。同じボードを2つのアプリで同時に動かすと、タスクが二重に動くためです', { pid: holder.pid }) };
    return { action: 'focus' };
  }
  if (holder && holder.mode === 'headless') return { action: 'refuse', message: tr('常駐モードはもう動いています（pid {pid}）', { pid: holder.pid }) };
  if (holder && holder.mode === 'desktop') return { action: 'refuse', message: tr('このマシンでは Worktree Kanban のデスクトップ版が動いています（pid {pid}）。常駐モードで動かすには、先にデスクトップ版を終了してください', { pid: holder.pid }) };
  return { action: 'refuse', message: tr('このマシンでは Worktree Kanban がもう動いています。常駐モードで動かすには、先に終了してください') };
}

// ---------- 画面の代わりに出すログ ----------

const stamp = (now = new Date()) => {
  const p = (n) => String(n).padStart(2, '0');
  return `${now.getFullYear()}-${p(now.getMonth() + 1)}-${p(now.getDate())} ${p(now.getHours())}:${p(now.getMinutes())}:${p(now.getSeconds())}`;
};

// 通知（右上のベルに貯まるもの）を1行にする
function notificationLine(n, now) {
  const body = String((n && n.body) || '').replace(/\s+/g, ' ').trim().slice(0, 200);
  return `[${stamp(now)}] ${(n && n.title) || ''}${body ? ` — ${body}` : ''}`;
}

function log(line, out = console.log) {
  out(`[${stamp()}] ${line}`);
}

module.exports = {
  HEADLESS_FLAG,
  REMOTE_HOST_FLAG,
  SECRETS_FILE_FLAG,
  ENV_HEADLESS,
  ENV_SECRETS_FILE,
  DEFAULT_SECRETS_FILE,
  parseHeadlessOptions,
  envNameFor,
  parseEnvText,
  readSecretsFile,
  createSecretOverrides,
  scrubSecretEnv,
  lockInfoFile,
  writeLockInfo,
  readLockInfo,
  clearLockInfo,
  secondInstancePlan,
  notificationLine,
  log,
};
