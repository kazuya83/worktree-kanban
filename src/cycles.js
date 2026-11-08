// スプリント（期間とゴールを持つ、タスクのまとまり）の cycles:* のハンドラの中身。main.js から呼ぶ。
// Electron なしで試せるように、ここでは store を変えて onChange を呼ぶだけにする
const crypto = require('crypto');
const CycleModel = require('../renderer/cycle-model');
const { tr } = require('../renderer/i18n');

const EDIT_KEYS = ['name', 'startDate', 'endDate', 'goal'];

function needId(arg, msg) {
  const id = arg && typeof arg === 'object' ? arg.id : arg;
  if (!id || typeof id !== 'string') throw new Error(msg);
  return id;
}

function createCycleApi({ store, onChange = () => {}, now = () => Date.now() }) {
  const find = (id) => {
    const c = store.cycle(id);
    if (!c) throw new Error(tr('スプリントが見つかりません（消されたかもしれません）'));
    return c;
  };
  const changed = () => {
    store.save();
    onChange();
  };
  // カードの cycleIds を、そのリポジトリにあるスプリントだけにして入れる（空なら消す）
  const assign = (card, ids) => {
    const list = CycleModel.cleanCycleIds(ids, store.cyclesOf(card.repoPath));
    if (list.length) card.cycleIds = list;
    else delete card.cycleIds;
    // ブランチを使うスプリントは、入っているスプリントのどれかのときだけ残す
    if (card.branchCycleId && !list.includes(card.branchCycleId)) delete card.branchCycleId;
    return list;
  };
  return {
    // 新しいスプリントは、今開いているリポジトリのものにする（遠隔操作ではホストの今のリポジトリ）
    create(p) {
      const repoPath = store.settings.repoPath;
      if (!repoPath) throw new Error(tr('先にリポジトリを開いてください'));
      const x = p || {};
      const err = CycleModel.cycleError(x);
      if (err) throw new Error(err);
      const at = now();
      const c = CycleModel.cleanCycle({ ...Object.fromEntries(EDIT_KEYS.map((k) => [k, x[k]])), id: crypto.randomBytes(4).toString('hex'), repoPath, done: false, createdAt: at, updatedAt: at });
      store.addCycle(c);
      changed();
      return c;
    },
    // 名前・期間・ゴールを変える。done で完了にする・戻す
    update(p) {
      const { id, ...patch } = p || {};
      const cur = find(needId(id, tr('スプリントが指定されていません')));
      const next = { ...cur };
      for (const k of EDIT_KEYS) if (patch[k] !== undefined) next[k] = patch[k];
      const err = CycleModel.cycleError(next);
      if (err) throw new Error(err);
      if (patch.done !== undefined) {
        const done = patch.done === true;
        if (done && !cur.done) next.doneAt = now();
        next.done = done;
      }
      next.updatedAt = now();
      const clean = CycleModel.cleanCycle(next);
      Object.assign(cur, clean);
      changed();
      return cur;
    },
    // スプリントを消す。中のタスクは消さず、そのスプリントから外すだけ
    delete(arg) {
      const id = needId(arg, tr('スプリントが指定されていません'));
      find(id);
      store.removeCycle(id);
      for (const card of store.cards) {
        if (!Array.isArray(card.cycleIds) || !card.cycleIds.includes(id)) continue;
        const rest = card.cycleIds.filter((x) => x !== id);
        if (rest.length) card.cycleIds = rest;
        else delete card.cycleIds;
        if (card.branchCycleId === id) delete card.branchCycleId;
      }
      changed();
      return true;
    },
    // タスクを入れるスプリントを決める（いくつでも。空ならどのスプリントにも入れない）
    // branchCycleId: 複数のスプリントに入れるときに、ブランチを使うスプリント（'' で選ばない。渡さなければ前のまま）
    setCard(p) {
      const { id, cycleIds, branchCycleId } = p || {};
      const card = store.card(needId(id, tr('タスクが指定されていません')));
      if (!card) throw new Error(tr('タスクが見つかりません'));
      if (branchCycleId !== undefined) {
        const b = typeof branchCycleId === 'string' ? branchCycleId.trim() : '';
        if (b) card.branchCycleId = b;
        else delete card.branchCycleId;
      }
      const list = assign(card, cycleIds);
      changed();
      return list;
    },
    // 作ったばかりのカードを入れる（card:create などから。知らせるのは呼んだ側）
    assignNew(ids, cycleIds) {
      const list = CycleModel.cleanCycleIds(cycleIds);
      if (!list.length) return;
      for (const id of ids || []) {
        const card = store.card(id);
        if (card) assign(card, list);
      }
      changed();
    },
  };
}

module.exports = { createCycleApi };
