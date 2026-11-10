// ボードの列とレーン: 設定の整え方・確かめ方、カードの振り分け、手で動かせる列、ファイルの読み書き、AI の変換
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const BC = require('../renderer/board-columns');
const ColumnsFile = require('../src/board-columns-file');
const { convertColumns, parseColumnsReply, buildColumnsPrompt } = require('../src/columns-ai');
const BM = require('../mobile/assets/board-model');

// 完了の列を Done / Close に分け、レビューの段階に QA の列を足した設定
function sample() {
  return BC.cleanConfig({
    columns: [
      { id: 'todo', name: 'Todo', description: 'まだ', stage: 'todo', next: ['running'], lanes: [{ id: 'main' }] },
      { id: 'running', name: '実行中', description: '作業中', stage: 'running', next: [], lanes: [{ id: 'main' }] },
      { id: 'qa', name: 'QA', description: 'CI 待ち', stage: 'review', when: { ci: ['pending'] }, next: ['review'], lanes: [{ id: 'main' }] },
      { id: 'review', name: 'レビュー', description: '確かめる', stage: 'review', next: ['done', 'qa'], lanes: [{ id: 'main' }] },
      {
        id: 'done',
        name: '完了',
        description: '終わった',
        stage: 'done',
        next: ['review'],
        lanes: [
          { id: 'close', name: 'Close', description: 'マージせずに閉じた', when: { merged: false } },
          { id: 'merged', name: 'Done', description: 'マージした', when: { merged: true } },
        ],
      },
    ],
  });
}

test('何も決めていないときは今までの4つの列で、そのまま保存できる形', () => {
  const cfg = BC.defaultConfig();
  assert.deepStrictEqual(cfg.columns.map((c) => c.id), ['todo', 'running', 'review', 'done']);
  assert.deepStrictEqual(cfg.columns.map((c) => c.stage), BC.STAGES);
  assert.deepStrictEqual(BC.validateConfig(BC.cleanConfig(cfg)), []);
});

test('cleanConfig: ID の重なり・知らない条件・ない列への next を直す', () => {
  const cfg = BC.cleanConfig({
    columns: [
      { id: 'a', name: '  A  ', description: 'x', stage: 'todo', next: ['b', 'a', 'zzz'], when: { merged: 'yes', pr: ['OPEN', 'bad'], nope: 1 } },
      { id: 'a', name: 'B', description: 'y', stage: 'nope', lanes: [{ id: 'l' }, { id: 'l' }] },
    ],
  });
  assert.strictEqual(cfg.columns[0].name, 'A');
  assert.notStrictEqual(cfg.columns[1].id, 'a');
  assert.deepStrictEqual(cfg.columns[0].next, []);
  assert.deepStrictEqual(cfg.columns[0].when, { pr: ['open'] });
  assert.strictEqual(cfg.columns[1].stage, '');
  assert.notStrictEqual(cfg.columns[1].lanes[0].id, cfg.columns[1].lanes[1].id);
});

test('validateConfig: 説明は必ず要る。レーンが2つ以上なら、レーンの名前と説明も要る。どの段階にも列が要る', () => {
  const cfg = BC.cleanConfig({ columns: [{ id: 'a', name: 'A', description: '', stage: 'todo', lanes: [{ id: 'x', name: 'X', description: 'd' }, { id: 'y' }] }] });
  const errors = BC.validateConfig(cfg);
  assert.ok(errors.some((e) => e.includes('説明')));
  assert.ok(errors.some((e) => e.includes('2番目のレーン')));
  assert.ok(errors.some((e) => e.includes('実行中')));
  // 変換の前は、段階がなくてもよい
  const before = BC.cleanConfig({ columns: [{ id: 'a', name: 'A', description: 'd' }] });
  assert.deepStrictEqual(BC.validateConfig(before, { needStage: false }), []);
  assert.ok(BC.validateConfig(before).length > 0);
});

