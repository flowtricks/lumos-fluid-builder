// Shared by the panel (app.js) and the on-canvas controls (hud.js).

(typeof window !== 'undefined' ? window : globalThis).FT = (() => {
  /** Lumos type styles: the variant name in `text-style-<variant>` → the variable prefix. */
  const STYLES = [
    { variant: 'display', key: 'display', label: 'Display' },
    { variant: 'h1', key: 'h1', label: 'H1' },
    { variant: 'h2', key: 'h2', label: 'H2' },
    { variant: 'h3', key: 'h3', label: 'H3' },
    { variant: 'h4', key: 'h4', label: 'H4' },
    { variant: 'h5', key: 'h5', label: 'H5' },
    { variant: 'h6', key: 'h6', label: 'H6' },
    { variant: 'large', key: 'text-large', label: 'Large' },
    { variant: 'main', key: 'text-main', label: 'Main' },
    { variant: 'small', key: 'text-small', label: 'Small' },
  ];

  const byVariant = (variant) => STYLES.find((s) => s.variant === variant);
  /** The spacing scale: the space variables and the section spacing, each a fluid min and max like a font size. */
  const SPACING = [
    // Largest to smallest, as the type scale is: the biggest sections first, down to Space 1.
    { key: 'section-space-nav-overlap', label: 'Nav overlap' },
    { key: 'section-space-large', label: 'Section large' },
    { key: 'section-space-medium', label: 'Section medium' },
    { key: 'section-space-small', label: 'Section small' },
    ...[8, 7, 6, 5, 4, 3, 2, 1].map((n) => ({ key: `space-${n}`, label: `Space ${n}` })),
  ];

  const byKey = (key) => STYLES.find((s) => s.key === key) || SPACING.find((s) => s.key === key);

  /** Font size in px at a viewport width, as the site's clamp() works it out. */
  const sizeAt = (width, min, max, vMin, vMax) => {
    if (vMax === vMin) return max;
    const raw = min + ((max - min) / (vMax - vMin)) * (width - vMin);
    const lo = Math.min(min, max);
    const hi = Math.max(min, max);
    return Math.min(hi, Math.max(lo, raw));
  };

  const fmt = (n, digits = 2) => {
    if (!Number.isFinite(n)) return '';
    return String(Number(n.toFixed(digits)));
  };

  // ── Accessibility check ───────────────────────────────────────────────────
  //
  // Ported from Stacki's own variables panel (src/features/variables/fluid.ts), so the
  // app and the panel agree to the digit. A fluid value is a clamp() of a floor, a
  // linear term that grows with the viewport, and a ceiling. Two ways it fails a reader
  // who zooms:
  //
  //   error    max is more than 2.5x min, so the value never reaches 2x its size at
  //            500% zoom (WCAG 1.4.4).
  //   warning  the rem part of the linear term is zero or less, so the value ignores
  //            the reader's font-size setting, or shrinks as it grows.
  //
  // The numbers are read out of the expression, with its variables substituted, so it
  // is checked on what it computes to, not on what it is named.

  const FLUID_LINK = 'https://www.smashingmagazine.com/2023/11/addressing-accessibility-concerns-fluid-type/#conclusion';
  const FLUID_COPY = {
    error: 'Does not reach 2x of its original size at a 500% zoom. Reduce difference between max and min variable size.',
    warning: 'Shrinks when increasing zoom. Increase difference between max and min viewport size.',
  };

  const VAR_RE = /var\(\s*(--[\w-]+)\s*(?:,([^()]*(?:\([^()]*\)[^()]*)*))?\)/g;

  /** A value with its variables substituted. `overrides` wins over `values`: what is being dragged, not yet saved. */
  const resolveValue = (value, values, overrides, depth = 0) => {
    if (depth > 8) return String(value);
    const next = String(value).replace(VAR_RE, (whole, name, fallback) => {
      const found = overrides && overrides[name] !== undefined ? overrides[name] : values && values[name];
      if (found !== undefined) return found;
      return fallback !== undefined ? fallback.trim() : whole;
    });
    return next === String(value) ? next : resolveValue(next, values, overrides, depth + 1);
  };

  /** Splits `a, b, c` at the top level. */
  const splitArgs = (text) => {
    const out = [];
    let depth = 0;
    let start = 0;
    for (let i = 0; i < text.length; i++) {
      const ch = text[i];
      if (ch === '(') depth++;
      else if (ch === ')') depth--;
      else if (ch === ',' && depth === 0) {
        out.push(text.slice(start, i));
        start = i + 1;
      }
    }
    out.push(text.slice(start));
    return out;
  };

  /** Arithmetic in rem, with `vw` as a symbol-free number the caller scales. Undefined when it cannot be read. */
  const evaluate = (text, viewportWidth) => {
    const source = String(text);
    if (source.length > 4000) return undefined;
    let pos = 0;
    const skip = () => {
      while (pos < source.length && /\s/.test(source[pos])) pos++;
    };
    const factor = (depth) => {
      if (depth > 32) return undefined;
      skip();
      if (source[pos] === '(') {
        pos++;
        const value = expression(depth + 1);
        skip();
        if (source[pos] !== ')') return undefined;
        pos++;
        return value;
      }
      if (source[pos] === '-') {
        pos++;
        const value = factor(depth + 1);
        return value === undefined ? undefined : -value;
      }
      const match = /^([0-9]*\.?[0-9]+)(px|rem|em|vw|vh|%)?/.exec(source.slice(pos));
      if (!match || !match[1]) return undefined;
      pos += match[0].length;
      const number = parseFloat(match[1]);
      switch (match[2]) {
        case undefined:
        case 'rem':
          return number;
        case 'px':
          return number / 16;
        case 'vw':
          return number * viewportWidth;
        default:
          return undefined;
      }
    };
    const term = (depth) => {
      let value = factor(depth);
      for (let n = 0; n <= source.length; n++) {
        skip();
        const op = source[pos];
        if (op !== '*' && op !== '/') return value;
        pos++;
        const right = factor(depth);
        if (right === undefined || value === undefined) return undefined;
        value = op === '*' ? value * right : value / right;
      }
      return undefined;
    };
    const expression = (depth) => {
      let value = term(depth);
      for (let n = 0; n <= source.length; n++) {
        skip();
        const op = source[pos];
        if (op !== '+' && op !== '-') return value;
        pos++;
        const right = term(depth);
        if (right === undefined || value === undefined) return undefined;
        value = op === '+' ? value + right : value - right;
      }
      return undefined;
    };
    const value = expression(0);
    skip();
    return pos === source.length ? value : undefined;
  };

  /** What a resolved fluid clamp() is worth to a reader who zooms: { status: 'ok' | 'warning' | 'error', … } or undefined when it is not one. */
  const fluidCheck = (resolved) => {
    const match = /^clamp\(([\s\S]*)\)$/i.exec(String(resolved || '').trim());
    if (!match) return undefined;
    const args = splitArgs(match[1]);
    if (args.length !== 3) return undefined;
    const min = evaluate(args[0], 0);
    const max = evaluate(args[2], 0);
    // The middle term read as `rem + coefficient * vw`: its value with no viewport is the
    // rem part, and the step to one vw is the coefficient.
    const base = evaluate(args[1], 0);
    const atOne = evaluate(args[1], 1);
    if ([min, max, base, atOne].some((n) => n === undefined || !Number.isFinite(n))) return undefined;
    const vw = atOne - base;
    if (vw === 0) return undefined; // a clamp, but not a fluid one
    // Inverted values are read the way they render.
    const low = Math.min(min, max);
    const high = Math.max(min, max);
    const accessible = high <= 2.5 * low;
    const zooms = base > 0;
    return { status: !accessible ? 'error' : !zooms ? 'warning' : 'ok', min: low, max: high, rem: base, vw, link: FLUID_LINK };
  };

  return { STYLES, SPACING, byVariant, byKey, sizeAt, fmt, resolveValue, splitArgs, evaluate, fluidCheck, FLUID_COPY, FLUID_LINK };
})();
