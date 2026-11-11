#!/usr/bin/env node
// Worktree Kanban の CLI（wtk）。アプリの API（src/api-server.js）を呼んで、タスクを作る・状態を見る・操作する。
// `wtk mcp` で、同じ操作をエージェント向けの MCP サーバー（stdio）として出す（src/api-mcp.js）。
//
// アプリの exe を ELECTRON_RUN_AS_NODE=1 で、このファイルを引数にして動かす（設定の「CLI・MCP」で入れる wtk がそうする）。
// ふつうの node でも動く（そのときアプリを自動で起動するには WORKTREE_KANBAN_APP が要る）
const fs = require('fs');
const path = require('path');
const { execFileSync } = require('child_process');
const { ApiClient, ApiError } = require('./api-client');

const STATUS_LABEL = { todo: 'todo', queued: 'queued', running: 'running', review: 'review', failed: 'failed', done: 'done' };
const COLUMNS = ['todo', 'running', 'review', 'done'];

const HELP = `Worktree Kanban CLI

Usage: wtk <command> [options]

Board
  status                         Show the app, the API connection and the repositories
  repos                          List the repositories (tabs) with running / review counts
  tasks [--repo P] [--status S] [--all]
                                 List tasks (S: todo,queued,running,review,failed,done; comma separated)
  show <id>                      Show a task, with pending approvals and questions
  logs <id> [--tail N]           Show the task's log
  diff <id>                      Show the task's diff

Create and run
  create <prompt...> [--title T] [--repo P] [--agent A] [--model M] [--skill S]
         [--pipeline NAME|ID] [--read-only] [--permission-mode M | --bypass] [--start]
                                 Create a task (in Todo unless --start). Use "-" as the prompt to read it from stdin
                                 M: default, acceptEdits, plan, bypassPermissions (defaults to the project setting).
                                 --bypass is --permission-mode bypassPermissions: no approval is asked at all
  pipelines [--repo P]           List the Pipelines of a repository
  run-pipeline <NAME|ID> <prompt...> [--title T] [--repo P] [--permission-mode M | --bypass]
                                 Create a task that runs the Pipeline and start it
  start <id> | stop <id> | resume <id>
  send <id> <message...>         Send a follow-up instruction (review / failed / done tasks)
  btw <id> <message...>          Add a note while the task is running
  approve <id> [--req R] [--always]
  deny <id> [--req R] [--message M]
                                 Answer a pending approval (the oldest one unless --req)
  answer <id> --req R [--json '{"question":"answer"}'] [--skip]
                                 Answer a pending question
  move <id> <todo|running|review|done>

Finish
  merge <id> [--target B] [--push] [--keep]
  pr <id> [--base B] [--title T] [--body B] [--keep]
  complete <id>                  Mark a read-only / no-git task as done
  delete <id> --yes              Discard the task (removes its worktree and branch)

Other machines
  pair-code                      (on the app's machine) Show a one-time pairing code
  login --url URL --code CODE [--name N]
                                 Pair this machine with the app at URL and save the token
  logout                         Forget the saved token
  devices | revoke <deviceId>    (on the app's machine) List / revoke paired machines

Advanced
  call <channel> [json]          Call any API channel directly
  mcp                            Run as an MCP server (stdio) for agents

Options
  --json                         Print JSON
  --url URL --token T            Use this app (or WORKTREE_KANBAN_URL / WORKTREE_KANBAN_TOKEN)
  --local                        Use the app on this machine even after "login"
  --no-start                     Do not start the app in headless mode when it is not running
  -h, --help                     Show this help

When no app is running on this machine, wtk starts it in headless mode and waits for it.
Without --repo, the repository is the one that contains the current folder (or the app's open tab).`;

// ---- 引数 ----

const BOOL_FLAGS = new Set(['json', 'all', 'start', 'read-only', 'push', 'keep', 'always', 'skip', 'yes', 'local', 'no-start', 'bypass', 'help', 'h']);

