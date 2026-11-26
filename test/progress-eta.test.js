// 「あとどれくらいでレビュー待ちか」（renderer/progress-eta.js）: 進み具合の % と残りの時間の見込み
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');
const E = require('../renderer/progress-eta');
const { withProgressNote, PROGRESS_NOTE } = require('../src/agent');

const MIN = 60 * 1000;

test('返事から [[PROGRESS:数字]] を取り出して、本文から消す（最後の値を使い、0〜100 に収める）', () => {
  assert.deepStrictEqual(E.extractProgress('調べました\n[[PROGRESS:30]]\n次は直します'), { text: '調べました\n次は直します', pct: 30 });
  assert.deepStrictEqual(E.extractProgress('[[PROGRESS: 20%]]\n[[PROGRESS:150]]'), { text: '', pct: 100 });
  assert.strictEqual(E.extractProgress('途中です（[[PROGRESS:45]]）').pct, 45);
  // ルールの説明の例（バッククォートで囲んだもの）は報告として数えない
  assert.strictEqual(E.extractProgress('例: `[[PROGRESS:40]]` と書く').pct, null);
  assert.deepStrictEqual(E.extractProgress('印はありません'), { text: '印はありません', pct: null });
  assert.deepStrictEqual(E.extractProgress(null), { text: '', pct: null });
});

test('TODO があれば完了数（作業中は半分）、なければエージェントの報告を進み具合にする', () => {
  const todos = { items: [{ status: 'completed' }, { status: 'in_progress' }, { status: 'pending' }, { status: 'cancelled' }], at: 2 };
  assert.deepStrictEqual(E.cardPct({ todos, startedAt: 1 }), { pct: 50, source: 'todo' });
  assert.deepStrictEqual(E.cardPct({ progressReport: { pct: 70 } }), { pct: 70, source: 'report' });
  // TODO があるときは TODO を優先する
  assert.strictEqual(E.cardPct({ todos, progressReport: { pct: 90 }, startedAt: 1 }).source, 'todo');
  // 前の実行で終わった TODO が残っていて、今回の報告があれば報告を使う
  const old = { items: [{ status: 'completed' }], at: 1 };
  assert.deepStrictEqual(E.cardPct({ todos: old, progressReport: { pct: 10 }, startedAt: 5 }), { pct: 10, source: 'report' });
  assert.strictEqual(E.cardPct({}), null);
});

test('残りの時間は、かかった時間と進み具合から割り出す（始めたばかり・ほとんど進んでいないときは出さない）', () => {
  assert.strictEqual(E.remainingMs(50, 10 * MIN), 10 * MIN);
  assert.strictEqual(E.remainingMs(25, 10 * MIN), 30 * MIN);
  assert.strictEqual(E.remainingMs(100, 10 * MIN), 0);
  assert.strictEqual(E.remainingMs(2, 10 * MIN), null);
  assert.strictEqual(E.remainingMs(50, 10 * 1000), null);
});

test('作業中のタスク: 全体の % と残りの時間。作業中でなければ出さない', () => {
  const now = 100 * MIN;
  const c = { status: 'running', startedAt: now - 10 * MIN, progressReport: { pct: 40 } };
  const e = E.estimate(c, () => null, now);
  assert.strictEqual(e.overall.pct, 40);
  assert.strictEqual(e.overall.source, 'report');
  assert.strictEqual(e.overall.remainingMs, 15 * MIN);
  assert.strictEqual(e.current, null);
  assert.strictEqual(E.estimate({ ...c, status: 'review' }, () => null, now), null);
  assert.strictEqual(E.estimate({ status: 'running', startedAt: now }, () => null, now), null);
});

test('サブタスクの親: 終わったサブタスクと、動いているサブタスクの進み具合を合わせる（破棄は数えない）', () => {
  const now = 100 * MIN;
  const kids = {
    a: { id: 'a', status: 'done', createdAt: now - 20 * MIN },
    b: { id: 'b', status: 'running', createdAt: now - 10 * MIN, startedAt: now - 10 * MIN, progressReport: { pct: 50 } },
  };
  const parent = {
    status: 'review',
    subtasks: {
      phase: 'run',
      items: [
        { key: 'a', state: 'merged', cardId: 'a' },
        { key: 'b', state: 'running', cardId: 'b' },
        { key: 'c', state: 'pending' },
        { key: 'd', state: 'skipped' },
      ],
    },
  };
  const e = E.estimate(parent, (id) => kids[id], now);
  assert.strictEqual(e.overall.source, 'subtasks');
  assert.strictEqual(e.overall.pct, 50); // (1 + 0.5 + 0) / 3
  assert.strictEqual(e.overall.remainingMs, 20 * MIN); // 20分で50%
  assert.strictEqual(e.current, null); // 親のエージェントは動いていない
});

test('Pipeline: 通った工程の数と今の工程の進み具合を合わせ、今のエージェントの分も返す', () => {
  const now = 100 * MIN;
  const c = {
    status: 'running',
    startedAt: now - 5 * MIN,
    todos: { items: [{ status: 'completed' }, { status: 'pending' }], at: now },
    relay: {
      steps: [{ id: 's1' }, { id: 's2' }],
      index: 1,
      history: [{ index: 0, startedAt: now - 15 * MIN }],
      stepStartedAt: now - 5 * MIN,
    },
  };
  const e = E.estimate(c, () => null, now);
  assert.strictEqual(e.overall.source, 'relay');
  assert.strictEqual(e.overall.pct, 75); // (1 + 0.5) / 2
  assert.strictEqual(e.overall.remainingMs, 5 * MIN); // 15分で75%
  assert.strictEqual(e.current.pct, 50);
  assert.strictEqual(e.current.source, 'todo');
});

test('エージェントへの指示に進み具合の報告のルールを足し、画面にはスクリプトと4言語の言葉がある', () => {
  assert.ok(withProgressNote('作って').startsWith('作って\n'));
  assert.ok(withProgressNote('作って').endsWith(PROGRESS_NOTE));
  assert.match(PROGRESS_NOTE, /\[\[PROGRESS:数字\]\]/);
  const html = fs.readFileSync(path.join(__dirname, '../renderer/index.html'), 'utf8');
  assert.ok(html.indexOf('progress-eta.js') > 0 && html.indexOf('progress-eta.js') < html.indexOf('renderer.js'));
  const pkg = require('../package.json');
  assert.ok(pkg.build.files.includes('renderer/**'));
});
