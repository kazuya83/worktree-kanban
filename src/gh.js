// GitHub CLI（gh）の確認・インストール・ログイン
const { spawn, execFile } = require('child_process');
const { resolveCommand, isWin } = require('./env');
const { tr } = require('../renderer/i18n');
const ReviewComments = require('./review-comments');

const DOWNLOAD_URL = 'https://cli.github.com/';
const DEVICE_URL = 'https://github.com/login/device';

function run(cmd, args, opts = {}) {
  return new Promise((resolve) => {
    // WSL のフォルダを作業フォルダにすると、gh が Windows の git でそのフォルダを調べて止まるので、使わない（--repo で指定する）
    if (opts.cwd && require('./wsl').isWslPath(opts.cwd)) opts = { ...opts, cwd: undefined };
    execFile(cmd, args, { windowsHide: true, timeout: 20000, ...opts }, (err, stdout, stderr) => {
      resolve({ code: err ? (typeof err.code === 'number' ? err.code : 1) : 0, stdout: String(stdout || ''), stderr: String(stderr || '') });
    });
  });
}

// gh のインストールに使えるパッケージマネージャー
function installer() {
  if (process.platform === 'darwin') {
    const brew = resolveCommand('brew');
    return brew ? { name: 'Homebrew', cmd: brew, args: ['install', 'gh'], label: 'brew install gh' } : null;
  }
  if (isWin) {
    const winget = resolveCommand('winget');
    return winget
      ? {
          name: 'winget',
          cmd: winget,
          args: ['install', '--id', 'GitHub.cli', '-e', '--silent', '--accept-source-agreements', '--accept-package-agreements'],
          label: 'winget install GitHub.cli',
        }
      : null;
  }
  return null; // Linux はディストリごとに違うので、ダウンロードページを案内する
}

