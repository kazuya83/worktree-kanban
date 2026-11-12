const test = require('node:test');
const assert = require('node:assert');
const { extractFixTask, FIX_TASK_NOTE } = require('../src/fix-task');
const { buildAfterDonePrompt } = require('../src/agent');

test('返事の最後の ```fix-task ブロックを取り出して、本文から消す', () => {
  const raw = '直すならこうします。\n\n```fix-task\n{"title": "ボタンの色を直す", "prompt": "保存ボタンの色を青にする"}\n```\n';
  const { text, proposal } = extractFixTask(raw);
  assert.strictEqual(text, '直すならこうします。');
  assert.deepStrictEqual(proposal, { title: 'ボタンの色を直す', prompt: '保存ボタンの色を青にする' });
});

test('ブロックがなければ本文はそのまま・案はなし', () => {
  const raw = 'ただの答えです。\n```js\nx()\n```';
  assert.deepStrictEqual(extractFixTask(raw), { text: raw, proposal: null });
});

test('読めない JSON や指示が空のブロックは、本文から消すが案にはしない', () => {
  assert.deepStrictEqual(extractFixTask('a\n```fix-task\n{oops\n```'), { text: 'a', proposal: null });
  assert.deepStrictEqual(extractFixTask('a\n```fix-task\n{"title":"t"}\n```'), { text: 'a', proposal: null });
});

test('完了したタスクについて話す指示に、修正タスクの案の書き方が入る', () => {
  const p = buildAfterDonePrompt({ id: 'x', title: 't', prompt: 'p', logs: [], status: 'done' }, 'これ直せる？');
  assert.ok(p.includes(FIX_TASK_NOTE));
});
