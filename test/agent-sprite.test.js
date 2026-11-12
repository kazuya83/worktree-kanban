// 進捗の見える化（renderer/agent-sprite.js）: ロボットの様子・TODO の進み具合・画面へのつなぎ
const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');
const AgentSprite = require('../renderer/agent-sprite.js');
require('../renderer/locales/board.js');
const I18n = require('../renderer/i18n.js');

const root = path.join(__dirname, '..');
const read = (rel) => fs.readFileSync(path.join(root, rel), 'utf8');

test('ツールの名前から作業の種類を決める（CLI ごとの名前の違いも拾う）', () => {
  const cases = {
    Edit: 'edit', Write: 'edit', MultiEdit: 'edit', apply_patch: 'edit', write_file: 'edit', replace: 'edit',
    Read: 'read', read_file: 'read',
    Bash: 'run', shell: 'run', run_shell_command: 'run', exec_command: 'run',
    Grep: 'search', Glob: 'search', search_file_content: 'search', ls: 'search',
    WebFetch: 'web', WebSearch: 'web', google_web_search: 'web',
    TodoWrite: 'plan', write_todos: 'plan', update_plan: 'plan',
    Task: 'agent', Agent: 'agent',
    mcp__foo__bar: 'tool', '': 'tool',
  };
  for (const [name, kind] of Object.entries(cases)) assert.strictEqual(AgentSprite.toolKind(name), kind, name);
});

test('様子: 待っているのが最優先、実行中はツールなら作業・それ以外は考え中', () => {
  const m = AgentSprite.moodOf;
  assert.deepStrictEqual(m({ status: 'running', attention: 'perm' }), { mood: 'wait', tool: 'perm' });
  assert.deepStrictEqual(m({ status: 'review', attention: 'ask' }), { mood: 'wait', tool: 'ask' });
  assert.deepStrictEqual(m({ status: 'running', activity: { kind: 'tool', name: 'Edit', at: 20 }, startedAt: 10 }), { mood: 'work', tool: 'edit' });
  // 前の実行のツールは使わない
  assert.deepStrictEqual(m({ status: 'running', activity: { kind: 'tool', name: 'Edit', at: 5 }, startedAt: 10 }), { mood: 'think', tool: null });
  assert.deepStrictEqual(m({ status: 'running', activity: { kind: 'text', at: 20 }, startedAt: 10 }), { mood: 'think', tool: null });
  assert.strictEqual(m({ status: 'queued' }).mood, 'queued');
  // レビューはゴールではなく、あなたの確認待ち
  assert.deepStrictEqual(m({ status: 'review' }), { mood: 'wait', tool: 'review' });
  assert.strictEqual(m({ status: 'done' }).mood, 'done');
  assert.strictEqual(m({ status: 'failed' }).mood, 'fail');
  assert.strictEqual(m({ status: 'todo' }).mood, 'idle');
  assert.deepStrictEqual(m({ status: 'review', orchestrating: true }), { mood: 'work', tool: 'agent' });
});

test('TODO の進み具合: 取りやめは数えず、今の TODO は作業中（なければ次にやるもの）', () => {
  const p = AgentSprite.progressOf([
    { text: 'A', status: 'completed' },
    { text: 'B', status: 'cancelled' },
    { text: 'C', status: 'in_progress' },
    { text: 'D', status: 'pending' },
  ]);
  assert.deepStrictEqual(p, { total: 3, done: 1, cur: 1, statuses: ['completed', 'in_progress', 'pending'], now: 'C', pct: 33 });
  assert.strictEqual(AgentSprite.progressOf([{ text: 'A', status: 'completed' }, { text: 'B', status: 'pending' }]).cur, 1);
  assert.deepStrictEqual(AgentSprite.progressOf(null), { total: 0, done: 0, cur: 0, statuses: [], now: '', pct: 0 });
  assert.strictEqual(AgentSprite.progressOf([{ text: 'A', status: 'completed' }]).pct, 100);
});

test('色: カスタムエージェントの色を優先し、おかしな色は使わない', () => {
  assert.strictEqual(AgentSprite.colorFor('codex'), AgentSprite.AGENT_COLORS.codex);
  assert.strictEqual(AgentSprite.colorFor('nope'), AgentSprite.AGENT_COLORS.claude);
  assert.strictEqual(AgentSprite.colorFor('claude', { color: '#123456' }), '#123456');
  assert.strictEqual(AgentSprite.colorFor('claude', { color: 'red;x' }), AgentSprite.AGENT_COLORS.claude);
  assert.strictEqual(AgentSprite.shade('#000000', 0.5), '#808080');
  assert.strictEqual(AgentSprite.shade('#ffffff', -0.5), '#808080');
});