/** @returns {Promise<{installed: boolean, path: string|null, loggedIn: boolean, user: string, installer: string|null, installLabel: string|null, downloadUrl: string}>} */
async function status() {
  const gh = resolveCommand('gh');
  const inst = installer();
  const base = { path: gh, installer: inst ? inst.name : null, installLabel: inst ? inst.label : null, downloadUrl: DOWNLOAD_URL };
  if (!gh) return { ...base, installed: false, loggedIn: false, user: '' };
  const r = await run(gh, ['auth', 'status', '--hostname', 'github.com']);
  const out = r.stdout + r.stderr;
  const m = out.match(/account\s+(\S+)/) || out.match(/Logged in to github\.com as\s+(\S+)/);
  const sm = out.match(/Token scopes:\s*(.*)/);
  const scopes = sm ? sm[1].split(',').map((x) => x.trim().replace(/^['"]|['"]$/g, '')).filter(Boolean) : null;
  // GH_TOKEN などで scope が出ないときは、分からない（null）にしておく
  const hasProjectScope = scopes ? scopes.includes('project') : null // 書き換えには read:project ではなく project が要る;
  return { ...base, installed: true, loggedIn: r.code === 0, user: m ? m[1] : '', scopes, hasProjectScope };
}

// 出力を1行ずつ onLine に渡しながらコマンドを動かす
function stream(cmd, args, onLine, { stdin } = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn(cmd, args, { windowsHide: true, env: { ...process.env, GH_PROMPT_DISABLED: '' } });
    let buf = '';
    const feed = (d) => {
      buf += d;
      let i;
      // \r も改行として扱う（進捗表示）
      while ((i = buf.search(/[\r\n]/)) >= 0) {
        const line = buf.slice(0, i).trim();
        buf = buf.slice(i + 1);
        if (line) onLine(line);
      }
    };
    child.stdout.setEncoding('utf8');
    child.stderr.setEncoding('utf8');
    child.stdout.on('data', feed);
    child.stderr.on('data', feed);
    child.stdin.on('error', () => {});
    if (stdin !== undefined) child.stdin.end(stdin);
    child.on('error', reject);
    child.on('close', (code) => {
      if (buf.trim()) onLine(buf.trim());
      resolve(code);
    });
    stream.current = child;
  });
}

async function install(onLine) {
  if (resolveCommand('gh')) return status();
  const inst = installer();
  if (!inst) throw new Error(tr('この環境では自動でインストールできません。{DOWNLOAD_URL} からインストールしてください', { DOWNLOAD_URL }));
  onLine(`$ ${inst.label}`);
  const code = await stream(inst.cmd, inst.args, onLine);
  const st = await status();
  if (!st.installed) {
    throw new Error(code === 0 ? tr('インストールは終わりましたが gh が見つかりません。アプリを再起動してください') : tr('インストールに失敗しました（終了コード {code}）', { code }));
  }
  return st;
}

// ブラウザで確認コードを入れる流れ（ログイン・権限の追加）を動かす
async function deviceFlow(args, onEvent) {
  const gh = resolveCommand('gh');
  if (!gh) throw new Error(tr('gh が入っていません'));
  let sentCode = false;
  const code = await stream(
    gh,
    args,
    (line) => {
      const m = line.match(/\b([A-Z0-9]{4}-[A-Z0-9]{4})\b/);
      if (m && !sentCode) {
        sentCode = true;
        const u = line.match(/https:\/\/\S+/);
        onEvent({ type: 'code', code: m[1], url: u ? u[0] : DEVICE_URL });
        return;
      }
      onEvent({ type: 'line', line });
    },
    { stdin: '\n' }, // 「Enter を押すとブラウザを開きます」で止まらないようにする
  );
  return code;
}

/**
 * ブラウザで GitHub にログインする（gh auth login --web）
 * @param {(ev: {type: 'code', code: string, url: string} | {type: 'line', line: string}) => void} onEvent
 */
async function login(onEvent) {
  const code = await deviceFlow(['auth', 'login', '--hostname', 'github.com', '--git-protocol', 'https', '--web', '--scopes', 'project'], onEvent);
  const st = await status();
  if (!st.loggedIn) throw new Error(code === 0 ? tr('ログインを確認できませんでした') : tr('ログインに失敗しました（終了コード {code}）', { code }));
  return st;
}

/**
 * GitHub Projects のステータスを変えられるように、gh に project の権限を足す（gh auth refresh -s project）
 * @param {(ev: {type: 'code', code: string, url: string} | {type: 'line', line: string}) => void} onEvent
 */
async function addProjectScope(onEvent) {
  const code = await deviceFlow(['auth', 'refresh', '--hostname', 'github.com', '--scopes', 'project'], onEvent);
  const st = await status();
  if (code !== 0 || st.hasProjectScope === false) throw new Error(code === 0 ? tr('project の権限を確認できませんでした') : tr('権限の追加に失敗しました（終了コード {code}）', { code }));
  return st;
}

/**
 * プルリクエストを作る。同じブランチの PR が開いていればそれを返す
 * @param {{ cwd: string, head: string, base: string, title: string, body: string, gh?: string }} p
 * @returns {Promise<{ url: string, number: number|null, created: boolean }>}
 */
async function createPullRequest({ cwd, head, base, title, body, repo, gh: ghPath }) {
  const gh = ghPath || resolveCommand('gh');
  if (!gh) throw new Error(tr('PR を作るには GitHub CLI（gh）が必要です。「Issue から」の画面からインストールとログインができます'));
  const opts = { cwd, timeout: 60000 };
  const repoArgs = repo ? ['--repo', repo] : [];
  const view = await run(gh, ['pr', 'view', head, ...repoArgs, '--json', 'url,number,state'], opts);
  if (view.code === 0) {
    try {
      const d = JSON.parse(view.stdout);
      if (String(d.state).toUpperCase() === 'OPEN' && d.url) return { url: d.url, number: d.number ?? null, created: false };
    } catch {
      /* 読めなければ新しく作る */
    }
  }
  const r = await run(gh, ['pr', 'create', ...repoArgs, '--head', head, '--base', base, '--title', title, '--body', body], opts);
  if (r.code !== 0) {
    const msg = (r.stderr || r.stdout).trim();
    if (/auth login|not logged/i.test(msg)) throw new Error(tr('GitHub にログインしていません。「Issue から」の画面からログインしてください'));
    throw new Error(tr('PR を作れませんでした: {msg}', { msg }));
  }
  const url = (r.stdout.match(/https:\/\/\S+\/pull\/\d+/) || [r.stdout.trim()])[0];
  const m = url.match(/\/pull\/(\d+)/);
  return { url, number: m ? Number(m[1]) : null, created: true };
}

const CHECK_PASSED = new Set(['SUCCESS', 'NEUTRAL', 'SKIPPED']);
const CHECK_FAILED = new Set(['FAILURE', 'ERROR', 'TIMED_OUT', 'STARTUP_FAILURE']);

// 1つのチェックを passed / failed / pending / attention（取り消しなど、人が見る必要があるもの）に分ける
function checkBucket(item) {
  if (item.__typename === 'StatusContext' || (item.context && !item.status)) {
    const s = String(item.state || '').toUpperCase();
    if (s === 'SUCCESS') return 'passed';
    return CHECK_FAILED.has(s) ? 'failed' : 'pending'; // PENDING / EXPECTED
  }
  if (String(item.status || '').toUpperCase() !== 'COMPLETED') return 'pending';
  const c = String(item.conclusion || '').toUpperCase();
  if (CHECK_PASSED.has(c)) return 'passed';
  return CHECK_FAILED.has(c) ? 'failed' : 'attention';
}

/**
 * gh の statusCheckRollup を、カードに載せる形にまとめる
 * @param {Array<object>|null|undefined} rollup
 * @param {string|null} [sha] 結果を取ったコミット
 * @returns {{ state: 'NONE'|'PENDING'|'SUCCESS'|'FAILURE'|'ATTENTION', sha: string|null, total: number, passed: number, pending: number, failed: Array<{ name: string, url: string|null }> }|null}
 */
function summarizeChecks(rollup, sha = null) {
  if (!Array.isArray(rollup)) return null;
  // 実行し直したチェックは、同じ名前で古い結果も並ぶので、新しいほうだけを見る
  const latest = new Map();
  for (const item of rollup) {
    if (!item) continue;
    const name = [item.workflowName, item.name || item.context].filter(Boolean).join(' / ') || '?';
    const prev = latest.get(name);
    if (!prev || String(item.startedAt || '') >= String(prev.item.startedAt || '')) latest.set(name, { name, item });
  }
  const out = { state: 'NONE', sha: sha || null, total: latest.size, passed: 0, pending: 0, failed: [] };
  let attention = 0;
  for (const { name, item } of latest.values()) {
    const bucket = checkBucket(item);
    if (bucket === 'failed') out.failed.push({ name, url: item.detailsUrl || item.targetUrl || null });
    else if (bucket === 'attention') attention++;
    else out[bucket]++;
  }
  if (out.failed.length) out.state = 'FAILURE';
  else if (out.pending) out.state = 'PENDING';
  else if (attention) out.state = 'ATTENTION';
  else if (out.total) out.state = 'SUCCESS';
  return out;
}

/**
 * プルリクエストの今の状態を GitHub に聞く
 * @param {{ url: string, cwd?: string, gh?: string }} p
 * @returns {Promise<{ state: 'OPEN'|'CLOSED'|'MERGED', mergedAt: string|null, headRefOid: string|null, baseRefName: string|null, mergeable: 'MERGEABLE'|'CONFLICTING'|'UNKNOWN'|null, checks: ReturnType<typeof summarizeChecks> }>}
 */
async function pullRequestState({ url, cwd, gh: ghPath }) {
  const gh = ghPath || resolveCommand('gh');
  if (!gh) throw new Error(tr('PR の状態を確かめるには GitHub CLI（gh）が必要です'));
  const view = (fields) => run(gh, ['pr', 'view', url, '--json', fields], { cwd, timeout: 30000 });
  const fields = 'state,mergedAt,headRefOid,baseRefName,mergeable';
  let r = await view(`${fields},statusCheckRollup`);
  // チェックを読む権限がないトークンでも、PR のマージの見張りは止めない
  if (r.code !== 0) r = await view(fields);
  if (r.code !== 0) {
    const msg = (r.stderr || r.stdout).trim();
    if (/auth login|not logged/i.test(msg)) throw new Error(tr('GitHub にログインしていません'));
    throw new Error(msg || tr('PR の状態を取れませんでした'));
  }
  let d;
  try {
    d = JSON.parse(r.stdout);
  } catch {
    throw new Error(tr('PR の状態を読めませんでした'));
  }
  return {
    state: String(d.state || '').toUpperCase(),
    mergedAt: d.mergedAt || null,
    headRefOid: d.headRefOid || null,
    baseRefName: d.baseRefName || null,
    // MERGEABLE / CONFLICTING / UNKNOWN（GitHub が計算中のときは UNKNOWN）
    mergeable: d.mergeable ? String(d.mergeable).toUpperCase() : null,
    checks: summarizeChecks(d.statusCheckRollup, d.headRefOid),
  };
}

// PR の URL から、ホスト・リポジトリ・番号を読む（GitHub Enterprise のホストもそのまま使う）
function parsePullUrl(url) {
  const m = String(url || '').match(/^https?:\/\/([^/]+)\/([^/]+)\/([^/]+)\/pull\/(\d+)/);
  return m ? { host: m[1].toLowerCase(), owner: m[2], name: m[3], number: Number(m[4]) } : null;
}

// gh api graphql を動かして data を返す。vars の数は -F、文字は -f で渡す
async function graphql(gh, host, query, vars, cwd) {
  const args = ['api', 'graphql', ...(host && host !== 'github.com' ? ['--hostname', host] : []), '-f', `query=${query}`];
  for (const [k, v] of Object.entries(vars || {})) args.push(typeof v === 'number' ? '-F' : '-f', `${k}=${v}`);
  const r = await run(gh, args, { cwd, timeout: 30000, maxBuffer: 32 * 1024 * 1024 });
  let d = null;
  try {
    d = JSON.parse(r.stdout);
  } catch {
    /* 下でエラーにする */
  }
  const err = d && Array.isArray(d.errors) && d.errors.length ? d.errors.map((e) => e && e.message).filter(Boolean).join('; ') : '';
  if (r.code !== 0 || !d || err) {
    const msg = err || (r.stderr || r.stdout).trim();
    if (/auth login|not logged/i.test(msg)) throw new Error(tr('GitHub にログインしていません'));
    throw new Error(msg || tr('GitHub の API を呼べませんでした'));
  }
  return d.data;
}

const REVIEW_QUERY = `query($owner: String!, $name: String!, $number: Int!) {
  repository(owner: $owner, name: $name) {
    pullRequest(number: $number) {
      reviewThreads(first: 100) { nodes { id isResolved isOutdated path line originalLine comments(first: 50) { nodes { id body createdAt url author { login } } } } }
      reviews(last: 50) { nodes { id state body submittedAt url author { login } } }
      comments(last: 100) { nodes { id body createdAt url author { login } } }
    }
  }
}`;

/**
 * PR のレビューコメント（解決していない行コメント・レビューの本文・会話欄のコメント）を読む
 * @returns {Promise<{ items: ReturnType<typeof ReviewComments.fromGithub> }>}
 */
async function pullRequestComments({ url, cwd, gh: ghPath }) {
  const gh = ghPath || resolveCommand('gh');
  if (!gh) throw new Error(tr('PR の状態を確かめるには GitHub CLI（gh）が必要です'));
  const p = parsePullUrl(url);
  if (!p) throw new Error(tr('PR の URL として読めません: {url}', { url }));
  const d = await graphql(gh, p.host, REVIEW_QUERY, { owner: p.owner, name: p.name, number: p.number }, cwd);
  const pr = d && d.repository && d.repository.pullRequest;
  if (!pr) throw new Error(tr('PR が見つかりません: {url}', { url }));
  return { items: ReviewComments.fromGithub(pr) };
}

/**
 * 直したあとの書き戻し: 行コメントのスレッドに返信して解決し、ほかのコメントにはまとめて1回だけ返信する
 * 1つ失敗しても残りは続け、失敗したものは errors に入れる
 * @param {{ url: string, cwd?: string, gh?: string, threads: Array<{ id: string, body: string }>, comment?: string|null }} p
 * @returns {Promise<{ replied: number, resolved: number, commented: boolean, errors: string[] }>}
 */
async function replyPullRequestComments({ url, cwd, gh: ghPath, threads = [], comment = null }) {
  const gh = ghPath || resolveCommand('gh');
  if (!gh) throw new Error(tr('PR の状態を確かめるには GitHub CLI（gh）が必要です'));
  const p = parsePullUrl(url);
  if (!p) throw new Error(tr('PR の URL として読めません: {url}', { url }));
  const out = { replied: 0, resolved: 0, commented: false, errors: [] };
  for (const t of threads) {
    try {
      await graphql(gh, p.host, 'mutation($id: ID!, $body: String!) { addPullRequestReviewThreadReply(input: { pullRequestReviewThreadId: $id, body: $body }) { comment { id } } }', { id: t.id, body: t.body }, cwd);
      out.replied++;
      await graphql(gh, p.host, 'mutation($id: ID!) { resolveReviewThread(input: { threadId: $id }) { thread { id } } }', { id: t.id }, cwd);
      out.resolved++;
    } catch (err) {
      out.errors.push(err.message);
    }
  }
  if (comment) {
    const r = await run(gh, ['pr', 'comment', url, '--body', comment], { cwd, timeout: 30000 });
    if (r.code === 0) out.commented = true;
    else out.errors.push((r.stderr || r.stdout).trim() || tr('PR にコメントできませんでした'));
  }
  return out;
}

function cancel() {
  const c = stream.current;
  if (c && c.exitCode === null) c.kill();
}

module.exports = { status, install, login, addProjectScope, cancel, createPullRequest, pullRequestState, pullRequestComments, replyPullRequestComments, summarizeChecks, DOWNLOAD_URL, DEVICE_URL };
