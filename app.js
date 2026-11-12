// Lumos Fluid Builder: select any element with a fluid font size, drag its min and max on the canvas.
//
// Nothing here assumes a Heading or a Paragraph. The app reads the project's stylesheets
// (src/**/*.css and the <style> blocks of src/**/*.astro) into a corpus, then traces the
// selected element's font size through the cascade: its own classes, its parents, the root,
// and any variable on the way (`font-size: var(--card-title)`, `--card-title: var(--h3)`,
// `--h3: clamp(… var(--h3-min) … var(--h3-max) …)`). Whatever declaration holds the min and
// max is the one it edits, one undo step per commit, in whichever file it lives.
//
// The tracer is trace.js. The accessibility check is Stacki's own, ported in shared.js.
// The controls are a card (hud.html) in a frame at the top of the panel. It has no SDK of its own:
// it and the app talk by postMessage.

(() => {

  const $ = (id) => document.getElementById(id);
  const esc = (s) => String(s).replace(/[&<>"']/g, (c) => `&#${c.charCodeAt(0)};`);

  const corpus = TR.createCorpus();

  /** Everything the app knows. */
  const app = {
    scale: 1, // canvas zoom
    width: 1440, // the canvas's width in CSS px (media queries are read at this width)
    viewH: 900,
    nodeId: undefined,
    lineage: undefined, // root → selected node, for the tracer
    view: undefined, // the open page's tree, cached
    target: undefined, // { key, label, source, trace } or { message }
    pinned: undefined, // a type scale level chosen from the list (a style key), until the next selection
    compare: true, // the graph also draws the other levels, greyed (on unless it was turned off and that was remembered)
    mode: 'type', // the group the list shows: its id ('type' and 'spacing' are the built-in ones, 'other' the rest)
    scaleOff: {}, // by mode and side: a scale was set to None, so its sizes are not read as following one
    unlocked: {}, // by mode and side: the scale lock is off, so its levels are free of the ratio
    lockCtx: undefined, // the scales that link the other levels to the one being dragged, taken before the drag changes anything
    applied: {}, // by mode and side: the ratio last set, to show it as set when the sizes allow more than one // the ratio last set for each side, to show it as set when sizes allow more than one
    note: undefined, // why the selected element has no fluid size, shown while the card falls back to a level
    styles: [], // the Lumos type scale at the root: { key, label, min, max, status }
    saving: false,
    loaded: false,
    groups: undefined, // settings: the groups, each { id, name, kind, names } (names without -- and -min/-max, in order); undefined = Typography and Spacing as Lumos has them
    pairs: [], // every name the project has a -min and a -max for, once read
    cache: {}, // the levels as last read, to draw the list before the project is read again
    canEdit: true, // this app's `edit-type-scale` permission for the person's role
  };

  // ── Role ──────────────────────────────────────────────────────────────────

  // A Stacki that does not resolve app permissions sends none: the manifest default (allowed) applies.
  const applyRole = (role) => {
    const granted = role && role.permissions && typeof role.permissions === 'object' ? role.permissions : {};
    app.canEdit = (role && role.isAdmin) || granted['edit-type-scale'] !== false;
    render();
  };

  // ── Project stylesheets ───────────────────────────────────────────────────

  const isSource = (path) => /\.(css|astro)$/.test(path);

  const listSources = async (dir = 'src', depth = 0, out = []) => {
    const { entries } = await stacki.files.list({ dir }).catch(() => ({ entries: [] }));
    const nested = [];
    for (const entry of entries) {
      if (entry.kind === 'file') {
        if (isSource(entry.path)) out.push(entry.path);
      } else if (depth < 8 && !/(^|\/)(node_modules|\.git)(\/|$)/.test(entry.path)) {
        nested.push(entry.path);
      }
    }
    await Promise.all(nested.map((path) => listSources(path, depth + 1, out)));
    return out;
  };

  const readInto = async (path) => {
    try {
      const { content } = await stacki.files.read({ path });
      corpus.setFile(path, content);
    } catch {
      corpus.removeFile(path);
    }
  };

  /** Reads every stylesheet and component into the tracer, a dozen at a time. */
  const loadCorpus = async () => {
    const paths = await listSources();
    for (let i = 0; i < paths.length; i += 32) await Promise.all(paths.slice(i, i + 32).map(readInto));
    app.loaded = true;
  };

  /** The stylesheets that changed, or all of them when Stacki does not say which. */
  const syncCorpus = async (paths) => {
    if (!paths || !paths.length) return loadCorpus();
    await Promise.all(paths.filter(isSource).map(readInto));
  };

  // ── The Lumos type scale, at the root ─────────────────────────────────────

  const collectVars = (expr, chain, out = {}, depth = 0) => {
    if (depth > 6) return out;
    for (const match of String(expr).matchAll(/var\(\s*(--[\w-]+)/g)) {
      const name = match[1];
      if (name in out) continue;
      const value = TR.valueAt(corpus, chain, name);
      if (value === undefined) continue;
      out[name] = value;
      collectVars(value, chain, out, depth + 1);
    }
    return out;
  };

  // ── Which variables a scale lists ─────────────────────────────────────────
  //
  // A level is a variable pair, `--name-min` and `--name-max`; its key is the name. Each scale lists the Lumos
  // levels unless settings say otherwise: any pair the project has, in any order, largest first.

  // A group is a list of levels with a kind: 'type' (font sizes, which an element's own size can pick and the
  // accessibility check applies to), 'space', or 'other' (the rest: whatever has a -min and a -max and is in no group).
  const BUILT_IN = [
    { id: 'type', name: 'Typography', kind: 'type', names: FT.STYLES.map((s) => s.key) },
    { id: 'spacing', name: 'Spacing', kind: 'space', names: FT.SPACING.map((s) => s.key) },
  ];
  const OTHER = { id: 'other', name: 'Other', kind: 'other' };
  const groupsOf = () => app.groups || BUILT_IN;
  const allGroups = () => [...groupsOf(), OTHER];
  const groupOf = (id = app.mode) => allGroups().find((g) => g.id === id) || allGroups()[0];
  const kindOf = (id = app.mode) => groupOf(id).kind;
  /** The names in no group: what the project has pairs for, and nothing lists. */
  const otherNames = () => {
    if (!app.loaded) return (app.cache.other || []).map((c) => c.key);
    const taken = new Set(groupsOf().flatMap((g) => g.names));
    return app.pairs.filter((name) => !taken.has(name));
  };
  const namesOf = (id) => (id === 'other' ? otherNames() : (groupsOf().find((g) => g.id === id) || { names: [] }).names);
  /** What a scale is called in an undo step: "type", "spacing", or a group's own name. */
  const scaleWord = () => (app.mode === 'type' ? 'type' : app.mode === 'spacing' ? 'spacing' : groupOf().name.toLowerCase());

  /** A level's label: Lumos' own for its levels, else the name read as words ("hero-title" → "Hero title"). */
  const labelFor = (name) => {
    const known = FT.byKey(name);
    if (known) return known.label;
    const words = name.replace(/[-_]+/g, ' ').trim();
    return words.charAt(0).toUpperCase() + words.slice(1);
  };
  const levelsOf = (mode) => namesOf(mode).map((key) => ({ key, label: labelFor(key) }));
  const slotByVar = (name) => levelsOf(app.mode).find((level) => level.key === name);

  /** The levels of the current scale as last seen (kept in storage), else bare rows: the list is drawn before the project is read. */
  const placeholderStyles = () => {
    const cached = new Map((app.cache[app.mode] || []).map((c) => [c.key, c]));
    return levelsOf(app.mode).map((style) => {
      const c = cached.get(style.key);
      return { key: style.key, label: style.label, min: c ? c.min : 0, max: c ? c.max : 0, status: c ? c.status : 'ok', order: [], badMin: false, badMax: false, pending: !c };
    });
  };

  let snapshotTimer;
  const saveSnapshot = () => {
    clearTimeout(snapshotTimer);
    snapshotTimer = setTimeout(() => {
      const value = JSON.stringify({ ...app.cache, width: app.width });
      stacki.storage.set({ key: 'snapshot', value, scope: 'local' }).catch(() => {});
    }, 400);
  };

  const loadScale = () => {
    if (!app.loaded) {
      app.styles = placeholderStyles();
      markOrder();
      return;
    }
    const chain = TR.rootChain(corpus, app.width);
    if (app.mode === 'other') app.pairs = TR.fluidPairs(corpus, chain);
    app.styles = [];
    for (const style of levelsOf(app.mode)) {
      const name = style.key;
      const min = TR.resolveNumber(corpus, chain, `--${name}-min`);
      const max = TR.resolveNumber(corpus, chain, `--${name}-max`);
      if (!min || !max) continue;
      const expr = TR.valueAt(corpus, chain, `--${name}`);
      // The accessibility check is about type: a reader's zoom has no use for it on a space.
      const check = expr && kindOf() === 'type' ? FT.fluidCheck(FT.resolveValue(expr, collectVars(expr, chain), {})) : undefined;
      app.styles.push({ key: style.key, label: style.label, min: min.number, max: max.number, status: check ? check.status : 'ok', order: [], badMin: false, badMax: false });
    }
    markOrder();
    app.cache[app.mode] = app.styles.map(({ key, min, max, status }) => ({ key, min, max, status }));
    saveSnapshot();
  };

  // A larger level should always be larger than the one below it. Each is compared with the next level
  // down in its own run (Display to H6, then Large to Small), at the minimum and at the maximum. Equal is
  // allowed; a level smaller than the one below it, at either end, is the problem, and its row is marked,
  // with the number that is too small.
  // Each run is compared in list order, larger first. The body sizes are a run of their own, as in Lumos; so is
  // each spacing scale.
  const BODY_SIZES = new Set(['text-large', 'text-main', 'text-small']);
  const runsOf = (mode) => {
    const names = namesOf(mode);
    if (mode === 'other') return []; // unrelated variables: no order between them
    return mode === 'type' ? [names.filter((n) => !BODY_SIZES.has(n)), names.filter((n) => BODY_SIZES.has(n))] : [names];
  };
  const markOrder = () => {
    for (const s of app.styles) {
      s.order = [];
      s.badMin = false;
      s.badMax = false;
    }
    const byKey = new Map(app.styles.map((s) => [s.key, s]));
    for (const run of runsOf(app.mode)) {
      const present = run.map((key) => byKey.get(key)).filter(Boolean);
      for (let i = 0; i + 1 < present.length; i++) {
        const larger = present[i];
        const smaller = present[i + 1];
        const where = [];
        // The larger level is the one at fault: its number is too small. Only its row is marked.
        if (larger.min < smaller.min) {
          where.push(`its minimum (${FT.fmt(larger.min)}px, against ${FT.fmt(smaller.min)}px)`);
          larger.badMin = true;
        }
        if (larger.max < smaller.max) {
          where.push(`its maximum (${FT.fmt(larger.max)}px, against ${FT.fmt(smaller.max)}px)`);
          larger.badMax = true;
        }
        if (!where.length) continue;
        const message = `${larger.label} is smaller than ${smaller.label} at ${where.join(' and ')}. A larger level should always be larger.`;
        larger.order.push(message);
      }
    }
    // A range that runs backwards (its minimum above its maximum) is wrong whatever the scales say. It can
    // come from setting scales whose steps fall further at the top than the bottom.
    for (const s of app.styles) {
      if (s.min > s.max) {
        s.order.push(`${s.label}'s minimum (${FT.fmt(s.min)}px) is larger than its maximum (${FT.fmt(s.max)}px).`);
        s.badMin = true;
        s.badMax = true;
      }
    }
  };

  // ── Selection → traced font size ──────────────────────────────────────────

  /** Where the size comes from, in a few words. */
  const describe = (trace) => {
    const f = trace.fontSize;
    let text = f.inherited ? `inherited from ${f.selector}` : f.selector;
    const at = trace.min.selector;
    if (at && at !== ':root' && at !== 'html' && at !== f.selector) text += ` · min/max on ${at}`;
    return text;
  };

  /** What a selection amounts to, for the panel and the canvas. */
  const toTarget = (trace) => {
    if (!trace) return undefined;
    if (!trace.ok) {
      const f = trace.fontSize;
      const message =
        trace.reason === 'no-font-size'
          ? 'No font size is set on this element or the ones above it.'
          : `Font size is ${f ? `${f.value} (${f.selector})` : 'fixed'}, not fluid.`;
      return { message };
    }
    const slot = slotByVar(trace.base);
    return { key: slot ? slot.key : trace.base, label: slot ? slot.label : trace.base, source: describe(trace), trace };
  };

  const findLineage = (nodes, id, trail = []) => {
    for (let index = 0; index < (nodes || []).length; index++) {
      const node = nodes[index];
      const here = [...trail, { node, siblings: nodes, index }];
      if (node.id === id) return here;
      const found = findLineage(node.children, id, here);
      if (found) return found;
    }
    return undefined;
  };

  const getView = async () => {
    if (!app.view) app.view = await stacki.page.get().catch(() => undefined);
    return app.view;
  };

  const lineageOf = async (nodeId) => {
    const view = await getView();
    const found = view && findLineage(view.nodes, nodeId);
    if (found) return found;
    // A node the open page's tree does not hold (inside a component, say): the node alone.
    const node = await stacki.node.get({ nodeId }).catch(() => undefined);
    return node ? [{ node: { children: [], ...node }, siblings: [node], index: 0 }] : undefined;
  };

  /** A level of the type scale as a trace of its own: its variables at the root, no element involved. */
  const traceLevel = (key) => {
    const name = key;
    const chain = TR.rootChain(corpus, app.width);
    const min = TR.resolveNumber(corpus, chain, `--${name}-min`);
    const max = TR.resolveNumber(corpus, chain, `--${name}-max`);
    if (!min || !max) return undefined;
    const expr = TR.valueAt(corpus, chain, `--${name}`) || '';
    const viewport = (name, fallback) => {
      const found = TR.resolveNumber(corpus, chain, name);
      return found ? found.number : fallback;
    };
    return {
      ok: true,
      base: name,
      fontSize: { value: `var(--${name})`, selector: ':root', file: min.file, chainIndex: 0, inherited: false },
      fluid: { expr, minVar: `--${name}-min`, maxVar: `--${name}-max` },
      min,
      max,
      vMin: viewport('--viewport-min', 320),
      vMax: viewport('--viewport-max', 1440),
      vars: expr ? collectVars(expr, chain) : {},
      editable: Boolean(min.edit && max.edit),
      via: [],
    };
  };

  /**
   * The level the card opens on when nothing else chooses one: the smallest, when the sizes follow a scale (it is
   * the one that sets the others), else the first in the list.
   */
  const defaultLevel = () => {
    const side = scaleOf('min') ? 'min' : scaleOf('max') ? 'max' : undefined;
    return side ? scaleOrigin(side) : app.styles[0].key; // the smallest, which sets the others, else the first (the largest)
  };

  const retrace = () => {
    app.note = undefined;
    if (!app.loaded) {
      app.target = undefined; // nothing to trace yet: the card shows the level chosen, or the first, as a placeholder
      return;
    }
    if (kindOf() !== 'type') {
      // No element has a "space size" the way it has a font size: the card shows the level chosen from the list, else the first.
      const key = app.pinned && app.styles.some((s) => s.key === app.pinned) ? app.pinned : app.styles.length ? defaultLevel() : undefined;
      app.target = key ? toTarget(traceLevel(key)) : undefined;
      return;
    }
    if (app.pinned) {
      app.target = toTarget(traceLevel(app.pinned));
      return;
    }
    // An element with a fluid size comes first. With none (nothing selected, or one that is not fluid) the
    // card shows the first level of the type scale, so there is always something to edit.
    let traced;
    if (app.lineage) {
      const chain = TR.buildChain(corpus, app.lineage, app.width);
      traced = toTarget(TR.traceFontSize(corpus, chain, app.width));
    }
    if (traced && traced.trace) {
      app.target = traced;
      return;
    }
    app.note = traced && traced.message; // why the selected element has no fluid size, if one is selected
    app.target = (app.styles.length && toTarget(traceLevel(defaultLevel()))) || traced;
  };

  /** Switches the card to a level of the type scale, whatever is selected on the page. */
  const pinLevel = async (key) => {
    app.lockCtx = undefined;
    if (live.running || live.writes) return; // a drag is still being saved
    app.pinned = key;
    retrace();
    render();
    await draw();
    // Clear the page's selection, so clicking an element again, even the one that was selected, is a
    // new selection and takes over from the level chosen here.
    if (app.nodeId !== undefined) {
      app.nodeId = undefined;
      app.lineage = undefined;
      await stacki.selection.set({ nodeId: undefined }).catch(() => {});
    }
  };

  const select = async ({ nodeId }) => {
    app.lockCtx = undefined;
    if (kindOf() !== 'type') {
      app.nodeId = nodeId; // a font size is not what is being edited; the chosen level stays
      return;
    }
    // Nothing selected (a click on empty canvas, or the selection cleared when a level was chosen) leaves
    // a chosen level as it is; selecting an element takes over from it.
    if (nodeId === undefined && app.pinned) {
      app.nodeId = undefined;
      app.lineage = undefined;
      return;
    }
    app.pinned = undefined;
    app.nodeId = nodeId;
    app.target = undefined;
    app.lineage = undefined;
    if (nodeId !== undefined) {
      const lineage = await lineageOf(nodeId);
      if (app.nodeId !== nodeId) return; // selection moved on
      app.lineage = lineage;
    }
    retrace(); // an element's own size, else the first level of the type scale
    render();
    await draw();
  };

  // ── Saving ────────────────────────────────────────────────────────────────

  const textFor = (unit, number) => {
    if (unit === 'rem') return `${FT.fmt(number / 16, 4)}rem`;
    return `${FT.fmt(number)}${unit === 'px' ? 'px' : ''}`;
  };

  // Stacki lets an app change 120 files a minute. Every write counts, live ones too, so they are paced:
  // at most one every LIVE.every ms, LIVE.perDrag in one drag, and never past LIVE.windowCap in any
  // rolling minute, which leaves the rest for the save at the end. Past a limit the page simply stops
  // following the pointer until release; the sliders carry on.
  const LIVE = { every: 250, perDrag: 24, windowCap: 90, settle: 450 };
  const writeLog = [];
  const writesThisMinute = () => {
    const cut = Date.now() - 60000;
    while (writeLog.length && writeLog[0] < cut) writeLog.shift();
    return writeLog.length;
  };
  const rateLimited = (error) => /at most|a minute|try again/i.test(String((error && error.message) || error));
  const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

  /** The edits a pair of values makes, by file. */
  const filesFor = (t, min, max, linked) => {
    const files = new Map();
    const add = (edit, text) => {
      const list = files.get(edit.file) || [];
      list.push({ edit, text });
      files.set(edit.file, list);
    };
    for (const [part, value] of [[t.min, min], [t.max, max]]) add(part.edit, textFor(part.unit, value));
    for (const { edit, text } of linked || []) add(edit, text); // the other levels a locked scale ties to this one
    return files;
  };

  /**
   * Writes the values. Each file is built from `baseline` when given (its content before the first live
   * write, so the traced offsets still hold however long the numbers have got), else from what is on
   * disk now. Returns how many writes Stacki applied.
   */
  const applyValues = async (t, min, max, label, baseline, setCorpus, linked) => {
    let applied = 0;
    for (const [path, list] of filesFor(t, min, max, linked)) {
      let base = baseline ? baseline.get(path) : undefined;
      if (base === undefined) {
        base = (await stacki.files.read({ path })).content;
        if (baseline) baseline.set(path, base);
      }
      let next = base;
      // Last edit first, so the earlier offsets still hold.
      for (const { edit, text } of list.sort((x, y) => y.edit.start - x.edit.start)) {
        if (next.slice(edit.start, edit.end) !== edit.raw) throw Object.assign(new Error('The stylesheet changed. Select the element again.'), { stale: true });
        next = next.slice(0, edit.start) + text + next.slice(edit.end);
      }
      const outcome = await stacki.files.write({ path, content: next, label });
      if (!outcome.applied) throw Object.assign(new Error(outcome.reason || 'The change was not applied.'), { refused: true });
      applied++;
      writeLog.push(Date.now());
      if (setCorpus) corpus.setFile(path, next);
    }
    return applied;
  };

  // ── Live preview ──────────────────────────────────────────────────────────
  //
  // While a slider is dragged the values are written to the stylesheet as they go, so the page's type
  // follows the pointer. The writes are paced to what the canvas can show: one at a time, the next not
  // before the page has had a moment to take the last (its own change event, or LIVE.settle ms), and
  // never more than a few a second. On release the final value is written straight from the file as it
  // was before the drag, so the page goes to it directly and does not replay the drag.

  const live = { baseline: new Map(), writes: 0, wanted: undefined, running: undefined, original: undefined, lastAt: 0, off: false, ack: undefined };

  /** The page took a write: its own change event arrived. */
  const noteChange = () => {
    if (live.ack) live.ack();
  };

  const runLive = async (t, label, key) => {
    try {
      while (live.wanted) {
        // Paced: wait out the gap since the last write; the newest wanted value is the one that goes.
        const wait = live.lastAt + LIVE.every - Date.now();
        if (wait > 0) await sleep(wait);
        if (!live.wanted) break;
        if (live.writes >= LIVE.perDrag || writesThisMinute() >= LIVE.windowCap) {
          live.off = true;
          live.wanted = undefined;
          break;
        }
        const { min, max } = live.wanted;
        live.wanted = undefined;
        live.lastAt = Date.now();
        // Ready to hear the page take it before the write goes out, so the event cannot be missed.
        const taken = new Promise((resolve) => {
          live.ack = resolve;
          setTimeout(resolve, LIVE.settle);
        });
        live.writes += await applyValues(t, min, max, `${label} ${kindOf() === 'type' ? 'font size' : 'size'} (live)`, live.baseline, false, lockedEdits(key, min, max));
        t.min.number = min;
        t.max.number = max;
        render();
        await taken; // backpressure: not another write until the page has had this one
        live.ack = undefined;
      }
    } catch (error) {
      if (rateLimited(error)) live.off = true;
      live.wanted = undefined; // the release will put things right from the file as it was
    }
  };

  /** The type scale as it would be with the values being dragged: row, order flags and check, at once. */
  let draftTimer;
  let draftWanted;
  const draftScale = (key, min, max) => {
    draftWanted = { key, min, max };
    if (draftTimer) return;
    draftTimer = setTimeout(() => {
      draftTimer = undefined;
      const { key: level, min: lo, max: hi } = draftWanted;
      const style = app.styles.find((s) => s.key === level);
      const t = active() ? app.target.trace : undefined;
      if (!style || !t) return;
      style.min = lo;
      style.max = hi;
      const linked = lockedValues(level, lo, hi);
      for (const side of Object.keys(linked)) {
        for (const [other, size] of Object.entries(linked[side])) {
          const row = app.styles.find((s) => s.key === other);
          if (row) row[side] = size;
        }
      }
      const check = t.fluid.expr ? FT.fluidCheck(FT.resolveValue(t.fluid.expr, t.vars, { [t.fluid.minVar]: String(lo), [t.fluid.maxVar]: String(hi) })) : undefined;
      style.status = check ? check.status : 'ok';
      markOrder();
      renderScale();
      renderScaleFields();
    }, 12);
  };

  const previewLive = (min, max) => {
    const t = active() ? app.target.trace : undefined;
    if (!t || !t.editable || !app.canEdit || live.off) return;
    if (!live.original) live.original = { min: t.min.number, max: t.max.number };
    app.saving = true;
    live.wanted = { min, max };
    if (!live.running) {
      const label = app.target.label;
      live.running = runLive(t, label, app.target.key).finally(() => {
        live.running = undefined;
      });
    }
  };

  /**
   * Ends a live preview: lets the write in flight finish, forgets the rest, and hands back the files as
   * they were before it began (the baseline), or undefined when it wrote nothing.
   */
  const endLive = async () => {
    live.wanted = undefined;
    if (live.running) await live.running;
    const { baseline, writes, original } = live;
    live.baseline = new Map();
    live.writes = 0;
    live.original = undefined;
    live.off = false;
    live.lastAt = 0;
    live.ack = undefined;
    return writes ? { baseline, original } : undefined;
  };

  /** A drag that came back to where it began: write the original files back. */
  const cancelLive = async () => {
    try {
      const ended = await endLive();
      if (ended) {
        for (const [path, content] of ended.baseline) {
          const outcome = await stacki.files.write({ path, content, label: `${app.target ? app.target.label : 'Font'} font size` });
          if (outcome.applied) writeLog.push(Date.now());
          corpus.setFile(path, content);
        }
        const t = active() ? app.target.trace : undefined;
        if (t && ended.original) {
          t.min.number = ended.original.min;
          t.max.number = ended.original.max;
        }
      }
    } catch {
      await syncCorpus().catch(() => {}); // could not tell: take the files as they are
    } finally {
      app.saving = false;
    }
    await reselect();
  };

  const save = async (min, max) => {
    // A drag may have written live values already: build the final files from what they were before it.
    const ended = live.writes || live.running || live.baseline.size ? await endLive() : undefined;
    if (ended) app.saving = true;
    const target = app.target;
    const t = target && target.trace;
    if (!t || !t.editable) {
      app.saving = false;
      return;
    }
    if (!app.canEdit) {
      app.saving = false;
      await post({ text: 'Your role can view the type scale but not edit it.', tone: 'error' });
      return;
    }
    if (!ended && t.min.number === min && t.max.number === max) {
      app.saving = false;
      await reselect();
      return;
    }

    app.saving = true;
    const before = { min: t.min.number, max: t.max.number };
    // Optimistic, so the canvas and panel follow at once.
    t.min.number = min;
    t.max.number = max;
    render();

    try {
      // The limit is per minute, so a save that meets it waits it out rather than failing a drag's worth of work.
      for (let attempt = 0; ; attempt++) {
        try {
          await applyValues(t, min, max, `${target.label} ${kindOf() === 'type' ? 'font size' : 'size'} ${FT.fmt(min)}–${FT.fmt(max)}px`, ended ? ended.baseline : undefined, true, lockedEdits(target.key, min, max));
          break;
        } catch (error) {
          if (!rateLimited(error) || attempt >= 5) throw error;
          await sleep(2000 * (attempt + 1));
        }
      }
      app.saving = false;
      await reselect();
      await post();
    } catch (error) {
      app.saving = false;
      t.min.number = before.min;
      t.max.number = before.max;
      await syncCorpus([...new Set([t.min.edit.file, t.max.edit.file])]).catch(() => {});
      await reselect().catch(() => {});
      const text = error && error.code === 'role-denied' ? 'Your role cannot edit stylesheets (needs code:edit).' : String((error && error.message) || error);
      await post({ text, tone: 'error' });
    }
  };

  /** Traces the same selection again, after the stylesheets moved under it. */
  const reselect = async () => {
    app.lockCtx = undefined;
    loadScale();
    retrace();
    render();
    await draw();
  };

  // ── The card ──────────────────────────────────────────────────────────────

  const active = () => Boolean(app.target && app.target.trace);

  const toCard = (message) => {
    const target = $('card').contentWindow;
    if (target) target.postMessage({ source: 'fluid-app', message }, '*');
  };

  /** Shows the card for the selection, or hides it, and hands it its state. */
  const draw = async () => {
    await post();
  };

  /** Which sides of the level at `key` are locked: it is one of the levels, the side has a scale with its lock on, and it is not the smallest. */
  const lockOf = (key) => {
    const level = app.styles.some((s) => s.key === key);
    return { min: level && scaleLocked('min') && scaleOrigin('min') !== key, max: level && scaleLocked('max') && scaleOrigin('max') !== key };
  };

  /** The panel's input background as drawn, for the card, which cannot see the panel's theme. Undefined when it is transparent. */
  const inputColour = () => {
    const box = document.querySelector('.scale-box');
    const colour = box ? getComputedStyle(box).backgroundColor : '';
    return colour && colour !== 'rgba(0, 0, 0, 0)' && colour !== 'transparent' ? colour : undefined;
  };

  /** Hands the card its state. */
  /** The card before there is a level to edit (still loading, or the selection has no editable size): the chosen level, or the first, shown but not editable. */
  const placeholder = () => {
    const key = app.pinned && app.styles.some((s) => s.key === app.pinned) ? app.pinned : app.styles.length ? defaultLevel() : undefined;
    const level = app.styles.find((s) => s.key === key) || app.styles[0];
    const min = level && !level.pending ? level.min : 16;
    const max = level && !level.pending ? level.max : 16;
    return {
      style: { key: level ? level.key : '', label: level ? level.label : '', source: '' },
      min, max, vMin: 320, vMax: 1440, width: app.width,
      expr: '', vars: {}, minVar: undefined, maxVar: undefined,
      editable: false,
      loading: !app.loaded || Boolean(level && level.pending),
      levels: app.styles.map(({ key: k, label: name, min: a, max: b }) => ({ key: k, label: name, min: a, max: b })),
      compare: app.compare,
      lock: { min: false, max: false },
      track: inputColour(),
    };
  };

  const post = async (status) => {
    if (!active()) toCard({ type: 'state', status, state: placeholder() });
    if (active()) {
      const { key, label, source, trace: t } = app.target;
      toCard({
        type: 'state',
        status,
        state: {
          style: { key, label, source },
          min: t.min.number,
          max: t.max.number,
          vMin: t.vMin,
          vMax: t.vMax,
          width: app.width,
          // What the card needs to run the accessibility check on a value still being dragged.
          expr: kindOf() === 'type' ? t.fluid.expr : '', // no accessibility check on a space
          vars: t.vars,
          minVar: t.fluid.minVar,
          maxVar: t.fluid.maxVar,
          editable: Boolean(t.editable && app.canEdit),
          // For the compare mode: every level's range, and whether it is on.
          levels: app.styles.map(({ key: level, label: name, min, max }) => ({ key: level, label: name, min, max })),
          compare: app.compare,
          // Which of this level's sliders are tied to the scale (and so read-only): the others on a locked side.
          lock: lockOf(key),
          track: inputColour(), // the slider tracks take the panel's input colour
        },
      });
    }
    if (status) showStatus(status);
  };

  const readViewport = async () => {
    const vp = await stacki.canvas.getViewport().catch(() => undefined);
    if (vp) {
      app.width = vp.widthPx;
      app.viewH = vp.heightPx;
      app.scale = vp.scale || 1;
    }
  };

  // ── Panel ─────────────────────────────────────────────────────────────────

  let statusTimer;
  const showStatus = ({ text, tone }) => {
    const el = $('status');
    el.textContent = text;
    el.dataset.tone = tone || '';
    el.hidden = false;
    clearTimeout(statusTimer);
    if (tone !== 'error') statusTimer = setTimeout(() => (el.hidden = true), 2500);
  };
  const showError = (text) => showStatus({ text, tone: 'error' });

  /** The red or amber icon, with its explanation as a tooltip on hover or focus. */
  const flagHtml = (status, own) => {
    const text = own || FT.FLUID_COPY[status];
    const why = status === 'error' ? ` <a href="${FT.FLUID_LINK}" target="_blank" rel="noreferrer">Read why</a>` : '';
    const kind = status === 'order' ? 'Type scale order' : `Accessibility ${status}`;
    return `<span class="flag" data-status="${status}" tabindex="0" role="img" aria-label="${esc(`${kind}: ${text}`)}">${FT.badgeHtml(status === 'order' ? 'warning' : status)}<span class="tip" role="tooltip"><span class="tip-text">${esc(text)}${why}</span></span></span>`;
  };

  /**
   * The one icon for a row, with all of its issues in the tooltip. The worst shows: an accessibility error
   * (red) over a type scale order problem (orange) over an accessibility warning (amber).
   */
  const rowFlagHtml = (s) => {
    const issues = [];
    if (s.status === 'error') issues.push({ status: 'error', text: FT.FLUID_COPY.error });
    if (s.order.length) issues.push({ status: 'order', text: s.order.join(' ') });
    if (s.status === 'warning') issues.push({ status: 'warning', text: FT.FLUID_COPY.warning });
    if (!issues.length) return '';
    const worst = issues[0];
    const text = issues
      .map((issue) => `<span class="tip-line" data-status="${issue.status}">${esc(issue.text)}${issue.status === 'error' ? ` <a href="${FT.FLUID_LINK}" target="_blank" rel="noreferrer">Read why</a>` : ''}</span>`)
      .join('');
    const label = issues.map((issue) => issue.text).join(' ');
    return `<span class="flag" data-status="${worst.status}" tabindex="0" role="img" aria-label="${esc(label)}">${FT.badgeHtml(worst.status === 'order' ? 'warning' : worst.status)}<span class="tip" role="tooltip"><span class="tip-text">${text}</span></span></span>`;
  };

  /** The type scale as rows: bars, numbers, and the order and accessibility flags. */
  const renderScale = () => {
    const list = $('scale');
    const key = active() ? app.target.key : undefined;
    const top = Math.max(...app.styles.map((s) => s.max), 1);
    list.replaceChildren(
      ...app.styles.map((s) => {
        const row = document.createElement('li');
        row.dataset.key = s.key;
        row.tabIndex = 0;
        row.setAttribute('role', 'button');
        row.setAttribute('aria-pressed', String(key === s.key));
        row.setAttribute('aria-label', `Edit ${s.label}`);
        if (key === s.key) row.className = 'on';
        const flags = rowFlagHtml(s);
        if (s.order.length) row.classList.add('order');
        row.innerHTML = `
          <span class="n">${s.label}</span>
          <span class="bar">${s.pending ? '' : `<i style="left:${(s.min / top) * 100}%;width:${Math.max(1.5, ((s.max - s.min) / top) * 100)}%"></i>`}</span>
          <span class="v"${s.order.length ? ` title="${esc(s.order.join(' '))}"` : ''}>${s.pending ? '–' : `<span${s.badMin ? ' class="bad"' : ''}>${FT.fmt(s.min)}</span>–<span${s.badMax ? ' class="bad"' : ''}>${FT.fmt(s.max)}</span>`}</span><span class="flags">${flags}</span>`;
        return row;
      }),
    );
  };

  // ── Scale ratio ───────────────────────────────────────────────────────────
  //
  // Two ratios, one for the minimum sizes and one for the maximum. Each shows the scale its sizes follow, and is
  // empty when they follow none. Setting one rewrites that side's sizes for every level, measured from the smallest
  // size on that side: it stays, and each other level becomes a multiple of it, a ratio for each step. It is
  // one write, so one undo.

  const scaleSizes = (side) => Object.fromEntries(app.styles.map((s) => [s.key, s[side]]));

  /** What a scale is measured on: the type scale from Main, the spacing scale from Space 1. */
  const scaleCfg = () => {
    const names = namesOf(app.mode);
    // Lumos' own groups are measured from Main and Space 1 and have a ladder of steps; any other from its smallest level.
    const standard = app.mode === 'spacing' ? SC.SPACING_BASE : app.mode === 'type' ? SC.BASE : undefined;
    const defaults = app.mode === 'spacing' ? SC.SPACING_STEPS : SC.DEFAULT_STEPS;
    let base = standard && names.includes(standard) ? standard : undefined;
    if (!base) {
      for (const s of app.styles) if (!base || s.min < app.styles.find((o) => o.key === base).min) base = s.key;
      base = base || names[names.length - 1];
    }
    // Where each level sits in a scale: the Lumos ladder for its own levels, else its place in the list, a step each from the base.
    const at = names.indexOf(base);
    const steps = {};
    names.forEach((name, i) => {
      steps[name] = standard && names.includes(standard) && name in defaults ? defaults[name] : at - i;
    });
    return { base, steps };
  };

  /** The key a side's state is kept under: each scale has its own minimum and maximum settings. */
  const sk = (side) => `${app.mode}-${side}`;

  /** The scale a side's sizes follow, or undefined. A ratio just set is shown as set while the sizes still follow it. */
  const scaleOf = (side) => {
    if (kindOf() === 'other') return undefined; // the rest have no scale
    if (app.scaleOff[sk(side)]) return undefined;
    const sizes = scaleSizes(side);
    const found = SC.detect(sizes, scaleCfg().base);
    const applied = app.applied[sk(side)];
    if (found && applied && SC.fits(sizes, applied, scaleCfg().base)) return { ratio: applied, name: SC.nameOf(applied), steps: found.steps };
    return found;
  };

  const setScaleOff = (side, off) => {
    if (app.scaleOff[sk(side)] === off) return;
    app.scaleOff[sk(side)] = off;
    app.lockCtx = undefined;
    stacki.storage.set({ key: `scale-off-${app.mode}-${side}`, value: String(off), scope: 'local' }).catch(() => {});
  };

  /**
   * The level the sizes scale from: always the smallest on that side, which keeps its size while the rest
   * climb from it. Where two are equally small, the one lower in the scale (Small before Main).
   */
  const scaleOrigin = (side) => {
    let best;
    for (const s of app.styles) {
      const step = scaleCfg().steps[s.key];
      if (step === undefined || !(s[side] > 0)) continue; // a size of zero is no size
      if (!best || s[side] < best[side] || (s[side] === best[side] && step < scaleCfg().steps[best.key])) best = s;
    }
    return best ? best.key : scaleCfg().base;
  };

  let scaleBusy = false;
  let scalePending; // a scale asked for while another was being written
  const scaleTimers = {};

  const closeScaleLists = (chosen) => {
    let wasOpen = false;
    for (const box of document.querySelectorAll('.scale-box')) {
      if (!box.querySelector('.scale-list').hidden) wasOpen = true;
      box.querySelector('.scale-list').hidden = true;
      box.querySelector('.scale-menu').setAttribute('aria-expanded', 'false');
    }
    // Closing without choosing undoes what hovering showed.
    if (wasOpen && !chosen && scalePreview.ctx) restoreScalePreview();
  };

  const renderScaleFields = () => {
    const ready = kindOf() !== 'other' && app.styles.some((s) => s.key === scaleCfg().base) && app.styles.length >= (app.mode === 'type' || app.mode === 'spacing' ? 5 : 3);
    $('scale-section').hidden = !ready;
    if (!ready) return;
    for (const side of ['min', 'max']) {
      const found = scaleOf(side);
      const input = $(`scale-${side}`);
      if (!input.dataset.dirty) input.value = found ? SC.format(found.ratio) : '';
      input.disabled = !app.canEdit; // not while writing: a disabled field loses the keyboard focus
      input.setAttribute('aria-label', `${side === 'min' ? 'Minimum' : 'Maximum'} ${scaleWord()} scale`);
      const lock = document.querySelector(`.scale-lock[data-side="${side}"]`);
      lock.hidden = !found; // a lock means something only while the sizes follow a scale
      lock.setAttribute('aria-pressed', String(!app.unlocked[sk(side)]));
      const word = side === 'min' ? 'minimum' : 'maximum';
      lock.title = app.unlocked[sk(side)] ? `Unlocked: the ${word} sizes are free. Lock them to the scale.` : `Locked: the other ${word} sizes follow the smallest. Unlock to set them freely.`;
      lock.setAttribute('aria-label', lock.title);
    }
  };

  // ── Locking the levels to a scale ─────────────────────────────────────────
  //
  // While a side has a scale and its lock is on, the sizes on that side are tied: the smallest sets the rest
  // through the ratio, and the others cannot be set on their own. Changing the smallest, from the card,
  // changes all of them. Turning the lock off frees them. The lock only means something while the sizes
  // do follow a scale; with none, every size is free whatever the lock says.

  const scaleLocked = (side) => !app.unlocked[sk(side)] && Boolean(scaleOf(side));

  /**
   * What links the other levels to the one at `key`, per locked side where `key` is the smallest: the ratio, the
   * steps, the sizes, and each level's declaration. Taken once, before a drag begins to change the sizes it reads,
   * and kept until the drag is over. Undefined fields when nothing is linked.
   */
  const ensureLockCtx = (key) => {
    if (app.lockCtx && app.lockCtx.key === key) return app.lockCtx;
    const ctx = { key, sides: {} };
    if (app.styles.some((s) => s.key === key)) {
      const chain = TR.rootChain(corpus, app.width);
      for (const side of ['min', 'max']) {
        if (!scaleLocked(side) || scaleOrigin(side) !== key) continue;
        const found = scaleOf(side);
        const parts = new Map();
        for (const s of app.styles) {
          const part = TR.resolveNumber(corpus, chain, `--${s.key}-${side}`);
          if (part && part.edit) parts.set(s.key, part);
        }
        ctx.sides[side] = { ratio: found.ratio, steps: found.steps, origin: key, sizes: scaleSizes(side), parts };
      }
    }
    app.lockCtx = ctx;
    return ctx;
  };

  /** The other levels' sizes under the scale, when `key` (the smallest) is set to min and max: { side: { level: size } }. */
  const lockedValues = (key, min, max) => {
    const out = {};
    const ctx = ensureLockCtx(key);
    for (const side of Object.keys(ctx.sides)) {
      const s = ctx.sides[side];
      out[side] = SC.apply({ ...s.sizes, [s.origin]: side === 'min' ? min : max }, s.ratio, s.steps, s.origin, scaleCfg().steps, scaleCfg().base);
    }
    return out;
  };

  /** The writes that tie the other levels to `key` at these values. */
  const lockedEdits = (key, min, max) => {
    if (!key) return [];
    const ctx = ensureLockCtx(key);
    const values = lockedValues(key, min, max);
    const edits = [];
    for (const side of Object.keys(values)) {
      for (const [level, value] of Object.entries(values[side])) {
        const part = ctx.sides[side].parts.get(level);
        if (part && part.number !== value) edits.push({ edit: part.edit, text: textFor(part.unit, value) });
      }
    }
    return edits;
  };

  // ── Previewing a scale from the list ──────────────────────────────────────
  //
  // While an option in the list is hovered, the sizes follow it: the page, the list and the card all show that
  // scale. Closing the list without choosing puts the stylesheet back as it was; choosing keeps what is shown.
  // Every preview is built from a snapshot of the file taken before the first one, so it does not matter in what
  // order the options were passed over, and the writes are paced like the card's live preview.

  const scalePreview = { ctx: undefined, last: undefined, writes: 0, wanted: undefined, running: false, lastAt: 0, off: false, timer: undefined };

  /** What a preview needs, read once from the sizes and the file as they are now. Undefined when they disagree. */
  const scaleContext = async (side) => {
    const sizes = scaleSizes(side);
    const found = SC.detect(sizes, scaleCfg().base);
    const chain = TR.rootChain(corpus, app.width);
    const parts = new Map();
    const base = new Map();
    for (const s of app.styles) {
      const part = TR.resolveNumber(corpus, chain, `--${s.key}-${side}`);
      if (!part || !part.edit) continue;
      parts.set(s.key, part);
      if (!base.has(part.edit.file)) base.set(part.edit.file, (await stacki.files.read({ path: part.edit.file })).content);
    }
    for (const [path, text] of base) if (corpus.getText(path) !== text) return undefined; // the file moved since it was read
    return { side, sizes, steps: found && found.steps, origin: scaleOrigin(side), parts, base };
  };

  /** The files as they would be under a ratio, built from the snapshot: path → text. Undefined when an edit no longer fits. */
  const scaleContent = (ctx, ratio) => {
    const next = SC.apply(ctx.sizes, ratio, ctx.steps, ctx.origin, scaleCfg().steps, scaleCfg().base);
    const byFile = new Map();
    for (const [key, value] of Object.entries(next)) {
      const part = ctx.parts.get(key);
      if (!part || part.number === value) continue;
      const list = byFile.get(part.edit.file) || [];
      list.push({ edit: part.edit, text: textFor(part.unit, value) });
      byFile.set(part.edit.file, list);
    }
    const out = new Map();
    for (const [path, base] of ctx.base) {
      let text = base;
      for (const { edit, text: replacement } of (byFile.get(path) || []).sort((x, y) => y.edit.start - x.edit.start)) {
        if (text.slice(edit.start, edit.end) !== edit.raw) return undefined;
        text = text.slice(0, edit.start) + replacement + text.slice(edit.end);
      }
      out.set(path, text);
    }
    return out;
  };

  const resetScalePreview = () => {
    clearTimeout(scalePreview.timer);
    Object.assign(scalePreview, { ctx: undefined, last: undefined, writes: 0, wanted: undefined, lastAt: 0, off: false, timer: undefined });
  };

  const runScalePreview = async (side, ratio) => {
    const p = scalePreview;
    if (p.off) return;
    if (p.running) {
      p.wanted = { side, ratio }; // the newest one waits its turn
      return;
    }
    p.running = true;
    try {
      if (!p.ctx || p.ctx.side !== side) {
        p.ctx = await scaleContext(side);
        if (!p.ctx) {
          p.off = true;
          return;
        }
      }
      const wait = p.lastAt + LIVE.every - Date.now();
      if (wait > 0) await sleep(wait);
      if (p.writes >= LIVE.perDrag || writesThisMinute() >= LIVE.windowCap) {
        p.off = true;
        return;
      }
      const files = scaleContent(p.ctx, ratio);
      if (!files) {
        p.off = true;
        return;
      }
      p.lastAt = Date.now();
      app.saving = true; // its own changes are not news
      for (const [path, text] of files) {
        if (p.last ? p.last.get(path) === text : text === p.ctx.base.get(path)) continue; // already what is there
        const outcome = await stacki.files.write({ path, content: text, label: `${side === 'min' ? 'Min' : 'Max'} ${scaleWord()} scale ${SC.format(ratio)}` });
        if (!outcome.applied) throw new Error(outcome.reason || 'The change was not applied.');
        writeLog.push(Date.now());
        corpus.setFile(path, text);
        p.writes++;
      }
      p.last = files;
      loadScale();
      retrace();
      render();
      await draw();
    } catch (error) {
      if (rateLimited(error)) p.off = true;
    } finally {
      p.running = false;
      if (p.wanted) {
        const next = p.wanted;
        p.wanted = undefined;
        runScalePreview(next.side, next.ratio);
      }
    }
  };

  /** A pointer resting on an option. Brief passes over the options in between are not previewed. */
  const queueScalePreview = (side, ratio) => {
    if (scaleBusy || live.running || live.writes || !app.canEdit) return;
    const found = scaleOf(side);
    if (!scalePreview.ctx && found && found.ratio === ratio) return; // the scale it already is
    clearTimeout(scalePreview.timer);
    scalePreview.timer = setTimeout(() => runScalePreview(side, ratio), 140);
  };

  /** Waits out a write in flight and forgets what is queued. */
  const settleScalePreview = async () => {
    clearTimeout(scalePreview.timer);
    scalePreview.wanted = undefined;
    while (scalePreview.running) await sleep(20);
  };

  /** The list closed without a choice: the stylesheet goes back to the snapshot. */
  const restoreScalePreview = async () => {
    await settleScalePreview();
    const { ctx, writes } = scalePreview;
    resetScalePreview();
    if (!ctx || !writes) {
      app.saving = false;
      return;
    }
    scaleBusy = true;
    try {
      for (const [path, text] of ctx.base) {
        const outcome = await stacki.files.write({ path, content: text, label: `${ctx.side === 'min' ? 'Min' : 'Max'} ${scaleWord()} scale` });
        if (outcome.applied) writeLog.push(Date.now());
        corpus.setFile(path, text);
      }
    } catch {
      await syncCorpus().catch(() => {}); // could not tell: take the files as they are
    } finally {
      scaleBusy = false;
      app.saving = false;
    }
    loadScale();
    retrace();
    render();
    await draw();
  };

  /** An option was chosen: what is shown stays. */
  const keepScalePreview = async () => {
    await settleScalePreview();
    resetScalePreview();
    app.saving = false;
  };

  const applyScale = async (side, ratio) => {
    if (live.running || live.writes || !app.canEdit) return;
    if (scaleBusy) {
      scalePending = { side, ratio };
      return;
    }
    setScaleOff(side, false); // choosing a scale turns it back on
    const sizes = scaleSizes(side);
    const found = SC.detect(sizes, scaleCfg().base);
    const next = SC.apply(sizes, ratio, found && found.steps, scaleOrigin(side), scaleCfg().steps, scaleCfg().base);
    const chain = TR.rootChain(corpus, app.width);
    const files = new Map();
    for (const [key, value] of Object.entries(next)) {
      const part = TR.resolveNumber(corpus, chain, `--${key}-${side}`);
      if (!part || !part.edit || part.number === value) continue; // not a plain number, or already there
      const list = files.get(part.edit.file) || [];
      list.push({ edit: part.edit, text: textFor(part.unit, value) });
      files.set(part.edit.file, list);
    }
    app.applied[sk(side)] = ratio;
    if (!files.size) {
      renderScaleFields();
      return;
    }

    scaleBusy = true;
    app.saving = true;
    renderScaleFields();
    const label = `${side === 'min' ? 'Min' : 'Max'} ${scaleWord()} scale ${SC.format(ratio)}`;
    try {
      for (const [path, list] of files) {
        for (let attempt = 0; ; attempt++) {
          try {
            const { content } = await stacki.files.read({ path });
            let out = content;
            for (const { edit, text } of list.sort((x, y) => y.edit.start - x.edit.start)) {
              if (out.slice(edit.start, edit.end) !== edit.raw) throw Object.assign(new Error('The stylesheet changed. Try again.'), { stale: true });
              out = out.slice(0, edit.start) + text + out.slice(edit.end);
            }
            const outcome = await stacki.files.write({ path, content: out, label });
            if (!outcome.applied) throw Object.assign(new Error(outcome.reason || 'The change was not applied.'), { refused: true });
            writeLog.push(Date.now());
            corpus.setFile(path, out);
            break;
          } catch (error) {
            if (!rateLimited(error) || attempt >= 5) throw error;
            await sleep(2000 * (attempt + 1));
          }
        }
      }
    } catch (error) {
      app.applied[sk(side)] = undefined;
      await syncCorpus([...files.keys()]).catch(() => {});
      showError(String((error && error.message) || error));
    } finally {
      scaleBusy = false;
      app.saving = false;
    }
    // The field is done with, unless more was typed or stepped while this was being written.
    const field = $(`scale-${side}`);
    if (SC.parse(field.value) === ratio) delete field.dataset.dirty;
    loadScale();
    retrace();
    render();
    await draw();
    if (scalePending) {
      const next = scalePending;
      scalePending = undefined;
      applyScale(next.side, next.ratio);
    }
  };

  /** What was typed in a side's field: set that scale. Empty or not a scale: put back what is there. */
  const commitScale = (side) => {
    clearTimeout(scaleTimers[side]);
    const input = $(`scale-${side}`);
    const ratio = SC.parse(input.value);
    const found = scaleOf(side);
    if (ratio === undefined || (found && found.ratio === ratio)) {
      delete input.dataset.dirty;
      renderScaleFields();
      return;
    }
    // The field stays as typed (dirty) until the write is done: the sizes it reads from are still the old
    // ones while that goes on, and redrawing the field from them would snap it back to the old scale.
    applyScale(side, ratio);
  };

  const openScaleList = (side) => {
    const box = document.querySelector(`.scale-field[data-side="${side}"] .scale-box`);
    const list = box.querySelector('.scale-list');
    const wasOpen = !list.hidden;
    closeScaleLists();
    if (wasOpen) return;
    const found = scaleOf(side);
    const named = found && found.name;
    list.innerHTML =
      `<li role="option" data-none aria-selected="${!found}"><span class="scale-ratio">None</span></li>` +
      SC.SCALES.map(
        (s) => `<li role="option" data-ratio="${s.ratio}" aria-selected="${named && found.ratio === s.ratio}"><span class="scale-ratio">${SC.format(s.ratio)}</span><span class="scale-title">${esc(s.name)}</span></li>`,
      ).join('') + `<li role="option" data-custom aria-selected="${Boolean(found && !named)}"><span class="scale-ratio">Custom</span></li>`;
    list.hidden = false;
    box.querySelector('.scale-menu').setAttribute('aria-expanded', 'true');
    const current = list.querySelector('[aria-selected="true"]');
    if (current) current.scrollIntoView({ block: 'nearest' });
  };

  for (const side of ['min', 'max']) {
    const input = $(`scale-${side}`);
    const box = input.closest('.scale-box');
    input.addEventListener('input', () => {
      input.dataset.dirty = '1';
    });
    input.addEventListener('change', () => commitScale(side));
    input.addEventListener('keydown', (event) => {
      if (event.key === 'Enter') {
        event.preventDefault();
        commitScale(side);
      } else if (event.key === 'Escape') {
        delete input.dataset.dirty;
        closeScaleLists();
        renderScaleFields();
      } else if (event.key === 'ArrowUp' || event.key === 'ArrowDown') {
        event.preventDefault();
        const direction = event.key === 'ArrowUp' ? 1 : -1;
        const current = SC.parse(input.value) ?? (scaleOf(side) ? scaleOf(side).ratio : 1.2);
        // Up and down go to the next named scale; with Option or Shift they step by a tenth, to any number.
        const next = event.altKey || event.shiftKey ? SC.clampRatio(SC.round3(current + direction * 0.1)) : SC.neighbour(current, direction);
        input.value = SC.format(next);
        input.dataset.dirty = '1';
        clearTimeout(scaleTimers[side]);
        scaleTimers[side] = setTimeout(() => commitScale(side), 150); // a run of presses is one change
      }
    });
    box.querySelector('.scale-menu').addEventListener('click', () => openScaleList(side));
    box.querySelector('.scale-list').addEventListener('click', (event) => {
      const item = event.target.closest('li');
      if (!item) return;
      if (item.hasAttribute('data-none')) {
        // No scale: the sizes stay as they are (as they were before any preview), and none is read from them.
        closeScaleLists(true);
        restoreScalePreview().then(() => {
          setScaleOff(side, true);
          app.applied[sk(side)] = undefined;
          delete input.dataset.dirty;
          renderScaleFields();
          post(); // the card's sliders are free of the scale
        });
      } else if (item.hasAttribute('data-custom')) {
        closeScaleLists(); // nothing chosen yet: what was previewed goes back
        input.focus();
        input.select();
      } else {
        closeScaleLists(true);
        keepScalePreview().then(() => applyScale(side, Number(item.dataset.ratio)));
      }
    });
    box.querySelector('.scale-list').addEventListener('mouseover', (event) => {
      const item = event.target.closest('li[data-ratio], li[data-none]');
      if (!item) return;
      // The tick and the highlight go with the pointer: the hovered option is the one being shown.
      for (const li of item.parentElement.children) li.setAttribute('aria-selected', String(li === item));
      if (item.hasAttribute('data-none')) {
        // None changes no size, so what it shows is the sizes as they were before any preview.
        if (scalePreview.ctx) restoreScalePreview();
        return;
      }
      queueScalePreview(side, Number(item.dataset.ratio));
    });
  }
  for (const lock of document.querySelectorAll('.scale-lock')) {
    lock.addEventListener('click', () => {
      const side = lock.dataset.side;
      app.unlocked[sk(side)] = !app.unlocked[sk(side)];
      stacki.storage.set({ key: `unlock-${app.mode}-${side}`, value: String(app.unlocked[sk(side)]), scope: 'local' }).catch(() => {});
      app.lockCtx = undefined;
      renderScaleFields();
      post(); // the card's sliders lock or free with it
    });
  }
  document.addEventListener('click', (event) => {
    if (!event.target.closest('.mode-head')) closeModeList();
    if (!event.target.closest('.scale-box')) closeScaleLists();
  });

  const render = () => {
    const target = app.target;
    const sel = $('selected');
    if (!target) {
      sel.innerHTML = app.loaded && !app.styles.length ? '<p class="hint">No fluid sizes found in this project.</p>' : '';
    } else if (target.message) {
      sel.innerHTML = `<p class="hint">${esc(target.message)}</p>`;
    } else if (!target.trace.editable) {
      sel.innerHTML = '<p class="hint">Its min or max is not a plain number, so it cannot be edited here.</p>';
    } else if (!app.canEdit) {
      sel.innerHTML = '<p class="hint">View only: your role cannot edit the type scale.</p>';
    } else if (app.note) {
      sel.innerHTML = `<p class="hint">${esc(app.note)}</p>`;
    } else {
      sel.innerHTML = '';
    }
    $('scale-section').inert = !app.loaded; // its inputs write to the stylesheet, which has not been read yet
    renderScale();
    renderScaleFields();
  };

  // ── Wiring ────────────────────────────────────────────────────────────────

  window.addEventListener('message', async (event) => {
    if (event.source !== $('card').contentWindow) return;
    const data = event.data;
    if (!data || data.source !== 'fluid-card' || !data.message) return;
    const message = data.message;
    if (message.type === 'ready') {
      await post();
    } else if (message.type === 'compare') {
      app.compare = Boolean(message.on);
      stacki.storage.set({ key: 'compare', value: String(app.compare), scope: 'local' }).catch(() => {});
    } else if (message.type === 'draft') {
      if (active() && app.target.key === message.key) {
        ensureLockCtx(message.key);
        draftScale(message.key, Number(message.min), Number(message.max));
      }
    } else if (message.type === 'preview') {
      if (active() && app.target.key === message.key) previewLive(Number(message.min), Number(message.max));
    } else if (message.type === 'cancel') {
      if (active() && app.target.key === message.key) await cancelLive();
    } else if (message.type === 'shortcut') {
      // A key the card could not hand to Stacki itself: undo, redo, save.
      if (['undo', 'redo', 'save'].includes(message.shortcut)) await stacki.shortcuts.run({ shortcut: message.shortcut }).catch(() => {});
    } else if (message.type === 'setWidth') {
      setCanvasWidth(Number(message.width));
    } else if (message.type === 'commit') {
      if (!active() || app.target.key !== message.key) return;
      await save(Number(message.min), Number(message.max));
      await draw();
    }
  });

  // The list's heading is a menu: the type scale, or the spacing scale.
  const modeList = $('mode-list');
  const renderMode = () => {
    if (!allGroups().some((g) => g.id === app.mode)) app.mode = allGroups()[0].id;
    $('mode-title').textContent = groupOf().name || 'Untitled';
    modeList.replaceChildren(
      ...allGroups().map((g) => {
        const li = document.createElement('li');
        li.setAttribute('role', 'option');
        li.dataset.mode = g.id;
        li.setAttribute('aria-selected', String(g.id === app.mode));
        li.textContent = g.name || 'Untitled';
        return li;
      }),
    );
  };
  const closeModeList = () => {
    modeList.hidden = true;
    $('mode-menu').setAttribute('aria-expanded', 'false');
  };
  const setMode = async (mode) => {
    closeModeList();
    if (mode === app.mode || live.running || live.writes) return;
    app.mode = mode;
    stacki.storage.set({ key: 'mode', value: mode, scope: 'local' }).catch(() => {});
    app.pinned = undefined;
    app.lockCtx = undefined;
    closeScaleLists();
    loadScale();
    if (kindOf() === 'type') {
      // Back to font sizes: what is selected on the page decides the card again.
      await select({ nodeId: app.nodeId });
    } else {
      retrace();
      render();
      await draw();
    }
    renderMode();
  };
  $('mode-menu').addEventListener('click', () => {
    const open = modeList.hidden;
    closeScaleLists();
    renderMode();
    modeList.hidden = !open;
    $('mode-menu').setAttribute('aria-expanded', String(open));
  });
  modeList.addEventListener('click', (event) => {
    const item = event.target.closest('li[data-mode]');
    if (item) setMode(item.dataset.mode);
  });
  document.addEventListener('keydown', (event) => {
    if (event.key === 'Escape') closeModeList();
  });

  const scaleList = $('scale');
  const rowOf = (event) => event.target.closest && event.target.closest('li[data-key]');
  scaleList.addEventListener('click', (event) => {
    if (event.target.closest('.flag a')) return; // "Read why" is a link, not a choice
    const row = rowOf(event);
    if (row) pinLevel(row.dataset.key);
  });
  scaleList.addEventListener('keydown', (event) => {
    if (event.key !== 'Enter' && event.key !== ' ') return;
    const row = rowOf(event);
    if (!row || event.target !== row) return;
    event.preventDefault();
    pinLevel(row.dataset.key);
  });

  stacki.on('role.change', applyRole);
  stacki.on('theme.change', () => post()); // the card takes the new input colour

  stacki.on('selection.change', select);
  stacki.on('page.change', () => {
    app.view = undefined;
    return select({ nodeId: undefined });
  });
  // Resizing the canvas fires this many times a second. The width goes to the card at once, on its
  // own, so the playhead and the size readout move with the drag. The rest (a media query may change
  // the font size at another width) is traced in a pass that coalesces the events behind it.
  // The card's playhead asks for a width; the latest ask wins, one call at a time.
  let widthBusy = false;
  let widthWanted;
  let widthInFlight; // the width canvas.setWidth is working on; an event for any other is stale
  const setCanvasWidth = async (width) => {
    if (!Number.isFinite(width)) return;
    widthWanted = Math.round(Math.min(6000, Math.max(240, width)));
    if (widthBusy) return;
    widthBusy = true;
    try {
      while (widthWanted !== undefined) {
        const next = widthWanted;
        widthWanted = undefined;
        widthInFlight = next;
        const viewport = await stacki.canvas.setWidth({ widthPx: next }).catch(() => undefined);
        if (viewport && Number.isFinite(viewport.widthPx)) {
          app.width = viewport.widthPx;
          if (Number.isFinite(viewport.heightPx)) app.viewH = viewport.heightPx;
          if (Number.isFinite(viewport.scale) && viewport.scale > 0) app.scale = viewport.scale;
        }
      }
    } finally {
      widthBusy = false;
      widthInFlight = undefined;
    }
  };

  let viewportSeq = 0;
  let refreshing = false;
  let refreshAgain = false;
  const refreshForWidth = async () => {
    if (refreshing) {
      refreshAgain = true;
      return;
    }
    refreshing = true;
    try {
      do {
        refreshAgain = false;
        const at = app.width;
        loadScale();
        retrace();
        render();
        await draw();
        if (app.width !== at) refreshAgain = true;
      } while (refreshAgain);
    } finally {
      refreshing = false;
    }
  };

  stacki.on('canvas.change', async (event) => {
    // While the playhead is resizing the canvas, an event for a width that is no longer the one in
    // flight is old news: acting on it would pull the frame back to where it was a step ago.
    if (widthBusy && event && Number.isFinite(event.widthPx) && event.widthPx !== widthInFlight) return;
    const seq = ++viewportSeq;
    const before = app.width;
    if (event && Number.isFinite(event.widthPx)) {
      app.width = event.widthPx;
      if (Number.isFinite(event.heightPx)) app.viewH = event.heightPx;
      if (Number.isFinite(event.scale) && event.scale > 0) app.scale = event.scale;
    } else {
      const vp = await stacki.canvas.getViewport().catch(() => undefined);
      if (seq !== viewportSeq) return; // a newer change has its own read
      if (vp) {
        app.width = vp.widthPx;
        app.viewH = vp.heightPx;
        app.scale = vp.scale || 1;
      }
    }
    toCard({ type: 'width', width: app.width });
    if (app.width !== before || !active()) await refreshForWidth();
    else await draw();
  });

  let changeTimer;
  stacki.on('project.change', ({ paths, origin }) => {
    noteChange();
    if (origin === 'self' || app.saving) return;
    clearTimeout(changeTimer);
    changeTimer = setTimeout(async () => {
      app.view = undefined; // the page's markup may have changed too
      await syncCorpus(paths).catch(() => {});
      // Undo, redo, another tool, a pulled commit: the type scale list and the selection both re-read.
      loadScale();
      if (app.pinned || kindOf() !== 'type') {
        retrace();
        render();
        await draw();
      } else if (app.nodeId !== undefined) await select({ nodeId: app.nodeId });
      else render();
    }, 120);
  });

  // ── Settings ──────────────────────────────────────────────────────────────
  //
  // The groups the list is split into, and which variables each holds, in order. Every `--name-min` and
  // `--name-max` pair the project has (as plain numbers) is in a group or in Other, which is the rest and has
  // no scale ratio. Typography and Spacing are there to start with; groups can be added, named and removed.

  const VAR_NAME = /^[A-Za-z_][\w-]*$/;
  const sameList = (a, b) => a.length === b.length && a.every((name, i) => name === b[i]);

  /** The groups as stored, after a change: Lumos' two, untouched, are kept as "not set". */
  const settle = () => {
    if (app.groups && JSON.stringify(app.groups) === JSON.stringify(BUILT_IN)) app.groups = undefined;
  };
  /** The groups to edit: a copy of the built-in two until something changes. */
  const editable = () => {
    if (!app.groups) app.groups = BUILT_IN.map((g) => ({ ...g, names: [...g.names] }));
    return app.groups;
  };
  /** Sets a group's variables; a variable is in one group, so it leaves any other that held it. */
  const setNames = (id, names) => {
    const groups = editable();
    for (const g of groups) g.names = g.id === id ? names : g.names.filter((n) => !names.includes(n));
    settle();
  };

  const readConfig = (text) => {
    let saved = {};
    try {
      saved = JSON.parse(text || '{}') || {};
    } catch {}
    const clean = (list) => (Array.isArray(list) ? [...new Set(list.filter((n) => typeof n === 'string' && VAR_NAME.test(n)))] : undefined);
    if (Array.isArray(saved.groups)) {
      const seen = new Set();
      const groups = [];
      for (const g of saved.groups) {
        const names = clean(g && g.names);
        if (!g || typeof g.id !== 'string' || !names || seen.has(g.id) || g.id === 'other' || g.id === 'width') continue;
        seen.add(g.id);
        groups.push({ id: g.id, name: String(g.name || '').slice(0, 40), kind: g.kind === 'space' ? 'space' : 'type', names });
      }
      app.groups = groups;
      settle();
    } else if (Array.isArray(saved.type) || Array.isArray(saved.spacing)) {
      // The first version kept one list for each of the two scales.
      app.groups = BUILT_IN.map((g) => ({ ...g, names: clean(saved[g.id]) || [...g.names] }));
      settle();
    } else {
      app.groups = undefined;
    }
  };

  /** Shared with the project (so a team agrees on the groups); this browser only, where the project cannot keep it. */
  const saveConfig = async () => {
    const value = JSON.stringify({ groups: app.groups });
    try {
      await stacki.storage.set({ key: 'settings', value, scope: 'project' });
    } catch {
      await stacki.storage.set({ key: 'settings', value, scope: 'local' }).catch(() => {});
    }
  };

  const loadConfig = async () => {
    const project = await stacki.storage.get({ key: 'settings', scope: 'project' }).catch(() => ({}));
    if (project && project.value !== undefined) return project.value;
    const local = await stacki.storage.get({ key: 'settings', scope: 'local' }).catch(() => ({}));
    return local && local.value;
  };

  /** The lists and the card, after a setting changed. */
  const applyConfig = async () => {
    if (live.running || live.writes) return;
    app.lockCtx = undefined;
    renderMode();
    if (app.pinned && !namesOf(app.mode).includes(app.pinned)) app.pinned = undefined;
    loadScale();
    retrace();
    render();
    await draw();
    saveConfig();
  };

  const settingsBody = $('settings-body');

  const GRIP = '<svg viewBox="0 0 10 14" aria-hidden="true"><path d="M2.5 2.5h.01M7.5 2.5h.01M2.5 7h.01M7.5 7h.01M2.5 11.5h.01M7.5 11.5h.01" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"/></svg>';
  const CROSS = '<svg viewBox="0 0 10 10" aria-hidden="true"><path d="M2 2l6 6M8 2l-6 6" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round"/></svg>';

  const renderSettings = () => {
    app.pairs = app.loaded ? TR.fluidPairs(corpus, TR.rootChain(corpus, app.width)) : app.pairs;
    const canEdit = app.canEdit;
    const groups = groupsOf();
    const nodes = groups.map((g) => {
      const section = document.createElement('section');
      section.className = 'cfg-group';
      section.dataset.mode = g.id;
      const rows = g.names
        .map((name) => {
          const missing = app.loaded && !app.pairs.includes(name);
          return `<li class="cfg-row" data-name="${esc(name)}"${missing ? ' data-missing' : ''}>
            <button class="cfg-grip" type="button" aria-label="Move ${esc(labelFor(name))}: arrow keys or drag"${canEdit ? '' : ' disabled'}>${GRIP}</button>
            <span class="cfg-label">${esc(labelFor(name))}</span>
            <code class="cfg-var">--${esc(name)}</code>
            ${missing ? `<span class="cfg-miss" title="No --${esc(name)}-min and --${esc(name)}-max in the project">Not found</span>` : ''}
            <button class="cfg-remove" type="button" aria-label="Remove ${esc(labelFor(name))} from ${esc(g.name || 'this group')}"${canEdit ? '' : ' disabled'}>${CROSS}</button>
          </li>`;
        })
        .join('');
      section.innerHTML = `<div class="cfg-head">
          <button class="cfg-grip cfg-ggrip" type="button" aria-label="Move the group ${esc(g.name || '')}: arrow keys or drag"${canEdit ? '' : ' disabled'}>${GRIP}</button>
          <input class="cfg-name" type="text" value="${esc(g.name)}" placeholder="Group name" maxlength="40" spellcheck="false" autocomplete="off" aria-label="Group name"${canEdit ? '' : ' disabled'}>
          <button class="cfg-remove cfg-del" type="button" aria-label="Delete the group ${esc(g.name || '')}"${canEdit ? '' : ' disabled'}>${CROSS}</button>
        </div>
        <ul class="cfg-list">${rows || '<li class="cfg-empty">Drag variables here.</li>'}</ul>`;
      return section;
    });

    const rest = otherNames();
    const other = document.createElement('section');
    other.className = 'cfg-group cfg-other';
    other.dataset.mode = 'other';
    other.innerHTML = `<div class="cfg-head"><h3 class="cfg-title">Other</h3></div>
      <ul class="cfg-list">${
        rest.length
          ? rest
              .map(
                (name) => `<li class="cfg-row" data-name="${esc(name)}">
                  <button class="cfg-grip" type="button" aria-label="Move ${esc(labelFor(name))} to a group: drag"${canEdit ? '' : ' disabled'}>${GRIP}</button>
                  <span class="cfg-label">${esc(labelFor(name))}</span>
                  <code class="cfg-var">--${esc(name)}</code>
                </li>`,
              )
              .join('')
          : `<li class="cfg-empty">${app.loaded ? 'Nothing else.' : 'Reading the project…'}</li>`
      }</ul>`;

    const intro = document.createElement('p');
    intro.className = 'modal-sub';
    intro.textContent = 'Every variable with a -min and a -max. Drag across groups.';
    settingsBody.replaceChildren(intro, ...nodes, other); // the note scrolls with the groups
  };

  const openSettings = () => {
    closeModeList();
    closeScaleLists();
    renderSettings();
    $('settings').hidden = false;
    $('settings-btn').setAttribute('aria-expanded', 'true');
    $('settings-done').focus();
  };
  const closeSettings = () => {
    if ($('settings').hidden) return;
    $('settings').hidden = true;
    $('settings-btn').setAttribute('aria-expanded', 'false');
    $('settings-btn').focus();
  };
  $('settings-btn').addEventListener('click', openSettings);
  $('settings-done').addEventListener('click', closeSettings);
  $('settings').addEventListener('mousedown', (event) => {
    if (event.target === $('settings')) closeSettings();
  });

  const groupIdOf = (node) => node.closest('.cfg-group').dataset.mode;

  // A group's name changes as it is typed, in the menu and the heading.
  let nameTimer;
  settingsBody.addEventListener('input', (event) => {
    const input = event.target;
    if (!input.classList || !input.classList.contains('cfg-name')) return;
    editable().find((g) => g.id === groupIdOf(input)).name = input.value.slice(0, 40);
    settle();
    renderMode();
    clearTimeout(nameTimer);
    nameTimer = setTimeout(saveConfig, 400);
  });

  settingsBody.addEventListener('click', (event) => {
    const remove = event.target.closest('.cfg-remove');
    if (remove && !remove.disabled) {
      const id = groupIdOf(remove);
      if (remove.classList.contains('cfg-del')) {
        app.groups = editable().filter((g) => g.id !== id);
        settle();
      } else {
        setNames(id, namesOf(id).filter((n) => n !== remove.closest('.cfg-row').dataset.name));
      }
      renderSettings();
      applyConfig();
      return;
    }
  });

  $('cfg-newgroup').addEventListener('click', () => {
    if (!app.canEdit) return;
    const id = `g${Date.now().toString(36)}`;
    editable().push({ id, name: 'New group', kind: 'type', names: [] });
    renderSettings();
    const section = settingsBody.querySelector(`.cfg-group[data-mode="${id}"]`);
    section.scrollIntoView({ block: 'nearest' });
    const input = section.querySelector('.cfg-name');
    input.focus();
    input.select();
    applyConfig();
  });

  // Drag a row by its grip, within its group or into another (or into Other, to take it out of its group). A blue
  // line shows where it would land, between the rows; it moves on release.
  let drag;
  let gdrag; // a group being dragged by the grip in its heading
  const clearTarget = () => {
    if (!drag) return;
    if (drag.line) drag.line.remove();
    drag.line = undefined;
    for (const el of settingsBody.querySelectorAll('.drop-target')) el.classList.remove('drop-target');
  };
  settingsBody.addEventListener('pointerdown', (event) => {
    const grip = event.target.closest('.cfg-grip');
    if (!grip || grip.disabled || event.button !== 0) return;
    event.preventDefault();
    grip.setPointerCapture(event.pointerId);
    if (grip.classList.contains('cfg-ggrip')) {
      const section = grip.closest('.cfg-group');
      section.classList.add('dragging-group');
      gdrag = { section, index: undefined, line: undefined };
      return;
    }
    const row = grip.closest('.cfg-row');
    row.classList.add('dragging');
    drag = { row, source: groupIdOf(row), target: undefined, index: undefined, line: undefined };
  });
  settingsBody.addEventListener('pointermove', (event) => {
    if (gdrag) {
      // The line goes before the first group whose middle is below the pointer, else after the last. Other stays last.
      const y = event.clientY;
      const others = [...settingsBody.querySelectorAll('.cfg-group:not(.cfg-other)')].filter((sec) => sec !== gdrag.section);
      let index = others.findIndex((sec) => y < sec.getBoundingClientRect().top + sec.getBoundingClientRect().height / 2);
      if (index < 0) index = others.length;
      gdrag.index = index;
      if (!gdrag.line) {
        gdrag.line = document.createElement('div');
        gdrag.line.className = 'cfg-drop';
        gdrag.line.setAttribute('aria-hidden', 'true');
        settingsBody.appendChild(gdrag.line);
      }
      const before = others[index];
      const last = others[others.length - 1];
      gdrag.line.style.top = `${before ? before.offsetTop - 6 : last ? last.offsetTop + last.offsetHeight + 6 : 0}px`;
      const body = settingsBody.getBoundingClientRect();
      if (y < body.top + 24) settingsBody.scrollTop -= 8;
      else if (y > body.bottom - 24) settingsBody.scrollTop += 8;
      return;
    }
    if (!drag) return;
    const y = event.clientY;
    // The group the pointer is in, else the nearest.
    const sections = [...settingsBody.querySelectorAll('.cfg-group')];
    const within = sections.find((sec) => {
      const box = sec.getBoundingClientRect();
      return y >= box.top && y <= box.bottom;
    });
    const section =
      within ||
      sections
        .map((sec) => ({ sec, d: Math.min(Math.abs(y - sec.getBoundingClientRect().top), Math.abs(y - sec.getBoundingClientRect().bottom)) }))
        .sort((a, b) => a.d - b.d)[0].sec;
    const target = section.dataset.mode;
    const list = section.querySelector('.cfg-list');
    if (drag.target !== target) {
      clearTarget();
      drag.target = target;
    }
    if (target === 'other') {
      section.classList.add('drop-target'); // order in Other is the project's: the whole group is the target
      drag.index = 0;
    } else {
      const others = [...list.children].filter((r) => r !== drag.row && r.classList.contains('cfg-row'));
      // The line goes before the first row whose middle is below the pointer, else after the last.
      let index = others.findIndex((r) => y < r.getBoundingClientRect().top + r.getBoundingClientRect().height / 2);
      if (index < 0) index = others.length;
      drag.index = index;
      if (!drag.line) {
        drag.line = document.createElement('li');
        drag.line.className = 'cfg-drop';
        drag.line.setAttribute('aria-hidden', 'true');
        list.appendChild(drag.line);
      }
      const before = others[index];
      const last = others[others.length - 1];
      drag.line.style.top = `${before ? before.offsetTop : last ? last.offsetTop + last.offsetHeight : 0}px`;
    }
    const body = settingsBody.getBoundingClientRect(); // keep the list scrolling while the row is held at an edge
    if (y < body.top + 24) settingsBody.scrollTop -= 8;
    else if (y > body.bottom - 24) settingsBody.scrollTop += 8;
  });
  const endDrag = (event) => {
    if (gdrag) {
      const { section, index, line } = gdrag;
      gdrag = undefined;
      if (line) line.remove();
      section.classList.remove('dragging-group');
      if (event.type === 'pointercancel' || index === undefined) return;
      const groups = editable();
      const moved = groups.find((g) => g.id === section.dataset.mode);
      const rest = groups.filter((g) => g !== moved);
      rest.splice(index, 0, moved);
      if (rest.every((g, i) => g === groups[i])) return;
      app.groups = rest;
      settle();
      renderSettings();
      applyConfig();
      return;
    }
    if (!drag) return;
    const { row, source, target, index } = drag;
    clearTarget();
    row.classList.remove('dragging');
    drag = undefined;
    if (event.type === 'pointercancel' || target === undefined) return;
    const name = row.dataset.name;
    if (target === 'other') {
      if (source === 'other') return;
      setNames(source, namesOf(source).filter((n) => n !== name));
    } else {
      const names = namesOf(target).filter((n) => n !== name);
      names.splice(index, 0, name);
      if (source === target && sameList(names, namesOf(target))) return;
      setNames(target, names);
    }
    renderSettings();
    applyConfig();
  };
  settingsBody.addEventListener('pointerup', endDrag);
  settingsBody.addEventListener('pointercancel', endDrag);

  // The same from the keyboard: arrow keys on the grip.
  settingsBody.addEventListener('keydown', (event) => {
    const grip = event.target.closest && event.target.closest('.cfg-grip');
    if (!grip || (event.key !== 'ArrowUp' && event.key !== 'ArrowDown')) return;
    event.preventDefault();
    if (grip.classList.contains('cfg-ggrip')) {
      const id = groupIdOf(grip);
      const groups = [...editable()];
      const from = groups.findIndex((g) => g.id === id);
      const to = from + (event.key === 'ArrowUp' ? -1 : 1);
      if (to < 0 || to >= groups.length) return;
      groups.splice(to, 0, groups.splice(from, 1)[0]);
      app.groups = groups;
      settle();
      renderSettings();
      settingsBody.querySelector(`.cfg-group[data-mode="${id}"] .cfg-ggrip`).focus();
      applyConfig();
      return;
    }
    const row = grip.closest('.cfg-row');
    const id = groupIdOf(row);
    if (id === 'other') return;
    const names = [...namesOf(id)];
    const from = names.indexOf(row.dataset.name);
    const to = from + (event.key === 'ArrowUp' ? -1 : 1);
    if (from < 0 || to < 0 || to >= names.length) return;
    names.splice(to, 0, names.splice(from, 1)[0]);
    setNames(id, names);
    renderSettings();
    settingsBody.querySelector(`.cfg-group[data-mode="${id}"] .cfg-row[data-name="${CSS.escape(row.dataset.name)}"] .cfg-grip`).focus();
    applyConfig();
  });

  document.addEventListener('keydown', (event) => {
    if (event.key === 'Escape' && !$('settings').hidden) {
      event.preventDefault();
      event.stopPropagation();
      closeSettings();
    }
  }, true);

  (async () => {
    // Start the slow reads first, then draw what is already known (the list, the card, the fields) from
    // storage alone; the project's own numbers replace it as soon as they are in.
    const loading = loadCorpus().catch((error) => showError(String((error && error.message) || error)));
    const roleP = stacki.role.get().catch(() => undefined);
    const viewportP = readViewport();
    const selectionP = stacki.selection.get().catch(() => ({}));
    const get = (key) => stacki.storage.get({ key, scope: 'local' }).catch(() => ({}));
    const sides = ['min', 'max'];
    const modes = ['type', 'spacing'];
    const [compare, mode, snapshot, settings, ...flags] = await Promise.all([
      get('compare'), get('mode'), get('snapshot'), loadConfig(),
      // The type scale's settings were kept before there was a spacing scale, under shorter keys.
      ...modes.flatMap((m) => sides.flatMap((side) => [get(`unlock-${m}-${side}`), get(`scale-off-${m}-${side}`), get(`unlock-${side}`), get(`scale-off-${side}`)])),
    ]);
    app.compare = !(compare && compare.value === 'false'); // on by default; only an explicit off is remembered
    readConfig(settings);
    app.mode = mode && mode.value ? mode.value : 'type'; // renderMode() falls back to the first group when it is gone
    let i = 0;
    for (const m of modes) {
      for (const side of sides) {
        const [unlock, off, oldUnlock, oldOff] = flags.slice(i, i + 4);
        i += 4;
        const kept = unlock && unlock.value !== undefined ? unlock : m === 'type' ? oldUnlock : {};
        app.unlocked[`${m}-${side}`] = Boolean(kept && kept.value === 'true');
        const keptOff = off && off.value !== undefined ? off : m === 'type' ? oldOff : {};
        app.scaleOff[`${m}-${side}`] = Boolean(keptOff && keptOff.value === 'true');
      }
    }
    try {
      const saved = JSON.parse((snapshot && snapshot.value) || '{}');
      for (const [id, list] of Object.entries(saved)) if (Array.isArray(list)) app.cache[id] = list;
      if (Number.isFinite(saved.width) && saved.width > 0) app.width = saved.width;
    } catch {}
    renderMode();
    loadScale(); // from the snapshot, or bare rows
    render();
    await draw();

    applyRole(await roleP);
    await viewportP;
    await loading;
    app.loaded = true;
    loadScale();
    if (!$('settings').hidden) renderSettings();
    const { nodeId } = await selectionP;
    await select({ nodeId });
    if (kindOf() !== 'type') {
      retrace();
      render();
      await draw();
    }
    // The settings of groups the project added: read after the first paint.
    const extra = allGroups().map((g) => g.id).filter((id) => id !== 'type' && id !== 'spacing');
    if (extra.length) {
      const more = await Promise.all(extra.flatMap((id) => sides.flatMap((side) => [get(`unlock-${id}-${side}`), get(`scale-off-${id}-${side}`)])));
      let j = 0;
      for (const id of extra) {
        for (const side of sides) {
          app.unlocked[`${id}-${side}`] = Boolean(more[j].value === 'true');
          app.scaleOff[`${id}-${side}`] = Boolean(more[j + 1].value === 'true');
          j += 2;
        }
      }
      renderScaleFields();
    }
  })();

})();
