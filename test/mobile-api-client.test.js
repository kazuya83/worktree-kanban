// スマホ用の画面の API の部品（mobile/assets/api-client.js）。fetch と保存先を差し替えて確かめる
const test = require('node:test');
const assert = require('node:assert');
const { createClient, createSseParser, deviceNameFromUA, ApiError, DEFAULT_STORAGE_KEY } = require('../mobile/assets/api-client.js');

function memStorage(init = {}) {
  const m = new Map(Object.entries(init));
  return {
    m,
    getItem: (k) => (m.has(k) ? m.get(k) : null),
    setItem: (k, v) => m.set(k, String(v)),
    removeItem: (k) => m.delete(k),
  };
}
const res = (status, body) => ({ ok: status >= 200 && status < 300, status, json: async () => body });
const paired = (token = 'tok-1', extra = {}) => memStorage({ [DEFAULT_STORAGE_KEY]: JSON.stringify({ token, deviceId: 'd1', expiresAt: 0, ...extra }) });

// fetch の偽物: 呼ばれた内容を残し、handler の返事を返す
function fakeFetch(handler) {
  const calls = [];
  const fn = async (url, init = {}) => {
    const call = { url, method: init.method, headers: init.headers || {}, body: init.body ? JSON.parse(init.body) : undefined, signal: init.signal };
    calls.push(call);
    return handler(call, calls.length);
  };
  fn.calls = calls;
  return fn;
}

// 少しずつ chunk を返す ReadableStream の代わり。push で足し、end で閉じる。abort で reject する
function stream() {
  const queue = [];
  const waiters = [];
  let closed = false;
  let failed = null;
  const enc = new TextEncoder();
  const flush = () => {
    while (waiters.length && (queue.length || closed || failed)) {
      const w = waiters.shift();
      if (failed) w.reject(failed);
      else if (queue.length) w.resolve({ value: queue.shift(), done: false });
      else w.resolve({ value: undefined, done: true });
    }
  };
  return {
    push(text) {
      queue.push(typeof text === 'string' ? enc.encode(text) : text);
      flush();
    },
    end() {
      closed = true;
      flush();
    },
    fail(err) {
      failed = err;
      flush();
    },
    body: {
      getReader: () => ({
        read: () => new Promise((resolve, reject) => {
          waiters.push({ resolve, reject });
          flush();
        }),
        cancel: async () => {
          closed = true;
          flush();
        },
      }),
    },
  };
}
const tick = (n = 5) => new Promise((r) => setTimeout(r, n));

// setTimeout の偽物（待ち時間を記録して、run で進める）
function fakeTimers() {
  const list = [];
  return {
    list,
    setTimeout: (fn, ms) => {
      const t = { fn, ms, done: false };
      list.push(t);
      return t;
    },
    clearTimeout: (t) => {
      if (t) t.done = true;
    },
    // ms がこの値の、まだ動いていないタイマーを動かす
    async fire(ms) {
      const t = list.find((x) => !x.done && (ms === undefined || x.ms === ms));
      assert.ok(t, `timer ${ms} がありません: ${JSON.stringify(list.filter((x) => !x.done).map((x) => x.ms))}`);
      t.done = true;
      t.fn();
      await tick();
    },
    pending: () => list.filter((x) => !x.done).map((x) => x.ms),
  };
}

test('pair: コードと端末名を送り、トークンを保存する。認証のヘッダーは付けない', async () => {
  const storage = memStorage();
  const fetch = fakeFetch(() => res(200, { ok: true, data: { token: 'secret', deviceId: 'dev-1', expiresAt: 999 } }));
  const client = createClient({ baseUrl: 'https://x.example/', fetch, storage, now: () => 1 });
  assert.strictEqual(client.hasToken(), false);
  const data = await client.pair('ABCD2345', 'iPhone Safari');
  assert.deepStrictEqual(data, { token: 'secret', deviceId: 'dev-1', expiresAt: 999 });
  assert.strictEqual(fetch.calls[0].url, 'https://x.example/api/v1/pair');
  assert.strictEqual(fetch.calls[0].method, 'POST');
  assert.deepStrictEqual(fetch.calls[0].body, { code: 'ABCD2345', deviceName: 'iPhone Safari' });
  assert.strictEqual(fetch.calls[0].headers.Authorization, undefined);
  assert.strictEqual(client.hasToken(), true);
  assert.deepStrictEqual(JSON.parse(storage.getItem(DEFAULT_STORAGE_KEY)), { token: 'secret', deviceId: 'dev-1', expiresAt: 999 });
  // 期限が過ぎたトークンは持っていないものとする
  const later = createClient({ fetch, storage, now: () => 1000 });
  assert.strictEqual(later.hasToken(), false);
});

