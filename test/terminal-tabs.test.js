const test = require('node:test');
const assert = require('node:assert');
const { orderTabs, moveTab } = require('../renderer/terminal-view');

const t = (...ids) => ids.map((id) => ({ id }));
const ids = (list) => list.map((x) => x.id);

test('下部のターミナルのタブは、並べ替えた順に並び、新しく開いたものは後ろに付く', () => {
  assert.deepStrictEqual(ids(orderTabs(t('a', 'b', 'c'), ['c', 'a', 'b'])), ['c', 'a', 'b']);
  assert.deepStrictEqual(ids(orderTabs(t('a', 'b', 'c', 'd'), ['c', 'a'])), ['c', 'a', 'b', 'd']);
  // 閉じたもの（一覧に無いもの）は並びから消える
  assert.deepStrictEqual(ids(orderTabs(t('b'), ['a', 'b'])), ['b']);
  assert.deepStrictEqual(ids(orderTabs(t('a', 'b'), null)), ['a', 'b']);
});

test('タブを別のタブの前・後ろへ動かせる', () => {
  assert.deepStrictEqual(moveTab(['a', 'b', 'c'], 'c', 'a', false), ['c', 'a', 'b']);
  assert.deepStrictEqual(moveTab(['a', 'b', 'c'], 'a', 'c', true), ['b', 'c', 'a']);
  assert.deepStrictEqual(moveTab(['a', 'b', 'c'], 'a', 'b', true), ['b', 'a', 'c']);
  assert.deepStrictEqual(moveTab(['a', 'b', 'c'], 'b', 'b', false), ['a', 'b', 'c']);
  assert.deepStrictEqual(moveTab(['a', 'b'], 'x', 'a', false), ['a', 'b']);
});
