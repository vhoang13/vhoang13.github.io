/* ============================================================
   world.js — block state, physics, block rendering
   Physics constants are per-SECOND (converted from the original
   per-frame values that assumed 60 fps).
   ============================================================ */
(() => {
  'use strict';
  const VH = window.VH;
  const E = VH.engine;

  const W = (VH.world = {});

  // ── Colors ──────────────────────────────────────────────────
  W.COLORS = {
    // Toy palette, sat down into the moonlight (2026-09): ~14% less
    // saturated than the original primaries, and the side faces pulled a
    // little toward the sky's cool navy so a stack reads as one lit mass
    // instead of plastic bricks. Tops keep their hue so a swatch still
    // says "red" at a glance.
    red:    { top: '#d65a5a', right: '#98383c', front: '#b3474a' },
    blue:   { top: '#5a91d6', right: '#375c9d', front: '#4774b6' },
    green:  { top: '#58c07b', right: '#357851', front: '#459861' },
    yellow: { top: '#e4c84c', right: '#a48d30', front: '#bfa63d' },
    orange: { top: '#e39e3d', right: '#a46e30', front: '#bf8337' },
    purple: { top: '#a077c9', right: '#684b91', front: '#805ba9' },
    cyan:   { top: '#5ac1ce', right: '#378696', front: '#46a0af' },
    pink:   { top: '#e078a2', right: '#a04c74', front: '#bb5d85' },
    white:  { top: '#e8e8e0', right: '#b8b8b0', front: '#d0d0c8' },
    grass:  { top: '#4a8c50', right: '#2a5c30', front: '#387040' },
    dirt:   { top: '#8b6b3d', right: '#5c4428', front: '#745832' },
    lamp:   { top: '#ffe9a8', right: '#e0ae4a', front: '#f2c968' },
    glass:  { top: '#d5ecf4', right: '#9dc4d4', front: '#bcdae6' },
    // Monument palette — reads as carved stone against the toy colors.
    // NEVER rename or remove a key: saved monuments reference them.
    stone:      { top: '#e2dccb', right: '#a99f8a', front: '#c9c1ac' },
    stoneDark:  { top: '#b8b09c', right: '#847b68', front: '#a2977f' },
    gold:       { top: '#ffd968', right: '#c99a2e', front: '#edbc4a' },
    lightRed:   { top: '#e05050', right: '#a83636', front: '#c84343' },
    lightWhite: { top: '#f4f0e6', right: '#c0b9a8', front: '#e0d9c8' },
    // True-to-reference monument colours (2026-08 detail pass). Monument-
    // only: not in BLOCK_COLORS, so none are placeable. Fronts stay bright
    // enough to read as firework sparks (debris keeps its piece colour).
    vermilion:    { top: '#ef5f45', right: '#b93a28', front: '#d84b35' }, // torii columns
    kasagiBlack:  { top: '#454b54', right: '#272b31', front: '#363b42' }, // torii top lintel
    copper:       { top: '#8a5a3c', right: '#5e3a26', front: '#744a30' }, // torii roof plates
    travertine:   { top: '#e8dfc8', right: '#b3a684', front: '#d0c5a6' }, // colosseum
    travertineDark:{ top: '#c9bda0', right: '#948a6d', front: '#b0a486' },
    marble:       { top: '#f2efe6', right: '#bfbaa9', front: '#dcd7c6' }, // parthenon / arc
    marbleShadow: { top: '#d8d3c4', right: '#a09a89', front: '#c0baa9' },
    ironBronze:   { top: '#8a6a4f', right: '#5a4232', front: '#71543e' }, // eiffel brown
    sarsenGrey:   { top: '#b9b5ac', right: '#807c74', front: '#9d9990' }, // stonehenge
    brickGrey:    { top: '#a8a49c', right: '#6f6c65', front: '#8d8a82' }, // great wall
    brickDark:    { top: '#8b8880', right: '#5a5750', front: '#74716a' },
    paleIronBlue: { top: '#b9cede', right: '#7f96aa', front: '#9fb5c7' }, // crystal palace frame
    trimYellow:   { top: '#e8c964', right: '#b2933f', front: '#cfae51' }, // crystal palace trim
    girderRed:    { top: '#c25548', right: '#8e372d', front: '#aa463a' }, // crystal palace girders
    graniteRose:  { top: '#d9a08e', right: '#a06a5c', front: '#c08575' }, // obelisk (Luxor granite)
    sand:         { top: '#e2d3ab', right: '#ab9c77', front: '#c9ba92' }, // arena floor
    water:        { top: '#8fc6ee', right: '#4f86b8', front: '#68a3d6' }, // gardens pools
    palm:         { top: '#5f9a3c', right: '#39602a', front: '#4c7d33' }, // gardens palm crowns (not 'grass': no flowers)
    pruBlue:      { top: '#79a8e0', right: '#4a6da3', front: '#618cc4' }, // Prudential sign — lit corporate blue
    bnyTeal:      { top: '#45c7b8', right: '#2a8478', front: '#37a596' }, // BNY teal (kept: keys are forever)
    bnyNavy:      { top: '#2b4d78', right: '#17304f', front: '#213e63' }, // BNY sign card — the brand navy ground
    bnyGlass:     { top: '#3a4a56', right: '#232e38', front: '#2f3d48' }, // 240 Greenwich ribbon glazing, dark at night
  };
  W.BLOCK_COLORS = ['red', 'blue', 'green', 'yellow', 'orange', 'purple', 'cyan', 'pink', 'white'];

  // ── Grid ────────────────────────────────────────────────────
  W.GRID_MIN = -5;
  W.GRID_MAX = 5;
  W.MAX_STACK = 10; // one cap for click-place AND drag-stack
  W.isOnPlatform = (gx, gy) =>
    gx >= W.GRID_MIN && gx <= W.GRID_MAX && gy >= W.GRID_MIN && gy <= W.GRID_MAX;

  // ── Block state ─────────────────────────────────────────────
  W.blocks = [];
  W.monuments = []; // completed monuments: { id, cells:[{gx,gy,gz}...], ... }

  // Occupancy lookup — the spatial index the matcher and stacking use.
  // Rebuilt on demand; ~a thousand entries worst case, negligible cost.
  // TWO views of the same world (the heart of the grid physics core):
  //   occupancy — everything, including a falling block's RESERVED landing
  //               cell, so aiming/placement can't target a cell that's
  //               already spoken for;
  //   settled   — only what is solid RIGHT NOW (landed blocks + monument
  //               volume), so gravity and support never rest weight on a
  //               reservation that hasn't landed yet.
  let occupancy = new Map();
  let settled = new Map();
  let occupancyDirty = true;
  W.markDirty = () => { occupancyDirty = true; };

  // A block that's launching (or counting down to launch) is no longer part
  // of the playable world: it doesn't occupy a cell, can't be stacked on,
  // and can't be grabbed. The instant a blast fires, the board reads empty.
  W.isLive = (b) => !b.blasting && b.preBlast === null;

  function rebuildOccupancy() {
    occupancy = new Map();
    settled = new Map();
    W.blocks.forEach(b => {
      if (!W.isLive(b) || b.isDebris) return; // debris is spectacle, not world
      const k = b.gx + ',' + b.gy + ',' + b.gz;
      occupancy.set(k, b);
      if (!b.dropping) settled.set(k, b);
    });
    W.monuments.forEach(m => {
      m.cells.forEach(c => {
        const k = c.gx + ',' + c.gy + ',' + c.gz;
        occupancy.set(k, m); settled.set(k, m);
      });
      // The drawn model bulges beyond the recipe's cells (wide lintels,
      // spire tips) — those cells are solid too, or blocks can be placed
      // inside the monument.
      (m.blocked || []).forEach(c => {
        const k = c.gx + ',' + c.gy + ',' + c.gz;
        occupancy.set(k, m); settled.set(k, m);
      });
    });
    occupancyDirty = false;
  }

  // Returns the block at a cell, the monument occupying it, or undefined
  W.at = (gx, gy, gz) => {
    if (occupancyDirty) rebuildOccupancy();
    return occupancy.get(gx + ',' + gy + ',' + gz);
  };

  // Only what is solid right now (no in-flight reservations)
  W.settledAt = (gx, gy, gz) => {
    if (occupancyDirty) rebuildOccupancy();
    return settled.get(gx + ',' + gy + ',' + gz);
  };

  // The block (not monument) at a cell, or undefined
  W.blockAt = (gx, gy, gz) => {
    const v = W.at(gx, gy, gz);
    return (v && v.color !== undefined) ? v : undefined; // monuments have no .color
  };

  W.getStackHeight = (gx, gy) => {
    // Contiguous-from-zero scan over the occupancy index. A column that's
    // free at ground level but blocked higher up (under a monument's
    // overhang) places at the ground — tucked UNDER the lintel — instead of
    // floating on top of it, which the old max+1 rule would have done.
    let z = 0;
    while (z <= W.MAX_STACK + 1 && W.at(gx, gy, z)) z++;
    return z;
  };

  // Same scan against only-what-is-solid: where a falling block will land.
  function settledLandZ(gx, gy) {
    if (occupancyDirty) rebuildOccupancy();
    let z = 0;
    while (z <= W.MAX_STACK && settled.get(gx + ',' + gy + ',' + z)) z++;
    return z;
  }

  // ── The grid physics core ───────────────────────────────────
  // The old model glided every block to a target chosen at SPAWN time and
  // never looked again. These two entry points make the world the truth:
  //
  // retargetFalling — every in-flight block re-aims at what is actually
  // below it NOW. Falling blocks sharing a column stack their reservations
  // bottom-up so they can't claim one cell — with one known edge: a column
  // already AT MAX_STACK clamps every extra in-flight reservation to the
  // top cell, so two blocks arriving over a full column can double-book it
  // (rare; needs two drops in flight over a column with one slot left).
  // Called whenever the world changes under someone's feet.
  W.retargetFalling = () => {
    const cols = new Map();
    W.blocks.forEach(b => {
      if (!W.isLive(b) || !b.dropping || b.isDebris) return;
      const k = b.gx + ',' + b.gy;
      let list = cols.get(k);
      if (!list) cols.set(k, list = []);
      list.push(b);
    });
    let changed = false;
    cols.forEach(list => {
      list.sort((a, b) => (a.gz + a.dropOffset) - (b.gz + b.dropOffset));
      let z = settledLandZ(list[0].gx, list[0].gy);
      list.forEach(d => {
        const abs = d.gz + d.dropOffset;
        const target = Math.min(z, W.MAX_STACK);
        if (target !== d.gz) {
          d.gz = target;
          d.dropOffset = Math.max(0, abs - target);
          changed = true;
        }
        z = target + 1;
      });
    });
    if (changed) W.markDirty();
  };

  // resettle — WEIGHT. Any settled block whose support vanished starts
  // falling from where it stands (cascading up the stack), then everything
  // in flight re-aims. Squash/dust/thump fire on each real landing via the
  // normal impact path. Called after world mutations (pickup, monument
  // move, ceremony sweep, blast reap, load).
  // notifyLandings: blocks knocked loose will fire the monument matcher
  // when they land (via the existing _playerPlaced → fireSettled plumbing).
  // Passed ONLY by deliberate player actions — pulling a block out of a
  // stack can collapse the tower into a valid recipe, and that should
  // transform. NEVER passed by W.load() (a saved build must not
  // spontaneously transform on page load) or by ceremony/blast sweeps.
  // Returns the number of BLOCKS knocked loose, so a caller can tell a
  // real collapse from a clean removal.
  W.resettle = (notifyLandings) => {
    if (occupancyDirty) rebuildOccupancy();
    const landings = new Map(); // monument → total cells fallen; hook fires ONCE, after
    let knockedBlocks = 0;
    let knocked = true;
    while (knocked) {
      knocked = false;
      W.blocks.forEach(b => {
        if (!W.isLive(b) || b.dropping || b.isDebris || b.gz <= 0) return;
        if (settled.get(b.gx + ',' + b.gy + ',' + (b.gz - 1))) return;
        b.dropping = true;      // falls from exactly where it is
        b.dropVel = 0;
        b.dropOffset = 0;
        if (notifyLandings) b._playerPlaced = true;
        settled.delete(b.gx + ',' + b.gy + ',' + b.gz);
        knocked = true;
        knockedBlocks++;
      });
      // MONUMENTS have weight too — same law, applied to the whole body.
      // (An obelisk built on a block hung in the air when that block was
      // picked up: this loop only ever knocked blocks, and nothing else in
      // the project even LOOKED at monument support — 2026-08-24.)
      W.monuments.forEach(mon => {
        if (mon.pending) return; // mid-ceremony: startCeremony reaps the source
                                 // blocks then calls resettle on the flash beat —
                                 // the rise owns the body until pending clears
        // Lowest cell per footprint column; supported if ANY column rests
        // on the ground or on something solid that isn't this monument.
        // "Any" is deliberate: a monument may perch on a partial ledge.
        const bottoms = new Map();
        mon.cells.forEach(c => {
          const k = c.gx + ',' + c.gy;
          const cur = bottoms.get(k);
          if (cur === undefined || c.gz < cur) bottoms.set(k, c.gz);
        });
        let supported = false;
        bottoms.forEach((gz, k) => {
          if (supported) return;
          if (gz <= 0) { supported = true; return; }
          const v = settled.get(k + ',' + (gz - 1));
          if (v !== undefined && v !== mon) supported = true;
        });
        if (supported) return;
        // Fall by the MINIMUM drop over the footprint, so no column can
        // land inside whatever sits lower in a neighbouring column.
        let drop = Infinity;
        bottoms.forEach((gz, k) => {
          let d = 0;
          for (let z = gz - 1; z >= 0; z--) {
            const v = settled.get(k + ',' + z);
            if (v !== undefined && v !== mon) break;
            d++;
          }
          drop = Math.min(drop, d);
        });
        if (!isFinite(drop) || drop <= 0) return;
        // Land instantly — mirrors the drag-commit geometry (game.js):
        // shift cells + model, re-derive the blocked volume.
        mon.cells.forEach(c => { c.gz -= drop; });
        mon.model.forEach(p => { p.gz -= drop; });
        if (VH.monuments && VH.monuments.blockedCellsFor) {
          mon.blocked = VH.monuments.blockedCellsFor(mon.model, mon.cells);
        } else {
          (mon.blocked || []).forEach(c => { c.gz -= drop; });
          mon.blocked = (mon.blocked || []).filter(c => c.gz >= 0);
        }
        landings.set(mon, (landings.get(mon) || 0) + drop);
        rebuildOccupancy(); // old cells free, new cells solid — recompute truth
        knocked = true;     // its landing may support (or strand) something else
      });
    }
    W.retargetFalling();
    W.markDirty();
    if (W.onMonumentLanded) landings.forEach((drop, mon) => W.onMonumentLanded(mon, drop));
    return knockedBlocks;
  };

  // Optional landing feedback, registered by game.js (dip/dust/tock live
  // there) — same pattern as notifyPlaced → onBlockSettled below. Fired
  // once per monument per resettle with the TOTAL distance fallen.
  W.onMonumentLanded = null;

  // ── Placement event hook (monuments.js subscribes) ──────────
  // Fired ONLY for deliberate player placements — never for the random
  // spawn scatter, save restore, or a drag returning home. The matcher
  // runs when the placed block SETTLES so ceremonies start on landed
  // blocks, not mid-fall.
  W.notifyPlaced = (b) => {
    W.markDirty();
    b._playerPlaced = true;
    b.tumbles = 0; // a fresh placement gets a fresh roll-off budget
    if (!b.dropping) {
      tryTumble(b);  // reduced motion never enters the falling path; the
                     // reduced branch relocates in place and returns false
      fireSettled(b);
    }
  };
  function fireSettled(b) {
    b._playerPlaced = false;
    if (VH.monuments && VH.monuments.onBlockSettled) VH.monuments.onBlockSettled(b);
  }

  // No longer an interaction gate (any visible block is grabbable since
  // 2026-08-25) — now only gates the hover LIFT, which needs headroom.
  W.isTopBlock = (b) =>
    !W.blocks.some(o => o.gx === b.gx && o.gy === b.gy && o.gz > b.gz && W.isLive(o));

  W.randomColor = () => W.BLOCK_COLORS[Math.floor(Math.random() * W.BLOCK_COLORS.length)];

  W.makeBlock = (gx, gy, gz, opts = {}) => ({
    gx, gy, gz,
    color: opts.color || W.randomColor(),
    opacity: 1,
    // Drop physics — spawn ABOVE the resting spot, fall DOWN.
    // dropOffset in grid units; dropVel in grid units / second.
    // Reduced motion: blocks appear in place, no fall.
    dropOffset: E.reducedMotion ? 0 : (opts.dropOffset ?? 5 + Math.random() * 3),
    dropVel: 0,
    dropDelay: E.reducedMotion ? 0 : (opts.dropDelay ?? 0), // seconds
    dropping: !E.reducedMotion,
    blasting: false,
    blastVelX: 0, blastVelY: 0, blastVelZ: 0,
    blastX: 0, blastY: 0, blastZ: 0,
    blastMode: 'fade',                // 'fade' (opacity ramp) | 'burst' (detonate at apex)
    blastGravity: 0,                  // 0 → default BLAST_GRAVITY at update time
    fuse: 0,                          // seconds to keep FALLING past apex before detonating
    // Game feel
    squash: 0, squashVel: 0,          // squash-and-stretch spring
    lift: 0,                          // hover lift (grid units)
    slideX: 0, slideY: 0,             // tumble roll-off: visual pos = logical + slide, eased to 0
    tumbles: 0,                       // roll-off hops this drop (capped — see tryTumble)
    shade: (Math.random() * 2 - 1),   // per-block lightness jitter (±)
    spin: 0, spinVel: 0,              // tumbling while blasted
    preBlast: null,                   // seconds until launch (anticipation + shockwave stagger)
    baseSxy: 1, baseSz: 1,            // static scale (monument debris keeps its shape)
    warmUntil: 0,                     // near-miss shimmer deadline (set by monuments.js)
  });

  // Blast-capable debris made from a monument's model pieces: an ordinary
  // block (inherits physics, draw pass, cull) that keeps the piece's shape.
  // Fractional coordinates are fine — it never enters occupancy (isLive).
  W.makeDebris = (gx, gy, gz, opts) => {
    const b = W.makeBlock(gx, gy, gz, { color: opts.color });
    b.dropping = false;
    b.dropOffset = 0;
    b.dropDelay = 0;
    // Rect pieces tumble as squares (spin makes the difference invisible)
    b.baseSxy = opts.sy != null ? Math.max(opts.sxy, opts.sy) : opts.sxy;
    b.baseSz = opts.sz;
    b.isDebris = true;
    return b;
  };

  // Optional `plan(gx, gy, gz, i)` returns makeBlock opts, so a caller
  // (the entrance) can choreograph heights/delays without a second spawn
  // path. No plan = the original uniform stagger.
  // Optional avoid(gx, gy) predicate: cells it claims are re-rolled (the
  // entrance keeps the scatter off the towers' tidy stacks). Bounded
  // retries so a huge avoid set can't spin forever.
  W.spawnBlocks = (count, plan, avoid) => {
    for (let i = 0; i < count; i++) {
      let gx, gy, tries = 0;
      do {
        gx = W.GRID_MIN + Math.floor(Math.random() * (W.GRID_MAX - W.GRID_MIN + 1));
        gy = W.GRID_MIN + Math.floor(Math.random() * (W.GRID_MAX - W.GRID_MIN + 1));
      } while (avoid && avoid(gx, gy) && ++tries < 40);
      const gz = W.getStackHeight(gx, gy);
      W.blocks.push(W.makeBlock(gx, gy, gz, plan ? plan(gx, gy, gz, i) : {
        dropOffset: 8 + Math.random() * 6 + gz * 1.5,
        dropDelay: i * 0.05 + Math.random() * 0.066, // staggered arrival
      }));
      // Per placement, not once at the end: the next getStackHeight must
      // see this block's reservation, or a burst can aim two blocks at
      // the same cell (the old same-cell landing race).
      W.markDirty();
    }
  };

  W.removeBlock = (b) => {
    const i = W.blocks.indexOf(b);
    if (i !== -1) W.blocks.splice(i, 1);
    W.markDirty();
  };

  // ── Persistence (localStorage autosave) ─────────────────────
  // v2 adds monuments + discoveries. v1 saves (blocks only) migrate:
  // the build is kept, discoveries start empty.
  const SAVE_KEY = 'vh-build-v1'; // key kept stable; version lives in the payload
  let saveTimer = null;

  W.save = () => {
    clearTimeout(saveTimer);
    saveTimer = setTimeout(() => {
      const M = VH.monuments;
      const data = {
        v: 2,
        blocks: W.blocks
          .filter(b => !b.blasting && b.preBlast === null)
          .map(b => [b.gx, b.gy, b.gz, b.color]),
        monuments: W.monuments.map(m => ({
          id: m.id,
          name: m.name,
          cells: m.cells.map(c => [c.gx, c.gy, c.gz]),
          // p[7] = sy (rect pieces); older loads simply ignore the extra slot
          model: m.model.map(p => [p.gx, p.gy, p.gz, p.sxy, p.sz, p.color, p.glow ? 1 : 0, p.sy]),
        })),
        discovered: M ? [...M.discovered] : [],
      };
      try { localStorage.setItem(SAVE_KEY, JSON.stringify(data)); } catch (_) { /* full/blocked */ }
    }, 300);
  };

  // Restore a saved build; returns true if anything was loaded
  W.load = () => {
    let data = null;
    try { data = JSON.parse(localStorage.getItem(SAVE_KEY)); } catch (_) {}
    if (!data || (data.v !== 1 && data.v !== 2) || !Array.isArray(data.blocks)) return false;
    let i = 0;
    // Welcome-back cascade: whole spread capped at 0.35 s regardless of
    // build size. For a returner the message is "your thing is still
    // here" — a long re-choreography of a 60-block build would be a lie.
    const spread = Math.min(0.35, data.blocks.length * 0.02);
    const denom = Math.max(1, data.blocks.length - 1);
    for (const item of data.blocks) {
      const [gx, gy, gz, color] = item;
      if (!W.isOnPlatform(gx, gy) || gz < 0 || gz > W.MAX_STACK || !W.COLORS[color]) continue;
      W.blocks.push(W.makeBlock(gx, gy, gz, {
        color,
        dropOffset: 2 + gz * 0.6,
        dropDelay: (i / denom) * spread,
      }));
      i++;
    }
    if (data.v === 2) {
      (data.monuments || []).forEach(m => {
        if (!Array.isArray(m.cells) || !Array.isArray(m.model)) return;
        // The MODEL is derived from the recipe when possible, not trusted
        // from the save: model art improves between visits, and a save
        // written before a redesign would otherwise pin the old look
        // forever. The stored cells give origin + rotation; the stored
        // pieces remain as the fallback for unknown/changed recipes.
        if (VH.monuments && VH.monuments.reinstantiate &&
            VH.monuments.reinstantiate(m.id, m.cells)) { i++; return; }
        const mon = {
          id: m.id,
          name: m.name,
          cells: m.cells.map(c => ({ gx: c[0], gy: c[1], gz: c[2] })),
          model: m.model.map(p => ({
            gx: p[0], gy: p[1], gz: p[2], sxy: p[3], sz: p[4], color: p[5], glow: !!p[6],
            sy: p[7] != null ? p[7] : p[3], pop: 1,
          })),
        };
        // blocked is DERIVED, never saved (monuments.js loads before us)
        mon.blocked = VH.monuments ? VH.monuments.blockedCellsFor(mon.model, mon.cells) : [];
        W.monuments.push(mon);
        i++;
      });
      if (VH.monuments && Array.isArray(data.discovered)) {
        data.discovered.forEach(id => VH.monuments.discovered.add(id));
      }
    }
    W.markDirty();
    W.resettle(); // normalize: a legacy save with floaters lands them properly
    // A save is debounced 300 ms but the tumble decides at LANDING (~400 ms
    // after placement), so a save written in between can freeze a block on
    // a bad perch. In normal mode the welcome-back cascade re-drops every
    // loaded block, so the landing path re-runs the check itself (verified
    // e2e). REDUCED MOTION loads blocks in place — dropping false — and
    // would keep the frozen perch forever without this sweep: instant
    // relocation, no roll theater (this is a load).
    if (W.TUMBLE) {
      W.blocks.forEach(b => {
        if (!W.isLive(b) || b.isDebris || b.dropping || b.gz <= 0) return;
        if (goodFooting(b.gx, b.gy, b.gz)) return;
        const below = W.settledAt(b.gx, b.gy, b.gz - 1);
        if (below === undefined || below.color !== undefined) return;
        const dest = rollTarget(b);
        if (!dest) return;
        b.gx = dest.gx; b.gy = dest.gy; b.gz = dest.gz;
        W.markDirty(); // per move: the next block's scan must see this one
      });
      W.resettle(); // a relocated block may have carried a stack on its back
    }
    return i > 0;
  };

  // ── Physics (all per-second; dt from the real clock) ────────
  const GRAVITY = 288;        // grid units / s²   (was 0.08 /frame² @60fps)
  const BOUNCE = 0.45;        // restitution (dimensionless)
  const BOUNCE_MIN_VEL = 15;  // u/s below which the block settles (was 0.25 u/f)
  const BLAST_GRAVITY = 648;  // u/s² (was 0.18 /frame²)
  const BLAST_FADE = 0.72;    // opacity / s (was 0.012 /frame)
  // Firework launches use MUCH lighter gravity so the arc peaks in the
  // visible sky band (~6-13 units up) instead of thousands of px off-screen.
  const FIREWORK_GRAVITY = 90; // u/s²
  const FUSE_FLOOR = 1.0;      // grid units above launch height where a fuse is cut short

  W.BLAST = { GRAVITY: BLAST_GRAVITY, FIREWORK_GRAVITY }; // exposed for game.js blast trigger

  // Squash-and-stretch spring (snappy, slight overshoot into a stretch)
  const SQUASH_K = 200;
  const SQUASH_D = 14;

  // Platform dip: the whole stage flinches when the blast fires
  W.dip = 0;
  W.dipVel = 0;
  W.kickDip = (v) => { W.dipVel += v; };

  W.hoveredBlock = null; // set by game.js; blocks ease a lift toward it
  W.hoveredMonument = null; // same idea, whole monument (monuments.js eases it)

  // Shared firework launch: put a group of blocks on the staggered
  // ballistic arc (crouch → shockwave from cx/cy → apex detonation).
  // Defaults are EXACTLY the Clear button's tuned values. Deliberately does
  // NOT touch onBlastCleared / kickShake / kickDip / sfx — those belong to
  // the callers, so a ceremony launch can never steal Clear's final beat.
  W.launchBlocks = (list, opts = {}) => {
    const reduced = E.reducedMotion;
    const cx = opts.cx ?? 0, cy = opts.cy ?? 0;
    const force = opts.force || [2, 5];        // u/s outward fan [min, max]
    const up = opts.up || [34, 50];            // u/s upward [min, max]
    const upFalloff = opts.upFalloff ?? 0.9;   // outer shells peak lower → a dome
    const delayBase = opts.delayBase ?? 0.09;
    const delayPerDist = opts.delayPerDist ?? 0.035;
    // Per-block random FUSE: seconds a shell keeps flying past its apex
    // before it detonates. Zero by default (ceremony sweeps pop at the top,
    // as a tight shockwave should). The Clear passes a fraction of a second
    // so the board rises as one mass and then breaks apart RAGGEDLY — some
    // at the top, some after a visible beat of falling (designer, 2026-08-31:
    // "I prefer the old animation where all of the pieces rise together, but
    // I just want them to explode at different times").
    const fuseJitter = opts.fuseJitter ?? 0;
    list.forEach(b => {
      if (b.blasting || b.preBlast !== null) return;
      const dx = b.gx - cx || (Math.random() - 0.5);
      const dy = b.gy - cy || (Math.random() - 0.5);
      const dist = Math.sqrt(dx * dx + dy * dy) || 1;
      b.dropping = false; // a mid-fall block launches from its target cell
      b.dropDelay = 0;
      b.dropOffset = 0;
      if (reduced) {
        // Reduced motion: fade out in place, no flight
        b.blastVelX = 0; b.blastVelY = 0; b.blastVelZ = 0;
        b.blastMode = 'fade';
      } else {
        const f = force[0] + Math.random() * (force[1] - force[0]);
        b.blastVelX = (dx / dist) * f;
        b.blastVelY = (dy / dist) * f;
        b.blastVelZ = up[0] + Math.random() * (up[1] - up[0]) - dist * upFalloff;
        b.squash = 0.26; // anticipation crouch
        b.blastMode = 'burst';
        b.blastGravity = FIREWORK_GRAVITY;
      }
      b.fuse = reduced ? 0 : Math.random() * fuseJitter;
      b.blastX = 0; b.blastY = 0; b.blastZ = 0;
      b.preBlast = reduced ? 0.01 : delayBase + dist * delayPerDist;
    });
  };

  // Fires once when the LAST launching block is gone (the show is over).
  // One-shot: consumed on fire. Nothing structural depends on it — it only
  // drives a final beat (a low boom + platform settle).
  W.onBlastCleared = null;

  // A 'burst' block detonating at the top of its arc: coloured sparks, a
  // bloom, the sky's stars catching the light, a small camera kick, a boom.
  // kickShake is a max (not a sum), so simultaneous detonations don't stack;
  // kickDip is deliberately NOT used here (it accumulates).
  function detonate(b) {
    const gx = b.gx + b.blastX, gy = b.gy + b.blastY, gz = b.gz + b.blastZ;
    if (VH.fx) {
      // 9/6 (was 12/8): embers now live ~3× longer, so fewer per shell
      // keeps the shared particle budget honest across a full barrage
      VH.fx.spawnBurst(gx, gy, gz, b.color, b.isDebris ? 6 : 9);
      VH.fx.spawnFlash(gx + 0.5, gy + 0.5, gz + 0.5,
        { dur: 0.28, r0: 0.8, r1: 4.5, peak: 0.7, colorKey: b.color });
      const s = E.toScreen(gx + 0.5, gy + 0.5, gz + 0.5);
      VH.fx.igniteStars(s.x / E.W, s.y / E.H, 0.10, 0.55);
    }
    E.kickShake(1.2);
    // Position → stereo pan; boomCls routes leftover-sweep shells to their
    // own (quieter, darker, wetter) budget so they can't trample a ceremony
    if (VH.sfx) VH.sfx.boom(Math.min(1.3, Math.max(0.6, 0.6 + gz * 0.05)),
      { gx, gy, gz }, { cls: b.boomCls });
  }

  // ── The tumble: "no" with personality ───────────────────────
  // A block that settles on a monument where the sculpture doesn't really
  // reach it (thin cover, or an air gap under its feet — the "perch"
  // measurements in HANDOFF.md) doesn't hover: it teeters and ROLLS OFF to
  // the nearest column with honest footing. Nearest, never random — a
  // block that teleports unpredictably is maddening when you're building
  // an exact recipe shape; one that visibly rolls one tile reads as
  // physics. The matcher is NOT fired at the perch: fireSettled runs only
  // at the block's final resting place, which is what the player sees.
  W.TUMBLE = true; // vh-dev-tumble flips this off to prove the harness bites

  function goodFooting(gx, gy, lz) {
    if (lz <= 0) return true;
    const below = W.settledAt(gx, gy, lz - 1);
    if (below === undefined) return false;
    if (below.color !== undefined) return true; // a block: fills its cell
    const M = VH.monuments;
    if (!M || !M.perchUnder) return true;
    const p = M.perchUnder(gx, gy, lz);
    return p.cover >= M.PERCH_MIN_COVER && p.gap <= M.PERCH_MAX_GAP;
  }

  // Nearest column (ring scan, fixed order — deterministic) whose own
  // landing spot has honest footing and room. Same scan shape as
  // game.js restoreDragBlockToOrigin.
  function rollTarget(b) {
    for (let r = 1; r <= 4; r++) {
      for (let dx = -r; dx <= r; dx++) {
        for (let dy = -r; dy <= r; dy++) {
          if (Math.max(Math.abs(dx), Math.abs(dy)) !== r) continue;
          const nx = b.gx + dx, ny = b.gy + dy;
          if (!W.isOnPlatform(nx, ny)) continue;
          const lz = settledLandZ(nx, ny);
          if (lz > W.MAX_STACK) continue;
          if (lz > b.gz) continue; // gravity: roll down or level, never up
          if (!goodFooting(nx, ny, lz)) continue;
          return { gx: nx, gy: ny, gz: lz };
        }
      }
    }
    return null;
  }

  // Called at the FINAL settle (not on a bounce). True → the block is
  // rolling again: caller must keep it dropping and must NOT fire the
  // matcher. False → settle normally (good footing, hop cap reached, or
  // nowhere sensible to go — settling beats vanishing or looping).
  function tryTumble(b, impactVel) {
    if (!W.TUMBLE || b.isDebris || !W.isLive(b) || b.gz <= 0) return false;
    if (goodFooting(b.gx, b.gy, b.gz)) return false;
    const below = W.settledAt(b.gx, b.gy, b.gz - 1);
    if (below === undefined || below.color !== undefined) return false; // only monument perches roll
    b.tumbles = (b.tumbles || 0) + 1;
    if (b.tumbles > 4) return false;
    const dest = rollTarget(b);
    if (!dest) return false;
    if (E.reducedMotion) {
      // No sideways theater: appear at the destination, settle normally.
      // No impact here either — returning false sends the caller down its
      // normal settle path, which fires onImpact at the RELOCATED coords,
      // exactly where the block now visibly is.
      b.gx = dest.gx; b.gy = dest.gy; b.gz = dest.gz;
      b.slideX = 0; b.slideY = 0;
      W.markDirty();
      W.retargetFalling();
      return false;
    }
    // The touch-and-teeter beat fires HERE, while gx/gy still point at the
    // perch — after the relocation below, the dust and thud would appear
    // one tile over at the destination.
    if (impactVel !== undefined) onImpact(b, impactVel);
    // Visual position stays put (slide = old − new) and eases to 0 while
    // the block falls the rest of the way — it arcs sideways and down.
    b.slideX = (b.slideX || 0) + (b.gx - dest.gx);
    b.slideY = (b.slideY || 0) + (b.gy - dest.gy);
    const fromZ = b.gz;
    b.gx = dest.gx; b.gy = dest.gy; b.gz = dest.gz;
    b.dropOffset = Math.max(0.001, fromZ - dest.gz);
    b.dropVel = 0;
    W.markDirty();
    W.retargetFalling();
    return true;
  }

  function onImpact(b, impactVel) {
    // impactVel: u/s downward at the moment of contact
    const strength = Math.min(1, Math.abs(impactVel) / 80);
    if (!E.reducedMotion) {
      b.squash = Math.max(b.squash, strength * 0.32);
      if (strength > 0.25 && VH.fx && VH.fx.spawnDust) {
        VH.fx.spawnDust(b.gx, b.gy, b.gz, Math.round(4 + strength * 6));
      }
    }
    if (strength > 0.2 && VH.sfx) VH.sfx.tock(b.gz, strength, b); // musical stacking, panned
    // Optional one-shot landing hook (the entrance's hero block): fires
    // on the FIRST impact only, before the bounces.
    if (b.onLand) { const fn = b.onLand; b.onLand = null; fn(b, impactVel); }
    // Compression ripple down the stack below
    W.blocks.forEach(o => {
      if (o !== b && o.gx === b.gx && o.gy === b.gy && o.gz < b.gz && !o.blasting) {
        const depth = b.gz - o.gz;
        o.squash = Math.max(o.squash, 0.10 * strength * Math.max(0, 1 - depth * 0.25));
      }
    });
  }

  W.updateBlocks = (dt) => {
    // Platform dip spring — snapped to true zero at rest like squash and
    // slide. A never-quite-zero dip made every render-time gz fractional
    // FOREVER, which silently broke integer-keyed cell lookups downstream
    // (the shimmer rim's neighbour test was the victim).
    W.dipVel += (-120 * W.dip - 10 * W.dipVel) * dt;
    W.dip = Math.min(0.2, W.dip + W.dipVel * dt);
    if (Math.abs(W.dip) < 0.001 && Math.abs(W.dipVel) < 0.01) { W.dip = 0; W.dipVel = 0; }

    W.blocks.forEach(b => {
      // Squash spring (runs for every block)
      if (b.squash !== 0 || b.squashVel !== 0) {
        b.squashVel += (-SQUASH_K * b.squash - SQUASH_D * b.squashVel) * dt;
        b.squash += b.squashVel * dt;
        if (Math.abs(b.squash) < 0.002 && Math.abs(b.squashVel) < 0.02) {
          b.squash = 0; b.squashVel = 0;
        }
      }
      // Hover lift eases toward its target. Buried blocks (something
      // directly above) don't lift — there is no room, and a middle block
      // rising into its neighbour reads as a glitch. They are still
      // grabbable; the cursor carries the feedback. Snapped at rest so
      // lift can't leave gz permanently fractional (see the dip note).
      const liftTarget = (b === W.hoveredBlock && W.isTopBlock(b)) ? 0.12 : 0;
      b.lift += (liftTarget - b.lift) * Math.min(1, 12 * dt);
      if (Math.abs(b.lift - liftTarget) < 0.001) b.lift = liftTarget;

      // Tumble slide eases home — the sideways half of the roll-off arc
      if (b.slideX || b.slideY) {
        const k = Math.min(1, 10 * dt);
        b.slideX += -b.slideX * k;
        b.slideY += -b.slideY * k;
        if (Math.abs(b.slideX) < 0.01) b.slideX = 0;
        if (Math.abs(b.slideY) < 0.01) b.slideY = 0;
      }

      // Anticipation countdown → launch (shockwave stagger)
      if (b.preBlast !== null) {
        b.preBlast -= dt;
        if (b.preBlast <= 0) {
          b.preBlast = null;
          b.blasting = true;
          if (!E.reducedMotion) {
            b.spinVel = (Math.random() - 0.5) * 6;
            b.squash = -0.18; // stretch as it leaves
          }
        }
      }

      if (b.dropping) {
        if (b.dropDelay > 0) { b.dropDelay -= dt; return; }
        b.dropVel -= GRAVITY * dt;
        b.dropOffset += b.dropVel * dt;
        if (b.dropOffset <= 0) {
          const impactVel = b.dropVel;
          b.dropOffset = 0;
          if (Math.abs(b.dropVel) > BOUNCE_MIN_VEL) {
            b.dropVel = Math.abs(b.dropVel) * BOUNCE; // bounce back up
            onImpact(b, impactVel);
          } else if (tryTumble(b, impactVel)) {
            // Bad perch: the teeter beat fired inside tryTumble at the
            // perch coords; the block is falling again — no fireSettled,
            // the matcher waits for the real resting place
          } else {
            b.dropVel = 0;
            b.dropping = false;
            W.markDirty(); // landing changes what is SOLID (settled map)
            onImpact(b, impactVel);
            if (b._playerPlaced) fireSettled(b);
          }
        }
      }
      if (b.blasting) {
        b.blastVelZ -= (b.blastGravity || BLAST_GRAVITY) * dt;
        b.blastX += b.blastVelX * dt;
        b.blastY += b.blastVelY * dt;
        b.blastZ += b.blastVelZ * dt;
        b.spin += b.spinVel * dt;
        if (b.blastMode === 'burst') {
          // Fully opaque through the climb; the payoff is at the APEX —
          // unless the shell drew a fuse, in which case it keeps falling,
          // still solid and visible, for a beat before it breaks.
          if (b.blastVelZ <= 0) {
            // The floor guard: a long fuse must never carry a shell back
            // down into the platform. FUSE_FLOOR is clearance, not zero —
            // a fast-falling shell covers ~half a cell per frame, so
            // cutting the fuse AT launch height still detonates below it.
            if (b.fuse > 0 && b.blastZ > FUSE_FLOOR) b.fuse -= dt;
            else { detonate(b); b.opacity = 0; }
          }
        } else {
          b.opacity = Math.max(0, b.opacity - BLAST_FADE * dt);
        }
      }
    });

    // Falling blocks sharing a column may not pass through each other:
    // clamp each one to ride at least one cell above the one below it, so
    // a column falls AS a column and lands in sequence. (Reservations
    // already guarantee distinct landing cells; this keeps the flight
    // itself interpenetration-free.)
    const fallCols = new Map();
    W.blocks.forEach(b => {
      if (!b.dropping || !W.isLive(b) || b.isDebris || b.dropDelay > 0) return;
      const k = b.gx + ',' + b.gy;
      let list = fallCols.get(k);
      if (!list) fallCols.set(k, list = []);
      list.push(b);
    });
    fallCols.forEach(list => {
      if (list.length < 2) return;
      list.sort((a, b) => (a.gz + a.dropOffset) - (b.gz + b.dropOffset));
      for (let i = 1; i < list.length; i++) {
        const below = list[i - 1], d = list[i];
        const floor = below.gz + below.dropOffset + 1;
        const abs = d.gz + d.dropOffset;
        if (abs < floor) {
          d.dropOffset = floor - d.gz;
          d.dropVel = Math.min(d.dropVel, below.dropVel); // ride, don't tunnel
        }
      }
    });

    const before = W.blocks.length;
    W.blocks = W.blocks.filter(b => !b.blasting || b.opacity > 0);
    if (W.blocks.length !== before) {
      W.markDirty();
      W.resettle(); // launched blocks vanishing can strand what stood on them
      // The show ends when nothing is launching or waiting to launch
      if (W.onBlastCleared && !W.blocks.some(b => b.blasting || b.preBlast !== null)) {
        const done = W.onBlastCleared;
        W.onBlastCleared = null;
        done();
      }
    }
  };

  // ── Block rendering ─────────────────────────────────────────
  // Lighting overlay applied to the current path (call right after fill)
  // Moonlit faces warm toward the moon's colour, faces turned away cool
  // toward the sky's — the two colour terms every outdoor night scene
  // has. Same alphas as the old white/black overlays, so the approved
  // material value structures are unchanged; only the temperature moved.
  const LIGHT_WARM = '#fff1d2';
  const LIGHT_COOL = '#0c1030';
  function applyLight(lightFactor, opacity) {
    const ctx = E.ctx;
    if (lightFactor > 0.05) {
      ctx.globalAlpha = opacity * lightFactor * 0.18;
      ctx.fillStyle = LIGHT_WARM;
      ctx.fill();
    } else if (lightFactor < -0.05) {
      ctx.globalAlpha = opacity * (-lightFactor) * 0.27;
      ctx.fillStyle = LIGHT_COOL;
      ctx.fill();
    }
  }

  // The lighthouse beam on a surface. Sibling of applyLight, same idiom
  // (fills the face path that is already set), and deliberately built from
  // the same two ingredients a game engine's directional light uses:
  //
  //   faceTerm — how squarely this face's ORIENTATION meets the beam.
  //              Identical for every piece of a wall, so a wall lights as
  //              one surface. This is the whole fix: earlier versions
  //              asked each PIECE whether it stood inside the cone, and
  //              that yes/no edge swept across a monument one piece at a
  //              time, which is what read as patchy flashing.
  //   fall     — distance from the LAMP. The lamp never moves, so this
  //              term is constant in time and cannot make anything flash.
  //   lobe     — a broad cosine around the beam's heading (exponent
  //              BEAM.focus). Smooth at every value; no cutoff anywhere.
  //              focus 0 turns it off and leaves a plain directional wash.
  const BEAM_WARM = '#ffe9b8';
  const BEAM_NEAR0 = 1.2, BEAM_NEAR1 = 3.4; // the beam's surface light fades IN over this
  function applyBeam(faceTerm, cx, cy, opacity) {
    const bl = E.beamLit;
    if (!bl || faceTerm <= 0.02) return;
    const vx = cx - bl.gx, vy = cy - bl.gy;
    const d = Math.hypot(vx, vy);
    // Fade IN away from the lamp, as well as out with distance. Two
    // reasons, and the near one is not cosmetic: a piece sitting AT the
    // lamp gives a near-zero direction vector, so the lobe below is
    // numerically unstable there and swung wildly as the beam turned —
    // measured as a 307/765 jump per 3° on the lighthouse's own pieces
    // while the Great Wall moved by 3. It is also just true: a lighthouse
    // does not floodlight its own tower with its beam. The tower is lit by
    // the lamp's steady point light instead.
    const nr = Math.min(1, Math.max(0, (d - BEAM_NEAR0) / (BEAM_NEAR1 - BEAM_NEAR0)));
    if (nr <= 0) return;                      // also guarantees d > BEAM_NEAR0 below
    const near = nr * nr * (3 - 2 * nr);      // smoothstep
    const fade = 1 - Math.min(1, d / bl.far);
    if (fade <= 0) return;
    let lobe = 1;
    if (bl.focus > 0) {
      const c = (vx * bl.dx + vy * bl.dy) / d; // cos of the angle off the beam
      if (c <= 0) return;
      lobe = Math.pow(c, bl.focus);
    }
    const a = opacity * faceTerm * near * fade * fade * lobe * bl.gain;
    if (a < 0.004) return;
    const ctx = E.ctx;
    ctx.globalAlpha = Math.min(0.55, a);
    ctx.fillStyle = BEAM_WARM;
    ctx.fill();
  }

  // Ambient occlusion band along one edge of a parallelogram face.
  // o = face origin (screen), a/b = the face's two full-edge vectors,
  // side: which edge — 'a0' (b=0 line) / 'a1' (b=1 line) run along a,
  // 'b0' / 'b1' run along b. Three nested quads instead of a gradient,
  // for the same reason as the contact bands: no per-frame allocation.
  const AO_STEPS = [0.2, 0.13, 0.065];
  const AO_ALPHA = 0.07;
  function aoBand(ctx, o, a, b, side) {
    const alongA = side[0] === 'a';
    const along = alongA ? a : b, across = alongA ? b : a;
    const far = side[1] === '1';
    for (const w of AO_STEPS) {
      const s0 = far ? 1 - w : 0, s1 = far ? 1 : w;
      ctx.beginPath();
      ctx.moveTo(o.x + across.x * s0, o.y + across.y * s0);
      ctx.lineTo(o.x + across.x * s0 + along.x, o.y + across.y * s0 + along.y);
      ctx.lineTo(o.x + across.x * s1 + along.x, o.y + across.y * s1 + along.y);
      ctx.lineTo(o.x + across.x * s1, o.y + across.y * s1);
      ctx.closePath(); ctx.fill();
    }
  }

  // ── Material texture (2026-08, session 9+) ──────────────────
  // The palette is material-NAMED (sarsenGrey, brickGrey, ironBronze…),
  // so texture needs no new data on any monument: family is looked up
  // from the colour key, the way the colour already is. Only pieces that
  // pass opts.tex (the logical piece object, monuments only) are ever
  // textured — ghosts, floaters and player blocks opt out by omission.
  // glass / gold / lamp stay clean ON PURPOSE: glass reads as glass
  // because everything around it has tooth, and gold belongs to the
  // shimmer rim.
  //
  // Approval state: stone, brick and metal are designer-approved.
  // Marble, wood and sand were never rebuilt on the value rule (see the
  // MATERIAL PRINCIPLE block in HANDOFF.md) — if any of them ever reads
  // cheap, rebuild it on light behaviour, don't nudge its alpha.
  const MATERIALS = {
    sarsenGrey: 'stone', stone: 'stone', stoneDark: 'stone',
    travertine: 'stone', travertineDark: 'stone', graniteRose: 'stone',
    brickGrey: 'brick', brickDark: 'brick',
    // lightWhite is BOTH temple marble and lighthouse whitewash; the
    // marble area gate (veins only on faces ≥0.8 cells²) means the
    // lighthouse's small courses stay clean automatically. Same story
    // for lightRed (doghouse roof timber vs lighthouse masonry bands):
    // the wood long-axis gate (≥1.2 cells) lets the roof through and
    // leaves the bands alone.
    marble: 'marble', marbleShadow: 'marble', lightWhite: 'marble',
    vermilion: 'wood', kasagiBlack: 'wood', orange: 'wood', lightRed: 'wood',
    // Metal = plate seams, and ORDER is the tell (machined, not natural):
    // evenly spaced, never hashed. The seam spacing needs ~1.35 cells of
    // run, which excludes every Eiffel piece automatically — measured:
    // its largest piece is 1.2 cells, so rivet-scale marks would be
    // sub-pixel there (the famously riveted tower is the worst target).
    copper: 'metal', ironBronze: 'metal', paleIronBlue: 'metal',
    trimYellow: 'metal', girderRed: 'metal',
    sand: 'sand',
  };
  // Per-family designer knob (vh-dev-material {family, amount}; 0 = off)
  W.MAT = { stone: 1, brick: 1, marble: 1, wood: 1, metal: 1, sand: 1 };
  // dark/light mark alphas per family (× amount × piece opacity)
  const MAT_STYLE = {
    stone: { dark: 0.085, light: 0.065 },
    brick: { dark: 0.15, light: 0 },
    marble: { dark: 0.13, light: 0.1 }, // light = the echo edge under the vein
    wood: { dark: 0.09, light: 0 },
    // Metal runs HOT on purpose — high contrast between the bright and
    // dark bands is the defining property, not a strength setting
    metal: { dark: 0.20, light: 0.30 },
    // (stone stays deliberately LOW contrast — matte is its tell)
    sand: { dark: 0.07, light: 0.05 },
  };

  // One mark: a parallelogram in face space. o = face origin (screen),
  // A/B = the face's screen basis vectors, u/v/du/dv in face fractions.
  // Quads, not strokes — strokes are the expensive canvas op (see the
  // stroked gate below), and quads batch into one fill per tone.
  function texMark(ctx, o, A, B, u, v, du, dv) {
    const px = o.x + A.x * u + B.x * v, py = o.y + A.y * u + B.y * v;
    ctx.moveTo(px, py);
    ctx.lineTo(px + A.x * du, py + A.y * du);
    ctx.lineTo(px + A.x * du + B.x * dv, py + A.y * du + B.y * dv);
    ctx.lineTo(px + B.x * dv, py + B.y * dv);
    ctx.closePath();
  }

  // ── The sign (2026-08-28) ───────────────────────────────────
  // The Prudential wordmark, authored as pixel art: the Rock of
  // Gibraltar mark plus PRUDENTIAL in a 4×5 pixel alphabet, drawn as
  // BUTTED face-space quads (the texMark idiom) on a flagged piece's
  // broad face. Butted, not gapped: adjacent dots fuse into strokes so
  // letters read solid while the grid step keeps the pixel voice. The
  // whole mark is one batched fill; positions are face FRACTIONS, so
  // the ceremony pop scales the sign with its plate for free, and
  // nothing is seeded — a wordmark is the same every frame by nature.
  // Simplified/authored, NOT a fetched brand asset (see the plan: a
  // real logo file would be the most foreign object on screen).
  const SIGN_FONT = {
    P: ['###.', '#..#', '###.', '#...', '#...'],
    R: ['###.', '#..#', '###.', '#.#.', '#..#'],
    U: ['#..#', '#..#', '#..#', '#..#', '.##.'],
    D: ['###.', '#..#', '#..#', '#..#', '###.'],
    E: ['####', '#...', '###.', '#...', '####'],
    N: ['#..#', '##.#', '#.##', '#..#', '#..#'],
    T: ['####', '.#..', '.#..', '.#..', '.#..'],
    I: ['###', '.#.', '.#.', '.#.', '###'],
    A: ['.##.', '#..#', '####', '#..#', '#..#'],
    L: ['#..', '#..', '#..', '#..', '###'],
    B: ['###.', '#..#', '###.', '#..#', '###.'],
    Y: ['#.#', '#.#', '.#.', '.#.', '.#.'],
  };
  // The Rock of Gibraltar: a craggy little mountain, asymmetric on purpose.
  const SIGN_ROCK = ['...#..', '..##..', '..###.', '.####.', '######'];
  // BNY's arrow (the 2024 rebrand): a right-pointing arrowhead with a
  // notched tail — drawn from the designer's own logo reference
  // (assets/reference/bny/BNY Logo.png), not from press descriptions,
  // which read "refined arrow" and led a first draft to point it ↗.
  const SIGN_ARROW = ['##...', '.###.', '..###', '.###.', '##...'];
  // Built once per mark: [col, row] dot lists. A recipe's sign plate
  // names its mark by key (the piece's `sign` field), so a second tower
  // is one glyph row and one entry here — no new draw code. A part
  // wrapped { acc: rows } lands in the ACCENT list and takes the accent
  // ink — BNY's teal arrow against white letters, per the real logo.
  const SIGN_MARKS = (() => {
    const build = (parts) => {
      const dots = [], accent = [];
      let col = 0;
      for (const part of parts) {
        if (typeof part === 'number') { col += part; continue; } // a gap
        const rows = part.acc || part;
        const out = part.acc ? accent : dots;
        const w = rows[0].length;
        for (let r = 0; r < 5; r++) {
          for (let c = 0; c < w; c++) {
            if (rows[r][c] === '#') out.push([col + c, r]);
          }
        }
        col += w;
      }
      return { dots, accent, cols: col };
    };
    const word = (s) => s.split('').flatMap((ch, i) => i ? [1, SIGN_FONT[ch]] : [SIGN_FONT[ch]]);
    return {
      prudential: build([SIGN_ROCK, 2, ...word('PRUDENTIAL')]),
      bny: build([{ acc: SIGN_ARROW }, 2, ...word('BNY')]),
    };
  })();
  // Inks per plate colour — the lit-sign night read the designer picked.
  // An unknown plate colour falls back to Prudential blue ink (the
  // blue-on-pale daytime colorway, kept for future use).
  const SIGN_INK = { pruBlue: '#eaf2ff', bnyTeal: '#eafcf9', bnyNavy: '#f2f6fa' };
  const SIGN_ACCENT_INK = { bnyNavy: '#45c7b8' }; // the teal arrow

  // A diagonal segment: thin sheared quad from (u0,v0) to (u1,v1) with
  // thickness tv along B — the primitive behind marble veins and wavy
  // wood grain, which axis-aligned marks can't draw.
  function texSeg(ctx, o, A, B, u0, v0, u1, v1, tv) {
    const ax = o.x + A.x * u0 + B.x * v0, ay = o.y + A.y * u0 + B.y * v0;
    const bx = o.x + A.x * u1 + B.x * v1, by = o.y + A.y * u1 + B.y * v1;
    ctx.moveTo(ax, ay);
    ctx.lineTo(bx, by);
    ctx.lineTo(bx + B.x * tv, by + B.y * tv);
    ctx.lineTo(ax + B.x * tv, ay + B.y * tv);
    ctx.closePath();
  }

  // Emit one face's marks into the CURRENT path, keeping only the tone
  // matching `pass` (0 = dark, 1 = light) — the two passes re-run the
  // same deterministic sequence, same idiom as the platform grain.
  // la/lb are the face's LOGICAL extents in cells (never the pop-scaled
  // drawn size — counts derived from drawn size re-tile every frame of
  // a discovery ceremony). id 2 = the top face.
  // Quarried stone (rough) vs cut stone (ashlar courses). The model
  // comments already draw this line — sarsen is "quarried, not
  // machined", the pyramid is "stepped limestone courses" — so the
  // texture follows the research rather than inventing a rule.
  const ROUGH_STONE = { sarsenGrey: 1 };

  function texFace(ctx, fam, rnd, o, A, B, la, lb, id, pass, lit, rough) {
    if (fam === 'stone') {
      // STONE IS CLUSTERED VALUE, NOT SCATTERED DOTS.
      //
      // The first version used the grass speckle with different numbers
      // and — inevitably — looked like grass. Scattered isolated marks
      // are a correct model of grass (many small separate things) and a
      // wrong model of stone. Do not reintroduce per-mark scatter here.
      //
      // What reads as stone: irregular BLOTCHES of slightly different
      // value (a few overlapping lobes each, so the clump has a ragged
      // outline rather than being a dot), weathered course lines on cut
      // stone, and chipped corners on quarried stone. Matte and low
      // contrast throughout — the opposite of metal's hard specular
      // step. Blotches run FIRST so both tone passes consume the same
      // rnd sequence; the pass-0-only work below may safely diverge.
      const nB = Math.max(2, Math.min(7, Math.round(la * lb * 2.4)));
      for (let i = 0; i < nB; i++) {
        const cu = 0.08 + rnd() * 0.8;
        const cv = 0.08 + rnd() * 0.8;
        const base = 0.10 + rnd() * 0.11; // blotch width in CELLS
        const want = i % 3 === 0 ? 1 : 0;  // ~1/3 catch the light
        // Lobes must OVERLAP. Spread them wider and the clump reads as
        // three separate rectangles — stickers, not stone. Tight
        // offsets fuse them into one patch with a ragged outline.
        for (let l = 0; l < 4; l++) {
          const ou = (rnd() - 0.5) * base * 0.55;
          const ov = (rnd() - 0.5) * base * 0.55;
          const s = base * (0.5 + rnd() * 0.5);
          if (want !== pass) continue;
          // Clamp the EXTENT too, not just the origin: on a thin plate
          // (the pyramid's 0.06-wide entrance notch) s can exceed the
          // face width, and an unclamped du/dv smears the blotch off
          // the piece — marks are never clipped to the face.
          const du = Math.min(s / la, 0.98), dv2 = Math.min(s / lb, 0.98);
          texMark(ctx, o, A, B,
            Math.max(0.01, Math.min(0.99 - du, cu + ou / la)),
            Math.max(0.01, Math.min(0.99 - dv2, cv + ov / lb)),
            du, dv2);
        }
      }
      if (pass !== 0) return;
      if (rough) {
        // Quarried, not machined (the Stonehenge sarsen note): no
        // courses — instead the corners get bitten out, which is the
        // silhouette tell that separates a weathered block from a box
        for (let c = 0; c < 4; c++) {
          const s = 0.07 + rnd() * 0.08;
          const skip = rnd() > 0.6;
          if (skip) continue;
          texMark(ctx, o, A, B,
            (c & 1) ? 1 - s / la : 0, (c & 2) ? 1 - s / lb : 0,
            s / la, s / lb);
        }
      } else if (id !== 2 && lb >= 0.5) {
        // Cut stone: cleavage courses. Unlike brick these carry NO
        // vertical joints and the spacing wanders — that irregularity
        // is the whole difference between ashlar and brickwork.
        const courses = Math.max(1, Math.round(lb / 0.45));
        for (let i = 1; i < courses; i++) {
          const v = i / courses + (rnd() - 0.5) * 0.05;
          texMark(ctx, o, A, B, 0, v, 1, 0.016 / lb);
        }
      }
    } else if (fam === 'brick') {
      if (pass !== 0) return; // mortar is dark only
      // Running bond on side faces, paver grid on tops. Counts derive
      // per-axis, so a thin band yields zero rows and stays clean —
      // the shape-aware gate the copper-band case needs.
      const rowStep = id === 2 ? 0.5 : 0.32;
      const rows = Math.round(lb / rowStep);
      const cols = Math.round(la / 0.55);
      const th = 0.03; // joint thickness in cells
      if (rows >= 2) {
        for (let i = 1; i < rows; i++) {
          texMark(ctx, o, A, B, 0, i / rows - th / lb / 2, 1, th / lb);
        }
      }
      if (cols >= 2 && rows >= 1) {
        for (let i = 0; i < rows; i++) {
          const off = id === 2 ? 0 : (i % 2) * 0.5; // bond offset
          for (let j = 1; j <= cols; j++) {
            const u = (j - off) / cols;
            if (u <= 0.02 || u >= 0.98) continue;
            texMark(ctx, o, A, B, u - th / la / 2, i / rows, th / la, 1 / rows);
          }
        }
      }
    } else if (fam === 'marble') {
      const area = la * lb;
      if (area < 0.8) return; // trim and small courses stay clean
      // A smooth diagonal MEANDER (per-step curvature, not zigzag — the
      // zigzag read as scratches, designer 2026-08-26), with a light
      // echo edge under the dark vein: the two-tone pair is what makes
      // it read as depth in the stone rather than dirt on it. Both
      // passes consume the identical rnd sequence, so the echo hugs
      // the vein exactly.
      const nVeins = area >= 2.5 ? 2 : 1;
      const tv = 0.02 / lb; // vein thickness in cells → face fraction
      for (let n = 0; n < nVeins; n++) {
        let u = 0.04 + rnd() * 0.2;
        let v = 0.1 + rnd() * 0.7;
        let dv = (rnd() < 0.5 ? -1 : 1) * (0.05 + rnd() * 0.1);
        for (let sIdx = 0; sIdx < 6; sIdx++) {
          // CLAMP, and clamp before drawing: nothing clips these marks
          // to the face, so an unbounded step paints the vein (and its
          // echo) off the piece and onto whatever is behind it. The
          // meander rework dropped this and it shipped as a dark stub
          // hanging off the Arc's top face. Both passes must clamp
          // identically or the echo desyncs from the vein.
          const u2 = Math.min(0.96, u + 0.13 + rnd() * 0.06);
          dv += (rnd() - 0.5) * 0.1; // curvature, not a new direction
          const v2 = Math.max(0.04, Math.min(0.92, v + dv));
          if (pass === 0) texSeg(ctx, o, A, B, u, v, u2, v2, tv);
          else texSeg(ctx, o, A, B, u, v + tv * 1.6, u2, v2 + tv * 1.6, tv);
          u = u2; v = v2;
          if (u >= 0.94) break;
        }
      }
    } else if (fam === 'wood') {
      if (pass !== 0) return; // grain is dark only
      // Grain runs along the LONG axis; short pieces stay clean (the
      // gate that keeps lighthouse masonry bands out of the family)
      const along = la >= lb;
      const ll = along ? la : lb, ls = along ? lb : la; // long/short extents
      if (ll < 1.2) return;
      const n = Math.max(1, Math.min(4, Math.round(ls / 0.3)));
      const tj = 0.02 / ls; // line thickness (across the short axis)
      for (let i = 0; i < n; i++) {
        const v = (i + 0.5) / n + (rnd() - 0.5) * 0.5 / n;
        const jog = (rnd() - 0.5) * 0.12; // mid-line waver
        if (along) {
          texSeg(ctx, o, A, B, 0.03, v, 0.5, v + jog, tj);
          texSeg(ctx, o, A, B, 0.5, v + jog, 0.97, v, tj);
        } else {
          // long axis is B: swap the roles so the line runs along B
          texSeg(ctx, o, B, A, 0.03, v, 0.5, v + jog, tj);
          texSeg(ctx, o, B, A, 0.5, v + jog, 0.97, v, tj);
        }
      }
    } else if (fam === 'metal') {
      // METAL IS A VALUE STRUCTURE, NOT A MARK. What separates metal
      // from stone is how it handles light: a narrow HIGH-CONTRAST
      // specular band, a dark core immediately under it, and a bright
      // bounce along the foot — hard steps, never a fade. The step
      // between bright and dark is the whole tell; you can render
      // convincing steel with no surface texture at all.
      //
      // The first version drew one evenly-spaced seam line per plate.
      // A seam is JOINERY, not material — it says "this was assembled",
      // not "this is metal". Designer rejected it on sight, correctly.
      // Do not reintroduce seams as the primary metal treatment.
      //
      // Consequence of the rework: banding is proportional, so it needs
      // no run-length — the Eiffel (largest piece 1.2 cells), excluded
      // from seams by measurement, is back IN for banding.
      if (id === 2) {
        // Top face: broad sweep toward the light, dark far half. `lit`
        // is the raw signed y-axis light (li.pyLight — continuous in
        // camera angle, like the uy basis this face is drawn on).
        // farness lerps the band ends instead of hard-switching them:
        // the old `lit < 0` boolean teleported a 30%-of-face band from
        // white to black in one frame at 45°/73°/225°/253° — the
        // "panel just goes from light to dark" pop. Endpoints are the
        // designed look and are exactly preserved at lit = ±1; the
        // sweep now SLIDES between them mid-rotation.
        //
        // SOFT EDGES (designer, 2026-08-31: the torii's copper roof
        // "reacting very strangely"). A hard-edged band whose position
        // follows the light doesn't read as a highlight — it reads as a
        // painted stripe CRAWLING across the surface as you rotate.
        // Measured: averaged over the roof the brightness is smooth
        // (max 12/255 per 3°), so this was never a lighting pop; it was
        // the shape of the mark. Worst on big thin plates, where the
        // band is long and the crawl is obvious — the torii roof
        // (3.54×0.68) and the Crystal Palace's panels (up to 3.1×2.1).
        // Fixed with the stacked-band fade already used for contact
        // shading below (world.js ~1331): concentric slices of
        // decreasing coverage sum to a soft-shouldered band, with no
        // per-frame gradient allocation (the thing the light pass was
        // built to eliminate). Total weight matches the old single
        // band, so the material's strength is unchanged.
        // The sweep is drawn by metalTopSweep() AFTER the batched pass —
        // a soft shoulder needs nested fills that ACCUMULATE, and every
        // mark inside one batched path shares a single alpha.
        return;
      }
      // Side faces (B is the vertical axis here): the specular sits
      // high on a moonlit face and collapses toward a rim on a face
      // turned away, which is what keeps a box reading as one object.
      const litF = Math.max(0, Math.min(1, lit));
      const spec = 0.60 + litF * 0.08;
      // A band needs vertical RUN. On a shallow face (girders, trim
      // bands) the full stack collapses into 1px stripes and reads as
      // corduroy — the same cheap-lines failure the seams had. Below
      // half a cell, emit the highlight alone: one bright band on a
      // thin edge is a lit edge, which is honest.
      if (lb < 0.5) {
        // Highlight over one dark band — two values, not the four-band
        // stack, which collapses into 1px corduroy at this height
        if (pass === 1) texMark(ctx, o, A, B, 0, 0.46, 1, 0.34);
        else texMark(ctx, o, A, B, 0, 0, 1, 0.30);
        return;
      }
      if (pass === 1) {
        texMark(ctx, o, A, B, 0, spec, 1, 0.10 + litF * 0.07); // specular
        texMark(ctx, o, A, B, 0, 0, 1, 0.06); // ground bounce at the foot
      } else {
        texMark(ctx, o, A, B, 0, spec - 0.24, 1, 0.24); // core, under the highlight
        texMark(ctx, o, A, B, 0, 0.88, 1, 0.12); // shaded top lip
      }
    } else if (fam === 'sand') {
      // Fine even tooth: denser, smaller, fainter than stone
      const n = Math.max(3, Math.min(20, Math.round(la * lb * 14)));
      for (let i = 0; i < n; i++) {
        const kc = 0.03 + rnd() * 0.035;
        const du = Math.min(kc / la, 0.98), dv = Math.min(kc / lb, 0.98);
        const u = rnd() * Math.max(0.001, 1 - du);
        const v = rnd() * Math.max(0.001, 1 - dv);
        if (i % 2 !== pass) continue;
        texMark(ctx, o, A, B, u, v, du, dv);
      }
    }
  }

  // Metal's top-face sweep, with a SOFT shoulder.
  // Nested bands sharing one centre, each its own fill at a low alpha:
  // the core is covered by all of them and lands at full strength, the
  // outermost slice alone at the edges — a stepped falloff. Exactly the
  // idiom the contact shading uses below (four stacked bands), and for
  // the same reason: marks batched into ONE path share one alpha, so a
  // gradient there is impossible, and per-frame canvas gradients are
  // the allocation the light pass exists to avoid.
  // SOFT widths are fractions of the band; STEPS is chosen so the summed
  // alpha at the core matches the old single band's weight.
  const SOFT_STEPS = [1.0, 0.66, 0.34];
  function metalTopSweep(ctx, st, amt, opacity, o, A, B, lit) {
    const farness = Math.max(0, Math.min(1, 0.5 - lit * 0.5));
    const mlerp = (a, b) => a + (b - a) * farness;
    // Centres travel between the same two ends the hard band used, now
    // expressed as the band's MIDPOINT (old: its leading edge).
    const runs = [
      { a: st.light, tone: '#ffffff', centre: mlerp(0.15, 0.85), thick: 0.30 },
      { a: st.dark, tone: '#000000', centre: mlerp(0.83, 0.17), thick: 0.34 },
    ];
    for (const r of runs) {
      if (r.a <= 0) continue;
      ctx.fillStyle = r.tone;
      ctx.globalAlpha = opacity * amt * r.a / SOFT_STEPS.length;
      for (const w of SOFT_STEPS) {
        const t = r.thick * w;
        const v = Math.max(0, Math.min(1 - t, r.centre - t / 2));
        ctx.beginPath();
        texMark(ctx, o, A, B, 0, v, 1, t);
        ctx.fill();
      }
    }
  }

  // The whole pass for one piece: three visible faces, two tone fills.
  // Seeds hash the piece's logical HOME cell (tp.gx/gy/gz — fractional
  // but stable) plus a per-face term, so opposite-axis faces of one
  // pier never share a pattern. Never seeded on dip, shake, pop or
  // screen position — the fractional-render-coordinate class of bug.
  function drawMaterialTexture(ctx, fam, amt, opacity, tp, ref, ux, uy, uz, xVisible, yVisible, lsx, lsy, lsz, li, rough) {
    const st = MAT_STYLE[fam];
    const hx = Math.round(tp.gx * 16), hy = Math.round(tp.gy * 16), hz = Math.round(tp.gz * 16);
    // Per-face light factors — metal needs them to place its specular;
    // the other families ignore the argument.
    const xLit = xVisible ? li.pxLight : li.nxLight;
    const yLit = yVisible ? li.pyLight : li.nyLight;
    for (let pass = 0; pass < 2; pass++) {
      const a = pass === 0 ? st.dark : st.light;
      if (a <= 0) continue;
      ctx.beginPath();
      const xo = xVisible ? { x: ref.x + ux.x, y: ref.y + ux.y } : ref;
      texFace(ctx, fam, E.hashRand(hx + 1, hy, hz), xo, uy, uz, lsy, lsz, 0, pass, xLit, rough);
      const yo = yVisible ? { x: ref.x + uy.x, y: ref.y + uy.y } : ref;
      texFace(ctx, fam, E.hashRand(hx, hy + 3, hz), yo, ux, uz, lsx, lsz, 1, pass, yLit, rough);
      const to = { x: ref.x + uz.x, y: ref.y + uz.y };
      // Top face gets the RAW signed y-axis light (li.pyLight), never
      // the visibility-signed yLit: this face's B axis is uy, which
      // rotates continuously and never flips, so a light term that
      // inverts at the yVisible boundary (45°) would — and did — pop
      // the metal sweep mid-rotation while the face is at full area.
      // (topLight is wrong for a different reason: a scalar "how lit
      // is up" can't say which EDGE the moon is on.)
      // Metal's top face opts OUT of the batch — its soft sweep needs
      // accumulating fills; see metalTopSweep below.
      texFace(ctx, fam, E.hashRand(hx, hy, hz + 5), to, ux, uy, lsx, lsy, 2, pass, li.pyLight, rough);
      ctx.globalAlpha = opacity * amt * a;
      ctx.fillStyle = pass === 0 ? '#000000' : '#ffffff';
      ctx.fill();
    }
    if (fam === 'metal') {
      const to = { x: ref.x + uz.x, y: ref.y + uz.y };
      metalTopSweep(ctx, st, amt, opacity, to, ux, uy, li.pyLight);
    }
  }

  // Smallest largest-dimension that still earns outlines + moonlit rim
  const STROKE_MIN = 0.35;

  // ── The hologram block ──────────────────────────────────────
  // A block held in LIGHT — the ceremony's silhouette reveal. Same
  // three-face geometry as drawBlock (verbatim vertex math), drawn into
  // a caller-supplied OFFSCREEN context (the engine's hologram buffer),
  // never E.ctx directly. Fills are OPAQUE — the union trick: inside a
  // source-over buffer, overlapping pieces overwrite instead of piling
  // up, so internal seams vanish and N boxes read as ONE shape of
  // light. Depth comes from LUMINANCE, not alpha (top face brightest,
  // like the moonlight); opts.lum scales all three faces for the
  // per-layer crescendo. Named drawHoloBlock: W.drawGhostBlock already
  // exists (the drag-placement preview) — a second definition with
  // that name silently shadowed this one and the ceremony drew the
  // preview cube instead. Grep-guard: exactly one definition of each.
  const HOLO_R = 255, HOLO_G = 233, HOLO_B = 184; // warm gold (#ffe9b8)
  W.drawHoloBlock = (ctx, gx, gy, gz, opts = {}) => {
    const sxy = opts.sxy || 1;
    const sy = opts.sy != null ? opts.sy : sxy;
    const sz = opts.sz || 1;
    const lum = opts.lum != null ? opts.lum : 1;
    if (lum <= 0) return;
    const ref = E.toScreen(gx + (1 - sxy) / 2, gy + (1 - sy) / 2, gz);
    const fv = E.fv;
    const ux = { x: fv.ux.x * sxy, y: fv.ux.y * sxy };
    const uy = { x: fv.uy.x * sy, y: fv.uy.y * sy };
    const uz = { x: fv.uz.x * sz, y: fv.uz.y * sz };
    const { xVisible, yVisible } = fv;
    const opp = { x: ref.x + ux.x + uy.x + uz.x, y: ref.y + ux.y + uy.y + uz.y };
    const P = (dx, dy) => ({ x: ref.x + dx, y: ref.y + dy });
    const tone = (k) => {
      const m = k * lum;
      return 'rgb(' + Math.round(HOLO_R * m) + ',' + Math.round(HOLO_G * m) +
        ',' + Math.round(HOLO_B * m) + ')';
    };
    const face = (a, b, c, d, shade) => {
      ctx.fillStyle = tone(shade);
      ctx.beginPath();
      ctx.moveTo(a.x, a.y); ctx.lineTo(b.x, b.y);
      ctx.lineTo(c.x, c.y); ctx.lineTo(d.x, d.y);
      ctx.closePath(); ctx.fill();
    };
    if (xVisible) face(P(ux.x, ux.y), P(ux.x + uz.x, ux.y + uz.y), opp, P(ux.x + uy.x, ux.y + uy.y), 0.72);
    else face(P(0, 0), P(uz.x, uz.y), P(uy.x + uz.x, uy.y + uz.y), P(uy.x, uy.y), 0.72);
    if (yVisible) face(P(uy.x, uy.y), P(uy.x + uz.x, uy.y + uz.y), opp, P(ux.x + uy.x, ux.y + uy.y), 0.55);
    else face(P(0, 0), P(uz.x, uz.y), P(ux.x + uz.x, ux.y + uz.y), P(ux.x, ux.y), 0.55);
    face(P(uz.x, uz.y), P(ux.x + uz.x, ux.y + uz.y), opp, P(uy.x + uz.x, uy.y + uz.y), 1.0);
  };

  // opts: sxy/sz   squash scale (width / height)
  //       sy       y-axis footprint (defaults to sxy) — RECTANGULAR pieces.
  //                Before this, every beam/lintel was secretly a square
  //                slab (the torii lintel rendered as a table top).
  //       styled   full treatment: outlines, moonlit rim, shade jitter
  //       shade    per-block lightness jitter (−1..1)
  //       contact  darken the base of side faces (resting on something)
  //       gridTop  subtle tile-grid stroke on the top face (platform)
  //       warmT    seconds of near-miss shimmer remaining (0/undefined = off)
  //       tex      the LOGICAL monument piece (material texture; monuments
  //                only — its gx/gy/gz seed the marks, its sxy/sy/sz set
  //                the counts, so the ceremony pop can't re-tile them)
  W.drawBlock = (gx, gy, gz, colorKey, opacity, opts = {}) => {
    if (opacity <= 0) return;
    const col = W.COLORS[colorKey];
    if (!col) return;
    const ctx = E.ctx;
    const sxy = opts.sxy || 1;
    const sy = opts.sy != null ? opts.sy : sxy;
    const sz = opts.sz || 1;
    // Squash widens the footprint; keep the block centered on its cell
    const ref = E.toScreen(gx + (1 - sxy) / 2, gy + (1 - sy) / 2, gz);
    const fv = E.fv;
    const ux = { x: fv.ux.x * sxy, y: fv.ux.y * sxy };
    const uy = { x: fv.uy.x * sy, y: fv.uy.y * sy };
    const uz = { x: fv.uz.x * sz, y: fv.uz.y * sz };
    const { xVisible, yVisible } = fv;
    const li = E.li;
    const bl = E.beamLit;
    const opp = { x: ref.x + ux.x + uy.x + uz.x, y: ref.y + ux.y + uy.y + uz.y };
    const styled = opts.styled;
    // Small-detail pieces skip outlines + rim: 1px strokes on a 0.2-wide
    // finial read as noise, and strokes are the expensive canvas op —
    // dense monument models pay for this twice over. (Sibling threshold:
    // monuments.js castsShadow uses the same largest-dimension test.)
    const stroked = styled && Math.max(sxy, sy, sz) >= STROKE_MIN;

    const facePath = (a, b, c, d) => {
      ctx.beginPath();
      ctx.moveTo(a.x, a.y); ctx.lineTo(b.x, b.y);
      ctx.lineTo(c.x, c.y); ctx.lineTo(d.x, d.y);
      ctx.closePath();
    };
    const P = (dx, dy) => ({ x: ref.x + dx, y: ref.y + dy });
    const outline = () => {
      if (!stroked) return;
      ctx.globalAlpha = opacity * 0.28;
      ctx.strokeStyle = '#14100c';
      ctx.lineWidth = 1;
      ctx.stroke();
    };

    // ── Lights on the faces ──────────────────────────────────────
    // Every POINT light in range is painted onto each visible face as a
    // SOFT SPOT centred where that light's ray meets the face's plane,
    // clipped to the face and mapped with the face's own basis — so light
    // drifts across a surface and wraps around a corner instead of
    // switching a whole panel on. The spot is the cached per-colour light
    // sprite; no gradients, no per-face allocation.
    //
    // The lighthouse BEAM is deliberately not here (Viet, session 20).
    // A monument is many small pieces, and every way of asking "is this
    // lit by the sweeping cone?" — per piece, or per face plane — put
    // moving edges across a built mass and read as patchy flashing. The
    // beam is now a shaft in the sky that touches nothing; the lamp room's
    // own point light (IDLE.lighthouse) still lights its neighbours, and
    // it never moves, so it cannot flash.
    //   lit[] = { gx,gy,gz, R (reach), peak (0..1), sprite }
    const lit = [];
    if (E.lights.length) {
      const bx = gx + 0.5, by = gy + 0.5;
      for (const l of E.lights) {
        if (!l.faces) continue;
        const d = Math.hypot(l.gx - bx, l.gy - by, l.gz - gz - sz * 0.5);
        if (d > l.r + 0.7) continue;
        lit.push({ gx: l.gx, gy: l.gy, gz: l.gz, R: l.r, peak: l.intensity, sprite: E.lightSprite(l.rgb) });
      }
    }
    // Paint the lights on one face. O = the face's world origin (the
    // corner that is the path's first point), a/b = the face's world axes
    // as unit vectors (ax..bz) with their screen images A/B (E.fv per
    // world unit), n = outward normal, fw/fh = extent in world units.
    const faceLights = (pathFn, o, O, ax, ay, az, bxx, byy, bz, nx, ny, nz, A, B) => {
      if (!lit.length) return;
      let began = false;
      for (const L of lit) {
        const dx = L.gx - O[0], dy = L.gy - O[1], dz = L.gz - O[2];
        const t = dx * nx + dy * ny + dz * nz;        // height of the light above the plane
        if (t <= 0.03 || t >= L.R) continue;          // behind the face, or out of reach
        const fx = dx - t * nx, fy = dy - t * ny, fz = dz - t * nz; // foot, relative to O
        const u = fx * ax + fy * ay + fz * az, v = fx * bxx + fy * byy + fz * bz;
        const Rp = Math.sqrt(L.R * L.R - t * t);      // reach on the plane
        const fall = 1 - t / L.R;
        const alpha = Math.min(0.62, L.peak * fall * fall * 0.85) * opacity;
        if (alpha < 0.01) continue;
        if (!began) { ctx.save(); pathFn(); ctx.clip(); ctx.imageSmoothingEnabled = true; began = true; }
        ctx.save();
        ctx.transform(A.x, A.y, B.x, B.y, o.x, o.y);
        ctx.globalAlpha = alpha;
        ctx.drawImage(L.sprite, u - Rp, v - Rp, Rp * 2, Rp * 2);
        ctx.restore();
      }
      if (began) ctx.restore();
    };

    // ±x side face
    let xFace;
    ctx.globalAlpha = opacity;
    ctx.fillStyle = col.right;
    if (xVisible) {
      xFace = [P(ux.x, ux.y), P(ux.x + uz.x, ux.y + uz.y), opp, P(ux.x + uy.x, ux.y + uy.y)];
      facePath(...xFace); ctx.fill();
      applyLight(li.pxLight, opacity);
      applyBeam(bl && bl.px, gx + 0.5, gy + 0.5, opacity);
    } else {
      xFace = [P(0, 0), P(uz.x, uz.y), P(uy.x + uz.x, uy.y + uz.y), P(uy.x, uy.y)];
      facePath(...xFace); ctx.fill();
      applyLight(li.nxLight, opacity);
      applyBeam(bl && bl.nx, gx + 0.5, gy + 0.5, opacity);
    }
    {
      const xp = xVisible ? gx + (1 + sxy) / 2 : gx + (1 - sxy) / 2;
      const y0 = gy + (1 - sy) / 2;
      faceLights(() => facePath(...xFace), xFace[0], [xp, y0, gz], 0, 1, 0, 0, 0, 1, xVisible ? 1 : -1, 0, 0,
        { x: fv.uy.x, y: fv.uy.y }, { x: fv.uz.x, y: fv.uz.y });
    }
    facePath(...xFace); outline();

    // ±y side face
    let yFace;
    ctx.globalAlpha = opacity;
    ctx.fillStyle = col.front;
    if (yVisible) {
      yFace = [P(uy.x, uy.y), P(uy.x + uz.x, uy.y + uz.y), opp, P(ux.x + uy.x, ux.y + uy.y)];
      facePath(...yFace); ctx.fill();
      applyLight(li.pyLight, opacity);
      applyBeam(bl && bl.py, gx + 0.5, gy + 0.5, opacity);
    } else {
      yFace = [P(0, 0), P(uz.x, uz.y), P(ux.x + uz.x, ux.y + uz.y), P(ux.x, ux.y)];
      facePath(...yFace); ctx.fill();
      applyLight(li.nyLight, opacity);
      applyBeam(bl && bl.ny, gx + 0.5, gy + 0.5, opacity);
    }
    {
      const yp = yVisible ? gy + (1 + sy) / 2 : gy + (1 - sy) / 2;
      const x0 = gx + (1 - sxy) / 2;
      faceLights(() => facePath(...yFace), yFace[0], [x0, yp, gz], 1, 0, 0, 0, 0, 1, 0, yVisible ? 1 : -1, 0,
        { x: fv.ux.x, y: fv.ux.y }, { x: fv.uz.x, y: fv.uz.y });
    }
    facePath(...yFace); outline();

    // Contact shading: the block reads as SEATED, not stickered on. Four
    // stacked translucent bands, tallest to shortest, so the strip FADES
    // toward its top — the old single flat band had a visible hard edge
    // (designer, 2026-08-24). Bands rather than a canvas gradient on
    // purpose: per-frame gradient allocations are the exact thing the
    // light pass was built to eliminate. Cumulative weight at the contact
    // line ≈ the old 0.10; each visible step is only 0.026.
    if (opts.contact) {
      ctx.globalAlpha = opacity * 0.026;
      ctx.fillStyle = '#000';
      const seat = (f0, f3) => {
        for (const h of [0.22, 0.165, 0.11, 0.055]) {
          ctx.beginPath();
          ctx.moveTo(f0.x, f0.y);
          ctx.lineTo(f0.x + uz.x * h, f0.y + uz.y * h);
          ctx.lineTo(f3.x + uz.x * h, f3.y + uz.y * h);
          ctx.lineTo(f3.x, f3.y);
          ctx.closePath(); ctx.fill();
        }
      };
      seat(xFace[0], xFace[3]);
      seat(yFace[0], yFace[3]);
    }

    // Ambient occlusion against settled neighbours (blocks only —
    // opts.ao is the block's integer cell). A neighbour standing
    // diagonally in front of a side face makes an inside corner along
    // that face's far edge; a neighbour one level up beside the top face
    // casts a soft band onto it. This is the difference between a stack
    // of separate cubes and a single built mass.
    const ao = E.SCALE >= 0.8 ? opts.ao : null; // sub-pixel when zoomed far out
    if (ao) {
      ctx.globalAlpha = opacity * AO_ALPHA;
      ctx.fillStyle = LIGHT_COOL;
      const xOut = xVisible ? ao.gx + 1 : ao.gx - 1;
      const yOut = yVisible ? ao.gy + 1 : ao.gy - 1;
      // ±x face: origin at its base-near corner, along uy, up uz
      const xo = xVisible ? P(ux.x, ux.y) : P(0, 0);
      if (W.settledAt(xOut, ao.gy + 1, ao.gz)) aoBand(ctx, xo, uy, uz, 'b1');
      if (W.settledAt(xOut, ao.gy - 1, ao.gz)) aoBand(ctx, xo, uy, uz, 'b0');
      const yo = yVisible ? P(uy.x, uy.y) : P(0, 0);
      if (W.settledAt(ao.gx + 1, yOut, ao.gz)) aoBand(ctx, yo, ux, uz, 'b1');
      if (W.settledAt(ao.gx - 1, yOut, ao.gz)) aoBand(ctx, yo, ux, uz, 'b0');
    }

    // Top face
    const topFace = [
      P(uz.x, uz.y),
      P(ux.x + uz.x, ux.y + uz.y),
      opp,
      P(uy.x + uz.x, uy.y + uz.y),
    ];
    ctx.globalAlpha = opacity;
    ctx.fillStyle = col.top;
    facePath(...topFace); ctx.fill();
    applyLight(li.topLight * 0.5, opacity); // subtle — top is already the lightest shade
    applyBeam(bl && bl.top, gx + 0.5, gy + 0.5, opacity);
    faceLights(() => facePath(...topFace), topFace[0], [gx + (1 - sxy) / 2, gy + (1 - sy) / 2, gz + sz], 1, 0, 0, 0, 1, 0, 0, 0, 1,
      { x: fv.ux.x, y: fv.ux.y }, { x: fv.uy.x, y: fv.uy.y });

    if (ao) {
      ctx.globalAlpha = opacity * AO_ALPHA;
      ctx.fillStyle = LIGHT_COOL;
      const to = P(uz.x, uz.y);
      if (W.settledAt(ao.gx + 1, ao.gy, ao.gz + 1)) aoBand(ctx, to, ux, uy, 'b1');
      if (W.settledAt(ao.gx - 1, ao.gy, ao.gz + 1)) aoBand(ctx, to, ux, uy, 'b0');
      if (W.settledAt(ao.gx, ao.gy + 1, ao.gz + 1)) aoBand(ctx, to, ux, uy, 'a1');
      if (W.settledAt(ao.gx, ao.gy - 1, ao.gz + 1)) aoBand(ctx, to, ux, uy, 'a0');
    }

    // Per-block lightness jitter (top face only — the most visible)
    if (styled && opts.shade) {
      ctx.globalAlpha = opacity * Math.abs(opts.shade) * 0.05;
      ctx.fillStyle = opts.shade > 0 ? '#ffffff' : '#000000';
      facePath(...topFace); ctx.fill();
    }

    facePath(...topFace);
    if (opts.gridTop) {
      ctx.globalAlpha = opacity * 0.07;
      ctx.strokeStyle = '#000';
      ctx.lineWidth = 1;
      ctx.stroke();
    } else {
      outline();
    }

    // Material texture — monuments only (opts.tex is the logical piece;
    // ghosts/floaters/blocks never pass it, so they opt out by omission).
    // Gated on the LOGICAL size so the gate can't flicker mid-ceremony,
    // and drawn under the warm shimmer + moonlit rim, which are light.
    const tp = opts.tex;
    if (tp && styled) {
      const fam = MATERIALS[colorKey];
      if (fam) {
        const amt = W.MAT[fam];
        const lsy = tp.sy != null ? tp.sy : tp.sxy;
        if (amt > 0 && Math.max(tp.sxy, lsy, tp.sz) >= STROKE_MIN) {
          drawMaterialTexture(ctx, fam, amt, opacity, tp, ref, ux, uy, uz,
            xVisible, yVisible, tp.sxy, lsy, tp.sz, li, !!ROUGH_STONE[colorKey]);
        }
      }
      // The sign — flagged pieces only (the Prudential band). Drawn on
      // the BROAD face (which axis that is survives quarter turns), with
      // the column order flipped whenever the face's screen basis points
      // left, so the wordmark always reads forward — like a real sign
      // painted on both faces. Ink keys off the plate colour: a blue
      // plate takes pale ink, a pale plate takes Prudential blue.
      if (tp.sign && SIGN_MARKS[tp.sign]) {
        const mark = SIGN_MARKS[tp.sign];
        const lsy = tp.sy != null ? tp.sy : tp.sxy;
        const broadX = tp.sxy >= lsy; // plate runs along x (else y, after a quarter turn)
        const A = broadX ? ux : uy;
        const o = broadX
          ? (yVisible ? { x: ref.x + uy.x, y: ref.y + uy.y } : ref)
          : (xVisible ? { x: ref.x + ux.x, y: ref.y + ux.y } : ref);
        const flip = A.x < 0;
        const colW = 0.92 / mark.cols;
        const rowH = 0.60 / 5, vBot = 0.20; // letters fill the band's middle
        const stamp = (dots) => {
          ctx.beginPath();
          for (const [c, r] of dots) {
            const u = 0.04 + (flip ? mark.cols - 1 - c : c) * colW;
            texMark(ctx, o, A, uz, u, vBot + (4 - r) * rowH, colW, rowH);
          }
          ctx.globalAlpha = opacity * 0.95;
          ctx.fill();
        };
        ctx.fillStyle = SIGN_INK[colorKey] || '#3567b2';
        stamp(mark.dots);
        if (mark.accent.length) {
          ctx.fillStyle = SIGN_ACCENT_INK[colorKey] || SIGN_INK[colorKey] || '#3567b2';
          stamp(mark.accent);
        }
      }
      // Windows — flagged pieces (the office towers). A curtain-wall
      // grid on BOTH visible side faces: dark glass punches with a
      // sparse scatter of warm lit windows (someone is working late).
      // The lit set is seeded on the piece's LOGICAL cell + a per-face
      // term, so it never changes under rotation, reload or the
      // ceremony pop — the anti-crawl contract, same as the material
      // marks. tp.win is the PARAPET height in cells: windows stop
      // that far below the piece top, so the crown band stays blank on
      // every face (the sign plates cover only the broad ones).
      // Two fills total: all dark punches in one batch, all lit in one.
      if (tp.win) {
        const lsy = tp.sy != null ? tp.sy : tp.sxy;
        const H = tp.sz;
        const CP = 0.17, CW = 0.10; // column pitch / window width, in cells
        const RP = 0.23, RH = 0.13; // row pitch / window height
        const usable = H - tp.win - 0.10;
        const nRows = Math.max(1, Math.floor(usable / RP));
        const hx = Math.round(tp.gx * 16), hy = Math.round(tp.gy * 16), hz = Math.round(tp.gz * 16);
        const faces = [
          { o: xVisible ? { x: ref.x + ux.x, y: ref.y + ux.y } : ref,
            A: uy, W: lsy, rnd: E.hashRand(hx + 11, hy, hz) },
          { o: yVisible ? { x: ref.x + uy.x, y: ref.y + uy.y } : ref,
            A: ux, W: tp.sxy, rnd: E.hashRand(hx, hy + 13, hz) },
        ];
        const lit = [];
        ctx.beginPath();
        for (const f of faces) {
          const nCols = Math.floor((f.W - 0.10) / CP);
          if (nCols < 1) continue;
          const u0 = (f.W - (nCols * CP - (CP - CW))) / 2;
          for (let c = 0; c < nCols; c++) {
            for (let r = 0; r < nRows; r++) {
              const q = [f.o, f.A, (u0 + c * CP) / f.W, (0.10 + r * RP) / H, CW / f.W, RH / H];
              // The late shift comes and goes: ~9% lit at any moment,
              // some of them permanent, the rest switching over minutes
              // on their own slow clocks (still seeded — nothing crawls).
              const rv = f.rnd();
              const on = rv < 0.06 || (rv < 0.17 && !E.reducedMotion &&
                Math.sin(VH.clock.time * 0.06 + rv * 700) > 0.45) ||
                (rv < 0.09 && E.reducedMotion);
              if (on) lit.push(q);
              else texMark(ctx, q[0], q[1], uz, q[2], q[3], q[4], q[5]);
            }
          }
        }
        ctx.globalAlpha = opacity * 0.45;
        ctx.fillStyle = '#1d2433'; // night glass — cool dark against the warm stone
        ctx.fill();
        if (lit.length) {
          ctx.beginPath();
          for (const q of lit) texMark(ctx, q[0], q[1], uz, q[2], q[3], q[4], q[5]);
          ctx.globalAlpha = opacity * 0.9;
          ctx.fillStyle = '#ffdf9c'; // the late shift
          ctx.fill();
        }
      }
      // Face patterns — flagged pieces (the Eiffel Tower). Painted, not
      // built: the reference render's truss is thousands of tiny voxels,
      // which this sorter cannot afford, so the OPENINGS are painted as
      // dark diamonds on the side faces and the light stone left between
      // them reads as the X-bracing. Anchored to WORLD coordinates (not
      // to the piece), so the pattern runs continuously across stacked
      // courses instead of restarting at every joint. 'mullion' is the
      // gallery version: dark bars across a lit band, leaving windows.
      // One fill per piece, same batching as the windows above.
      if (tp.mark) {
        const lsy = tp.sy != null ? tp.sy : tp.sxy;
        const H = tp.sz;
        const faces = [
          { o: xVisible ? { x: ref.x + ux.x, y: ref.y + ux.y } : ref, A: uy, W: lsy, a0: tp.gy + (1 - lsy) / 2 },
          { o: yVisible ? { x: ref.x + uy.x, y: ref.y + uy.y } : ref, A: ux, W: tp.sxy, a0: tp.gx + (1 - tp.sxy) / 2 },
        ];
        // A rounded arch on face f: foot at the face's base, centred at
        // uc (cells along the face), w wide, h tall overall (straight
        // jambs + 7-point semicircle). Adds to the current path.
        const archPath = (f, uc, w, h) => {
          const R = w / 2, v1 = h - R;
          const pt = (u, v) => ({ x: f.o.x + f.A.x * (u / f.W) + uz.x * (v / H), y: f.o.y + f.A.y * (u / f.W) + uz.y * (v / H) });
          let q = pt(uc - R, 0); ctx.moveTo(q.x, q.y);
          q = pt(uc - R, v1); ctx.lineTo(q.x, q.y);
          for (let i = 1; i <= 7; i++) { const t = Math.PI - (i / 8) * Math.PI; q = pt(uc + R * Math.cos(t), v1 + R * Math.sin(t)); ctx.lineTo(q.x, q.y); }
          q = pt(uc + R, v1); ctx.lineTo(q.x, q.y);
          q = pt(uc + R, 0); ctx.lineTo(q.x, q.y);
          ctx.closePath();
        };
        ctx.beginPath();
        if (tp.mark === 'lattice') {
          const P = 0.16, hd = 0.064;                 // opening pitch, diamond half-size — 0.03 of stone between openings reads as the X-bracing
          for (const f of faces) {
            if (f.W < 2 * hd + 0.04) continue;
            const c0 = Math.floor(f.a0 / P), c1 = Math.ceil((f.a0 + f.W) / P);
            const r0 = Math.floor(tp.gz / P), r1 = Math.ceil((tp.gz + H) / P);
            for (let c = c0; c <= c1; c++) {
              const a = (c + 0.5) * P;              // opening centre, world units along the face
              if (a - hd < f.a0 + 0.015 || a + hd > f.a0 + f.W - 0.015) continue;
              const u = (a - f.a0) / f.W, du = hd / f.W;
              for (let r = r0; r <= r1; r++) {
                const zc = (r + 0.5) * P;
                if (zc - hd < tp.gz + 0.015 || zc + hd > tp.gz + H - 0.015) continue;
                const v = (zc - tp.gz) / H, dv = hd / H;
                const cx = f.o.x + f.A.x * u + uz.x * v, cy = f.o.y + f.A.y * u + uz.y * v;
                ctx.moveTo(cx - f.A.x * du, cy - f.A.y * du);
                ctx.lineTo(cx + uz.x * dv, cy + uz.y * dv);
                ctx.lineTo(cx + f.A.x * du, cy + f.A.y * du);
                ctx.lineTo(cx - uz.x * dv, cy - uz.y * dv);
                ctx.closePath();
              }
            }
          }
          ctx.globalAlpha = opacity * 0.55;
          ctx.fillStyle = '#3b2f22'; // the dark of the openings
          ctx.fill();
        } else if (tp.mark === 'windows') {
          // A row of warm lit windows, centred on each side face. Colour
          // only — a lit tower with no light (the Eiffel lesson: painted
          // windows, real lights only where a lamp actually hangs).
          const P = 0.22, WW = 0.12, WH = 0.16;
          for (const f of faces) {
            const n = Math.floor((f.W - 0.10) / P);
            if (n < 1) continue;
            const span = n * P - (P - WW), u0 = (f.W - span) / 2, v0 = (H - WH) / 2;
            for (let c = 0; c < n; c++) texMark(ctx, f.o, f.A, uz, (u0 + c * P) / f.W, v0 / H, WW / f.W, WH / H);
          }
          ctx.globalAlpha = opacity * 0.9;
          ctx.fillStyle = '#ffdf9c';
          ctx.fill();
        } else if (tp.mark === 'gateX' || tp.mark === 'gateY') {
          // The gate: a dark rounded arch at the foot of the two faces the
          // wall runs THROUGH (gateY = the faces whose normal is ±y, i.e.
          // faces[1]; instantiate swaps the axis on odd quarter turns),
          // plus two painted lanterns flanking it. The lanterns are ink
          // rather than lamp cubes because a cube on the face would
          // overhang the cell — the one thing this monument may not do.
          const f = faces[tp.mark === 'gateY' ? 1 : 0];
          const AW = 0.36, AH = 0.40, cu = f.W / 2;
          archPath(f, cu, AW, AH + AW / 2);
          ctx.globalAlpha = opacity * 0.9;
          ctx.fillStyle = '#1a1612';
          ctx.fill();
          ctx.beginPath();
          for (const du of [-0.30, 0.30]) texMark(ctx, f.o, f.A, uz, (cu + du - 0.05) / f.W, 0.72 / H, 0.10 / f.W, 0.10 / H);
          ctx.globalAlpha = opacity * 0.95;
          ctx.fillStyle = '#ffdf9c';
          ctx.fill();
        } else if (tp.mark === 'arcade') {
          // The Colosseum's arcade: one ink arch per 0.25 step, anchored
          // to WORLD coordinates along the face (like lattice) so the
          // stair-stepped ring shows one rhythm on every exposed sliver,
          // with a warm lit square inside each foot. Painted, not lit —
          // the ring carries no glow pieces.
          const P = 0.25, AW = 0.13, AH = 0.30, LW = 0.07;
          const spots = [];
          for (const f of faces) {
            const c0 = Math.floor(f.a0 / P), c1 = Math.ceil((f.a0 + f.W) / P);
            for (let c = c0; c <= c1; c++) {
              const a = (c + 0.5) * P;
              if (a - AW / 2 < f.a0 + 0.015 || a + AW / 2 > f.a0 + f.W - 0.015) continue;
              archPath(f, a - f.a0, AW, AH);
              spots.push([f, a - f.a0]);
            }
          }
          ctx.globalAlpha = opacity * 0.9;
          ctx.fillStyle = '#2a2118';
          ctx.fill();
          ctx.beginPath();
          for (const [f, u] of spots) texMark(ctx, f.o, f.A, uz, (u - LW / 2) / f.W, 0.04 / H, LW / f.W, LW / H);
          ctx.globalAlpha = opacity * 0.9;
          ctx.fillStyle = '#ffdf9c';
          ctx.fill();
        } else if (tp.mark === 'terrace' || tp.mark === 'terraceX' || tp.mark === 'terraceY') {
          // The Hanging Gardens' tier face: a lapis tile band under the
          // top edge, a row of arches (every other one lit), a waterfall
          // down the centre of the FALL face (terraceX/Y name the axis in
          // model space; instantiate swaps it on odd quarter turns; plain
          // 'terrace' has no fall), and vines hanging from the top edge
          // at fixed per-column lengths so they never shimmer. Anchored
          // to world coordinates like lattice. Six batched fills.
          // band sits 0.15-0.22 below the top edge: the hedge overhang above
          // hides the top 0.15 of every face at the iso elevation
          const AP = 0.30, AW = 0.16, AH = 0.30, LS = 0.06, BT = 0.22, BB = 0.15;
          const WW = 0.24, VP = 0.13, VW = 0.05;
          const fall = tp.mark === 'terraceY' ? faces[1] : tp.mark === 'terraceX' ? faces[0] : null;
          const inFall = (f, u0, u1) => f === fall && u1 > (f.W - WW) / 2 && u0 < (f.W + WW) / 2;
          for (const f of faces) texMark(ctx, f.o, f.A, uz, 0, (H - BT) / H, 1, (BT - BB) / H);
          ctx.globalAlpha = opacity * 0.9;
          ctx.fillStyle = '#3a5db0'; // the glazed tile band
          ctx.fill();
          ctx.beginPath();
          const lit = [];
          for (const f of faces) {
            const c0 = Math.floor(f.a0 / AP), c1 = Math.ceil((f.a0 + f.W) / AP);
            for (let c = c0; c <= c1; c++) {
              const a = (c + 0.5) * AP;
              if (a - AW / 2 < f.a0 + 0.015 || a + AW / 2 > f.a0 + f.W - 0.015) continue;
              archPath(f, a - f.a0, AW, AH);
              if (c % 2 === 0) lit.push([f, a - f.a0]);
            }
          }
          ctx.globalAlpha = opacity * 0.9;
          ctx.fillStyle = '#2a2118';
          ctx.fill();
          ctx.beginPath();
          for (const [f, u] of lit) texMark(ctx, f.o, f.A, uz, (u - LS / 2) / f.W, 0.04 / H, LS / f.W, LS / H);
          ctx.globalAlpha = opacity * 0.9;
          ctx.fillStyle = '#ffdf9c';
          ctx.fill();
          if (fall) {
            ctx.beginPath();
            texMark(ctx, fall.o, fall.A, uz, (fall.W - WW) / 2 / fall.W, 0, WW / fall.W, (H - BT) / H);
            ctx.globalAlpha = opacity * 0.92;
            ctx.fillStyle = '#8fc6ee'; // the fall — colour only, no light
            ctx.fill();
            ctx.beginPath();
            for (const du of [-0.06, 0.06]) texMark(ctx, fall.o, fall.A, uz, (fall.W / 2 + du - 0.015) / fall.W, 0, 0.03 / fall.W, (H - BT) / H);
            ctx.globalAlpha = opacity * 0.7;
            ctx.fillStyle = '#eaf7ff'; // white water streaks
            ctx.fill();
          }
          ctx.beginPath();
          for (const f of faces) {
            const c0 = Math.floor(f.a0 / VP), c1 = Math.ceil((f.a0 + f.W) / VP);
            for (let c = c0; c <= c1; c++) {
              const u0 = c * VP + VP / 2 - VW / 2 - f.a0, u1 = u0 + VW;
              if (u0 < 0.01 || u1 > f.W - 0.01 || inFall(f, u0, u1)) continue;
              const len = Math.min(H - 0.02, 0.18 + 0.22 * ((((c * 7919) % 13) + 13) % 13) / 13); // reaches below the overhang's shadow
              texMark(ctx, f.o, f.A, uz, u0 / f.W, (H - len) / H, VW / f.W, len / H);
            }
          }
          ctx.globalAlpha = opacity * 0.9;
          ctx.fillStyle = '#4f7d38'; // hanging vines
          ctx.fill();
        } else if (tp.mark === 'mullion') {
          const P = 0.24, BW = 0.09;                  // window pitch, bar width (cells)
          for (const f of faces) {
            if (f.W < P) continue;
            const c0 = Math.floor(f.a0 / P), c1 = Math.ceil((f.a0 + f.W) / P);
            for (let c = c0; c <= c1; c++) {
              const a = c * P - BW / 2;
              if (a < f.a0 - 1e-6 || a + BW > f.a0 + f.W + 1e-6) continue;
              texMark(ctx, f.o, f.A, uz, (a - f.a0) / f.W, 0, BW / f.W, 1);
            }
          }
          ctx.globalAlpha = opacity * 0.85;
          ctx.fillStyle = '#5a4630'; // dark stone bars between the windows
          ctx.fill();
        }
      }
    }

    // Warmer/colder shimmer: this block is part of a nearly-complete recipe.
    // This is now the game's WHOLE hint (the dog retired from the job), so:
    // a travelling pulse (phase offset by cell) makes N blocks read as ONE
    // arrangement; a strong rim over a quiet wash keeps it legible without
    // recoloring the block; a fade-out envelope replaces the hard cutoff.
    if (opts.warmT > 0) {
      const env = Math.min(1, opts.warmT / 1.5); // 1.5s fade-out, no snap
      const pulse = E.reducedMotion
        ? 0.65 // steady gold edge — the hint survives, the motion doesn't
        : 0.5 + 0.5 * Math.sin(VH.clock.time * 4.2 - (gx + gy) * 0.7);
      ctx.globalAlpha = opacity * env * (0.05 + pulse * 0.09);
      ctx.fillStyle = '#ffe9a8';
      facePath(...topFace); ctx.fill();
      // EDGES, not face outlines — EVERY visible edge of EVERY warm cube,
      // seams included, so each cube reads as individually lit. Keeping
      // it edge-based (rather than stroking three face quads) is what
      // avoids the original artifacts: quads painted every shared edge
      // twice, sprouted crossing spurs at the corners, and drew the
      // hidden top-face outline of a stacked block as a band across the
      // seam. Here each cube emits its 9 visible edges exactly once.
      //
      // DELIBERATE, DO NOT "FIX" BACK: a neighbour test used to skip
      // shared edges so an arrangement outlined as ONE shape. It never
      // actually ran (it queried an integer-keyed map with fractional
      // render coordinates, so it always missed) — meaning the per-cube
      // look below is what the game always shipped. When the lookup was
      // repaired the group outline appeared for the first time and the
      // designer rejected it on sight, twice. Per-cube is the decision.
      const sxv = xVisible ? 1 : 0, syv = yVisible ? 1 : 0; // viewer-facing sides
      const C = (s, t, h) =>
        P(s * ux.x + t * uy.x + h * uz.x, s * ux.y + t * uy.y + h * uz.y);
      // The RIM pulses group-wide (no per-cell phase) so a run of lit
      // cubes breathes together. The travelling per-cell pulse stays on
      // the WASH above — that is what ties them into one arrangement.
      const rimPulse = E.reducedMotion ? 0.65 : 0.5 + 0.5 * Math.sin(VH.clock.time * 4.2);
      ctx.globalAlpha = opacity * env * (0.50 + rimPulse * 0.50);
      ctx.strokeStyle = '#ffd968';
      ctx.lineWidth = Math.max(1.5, 2 * E.SCALE);
      ctx.lineCap = 'round';
      ctx.beginPath();
      const edge = (a, b2) => { ctx.moveTo(a.x, a.y); ctx.lineTo(b2.x, b2.y); };
      // 4 top edges (top face + each side)
      edge(C(0, 0, 1), C(1, 0, 1));
      edge(C(1, 0, 1), C(1, 1, 1));
      edge(C(1, 1, 1), C(0, 1, 1));
      edge(C(0, 1, 1), C(0, 0, 1));
      // 3 visible verticals (the corner opposite the front one is hidden)
      for (let s = 0; s <= 1; s++) for (let t = 0; t <= 1; t++) {
        if (s === 1 - sxv && t === 1 - syv) continue; // the hidden back corner
        edge(C(s, t, 0), C(s, t, 1));
      }
      // 2 visible bottom edges (along the two viewer-facing side faces)
      edge(C(sxv, 0, 0), C(sxv, 1, 0));
      edge(C(0, syv, 0), C(1, syv, 0));
      ctx.stroke();
      ctx.lineCap = 'butt';
    }

    // Moonlit rim: highlight the two top edges nearest the moon
    // (position hoisted to E.li — one moon, and no per-block recompute)
    if (stroked) {
      const moon = { x: li.moonSx, y: li.moonSy };
      let best = 0, bestD = Infinity;
      for (let i = 0; i < 4; i++) {
        const d = (topFace[i].x - moon.x) ** 2 + (topFace[i].y - moon.y) ** 2;
        if (d < bestD) { bestD = d; best = i; }
      }
      const prev = topFace[(best + 3) % 4];
      const next = topFace[(best + 1) % 4];
      ctx.globalAlpha = opacity * 0.45;
      ctx.strokeStyle = '#fff6dc';
      ctx.lineWidth = 1.5;
      ctx.beginPath();
      ctx.moveTo(prev.x, prev.y);
      ctx.lineTo(topFace[best].x, topFace[best].y);
      ctx.lineTo(next.x, next.y);
      ctx.stroke();
    }

    ctx.globalAlpha = 1;
  };

  // ── Flowers (the Hanging Gardens) ───────────────────────────
  // Pixel-art flower sprites are flat, front-facing and RADIAL: a ring
  // of petals around a contrasting centre. At the ~10px a flower head
  // occupies here that ring is the entire read, so the head is
  // BILLBOARDED — built in screen space, always facing the viewer —
  // rather than modelled from boxes, which would read as a green lump
  // from most camera angles and vanish edge-on from some.
  //
  // Palette lifted from the reference sheet and pulled down a little:
  // full sprite-sheet saturation fights a moonlit scene.
  const FLOWERS = [
    ['#e87ba8', '#ffd96b'], // pink
    ['#e2553f', '#ffd96b'], // red
    ['#6f9fe0', '#ffb14a'], // cornflower
    ['#ef9440', '#ffe08a'], // orange
    ['#a878d8', '#ffd96b'], // violet
    ['#f0d152', '#ef9440'], // yellow
    ['#f0ece2', '#f0d152'], // white
  ];
  W.FLOWERS_ON = 1.2; // designer-picked on screen (vh-dev-flowers); 0 = off

  // tp = the LOGICAL piece: seeds the planting and fixes the COUNT, so
  // the ceremony pop grows the flowers with the terrace instead of
  // spawning new ones every frame. Same contract as opts.tex.
  W.drawFlowers = (gx, gy, gz, sxy, sy, sz, tp, opacity) => {
    if (!(W.FLOWERS_ON > 0) || opacity <= 0) return;
    const ctx = E.ctx;
    const lsy = tp.sy != null ? tp.sy : tp.sxy;
    const n = Math.max(1, Math.min(7, Math.round(tp.sxy * lsy * 9 * W.FLOWERS_ON)));
    const rnd = E.hashRand(Math.round(tp.gx * 16) + 7,
      Math.round(tp.gy * 16) + 11, Math.round(tp.gz * 16) + 13);
    const top = gz + sz;
    // Ratio of DRAWN to LOGICAL size — 1 at rest, and the ceremony's
    // backOut(pop) while a terrace is rising. Heads and stems are sized
    // in pixels/grid-units, so without this they pop in at full size
    // above a terrace that is still a dot: flowers first, garden after.
    const k = tp.sxy > 0 ? Math.min(1, sxy / tp.sxy) : 1;
    const r = Math.max(1.5, 2.5 * E.SCALE) * k; // petal-ring radius, px
    const pw = r * 1.06;                        // petal square, px
    for (let i = 0; i < n; i++) {
      const u = 0.14 + rnd() * 0.72;
      const v = 0.14 + rnd() * 0.72;
      const h = (0.09 + rnd() * 0.09) * k;     // stem height, grid units
      const f = FLOWERS[Math.floor(rnd() * FLOWERS.length)];
      const phase = rnd() * Math.PI * 2;
      const bx = gx + (1 - sxy) / 2 + u * sxy;
      const by = gy + (1 - sy) / 2 + v * sy;
      const sway = E.reducedMotion ? 0 : Math.sin(VH.clock.time * 1.5 + phase) * 0.03;
      const base = E.toScreen(bx, by, top);
      const tip = E.toScreen(bx + sway, by + sway * 0.6, top + h);
      ctx.globalAlpha = opacity * 0.9;
      ctx.strokeStyle = '#4f9455';
      ctx.lineWidth = Math.max(1, 1.1 * E.SCALE);
      ctx.beginPath();
      ctx.moveTo(base.x, base.y);
      ctx.quadraticCurveTo(base.x, (base.y + tip.y) / 2, tip.x, tip.y);
      ctx.stroke();
      // Five petals in a ring, then the centre. The ring is squashed
      // vertically so the head sits in the isometric scene instead of
      // reading as a sticker pasted flat on the screen.
      ctx.globalAlpha = opacity;
      ctx.fillStyle = f[0];
      ctx.beginPath();
      for (let p = 0; p < 5; p++) {
        const a = phase + p * (Math.PI * 2 / 5);
        ctx.rect(tip.x + Math.cos(a) * r - pw / 2,
          tip.y + Math.sin(a) * r * 0.8 - pw / 2, pw, pw);
      }
      ctx.fill();
      ctx.fillStyle = f[1];
      ctx.fillRect(tip.x - pw * 0.52, tip.y - pw * 0.52, pw * 1.04, pw * 1.04);
    }
    ctx.globalAlpha = 1;
  };

  // Placement preview. The old ghost was three quads of flat #ffffff at
  // alpha 0.25 with no stroke — over grass that is ~1.3:1 contrast, over
  // a pale block invisible, and with all faces the same value it read as
  // a flat hexagon, not a cube. Now: the block's REAL colours at 0.4
  // (the monument-ghost idiom), a light silhouette, and an emphasised
  // BASE DIAMOND — the footprint on the surface the cube will sit on,
  // which is the actual answer to "am I on top of this tower or behind
  // it?". `mul` scales the whole thing down for the quiet hover preview.
  W.drawGhostBlock = (gx, gy, gz, colorKey, mul = 1) => {
    const ctx = E.ctx;
    const ref = E.toScreen(gx, gy, gz);
    const { ux, uy, uz, xVisible, yVisible } = E.fv;
    const opp = { x: ref.x + ux.x + uy.x + uz.x, y: ref.y + ux.y + uy.y + uz.y };
    const col = W.COLORS[colorKey];
    const fillA = (col ? 0.4 : 0.25) * mul;

    const quad = (a, b, c, d, fill) => {
      ctx.fillStyle = fill;
      ctx.beginPath();
      ctx.moveTo(a.x, a.y); ctx.lineTo(b.x, b.y);
      ctx.lineTo(c.x, c.y); ctx.lineTo(d.x, d.y);
      ctx.closePath(); ctx.fill();
    };
    const at = (sx, sy, sz2) => ({
      x: ref.x + sx * ux.x + sy * uy.x + sz2 * uz.x,
      y: ref.y + sx * ux.y + sy * uy.y + sz2 * uz.y,
    });

    ctx.globalAlpha = fillA;
    // x side (whichever faces the viewer), y side, top — per-face colours
    // so the ghost reads as a volume, not a flat wash.
    const xs = xVisible ? 1 : 0;
    quad(at(xs, 0, 0), at(xs, 0, 1), at(xs, 1, 1), at(xs, 1, 0),
      col ? col.right : '#ffffff');
    const ys = yVisible ? 1 : 0;
    quad(at(0, ys, 0), at(0, ys, 1), at(1, ys, 1), at(1, ys, 0),
      col ? col.front : '#ffffff');
    quad(at(0, 0, 1), at(1, 0, 1), opp, at(0, 1, 1),
      col ? col.top : '#ffffff');

    // The base diamond: the footprint, stroked strong — the load-bearing
    // cue. (All four edges: the two "behind" the cube show through the
    // translucent fills and complete the reticle.)
    ctx.strokeStyle = '#fff6dc'; // the moonlit-rim warm white
    ctx.lineWidth = Math.max(1.5, 2 * E.SCALE);
    ctx.globalAlpha = 0.9 * mul;
    ctx.beginPath();
    ctx.moveTo(ref.x, ref.y);
    ctx.lineTo(at(1, 0, 0).x, at(1, 0, 0).y);
    ctx.lineTo(at(1, 1, 0).x, at(1, 1, 0).y);
    ctx.lineTo(at(0, 1, 0).x, at(0, 1, 0).y);
    ctx.closePath(); ctx.stroke();

    // Light top outline + visible verticals so the volume has edges
    ctx.lineWidth = 1;
    ctx.globalAlpha = 0.4 * mul;
    ctx.beginPath();
    ctx.moveTo(at(0, 0, 1).x, at(0, 0, 1).y);
    ctx.lineTo(at(1, 0, 1).x, at(1, 0, 1).y);
    ctx.lineTo(opp.x, opp.y);
    ctx.lineTo(at(0, 1, 1).x, at(0, 1, 1).y);
    ctx.closePath(); ctx.stroke();
    ctx.beginPath();
    const sxv = xVisible ? 1 : 0, syv = yVisible ? 1 : 0;
    for (let s = 0; s <= 1; s++) {
      for (let t = 0; t <= 1; t++) {
        if (s === 1 - sxv && t === 1 - syv) continue; // hidden back corner
        ctx.moveTo(at(s, t, 0).x, at(s, t, 0).y);
        ctx.lineTo(at(s, t, 1).x, at(s, t, 1).y);
      }
    }
    ctx.stroke();

    ctx.globalAlpha = 1;
  };

  // Block at a fixed screen position (the piece carried under the cursor)
  W.drawBlockAtScreen = (sx, sy, colorKey, opacity) => {
    const ctx = E.ctx;
    const t = E.TILE * E.SCALE;
    const c = W.COLORS[colorKey];
    ctx.globalAlpha = opacity;

    ctx.fillStyle = c.top;
    ctx.beginPath();
    ctx.moveTo(sx, sy - t); ctx.lineTo(sx + t, sy - t * 0.5);
    ctx.lineTo(sx, sy); ctx.lineTo(sx - t, sy - t * 0.5);
    ctx.closePath(); ctx.fill();

    ctx.fillStyle = c.right;
    ctx.beginPath();
    ctx.moveTo(sx, sy); ctx.lineTo(sx + t, sy - t * 0.5);
    ctx.lineTo(sx + t, sy + t * 0.5); ctx.lineTo(sx, sy + t);
    ctx.closePath(); ctx.fill();

    ctx.fillStyle = c.front;
    ctx.beginPath();
    ctx.moveTo(sx, sy); ctx.lineTo(sx - t, sy - t * 0.5);
    ctx.lineTo(sx - t, sy + t * 0.5); ctx.lineTo(sx, sy + t);
    ctx.closePath(); ctx.fill();

    ctx.globalAlpha = 1;
  };
})();
