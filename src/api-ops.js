// API（CLI・MCP）向けの操作 api:*（Electron に依存しない）。
// 画面のチャンネル（board:get など）は「今開いているリポジトリ」が前提なので、
// ここではリポジトリを指定して、画面のタブを切り替えずに読む・作るものを用意する
const { tr } = require('../renderer/i18n');
const { cleanRepoTabs, repoTabSummary } = require('./store');

const pipelinesOf = (rs) => (rs && Array.isArray(rs.relayFlows) ? rs.relayFlows : []);

const STATUSES = ['todo', 'queued', 'running', 'review', 'failed', 'done'];

// 一覧に出す、タスクの短い形
function taskSummary(c) {
  return {
    id: c.id,
    title: c.title || '',
    status: c.status,
    kind: c.kind === 'chat' ? 'chat' : 'task',
    agent: c.agent || '',
    model: c.model || '',
    permissionMode: c.permissionMode || '',
    repoPath: c.repoPath || '',
    branch: c.branch || '',
    subtaskOf: c.subtaskOf || null,
    pendingPermissions: (c.permissions || []).length,
    pendingQuestions: (c.questions || []).length,
    awaitingReply: !!c.awaitingReply,
    prUrl: c.prUrl || (c.pr && c.pr.url) || '',
    costUsd: typeof c.costUsd === 'number' ? c.costUsd : undefined,
    createdAt: c.createdAt || 0,
    updatedAt: c.updatedAt || c.finishedAt || c.startedAt || c.createdAt || 0,
  };
}

// 1 件の詳しい形（ログと差分は別に取る。指示文・承認待ち・質問は出す）
function taskDetail(c) {
  return {
    ...taskSummary(c),
    prompt: c.prompt || '',
    worktreePath: c.worktreePath || '',
    baseBranch: c.baseBranch || '',
    error: c.error || '',
    permissions: (c.permissions || []).map((p) => ({ reqId: p.id, toolName: p.toolName, summary: p.summary || '', at: p.at || 0 })),
    questions: (c.questions || []).map((q) => ({ reqId: q.id, questions: (q.questions || []).map((x) => ({ question: x.question, header: x.header || '', multiSelect: !!x.multiSelect, options: (x.options || []).map((o) => ({ label: o.label, description: o.description || '' })) })), at: q.at || 0 })),
    subtasks: c.subtasks ? { phase: c.subtasks.phase || '', items: (c.subtasks.items || []).map((s) => ({ key: s.key, title: s.title, cardId: s.cardId || null, status: s.status || '' })) } : null,
    mergedAt: c.mergedAt || 0,
    finishedAt: c.finishedAt || 0,
  };
}

/**
 * @param {{ store: object, agents: object, addRepo?: (dir: string) => Promise<string> }} deps
 *   addRepo: まだタブに無いリポジトリをタブに足す（今のタブは切り替えない）。git の一番上のフォルダを返す
 */
function createApiOps({ store, agents, addRepo }) {
  const repoList = () => repoTabSummary(cleanRepoTabs(store.settings.repoTabs, store.settings.repoPath), store.cards, store.settings);

  // repo の指定（パス）を、知っているリポジトリに合わせる。空なら今開いているリポジトリ
  const resolveRepo = (repo) => {
    const want = String(repo || '').trim().replace(/[\\/]+$/, '');
    if (!want) return store.settings.repoPath || '';
    const tabs = repoList().map((t) => t.path);
    const hit = tabs.find((p) => p === want) || tabs.find((p) => p.replace(/[\\/]+$/, '') === want);
    return hit || want;
  };

  const findTask = (id) => {
    const c = store.card(String(id || ''));
    if (!c) throw new Error(tr('タスクが見つかりません'));
    return c;
  };

  const ops = {
    status() {
      return { currentRepo: store.settings.repoPath || '', repos: repoList() };
    },

    // { repo, status, all } all: true ならすべてのリポジトリ
    tasks({ repo, status, all } = {}) {
      const repoPath = all ? '' : resolveRepo(repo);
      let list = agents.publicCards(repoPath || undefined);
      if (!all && !repoPath) list = [];
      if (status) {
        const want = String(status).split(',').map((s) => s.trim()).filter(Boolean);
        for (const s of want) if (!STATUSES.includes(s)) throw new Error(tr('知らない状態です: {status}', { status: s }));
        list = list.filter((c) => want.includes(c.status));
      }
      return list.map(taskSummary);
    },

    task({ id } = {}) {
      findTask(id);
      const c = agents.publicCards().find((x) => x.id === id);
      return taskDetail(c);
    },

    // { repo, title, prompt, agent, model, skill, pipeline, readOnly, permissionMode, start, attachments }
    // permissionMode: このタスクだけの権限モード（default / acceptEdits / plan / bypassPermissions）。省くとプロジェクトの設定
    async create({ repo, title, prompt, agent, model, skill, pipeline, readOnly, permissionMode, start, attachments } = {}) {
      if (!String(prompt || '').trim()) throw new Error(tr('指示を入力してください'));
      let repoPath = resolveRepo(repo);
      // まだ開いていないリポジトリなら、タブに足す（画面で見られるように）
      if (repo && addRepo && !repoList().some((t) => t.path === repoPath)) repoPath = await addRepo(repoPath);
      let mode = agent || undefined;
      if (pipeline) {
        const p = findPipeline(repoPath, pipeline);
        mode = `relay:${p.id}`;
      }
      const cards = agents.createTask({ title, prompt, agent: mode, model, skill, readOnly: !!readOnly, permissionMode, attachments, repoPath });
      if (start) for (const c of cards) agents.start(c.id);
      return { ids: cards.map((c) => c.id), tasks: cards.map((c) => taskSummary(store.card(c.id) || c)) };
    },

    pipelines({ repo } = {}) {
      const repoPath = resolveRepo(repo);
      const rs = store.repoSettings(repoPath);
      const list = pipelinesOf(rs);
      return list.map((p) => ({ id: p.id, name: p.name || 'Pipeline', default: p.id === rs.relayFlowId, steps: Array.isArray(p.flow && p.flow.nodes) ? p.flow.nodes.length : undefined }));
    },
  };

  // ID か名前で Pipeline を探す
  function findPipeline(repoPath, key) {
    const rs = store.repoSettings(repoPath);
    const list = pipelinesOf(rs);
    const k = String(key);
    const p = list.find((x) => x.id === k) || list.find((x) => (x.name || '') === k) || list.find((x) => (x.name || '').toLowerCase() === k.toLowerCase());
    if (!p) throw new Error(tr('Pipeline が見つかりません: {name}', { name: k }));
    return p;
  }

  return ops;
}

module.exports = { createApiOps, taskSummary, taskDetail, STATUSES };
