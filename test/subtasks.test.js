// サブタスク: 親のブランチから分けて動かし、終わったものから親のブランチにマージして、最後に親が仕上げる
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { execFileSync } = require('child_process');
const { Store } = require('../src/store');
const { AgentManager } = require('../src/agent');
const Subtasks = require('../src/subtasks');

const FAKE_CLAUDE = path.join(__dirname, 'fake-claude.js');

function setup(extra = {}) {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'worktree-kanban-sub-'));
  const repo = path.join(tmp, 'repo');
  fs.mkdirSync(repo);
  const g = (...a) => execFileSync('git', a, { cwd: repo }).toString();
  g('init', '-q', '-b', 'main');
  fs.writeFileSync(path.join(repo, 'README.md'), 'hello\n');
  g('add', '.');
  g('-c', 'user.name=t', '-c', 'user.email=t@t', 'commit', '-qm', 'init');
  const bin = path.join(tmp, 'claude');
  fs.writeFileSync(bin, `#!/bin/sh\nexec "${process.execPath}" "${FAKE_CLAUDE}" "$@"\n`, { mode: 0o755 });
  const store = new Store(path.join(tmp, 'data', 'board.json'));
  Object.assign(store.settings, { repoPath: repo, claudePath: bin, maxParallel: 3, permissionMode: 'bypassPermissions', specCheck: false, ...extra });
  const agents = new AgentManager(store, { mcpScript: path.join(__dirname, '..', 'src', 'permission-mcp.js'), mcpDir: path.join(tmp, 'data', 'mcp'), nodeBin: process.execPath });
  return { tmp, repo, store, agents, g };
}

function waitFor(pred, ms = 20000) {
  return new Promise((resolve, reject) => {
    const t0 = Date.now();
    const iv = setInterval(() => {
      let v;
      try {
        v = pred();
      } catch (err) {
        clearInterval(iv);
        return reject(err);
      }
      if (v) {
        clearInterval(iv);
        resolve(v);
      } else if (Date.now() - t0 > ms) {
        clearInterval(iv);
        reject(new Error('timeout'));
      }
    }, 20);
  });
}

test('subtasks: 一覧を整える（key の重なり・知らない after・循環）', () => {
  const items = Subtasks.cleanItems([
    { key: 'a', title: 'A', prompt: 'a', after: ['b', 'zz', 'a'] },
    { key: 'a', title: 'B', prompt: 'b', after: ['a'] },
    { title: '', prompt: '' },
  ]);
  assert.deepStrictEqual(items.map((x) => x.key), ['a', 'a-2']);
  assert.deepStrictEqual(items[0].after, []);
  assert.deepStrictEqual(items[1].after, ['a']);
  const cyc = Subtasks.cleanItems([
    { key: 'x', title: 'X', after: ['y'] },
    { key: 'y', title: 'Y', after: ['x'] },
  ]);
  assert.deepStrictEqual(cyc.map((x) => x.after), [[], ['x']]);
  const ex = Subtasks.extractSubtasks('[[SUBTASKS]]\n説明\n```subtasks\n[{"key":"k","title":"T","prompt":"p"}]\n```');
  assert.strictEqual(ex.marked, true);
  assert.strictEqual(ex.text, '説明');
  assert.strictEqual(ex.items[0].key, 'k');
  // 順番が返ってこなければ直列にする
  const plan = Subtasks.applyPlan([{ key: 'a', title: 'A', prompt: 'a', after: [], state: 'pending' }, { key: 'b', title: 'B', prompt: 'b', after: [], state: 'pending' }], null);
  assert.deepStrictEqual(plan.map((x) => x.after), [[], ['a']]);
  assert.strictEqual(plan[0].state, 'pending');
});

