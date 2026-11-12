// The on-canvas controls: an overlay `frame` the app places beside the selected
// text. The app owns the files; this frame shows its state (overlay.message)
// and sends back a commit when a drag or an edit ends.

(() => {
  const $ = (id) => document.getElementById(id);
  const card = $('card');
  const rowOf = (k) => document.querySelector(`.row[data-k="${k}"]`);
  const els = {
    min: { row: rowOf('min'), field: rowOf('min').querySelector('.field') },
    max: { row: rowOf('max'), field: rowOf('max').querySelector('.field') },
  };
  /** Sets every copy of a text in a row: the slider draws each label and value twice (pale and dark). */
  const setText = (row, selector, text) => {
    for (const node of row.querySelectorAll(selector)) node.textContent = text;
  };

  // ── Rolling numbers ───────────────────────────────────────────────────────
  //
  // A number is drawn as columns of digits. Each column is a tall strip of repeating 0-9 inside a
  // window one line high, and a change slides the strip with a CSS transform, so an update costs a
  // style write per digit that moved and no layout. Rising numbers roll up, falling ones roll down,
  // and a wrap (9 to 0) carries on in the same direction. A column is only built or removed when the
  // number gains or loses a digit; it grows from, or shrinks to, nothing so the number never pops.
  // The slider draws each value twice (on the track and over the fill) with identical timing.

  const REDUCED = window.matchMedia ? window.matchMedia('(prefers-reduced-motion: reduce)') : { matches: false };
  const CELL = 1.25; // a digit's height, in em: the line height of .col
  const CELLS = 120; // ten full turns, so a column rarely needs recentring
  const MID = 60;
  const STRIP_HTML = Array.from({ length: CELLS }, (_, i) => `<span class="c">${i % 10}</span>`).join('');

  const setCell = (col, animate) => {
    col.strip.style.transition = animate && !REDUCED.matches ? '' : 'none';
    col.strip.style.transform = `translateY(${-col.cell * CELL}em)`;
  };

  const makeColumn = (digit, grow, ms) => {
    const el = document.createElement('span');
    el.className = grow && !REDUCED.matches ? 'col enter' : 'col';
    el.setAttribute('aria-hidden', 'true');
    el.style.setProperty('--roll-ms', `${ms}ms`);
    el.innerHTML = `<span class="ph">8</span><span class="win"><span class="strip">${STRIP_HTML}</span></span>`;
    const col = { el, strip: el.lastChild.firstChild, cell: MID + digit };
    setCell(col, false);
    if (el.classList.contains('enter')) {
      el.offsetWidth; // the start state has to be laid out once for the growth to animate
      el.classList.remove('enter');
    }
    return col;
  };

  const turnColumn = (col, digit, dir) => {
    const at = col.cell % 10;
    const steps = dir >= 0 ? (digit - at + 10) % 10 : -((at - digit + 10) % 10);
    if (steps === 0) return;
    if (col.cell < 20 || col.cell > CELLS - 20) {
      // Far from the middle of the strip: move a whole number of turns back, which looks the same.
      col.cell -= Math.round((col.cell - MID) / 10) * 10;
      setCell(col, false);
      col.strip.offsetHeight;
    }
    col.cell += steps;
    setCell(col, true);
  };

  const dropColumn = (col, ms) => {
    if (REDUCED.matches) return col.el.remove();
    col.el.classList.add('leave');
    setTimeout(() => col.el.remove(), ms + 40);
  };

  /** Keeps `cols` in step with `digits`: a column per digit, joined or left at the `grow` end. */
  const syncColumns = (cols, host, digits, dir, atStart, ms, instant) => {
    const extra = digits.length - cols.length;
    if (extra > 0) {
      for (let i = 0; i < extra; i++) {
        // New columns appear at the left of the integer part and at the right of the fraction.
        const col = makeColumn(digits[atStart ? extra - 1 - i : cols.length + i], !instant, ms);
        if (atStart) {
          cols.unshift(col);
          host.insertBefore(col.el, host.firstChild);
        } else {
          cols.push(col);
          host.append(col.el);
        }
      }
    } else if (extra < 0) {
      for (let i = 0; i < -extra; i++) dropColumn(atStart ? cols.shift() : cols.pop(), ms);
    }
    // Columns line up from the decimal point: the integer part from its right, the fraction from its left.
    const offset = atStart ? cols.length - digits.length : 0;
    for (let i = 0; i < digits.length; i++) {
      const col = cols[i + offset];
      if (extra > 0 && ((atStart && i + offset < extra) || (!atStart && i >= cols.length - extra))) continue; // just built
      if (instant) {
        col.cell = MID + digits[i];
        setCell(col, false);
      } else turnColumn(col, digits[i], dir);
    }
  };

  const makeRoller = (el, ms = 200) => {
    el.classList.add('roll');
    el.innerHTML = '<span class="int"></span><span class="dot" hidden>.</span><span class="frac"></span>';
    const [intHost, dot, fracHost] = el.children;
    const roller = { text: undefined, ints: [], fracs: [] };
    /** Shows `text` (a plain number such as 40, 12.5 or 1000). `dir` is 1 when it rose, -1 when it fell; `instant` skips the roll. */
    roller.set = (text, dir = 1, instant = false) => {
      if (text === roller.text) return;
      const first = roller.text === undefined;
      roller.text = text;
      el.setAttribute('role', 'img');
      el.setAttribute('aria-label', text);
      const match = /^(\d+)(?:\.(\d+))?$/.exec(text);
      if (!match) return; // not a number: nothing to roll
      const quick = instant || first;
      syncColumns(roller.ints, intHost, [...match[1]].map(Number), dir, true, ms, quick);
      const fraction = match[2] ? [...match[2]].map(Number) : [];
      dot.hidden = fraction.length === 0;
      syncColumns(roller.fracs, fracHost, fraction, dir, false, ms, quick);
    };
    return roller;
  };

  const rollers = new Map();
  /** Rolls every copy of a number in a row (the slider draws each value twice). */
  const rollText = (host, selector, text, dir, instant) => {
    for (const node of host.querySelectorAll(selector)) {
      let roller = rollers.get(node);
      if (!roller) rollers.set(node, (roller = makeRoller(node)));
      roller.set(text, dir, instant);
    }
  };
  let nowRoller;
  let seen; // what the last render showed, to roll the right way: { key, min, max, now }

  /** Last state from the app, and the values being dragged (drafts). */
  let state;
  let draft;
  let geom; // the graph's width range, for turning a pointer position back into a canvas width
  let scrubbing = false;
  const CANVAS_MIN = 240; // Stacki's own lower limit for canvas.setWidth

  // The card lives in an iframe in the app's panel and talks to it with postMessage. The panel's app.js
  // owns the Stacki connection; the messages are the same objects as before.
  // The tooltip of a locked slider: shown once the pointer has rested on it for a second, above it.
  let tipTimer;
  let tipField;
  const hideTiedTip = () => {
    clearTimeout(tipTimer);
    tipField = undefined;
    $('tied-tip').hidden = true;
  };
  const showTiedTip = (field) => {
    const tip = $('tied-tip');
    tip.hidden = false;
    const card = $('card').getBoundingClientRect();
    const box = field.getBoundingClientRect();
    const width = tip.offsetWidth;
    const centre = box.left + box.width / 2 - card.left;
    const left = Math.max(4, Math.min(centre - width / 2, card.width - width - 4));
    tip.style.left = `${Math.round(left)}px`;
    tip.style.top = `${Math.round(box.top - card.top - tip.offsetHeight - 9)}px`;
    tip.style.setProperty('--caret-x', `${Math.round(centre - left)}px`);
    tipField = field;
  };

  /** A slider tied to the type scale: the app says so for the levels a locked scale sets from the smallest. */
  const tied = (k) => Boolean(state && state.lock && state.lock[k]);

  const send = (message) => parent.postMessage({ source: 'fluid-card', message }, '*');

  // The sliders' scale is one fixed range for every style: 0 at the left end, 150 at the right, where
  // the white bar is full. A bigger value keeps the bar full and the number keeps counting. The scale
  // never changes, so the white edge never moves under the pointer except by dragging.
  const LO = 0; // the value at the left end of the scale; the fill is never narrower than its label group
  const scaleHi = 150; // the value at which the white bar is full

  // The footer is for errors only. A save that worked shows itself in the values, so it says nothing.
  const setStatus = (text, tone) => {
    const footer = $('status');
    if (tone !== 'error') {
      footer.textContent = '';
      footer.className = '';
      return;
    }
    footer.textContent = text;
    footer.className = 'error';
  };

  const GRAPH_MAX = 100; // the font size at the top of the graph
  let dotDrag; // { k, top }: a dot being dragged, and the scale it was picked up on
  let graphGeom; // { w, h, d1 } of the graph as last drawn
  const drawGraph = (min, max) => {
    const svg = $('graph');
    const w = Math.max(100, svg.clientWidth || 290);
    const h = Math.max(16, svg.clientHeight || 24);
    svg.setAttribute('viewBox', `0 0 ${w} ${h}`);
    const { vMin, vMax, width } = state;
    const span = vMax - vMin;
    const x0 = vMin - span * 0.08;
    const x1 = vMax + span * 0.08;
    // The graph's height is a fixed 0 to GRAPH_MAX (100px) and nothing rescales as values change. Only a
    // value past the top makes room for itself.
    const d0 = 0;
    // While a dot is dragged the scale is the one it had when it was picked up, so the dot follows the
    // pointer; past the top it stays at the top edge and the number carries on counting.
    // With compare on, the other levels share the graph, so the scale has room for the biggest of them too.
    const others = state.compare && state.levels ? state.levels.filter((level) => level.key !== state.style.key) : [];
    const d1 = dotDrag ? dotDrag.top : Math.max(GRAPH_MAX, min, max, ...others.map((level) => level.max));
    graphGeom = { w, h, d1 };
    const px = (vw) => ((vw - x0) / (x1 - x0)) * w;
    const py = (size) => Math.min(h - 3, Math.max(3, h - 3 - ((size - d0) / (d1 - d0)) * (h - 6)));
    const pts = [
      [0, py(min)],
      [px(vMin), py(min)],
      [px(vMax), py(max)],
      [w, py(max)],
    ];
    const line = pts.map(([x, y], i) => `${i ? 'L' : 'M'}${x.toFixed(1)} ${y.toFixed(1)}`).join(' ');
    $('line').setAttribute('d', line);
    // The other levels, greyed: flat to their minimum, the ramp, flat from their maximum.
    const ghosts = $('ghosts');
    while (ghosts.children.length > others.length) ghosts.lastChild.remove();
    while (ghosts.children.length < others.length) {
      const path = document.createElementNS('http://www.w3.org/2000/svg', 'path');
      path.setAttribute('class', 'ghost');
      ghosts.appendChild(path);
    }
    others.forEach((level, i) => {
      const lo = py(level.min).toFixed(1);
      const hi = py(level.max).toFixed(1);
      ghosts.children[i].setAttribute('d', `M0 ${lo} L${px(vMin).toFixed(1)} ${lo} L${px(vMax).toFixed(1)} ${hi} L${w} ${hi}`);
    });
    $('area').setAttribute('d', `${line} L${w} ${h} L0 ${h} Z`);

    // The playhead marks the canvas's width; the size there is in the header.
    geom = { x0, x1 };
    const cx = px(Math.min(x1, Math.max(x0, width)));
    const head = $('playhead');
    head.style.left = `${cx}px`;
    head.setAttribute('aria-valuemin', String(Math.max(CANVAS_MIN, Math.round(x0))));
    head.setAttribute('aria-valuemax', String(Math.round(x1)));
    head.setAttribute('aria-valuenow', String(Math.round(width)));
    // Two dots: where the ramp starts and where it ends.
    $('dot-min').setAttribute('cx', px(vMin));
    $('dot-min').setAttribute('cy', py(min));
    $('dot-max').setAttribute('cx', px(vMax));
    $('dot-max').setAttribute('cy', py(max));
  };

  // ── The sliders ───────────────────────────────────────────────────────────
  //
  // The fill ends at edge(v), growing linearly from nothing at 0 to the full track at the top of the
  // scale:  edge(v) = maxEdge * v / scaleHi. It has no minimum width: at 0 there is no fill at all.
  // Past the top the fill stays full and the number keeps counting.

  const GRIP_MIN = 14; // the fill must be at least this wide to hold the grip
  const geomOf = (field) => {
    const value = field.querySelector('.txt.light .val');
    const maxEdge = Math.max(field.offsetWidth, 1); // the fill runs edge to edge: full at the track's right end
    return { minEdge: 0, maxEdge, valueLeft: value.offsetLeft };
  };
  const edgeOf = (g, value) => g.minEdge + (g.maxEdge - g.minEdge) * Math.max(0, Math.min(1, (value - LO) / (scaleHi - LO)));
  const valueAtX = (g, x) => LO + ((x - g.minEdge) / (g.maxEdge - g.minEdge)) * (scaleHi - LO);

  const paintField = (k, value) => {
    const { field } = els[k];
    const g = geomOf(field);
    const edge = edgeOf(g, value);
    field.style.setProperty('--edge', `${edge}px`);
    // The grip needs room inside the fill. (It stays when the fill reaches the number: the number is drawn over it.)
    field.style.setProperty('--grip-o', edge < GRIP_MIN ? '0' : '1');
    field.setAttribute('aria-valuemin', String(LO));
    field.setAttribute('aria-valuemax', String(Math.round(scaleHi)));
    field.setAttribute('aria-valuenow', FT.fmt(value));
    field.setAttribute('aria-valuetext', `${FT.fmt(value)}px`);
  };

  /** Stacki's check on the size as it would be with these values: live while dragging. */
  const checkNow = (min, max) => {
    if (!state.expr || !state.minVar || !state.maxVar) return undefined;
    const resolved = FT.resolveValue(state.expr, state.vars || {}, { [state.minVar]: String(min), [state.maxVar]: String(max) });
    return FT.fluidCheck(resolved);
  };

  /** The tip's caret points at the badge, wherever the header has put it. */
  const placeCaret = () => {
    const box = $('badge').getBoundingClientRect();
    if (box.width > 0) $('tip').style.setProperty('--caret-x', `${Math.round(box.left + box.width / 2 - $('tip').getBoundingClientRect().left)}px`);
  };

  const renderCheck = (min, max) => {
    const result = state.editable === false ? undefined : checkNow(min, max);
    const status = result && result.status !== 'ok' ? result.status : '';
    const flag = $('flag');
    if (status) card.setAttribute('data-check', status);
    else card.removeAttribute('data-check');
    flag.toggleAttribute('data-off', !status);
    $('badge').tabIndex = status ? 0 : -1;
    if (status) flag.dataset.status = status; // keep the last one while it fades out
    if (!status) return;
    const message = FT.FLUID_COPY[status];
    const badge = $('badge');
    if (badge.dataset.status !== status) badge.innerHTML = FT.badgeHtml(status);
    badge.dataset.status = status;
    badge.setAttribute('aria-label', `${status === 'error' ? 'Accessibility error' : 'Accessibility warning'}: ${message}`);
    $('tip-msg').textContent = message;
    placeCaret();
    const why = $('tip-why');
    why.hidden = status !== 'error';
    if (status === 'error') why.href = FT.FLUID_LINK;
  };

  const render = () => {
    if (!state || !state.style) return;
    card.toggleAttribute('data-loading', Boolean(state.loading));
    const min = draft ? draft.min : state.min;
    const max = draft ? draft.max : state.max;

    $('chip').textContent = state.style.label;
    // A change of style, or the first look, shows its numbers as they are; after that they roll.
    const fresh = !seen || seen.key !== state.style.key || seen.loading !== Boolean(state.loading) || state.editable === false; // placeholders and the first real numbers are set, not rolled
    const nowSize = FT.sizeAt(state.width, min, max, state.vMin, state.vMax);
    if (!nowRoller) nowRoller = makeRoller($('now'), 140);
    nowRoller.set(FT.fmt(nowSize, 1), !seen || nowSize >= seen.now ? 1 : -1, fresh);

    for (const [k, value] of [['min', min], ['max', max]]) {
      rollText(els[k].row, '.v', FT.fmt(value), !seen || value >= seen[k] ? 1 : -1, fresh);
      paintField(k, value);
    }
    $('compare').setAttribute('aria-pressed', String(Boolean(state.compare)));
    drawGraph(min, max);

    const locked = state.editable === false;
    card.toggleAttribute('data-locked', locked);
    for (const k of ['min', 'max']) {
      const { field } = els[k];
      const fixed = locked || tied(k);
      field.tabIndex = fixed ? -1 : 0;
      field.setAttribute('aria-disabled', String(fixed));
      field.toggleAttribute('data-tied', tied(k));
      if (!tied(k) && tipField === field) hideTiedTip(); // it was the one showing, and is free now
    }
    renderCheck(min, max);
    seen = { key: state.style.key, min, max, now: nowSize, loading: Boolean(state.loading) };
  };

  // While a slider is dragged the app writes the values to the stylesheet as it goes, so the page's
  // type follows the pointer. Throttled, and only when a rounded value changed.
  const PREVIEW_EVERY = 100;
  let previewTimer;
  let previewAt = 0;
  let previewWanted;
  let previewSent;
  const preview = (min, max) => {
    previewWanted = { min, max };
    if (previewTimer) return;
    previewTimer = setTimeout(() => {
      previewTimer = undefined;
      previewAt = performance.now();
      const next = previewWanted;
      previewWanted = undefined;
      if (!next || !state) return;
      if (previewSent && previewSent.min === next.min && previewSent.max === next.max) return;
      previewSent = next;
      send({ type: 'preview', key: state.style.key, min: next.min, max: next.max });
    }, Math.max(0, PREVIEW_EVERY - (performance.now() - previewAt)));
  };
  const endPreview = () => {
    clearTimeout(previewTimer);
    previewTimer = undefined;
    previewWanted = undefined;
    previewSent = undefined;
  };

  const commit = () => {
    // Remember whether the app wrote live values for this drag, before that is forgotten.
    const hadPreview = Boolean(previewSent) || draftSent;
    draftSent = false;
    endPreview();
    if (!draft || !state) return;
    const { min, max } = draft;
    draft = undefined;
    if (min === state.min && max === state.max) {
      render();
      // Dragged back to where it started: nothing to save, but the stylesheet holds live values to put back.
      if (hadPreview) send({ type: 'cancel', key: state.style.key });
      return;
    }
    // Show the new values at once; the app confirms with its next state.
    state = { ...state, min, max };
    render();
    send({ type: 'commit', key: state.style.key, min, max });
  };

  let drag; // { k }: the slider being dragged
  let draftSent = false; // this drag has told the panel about at least one in-between value

  /** Moves one value; the other follows so min never passes max. */
  const move = (k, value) => {
    if (!state) return;
    const base = draft || { min: state.min, max: state.max };
    const next = { ...base, [k]: value };
    if (k === 'min' && next.min > next.max) next.max = next.min;
    if (k === 'max' && next.max < next.min) next.min = next.max;
    draft = next;
    render();
    if (drag) {
      preview(next.min, next.max);
      // The panel's type scale follows the drag as it happens: no file write waits on this.
      draftSent = true;
      send({ type: 'draft', key: state.style.key, min: next.min, max: next.max });
    }
  };

  const DRAG_MAX = 1000; // a drag does not raise the number past this
  const roundTo = (value, fine) => (fine ? Math.round(value * 10) / 10 : Math.round(value));
  let keyTimer;
  // Hover is tracked here rather than left to :hover. While a drag holds the pointer no enter or leave
  // is sent, and a release outside the frame sends nothing either, so :hover could be left on a slider
  // the pointer is nowhere near. A slider is hot while the pointer is over it, and not after a release
  // anywhere else.
  let lastPointer;
  const clearHot = () => {
    for (const { field } of Object.values(els)) delete field.dataset.hot;
  };
  const settleHot = () => {
    if (!lastPointer) return clearHot();
    for (const { field } of Object.values(els)) {
      const box = field.getBoundingClientRect();
      const inside = lastPointer.x >= box.left && lastPointer.x <= box.right && lastPointer.y >= box.top && lastPointer.y <= box.bottom;
      if (inside) field.dataset.hot = '';
      else delete field.dataset.hot;
    }
  };
  for (const type of ['pointermove', 'pointerup', 'pointerdown']) {
    document.addEventListener(type, (event) => (lastPointer = { x: event.clientX, y: event.clientY }), true);
  }
  document.documentElement.addEventListener('pointerleave', () => {
    lastPointer = undefined;
    if (!drag) clearHot();
  });
  window.addEventListener('blur', () => {
    lastPointer = undefined;
    if (!drag) clearHot();
  });

  const endDrag = () => {
    if (!drag) return;
    drag = undefined;
    for (const { field } of Object.values(els)) delete field.dataset.dragging;
    settleHot();
    commit();
  };

  for (const k of ['min', 'max']) {
    const { field } = els[k];

    // Drag: the pointer's own position is the value, on every move, so the white edge is under the
    // pointer wherever the value is inside the scale. Below the floor the value is 0 and the fill sits
    // at its least; the moment the pointer is back to the right of that it responds. Past the right
    // end the same linear mapping carries on (the number rises, the fill stays full), and the scale
    // is not touched until release. Pointer capture keeps the events coming outside the frame.
    const valueAtPointer = (event, fine) => {
      const g = geomOf(field);
      const x = event.clientX - field.getBoundingClientRect().left; // read fresh: nothing is assumed to hold still
      return roundTo(Math.max(LO, Math.min(DRAG_MAX, valueAtX(g, x))), fine);
    };
    field.addEventListener('pointerenter', () => {
      if (!drag) field.dataset.hot = '';
      if (tied(k)) {
        clearTimeout(tipTimer);
        tipTimer = setTimeout(() => tied(k) && showTiedTip(field), 1000);
      }
    });
    field.addEventListener('pointerleave', () => {
      if (!drag) delete field.dataset.hot;
      hideTiedTip();
    });
    field.addEventListener('pointerdown', hideTiedTip);
    field.addEventListener('pointerdown', (event) => {
      if (event.button !== 0 || !state || state.editable === false || tied(k)) return;
      field.setPointerCapture(event.pointerId);
      field.focus({ preventScroll: true });
      event.preventDefault();
      clearTimeout(keyTimer);
      drag = { k };
      field.dataset.dragging = '';
      move(k, valueAtPointer(event, event.altKey)); // a press on the row jumps the value to that spot, with no grab offset
    });
    field.addEventListener('pointermove', (event) => {
      if (!drag || drag.k !== k) return;
      move(k, valueAtPointer(event, event.altKey));
    });
    // The value is saved once, on release. A scale too small for it grows then (in render, from the saved state).
    for (const type of ['pointerup', 'pointercancel', 'lostpointercapture']) field.addEventListener(type, endDrag);

    field.addEventListener('keydown', (event) => {
      if (event.target !== field || !state || state.editable === false || tied(k)) return;
      if (!['ArrowLeft', 'ArrowRight', 'ArrowUp', 'ArrowDown', 'Home', 'End'].includes(event.key)) return;
      event.preventDefault();
      const current = draft ? draft[k] : state[k];
      const step = event.shiftKey ? 10 : event.altKey ? 0.1 : 1;
      const up = event.key === 'ArrowRight' || event.key === 'ArrowUp';
      const next = event.key === 'Home' ? LO : event.key === 'End' ? scaleHi : current + (up ? step : -step);
      move(k, Math.round(Math.max(LO, Math.min(DRAG_MAX, next)) * 10) / 10);
      // A burst of key presses is one change.
      clearTimeout(keyTimer);
      keyTimer = setTimeout(commit, 350);
    });
    field.addEventListener('blur', () => {
      clearTimeout(keyTimer);
      if (draft) commit();
    });
  }

  window.addEventListener('message', (event) => {
    const data = event.data;
    if (!data || data.source !== 'fluid-app' || !data.message) return;
    const message = data.message;
    if (message.type === 'state') {
      const held = scrubbing && state ? state.width : undefined;
      state = message.state;
      // The panel's own input colour, so the slider tracks match its fields.
      if (state.track) document.documentElement.style.setProperty('--track', state.track);
      if (held !== undefined) state = { ...state, width: held };
      if (message.status) setStatus(message.status.text, message.status.tone);
      render();
    } else if (message.type === 'width' && state && !scrubbing) {
      // The canvas is being resized: only the width changed, so only the cursor and readout move.
      state = { ...state, width: message.width };
      render();
    }
  });


  // ── The playhead ──────────────────────────────────────────────────────────
  //
  // Drag it, or click anywhere on the graph, and the canvas width follows. The HUD moves its own
  // line at once and asks the app to resize the canvas, at most once a frame; the app's echo of the
  // width is ignored until the pointer is released, so the two never fight.

  const plot = document.querySelector('.plot');
  let latestWidth;
  let queued = false;

  const requestWidth = (width) => {
    latestWidth = width;
    if (queued) return;
    queued = true;
    requestAnimationFrame(() => {
      queued = false;
      send({ type: 'setWidth', width: latestWidth });
    });
  };

  const moveTo = (width) => {
    if (!state || width === state.width) return;
    state = { ...state, width };
    render();
    requestWidth(width);
  };

  // The drag is measured in screen distance from where it began, not from the graph's position.
  // The frame is anchored to the element, so it can shift under the pointer while the canvas
  // resizes; a pointer position read against the graph would then feed back into the width.
  const lowest = () => Math.max(CANVAS_MIN, state.vMin);
  const clampWidth = (width) => Math.round(Math.min(state.vMax, Math.max(lowest(), width)));
  const widthAt = (clientX) => {
    const box = $('graph').getBoundingClientRect();
    if (!geom || box.width <= 0) return undefined;
    return clampWidth(geom.x0 + ((clientX - box.left) / box.width) * (geom.x1 - geom.x0));
  };
  let anchor; // { screenX, width, perPx } where the drag began
  const widthFromDrag = (screenX) => clampWidth(anchor.width + (screenX - anchor.screenX) * anchor.perPx);

  const endScrub = () => {
    if (!scrubbing) return;
    scrubbing = false;
    delete plot.dataset.scrubbing;
  };

  // The two dots on the graph are handles: drag one up or down and its slider follows, number and all.
  const DOT_REACH = 14; // css px around a dot that picks it up
  const dotAt = (event) => {
    if (!state || state.editable === false || !graphGeom) return undefined;
    const box = $('graph').getBoundingClientRect();
    if (box.width <= 0 || box.height <= 0) return undefined;
    let best;
    for (const k of ['min', 'max']) {
      if (tied(k)) continue; // a dot on a locked side is not a handle
      const dot = $(`dot-${k}`);
      const x = box.left + (Number(dot.getAttribute('cx')) * box.width) / graphGeom.w;
      const y = box.top + (Number(dot.getAttribute('cy')) * box.height) / graphGeom.h;
      const distance = Math.hypot(event.clientX - x, event.clientY - y);
      if (distance <= DOT_REACH && (!best || distance < best.distance)) best = { k, distance };
    }
    return best && best.k;
  };
  const valueAtY = (event) => {
    const box = $('graph').getBoundingClientRect();
    const y = ((event.clientY - box.top) * graphGeom.h) / Math.max(box.height, 1);
    const value = ((graphGeom.h - 3 - y) / (graphGeom.h - 6)) * dotDrag.top;
    return roundTo(Math.max(LO, Math.min(DRAG_MAX, value)), event.altKey);
  };
  const endDot = () => {
    if (!dotDrag) return;
    dotDrag = undefined;
    delete plot.dataset.dotDragging;
    for (const k of ['min', 'max']) $(`dot-${k}`).classList.remove('hot');
    endDrag(); // the same release as a slider's: one commit, one drag over
  };
  const hotDot = (k) => {
    for (const other of ['min', 'max']) $(`dot-${other}`).classList.toggle('hot', other === k);
    plot.style.cursor = k ? 'ns-resize' : '';
  };

  plot.addEventListener('pointerdown', (event) => {
    if (!state || event.button !== 0) return;
    const grabbed = dotAt(event);
    if (grabbed) {
      plot.setPointerCapture(event.pointerId);
      drag = { k: grabbed };
      dotDrag = { k: grabbed, top: graphGeom.d1 };
      plot.dataset.dotDragging = grabbed;
      els[grabbed].field.dataset.dragging = ''; // its slider lights up as if it were being dragged
      hotDot(grabbed);
      move(grabbed, valueAtY(event));
      event.preventDefault();
      return;
    }
    scrubbing = true;
    plot.dataset.scrubbing = '';
    plot.setPointerCapture(event.pointerId);
    // A click on the graph jumps there; the drag carries on from that spot.
    const width = widthAt(event.clientX);
    if (width !== undefined) moveTo(width);
    const box = $('graph').getBoundingClientRect();
    anchor = {
      screenX: event.screenX,
      width: state.width,
      perPx: geom && box.width > 0 ? (geom.x1 - geom.x0) / box.width : 1,
    };
    event.preventDefault();
  });
  plot.addEventListener('pointermove', (event) => {
    if (dotDrag) {
      move(dotDrag.k, valueAtY(event));
      return;
    }
    if (!scrubbing || !anchor) {
      hotDot(dotAt(event)); // a dot under the pointer is lit, and shows it can be dragged
      return;
    }
    moveTo(widthFromDrag(event.screenX));
  });
  plot.addEventListener('pointerleave', () => {
    if (!dotDrag) hotDot(undefined);
  });
  for (const type of ['pointerup', 'pointercancel', 'lostpointercapture']) {
    plot.addEventListener(type, () => {
      endDot();
      endScrub();
    });
  }

  $('playhead').addEventListener('keydown', (event) => {
    if (!state || !['ArrowLeft', 'ArrowRight', 'Home', 'End'].includes(event.key)) return;
    event.preventDefault();
    const step = event.shiftKey ? 100 : event.altKey ? 1 : 10;
    const next =
      event.key === 'Home' ? state.vMin : event.key === 'End' ? state.vMax : state.width + (event.key === 'ArrowRight' ? step : -step);
    moveTo(clampWidth(next));
  });

  // The header can shift as its readout changes length, so the caret is placed again when the tip is about to show.
  $('flag').addEventListener('pointerenter', placeCaret);
  $('flag').addEventListener('focusin', placeCaret);

  window.addEventListener('resize', render);
  // Stacki forwards undo, redo and save from an app's own frame, but not from a frame inside it, and
  // after a drag the keyboard focus is in this one. So those keys are caught here and handed to the
  // panel, which asks Stacki to run them.
  document.addEventListener(
    'keydown',
    (event) => {
      if (!(event.metaKey || event.ctrlKey) || event.altKey) return;
      const key = event.key.toLowerCase();
      let shortcut;
      if (key === 'z') shortcut = event.shiftKey ? 'redo' : 'undo';
      else if (key === 'y' && !event.shiftKey) shortcut = 'redo';
      else if (key === 's' && !event.shiftKey) shortcut = 'save';
      if (!shortcut) return;
      event.preventDefault();
      send({ type: 'shortcut', shortcut });
    },
    true,
  );

  $('compare').addEventListener('click', () => {
    if (!state) return;
    state = { ...state, compare: !state.compare };
    render();
    send({ type: 'compare', on: Boolean(state.compare) }); // the panel remembers it
  });

  send({ type: 'ready' });
})();
