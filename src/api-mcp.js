// エージェント向けの MCP サーバー（stdio、1行1つの JSON-RPC）。`wtk mcp` で動く。
// ツールは CLI と同じ操作（タスクを作る・状態を見る・操作する）。中ではアプリの API（src/api-client.js）を呼ぶ。
// アプリにつなぐのは、最初にツールが呼ばれたとき（アプリが動いていなければ、そのとき常駐モードで起動する）
const { ApiError } = require('./api-client');
const { defaultRepo, pendingReq } = require('./kanban-cli');

const PROTOCOL_VERSION = '2025-06-18';

const str = (description) => ({ type: 'string', description });
const bool = (description) => ({ type: 'boolean', description });
const ID = { id: str('Task ID (from list_tasks or create_task)') };
const REPO = { repo: str('Absolute path of the repository. Defaults to the repository that contains the current folder, or the tab open in the app') };

const TOOLS = [
  {
    name: 'list_repos',
    description: 'List the repositories open in Worktree Kanban, with counts of running tasks, tasks in review and tasks that need attention.',
    inputSchema: { type: 'object', properties: {} },
    annotations: { readOnlyHint: true },
  },
  {
    name: 'list_tasks',
    description: 'List tasks on the Worktree Kanban board of a repository. Each task shows its status (todo, queued, running, review, failed, done) and whether it waits for an approval or an answer.',
    inputSchema: { type: 'object', properties: { ...REPO, status: str('Only these statuses, comma separated (todo,queued,running,review,failed,done)'), all: bool('Tasks of all repositories') } },
    annotations: { readOnlyHint: true },
  },
  {
    name: 'get_task',
    description: 'Get one task: status, branch, worktree, prompt, pending approvals (with reqId) and pending questions (with reqId and options).',
    inputSchema: { type: 'object', properties: { ...ID }, required: ['id'] },
    annotations: { readOnlyHint: true },
  },
  {
    name: 'get_task_logs',
    description: "Get the task's log (the agent's messages, tool calls and results).",
    inputSchema: { type: 'object', properties: { ...ID, tail: { type: 'integer', description: 'Only the last N entries (default 50)' } }, required: ['id'] },
    annotations: { readOnlyHint: true },
  },
  {
    name: 'get_task_diff',
    description: "Get the task's changes as a unified diff against its base.",
    inputSchema: { type: 'object', properties: { ...ID }, required: ['id'] },
    annotations: { readOnlyHint: true },
  },
  {
    name: 'create_task',
    description: 'Create a task on the board. The task runs an AI coding agent in its own git worktree. It stays in Todo unless start is true.',
    inputSchema: {
      type: 'object',
      properties: {
        prompt: str('What the agent should do'),
        title: str('Short title (defaults to the first line of the prompt)'),
        ...REPO,
        agent: str('claude, codex, antigravity, gemini, cursor, opencode, copilot, amp, pi, droid, or a custom agent / Pipeline / compete reference. Defaults to the project setting'),
        model: str('Model for the agent (defaults to the project setting)'),
        skill: str('Skill to use'),
        pipeline: str('Run this Pipeline (name or ID) instead of a single agent'),
        read_only: bool('The task does not change the source (no worktree, no file edits)'),
        start: bool('Start the task right away (default false: stays in Todo)'),
      },
      required: ['prompt'],
    },
  },
  {
    name: 'list_pipelines',
    description: 'List the Pipelines (flowcharts of agent steps) of a repository.',
    inputSchema: { type: 'object', properties: { ...REPO } },
    annotations: { readOnlyHint: true },
  },
  {
    name: 'run_pipeline',
    description: 'Create a task that runs a Pipeline and start it.',
    inputSchema: { type: 'object', properties: { pipeline: str('Pipeline name or ID'), prompt: str('What to do'), title: str('Short title'), ...REPO }, required: ['pipeline', 'prompt'] },
  },
  { name: 'start_task', description: 'Start a task that is in Todo.', inputSchema: { type: 'object', properties: { ...ID }, required: ['id'] } },
  { name: 'stop_task', description: 'Stop a running or queued task.', inputSchema: { type: 'object', properties: { ...ID }, required: ['id'] } },
  { name: 'resume_task', description: 'Resume a task that was interrupted.', inputSchema: { type: 'object', properties: { ...ID }, required: ['id'] } },
  {
    name: 'send_message',
    description: 'Send a follow-up instruction to a task in review, failed or done. The agent continues the work.',
    inputSchema: { type: 'object', properties: { ...ID, message: str('The instruction') }, required: ['id', 'message'] },
  },
  {
    name: 'answer_approval',
    description: "Answer a task's pending approval (a tool call the agent asked permission for).",
    inputSchema: {
      type: 'object',
      properties: { ...ID, req_id: str('reqId from get_task (defaults to the oldest pending approval)'), decision: { type: 'string', enum: ['allow', 'deny', 'always'], description: 'always: allow this tool for the rest of the task' }, message: str('Reason when denying') },
      required: ['id', 'decision'],
    },
  },
  {
    name: 'answer_question',
    description: "Answer a task's pending question. answers maps each question text to the answer.",
    inputSchema: {
      type: 'object',
      properties: { ...ID, req_id: str('reqId from get_task (defaults to the oldest pending question)'), answers: { type: 'object', additionalProperties: { type: 'string' }, description: '{ "<question>": "<answer>" }' }, skip: bool('Do not answer; let the agent decide') },
      required: ['id'],
    },
  },
  {
    name: 'move_task',
    description: 'Move a task to another column (todo, running, review, done). Moving a Todo task to running starts it.',
    inputSchema: { type: 'object', properties: { ...ID, to: { type: 'string', enum: ['todo', 'running', 'review', 'done'] } }, required: ['id', 'to'] },
  },
  {
    name: 'merge_task',
    description: "Merge the task's branch into the base branch (or target) and finish the task.",
    inputSchema: { type: 'object', properties: { ...ID, target: str('Branch to merge into (defaults to the base branch)'), push: bool('Push after merging'), keep: bool('Keep the worktree and branch') }, required: ['id'] },
    annotations: { destructiveHint: true },
  },
  {
    name: 'create_pr',
    description: "Push the task's branch and open a pull request (or GitLab merge request).",
    inputSchema: { type: 'object', properties: { ...ID, base: str('Base branch'), title: str('PR title'), body: str('PR body'), keep: bool('Keep the worktree') }, required: ['id'] },
  },
  {
    name: 'complete_task',
    description: 'Mark a read-only or no-git task as done.',
    inputSchema: { type: 'object', properties: { ...ID }, required: ['id'] },
  },
  {
    name: 'delete_task',
    description: 'Discard a task: removes its worktree and branch. This cannot be undone.',
    inputSchema: { type: 'object', properties: { ...ID, confirm: bool('Must be true') }, required: ['id', 'confirm'] },
    annotations: { destructiveHint: true },
  },
];