test('pair: コードが違う（401）ときは、エラーにするだけで onUnauthorized は呼ばない', async () => {
  const storage = memStorage();
  const fetch = fakeFetch(() => res(401, { ok: false, error: 'ペアリングコードが違います' }));
  const client = createClient({ fetch, storage });
  let called = 0;
  client.onUnauthorized(() => called++);
  await assert.rejects(() => client.pair('XXXX', 'x'), (err) => err instanceof ApiError && err.status === 401 && err.message === 'ペアリングコードが違います');
  assert.strictEqual(called, 0);
  assert.strictEqual(client.hasToken(), false);
});

test('invoke: Bearer トークンを付けて {channel, arg} を送り、data を返す。失敗は error の文で例外にする', async () => {
  const fetch = fakeFetch((call) => {
    if (call.body.channel === 'card:start') return res(200, { ok: false, error: 'このタスクはもう開始しています' });
    if (call.body.channel === 'boom') return { ok: false, status: 502, json: async () => { throw new Error('not json'); } };
    return res(200, { ok: true, data: { echo: call.body } });
  });
  const client = createClient({ fetch, storage: paired('tok-9') });
  const data = await client.invoke('card:send', { id: 'c1', message: 'hi' });
  assert.deepStrictEqual(data, { echo: { channel: 'card:send', arg: { id: 'c1', message: 'hi' } } });
  assert.strictEqual(fetch.calls[0].url, '/api/v1/invoke');
  assert.strictEqual(fetch.calls[0].headers.Authorization, 'Bearer tok-9');
  // arg を渡さないときは channel だけ
  assert.deepStrictEqual(await client.invoke('board:get'), { echo: { channel: 'board:get' } });
  await assert.rejects(() => client.invoke('card:start', 'c1'), /このタスクはもう開始しています/);
  await assert.rejects(() => client.invoke('boom'), (err) => err.status === 502);
  assert.strictEqual(client.hasToken(), true, '401 以外ではトークンを消さない');
});

test('401 のときはトークンを消して onUnauthorized で知らせる。解除した関数は呼ばない', async () => {
  const storage = paired('old');
  const fetch = fakeFetch(() => res(401, { ok: false, error: 'トークンが無効です' }));
  const client = createClient({ fetch, storage });
  const got = [];
  client.onUnauthorized((err) => got.push(err.message));
  const off = client.onUnauthorized(() => got.push('removed'));
  off();
  await assert.rejects(() => client.session(), (err) => err.status === 401);
  assert.deepStrictEqual(got, ['トークンが無効です']);
  assert.strictEqual(client.hasToken(), false);
  assert.strictEqual(storage.getItem(DEFAULT_STORAGE_KEY), null);
  // トークンが無いまま呼ぶと、送らずに 401 として扱う
  await assert.rejects(() => client.invoke('board:get'), (err) => err.status === 401 && err.code === 'no_token');
  assert.strictEqual(fetch.calls.length, 1);
});

test('通信できないときは status 0 のエラー。トークンは消さない', async () => {
  const client = createClient({ fetch: async () => { throw new TypeError('Failed to fetch'); }, storage: paired() });
  await assert.rejects(() => client.invoke('board:get'), (err) => err instanceof ApiError && err.status === 0 && err.code === 'network');
  assert.strictEqual(client.hasToken(), true);
});

test('logout: サーバーに届かなくても、手元のトークンは消す', async () => {
  const storage = paired();
  const fetch = fakeFetch(() => res(500, { ok: false, error: 'x' }));
  const client = createClient({ fetch, storage });
  await assert.rejects(() => client.logout());
  assert.strictEqual(fetch.calls[0].url, '/api/v1/logout');
  assert.strictEqual(client.hasToken(), false);
  assert.strictEqual(storage.getItem(DEFAULT_STORAGE_KEY), null);
});

