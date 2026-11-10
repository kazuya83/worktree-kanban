// 画面の使い勝手の改善（上部のバーの「その他」・状態で隠すタブ・カードのお知らせ・新しいタスクの「詳しい設定」）
const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');
const { hiddenDetailTabs } = require('../renderer/app-view.js');

const read = (rel) => fs.readFileSync(path.join(__dirname, '..', rel), 'utf8');
const html = read('renderer/index.html');
const src = read('renderer/renderer.js');
const fnSource = (name) => {
  const m = src.match(new RegExp(`^function ${name}\\(.*\\{\\n[\\s\\S]*?^\\}\\n`, 'm'));
  assert.ok(m, name);
  return m[0];
};

test('上部のバー: スマホとセッションは「その他」メニューに入れ、RC設定・ターミナル・会話は外に残す', () => {
  const menu = html.slice(html.indexOf('<div id="moreMenu"'), html.indexOf('</div>', html.indexOf('<div id="moreMenu"')));
  assert.match(menu, /id="mobileBtn" class="nav-item"/);
  assert.match(menu, /id="sessionsBtn" class="nav-item"/);
  for (const id of ['rcBtn', 'termBtn', 'chatBtn', 'newBtn', 'notifBtn']) {
    assert.match(html, new RegExp(`id="${id}"`), id);
    assert.doesNotMatch(menu, new RegExp(`id="${id}"`), `${id} はメニューに入れない`);
  }
  assert.match(html, /id="moreBtn"[^>]*aria-controls="moreMenu"/);
  assert.match(src, /AppView\.bindNavMenu\(\{ button: \$\('moreBtn'\), menu: \$\('moreMenu'\), doc: document, item: '\.nav-item'/);
});

test('タスク詳細のタブ: 開始前は worktree の中を見るタブと btw を隠す', () => {
  assert.deepStrictEqual(hiddenDetailTabs({ status: 'todo' }).sort(), ['browser', 'btw', 'diff', 'terminal', 'worktree']);
  // worktree があれば（止めて戻したタスクなど）見られる
  assert.deepStrictEqual(hiddenDetailTabs({ status: 'todo', worktreePath: '/w' }), ['btw']);
});

test('タスク詳細のタブ: btw は動いているあいだか、送ったものがあるときだけ', () => {
  assert.deepStrictEqual(hiddenDetailTabs({ status: 'running', worktreePath: '/w' }), []);
  assert.deepStrictEqual(hiddenDetailTabs({ status: 'queued' }), []);
  assert.deepStrictEqual(hiddenDetailTabs({ status: 'review', worktreePath: '/w' }), ['btw']);
  assert.deepStrictEqual(hiddenDetailTabs({ status: 'done', btw: [{ text: 'x' }] }), []);
});

test('タスク詳細のタブ: 会話・git で管理していないフォルダは、worktree・差分・ブラウザを隠す', () => {
  assert.deepStrictEqual(hiddenDetailTabs({ status: 'running' }, { noRepo: true }).sort(), ['browser', 'diff', 'worktree']);
  assert.deepStrictEqual(hiddenDetailTabs(null), []);
  const body = fnSource('updateTabsFor');
  assert.match(body, /AppView\.hiddenDetailTabs\(c, \{ noRepo: isChat\(c\) \|\| isNoGit\(c\) \}\)/);
  assert.match(body, /if \(hide\.includes\(state\.tab\)\) setTab\('chat'\);/, '見ていたタブを隠したらチャットに戻す');
});

test('カード: 自分の操作が要るものは同じ色（tone-act）、うまくいっていないものは tone-err', () => {
  const tone = Function(`${src.match(/^const BADGE_TONE = .*$/m)[0]}; return BADGE_TONE;`)();
  for (const k of ['question', 'waiting', 'spec', 'awaiting', 'interrupted']) assert.strictEqual(tone[k], 'act', k);
  for (const k of ['conflict', 'failed']) assert.strictEqual(tone[k], 'err', k);
  assert.strictEqual(tone.running, undefined);
  const card = fnSource('cardHtml');
  assert.match(card, /\$\{badgeHtml\(c\)\}/);
  assert.match(card, /needs-you/);
  assert.doesNotMatch(card, /'asking'/, '色ごとに分けていた古い見た目は使わない');
  const css = read('renderer/styles.css');
  assert.match(css, /\.badge\.tone-act \{[^}]*var\(--warn\)/);
  assert.match(css, /\.card\.needs-you \{[^}]*var\(--warn\)/);
  assert.doesNotMatch(css, /\.card\.asking/);
});

test('列の見出しに、自分の操作が要るタスクの数を出す（0 件なら出さない）', () => {
  assert.match(src, /<span>\$\{col\.label\}<\/span>\$\{colAttnHtml\(list\)\}<span class="count">/);
  assert.match(fnSource('colAttnHtml'), /return n \? /);
});

test('新しいタスク: 題名・エージェント・指示を先に出し、ほかは「詳しい設定」にたたむ', () => {
  const body = fnSource('newTask');
  const at = (t) => {
    const i = body.indexOf(t);
    assert.ok(i >= 0, t);
    return i;
  };
  const more = at('<details class="more-opts" id="nMore">');
  const end = at('</details>');
  for (const t of ['id="nTitle"', "agentFieldHtml('n'", 'id="nPrompt"']) assert.ok(at(t) < more, `${t} は外`);
  for (const t of ["modelFieldHtml('n'", "sessionFieldHtml('n')", "CycleView.fieldHtml('n'", 'id="nReadOnly"']) assert.ok(more < at(t) && at(t) < end, `${t} は中`);
  assert.ok(end < at('id="nStart"'), 'すぐに開始するかは外');
  assert.match(body, /bindMoreOpts\(\$\('nMore'\), !!from\)/, '続きのタスクは開いておく');
});