function parseArgs(argv) {
  const pos = [];
  const opts = {};
  for (let i = 0; i < argv.length; i++) {
    const a = String(argv[i]);
    if (a === '--') {
      pos.push(...argv.slice(i + 1).map(String));
      break;
    }
    if (a === '-h') {
      opts.help = true;
      continue;
    }
    if (a.startsWith('--')) {
      const eq = a.indexOf('=');
      const name = eq > 0 ? a.slice(2, eq) : a.slice(2);
      if (eq > 0) opts[name] = a.slice(eq + 1);
      else if (BOOL_FLAGS.has(name)) opts[name] = true;
      else if (i + 1 < argv.length) opts[name] = String(argv[++i]);
      else throw new ApiError(`--${name} needs a value`);
      continue;
    }
    pos.push(a);
  }
  return { pos, opts };
}

// ---- 表示 ----

function pad(s, n) {
  const t = String(s);
  return t.length >= n ? t : t + ' '.repeat(n - t.length);
}

function oneLine(s, max = 60) {
  const t = String(s || '').replace(/\s+/g, ' ').trim();
  return t.length > max ? `${t.slice(0, max - 1)}…` : t;
}

function taskLine(t) {
  const flags = [];
  if (t.pendingPermissions) flags.push(`${t.pendingPermissions} approval`);
  if (t.pendingQuestions) flags.push(`${t.pendingQuestions} question`);
  if (t.awaitingReply) flags.push('awaiting reply');
  if (t.prUrl) flags.push(t.prUrl);
  return `${pad(t.id, 9)} ${pad(STATUS_LABEL[t.status] || t.status, 8)} ${pad(oneLine(t.agent, 14), 14)} ${oneLine(t.title)}${flags.length ? `  [${flags.join(', ')}]` : ''}`;
}

function showTask(t) {
  const lines = [`${t.title}`, `  id:      ${t.id}`, `  status:  ${t.status}`, `  agent:   ${t.agent}${t.model ? ` (${t.model})` : ''}`, ...(t.permissionMode ? [`  mode:    ${t.permissionMode}`] : []), `  repo:    ${t.repoPath}`];
  if (t.branch) lines.push(`  branch:  ${t.branch}`);
  if (t.worktreePath) lines.push(`  worktree: ${t.worktreePath}`);
  if (t.prUrl) lines.push(`  PR:      ${t.prUrl}`);
  if (t.error) lines.push(`  error:   ${oneLine(t.error, 200)}`);
  if (t.subtasks && t.subtasks.items.length) {
    lines.push(`  subtasks (${t.subtasks.phase}):`);
    for (const s of t.subtasks.items) lines.push(`    - ${s.key}: ${s.title}${s.cardId ? ` (${s.cardId})` : ''}${s.status ? ` [${s.status}]` : ''}`);
  }
  for (const p of t.permissions) lines.push(`  approval ${p.reqId}: ${p.toolName} ${oneLine(p.summary, 120)}`);
  for (const q of t.questions) {
    lines.push(`  question ${q.reqId}:`);
    for (const x of q.questions) lines.push(`    ? ${x.question}${x.options.length ? `  (${x.options.map((o) => o.label).join(' / ')})` : ''}`);
  }
  lines.push('', t.prompt);
  return lines.join('\n');
}

function logLine(l) {
  if (!l || typeof l !== 'object') return String(l);
  const t = l.t || l.at;
  const time = t ? new Date(t).toLocaleTimeString() : '';
  const text = typeof l.text === 'string' ? l.text : JSON.stringify(l);
  return `${time} ${l.kind || ''}: ${text}`.trim();
}

// ---- リポジトリ ----

const norm = (p) => path.resolve(String(p || '')).replace(/[\\/]+$/, '');
const inside = (child, parent) => {
  const c = norm(child);
  const p = norm(parent);
  const sep = c.includes('\\') && !c.includes('/') ? '\\' : path.sep;
  return c === p || c.startsWith(p + sep) || (process.platform === 'win32' && c.toLowerCase().startsWith(`${p.toLowerCase()}${sep}`));
};

// 今のフォルダを含むリポジトリ（worktree の中なら、元のリポジトリ）。見つからなければ ''
function repoForCwd(repos, cwd = process.cwd(), gitCommonDir = defaultGitCommonDir) {
  const paths = (repos || []).map((r) => (typeof r === 'string' ? r : r.path)).filter(Boolean);
  const direct = paths.filter((p) => inside(cwd, p)).sort((a, b) => b.length - a.length)[0];
  if (direct) return direct;
  const common = gitCommonDir(cwd);
  if (!common) return '';
  const root = path.basename(common) === '.git' ? path.dirname(common) : common;
  return paths.find((p) => norm(p) === norm(root)) || '';
}

