// スマホのブラウザ（と将来のネイティブアプリ）から使う API サーバー（v1）
// - 127.0.0.1 だけで HTTP 待ち受け。外からは Cloudflare Tunnel が中継する
// - 認証は Authorization: Bearer <token>（Cookie は使わない）。トークンはペアリングコードと引き換えに出す
// - POST /api/v1/invoke でボード操作、GET /api/v1/events（Server-Sent Events）で board:changed などを流す
// - それ以外の GET/HEAD は、スマホ用の画面（mobile/）と言葉の辞書（renderer/i18n.js・renderer/locales）を返す
const http = require('http');
const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const { EventEmitter } = require('events');
const { tr } = require('../renderer/i18n');
const { PAIR_TTL_MS, MAX_PAIR_FAILURES, genToken, timingEqual, redactForRemote } = require('./remote');

// トークンの有効期限
const TOKEN_TTL_MS = 30 * 24 * 60 * 60 * 1000;
// 手入力しやすいペアリングコード。紛らわしい 0/O/1/I/L は使わない
const PAIR_ALPHABET = 'ABCDEFGHJKMNPQRSTUVWXYZ23456789';
const PAIR_CODE_LENGTH = 8;
// リクエスト本文の上限
const MAX_BODY = 1024 * 1024;
// 上限を超えた本文を読み捨てる量の上限
const MAX_DRAIN = 16 * MAX_BODY;
// SSE の接続を保つための空行（コメント）の間隔
const PING_INTERVAL_MS = 25 * 1000;
// poll で新しいイベントを待つ長さ（Cloudflare は 100 秒で切るので、それより十分短く）
const POLL_WAIT_MS = 25 * 1000;
// poll のために覚えておくイベントの数
const RECENT_LIMIT = 300;
// lastSeenAt は毎回変わるので、保存（onDevices）はこの間隔に 1 回まで
const LAST_SEEN_SAVE_MS = 60 * 60 * 1000;
// pair の回数制限（IP ごと）
const PAIR_RATE_LIMIT = 10;
const PAIR_RATE_WINDOW_MS = 60 * 1000;
const MAX_DEVICE_NAME = 64;

// スマホから使ってよいチャンネル（remote.js の PROXY_CHANNELS の一部。設定やフォルダ操作は出さない）
const MOBILE_CHANNELS = new Set([
  'board:get',
  'repo:switchTab',
  'card:create',
  'card:update',
  'card:move',
  'card:start',
  'card:resume',
  'card:stop',
  'card:send',
  'card:permission',
  'card:answer',
  'card:logs',
  'card:diff',
  'card:markSeen',
  'card:btw',
  'notifications:read',
  'notifications:act',
  'notifications:clear',
  'subtasks:accept',
  'subtasks:decline',
  'subtasks:approve',
  'subtasks:startOne',
  'skills:list',
  'sessions:list',
  // アプリの中のターミナル。パソコンのアプリで「スマホからのターミナルを許可」にしたときだけ使える（main.js で断る）
  'terminal:available',
  'terminal:list',
  'terminal:open',
  'terminal:read',
  'terminal:write',
  'terminal:resize',
  'terminal:close',
]);

const CONTENT_TYPES = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.webmanifest': 'application/manifest+json; charset=utf-8',
  '.txt': 'text/plain; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.gif': 'image/gif',
  '.webp': 'image/webp',
  '.ico': 'image/x-icon',
  '.woff': 'font/woff',
  '.woff2': 'font/woff2',
};

const SECURITY_HEADERS = {
  'Content-Security-Policy': "default-src 'self'; img-src 'self' data:; style-src 'self'; script-src 'self'; connect-src 'self'; frame-ancestors 'none'; base-uri 'none'",
  'X-Content-Type-Options': 'nosniff',
  'Referrer-Policy': 'no-referrer',
  'X-Frame-Options': 'DENY',
};

function genMobilePairCode() {
  let s = '';
  for (let i = 0; i < PAIR_CODE_LENGTH; i++) s += PAIR_ALPHABET[crypto.randomInt(0, PAIR_ALPHABET.length)];
  return s;
}

// 入力のゆれ（大文字小文字・空白・ハイフン）をそろえる
function normalizePairCode(code) {
  return String(code == null ? '' : code).replace(/[\s-]+/g, '').toUpperCase();
}

function hashToken(token) {
  return crypto.createHash('sha256').update(String(token)).digest('hex');
}

