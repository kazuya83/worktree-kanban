// アプリの中のターミナル（シェルだけ。エージェントの実行はヘッドレスのまま変えない）
//
// - タスクのターミナル: そのタスクの worktree で開く。タスクごとに1つ（kind: 'card'）
// - 自由なターミナル: タスクと関係なく開く。いくつでも開ける（kind: 'free'）
//
// シェルは main プロセス（常駐モードでも同じ）で動かし、画面（xterm.js）とは IPC・遠隔操作・スマホのサーバーでつなぐ。
// 画面を閉じても、アプリを終えるか close するまでは動かしたまま。出力の最後の部分（scrollback）を持っておき、
// 開き直したとき（open が同じものを返したとき・list のあと attach したとき）に画面へ返す。
//
// PTY の作り方は2つ:
//   1. node-pty（Mac・Windows はビルド済みのバイナリを同梱している）
//   2. node-pty を読み込めない Mac・Linux では、python3 の pty モジュールで PTY を作る小さなプログラム（PY_HELPER）
// どちらも使えないときは available() が ok: false を返し、画面は「外部のターミナルで開く」を出す（openExternal）。

const { EventEmitter } = require('events');
const { spawn } = require('child_process');
const { StringDecoder } = require('string_decoder');
const crypto = require('crypto');
const fs = require('fs');
const os = require('os');
const path = require('path');

const SCROLLBACK_LIMIT = 256 * 1024; // 開き直したときに返す出力の長さ（文字数）
const FLUSH_MS = 8; // 出力をまとめて送る間隔（遠隔・スマホで1文字ずつ送らないため）
const MAX_FLUSH = 64 * 1024; // これだけ貯まったら待たずに送る
const MAX_WRITE = 1024 * 1024; // 1回に書き込める入力（貼り付け）の長さ
const MIN_COLS = 2;
const MAX_COLS = 1000;
const MIN_ROWS = 1;
const MAX_ROWS = 500;

// python3 で PTY を作って、シェルとのあいだで入出力を中継する。
//   引数: cols rows file args...   stdin/stdout: シェルの入出力   fd 3: 大きさの変更（"cols rows\n"）
const PY_HELPER = String.raw`
import os, sys, pty, select, signal, struct, fcntl, termios
cols, rows = int(sys.argv[1]), int(sys.argv[2])
argv = sys.argv[3:]
pid, fd = pty.fork()
if pid == 0:
    try:
        os.execvp(argv[0], argv)
    except Exception as e:
        sys.stderr.write(str(e) + "\n")
    os._exit(127)
def setsize(c, r):
    fcntl.ioctl(fd, termios.TIOCSWINSZ, struct.pack('HHHH', r, c, 0, 0))
def wall(f, b):
    while b:
        n = os.write(f, b)
        b = b[n:]
def bye(*a):
    try:
        os.kill(pid, signal.SIGHUP)
    except Exception:
        pass
    os._exit(0)
setsize(cols, rows)
signal.signal(signal.SIGTERM, bye)
signal.signal(signal.SIGHUP, bye)
fds = [0, fd, 3]
ctl = b''
while True:
    try:
        rr, _, _ = select.select(fds, [], [])
    except InterruptedError:
        continue
    if fd in rr:
        try:
            d = os.read(fd, 65536)
        except OSError:
            d = b''
        if not d:
            break
        wall(1, d)
    if 0 in rr:
        d = os.read(0, 65536)
        if not d:
            bye()
        wall(fd, d)
    if 3 in rr:
        d = os.read(3, 4096)
        if not d:
            fds.remove(3)
        else:
            ctl += d
            while b'\n' in ctl:
                line, ctl = ctl.split(b'\n', 1)
                try:
                    c, r = [int(x) for x in line.split()]
                    setsize(c, r)
                    os.kill(pid, signal.SIGWINCH)
                except Exception:
                    pass
_, st = os.waitpid(pid, 0)
if os.WIFEXITED(st):
    sys.exit(os.WEXITSTATUS(st))
sys.exit(128 + (os.WTERMSIG(st) if os.WIFSIGNALED(st) else 0))
`;

function clampInt(v, min, max, def) {
  const n = Math.floor(Number(v));
  if (!Number.isFinite(n)) return def;
  return Math.min(max, Math.max(min, n));
}

function cleanSize(cols, rows) {
  return { cols: clampInt(cols, MIN_COLS, MAX_COLS, 80), rows: clampInt(rows, MIN_ROWS, MAX_ROWS, 24) };
}

