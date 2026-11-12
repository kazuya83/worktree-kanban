// ボードの状態を JSON ファイルに保存する
const fs = require('fs');
const path = require('path');
const { DEFAULT_RELAY_STEPS, defaultRelaySteps, DEFAULT_COMPETE_AGENTS, DEFAULT_ENABLED_AGENTS, isAgent, isCustomRef, cleanEnabledAgents, cleanOrchestration, cleanRelaySteps, cleanCustomAgents, defaultAgentOf, defaultAgentRefOf, defaultTaskRefOf, cleanCompetes, legacyCompetes } = require('./providers');
const FlowModel = require('../renderer/flow-model');
const { cleanSchedules } = require('../renderer/schedule-model');
const { cleanCycles, cleanCycleView } = require('../renderer/cycle-model');
const I18n = require('../renderer/i18n');
const Shared = require('./shared-settings');
const { tr } = I18n;

// Pipelineのフローチャート（プロジェクトごと）の初期値: 前と同じ「実装 → レビュー」
// 呼んだときの言語で作る。言語を変えると画面を読み直すので、新しいリポジトリは選んだ言語になる
function defaultRelayFlow(enabled) {
  return FlowModel.flowFromSteps(defaultRelaySteps(enabled));
}
const DEFAULT_RELAY_FLOW = defaultRelayFlow();
function cloneFlow(f) {
  return JSON.parse(JSON.stringify(f));
}
// 保存されていたフローを整える（形になっていなければ、今の言語の初期値）
function cleanRelayFlow(f) {
  return FlowModel.cleanFlow(f, { isAgent }) || cloneFlow(defaultRelayFlow());
}

// 保存済みの board.json を読む前に、表示の言語を決める（Store は setLanguage しない）
function languageForBoardFile(file) {
  let text;
  try {
    text = fs.readFileSync(file, 'utf8');
  } catch {
    return I18n.DEFAULT_LANGUAGE; // ファイルがない（初めて入れたとき）
  }
  try {
    const raw = JSON.parse(text);
    const lang = raw && raw.settings && raw.settings.language;
    return I18n.isLanguage(lang) ? lang : I18n.LEGACY_LANGUAGE;
  } catch {
    return I18n.LEGACY_LANGUAGE; // あるが読めない既存ファイルは、これまでの日本語のまま
  }
}

// 言語の切り替え。対応していないコードは受け付けない
function assertLanguage(code) {
  if (!I18n.isLanguage(code)) {
    const err = new Error(tr('対応していない言語です: {code}', { code: String(code ?? '') }));
    err.code = 'BAD_LANGUAGE';
    throw err;
  }
  return code;
}

// ---------- Pipeline（プロジェクトごとに複数） ----------
// relayFlows: [{ id, name, flow }]（1つ以上）。relayFlowId: 既定の Pipeline の ID。
// relayFlow は既定の Pipeline のフロー（前の版と同じ名前で、いつも既定の Pipeline の flow と同じ中身にそろえる）
const MAX_RELAY_FLOWS = 30;
const RELAY_FLOW_ID_RE = /^[A-Za-z0-9_-]{1,32}$/;
const DEFAULT_PIPELINE_NAME = 'Pipeline';
// Pipeline の名前の長さの上限（タスクを作るときの「エージェント」のプルダウンで見切れないように）
const PIPELINE_NAME_MAX = 15;
function cleanPipelineName(v, fallback = DEFAULT_PIPELINE_NAME) {
  const s = [...String(v == null ? '' : v).replace(/\s+/g, ' ').trim()].slice(0, PIPELINE_NAME_MAX).join('').trim();
  return s || fallback;
}
// 名前が重ならないようにする（重なったら「 (2)」などを付ける。上限の長さに収める）
function uniquePipelineName(name, taken) {
  if (!taken.has(name)) return name;
  for (let i = 2; ; i++) {
    const sfx = ` (${i})`;
    const n = [...name].slice(0, PIPELINE_NAME_MAX - sfx.length).join('').trim() + sfx;
    if (!taken.has(n)) return n;
  }
}
// Pipeline の一覧を整える。flow を渡したら、それを既定の Pipeline のフローにする（前の版の relayFlow だけの設定・relayFlow だけを変えたとき）
function cleanRelayFlows(list, id, flow) {
  const out = [];
  const ids = new Set();
  const names = new Set();
  for (const x of Array.isArray(list) ? list : []) {
    if (!x || typeof x !== 'object' || out.length >= MAX_RELAY_FLOWS) continue;
    let pid = String(x.id || '').trim();
    if (!RELAY_FLOW_ID_RE.test(pid) || ids.has(pid)) {
      let n = out.length + 1;
      while (ids.has(`p${n}`)) n++;
      pid = `p${n}`;
    }
    ids.add(pid);
    // 前の版の長い名前も上限で切る（切って重なったら番号を付ける）
    const name = uniquePipelineName(cleanPipelineName(x.name, `${DEFAULT_PIPELINE_NAME} ${out.length + 1}`), names);
    names.add(name);
    out.push({ id: pid, name, flow: cleanRelayFlow(x.flow) });
  }
  if (!out.length) out.push({ id: 'default', name: DEFAULT_PIPELINE_NAME, flow: cleanRelayFlow(flow) });
  const def = out.find((x) => x.id === String(id || '')) || out[0];
  if (flow !== undefined && flow !== null) def.flow = cleanRelayFlow(flow);
  return { relayFlows: out, relayFlowId: def.id, relayFlow: def.flow };
}
// Pipeline の ID から、その Pipeline（なければ既定の Pipeline。id が空のときも既定）
function pipelineOf(settings, id) {
  const list = (settings && settings.relayFlows) || [];
  const want = String(id || '') || (settings && settings.relayFlowId);
  return list.find((x) => x.id === want) || (id ? null : list[0] || null);
}
// 設定の変更のうち Pipeline の分を、今の値と合わせて { relayFlows, relayFlowId, relayFlow } にそろえる
function relayPatchOf(cur, patch) {
  if (!patch || !['relayFlows', 'relayFlowId', 'relayFlow'].some((k) => k in patch)) return null;
  const list = 'relayFlows' in patch ? patch.relayFlows : (cur && cur.relayFlows) || [];
  const id = 'relayFlowId' in patch ? patch.relayFlowId : cur && cur.relayFlowId;
  // 一覧を変えたときは、一覧の中身を使う（relayFlow は一覧の既定の分から作り直す）
  const flow = 'relayFlow' in patch && !('relayFlows' in patch) ? patch.relayFlow : undefined;
  return cleanRelayFlows(list, id, flow);
}

const MAX_RECENT_REPOS = 10; // 最近開いたリポジトリを覚えておく件数

// 最近開いたリポジトリ一覧を整える（新しいものが先頭・重複なし・空は捨てる）
function cleanRecentRepoPaths(list, max = MAX_RECENT_REPOS) {
  const out = [];
  for (const p of Array.isArray(list) ? list : []) {
    const s = String(p || '').trim();
    if (!s || out.includes(s)) continue;
    out.push(s);
    if (out.length >= max) break;
  }
  return out;
}

