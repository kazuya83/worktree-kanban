// ボードの列とレーン（プロジェクトごと。リポジトリの .worktree-kanban/board.json に置く）
// 列とレーンには、それぞれ自然言語の説明を付ける。保存するときに AI が説明を「段階＋条件」に変換し、
// カードはその条件で、決まった通りに自動で振り分ける（毎回 AI は呼ばない）。
// 手でドラッグして動かせるのは、今の列の「次に進んでよい列」と、同じ列の中のレーンだけ。
// 手で動かした置き場所は、次にカードの状態が変わったら外して、また条件で振り分ける。
//
// デスクトップの画面・スマホの画面・メインプロセス（保存・カードの置き場所）の3か所から使う。DOM には触らない。
(function (root, factory) {
  const api = factory(root);
  if (typeof module === 'object' && module.exports) module.exports = api;
  else root.BoardColumns = api;
})(typeof globalThis !== 'undefined' ? globalThis : this, function (root) {
  function tr(key, vars) {
    const i18n = typeof module === 'object' && module.exports ? require('./i18n.js') : root.I18n;
    if (i18n) return i18n.tr(key, vars);
    return vars ? String(key).replace(/\{(\w+)\}/g, (m, k) => (k in vars ? String(vars[k]) : m)) : key;
  }

  const FILE_VERSION = 1;
  // 段階（アプリがカードの状態から決める。列はどれか1つの段階にひも付く）
  const STAGES = ['todo', 'running', 'review', 'done'];
  const STAGE_STATUSES = { todo: ['todo'], running: ['queued', 'running'], review: ['review', 'failed'], done: ['done'] };
  const MAX_COLUMNS = 12;
  const MAX_LANES = 6;
  const NAME_MAX = 30;
  const DESC_MAX = 1000;
  const ID_RE = /^[A-Za-z0-9_-]{1,32}$/;
  const AGENT_IDS = ['claude', 'codex', 'antigravity', 'gemini', 'cursor', 'opencode', 'copilot', 'amp', 'pi', 'droid'];

  // 条件に使える、カードの事実。条件の項目はすべて満たしたときに合う（空の条件は、いつでも合う）
  // bool: true / false。list: その中のどれかなら合う
  const FACTS = {
    failed: { type: 'bool' },
    needsYou: { type: 'bool' },
    merged: { type: 'bool' },
    manualDone: { type: 'bool' },
    hasSubtasks: { type: 'bool' },
    reviewComments: { type: 'bool' },
    pr: { type: 'list', values: ['none', 'open', 'merged', 'closed'] },
    ci: { type: 'list', values: ['none', 'pending', 'success', 'failure'] },
    agents: { type: 'list', values: AGENT_IDS },
    titleIncludes: { type: 'words' },
  };
  const STAGE_LABEL = () => ({ todo: 'Todo', running: tr('実行中'), review: tr('レビュー'), done: tr('完了') });

  const stageLabel = (s) => STAGE_LABEL()[s] || String(s || '');

  // 何も決めていないときの4つの列（今までと同じ）
  function defaultConfig() {
    return {
      version: FILE_VERSION,
      columns: [
        { id: 'todo', name: 'Todo', description: tr('まだ始めていないタスク'), stage: 'todo', when: {}, next: ['running'], lanes: [{ id: 'main', name: '', description: '', when: {} }] },
        { id: 'running', name: tr('実行中'), description: tr('エージェントが作業しているタスク'), stage: 'running', when: {}, next: ['done'], lanes: [{ id: 'main', name: '', description: '', when: {} }] },
        { id: 'review', name: tr('レビュー'), description: tr('エージェントの作業が終わり、確かめるのを待っているタスク'), stage: 'review', when: {}, next: ['done'], lanes: [{ id: 'main', name: '', description: '', when: {} }] },
        { id: 'done', name: tr('完了'), description: tr('マージした、または完了にしたタスク'), stage: 'done', when: {}, next: ['review'], lanes: [{ id: 'main', name: '', description: '', when: {} }] },
      ],
    };
  }

  const str = (v, max) => [...String(v == null ? '' : v).replace(/\r\n?/g, '\n').trim()].slice(0, max).join('').trim();
  const oneLine = (v, max) => str(String(v == null ? '' : v).replace(/\s+/g, ' '), max);

  // 条件を整える（知らない項目・形の合わない値は捨てる）
  function cleanWhen(w) {
    const out = {};
    if (!w || typeof w !== 'object' || Array.isArray(w)) return out;
    for (const [k, def] of Object.entries(FACTS)) {
      if (!(k in w)) continue;
      const v = w[k];
      if (def.type === 'bool') {
        if (typeof v === 'boolean') out[k] = v;
      } else if (def.type === 'list') {
        const list = (Array.isArray(v) ? v : [v]).map((x) => String(x || '').toLowerCase()).filter((x) => def.values.includes(x));
        if (list.length) out[k] = [...new Set(list)];
      } else if (def.type === 'words') {
        const list = (Array.isArray(v) ? v : [v]).map((x) => oneLine(x, 40)).filter(Boolean).slice(0, 10);
        if (list.length) out[k] = [...new Set(list)];
      }
    }
    return out;
  }

  function uniqueId(raw, taken, prefix) {
    let id = String(raw == null ? '' : raw).trim();
    if (!ID_RE.test(id) || taken.has(id)) {
      let n = taken.size + 1;
      while (taken.has(`${prefix}${n}`)) n++;
      id = `${prefix}${n}`;
    }
    taken.add(id);
    return id;
  }

  /**
   * 列の設定を整える（形の合わないところは直す・捨てる。足りない説明などは validateConfig が知らせる）
   * @returns {{ version: number, columns: object[] }}
   */
  function cleanConfig(raw) {
    const src = raw && typeof raw === 'object' && Array.isArray(raw.columns) ? raw.columns : [];
    const ids = new Set();
    const columns = [];
    for (const c of src) {
      if (!c || typeof c !== 'object' || columns.length >= MAX_COLUMNS) continue;
      const laneIds = new Set();
      const lanes = [];
      for (const l of Array.isArray(c.lanes) ? c.lanes : []) {
        if (!l || typeof l !== 'object' || lanes.length >= MAX_LANES) continue;
        lanes.push({ id: uniqueId(l.id, laneIds, 'l'), name: oneLine(l.name, NAME_MAX), description: str(l.description, DESC_MAX), when: cleanWhen(l.when) });
      }
      if (!lanes.length) lanes.push({ id: uniqueId('main', laneIds, 'l'), name: '', description: '', when: {} });
      columns.push({
        id: uniqueId(c.id, ids, 'c'),
        name: oneLine(c.name, NAME_MAX),
        description: str(c.description, DESC_MAX),
        stage: STAGES.includes(c.stage) ? c.stage : '',
        when: cleanWhen(c.when),
        next: Array.isArray(c.next) ? c.next.map((x) => String(x || '').trim()) : [],
        lanes,
      });
    }
    // 次に進んでよい列は、ある列だけ（自分は入れない）
    const all = new Set(columns.map((c) => c.id));
    for (const c of columns) c.next = [...new Set(c.next.filter((x) => all.has(x) && x !== c.id))];
    return { version: FILE_VERSION, columns };
  }

  /**
   * 保存できる形かを確かめる。直すところの一覧（なければ空）
   * @param {object} cfg cleanConfig を通したもの
   * @param {{ needStage?: boolean }} [opt] needStage: false なら、段階がまだ決まっていなくてもよい（AI に変換してもらう前）
   */
  function validateConfig(cfg, { needStage = true } = {}) {
    const errors = [];
    const cols = (cfg && cfg.columns) || [];
    if (!cols.length) errors.push(tr('列が1つもありません'));
    for (const [i, c] of cols.entries()) {
      const label = c.name || tr('{n}番目の列', { n: i + 1 });
      if (!c.name) errors.push(tr('{n}番目の列に名前を付けてください', { n: i + 1 }));
      if (!c.description) errors.push(tr('「{name}」の列に説明を書いてください', { name: label }));
      if (needStage && !c.stage) errors.push(tr('「{name}」の列の段階が決まっていません', { name: label }));
      if (c.lanes.length > 1) {
        for (const [j, l] of c.lanes.entries()) {
          if (!l.name) errors.push(tr('「{name}」の列の{n}番目のレーンに名前を付けてください', { name: label, n: j + 1 }));
          if (!l.description) errors.push(tr('「{name}」の列のレーン「{lane}」に説明を書いてください', { name: label, lane: l.name || String(j + 1) }));
        }
      }
    }
    if (needStage && cols.length) {
      for (const s of STAGES) if (!cols.some((c) => c.stage === s)) errors.push(tr('段階「{stage}」の列がありません。どの段階のカードも、どれかの列に入るようにしてください', { stage: stageLabel(s) }));
    }
    return errors;
  }

  // 説明だけを比べる鍵（説明が変わっていなければ、前に変換した段階・条件をそのまま使える）
  function descriptionKey(cfg) {
    return JSON.stringify(((cfg && cfg.columns) || []).map((c) => [c.id, c.description, c.lanes.map((l) => [l.id, c.lanes.length > 1 ? l.description : ''])]));
  }

  // ---------- カードの事実と置き場所 ----------

  const isChat = (c) => !!c && c.kind === 'chat';
  const isActive = (c) => !!c && (c.status === 'running' || c.status === 'queued');
  const subtasksRunning = (c) => !!(c && c.subtasks && c.subtasks.phase === 'run');

  // カードの段階（サブタスクを動かしている親は「実行中」）
  function stageOf(c) {
    if (!c) return '';
    const s = subtasksRunning(c) && (c.status === 'review' || c.status === 'failed') ? 'running' : c.status;
    return STAGES.find((k) => STAGE_STATUSES[k].includes(s)) || '';
  }

  // 条件で見る、カードの事実
  function factsOf(c) {
    const pr = !c.prUrl ? 'none' : c.prState === 'MERGED' || c.prMergedAt ? 'merged' : c.prState === 'CLOSED' ? 'closed' : 'open';
    const cs = c.prChecks && c.prChecks.state;
    const ci = cs === 'FAILURE' || cs === 'ERROR' ? 'failure' : cs === 'SUCCESS' ? 'success' : cs === 'PENDING' || cs === 'ATTENTION' ? 'pending' : 'none';
    const waiting = !!(
      (c.interrupted && !isActive(c)) ||
      (c.questions || []).length ||
      (c.permissions || []).length ||
      ((c.status === 'review' || c.status === 'failed') && (c.awaitingReply || (c.specState === 'pending')))
    );
    return {
      failed: c.status === 'failed',
      needsYou: waiting,
      merged: !!((c.mergedInto || []).length || pr === 'merged'),
      manualDone: c.status === 'done' && !!c.manualDone && !(c.mergedInto || []).length && pr !== 'merged',
      hasSubtasks: !!(c.subtasks && Array.isArray(c.subtasks.items) && c.subtasks.items.length),
      reviewComments: !!(c.prReview && Array.isArray(c.prReview.items) && c.prReview.items.length),
      pr,
      ci,
      agent: String(c.agent || 'claude'),
      title: String(c.title || ''),
    };
  }

  function matches(when, f) {
    for (const [k, v] of Object.entries(when || {})) {
      const def = FACTS[k];
      if (!def) continue;
      if (def.type === 'bool' && f[k] !== v) return false;
      if (def.type === 'list' && !v.includes(k === 'agents' ? f.agent : f[k])) return false;
      if (def.type === 'words') {
        const t = f.title.toLowerCase();
        if (!v.some((w) => t.includes(String(w).toLowerCase()))) return false;
      }
    }
    return true;
  }

  // カードの状態のしるし。手で動かしたときに覚え、これが変わったら（状態が変わったら）条件で振り分け直す
  function signatureOf(c) {
    if (!c) return '';
    const f = factsOf(c);
    return [stageOf(c), f.failed, f.needsYou, f.merged, f.manualDone, f.hasSubtasks, f.reviewComments, f.pr, f.ci].join('|');
  }

  /**
   * カードを置く列とレーン
   * @returns {{ col: string, lane: string, manual: boolean } | null}
   */
  function placeOf(cfg, c) {
    const cols = (cfg && cfg.columns) || [];
    const stage = stageOf(c);
    const same = cols.filter((x) => x.stage === stage);
    if (!same.length) return null;
    const f = factsOf(c);
    const laneIn = (col, want) => (want && col.lanes.find((l) => l.id === want)) || col.lanes.find((l) => matches(l.when, f)) || col.lanes[0];
    const p = c.boardPlace;
    if (p && typeof p === 'object' && p.sig === signatureOf(c)) {
      const col = same.find((x) => x.id === p.col);
      if (col) return { col: col.id, lane: laneIn(col, p.lane).id, manual: true };
    }
    const col = same.find((x) => matches(x.when, f)) || same[0];
    return { col: col.id, lane: laneIn(col, null).id, manual: false };
  }

  // 段階をまたいで手で動かせるか（今までのドラッグと同じ決まり: Todo → 実行中で開始、レビュー ⇄ 完了）
  function canChangeStage(c, from, to) {
    if (from === to) return true;
    if (from === 'todo') return to === 'running';
    if (from === 'review') return to === 'done';
    if (from === 'done') return to === 'review';
    if (from === 'running') return to === 'done' && subtasksRunning(c); // サブタスクが残っているときは、あとで理由を出す
    return false;
  }

  // 手で動かせるカードか
  function canDrag(c) {
    return !!c && !isChat(c) && !c.afterDone && ['todo', 'review', 'failed', 'done'].includes(c.status);
  }

  /**
   * 手でその列（とレーン）へ動かせるか。lane を省くと、列の中のレーンは条件で決める
   * 同じ列の中のレーンはいつでも動かせる。別の列へは「次に進んでよい列」だけ
   */
  function canPlace(cfg, c, toCol, toLane) {
    if (!canDrag(c)) return false;
    const cols = (cfg && cfg.columns) || [];
    const to = cols.find((x) => x.id === toCol);
    const from = placeOf(cfg, c);
    if (!to || !from) return false;
    if (from.col === to.id) return !!toLane && toLane !== from.lane && to.lanes.some((l) => l.id === toLane);
    const fromCol = cols.find((x) => x.id === from.col);
    if (!fromCol || !fromCol.next.includes(to.id)) return false;
    if (toLane && !to.lanes.some((l) => l.id === toLane)) return false;
    return canChangeStage(c, stageOf(c), to.stage);
  }

  // 条件を、人が読める文にする（変換の結果を確かめる画面で使う）
  function describeWhen(when) {
    const parts = [];
    const yes = (k, on, off) => (when[k] === true ? on : off);
    const L = {
      pr: { none: tr('PR なし'), open: tr('PR が開いている'), merged: tr('PR がマージ済み'), closed: tr('PR がマージされずに閉じた') },
      ci: { none: tr('CI なし'), pending: tr('CI 実行中'), success: tr('CI 成功'), failure: tr('CI 失敗') },
    };
    if ('failed' in when) parts.push(yes('failed', tr('エラーで終わった'), tr('エラーではない')));
    if ('needsYou' in when) parts.push(yes('needsYou', tr('あなたの対応待ち'), tr('対応待ちではない')));
    if ('merged' in when) parts.push(yes('merged', tr('マージ済み'), tr('マージしていない')));
    if ('manualDone' in when) parts.push(yes('manualDone', tr('マージせずに完了にした'), tr('マージせずに完了にしたものではない')));
    if ('hasSubtasks' in when) parts.push(yes('hasSubtasks', tr('サブタスクがある'), tr('サブタスクがない')));
    if ('reviewComments' in when) parts.push(yes('reviewComments', tr('PR にレビューコメントがある'), tr('PR にレビューコメントがない')));
    if (when.pr) parts.push(when.pr.map((x) => L.pr[x]).join(tr(' または ')));
    if (when.ci) parts.push(when.ci.map((x) => L.ci[x]).join(tr(' または ')));
    if (when.agents) parts.push(tr('エージェント: {list}', { list: when.agents.join(', ') }));
    if (when.titleIncludes) parts.push(tr('タイトルに「{list}」のどれかを含む', { list: when.titleIncludes.join('」「') }));
    return parts.length ? parts.join(tr('、かつ ')) : tr('条件なし（この段階のカードはすべて）');
  }

  return { FILE_VERSION, STAGES, STAGE_STATUSES, FACTS, MAX_COLUMNS, MAX_LANES, NAME_MAX, DESC_MAX, ID_RE, stageLabel, defaultConfig, cleanWhen, cleanConfig, validateConfig, descriptionKey, stageOf, factsOf, matches, signatureOf, placeOf, canChangeStage, canDrag, canPlace, describeWhen };
});
