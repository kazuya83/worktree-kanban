// スプリント（期間とゴールを持つ、タスクのまとまり）: 形・絞り込み・スイムレーン・IPC の中身・保存・画面
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const vm = require('vm');
const M = require('../renderer/cycle-model');
const I18n = require('../renderer/i18n');
const { createCycleApi } = require('../src/cycles');
const { Store, DEFAULT_SETTINGS } = require('../src/store');
const { isProxyChannel } = require('../src/remote');

const root = path.join(__dirname, '..');
const read = (rel) => fs.readFileSync(path.join(root, rel), 'utf8');
const cy = (id, extra = {}) => ({ id, repoPath: '/r', name: id.toUpperCase(), startDate: '', endDate: '', goal: '', done: false, createdAt: 1, ...extra });

test('cleanDate は実在する YYYY-MM-DD だけを残す', () => {
  assert.strictEqual(M.cleanDate('2026-11-08'), '2026-11-08');
  assert.strictEqual(M.cleanDate(' 2026-02-28 '), '2026-02-28');
  for (const bad of ['2026-02-30', '2026-13-01', '2026/11/08', '', null, undefined, 20261108, '2026-1-8']) assert.strictEqual(M.cleanDate(bad), '', String(bad));
});

test('cycleError: 名前は必須、日付は正しく、終了日は開始日より後', () => {
  assert.strictEqual(M.cycleError({ name: 'A' }), '');
  assert.match(M.cycleError({ name: '  ' }), /名前/);
  assert.match(M.cycleError({ name: 'A', startDate: 'x' }), /開始日/);
  assert.match(M.cycleError({ name: 'A', endDate: '2026-02-31' }), /終了日/);
  assert.match(M.cycleError({ name: 'A', startDate: '2026-11-10', endDate: '2026-11-01' }), /後/);
  assert.strictEqual(M.cycleError({ name: 'A', startDate: '2026-11-10', endDate: '2026-11-10' }), '');
});

test('cleanCycle / cleanCycles: 足りないものは捨て、値を整える', () => {
  assert.strictEqual(M.cleanCycle(null), null);
  assert.strictEqual(M.cleanCycle({ id: 'a', repoPath: '/r', name: ' ' }), null);
  assert.strictEqual(M.cleanCycle({ id: '', repoPath: '/r', name: 'x' }), null);
  const c = M.cleanCycle({ id: 'a', repoPath: '/r', name: '  Sprint\n 1 ', startDate: '2026-11-14', endDate: '2026-11-01', goal: 'g\r\n', done: 'yes', doneAt: 5, extra: 1 });
  assert.deepStrictEqual(c, { id: 'a', repoPath: '/r', name: 'Sprint 1', startDate: '2026-11-01', endDate: '2026-11-14', goal: 'g', done: false, createdAt: 0, updatedAt: 0, doneAt: 0 });
  assert.strictEqual(M.cleanCycle({ id: 'a', repoPath: '/r', name: 'x'.repeat(200) }).name.length, M.NAME_MAX);
  assert.deepStrictEqual(M.cleanCycles([cy('a'), cy('a'), { id: 'b' }, 'x', cy('c')]).map((x) => x.id), ['a', 'c']);
  assert.deepStrictEqual(M.cleanCycles('nope'), []);
});

test('cleanCycleView は知らない値なら上のタブ', () => {
  for (const v of M.VIEWS) assert.strictEqual(M.cleanCycleView(v), v);
  for (const v of ['', null, 'left', 1]) assert.strictEqual(M.cleanCycleView(v), 'top');
  assert.strictEqual(DEFAULT_SETTINGS.cycleView, 'top');
});

test('カードのスプリント: 自分のものがなければ親（サブタスク・並列の枝）のものを使う', () => {
  const cards = [
    { id: 'p', cycleIds: ['a', 'b', 'a'] },
    { id: 's', subtaskOf: { parent: 'p' } },
    { id: 'b1', relay: { branchOf: { parent: 's' } } },
    { id: 'own', subtaskOf: { parent: 'p' }, cycleIds: ['c'] },
    { id: 'loose' },
  ];
  assert.deepStrictEqual(M.cardCycleIds(cards[0], cards), ['a', 'b']);
  assert.deepStrictEqual(M.cardCycleIds(cards[1], cards), ['a', 'b']);
  assert.deepStrictEqual(M.cardCycleIds(cards[2], cards), ['a', 'b']);
  assert.deepStrictEqual(M.cardCycleIds(cards[3], cards), ['c']);
  assert.deepStrictEqual(M.cardCycleIds(cards[4], cards), []);
  // 親がぐるぐる回っていても止まる
  const loop = [{ id: 'x', subtaskOf: { parent: 'y' } }, { id: 'y', subtaskOf: { parent: 'x' } }];
  assert.deepStrictEqual(M.cardCycleIds(loop[0], loop), []);
});

