// 修正タスクの案: 完了したタスクについての会話で、エージェントが「修正が必要」と判断したときに、
// 返事のいちばん最後に ```fix-task のブロック（JSON）で、修正タスクのタイトルと指示を書いてもらう。
// アプリはブロックを画面に出さずにカードに覚えておき（c.fixTaskProposal = { title, prompt, at }）、
// チャットの最後の「修正タスクを作る」ボタンで、その内容のままカードを作る

const FIX_TASK_LANG = 'fix-task';
const FIX_TASK_BLOCK_RE = new RegExp('\\n?[ \\t]*```[ \\t]*' + FIX_TASK_LANG + '[ \\t]*\\r?\\n([\\s\\S]*?)\\r?\\n[ \\t]*```[ \\t]*', 'g');

function truncate(s, n) {
  s = String(s ?? '');
  return s.length > n ? `${s.slice(0, n)}…` : s;
}

/**
 * ブロックの JSON を読んで整える（読めない・中身がないときは null）
 * @returns {{ title: string, prompt: string } | null}
 */
function parseProposal(json) {
  let v;
  try {
    v = JSON.parse(String(json || '').trim());
  } catch {
    return null;
  }
  if (Array.isArray(v)) v = v[0];
  if (!v || typeof v !== 'object') return null;
  const title = truncate(String(v.title || '').trim(), 120);
  const prompt = truncate(String(v.prompt || '').trim(), 20000);
  if (!prompt) return null;
  return { title, prompt };
}

/**
 * 返事の文章から ```fix-task のブロックを取り出す（ブロックは本文から消す）
 * @returns {{ text: string, proposal: { title: string, prompt: string } | null }}
 */
function extractFixTask(raw) {
  const src = String(raw || '');
  let proposal = null;
  let found = false;
  const body = src.replace(FIX_TASK_BLOCK_RE, (_, json) => {
    found = true;
    proposal = parseProposal(json) || proposal;
    return '';
  });
  return { text: found ? body.replace(/\s+$/, '') : src, proposal };
}

// 完了したタスクについての会話の指示に足す（修正の案をボタンにするため）
const FIX_TASK_NOTE = [
  `- 修正や追加の作業が必要なときは、返事のいちばん最後に \`\`\`${FIX_TASK_LANG} のコードブロックで、修正タスクの内容を JSON で付けてください（ユーザーには表示されません。チャットに「修正タスクを作る」ボタンが出て、押すとこの内容でタスクを作ります）`,
  '  形: {"title": "短いタイトル", "prompt": "修正タスクのエージェントへの指示（何をどう直すか、どうなれば完了か。これだけ読んで作業できるように）"}',
  '- 修正が要らない返事（質問への答えだけなど）には、このブロックを付けないでください',
].join('\n');

module.exports = { FIX_TASK_LANG, FIX_TASK_NOTE, extractFixTask, parseProposal };
