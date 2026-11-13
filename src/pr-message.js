// PR（MR）のタイトルと本文を、リポジトリの PR テンプレートとドキュメントのルールに従って作る。
// テンプレート・ルールのファイルはアプリが探して中身をプロンプトに入れ、エージェントに1回だけ聞いて JSON で返してもらう
const fs = require('fs');
const path = require('path');
const { tr } = require('../renderer/i18n');

// PR テンプレートを探す場所（GitHub・GitLab）。先に見つかったものを使う
const TEMPLATE_FILES = [
  '.github/pull_request_template.md',
  '.github/PULL_REQUEST_TEMPLATE.md',
  'pull_request_template.md',
  'PULL_REQUEST_TEMPLATE.md',
  'docs/pull_request_template.md',
  'docs/PULL_REQUEST_TEMPLATE.md',
  '.gitlab/merge_request_templates/Default.md',
  '.gitlab/merge_request_templates/default.md',
];
// テンプレートが複数あるときのフォルダ（中の .md を名前順に読み、Default・default があればそれを使う）
const TEMPLATE_DIRS = ['.github/PULL_REQUEST_TEMPLATE', '.github/pull_request_template', 'PULL_REQUEST_TEMPLATE', 'docs/PULL_REQUEST_TEMPLATE', '.gitlab/merge_request_templates'];

// PR の書き方のルールが書かれていそうなドキュメント。PR・コミットに触れているものだけを使う
const RULE_FILES = [
  'CONTRIBUTING.md',
  '.github/CONTRIBUTING.md',
  'docs/CONTRIBUTING.md',
  'CLAUDE.md',
  '.claude/CLAUDE.md',
  'AGENTS.md',
  'GEMINI.md',
  '.github/copilot-instructions.md',
  'docs/development.md',
  'docs/DEVELOPMENT.md',
];
const RULE_HINT = /pull[ -]?request|merge[ -]?request|\bPRs?\b|\bMRs?\b|プルリク|マージリクエスト/i;

const TEMPLATE_MAX = 8000;
const RULE_MAX = 6000;
const RULES_TOTAL_MAX = 16000;

function readText(file) {
  try {
    const st = fs.statSync(file);
    if (!st.isFile() || st.size > 512 * 1024) return null;
    return fs.readFileSync(file, 'utf8');
  } catch {
    return null;
  }
}

const clip = (s, n) => (s.length > n ? `${s.slice(0, n)}\n…` : s);

/**
 * リポジトリの PR テンプレートを探す
 * @param {string} dir  worktree（なければリポジトリ）のパス
 * @returns {{ path: string, text: string } | null}  path はリポジトリからの相対パス
 */
function findPrTemplate(dir) {
  if (!dir) return null;
  for (const rel of TEMPLATE_FILES) {
    const text = readText(path.join(dir, rel));
    if (text && text.trim()) return { path: rel, text: clip(text, TEMPLATE_MAX) };
  }
  for (const relDir of TEMPLATE_DIRS) {
    let names;
    try {
      names = fs.readdirSync(path.join(dir, relDir)).filter((n) => /\.md$/i.test(n)).sort();
    } catch {
      continue;
    }
    const pick = names.find((n) => /^default\.md$/i.test(n)) || names[0];
    if (!pick) continue;
    const rel = `${relDir}/${pick}`;
    const text = readText(path.join(dir, rel));
    if (text && text.trim()) return { path: rel, text: clip(text, TEMPLATE_MAX) };
  }
  return null;
}

/**
 * PR の書き方に触れているドキュメントを集める
 * @param {string} dir
 * @returns {{ path: string, text: string }[]}
 */
function findRuleDocs(dir) {
  if (!dir) return [];
  const out = [];
  const seen = new Set();
  let total = 0;
  for (const rel of RULE_FILES) {
    const file = path.join(dir, rel);
    const text = readText(file);
    if (!text || !RULE_HINT.test(text)) continue;
    // 大文字・小文字を区別しないファイルシステムで、同じファイルを2回入れない
    let real = file;
    try {
      real = fs.realpathSync.native(file).toLowerCase();
    } catch {
      /* そのまま */
    }
    if (seen.has(real)) continue;
    seen.add(real);
    const room = RULES_TOTAL_MAX - total;
    if (room < 500) break;
    const body = clip(text, Math.min(RULE_MAX, room));
    total += body.length;
    out.push({ path: rel, text: body });
  }
  return out;
}

/**
 * @param {{ template: {path:string,text:string}|null, docs: {path:string,text:string}[], title: string, prompt?: string,
 *   lastMessage?: string, linkLines?: string[], commits?: string, diffStat?: string, base: string, branch: string }} input
 * @returns {string}
 */