// 文字列の最後の limit 文字だけを残す。サロゲートペアの片方や、ESC シーケンスの途中から始めないように少し進める
function trimScrollback(buf, limit = SCROLLBACK_LIMIT) {
  if (buf.length <= limit) return buf;
  let start = buf.length - limit;
  const c = buf.charCodeAt(start);
  if (c >= 0xdc00 && c <= 0xdfff) start++;
  // 行の頭から始める（途中の ESC シーケンスや、色の途中から描き始めないように）。近くに改行が無ければそのまま
  const nl = buf.indexOf('\n', start);
  if (nl !== -1 && nl - start < 4096) start = nl + 1;
  return buf.slice(start);
}

/**
 * どのシェルを、どう起動するか（純粋な関数。テストで使う）
 * @param {{ platform: string, env: Record<string,string|undefined>, cwd: string, which?: (cmd: string) => string|null, parseWslPath?: (p: string) => ({distro: string, linux: string}|null), wslExe?: string }} o
 * @returns {{ file: string, args: string[], cwd: string|undefined, name: string }}
 */
function shellCommand({ platform, env, cwd, which = () => null, parseWslPath = () => null, wslExe = 'wsl.exe' }) {
  if (platform === 'win32') {
    const w = cwd ? parseWslPath(cwd) : null;
    // WSL のリポジトリ: その distro の既定のシェルを、Linux 側のフォルダで開く（UNC のパスは cwd にできない）
    if (w) return { file: wslExe, args: ['-d', w.distro, '--cd', w.linux || '~'], cwd: undefined, name: `WSL: ${w.distro}` };
    const pwsh = which('pwsh');
    if (pwsh) return { file: pwsh, args: ['-NoLogo'], cwd, name: 'pwsh' };
    const root = env.SystemRoot || env.SYSTEMROOT || 'C:\\Windows';
    const ps = which('powershell.exe') || path.win32.join(root, 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe');
    return { file: ps, args: ['-NoLogo'], cwd, name: 'powershell' };
  }
  const shell = String(env.SHELL || '').trim() || (platform === 'darwin' ? '/bin/zsh' : '/bin/bash');
  return { file: shell, args: ['-l'], cwd, name: path.posix.basename(shell) };
}

// シェルに渡す環境変数。Electron が足す変数は外し、ターミナルらしい値を入れる
function shellEnv(env, extra = {}) {
  const out = {};
  for (const [k, v] of Object.entries(env || {})) {
    if (v == null) continue;
    if (k === 'ELECTRON_RUN_AS_NODE' || k.startsWith('ELECTRON_') || k === 'NODE_OPTIONS' || k === 'CHROME_DESKTOP') continue;
    out[k] = String(v);
  }
  out.TERM = 'xterm-256color';
  out.COLORTERM = 'truecolor';
  out.TERM_PROGRAM = 'WorktreeKanban';
  if (!out.LANG && process.platform !== 'win32') out.LANG = 'en_US.UTF-8';
  return { ...out, ...extra };
}

/**
 * OS の既定のターミナルを、そのフォルダで開くためのコマンドの候補（上から順に試す）
 * @returns {{ file: string, args: string[], cwd?: string, detached?: boolean }[]}
 */
function externalTerminalCommands({ platform, cwd, parseWslPath = () => null, wslExe = 'wsl.exe' }) {
  if (platform === 'darwin') return [{ file: 'open', args: ['-a', 'Terminal', cwd] }];
  if (platform === 'win32') {
    const w = parseWslPath(cwd);
    if (w) {
      return [
        { file: 'wt.exe', args: ['-d', cwd, wslExe, '-d', w.distro, '--cd', w.linux || '~'] },
        { file: 'cmd.exe', args: ['/c', 'start', '""', wslExe, '-d', w.distro, '--cd', w.linux || '~'] },
      ];
    }
    return [
      { file: 'wt.exe', args: ['-d', cwd] },
      { file: 'cmd.exe', args: ['/c', 'start', '""', '/D', cwd, 'powershell.exe', '-NoLogo'], cwd },
    ];
  }
  return [
    { file: 'x-terminal-emulator', args: [], cwd },
    { file: 'gnome-terminal', args: [`--working-directory=${cwd}`] },
    { file: 'konsole', args: ['--workdir', cwd] },
    { file: 'xfce4-terminal', args: [`--working-directory=${cwd}`] },
    { file: 'kitty', args: ['--directory', cwd] },
    { file: 'alacritty', args: ['--working-directory', cwd] },
    { file: 'xterm', args: [], cwd },
  ];
}

// node-pty の macOS 用 spawn-helper に実行の権限を付ける（scripts/fix-node-pty.js と同じ。アプリの中で入れ直されたとき用）
function fixSpawnHelper(ptyMain) {
  if (process.platform !== 'darwin' || !ptyMain) return;
  const dir = path.join(path.dirname(ptyMain), '..', 'prebuilds', `${process.platform}-${process.arch}`).replace('app.asar', 'app.asar.unpacked');
  const helper = path.join(dir, 'spawn-helper');
  try {
    const st = fs.statSync(helper);
    if ((st.mode & 0o111) !== 0o111) fs.chmodSync(helper, 0o755);
  } catch {
    /* 無い・書けない: そのまま試す */
  }
}

// node-pty を読み込む。読めなければ null
function defaultLoadPty() {
  try {
    const main = require.resolve('node-pty');
    fixSpawnHelper(main);
    return require('node-pty');
  } catch {
    return null;
  }
}

// python3 の PTY で、node-pty と同じ形（onData / onExit / write / resize / kill）の物を作る
function spawnPython(python, file, args, { cols, rows, cwd, env }) {
  const child = spawn(python, ['-u', '-c', PY_HELPER, String(cols), String(rows), file, ...args], { cwd, env, stdio: ['pipe', 'pipe', 'pipe', 'pipe'] });
  const em = new EventEmitter();
  const dec = new StringDecoder('utf8');
  let exited = false;
  const onOut = (b) => em.emit('data', dec.write(b));
  child.stdout.on('data', onOut);
  child.stderr.on('data', onOut);
  const done = (code) => {
    if (exited) return;
    exited = true;
    const rest = dec.end();
    if (rest) em.emit('data', rest);
    em.emit('exit', code);
  };
  child.on('exit', (code, signal) => done(code == null ? (signal ? 128 : 1) : code));
  child.on('error', (err) => {
    em.emit('data', `\r\n${err.message}\r\n`);
    done(1);
  });
  for (const s of [child.stdin, child.stdio[3]]) s?.on('error', () => {});
  return {
    pid: child.pid,
    onData: (fn) => em.on('data', fn),
    onExit: (fn) => em.on('exit', (exitCode) => fn({ exitCode })),
    write: (d) => {
      if (!exited) child.stdin.write(d);
    },
    resize: (c, r) => {
      if (!exited) child.stdio[3].write(`${c} ${r}\n`);
    },
    kill: () => {
      if (!exited) child.kill('SIGTERM');
    },
  };
}

class TerminalManager extends EventEmitter {
  /**
   * @param {object} o
   * @param {() => any} [o.loadPty]  node-pty を返す（読めなければ null）
   * @param {(cmd: string) => string|null} [o.which]  コマンドの場所を探す
   * @param {(python: string, file: string, args: string[], opts: object) => any} [o.spawnFallback]
   * @param {string} [o.platform]
   * @param {Record<string,string|undefined>} [o.env]
   * @param {(p: string) => any} [o.parseWslPath]
   * @param {string} [o.wslExe]
   * @param {(file: string, args: string[], opts: object) => any} [o.spawnDetached]  openExternal に使う
   * @param {number} [o.flushMs]
   */
  constructor(o = {}) {
    super();
    this.loadPty = o.loadPty || defaultLoadPty;
    this.which = o.which || (() => null);
    this.spawnFallback = o.spawnFallback || spawnPython;
    this.platform = o.platform || process.platform;
    this.env = o.env || process.env;
    this.parseWslPath = o.parseWslPath || (() => null);
    this.wslExe = o.wslExe || 'wsl.exe';
    this.spawnDetached = o.spawnDetached || defaultSpawnDetached;
    this.flushMs = o.flushMs == null ? FLUSH_MS : o.flushMs;
    this.prefix = crypto.randomBytes(3).toString('hex'); // マシン（起動）ごとの印。遠隔のホストの id と重ならないように
    this.seq = 0;
    this.sessions = new Map();
    this._backend = undefined;
  }

  // PTY の作り方を決める（1回だけ調べる）
  backend() {
    if (this._backend !== undefined) return this._backend;
    const pty = this.loadPty();
    if (pty && typeof pty.spawn === 'function') this._backend = { kind: 'node-pty', pty };
    else if (this.platform !== 'win32') {
      const python = this.which('python3');
      this._backend = python ? { kind: 'python', python } : null;
    } else this._backend = null;
    return this._backend;
  }

  /** @returns {{ ok: boolean, backend: string|null, platform: string }} */
  available() {
    const b = this.backend();
    return { ok: !!b, backend: b ? b.kind : null, platform: this.platform };
  }

  info(s) {
    return { id: s.id, kind: s.kind, cardId: s.cardId || null, cwd: s.cwd, title: s.title, shell: s.shell, exited: s.exited, exitCode: s.exitCode, createdAt: s.createdAt };
  }

  /** 動いている（終わったものも、閉じるまでは残る）ターミナルの一覧 */
  list() {
    return [...this.sessions.values()].map((s) => this.info(s));
  }

  get(id) {
    return this.sessions.get(String(id || '')) || null;
  }

  must(id) {
    const s = this.get(id);
    if (!s) throw new Error('terminal not found');
    return s;
  }

  findCard(cardId) {
    for (const s of this.sessions.values()) if (s.kind === 'card' && s.cardId === cardId) return s;
    return null;
  }

  /**
   * ターミナルを開く。kind: 'card' で、そのタスクのものが残っていれば（終わっていなければ）それを返す
   * @param {{ kind?: 'card'|'free', cardId?: string, cwd: string, title?: string, cols?: number, rows?: number }} o
   * @returns {{ id: string, kind: string, cardId: string|null, cwd: string, title: string, scrollback: string, exited: boolean, reused: boolean }}
   */
  open(o = {}) {
    const kind = o.kind === 'card' ? 'card' : 'free';
    const cardId = kind === 'card' ? String(o.cardId || '') : null;
    if (kind === 'card' && !cardId) throw new Error('cardId is required');
    const { cols, rows } = cleanSize(o.cols, o.rows);
    if (kind === 'card') {
      const old = this.findCard(cardId);
      if (old && !old.exited) {
        // まだ送っていない出力は先に送る（返す scrollback に入っているので、あとから同じものを送らない）
        this.flush(old);
        this.resize(old.id, cols, rows);
        return { ...this.info(old), scrollback: old.buf, offset: old.total, reused: true };
      }
      if (old) this.close(old.id);
    }
    const b = this.backend();
    if (!b) throw new Error('terminal is not available');
    const cwd = String(o.cwd || '') || os.homedir();
    const sh = shellCommand({ platform: this.platform, env: this.env, cwd, which: this.which, parseWslPath: this.parseWslPath, wslExe: this.wslExe });
    if (sh.cwd && !this.parseWslPath(sh.cwd)) {
      let ok = false;
      try {
        ok = fs.statSync(sh.cwd).isDirectory();
      } catch {
        ok = false;
      }
      if (!ok) throw new Error(`folder not found: ${sh.cwd}`);
    }
    const env = shellEnv(this.env);
    const opts = { name: 'xterm-256color', cols, rows, cwd: sh.cwd, env };
    const proc = b.kind === 'node-pty' ? b.pty.spawn(sh.file, sh.args, this.platform === 'win32' ? { ...opts, useConpty: true } : opts) : this.spawnFallback(b.python, sh.file, sh.args, opts);
    const id = `t-${this.prefix}-${++this.seq}`;
    const s = { id, kind, cardId, cwd, title: String(o.title || '') || sh.name, shell: sh.name, proc, buf: '', total: 0, pending: '', timer: null, readers: new Set(), exited: false, exitCode: null, cols, rows, createdAt: Date.now() };
    this.sessions.set(id, s);
    proc.onData((d) => this.onData(s, d));
    proc.onExit((e) => this.onExit(s, e && typeof e === 'object' ? e.exitCode : e));
    this.emit('changed');
    return { ...this.info(s), scrollback: '', offset: 0, reused: false };
  }

  onData(s, d) {
    if (!d) return;
    const text = String(d);
    s.buf = trimScrollback(s.buf + text);
    s.total += text.length;
    this.wakeReaders(s);
    s.pending += text;
    if (s.pending.length >= MAX_FLUSH || this.flushMs <= 0) return this.flush(s);
    if (!s.timer) s.timer = setTimeout(() => this.flush(s), this.flushMs);
  }

  flush(s) {
    if (s.timer) clearTimeout(s.timer);
    s.timer = null;
    if (!s.pending) return;
    const chunk = s.pending;
    s.pending = '';
    this.emit('data', s.id, chunk);
  }

  onExit(s, code) {
    if (s.exited) return;
    this.flush(s);
    s.exited = true;
    s.exitCode = code == null ? null : Number(code);
    this.emit('exit', s.id, s.exitCode);
    this.emit('changed');
    this.wakeReaders(s);
  }

  wakeReaders(s) {
    for (const r of [...s.readers]) r();
  }

  /**
   * 出力を、offset（それまでに受け取った文字数）の続きから読む。新しい出力が無ければ waitMs まで待つ（待ち受け型のポーリング）。
   * スマホは Cloudflare の Quick Tunnel 越しにイベントの流れを使えないことがあるので、ターミナルの出力はこれで読む
   * @returns {Promise<{ data: string, offset: number, reset: boolean, exited: boolean, exitCode: number|null }>}
   *   reset: offset が古すぎて（scrollback から外れて）続きを渡せないので、data は持っている全部
   */
  async read(id, offset = 0, waitMs = 0) {
    const s = this.must(id);
    const since = Math.max(0, Math.floor(Number(offset)) || 0);
    if (since >= s.total && !s.exited && waitMs > 0) {
      await new Promise((resolve) => {
        const done = () => {
          clearTimeout(t);
          s.readers.delete(done);
          resolve();
        };
        const t = setTimeout(done, Math.min(25000, waitMs));
        s.readers.add(done);
      });
    }
    const start = s.total - s.buf.length; // buf の頭が、全体の何文字目か
    const reset = since < start || since > s.total;
    const data = reset ? s.buf : s.buf.slice(since - start);
    return { data, offset: s.total, reset, exited: s.exited, exitCode: s.exitCode };
  }

  /** 開き直したときに画面へ返す（それまでの出力と、今の状態） */
  attach(id) {
    const s = this.must(id);
    this.flush(s);
    return { ...this.info(s), scrollback: s.buf, offset: s.total };
  }

  write(id, data) {
    const s = this.must(id);
    if (s.exited) return false;
    const d = String(data == null ? '' : data);
    if (d.length > MAX_WRITE) throw new Error('input is too long');
    if (d) s.proc.write(d);
    return true;
  }

  resize(id, cols, rows) {
    const s = this.must(id);
    const size = cleanSize(cols, rows);
    if (s.exited || (size.cols === s.cols && size.rows === s.rows)) return false;
    s.cols = size.cols;
    s.rows = size.rows;
    try {
      s.proc.resize(size.cols, size.rows);
    } catch {
      /* 終わる途中 */
    }
    return true;
  }

  /** 閉じる（シェルを止めて、一覧から外す） */
  close(id) {
    const s = this.get(id);
    if (!s) return false;
    this.sessions.delete(s.id);
    if (s.timer) clearTimeout(s.timer);
    this.wakeReaders(s);
    if (!s.exited) {
      s.exited = true;
      try {
        s.proc.kill();
      } catch {
        /* もう終わっている */
      }
      this.emit('exit', s.id, null);
    }
    this.emit('closed', s.id);
    this.emit('changed');
    return true;
  }

  /** 残っているタスクの id にない、タスクのターミナルを閉じる（タスクを消したとき） */
  prune(cardIds) {
    const keep = new Set(cardIds || []);
    let n = 0;
    for (const s of [...this.sessions.values()]) if (s.kind === 'card' && !keep.has(s.cardId) && this.close(s.id)) n++;
    return n;
  }

  closeAll() {
    for (const id of [...this.sessions.keys()]) this.close(id);
  }

  /** OS の既定のターミナルを、そのフォルダで開く（アプリの中で開けないときの代わり） */
  async openExternal(cwd) {
    const dir = String(cwd || '') || os.homedir();
    const list = externalTerminalCommands({ platform: this.platform, cwd: dir, parseWslPath: this.parseWslPath, wslExe: this.wslExe });
    let last = null;
    for (const c of list) {
      if (this.platform === 'linux' && !this.which(c.file)) continue;
      try {
        await this.spawnDetached(c.file, c.args, { cwd: c.cwd });
        return { command: c.file };
      } catch (err) {
        last = err;
      }
    }
    throw last || new Error('no terminal application found');
  }
}

// 外のアプリを起動して、待たずに切り離す。起動できなかったら（ENOENT など）reject
function defaultSpawnDetached(file, args, { cwd } = {}) {
  return new Promise((resolve, reject) => {
    let child;
    try {
      child = spawn(file, args, { cwd: cwd && !/^[\\/]{2}/.test(cwd) ? cwd : undefined, detached: true, stdio: 'ignore', windowsHide: false });
    } catch (err) {
      reject(err);
      return;
    }
    child.once('error', reject);
    child.once('spawn', () => {
      child.unref();
      resolve();
    });
  });
}

module.exports = { TerminalManager, shellCommand, shellEnv, externalTerminalCommands, trimScrollback, cleanSize, spawnPython, PY_HELPER, SCROLLBACK_LIMIT };
