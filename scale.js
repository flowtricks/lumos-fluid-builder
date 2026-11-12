// Type scales: one ratio that the sizes of every level follow.
//
// Lumos does not define a scale. It has a size for each level (Display, H1 to H6, Large, Main, Small) at the
// narrowest viewport (the minimum) and another at the widest (the maximum). A set of sizes follows a scale
// when each is the Main size times one ratio, raised to a whole number of steps: 16, 19.2, 23, 27.6 at 1.2.
// This file looks at the numbers and says which scale they follow, if any, and works out what they become
// when the ratio changes. Reading and writing the stylesheet is the app's job.
//
//   detect(sizes)            the scale the sizes follow: { ratio, name, steps } or undefined
//   apply(sizes, ratio, st)  the sizes under another ratio, keeping Main and each level's step
//
// Plain script: `window.SC` in the browser, and `globalThis.SC` (also `module.exports` where there is one) in Node.

(function (root, factory) {
  const api = factory();
  if (typeof module === 'object' && module.exports) module.exports = api;
  root.SC = api;
})(typeof self !== 'undefined' ? self : typeof globalThis !== 'undefined' ? globalThis : {}, function () {
  'use strict';

  /** The named scales, as the type scale pickers list them. */
  const SCALES = [
    { ratio: 1.067, name: 'Minor Second' },
    { ratio: 1.125, name: 'Major Second' },
    { ratio: 1.2, name: 'Minor Third' },
    { ratio: 1.25, name: 'Major Third' },
    { ratio: 1.333, name: 'Perfect Fourth' },
    { ratio: 1.414, name: 'Augmented Fourth' },
    { ratio: 1.5, name: 'Perfect Fifth' },
    { ratio: 1.618, name: 'Golden Ratio' },
    { ratio: 1.667, name: 'Major Sixth' },
    { ratio: 1.778, name: 'Minor Seventh' },
    { ratio: 1.875, name: 'Major Seventh' },
    { ratio: 2, name: 'Octave' },
  ];

  /** The level whose size every other level is measured from: Main, for the type scale. */
  const BASE = 'text-main';
  /** The spacing scale's: the smallest space. */
  const SPACING_BASE = 'space-1';
  /** Where each spacing level sits, from Space 1 at the bottom up through the section spacing: one step each. */
  const SPACING_STEPS = {
    'space-1': 0, 'space-2': 1, 'space-3': 2, 'space-4': 3, 'space-5': 4, 'space-6': 5, 'space-7': 6, 'space-8': 7,
    'section-space-small': 8, 'section-space-medium': 9, 'section-space-large': 10, 'section-space-nav-overlap': 11,
  };

  /**
   * Where each level sits, in steps from Main, for sizes that follow no scale yet (so there is nothing to read
   * the steps from): Small one down, Large and H6 one up, then one more step for each heading to Display. Only
   * a starting point. Once the sizes follow a scale, their own steps are used.
   */
  const DEFAULT_STEPS = { display: 7, h1: 6, h2: 5, h3: 4, h4: 3, h5: 2, h6: 1, 'text-large': 1, 'text-main': 0, 'text-small': -1 };

  const RATIO_MIN = 1.001;
  const RATIO_MAX = 4;
  /** A size is on the scale when it is within half a pixel of it: that is what rounding to whole pixels leaves. */
  const TOLERANCE = 0.5 + 1e-9;
  /** At least this many different sizes, Main included, before "follows a scale" means anything. */
  const DISTINCT_MIN = 4;
  /**
   * A scale climbs a step at a time. A designer may skip one, but if neighbouring sizes are further apart than
   * this many steps the numbers are not following a scale: a ratio close enough to 1 will pass through any set
   * of sizes, given enough steps.
   */
  const MAX_GAP = 2;
  /** The smallest ratio that is detected. Below it the steps are finer than a pixel at body sizes. */
  const DETECT_MIN = 1.04;

  const round3 = (n) => Math.round(n * 1000) / 1000;
  const clampRatio = (r) => Math.min(RATIO_MAX, Math.max(RATIO_MIN, r));

  /** The name of a named scale, when the ratio is one (within rounding), else undefined. */
  const nameOf = (ratio) => {
    const hit = SCALES.find((s) => Math.abs(s.ratio - ratio) < 0.0006);
    return hit && hit.name;
  };

  /**
   * How a set of sizes sits on one ratio: each level's whole-number step from Main, and whether some base
   * (near Main's own size) makes every size within half a pixel. Undefined when a size is off the scale.
   */
  const fitTo = (sizes, ratio, baseKey = BASE) => {
    const main = sizes[baseKey];
    const keys = Object.keys(sizes).filter((key) => Number.isFinite(sizes[key]) && sizes[key] > 0);
    const logRatio = Math.log(ratio);
    const steps = {};
    let low = -Infinity;
    let high = Infinity;
    let top = 0;
    let bottom = 0;
    for (const key of keys) {
      const step = key === baseKey ? 0 : Math.round(Math.log(sizes[key] / main) / logRatio);
      const factor = Math.pow(ratio, step);
      low = Math.max(low, (sizes[key] - TOLERANCE) / factor);
      high = Math.min(high, (sizes[key] + TOLERANCE) / factor);
      if (low > high) return undefined;
      steps[key] = step;
      top = Math.max(top, step);
      bottom = Math.min(bottom, step);
    }
    // The sizes in order, each at most MAX_GAP steps above the one before.
    const ordered = [...new Set(keys.map((key) => steps[key]))].sort((a, b) => a - b);
    for (let i = 1; i < ordered.length; i++) if (ordered[i] - ordered[i - 1] > MAX_GAP) return undefined;
    // How far the sizes are from the scale through Main, for choosing between ratios that all fit.
    let squared = 0;
    for (const key of keys) squared += Math.pow(sizes[key] - main * Math.pow(ratio, steps[key]), 2);
    return { steps, span: top - bottom, squared };
  };

  /**
   * The scale a set of sizes follows, if any: { ratio, name, steps }, with `name` undefined for a ratio that has
   * none. `sizes` is { level: size }, with Main among them. Where more than one ratio fits (a ratio and its
   * square root often do), the one with the fewest steps wins, then a named scale, then the closest.
   */
  const detect = (sizes, baseKey = BASE) => {
    const main = sizes[baseKey];
    if (!(main > 0)) return undefined;
    const distinct = new Set(Object.values(sizes).filter((n) => Number.isFinite(n) && n > 0).map((n) => Math.round(n * 100)));
    if (distinct.size < DISTINCT_MIN) return undefined;

    let best;
    const consider = (ratio, named) => {
      const fit = fitTo(sizes, ratio, baseKey);
      if (!fit) return;
      const better =
        !best ||
        fit.span < best.fit.span ||
        (fit.span === best.fit.span && named && !best.named) ||
        (fit.span === best.fit.span && named === best.named && fit.squared < best.fit.squared - 1e-9);
      if (better) best = { ratio, named, fit };
    };
    for (const scale of SCALES) consider(scale.ratio, true);
    for (let ratio = DETECT_MIN; ratio <= 3.0001; ratio += 0.001) consider(round3(ratio), false);
    return best ? { ratio: best.ratio, name: nameOf(best.ratio), steps: best.fit.steps } : undefined;
  };

  /** Whether the sizes follow this ratio (with the steps they have now). */
  const fits = (sizes, ratio, baseKey = BASE) => Boolean(sizes[baseKey] > 0) && fitTo(sizes, ratio, baseKey) !== undefined;

  /** A level's step: the one `detect` found for it, else its place in the default ladder. */
  const stepOf = (key, steps, defaults = DEFAULT_STEPS) => (steps && key in steps ? steps[key] : defaults[key]);

  /**
   * Every size under a ratio, measured from one level (`from`, Main when not given): that level keeps its size
   * and each other level becomes round(size × ratio^(its step − that level's step)), so the levels are
   * multiples of the one chosen. `steps` is each level's step, as `detect` found it. A `from` that has no step
   * (a size that is not one of the levels) falls back to Main. The level it is measured from is not in the result.
   */
  const apply = (sizes, ratio, steps, from, defaults = DEFAULT_STEPS, baseKey = BASE) => {
    const origin = from && sizes[from] > 0 && stepOf(from, steps, defaults) !== undefined ? from : baseKey;
    const size = sizes[origin];
    const out = {};
    if (!(size > 0)) return out;
    const originStep = stepOf(origin, steps, defaults);
    if (originStep === undefined) return out;
    for (const key of Object.keys(sizes)) {
      if (key === origin) continue;
      const step = stepOf(key, steps, defaults);
      if (step === undefined) continue;
      out[key] = Math.round(size * Math.pow(ratio, step - originStep));
    }
    return out;
  };

  /** The named scale after (direction 1) or before (-1) a ratio; the ends stay put. */
  const neighbour = (ratio, direction) => {
    const ratios = SCALES.map((s) => s.ratio);
    if (direction > 0) return ratios.find((r) => r > ratio + 0.0005) ?? ratios[ratios.length - 1];
    const below = ratios.filter((r) => r < ratio - 0.0005);
    return below.length ? below[below.length - 1] : ratios[0];
  };

  /** A ratio as shown: three places at most, no trailing zeros. */
  const format = (ratio) => String(round3(ratio));

  /** Reads a typed ratio; undefined when it is not a number a scale could use. */
  const parse = (text) => {
    const n = parseFloat(String(text).replace(',', '.'));
    return Number.isFinite(n) && n > 1 ? clampRatio(round3(n)) : undefined;
  };

  return { SCALES, BASE, SPACING_BASE, SPACING_STEPS, DEFAULT_STEPS, stepOf, RATIO_MIN, RATIO_MAX, nameOf, detect, fits, apply, neighbour, format, parse, round3, clampRatio };
});
