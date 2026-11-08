// エージェントの返事（Markdown）を、スマホ用の画面に出す。
// HTML の文字列は作らず、いったん木（ただのオブジェクト）にしてから DOM を組み立てる。
// 文字はすべて textContent で入れるので、返事の中の HTML やスクリプトは文字として出るだけ。
// リンクは http(s) のものだけを <a> にする（ほかの URL は文字のまま）。
// 画面（<script>）とテスト（require）の両方から使う。
(function (root, factory) {
  const api = factory();
  if (typeof module === 'object' && module.exports) module.exports = api;
  else root.MobileMarkdown = api;
})(typeof globalThis !== 'undefined' ? globalThis : this, function () {
  const SAFE_URL = /^https?:\/\/[^\s<>"]+$/i;
  const isSafeUrl = (u) => typeof u === 'string' && SAFE_URL.test(u);

  // ---- 行の中の装飾（コード・リンク・太字・斜体・取り消し線） ----
  const P = {
    code: /(`+)([^`]|[^`][\s\S]*?[^`])\1(?!`)/y,
    link: /\[([^\]\n]+)\]\((https?:\/\/[^\s)]+)\)/y,
    url: /https?:\/\/[^\s<>()（）]+[^\s<>()（）.,;:!?。、]/y,
    strong: /\*\*(?=\S)([\s\S]*?\S)\*\*/y,
    strong2: /__(?=\S)([\s\S]*?\S)__(?![A-Za-z0-9])/y,
    del: /~~(?=\S)([\s\S]*?\S)~~/y,
    em: /\*(?=[^\s*])([^*\n]*?[^\s*])\*(?!\*)/y,
    em2: /_(?=[^\s_])([^_\n]*?[^\s_])_(?![A-Za-z0-9])/y,
  };
  const at = (re, s, i) => {
    re.lastIndex = i;
    return re.exec(s);
  };

  function inline(src) {
    const s = String(src ?? '');
    const out = [];
    let text = '';
    const flush = () => {
      if (text) out.push({ t: 'text', v: text });
      text = '';
    };
    let i = 0;
    while (i < s.length) {
      const ch = s[i];
      const prev = i ? s[i - 1] : '';
      const wordBefore = /[\w]/.test(prev);
      let m = null;
      let node = null;
      if (ch === '`' && (m = at(P.code, s, i))) node = { t: 'code', v: m[2].trim() || m[2] };
      else if (ch === '[' && (m = at(P.link, s, i))) node = { t: 'link', href: m[2], c: inline(m[1]) };
      else if (ch === 'h' && (!prev || /[\s(（]/.test(prev)) && (m = at(P.url, s, i))) node = { t: 'link', href: m[0], c: [{ t: 'text', v: m[0] }] };
      else if (ch === '*' && s[i + 1] === '*' && (m = at(P.strong, s, i))) node = { t: 'strong', c: inline(m[1]) };
      else if (ch === '_' && s[i + 1] === '_' && !wordBefore && (m = at(P.strong2, s, i))) node = { t: 'strong', c: inline(m[1]) };
      else if (ch === '~' && s[i + 1] === '~' && (m = at(P.del, s, i))) node = { t: 'del', c: inline(m[1]) };
      else if (ch === '*' && prev !== '*' && !wordBefore && (m = at(P.em, s, i))) node = { t: 'em', c: inline(m[1]) };
      else if (ch === '_' && !wordBefore && (m = at(P.em2, s, i))) node = { t: 'em', c: inline(m[1]) };
      if (node && node.t === 'link' && !isSafeUrl(node.href)) node = null;
      if (node) {
        flush();
        out.push(node);
        i += m[0].length;
      } else {
        text += ch;
        i++;
      }
    }
    flush();
    return out;
  }

  // ---- ブロック（コード・見出し・区切り線・引用・リスト・表・段落） ----
  const RE = {
    fence: /^ {0,3}(`{3,}|~{3,})\s*([^\s`]*)[^`]*$/,
    heading: /^ {0,3}(#{1,6})\s+(.*?)\s*#*\s*$/,
    hr: /^ {0,3}([-*_])(\s*\1){2,}\s*$/,
    quote: /^ {0,3}> ?(.*)$/,
    item: /^(\s*)([-*+]|\d{1,9}[.)])\s+(.*)$/,
    tableSep: /^\s*\|?\s*:?-+:?\s*(\|\s*:?-+:?\s*)*\|?\s*$/,
  };
  const cells = (line) => line.trim().replace(/^\|/, '').replace(/\|$/, '').split('|').map((c) => c.trim());
  const isTableStart = (line, next) => line.includes('|') && typeof next === 'string' && next.includes('|') && RE.tableSep.test(next);
  const isBlockStart = (line, next) => RE.fence.test(line) || RE.heading.test(line) || RE.hr.test(line) || RE.quote.test(line) || RE.item.test(line) || isTableStart(line, next);
  // 行をつないだ段落の中身（改行は br にする）
  const lines2inline = (ls) => ls.flatMap((l, k) => (k ? [{ t: 'br' }, ...inline(l.trim())] : inline(l.trim())));

  function list(lines, i, depth) {
    const first = lines[i].match(RE.item);
    const indent = first[1].length;
    const ordered = /\d/.test(first[2]);
    const start = ordered ? parseInt(first[2], 10) : 1;
    const items = [];
    while (i < lines.length) {
      const m = lines[i].match(RE.item);
      if (m && m[1].length === indent && /\d/.test(m[2]) === ordered) {
        items.push([m[3]]);
        i++;
      } else if (m && m[1].length > indent && items.length) {
        items[items.length - 1].push(lines[i]);
        i++;
      } else if (!m && lines[i].trim() && /^\s+/.test(lines[i]) && items.length) {
        items[items.length - 1].push(lines[i]);
        i++;
      } else break;
    }
    const nodes = items.map((parts) => {
      let text = parts[0];
      let task = null;
      const t = text.match(/^\[([ xX])\]\s+(.*)$/);
      if (t) {
        task = t[1] !== ' ';
        text = t[2];
      }
      const rest = parts.slice(1);
      let sub = [];
      let more = [];
      if (rest.length && RE.item.test(rest[0])) sub = blocks(rest.map((l) => l.replace(/^\s+/, (w) => w.slice(Math.min(w.length, indent + 2)))), depth + 1);
      else if (rest.length) more = rest.flatMap((l) => [{ t: 'br' }, ...inline(l.trim())]);
      return { task, c: [...inline(text), ...more], sub };
    });
    return [{ t: 'list', ordered, start, items: nodes }, i];
  }

  function blocks(lines, depth = 0) {
    const out = [];
    let i = 0;
    // 入れ子が深すぎる入力で止まらないように
    if (depth > 20) return [{ t: 'p', c: lines2inline(lines.filter((l) => l.trim())) }];
    while (i < lines.length) {
      const line = lines[i];
      if (!line.trim()) {
        i++;
        continue;
      }
      let m;
      if ((m = line.match(RE.fence))) {
        const mark = m[1];
        const body = [];
        i++;
        while (i < lines.length && !(lines[i].trim().startsWith(mark[0].repeat(mark.length)) && !lines[i].trim().replace(/[`~]/g, ''))) body.push(lines[i++]);
        i++;
        out.push({ t: 'codeblock', lang: m[2] || '', v: body.join('\n') });
        continue;
      }
      if ((m = line.match(RE.heading))) {
        out.push({ t: 'h', level: m[1].length, c: inline(m[2]) });
        i++;
        continue;
      }
      if (RE.hr.test(line)) {
        out.push({ t: 'hr' });
        i++;
        continue;
      }
      if (RE.quote.test(line)) {
        const body = [];
        while (i < lines.length && (m = lines[i].match(RE.quote))) {
          body.push(m[1]);
          i++;
        }
        out.push({ t: 'quote', c: blocks(body, depth + 1) });
        continue;
      }
      if (RE.item.test(line)) {
        const [node, next] = list(lines, i, depth);
        out.push(node);
        i = next;
        continue;
      }
      if (isTableStart(line, lines[i + 1])) {
        const head = cells(line);
        const align = cells(lines[i + 1]).map((c) => (c.startsWith(':') && c.endsWith(':') ? 'center' : c.endsWith(':') ? 'right' : ''));
        i += 2;
        const rows = [];
        while (i < lines.length && lines[i].trim() && lines[i].includes('|')) rows.push(cells(lines[i++]));
        out.push({ t: 'table', align: head.map((_, k) => align[k] || ''), head: head.map(inline), rows: rows.map((r) => head.map((_, k) => inline(r[k] ?? ''))) });
        continue;
      }
      const para = [];
      while (i < lines.length && lines[i].trim() && (!para.length || !isBlockStart(lines[i], lines[i + 1]))) para.push(lines[i++]);
      out.push({ t: 'p', c: lines2inline(para) });
    }
    return out;
  }

  function parse(text) {
    return blocks(String(text ?? '').replace(/\r\n?/g, '\n').split('\n'));
  }

  // ---- DOM を組み立てる（doc は document。テストでは差し替えられる） ----
  function render(doc, text, opts = {}) {
    const frag = doc.createDocumentFragment();
    const el = (tag, cls) => {
      const e = doc.createElement(tag);
      if (cls) e.className = cls;
      return e;
    };
    const copyLabel = opts.copyLabel || 'Copy';
    const inl = (parent, nodes) => {
      for (const n of nodes) {
        if (n.t === 'text') parent.appendChild(doc.createTextNode(n.v));
        else if (n.t === 'br') parent.appendChild(el('br'));
        else if (n.t === 'code') {
          const c = el('code');
          c.textContent = n.v;
          parent.appendChild(c);
        } else if (n.t === 'link') {
          if (!isSafeUrl(n.href)) {
            inl(parent, n.c);
            continue;
          }
          const a = el('a', 'md-link');
          a.setAttribute('href', n.href);
          a.setAttribute('target', '_blank');
          a.setAttribute('rel', 'noopener noreferrer');
          inl(a, n.c);
          parent.appendChild(a);
        } else if (n.t === 'strong' || n.t === 'em' || n.t === 'del') {
          const e = el(n.t);
          inl(e, n.c);
          parent.appendChild(e);
        }
      }
    };
    const blk = (parent, nodes) => {
      for (const n of nodes) {
        if (n.t === 'p') {
          const p = el('p');
          inl(p, n.c);
          parent.appendChild(p);
        } else if (n.t === 'h') {
          const h = el(`h${Math.min(6, Math.max(1, n.level | 0))}`);
          inl(h, n.c);
          parent.appendChild(h);
        } else if (n.t === 'hr') parent.appendChild(el('hr'));
        else if (n.t === 'quote') {
          const q = el('blockquote');
          blk(q, n.c);
          parent.appendChild(q);
        } else if (n.t === 'codeblock') {
          const wrap = el('div', 'md-code-wrap');
          const btn = el('button', 'md-copy');
          btn.type = 'button';
          btn.textContent = copyLabel;
          const pre = el('pre', 'md-code');
          if (n.lang) pre.setAttribute('data-lang', n.lang);
          const code = el('code');
          code.textContent = n.v;
          pre.appendChild(code);
          wrap.appendChild(btn);
          wrap.appendChild(pre);
          parent.appendChild(wrap);
        } else if (n.t === 'list') {
          const l = el(n.ordered ? 'ol' : 'ul');
          if (n.ordered && n.start !== 1) l.setAttribute('start', String(n.start));
          for (const it of n.items) {
            const li = el('li');
            if (it.task !== null) {
              const box = el('input');
              box.type = 'checkbox';
              box.disabled = true;
              box.checked = !!it.task;
              li.appendChild(box);
              li.appendChild(doc.createTextNode(' '));
            }
            inl(li, it.c);
            blk(li, it.sub);
            l.appendChild(li);
          }
          parent.appendChild(l);
        } else if (n.t === 'table') {
          const wrap = el('div', 'md-table');
          const table = el('table');
          const thead = el('thead');
          const tr = el('tr');
          n.head.forEach((c, k) => {
            const th = el('th', n.align[k] ? `al-${n.align[k]}` : '');
            inl(th, c);
            tr.appendChild(th);
          });
          thead.appendChild(tr);
          const tbody = el('tbody');
          for (const r of n.rows) {
            const row = el('tr');
            r.forEach((c, k) => {
              const td = el('td', n.align[k] ? `al-${n.align[k]}` : '');
              inl(td, c);
              row.appendChild(td);
            });
            tbody.appendChild(row);
          }
          table.appendChild(thead);
          table.appendChild(tbody);
          wrap.appendChild(table);
          parent.appendChild(wrap);
        }
      }
    };
    blk(frag, parse(text));
    return frag;
  }

  // カードや通知の短い文章用: Markdown の記号を外して、ふつうの文章にする
  function plain(text) {
    const walk = (nodes) => nodes.map((n) => (n.t === 'text' || n.t === 'code' ? n.v : n.t === 'br' ? ' ' : n.c ? walk(n.c) : '')).join('');
    const parts = [];
    const blk = (nodes) => {
      for (const n of nodes) {
        if (n.t === 'p' || n.t === 'h') parts.push(walk(n.c));
        else if (n.t === 'quote') blk(n.c);
        else if (n.t === 'list') for (const it of n.items) parts.push(`• ${walk(it.c)}`), blk(it.sub);
        else if (n.t === 'table') for (const r of [n.head, ...n.rows]) parts.push(r.map(walk).join(' / '));
      }
    };
    blk(parse(text));
    return parts.join(' ').replace(/\s+/g, ' ').trim();
  }

  return { parse, inline, render, plain, isSafeUrl };
});
