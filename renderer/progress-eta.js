// 作業中のタスクの「あとどれくらいでレビュー待ちに行けるか」（進み具合の % と、残りの時間の見込み）
// - 進み具合: エージェントの TODO があればその完了数、なければエージェントが返事に書いた [[PROGRESS:数字]]
// - 残りの時間: ここまでにかかった時間と進み具合から割り出す（10分で50%なら、あと約10分）
// - サブタスクの親・Pipeline は、終わったサブタスク・工程の数と、今動いているものの進み具合を合わせる
// 画面の言葉は持たない（レンダラが tr() で作る）。メインプロセス（印の読み取り）とレンダラ・テストの両方から使う。
(function (root, factory) {
  const api = factory();
  if (typeof module === 'object' && module.exports) module.exports = api;
  else root.ProgressEta = api;
})(typeof self !== 'undefined' ? self : this, function () {
  // エージェントに書いてもらう印（1行。アプリが読み取り、画面には出さない）
  // 行だけの印は行ごと消す。`[[PROGRESS:40]]` のようにバッククォートで囲んだもの（ルールの説明の例）は数えない
  const PROGRESS_RE = /^[ \t]*\[\[PROGRESS:\s*(\d{1,3})\s*%?\s*\]\][ \t]*(?:\r?\n|$)|(?<!`)\[\[PROGRESS:\s*(\d{1,3})\s*%?\s*\]\](?!`)/gm;
  // 見積もりを出すのに要る最低限（始めたばかり・ほとんど進んでいないときは、当てにならないので出さない）
  const MIN_ELAPSED_MS = 30 * 1000;
  const MIN_PCT = 5;

  const clampPct = (n) => Math.max(0, Math.min(100, Math.round(Number(n) || 0)));

  // 返事の文章から印を取り出す。pct は最後に書かれた値（なければ null）、text は印を除いた本文
  function extractProgress(raw) {
    const src = String(raw == null ? '' : raw);
    let pct = null;
    const text = src.replace(PROGRESS_RE, (_, a, b) => {
      pct = clampPct(a != null ? a : b);
      return '';
    });
    return { text: pct == null ? src : text, pct };
  }

  // TODO の完了の割合（取りやめは数えない）。TODO がなければ null
  function todoPct(items) {
    const live = (Array.isArray(items) ? items : []).filter((t) => t && t.status !== 'cancelled');
    if (!live.length) return null;
    const done = live.filter((t) => t.status === 'completed').length;
    // 作業中の TODO は半分進んだとみなす（1つ目の TODO のあいだも少しずつ進むように）
    const half = live.some((t) => t.status === 'in_progress') ? 0.5 : 0;
    return clampPct(((done + half) / live.length) * 100);
  }

  // 前の実行の TODO が、すべて終わったまま残っているか（レビュー待ちのあとに追加指示で続けたなど）
  // そのまま使うと、追加指示の作業を始めたばかりなのに 100%（まもなくレビュー待ち）になってしまう
  // 今回の実行を始めた時刻（追加指示を送って順番を待っているあいだは、送った時刻）
  const runStart = (c) => Math.max(Number(c.startedAt) || 0, Number(c.queuedAt) || 0) || null;
  function staleTodos(c) {
    const todos = c && c.todos && Array.isArray(c.todos.items) ? c.todos : null;
    const start = todos ? runStart(c) : null;
    return !!todos && todoPct(todos.items) === 100 && !!start && !!todos.at && todos.at < start;
  }

  // カード1枚の進み具合 { pct, source: 'todo' | 'report' }。分からなければ null
  // 前の実行の終わった TODO は、今回の実行の進み具合として使わない（今回の報告か、新しい TODO を待つ）
  function cardPct(c) {
    if (!c) return null;
    const todos = c.todos && Array.isArray(c.todos.items) ? c.todos : null;
    const t = todos && !staleTodos(c) ? todoPct(todos.items) : null;
    const rep = c.progressReport && Number.isFinite(Number(c.progressReport.pct)) ? c.progressReport : null;
    if (t != null) return { pct: t, source: 'todo' };
    if (rep) return { pct: clampPct(rep.pct), source: 'report' };
    return null;
  }

  // 残りの時間（ミリ秒）。見積もれないときは null。100% なら 0（もうすぐ）
  function remainingMs(pct, elapsedMs) {
    const p = Number(pct);
    const e = Number(elapsedMs);
    if (!Number.isFinite(p) || !Number.isFinite(e)) return null;
    if (p >= 100) return 0;
    if (p < MIN_PCT || e < MIN_ELAPSED_MS) return null;
    return Math.round((e * (100 - p)) / p);
  }

  const isWorking = (c) => !!c && (c.status === 'running' || c.status === 'queued');

  // 1つのエージェントが作業しているタスク: { pct, source, since, remainingMs }
  function single(c, now) {
    // 追加指示を送って順番を待っているあいだは、まだ始めていない（前の実行の時刻・報告で見積もらない）
    if (c.status === 'queued' && c.queuedAt && !(c.startedAt > c.queuedAt)) return null;
    const p = cardPct(c);
    if (!p) return null;
    const since = c.startedAt || null;
    return { ...p, since, remainingMs: since ? remainingMs(p.pct, now - since) : null };
  }

  // サブタスクの親: 完了（マージ・取り込まずに完了）は 1、動いているものはその進み具合、破棄は数えない
  // getCard(id) でサブタスクのカードを引く
  function subtasks(parent, getCard, now) {
    const st = parent && parent.subtasks;
    if (!st || !Array.isArray(st.items) || !st.items.length) return null;
    const live = st.items.filter((x) => x.state !== 'skipped');
    if (!live.length) return null;
    let sum = 0;
    let since = null;
    for (const x of live) {
      const k = x.cardId ? getCard(x.cardId) : null;
      if (k && (k.createdAt || k.startedAt)) {
        const t = k.createdAt || k.startedAt;
        since = since == null ? t : Math.min(since, t);
      }
      if (x.state === 'merged' || x.state === 'done' || x.state === 'review') sum += 1;
      else if (x.state === 'running' && k) {
        if (k.status === 'review' || k.status === 'done') sum += 1;
        else {
          const p = cardPct(k);
          if (p) sum += p.pct / 100;
        }
      }
    }
    const pct = clampPct((sum / live.length) * 100);
    return { pct, source: 'subtasks', since, remainingMs: since ? remainingMs(pct, now - since) : null };
  }

  // Pipeline: 通った工程の数（同じ工程は1回だけ数える）と、今の工程の進み具合
  // 並列の枝を待っているあいだは、枝の進み具合の平均を今の工程の進み具合にする
  function relay(c, getCard, now) {
    const r = c && c.relay;
    if (!r || !Array.isArray(r.steps) || !r.steps.length) return null;
    const total = r.steps.length;
    const passed = new Set((r.history || []).map((h) => h.index).filter((i) => Number.isInteger(i) && i !== r.index));
    let cur = 0;
    if (r.done) cur = 1;
    else if (r.waiting && Array.isArray(r.waiting.children) && r.waiting.children.length) {
      const kids = r.waiting.children.map((id) => getCard(id)).filter(Boolean);
      const ps = kids.map((k) => (k.status === 'review' || k.status === 'done' ? 1 : (cardPct(k) || { pct: 0 }).pct / 100));
      cur = ps.length ? ps.reduce((a, b) => a + b, 0) / ps.length : 0;
    } else if (isWorking(c)) {
      const p = cardPct(c);
      cur = p ? p.pct / 100 : 0;
    }
    const pct = clampPct((Math.min(total, passed.size + cur) / total) * 100);
    const starts = (r.history || []).map((h) => h.startedAt).filter(Boolean);
    if (r.stepStartedAt) starts.push(r.stepStartedAt);
    const since = starts.length ? Math.min(...starts) : c.startedAt || null;
    return { pct, source: 'relay', since, remainingMs: since ? remainingMs(pct, now - since) : null };
  }

  // タスクの「あとどれくらい」。出さないとき（作業中でない・分からない）は null
  // サブタスクを動かしている親・Pipeline は全体（overall）と、今のエージェントの分（current）を返す
  function estimate(c, getCard, now) {
    if (!c) return null;
    const t = now == null ? Date.now() : now;
    const get = typeof getCard === 'function' ? getCard : () => null;
    if (c.subtasks && c.subtasks.phase === 'run') {
      const overall = subtasks(c, get, t);
      return overall ? { overall, current: isWorking(c) ? single(c, t) : null } : null;
    }
    if (c.relay && (isWorking(c) || (c.relay.waiting && !c.relay.done))) {
      const overall = relay(c, get, t);
      return overall ? { overall, current: isWorking(c) ? single(c, t) : null } : null;
    }
    if (!isWorking(c)) return null;
    const s = single(c, t);
    return s ? { overall: s, current: null } : null;
  }

  return { PROGRESS_RE, MIN_ELAPSED_MS, MIN_PCT, extractProgress, todoPct, staleTodos, cardPct, remainingMs, estimate };
});