function defaultGitCommonDir(cwd) {
  try {
    const out = execFileSync('git', ['rev-parse', '--path-format=absolute', '--git-common-dir'], { cwd, stdio: ['ignore', 'pipe', 'ignore'], timeout: 5000 }).toString().trim();
    return out || '';
  } catch {
    return '';
  }
}

// ---- コマンド ----

function needId(pos, name) {
  const id = pos[1];
  if (!id) throw new ApiError(`Usage: wtk ${name} <id>`);
  return id;
}

function restText(pos, from) {
  return pos.slice(from).join(' ').trim();
}

function readStdin() {
  try {
    return fs.readFileSync(0, 'utf8');
  } catch {
    return '';
  }
}

// 承認・質問の reqId を省いたときは、いちばん古いもの
async function pendingReq(client, id, kind, req) {
  if (req) return req;
  const t = await client.invoke('api:task', { id });
  const list = kind === 'question' ? t.questions : t.permissions;
  if (!list.length) throw new ApiError(kind === 'question' ? `Task ${id} has no pending question` : `Task ${id} has no pending approval`);
  return list[0].reqId;
}

// git のリポジトリの一番上のフォルダ（worktree の中なら、元のリポジトリ）。git の外なら ''
function gitRepoRoot(cwd = process.cwd(), gitCommonDir = defaultGitCommonDir) {
  const common = gitCommonDir(cwd);
  if (!common) return '';
  return path.basename(common) === '.git' ? path.dirname(common) : '';
}

// --repo の指定か、今のフォルダから決めるリポジトリ（'' はアプリで開いているタブ）。
// forCreate: 開いていないリポジトリの中でタスクを作るときは、そのリポジトリにする（アプリがタブに足す）
async function defaultRepo(client, opts, { forCreate = false, cwd = process.cwd(), gitCommonDir = defaultGitCommonDir } = {}) {
  if (opts.repo) return path.isAbsolute(opts.repo) || /^[A-Za-z]:[\\/]/.test(opts.repo) || opts.repo.startsWith('\\\\') ? opts.repo : path.resolve(cwd, opts.repo);
  const t = await client.connect();
  if (t.kind !== 'local') return ''; // ほかの PC のアプリ: 今のフォルダは関係ない
  const st = await client.invoke('api:status');
  return repoForCwd(st.repos, cwd, gitCommonDir) || (forCreate ? gitRepoRoot(cwd, gitCommonDir) : '');
}

/**
 * @returns {Promise<{ data: any, text: string }>}
 */
