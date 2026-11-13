// ログタブをチャットの形に並べる renderer/chat-log.js を確かめる
const test = require('node:test');
const assert = require('node:assert');
const { build, push, final } = require('../renderer/chat-log');

const L = (kind, text, extra) => ({ t: 1, kind, text, ...(extra || {}) });

test('build: あなたの指示・返事・ツール・お知らせを、それぞれの項目に分ける', () => {
  const items = build(
    [L('system', 'worktree を作成しました'), L('user', '直して'), L('text', '見てみます'), L('tool', 'Read  a.js'), L('tool_result', '...'), L('text', '直しました'), L('result', '完了しました')],
    'claude',
  );
  assert.deepStrictEqual(
    items.map((it) => it.type),
    ['notice', 'user', 'assistant', 'tool', 'assistant', 'notice'],
  );
  // ツールの結果は呼び出しの項目にまとめる
  assert.strictEqual(items[3].entry.text, 'Read  a.js');
  assert.strictEqual(items[3].result.text, '...');
  // 名前とアイコンは返事のまとまりの最初だけ
  assert.strictEqual(items[2].head, true);
  assert.strictEqual(items[3].head, false);
  assert.strictEqual(items[4].head, false);
  assert.strictEqual(items[2].agent, 'claude');
});

test('build: まとまりがツールから始まったら、ツールの項目に名前を出す', () => {
  const items = build([L('user', 'x'), L('tool', 'Bash  ls'), L('tool_error', 'no'), L('text', 'だめでした')], 'codex');
  assert.strictEqual(items[1].head, true);
  assert.strictEqual(items[1].result.kind, 'tool_error');
  assert.strictEqual(items[2].head, false);
});

test('build: Pipeline でエージェントが替わったら、もう一度名前を出す', () => {
  const items = build([L('text', 'a', { agent: 'claude' }), L('text', 'b', { agent: 'claude' }), L('text', 'c', { agent: 'codex' })], 'claude');
  assert.deepStrictEqual(items.map((it) => it.head), [true, false, true]);
  assert.strictEqual(items[2].agent, 'codex');
});

test('build: 呼び出しのない結果や、2つめの結果は別の項目にする', () => {
  const items = build([L('tool_result', 'r1'), L('tool', 'Read  a'), L('tool_result', 'r2'), L('tool_result', 'r3')]);
  assert.strictEqual(items.length, 3);
  assert.strictEqual(items[0].entry, null);
  assert.strictEqual(items[0].result.text, 'r1');
  assert.strictEqual(items[1].result.text, 'r2');
  assert.strictEqual(items[2].result.text, 'r3');
});

test('push: 結果が届いたら、直前のツールの項目を描き直す（それ以外は末尾に足す）', () => {
  const items = [];
  assert.strictEqual(push(items, L('tool', 'Read  a')).op, 'append');
  const r = push(items, L('tool_result', 'ok'));
  assert.strictEqual(r.op, 'replace');
  assert.strictEqual(r.item, items[0]);
  assert.strictEqual(push(items, L('text', 'done')).op, 'append');
  assert.strictEqual(items.length, 2);
});

test('build: agent の無い返事は Claude とみなす（Claude → Codex の Pipeline で、Claude の返事を Codex と出さない）', () => {
  const items = build([L('user', 'x'), L('text', 'claude の返事'), L('system', '引き継ぎ'), L('text', 'codex の返事', { agent: 'codex' })], 'codex');
  assert.strictEqual(items[1].agent, 'claude');
  assert.strictEqual(items[3].agent, 'codex');
});

test('build: ツールの agent が替わったら、ツールの項目に名前を出し直す', () => {
  const items = build([L('text', 'a', { agent: 'claude' }), L('tool', 'Bash  ls', { agent: 'codex' }), L('tool_result', 'ok'), L('text', 'b', { agent: 'codex' })], 'codex');
  assert.deepStrictEqual(items.map((it) => it.head), [true, true, false]);
  assert.strictEqual(items[1].agent, 'codex');
});

test('build: agent の無い古いツールは、まとまりのエージェントを使う（名前は出し直さない）', () => {
  const items = build([L('text', 'a', { agent: 'gemini' }), L('tool', 'Read  a')], 'claude');
  assert.strictEqual(items[1].agent, 'gemini');
  assert.strictEqual(items[1].head, false);
});

