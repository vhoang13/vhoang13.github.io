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
  const STAR_TINTS = ['#ffffff', '#ffffff', '#dfe7ff', '#fff3dc'];
  for (let i = 0; i < 84; i++) {
    const bright = i < 7; // a handful of first-magnitude stars carry a 4-point spike
    stars.push({
      x: Math.random(), y: Math.random() * 0.5,
      size: bright ? 1.5 + Math.random() * 0.5 : Math.random() * 1.3 + 0.5,
      twinkle: Math.random() * Math.PI * 2,
      freq: 0.5 + Math.random() * 1.9, // each star breathes at its own pace
      tint: STAR_TINTS[i % STAR_TINTS.length],
      bright,
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
      const freq = s.freq || 1.5;
      const baseAlpha = isText
        ? 0.06 + Math.sin(clock.time * 1.5 + s.twinkle) * 0.06
        : (s.bright ? 0.55 : 0.3) + Math.sin(clock.time * freq + s.twinkle) * (s.bright ? 0.25 : 0.3);
      const glowAlpha = s.glow * 0.9;
      const alpha = Math.min(1, baseAlpha + glowAlpha);
      const sz = s.size * E.SCALE * (1 + s.glow * 1.2);
      if (s.glow > 0.2) {
        // Ignited-star halo is a LIGHT (bloom pass)
        E.addLight(s.x * E.W, s.y * E.H, sz * 3, '255,251,230', s.glow * 0.15);
      }
      ctx.globalAlpha = alpha;
      ctx.fillStyle = s.glow > 0.2 ? '#fffbe6' : (s.tint || '#fff');
      const px = s.x * E.W, py = s.y * E.H;
      ctx.fillRect(px - sz * 0.5, py - sz * 0.5, sz, sz);
      if (s.bright) {
        // The spike: two thin bars, dimmer than the core, so the star reads
        // as a point of light rather than a square.
        ctx.globalAlpha = alpha * 0.22;
        ctx.fillRect(px - sz * 1.7, py - sz * 0.2, sz * 3.4, sz * 0.4);
        ctx.fillRect(px - sz * 0.2, py - sz * 1.7, sz * 0.4, sz * 3.4);
      }
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

  // ── Sky (cached bitmap) ─────────────────────────────────────
  // The sky is ~70% of every frame and used to be a three-stop gradient
  // allocated per frame. Now it is painted once per viewport: a
  // zenith→horizon ramp, a soft brightening around the moon (night air
  // scatters its light), a low lift behind the island, a vignette, and a
  // noise tile that breaks the banding a flat gradient shows on dark
  // indigo. One drawImage per frame; zero per-frame gradients.
  const sky = { canvas: document.createElement('canvas'), key: '' };
  let noiseTile = null;
  function makeNoiseTile() {
    const n = 128, c = document.createElement('canvas'); c.width = c.height = n;
    const x = c.getContext('2d'), img = x.createImageData(n, n), d = img.data;
    for (let i = 0; i < d.length; i += 4) {
      const v = 128 + (Math.random() * 2 - 1) * 64;
      d[i] = d[i + 1] = d[i + 2] = v; d[i + 3] = 255;
    }
    x.putImageData(img, 0, 0);
    return c;
  }
  FX.drawSky = () => {
    const ctx = E.ctx;
    const dpr = Math.min(window.devicePixelRatio || 1, 2);
    const key = `${E.W}|${E.H}|${dpr}`;
    if (sky.key !== key) {
      sky.key = key;
      const W = E.W, H = E.H, c = sky.canvas;
      c.width = W * dpr; c.height = H * dpr;
      const x = c.getContext('2d');
      x.setTransform(dpr, 0, 0, dpr, 0, 0);
      const g = x.createLinearGradient(0, 0, 0, H);
      g.addColorStop(0, '#090a17');
      g.addColorStop(0.32, '#10122a');
      g.addColorStop(0.64, '#191b3a');
      g.addColorStop(1, '#1b2446');
      x.fillStyle = g; x.fillRect(0, 0, W, H);
      const mx = E.MOON.fx * W, my = E.MOON.fy * H;
      const mg = x.createRadialGradient(mx, my, 0, mx, my, Math.max(W, H) * 0.6);
      mg.addColorStop(0, 'rgba(200,196,220,0.17)');
      mg.addColorStop(0.3, 'rgba(160,160,200,0.06)');
      mg.addColorStop(1, 'rgba(160,160,200,0)');
      x.fillStyle = mg; x.fillRect(0, 0, W, H);
      const hy = H * E.FRAME_ANCHOR;
      const hg = x.createLinearGradient(0, hy - H * 0.28, 0, hy + H * 0.38);
      hg.addColorStop(0, 'rgba(92,104,156,0)');
      hg.addColorStop(0.55, 'rgba(92,104,156,0.11)');
      hg.addColorStop(1, 'rgba(92,104,156,0)');
      x.fillStyle = hg; x.fillRect(0, 0, W, H);
      const vg = x.createRadialGradient(W / 2, H * 0.45, Math.min(W, H) * 0.38, W / 2, H * 0.45, Math.max(W, H) * 0.82);
      vg.addColorStop(0, 'rgba(3,3,10,0)');
      vg.addColorStop(1, 'rgba(3,3,10,0.5)');
      x.fillStyle = vg; x.fillRect(0, 0, W, H);
      noiseTile = noiseTile || makeNoiseTile();
      x.globalCompositeOperation = 'overlay';
      x.globalAlpha = 0.07;
      x.fillStyle = x.createPattern(noiseTile, 'repeat');
      x.fillRect(0, 0, W, H);
      x.globalAlpha = 1;
      x.globalCompositeOperation = 'source-over';
    }
    ctx.drawImage(sky.canvas, 0, 0, sky.canvas.width, sky.canvas.height, 0, 0, E.W, E.H);
  };

  // ── Moon ────────────────────────────────────────────────────
  // Drawn once into a sprite (rebuilt only when the zoom changes its
  // radius). The crescent is CARVED out of the sprite with a soft-edged
  // destination-out — never painted over with a sky-coloured disc, which
  // was visible as a dark circle beside the moon against the real sky.
  // Only the HALO is a light: an additive buffer cannot represent dark.
  const moonSprite = { canvas: document.createElement('canvas'), r: 0, size: 0 };
  function buildMoonSprite(r) {
    const S = Math.ceil(r * 2.4), c = moonSprite.canvas;
    const dpr = Math.min(window.devicePixelRatio || 1, 2);
    c.width = c.height = Math.ceil(S * dpr);
    const x = c.getContext('2d');
    x.setTransform(dpr, 0, 0, dpr, 0, 0);
    const cx = S / 2, cy = S / 2;
    x.save();
    x.beginPath(); x.arc(cx, cy, r, 0, Math.PI * 2); x.clip();
    x.fillStyle = '#ede8d8';
    x.fillRect(0, 0, S, S);
    // Limb darkening: the edge of a lit sphere is dimmer than its middle.
    const lg = x.createRadialGradient(cx - r * 0.3, cy - r * 0.05, r * 0.15, cx, cy, r);
    lg.addColorStop(0, 'rgba(150,140,115,0)');
    lg.addColorStop(0.75, 'rgba(150,140,115,0.12)');
    lg.addColorStop(1, 'rgba(120,110,90,0.42)');
    x.fillStyle = lg; x.fillRect(0, 0, S, S);
    // Maria: soft dark seas on the lit side, not two flat dots.
    const maria = [[-0.42, 0.04, 0.17], [-0.22, -0.34, 0.13], [-0.10, 0.31, 0.11], [-0.50, -0.30, 0.08], [-0.28, 0.46, 0.07], [-0.62, 0.22, 0.06]];
    for (const [dx, dy, rr] of maria) {
      const g = x.createRadialGradient(cx + dx * r, cy + dy * r, 0, cx + dx * r, cy + dy * r, rr * r);
      g.addColorStop(0, 'rgba(118,115,108,0.36)');
      g.addColorStop(0.65, 'rgba(118,115,108,0.24)');
      g.addColorStop(1, 'rgba(118,115,108,0)');
      x.fillStyle = g; x.fillRect(0, 0, S, S);
    }
    // Terminator: carve the night side with a softened edge.
    x.globalCompositeOperation = 'destination-out';
    const sx = cx + r * 0.35, sy = cy - r * 0.1, sr = r * 0.75;
    const tg = x.createRadialGradient(sx, sy, sr * 0.9, sx, sy, sr * 1.03);
    tg.addColorStop(0, 'rgba(0,0,0,1)');
    tg.addColorStop(1, 'rgba(0,0,0,0)');
    x.fillStyle = tg; x.fillRect(0, 0, S, S);
    x.restore();
    // Earthshine: the unlit disc is faintly there on a clear night.
    x.globalCompositeOperation = 'destination-over';
    x.fillStyle = 'rgba(160,162,190,0.025)';
    x.beginPath(); x.arc(cx, cy, r, 0, Math.PI * 2); x.fill();
    x.globalCompositeOperation = 'source-over';
    moonSprite.r = r; moonSprite.size = S;
  }
  FX.drawMoon = () => {
    const ctx = E.ctx;
    const mx = E.MOON.fx * E.W, my = E.MOON.fy * E.H, r = E.MOON.r * E.SCALE;
    E.addLight(mx, my, r * 3, '220,220,200', 0.08);
    // Quantised radius: a zoom tween changes SCALE every frame and would
    // otherwise rebuild the sprite (eight gradients) per frame.
    const rq = Math.max(8, Math.round(r / 4) * 4);
    if (moonSprite.r !== rq) buildMoonSprite(rq);
    const S = moonSprite.size * (r / rq);
    ctx.drawImage(moonSprite.canvas, mx - S / 2, my - S / 2, S, S);
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
  // (grav / col / a0 / floor / glow / trail / drag / fadePow) — defaults
  // reproduce old dust behavior exactly.
  const dust = [];
  // Raised 400 → 900 for the ember retune: sparks now live ~3s instead of
  // ~0.8s, so ~3× more are alive at once during a Clear. The per-shell
  // count went DOWN (12→9) to compensate — denser-looking, not
  // denser-costing. spawnBurst silently spawns zero when full, so a low
  // cap starves the late shells of a barrage.
  const MAX_PARTICLES = 900; // hard bound — spectacle, not a slideshow

  function hexToRgb(hex) {
    const n = parseInt(hex.slice(1), 16);
    return ((n >> 16) & 255) + ',' + ((n >> 8) & 255) + ',' + (n & 255);
  }

  FX.spawnDust = (gx, gy, gz, count) => {
    // Same cap the other spawners honour — a mass landing (entrance
    // wave, Clear cascade) stacked on a barrage must not blow past the
    // pool's hard bound (review find WR-05).
    count = Math.min(count, MAX_PARTICLES - dust.length);
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

  // Thrown EARTH — the eruption when the gofer breaks the surface, and
  // the smaller spray when he dives. Deliberately not spawnDust: dust is
  // a pale puff that fades in mid-air, and dirt is heavy stuff that
  // arcs, lands and rests. Differences that carry the read:
  //  · THREE discrete size classes in a 3:6:9 ratio (big clods rare).
  //    Continuous random sizes read as mush; graded sizes read as
  //    material that broke apart.
  //  · Speed biased LOW (pow 1.6) — most clods barely clear the hole,
  //    a few outliers fly. Uniform random looks mechanical.
  //  · An UPWARD CONE, not a sphere: a sphere is an explosion, a narrow
  //    jet is a geyser, ~40° is something pushing up through a surface.
  //    The cone tilts along his travel so the spray carries his momentum.
  //  · They land, brake and rest (fric), and the heaviest class gets ONE
  //    small bounce — every particle bouncing reads as rubber.
  const SOIL_TONES = ['94,75,47', '117,90,51', '139,107,61', '105,78,46', '78,62,38'];
  FX.spawnSoil = (gx, gy, gz, count, opts = {}) => {
    if (E.reducedMotion) return;
    // Soil gets headroom ABOVE the shared cap: it is the cheapest thing
    // in the pool (short-lived, no glow, no light, no trail), and the
    // one moment it exists for — the gofer erupting — can coincide with
    // a firework barrage that has the pool pinned at MAX.
    const room = (MAX_PARTICLES + 48) - dust.length;
    if (room <= 0) return;
    count = Math.min(count, room);
    const half = (opts.cone || 42) * Math.PI / 180;   // cone half-angle
    const up = opts.up !== undefined ? opts.up : 4.6; // vertical launch
    const out = opts.out !== undefined ? opts.out : 3.2;
    const dx = opts.dx || 0, dy = opts.dy || 0;       // travel-direction tilt
    for (let i = 0; i < count; i++) {
      const ang = Math.random() * Math.PI * 2;
      // Low-biased radius inside the cone: most clods barely clear the
      // hole, a few outliers fly. Uniform random looks mechanical.
      const r = Math.pow(Math.random(), 1.6);
      const horiz = Math.tan(half) * r;
      // Weighted 3:6:9 — big clods RARE, and randomly placed, so no two
      // eruptions throw the same clods in the same slots. opts.fine
      // skips the heavy class entirely: the gofer's travel-shed crumbs
      // come off a ~30px mound, and a 3px clod there is a calving
      // boulder, not a crumb.
      const roll = Math.random();
      const cls = opts.fine ? (roll < 0.5 ? 1 : 2)
                : (roll < 0.17 ? 0 : roll < 0.5 ? 1 : 2);
      const size = cls === 0 ? 2.6 + Math.random() * 0.9
                 : cls === 1 ? 1.8 + Math.random() * 0.7
                 : 1.1 + Math.random() * 0.6;
      const heavy = cls === 0;
      const sp = out * (heavy ? 0.7 : 1);
      dust.push({
        px: gx + (Math.random() - 0.5) * 0.3,
        py: gy + (Math.random() - 0.5) * 0.3,
        pz: gz + 0.05,
        vx: Math.cos(ang) * horiz * sp + dx * 1.1,
        vy: Math.sin(ang) * horiz * sp + dy * 1.1,
        vz: up * (heavy ? 0.78 : 1) * (0.75 + Math.random() * 0.5),
        // Short: particles draw AFTER the depth sort, on top of the
        // world, so the whole physics beat must finish before he is
        // tall — long-resting clods would paint over his belly.
        // opts.life/lifeSpan/rest override the eruption tuning for the
        // travel-shed crumbs, which must be gone even faster or they
        // carpet the trail.
        life: (opts.life !== undefined ? opts.life : 0.55) +
              Math.random() * (opts.lifeSpan !== undefined ? opts.lifeSpan : 0.35),
        age: 0,
        size,
        grav: 16, fadePow: 0.6, a0: 0.95,
        col: SOIL_TONES[(Math.random() * SOIL_TONES.length) | 0],
        fric: 9, bounce: heavy ? 0.3 : 0,
        restT: opts.rest,
      });
    }
  };

  // Firework burst — real-shell physics: a FAST burst whose outward speed
  // the air kills in ~0.3s (drag), then a slow glowing drift down (light
  // gravity, terminal velocity ≈ grav/drag ≈ 4 u/s) fading over ~3s. The
  // velocity-lookback trail auto-shortens as sparks brake, so streaks turn
  // into drifting embers with no extra code. fadePow < 1 holds brightness
  // through the drift instead of dimming uniformly from birth.
  // Sparks fall PAST the ground plane (floor:false) so they never carpet
  // the grass; life (not the floor) culls them before they travel far below.
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
      const speed = 6 + Math.random() * 7;          // fast burst; drag brakes it
      // ~20% take the bright top-face value — internal sparkle variation
      const hex = Math.random() < 0.2 ? col.top : col.front;
      dust.push({
        px: gx + 0.5, py: gy + 0.5, pz: gz + 0.5,
        vx: Math.cos(ang) * horiz * speed,
        vy: Math.sin(ang) * horiz * speed,
        vz: up * speed + 1.5,
        life: 2.4 + Math.random() * 1.0,
        age: 0,
        size: 1.6 + Math.random() * 1.6,
        grav: 9, drag: 2.2, fadePow: 0.7,
        col: hexToRgb(hex), a0: 0.9,
        // Not every ember carries a bloom light: real embers vary in
        // brightness, and the light stamp is where the per-frame cost
        // lives (3× lifetime = 3× concurrent embers)
        floor: false, glow: Math.random() < 0.45, trail: 1,
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
      // Air resistance (sparks only — dust has no drag field): brakes all
      // three components, then gravity re-accelerates the fall toward a
      // gentle terminal velocity. Same frame-rate-safe form as the
      // firefly/hover damping idiom.
      if (p.drag) {
        const k = Math.max(0, 1 - p.drag * dt);
        p.vx *= k; p.vy *= k; p.vz *= k;
      }
      p.px += p.vx * dt;
      p.py += p.vy * dt;
      p.vz -= (p.grav !== undefined ? p.grav : 6) * dt;
      const nz = p.pz + p.vz * dt;
      p.pz = p.floor === false ? nz : Math.max(0, nz);
      // Contact: thrown EARTH lands and stays. Opt-in via p.fric so
      // existing dust and firework sparks are untouched. Without this a
      // clod keeps sliding along the ground at its launch speed, which
      // reads as skidding litter; dirt has no bounce left after one.
      if (p.fric && p.pz <= 0) {
        p.pz = 0;
        if (p.vz < 0) { p.vz = p.bounce ? -p.vz * p.bounce : 0; p.bounce = 0; }
        const k = Math.max(0, 1 - p.fric * dt);
        p.vx *= k; p.vy *= k;
        // A landed clod rests only briefly: it draws over the sorted
        // world, so it must be gone before anything tall stands beside it
        if (!p.rested) {
          p.rested = 1;
          p.life = Math.min(p.life, p.age + (p.restT !== undefined ? p.restT : 0.3));
        }
      }
      // fadePow < 1 holds brightness longer, then lets go (embers); dust
      // keeps the plain linear fade
      let fade = 1 - p.age / p.life;
      if (p.fadePow) fade = Math.pow(fade, p.fadePow);
      const s = E.toScreen(p.px, p.py, p.pz);
      const sz = p.size * E.SCALE * (0.7 + fade * 0.5);
      const col = p.col || '207,200,184';
      if (p.glow) {
        // Halo is a LIGHT (bloom pass) — was a fresh gradient per spark
        // per frame, the single heaviest allocation in the game. Dim
        // embers stop paying for a light at all.
        if (fade > 0.3) E.addLight(s.x, s.y, sz * 2.5, col, fade * 0.35);
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
      E.addPoint(fl.gx, fl.gy, fl.gz, fl.r0 + f * fl.r1, fl.col, alpha * 0.8, { faces: true, ground: true });
    }
  };

  // ── Grass tufts (sway; hide under placed blocks) ────────────
  const W_ = () => VH.world;
  const grassTufts = [];
  (function seedGrass() {
    const used = new Set();
    while (grassTufts.length < 24) {
      // Half the tufts crowd the rim, where a lawn goes uncut.
      const rim = grassTufts.length < 12;
      let gx = -5 + Math.floor(Math.random() * 11);
      let gy = -5 + Math.floor(Math.random() * 11);
      if (rim) { if (Math.random() < 0.5) gx = Math.random() < 0.5 ? -5 : 5; else gy = Math.random() < 0.5 ? -5 : 5; }
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
      E.addPoint(f.px, f.py, f.pz, 1.3, '216,232,106', 0.2 + pulse * 0.15, { faces: true, ground: true });
      ctx.globalCompositeOperation = 'lighter';
      ctx.fillStyle = `rgba(240,248,180,${0.5 + pulse * 0.5})`;
      ctx.beginPath();
      ctx.arc(s.x, s.y, r * 0.6, 0, Math.PI * 2);
      ctx.fill();
      ctx.globalCompositeOperation = 'source-over';
    }
  };

  // ── Clouds ──────────────────────────────────────────────────
  // Two depth layers. Each cloud is a seeded run of lobes (never the same
  // three ellipses), lit from the moon's side: a pale copy is drawn first
  // and the body is drawn over it pushed away from the moon, so the
  // sliver that remains uncovered is the moonlit rim. Far clouds draw
  // behind the moon; near clouds cross in front of it and veil it. They
  // also brighten as they approach the moon, the way real cloud does.
  function makeCloud(i, far) {
    const rnd = E.hashRand(i * 7 + 3, far ? 11 : 5, 19);
    const n = 5 + Math.floor(rnd() * 4), lobes = [];
    for (let k = 0; k < n; k++) {
      const t = (k / (n - 1)) * 2 - 1; // -1..1 across the cloud
      // Cumulus: big lifted lobes in the middle, small flat ones at the
      // ends, and a flatter base than top.
      const mid = 1 - Math.abs(t);
      const rx = 18 + rnd() * 26 * (0.5 + mid * 0.5);
      lobes.push({
        dx: t * 66 + (rnd() - 0.5) * 16,
        dy: (rnd() - 0.5) * 5 - mid * 9,
        rx, ry: rx * (0.42 + rnd() * 0.22),
      });
    }
    return {
      x: rnd() * 1.4 - 0.2,
      y: (far ? 0.04 : 0.09) + rnd() * 0.15,
      speed: (far ? 0.0035 : 0.008) + rnd() * 0.004, // fraction of W per second
      scale: (far ? 0.55 : 0.9) + rnd() * 0.5,
      alpha: (far ? 0.06 : 0.09) + rnd() * 0.03,
      lobes,
    };
  }
  const cloudsFar = [0, 1, 2].map(i => makeCloud(i, true));
  const cloudsNear = [3, 4, 5].map(i => makeCloud(i, false));
  // Each cloud is composed OPAQUE in its own small sprite — rim colour over
  // the whole body, then the body colour shifted away from the moon with
  // source-atop, so only a moon-side sliver stays pale and nothing spills
  // outside the silhouette — and the sprite is blitted once at the cloud's
  // alpha. (Drawing both copies translucently on the main canvas showed the
  // pale copy through the body as a ghost outline.)
  const cloudSprite = document.createElement('canvas');
  const cloudSpriteCtx = cloudSprite.getContext('2d');
  function drawCloudLayer(list, dt) {
    const ctx = E.ctx;
    const mx = E.MOON.fx * E.W, my = E.MOON.fy * E.H;
    const dpr = Math.min(window.devicePixelRatio || 1, 2);
    for (const c of list) {
      if (!E.reducedMotion) c.x += c.speed * dt;
      if (c.x > 1.3) c.x = -0.3;
      const cx = c.x * E.W, cy = c.y * E.H, s = c.scale * E.SCALE;
      const ddx = mx - cx, ddy = my - cy, d = Math.hypot(ddx, ddy) || 1;
      const near = Math.max(0, 1 - d / (E.W * 0.4));
      const a = Math.min(0.42, c.alpha * 1.5 * (1 + near * 1.3));
      // sprite bounds: lobes span roughly ±(66+50) in x, ±30 in y, in units of s
      const hw = Math.ceil(130 * s), hh = Math.ceil(42 * s);
      const sw = hw * 2, sh = hh * 2;
      if (cloudSprite.width !== Math.ceil(sw * dpr) || cloudSprite.height !== Math.ceil(sh * dpr)) {
        cloudSprite.width = Math.ceil(sw * dpr); cloudSprite.height = Math.ceil(sh * dpr);
      }
      const x = cloudSpriteCtx;
      x.setTransform(dpr, 0, 0, dpr, 0, 0);
      x.globalCompositeOperation = 'source-over';
      x.clearRect(0, 0, sw, sh);
      const lobePath = (ox, oy) => {
        x.beginPath();
        for (const l of c.lobes) {
          const lx = hw + (l.dx + ox) * s, ly = hh + (l.dy + oy) * s;
          x.moveTo(lx + l.rx * s, ly);
          x.ellipse(lx, ly, l.rx * s, l.ry * s, 0, 0, Math.PI * 2);
        }
      };
      x.fillStyle = '#e6e6f4'; // the moonlit rim
      lobePath(0, 0); x.fill();
      x.globalCompositeOperation = 'source-atop';
      x.fillStyle = '#7d86b4'; // the body, pushed away from the moon
      const k = 2.4 * (0.6 + near);
      lobePath(-ddx / d * k, -ddy / d * k); x.fill();
      ctx.globalAlpha = a;
      ctx.drawImage(cloudSprite, 0, 0, cloudSprite.width, cloudSprite.height, cx - hw, cy - hh, sw, sh);
    }
    ctx.globalAlpha = 1;
  }
  FX.drawCloudsFar = (dt) => drawCloudLayer(cloudsFar, dt);
  FX.drawCloudsNear = (dt) => drawCloudLayer(cloudsNear, dt);

  // ── Void mist ───────────────────────────────────────────────
  // A soft dark pool under the island so it sits IN the night rather than
  // pasted onto it. Cached sprite (one radial gradient per zoom level),
  // drawn on the main canvas before the platform: the light buffer is
  // additive and cannot darken.
  const mist = { canvas: document.createElement('canvas'), key: '', w: 0, h: 0 };
  FX.drawVoidMist = () => {
    const Wd = VH.world;
    const ctx = E.ctx;
    const t = E.TILE * E.SCALE;
    const span = Wd.GRID_MAX - Wd.GRID_MIN + 1;
    const rw = span * t * 1.25, rh = span * t * 0.5 * 1.0;
    const key = rw.toFixed(1);
    if (mist.key !== key) {
      mist.key = key;
      const dpr = Math.min(window.devicePixelRatio || 1, 2);
      const c = mist.canvas;
      mist.w = Math.ceil(rw * 2); mist.h = Math.ceil(rh * 2);
      c.width = Math.ceil(mist.w * dpr); c.height = Math.ceil(mist.h * dpr);
      const x = c.getContext('2d');
      x.setTransform(dpr, 0, 0, dpr, 0, 0);
      x.translate(mist.w / 2, mist.h / 2);
      x.scale(1, rh / rw);
      // A faint haze first (night air under the island), then the dark
      // core directly beneath it.
      const h = x.createRadialGradient(0, 0, 0, 0, 0, rw);
      h.addColorStop(0, 'rgba(110,122,176,0.10)');
      h.addColorStop(0.6, 'rgba(110,122,176,0.05)');
      h.addColorStop(1, 'rgba(110,122,176,0)');
      x.fillStyle = h;
      x.beginPath(); x.arc(0, 0, rw, 0, Math.PI * 2); x.fill();
      const g = x.createRadialGradient(0, 0, 0, 0, 0, rw * 0.62);
      g.addColorStop(0, 'rgba(4,5,16,0.7)');
      g.addColorStop(0.5, 'rgba(4,5,16,0.35)');
      g.addColorStop(1, 'rgba(4,5,16,0)');
      x.fillStyle = g;
      x.beginPath(); x.arc(0, 0, rw, 0, Math.PI * 2); x.fill();
    }
    const c = E.toScreen(0.5, 0.5, -2.9);
    ctx.drawImage(mist.canvas, c.x - mist.w / 2, c.y - mist.h / 2, mist.w, mist.h);
  };

})();