async function run(client, pos, opts, io = {}) {
  const cmd = pos[0];
  const stdin = io.readStdin || readStdin;
  const out = (data, text) => ({ data, text: text == null ? JSON.stringify(data, null, 2) : text });
  switch (cmd) {
    case 'status': {
      const s = await client.session();
      const st = await client.invoke('api:status');
      const lines = [`Connected to Worktree Kanban ${s.appVersion} (${s.mode}) at ${s.url}${s.via === 'local' ? '' : ` [${s.via}]`}`, `Open repository: ${st.currentRepo || '(none)'}`, '', ...st.repos.map((r) => `${pad(r.path, 50)} running ${r.running}  review ${r.review}  attention ${r.attention}`)];
      return out({ session: s, ...st }, lines.join('\n'));
    }
    case 'repos': {
      const st = await client.invoke('api:status');
      return out(st.repos, st.repos.map((r) => `${r.path === st.currentRepo ? '*' : ' '} ${pad(r.path, 50)} running ${r.running}  review ${r.review}  attention ${r.attention}`).join('\n') || '(no repositories)');
    }
    case 'tasks': {
      const repo = opts.all ? '' : await defaultRepo(client, opts);
      const list = await client.invoke('api:tasks', { repo, status: opts.status, all: !!opts.all });
      return out(list, list.length ? list.map(taskLine).join('\n') : '(no tasks)');
    }
    case 'show': {
      const t = await client.invoke('api:task', { id: needId(pos, 'show') });
      return out(t, showTask(t));
    }
    case 'logs': {
      const id = needId(pos, 'logs');
      let logs = (await client.invoke('card:logs', id)) || [];
      const n = parseInt(opts.tail, 10);
      if (Number.isFinite(n) && n > 0) logs = logs.slice(-n);
      return out(logs, logs.map(logLine).join('\n'));
    }
    case 'diff': {
      const d = await client.invoke('card:diff', needId(pos, 'diff'));
      return out(d, typeof d === 'string' ? d : d && typeof d.diff === 'string' ? d.diff : JSON.stringify(d, null, 2));
    }
    case 'create':
    case 'run-pipeline': {
      const pipeline = cmd === 'run-pipeline' ? pos[1] : opts.pipeline;
      if (cmd === 'run-pipeline' && !pipeline) throw new ApiError('Usage: wtk run-pipeline <NAME|ID> <prompt...>');
      let prompt = restText(pos, cmd === 'run-pipeline' ? 2 : 1);
      if (prompt === '-' || opts.prompt === '-') prompt = stdin();
      else if (opts.prompt) prompt = opts.prompt;
      if (!prompt.trim()) throw new ApiError(`Usage: wtk ${cmd} ${cmd === 'run-pipeline' ? '<NAME|ID> ' : ''}<prompt...>  (or "-" to read from stdin)`);
      const repo = await defaultRepo(client, opts, { forCreate: true });
      const r = await client.invoke('api:create', { repo, title: opts.title, prompt, agent: opts.agent, model: opts.model, skill: opts.skill, pipeline, readOnly: !!opts['read-only'], permissionMode: opts.bypass ? 'bypassPermissions' : opts['permission-mode'], start: cmd === 'run-pipeline' || !!opts.start });
      return out(r, r.tasks.map(taskLine).join('\n'));
    }
    case 'pipelines': {
      const repo = await defaultRepo(client, opts);
      const list = await client.invoke('api:pipelines', { repo });
      return out(list, list.map((p) => `${p.default ? '*' : ' '} ${pad(p.id, 12)} ${p.name}`).join('\n') || '(no pipelines)');
    }
    case 'start':
    case 'stop':
    case 'resume':
    case 'complete': {
      const id = needId(pos, cmd);
      await client.invoke(`card:${cmd}`, id);
      return out({ id, ok: true }, `${cmd}: ${id}`);
    }
    case 'send':
    case 'btw': {
      const id = needId(pos, cmd);
      let text = restText(pos, 2);
      if (text === '-') text = stdin();
      if (!text.trim()) throw new ApiError(`Usage: wtk ${cmd} <id> <message...>`);
      await client.invoke(`card:${cmd}`, cmd === 'send' ? { id, message: text } : { id, text });
      return out({ id, ok: true }, `sent to ${id}`);
    }
    case 'approve':
    case 'deny': {
      const id = needId(pos, cmd);
      const reqId = await pendingReq(client, id, 'permission', opts.req);
      const decision = cmd === 'deny' ? 'deny' : opts.always ? 'always' : 'allow';
      await client.invoke('card:permission', { id, reqId, decision, message: opts.message });
      return out({ id, reqId, decision }, `${decision}: ${id} ${reqId}`);
    }
    case 'answer': {
      const id = needId(pos, 'answer');
      const reqId = await pendingReq(client, id, 'question', opts.req);
      let answers = null;
      if (!opts.skip) {
        if (!opts.json) throw new ApiError('Give --json \'{"<question>":"<answer>"}\', or --skip to let the agent decide');
        try {
          answers = JSON.parse(opts.json);
        } catch {
          throw new ApiError('--json is not valid JSON');
        }
      }
      await client.invoke('card:answer', { id, reqId, answers });
      return out({ id, reqId }, `answered: ${id} ${reqId}`);
    }
    case 'move': {
      const id = needId(pos, 'move');
      const to = pos[2];
      if (!COLUMNS.includes(to)) throw new ApiError(`Usage: wtk move <id> <${COLUMNS.join('|')}>`);
      await client.invoke('card:move', { id, to });
      return out({ id, to }, `moved ${id} to ${to}`);
    }
    case 'merge': {
      const id = needId(pos, 'merge');
      const r = await client.invoke('card:merge', { id, target: opts.target, keep: !!opts.keep, push: !!opts.push });
      return out(r, `merged ${id}${r && typeof r === 'object' && r.target ? ` into ${r.target}` : ''}`);
    }
    case 'pr': {
      const id = needId(pos, 'pr');
      const r = await client.invoke('card:pr', { id, base: opts.base, title: opts.title, body: opts.body, keep: !!opts.keep });
      return out(r, typeof r === 'string' ? r : (r && (r.url || r.prUrl)) || `PR created for ${id}`);
    }
    case 'delete': {
      const id = needId(pos, 'delete');
      if (!opts.yes) throw new ApiError(`This discards task ${id}, its worktree and its branch. Add --yes to confirm.`);
      await client.invoke('card:discard', id);
      return out({ id, deleted: true }, `deleted ${id}`);
    }
    case 'pair-code': {
      const r = await client.invoke('api:pairCode');
      return out(r, `Pairing code: ${r.code}\nValid until ${new Date(r.expiresAt).toLocaleTimeString()} (one use).\nOn the other machine: wtk login --url http://127.0.0.1:${r.port} --code ${r.code}\n(forward the port first, e.g. ssh -N -L ${r.port}:127.0.0.1:${r.port} <this machine>)`);
    }
    case 'devices': {
      const list = await client.invoke('api:devices');
      return out(list, list.map((d) => `${pad(d.id, 38)} ${pad(d.name, 20)} last used ${d.lastSeenAt ? new Date(d.lastSeenAt).toLocaleString() : '-'}`).join('\n') || '(no paired machines)');
    }
    case 'revoke': {
      const id = needId(pos, 'revoke');
      const r = await client.invoke('api:revoke', { id });
      return out(r, r ? `revoked ${id}` : `no such device: ${id}`);
    }
    case 'login': {
      const r = await client.login({ url: opts.url || pos[1], code: opts.code || pos[2], name: opts.name });
      return out(r, `Logged in to ${r.url}. The token is saved in ${r.file}`);
    }
    case 'logout': {
      const r = await client.logout();
      return out(r, r.removed ? `Logged out from ${r.url}` : 'Not logged in');
    }
    case 'call': {
      const channel = pos[1];
      if (!channel) throw new ApiError('Usage: wtk call <channel> [json]');
      let arg = null;
      if (pos[2] != null) {
        const raw = pos[2] === '-' ? stdin() : pos[2];
        try {
          arg = JSON.parse(raw);
        } catch {
          arg = raw; // ID などの文字列はそのまま
        }
      }
      const r = await client.invoke(channel, arg);
      return out(r);
    }
    default:
      throw new ApiError(`Unknown command: ${cmd}. Run "wtk --help".`);
  }
}