test('final: チャットタブには、指示と途中も含めた返事を出す（ツールやお知らせは出さない）', () => {
  const items = final(
    [L('system', 'worktree を作成しました'), L('user', '直して'), L('text', '見てみます'), L('tool', 'Read  a.js'), L('tool_result', '...'), L('text', '直しました'), L('result', '完了しました'), L('user', '次も'), L('text', 'やりました')],
    'claude',
    false,
  );
  assert.deepStrictEqual(items.map((it) => [it.type, it.entry.text]), [['user', '直して'], ['assistant', '見てみます'], ['assistant', '直しました'], ['user', '次も'], ['assistant', 'やりました']]);
  assert.strictEqual(items[1].agent, 'claude');
  // 名前は返事のまとまりの最初だけ
  assert.deepStrictEqual(items.map((it) => !!it.head), [false, true, false, false, true]);
});

test('final: 途中の質問と回答は、その前の返事と一緒にチャットに出す', () => {
  const items = final(
    [L('user', '作って'), L('text', 'どちらにしますか'), L('tool', 'AskUserQuestion  x'), L('question', '質問: A か B か'), L('user', 'A か B か → A', { answer: true }), L('text', 'A で作りました', { agent: 'codex' }), L('result', '完了')],
    'claude',
    false,
  );
  assert.deepStrictEqual(items.map((it) => it.type), ['user', 'assistant', 'notice', 'user', 'assistant']);
  assert.strictEqual(items[2].entry.kind, 'question');
  assert.strictEqual(items[4].agent, 'codex');
});

test('final: 実行中も、届いた途中の返事をすぐに出す', () => {
  const logs = [L('user', 'x'), L('text', 'わかりました。まず台本から作ります'), L('tool', 'Write  a.md')];
  assert.deepStrictEqual(final(logs, 'claude', true).map((it) => [it.type, it.entry.text]), [['user', 'x'], ['assistant', 'わかりました。まず台本から作ります']]);
  const err = final([...logs, L('error', 'エラーで終了しました')], 'claude', true);
  assert.deepStrictEqual(err.map((it) => it.type), ['user', 'assistant', 'notice']);
});

test('final: エージェントが替わったら、名前を出し直す', () => {
  const items = final([L('user', 'x'), L('text', 'a', { agent: 'codex' }), L('text', 'b', { agent: 'codex' }), L('text', 'c')], 'claude', false);
  assert.deepStrictEqual(items.map((it) => !!it.head), [false, true, false, true]);
});


test('final: ツールの結果の画像は、やり取りのまとまりの最後に「最後に撮った画像」として出す', () => {
  const a = { mediaType: 'image/png', data: 'AAAA' };
  const b = { mediaType: 'image/png', data: 'BBBB' };
  const c = { mediaType: 'image/png', data: 'CCCC' };
  const items = final(
    [
      L('user', '直して'),
      L('text', '確かめます'),
      L('tool', 'screenshot'),
      L('tool_result', '', { images: [a] }),
      L('tool', 'screenshot'),
      L('tool_result', '', { images: [b, { omitted: '大きすぎる' }] }),
      L('tool', 'Read  x'),
      L('tool_result', 'ok'),
      L('text', '直しました'),
      L('result', '完了'),
      L('user', '次も'),
      L('tool', 'screenshot'),
      L('tool_error', 'x', { images: [c] }),
    ],
    'codex',
  );
  assert.deepStrictEqual(items.map((it) => it.type), ['user', 'assistant', 'assistant', 'shots', 'user', 'shots']);
  assert.deepStrictEqual(items[3].images, [b], '最後に撮った画像だけ（消された画像は除く）');
  assert.deepStrictEqual(items[3].earlier, [a], 'それより前の画像は earlier に');
  assert.strictEqual(items[3].agent, 'claude');
  assert.deepStrictEqual(items[5].images, [c]);
  assert.deepStrictEqual(items[5].earlier, []);
  assert.strictEqual(items[5].agent, 'codex', '返事がなければカードのエージェント');
});

test('final: 画像のあとの返事は、名前を出し直す。画像の無いまとまりには出さない', () => {
  const items = final([L('user', 'x'), L('tool_result', '', { images: [{ omitted: '消しました' }] }), L('text', 'a'), L('question', 'どっち？'), L('user', 'A')], 'claude');
  assert.deepStrictEqual(items.map((it) => it.type), ['user', 'assistant', 'notice', 'user']);
});

test('final: スマホ用のチャットも、同じように最後に撮った画像を出す', () => {
  const Mobile = require('../mobile/assets/chat-model');
  const a = { mediaType: 'image/png', data: 'AAAA' };
  const logs = [L('user', 'x'), L('text', 'a'), L('tool_result', '', { images: [a] }), L('error', 'だめでした')];
  assert.deepStrictEqual(Mobile.final(logs, 'claude').map((it) => it.type), ['user', 'assistant', 'shots', 'notice']);
  assert.deepStrictEqual(final(logs, 'claude').map((it) => it.type), ['user', 'assistant', 'shots', 'notice']);
});
