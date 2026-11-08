// アプリの中のターミナル（src/terminal.js）: シェルの決め方・出力のまとめ方・開き直し・読み出し・タスクを消したとき
const test = require('node:test');
const assert = require('node:assert');
const os = require('os');
const { EventEmitter } = require('events');
const { TerminalManager, shellCommand, shellEnv, externalTerminalCommands, trimScrollback, cleanSize } = require('../src/terminal');
const { terminalSide, isProxyChannel } = require('../src/remote');
const wsl = require('../src/wsl');

// node-pty の代わり。spawn した物を覚えておき、テストから出力・終了を起こす
function fakePty() {
  const spawned = [];
  return {
    spawned,
    spawn(file, args, opts) {
      const em = new EventEmitter();
      const p = {
        file,
        args,
        opts,
        written: [],
        sizes: [],
        killed: false,
        onData: (fn) => em.on('data', fn),
        onExit: (fn) => em.on('exit', fn),
        write: (d) => p.written.push(d),
        resize: (c, r) => p.sizes.push([c, r]),
        kill: () => {
          p.killed = true;
        },
        out: (d) => em.emit('data', d),
        exit: (code) => em.emit('exit', { exitCode: code }),
      };
      spawned.push(p);
      return p;
    },
  };
}

function manager(extra = {}) {
  const pty = fakePty();
  const m = new TerminalManager({ loadPty: () => pty, platform: 'linux', env: { SHELL: '/bin/zsh', PATH: '/usr/bin' }, flushMs: 0, ...extra });
  return { m, pty };
}

test('shellCommand: Mac・Linux は $SHELL のログインシェル、無ければ OS の既定', () => {
  assert.deepStrictEqual(shellCommand({ platform: 'darwin', env: { SHELL: '/opt/homebrew/bin/fish' }, cwd: '/r' }), { file: '/opt/homebrew/bin/fish', args: ['-l'], cwd: '/r', name: 'fish' });
  assert.strictEqual(shellCommand({ platform: 'darwin', env: {}, cwd: '/r' }).file, '/bin/zsh');
  assert.strictEqual(shellCommand({ platform: 'linux', env: {}, cwd: '/r' }).file, '/bin/bash');
});

test('shellCommand: Windows は pwsh、無ければ Windows PowerShell。WSL のフォルダは wsl.exe で、その distro の中で開く', () => {
  const which = (c) => (c === 'pwsh' ? 'C:\\pwsh\\pwsh.exe' : null);
  assert.deepStrictEqual(shellCommand({ platform: 'win32', env: {}, cwd: 'C:\\r', which }), { file: 'C:\\pwsh\\pwsh.exe', args: ['-NoLogo'], cwd: 'C:\\r', name: 'pwsh' });
  const ps = shellCommand({ platform: 'win32', env: { SystemRoot: 'D:\\Win' }, cwd: 'C:\\r' });
  assert.strictEqual(ps.file, 'D:\\Win\\System32\\WindowsPowerShell\\v1.0\\powershell.exe');
  const w = shellCommand({ platform: 'win32', env: {}, cwd: '\\\\wsl.localhost\\Ubuntu\\home\\me\\repo', parseWslPath: wsl.parseWslPath, wslExe: 'wsl.exe' });
  assert.deepStrictEqual(w, { file: 'wsl.exe', args: ['-d', 'Ubuntu', '--cd', '/home/me/repo'], cwd: undefined, name: 'WSL: Ubuntu' });
});

test('shellEnv: Electron の変数を外し、色の使えるターミナルにする', () => {
  const env = shellEnv({ PATH: '/bin', ELECTRON_RUN_AS_NODE: '1', NODE_OPTIONS: '--x', HOME: '/h', EMPTY: undefined });
  assert.strictEqual(env.PATH, '/bin');
  assert.strictEqual(env.HOME, '/h');
  assert.strictEqual(env.TERM, 'xterm-256color');
  assert.ok(!('ELECTRON_RUN_AS_NODE' in env));
  assert.ok(!('NODE_OPTIONS' in env));
  assert.ok(!('EMPTY' in env));
});

test('externalTerminalCommands: OS ごとの既定のターミナル', () => {
  assert.deepStrictEqual(externalTerminalCommands({ platform: 'darwin', cwd: '/r' }), [{ file: 'open', args: ['-a', 'Terminal', '/r'] }]);
  assert.strictEqual(externalTerminalCommands({ platform: 'win32', cwd: 'C:\\r' })[0].file, 'wt.exe');
  const w = externalTerminalCommands({ platform: 'win32', cwd: '\\\\wsl$\\Ubuntu\\home\\me', parseWslPath: wsl.parseWslPath });
  assert.deepStrictEqual(w[0].args.slice(-4), ['-d', 'Ubuntu', '--cd', '/home/me']);
  assert.ok(externalTerminalCommands({ platform: 'linux', cwd: '/r' }).some((c) => c.file === 'gnome-terminal'));
});

