// スマホ用 API サーバー（ペアリング・トークン・invoke・SSE・静的ファイル）
const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const http = require('node:http');
const { MobileServer, MOBILE_CHANNELS, TOKEN_TTL_MS, PAIR_ALPHABET, PAIR_CODE_LENGTH, MAX_BODY, LAST_SEEN_SAVE_MS, PAIR_RATE_LIMIT, genMobilePairCode, normalizePairCode, hashToken, safeJoin } = require('../src/mobile-server');
const { PROXY_CHANNELS, PAIR_TTL_MS, MAX_PAIR_FAILURES } = require('../src/remote');

// 時計を進められるサーバーを立てる
async function startServer(opts = {}) {
  const clock = { t: 10_000_000_000 };
  const saved = [];
  const calls = [];
  const server = new MobileServer({
    invoke: async (channel, arg, who) => {
      calls.push({ channel, arg, who });
      if (channel === 'board:get') return { settings: { repoPath: '/r', remotePairTokens: ['secret'], remoteClientToken: 'tok', language: 'ja' }, cards: [] };
      if (channel === 'card:stop') throw new Error('止められません');
      return { echo: arg };
    },
    devices: [],
    onDevices: (d) => saved.push(d),
    appVersion: '9.9.9',
    getLanguage: () => 'fr',
    now: () => clock.t,
    ...opts,
  });
  await server.start(0);
  const base = `http://127.0.0.1:${server.port}`;
  return { server, clock, saved, calls, base };
}

async function api(base, p, { method = 'GET', body, token, headers = {} } = {}) {
  const h = { ...headers };
  if (token) h.Authorization = `Bearer ${token}`;
  if (body !== undefined) h['Content-Type'] = 'application/json';
  const res = await fetch(base + p, { method, headers: h, body: body === undefined ? undefined : typeof body === 'string' ? body : JSON.stringify(body) });
  const text = await res.text();
  let json = null;
  try {
    json = JSON.parse(text);
  } catch {
    /* JSON でない */
  }
  return { status: res.status, headers: res.headers, json, text };
}

async function pair(ctx, deviceName = 'iPhone') {
  const { code } = ctx.server.refreshPairCode();
  const r = await api(ctx.base, '/api/v1/pair', { method: 'POST', body: { code, deviceName } });
  assert.strictEqual(r.status, 200, r.text);
  return r.json.data;
}

// fetch は ../ を消してしまうので、パスをそのまま送る
function rawGet(port, rawPath, method = 'GET') {
  return new Promise((resolve, reject) => {
    const req = http.request({ host: '127.0.0.1', port, path: rawPath, method }, (res) => {
      let body = '';
      res.setEncoding('utf8');
      res.on('data', (c) => (body += c));
      res.on('end', () => resolve({ status: res.statusCode, headers: res.headers, body }));
    });
    req.on('error', reject);
    req.end();
  });
}

