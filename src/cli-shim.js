// CLI のコマンド（wtk）を PATH に置くためのファイルと、MCP の設定を作る（Electron に依存しない）
//
//   macOS / Linux: ~/.local/bin/wtk（sh）。アプリの exe を ELECTRON_RUN_AS_NODE=1 で、kanban-cli.js を引数にして動かす
//   AppImage: 中のファイルの場所が起動ごとに変わるので、AppImage に --kanban-cli を付けて呼ぶ（main.js が起動し直す）
//   Windows: %USERPROFILE%\.local\bin\wtk.cmd
const fs = require('fs');
const path = require('path');

const SHIM_NAME = 'wtk';
const MARKER = 'Worktree Kanban CLI';
const MCP_NAME = 'worktree-kanban';

const shQuote = (s) => `'${String(s).replace(/'/g, `'\\''`)}'`;
// cmd の set "X=..." の中: % は %% にする（" はパスに入らない）
const cmdValue = (s) => String(s).replace(/%/g, '%%');

/**
 * @param {{ platform: string, home: string, execPath: string, script: string, dataDir: string, appImage?: string, appArgs?: string[] }} o
 * @returns {{ file: string, dir: string, content: string, mode: number, mcp: object, claudeAdd: string }}
 */
function shimPlan({ platform, home, execPath, script, dataDir, appImage = '', appArgs = [] }) {
  const win = platform === 'win32';
  const p = win ? path.win32 : path.posix;
  const dir = p.join(home, '.local', 'bin');
  const file = p.join(dir, win ? `${SHIM_NAME}.cmd` : SHIM_NAME);
  const argsJson = appArgs && appArgs.length ? JSON.stringify(appArgs) : '';
  let content;
  if (win) {
    content = [
      '@echo off',
      `rem ${MARKER} (written by the app. Run "wtk --help")`,
      'setlocal',
      'set "ELECTRON_RUN_AS_NODE=1"',
      `set "WORKTREE_KANBAN_DATA_DIR=${cmdValue(dataDir)}"`,
      `set "WORKTREE_KANBAN_APP=${cmdValue(execPath)}"`,
      ...(argsJson ? [`set "WORKTREE_KANBAN_APP_ARGS=${cmdValue(argsJson)}"`] : []),
      `"${execPath}" "${script}" %*`,
      '',
    ].join('\r\n');
  } else if (appImage) {
    content = ['#!/bin/sh', `# ${MARKER} (written by the app. Run "wtk --help")`, `WORKTREE_KANBAN_DATA_DIR=${shQuote(dataDir)} exec ${shQuote(appImage)} --kanban-cli "$@"`, ''].join('\n');
  } else {
    const env = [`ELECTRON_RUN_AS_NODE=1`, `WORKTREE_KANBAN_DATA_DIR=${shQuote(dataDir)}`, `WORKTREE_KANBAN_APP=${shQuote(execPath)}`, ...(argsJson ? [`WORKTREE_KANBAN_APP_ARGS=${shQuote(argsJson)}`] : [])];
    content = ['#!/bin/sh', `# ${MARKER} (written by the app. Run "wtk --help")`, `${env.join(' ')} exec ${shQuote(execPath)} ${shQuote(script)} "$@"`, ''].join('\n');
  }
  // MCP の設定: wtk が PATH に無くても動くように、exe を直接書く
  const server = appImage
    ? { command: appImage, args: ['--kanban-cli', 'mcp'], env: { WORKTREE_KANBAN_DATA_DIR: dataDir } }
    : { command: execPath, args: [script, 'mcp'], env: { ELECTRON_RUN_AS_NODE: '1', WORKTREE_KANBAN_DATA_DIR: dataDir, WORKTREE_KANBAN_APP: execPath, ...(argsJson ? { WORKTREE_KANBAN_APP_ARGS: argsJson } : {}) } };
  const mcp = { mcpServers: { [MCP_NAME]: server } };
  const claudeAdd = `claude mcp add-json ${MCP_NAME} ${win ? `"${JSON.stringify(server).replace(/"/g, '\\"')}"` : shQuote(JSON.stringify(server))}`;
  return { file, dir, content, mode: 0o755, mcp, claudeAdd };
}

// 置いてあるか・中身が今のアプリと同じか
function shimState(plan, { fsImpl = fs } = {}) {
  let text;
  try {
    text = fsImpl.readFileSync(plan.file, 'utf8');
  } catch {
    return { installed: false, current: false, ours: false };
  }
  return { installed: true, current: text === plan.content, ours: text.includes(MARKER) };
}

function installShim(plan, { fsImpl = fs } = {}) {
  const st = shimState(plan, { fsImpl });
  if (st.installed && !st.ours) throw new Error(`${plan.file} already exists and was not written by Worktree Kanban`);
  fsImpl.mkdirSync(plan.dir, { recursive: true });
  fsImpl.writeFileSync(plan.file, plan.content, { mode: plan.mode });
  try {
    fsImpl.chmodSync(plan.file, plan.mode);
  } catch {
    /* Windows */
  }
  return plan.file;
}

// 前に置いた wtk の中身が古い（アプリの場所が変わった）ときだけ、書き直す
function refreshShim(plan, { fsImpl = fs } = {}) {
  const st = shimState(plan, { fsImpl });
  if (!st.installed || !st.ours || st.current) return false;
  installShim(plan, { fsImpl });
  return true;
}

function onPath(dir, envPath = process.env.PATH || '', platform = process.platform) {
  const sep = platform === 'win32' ? ';' : ':';
  const norm = (s) => (platform === 'win32' ? s.toLowerCase() : s).replace(/[\\/]+$/, '');
  return envPath.split(sep).filter(Boolean).some((p) => norm(p) === norm(dir));
}

module.exports = { shimPlan, shimState, installShim, refreshShim, onPath, SHIM_NAME, MCP_NAME, MARKER };