async function main(argv = process.argv.slice(2), { stdout = process.stdout, stderr = process.stderr, env = process.env } = {}) {
  let parsed;
  try {
    parsed = parseArgs(argv);
  } catch (err) {
    stderr.write(`${err.message}\n`);
    return 2;
  }
  const { pos, opts } = parsed;
  if (opts.help || opts.h || !pos.length || pos[0] === 'help') {
    stdout.write(`${HELP}\n`);
    return 0;
  }
  // 「--url」はつなぐ先。ただし login では、ペアリングする先
  const clientOpts = { env, local: !!opts.local, autoStart: !opts['no-start'], onLog: (l) => stderr.write(`${l}\n`) };
  if (pos[0] !== 'login') Object.assign(clientOpts, { url: opts.url, token: opts.token });
  const client = new ApiClient(clientOpts);
  if (pos[0] === 'mcp') {
    // MCP では、標準出力は JSON-RPC だけ。起動のお知らせなどは標準エラーへ
    await require('./api-mcp').serve({ client });
    return 0;
  }
  try {
    const r = await run(client, pos, opts);
    stdout.write(`${opts.json ? JSON.stringify(r.data, null, 2) : r.text}\n`);
    return 0;
  } catch (err) {
    stderr.write(`Error: ${(err && err.message) || err}\n`);
    return 1;
  }
}

module.exports = { main, run, parseArgs, repoForCwd, defaultRepo, pendingReq, HELP };

if (require.main === module) {
  main().then(
    (code) => {
      if (code) process.exitCode = code;
    },
    (err) => {
      process.stderr.write(`Error: ${(err && err.message) || err}\n`);
      process.exitCode = 1;
    },
  );
}