function publicDevice(d) {
  return { id: d.id, name: d.name, createdAt: d.createdAt, expiresAt: d.expiresAt, lastSeenAt: d.lastSeenAt };
}

function normalizeDevice(d) {
  if (!d || typeof d !== 'object') return null;
  if (typeof d.id !== 'string' || !d.id || typeof d.tokenHash !== 'string' || !/^[0-9a-f]{64}$/.test(d.tokenHash)) return null;
  const expiresAt = Number(d.expiresAt) || 0;
  return {
    id: d.id,
    name: typeof d.name === 'string' ? d.name : '',
    tokenHash: d.tokenHash,
    createdAt: Number(d.createdAt) || 0,
    expiresAt,
    lastSeenAt: Number(d.lastSeenAt) || 0,
  };
}

function cleanDeviceName(name) {
  const s = typeof name === 'string' ? name.replace(/[\u0000-\u001f\u007f]/g, ' ').trim().slice(0, MAX_DEVICE_NAME) : '';
  return s || tr('スマートフォン');
}

// URL のパスを、root の中の実ファイルの絶対パスにする。外へ出るもの・おかしなものは null
function safeJoin(root, rel) {
  let decoded;
  try {
    decoded = decodeURIComponent(rel);
  } catch {
    return null;
  }
  if (decoded.includes('\0') || decoded.includes('\\')) return null;
  const parts = decoded.split('/');
  if (parts.some((p) => p === '..' || p === '.')) return null;
  const base = path.resolve(root);
  const full = path.resolve(base, path.posix.normalize(decoded).replace(/^\/+/, ''));
  if (full !== base && !full.startsWith(base + path.sep)) return null;
  return full;
}

class HttpError extends Error {
  constructor(status, message) {
    super(message);
    this.status = status;
  }
}

class MobileServer extends EventEmitter {
  // invoke(channel, arg, { deviceId, deviceName }) => Promise<any>
  // devices: 保存してある端末 [{id, name, tokenHash, createdAt, expiresAt, lastSeenAt}]
  // onDevices(devices): 端末が増えた・消えた・lastSeenAt を保存するときに呼ぶ（tokenHash 付き。保存用）
  // getLanguage(): スマホの画面に出す言語（session で返す）
  constructor({ invoke, port = 0, devices = [], onDevices, appVersion = '', getLanguage, staticRoot, rendererRoot, now = Date.now, tokenTtlMs = TOKEN_TTL_MS, pingIntervalMs = PING_INTERVAL_MS, pollWaitMs = POLL_WAIT_MS } = {}) {
    super();
    this.invoke = invoke;
    this.port = port;
    this.devices = (Array.isArray(devices) ? devices : []).map(normalizeDevice).filter(Boolean);
    this.onDevices = onDevices;
    this.appVersion = appVersion;
    this.getLanguage = getLanguage;
    this.staticRoot = staticRoot || path.join(__dirname, '..', 'mobile');
    this.rendererRoot = rendererRoot || path.join(__dirname, '..', 'renderer');
    this.now = now;
    this.tokenTtlMs = tokenTtlMs;
    this.pingIntervalMs = pingIntervalMs;
    this.server = null;
    this.streams = new Set(); // { res, deviceId, timer }
    // 待ち受け型のポーリング（/api/v1/poll）。Cloudflare の Quick Tunnel は SSE の本文を通さないので、その代わりに使う
    this.seq = 0; // broadcast ごとに 1 ずつ増える番号
    this.droppedUpTo = 0; // 数の上限で捨てたイベントの、いちばん新しい番号
    this.epoch = crypto.randomBytes(6).toString('hex'); // 起動ごとの印。変わったら番号の続きは無いので、読み直してもらう
    this.recent = []; // 最近のイベント [{ seq, channel, data }]（古いものから捨てる。board:changed は最新の 1 つだけ残す）
    this.waiters = new Set(); // 待っている poll { res, deviceId, after, timer }
    this.pollWaitMs = pollWaitMs;
    this.pairCode = null;
    this.pairExpiresAt = 0;
    this.pairFailures = 0;
    this.pairAttempts = new Map(); // ip -> { count, resetAt }
    this.savedSeenAt = new Map(); // deviceId -> 最後に保存した lastSeenAt
    for (const d of this.devices) this.savedSeenAt.set(d.id, d.lastSeenAt);
  }

  listening() {
    return !!this.server;
  }

