// 進捗の見える化: エージェントをピクセルアートのロボットにして、Canvas で動かす
// - ボードのカード（mini）: 机でタイピングするロボットと、TODO のマスの進捗バー
// - 「進捗」タブ（stage）: TODO の旗が並ぶ道をロボットが進み、ゴールで跳ねる
// 画面の言葉はレンダラ（renderer.js）が tr() で作って info.label などで渡す。ここには言葉を持たない
// レンダラ（<script> で読み込む）とテスト（require）の両方から使う。
(function (root, factory) {
  const api = factory();
  if (typeof module === 'object' && module.exports) module.exports = api;
  else root.AgentSprite = api;
})(typeof self !== 'undefined' ? self : this, function () {
  // エージェントごとのロボットの色（カスタムエージェントは、その色を使う）
  const AGENT_COLORS = {
    claude: '#d97757',
    codex: '#10a37f',
    agy: '#4285f4',
    gemini: '#5b8def',
    cursor: '#a0a8ba',
    opencode: '#f5a524',
    copilot: '#8957e5',
    amp: '#ff6b6b',
    pi: '#22b8cf',
    droid: '#e6b422',
  };
  const HEX = /^#([0-9a-f]{6})$/i;
  function colorFor(agent, persona) {
    if (persona && typeof persona.color === 'string' && HEX.test(persona.color)) return persona.color;
    return AGENT_COLORS[agent] || AGENT_COLORS.claude;
  }

  // キャラクターの種類と色。タスクを作ったときに randomCharacter() で決めて、カードの character に残す
  // （開き直しても同じキャラクターになる）。character のない前からのタスクは、エージェントの色のロボットのまま
  const CHARACTER_KINDS = ['robot', 'cat', 'ghost', 'slime', 'bear', 'penguin', 'alien', 'frog'];
  const CHARACTER_COLORS = ['#d97757', '#10a37f', '#4285f4', '#8957e5', '#ff6b6b', '#22b8cf', '#e6b422', '#f5a524', '#ec4899', '#84cc16', '#a0a8ba', '#14b8a6'];
  function randomCharacter(rand = Math.random) {
    const pick = (list) => list[Math.min(list.length - 1, Math.floor(rand() * list.length))];
    return { kind: pick(CHARACTER_KINDS), color: pick(CHARACTER_COLORS) };
  }
  // カードから、描くキャラクターを決める。カスタムエージェントの色は、選んだ色をそのまま使う
  function characterFor({ agent, persona, character } = {}) {
    const ch = character && typeof character === 'object' ? character : {};
    const kind = CHARACTER_KINDS.includes(ch.kind) ? ch.kind : 'robot';
    const own = persona && typeof persona.color === 'string' && HEX.test(persona.color);
    const color = own ? persona.color : typeof ch.color === 'string' && HEX.test(ch.color) ? ch.color : colorFor(agent);
    return { kind, color };
  }

  // ツールの名前から、吹き出しに出す作業の種類を決める（CLI ごとに名前が違うので、名前の一部で見る）
  function toolKind(name) {
    const n = String(name || '').toLowerCase();
    if (!n) return 'tool';
    if (/todo|plan/.test(n)) return 'plan';
    if (/web|fetch|browse|http|url/.test(n)) return 'web';
    if (/edit|write|patch|replace|create|notebook|insert/.test(n)) return 'edit';
    if (/bash|shell|exec|command|terminal|^run/.test(n)) return 'run';
    if (/grep|glob|search|find|^ls$|list/.test(n)) return 'search';
    if (/read|view|cat|open/.test(n)) return 'read';
    if (/task|agent/.test(n)) return 'agent';
    return 'tool';
  }

  // ロボットの様子
  // - attention: 'perm'（承認待ち）/ 'ask'（質問・回答待ちなど、あなたの操作を待っている）/ null
  // - activity: { kind: 'tool' | 'text', name, at }（最後のツールの呼び出し・返事）。今回の実行より前のものは使わない
  function moodOf({ status, attention, activity, startedAt, orchestrating } = {}) {
    if (attention === 'perm') return { mood: 'wait', tool: 'perm' };
    if (attention) return { mood: 'wait', tool: 'ask' };
    if (orchestrating) return { mood: 'work', tool: 'agent' };
    if (status === 'running') {
      const fresh = activity && (!startedAt || Number(activity.at) >= Number(startedAt));
      if (fresh && activity.kind === 'tool') return { mood: 'work', tool: toolKind(activity.name) };
      return { mood: 'think', tool: null };
    }
    if (status === 'queued') return { mood: 'queued', tool: null };
    // レビューはゴールではなく、あなたの確認待ち
    if (status === 'review') return { mood: 'wait', tool: 'review' };
    if (status === 'done') return { mood: 'done', tool: null };
    if (status === 'failed') return { mood: 'fail', tool: null };
    return { mood: 'idle', tool: null };
  }

  // TODO の進み具合（取りやめは数えない）。cur は今の TODO（作業中、なければ次にやるもの）
  function progressOf(items) {
    const list = (Array.isArray(items) ? items : []).filter((t) => t && t.status !== 'cancelled');
    const statuses = list.map((t) => t.status);
    const done = statuses.filter((s) => s === 'completed').length;
    let cur = statuses.indexOf('in_progress');
    if (cur < 0) cur = statuses.indexOf('pending');
    if (cur < 0) cur = list.length;
    const now = list[cur] && list[cur].text ? String(list[cur].text) : '';
    return { total: list.length, done, cur, statuses, now, pct: list.length ? Math.round((done / list.length) * 100) : 0 };
  }

  // ---------- 描く ----------
  function shade(hex, f) {
    const m = HEX.exec(hex);
    if (!m) return hex;
    const v = parseInt(m[1], 16);
    const ch = [(v >> 16) & 255, (v >> 8) & 255, v & 255].map((c) => Math.round(f >= 0 ? c + (255 - c) * f : c * (1 + f)));
    return `#${ch.map((c) => Math.max(0, Math.min(255, c)).toString(16).padStart(2, '0')).join('')}`;
  }
  // 1マス u（CSS の px）で、整数のマスに四角を描く
  function grid(ctx, u, ox, oy) {
    return (x, y, w, h, color) => {
      ctx.fillStyle = color;
      ctx.fillRect(Math.round(ox + x * u), Math.round(oy + y * u), Math.ceil(w * u), Math.ceil(h * u));
    };
  }
  const ICONS = {
    edit: ['...##', '..###', '.###.', '###..', '##...'],
    read: ['.###.', '#...#', '#.#.#', '#...#', '.###.'],
    run: ['#....', '.#...', '#....', '.....', '..###'],
    search: ['.##..', '#..#.', '#..#.', '.##..', '...##'],
    web: ['.###.', '#.#.#', '#####', '#.#.#', '.###.'],
    plan: ['#.###', '.....', '#.###', '.....', '#.###'],
    agent: ['##.##', '##.##', '.....', '#####', '#####'],
    tool: ['.#.#.', '#####', '.#.#.', '#####', '.#.#.'],
    ask: ['.###.', '#...#', '...#.', '.....', '..#..'],
    perm: ['..#..', '..#..', '..#..', '.....', '..#..'],
    review: ['.##..', '#..#.', '#..#.', '.###.', '...##'],
    done: ['..#..', '.###.', '#####', '.###.', '.#.#.'],
    fail: ['#...#', '.#.#.', '..#..', '.#.#.', '#...#'],
    queued: ['#####', '.###.', '..#..', '.###.', '#####'],
  };
  function drawIcon(r, x, y, name, color) {
    const rows = ICONS[name] || ICONS.tool;
    rows.forEach((row, j) => {
      for (let i = 0; i < row.length; i++) if (row[i] === '#') r(x + i, y + j, 1, 1, color);
    });
  }
  function iconColor(name, th) {
    if (name === 'perm' || name === 'ask' || name === 'review' || name === 'queued') return th.warn;
    if (name === 'done') return th.ok;
    if (name === 'fail') return th.err;
    if (name === 'edit') return th.ok;
    if (name === 'run') return th.run;
    if (name === 'web' || name === 'search') return th.accent;
    return th.text;
  }

  // ロボット（9マス × 11マス。左上が x, y）
  function drawBot(r, x, y, color, mood, f, th, { walking = false } = {}) {
    const dark = shade(color, -0.35);
    const light = shade(color, 0.35);
    const face = '#1b1e27';
    const R = (a, b, w, h, c) => r(x + a, y + b, w, h, c);
    // アンテナ（待っているときは点滅）
    const tip = mood === 'wait' ? (f % 4 < 2 ? th.warn : light) : mood === 'work' ? (f % 6 < 3 ? th.run : light) : light;
    R(4, 1, 1, 1, dark);
    R(4, 0, 1, 1, tip);
    // 頭
    R(1, 2, 7, 5, color);
    R(1, 2, 7, 1, light);
    R(2, 3, 5, 3, face);
    // 目
    const blink = f % 37 === 0;
    const eye = mood === 'fail' ? th.err : mood === 'done' ? th.ok : '#7fdcff';
    if (mood === 'idle' || mood === 'queued' || blink) {
      R(3, 5, 1, 1, '#5b6275');
      R(5, 5, 1, 1, '#5b6275');
    } else if (mood === 'think') {
      const dx = f % 16 < 8 ? 0 : 1;
      R(2 + dx + 1, 3, 1, 1, eye);
      R(4 + dx + 1, 3, 1, 1, eye);
    } else if (mood === 'done') {
      R(3, 4, 1, 1, eye);
      R(5, 4, 1, 1, eye);
      R(3, 5, 3, 1, th.ok);
    } else {
      R(3, 4, 1, 1, eye);
      R(5, 4, 1, 1, eye);
    }
    // 体
    R(2, 7, 5, 3, dark);
    R(3, 8, 3, 1, mood === 'work' ? (f % 4 < 2 ? th.run : light) : light);
    // 腕
    if (mood === 'work') {
      R(0, 7 + (f % 2), 2, 1, color);
      R(7, 8 - (f % 2), 2, 1, color);
    } else if (mood === 'wait') {
      R(1, 7, 1, 2, color);
      R(7, 2 + (f % 4 < 2 ? 0 : 1), 1, 5, color);
      R(7, 1 + (f % 4 < 2 ? 0 : 1), 2, 1, light);
    } else if (mood === 'done') {
      R(0, 3, 1, 4, color);
      R(8, 3, 1, 4, color);
    } else {
      R(1, 7, 1, 2, color);
      R(7, 7, 1, 2, color);
    }
    // 足（歩いているときは交互に動かす）
    if (walking) {
      R(f % 2 ? 2 : 3, 10, 1, 1, dark);
      R(f % 2 ? 6 : 5, 10, 1, 1, dark);
    } else {
      R(3, 10, 1, 1, dark);
      R(5, 10, 1, 1, dark);
    }
  }
  // ロボット以外のキャラクター（9マス × 11マス。左上が x, y）。目・腕・足の動きはロボットと同じ決まりで動かす
  const INK = '#1b1e27';
  function drawEyes(R, mood, f, th, { ex = [3, 5], ey = 4, color = INK } = {}) {
    const blink = f % 37 === 0;
    const eye = mood === 'fail' ? th.err : color;
    if (mood === 'idle' || mood === 'queued' || blink) {
      for (const x of ex) R(x, ey, 1, 1, '#5b6275');
    } else if (mood === 'think') {
      const dx = f % 16 < 8 ? 0 : 1;
      for (const x of ex) R(x + dx, ey, 1, 1, eye); // 考え中は、目を左右に動かす
    } else if (mood === 'done') {
      for (const x of ex) R(x, ey, 1, 1, eye);
      R(ex[0], ey + 1, ex[1] - ex[0] + 1, 1, th.ok);
    } else {
      for (const x of ex) R(x, ey, 1, 1, eye);
    }
  }
  function drawArms(R, mood, f, color, light, { top = 7 } = {}) {
    if (mood === 'work') {
      R(0, top + (f % 2), 2, 1, color);
      R(7, top + 1 - (f % 2), 2, 1, color);
    } else if (mood === 'wait') {
      R(1, top, 1, 2, color);
      R(7, top - 5 + (f % 4 < 2 ? 0 : 1), 1, 5, color);
      R(7, top - 6 + (f % 4 < 2 ? 0 : 1), 2, 1, light);
    } else if (mood === 'done') {
      R(0, top - 4, 1, 4, color);
      R(8, top - 4, 1, 4, color);
    } else {
      R(1, top, 1, 2, color);
      R(7, top, 1, 2, color);
    }
  }
  function drawFeet(R, walking, f, color, { left = 3, right = 5, w = 1 } = {}) {
    if (walking) {
      R(f % 2 ? left - 1 : left, 10, w, 1, color);
      R(f % 2 ? right + 1 : right, 10, w, 1, color);
    } else {
      R(left, 10, w, 1, color);
      R(right, 10, w, 1, color);
    }
  }
  const CHARACTERS = {
    cat(R, c, dark, light, mood, f, th, walking) {
      R(1, 1, 2, 2, c);
      R(6, 1, 2, 2, c);
      R(2, 2, 1, 1, '#f49ac1');
      R(6, 2, 1, 1, '#f49ac1');
      R(1, 2, 7, 5, c);
      R(3, 5, 3, 1, light);
      R(4, 5, 1, 1, '#f49ac1');
      drawEyes(R, mood, f, th);
      R(2, 7, 5, 3, c);
      R(3, 8, 3, 2, light);
      // しっぽ（ゆらゆら）
      R(7, 9, 1, 1, c);
      R(8, f % 8 < 4 ? 7 : 8, 1, 2, c);
      drawArms(R, mood, f, dark, light);
      drawFeet(R, walking, f, dark);
    },
    ghost(R, c, dark, light, mood, f, th) {
      R(2, 1, 5, 1, c);
      R(1, 2, 7, 8, c);
      R(2, 2, 2, 1, light);
      // すそ（波打つ）
      for (let i = 1; i < 8; i++) if ((i + (f >> 1)) % 2 === 0) R(i, 10, 1, 1, c);
      drawEyes(R, mood, f, th);
      if (mood === 'fail' || mood === 'wait') R(4, 6, 1, 1, INK);
      drawArms(R, mood, f, c, light);
    },
    slime(R, c, dark, light, mood, f, th) {
      // ぷるぷる（作業中は上下に伸び縮みする）
      const sq = mood === 'work' && f % 4 < 2 ? 1 : 0;
      R(3, 4 + sq, 3, 1, c);
      R(2, 5 + sq, 5, 1, c);
      R(1, 6 + sq, 7, 4 - sq, c);
      R(0, 8, 9, 2, c);
      R(0, 10, 9, 1, dark);
      R(2, 6 + sq, 1, 1, light);
      R(3, 5 + sq, 1, 1, light);
      drawEyes(R, mood, f, th, { ey: 7 + sq });
      if (mood === 'wait') R(8, 4 + (f % 4 < 2 ? 0 : 1), 1, 3, light);
    },
    bear(R, c, dark, light, mood, f, th, walking) {
      R(1, 1, 2, 2, c);
      R(6, 1, 2, 2, c);
      R(1, 1, 1, 1, dark);
      R(7, 1, 1, 1, dark);
      R(1, 2, 7, 5, c);
      R(3, 5, 3, 2, light);
      R(4, 5, 1, 1, INK);
      drawEyes(R, mood, f, th);
      R(2, 7, 5, 3, c);
      R(3, 8, 3, 2, light);
      drawArms(R, mood, f, dark, light);
      drawFeet(R, walking, f, dark);
    },
    penguin(R, c, dark, light, mood, f, th, walking) {
      R(2, 1, 5, 1, c);
      R(1, 2, 7, 8, c);
      R(2, 3, 5, 7, '#f4f4f4');
      R(4, 5, 1, 1, '#f5a524');
      drawEyes(R, mood, f, th);
      drawArms(R, mood, f, dark, light);
      drawFeet(R, walking, f, '#f5a524', { left: 2, right: 5, w: 2 });
    },
    alien(R, c, dark, light, mood, f, th, walking) {
      const glow = mood === 'wait' ? (f % 4 < 2 ? th.warn : light) : mood === 'work' ? (f % 6 < 3 ? th.run : light) : light;
      R(2, 1, 1, 2, dark);
      R(6, 1, 1, 2, dark);
      R(2, 0, 1, 1, glow);
      R(6, 0, 1, 1, glow);
      R(1, 2, 7, 5, c);
      R(0, 3, 9, 3, c);
      R(2, 3, 2, 2, INK);
      R(5, 3, 2, 2, INK);
      drawEyes(R, mood, f, th, { ex: [3, 5], ey: 3, color: '#b6ff8a' });
      R(3, 7, 3, 3, c);
      R(4, 8, 1, 1, light);
      drawArms(R, mood, f, dark, light);
      drawFeet(R, walking, f, dark);
    },
    frog(R, c, dark, light, mood, f, th, walking) {
      R(1, 2, 3, 2, c);
      R(5, 2, 3, 2, c);
      R(2, 2, 1, 1, '#f4f4f4');
      R(6, 2, 1, 1, '#f4f4f4');
      R(1, 4, 7, 3, c);
      R(2, 6, 5, 1, dark);
      drawEyes(R, mood, f, th, { ex: [2, 6], ey: 3 });
      R(2, 7, 5, 3, c);
      R(3, 8, 3, 2, light);
      drawArms(R, mood, f, c, light);
      drawFeet(R, walking, f, dark, { left: 2, right: 5, w: 2 });
    },
  };
  // キャラクターを描く（kind がロボットか知らない種類なら、今までのロボット）
  function drawCharacter(r, x, y, kind, color, mood, f, th, opts = {}) {
    const draw = CHARACTERS[kind];
    if (!draw) return drawBot(r, x, y, color, mood, f, th, opts);
    const R = (a, b, w, h, c) => r(x + a, y + b, w, h, c);
    draw(R, color, shade(color, -0.35), shade(color, 0.35), mood, f, th, !!opts.walking);
  }

  // 吹き出し（9 × 7 マス。しっぽは左下）
  function drawBubble(r, x, y, mood, tool, f, th) {
    r(x, y, 9, 7, th.line);
    r(x + 1, y + 1, 7, 5, th.panel);
    r(x + 1, y + 7, 2, 1, th.line);
    if (mood === 'think') {
      for (let i = 0; i < 3; i++) r(x + 2 + i * 2, y + 3, 1, 1, Math.floor(f / 3) % 4 > i ? th.text : th.line);
      return;
    }
    if (mood === 'idle') {
      const k = f % 12 < 6;
      r(x + 2, y + 2, 3, 1, th.muted);
      r(x + 3, y + 3, 1, 1, th.muted);
      r(x + 2, y + 4, 3, 1, th.muted);
      if (k) r(x + 6, y + 2, 1, 1, th.muted);
      return;
    }
    const name = mood === 'work' ? tool || 'tool' : mood === 'wait' ? tool || 'ask' : mood;
    if (mood === 'wait' && f % 4 >= 3) return; // 点滅
    drawIcon(r, x + 2, y + 1, name, iconColor(name, th));
  }

  // 粒（TODO が終わったときの光・ゴールの紙吹雪）。座標は CSS の px
  function burst(m, x, y, colors, n = 14, spread = 2.4) {
    for (let i = 0; i < n; i++) {
      const a = (Math.PI * 2 * i) / n + Math.random() * 0.4;
      const s = spread * (0.5 + Math.random());
      m.parts.push({ x, y, vx: Math.cos(a) * s, vy: Math.sin(a) * s - 1.4, life: 18 + Math.random() * 10, c: colors[i % colors.length], sz: 2 });
    }
  }
  function stepParts(ctx, m) {
    m.parts = m.parts.filter((p) => p.life > 0);
    for (const p of m.parts) {
      p.x += p.vx;
      p.y += p.vy;
      p.vy += 0.18;
      p.life -= 1;
      ctx.globalAlpha = Math.max(0, Math.min(1, p.life / 10));
      ctx.fillStyle = p.c;
      ctx.fillRect(Math.round(p.x), Math.round(p.y), p.sz, p.sz);
    }
    ctx.globalAlpha = 1;
  }

  function fitText(ctx, text, max) {
    const s = String(text || '');
    if (max <= 0) return '';
    if (ctx.measureText(s).width <= max) return s;
    let lo = 0;
    let hi = s.length;
    while (lo < hi) {
      const mid = (lo + hi + 1) >> 1;
      if (ctx.measureText(`${s.slice(0, mid)}…`).width <= max) lo = mid;
      else hi = mid - 1;
    }
    return `${s.slice(0, lo)}…`;
  }
  const FONT = "-apple-system, BlinkMacSystemFont, 'Segoe UI', 'Hiragino Sans', 'Noto Sans JP', sans-serif";

  // TODO のマスの進捗バー（作業中のマスは点滅、終わったマスは緑）。マスがないときは、動いている間だけ流れる帯
  function drawSegments(ctx, x, y, w, h, info, f, th, m) {
    const p = info.progress;
    ctx.fillStyle = th.line;
    if (!p.total) {
      ctx.fillRect(x, y, w, h);
      if (info.mood === 'work' || info.mood === 'think') {
        const bw = Math.max(12, w * 0.22);
        const pos = ((f * 3) % (w + bw)) - bw;
        ctx.fillStyle = th.run;
        ctx.fillRect(Math.max(x, x + pos), y, Math.min(bw, w - Math.max(0, pos), bw + pos), h);
      } else if (info.mood === 'done') {
        ctx.fillStyle = th.ok;
        ctx.fillRect(x, y, w, h);
      }
      return [];
    }
    const gap = p.total > 24 ? 1 : 2;
    const sw = Math.max(1, (w - gap * (p.total - 1)) / p.total);
    const centers = [];
    p.statuses.forEach((s, i) => {
      const sx = Math.round(x + i * (sw + gap));
      const ww = Math.max(1, Math.round(x + i * (sw + gap) + sw) - sx);
      let c = th.line;
      if (s === 'completed') c = th.ok;
      else if (s === 'in_progress') c = f % 6 < 3 ? th.warn : shade(th.warn, -0.25);
      ctx.fillStyle = c;
      ctx.fillRect(sx, y, ww, h);
      if (s === 'completed') {
        ctx.fillStyle = shade(th.ok, 0.4);
        ctx.fillRect(sx, y, ww, 1);
      }
      centers.push(sx + ww / 2);
    });
    // 終わったマスがキラッと光る
    if (m && !info.still && p.done && f % 24 < 2) {
      const i = Math.floor(f / 24) % p.done;
      const idx = p.statuses.reduce((acc, s, k) => (s === 'completed' ? acc.concat(k) : acc), [])[i];
      if (idx != null) {
        ctx.fillStyle = '#ffffff';
        ctx.fillRect(Math.round(centers[idx]) - 1, y, 2, h);
      }
    }
    return centers;
  }

  // ボードのカード（高さ 36px ほど）
  function drawMini(ctx, w, h, info, m, f, th) {
    const u = 2;
    const r = grid(ctx, u, 0, Math.round((h - 18 * u) / 2));
    ctx.clearRect(0, 0, w, h);
    const mood = info.mood;
    const jump = mood === 'done' && !info.still ? [0, 1, 2, 2, 1, 0, 0, 0][f % 8] : 0;
    // 机とモニター
    r(10, 13, 11, 1, th.muted);
    r(11, 14, 1, 3, th.muted);
    r(19, 14, 1, 3, th.muted);
    r(13, 8, 7, 5, th.line);
    const screen = mood === 'fail' ? shade(th.err, -0.5) : mood === 'idle' || mood === 'queued' ? '#11141b' : '#0b1a2a';
    r(14, 9, 5, 3, screen);
    if (mood === 'work') {
      for (let j = 0; j < 3; j++) {
        const len = 1 + ((f + j * 3) % 4);
        r(14, 9 + j, Math.min(5, len), 1, j === (f % 3) ? th.ok : th.run);
      }
    } else if (mood === 'done') r(15, 10, 3, 1, th.ok);
    else if (mood === 'wait') {
      if (f % 4 < 2) r(16, 9, 1, 3, th.warn);
    }
    r(10, 12, 3, 1, th.text); // キーボード
    drawCharacter(r, 1, 6 - jump, info.kind, info.color, mood, f, th);
    drawBubble(r, 11, -0.5, mood, info.tool, f, th);
    // 右側: 今の作業と、TODO のマス
    const x0 = 24 * u + 6;
    const tw = w - x0 - 4;
    if (tw < 30) return;
    ctx.textBaseline = 'alphabetic';
    const p = info.progress;
    const count = p.total ? `${p.done}/${p.total}` : '';
    ctx.font = `600 10px ${FONT}`;
    const cw = count ? ctx.measureText(count).width + 6 : 0;
    ctx.fillStyle = mood === 'wait' ? th.warn : mood === 'fail' ? th.err : mood === 'done' ? th.ok : th.text;
    ctx.font = `600 11px ${FONT}`;
    ctx.fillText(fitText(ctx, info.label, tw), x0, h / 2 - 3);
    const by = Math.round(h / 2 + 3);
    const centers = drawSegments(ctx, x0, by, tw - cw, 6, info, f, th, m);
    if (count) {
      ctx.font = `600 10px ${FONT}`;
      ctx.fillStyle = th.muted;
      ctx.fillText(count, w - 4 - ctx.measureText(count).width, by + 6);
    }
    // TODO が終わったら、そのマスから光が飛ぶ
    if (m.lastDone != null && p.done > m.lastDone && !info.still) {
      const i = p.statuses.lastIndexOf('completed');
      if (centers[i] != null) burst(m, centers[i], by + 3, [th.ok, th.warn, '#ffffff'], 10, 1.8);
    }
    m.lastDone = p.done;
    stepParts(ctx, m);
  }

  // 「進捗」タブ（高さ 150px ほど）: TODO の旗が並ぶ道をロボットが進む
  function drawStage(ctx, w, h, info, m, f, th) {
    ctx.clearRect(0, 0, w, h);
    const u = 4;
    const mood = info.mood;
    const p = info.progress;
    const groundY = h - 26;
    // 空と遠くの山（ゆっくり流れる）
    const sky = ctx.createLinearGradient(0, 0, 0, groundY);
    sky.addColorStop(0, th.panel2);
    sky.addColorStop(1, th.panel);
    ctx.fillStyle = sky;
    ctx.fillRect(0, 0, w, groundY);
    for (let i = 0; i < 24; i++) {
      const sx = (i * 97 + 13) % Math.max(1, w);
      const sy = 8 + ((i * 53) % Math.max(1, groundY - 40));
      if ((f + i * 5) % 30 < 20) {
        ctx.fillStyle = th.line;
        ctx.fillRect(sx, sy, 2, 2);
      }
    }
    const drift = info.still ? 0 : (f * 0.5) % 120;
    ctx.fillStyle = shade(th.line, 0);
    for (let x = -120; x < w + 120; x += 120) {
      const hx = Math.round(x - drift);
      for (let s = 0; s < 6; s++) ctx.fillRect(hx + s * 10, groundY - 8 - s * 4, 120 - s * 20, 4);
    }
    // 地面と道
    ctx.fillStyle = th.panel2;
    ctx.fillRect(0, groundY, w, h - groundY);
    ctx.fillStyle = th.line;
    ctx.fillRect(0, groundY, w, 2);
    const xs = 30;
    const xe = w - 34;
    const span = Math.max(1, xe - xs);
    for (let x = xs; x < xe; x += 12) {
      ctx.fillStyle = th.muted;
      ctx.fillRect(x, groundY + 9, 6, 2);
    }
    // TODO の旗（終わった: 緑の旗がはためく / 作業中: 黄色が点滅 / これから: 柱だけ）
    const n = p.total;
    const at = (i) => xs + ((i + 0.5) * span) / Math.max(1, n);
    for (let i = 0; i < n; i++) {
      const fx = Math.round(at(i));
      const s = p.statuses[i];
      ctx.fillStyle = th.muted;
      ctx.fillRect(fx, groundY - 26, 2, 26);
      if (s === 'completed') {
        const wave = info.still ? 0 : f % 6 < 3 ? 0 : 1;
        ctx.fillStyle = th.ok;
        ctx.fillRect(fx + 2, groundY - 26, 12, 4);
        ctx.fillRect(fx + 2, groundY - 22, 12 - wave * 2, 4);
        ctx.fillStyle = shade(th.ok, 0.4);
        ctx.fillRect(fx + 2, groundY - 26, 12, 1);
      } else if (s === 'in_progress') {
        ctx.fillStyle = f % 6 < 4 || info.still ? th.warn : shade(th.warn, -0.3);
        ctx.fillRect(fx + 2, groundY - 26, 10, 7);
      } else {
        ctx.fillStyle = th.line;
        ctx.fillRect(fx + 2, groundY - 26, 6, 4);
      }
      ctx.font = `600 9px ${FONT}`;
      ctx.fillStyle = s === 'completed' ? th.ok : s === 'in_progress' ? th.warn : th.muted;
      const num = String(i + 1);
      if (n <= 20 || i % Math.ceil(n / 20) === 0) ctx.fillText(num, fx + 1 - ctx.measureText(num).width / 2, groundY + 22);
    }
    // ゴール（チェッカーフラッグ）
    const gx = xe + 6;
    ctx.fillStyle = th.muted;
    ctx.fillRect(gx, groundY - 34, 2, 34);
    for (let j = 0; j < 3; j++) for (let i = 0; i < 4; i++) {
      ctx.fillStyle = (i + j) % 2 ? th.text : th.panel;
      ctx.fillRect(gx + 2 + i * 4, groundY - 34 + j * 4, 4, 4);
    }
    // ロボットの行き先: 今の TODO の旗の手前（終わったらゴール、TODO がなければ道の途中）
    // レビュー（あなたの確認待ち）では、ゴールの手前で待つ
    const reviewing = mood === 'wait' && info.tool === 'review';
    const allDone = !reviewing && (mood === 'done' || (n > 0 && p.done === n));
    let target;
    if (reviewing) target = gx - 22 * u;
    else if (allDone) target = gx - 12 * u;
    else if (n) target = at(Math.min(p.cur, n - 1)) - 10 * u;
    else target = mood === 'idle' ? xs - 10 : xs + span * 0.45;
    target = Math.max(4, target);
    if (m.x == null || info.still) m.x = target;
    const dx = target - m.x;
    m.x += Math.abs(dx) < 1 ? dx : Math.sign(dx) * Math.min(Math.abs(dx), 3 + Math.abs(dx) * 0.06);
    const walking = Math.abs(dx) >= 1;
    const jump = allDone && !info.still && !walking ? [0, 2, 4, 5, 4, 2, 0, 0, 0, 0][f % 10] : 0;
    const bx = Math.round(m.x);
    const by = groundY - 11 * u - jump;
    const r = grid(ctx, u, bx, by);
    // 影
    ctx.fillStyle = th.line;
    ctx.fillRect(bx + u * 2, groundY - 2, u * 5, 2);
    drawCharacter(r, 0, 0, info.kind, info.color, walking ? 'work' : mood, f, th, { walking });
    // 作業中: 前に箱を組み立てていて、火花が出る
    if (!walking && mood === 'work') {
      const hx = bx + 10 * u;
      ctx.fillStyle = th.muted;
      ctx.fillRect(hx, groundY - 12, 12, 12);
      ctx.fillStyle = th.panel2;
      ctx.fillRect(hx + 2, groundY - 10, 8, 8);
      if (!info.still && f % 3 === 0) burst(m, hx + 2, groundY - 12, [th.warn, '#ffffff'], 3, 1.2);
    }
    // 失敗: 頭の上に雨雲
    if (mood === 'fail') {
      ctx.fillStyle = th.muted;
      ctx.fillRect(bx, by - 18, 28, 8);
      ctx.fillRect(bx + 4, by - 22, 16, 4);
      ctx.fillStyle = th.run;
      for (let i = 0; i < 4; i++) ctx.fillRect(bx + 3 + i * 7, by - 8 + ((f + i * 2) % 6), 1, 3);
    }
    // 吹き出しと今の作業
    if (mood !== 'fail') {
      // 右の端では、吹き出しを左に出す
      const left = bx + 18 * u > w;
      const rb = grid(ctx, u, left ? bx - 8 * u : bx + 9 * u, by - 9 * u);
      drawBubble(rb, 0, 0, walking ? 'work' : mood, walking ? null : info.tool, f, th);
      if (walking) drawIcon(rb, 2, 1, 'run', th.run);
    }
    // 上: 今の様子・今の TODO・割合
    ctx.textBaseline = 'alphabetic';
    ctx.font = `700 22px ${FONT}`;
    const pct = n ? `${p.pct}%` : '';
    const pw = pct ? ctx.measureText(pct).width : 0;
    if (pct) {
      ctx.fillStyle = allDone ? th.ok : th.text;
      ctx.fillText(pct, w - 12 - pw, 28);
    }
    ctx.font = `700 13px ${FONT}`;
    ctx.fillStyle = mood === 'wait' ? th.warn : mood === 'fail' ? th.err : mood === 'done' ? th.ok : th.text;
    const head = n ? `${info.label}  ·  ${p.done}/${n}` : info.label;
    ctx.fillText(fitText(ctx, head, w - 36 - pw), 12, 20);
    if (info.detail) {
      ctx.font = `12px ${FONT}`;
      ctx.fillStyle = th.muted;
      ctx.fillText(fitText(ctx, info.detail, w - 36 - pw), 12, 38);
    }
    // TODO が終わった旗から光、全部終わったら紙吹雪
    if (m.lastDone != null && p.done > m.lastDone && !info.still) {
      const i = p.statuses.lastIndexOf('completed');
      if (i >= 0) burst(m, at(i) + 8, groundY - 24, [th.ok, th.warn, th.accent, '#ffffff'], 18, 2.6);
    }
    if (m.lastMood != null && m.lastMood !== 'done' && mood === 'done' && !info.still) confetti(m, w, th);
    if (allDone && !info.still && f % 20 === 0) confetti(m, w, th, 6);
    m.lastDone = p.done;
    m.lastMood = mood;
    stepParts(ctx, m);
  }
  function confetti(m, w, th, n = 40) {
    const colors = [th.ok, th.warn, th.accent, th.err, th.run];
    for (let i = 0; i < n; i++) m.parts.push({ x: Math.random() * w, y: -4 - Math.random() * 30, vx: (Math.random() - 0.5) * 1.2, vy: 0.5 + Math.random(), life: 50 + Math.random() * 30, c: colors[i % colors.length], sz: 3 });
  }

  // ---------- 動かす ----------
  // カードごとの動きの記憶（ボードを描き直して Canvas が作り直されても、位置や光を引き継ぐ）
  const memory = new Map();
  function memo(key) {
    let m = memory.get(key);
    if (!m) memory.set(key, (m = { x: null, lastDone: null, lastMood: null, parts: [] }));
    return m;
  }
  let theme = null;
  let themeAt = 0;
  function readTheme() {
    const now = Date.now();
    if (theme && now - themeAt < 2000) return theme;
    const cs = getComputedStyle(document.documentElement);
    const v = (k, d) => (cs.getPropertyValue(k) || '').trim() || d;
    theme = {
      panel: v('--panel', '#161922'),
      panel2: v('--panel-2', '#1d212c'),
      line: v('--line', '#2a2f3c'),
      text: v('--text', '#e6e8ee'),
      muted: v('--muted', '#8b92a5'),
      accent: v('--accent', '#6d8bff'),
      ok: v('--ok', '#3ccf8e'),
      warn: v('--warn', '#ffb547'),
      err: v('--err', '#ff6b6b'),
      run: v('--run', '#4fb8ff'),
    };
    themeAt = now;
    return theme;
  }
  const FRAME_MS = 90; // ピクセルアートらしく、コマ送りくらいの速さで描く
  let source = null;
  let frame = 0;
  let reduce = null;
  // 画面に出ている Canvas をすべて描く。advance: コマを進める（false は、描き直したばかりの Canvas を同じコマで埋めるだけ）
  function paint(advance) {
    if (!source) return;
    if (advance) frame++;
    const still = !!(reduce && reduce.matches);
    const list = document.querySelectorAll('canvas.agent-sprite[data-id]');
    if (!list.length) return;
    const th = readTheme();
    const vh = window.innerHeight;
    const vw = window.innerWidth;
    const seen = new Set();
    for (const cv of list) {
      const key = `${cv.dataset.id}:${cv.dataset.sprite}`;
      seen.add(key);
      // 同じコマで描き直すときは、もう描いてある Canvas は飛ばす（粒を二重に動かさない）
      if (!advance && cv.dataset.painted) continue;
      const rect = cv.getBoundingClientRect();
      if (!rect.width || !rect.height || rect.bottom < 0 || rect.top > vh || rect.right < 0 || rect.left > vw) continue;
      const info = source(cv.dataset.id);
      if (!info) continue;
      info.still = still;
      const dpr = window.devicePixelRatio || 1;
      const W = Math.round(rect.width * dpr);
      const H = Math.round(rect.height * dpr);
      if (cv.width !== W || cv.height !== H) {
        cv.width = W;
        cv.height = H;
      }
      const ctx = cv.getContext('2d');
      ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
      const f = still ? 1 : frame;
      if (cv.dataset.sprite === 'stage') drawStage(ctx, rect.width, rect.height, info, memo(key), f, th);
      else drawMini(ctx, rect.width, rect.height, info, memo(key), f, th);
      cv.dataset.painted = '1';
    }
    // 画面から消えたカードの記憶は捨てる（たまに見る）
    if (advance && frame % 200 === 0) for (const k of memory.keys()) if (!seen.has(k)) memory.delete(k);
  }
  // getInfo(id) → { mood, tool, label, detail, color, progress }（なければ描かない）
  function start(getInfo) {
    if (source || typeof window === 'undefined') return;
    source = getInfo;
    reduce = window.matchMedia ? window.matchMedia('(prefers-reduced-motion: reduce)') : null;
    let last = 0;
    const tick = (t) => {
      requestAnimationFrame(tick);
      if (document.hidden || t - last < FRAME_MS) return;
      last = t;
      paint(true);
    };
    requestAnimationFrame(tick);
  }
  // ボード・進捗タブを描き直した直後に呼ぶ（次のコマまで空白にならないように）
  function drawNow() {
    if (typeof window !== 'undefined') paint(false);
  }

  return { AGENT_COLORS, CHARACTER_KINDS, CHARACTER_COLORS, randomCharacter, characterFor, drawCharacter, colorFor, toolKind, moodOf, progressOf, shade, fitText, start, drawNow };
});
