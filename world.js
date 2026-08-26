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
    red:    { top: '#e05050', right: '#b03030', front: '#c84040' },
    blue:   { top: '#5090e0', right: '#3060b0', front: '#4078c8' },
    green:  { top: '#50c878', right: '#308850', front: '#40a860' },
    yellow: { top: '#f0d040', right: '#c0a020', front: '#d8b830' },
    orange: { top: '#f0a030', right: '#c07820', front: '#d88c28' },
    purple: { top: '#a070d0', right: '#7048a0', front: '#8858b8' },
    cyan:   { top: '#50c8d8', right: '#3098a8', front: '#40b0c0' },
    pink:   { top: '#e870a0', right: '#b84878', front: '#d05888' },
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
  W.spawnBlocks = (count, plan) => {
    for (let i = 0; i < count; i++) {
      const gx = W.GRID_MIN + Math.floor(Math.random() * (W.GRID_MAX - W.GRID_MIN + 1));
      const gy = W.GRID_MIN + Math.floor(Math.random() * (W.GRID_MAX - W.GRID_MIN + 1));
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

  W.BLAST = { GRAVITY: BLAST_GRAVITY, FIREWORK_GRAVITY }; // exposed for game.js blast trigger

  // Squash-and-stretch spring (snappy, slight overshoot into a stretch)
  const SQUASH_K = 200;
  const SQUASH_D = 14;

  // Platform dip: the whole stage flinches when the blast fires
  W.dip = 0;
  W.dipVel = 0;
  W.kickDip = (v) => { W.dipVel += v; };

  W.hoveredBlock = null; // set by game.js; blocks ease a lift toward it

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
      b.blastX = 0; b.blastY = 0; b.blastZ = 0;
      b.preBlast = reduced ? 0.01 : delayBase + dist * delayPerDist; // shockwave stagger
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
          // Fully opaque through the climb; the payoff is at the APEX
          if (b.blastVelZ <= 0) { detonate(b); b.opacity = 0; }
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
  function applyLight(lightFactor, opacity) {
    const ctx = E.ctx;
    if (lightFactor > 0.05) {
      ctx.globalAlpha = opacity * lightFactor * 0.18;
      ctx.fillStyle = '#ffffff';
      ctx.fill();
    } else if (lightFactor < -0.05) {
      ctx.globalAlpha = opacity * (-lightFactor) * 0.25;
      ctx.fillStyle = '#000000';
      ctx.fill();
    }
  }

  // Smallest largest-dimension that still earns outlines + moonlit rim
  const STROKE_MIN = 0.35;

  // opts: sxy/sz   squash scale (width / height)
  //       sy       y-axis footprint (defaults to sxy) — RECTANGULAR pieces.
  //                Before this, every beam/lintel was secretly a square
  //                slab (the torii lintel rendered as a table top).
  //       styled   full treatment: outlines, moonlit rim, shade jitter
  //       shade    per-block lightness jitter (−1..1)
  //       contact  darken the base of side faces (resting on something)
  //       gridTop  subtle tile-grid stroke on the top face (platform)
  //       warmT    seconds of near-miss shimmer remaining (0/undefined = off)
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

    // ±x side face
    let xFace;
    ctx.globalAlpha = opacity;
    ctx.fillStyle = col.right;
    if (xVisible) {
      xFace = [P(ux.x, ux.y), P(ux.x + uz.x, ux.y + uz.y), opp, P(ux.x + uy.x, ux.y + uy.y)];
      facePath(...xFace); ctx.fill();
      applyLight(li.pxLight, opacity);
    } else {
      xFace = [P(0, 0), P(uz.x, uz.y), P(uy.x + uz.x, uy.y + uz.y), P(uy.x, uy.y)];
      facePath(...xFace); ctx.fill();
      applyLight(li.nxLight, opacity);
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
    } else {
      yFace = [P(0, 0), P(uz.x, uz.y), P(ux.x + uz.x, ux.y + uz.y), P(ux.x, ux.y)];
      facePath(...yFace); ctx.fill();
      applyLight(li.nyLight, opacity);
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
