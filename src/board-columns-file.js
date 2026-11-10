// ボードの列とレーンの設定を、リポジトリの .worktree-kanban/board.json に読み書きする（チームで共有できる）
// ファイルがない・読めない・形が合わないときは、今までの4つの列を使う
const fs = require('fs');
const path = require('path');
const BC = require('../renderer/board-columns');
const { SHARED_DIR } = require('./shared-settings');

const COLUMNS_FILE = 'board.json';
const COLUMNS_REL = `${SHARED_DIR}/${COLUMNS_FILE}`;
const MAX_FILE_BYTES = 1024 * 1024;

function columnsFilePath(repoDir) {
  const dir = String(repoDir || '');
  const p = /^\\\\/.test(dir) || /^[A-Za-z]:[\\/]/.test(dir) ? path.win32 : path;
  return p.join(dir, SHARED_DIR, COLUMNS_FILE);
}

/**
 * @returns {{ exists: boolean, config: object, error: string, file: string, mtimeMs: number }}
 */
function readColumns(repoDir) {
  const file = columnsFilePath(repoDir);
  const out = { exists: false, config: BC.defaultConfig(), error: '', file, mtimeMs: 0 };
  if (!repoDir) return out;
  let text;
  try {
    const st = fs.statSync(file);
    if (!st.isFile()) return out;
    out.exists = true;
    out.mtimeMs = st.mtimeMs;
    if (st.size > MAX_FILE_BYTES) {
      out.error = 'too large';
      return out;
    }
    text = fs.readFileSync(file, 'utf8');
  } catch (err) {
    if (err && err.code !== 'ENOENT' && err.code !== 'ENOTDIR') {
      out.exists = true;
      out.error = err.message || String(err);
    }
    return out;
  }
  try {
    const cfg = BC.cleanConfig(JSON.parse(String(text).replace(/^﻿/, '')));
    const errors = BC.validateConfig(cfg);
    if (errors.length) out.error = errors.join('\n');
    else out.config = cfg;
  } catch (err) {
    out.error = (err && err.message) || String(err);
  }
  return out;
}

// 確かめてから書く（形が合わなければ書かずに投げる）
function writeColumns(repoDir, raw) {
  if (!repoDir) throw new Error('no repository');
  const cfg = BC.cleanConfig(raw);
  const errors = BC.validateConfig(cfg);
  if (errors.length) throw new Error(errors.join('\n'));
  const file = columnsFilePath(repoDir);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const tmp = `${file}.tmp`;
  fs.writeFileSync(tmp, `${JSON.stringify(cfg, null, 2)}\n`);
  fs.renameSync(tmp, file);
  return cfg;
}

// 今までの4つの列に戻す（ファイルを消す）
function removeColumns(repoDir) {
  if (!repoDir) return;
  try {
    fs.unlinkSync(columnsFilePath(repoDir));
  } catch (err) {
    if (err && err.code !== 'ENOENT') throw err;
  }
}

// mtime を見て、変わったときだけ読み直す
function createColumnsCache() {
  const cache = new Map();
  return {
    get(repoDir) {
      const d = String(repoDir || '');
      if (!d) return readColumns('');
      let mtimeMs = -1;
      try {
        mtimeMs = fs.statSync(columnsFilePath(d)).mtimeMs;
      } catch {
        mtimeMs = 0;
      }
      const hit = cache.get(d);
      if (hit && hit.mtimeMs === mtimeMs && (mtimeMs !== 0 || !hit.exists)) return hit;
      const r = readColumns(d);
      r.mtimeMs = mtimeMs;
      cache.set(d, r);
      return r;
    },
    forget(repoDir) {
      cache.delete(String(repoDir || ''));
    },
  };
}

module.exports = { COLUMNS_FILE, COLUMNS_REL, columnsFilePath, readColumns, writeColumns, removeColumns, createColumnsCache };