  pairCodeActive() {
    if (this.pairCode && this.now() >= this.pairExpiresAt) this.clearPairCode();
    return !!this.pairCode;
  }

  status() {
    this.dropExpired();
    return {
      listening: this.listening(),
      port: this.port,
      pairCode: this.pairCodeActive() ? { expiresAt: this.pairExpiresAt } : null,
      devices: this.devices.map(publicDevice),
    };
  }

  // 新しいペアリングコードを出す（前のコードは使えなくなる）
  refreshPairCode() {
    this.pairCode = genMobilePairCode();
    this.pairExpiresAt = this.now() + PAIR_TTL_MS;
    this.pairFailures = 0;
    this.emit('changed');
    return { code: this.pairCode, expiresAt: this.pairExpiresAt };
  }

  clearPairCode() {
    const had = !!this.pairCode;
    this.pairCode = null;
    this.pairExpiresAt = 0;
    this.pairFailures = 0;
    if (had) this.emit('changed');
  }

  saveDevices() {
    for (const d of this.devices) this.savedSeenAt.set(d.id, d.lastSeenAt);
    this.onDevices?.(this.devices.map((d) => ({ ...d })));
  }

  removeDevices(ids) {
    const drop = new Set(ids);
    if (!drop.size) return false;
    const before = this.devices.length;
    this.devices = this.devices.filter((d) => !drop.has(d.id));
    for (const id of drop) this.savedSeenAt.delete(id);
    for (const s of [...this.streams]) if (drop.has(s.deviceId)) this.closeStream(s);
    for (const w of [...this.waiters]) if (drop.has(w.deviceId)) this.closeWaiter(w);
    if (this.devices.length === before) return false;
    this.saveDevices();
    this.emit('changed');
    return true;
  }

  dropExpired() {
    const t = this.now();
    this.removeDevices(this.devices.filter((d) => t >= d.expiresAt).map((d) => d.id));
  }

  revokeDevice(id) {
    return this.removeDevices([id]);
  }

  revokeAll() {
    this.removeDevices(this.devices.map((d) => d.id));
  }

  start(port = this.port) {
    if (this.server) return Promise.resolve(this.status());
    const n = parseInt(port, 10);
    const listenPort = Number.isFinite(n) && n >= 0 && n <= 65535 ? n : 0;
    return new Promise((resolve, reject) => {
      const server = http.createServer((req, res) => this.handle(req, res));
      server.on('error', (err) => {
        if (!this.server) reject(err);
        // 'error' の聞き手がいないと例外でメインプロセスが落ちるので、いるときだけ流す
        else if (this.listenerCount('error')) this.emit('error', err);
      });
      server.on('clientError', (err, socket) => {
        if (socket.writable) socket.end('HTTP/1.1 400 Bad Request\r\nConnection: close\r\n\r\n');
        else socket.destroy();
      });
      server.listen(listenPort, '127.0.0.1', () => {
        this.port = server.address().port;
        this.server = server;
        this.emit('changed');
        resolve(this.status());
      });
    });
  }

  stop() {
    for (const s of [...this.streams]) this.closeStream(s);
    for (const w of [...this.waiters]) this.answerPoll(w, true);
    this.clearPairCode();
    const s = this.server;
    this.server = null;
    return new Promise((resolve) => {
      if (!s) return resolve();
      s.close(() => {
        this.emit('changed');
        resolve();
      });
      s.closeAllConnections?.();
    });
  }

  // 全部の SSE 接続へイベントを流す（秘密は外す）
  broadcast(channel, payload) {
    if (!this.server) return;
    const name = String(channel).replace(/[\r\n]/g, '');
    const value = redactForRemote(payload) ?? null;
    // poll のために覚えておく。ボードは全体を送るので、古いボードは要らない
    this.seq += 1;
    if (name === 'board:changed') this.recent = this.recent.filter((e) => e.channel !== 'board:changed');
    this.recent.push({ seq: this.seq, channel: name, data: value });
    if (this.recent.length > RECENT_LIMIT) {
      const dropped = this.recent.splice(0, this.recent.length - RECENT_LIMIT);
      this.droppedUpTo = dropped[dropped.length - 1].seq; // ここまでのイベントは、もう渡せない
    }
    for (const w of [...this.waiters]) this.answerPoll(w);
    if (!this.streams.size) return;
    const chunk = `event: ${name}\ndata: ${JSON.stringify(value)}\n\n`;
    for (const s of this.streams) this.writeStream(s, chunk);
  }