// 開いたリポジトリを最近一覧の先頭に足す
function touchRecentRepo(list, dir, max = MAX_RECENT_REPOS) {
  const s = String(dir || '').trim();
  if (!s) return cleanRecentRepoPaths(list, max);
  return cleanRecentRepoPaths([s, ...(Array.isArray(list) ? list : [])], max);
}

// 履歴が空のとき、今のリポジトリとカードから初期一覧を作る
function seedRecentRepoPaths(settings, cards) {
  const seeded = [];
  const add = (p) => {
    const s = String(p || '').trim();
    if (s && !seeded.includes(s)) seeded.push(s);
  };
  add(settings.repoPath);
  const sorted = [...(Array.isArray(cards) ? cards : [])].sort((a, b) => (Number(b && b.createdAt) || 0) - (Number(a && a.createdAt) || 0));
  for (const c of sorted) add(c && c.repoPath);
  return cleanRecentRepoPaths(seeded);
}

const MAX_REPO_TABS = 3; // 画面上部のタブで同時に開いておけるリポジトリの数

// タブで開いているリポジトリ一覧を整える（空・重複を捨てる。今のリポジトリは必ず入れて、上限まで）
function cleanRepoTabs(list, current, max = MAX_REPO_TABS) {
  const cur = String(current || '').trim();
  const out = [];
  for (const p of Array.isArray(list) ? list : []) {
    const s = String(p || '').trim();
    if (s && !out.includes(s)) out.push(s);
  }
  if (cur && !out.includes(cur)) out.push(cur);
  // 多すぎるときは、今のリポジトリを残して後ろから落とす
  while (out.length > max) {
    let i = out.length - 1;
    if (out[i] === cur) i -= 1;
    out.splice(i, 1);
  }
  return out;
}

// リポジトリを開いたあとのタブ一覧
// すでにタブにあればそのまま。mode が 'replace' か、タブが上限まであるなら今のタブを置き換え、そうでなければ右に足す
function openRepoTab(tabs, current, dir, { mode = 'new', max = MAX_REPO_TABS } = {}) {
  const list = cleanRepoTabs(tabs, current, max);
  const d = String(dir || '').trim();
  if (!d || list.includes(d)) return list;
  const i = list.indexOf(String(current || '').trim());
  if (i >= 0 && (mode === 'replace' || list.length >= max)) {
    list[i] = d;
    return list;
  }
  if (list.length >= max) list.pop();
  list.push(d);
  return list;
}

// タブを閉じたあとのタブ一覧と、次に開くリポジトリ（今のタブを閉じたら、その右・なければ左のタブ）
function closeRepoTab(tabs, current, dir, max = MAX_REPO_TABS) {
  const list = cleanRepoTabs(tabs, current, max);
  const d = String(dir || '').trim();
  const cur = String(current || '').trim();
  const i = list.indexOf(d);
  if (i < 0 || list.length <= 1) return { tabs: list, next: cur };
  list.splice(i, 1);
  return { tabs: list, next: d === cur ? list[Math.min(i, list.length - 1)] : cur };
}

// タブに出す、リポジトリごとの動いているタスク・対応を待っているタスク・レビュー中のタスクの数
// git で管理していないフォルダとして開いたか（settings.noGitRepos に入っている）
function isNoGitRepo(settings, dir) {
  const d = String(dir || '').trim();
  return !!d && Array.isArray(settings && settings.noGitRepos) && settings.noGitRepos.includes(d);
}

// フォルダを開いたときに、git で管理していないかどうかを覚えておく（git リポジトリになったら外す）
function markNoGitRepo(settings, dir, noGit) {
  const d = String(dir || '').trim();
  if (!d || !settings) return;
  const list = (Array.isArray(settings.noGitRepos) ? settings.noGitRepos : []).filter((p) => p && p !== d);
  if (noGit) list.unshift(d);
  settings.noGitRepos = list.slice(0, 200);
}

function repoTabSummary(tabs, cards, settings) {
  const all = Array.isArray(cards) ? cards : [];
  const ids = new Set(all.map((c) => c && c.id).filter(Boolean));
  return (Array.isArray(tabs) ? tabs : []).map((p) => {
    const mine = all.filter((c) => c && c.repoPath === p);
    return {
      path: p,
      ...(isNoGitRepo(settings, p) ? { noGit: true } : {}),
      running: mine.filter((c) => c.status === 'running' || c.status === 'queued').length,
      attention: mine.filter((c) => (c.questions || []).length || (c.permissions || []).length || (c.awaitingReply && (c.status === 'review' || c.status === 'failed'))).length,
      // ボードの「レビュー」列に出るもの（チャットと、親のカードにまとめて出すサブタスクは数えない）
      review: mine.filter((c) => (c.status === 'review' || c.status === 'failed') && c.kind !== 'chat' && !(c.subtaskOf && ids.has(c.subtaskOf))).length,
    };
  });
}

