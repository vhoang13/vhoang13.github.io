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

  // ── Gofer hit testing ───────────────────────────────────────
  // Same shape as hitTestMonument, and for the same reason: he is boxes,
  // so the honest test is the real face quads, not a screen-space
  // approximation that can drift from the pixels. He hands back the very
  // boxes he draws (VH.gofer.hitBoxes), which returns null unless he is
  // STANDING — the mound and the mid-duck scale are never targets, and
  // taps pass through them to the core loop untouched.
  // `coarse` (touch pointers): his body projects to ~23×29 CSS px at
  // phone width — well under the 44px touch floor — so a miss falls
  // back to a circle around his chest. The slop lives HERE in input
  // land, not in hitBoxes(), which stays honest to the pixels.
  // Trade-off accepted: on touch, a near-miss beside a standing Abe
  // chats instead of placing a block — same shape as the documented
  // first-in-chain risk, and a mis-chat is one Escape to undo.
  const GOFER_TOUCH_SLOP = 22; // CSS px radius ≈ a 44px effective target
  function hitTestGofer(sx, sy, coarse) {
    // A hidden tab freezes the loop with E.fv empty; the first pointer
    // event after it comes back must not throw (seen in the console).
    if (!E.fv || !E.fv.ux) return null;
    const boxes = VH.gofer.hitBoxes();
    if (!boxes) return null;
    for (let i = 0; i < boxes.length; i++) {
      for (const q of monumentFaceQuads(boxes[i])) {
        if (E.pointInQuad(sx, sy, q[0], q[1], q[2], q[3])) return VH.gofer;
      }
    }
    if (coarse) {
      const a = VH.gofer.tapAnchor();
      if (a && Math.hypot(sx - a.x, sy - a.y) <= GOFER_TOUCH_SLOP) return VH.gofer;
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

  // Any zoom/pan change invalidates screen→grid state captured earlier:
  // same class of event as a keyboard rotate, same fix (see the arrow-key
  // handler's `hoverPreview = null` with the same comment). Mid-carry the
  // target is RE-DERIVED rather than nulled — releaseCarriedBlock's
  // no-target fall-through can reach the void branch, and a wheel tick
  // must never be what voids a block.
  E.onProjectionChange = () => {
    hoverPreview = null;
    W.hoveredMonument = null; // stale after zoom/pan; next mousemove re-derives
    if (isDragging) updateHoverTarget();
    else hoverGrid = null;
  };

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
      VH.gofer.noticePlacement(dragBlock.gx, dragBlock.gy);
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

  // Pressing the gofer arms a TAP. It commits on pointerup only when the
  // pointer never moved (!didDrag) and the gesture wasn't cancelled —
  // the same "a tap, not a drag" contract every other interaction keeps.
  // It can never coexist with pendingBlock/pendingMonument: a gofer hit
  // short-circuits both at pointerdown.
  let pendingGofer = false;

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

  // ── Pinch zoom (touch) ──────────────────────────────────────
  // The single-pointer discipline below stays load-bearing for every
  // GAME gesture — but the pinch bookkeeping runs BEFORE it, tracking
  // all canvas touch points. When a second finger lands, the in-flight
  // gesture is ABORTED through endPointer's cancelled path (the same
  // path a real pointercancel takes: every commit is guarded on
  // !cancelled, a carried block goes home, a monument drag is dropped
  // without moving). This matters: committing instead would mix grid
  // coordinates from two different projections, and for a monument
  // drag that mismatch reads as "thrown off the platform" — pinching
  // must never be able to destroy a monument.
  const touchPts = new Map(); // pointerId → canvas pos, canvas touches only
  let pinch = null;           // { d0, z0 } — start distance and start zoom

  canvas.addEventListener('pointerdown', (e) => {
    if (e.pointerType === 'touch') {
      touchPts.set(e.pointerId, eventPos(e));
      if (touchPts.size === 2) {
        if (activePointerId !== null) endPointer({ pointerId: activePointerId }, true);
        try { canvas.setPointerCapture(e.pointerId); } catch (_) { /* synthetic ids */ }
        const [a, b] = [...touchPts.values()];
        pinch = {
          d0: Math.hypot(a.x - b.x, a.y - b.y) || 1, z0: E.ZOOM,
          // midpoint drives the two-finger PAN: designer feedback — one
          // finger already means rotate, so moving around while zoomed
          // needs the second finger. Standard map-app behaviour: spread
          // to zoom, move both to pan, freely combined.
          mx: (a.x + b.x) / 2, my: (a.y + b.y) / 2,
        };
        return;
      }
      if (touchPts.size > 2) { try { canvas.setPointerCapture(e.pointerId); } catch (_) {} return; }
    }
    if (pinch) return; // no new gestures while a pinch is live
    if (activePointerId !== null) return; // one pointer drives; ignore extra touches
    activePointerId = e.pointerId;
    canvas.setPointerCapture(e.pointerId);
    hoverPreview = null; // a gesture owns the pointer now; recomputed on next hover

    const p = eventPos(e);
    pointerDownPos = p;
    pointerScreen = { ...p };
    didDrag = false;

    // The gofer goes FIRST. Accepted risk (plan §4): a surfaced gofer
    // overlapping a block steals the grab. Rare — he only surfaces on
    // empty tiles — and testing him last would make him untappable
    // whenever he stands in front of anything.
    const goferHit = hitTestGofer(p.x, p.y, e.pointerType === 'touch');
    pendingGofer = !!goferHit;
    const hit = goferHit ? null : hitTestBlock(p.x, p.y);
    const monHit = (goferHit || hit) ? null : hitTestMonument(p.x, p.y);
    if (goferHit) {
      // He is a LINK, not a handle: nothing is picked up, and the press
      // arms a tap that commits on pointerup. Rotation is armed too, so
      // dragging THROUGH him still turns the world like any other drag —
      // the tap only fires when the pointer never moved.
      isRotating = true;
      cam.cancelTween();
      rotateStartAngle = cam.angle;
      rotateStartX = p.x;
      canvas.style.cursor = 'pointer';
    } else if (hit) { // ANY visible block is grabbable — pull one out of the
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
    if (touchPts.has(e.pointerId)) {
      touchPts.set(e.pointerId, eventPos(e));
      if (pinch && touchPts.size >= 2) {
        const [a, b] = [...touchPts.values()];
        const d = Math.hypot(a.x - b.x, a.y - b.y) || 1;
        const mx = (a.x + b.x) / 2, my = (a.y + b.y) / 2;
        // zoom about the midpoint, then pan by the midpoint's travel —
        // spread-to-zoom and move-to-pan compose into one gesture
        E.setZoom(pinch.z0 * (d / pinch.d0), mx, my);
        E.panBy(mx - pinch.mx, my - pinch.my);
        pinch.mx = mx; pinch.my = my;
        return;
      }
    }
    const p = eventPos(e);
    pointerScreen.x = p.x;
    pointerScreen.y = p.y;

    if (e.pointerId !== activePointerId) {
      // Plain hover (mouse only): cursor + a gentle lift on the grabbable block
      if (activePointerId === null && e.pointerType === 'mouse') {
        // Same order as pointerdown, so what the cursor promises is
        // exactly what the press will claim.
        const goferHit = hitTestGofer(p.x, p.y);
        const hit = goferHit ? null : hitTestBlock(p.x, p.y);
        // Any block is grabbable now; buried ones skip the lift (no room
        // to rise — world.js gates it) but still get the grab cursor.
        // Monuments get the same lift treatment (monuments.js eases it),
        // so grabbable things all answer the cursor the same way.
        const monHit = (goferHit || hit) ? null : hitTestMonument(p.x, p.y);
        const grabbable = hit || monHit;
        // POINTER, not grab: he is somewhere to go, not something to
        // pick up, and the cursor is the whole desktop affordance for
        // "he'll take a tap" in the moment he is standing.
        canvas.style.cursor = goferHit ? 'pointer' : (grabbable ? 'grab' : 'default');
        W.hoveredBlock = hit || null;
        W.hoveredMonument = monHit || null;
        // The quiet preview: where a tap would place a block. Same
        // resolver as the drag target and the tap commit, so the three
        // can never disagree. Mouse only — touch has no hover.
        // ONE AFFORDANCE AT A TIME: over something grabbable the answer
        // is "pick this up" — the grab cursor and the hover lift already
        // say so — so the placement ghost stands down. Showing both at
        // once answered a question the visitor wasn't asking and read as
        // clutter exactly when they were aiming to grab.
        hoverPreview = (goferHit || grabbable) ? null : resolveTarget(p.x, p.y);
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
      W.hoveredMonument = null;
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
      W.hoveredMonument = null; // the drag owns it now; the lift eases home
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

    // Pressed a monument and released without moving: a TAP. On the two
    // company towers that opens their summary; every other monument
    // still does nothing, exactly as before (the press was an armed drag
    // that never started). Same !didDrag && !cancelled contract the
    // gofer tap keeps, so dragging a tower still just moves it.
    if (pendingMonument && !didDrag && !cancelled) openCompany(pendingMonument.id);
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
        VH.gofer.noticePlacement(col.gx, col.gy);
        W.save();
      }
      W.hoveredBlock = null;
      W.hoveredMonument = null;
      canvas.style.cursor = 'default';
      return;
    }
    pendingBlock = null;

    if (isDragging && dragBlock) {
      releaseCarriedBlock(cancelled);
    } else if (isRotating) {
      if (pendingGofer && !didDrag && !cancelled) {
        // TAPPED ABE. Digging is searching, surfacing is "found
        // something" — and this is the conversation. It used to
        // navigate to the case study, which ripped the visitor out of
        // the island they'd just been convinced to care about; now he
        // TALKS (chat.js), and the case study is a link in his panel.
        cam.angle = rotateStartAngle; // undo sub-threshold wiggle
        isRotating = false;
        pendingGofer = false;
        canvas.style.cursor = 'default';
        closeCodex(); // one panel at a time — they share the right edge
        closeCompany({ silent: true });
        VH.chat.open();
        return;
      }
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
          VH.gofer.noticePlacement(target.gx, target.gy);
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
    // Disarm: a drag through him, or a pinch/cancel, is not a tap.
    pendingGofer = false;
    W.hoveredBlock = null;
    W.hoveredMonument = null;
    canvas.style.cursor = 'default';
  }

  // A lifted finger leaves the pinch; below two fingers the pinch ends
  // and the zoom KEEPS its value. The remaining finger owns no gesture
  // (it never claimed one) — lifting and re-touching starts fresh.
  function endTouchPoint(e) {
    if (touchPts.delete(e.pointerId) && pinch && touchPts.size < 2) pinch = null;
  }

  canvas.addEventListener('pointerup', (e) => { endTouchPoint(e); endPointer(e, false); });
  canvas.addEventListener('pointercancel', (e) => { endTouchPoint(e); endPointer(e, true); });
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

  // ── Intro panel tuck ────────────────────────────────────────
  // Zooming in is a clear "I'm exploring now" signal, and on a phone
  // the intro panel covers the very corner you zoomed toward — so it
  // folds into a pill while ZOOM is high and comes back when the view
  // returns home. Manual overrides (the – button, tapping the pill)
  // win until the zoom crosses back to base, then the automatics reset.
  {
    const panelEl = document.getElementById('panel');
    const pillEl = document.getElementById('panelPill');
    let userTucked = false;
    let userOpened = false;
    let wasZoomed = false;
    const syncPanelTuck = () => {
      // overrides reset only on the TRANSITION back to base zoom — a
      // steady-state check here would instantly undo a manual tuck
      const zoomedNow = E.ZOOM > 1.05;
      if (wasZoomed && !zoomedNow) { userOpened = false; userTucked = false; }
      wasZoomed = zoomedNow;
      const tucked = userTucked || (E.ZOOM > 1.15 && !userOpened);
      panelEl.classList.toggle('tucked', tucked);
      pillEl.classList.toggle('show', tucked);
      pillEl.setAttribute('aria-expanded', String(!tucked));
    };
    document.getElementById('panelTuck').addEventListener('click', () => {
      userTucked = true; userOpened = false; syncPanelTuck();
    });
    pillEl.addEventListener('click', () => {
      // "keep it open" only means something while zoomed — at rest the
      // pill tap is just undoing a manual tuck, and must not suppress
      // the NEXT zoom's auto-tuck
      userOpened = E.ZOOM > 1.15;
      userTucked = false;
      syncPanelTuck();
    });
    // ride the existing projection-change hook so every zoom/pan syncs
    const prevOPC = E.onProjectionChange;
    E.onProjectionChange = () => { prevOPC(); syncPanelTuck(); };
  }

  // ── Wheel zoom (desktop) ────────────────────────────────────
  // Exponential steps so equal wheel travel feels like equal zoom in
  // both directions. passive:false + preventDefault so a trackpad
  // ctrl+wheel pinch zooms the WORLD, not the browser (the page itself
  // cannot scroll — html/body are overflow:hidden). deltaMode 1 is
  // line-based deltas (Firefox); the multiplier compensates.
  canvas.addEventListener('wheel', (e) => {
    e.preventDefault();
    const p = eventPos(e);
    const step = e.deltaMode === 1 ? 0.06 : 0.0018;
    E.setZoom(E.ZOOM * Math.exp(-e.deltaY * step), p.x, p.y);
  }, { passive: false });

  // Keyboard: quarter-turn rotation (reads as "game", helps accessibility)
  window.addEventListener('keydown', (e) => {
    const k = e.key;
    // Typing in the chat panel must not drive the game — without this,
    // writing "read" rotates the world twice and "1" swaps the hotbar.
    // Escape still closes the chat (game.js stays the one keyboard
    // authority), everything else belongs to the input.
    if (e.target && e.target.closest && e.target.closest('#chat')) {
      if (k === 'Escape' || k === 'Esc') VH.chat.close();
      return;
    }
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
    else if (k === 'Escape' || k === 'Esc') {
      // Chat, then the company panel, then the codex — only one is ever
      // open, so the order is just a deterministic sweep.
      if (VH.chat.isOpen()) VH.chat.close();
      else if (!document.getElementById('company').hidden) closeCompany();
      else closeCodex(); // hoisted; defined with the codex wiring
    }
  });

  // ── Clear / Fireworks — and Reset ───────────────────────────
  // Choreography: anticipation crouch → staggered ballistic launch (a
  // shockwave from the center) → each block detonates at its APEX into a
  // coloured particle burst + bloom. Monuments become debris and explode
  // too. The stage ends EMPTY — clicking places blocks, so it stays
  // playable — and DISCOVERIES persist forever (saved in v2).
  //
  // ONE control, TWO states: while anything stands the button is Clear;
  // on a bare island the same button reads Reset and replays the opening,
  // so the world comes back with its ceremony instead of by appearing.
  // The label, aria-label and title flip TOGETHER (one control changing
  // meaning means the accessible name must change with the visible one).
  const resetBtn = document.getElementById('resetBtn');
  let resetBtnMode = null; // 'clear' | 'reset' — cached so the DOM is only touched on transitions
  function updateResetBtn() {
    const mode = (!W.blocks.length && !W.monuments.length) ? 'reset' : 'clear';
    if (mode === resetBtnMode) return;
    resetBtnMode = mode;
    const word = mode === 'reset' ? 'Reset' : 'Clear';
    // The SVG stays; only the text node after it carries the word.
    resetBtn.lastChild.textContent = '\n      ' + word + '\n    ';
    resetBtn.setAttribute('aria-label', word + ' the platform');
    resetBtn.title = word + ' the platform';
  }

  resetBtn.addEventListener('click', (e) => {
    e.stopPropagation();
    if (!W.blocks.length && !W.monuments.length) {
      // Bare island: Reset. Replay the opening — runEntrance owns the
      // whole show now, towers included: the tidy stacks land in the
      // wave and transform with their ceremonies, so the restore IS a
      // small show rather than an appearance. What the visitor
      // DISCOVERED is never touched; Reset restores the world, not
      // their memory of it.
      runEntrance();
      W.save();
      return;
    }

    // A reset mid-ceremony must not leave an orphaned ceremony drawing
    VH.monuments.clearCeremonies();

    // Monuments explode too: each substantial model piece becomes blast
    // debris that keeps its shape (the obelisk's gold tip bursts as its
    // own shell) — one shared policy with the void drop (monumentDebris).
    // markDirty right here: occupancy is keyed off this array.
    W.monuments.forEach(mon => monumentDebris(mon).forEach(d => W.blocks.push(d)));
    W.monuments = [];
    W.markDirty();

    // The launch itself lives in W.launchBlocks (shared with the ceremony's
    // leftover sweep). The whole board rises TOGETHER on the distance wave —
    // the show is in the break, not the takeoff: fuseJitter gives each shell
    // its own fuse so some pop at the apex and some fall a visible beat first
    // (designer, 2026-08-31). Raise it for a raggeder break, lower it toward 0
    // for a single clean flash; the floor guard in world.js keeps long fuses
    // from carrying a shell below its launch height.
    W.launchBlocks(W.blocks, {
      cx: (W.GRID_MIN + W.GRID_MAX) / 2,
      cy: (W.GRID_MIN + W.GRID_MAX) / 2,
      delayPerDist: 0.05,
      fuseJitter: 0.45,
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

  // ── Company panel ───────────────────────────────────────────
  // The BNY and Prudential towers are Viet's two old jobs. Tapping one
  // used to do nothing (the press arms a DRAG, which only starts on
  // movement), so the towers read as scenery. Now a tap tells you what
  // the job was.
  //
  // The copy is lifted VERBATIM from the case-study pages so the claims
  // have ONE source: a correction on work/bny/ must be mirrored here,
  // and keeping the wording identical makes a drift obvious on sight.
  // Nothing here asserts anything the pages do not already say — the
  // bullet list keeps the pages' own future tense, because those case
  // studies are still unwritten.
  const COMPANIES = {
    bny: {
      name: 'BNY',
      role: 'Head of Design, Wealth · 2021–2025',
      lead: 'I led six designers on the software wealth managers use to look ' +
            'after other people\u2019s money, and the software those clients use ' +
            'to look after their own.',
      label: 'The case study will cover',
      points: [
        'Counting the work before designing it, and why an inventory changed the strategy.',
        'The finding that reframed the program: the expensive thing was not how long a flow took, it was not knowing where it was.',
        'Which flows we deliberately left manual, and why the human checkpoint was the control.',
        'Setting the design standards for the bank\u2019s AI wealth tools: what a system is allowed to say about someone\u2019s money.',
      ],
      href: 'work/bny/',
    },
    prudential: {
      name: 'Prudential',
      role: 'Senior Product Designer · 2018–2021',
      lead: 'The app was not badly designed. It was badly organized, structured ' +
            'the way Prudential is structured rather than the way a person ' +
            'thinks about their own money.',
      label: 'The case study will cover',
      points: [
        'What open card sorting actually surfaced, and why it was not what we expected.',
        'Two rounds of tree testing, including the round that told us we had over-corrected.',
        'Keeping the old structure alive as a side door, for people who already know what they own.',
        'Cutting a personalized home screen that tested well, for a structural reason.',
      ],
      href: 'work/prudential/',
    },
  };

  const companyPanel = document.getElementById('company');
  const companyPoints = document.getElementById('companyPoints');
  function openCompany(id) {
    const c = COMPANIES[id];
    if (!c) return false;              // every other monument still does nothing
    closeCodex();                      // one panel at a time — they share the right edge
    VH.chat.close({ silent: true });
    document.getElementById('companyName').textContent = c.name;
    document.getElementById('companyRole').textContent = c.role;
    document.getElementById('companyLead').textContent = c.lead;
    document.getElementById('companyLabel').textContent = c.label;
    // textContent only, and the list is rebuilt rather than appended to,
    // so reopening a second company never stacks the first one's points.
    companyPoints.replaceChildren();
    c.points.forEach((t) => {
      const li = document.createElement('li');
      li.textContent = t;
      companyPoints.appendChild(li);
    });
    document.getElementById('companyLink').href = c.href;
    companyPanel.hidden = false;
    if (VH.sfx) VH.sfx.uiTick('open');
    return true;
  }
  function closeCompany(opts) {
    if (companyPanel.hidden) return;
    companyPanel.hidden = true;
    if (!(opts && opts.silent) && VH.sfx) VH.sfx.uiTick('close');
  }
  document.getElementById('companyClose').addEventListener('click', () => closeCompany());

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
    VH.chat.close({ silent: true }); // one panel at a time — they share the right edge; the button already ticked
    closeCompany({ silent: true });
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
        W.hoveredMonument = null;
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
        b.setAttribute('aria-label', 'Random color');
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

  // ── Surface grain (2026-08 "real textures" ask, resolved to procedural
  // speckle on the night palette — no asset files, no packs). Speckle
  // positions hash from the tile's LOGICAL cell, never render coordinates
  // (the fractional-gz class of bug), and are projected through the same
  // camera math as the tiles, so grain sticks to the ground while the
  // camera turns. Marks batch into four fills — but this is NOT
  // allocation-free: the per-cell RNG closures and the point literals
  // in the loop run ~1-2k objects per rebuild, and the cache misses
  // every frame during a rotate or shake. Measured acceptable, not
  // free; see HANDOFF "allocation follow-up" before adding more here.
  let GRAIN = 0.55; // designer knob; 0 disables. Live: vh-dev-grain {amount}

  // Same cell, same speckles, every rebuild (the +40 keeps the shipped
  // pattern identical to before E.hashRand was hoisted to the engine)
  const speckleRand = (gx, gy, gz) => E.hashRand(gx + 40, gy + 40, gz + 40);

  const SPECK_TOP = 9;  // speckles per grass top face
  const SPECK_SIDE = 6; // speckles per visible cliff face

  // One parallelogram on a face, in grid space: base point p (screen),
  // edge vectors a/b (screen), size k as a fraction of the tile edge
  function speckQuad(ctx, p, a, b, k) {
    ctx.moveTo(p.x, p.y);
    ctx.lineTo(p.x + a.x * k, p.y + a.y * k);
    ctx.lineTo(p.x + (a.x + b.x) * k, p.y + (a.y + b.y) * k);
    ctx.lineTo(p.x + b.x * k, p.y + b.y * k);
    ctx.closePath();
  }

  // Emit every speckle for the platform into the CURRENT path, keeping
  // only the ones whose parity matches `pass` (0 = dark, 1 = light). Two
  // passes re-run the same deterministic sequence — cheaper than arrays.
  // One E.toScreen per FACE, not per speckle: speckle offsets ride the
  // frame's face vectors, which is the same projection by another route.
  function emitGrain(ctx, dip, pass) {
    const fv = E.fv;
    const ux = fv.ux, uy = fv.uy, uz = fv.uz;
    // Grass tops (the whole island). Top surface of gz=-1 sits at z = -dip.
    for (let gx = W.GRID_MIN; gx <= W.GRID_MAX; gx++) {
      for (let gy = W.GRID_MIN; gy <= W.GRID_MAX; gy++) {
        const o = E.toScreen(gx, gy, -dip);
        const rnd = speckleRand(gx, gy, -1);
        for (let i = 0; i < SPECK_TOP; i++) {
          const k = 0.05 + rnd() * 0.08;
          const u = 0.04 + rnd() * (0.92 - k);
          const v = 0.04 + rnd() * (0.92 - k);
          if (i % 2 !== pass) continue;
          speckQuad(ctx, { x: o.x + ux.x * u + uy.x * v, y: o.y + ux.y * u + uy.y * v }, ux, uy, k);
        }
      }
    }
    // The visible cliff: outer X and Y walls only (interior side faces are
    // hidden under neighbouring tiles). Grass row (gz=-1) + dirt row (gz=-2).
    const gxEdge = fv.xVisible ? W.GRID_MAX : W.GRID_MIN;
    const gyEdge = fv.yVisible ? W.GRID_MAX : W.GRID_MIN;
    const xPlane = fv.xVisible ? gxEdge + 1 : gxEdge; // matches drawBlock's face pick
    const yPlane = fv.yVisible ? gyEdge + 1 : gyEdge;
    for (let g = W.GRID_MIN; g <= W.GRID_MAX; g++) {
      for (const gz of [-1, -2]) {
        // ±X wall face of tile (gxEdge, g, gz)
        const ox = E.toScreen(xPlane, g, gz - dip);
        let rnd = speckleRand(gxEdge * 3 + 101, g, gz);
        for (let i = 0; i < SPECK_SIDE; i++) {
          const k = 0.05 + rnd() * 0.07;
          const t = 0.04 + rnd() * (0.92 - k);
          const h = 0.04 + rnd() * (0.92 - k);
          if (i % 2 !== pass) continue;
          speckQuad(ctx, { x: ox.x + uy.x * t + uz.x * h, y: ox.y + uy.y * t + uz.y * h }, uy, uz, k);
        }
        // ±Y wall face of tile (g, gyEdge, gz)
        const oy = E.toScreen(g, yPlane, gz - dip);
        rnd = speckleRand(g, gyEdge * 3 + 107, gz);
        for (let i = 0; i < SPECK_SIDE; i++) {
          const k = 0.05 + rnd() * 0.07;
          const t = 0.04 + rnd() * (0.92 - k);
          const h = 0.04 + rnd() * (0.92 - k);
          if (i % 2 !== pass) continue;
          speckQuad(ctx, { x: oy.x + ux.x * t + uz.x * h, y: oy.y + ux.y * t + uz.y * h }, ux, uz, k);
        }
      }
    }
  }

  // Per-tile tone: a hashed ±lightness per cell plus a faint checker, so
  // the lawn is a field of slightly different grasses rather than one
  // flat green. Two batched fills (dark / light), like the grain.
  function emitTileTint(ctx, dip, pass) {
    const fv = E.fv, ux = fv.ux, uy = fv.uy;
    for (let gx = W.GRID_MIN; gx <= W.GRID_MAX; gx++) {
      for (let gy = W.GRID_MIN; gy <= W.GRID_MAX; gy++) {
        const v = E.hashRand(gx + 200, gy + 200, 7)() * 2 - 1 + (((gx + gy) & 1) ? 0.35 : -0.35);
        if ((v > 0 ? 1 : 0) !== pass) continue;
        const o = E.toScreen(gx, gy, -dip);
        ctx.moveTo(o.x, o.y);
        ctx.lineTo(o.x + ux.x, o.y + ux.y);
        ctx.lineTo(o.x + ux.x + uy.x, o.y + ux.y + uy.y);
        ctx.lineTo(o.x + uy.x, o.y + uy.y);
        ctx.closePath();
      }
    }
  }

  // The cliff as earth, not a brown box: a shadow lip where the turf
  // overhangs the soil, two wandering strata, a few pale stones, and a
  // darkening toward the bottom edge so the wall falls away into the
  // night instead of ending on a hard line. Whole-wall quads, not
  // per-tile — one wall is one run.
  function emitCliffDetail(ctx, dip, pass) {
    const fv = E.fv, ux = fv.ux, uy = fv.uy, uz = fv.uz;
    const gxEdge = fv.xVisible ? W.GRID_MAX : W.GRID_MIN;
    const gyEdge = fv.yVisible ? W.GRID_MAX : W.GRID_MIN;
    const xPlane = fv.xVisible ? gxEdge + 1 : gxEdge;
    const yPlane = fv.yVisible ? gyEdge + 1 : gyEdge;
    const n = W.GRID_MAX - W.GRID_MIN + 1;
    // pass 0 = dark marks, pass 1 = light marks
    const walls = [
      { o: E.toScreen(xPlane, W.GRID_MIN, -2 - dip), a: { x: uy.x * n, y: uy.y * n }, seed: 1 },
      { o: E.toScreen(W.GRID_MIN, yPlane, -2 - dip), a: { x: ux.x * n, y: ux.y * n }, seed: 2 },
    ];
    const band = (o, a, h0, h1) => {
      ctx.moveTo(o.x + uz.x * h0, o.y + uz.y * h0);
      ctx.lineTo(o.x + a.x + uz.x * h0, o.y + a.y + uz.y * h0);
      ctx.lineTo(o.x + a.x + uz.x * h1, o.y + a.y + uz.y * h1);
      ctx.lineTo(o.x + uz.x * h1, o.y + uz.y * h1);
      ctx.closePath();
    };
    for (const wl of walls) {
      const rnd = E.hashRand(wl.seed + 300, 0, 0);
      if (pass === 0) {
        // overhang shadow: three nested bands under the turf (dirt row spans h 0..1)
        band(wl.o, wl.a, 0.84, 1.0); band(wl.o, wl.a, 0.92, 1.0); band(wl.o, wl.a, 0.96, 1.0);
        // bottom falloff: the wall dissolves into the night
        band(wl.o, wl.a, 0, 0.5); band(wl.o, wl.a, 0, 0.34); band(wl.o, wl.a, 0, 0.2);
        band(wl.o, wl.a, 0, 0.11); band(wl.o, wl.a, 0, 0.05);
        // two wandering strata, in short segments so they drift
        for (const base of [0.36, 0.62]) {
          let h = base + (rnd() - 0.5) * 0.06;
          const segs = 8;
          for (let k = 0; k < segs; k++) {
            const t0 = k / segs, t1 = (k + 1) / segs;
            const h2 = h + (rnd() - 0.5) * 0.05;
            ctx.moveTo(wl.o.x + wl.a.x * t0 + uz.x * h, wl.o.y + wl.a.y * t0 + uz.y * h);
            ctx.lineTo(wl.o.x + wl.a.x * t1 + uz.x * h2, wl.o.y + wl.a.y * t1 + uz.y * h2);
            ctx.lineTo(wl.o.x + wl.a.x * t1 + uz.x * (h2 + 0.035), wl.o.y + wl.a.y * t1 + uz.y * (h2 + 0.035));
            ctx.lineTo(wl.o.x + wl.a.x * t0 + uz.x * (h + 0.035), wl.o.y + wl.a.y * t0 + uz.y * (h + 0.035));
            ctx.closePath();
            h = h2;
          }
        }
      } else {
        // pale stones set into the soil
        for (let k = 0; k < 7; k++) {
          const t = rnd() * 0.95, h = 0.12 + rnd() * 0.6, w = 0.008 + rnd() * 0.014;
          const ox = wl.o.x + wl.a.x * t + uz.x * h, oy = wl.o.y + wl.a.y * t + uz.y * h;
          ctx.moveTo(ox, oy);
          ctx.lineTo(ox + wl.a.x * w, oy + wl.a.y * w);
          ctx.lineTo(ox + wl.a.x * w + uz.x * w * 8, oy + wl.a.y * w + uz.y * w * 8);
          ctx.lineTo(ox + uz.x * w * 8, oy + uz.y * w * 8);
          ctx.closePath();
        }
      }
    }
  }

  function drawPlatformGrain(dip) {
    if (!(GRAIN > 0)) return; // fail CLOSED on NaN
    const ctx = E.ctx; // called inside drawPlatform's E.ctx swap → the cache
    ctx.beginPath(); emitTileTint(ctx, dip, 0);
    ctx.globalAlpha = 0.045; ctx.fillStyle = '#0c1030'; ctx.fill();
    ctx.beginPath(); emitTileTint(ctx, dip, 1);
    ctx.globalAlpha = 0.035; ctx.fillStyle = '#fff1d2'; ctx.fill();
    ctx.beginPath(); emitCliffDetail(ctx, dip, 0);
    ctx.globalAlpha = 0.16; ctx.fillStyle = '#0c1030'; ctx.fill();
    ctx.beginPath(); emitCliffDetail(ctx, dip, 1);
    ctx.globalAlpha = 0.22; ctx.fillStyle = '#e8dcc4'; ctx.fill();
    ctx.beginPath();
    emitGrain(ctx, dip, 0);
    ctx.globalAlpha = Math.min(1, GRAIN * 0.16);
    ctx.fillStyle = '#000000';
    ctx.fill();
    ctx.beginPath();
    emitGrain(ctx, dip, 1);
    ctx.globalAlpha = Math.min(1, GRAIN * 0.10);
    ctx.fillStyle = '#ffffff';
    ctx.fill();
    ctx.globalAlpha = 1;
  }

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
    // Cache key: anything that changes the platform's pixels. SCALE and
    // pan are in here because zoom changes NEITHER E.W nor E.H — without
    // them the island keeps rendering at the old size while every block
    // rescales, indefinitely (nothing else invalidates at rest), then
    // silently self-heals on the next rotate. Do not remove.
    const key = [cam.angle.toFixed(5), dip.toFixed(4), E.W, E.H,
                 E.SCALE.toFixed(4), E.panX.toFixed(1), E.panY.toFixed(1),
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
      // The tiles go through drawBlock, which reads the frame's lights —
      // and this bitmap is CACHED, so any lamp or beam light would bake
      // into the grass on a rotate frame and freeze there. Hide the lights
      // for the rebuild; the ground gets its light live, after the blit.
      const savedLights = E.lights, savedBeams = E.beams;
      E.lights = []; E.beams = [];
      getPlatformTiles().forEach(t =>
        W.drawBlock(t.gx, t.gy, t.gz - dip, t.color, 1, { gridTop: t.color === 'grass' }));
      drawPlatformGrain(dip); // after every tile: tops are never occluded, walls are boundary-only
      E.lights = savedLights; E.beams = savedBeams;
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
    // The gofer updates BEFORE the frame's entries are built (unlike
    // M.update, which deliberately runs after the draw) — otherwise
    // his entry box and his pixels disagree within a frame.
    VH.gofer.update(dt);
    E.updateFaceVectors();
    E.updateLightInfo();
    ctx.clearRect(0, 0, E.W, E.H);
    E.lightBegin(); // wipe the bloom buffer; emissive draws register into it
    VH.monuments.registerBeams(); // the lighthouse beam, computed before anything draws

    FX.drawSky();
    FX.drawStars(dt);
    FX.updateAndDrawShootingStar(dt);
    FX.drawCloudsFar(dt);
    FX.drawMoon();
    FX.updateAndDrawSilhouettes(dt);
    FX.drawCloudsNear(dt);
    FX.drawVoidMist();

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
      // Hover lift: the shadow rides along, exactly as blocks fold b.lift
      // into their shadow gz above — miss it and the monument rises off
      // its own shadow.
      const mLift = mon.lift || 0;
      mon.model.forEach(m => {
        if (!VH.monuments.castsShadow(m)) return; // ONE gate, shared with the ceremony pass
        E.addShadowBox(m.gx, m.gy, m.gz + mLift, m.sxy, m.sz,
          heightFade(m.gz + mLift + m.sz) * dim, dip, m.sy);
      });
    });
    // Ceremony shadows: floaters cast from their live rising positions and
    // the monument's pieces cast growing shadows as they pop in — no more
    // 2-second shadow hole + single-frame snap when a monument forms
    VH.monuments.pushShadowCasters(dip, heightFade);
    VH.gofer.pushShadow(dip, heightFade);
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
    // Light on the ground: lamp pools and the lighthouse cone, with the
    // lighthouse's own shadows cut out. AFTER the moon shadows so a pool
    // inside one is not dimmed by it (light is drawn over shadow), BEFORE
    // the world so every cube and the gofer stand on it and occlude it.
    E.groundDraw(dip); // point-light pools only
    E.groundComposite([
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
    VH.gofer.pushEntries(entries, dip);
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
      // …and the light the world reacts to: neighbours warm, the grass pools.
      E.addPoint(b.gx + 0.5, b.gy + 0.5, z + 0.6, 3.2, '255,196,90', 0.55 * flicker, { faces: true, ground: true });
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
          { ...squashOpts, contact: settled && !isGlass,
            ao: settled && !isGlass ? b : null }
        );
      }
    });

    // The ceremony's hologram silhouette — one union of light, drawn
    // above the solid world (it's light: it glows through, like flashes)
    VH.monuments.drawHologram(dip);

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

    // The lighthouse shaft, added over the finished world — volumetric
    // light is glowing AIR in front of what it passes, so it goes last and
    // additive, exactly where a real engine puts it. Nothing to sort, and
    // it always reaches back to its own lamp. See M.drawBeamShaft.
    VH.monuments.drawBeamShaft();

    // The one light pass: blur the collected lights, add them over the
    // scene. Leaves the context state clean (postcard export reads it).
    E.lightComposite();

    // Clear ⇄ Reset rides the frame so EVERY path that fills or empties
    // the board flips it (blast finishing, void falls, placements, load,
    // harness restores) — cached mode means DOM writes only on transitions.
    updateResetBtn();

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
    return bad;
  }
  // Warn on CHANGE, not on repeat: a persistent violation streaming a
  // warn every 500ms retains thousands of console entries over a long
  // #dev session and measurably slows the page with DevTools open.
  // (The on-demand vh-dev-invariant report below still prints in full.)
  let lastInvariantMsg = '';
  setInterval(() => {
    const msg = checkInvariants().join(' | ');
    if (msg && msg !== lastInvariantMsg) console.warn('[invariant]', msg);
    lastInvariantMsg = msg;
  }, 500);
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
    if (d.ground !== undefined) E.GROUND_GAIN = d.ground;   // ground-light pools
    if (d.lights !== undefined) E.LIGHTS_ON = !!d.lights;    // point-light kill switch
    console.log('[dev-light] gain', E.LIGHT_GAIN, 'blur', E.LIGHT_BLUR,
      'moon', E.MOON_ALT, 'shadow', E.SHADOW_STRENGTH,
      'ground', E.GROUND_GAIN, 'lights', E.LIGHTS_ON);
  });
  // Framing picker: the designer chooses the DEFAULT island size on a
  // real phone (vietnhoang.com/#dev), never from a description. The
  // divisor is the island's width fraction on a portrait phone (600 =
  // 73% of the width, 500 = 88%, 460 = 96%); the anchor is where the
  // island sits vertically. Picking a variant re-runs resize(), which
  // recomputes BASE_SCALE and reapplies any user zoom on top.
  document.addEventListener('vh-dev-frame', (e) => {
    const d = e.detail || {};
    if (Number.isFinite(+d.div) && +d.div > 100) E.FRAME_DIV = +d.div;
    if (Number.isFinite(+d.anchor)) E.FRAME_ANCHOR = Math.max(0.2, Math.min(0.8, +d.anchor));
    E.resize();
    console.log('[dev-frame]', JSON.stringify({ div: E.FRAME_DIV, anchor: E.FRAME_ANCHOR }));
  });
  {
    const FRAMES = [
      ['A · small (old)', 600, 0.46],
      ['B · default', 500, 0.46],   // ← the designer's pick, 2026-08-27
      ['C · biggest', 460, 0.44],
    ];
    const bar = document.createElement('div');
    bar.style.cssText = 'position:fixed;left:50%;top:70px;transform:translateX(-50%);z-index:60;display:flex;gap:8px;';
    FRAMES.forEach(([label, div, anchor]) => {
      const b = document.createElement('button');
      b.textContent = label;
      // 48px targets — this picker's whole job is being usable on a phone
      b.style.cssText = 'min-width:88px;min-height:48px;padding:6px 12px;border-radius:10px;border:1px solid rgba(255,255,255,0.25);background:rgba(10,12,24,0.88);color:#e8e0d6;font:600 13px system-ui;cursor:pointer;';
      b.addEventListener('click', () =>
        document.dispatchEvent(new CustomEvent('vh-dev-frame', { detail: { div, anchor } })));
      bar.appendChild(b);
    });
    document.body.appendChild(bar);
  }
  // Flower density on the Hanging Gardens. Default 1.2 (designer-picked
  // on screen). Only EXACTLY 0 turns them off — the count floor is 1 per
  // piece, so 0.01 still plants one.
  document.addEventListener('vh-dev-flowers', (e) => {
    const d = e.detail || {};
    if (d.amount != null) W.FLOWERS_ON = Math.max(0, +d.amount);
    console.log('[dev-flowers]', JSON.stringify({ amount: W.FLOWERS_ON }));
  });
  // Live material-texture tuning, PER FAMILY, so any family that reads
  // as noise can be zeroed on screen without touching the others.
  // {family: 'stone'|'brick'|…|'all', amount: 0..~1.5}; 0 disables.
  document.addEventListener('vh-dev-material', (e) => {
    const d = e.detail || {};
    if (d.amount != null) {
      const amt = Math.max(0, +d.amount);
      if (!d.family || d.family === 'all') Object.keys(W.MAT).forEach(k => { W.MAT[k] = amt; });
      else if (W.MAT[d.family] != null) W.MAT[d.family] = amt;
      else console.warn('[dev-material] unknown family:', d.family);
    }
    console.log('[dev-material]', JSON.stringify(W.MAT));
  });
  // Live grain tuning: the designer picks the amount ON SCREEN, never
  // from a description — same idiom as vh-dev-light. 0 disables.
  document.addEventListener('vh-dev-grain', (e) => {
    const d = e.detail || {};
    // Number.isFinite, not just +: a non-numeric amount yields NaN,
    // NaN <= 0 is FALSE so the early-out fails OPEN, and assigning NaN
    // to globalAlpha is a spec no-op that leaves the previous value —
    // 1 — painting the island in solid black and white speckle, baked
    // into the platform cache. The sibling hooks fail closed; this
    // one didn't.
    if (d.amount != null && Number.isFinite(+d.amount)) GRAIN = Math.max(0, +d.amount);
    platformCacheKey = ''; // force a repaint so the change shows this frame
    console.log('[dev-grain]', JSON.stringify({ amount: GRAIN }));
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
    // 'green' satisfies every '*' in play: plain (arc's plainOnly), not
    // glass/lamp (obelisk's notColors), same across a build (sameColor) —
    // and NEUTRAL: no explicit recipe demands it. 'blue' stopped being
    // neutral when the Prudential tower (a blue wall) shipped: a blue
    // 2×3 arc now rightly DEFERS to a possible tower-in-progress, the
    // same learned trap as a red arc before the torii is discovered.
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
            { color: c[3] === '*' ? 'green' : c[3], dropOffset: 0.8 });
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
    // Act 3 — the payoff. The tidy stacks transform in career order;
    // the second ceremony overlaps the tail of the first (one rising
    // passage, not two events).
    STACK_STEP: 0.045, // seconds between a tidy stack's blocks
    STACK_SETTLE: 0.33,// fall allowance after the last stack block's release
    T3_FIRST: 0.55,    // hero impact → Prudential's ceremony
    T3_SECOND: 1.65,   // hero impact → BNY's (Prudential is mid-rise)
    // Act 4 — the gofer. He sets out AFTER both ceremonies have finished
    // (BNY's runs to impact+3.65) and after its card has cleared
    // (showCard holds 2.8s from ceremony+0.7, so impact+5.15). The stage
    // is empty and the island is built; only then does something move
    // under the grass. His mound travels ~3.5 tiles before erupting, so
    // he actually appears around impact+6.2s.
    T3_GOFER: 4.6,
    // Reduced motion runs act 3 on its own clock (BNY at 2.0s → its card
    // clears at 5.5s) and his cameo has no travel to spend, so it waits
    // longer and lands straight away.
    T3_GOFER_RM: 5.8,
  };

  function runEntrance() {
    const span = W.GRID_MAX - W.GRID_MIN;
    const M = VH.monuments;
    // He waits underground through the whole opening and comes up in
    // act 4. Standing here from frame one would both spoil the reveal
    // and bury him under the wave.
    VH.gofer.hideForEntrance();

    // ── Act 1: the world arrives — and the towers were there all along.
    // The two portfolio recipes land INSIDE the wave as conspicuously
    // tidy stacks (the wall column by column, the block storey by
    // storey), so the payoff transforms something the visitor WATCHED
    // land — nothing appears from nowhere. A tower already standing, or
    // one whose home ground is occupied, simply skips its stack: Reset
    // on a board that kept one rebuilds only what is missing.
    const towerPlans = [
      { id: 'prudential', order: (a, b) => (a[0] - b[0]) || (a[2] - b[2]) },
      { id: 'bny',        order: (a, b) => (a[2] - b[2]) || (a[1] - b[1]) || (a[0] - b[0]) },
    ];
    const avoid = new Set();
    const finals = []; // per tower: the last-landing block — act 3 pokes it
    let lastStackDelay = 0;
    towerPlans.forEach((tp, ti) => {
      const r = M.RECIPES.find(x => x.id === tp.id);
      if (!r || !r.home) return;
      if (W.monuments.some(m => m.id === r.id)) return;
      const cells = r.cells.map(c => [r.home.ox + c[0], r.home.oy + c[1], c[2], c[3]]);
      if (cells.some(c => W.getStackHeight(c[0], c[1]) > c[2])) return;
      cells.sort(tp.order);
      let last = null;
      cells.forEach((c, i) => {
        const delay = 0.15 + ti * 0.24 + i * ENT.STACK_STEP;
        lastStackDelay = Math.max(lastStackDelay, delay);
        last = W.makeBlock(c[0], c[1], c[2], {
          color: c[3],
          dropOffset: 6 + c[2] * 1.4,
          dropDelay: delay,
        });
        W.blocks.push(last);
        W.markDirty();
      });
      cells.forEach(c => avoid.add(c[0] + ',' + c[1]));
      finals.push(last);
    });
    // Act 3's trigger runs through the REAL path — W.notifyPlaced on the
    // stack's last block, exactly what a player's placement does — so
    // the matcher, deferral, ceremony, card and the new hit-stop all
    // come along for free. Guarded: if the visitor grabbed a stack block
    // mid-opening (input is NEVER locked), the poke finds no pattern and
    // quietly does nothing; the codex and Reset both still lead here.
    const fireTower = (i) => {
      const b = finals[i];
      if (b && W.blocks.includes(b)) W.notifyPlaced(b);
    };

    W.spawnBlocks(24, (gx, gy, gz) => {
      const d = (gx - W.GRID_MIN) + (gy - W.GRID_MIN); // Manhattan distance from the far corner
      const phrase = Math.min(3, Math.floor(d / (span / 2 + 0.01)));
      return {
        dropOffset: 6 + Math.random() * 2 + gz * 1.2,
        dropDelay: 0.15 + phrase * ENT.PHRASE + (Math.random() * 0.04 - 0.02),
      };
    }, (gx, gy) => avoid.has(gx + ',' + gy));
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
    // Released after the wave AND the tidy stacks have fully settled,
    // then the pause — the stillness is the act break, so it must not
    // start while a tower storey is still falling.
    const waveLands = Math.max(0.15 + 3 * ENT.PHRASE + 0.24,
                               lastStackDelay + ENT.STACK_SETTLE);
    if (!tile) {
      // No open ground for the hero (can't happen on a fresh board, but
      // the act-3 payoff must not die with the beat): fire the towers on
      // the clock instead.
      setTimeout(() => fireTower(0), (waveLands + ENT.PAUSE + ENT.T3_FIRST) * 1000);
      setTimeout(() => fireTower(1), (waveLands + ENT.PAUSE + ENT.T3_SECOND) * 1000);
      // No hero tile to aim at, so he comes up near the middle instead.
      setTimeout(() => VH.gofer.cameo(0, 0),
        (waveLands + ENT.PAUSE + ENT.T3_GOFER) * 1000);
      return;
    }
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
        // ── Act 3, anchored to the impact the visitor just FELT:
        // Prudential (2018) rises first, BNY (2021) into its tail — the
        // career traced forward without a caption.
        setTimeout(() => fireTower(0), ENT.T3_FIRST * 1000);
        setTimeout(() => fireTower(1), ENT.T3_SECOND * 1000);
        // ── Act 4: and something is still living here. He sets out
        // toward the hero block — where the visitor is already looking.
        setTimeout(() => VH.gofer.cameo(tile[0], tile[1]), ENT.T3_GOFER * 1000);
      };
    } else {
      // Reduced motion never enters the falling path, so there is no
      // impact to anchor to — act 3 runs on the clock, and the
      // ceremonies' own reduced-motion branches keep them gentle.
      setTimeout(() => fireTower(0), 900);
      setTimeout(() => fireTower(1), 2000);
      setTimeout(() => VH.gofer.cameo(tile[0], tile[1]), ENT.T3_GOFER_RM * 1000);
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
  // The RETURNING visitor whose save predates the towers gets them
  // planted quietly at home (never over their build, never a tower they
  // deliberately destroyed — plantHomes owns those rules). Fresh
  // visitors skip this entirely: their towers arrive inside the opening
  // as tidy stacks that transform on screen.
  if (!firstVisit) VH.monuments.plantHomes();
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
