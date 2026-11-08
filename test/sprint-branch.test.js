// スプリントごとのブランチ: タスクはスプリントのブランチから始めてそこへマージし、スプリントのブランチはボタンでベースへマージ・PR にする
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { execFileSync } = require('child_process');
const { Store } = require('../src/store');
const { AgentManager } = require('../src/agent');
const { createCycleApi } = require('../src/cycles');
const M = require('../renderer/cycle-model');

const FAKE = path.join(__dirname, 'fake-claude.js');

function setup({ sprintBranch = true } = {}) {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'worktree-kanban-sprint-'));
  const repo = path.join(tmp, 'repo');
  fs.mkdirSync(repo);
  const g = (...a) => execFileSync('git', a, { cwd: repo }).toString().trim();
  g('init', '-q', '-b', 'main');
  fs.writeFileSync(path.join(repo, 'README.md'), 'hello\n');
  g('add', '.');
  g('-c', 'user.name=t', '-c', 'user.email=t@t', 'commit', '-qm', 'init');
  const fakeBin = path.join(tmp, 'claude');
  fs.writeFileSync(fakeBin, `#!/bin/sh\nexec "${process.execPath}" "${FAKE}" "$@"\n`, { mode: 0o755 });
  const store = new Store(path.join(tmp, 'data', 'board.json'));
  Object.assign(store.settings, { repoPath: repo, claudePath: fakeBin, maxParallel: 1, permissionMode: 'bypassPermissions', sprintBranch });
  const agents = new AgentManager(store, { mcpScript: path.join(__dirname, '..', 'src', 'permission-mcp.js'), mcpDir: path.join(tmp, 'data', 'mcp'), nodeBin: process.execPath });
  const cycles = createCycleApi({ store });
  return { tmp, repo, store, agents, cycles, g };
}

function waitFor(pred, ms = 10000) {
  return new Promise((resolve, reject) => {
    const t0 = Date.now();
    const iv = setInterval(() => {
      if (pred()) {
        clearInterval(iv);
        resolve();
      } else if (Date.now() - t0 > ms) {
        clearInterval(iv);
        reject(new Error('timeout'));
      }
    }, 20);
  });
}

test('ブランチ名: sprint/<名前を英数字にしたもの>-<ID の先頭8文字>。英数字がなければ sprint/<ID>', () => {
  assert.strictEqual(M.sprintBranchName({ id: 'ab12cd34ef', name: 'v0.2 Release!' }), 'sprint/v0-2-release-ab12cd34');
  assert.strictEqual(M.sprintBranchName({ id: 'ab12cd34', name: '11月前半' }), 'sprint/11-ab12cd34');
  assert.strictEqual(M.sprintBranchName({ id: 'ab12cd34', name: '前半' }), 'sprint/ab12cd34');
  assert.strictEqual(M.cleanCycle({ id: 'a', repoPath: '/r', name: 'x', branch: '-bad' }).branch, undefined);
  const c = M.cleanCycle({ id: 'a', repoPath: '/r', name: 'x', branch: 'sprint/x-a', branchBase: 'main', mergedAt: 5, prUrl: 'https://github.com/o/r/pull/1' });
  assert.deepStrictEqual([c.branch, c.branchBase, c.mergedAt, c.prUrl], ['sprint/x-a', 'main', 5, 'https://github.com/o/r/pull/1']);
});

test('branchCycleFor: 1つならそれ、複数なら選んだもの（選んでいなければ候補を返す）。完了したスプリントは使わない', () => {
  const cys = [
    { id: 'a', name: 'A', startDate: '2026-11-10', done: false },
    { id: 'b', name: 'B', startDate: '2026-11-01', done: false },
    { id: 'z', name: 'Z', done: true },
  ];
  assert.strictEqual(M.branchCycleFor({ id: 'c' }, [], cys).cycle, null);
  assert.strictEqual(M.branchCycleFor({ id: 'c', cycleIds: ['a', 'z'] }, [], cys).cycle.id, 'a');
  const amb = M.branchCycleFor({ id: 'c', cycleIds: ['a', 'b'] }, [], cys);
  assert.strictEqual(amb.cycle, null);
  assert.deepStrictEqual(amb.choices.map((x) => x.id), ['b', 'a']);
  assert.strictEqual(M.branchCycleFor({ id: 'c', cycleIds: ['a', 'b'], branchCycleId: 'a' }, [], cys).cycle.id, 'a');
  assert.strictEqual(M.branchCycleFor({ id: 'c', cycleIds: ['a', 'b'], branchCycleId: 'z' }, [], cys).cycle, null);
});