  // after より新しいイベント。取りこぼしがあれば reset（ボードを読み直してもらう）
  eventsAfter(after, epoch = this.epoch) {
    const events = this.recent.filter((e) => e.seq > after).map(({ channel, data }) => ({ channel, data }));
    // 捨てたイベントより前から欲しい・番号がこちらより先（アプリを起動し直した）ときは、ボードを読み直してもらう
    const reset = epoch !== this.epoch || after > this.seq || after < this.droppedUpTo;
    return { reset, events };
  }

  answerPoll(w, force = false) {
    const { reset, events } = this.eventsAfter(w.after, w.epoch);
    if (!force && !reset && !events.length) return false;
    clearTimeout(w.timer);
    this.waiters.delete(w);
    if (!w.res.destroyed && !w.res.writableEnded) this.sendJson(w.res, 200, { ok: true, data: { epoch: this.epoch, seq: this.seq, reset, events } });
    return true;
  }

  writeStream(s, chunk) {
    if (s.res.destroyed || s.res.writableEnded) return;
    try {
      s.res.write(chunk);
    } catch {
      /* 切断済み */
    }
  }

  // GET /api/v1/poll?after=<seq>&epoch=<前に受け取った epoch>: 新しいイベントがあればすぐ、無ければ最大 pollWaitMs 待って返す。
  // after が無いときは、いまの番号だけを返す（reset: true。最初にボードを読んでもらう）
  handlePoll(req, res, device, url) {
    const raw = url.searchParams.get('after');
    const after = raw != null && /^\d+$/.test(raw) ? Number(raw) : null;
    if (after === null) return this.sendJson(res, 200, { ok: true, data: { epoch: this.epoch, seq: this.seq, reset: true, events: [] } });
    const w = { res, deviceId: device.id, after, epoch: url.searchParams.get('epoch') || this.epoch, timer: null };
    if (this.answerPoll(w)) return undefined;
    w.timer = setTimeout(() => this.answerPoll(w, true), this.pollWaitMs);
    w.timer.unref?.();
    this.waiters.add(w);
    const done = () => {
      clearTimeout(w.timer);
      this.waiters.delete(w);
    };
    req.on('close', done);
    res.on('close', done);
    return undefined;
  }

  closeWaiter(w) {
    clearTimeout(w.timer);
    this.waiters.delete(w);
    if (!w.res.headersSent) this.sendJson(w.res, 401, { ok: false, error: tr('ログインしてください。アプリに出ているペアリングコードを入れてください') });
    else w.res.destroy();
  }

  closeStream(s) {
    clearInterval(s.timer);
    this.streams.delete(s);
    try {
      s.res.end();
    } catch {
      /* 切断済み */
    }
    s.res.socket?.destroy();
  }

  // ---- HTTP ----

  async handle(req, res) {
    try {
      const url = new URL(req.url || '/', 'http://localhost');
      const p = url.pathname;
      if (p === '/api' || p.startsWith('/api/')) await this.handleApi(req, res, p);
      else await this.handleStatic(req, res, p);
    } catch (err) {
      const status = err instanceof HttpError ? err.status : 500;
      const message = err instanceof HttpError ? err.message : (err && err.message) || String(err);
      if (!res.headersSent) this.sendJson(res, status, { ok: false, error: message });
      else res.destroy();
    }
  }

  setCommonHeaders(res) {
    for (const [k, v] of Object.entries(SECURITY_HEADERS)) res.setHeader(k, v);
  }

  sendJson(res, status, obj) {
    const body = JSON.stringify(obj);
    this.setCommonHeaders(res);
    res.writeHead(status, {
      'Content-Type': 'application/json; charset=utf-8',
      'Content-Length': Buffer.byteLength(body),
      'Cache-Control': 'no-store',
    });
    res.end(body);
  }

  clientIp(req) {
    const cf = req.headers['cf-connecting-ip'];
    return (typeof cf === 'string' && cf.trim()) || req.socket.remoteAddress || '';
  }