test('placeOf: 段階が合う列のうち、条件が合う最初の列。列の中は条件が合う最初のレーン', () => {
  const cfg = sample();
  assert.deepStrictEqual(BC.placeOf(cfg, { status: 'todo' }), { col: 'todo', lane: 'main', manual: false });
  assert.strictEqual(BC.placeOf(cfg, { status: 'queued' }).col, 'running');
  // サブタスクを動かしている親は「実行中」
  assert.strictEqual(BC.placeOf(cfg, { status: 'review', subtasks: { phase: 'run', items: [{}] } }).col, 'running');
  assert.strictEqual(BC.placeOf(cfg, { status: 'review', prUrl: 'u', prState: 'OPEN', prChecks: { state: 'PENDING' } }).col, 'qa');
  assert.strictEqual(BC.placeOf(cfg, { status: 'review', prUrl: 'u', prState: 'OPEN', prChecks: { state: 'SUCCESS' } }).col, 'review');
  assert.strictEqual(BC.placeOf(cfg, { status: 'failed' }).col, 'review');
  assert.deepStrictEqual(BC.placeOf(cfg, { status: 'done', mergedInto: ['main'] }), { col: 'done', lane: 'merged', manual: false });
  assert.deepStrictEqual(BC.placeOf(cfg, { status: 'done', manualDone: true }), { col: 'done', lane: 'close', manual: false });
  // 条件に合う列がなければ、その段階の最初の列
  const noMatch = BC.cleanConfig({ columns: [{ id: 'r', name: 'R', description: 'd', stage: 'review', when: { failed: true } }] });
  assert.strictEqual(BC.placeOf(noMatch, { status: 'review' }).col, 'r');
  assert.strictEqual(BC.placeOf(noMatch, { status: 'todo' }), null);
});

test('手で置いた場所は、状態が変わるまで使う', () => {
  const cfg = sample();
  const c = { status: 'review', prUrl: 'u', prState: 'OPEN', prChecks: { state: 'SUCCESS' } };
  c.boardPlace = { col: 'qa', lane: null, sig: BC.signatureOf(c) };
  assert.deepStrictEqual(BC.placeOf(cfg, c), { col: 'qa', lane: 'main', manual: true });
  c.prChecks = { state: 'FAILURE' };
  assert.deepStrictEqual(BC.placeOf(cfg, c), { col: 'review', lane: 'main', manual: false });
  // 段階の合わない列は使わない
  const d = { status: 'done', mergedInto: ['main'] };
  d.boardPlace = { col: 'review', lane: null, sig: BC.signatureOf(d) };
  assert.strictEqual(BC.placeOf(cfg, d).col, 'done');
});

test('canPlace: 別の列へは「次に進んでよい列」だけ。段階をまたぐのは今までの決まりどおり。同じ列の中のレーンはいつでも', () => {
  const cfg = sample();
  const todo = { status: 'todo' };
  assert.strictEqual(BC.canPlace(cfg, todo, 'running'), true);
  assert.strictEqual(BC.canPlace(cfg, todo, 'review'), false);
  const rev = { status: 'review' };
  assert.strictEqual(BC.canPlace(cfg, rev, 'done'), true);
  assert.strictEqual(BC.canPlace(cfg, rev, 'done', 'merged'), true);
  assert.strictEqual(BC.canPlace(cfg, rev, 'done', 'nope'), false);
  assert.strictEqual(BC.canPlace(cfg, rev, 'qa'), true, '同じ段階の列へ');
  assert.strictEqual(BC.canPlace(cfg, rev, 'todo'), false);
  const done = { status: 'done', mergedInto: ['main'] };
  assert.strictEqual(BC.canPlace(cfg, done, 'done', 'close'), true, '同じ列の別のレーン');
  assert.strictEqual(BC.canPlace(cfg, done, 'done', 'merged'), false, '今いるレーン');
  assert.strictEqual(BC.canPlace(cfg, done, 'review'), true);
  assert.strictEqual(BC.canPlace(cfg, { status: 'running' }, 'done'), false);
  assert.strictEqual(BC.canPlace(cfg, { status: 'review', kind: 'chat' }, 'done'), false);
  // 次に進んでよい列に入れていなければ動かせない
  const strict = BC.cleanConfig({ ...cfg, columns: cfg.columns.map((c) => (c.id === 'review' ? { ...c, next: [] } : c)) });
  assert.strictEqual(BC.canPlace(strict, rev, 'done'), false);
});

test('describeWhen: 条件を人が読める文にする', () => {
  assert.match(BC.describeWhen({}), /条件なし/);
  assert.match(BC.describeWhen({ merged: true, pr: ['closed'] }), /マージ済み.*マージされずに閉じた/);
});

