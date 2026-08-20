/* ============================================================
   engine.js — canvas, camera, projection, lighting, clock
   Load order: engine.js → world.js → fx.js → game.js
   Shared namespace: window.VH
   ============================================================ */
(() => {
  'use strict';
  const VH = (window.VH = window.VH || {});

  const canvas = document.getElementById('scene');
  const ctx = canvas.getContext('2d');

  const E = (VH.engine = {
    canvas, ctx,
    W: 0, H: 0, SCALE: 1,
    TILE: 20,
    // Scene-wide accessibility switch: no throws, shakes, tumbles, or
    // ambient sway for visitors who prefer reduced motion.
    reducedMotion: window.matchMedia('(prefers-reduced-motion: reduce)').matches,
  });

  function resize() {
    const dpr = Math.min(window.devicePixelRatio || 1, 2); // cap DPR at 2
    E.W = window.innerWidth;
    E.H = window.innerHeight;
    canvas.width = E.W * dpr;
    canvas.height = E.H * dpr;
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.imageSmoothingEnabled = false;
    E.SCALE = Math.min(E.W, E.H) / 600;
    E.dirty = true; // cached layers must rebuild
  }
  E.resize = resize;
  resize();
  window.addEventListener('resize', resize);

  // ── Clock (real time, not frame count) ──────────────────────
  // dt is capped so a backgrounded tab resuming doesn't explode physics.
  const clock = (VH.clock = { time: 0, dt: 0, last: null });
  const DT_CAP = 1 / 20; // max 50 ms per step

  clock.tick = (nowMs) => {
    if (clock.last === null) clock.last = nowMs;
    clock.dt = Math.min((nowMs - clock.last) / 1000, DT_CAP);
    clock.last = nowMs;
    clock.time += clock.dt;
    return clock.dt;
  };
  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState === 'visible') clock.last = null; // no dt spike on resume
  });

  // ── Camera (rotation with spring snap to 90° steps) ─────────
  const HALF_PI = Math.PI / 2;
  const cam = (VH.camera = {
    angle: 0,          // radians; rests only on multiples of HALF_PI
    tween: null,       // { from, to, t, dur }
  });

  // easeOutBack — a slight overshoot so the snap feels physical
  function backOut(t) {
    const s = 1.2;
    const u = t - 1;
    return u * u * ((s + 1) * u + s) + 1;
  }

  cam.snapTo = (target, dur = 0.5) => {
    cam.tween = { from: cam.angle, to: target, t: 0, dur };
  };
  cam.nearestSnap = () => Math.round(cam.angle / HALF_PI) * HALF_PI;
  cam.rotateStep = (dir) => {
    // dir: +1 / -1 quarter turns from the current resting target
    const base = cam.tween ? cam.tween.to : cam.nearestSnap();
    cam.snapTo(base + dir * HALF_PI, 0.5);
  };
  cam.cancelTween = () => { cam.tween = null; };
  cam.update = (dt) => {
    if (!cam.tween) return;
    const tw = cam.tween;
    tw.t += dt;
    const p = Math.min(tw.t / tw.dur, 1);
    cam.angle = tw.from + (tw.to - tw.from) * backOut(p);
    if (p >= 1) { cam.angle = tw.to; cam.tween = null; }
  };

  // ── Camera shake (per-frame jitter, decays exponentially) ───
  E.shake = 0;      // magnitude in px
  E.shakeX = 0;
  E.shakeY = 0;
  E.kickShake = (mag) => { E.shake = Math.max(E.shake, mag); };

  // ── Projection ──────────────────────────────────────────────
  function sceneCenter() { return { x: E.W / 2 + E.shakeX, y: E.H * 0.46 + E.shakeY }; }
  E.sceneCenter = sceneCenter;

  // Grid → Screen. Rotate grid coords, then standard isometric projection.
  E.toScreen = (gx, gy, gz) => {
    const t = E.TILE * E.SCALE;
    const c = sceneCenter();
    const rx = gx * E.cosA - gy * E.sinA;
    const ry = gx * E.sinA + gy * E.cosA;
    return {
      x: c.x + (rx - ry) * t,
      y: c.y + (rx + ry) * t * 0.5 - gz * t,
    };
  };

  // Screen → Grid (ground plane gz=0)
  E.toGrid = (sx, sy) => {
    const t = E.TILE * E.SCALE;
    const c = sceneCenter();
    const relX = sx - c.x;
    const relY = sy - c.y;
    const rx = (relX / t + 2 * relY / t) / 2;
    const ry = (2 * relY / t - relX / t) / 2;
    const gx = rx * E.cosA + ry * E.sinA;
    const gy = -rx * E.sinA + ry * E.cosA;
    return { gx: Math.floor(gx), gy: Math.floor(gy) };
  };

  // ── Per-frame derived state (face vectors, lighting) ────────
  E.fv = {};
  E.li = {};
  E.cosA = 1;
  E.sinA = 0;

  E.updateFaceVectors = () => {
    const t = E.TILE * E.SCALE;
    // One jitter sample per frame so every projection in the frame agrees
    if (E.shake > 0.05) {
      E.shakeX = (Math.random() - 0.5) * E.shake;
      E.shakeY = (Math.random() - 0.5) * E.shake;
      E.shake *= Math.exp(-10 * VH.clock.dt);
    } else {
      E.shake = 0; E.shakeX = 0; E.shakeY = 0;
    }
    E.cosA = Math.cos(cam.angle);
    E.sinA = Math.sin(cam.angle);
    const cos_a = E.cosA, sin_a = E.sinA;
    E.fv = {
      ux: { x: (cos_a - sin_a) * t, y: (cos_a + sin_a) * t * 0.5 },
      uy: { x: -(sin_a + cos_a) * t, y: (cos_a - sin_a) * t * 0.5 },
      uz: { x: 0, y: -t },
      xVisible: (cos_a + sin_a) > 0,
      yVisible: (cos_a - sin_a) > 0,
    };
  };

  E.updateLightInfo = () => {
    const t = E.TILE * E.SCALE;
    const c = sceneCenter();
    const mx = 0.82 * E.W, my = 0.13 * E.H;
    // Moon direction from scene center → continuous grid coords
    const relX = mx - c.x;
    const relY = my - c.y;
    const rx = (relX / t + 2 * relY / t) / 2;
    const ry = (2 * relY / t - relX / t) / 2;
    const moonGx = rx * E.cosA + ry * E.sinA;
    const moonGy = -rx * E.sinA + ry * E.cosA;
    const moonGz = 18;
    const len = Math.sqrt(moonGx * moonGx + moonGy * moonGy + moonGz * moonGz);
    const lx = moonGx / len, ly = moonGy / len, lz = moonGz / len;
    E.li = {
      shadowDx: -moonGx / moonGz,
      shadowDy: -moonGy / moonGz,
      topLight: lz,
      pxLight: lx, nxLight: -lx,
      pyLight: ly, nyLight: -ly,
    };
  };

  // Depth sort key for the current rotation
  E.depthKey = (gx, gy, gz) => gx * (E.cosA + E.sinA) + gy * (E.cosA - E.sinA) + gz * 0.01;

  // ── AABB helpers (occupancy, leftover sweep, occlusion sort) ──
  // pieceAABB mirrors drawBlock's geometry EXACTLY: sxy widens the piece in
  // BOTH ground axes about the cell center; sz extends upward from gz.
  E.SOLID_EPS = 0.08; // how deep a block must intrude before it counts as "inside"
  E.pieceAABB = (gx, gy, gz, sxy, sz) => ({
    x0: gx + (1 - sxy) / 2, x1: gx + (1 + sxy) / 2,
    y0: gy + (1 - sxy) / 2, y1: gy + (1 + sxy) / 2,
    z0: gz, z1: gz + sz,
  });
  E.cellAABB = (gx, gy, gz) => E.pieceAABB(gx, gy, gz, 1, 1);
  // Overlap must exceed eps on ALL THREE axes (a hairline graze doesn't count)
  E.aabbOverlap = (a, b, eps = 0) =>
    a.x1 - eps > b.x0 && b.x1 - eps > a.x0 &&
    a.y1 - eps > b.y0 && b.y1 - eps > a.y0 &&
    a.z1 - eps > b.z0 && b.z1 - eps > a.z0;

  // Extents of an AABB in CAMERA space (u,v = rotated ground axes, z up).
  // Closed form, valid at ANY angle — including mid-rotation-tween.
  E.camExtents = (a, cosA = E.cosA, sinA = E.sinA) => {
    const cx = (a.x0 + a.x1) / 2, cy = (a.y0 + a.y1) / 2;
    const hx = (a.x1 - a.x0) / 2, hy = (a.y1 - a.y0) / 2;
    const uc = cx * cosA - cy * sinA, ur = Math.abs(cosA) * hx + Math.abs(sinA) * hy;
    const vc = cx * sinA + cy * cosA, vr = Math.abs(sinA) * hx + Math.abs(cosA) * hy;
    return { u0: uc - ur, u1: uc + ur, v0: vc - vr, v1: vc + vr, z0: a.z0, z1: a.z1 };
  };

  // ── Geometry helper ─────────────────────────────────────────
  E.pointInQuad = (px, py, q0, q1, q2, q3) => {
    const pts = [q0, q1, q2, q3];
    let pos = 0, neg = 0;
    for (let i = 0; i < 4; i++) {
      const a = pts[i], b = pts[(i + 1) % 4];
      const cross = (b.x - a.x) * (py - a.y) - (b.y - a.y) * (px - a.x);
      if (cross > 0) pos++; else if (cross < 0) neg++;
    }
    return pos === 0 || neg === 0;
  };
})();