const need = (a, k) => {
  const v = a[k];
  if (v === undefined || v === null || v === '') throw new ApiError(`"${k}" is required`);
  return v;
};

async function callTool(client, name, a = {}) {
  const repo = (forCreate = false) => defaultRepo(client, { repo: a.repo }, { forCreate });
  switch (name) {
    case 'list_repos':
      return client.invoke('api:status');
    case 'list_tasks':
      return client.invoke('api:tasks', { repo: a.all ? '' : await repo(), status: a.status, all: !!a.all });
    case 'get_task':
      return client.invoke('api:task', { id: need(a, 'id') });
    case 'get_task_logs': {
      const logs = (await client.invoke('card:logs', need(a, 'id'))) || [];
      const n = Number.isInteger(a.tail) && a.tail > 0 ? a.tail : 50;
      // 画像は大きいので外す
      return logs.slice(-n).map(({ images, ...rest }) => (images ? { ...rest, images: images.length } : rest));
    }
    case 'get_task_diff':
      return client.invoke('card:diff', need(a, 'id'));
    case 'create_task':
      return client.invoke('api:create', { repo: await repo(true), prompt: need(a, 'prompt'), title: a.title, agent: a.agent, model: a.model, skill: a.skill, pipeline: a.pipeline, readOnly: !!a.read_only, start: !!a.start });
    case 'list_pipelines':
      return client.invoke('api:pipelines', { repo: await repo() });
    case 'run_pipeline':
      return client.invoke('api:create', { repo: await repo(true), pipeline: need(a, 'pipeline'), prompt: need(a, 'prompt'), title: a.title, start: true });
    case 'start_task':
    case 'stop_task':
    case 'resume_task':
    case 'complete_task': {
      const id = need(a, 'id');
      await client.invoke(`card:${name.replace('_task', '')}`, id);
      return client.invoke('api:task', { id });
    }
    case 'send_message': {
      const id = need(a, 'id');
      await client.invoke('card:send', { id, message: need(a, 'message') });
      return client.invoke('api:task', { id });
    }
    case 'answer_approval': {
      const id = need(a, 'id');
      const reqId = await pendingReq(client, id, 'permission', a.req_id);
      await client.invoke('card:permission', { id, reqId, decision: need(a, 'decision'), message: a.message });
      return { id, reqId, decision: a.decision };
    }
    case 'answer_question': {
      const id = need(a, 'id');
      const reqId = await pendingReq(client, id, 'question', a.req_id);
      if (!a.skip && (!a.answers || typeof a.answers !== 'object')) throw new ApiError('Give "answers", or "skip": true');
      await client.invoke('card:answer', { id, reqId, answers: a.skip ? null : a.answers });
      return { id, reqId };
    }
    case 'move_task': {
      const id = need(a, 'id');
      await client.invoke('card:move', { id, to: need(a, 'to') });
      return client.invoke('api:task', { id });
    }
    case 'merge_task':
      return client.invoke('card:merge', { id: need(a, 'id'), target: a.target, push: !!a.push, keep: !!a.keep });
    case 'create_pr':
      return client.invoke('card:pr', { id: need(a, 'id'), base: a.base, title: a.title, body: a.body, keep: !!a.keep });
    case 'delete_task': {
      const id = need(a, 'id');
      if (a.confirm !== true) throw new ApiError('Set "confirm": true to discard the task');
      await client.invoke('card:discard', id);
      return { id, deleted: true };
    }
    default:
      throw new ApiError(`Unknown tool: ${name}`);
  }
}