  readJson(req, res) {
    return new Promise((resolve, reject) => {
      // 大きすぎるときは先に 413 を返し、残りは読み捨てる（途中で切ると相手には 413 が届かない）。
      // 読み捨てる量にも上限を付け、それを超えたら接続ごと切る
      const tooLarge = () => {
        let dropped = 0;
        req.on('data', (c) => {
          dropped += c.length;
          if (dropped > MAX_DRAIN) req.socket.destroy();
        });
        req.resume();
        reject(new HttpError(413, tr('送られたデータが大きすぎます')));
      };
      if (parseInt(req.headers['content-length'], 10) > MAX_BODY) return tooLarge();
      const chunks = [];
      let size = 0;
      let done = false;
      req.on('data', (c) => {
        if (done) return;
        size += c.length;
        if (size > MAX_BODY) {
          done = true;
          tooLarge();
          return;
        }
        chunks.push(c);
      });
      req.on('end', () => {
        if (done) return;
        done = true;
        const text = Buffer.concat(chunks).toString('utf8');
        if (!text.trim()) return resolve({});
        try {
          const v = JSON.parse(text);
          if (!v || typeof v !== 'object' || Array.isArray(v)) throw new Error('not object');
          resolve(v);
        } catch {
          reject(new HttpError(400, tr('リクエストの形が正しくありません')));
        }
      });
      req.on('error', (err) => {
        if (done) return;
        done = true;
        reject(err);
      });
    });
  }

  // Authorization: Bearer <token> から端末を探す。無い・期限切れは 401
  authenticate(req) {
    const m = /^Bearer\s+(\S+)\s*$/i.exec(String(req.headers.authorization || ''));
    if (!m) throw new HttpError(401, tr('ログインしてください。アプリに出ているペアリングコードを入れてください'));
    const h = hashToken(m[1]);
    const device = this.devices.find((d) => timingEqual(h, d.tokenHash));
    if (!device) throw new HttpError(401, tr('トークンが無効です。もう一度ペアリングしてください'));
    const t = this.now();
    if (t >= device.expiresAt) {
      this.removeDevices([device.id]);
      throw new HttpError(401, tr('ログインの期限が切れました。もう一度ペアリングしてください'));
    }
    device.lastSeenAt = t;
    if (t - (this.savedSeenAt.get(device.id) || 0) >= LAST_SEEN_SAVE_MS) this.saveDevices();
    return device;
  }

  async handleApi(req, res, p) {
    const route = {
      '/api/v1/pair': 'POST',
      '/api/v1/session': 'GET',
      '/api/v1/invoke': 'POST',
      '/api/v1/events': 'GET',
      '/api/v1/poll': 'GET',
      '/api/v1/logout': 'POST',
    }[p];
    if (!route) throw new HttpError(404, tr('見つかりません'));
    if (req.method !== route) {
      res.setHeader('Allow', route);
      throw new HttpError(405, tr('このメソッドは使えません'));
    }
    if (p === '/api/v1/pair') return this.handlePair(req, res);
    const device = this.authenticate(req);
    if (p === '/api/v1/session') {
      return this.sendJson(res, 200, {
        ok: true,
        data: {
          deviceId: device.id,
          deviceName: device.name,
          expiresAt: device.expiresAt,
          appVersion: this.appVersion,
          language: typeof this.getLanguage === 'function' ? this.getLanguage() : undefined,
          channels: [...MOBILE_CHANNELS],
        },
      });
    }
    if (p === '/api/v1/events') return this.handleEvents(req, res, device);
    if (p === '/api/v1/poll') return this.handlePoll(req, res, device, new URL(req.url || '/', 'http://localhost'));
    if (p === '/api/v1/logout') {
      this.removeDevices([device.id]);
      return this.sendJson(res, 200, { ok: true, data: null });
    }
    // /api/v1/invoke
    const body = await this.readJson(req, res);
    const channel = typeof body.channel === 'string' ? body.channel : '';
    if (!MOBILE_CHANNELS.has(channel)) throw new HttpError(403, tr('この操作はスマホからは使えません: {channel}', { channel }));
    try {
      const data = redactForRemote(await this.invoke(channel, body.arg, { deviceId: device.id, deviceName: device.name }));
      this.sendJson(res, 200, { ok: true, data: data === undefined ? null : data });
    } catch (err) {
      this.sendJson(res, 200, { ok: false, error: (err && err.message) || String(err) });
    }
  }

  takePairAttempt(ip) {
    const t = this.now();
    // 古い記録は捨てる（増え続けないように）
    if (this.pairAttempts.size > 1000) for (const [k, v] of this.pairAttempts) if (t >= v.resetAt) this.pairAttempts.delete(k);
    let a = this.pairAttempts.get(ip);
    if (!a || t >= a.resetAt) {
      a = { count: 0, resetAt: t + PAIR_RATE_WINDOW_MS };
      this.pairAttempts.set(ip, a);
    }
    a.count += 1;
    return a.count <= PAIR_RATE_LIMIT;
  }