test('trimScrollback / cleanSize', () => {
  assert.strictEqual(trimScrollback('abc', 10), 'abc');
  assert.strictEqual(trimScrollback('line1\nline2\nline3', 8), 'line3');
  assert.deepStrictEqual(cleanSize('x', -3), { cols: 80, rows: 1 });
  assert.deepStrictEqual(cleanSize(99999, 30.7), { cols: 1000, rows: 30 });
});

test('available: node-pty が無ければ python3、どちらも無ければ使えない（Windows は python に頼らない）', () => {
  assert.deepStrictEqual(manager().m.available(), { ok: true, backend: 'node-pty', platform: 'linux' });
  const py = new TerminalManager({ loadPty: () => null, platform: 'linux', which: (c) => (c === 'python3' ? '/usr/bin/python3' : null) });
  assert.strictEqual(py.available().backend, 'python');
  assert.strictEqual(new TerminalManager({ loadPty: () => null, platform: 'linux' }).available().ok, false);
  assert.strictEqual(new TerminalManager({ loadPty: () => null, platform: 'win32', which: () => 'C:\\python3.exe' }).available().ok, false);
  assert.throws(() => new TerminalManager({ loadPty: () => null, platform: 'linux' }).open({ cwd: os.tmpdir() }), /not available/);
});

test('open / write / resize / 出力 / 終了 / close', () => {
  const { m, pty } = manager();
  const events = [];
  m.on('data', (id, d) => events.push(['data', id, d]));
  m.on('exit', (id, c) => events.push(['exit', id, c]));
  const t = m.open({ kind: 'free', cwd: os.tmpdir(), cols: 100, rows: 30 });
  assert.match(t.id, new RegExp(`^t-${m.prefix}-1$`));
  assert.strictEqual(t.kind, 'free');
  assert.strictEqual(t.title, 'zsh');
  const p = pty.spawned[0];
  assert.strictEqual(p.file, '/bin/zsh');
  assert.deepStrictEqual(p.args, ['-l']);
  assert.strictEqual(p.opts.cwd, os.tmpdir());
  assert.strictEqual(p.opts.cols, 100);
  assert.strictEqual(p.opts.env.TERM, 'xterm-256color');
  m.write(t.id, 'ls\r');
  assert.deepStrictEqual(p.written, ['ls\r']);
  assert.strictEqual(m.resize(t.id, 120, 40), true);
  assert.strictEqual(m.resize(t.id, 120, 40), false); // 同じ大きさなら送らない
  assert.deepStrictEqual(p.sizes, [[120, 40]]);
  p.out('hello');
  assert.deepStrictEqual(events[0], ['data', t.id, 'hello']);
  assert.strictEqual(m.attach(t.id).scrollback, 'hello');
  p.exit(3);
  assert.deepStrictEqual(events[1], ['exit', t.id, 3]);
  assert.strictEqual(m.write(t.id, 'x'), false); // 終わったら書かない
  assert.strictEqual(m.list()[0].exited, true); // 閉じるまでは一覧に残る
  assert.strictEqual(m.close(t.id), true);
  assert.deepStrictEqual(m.list(), []);
  assert.throws(() => m.write(t.id, 'x'), /not found/);
});

test('出力はまとめて送る（flushMs）', async () => {
  const { m, pty } = manager({ flushMs: 5 });
  const got = [];
  m.on('data', (id, d) => got.push(d));
  const t = m.open({ cwd: os.tmpdir() });
  pty.spawned[0].out('a');
  pty.spawned[0].out('b');
  pty.spawned[0].out('c');
  assert.deepStrictEqual(got, []);
  await new Promise((r) => setTimeout(r, 20));
  assert.deepStrictEqual(got, ['abc']);
  m.close(t.id);
});

test('タスクのターミナルはタスクごとに1つ。開き直すと同じものと、それまでの出力を返す', () => {
  const { m, pty } = manager();
  const a = m.open({ kind: 'card', cardId: 'c1', cwd: os.tmpdir(), title: 'Fix bug' });
  pty.spawned[0].out('before');
  const b = m.open({ kind: 'card', cardId: 'c1', cwd: os.tmpdir(), cols: 90, rows: 20 });
  assert.strictEqual(b.id, a.id);
  assert.strictEqual(b.reused, true);
  assert.strictEqual(b.scrollback, 'before');
  assert.strictEqual(b.title, 'Fix bug');
  assert.strictEqual(pty.spawned.length, 1);
  // 終わっていたら、新しく開き直す
  pty.spawned[0].exit(0);
  const c = m.open({ kind: 'card', cardId: 'c1', cwd: os.tmpdir() });
  assert.notStrictEqual(c.id, a.id);
  assert.strictEqual(m.list().length, 1);
  assert.throws(() => m.open({ kind: 'card', cwd: os.tmpdir() }), /cardId/);
});

