// ボードの列とレーンの説明（自然言語）を、AI に「段階＋条件＋次に進んでよい列」へ変換してもらう。
// 保存はしない（設定画面で結果を確かめてから保存する）。形が正しくなければ、直すところを伝えて1回だけ聞き直す
const BC = require('../renderer/board-columns');
const { tr } = require('../renderer/i18n');

function columnsForPrompt(cfg) {
  return cfg.columns.map((c) => ({
    id: c.id,
    name: c.name,
    description: c.description,
    lanes: c.lanes.length > 1 ? c.lanes.map((l) => ({ id: l.id, name: l.name, description: l.description })) : [],
  }));
}

function buildColumnsPrompt(cfg) {
  return `Worktree Kanban（AI エージェントにタスクを任せるカンバン）のボードの列の設定を、決まった形の JSON に変換してください。
ファイルの変更・コマンドの実行はしないでください。リポジトリを調べる必要もありません。
質問はせず、足りないところは妥当に決めて、返事は JSON だけにしてください（説明の文やコードブロックの印は不要です）。

# 列（左から順。ユーザーが書いた名前と説明）
${JSON.stringify(columnsForPrompt(cfg), null, 2)}

# カードの段階（stage）
アプリがカードの状態から決めます。どの列も、このどれか1つにします。
- todo: まだ開始していない
- running: エージェントが作業中（待機中も含む）
- review: エージェントの作業が終わった（エラーで終わったものも含む）。人が確かめる・マージを待つ
- done: 完了（マージした、またはマージせずに完了にした）
4つの段階それぞれに、少なくとも1つの列が必要です。

# 条件（when）
カードをどの列・レーンに置くかを、次の項目で書きます。書いた項目をすべて満たしたときに合います。書かない項目は見ません。空の {} はいつでも合います。
- failed: true/false（エラーで終わった）
- needsYou: true/false（質問への回答・許可・仕様の確認など、人の対応を待っている）
- merged: true/false（マージ済み。PR のマージも含む）
- manualDone: true/false（マージせずに完了にした）
- hasSubtasks: true/false（サブタスクに分けている）
- reviewComments: true/false（PR にレビューコメントが付いている）
- pr: ["none" | "open" | "merged" | "closed"] のどれか（closed はマージされずに閉じた PR）
- ci: ["none" | "pending" | "success" | "failure"] のどれか（PR の CI の結果）
- agents: [${BC.FACTS.agents.values.map((x) => `"${x}"`).join(' | ')}] のどれか（担当のエージェント）
- titleIncludes: ["語", ...]（タスクのタイトルに、どれかを含む）

カードは、段階が合う列のうち、左から順に見て条件が合う最初の列に入ります（どれにも合わなければ、その段階の最初の列）。
列の中では、上から順に見て条件が合う最初のレーンに入ります（どれにも合わなければ最初のレーン）。
同じ段階の列が2つ以上あるときや、レーンが2つ以上あるときは、説明どおりに分かれるように条件を書いてください。
説明がこの項目で表せないときは、いちばん近い条件にしてください。

# 次に進んでよい列（next）
ユーザーが手でドラッグして動かしてよい、行き先の列の id の一覧です。説明に流れが書いてあればそれに従い、なければ左から右へ進む流れにしてください（完了の列からレビューの段階の列へ戻すのは、ふつうは入れておきます）。
ただし、段階をまたいで手で動かせるのは todo → running、review → done、done → review だけです（それ以外は入れても動かせません）。

# 返事の形
{"columns": [{"id": "列の id", "stage": "todo|running|review|done", "when": {...}, "next": ["列の id", ...], "lanes": [{"id": "レーンの id", "when": {...}}]}]}
列は上と同じ id・同じ順番で、すべて返してください。レーンがない列は "lanes": [] にしてください。`;
}

function buildRepairPrompt(reply, errors) {
  return `\n\n# 前回の返事の直すところ
前回の返事は、次の理由で使えませんでした。直した JSON 全体だけを返してください。
${errors.map((e) => `- ${e}`).join('\n')}

前回の返事:
${String(reply).slice(0, 8000)}`;
}

function parseColumnsReply(text) {
  const s = String(text || '');
  const fenced = [...s.matchAll(/```[^\n]*\n([\s\S]*?)```/g)].map((m) => m[1]);
  const first = s.indexOf('{');
  const last = s.lastIndexOf('}');
  const whole = first >= 0 && last > first ? [s.slice(first, last + 1)] : [];
  for (const body of [...fenced, ...whole]) {
    try {
      const v = JSON.parse(body);
      if (v && typeof v === 'object' && Array.isArray(v.columns)) return v;
    } catch {
      /* 次の候補を見る */
    }
  }
  return null;
}

/**
 * 返事を、ユーザーの列（名前・説明・順番）に当てる。返事にない列・レーンは段階が空・条件なしになる
 * @returns {object} cleanConfig を通した設定
 */
function applyReply(cfg, reply) {
  const byId = new Map(((reply && reply.columns) || []).filter((x) => x && typeof x === 'object').map((x) => [String(x.id), x]));
  return BC.cleanConfig({
    columns: cfg.columns.map((c) => {
      const r = byId.get(c.id) || {};
      const lanesById = new Map((Array.isArray(r.lanes) ? r.lanes : []).filter((x) => x && typeof x === 'object').map((x) => [String(x.id), x]));
      return {
        ...c,
        stage: BC.STAGES.includes(r.stage) ? r.stage : '',
        when: BC.cleanWhen(r.when),
        next: Array.isArray(r.next) ? r.next : [],
        lanes: c.lanes.map((l) => ({ ...l, when: c.lanes.length > 1 ? BC.cleanWhen((lanesById.get(l.id) || {}).when) : {} })),
      };
    }),
  });
}

/**
 * @param {(prompt: string) => Promise<string>} ask エージェントに1回聞く
 * @param {object} draft 画面で書いた列（名前・説明・レーン。段階や条件はなくてよい）
 * @returns {Promise<object>} 段階・条件・次に進んでよい列を入れた設定（保存はしない）
 */
async function convertColumns(ask, draft) {
  const cfg = BC.cleanConfig(draft);
  const errors = BC.validateConfig(cfg, { needStage: false });
  if (errors.length) throw new Error(errors.join('\n'));
  const prompt = buildColumnsPrompt(cfg);
  let reply = await ask(prompt);
  let parsed = parseColumnsReply(reply);
  let next = parsed ? applyReply(cfg, parsed) : null;
  let problems = next ? BC.validateConfig(next) : ['JSON の {"columns": [...]} になっていません'];
  if (problems.length) {
    reply = await ask(prompt + buildRepairPrompt(reply, problems));
    parsed = parseColumnsReply(reply);
    if (parsed) next = applyReply(cfg, parsed);
  }
  if (!next) throw new Error(tr('列の設定の形で返ってきませんでした: {text}', { text: String(reply).trim().slice(0, 200) }));
  return next;
}

module.exports = { buildColumnsPrompt, parseColumnsReply, applyReply, convertColumns };
