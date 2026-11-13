// PR のタイトルと本文を、リポジトリの PR テンプレートとドキュメントのルールに従って作る
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const PrMessage = require('../src/pr-message');

function tmpRepo(files) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'pr-message-'));
  for (const [rel, text] of Object.entries(files)) {
    fs.mkdirSync(path.dirname(path.join(dir, rel)), { recursive: true });
    fs.writeFileSync(path.join(dir, rel), text);
  }
  return dir;
}

test('PR テンプレートは決まった場所から探し、フォルダに複数あれば Default を使う', () => {
  assert.strictEqual(PrMessage.findPrTemplate(tmpRepo({ 'README.md': 'x' })), null);
  assert.strictEqual(PrMessage.findPrTemplate(''), null);
  const one = PrMessage.findPrTemplate(tmpRepo({ '.github/pull_request_template.md': '## Summary\n' }));
  assert.deepStrictEqual(one, { path: '.github/pull_request_template.md', text: '## Summary\n' });
  const multi = PrMessage.findPrTemplate(tmpRepo({ '.gitlab/merge_request_templates/Bug.md': 'bug', '.gitlab/merge_request_templates/Default.md': 'def' }));
  assert.strictEqual(multi.text, 'def');
  const first = PrMessage.findPrTemplate(tmpRepo({ '.github/PULL_REQUEST_TEMPLATE/b.md': 'b', '.github/PULL_REQUEST_TEMPLATE/a.md': 'a' }));
  assert.strictEqual(first.text, 'a');
  // 空のテンプレートは使わない
  assert.strictEqual(PrMessage.findPrTemplate(tmpRepo({ '.github/pull_request_template.md': '  \n' })), null);
});

test('ルールのドキュメントは、PR に触れているものだけを集める', () => {
  const dir = tmpRepo({
    'CONTRIBUTING.md': 'Open a pull request against main.',
    'CLAUDE.md': 'Use 2 spaces.',
    'AGENTS.md': 'PR のタイトルは日本語で書く',
    'docs/development.md': 'MR titles must start with feat:',
  });
  assert.deepStrictEqual(PrMessage.findRuleDocs(dir).map((d) => d.path), ['CONTRIBUTING.md', 'AGENTS.md', 'docs/development.md']);
  assert.deepStrictEqual(PrMessage.findRuleDocs(tmpRepo({ 'README.md': 'pull request' })), []);
});

test('プロンプトにテンプレート・ルール・Issue の行・作業の結果が入る', () => {
  const p = PrMessage.buildPrPrompt({
    template: { path: '.github/pull_request_template.md', text: '## 概要\n<!-- 何をしたか -->' },
    docs: [{ path: 'CONTRIBUTING.md', text: 'PR title: feat: ...' }],
    title: 'ログイン',
    prompt: 'ログイン画面を作る',
    lastMessage: '画面を作りました',
    linkLines: ['Closes #12'],
    commits: 'agent: ログイン',
    diffStat: ' src/login.js | 10 +',
    base: 'main',
    branch: 'agent/x',
  });
  for (const s of ['## 概要', 'PR title: feat:', 'Closes #12', 'ログイン画面を作る', '画面を作りました', 'src/login.js', 'agent/x → main', '"title"']) assert.ok(p.includes(s), s);
  const none = PrMessage.buildPrPrompt({ template: null, docs: [], title: 't', base: 'main', branch: 'b' });
  assert.ok(none.includes('（なし）'));
  assert.ok(!none.includes('Closes'));
});

test('返事の JSON を取り出す（コードブロック・前後の文があってもよい）', () => {
  assert.deepStrictEqual(PrMessage.parsePrReply('{"title":"feat: x","body":"## Summary\\nok\\n"}'), { title: 'feat: x', body: '## Summary\nok' });
  assert.deepStrictEqual(PrMessage.parsePrReply('書きました\n```json\n{"title":"t","body":"b"}\n```\n以上'), { title: 't', body: 'b' });
  assert.deepStrictEqual(PrMessage.parsePrReply('{"body":"b"}'), { title: '', body: 'b' });
  assert.strictEqual(PrMessage.parsePrReply('ごめんなさい'), null);
  assert.strictEqual(PrMessage.parsePrReply('{"title":"t","body":"  "}'), null);
  assert.strictEqual(PrMessage.parsePrReply(''), null);
});

test('Issue の行が抜けていたら先頭に足し、入っていればそのまま', async () => {
  assert.strictEqual(PrMessage.ensureLinkLines('## 概要\nCloses #1', ['Closes #1']), '## 概要\nCloses #1');
  assert.strictEqual(PrMessage.ensureLinkLines('## 概要', ['Closes #1', 'Closes #2']), 'Closes #1\nCloses #2\n\n## 概要');
  const r = await PrMessage.draftPullRequest(async () => '{"title":"","body":"## 概要"}', { template: null, docs: [], title: 'ログイン', linkLines: ['Closes #1'], base: 'main', branch: 'b' });
  assert.deepStrictEqual(r, { title: 'ログイン', body: 'Closes #1\n\n## 概要' });
  await assert.rejects(PrMessage.draftPullRequest(async () => 'no', { template: null, docs: [], title: 't', base: 'main', branch: 'b' }));
});

test('「Closes #1」は「Closes #12」があっても足す', () => {
  assert.strictEqual(PrMessage.ensureLinkLines('Closes #12', ['Closes #1']), 'Closes #1\n\nCloses #12');
  assert.strictEqual(PrMessage.ensureLinkLines('- Closes #1.', ['Closes #1']), '- Closes #1.');
});
