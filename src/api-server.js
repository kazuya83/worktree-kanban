// ほかのツール（CLI・MCP・スクリプト）から使う API サーバー（v1）
// - 127.0.0.1 だけで HTTP 待ち受け。ほかの PC からは SSH のポート転送などで届ける
// - 認証は Authorization: Bearer <token>
//   - 同じ PC: 起動ごとに作るトークンを、本人しか読めないファイル（userData/api.json）に書く。CLI・MCP はそれを読む
//   - ほかの PC: アプリ（か同じ PC の CLI）で出したペアリングコードと引き換えに、トークンを出す（スマホと同じ仕組み）
// - POST /api/v1/invoke { channel, arg } でボードを操作する。使えるチャンネルは API_CHANNELS だけ
//   （同じ PC のトークンだけが使えるもの: LOCAL_ONLY_CHANNELS。ペアリングコードを出す・端末を無効にする）
// ブラウザからは使わせない（Origin の付いたリクエストは断る）
const http = require('http');
const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const { EventEmitter } = require('events');
const { tr } = require('../renderer/i18n');
const { PAIR_TTL_MS, MAX_PAIR_FAILURES, genToken, timingEqual, redactForRemote } = require('./remote');
const { genMobilePairCode, normalizePairCode, hashToken } = require('./mobile-server');

const DEFAULT_API_PORT = 47821;
const TOKEN_TTL_MS = 365 * 24 * 60 * 60 * 1000;
const MAX_BODY = 4 * 1024 * 1024; // 添付ファイル（base64）も送れるように
const PAIR_RATE_LIMIT = 10;
const PAIR_RATE_WINDOW_MS = 60 * 1000;
const LAST_SEEN_SAVE_MS = 60 * 60 * 1000;
const MAX_DEVICE_NAME = 64;
const DISCOVERY_FILE = 'api.json';
const LOCAL_DEVICE_ID = 'local';

// API から使ってよいチャンネル。api:* は src/api-ops.js（main.js で登録）
const API_CHANNELS = new Set([
  'api:status',
  'api:tasks',
  'api:task',
  'api:create',
  'api:pipelines',
  'api:pairCode',
  'api:devices',
  'api:revoke',
  'board:get',
  'card:create',
  'card:createFromIssues',
  'card:update',
  'card:move',
  'card:start',
  'card:resume',
  'card:stop',
  'card:send',
  'card:btw',
  'card:permission',
  'card:answer',
  'card:logs',
  'card:diff',
  'card:merge',
  'card:pr',
  'card:discard',
  'card:complete',
  'card:markSeen',
  'subtasks:accept',
  'subtasks:decline',
  'subtasks:approve',
  'subtasks:startOne',
  'notifications:read',
  'skills:list',
  'sessions:list',
]);
// 同じ PC のトークンだけが使えるチャンネル（ペアリングした端末から、別の端末を増やしたり消したりさせない）
const LOCAL_ONLY_CHANNELS = new Set(['api:pairCode', 'api:devices', 'api:revoke']);
// 見るだけのチャンネル（記録に残さない）
const API_READ_CHANNELS = new Set(['api:status', 'api:tasks', 'api:task', 'api:pipelines', 'api:devices', 'board:get', 'card:logs', 'card:diff', 'card:markSeen', 'notifications:read', 'skills:list', 'sessions:list']);

class HttpError extends Error {
  constructor(status, message) {
    super(message);
    this.status = status;
  }
}

function normalizeDevice(d) {
  if (!d || typeof d !== 'object') return null;
  if (typeof d.id !== 'string' || !d.id || typeof d.tokenHash !== 'string' || !/^[0-9a-f]{64}$/.test(d.tokenHash)) return null;
  return {
    id: d.id,
    name: typeof d.name === 'string' ? d.name : '',
    tokenHash: d.tokenHash,
    createdAt: Number(d.createdAt) || 0,
    expiresAt: Number(d.expiresAt) || 0,
    lastSeenAt: Number(d.lastSeenAt) || 0,
  };
}

function publicDevice(d) {
  return { id: d.id, name: d.name, createdAt: d.createdAt, expiresAt: d.expiresAt, lastSeenAt: d.lastSeenAt };
}

function cleanDeviceName(name) {
  const s = typeof name === 'string' ? name.replace(/[\u0000-\u001f\u007f]/g, ' ').trim().slice(0, MAX_DEVICE_NAME) : '';
  return s || 'CLI';
}

