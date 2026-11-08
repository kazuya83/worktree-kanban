// テスト用の cloudflared 代わり。環境変数でふるまいを変える
// FAKE_CF_MODE:
//   url（既定）… api.trycloudflare.com の行のあとに、https://<sub>.trycloudflare.com を標準エラーに出して待つ
//   crash … FAKE_CF_OUTPUT を出してすぐ終わる（終了コード 1）
//   silent … 何も出さずに待つ
//   named … 「Registered tunnel connection」を出して待つ
// FAKE_CF_SUB: url で出すサブドメイン。FAKE_CF_SEQ に数を数えるファイルを入れると、起動するたびに <sub>-<n> になる
// FAKE_CF_EXIT_AFTER: url / named のとき、印を出してからこのミリ秒で終わる（落ちたときのまね）
// FAKE_CF_OUTPUT: 出力に足す文字列（トークンを伏せるかのテスト用）
// FAKE_CF_LOG: 受け取った引数と TUNNEL_TOKEN の有無を、1回の起動につき1行の JSON で足していく
const fs = require('fs');

const args = process.argv.slice(2);
const env = process.env;
const token = env.TUNNEL_TOKEN || '';
if (env.FAKE_CF_LOG) {
  fs.appendFileSync(env.FAKE_CF_LOG, `${JSON.stringify({ args, hasToken: !!token, tokenLength: token.length, pid: process.pid })}\n`);
}
const mode = env.FAKE_CF_MODE || 'url';
const extra = env.FAKE_CF_OUTPUT ? `${env.FAKE_CF_OUTPUT}\n` : '';

function nextSeq() {
  if (!env.FAKE_CF_SEQ) return '';
  let n = 0;
  try {
    n = Number(fs.readFileSync(env.FAKE_CF_SEQ, 'utf8')) || 0;
  } catch {
    /* はじめて */
  }
  n += 1;
  fs.writeFileSync(env.FAKE_CF_SEQ, String(n));
  return `-${n}`;
}

function exitLater() {
  const ms = Number(env.FAKE_CF_EXIT_AFTER);
  if (ms > 0) setTimeout(() => process.exit(1), ms);
}

if (!args.includes('tunnel') || !args.includes('--no-autoupdate')) {
  process.stderr.write(`bad args: ${args.join(' ')}\n`);
  process.exit(2);
}
if (mode === 'crash') {
  process.stderr.write(`2026-11-08T00:00:00Z INF Starting tunnel\n${extra}2026-11-08T00:00:01Z ERR failed to connect\n`);
  process.exit(1);
}
if (mode === 'url') {
  const sub = `${env.FAKE_CF_SUB || 'fake-quick'}${nextSeq()}`;
  process.stderr.write('2026-11-08T00:00:00Z INF Requesting new quick Tunnel on https://api.trycloudflare.com...\n');
  process.stderr.write(`${extra}2026-11-08T00:00:01Z INF |  https://${sub}.trycloudflare.com  |\n`);
  exitLater();
}
if (mode === 'named') {
  process.stderr.write(`${extra}2026-11-08T00:00:01Z INF Registered tunnel connection connIndex=0 location=nrt01 protocol=quic\n`);
  exitLater();
}
// silent など: 止められるまで待つ
setInterval(() => {}, 1000);
process.on('SIGTERM', () => process.exit(0));
