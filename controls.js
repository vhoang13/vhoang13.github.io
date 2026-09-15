/* ============================================================
   controls.js — the World panel: the tuning hooks, with a face.

   Every knob here writes through a vh-dev-* event that game.js has
   listened for since the look-review sessions (the designer picks the
   amount ON SCREEN, never from a description). Nothing in engine/world/
   fx/sfx learned a new API for this file; the console idiom still works.

   Two depths, one panel:
     - visitors: the look (moon, lamp glow, shadows, fireflies) and
       sound, plus "Reset the look".
     - #dev: everything above, plus glow spread, ground pools, flowers
       (Hanging Gardens only — invisible on most islands, which is why
       it is not a visitor knob), grain, per-family material texture,
       framing, the audio mix, the harness buttons, and copy-config —
       the console workflow, on a phone.

   Persistence splits by KIND. Sound (vh-sound, owned by sfx.js) is the
   visitor's preference and survives a reload. The look does not: every
   arrival sees the composed world. The blocks are the visitor's
   (vh-build-v1); the lighting is the designer's. Reduced motion is the
   OS setting, read by engine.js — there is no switch for it here.

   Load order: after game.js — the listeners must exist before the first
   slider fires, and VH.closeOtherPanels / VH.reflectSound live there.
   ============================================================ */
