// PR / MR のレビューコメント: 応答をそろえる・扱ったものを除く・指示と返信の文・gh の呼び方
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const RC = require('../src/review-comments');

const ghComment = (id, login, body, at = '2026-11-01T00:00:00Z') => ({ id, body, createdAt: at, url: `https://github.com/o/r/pull/9#c-${id}`, author: { login } });

function githubPr() {
  return {
    reviewThreads: {
      nodes: [
        { id: 'T1', isResolved: false, isOutdated: false, path: 'src/a.js', line: 12, comments: { nodes: [ghComment('a1', 'alice', 'null を見て'), ghComment('a2', 'coderabbitai[bot]', '同意します', '2026-11-02T00:00:00Z')] } },
        { id: 'T2', isResolved: true, path: 'src/b.js', line: 3, comments: { nodes: [ghComment('b1', 'bob', '解決済み')] } },
        // 最後がアプリの返信: もう返信してある（解決だけできなかった）
        { id: 'T3', isResolved: false, path: 'src/c.js', line: null, originalLine: 7, comments: { nodes: [ghComment('c1', 'bob', '直して'), ghComment('c2', 'me', `直しました\n${RC.MARKER}`)] } },
      ],
    },
    reviews: {
      nodes: [
        { id: 'R1', state: 'CHANGES_REQUESTED', body: 'テストを足してください', submittedAt: '2026-11-01T00:00:00Z', url: 'https://github.com/o/r/pull/9#r1', author: { login: 'carol' } },
        { id: 'R2', state: 'APPROVED', body: 'LGTM', author: { login: 'dave' } },
        { id: 'R3', state: 'COMMENTED', body: '', author: { login: 'alice' } },
      ],
    },
    comments: { nodes: [ghComment('C1', 'erin', '名前を変えては？'), ghComment('C2', 'me', `対応しました\n${RC.MARKER}`), ghComment('C3', 'x', '   ')] },
  };
}

test('GitHub: 解決していないスレッド・変更の要求・会話欄のコメントだけを取り込む。アプリの返信は除く', () => {
  const items = RC.fromGithub(githubPr());
  assert.deepStrictEqual(items.map((i) => i.key), ['t:T1:a2', 'r:R1', 'c:C1']);
  const t = items[0];
  assert.strictEqual(t.kind, 'thread');
  assert.strictEqual(t.path, 'src/a.js');
  assert.strictEqual(t.line, 12);
  assert.strictEqual(t.at, '2026-11-02T00:00:00Z');
  assert.deepStrictEqual(t.comments.map((c) => c.author), ['alice', 'coderabbitai[bot]'], 'bot のコメントも入れる');
  assert.ok(items[1].changesRequested);
  assert.deepStrictEqual(RC.fromGithub(null), []);
});

test('GitLab: 未解決のディスカッションはスレッド、ふつうのノートは会話欄。システムノートとアプリの返信は除く', () => {
  const note = (id, username, body, extra = {}) => ({ id, body, author: { username }, created_at: '2026-11-01T00:00:00Z', ...extra });
  const discussions = [
    { id: 'd1', notes: [note(1, 'alice', 'ここ', { resolvable: true, resolved: false, position: { new_path: 'a.rb', new_line: 4 } }), note(2, 'bob', '同じく', { resolvable: true, resolved: false })] },
    { id: 'd2', notes: [note(3, 'alice', '済み', { resolvable: true, resolved: true })] },
    { id: 'd3', individual_note: true, notes: [note(4, 'carol', '全体的に')] },
    { id: 'd4', individual_note: true, notes: [note(5, 'ghost', 'added 1 commit', { system: true })] },
    { id: 'd5', notes: [note(6, 'alice', '直して', { resolvable: true, resolved: false }), note(7, 'me', `直しました ${RC.MARKER}`, { resolvable: true, resolved: false })] },
  ];
  const items = RC.fromGitlab(discussions, 'https://gl/g/p/-/merge_requests/5');
  assert.deepStrictEqual(items.map((i) => [i.key, i.kind]), [['t:d1:2', 'thread'], ['c:d3:4', 'comment']]);
  assert.strictEqual(items[0].url, 'https://gl/g/p/-/merge_requests/5#note_1');
  assert.strictEqual(items[0].path, 'a.rb');
  assert.strictEqual(items[0].line, 4);
});

