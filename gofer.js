/* ============================================================
   gofer.js — the gofer: a voxel character in the monument idiom.

   WHO he is comes from the locked mascot bible
   (gofer repo, .planning/notes/landing-page-mascot-midjourney-prompts.md):
   round cinnamon body, cream belly, small close-set ears, two buck
   teeth, cream crossbody satchel + knotted neckerchief (the two
   non-negotiable recognisability anchors), standing on hind legs.
   ONE deviation, decided 2026-08-30: the neckerchief is WARM RUST,
   not the bible's forest-green — green-on-green vanishes on night
   grass at his size.

   HOW he is made: boxes drawn through W.drawBlock, one depth-sort
   entry per box (the monument idiom), so he takes the moonlight,
   casts a real shadow and occludes correctly.

   HE HAS A HEADING (`S.facing`, quarter turns). His whole body pivots
   into it, and his face — eyes on the head, nose + buck teeth on the
   snout, drawn as pixel quads in the SIGN_MARKS idiom because fine
   facial detail at ~20px is the one thing boxes can't do — is painted
   on his REAL front and never moves relative to him. Rotate the camera
   behind him and you see the back of his head. That is deliberate: it
   is the difference between a creature and a sticker, and it is the
   whole reason this project chose voxels over a billboarded sprite.
   (The plan's original recommendation — stamp the face on whichever
   side points at the camera — was built first and REJECTED on screen
   2026-08-30. See the note on S.facing for what it looked like.)

   HE LIVES on a loop: up → ducks into the dirt → the mound slides
   across the grass → pops up somewhere empty, facing the visitor.
   A block claiming his tile makes him duck immediately — he is never
   in the occupancy index, so he can never obstruct the core loop; he
   reacts to it instead. He is NEVER below the surface: duck and
   surface are a scale about the ground plane, and the dirt mound
   plays the hole. Rhythm knobs live in RHYTHM (second gate).
   Still to come: the tap (→ /work/gofer/), noticePlacement bias
   ("he notices"), and the entrance cameo.
   ============================================================ */
