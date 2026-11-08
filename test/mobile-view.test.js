// スマホ用の画面（mobile/）: Markdown の木・チャットの並べ方・カードの見方・言葉・CSP に合う作り
const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const root = path.join(__dirname, '..');
const read = (rel) => fs.readFileSync(path.join(root, rel), 'utf8');
const I18n = require('../renderer/i18n.js');
const Md = require('../mobile/assets/markdown-dom.js');
const Chat = require('../mobile/assets/chat-model.js');
const BM = require('../mobile/assets/board-model.js');

test.afterEach(() => I18n.setLanguage('ja'));

test('Markdown: 木にしてから組み立てる。HTML は文字のまま、リンクは http(s) だけ', () => {
  const tree = Md.parse('# 見出し\n\n<script>alert(1)</script> **太字** と `code` と [リンク](https://example.com/a) と [悪い](javascript:alert(1))\n\n- [x] 済み\n- 次\n  1. 入れ子\n\n```js\nconst a = "<b>";\n```\n\n| a | b |\n|:-:|--:|\n| 1 | 2 |');
  assert.deepStrictEqual(tree[0], { t: 'h', level: 1, c: [{ t: 'text', v: '見出し' }] });
  const p = tree[1];
  assert.strictEqual(p.t, 'p');
  assert.deepStrictEqual(p.c[0], { t: 'text', v: '<script>alert(1)</script> ' });
  assert.deepStrictEqual(p.c[1], { t: 'strong', c: [{ t: 'text', v: '太字' }] });
  assert.ok(p.c.some((n) => n.t === 'code' && n.v === 'code'));
  assert.ok(p.c.some((n) => n.t === 'link' && n.href === 'https://example.com/a'));
  assert.ok(!JSON.stringify(p).includes('"href":"javascript'), 'javascript: はリンクにしない');
  const list = tree[2];
  assert.strictEqual(list.t, 'list');
  assert.strictEqual(list.items[0].task, true);
  assert.strictEqual(list.items[1].sub[0].ordered, true);
  assert.deepStrictEqual(tree[3], { t: 'codeblock', lang: 'js', v: 'const a = "<b>";' });
  assert.deepStrictEqual(tree[4].align, ['center', 'right']);
  assert.strictEqual(Md.isSafeUrl('https://a.b/c'), true);
  for (const bad of ['javascript:alert(1)', 'data:text/html,x', 'http://a"onmouseover=x', '', null]) assert.strictEqual(Md.isSafeUrl(bad), false, String(bad));
  assert.strictEqual(Md.plain('## 題\n- **一** つ\n`x`'), '題 • 一 つ x');
});

test('Markdown: DOM は textContent と setAttribute だけで組み立てる（innerHTML を使わない）', () => {
  // とても小さな DOM の偽物
  const made = [];
  const node = (tag) => {
    const n = { tag, kids: [], attrs: {}, className: '', textContent: '', appendChild: (k) => (n.kids.push(k), k), setAttribute: (k, v) => (n.attrs[k] = v) };
    Object.defineProperty(n, 'innerHTML', { set: () => assert.fail('innerHTML は使わない') });
    made.push(n);
    return n;
  };
  const doc = { createElement: node, createTextNode: (v) => ({ text: v }), createDocumentFragment: () => node('#frag') };
  const frag = Md.render(doc, '<img src=x onerror=alert(1)> [a](https://x.example/?q=1) `<b>`\n\n```\n<script>\n```', { copyLabel: 'Copy' });
  const p = frag.kids[0];
  assert.strictEqual(p.tag, 'p');
  assert.strictEqual(p.kids[0].text, '<img src=x onerror=alert(1)> ');
  const a = p.kids.find((k) => k.tag === 'a');
  assert.deepStrictEqual(a.attrs, { href: 'https://x.example/?q=1', target: '_blank', rel: 'noopener noreferrer' });
  assert.strictEqual(p.kids.find((k) => k.tag === 'code').textContent, '<b>');
  const wrap = frag.kids[1];
  assert.strictEqual(wrap.kids[0].textContent, 'Copy');
  assert.strictEqual(wrap.kids[1].kids[0].textContent, '<script>');
});