test('選んでいるもので絞る: すべて・未割り当て・スプリント。消えたスプリントは数えない', () => {
  const cycles = [cy('a'), cy('b')];
  const cards = [{ id: '1', cycleIds: ['a'] }, { id: '2', cycleIds: ['a', 'b'] }, { id: '3' }, { id: '4', cycleIds: ['gone'] }];
  const pick = (sel) => cards.filter((c) => M.inSelection(c, sel, cards, cycles)).map((c) => c.id);
  assert.deepStrictEqual(pick('all'), ['1', '2', '3', '4']);
  assert.deepStrictEqual(pick('none'), ['3', '4']);
  assert.deepStrictEqual(pick('a'), ['1', '2']);
  assert.deepStrictEqual(pick('b'), ['2']);
});

test('cleanSelection: 消えた・隠した（完了した）スプリントは「すべて」に戻す', () => {
  const cycles = [cy('a'), cy('d', { done: true })];
  assert.strictEqual(M.cleanSelection('a', cycles, false), 'a');
  assert.strictEqual(M.cleanSelection('none', cycles, false), 'none');
  assert.strictEqual(M.cleanSelection('zzz', cycles, false), 'all');
  assert.strictEqual(M.cleanSelection('d', cycles, false), 'all');
  assert.strictEqual(M.cleanSelection('d', cycles, true), 'd');
});

test('新しいタスク: スプリントを選んでいるときだけ、そのスプリントに入れる（完了したスプリントには入れない）', () => {
  const cycles = [cy('a'), cy('d', { done: true })];
  assert.deepStrictEqual(M.newTaskCycleIds('a', cycles), ['a']);
  assert.deepStrictEqual(M.newTaskCycleIds('d', cycles), []);
  assert.deepStrictEqual(M.newTaskCycleIds('all', cycles), []);
  assert.deepStrictEqual(M.newTaskCycleIds('none', cycles), []);
});

test('ドラッグ: スプリントへ落とすと加え、未割り当てなら外す。スイムレーンでは元の段から移す', () => {
  assert.deepStrictEqual(M.dropCycleIds(['a'], 'b'), ['a', 'b']);
  assert.deepStrictEqual(M.dropCycleIds(['a', 'b'], 'b'), ['a', 'b']);
  assert.deepStrictEqual(M.dropCycleIds(['a', 'b'], 'none'), []);
  assert.deepStrictEqual(M.dropCycleIds(['a', 'b'], 'c', 'a'), ['b', 'c']);
  assert.deepStrictEqual(M.dropCycleIds([], 'c', 'none'), ['c']);
  assert.deepStrictEqual(M.dropCycleIds(['a'], 'all'), ['a']);
});

test('スイムレーン: 表示するスプリントごとの段と、最後に未割り当て。複数のスプリントのカードは両方の段に出る', () => {
  const cycles = [cy('b', { startDate: '2026-12-01' }), cy('a', { startDate: '2026-11-01' }), cy('d', { done: true }), cy('n')];
  const cards = [{ id: '1', cycleIds: ['a', 'b'] }, { id: '2' }, { id: '3', cycleIds: ['d'] }, { id: '4', cycleIds: ['n'] }];
  const lanes = M.laneGroups(cards, cycles, cards, false);
  assert.deepStrictEqual(lanes.map((l) => [l.key, l.cards.map((c) => c.id)]), [['a', ['1']], ['b', ['1']], ['n', ['4']], ['none', ['2']]]);
  const all = M.laneGroups(cards, cycles, cards, true);
  assert.deepStrictEqual(all.map((l) => l.key), ['a', 'b', 'd', 'n', 'none']);
  assert.deepStrictEqual(all.find((l) => l.key === 'd').cards.map((c) => c.id), ['3']);
});

