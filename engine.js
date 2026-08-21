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
    if (E._lightResize) E._lightResize();   // keep the light buffer in step
    if (E._shadowResize) E._shadowResize(); // and the shadow buffer
  }
  E.resize = resize;
  resize();
  window.addEventListener('resize', resize);

  // ── Light pass (bloom) ──────────────────────────────────────
  // Everything emissive registers itself with E.addLight instead of
  // painting its own radial gradient onto the scene. Lights collect in an
  // offscreen HALF-resolution buffer; once per frame (E.lightComposite)
  // the buffer is blurred and added over the finished scene with
  // globalCompositeOperation 'lighter' — which is what real bloom is.
  // The threshold is structural: the scene is never bright-passed, so
  // glow can only come from things that explicitly call addLight. On an
  // empty stage with no lamps/fireflies/fireworks this buffer is black.
  const lightCanvas = document.createElement('canvas');
  const lightCtx = lightCanvas.getContext('2d');
  E.LIGHT_GAIN = 0.8; // one global knob for the whole effect
  E.LIGHT_BLUR = 10;  // CSS px of spread at composite time

  // ctx.filter probe (very old Safari lacks it — fall back, don't fail)
  const filterOK = (() => {
    lightCtx.filter = 'blur(1px)';
    const ok = lightCtx.filter === 'blur(1px)';
    lightCtx.filter = 'none';
    return ok;
  })();
  const blurScratch = filterOK ? null : document.createElement('canvas');

  E._lightResize = () => {
    const dpr = Math.min(window.devicePixelRatio || 1, 2);
    lightCanvas.width = Math.max(1, Math.ceil(E.W * dpr / 2));
    lightCanvas.height = Math.max(1, Math.ceil(E.H * dpr / 2));
    // Same trick as the main canvas: pre-scale the transform so all
    // callers keep working in CSS pixels.
    lightCtx.setTransform(dpr / 2, 0, 0, dpr / 2, 0, 0);
    // Lights stack like PAINT inside the buffer (saturating, matching the
    // old per-object gradients) — NOT additively. With 'lighter' here, 25
    // overlapping lamp pools summed linearly and blew the scene out
    // (first review verdict: "way too bright"). The single composite of
    // the finished buffer over the scene stays additive — that's the
    // bloom; this line is why dense scenes no longer escalate.
    lightCtx.globalCompositeOperation = 'source-over';
  };
  E._lightResize();

  // Soft-dot sprites: one tiny canvas per colour with the falloff baked in
  // (solid centre -> transparent edge), drawn scaled to any radius. Made
  // ONCE per colour for the life of the page — this is what replaces the
  // per-object createRadialGradient calls (hundreds per frame during a
  // firework Clear) with zero per-frame allocation.
  const SPRITE_R = 32;
  const lightSprites = new Map();
  function lightSprite(rgb) {
    let s = lightSprites.get(rgb);
    if (s) return s;
    s = document.createElement('canvas');
    s.width = s.height = SPRITE_R * 2;
    const c = s.getContext('2d');
    const g = c.createRadialGradient(SPRITE_R, SPRITE_R, 0, SPRITE_R, SPRITE_R, SPRITE_R);
    g.addColorStop(0, `rgba(${rgb},1)`);
    g.addColorStop(1, `rgba(${rgb},0)`);
    c.fillStyle = g;
    c.fillRect(0, 0, SPRITE_R * 2, SPRITE_R * 2);
    lightSprites.set(rgb, s);
    return s;
  }

  // Register one light for this frame. x/y/radius in CSS px, rgb as
  // '255,196,90', intensity = the old gradient's peak alpha (0..1).
  E.addLight = (x, y, radius, rgb, intensity) => {
    const a = intensity * E.LIGHT_GAIN;
    if (a <= 0 || radius <= 0) return;
    lightCtx.globalAlpha = Math.min(1, a);
    lightCtx.drawImage(lightSprite(rgb), x - radius, y - radius, radius * 2, radius * 2);
  };

  // Top of the frame: wipe the buffer for this frame's lights.
  E.lightBegin = () => {
    lightCtx.save();
    lightCtx.setTransform(1, 0, 0, 1, 0, 0);
    lightCtx.globalCompositeOperation = 'source-over';
    lightCtx.clearRect(0, 0, lightCanvas.width, lightCanvas.height);
    lightCtx.restore(); // back to the dpr/2 transform + paint-style stacking
  };

  // End of the frame: blur once, add over the scene. save/restore
  // guarantees no filter/composite state leaks out of the frame — the
  // postcard export reads the canvas BETWEEN frames and must see clean
  // state.
  E.lightComposite = () => {
    const c = E.ctx;
    c.save();
    c.imageSmoothingEnabled = true; // the buffer upscales 2x; smooth it
    c.globalCompositeOperation = 'lighter';
    if (filterOK) {
      c.filter = `blur(${E.LIGHT_BLUR}px)`;
      c.drawImage(lightCanvas, 0, 0, lightCanvas.width, lightCanvas.height, 0, 0, E.W, E.H);
    } else {
      // No ctx.filter: fake the blur by bouncing through a quarter-res
      // scratch with smoothing on — softer and cheaper, never a hard fail.
      blurScratch.width = Math.max(1, lightCanvas.width >> 1);
      blurScratch.height = Math.max(1, lightCanvas.height >> 1);
      const sc = blurScratch.getContext('2d');
      sc.imageSmoothingEnabled = true;
      sc.drawImage(lightCanvas, 0, 0, blurScratch.width, blurScratch.height);
      c.drawImage(blurScratch, 0, 0, blurScratch.width, blurScratch.height, 0, 0, E.W, E.H);
    }
    c.restore();
  };

  // ── The moon (single source of truth) ───────────────────────
  // Screen position + drawn radius were copy-pasted in four files; the
  // light maths, the drawn moon, the rim highlight and the silhouettes
  // must all agree or the shadows point away from the visible moon.
  E.MOON = { fx: 0.82, fy: 0.13, r: 40 };
  // Altitude in grid units. THE mood knob: lower = longer raking shadows
  // AND darker sides/tops (both derive from it in updateLightInfo), so
  // one number keeps light and shadow physically consistent.
  E.MOON_ALT = 18;

  // ── Shadow pass ─────────────────────────────────────────────
  // Mirror of the light pass, pointing the other way: every caster
  // registers one ground-plane quad; quads render into an offscreen
  // half-res buffer (black, blurred as they are drawn — wider with
  // caster height), and the buffer composites over the platform ONCE at
  // E.SHADOW_STRENGTH. Overlaps merge inside the buffer instead of
  // stacking on the canvas. This replaces the old per-quad fills, which
  // (a) double-multiplied fillStyle × globalAlpha to ~4.5× fainter than
  // the constants read, and (b) stacked a 4-high tower ~3.7× darker
  // than a lone block, with banding.
  const shadowCanvas = document.createElement('canvas');
  const shadowCtx = shadowCanvas.getContext('2d');
  E.SHADOW_STRENGTH = 0.4; // the ONE darkness number (composite alpha)
  let shadowQuads = [];

  E._shadowResize = () => {
    const dpr = Math.min(window.devicePixelRatio || 1, 2);
    shadowCanvas.width = Math.max(1, Math.ceil(E.W * dpr / 2));
    shadowCanvas.height = Math.max(1, Math.ceil(E.H * dpr / 2));
    shadowCtx.setTransform(dpr / 2, 0, 0, dpr / 2, 0, 0);
  };
  E._shadowResize();

  E.shadowBegin = () => {
    shadowQuads.length = 0;
    shadowCtx.save();
    shadowCtx.setTransform(1, 0, 0, 1, 0, 0);
    shadowCtx.clearRect(0, 0, shadowCanvas.width, shadowCanvas.height);
    shadowCtx.restore();
  };

  // Convex hull (monotone chain) of 2D points [[x,y],…] — tiny input
  // sets (8 points per caster), so cost is negligible.
  function convexHull(pts) {
    const s = [...pts].sort((a, b) => a[0] - b[0] || a[1] - b[1]);
    const cross = (o, a, b) =>
      (a[0] - o[0]) * (b[1] - o[1]) - (a[1] - o[1]) * (b[0] - o[0]);
    const lower = [];
    for (const p of s) {
      while (lower.length >= 2 && cross(lower[lower.length - 2], lower[lower.length - 1], p) <= 0) lower.pop();
      lower.push(p);
    }
    const upper = [];
    for (let i = s.length - 1; i >= 0; i--) {
      const p = s[i];
      while (upper.length >= 2 && cross(upper[upper.length - 2], upper[upper.length - 1], p) <= 0) upper.pop();
      upper.push(p);
    }
    lower.pop(); upper.pop();
    return lower.concat(upper);
  }

  // Register one caster VOLUME. The shadow of a box is its whole body
  // swept along the light direction onto the ground: the base ring and
  // the top ring both project, and the shadow is the convex hull of the
  // two (a hexagon). This is what keeps a shadow ATTACHED to its
  // caster's feet and CONTINUOUS up a stacked pillar — the earlier
  // top-face-only quads floated away from the base and left gaps.
  // gx/gy/gz/sxy/sz in grid units (live position, not resting state);
  // alpha = in-buffer weight (height falloff); dip = platform sink so
  // shadows land on the real ground plane.
  E.addShadowBox = (gx, gy, gz, sxy, sz, alpha, dip) => {
    if (alpha <= 0) return;
    const bz = Math.max(0, gz); // the underground part of a box casts nothing
    const tz = gz + sz;
    if (tz <= bz) return;
    const li = E.li;
    const x0 = gx + (1 - sxy) / 2, x1 = gx + (1 + sxy) / 2;
    const y0 = gy + (1 - sxy) / 2, y1 = gy + (1 + sxy) / 2;
    const pts = [];
    for (const z of [bz, tz]) {
      const ox = z * li.shadowDx, oy = z * li.shadowDy;
      pts.push([x0 + ox, y0 + oy], [x1 + ox, y0 + oy],
               [x1 + ox, y1 + oy], [x0 + ox, y1 + oy]);
    }
    const d = -(dip || 0);
    const poly = convexHull(pts).map(p => E.toScreen(p[0], p[1], d));
    shadowQuads.push({ poly, alpha, h: tz });
  };

  // Three blur buckets: contact shadows stay tight and grounded, high
  // casters go wide and soft — the cue that reads as "cast by a light".
  const SHADOW_BUCKETS = [
    { maxH: 1.2, blur: 2 },
    { maxH: 3.0, blur: 5 },
    { maxH: Infinity, blur: 9 },
  ];

  // clipPoly: the RECEIVING surface (the platform top, computed per
  // frame — it rotates and dips). Shadows end where the ground ends: a
  // floating island casts nothing into the void past its rim.
  E.shadowComposite = (clipPoly) => {
    if (!shadowQuads.length) return; // empty stage: buffer was just cleared, skip the blit
    for (const bk of SHADOW_BUCKETS) {
      let any = false;
      for (const q of shadowQuads) {
        if (q.h > bk.maxH || q.done) continue;
        q.done = true;
        if (!any) { shadowCtx.filter = filterOK ? `blur(${bk.blur}px)` : 'none'; any = true; }
        shadowCtx.globalAlpha = q.alpha;
        shadowCtx.fillStyle = '#000';
        shadowCtx.beginPath();
        shadowCtx.moveTo(q.poly[0].x, q.poly[0].y);
        for (let k = 1; k < q.poly.length; k++) shadowCtx.lineTo(q.poly[k].x, q.poly[k].y);
        shadowCtx.closePath();
        shadowCtx.fill();
      }
    }
    shadowCtx.filter = 'none';
    shadowCtx.globalAlpha = 1;
    const c = E.ctx;
    c.save();
    if (clipPoly && clipPoly.length >= 3) {
      c.beginPath();
      c.moveTo(clipPoly[0].x, clipPoly[0].y);
      for (let k = 1; k < clipPoly.length; k++) c.lineTo(clipPoly[k].x, clipPoly[k].y);
      c.closePath();
      c.clip();
    }
    c.imageSmoothingEnabled = true; // half-res buffer upscales; smooth it
    c.globalAlpha = E.SHADOW_STRENGTH;
    c.drawImage(shadowCanvas, 0, 0, shadowCanvas.width, shadowCanvas.height, 0, 0, E.W, E.H);
    c.restore();
  };

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
    const mx = E.MOON.fx * E.W, my = E.MOON.fy * E.H;
    // Moon direction from scene center → continuous grid coords
    const relX = mx - c.x;
    const relY = my - c.y;
    const rx = (relX / t + 2 * relY / t) / 2;
    const ry = (2 * relY / t - relX / t) / 2;
    const moonGx = rx * E.cosA + ry * E.sinA;
    const moonGy = -rx * E.sinA + ry * E.cosA;
    const moonGz = E.MOON_ALT; // the live mood knob (see E.MOON above)
    const len = Math.sqrt(moonGx * moonGx + moonGy * moonGy + moonGz * moonGz);
    const lx = moonGx / len, ly = moonGy / len, lz = moonGz / len;
    E.li = {
      shadowDx: -moonGx / moonGz,
      shadowDy: -moonGy / moonGz,
      topLight: lz,
      pxLight: lx, nxLight: -lx,
      pyLight: ly, nyLight: -ly,
      moonSx: mx, moonSy: my, // hoisted: rim highlight reads these per block
      altitude: moonGz,
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