test('チャットの並べ方: ツールの結果は呼び出しにまとめ、チャットは最後の返事だけ（実行中は出さない）', () => {
  const logs = [
    { kind: 'user', text: 'やって' },
    { kind: 'text', text: '考え中' },
    { kind: 'tool', text: 'Bash  npm test' },
    { kind: 'tool_result', text: 'ok' },
    { kind: 'text', text: '終わりました' },
    { kind: 'result', text: '完了' },
    { kind: 'text', text: '追記', agent: 'codex' },
  ];
  const items = Chat.build(logs, 'claude');
  assert.deepStrictEqual(items.map((x) => x.type), ['user', 'assistant', 'tool', 'assistant', 'notice', 'assistant']);
  assert.strictEqual(items[2].result.text, 'ok');
  assert.deepStrictEqual(items.map((x) => !!x.head), [false, true, false, false, false, true]);
  const fin = Chat.final(logs, 'claude', false);
  assert.deepStrictEqual(fin.map((x) => [x.type, x.entry.text]), [['user', 'やって'], ['assistant', '終わりました'], ['assistant', '追記']]);
  assert.strictEqual(Chat.final(logs, 'claude', true).length, 2, '実行中の途中の返事は出さない');
  const live = [];
  assert.strictEqual(Chat.push(live, { kind: 'tool', text: 'Read  a.js' }, 'claude').op, 'append');
  assert.strictEqual(Chat.push(live, { kind: 'tool_error', text: 'x' }, 'claude').op, 'replace');
  assert.strictEqual(Chat.push(live, null, 'claude'), null);
  assert.deepStrictEqual(Chat.splitTool('Bash  npm test'), ['Bash', 'npm test']);
});

test('カードの見方: 列・確認待ち・バッジ・動かせる列・入力欄の使い方は、デスクトップと同じ決まり', () => {
  const cards = [
    { id: 'a', status: 'todo', createdAt: 1 },
    { id: 'b', status: 'running', createdAt: 2 },
    { id: 'c', status: 'review', createdAt: 3, permissions: [{ id: 'r1', toolName: 'Bash' }] },
    { id: 'd', status: 'review', createdAt: 4, worktreePath: '/w' },
    { id: 'e', status: 'done', createdAt: 5 },
    { id: 'f', status: 'review', createdAt: 6, subtasks: { phase: 'run', items: [{ key: 'k', state: 'running', cardId: 'g' }] } },
    { id: 'g', status: 'review', createdAt: 7, subtaskOf: { parent: 'f' }, questions: [{ id: 'q', questions: [] }] },
    { id: 'h', status: 'review', kind: 'chat', unread: true, createdAt: 8 },
    { id: 'i', status: 'failed', createdAt: 9, interrupted: { kind: 'running' } },
  ];
  const m = BM.model(cards);
  assert.deepStrictEqual(m.columnCards('todo').map((c) => c.id), ['a']);
  assert.deepStrictEqual(m.columnCards('running').map((c) => c.id), ['f', 'b'], 'サブタスクを動かしている親は実行中。対応待ちが上');
  assert.deepStrictEqual(m.columnCards('review').map((c) => c.id), ['i', 'c', 'd'], '会話と隠れたサブタスクは出さない');
  assert.strictEqual(m.needsYou(cards[2]), true);
  assert.deepStrictEqual(m.badge(cards[2]), ['waiting', '承認待ち']);
  assert.deepStrictEqual(m.badge(cards[8]), ['interrupted', '中断']);
  assert.deepStrictEqual(m.badge(cards[5]), ['awaiting', 'サブタスクが対応待ち']);
  assert.strictEqual(m.canMove(cards[0], 'running'), true);
  assert.strictEqual(m.canMove(cards[3], 'done'), true);
  assert.strictEqual(m.canMove(cards[4], 'review'), true);
  assert.strictEqual(m.canMove(cards[1], 'done'), false);
  assert.strictEqual(m.canMove(cards[7], 'done'), false, '会話は動かさない');
  assert.strictEqual(m.isUnreadChat(cards[7], null), true);
  assert.strictEqual(m.isUnreadChat(cards[7], 'h'), false, '開いている会話は未読にしない');
  assert.strictEqual(BM.composerMode(cards[1]), 'btw');
  assert.strictEqual(BM.composerMode(cards[3]), 'send');
  assert.strictEqual(BM.composerMode(cards[0]), 'off');
  assert.strictEqual(BM.composerMode({ status: 'done', afterDone: true }), 'off');
  assert.deepStrictEqual([...BM.unreadCardIds([{ cardId: 'a' }, { cardId: 'b', read: true }, { id: 'n' }])], ['a']);
  I18n.setLanguage('en');
  assert.deepStrictEqual(m.badge(cards[2]), ['waiting', 'Waiting for approval']);
});

