// リポジトリに置いて、チームで共有するプロジェクトの設定（.worktree-kanban/settings.json）
// ファイルにある項目はファイルの値を使う（PC ごとに上書きもできる。上書きした項目は board.json の sharedRepos に覚える）
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const SHARED_DIR = '.worktree-kanban';
const SHARED_FILE = 'settings.json';
const SHARED_REL = `${SHARED_DIR}/${SHARED_FILE}`;
const SHARED_VERSION = 1;
const MAX_FILE_BYTES = 2 * 1024 * 1024;
// 共有しない項目: origin から決めるもの（codeHost）・前の版の設定（competeCustomAgents）
const NOT_SHARED = ['codeHost', 'competeCustomAgents'];
// いっしょに扱う項目（Pipeline は一覧・既定の ID・既定のフローがそろっていないと食い違う）
const KEY_GROUPS = [['relayFlow', 'relayFlows', 'relayFlowId']];
// ファイルから来たら、動かす前に確かめるスクリプト
const SCRIPT_KEYS = { setup: 'setupScript', teardown: 'teardownScript', run: 'runScript' };

function sharedKeys(repoSettingKeys) {
  return repoSettingKeys.filter((k) => !NOT_SHARED.includes(k));
}

function sharedFilePath(repoDir) {
  const dir = String(repoDir || '');
  // WSL のリポジトリ（\\wsl$\...）も Windows のパスとしてつなぐ
  const p = /^\\\\/.test(dir) || /^[A-Za-z]:[\\/]/.test(dir) ? path.win32 : path;
  return p.join(dir, SHARED_DIR, SHARED_FILE);
}

// 1つの項目を広げて、いっしょに扱う項目も含める
function expandKeys(keys) {
  const out = new Set(keys);
  for (const g of KEY_GROUPS) if (g.some((k) => out.has(k))) for (const k of g) out.add(k);
  return [...out];
}

function typeOf(v) {
  if (Array.isArray(v)) return 'array';
  if (v === null) return 'null';
  return typeof v;
}

/**
 * ファイルの中身から、共有する項目だけを取り出す。型が初期値と合わない項目は使わない
 * @param {string} text
 * @param {{ keys: string[], defaults: object }} spec
 * @returns {{ values: object, ignored: string[] }}
 */
function parseShared(text, { keys, defaults }) {
  const raw = JSON.parse(String(text).replace(/^﻿/, ''));
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) throw new Error('not an object');
  // { "version": 1, "settings": { ... } } の形。settings がなければ、上の段をそのまま設定とみなす
  const src = raw.settings && typeof raw.settings === 'object' && !Array.isArray(raw.settings) ? raw.settings : raw;
  const values = {};
  const ignored = [];
  for (const [k, v] of Object.entries(src)) {
    if (src === raw && (k === 'version' || k === '$schema')) continue;
    if (!keys.includes(k)) {
      ignored.push(k);
      continue;
    }
    const want = typeOf(defaults[k]);
    if (v === undefined || (want !== 'undefined' && typeOf(v) !== want)) {
      ignored.push(k);
      continue;
    }
    values[k] = v;
  }
  return { values, ignored };
}

/**
 * リポジトリの共有ファイルを読む
 * @returns {{ exists: boolean, values: object, ignored: string[], error: string, file: string }}
 */
function readShared(repoDir, spec) {
  const file = sharedFilePath(repoDir);
  const out = { exists: false, values: {}, ignored: [], error: '', file };
  if (!repoDir) return out;
  let text;
  try {
    const st = fs.statSync(file);
    if (!st.isFile()) return out;
    out.exists = true;
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
    Object.assign(out, parseShared(text, spec));
  } catch (err) {
    out.error = (err && err.message) || String(err);
  }
  return out;
}

// 書き出すファイルの中身（キーの並びは REPO_SETTING_KEYS の順）
function sharedDoc(repoSettings, keys) {
  const settings = {};
  for (const k of keys) if (repoSettings[k] !== undefined) settings[k] = repoSettings[k];
  return { version: SHARED_VERSION, settings };
}

function writeShared(repoDir, repoSettings, keys) {
  if (!repoDir) throw new Error('no repository');
  const file = sharedFilePath(repoDir);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const tmp = `${file}.tmp`;
  fs.writeFileSync(tmp, `${JSON.stringify(sharedDoc(repoSettings, keys), null, 2)}\n`);
  fs.renameSync(tmp, file);
  return file;
}

function scriptHash(script) {
  return crypto.createHash('sha256').update(String(script || '')).digest('hex');
}

module.exports = { SHARED_DIR, SHARED_FILE, SHARED_REL, SHARED_VERSION, NOT_SHARED, KEY_GROUPS, SCRIPT_KEYS, sharedKeys, sharedFilePath, expandKeys, parseShared, readShared, sharedDoc, writeShared, scriptHash };