test('保存先が壊れていても落ちない（読めなければペアリングしていない扱い）', () => {
  const client = createClient({ fetch: async () => res(200, {}), storage: memStorage({ [DEFAULT_STORAGE_KEY]: '{not json' }) });
  assert.strictEqual(client.hasToken(), false);
  const broken = { getItem: () => { throw new Error('denied'); }, setItem: () => { throw new Error('denied'); }, removeItem: () => { throw new Error('denied'); } };
  const c2 = createClient({ fetch: async () => res(200, { ok: true, data: { token: 't', deviceId: 'd', expiresAt: 0 } }), storage: broken });
  assert.strictEqual(c2.hasToken(), false);
  return c2.pair('ABCDEFGH', 'x').then(() => assert.strictEqual(c2.hasToken(), true, '保存できなくても、この画面のあいだは使える'));
});

test('SSE の読み取り: chunk が行やイベントの途中で切れていても、まとめて読む', () => {
  const got = [];
  const p = createSseParser((name, data) => got.push([name, data]));
  const text = 'event: hello\ndata: {"deviceId":"d1"}\n\n: ping\n\nevent: board:changed\ndata: {"cards":[{"id":"c1","title":"あいう"}]}\n\nevent: card:log\r\ndata: {"id":"c1",\r\ndata: "entry":{"kind":"text","text":"x"}}\r\n\r\ndata: plain\n\n';
  // 1文字ずつ・\r\n の真ん中で切るなど、いろいろな切り方で同じ結果になる
  for (const size of [1, 2, 3, 7, 1000]) {
    got.length = 0;
    for (let i = 0; i < text.length; i += size) p.push(text.slice(i, i + size));
    assert.deepStrictEqual(got, [
      ['hello', { deviceId: 'd1' }],
      ['board:changed', { cards: [{ id: 'c1', title: 'あいう' }] }],
      ['card:log', { id: 'c1', entry: { kind: 'text', text: 'x' } }],
      ['message', 'plain'],
    ], `size ${size}`);
  }
  // 終わりの空行が来ていないイベントは出さない
  got.length = 0;
  p.push('event: x\ndata: 1\n');
  p.end();
  p.push('\n');
  assert.deepStrictEqual(got, []);
});

test('subscribe: Bearer で /api/v1/events を開き、分割された chunk（UTF-8 の途中も）からイベントを読む', async () => {
  const s = stream();
  const fetch = fakeFetch(() => ({ ok: true, status: 200, body: s.body }));
  const timers = fakeTimers();
  const client = createClient({ fetch, storage: paired('tok-s'), setTimeout: timers.setTimeout, clearTimeout: timers.clearTimeout, idleTimeoutMs: 0 });
  const got = [];
  let opened = 0;
  const off = client.subscribe((name, data) => got.push([name, data]), { onOpen: () => opened++ });
  await tick();
  assert.strictEqual(fetch.calls[0].url, '/api/v1/events');
  assert.strictEqual(fetch.calls[0].headers.Authorization, 'Bearer tok-s');
  assert.strictEqual(fetch.calls[0].headers.Accept, 'text/event-stream');
  assert.strictEqual(opened, 1);
  const bytes = new TextEncoder().encode('event: hello\ndata: {}\n\nevent: board:changed\ndata: {"t":"日本語"}\n\n');
  // 「日」の UTF-8 の途中で切る
  const cut = bytes.indexOf(0xe6) + 1;
  s.push(bytes.slice(0, 5));
  s.push(bytes.slice(5, cut));
  s.push(bytes.slice(cut));
  await tick();
  assert.deepStrictEqual(got, [['hello', {}], ['board:changed', { t: '日本語' }]]);
  off();
  s.push('event: late\ndata: 1\n\n');
  await tick();
  assert.strictEqual(got.length, 2, '止めたあとは知らせない');
  assert.deepStrictEqual(timers.pending(), [], '止めたら繋ぎ直さない');
});