test('状態と期間の表示', () => {
  const now = new Date(2026, 10, 8, 12).getTime();
  assert.strictEqual(M.today(now), '2026-11-08');
  assert.strictEqual(M.cycleState(cy('a', { done: true, startDate: '2026-11-01' }), now), 'done');
  assert.strictEqual(M.cycleState(cy('a', { startDate: '2026-11-09' }), now), 'upcoming');
  assert.strictEqual(M.cycleState(cy('a', { startDate: '2026-11-01', endDate: '2026-11-08' }), now), 'active');
  assert.strictEqual(M.cycleState(cy('a', { endDate: '2026-11-07' }), now), 'ended');
  assert.strictEqual(M.cycleState(cy('a'), now), '');
  assert.strictEqual(M.periodLabel(cy('a', { startDate: '2026-11-01', endDate: '2026-11-14' }), now), '11/1 – 11/14');
  assert.strictEqual(M.periodLabel(cy('a', { startDate: '2026-12-20', endDate: '2027-01-03' }), now), '12/20 – 2027/1/3');
  assert.strictEqual(M.periodLabel(cy('a', { startDate: '2026-11-01' }), now), '11/1 –');
  assert.strictEqual(M.periodLabel(cy('a'), now), '');
});

// ---- IPC の中身（src/cycles.js） ----
function fakeStore(repoPath = '/r') {
  const data = { cycles: [], cards: [] };
  let saves = 0;
  return {
    settings: { repoPath },
    get cards() {
      return data.cards;
    },
    cyclesOf: (p) => data.cycles.filter((c) => c.repoPath === p),
    cycle: (id) => data.cycles.find((c) => c.id === id),
    addCycle: (c) => data.cycles.push(c),
    removeCycle: (id) => (data.cycles = data.cycles.filter((c) => c.id !== id)),
    card: (id) => data.cards.find((c) => c.id === id),
    save: () => saves++,
    get saves() {
      return saves;
    },
    data,
  };
}

test('cycles:create は今のリポジトリに作り、入力を確かめる', () => {
  const store = fakeStore();
  let changed = 0;
  const api = createCycleApi({ store, onChange: () => changed++, now: () => 100 });
  const c = api.create({ name: ' 11月前半 ', startDate: '2026-11-01', endDate: '2026-11-14', goal: 'ゴール', done: true, repoPath: '/other' });
  assert.strictEqual(c.repoPath, '/r');
  assert.strictEqual(c.name, '11月前半');
  assert.strictEqual(c.done, false, '作るときは完了にしない');
  assert.strictEqual(c.createdAt, 100);
  assert.match(c.id, /^[0-9a-f]{8}$/);
  assert.strictEqual(store.data.cycles.length, 1);
  assert.strictEqual(changed, 1);
  assert.strictEqual(store.saves, 1);
  assert.throws(() => api.create({ name: '' }), /名前/);
  assert.throws(() => api.create({ name: 'x', startDate: '2026-11-10', endDate: '2026-11-01' }), /後/);
  assert.throws(() => createCycleApi({ store: fakeStore('') }).create({ name: 'x' }), /リポジトリ/);
});

test('cycles:update は名前・期間・ゴール・完了を変える', () => {
  const store = fakeStore();
  let t = 1;
  const api = createCycleApi({ store, now: () => t++ });
  const c = api.create({ name: 'A' });
  const u = api.update({ id: c.id, name: 'B', goal: 'G', endDate: '2026-11-30', repoPath: '/x', id2: 1 });
  assert.strictEqual(u.name, 'B');
  assert.strictEqual(u.goal, 'G');
  assert.strictEqual(u.endDate, '2026-11-30');
  assert.strictEqual(u.repoPath, '/r');
  const d = api.update({ id: c.id, done: true });
  assert.strictEqual(d.done, true);
  assert.ok(d.doneAt > 0);
  assert.strictEqual(d.name, 'B', '指定しない項目は変えない');
  assert.strictEqual(api.update({ id: c.id, done: false }).done, false);
  assert.throws(() => api.update({ id: c.id, name: '' }), /名前/);
  assert.throws(() => api.update({ id: 'nope', name: 'x' }), /見つかりません/);
  assert.throws(() => api.update({ name: 'x' }), /指定されていません/);
});