test('setCard: ブランチを使うスプリントを覚え、外したスプリント・消したスプリントなら忘れる', () => {
  const { store, cycles, agents } = setup();
  const a = cycles.create({ name: 'A' });
  const b = cycles.create({ name: 'B' });
  const c = agents.createCard({ title: 't', prompt: 'p' });
  cycles.setCard({ id: c.id, cycleIds: [a.id, b.id], branchCycleId: b.id });
  assert.strictEqual(store.card(c.id).branchCycleId, b.id);
  cycles.setCard({ id: c.id, cycleIds: [a.id, b.id] });
  assert.strictEqual(store.card(c.id).branchCycleId, b.id, '渡さなければ前のまま');
  cycles.setCard({ id: c.id, cycleIds: [a.id] });
  assert.strictEqual(store.card(c.id).branchCycleId, undefined);
  cycles.setCard({ id: c.id, cycleIds: [a.id, b.id], branchCycleId: a.id });
  cycles.delete(a.id);
  assert.strictEqual(store.card(c.id).branchCycleId, undefined);
  cycles.setCard({ id: c.id, cycleIds: [b.id], branchCycleId: '' });
  assert.strictEqual(store.card(c.id).branchCycleId, undefined);
});

test('設定がオン: スプリントのタスクは、最初のタスクで作ったスプリントのブランチから始めて、そこへマージする', async () => {
  const { repo, store, agents, cycles, g } = setup();
  const sp = cycles.create({ name: 'Sprint One' });
  const name = M.sprintBranchName(sp);

  const a = agents.createCard({ title: 'first', prompt: 'ファイルを作って' });
  cycles.setCard({ id: a.id, cycleIds: [sp.id] });
  agents.start(a.id);
  await waitFor(() => a.status === 'review');
  assert.strictEqual(a.baseBranch, name);
  assert.strictEqual(a.sprintId, sp.id);
  assert.strictEqual(store.cycle(sp.id).branch, name);
  assert.strictEqual(store.cycle(sp.id).branchBase, 'main');
  assert.ok(a.logs.some((l) => l.kind === 'system' && l.text.includes(name)));

  const mainBefore = g('rev-parse', 'main');
  await agents.merge(a.id);
  assert.deepStrictEqual(a.mergedInto, [name]);
  assert.strictEqual(g('rev-parse', 'main'), mainBefore, 'main には入らない');
  assert.strictEqual(g('rev-list', '--count', `main..${name}`), '2', 'タスクのコミットとマージのコミット');

  // 2つ目のタスクは、もうあるスプリントのブランチ（1つ目をマージしたもの）から始める
  const b = agents.createCard({ title: 'second', prompt: '2つ目' });
  cycles.setCard({ id: b.id, cycleIds: [sp.id] });
  agents.start(b.id);
  await waitFor(() => b.status === 'review');
  assert.strictEqual(b.baseBranch, name);
  assert.strictEqual(b.baseCommit, g('rev-parse', name));

  // スプリントに入っていないタスクは、いつものベース
  const c = agents.createCard({ title: 'loose', prompt: '3つ目' });
  agents.start(c.id);
  await waitFor(() => c.status === 'review');
  assert.strictEqual(c.baseBranch, 'main');
  assert.ok(fs.existsSync(repo));
});

test('複数のスプリントに入っていて選んでいなければベースから始め、選んでいればそのスプリントのブランチ', async () => {
  const { store, agents, cycles } = setup();
  const a = cycles.create({ name: 'A' });
  const b = cycles.create({ name: 'B' });
  const c1 = agents.createCard({ title: 'amb', prompt: 'p' });
  cycles.setCard({ id: c1.id, cycleIds: [a.id, b.id] });
  agents.start(c1.id);
  await waitFor(() => c1.status === 'review');
  assert.strictEqual(c1.baseBranch, 'main');
  assert.ok(c1.logs.some((l) => /複数のスプリント/.test(l.text)));
  assert.strictEqual(store.cycle(a.id).branch, undefined);

  const c2 = agents.createCard({ title: 'chosen', prompt: 'p' });
  cycles.setCard({ id: c2.id, cycleIds: [a.id, b.id], branchCycleId: b.id });
  agents.start(c2.id);
  await waitFor(() => c2.status === 'review');
  assert.strictEqual(c2.baseBranch, M.sprintBranchName(store.cycle(b.id)));
});