const DEFAULT_SETTINGS = {
  repoPath: '',
  repoTabs: [], // 画面上部のタブで開いているリポジトリ（左から順。今のリポジトリも含む・MAX_REPO_TABS まで）
  repoSettings: {}, // プロジェクト（リポジトリ）ごとの設定（REPO_SETTING_KEYS）。今のリポジトリの分は、下の同じ名前の項目にも入れて使う
  sharedRepos: {}, // リポジトリの .worktree-kanban/settings.json の様子 { [リポジトリ]: { keys: ファイルにある項目, overrides: この PC で上書きした項目, approved: { setup|teardown|run: 許可したスクリプトの SHA-256 } } }
  lastRepoParent: '', // クローン・新規作成で最後に使った置き場所（親フォルダ）
  recentRepoPaths: [], // 最近開いたリポジトリ（新しいものが先頭）
  noGitRepos: [], // git で管理していないフォルダとして開いたもの（worktree を作らず、そのフォルダでタスクを動かす）
  // ---- ここから REPO_SETTING_KEYS の項目は、今のリポジトリの設定（repoSettings から写したもの） ----
  baseBranch: '', // 空なら、開始時にチェックアウトしているブランチ
  permissionMode: 'acceptEdits', // default / acceptEdits / plan / bypassPermissions
  allowedTools: '', // カンマ・改行区切り（例: Bash(npm test:*), WebSearch）
  model: '',
  claudePath: 'claude',
  maxParallel: 3,
  defaultSkill: '', // 新しいタスクを作るときに最初から選んでおくスキル
  setupScript: '', // worktree を作った直後、エージェントの開始前に動かすスクリプト
  teardownScript: '', // worktree を消す直前に動かすスクリプト
  runScript: '', // タスク詳細の「実行」ボタンで動かすスクリプト（開発サーバーなど）
  portStart: 20000, // タスクごとに分ける開発サーバーのポートを探し始める番号（プロジェクトごと）
  portCount: 10, // 1つのタスクに割り当てるポートの数（フロントと API など、複数のサーバーを動かせるように）
  integration: 'pr', // レビュー後の取り込み方: merge（ローカルで直接マージ） / pr（push してプルリクエストを作る）
  issueProvider: 'github', // このプロジェクトで使う課題管理サービス（src/trackers に登録したプロバイダの ID）
  trackerConfigs: {}, // 連携するサービスの設定（アプリ全体。プロバイダの ID ごと）。トークンは入れない（src/secrets.js に保存する）
  issueComments: true, // タスクの開始・PR の作成・完了を Issue にコメントする（commentEvents を持つサービスだけ。GitHub は書かない）
  codeHost: '', // origin を gh の代わりに扱うコードのホスト（gitlab）。画面の文言を決める。リポジトリを開いたときに origin から決める
  issueStatusSync: true, // Issue から作ったタスクの列に合わせて、サービスの Issue の状態を変える（GitHub なら Projects の Status: In progress / In review / Done）
  statusFieldName: '', // Projects で変える項目（単一選択）の名前。空なら「Status」
  statusMapping: { inProgress: '', inReview: '', done: '' }, // 列ごとに使う選択肢の名前（カンマ区切りで複数可）。空なら名前から自動で探す
  customAgents: [], // カスタムエージェント（元にする CLI・モデルと、プロフィール: 名前・アイコンと色・説明・振る舞いの指示）。タスク・会話・Pipeline・競争で選べる
  competeCustomAgents: [], // 前の版の設定: 競争に加えるカスタムエージェントの ID。今は competes を使う（読み込むときに competes へ移す）
  competes: cleanCompetes(legacyCompetes(DEFAULT_COMPETE_AGENTS, []), []), // 競争の一覧 [{ id, name, agents, customAgents }]（プロジェクトごと。いくつでも作れる）。タスクを作るときに「compete:<ID>」で選ぶ
  relayFlow: DEFAULT_RELAY_FLOW, // 既定の Pipelineのフローチャート（工程・分岐・並列・合流・ループ）。relayFlows の既定の分と同じ中身
  relayFlows: [], // Pipeline の一覧 [{ id, name, flow }]（プロジェクトごと。空なら relayFlow から1つ作る）
  relayFlowId: '', // 既定の Pipeline の ID（タスクを作るときに最初から選んでおく）
  pushAfterMerge: true, // マージしたあと origin にも push する（マージのダイアログで最後に選んだもの）
  suggestSkillsOnDone: true, // タスクが完了したとき、前に完了したタスクと似た作業なら「スキルにしませんか？」と通知する
  deleteSessionsOnMerge: true, // マージして完了したら、そのタスクが作業に使った Claude Code の会話を消す
  ciAutoFix: true, // PR の CI が失敗したら、エージェントに直してもらって push する
  reviewAutoFix: false, // PR にレビューコメントが付いたら、エージェントに直してもらって push し、返信して解決する
  specCheck: true, // 新しいタスクの内容が詰まっていなければ、開発を始める前にエージェントと対話して仕様を詰める
  subtaskMerge: 'auto', // サブタスクが終わったら親のブランチへ自動でマージする（'review' ならユーザーが確かめてから）。タスクごとに開始前に変えられる
  sprintBranch: false, // スプリントごとにブランチを作り、スプリントに入っているタスクはそこから始めてそこへマージする（プロジェクトごと）
  branchNamingRule: '', // ブランチの命名規則（自然言語）。空なら agent/issue-12-xxxx のようないつもの名前
  weeklyResetDay: '', // Claude の週間上限がリセットされる曜日（'0'=日〜'6'=土）。空なら claude が知らせてくる日時を使う
  weeklyResetTime: '00:00', // 週間上限がリセットされる時刻（HH:MM・ローカル時刻）。weeklyResetDay を決めたときに使う
  language: I18n.DEFAULT_LANGUAGE, // 画面の言葉。初めて入れたときは英語。language のない既存の board.json は読み込み時に ja にする
  autoUpdate: false, // 新しい版が出たら、実行中・待機中のタスクがないときに自動で入れ替えて起動し直す
  updatePending: null, // 更新のために終了したときの { from, to, at }（次の起動で、更新できたかを知らせる）
  // ---- エージェント ----
  enabledAgents: DEFAULT_ENABLED_AGENTS, // 使うエージェント（チェックを付けたものだけ、コマンド・モデルを設定してタスクや会話で選べる）
  defaultAgent: 'claude', // 新しいタスク・会話で最初から選んでおくもの（プロジェクトごと。claude / codex / antigravity / gemini / cursor / opencode / copilot / amp / pi / droid か、このプロジェクトのカスタムエージェント「custom:<ID>」・Pipeline「relay:<ID>」・競争「compete:<ID>」。会話では Pipeline・競争のときは使うエージェントの先頭）
  codexPath: 'codex',
  codexModel: '',
  antigravityPath: 'agy',
  antigravityModel: '',
  geminiPath: 'gemini',
  geminiModel: '',
  cursorPath: 'cursor-agent',
  cursorModel: '',
  opencodePath: 'opencode',
  opencodeModel: '',
  copilotPath: 'copilot',
  copilotModel: '',
  ampPath: 'amp',
  ampModel: '',
  piPath: 'pi',
  piModel: '',
  droidPath: 'droid',
  droidModel: '',
  // ---- オーケストレーション ----
  orchestration: 'relay', // 前の版の設定（Pipelineと競争は排他で、どちらか1つだけ使えた）。今は使わない
  relaySteps: DEFAULT_RELAY_STEPS, // 前のバージョンのPipelineの工程のリスト（アプリ全体で1つ）。今はプロジェクトごとの relayFlow を使う。読み込むときに relayFlow へ移す
  competeAgents: DEFAULT_COMPETE_AGENTS, // 前の版の設定（アプリ全体の競争のエージェント）。今はプロジェクトごとの competes を使う。新しいプロジェクトの最初の競争に使う
  // ---- 遠隔操作（SSH トンネル前提。アプリ同士） ----
  remoteHostEnabled: false, // このマシンをホスト（作業側）として 127.0.0.1 で待ち受ける
  remotePort: 17831, // ホストの待ち受けポート（クライアントは SSH -L でここにトンネルする）
  remotePairTokens: [], // ペアリング済みクライアントのトークン（ホスト側）
  remoteClientHost: '127.0.0.1', // 接続先（トンネル後は通常 127.0.0.1）
  remoteClientPort: 17831,
  remoteClientToken: '', // ペアリング後に保存するトークン（クライアント側）
  remoteClientHistory: [], // これまでつないだ接続先とそのトークン（新しい順）。RC設定のカードから選んでつなぎ直す
  remoteClientResume: false, // 前回クライアントとして接続していた（自分で切断していない）。次の起動時や切れたときに自動でつなぎ直す
  remoteClientMode: 'ssh', // 'ssh' = アプリが SSH トンネルを張る / 'direct' = 自分で張ったトンネルなどへ直接つなぐ
  remoteSshHost: '', // SSH の接続先（Tailscale の IP やホスト名）
  remoteSshUser: '', // SSH のユーザー名（Mac のログイン名）
  remoteSshPort: 22,
  remoteSshKey: '', // 鍵ファイル（空なら ssh の既定）
  remoteSshPath: 'ssh', // ssh コマンド
  // ---- スマホから使う（外から Cloudflare Tunnel を通して、スマホのブラウザで操作する） ----
  mobileEnabled: false, // スマホ用のサーバーとトンネルを動かす（起動時にも再開する）
  mobilePort: 17832, // スマホ用のサーバーの待ち受けポート（127.0.0.1）。名前付きトンネルはここへ向ける
  mobileTerminalEnabled: false, // スマホからアプリの中のターミナル（シェル）を使ってよいか。シェルを丸ごと渡すので既定はオフ
  mobileDevices: [], // ペアリングしたスマホ（トークンは SHA-256 だけ）
  mobileTunnelMode: 'quick', // 'quick' = Quick Tunnel（URL が起動ごとに変わる） / 'named' = 名前付きトンネル
  mobileNamedHostname: '', // 名前付きトンネルで公開するホスト名（トークンは secrets.json）
  cloudflaredPath: '', // cloudflared のパス（空なら探す）
  // ---- CLI・MCP（ほかのツールから操作する。src/api-server.js） ----
  apiEnabled: true, // API を動かす（127.0.0.1 だけ。同じ PC の CLI・MCP は userData/api.json のトークンで使う）
  apiPort: 47821, // API の待ち受けポート（127.0.0.1）。ふさがっていたら空いているポートを使う
  apiDevices: [], // ペアリングしたほかの PC（トークンは SHA-256 だけ）
  // ---- サイクル（期間とゴールを持つ、タスクのまとまり） ----
  // ---- 進捗のアニメーション（renderer/agent-sprite.js の SCENES） ----
  progressScene: 'random', // 'random' = タスクごとにランダム / 'quest' / 'dance' / 'garden' / 'space'
  cycleView: 'top', // 'top' = ボードの上のタブ / 'sidebar' = 左のサイドバー / 'lanes' = 列の中をサイクルごとの段に分ける
};