test('MOBILE_CHANNELS は遠隔で転送できるチャンネルの一部で、設定やフォルダ操作は入らない', () => {
  assert.strictEqual(MOBILE_CHANNELS.size, 24);
  for (const c of MOBILE_CHANNELS) assert.ok(PROXY_CHANNELS.has(c), c);
  for (const c of ['settings:update', 'repo:open', 'repo:browse', 'remote:connect', 'app:info']) assert.strictEqual(MOBILE_CHANNELS.has(c), false, c);
  // main.js にある操作だけ
  const src = fs.readFileSync(path.join(__dirname, '..', 'main.js'), 'utf8');
  const handled = new Set([...src.matchAll(/\bhandle\('([^']+)'/g)].map((m) => m[1]));
  for (const c of MOBILE_CHANNELS) assert.ok(handled.has(c), c);
});

test('ペアリングコードは紛らわしい文字を使わない 8 文字。入力のゆれは無視する', () => {
  assert.strictEqual(PAIR_CODE_LENGTH, 8);
  assert.doesNotMatch(PAIR_ALPHABET, /[0O1IL]/);
  for (let i = 0; i < 200; i++) {
    const c = genMobilePairCode();
    assert.strictEqual(c.length, 8);
    for (const ch of c) assert.ok(PAIR_ALPHABET.includes(ch), c);
  }
  assert.strictEqual(normalizePairCode(' abcd-efgh '), 'ABCDEFGH');
  assert.strictEqual(normalizePairCode('ab cd\tef-gh'), 'ABCDEFGH');
  assert.strictEqual(normalizePairCode(null), '');
  assert.strictEqual(hashToken('x').length, 64);
});

test('ペアリング: 成功するとトークンを出し、保存するのはハッシュだけ。コードは 1 回しか使えない', async (t) => {
  const ctx = await startServer();
  t.after(() => ctx.server.stop());
  let changed = 0;
  ctx.server.on('changed', () => changed++);
  const { code, expiresAt } = ctx.server.refreshPairCode();
  assert.strictEqual(expiresAt, ctx.clock.t + PAIR_TTL_MS);
  assert.deepStrictEqual(ctx.server.status().pairCode, { expiresAt });
  // 小文字・ハイフン・空白が混ざっていてもよい
  const typed = `${code.slice(0, 4).toLowerCase()}- ${code.slice(4)}`;
  const r = await api(ctx.base, '/api/v1/pair', { method: 'POST', body: { code: typed, deviceName: '  My iPhone  ' } });
  assert.strictEqual(r.status, 200, r.text);
  assert.strictEqual(r.json.ok, true);
  const { token, deviceId } = r.json.data;
  assert.match(token, /^[0-9a-f]{48}$/);
  assert.strictEqual(r.json.data.expiresAt, ctx.clock.t + TOKEN_TTL_MS);
  assert.strictEqual(r.headers.get('cache-control'), 'no-store');
  assert.ok(changed >= 2);

  const last = ctx.saved.at(-1);
  assert.strictEqual(last.length, 1);
  assert.strictEqual(last[0].id, deviceId);
  assert.strictEqual(last[0].name, 'My iPhone');
  assert.strictEqual(last[0].tokenHash, hashToken(token));
  assert.ok(!JSON.stringify(ctx.saved).includes(token), 'トークンそのものは保存しない');

  const st = ctx.server.status();
  assert.strictEqual(st.pairCode, null);
  assert.strictEqual(st.listening, true);
  assert.deepStrictEqual(Object.keys(st.devices[0]).sort(), ['createdAt', 'expiresAt', 'id', 'lastSeenAt', 'name']);

  // 同じコードの使い回しは、コードが無いので 403
  const again = await api(ctx.base, '/api/v1/pair', { method: 'POST', body: { code } });
  assert.strictEqual(again.status, 403);
  assert.strictEqual(again.json.ok, false);
  assert.ok(again.json.error);

  // セッション
  const s = await api(ctx.base, '/api/v1/session', { token });
  assert.strictEqual(s.status, 200);
  assert.deepStrictEqual({ ...s.json.data, channels: undefined }, { deviceId, deviceName: 'My iPhone', expiresAt: r.json.data.expiresAt, appVersion: '9.9.9', language: 'fr', channels: undefined });
  assert.deepStrictEqual(s.json.data.channels, [...MOBILE_CHANNELS]);
});

test('ペアリング: 違うコード・期限切れ・5 回失敗', async (t) => {
  const ctx = await startServer();
  t.after(() => ctx.server.stop());
  // コードが無い間は 403
  let r = await api(ctx.base, '/api/v1/pair', { method: 'POST', body: { code: 'AAAAAAAA' } });
  assert.strictEqual(r.status, 403);

  // 期限切れ
  let { code } = ctx.server.refreshPairCode();
  ctx.clock.t += PAIR_TTL_MS;
  r = await api(ctx.base, '/api/v1/pair', { method: 'POST', body: { code } });
  assert.strictEqual(r.status, 403);
  assert.strictEqual(ctx.server.status().pairCode, null);

  // 5 回間違えたらコードを無効にする
  ({ code } = ctx.server.refreshPairCode());
  const wrong = code === 'ZZZZZZZZ' ? 'YYYYYYYY' : 'ZZZZZZZZ';
  for (let i = 0; i < MAX_PAIR_FAILURES; i++) {
    r = await api(ctx.base, '/api/v1/pair', { method: 'POST', body: { code: wrong } });
    assert.strictEqual(r.status, 401, `${i}`);
  }
  assert.strictEqual(ctx.server.status().pairCode, null);
  r = await api(ctx.base, '/api/v1/pair', { method: 'POST', body: { code } });
  assert.strictEqual(r.status, 403, '正しいコードでも、もう使えない');
  assert.strictEqual(ctx.server.status().devices.length, 0);

  // 新しいコードを出せば失敗の数は 0 に戻る
  ({ code } = ctx.server.refreshPairCode());
  ctx.server.clearPairCode();
  r = await api(ctx.base, '/api/v1/pair', { method: 'POST', body: { code } });
  assert.strictEqual(r.status, 403, 'clearPairCode のあとは使えない');
});

test('ペアリング: IP ごとの回数制限で 429', async (t) => {
  const ctx = await startServer();
  t.after(() => ctx.server.stop());
  const headers = { 'cf-connecting-ip': '203.0.113.5' };
  for (let i = 0; i < PAIR_RATE_LIMIT; i++) {
    const r = await api(ctx.base, '/api/v1/pair', { method: 'POST', body: { code: 'x' }, headers });
    assert.strictEqual(r.status, 403);
  }
  let r = await api(ctx.base, '/api/v1/pair', { method: 'POST', body: { code: 'x' }, headers });
  assert.strictEqual(r.status, 429);
  // 別の IP は数えない
  r = await api(ctx.base, '/api/v1/pair', { method: 'POST', body: { code: 'x' }, headers: { 'cf-connecting-ip': '203.0.113.6' } });
  assert.strictEqual(r.status, 403);
  // 1 分たてば戻る
  ctx.clock.t += 60 * 1000;
  r = await api(ctx.base, '/api/v1/pair', { method: 'POST', body: { code: 'x' }, headers });
  assert.strictEqual(r.status, 403);
});

test('トークン: 無い・違う・期限切れは 401。期限切れは記録からも消す', async (t) => {
  const ctx = await startServer({ tokenTtlMs: 1000 });
  t.after(() => ctx.server.stop());
  const { token } = await pair(ctx);
  assert.strictEqual((await api(ctx.base, '/api/v1/session')).status, 401);
  assert.strictEqual((await api(ctx.base, '/api/v1/session', { token: 'f'.repeat(48) })).status, 401);
  assert.strictEqual((await api(ctx.base, '/api/v1/session', { headers: { Authorization: token } })).status, 401, 'Bearer が無い');
  assert.strictEqual((await api(ctx.base, '/api/v1/session', { token })).status, 200);
  ctx.clock.t += 1000;
  const r = await api(ctx.base, '/api/v1/session', { token });
  assert.strictEqual(r.status, 401);
  assert.strictEqual(r.json.ok, false);
  assert.strictEqual(ctx.server.status().devices.length, 0);
  assert.deepStrictEqual(ctx.saved.at(-1), []);
});

test('トークン: 保存した端末で起動しても使え、lastSeenAt の保存は 1 時間に 1 回まで', async (t) => {
  const token = 'a'.repeat(48);
  const ctx = await startServer({ devices: [{ id: 'd1', name: 'Pixel', tokenHash: hashToken(token), createdAt: 1, expiresAt: 1e15, lastSeenAt: 1 }, { id: 'bad' }] });
  t.after(() => ctx.server.stop());
  assert.deepStrictEqual(ctx.server.status().devices.map((d) => d.id), ['d1'], '形の壊れた記録は読まない');
  assert.strictEqual((await api(ctx.base, '/api/v1/session', { token })).status, 200);
  assert.strictEqual(ctx.saved.length, 1);
  ctx.clock.t += 1000;
  assert.strictEqual((await api(ctx.base, '/api/v1/session', { token })).status, 200);
  assert.strictEqual(ctx.saved.length, 1, 'すぐには保存しない');
  assert.strictEqual(ctx.server.status().devices[0].lastSeenAt, ctx.clock.t, '画面に出す値は新しい');
  ctx.clock.t += LAST_SEEN_SAVE_MS;
  assert.strictEqual((await api(ctx.base, '/api/v1/session', { token })).status, 200);
  assert.strictEqual(ctx.saved.length, 2);
  assert.strictEqual(ctx.saved[1][0].lastSeenAt, ctx.clock.t);
});

test('revokeDevice・revokeAll・logout でトークンが使えなくなる', async (t) => {
  const ctx = await startServer();
  t.after(() => ctx.server.stop());
  const a = await pair(ctx, 'A');
  const b = await pair(ctx, 'B');
  const c = await pair(ctx, 'C');
  assert.strictEqual(ctx.server.status().devices.length, 3);

  assert.strictEqual(ctx.server.revokeDevice(a.deviceId), true);
  assert.strictEqual(ctx.server.revokeDevice('nope'), false);
  assert.strictEqual((await api(ctx.base, '/api/v1/session', { token: a.token })).status, 401);
  assert.strictEqual((await api(ctx.base, '/api/v1/session', { token: b.token })).status, 200);

  const out = await api(ctx.base, '/api/v1/logout', { method: 'POST', token: b.token });
  assert.strictEqual(out.status, 200);
  assert.strictEqual(out.json.ok, true);
  assert.strictEqual((await api(ctx.base, '/api/v1/session', { token: b.token })).status, 401);
  assert.deepStrictEqual(ctx.server.status().devices.map((d) => d.name), ['C']);

  ctx.server.revokeAll();
  assert.strictEqual((await api(ctx.base, '/api/v1/session', { token: c.token })).status, 401);
  assert.deepStrictEqual(ctx.saved.at(-1), []);
});

test('invoke: 許したチャンネルだけ。誰の操作かを渡し、秘密は外して返す', async (t) => {
  const ctx = await startServer();
  t.after(() => ctx.server.stop());
  const { token, deviceId } = await pair(ctx, 'iPad');

  let r = await api(ctx.base, '/api/v1/invoke', { method: 'POST', token, body: { channel: 'board:get' } });
  assert.strictEqual(r.status, 200);
  assert.strictEqual(r.json.ok, true);
  assert.deepStrictEqual(r.json.data.settings, { repoPath: '/r' });
  assert.ok(!r.text.includes('secret') && !r.text.includes('remotePairTokens') && !r.text.includes('remoteClientToken'));

  r = await api(ctx.base, '/api/v1/invoke', { method: 'POST', token, body: { channel: 'card:send', arg: { id: 'c1', text: 'hi' } } });
  assert.deepStrictEqual(r.json, { ok: true, data: { echo: { id: 'c1', text: 'hi' } } });
  assert.deepStrictEqual(ctx.calls.at(-1), { channel: 'card:send', arg: { id: 'c1', text: 'hi' }, who: { deviceId, deviceName: 'iPad' } });

  // 失敗は ok:false
  r = await api(ctx.base, '/api/v1/invoke', { method: 'POST', token, body: { channel: 'card:stop' } });
  assert.deepStrictEqual(r.json, { ok: false, error: '止められません' });

  // MOBILE_CHANNELS にないものは 403 で、invoke を呼ばない
  const n = ctx.calls.length;
  for (const channel of ['settings:update', 'repo:open', 'remote:connect', '', undefined, 123]) {
    r = await api(ctx.base, '/api/v1/invoke', { method: 'POST', token, body: { channel } });
    assert.strictEqual(r.status, 403, String(channel));
    assert.strictEqual(r.json.ok, false);
  }
  assert.strictEqual(ctx.calls.length, n);

  // 認証なしは 401。壊れた JSON は 400
  assert.strictEqual((await api(ctx.base, '/api/v1/invoke', { method: 'POST', body: { channel: 'board:get' } })).status, 401);
  assert.strictEqual((await api(ctx.base, '/api/v1/invoke', { method: 'POST', token, body: '{bad' })).status, 400);
  assert.strictEqual((await api(ctx.base, '/api/v1/invoke', { method: 'POST', token, body: '[1]' })).status, 400);
  // メソッド違いは 405、知らない API は 404
  r = await api(ctx.base, '/api/v1/invoke', { token });
  assert.strictEqual(r.status, 405);
  assert.strictEqual(r.headers.get('allow'), 'POST');
  assert.strictEqual((await api(ctx.base, '/api/v1/nope', { token })).status, 404);
  assert.strictEqual((await api(ctx.base, '/api/v2/invoke', { method: 'POST', token, body: {} })).status, 404);
});

test('本文は 1MB まで（超えたら 413）', async (t) => {
  const ctx = await startServer();
  t.after(() => ctx.server.stop());
  const { token } = await pair(ctx);
  const big = JSON.stringify({ channel: 'card:send', arg: 'x'.repeat(MAX_BODY) });
  const r = await api(ctx.base, '/api/v1/invoke', { method: 'POST', token, body: big });
  assert.strictEqual(r.status, 413);
  assert.strictEqual(r.json.ok, false);
  // Content-Length の無い（chunked の）本文も数える
  const status = await new Promise((resolve, reject) => {
    const req = http.request({ host: '127.0.0.1', port: ctx.server.port, path: '/api/v1/invoke', method: 'POST', headers: { Authorization: `Bearer ${token}`, 'Transfer-Encoding': 'chunked' } }, (res) => {
      res.resume();
      resolve(res.statusCode);
    });
    req.on('error', () => {});
    const chunk = 'x'.repeat(64 * 1024);
    let sent = 0;
    const pump = () => {
      while (sent < MAX_BODY * 2) {
        sent += chunk.length;
        if (!req.write(chunk)) return req.once('drain', pump);
      }
      req.end();
    };
    pump();
    setTimeout(() => reject(new Error('timeout')), 5000).unref();
  });
  assert.strictEqual(status, 413);
  // ちょうど上限より小さければ通る
  const ok = await api(ctx.base, '/api/v1/invoke', { method: 'POST', token, body: JSON.stringify({ channel: 'card:send', arg: 'x'.repeat(MAX_BODY - 100) }) });
  assert.strictEqual(ok.status, 200);
});

// SSE を fetch のストリームで読む（スマホの画面と同じ）
async function openEvents(base, token) {
  const ac = new AbortController();
  const res = await fetch(`${base}/api/v1/events`, { headers: { Authorization: `Bearer ${token}` }, signal: ac.signal });
  const reader = res.body.getReader();
  const dec = new TextDecoder();
  let buf = '';
  let ended = false;
  const events = [];
  const pump = (async () => {
    try {
      for (;;) {
        const { value, done } = await reader.read();
        if (done) break;
        buf += dec.decode(value, { stream: true });
        let i;
        while ((i = buf.indexOf('\n\n')) >= 0) {
          const block = buf.slice(0, i);
          buf = buf.slice(i + 2);
          if (block.startsWith(':')) {
            events.push({ comment: block });
            continue;
          }
          const ev = /^event: (.*)$/m.exec(block);
          const data = /^data: (.*)$/m.exec(block);
          events.push({ event: ev && ev[1], data: data && JSON.parse(data[1]) });
        }
      }
    } catch {
      /* 中断 */
    }
    ended = true;
  })();
  const waitFor = async (pred, ms = 2000) => {
    const until = Date.now() + ms;
    while (Date.now() < until) {
      const hit = events.find(pred);
      if (hit) return hit;
      await new Promise((r) => setTimeout(r, 10));
    }
    throw new Error('event timeout');
  };
  const waitEnd = async (ms = 2000) => {
    await Promise.race([pump, new Promise((r) => setTimeout(r, ms))]);
    return ended;
  };
  return { res, events, waitFor, waitEnd, close: () => ac.abort() };
}

test('SSE: hello のあと、broadcast が秘密を外して届く。ping も送る', async (t) => {
  const ctx = await startServer({ pingIntervalMs: 30 });
  t.after(() => ctx.server.stop());
  const { token, deviceId } = await pair(ctx);
  assert.strictEqual((await api(ctx.base, '/api/v1/events')).status, 401);
  const es = await openEvents(ctx.base, token);
  t.after(() => es.close());
  assert.strictEqual(es.res.status, 200);
  assert.match(es.res.headers.get('content-type'), /^text\/event-stream/);
  assert.strictEqual(es.res.headers.get('cache-control'), 'no-store');
  const hello = await es.waitFor((e) => e.event === 'hello');
  assert.strictEqual(hello.data.deviceId, deviceId);
  assert.strictEqual(es.events[0].event, 'hello', '最初は hello');

  ctx.server.broadcast('board:changed', { settings: { repoPath: '/r', remotePairTokens: ['secret'] }, cards: [{ id: 'c1' }] });
  const ev = await es.waitFor((e) => e.event === 'board:changed');
  assert.deepStrictEqual(ev.data, { settings: { repoPath: '/r' }, cards: [{ id: 'c1' }] });
  ctx.server.broadcast('card:log', undefined);
  assert.strictEqual((await es.waitFor((e) => e.event === 'card:log')).data, null);
  await es.waitFor((e) => e.comment === ': ping');
});

test('SSE: revoke した端末と stop() で接続を閉じる', async (t) => {
  const ctx = await startServer();
  t.after(() => ctx.server.stop());
  const a = await pair(ctx, 'A');
  const b = await pair(ctx, 'B');
  const ea = await openEvents(ctx.base, a.token);
  const eb = await openEvents(ctx.base, b.token);
  await ea.waitFor((e) => e.event === 'hello');
  await eb.waitFor((e) => e.event === 'hello');
  assert.strictEqual(ctx.server.streams.size, 2);

  ctx.server.revokeDevice(a.deviceId);
  assert.strictEqual(await ea.waitEnd(), true, 'revoke した端末の SSE は閉じる');
  ctx.server.broadcast('board:changed', { cards: [] });
  await eb.waitFor((e) => e.event === 'board:changed');

  await ctx.server.stop();
  assert.strictEqual(await eb.waitEnd(), true, 'stop() で全部閉じる');
  assert.strictEqual(ctx.server.streams.size, 0);
  assert.strictEqual(ctx.server.listening(), false);
  assert.strictEqual(ctx.server.status().listening, false);
});

test('静的ファイル: 決まった場所だけ、Content-Type と安全のためのヘッダーを付けて返す（認証不要）', async (t) => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'mobile-server-'));
  t.after(() => fs.rmSync(tmp, { recursive: true, force: true }));
  const staticRoot = path.join(tmp, 'mobile');
  const rendererRoot = path.join(tmp, 'renderer');
  fs.mkdirSync(path.join(staticRoot, 'assets', 'img'), { recursive: true });
  fs.mkdirSync(path.join(rendererRoot, 'locales'), { recursive: true });
  fs.writeFileSync(path.join(staticRoot, 'index.html'), '<!doctype html><title>m</title>');
  fs.writeFileSync(path.join(staticRoot, 'manifest.webmanifest'), '{"name":"m"}');
  fs.writeFileSync(path.join(staticRoot, 'assets', 'app.js'), 'console.log(1)');
  fs.writeFileSync(path.join(staticRoot, 'assets', 'app.css'), 'body{}');
  fs.writeFileSync(path.join(staticRoot, 'assets', 'img', 'icon.png'), 'png');
  fs.writeFileSync(path.join(staticRoot, 'secret.txt'), 'SECRET');
  fs.writeFileSync(path.join(rendererRoot, 'i18n.js'), 'i18n');
  fs.writeFileSync(path.join(rendererRoot, 'locales', 'board.js'), 'board');
  fs.writeFileSync(path.join(rendererRoot, 'locales', 'notes.txt'), 'x');
  fs.writeFileSync(path.join(rendererRoot, 'renderer.js'), 'RENDERER');
  fs.writeFileSync(path.join(tmp, 'outside.txt'), 'OUTSIDE');

  const ctx = await startServer({ staticRoot, rendererRoot });
  t.after(() => ctx.server.stop());
  const port = ctx.server.port;
  const cases = [
    ['/', 'text/html; charset=utf-8', '<!doctype html><title>m</title>'],
    ['/index.html', 'text/html; charset=utf-8', '<!doctype html><title>m</title>'],
    ['/manifest.webmanifest', 'application/manifest+json; charset=utf-8', '{"name":"m"}'],
    ['/assets/app.js', 'text/javascript; charset=utf-8', 'console.log(1)'],
    ['/assets/app.css', 'text/css; charset=utf-8', 'body{}'],
    ['/assets/img/icon.png', 'image/png', 'png'],
    ['/assets/%61pp.js?v=1', 'text/javascript; charset=utf-8', 'console.log(1)'],
    ['/i18n.js', 'text/javascript; charset=utf-8', 'i18n'],
    ['/locales/board.js', 'text/javascript; charset=utf-8', 'board'],
  ];
  for (const [p, type, body] of cases) {
    const r = await rawGet(port, p);
    assert.strictEqual(r.status, 200, p);
    assert.strictEqual(r.headers['content-type'], type, p);
    assert.strictEqual(r.body, body, p);
    assert.strictEqual(r.headers['x-content-type-options'], 'nosniff');
    assert.strictEqual(r.headers['referrer-policy'], 'no-referrer');
    assert.strictEqual(r.headers['x-frame-options'], 'DENY');
    assert.strictEqual(r.headers['content-security-policy'], "default-src 'self'; img-src 'self' data:; style-src 'self'; script-src 'self'; connect-src 'self'; frame-ancestors 'none'; base-uri 'none'");
  }
  const head = await rawGet(port, '/assets/app.js', 'HEAD');
  assert.strictEqual(head.status, 200);
  assert.strictEqual(head.body, '');

  // API の応答にも同じヘッダー
  const apiRes = await rawGet(port, '/api/v1/session');
  assert.strictEqual(apiRes.headers['x-frame-options'], 'DENY');
  assert.strictEqual(apiRes.headers['cache-control'], 'no-store');
  assert.match(apiRes.headers['content-type'], /^application\/json/);

  // 決まった場所の外・ディレクトリの外は 404
  const denied = [
    '/secret.txt',
    '/renderer.js',
    '/assets/',
    '/assets/img',
    '/assets/../secret.txt',
    '/assets/%2e%2e/secret.txt',
    '/assets/%2E%2E/%2E%2E/outside.txt',
    '/assets/..%2fsecret.txt',
    '/assets/..%5csecret.txt',
    '/assets/app.js%00.png',
    '/locales/../renderer.js',
    '/locales/%2e%2e/renderer.js',
    '/locales/notes.txt',
    '/assets/%E0%A4%A',
    '/assets/nope.js',
  ];
  for (const p of denied) {
    const r = await rawGet(port, p);
    assert.ok(r.status === 404 || r.status === 400, `${p} => ${r.status}`);
    assert.ok(!r.body.includes('SECRET') && !r.body.includes('OUTSIDE') && !r.body.includes('RENDERER'), p);
    if (r.status === 404) assert.strictEqual(JSON.parse(r.body).ok, false);
  }
  // GET/HEAD 以外は 405
  const post = await api(ctx.base, '/index.html', { method: 'POST', body: {} });
  assert.strictEqual(post.status, 405);
});

test('safeJoin は root の外に出るパスを null にする', () => {
  const root = path.join(os.tmpdir(), 'root');
  assert.strictEqual(safeJoin(root, 'a/b.js'), path.join(root, 'a', 'b.js'));
  for (const bad of ['../x', 'a/../../x', '%2e%2e/x', 'a%2f..%2f..%2fx', 'a\\..\\x', 'a%00', '%', './x']) assert.strictEqual(safeJoin(root, bad), null, bad);
});

test('start(0) は空いているポートを 127.0.0.1 で待ち受け、二重に start しない', async () => {
  const server = new MobileServer({ invoke: async () => null });
  assert.strictEqual(server.listening(), false);
  const st = await server.start(0);
  assert.strictEqual(st.listening, true);
  assert.ok(st.port > 0);
  assert.strictEqual(server.server.address().address, '127.0.0.1');
  const again = await server.start(0);
  assert.strictEqual(again.port, st.port);
  await server.stop();
  await server.stop();
  assert.strictEqual(server.listening(), false);
});
