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
  // Model entries: [dx, dy, dz, footprint, sz, colorKey, glow?, sign?,
  // win?, mark?] — footprint is [sx, sy] (rectangular; a plain number
  // means square, and a quarter turn swaps the axes at instantiate).
  // mark is a face PATTERN drawBlock paints ('lattice', 'mullion',
  // 'windows', 'arcade', 'terrace', and the axis-carrying 'gateX'/'gateY',
  // 'terraceX'/'terraceY' — a trailing X/Y is an axis in MODEL space and
  // instantiate swaps it on odd quarter turns).
  // Fractional dx/dy shift the cube center off-cell; fractional dz
  // stacks partial cubes. sign NAMES the pixel wordmark a plate carries
  // (a key into world.js SIGN_MARKS); win is a PARAPET HEIGHT in cells —
  // truthy means "draw the curtain-wall window grid on this piece,
  // stopping that far below its top". Both ride the recipe, not the
  // save, so reinstantiate restores them.
  //
  // ⚠ Pieces must be pairwise DISJOINT (touching faces are fine). Two
  // boxes that INTERPENETRATE have no valid painter's order: whichever
  // draws later shows BOTH its ends, so a detail buried in a parent and
  // poking out both faces reads correctly from the front and floats ON
  // TOP of the parent from the back (the 2026-08 arc/greatwall glitch).
  // Mount details ON a face, one piece per side (the doghouse-door
  // pattern), split through-beams into their visible segments, and butt
  // ring walls instead of overlapping their corners — corner overlap is
  // also what created genuine sort cycles (colosseum, eiffel). Details
  // must still protrude ≥0.05 or the sorter will hide them.
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
      // Giza: stepped limestone courses (per-course tonal jitter comes
      // free from the shade channel), a dark entrance notch, and the
      // gilded pyramidion — real pyramidions were gold-sheathed.
      model: [
        [1, 1, 0,    [3.0, 3.0],   0.34, 'stone'],
        [1, 1, 0.34, [2.64, 2.64], 0.32, 'stone'],
        [1, 1, 0.66, [2.28, 2.28], 0.31, 'stone'],
        [1, 1, 0.97, [1.9, 1.9],   0.3,  'stone'],
        [1, 1, 1.27, [1.5, 1.5],   0.28, 'stone'],
        [1, 1, 1.55, [1.1, 1.1],   0.26, 'stone'],
        [1, 1, 1.81, [0.7, 0.7],   0.24, 'stone'],
        [1, 1, 2.05, [0.36, 0.36], 0.2,  'stone'],
        [1, -0.53, 0.12, [0.44, 0.06], 0.42, 'stoneDark'], // entrance notch (face plate)
        [1, 1, 2.25, [0.3, 0.3],   0.28, 'gold', true],  // pyramidion
      ],
    },
    {
      id: 'torii',
      name: 'The Torii Gate',
      hint: 'a red wall, three across and three high',
      cells: [
        [0, 0, 0, 'red'], [1, 0, 0, 'red'], [2, 0, 0, 'red'],
        [0, 0, 1, 'red'], [1, 0, 1, 'red'], [2, 0, 1, 'red'],
        [0, 0, 2, 'red'], [1, 0, 2, 'red'], [2, 0, 2, 'red'],
      ],
      // The transform CARVES the passage the player couldn't build.
      // Myōjin torii (Itsukushima colours): vermilion columns on black
      // nemaki bases; the nuki tie-beam passes THROUGH the columns and
      // protrudes past them; the top is the black kasagi (only the
      // columns are red on the real gate) roofed in copper, with raised
      // end blocks suggesting the upturned tips. Rect footprints
      // throughout — the old square lintel rendered as a table top.
      // 2026-08-27 mass pass: the gate returned 22% of the volume its nine
      // cubes held and read as smaller than the wall it replaced. Members
      // thickened per the value of the REAL gate's proportions — columns
      // 0.42→0.68, lintels deepened — with every joint re-butted to the
      // new column faces (inner faces now at 0.84 / 2.16) and no piece's
      // spill grown past what the guard already knows. Nuki stays 0.26
      // tall: its top must keep butting the gakuzuka at z 1.71.
      model: [
        [0, 0, 0,    [0.8, 0.8],   0.14, 'kasagiBlack'],  // nemaki L
        [2, 0, 0,    [0.8, 0.8],   0.14, 'kasagiBlack'],  // nemaki R
        [0, 0, 0.14, [0.68, 0.68], 1.89, 'vermilion'],    // column L (tucks under the shimaki)
        [2, 0, 0.14, [0.68, 0.68], 1.89, 'vermilion'],    // column R
        // Nuki tie-beam in its VISIBLE segments (the parts inside the
        // columns are never seen; a through-beam has no paint order)
        [-0.42, 0, 1.45, [0.16, 0.44], 0.26, 'vermilion'], // nuki, protruding end L (flush with the footprint edge, like before)
        [1, 0, 1.45, [1.32, 0.44],  0.26, 'vermilion'],    // nuki, span between columns
        [2.42, 0, 1.45, [0.16, 0.44], 0.26, 'vermilion'],  // nuki, protruding end R
        [1, 0, 1.71, [0.42, 0.42], 0.32, 'vermilion'],    // gakuzuka strut
        [1, -0.24, 1.78, [0.26, 0.06], 0.22, 'gold'],     // shrine plaque, front face
        [1, 0, 2.03, [3.2, 0.56],  0.3,  'vermilion'],    // shimaki (columns end here)
        [1, 0, 2.33, [3.5, 0.64],  0.26, 'kasagiBlack'],  // kasagi
        [1, 0, 2.59, [3.54, 0.68], 0.1,  'copper'],       // copper roof plates
        [-0.55, 0, 2.69, [0.4, 0.62], 0.3, 'kasagiBlack'], // upturned tip L (rises above the roofline)
        [2.55, 0, 2.69, [0.4, 0.62], 0.3, 'kasagiBlack'],  // upturned tip R
      ],
    },
    {
      id: 'stonehenge',
      name: 'Stonehenge',
      hint: 'four ancient stones, two high, at the corners of a square',
      cells: [
        [0, 0, 0, '*'], [0, 0, 1, '*'],
        [2, 0, 0, '*'], [2, 0, 1, '*'],
        [0, 2, 0, '*'], [0, 2, 1, '*'],
        [2, 2, 0, '*'], [2, 2, 1, '*'],
      ],
      empty: [[1, 1, 0], [1, 0, 0], [0, 1, 0], [2, 1, 0], [1, 2, 0]],
      // Sarsen grey (not warm limestone): each upright is two stacked,
      // slightly offset stones — quarried, not machined — under true
      // rectangular lintels. Two fallen stones in the middle.
      // 2026-08-27 mass pass: 37% of its eight cubes — sarsens are the
      // heaviest objects their landscape has, and these read as fence
      // posts. Stones widened AND deepened (still each slightly different
      // — quarried, not machined); lintels deepened to match and the
      // y-pair re-butted to the deeper x-pair (butt faces now at y 0.86).
      // The (2,2) upright shifts +0.04 so the pocket stone keeps its
      // exact corner-butt clearances; the big fallen stone grows only
      // away from those butt faces.
      model: [
        [0, 0, 0,      [0.72, 0.68], 0.9,  'sarsenGrey'],
        [0.03, 0, 0.9, [0.66, 0.62], 0.85, 'sarsenGrey'],
        [2, 0, 0,      [0.7, 0.68],  0.92, 'sarsenGrey'],
        [1.97, 0, 0.92,[0.64, 0.6],  0.83, 'sarsenGrey'],
        [0, 2, 0,      [0.71, 0.66], 0.88, 'sarsenGrey'],
        [0.02, 2, 0.88,[0.63, 0.61], 0.85, 'sarsenGrey'],
        [2.04, 2.04, 0,    [0.66, 0.62], 0.95, 'sarsenGrey'],
        [2.04, 2.04, 0.95, [0.6, 0.55],  0.8,  'sarsenGrey'],
        [1, 0, 1.75,   [2.5, 0.72],  0.44, 'sarsenGrey'], // lintel, x-pair
        // y-pair lintel BUTTS the x-pair (they used to cross inside the
        // shared corner post — two boxes through each other)
        // y-pair keeps sz 0.35: at 0.44 its top crossed the z=2 claim
        // threshold (top − SOLID_EPS > 2.0) and newly blocked two tiles —
        // a gameplay change. Unequal lintels also read right: quarried.
        [0, 1.305, 1.73, [0.72, 1.89], 0.35, 'sarsenGrey'],
        [0.95, 1.04, 0, [0.95, 0.62], 0.36, 'sarsenGrey'], // fallen stone
        [1.56, 1.55, 0, [0.27, 0.4], 0.3, 'stoneDark'],   // second, in the pocket between
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
      // Rebuilt (session 21) from the voxel reference as a pixel-art OVAL.
      // The 3x3 box is cut into 12 rows of DY = 0.25 (y -0.5..2.5); each
      // tier is a ring (outer R, inner r) drawn as one or two strips per
      // row, cut to the circle's width at that row and EPS short so rows
      // and tiers touch but never overlap. Every piece is a strip along x
      // and the set splits by axis planes (rows, then tiers, then x = 1),
      // so there is NO painter's cycle at any angle — the old four ring
      // walls pinwheeled at the back angles and needed a split trim band.
      // Zero spill: max R 1.495 and the rows exactly fill the box (no
      // allowlist entry; any overhang fails the guard). The arches are
      // PAINTED ('arcade' mark, world.js drawBlock) — ~100 pieces, no
      // glow; IDLE.colosseum keeps the arena torch. The tall half is the
      // south-east (low y, high x) as before; the rim breaks north-west.
      model: (() => {
        const P = [];
        const box = (x, y, z, sx, sy, sz, color, glow, mark) =>
          P.push(mark ? [x, y, z, [sx, sy], sz, color, !!glow, '', 0, mark]
                      : glow ? [x, y, z, [sx, sy], sz, color, true] : [x, y, z, [sx, sy], sz, color]);
        const EPS = 0.006, DY = 0.25, ROWS = 12;
        // ring(R, r, z0, h, color, mark, keep, split): keep(cx, cy, row) may
        // return false to drop a strip or a number to override its height.
        // split: a row the ring spans whole (the front and back walls) is
        // cut in two at x = 1, TOUCHING (no gap, no visible seam). Needed
        // on every tier that has something beneath it: at the edge-on
        // angles (45°, 135°…) a whole-width strip links a low piece on
        // one side to a high piece on the other by height, and a block
        // column between the two sides closes a painter's cycle — the same
        // pinwheel the old model broke by splitting its string course.
        // Tier 1, the seating and the arena have nothing below them and
        // stay whole. Proven by the rotation sweep, packed: 17 → 0.
        const ring = (R, r, z0, h, color, mark, keep, split) => {
          for (let i = 0; i < ROWS; i++) {
            const yc = -0.5 + i * DY + DY / 2, d = yc - 1;
            const xo = Math.sqrt(Math.max(0, R * R - d * d));
            if (xo < 0.02) continue;
            const xi = Math.sqrt(Math.max(0, r * r - d * d));
            const spans = xi > 0.02 ? [[1 - xo, 1 - xi], [1 + xi, 1 + xo]]
                        : split ? [[1 - xo, 1], [1, 1 + xo]] : [[1 - xo, 1 + xo]];
            for (const [xa, xb] of spans) {
              const w = xb - xa - (xa === 1 || xb === 1 ? EPS / 2 : EPS);
              if (w < 0.02) continue;
              const cx = xa === 1 ? 1 + w / 2 : xb === 1 ? 1 - w / 2 : (xa + xb) / 2;
              const k = keep ? keep(cx, yc, i) : true;
              if (k === false) continue;
              box(cx, yc, z0, w, DY - EPS, (typeof k === 'number' ? k : h) - EPS, color, false, mark || '');
            }
          }
        };
        const se = (cx, cy) => (cx - 1) - (cy - 1);   // > 0 on the tall south-east half
        const T = 'travertine', D = 'travertineDark';
        ring(1.48, 0.95, 0, 0.52, T, 'arcade');                                  // tier 1, all round
        ring(1.495, 0.95, 0.52, 0.08, D, '', null, true);                          // string course
        ring(1.44, 0.95, 0.60, 0.48, T, 'arcade',                                 // tier 2, rim broken NW
          (cx, cy, i) => se(cx, cy) < -0.35 ? (i % 2 ? 0.32 : 0.48) : true, true);
        ring(1.40, 0.95, 1.08, 0.44, T, 'arcade', (cx, cy) => se(cx, cy) >= -0.1, true); // tier 3, SE only
        ring(1.36, 0.95, 1.52, 0.28, D, '', (cx, cy) => se(cx, cy) >= 0.35, true);  // attic
        ring(0.95, 0.78, 0, 0.30, D);                                             // upper seating
        ring(0.78, 0.62, 0, 0.16, D);                                             // lower seating
        // The arena is ONE square, not strips: a foreign cell (the heart)
        // is claimed only by a single piece covering >= CLAIM_COVER_MIN of
        // it, and a 0.25 strip covers 0.25. It sits inside r 0.62 (corner
        // radius 0.622 clears the strips, which are cut at row centres)
        // and still splits by planes (y 0.5 / 1.5, then x either side).
        box(1, 1, 0, 0.88, 0.88, 0.10, 'sand');                                    // arena floor, > SOLID_EPS deep so it claims the heart
        return P;
      })(),
    },
    {
      id: 'gardens',
      name: 'The Hanging Gardens',
      hint: 'green growing from two corners of a low terrace',
      cells: [
        [0, 0, 0, '*'], [1, 0, 0, '*'], [0, 1, 0, '*'], [1, 1, 0, '*'],
        [0, 0, 1, 'grass'], [1, 1, 1, 'grass'],
      ],
      // Rebuilt (session 21) from the voxel reference. Four nested stone
      // tiers, each centred inside the one below (so their vertical
      // order is consistent at every angle), with everything else
      // PAINTED on their faces by the 'terrace' mark (world.js drawBlock):
      // lapis tile band, arches, a waterfall down the south face, vines.
      // Built as pieces: 'water' pools where each fall lands, 'grass'
      // hedges on every terrace edge (the colour is the flower signal,
      // and they are the only pieces allowed to overhang — 0.15, under
      // the claim threshold, the same hanging as before), four lamp
      // lanterns on the top hedge corners (real lights, small points),
      // three palms ('palm' crowns so they carry no flowers). The stone
      // never leaves the 2x2 box. No stairs: no room beside the fall.
      model: (() => {
        const P = [];
        const box = (x, y, z, sx, sy, sz, color, glow, mark) =>
          P.push(mark ? [x, y, z, [sx, sy], sz, color, !!glow, '', 0, mark]
                      : glow ? [x, y, z, [sx, sy], sz, color, true] : [x, y, z, [sx, sy], sz, color]);
        const EPS = 0.006, C = 0.5;
        const HD = 0.28, HH = 0.22, GAP = 0.25;  // hedge depth/height (centred 0.01 out: 0.13 hangs over), half of the pool gap
        // tiers: [half-width, z0, z1, colour, mark]
        const TIERS = [
          [1.00, 0,    0.55, 'stone',     'terraceY'],
          [0.75, 0.55, 1.05, 'stoneDark', 'terraceY'],
          [0.50, 1.05, 1.50, 'stone',     'terraceY'],
          [0.25, 1.50, 1.85, 'stoneDark', 'terrace'],   // the pavilion — arches, no fall
        ];
        TIERS.forEach(([h, z0, z1, col, mark]) => box(C, C, z0, 2 * h, 2 * h, z1 - z0 - EPS, col, false, mark));
        for (let i = 1; i < TIERS.length; i++) {
          const [h, , top] = TIERS[i - 1], [hi] = TIERS[i];
          // the pool where tier i's fall lands, on the strip of tier i-1's top
          box(C, C - (h + hi) / 2, top, 0.40, h - hi - 0.03, 0.05, 'water');
          // hedges along the four edges of that terrace; the south edge is
          // two halves either side of the pool; east/west butt between them.
          // THE HANGING RULE (packed rotation sweep, 13 → 12 → 0 wrong
          // pairs): a piece that hangs past the footprint must run the
          // FULL length of its edge, and nothing else may leave the box.
          // A block in the neighbouring row that sits beside a short
          // overhang (not under it) is separated from it on one axis
          // while the tier below is separated on another — a three-axis
          // painter's loop. So north/east/west hedges hang over and span
          // their whole edge; the two south halves beside the pool sit
          // INSIDE the edge (the fall comes down a clean lip, as in the
          // reference); the palms' crowns stay inside the box.
          const e = h - 0.01, SD = 0.25 - 2 * EPS, si = h - EPS - SD / 2;                   // the inside hedge fills the 0.25 strip
          box(C, C + e, top, 2 * h, HD, HH, 'grass');                                        // north — hangs over
          box(C - (h + GAP) / 2, C - si, top, h - GAP, SD, HH, 'grass');                    // south-west half — inside
          box(C + (h + GAP) / 2, C - si, top, h - GAP, SD, HH, 'grass');                    // south-east half — inside
          const y0 = C - h + 0.25 + EPS, y1 = C + h - 0.15 - EPS;                          // between the south and north hedges
          box(C - e, (y0 + y1) / 2, top, HD, y1 - y0, HH, 'grass');                          // west — hangs over
          box(C + e, (y0 + y1) / 2, top, HD, y1 - y0, HH, 'grass');                          // east — hangs over
        }
        // lanterns on the corners of the top terrace's hedges
        { const [h, , top] = TIERS[2], e = h - 0.01;
          for (const sx of [-1, 1]) for (const sy of [-1, 1]) box(C + sx * e, C + sy * e, top + HH, 0.12, 0.12, 0.12, 'lamp', true); }
        // palms: trunk, crown, tuft
        const palm = (x, y, z, tw, th, cw, ch, uw, uh) => {
          box(x, y, z, tw, tw, th, 'copper');
          box(x, y, z + th, cw, cw, ch, 'palm');
          box(x, y, z + th + ch, uw, uw, uh, 'palm');
        };
        palm(C, C, TIERS[3][2], 0.09, 0.42, 0.36, 0.14, 0.18, 0.10);                        // the crown palm
        { const [h, , top] = TIERS[0], d = h - 0.14;                                        // two on the back hedge, crowns inside the box
          palm(C - d, C + d, top + HH, 0.06, 0.50, 0.26, 0.11, 0.14, 0.08);
          palm(C + d, C + d, top + HH, 0.06, 0.50, 0.26, 0.11, 0.14, 0.08); }
        return P;
      })(),
    },
    {
      id: 'arc',
      name: 'The Arc de Triomphe',
      hint: 'a returning army\u2019s doorway: two columns, three high',
      cells: [
        [0, 0, 0, '*'], [1, 0, 0, '*'],
        [0, 0, 1, '*'], [1, 0, 1, '*'],
        [0, 0, 2, '*'], [1, 0, 2, '*'],
      ],
      plainOnly: true,
      // sameColor is LOAD-BEARING, not decoration (designer, 2026-08-31:
      // "a user can accidentally make the Arc de Triomphe" while building
      // a torii). The arc's 2×3 sits inside the torii's 3×3, and
      // shouldDefer only stands the arc aside when a torii could contain
      // ALL of the arc's matched blocks. Mixed colours broke that: your
      // first red column plus ANY 3-high neighbour of another colour
      // matched the arc, no red torii could contain the neighbour, so
      // viable=false, no deferral, and the torii died on its THIRD block.
      // Measured: clean board = torii every time; one blue column beside
      // it = arc on block 3, every time. Requiring one colour removes the
      // mixed match entirely, and an all-red pair then defers correctly.
      // Cost, accepted: a RED arc is impossible until the torii is
      // discovered — the same bargain the towers already make.
      sameColor: true,
      // Cream marble: plinths, piers with raised relief panels (they
      // must protrude — a correct sorter hides embedded detail), frieze,
      // cornice, attic, top cornice.
      // 2026-08-27 mass pass: 38% of its six cubes. The doorway IS the
      // monument, so the piers take their mass in DEPTH (0.48→0.66) and
      // only modestly in width (0.5→0.56, keeping a 0.44 opening); the
      // superstructure deepens to match. Relief plates re-butted to the
      // new pier faces (y 0.17 / 0.83).
      model: [
        [0, 0, 0, [0.68, 0.78], 0.25, 'marbleShadow'],
        [1, 0, 0, [0.68, 0.78], 0.25, 'marbleShadow'],
        [0, 0, 0.25, [0.56, 0.66], 1.65, 'marble'],
        [1, 0, 0.25, [0.56, 0.66], 1.65, 'marble'],
        // Relief panels: one plate per pier FACE (a buried two-sided
        // panel showed through the pier from behind)
        [0, -0.365, 0.55, [0.4, 0.07], 0.75, 'marbleShadow'],
        [0, 0.365, 0.55, [0.4, 0.07], 0.75, 'marbleShadow'],
        [1, -0.365, 0.55, [0.4, 0.07], 0.75, 'marbleShadow'],
        [1, 0.365, 0.55, [0.4, 0.07], 0.75, 'marbleShadow'],
        [0.5, 0, 1.9, [2.0, 0.72], 0.28, 'marble'],       // frieze band
        [0.5, 0, 2.18, [2.15, 0.76], 0.14, 'marbleShadow'],
        [0.5, 0, 2.32, [1.95, 0.7], 0.45, 'marble'],      // attic
        [0.5, 0, 2.77, [2.05, 0.74], 0.12, 'marbleShadow'],
      ],
    },
    {
      id: 'temple',
      name: 'The Temple',
      hint: 'a white wall, three across and two high',
      cells: [
        [0, 0, 0, 'white'], [1, 0, 0, 'white'], [2, 0, 0, 'white'],
        [0, 0, 1, 'white'], [1, 0, 1, 'white'], [2, 0, 1, 'white'],
      ],
      // Parthenon front: three-step stylobate, five fluted columns with
      // capitals, a true rect architrave, a frieze with triglyph rhythm,
      // and the stepped pediment triangle. Marble whites over shadow.
      model: [
        [1, 0, 0,    [3.4, 1.15], 0.14, 'marbleShadow'], // bottom step
        [1, 0, 0.14, [3.2, 1.0],  0.12, 'marble'],
        [1, 0, 0.26, [3.0, 0.9],  0.12, 'marble'],       // stylobate top
        [0, 0, 0.38, [0.26, 0.26], 0.98, 'lightWhite'],  // columns
        [0.5, 0, 0.38, [0.26, 0.26], 0.98, 'lightWhite'],
        [1, 0, 0.38, [0.26, 0.26], 0.98, 'lightWhite'],
        [1.5, 0, 0.38, [0.26, 0.26], 0.98, 'lightWhite'],
        [2, 0, 0.38, [0.26, 0.26], 0.98, 'lightWhite'],
        [0, 0, 1.36, [0.34, 0.34], 0.08, 'marble'],      // capitals
        [0.5, 0, 1.36, [0.34, 0.34], 0.08, 'marble'],
        [1, 0, 1.36, [0.34, 0.34], 0.08, 'marble'],
        [1.5, 0, 1.36, [0.34, 0.34], 0.08, 'marble'],
        [2, 0, 1.36, [0.34, 0.34], 0.08, 'marble'],
        [1, 0, 1.44, [3.1, 0.5], 0.18, 'marble'],        // architrave
        [1, 0, 1.62, [3.1, 0.5], 0.16, 'lightWhite'],    // frieze band
        // Triglyphs: one plate per frieze FACE (two-sided buried strips
        // showed through the frieze from behind)
        [0, -0.28, 1.62, [0.16, 0.06], 0.16, 'marbleShadow'],
        [0.5, -0.28, 1.62, [0.16, 0.06], 0.16, 'marbleShadow'],
        [1, -0.28, 1.62, [0.16, 0.06], 0.16, 'marbleShadow'],
        [1.5, -0.28, 1.62, [0.16, 0.06], 0.16, 'marbleShadow'],
        [2, -0.28, 1.62, [0.16, 0.06], 0.16, 'marbleShadow'],
        [0, 0.28, 1.62, [0.16, 0.06], 0.16, 'marbleShadow'],
        [0.5, 0.28, 1.62, [0.16, 0.06], 0.16, 'marbleShadow'],
        [1, 0.28, 1.62, [0.16, 0.06], 0.16, 'marbleShadow'],
        [1.5, 0.28, 1.62, [0.16, 0.06], 0.16, 'marbleShadow'],
        [2, 0.28, 1.62, [0.16, 0.06], 0.16, 'marbleShadow'],
        [1, 0, 1.78, [3.3, 0.62], 0.1, 'marble'],        // cornice
        [1, 0, 1.88, [3.0, 0.5], 0.18, 'lightWhite'],    // pediment steps
        [1, 0, 2.06, [2.0, 0.44], 0.18, 'marble'],
        [1, 0, 2.24, [1.0, 0.38], 0.16, 'lightWhite'],
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
      // The tower needs its own site: a 3×3 clearing around the five
      // panes (Viet, session 20, from a voxel reference render). The
      // codex draws these as dashed cells; the matcher requires them
      // empty; after the transformation the legs and galleries claim them
      // (blockedCellsFor), so nothing can be dropped inside the lattice.
      empty: [
        [-1, -1, 0], [0, -1, 0], [1, -1, 0],
        [-1, 0, 0],              [1, 0, 0],
        [-1, 1, 0],  [0, 1, 0],  [1, 1, 0],
      ],
      // GENERATED, not hand-placed — ~190 boxes is past what anyone should
      // type, and every joint below depends on one curve. It is an IIFE
      // inside the literal on purpose: tools/check-*.js eval the RECIPES
      // block in isolation, so the generator must be self-contained.
      //
      // The anatomy, bottom to top, in cells (the recipe cell is 0,0 and
      // pieces are centred on it, so ±1.5 is the edge of the 3×3 site):
      //   legs      four columns of stacked courses that follow D(z), the
      //             tower's famous inward curve, alternating light and
      //             inset dark courses — that alternation IS the lattice
      //             at this scale (a box renderer cannot draw a diagonal)
      //   arches    stepped bars under the first girders, each row's
      //             opening set by a semicircle — three rows read as an arch
      //   galleries two platforms: girder ring, slab, a warm LAMP strip
      //             around the edge (the lit windows — glow pieces, so
      //             they are real lights), a thin rail above
      //   bracing   zig-zag cubes between the legs above each gallery
      //   shaft     the legs meet at 4.8 and continue as one column
      //   crown     top slab, lit lantern, cap, spire, antenna, beacon
      // Warm sandstone (sand / travertineDark), per the reference — the
      // old puddled-iron brown is gone.
      model: (() => {
        const P = [];
        // mark: a PATTERN drawBlock paints on the side faces — 'lattice'
        // (the truss openings) or 'mullion' (window bars on a lit band).
        // Painted, not built: the piece count and the sorter stay as is.
        const box = (x, y, z, sx, sy, sz, color, glow, mark) =>
          P.push(mark ? [x, y, z, [sx, sy], sz, color, !!glow, '', 0, mark]
                      : glow ? [x, y, z, [sx, sy], sz, color, true] : [x, y, z, [sx, sy], sz, color]);
        const curve = (pts, z) => {
          if (z <= pts[0][0]) return pts[0][1];
          for (let i = 1; i < pts.length; i++) if (z <= pts[i][0]) {
            const [z0, v0] = pts[i - 1], [z1, v1] = pts[i];
            return v0 + (v1 - v0) * ((z - z0) / (z1 - z0));
          }
          return pts[pts.length - 1][1];
        };
        // D: distance of each leg's centre from the axis. S: a leg's side.
        const D = [[0, 1.22], [0.6, 1.17], [1.2, 1.08], [1.86, 0.95], [2.4, 0.81], [3.6, 0.52], [4.6, 0.30], [4.8, 0.29]];
        const S = [[0, 0.58], [2.0, 0.46], [3.6, 0.34], [4.8, 0.28]];
        const LIGHT = 'sand', DARK = 'travertineDark', LAMP = 'lamp';
        const INSET = 0.08, EPS = 0.006;
        // Leg courses between two heights. Records each course so the
        // bars between legs can be cut to the innermost leg face they span.
        const courses = [];
        const legs = (z0, z1, n) => {
          const h = (z1 - z0) / n;
          for (let i = 0; i < n; i++) {
            const z = z0 + i * h, zc = z + h / 2, d = curve(D, zc), s = curve(S, zc);
            const dark = i % 2 === 1, ss = dark ? s - INSET : s;
            courses.push({ z0: z, z1: z + h, inner: d - s / 2, d });
            for (const [px, py] of [[-1, -1], [1, -1], [-1, 1], [1, 1]])
              box(px * d, py * d, z, ss, ss, h, dark ? DARK : LIGHT, false, 'lattice');
          }
        };
        // The clear span between two legs' inner faces over a z-range.
        const span = (z0, z1) => {
          let m = Infinity;
          courses.forEach(c => { if (c.z1 > z0 + 1e-9 && c.z0 < z1 - 1e-9) m = Math.min(m, c.inner); });
          return m - EPS;
        };
        const dAt = (z) => curve(D, z);
        // A bar on all four outer faces, from -L..L along the face, sitting
        // in the legs' own plane (centre at ±d), `dep` deep, `th` tall.
        // A closed girder ring in the legs' plane (centre at ±d): the x-bars
        // run corner to corner, the y-bars fill between them — no crossing.
        const ring = (z, th, dep, color) => {
          const d = dAt(z + th / 2), Lx = d + dep / 2, Ly = d - dep / 2 - EPS;
          box(0, -d, z, 2 * Lx, dep, th, color, false, 'lattice');
          box(0, d, z, 2 * Lx, dep, th, color, false, 'lattice');
          box(-d, 0, z, dep, 2 * Ly, th, color, false, 'lattice');
          box(d, 0, z, dep, 2 * Ly, th, color, false, 'lattice');
        };
        // Lattice rings: a thin horizontal bar across each face between
        // two legs, cut to the innermost leg face it spans. (Zig-zag cubes
        // were tried first and read as rubble at this scale.)
        const brace = (z, th = 0.09) => {
          const L = span(z, z + th);
          if (L < 0.12) return;
          const d = dAt(z + th / 2);
          box(0, -d, z, 2 * L, th, th, DARK); box(0, d, z, 2 * L, th, th, DARK);
          box(-d, 0, z, th, 2 * L, th, DARK); box(d, 0, z, th, 2 * L, th, DARK);
        };
        // A gallery: girder ring under, slab, lamp strip, rail. Returns
        // the z where the legs resume. `half` = slab half-width.
        const gallery = (zTop, girderH, girderDep, slabH, half) => {
          const zg = zTop - girderH;
          ring(zg, girderH, girderDep, LIGHT);
          box(0, 0, zTop, 2 * half, 2 * half, slabH, LIGHT);
          // The lit windows: LAMP colour reads as lit on its own. They are
          // deliberately NOT glow pieces — eight point lights per tower
          // washed every face between the galleries into one yellow blob.
          // Only the lantern and the beacon are real lights.
          //
          // The dark rail is a FRAME beside the lit band, at the SAME height.
          // It used to sit one step above the band and wrap the legs, and
          // that is a painter's cycle by construction: leg behind band (y),
          // band behind rail (z), rail behind leg (x) — six wrong pairs at
          // every camera angle. Same height = no z vote = no loop.
          const zs = zTop + slabH, th = 0.14, e = half - 0.13; // lamp band centre line
          box(0, -e, zs, 2 * (e + 0.06), 0.12, th, LAMP, false, 'mullion');
          box(0, e, zs, 2 * (e + 0.06), 0.12, th, LAMP, false, 'mullion');
          box(-e, 0, zs, 0.12, 2 * (e - 0.06), th, LAMP, false, 'mullion');
          box(e, 0, zs, 0.12, 2 * (e - 0.06), th, LAMP, false, 'mullion');
          const f = e + 0.09;                                  // frame centre line
          box(0, -f, zs, 2 * (f + 0.03), 0.06, th, DARK);
          box(0, f, zs, 2 * (f + 0.03), 0.06, th, DARK);
          box(-f, 0, zs, 0.06, 2 * (f - 0.03), th, DARK);
          box(f, 0, zs, 0.06, 2 * (f - 0.03), th, DARK);
          return zs;
        };

        // ── Build ──
        legs(0, 1.86, 9);                       // ground to the first girders
        // Arches: rows of bars whose opening follows a semicircle that
        // tops out at the girder's underside.
        { const top = 1.86, R = span(1.6, 1.86), zc = top - R, th = 0.17, dep = 0.2;
          for (let z = 1.18; z + th <= top + 1e-9; z += 0.17) {
            const mid = z + th / 2, o = Math.sqrt(Math.max(0, R * R - (mid - zc) * (mid - zc)));
            const L = span(z, z + th), len = L - o;
            if (len < 0.04) continue;
            const d = dAt(mid), u = o + len / 2;
            for (const [bx, by, bw, bh] of [[-u, -d, len, dep], [u, -d, len, dep], [-u, d, len, dep], [u, d, len, dep],
                                             [-d, -u, dep, len], [-d, u, dep, len], [d, -u, dep, len], [d, u, dep, len]])
              box(bx, by, z, bw, bh, th, LIGHT, false, 'lattice');
          } }
        let z = gallery(2.2, 0.34, 0.5, 0.16, 1.22);   // first gallery (legs resume at z)
        legs(z, 3.36, 4);
        brace(2.62); brace(2.88); brace(3.14);
        z = gallery(3.6, 0.24, 0.36, 0.14, 0.85);      // second gallery
        legs(z, 4.8, 4);
        brace(4.0); brace(4.3);
        // The shaft: one column, same light/dark rhythm, tapering to the crown.
        { const W0 = 0.60, W1 = 0.42, n = 6, h = (6.2 - 4.8) / n;
          for (let i = 0; i < n; i++) {
            const zz = 4.8 + i * h, w = W0 + (W1 - W0) * ((i + 0.5) / n), dark = i % 2 === 1;
            box(0, 0, zz, dark ? w - INSET : w, dark ? w - INSET : w, h, dark ? DARK : LIGHT, false, 'lattice');
          } }
        box(0, 0, 6.2, 0.8, 0.8, 0.12, LIGHT);          // top slab
        box(0, 0, 6.32, 0.30, 0.30, 0.30, LAMP, true);  // the lantern
        box(0, 0, 6.62, 0.34, 0.34, 0.08, DARK);        // cap
        box(0, 0, 6.70, 0.14, 0.14, 0.50, DARK);        // spire
        box(0, 0, 7.20, 0.06, 0.06, 0.58, DARK);        // antenna
        box(0, 0, 7.78, 0.08, 0.08, 0.12, LAMP, true);  // beacon
        return P;
      })(),
    },
    {
      id: 'crystal',
      name: 'The Crystal Palace',
      hint: 'six panes of glass, laid flat in a three-by-two bed',
      cells: [
        [0, 0, 0, 'glass'], [1, 0, 0, 'glass'], [2, 0, 0, 'glass'],
        [0, 1, 0, 'glass'], [1, 1, 0, 'glass'], [2, 1, 0, 'glass'],
      ],
      // Paxton's documented scheme: the iron frame was pale blue with
      // yellow trim, the girders red. Glass tiers, then the barrel
      // transept running crosswise, gold finial.
      model: [
        [1, 0.5, 0, [3.1, 2.1], 0.14, 'girderRed'],        // girder base
        // Hall ends at the trim; ribs are FACE plates (they used to
        // pierce the glass hall clean through, out both ends)
        [1, 0.5, 0.14, [3.0, 2.0], 0.76, 'glass'],         // main hall
        [1, -0.53, 0.2, [3.0, 0.06], 0.68, 'paleIronBlue'], // front ribs
        [1, 1.53, 0.2, [3.0, 0.06], 0.68, 'paleIronBlue'],  // rear ribs
        [1, 0.5, 0.9, [3.04, 2.04], 0.06, 'trimYellow'],   // trim line (hall→trim→tier stack)
        [1, 0.5, 0.96, [2.4, 1.6], 0.48, 'glass'],         // second tier
        [1, -0.33, 1.0, [2.46, 0.06], 0.4, 'paleIronBlue'],
        [1, 0.5, 1.44, [2.44, 1.64], 0.05, 'trimYellow'],
        // Transept depth is clamped to the 2-cell footprint (was 2.1/2.06).
        // Overhanging even 0.05 put these two plates into the airspace of the
        // neighbouring cell's blocks, which closed a painter's cycle through
        // the tier stack — 8 wrongly-ordered pairs at 122.5deg, at every angle.
        // Flush is the invariant: nothing in the roof may cross y=0 or y=2.
        [1, 0.5, 1.49, [1.15, 2.0], 0.35, 'glass'],        // barrel transept
        [1, 0.5, 1.84, [0.85, 2.0], 0.25, 'glass'],
        [1, 0.5, 2.09, [0.5, 2.0], 0.18, 'glass'],
        [1, 0.5, 2.27, [0.24, 0.24], 0.22, 'gold', true],  // finial
      ],
    },
    {
      id: 'doghouse',
      name: 'The Doghouse',
      hint: "somebody's dream home: orange below, red above",
      cells: [
        [0, 0, 0, 'orange'], [1, 0, 0, 'orange'],
        [0, 0, 1, 'red'], [1, 0, 1, 'red'],
      ],
      // A real kennel: rect body, stepped gable roof with overhang and a
      // ridge cap, an arched doorway that PROTRUDES past the front face
      // (a correct sort hides buried geometry — the door lesson), and a
      // food bowl by the entrance.
      model: [
        [0.5, 0, 0, [1.9, 0.95], 0.85, 'orange'],           // body
        [0.5, -0.5125, 0.06, [0.5, 0.075], 0.5, 'stoneDark'],   // doorway (face plate)
        [0.5, -0.5125, 0.56, [0.34, 0.075], 0.14, 'stoneDark'], // arch top
        [0.5, 0, 0.85, [2.15, 1.15], 0.3, 'lightRed'],      // roof, eaves
        [0.5, 0, 1.15, [1.45, 1.05], 0.28, 'lightRed'],
        [0.5, 0, 1.43, [0.75, 0.95], 0.26, 'lightRed'],     // roof, ridge
        [0.5, 0, 1.69, [0.34, 0.5], 0.1, 'stoneDark'],      // ridge cap
        [1.1, -0.6, 0, [0.28, 0.24], 0.14, 'gold'],         // food bowl, in front of the house
      ],
    },
    {
      id: 'lighthouse',
      name: 'The Lighthouse',
      hint: 'a tall friend for ships in the dark, crowned with a lamp',
      cells: [
        [0, 0, 0, '*'], [0, 0, 1, '*'], [0, 0, 2, '*'],
        [0, 0, 3, 'lamp'],
      ],
      // The classic banded tower, completed: rock base, door, a real
      // gallery deck, corner posts framing the lamp room, gallery roof,
      // dome step, finial.
      model: [
        [0, 0, 0, [1.05, 1.05], 0.22, 'sarsenGrey'],       // rock base
        [0, 0, 0.22, [0.8, 0.8], 0.85, 'lightWhite'],
        [0, -0.455, 0.22, [0.3, 0.11], 0.52, 'stoneDark'], // door (face plate)
        [0, 0, 1.07, [0.72, 0.72], 0.85, 'lightRed'],
        [0, 0, 1.92, [0.64, 0.64], 0.85, 'lightWhite'],
        [0, 0, 2.77, [0.58, 0.58], 0.6, 'lightRed'],
        [0, 0, 3.37, [0.9, 0.9], 0.1, 'stoneDark'],        // gallery deck
        [0, 0, 3.47, [0.5, 0.5], 0.42, 'lamp', true],      // the light
        [-0.3, -0.3, 3.47, [0.1, 0.1], 0.42, 'kasagiBlack'],
        [0.3, -0.3, 3.47, [0.1, 0.1], 0.42, 'kasagiBlack'],
        [-0.3, 0.3, 3.47, [0.1, 0.1], 0.42, 'kasagiBlack'],
        [0.3, 0.3, 3.47, [0.1, 0.1], 0.42, 'kasagiBlack'],
        [0, 0, 3.89, [0.6, 0.6], 0.12, 'lightRed'],        // gallery roof
        [0, 0, 4.01, [0.34, 0.34], 0.22, 'lightRed'],      // dome step
        [0, 0, 4.23, [0.14, 0.14], 0.16, 'kasagiBlack'],   // finial
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
      // Luxor rose granite on a stepped pedestal, tapering shaft in
      // shade-varied segments, gilded pyramidion.
      // 2026-08-27 mass pass: 31% of its four cubes — the needle read as a
      // stick. Shaft 0.52→0.66 with the taper steps preserved (0.08 per
      // stage); pure z-stack, every joint still butts.
      model: [
        [0, 0, 0, [0.95, 0.95], 0.3, 'stoneDark'],       // base slab
        [0, 0, 0.3, [0.78, 0.78], 0.45, 'graniteRose'],  // pedestal
        [0, 0, 0.75, [0.88, 0.88], 0.1, 'stoneDark'],    // pedestal cap
        [0, 0, 0.85, [0.66, 0.66], 1.1, 'graniteRose'],
        [0, 0, 1.95, [0.58, 0.58], 1.05, 'graniteRose'],
        [0, 0, 3.0, [0.5, 0.5], 0.95, 'graniteRose'],
        [0, 0, 3.95, [0.42, 0.42], 0.38, 'gold', true],  // pyramidion
      ],
    },
    {
      id: 'greatwall',
      name: 'The Great Wall',
      hint: 'five of anything, standing shoulder to shoulder',
      cells: [
        [0, 0, 0, '*'], [1, 0, 0, '*'], [2, 0, 0, '*'], [3, 0, 0, '*'], [4, 0, 0, '*'],
      ],
      // Rebuilt 2026-09-07 (session 20) from Viet's voxel reference: three
      // watchtowers with grey tiled hip roofs and lit windows, a gate arch
      // through the middle one, battlemented wall runs between them,
      // lantern posts on the walkway. GENERATED (an IIFE inside the
      // literal — the tools eval the RECIPES block in isolation), like
      // the Eiffel Tower.
      //
      // THE RULE THIS MONUMENT LIVES BY: nothing overhangs the 1×5 cell
      // strip. Blocks stacked beside the old tower interpenetrated its
      // corbel and roof slabs and closed a painter's cycle (9 wrong pairs
      // at 317.5°); the spill guard now allows this recipe ZERO spill.
      // So: eaves are flush with the cell (the storey below steps IN to
      // make the ledge), the gate lanterns are PAINTED into the arch
      // mark rather than mounted on the face, and there are no stairs —
      // there is no room for them inside a 1.0-wide strip. Winding and
      // landscape were ruled out by Viet (straight, wall only).
      //
      // Lit windows and the gate arch are painted marks, not pieces
      // (world.js drawBlock); the only real lights are the two lantern
      // posts. ~45 pieces.
      model: (() => {
        const P = [];
        const box = (x, y, z, sx, sy, sz, color, glow, mark) =>
          P.push(mark ? [x, y, z, [sx, sy], sz, color, !!glow, '', 0, mark]
                      : glow ? [x, y, z, [sx, sy], sz, color, true] : [x, y, z, [sx, sy], sz, color]);
        const EPS = 0.006;
        const BRICK = 'brickGrey', DARK = 'brickDark', TILE = 'kasagiBlack', LAMP = 'lamp';
        // Watchtowers at x = 0, 2 (the gate), 4 — each inside its own cell.
        for (const tx of [0, 2, 4]) {
          box(tx, 0, 0, 1.0, 1.0, 1.30, DARK, false, tx === 2 ? 'gateY' : '');  // body
          box(tx, 0, 1.30, 1.0, 1.0, 0.10, BRICK);                                // corbel band (flush)
          box(tx, 0, 1.40, 0.88, 0.88, 0.65, BRICK, false, 'windows');           // upper storey, lit windows
          box(tx, 0, 2.05, 1.0, 1.0, 0.10, TILE);                                 // hip roof, eaves flush
          box(tx, 0, 2.15, 0.74, 0.74, 0.10, TILE);
          box(tx, 0, 2.25, 0.48, 0.48, 0.10, TILE);
          box(tx, 0, 2.35, 0.22, 0.22, 0.12, TILE);                               // ridge
        }
        // Wall runs between the towers, butted EPS short of their faces.
        for (const rx of [1, 3]) {
          const L = 1.0 - 2 * EPS;
          box(rx, 0, 0, L, 0.80, 1.05, BRICK);                 // body
          box(rx, 0, 1.05, L, 0.80, 0.06, DARK);               // walkway pavers
          for (const side of [-1, 1]) {
            box(rx, side * 0.34, 1.11, L, 0.12, 0.14, BRICK);  // parapet
            for (const mx of [-0.34, 0, 0.34])                 // merlons — silhouette, so pieces
              box(rx + mx, side * 0.34, 1.25, 0.20, 0.12, 0.18, DARK);
          }
          // one lantern post on the rear parapet, between two merlons
          box(rx - 0.17, 0.34, 1.25, 0.08, 0.08, 0.26, DARK);
          box(rx - 0.17, 0.34, 1.51, 0.12, 0.12, 0.12, LAMP, true);
        }
        return P;
      })(),
    },
    {
      id: 'prudential',
      name: 'Prudential Tower',
      hint: 'a blue wall, three across and three high',
      // The FIRST portfolio monument: 751 Broad St, Newark (1960) — where
      // Viet was Sr. Product Designer 2018–2021. The card says so.
      //
      // The recipe joins the game's colour-wall namespace: red 3×3 wall =
      // torii, white 3×2 wall = temple, BLUE 3×3 wall = this. Colour is
      // what the matcher already uses to tell identical shapes apart, and
      // the explicit colour is also what makes it buildable at all
      // (temple's wall and arc's 2×3 live inside every wall; they defer
      // only to a LARGER recipe's explicit colour demand — '*' here would
      // be eaten mid-build in every order, and WHITE is the temple's).
      // Blue is the one colour that is HONEST here anyway: it is
      // Prudential's brand blue — you build the company colour and it
      // becomes the company's limestone tower wearing its blue sign.
      card: { title: 'PRUDENTIAL', sub: 'SR. PRODUCT DESIGNER · 2018–2021' },
      // Where the opening builds it: against the far edge, LEFT of BNY,
      // so the skyline reads 2018 → 2021 and the centre stays the
      // visitor's canvas. Consumed by runEntrance (the tidy stack lands
      // here) and plantHomes (pre-tower saves).
      home: { ox: -4, oy: -4, k: 0 },
      // Never lose these blocks to a smaller recipe, even once discovered —
      // see the learned-trap note in shouldDefer. The arc (2×3, any plain
      // colour) lives inside this 3×3 wall and used to eat it. BNY's tower
      // must carry this too.
      neverStolen: true,
      cells: [
        [0, 0, 0, 'blue'], [1, 0, 0, 'blue'], [2, 0, 0, 'blue'],
        [0, 0, 1, 'blue'], [1, 0, 1, 'blue'], [2, 0, 1, 'blue'],
        [0, 0, 2, 'blue'], [1, 0, 2, 'blue'], [2, 0, 2, 'blue'],
      ],
      // A broad flat slab (the 1960 curtain-wall block reads as a wall,
      // not a spire), risen from a wider podium with a heavy cornice, on
      // a plaza that is part of the monument — the "distinct site" that
      // will separate it from BNY's tower later. The crown is the blank
      // parapet band carrying the lit blue PRUDENTIAL sign (face plates,
      // doghouse-door idiom, glowing steady) and the flagpole from the
      // reference photos. Volume 57.7% of its nine cubes — the top half
      // of the 40–60 band; a solid office tower SHOULD read massive.
      model: [
        [1, 0, 0,    [3.05, 1.35], 0.1,  'stoneDark'],     // plaza
        [1, 0, 0.1,  [2.75, 1.12], 0.34, 'travertineDark'], // podium
        [1, 0, 0.44, [2.85, 1.2],  0.08, 'stoneDark'],     // podium cornice
        [1, 0, 0.52, [2.3, 0.46],  3.2,  'travertine', 0, 0, 0.55], // the slab shaft — windowed, blank parapet above
        [1, -0.26, 3.26, [2.0, 0.06], 0.3, 'pruBlue', true, 'prudential'], // sign, front face (glow + wordmark)
        [1, 0.26, 3.26,  [2.0, 0.06], 0.3, 'pruBlue', true, 'prudential'], // sign, rear face
        [1, 0, 3.72, [0.12, 0.12], 0.44, 'ironBronze'],    // flagpole
      ],
    },
    {
      id: 'bny',
      name: 'Bank of New York',
      hint: 'a cyan block, three by two and two high',
      // The SECOND portfolio monument: 240 Greenwich St, New York (1983,
      // SOM) — where Viet was Head of Design, Wealth, 2021–2025.
      //
      // Everything about it is Prudential's opposite, which is the whole
      // differentiation strategy: WIDE chunky box vs thin slab, cool
      // silver glass vs warm limestone, HORIZONTAL ribbon windows vs a
      // vertical grid, stepped terraced roofline + rooftop drum vs blank
      // parapet + flagpole. Cyan is the honest colour twice over: the
      // 2024 BNY rebrand's hero colour is a distinctive teal, and cyan
      // is what the swatch row offers. The recipe is theft-proof by
      // colour alone — crystal demands glass, gardens demands grass
      // tops, temple white, doghouse orange/red — but neverStolen goes
      // on anyway, same insurance as Prudential.
      card: { title: 'BANK OF NEW YORK', sub: 'HEAD OF DESIGN, WEALTH · 2021–2025' },
      neverStolen: true,
      home: { ox: 0, oy: -4, k: 0 }, // far edge, RIGHT of Prudential — the career reads left→right
      cells: [
        [0, 0, 0, 'cyan'], [1, 0, 0, 'cyan'], [2, 0, 0, 'cyan'],
        [0, 1, 0, 'cyan'], [1, 1, 0, 'cyan'], [2, 1, 0, 'cyan'],
        [0, 0, 1, 'cyan'], [1, 0, 1, 'cyan'], [2, 0, 1, 'cyan'],
        [0, 1, 1, 'cyan'], [1, 1, 1, 'cyan'], [2, 1, 1, 'cyan'],
      ],
      // The ribbon read is built in GEOMETRY, not texture: the body is a
      // stack of alternating slabs — pale spandrel bands ('lightWhite',
      // faces < 0.8 cells² so the marble family stays clean) and dark
      // night-glazing bands ('bnyGlass', no material family). Robust at
      // every zoom, zero new draw code. Mass 92% of its twelve cubes —
      // NOT the towers' 40–60 band, deliberately: that band repaired the
      // thin five, and on a wide footprint it would force a squat plinth
      // (60% volume = a 1.2-cell-tall slab losing to its own 2-cube
      // stack). The chunky healthy monuments are the right reference:
      // colosseum 90%, pyramid 91%. Height 126% of the stack.
      model: [
        [1, 0.5, 0,    [3.3, 2.3],   0.08, 'stoneDark'],   // plaza (street trees' ground)
        [1, 0.5, 0.08, [2.95, 1.95], 0.26, 'bnyGlass'],    // glass lobby storey
        [1, 0.5, 0.34, [2.8, 1.8],   0.09, 'lightWhite'],  // spandrel
        [1, 0.5, 0.43, [2.8, 1.8],   0.13, 'bnyGlass'],    // ribbon
        [1, 0.5, 0.56, [2.8, 1.8],   0.09, 'lightWhite'],
        [1, 0.5, 0.65, [2.8, 1.8],   0.13, 'bnyGlass'],
        [1, 0.5, 0.78, [2.8, 1.8],   0.09, 'lightWhite'],
        [1, 0.5, 0.87, [2.8, 1.8],   0.13, 'bnyGlass'],
        [1, 0.5, 1.0,  [2.8, 1.8],   0.09, 'lightWhite'],
        [1, 0.5, 1.09, [2.8, 1.8],   0.13, 'bnyGlass'],
        [1, 0.5, 1.22, [2.8, 1.8],   0.09, 'lightWhite'],
        [1, 0.5, 1.31, [2.8, 1.8],   0.13, 'bnyGlass'],
        [1, 0.5, 1.44, [2.8, 1.8],   0.09, 'lightWhite'],
        [1, 0.5, 1.53, [2.8, 1.8],   0.13, 'bnyGlass'],
        [1, 0.5, 1.66, [2.8, 1.8],   0.26, 'lightWhite'],  // parapet band — carries the sign
        [1, -0.43, 1.69, [1.3, 0.06], 0.2, 'bnyNavy', true, 'bny'], // sign card, front face (navy ground, white BNY, teal arrow)
        [1, 1.43, 1.69,  [1.3, 0.06], 0.2, 'bnyNavy', true, 'bny'], // sign card, rear face
        [0.85, 0.5, 1.92, [2.3, 1.5], 0.16, 'lightWhite'], // roof terrace, first setback
        [0.65, 0.5, 2.08, [1.7, 1.2], 0.16, 'lightWhite'], // second setback — the staircase roofline
        [0.55, 0.55, 2.24, [0.42, 0.42], 0.28, 'lightWhite'], // the rooftop drum
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

  // ── Occlusion-correct ordering: the separating-plane test ───
  // Two disjoint boxes always have a flat axis wall (x, y, or z plane)
  // between them; whoever is on the VIEWER's side of that wall is in
  // front. Which side the viewer is on follows from the camera angle:
  // world +x is toward the viewer iff (cosA+sinA) > 0, +y iff
  // (cosA−sinA) > 0, +z always. Per pair, every separated axis casts a
  // front/behind vote: agreeing votes → an ordering edge; contradictory
  // votes → the boxes provably share no pixels → no edge needed; no
  // votes → touching/interpenetrating → no edge (key order decides).
  // This is EXACT and continuous at every angle — a pair's order flips
  // exactly once per quarter turn, when its wall goes edge-on. The
  // previous camera-extent test was exact only at the four rest angles;
  // in between it lost its opinion on many pairs, and their order fell
  // to an accident of emission that reshuffled as the angle swept — the
  // "blocks flicker against the pyramid while rotating" bug.
  // pieces: [{gx,gy,gz,sxy,sy,sz}, ...]; returns indices back-to-front.
  function occlusionOrder(allPieces, cosA, sinA) {
    if (cosA === undefined) { cosA = E.cosA; sinA = E.sinA; }
    // LIGHT entries (the beam's slices: long, diagonal, translucent) are
    // sorted AFTER the solid world is ordered, and slotted in behind the
    // last solid they must follow. Sorting them together with the solids
    // let their boxes close painter's cycles through a monument, and the
    // cycle breaker then drew a rear sign plate over the front of the
    // tower. A light drawn one slot too early is invisible; a solid drawn
    // one slot too early is a glitch.
    const lights = [], solidIdx = [];
    allPieces.forEach((p, i) => (p.light ? lights : solidIdx).push(i));
    const pieces = solidIdx.map(i => allPieces[i]);
    const n = pieces.length;
    const EPS = 1e-6, EV = 1e-9;
    const box = pieces.map(p => E.pieceAABB(p.gx, p.gy, p.gz, p.sxy, p.sz, p.sy));
    const key = pieces.map(p => p.gx * (cosA + sinA) + p.gy * (cosA - sinA) + p.gz * 0.01);
    const vx = cosA + sinA, vy = cosA - sinA;
    const after = Array.from({ length: n }, () => []); // after[a] = pieces a must precede
    const indeg = new Array(n).fill(0);
    for (let a = 0; a < n; a++) {
      const A = box[a];
      for (let b = a + 1; b < n; b++) {
        const B = box[b];
        let aFront = 0, aBehind = 0;
        if (A.x1 <= B.x0 + EPS) { if (vx > EV) aBehind++; else if (vx < -EV) aFront++; }
        else if (B.x1 <= A.x0 + EPS) { if (vx > EV) aFront++; else if (vx < -EV) aBehind++; }
        if (A.y1 <= B.y0 + EPS) { if (vy > EV) aBehind++; else if (vy < -EV) aFront++; }
        else if (B.y1 <= A.y0 + EPS) { if (vy > EV) aFront++; else if (vy < -EV) aBehind++; }
        if (A.z1 <= B.z0 + EPS) aBehind++; else if (B.z1 <= A.z0 + EPS) aFront++;
        if (aBehind && !aFront) { after[a].push(b); indeg[b]++; }      // a is behind b
        else if (aFront && !aBehind) { after[b].push(a); indeg[a]++; } // b is behind a
      }
    }
    // Kahn's; pop smallest depthKey among ready for determinism.
    const order = [], ready = [], used = new Array(n).fill(false);
    for (let i = 0; i < n; i++) if (indeg[i] === 0) ready.push(i);
    while (order.length < n) {
      let pick = -1;
      if (ready.length) {
        let bi = 0;
        for (let i = 1; i < ready.length; i++) if (key[ready[i]] < key[ready[bi]]) bi = i;
        pick = ready.splice(bi, 1)[0];
      } else {
        // A genuine cycle: no valid next piece exists. Long thin boxes CAN
        // cycle at mid-rotation angles (a painter's pinwheel), so degrade
        // by emitting the node with the FEWEST un-drawn prerequisites —
        // each one is a pair that will draw wrongly — tie-broken by depth
        // key. (The old smallest-key-only pick could emit a front-most
        // piece first and violate a dozen pairs instead of one or two.)
        for (let i = 0; i < n; i++) {
          if (used[i]) continue;
          if (pick === -1 || indeg[i] < indeg[pick] ||
              (indeg[i] === indeg[pick] && key[i] < key[pick])) pick = i;
        }
      }
      used[pick] = true;
      order.push(pick);
      after[pick].forEach(j => { if (!used[j] && --indeg[j] === 0) ready.push(j); });
    }
    // Map back to indices into allPieces, then slot the lights in.
    const out = order.map(i => solidIdx[i]);
    if (lights.length) {
      const pos = new Map(); // allPieces index -> position in out
      out.forEach((idx, k) => pos.set(idx, k));
      const behindOf = (L, S) => { // is solid S behind light L?
        let aFront = 0, aBehind = 0; // "a" = the light
        if (L.x1 <= S.x0 + EPS) { if (vx > EV) aBehind++; else if (vx < -EV) aFront++; }
        else if (S.x1 <= L.x0 + EPS) { if (vx > EV) aFront++; else if (vx < -EV) aBehind++; }
        if (L.y1 <= S.y0 + EPS) { if (vy > EV) aBehind++; else if (vy < -EV) aFront++; }
        else if (S.y1 <= L.y0 + EPS) { if (vy > EV) aFront++; else if (vy < -EV) aBehind++; }
        if (L.z1 <= S.z0 + EPS) aBehind++; else if (S.z1 <= L.z0 + EPS) aFront++;
        return aFront && !aBehind; // the solid is behind the light
      };
      const frontOf = (L, S) => { // is solid S in front of light L?
        let aFront = 0, aBehind = 0; // "a" = the light
        if (L.x1 <= S.x0 + EPS) { if (vx > EV) aBehind++; else if (vx < -EV) aFront++; }
        else if (S.x1 <= L.x0 + EPS) { if (vx > EV) aFront++; else if (vx < -EV) aBehind++; }
        if (L.y1 <= S.y0 + EPS) { if (vy > EV) aBehind++; else if (vy < -EV) aFront++; }
        else if (S.y1 <= L.y0 + EPS) { if (vy > EV) aFront++; else if (vy < -EV) aBehind++; }
        if (L.z1 <= S.z0 + EPS) aBehind++; else if (S.z1 <= L.z0 + EPS) aFront++;
        return aBehind && !aFront; // the light is behind the solid
      };
      const inserts = lights.map(li => {
        const p = allPieces[li];
        const L = E.pieceAABB(p.gx, p.gy, p.gz, p.sxy, p.sz, p.sy);
        // After the last solid behind it, but NEVER after a solid in front
        // of it: the solid order interleaves, so "last behind" can sit past
        // a piece the light must stay under — that drew the sheet over a
        // tower face and, as the beam swept, flickered it on and off. Too
        // early is invisible; too late is a glitch. Early wins the tie.
        let at = -1, firstFront = out.length;
        for (let k = 0; k < out.length; k++) {
          const S = box[order[k]];
          if (behindOf(L, S)) at = k;
          if (firstFront === out.length && frontOf(L, S)) firstFront = k;
        }
        return { li, at: Math.min(at, firstFront - 1) };
      });
      // insert from the back so earlier positions stay valid
      inserts.sort((a, b) => b.at - a.at);
      for (const ins of inserts) out.splice(ins.at + 1, 0, ins.li);
    }
    return out;
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
          const match = { recipe: r, ox, oy, oz, k, blocks };
          if (shouldDefer(match)) continue; // mid-way through something bigger
          return match;
        }
      }
    }
    return null;
  }

  // ── Deferral: don't steal blocks from a bigger build in progress ──
  // The torii (a 3×3 RED wall) contains the arc (2×3, ANY plain colour)
  // as a sub-pattern, so the arc used to fire six blocks into the wall
  // and eat the torii in almost every natural build order. The rule that
  // fixes it without breaking anything else is COLOUR SPECIFICITY:
  //
  //   a recipe that matched via '*' (any colour) must not consume blocks
  //   that specifically satisfy a LARGER, undiscovered recipe's explicit
  //   colour requirement.
  //
  // Traced against every conflict: arc yields to torii (torii demands red
  // where arc says '*'); the doghouse still fires inside a would-be arc
  // (doghouse is MORE specific — orange/red — so nothing defers it); the
  // colosseum still fires inside a pyramid base (both all-'*', and its
  // satisfied empty heart is deliberate intent, exempted below). After a
  // monument is discovered its trap is considered learned — the player
  // knows the shape and can build around it, and e.g. a red arc becomes
  // possible again. Guarded by the vh-dev-buildable harness.
  function shouldDefer(match) {
    const R = match.recipe;
    if (R.empty && R.empty.length) return false; // a satisfied empty is intent
    const key = (x, y, z) => x + ',' + y + ',' + z;
    const matched = new Map(match.blocks.map(b => [key(b.gx, b.gy, b.gz), b]));
    // Which matched blocks did R accept via '*'? (blocks[] parallels cells)
    const starKeys = new Set();
    match.blocks.forEach((b, i) => {
      if (R.cells[i][3] === '*') starKeys.add(key(b.gx, b.gy, b.gz));
    });
    if (!starKeys.size) return false; // a fully explicit recipe always wins
    for (const L of RECIPES) {
      if (L === R || L.cells.length <= R.cells.length) continue;
      // The learned-trap exemption, and the ONE case it must not apply to.
      // For the 13 toys "you found it, now you can build around it" is the
      // right rule. For a portfolio building it is exactly backwards: the
      // opening ceremony discovers the towers in the first seconds of every
      // visit, so without neverStolen a hand-rebuilt blue 3×3 wall becomes
      // an ARC ~70% of the time (measured) for the whole rest of the visit.
      // A tower is an address, not a puzzle — it must always be reachable.
      // Cost, accepted: a BLUE arc is now permanently impossible (eight
      // other colours still make one), and that is the more consistent
      // rule anyway — a blue 2×3 wall is always on its way to Prudential.
      if (M.discovered.has(L.id) && !L.neverStolen) continue;
      for (let k = 0; k < 4; k++) {
        // Candidate placements of L: align each of its cells onto each
        // matched block (small numbers — recipes are ≤10 cells)
        const origins = new Set();
        for (const c of L.cells) {
          const [cx, cy] = rot(c[0], c[1], k);
          match.blocks.forEach(b => {
            if (b.gz - c[2] >= 0) {
              origins.add((b.gx - cx) + ',' + (b.gy - cy) + ',' + (b.gz - c[2]));
            }
          });
        }
        for (const o of origins) {
          const [ox, oy, oz] = o.split(',').map(Number);
          let covered = 0, explicitOverStar = false, viable = true;
          for (const c of L.cells) {
            const [cx, cy] = rot(c[0], c[1], k);
            const kk = key(ox + cx, oy + cy, oz + c[2]);
            const b = matched.get(kk) || W.blockAt(ox + cx, oy + cy, oz + c[2]);
            if (!b) continue; // an unfilled L cell: still buildable
            // A block already inside L's shape that VIOLATES L means this
            // placement of L isn't genuinely in progress — don't defer for it
            if (b.transforming || (c[3] !== '*' && b.color !== c[3])) { viable = false; break; }
            if (matched.has(kk)) {
              covered++;
              if (c[3] !== '*' && starKeys.has(kk)) explicitOverStar = true;
            }
          }
          if (viable && covered === match.blocks.length && explicitOverStar) return true;
        }
      }
    }
    return false;
  }

  // ── Discovery state (persistence arrives with the codex) ────
  M.discovered = new Set();
  M.findMatchAt = findMatchAt; // exposed for dev probing; harmless to keep

  // ── Ceremony ────────────────────────────────────────────────
  // gather (0.7s): consumed blocks lift, spin, glow, drift to center
  // flash  (at 0.7): burst of light, blocks vanish, monument starts rising
  // rise   (0.7→1.8): model cubes pop in bottom-up with tiny overshoots
  const ceremonies = [];

  // Cells the DRAWN model fills but the recipe never claimed. A piece's
  // footprint (sxy across x, sy across y) bulges beyond its base cell, so
  // a lintel spans neighbouring columns; spires poke a cell above their
  // recipe. These cells must count
  // as solid (occupancy + stacking + the leftover sweep) or blocks end up
  // inside the monument. Derived, never persisted — stays correct if
  // E.SOLID_EPS is ever retuned.
  // OUTSIDE the recipe's own columns a graze must not claim the tile.
  // Deliberate overhangs (the torii's kasagi projects 0.27 past its posts,
  // the temple's bottom step 0.2, the doghouse's food bowl 0.22) used to
  // pass the SOLID_EPS test and steal the neighbouring tile of open grass:
  // getStackHeight skipped the invisibly-claimed cell, so the first block
  // dropped there landed one level up, floating — and settledAt vouched for
  // it, which is why vh-dev-invariant never fired. A piece must now cover
  // ≥ CLAIM_COVER_MIN of a foreign tile's ground area to claim it. 0.30
  // sits in a measured gap: grazes top out at 20% (temple step) and the
  // smallest genuine fill is 42.5% (stonehenge's courtyard sarsen), so
  // there is ~10 points of margin either side. Inside the recipe's own
  // columns the generous rule stands — spire tips and upper storeys must
  // stay unbuildable however thin they are.
  M.CLAIM_COVER_MIN = 0.30;

  function blockedCellsFor(model, cells) {
    const claimed = new Set(cells.map(c => c.gx + ',' + c.gy + ',' + c.gz));
    const ownCols = new Set(cells.map(c => c.gx + ',' + c.gy));
    const out = new Map();
    model.forEach(p => {
      const box = E.pieceAABB(p.gx, p.gy, p.gz, p.sxy, p.sz, p.sy);
      for (let gx = Math.floor(box.x0); gx < Math.ceil(box.x1); gx++) {
        for (let gy = Math.floor(box.y0); gy < Math.ceil(box.y1); gy++) {
          for (let gz = Math.max(0, Math.floor(box.z0)); gz < Math.ceil(box.z1); gz++) {
            const key = gx + ',' + gy + ',' + gz;
            if (claimed.has(key) || out.has(key) || !W.isOnPlatform(gx, gy)) continue;
            if (!E.aabbOverlap(E.cellAABB(gx, gy, gz), box, E.SOLID_EPS)) continue;
            if (!ownCols.has(gx + ',' + gy)) {
              const cover =
                Math.max(0, Math.min(gx + 1, box.x1) - Math.max(gx, box.x0)) *
                Math.max(0, Math.min(gy + 1, box.y1) - Math.max(gy, box.y0));
              if (cover < M.CLAIM_COVER_MIN) continue;
            }
            out.set(key, { gx, gy, gz });
          }
        }
      }
    });
    return [...out.values()];
  }
  M.blockedCellsFor = blockedCellsFor; // world.js re-derives on load

  // ── Perch geometry (ONE source of truth) ────────────────────
  // For the cell DIRECTLY BELOW (gx,gy,gz): the best ground-area coverage
  // by any monument piece with real presence in that cell, and the air gap
  // between gz and the top of that solid. Consumed by the tumble physics
  // (world.js), the invariant, and the dev harnesses — keep them all
  // pointed HERE. The thresholds come from the measured 49-column table in
  // HANDOFF.md: crystal (gap ≤0.16, cover 59–85%) and doghouse (0.21,
  // 100%) stay stackable; gardens (5% cover) and eiffel (12%) tumble.
  M.PERCH_MIN_COVER = 0.5;
  M.PERCH_MAX_GAP = 0.25;
  M.perchUnder = (gx, gy, gz) => {
    const below = gz - 1;
    const cell = E.cellAABB(gx, gy, below);
    let cover = 0, top = -Infinity;
    W.monuments.forEach(mon => {
      mon.model.forEach(p => {
        const box = E.pieceAABB(p.gx, p.gy, p.gz, p.sxy, p.sz, p.sy);
        if (box.z1 <= below || box.z0 >= below + 1) return;
        if (!E.aabbOverlap(cell, box, E.SOLID_EPS)) return;
        const c =
          Math.max(0, Math.min(gx + 1, box.x1) - Math.max(gx, box.x0)) *
          Math.max(0, Math.min(gy + 1, box.y1) - Math.max(gy, box.y0));
        if (c > cover) cover = c;
        // clamp to the cell top: a piece poking past it into the resting
        // thing's own cell reads as gap 0 — seated, not floating
        if (c > 0.02) top = Math.max(top, Math.min(box.z1, below + 1));
      });
    });
    return { cover, gap: top === -Infinity ? Infinity : gz - top };
  };

  // Build a monument in world space and add it to the world. The ceremony
  // passes pending:true (the rise animation reveals it); the dev gallery
  // instantiates fully-revealed monuments directly.
  // A quarter turn swaps a piece's axes (see fp below); a mark that names
  // an axis has to turn with it.
  // A mark ending in X/Y names an axis in MODEL space (gateX, terraceY…); an odd quarter turn swaps it.
  const rotMark = (m, k) => (k % 2 === 1 && /X$/.test(m)) ? m.slice(0, -1) + 'Y' : (k % 2 === 1 && /Y$/.test(m)) ? m.slice(0, -1) + 'X' : m;
  M.instantiate = (recipe, ox, oy, oz, k, opts = {}) => {
    const pending = !!opts.pending;
    const maxDz = Math.max(...recipe.model.map(e => e[2] + e[4]));
    const model = recipe.model.map(e => {
      const [rx, ry] = rot(e[0], e[1], k);
      // Footprint: a number = square, [sx, sy] = rectangular. A quarter
      // turn (odd k) swaps the axes — a beam long in x becomes long in y.
      const fp = Array.isArray(e[3]) ? e[3] : [e[3], e[3]];
      const [sx, sy] = (k % 2 === 1) ? [fp[1], fp[0]] : fp;
      return {
        gx: ox + rx, gy: oy + ry, gz: oz + e[2],
        sxy: sx, sy, sz: e[4], color: e[5], glow: !!e[6],
        sign: e[7] || false, // a MARK KEY into world.js SIGN_MARKS ('prudential', 'bny')
        win: e[8] || 0,
        mark: rotMark(e[9] || '', k), // a face PATTERN painted by drawBlock (see the format note)
        // appearAt drives the mallet notes AND the hologram's per-layer
        // lighting (bottom-up); the MATTER now arrives all at once at
        // TRANSFORM_AT, decoupled from this schedule.
        appearAt: 0.7 + (e[2] / maxDz) * 0.75,
        pop: pending ? 0 : 1,
        lit: pending ? 0 : 1, // hologram layer-light, ramped after appearAt
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
      lift: 0, // hover lift (grid units) — eased in M.update, like blocks
    };
    monument.blocked = blockedCellsFor(model, monument.cells);
    W.monuments.push(monument);
    W.markDirty();
    return monument;
  };

  // ── Ceremony tuning ─────────────────────────────────────────
  // GATHER is the beat the MUSIC is written to (sfx.js schedules the
  // whole phrase up front: true silence at 0.66, bell at 0.70) — the
  // smash must land on it. FLOAT_CUT gives the flash frame cover.
  const GATHER = 0.7;       // seconds of vortex before the smash
  const FLOAT_CUT = 0.75;   // floaters draw until here (flash covers the cut)
  const TAU = Math.PI * 2;
  const TURNS = 1.25;       // revolutions over the gather (angle ∝ p²: slow start, whip finish)
  const R_FLOOR = 0.35;     // min orbit radius — full overlap gives the occlusion
                            // sort no separating axis and blocks pop in draw order
  // The hologram arc, keyed to the pre-scheduled music (sfx.js): bell
  // at 0.70 births the silhouette dim; one mallet note per layer 0.70 →
  // ~1.45 lights it bottom-up, brighter and brighter; the crossfade
  // then dissolves light into matter as ONE object — no stagger. The
  // settle note at 1.55 lands mid-crossfade. Ceremony still ends at 2.0.
  const HOLO_IN = 0.12;       // silhouette blooms in after the smash
  const LIT_RAMP = 0.25;      // seconds for one layer to light after its note
  const TRANSFORM_AT = 1.45;  // all matter arrives together from here
  const XFADE = 0.22;         // light dissolves as stone fades up

  // The ONE source of truth for where a swirling floater is — the draw
  // path and the shadow path both read this. (Forking the interpolation
  // between them is exactly the bodyBoxes class of bug.)
  // Returns grid position + the stretch scales; caller applies dip.
  function floaterPose(c, f, p, ease, riseEase) {
    if (E.reducedMotion) {
      // Honest reduced-motion answer: no orbit at all. The blocks stay
      // put, rise a hair, and cross-fade out under the flash (the fade
      // lives in drawFloater; a small-amplitude spiral is still a spiral).
      return { gx: f.gx, gy: f.gy, gz: f.gz + riseEase * 0.15, sxy: 1, sz: 1 };
    }
    // The vortex: angle accelerates (p²), radius collapses, rise leads
    // (riseEase finishes ~60% in — blocks clear the monument's height
    // before they travel, which keeps them out of its rising model).
    const theta = f.theta0 + TURNS * TAU * p * p * (1 + f.phase * 0.15);
    const r = Math.max(R_FLOOR, f.r0 * Math.pow(1 - p, 1.6));
    // Stretch along the fling — drawn out vertically mid-swirl, easing
    // back to a clean cube for the impact frame (same trick as the
    // launch stretch in world.js: squash = -0.18, "stretch as it leaves").
    const st = Math.sin(Math.min(1, p * 1.25) * Math.PI); // 0 → 1 → 0
    return {
      gx: c.cx - 0.5 + Math.cos(theta) * r,
      gy: c.cy - 0.5 + Math.sin(theta) * r,
      gz: f.gz + riseEase * f.rise,
      sxy: 1 - st * 0.18,
      sz: 1 + st * 0.35,
    };
  }

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
    // Shut the plan you were following: the row should show the monument
    // you just earned, not the blueprint you no longer need. It's one tap
    // away again whenever you want to rebuild it.
    if (M.plansOpen.delete(recipe.id)) savePlans();
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
      // Vortex seeds: each block enters the spiral from where it stood
      // (theta0/r0 are its true polar offset from the centre); phase
      // de-syncs the turn counts so the flock never moves as one rigid
      // body. (The old spin/spinVel drove a 2D sprite rock in
      // drawFloater — half of the "flat card" read; gone with it.)
      floaters: blocks.map(b => {
        const dx = b.gx - (cx - 0.5), dy = b.gy - (cy - 0.5);
        return {
          gx: b.gx, gy: b.gy, gz: b.gz, color: b.color,
          rise: Math.max(1.1, clearTop + 0.4 - b.gz),
          r0: Math.max(R_FLOOR, Math.hypot(dx, dy)),
          theta0: Math.atan2(dy, dx),
          phase: Math.random(),
        };
      }),
      monument,
      flashed: false,
    });

    // Falling blocks above the pattern re-aim: the monument's volume is
    // solid from this instant, and nothing may land inside it.
    W.retargetFalling();

    // The ceremony's WHOLE sound phrase (gather → silence → bell → the
    // melodic rise → settle) is scheduled here, up front, on the audio
    // clock — per-frame triggering would smear the melody on any hitch.
    // One note per LAYER: cubes at the same height share an appearAt, so
    // note times reuse that exact expression and note + pop-in are
    // frame-locked by construction.
    if (VH.sfx && VH.sfx.ceremony) {
      const byDz = new Map();
      monument.model.forEach(m => {
        // Quantised to quarter-cells: detailed models have MANY distinct
        // fractional dz values, and one note per exact dz would be a
        // slot-machine trill. Grouped, a course of trim joins its wall.
        const dz = Math.round((m.gz - oz) * 4) / 4;
        let L = byDz.get(dz);
        if (!L) byDz.set(dz, L = { at: m.appearAt, n: 0, sx: 0, sy: 0, gz: m.gz });
        L.n++; L.sx += m.gx + 0.5; L.sy += m.gy + 0.5;
      });
      const layers = [...byDz.values()]
        .map(L => ({ at: L.at, n: L.n, gx: L.sx / L.n, gy: L.sy / L.n, gz: L.gz }))
        .sort((a, b) => a.at - b.at);
      VH.sfx.ceremony({ layers, center: { gx: cx, gy: cy, gz: cz } });
    }
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
    // Hover lift — the block treatment (world.js) applied to whole
    // monuments: same 0.12 target, same easing rate, snapped at rest so
    // the offset can't leave gz math permanently fractional. Gated off
    // while pending (the ceremony owns the rise), while dragging (the
    // ghost owns it — two owners of one property is this project's
    // most-repeated bug), and while any live block rests ON the monument:
    // the buried-block rule. Rising into a block that stays put reads as
    // a glitch; the grab cursor still carries the feedback. The support
    // test only runs for the one hovered monument (short-circuit), and
    // floor(gz - 0.001) maps a block perched at fractional height onto
    // the occupancy cell of the piece holding it up.
    W.monuments.forEach(mon => {
      const target = (mon === W.hoveredMonument && !mon.pending && !mon._dragging &&
        !W.blocks.some(b => W.isLive(b) &&
          W.at(b.gx, b.gy, Math.floor(b.gz - 0.001)) === mon)) ? 0.12 : 0;
      const cur = mon.lift || 0; // undefined on the raw-load fallback path
      let next = cur + (target - cur) * Math.min(1, 12 * dt);
      if (Math.abs(next - target) < 0.001) next = target;
      mon.lift = next;
    });

    for (let i = ceremonies.length - 1; i >= 0; i--) {
      const c = ceremonies[i];
      c.t += dt;

      // The vortex's skirt: a mote or two of ground debris per frame,
      // thrown TANGENTIALLY around the shrinking ring (dx/dy is
      // spawnSoil's travel tilt). Particles draw after the depth sort,
      // so the skirt can never be occluded by the monument — and soil
      // self-gates on reduced motion, but we gate anyway to skip the
      // wasted math. fine:true — crumbs, not calving boulders.
      if (!E.reducedMotion && VH.fx && c.t < GATHER) {
        const p = c.t / GATHER;
        const swirl = 1.5 + p * 2.5;
        const n = 1 + (Math.random() < 0.35 ? 1 : 0);
        for (let k = 0; k < n; k++) {
          const ang = Math.random() * TAU;
          const r = 0.4 + Math.random() * 1.5 * (1 - p * 0.5);
          VH.fx.spawnSoil(
            c.cx - 0.5 + Math.cos(ang) * r,
            c.cy - 0.5 + Math.sin(ang) * r,
            Math.max(0, c.cz - 0.5),
            1,
            { fine: true, up: 2.2 + p * 3, out: 0.8,
              dx: -Math.sin(ang) * swirl, dy: Math.cos(ang) * swirl,
              life: 0.4, lifeSpan: 0.2 });
        }
      }

      if (!c.flashed && c.t >= GATHER) {
        c.flashed = true;
        // The entrance hero's landing weight, given to every ceremony
        // (designer, 2026-08-29): shake + dip were already here, but the
        // HIT-STOP — the world freezing dead on the impact frame — is
        // what makes the hero's landing feel like it moves the platform.
        // Scaled by the monument's size: a doghouse thuds, a bank slams.
        // kickHitStop is render-loop only, so harnesses are unaffected.
        if (!E.reducedMotion) {
          E.kickShake(4); W.kickDip(1.5);
          // A touch more hit-stop than the old drift-and-cut earned:
          // the blocks now genuinely COLLIDE here, and the freeze is
          // what sells mass meeting mass.
          W.kickHitStop(Math.min(0.12, 0.05 + c.recipe.cells.length * 0.005));
        }
        if (VH.fx) {
          VH.fx.spawnDust(Math.round(c.cx - 0.5), Math.round(c.cy - 0.5), Math.max(0, Math.round(c.cz - 0.5)), 14);
          // The bloom (drawn by fx.js flashes — shared with firework detonations)
          // Warm gold, not near-white: an additive white flash over green
          // grass read as a green wash. Smaller reach for the same reason.
          VH.fx.spawnFlash(c.cx, c.cy, c.cz, { dur: 0.45, r0: 2, r1: 5, peak: 0.75, col: '255,208,130' });
          // The compression ring: a fast tight-to-wide pulse reading as
          // the shockwave of the smash itself, under the slower bloom.
          // Gated: spawnFlash does NOT self-gate on reduced motion (unlike
          // spawnSoil/spawnBurst), so stacking a second bloom here would
          // hand a visitor who asked for LESS a brighter combined flash.
          if (!E.reducedMotion) {
            VH.fx.spawnFlash(c.cx, c.cy, c.cz, { dur: 0.28, r0: 0.4, r1: 4.5, peak: 0.5, col: '255,226,170' });
          }
        }
        // (The flash SOUND — the bell — was scheduled with the whole
        // ceremony phrase in startCeremony; nothing to trigger here.)
        showCard(c.recipe);

        // Broken leftovers go up in fireworks on the same beat, so the
        // flash covers the launch and it reads as one event. Gentler
        // velocities than Clear — this must not upstage the ceremony.
        const doomed = collectDoomed(c.monument);
        if (doomed.length) {
          // Sweep-class booms get their own small budget in sfx (darker,
          // quieter, wetter) so they read as distant thuds BEHIND the
          // monument instead of trampling the bell.
          doomed.forEach(b => { b.boomCls = 'sweep'; });
          W.launchBlocks(doomed, { cx: c.cx - 0.5, cy: c.cy - 0.5, force: [1.5, 3], up: [24, 34] });
          W.markDirty();
          W.save(); // AFTER launch: save() filters launching blocks out of the payload
        }
        W.resettle(); // physics owns whatever the sweep's policy spared
      }

      // The crescendo, then the crossfade. appearAt lights each layer's
      // patch of the hologram on its mallet note (bottom-up, brighter
      // and brighter); the matter itself waits and arrives TOGETHER at
      // TRANSFORM_AT — the old per-piece pop stagger was a course-by-
      // course build, not a transformation (designer, 2026-08-31).
      c.monument.model.forEach(m => {
        if (c.t > m.appearAt) m.lit = Math.min(1, m.lit + dt / LIT_RAMP);
        if (c.t >= TRANSFORM_AT) m.pop = Math.min(1, m.pop + dt / XFADE);
      });

      if (c.t >= 2.0) {
        // Theater over: reveal the (already-real) monument permanently
        c.monument.pending = false;
        c.monument.model.forEach(m => { m.pop = 1; m.lit = 1; });
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
      c.monument.model.forEach(m => { m.pop = 1; m.lit = 1; });
    });
    ceremonies.length = 0;
  };

  // easeOutBack for the pop-in
  function backOut(t) {
    const s = 1.5, u = t - 1;
    return u * u * ((s + 1) * u + s) + 1;
  }

  // Deterministic per-piece tonal jitter (-1..1 in 7 steps): stone-course
  // variation with zero state — the same piece always gets the same shade.
  function pieceShade(m) {
    const h = (m.gx * 7.13 + m.gy * 13.7 + m.gz * 29.3) * 31;
    return ((Math.abs(Math.round(h)) % 7) - 3) / 3;
  }

  // Plant any recipe with a `home` {ox, oy, oz?, k?} that isn't already
  // standing — for the RETURNING visitor whose save predates the towers.
  // Three rules, each load-bearing:
  //  · a board that HAS the tower wins, wherever the visitor moved it —
  //    this fills absence, never position;
  //  · a tower in `discovered` but absent was DESTROYED BY CHOICE (the
  //    towers are ordinary monuments; Clear and the void are allowed to
  //    win) — absence persists, Reset is the way back;
  //  · never plant INTO a visitor's build — every footprint column must
  //    be empty, or the plant is skipped entirely.
  // First visits never reach this: runEntrance builds the towers on
  // screen with their ceremonies. Discovery is NOT granted here either —
  // finding a monument stays something the ceremony does.
  M.plantHomes = () => {
    let added = 0;
    RECIPES.forEach(r => {
      if (!r.home) return;
      if (W.monuments.some(m => m.id === r.id)) return;
      if (M.discovered.has(r.id)) return;
      const k = r.home.k || 0;
      const clear = r.cells.every(c => {
        const [rx, ry] = rot(c[0], c[1], k);
        return W.getStackHeight(r.home.ox + rx, r.home.oy + ry) === 0;
      });
      if (!clear) return;
      M.instantiate(r, r.home.ox, r.home.oy, r.home.oz || 0, k);
      added++;
    });
    if (added) W.markDirty();
    return added;
  };

  // Rebuild a SAVED monument from its recipe: the stored cells give origin
  // and rotation (cells were serialised in recipe order), so model art
  // improvements reach existing saves instead of being pinned by them.
  // Returns false for unknown ids / mismatched cells — caller falls back
  // to the stored pieces.
  M.reinstantiate = (id, savedCells) => {
    const recipe = RECIPES.find(r => r.id === id);
    if (!recipe || !Array.isArray(savedCells) ||
        savedCells.length !== recipe.cells.length) return false;
    for (let k = 0; k < 4; k++) {
      const [r0x, r0y] = rot(recipe.cells[0][0], recipe.cells[0][1], k);
      const ox = savedCells[0][0] - r0x;
      const oy = savedCells[0][1] - r0y;
      const oz = savedCells[0][2] - recipe.cells[0][2];
      let ok = true;
      for (let i = 0; i < recipe.cells.length; i++) {
        const [rx, ry] = rot(recipe.cells[i][0], recipe.cells[i][1], k);
        const c = savedCells[i];
        if (c[0] !== ox + rx || c[1] !== oy + ry || c[2] !== oz + recipe.cells[i][2]) { ok = false; break; }
      }
      if (ok) { M.instantiate(recipe, ox, oy, oz, k); return true; }
    }
    return false;
  };

  // ONE shadow gate for monument pieces, shared by the permanent pass
  // (game.js) and the ceremony pass below — it must be the same test or a
  // piece's shadow pops in/out at t=2.0 when pending flips. Gates on the
  // LARGEST dimension (like drawBlock's outline gate): tiny trim casts
  // nothing, but a tall thin piece — the eiffel's upper shaft, a mast —
  // still casts. (The old footprint-only test made thin spires shadowless.)
  M.castsShadow = (m) => Math.max(m.sxy, m.sy, m.sz) >= 0.3;

  // The GLOBAL sorter: game.js hands the whole frame's draw items (player
  // blocks + everything pushed below) to occlusionOrder in one pass, so a
  // block against a monument sorts by the pieces' REAL extents. The old
  // contract merged monuments into the block sort by a multiset of
  // base-cell depth keys (a rank permutation) — a piece's key ignored its
  // footprint, so a 4-cell lintel sorted as a 1-cell post at its centre
  // and mis-ordered against player blocks mid-rotation (the "glitchy
  // while rotating" bug: near-clean at the four rest angles, dozens of
  // wrong pairs in between).
  M.occlusionOrder = occlusionOrder;

  // Contribute draw items for monuments + ceremony theater. Each item
  // carries its true box (gx/gy/gz/sxy/sy/sz) plus a draw closure;
  // ordering is game.js's job now, in one global pass.
  M.pushEntries = (entries, dip) => {
    W.monuments.forEach(mon => {
      if (mon.pending) return; // still mid-ceremony; its ceremony contributes below
      const op = mon._dragging ? 0.45 : 1; // dimmed while being carried
      // Hover lift rides the SORT KEY as well as the draw — offsetting the
      // pixels but not the entry's gz would make a lifted monument sort
      // behind things it is now visually in front of. tex/flower seeding
      // stay on the LOGICAL piece (unlifted), per the anti-crawl contract.
      const lift = mon.lift || 0;
      mon.model.forEach(m => {
        entries.push({
          gx: m.gx, gy: m.gy, gz: m.gz + lift, sxy: m.sxy, sy: m.sy, sz: m.sz,
          // shade: deterministic per-piece tonal jitter — free stone-course
          // variation. contact: ground courses read as seated, not placed.
          // 'grass' is the gardens' greenery and nothing else's among
          // the monuments, so the colour IS the "plant here" signal —
          // no new field on any model. Flowers draw immediately after
          // their own piece, which keeps them correctly occluded by
          // anything sorted in front.
          draw: () => {
            W.drawBlock(m.gx, m.gy, m.gz + lift - dip, m.color, op,
              { styled: true, sxy: m.sxy, sy: m.sy, sz: m.sz, tex: m,
                shade: pieceShade(m), contact: m.gz === 0 });
            if (m.color === 'grass') {
              W.drawFlowers(m.gx, m.gy, m.gz + lift - dip, m.sxy, m.sy, m.sz, m, op);
            }
          },
        });
      });
    });

    // Ceremony theater joins the SAME depth-sorted pass as everything
    // else. It used to paint on top of the world after the sort — one of
    // the two root causes of "blocks glitch through each other": correct
    // occlusion was impossible by construction.
    ceremonies.forEach(c => {
      if (c.t < FLOAT_CUT) {
        // Gathering: the vortex. Consumed blocks spiral inward — angle
        // accelerating, radius collapsing, stretched along the fling —
        // and smash together at the centre on the music's bell.
        // floaterPose is the single source of truth for the motion
        // (the shadow pass reads the same function).
        const p = Math.min(1, c.t / GATHER);
        const ease = 1 - Math.pow(1 - p, 2);
        const riseEase = 1 - Math.pow(1 - Math.min(1, p * 1.6), 2);
        c.floaters.forEach(f => {
          const pose = floaterPose(c, f, p, ease, riseEase);
          entries.push({
            gx: pose.gx, gy: pose.gy, gz: pose.gz,
            sxy: pose.sxy, sy: pose.sxy, sz: pose.sz,
            draw: () => drawFloater(f, pose, ease, dip),
          });
        });
      }

      // (The flash is spawned at the c.flashed moment and drawn by
      // fx.js's shared flash system after the sorted pass.)

      // The rising model — full-size boxes (the pop scale only shrinks a
      // piece INSIDE its box), so nothing snaps when pending flips at
      // t=2.0. The hologram silhouette is NOT drawn here: it renders as
      // one union into the engine's holo buffer (M.drawHologram, called
      // after the sorted pass) — per-piece additive ghosts in this pass
      // piled up at every overlap and drew seams down the silhouette.
      if (c.t >= GATHER) {
        c.monument.model.forEach(m => {
          if (m.pop <= 0) return;
          entries.push({
            gx: m.gx, gy: m.gy, gz: m.gz, sxy: m.sxy, sy: m.sy, sz: m.sz,
            draw: () => {
              const pop = backOut(m.pop);
              // tex is the LOGICAL piece — mark counts stay pinned to the
              // true size while the drawn basis pops, so texture scales
              // smoothly with the piece instead of re-tiling every frame
              const cop = Math.min(1, m.pop * 2);
              W.drawBlock(m.gx, m.gy, m.gz - dip, m.color, cop,
                { styled: true, sxy: m.sxy * pop, sy: m.sy * pop, sz: m.sz * pop, tex: m,
                  shade: pieceShade(m), contact: m.gz === 0 });
              if (m.color === 'grass') {
                W.drawFlowers(m.gx, m.gy, m.gz - dip,
                  m.sxy * pop, m.sy * pop, m.sz * pop, m, cop);
              }
            },
          });
        });
      }
    });
  };

  // Ceremony shadow casters — the fix for "the shadow blinks into place".
  // The old flow had a ~2s shadow hole: the source blocks left W.blocks at
  // t=0 (their shadows vanished that frame), floaters cast nothing, the
  // pending monument was skipped by the shadow pass, and the full shadow
  // snapped on in one frame when pending cleared at t=2.0. Now the shadow
  // follows the theater: floaters cast from their LIVE rising position, and
  // each model piece casts a shadow that grows with the same backOut(pop)
  // scale the draw uses — so the handoff at t=2.0 is seamless by
  // construction. heightFade is passed in from game.js (the same falloff
  // every other caster uses); blur bucketing follows automatically because
  // it keys off the caster's top height.
  M.pushShadowCasters = (dip, heightFade) => {
    ceremonies.forEach(c => {
      if (c.t < FLOAT_CUT) {
        // Same floaterPose as the draw path — one source of truth, so
        // a shadow can never detach from its swirling block.
        const p = Math.min(1, c.t / GATHER);
        const ease = 1 - Math.pow(1 - p, 2);
        const riseEase = 1 - Math.pow(1 - Math.min(1, p * 1.6), 2);
        c.floaters.forEach(f => {
          const pose = floaterPose(c, f, p, ease, riseEase);
          E.addShadowBox(pose.gx, pose.gy, pose.gz, pose.sxy, pose.sz,
            heightFade(pose.gz + pose.sz), dip);
        });
      }
      if (c.t >= GATHER) {
        c.monument.model.forEach(m => {
          if (m.pop <= 0 || !M.castsShadow(m)) return;
          const pop = backOut(m.pop);
          E.addShadowBox(m.gx, m.gy, m.gz, m.sxy * pop, m.sz * pop,
            heightFade(m.gz + m.sz * pop) * Math.min(1, m.pop * 2), dip, m.sy * pop);
        });
      }
    });
  };

  // ── The hologram reveal ─────────────────────────────────────
  // (designer, 2026-08-31: "the silhouette shows up, gets brighter and
  // brighter, and then transforms into the monument")
  // Every model piece renders OPAQUE into the engine's offscreen holo
  // buffer — overlaps merge, so N boxes composite as ONE union of warm
  // light with no internal seams — then the buffer blits onto the
  // scene once, additively, at `strength`. The arc rides the music:
  // born dim at the bell (0.70), each mallet note lights its layer
  // (m.lit, bottom-up, 0.70→1.45), peak at TRANSFORM_AT, then the
  // crossfade hands brightness to the arriving matter. Drawn after the
  // depth-sorted pass: a hologram is light, it glows through the world
  // the same way flashes and particles do.
  M.drawHologram = (dip) => {
    if (!ceremonies.length) return;
    ceremonies.forEach(c => {
      if (c.t < GATHER) return;
      const born = Math.min(1, (c.t - GATHER) / HOLO_IN);
      let litFrac = 0;
      c.monument.model.forEach(m => { litFrac += m.lit; });
      litFrac /= Math.max(1, c.monument.model.length);
      const x = Math.max(0, Math.min(1, (c.t - TRANSFORM_AT) / XFADE));
      let strength = born * (0.45 + 0.55 * litFrac) * (1 - x);
      // Reduced motion keeps the hologram (a brightness ramp, not
      // motion) but softer — no hot peak.
      if (E.reducedMotion) strength *= 0.6;
      if (strength <= 0.005) return;
      E.holoBegin();
      E.holoDraw((hctx) => {
        c.monument.model.forEach(m => {
          W.drawHoloBlock(hctx, m.gx, m.gy, m.gz - dip, {
            sxy: m.sxy, sy: m.sy, sz: m.sz,
            lum: 0.35 + 0.65 * m.lit, // unlit layers dim, lit layers full
          });
        });
      });
      E.holoComposite(strength);
      // The silhouette spills real light on the island, handing off to
      // the monument's own glow pieces as the crossfade completes.
      const sc = E.toScreen(c.cx, c.cy, Math.max(0.5, c.cz) - dip);
      E.addLight(sc.x, sc.y, E.TILE * E.SCALE * 5, '255,233,184', 0.18 * strength);
      E.addPoint(c.cx, c.cy, Math.max(0.5, c.cz), 5, '255,233,184', 0.45 * strength, { faces: true, ground: true });
    });
  };

  // No ctx.rotate here, deliberately: spinning the projected iso sprite
  // in 2D was half the "flat card" read (the faces keep their shear at
  // any angle, so it reads as a card flapping, not a cube tumbling).
  // The orbit + stretch in floaterPose carry the motion instead.
  function drawFloater(f, pose, ease, dip) {
    const ctx = E.ctx;
    const gz = pose.gz - dip;
    // Reduced motion: the no-orbit path cross-fades the block out under
    // the flash instead of consuming it in a smash it never flew into.
    const alpha = E.reducedMotion ? Math.max(0, 1 - ease) : 1;
    if (alpha <= 0) return;
    W.drawBlock(pose.gx, pose.gy, gz, f.color, alpha,
      { styled: true, sxy: pose.sxy, sy: pose.sxy, sz: pose.sz });
    // The charge glow: a radial falloff sized to the block plus a real
    // entry in the bloom pass — light ON the cube, not paint over it.
    // (The old version fillRect'd a screen-aligned #fff6d8 rectangle at
    // up to 0.55 alpha: the literal flat card the designer called out.)
    if (ease > 0.01) {
      const center = E.toScreen(pose.gx + 0.5, pose.gy + 0.5, gz + 0.5);
      const t = E.TILE * E.SCALE;
      const r = t * (1.1 + ease * 0.5) * Math.max(pose.sxy, pose.sz);
      const a = 0.38 * ease * alpha;
      const grad = ctx.createRadialGradient(center.x, center.y, r * 0.15,
        center.x, center.y, r);
      grad.addColorStop(0, 'rgba(255,246,216,' + a.toFixed(3) + ')');
      grad.addColorStop(1, 'rgba(255,246,216,0)');
      ctx.globalCompositeOperation = 'lighter';
      ctx.fillStyle = grad;
      ctx.fillRect(center.x - r, center.y - r, r * 2, r * 2);
      ctx.globalCompositeOperation = 'source-over';
      E.addLight(center.x, center.y, r * 2.2, '255,238,190', 0.10 * ease * alpha);
    }
  }

  // Warm glow for monument cells flagged glow (lighthouse lamp, gold tip)
  // — registered as LIGHTS for the bloom pass, not painted gradients.
  // A lit SIGN (the Prudential band) glows its own blue and holds STEADY:
  // flame and gilt flicker, corporate signage does not.
  // ── Idle life ────────────────────────────────────────────────
  // One quiet behaviour per monument that has a reason to move at night:
  // the lighthouse sweeps, the tower's late shift comes and goes (that
  // one lives in world.js with the windows), the Eiffel beacon sparkles
  // on the hour, torches burn inside the Colosseum, a lantern hangs at
  // the torii, the Crystal Palace breathes. All of it is LIGHT — bloom
  // entries and a few 'lighter' pixels — so the sorted world is
  // untouched and reduced motion simply holds each one still.
  const centreOf = (mon) => {
    if (!mon._centre) {
      let sx = 0, sy = 0;
      mon.cells.forEach(c => { sx += c.gx; sy += c.gy; });
      mon._centre = { gx: sx / mon.cells.length + 0.5, gy: sy / mon.cells.length + 0.5 };
    }
    return mon._centre;
  };
  const IDLE = {
    lighthouse(mon, t, time, rm) {
      // The lamp room: a STEADY warm glow. It deliberately does not read
      // the beam's direction. The halo used to widen and brighten as the
      // beam swung toward the camera, and because the bloom buffer is
      // composited over the whole scene, that bled onto the tower next
      // door — the last remaining way the sweeping beam could change a
      // pixel on somebody else's monument. One flicker term only, so the
      // island is completely still as the beam turns.
      const lamp = mon.model.find(m => m.color === 'lamp');
      if (!lamp) return;
      const b = beamFor(mon, time, rm);
      const flick = b ? b.strength : 1;
      const top = E.toScreen(lamp.gx + 0.5, lamp.gy + 0.5, lamp.gz + lamp.sz / 2);
      E.addLight(top.x, top.y, t * 1.5, '255,236,170', 0.34 * flick);
      E.addPoint(lamp.gx + 0.5, lamp.gy + 0.5, lamp.gz + lamp.sz / 2, 2.2, '255,236,170', 0.4 * flick, { faces: true, ground: true });
    },
    eiffel(mon, t, time, rm) {
      // On the hour, the tower glitters: a two-second scatter of white
      // sparks up its height. Reduced motion keeps the beacon only.
      if (rm) return;
      const phase = time % 26;
      if (phase > 2.4) return;
      const ctx = E.ctx;
      const base = mon.model[0];
      const cx = base.gx + 0.5, cy = base.gy + 0.5;
      const env = Math.sin((phase / 2.4) * Math.PI);
      const rnd = E.hashRand(Math.floor(time * 18), 3, 7); // new scatter each 1/18 s
      ctx.save();
      ctx.globalCompositeOperation = 'lighter';
      ctx.fillStyle = '#fff6dc';
      for (let k = 0; k < 7; k++) {
        const z = 0.3 + rnd() * 4.2;
        const w = 0.55 * (1 - z / 5.2) + 0.08;
        const p = E.toScreen(cx + (rnd() - 0.5) * w, cy + (rnd() - 0.5) * w, z);
        const on = rnd() < 0.7 * env;
        if (!on) continue;
        const sz = Math.max(1, 1.6 * E.SCALE);
        ctx.globalAlpha = 0.85;
        ctx.fillRect(p.x - sz / 2, p.y - sz / 2, sz, sz);
        if (k < 3) E.addLight(p.x, p.y, t * 0.5, '255,246,220', 0.25);
      }
      ctx.restore();
    },
    colosseum(mon, t, time, rm) {
      // Torches in the arena: a low warm flicker inside the ring.
      const c = centreOf(mon);
      const f = rm ? 1 : 0.8 + 0.2 * Math.sin(time * 6.3) * Math.sin(time * 2.1 + 1);
      const p = E.toScreen(c.gx, c.gy, 0.35);
      E.addLight(p.x, p.y, t * 1.9, '255,170,80', 0.14 * f);
      E.addPoint(c.gx, c.gy, 0.35, 2.4, '255,170,80', 0.4 * f, { faces: true, ground: true });
    },
    torii(mon, t, time, rm) {
      // The shrine lantern: hangs at the plaque, breathes slowly.
      const plaque = mon.model.find(m => m.color === 'gold');
      if (!plaque) return;
      const f = rm ? 1 : 0.85 + 0.15 * Math.sin(time * 1.3);
      const p = E.toScreen(plaque.gx + 0.5, plaque.gy + 0.5, plaque.gz - 0.15);
      E.addLight(p.x, p.y, t * 1.5, '255,200,110', 0.16 * f);
      E.addPoint(plaque.gx + 0.5, plaque.gy + 0.5, plaque.gz - 0.15, 2.2, '255,200,110', 0.4 * f, { faces: true, ground: true });
    },
    crystal(mon, t, time, rm) {
      // A greenhouse at night keeps a cool light on inside.
      const c = centreOf(mon);
      const f = rm ? 1 : 0.8 + 0.2 * Math.sin(time * 0.7);
      const p = E.toScreen(c.gx, c.gy, 0.6);
      E.addLight(p.x, p.y, t * 2.6, '190,225,255', 0.11 * f);
      E.addPoint(c.gx, c.gy, 0.6, 3, '190,225,255', 0.3 * f, { faces: true, ground: true });
    },
  };

  // ── The lighthouse beam ──────────────────────────────────────
  // A shaft of light in the SKY, and nothing else. It does not light any
  // object, does not stop at any object, and is not sorted against any
  // object (Viet, session 20: "let's not have the beam interact with any
  // of the objects" — every version that touched the monuments read as
  // patchy or flashing on a built mass, because a monument is dozens of
  // small pieces and a moving cone edge crosses them one at a time).
  //
  // Two consequences make it glitch-proof by construction:
  //   * it climbs (BEAM.rise) instead of aiming at the island, so it
  //     always sweeps up-screen into empty sky;
  //   * it is drawn in the SKY layer, before the platform and the world,
  //     so anything standing in front of it simply paints over it.
  // The lamp room's own glow (IDLE.lighthouse) is a separate, stationary
  // point light and is unchanged.
  const BEAM = { far: 9.5, hw: 2.6, rise: 0.25, alpha: 0.5, gain: 0.32, focus: 2.5, speed: 0.4, angle: null };
  // far   — length of the shaft in cells       hw    — half-width at the far end
  // rise  — climb per cell travelled (0.25 ≈ a lighthouse aimed at the horizon)
  // alpha — weight of the shaft in the air     gain  — weight of the light on surfaces
  // focus — how spotlight-like the surface light is. 0 = a plain directional
  //         wash over the whole island; higher = tighter around the beam's
  //         heading. It is an exponent on a cosine, so it is smooth at every
  //         value — there is no in/out edge to sweep across a monument.
  // angle — dev pin, radians; null = sweeping
  M.BEAM = BEAM; // dev: BEAM.angle (radians) pins the sweep for screenshots
  function beamFor(mon, time, rm) {
    if (mon.id !== 'lighthouse' || mon.pending) return null;
    const lamp = mon.model.find(m => m.color === 'lamp');
    if (!lamp) return null;
    const ang = BEAM.angle != null ? BEAM.angle : rm ? 0.8 : time * BEAM.speed;
    // unit axis: out along the sweep, and up by BEAM.rise
    const n = Math.hypot(1, BEAM.rise);
    return {
      gx: lamp.gx + 0.5, gy: lamp.gy + 0.5, gz: lamp.gz + lamp.sz * 0.55,
      dx: Math.cos(ang), dy: Math.sin(ang),
      ax: Math.cos(ang) / n, ay: Math.sin(ang) / n, az: BEAM.rise / n,
      far: BEAM.far, hw: BEAM.hw,
      strength: rm ? 1 : 0.92 + 0.08 * Math.sin(time * 5.1),
    };
  }
  // The beam lights surfaces the way a game engine's directional light
  // does: ONE brightness per face ORIENTATION, computed from the beam's
  // heading against the face's normal. Every piece of a wall shares a
  // normal, so a whole wall brightens and dims in perfect unison — which
  // is precisely what four earlier attempts could not achieve, because
  // they asked each PIECE "are you inside the cone?" and that question
  // has a hard yes/no edge that crosses a monument one piece at a time.
  // Orientation has no edge. Published as E.beamLit for W.drawBlock.
  M.registerBeams = () => {
    const time = VH.clock.time, rm = !!E.reducedMotion;
    E.beamLit = null;
    W.monuments.forEach(mon => {
      const b = beamFor(mon, time, rm);
      if (!b) return;
      E.addBeam(b);
      E.beamLit = {
        // how squarely each face orientation meets the beam (0..1)
        px: Math.max(0, -b.ax), nx: Math.max(0, b.ax),
        py: Math.max(0, -b.ay), ny: Math.max(0, b.ay),
        top: Math.max(0, -b.az),
        gx: b.gx, gy: b.gy,            // the lamp: FIXED, so the distance
        dx: b.dx, dy: b.dy,            // falloff below never changes in time
        far: b.far, focus: BEAM.focus,
        gain: BEAM.gain * b.strength,
      };
    });
  };
  // ONE camera-facing sheet (a billboard — what games use for
  // searchlights and sword trails): the triangle contains the lamp→far
  // axis and is turned each frame so its face points at the camera, so it
  // can never show a seam or go edge-on into a thin blade.
  //   facing — 0..1: looking straight down the barrel there is no sheet to
  //            see, only the glow at the lamp room (IDLE.lighthouse).
  function beamSheet(b) {
    const L = { gx: b.gx, gy: b.gy, gz: b.gz };
    const F = { gx: b.gx + b.ax * b.far, gy: b.gy + b.ay * b.far, gz: b.gz + b.az * b.far };
    // V: the one world direction that projects to "into the screen" (the
    // iso projection is orthographic, so it is the same for every point).
    // Same vx/vy the depth sort uses, plus z = 1; (1,1,1) at angle 0.
    const vl = Math.hypot(E.cosA + E.sinA, E.cosA - E.sinA, 1);
    const Vx = (E.cosA + E.sinA) / vl, Vy = (E.cosA - E.sinA) / vl, Vz = 1 / vl;
    // W = A x V: across the beam AND across the line of sight — the sheet
    // spanned by A and W is the most face-on a sheet through the axis can
    // be. |A x V| -> 0 when the beam points at/away from the camera, where
    // W is unstable, so the shaft fades out before that matters.
    let wx = b.ay * Vz - b.az * Vy, wy = b.az * Vx - b.ax * Vz, wz = b.ax * Vy - b.ay * Vx;
    const wl = Math.hypot(wx, wy, wz);
    const facing = Math.min(1, wl / 0.35);
    if (facing <= 0) return null;
    if (wl > 1e-6) { wx /= wl; wy /= wl; wz /= wl; }
    const hw = b.hw;
    return { facing, tri: [L,
      { gx: F.gx + wx * hw, gy: F.gy + wy * hw, gz: F.gz + wz * hw },
      { gx: F.gx - wx * hw, gy: F.gy - wy * hw, gz: F.gz - wz * hw }] };
  }
  const sc = (p) => E.toScreen(p.gx, p.gy, p.gz);

  // Drawn LAST, over the finished world, with 'lighter' (additive)
  // blending — never in the depth sort. This is what a real engine does
  // with volumetric light, and it is physically right: a shaft is glowing
  // AIR between the camera and everything else, so it belongs in front of
  // whatever it passes. Drawing it behind the world instead (the previous
  // attempt) chopped it off at the island's silhouette and left a streak
  // floating in the sky, disconnected from its own lamp.
  M.drawBeamShaft = () => {
    for (const b of E.beams) {
      const S = beamSheet(b);
      if (!S) continue;
      E.drawConeSlice(E.ctx, S.tri.map(sc), 0, E.CONE_W, BEAM.alpha * b.strength * S.facing);
    }
  };

  M.drawGlows = () => {
    const t = E.TILE * E.SCALE;
    const time = VH.clock.time, rm = !!E.reducedMotion;
    W.monuments.forEach(mon => {
      const idle = IDLE[mon.id];
      if (idle && !mon.pending) idle(mon, t, time, rm);
      mon.model.forEach(m => {
        if (!m.glow) return;
        const s = E.toScreen(m.gx + 0.5, m.gy + 0.5, m.gz + m.sz / 2);
        const sign = m.sign; // sign-ness is a piece flag, not a colour test
        // Each sign glows its own brand light; flame and gilt stay warm.
        const SIGN_LIGHT = { pruBlue: '130,175,255', bnyTeal: '110,225,205',
                             bnyNavy: '170,205,235' }; // white letters throw a cool-white halo
        const flicker = (sign || E.reducedMotion)
          ? 1 : 0.8 + 0.2 * Math.sin(VH.clock.time * 2.7 + m.gx * 3 + m.gy);
        const rgb = sign ? (SIGN_LIGHT[m.color] || '130,175,255') : '255,214,120';
        E.addLight(s.x, s.y, t * 2.4, rgb, 0.22 * flicker);
        // the glow lights its neighbours too; low pieces pool on the grass
        E.addPoint(m.gx + 0.5, m.gy + 0.5, m.gz + m.sz / 2, 2.4, rgb, 0.4 * flicker,
          { faces: true, ground: m.gz < 1.5 });
      });
    });
  };

  // ── The name card ───────────────────────────────────────────
  // A recipe may carry `card: { title, sub }` — the portfolio towers say
  // who Viet was there ("PRUDENTIAL / SR. PRODUCT DESIGNER · 2018–2021")
  // where a wonder of the world says "discovered". Absent, the old copy
  // stands, so the 13 originals are untouched.
  let cardTimer = null;
  function showCard(recipe) {
    const card = document.getElementById('monumentCard');
    if (!card) return;
    const c = recipe.card || {};
    document.getElementById('mcTitle').textContent = c.title || recipe.name.toUpperCase();
    document.getElementById('mcSub').textContent = c.sub || 'discovered';
    card.classList.add('show');
    clearTimeout(cardTimer);
    cardTimer = setTimeout(() => card.classList.remove('show'), 2800);
  }

  // ── Codex (the collection panel) ────────────────────────────
  // Thumbnails use a tiny standalone iso projector so silhouettes can be
  // drawn without touching the main engine's canvas state.
  // ── Blueprint: the BLOCKS you place, not the monument you get ──────
  // The monument model never resembles its recipe — the torii's gap is
  // CARVED by the transform (see its model comment), so its silhouette
  // shows a gate while the recipe is a SOLID 3x3 wall. Drawing the model
  // as a locked-row hint therefore taught the wrong shape. The blueprint
  // draws recipe.cells as unit cubes instead: real colours, '*' as a
  // neutral "any" cube, and `empty` cells as dashed outlines (the
  // colosseum's hole is part of its recipe and was invisible everywhere).
  // Deliberately does NOT reveal the name or the model — you always know
  // what to build, never what it becomes, so the ceremony stays a reveal.
  function drawBlueprint(canvas2, recipe) {
    const c = canvas2.getContext('2d');
    const Wpx = canvas2.width, Hpx = canvas2.height;
    c.clearRect(0, 0, Wpx, Hpx);
    const cells = recipe.cells.map(e => ({ x: e[0], y: e[1], z: e[2], req: e[3] }));
    const holes = (recipe.empty || []).map(e => ({ x: e[0], y: e[1], z: e[2], hole: true }));
    const all = cells.concat(holes);
    const minX = Math.min(...all.map(p => p.x)), maxX = Math.max(...all.map(p => p.x));
    const minY = Math.min(...all.map(p => p.y)), maxY = Math.max(...all.map(p => p.y));
    const maxZ = Math.max(...all.map(p => p.z)) + 1;
    const span = Math.max(maxX - minX + 1, maxY - minY + 1, maxZ);
    const s = (Math.min(Wpx, Hpx) * 0.86) / (span * 1.6);
    const cx = Wpx / 2, cy = Hpx * 0.9;
    const P = (x, y, z) => ({ x: cx + (x - y) * s, y: cy + (x + y) * s * 0.5 - z * s * 1.25 });
    // Painter's order: back-to-front for unit cubes is just x+y+z
    all.sort((a, b) => (a.x + a.y + a.z) - (b.x + b.y + b.z));
    all.forEach(p => {
      const x0 = p.x - (maxX + minX) / 2, y0 = p.y - (maxY + minY) / 2;
      const k = [
        P(x0, y0, p.z), P(x0 + 1, y0, p.z), P(x0 + 1, y0 + 1, p.z), P(x0, y0 + 1, p.z),
        P(x0, y0, p.z + 1), P(x0 + 1, y0, p.z + 1), P(x0 + 1, y0 + 1, p.z + 1), P(x0, y0 + 1, p.z + 1),
      ];
      const poly = (idx) => {
        c.beginPath();
        c.moveTo(k[idx[0]].x, k[idx[0]].y);
        idx.slice(1).forEach(i => c.lineTo(k[i].x, k[i].y));
        c.closePath();
      };
      if (p.hole) { // a cell that must stay EMPTY
        c.setLineDash([2, 2]);
        c.strokeStyle = 'rgba(184,184,204,0.55)';
        c.lineWidth = 1;
        poly([4, 5, 6, 7]); c.stroke();
        c.setLineDash([]);
        return;
      }
      // '*' cells: a neutral cube meaning "any colour" (the recipe line
      // says so in words too, so a pale cube is never mistaken for white)
      const col = p.req === '*' ? null : (W.COLORS[p.req] || W.COLORS.stone);
      const faces = col
        ? [col.right, col.front, col.top]
        : ['#4a5064', '#3e4356', '#5b6278'];
      poly([1, 2, 6, 5]); c.fillStyle = faces[0]; c.fill();
      poly([3, 2, 6, 7]); c.fillStyle = faces[1]; c.fill();
      poly([4, 5, 6, 7]); c.fillStyle = faces[2]; c.fill();
      c.strokeStyle = 'rgba(0,0,0,0.35)'; c.lineWidth = 0.8;
      poly([1, 2, 6, 5]); c.stroke();
      poly([3, 2, 6, 7]); c.stroke();
      poly([4, 5, 6, 7]); c.stroke();
    });
  }

  // Plain-language recipe, generated from the cell data so it can never
  // drift from the truth. Also surfaces the constraint flags (sameColor,
  // plainOnly, empty) — none of which the game communicates anywhere today.
  function recipeSummary(recipe) {
    const counts = new Map();
    recipe.cells.forEach(c => counts.set(c[3], (counts.get(c[3]) || 0) + 1));
    const parts = [];
    const anyN = counts.get('*') || 0;
    if (anyN) {
      parts.push(anyN + (anyN === 1 ? ' block' : ' blocks') +
        // sameColor and plainOnly are not exclusive — the arc now sets
        // BOTH, and a hint that mentions only one sends a player off to
        // build six matching GLASS blocks and watch nothing happen.
        (recipe.sameColor && recipe.plainOnly ? ', all the same plain color'
          : recipe.sameColor ? ', all the same color'
          : recipe.plainOnly ? ', any plain color' : ', any color'));
    }
    [...counts.entries()].filter(([k]) => k !== '*')
      .forEach(([k, n]) => parts.push(n + ' ' + k));
    // "9 red" alone reads clipped; "2 orange + 2 red blocks" would read
    // clumsy — so only the sole-ingredient case gets the noun
    if (parts.length === 1 && !anyN) parts[0] += ' blocks';
    const xs = recipe.cells.map(c => c[0]), ys = recipe.cells.map(c => c[1]);
    const dims = (Math.max(...xs) - Math.min(...xs) + 1) + ' wide, ' +
      (Math.max(...ys) - Math.min(...ys) + 1) + ' deep, ' +
      (Math.max(...recipe.cells.map(c => c[2])) + 1) + ' tall';
    let out = parts.join(' + ') + ' · ' + dims;
    if (recipe.empty && recipe.empty.length) out += ' · leave the dashed cells empty';
    return out;
  }

  function drawThumb(canvas2, recipe, found) {
    const c = canvas2.getContext('2d');
    const Wpx = canvas2.width, Hpx = canvas2.height;
    c.clearRect(0, 0, Wpx, Hpx);
    // Model bounds → scale to fit
    let minX = 9, maxX = -9, minY = 9, maxY = -9, maxZ = 0;
    recipe.model.forEach(m => {
      const fp = Array.isArray(m[3]) ? m[3] : [m[3], m[3]];
      minX = Math.min(minX, m[0] - fp[0] / 2); maxX = Math.max(maxX, m[0] + fp[0] / 2);
      minY = Math.min(minY, m[1] - fp[1] / 2); maxY = Math.max(maxY, m[1] + fp[1] / 2);
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
        recipe.model.map(m => {
          const fp = Array.isArray(m[3]) ? m[3] : [m[3], m[3]];
          return { gx: m[0], gy: m[1], gz: m[2], sxy: fp[0], sy: fp[1], sz: m[4] };
        }), 1, 0);
    }
    const pieces = recipe._thumbOrder.map(i => recipe.model[i]);
    pieces.forEach(m => {
      const [dx, dy, dz, fpRaw, sz, colorKey] = m;
      const fp = Array.isArray(fpRaw) ? fpRaw : [fpRaw, fpRaw];
      const x0 = dx - (maxX + minX) / 2, y0 = dy - (maxY + minY) / 2;
      const col = found ? (W.COLORS[colorKey] || W.COLORS.stone) : null;
      const hx = fp[0] / 2, hy = fp[1] / 2;
      const corners = [
        P(x0 - hx, y0 - hy, dz), P(x0 + hx, y0 - hy, dz),
        P(x0 + hx, y0 + hy, dz), P(x0 - hx, y0 + hy, dz),
        P(x0 - hx, y0 - hy, dz + sz), P(x0 + hx, y0 - hy, dz + sz),
        P(x0 + hx, y0 + hy, dz + sz), P(x0 - hx, y0 + hy, dz + sz),
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

  // ── Plans (the how-to-build hint) ───────────────────────────
  // EVERY row toggles its plan open and shut — including discovered
  // ones. A found monument is exactly when you most want the recipe
  // again: you pressed Clear and want to rebuild it. Hiding the plan
  // after discovery threw away the reference right when it became
  // useful. Stored in their OWN localStorage key, deliberately not in
  // the save payload, so the v2 format stays untouched.
  const HINT_KEY = 'vh-hints-v1';
  M.plansOpen = new Set();
  try {
    const raw = JSON.parse(localStorage.getItem(HINT_KEY) || '[]');
    if (Array.isArray(raw)) raw.forEach(id => M.plansOpen.add(id));
  } catch (e) { /* corrupt or absent: start closed */ }

  function savePlans() {
    try { localStorage.setItem(HINT_KEY, JSON.stringify([...M.plansOpen])); } catch (e) {}
  }

  M.togglePlan = (id) => {
    const open = !M.plansOpen.has(id);
    if (open) M.plansOpen.add(id); else M.plansOpen.delete(id);
    savePlans();
    M.buildCodex();
    return open;
  };

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
      const isOpen = M.plansOpen.has(r.id);
      if (isFound) found++;
      // Every row is a real button: the plan must be keyboard-reachable
      // and its open/shut state has to announce itself
      const row = document.createElement('button');
      row.type = 'button';
      row.className = 'codex-row' + (isFound ? ' found' : ' locked') + (isOpen ? ' open' : '');
      row.dataset.recipe = r.id;
      row.setAttribute('aria-expanded', String(isOpen));
      row.setAttribute('aria-label',
        (isFound ? r.name + ', discovered. ' : 'Undiscovered monument: ' + r.hint + '. ') +
        (isOpen ? 'Plan: ' + recipeSummary(r) + '. Hide the plan.' : 'Show the plan.'));
      // Open → the blueprint. Shut → the monument if you've earned it, or
      // a neutral "?" plate if you haven't. (A canvas is a replaced
      // element and silently drops ::after, so the plate is a div.) The
      // old monument silhouette is GONE from locked rows on purpose — it
      // showed a shape you can never build.
      let thumb;
      if (isOpen || isFound) {
        thumb = document.createElement('canvas');
        thumb.width = 128; thumb.height = 128; // crisp on retina; CSS sets display size
        thumb.className = 'codex-thumb';
        if (isOpen) drawBlueprint(thumb, r); else drawThumb(thumb, r, true);
      } else {
        thumb = document.createElement('div');
        thumb.className = 'codex-thumb codex-plate';
        thumb.textContent = '?';
        thumb.setAttribute('aria-hidden', 'true');
      }
      const text = document.createElement('div');
      text.className = 'codex-text';
      const name = document.createElement('div');
      name.className = 'codex-name';
      // Stays '???' even when the plan is open — the plan is not the prize
      name.textContent = isFound ? r.name : '???';
      if (isFound) {
        const b = document.createElement('span');
        b.className = 'codex-found';
        b.textContent = 'Discovered'; // matches the card's own word and the header count
        name.appendChild(b);
      }
      const hint = document.createElement('div');
      hint.className = 'codex-hint';
      hint.textContent = r.hint; // ALWAYS the hint — it's the how-to-rebuild reference
      text.appendChild(name); text.appendChild(hint);
      if (isOpen) {
        const plan = document.createElement('div');
        plan.className = 'codex-plan';
        plan.textContent = recipeSummary(r);
        text.appendChild(plan);
      }
      // A VISIBLE affordance, always — a hint system nobody can find is
      // no hint system, and a plan you can't put away is a nuisance
      const toggle = document.createElement('div');
      toggle.className = 'codex-reveal';
      toggle.textContent = isOpen ? 'Hide the plan' : 'Show the plan';
      text.appendChild(toggle);
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
  W.warmCenter = null; // {gx, gy, at} — the arrangement's ground CENTER
                       // (fractional cell coords), consumed by game.js's pool

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
      // Center the pool on the blocks actually PRESENT (their centroid),
      // not on origin+1 — the old hardcoded +1 was only the center for a
      // 3-wide recipe (two cells off for the greatwall, one off in both
      // axes for the obelisk/eiffel).
      const cgx = near.present.reduce((s, b) => s + b.gx, 0) / near.present.length + 0.5;
      const cgy = near.present.reduce((s, b) => s + b.gy, 0) / near.present.length + 0.5;
      W.warmCenter = { gx: cgx, gy: cgy, at: VH.clock.time };
      // The hint's SOUND — a very quiet two-note interval, mostly reverb.
      // sfx retrigger-guards it (replays only for a NEW spot or getting
      // closer, floor 2.5 s) so re-placing can't turn it into a ping.
      if (VH.sfx && VH.sfx.warm) {
        VH.sfx.warm(near.missing, { gx: cgx, gy: cgy, gz: pz },
          near.ox + ',' + near.oy);
      }
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