(() => {
  'use strict';
  const VH = window.VH;
  const E = VH.engine;
  const W = VH.world;
  const C = (VH.controls = {});
  const FX = VH.fx;
  const DEV = location.hash === '#dev';
  const TOUCH = 'ontouchstart' in window;

  const fire = (name, detail) =>
    document.dispatchEvent(new CustomEvent(name, { detail }));
  // Up to two decimals, no trailing zeros: 0.8 not 0.80, 18 not 18.00.
  const raw = (v) => Number(v).toFixed(2).replace(/\.?0+$/, '');
  // Visitors see where in the range a knob sits ("Shadows 40%"), not the
  // engine's unit-less number ("Shadows 0.4", which reads like a bug).
  // #dev shows the raw value — that is the number that gets copied.
  const fmt = (v, k) => DEV || !k
    ? raw(v)
    : Math.round((v - k.min) / (k.max - k.min) * 100) + '%';

  // Values with no readable home. GRAIN is a `let` inside game.js; the
  // hook logs it but nothing exposes it, so the panel remembers what it
  // last sent (seeded with the shipped default).
  const cache = { grain: 0.55 };
  const audio = () => (VH.sfx && VH.sfx.tune ? VH.sfx.tune({}) : {});

  // ── The registry ───────────────────────────────────────────
  // Ranges are wide enough to be wrong on both sides: a slider that
  // stops at the current value hides the fact that past it is better.
  //
  // Writes set the SAME properties the vh-dev-* hooks set (that is all
  // those hooks do), rather than dispatching the events: game.js only
  // registers the listeners under #dev, so for a visitor an event would
  // fire into nothing. Grain is the one exception — it lives in a `let`
  // inside game.js and is reachable only through its hook, so it is a
  // #dev knob and the hook exists whenever it is shown.
  const KNOBS = [
    { id: 'moon', group: 'Light', label: 'Moon height', min: 6, max: 48, step: 1,
      read: () => E.MOON_ALT, write: (v) => { E.MOON_ALT = v; } },
    { id: 'gain', group: 'Light', label: 'Lamp glow', min: 0, max: 2, step: 0.05,
      read: () => E.LIGHT_GAIN, write: (v) => { E.LIGHT_GAIN = v; } },
    { id: 'shadow', group: 'Light', label: 'Shadows', min: 0, max: 1, step: 0.05,
      read: () => E.SHADOW_STRENGTH, write: (v) => { E.SHADOW_STRENGTH = v; } },
    { id: 'fireflies', group: 'Island', label: 'Fireflies', min: 0, max: 12, step: 1,
      read: () => FX.FIREFLIES, write: (v) => { FX.FIREFLIES = v; } },

    // ── #dev only from here down ──
    { dev: true, id: 'flowers', group: 'Island', label: 'Flowers (Hanging Gardens)', min: 0, max: 3, step: 0.1,
      read: () => W.FLOWERS_ON, write: (v) => { W.FLOWERS_ON = Math.max(0, v); } },
    { dev: true, id: 'blur', group: 'Light', label: 'Glow spread', min: 0, max: 40, step: 1,
      read: () => E.LIGHT_BLUR, write: (v) => { E.LIGHT_BLUR = v; } },
    { dev: true, id: 'ground', group: 'Light', label: 'Ground pools', min: 0, max: 2, step: 0.05,
      read: () => E.GROUND_GAIN, write: (v) => { E.GROUND_GAIN = v; } },
    { dev: true, id: 'grain', group: 'Surface', label: 'Grain', min: 0, max: 1.5, step: 0.05,
      read: () => cache.grain, write: (v) => { cache.grain = v; fire('vh-dev-grain', { amount: v }); } },
    ...['stone', 'brick', 'marble', 'wood', 'metal', 'sand'].map((family) => ({
      dev: true, id: 'mat-' + family, group: 'Surface', min: 0, max: 1.5, step: 0.05,
      label: family[0].toUpperCase() + family.slice(1) + ' texture',
      read: () => W.MAT[family], write: (v) => { W.MAT[family] = Math.max(0, v); },
    })),
    { dev: true, id: 'div', group: 'Framing', label: 'Frame divisor (up = smaller island)',
      min: 400, max: 700, step: 10,
      read: () => E.FRAME_DIV, write: (v) => { E.FRAME_DIV = v; E.resize(); } },
    { dev: true, id: 'anchor', group: 'Framing', label: 'Vertical anchor', min: 0.2, max: 0.8, step: 0.01,
      read: () => E.FRAME_ANCHOR, write: (v) => { E.FRAME_ANCHOR = v; E.resize(); } },
    { dev: true, id: 'wet', group: 'Audio', label: 'Reverb', min: 0, max: 1, step: 0.05,
      read: () => audio().wet, write: (v) => VH.sfx.tune({ wet: v }) },
    { dev: true, id: 'spread', group: 'Audio', label: 'Stereo width', min: 0, max: 1, step: 0.05,
      read: () => audio().spread, write: (v) => VH.sfx.tune({ spread: v }) },
    { dev: true, id: 'master', group: 'Audio', label: 'Master level', min: 0, max: 0.5, step: 0.01,
      read: () => audio().master, write: (v) => VH.sfx.tune({ master: v }) },
  ].filter((k) => DEV || !k.dev);

  // Results print to the console — these are the harnesses game.js
  // already ships, reachable without typing their event names.
  const ACTIONS = DEV ? [
    ['Rotate ¼', () => fire('vh-dev-rotate', { steps: 1 })],
    ['Barrage', () => fire('vh-dev-barrage', { n: 30 })],
    ['Perf 300f', () => fire('vh-dev-perf', { frames: 300 })],
    ['Invariants', () => fire('vh-dev-invariant')],
    ['State', () => fire('vh-dev-state')],
    ['Check', () => fire('vh-dev-check')],
  ] : [];
  const HARNESS = DEV ? [
    ['Buildable', () => fire('vh-dev-buildable')],
    ['Weight', () => fire('vh-dev-weight')],
    ['Tumble', () => fire('vh-dev-tumble')],
    ['Neighbours', () => fire('vh-dev-neighbours')],
    ['Monstack', () => fire('vh-dev-monstack')],
  ] : [];

  // The shipped look, captured before anything is touched. Reset writes
  // these back — no second copy of the defaults to drift.
  const DEFAULTS = {};
  KNOBS.forEach((k) => { DEFAULTS[k.id] = k.read(); });

  // ── DOM ────────────────────────────────────────────────────
  const el = (tag, attrs, ...children) => {
    const n = document.createElement(tag);
    Object.entries(attrs || {}).forEach(([a, v]) => {
      if (a === 'class') n.className = v;
      else if (a === 'text') n.textContent = v;
      else if (a.startsWith('on')) n.addEventListener(a.slice(2), v);
      else n.setAttribute(a, v);
    });
    children.forEach((c) => c && n.appendChild(c));
    return n;
  };

  const panel = document.getElementById('world');
  const body = document.getElementById('worldBody');
  const btn = document.getElementById('worldBtn');
  const ranges = new Map(); // knob id → { input, out }

  // The filled part of the track, which the CSS paints. WebKit keeps the
  // 20px thumb inside the track, so the thumb's centre travels from 10px
  // to (100% − 10px); the fill edge follows that, not a bare percent, or
  // the two drift apart by up to 10px at the ends.
  const paint = (input, k, v) => {
    const ratio = (v - k.min) / (k.max - k.min);
    input.style.setProperty('--p', 'calc(10px + (100% - 20px) * ' + ratio + ')');
  };
  // Sighted visitors read the percent; the slider announces the same.
  const say = (input, k, v) => input.setAttribute('aria-valuetext', fmt(v, k));

  function knobRow(k) {
    // aria-hidden: the <output> sits inside the <label> that names the
    // slider, and a name that changes on every nudge is disorienting.
    // The value is still announced from the slider itself.
    const out = el('output', { class: 'world-value', 'aria-hidden': 'true', text: fmt(k.read(), k) });
    const input = el('input', {
      type: 'range', class: 'world-range', id: 'world-' + k.id,
      min: k.min, max: k.max, step: k.step, value: k.read(),
      oninput: (e) => {
        const v = +e.target.value;
        k.write(v);
        out.textContent = fmt(v, k);
        paint(input, k, v);
        say(input, k, v);
      },
    });
    paint(input, k, k.read());
    say(input, k, k.read());
    ranges.set(k.id, { input, out, k });
    // A single <label> wraps everything, so the label text, the value,
    // and the gap all focus the slider — no dead zones.
    return el('label', { class: 'world-row', for: 'world-' + k.id },
      el('span', { class: 'world-label', text: k.label }), out, input);
  }

  function group(title, ...rows) {
    const g = el('section', { class: 'world-group' },
      el('h3', { class: 'world-group-title', text: title }), ...rows);
    return g;
  }

  function buttons(pairs) {
    return el('div', { class: 'world-actions' },
      ...pairs.map(([label, fn]) => el('button', { type: 'button', class: 'world-btn', text: label, onclick: fn })));
  }

  // Sound: real radios styled as a segmented control, so arrow keys and
  // screen readers get the platform behaviour for free.
  let soundInputs = [];
  function soundRow() {
    const legend = el('legend', { class: 'world-label', text: 'Sound' });
    const seg = el('div', { class: 'world-seg' });
    soundInputs = [['full', 'Full'], ['quiet', 'Quiet'], ['off', 'Off']].map(([v, label]) => {
      const input = el('input', {
        type: 'radio', name: 'world-sound', value: v, id: 'world-sound-' + v,
        onchange: () => {
          if (!VH.sfx) return;
          VH.sfx.setState(v);
          if (VH.reflectSound) VH.reflectSound(); // the header icon shows the same state
          if (v !== 'off') VH.sfx.pop();
        },
      });
      seg.appendChild(el('label', { class: 'world-seg-item', for: 'world-sound-' + v },
        input, el('span', { text: label })));
      return input;
    });
    return el('fieldset', { class: 'world-field' }, legend, seg);
  }

  // ── Build ──────────────────────────────────────────────────
  const byGroup = new Map();
  KNOBS.forEach((k) => {
    if (!byGroup.has(k.group)) byGroup.set(k.group, []);
    byGroup.get(k.group).push(knobRow(k));
  });
  byGroup.forEach((rows, title) => body.appendChild(group(title, ...rows)));

  body.appendChild(group('Sound', soundRow()));

  // "The look" is the scene, not the mix: under #dev the Audio sliders
  // are knobs too, but Reset leaves them where the ear put them.
  const resetBtn = el('button', { type: 'button', class: 'world-btn world-btn--wide', text: 'Reset the look',
    onclick: () => {
      KNOBS.filter((k) => k.group !== 'Audio').forEach((k) => k.write(DEFAULTS[k.id]));
      C.sync();
      if (VH.sfx) VH.sfx.pop();
      // Visible confirmation too: with sound off, and sliders already at
      // their defaults, nothing else would show the click landed.
      resetBtn.textContent = 'Look reset';
      setTimeout(() => { resetBtn.textContent = 'Reset the look'; }, 1200);
    } });
  body.appendChild(el('div', { class: 'world-foot' }, resetBtn,
    el('p', { class: 'world-sub', text: 'Sound is remembered. The look resets on your next visit.' })));

  if (DEV) {
    body.appendChild(group('Actions', buttons(ACTIONS)));
    body.appendChild(group('Harness', buttons(HARNESS),
      el('p', { class: 'world-sub', text: 'Results print to the console.' })));
    // The number is what survives the session: one line, paste-ready.
    const copyBtn = el('button', { type: 'button', class: 'world-btn world-btn--wide', text: 'Copy config',
      onclick: () => {
        const line = KNOBS.map((k) => k.id + ': ' + raw(k.read())).join(' · ');
        const done = () => { copyBtn.textContent = 'Copied'; setTimeout(() => { copyBtn.textContent = 'Copy config'; }, 1200); };
        console.log('[world]', line);
        if (navigator.clipboard) navigator.clipboard.writeText(line).then(done, done); else done();
      } });
    body.appendChild(el('div', { class: 'world-foot' }, copyBtn));
    document.getElementById('worldMode').textContent = 'dev';
  }

  // ── Sync: the panel shows what the world IS, never what it remembers ──
  C.sync = () => {
    ranges.forEach(({ input, out, k }) => {
      const v = k.read();
      if (v == null || !Number.isFinite(+v)) return;
      input.value = v;
      out.textContent = fmt(v, k);
      paint(input, k, v);
      say(input, k, v);
    });
    if (VH.sfx) soundInputs.forEach((i) => { i.checked = i.value === VH.sfx.state; });
  };

  // ── Open / close: the fourth right-edge panel, same rules as the rest ──
  function reflect() {
    const open = VH.panelIsOpen(panel);
    btn.setAttribute('aria-expanded', String(open));
    btn.setAttribute('aria-label', open ? 'Close world settings' : 'Open world settings');
  }
  C.isOpen = () => VH.panelIsOpen(panel);
  C.open = () => {
    if (VH.panelIsOpen(panel)) return;
    if (VH.closeOtherPanels) VH.closeOtherPanels({ silent: true });
    C.sync();
    VH.revealPanel(panel);
    reflect();
    // Keyboard users land on the first slider; on touch, focusing a
    // control would scroll or highlight for no reason.
    if (!TOUCH) { const first = panel.querySelector('input'); if (first) first.focus(); }
  };
  C.close = (opts) => {
    const inside = panel.contains(document.activeElement);
    if (!VH.dismissPanel(panel)) return;
    reflect();
    if (!(opts && opts.silent) && VH.sfx) VH.sfx.uiTick('close');
    if (inside) btn.focus(); // never strand focus on a hidden node
  };
  btn.addEventListener('click', (e) => {
    e.stopPropagation();
    if (!VH.panelIsOpen(panel)) { if (VH.sfx) VH.sfx.uiTick('open'); C.open(); }
    else C.close();
  });
  document.getElementById('worldClose').addEventListener('click', () => C.close());

  // The right-edge panels sit at a fixed top, but on a phone the control
  // row above them wraps — two rows on most, three at 390px once this
  // button joined — and a rem guess either overlaps the third row or
  // wastes space when there are two. Measure instead: publish the row's
  // bottom edge as a custom property and let the phone CSS position all
  // four panels from it.
  {
    const controls = document.getElementById('controls');
    // offsetTop/offsetHeight, not getBoundingClientRect: the row enters
    // with a translateY(-10px) that the rect would include, and it is
    // measured before .show lands — so the rect is 10px short and the
    // observer never re-fires (the SIZE never changes, only the slide).
    const publish = () => {
      document.documentElement.style.setProperty(
        '--controls-bottom', (controls.offsetTop + controls.offsetHeight) + 'px');
    };
    publish();
    if ('ResizeObserver' in window) new ResizeObserver(publish).observe(controls);
    else window.addEventListener('resize', publish);
  }

  C.sync();
  reflect();
})();