test('長い文字は幅に収まるように … で切る', () => {
  const ctx = { measureText: (s) => ({ width: s.length * 10 }) };
  assert.strictEqual(AgentSprite.fitText(ctx, 'abc', 100), 'abc');
  assert.strictEqual(AgentSprite.fitText(ctx, 'abcdefghij', 50), 'abcd…');
  assert.strictEqual(AgentSprite.fitText(ctx, 'abc', 0), '');
});

test('画面へのつなぎ: スクリプトを読み込み、カードと進捗タブに Canvas を置き、言葉は4言語ある', () => {
  const html = read('renderer/index.html');
  const order = [...html.matchAll(/<script src="([^"]+)"/g)].map((m) => m[1]);
  assert.ok(order.includes('agent-sprite.js'));
  assert.ok(order.indexOf('agent-sprite.js') < order.indexOf('renderer.js'));
  const src = read('renderer/renderer.js');
  assert.match(src, /showCardSprite\(c\) \? spriteCanvasHtml\(c, 'mini'\)/);
  assert.match(src, /spriteCanvasHtml\(c, 'stage'\)/);
  assert.match(src, /AgentSprite\.start\(/);
  const a = src.indexOf('const SPRITE_LABEL');
  const b = src.indexOf('function showCardSprite');
  const keys = [...src.slice(a, b).matchAll(/\btr\('((?:\\'|[^'])*)'/g)].map((m) => m[1]);
  assert.ok(keys.length >= 16);
  for (const lang of ['en', 'es', 'fr', 'zh']) {
    I18n.setLanguage(lang);
    for (const k of keys) assert.notStrictEqual(I18n.tr(k), k, `${lang}: ${k}`);
  }
  I18n.setLanguage('ja');
});

test('エージェントのログから、いまの作業（ツール・返事）を覚える', () => {
  const src = read('src/agent.js');
  assert.match(src, /if \(kind === 'tool'\) card\.activity = \{ kind: 'tool'/);
  assert.match(src, /else if \(kind === 'text'\) card\.activity = \{ kind: 'text'/);
});

test('カード: スキルの下・ブランチの上に、チャットの一言の代わりにロボットを出す（レビュー・完了でも）', () => {
  const src = read('renderer/renderer.js');
  const a = src.indexOf('function cardHtml(c)');
  const body = src.slice(a, src.indexOf('\n}\n', a));
  const skill = body.indexOf('c.skill ?');
  const sprite = body.indexOf("spriteCanvasHtml(c, 'mini')");
  const branch = body.indexOf('c.branch ?');
  assert.ok(skill < sprite && sprite < branch);
  // チャットの最後の一言は、チャットのカードだけに出す
  assert.match(body, /isChat\(c\) && c\.lastMessage && !waiting \?/);
  assert.doesNotMatch(body, /\$\{c\.lastMessage && !waiting/);
  const f = src.slice(src.indexOf('function showCardSprite'));
  const fn = new Function('isChat', `${f.slice(0, f.indexOf('\n}\n') + 2)}; return showCardSprite;`)((c) => !!c.chat);
  for (const status of ['running', 'queued', 'review', 'done', 'failed']) assert.strictEqual(fn({ status }), true, status);
  assert.strictEqual(fn({ status: 'todo' }), false);
  assert.strictEqual(fn({ status: 'review', chat: true }), false);
});

// ---- キャラクター（作ったときにランダムで決めて、カードに残す） ----
test('randomCharacter: 種類と色を一覧から選ぶ。8種類 × 12色', () => {
  const A = require('../renderer/agent-sprite.js');
  assert.strictEqual(A.CHARACTER_KINDS.length, 8);
  assert.strictEqual(A.CHARACTER_COLORS.length, 12);
  assert.deepStrictEqual(A.randomCharacter(() => 0), { kind: A.CHARACTER_KINDS[0], color: A.CHARACTER_COLORS[0] });
  assert.deepStrictEqual(A.randomCharacter(() => 0.9999999), { kind: A.CHARACTER_KINDS[7], color: A.CHARACTER_COLORS[11] });
  assert.deepStrictEqual(A.randomCharacter(() => 1), { kind: A.CHARACTER_KINDS[7], color: A.CHARACTER_COLORS[11] }, '1 が来ても範囲の外に出ない');
  const seen = new Set();
  for (let i = 0; i < 400; i++) seen.add(A.randomCharacter().kind);
  assert.strictEqual(seen.size, 8, 'どの種類も出る');
});

test('characterFor: character のない前からのタスクは、エージェントの色のロボットのまま', () => {
  const A = require('../renderer/agent-sprite.js');
  assert.deepStrictEqual(A.characterFor({ agent: 'codex' }), { kind: 'robot', color: A.AGENT_COLORS.codex });
  assert.deepStrictEqual(A.characterFor({ agent: 'codex', character: { kind: 'cat', color: '#ec4899' } }), { kind: 'cat', color: '#ec4899' });
  // 知らない種類・色は、ロボット・エージェントの色に戻す
  assert.deepStrictEqual(A.characterFor({ agent: 'claude', character: { kind: 'dragon', color: 'red' } }), { kind: 'robot', color: A.AGENT_COLORS.claude });
  // カスタムエージェントは、選んだ色を使う（種類はランダムのまま）
  assert.deepStrictEqual(A.characterFor({ agent: 'claude', persona: { color: '#123456' }, character: { kind: 'frog', color: '#ec4899' } }), { kind: 'frog', color: '#123456' });
  assert.deepStrictEqual(A.characterFor(), { kind: 'robot', color: A.AGENT_COLORS.claude });
});

test('タスク・枝・サブタスク・会話を作るところで、キャラクターを決めて残す', () => {
  const src = read('src/agent.js');
  const pushes = src.match(/this\.store\.cards\.push\(card\);/g).length;
  assert.strictEqual(src.match(/card\.character = AgentSprite\.randomCharacter\(\);\n {4}this\.store\.cards\.push\(card\);/g).length, pushes);
  // 描くときは card.character を使う
  assert.match(read('renderer/renderer.js'), /AgentSprite\.characterFor\(\{ agent: agentOf\(c\), persona: c\.persona, character: c\.character \}\)/);
});

test('どのキャラクターも、どの様子でも 9 × 11 マスの中に描く', () => {
  const A = require('../renderer/agent-sprite.js');
  const src = read('renderer/agent-sprite.js');
  const body = src.slice(src.indexOf('  const INK ='), src.indexOf('  // 吹き出し（9 × 7 マス'));
  const fn = new Function('shade', 'drawBot', `${body}; return drawCharacter;`)(A.shade, () => {});
  const th = { ok: '#0f0', err: '#f00', warn: '#ff0', run: '#00f', line: '#333', panel: '#111', text: '#eee', muted: '#888', accent: '#55f' };
  for (const kind of A.CHARACTER_KINDS.filter((k) => k !== 'robot')) {
    for (const mood of ['idle', 'queued', 'think', 'work', 'wait', 'done', 'fail']) {
      for (const f of [0, 1, 2, 3, 5, 9]) {
        for (const walking of [false, true]) {
          let n = 0;
          fn((x, y, w, h) => {
            n++;
            assert.ok(x >= 0 && y >= 0 && x + w <= 9 && y + h <= 11, `${kind}/${mood}/${f}: ${x},${y} ${w}x${h}`);
          }, 0, 0, kind, '#4285f4', mood, f, th, { walking });
          assert.ok(n > 5, `${kind} を描いていない`);
        }
      }
    }
  }
});

// ---- 進捗のアニメーションの種類（設定の progressScene） ----
test('sceneFor: 選んだシーンを使う。ランダムはタスクごとに決まり、同じタスクはいつも同じ', () => {
  const A = require('../renderer/agent-sprite.js');
  assert.deepStrictEqual(A.SCENES, ['quest', 'dance', 'garden', 'space']);
  assert.deepStrictEqual(A.SCENE_SETTINGS, ['random', ...A.SCENES]);
  for (const s of A.SCENES) assert.strictEqual(A.sceneFor(s, 'abc'), s);
  assert.strictEqual(A.cleanScene('nope'), 'random');
  assert.strictEqual(A.cleanScene(undefined), 'random');
  assert.strictEqual(A.sceneFor('random', 'task-1'), A.sceneFor('random', 'task-1'));
  assert.strictEqual(A.sceneFor(undefined, 'task-1'), A.sceneFor('random', 'task-1'), '設定がない前からのデータはランダム');
  const seen = new Set();
  for (let i = 0; i < 200; i++) seen.add(A.sceneFor('random', `t${i}`));
  assert.strictEqual(seen.size, A.SCENES.length, 'ランダムでは、どのシーンも出る');
});

test('dancePose: 踊りは左右に 2 マスまで・上に 2 マスまでで、ときどき反転する', () => {
  const A = require('../renderer/agent-sprite.js');
  let flips = 0;
  for (let f = 0; f < 64; f++) {
    const p = A.dancePose(f);
    assert.ok(Math.abs(p.dx) <= 2 && p.dy <= 0 && p.dy >= -2, `${f}`);
    assert.ok(['work', 'done'].includes(p.mood));
    if (p.flip) flips++;
  }
  assert.ok(flips > 0);
});

test('どのシーンも、どの様子でも、カードと進捗タブを描ける（エラーにならない）', () => {
  const A = require('../renderer/agent-sprite.js');
  const src = read('renderer/agent-sprite.js');
  const body = src.slice(src.indexOf('  const HEX ='), src.indexOf('  // ---------- 動かす ----------'));
  const api = new Function(`${body}; return { drawMini, drawStage };`)();
  const ctx = {
    fillRect() {}, clearRect() {}, fillText() {}, measureText: (s) => ({ width: String(s).length * 6 }),
    createLinearGradient: () => ({ addColorStop() {} }),
    set fillStyle(v) {}, set globalAlpha(v) {}, set font(v) {}, set textBaseline(v) {},
  };
  const th = { panel: '#161922', panel2: '#1d212c', line: '#2a2f3c', text: '#e6e8ee', muted: '#8b92a5', accent: '#6d8bff', ok: '#3ccf8e', warn: '#ffb547', err: '#ff6b6b', run: '#4fb8ff' };
  const progress = A.progressOf([{ text: 'a', status: 'completed' }, { text: 'b', status: 'in_progress' }, { text: 'c', status: 'pending' }]);
  for (const scene of [...A.SCENES, 'unknown']) {
    for (const mood of ['idle', 'queued', 'think', 'work', 'wait', 'done', 'fail']) {
      for (const still of [false, true]) {
        for (const p of [progress, A.progressOf([])]) {
          const m = { x: null, lastDone: null, lastMood: null, parts: [] };
          for (let f = 0; f < 30; f++) {
            const info = { mood, tool: mood === 'wait' ? 'review' : 'edit', label: 'x', detail: 'y', progress: p, kind: 'cat', color: '#4285f4', scene, still };
            api.drawStage(ctx, 600, 164, info, m, f, th);
            api.drawMini(ctx, 280, 36, info, { lastDone: null, parts: [] }, f, th);
          }
        }
      }
    }
  }
});

test('設定: 進捗のアニメーションを選べて、ランダムが既定。保存できる項目に入れて、知らない値はランダムに戻す', () => {
  const { DEFAULT_SETTINGS } = require('../src/store.js');
  assert.strictEqual(DEFAULT_SETTINGS.progressScene, 'random');
  const main = read('main.js');
  assert.match(main, /'cycleView', 'progressScene'\]/);
  assert.match(main, /progressScene: require\('\.\/renderer\/agent-sprite'\)\.cleanScene\(patch\.progressScene\)/);
  const src = read('renderer/renderer.js');
  assert.match(src, /id="sProgressScene"/);
  assert.match(src, /\$\('sProgressScene'\)\.value !== AgentSprite\.cleanScene\(s\.progressScene\) \? \{ progressScene:/);
  assert.match(src, /AgentSprite\.sceneFor\(state\.board\.settings && state\.board\.settings\.progressScene, c\.id\)/);
  // 選択肢は SCENE_SETTINGS と同じ並び
  const A = require('../renderer/agent-sprite.js');
  const list = src.slice(src.indexOf('const PROGRESS_SCENES'), src.indexOf('function showCardSprite'));
  assert.deepStrictEqual([...list.matchAll(/\['(\w+)', tr\(/g)].map((m) => m[1]), A.SCENE_SETTINGS);
  for (const lang of ['en', 'es', 'fr', 'zh']) {
    I18n.setLanguage(lang);
    for (const k of [...list.matchAll(/tr\('([^']+)'\)/g)].map((m) => m[1]).concat('進捗のアニメーション')) assert.notStrictEqual(I18n.tr(k), k, `${lang}: ${k}`);
  }
  I18n.setLanguage('ja');
});
