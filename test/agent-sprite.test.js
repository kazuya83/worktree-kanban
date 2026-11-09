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
  assert.strictEqual(m({ status: 'review' }).mood, 'done');
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
