/* ============================================================
   fx.js — ambient effects: stars, constellation, shooting star,
   moon, silhouettes. All timing uses the real
   clock (dt in seconds), never frame counts.
   ============================================================ */
(() => {
  'use strict';
  const VH = window.VH;
  const E = VH.engine;
  const clock = VH.clock;

  const FX = (VH.fx = {});

  // ── Stars ───────────────────────────────────────────────────
  const stars = [];
  for (let i = 0; i < 80; i++) {
    stars.push({
      x: Math.random(), y: Math.random() * 0.5,
      size: Math.random() * 1.5 + 0.5,
      twinkle: Math.random() * Math.PI * 2,
      glow: 0,
    });
  }
  FX.stars = stars;

  // ── Constellation text stars ("STILL BUILDING") ─────────────
  // 3 wide x 5 tall bitmaps, row-major. A character with no glyph here
  // renders as a BLANK GAP (silently), so any new wording must have every
  // letter defined. At 3px some pairs are inherently close: B/D differ by
  // a single row (B's middle bar), as do G/O. That's tolerable because the
  // constellation is dim ambient texture read in context, not a headline —
  // but it's the reason to eyeball any new wording on screen, not just in
  // the array.
  const PIXEL_FONT = {
    U:[1,0,1,1,0,1,1,0,1,1,0,1,1,1,1],
    N:[1,0,1,1,1,1,1,1,1,1,0,1,1,0,1],
    D:[1,1,0,1,0,1,1,0,1,1,0,1,1,1,0],
    E:[1,1,1,1,0,0,1,1,0,1,0,0,1,1,1],
    R:[1,1,0,1,0,1,1,1,0,1,0,1,1,0,1],
    C:[1,1,1,1,0,0,1,0,0,1,0,0,1,1,1],
    O:[1,1,1,1,0,1,1,0,1,1,0,1,1,1,1],
    S:[1,1,1,1,0,0,1,1,1,0,0,1,1,1,1],
    T:[1,1,1,0,1,0,0,1,0,0,1,0,0,1,0],
    I:[1,1,1,0,1,0,0,1,0,0,1,0,1,1,1],
    L:[1,0,0,1,0,0,1,0,0,1,0,0,1,1,1],
    B:[1,1,0,1,0,1,1,1,0,1,0,1,1,1,0],
    G:[1,1,1,1,0,0,1,0,1,1,0,1,1,1,1],
    ' ':[0,0,0,0,0,0,0,0,0,0,0,0,0,0,0],
  };
  // The site's whole framing: the skills are still being built, and this
  // page is literally a building game. Max ~12 chars per line before the
  // left edge clips (see the centering math below).
  const CONSTELLATION_LINES = ['STILL', 'BUILDING'];
  const CELL = 0.015;
  const LETTER_W = 3;
  const LETTER_GAP = 1.5;
  const LINE_GAP = 2.5;
  const TEXT_CENTER_X = 0.42;
  const TEXT_TOP = 0.05;

  (function buildTextStars() {
    for (let lineIdx = 0; lineIdx < CONSTELLATION_LINES.length; lineIdx++) {
      const line = CONSTELLATION_LINES[lineIdx];
      const lineWidth = line.length * (LETTER_W + LETTER_GAP) - LETTER_GAP;
      const lineLeft = TEXT_CENTER_X - (lineWidth * CELL) / 2;
      const lineTop = TEXT_TOP + lineIdx * (5 + LINE_GAP) * CELL;
      let cursorX = 0;
      for (const ch of line) {
        const glyph = PIXEL_FONT[ch];
        if (!glyph) { cursorX += LETTER_W + LETTER_GAP; continue; }
        for (let row = 0; row < 5; row++) {
          for (let col = 0; col < 3; col++) {
            if (glyph[row * 3 + col]) {
              stars.push({
                x: lineLeft + (cursorX + col) * CELL,
                y: lineTop + row * CELL,
                size: 1.0 + Math.random() * 0.5,
                twinkle: Math.random() * Math.PI * 2,
                glow: 0,
                isText: true,
              });
            }
          }
        }
        cursorX += LETTER_W + LETTER_GAP;
      }
    }
  })();

  // Glow decay rates (per second; was 0.012 / 0.003 per frame)
  const GLOW_DECAY = 0.72;
  const GLOW_DECAY_TEXT = 0.18;

  // Light up stars near a normalized screen point (0..1 fractions of W/H).
  // Used by the shooting star as it passes and by firework detonations —
  // a barrage briefly ignites the "STILL BUILDING" constellation.
  FX.igniteStars = (nx, ny, radius, strength = 1) => {
    stars.forEach(star => {
      const dx = star.x - nx;
      const dy = star.y - ny;
      const dist = Math.sqrt(dx * dx + dy * dy);
      if (dist < radius) {
        star.glow = Math.max(star.glow, (1 - dist / radius) * strength);
      }
    });
  };

  FX.drawStars = (dt) => {
    const ctx = E.ctx;
    stars.forEach(s => {
      const isText = s.isText;
      const baseAlpha = isText
        ? 0.06 + Math.sin(clock.time * 1.5 + s.twinkle) * 0.06
        : 0.3 + Math.sin(clock.time * 1.5 + s.twinkle) * 0.3;
      const glowAlpha = s.glow * 0.9;
      const alpha = Math.min(1, baseAlpha + glowAlpha);
      const sz = s.size * E.SCALE * (1 + s.glow * 1.2);
      if (s.glow > 0.2) {
        // Ignited-star halo is a LIGHT (bloom pass)
        E.addLight(s.x * E.W, s.y * E.H, sz * 3, '255,251,230', s.glow * 0.15);
      }
      ctx.globalAlpha = alpha;
      ctx.fillStyle = s.glow > 0.2 ? '#fffbe6' : '#fff';
      ctx.fillRect(s.x * E.W - sz * 0.5, s.y * E.H - sz * 0.5, sz, sz);
      s.glow = Math.max(0, s.glow - (isText ? GLOW_DECAY_TEXT : GLOW_DECAY) * dt);
    });
    ctx.globalAlpha = 1;
  };

  // ── Shooting star ───────────────────────────────────────────
  let shootingStar = null;
  let nextShootingStarTime = 5 + Math.random() * 5;

  function spawnShootingStar() {
    shootingStar = {
      startX: 0.03,
      startY: 0.02 + Math.random() * 0.03,
      // Lands on the last letter of the lower line. "BUILDING" ends at
      // x 0.679 (vs "CONSTRUCTION"'s 0.814), so this was pulled in to keep
      // the sweep matched to the words instead of overshooting them.
      endX: 0.72,
      endY: 0.12 + Math.random() * 0.04,
      progress: 0,
      speed: 0.18 + Math.random() * 0.06, // progress / second
      tailLength: 0.08,
    };
    nextShootingStarTime = clock.time + 18 + Math.random() * 12;
  }

  FX.updateAndDrawShootingStar = (dt) => {
    if (E.reducedMotion) return; // a streak across the sky is exactly the kind of motion to skip
    if (!shootingStar && clock.time > nextShootingStarTime) spawnShootingStar();
    if (!shootingStar) return;
    const ctx = E.ctx;
    const s = shootingStar;
    s.progress += s.speed * dt;
    if (s.progress > 1.3) { shootingStar = null; return; }

    const t = Math.min(s.progress, 1);
    const headX = s.startX + (s.endX - s.startX) * t;
    const headY = s.startY + (s.endY - s.startY) * t - Math.sin(t * Math.PI) * 0.03;

    // Light up nearby stars (the constellation ignites as it passes)
    FX.igniteStars(headX, headY, 0.12, 1);

    if (s.progress <= 1) {
      const tailT = Math.max(0, t - s.tailLength);
      const tailX = s.startX + (s.endX - s.startX) * tailT;
      const tailY = s.startY + (s.endY - s.startY) * tailT - Math.sin(tailT * Math.PI) * 0.03;

      const grad = ctx.createLinearGradient(tailX * E.W, tailY * E.H, headX * E.W, headY * E.H);
      grad.addColorStop(0, 'rgba(255,255,255,0)');
      grad.addColorStop(1, 'rgba(255,255,255,0.9)');
      ctx.strokeStyle = grad;
      ctx.lineWidth = 1.5 * E.SCALE;
      ctx.beginPath();
      ctx.moveTo(tailX * E.W, tailY * E.H);
      ctx.lineTo(headX * E.W, headY * E.H);
      ctx.stroke();

      ctx.fillStyle = 'rgba(255,255,255,0.95)';
      ctx.beginPath();
      ctx.arc(headX * E.W, headY * E.H, 1.5 * E.SCALE, 0, Math.PI * 2);
      ctx.fill();
    }
  };

  // ── Moon ────────────────────────────────────────────────────
  FX.drawMoon = () => {
    const ctx = E.ctx;
    const mx = E.MOON.fx * E.W, my = E.MOON.fy * E.H, r = E.MOON.r * E.SCALE;
    // Only the HALO is a light. The body below stays on the main canvas:
    // its crescent is carved with an opaque sky-coloured disc, and an
    // additive buffer cannot represent dark (it would fill back in).
    E.addLight(mx, my, r * 3, '220,220,200', 0.08);
    ctx.fillStyle = '#e8e4d4';
    ctx.beginPath(); ctx.arc(mx, my, r, 0, Math.PI * 2); ctx.fill();
    ctx.fillStyle = '#0d0d1a';
    ctx.beginPath(); ctx.arc(mx + r * 0.35, my - r * 0.1, r * 0.75, 0, Math.PI * 2); ctx.fill();
    ctx.fillStyle = 'rgba(180,175,160,0.3)';
    ctx.beginPath(); ctx.arc(mx - r * 0.3, my + r * 0.1, r * 0.1, 0, Math.PI * 2); ctx.fill();
    ctx.beginPath(); ctx.arc(mx - r * 0.15, my - r * 0.35, r * 0.07, 0, Math.PI * 2); ctx.fill();
  };

  // ── Moon silhouettes (easter eggs) ──────────────────────────
  const silhouetteTypes = [
    function(ctx, x, y, s) { // ET
      ctx.fillStyle='#000';
      ctx.beginPath();ctx.arc(x-8*s,y+6*s,4*s,0,Math.PI*2);ctx.fill();
      ctx.beginPath();ctx.arc(x+8*s,y+6*s,4*s,0,Math.PI*2);ctx.fill();
      ctx.fillRect(x-7*s,y+2*s,14*s,2*s);
      ctx.fillRect(x+6*s,y-1*s,2*s,4*s);
      ctx.fillRect(x-2*s,y-6*s,4*s,8*s);
      ctx.beginPath();ctx.arc(x,y-8*s,3*s,0,Math.PI*2);ctx.fill();
      ctx.beginPath();ctx.ellipse(x+9*s,y-2*s,2*s,4*s,-0.3,0,Math.PI*2);ctx.fill();
      ctx.fillRect(x+6*s,y,6*s,3*s);
      ctx.fillRect(x+12*s,y-6*s,1.5*s,5*s);
    },
    function(ctx, x, y, s) { // Witch
      ctx.fillStyle='#000';
      ctx.fillRect(x-14*s,y+1*s,28*s,1.5*s);
      ctx.beginPath();ctx.moveTo(x-14*s,y-3*s);ctx.lineTo(x-20*s,y+1*s);
      ctx.lineTo(x-14*s,y+5*s);ctx.closePath();ctx.fill();
      ctx.fillRect(x-2*s,y-6*s,5*s,7*s);
      ctx.beginPath();ctx.arc(x+1*s,y-8*s,3*s,0,Math.PI*2);ctx.fill();
      ctx.beginPath();ctx.moveTo(x-2*s,y-10*s);ctx.lineTo(x+1*s,y-18*s);
      ctx.lineTo(x+4*s,y-10*s);ctx.closePath();ctx.fill();
    },
    function(ctx, x, y, s) { // Santa
      ctx.fillStyle='#000';
      for(let i=0;i<2;i++){const dx=-(i*10+14)*s;
      ctx.fillRect(x+dx,y-2*s,7*s,4*s);ctx.fillRect(x+dx-3*s,y-3*s,4*s,3*s);
      ctx.fillRect(x+dx+1*s,y+2*s,1.5*s,3*s);ctx.fillRect(x+dx+4*s,y+2*s,1.5*s,3*s);}
      ctx.fillRect(x-12*s,y-0.5*s,12*s,0.8*s);
      ctx.beginPath();ctx.moveTo(x-1*s,y-4*s);ctx.lineTo(x+10*s,y-4*s);
      ctx.lineTo(x+14*s,y+3*s);ctx.lineTo(x-1*s,y+3*s);ctx.closePath();ctx.fill();
      ctx.fillRect(x+2*s,y-9*s,5*s,5*s);
      ctx.beginPath();ctx.arc(x+4.5*s,y-11*s,2.5*s,0,Math.PI*2);ctx.fill();
    },
    function(ctx, x, y, s) { // Superman
      ctx.fillStyle='#000';ctx.save();ctx.translate(x,y);ctx.rotate(-0.3);
      ctx.beginPath();ctx.moveTo(-2*s,-3*s);ctx.lineTo(-12*s,4*s);
      ctx.lineTo(-8*s,6*s);ctx.lineTo(-1*s,0);ctx.closePath();ctx.fill();
      ctx.fillRect(-2*s,-5*s,5*s,9*s);
      ctx.beginPath();ctx.arc(1*s,-7*s,3*s,0,Math.PI*2);ctx.fill();
      ctx.fillRect(3*s,-5*s,10*s,2*s);
      ctx.fillRect(-1*s,4*s,2*s,7*s);ctx.fillRect(1.5*s,4*s,2*s,6*s);
      ctx.restore();
    },
  ];

  const activeSilhouettes = [];
  let nextSilhouetteTime = 6;
  let lastUsedType = -1;

  function spawnSilhouette() {
    let t; do { t = Math.floor(Math.random() * silhouetteTypes.length); }
    while (t === lastUsedType && silhouetteTypes.length > 1);
    lastUsedType = t;
    const right = Math.random() > 0.5;
    const mx = E.MOON.fx * E.W, my = E.MOON.fy * E.H, r = E.MOON.r * E.SCALE;
    activeSilhouettes.push({
      drawFn: silhouetteTypes[t],
      startX: right ? mx - r * 4 : mx + r * 4,
      endX: right ? mx + r * 4 : mx - r * 4,
      y: my + (Math.random() - 0.5) * r * 0.6,
      progress: 0,
      speed: 0.15 + Math.random() * 0.1, // progress / second
      scale: E.SCALE * (0.8 + Math.random() * 0.4),
    });
    nextSilhouetteTime = clock.time + 8 + Math.random() * 7;
  }

  FX.updateAndDrawSilhouettes = (dt) => {
    if (clock.time > nextSilhouetteTime) spawnSilhouette();
    const ctx = E.ctx;
    for (let i = activeSilhouettes.length - 1; i >= 0; i--) {
      const s = activeSilhouettes[i];
      s.progress += s.speed * dt;
      if (s.progress > 1) { activeSilhouettes.splice(i, 1); continue; }
      const cx = s.startX + (s.endX - s.startX) * s.progress;
      const arc = Math.sin(s.progress * Math.PI) * -15 * E.SCALE;
      let alpha = 1;
      if (s.progress < 0.15) alpha = s.progress / 0.15;
      else if (s.progress > 0.85) alpha = (1 - s.progress) / 0.15;
      ctx.save(); ctx.globalAlpha = alpha;
      s.drawFn(ctx, cx, s.y + arc, s.scale);
      ctx.restore();
    }
  };

  // ── Particles: dust puffs + firework sparks (one shared system) ──
  // Particles live in GRID space so they stay correct under rotation.
  // Dust records carry only the original fields; sparks add optional ones
  // (grav / col / a0 / floor / glow / trail) — defaults reproduce old dust
  // behavior exactly.
  const dust = [];
  const MAX_PARTICLES = 400; // hard bound — spectacle, not a slideshow

  function hexToRgb(hex) {
    const n = parseInt(hex.slice(1), 16);
    return ((n >> 16) & 255) + ',' + ((n >> 8) & 255) + ',' + (n & 255);
  }

  FX.spawnDust = (gx, gy, gz, count) => {
    for (let i = 0; i < count; i++) {
      const ang = Math.random() * Math.PI * 2;
      const speed = 1.2 + Math.random() * 2.0; // grid units / s outward
      dust.push({
        px: gx + 0.5 + Math.cos(ang) * 0.4,
        py: gy + 0.5 + Math.sin(ang) * 0.4,
        pz: gz + 0.05,
        vx: Math.cos(ang) * speed,
        vy: Math.sin(ang) * speed,
        vz: 0.8 + Math.random() * 1.2,
        life: 0.45 + Math.random() * 0.2,
        age: 0,
        size: 1.5 + Math.random() * 2,
      });
    }
  };

  // Firework burst: a sphere of glowing sparks tinted from the block's color.
  // Sparks fall PAST the ground plane (floor:false) so they never carpet the
  // grass, and draw as short trails so they read as sparks, not confetti.
  FX.spawnBurst = (gx, gy, gz, colorKey, count) => {
    if (E.reducedMotion) return;
    const room = MAX_PARTICLES - dust.length;
    if (room <= 0) return;
    count = Math.min(count, room);
    const col = (VH.world.COLORS[colorKey] || VH.world.COLORS.white);
    for (let i = 0; i < count; i++) {
      const ang = Math.random() * Math.PI * 2;
      const up = Math.random() * 2 - 1;             // vertical component
      const horiz = Math.sqrt(1 - up * up);
      const speed = 3 + Math.random() * 5;
      // ~20% take the bright top-face value — internal sparkle variation
      const hex = Math.random() < 0.2 ? col.top : col.front;
      dust.push({
        px: gx + 0.5, py: gy + 0.5, pz: gz + 0.5,
        vx: Math.cos(ang) * horiz * speed,
        vy: Math.sin(ang) * horiz * speed,
        vz: up * speed + 1.5,
        life: 0.55 + Math.random() * 0.45,
        age: 0,
        size: 1.6 + Math.random() * 1.6,
        grav: 22, col: hexToRgb(hex), a0: 0.9,
        floor: false, glow: true, trail: 1,
      });
    }
  };

  FX.updateAndDrawDust = (dt) => {
    if (!dust.length) return;
    const ctx = E.ctx;
    for (let i = dust.length - 1; i >= 0; i--) {
      const p = dust[i];
      p.age += dt;
      if (p.age >= p.life) { dust.splice(i, 1); continue; }
      p.px += p.vx * dt;
      p.py += p.vy * dt;
      p.vz -= (p.grav !== undefined ? p.grav : 6) * dt;
      const nz = p.pz + p.vz * dt;
      p.pz = p.floor === false ? nz : Math.max(0, nz);
      const fade = 1 - p.age / p.life;
      const s = E.toScreen(p.px, p.py, p.pz);
      const sz = p.size * E.SCALE * (0.7 + fade * 0.5);
      const col = p.col || '207,200,184';
      if (p.glow) {
        // Halo is a LIGHT (bloom pass) — was a fresh gradient per spark
        // per frame, the single heaviest allocation in the game
        E.addLight(s.x, s.y, sz * 2.5, col, fade * 0.35);
        // …and the spark body draws additively so it reads as light
        ctx.globalCompositeOperation = 'lighter';
      }
      ctx.globalAlpha = fade * (p.a0 !== undefined ? p.a0 : 0.5);
      if (p.trail) {
        // Short motion trail back along the velocity
        const tail = E.toScreen(p.px - p.vx * 0.04, p.py - p.vy * 0.04, p.pz - p.vz * 0.04);
        ctx.strokeStyle = `rgb(${col})`;
        ctx.lineWidth = Math.max(1, sz * 0.5);
        ctx.beginPath();
        ctx.moveTo(tail.x, tail.y);
        ctx.lineTo(s.x, s.y);
        ctx.stroke();
      } else {
        ctx.fillStyle = `rgb(${col})`;
        ctx.fillRect(s.x - sz / 2, s.y - sz / 2, sz, sz);
      }
      if (p.glow) ctx.globalCompositeOperation = 'source-over';
    }
    ctx.globalAlpha = 1;
  };

  // ── Flashes (radial blooms) ─────────────────────────────────
  // The alpha curve (fast 33% attack / 67% decay) is the monument ceremony's
  // flash, consolidated here; ceremonies and firework detonations both use it.
  const flashes = [];

  FX.spawnFlash = (gx, gy, gz, opts = {}) => {
    let col = opts.col || '255,248,220';
    if (opts.colorKey) {
      // Block-coloured bloom, lightened halfway to white so it reads as light
      const hex = (VH.world.COLORS[opts.colorKey] || VH.world.COLORS.white).top;
      const n = parseInt(hex.slice(1), 16);
      const lift = (c) => Math.round(c + (255 - c) * 0.5);
      col = lift((n >> 16) & 255) + ',' + lift((n >> 8) & 255) + ',' + lift(n & 255);
    }
    flashes.push({
      gx, gy, gz, t: 0,
      dur: opts.dur || 0.45,
      r0: opts.r0 !== undefined ? opts.r0 : 2,
      r1: opts.r1 !== undefined ? opts.r1 : 7,
      peak: opts.peak !== undefined ? opts.peak : 0.85,
      col,
    });
  };

  FX.updateAndDrawFlashes = (dt) => {
    if (!flashes.length) return;
    for (let i = flashes.length - 1; i >= 0; i--) {
      const fl = flashes[i];
      fl.t += dt;
      const f = fl.t / fl.dur;
      if (f >= 1) { flashes.splice(i, 1); continue; }
      const alpha = (f < 0.33 ? f * 3 : 1 - (f - 0.33) / 0.67) * fl.peak;
      const s = E.toScreen(fl.gx, fl.gy, fl.gz);
      const r = E.TILE * E.SCALE * (fl.r0 + f * fl.r1);
      E.addLight(s.x, s.y, r, fl.col, alpha); // blooms ARE light — one registered light each
    }
  };

  // ── Grass tufts (sway; hide under placed blocks) ────────────
  const W_ = () => VH.world;
  const grassTufts = [];
  (function seedGrass() {
    const used = new Set();
    while (grassTufts.length < 16) {
      const gx = -5 + Math.floor(Math.random() * 11);
      const gy = -5 + Math.floor(Math.random() * 11);
      const key = gx + ',' + gy;
      if (used.has(key)) continue;
      used.add(key);
      grassTufts.push({
        gx, gy,
        blades: Array.from({ length: 2 + Math.floor(Math.random() * 2) }, () => ({
          ox: 0.2 + Math.random() * 0.6,
          oy: 0.2 + Math.random() * 0.6,
          h: 0.22 + Math.random() * 0.18,      // height in grid units
          phase: Math.random() * Math.PI * 2,
        })),
      });
    }
  })();

  FX.drawGrass = () => {
    const ctx = E.ctx;
    const W = W_();
    ctx.strokeStyle = '#6fbc72';
    ctx.lineWidth = Math.max(1, 1.2 * E.SCALE);
    ctx.globalAlpha = 0.85;
    for (const tuft of grassTufts) {
      if (W.getStackHeight(tuft.gx, tuft.gy) > 0) continue; // a block sits here
      for (const b of tuft.blades) {
        const sway = E.reducedMotion ? 0 : Math.sin(clock.time * 1.6 + b.phase) * 0.10;
        const base = E.toScreen(tuft.gx + b.ox, tuft.gy + b.oy, 0);
        const tip = E.toScreen(tuft.gx + b.ox + sway, tuft.gy + b.oy + sway * 0.6, b.h);
        ctx.beginPath();
        ctx.moveTo(base.x, base.y);
        ctx.quadraticCurveTo(base.x, (base.y + tip.y) / 2, tip.x, tip.y);
        ctx.stroke();
      }
    }
    ctx.globalAlpha = 1;
  };

  // ── Fireflies ───────────────────────────────────────────────
  const fireflies = Array.from({ length: 3 }, () => ({
    px: (Math.random() - 0.5) * 12,
    py: (Math.random() - 0.5) * 12,
    pz: 1 + Math.random() * 2.5,
    vx: 0, vy: 0, vz: 0,
    tx: 0, ty: 0, tz: 1.5,      // wander target
    retarget: 0,
    phase: Math.random() * Math.PI * 2,
  }));

  FX.updateAndDrawFireflies = (dt) => {
    const ctx = E.ctx;
    for (const f of fireflies) {
      f.retarget -= dt;
      if (f.retarget <= 0) {
        f.retarget = 2 + Math.random() * 3;
        f.tx = (Math.random() - 0.5) * 14;
        f.ty = (Math.random() - 0.5) * 14;
        f.tz = 0.8 + Math.random() * 3;
      }
      // Ease velocity toward the target, drift smoothly
      f.vx += ((f.tx - f.px) * 0.25 - f.vx) * Math.min(1, 1.2 * dt);
      f.vy += ((f.ty - f.py) * 0.25 - f.vy) * Math.min(1, 1.2 * dt);
      f.vz += ((f.tz - f.pz) * 0.4 - f.vz) * Math.min(1, 1.2 * dt);
      f.px += f.vx * dt; f.py += f.vy * dt; f.pz += f.vz * dt;

      const s = E.toScreen(f.px, f.py, f.pz);
      // Pulse is motion — hold it steady for reduced-motion visitors
      const pulse = E.reducedMotion ? 0.65 : 0.5 + 0.5 * Math.sin(clock.time * 2.2 + f.phase);
      const r = (2 + pulse * 2) * E.SCALE;
      // Halo is a LIGHT (bloom pass); the body draws additively
      E.addLight(s.x, s.y, r * 4, '216,232,106', 0.35 + pulse * 0.3);
      ctx.globalCompositeOperation = 'lighter';
      ctx.fillStyle = `rgba(240,248,180,${0.5 + pulse * 0.5})`;
      ctx.beginPath();
      ctx.arc(s.x, s.y, r * 0.6, 0, Math.PI * 2);
      ctx.fill();
      ctx.globalCompositeOperation = 'source-over';
    }
  };

  // ── Clouds (slow drift across the upper sky) ────────────────
  const clouds = Array.from({ length: 3 }, (_, i) => ({
    x: Math.random(),                    // fraction of W
    y: 0.06 + i * 0.06 + Math.random() * 0.03,
    speed: 0.006 + Math.random() * 0.006, // fraction of W per second
    scale: 0.7 + Math.random() * 0.6,
    alpha: 0.035 + Math.random() * 0.02,
  }));

  FX.updateAndDrawClouds = (dt) => {
    const ctx = E.ctx;
    for (const c of clouds) {
      c.x += c.speed * dt;
      if (c.x > 1.25) c.x = -0.25;
      const cx = c.x * E.W, cy = c.y * E.H, s = c.scale * E.SCALE;
      ctx.fillStyle = `rgba(215,218,235,${c.alpha})`;
      ctx.beginPath();
      ctx.ellipse(cx, cy, 90 * s, 16 * s, 0, 0, Math.PI * 2);
      ctx.ellipse(cx - 45 * s, cy + 6 * s, 55 * s, 12 * s, 0, 0, Math.PI * 2);
      ctx.ellipse(cx + 50 * s, cy + 5 * s, 60 * s, 13 * s, 0, 0, Math.PI * 2);
      ctx.fill();
    }
  };

})();
