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

  const prefersReducedMotion = window.matchMedia('(prefers-reduced-motion: reduce)').matches;
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
  // Mirrors drawBlock's geometry: sxy widens both ground axes about the
  // cell center, sz extends upward. Pieces tested in REVERSE draw order so
  // the front-most piece under the cursor wins.
  function monumentFaceQuads(p) {
    const sxy = p.sxy, sz = p.sz;
    const ref = E.toScreen(p.gx + (1 - sxy) / 2, p.gy + (1 - sxy) / 2, p.gz);
    const fv = E.fv;
    const ux = { x: fv.ux.x * sxy, y: fv.ux.y * sxy };
    const uy = { x: fv.uy.x * sxy, y: fv.uy.y * sxy };
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
  function monumentMoveValid(mon, dx, dy) {
    const free = (c) => {
      const gx = c.gx + dx, gy = c.gy + dy;
      if (!W.isOnPlatform(gx, gy)) return false;
      const v = W.at(gx, gy, c.gz);
      return v === undefined || v === mon;
    };
    return mon.cells.every(free) && (mon.blocked || []).every(free);
  }

  // ── Interaction state ───────────────────────────────────────
  let dragBlock = null;
  let dragOrigin = null;      // where the carried block came from
  let isDragging = false;
  let isRotating = false;
  let pointerScreen = { x: 0, y: 0 };
  let pointerDownPos = { x: 0, y: 0 };
  let hoverGrid = null;
  let hoverBlock = null;
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

  function updateHoverTarget() {
    hoverGrid = null;
    hoverBlock = null;
    const { ux, uy } = E.fv;
    // Test the LANDING SURFACE of each column (the visible top of the
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
      if (E.pointInQuad(pointerScreen.x, pointerScreen.y, ref, q1, q2, q3)) {
        hoverGrid = { gx: c.gx, gy: c.gy, gz: c.gz };
        hoverBlock = W.blocks.find(b =>
          b.gx === c.gx && b.gy === c.gy && b.gz === c.gz - 1 && W.isLive(b) && !b.dropping
        ) || null;
        return;
      }
    }
    // Fallback to ground-level grid if no top face hit
    const grid = E.toGrid(pointerScreen.x, pointerScreen.y);
    if (W.isOnPlatform(grid.gx, grid.gy)) {
      const gz = W.getStackHeight(grid.gx, grid.gy);
      if (gz <= W.MAX_STACK) hoverGrid = { gx: grid.gx, gy: grid.gy, gz };
    }
  }

  function restoreDragBlockToOrigin() {
    // Put the carried block back where it came from (stack may have changed)
    const gz = W.getStackHeight(dragOrigin.gx, dragOrigin.gy);
    dragBlock.gx = dragOrigin.gx;
    dragBlock.gy = dragOrigin.gy;
    dragBlock.gz = Math.min(gz, W.MAX_STACK);
    dragBlock.dropOffset = prefersReducedMotion ? 0 : 2;
    dragBlock.dropVel = 0;
    dragBlock.dropDelay = 0;
    dragBlock.dropping = !prefersReducedMotion;
    W.blocks.push(dragBlock);
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
  let dragMonValid = false;

  canvas.addEventListener('pointerdown', (e) => {
    if (activePointerId !== null) return; // one pointer drives; ignore extra touches
    activePointerId = e.pointerId;
    canvas.setPointerCapture(e.pointerId);

    const p = eventPos(e);
    pointerDownPos = p;
    pointerScreen = { ...p };
    didDrag = false;

    const hit = hitTestBlock(p.x, p.y);
    const monHit = hit ? null : hitTestMonument(p.x, p.y);
    if (hit && W.isTopBlock(hit)) {
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
        const grabbable = hit && W.isTopBlock(hit);
        canvas.style.cursor = grabbable || (!hit && hitTestMonument(p.x, p.y))
          ? 'grab' : 'default';
        W.hoveredBlock = grabbable ? hit : null;
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
      W.removeBlock(dragBlock);
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
      dragMonValid = monumentMoveValid(dragMon, dragMonDelta.dx, dragMonDelta.dy);
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
    // Single-pointer game: any pointerup/cancel while a gesture is active ends it.
    // (Strict pointerId matching can wedge the input if the up event arrives
    // with a different id, e.g. from synthetic/test input.)
    if (activePointerId === null) return;
    if (e.pointerId !== activePointerId && !isDragging && !isRotating && !pendingBlock &&
        !pendingMonument && !dragMon) return;
    activePointerId = null;

    // Pressed a monument and released without moving: nothing happens
    pendingMonument = null;

    if (dragMon) {
      const { dx, dy } = dragMonDelta;
      const stillExists = W.monuments.includes(dragMon); // Clear mid-drag guard
      if (!cancelled && stillExists && (dx || dy) && monumentMoveValid(dragMon, dx, dy)) {
        // Commit: shift cells + model, re-derive the blocked volume
        dragMon.cells.forEach(c => { c.gx += dx; c.gy += dy; });
        dragMon.model.forEach(m => { m.gx += dx; m.gy += dy; });
        dragMon.blocked = VH.monuments.blockedCellsFor(dragMon.model, dragMon.cells);
        W.markDirty();
        W.save();
        if (!prefersReducedMotion) {
          W.kickDip(0.8); // it lands with weight
          const c0 = dragMon.cells[0];
          if (VH.fx) VH.fx.spawnDust(c0.gx, c0.gy, 0, 10);
        }
        if (VH.sfx) VH.sfx.tock(0, 0.9);
      } else if (!cancelled && stillExists && (dx || dy)) {
        // Refused: the red ghost already said why; a small headshake
        if (!prefersReducedMotion) E.kickShake(2);
      }
      dragMon._dragging = false;
      dragMon = null;
      dragMonBase = null;
      dragMonDelta = { dx: 0, dy: 0 };
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
        if (prefersReducedMotion && VH.sfx) VH.sfx.tock(gz, 0.6);
        W.notifyPlaced(placed);
        W.save();
      }
      W.hoveredBlock = null;
      canvas.style.cursor = 'default';
      return;
    }
    pendingBlock = null;

    if (isDragging && dragBlock) {
      if (!cancelled && hoverGrid && W.isOnPlatform(hoverGrid.gx, hoverGrid.gy)) {
        dragBlock.gx = hoverGrid.gx;
        dragBlock.gy = hoverGrid.gy;
        dragBlock.gz = hoverGrid.gz;
        dragBlock.dropOffset = prefersReducedMotion ? 0 : 2;
        dragBlock.dropVel = 0;
        dragBlock.dropDelay = 0;
        dragBlock.dropping = !prefersReducedMotion;
        W.blocks.push(dragBlock);
        if (prefersReducedMotion && VH.sfx) VH.sfx.tock(dragBlock.gz, 0.6);
        W.notifyPlaced(dragBlock); // moving a block can complete a pattern
        W.save();
      } else if (cancelled) {
        restoreDragBlockToOrigin();
        W.save();
      } else {
        const grid = E.toGrid(pointerScreen.x, pointerScreen.y);
        if (W.isOnPlatform(grid.gx, grid.gy)) {
          // On the platform but no valid spot (e.g. full stack) → go home
          restoreDragBlockToOrigin();
          W.save();
        } else {
          // Dropped off the platform → the dog objects, block is gone
          FX.showAngryDog();
          W.save();
        }
      }
      dragBlock = null;
      dragOrigin = null;
      isDragging = false;
      hoverGrid = null;
      hoverBlock = null;
      lastMoveX = null;
      dragVelX = 0;
    } else if (isRotating) {
      if (!didDrag && !cancelled) {
        // Click/tap on the platform → place a block
        const grid = E.toGrid(pointerScreen.x, pointerScreen.y);
        if (W.isOnPlatform(grid.gx, grid.gy)) {
          const gz = W.getStackHeight(grid.gx, grid.gy);
          if (gz <= W.MAX_STACK) {
            const placed = W.makeBlock(grid.gx, grid.gy, gz, { color: placeColor() });
            W.blocks.push(placed);
            if (prefersReducedMotion && VH.sfx) VH.sfx.tock(gz, 0.6);
            W.notifyPlaced(placed);
            W.save();
          }
        }
        cam.angle = rotateStartAngle; // undo sub-threshold wiggle
        // If the tap interrupted a snap animation, finish the snap
        const HALF_PI = Math.PI / 2;
        if (Math.abs(cam.angle - Math.round(cam.angle / HALF_PI) * HALF_PI) > 1e-4) {
          cam.snapTo(cam.nearestSnap(), prefersReducedMotion ? 0.001 : 0.3);
        }
      } else {
        // Release the rotation into a snap at the nearest quarter turn
        cam.snapTo(cam.nearestSnap(), prefersReducedMotion ? 0.001 : 0.5);
      }
      isRotating = false;
    }
    W.hoveredBlock = null;
    canvas.style.cursor = 'default';
  }

  canvas.addEventListener('pointerup', (e) => endPointer(e, false));
  canvas.addEventListener('pointercancel', (e) => endPointer(e, true));
  canvas.addEventListener('contextmenu', (e) => e.preventDefault());

  // Keyboard: quarter-turn rotation (reads as "game", helps accessibility)
  window.addEventListener('keydown', (e) => {
    const k = e.key;
    // Arrows match the drag: ArrowRight turns the world the way dragging right does
    if (k === 'ArrowLeft' || k === 'Left') { cam.rotateStep(1); e.preventDefault(); }
    else if (k === 'ArrowRight' || k === 'Right' || k === 'r' || k === 'R') { cam.rotateStep(-1); e.preventDefault(); }
    else if (k >= '1' && k <= '4') {
      selectSlot(['color', 'grass', 'lamp', 'glass'][+k - 1]);
    }
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

    // Monuments explode too: each model piece becomes blast debris that
    // keeps its shape (the obelisk's gold tip bursts as its own shell)
    W.monuments.forEach(mon => mon.model.forEach(p =>
      W.blocks.push(W.makeDebris(p.gx, p.gy, p.gz, { color: p.color, sxy: p.sxy, sz: p.sz }))));
    W.monuments = [];

    // The launch itself lives in W.launchBlocks (shared with the ceremony's
    // leftover sweep); the defaults ARE the Clear tuning.
    W.launchBlocks(W.blocks, {
      cx: (W.GRID_MIN + W.GRID_MAX) / 2,
      cy: (W.GRID_MIN + W.GRID_MAX) / 2,
    });
    if (prefersReducedMotion) {
      // One soft bloom over the whole board: "the stage dissolves in light"
      FX.spawnFlash(0, 0, 1.2, { dur: 0.7, r0: 3, r1: 6, peak: 0.30 });
      if (VH.sfx) VH.sfx.boom(0.6);
    } else {
      E.kickShake(5);
      W.kickDip(2.2);
      // A final beat once the last shell is gone
      W.onBlastCleared = () => {
        if (VH.sfx) VH.sfx.boom(1.4);
        W.kickDip(1.0);
      };
      if (VH.sfx) { VH.sfx.whoomp(); VH.sfx.whistle(); }
    }
    // Persistence doesn't wait for the show: save() filters launching
    // blocks, so the debounced write stores the empty stage + discoveries.
    W.markDirty();
    W.save();
  });

  // ── Codex wiring ────────────────────────────────────────────
  const codex = document.getElementById('codex');
  document.getElementById('codexBtn').addEventListener('click', (e) => {
    e.stopPropagation();
    const opening = codex.hidden;
    codex.hidden = !opening;
    if (opening) VH.monuments.buildCodex();
  });
  document.getElementById('codexClose').addEventListener('click', () => { codex.hidden = true; });
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
  slots.forEach(s => s.addEventListener('click', () => selectSlot(s.dataset.type)));

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

  // Mini isometric cube icons drawn into each slot canvas
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
      ictx.clearRect(0, 0, 64, 64);
      const face = (pts, fill) => {
        ictx.fillStyle = fill;
        ictx.beginPath();
        ictx.moveTo(pts[0][0], pts[0][1]);
        for (let i = 1; i < pts.length; i++) ictx.lineTo(pts[i][0], pts[i][1]);
        ictx.closePath(); ictx.fill();
        ictx.strokeStyle = 'rgba(0,0,0,0.35)';
        ictx.lineWidth = 1.5;
        ictx.stroke();
      };
      face([[cx, cy - t * 1.5], [cx + t, cy - t], [cx, cy - t * 0.5], [cx - t, cy - t]], col.top);
      face([[cx, cy - t * 0.5], [cx + t, cy - t], [cx + t, cy], [cx, cy + t * 0.5]], col.right);
      face([[cx, cy - t * 0.5], [cx - t, cy - t], [cx - t, cy], [cx, cy + t * 0.5]], col.front);
      if (slot.dataset.type === 'glass') { // sheen
        ictx.globalAlpha = 0.5;
        ictx.strokeStyle = '#fff';
        ictx.lineWidth = 2;
        ictx.beginPath();
        ictx.moveTo(cx - t * 0.5, cy - t * 1.15);
        ictx.lineTo(cx + t * 0.35, cy - t * 0.7);
        ictx.stroke();
        ictx.globalAlpha = 1;
      }
      if (slot.dataset.type === 'lamp') { // glow dot
        const g = ictx.createRadialGradient(cx, cy - t * 0.9, 1, cx, cy - t * 0.9, 16);
        g.addColorStop(0, 'rgba(255,220,130,0.65)');
        g.addColorStop(1, 'rgba(255,220,130,0)');
        ictx.fillStyle = g;
        ictx.fillRect(0, 0, 64, 64);
      }
    });
  }
  drawSlotIcons();

  // ── Sound toggle ────────────────────────────────────────────
  const soundBtn = document.getElementById('soundBtn');
  function reflectSound() { soundBtn.classList.toggle('muted', !VH.sfx.enabled); }
  soundBtn.addEventListener('click', (e) => {
    e.stopPropagation();
    VH.sfx.setEnabled(!VH.sfx.enabled);
    reflectSound();
    if (VH.sfx.enabled) VH.sfx.pop(); // audible confirmation
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

  // ── Render loop (driven by real time) ───────────────────────
  function render(nowMs) {
    const dt = clock.tick(nowMs);
    const ctx = E.ctx;

    cam.update(dt);
    W.updateBlocks(dt);
    E.updateFaceVectors();
    E.updateLightInfo();
    ctx.clearRect(0, 0, E.W, E.H);

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

    // Platform (dips when the blast fires; blocks below inherit the dip)
    const dip = W.dip;
    drawPlatform(dip);
    FX.drawGrass();

    // Shadows
    const { ux, uy } = E.fv;
    const li = E.li;
    ctx.fillStyle = 'rgba(0,0,0,0.22)';
    W.blocks.forEach(b => {
      if (!W.isLive(b)) return; // launching blocks stop casting shadows
      if (b.dropping && b.dropDelay > 0) return; // not on stage yet
      if (b.dropping) {
        // Landing telegraph: contact shadow on the surface it will land on,
        // growing and darkening as the block gets closer.
        const plane = b.gz; // it drops INTO gz, so the surface below is at gz
        const proximity = Math.max(0, 1 - b.dropOffset / 8); // 0 far → 1 landed
        const sRef = E.toScreen(b.gx, b.gy, plane);
        ctx.globalAlpha = 0.10 + proximity * 0.16;
        const inset = (1 - (0.55 + proximity * 0.45)) / 2; // shrink toward center when far
        ctx.beginPath();
        ctx.moveTo(sRef.x + (ux.x + uy.x) * inset, sRef.y + (ux.y + uy.y) * inset);
        ctx.lineTo(sRef.x + ux.x * (1 - inset) + uy.x * inset, sRef.y + ux.y * (1 - inset) + uy.y * inset);
        ctx.lineTo(sRef.x + (ux.x + uy.x) * (1 - inset), sRef.y + (ux.y + uy.y) * (1 - inset));
        ctx.lineTo(sRef.x + ux.x * inset + uy.x * (1 - inset), sRef.y + ux.y * inset + uy.y * (1 - inset));
        ctx.closePath();
        ctx.fill();
        return;
      }
      // Resting blocks: moon-cast shadow on the ground plane
      const h = b.gz + 1;
      if (h <= 0) return;
      const sx = b.gx + h * li.shadowDx;
      const sy = b.gy + h * li.shadowDy;
      const sRef = E.toScreen(sx, sy, 0);
      ctx.globalAlpha = 0.22 * Math.min(1, 1.5 / (h * 0.5 + 1));
      ctx.beginPath();
      ctx.moveTo(sRef.x, sRef.y);
      ctx.lineTo(sRef.x + ux.x, sRef.y + ux.y);
      ctx.lineTo(sRef.x + ux.x + uy.x, sRef.y + ux.y + uy.y);
      ctx.lineTo(sRef.x + uy.x, sRef.y + uy.y);
      ctx.closePath();
      ctx.fill();
    });
    ctx.globalAlpha = 1;

    // User blocks + monuments, merged into ONE depth-sorted pass so a
    // block behind a monument draws behind it (and vice versa)
    const entries = [];
    W.blocks.forEach(b => {
      const gx = b.blasting ? b.gx + b.blastX : b.gx;
      const gy = b.blasting ? b.gy + b.blastY : b.gy;
      const gz = b.blasting ? b.gz + b.blastZ : b.gz + (b.dropping ? b.dropOffset : 0);
      entries.push({ key: E.depthKey(gx, gy, gz), b });
    });
    VH.monuments.pushEntries(entries, dip);
    entries.sort((a, b) => a.key - b.key);
    const sorted = entries; // each entry: { key, b } for blocks or { key, draw } for monuments
    // Warm ground pool under a near-miss arrangement — the peripheral
    // "where" signal the dog used to provide. One gradient, not one per
    // block; same idiom as the lamp under-glow below.
    if (W.warmCenter) {
      const wt = 7 - (clock.time - W.warmCenter.at);
      if (wt > 0) {
        const env = Math.min(1, wt / 1.5);
        const pulse = prefersReducedMotion ? 0.65 : 0.5 + 0.5 * Math.sin(clock.time * 4.2);
        const c = E.toScreen(W.warmCenter.gx + 1, W.warmCenter.gy + 1, 0);
        const r = E.TILE * E.SCALE * 3.5;
        const g = ctx.createRadialGradient(c.x, c.y, 0, c.x, c.y, r);
        g.addColorStop(0, `rgba(255,217,104,${0.11 * env * (0.7 + 0.3 * pulse)})`);
        g.addColorStop(1, 'rgba(255,217,104,0)');
        ctx.fillStyle = g;
        ctx.fillRect(c.x - r, c.y - r, r * 2, r * 2);
      }
    }
    // Lamp under-glow: warm pools of light beneath lamp blocks (behind blocks)
    W.blocks.forEach(b => {
      if (b.color !== 'lamp' || !W.isLive(b)) return;
      if (b.dropping && b.dropDelay > 0) return; // not on stage yet
      const c = E.toScreen(b.gx + 0.5, b.gy + 0.5, b.gz + (b.dropOffset || 0) + 0.5);
      const r = E.TILE * E.SCALE * 3;
      const flicker = 0.85 + 0.15 * Math.sin(clock.time * 3.1 + b.gx * 2 + b.gy);
      const g = ctx.createRadialGradient(c.x, c.y, 0, c.x, c.y, r);
      g.addColorStop(0, `rgba(255,196,90,${0.16 * flicker})`);
      g.addColorStop(1, 'rgba(255,196,90,0)');
      ctx.fillStyle = g;
      ctx.fillRect(c.x - r, c.y - r, r * 2, r * 2);
    });

    sorted.forEach(entry => {
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
        // Tumbling: rotate the whole block around its screen center
        const bgx = b.gx + b.blastX, bgy = b.gy + b.blastY, bgz = b.gz + b.blastZ;
        const c = E.toScreen(bgx + 0.5, bgy + 0.5, bgz + 0.5);
        ctx.save();
        ctx.translate(c.x, c.y);
        ctx.rotate(b.spin);
        ctx.translate(-c.x, -c.y);
        W.drawBlock(bgx, bgy, bgz, b.color, drawOpacity, squashOpts);
        ctx.restore();
      } else {
        const settled = !b.dropping && b.lift < 0.01;
        W.drawBlock(
          b.gx, b.gy,
          b.gz + (b.dropOffset || 0) + b.lift - dip,
          b.color, drawOpacity,
          { ...squashOpts, contact: settled && !isGlass }
        );
      }
    });

    // Lamp top-glow: a soft additive halo above each lamp (over blocks)
    W.blocks.forEach(b => {
      if (b.color !== 'lamp' || !W.isLive(b)) return;
      if (b.dropping && b.dropDelay > 0) return; // not on stage yet
      const c = E.toScreen(b.gx + 0.5, b.gy + 0.5, b.gz + (b.dropOffset || 0) + 1.1);
      const r = E.TILE * E.SCALE * 1.1;
      const g = ctx.createRadialGradient(c.x, c.y, 0, c.x, c.y, r);
      g.addColorStop(0, 'rgba(255,228,150,0.35)');
      g.addColorStop(1, 'rgba(255,228,150,0)');
      ctx.fillStyle = g;
      ctx.fillRect(c.x - r, c.y - r, r * 2, r * 2);
    });

    // Monument glows (lighthouse lamp room, gold pyramidion)
    VH.monuments.drawGlows();

    // Transform ceremonies: floating blocks, the rising model
    VH.monuments.update(dt);
    VH.monuments.drawCeremonies();

    // Blooms: ceremony flashes + firework detonations (behind the sparks)
    FX.updateAndDrawFlashes(dt);

    // Particles: landing dust + firework sparks
    FX.updateAndDrawDust(dt);

    // Ambient life
    FX.updateAndDrawFireflies(dt);
    FX.updateAndDrawResidentDog(dt, {
      pointerX: pointerScreen.x || null,
      rotating: isRotating || cam.tween !== null,
    });

    // Placement preview while dragging: ghost cube on the landing spot
    if (isDragging && hoverGrid && W.isOnPlatform(hoverGrid.gx, hoverGrid.gy)) {
      W.drawGhostBlock(hoverGrid.gx, hoverGrid.gy, hoverGrid.gz);
    }

    // Monument move preview: the whole structure ghosted at the
    // destination — its real colours when the drop is allowed, red when
    // the spot is blocked (releasing there refuses the move).
    if (dragMon && (dragMonDelta.dx || dragMonDelta.dy)) {
      const { dx, dy } = dragMonDelta;
      VH.monuments.orderedModel(dragMon).forEach(m => {
        W.drawBlock(m.gx + dx, m.gy + dy, m.gz - dip,
          dragMonValid ? m.color : 'lightRed', 0.4, { sxy: m.sxy, sz: m.sz });
      });
    }

    // The carried block: pops on pickup, tilts with drag velocity
    if (isDragging && dragBlock) {
      const t = E.TILE * E.SCALE;
      const popT = Math.min((clock.time - dragStartTime) / 0.12, 1);
      const pop = 1 + 0.15 * (1 - Math.pow(1 - popT, 3)); // ease-out to 1.15×
      const tilt = Math.max(-0.14, Math.min(0.14, dragVelX * 0.00012));
      ctx.save();
      ctx.translate(pointerScreen.x, pointerScreen.y - t);
      ctx.rotate(tilt);
      ctx.scale(pop, pop);
      W.drawBlockAtScreen(0, 0, dragBlock.color, 0.85);
      ctx.restore();
    }

    FX.drawAngryDog(dt);

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
      boxes.push({ id: mon.id, box: E.pieceAABB(p.gx, p.gy, p.gz, p.sxy, p.sz) })));
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
  } // end #dev hooks

  // ── Boot ────────────────────────────────────────────────────
  // Restore the visitor's saved build; fresh visitors get a random scatter.
  if (!W.load()) {
    W.spawnBlocks(25);
    W.save();
  }
  VH.monuments.buildCodex(); // badge shows the right count from the start
  requestAnimationFrame(render);

  // UI entrance (CSS transitions; anime.js dependency removed)
  const panel = document.getElementById('panel');
  const controls = document.getElementById('controls');
  const hint = document.getElementById('hint');
  // Touch devices get touch words
  if (window.matchMedia('(pointer: coarse)').matches) {
    hint.textContent = 'Tap to place blocks · Drag to move · Some shapes become monuments';
  }
  if (prefersReducedMotion) {
    panel.classList.add('show');
    controls.classList.add('show');
    hotbar.classList.add('show');
    hint.classList.add('show');
    uiReady = true;
    reflectSwatches();
  } else {
    setTimeout(() => { panel.classList.add('show'); controls.classList.add('show'); }, 600);
    setTimeout(() => { hotbar.classList.add('show'); uiReady = true; reflectSwatches(); }, 1000);
    setTimeout(() => { hint.classList.add('show'); }, 1800);
    setTimeout(() => { hint.classList.remove('show'); }, 7000);
  }
})();