test('cycles:delete はスプリントを消し、タスクは消さずにそのスプリントから外す', () => {
  const store = fakeStore();
  const api = createCycleApi({ store });
  const a = api.create({ name: 'A' });
  const b = api.create({ name: 'B' });
  store.data.cards.push({ id: '1', repoPath: '/r', cycleIds: [a.id, b.id] }, { id: '2', repoPath: '/r', cycleIds: [a.id] }, { id: '3', repoPath: '/r' });
  api.delete(a.id);
  assert.deepStrictEqual(store.data.cycles.map((c) => c.id), [b.id]);
  assert.deepStrictEqual(store.data.cards[0].cycleIds, [b.id]);
  assert.ok(!('cycleIds' in store.data.cards[1]));
  assert.strictEqual(store.data.cards.length, 3);
  assert.throws(() => api.delete({ id: a.id }), /見つかりません/);
});

test('cycles:setCard はそのリポジトリのスプリントだけを入れる。空なら消す', () => {
  const store = fakeStore();
  const api = createCycleApi({ store });
  const a = api.create({ name: 'A' });
  const b = api.create({ name: 'B' });
  store.data.cycles.push(cy('other', { repoPath: '/other' }));
  store.data.cards.push({ id: '1', repoPath: '/r' });
  assert.deepStrictEqual(api.setCard({ id: '1', cycleIds: [b.id, a.id, b.id, 'other', 'gone'] }), [b.id, a.id]);
  assert.deepStrictEqual(store.data.cards[0].cycleIds, [b.id, a.id]);
  assert.deepStrictEqual(api.setCard({ id: '1', cycleIds: [] }), []);
  assert.ok(!('cycleIds' in store.data.cards[0]));
  assert.throws(() => api.setCard({ id: 'nope', cycleIds: [] }), /見つかりません/);
  assert.throws(() => api.setCard({ cycleIds: [] }), /指定されていません/);
});

test('作ったばかりのタスクを、選んでいたスプリントに入れる（なければ何もしない）', () => {
  const store = fakeStore();
  let changed = 0;
  const api = createCycleApi({ store, onChange: () => changed++ });
  const a = api.create({ name: 'A' });
  changed = 0;
  store.data.cards.push({ id: '1', repoPath: '/r' }, { id: '2', repoPath: '/r' });
  api.assignNew(['1', '2'], undefined);
  assert.strictEqual(changed, 0);
  api.assignNew(['1', '2', 'gone'], [a.id, 'x']);
  assert.deepStrictEqual(store.data.cards.map((c) => c.cycleIds), [[a.id], [a.id]]);
  assert.strictEqual(changed, 1);
});

test('スプリントは board.json に保存され、読み直せる（壊れたものは捨てる）', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cycles-'));
  const file = path.join(dir, 'board.json');
  try {
    const s = new Store(file);
    s.addCycle(M.cleanCycle(cy('a')));
    s.flush();
    const raw = JSON.parse(fs.readFileSync(file, 'utf8'));
    raw.cycles.push({ id: 'bad' });
    raw.settings.cycleView = 'weird';
    fs.writeFileSync(file, JSON.stringify(raw));
    const s2 = new Store(file);
    assert.deepStrictEqual(s2.cycles.map((c) => c.id), ['a']);
    assert.deepStrictEqual(s2.cyclesOf('/r').map((c) => c.id), ['a']);
    assert.deepStrictEqual(s2.cyclesOf('/x'), []);
    assert.strictEqual(s2.settings.cycleView, 'top');
    s2.removeCycle('a');
    assert.deepStrictEqual(s2.cycles, []);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('つなぎ: main・preload・遠隔操作・画面のスクリプト', () => {
  const main = read('main.js');
  for (const ch of ['cycles:create', 'cycles:update', 'cycles:delete', 'cycles:setCard']) {
    assert.ok(main.includes(`handle('${ch}'`), ch);
    assert.ok(isProxyChannel(ch), `遠隔操作ではホストで行う: ${ch}`);
  }
  assert.match(main, /cycles: store\.cyclesOf\(store\.settings\.repoPath\)/);
  assert.match(main, /'weeklyResetTime', 'cycleView'\]/);
  assert.match(main, /cycleApi\.assignNew\(cards\.map\(\(c\) => c\.id\), cycleIds\)/);
  const preload = read('preload.js');
  for (const fn of ['createCycle', 'updateCycle', 'deleteCycle', 'setCardCycles']) assert.match(preload, new RegExp(`${fn}: `));
  const html = read('renderer/index.html');
  const order = [...html.matchAll(/<script src="([^"]+)"/g)].map((m) => m[1]);
  assert.ok(order.indexOf('locales/cycles.js') < order.indexOf('cycle-model.js'));
  assert.ok(order.indexOf('cycle-model.js') < order.indexOf('cycles-view.js'));
  assert.ok(order.indexOf('cycles-view.js') < order.indexOf('renderer.js'));
});

test('スプリントの文言は4言語に訳され、差し込み名が一致する', () => {
  const re = /(?:^|[^A-Za-z0-9_$])tr\(\s*'((?:\\.|[^'\\])*)'/g;
  const keys = new Set();
  for (const f of ['renderer/cycle-model.js', 'renderer/cycles-view.js', 'src/cycles.js']) for (const m of read(f).matchAll(re)) keys.add(m[1].replace(/\\(.)/g, (_, c) => ({ n: '\n' })[c] || c));
  const src = read('renderer/renderer.js');
  for (const k of ['スプリントの表示', 'ボードの上にタブで並べて切り替える', 'ボードの左のサイドバーで切り替える']) {
    assert.ok(src.includes(`tr('${k}')`), k);
    keys.add(k);
  }
  assert.ok(keys.size > 40);
  const ph = (s) => [...String(s).matchAll(/\{(\w+)\}/g)].map((m) => m[1]).sort();
  try {
    for (const key of keys) {
      for (const lang of ['en', 'es', 'fr', 'zh']) {
        assert.strictEqual(I18n.has(key, lang), true, `${lang}: ${key}`);
        I18n.setLanguage(lang);
        assert.deepStrictEqual(ph(I18n.tr(key)), ph(key), key);
      }
    }
  } finally {
    I18n.setLanguage('ja');
  }
  assert.doesNotMatch(read('renderer/locales/cycles.js'), /サイクル|\b[Cc]ycles?\b|[Cc]iclos?\b|周期/, '画面の言葉は「スプリント」にそろえる');
});

