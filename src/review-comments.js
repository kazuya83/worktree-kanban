// PR / MR のレビューコメント: GitHub と GitLab の応答を同じ形にそろえる・まだ扱っていないものを選ぶ・返信の文を作る。
//
// 1件（item）の形:
//   { key, kind: 'thread'|'review'|'comment', id, author, url, path, line, outdated, at, comments: [{ author, body }] }
//   - thread: 行コメントのスレッド（解決していないものだけ）。id はスレッド（GitLab はディスカッション）の ID。返信して解決できる
//   - review: GitHub のレビューの本文（変更の要求・コメント）
//   - comment: PR の会話欄のコメント（GitLab はスレッドにしていないノート）
//   key は「扱ったか」を覚えるための値。スレッドに新しい返信が付いたら key が変わり、もう一度扱う
const { tr } = require('../renderer/i18n');

// アプリが書いた返信に入れる印。これが入ったコメントは取り込まない（直しては返信する、を繰り返さないように）
const MARKER = '<!-- worktree-kanban:review-fix -->';
const BODY_MAX = 4000; // 1件の本文の上限（bot の長い要約で指示がふくらみすぎないように）
const SUMMARY_MAX = 3000;

const clip = (s, max = BODY_MAX) => {
  const t = String(s || '').trim();
  return t.length > max ? `${t.slice(0, max)}…` : t;
};
const hasMarker = (body) => String(body || '').includes(MARKER);
const latest = (...xs) => xs.filter(Boolean).sort().at(-1) || null;

/**
 * gh api graphql の pullRequest を item の配列にする
 * @param {object} pr reviewThreads / reviews / comments を持つ
 */
function fromGithub(pr) {
  const out = [];
  const login = (a) => (a && a.login) || 'ghost';
  for (const t of (pr && pr.reviewThreads && pr.reviewThreads.nodes) || []) {
    if (!t || t.isResolved) continue;
    const cs = ((t.comments && t.comments.nodes) || []).filter((x) => x && String(x.body || '').trim());
    const last = cs.at(-1);
    // 最後がアプリの返信なら、もう返信してある（解決だけできなかった）
    if (!last || hasMarker(last.body)) continue;
    out.push({
      key: `t:${t.id}:${last.id}`,
      kind: 'thread',
      id: t.id,
      author: login(cs[0].author),
      url: cs[0].url || null,
      path: t.path || null,
      line: t.line ?? t.originalLine ?? null,
      outdated: !!t.isOutdated,
      at: latest(...cs.map((x) => x.createdAt)),
      comments: cs.filter((x) => !hasMarker(x.body)).map((x) => ({ author: login(x.author), body: clip(x.body) })),
    });
  }
  for (const r of (pr && pr.reviews && pr.reviews.nodes) || []) {
    if (!r || !['CHANGES_REQUESTED', 'COMMENTED'].includes(r.state)) continue;
    if (!String(r.body || '').trim() || hasMarker(r.body)) continue;
    out.push({ key: `r:${r.id}`, kind: 'review', id: r.id, author: login(r.author), url: r.url || null, path: null, line: null, outdated: false, changesRequested: r.state === 'CHANGES_REQUESTED', at: r.submittedAt || null, comments: [{ author: login(r.author), body: clip(r.body) }] });
  }
  for (const x of (pr && pr.comments && pr.comments.nodes) || []) {
    if (!x || !String(x.body || '').trim() || hasMarker(x.body)) continue;
    out.push({ key: `c:${x.id}`, kind: 'comment', id: x.id, author: login(x.author), url: x.url || null, path: null, line: null, outdated: false, at: x.createdAt || null, comments: [{ author: login(x.author), body: clip(x.body) }] });
  }
  return out;
}

/**
 * GitLab の MR のディスカッションを item の配列にする
 * @param {Array<object>} discussions GET /merge_requests/:iid/discussions の結果
 * @param {string} mrUrl MR の Web の URL（ノートへのリンクを作る）
 */