const WEEK_MS = 7 * 24 * 60 * 60 * 1000;
const COST_LOG_KEEP_MS = 8 * WEEK_MS; // これより古い金額の記録は捨てる

// リセット日時の1つ（anchor）から、now を含む1週間 [start, end) を求める
function weekAround(anchorMs, now) {
  const k = Math.floor((now - anchorMs) / WEEK_MS) + 1;
  const end = anchorMs + k * WEEK_MS;
  return { start: end - WEEK_MS, end };
}

// 曜日と時刻（ローカル）から、直近のリセット日時を1つ作る
function anchorFromDay(day, time, now) {
  const [h, m] = String(time || '00:00').split(':').map((v) => parseInt(v, 10) || 0);
  const d = new Date(now);
  d.setHours(Math.min(23, Math.max(0, h)), Math.min(59, Math.max(0, m)), 0, 0);
  d.setDate(d.getDate() + ((Number(day) - d.getDay() + 7) % 7));
  return d.getTime();
}

const MAX_NOTIFICATIONS = 200;

// ---------- プロジェクト（リポジトリ）ごとの設定 ----------
// リポジトリに関わる設定だけをプロジェクトごとに持つ。コマンドのパス・モデル・同時に動かす数・自動更新などはアプリ全体で1つ
const REPO_SETTING_KEYS = ['baseBranch', 'integration', 'branchNamingRule', 'issueProvider', 'issueComments', 'codeHost', 'issueStatusSync', 'statusFieldName', 'statusMapping', 'permissionMode', 'allowedTools', 'defaultSkill', 'specCheck', 'ciAutoFix', 'reviewAutoFix', 'subtaskMerge', 'sprintBranch', 'pushAfterMerge', 'relayFlow', 'relayFlows', 'relayFlowId', 'customAgents', 'competeCustomAgents', 'competes', 'defaultAgent', 'setupScript', 'teardownScript', 'runScript', 'portStart', 'portCount'];
const MAX_REPO_SETTINGS = 200;

// 初めて開いたプロジェクトの設定（初期値。取り込み方は PR を作成。GitHub でないリポジトリは開いたときに直接マージにする）
function defaultRepoSettings() {
  const out = {};
  for (const k of REPO_SETTING_KEYS) out[k] = k === 'statusMapping' ? { ...DEFAULT_SETTINGS.statusMapping } : k === 'relayFlow' ? cloneFlow(defaultRelayFlow()) : k === 'competes' ? JSON.parse(JSON.stringify(DEFAULT_SETTINGS.competes)) : Array.isArray(DEFAULT_SETTINGS[k]) ? [...DEFAULT_SETTINGS[k]] : DEFAULT_SETTINGS[k];
  return out;
}

// 保存してある、そのリポジトリの設定。初めて開くリポジトリは初期値にし、Pipeline は今使えるエージェントで組む
function savedRepoSettings(settings, dir) {
  const saved = (settings.repoSettings || {})[dir];
  // 最初から選んでおくエージェントは、今の値を引き継ぐ（カスタムエージェントはプロジェクトごとなので、その元にするエージェント）
  // 競争の一覧がない（初めて開く・前の版の）プロジェクトは、アプリ全体の competeAgents から1つ作る
  if (saved) return pickRepoSettings(saved.competes === undefined ? { ...saved, competeAgents: settings.competeAgents } : saved);
  return pickRepoSettings({ relayFlow: defaultRelayFlow(settings.enabledAgents), defaultAgent: defaultAgentOf(settings), competeAgents: settings.competeAgents });
}

// 設定から、プロジェクトごとの項目だけを取り出す（足りない項目は初期値）
function pickRepoSettings(src) {
  const out = defaultRepoSettings();
  if (!src || typeof src !== 'object') return out;
  for (const k of REPO_SETTING_KEYS) if (src[k] !== undefined) out[k] = k === 'statusMapping' ? { ...out.statusMapping, ...(src[k] || {}) } : src[k];
  if (!['merge', 'pr'].includes(out.integration)) out.integration = DEFAULT_SETTINGS.integration;
  if (!['auto', 'review'].includes(out.subtaskMerge)) out.subtaskMerge = 'auto';
  out.sprintBranch = out.sprintBranch === true;
  out.portCount = cleanPortCount(out.portCount);
  out.portStart = cleanPortStart(out.portStart, out.portCount);
  out.issueProvider = String(out.issueProvider || '') || DEFAULT_SETTINGS.issueProvider;
  // 既定の Pipeline のフローは relayFlow を正とする（前の版の設定・relayFlow を直接変えたときも、一覧の既定の分に入る）
  Object.assign(out, cleanRelayFlows(out.relayFlows, out.relayFlowId, src.relayFlow !== undefined ? src.relayFlow : undefined));
  out.customAgents = cleanCustomAgents(out.customAgents);
  out.competeCustomAgents = cleanCompeteCustomAgents(out.competeCustomAgents, out.customAgents);
  // 競争の一覧がなかったころの設定: competeAgents（アプリ全体）と competeCustomAgents から1つ作る
  out.competes = cleanCompetes(Array.isArray(src.competes) ? src.competes : legacyCompetes(src.competeAgents, out.competeCustomAgents), out.customAgents);
  const ref = out.defaultAgent;
  const known = isAgent(ref) || isCustomRef(ref) || (typeof ref === 'string' && ref.startsWith('relay:') && out.relayFlows.some((p) => 'relay:' + p.id === ref)) || (typeof ref === 'string' && ref.startsWith('compete:') && out.competes.some((x) => 'compete:' + x.id === ref));
  if (!known) out.defaultAgent = DEFAULT_SETTINGS.defaultAgent;
  return out;
}