test('扱ったものは除く。スレッドに新しい返信が付いたら、もう一度扱う', () => {
  const items = RC.fromGithub(githubPr());
  assert.deepStrictEqual(RC.pendingOf(items, { 't:T1:a2': true, 'c:C1': true }).map((i) => i.key), ['r:R1']);
  const pr = githubPr();
  pr.reviewThreads.nodes[0].comments.nodes.push(ghComment('a3', 'alice', 'まだです'));
  assert.deepStrictEqual(RC.pendingOf(RC.fromGithub(pr), { 't:T1:a2': true }).map((i) => i.key)[0], 't:T1:a3');
});

test('指示には番号・場所・引用を入れ、返信には印を入れる', () => {
  const items = RC.fromGithub(githubPr());
  const p = RC.buildFixPrompt({ url: 'https://github.com/o/r/pull/9', noun: 'PR' }, items);
  assert.match(p, /この PR（https:\/\/github.com\/o\/r\/pull\/9）/);
  assert.match(p, /## 1\. 行コメント `src\/a\.js:12`（alice）/);
  assert.match(p, /> null を見て\n返信（coderabbitai\[bot\]）:\n> 同意します/);
  assert.match(p, /## 2\. レビュー（carol・変更の要求）/);
  assert.match(p, /## 3\. 会話欄のコメント（erin）/);
  assert.ok(RC.threadReply('abcdef123').includes('abcdef1'));
  assert.ok(RC.threadReply('abc').endsWith(RC.MARKER));
  const s = RC.summaryReply('abcdef123', items.slice(1), 'まとめ');
  assert.match(s, /\[carol\]\(https:\/\/github.com\/o\/r\/pull\/9#r1\)/);
  assert.match(s, /まとめ/);
  assert.ok(s.endsWith(RC.MARKER));
});

test('gh: graphql で読み、スレッドに返信して解決し、会話欄にまとめて返信する', async () => {
  const gh = require('../src/gh');
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'wk-review-'));
  const logFile = path.join(tmp, 'calls.jsonl');
  const fake = path.join(tmp, 'gh.js');
  fs.writeFileSync(
    fake,
    `const fs = require('fs');
const args = process.argv.slice(2);
fs.appendFileSync(${JSON.stringify(logFile)}, JSON.stringify(args) + '\\n');
const q = (args.find((a) => a.startsWith('query=')) || '').slice(6);
if (args[0] === 'pr' && args[1] === 'comment') process.exit(0);
if (/resolveReviewThread/.test(q) && args.includes('id=T9')) { console.log(JSON.stringify({ errors: [{ message: 'no permission' }] })); process.exit(0); }
if (/mutation/.test(q)) { console.log(JSON.stringify({ data: {} })); process.exit(0); }
console.log(JSON.stringify({ data: { repository: { pullRequest: ${JSON.stringify(githubPr())} } } }));
`,
  );
  const bin = path.join(tmp, 'gh');
  fs.writeFileSync(bin, `#!/bin/sh\nexec "${process.execPath}" "${fake}" "$@"\n`, { mode: 0o755 });
  const url = 'https://ghe.example.com/o/r/pull/9';
  const { items } = await gh.pullRequestComments({ url, gh: bin });
  assert.strictEqual(items.length, 3);
  const r = await gh.replyPullRequestComments({ url, gh: bin, threads: [{ id: 'T1', body: 'ok' }, { id: 'T9', body: 'ok' }], comment: 'まとめ' });
  assert.deepStrictEqual(r, { replied: 2, resolved: 1, commented: true, errors: ['no permission'] });
  const calls = fs.readFileSync(logFile, 'utf8').trim().split('\n').map((l) => JSON.parse(l));
  assert.deepStrictEqual(calls[0].slice(0, 4), ['api', 'graphql', '--hostname', 'ghe.example.com'], 'GitHub Enterprise のホストに聞く');
  assert.ok(calls[0].includes('number=9') && calls[0][calls[0].indexOf('number=9') - 1] === '-F', '番号は数で渡す');
  assert.deepStrictEqual(calls.at(-1), ['pr', 'comment', url, '--body', 'まとめ']);
  await assert.rejects(gh.pullRequestComments({ url: 'https://github.com/o/r/issues/1', gh: bin }), /PR の URL として読めません/);
});