function buildPrPrompt({ template, docs, title, prompt, lastMessage, linkLines = [], commits, diffStat, base, branch }) {
  const parts = [];
  parts.push(`このリポジトリのプルリクエスト（PR）のタイトルと本文を書いてください。
ファイルの変更・コマンドの実行はしないでください。質問はせず、足りないところは下の情報から妥当に決めてください。
返事は次の形の JSON だけにしてください（説明の文やコードブロックの印は不要です）。
{"title": "PR のタイトル", "body": "PR の本文（Markdown）"}

# 守ること
- PR テンプレートがあるときは、その見出し・順番・チェックリストの形をそのまま使い、各欄を中身で埋める。HTML のコメント（<!-- -->）の説明文は、従ったら消す。当てはまらない欄は消さずに「なし」などと書く
- ドキュメントに PR（タイトル・本文・言語・書式・接頭辞など）のルールがあれば従う。コミットや Issue だけのルールは、PR に当てはまるところだけ使う
- 書く言語は、ルールやテンプレートで決まっていればそれに、なければテンプレートと同じ言葉に、テンプレートもなければタスクと同じ言葉にする
- 変更の中身は、下のタスク・作業の結果・コミット・変更したファイルから書く。分からないことは書かない（でっちあげない）`);
  if (linkLines.length) parts.push(`- 本文には、次の行をそのまま入れる（Issue を閉じる・つなぐための行。テンプレートに Issue の欄があればそこに、なければ先頭に）\n${linkLines.map((l) => `  ${l}`).join('\n')}`);
  parts.push(`\n# PR テンプレート\n${template ? `${template.path}\n\`\`\`\`markdown\n${template.text}\n\`\`\`\`` : '（なし）'}`);
  parts.push(`\n# ルールが書かれていそうなドキュメント\n${docs.length ? docs.map((d) => `## ${d.path}\n\`\`\`\`markdown\n${d.text}\n\`\`\`\``).join('\n\n') : '（なし）'}`);
  parts.push(`\n# このタスク\nタイトル: ${title}\nブランチ: ${branch} → ${base}`);
  if (prompt && prompt.trim() && prompt.trim() !== String(title).trim()) parts.push(`\n## 依頼の内容\n${clip(prompt.trim(), 4000)}`);
  if (lastMessage && lastMessage.trim()) parts.push(`\n## エージェントの作業の結果（最後の返事）\n${clip(lastMessage.trim(), 6000)}`);
  if (commits && commits.trim()) parts.push(`\n## コミット\n${clip(commits.trim(), 3000)}`);
  if (diffStat && diffStat.trim()) parts.push(`\n## 変更したファイル\n${clip(diffStat.trim(), 3000)}`);
  return parts.join('\n');
}

/**
 * 返事の文章から { title, body } を取り出す（コードブロックや前後の文があってもよい）
 * @param {string} text
 * @returns {{ title: string, body: string } | null}
 */
function parsePrReply(text) {
  const s = String(text || '');
  const tryParse = (t) => {
    try {
      const o = JSON.parse(t);
      if (o && typeof o === 'object' && typeof o.body === 'string' && o.body.trim()) {
        return { title: typeof o.title === 'string' ? o.title.trim().split('\n')[0] : '', body: o.body.replace(/\s+$/, '') };
      }
    } catch {
      /* 次を試す */
    }
    return null;
  };
  const fence = s.match(/```(?:json)?\s*\n([\s\S]*?)\n```/);
  if (fence) {
    const r = tryParse(fence[1].trim());
    if (r) return r;
  }
  const a = s.indexOf('{');
  const b = s.lastIndexOf('}');
  if (a >= 0 && b > a) return tryParse(s.slice(a, b + 1));
  return null;
}

/**
 * Issue を閉じる・つなぐ行が本文から抜けていたら、先頭に足す
 * @param {string} body
 * @param {string[]} linkLines
 */
function ensureLinkLines(body, linkLines = []) {
  // 「Closes #1」が「Closes #12」の一部として見つかったことにしない
  const has = (l) => new RegExp(`${l.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}(?![\\w-])`).test(body);
  const missing = linkLines.filter((l) => l && !has(l));
  return missing.length ? `${missing.join('\n')}\n\n${body}` : body;
}

/**
 * エージェントに聞いて、PR のタイトルと本文を作る
 * @param {(prompt: string) => Promise<string>} ask
 * @param {Parameters<typeof buildPrPrompt>[0]} input
 * @returns {Promise<{ title: string, body: string }>}
 */
async function draftPullRequest(ask, input) {
  const reply = await ask(buildPrPrompt(input));
  const r = parsePrReply(reply);
  if (!r) throw new Error(tr('PR の本文が返ってきませんでした'));
  return { title: r.title || input.title, body: ensureLinkLines(r.body, input.linkLines) };
}

module.exports = { findPrTemplate, findRuleDocs, buildPrPrompt, parsePrReply, ensureLinkLines, draftPullRequest, TEMPLATE_FILES, RULE_FILES };
