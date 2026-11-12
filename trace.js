// A static CSS tracer: where does an element's font size come from, and which two numbers
// (the min and max variables) make it fluid?
//
// Stacki gives apps no computed styles, so this reads the project's own CSS (*.css and the
// <style> blocks of *.astro files) and runs a small cascade over it: layers, specificity,
// nesting, media queries at the canvas width, inheritance, and custom properties.
//
//   const corpus = TR.createCorpus();
//   corpus.setFile('src/styles/base.css', text);            // .css or .astro
//   const chain = TR.buildChain(corpus, lineage, width);    // element, parents… body, html
//   const trace = TR.traceFontSize(corpus, chain, width);
//
// Everything is plain JS with no dependencies, so it loads in the app frame and in Node.

(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory();
  else root.TR = factory();
})(typeof globalThis !== 'undefined' ? globalThis : typeof self !== 'undefined' ? self : this, function () {
  'use strict';

  const UNLAYERED = 1e9;

  // ── Small text helpers ─────────────────────────────────────────────────────

  /** Comments become spaces, so every offset in the file stays where it was. */
  const blank = (t) => t.replace(/\/\*[\s\S]*?\*\//g, (m) => m.replace(/[^\n]/g, ' '));

  const skipString = (t, i, end) => {
    const q = t[i];
    for (let j = i + 1; j < end; j++) {
      if (t[j] === '\\') j++;
      else if (t[j] === q) return j;
    }
    return end - 1;
  };

  /** Index of the first top-level `{`, `;` or `}` from i, or end. */
  const scanStmt = (t, i, end) => {
    let depth = 0;
    for (let j = i; j < end; j++) {
      const c = t[j];
      if (c === '"' || c === "'") j = skipString(t, j, end);
      else if (c === '(' || c === '[') depth++;
      else if (c === ')' || c === ']') depth = Math.max(0, depth - 1);
      else if (depth === 0 && (c === '{' || c === ';' || c === '}')) return j;
    }
    return end;
  };

  /** Index of the `}` that closes the `{` at `open`. */
  const blockEnd = (t, open, end) => {
    let depth = 0;
    for (let j = open; j < end; j++) {
      const c = t[j];
      if (c === '"' || c === "'") j = skipString(t, j, end);
      else if (c === '{') depth++;
      else if (c === '}' && --depth === 0) return j;
    }
    return end;
  };

  /** Matching close for the bracket at i (quotes respected), or -1. */
  const closing = (s, i, open, close) => {
    let depth = 0;
    for (let j = i; j < s.length; j++) {
      const c = s[j];
      if (c === '"' || c === "'") j = skipString(s, j, s.length);
      else if (c === open) depth++;
      else if (c === close && --depth === 0) return j;
    }
    return -1;
  };

  /** Splits at top-level commas (brackets and quotes respected). */
  const splitTop = (str, sep = ',') => {
    const out = [];
    let depth = 0;
    let from = 0;
    for (let i = 0; i < str.length; i++) {
      const c = str[i];
      if (c === '"' || c === "'" || c === '`') i = skipString(str, i, str.length);
      else if (c === '(' || c === '[' || c === '{') depth++;
      else if (c === ')' || c === ']' || c === '}') depth--;
      else if (c === sep && depth === 0) {
        out.push(str.slice(from, i));
        from = i + 1;
      }
    }
    out.push(str.slice(from));
    return out;
  };

  const dirname = (p) => (p.includes('/') ? p.slice(0, p.lastIndexOf('/')) : '');
  const basename = (p) => p.slice(p.lastIndexOf('/') + 1);
  const normalize = (p) => {
    const out = [];
    for (const seg of p.split('/')) {
      if (seg === '..') out.pop();
      else if (seg !== '.' && seg !== '') out.push(seg);
    }
    return (p.startsWith('/') ? '/' : '') + out.join('/');
  };

  // ── CSS parser ─────────────────────────────────────────────────────────────
  //
  // Produces rules: { selectors: [{ text, match }], decls, media: [cond…], layer }.
  // A declaration keeps the absolute range of its value text, so a caller can edit it.

  const SKIPPED_AT = /^@(keyframes|-webkit-keyframes|font-face|property|container|page|scope|starting-style|counter-style|font-feature-values|view-transition)\b/i;

  const parseDecl = (t, i, j, file) => {
    // The first colon at the top level splits name from value.
    let depth = 0;
    let colon = -1;
    for (let k = i; k < j; k++) {
      const c = t[k];
      if (c === '(' || c === '[') depth++;
      else if (c === ')' || c === ']') depth--;
      else if (c === ':' && depth === 0) {
        colon = k;
        break;
      }
    }
    if (colon < 0) return undefined;
    const name = t.slice(i, colon).trim();
    if (!/^-{0,2}[A-Za-z_][\w-]*$/.test(name)) return undefined;
    let start = colon + 1;
    let end = j;
    while (start < end && /\s/.test(t[start])) start++;
    while (end > start && /\s/.test(t[end - 1])) end--;
    let important = false;
    const imp = /\s*!\s*important\s*$/i.exec(t.slice(start, end));
    if (imp) {
      important = true;
      end -= imp[0].length;
    }
    if (end <= start) return undefined;
    return { prop: name.startsWith('--') ? name : name.toLowerCase(), value: t.slice(start, end), start, end, important, file };
  };

  /** Nested selectors resolved against their parents: `&` is the parent, no `&` is a descendant. */
  const resolveNested = (prelude, parents) => {
    const out = [];
    for (const raw of splitTop(prelude)) {
      const part = raw.trim();
      if (!part) continue;
      for (const p of parents) {
        if (part.includes('&')) {
          const wrap = /[\s>+~,]/.test(p.match);
          out.push({ text: part.replace(/&/g, p.text), match: part.replace(/&/g, wrap ? `:is(${p.match})` : p.match) });
        } else {
          out.push({ text: `${p.text} ${part}`, match: `${p.match} ${part}` });
        }
      }
    }
    return out;
  };

  const topSelectors = (prelude) =>
    splitTop(prelude)
      .map((s) => s.trim())
      .filter(Boolean)
      .map((s) => ({ text: s, match: s.replace(/:global\(([^)]*)\)/g, '$1') }));

  /** Parses one file's CSS between [start, end) of `t` (comments already blanked). */
  const parseCss = (t, start, end, file, out) => {
    let anon = 0;

    const body = (i, stop, selectors, media, layer) => {
      const decls = [];
      while (i < stop) {
        while (i < stop && /\s/.test(t[i])) i++;
        if (i >= stop) break;
        const j = scanStmt(t, i, stop);
        const c = t[j];
        if (c === '}') {
          i = j + 1;
        } else if (c === '{') {
          const prelude = t.slice(i, j).trim();
          const be = blockEnd(t, j, stop);
          if (prelude.startsWith('@')) {
            if (/^@(media|supports)\b/i.test(prelude)) body(j + 1, be, selectors, /^@media/i.test(prelude) ? media.concat(prelude.replace(/^@media\s*/i, '')) : media, layer);
            else if (/^@layer\b/i.test(prelude)) {
              const name = prelude.replace(/^@layer\s*/i, '').trim() || `__anon${anon++}`;
              out.layerBlocks.push(name);
              body(j + 1, be, selectors, media, name);
            }
          } else {
            body(j + 1, be, resolveNested(prelude, selectors), media, layer);
          }
          i = be + 1;
        } else {
          const d = parseDecl(t, i, j, file);
          if (d) decls.push(d);
          i = j + 1;
        }
      }
      if (decls.length) out.rules.push({ selectors, decls, media, layer, order: decls[0].start });
    };

    const sheet = (i, stop, media, layer) => {
      while (i < stop) {
        while (i < stop && /\s/.test(t[i])) i++;
        if (i >= stop) break;
        const j = scanStmt(t, i, stop);
        const c = t[j];
        const prelude = t.slice(i, j).trim();
        if (c === '}') {
          i = j + 1;
        } else if (c === '{') {
          const be = blockEnd(t, j, stop);
          if (prelude.startsWith('@')) {
            if (/^@media\b/i.test(prelude)) sheet(j + 1, be, media.concat(prelude.replace(/^@media\s*/i, '')), layer);
            else if (/^@supports\b/i.test(prelude)) sheet(j + 1, be, media, layer);
            else if (/^@layer\b/i.test(prelude)) {
              const name = prelude.replace(/^@layer\s*/i, '').trim() || `__anon${anon++}`;
              out.layerBlocks.push(name);
              sheet(j + 1, be, media, name);
            } else if (!SKIPPED_AT.test(prelude)) {
              /* an at-rule with nothing to say about type: ignored */
            }
          } else if (prelude) {
            body(j + 1, be, topSelectors(prelude), media, layer);
          }
          i = be + 1;
        } else {
          if (/^@layer\b/i.test(prelude)) {
            for (const name of prelude.replace(/^@layer\s*/i, '').split(',')) if (name.trim()) out.layerStatements.push(name.trim());
          } else if (/^@import\b/i.test(prelude)) {
            const m = /^@import\s+(?:url\(\s*)?["']?([^"')\s]+)/i.exec(prelude);
            if (m) {
              const lm = /\blayer(?:\(\s*([\w.-]*)\s*\))?/i.exec(prelude.slice(m[0].length));
              out.imports.push({ href: m[1], layer: lm ? lm[1] || '' : undefined });
            }
          }
          i = j + 1;
        }
      }
    };

    sheet(start, end, [], undefined);
  };

  /** A file's rules: all of a .css file, the <style> blocks of an .astro file. */
  const parseFile = (path, text) => {
    const out = { rules: [], layerStatements: [], layerBlocks: [], imports: [] };
    if (/\.css$/i.test(path)) {
      parseCss(blank(text), 0, text.length, path, out);
    } else if (/\.astro$/i.test(path)) {
      const t = text.replace(/(<style\b[^>]*>)([\s\S]*?)(<\/style>)/gi, (m, a, b, c) => a + blank(b) + c);
      const re = /<style\b([^>]*)>/gi;
      let m;
      while ((m = re.exec(t))) {
        if (/\blang\s*=\s*["']?(scss|sass|less|stylus|styl)/i.test(m[1])) continue;
        const from = m.index + m[0].length;
        const to = t.indexOf('</style>', from);
        if (to < 0) break;
        parseCss(t, from, to, path, out);
        re.lastIndex = to;
      }
    }
    return out;
  };

  // ── Selectors ──────────────────────────────────────────────────────────────

  const IDENT = '(?:[\\w-]|\\\\.)+';
  const NO_MATCH_PSEUDO_ELEMENTS = new Set(['before', 'after', 'first-line', 'first-letter']);

  const parseNth = (arg) => {
    const s = String(arg || '').trim().toLowerCase().replace(/\s+/g, '');
    if (s === 'odd') return { a: 2, b: 1 };
    if (s === 'even') return { a: 2, b: 0 };
    if (/^[+-]?\d+$/.test(s)) return { a: 0, b: parseInt(s, 10) };
    const m = /^([+-]?\d*)n([+-]\d+)?$/.exec(s);
    if (!m) return undefined;
    const a = m[1] === '' || m[1] === '+' ? 1 : m[1] === '-' ? -1 : parseInt(m[1], 10);
    return { a, b: m[2] ? parseInt(m[2], 10) : 0 };
  };

  const parseAttr = (s) => {
    const m = /^\s*([\w:-]+)\s*(?:([~|^$*]?=)\s*(?:"([^"]*)"|'([^']*)'|([^\s\]]+))\s*(?:[is])?)?\s*$/i.exec(s);
    if (!m) return undefined;
    return { name: m[1].toLowerCase(), op: m[2], value: m[3] ?? m[4] ?? m[5] };
  };

  const parseCompound = (s) => {
    const c = { tag: null, ids: [], classes: [], attrs: [], pseudos: [], bad: false };
    let i = 0;
    const ident = () => {
      const m = new RegExp('^' + IDENT).exec(s.slice(i));
      if (!m) return null;
      i += m[0].length;
      return m[0].replace(/\\(.)/g, '$1');
    };
    if (s[i] === '*') {
      c.tag = '*';
      i++;
    } else if (s[i] && /[\w-]/.test(s[i])) {
      c.tag = ident();
    }
    while (i < s.length && !c.bad) {
      const ch = s[i];
      if (ch === '#') {
        i++;
        const v = ident();
        if (v === null) c.bad = true;
        else c.ids.push(v);
      } else if (ch === '.') {
        i++;
        const v = ident();
        if (v === null) c.bad = true;
        else c.classes.push(v);
      } else if (ch === '[') {
        const e = closing(s, i, '[', ']');
        const a = e < 0 ? undefined : parseAttr(s.slice(i + 1, e));
        if (!a) c.bad = true;
        else {
          c.attrs.push(a);
          i = e + 1;
        }
      } else if (ch === ':') {
        if (s[i + 1] === ':') {
          c.bad = true; // a pseudo-element is not the element
          break;
        }
        i++;
        const name = (ident() || '').toLowerCase();
        let arg = null;
        if (s[i] === '(') {
          const e = closing(s, i, '(', ')');
          if (e < 0) {
            c.bad = true;
            break;
          }
          arg = s.slice(i + 1, e);
          i = e + 1;
        }
        if (NO_MATCH_PSEUDO_ELEMENTS.has(name)) c.bad = true;
        const p = { name, arg };
        if (['is', 'where', 'not', 'matches', '-webkit-any', '-moz-any'].includes(name)) p.list = splitTop(arg || '').map(parseComplex);
        if (name === 'nth-child') p.nth = parseNth(arg);
        c.pseudos.push(p);
      } else {
        c.bad = true;
      }
    }
    return c;
  };

  /** `a > b c` → { parts: [{ comb, c }], spec, bad }, where comb joins a part to the one before it. */
  function parseComplex(str) {
    const s = String(str).trim();
    const parts = [];
    let cur = '';
    let pending = null;
    let depth = 0;
    let bad = false;
    const flush = () => {
      if (!cur) return;
      parts.push({ comb: parts.length ? pending || ' ' : null, c: parseCompound(cur) });
      cur = '';
      pending = null;
    };
    for (let i = 0; i < s.length; i++) {
      const ch = s[i];
      if (ch === '"' || ch === "'") {
        const e = skipString(s, i, s.length);
        cur += s.slice(i, e + 1);
        i = e;
      } else if (ch === '(' || ch === '[') {
        depth++;
        cur += ch;
      } else if (ch === ')' || ch === ']') {
        depth--;
        cur += ch;
      } else if (depth === 0 && /\s/.test(ch)) {
        flush();
        if (parts.length && pending === null) pending = ' ';
      } else if (depth === 0 && (ch === '>' || ch === '+' || ch === '~')) {
        flush();
        pending = ch;
      } else {
        cur += ch;
      }
    }
    flush();
    if (!parts.length || parts.some((p) => p.c.bad)) bad = true;
    return { parts, bad, spec: bad ? 0 : specificity(parts) };
  }

  const specTriple = (parts) => {
    let a = 0;
    let b = 0;
    let c = 0;
    for (const { c: cmp } of parts) {
      a += cmp.ids.length;
      b += cmp.classes.length + cmp.attrs.length;
      if (cmp.tag && cmp.tag !== '*') c++;
      for (const p of cmp.pseudos) {
        if (p.name === 'where') continue;
        if (p.list) {
          let best = [0, 0, 0];
          for (const sel of p.list) {
            const t = sel.bad ? [0, 0, 0] : specTriple(sel.parts);
            if (t[0] > best[0] || (t[0] === best[0] && (t[1] > best[1] || (t[1] === best[1] && t[2] > best[2])))) best = t;
          }
          a += best[0];
          b += best[1];
          c += best[2];
        } else b++;
      }
    }
    return [a, b, c];
  };
  const specificity = (parts) => {
    const [a, b, c] = specTriple(parts);
    return a * 1e6 + b * 1e3 + c;
  };

  const matchCompound = (cmp, el) => {
    if (cmp.tag && cmp.tag !== '*' && cmp.tag.toLowerCase() !== el.name) return false;
    for (const id of cmp.ids) if (el.id !== id) return false;
    for (const cls of cmp.classes) if (!el.classes.includes(cls)) return false;
    for (const a of cmp.attrs) {
      const raw = el.attrs[a.name];
      if (raw === undefined || raw === null || raw === false) return false;
      if (!a.op) continue;
      const val = String(raw);
      const want = a.value;
      let ok;
      switch (a.op) {
        case '=': ok = val === want; break;
        case '~=': ok = val.split(/\s+/).includes(want); break;
        case '|=': ok = val === want || val.startsWith(want + '-'); break;
        case '^=': ok = want !== '' && val.startsWith(want); break;
        case '$=': ok = want !== '' && val.endsWith(want); break;
        case '*=': ok = want !== '' && val.includes(want); break;
        default: ok = false;
      }
      if (!ok) return false;
    }
    for (const p of cmp.pseudos) {
      switch (p.name) {
        case 'root': if (!el.isRoot) return false; break;
        case 'is': case 'where': case 'matches': case '-webkit-any': case '-moz-any':
          if (!p.list.some((sel) => matchComplex(sel, el))) return false;
          break;
        case 'not': if (p.list.some((sel) => matchComplex(sel, el))) return false; break;
        case 'first-child': if (el.index !== 0) return false; break;
        case 'last-child': if (el.index !== el.count - 1) return false; break;
        case 'only-child': if (el.count !== 1) return false; break;
        case 'nth-child': {
          if (!p.nth) return false;
          const n = el.index + 1;
          const { a, b } = p.nth;
          if (a === 0 ? n !== b : (n - b) / a < 0 || (n - b) % a !== 0) return false;
          break;
        }
        default: return false; // :hover, :focus, :has … never apply to a static read
      }
    }
    return true;
  };

  function matchFrom(parts, k, el) {
    if (!matchCompound(parts[k].c, el)) return false;
    if (k === 0) return true;
    switch (parts[k].comb) {
      case '>': return el.parent ? matchFrom(parts, k - 1, el.parent) : false;
      case '+': return el.prev ? matchFrom(parts, k - 1, el.prev) : false;
      case '~': for (let p = el.prev; p; p = p.prev) if (matchFrom(parts, k - 1, p)) return true; return false;
      default: for (let p = el.parent; p; p = p.parent) if (matchFrom(parts, k - 1, p)) return true; return false;
    }
  }
  function matchComplex(sel, el) {
    return !sel.bad && matchFrom(sel.parts, sel.parts.length - 1, el);
  }

  // ── Media queries, at one canvas width ─────────────────────────────────────

  const toPx = (num, unit) => (unit === 'px' ? parseFloat(num) : parseFloat(num) * 16);

  const mediaItem = (item, width) => {
    let s = item.trim().toLowerCase();
    let negate = false;
    if (/^not\s/.test(s)) {
      negate = true;
      s = s.slice(4);
    }
    s = s.replace(/^only\s+/, '');
    const results = s.split(/\band\b/).map((part) => {
      part = part.trim();
      if (part === 'screen' || part === 'all') return true;
      if (part === 'print' || part === 'speech') return false;
      let m = /^\(\s*(min-width|max-width|width)\s*:\s*([\d.]+)(px|em|rem)\s*\)$/.exec(part);
      if (m) {
        const v = toPx(m[2], m[3]);
        return m[1] === 'min-width' ? width >= v : m[1] === 'max-width' ? width <= v : width === v;
      }
      m = /^\(\s*width\s*(>=|<=|>|<|=)\s*([\d.]+)(px|em|rem)\s*\)$/.exec(part);
      if (m) {
        const v = toPx(m[2], m[3]);
        return { '>=': width >= v, '<=': width <= v, '>': width > v, '<': width < v, '=': width === v }[m[1]];
      }
      m = /^\(\s*([\d.]+)(px|em|rem)\s*(<=|<)\s*width\s*(?:(<=|<)\s*([\d.]+)(px|em|rem))?\s*\)$/.exec(part);
      if (m) {
        const lo = toPx(m[1], m[2]);
        const okLo = m[3] === '<=' ? lo <= width : lo < width;
        if (!m[4]) return okLo;
        const hi = toPx(m[5], m[6]);
        return okLo && (m[4] === '<=' ? width <= hi : width < hi);
      }
      m = /^\(\s*(any-)?(hover|pointer)\s*:\s*([\w-]+)\s*\)$/.exec(part);
      if (m) return m[3] === 'hover' || m[3] === 'fine';
      m = /^\(\s*prefers-color-scheme\s*:\s*light\s*\)$/.exec(part);
      if (m) return true;
      return false; // anything else is not known to hold
    });
    const all = results.every(Boolean);
    return negate ? !all : all;
  };
  const mediaOk = (conds, width) => conds.every((c) => splitTop(c).some((item) => mediaItem(item, width)));

  // ── Component sources ──────────────────────────────────────────────────────
  //
  // A component node on the page stands for an element the component's own template
  // renders. Its root tag and classes are read from the .astro source.

  const analyzeComponent = (text) => {
    const fm = /^\s*---[^\n]*\n([\s\S]*?)\n---/.exec(text);
    const front = fm ? fm[1] : '';
    let tpl = fm ? text.slice(fm[0].length) : text;
    tpl = tpl.replace(/<style\b[\s\S]*?<\/style>|<script\b[\s\S]*?<\/script>|<!--[\s\S]*?-->/gi, (m) => ' '.repeat(m.length));

    const locals = {};
    const dm = /const\s*\{([\s\S]*?)\}\s*=\s*Astro\.props/.exec(front);
    if (dm) {
      for (const entry of splitTop(dm[1])) {
        const m = /^\s*(?:\.\.\.)?([\w$]+)(?:\s*:\s*([\w$]+))?(?:\s*=\s*([\s\S]+?))?\s*$/.exec(entry);
        if (m) locals[m[2] || m[1]] = { prop: m[1], def: m[3] };
      }
    }

    const info = { locals, tag: undefined, statics: [], dynamics: [], id: undefined };
    const re = /<([A-Za-z][\w.:-]*)/g;
    let m;
    while ((m = re.exec(tpl))) {
      if (m[1] !== 'Fragment') break;
    }
    if (!m) return info;
    info.tag = /^[a-z]/.test(m[1]) ? { literal: m[1].toLowerCase() } : locals[m[1]] ? { local: m[1] } : undefined;

    // The start tag: up to its `>`, past any {expressions} and strings.
    const from = m.index + m[0].length;
    let j = from;
    let depth = 0;
    for (; j < tpl.length; j++) {
      const c = tpl[j];
      if (c === '"' || c === "'" || c === '`') j = skipString(tpl, j, tpl.length);
      else if (c === '{') depth++;
      else if (c === '}') depth--;
      else if (c === '>' && depth === 0) break;
    }
    const attrs = tpl.slice(from, j);

    const addTokens = (lit) => {
      for (const tok of lit.split(/\s+/).filter(Boolean)) {
        if (!tok.includes('${')) {
          info.statics.push(tok);
          continue;
        }
        const d = /^([^$]*)\$\{\s*([\w$]+)\s*\}([^$]*)$/.exec(tok);
        if (d) info.dynamics.push({ prefix: d[1], local: d[2], suffix: d[3] });
      }
    };

    const idm = /(?:^|\s)id\s*=\s*["']([^"']*)["']/.exec(attrs);
    if (idm) info.id = idm[1];

    const cre = /(?:^|\s)class(?::list)?\s*=\s*/g;
    let c;
    while ((c = cre.exec(attrs))) {
      const p = c.index + c[0].length;
      const q = attrs[p];
      if (q === '"' || q === "'") {
        addTokens(attrs.slice(p + 1, skipString(attrs, p, attrs.length)));
      } else if (q === '{') {
        const e = closing(attrs, p, '{', '}');
        const expr = attrs.slice(p + 1, e < 0 ? attrs.length : e);
        // String literals in the expression; the ones compared against are not classes.
        for (let i = 0; i < expr.length; i++) {
          const ch = expr[i];
          if (ch !== '"' && ch !== "'" && ch !== '`') continue;
          const end = skipString(expr, i, expr.length);
          if (!/[!=]==?\s*$/.test(expr.slice(Math.max(0, i - 6), i))) addTokens(expr.slice(i + 1, end));
          i = end;
        }
      }
    }
    return info;
  };

  /** A local's value: the node's prop, else the destructuring default, following one-hop aliases (`variant = Tag`). */
  const resolveLocal = (info, local, attrs, depth = 0) => {
    const l = info.locals[local];
    if (!l) return undefined;
    const v = attrs[l.prop];
    if (v !== undefined && v !== null && v !== '' && v !== false) return String(v);
    if (l.def === undefined) return undefined;
    const d = l.def.trim();
    const sm = /^(["'`])([\s\S]*)\1$/.exec(d);
    if (sm) return sm[2];
    if (info.locals[d] && depth < 4) return resolveLocal(info, d, attrs, depth + 1);
    if (/^-?\d|^(true|false)$/.test(d)) return d;
    return undefined;
  };

  // ── The corpus ─────────────────────────────────────────────────────────────

  const createCorpus = () => {
    const files = new Map(); // path → { path, text, idx, parsed, info? }
    let counter = 0;
    let built;

    const build = () => {
      if (built) return built;
      const sorted = [...files.values()].sort((a, b) => a.idx - b.idx);
      const layerOrder = [];
      const add = (n) => {
        if (n && !layerOrder.includes(n)) layerOrder.push(n);
      };
      for (const f of sorted) f.parsed.layerStatements.forEach(add);
      for (const f of sorted) f.parsed.layerBlocks.forEach(add);
      const importLayers = new Map();
      for (const f of sorted) {
        for (const imp of f.parsed.imports) {
          if (imp.layer === undefined || !/^[./]/.test(imp.href)) continue;
          const target = normalize(`${dirname(f.path)}/${imp.href}`);
          const name = imp.layer || `__imp:${target}`;
          importLayers.set(target, name);
          add(name);
        }
      }
      const byProp = new Map();
      for (const f of sorted) {
        for (const r of f.parsed.rules) {
          const name = r.layer || importLayers.get(normalize(f.path));
          const rule = { ...r, file: f.path, layerRank: name ? layerOrder.indexOf(name) : UNLAYERED, fileIdx: f.idx };
          for (const d of r.decls) {
            if (!byProp.has(d.prop)) byProp.set(d.prop, []);
            byProp.get(d.prop).push({ rule, decl: d });
          }
        }
      }
      const comps = new Map();
      for (const f of sorted) {
        if (!/\.astro$/i.test(f.path)) continue;
        const name = basename(f.path).replace(/\.astro$/i, '');
        if (!comps.has(name)) comps.set(name, f);
      }
      built = { byProp, comps };
      return built;
    };

    return {
      setFile(path, text) {
        const prev = files.get(path);
        files.set(path, { path, text, idx: prev ? prev.idx : counter++, parsed: parseFile(path, text) });
        built = undefined;
      },
      removeFile(path) {
        files.delete(path);
        built = undefined;
      },
      getText: (path) => (files.has(path) ? files.get(path).text : undefined),
      paths: () => [...files.keys()],
      _byProp: (prop) => build().byProp.get(prop) || [],
      _props: () => [...build().byProp.keys()],
      _component(name) {
        const f = build().comps.get(name);
        if (!f) return undefined;
        if (!f.info) f.info = analyzeComponent(f.text);
        return f.info;
      },
    };
  };

  // ── Elements and chains ────────────────────────────────────────────────────

  const synth = (corpus, node) => {
    const attrs = { ...(node.attributes || {}) };
    let name = String(node.name || '').toLowerCase();
    let classes = [...(node.classes || [])];
    let id = attrs.id;
    if (node.kind === 'component') {
      const info = corpus._component(node.name);
      name = '';
      classes = [];
      if (info) {
        if (info.tag) name = (info.tag.literal || resolveLocal(info, info.tag.local, attrs) || '').toLowerCase();
        classes.push(...info.statics);
        for (const d of info.dynamics) {
          const v = resolveLocal(info, d.local, attrs);
          if (v) classes.push(d.prefix + v + d.suffix);
        }
        if (info.id && !id) id = info.id;
      }
      if (typeof attrs.class === 'string') classes.push(...attrs.class.split(/\s+/).filter(Boolean));
      classes.push(...(node.classes || []));
    } else if (!classes.length && typeof attrs.class === 'string') {
      classes = attrs.class.split(/\s+/).filter(Boolean);
    }
    classes = [...new Set(classes)];
    attrs.class = classes.join(' ');
    return { name, classes, attrs, id };
  };

  const makeEl = (corpus, node, siblings, parent) => {
    const els = (siblings && siblings.length ? siblings : [node]).filter((n) => n.kind !== 'text');
    const at = Math.max(0, els.indexOf(node));
    const el = { ...synth(corpus, node), node, isRoot: false, parent, index: at, count: els.length || 1 };
    let prev;
    Object.defineProperty(el, 'prev', {
      get() {
        if (prev === undefined) prev = at > 0 ? makeEl(corpus, els[at - 1], siblings, parent) : null;
        return prev;
      },
    });
    return el;
  };

  const virtual = (name, parent, isRoot) => ({ name, classes: [], attrs: { class: '' }, id: undefined, isRoot, parent, index: 0, count: 1, prev: null });

  /** [target, …parents, body, html]. A text node stands for its parent. */
  const buildChain = (corpus, lineage, width) => {
    const items = (lineage || []).slice();
    if (items.length && items[items.length - 1].node.kind === 'text') items.pop();
    const html = virtual('html', null, true);
    const body = virtual('body', html, false);
    const chain = [body, html];
    let parent = body;
    for (const item of items) {
      parent = makeEl(corpus, item.node, item.siblings, parent);
      chain.unshift(parent);
    }
    chain.width = width;
    return chain;
  };

  const rootChain = (corpus, width) => {
    const chain = [virtual('html', null, true)];
    chain.width = width;
    return chain;
  };

  // ── Cascade ────────────────────────────────────────────────────────────────

  const beats = (a, b) => {
    // (important, layer — flipped for important, specificity, source order)
    if (a.important !== b.important) return a.important;
    const la = a.important ? -a.layerRank : a.layerRank;
    const lb = b.important ? -b.layerRank : b.layerRank;
    if (la !== lb) return la > lb;
    if (a.spec !== b.spec) return a.spec > b.spec;
    return a.order > b.order;
  };

  const makeCtx = (corpus, chain, width) => ({ corpus, chain, width: width ?? chain.width ?? 1440, cache: new Map() });

  /** The declaration of `prop` that wins on chain[idx] itself, if any. */
  const winner = (ctx, idx, prop) => {
    const key = `${idx}|${prop}`;
    if (ctx.cache.has(key)) return ctx.cache.get(key);
    const el = ctx.chain[idx];
    let best = null;
    for (const { rule, decl } of ctx.corpus._byProp(prop)) {
      if (!mediaOk(rule.media, ctx.width)) continue;
      let spec = -1;
      let text = '';
      for (const sel of rule.selectors) {
        if (!sel.parsed) sel.parsed = parseComplex(sel.match);
        if (sel.parsed.spec > spec && matchComplex(sel.parsed, el)) {
          spec = sel.parsed.spec;
          text = sel.text;
        }
      }
      if (spec < 0) continue;
      const cand = { decl, selector: text, spec, important: decl.important, layerRank: rule.layerRank, order: rule.fileIdx * 1e9 + decl.start };
      if (!best || beats(cand, best)) best = cand;
    }
    ctx.cache.set(key, best);
    return best;
  };

  /** The value of `prop` as it reaches chain[idx]: its own winner, else what it inherits. */
  const lookup = (ctx, prop, idx) => {
    for (let j = idx; j < ctx.chain.length; j++) {
      const w = winner(ctx, j, prop);
      if (!w) continue;
      const v = w.decl.value.trim().toLowerCase();
      if (v === 'inherit' || v === 'unset') continue;
      if (v === 'initial') return undefined;
      return { w, at: j };
    }
    return undefined;
  };

  const refs = (text) => {
    const out = [];
    const re = /var\(\s*(--[\w-]+)/g;
    let m;
    while ((m = re.exec(text))) out.push(m[1]);
    return out;
  };

  /** A plain number (unitless, px or rem), following `--a: var(--b)` aliases to the number's own declaration. */
  const numberAt = (ctx, name, idx, depth = 0) => {
    const r = lookup(ctx, name, idx);
    if (!r) return undefined;
    const d = r.w.decl;
    const v = d.value.trim();
    const m = /^(-?\d*\.?\d+)(px|rem)?$/.exec(v);
    if (m) {
      const n = parseFloat(m[1]);
      return { number: m[2] === 'rem' ? n * 16 : n, unit: m[2] || '', edit: { file: d.file, start: d.start, end: d.end, raw: v }, selector: r.w.selector, file: d.file, at: r.at };
    }
    const a = /^var\(\s*(--[\w-]+)\s*(?:,[^)]*)?\)$/.exec(v);
    if (a && depth < 8) return numberAt(ctx, a[1], r.at, depth + 1);
    return { notNumeric: true, raw: v, selector: r.w.selector, file: d.file };
  };

  /** From a value, through var() aliases and calc wrappers, to a clamp() holding a --X-min / --X-max pair. */
  const findFluid = (ctx, text, at, depth, via) => {
    if (depth > 8) return undefined;
    const names = refs(text);
    if (/clamp\(/i.test(text)) {
      for (const n of names) {
        if (!/-min$/.test(n)) continue;
        const base = n.slice(0, -4);
        if (base === '--viewport' || !names.includes(`${base}-max`)) continue;
        return { expr: text, at, minVar: n, maxVar: `${base}-max`, base: base.slice(2), via };
      }
    }
    for (const n of names) {
      if (via.includes(n)) continue;
      const r = lookup(ctx, n, at);
      if (!r) continue;
      const out = findFluid(ctx, r.w.decl.value, r.at, depth + 1, via.concat(n));
      if (out) return out;
    }
    return undefined;
  };

  /** Every variable an expression uses, transitively, with its raw winning value. */
  const collectVars = (ctx, text, at, out, depth = 0) => {
    if (depth > 8) return out;
    for (const n of refs(text)) {
      if (out[n] !== undefined) continue;
      const r = lookup(ctx, n, at);
      if (!r) continue;
      out[n] = r.w.decl.value;
      collectVars(ctx, r.w.decl.value, r.at, out, depth + 1);
    }
    return out;
  };

  const publicNumber = (n) => (n && !n.notNumeric ? { number: n.number, unit: n.unit, edit: n.edit, selector: n.selector, file: n.file } : undefined);

  /** Where an element's font size comes from, and the numbers that make it fluid. */
  const traceFontSize = (corpus, chain, width) => {
    const ctx = makeCtx(corpus, chain, width);
    const r = lookup(ctx, 'font-size', 0);
    if (!r) return { ok: false, reason: 'no-font-size' };
    const d = r.w.decl;
    const fontSize = { value: d.value, selector: r.w.selector, file: d.file, chainIndex: r.at, inherited: r.at > 0 };
    const fluid = findFluid(ctx, d.value, r.at, 0, []);
    if (!fluid) return { ok: false, reason: 'not-fluid', fontSize };

    const min = numberAt(ctx, fluid.minVar, fluid.at);
    const max = numberAt(ctx, fluid.maxVar, fluid.at);
    const vMin = numberAt(ctx, '--viewport-min', fluid.at);
    const vMax = numberAt(ctx, '--viewport-max', fluid.at);
    const side = (n) => (n ? (n.notNumeric ? { number: null, unit: '', edit: null, selector: n.selector, file: n.file, raw: n.raw } : publicNumber(n)) : undefined);
    return {
      ok: true,
      base: fluid.base,
      fontSize,
      fluid: { expr: fluid.expr, minVar: fluid.minVar, maxVar: fluid.maxVar },
      min: side(min),
      max: side(max),
      vMin: vMin && !vMin.notNumeric ? vMin.number : 320,
      vMax: vMax && !vMax.notNumeric ? vMax.number : 1440,
      vars: collectVars(ctx, fluid.expr, fluid.at, {}),
      editable: !!(min && max && !min.notNumeric && !max.notNumeric),
      via: fluid.via,
    };
  };

  /** One variable as a plain number, wherever the chain's cascade puts it. */
  const resolveNumber = (corpus, chain, name) => publicNumber(numberAt(makeCtx(corpus, chain), name, 0));

  /** One variable's raw winning value on the chain. */
  const valueAt = (corpus, chain, name) => {
    const r = lookup(makeCtx(corpus, chain), name, 0);
    return r ? r.w.decl.value : undefined;
  };

  /**
   * Every fluid pair at the root: the names (without `--`) that have both a `--name-min` and a `--name-max`
   * resolving to numbers, in the order the project declares them. `--viewport-min/max` is not one.
   */
  const fluidPairs = (corpus, chain) => {
    const props = new Set(corpus._props());
    const out = [];
    for (const prop of props) {
      if (!prop.startsWith('--') || !prop.endsWith('-min')) continue;
      const base = prop.slice(0, -4);
      if (base === '--viewport' || !props.has(`${base}-max`)) continue;
      if (resolveNumber(corpus, chain, prop) && resolveNumber(corpus, chain, `${base}-max`)) out.push(base.slice(2));
    }
    return out;
  };

  return { createCorpus, buildChain, rootChain, traceFontSize, resolveNumber, valueAt, fluidPairs };
});