const MAX_PORT_COUNT = 100;

// 1つのタスクに割り当てるポートの数（1〜100）
function cleanPortCount(v) {
  const n = parseInt(v, 10);
  return Number.isFinite(n) ? Math.min(MAX_PORT_COUNT, Math.max(1, n)) : DEFAULT_SETTINGS.portCount;
}

// ポートを探し始める番号（1024〜。最後の組が 65535 を越えないように）
function cleanPortStart(v, count = DEFAULT_SETTINGS.portCount) {
  const n = parseInt(v, 10);
  if (!Number.isFinite(n)) return DEFAULT_SETTINGS.portStart;
  return Math.min(65536 - cleanPortCount(count), Math.max(1024, n));
}

// 競争に加えるカスタムエージェントの ID（あるものだけ・重なりなし）
function cleanCompeteCustomAgents(list, customAgents) {
  const ids = new Set((customAgents || []).map((x) => x.id));
  const out = [];
  for (const v of Array.isArray(list) ? list : []) {
    const id = String(v || '').replace(/^custom:/, '');
    if (ids.has(id) && !out.includes(id)) out.push(id);
  }
  return out;
}

function cleanRepoSettingsMap(map) {
  const out = {};
  if (!map || typeof map !== 'object' || Array.isArray(map)) return out;
  for (const [p, v] of Object.entries(map).slice(-MAX_REPO_SETTINGS)) if (String(p || '').trim() && v && typeof v === 'object') out[p] = pickRepoSettings(v);
  return out;
}

// そのリポジトリの設定（今のリポジトリなら、画面で変えた今の値）
function repoSettingsOf(settings, dir) {
  const d = String(dir || '').trim();
  if (!settings) return defaultRepoSettings();
  if (!d || d === settings.repoPath) return pickRepoSettings(settings);
  return savedRepoSettings(settings, d);
}

function hasRepoSettings(settings, dir) {
  const d = String(dir || '').trim();
  return !!d && !!settings && (d === settings.repoPath || Object.prototype.hasOwnProperty.call(settings.repoSettings || {}, d));
}

// 今のリポジトリの設定を repoSettings に書き戻す
function stashRepoSettings(settings) {
  if (!settings) return;
  const map = settings.repoSettings && typeof settings.repoSettings === 'object' && !Array.isArray(settings.repoSettings) ? { ...settings.repoSettings } : {};
  if (settings.repoPath) {
    delete map[settings.repoPath]; // 新しく使ったものを後ろにする（多すぎるときは古いものから捨てる）
    map[settings.repoPath] = pickRepoSettings(settings);
  }
  settings.repoSettings = cleanRepoSettingsMap(map);
}

// 今のリポジトリを切り替える: 今の分を書き戻して、開くリポジトリの分（なければ初期値）を写す
function switchRepoSettings(settings, dir) {
  stashRepoSettings(settings);
  const d = String(dir || '').trim();
  const next = d ? savedRepoSettings(settings, d) : defaultRepoSettings();
  settings.repoPath = d;
  Object.assign(settings, next);
  if (d) settings.repoSettings[d] = pickRepoSettings(next);
}

// そのリポジトリの設定を変える（今のリポジトリなら今の値も変える）
function setRepoSettings(settings, dir, patch) {
  const d = String(dir || '').trim();
  if (!settings || !d || !patch) return;
  const map = settings.repoSettings && typeof settings.repoSettings === 'object' && !Array.isArray(settings.repoSettings) ? { ...settings.repoSettings } : {};
  const cur = d === settings.repoPath ? pickRepoSettings(settings) : savedRepoSettings({ ...settings, repoSettings: map }, d);
  const relay = relayPatchOf(cur, patch);
  if (relay) patch = { ...patch, ...relay };
  const keys = Object.keys(patch).filter((k) => REPO_SETTING_KEYS.includes(k));
  if (d === settings.repoPath) for (const k of keys) settings[k] = patch[k];
  for (const k of keys) cur[k] = patch[k];
  map[d] = pickRepoSettings(cur);
  settings.repoSettings = map;
}

// ---------- リポジトリで共有する設定（.worktree-kanban/settings.json） ----------

const SHARED_KEYS = Shared.sharedKeys(REPO_SETTING_KEYS);
const SHARED_SPEC = { keys: SHARED_KEYS, defaults: DEFAULT_SETTINGS };
const SCRIPT_KINDS_SHARED = Object.keys(Shared.SCRIPT_KEYS);

function cleanSharedInfo(v) {
  const o = v && typeof v === 'object' && !Array.isArray(v) ? v : {};
  const list = (x) => [...new Set((Array.isArray(x) ? x : []).filter((k) => SHARED_KEYS.includes(k)))];
  const approved = {};
  const a = o.approved && typeof o.approved === 'object' && !Array.isArray(o.approved) ? o.approved : {};
  for (const kind of SCRIPT_KINDS_SHARED) if (typeof a[kind] === 'string' && /^[0-9a-f]{64}$/.test(a[kind])) approved[kind] = a[kind];
  const keys = list(o.keys);
  // 上書きは、ファイルにある項目だけ
  return { keys, overrides: list(o.overrides).filter((k) => keys.includes(k)), approved };
}

function cleanSharedRepos(map) {
  const out = {};
  if (!map || typeof map !== 'object' || Array.isArray(map)) return out;
  for (const [p, v] of Object.entries(map).slice(-MAX_REPO_SETTINGS)) if (String(p || '').trim()) out[p] = cleanSharedInfo(v);
  return out;
}

function sharedInfoOf(settings, dir) {
  const d = String(dir || '').trim();
  return cleanSharedInfo(d && settings && settings.sharedRepos ? settings.sharedRepos[d] : null);
}

function putSharedInfo(settings, dir, info) {
  const map = settings.sharedRepos && typeof settings.sharedRepos === 'object' && !Array.isArray(settings.sharedRepos) ? { ...settings.sharedRepos } : {};
  map[dir] = cleanSharedInfo(info);
  settings.sharedRepos = map;
}

// ファイルの値を使っている（ファイルにあって、この PC で上書きしていない）項目
function sharedActiveKeys(settings, dir) {
  const info = sharedInfoOf(settings, dir);
  return info.keys.filter((k) => !info.overrides.includes(k));
}