// ---- 画面（cycles-view.js）: renderer.js の部品を置き換えて、HTML と操作を確かめる ----
function loadView({ cycles = [], cards = [], settings = {}, selection } = {}) {
  const ls = new Map();
  if (selection) ls.set(`cycleSel:${settings.repoPath || '/r'}`, selection);
  const calls = [];
  const ctx = {
    state: { board: { settings: { repoPath: '/r', ...settings }, cards, cycles } },
    localStorage: { getItem: (k) => (ls.has(k) ? ls.get(k) : null), setItem: (k, v) => ls.set(k, String(v)) },
    esc: (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]),
    icon: (n) => `<i:${n}>`,
    isChat: (c) => !!c && c.kind === 'chat',
    isHiddenSubtask: (c) => !!(c && c.subtaskOf),
    cardHtml: (c) => `<card ${c.id}>`,
    runBusy: async (_m, fn) => fn(),
    toast: () => {},
    api: {
      setCardCycles: async (id, ids) => {
        calls.push(['setCardCycles', id, ids]);
        return ids;
      },
    },
    I18n,
  };
  ctx.self = ctx;
  vm.createContext(ctx);
  vm.runInContext(read('renderer/cycle-model.js'), ctx);
  vm.runInContext(read('renderer/cycles-view.js'), ctx);
  return { V: ctx.CycleView, calls, ls };
}