function toText(data) {
  if (typeof data === 'string') return data || '(empty)';
  return JSON.stringify(data === undefined ? null : data, null, 2);
}

// 1つのメッセージに答える（返事がいらない通知なら null）
async function handleMessage(client, msg, { version = '' } = {}) {
  const { id, method, params } = msg || {};
  const reply = (result) => ({ jsonrpc: '2.0', id, result });
  if (method === 'initialize') {
    return reply({
      protocolVersion: (params && params.protocolVersion) || PROTOCOL_VERSION,
      capabilities: { tools: {} },
      serverInfo: { name: 'worktree-kanban', version: version || '0.0.0' },
      instructions: 'Worktree Kanban runs AI coding agents in parallel, one git worktree per task. Use these tools to create tasks, watch their status, answer approvals and questions, and merge or open PRs when they are in review.',
    });
  }
  if (method === 'ping') return reply({});
  if (method === 'tools/list') return reply({ tools: TOOLS });
  if (method === 'tools/call') {
    const name = params && params.name;
    try {
      const data = await callTool(client, name, (params && params.arguments) || {});
      return reply({ content: [{ type: 'text', text: toText(data) }] });
    } catch (err) {
      return reply({ content: [{ type: 'text', text: `Error: ${(err && err.message) || err}` }], isError: true });
    }
  }
  if (id === undefined || id === null) return null; // notifications/*
  return { jsonrpc: '2.0', id, error: { code: -32601, message: `Method not found: ${method}` } };
}

// stdin が閉じるまで動く
function serve({ client, stdin = process.stdin, stdout = process.stdout, version } = {}) {
  let ver = version;
  if (!ver) {
    try {
      ver = require('../package.json').version;
    } catch {
      ver = '';
    }
  }
  return new Promise((resolve) => {
    let buf = '';
    let pending = 0;
    let ended = false;
    const done = () => {
      if (ended && !pending) resolve();
    };
    const write = (m) => m && stdout.write(`${JSON.stringify(m)}\n`);
    stdin.setEncoding('utf8');
    stdin.on('data', (chunk) => {
      buf += chunk;
      let i;
      while ((i = buf.indexOf('\n')) >= 0) {
        const line = buf.slice(0, i).trim();
        buf = buf.slice(i + 1);
        if (!line) continue;
        let msg;
        try {
          msg = JSON.parse(line);
        } catch {
          write({ jsonrpc: '2.0', id: null, error: { code: -32700, message: 'Parse error' } });
          continue;
        }
        pending++;
        handleMessage(client, msg, { version: ver })
          .then(write, (err) => write({ jsonrpc: '2.0', id: msg.id ?? null, error: { code: -32603, message: String((err && err.message) || err) } }))
          .finally(() => {
            pending--;
            done();
          });
      }
    });
    stdin.on('end', () => {
      ended = true;
      done();
    });
  });
}

module.exports = { serve, handleMessage, callTool, TOOLS };
