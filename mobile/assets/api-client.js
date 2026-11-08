// スマホ用の画面から、デスクトップのアプリの API（/api/v1）を使うための部品。
// - DOM には触らない。fetch と保存先（localStorage と同じ getItem / setItem / removeItem）を差し替えられる
// - 画面（<script>）とテスト（require）の両方から使う。将来ネイティブのアプリでも使い回せるよう、ブラウザだけの物には頼らない
// - 成功は {ok:true,data}、失敗は {ok:false,error}。401 のときはトークンを消して onUnauthorized で知らせる
(function (root, factory) {
  const api = factory();
  if (typeof module === 'object' && module.exports) module.exports = api;
  else root.MobileApi = api;
})(typeof globalThis !== 'undefined' ? globalThis : this, function () {
  const DEFAULT_STORAGE_KEY = 'worktreeKanban.mobile.auth';
  const BACKOFF_MIN_MS = 1000;
  const BACKOFF_MAX_MS = 30000;
  // サーバーは 25 秒ごとに「: ping」を送る。これより長く何も来なければ、切れたものとして繋ぎ直す
  const IDLE_TIMEOUT_MS = 70000;

  class ApiError extends Error {
    constructor(message, status, code) {
      super(message);
      this.name = 'ApiError';
      this.status = status || 0;
      if (code) this.code = code;
    }
  }

  // userAgent から端末の名前を作る（例: "iPhone Safari"、"Android Chrome"）
  function deviceNameFromUA(ua) {
    const s = String(ua || '');
    const device = /iPhone/.test(s) ? 'iPhone' : /iPad/.test(s) ? 'iPad' : /Android/.test(s) ? 'Android' : /Macintosh|Mac OS X/.test(s) ? 'Mac' : /Windows/.test(s) ? 'Windows' : /CrOS/.test(s) ? 'ChromeOS' : /Linux/.test(s) ? 'Linux' : '';
    // 順番に意味がある（Chrome の UA には Safari も、Edge の UA には Chrome も入っている）
    const browser = /EdgiOS|EdgA|Edg\//.test(s) ? 'Edge'
      : /SamsungBrowser/.test(s) ? 'Samsung Internet'
      : /FxiOS|Firefox\//.test(s) ? 'Firefox'
      : /OPR\/|OPiOS/.test(s) ? 'Opera'
      : /CriOS|Chrome\//.test(s) ? 'Chrome'
      : /Safari\//.test(s) ? 'Safari'
      : '';
    return [device, browser].filter(Boolean).join(' ') || 'Browser';
  }

  // Server-Sent Events の読み取り。chunk はどこで切れていてもよい（行の途中・イベントの途中）
  // onEvent(name, data): data は JSON として読めればその値、読めなければ文字列のまま
  function createSseParser(onEvent) {
    let buf = '';
    let name = '';
    let data = [];
    const dispatch = () => {
      if (!data.length) {
        name = '';
        return;
      }
      const raw = data.join('\n');
      let value = raw;
      try {
        value = JSON.parse(raw);
      } catch {
        /* JSON でなければ文字列のまま */
      }
      const ev = name || 'message';
      name = '';
      data = [];
      onEvent(ev, value);
    };
    const line = (l) => {
      if (l === '') return dispatch();
      if (l[0] === ':') return; // コメント（: ping）
      const i = l.indexOf(':');
      const field = i < 0 ? l : l.slice(0, i);
      let value = i < 0 ? '' : l.slice(i + 1);
      if (value[0] === ' ') value = value.slice(1);
      if (field === 'event') name = value;
      else if (field === 'data') data.push(value);
    };
    return {
      push(text) {
        buf += String(text);
        // \r\n が chunk の境目で分かれたときのために、末尾の \r は次の chunk まで残す
        let m;
        const re = /\r\n|\r(?!$)|\n/g;
        let start = 0;
        while ((m = re.exec(buf))) {
          line(buf.slice(start, m.index));
          start = m.index + m[0].length;
        }
        buf = buf.slice(start);
      },
      // ストリームの終わり。途中のイベントは捨てる（SSE の決まりどおり）
      end() {
        buf = '';
        name = '';
        data = [];
      },
    };
  }

  function memoryStorage() {
    const m = new Map();
    return {
      getItem: (k) => (m.has(k) ? m.get(k) : null),
      setItem: (k, v) => m.set(k, String(v)),
      removeItem: (k) => m.delete(k),
    };
  }

  /**
   * @param {object} opts
   * @param {string} [opts.baseUrl] 例: "https://xxx.trycloudflare.com"（空なら同じオリジン）
   * @param {Function} [opts.fetch] fetch と同じ形の関数
   * @param {object} [opts.storage] getItem / setItem / removeItem（localStorage など）
   */
  function createClient(opts = {}) {
    const baseUrl = String(opts.baseUrl || '').replace(/\/+$/, '');
    const fetchFn = opts.fetch || (typeof fetch === 'function' ? fetch.bind(globalThis) : null);
    if (!fetchFn) throw new Error('fetch がありません');
    const storage = opts.storage || memoryStorage();
    const key = opts.storageKey || DEFAULT_STORAGE_KEY;
    const now = opts.now || (() => Date.now());
    const setT = opts.setTimeout || ((fn, ms) => setTimeout(fn, ms));
    const clearT = opts.clearTimeout || ((t) => clearTimeout(t));
    const backoffMin = opts.backoffMinMs || BACKOFF_MIN_MS;
    const backoffMax = opts.backoffMaxMs || BACKOFF_MAX_MS;
    const idleTimeout = opts.idleTimeoutMs === 0 ? 0 : opts.idleTimeoutMs || IDLE_TIMEOUT_MS;
    const Decoder = opts.TextDecoder || (typeof TextDecoder !== 'undefined' ? TextDecoder : null);
    const unauthorized = new Set();

    function readAuth() {
      try {
        const v = JSON.parse(storage.getItem(key) || 'null');
        return v && typeof v.token === 'string' && v.token ? v : null;
      } catch {
        return null;
      }
    }
    function writeAuth(v) {
      try {
        storage.setItem(key, JSON.stringify(v));
      } catch {
        /* 保存できなくても、この画面のあいだは使える */
      }
      memo = v;
    }
    let memo = readAuth();
    const auth = () => memo || (memo = readAuth());

    function clearToken() {
      memo = null;
      try {
        storage.removeItem(key);
      } catch {
        /* 消せなくても先へ進む */
      }
    }
    function fireUnauthorized(err) {
      clearToken();
      for (const fn of [...unauthorized]) {
        try {
          fn(err);
        } catch {
          /* 知らせる側の失敗は無視する */
        }
      }
    }

    async function request(method, path, body, { auth: useAuth = true } = {}) {
      const headers = { Accept: 'application/json' };
      const a = auth();
      if (useAuth) {
        if (!a) {
          const err = new ApiError('not paired', 401, 'no_token');
          fireUnauthorized(err);
          throw err;
        }
        headers.Authorization = `Bearer ${a.token}`;
      }
      if (body !== undefined) headers['Content-Type'] = 'application/json';
      let res;
      try {
        res = await fetchFn(baseUrl + path, { method, headers, body: body === undefined ? undefined : JSON.stringify(body), cache: 'no-store' });
      } catch (e) {
        throw new ApiError((e && e.message) || 'network error', 0, 'network');
      }
      let json = null;
      try {
        json = await res.json();
      } catch {
        json = null;
      }
      if (res.status === 401 && useAuth) {
        const err = new ApiError((json && json.error) || 'unauthorized', 401);
        fireUnauthorized(err);
        throw err;
      }
      if (!json || typeof json !== 'object') throw new ApiError(`HTTP ${res.status}`, res.status);
      if (!res.ok || !json.ok) throw new ApiError(json.error || `HTTP ${res.status}`, res.status);
      return json.data;
    }

    async function pair(code, deviceName) {
      const data = await request('POST', '/api/v1/pair', { code: String(code || ''), deviceName: String(deviceName || '') }, { auth: false });
      if (!data || typeof data.token !== 'string' || !data.token) throw new ApiError('bad response', 0);
      writeAuth({ token: data.token, deviceId: data.deviceId || '', expiresAt: data.expiresAt || 0 });
      return data;
    }
    const session = () => request('GET', '/api/v1/session');
    const invoke = (channel, arg) => request('POST', '/api/v1/invoke', arg === undefined ? { channel } : { channel, arg });
    async function logout() {
      try {
        if (auth()) await request('POST', '/api/v1/logout', {});
      } finally {
        clearToken();
      }
    }
    // 期限が切れたトークンは持っていないものとする（サーバーでも 401 になる）
    function hasToken() {
      const a = auth();
      return !!a && !(a.expiresAt && a.expiresAt <= now());
    }
    function onUnauthorized(fn) {
      unauthorized.add(fn);
      return () => unauthorized.delete(fn);
    }

    /**
     * /api/v1/events を読み続ける。切れたら待つ時間を延ばしながら繋ぎ直す。
     * EventSource はヘッダーを付けられないので、fetch のストリームで読む。
     * @param {(name: string, data: any) => void} onEvent
     * @param {{ onOpen?: () => void, onClose?: (err?: Error) => void }} [hooks] onOpen は繋がるたび（繋ぎ直したときも）に呼ぶ
     * @returns {Function} 止める関数（.reconnect() ですぐに繋ぎ直す）
     */
    function subscribe(onEvent, hooks = {}) {
      let stopped = false;
      let attempt = 0;
      let retryTimer = null;
      let idleTimer = null;
      let ctrl = null;
      let gen = 0;

      const clearIdle = () => {
        if (idleTimer) clearT(idleTimer);
        idleTimer = null;
      };
      const abort = () => {
        try {
          if (ctrl) ctrl.abort();
        } catch {
          /* 止められなくてもよい */
        }
        ctrl = null;
      };
      const schedule = () => {
        if (stopped || retryTimer) return;
        const delay = Math.min(backoffMax, backoffMin * 2 ** attempt);
        attempt++;
        retryTimer = setT(() => {
          retryTimer = null;
          connect();
        }, delay);
      };

      async function connect() {
        if (stopped) return;
        const my = ++gen;
        const a = auth();
        if (!a) {
          stopped = true;
          fireUnauthorized(new ApiError('not paired', 401, 'no_token'));
          return;
        }
        ctrl = typeof AbortController !== 'undefined' ? new AbortController() : null;
        let closeErr;
        let reader = null;
        const kick = () => {
          // しばらく何も来ない: 回線が黙って切れている（スマホのスリープ明けなど）
          clearIdle();
          if (!idleTimeout) return;
          idleTimer = setT(() => {
            idleTimer = null;
            if (my !== gen) return;
            abort();
            try {
              if (reader && reader.cancel) reader.cancel();
            } catch {
              /* 無視 */
            }
          }, idleTimeout);
        };
        try {
          const res = await fetchFn(baseUrl + '/api/v1/events', {
            method: 'GET',
            headers: { Accept: 'text/event-stream', Authorization: `Bearer ${a.token}` },
            cache: 'no-store',
            signal: ctrl ? ctrl.signal : undefined,
          });
          if (my !== gen || stopped) return;
          if (res.status === 401) {
            let msg = 'unauthorized';
            try {
              msg = (await res.json()).error || msg;
            } catch {
              /* 本文が読めなくてもよい */
            }
            stopped = true;
            fireUnauthorized(new ApiError(msg, 401));
            return;
          }
          if (!res.ok) throw new ApiError(`HTTP ${res.status}`, res.status);
          if (!res.body || typeof res.body.getReader !== 'function' || !Decoder) throw new ApiError('streaming is not supported', 0, 'no_stream');
          reader = res.body.getReader();
          const decoder = new Decoder('utf-8');
          const parser = createSseParser((name, data) => {
            if (my !== gen || stopped) return;
            try {
              onEvent(name, data);
            } catch {
              /* 画面側の失敗で読み取りを止めない */
            }
          });
          kick();
          if (hooks.onOpen) hooks.onOpen();
          let got = false;
          for (;;) {
            const { value, done } = await reader.read();
            if (my !== gen || stopped) return;
            if (done) break;
            kick();
            // 何か届いたら、待つ時間を最初に戻す
            if (!got) {
              got = true;
              attempt = 0;
            }
            parser.push(typeof value === 'string' ? value : decoder.decode(value, { stream: true }));
          }
          parser.end();
        } catch (e) {
          closeErr = e;
        } finally {
          if (my === gen) clearIdle();
        }
        if (my !== gen || stopped) return;
        ctrl = null;
        if (hooks.onClose) {
          try {
            hooks.onClose(closeErr);
          } catch {
            /* 無視 */
          }
        }
        schedule();
      }

      const unsubscribe = () => {
        stopped = true;
        gen++;
        if (retryTimer) clearT(retryTimer);
        retryTimer = null;
        clearIdle();
        abort();
      };
      // 画面が前に戻ったときなどに、待たずに繋ぎ直す
      unsubscribe.reconnect = () => {
        if (stopped) return;
        if (retryTimer) clearT(retryTimer);
        retryTimer = null;
        clearIdle();
        abort();
        attempt = 0;
        connect();
      };
      connect();
      return unsubscribe;
    }

    return {
      pair,
      session,
      invoke,
      subscribe,
      logout,
      hasToken,
      onUnauthorized,
      clearToken,
      auth: () => (auth() ? { ...auth() } : null),
    };
  }

  return { createClient, createSseParser, deviceNameFromUA, ApiError, DEFAULT_STORAGE_KEY, BACKOFF_MIN_MS, BACKOFF_MAX_MS, IDLE_TIMEOUT_MS };
});