test('仕様の質問の答えと、タスクを作るときのエージェントの選択肢', () => {
  const msg = BM.specAnswerMessage([{ question: 'どこ？' }, { question: 'いつ？' }], { 'どこ？': 'ここ' }, '補足です', false);
  assert.strictEqual(msg, '仕様の質問への答えです。\n\n1. どこ？\n   → ここ\n2. いつ？\n   → おまかせ（妥当な案で決めてください）\n\n補足: 補足です');
  const none = BM.agentChoices({});
  assert.deepStrictEqual(none.groups.map((g) => g.options.map((o) => o.value)), [['claude']]);
  assert.strictEqual(none.value, 'claude');
  const s = {
    enabledAgents: ['claude', 'codex'],
    defaultAgent: 'codex',
    customAgents: [{ id: 'x', name: 'レビュー係', agent: 'gemini' }],
    relayFlows: [{ id: 'p1', name: '速い', flow: { nodes: [{ id: 's', type: 'start' }, { id: 'a', type: 'agent' }] } }, { id: 'p2', name: '空', flow: { nodes: [] } }],
    relayFlowId: 'p1',
  };
  const c = BM.agentChoices(s);
  assert.deepStrictEqual(c.groups.map((g) => g.options.map((o) => [o.value, !!o.disabled])), [[['claude', false], ['codex', false]], [['custom:x', true]], [['relay:p1', false], ['relay:p2', true]]]);
  assert.strictEqual(c.value, 'codex', '設定で最初から選んでおくもの');
  assert.strictEqual(BM.agentChoices({ ...s, defaultAgent: 'relay:p1' }).value, 'relay:p1', 'Pipeline も最初から選んでおける');
  assert.strictEqual(BM.agentChoices({ ...s, defaultAgent: 'relay:p2' }).value, 'claude', '使えない Pipeline なら1つのエージェント');
  // 競争はいくつでも作れて、Pipeline と一緒に選べる
  const comp = BM.agentChoices({ ...s, defaultAgent: 'compete:k2', competes: [{ id: 'k1', name: '一人', agents: ['claude'], customAgents: [] }, { id: 'k2', name: '二人', agents: ['claude', 'codex'], customAgents: [] }] });
  assert.deepStrictEqual(comp.groups.slice(2).map((g) => g.options.map((o) => [o.value, !!o.disabled])), [[['relay:p1', false], ['relay:p2', true]], [['compete:k1', true], ['compete:k2', false]]]);
  assert.strictEqual(comp.value, 'compete:k2');
});

