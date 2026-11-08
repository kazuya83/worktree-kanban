// スプリント（期間とゴールを持つ、タスクのまとまり。プロジェクト＝リポジトリごと）の形・確かめ方・絞り込み方。
// レンダラ（<script> で読み込む。ボードの絞り込み・スイムレーン）と、アプリ本体（require。保存・IPC）の両方から使う。
//
// スプリント: {
//   id, repoPath,
//   name,                 名前（必須）
//   startDate, endDate,   期間（'YYYY-MM-DD'。どちらも空でよい）
//   goal,                 ゴールのメモ
//   done,                 完了にしたか（完了したスプリントは、ふだんは一覧に出さない）
//   createdAt, updatedAt, doneAt
// }
// タスク（カード）は cycleIds（スプリントの ID の配列。いくつでも）を持つ。
// サブタスクと Pipeline の並列の枝のカードは、自分の cycleIds がなければ親のスプリントに入る
(function (root, factory) {
  const api = factory();
  if (typeof module === 'object' && module.exports) module.exports = api;
  else root.CycleModel = api;
})(typeof self !== 'undefined' ? self : this, function () {
  const i18n = typeof module === 'object' && module.exports ? require('./i18n.js') : typeof I18n !== 'undefined' ? I18n : null;
  function tr(key, vars) {
    if (i18n) return i18n.tr(key, vars);
    return vars ? String(key).replace(/\{(\w+)\}/g, (m, k) => (k in vars ? String(vars[k]) : m)) : key;
  }

  const NAME_MAX = 60;
  const GOAL_MAX = 2000;
  const MAX_CYCLES = 500; // 全プロジェクトの合計
  const VIEWS = ['top', 'sidebar', 'lanes']; // ボードの上のタブ / 左のサイドバー / 列の中をスプリントごとの段に分ける
  const DEFAULT_VIEW = 'top';
  const ALL = 'all'; // すべてのタスク
  const NONE = 'none'; // どのスプリントにも入っていないタスク

  const str = (v) => (typeof v === 'string' ? v : v == null ? '' : String(v));

  // 'YYYY-MM-DD'（実在する日付）だけを残す。それ以外は空
  function cleanDate(v) {
    const s = str(v).trim();
    const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(s);
    if (!m) return '';
    const d = new Date(Date.UTC(+m[1], +m[2] - 1, +m[3]));
    return d.getUTCFullYear() === +m[1] && d.getUTCMonth() === +m[2] - 1 && d.getUTCDate() === +m[3] ? s : '';
  }

  function cleanName(v) {
    return str(v).replace(/\s+/g, ' ').trim().slice(0, NAME_MAX);
  }

  function cleanGoal(v) {
    return str(v).replace(/\r\n?/g, '\n').trim().slice(0, GOAL_MAX);
  }

  // 入力の確かめ（保存する前）。問題なければ空文字
  function cycleError(p) {
    const x = p || {};
    if (!cleanName(x.name)) return tr('スプリントの名前を入力してください');
    if (str(x.startDate).trim() && !cleanDate(x.startDate)) return tr('開始日が正しくありません');
    if (str(x.endDate).trim() && !cleanDate(x.endDate)) return tr('終了日が正しくありません');
    const a = cleanDate(x.startDate);
    const b = cleanDate(x.endDate);
    if (a && b && b < a) return tr('終了日は開始日より後にしてください');
    return '';
  }

  // 保存してある1件を今の形にする。ID・リポジトリ・名前のないものは捨てる（null）
  function cleanCycle(raw) {
    if (!raw || typeof raw !== 'object') return null;
    const id = str(raw.id).trim();
    const repoPath = str(raw.repoPath).trim();
    const name = cleanName(raw.name);
    if (!id || !repoPath || !name) return null;
    let startDate = cleanDate(raw.startDate);
    let endDate = cleanDate(raw.endDate);
    if (startDate && endDate && endDate < startDate) [startDate, endDate] = [endDate, startDate];
    const num = (v) => (Number.isFinite(Number(v)) && Number(v) > 0 ? Number(v) : 0);
    const done = raw.done === true;
    return { id, repoPath, name, startDate, endDate, goal: cleanGoal(raw.goal), done, createdAt: num(raw.createdAt), updatedAt: num(raw.updatedAt), doneAt: done ? num(raw.doneAt) : 0 };
  }

  function cleanCycles(list) {
    const out = [];
    const seen = new Set();
    for (const raw of Array.isArray(list) ? list : []) {
      const c = cleanCycle(raw);
      if (!c || seen.has(c.id)) continue;
      seen.add(c.id);
      out.push(c);
    }
    return out.slice(-MAX_CYCLES);
  }

  function cleanCycleView(v) {
    return VIEWS.includes(v) ? v : DEFAULT_VIEW;
  }

  // スプリントの ID の配列（文字列・重なりなし）。cycles を渡すと、その中にあるものだけ
  function cleanCycleIds(list, cycles) {
    const known = Array.isArray(cycles) ? new Set(cycles.map((c) => c && c.id)) : null;
    const out = [];
    for (const v of Array.isArray(list) ? list : []) {
      const id = str(v).trim();
      if (id && !out.includes(id) && (!known || known.has(id))) out.push(id);
    }
    return out;
  }

  // 並び: 開始日の順（開始日がないものは後ろ）、同じなら作った順
  function sortCycles(list) {
    return [...(list || [])].sort((a, b) => {
      const sa = a.startDate || '9999-99-99';
      const sb = b.startDate || '9999-99-99';
      return sa < sb ? -1 : sa > sb ? 1 : (a.createdAt || 0) - (b.createdAt || 0);
    });
  }

  // 一覧に出すスプリント（完了したものは showDone のときだけ）
  function visibleCycles(cycles, showDone) {
    return sortCycles((cycles || []).filter((c) => c && (showDone || !c.done)));
  }

  // 親のカード（サブタスク・Pipeline の並列の枝）
  function parentIdOf(c) {
    return (c && ((c.subtaskOf && c.subtaskOf.parent) || (c.relay && c.relay.branchOf && c.relay.branchOf.parent))) || '';
  }

  // カードが入っているスプリント。自分の cycleIds がなければ親のものを使う（親の親もたどる）
  function cardCycleIds(c, cards) {
    const byId = new Map((cards || []).map((x) => [x && x.id, x]));
    let cur = c;
    for (let depth = 0; cur && depth < 10; depth++) {
      const own = cleanCycleIds(cur.cycleIds);
      if (own.length) return own;
      const pid = parentIdOf(cur);
      cur = pid ? byId.get(pid) : null;
    }
    return [];
  }

  // 選んでいるもの（'all' / 'none' / スプリントの ID）に入るカードか。消えたスプリントの ID は数えない
  function inSelection(c, selection, cards, cycles) {
    if (!selection || selection === ALL) return true;
    const ids = cleanCycleIds(cardCycleIds(c, cards), cycles);
    if (selection === NONE) return ids.length === 0;
    return ids.includes(selection);
  }

  // 選んでいるものを確かめる: 消えたスプリントや、隠している（完了した）スプリントなら「すべて」に戻す
  function cleanSelection(selection, cycles, showDone) {
    if (selection === ALL || selection === NONE) return selection;
    const c = (cycles || []).find((x) => x && x.id === selection);
    return c && (showDone || !c.done) ? c.id : ALL;
  }

  // 新しいタスクを入れるスプリント: スプリントを選んでいるときだけ、そのスプリント（完了したスプリントには入れない）
  function newTaskCycleIds(selection, cycles) {
    const c = (cycles || []).find((x) => x && x.id === selection);
    return c && !c.done ? [c.id] : [];
  }

  // スプリントへドラッグしたときの、新しい cycleIds
  // target: 'none' ならどのスプリントからも外す。スプリントの ID なら加える。from（スイムレーンで元の段のスプリント）を渡すと、そこからは外す
  function dropCycleIds(current, target, from) {
    if (target === NONE) return [];
    if (!target || target === ALL) return cleanCycleIds(current);
    const ids = cleanCycleIds(current).filter((id) => !from || from === NONE || id !== from);
    if (!ids.includes(target)) ids.push(target);
    return ids;
  }

  // スイムレーン: 表示するスプリントごとの段と、最後に「未割り当て」の段。複数のスプリントに入っているカードは、それぞれの段に出す
  function laneGroups(list, cycles, allCards, showDone) {
    const shown = visibleCycles(cycles, showDone);
    const lanes = shown.map((cy) => ({ key: cy.id, cycle: cy, cards: [] }));
    const none = { key: NONE, cycle: null, cards: [] };
    const byKey = new Map(lanes.map((l) => [l.key, l]));
    for (const c of list || []) {
      const ids = cleanCycleIds(cardCycleIds(c, allCards || list), cycles);
      if (!ids.length) {
        none.cards.push(c);
        continue;
      }
      for (const id of ids) if (byKey.has(id)) byKey.get(id).cards.push(c);
    }
    return [...lanes, none];
  }

  // 今日（ローカル）の 'YYYY-MM-DD'
  function today(now = Date.now()) {
    const d = new Date(now);
    const p = (n) => String(n).padStart(2, '0');
    return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`;
  }

  // 'done'（完了）/ 'upcoming'（開始前）/ 'active'（期間中）/ 'ended'（期間が過ぎた）/ ''（期間なし）
  function cycleState(c, now = Date.now()) {
    if (!c) return '';
    if (c.done) return 'done';
    const t = today(now);
    if (c.startDate && t < c.startDate) return 'upcoming';
    if (c.endDate && t > c.endDate) return 'ended';
    if (c.startDate || c.endDate) return 'active';
    return '';
  }

  // 期間の表示（'11/1 – 11/14'。年が今年でなければ年も付ける）
  function periodLabel(c, now = Date.now()) {
    if (!c || (!c.startDate && !c.endDate)) return '';
    const year = String(new Date(now).getFullYear());
    const fmt = (s) => {
      if (!s) return '';
      const [y, m, d] = s.split('-');
      return y === year ? `${+m}/${+d}` : `${y}/${+m}/${+d}`;
    };
    return `${fmt(c.startDate)} – ${fmt(c.endDate)}`.trim();
  }

  return {
    NAME_MAX,
    GOAL_MAX,
    MAX_CYCLES,
    VIEWS,
    DEFAULT_VIEW,
    ALL,
    NONE,
    cleanDate,
    cleanName,
    cleanGoal,
    cycleError,
    cleanCycle,
    cleanCycles,
    cleanCycleView,
    cleanCycleIds,
    sortCycles,
    visibleCycles,
    cardCycleIds,
    inSelection,
    cleanSelection,
    newTaskCycleIds,
    dropCycleIds,
    laneGroups,
    today,
    cycleState,
    periodLabel,
  };
});