test('設定がオフなら、スプリントに入っていてもいつものベース', async () => {
  const { store, agents, cycles } = setup({ sprintBranch: false });
  const sp = cycles.create({ name: 'S' });
  const c = agents.createCard({ title: 't', prompt: 'p' });
  cycles.setCard({ id: c.id, cycleIds: [sp.id] });
  agents.start(c.id);
  await waitFor(() => c.status === 'review');
  assert.strictEqual(c.baseBranch, 'main');
  assert.strictEqual(store.cycle(sp.id).branch, undefined);
});

test('スプリントのブランチをベースへマージ・PR を作る', async () => {
  const { tmp, store, agents, cycles, g } = setup();
  const sp = cycles.create({ name: 'Ship' });
  await assert.rejects(agents.mergeSprintBranch(sp.id), /まだありません/);

  const a = agents.createCard({ title: 'feature', prompt: 'ファイルを作って' });
  cycles.setCard({ id: a.id, cycleIds: [sp.id] });
  agents.start(a.id);
  await waitFor(() => a.status === 'review');
  await agents.merge(a.id);
  const name = store.cycle(sp.id).branch;

  // PR: origin に push して gh pr create（本文にマージしたタスク）
  const remote = path.join(tmp, 'remote.git');
  execFileSync('git', ['init', '-q', '--bare', remote]);
  g('remote', 'add', 'origin', remote);
  g('push', '-q', 'origin', 'main');
  const ghLog = path.join(tmp, 'gh.log');
  const ghBin = path.join(tmp, 'gh');
  fs.writeFileSync(ghBin, `#!/bin/sh\necho "$@" >> "${ghLog}"\nif [ "$1 $2" = "pr create" ]; then echo 'https://github.com/o/r/pull/3'; exit 0; fi\nexit 1\n`, { mode: 0o755 });
  agents.opts.ghPath = ghBin;
  const pr = await agents.sprintPullRequest(sp.id);
  assert.strictEqual(pr.url, 'https://github.com/o/r/pull/3');
  assert.strictEqual(store.cycle(sp.id).prUrl, pr.url);
  assert.strictEqual(execFileSync('git', ['rev-parse', `refs/heads/${name}`], { cwd: remote }).toString().trim(), g('rev-parse', name));
  const log = fs.readFileSync(ghLog, 'utf8');
  assert.match(log, new RegExp(`pr create --head ${name} --base main --title Sprint: Ship`));
  assert.match(log, /- feature/);

  // マージ: main（チェックアウト中のリポジトリ）に取り込み、origin にも push
  const r = await agents.mergeSprintBranch(sp.id, { push: true });
  assert.deepStrictEqual(r, { target: 'main', merged: true, pushed: true });
  assert.strictEqual(g('rev-list', '--count', `main..${name}`), '0');
  assert.strictEqual(execFileSync('git', ['rev-parse', 'refs/heads/main'], { cwd: remote }).toString().trim(), g('rev-parse', 'main'));
  assert.ok(store.cycle(sp.id).mergedAt > 0);
  // もう一度: 取り込み済みなので何もしない
  assert.strictEqual((await agents.mergeSprintBranch(sp.id)).merged, false);
});

test('タスクからスプリントのブランチへの PR: origin にスプリントのブランチがなければ先に push する', async () => {
  const { tmp, agents, cycles, g, store } = setup();
  const remote = path.join(tmp, 'remote.git');
  execFileSync('git', ['init', '-q', '--bare', remote]);
  g('remote', 'add', 'origin', remote);
  g('push', '-q', 'origin', 'main');
  const ghLog = path.join(tmp, 'gh.log');
  const ghBin = path.join(tmp, 'gh');
  fs.writeFileSync(ghBin, `#!/bin/sh\necho "$@" >> "${ghLog}"\nif [ "$1 $2" = "pr create" ]; then echo 'https://github.com/o/r/pull/4'; exit 0; fi\nexit 1\n`, { mode: 0o755 });
  agents.opts.ghPath = ghBin;
  const sp = cycles.create({ name: 'S' });
  const c = agents.createCard({ title: 't', prompt: 'p' });
  cycles.setCard({ id: c.id, cycleIds: [sp.id] });
  agents.start(c.id);
  await waitFor(() => c.status === 'review');
  const name = store.cycle(sp.id).branch;
  await agents.createPullRequest(c.id);
  assert.strictEqual(execFileSync('git', ['rev-parse', `refs/heads/${name}`], { cwd: remote }).toString().trim(), g('rev-parse', name));
  assert.match(fs.readFileSync(ghLog, 'utf8'), new RegExp(`--base ${name}`));
});