test('サブタスク: 手動で決めたサブタスクを、順番どおりに動かして親のブランチにマージし、親が仕上げる', async () => {
  const { agents, store, g } = setup();
  const [p] = agents.createTask({ title: '大きな作業 [serial]', prompt: '大きな作業をする [serial]', agent: 'claude' });
  agents.setSubtasks(p.id, { items: [{ title: '下準備', prompt: '下準備をする' }, { title: '本体', prompt: '本体を作る' }] });
  assert.strictEqual(p.subtasks.phase, 'plan');
  assert.strictEqual(p.subtasks.merge, 'auto');
  agents.start(p.id);
  // 順番が決まって、1つ目だけが動き出す（直列）
  await waitFor(() => p.subtasks.phase === 'run');
  assert.deepStrictEqual(p.subtasks.items.map((x) => x.after), [[], ['s1']]);
  await waitFor(() => p.subtasks.items[0].state !== 'pending');
  assert.strictEqual(p.subtasks.items[1].state, 'pending');
  const first = store.card(p.subtasks.items[0].cardId);
  assert.strictEqual(first.subtaskOf.parent, p.id);
  await waitFor(() => first.branch);
  assert.strictEqual(first.baseBranch, p.branch);
  // マージ・PR はサブタスクからはできない
  await waitFor(() => p.subtasks.items[0].state === 'merged');
  assert.ok(!store.card(first.id), 'マージしたサブタスクのカードは片付ける');
  await waitFor(() => p.subtasks.items[1].state === 'merged');
  // すべてマージしたら、親が仕上げてからレビューへ
  await waitFor(() => p.subtasks.phase === 'done' && p.status === 'review');
  const log = g('log', '--oneline', p.branch);
  assert.match(log, /Merge subtask: 下準備/);
  assert.match(log, /Merge subtask: 本体/);
  assert.ok((p.logs || []).some((l) => l.kind === 'user' && /このタスクのブランチにマージしました/.test(l.text)));
  // 仕上げが終わったので、親はマージできる
  const r = await agents.merge(p.id, { target: 'main' });
  assert.ok(r.merged);
});

