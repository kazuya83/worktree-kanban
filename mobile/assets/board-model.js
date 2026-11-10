// スマホ用の画面で使う、ボードとカードの見方（デスクトップの renderer.js と同じ決まり）。
// 列・状態のバッジ・確認待ち・未読・追加指示を送れるか・列を動かせるか・タスクを作るときのエージェントの選択肢。
// DOM には触らない。画面（<script>）とテスト（require）の両方から使う。
(function (root, factory) {
  const api = factory(root);
  if (typeof module === 'object' && module.exports) module.exports = api;
  else root.BoardModel = api;
})(typeof globalThis !== 'undefined' ? globalThis : this, function (root) {
  function tr(key, vars) {
    const i18n = typeof module === 'object' && module.exports ? require('../../renderer/i18n.js') : root.I18n;
    if (i18n) return i18n.tr(key, vars);
    return vars ? String(key).replace(/\{(\w+)\}/g, (m, k) => (k in vars ? String(vars[k]) : m)) : key;
  }

  const COLUMNS = [
    { key: 'todo', label: () => 'Todo', statuses: ['todo'] },
    { key: 'running', label: () => tr('実行中'), statuses: ['queued', 'running'] },
    { key: 'review', label: () => tr('レビュー'), statuses: ['review', 'failed'] },
    { key: 'done', label: () => tr('完了'), statuses: ['done'] },
  ];
  const STATUS_LABEL = () => ({ todo: tr('未着手'), queued: tr('待機中'), running: tr('実行中'), review: tr('レビュー待ち'), failed: tr('エラー'), done: tr('マージ済み') });
  const CHAT_STATUS_LABEL = () => ({ todo: tr('未開始'), queued: tr('待機中'), running: tr('返答中'), review: tr('返事済み'), failed: tr('エラー'), done: tr('終了') });

  const AGENTS = [
    ['claude', 'Claude Code', 'Claude'],
    ['codex', 'Codex CLI', 'Codex'],
    ['antigravity', 'Antigravity CLI', 'Antigravity'],
    ['gemini', 'Gemini CLI', 'Gemini'],
    ['cursor', 'Cursor CLI', 'Cursor'],
    ['opencode', 'OpenCode', 'OpenCode'],
    ['copilot', 'Copilot CLI', 'Copilot'],
    ['amp', 'Amp', 'Amp'],
    ['pi', 'Pi', 'Pi'],
    ['droid', 'Droid', 'Droid'],
  ];
  const agentOf = (c) => (c && AGENTS.some((x) => x[0] === c.agent) ? c.agent : 'claude');
  const agentLabel = (a) => (AGENTS.find((x) => x[0] === a) || AGENTS[0])[1];
  const agentShort = (a) => (AGENTS.find((x) => x[0] === a) || AGENTS[0])[2];
  // 返事の名前（カスタムエージェントならその名前。Pipeline は工程ごとに変わるので CLI の名前）
  const whoShort = (c, agent) => (c && c.persona && c.persona.name && !c.relay ? String(c.persona.name) : agentShort(agent || agentOf(c)));

  const isChat = (c) => !!c && c.kind === 'chat';
  const isNoGit = (c) => !!c && !!c.noGit;
  const isActive = (c) => !!c && (c.status === 'running' || c.status === 'queued');
  const isInterrupted = (c) => !!c && !!c.interrupted && !isActive(c);
  const isSpecPending = (c) => !!c && c.specState === 'pending' && (c.status === 'review' || c.status === 'failed');
  const specQuestions = (c) => (isSpecPending(c) && Array.isArray(c.specQuestions) && c.specQuestions.length ? c.specQuestions : null);
  const hasSubtasks = (c) => !!(c && c.subtasks && Array.isArray(c.subtasks.items) && c.subtasks.items.length);
  const subtasksRunning = (c) => !!(c && c.subtasks && c.subtasks.phase === 'run');
  const hasSubtaskProposal = (c) => !!(c && c.subtaskProposal && Array.isArray(c.subtaskProposal.items) && (c.status === 'review' || c.status === 'failed'));

  // cards: ボードのカードの一覧（サブタスクの親を探すのに使う）
  // ボードの列とレーン（デスクトップと同じ renderer/board-columns.js。プロジェクトの .worktree-kanban/board.json）
  const BCols = () => (typeof module === 'object' && module.exports ? require('../../renderer/board-columns.js') : root.BoardColumns);

  // config: ボードの列の設定（board.boardColumns.config。省くと今までの4つの列）
  function model(cards, config) {
    const list = Array.isArray(cards) ? cards : [];
    const cfg = BCols().cleanConfig(config && Array.isArray(config.columns) && config.columns.length ? config : BCols().defaultConfig());
    // 画面に出す列（key・label・レーン）
    const columns = () => cfg.columns.map((c) => ({ key: c.id, label: () => c.name, stage: c.stage, description: c.description, lanes: c.lanes }));
    const places = new Map();
    const placeOf = (c) => {
      if (!c) return null;
      if (!places.has(c)) places.set(c, BCols().placeOf(cfg, c));
      return places.get(c);
    };
    const byId = new Map(list.map((c) => [c && c.id, c]));
    const card = (id) => byId.get(id);
    const subtaskParent = (c) => (c && c.subtaskOf ? card(c.subtaskOf.parent) || null : null);
    // ボードに出さないカード（親が残っているサブタスク）
    const isHiddenSubtask = (c) => !!subtaskParent(c);
    const subItemOf = (k) => {
      const p = subtaskParent(k);
      return p && hasSubtasks(p) ? p.subtasks.items.find((x) => x.cardId === k.id) : null;
    };
    const subtaskReady = (k) =>
      !!k && !!k.worktreePath && (k.status === 'review' || k.status === 'failed') && !k.awaitingReply && !isSpecPending(k) && !k.conflict && !isInterrupted(k) && !(k.questions || []).length && !(k.permissions || []).length;
    const subtaskChecked = (k) => {
      const p = subtaskParent(k);
      const item = subItemOf(k);
      return !!p && (p.subtasks.merge === 'review' || !!(item && item.manual));
    };
    // あなたの確認（親のタスクに取り込む）を待っているサブタスクか
    const subtaskNeedsCheck = (k) => subtaskChecked(k) && !(k.subtaskOf && k.subtaskOf.approved) && subtaskReady(k) && k.status === 'review';
    const subKids = (c) => (hasSubtasks(c) ? c.subtasks.items.filter((x) => x.cardId && x.state === 'running').map((x) => card(x.cardId)).filter(Boolean) : []);
    const subNeedsYou = (c) => subKids(c).some((k) => needsYou(k) || subtaskNeedsCheck(k));

    function needsYou(c) {
      if (!c) return false;
      if (subtasksRunning(c) && subNeedsYou(c)) return true;
      if (hasSubtaskProposal(c)) return true;
      return !!(isInterrupted(c) || (c.questions || []).length || (c.permissions || []).length || (c.awaitingReply && c.status === 'review') || (c.conflict && !c.conflict.resolving && c.status === 'review'));
    }

    // カードの状態のバッジ [種類, 文字]。質問・承認待ち・回答待ちを優先して出す
    function badge(c) {
      if (isInterrupted(c)) return ['interrupted', tr('中断')];
      if ((c.questions || []).length) return ['question', tr('質問')];
      if ((c.permissions || []).length) return ['waiting', tr('承認待ち')];
      if (c.conflict && !c.conflict.resolving && !isActive(c)) return ['conflict', tr('コンフリクト')];
      if (isSpecPending(c)) return ['spec', tr('仕様の確認')];
      if (c.prState === 'OPEN' && c.prChecks && c.prChecks.state === 'FAILURE' && (c.status === 'review' || c.status === 'failed')) return ['conflict', tr('CI 失敗')];
      if (hasSubtaskProposal(c)) return ['spec', tr('サブタスクの提案')];
      if (subtasksRunning(c) && (c.status === 'review' || c.status === 'failed')) return subNeedsYou(c) ? ['awaiting', tr('サブタスクが対応待ち')] : ['running', tr('サブタスク実行中')];
      if (c.subtaskOf && subtaskNeedsCheck(c)) return ['awaiting', tr('確認待ち')];
      if (c.relay && c.relay.waiting && c.status === 'review') return ['queued', tr('並列の枝を待機中')];
      if (c.awaitingReply && (c.status === 'review' || c.status === 'failed')) return ['awaiting', tr('回答待ち')];
      return [c.status, (isChat(c) ? CHAT_STATUS_LABEL() : STATUS_LABEL())[c.status] || String(c.status || '')];
    }

    // カードが今いる列とレーン（列とレーンの条件で振り分ける。サブタスクを動かしている親は「実行中」の段階）
    function columnOf(c) {
      return (placeOf(c) || {}).col || '';
    }
    function laneOf(c) {
      return (placeOf(c) || {}).lane || '';
    }
    // 対応が必要なものを上に、あとは新しい順
    const byAttention = (a, b) => (needsYou(b) ? 1 : 0) - (needsYou(a) ? 1 : 0) || (b.createdAt || 0) - (a.createdAt || 0);
    // 列ごとのカード（会話と、親が残っているサブタスクは出さない）
    function columnCards(key) {
      return list.filter((c) => c && !isChat(c) && !isHiddenSubtask(c) && columnOf(c) === key).sort(byAttention);
    }

    // 列を動かせるか（デスクトップのドラッグと同じ: Todo → 実行中で開始、レビュー ⇄ 完了）
    function canMove(c, to) {
      if (!c || isChat(c) || c.afterDone || isHiddenSubtask(c) || !['todo', 'review', 'failed', 'done'].includes(c.status)) return false;
      const from = BCols().stageOf(c);
      if (from === to) return false;
      if (from === 'todo') return to === 'running';
      if (from === 'review') return to === 'done';
      if (from === 'done') return to === 'review';
      return false;
    }

    // 開いているときに既読にする会話か
    const isUnreadChat = (c, selectedId) => isChat(c) && !!c.unread && !isActive(c) && selectedId !== c.id;

    return { columns, card, needsYou, badge, columnOf, laneOf, columnCards, byAttention, canMove, subtaskParent, isHiddenSubtask, subtaskNeedsCheck, subKids, isUnreadChat };
  }

  // 追加指示を送れる状態か（完了したタスクにも送れる。送ると、ファイルを変えずに話す）
  const canSendFollow = (c) => !!c && (c.status === 'review' || c.status === 'failed' || c.status === 'done');

  // 下の入力欄で何をするか: 'btw'（実行中の作業に差し込む）/ 'send'（追加指示）/ 'off'（送れない）
  function composerMode(c) {
    if (!c) return 'off';
    if (isActive(c)) return 'btw';
    if (canSendFollow(c) && !c.afterDone) return 'send';
    if (canSendFollow(c) && c.afterDone) return 'off';
    return 'off';
  }

  // 仕様の確認フォームの答えを、エージェントに送る文章にする（デスクトップと同じ形）
  function specAnswerMessage(questions, answers, note, auto) {
    const AUTO = tr('おまかせ（妥当な案で決めてください）');
    const lines = [tr('仕様の質問への答えです。'), ''];
    (questions || []).forEach((q, i) => {
      lines.push(`${i + 1}. ${q.question}`, `   → ${(!auto && answers && answers[q.question]) || AUTO}`);
    });
    if (note) lines.push('', tr('補足: {note}', { note }));
    return lines.join('\n');
  }

  // ---- タスクを作るときのエージェントの選択肢（設定で使うものだけ。デスクトップの新しいタスクと同じ並び） ----
  function enabledAgents(s) {
    const on = s && Array.isArray(s.enabledAgents) ? s.enabledAgents : ['claude'];
    const list = AGENTS.map((x) => x[0]).filter((a) => on.includes(a));
    return list.length ? list : ['claude'];
  }
  function defaultAgent(s) {
    const list = enabledAgents(s);
    return s && list.includes(s.defaultAgent) ? s.defaultAgent : list[0];
  }
  function pipelines(s) {
    if (s && Array.isArray(s.relayFlows) && s.relayFlows.length) return s.relayFlows;
    return s && s.relayFlow ? [{ id: 'default', name: 'Pipeline', flow: s.relayFlow }] : [];
  }
  // 競争の一覧（プロジェクトごとに複数）
  function competes(s) {
    return s && Array.isArray(s.competes) ? s.competes.filter((x) => x && x.id) : [];
  }
  function competeNames(s, set) {
    if (!set) return [];
    const on = enabledAgents(s);
    const custom = Array.isArray(s && s.customAgents) ? s.customAgents : [];
    const plain = (set.agents || []).filter((a) => on.includes(a)).map(agentShort);
    const named = (set.customAgents || []).map((id) => custom.find((x) => x && x.id === id)).filter((ca) => ca && on.includes(ca.agent)).map((ca) => ca.name);
    return [...plain, ...named];
  }
  // フローに工程があるか（細かい確かめはアプリ側。作るときにエラーなら知らせる）
  const pipelineUsable = (p) => !!(p && p.flow && Array.isArray(p.flow.nodes) && p.flow.nodes.some((n) => n && n.type !== 'start' && n.type !== 'end'));

  /**
   * @returns {{ groups: Array<{ label: string, options: Array<{ value: string, label: string, disabled?: boolean }> }>, value: string }}
   */
  function agentChoices(s) {
    const settings = s || {};
    const on = enabledAgents(settings);
    const groups = [];
    groups.push({ label: tr('1つのエージェントで動かす'), options: AGENTS.filter(([a]) => on.includes(a)).map(([a, l]) => ({ value: a, label: l })) });
    const cas = Array.isArray(settings.customAgents) ? settings.customAgents.filter((x) => x && x.id) : [];
    if (cas.length) {
      groups.push({
        label: tr('カスタムエージェント'),
        options: cas.map((ca) => ({
          value: `custom:${ca.id}`,
          label: tr('{icon}{name}（{agent}{model}）{off}', { icon: ca.icon ? `${ca.icon} ` : '', name: ca.name || '?', agent: agentShort(ca.agent), model: ca.model ? ` / ${ca.model}` : '', off: on.includes(ca.agent) ? '' : tr('（使わない設定）') }),
          disabled: !on.includes(ca.agent),
        })),
      });
    }
    const pipes = pipelines(settings);
    if (pipes.length) groups.push({ label: 'Pipeline', options: pipes.map((p) => ({ value: `relay:${p.id}`, label: String(p.name || 'Pipeline'), disabled: !pipelineUsable(p) })) });
    const comps = competes(settings).map((x) => ({ x, names: competeNames(settings, x) }));
    if (comps.length) {
      groups.push({
        label: tr('競争'),
        options: comps.map(({ x, names }) => ({
          value: `compete:${x.id}`,
          label: names.length >= 2 ? tr('{name}: {names}', { name: x.name, names: names.join(tr('・')) }) : tr('{name}（設定で使うエージェントを2つ以上選んでください）', { name: x.name }),
          disabled: names.length < 2,
        })),
      });
    }
    // 最初から選んでおくもの（設定で決めたもの。Pipeline・競争・カスタムエージェントも選べる。使えなければ1つのエージェント）
    const pick = settings.defaultAgent;
    const value = groups.some((g) => g.options.some((o) => o.value === pick && !o.disabled)) ? pick : defaultAgent(settings);
    return { groups, value };
  }

  // 通知のある未読のカード（ベルの未読が残っているタスク）
  function unreadCardIds(notifications) {
    return new Set((Array.isArray(notifications) ? notifications : []).filter((n) => n && !n.read && n.cardId).map((n) => n.cardId));
  }

  return {
    COLUMNS,
    AGENTS,
    model,
    agentOf,
    agentLabel,
    agentShort,
    whoShort,
    isChat,
    isNoGit,
    isActive,
    isInterrupted,
    isSpecPending,
    specQuestions,
    hasSubtasks,
    subtasksRunning,
    hasSubtaskProposal,
    canSendFollow,
    composerMode,
    specAnswerMessage,
    agentChoices,
    enabledAgents,
    defaultAgent,
    unreadCardIds,
  };
});