test('ファイル: 書いて読める。形が合わなければ書かない。読めなければ今までの4つの列', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'wk-cols-'));
  try {
    assert.strictEqual(ColumnsFile.readColumns(dir).exists, false);
    ColumnsFile.writeColumns(dir, sample());
    const file = path.join(dir, '.worktree-kanban', 'board.json');
    assert.ok(fs.existsSync(file));
    const r = ColumnsFile.readColumns(dir);
    assert.strictEqual(r.exists, true);
    assert.strictEqual(r.error, '');
    assert.deepStrictEqual(r.config.columns.map((c) => c.id), ['todo', 'running', 'qa', 'review', 'done']);
    assert.throws(() => ColumnsFile.writeColumns(dir, { columns: [{ id: 'a', name: 'A', description: '' }] }));
    fs.writeFileSync(file, '{ broken');
    const bad = ColumnsFile.readColumns(dir);
    assert.ok(bad.error);
    assert.deepStrictEqual(bad.config.columns.map((c) => c.id), ['todo', 'running', 'review', 'done']);
    // キャッシュは、ファイルが変わったら読み直す
    const cache = ColumnsFile.createColumnsCache();
    const first = cache.get(dir);
    assert.strictEqual(cache.get(dir), first);
    ColumnsFile.writeColumns(dir, sample());
    fs.utimesSync(file, new Date(), new Date(Date.now() + 5000));
    assert.notStrictEqual(cache.get(dir), first);
    ColumnsFile.removeColumns(dir);
    assert.strictEqual(ColumnsFile.readColumns(dir).exists, false);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('AI の変換: 返事を列に当てる。形が合わなければ1回だけ聞き直す', async () => {
  const draft = {
    columns: [
      { id: 'todo', name: 'Todo', description: 'まだ' },
      { id: 'run', name: '実行中', description: '作業中' },
      { id: 'rev', name: 'レビュー', description: '確かめる' },
      { id: 'done', name: '完了', description: '終わった', lanes: [{ id: 'd', name: 'Done', description: 'マージした' }, { id: 'c', name: 'Close', description: '閉じた' }] },
    ],
  };
  const prompts = [];
  const replies = [
    '{"columns": [{"id": "todo", "stage": "todo"}]}',
    '```json\n{"columns": [{"id":"todo","stage":"todo","next":["run"]},{"id":"run","stage":"running"},{"id":"rev","stage":"review","next":["done"]},{"id":"done","stage":"done","next":["rev"],"lanes":[{"id":"d","when":{"merged":true}},{"id":"c","when":{"merged":false}}]}]}\n```',
  ];
  const out = await convertColumns(async (p) => {
    prompts.push(p);
    return replies.shift();
  }, draft);
  assert.strictEqual(prompts.length, 2);
  assert.match(prompts[1], /前回の返事の直すところ/);
  assert.deepStrictEqual(out.columns.map((c) => c.stage), ['todo', 'running', 'review', 'done']);
  assert.deepStrictEqual(out.columns[3].lanes.map((l) => l.when), [{ merged: true }, { merged: false }]);
  assert.strictEqual(out.columns[3].lanes[0].name, 'Done', '名前と説明はユーザーが書いたまま');
  assert.deepStrictEqual(BC.validateConfig(out), []);
  // 説明がない列は、AI に聞かずに断る
  await assert.rejects(convertColumns(async () => '{}', { columns: [{ id: 'a', name: 'A', description: '' }] }));
  assert.strictEqual(parseColumnsReply('no json'), null);
  assert.match(buildColumnsPrompt(BC.cleanConfig(draft)), /マージした/);
});

test('スマホ: 設定した列とレーンで振り分ける。設定がなければ今までの4つの列', () => {
  const cards = [
    { id: 'a', status: 'done', mergedInto: ['main'], createdAt: 1 },
    { id: 'b', status: 'done', manualDone: true, createdAt: 2 },
    { id: 'c', status: 'review', prUrl: 'u', prState: 'OPEN', prChecks: { state: 'PENDING' }, createdAt: 3 },
  ];
  const m = BM.model(cards, sample());
  assert.deepStrictEqual(m.columns().map((c) => c.key), ['todo', 'running', 'qa', 'review', 'done']);
  assert.deepStrictEqual(m.columnCards('done').map((c) => c.id), ['b', 'a']);
  assert.strictEqual(m.laneOf(cards[0]), 'merged');
  assert.strictEqual(m.laneOf(cards[1]), 'close');
  assert.deepStrictEqual(m.columnCards('qa').map((c) => c.id), ['c']);
  const plain = BM.model(cards);
  assert.deepStrictEqual(plain.columns().map((c) => c.key), ['todo', 'running', 'review', 'done']);
  assert.deepStrictEqual(plain.columnCards('review').map((c) => c.id), ['c']);
});