function fromGitlab(discussions, mrUrl) {
  const out = [];
  const user = (a) => (a && a.username) || 'ghost';
  const link = (n) => (mrUrl ? `${mrUrl}#note_${n.id}` : null);
  for (const d of discussions || []) {
    const notes = ((d && d.notes) || []).filter((n) => n && !n.system && String(n.body || '').trim());
    const last = notes.at(-1);
    if (!last || hasMarker(last.body)) continue;
    const first = notes[0];
    const resolvable = notes.some((n) => n.resolvable);
    const at = latest(...notes.map((n) => n.created_at));
    const comments = notes.filter((n) => !hasMarker(n.body)).map((n) => ({ author: user(n.author), body: clip(n.body) }));
    if (resolvable) {
      if (!notes.some((n) => n.resolvable && !n.resolved)) continue;
      const pos = first.position || {};
      out.push({ key: `t:${d.id}:${last.id}`, kind: 'thread', id: d.id, author: user(first.author), url: link(first), path: pos.new_path || pos.old_path || null, line: pos.new_line ?? pos.old_line ?? null, outdated: false, at, comments });
    } else {
      out.push({ key: `c:${d.id}:${last.id}`, kind: 'comment', id: d.id, author: user(first.author), url: link(first), path: null, line: null, outdated: false, at, comments });
    }
  }
  return out;
}

/** まだ扱っていないものだけを選ぶ */
function pendingOf(items, handled) {
  const h = handled || {};
  return (items || []).filter((i) => i && i.key && !h[i.key]);
}

// 指示の見出し（エージェントに渡す文なので訳さない）
function headingOf(i) {
  if (i.kind === 'thread') return `行コメント${i.path ? ` \`${i.path}${i.line ? `:${i.line}` : ''}\`` : ''}（${i.author}）${i.outdated ? '［古い行へのコメント］' : ''}`;
  if (i.kind === 'review') return `レビュー（${i.author}${i.changesRequested ? '・変更の要求' : ''}）`;
  return `会話欄のコメント（${i.author}）`;
}

/**
 * エージェントに直してもらう指示
 * @param {{ url: string, noun: string, gitlab?: boolean }} pr noun: 'PR' / 'MR'
 */
function buildFixPrompt(pr, items) {
  const lines = [`この ${pr.noun}（${pr.url}）にレビューコメントが付きました。内容を読んで、必要なところを直してください。`, ''];
  items.forEach((i, n) => {
    lines.push(`## ${n + 1}. ${headingOf(i)}`);
    if (i.url) lines.push(i.url);
    for (const [k, c] of i.comments.entries()) {
      if (k > 0) lines.push(`返信（${c.author}）:`);
      lines.push(...c.body.split('\n').map((l) => `> ${l}`));
    }
    lines.push('');
  });
  lines.push(
    '- 指摘ごとに、直すべきかを判断してください。指摘が誤っている・対応がいらないときは、変更せずにその理由を書いてください',
    '- bot（CodeRabbit・Copilot など）のコメントも同じように扱ってください。ただの要約やあいさつには対応しなくてかまいません',
    '- 直したらテストを実行して確かめてください。コミット・push・レビューへの返信はアプリが行うので、しなくてかまいません',
    '- 最後に、指摘ごとに（番号で）どう対応したかを短くまとめてください。このまとめはレビューへの返信に使います',
  );
  return lines.join('\n');
}

/** 行コメントのスレッドに付ける返信 */
function threadReply(sha) {
  return `${tr('直しました（{sha}）。', { sha: String(sha).slice(0, 7) })}\n\n${MARKER}`;
}

/** 会話欄のコメント・レビューの本文に、まとめて付ける返信 */
function summaryReply(sha, items, summary) {
  const refs = items.map((i) => `- ${i.url ? `[${i.author}](${i.url})` : i.author}`);
  const lines = [tr('レビューコメントに対応しました（{sha}）。', { sha: String(sha).slice(0, 7) }), '', ...refs];
  const s = clip(summary, SUMMARY_MAX);
  if (s) lines.push('', s);
  lines.push('', MARKER);
  return lines.join('\n');
}

module.exports = { MARKER, fromGithub, fromGitlab, pendingOf, buildFixPrompt, threadReply, summaryReply };