test('自由なターミナルはいくつでも開ける。無いフォルダでは開かない', () => {
  const { m } = manager();
  m.open({ cwd: os.tmpdir() });
  m.open({ cwd: os.tmpdir() });
  assert.strictEqual(m.list().length, 2);
  assert.throws(() => m.open({ cwd: '/no/such/folder/xyz' }), /folder not found/);
});

test('prune: 消えたタスクのターミナルだけ閉じる。closeAll はシェルを止める', () => {
  const { m, pty } = manager();
  m.open({ kind: 'card', cardId: 'keep', cwd: os.tmpdir() });
  m.open({ kind: 'card', cardId: 'gone', cwd: os.tmpdir() });
  m.open({ kind: 'free', cwd: os.tmpdir() });
  assert.strictEqual(m.prune(['keep']), 1);
  assert.deepStrictEqual(m.list().map((t) => t.cardId), ['keep', null]);
  assert.strictEqual(pty.spawned[1].killed, true);
  m.closeAll();
  assert.deepStrictEqual(m.list(), []);
  assert.ok(pty.spawned.every((p) => p.killed));
});

test('read: offset の続きを返し、無ければ待つ。古すぎる offset は reset で全部を返す', async () => {
  const { m, pty } = manager();
  const t = m.open({ cwd: os.tmpdir() });
  const p = pty.spawned[0];
  p.out('abc');
  assert.deepStrictEqual(await m.read(t.id, 0), { data: 'abc', offset: 3, reset: false, exited: false, exitCode: null });
  assert.strictEqual((await m.read(t.id, 1)).data, 'bc');
  const waiting = m.read(t.id, 3, 5000);
  setTimeout(() => p.out('de'), 10);
  assert.deepStrictEqual(await waiting, { data: 'de', offset: 5, reset: false, exited: false, exitCode: null });
  assert.strictEqual((await m.read(t.id, 99)).reset, true);
  // 待っているあいだに終わったら、すぐ返す
  const w2 = m.read(t.id, 5, 5000);
  setTimeout(() => p.exit(0), 10);
  const r = await w2;
  assert.strictEqual(r.exited, true);
  assert.strictEqual(r.exitCode, 0);
});

test('openExternal: 起動できるものを上から試す（Linux は PATH にあるものだけ）', async () => {
  const tried = [];
  const m = new TerminalManager({
    loadPty: () => null,
    platform: 'linux',
    which: (c) => (c === 'konsole' || c === 'xterm' ? `/usr/bin/${c}` : null),
    spawnDetached: async (file) => {
      tried.push(file);
      if (file === 'konsole') throw new Error('ENOENT');
    },
  });
  assert.deepStrictEqual(await m.openExternal('/r'), { command: 'xterm' });
  assert.deepStrictEqual(tried, ['konsole', 'xterm']);
  const none = new TerminalManager({ loadPty: () => null, platform: 'linux', which: () => null, spawnDetached: async () => {} });
  await assert.rejects(() => none.openExternal('/r'), /no terminal/);
});

test('遠隔操作: ターミナルの操作はホストへ転送し、id の印で開いた側へ送る', () => {
  for (const c of ['terminal:available', 'terminal:list', 'terminal:open', 'terminal:attach', 'terminal:write', 'terminal:resize', 'terminal:close']) assert.ok(isProxyChannel(c), c);
  assert.strictEqual(isProxyChannel('terminal:openExternal'), false);
  assert.strictEqual(terminalSide('terminal:write', { id: 't-abc123-4' }, 'abc123'), 'local');
  assert.strictEqual(terminalSide('terminal:write', { id: 't-ffffff-4' }, 'abc123'), 'host');
  assert.strictEqual(terminalSide('terminal:close', { id: 't-ffffff-4' }, 'abc123'), 'host');
  assert.strictEqual(terminalSide('terminal:open', { kind: 'free' }, 'abc123'), null);
  assert.strictEqual(terminalSide('terminal:write', {}, 'abc123'), null);
});

test('python3 の PTY（node-pty が無い Mac・Linux 用）で、実際にシェルが動く', { skip: process.platform === 'win32' || !require('../src/env').resolveCommand('python3') }, async () => {
  const m = new TerminalManager({ loadPty: () => null, which: require('../src/env').resolveCommand, env: { ...process.env, SHELL: '/bin/sh' }, flushMs: 0 });
  const t = m.open({ cwd: os.tmpdir(), cols: 77, rows: 22 });
  let out = '';
  m.on('data', (id, d) => {
    out += d;
  });
  const exited = new Promise((r) => m.on('exit', (id, code) => r(code)));
  m.write(t.id, 'stty size; echo OK_$((40+2)); exit 5\n');
  assert.strictEqual(await exited, 5);
  assert.match(out, /22 77/);
  assert.match(out, /OK_42/);
});