test('subscribe: 切れたら待つ時間を延ばしながら繋ぎ直し、繋がるたびに onOpen を呼ぶ。届いたら待ち時間を戻す', async () => {
  const streams = [];
  const fetch = fakeFetch((call, n) => {
    if (n === 2 || n === 3) throw new TypeError('network down');
    const s = stream();
    streams.push(s);
    return { ok: true, status: 200, body: s.body };
  });
  const timers = fakeTimers();
  const client = createClient({ fetch, storage: paired(), setTimeout: timers.setTimeout, clearTimeout: timers.clearTimeout, backoffMinMs: 100, backoffMaxMs: 250, idleTimeoutMs: 0 });
  const events = [];
  let opened = 0;
  let closed = 0;
  const off = client.subscribe((name) => events.push(name), { onOpen: () => opened++, onClose: () => closed++ });
  await tick();
  assert.strictEqual(opened, 1);
  streams[0].push('event: hello\ndata: {}\n\n');
  await tick();
  streams[0].end(); // サーバーが閉じた
  await tick();
  assert.strictEqual(closed, 1);
  assert.deepStrictEqual(timers.pending(), [100]);
  await timers.fire(100); // 2回目: 失敗
  assert.deepStrictEqual(timers.pending(), [200]);
  await timers.fire(200); // 3回目: 失敗
  assert.deepStrictEqual(timers.pending(), [250], '上限で止める');
  await timers.fire(250); // 4回目: つながる
  assert.strictEqual(fetch.calls.length, 4);
  assert.strictEqual(opened, 2, 'つながり直したら onOpen（画面はここで board:get を取り直す）');
  streams[1].push('event: board:changed\ndata: {}\n\n');
  await tick();
  assert.deepStrictEqual(events, ['hello', 'board:changed']);
  streams[1].fail(new Error('reset'));
  await tick();
  assert.deepStrictEqual(timers.pending(), [100], '届いたあとに切れたら、最初の待ち時間から');
  off();
  assert.deepStrictEqual(timers.pending(), []);
});

test('subscribe: 401 ならトークンを消して止める（繋ぎ直さない）', async () => {
  const fetch = fakeFetch(() => res(401, { ok: false, error: '期限切れ' }));
  const timers = fakeTimers();
  const client = createClient({ fetch, storage: paired(), setTimeout: timers.setTimeout, clearTimeout: timers.clearTimeout });
  const got = [];
  client.onUnauthorized((err) => got.push(err.message));
  client.subscribe(() => {});
  await tick();
  assert.deepStrictEqual(got, ['期限切れ']);
  assert.strictEqual(client.hasToken(), false);
  assert.deepStrictEqual(timers.pending(), []);
});

test('subscribe: しばらく何も来なければ切れたものとして繋ぎ直す。reconnect ですぐに繋ぎ直す', async () => {
  const streams = [];
  const fetch = fakeFetch(() => {
    const s = stream();
    streams.push(s);
    return { ok: true, status: 200, body: s.body };
  });
  const timers = fakeTimers();
  const client = createClient({ fetch, storage: paired(), setTimeout: timers.setTimeout, clearTimeout: timers.clearTimeout, backoffMinMs: 100, idleTimeoutMs: 5000, sseHelloTimeoutMs: 0 });
  let opened = 0;
  const off = client.subscribe(() => {}, { onOpen: () => opened++ });
  await tick();
  assert.deepStrictEqual(timers.pending(), [5000]);
  streams[0].push(': ping\n\n'); // ping が来たら見張りを延ばす
  await tick();
  assert.deepStrictEqual(timers.pending(), [5000]);
  await timers.fire(5000); // 何も来ない
  await tick();
  assert.deepStrictEqual(timers.pending(), [100], '黙って切れた回線は捨てて、繋ぎ直しを待つ');
  await timers.fire(100);
  assert.strictEqual(opened, 2);
  off.reconnect();
  await tick();
  assert.strictEqual(opened, 3);
  assert.strictEqual(fetch.calls.length, 3);
  off();
});

test('端末の名前は userAgent から作る', () => {
  const ua = {
    iphone: 'Mozilla/5.0 (iPhone; CPU iPhone OS 17_4 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.4 Mobile/15E148 Safari/604.1',
    iphoneChrome: 'Mozilla/5.0 (iPhone; CPU iPhone OS 17_4 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) CriOS/123.0 Mobile/15E148 Safari/604.1',
    android: 'Mozilla/5.0 (Linux; Android 14; Pixel 8) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0 Mobile Safari/537.36',
    samsung: 'Mozilla/5.0 (Linux; Android 14; SM-S918B) AppleWebKit/537.36 (KHTML, like Gecko) SamsungBrowser/24.0 Chrome/117.0 Mobile Safari/537.36',
    ipad: 'Mozilla/5.0 (iPad; CPU OS 17_4 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.4 Mobile/15E148 Safari/604.1',
  };
  assert.strictEqual(deviceNameFromUA(ua.iphone), 'iPhone Safari');
  assert.strictEqual(deviceNameFromUA(ua.iphoneChrome), 'iPhone Chrome');
  assert.strictEqual(deviceNameFromUA(ua.android), 'Android Chrome');
  assert.strictEqual(deviceNameFromUA(ua.samsung), 'Android Samsung Internet');
  assert.strictEqual(deviceNameFromUA(ua.ipad), 'iPad Safari');
  assert.strictEqual(deviceNameFromUA(''), 'Browser');
  assert.strictEqual(deviceNameFromUA(undefined), 'Browser');
});

