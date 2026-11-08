// タスクのログを、チャットの形の項目に並べる（スマホ用。デスクトップの詳細の「ログ」「チャット」タブと同じ並べ方）。
// - あなたの指示は右の吹き出し、エージェントの返事は左（返事のまとまりの最初だけ名前を出す）
// - ツールの呼び出しと、その結果は1つの折りたたみにまとめる
// - システムのお知らせ・完了・エラーなどは、会話の間に小さく挟む
// DOM には触らない。画面（<script>）とテスト（require）の両方から使う。
(function (root, factory) {
  const api = factory();
  if (typeof module === 'object' && module.exports) module.exports = api;
  else root.MobileChat = api;
})(typeof globalThis !== 'undefined' ? globalThis : this, function () {
  const RESULT_KINDS = new Set(['tool_result', 'tool_error']);
  const agentSide = (it) => !!it && (it.type === 'assistant' || it.type === 'tool');

  // 末尾から続いているエージェント側のまとまりで、最後に分かっているエージェント（分からなければ null）
  function runAgentOf(items) {
    for (let i = items.length - 1; i >= 0 && agentSide(items[i]); i--) if (items[i].known) return items[i].agent;
    return null;
  }

  /**
   * ログを1件足す。
   * @returns {{ op: 'append' | 'replace', item: object }} replace は末尾の項目（ツールの呼び出し）に結果が入ったとき
   */
  function push(items, entry, defaultAgent) {
    if (!entry || typeof entry !== 'object') return null;
    const last = items[items.length - 1];
    const runAgent = agentSide(last) ? runAgentOf(items) : null;
    // まとまりの最初か、途中でエージェントが替わったとき（Pipeline）だけ名前を出す
    const head = (agent) => !agentSide(last) || (!!agent && runAgent !== null && runAgent !== agent);
    if (RESULT_KINDS.has(entry.kind)) {
      if (last && last.type === 'tool' && !last.result) {
        last.result = entry;
        return { op: 'replace', item: last };
      }
      const item = { type: 'tool', entry: null, result: entry, agent: runAgent || defaultAgent || '', known: false, head: head(null) };
      items.push(item);
      return { op: 'append', item };
    }
    let item;
    if (entry.kind === 'user') item = { type: 'user', entry };
    else if (entry.kind === 'text') {
      // agent の無い返事は Claude のもの
      const agent = entry.agent || 'claude';
      item = { type: 'assistant', entry, agent, known: true, head: head(agent) };
    } else if (entry.kind === 'tool') {
      const agent = entry.agent || runAgent || defaultAgent || '';
      item = { type: 'tool', entry, result: null, agent, known: !!entry.agent, head: head(entry.agent || null) };
    } else item = { type: 'notice', entry };
    items.push(item);
    return { op: 'append', item };
  }

  function build(logs, defaultAgent) {
    const items = [];
    for (const e of Array.isArray(logs) ? logs : []) push(items, e, defaultAgent);
    return items;
  }

  // 「チャット」: 指示（と回答）・途中の質問・エラーと、それぞれの指示に対する最後の返事だけ。
  // 実行中は、まだ途中の返事かもしれないので、確定するまで出さない
  const FINAL_STOPS = new Set(['user', 'question', 'result', 'error']);
  function final(logs, defaultAgent, running) {
    const items = [];
    let pending = null;
    const flush = () => {
      if (!pending) return;
      items.push({ type: 'assistant', entry: pending, agent: pending.agent || 'claude', known: true, head: true });
      pending = null;
    };
    for (const e of Array.isArray(logs) ? logs : []) {
      if (!e || typeof e !== 'object') continue;
      if (e.kind === 'text') pending = e;
      else if (FINAL_STOPS.has(e.kind)) {
        flush();
        if (e.kind === 'user') items.push({ type: 'user', entry: e });
        else if (e.kind !== 'result') items.push({ type: 'notice', entry: e });
      }
    }
    if (!running) flush();
    return items;
  }

  // ツールの呼び出し「名前  引数の要約」を、名前と引数に分ける
  function splitTool(text) {
    const t = String(text || '');
    const i = t.indexOf('  ');
    return i < 0 ? [t, ''] : [t.slice(0, i), t.slice(i + 2)];
  }

  return { build, push, final, splitTool };
});