/**
 * 共有ファイルの値を、そのリポジトリの設定に当てる（ファイルにあって、上書きしていない項目だけ）
 * @param {object} settings
 * @param {string} dir
 * @param {{ exists: boolean, values: object, error?: string }} shared readShared の結果
 * @returns {boolean} 設定が変わったか
 */
function applySharedSettings(settings, dir, shared) {
  const d = String(dir || '').trim();
  if (!settings || !d) return false;
  const prev = sharedInfoOf(settings, d);
  // 読めなかったときは、前に読んだ分のまま（壊れたファイルで設定を消さない）
  if (shared && shared.error) return false;
  const values = (shared && shared.exists && shared.values) || {};
  const keys = SHARED_KEYS.filter((k) => values[k] !== undefined);
  const info = { ...prev, keys, overrides: prev.overrides.filter((k) => keys.includes(k)) };
  if (!keys.length && !Object.keys(prev.approved).length) {
    const had = settings.sharedRepos && Object.prototype.hasOwnProperty.call(settings.sharedRepos, d);
    if (had) {
      const map = { ...settings.sharedRepos };
      delete map[d];
      settings.sharedRepos = map;
    }
  } else putSharedInfo(settings, d, info);
  const before = repoSettingsOf(settings, d);
  const merged = { ...before };
  const use = keys.filter((k) => !info.overrides.includes(k));
  for (const k of use) merged[k] = values[k];
  // Pipeline の一覧だけを書いたファイル: 一覧の既定のフローを使う（手元の relayFlow で上書きしない）
  if (use.some((k) => k === 'relayFlows' || k === 'relayFlowId') && !use.includes('relayFlow')) delete merged.relayFlow;
  const next = pickRepoSettings(merged);
  const changed = JSON.stringify(next) !== JSON.stringify(before);
  if (!changed) return false;
  const map = settings.repoSettings && typeof settings.repoSettings === 'object' && !Array.isArray(settings.repoSettings) ? { ...settings.repoSettings } : {};
  map[d] = next;
  settings.repoSettings = map;
  if (d === settings.repoPath) Object.assign(settings, next);
  return true;
}

/**
 * 画面で変えた項目のうち、ファイルの値から変わったものを「この PC で上書き」にする
 * @returns {string[]} 新しく上書きにした項目
 */
function noteSharedOverrides(settings, dir, before, after) {
  const d = String(dir || '').trim();
  if (!settings || !d) return [];
  const info = sharedInfoOf(settings, d);
  const changed = info.keys.filter((k) => !info.overrides.includes(k) && JSON.stringify(before[k]) !== JSON.stringify(after[k]));
  if (!changed.length) return [];
  const added = Shared.expandKeys(changed).filter((k) => info.keys.includes(k) && !info.overrides.includes(k));
  putSharedInfo(settings, d, { ...info, overrides: [...info.overrides, ...added] });
  return added;
}

// 上書きをやめる（keys を省くとすべて）。値は、次に applySharedSettings したときにファイルの値に戻る
function clearSharedOverrides(settings, dir, keys) {
  const d = String(dir || '').trim();
  const info = sharedInfoOf(settings, d);
  if (!d || !info.overrides.length) return;
  const drop = Array.isArray(keys) ? Shared.expandKeys(keys) : info.overrides;
  putSharedInfo(settings, d, { ...info, overrides: info.overrides.filter((k) => !drop.includes(k)) });
}

// そのスクリプトは共有ファイルから来たもの（ファイルにあって、この PC で上書きしていない）か
function isSharedScript(settings, dir, kind) {
  const key = Shared.SCRIPT_KEYS[kind];
  return !!key && sharedActiveKeys(settings, dir).includes(key);
}

function isScriptApproved(settings, dir, kind, script) {
  return sharedInfoOf(settings, dir).approved[kind] === Shared.scriptHash(script);
}

function approveScript(settings, dir, kind, script) {
  const d = String(dir || '').trim();
  if (!d || !Shared.SCRIPT_KEYS[kind]) return;
  const info = sharedInfoOf(settings, d);
  putSharedInfo(settings, d, { ...info, approved: { ...info.approved, [kind]: Shared.scriptHash(script) } });
}

// プロジェクトごとの設定がなかったころの設定: 今まで使っていたリポジトリには、今までの値（ベースブランチはリポジトリごとに覚えていた分）を入れておく
// 取り込み方を保存していなければ、そのころの初期値（直接マージ）にする
function migrateRepoSettings(settings, raw, cards) {
  // Pipelineがフローチャートになる前の設定: アプリ全体の工程のリストを、それぞれのプロジェクトのフローにする
  if (raw.relayFlow === undefined && Array.isArray(raw.relaySteps)) {
    const legacy = FlowModel.flowFromSteps(cleanRelaySteps(raw.relaySteps));
    settings.relayFlow = legacy;
    raw = { ...raw, relayFlow: legacy };
    if (raw.repoSettings && typeof raw.repoSettings === 'object' && !Array.isArray(raw.repoSettings)) {
      const map = {};
      for (const [p, v] of Object.entries(raw.repoSettings)) map[p] = v && typeof v === 'object' && v.relayFlow === undefined ? { ...v, relayFlow: cloneFlow(legacy) } : v;
      raw = { ...raw, repoSettings: map };
    }
  }
  if (raw.repoSettings && typeof raw.repoSettings === 'object' && !Array.isArray(raw.repoSettings)) {
    // 最初から選んでおくエージェントがアプリ全体の設定だったころの分: どのプロジェクトにも今までの値を入れておく
    const map = {};
    // 競争の一覧がなかったころの分: アプリ全体の competeAgents から作る
    for (const [p, v] of Object.entries(raw.repoSettings)) {
      let x = v && typeof v === 'object' && v.defaultAgent === undefined ? { ...v, defaultAgent: settings.defaultAgent } : v;
      if (x && typeof x === 'object' && x.competes === undefined) x = { ...x, competeAgents: settings.competeAgents };
      map[p] = x;
    }
    settings.repoSettings = cleanRepoSettingsMap(map);
    if (settings.repoPath && !settings.repoSettings[settings.repoPath]) settings.repoSettings[settings.repoPath] = pickRepoSettings(settings);
    delete settings.repoBaseBranches;
    return;
  }
  const old = { ...raw, integration: raw.integration === 'pr' ? 'pr' : 'merge', defaultAgent: settings.defaultAgent };
  const bases = raw.repoBaseBranches && typeof raw.repoBaseBranches === 'object' && !Array.isArray(raw.repoBaseBranches) ? raw.repoBaseBranches : {};
  const paths = new Set();
  const add = (p) => {
    const s = String(p || '').trim();
    if (s) paths.add(s);
  };
  add(settings.repoPath);
  for (const p of settings.repoTabs || []) add(p);
  for (const p of settings.recentRepoPaths || []) add(p);
  for (const p of Object.keys(bases)) add(p);
  for (const c of cards || []) add(c && c.repoPath);
  const map = {};
  for (const p of paths) {
    const base = p === settings.repoPath ? String(raw.baseBranch || '') : String(bases[p] || '');
    map[p] = pickRepoSettings({ ...old, baseBranch: base });
  }
  settings.repoSettings = cleanRepoSettingsMap(map);
  // 今のリポジトリの値も、今までの値にそろえる
  Object.assign(settings, settings.repoPath ? settings.repoSettings[settings.repoPath] : pickRepoSettings(old));
  delete settings.repoBaseBranches;
}

