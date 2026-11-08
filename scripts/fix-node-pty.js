#!/usr/bin/env node
// node-pty 1.1.0 のビルド済みの spawn-helper（macOS で、シェルを PTY の中で起動する小さなプログラム）には、
// 実行の権限が付いていないことがある。付いていないと posix_spawnp failed でターミナルが開けないので、ここで付ける。
// （npm install のあと・ビルドの前に動く。アプリの中でも、開くときに同じことを試す: src/terminal.js）
const fs = require('fs');
const path = require('path');

const root = path.join(__dirname, '..', 'node_modules', 'node-pty', 'prebuilds');
let dirs = [];
try {
  dirs = fs.readdirSync(root);
} catch {
  process.exit(0); // node-pty が入っていない
}
for (const d of dirs) {
  const helper = path.join(root, d, 'spawn-helper');
  try {
    const st = fs.statSync(helper);
    if ((st.mode & 0o111) !== 0o111) fs.chmodSync(helper, 0o755);
  } catch {
    /* その OS 用には無い */
  }
}
