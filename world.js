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
    // Monument palette — reads as carved stone against the toy colors
    stone:      { top: '#e2dccb', right: '#a99f8a', front: '#c9c1ac' },
    stoneDark:  { top: '#b8b09c', right: '#847b68', front: '#a2977f' },
    gold:       { top: '#ffd968', right: '#c99a2e', front: '#edbc4a' },
    lightRed:   { top: '#e05050', right: '#a83636', front: '#c84343' },
    lightWhite: { top: '#f4f0e6', right: '#c0b9a8', front: '#e0d9c8' },
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
  // bottom-up, so two can never claim one cell. Called whenever the world
  // changes under someone's feet.
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
  W.resettle = () => {
    if (occupancyDirty) rebuildOccupancy();
    let knocked = true;
    while (knocked) {
      knocked = false;
      W.blocks.forEach(b => {
        if (!W.isLive(b) || b.dropping || b.isDebris || b.gz <= 0) return;
        if (settled.get(b.gx + ',' + b.gy + ',' + (b.gz - 1))) return;
        b.dropping = true;      // falls from exactly where it is
        b.dropVel = 0;
        b.dropOffset = 0;
        settled.delete(b.gx + ',' + b.gy + ',' + b.gz);
        knocked = true;
      });
    }
    W.retargetFalling();
    W.markDirty();
  };

  // ── Placement event hook (monuments.js subscribes) ──────────
  // Fired ONLY for deliberate player placements — never for the random
  // spawn scatter, save restore, or a drag returning home. The matcher
  // runs when the placed block SETTLES so ceremonies start on landed
  // blocks, not mid-fall.
  W.notifyPlaced = (b) => {
    W.markDirty();
    b._playerPlaced = true;
    if (!b.dropping) fireSettled(b); // reduced motion: lands instantly
  };
  function fireSettled(b) {
    b._playerPlaced = false;
    if (VH.monuments && VH.monuments.onBlockSettled) VH.monuments.onBlockSettled(b);
  }

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
    b.baseSxy = opts.sxy;
    b.baseSz = opts.sz;
    b.isDebris = true;
    return b;
  };

  W.spawnBlocks = (count) => {
    for (let i = 0; i < count; i++) {
      const gx = W.GRID_MIN + Math.floor(Math.random() * (W.GRID_MAX - W.GRID_MIN + 1));
      const gy = W.GRID_MIN + Math.floor(Math.random() * (W.GRID_MAX - W.GRID_MIN + 1));
      const gz = W.getStackHeight(gx, gy);
      W.blocks.push(W.makeBlock(gx, gy, gz, {
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
          model: m.model.map(p => [p.gx, p.gy, p.gz, p.sxy, p.sz, p.color, p.glow ? 1 : 0]),
        })),
        discovered: M ? [...M.discovered] : [],
      };
      try { localStorage.setItem(SAVE_KEY, JSON.stringify(data)); } catch (_) { /* full/blocked */ }
    }, 300);
  };

  W.clearSave = () => {
    clearTimeout(saveTimer);
    try { localStorage.removeItem(SAVE_KEY); } catch (_) {}
  };

  // Restore a saved build; returns true if anything was loaded
  W.load = () => {
    let data = null;
    try { data = JSON.parse(localStorage.getItem(SAVE_KEY)); } catch (_) {}
    if (!data || (data.v !== 1 && data.v !== 2) || !Array.isArray(data.blocks)) return false;
    let i = 0;
    for (const item of data.blocks) {
      const [gx, gy, gz, color] = item;
      if (!W.isOnPlatform(gx, gy) || gz < 0 || gz > W.MAX_STACK || !W.COLORS[color]) continue;
      W.blocks.push(W.makeBlock(gx, gy, gz, {
        color,
        dropOffset: 2 + gz * 0.6,
        dropDelay: i * 0.02, // gentle welcome-back cascade
      }));
      i++;
    }
    if (data.v === 2) {
      (data.monuments || []).forEach(m => {
        if (!Array.isArray(m.cells) || !Array.isArray(m.model)) return;
        const mon = {
          id: m.id,
          name: m.name,
          cells: m.cells.map(c => ({ gx: c[0], gy: c[1], gz: c[2] })),
          model: m.model.map(p => ({
            gx: p[0], gy: p[1], gz: p[2], sxy: p[3], sz: p[4], color: p[5], glow: !!p[6], pop: 1,
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
      VH.fx.spawnBurst(gx, gy, gz, b.color, b.isDebris ? 8 : 12);
      VH.fx.spawnFlash(gx + 0.5, gy + 0.5, gz + 0.5,
        { dur: 0.28, r0: 0.8, r1: 4.5, peak: 0.7, colorKey: b.color });
      const s = E.toScreen(gx + 0.5, gy + 0.5, gz + 0.5);
      VH.fx.igniteStars(s.x / E.W, s.y / E.H, 0.10, 0.55);
    }
    E.kickShake(1.2);
    if (VH.sfx) VH.sfx.boom(Math.min(1.3, Math.max(0.6, 0.6 + gz * 0.05)));
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
    if (strength > 0.2 && VH.sfx) VH.sfx.tock(b.gz, strength); // musical stacking
    // Compression ripple down the stack below
    W.blocks.forEach(o => {
      if (o !== b && o.gx === b.gx && o.gy === b.gy && o.gz < b.gz && !o.blasting) {
        const depth = b.gz - o.gz;
        o.squash = Math.max(o.squash, 0.10 * strength * Math.max(0, 1 - depth * 0.25));
      }
    });
  }

  W.updateBlocks = (dt) => {
    // Platform dip spring
    W.dipVel += (-120 * W.dip - 10 * W.dipVel) * dt;
    W.dip = Math.min(0.2, W.dip + W.dipVel * dt);

    W.blocks.forEach(b => {
      // Squash spring (runs for every block)
      if (b.squash !== 0 || b.squashVel !== 0) {
        b.squashVel += (-SQUASH_K * b.squash - SQUASH_D * b.squashVel) * dt;
        b.squash += b.squashVel * dt;
        if (Math.abs(b.squash) < 0.002 && Math.abs(b.squashVel) < 0.02) {
          b.squash = 0; b.squashVel = 0;
        }
      }
      // Hover lift eases toward its target
      const liftTarget = (b === W.hoveredBlock) ? 0.12 : 0;
      b.lift += (liftTarget - b.lift) * Math.min(1, 12 * dt);

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

  // opts: sxy/sz   squash scale (width / height)
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
    const sz = opts.sz || 1;
    // Squash widens the footprint; keep the block centered on its cell
    const ref = E.toScreen(gx + (1 - sxy) / 2, gy + (1 - sxy) / 2, gz);
    const fv = E.fv;
    const ux = { x: fv.ux.x * sxy, y: fv.ux.y * sxy };
    const uy = { x: fv.uy.x * sxy, y: fv.uy.y * sxy };
    const uz = { x: fv.uz.x * sz, y: fv.uz.y * sz };
    const { xVisible, yVisible } = fv;
    const li = E.li;
    const opp = { x: ref.x + ux.x + uy.x + uz.x, y: ref.y + ux.y + uy.y + uz.y };
    const styled = opts.styled;

    const facePath = (a, b, c, d) => {
      ctx.beginPath();
      ctx.moveTo(a.x, a.y); ctx.lineTo(b.x, b.y);
      ctx.lineTo(c.x, c.y); ctx.lineTo(d.x, d.y);
      ctx.closePath();
    };
    const P = (dx, dy) => ({ x: ref.x + dx, y: ref.y + dy });
    const outline = () => {
      if (!styled) return;
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

    // Contact shading: dark strip along the bottom of both side faces
    if (opts.contact) {
      ctx.globalAlpha = opacity * 0.10;
      ctx.fillStyle = '#000';
      const strip = 0.22; // fraction of face height
      const s0 = xFace[0], s3 = xFace[3];
      ctx.beginPath();
      ctx.moveTo(s0.x, s0.y);
      ctx.lineTo(s0.x + uz.x * strip, s0.y + uz.y * strip);
      ctx.lineTo(s3.x + uz.x * strip, s3.y + uz.y * strip);
      ctx.lineTo(s3.x, s3.y);
      ctx.closePath(); ctx.fill();
      const t0 = yFace[0], t3 = yFace[3];
      ctx.beginPath();
      ctx.moveTo(t0.x, t0.y);
      ctx.lineTo(t0.x + uz.x * strip, t0.y + uz.y * strip);
      ctx.lineTo(t3.x + uz.x * strip, t3.y + uz.y * strip);
      ctx.lineTo(t3.x, t3.y);
      ctx.closePath(); ctx.fill();
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
      ctx.globalAlpha = opacity * env * (0.50 + pulse * 0.50);
      ctx.strokeStyle = '#ffd968';
      ctx.lineWidth = Math.max(1.5, 2 * E.SCALE);
      facePath(...topFace); ctx.stroke();
      facePath(...xFace); ctx.stroke();
      facePath(...yFace); ctx.stroke();
    }

    // Moonlit rim: highlight the two top edges nearest the moon
    // (position hoisted to E.li — one moon, and no per-block recompute)
    if (styled) {
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

  // Translucent white cube used as the placement preview while dragging
  W.drawGhostBlock = (gx, gy, gz) => {
    const ctx = E.ctx;
    const ref = E.toScreen(gx, gy, gz);
    const { ux, uy, uz, xVisible, yVisible } = E.fv;
    const opp = { x: ref.x + ux.x + uy.x + uz.x, y: ref.y + ux.y + uy.y + uz.y };
    ctx.globalAlpha = 0.25;
    ctx.fillStyle = '#ffffff';

    if (xVisible) {
      ctx.beginPath();
      ctx.moveTo(ref.x + ux.x, ref.y + ux.y);
      ctx.lineTo(ref.x + ux.x + uz.x, ref.y + ux.y + uz.y);
      ctx.lineTo(opp.x, opp.y);
      ctx.lineTo(ref.x + ux.x + uy.x, ref.y + ux.y + uy.y);
      ctx.closePath(); ctx.fill();
    } else {
      ctx.beginPath();
      ctx.moveTo(ref.x, ref.y);
      ctx.lineTo(ref.x + uz.x, ref.y + uz.y);
      ctx.lineTo(ref.x + uy.x + uz.x, ref.y + uy.y + uz.y);
      ctx.lineTo(ref.x + uy.x, ref.y + uy.y);
      ctx.closePath(); ctx.fill();
    }

    if (yVisible) {
      ctx.beginPath();
      ctx.moveTo(ref.x + uy.x, ref.y + uy.y);
      ctx.lineTo(ref.x + uy.x + uz.x, ref.y + uy.y + uz.y);
      ctx.lineTo(opp.x, opp.y);
      ctx.lineTo(ref.x + ux.x + uy.x, ref.y + ux.y + uy.y);
      ctx.closePath(); ctx.fill();
    } else {
      ctx.beginPath();
      ctx.moveTo(ref.x, ref.y);
      ctx.lineTo(ref.x + uz.x, ref.y + uz.y);
      ctx.lineTo(ref.x + ux.x + uz.x, ref.y + ux.y + uz.y);
      ctx.lineTo(ref.x + ux.x, ref.y + ux.y);
      ctx.closePath(); ctx.fill();
    }

    ctx.beginPath();
    ctx.moveTo(ref.x + uz.x, ref.y + uz.y);
    ctx.lineTo(ref.x + ux.x + uz.x, ref.y + ux.y + uz.y);
    ctx.lineTo(opp.x, opp.y);
    ctx.lineTo(ref.x + uy.x + uz.x, ref.y + uy.y + uz.y);
    ctx.closePath(); ctx.fill();

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