// 前のバージョンの設定を今の形に直す
function migrateSettings(settings, raw, cards) {
  if (!Array.isArray(raw.enabledAgents)) {
    // 「使うエージェント」がなかったころの設定: 今まで使っていたエージェントにチェックを付けておく
    const used = new Set(['claude']);
    const d = raw.defaultAgent;
    if (isAgent(d)) used.add(d);
    if (d === 'relay') for (const st of settings.relaySteps || []) used.add(st && st.agent);
    if (d === 'compete') for (const a of settings.competeAgents || []) used.add(a);
    for (const c of cards) if (c && c.agent) used.add(c.agent);
    settings.enabledAgents = cleanEnabledAgents([...used]);
  } else settings.enabledAgents = cleanEnabledAgents(raw.enabledAgents);
  // 前の版の設定（Pipelineと競争は排他だった）。今は使わないが、知らない値はそろえておく
  settings.orchestration = cleanOrchestration(settings.orchestration);
  // 最初から選んでおくもの（1つのエージェント・カスタムエージェント・Pipeline・競争）。
  // 前の版の「relay」「compete」だけの値や、消えた・元の CLI を使わない設定のものなら、使うものの先頭
  if (raw.competes === undefined) settings.competes = cleanCompetes(legacyCompetes(settings.competeAgents, settings.competeCustomAgents), cleanCustomAgents(settings.customAgents));
  settings.defaultAgent = defaultTaskRefOf(settings);
  // 最近開いたリポジトリ: なければ今のリポジトリとカードから起こす
  settings.recentRepoPaths = cleanRecentRepoPaths(settings.recentRepoPaths);
  if (!settings.recentRepoPaths.length) settings.recentRepoPaths = seedRecentRepoPaths(settings, cards);
  // タブがなかったころの設定: 今のリポジトリだけのタブにする
  settings.repoTabs = cleanRepoTabs(settings.repoTabs, settings.repoPath);
  migrateRepoSettings(settings, raw, cards);
  Object.assign(settings, cleanRelayFlows(settings.relayFlows, settings.relayFlowId, settings.relayFlow));
  // ファイルに言語がなければ、これまでの表示（日本語）のままにする。新規の初期値 en で上書きしない
  if (!I18n.isLanguage(raw && raw.language)) settings.language = I18n.LEGACY_LANGUAGE;
}

class Store {
  constructor(file) {
    this.file = file;
    // 言語は main.js が setLanguage したあとに new Store する。ここでは setLanguage しない
    // 読めないときの初期 language は、その時点の表示言語（欠けたファイルは en、壊れたファイルは ja）
    this.data = { settings: { ...DEFAULT_SETTINGS, language: I18n.getLanguage(), relaySteps: defaultRelaySteps(), relayFlow: cloneFlow(defaultRelayFlow()), agentsUnset: true }, cards: [], removedCost: {}, costLog: [], weeklyResetAt: 0, notifications: [], schedules: [], cycles: [] };
    this.timer = null;
    this.load();
  }

  load() {
    try {
      const raw = JSON.parse(fs.readFileSync(this.file, 'utf8'));
      this.data.settings = { ...DEFAULT_SETTINGS, ...(raw.settings || {}) };
      this.data.settings.statusMapping = { ...DEFAULT_SETTINGS.statusMapping, ...(this.data.settings.statusMapping || {}) };
      this.data.cards = Array.isArray(raw.cards) ? raw.cards : [];
      this.data.removedCost = raw.removedCost && typeof raw.removedCost === 'object' ? raw.removedCost : {};
      this.data.notifications = Array.isArray(raw.notifications) ? raw.notifications : [];
      this.data.costLog = Array.isArray(raw.costLog) ? raw.costLog : [];
      this.data.weeklyResetAt = Number(raw.weeklyResetAt) || 0;
      this.data.schedules = cleanSchedules(raw.schedules);
      this.data.cycles = cleanCycles(raw.cycles);
      migrateSettings(this.data.settings, raw.settings || {}, this.data.cards);
      this.data.settings.cycleView = cleanCycleView(this.data.settings.cycleView);
      this.data.settings.sharedRepos = cleanSharedRepos(this.data.settings.sharedRepos);
    } catch {
      /* ファイルが無い、または壊れている。language はコンストラクタで入れた表示言語のまま */
    }
  }

  save() {
    clearTimeout(this.timer);
    this.timer = setTimeout(() => this.flush(), 300);
  }

  flush() {
    clearTimeout(this.timer);
    stashRepoSettings(this.data.settings);
    fs.mkdirSync(path.dirname(this.file), { recursive: true });
    const tmp = `${this.file}.tmp`;
    fs.writeFileSync(tmp, JSON.stringify(this.data));
    fs.renameSync(tmp, this.file);
  }

  /**
   * 使うエージェントをまだ決めていない（初めて起動した）ときに、インストールされているエージェントを使う設定にする。
   * 見つからなければ何も変えず、次に起動したときにまた探す。ユーザーが設定を保存したあとは変えない
   * @param {string[]} found 見つかったエージェント
   * @returns {boolean} 変えたか
   */
  adoptAgents(found) {
    const s = this.data.settings;
    const list = (found || []).filter(isAgent);
    if (!s.agentsUnset || !list.length) return false;
    delete s.agentsUnset;
    s.enabledAgents = cleanEnabledAgents(list);
    s.defaultAgent = s.enabledAgents[0];
    s.competeAgents = [...s.enabledAgents];
    // 最初の競争も、見つかったエージェントで組む（まだ手を入れていない初期値のときだけ）
    if (Array.isArray(s.competes) && s.competes.length === 1 && s.competes[0].id === 'default') s.competes = [{ ...s.competes[0], agents: [...s.enabledAgents] }];
    if (!s.repoPath) Object.assign(s, cleanRelayFlows([], '', defaultRelayFlow(s.enabledAgents)));
    this.save();
    return true;
  }

  get settings() {
    return this.data.settings;
  }

  get cards() {
    return this.data.cards;
  }

  // そのリポジトリ（プロジェクト）の設定。タブで開いていない・裏で動いているリポジトリのタスクでも、そのリポジトリの分を使う
  repoSettings(dir) {
    return repoSettingsOf(this.data.settings, dir);
  }

  setRepoSettings(dir, patch) {
    setRepoSettings(this.data.settings, dir, patch);
  }