(() => {
  'use strict';
  const VH = window.VH;
  const E = VH.engine;
  const W = VH.world;

  const G = (VH.gofer = {});

  // The gofer's palette, registered here so world.js stays untouched.
  // None of these are placeable (not in BLOCK_COLORS) and none can
  // enter a save (saves store block + monument colours only).
  Object.assign(W.COLORS, {
    goferFur:    { top: '#b57a4b', right: '#7d4e2c', front: '#9a643a' }, // warm cinnamon
    goferBelly:  { top: '#e8d2a6', right: '#b09a74', front: '#cdb68d' }, // cream-tan
    goferRust:   { top: '#c95f33', right: '#8e3c1c', front: '#ac4d28' }, // the neckerchief (rust, not green)
    goferCanvas: { top: '#e6dcbd', right: '#b0a689', front: '#cbc1a2' }, // satchel canvas
    goferStrap:  { top: '#6e4c2d', right: '#48301b', front: '#5b3e24' }, // leather strap
    // The soil ramp — four VALUE steps in one narrow warm hue, because
    // earth reads through value, never through hue (brown→orange→red
    // reads as candy). Face ratios stay consistent across the ramp so
    // nine clumps read as one mass instead of nine objects. soil2 is
    // the platform's own dirt, so the pile belongs to the island.
    soil0: { top: '#6b5232', right: '#42311d', front: '#574227' }, // darkest — trail
    soil1: { top: '#7b5f39', right: '#4d3a22', front: '#644c2d' },
    soil2: { top: '#8b6b3d', right: '#5c4428', front: '#745832' }, // == dirt
    soil3: { top: '#9c7a48', right: '#68502f', front: '#82643a' }, // lightest — catches the moon
    // Two deliberately "wrong" clumps in the pile — a scrap of turf
    // carried up, and a near-black pebble. Two off-notes in nine clumps
    // is the difference between dirt and brown boxes.
    soilTurf:   { top: '#5d7141', right: '#3a4827', front: '#4b5c33' },
    soilPebble: { top: '#3a352e', right: '#211e19', front: '#2d2a24' },
  });

  // ── The model ───────────────────────────────────────────────
  // [dx, dy, z, sx, sy, sz, colour] — dx/dy offset the piece CENTRE
  // from the anchor tile's centre (drawBlock centres a box on its
  // cell); z is the box base. He faces -y. Pieces are pairwise
  // DISJOINT (butted, never interpenetrating) — same rule as the
  // monument models, same reason: overlapping boxes have no valid
  // painter's order. A #dev self-check below polices it.
  //
  // Proportions live here so a "head too big / too small" note from
  // the designer is a one-number change.
  const MODEL = [
    // round body on hind legs
    [0,     0,      0.09, 0.60, 0.46, 0.50, 'goferFur',    'body'],
    // cream belly, a plate on his front (the doghouse-door pattern)
    // a WIDE cream panel on purpose: it is the canvas the dark strap
    // and fur paws read against — small belly = clutter, tested on screen
    [0,    -0.26,   0.12, 0.44, 0.06, 0.44, 'goferBelly',  'belly'],
    // neckerchief: a collar band between body and head, proud all round
    [0,     0,      0.59, 0.54, 0.46, 0.09, 'goferRust',   'kerchief'],
    // head
    [0,     0,      0.68, 0.48, 0.40, 0.38, 'goferFur',    'head'],
    // small round ears, set close
    [-0.13, 0.02,   1.06, 0.13, 0.11, 0.11, 'goferFur',    'earL'],
    [ 0.13, 0.02,   1.06, 0.13, 0.11, 0.11, 'goferFur',    'earR'],
    // paws held out — "Look what I found"
    [-0.16, -0.35,  0.34, 0.14, 0.12, 0.12, 'goferFur',    'pawL'],
    [ 0.16, -0.35,  0.34, 0.14, 0.12, 0.12, 'goferFur',    'pawR'],
    // stubby tail
    [0,     0.28,   0.12, 0.14, 0.10, 0.12, 'goferFur',    'tail'],
    // the satchel on his right hip…
    [0.36,  0.02,   0.12, 0.12, 0.28, 0.30, 'goferCanvas', 'bag'],
    // …and its diagonal strap, stepped voxel-style across front and
    // back — the asymmetry that breaks the round silhouette (the
    // bible's own anti-lump insurance)
    [-0.14, -0.315, 0.46, 0.13, 0.05, 0.13, 'goferStrap',  'strapF1'],
    [ 0,    -0.315, 0.33, 0.13, 0.05, 0.13, 'goferStrap',  'strapF2'],
    [ 0.14, -0.315, 0.20, 0.13, 0.05, 0.13, 'goferStrap',  'strapF3'],
    [-0.14,  0.255, 0.46, 0.13, 0.05, 0.13, 'goferStrap',  'strapB1'],
    [ 0,     0.255, 0.33, 0.13, 0.05, 0.13, 'goferStrap',  'strapB2'],
    [ 0.14,  0.255, 0.20, 0.13, 0.05, 0.13, 'goferStrap',  'strapB3'],
  ];

  // Snout: authored separately from MODEL only because the face marks
  // ride it. It butts the head's FRONT (local -y): the head is 0.40
  // deep, so its front face sits at -0.20, and a 0.10-thick muzzle
  // centred at -0.25 touches it exactly and protrudes 0.10.
  const SNOUT = { protrude: 0.25, across: 0.20, thick: 0.10, z: 0.72, sz: 0.14 };

  // ── The mounds ──────────────────────────────────────────────
  // [dx, dy, z0, sx, sy, sz, colour] in his LOCAL frame (front = -y,
  // rear = +y), rotated into the world by his heading like every other
  // piece. Two tables, chosen by state.
  //
  // Rules doing specific work (each one earned by the failed flat-tile
  // version the designer rejected):
  //  · EVERY dimension < 0.35 (STROKE_MIN in world.js): at or over that
  //    threshold drawBlock strokes a crisp 1px outline and seats contact
  //    bands — the exact rendering that makes a box read as a TILE. The
  //    old 0.84-wide platter was over it; that outline WAS the tile.
  //  · All bases 0.03–0.05 BELOW the ground plane, so no baseline is
  //    ever drawn — the strongest "pushed up through the turf" cue, and
  //    free: there is no z-buffer, and the sub-zero sliver projects to
  //    under a pixel.
  //  · Same-colour unstroked clumps may OVERLAP: they produce the same
  //    union silhouette in any paint order, so the disjointness rule is
  //    deliberately relaxed here (and the #dev self-check excludes them).
  //  · The peak sits toward the REAR (+y): material trailing the
  //    creature is what says "pushed forward". The shoulder loads one
  //    side only — the gopher-mound crescent, and the asymmetry that
  //    breaks the tile read.
  //  · At least two distinct top heights in silhouette; one flat top
  //    equals one tile.
  // The core is trimmed to 0.32×0.27 ON PURPOSE: at the sniff swell
  // (×1.12) plus the churn's ±16% height cycle, a 0.29-tall core would
  // cross STROKE_MIN and regrow the rejected tile's outline. The #dev
  // self-check asserts this headroom permanently.
  const MOUND_ACTIVE = [
    [ 0,     0.02, -0.05, 0.32, 0.30, 0.26, 'soil2'],  // core mass
    [ 0.02,  0.09,  0.14, 0.26, 0.22, 0.14, 'soil3'],  // peak cap, rear-biased
    [ 0.15,  0.04, -0.04, 0.30, 0.24, 0.20, 'soil1'],  // crescent shoulder, one side
    // the leading APRON — the ragged lip a real mound pushes ahead of
    // itself, and the geometry the churn animates. Before these, the
    // front profile was one flat soil2 wall: the brick. Mutually
    // disjoint in x, so their different colours never contend for
    // paint order; deliberately NOT soil2, which would rebuild the wall.
    [-0.20, -0.23, -0.05, 0.16, 0.14, 0.15, 'soil3'],  // lip L1
    [ 0.01, -0.28, -0.05, 0.18, 0.15, 0.11, 'soil1'],  // lip L2 — furthest forward, lowest
    [ 0.19, -0.21, -0.05, 0.13, 0.12, 0.18, 'soil0'],  // lip L3 — tallest, crescent side
    [-0.28,  0.18, -0.03, 0.18, 0.16, 0.13, 'soil1'],  // skirt…
    [ 0.30,  0.22, -0.03, 0.14, 0.13, 0.10, 'soil0'],
    [-0.32, -0.06, -0.03, 0.15, 0.14, 0.11, 'soil2'],
    [ 0.10,  0.34, -0.03, 0.20, 0.15, 0.13, 'soil3'],
    [-0.12,  0.30, -0.03, 0.13, 0.12, 0.09, 'soilTurf'],   // turf carried up
    [ 0.30, -0.18, -0.03, 0.08, 0.08, 0.08, 'soilPebble'], // near-black pebble, clear of the lip
  ];
  // The crater he stands IN after erupting: a low ring of spoil outside
  // his 0.60×0.46 body footprint, plus a fresh-dirt pad whose top is
  // exactly his sole height (0.09) — he emerges onto the earth he threw.
  const MOUND_CRATER = [
    [ 0,     0,    -0.03, 0.34, 0.30, 0.12, 'soil2'],  // the pad he stands on
    [ 0.34,  0.10, -0.03, 0.14, 0.13, 0.11, 'soil1'],
    [-0.35, -0.02, -0.03, 0.13, 0.14, 0.10, 'soil2'],
    [ 0.10,  0.30, -0.03, 0.16, 0.13, 0.11, 'soil3'],
    [-0.16,  0.29, -0.03, 0.12, 0.12, 0.09, 'soil0'],
    [ 0.30, -0.20, -0.03, 0.12, 0.11, 0.09, 'soil2'],
    [-0.28, -0.20, -0.03, 0.11, 0.11, 0.08, 'soilTurf'],
  ];

  const HEIGHT = 1.17; // ear tops — the shadow caster's ceiling

  // ── The face (pixel quads on his REAL front) ────────────────
  // Face-space rects [u, v, du, dv]: u across the face, v up from its
  // base, both 0..1. The bible's translation table: large soft dark
  // eyes (highlight dropped — it will not survive), small dark nose,
  // two pale buck teeth.
  //
  // Every group is left-right SYMMETRIC on purpose, so the marks need
  // no column flip: they are paint on one fixed surface of his head,
  // not a wordmark that must read forward from both sides (contrast
  // world.js SIGN_MARKS, which flips for exactly that reason). If an
  // asymmetric detail is ever added — a wink, a cocked eyebrow — it
  // will still be correct, because the surface it sits on is his.
  const EYES  = [[0.15, 0.52, 0.22, 0.32], [0.63, 0.52, 0.22, 0.32]];
  // Blink: the SAME eye, collapsed to a lid line sitting where the eye's
  // lower edge was. Width is unchanged on purpose — a blink that also
  // narrows reads as a squint, and the shape popping to a new width is
  // what makes cheap blinks look like a glitch rather than an eyelid.
  const EYES_SHUT = [[0.15, 0.58, 0.22, 0.09], [0.63, 0.58, 0.22, 0.09]];
  const NOSE  = [[0.34, 0.58, 0.32, 0.30]];
  const TEETH = [[0.24, 0.04, 0.21, 0.42], [0.55, 0.04, 0.21, 0.42]];
  const INK_DARK = '#2a1c12'; // soft near-black, not pure #000
  const INK_TOOTH = '#f4ecd9';

  // Blink rhythm. Humans blink every 2–10s and a blink lasts ~0.1–0.15s;
  // these sit at the lively end of that, because he is a small eager
  // animal, not a resting adult. The occasional DOUBLE blink is what
  // stops the loop reading as a metronome — an even cadence is the tell
  // that gives away a timer, and irregularity is what reads as alive.
  const BLINK_SHUT = 0.12;   // seconds the lid is down
  const BLINK_GAP = 0.17;    // pause between the two halves of a double
  const BLINK_MIN = 2.6, BLINK_SPAN = 3.6; // 2.6–6.2s between blinks
  const DOUBLE_CHANCE = 0.28;
  const nextBlink = () => BLINK_MIN + Math.random() * BLINK_SPAN;

  // ── The rhythm (SECOND GATE — tune these on screen) ─────────
  // How long he stays up, how long the dig pause lasts, how fast the
  // mound travels, how far he goes. One block, no arithmetic elsewhere.
  const RHYTHM = {
    upMin: 9, upSpan: 9,     // seconds standing before he digs off (9–18)
    duckT: 0.22,             // seconds to shrink into the ground
    holePause: 0.55,         // beat underground before the mound moves
    speed: 2.4,              // mound travel, tiles per second (mean — see surge)
    surfaceT: 0.34,          // seconds to pop back up (backOut overshoot)
    wanderMin: 2, wanderMax: 5, // how far a relocation reaches, in tiles
    // The dig craft — what separates a creature from a sliding marker:
    surge: 0.45,             // ±speed modulation while travelling (real burrowers surge)
    surgeFreq: 4.1,          // radians per tile travelled
    bob: 0.05,               // mound vertical bob, tiles (0.035 was sub-pixel on a phone)
    bobFreq: 6.3,            // radians per tile travelled
    // Tuned so a sniff lands MID-journey: legs run 0.8–2.1s at this
    // speed, and a sniff that fires later than that never happens —
    // measured, six straight journeys, zero sniffs — which also
    // starves the change-of-mind turn that rides on it.
    sniffMin: 0.7, sniffSpan: 0.9, // seconds of travel between pause-and-sniff beats
    sniffT: 0.32,            // how long a sniff pause holds
    turnChance: 0.6,         // chance a sniff ends in a CHANGE OF MIND (new heading)
    turnsMax: 2,             // at most this many mid-journey turns per trip
    anticipateT: 0.28,       // pre-eruption shake/swell
    eruptLead: 0.05,         // dirt is airborne this long BEFORE the head appears
    trailStep: 0.26,         // tiles travelled between trail segments
    trailLife: 1.5,          // seconds a segment takes to sink away
    stepEvery: 0.42,         // tiles dug between paw-scuff sounds (~4.6/s at cruise)
    // The churn — the working, crumbling leading edge (designer's note:
    // "dirt is falling off the top of it"). One master dial:
    churnAmp: 1.0,           // 0 = rigid brick, ~1.8 = pronounced
    churnFreq: 11.0,         // radians per tile dug (~4.2Hz at cruise — clearly
                             // faster than the 2.4Hz gait bob, so it reads as
                             // a second motion, not more bob)
    shedStep: 0.11,          // tiles dug between crumbs shed off the lip
  };

  // ── State ───────────────────────────────────────────────────
  // The machine from the plan: up → ducking → (hole beat) →
  // travelling mound → surfacing → up. He ducks EARLY the moment a
  // block claims his tile — he is never in the occupancy index, so he
  // can never block the core loop; he reacts to it instead, which is
  // exactly what a gopher would do. He is never below the surface:
  // duck/surface are a scale about the ground plane, travel is the
  // dirt mound sliding, and the visitor's eye does the rest.
  //
  // `facing` is his HEADING in quarter turns, and it is the whole
  // correction the designer called for on 2026-08-30. The first cut
  // followed the plan literally — the face was stamped on whichever
  // side of his head pointed at the camera — and it failed on screen
  // for two reasons: his snout is a real box, so it TELEPORTED across
  // his head as the camera passed 45°; and his face slid free of his
  // own chest, so his eyes sat on the side of a body that never
  // turned. That is the swivelling-sticker problem the voxel decision
  // was bought to avoid, reintroduced at the head. So: he has a real
  // front, his face is painted on it, and he TURNS — a heading is
  // something he has, not something the camera grants him.
  const S = {
    state: 'up',
    gx: 2, gy: 2,     // his CURRENT tile (integers when settled)
    px: 2, py: 2,     // continuous position — fractional only mid-travel
    tx: 2, ty: 2,     // travel target tile
    scale: 1,         // 0 = underground, 1 = fully surfaced
    t: 0,             // current phase's countdown timer
    upFor: 6,         // seconds left standing before he digs off
    facing: 3,        // heading in quarter turns; 3 = chest toward viewer at rest
    booted: false,    // first-update check: a SAVE may occupy his start tile
    travelled: 0,     // distance dug this trip — keys surge/bob/trail (freezes with dt)
    churn: 0,         // churn phase, radians. Integrates dt/step — NEVER clock.time,
                      // which keeps advancing during hit-stop and would leave the
                      // pile boiling while the whole world is frozen
    trailAt: 0,       // distance mark for the next trail segment
    shedAt: 0,        // distance mark for the next shed crumb
    stepAt: 0,        // distance mark for the next paw-scuff sound
    sniffIn: 2,       // seconds of travel until the next pause-and-sniff
    sniffT: 0,        // >0: mid-sniff, the mound holds still and swells
    turnsLeft: 0,     // mid-journey changes of mind remaining this trip
    jx: 0, jy: 0,     // anticipation jitter, tiles
    dirX: 0, dirY: -1,// unit direction of the current travel leg
    blinkIn: 1.2,  // seconds until the next blink starts
    blinkShut: 0,  // seconds of lid-down remaining (>0 means eyes closed)
    blinkQueue: 0, // halves of a double-blink still owed
    lookT: 0,      // >0: holding a look at something that just landed
    startleT: 0,   // >0: mid-flinch (the hop that rides the look)
    chatHold: false, // the chat panel is open: his dig-off timer pauses
  };

  // ── The trail ───────────────────────────────────────────────
  // Disturbed earth closing behind him — without it there is no
  // evidence the ground was ever entered, and the mound reads as an
  // object ON the surface. Fixed ring buffer, slots reused, nothing
  // allocated per frame beyond the entry closures every drawer makes.
  //
  // Segments fade by SINKING — the top decays to the ground while the
  // base stays pinned just below it — never by translating downward:
  // there is no depth buffer, so a box pushed under the surface would
  // paint a full-height dirt wall OVER the platform bitmap and get
  // more visible as it "sank".
  // 20, not 16: the ring must outlive trailLife at PEAK surge speed
  // (speed × 1.45), or a fast stretch reuses a slot whose segment is
  // still alive — it vanishes at the tail and reappears at his heels
  // in one frame. 20 × 0.26 / 3.5 ≈ 1.49s ≥ the 1.5s life, with the
  // sniff pauses adding real margin on top.
  const TRAIL_MAX = 20;
  const trail = Array.from({ length: TRAIL_MAX }, () => ({
    live: false, gx: 0, gy: 0, sx: 0.3, sy: 0.2, h0: 0.13,
    age: 0, life: RHYTHM.trailLife, col: 'soil0',
    // two crumbs, offsets fixed at spawn so nothing shimmers
    c1x: 0, c1y: 0, c1s: 0.07, c2x: 0, c2y: 0, c2s: 0.05,
  }));
  let trailHead = 0;

  function dropTrailSegment(gx, gy, serpent) {
    const s = trail[trailHead];
    trailHead = (trailHead + 1) % TRAIL_MAX;
    // Perpendicular to travel: the serpentine wander that separates a
    // creature's path from a stamped decal
    const lx = -S.dirY, ly = S.dirX;
    s.live = true;
    s.gx = gx + lx * serpent;
    s.gy = gy + ly * serpent;
    // Long axis follows the travel quadrant (boxes cannot rotate)
    const alongX = Math.abs(S.dirX) >= Math.abs(S.dirY);
    s.sx = alongX ? 0.30 : 0.20;
    s.sy = alongX ? 0.20 : 0.30;
    s.h0 = 0.11 + Math.random() * 0.05;
    s.age = 0;
    s.life = RHYTHM.trailLife;
    s.col = Math.random() < 0.5 ? 'soil0' : 'soil1'; // freshly turned: darker than the pile
    s.c1x = (Math.random() - 0.5) * 0.34; s.c1y = (Math.random() - 0.5) * 0.34;
    s.c2x = (Math.random() - 0.5) * 0.4;  s.c2y = (Math.random() - 0.5) * 0.4;
    s.c1s = 0.05 + Math.random() * 0.04;
    s.c2s = 0.04 + Math.random() * 0.03;
  }

  // Reduced motion lays the whole path at once and lets it sink in
  // place — zero lateral movement, but the "he went that way" record
  // is arguably clearer than the animated version.
  function layTrail(x0, y0, x1, y1) {
    const dx = x1 - x0, dy = y1 - y0;
    const dist = Math.hypot(dx, dy);
    if (dist < 0.5) return;
    S.dirX = dx / dist; S.dirY = dy / dist;
    const n = Math.min(TRAIL_MAX - 2, Math.max(2, Math.round(dist / RHYTHM.trailStep)));
    for (let i = 0; i <= n; i++) {
      const f = i / n;
      dropTrailSegment(x0 + dx * f, y0 + dy * f, Math.sin(f * dist * 6) * 0.09);
    }
  }

  const backOut = (p) => { const c = 1.70158; const q = p - 1; return 1 + (c + 1) * q * q * q + c * q * q; };
  const rollUp = () => RHYTHM.upMin + Math.random() * RHYTHM.upSpan;

  // The free-tile test — the grass-tuft precedent. getStackHeight counts
  // player blocks AND monument volumes, so one call answers both.
  const tileFree = (gx, gy) => W.isOnPlatform(gx, gy) && W.getStackHeight(gx, gy) === 0;

  // ── The noticing ────────────────────────────────────────────
  // The half of him that is NOT decoration. Gofer's product is "a social
  // wishlist that learns what you and your friends love", so a gofer who
  // merely wanders is the mascot trap — cute, meaningless, and the exact
  // thing that makes a portfolio read as "look what I can do". He pays
  // attention to what you like, which is literally the product's job:
  // he comes up near where you have been building, and he looks when
  // something lands beside him.
  const NOTICE = {
    keep: 6,        // placements remembered
    life: 45,       // seconds one stays "recent" — he must not haunt a
                    // corner the visitor abandoned five minutes ago
    bias: 0.7,      // chance a relocation aims at one of them
    reach: 2.2,     // he surfaces within this many tiles of the placement
    minTrip: 1.5,   // …but never a trip so short it reads as a twitch
                    // (below wanderMin on purpose: going somewhere
                    // SPECIFIC earns a shorter journey than wandering)
    near: 3.0,      // a block landing this close gets the one-beat look
    lookT: 1.1,     // how long he holds it before turning back
    startleT: 0.26, // the flinch that rides the turn
    startleH: 0.07, // flinch height, tiles
  };
  const recent = []; // {gx, gy, age} — oldest first, newest last

  // Called from the three places the VISITOR puts a block down (game.js).
  // Deliberately not called by the entrance, the dev harnesses or the
  // tumble paths: this is a record of what the visitor did, not of what
  // the world did.
  G.noticePlacement = (gx, gy) => {
    recent.push({ gx, gy, age: NOTICE.life });
    if (recent.length > NOTICE.keep) recent.shift();
    // The one-beat reaction. Only while he is standing — there is no
    // face to look with otherwise — and never for a block on his own
    // tile, which outranks this and makes him duck (handled in update).
    if (S.state !== 'up') return;
    const d = Math.hypot(gx - S.px, gy - S.py);
    if (d < 1e-6 || d > NOTICE.near) return;
    S.lookT = NOTICE.lookT;
    S.startleT = NOTICE.startleT;
    S.facing = faceTravel(gx - S.px, gy - S.py); // he turns to it
    S.blinkIn = 0.001; S.blinkShut = 0;          // and blinks on the turn
  };

  // A tile near something the visitor recently built. Weighted toward the
  // NEWEST placement: their attention is where they just put a block, not
  // where they put one a minute ago.
  function pickNoticed() {
    if (!recent.length) return null;
    for (let tries = 0; tries < 30; tries++) {
      // |rand - rand| is triangular at 0, so this lands on the end of the
      // array (newest) far more often than the front. No RNG table, no
      // weights array — one expression.
      const back = Math.floor(Math.abs(Math.random() - Math.random()) * recent.length);
      const r = recent[Math.max(0, recent.length - 1 - back)];
      const a = Math.random() * Math.PI * 2;
      const d = 0.9 + Math.random() * (NOTICE.reach - 0.9);
      const gx = Math.round(r.gx + Math.cos(a) * d);
      const gy = Math.round(r.gy + Math.sin(a) * d);
      if (gx === S.gx && gy === S.gy) continue;
      if (!tileFree(gx, gy)) continue;
      if (Math.hypot(gx - S.px, gy - S.py) < NOTICE.minTrip) continue;
      return { gx, gy };
    }
    return null;
  }

  // Somewhere empty to pop up. Mostly near where the visitor has been
  // building; otherwise wanderMin..wanderMax tiles away at random.
  function pickTarget() {
    if (Math.random() < NOTICE.bias) {
      const noticed = pickNoticed();
      if (noticed) return noticed;
    }
    for (let tries = 0; tries < 60; tries++) {
      const d = RHYTHM.wanderMin + Math.random() * (RHYTHM.wanderMax - RHYTHM.wanderMin);
      const a = Math.random() * Math.PI * 2;
      const gx = Math.round(S.px + Math.cos(a) * d);
      const gy = Math.round(S.py + Math.sin(a) * d);
      if ((gx !== S.gx || gy !== S.gy) && tileFree(gx, gy)) return { gx, gy };
    }
    // Crowded board: take ANY free tile; a full board keeps him hidden
    for (let gx = W.GRID_MIN; gx <= W.GRID_MAX; gx++) {
      for (let gy = W.GRID_MIN; gy <= W.GRID_MAX; gy++) {
        if (tileFree(gx, gy)) return { gx, gy };
      }
    }
    return null;
  }

  // The heading whose front points most toward the viewer — decided
  // ONCE, at the moment he surfaces. A choice he makes when he pops up
  // and then holds, not a per-frame billboard: the camera can still
  // orbit behind him afterwards.
  function faceCamera() {
    const wx = E.cosA + E.sinA, wy = E.cosA - E.sinA; // +x / +y toward-viewer weights
    const dir = Math.abs(wx) >= Math.abs(wy)
      ? [wx > 0 ? 1 : -1, 0]
      : [0, wy > 0 ? 1 : -1];
    for (let k = 0; k < 4; k++) {
      const [fx, fy] = rot(0, -1, k);
      if (fx === dir[0] && fy === dir[1]) return k;
    }
    return 3;
  }

  // The heading nearest his travel direction — the mound arrives and he
  // pops up the way he was going, then turns to the visitor.
  function faceTravel(dx, dy) {
    const dir = Math.abs(dx) >= Math.abs(dy)
      ? [dx > 0 ? 1 : -1, 0]
      : [0, dy > 0 ? 1 : -1];
    for (let k = 0; k < 4; k++) {
      const [fx, fy] = rot(0, -1, k);
      if (fx === dir[0] && fy === dir[1]) return k;
    }
    return S.facing;
  }

  // Set out for S.tx/S.ty as a travelling mound. Shared by his own loop
  // and by the entrance cameo, so the opening shows the same journey the
  // visitor will see all evening rather than a special-cased imitation.
  function beginTravel() {
    S.facing = faceTravel(S.tx - S.px, S.ty - S.py);
    S.travelled = 0;
    S.churn = 0;
    S.trailAt = RHYTHM.trailStep;
    S.shedAt = RHYTHM.shedStep;
    S.stepAt = RHYTHM.stepEvery;
    S.sniffIn = RHYTHM.sniffMin + Math.random() * RHYTHM.sniffSpan;
    S.turnsLeft = 1 + Math.floor(Math.random() * RHYTHM.turnsMax);
    S.state = 'travelling';
  }

  function startDuck() {
    // The dive throws a little dirt sideways — but only if he is
    // actually visible (startDuck is reachable mid-pop, where a burst
    // off an invisible body would be noise). Wider cone than the
    // eruption: he is punching DOWN, so the spray goes out, not up.
    if (S.scale > 0.5 && VH.fx) {
      VH.fx.spawnSoil(S.px + 0.5, S.py + 0.5, 0.05, 8, { cone: 62, up: 2.6, out: 2.2 });
    }
    // The knock: a thump felt through the turf as he punches in. Same
    // visibility gate as the spray — an inaudible-body dive is noise.
    if (S.scale > 0.5 && VH.sfx && VH.sfx.goferDuck) {
      VH.sfx.goferDuck({ gx: S.px, gy: S.py });
    }
    S.state = 'ducking';
    // Scaled to where he actually is: ducking derives scale from the
    // timer, so a full timer during a mid-pop snipe would SNAP him to
    // full size before shrinking (review find CR-01). min() also covers
    // the backOut overshoot where scale is briefly ~1.1.
    S.t = (E.reducedMotion ? 0.22 : RHYTHM.duckT) * Math.min(1, S.scale);
  }

  // Reduced motion keeps REAL durations (0.22 / 0.3 / 0.25): the
  // setting means no vestibular motion — no slide, no shake, no debris
  // — not "instant". A teleport is its own kind of jolt.
  function beginSurface() {
    S.gx = S.tx; S.gy = S.ty;
    S.facing = faceCamera(); // he pops up and meets the visitor
    if (E.reducedMotion) {
      // Sound survives reduced motion (it isn't vestibular), and with no
      // dirt burst on this path the pop is the only arrival cue there is.
      if (VH.sfx && VH.sfx.goferPop) VH.sfx.goferPop({ gx: S.px, gy: S.py });
      S.state = 'surfacing';
      S.t = 0.25;
    } else {
      // Anticipation first: the mound halts, swells and shakes — the
      // beat that tells the player something is about to happen.
      S.state = 'anticipating';
      S.t = RHYTHM.anticipateT;
    }
  }

  // Local model space: his front is -y, his right is +x. `facing` maps
  // that local frame into the world with the monuments' own quarter-turn
  // convention (monuments.js rot), so a piece long in x becomes long in
  // y on an odd turn — exactly as a rotated recipe does.
  function rot(dx, dy, k) {
    switch (k & 3) {
      case 0: return [dx, dy];
      case 1: return [dy, -dx];
      case 2: return [-dx, -dy];
      default: return [-dy, dx];
    }
  }

  // His front as a world direction, per facing: local -y turned by k.
  // axis 'x'|'y' plus the sign of that axis.
  function frontDir() {
    const [fx, fy] = rot(0, -1, S.facing);
    return fx !== 0 ? { axis: 'x', sign: fx } : { axis: 'y', sign: fy };
  }

  // Is his front actually the side drawBlock is painting right now?
  // drawBlock draws exactly two side faces: the +x one when xVisible
  // (else -x), and the +y one when yVisible (else -y). So a specific
  // world side is on screen only when it matches that pick — and when
  // it doesn't, he has his back to us and the face must NOT be drawn.
  // That absence is the point: it is what makes turning mean something.
  function frontVisible(dir) {
    return dir.axis === 'x'
      ? (dir.sign > 0) === E.fv.xVisible
      : (dir.sign > 0) === E.fv.yVisible;
  }

  G.update = (dt) => {
    // Timers count DOWN against dt, never against clock.time deltas:
    // dt is capped at 50ms and is exactly 0 during hit-stop, so he
    // holds his breath with the rest of the world on an impact frame.

    // A save can occupy his authored start tile before his first frame;
    // relocate silently rather than materialising inside a block.
    if (!S.booted) {
      S.booted = true;
      S.upFor = rollUp();
      if (!tileFree(S.gx, S.gy)) {
        S.state = 'hidden';
        S.scale = 0;
        S.t = 0.3;
      }
    }

    switch (S.state) {
      case 'up': {
        // A block claiming his tile outranks every timer — the yellow-
        // cube-through-the-ears bug from the designer's screenshot.
        // (It outranks the chat pin too: world rules always win. The
        // panel stays open and he talks from the burrow.)
        if (!tileFree(S.gx, S.gy)) { startDuck(); break; }
        // The look he gave a block that just landed near him. ONE beat:
        // he holds it, then turns back to the visitor. Not a performance.
        if (S.lookT > 0) {
          S.lookT -= dt;
          if (S.lookT <= 0) S.facing = faceCamera();
        }
        if (S.startleT > 0) S.startleT = Math.max(0, S.startleT - dt);
        // While the chat panel is open he stays put — you don't walk
        // away mid-conversation. The timer resumes fresh on close.
        if (!S.chatHold) {
          S.upFor -= dt;
          if (S.upFor <= 0) startDuck();
        }
        break;
      }
      case 'ducking': {
        S.t -= dt;
        const T = E.reducedMotion ? 0.22 : RHYTHM.duckT;
        S.scale = Math.max(0, S.t / T);
        if (S.t <= 0) {
          S.scale = 0;
          S.state = 'hidden';
          S.t = E.reducedMotion ? 0.3 : RHYTHM.holePause;
        }
        break;
      }
      case 'hidden': {
        S.t -= dt;
        if (S.t > 0) break;
        const target = pickTarget();
        if (!target) { S.t = 1.5; break; } // board is FULL: stay under, retry
        S.tx = target.gx; S.ty = target.gy;
        if (E.reducedMotion) {
          // No travelling slide under reduced motion: the disturbed
          // trail is stamped whole and sinks in place — the record of
          // the journey without the journey.
          layTrail(S.px, S.py, S.tx, S.ty);
          S.px = S.tx; S.py = S.ty;
          beginSurface();
        } else {
          beginTravel();
        }
        break;
      }
      case 'travelling': {
        if (E.reducedMotion) { // flipped mid-slide: finish without motion
          layTrail(S.px, S.py, S.tx, S.ty);
          S.px = S.tx; S.py = S.ty;
          beginSurface();
          break;
        }
        if (!tileFree(S.tx, S.ty)) { S.state = 'hidden'; S.t = 0.2; break; } // stolen mid-trip: repick
        // The pause-and-sniff: every second or three the mound stops
        // dead for a beat. Disproportionately effective — it says a
        // CREATURE is down there making decisions. And sometimes the
        // decision is a CHANGE OF MIND: the sniff ends with a new
        // heading picked from where he is now, so journeys bend at
        // the exact moment that already reads as him thinking.
        if (S.sniffT > 0) {
          S.sniffT -= dt;
          S.churn += dt * 5.0; // the pile keeps breathing while he thinks
          if (S.sniffT <= 0 && S.turnsLeft > 0 && Math.random() < RHYTHM.turnChance) {
            const turn = pickTarget(); // anchored at his CURRENT position
            if (turn) {
              S.turnsLeft--;
              S.tx = turn.gx; S.ty = turn.gy;
              S.facing = faceTravel(S.tx - S.px, S.ty - S.py);
              // The pre-rotated pile snaps 90° with the new heading —
              // a puff of dirt at that exact frame is what masks the
              // snap (the oldest trick there is).
              if (VH.fx) {
                VH.fx.spawnSoil(S.px + 0.5, S.py + 0.5, 0.2, 5,
                  { cone: 80, up: 1.2, out: 0.9, fine: true, life: 0.35, lifeSpan: 0.2, rest: 0.15 });
              }
            }
          }
          break;
        }
        S.sniffIn -= dt;
        const dx = S.tx - S.px, dy = S.ty - S.py;
        const dist = Math.hypot(dx, dy);
        if (S.sniffIn <= 0 && dist > 1.2) {
          S.sniffT = RHYTHM.sniffT;
          S.sniffIn = RHYTHM.sniffMin + Math.random() * RHYTHM.sniffSpan;
          // He stops, and the pile shrugs off a little dirt — the
          // settle that keeps a paused mound from reading as dead.
          if (VH.fx) {
            VH.fx.spawnSoil(S.px + 0.5, S.py + 0.5, 0.18, 3,
              { cone: 85, up: 0.7, out: 0.4, fine: true, life: 0.3, lifeSpan: 0.2, rest: 0.12 });
          }
          break;
        }
        // Surging gait, keyed to DISTANCE dug (not clock time, so it is
        // frame-rate safe and freezes with hit-stop): real burrowers
        // surge; a constant velocity is the core of the "sliding tile".
        const surge = 1 + RHYTHM.surge * Math.sin(S.travelled * RHYTHM.surgeFreq);
        const step = RHYTHM.speed * surge * dt;
        if (dist <= step || dist < 1e-6) {
          S.px = S.tx; S.py = S.ty;
          beginSurface();
        } else {
          S.dirX = dx / dist; S.dirY = dy / dist;
          S.px += S.dirX * step;
          S.py += S.dirY * step;
          S.travelled += step;
          S.churn += step * RHYTHM.churnFreq; // phase-locked to the dig
          // Trail segments spawn by DISTANCE — time-based spawning
          // clumps when slow and gaps when fast
          if (S.travelled >= S.trailAt) {
            S.trailAt += RHYTHM.trailStep;
            dropTrailSegment(
              S.px - S.dirX * 0.35, S.py - S.dirY * 0.35,
              Math.sin(S.travelled * 6) * 0.09);
          }
          // Fine crumbs shed off the LIP as he ploughs — "dirt falling
          // off the top of it", the designer's exact note. Launched so
          // low they never clear the crest (their apex is ~1.5px), so
          // drawing them unsorted over the world can't misread. They
          // brake to rest in ~0.15s while the mound advances at 2.4
          // tiles/s, so being left behind on the rear slope is free.
          // Paw scuffs by DISTANCE, like the trail and the crumbs —
          // time-based cadence clumps at surge troughs and machine-guns
          // at peaks. The sound follows the mound's position.
          if (S.travelled >= S.stepAt && VH.sfx && VH.sfx.goferStep) {
            S.stepAt += RHYTHM.stepEvery;
            VH.sfx.goferStep({ gx: S.px, gy: S.py });
          }
          if (S.travelled >= S.shedAt && VH.fx) {
            S.shedAt += RHYTHM.shedStep;
            VH.fx.spawnSoil(
              S.px + 0.5 + S.dirX * 0.12, S.py + 0.5 + S.dirY * 0.12, 0.22,
              1 + (Math.random() < 0.35 ? 1 : 0),
              { cone: 78, up: 1.15, out: 0.75, fine: true,
                dx: S.dirX * 0.3, dy: S.dirY * 0.3,
                life: 0.3, lifeSpan: 0.22, rest: 0.12 });
          }
        }
        break;
      }
      case 'anticipating': {
        // Underground guard, travelling-style: he is invisible, so a
        // stolen tile means repick, never a duck animation from scale 0.
        if (!tileFree(S.gx, S.gy)) { S.state = 'hidden'; S.t = 0.2; break; }
        S.t -= dt;
        // Shake computed here in the update path (never in the draw —
        // Math.random in the render path would shimmer under hit-stop)
        S.jx = (Math.random() - 0.5) * 0.04;
        S.jy = (Math.random() - 0.5) * 0.04;
        if (S.t <= 0) {
          S.jx = 0; S.jy = 0;
          // DIRT FIRST, always: the burst fires on this transition and
          // the head follows eruptLead later. If the head leads, the
          // dirt reads as an afterthought.
          if (VH.fx) {
            VH.fx.spawnSoil(S.px + 0.5, S.py + 0.5, 0.05, 18,
              { cone: 42, up: 4.6, out: 3.2, dx: S.dirX * 0.8, dy: S.dirY * 0.8 });
          }
          // The pop rides the DIRT, not the head — same dirt-first rule
          // the eruption's visuals follow.
          if (VH.sfx && VH.sfx.goferPop) VH.sfx.goferPop({ gx: S.px, gy: S.py });
          S.state = 'surfacing';
          S.t = RHYTHM.surfaceT + RHYTHM.eruptLead;
        }
        break;
      }
      case 'surfacing': {
        if (!tileFree(S.gx, S.gy)) { startDuck(); break; } // sniped mid-pop
        S.t -= dt;
        const T = E.reducedMotion ? 0.25 : RHYTHM.surfaceT;
        const L = E.reducedMotion ? 0 : RHYTHM.eruptLead;
        // Scale pinned at 0 through the lead, so thrown dirt is airborne
        // before the head exists. Linear under reduced motion (backOut
        // overshoot is a bounce — motion for motion's sake).
        const p = Math.min(1, Math.max(0, ((T + L) - S.t - L) / T));
        S.scale = E.reducedMotion ? p : backOut(p);
        if (S.t <= 0) {
          S.scale = 1;
          S.state = 'up';
          S.upFor = rollUp();
        }
        break;
      }
    }

    // What the visitor built stops being "recent" on its own, so he
    // never haunts a corner they abandoned. Counts down against dt like
    // every other timer here, so it freezes with hit-stop too.
    for (let i = recent.length - 1; i >= 0; i--) {
      recent[i].age -= dt;
      if (recent[i].age <= 0) recent.splice(i, 1);
    }

    // Trail settles regardless of state — old segments keep sinking
    // while he stands at the far end of them
    for (let i = 0; i < TRAIL_MAX; i++) {
      const s = trail[i];
      if (s.live) { s.age += dt; if (s.age >= s.life) s.live = false; }
    }

    // Blink — only while there is a face on screen to blink with.
    // Survives reduced motion deliberately: that setting is about
    // vestibular motion — big travel, parallax, zoom — and a one-pixel
    // eyelid is none of those. Killing it would leave a staring animal.
    if (S.state === 'up') {
      if (S.blinkShut > 0) {
        S.blinkShut -= dt;
        if (S.blinkShut <= 0) {
          S.blinkShut = 0;
          S.blinkIn = S.blinkQueue > 0 ? BLINK_GAP : nextBlink();
        }
      } else {
        S.blinkIn -= dt;
        if (S.blinkIn <= 0) {
          S.blinkShut = BLINK_SHUT;
          // Roll for a double only on the FIRST half, or he could stutter
          // indefinitely: the queued half consumes, it never re-rolls.
          if (S.blinkQueue > 0) S.blinkQueue--;
          else if (Math.random() < DOUBLE_CHANCE) S.blinkQueue = 1;
        }
      }
    }
  };

  // Stamp pixel-quad groups onto one FIXED world side of a box — the
  // SIGN_MARKS geometry (world.js), minus its column flip, because
  // this is paint on his front, not a wordmark that must read forward
  // from either side. Caller has already checked the side is visible.
  function stampFace(gx, gy, gz, sxy, sy, sz, dir, groups) {
    const ctx = E.ctx;
    const fv = E.fv;
    const ref = E.toScreen(gx + (1 - sxy) / 2, gy + (1 - sy) / 2, gz);
    const ux = { x: fv.ux.x * sxy, y: fv.ux.y * sxy };
    const uy = { x: fv.uy.x * sy, y: fv.uy.y * sy };
    const uz = { x: fv.uz.x * sz, y: fv.uz.y * sz };
    let o, A;
    if (dir.axis === 'x') {
      o = fv.xVisible ? { x: ref.x + ux.x, y: ref.y + ux.y } : ref;
      A = uy;
    } else {
      o = fv.yVisible ? { x: ref.x + uy.x, y: ref.y + uy.y } : ref;
      A = ux;
    }
    for (const g of groups) {
      ctx.beginPath();
      for (const [u, v, du, dv] of g.px) {
        const px = o.x + A.x * u + uz.x * v, py = o.y + A.y * u + uz.y * v;
        ctx.moveTo(px, py);
        ctx.lineTo(px + A.x * du, py + A.y * du);
        ctx.lineTo(px + A.x * du + uz.x * dv, py + A.y * du + uz.y * dv);
        ctx.lineTo(px + uz.x * dv, py + uz.y * dv);
        ctx.closePath();
      }
      ctx.globalAlpha = 0.95;
      ctx.fillStyle = g.ink;
      ctx.fill();
    }
    ctx.globalAlpha = 1;
  }

  // ── Pre-rotated geometry, built ONCE ────────────────────────
  // rot() allocates a tuple per call and the draw path runs per piece
  // per frame — the monuments solved the same problem by precomputing
  // piece geometry at instantiate. Four variants per table (one per
  // heading), offsets rotated and footprint axes pre-swapped, so the
  // hot path is lookups and arithmetic only (review find WR-03).
  function rotTable(table) {
    // Frontness is LOCAL (front = -y before rotation), so it is
    // heading-invariant: compute once from the source rows and copy the
    // same weight onto all four variants. fe = leading extent; the most
    // forward clump gets weight 1, the rear skirt ~0. The ^2.5 curve
    // concentrates motion at the lip; the size damp keeps the big core
    // from heaving. Phase offsets step by the golden angle so no two
    // clumps ever sync up and nothing shimmers (deterministic, no RNG).
    const fes = table.map(c => c[1] - c[4] / 2);
    const feMin = Math.min(...fes), feMax = Math.max(...fes);
    const span = Math.max(1e-6, feMax - feMin);
    const meta = table.map((c, i) => {
      const fn = (feMax - fes[i]) / span; // 1 = most forward
      return {
        f: fn,
        w: Math.pow(fn, 2.5) * Math.min(1, 0.16 / Math.max(c[3], c[4], c[5])),
        ph: i * 2.399963,
      };
    });
    const out = [];
    for (let k = 0; k < 4; k++) {
      const odd = (k & 1) === 1;
      out.push(table.map((c, i) => {
        const [rx, ry] = rot(c[0], c[1], k);
        return { dx: rx, dy: ry, z: c[2],
                 sx: odd ? c[4] : c[3], sy: odd ? c[3] : c[4],
                 sz: c[5], col: c[6], tag: c[7] || '',
                 f: meta[i].f, w: meta[i].w, ph: meta[i].ph };
      }));
    }
    return out;
  }
  // His local FRONT and LEFT as world axes, per heading — precomputed
  // so the churn's fore/aft and lateral offsets rotate with two
  // multiplies and no allocation. (FWD[k] = rot(0,-1,k), LEFT[k] =
  // rot(-1,0,k), verified against the rot() convention.)
  const FWD = [[0, -1], [-1, 0], [0, 1], [1, 0]];
  const LEFT = [[-1, 0], [0, 1], [1, 0], [0, -1]];
  const R_MODEL = rotTable(MODEL);
  const R_ACTIVE = rotTable(MOUND_ACTIVE);
  const R_CRATER = rotTable(MOUND_CRATER);
  const R_SNOUT = rotTable([[0, -SNOUT.protrude, SNOUT.z, SNOUT.across, SNOUT.thick, SNOUT.sz, 'goferFur', 'snout']]);

  // ── His drawn body, ONE source of truth ─────────────────────
  // Body pieces + snout at his current heading and scale. Both the
  // depth entries and the hit test read this, so the tap region can
  // never drift from the pixels — this codebase's classic bug, and the
  // reason the plan asked for the hit test to share the draw geometry
  // rather than approximate it in screen space.
  //
  // Pieces scale toward the tile centre at the GROUND, so ducking reads
  // as sinking into the dirt rather than a cluster of crumbs shrinking
  // in place. Rotated offsets scale linearly, so the pre-rotated tables
  // serve every scale.
  //
  // Fills a caller-supplied array — two fixed scratch arrays below, so
  // the draw path and the (per-mousemove) hit path never allocate and
  // never share a buffer.
  function bodyBoxes(out) {
    const k = S.scale;
    // The startle when something lands beside him: a single quick hop,
    // UPWARD only (there is no depth buffer — see the trail's note), so
    // it can never paint over the platform bitmap. It rides here rather
    // than in the draw so the sort keys and the tap region move with the
    // pixels instead of drifting behind them.
    const hop = S.startleT > 0
      ? NOTICE.startleH * Math.sin(Math.PI * (1 - S.startleT / NOTICE.startleT)) : 0;
    out.length = 0;
    for (const p of R_MODEL[S.facing]) {
      out.push({ gx: S.px + p.dx * k, gy: S.py + p.dy * k, gz: p.z * k + hop,
                 sxy: p.sx * k, sy: p.sy * k, sz: p.sz * k, col: p.col, tag: p.tag });
    }
    // The snout — butted against his OWN front, so it stays put as the
    // camera turns. It only ever moves when he does.
    const sn = R_SNOUT[S.facing][0];
    out.push({ gx: S.px + sn.dx * k, gy: S.py + sn.dy * k, gz: sn.z * k + hop,
               sxy: sn.sx * k, sy: sn.sy * k, sz: sn.sz * k, col: 'goferFur', tag: 'snout' });
    return out;
  }
  const drawBoxes = [];
  const hitBoxes = [];

  // A mound clump placed at his heading — NO body scale: the thrown
  // earth never shrinks with him.
  //
  // `churn` is the working, crumbling motion of the pile, weighted by
  // each clump's frontness so the LEADING lip churns hard while the
  // trailing peak barely stirs. Three channels per clump plus a height
  // cycle — and two of them are a quarter-cycle apart, so each clump
  // traces a small ELLIPSE (a tumble), not a line (a bounce). The
  // phase LAGS with frontness, so material appears to well up at the
  // back and break at the front — the read of a travelling wave with
  // none of the caterpillar-track transport a real roll would show at
  // this size.
  //
  // The vertical lift is UPWARD-ONLY, and that is load-bearing: there
  // is no depth buffer, so a clump pushed below the surface paints a
  // dirt wall OVER the platform bitmap (the trail's documented trap).
  // The "falling" half of the cycle is carried by the sz squash —
  // which is also truer: material lifts off a crest, it doesn't sink
  // into one. The sort box carries every churn offset (computed here,
  // read by the closure) so the key can never drift from the pixels.
  function pushMound(entries, dip, rtable, bob, swell, jx, jy, churn, lean) {
    const table = rtable[S.facing];
    const fwd = FWD[S.facing], lft = LEFT[S.facing];
    const leanX = fwd[0] * lean, leanY = fwd[1] * lean;
    for (const c of table) {
      let gx = S.px + c.dx + jx + leanX, gy = S.py + c.dy + jy + leanY;
      let gz = c.z + bob, sz = c.sz * swell;
      if (churn > 0) {
        const p = S.churn - c.f * 2.6 + c.ph;
        const a = churn * c.w;
        const fore = a * 0.035 * Math.cos(p);
        const lat = a * 0.018 * Math.sin(1.618 * p);
        gx += fwd[0] * fore + lft[0] * lat;
        gy += fwd[1] * fore + lft[1] * lat;
        gz += a * 0.045 * (0.5 + 0.5 * Math.sin(p));
        sz *= 1 + a * 0.16 * Math.sin(p);
      }
      const sxy = c.sx, sy = c.sy;
      entries.push({
        gx, gy, gz, sxy, sy, sz,
        // No contact bands, and every dimension is under STROKE_MIN so
        // no outline: both are the exact marks that render a box as a
        // TILE, and both are order-sensitive where clumps overlap.
        draw: () => W.drawBlock(gx, gy, gz - dip, c.col, 1,
          { styled: true, sxy, sy, sz }),
      });
    }
  }

  function pushTrail(entries, dip) {
    for (let i = 0; i < TRAIL_MAX; i++) {
      const s = trail[i];
      if (!s.live) continue;
      const t = s.age / s.life;
      // Sink: the top decays to the turf (fast settle, long tail) while
      // the base stays pinned just below it — never translate downward.
      const h = s.h0 * Math.pow(1 - t, 1.8);
      if (h < 0.02) continue;
      const shrink = 1 - 0.15 * t; // the tail must not flatten into a diamond
      const sx = s.sx * shrink, sy = s.sy * shrink;
      entries.push({
        // The sort box is INFLATED to the crumbs' union (offsets reach
        // ±0.25 from centre) — a box that covers only the main segment
        // lets an adjacent block sort behind pixels the crumbs paint
        // in front of it (review find WR-04, this codebase's classic
        // sort-key-vs-pixels drift).
        gx: s.gx, gy: s.gy, gz: -0.03, sxy: Math.max(sx, 0.5), sy: Math.max(sy, 0.5), sz: h + 0.03,
        draw: () => {
          W.drawBlock(s.gx, s.gy, -0.03 - dip, s.col, 1,
            { styled: true, sxy: sx, sy, sz: h + 0.03 });
          // Crumbs ride the segment's own closure: same colour family,
          // sub-stroke, so paint order against their segment is invisible
          W.drawBlock(s.gx + s.c1x, s.gy + s.c1y, -0.02 - dip, s.col, 1,
            { styled: true, sxy: s.c1s, sy: s.c1s, sz: h * 0.5 + 0.02 });
          W.drawBlock(s.gx + s.c2x, s.gy + s.c2y, -0.02 - dip, 'soil1', 1,
            { styled: true, sxy: s.c2s, sy: s.c2s, sz: h * 0.35 + 0.02 });
        },
      });
    }
  }

  // ── Depth-sorted entries — one per box, like the monuments ──
  G.pushEntries = (entries, dip) => {
    // The trail draws in EVERY state — it keeps sinking behind him
    // after he has popped up at the far end of it.
    pushTrail(entries, dip);

    const under = S.state === 'hidden' || S.state === 'travelling' ||
                  S.state === 'anticipating';
    if (under || S.scale <= 0.01) {
      // The travelling pile: bobbing with the dig, breathing through a
      // sniff, shaking through the pre-eruption beat — and CHURNING at
      // the leading edge, which is what stops it reading as a brick.
      const travelling = S.state === 'travelling';
      const anticipating = S.state === 'anticipating';
      const bob = (travelling && S.sniffT <= 0)
        ? RHYTHM.bob * Math.sin(S.travelled * RHYTHM.bobFreq) : 0;
      // Sniff swell EASES in and out (a half-sine over the pause) — the
      // old step to 1.12 was a visible pop-and-unpop on a still pile.
      const swell = anticipating
        ? 1 + 0.15 * (1 - S.t / RHYTHM.anticipateT)
        : (S.sniffT > 0
          ? 1 + 0.12 * Math.sin(Math.PI * Math.max(0, 1 - S.sniffT / RHYTHM.sniffT))
          : 1);
      // Churn amplitude: full while digging, settling to 45% across a
      // sniff, zero while anticipating (the shake owns that beat) and
      // zero under reduced motion. The crater never churns.
      const churn = (travelling && !E.reducedMotion)
        ? RHYTHM.churnAmp * (S.sniffT > 0
          ? 0.45 + 0.55 * (S.sniffT / RHYTHM.sniffT) : 1)
        : 0;
      // Surge lean: the pile leans into acceleration and piles forward
      // on deceleration — the "something is PUSHING this" cue. Rides
      // the surge's own phase (cos is the derivative of its sin).
      const lean = (travelling && S.sniffT <= 0 && !E.reducedMotion)
        ? -0.035 * Math.cos(S.travelled * RHYTHM.surgeFreq) : 0;
      pushMound(entries, dip, R_ACTIVE, bob, swell,
        anticipating ? S.jx : 0, anticipating ? S.jy : 0, churn, lean);
      return;
    }

    // Standing (or mid duck/pop): the crater he threw, and the body
    pushMound(entries, dip, R_CRATER, 0, 1, 0, 0, 0, 0);

    const dir = frontDir();
    // Face pixels vanish below ~half size: at a sub-pixel scale they
    // smear into noise, and mid-duck nobody is reading an expression.
    const showFace = frontVisible(dir) && S.scale > 0.5;

    for (const p of bodyBoxes(drawBoxes)) {
      const { gx, gy, gz, sxy, sy, sz, col, tag } = p;
      const marks = tag === 'head'
        ? [{ px: S.blinkShut > 0 ? EYES_SHUT : EYES, ink: INK_DARK }]
        : (tag === 'snout'
          ? [{ px: NOSE, ink: INK_DARK }, { px: TEETH, ink: INK_TOOTH }]
          : null);
      entries.push({
        gx, gy, gz, sxy, sy, sz,
        draw: () => {
          W.drawBlock(gx, gy, gz - dip, col, 1, { styled: true, sxy, sy, sz });
          if (marks && showFace) stampFace(gx, gy, gz - dip, sxy, sy, sz, dir, marks);
        },
      });
    }
  };

  // ── The entrance cameo ──────────────────────────────────────
  // The island's two towers are PAST TENSE — buildings Viet worked in,
  // with end dates. Two monuments to jobs he no longer has is a
  // graveyard. He is the present tense, and the opening is where the
  // visitor learns he exists at all, while they are already watching.
  //
  // The mound crosses the new grass FIRST and erupts at the end of it:
  // something moves under the island, stops, and becomes a creature.
  // That is his whole meaning — digging is searching, surfacing is
  // "found something" — told in about two seconds, before anyone has
  // been asked to care. A bare pop-in would say none of it.

  // A free tile roughly minD..maxD tiles from (gx, gy). Used for both
  // ends of the cameo's short journey.
  function freeTileNear(gx, gy, minD, maxD) {
    for (let tries = 0; tries < 80; tries++) {
      const a = Math.random() * Math.PI * 2;
      const d = minD + Math.random() * (maxD - minD);
      const tx = Math.round(gx + Math.cos(a) * d);
      const ty = Math.round(gy + Math.sin(a) * d);
      if (tileFree(tx, ty)) return { gx: tx, gy: ty };
    }
    return null;
  }

  // Called at the top of runEntrance. Without it he is standing in the
  // middle of the opening wave from frame one — which spoils the reveal
  // AND gets him buried by a falling block inside a second.
  G.hideForEntrance = () => {
    S.state = 'hidden';
    S.scale = 0;
    S.booted = true;   // skip the boot relocate: we are placing him
    // He is waiting for the cameo call, not for this timer. It exists
    // only so a cameo that finds no free ground can't strand him under
    // the island forever — he simply resumes his own loop instead.
    S.t = 20;
  };

  // Surface once, near (gx, gy) — the entrance passes the hero block's
  // tile, because that is where the visitor's eye already is.
  G.cameo = (gx, gy) => {
    const dest = freeTileNear(gx, gy, 1.2, 2.6);
    if (!dest) return;                       // no room: he keeps waiting
    const start = freeTileNear(dest.gx, dest.gy, 3.0, 4.2);
    if (!start) return;
    S.gx = start.gx; S.gy = start.gy;
    S.px = start.gx; S.py = start.gy;
    S.tx = dest.gx;  S.ty = dest.gy;
    S.scale = 0;
    if (E.reducedMotion) {
      layTrail(S.px, S.py, S.tx, S.ty);
      S.px = S.tx; S.py = S.ty;
      beginSurface();
    } else {
      beginTravel();
    }
  };

  // ── The tap ─────────────────────────────────────────────────
  // Only while he is STANDING. Underground or mid-duck he is not a
  // target at all and the tap passes straight through to place a block
  // — he never competes with the core loop.
  //
  // Returns his drawn boxes and lets game.js do the quad walk, exactly
  // as hitTestMonument consumes monuments.orderedModel: the geometry
  // lives with the character, the screen-space test lives with input.
  // Order is irrelevant here (any piece hit means "the gofer"), so
  // there is no front-to-back sort to keep in step.
  //
  // The CRATER is deliberately NOT tappable. It is spoil he threw, not
  // him, and it reaches ±0.35 tiles — including it would swallow taps
  // aimed at the grass beside him for a target only ~0.12 tiles tall.
  G.hitBoxes = () => (S.state === 'up' ? bodyBoxes(hitBoxes) : null);

  // ── The conversation (Abe's side of it) ─────────────────────
  // The chat panel talks to him through these three calls; everything
  // it needs from him is a beat he already knows how to do.

  // The panel opened: he meets the visitor's eye and stays put. The
  // pin is a flag, not a frozen timer — world rules (a block landing
  // on his tile) still outrank it, and startDuck ignores it entirely.
  G.chatOpen = () => {
    S.chatHold = true;
    if (S.state === 'up') {
      S.facing = faceCamera();
      S.blinkIn = 0.001; S.blinkShut = 0; // a blink as he turns to you
    }
  };

  // The panel closed: fresh standing timer, so he never digs off the
  // instant the conversation ends — he lingers, then goes.
  G.chatClose = () => {
    S.chatHold = false;
    if (S.state === 'up') S.upFor = rollUp();
  };

  // A reply arrived: the noticePlacement beat MINUS the turn — he
  // keeps facing the visitor and does the little "found something"
  // hop + blink. The hop rides bodyBoxes' startleT automatically.
  G.chatReact = () => {
    if (S.state !== 'up') return;
    S.startleT = NOTICE.startleT;
    S.blinkIn = 0.001; S.blinkShut = 0;
  };

  // Where he stands on screen (chest height) — the touch-slop circle
  // in game.js is centred here so a fat finger near him still counts.
  G.tapAnchor = () =>
    (S.state === 'up' ? E.toScreen(S.px + 0.5, S.py + 0.5, 0.6 * S.scale) : null);

  // Surfaced (and mid-duck/pop, scaled) casts ONE shadow; the
  // travelling mound casts none — a mound with a cast shadow reads as
  // sitting ON the grass, not moving under it.
  G.pushShadow = (dip, heightFade) => {
    if (S.state === 'hidden' || S.state === 'travelling' || S.scale <= 0.01) return;
    const k = S.scale;
    const odd = (S.facing & 1) === 1; // his footprint turns with him
    const h = HEIGHT * k;
    E.addShadowBox(S.px, S.py, 0.09 * k, (odd ? 0.46 : 0.60) * k, h - 0.09 * k,
      heightFade(h) * k, dip, (odd ? 0.60 : 0.46) * k);
  };

  // ── Dev hooks (#dev only, inert for visitors) ───────────────
  if (location.hash === '#dev') {
    document.addEventListener('vh-dev-gofer', (e) => {
      const d = e.detail || {};
      if (typeof d.gx === 'number') { S.gx = d.gx; S.px = d.gx; S.tx = d.gx; }
      if (typeof d.gy === 'number') { S.gy = d.gy; S.py = d.gy; S.ty = d.gy; }
      if (typeof d.facing === 'number') S.facing = d.facing & 3;
      if (d.blink) { S.blinkIn = 0.001; S.blinkShut = 0; S.blinkQueue = d.blink === 2 ? 1 : 0; }
      if (d.dig) S.upFor = 0.001; // force a relocation now
      // {up:1} surfaces him HERE immediately — the only way to test the
      // tap without racing his 9–18s standing timer. {hold:n} then pins
      // him up for n seconds (default 600) so a hit test can't expire
      // halfway through.
      if (d.up) {
        S.tx = S.gx; S.ty = S.gy; S.px = S.gx; S.py = S.gy;
        S.scale = 1; S.state = 'up'; S.upFor = rollUp();
      }
      if (typeof d.hold === 'number' || d.hold) S.upFor = (+d.hold || 600);
      console.log('[dev-gofer]', JSON.stringify(
        { state: S.state, gx: S.gx, gy: S.gy, px: +S.px.toFixed(2), py: +S.py.toFixed(2),
          tx: S.tx, ty: S.ty, turns: S.turnsLeft,
          facing: S.facing, scale: +S.scale.toFixed(2), upFor: +S.upFor.toFixed(1),
          shut: +(S.blinkShut > 0), look: +S.lookT.toFixed(2),
          recent: recent.map(r => r.gx + ',' + r.gy) }));
    });

    // Disjointness self-check — the same rule tools/check-disjoint.js
    // enforces on monument models, run here because the gofer is not a
    // recipe. Runs at ALL FOUR headings: a quarter turn swaps footprint
    // axes, so a pair that clears at one heading can collide at another.
    // Covers the body + snout + CRATER (they coexist while he stands).
    // MOUND_ACTIVE is deliberately excluded: its clumps overlap by
    // design — same-colour unstroked boxes have no visible paint order,
    // and they never coexist with the body (disjointness per state).
    for (let k = 0; k < 4; k++) {
      const boxes = [];
      const collect = (rtable, prefix) => rtable[k].forEach((p, i) =>
        boxes.push({ tag: (p.tag || prefix + i),
          box: E.pieceAABB(S.px + p.dx, S.py + p.dy, p.z, p.sx, p.sz, p.sy) }));
      collect(R_MODEL, 'body');
      collect(R_SNOUT, 'snout');
      collect(R_CRATER, 'crater');
      for (let a = 0; a < boxes.length; a++) {
        for (let b = a + 1; b < boxes.length; b++) {
          // 1e-6 forgives butt-joint float noise; real interpenetration is ≥0.005
          if (E.aabbOverlap(boxes[a].box, boxes[b].box, 1e-6)) {
            console.warn('[dev-gofer] PIECE OVERLAP at facing', k,
              boxes[a].tag, '<>', boxes[b].tag);
          }
        }
      }
    }
    // STROKE_MIN guardrail: every travelling-mound clump, at the WORST
    // combination of sniff swell (×1.12) and churn height cycle
    // (×1.16), must stay under 0.35 — at that threshold drawBlock
    // strokes the outline that made the original rejected version read
    // as a sliding tile. This is how that can never come back silently.
    MOUND_ACTIVE.forEach((c, i) => {
      const worst = Math.max(c[3], c[4], c[5] * 1.12 * 1.16);
      if (worst >= 0.35) {
        console.warn('[dev-gofer] MOUND CLUMP', i, 'CAN REACH STROKE_MIN:',
          +worst.toFixed(3), '— it will draw the tile outline');
      }
    });
    console.log('[dev-gofer] piece self-check done (4 headings)');
  }
})();
