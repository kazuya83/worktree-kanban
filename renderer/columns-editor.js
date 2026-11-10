// 設定の「ボードの列」: 列とレーンを足す・消す・名前と説明を書く・並べ替える。
// 保存するときは、AI に説明を「段階＋条件＋次に進んでよい列」へ変換してもらい、結果を確かめてから
// リポジトリの .worktree-kanban/board.json に書く（説明が前と同じなら AI は呼ばずに、前の変換を使う）
// ColumnsEditor.render(box, { config, exists, error, file }) で描く
/* global api, esc, tr, toast, runBusy, BoardColumns */
(function (root) {
  const BC = () => root.BoardColumns;
  const clone = (v) => JSON.parse(JSON.stringify(v));
  let seq = 0;
  const newId = (prefix, taken) => {
    let id;
    do id = `${prefix}${Date.now().toString(36)}${(seq++).toString(36)}`.slice(0, 32);
    while (taken.includes(id));
    return id;
  };

  function render(box, status) {
    if (!box) return;
    const saved = BC().cleanConfig((status && status.config) || BC().defaultConfig());
    const view = { draft: clone(saved), preview: null, busy: false };

    // 説明が前の保存と同じなら、前の変換（段階・条件・次の列）をそのまま使える
    function reuseSaved(draft) {
      if (BC().descriptionKey(draft) !== BC().descriptionKey(saved)) return null;
      const byId = new Map(saved.columns.map((c) => [c.id, c]));
      return BC().cleanConfig({
        columns: draft.columns.map((c) => {
          const s = byId.get(c.id);
          const lanes = new Map(s.lanes.map((l) => [l.id, l]));
          return { ...c, stage: s.stage, when: s.when, next: s.next, lanes: c.lanes.map((l) => ({ ...l, when: (lanes.get(l.id) || {}).when || {} })) };
        }),
      });
    }

    function colHtml(c, i, n) {
      const multi = c.lanes.length > 1;
      const lanes = multi
        ? c.lanes
            .map(
              (l, j) => `<div class="bc-lane" data-lane="${j}">
            <div class="bc-row">
              <input class="bc-lane-name" data-f="name" maxlength="${BC().NAME_MAX}" placeholder="${esc(tr('レーンの名前（例: Done）'))}" value="${esc(l.name)}" />
              <span class="bc-tools">
                <button class="btn small ghost" type="button" data-act="laneUp" ${j === 0 ? 'disabled' : ''} title="${esc(tr('上へ'))}">↑</button>
                <button class="btn small ghost" type="button" data-act="laneDown" ${j === c.lanes.length - 1 ? 'disabled' : ''} title="${esc(tr('下へ'))}">↓</button>
                <button class="btn small ghost" type="button" data-act="laneDel" title="${esc(tr('このレーンを消す'))}">✕</button>
              </span>
            </div>
            <textarea class="bc-lane-desc" data-f="description" rows="2" maxlength="${BC().DESC_MAX}" placeholder="${esc(tr('このレーンに入れるタスクを、文章で書いてください（例: マージしたタスク）'))}">${esc(l.description)}</textarea>
          </div>`,
            )
            .join('')
        : '';
      return `<div class="bc-col" data-col="${i}">
        <div class="bc-row">
          <input class="bc-col-name" data-f="name" maxlength="${BC().NAME_MAX}" placeholder="${esc(tr('列の名前（例: QA）'))}" value="${esc(c.name)}" />
          <span class="bc-tools">
            <button class="btn small ghost" type="button" data-act="colUp" ${i === 0 ? 'disabled' : ''} title="${esc(tr('左へ'))}">←</button>
            <button class="btn small ghost" type="button" data-act="colDown" ${i === n - 1 ? 'disabled' : ''} title="${esc(tr('右へ'))}">→</button>
            <button class="btn small ghost" type="button" data-act="colDel" ${n <= 1 ? 'disabled' : ''} title="${esc(tr('この列を消す'))}">✕</button>
          </span>
        </div>
        <textarea class="bc-col-desc" data-f="description" rows="2" maxlength="${BC().DESC_MAX}" placeholder="${esc(tr('この列に入れるタスクと、どの列へ進めるかを文章で書いてください（例: レビューが終わって、マージを待っているタスク。次は完了へ進める）'))}">${esc(c.description)}</textarea>
        ${multi ? `<div class="bc-lanes"><small class="muted">${tr('レーン（列の中を上下に区切ります。上から順に、説明に合うレーンに入ります）')}</small>${lanes}</div>` : ''}
        <div><button class="btn small" type="button" data-act="laneAdd" ${c.lanes.length >= BC().MAX_LANES ? 'disabled' : ''}>${multi ? tr('＋ レーンを追加') : tr('＋ レーンに分ける')}</button></div>
      </div>`;
    }

    function previewHtml(p) {
      const cols = p.columns
        .map((c, i) => {
          const next = p.columns
            .filter((x) => x.id !== c.id)
            .map((x) => `<label class="check bc-next"><input type="checkbox" data-pnext="${i}" value="${esc(x.id)}" ${c.next.includes(x.id) ? 'checked' : ''} />${esc(x.name)}</label>`)
            .join('');
          const lanes = c.lanes.length > 1 ? `<ul class="bc-plane">${c.lanes.map((l) => `<li><b>${esc(l.name)}</b>: ${esc(BC().describeWhen(l.when))}</li>`).join('')}</ul>` : '';
          return `<div class="bc-pcol">
          <div class="bc-row"><b>${esc(c.name)}</b>
            <label class="bc-stage">${tr('段階')}
              <select data-pstage="${i}">${BC().STAGES.map((s) => `<option value="${s}" ${s === c.stage ? 'selected' : ''}>${esc(BC().stageLabel(s))}</option>`).join('')}</select>
            </label></div>
          <div class="small">${tr('条件')}: ${esc(BC().describeWhen(c.when))}</div>
          ${lanes}
          <div class="small bc-nexts">${tr('次に進んでよい列')}: ${next || `<span class="muted">${tr('なし')}</span>`}</div>
        </div>`;
        })
        .join('');
      const errors = BC().validateConfig(p);
      return `<div class="bc-preview">
        <b>${tr('変換の結果を確かめてください')}</b>
        <small class="muted">${tr('カードは、段階が合う列のうち左から順に条件が合う列に、列の中では上から順に条件が合うレーンに入ります。段階と次に進んでよい列は、ここで直せます。条件を直したいときは、説明を書き直してもう一度変換してください。')}</small>
        ${cols}
        ${errors.length ? `<div class="bc-errors">${errors.map((e) => `<div>${esc(e)}</div>`).join('')}</div>` : ''}
        <div class="cf-actions"><button class="btn primary" type="button" data-act="save" ${errors.length ? 'disabled' : ''}>${tr('この内容で保存')}</button><button class="btn ghost" type="button" data-act="cancelPreview">${tr('やめる')}</button></div>
      </div>`;
    }

    function draw() {
      const d = view.draft;
      const st = status || {};
      const where = st.exists
        ? tr('{file} の設定を使っています。コミットすると、チームで同じ列を使えます。', { file: st.file || '.worktree-kanban/board.json' })
        : tr('まだ設定していないので、今までの4つの列（Todo・実行中・レビュー・完了）を使っています。保存すると {file} に書きます。', { file: st.file || '.worktree-kanban/board.json' });
      box.innerHTML = `<small class="muted s-note">${esc(where)}</small>
        ${st.error ? `<div class="bc-errors">${esc(tr('{file} を読めなかったので、今までの4つの列を使っています: {error}', { file: st.file || '', error: st.error }))}</div>` : ''}
        <small class="muted s-note">${tr('列とレーンには、どんなタスクを入れるかの説明を必ず書きます。保存するときに AI が説明を「段階（Todo・実行中・レビュー・完了）と条件」に変換し、カードはその条件で自動で振り分けます。手でドラッグできるのは「次に進んでよい列」と、同じ列の中のレーンだけです。手で動かしたカードも、状態が変わるとまた条件で振り分けます。')}</small>
        <div class="bc-cols">${d.columns.map((c, i) => colHtml(c, i, d.columns.length)).join('')}</div>
        <div class="pl-tools">
          <button class="btn small" type="button" data-act="colAdd" ${d.columns.length >= BC().MAX_COLUMNS ? 'disabled' : ''}>${tr('＋ 列を追加')}</button>
          <button class="btn small primary" type="button" data-act="convert">${tr('変換して確かめる')}</button>
          ${st.exists ? `<button class="btn small ghost" type="button" data-act="reset">${tr('今までの4つの列に戻す')}</button>` : ''}
        </div>
        ${view.preview ? previewHtml(view.preview) : ''}`;
    }

    // 入力は描き直さずに draft に入れる（フォーカスを失わないように）。変えたら変換の結果は捨てる
    box.oninput = (e) => {
      const f = e.target.dataset.f;
      if (!f) return;
      const ci = Number(e.target.closest('[data-col]')?.dataset.col);
      const col = view.draft.columns[ci];
      if (!col) return;
      const li = e.target.closest('[data-lane]');
      const target = li ? col.lanes[Number(li.dataset.lane)] : col;
      if (target) target[f] = e.target.value;
      if (view.preview) {
        view.preview = null;
        box.querySelector('.bc-preview')?.remove();
      }
    };
    box.onchange = (e) => {
      const p = view.preview;
      if (!p) return;
      if (e.target.dataset.pstage !== undefined) {
        p.columns[Number(e.target.dataset.pstage)].stage = e.target.value;
        draw();
      } else if (e.target.dataset.pnext !== undefined) {
        const c = p.columns[Number(e.target.dataset.pnext)];
        c.next = e.target.checked ? [...new Set([...c.next, e.target.value])] : c.next.filter((x) => x !== e.target.value);
      }
    };
    box.onclick = async (e) => {
      const b = e.target.closest('[data-act]');
      if (!b || b.disabled || view.busy) return;
      const d = view.draft;
      const ci = Number(b.closest('[data-col]')?.dataset.col);
      const li = Number(b.closest('[data-lane]')?.dataset.lane);
      const col = d.columns[ci];
      const swap = (arr, a, z) => ([arr[a], arr[z]] = [arr[z], arr[a]]);
      const act = b.dataset.act;
      if (act === 'colAdd') d.columns.push({ id: newId('c', d.columns.map((c) => c.id)), name: '', description: '', stage: '', when: {}, next: [], lanes: [{ id: 'main', name: '', description: '', when: {} }] });
      else if (act === 'colUp' && ci > 0) swap(d.columns, ci, ci - 1);
      else if (act === 'colDown' && ci < d.columns.length - 1) swap(d.columns, ci, ci + 1);
      else if (act === 'colDel' && col) {
        if (!confirm(tr('「{name}」の列を消しますか？（保存するまでは、ファイルは変わりません）', { name: col.name || '?' }))) return;
        d.columns.splice(ci, 1);
      } else if (act === 'laneAdd' && col) {
        const ids = col.lanes.map((l) => l.id);
        // 1つ目のレーンには、列の名前を仮に入れておく
        if (col.lanes.length === 1 && !col.lanes[0].name) Object.assign(col.lanes[0], { name: col.name, description: col.lanes[0].description || col.description });
        col.lanes.push({ id: newId('l', ids), name: '', description: '', when: {} });
      } else if (act === 'laneUp' && col && li > 0) swap(col.lanes, li, li - 1);
      else if (act === 'laneDown' && col && li < col.lanes.length - 1) swap(col.lanes, li, li + 1);
      else if (act === 'laneDel' && col) col.lanes.splice(li, 1);
      else if (act === 'cancelPreview') view.preview = null;
      else if (act === 'convert') return convert();
      else if (act === 'save') return save();
      else if (act === 'reset') return reset();
      else return;
      if (act !== 'cancelPreview') view.preview = null;
      draw();
    };

    async function convert() {
      const draft = BC().cleanConfig(view.draft);
      const errors = BC().validateConfig(draft, { needStage: false });
      if (errors.length) return toast(errors.join('\n'), 'error');
      const reused = reuseSaved(draft);
      if (reused && !BC().validateConfig(reused).length) {
        view.preview = reused;
        return draw();
      }
      view.busy = true;
      try {
        const out = await runBusy(tr('AI が列の説明を条件に変換しています…'), () => api.convertColumns({ draft }));
        if (out) view.preview = BC().cleanConfig(out);
      } finally {
        view.busy = false;
      }
      draw();
    }

    async function save() {
      const p = view.preview;
      if (!p) return;
      const errors = BC().validateConfig(p);
      if (errors.length) return toast(errors.join('\n'), 'error');
      const st = await runBusy(tr('列の設定を保存しています…'), () => api.saveColumns(p), tr('列の設定を保存しました'));
      if (st) render(box, st);
    }

    async function reset() {
      if (!confirm(tr('今までの4つの列（Todo・実行中・レビュー・完了）に戻しますか？ {file} を消します。', { file: (status && status.file) || '' }))) return;
      const st = await runBusy(tr('列の設定を戻しています…'), () => api.resetColumns(), tr('今までの4つの列に戻しました'));
      if (st) render(box, st);
    }

    draw();
  }

  root.ColumnsEditor = { render };
})(typeof globalThis !== 'undefined' ? globalThis : this);
