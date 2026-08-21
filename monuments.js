/* ============================================================
   monuments.js — the game: build a combination, discover a monument
   Recipes are voxel patterns matched rotation-invariantly around
   every player placement. A match consumes the blocks in a ceremony
   and raises a detailed monument model in their place.
   Load order: after world.js/fx.js/sfx.js, before game.js.
   ============================================================ */
(() => {
  'use strict';
  const VH = window.VH;
  const E = VH.engine;
  const W = VH.world;

  const M = (VH.monuments = {});

  // ── Recipes ─────────────────────────────────────────────────
  // cells: [dx, dy, dz, req] — req '*' = any block, or a specific color key.
  // empty: cells that must contain NOTHING (no block, no monument).
  // sameColor: all matched blocks must share one color.
  // Model entries: [dx, dy, dz, sxy, sz, colorKey, glow?] — fractional
  // dx/dy shift the cube center off-cell; fractional dz stacks partial cubes.
  const RECIPES = [
    {
      id: 'pyramid',
      name: 'The Great Pyramid',
      hint: 'a full square, crowned at its center',
      cells: [
        [0, 0, 0, '*'], [1, 0, 0, '*'], [2, 0, 0, '*'],
        [0, 1, 0, '*'], [1, 1, 0, '*'], [2, 1, 0, '*'],
        [0, 2, 0, '*'], [1, 2, 0, '*'], [2, 2, 0, '*'],
        [1, 1, 1, '*'],
      ],
      model: [
        [1, 1, 0,    2.96, 0.5,  'stone'],
        [1, 1, 0.5,  2.2,  0.45, 'stone'],
        [1, 1, 0.95, 1.5,  0.42, 'stone'],
        [1, 1, 1.37, 0.9,  0.4,  'stone'],
        [1, 1, 1.77, 0.45, 0.35, 'gold', true],
      ],
    },
    {
      id: 'torii',
      name: 'The Torii Gate',
      hint: 'a red wall, three by three',
      cells: [
        [0, 0, 0, 'red'], [1, 0, 0, 'red'], [2, 0, 0, 'red'],
        [0, 0, 1, 'red'], [1, 0, 1, 'red'], [2, 0, 1, 'red'],
        [0, 0, 2, 'red'], [1, 0, 2, 'red'], [2, 0, 2, 'red'],
      ],
      // The transform CARVES the passage the player couldn't build
      model: [
        [0, 0, 0,    0.42, 2.1, 'lightRed'],
        [2, 0, 0,    0.42, 2.1, 'lightRed'],
        [1, 0, 2.1,  3.1,  0.3, 'lightRed'],
        [1, 0, 2.4,  3.4,  0.32, 'lightRed'],
        [1, 0, 1.55, 0.4,  0.55, 'lightRed'],
        [1, 0, 2.72, 0.9,  0.14, 'stoneDark'],
      ],
    },
    {
      id: 'stonehenge',
      name: 'Stonehenge',
      hint: 'four ancient stones, standing apart',
      cells: [
        [0, 0, 0, '*'], [0, 0, 1, '*'],
        [2, 0, 0, '*'], [2, 0, 1, '*'],
        [0, 2, 0, '*'], [0, 2, 1, '*'],
        [2, 2, 0, '*'], [2, 2, 1, '*'],
      ],
      empty: [[1, 1, 0], [1, 0, 0], [0, 1, 0], [2, 1, 0], [1, 2, 0]],
      model: [
        [0, 0, 0, 0.6, 1.7, 'stoneDark'],
        [2, 0, 0, 0.6, 1.7, 'stoneDark'],
        [0, 2, 0, 0.6, 1.7, 'stoneDark'],
        [2, 2, 0, 0.6, 1.7, 'stoneDark'],
        [1, 0, 1.7, 2.4, 0.35, 'stoneDark'],
        [0, 1, 1.7, 2.4, 0.35, 'stoneDark'],
        [1, 1, 0, 0.8, 0.3, 'stone'], // the fallen stone
      ],
    },
    {
      id: 'colosseum',
      name: 'The Colosseum',
      hint: 'a ring with an empty heart',
      cells: [
        [0, 0, 0, '*'], [1, 0, 0, '*'], [2, 0, 0, '*'],
        [0, 1, 0, '*'],                 [2, 1, 0, '*'],
        [0, 2, 0, '*'], [1, 2, 0, '*'], [2, 2, 0, '*'],
      ],
      empty: [[1, 1, 0]],
      model: [
        [0, 0, 0, 0.9, 1.1, 'stone'], [1, 0, 0, 0.9, 0.75, 'stoneDark'],
        [2, 0, 0, 0.9, 1.1, 'stone'], [2, 1, 0, 0.9, 0.75, 'stoneDark'],
        [2, 2, 0, 0.9, 1.1, 'stone'], [1, 2, 0, 0.9, 0.75, 'stoneDark'],
        [0, 2, 0, 0.9, 1.1, 'stone'], [0, 1, 0, 0.9, 0.75, 'stoneDark'],
        [1, 1, 0, 1.0, 0.12, 'gold'], // the arena floor
      ],
    },
    {
      id: 'gardens',
      name: 'The Hanging Gardens',
      hint: 'life planted on a terrace',
      cells: [
        [0, 0, 0, '*'], [1, 0, 0, '*'], [0, 1, 0, '*'], [1, 1, 0, '*'],
        [0, 0, 1, 'grass'], [1, 1, 1, 'grass'],
      ],
      model: [
        [0, 0, 0, 0.95, 0.9, 'stone'], [1, 0, 0, 0.95, 0.9, 'stoneDark'],
        [0, 1, 0, 0.95, 0.9, 'stoneDark'], [1, 1, 0, 0.95, 0.9, 'stone'],
        [0, 0, 0.9, 0.7, 0.5, 'grass'], [1, 1, 0.9, 0.7, 0.5, 'grass'],
        [1, 0, 0.9, 0.45, 0.3, 'grass'], [0, 1, 0.9, 0.45, 0.3, 'grass'],
        [0, 0, 1.4, 0.4, 0.35, 'grass'], [1, 1, 1.4, 0.4, 0.35, 'grass'],
      ],
    },
    {
      id: 'arc',
      name: 'The Arc de Triomphe',
      hint: 'a tall doorway for a returning army',
      cells: [
        [0, 0, 0, '*'], [1, 0, 0, '*'],
        [0, 0, 1, '*'], [1, 0, 1, '*'],
        [0, 0, 2, '*'], [1, 0, 2, '*'],
      ],
      plainOnly: true,
      model: [
        [0, 0, 0, 0.55, 1.9, 'stone'],
        [1, 0, 0, 0.55, 1.9, 'stone'],
        [0.5, 0, 1.9, 1.9, 0.6, 'stone'],
        [0.5, 0, 2.5, 1.4, 0.25, 'stoneDark'],
      ],
    },
    {
      id: 'temple',
      name: 'The Temple',
      hint: 'a wide white wall, gleaming',
      cells: [
        [0, 0, 0, 'white'], [1, 0, 0, 'white'], [2, 0, 0, 'white'],
        [0, 0, 1, 'white'], [1, 0, 1, 'white'], [2, 0, 1, 'white'],
      ],
      model: [
        [1, 0, 0, 3.0, 0.25, 'stone'],
        [0, 0, 0.25, 0.32, 1.15, 'lightWhite'],
        [0.5, 0, 0.25, 0.32, 1.15, 'lightWhite'],
        [1, 0, 0.25, 0.32, 1.15, 'lightWhite'],
        [1.5, 0, 0.25, 0.32, 1.15, 'lightWhite'],
        [2, 0, 0.25, 0.32, 1.15, 'lightWhite'],
        [1, 0, 1.4, 3.1, 0.3, 'stone'],
        [1, 0, 1.7, 2.2, 0.32, 'lightWhite'],
        [1, 0, 2.02, 1.1, 0.25, 'stone'],
      ],
    },
    {
      id: 'eiffel',
      name: 'The Eiffel Tower',
      hint: 'five panes of glass, straight up',
      cells: [
        [0, 0, 0, 'glass'], [0, 0, 1, 'glass'], [0, 0, 2, 'glass'],
        [0, 0, 3, 'glass'], [0, 0, 4, 'glass'],
      ],
      model: [
        [-0.28, -0.28, 0, 0.3, 0.9, 'stoneDark'],
        [0.28, -0.28, 0, 0.3, 0.9, 'stoneDark'],
        [-0.28, 0.28, 0, 0.3, 0.9, 'stoneDark'],
        [0.28, 0.28, 0, 0.3, 0.9, 'stoneDark'],
        [0, 0, 0.9, 1.15, 0.22, 'stoneDark'],
        [0, 0, 1.12, 0.62, 1.1, 'glass'],
        [0, 0, 2.22, 0.72, 0.18, 'stoneDark'],
        [0, 0, 2.4, 0.4, 1.2, 'glass'],
        [0, 0, 3.6, 0.24, 1.0, 'stoneDark'],
        [0, 0, 4.6, 0.1, 0.5, 'gold', true],
      ],
    },
    {
      id: 'crystal',
      name: 'The Crystal Palace',
      hint: 'six panes laid out like a garden bed',
      cells: [
        [0, 0, 0, 'glass'], [1, 0, 0, 'glass'], [2, 0, 0, 'glass'],
        [0, 1, 0, 'glass'], [1, 1, 0, 'glass'], [2, 1, 0, 'glass'],
      ],
      model: [
        [1, 0.5, 0, 3.0, 0.18, 'stone'],
        [0, 0, 0.18, 0.85, 0.9, 'glass'], [1, 0, 0.18, 0.85, 0.9, 'glass'], [2, 0, 0.18, 0.85, 0.9, 'glass'],
        [0, 1, 0.18, 0.85, 0.9, 'glass'], [1, 1, 0.18, 0.85, 0.9, 'glass'], [2, 1, 0.18, 0.85, 0.9, 'glass'],
        [1, 0.5, 1.08, 2.3, 0.5, 'glass'],
        [1, 0.5, 1.58, 1.2, 0.4, 'glass'],
        [1, 0.5, 1.98, 0.3, 0.3, 'gold', true],
      ],
    },
    {
      id: 'doghouse',
      name: 'The Doghouse',
      hint: "somebody's dream home",
      cells: [
        [0, 0, 0, 'orange'], [1, 0, 0, 'orange'],
        [0, 0, 1, 'red'], [1, 0, 1, 'red'],
      ],
      model: [
        [0.5, 0, 0, 1.9, 0.9, 'orange'],
        [0.5, 0, 0.9, 2.2, 0.45, 'lightRed'],
        [0.5, 0, 1.35, 1.3, 0.35, 'lightRed'],
        // The door genuinely protrudes past the body's front face (dy 0.72,
        // body ends at 1.45, door reaches 1.495). It used to sit INSIDE the
        // body and was only visible because the old broken sort drew it
        // last; a correct sort hides buried geometry, so it had to move out.
        [0.5, 0.72, 0.12, 0.55, 0.55, 'stoneDark'], // the door
      ],
    },
    {
      id: 'lighthouse',
      name: 'The Lighthouse',
      hint: 'a tall friend for ships in the dark',
      cells: [
        [0, 0, 0, '*'], [0, 0, 1, '*'], [0, 0, 2, '*'],
        [0, 0, 3, 'lamp'],
      ],
      model: [
        [0, 0, 0,    1.0,  0.3,  'stoneDark'],
        [0, 0, 0.3,  0.78, 0.9,  'lightWhite'],
        [0, 0, 1.2,  0.7,  0.9,  'lightRed'],
        [0, 0, 2.1,  0.62, 0.9,  'lightWhite'],
        [0, 0, 3.0,  0.54, 0.5,  'lightRed'],
        [0, 0, 3.5,  0.68, 0.14, 'stoneDark'],
        [0, 0, 3.64, 0.46, 0.5,  'lamp', true],
        [0, 0, 4.14, 0.52, 0.22, 'lightRed'],
      ],
    },
    {
      id: 'obelisk',
      name: 'The Obelisk',
      hint: 'four of a kind, reaching up',
      sameColor: true,
      notColors: ['glass', 'lamp'], // a glass column is on its way to Paris
      cells: [
        [0, 0, 0, '*'], [0, 0, 1, '*'], [0, 0, 2, '*'], [0, 0, 3, '*'],
      ],
      model: [
        [0, 0, 0,    1.0,  0.35, 'stoneDark'],
        [0, 0, 0.35, 0.8,  0.28, 'stone'],
        [0, 0, 0.63, 0.56, 1.15, 'stone'],
        [0, 0, 1.78, 0.5,  1.15, 'stone'],
        [0, 0, 2.93, 0.44, 1.0,  'stone'],
        [0, 0, 3.93, 0.4,  0.45, 'gold', true],
      ],
    },
    {
      id: 'greatwall',
      name: 'The Great Wall',
      hint: 'five of anything, standing shoulder to shoulder',
      cells: [
        [0, 0, 0, '*'], [1, 0, 0, '*'], [2, 0, 0, '*'], [3, 0, 0, '*'], [4, 0, 0, '*'],
      ],
      model: [
        // End towers
        [0, 0, 0, 0.95, 1.3, 'stoneDark'],
        [0, 0, 1.3, 1.0, 0.18, 'stone'],
        [4, 0, 0, 0.95, 1.3, 'stoneDark'],
        [4, 0, 1.3, 1.0, 0.18, 'stone'],
        // Wall run with crenellations
        [1, 0, 0, 0.9, 1.0, 'stone'],
        [2, 0, 0, 0.9, 1.0, 'stone'],
        [3, 0, 0, 0.9, 1.0, 'stone'],
        [0.75, 0, 1.0, 0.26, 0.28, 'stoneDark'],
        [1.25, 0, 1.0, 0.26, 0.28, 'stoneDark'],
        [1.75, 0, 1.0, 0.26, 0.28, 'stoneDark'],
        [2.25, 0, 1.0, 0.26, 0.28, 'stoneDark'],
        [2.75, 0, 1.0, 0.26, 0.28, 'stoneDark'],
        [3.25, 0, 1.0, 0.26, 0.28, 'stoneDark'],
      ],
    },
  ];
  // Bigger recipes first so a large pattern isn't stolen by a smaller one
  RECIPES.sort((a, b) => b.cells.length - a.cells.length);
  M.RECIPES = RECIPES;

  // ── Rotation (about z, 4 orientations) ──────────────────────
  function rot(dx, dy, k) {
    switch (k & 3) {
      case 0: return [dx, dy];
      case 1: return [dy, -dx];
      case 2: return [-dx, -dy];
      default: return [-dy, dx];
    }
  }

  // ── Occlusion-correct piece ordering ────────────────────────
  // The old sort keyed each piece by its BASE CELL, ignoring sxy/sz — so a
  // 1.9-wide lintel sorted as if it were a post at its center, and pillars
  // painted over the arch. The view ray is (1,1,1) in camera space (u,v,z):
  // box A can only hide box B if A is greater on ALL THREE axes. If NEITHER
  // can hide the other they never share a pixel → no ordering constraint,
  // which is what handles both pyramid stacks (only height separates) and
  // wide lintels (only footprint separates) without cycles.
  // pieces: [{gx,gy,gz,sxy,sz}, ...]; returns indices back-to-front.
  function occlusionOrder(pieces, cosA, sinA) {
    if (cosA === undefined) { cosA = E.cosA; sinA = E.sinA; }
    const n = pieces.length;
    const EPS = 1e-6;
    const ext = pieces.map(p => E.camExtents(E.pieceAABB(p.gx, p.gy, p.gz, p.sxy, p.sz), cosA, sinA));
    const key = pieces.map(p => p.gx * (cosA + sinA) + p.gy * (cosA - sinA) + p.gz * 0.01);
    // a can never draw in front of (hide) b?
    const cannot = (a, b) =>
      ext[a].u1 <= ext[b].u0 + EPS || ext[a].v1 <= ext[b].v0 + EPS || ext[a].z1 <= ext[b].z0 + EPS;
    const after = Array.from({ length: n }, () => []); // after[a] = pieces a must precede
    const indeg = new Array(n).fill(0);
    for (let a = 0; a < n; a++) {
      for (let b = a + 1; b < n; b++) {
        const ab = cannot(a, b), ba = cannot(b, a);
        if (ab && !ba) { after[a].push(b); indeg[b]++; }      // a is behind b
        else if (ba && !ab) { after[b].push(a); indeg[a]++; } // b is behind a
        // both → they never overlap on screen; order is irrelevant
      }
    }
    // Kahn's; pop smallest depthKey among ready for determinism. A genuine
    // cycle (shouldn't happen with these models) degrades locally: emit the
    // smallest-key remaining node and keep going.
    const order = [], ready = [], used = new Array(n).fill(false);
    for (let i = 0; i < n; i++) if (indeg[i] === 0) ready.push(i);
    while (order.length < n) {
      let pick = -1;
      if (ready.length) {
        let bi = 0;
        for (let i = 1; i < ready.length; i++) if (key[ready[i]] < key[ready[bi]]) bi = i;
        pick = ready.splice(bi, 1)[0];
      } else {
        for (let i = 0; i < n; i++) if (!used[i] && (pick === -1 || key[i] < key[pick])) pick = i;
      }
      used[pick] = true;
      order.push(pick);
      after[pick].forEach(j => { if (!used[j] && --indeg[j] === 0) ready.push(j); });
    }
    return order;
  }

  // Memoised per-monument order for the current camera angle. Memo keys on
  // the EXACT angle (not the quarter-turn snap) so the order tracks smoothly
  // through the rotation tween instead of popping at the midpoint.
  M.orderedModel = (mon) => {
    if (mon._ordCos === E.cosA && mon._ordSin === E.sinA && mon._ord) return mon._ord;
    mon._ord = occlusionOrder(mon.model).map(i => mon.model[i]);
    mon._ordCos = E.cosA;
    mon._ordSin = E.sinA;
    return mon._ord;
  };

  // ── Matcher ─────────────────────────────────────────────────
  // The placed block may be ANY cell of the pattern, in any of the 4
  // orientations. Returns { recipe, origin, k, blocks } or null.
  function findMatchAt(px, py, pz) {
    for (const r of RECIPES) {
      for (let k = 0; k < 4; k++) {
        for (const anchor of r.cells) {
          const [ax, ay] = rot(anchor[0], anchor[1], k);
          const ox = px - ax, oy = py - ay, oz = pz - anchor[2];
          if (oz < 0) continue;
          const blocks = [];
          let ok = true;
          for (const c of r.cells) {
            const [cx, cy] = rot(c[0], c[1], k);
            const b = W.blockAt(ox + cx, oy + cy, oz + c[2]);
            if (!b || b.transforming) { ok = false; break; }
            if (c[3] !== '*' && b.color !== c[3]) { ok = false; break; }
            blocks.push(b);
          }
          if (!ok) continue;
          if (r.sameColor && !blocks.every(b => b.color === blocks[0].color)) continue;
          if (r.notColors && blocks.some(b => r.notColors.includes(b.color))) continue;
          if (r.plainOnly && !blocks.every(b => W.BLOCK_COLORS.includes(b.color))) continue;
          if (r.empty) {
            for (const c of r.empty) {
              const [cx, cy] = rot(c[0], c[1], k);
              if (W.at(ox + cx, oy + cy, oz + c[2])) { ok = false; break; }
            }
            if (!ok) continue;
          }
          return { recipe: r, ox, oy, oz, k, blocks };
        }
      }
    }
    return null;
  }

  // ── Discovery state (persistence arrives with the codex) ────
  M.discovered = new Set();
  M.findMatchAt = findMatchAt; // exposed for dev probing; harmless to keep

  // ── Ceremony ────────────────────────────────────────────────
  // gather (0.7s): consumed blocks lift, spin, glow, drift to center
  // flash  (at 0.7): burst of light, blocks vanish, monument starts rising
  // rise   (0.7→1.8): model cubes pop in bottom-up with tiny overshoots
  const ceremonies = [];

  // Cells the DRAWN model fills but the recipe never claimed. sxy widens a
  // piece in BOTH ground axes, so a "lintel" bulges into neighbouring
  // columns; spires poke a cell above their recipe. These cells must count
  // as solid (occupancy + stacking + the leftover sweep) or blocks end up
  // inside the monument. Derived, never persisted — stays correct if
  // E.SOLID_EPS is ever retuned.
  function blockedCellsFor(model, cells) {
    const claimed = new Set(cells.map(c => c.gx + ',' + c.gy + ',' + c.gz));
    const out = new Map();
    model.forEach(p => {
      const box = E.pieceAABB(p.gx, p.gy, p.gz, p.sxy, p.sz);
      for (let gx = Math.floor(box.x0); gx < Math.ceil(box.x1); gx++) {
        for (let gy = Math.floor(box.y0); gy < Math.ceil(box.y1); gy++) {
          for (let gz = Math.max(0, Math.floor(box.z0)); gz < Math.ceil(box.z1); gz++) {
            const key = gx + ',' + gy + ',' + gz;
            if (claimed.has(key) || out.has(key) || !W.isOnPlatform(gx, gy)) continue;
            if (E.aabbOverlap(E.cellAABB(gx, gy, gz), box, E.SOLID_EPS)) {
              out.set(key, { gx, gy, gz });
            }
          }
        }
      }
    });
    return [...out.values()];
  }
  M.blockedCellsFor = blockedCellsFor; // world.js re-derives on load

  // Build a monument in world space and add it to the world. The ceremony
  // passes pending:true (the rise animation reveals it); the dev gallery
  // instantiates fully-revealed monuments directly.
  M.instantiate = (recipe, ox, oy, oz, k, opts = {}) => {
    const pending = !!opts.pending;
    const maxDz = Math.max(...recipe.model.map(e => e[2] + e[4]));
    const model = recipe.model.map(e => {
      const [rx, ry] = rot(e[0], e[1], k);
      return {
        gx: ox + rx, gy: oy + ry, gz: oz + e[2],
        sxy: e[3], sz: e[4], color: e[5], glow: !!e[6],
        appearAt: 0.7 + (e[2] / maxDz) * 0.75, // bottom-up pop-in
        pop: pending ? 0 : 1,
      };
    });
    const monument = {
      id: recipe.id,
      name: recipe.name,
      cells: recipe.cells.map(c => {
        const [rx, ry] = rot(c[0], c[1], k);
        return { gx: ox + rx, gy: oy + ry, gz: oz + c[2] };
      }),
      model,
      pending,
    };
    monument.blocked = blockedCellsFor(model, monument.cells);
    W.monuments.push(monument);
    W.markDirty();
    return monument;
  };

  function startCeremony(match) {
    const { recipe, ox, oy, oz, k, blocks } = match;
    // Take the blocks out of the world; the ceremony draws its own copies
    blocks.forEach(b => { b.transforming = true; W.removeBlock(b); });

    // World-space center of the pattern (for drift + effects)
    let cx = 0, cy = 0, cz = 0;
    recipe.cells.forEach(c => {
      const [rx, ry] = rot(c[0], c[1], k);
      cx += ox + rx + 0.5; cy += oy + ry + 0.5; cz += oz + c[2] + 0.5;
    });
    cx /= recipe.cells.length; cy /= recipe.cells.length; cz /= recipe.cells.length;

    // The monument exists LOGICALLY from this moment (occupies cells, is
    // saved, survives a mid-ceremony reload); the ceremony is only theater.
    // pending=true keeps it invisible until the rise animation reveals it.
    const monument = M.instantiate(recipe, ox, oy, oz, k, { pending: true });
    M.discovered.add(recipe.id);
    W.warmCenter = null; // the hint resolved — stop the ground pool
    W.save();
    if (M.onDiscovered) M.onDiscovered(recipe);

    // Clearance for the gather: the tallest thing standing in (or next to)
    // the gather region. Floaters rise ABOVE it before they drift, so the
    // path can no longer sweep through a neighbouring tower. Scanned after
    // instantiate, so the new monument's own volume is cleared too.
    let clearTop = 0;
    {
      const xs = blocks.map(b => b.gx), ys = blocks.map(b => b.gy);
      const x0 = Math.min(...xs) - 1, x1 = Math.max(...xs) + 1;
      const y0 = Math.min(...ys) - 1, y1 = Math.max(...ys) + 1;
      for (let gx = x0; gx <= x1; gx++) {
        for (let gy = y0; gy <= y1; gy++) {
          for (let z = W.MAX_STACK; z >= 0; z--) {
            if (W.at(gx, gy, z)) { clearTop = Math.max(clearTop, z + 1); break; }
          }
        }
      }
    }

    ceremonies.push({
      recipe, t: 0, cx, cy, cz,
      floaters: blocks.map(b => ({
        gx: b.gx, gy: b.gy, gz: b.gz, color: b.color,
        rise: Math.max(1.1, clearTop + 0.4 - b.gz),
        spin: 0, spinVel: 2 + Math.random() * 3,
      })),
      monument,
      flashed: false,
    });

    // Falling blocks above the pattern re-aim: the monument's volume is
    // solid from this instant, and nothing may land inside it.
    W.retargetFalling();
  }

  // "Only broken ones": (a) blocks genuinely inside the monument's claimed
  // or drawn volume, (b) chains left standing on the consumed pattern.
  // This is POLICY, not a physics gap (locked design: wreckage goes up in
  // fireworks on the flash beat) — W.resettle() handles ordinary lost
  // support everywhere else. A merely-adjacent block fails both tests and
  // ALWAYS survives.
  function collectDoomed(monument) {
    const solid = new Set();
    monument.cells.forEach(c => solid.add(c.gx + ',' + c.gy + ',' + c.gz));
    (monument.blocked || []).forEach(c => solid.add(c.gx + ',' + c.gy + ',' + c.gz));

    const victims = new Set();
    W.blocks.forEach(b => {
      if (W.isLive(b) && solid.has(b.gx + ',' + b.gy + ',' + b.gz)) victims.add(b);
    });

    // Support cascade: a block needs the ground, a surviving block, or a
    // PRE-EXISTING monument directly beneath it. The NEW monument never
    // counts — a chain of blocks standing on the transformed pattern is
    // wreckage all the way up (they'd hang over the model's sloped/stepped
    // surface), so the whole tower goes up in fireworks. Blocks placed on
    // an OLD monument deliberately still survive unrelated ceremonies.
    const liveAt = new Map();
    W.blocks.forEach(b => { if (W.isLive(b)) liveAt.set(b.gx + ',' + b.gy + ',' + b.gz, b); });
    let changed = true;
    while (changed) {
      changed = false;
      W.blocks.forEach(b => {
        if (!W.isLive(b) || victims.has(b) || b.gz === 0) return;
        const below = liveAt.get(b.gx + ',' + b.gy + ',' + (b.gz - 1));
        const supported = (below && !victims.has(below)) ||
          (() => {
            const v = W.at(b.gx, b.gy, b.gz - 1);
            return v && v.color === undefined && v !== monument; // an older monument
          })();
        if (!supported) { victims.add(b); changed = true; }
      });
    }
    return [...victims];
  }

  M.update = (dt) => {
    for (let i = ceremonies.length - 1; i >= 0; i--) {
      const c = ceremonies[i];
      c.t += dt;
      c.floaters.forEach(f => { f.spin += f.spinVel * dt; }); // state here, drawing in pushEntries

      if (!c.flashed && c.t >= 0.7) {
        c.flashed = true;
        if (!E.reducedMotion) { E.kickShake(4); W.kickDip(1.5); }
        if (VH.fx) {
          VH.fx.spawnDust(Math.round(c.cx - 0.5), Math.round(c.cy - 0.5), Math.max(0, Math.round(c.cz - 0.5)), 14);
          // The bloom (drawn by fx.js flashes — shared with firework detonations)
          VH.fx.spawnFlash(c.cx, c.cy, c.cz, { dur: 0.45, r0: 2, r1: 7, peak: 0.85 });
        }
        if (VH.sfx) VH.sfx.fanfare();
        showCard(c.recipe);

        // Broken leftovers go up in fireworks on the same beat, so the
        // flash covers the launch and it reads as one event. Gentler
        // velocities than Clear — this must not upstage the ceremony.
        const doomed = collectDoomed(c.monument);
        if (doomed.length) {
          W.launchBlocks(doomed, { cx: c.cx - 0.5, cy: c.cy - 0.5, force: [1.5, 3], up: [24, 34] });
          W.markDirty();
          W.save(); // AFTER launch: save() filters launching blocks out of the payload
        }
        W.resettle(); // physics owns whatever the sweep's policy spared
      }

      // Pop the model cubes in
      c.monument.model.forEach(m => {
        if (c.t > m.appearAt) m.pop = Math.min(1, m.pop + dt / 0.16);
      });

      if (c.t >= 2.0) {
        // Theater over: reveal the (already-real) monument permanently
        c.monument.pending = false;
        c.monument.model.forEach(m => { m.pop = 1; });
        ceremonies.splice(i, 1);
      }
    }
  };

  // A reset pressed mid-ceremony: finish the theater instantly so an
  // orphaned ceremony doesn't keep drawing a monument that's about to
  // become firework debris.
  M.clearCeremonies = () => {
    ceremonies.forEach(c => {
      c.monument.pending = false;
      c.monument.model.forEach(m => { m.pop = 1; });
    });
    ceremonies.length = 0;
  };

  // easeOutBack for the pop-in
  function backOut(t) {
    const s = 1.5, u = t - 1;
    return u * u * ((s + 1) * u + s) + 1;
  }

  // Contribute depth-sorted draw entries for permanent monuments.
  // RANK PERMUTATION: the monument contributes the same multiset of depth
  // keys as before (so player blocks keep their position relative to the
  // monument as a whole), but the i-th slot is filled by the i-th piece in
  // occlusion order — fixing which piece draws over which. For monuments
  // the old sort already handled (pyramid, obelisk...), this is the
  // identity and the render is pixel-identical.
  M.pushEntries = (entries, dip) => {
    W.monuments.forEach(mon => {
      if (mon.pending) return; // still mid-ceremony; its ceremony contributes below
      const keys = mon.model.map(m => E.depthKey(m.gx, m.gy, m.gz)).sort((a, b) => a - b);
      const op = mon._dragging ? 0.45 : 1; // dimmed while being carried
      M.orderedModel(mon).forEach((m, i) => {
        entries.push({
          key: keys[i] + i * 1e-6, // epsilon keeps the order through duplicate keys
          draw: () => W.drawBlock(m.gx, m.gy, m.gz - dip, m.color, op,
            { styled: true, sxy: m.sxy, sz: m.sz }),
        });
      });
    });

    // Ceremony theater joins the SAME depth-sorted pass as everything
    // else. It used to paint on top of the world after the sort — one of
    // the two root causes of "blocks glitch through each other": correct
    // occlusion was impossible by construction.
    ceremonies.forEach(c => {
      if (c.t < 0.75) {
        // Gathering: consumed blocks lift, spin, drift, glow. The RISE
        // leads the drift (finishes ~60% in), so floaters are above the
        // clearance height before they travel sideways.
        const p = Math.min(1, c.t / 0.7);
        const ease = 1 - Math.pow(1 - p, 2);
        const riseEase = 1 - Math.pow(1 - Math.min(1, p * 1.6), 2);
        c.floaters.forEach(f => {
          const gx = f.gx + (c.cx - 0.5 - f.gx) * ease * 0.25;
          const gy = f.gy + (c.cy - 0.5 - f.gy) * ease * 0.25;
          const gz = f.gz + riseEase * (E.reducedMotion ? 0.15 : f.rise);
          entries.push({
            key: E.depthKey(gx, gy, gz),
            draw: () => drawFloater(f, gx, gy, gz - dip, ease),
          });
        });
      }

      // (The flash is spawned at the c.flashed moment and drawn by
      // fx.js's shared flash system after the sorted pass.)

      // The rising model — same key structure as the permanent pass, so
      // nothing visually snaps when the ceremony ends and pending flips
      if (c.t >= 0.7) {
        const mon = c.monument;
        const keys = mon.model.map(m => E.depthKey(m.gx, m.gy, m.gz)).sort((a, b) => a - b);
        M.orderedModel(mon).forEach((m, i) => {
          if (m.pop <= 0) return;
          entries.push({
            key: keys[i] + i * 1e-6,
            draw: () => {
              const pop = backOut(m.pop);
              W.drawBlock(m.gx, m.gy, m.gz - dip, m.color, Math.min(1, m.pop * 2),
                { styled: true, sxy: m.sxy * pop, sz: m.sz * pop });
            },
          });
        });
      }
    });
  };

  function drawFloater(f, gx, gy, gz, ease) {
    const ctx = E.ctx;
    const center = E.toScreen(gx + 0.5, gy + 0.5, gz + 0.5);
    ctx.save();
    ctx.translate(center.x, center.y);
    if (!E.reducedMotion) ctx.rotate(Math.sin(f.spin) * 0.35);
    ctx.translate(-center.x, -center.y);
    W.drawBlock(gx, gy, gz, f.color, 1, { styled: true });
    // Glow overlay strengthens as the moment approaches (additive,
    // so it reads as light on the block rather than white paint)
    ctx.globalCompositeOperation = 'lighter';
    ctx.globalAlpha = ease * 0.55;
    ctx.fillStyle = '#fff6d8';
    const t = E.TILE * E.SCALE;
    ctx.fillRect(center.x - t, center.y - t * 1.4, t * 2, t * 2.6);
    ctx.globalAlpha = 1;
    ctx.globalCompositeOperation = 'source-over';
    ctx.restore();
  }

  // Warm glow for monument cells flagged glow (lighthouse lamp, gold tip)
  // — registered as LIGHTS for the bloom pass, not painted gradients
  M.drawGlows = () => {
    const t = E.TILE * E.SCALE;
    W.monuments.forEach(mon => {
      mon.model.forEach(m => {
        if (!m.glow) return;
        const s = E.toScreen(m.gx + 0.5, m.gy + 0.5, m.gz + m.sz / 2);
        const flicker = E.reducedMotion
          ? 1 : 0.8 + 0.2 * Math.sin(VH.clock.time * 2.7 + m.gx * 3 + m.gy);
        E.addLight(s.x, s.y, t * 2.4, '255,214,120', 0.22 * flicker);
      });
    });
  };

  // ── The name card ───────────────────────────────────────────
  let cardTimer = null;
  function showCard(recipe) {
    const card = document.getElementById('monumentCard');
    if (!card) return;
    document.getElementById('mcTitle').textContent = recipe.name.toUpperCase();
    document.getElementById('mcSub').textContent = 'discovered';
    card.classList.add('show');
    clearTimeout(cardTimer);
    cardTimer = setTimeout(() => card.classList.remove('show'), 2800);
  }

  // ── Codex (the collection panel) ────────────────────────────
  // Thumbnails use a tiny standalone iso projector so silhouettes can be
  // drawn without touching the main engine's canvas state.
  function drawThumb(canvas2, recipe, found) {
    const c = canvas2.getContext('2d');
    const Wpx = canvas2.width, Hpx = canvas2.height;
    c.clearRect(0, 0, Wpx, Hpx);
    // Model bounds → scale to fit
    let minX = 9, maxX = -9, minY = 9, maxY = -9, maxZ = 0;
    recipe.model.forEach(m => {
      minX = Math.min(minX, m[0] - m[3] / 2); maxX = Math.max(maxX, m[0] + m[3] / 2);
      minY = Math.min(minY, m[1] - m[3] / 2); maxY = Math.max(maxY, m[1] + m[3] / 2);
      maxZ = Math.max(maxZ, m[2] + m[4]);
    });
    const span = Math.max(maxX - minX + 1, maxY - minY + 1, maxZ);
    const s = (Math.min(Wpx, Hpx) * 0.82) / (span * 1.6);
    const cx = Wpx / 2, cy = Hpx * 0.88;
    const P = (x, y, z) => ({ x: cx + (x - y) * s, y: cy + (x + y) * s * 0.5 - z * s * 1.25 });
    // Draw back-to-front — same occlusion sort as the world render (fixed
    // thumbnail angle = camera angle 0), cached per recipe (immutable)
    if (!recipe._thumbOrder) {
      recipe._thumbOrder = occlusionOrder(
        recipe.model.map(m => ({ gx: m[0], gy: m[1], gz: m[2], sxy: m[3], sz: m[4] })), 1, 0);
    }
    const pieces = recipe._thumbOrder.map(i => recipe.model[i]);
    pieces.forEach(m => {
      const [dx, dy, dz, sxy, sz, colorKey] = m;
      const x0 = dx - (maxX + minX) / 2, y0 = dy - (maxY + minY) / 2;
      const col = found ? (W.COLORS[colorKey] || W.COLORS.stone) : null;
      const half = sxy / 2;
      const corners = [
        P(x0 - half, y0 - half, dz), P(x0 + half, y0 - half, dz),
        P(x0 + half, y0 + half, dz), P(x0 - half, y0 + half, dz),
        P(x0 - half, y0 - half, dz + sz), P(x0 + half, y0 - half, dz + sz),
        P(x0 + half, y0 + half, dz + sz), P(x0 - half, y0 + half, dz + sz),
      ];
      const face = (idx, fill) => {
        c.fillStyle = fill;
        c.beginPath();
        c.moveTo(corners[idx[0]].x, corners[idx[0]].y);
        idx.slice(1).forEach(i => c.lineTo(corners[i].x, corners[i].y));
        c.closePath(); c.fill();
      };
      if (found) {
        face([1, 2, 6, 5], col.right);
        face([3, 2, 6, 7], col.front);
        face([4, 5, 6, 7], col.top);
      } else {
        // Silhouette: one dark shape
        face([1, 2, 6, 5], '#20242e');
        face([3, 2, 6, 7], '#20242e');
        face([4, 5, 6, 7], '#2a2f3c');
      }
    });
  }

  M.buildCodex = () => {
    const list = document.getElementById('codexList');
    const count = document.getElementById('codexCount');
    const badge = document.getElementById('codexBadge');
    if (!list) return;
    const keepScroll = list.scrollTop; // panel can be open during discovery — don't yank it to the top
    list.innerHTML = '';
    let found = 0;
    // Display order: by difficulty-ish (cell count), found or not
    const display = [...RECIPES].sort((a, b) => a.cells.length - b.cells.length);
    display.forEach(r => {
      const isFound = M.discovered.has(r.id);
      if (isFound) found++;
      const row = document.createElement('div');
      row.className = 'codex-row' + (isFound ? ' found' : '');
      const thumb = document.createElement('canvas');
      thumb.width = 72; thumb.height = 72;
      thumb.className = 'codex-thumb';
      drawThumb(thumb, r, isFound);
      const text = document.createElement('div');
      text.className = 'codex-text';
      const name = document.createElement('div');
      name.className = 'codex-name';
      name.textContent = isFound ? r.name : '???';
      if (isFound) {
        const badge = document.createElement('span');
        badge.className = 'codex-found';
        badge.textContent = 'Found';
        name.appendChild(badge);
      }
      const hint = document.createElement('div');
      hint.className = 'codex-hint';
      hint.textContent = r.hint; // ALWAYS the hint — it's the how-to-rebuild reference
      text.appendChild(name); text.appendChild(hint);
      row.appendChild(thumb); row.appendChild(text);
      list.appendChild(row);
    });
    if (count) count.textContent = `${found} of ${RECIPES.length} discovered`;
    if (badge) badge.textContent = `${found}/${RECIPES.length}`;
    list.scrollTop = keepScroll;
  };

  // ── Warmer/colder: near-miss detection ──────────────────────
  // When an arrangement is 1-2 blocks short of an UNDISCOVERED recipe,
  // its blocks shimmer gold (travelling pulse) and a warm pool glows on
  // the ground beneath the arrangement. The shimmer IS the hint system —
  // the dog used to react too, but he's a pet now. Wrong-type blocks
  // don't count as "close" — only genuinely missing pieces do.
  W.warmCenter = null; // {gx, gy, at} — consumed by game.js's ground pool

  function findNearMiss(px, py, pz) {
    let best = null;
    for (const r of RECIPES) {
      if (M.discovered.has(r.id)) continue; // no hints for found monuments
      for (let k = 0; k < 4; k++) {
        for (const anchor of r.cells) {
          const [ax, ay] = rot(anchor[0], anchor[1], k);
          const ox = px - ax, oy = py - ay, oz = pz - anchor[2];
          if (oz < 0) continue;
          const present = [];
          let missing = 0, bad = false;
          for (const c of r.cells) {
            const [cx, cy] = rot(c[0], c[1], k);
            const b = W.blockAt(ox + cx, oy + cy, oz + c[2]);
            if (!b) { missing++; if (missing > 2) { bad = true; break; } continue; }
            if (b.transforming || (c[3] !== '*' && b.color !== c[3])) { bad = true; break; }
            present.push(b);
          }
          if (bad || missing === 0 || present.length < 2) continue;
          if (r.sameColor && !present.every(b => b.color === present[0].color)) continue;
          if (r.notColors && present.some(b => r.notColors.includes(b.color))) continue;
          if (r.plainOnly && !present.every(b => W.BLOCK_COLORS.includes(b.color))) continue;
          if (r.empty) {
            let occ = false;
            for (const c of r.empty) {
              const [cx, cy] = rot(c[0], c[1], k);
              if (W.at(ox + cx, oy + cy, oz + c[2])) { occ = true; break; }
            }
            if (occ) continue;
          }
          if (!best || missing < best.missing) best = { missing, present, ox, oy };
        }
      }
    }
    return best;
  }

  function updateWarmth(px, py, pz) {
    const near = findNearMiss(px, py, pz);
    if (near) {
      const until = VH.clock.time + 7;
      near.present.forEach(b => { b.warmUntil = until; });
      W.warmCenter = { gx: near.ox, gy: near.oy, at: VH.clock.time };
    }
  }

  // ── Hook into placement ─────────────────────────────────────
  // Fires when a player-placed block SETTLES (world.js routes it here)
  M.onBlockSettled = (b) => {
    const match = findMatchAt(b.gx, b.gy, b.gz);
    if (match) { startCeremony(match); return; }
    updateWarmth(b.gx, b.gy, b.gz);
  };
  M.onDiscovered = null; // codex subscribes later
})();