  async handlePair(req, res) {
    if (!this.takePairAttempt(this.clientIp(req))) throw new HttpError(429, tr('試す回数が多すぎます。しばらく待ってから、もう一度試してください'));
    const body = await this.readJson(req, res);
    if (!this.pairCodeActive()) throw new HttpError(403, tr('ペアリングコードが出ていません。アプリで新しいコードを出してください'));
    const code = normalizePairCode(body.code);
    if (!timingEqual(code, this.pairCode)) {
      if (++this.pairFailures >= MAX_PAIR_FAILURES) this.clearPairCode();
      throw new HttpError(401, tr('ペアリングコードが違うか、期限切れです。アプリで新しいコードを出してください'));
    }
    // コードは 1 回だけ使える
    this.clearPairCode();
    const token = genToken();
    const t = this.now();
    const device = {
      id: crypto.randomUUID(),
      name: cleanDeviceName(body.deviceName),
      tokenHash: hashToken(token),
      createdAt: t,
      expiresAt: t + this.tokenTtlMs,
      lastSeenAt: t,
    };
    this.devices.push(device);
    this.saveDevices();
    this.emit('changed');
    this.sendJson(res, 200, { ok: true, data: { token, deviceId: device.id, expiresAt: device.expiresAt } });
  }

  handleEvents(req, res, device) {
    this.setCommonHeaders(res);
    res.writeHead(200, {
      'Content-Type': 'text/event-stream; charset=utf-8',
      'Cache-Control': 'no-store',
      Connection: 'keep-alive',
      'X-Accel-Buffering': 'no',
    });
    req.socket.setTimeout(0);
    req.socket.setNoDelay?.(true);
    const s = { res, deviceId: device.id, timer: null };
    s.timer = setInterval(() => this.writeStream(s, ': ping\n\n'), this.pingIntervalMs);
    s.timer.unref?.();
    this.streams.add(s);
    const done = () => {
      clearInterval(s.timer);
      this.streams.delete(s);
    };
    req.on('close', done);
    res.on('close', done);
    this.writeStream(s, `event: hello\ndata: ${JSON.stringify({ deviceId: device.id, appVersion: this.appVersion })}\n\n`);
  }

  // ---- 静的ファイル ----

  resolveStatic(p) {
    if (p === '/' || p === '/index.html') return path.join(this.staticRoot, 'index.html');
    if (p === '/manifest.webmanifest') return path.join(this.staticRoot, 'manifest.webmanifest');
    if (p === '/i18n.js') return path.join(this.rendererRoot, 'i18n.js');
    if (p.startsWith('/assets/')) return safeJoin(path.join(this.staticRoot, 'assets'), p.slice('/assets/'.length));
    if (p.startsWith('/locales/')) {
      const full = safeJoin(path.join(this.rendererRoot, 'locales'), p.slice('/locales/'.length));
      return full && full.endsWith('.js') ? full : null;
    }
    return null;
  }

  async handleStatic(req, res, p) {
    if (req.method !== 'GET' && req.method !== 'HEAD') {
      res.setHeader('Allow', 'GET, HEAD');
      throw new HttpError(405, tr('このメソッドは使えません'));
    }
    const file = this.resolveStatic(p);
    if (!file) throw new HttpError(404, tr('見つかりません'));
    let st;
    try {
      st = await fs.promises.stat(file);
    } catch {
      throw new HttpError(404, tr('見つかりません'));
    }
    if (!st.isFile()) throw new HttpError(404, tr('見つかりません'));
    const body = await fs.promises.readFile(file);
    this.setCommonHeaders(res);
    res.writeHead(200, {
      'Content-Type': CONTENT_TYPES[path.extname(file).toLowerCase()] || 'application/octet-stream',
      'Content-Length': body.length,
      'Cache-Control': 'no-cache',
    });
    res.end(req.method === 'HEAD' ? undefined : body);
  }
}

module.exports = {
  MobileServer,
  MOBILE_CHANNELS,
  TOKEN_TTL_MS,
  PAIR_ALPHABET,
  PAIR_CODE_LENGTH,
  MAX_BODY,
  PING_INTERVAL_MS,
  LAST_SEEN_SAVE_MS,
  PAIR_RATE_LIMIT,
  genMobilePairCode,
  normalizePairCode,
  hashToken,
  safeJoin,
};