test('サブタスク: 提案を受けて分け、同じファイルのコンフリクトは親が解消する', async () => {
  // 提案は、開発を始める前の相談（仕様の確認）の一部として頼む
  const { agents, store, g } = setup({ specCheck: true });
  const [p] = agents.createTask({ title: '分けたい作業', prompt: '画面と API を作る [split-me]', agent: 'claude' });
  agents.start(p.id);
  await waitFor(() => p.subtaskProposal && p.status === 'review');
  assert.strictEqual(p.awaitingReply, true);
  assert.strictEqual(p.subtaskProposal.items.length, 2);
  assert.strictEqual(p.specState, 'settled');
  assert.ok(!/\[\[SUBTASKS\]\]|```subtasks/.test(p.lastText), '印とブロックは画面に出さない');
  assert.ok(store.notifications.some((n) => n.cardId === p.id && /サブタスクの提案/.test(n.title)));
  await agents.acceptSubtasks(p.id, { merge: 'auto' });
  assert.strictEqual(p.subtaskProposal, null);
  // 並列に2つ動き、2つ目のマージで shared.txt がコンフリクトする → 親が解消して先へ進む
  await waitFor(() => p.subtasks.phase === 'done' && p.status === 'review', 30000);
  assert.deepStrictEqual(p.subtasks.items.map((x) => x.state), ['merged', 'merged']);
  assert.ok((p.logs || []).some((l) => /コンフリクトしました/.test(l.text)));
  assert.ok(!p.conflict);
  const shared = g('show', `${p.branch}:shared.txt`);
  assert.ok(!/<<<<<<<|>>>>>>>/.test(shared));
});

test('サブタスク: 「確かめてからマージ」では、取り込むまで親のブランチに入れない', async () => {
  const { agents, store } = setup();
  const [p] = agents.createTask({ title: '確かめる作業', prompt: '作業する', agent: 'claude' });
  agents.setSubtasks(p.id, { items: [{ title: 'ひとつ', prompt: 'ひとつ作る' }], merge: 'review' });
  agents.start(p.id);
  await waitFor(() => p.subtasks.items[0].cardId);
  const k = store.card(p.subtasks.items[0].cardId);
  await waitFor(() => k.status === 'review');
  await new Promise((r) => setTimeout(r, 200));
  assert.strictEqual(p.subtasks.items[0].state, 'running');
  await assert.rejects(() => agents.merge(k.id, { target: 'main' }), /親のタスク/);
  await assert.rejects(() => agents.merge(p.id, { target: 'main' }), /サブタスク/);
  assert.ok(store.notifications.some((n) => n.cardId === k.id && /サブタスクの確認/.test(n.title)));
  await agents.approveSubtask(k.id);
  await waitFor(() => p.subtasks.phase === 'done' && p.status === 'review');
});

test('サブタスク: Issue のサブIssue をサブタスクにする / 提案を受けるときにサブIssue を作る', async () => {
  const { agents } = setup();
  agents.fetchIssue = async (_r, n) => ({ number: n, title: `Issue ${n}`, body: `本文 ${n}`, url: `https://github.com/o/r/issues/${n}`, state: 'open', labels: [], comments: [] });
  agents.fetchSubIssues = async (_r, n) => (n === 10 ? [{ number: 11, title: 'Issue 11', state: 'open', url: 'u11' }, { number: 12, title: 'Issue 12', state: 'closed', url: 'u12' }] : []);
  const { cards } = await agents.createFromIssues({ numbers: '10, 20', agent: 'claude' });
  const [a, b] = cards;
  assert.deepStrictEqual(a.subtasks.items.map((x) => x.issue.number), [11]);
  assert.strictEqual(a.subtasks.phase, 'plan');
  assert.ok(!b.subtasks);
  // サブIssue の PR 本文には Closes が入る（マージしたもの）
  a.subtasks.items[0].state = 'merged';
  assert.match(agents.prDefaults(a).body, /Closes #10[\s\S]*Closes #11/);
  // 提案を受けるときに、サブIssue を作る
  const made = [];
  agents.createSubIssue = async (_r, parent, { title }) => {
    made.push([parent, title]);
    return { number: 100 + made.length, title, url: `u${100 + made.length}` };
  };
  b.status = 'review';
  b.worktreePath = '/nonexistent';
  b.subtaskProposal = { items: Subtasks.cleanItems([{ key: 'x', title: 'X', prompt: 'x' }]), at: Date.now() };
  agents.advanceSubtasks = async () => {};
  await agents.acceptSubtasks(b.id, { createIssues: true });
  assert.deepStrictEqual(made, [[20, 'X']]);
  assert.strictEqual(b.subtasks.items[0].issue.number, 101);
});

test('サブタスク: 提案に「分けずに進める」と答えると、このタスクのまま進める', async () => {
  const { agents } = setup({ specCheck: true });
  const [p] = agents.createTask({ title: '分けない作業', prompt: '作る [split-me]', agent: 'claude' });
  agents.start(p.id);
  await waitFor(() => p.subtaskProposal && p.status === 'review');
  agents.declineSubtasks(p.id);
  assert.strictEqual(p.subtaskProposal, null);
  await waitFor(() => p.status === 'review' && !p.awaitingReply);
  assert.ok(!p.subtasks);
  assert.ok((p.logs || []).some((l) => l.kind === 'user' && /サブタスクに分けずに/.test(l.text)));
  // Pipeline・競争・サブタスク自身は分けない
  assert.throws(() => agents.setSubtasks(p.id, { items: [{ title: 'x' }] }), /開始前/);
});

test('サブタスク: サブタスクだけ開始すると、親は動かさずにそのサブタスクだけ動き、レビューで止まる。状態はドラッグで変える', async () => {
  const { agents, store, g } = setup();
  const [p] = agents.createTask({ title: '手で進める作業', prompt: '全体の作業 [manual]', agent: 'claude' });
  agents.setSubtasks(p.id, { items: [{ title: 'ひとつめ', prompt: 'ひとつめを作る' }, { title: 'ふたつめ', prompt: 'ふたつめを作る' }, { title: 'みっつめ', prompt: 'みっつめを作る' }] });
  // 開始前の親では、開始以外の移動はできない
  await assert.rejects(() => agents.moveSubtask(p.id, 's1', 'done'), /開始する前/);
  await agents.startSubtaskOnly(p.id, 's2');
  assert.ok(p.worktreePath && p.branch, '親のブランチだけ作る');
  assert.strictEqual(p.status, 'review');
  assert.strictEqual(p.subtasks.phase, 'run');
  assert.strictEqual(p.subtasks.auto, false);
  const item = p.subtasks.items[1];
  assert.strictEqual(item.state, 'running');
  assert.ok(item.manual);
  const k = store.card(item.cardId);
  await waitFor(() => k.status === 'review');
  await new Promise((r) => setTimeout(r, 200));
  // ほかのサブタスクは始めない・自動でマージしない・親のエージェントは動かない
  assert.deepStrictEqual(p.subtasks.items.map((x) => x.state), ['pending', 'running', 'pending']);
  assert.ok(!p.sessionId);
  assert.ok(!/Merge subtask/.test(g('log', '--oneline', p.branch)));
  // 取り込むと親のブランチにマージするが、状態はレビューのまま（完了へはドラッグで動かす）
  await agents.approveSubtask(k.id);
  await waitFor(() => item.state === 'review');
  assert.ok(item.merged);
  assert.ok(!store.card(k.id));
  assert.match(g('log', '--oneline', p.branch), /Merge subtask: ふたつめ/);
  await agents.moveSubtask(p.id, 's2', 'done');
  assert.strictEqual(item.state, 'merged');
  // 完了から戻せる・戻したものはもう一度完了にできる
  await agents.moveSubtask(p.id, 's2', 'review');
  assert.strictEqual(item.state, 'review');
  await agents.moveSubtask(p.id, 's2', 'done');
  // 親は、サブタスクが残っているあいだは完了にできない
  assert.throws(() => agents.moveCard(p.id, 'done'), /サブタスクが残っています/);
  // 3つめは取り込まずに完了にする（カードは片付ける）
  await agents.startSubtaskOnly(p.id, 's3');
  const k3 = store.card(p.subtasks.items[2].cardId);
  await waitFor(() => k3.status === 'review');
  await agents.moveSubtask(p.id, 's3', 'done');
  assert.strictEqual(p.subtasks.items[2].state, 'done');
  assert.ok(!store.card(k3.id));
  // 1つめは始めずに完了にする → すべて完了したので、親が（全体の指示つきで）仕上げてからレビューへ
  await agents.moveSubtask(p.id, 's1', 'done');
  assert.strictEqual(p.subtasks.phase, 'done');
  await waitFor(() => p.status === 'review' && p.sessionId);
  const fin = (p.logs || []).find((l) => l.kind === 'user' && /このタスクのブランチにマージしました/.test(l.text));
  assert.ok(fin && /全体の作業 \[manual\]/.test(fin.text));
});

test('サブタスク: 自動で進めているときも、まだのサブタスクだけ先に開始できる', async () => {
  const { agents, store } = setup();
  const [p] = agents.createTask({ title: '大きな作業 [serial]', prompt: '大きな作業をする [serial]', agent: 'claude' });
  agents.setSubtasks(p.id, { items: [{ title: '下準備', prompt: '下準備をする' }, { title: '本体', prompt: '本体を作る' }], merge: 'review' });
  agents.start(p.id);
  await waitFor(() => p.subtasks.phase === 'run' && p.status === 'review' && p.subtasks.items[0].cardId);
  assert.strictEqual(p.subtasks.items[1].state, 'pending');
  // 順番（after）は目安: 先のものが終わっていなくても開始できる
  await agents.startSubtaskOnly(p.id, 's2');
  assert.strictEqual(p.subtasks.items[1].state, 'running');
  const k2 = store.card(p.subtasks.items[1].cardId);
  await waitFor(() => k2.status === 'review');
  await agents.approveSubtask(k2.id);
  await waitFor(() => p.subtasks.items[1].state === 'review');
  const k1 = store.card(p.subtasks.items[0].cardId);
  await waitFor(() => k1.status === 'review');
  await agents.approveSubtask(k1.id);
  // 自動で始めたものは、取り込んだら完了になる
  // （先に取り込んだ s2 とコンフリクトしたときは、親のエージェントが解消し終えてレビューに戻るまで待つ）
  await waitFor(() => p.subtasks.items[0].state === 'merged' && p.status === 'review');
  assert.strictEqual(p.subtasks.phase, 'run', '個別に開始したものが完了になるまでは、仕上げない');
  await agents.moveSubtask(p.id, 's2', 'done');
  await waitFor(() => p.subtasks.phase === 'done' && p.status === 'review');
});

test('ボード: レビューと完了のあいだをドラッグで動かす（マージせずに完了にする・戻す）', async () => {
  const { agents, store } = setup();
  const [c] = agents.createTask({ title: 'ふつうの作業', prompt: '作業する', agent: 'claude' });
  assert.throws(() => agents.moveCard(c.id, 'done'), /開始していない/);
  agents.moveCard(c.id, 'running');
  await waitFor(() => c.status === 'review');
  assert.throws(() => agents.moveCard(c.id, 'todo'), /Todo に戻せません/);
  agents.moveCard(c.id, 'done');
  assert.strictEqual(c.status, 'done');
  assert.ok(c.worktreePath && fs.existsSync(c.worktreePath), 'マージしていないので worktree は残す');
  assert.strictEqual(agents.issueStatusKey(c), 'done');
  assert.ok(store.notifications.some((n) => n.cardId === c.id && /完了/.test(n.title)));
  agents.moveCard(c.id, 'review');
  assert.strictEqual(c.status, 'review');
  // マージで片付けたものは、もう戻せない
  await agents.merge(c.id, { target: 'main' });
  assert.strictEqual(c.status, 'done');
  assert.throws(() => agents.moveCard(c.id, 'review'), /戻せません/);
});

test('ボード: 設定した列とレーンへ動かす（次に進んでよい列だけ。置いた場所は状態が変わるまで覚える）', async () => {
  const BC = require('../renderer/board-columns');
  const { agents } = setup();
  const cfg = BC.cleanConfig({
    columns: [
      { id: 'todo', name: 'Todo', description: 'まだ', stage: 'todo', next: ['run'] },
      { id: 'run', name: '実行中', description: '作業中', stage: 'running' },
      { id: 'rev', name: 'レビュー', description: '確かめる', stage: 'review', next: ['qa', 'done'] },
      { id: 'qa', name: 'QA', description: '手で確かめる', stage: 'review', next: ['rev'] },
      { id: 'done', name: '完了', description: '終わった', stage: 'done', next: [], lanes: [{ id: 'd', name: 'Done', description: 'マージ', when: { merged: true } }, { id: 'c', name: 'Close', description: '閉じた' }] },
    ],
  });
  agents.opts.boardColumnsOf = () => cfg;
  const [c] = agents.createTask({ title: '列の作業', prompt: '作業する', agent: 'claude' });
  await assert.rejects(agents.placeCard(c.id, 'rev'), /動かせません/);
  await agents.placeCard(c.id, 'run');
  await waitFor(() => c.status === 'review');
  assert.strictEqual(BC.placeOf(cfg, c).col, 'rev', '状態が変わったら条件で振り分け直す');
  await agents.placeCard(c.id, 'qa');
  assert.strictEqual(c.status, 'review', '同じ段階なら状態は変えない');
  assert.strictEqual(BC.placeOf(cfg, c).col, 'qa');
  await assert.rejects(agents.placeCard(c.id, 'done'), /動かせません/, 'QA から完了へは進めない設定');
  await agents.placeCard(c.id, 'rev');
  await agents.placeCard(c.id, 'done', 'c');
  assert.strictEqual(c.status, 'done');
  assert.deepStrictEqual(BC.placeOf(cfg, c), { col: 'done', lane: 'c', manual: true });
  await assert.rejects(agents.placeCard(c.id, 'nope'), /知らない列/);
});

test('完了にする: git のタスクも、マージや PR を作らずに完了にできる（差分がなければ worktree とブランチを片付ける）', async () => {
  const { agents, repo, g } = setup();
  // 差分がない: worktree とブランチを片付けて完了にする
  const [a] = agents.createTask({ title: '調べるだけ', prompt: '調べる', agent: 'claude' });
  agents.moveCard(a.id, 'running');
  await waitFor(() => a.status === 'review');
  const wtA = a.worktreePath;
  execFileSync('git', ['reset', '-q', '--hard', a.baseCommit], { cwd: wtA });
  execFileSync('git', ['clean', '-qfd'], { cwd: wtA });
  assert.deepStrictEqual(await agents.complete(a.id), { cleaned: true });
  assert.strictEqual(a.status, 'done');
  assert.strictEqual(a.manualDone, true);
  assert.strictEqual(a.worktreePath, null);
  assert.ok(!fs.existsSync(wtA), 'worktree を消す');
  assert.ok(!g('branch', '--list', a.branch).trim(), 'ブランチを消す');
  assert.strictEqual(g('rev-list', '--count', 'main').trim(), '1', 'マージはしない');
  assert.strictEqual(agents.issueStatusKey(a), 'done');
  assert.ok(a.logs.some((l) => /変更がなかったので/.test(l.text)));
  await assert.rejects(async () => agents.complete(a.id), /レビュー中のタスクだけ/);
  assert.throws(() => agents.moveCard(a.id, 'review'), /戻せません/);

  // 差分がある: マージはせずに、worktree とブランチを残して完了にする
  const [b] = agents.createTask({ title: 'ふつうの作業', prompt: '作業する', agent: 'claude' });
  agents.moveCard(b.id, 'running');
  await waitFor(() => b.status === 'review');
  fs.writeFileSync(path.join(b.worktreePath, 'new.txt'), 'x\n');
  assert.deepStrictEqual(await agents.complete(b.id), { cleaned: false });
  assert.strictEqual(b.status, 'done');
  assert.ok(b.worktreePath && fs.existsSync(b.worktreePath), 'マージしていないので worktree は残す');
  assert.ok(g('branch', '--list', b.branch).trim());
  assert.strictEqual(g('rev-list', '--count', 'main').trim(), '1');
  agents.moveCard(b.id, 'review');
  assert.strictEqual(b.status, 'review');

  // コンフリクトの途中は完了にできない
  b.conflict = { target: 'main', files: ['x'] };
  await assert.rejects(async () => agents.complete(b.id), /コンフリクト/);
  assert.ok(fs.existsSync(repo));
});

test('サブタスク: まだ始めていないサブタスクは、名前とやることを変えられ、開始するとその内容で動く', async () => {
  const { agents } = setup();
  const [p] = agents.createTask({ title: '直す作業', prompt: '全体の作業 [manual]', agent: 'claude' });
  agents.setSubtasks(p.id, { items: [{ title: 'ひとつめ', prompt: 'ひとつめを作る' }, { title: 'ふたつめ', prompt: 'ふたつめを作る' }] });
  assert.throws(() => agents.editSubtask(p.id, 's1', { title: ' ', prompt: 'x' }), /名前/);
  assert.throws(() => agents.editSubtask(p.id, 's1', { title: 'x', prompt: '' }), /やること/);
  assert.throws(() => agents.editSubtask(p.id, 'nope', { title: 'x', prompt: 'y' }), /見つかりません/);
  const item = agents.editSubtask(p.id, 's1', { title: '  新しい名前 ', prompt: '新しいやること\n2行目' });
  assert.strictEqual(item.title, '新しい名前');
  assert.strictEqual(p.subtasks.items[0].prompt, '新しいやること\n2行目');
  assert.ok((p.logs || []).some((l) => l.kind === 'user' && /「ひとつめ」を「新しい名前」に変えました/.test(l.text)));
  await agents.startSubtaskOnly(p.id, 's1');
  const k = agents.store.card(p.subtasks.items[0].cardId);
  assert.ok(k.title.endsWith('新しい名前'));
  assert.match(k.prompt, /新しいやること/);
  // 始めたサブタスクは変えられない
  assert.throws(() => agents.editSubtask(p.id, 's1', { title: 'x', prompt: 'y' }), /まだ始めていない/);
  await waitFor(() => k.status === 'review' || k.status === 'failed');
});