test('画面: 上のタブは「すべて・未割り当て・各スプリント」と数を出し、選んだスプリントのタスクだけを残す', () => {
  const cycles = [cy('a', { goal: '<b>ゴール</b>', startDate: '2026-11-01' }), cy('d', { done: true })];
  const cards = [{ id: '1', cycleIds: ['a'] }, { id: '2' }, { id: '3', cycleIds: ['d'] }];
  const { V } = loadView({ cycles, cards, selection: 'a' });
  assert.strictEqual(V.mode(), 'top');
  const html = V.chromeHtml(cards);
  assert.match(html, /class="cycle-bar"/);
  assert.match(html, /data-cycle-sel="all"[\s\S]*?cy-count">3</);
  assert.match(html, /data-cycle-sel="none" data-cycle-drop="none"[\s\S]*?cy-count">1</);
  assert.match(html, /cy-item active[^"]*" data-cycle-sel="a"/);
  assert.doesNotMatch(html, /data-cycle-sel="d"/, '完了したスプリントは出さない');
  assert.match(html, /&lt;b&gt;ゴール&lt;\/b&gt;/, 'ゴールは文字として出す');
  assert.deepStrictEqual(cards.filter(V.inView).map((c) => c.id), ['1']);
  assert.deepStrictEqual([...V.newTaskIds()], ['a']);
});

test('画面: サイドバー・スイムレーン', () => {
  const cycles = [cy('a'), cy('b')];
  const cards = [{ id: '1', status: 'todo', cycleIds: ['a', 'b'] }, { id: '2', status: 'done' }];
  const side = loadView({ cycles, cards, settings: { cycleView: 'sidebar' } }).V;
  assert.match(side.chromeHtml(cards), /<aside class="cycle-side"/);
  const { V } = loadView({ cycles, cards, settings: { cycleView: 'lanes' }, selection: 'a' });
  assert.strictEqual(V.selection(), 'all', 'スイムレーンでは絞らない');
  assert.deepStrictEqual(cards.filter(V.inView).map((c) => c.id), ['1', '2']);
  assert.deepStrictEqual([...V.newTaskIds()], []);
  const cols = [{ key: 'todo', label: 'Todo', statuses: ['todo'] }, { key: 'done', label: 'Done', statuses: ['done'] }];
  const html = V.lanesHtml(cards, cols, (list, col) => list.filter((c) => col.statuses.includes(c.status)));
  assert.deepStrictEqual([...html.matchAll(/data-lane-row="([^"]+)"/g)].map((m) => m[1]), ['a', 'b', 'none']);
  assert.match(html, /data-col="todo" data-lane="a"><div class="cards"><card 1>/);
  assert.match(html, /data-col="todo" data-lane="b"><div class="cards"><card 1>/);
  assert.match(html, /data-col="done" data-lane="none"><div class="cards"><card 2>/);
  assert.strictEqual(V.chipsHtml(cards[0]), '', 'スイムレーンではカードに印を出さない');
});

test('画面: ドラッグでスプリントに入れる・外す・段を移す', async () => {
  const cycles = [cy('a'), cy('b'), cy('d', { done: true })];
  const cards = [{ id: '1', cycleIds: ['a'] }, { id: '2' }, { id: 'c', kind: 'chat' }];
  const { V, calls } = loadView({ cycles, cards });
  const plain = (v) => JSON.parse(JSON.stringify(v));
  assert.strictEqual(V.canDropOn(cards[0], 'a'), false, 'もう入っている');
  assert.strictEqual(V.canDropOn(cards[0], 'b'), true);
  assert.strictEqual(V.canDropOn(cards[0], 'd'), false, '完了したスプリントには入れない');
  assert.strictEqual(V.canDropOn(cards[0], 'none'), true);
  assert.strictEqual(V.canDropOn(cards[1], 'none'), false, 'もう未割り当て');
  assert.strictEqual(V.canDropOn(cards[2], 'a'), false, '会話は入れない');
  await V.dropOn(cards[0], 'b');
  await V.dropOn(cards[0], 'none');
  assert.strictEqual(V.canLaneDrop(cards[0], 'a', 'a'), false);
  await V.moveLane(cards[0], 'a', 'b');
  assert.deepStrictEqual(plain(calls), [
    ['setCardCycles', '1', ['a', 'b']],
    ['setCardCycles', '1', []],
    ['setCardCycles', '1', ['b']],
  ]);
  assert.match(V.chipsHtml(cards[0]), /class="cycle-chip "[^>]*>A</);
  assert.strictEqual(V.chipsHtml(cards[1]), '');
});

test('画面: 新しいタスクのスプリントの欄と、詳細の「スプリント」ボタン', () => {
  const { V } = loadView({ cycles: [cy('a'), cy('d', { done: true })], cards: [{ id: '1', cycleIds: ['a'] }, { id: 's', subtaskOf: { parent: '1' } }] });
  const f = V.fieldHtml('n', ['a']);
  assert.match(f, /id="nCycles"/);
  assert.match(f, /value="a" checked/);
  assert.doesNotMatch(f, /value="d"/, '完了したスプリントは、入っていなければ選ばせない');
  assert.match(V.detailButtonHtml({ id: '1', cycleIds: ['a'] }), /data-act="cycles"/);
  assert.strictEqual(V.detailButtonHtml({ id: 's', subtaskOf: { parent: '1' } }), '');
  assert.strictEqual(loadView({ cycles: [] }).V.fieldHtml('n', []), '', 'スプリントがなければ欄を出さない');
});
