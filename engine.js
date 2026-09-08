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

  // THE one reduced-motion source (game.js used to keep its own copy).
  // Kept live: flipping the OS setting mid-session takes effect at the
  // next spawn/gesture — every consumer reads E.reducedMotion at use
  // time, so audio and visuals can never disagree about it.
  const motionQuery = window.matchMedia('(prefers-reduced-motion: reduce)');

  const E = (VH.engine = {
    canvas, ctx,
    W: 0, H: 0, SCALE: 1,
    // SCALE = BASE_SCALE * ZOOM, always. BASE_SCALE is the framing
    // formula (what resize computes); ZOOM is the user's multiplier and
    // must survive a resize — writing zoom into SCALE directly would be
    // wiped by the next rotate-your-phone. panX/panY shift the scene
    // anchor so a zoom can follow the fingers/cursor; both live in
    // sceneCenter() so every projection and hit-test gets them free.
    BASE_SCALE: 1, ZOOM: 1, panX: 0, panY: 0,
    // The framing formula's two knobs (BASE_SCALE = min(W,H)/FRAME_DIV,
    // anchor y = H*FRAME_ANCHOR). Geometry: the island's screen width is
    // ~440*SCALE px, so on a portrait phone (min = W) the divisor IS the
    // width fraction — 600 → 73% of the width, 500 → 88%, 460 → 96%.
    // Variants are picked on a real phone via the #dev framing picker.
    // 500 = variant B, designer-picked on their phone 2026-08-27 (~88%
    // of a portrait phone's width; was 600 / 73% at launch).
    FRAME_DIV: 500, FRAME_ANCHOR: 0.46,
    TILE: 20,
    // Scene-wide accessibility switch: no throws, shakes, tumbles, or
    // ambient sway for visitors who prefer reduced motion.
    reducedMotion: motionQuery.matches,
  });
  motionQuery.addEventListener('change', (e) => { E.reducedMotion = e.matches; });

  function resize() {
    const dpr = Math.min(window.devicePixelRatio || 1, 2); // cap DPR at 2
    E.W = window.innerWidth;
    E.H = window.innerHeight;
    canvas.width = E.W * dpr;
    canvas.height = E.H * dpr;
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.imageSmoothingEnabled = false;
    E.BASE_SCALE = Math.min(E.W, E.H) / E.FRAME_DIV;
    E.SCALE = E.BASE_SCALE * E.ZOOM;
    if (E._clampPan) E._clampPan(); // viewport changed → pan bounds changed
    if (E._lightResize) E._lightResize();   // keep the light buffer in step
    if (E._shadowResize) E._shadowResize(); // and the shadow buffer
    if (E._holoResize) E._holoResize();     // and the hologram buffer
    if (E._groundResize) E._groundResize(); // and the ground-light buffer
    if (E.placeMoon) E.placeMoon();         // the moon clears the top-right controls
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
  E.lightSprite = (rgb) => lightSprite(rgb);
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

  // Directional light sources the WORLD reacts to (drawBlock reads these
  // and brightens the faces that face the beam). Cleared every frame;
  // grid-space: origin (gx,gy,gz), unit direction (dx,dy), length, and
  // the drop per cell of travel (a lighthouse beam tilts toward the sea).
  E.beams = [];
  E.beamLit = null;   // per-frame directional light from the beam (monuments.registerBeams)
  E.addBeam = (b) => { E.beams.push(b); };

  // ── The light list ───────────────────────────────────────────
  // Every point light the WORLD reacts to (faces in drawBlock, pools on
  // the ground). Grid space. Registration lands in the NEXT frame's list:
  // most emitters register after the sorted world has drawn (drawGlows,
  // fireflies, flashes), so a same-frame list would be empty when faces
  // read it. One frame of lag on a lamp is invisible; one rule for all.
  //   E.addPoint(gx, gy, gz, radius /*grid units*/, rgb /*'255,196,90'*/,
  //              intensity, { faces, ground })
  // The fill string is built once here, never per face in drawBlock.
  E.lights = [];
  let lightsNext = [];
  E.addPoint = (gx, gy, gz, r, rgb, intensity, opts = {}) => {
    if (intensity <= 0 || r <= 0) return;
    lightsNext.push({ gx, gy, gz, r, rgb, intensity, fill: 'rgb(' + rgb + ')',
      faces: opts.faces !== false, ground: !!opts.ground });
  };
  E.LIGHTS_ON = true; // vh-dev-light {lights:0} kill switch

  // ── The cone as a picture ──────────────────────────────────
  // One soft cone image, made once: an apex on the left spreading to the
  // right, fading across its width and along its length (brightest at
  // the source). Everything below maps this ONE image onto planes in the
  // world with exact triangle-to-triangle transforms — the isometric
  // projection is affine, so a cone lying on a plane is a plain skew of
  // this picture. No per-frame gradients, no filled polygons.
  const CONE_W = 256, CONE_H = 128;
  E.CONE_W = CONE_W;
  // Two along-axis profiles, one picture each:
  //   shaft — brightest at the lamp, dispersing to NOTHING by the far end
  //           (a searchlight thins into the night; it never ends in a line)
  //   pool  — fades IN past the lamp's foot (the cone is above the ground
  //           there) and out to nothing at the far end. Before this the
  //           pool was the shaft sprite cut off at `near`: a straight
  //           full-brightness edge across the grass.
  const CONE_PROFILE = {
    shaft: (t) => Math.pow(1 - t, 0.85) * Math.min(1, t * 12 + 0.15),
  };
  E.CONE_PROFILE = CONE_PROFILE; // dev: swap the curve, then E._coneReset()
  const coneSprites = {};
  E._coneReset = () => { for (const k in coneSprites) delete coneSprites[k]; };
  function makeConeSprite(profile) {
    const c = document.createElement('canvas');
    c.width = CONE_W; c.height = CONE_H;
    const x = c.getContext('2d');
    const img = x.createImageData(CONE_W, CONE_H), d = img.data;
    for (let py = 0; py < CONE_H; py++) {
      for (let px = 0; px < CONE_W; px++) {
        const t = px / (CONE_W - 1);
        const hw = 3 + (CONE_H / 2 - 3) * t;
        const dy = Math.abs(py + 0.5 - CONE_H / 2);
        let a = Math.max(0, 1 - dy / hw);
        a = Math.pow(a, 1.7) * profile(t);
        const i = (py * CONE_W + px) * 4;
        d[i] = 255; d[i + 1] = 226; d[i + 2] = 168; d[i + 3] = Math.round(a * 255);
      }
    }
    x.putImageData(img, 0, 0);
    return c;
  }
  // Affine map taking sprite triangle (s0,s1,s2) onto screen triangle (t0,t1,t2)
  function affineTri(s0, s1, s2, t0, t1, t2) {
    const ax = s1.x - s0.x, ay = s1.y - s0.y, bx = s2.x - s0.x, by = s2.y - s0.y;
    const det = ax * by - ay * bx;
    if (Math.abs(det) < 1e-9) return null;
    const ux = t1.x - t0.x, uy = t1.y - t0.y, vx = t2.x - t0.x, vy = t2.y - t0.y;
    // M maps (ax,ay)->(ux,uy), (bx,by)->(vx,vy)
    const a = (ux * by - vx * ay) / det, c = (vx * ax - ux * bx) / det;
    const b = (uy * by - vy * ay) / det, d = (vy * ax - uy * bx) / det;
    return [a, b, c, d, t0.x - a * s0.x - c * s0.y, t0.y - b * s0.x - d * s0.y];
  }
  const S_APEX = { x: 0, y: CONE_H / 2 }, S_TOP = { x: CONE_W, y: 0 }, S_BOT = { x: CONE_W, y: CONE_H };
  E.drawConeSlice = (ctx, tri, x0, x1, alpha, kind = 'shaft') => {
    const coneSprite = coneSprites[kind] || (coneSprites[kind] = makeConeSprite(CONE_PROFILE[kind]));
    const m = affineTri(S_APEX, S_TOP, S_BOT, tri[0], tri[1], tri[2]);
    if (!m) return;
    ctx.save();
    ctx.globalCompositeOperation = 'lighter';
    ctx.globalAlpha = alpha;
    ctx.imageSmoothingEnabled = true;
    ctx.transform(m[0], m[1], m[2], m[3], m[4], m[5]);
    ctx.drawImage(coneSprite, x0, 0, x1 - x0, CONE_H, x0, 0, x1 - x0, CONE_H);
    ctx.restore();
  };

  // ── Ground light ─────────────────────────────────────────────
  // The grass is a cached bitmap, so light that lands on the ground is
  // painted live, here, after the moon shadows and before the world:
  // point lights as a soft disc mapped onto the ground plane (E.fv.ux/uy
  // ARE the ground basis, so the unit disc lands as the right iso
  // ellipse), the lighthouse pool as the cone sprite. The lighthouse's
  // shadows are punched OUT of its own pool before it joins the buffer —
  // a shadow is the absence of that light, nothing else. Lights stack
  // source-over inside; one 'lighter' composite, clipped to the platform.
  const groundCanvas = document.createElement('canvas');
  const groundCtx = groundCanvas.getContext('2d');
  E.GROUND_GAIN = 1.0;
  E._groundResize = () => {
    const dpr = Math.min(window.devicePixelRatio || 1, 2);
    groundCanvas.width = Math.max(1, Math.ceil(E.W * dpr / 2));
    groundCanvas.height = Math.max(1, Math.ceil(E.H * dpr / 2));
    groundCtx.setTransform(dpr / 2, 0, 0, dpr / 2, 0, 0);
  };
  E._groundResize();
  let groundUsed = false;
  E.groundDraw = (dip) => {
    groundUsed = false;
    groundCtx.save();
    groundCtx.setTransform(1, 0, 0, 1, 0, 0);
    groundCtx.clearRect(0, 0, groundCanvas.width, groundCanvas.height);
    groundCtx.restore();
    const fv = E.fv;
    for (const l of E.lights) {
      if (!l.ground) continue;
      const c = E.toScreen(l.gx, l.gy, -dip), s = l.r / SPRITE_R;
      groundCtx.save();
      groundCtx.transform(fv.ux.x * s, fv.ux.y * s, fv.uy.x * s, fv.uy.y * s, c.x, c.y);
      groundCtx.globalAlpha = Math.min(1, l.intensity * 0.55 * E.GROUND_GAIN);
      groundCtx.drawImage(lightSprite(l.rgb), -SPRITE_R, -SPRITE_R);
      groundCtx.restore();
      groundUsed = true;
    }
  };
  E.groundComposite = (clipPoly) => {
    if (!groundUsed) return;
    const c = E.ctx;
    c.save();
    if (clipPoly && clipPoly.length >= 3) {
      c.beginPath();
      c.moveTo(clipPoly[0].x, clipPoly[0].y);
      for (let k = 1; k < clipPoly.length; k++) c.lineTo(clipPoly[k].x, clipPoly[k].y);
      c.closePath();
      c.clip();
    }
    c.imageSmoothingEnabled = true;
    c.globalCompositeOperation = 'lighter';
    c.globalAlpha = 1;
    c.drawImage(groundCanvas, 0, 0, groundCanvas.width, groundCanvas.height, 0, 0, E.W, E.H);
    c.restore();
  };

  // Top of the frame: wipe the buffer for this frame's lights.
  E.lightBegin = () => {
    E.beams.length = 0;
    E.beamLit = null;
    E.lights = E.LIGHTS_ON ? lightsNext : [];
    lightsNext = [];
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
  E.MOON = { fx: 0.82, fy: 0.19, r: 40 };
  // The HUD's control row lives in the top-right corner of every viewport.
  // On a phone the moon moves down and inward so it never sits behind the
  // buttons (the audit's first finding). Called from resize().
  E.placeMoon = () => {
    if (E.W < 600) { E.MOON.fx = 0.68; E.MOON.fy = 0.24; }
    else { E.MOON.fx = 0.82; E.MOON.fy = 0.19; }
  };
  E.placeMoon();
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
  // Scratch buffer for one blur BUCKET at a time: quads fill here sharp
  // (cheap), then the whole bucket blurs in ONE filtered drawImage into
  // shadowCanvas. The old path set ctx.filter and filled each quad
  // individually — every fill paid a full blur rasterization, so a busy
  // board (~180 casters) cost ~180 blur passes per frame and measured
  // 278 ms/frame in software rendering. Same visual model (per-quad
  // alpha, in-bucket stacking, per-bucket radius), ≤3 blurs per frame.
  const shadowScratch = document.createElement('canvas');
  const scratchCtx = shadowScratch.getContext('2d');
  E.SHADOW_STRENGTH = 0.4; // the ONE darkness number (composite alpha)
  let shadowQuads = [];

  E._shadowResize = () => {
    const dpr = Math.min(window.devicePixelRatio || 1, 2);
    shadowCanvas.width = Math.max(1, Math.ceil(E.W * dpr / 2));
    shadowCanvas.height = Math.max(1, Math.ceil(E.H * dpr / 2));
    shadowCtx.setTransform(dpr / 2, 0, 0, dpr / 2, 0, 0);
    shadowScratch.width = shadowCanvas.width;
    shadowScratch.height = shadowCanvas.height;
    scratchCtx.setTransform(dpr / 2, 0, 0, dpr / 2, 0, 0);
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
  E.addShadowBox = (gx, gy, gz, sxy, sz, alpha, dip, sy) => {
    if (alpha <= 0) return;
    if (sy == null) sy = sxy; // rectangular casters: sy defaults to square
    const bz = Math.max(0, gz); // the underground part of a box casts nothing
    const tz = gz + sz;
    if (tz <= bz) return;
    const li = E.li;
    const x0 = gx + (1 - sxy) / 2, x1 = gx + (1 + sxy) / 2;
    const y0 = gy + (1 - sy) / 2, y1 = gy + (1 + sy) / 2;
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
        if (!any) {
          // Bucket begins: wipe the scratch stage
          scratchCtx.save();
          scratchCtx.setTransform(1, 0, 0, 1, 0, 0);
          scratchCtx.clearRect(0, 0, shadowScratch.width, shadowScratch.height);
          scratchCtx.restore();
          any = true;
        }
        // Sharp fill — the blur happens once for the whole bucket below
        scratchCtx.globalAlpha = q.alpha;
        scratchCtx.fillStyle = '#000';
        scratchCtx.beginPath();
        scratchCtx.moveTo(q.poly[0].x, q.poly[0].y);
        for (let k = 1; k < q.poly.length; k++) scratchCtx.lineTo(q.poly[k].x, q.poly[k].y);
        scratchCtx.closePath();
        scratchCtx.fill();
      }
      if (any) {
        scratchCtx.globalAlpha = 1;
        shadowCtx.save();
        shadowCtx.setTransform(1, 0, 0, 1, 0, 0);
        shadowCtx.filter = filterOK ? `blur(${bk.blur}px)` : 'none';
        shadowCtx.drawImage(shadowScratch, 0, 0);
        shadowCtx.restore(); // restores filter + transform together
      }
    }
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

  // ── Hologram pass ───────────────────────────────────────────
  // The ceremony's silhouette reveal. Same architecture as the shadow
  // pass: shapes render OPAQUE into an offscreen half-res buffer (so
  // overlapping monument pieces merge into one union of light instead
  // of stacking additively — no internal seams, no hot spots), and the
  // buffer composites onto the scene ONCE, additively, at the caller's
  // strength. The strength knob is the whole crescendo: monuments.js
  // ramps it up note by note and back down through the crossfade.
  // Empty frames skip the blit entirely (the shadow pass's early-out).
  const holoCanvas = document.createElement('canvas');
  const holoCtx = holoCanvas.getContext('2d');
  // The edge buffer: the hologram erased by itself shifted a pixel each
  // way leaves only the OUTLINE of the union — a crisp silhouette with
  // no internal seams, which is what makes the shape legible before it
  // becomes stone. Four half-res drawImages, only while a ceremony runs.
  const holoEdgeCanvas = document.createElement('canvas');
  const holoEdgeCtx = holoEdgeCanvas.getContext('2d');
  let holoUsed = false;

  E._holoResize = () => {
    const dpr = Math.min(window.devicePixelRatio || 1, 2);
    holoCanvas.width = Math.max(1, Math.ceil(E.W * dpr / 2));
    holoCanvas.height = Math.max(1, Math.ceil(E.H * dpr / 2));
    holoCtx.setTransform(dpr / 2, 0, 0, dpr / 2, 0, 0);
    holoEdgeCanvas.width = holoCanvas.width;
    holoEdgeCanvas.height = holoCanvas.height;
  };
  E._holoResize();

  E.holoBegin = () => {
    holoUsed = false;
    holoCtx.save();
    holoCtx.setTransform(1, 0, 0, 1, 0, 0);
    holoCtx.clearRect(0, 0, holoCanvas.width, holoCanvas.height);
    holoCtx.restore();
  };

  // Hands the buffer's context to the caller so the box-face geometry
  // stays in world.js next to drawBlock (forking that math out here is
  // the bodyBoxes class of bug).
  E.holoDraw = (fn) => { holoUsed = true; fn(holoCtx); };

  E.holoComposite = (strength, edge = 1) => {
    if (!holoUsed || strength <= 0) return;
    const c = E.ctx;
    const w = holoCanvas.width, h = holoCanvas.height;
    if (edge > 0) {
      const e = holoEdgeCtx;
      e.setTransform(1, 0, 0, 1, 0, 0);
      e.globalCompositeOperation = 'source-over';
      e.clearRect(0, 0, w, h);
      e.drawImage(holoCanvas, 0, 0);
      e.globalCompositeOperation = 'destination-out';
      for (const [dx, dy] of [[1, 0], [-1, 0], [0, 1], [0, -1]]) e.drawImage(holoCanvas, dx, dy);
    }
    c.save();
    c.imageSmoothingEnabled = true; // half-res buffer upscales; smooth it
    c.globalCompositeOperation = 'lighter';
    c.globalAlpha = Math.min(1, strength);
    c.drawImage(holoCanvas, 0, 0, w, h, 0, 0, E.W, E.H);
    if (edge > 0) {
      c.globalAlpha = Math.min(1, strength * edge);
      c.drawImage(holoEdgeCanvas, 0, 0, w, h, 0, 0, E.W, E.H);
      c.drawImage(holoEdgeCanvas, 0, 0, w, h, 0, 0, E.W, E.H); // twice: the ring runs hot
    }
    c.restore();
  };

  // ── Clock (real time, not frame count) ──────────────────────
  // dt is capped so a backgrounded tab resuming doesn't explode physics,
  // and floored at 0: if anything drives the clock ahead of real time
  // (the #dev harnesses tick it manually), a negative dt would blow up
  // exponential decays (shake → Infinity → every coordinate NaN).
  const clock = (VH.clock = { time: 0, dt: 0, last: null });
  const DT_CAP = 1 / 20; // max 50 ms per step

  clock.tick = (nowMs) => {
    if (clock.last === null) clock.last = nowMs;
    clock.dt = Math.min(Math.max((nowMs - clock.last) / 1000, 0), DT_CAP);
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

  // Deterministic seeded RNG (tiny LCG): same integer inputs, same
  // sequence, every call — the anti-crawl guarantee behind the platform
  // grain (game.js) and the material texture pass (world.js). Never feed
  // it render coordinates; hash LOGICAL cells only.
  E.hashRand = (a, b, c) => {
    let s = (((a | 0) * 73856093) ^ ((b | 0) * 19349663) ^ ((c | 0) * 83492791)) >>> 0;
    return () => {
      s = (s * 1664525 + 1013904223) >>> 0;
      return s / 4294967296;
    };
  };

  // ── Projection ──────────────────────────────────────────────
  function sceneCenter() {
    return { x: E.W / 2 + E.panX + E.shakeX, y: E.H * E.FRAME_ANCHOR + E.panY + E.shakeY };
  }
  E.sceneCenter = sceneCenter;

  // ── Zoom (user-controlled; pinch on touch, wheel on desktop) ──
  // Allowed pan GROWS with zoom and is zero at ZOOM ≤ 1: the default
  // framing centres the island, and zooming back out eases you home
  // automatically — the island can never be lost off-screen.
  function clampPan() {
    const room = Math.max(0, E.ZOOM - 1);
    const mx = E.W * 0.35 * Math.min(1, room);
    const my = E.H * 0.30 * Math.min(1, room);
    E.panX = Math.max(-mx, Math.min(mx, E.panX));
    E.panY = Math.max(-my, Math.min(my, E.panY));
  }
  E._clampPan = clampPan;

  // Set zoom about a screen focal point (fx, fy) — the world point under
  // the fingers/cursor stays put. ZOOM is clamped both directly and so
  // the resulting SCALE stays inside ~0.5–3.2, the band the line-width
  // floors and blur radii were tuned around.
  E.setZoom = (z, fx, fy) => {
    const lo = Math.max(0.6, 0.5 / E.BASE_SCALE);
    const hi = Math.min(2.4, 3.2 / E.BASE_SCALE);
    const next = Math.max(lo, Math.min(hi, z));
    if (next === E.ZOOM) { clampPan(); return; }
    const k = next / E.ZOOM;
    if (fx != null && fy != null) {
      // keep the world point under (fx, fy) fixed through the change
      E.panX = (1 - k) * (fx - E.W / 2) + k * E.panX;
      E.panY = (1 - k) * (fy - E.H * E.FRAME_ANCHOR) + k * E.panY;
    }
    E.ZOOM = next;
    E.SCALE = E.BASE_SCALE * E.ZOOM;
    clampPan();
    if (E.onProjectionChange) E.onProjectionChange(); // game.js: stale hover
  };
  E.resetZoom = () => { E.ZOOM = 1; E.panX = 0; E.panY = 0; E.SCALE = E.BASE_SCALE; if (E.onProjectionChange) E.onProjectionChange(); };

  // Shift the view (two-finger pan rides this). Same clamp as zoom: pan
  // room is zero at ZOOM ≤ 1, so panning only works once zoomed in and
  // the island can never be pushed off-screen.
  E.panBy = (dx, dy) => {
    E.panX += dx;
    E.panY += dy;
    clampPan();
    if (E.onProjectionChange) E.onProjectionChange();
  };

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
    // BASE scale and the UN-panned centre on purpose: the moon is a
    // fixed screen fraction, so unprojecting it through the zoomed,
    // panned view would SHORTEN every shadow as you zoom in and swing
    // the light across the island as you pan. Lighting is a property
    // of the world, not of the viewport.
    const t = E.TILE * E.BASE_SCALE;
    const c = { x: E.W / 2 + E.shakeX, y: E.H * E.FRAME_ANCHOR + E.shakeY };
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
    };
  };

  // Depth sort key for the current rotation
  E.depthKey = (gx, gy, gz) => gx * (E.cosA + E.sinA) + gy * (E.cosA - E.sinA) + gz * 0.01;

  // ── AABB helpers (occupancy, leftover sweep, occlusion sort) ──
  // pieceAABB mirrors drawBlock's geometry EXACTLY: sxy widens the piece in
  // the x ground axis, sy (optional, defaults to sxy) in the y axis, both
  // about the cell center; sz extends upward from gz. The optional sy is
  // what makes RECTANGULAR pieces possible — before it, every "beam" was
  // secretly a square slab (the torii lintel rendered as a table top).
  E.SOLID_EPS = 0.08; // how deep a block must intrude before it counts as "inside"
  E.pieceAABB = (gx, gy, gz, sxy, sz, sy) => {
    if (sy == null) sy = sxy;
    return {
      x0: gx + (1 - sxy) / 2, x1: gx + (1 + sxy) / 2,
      y0: gy + (1 - sy) / 2, y1: gy + (1 + sy) / 2,
      z0: gz, z1: gz + sz,
    };
  };
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
