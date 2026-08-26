/* ============================================================
   game.js — input, hit testing, render loop, UI boot
   Pointer Events (mouse + touch unified), snap rotation,
   facing-aware hit testing, falling shadows.
   ============================================================ */
(() => {
  'use strict';
  const VH = window.VH;
  const E = VH.engine;
  const W = VH.world;
  const FX = VH.fx;
  const cam = VH.camera;
  const clock = VH.clock;

  const canvas = E.canvas;

  // ── Hit testing (facing-aware: tests the faces actually shown) ──
  function blockFaceQuads(ref) {
    const { ux, uy, uz, xVisible, yVisible } = E.fv;
    const opp = { x: ref.x + ux.x + uy.x + uz.x, y: ref.y + ux.y + uy.y + uz.y };
    const P = (dx, dy) => ({ x: ref.x + dx, y: ref.y + dy });
    const quads = [];
    // Top face
    quads.push([P(uz.x, uz.y), P(ux.x + uz.x, ux.y + uz.y), opp, P(uy.x + uz.x, uy.y + uz.y)]);
    // Visible x-side
    quads.push(xVisible
      ? [P(ux.x, ux.y), P(ux.x + uz.x, ux.y + uz.y), opp, P(ux.x + uy.x, ux.y + uy.y)]
      : [P(0, 0), P(uz.x, uz.y), P(uy.x + uz.x, uy.y + uz.y), P(uy.x, uy.y)]);
    // Visible y-side
    quads.push(yVisible
      ? [P(uy.x, uy.y), P(uy.x + uz.x, uy.y + uz.y), opp, P(ux.x + uy.x, ux.y + uy.y)]
      : [P(0, 0), P(uz.x, uz.y), P(ux.x + uz.x, ux.y + uz.y), P(ux.x, ux.y)]);
    return quads;
  }

  function hitTestBlock(sx, sy) {
    const sorted = W.blocks
      .filter(b => W.isLive(b) && !b.dropping)
      .sort((a, b) => E.depthKey(b.gx, b.gy, b.gz) - E.depthKey(a.gx, a.gy, a.gz));
    for (const block of sorted) {
      const ref = E.toScreen(block.gx, block.gy, block.gz);
      for (const q of blockFaceQuads(ref)) {
        if (E.pointInQuad(sx, sy, q[0], q[1], q[2], q[3])) return block;
      }
    }
    return null;
  }

  // ── Monument hit testing (front-to-back, scaled pieces) ─────
  // Mirrors drawBlock's geometry: sxy widens the x ground axis, sy the y
  // axis (rectangular pieces), both about the cell center; sz extends
  // upward. Pieces tested in REVERSE draw order so the front-most piece
  // under the cursor wins.
  function monumentFaceQuads(p) {
    const sxy = p.sxy, sy = p.sy, sz = p.sz;
    const ref = E.toScreen(p.gx + (1 - sxy) / 2, p.gy + (1 - sy) / 2, p.gz);
    const fv = E.fv;
    const ux = { x: fv.ux.x * sxy, y: fv.ux.y * sxy };
    const uy = { x: fv.uy.x * sy, y: fv.uy.y * sy };
    const uz = { x: fv.uz.x * sz, y: fv.uz.y * sz };
    const opp = { x: ref.x + ux.x + uy.x + uz.x, y: ref.y + ux.y + uy.y + uz.y };
    const P = (dx, dy) => ({ x: ref.x + dx, y: ref.y + dy });
    return [
      [P(uz.x, uz.y), P(ux.x + uz.x, ux.y + uz.y), opp, P(uy.x + uz.x, uy.y + uz.y)],
      fv.xVisible
        ? [P(ux.x, ux.y), P(ux.x + uz.x, ux.y + uz.y), opp, P(ux.x + uy.x, ux.y + uy.y)]
        : [P(0, 0), P(uz.x, uz.y), P(uy.x + uz.x, uy.y + uz.y), P(uy.x, uy.y)],
      fv.yVisible
        ? [P(uy.x, uy.y), P(uy.x + uz.x, uy.y + uz.y), opp, P(ux.x + uy.x, ux.y + uy.y)]
        : [P(0, 0), P(uz.x, uz.y), P(ux.x + uz.x, ux.y + uz.y), P(ux.x, ux.y)],
    ];
  }

  function hitTestMonument(sx, sy) {
    for (const mon of W.monuments) {
      if (mon.pending) continue; // mid-ceremony: not grabbable yet
      const ordered = VH.monuments.orderedModel(mon);
      for (let i = ordered.length - 1; i >= 0; i--) {
        for (const q of monumentFaceQuads(ordered[i])) {
          if (E.pointInQuad(sx, sy, q[0], q[1], q[2], q[3])) return mon;
        }
      }
    }
    return null;
  }

  // A monument move is allowed only onto fully free, on-platform cells
  // (its own current footprint counts as free — it vacates it).
  // A monument drag now resolves a landing HEIGHT as well as a shift, so
  // monuments can stand on cubes (the lighthouse fills one square cleanly
  // and could never sit on a block). Rules, decided 2026-08-24:
  // - FLAT SURFACE: every footprint column must land with the same lift.
  //   A pyramid on one tall block is refused (red ghost); a pyramid on a
  //   full 3×3 plinth is allowed — building the plinth becomes the goal.
  // - CUBES OR GROUND only. A monument's sculpted top stops short of its
  //   cell line (the perch measurements in HANDOFF.md), so landing on
  //   another monument would hover exactly like the perch bug. Blocks
  //   fill their cells; monuments don't.
  // Dragging a RAISED monument onto open ground yields a negative dz — it
  // comes down, and W.resettle() after the commit agrees.
  function monumentMovePlan(mon, dx, dy) {
    const refuse = { ok: false, dz: 0 };
    // lowest recipe cell per destination column
    const cols = new Map();
    for (const c of mon.cells) {
      const gx = c.gx + dx, gy = c.gy + dy;
      const k = gx + ',' + gy;
      const cur = cols.get(k);
      if (cur === undefined || c.gz < cur.baseGz) cols.set(k, { gx, gy, baseGz: c.gz });
    }
    let dz = null;
    for (const { gx, gy, baseGz } of cols.values()) {
      if (!W.isOnPlatform(gx, gy)) return refuse;
      // column height ignoring the dragged monument itself
      let h = 0;
      for (;;) {
        const v = W.at(gx, gy, h);
        if (v === undefined || v === mon) break;
        h++;
      }
      if (h > 0) {
        const under = W.at(gx, gy, h - 1);
        if (!under || under.color === undefined) return refuse; // not a cube
      }
      const lift = h - baseGz;
      if (dz === null) dz = lift;
      else if (lift !== dz) return refuse; // flat-surface rule
    }
    if (dz === null) return refuse;
    const free = (c) => {
      const gx = c.gx + dx, gy = c.gy + dy, gz = c.gz + dz;
      if (!W.isOnPlatform(gx, gy)) return false;
      if (gz < 0) return false;
      const v = W.at(gx, gy, gz);
      return v === undefined || v === mon;
    };
    if (!mon.cells.every(free)) return refuse;
    // blocked cells that would sink below the floor re-derive away on
    // commit — skip them rather than refuse over them
    if (!(mon.blocked || []).every(c => c.gz + dz < 0 || free(c))) return refuse;
    return { ok: true, dz };
  }

  // The one commit path — the pointer handler and the dev harness both use
  // it, so a passing test is testing the real move.
  function applyMonumentMove(mon, dx, dy, dz) {
    mon.cells.forEach(c => { c.gx += dx; c.gy += dy; c.gz += dz; });
    mon.model.forEach(m => { m.gx += dx; m.gy += dy; m.gz += dz; });
    mon.blocked = VH.monuments.blockedCellsFor(mon.model, mon.cells);
    W.markDirty();
    W.resettle(); // blocks stacked on the moved monument FALL (user decision)
    W.save();
  }

  // One monument→debris policy for BOTH destructions (Clear and the void
  // drop): the same monument must shed the same pieces however it dies.
  // Pieces under DEBRIS_MIN in every dimension vanish as trim — detailed
  // models have dozens of tiny pieces, and one shell per piece would
  // starve the particle budget mid-barrage (spawnBurst silently drops
  // when full).
  const DEBRIS_MIN = 0.4;
  function monumentDebris(mon, dx = 0, dy = 0) {
    const out = [];
    mon.model.forEach(p => {
      if (Math.max(p.sxy, p.sy) < DEBRIS_MIN && p.sz < DEBRIS_MIN) return;
      out.push(W.makeDebris(p.gx + dx, p.gy + dy, p.gz,
        { color: p.color, sxy: p.sxy, sy: p.sy, sz: p.sz }));
    });
    return out;
  }

  // ── Interaction state ───────────────────────────────────────
  let dragBlock = null;
  let dragOrigin = null;      // where the carried block came from (null when spawned)
  let spawnDrag = false;      // carried block came OUT OF THE HOTBAR, not off the platform
  let isDragging = false;
  let isRotating = false;
  let pointerScreen = { x: 0, y: 0 };
  let pointerDownPos = { x: 0, y: 0 };
  let hoverGrid = null;
  let hoverPreview = null; // quiet mouse-hover ghost: where a TAP would place
  let rotateStartAngle = 0;
  let rotateStartX = 0;
  let didDrag = false;
  let activePointerId = null;
  let dragStartTime = 0;   // for the pickup pop
  let dragVelX = 0;        // smoothed horizontal pointer velocity (carried tilt)
  let lastMoveX = null;
  let lastMoveT = 0;

  const DRAG_THRESHOLD = 6;             // px — forgiving enough for touch
  const ROT_PER_PX = (Math.PI / 2) / 260; // quarter turn per 260px of drag

  // ── Block palette (hotbar) ──────────────────────────────────
  let selectedType = 'color';
  let chosenColor = null; // colour slot: null = random, else a locked colour
  const placeColor = () =>
    selectedType === 'color' ? (chosenColor || W.randomColor()) : selectedType;

  function eventPos(e) {
    const rect = canvas.getBoundingClientRect();
    return { x: e.clientX - rect.left, y: e.clientY - rect.top };
  }

  // ONE cursor→landing-cell resolver, shared by the drag target, the
  // hover preview, and the ground tap, so what the preview shows is
  // provably where a release/tap will put the block.
  function resolveTarget(px, py) {
    const { ux, uy } = E.fv;
    // 1) Test the LANDING SURFACE of each column (the visible top of the
    // stack — the diamond the new block will sit ON), tallest first.
    // The old code tested where the new block's LID would end up — a
    // region floating one full block above the stack, which a cursor
    // never naturally reaches, so drops fell through to the ground
    // fallback and landed on the cell BEHIND the stack.
    const candidates = [];
    for (let gx = W.GRID_MIN; gx <= W.GRID_MAX; gx++) {
      for (let gy = W.GRID_MIN; gy <= W.GRID_MAX; gy++) {
        const gz = W.getStackHeight(gx, gy);
        if (gz <= W.MAX_STACK) candidates.push({ gx, gy, gz });
      }
    }
    candidates.sort((a, b) => b.gz - a.gz);
    for (const c of candidates) {
      const ref = E.toScreen(c.gx, c.gy, c.gz); // = top plane of the stack below
      const q1 = { x: ref.x + ux.x, y: ref.y + ux.y };
      const q2 = { x: ref.x + ux.x + uy.x, y: ref.y + ux.y + uy.y };
      const q3 = { x: ref.x + uy.x, y: ref.y + uy.y };
      if (E.pointInQuad(px, py, ref, q1, q2, q3)) {
        return { gx: c.gx, gy: c.gy, gz: c.gz };
      }
    }
    // 2) A block's visible SIDE face → that block's column. This is where
    // the cursor naturally sits when aiming at a tall stack, and the old
    // ground fallback resolved it to a cell several tiles BEHIND the
    // stack (one grid cell of error per unit of height) — near the far
    // edge that projected clean off the platform and destroyed the block.
    const face = hitTestBlock(px, py);
    if (face) {
      const gz = W.getStackHeight(face.gx, face.gy);
      if (gz <= W.MAX_STACK) return { gx: face.gx, gy: face.gy, gz };
    }
    // 3) Ground plane — with a one-cell dead-zone past the edge, so a
    // slight overshoot places on the edge cell instead of dropping the
    // block into the void. Only a decisive throw (≥ a full cell out)
    // reaches the void.
    const grid = E.toGrid(px, py);
    const cgx = Math.max(W.GRID_MIN, Math.min(W.GRID_MAX, grid.gx));
    const cgy = Math.max(W.GRID_MIN, Math.min(W.GRID_MAX, grid.gy));
    if (Math.abs(grid.gx - cgx) <= 1 && Math.abs(grid.gy - cgy) <= 1) {
      const gz = W.getStackHeight(cgx, cgy);
      if (gz <= W.MAX_STACK) return { gx: cgx, gy: cgy, gz };
    }
    return null;
  }

  function updateHoverTarget() {
    hoverGrid = resolveTarget(pointerScreen.x, pointerScreen.y);
  }

  function restoreDragBlockToOrigin() {
    // Put the carried block back where it came from (stack may have
    // changed). If that column filled to the cap meanwhile, spiral out to
    // the nearest column with room — never overwrite an occupied cell.
    let gx = dragOrigin.gx, gy = dragOrigin.gy;
    let gz = W.getStackHeight(gx, gy);
    if (gz > W.MAX_STACK) {
      outer:
      for (let r = 1; r <= 4; r++) {
        for (let dx = -r; dx <= r; dx++) {
          for (let dy = -r; dy <= r; dy++) {
            if (Math.max(Math.abs(dx), Math.abs(dy)) !== r) continue;
            const nx = gx + dx, ny = gy + dy;
            if (!W.isOnPlatform(nx, ny)) continue;
            const nz = W.getStackHeight(nx, ny);
            if (nz <= W.MAX_STACK) { gx = nx; gy = ny; gz = nz; break outer; }
          }
        }
      }
    }
    dragBlock.gx = gx;
    dragBlock.gy = gy;
    dragBlock.gz = Math.min(gz, W.MAX_STACK);
    dragBlock.dropOffset = E.reducedMotion ? 0 : 2;
    dragBlock.dropVel = 0;
    dragBlock.dropDelay = 0;
    dragBlock.dropping = !E.reducedMotion;
    W.blocks.push(dragBlock);
  }

  // The ONE commit path for a carried block — shared by the canvas release
  // and by a drag that started on a hotbar slot, so both can't drift.
  // spawnDrag flips the failure cases: a block dragged OUT OF THE BAR has
  // no origin to go home to and was never in the world, so "put it back"
  // and "throw it into the void" both become simply "never happened".
  function releaseCarriedBlock(cancelled) {
    // Re-validate at COMMIT time: hoverGrid was computed on the last
    // pointer move, and the world can change in between (a ceremony
    // finishing, a block landing). Never trust a stale target.
    const freshGz = (!cancelled && hoverGrid && W.isOnPlatform(hoverGrid.gx, hoverGrid.gy))
      ? W.getStackHeight(hoverGrid.gx, hoverGrid.gy) : Infinity;
    if (freshGz <= W.MAX_STACK) {
      dragBlock.gx = hoverGrid.gx;
      dragBlock.gy = hoverGrid.gy;
      dragBlock.gz = freshGz;
      dragBlock.dropOffset = E.reducedMotion ? 0 : 2;
      dragBlock.dropVel = 0;
      dragBlock.dropDelay = 0;
      dragBlock.dropping = !E.reducedMotion;
      W.blocks.push(dragBlock);
      if (E.reducedMotion && VH.sfx) VH.sfx.tock(dragBlock.gz, 0.6);
      W.notifyPlaced(dragBlock); // moving a block can complete a pattern
      W.save();
    } else if (spawnDrag) {
      // Never placed: no put-back, no void drop, no save — the world is
      // exactly as it was before the drag started.
      if (VH.sfx) VH.sfx.uiTick('slot');
    } else if (!cancelled && hoverGrid && W.isOnPlatform(hoverGrid.gx, hoverGrid.gy)) {
      // Target filled up while carrying → go home instead of overwriting
      restoreDragBlockToOrigin();
      W.save();
    } else if (cancelled) {
      restoreDragBlockToOrigin();
      W.save();
    } else {
      // Height-aware void test — the same fix monuments got: the raw
      // cursor projected onto the GROUND plane ignores height, so a
      // cursor visually over a tall stack or monument near the far edge
      // projected off-platform and destroyed the block. Reaching this
      // branch means resolveTarget found no landing cell; the remaining
      // question is bare-ground vs void, plus "is the cursor actually
      // over a monument's body" (not a landing surface, but definitely
      // not the void either).
      const grid = E.toGrid(pointerScreen.x, pointerScreen.y);
      if (W.isOnPlatform(grid.gx, grid.gy) ||
          hitTestMonument(pointerScreen.x, pointerScreen.y)) {
        // Over the platform but no valid spot (e.g. full stack) → go home
        restoreDragBlockToOrigin();
        W.save();
      } else {
        // Dropped off the platform: it tumbles into the void — real
        // physics, no scolding. (Reduced motion: it simply vanishes.)
        if (!E.reducedMotion) {
          const g = E.toGrid(pointerScreen.x, pointerScreen.y);
          dragBlock.gx = g.gx;
          dragBlock.gy = g.gy;
          dragBlock.gz = 0;
          dragBlock.dropping = false;
          dragBlock.dropOffset = 0;
          dragBlock.blasting = true;
          dragBlock.blastMode = 'fade';
          dragBlock.blastX = 0; dragBlock.blastY = 0; dragBlock.blastZ = 2;
          dragBlock.blastVelX = 0; dragBlock.blastVelY = 0; dragBlock.blastVelZ = -2;
          dragBlock.spinVel = (Math.random() - 0.5) * 4;
          W.blocks.push(dragBlock);
        }
        // A single block's fall cue (same design as the monument's,
        // minus the tumble): release → descent → nothing but tail.
        if (VH.sfx) VH.sfx.fall({
          pan: Math.max(-0.6, Math.min(0.6, (pointerScreen.x / E.W) * 2 - 1)),
          mass: 1, reduced: E.reducedMotion,
        });
        W.save();
      }
    }
    dragBlock = null;
    dragOrigin = null;
    isDragging = false;
    spawnDrag = false;
    hoverGrid = null;
    lastMoveX = null;
    dragVelX = 0;
  }

  // Clicking a block STACKS on its column; dragging a block MOVES it.
  // So pickup is decided on movement, not on press.
  let pendingBlock = null;

  // Monument dragging: press on a monument arms it; movement starts the
  // drag. The monument stays put (dimmed) while a ghost previews the
  // destination — red when the move is blocked; releasing there refuses
  // the move and the monument stays where it was.
  let pendingMonument = null;
  let dragMon = null;
  let dragMonBase = null;            // grid cell under the pointer at pickup
  let dragMonDelta = { dx: 0, dy: 0 };
  let dragMonDz = 0;                 // landing lift resolved by monumentMovePlan
  let dragMonValid = false;

  canvas.addEventListener('pointerdown', (e) => {
    if (activePointerId !== null) return; // one pointer drives; ignore extra touches
    activePointerId = e.pointerId;
    canvas.setPointerCapture(e.pointerId);
    hoverPreview = null; // a gesture owns the pointer now; recomputed on next hover

    const p = eventPos(e);
    pointerDownPos = p;
    pointerScreen = { ...p };
    didDrag = false;

    const hit = hitTestBlock(p.x, p.y);
    const monHit = hit ? null : hitTestMonument(p.x, p.y);
    if (hit) { // ANY visible block is grabbable — pull one out of the
               // middle and the tower above collapses (W.resettle)
      pendingBlock = hit;           // becomes a carry only if the pointer moves
      canvas.style.cursor = 'grab';
    } else if (monHit) {
      pendingMonument = monHit;     // becomes a monument drag only on movement
      canvas.style.cursor = 'grab';
    } else {
      isRotating = true;
      cam.cancelTween();
      rotateStartAngle = cam.angle;
      rotateStartX = p.x;
      canvas.style.cursor = 'grabbing';
    }
  });

  canvas.addEventListener('pointermove', (e) => {
    const p = eventPos(e);
    pointerScreen.x = p.x;
    pointerScreen.y = p.y;

    if (e.pointerId !== activePointerId) {
      // Plain hover (mouse only): cursor + a gentle lift on the grabbable block
      if (activePointerId === null && e.pointerType === 'mouse') {
        const hit = hitTestBlock(p.x, p.y);
        // Any block is grabbable now; buried ones skip the lift (no room
        // to rise — world.js gates it) but still get the grab cursor.
        const grabbable = hit || hitTestMonument(p.x, p.y);
        canvas.style.cursor = grabbable ? 'grab' : 'default';
        W.hoveredBlock = hit || null;
        // The quiet preview: where a tap would place a block. Same
        // resolver as the drag target and the tap commit, so the three
        // can never disagree. Mouse only — touch has no hover.
        // ONE AFFORDANCE AT A TIME: over something grabbable the answer
        // is "pick this up" — the grab cursor and the hover lift already
        // say so — so the placement ghost stands down. Showing both at
        // once answered a question the visitor wasn't asking and read as
        // clutter exactly when they were aiming to grab.
        hoverPreview = grabbable ? null : resolveTarget(p.x, p.y);
      }
      return;
    }

    if (Math.abs(p.x - pointerDownPos.x) > DRAG_THRESHOLD ||
        Math.abs(p.y - pointerDownPos.y) > DRAG_THRESHOLD) didDrag = true;

    // A pressed block becomes a carried block once the pointer moves
    if (pendingBlock && didDrag && !isDragging) {
      dragBlock = pendingBlock;
      pendingBlock = null;
      dragOrigin = { gx: dragBlock.gx, gy: dragBlock.gy };
      isDragging = true;
      dragStartTime = clock.time;
      dragVelX = 0;
      W.hoveredBlock = null;
      const vacated = { gx: dragBlock.gx, gy: dragBlock.gy, gz: dragBlock.gz };
      W.removeBlock(dragBlock);
      const knocked = W.resettle(true); // weight: anything that rested on
                        // it falls — and a collapse into a valid recipe
                        // transforms (blocks knocked loose fire the
                        // matcher when they LAND)
      // Removal can also complete a recipe with nothing falling at all —
      // e.g. clearing the cell a recipe needs EMPTY (the colosseum's
      // hole). Only when NOTHING was knocked loose: the matcher counts a
      // falling block at its reserved landing cell, so re-checking during
      // a collapse could start a ceremony around a block still in the air
      // — the landing path handles the collapse case on solid ground.
      if (!knocked && VH.monuments && VH.monuments.onBlockSettled) {
        [[1,0,0],[-1,0,0],[0,1,0],[0,-1,0],[0,0,1],[0,0,-1]].forEach(([dx,dy,dz]) => {
          const nb = W.blockAt(vacated.gx + dx, vacated.gy + dy, vacated.gz + dz);
          if (nb && !nb.dropping) VH.monuments.onBlockSettled(nb);
        });
      }
      if (VH.sfx) VH.sfx.pop();
      canvas.style.cursor = 'grabbing';
    }

    // A pressed monument becomes a monument drag once the pointer moves
    if (pendingMonument && didDrag && !dragMon) {
      dragMon = pendingMonument;
      pendingMonument = null;
      dragMon._dragging = true; // pushEntries dims it while it's held
      dragMonBase = E.toGrid(pointerDownPos.x, pointerDownPos.y);
      dragMonDelta = { dx: 0, dy: 0 };
      dragMonValid = true;
      if (VH.sfx) VH.sfx.pop();
      canvas.style.cursor = 'grabbing';
    }

    if (dragMon) {
      // Whole-structure move: pointer delta on the ground plane, in cells
      const g = E.toGrid(p.x, p.y);
      dragMonDelta = { dx: g.gx - dragMonBase.gx, dy: g.gy - dragMonBase.gy };
      const plan = monumentMovePlan(dragMon, dragMonDelta.dx, dragMonDelta.dy);
      dragMonValid = plan.ok;
      dragMonDz = plan.dz;
      return;
    }

    if (isRotating) {
      // Horizontal drag distance → angle. The world FOLLOWS the drag:
      // dragging right moves the front of the platform rightward
      // (negative angle in this projection — verified visually).
      cam.angle = rotateStartAngle - (p.x - rotateStartX) * ROT_PER_PX;
    } else if (isDragging && dragBlock) {
      // Smoothed horizontal velocity for the carried-block tilt
      const now = performance.now() / 1000;
      if (lastMoveX !== null && now > lastMoveT) {
        const v = (p.x - lastMoveX) / (now - lastMoveT);
        dragVelX += (v - dragVelX) * 0.25;
      }
      lastMoveX = p.x;
      lastMoveT = now;
      updateHoverTarget();
    }
  });

  function endPointer(e, cancelled) {
    // Strict pointer matching: only the pointer that STARTED the gesture may
    // end it — on touch, a second finger's tap must not commit the first
    // finger's drag at whatever position the cursor happens to be. (An
    // earlier loosening for synthetic test input is superseded: synthetic
    // events must use pointerId 1, the primary — setPointerCapture rejects
    // other ids anyway. The lostpointercapture net below un-wedges the rare
    // case where the captured pointer dies without a proper up/cancel.)
    if (activePointerId === null) return;
    if (e.pointerId !== activePointerId) return;
    activePointerId = null;

    // Pressed a monument and released without moving: nothing happens
    pendingMonument = null;

    if (dragMon) {
      const { dx, dy } = dragMonDelta;
      let movePlan; // resolved (ok + landing lift) inside the commit test below
      const stillExists = W.monuments.includes(dragMon); // Clear mid-drag guard
      // "Off the platform" = the WHOLE dragged footprint left it (what the
      // ghost shows), and the drag actually moved. The old test projected
      // the raw cursor onto the GROUND plane, ignoring height — pressing
      // high on a tall monument near the edge projected off-platform before
      // any movement, so a six-pixel twitch destroyed it. A partially-off
      // destination stays a refused move (red ghost), not a destruction.
      const thrownOff = (dx || dy) &&
        dragMon.cells.every(c => !W.isOnPlatform(c.gx + dx, c.gy + dy));
      if (!cancelled && stillExists && thrownOff) {
        // Released off the platform: the monument tumbles into the void,
        // same as a block. The DISCOVERY persists — only the built copy
        // is gone; it can always be rebuilt from its recipe.
        W.monuments.splice(W.monuments.indexOf(dragMon), 1);
        if (!E.reducedMotion) {
          // Fall from the GHOST position (original + drag delta) — the
          // monument never moves during a drag, so without the offset
          // the debris dropped from its old spot mid-platform.
          monumentDebris(dragMon, dx, dy).forEach(d => {
            d.blasting = true;
            d.blastMode = 'fade';
            d.blastVelZ = -1 - Math.random() * 2;
            d.spinVel = (Math.random() - 0.5) * 3;
            W.blocks.push(d);
          });
          E.kickShake(2);
        }
        // The fall cue: a release, a descending tumble (the monument's own
        // rise melody played backwards as you lose it), and 240 ms of pure
        // reverb tail at the end — the void has no floor. Panned to where
        // you actually threw it. Reduced motion gets a short confirmation
        // instead (on screen nothing falls; a long tumble would be a lie).
        if (VH.sfx) VH.sfx.fall({
          pan: Math.max(-0.6, Math.min(0.6, (pointerScreen.x / E.W) * 2 - 1)),
          mass: dragMon.model.length, tumble: true, reduced: E.reducedMotion,
        });
        W.markDirty();
        W.resettle(); // anything stacked on it falls
        W.save();
      } else if (!cancelled && stillExists && (dx || dy) &&
                 (movePlan = monumentMovePlan(dragMon, dx, dy)).ok) {
        // Commit: shift cells + model (with the resolved landing lift),
        // re-derive the blocked volume — applyMonumentMove is the ONE
        // commit path, shared with the vh-dev-monstack harness
        applyMonumentMove(dragMon, dx, dy, movePlan.dz);
        if (!E.reducedMotion) {
          W.kickDip(0.8); // it lands with weight
          const c0 = dragMon.cells[0];
          if (VH.fx) VH.fx.spawnDust(c0.gx, c0.gy, 0, 10);
        }
        if (VH.sfx) VH.sfx.tock(0, 0.9);
      } else if (!cancelled && stillExists && (dx || dy)) {
        // Refused: the red ghost already said why; a small headshake
        if (!E.reducedMotion) E.kickShake(2);
      }
      dragMon._dragging = false;
      dragMon = null;
      dragMonBase = null;
      dragMonDelta = { dx: 0, dy: 0 };
      dragMonDz = 0;
      canvas.style.cursor = 'default';
      return;
    }

    if (pendingBlock && !cancelled) {
      // Pressed a block and released without moving: stack on its column
      const col = pendingBlock;
      pendingBlock = null;
      const gz = W.getStackHeight(col.gx, col.gy);
      if (gz <= W.MAX_STACK) {
        const placed = W.makeBlock(col.gx, col.gy, gz, { color: placeColor() });
        W.blocks.push(placed);
        if (E.reducedMotion && VH.sfx) VH.sfx.tock(gz, 0.6);
        W.notifyPlaced(placed);
        W.save();
      }
      W.hoveredBlock = null;
      canvas.style.cursor = 'default';
      return;
    }
    pendingBlock = null;

    if (isDragging && dragBlock) {
      releaseCarriedBlock(cancelled);
    } else if (isRotating) {
      if (!didDrag && !cancelled) {
        // Click/tap on the platform → place a block, via the SAME
        // resolver as the hover preview and the drag target (the old
        // ground-plane projection put a tap on a tower's side face onto
        // the cell BEHIND the tower — one cell of error per unit of
        // height, and blind: there was no preview for taps at all).
        const target = resolveTarget(pointerScreen.x, pointerScreen.y);
        if (target) {
          const placed = W.makeBlock(target.gx, target.gy, target.gz,
            { color: placeColor() });
          W.blocks.push(placed);
          if (E.reducedMotion && VH.sfx) VH.sfx.tock(target.gz, 0.6);
          W.notifyPlaced(placed);
          W.save();
        }
        cam.angle = rotateStartAngle; // undo sub-threshold wiggle
        // If the tap interrupted a snap animation, finish the snap
        const HALF_PI = Math.PI / 2;
        if (Math.abs(cam.angle - Math.round(cam.angle / HALF_PI) * HALF_PI) > 1e-4) {
          cam.snapTo(cam.nearestSnap(), E.reducedMotion ? 0.001 : 0.3);
        }
      } else {
        // Release the rotation into a snap at the nearest quarter turn
        cam.snapTo(cam.nearestSnap(), E.reducedMotion ? 0.001 : 0.5);
      }
      isRotating = false;
    }
    W.hoveredBlock = null;
    canvas.style.cursor = 'default';
  }

  canvas.addEventListener('pointerup', (e) => endPointer(e, false));
  canvas.addEventListener('pointercancel', (e) => endPointer(e, true));
  // Safety net for the strict guard above: if the captured pointer dies
  // without a proper up/cancel, end the gesture as a cancel instead of
  // wedging input. (After a normal pointerup this fires too, but by then
  // activePointerId is null and endPointer returns immediately.)
  canvas.addEventListener('lostpointercapture', (e) => {
    if (e.pointerId === activePointerId) endPointer(e, true);
  });
  // The hover ghost must not linger when the mouse leaves the canvas
  // (onto a panel or out of the window) — it recomputes on re-entry.
  canvas.addEventListener('pointerleave', () => { hoverPreview = null; });
  canvas.addEventListener('contextmenu', (e) => e.preventDefault());

  // Keyboard: quarter-turn rotation (reads as "game", helps accessibility)
  window.addEventListener('keydown', (e) => {
    const k = e.key;
    // Arrows match the drag: ArrowRight turns the world the way dragging right does
    if (k === 'ArrowLeft' || k === 'Left') {
      cam.rotateStep(1); if (VH.sfx) VH.sfx.uiTick('rotate'); e.preventDefault();
      hoverPreview = null; // projection is changing; recomputed on next mouse move
    }
    else if (k === 'ArrowRight' || k === 'Right' || k === 'r' || k === 'R') {
      cam.rotateStep(-1); if (VH.sfx) VH.sfx.uiTick('rotate'); e.preventDefault();
      hoverPreview = null;
    }
    else if (k >= '1' && k <= '4') {
      selectSlot(['color', 'grass', 'lamp', 'glass'][+k - 1]);
    }
    else if (k === 'Escape' || k === 'Esc') { closeCodex(); } // hoisted; defined with the codex wiring
  });

  // ── Clear / Fireworks ───────────────────────────────────────
  // Choreography: anticipation crouch → staggered ballistic launch (a
  // shockwave from the center) → each block detonates at its APEX into a
  // coloured particle burst + bloom. Monuments become debris and explode
  // too. The stage ends EMPTY — clicking places blocks, so it stays
  // playable — and DISCOVERIES persist forever (saved in v2).
  document.getElementById('resetBtn').addEventListener('click', (e) => {
    e.stopPropagation();
    if (!W.blocks.length && !W.monuments.length) return; // nothing to clear

    // A reset mid-ceremony must not leave an orphaned ceremony drawing
    VH.monuments.clearCeremonies();

    // Monuments explode too: each substantial model piece becomes blast
    // debris that keeps its shape (the obelisk's gold tip bursts as its
    // own shell) — one shared policy with the void drop (monumentDebris).
    W.monuments.forEach(mon => monumentDebris(mon).forEach(d => W.blocks.push(d)));
    W.monuments = [];

    // The launch itself lives in W.launchBlocks (shared with the ceremony's
    // leftover sweep); the defaults ARE the Clear tuning.
    W.launchBlocks(W.blocks, {
      cx: (W.GRID_MIN + W.GRID_MAX) / 2,
      cy: (W.GRID_MIN + W.GRID_MAX) / 2,
    });
    const shellCount = W.blocks.length;
    if (E.reducedMotion) {
      // One soft bloom over the whole board: "the stage dissolves in light".
      // The sound keeps the ARC (thump → soft break → crackle → the night
      // returns) without describing a barrage that isn't on screen — and
      // reduced-motion users finally GET a final beat (the old path wired
      // onBlastCleared only in the animated branch).
      FX.spawnFlash(0, 0, 1.2, { dur: 0.7, r0: 3, r1: 6, peak: 0.30 });
      if (VH.sfx) VH.sfx.clearReduced();
    } else {
      E.kickShake(5);
      W.kickDip(2.2);
      // A final beat once the last shell is gone. finalBoom bypasses the
      // boom coalescer — the OLD cooldown ate this beat in the same tick,
      // every single time, so Clear's punctuation had never actually played.
      W.onBlastCleared = () => {
        if (VH.sfx) VH.sfx.finalBoom();
        W.kickDip(1.0);
      };
      // Anticipation thump + a whistle VOLLEY that shadows the real launch
      // stagger (one whistle for a whole barrage was the biggest tell),
      // then a deliberate gap before the first apex. Tier budgets scale to
      // the board so a small clear stays intimate.
      if (VH.sfx) VH.sfx.beginBarrage(shellCount);
    }
    // Persistence doesn't wait for the show: save() filters launching
    // blocks, so the debounced write stores the empty stage + discoveries.
    W.markDirty();
    W.save();
  });

  // ── Codex wiring ────────────────────────────────────────────
  // One open/close path shared by the button, the boot auto-open and
  // Escape, so the button's label/expanded state can never drift.
  const codex = document.getElementById('codex');
  const codexBtn = document.getElementById('codexBtn');
  function reflectCodexBtn() {
    const open = !codex.hidden;
    codexBtn.setAttribute('aria-expanded', String(open));
    codexBtn.setAttribute('aria-label', open ? 'Close your collection' : 'Open your collection');
  }
  function openCodex() {
    if (!codex.hidden) return;
    // No rebuild here: the codex is built at boot and rebuilt on every
    // state change (onDiscovered, plan toggles, harness restores), so it
    // is always current while hidden. Rebuilding on open was a full DOM
    // teardown + 13 canvas thumbnails in the same frame as the panel's
    // entrance animation — the heaviest single beat of the old boot.
    codex.hidden = false;
    reflectCodexBtn();
  }
  function closeCodex() {
    if (codex.hidden) return;
    codex.hidden = true;
    reflectCodexBtn();
  }
  codexBtn.addEventListener('click', (e) => {
    e.stopPropagation();
    if (VH.sfx) VH.sfx.uiTick(codex.hidden ? 'open' : 'close');
    if (codex.hidden) openCodex(); else closeCodex();
  });
  document.getElementById('codexClose').addEventListener('click', () => closeCodex());
  // Tap any row to show/hide its PLAN (the blocks to place). Delegated,
  // because buildCodex() replaces every row on each rebuild. For an
  // undiscovered monument the name stays ??? — you learn what to build,
  // never what you get, so the ceremony is still the reveal. Found rows
  // toggle too: after a Clear, the plan is how you rebuild a favourite.
  document.getElementById('codexList').addEventListener('click', (e) => {
    const row = e.target.closest('.codex-row');
    if (!row || !row.dataset.recipe) return;
    e.stopPropagation();
    const opened = VH.monuments.togglePlan(row.dataset.recipe);
    if (VH.sfx) VH.sfx.uiTick(opened ? 'open' : 'close');
  });
  VH.monuments.onDiscovered = () => {
    W.save();
    VH.monuments.buildCodex(); // refresh counts/rows (cheap; also updates badge)
  };

  // ── Hotbar wiring (click + number keys) ─────────────────────
  const hotbar = document.getElementById('hotbar');
  const slots = [...hotbar.querySelectorAll('.slot')];

  function selectSlot(type) {
    selectedType = type;
    slots.forEach(s => s.classList.toggle('selected', s.dataset.type === type));
    reflectSwatches();
  }
  slots.forEach(s => s.addEventListener('click', () => {
    // Kept for KEYBOARD: Enter/Space fire click with NO pointer events, so
    // removing this would strip keyboard selection. Any pointer gesture has
    // already selected on press (and a drag must not re-select on release),
    // so the click that trails every tap is swallowed here.
    if (slotPointerDone) { slotPointerDone = false; return; }
    if (VH.sfx) VH.sfx.uiTick('slot');
    selectSlot(s.dataset.type);
  }));

  // ── Drag a block OUT of the hotbar onto the platform ────────
  // The instinct is to drag from the bar rather than click-then-click, and
  // everything needed already exists: the carried cube renders at the
  // cursor, updateHoverTarget() resolves the landing cell, drawGhostBlock
  // previews it, and releaseCarriedBlock commits. All that's new is
  // starting the gesture on an HTML button.
  //
  // The slot CAPTURES the pointer, so every later move/up fires here even
  // though the finger is out over the canvas — the canvas handlers stay
  // out of it entirely and there is exactly one owner for the gesture.
  let slotPressId = null;      // pointerId owning a press that began on a slot
  let slotPressPos = null;
  let slotPointerDone = false; // a pointer gesture handled it; swallow the trailing click
  slots.forEach(s => {
    s.addEventListener('pointerdown', (e) => {
      if (activePointerId !== null || slotPressId !== null) return; // one pointer drives
      slotPressId = e.pointerId;
      slotPressPos = { x: e.clientX, y: e.clientY };
      try { s.setPointerCapture(e.pointerId); } catch (_) { /* synthetic ids */ }
      // Select on PRESS: it makes placeColor() right for the drag that may
      // follow, and the highlight answers the finger immediately.
      if (VH.sfx) VH.sfx.uiTick('slot');
      selectSlot(s.dataset.type);
    });
    s.addEventListener('pointermove', (e) => {
      if (e.pointerId !== slotPressId) return;
      pointerScreen = { x: e.clientX, y: e.clientY };
      if (!isDragging) {
        if (Math.abs(e.clientX - slotPressPos.x) < DRAG_THRESHOLD &&
            Math.abs(e.clientY - slotPressPos.y) < DRAG_THRESHOLD) return;
        // Past the threshold: this is a drag, not a tap. The block is made
        // but deliberately NOT pushed into W.blocks — it isn't in the world
        // until it lands, so an abandoned drag leaves nothing behind.
        dragBlock = W.makeBlock(0, 0, 0, { color: placeColor() });
        dragBlock.dropping = false;
        dragBlock.dropOffset = 0;
        dragOrigin = null;
        spawnDrag = true;
        isDragging = true;
        dragStartTime = clock.time;
        W.hoveredBlock = null;
        canvas.style.cursor = 'grabbing';
      }
      updateHoverTarget(); // keeps the carried cube and its ghost in step
    });
    const endSlotPress = (e, cancelled) => {
      if (e.pointerId !== slotPressId) return;
      if (isDragging && dragBlock) {
        pointerScreen = { x: e.clientX, y: e.clientY };
        if (!cancelled) updateHoverTarget();
        releaseCarriedBlock(cancelled);
      }
      slotPressId = null;
      slotPressPos = null;
      slotPointerDone = true; // the trailing click is a duplicate, not input
      canvas.style.cursor = 'default';
    };
    s.addEventListener('pointerup', (e) => endSlotPress(e, false));
    s.addEventListener('pointercancel', (e) => endSlotPress(e, true));
  });

  // ── Colour swatches (unfold while the colour slot is selected) ──
  const swatchBar = document.getElementById('swatches');
  let uiReady = false; // swatches wait for the hotbar's entrance

  function reflectSwatches() {
    swatchBar.classList.toggle('show', uiReady && selectedType === 'color');
  }

  (function buildSwatches() {
    const mk = (colorKey) => {
      const b = document.createElement('button');
      b.className = 'swatch' + (colorKey ? '' : ' swatch--random');
      if (colorKey) {
        b.style.background = W.COLORS[colorKey].top;
        b.setAttribute('aria-label', colorKey + ' blocks');
      } else {
        b.textContent = '?';
        b.setAttribute('aria-label', 'Random colour');
      }
      b.addEventListener('click', (e) => {
        e.stopPropagation();
        if (VH.sfx) VH.sfx.uiTick('swatch');
        chosenColor = colorKey || null;
        [...swatchBar.children].forEach(x => x.classList.toggle('selected', x === b));
        drawSlotIcons(); // slot 1's cube shows the locked colour (or multicolour)
      });
      swatchBar.appendChild(b);
      return b;
    };
    mk(null).classList.add('selected'); // random is the default
    W.BLOCK_COLORS.forEach(mk);
  })();

  // Mini isometric cube icons drawn into each slot canvas.
  // Runs on init and on colour-swatch change — NOT per frame, so the
  // gradient below is not the per-frame allocation the light pass was
  // built to eliminate. Don't "optimise" it away.
  // Each icon has to say what its block IS: four cubes in four colours
  // read as four colours, which is exactly the confusion the captions and
  // these treatments fix together.
  function drawSlotIcons() {
    const ICON_COLORS = {
      // Multicolour cube = "random"; a locked colour shows its own cube
      color: chosenColor
        ? W.COLORS[chosenColor]
        : { top: '#e05050', right: '#3060b0', front: '#d8b830' },
      grass: W.COLORS.grass,
      lamp: W.COLORS.lamp,
      glass: W.COLORS.glass,
    };
    slots.forEach(slot => {
      const c = slot.querySelector('.slot-icon');
      const ictx = c.getContext('2d');
      const col = ICON_COLORS[slot.dataset.type];
      const cx = 32, cy = 34, t = 17;
      const type = slot.dataset.type;
      ictx.clearRect(0, 0, 64, 64);
      const face = (pts, fill, alpha) => {
        ictx.globalAlpha = alpha === undefined ? 1 : alpha;
        ictx.fillStyle = fill;
        ictx.beginPath();
        ictx.moveTo(pts[0][0], pts[0][1]);
        for (let i = 1; i < pts.length; i++) ictx.lineTo(pts[i][0], pts[i][1]);
        ictx.closePath(); ictx.fill();
        ictx.strokeStyle = 'rgba(0,0,0,0.35)';
        ictx.lineWidth = 1.5;
        ictx.stroke();
        ictx.globalAlpha = 1;
      };
      // Lamp: the glow reads as EMITTING, so it goes down first and spills
      // past the cube's silhouette — a halo behind glass-clear air, not a
      // yellow highlight sitting on a face.
      if (type === 'lamp') {
        const g = ictx.createRadialGradient(cx, cy - t * 0.4, 1, cx, cy - t * 0.4, 30);
        g.addColorStop(0, 'rgba(255,226,150,0.85)');
        g.addColorStop(0.45, 'rgba(255,206,110,0.34)');
        g.addColorStop(1, 'rgba(255,200,100,0)');
        ictx.fillStyle = g;
        ictx.fillRect(0, 0, 64, 64);
      }
      // Glass: genuinely see-through — the slot behind shows through the
      // faces, which is the one thing a solid cube can never say.
      const fa = type === 'glass' ? 0.42 : 1;
      // Grass: soil sides under a green lid, so it reads as turf rather
      // than "the green one".
      const sideR = type === 'grass' ? '#6b4a2f' : col.right;
      const sideF = type === 'grass' ? '#835b39' : col.front;
      face([[cx, cy - t * 1.5], [cx + t, cy - t], [cx, cy - t * 0.5], [cx - t, cy - t]], col.top, fa);
      face([[cx, cy - t * 0.5], [cx + t, cy - t], [cx + t, cy], [cx, cy + t * 0.5]], sideR, fa);
      face([[cx, cy - t * 0.5], [cx - t, cy - t], [cx - t, cy], [cx, cy + t * 0.5]], sideF, fa);
      if (type === 'grass') { // turf lip: a green band capping the soil
        ictx.globalAlpha = 0.95;
        ictx.fillStyle = col.right;
        ictx.beginPath();
        ictx.moveTo(cx, cy - t * 0.5); ictx.lineTo(cx + t, cy - t);
        ictx.lineTo(cx + t, cy - t * 0.72); ictx.lineTo(cx, cy - t * 0.22);
        ictx.closePath(); ictx.fill();
        ictx.fillStyle = col.front;
        ictx.beginPath();
        ictx.moveTo(cx, cy - t * 0.5); ictx.lineTo(cx - t, cy - t);
        ictx.lineTo(cx - t, cy - t * 0.72); ictx.lineTo(cx, cy - t * 0.22);
        ictx.closePath(); ictx.fill();
        ictx.globalAlpha = 1;
      }
      if (type === 'glass') { // sheen
        ictx.globalAlpha = 0.7;
        ictx.strokeStyle = '#fff';
        ictx.lineWidth = 2;
        ictx.beginPath();
        ictx.moveTo(cx - t * 0.5, cy - t * 1.15);
        ictx.lineTo(cx + t * 0.35, cy - t * 0.7);
        ictx.stroke();
        ictx.globalAlpha = 1;
      }
      if (type === 'lamp') { // filament core, on top of the faces
        ictx.globalAlpha = 0.9;
        ictx.fillStyle = '#fff4cf';
        ictx.beginPath();
        ictx.arc(cx, cy - t * 0.62, t * 0.26, 0, Math.PI * 2);
        ictx.fill();
        ictx.globalAlpha = 1;
      }
    });
  }
  drawSlotIcons();

  // ── Sound button: a 3-state cycle (full → quiet → off) ──────
  // No slider: it would break the icon row for a control almost nobody
  // touches. Quiet keeps the outer wave arc at 25% opacity; off keeps the
  // existing slash. The label announces the state for screen readers.
  const soundBtn = document.getElementById('soundBtn');
  function reflectSound() {
    const st = VH.sfx.state;
    soundBtn.classList.toggle('muted', st === 'off');
    soundBtn.classList.toggle('quiet', st === 'quiet');
    soundBtn.setAttribute('aria-label',
      st === 'off' ? 'Sound: off' : st === 'quiet' ? 'Sound: quiet' : 'Sound: full');
  }
  soundBtn.addEventListener('click', (e) => {
    e.stopPropagation();
    const next = { full: 'quiet', quiet: 'off', off: 'full' }[VH.sfx.state] || 'full';
    VH.sfx.setState(next);
    reflectSound();
    if (next !== 'off') VH.sfx.pop(); // audible confirmation at the new level
  });
  reflectSound();

  // ── Postcard export ─────────────────────────────────────────
  document.getElementById('postcardBtn').addEventListener('click', (e) => {
    e.stopPropagation();
    const src = E.canvas;
    const border = Math.round(src.width * 0.02);
    const caption = Math.round(src.width * 0.05);
    const out = document.createElement('canvas');
    out.width = src.width + border * 2;
    out.height = src.height + border * 2 + caption;
    const octx = out.getContext('2d');
    octx.fillStyle = '#f4efe4'; // postcard paper
    octx.fillRect(0, 0, out.width, out.height);
    octx.drawImage(src, border, border);
    octx.fillStyle = '#1a1a2e';
    const fs = Math.max(12, Math.round(src.width * 0.011));
    octx.font = `${fs}px "Press Start 2P", monospace`;
    octx.textAlign = 'center';
    octx.textBaseline = 'middle';
    const found = VH.monuments.discovered.size;
    const total = VH.monuments.RECIPES.length;
    const stamp = found > 0
      ? `a night at vietnhoang.com — ${found}/${total} monuments`
      : 'a night at vietnhoang.com';
    octx.fillText(stamp, out.width / 2, src.height + border + caption / 2 + border * 0.4);
    out.toBlob((blob) => {
      if (!blob) return;
      const url = URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.href = url;
      a.download = 'night-blocks-postcard.png';
      a.click();
      setTimeout(() => URL.revokeObjectURL(url), 5000);
    }, 'image/png');
  });

  // ── Platform layer (offscreen cache; redrawn only when the view moves) ──
  let platformTiles = null;
  let platformAngle = null;
  const platformCache = document.createElement('canvas');
  const platformCacheCtx = platformCache.getContext('2d');
  let platformCacheKey = '';

  function getPlatformTiles() {
    if (platformTiles && platformAngle === cam.angle) return platformTiles;
    platformTiles = [];
    for (let gx = W.GRID_MIN; gx <= W.GRID_MAX; gx++) {
      for (let gy = W.GRID_MIN; gy <= W.GRID_MAX; gy++) {
        platformTiles.push({ gx, gy, gz: -1, color: 'grass' });
        const isEdge = gx === W.GRID_MIN || gx === W.GRID_MAX || gy === W.GRID_MIN || gy === W.GRID_MAX;
        if (isEdge) platformTiles.push({ gx, gy, gz: -2, color: 'dirt' });
      }
    }
    platformTiles.sort((a, b) => E.depthKey(a.gx, a.gy, a.gz) - E.depthKey(b.gx, b.gy, b.gz));
    platformAngle = cam.angle;
    return platformTiles;
  }

  function drawPlatform(dip) {
    // Cache key: anything that changes the platform's pixels
    const key = [cam.angle.toFixed(5), dip.toFixed(4), E.W, E.H,
                 E.shakeX.toFixed(2), E.shakeY.toFixed(2)].join('|');
    if (key !== platformCacheKey) {
      platformCacheKey = key;
      const dpr = Math.min(window.devicePixelRatio || 1, 2);
      if (platformCache.width !== E.W * dpr || platformCache.height !== E.H * dpr) {
        platformCache.width = E.W * dpr;
        platformCache.height = E.H * dpr;
      }
      platformCacheCtx.setTransform(dpr, 0, 0, dpr, 0, 0);
      platformCacheCtx.clearRect(0, 0, E.W, E.H);
      const mainCtx = E.ctx;
      E.ctx = platformCacheCtx; // world drawing helpers target E.ctx
      getPlatformTiles().forEach(t =>
        W.drawBlock(t.gx, t.gy, t.gz - dip, t.color, 1, { gridTop: t.color === 'grass' }));
      E.ctx = mainCtx;
    }
    E.ctx.drawImage(platformCache, 0, 0, platformCache.width, platformCache.height, 0, 0, E.W, E.H);
  }

  // One blasting-block draw for BOTH passes (the behind-platform pre-pass
  // and the sorted main pass) — the spin transform must stay identical or
  // a faller pops the moment it crosses the platform edge
  function drawBlastingBlock(b, drawOpacity, squashOpts) {
    const ctx = E.ctx;
    const bgx = b.gx + b.blastX, bgy = b.gy + b.blastY, bgz = b.gz + b.blastZ;
    const c = E.toScreen(bgx + 0.5, bgy + 0.5, bgz + 0.5);
    ctx.save();
    ctx.translate(c.x, c.y);
    ctx.rotate(b.spin);
    ctx.translate(-c.x, -c.y);
    W.drawBlock(bgx, bgy, bgz, b.color, drawOpacity, squashOpts);
    ctx.restore();
  }

  // ── Render loop (driven by real time) ───────────────────────
  let perfMon = null; // set by the #dev vh-dev-perf hook; null for visitors
  // Hit stop: hold the world still for a beat on a significant impact.
  // The clock keeps running (shimmer phases stay continuous) but dt is
  // zero, so blocks, dust, camera and monuments freeze mid-squash. It is
  // the one impact technique that works with NO sound — which is exactly
  // the entrance's situation (browsers gate audio until first input).
  let hitStop = 0;
  W.kickHitStop = (secs) => { if (!E.reducedMotion) hitStop = Math.max(hitStop, secs); };
  function render(nowMs) {
    const __perfT0 = perfMon ? performance.now() : 0;
    let dt = clock.tick(nowMs);
    if (hitStop > 0) { hitStop -= dt; dt = 0; }
    const ctx = E.ctx;

    cam.update(dt);
    W.updateBlocks(dt);
    E.updateFaceVectors();
    E.updateLightInfo();
    ctx.clearRect(0, 0, E.W, E.H);
    E.lightBegin(); // wipe the bloom buffer; emissive draws register into it

    // Sky
    const grad = ctx.createLinearGradient(0, 0, 0, E.H);
    grad.addColorStop(0, '#0d0d1a');
    grad.addColorStop(0.6, '#1a1a2e');
    grad.addColorStop(1, '#16213e');
    ctx.fillStyle = grad;
    ctx.fillRect(0, 0, E.W, E.H);

    FX.drawStars(dt);
    FX.updateAndDrawShootingStar(dt);
    FX.drawMoon();
    FX.updateAndDrawClouds(dt);
    FX.updateAndDrawSilhouettes(dt);

    // Void-fallers that are provably BEHIND the platform draw first, so
    // they disappear behind it. The old order painted the platform and
    // then every block, so anything released past the FAR edge fell
    // "through" the grass — painted over it. Same separating-plane votes
    // as the occlusion sorter (monuments.js occlusionOrder): agreeing
    // votes = behind; contradictory = provably no shared pixels, so the
    // main pass is fine for those. NOT a corner-distance shortcut — a
    // block past the middle of a far edge is genuinely behind while its
    // depth key still sits inside the platform's range.
    const behindPlatform = new Set();
    {
      const P = { x0: W.GRID_MIN, x1: W.GRID_MAX + 1,
                  y0: W.GRID_MIN, y1: W.GRID_MAX + 1, z0: -2, z1: 0 };
      const vx = E.cosA + E.sinA, vy = E.cosA - E.sinA, EV = 1e-9, SEP = 1e-6;
      W.blocks.forEach(b => {
        if (!b.blasting || b.opacity <= 0) return;
        const A = E.pieceAABB(b.gx + b.blastX, b.gy + b.blastY, b.gz + b.blastZ,
          b.baseSxy, b.baseSz);
        let aF = 0, aB = 0;
        if (A.x1 <= P.x0 + SEP) { if (vx > EV) aB++; else if (vx < -EV) aF++; }
        else if (P.x1 <= A.x0 + SEP) { if (vx > EV) aF++; else if (vx < -EV) aB++; }
        if (A.y1 <= P.y0 + SEP) { if (vy > EV) aB++; else if (vy < -EV) aF++; }
        else if (P.y1 <= A.y0 + SEP) { if (vy > EV) aF++; else if (vy < -EV) aB++; }
        if (A.z1 <= P.z0 + SEP) aB++; else if (P.z1 <= A.z0 + SEP) aF++;
        if (aB && !aF) behindPlatform.add(b);
      });
      behindPlatform.forEach(b => {
        const isGlass = b.color === 'glass';
        drawBlastingBlock(b, isGlass ? b.opacity * 0.55 : b.opacity, {
          styled: true, shade: b.shade,
          sxy: (1 + b.squash * 0.7) * b.baseSxy,
          sz: (1 - b.squash) * b.baseSz,
          warmT: Math.max(0, b.warmUntil - clock.time),
        });
      });
    }

    // Platform (dips when the blast fires; blocks below inherit the dip)
    const dip = W.dip;
    drawPlatform(dip);
    FX.drawGrass();

    // Shadows — one physical model, no special cases: every caster
    // projects its full VOLUME from its LIVE position (engine.js
    // E.addShadowBox), so a falling block's shadow slides in and
    // sharpens as it lands (no telegraph/moon-shadow handoff blink),
    // launching blocks cast racing shadows, and monument pillars throw
    // one continuous shadow attached at their feet. The composite is
    // clipped to the platform top: no ground, no shadow.
    const heightFade = (h) => Math.min(1, 1.5 / (h * 0.5 + 1));
    E.shadowBegin();
    W.blocks.forEach(b => {
      if (b.dropping && b.dropDelay > 0) return; // not on stage yet
      if (b.opacity <= 0) return;
      const live = W.isLive(b);
      // The SAME live coordinates the draw pass renders from (slide = the
      // tumble roll-off offset — shadow must ride along or it detaches)
      const gx = live ? b.gx + (b.slideX || 0) : b.gx + b.blastX;
      const gy = live ? b.gy + (b.slideY || 0) : b.gy + b.blastY;
      const gz = live ? b.gz + (b.dropOffset || 0) + (b.lift || 0) : b.gz + b.blastZ;
      const sxyQ = (1 + b.squash * 0.7) * b.baseSxy;
      const hTop = gz + (b.baseSz || 1);
      if (hTop <= 0) return;
      E.addShadowBox(gx, gy, gz, sxyQ, b.baseSz || 1,
        heightFade(hTop) * Math.min(1, b.opacity), dip);
    });
    W.monuments.forEach(mon => {
      if (mon.pending) return; // mid-ceremony: pushShadowCasters owns it below
      const dim = mon._dragging ? 0.45 : 1; // match the dimmed drag look
      mon.model.forEach(m => {
        if (!VH.monuments.castsShadow(m)) return; // ONE gate, shared with the ceremony pass
        E.addShadowBox(m.gx, m.gy, m.gz, m.sxy, m.sz,
          heightFade(m.gz + m.sz) * dim, dip, m.sy);
      });
    });
    // Ceremony shadows: floaters cast from their live rising positions and
    // the monument's pieces cast growing shadows as they pop in — no more
    // 2-second shadow hole + single-frame snap when a monument forms
    VH.monuments.pushShadowCasters(dip, heightFade);
    // The landing cell's shadow during a drag — the one depth cue a drag
    // otherwise LOSES (the carried block left W.blocks at pickup, so
    // nothing casts). One box at the future position; the composite is
    // clipped to the platform top, so with no valid target there is no
    // shadow — its absence is the "this will fall" warning, physically.
    if (isDragging && hoverGrid) {
      E.addShadowBox(hoverGrid.gx, hoverGrid.gy, hoverGrid.gz, 1, 1, 0.6, dip);
    }
    // The receiving surface: the platform's top diamond, live-rotated + dipped
    E.shadowComposite([
      E.toScreen(W.GRID_MIN, W.GRID_MIN, -dip),
      E.toScreen(W.GRID_MAX + 1, W.GRID_MIN, -dip),
      E.toScreen(W.GRID_MAX + 1, W.GRID_MAX + 1, -dip),
      E.toScreen(W.GRID_MIN, W.GRID_MAX + 1, -dip),
    ]);

    // User blocks + monuments + ceremony theater, ordered by ONE global
    // occlusion sort over every item's REAL box — so a block against a
    // monument sorts by the pieces' true extents, not by a base-cell
    // stand-in. (The old merge keyed monument pieces by their base cell:
    // a 4-cell lintel sorted as a 1-cell post at its centre, which was
    // near-correct at the four rest angles and visibly wrong mid-rotation.)
    // Each entry: a box {gx,gy,gz,sxy,sy,sz} plus { b } for blocks or
    // { draw } for monument/ceremony pieces.
    const entries = [];
    W.blocks.forEach(b => {
      if (behindPlatform.has(b)) return; // already drawn under the platform
      const gx = b.blasting ? b.gx + b.blastX : b.gx + (b.slideX || 0);
      const gy = b.blasting ? b.gy + b.blastY : b.gy + (b.slideY || 0);
      const gz = b.blasting ? b.gz + b.blastZ : b.gz + (b.dropping ? b.dropOffset : 0);
      entries.push({ gx, gy, gz, sxy: b.baseSxy, sy: b.baseSxy, sz: b.baseSz, b });
    });
    VH.monuments.pushEntries(entries, dip);
    const drawOrder = VH.monuments.occlusionOrder(entries);
    // Warm ground pool under a near-miss arrangement — the peripheral
    // "where" signal the dog used to provide. One gradient, not one per
    // block; same idiom as the lamp under-glow below.
    if (W.warmCenter) {
      const wt = 7 - (clock.time - W.warmCenter.at);
      if (wt > 0) {
        const env = Math.min(1, wt / 1.5);
        const pulse = E.reducedMotion ? 0.65 : 0.5 + 0.5 * Math.sin(clock.time * 4.2);
        const c = E.toScreen(W.warmCenter.gx, W.warmCenter.gy, 0); // already the arrangement's center
        E.addLight(c.x, c.y, E.TILE * E.SCALE * 3.5, '255,217,104',
          0.11 * env * (0.7 + 0.3 * pulse));
      }
    }
    // Lamp light: a wide warm pool + a tighter bright halo above the lamp.
    // Both are LIGHTS (rendered by the bloom pass), not painted gradients.
    W.blocks.forEach(b => {
      if (b.color !== 'lamp' || !W.isLive(b)) return;
      if (b.dropping && b.dropDelay > 0) return; // not on stage yet
      const z = b.gz + (b.dropOffset || 0);
      const flicker = E.reducedMotion
        ? 1 : 0.85 + 0.15 * Math.sin(clock.time * 3.1 + b.gx * 2 + b.gy);
      const pool = E.toScreen(b.gx + 0.5, b.gy + 0.5, z + 0.5);
      E.addLight(pool.x, pool.y, E.TILE * E.SCALE * 3, '255,196,90', 0.16 * flicker);
      const top = E.toScreen(b.gx + 0.5, b.gy + 0.5, z + 1.1);
      E.addLight(top.x, top.y, E.TILE * E.SCALE * 1.1, '255,228,150', 0.35);
    });

    drawOrder.forEach(oi => {
      const entry = entries[oi];
      if (entry.draw) { entry.draw(); return; } // a monument piece
      const b = entry.b;
      if (b.dropping && b.dropDelay > 0) return; // hasn't entered yet
      const isGlass = b.color === 'glass';
      const drawOpacity = isGlass ? b.opacity * 0.55 : b.opacity;
      const squashOpts = {
        styled: true,
        shade: b.shade,
        // baseSxy/baseSz keep monument debris in its piece's proportions
        sxy: (1 + b.squash * 0.7) * b.baseSxy,
        sz: (1 - b.squash) * b.baseSz,
        warmT: Math.max(0, b.warmUntil - clock.time), // near-miss shimmer
      };
      if (b.blasting) {
        drawBlastingBlock(b, drawOpacity, squashOpts);
      } else {
        const settled = !b.dropping && b.lift < 0.01;
        W.drawBlock(
          b.gx + (b.slideX || 0), b.gy + (b.slideY || 0),
          b.gz + (b.dropOffset || 0) + b.lift - dip,
          b.color, drawOpacity,
          { ...squashOpts, contact: settled && !isGlass }
        );
      }
    });

    // Monument glows (lighthouse lamp room, gold pyramidion)
    VH.monuments.drawGlows();

    // Transform ceremonies: state advances here; their DRAWING now lives
    // inside the depth-sorted pass above (pushEntries), so floaters and
    // the rising model occlude correctly instead of painting on top.
    VH.monuments.update(dt);

    // Blooms: ceremony flashes + firework detonations (behind the sparks)
    FX.updateAndDrawFlashes(dt);

    // Particles: landing dust + firework sparks
    FX.updateAndDrawDust(dt);

    // Ambient life
    FX.updateAndDrawFireflies(dt);

    // Placement preview while dragging: the block's real colours at the
    // landing spot, base diamond emphasised (resolveTarget only returns
    // on-platform cells, so no extra gate needed)
    if (isDragging && hoverGrid) {
      W.drawGhostBlock(hoverGrid.gx, hoverGrid.gy, hoverGrid.gz,
        dragBlock && dragBlock.color);
    }

    // Quiet hover preview (mouse only, no gesture in flight): where a
    // TAP would place a block — same resolver as the tap commit.
    if (!isDragging && !dragMon && activePointerId === null && hoverPreview) {
      W.drawGhostBlock(hoverPreview.gx, hoverPreview.gy, hoverPreview.gz,
        selectedType === 'color' ? chosenColor : selectedType, 0.5);
    }

    // Monument move preview: the whole structure ghosted at the
    // destination — its real colours when the drop is allowed, red when
    // the spot is blocked (releasing there refuses the move). A valid
    // plan previews at its resolved landing HEIGHT (on top of a plinth,
    // or down to the ground from a perch); a refused one stays at the
    // current height so the red ghost shows what you grabbed.
    if (dragMon && (dragMonDelta.dx || dragMonDelta.dy)) {
      const { dx, dy } = dragMonDelta;
      const dz = dragMonValid ? dragMonDz : 0;
      VH.monuments.orderedModel(dragMon).forEach(m => {
        W.drawBlock(m.gx + dx, m.gy + dy, m.gz + dz - dip,
          dragMonValid ? m.color : 'lightRed', 0.4, { sxy: m.sxy, sy: m.sy, sz: m.sz });
      });
    }

    // The carried block: pops on pickup, tilts with drag velocity.
    // With no valid target under it (the void, or a full stack) it tints
    // lightRed and dims — the same "refused" colour the monument ghost
    // uses — so "letting go here loses this" is said AT the cursor,
    // where the eye already is. Static tint: reduced-motion safe.
    if (isDragging && dragBlock) {
      const t = E.TILE * E.SCALE;
      const popT = Math.min((clock.time - dragStartTime) / 0.12, 1);
      const pop = 1 + 0.15 * (1 - Math.pow(1 - popT, 3)); // ease-out to 1.15×
      const tilt = Math.max(-0.14, Math.min(0.14, dragVelX * 0.00012));
      const doomed = !hoverGrid;
      ctx.save();
      ctx.translate(pointerScreen.x, pointerScreen.y - t);
      ctx.rotate(tilt);
      ctx.scale(pop, pop);
      W.drawBlockAtScreen(0, 0, doomed ? 'lightRed' : dragBlock.color,
        doomed ? 0.6 : 0.85);
      ctx.restore();
    }

    // The one light pass: blur the collected lights, add them over the
    // scene. Leaves the context state clean (postcard export reads it).
    E.lightComposite();

    if (perfMon) perfMon.frame(__perfT0, nowMs);
    requestAnimationFrame(render);
  }

  // DEV hooks: deterministic placement/probing for testing, reachable from
  // the test harness's isolated world via DOM events. Active ONLY with #dev
  // in the URL so they're inert for real visitors.
  if (location.hash === '#dev') {
  document.addEventListener('vh-dev-state', () => {
    const counts = { total: W.blocks.length, dropping: 0, delayed: 0, blasting: 0, zeroOpacity: 0 };
    W.blocks.forEach(b => {
      if (b.dropping) counts.dropping++;
      if (b.dropping && b.dropDelay > 0) counts.delayed++;
      if (b.blasting) counts.blasting++;
      if (b.opacity <= 0) counts.zeroOpacity++;
    });
    console.log('[dev-state]', JSON.stringify(counts),
      'sample:', JSON.stringify(W.blocks.slice(0, 3).map(b =>
        ({ x: b.gx, y: b.gy, z: b.gz, c: b.color, drop: b.dropping, dd: +b.dropDelay.toFixed(2), off: +b.dropOffset.toFixed(2), op: b.opacity }))));
  });
  document.addEventListener('vh-dev-check', (e) => {
    const { gx, gy, gz } = e.detail || {};
    const m = VH.monuments.findMatchAt ? VH.monuments.findMatchAt(gx, gy, gz) : 'no-export';
    console.log('[dev-check]', gx, gy, gz,
      'cell:', (W.blockAt(gx, gy, gz) || {}).color || 'empty',
      'match:', m && m.recipe ? m.recipe.id : String(m));
  });
  document.addEventListener('vh-dev-place', (e) => {
    const { gx, gy, color } = e.detail || {};
    if (!W.isOnPlatform(gx, gy)) { console.log('[dev] off platform', gx, gy); return; }
    const gz = W.getStackHeight(gx, gy);
    if (gz > W.MAX_STACK) { console.log('[dev] column full', gx, gy); return; }
    const b = W.makeBlock(gx, gy, gz, { color: color || W.randomColor(), dropOffset: 0.8 });
    W.blocks.push(b);
    W.notifyPlaced(b);
    W.save();
  });
  // Gallery: instantly build a batch of monuments so every model can be
  // eyeballed at once (use vh-dev-rotate to check all four camera angles).
  // Batch 1 = the render-bug suspects, batch 2 = the known-good controls
  // (all 13 need ~108 of the platform's 121 cells, so they can't share).
  // Origins account for MODEL overhang, not just cells; a runtime
  // self-check warns if two models intersect so a layout typo can't be
  // mistaken for a render bug. Deliberately does NOT save — but any
  // placement afterwards will, clobbering the visitor's build. Dev-only.
  const GALLERY = {
    1: [['stonehenge', -4, -4], ['temple', 0, -3], ['arc', 4, -4],
        ['greatwall', -5, 0], ['eiffel', 1, 0], ['torii', -4, 3], ['crystal', 1, 3]],
    2: [['pyramid', -5, -4], ['colosseum', -1, -4], ['doghouse', 3, -4],
        ['gardens', -5, 1], ['lighthouse', -1, 1], ['obelisk', 1, 1]],
  };
  document.addEventListener('vh-dev-gallery', (e) => {
    const batch = (e.detail && e.detail.batch) || 1;
    const layout = GALLERY[batch];
    if (!layout) { console.log('[dev-gallery] no batch', batch); return; }
    VH.monuments.clearCeremonies();
    W.blocks = [];
    W.monuments = [];
    layout.forEach(([id, ox, oy]) => {
      const recipe = VH.monuments.RECIPES.find(r => r.id === id);
      VH.monuments.instantiate(recipe, ox, oy, 0, 0);
      VH.monuments.discovered.add(id);
    });
    W.markDirty();
    VH.monuments.buildCodex();
    const boxes = [];
    W.monuments.forEach(mon => mon.model.forEach(p =>
      boxes.push({ id: mon.id, box: E.pieceAABB(p.gx, p.gy, p.gz, p.sxy, p.sz, p.sy) })));
    for (let a = 0; a < boxes.length; a++) {
      for (let b = a + 1; b < boxes.length; b++) {
        if (boxes[a].id !== boxes[b].id && E.aabbOverlap(boxes[a].box, boxes[b].box, 0)) {
          console.warn('[dev-gallery] LAYOUT OVERLAP', boxes[a].id, '<>', boxes[b].id);
        }
      }
    }
    console.log('[dev-gallery] batch', batch + ':', layout.map(l => l[0]).join(', '));
  });
  // Snap the camera a quarter turn (render bugs are angle-dependent)
  document.addEventListener('vh-dev-rotate', (e) => {
    const steps = (e.detail && e.detail.steps) || 1;
    cam.cancelTween();
    cam.snapTo(cam.nearestSnap() + steps * Math.PI / 2, 0.001);
  });
  // Physics invariant tripwire: the grid engine must NEVER produce two
  // A monument that loses its footing lands with the same feedback as a
  // drag commit (dip, dust, tock) — it settles with weight rather than
  // teleporting. No save here: every interactive path that can trigger a
  // fall saves on its own, and W.load() calls resettle too — saving from
  // inside load would be writing while reading.
  W.onMonumentLanded = (mon) => {
    if (!E.reducedMotion) {
      W.kickDip(0.8);
      const c0 = mon.cells[0];
      if (VH.fx) VH.fx.spawnDust(c0.gx, c0.gy, 0, 10);
    }
    if (VH.sfx) VH.sfx.tock(0, 0.9);
  };

  // settled blocks in one cell, a block inside a monument's volume, or an
  // unsupported block that isn't falling. Runs continuously under #dev;
  // fire 'vh-dev-invariant' for an on-demand report.
  function checkInvariants() {
    const seen = new Map();
    const bad = [];
    W.blocks.forEach(b => {
      if (!W.isLive(b) || b.dropping || b.isDebris) return;
      const k = b.gx + ',' + b.gy + ',' + b.gz;
      if (seen.has(k)) bad.push('two blocks @ ' + k);
      seen.set(k, b);
      const v = W.at(b.gx, b.gy, b.gz);
      if (v && v.color === undefined) bad.push('block inside monument @ ' + k);
      if (b.gz > 0 && !W.settledAt(b.gx, b.gy, b.gz - 1)) bad.push('floater @ ' + k);
    });
    // Monuments too — the 2026-08-24 floating obelisk was invisible to
    // every automated check because this loop only ever looked at blocks.
    W.monuments.forEach(m => {
      if (m.pending) return; // mid-ceremony bodies are the rise's business
      const bottoms = new Map();
      m.cells.forEach(c => {
        const ck = c.gx + ',' + c.gy;
        const cur = bottoms.get(ck);
        if (cur === undefined || c.gz < cur) bottoms.set(ck, c.gz);
      });
      let ok = false;
      bottoms.forEach((gz, ck) => {
        if (ok) return;
        if (gz <= 0) { ok = true; return; }
        const [bx, by] = ck.split(',').map(Number);
        const below = W.settledAt(bx, by, gz - 1);
        if (below !== undefined && below !== m) ok = true;
      });
      if (!ok) bad.push('floating monument (' + m.id + ') @ ' +
        m.cells[0].gx + ',' + m.cells[0].gy);
    });
    if (bad.length) console.warn('[invariant]', bad.join(' | '));
    return bad;
  }
  setInterval(() => checkInvariants(), 500);
  document.addEventListener('vh-dev-invariant', () => {
    const bad = checkInvariants();
    console.log('[invariant]', bad.length ? bad : 'clean',
      '| blocks', W.blocks.length, '| monuments', W.monuments.length);
  });
  // Live lighting tuning: adjust the knobs without a reload, so
  // look-review can iterate in seconds while the reviewer watches.
  // gain/blur = bloom; moon = altitude (lower = longer raking shadows +
  // darker sides, one physically-coupled knob); shadow = darkness.
  document.addEventListener('vh-dev-light', (e) => {
    const d = e.detail || {};
    if (d.gain !== undefined) E.LIGHT_GAIN = d.gain;
    if (d.blur !== undefined) E.LIGHT_BLUR = d.blur;
    if (d.moon !== undefined) E.MOON_ALT = d.moon;
    if (d.shadow !== undefined) E.SHADOW_STRENGTH = d.shadow;
    console.log('[dev-light] gain', E.LIGHT_GAIN, 'blur', E.LIGHT_BLUR,
      'moon', E.MOON_ALT, 'shadow', E.SHADOW_STRENGTH);
  });
  // Live audio tuning: the mix dials most likely to need review iteration
  // (wet = reverb amount, spread = stereo width, master = pre-limiter
  // level, amb = ambience bed level), adjustable while the reviewer
  // listens — same idiom as vh-dev-light.
  document.addEventListener('vh-dev-audio', (e) => {
    console.log('[dev-audio]', JSON.stringify(VH.sfx.tune(e.detail || {})));
  });
  // Synthetic barrage: N detonations spread over ~0.5 s at random board
  // positions, to exercise the boom coalescer without building a board.
  document.addEventListener('vh-dev-barrage', (e) => {
    const n = (e.detail && e.detail.n) || 30;
    VH.sfx.beginBarrage(n);
    for (let i = 0; i < n; i++) {
      setTimeout(() => {
        const gx = W.GRID_MIN + Math.random() * (W.GRID_MAX - W.GRID_MIN);
        const gy = W.GRID_MIN + Math.random() * (W.GRID_MAX - W.GRID_MIN);
        const gz = 4 + Math.random() * 8;
        VH.sfx.boom(Math.min(1.3, 0.6 + gz * 0.05), { gx, gy, gz });
      }, 400 + Math.random() * 500);
    }
    console.log('[dev-barrage] firing', n, 'shells');
  });
  // Buildability harness: PLAYS every recipe through the real placement →
  // settle → match path, in several build orders, stepping physics manually
  // (a hidden tab pauses rAF, so the test drives the clock itself). Asserts
  // the RIGHT monument forms, and only on the FINAL block — a mid-build
  // transformation is the exact signature of one recipe stealing another.
  // vh-dev-gallery can't catch this: it instantiates monuments directly,
  // proving they RENDER, not that a player can reach them.
  document.addEventListener('vh-dev-buildable', () => {
    const M = VH.monuments;
    const savedBuild = localStorage.getItem('vh-build-v1');
    const savedDiscovered = new Set(M.discovered);
    const results = [];
    let simMs = (VH.clock.last || 0) + 16;
    const stepFrames = (n) => {
      for (let i = 0; i < n; i++) {
        simMs += 1000 / 60;
        VH.clock.tick(simMs);
        W.updateBlocks(1 / 60);
        M.update(1 / 60);
      }
    };
    // 'blue' satisfies every '*' in play: plain (arc's plainOnly), not
    // glass/lamp (obelisk's notColors), and same across a build (sameColor)
    const orders = {
      'rows-ltr': (cells) => [...cells].sort((a, b) => a[2] - b[2] || a[1] - b[1] || a[0] - b[0]),
      'rows-rtl': (cells) => [...cells].sort((a, b) => a[2] - b[2] || a[1] - b[1] || b[0] - a[0]),
      'columns': (cells) => [...cells].sort((a, b) => a[1] - b[1] || a[0] - b[0] || a[2] - b[2]),
      'outside-in': (cells) => {
        const mx = cells.reduce((s, c) => s + c[0], 0) / cells.length;
        const my = cells.reduce((s, c) => s + c[1], 0) / cells.length;
        const d = (c) => Math.abs(c[0] - mx) + Math.abs(c[1] - my);
        return [...cells].sort((a, b) => a[2] - b[2] || d(b) - d(a));
      },
    };
    // By-design exception: a pyramid base built ring-first IS a colosseum —
    // its empty heart is satisfied, which the match rule treats as intent.
    const expected = { 'pyramid/outside-in': 'colosseum' };
    E.updateFaceVectors();
    for (const r of M.RECIPES) {
      for (const oname of Object.keys(orders)) {
        M.clearCeremonies();
        W.blocks = []; W.monuments = []; W.warmCenter = null;
        W.markDirty();
        M.discovered.clear(); // deferral + hints key off discovery state
        const seq = orders[oname](r.cells);
        let stolen = null;
        for (let i = 0; i < seq.length; i++) {
          const c = seq[i];
          const b = W.makeBlock(c[0], c[1], c[2],
            { color: c[3] === '*' ? 'blue' : c[3], dropOffset: 0.8 });
          W.blocks.push(b);
          W.notifyPlaced(b);
          stepFrames(45); // fall + settle + match
          if (W.monuments.length && i < seq.length - 1) {
            stolen = W.monuments[0].id;
            break;
          }
        }
        stepFrames(140); // let any ceremony + leftover sweep finish
        const formed = W.monuments.map(m => m.id);
        const want = expected[r.id + '/' + oname];
        const verdict = stolen
          ? (want === stolen ? 'known: ' + stolen : 'STOLEN by ' + stolen)
          : (formed.length === 1 && formed[0] === r.id ? 'PASS'
            : formed.length === 0 ? 'NO MATCH' : 'WRONG: ' + formed.join('+'));
        results.push({ recipe: r.id, order: oname, verdict });
      }
    }
    // Restore the visitor's world + discoveries exactly as they were
    M.clearCeremonies();
    W.blocks = []; W.monuments = [];
    M.discovered.clear();
    savedDiscovered.forEach(id => M.discovered.add(id));
    if (savedBuild !== null) localStorage.setItem('vh-build-v1', savedBuild);
    else localStorage.removeItem('vh-build-v1');
    W.load();
    M.buildCodex();
    VH.clock.last = null; // the harness drove the clock ahead; re-baseline on the next real frame
    const bad = results.filter(x => x.verdict !== 'PASS' && !x.verdict.startsWith('known'));
    console.log('[dev-buildable]', bad.length ? bad.length + ' FAILURE(S)' : 'all pass');
    console.table(results);
    document.dispatchEvent(new CustomEvent('vh-dev-buildable-done', { detail: { results, bad } }));
  });
  // Neighbour-landing harness: instantiates every monument, drops blocks
  // into every column touching it (8-neighbourhood of its recipe columns),
  // stacks 3 high through the real gravity/settle path, and asserts each
  // block settles on REAL support: the ground, another block, or a monument
  // cell the model GENUINELY fills — judged by recomputing piece coverage,
  // NOT by trusting mon.blocked. That distinction is the whole test: the
  // floating-block bug (2026-08-24) put grazed tiles into blocked, so
  // settledAt vouched for the floater and vh-dev-invariant stayed green.
  // The MATCHER is deliberately not engaged (no notifyPlaced): blue
  // 3-stacks ringing a monument form real arcs and great walls, whose
  // ceremonies consumed the evidence blocks and returned a hollow PASS on
  // this harness's first run. Physics under test, matching out of scope.
  // The coverage threshold is a LOCAL constant so the harness stays
  // honest if M.CLAIM_COVER_MIN is toggled (set it to 0 in the console to
  // reproduce the bug; this harness must flag it).
  document.addEventListener('vh-dev-neighbours', () => {
    const M = VH.monuments;
    const GENUINE_COVER = 0.30; // deliberate copy of M.CLAIM_COVER_MIN — see above
    const savedBuild = localStorage.getItem('vh-build-v1');
    const savedDiscovered = new Set(M.discovered);
    const results = [];
    let simMs = (VH.clock.last || 0) + 16;
    const stepFrames = (n) => {
      for (let i = 0; i < n; i++) {
        simMs += 1000 / 60;
        VH.clock.tick(simMs);
        W.updateBlocks(1 / 60);
        M.update(1 / 60);
      }
    };
    E.updateFaceVectors();
    for (const r of M.RECIPES) {
      M.clearCeremonies();
      W.blocks = []; W.monuments = []; W.warmCenter = null;
      W.markDirty();
      const mon = M.instantiate(r, 0, 0, 0, 0);
      const ownCells = new Set(mon.cells.map(c => c.gx + ',' + c.gy + ',' + c.gz));
      const claimed = new Set([...ownCells,
        ...(mon.blocked || []).map(c => c.gx + ',' + c.gy + ',' + c.gz)]);
      const cols = new Set(mon.cells.map(c => c.gx + ',' + c.gy));
      // Does some piece SOLIDLY sit in this cell AND cover ≥ GENUINE_COVER
      // of its ground area? Geometry from M.perchUnder — the ONE shared
      // perch test — with the harness's own LOCAL threshold, so toggling
      // M.CLAIM_COVER_MIN can't blind it. (Foreign columns only — own
      // columns may be arbitrarily thin: spire tips are legitimate.)
      const genuinelyFilled = (gx, gy, gz) =>
        M.perchUnder(gx, gy, gz + 1).cover >= GENUINE_COVER;
      const targets = new Set();
      cols.forEach(k => {
        const [x, y] = k.split(',').map(Number);
        for (let dx = -1; dx <= 1; dx++) for (let dy = -1; dy <= 1; dy++) {
          const nk = (x + dx) + ',' + (y + dy);
          if (!cols.has(nk) && W.isOnPlatform(x + dx, y + dy)) targets.add(nk);
        }
      });
      let dropped = 0;
      targets.forEach(k => {
        const [gx, gy] = k.split(',').map(Number);
        for (let n = 0; n < 3; n++) {
          const gz = W.getStackHeight(gx, gy);
          if (gz > W.MAX_STACK) break;
          const b = W.makeBlock(gx, gy, gz, { color: 'blue', dropOffset: 0.8 });
          W.blocks.push(b);
          W.markDirty(); // no notifyPlaced — see the matcher note above
          dropped++;
        }
      });
      stepFrames(120); // fall + settle everywhere
      const bad = [];
      if (W.monuments.length > 1) bad.push('a monument formed mid-test — matcher leaked in');
      W.blocks.forEach(b => {
        if (!W.isLive(b) || b.isDebris) return;
        const at = b.gx + ',' + b.gy + ',' + b.gz;
        if (b.dropping) { bad.push(at + ' never settled'); return; }
        if (b.gz === 0) return;                              // the ground
        if (W.blockAt(b.gx, b.gy, b.gz - 1)) return;         // another block
        const bx = b.gx, by = b.gy, bz = b.gz - 1;
        const below = bx + ',' + by + ',' + bz;
        if (ownCells.has(below)) return;                     // recipe cell
        if (cols.has(bx + ',' + by) && claimed.has(below)) return; // own column
        if (genuinelyFilled(bx, by, bz)) return;             // real foreign fill
        bad.push(at + ' floats — nothing real underneath');
      });
      const alive = W.blocks.filter(b => W.isLive(b) && !b.isDebris).length;
      if (alive !== dropped) bad.push('dropped ' + dropped + ' but only ' + alive + ' survived');
      results.push({
        recipe: r.id, columns: targets.size, dropped, alive,
        verdict: bad.length ? 'FAIL: ' + bad.join(' | ') : 'PASS',
      });
    }
    // Restore the visitor's world + discoveries exactly as they were
    M.clearCeremonies();
    W.blocks = []; W.monuments = [];
    M.discovered.clear();
    savedDiscovered.forEach(id => M.discovered.add(id));
    if (savedBuild !== null) localStorage.setItem('vh-build-v1', savedBuild);
    else localStorage.removeItem('vh-build-v1');
    W.load();
    M.buildCodex();
    VH.clock.last = null; // the harness drove the clock ahead; re-baseline on the next real frame
    const bad = results.filter(x => x.verdict !== 'PASS');
    console.log('[dev-neighbours]', bad.length ? bad.length + ' FAILURE(S)' : 'all pass');
    console.table(results);
    document.dispatchEvent(new CustomEvent('vh-dev-neighbours-done', { detail: { results, bad } }));
  });
  // Weight harness: monuments must FALL when unsupported and STAY when
  // supported. Four checks per recipe: (1) instantiated one cell up with
  // nothing beneath → lands on the ground, shape intact; (2) instantiated
  // one cell up resting on a single block → stays (ANY supported column
  // holds the whole body — the partial-ledge rule); (3) that block removed
  // → now it lands; (4) after landing, the blocked volume was RE-DERIVED
  // at the new height, not left stale. This is the harness the floating
  // obelisk (2026-08-24) would have failed.
  document.addEventListener('vh-dev-weight', () => {
    const M = VH.monuments;
    const savedBuild = localStorage.getItem('vh-build-v1');
    const savedDiscovered = new Set(M.discovered);
    const results = [];
    const minGz = (mon) => Math.min(...mon.cells.map(c => c.gz));
    const shape = (mon) => mon.cells.map(c => (c.gx + 9) + ',' + (c.gy + 9) + ',' + c.gz)
      .sort().join('|');
    const reset = () => {
      M.clearCeremonies();
      W.blocks = []; W.monuments = []; W.warmCenter = null;
      W.markDirty();
    };
    E.updateFaceVectors();
    for (const r of M.RECIPES) {
      const bad = [];
      // (1) unsupported at oz=1 → lands at 0, same shape one cell lower
      reset();
      let mon = M.instantiate(r, 0, 0, 1, 0);
      const before = shape(mon);
      W.resettle();
      if (minGz(mon) !== 0) bad.push('did not land (minGz ' + minGz(mon) + ')');
      const after = shape(mon);
      const expected = before.replace(/,(\d+)(?=\||$)/g, (s, z) => ',' + (Number(z) - 1));
      if (after !== expected) bad.push('shape changed while falling');
      // (2) supported by one block under one column → stays put
      reset();
      const sup = W.makeBlock(r.cells[0][0], r.cells[0][1], 0, { color: 'blue', dropOffset: 0 });
      sup.dropping = false; W.blocks.push(sup); W.markDirty();
      mon = M.instantiate(r, 0, 0, 1, 0);
      W.resettle();
      if (minGz(mon) !== 1) bad.push('fell despite support (minGz ' + minGz(mon) + ')');
      // (3) the support removed → lands
      W.removeBlock(sup);
      W.resettle();
      if (minGz(mon) !== 0) bad.push('did not land after losing support (minGz ' + minGz(mon) + ')');
      // (4) blocked re-derived at the new height
      const fresh = M.blockedCellsFor(mon.model, mon.cells)
        .map(c => c.gx + ',' + c.gy + ',' + c.gz).sort().join('|');
      const held = (mon.blocked || [])
        .map(c => c.gx + ',' + c.gy + ',' + c.gz).sort().join('|');
      if (fresh !== held) bad.push('blocked volume is stale after landing');
      if ((mon.blocked || []).some(c => c.gz < 0)) bad.push('blocked cell below the floor');
      results.push({ recipe: r.id, verdict: bad.length ? 'FAIL: ' + bad.join(' | ') : 'PASS' });
    }
    // Restore the visitor's world + discoveries exactly as they were
    M.clearCeremonies();
    W.blocks = []; W.monuments = [];
    M.discovered.clear();
    savedDiscovered.forEach(id => M.discovered.add(id));
    if (savedBuild !== null) localStorage.setItem('vh-build-v1', savedBuild);
    else localStorage.removeItem('vh-build-v1');
    W.load();
    M.buildCodex();
    const bad = results.filter(x => x.verdict !== 'PASS');
    console.log('[dev-weight]', bad.length ? bad.length + ' FAILURE(S)' : 'all pass');
    console.table(results);
    document.dispatchEvent(new CustomEvent('vh-dev-weight-done', { detail: { results, bad } }));
  });
  // Tumble harness: drop one block onto every footprint column of every
  // monument and assert it ends on HONEST footing — the ground, another
  // block, or a monument surface that passes M.perchUnder — never hovering,
  // never lost, never past the hop cap. Crystal and doghouse blocks STAY
  // on top (good perch); the rest roll off. Set W.TUMBLE = false and
  // re-run to prove the harness bites (blocks hover, it fails). The
  // matcher is not engaged (no notifyPlaced): tumbled blocks scattering
  // around a monument could line up into a real great wall and consume
  // the evidence — the lesson vh-dev-neighbours already paid for.
  document.addEventListener('vh-dev-tumble', () => {
    const M = VH.monuments;
    const savedBuild = localStorage.getItem('vh-build-v1');
    const savedDiscovered = new Set(M.discovered);
    const results = [];
    let simMs = (VH.clock.last || 0) + 16;
    const stepFrames = (n) => {
      for (let i = 0; i < n; i++) {
        simMs += 1000 / 60;
        VH.clock.tick(simMs);
        W.updateBlocks(1 / 60);
        M.update(1 / 60);
      }
    };
    E.updateFaceVectors();
    for (const r of M.RECIPES) {
      M.clearCeremonies();
      W.blocks = []; W.monuments = []; W.warmCenter = null;
      W.markDirty();
      const mon = M.instantiate(r, 0, 0, 0, 0);
      const cols = new Map();
      mon.cells.forEach(c => { const k = c.gx + ',' + c.gy; if (!cols.has(k)) cols.set(k, [c.gx, c.gy]); });
      let dropped = 0;
      cols.forEach(([gx, gy]) => {
        const gz = W.getStackHeight(gx, gy);
        if (gz > W.MAX_STACK) return;
        const b = W.makeBlock(gx, gy, gz, { color: 'blue', dropOffset: 0.8 });
        W.blocks.push(b);
        W.markDirty();
        dropped++;
      });
      stepFrames(300); // land, teeter, roll — up to the full hop cap
      const bad = [];
      let alive = 0;
      W.blocks.forEach(b => {
        if (!W.isLive(b) || b.isDebris) return;
        alive++;
        const at = b.gx + ',' + b.gy + ',' + b.gz;
        if (b.dropping) { bad.push(at + ' never settled'); return; }
        if ((b.tumbles || 0) > 4) { bad.push(at + ' exceeded the hop cap'); return; }
        if (b.gz === 0) return;
        if (W.blockAt(b.gx, b.gy, b.gz - 1)) return;
        const p = M.perchUnder(b.gx, b.gy, b.gz);
        if (p.cover >= M.PERCH_MIN_COVER && p.gap <= M.PERCH_MAX_GAP) return;
        bad.push(at + ' hovers on a bad perch (cover ' +
          Math.round(p.cover * 100) + '%, gap ' + p.gap.toFixed(2) + ')');
      });
      if (alive !== dropped) bad.push('dropped ' + dropped + ' but ' + alive + ' survived');
      results.push({ recipe: r.id, dropped, verdict: bad.length ? 'FAIL: ' + bad.join(' | ') : 'PASS' });
    }
    // Restore the visitor's world + discoveries exactly as they were
    M.clearCeremonies();
    W.blocks = []; W.monuments = [];
    M.discovered.clear();
    savedDiscovered.forEach(id => M.discovered.add(id));
    if (savedBuild !== null) localStorage.setItem('vh-build-v1', savedBuild);
    else localStorage.removeItem('vh-build-v1');
    W.load();
    M.buildCodex();
    VH.clock.last = null; // the harness drove the clock ahead; re-baseline on the next real frame
    const bad = results.filter(x => x.verdict !== 'PASS');
    console.log('[dev-tumble]', bad.length ? bad.length + ' FAILURE(S)' : 'all pass');
    console.table(results);
    document.dispatchEvent(new CustomEvent('vh-dev-tumble-done', { detail: { results, bad } }));
  });
  // Monument-stacking harness: exercises monumentMovePlan + the REAL
  // commit path (applyMonumentMove). Lighthouse onto one cube: allowed,
  // sits at z1, gravity keeps it. Pyramid onto one cube: refused (flat-
  // surface rule). Pyramid onto a full 3×3 plinth: allowed. A raised
  // monument dragged to open ground comes DOWN (negative dz). A monument
  // may never stand on another monument (cubes-or-ground rule).
  document.addEventListener('vh-dev-monstack', () => {
    const M = VH.monuments;
    const savedBuild = localStorage.getItem('vh-build-v1');
    const savedDiscovered = new Set(M.discovered);
    const bad = [];
    const check = (name, cond) => { if (!cond) bad.push(name); };
    const reset = () => {
      M.clearCeremonies();
      W.blocks = []; W.monuments = []; W.warmCenter = null;
      W.markDirty();
    };
    const solidBlock = (gx, gy, gz) => {
      const b = W.makeBlock(gx, gy, gz, { color: 'blue', dropOffset: 0 });
      b.dropping = false; W.blocks.push(b); W.markDirty();
      return b;
    };
    const minGz = (mon) => Math.min(...mon.cells.map(c => c.gz));
    E.updateFaceVectors();
    // 1. lighthouse onto ONE cube
    reset();
    solidBlock(3, 3, 0);
    let mon = M.instantiate(M.RECIPES.find(x => x.id === 'lighthouse'), 0, 0, 0, 0);
    let plan = monumentMovePlan(mon, 3, 3);
    check('lighthouse onto a cube should be allowed at dz 1', plan.ok && plan.dz === 1);
    if (plan.ok) {
      applyMonumentMove(mon, 3, 3, plan.dz);
      check('lighthouse should sit at z1 and stay (gravity agrees)', minGz(mon) === 1);
    }
    // 2. pyramid onto a single cube: flat-surface rule refuses
    reset();
    solidBlock(4, 4, 0);
    mon = M.instantiate(M.RECIPES.find(x => x.id === 'pyramid'), 0, 0, 0, 0);
    check('pyramid onto one cube should be refused', !monumentMovePlan(mon, 3, 3).ok);
    // 3. pyramid onto a full 3×3 plinth
    reset();
    for (let x = 3; x <= 5; x++) for (let y = 3; y <= 5; y++) solidBlock(x, y, 0);
    mon = M.instantiate(M.RECIPES.find(x => x.id === 'pyramid'), 0, 0, 0, 0);
    plan = monumentMovePlan(mon, 3, 3);
    check('pyramid onto a 3×3 plinth should be allowed at dz 1', plan.ok && plan.dz === 1);
    if (plan.ok) {
      applyMonumentMove(mon, 3, 3, plan.dz);
      check('pyramid should sit at z1 on the plinth', minGz(mon) === 1);
    }
    // 4. a raised monument dragged to open ground comes DOWN
    reset();
    solidBlock(3, 3, 0);
    mon = M.instantiate(M.RECIPES.find(x => x.id === 'lighthouse'), 0, 0, 0, 0);
    plan = monumentMovePlan(mon, 3, 3);
    if (plan.ok) applyMonumentMove(mon, 3, 3, plan.dz);
    plan = monumentMovePlan(mon, -6, -6);
    check('raised monument to open ground should resolve dz -1', plan.ok && plan.dz === -1);
    if (plan.ok) {
      applyMonumentMove(mon, -6, -6, plan.dz);
      check('it should come down to z0', minGz(mon) === 0);
    }
    // 5. never onto another monument
    reset();
    M.instantiate(M.RECIPES.find(x => x.id === 'colosseum'), 0, 0, 0, 0);
    mon = M.instantiate(M.RECIPES.find(x => x.id === 'lighthouse'), 5, 5, 0, 0);
    check('monument onto a monument should be refused', !monumentMovePlan(mon, -5, -5).ok);
    // Restore the visitor's world + discoveries exactly as they were
    reset();
    M.discovered.clear();
    savedDiscovered.forEach(id => M.discovered.add(id));
    if (savedBuild !== null) localStorage.setItem('vh-build-v1', savedBuild);
    else localStorage.removeItem('vh-build-v1');
    W.load();
    M.buildCodex();
    console.log('[dev-monstack]', bad.length ? bad.length + ' FAILURE(S): ' + bad.join(' | ') : 'all pass');
    document.dispatchEvent(new CustomEvent('vh-dev-monstack-done', { detail: { bad } }));
  });
  // Perf sampler: measures REAL frame cost over N frames — render() JS time,
  // rAF delta, and gradient allocations per frame (counted by wrapping the
  // context prototype, so offscreen buffers are counted too). Measure with
  // the window in FRONT: a hidden tab pauses rAF and the numbers lie.
  document.addEventListener('vh-dev-perf', (e) => {
    if (perfMon) { console.warn('[dev-perf] already sampling'); return; }
    const frames = (e.detail && e.detail.frames) || 300;
    const label = (e.detail && e.detail.label) || '';
    const proto = CanvasRenderingContext2D.prototype;
    const origRad = proto.createRadialGradient;
    const origLin = proto.createLinearGradient;
    let radCount = 0, linCount = 0;
    proto.createRadialGradient = function (...a) { radCount++; return origRad.apply(this, a); };
    proto.createLinearGradient = function (...a) { linCount++; return origLin.apply(this, a); };
    const renderMs = [], deltas = [], rads = [], lins = [];
    let lastNow = null;
    perfMon = {
      frame(t0, nowMs) {
        renderMs.push(performance.now() - t0);
        if (lastNow !== null) deltas.push(nowMs - lastNow);
        lastNow = nowMs;
        rads.push(radCount); lins.push(linCount);
        radCount = 0; linCount = 0;
        if (renderMs.length < frames) return;
        proto.createRadialGradient = origRad;
        proto.createLinearGradient = origLin;
        perfMon = null;
        const avg = a => a.reduce((s, v) => s + v, 0) / a.length;
        const p95 = a => [...a].sort((x, y) => x - y)[Math.floor(a.length * 0.95)];
        console.log(`[dev-perf${label ? ' ' + label : ''}]`, JSON.stringify({
          frames,
          renderMsAvg: +avg(renderMs).toFixed(3),
          renderMsP95: +p95(renderMs).toFixed(3),
          frameDeltaAvg: +avg(deltas).toFixed(2),
          fps: +(1000 / avg(deltas)).toFixed(1),
          radialGradAvg: +avg(rads).toFixed(1),
          radialGradPeak: Math.max(...rads),
          linearGradAvg: +avg(lins).toFixed(1),
        }));
      },
    };
    console.log('[dev-perf] sampling', frames, 'frames…');
  });
  } // end #dev hooks

  // ── The entrance: the wave, then the last block ─────────────
  // First visit only. All 24 wave blocks release together; each one's
  // delay comes from its distance to the far corner, bucketed into four
  // phrases ~90 ms apart, so the arrival sweeps across the island as one
  // physical event instead of a uniform tick (a cascade with no origin
  // reads as loading, not arrival). Then a held beat of stillness — and
  // ONE block falls alone onto open grass with the game's full landing
  // weight: a wordless demonstration of the verb the visitor is about to
  // perform. Reduced motion: makeBlock zeroes all travel, blocks appear
  // in place, and the hero hook is never attached.
  // Tuning knobs, gathered so the timing can be felt and adjusted in one
  // place. Phrase gap and PAUSE are the two that decide whether this
  // reads as an EVENT or as a loading spinner.
  const ENT = {
    PHRASE: 0.16,     // seconds between the wave's four groups
    PAUSE: 0.48,      // stillness after the wave, before the last block
    HERO_DROP: 20,    // grid units — starts above the frame, falls INTO it
    HERO_STOP: 0.09,  // hit-stop held on the moment of impact
    DIP: 1.2, SHAKE: 2.2, DUST: 14, SKY: 0.9,
  };

  function runEntrance() {
    const span = W.GRID_MAX - W.GRID_MIN;
    W.spawnBlocks(24, (gx, gy, gz) => {
      const d = (gx - W.GRID_MIN) + (gy - W.GRID_MIN); // Manhattan distance from the far corner
      const phrase = Math.min(3, Math.floor(d / (span / 2 + 0.01)));
      return {
        dropOffset: 6 + Math.random() * 2 + gz * 1.2,
        dropDelay: 0.15 + phrase * ENT.PHRASE + (Math.random() * 0.04 - 0.02),
      };
    });
    // The last block wants a CLEARING, not merely an empty tile: among 24
    // neighbours one more cube is invisible. Score every open tile by how
    // much empty grass surrounds it, biased toward the centre, so the
    // block that teaches the verb lands where the eye can find it.
    let tile = null, best = -Infinity;
    for (let gx = W.GRID_MIN; gx <= W.GRID_MAX; gx++) {
      for (let gy = W.GRID_MIN; gy <= W.GRID_MAX; gy++) {
        if (W.getStackHeight(gx, gy) !== 0) continue;
        let open = 0;
        for (let dx = -1; dx <= 1; dx++) {
          for (let dy = -1; dy <= 1; dy++) {
            if (!W.isOnPlatform(gx + dx, gy + dy) ||
                W.getStackHeight(gx + dx, gy + dy) === 0) open++;
          }
        }
        const centre = 1 - (Math.abs(gx) + Math.abs(gy)) / span;
        const score = open + centre * 2 + Math.random() * 0.5;
        if (score > best) { best = score; tile = [gx, gy]; }
      }
    }
    if (!tile) return; // no open ground (can't happen with 24 blocks) — the wave alone will do
    // Released after the wave has fully settled AND the pause has run.
    const waveLands = 0.15 + 3 * ENT.PHRASE + 0.24;
    const hero = W.makeBlock(tile[0], tile[1], 0, {
      dropOffset: ENT.HERO_DROP,
      dropDelay: waveLands + ENT.PAUSE,
    });
    if (!E.reducedMotion) {
      hero.onLand = () => {
        // Everything the game has for "this mattered", spent at once and
        // only here: the world stops dead for a beat on the squashed
        // frame, the ground flinches, the screen kicks, and the sky
        // answers (text stars hold their glow ~4× longer, so it lingers).
        W.kickHitStop(ENT.HERO_STOP);
        W.kickDip(ENT.DIP);
        E.kickShake(ENT.SHAKE);
        if (VH.fx) {
          VH.fx.spawnDust(tile[0], tile[1], 0, ENT.DUST);
          VH.fx.igniteStars(0.42, 0.08, 0.32, ENT.SKY);
        }
      };
    }
    W.blocks.push(hero);
    W.markDirty();
  }

  // ── Boot ────────────────────────────────────────────────────
  // #replay — forget the saved build so the FIRST-VISIT entrance runs
  // again. The hash is kept, so every reload replays it: the only
  // practical way to judge a 2-second sequence is to watch it 20 times.
  if (location.hash === '#replay') localStorage.removeItem('vh-build-v1');
  // Restore the visitor's saved build; fresh visitors get the entrance.
  const firstVisit = !W.load();
  if (firstVisit) {
    runEntrance();
    W.save();
  }
  VH.monuments.buildCodex(); // badge shows the right count from the start
  // Sound owns the screen-x projection; call sites just pass game objects.
  // (This is what pans a landing tock / a detonating shell to where it
  // actually is on screen — capped well short of hard L/R in sfx.)
  if (VH.sfx && VH.sfx.setProjector) {
    VH.sfx.setProjector((gx, gy, gz) => E.toScreen(gx, gy, gz).x / E.W);
  }
  requestAnimationFrame(render);

  // The first gesture is the moment the world gains its voice — audio is
  // browser-gated until a real interaction, so the entrance is silent by
  // policy and the first touch answers with the ambience swell + one
  // warm note (see sfx.unlock). {once}: it's a greeting, not a listener.
  const greet = () => { if (VH.sfx && VH.sfx.unlock) VH.sfx.unlock(); };
  window.addEventListener('pointerdown', greet, { once: true, capture: true });
  window.addEventListener('keydown', greet, { once: true, capture: true });

  // Build the audio graph (incl. generating the reverb — a few ms of
  // pure math that used to fire mid-cascade and stall the entrance) in
  // idle time AFTER everything has settled. The context stays suspended
  // and silent; if the visitor clicks sooner, unlock() builds it instead.
  setTimeout(() => {
    const idle = window.requestIdleCallback || ((fn) => setTimeout(fn, 200));
    idle(() => { if (VH.sfx && VH.sfx.prime) VH.sfx.prime(); });
  }, firstVisit ? 2600 : 1600);

  // UI entrance (CSS transitions; anime.js dependency removed)
  const panel = document.getElementById('panel');
  const controls = document.getElementById('controls');
  const hint = document.getElementById('hint');
  // Touch devices get touch words
  if (window.matchMedia('(pointer: coarse)').matches) {
    hint.textContent = 'Tap to place blocks · Drag to move · Some shapes become monuments';
  }
  // Codex opens by default on desktop so a visitor immediately sees there
  // are 13 monuments to find. Phones keep it shut — it would smother the
  // game there. Width alone is not the test: a phone in landscape is
  // 844px wide but still a phone, so coarse pointers stay shut at any
  // width. Timed to land AFTER .controls settles (600ms + 0.7s
  // transition) so it reads as emerging from the book icon.
  const codexAutoOpen = window.matchMedia('(min-width: 601px)').matches
    && !window.matchMedia('(pointer: coarse)').matches;
  if (E.reducedMotion) {
    panel.classList.add('show');
    controls.classList.add('show');
    hotbar.classList.add('show');
    hint.classList.add('show');
    uiReady = true;
    reflectSwatches();
    if (codexAutoOpen) openCodex();
  } else {
    // The interface waits for the WORLD. Two reasons: the panels'
    // backdrop blur re-samples the canvas behind them every frame, so
    // fading them in over 25 falling blocks was the most expensive thing
    // the old boot did — and choreographically, the world should finish
    // arriving before the interface offers itself. Also gated on the
    // fonts, so text can never re-flow inside a moving panel (the old
    // mid-transition font swap read as jank).
    const bootT = performance.now();
    // After the hero has landed and its bounces have settled (the canvas
    // owns the stage until the world is finished arriving).
    const uiAt = firstVisit ? 2150 : 500;
    Promise.race([
      document.fonts.ready,
      new Promise((res) => setTimeout(res, 1000)), // a font failure must never hold the UI
    ]).then(() => {
      const go = (offset, fn) =>
        setTimeout(fn, Math.max(0, bootT + uiAt + offset - performance.now()));
      go(0,    () => { panel.classList.add('show'); controls.classList.add('show'); });
      go(250,  () => { hotbar.classList.add('show'); uiReady = true; reflectSwatches(); });
      if (codexAutoOpen) go(500, openCodex);
      go(700,  () => { hint.classList.add('show'); });
      go(5900, () => { hint.classList.remove('show'); });
    });
  }
})();