// 画面で読む辞書（index.html が読むもの）だけで、mobile の tr がすべて4言語に訳せること
function browserTable() {
  const table = {};
  const html = read('mobile/index.html');
  const files = [...html.matchAll(/<script src="\/locales\/([^"]+)"/g)].map((m) => m[1]);
  for (const f of files) vm.runInNewContext(read(`renderer/locales/${f}`), { I18n: { add: (e) => Object.assign(table, e) } });
  return table;
}
function mobileKeys() {
  const keys = new Set();
  for (const f of fs.readdirSync(path.join(root, 'mobile/assets')).filter((x) => x.endsWith('.js'))) {
    const src = read(`mobile/assets/${f}`);
    const re = /\btr\(\s*('(?:\\'|[^'])*')/g;
    let m;
    while ((m = re.exec(src))) keys.add(Function(`"use strict"; return ${m[1]};`)());
  }
  return [...keys];
}

test('mobile の文言は、画面で読む辞書（shell・board・mobile）に4言語の訳があり、差し込みの名前が一致する', () => {
  const table = browserTable();
  const keys = mobileKeys();
  assert.ok(keys.length > 100, String(keys.length));
  const bad = [];
  for (const key of keys) {
    const names = [...key.matchAll(/\{(\w+)\}/g)].map((m) => m[1]).sort().join();
    for (const lang of ['en', 'es', 'fr', 'zh']) {
      const s = table[key] && table[key][lang];
      if (!s) bad.push(`missing ${lang}: ${key}`);
      else if ([...s.matchAll(/\{(\w+)\}/g)].map((m) => m[1]).sort().join() !== names) bad.push(`ph ${lang}: ${key}`);
    }
  }
  assert.deepStrictEqual(bad, []);
});

test('mobile.js は他の辞書と同じキーなら同じ訳にする（node ではすべての辞書を読むので、違うと上書きしあう）', () => {
  const load = (f) => {
    const t = {};
    vm.runInNewContext(read(`renderer/locales/${f}`), { I18n: { add: (e) => Object.assign(t, e) } });
    return t;
  };
  const mine = load('mobile.js');
  const conflicts = [];
  for (const f of fs.readdirSync(path.join(root, 'renderer/locales')).filter((x) => x !== 'mobile.js')) {
    const other = load(f);
    for (const k of Object.keys(mine)) if (other[k] && JSON.stringify(other[k]) !== JSON.stringify(mine[k])) conflicts.push(`${f}: ${k}`);
  }
  assert.deepStrictEqual(conflicts, []);
});

test('CSP（script-src / style-src が self だけ）に合う: インラインのスクリプト・スタイル・イベント属性がない', () => {
  const html = read('mobile/index.html');
  assert.doesNotMatch(html, /<script(?![^>]*\bsrc=)[^>]*>/, 'インラインの <script> はない');
  assert.doesNotMatch(html, /<style\b/);
  assert.doesNotMatch(html, /\sstyle=/);
  assert.doesNotMatch(html, /\son[a-z]+=/i);
  assert.doesNotMatch(html, /https?:\/\//, '外の CDN は使わない');
  const order = [...html.matchAll(/<script src="([^"]+)"/g)].map((m) => m[1]);
  assert.deepStrictEqual(order.slice(0, 4), ['/i18n.js', '/locales/shell.js', '/locales/board.js', '/locales/mobile.js']);
  assert.strictEqual(order[order.length - 1], '/assets/app.js');
  for (const f of fs.readdirSync(path.join(root, 'mobile/assets')).filter((x) => x.endsWith('.js'))) {
    const src = read(`mobile/assets/${f}`);
    assert.doesNotMatch(src, /\.innerHTML\s*=|insertAdjacentHTML|outerHTML\s*=|document\.write/, `${f}: HTML の文字列を入れない`);
    assert.doesNotMatch(src, /\beval\(|new Function\(/, f);
  }
  const manifest = JSON.parse(read('mobile/manifest.webmanifest'));
  assert.strictEqual(manifest.start_url, '/');
  for (const icon of manifest.icons) assert.ok(fs.existsSync(path.join(root, 'mobile', icon.src)), icon.src);
  assert.match(read('mobile/assets/app.css'), /safe-area-inset-bottom/);
  assert.match(read('mobile/assets/app.css'), /prefers-color-scheme: dark/);
});