  // 画面での操作で変える（ファイルの値から変わった項目は、この PC の上書きにする）
  setRepoSettingsByUser(dir, patch) {
    const before = this.repoSettings(dir);
    setRepoSettings(this.data.settings, dir, patch);
    noteSharedOverrides(this.data.settings, dir, before, this.repoSettings(dir));
  }

  // ---- リポジトリで共有する設定 ----
  sharedInfo(dir) {
    return sharedInfoOf(this.data.settings, dir);
  }

  applyShared(dir, shared) {
    return applySharedSettings(this.data.settings, dir, shared);
  }

  noteSharedOverrides(dir, before, after) {
    return noteSharedOverrides(this.data.settings, dir, before, after);
  }

  clearSharedOverrides(dir, keys) {
    clearSharedOverrides(this.data.settings, dir, keys);
  }

  isSharedScript(dir, kind) {
    return isSharedScript(this.data.settings, dir, kind);
  }

  isScriptApproved(dir, kind, script) {
    return isScriptApproved(this.data.settings, dir, kind, script);
  }

  approveScript(dir, kind, script) {
    approveScript(this.data.settings, dir, kind, script);
  }

  get notifications() {
    return this.data.notifications;
  }

  // 通知を足す（新しいものが先頭）。古いものから捨てる
  addNotification(n) {
    this.data.notifications.unshift(n);
    if (this.data.notifications.length > MAX_NOTIFICATIONS) this.data.notifications.length = MAX_NOTIFICATIONS;
    return n;
  }

  card(id) {
    return this.data.cards.find((c) => c.id === id);
  }

  // タスクスケジューラのスケジュール（全リポジトリの分。動かすときはタブを開いていないリポジトリの分も使う）
  get schedules() {
    return this.data.schedules;
  }

  // そのリポジトリのスケジュール（画面に渡す分）
  schedulesOf(repoPath) {
    return this.data.schedules.filter((s) => s.repoPath === repoPath);
  }

  schedule(id) {
    return this.data.schedules.find((s) => s.id === id);
  }

  addSchedule(s) {
    this.data.schedules.push(s);
    return s;
  }

  removeSchedule(id) {
    this.data.schedules = this.data.schedules.filter((s) => s.id !== id);
  }

  // サイクル（全リポジトリの分）
  get cycles() {
    return this.data.cycles;
  }

  // そのリポジトリのサイクル（画面に渡す分）
  cyclesOf(repoPath) {
    return this.data.cycles.filter((c) => c.repoPath === repoPath);
  }

  cycle(id) {
    return this.data.cycles.find((c) => c.id === id);
  }

  addCycle(c) {
    this.data.cycles.push(c);
    return c;
  }

  removeCycle(id) {
    this.data.cycles = this.data.cycles.filter((c) => c.id !== id);
  }

  // 削除したタスクで使った金額も合計に残すため、リポジトリごとに足し込んでおく
  removeCard(id) {
    const c = this.card(id);
    if (c && c.costUsd) {
      const key = c.repoPath || '';
      this.data.removedCost[key] = (Number(this.data.removedCost[key]) || 0) + c.costUsd;
    }
    this.data.cards = this.data.cards.filter((c) => c.id !== id);
  }

  // そのリポジトリで使った金額の合計（USD）。削除したタスクの分も含む
  totalCost(repoPath) {
    const live = this.data.cards
      .filter((c) => !repoPath || c.repoPath === repoPath)
      .reduce((sum, c) => sum + (Number(c.costUsd) || 0), 0);
    const removed = repoPath
      ? Number(this.data.removedCost[repoPath]) || 0
      : Object.values(this.data.removedCost).reduce((sum, v) => sum + (Number(v) || 0), 0);
    return live + removed;
  }

  // 使った金額を日時つきで残す（週ごとの合計に使う）
  addCost(repoPath, usd, at = Date.now()) {
    const v = Number(usd) || 0;
    if (v <= 0) return;
    this.data.costLog.push({ at, repo: repoPath || '', usd: v });
    const limit = at - COST_LOG_KEEP_MS;
    if (this.data.costLog[0] && this.data.costLog[0].at < limit) this.data.costLog = this.data.costLog.filter((e) => e.at >= limit);
  }

  // claude が知らせてきた週間上限のリセット日時（ミリ秒）を覚えておく
  setWeeklyResetAt(ms) {
    const v = Number(ms) || 0;
    if (v > 0 && v !== this.data.weeklyResetAt) {
      this.data.weeklyResetAt = v;
      return true;
    }
    return false;
  }

  // 今の週（週間上限のリセットからリセットまで）の期間と、その間に使った金額
  // source: 'settings'（設定の曜日・時刻）/ 'claude'（claude が知らせてきた日時）/ 'default'（どちらもないので月曜 0:00）
  weeklyCost(repoPath, now = Date.now()) {
    const s = this.data.settings;
    let anchor;
    let source;
    if (s.weeklyResetDay !== '' && s.weeklyResetDay != null && /^[0-6]$/.test(String(s.weeklyResetDay))) {
      anchor = anchorFromDay(s.weeklyResetDay, s.weeklyResetTime, now);
      source = 'settings';
    } else if (this.data.weeklyResetAt) {
      anchor = this.data.weeklyResetAt;
      source = 'claude';
    } else {
      anchor = anchorFromDay(1, '00:00', now);
      source = 'default';
    }
    const { start, end } = weekAround(anchor, now);
    const usd = this.data.costLog
      .filter((e) => (!repoPath || e.repo === repoPath) && e.at >= start && e.at < end)
      .reduce((sum, e) => sum + (Number(e.usd) || 0), 0);
    return { usd, start, end, source };
  }
}

module.exports = {
  migrateSettings,
  cleanRelayFlow,
  cleanRelayFlows,
  cleanPipelineName,
  PIPELINE_NAME_MAX,
  relayPatchOf,
  pipelineOf,
  MAX_RELAY_FLOWS,
  DEFAULT_RELAY_FLOW,
  REPO_SETTING_KEYS,
  SHARED_KEYS,
  SHARED_SPEC,
  cleanPortCount,
  cleanPortStart,
  MAX_PORT_COUNT,
  cleanSharedRepos,
  sharedInfoOf,
  sharedActiveKeys,
  applySharedSettings,
  noteSharedOverrides,
  clearSharedOverrides,
  isSharedScript,
  isScriptApproved,
  approveScript,
  defaultRepoSettings,
  pickRepoSettings,
  repoSettingsOf,
  hasRepoSettings,
  stashRepoSettings,
  switchRepoSettings,
  setRepoSettings,
  Store,
  languageForBoardFile,
  assertLanguage,
  defaultRelayFlow,
  DEFAULT_SETTINGS,
  MAX_NOTIFICATIONS,
  MAX_RECENT_REPOS,
  MAX_REPO_TABS,
  cleanRepoTabs,
  openRepoTab,
  closeRepoTab,
  repoTabSummary,
  isNoGitRepo,
  markNoGitRepo,
  cleanRecentRepoPaths,
  touchRecentRepo,
  seedRecentRepoPaths,
  weekAround,
  anchorFromDay,
  WEEK_MS,
};