// ---- 同じ PC の CLI に、ポートとトークンを知らせるファイル ----

function discoveryFile(userData) {
  return path.join(userData, DISCOVERY_FILE);
}

function writeDiscovery(userData, info) {
  fs.mkdirSync(userData, { recursive: true });
  const file = discoveryFile(userData);
  // 古いファイルの権限を引き継がないように、消してから本人だけが読める形で作る
  try {
    fs.unlinkSync(file);
  } catch {
    /* 無い */
  }
  fs.writeFileSync(file, JSON.stringify(info), { mode: 0o600 });
  return file;
}

// 自分が書いたものだけを消す
function clearDiscovery(userData, pid = process.pid) {
  const file = discoveryFile(userData);
  try {
    const info = JSON.parse(fs.readFileSync(file, 'utf8'));
    if (info && info.pid === pid) fs.unlinkSync(file);
  } catch {
    /* 無い・壊れている */
  }
}

class ApiServer extends EventEmitter {
  // invoke(channel, arg, { deviceId, deviceName, local }) => Promise<any>
  // devices: ペアリングした端末 [{id, name, tokenHash, createdAt, expiresAt, lastSeenAt}]
  // onDevices(devices): 端末が増えた・消えた・lastSeenAt を保存するときに呼ぶ（tokenHash 付き。保存用）
  // localToken: 同じ PC の CLI・MCP が使うトークン（省くと作る）
  constructor({ invoke, port = DEFAULT_API_PORT, devices = [], onDevices, localToken, appVersion = '', mode = 'desktop', now = Date.now, tokenTtlMs = TOKEN_TTL_MS } = {}) {
    super();
    this.invoke = invoke;
    this.port = port;
    this.devices = (Array.isArray(devices) ? devices : []).map(normalizeDevice).filter(Boolean);
    this.onDevices = onDevices;
    this.localToken = localToken || genToken();
    this.appVersion = appVersion;
    this.mode = mode;
    this.now = now;
    this.tokenTtlMs = tokenTtlMs;
    this.server = null;
    this.pairCode = null;
    this.pairExpiresAt = 0;
    this.pairFailures = 0;
    this.pairAttempts = new Map();
    this.savedSeenAt = new Map();
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

  // 同じ PC の CLI に知らせる中身
  discoveryInfo() {
    return { pid: process.pid, port: this.port, token: this.localToken, version: this.appVersion, mode: this.mode, url: `http://127.0.0.1:${this.port}` };
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
    return this.removeDevices(this.devices.map((d) => d.id));
  }

  start(port = this.port) {
    if (this.server) return Promise.resolve(this.status());
    const n = parseInt(port, 10);
    const listenPort = Number.isFinite(n) && n >= 0 && n <= 65535 ? n : DEFAULT_API_PORT;
    return new Promise((resolve, reject) => {
      const server = http.createServer((req, res) => this.handle(req, res));
      server.on('error', (err) => {
        if (!this.server) reject(err);
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
    this.clearPairCode();
    const server = this.server;
    this.server = null;
    if (!server) return Promise.resolve();
    return new Promise((resolve) => {
      server.close(() => resolve());
      server.closeAllConnections?.();
      this.emit('changed');
    });
  }

  // ---- HTTP ----

  async handle(req, res) {
    try {
      // ブラウザ（ほかのサイトのページ）からは使わせない
      if (req.headers.origin) throw new HttpError(403, tr('ブラウザからは使えません'));
      const p = new URL(req.url || '/', 'http://localhost').pathname;
      await this.handleApi(req, res, p);
    } catch (err) {
      const status = err instanceof HttpError ? err.status : 500;
      const message = err instanceof HttpError ? err.message : (err && err.message) || String(err);
      if (!res.headersSent) this.sendJson(res, status, { ok: false, error: message });
      else res.destroy();
    }
  }

  sendJson(res, status, obj) {
    const body = JSON.stringify(obj);
    res.writeHead(status, {
      'Content-Type': 'application/json; charset=utf-8',
      'Content-Length': Buffer.byteLength(body),
      'Cache-Control': 'no-store',
      'X-Content-Type-Options': 'nosniff',
    });
    res.end(body);
  }

  readJson(req) {
    return new Promise((resolve, reject) => {
      if (parseInt(req.headers['content-length'], 10) > MAX_BODY) {
        req.resume();
        return reject(new HttpError(413, tr('送られたデータが大きすぎます')));
      }
      const chunks = [];
      let size = 0;
      let done = false;
      req.on('data', (c) => {
        if (done) return;
        size += c.length;
        if (size > MAX_BODY) {
          done = true;
          req.resume();
          reject(new HttpError(413, tr('送られたデータが大きすぎます')));
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

  // Authorization: Bearer <token> から、同じ PC か、ペアリングした端末かを決める
  authenticate(req) {
    const m = /^Bearer\s+(\S+)\s*$/i.exec(String(req.headers.authorization || ''));
    if (!m) throw new HttpError(401, tr('トークンがありません。同じ PC ならアプリを起動し、ほかの PC からはペアリングしてください'));
    if (timingEqual(m[1], this.localToken)) return { id: LOCAL_DEVICE_ID, name: LOCAL_DEVICE_ID, local: true };
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
    return { id: device.id, name: device.name, local: false };
  }

  async handleApi(req, res, p) {
    const route = { '/api/v1/pair': 'POST', '/api/v1/session': 'GET', '/api/v1/invoke': 'POST', '/api/v1/logout': 'POST' }[p];
    if (!route) throw new HttpError(404, tr('見つかりません'));
    if (req.method !== route) {
      res.setHeader('Allow', route);
      throw new HttpError(405, tr('このメソッドは使えません'));
    }
    if (p === '/api/v1/pair') return this.handlePair(req, res);
    const who = this.authenticate(req);
    if (p === '/api/v1/session') {
      return this.sendJson(res, 200, { ok: true, data: { deviceId: who.id, deviceName: who.name, local: who.local, appVersion: this.appVersion, mode: this.mode, channels: [...API_CHANNELS].filter((c) => who.local || !LOCAL_ONLY_CHANNELS.has(c)) } });
    }
    if (p === '/api/v1/logout') {
      if (!who.local) this.removeDevices([who.id]);
      return this.sendJson(res, 200, { ok: true, data: null });
    }
    const body = await this.readJson(req);
    const channel = typeof body.channel === 'string' ? body.channel : '';
    if (!API_CHANNELS.has(channel) || (LOCAL_ONLY_CHANNELS.has(channel) && !who.local)) throw new HttpError(403, tr('この操作は API からは使えません: {channel}', { channel }));
    try {
      const data = redactForRemote(await this.invoke(channel, body.arg, { deviceId: who.id, deviceName: who.name, local: who.local }));
      this.sendJson(res, 200, { ok: true, data: data === undefined ? null : data });
    } catch (err) {
      this.sendJson(res, 200, { ok: false, error: (err && err.message) || String(err) });
    }
  }

  takePairAttempt(ip) {
    const t = this.now();
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
    // SSH のポート転送で届くと、どれも 127.0.0.1 から来る。それでも回数の上限とコードの使い捨てで総当たりを防ぐ
    if (!this.takePairAttempt(req.socket.remoteAddress || '')) throw new HttpError(429, tr('試す回数が多すぎます。しばらく待ってから、もう一度試してください'));
    const body = await this.readJson(req);
    if (!this.pairCodeActive()) throw new HttpError(403, tr('ペアリングコードが出ていません。アプリで新しいコードを出してください'));
    const code = normalizePairCode(body.code);
    if (!timingEqual(code, this.pairCode)) {
      if (++this.pairFailures >= MAX_PAIR_FAILURES) this.clearPairCode();
      throw new HttpError(401, tr('ペアリングコードが違うか、期限切れです。アプリで新しいコードを出してください'));
    }
    this.clearPairCode();
    const token = genToken();
    const t = this.now();
    const device = { id: crypto.randomUUID(), name: cleanDeviceName(body.deviceName), tokenHash: hashToken(token), createdAt: t, expiresAt: t + this.tokenTtlMs, lastSeenAt: t };
    this.devices.push(device);
    this.saveDevices();
    this.emit('changed');
    this.sendJson(res, 200, { ok: true, data: { token, deviceId: device.id, expiresAt: device.expiresAt } });
  }
}

module.exports = {
  ApiServer,
  API_CHANNELS,
  LOCAL_ONLY_CHANNELS,
  API_READ_CHANNELS,
  DEFAULT_API_PORT,
  DISCOVERY_FILE,
  TOKEN_TTL_MS,
  discoveryFile,
  writeDiscovery,
  clearDiscovery,
};