test('subscribe: SSE の本文が届かない経路（Quick Tunnel）では、hello を待って poll に切り替える', async () => {
  const streams = [];
  const polls = [];
  const fetch = fakeFetch((call) => {
    if (call.url.includes('/api/v1/events')) {
      const s = stream();
      streams.push(s);
      return { ok: true, status: 200, body: s.body };
    }
    polls.push(call.url);
    // 1 回目: 番号だけ。2 回目: イベント。3 回目: 取りこぼし（reset）。4 回目: 返事をしないまま
    if (polls.length === 1) return res(200, { ok: true, data: { epoch: 'e1', seq: 3, reset: true, events: [] } });
    if (polls.length === 2) return res(200, { ok: true, data: { epoch: 'e1', seq: 5, reset: false, events: [{ channel: 'card:log', data: { id: 'c1' } }, { channel: 'board:changed', data: { cards: [] } }] } });
    if (polls.length === 3) return res(200, { ok: true, data: { epoch: 'e2', seq: 1, reset: true, events: [] } });
    return new Promise(() => {});
  });
  const timers = fakeTimers();
  const client = createClient({ fetch, storage: paired(), setTimeout: timers.setTimeout, clearTimeout: timers.clearTimeout, sseHelloTimeoutMs: 6000, idleTimeoutMs: 0 });
  const got = [];
  let opened = 0;
  const off = client.subscribe((name, data) => got.push([name, data]), { onOpen: () => opened++ });
  await tick();
  assert.strictEqual(off.transport(), 'sse');
  await timers.fire(6000); // hello が来ない
  await tick(20);
  assert.strictEqual(off.transport(), 'poll');
  assert.deepStrictEqual(polls.slice(0, 4).map((u) => u.replace(/^.*\/api\/v1\/poll/, '')), ['', '?after=3&epoch=e1', '?after=5&epoch=e1', '?after=1&epoch=e2']);
  assert.deepStrictEqual(got, [['card:log', { id: 'c1' }], ['board:changed', { cards: [] }]]);
  // 最初の SSE・poll の最初・reset で、ボードを読み直してもらう
  assert.strictEqual(opened, 3);
  assert.strictEqual(fetch.calls.at(-1).headers.Authorization, 'Bearer tok-1');
  off();
});

test('subscribe: SSE で hello が届けば、poll には切り替えない', async () => {
  const streams = [];
  const fetch = fakeFetch(() => {
    const s = stream();
    streams.push(s);
    return { ok: true, status: 200, body: s.body };
  });
  const timers = fakeTimers();
  const client = createClient({ fetch, storage: paired(), setTimeout: timers.setTimeout, clearTimeout: timers.clearTimeout, sseHelloTimeoutMs: 6000, idleTimeoutMs: 0 });
  const off = client.subscribe(() => {});
  await tick();
  streams[0].push('event: hello\ndata: {}\n\n');
  await tick();
  assert.deepStrictEqual(timers.pending(), [], 'hello が来たら見張りは止める');
  assert.strictEqual(off.transport(), 'sse');
  off();
});

test('subscribe: poll で 401 なら止めて、ペアリングし直してもらう', async () => {
  const fetch = fakeFetch(() => res(401, { ok: false, error: 'expired' }));
  const client = createClient({ fetch, storage: paired(), transport: 'poll' });
  const errors = [];
  client.onUnauthorized((e) => errors.push(e.message));
  const off = client.subscribe(() => {});
  await tick(20);
  assert.deepStrictEqual(errors, ['expired']);
  assert.strictEqual(fetch.calls.length, 1);
  assert.strictEqual(client.hasToken(), false);
  off();
});
