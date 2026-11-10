// スプリント（期間とゴールを持つ、タスクのまとまり）の画面: ボードの上のタブ・左のサイドバー・スイムレーン、
// スプリントの作成・編集、タスクを入れるスプリントの選択。
// 画面の部品（openModal・runBusy・cardHtml など）は renderer.js のものを使う。
// このファイルは renderer.js より先に読み込むので、それらは関数の中でだけ触る。
//
// 境界: window.CycleView = {
//   mode()                 ボードの見え方（'top' / 'sidebar' / 'lanes'。設定の「スプリントの表示」）
//   cycles()               今のプロジェクトのスプリント
//   inView(c)              今選んでいるスプリントに入るカードか（スイムレーンでは、いつも true）
//   chromeHtml(counts)     ボードの上のタブ・左のサイドバー（スイムレーンでは上の帯）
//   lanesHtml(cards, cols) スイムレーンの中身
//   bindChrome()           タブ・サイドバー・レーンの見出しのクリック
//   chipsHtml(c)           カードに出すスプリントの印
//   newTaskIds()           新しいタスクを入れるスプリント（スプリントを選んでいるとき）
//   fieldHtml(idp, ids) / readField(idp)  新しいタスクのダイアログのスプリントの欄
//   detailButtonHtml(c) / openCardCycles(c)  詳細の「スプリント」ボタンと、その選択ダイアログ
//   canDrag(c) / canDropOn(c, target) / dropOn(c, target) / canLaneDrop(c, from, to) / moveLane(c, from, to)
// }
// 設定「スプリントごとにブランチを作る」がオンのときは、スプリントのブランチと「ベースにマージ」「PR を作る」も出す
/* global api, icon, esc, $, state, CycleModel, openModal, closeModal, runBusy, toast, renderBoard, cardHtml, isChat, isHiddenSubtask */
(function (root) {
  const i18n = typeof module === 'object' && module.exports ? require('./i18n.js') : root.I18n;
  function tr(key, vars) {
    if (i18n) return i18n.tr(key, vars);
    return vars ? String(key).replace(/\{(\w+)\}/g, (m, k) => (k in vars ? String(vars[k]) : m)) : key;
  }
  const M = () => root.CycleModel;
  const SEL_KEY = 'cycleSel:'; // + リポジトリのパス。プロジェクトごとに、最後に選んだスプリントを覚える
  const DONE_KEY = 'cycleShowDone';
  const store = () => {
    try {
      return root.localStorage || null;
    } catch {
      return null;
    }
  };

  function cycles() {
    return Array.isArray(state.board.cycles) ? state.board.cycles : [];
  }
  function mode() {
    return M().cleanCycleView(state.board.settings && state.board.settings.cycleView);
  }
  function showDone() {
    return store()?.getItem(DONE_KEY) === '1';
  }
  function setShowDone(on) {
    store()?.setItem(DONE_KEY, on ? '1' : '0');
  }
  function repoKey() {
    return SEL_KEY + String((state.board.settings && state.board.settings.repoPath) || '');
  }
  // 選んでいるもの（'all' / 'none' / スプリントの ID）。消えた・隠したスプリントなら「すべて」
  function selection() {
    if (mode() === 'lanes') return M().ALL;
    return M().cleanSelection(store()?.getItem(repoKey()) || M().ALL, cycles(), showDone());
  }
  function setSelection(sel) {
    store()?.setItem(repoKey(), sel);
  }
  function findCycle(id) {
    return cycles().find((x) => x.id === id) || null;
  }
  function idsOf(c) {
    return M().cleanCycleIds(M().cardCycleIds(c, state.board.cards), cycles());
  }

  function inView(c) {
    return M().inSelection(c, selection(), state.board.cards, cycles());
  }

  // ---- 表示の部品 ----
  function stateLabel(cy) {
    const s = M().cycleState(cy);
    if (s === 'done') return tr('完了');
    if (s === 'upcoming') return tr('開始前');
    if (s === 'active') return tr('期間中');
    if (s === 'ended') return tr('期間終了');
    return '';
  }
  function stateBadge(cy) {
    const s = M().cycleState(cy);
    return s ? `<span class="cy-state cy-${s}">${esc(stateLabel(cy))}</span>` : '';
  }
  function itemTitle(cy) {
    const parts = [cy.name];
    const p = M().periodLabel(cy);
    if (p) parts.push(tr('期間: {p}', { p }));
    if (cy.goal) parts.push(tr('ゴール: {goal}', { goal: cy.goal }));
    return parts.join('\n');
  }

  // 一覧に出すもの: すべて・未割り当て・各スプリント（数はボードに出るカードの数）
  function entries(list) {
    const all = list.length;
    const none = list.filter((c) => M().inSelection(c, M().NONE, state.board.cards, cycles())).length;
    const shown = M().visibleCycles(cycles(), showDone());
    return [
      { key: M().ALL, label: tr('すべて'), count: all, drop: false },
      { key: M().NONE, label: tr('未割り当て'), count: none, drop: true },
      ...shown.map((cy) => ({ key: cy.id, cycle: cy, label: cy.name, count: list.filter((c) => idsOf(c).includes(cy.id)).length, drop: !cy.done })),
    ];
  }
  function entryHtml(e, sel, side) {
    const cy = e.cycle;
    const period = cy ? M().periodLabel(cy) : '';
    const cls = ['cy-item', e.key === sel ? 'active' : '', cy && cy.done ? 'done' : '', cy ? `cy-${M().cycleState(cy) || 'none'}` : ''].filter(Boolean).join(' ');
    const title = cy ? itemTitle(cy) : e.key === M().NONE ? tr('どのスプリントにも入っていないタスク。カードをここへドラッグすると、スプリントから外します') : tr('すべてのタスク');
    return `<button type="button" class="${cls}" data-cycle-sel="${esc(e.key)}" ${e.drop ? `data-cycle-drop="${esc(e.key)}"` : ''} title="${esc(title)}">
      <span class="cy-name">${esc(e.label)}</span>${side && period ? `<span class="cy-period">${esc(period)}</span>` : ''}<span class="cy-count">${e.count}</span></button>`;
  }
  // スプリントごとのブランチを使う設定か（プロジェクトごと）
  function branchMode() {
    return !!(state.board.settings && state.board.settings.sprintBranch === true);
  }
  // スプリントのブランチと、マージ・PR のボタン
  function branchHtml(cy) {
    if (!branchMode() || !cy) return '';
    if (!cy.branch) return `<div class="cy-branch muted small">${icon('branch')}${tr('ブランチは、このスプリントで最初にタスクを始めるときに作ります')}</div>`;
    const base = cy.branchBase || (state.board.settings && state.board.settings.baseBranch) || '';
    const done = [cy.mergedAt ? tr('{base} にマージ済み', { base: esc(base || tr('ベース')) }) : '', cy.prUrl ? `<a class="issue-chip" data-url="${esc(cy.prUrl)}">PR</a>` : ''].filter(Boolean).join(' ');
    return `<div class="cy-branch">${icon('branch')}<code>${esc(cy.branch)}</code>${base ? ` <span class="muted small">← ${esc(base)}</span>` : ''} ${done ? `<span class="muted small">${done}</span>` : ''}
      <span class="cy-current-acts">
        <button type="button" class="btn small ghost" data-cycle-act="mergeBranch" data-id="${esc(cy.id)}" title="${esc(tr('スプリントのブランチを {base} にマージします', { base: base || tr('ベース') }))}">${tr('ベースにマージ')}</button>
        <button type="button" class="btn small ghost" data-cycle-act="prBranch" data-id="${esc(cy.id)}" title="${esc(tr('スプリントのブランチを origin に push して、{base} への PR を作ります', { base: base || tr('ベース') }))}">${tr('PR を作る')}</button>
      </span></div>`;
  }
  // 選んでいるスプリントの、期間・ゴールと操作
  function currentHtml(sel) {
    const cy = findCycle(sel);
    if (!cy) return '';
    const period = M().periodLabel(cy);
    return `<div class="cy-current">
      <div class="cy-current-head"><b>${esc(cy.name)}</b> ${stateBadge(cy)} ${period ? `<span class="muted small">${esc(period)}</span>` : ''}
        <span class="cy-current-acts">
          <button type="button" class="btn small ghost" data-cycle-act="edit" data-id="${esc(cy.id)}">${tr('編集')}</button>
          <button type="button" class="btn small ghost" data-cycle-act="${cy.done ? 'reopen' : 'done'}" data-id="${esc(cy.id)}">${cy.done ? tr('未完了に戻す') : tr('完了にする')}</button>
        </span></div>
      ${cy.goal ? `<div class="cy-goal"><span class="muted small">${tr('ゴール')}</span> ${esc(cy.goal)}</div>` : ''}
      ${branchHtml(cy)}
    </div>`;
  }
  function toolsHtml() {
    return `<button type="button" class="btn small ghost cy-new" data-cycle-act="new" title="${esc(tr('期間とゴールを持つ、タスクのまとまりを作ります'))}">${icon('plus')}${tr('スプリント')}</button>
      <label class="check cy-show-done" title="${esc(tr('完了にしたスプリントも一覧に出します'))}"><input type="checkbox" data-cycle-act="showDone" ${showDone() ? 'checked' : ''} /> ${tr('完了したスプリントを表示')}</label>`;
  }

  // ボードの上のタブ（top）・左のサイドバー（sidebar）・スイムレーンの上の帯（lanes）
  function chromeHtml(list) {
    const m = mode();
    if (m === 'lanes') return `<div class="cycle-bar lanes-bar">${toolsHtml()}</div>`;
    const sel = selection();
    const items = entries(list);
    if (m === 'sidebar') {
      return `<aside class="cycle-side" aria-label="${esc(tr('スプリント'))}">
        <div class="cy-side-head">${tr('スプリント')}</div>
        <div class="cy-side-list">${items.map((e) => entryHtml(e, sel, true)).join('')}</div>
        <div class="cy-side-tools">${toolsHtml()}</div>
        ${currentHtml(sel)}
      </aside>`;
    }
    return `<div class="cycle-bar" role="tablist" aria-label="${esc(tr('スプリント'))}">
      <div class="cy-tabs">${items.map((e) => entryHtml(e, sel, false)).join('')}</div>
      <div class="cy-tools">${toolsHtml()}</div>
      ${currentHtml(sel)}
    </div>`;
  }

  // スイムレーン: 列の見出しの行と、スプリントごとの段（最後に「未割り当て」）
  // cols: [{ key, label, list(cards) }] の作り方は renderer.js（列ごとの並べ方を同じにする）
  // cellInner(cards, col): 列の中身（ボードの列にレーンがあるときは、上下に区切る）。省くとカードを並べるだけ
  function lanesHtml(list, columns, columnCards, cellInner) {
    const lanes = M().laneGroups(list, cycles(), state.board.cards, showDone());
    const head = `<div class="lane-cols">${columns.map((col) => `<div class="lane-col-head"><span>${col.label}</span><span class="count">${columnCards(list, col).length}</span></div>`).join('')}</div>`;
    const body = lanes
      .map((l) => {
        const cy = l.cycle;
        const period = cy ? M().periodLabel(cy) : '';
        const title = cy
          ? `<b class="lane-name">${esc(cy.name)}</b> ${stateBadge(cy)} ${period ? `<span class="muted small">${esc(period)}</span>` : ''}${cy.goal ? `<span class="lane-goal" title="${esc(cy.goal)}">${esc(cy.goal)}</span>` : ''}`
          : `<b class="lane-name">${tr('未割り当て')}</b>`;
        const acts = cy ? `<button type="button" class="btn small ghost" data-cycle-act="edit" data-id="${esc(cy.id)}">${tr('編集')}</button>` : '';
        const cells = columns
          .map((col) => {
            const cs = columnCards(l.cards, col);
            const inner = cellInner ? cellInner(cs, col) : `<div class="cards">${cs.map(cardHtml).join('')}</div>`;
            return `<section class="column lane-cell" data-col="${esc(col.key)}" data-lane="${esc(l.key)}">${inner}</section>`;
          })
          .join('');
        return `<div class="lane ${cy && cy.done ? 'done' : ''}" data-lane-row="${esc(l.key)}">
          <div class="lane-head">${title}<span class="count">${l.cards.length}</span><span class="lane-acts">${acts}</span></div>
          ${branchHtml(cy)}
          <div class="lane-row">${cells}</div>
        </div>`;
      })
      .join('');
    return `${head}<div class="lanes">${body}</div>`;
  }

  // カードに出すスプリントの印（スイムレーンと、選んでいるスプリントそのものは出さない）
  function chipsHtml(c) {
    if (isChat(c) || mode() === 'lanes') return '';
    const sel = selection();
    const own = idsOf(c).filter((id) => id !== sel);
    if (!own.length) return '';
    return `<div class="card-skill-row">${own
      .map((id) => findCycle(id))
      .filter(Boolean)
      .map((cy) => `<span class="cycle-chip ${cy.done ? 'done' : ''}" title="${esc(itemTitle(cy))}">${esc(cy.name)}</span>`)
      .join('')}</div>`;
  }

  // ---- 操作 ----
  // タブ・ボタンのクリックは、ボードにまとめて受ける（イベント委譲）。
  // エージェントが動いているあいだはボードが何度も描き直されるので、押している間にボタンが差し替わると
  // click はボタンではなくボード自体に届き、「編集」などが効かなくなる。
  // そのときは、押したボタンと同じもの（同じ操作・同じスプリント）が今その場所にあれば、それを押したことにする
  const HIT = '[data-cycle-sel], [data-cycle-act]';
  const keyOf = (el) => (el ? `${el.dataset.cycleSel || ''}|${el.dataset.cycleAct || ''}|${el.dataset.id || ''}` : '');
  let pressed = null;
  let bound = null;
  function hitAt(e, sel, from) {
    const direct = e.target && e.target.closest ? e.target.closest(sel) : null;
    if (direct) return direct;
    if (!from || from.isConnected) return null;
    const doc = root.document;
    const at = doc && doc.elementFromPoint ? doc.elementFromPoint(e.clientX, e.clientY) : null;
    const el = at && at.closest ? at.closest(sel) : null;
    return el && keyOf(el) === keyOf(from) ? el : null;
  }
  function onBoardDown(e) {
    pressed = e.target && e.target.closest ? e.target.closest(HIT) : null;
  }
  function onBoardClick(e) {
    const from = pressed;
    pressed = null;
    const b = hitAt(e, HIT, from);
    if (!b) return;
    if (b.dataset.cycleSel) {
      setSelection(b.dataset.cycleSel);
      renderBoard();
      return;
    }
    const act = b.dataset.cycleAct;
    if (act === 'showDone') return; // チェックボックスは change で受ける
    const cy = findCycle(b.dataset.id);
    if (act === 'new') return openEditor(null);
    if (!cy) return;
    if (act === 'edit') return openEditor(cy);
    if (act === 'done') return setDone(cy, true);
    if (act === 'reopen') return setDone(cy, false);
    if (act === 'mergeBranch') return mergeBranch(cy);
    if (act === 'prBranch') return prBranch(cy);
  }
  // タブのダブルクリックで編集。1回目のクリックで描き直すので、押した場所にある今のタブを見る
  function onBoardDblClick(e) {
    let b = e.target && e.target.closest ? e.target.closest('[data-cycle-sel]') : null;
    if (!b) {
      const doc = root.document;
      const at = doc && doc.elementFromPoint ? doc.elementFromPoint(e.clientX, e.clientY) : null;
      b = at && at.closest ? at.closest('[data-cycle-sel]') : null;
    }
    const cy = b ? findCycle(b.dataset.cycleSel) : null;
    if (cy) openEditor(cy);
  }
  function onBoardChange(e) {
    const b = e.target;
    if (!b || !b.dataset || b.dataset.cycleAct !== 'showDone') return;
    setShowDone(b.checked);
    renderBoard();
  }
  function bindChrome() {
    const board = $('board');
    if (!board || bound === board) return;
    bound = board;
    board.addEventListener('mousedown', onBoardDown);
    board.addEventListener('click', onBoardClick);
    board.addEventListener('dblclick', onBoardDblClick);
    board.addEventListener('change', onBoardChange);
  }

  async function setDone(cy, done) {
    if (done && !confirm(tr('スプリント「{name}」を完了にしますか？\n完了したスプリントは一覧から隠れます（「完了したスプリントを表示」で見られます）。中のタスクはそのまま残ります。', { name: cy.name }))) return;
    await runBusy(done ? tr('スプリントを完了にしています…') : tr('スプリントを未完了に戻しています…'), () => api.updateCycle(cy.id, { done }), done ? tr('スプリントを完了にしました') : tr('スプリントを未完了に戻しました'));
  }

  // スプリントのブランチを、作成元（ベース）のブランチへマージする
  function mergeBranch(cy) {
    const base = cy.branchBase || state.board.settings.baseBranch || tr('ベース');
    const push = state.board.settings.pushAfterMerge !== false;
    openModal(
      `<h2>${tr('スプリントのブランチをマージ')}</h2>
       <p>${tr('スプリント「{name}」のブランチ <code>{branch}</code> を <code>{base}</code> にマージします。', { name: esc(cy.name), branch: esc(cy.branch), base: esc(base) })}</p>
       <label class="check"><input type="checkbox" id="cbPush" ${push ? 'checked' : ''} /> ${tr('マージしたあと origin にも push する')}</label>
       <div class="modal-actions"><span class="spacer"></span><button class="btn ghost" id="cbCancel">${tr('キャンセル')}</button><button class="btn primary" id="cbOk">${tr('マージ')}</button></div>`,
      () => {
        $('cbCancel').onclick = closeModal;
        $('cbOk').onclick = async () => {
          const p = $('cbPush').checked;
          const r = await runBusy(tr('スプリントのブランチをマージしています…'), () => api.mergeSprintBranch(cy.id, p));
          if (!r) return;
          closeModal();
          toast(r.merged ? tr('{target} にマージしました', { target: r.target }) : tr('{target} にはもう取り込まれているので、マージする変更はありませんでした', { target: r.target }), 'ok');
        };
      },
    );
  }
  // スプリントのブランチから、作成元（ベース）のブランチへの PR を作る
  async function prBranch(cy) {
    const base = cy.branchBase || state.board.settings.baseBranch || tr('ベース');
    if (!confirm(tr('スプリント「{name}」のブランチ {branch} を origin に push して、{base} への PR を作りますか？', { name: cy.name, branch: cy.branch, base }))) return;
    const r = await runBusy(tr('PR を作成しています…'), () => api.sprintPullRequest(cy.id, {}));
    if (r && r.url) toast(r.created === false ? tr('開いている PR を更新しました: {url}', { url: r.url }) : tr('PR を作成しました: {url}', { url: r.url }), 'ok');
  }

  // スプリントの作成・編集（cy が null なら作成）。作ったら、そのスプリントを選ぶ
  function openEditor(cy, onCreated) {
    if (!state.board.settings.repoPath) return toast(tr('先にリポジトリを開いてください'));
    const v = cy || { name: '', startDate: '', endDate: '', goal: '' };
    openModal(
      `<h2>${cy ? tr('スプリントを編集') : tr('新しいスプリント')}</h2>
       <p class="muted small">${tr('期間とゴールを決めて、タスクをまとめます。スプリントを選ぶと、そのスプリントのタスクだけがボードに出ます。')}</p>
       <label class="field"><span>${tr('名前')}</span><input id="cyName" maxlength="${M().NAME_MAX}" value="${esc(v.name)}" placeholder="${esc(tr('例: 11月前半・v0.2 リリース'))}" /></label>
       <div class="row cy-dates">
         <label class="field"><span>${tr('開始日（任意）')}</span><input id="cyStart" type="date" value="${esc(v.startDate)}" /></label>
         <label class="field"><span>${tr('終了日（任意）')}</span><input id="cyEnd" type="date" value="${esc(v.endDate)}" /></label>
       </div>
       <label class="field"><span>${tr('ゴール（任意）')}</span><textarea id="cyGoal" rows="4" maxlength="${M().GOAL_MAX}" placeholder="${esc(tr('例: ログインまわりの不具合をなくす'))}">${esc(v.goal)}</textarea></label>
       <div class="modal-actions">
         ${cy ? `<button class="btn danger" id="cyDelete">${tr('削除')}</button><button class="btn ghost" id="cyDone">${cy.done ? tr('未完了に戻す') : tr('完了にする')}</button><span class="spacer"></span>` : ''}
         <button class="btn ghost" id="cyCancel">${tr('キャンセル')}</button><button class="btn primary" id="cyOk">${cy ? tr('保存') : tr('作成')}</button>
       </div>`,
      () => {
        $('cyName').focus();
        $('cyCancel').onclick = closeModal;
        const read = () => ({ name: $('cyName').value, startDate: $('cyStart').value, endDate: $('cyEnd').value, goal: $('cyGoal').value });
        $('cyOk').onclick = async () => {
          const p = read();
          const err = M().cycleError(p);
          if (err) return toast(err);
          const r = await runBusy(cy ? tr('スプリントを保存しています…') : tr('スプリントを作成しています…'), () => (cy ? api.updateCycle(cy.id, p) : api.createCycle(p)), cy ? tr('スプリントを保存しました') : tr('スプリントを作成しました'));
          if (!r) return;
          closeModal();
          if (!cy && r.id) {
            if (mode() !== 'lanes') setSelection(r.id);
            onCreated?.(r);
          }
        };
        if (!cy) return;
        $('cyDone').onclick = async () => {
          closeModal();
          await setDone(cy, !cy.done);
        };
        $('cyDelete').onclick = async () => {
          if (!confirm(tr('スプリント「{name}」を削除しますか？\n中のタスクは消さずに、このスプリントから外します。', { name: cy.name }))) return;
          const r = await runBusy(tr('スプリントを削除しています…'), () => api.deleteCycle(cy.id), tr('スプリントを削除しました'));
          if (r) closeModal();
        };
      },
    );
  }

  // 新しいタスクを入れるスプリント（スプリントを選んでいるときは、そのスプリント）
  function newTaskIds() {
    return M().newTaskCycleIds(selection(), cycles());
  }

  // 選べるスプリント: 完了していないもの（と、もう入っている完了したもの）
  function pickable(ids) {
    return M().sortCycles(cycles().filter((cy) => !cy.done || ids.includes(cy.id)));
  }
  function checksHtml(idp, ids) {
    const list = pickable(ids);
    if (!list.length) return `<small class="muted">${tr('スプリントはまだありません。ボードの「＋ スプリント」から作れます。')}</small>`;
    return `<div class="cy-checks" id="${idp}Cycles">${list
      .map((cy) => {
        const period = M().periodLabel(cy);
        return `<label class="check" title="${esc(itemTitle(cy))}"><input type="checkbox" value="${esc(cy.id)}" ${ids.includes(cy.id) ? 'checked' : ''} /> ${esc(cy.name)}${period ? ` <span class="muted small">${esc(period)}</span>` : ''}${cy.done ? ` <span class="cy-state cy-done">${tr('完了')}</span>` : ''}</label>`;
      })
      .join('')}</div>`;
  }
  // 新しいタスクのダイアログの欄（スプリントがなければ出さない）
  function fieldHtml(idp, ids) {
    if (!cycles().some((cy) => !cy.done)) return '';
    return `<div class="field"><span>${tr('スプリント（いくつでも）')}</span>${checksHtml(idp, ids || [])}</div>`;
  }
  function readField(idp) {
    const box = $(`${idp}Cycles`);
    if (!box) return undefined;
    return [...box.querySelectorAll('input[type=checkbox]:checked')].map((x) => x.value);
  }

  // 詳細の上の段の「スプリント」ボタン（会話・サブタスクには出さない）
  function detailButtonHtml(c) {
    if (isChat(c) || isHiddenSubtask(c)) return '';
    const names = idsOf(c).map((id) => findCycle(id)).filter(Boolean).map((cy) => cy.name);
    const title = names.length ? tr('入っているスプリント: {names}', { names: names.join(tr('、')) }) : tr('どのスプリントにも入っていません');
    return `<button class="btn ghost" data-act="cycles" title="${esc(title)}">${icon('flag')}${names.length ? tr('スプリント（{n}）', { n: names.length }) : tr('スプリント')}</button>`;
  }
  // 複数のスプリントを選んだときに、ブランチを使うスプリントを選ぶ欄（設定「スプリントごとにブランチを作る」のとき）
  function branchPickHtml(ids, chosen) {
    const list = M().sortCycles(cycles().filter((cy) => ids.includes(cy.id) && !cy.done));
    if (!branchMode() || list.length < 2) return '';
    return `<label class="field"><span>${tr('ブランチを使うスプリント')}</span><select id="ccBranch">
        <option value="">${tr('選ばない（ベースブランチから始める）')}</option>
        ${list.map((cy) => `<option value="${esc(cy.id)}" ${cy.id === chosen ? 'selected' : ''}>${esc(cy.name)}${cy.branch ? ` (${esc(cy.branch)})` : ''}</option>`).join('')}
      </select><small>${tr('複数のスプリントに入っているので、どのスプリントのブランチから始めて、どこへマージするかを選びます。')}</small></label>`;
  }
  function openCardCycles(c) {
    const ids = idsOf(c);
    openModal(
      `<h2>${tr('タスクを入れるスプリント')}</h2>
       <p class="muted small">${tr('「{title}」を入れるスプリントを選びます（いくつでも。どれも選ばなければ「未割り当て」）。', { title: esc(c.title) })}</p>
       <div id="ccBox">${checksHtml('cc', ids)}</div>
       <div id="ccBranchBox">${branchPickHtml(ids, c.branchCycleId || '')}</div>
       <div class="modal-actions"><button class="btn ghost" id="ccNew">${icon('plus')}${tr('新しいスプリント')}</button><span class="spacer"></span><button class="btn ghost" id="ccCancel">${tr('キャンセル')}</button><button class="btn primary" id="ccOk">${tr('保存')}</button></div>`,
      () => {
        $('ccCancel').onclick = closeModal;
        $('ccNew').onclick = () => openEditor(null, () => openCardCycles(card(c.id) || c));
        // チェックを変えたら、ブランチを使うスプリントの欄を作り直す（選んでいたものは残す）
        const box = $('ccCycles');
        if (box) {
          box.onchange = () => {
            const prev = $('ccBranch') ? $('ccBranch').value : c.branchCycleId || '';
            $('ccBranchBox').innerHTML = branchPickHtml(readField('cc') || [], prev);
          };
        }
        $('ccOk').onclick = async () => {
          const next = readField('cc') || [];
          const branchCycleId = $('ccBranch') ? $('ccBranch').value : undefined;
          const r = await runBusy(tr('スプリントを保存しています…'), () => api.setCardCycles(c.id, next, branchCycleId), tr('スプリントを保存しました'));
          if (r) closeModal();
        };
      },
    );
  }
  function card(id) {
    return state.board.cards.find((x) => x.id === id);
  }

  // ---- ドラッグ&ドロップ ----
  // スプリントへ動かせるカードか（スプリントがあり、会話・親に入っているサブタスクでない）
  function canDrag(c) {
    return !!c && cycles().length > 0 && !isChat(c) && !isHiddenSubtask(c);
  }
  // タブ・サイドバーのスプリント（'none' は外す）へ落とせるか（もう入っているなら光らせない）
  function canDropOn(c, target) {
    if (!canDrag(c) || !target || target === M().ALL) return false;
    const ids = idsOf(c);
    if (target === M().NONE) return ids.length > 0;
    const cy = findCycle(target);
    return !!cy && !cy.done && !ids.includes(target);
  }
  async function dropOn(c, target) {
    if (!canDropOn(c, target)) return;
    const next = M().dropCycleIds(idsOf(c), target);
    const cy = findCycle(target);
    await runBusy(tr('スプリントを保存しています…'), () => api.setCardCycles(c.id, next), cy ? tr('スプリント「{name}」に入れました', { name: cy.name }) : tr('スプリントから外しました'));
  }
  // スイムレーンで、別の段へ動かせるか
  function canLaneDrop(c, from, to) {
    if (!canDrag(c) || !to || from === to) return false;
    if (to === M().NONE) return true;
    const cy = findCycle(to);
    return !!cy && !cy.done;
  }
  async function moveLane(c, from, to) {
    if (!canLaneDrop(c, from, to)) return;
    const next = M().dropCycleIds(idsOf(c), to, from);
    await runBusy(tr('スプリントを保存しています…'), () => api.setCardCycles(c.id, next));
  }

  root.CycleView = { mode, cycles, selection, inView, chromeHtml, lanesHtml, bindChrome, chipsHtml, newTaskIds, fieldHtml, readField, detailButtonHtml, openCardCycles, openEditor, canDrag, canDropOn, dropOn, canLaneDrop, moveLane };
})(typeof self !== 'undefined' ? self : this);
