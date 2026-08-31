/* ============================================================
   sfx.js — synthesized sound engine (WebAudio, zero assets)
   ON by default; the sound button cycles full → quiet → off and
   persists. (Browsers gate audio behind the first user interaction,
   so the first sound lands on the first click — ensure() resumes
   the context then.)

   Architecture (built once in ensure()):

     voice → pan → bus.in → bus.duck ─┬→ preMaster → limiter → masterVol → out
                                       └ (per-voice send) → reverb → wet ─┘

   - Four buses (ui / impact / blast / music / amb) with different
     default reverb sends: interaction stays dry and close, the
     fireworks live out in the void.
   - The reverb is a generated impulse response — a small hard
     platform (discrete early reflections) inside a huge dark night
     (1.6 s decorrelated decaying-noise tail, progressively darkened).
     No audio files anywhere.
   - One limiter, last in the chain, transparent in normal play.
   - Booms are COALESCED per frame instead of rate-limited: a full
     Clear barrage plays a few full "hero" shells, mid shells without
     the repeating transient, and pours the rest into a crackle bed
     (the sky catching). The old 35 ms cooldown silently swallowed
     Clear's final beat every time (same-tick callback) — gone.
   - Placement "tock" pitch still rises with stack height.
   ============================================================ */
(() => {
  'use strict';
  const VH = (window.VH = window.VH || {});

  const S = (VH.sfx = {});
  const PREF_KEY = 'vh-sound';

  // ── Volume state: 'full' | 'quiet' | 'off' (legacy 'on' = full) ──
  const storedPref = localStorage.getItem(PREF_KEY);
  S.state = storedPref === 'off' ? 'off' : (storedPref === 'quiet' ? 'quiet' : 'full');

  let actx = null;
  let buses = null;        // { ui, impact, blast, music, amb } → { in, duck }
  let preMaster = null;
  let masterVol = null;
  let reverbIn = null;     // send target (convolver input, or delay fallback)
  let wetMaster = null;    // the ONE global wet dial (ships at 0.5 — raise on review)
  let NOISE = null;        // one shared, gently-pinked noise buffer (see below)
  let project = null;      // (gx,gy,gz) → 0..1 screen x, injected by game.js

  // Live-tunable (vh-dev-audio) — restraint is the standing brief:
  // sends ship at HALF their target and get raised on an on-screen review.
  let WET = 0.5;           // global wet scale
  let SPREAD = 0.55;       // stereo width of the platform (0 = mono)
  const BUS_SEND = { ui: 0.06, impact: 0.18, blast: 0.38, music: 0.30, amb: 0.10 };

  const RM = () => !!(VH.engine && VH.engine.reducedMotion);
  const clamp = (v, a, b) => Math.max(a, Math.min(b, v));
  const R = (j) => 1 + (Math.random() * 2 - 1) * j;          // ±jitter, multiplicative
  const Rn = (a, b) => a + Math.random() * (b - a);

  // Voice ceiling — insurance against a pathological board, not a mixer.
  // (A tall ceremony legitimately schedules ~50 short sources ahead, and a
  // hero boom with its roll + crackle sputter is ~10.)
  const MAX_VOICES = 96;
  let activeVoices = 0;

  // ════ 1 · THE GRAPH — the room, buses, limiter, master, state ════

  // ── The room: a generated impulse response ─────────────────────
  // Small hard platform (6 early taps, alternating L/R) in a huge dark
  // void (1.6 s decorrelated noise tail, darkening 5000→1400 Hz, high-
  // passed at 180 Hz so the boom bodies stay punchy instead of muddy).
  function makeIR(ctx, dur) {
    const sr = ctx.sampleRate, n = Math.floor(sr * dur);
    const buf = ctx.createBuffer(2, n, sr);
    const preDelay = Math.floor(sr * 0.020);
    for (let ch = 0; ch < 2; ch++) {
      const d = buf.getChannelData(ch);
      let lp = 0, hp = 0;
      for (let i = preDelay; i < n; i++) {
        const t = (i - preDelay) / (n - preDelay);
        const decay = Math.exp(-5.2 * t);                       // RT60 ≈ 1.5 s
        const density = Math.min(1, (i - preDelay) / (sr * 0.06));
        const x = (Math.random() * 2 - 1) * decay * density;
        const fc = 5000 * Math.pow(1400 / 5000, t);             // progressive darkening
        const a = 1 - Math.exp(-2 * Math.PI * fc / sr);
        lp += (x - lp) * a;
        const b = 1 - Math.exp(-2 * Math.PI * 180 / sr);        // keep lows out of the tail
        hp += (lp - hp) * b;
        d[i] = lp - hp;
      }
      const taps = [0.011, 0.017, 0.029, 0.041, 0.058, 0.079];  // the platform answering
      taps.forEach((ms, k) => {
        const amp = (0.50 - k * 0.06) * (ch === (k & 1) ? 1 : 0.55);
        d[preDelay + Math.floor(ms * sr)] += amp;
      });
    }
    // Hand-scale to a known peak; convolver.normalize=false so the wet
    // level never depends on IR content (tuning stays deterministic).
    let peak = 0;
    for (let ch = 0; ch < 2; ch++) {
      const d = buf.getChannelData(ch);
      for (let i = 0; i < d.length; i++) peak = Math.max(peak, Math.abs(d[i]));
    }
    const s = 0.35 / (peak || 1);
    for (let ch = 0; ch < 2; ch++) {
      const d = buf.getChannelData(ch);
      for (let i = 0; i < d.length; i++) d[i] *= s;
    }
    return buf;
  }

  // Graph construction, split out of ensure(): prime() calls it during
  // idle time after the entrance so the reverb generation (a few ms of
  // pure math) can never land inside the cascade. The context it creates
  // is suspended (silent) until the first user gesture.
  function build() {
    if (!actx) {
      const AC = window.AudioContext || window.webkitAudioContext;
      if (!AC) return null;
      actx = new AC();
      const sr = actx.sampleRate;

      // One shared noise buffer, gently pinked (one-pole LP at 6 kHz,
      // renormalized). The old code allocated a FRESH buffer per sound —
      // during a Clear that was ~1.7M Math.random() calls and ~1.7 MB of
      // GC churn in the most GPU-loaded half-second of the game. A random
      // start offset per play gives better variation than fresh noise did.
      NOISE = actx.createBuffer(1, Math.floor(sr * 2.0), sr);
      {
        const d = NOISE.getChannelData(0);
        const a = 1 - Math.exp(-2 * Math.PI * 6000 / sr);
        let y = 0, peak = 0;
        for (let i = 0; i < d.length; i++) {
          y += ((Math.random() * 2 - 1) - y) * a;
          d[i] = y;
          peak = Math.max(peak, Math.abs(y));
        }
        for (let i = 0; i < d.length; i++) d[i] /= peak || 1;
      }

      // Master chain. preMaster carries the exact old master value, so
      // dry levels are byte-identical to the previous build.
      preMaster = actx.createGain(); preMaster.gain.value = 0.16;
      const limiter = actx.createDynamicsCompressor();
      limiter.threshold.value = -6;
      limiter.knee.value = 0;
      limiter.ratio.value = 20;
      limiter.attack.value = 0.002;
      limiter.release.value = 0.10;
      masterVol = actx.createGain();
      masterVol.gain.value = S.state === 'quiet' ? Math.pow(0.45, 1.8) : 1;
      preMaster.connect(limiter); limiter.connect(masterVol);
      masterVol.connect(actx.destination);

      // The space. Low-core devices skip the convolver for a 2-tap
      // feedback delay (~70% of the effect at ~5% of the CPU).
      wetMaster = actx.createGain();
      wetMaster.gain.value = WET;
      wetMaster.connect(preMaster);
      reverbIn = actx.createGain();
      if ((navigator.hardwareConcurrency || 8) > 4) {
        const conv = actx.createConvolver();
        conv.normalize = false;
        conv.buffer = makeIR(actx, 1.6);
        reverbIn.connect(conv); conv.connect(wetMaster);
      } else {
        const mkTap = (ms) => {
          const dl = actx.createDelay(0.2); dl.delayTime.value = ms / 1000;
          const fb = actx.createGain(); fb.gain.value = 0.55;
          const lp = actx.createBiquadFilter(); lp.type = 'lowpass'; lp.frequency.value = 2200;
          reverbIn.connect(dl); dl.connect(lp); lp.connect(fb); fb.connect(dl);
          lp.connect(wetMaster);
        };
        mkTap(37); mkTap(53);
      }

      // Buses: in → duck → preMaster. The duck sits on the DRY path only,
      // so a ducked sound's reverb tail keeps breathing under the priority
      // sound — which is the nice version.
      buses = {};
      ['ui', 'impact', 'blast', 'music', 'amb'].forEach(name => {
        const inp = actx.createGain(), duck = actx.createGain();
        inp.connect(duck); duck.connect(preMaster);
        buses[name] = { in: inp, duck };
      });

      loadSamples(); // Abe's foley decodes alongside the graph build
    }
    return actx;
  }

  // ── Samples — Abe's foley (the nessfx 8-bit pack) ──────────────
  // The island's voice is synthesized; Abe's is SAMPLED. Viet's call:
  // the chat went RPG-dialog-box, so his foley goes chiptune — tiny
  // mono wavs from the nessfx FamiTracker pack, played through the
  // same bus/pan/reverb plumbing as every synthesized voice, so they
  // sit in the same room. Decoding rides the graph build; a missing
  // or failed file simply leaves that cue silent — samples can never
  // break the synth.
  const SAMPLE_URLS = {
    dig1: 'sfx/dig1.wav',       // nessfx 21_walk1 — alternating paw scuffs
    dig2: 'sfx/dig2.wav',       // nessfx 22_walk2 —  under the moving mound
    blip: 'sfx/blip.wav',       // nessfx 31_text  — Abe's dialog blip
    knock: 'sfx/knock.wav',     // nessfx 67_knock — Abe diving into the ground
    drink: 'sfx/drink.wav',     // nessfx 66_drink — Abe popping back out
    explode: 'sfx/explode.wav', // nessfx 69_explode — the Clear's shell crack
    fall: 'sfx/fall.wav',       // nessfx 56_fall — anything lost off the platform
  };
  const BUFS = {};
  // Normalize each decoded file to a 1.0 peak — the same treatment
  // makeIR gives the reverb. The nessfx wavs are QUIET recordings
  // (dig1 peaks at 0.26 of full scale), so without this a cue's
  // `peak` option silently means a quarter of what it says, and the
  // first wired steps were ~15× under a tock: technically playing,
  // practically inaudible. After this, `peak` on a sample means
  // exactly what it means on a tone.
  function normalizeBuf(buf) {
    let peak = 0;
    for (let ch = 0; ch < buf.numberOfChannels; ch++) {
      const d = buf.getChannelData(ch);
      for (let i = 0; i < d.length; i++) peak = Math.max(peak, Math.abs(d[i]));
    }
    const s = 1 / (peak || 1);
    for (let ch = 0; ch < buf.numberOfChannels; ch++) {
      const d = buf.getChannelData(ch);
      for (let i = 0; i < d.length; i++) d[i] *= s;
    }
    return buf;
  }
  let samplesRequested = false;
  function loadSamples() {
    if (samplesRequested) return;
    samplesRequested = true;
    for (const [key, url] of Object.entries(SAMPLE_URLS)) {
      fetch(url)
        .then(r => (r.ok ? r.arrayBuffer() : Promise.reject()))
        .then(ab => actx.decodeAudioData(ab))
        .then(buf => { BUFS[key] = normalizeBuf(buf); })
        .catch(() => {});
    }
  }

  // Sample voice in the house idiom: rate jitter is the anti-machine-
  // gun move (samples repeat EXACTLY, unlike synth voices, so without
  // it every step is a photocopy), the 3ms fade-in guards the start
  // click, and lp darkens a source that should read as distant or
  // buried. The sample owns its own tail.
  function sample(t0, key, o) {
    const buf = BUFS[key];
    if (!buf || activeVoices >= MAX_VOICES) return null;
    const src = actx.createBufferSource();
    src.buffer = buf;
    src.playbackRate.value = (o.rate || 1) * R(o.jitter != null ? o.jitter : 0);
    const g = actx.createGain();
    g.gain.setValueAtTime(0.0001, t0);
    g.gain.linearRampToValueAtTime(o.peak || 0.2, t0 + 0.003);
    let head = src;
    if (o.lp) {
      const lp = actx.createBiquadFilter();
      lp.type = 'lowpass';
      lp.frequency.setValueAtTime(o.lp, t0);
      if (o.lpTo) { // same "distance" ramp the noise voice owns
        lp.frequency.exponentialRampToValueAtTime(o.lpTo, t0 + (o.lpGlide || 0.5));
      }
      src.connect(lp); head = lp;
    }
    head.connect(g);
    wire(g, t0, o);
    countVoice(src);
    src.start(t0);
    return { src, g };
  }

  // Has the visitor EVER interacted? Pre-activation, audio can never be
  // heard, so cues must cost nothing: no graph build, no resume attempt
  // (each rejected resume logs a browser warning). Browsers without
  // userActivation report true — the old opportunistic behaviour.
  const hasActivation = () =>
    !navigator.userActivation || navigator.userActivation.hasBeenActive;

  function ensure() {
    if (S.state === 'off') return null;
    if (!actx) {
      if (!hasActivation()) return null; // silent no-op before the first gesture
      if (!build()) return null;
    }
    if (actx.state === 'suspended') {
      // DROP this cue rather than schedule it against a frozen clock —
      // cues scheduled while suspended pile up at t≈0 and thaw as a
      // burst on the first click (the boot-cascade bug).
      if (hasActivation()) actx.resume();
      return null;
    }
    return actx;
  }

  // Build the graph ahead of need, without playing anything. Safe to call
  // pre-gesture: the context sits suspended and costs nothing until the
  // first real interaction resumes it.
  S.prime = () => { if (S.state !== 'off') build(); };

  // ── The first touch: the world gains its voice ─────────────────
  // The entrance is silent by browser policy (no audio before a real
  // gesture), so the FIRST gesture is the moment the room blooms: the
  // ambience bed swells in over its 4 s ramp, and one warm note — low,
  // mostly reverb — answers the touch. A greeting, not a fanfare.
  let greeted = false;
  S.unlock = () => {
    if (greeted || S.state === 'off') return;
    if (!build()) return;
    greeted = true;
    const p = actx.state === 'suspended' ? actx.resume() : Promise.resolve();
    Promise.resolve(p).then(() => {
      if (S.state === 'off' || !actx) return;
      startAmbience(); // deliberately NOT started at build: its sources
      // would log start-while-suspended warnings and gain nothing — the
      // 4 s swell belongs to this moment anyway.
      tone(actx.currentTime + 0.05, { type: 'sine', f0: 261.63,
        peak: 0.10, atk: 0.02, dec: 0.9, bus: 'music', send: 0.55, jitter: 0 });
    }).catch(() => {});
  };

  // ── State / volume ─────────────────────────────────────────────
  S.setState = (state) => {
    S.state = state;
    localStorage.setItem(PREF_KEY, state);
    if (state === 'off') {
      stopAmbience(0.3);
      stopBed();
      // Actually MUTE: a ceremony phrase or a fall cue already scheduled
      // has seconds of tail left — gating only NEW voices (ensure() below)
      // left it playing at full level after the button said "off".
      if (actx && masterVol) masterVol.gain.setTargetAtTime(0.0001, actx.currentTime, 0.05);
      return;
    }
    // build(), not ensure(): state changes must apply even while the
    // context is still suspended pre-resume (gain values are state, not
    // cues — they take effect the moment the context runs).
    if (!build()) return;
    if (actx.state === 'suspended') actx.resume();
    // Perceptual, not linear; smoothed so a live control never zippers.
    masterVol.gain.setTargetAtTime(
      state === 'quiet' ? Math.pow(0.45, 1.8) : 1, actx.currentTime, 0.02);
    if (state === 'full') startAmbience(); else stopAmbience(1);
  };

  S.setProjector = (fn) => { project = fn; };

  // ════ 2 · PRIMITIVES — pan, adsr, wire, tone, noise, duck, ambience ════

  // Optional trailing position: a number = explicit pan, an object with
  // gx/gy(/gz) = pan from its on-screen x. Every existing no-arg call
  // keeps working (centred). `widen` lets fireworks sit wider than the
  // platform's 0.55 spread without touching the global dial.
  function panOf(at, widen = 1) {
    const spread = RM() ? 0 : SPREAD;      // spatial motion off under reduced motion
    if (at == null || spread === 0) return 0;
    if (typeof at === 'number') return clamp(at, -1, 1);
    if (!project) return 0;
    const nx = project(at.gx, at.gy, at.gz || 0);
    return clamp((nx - 0.5) * 2 * spread * widen, -1, 1);
  }

  // ── Envelope + voice primitives ────────────────────────────────
  // Linear attack (a real transient) → optional hold → exponential decay.
  // Attack is PER VOICE, never a global 1 ms — clickiness is exactly the
  // "too bright" failure mode this project keeps rejecting.
  function adsr(p, t0, peak, atk, hold, dec) {
    const pk = Math.max(0.0008, peak);
    p.setValueAtTime(0.0001, t0);
    p.linearRampToValueAtTime(pk, t0 + atk);
    if (hold > 0) p.setValueAtTime(pk, t0 + atk + hold);
    p.exponentialRampToValueAtTime(0.0001, t0 + atk + hold + dec);
  }

  // Wire a voice's output: gain → (pan) → bus dry + per-voice reverb send.
  // Reads o.{bus, pan, send, sendTo, sendGlide}: a send may RAMP over the
  // voice's life (sendTo) — a falling object grows wetter as it goes.
  function wire(g, t0, o) {
    let head = g;
    const pan = o.pan || 0;
    if (pan && actx.createStereoPanner) {
      const pn = actx.createStereoPanner();
      pn.pan.value = clamp(pan, -1, 1);
      g.connect(pn); head = pn;
    }
    const bus = o.bus || 'impact';
    head.connect(buses[bus].in);
    const sg = actx.createGain();
    const send = o.send != null ? o.send : BUS_SEND[bus];
    if (o.sendTo != null) {
      sg.gain.setValueAtTime(send, t0);
      sg.gain.linearRampToValueAtTime(o.sendTo, t0 + (o.sendGlide || 1));
    } else sg.gain.value = send;
    head.connect(sg); sg.connect(reverbIn);
  }

  function countVoice(src) {
    activeVoices++;
    src.onended = () => { activeVoices--; };
  }

  // Oscillator voice. f1 glides pitch; lp adds a lowpass (lpTo/lpGlide
  // ramp it — an opening filter IS a rise); jitter scatters pitch per
  // play (the anti-machine-gun move); send overrides the bus wet.
  function tone(t0, o) {
    if (activeVoices >= MAX_VOICES) return null;
    const osc = actx.createOscillator();
    const g = actx.createGain();
    osc.type = o.type || 'triangle';
    const j = o.jitter != null ? o.jitter : 0;
    const f0 = o.f0 * R(j);
    osc.frequency.setValueAtTime(f0, t0);
    if (o.f1 != null) {
      osc.frequency.exponentialRampToValueAtTime(
        Math.max(1, o.f1 * R(j)), t0 + (o.glide || 0.10));
    }
    adsr(g.gain, t0, (o.peak || 0.3) * R(o.lvlJitter != null ? o.lvlJitter : 0.1),
      o.atk != null ? o.atk : 0.004, o.hold || 0, o.dec != null ? o.dec : 0.15);
    if (o.lp) {
      const f = actx.createBiquadFilter(); f.type = 'lowpass';
      f.frequency.setValueAtTime(o.lp, t0);
      if (o.lpTo) f.frequency.exponentialRampToValueAtTime(o.lpTo, t0 + (o.lpGlide || 0.5));
      osc.connect(f); f.connect(g);
    } else osc.connect(g);
    wire(g, t0, o);
    countVoice(osc);
    osc.start(t0);
    osc.stop(t0 + (o.atk || 0.004) + (o.hold || 0) + (o.dec != null ? o.dec : 0.15) + 0.08);
    return { osc, g };
  }

  // Noise voice off the shared buffer, at a random offset per play.
  // Options beyond tone's: a SECOND series lowpass (lp/lpTo/lpGlide) for
  // "distance" — the dry darkens over the voice's life — and loop:true
  // for a bed (loops forever, no envelope; caller owns g.gain + src.stop,
  // and it isn't voice-counted — a permanent source would eat a slot).
  function noise(t0, o) {
    if (activeVoices >= MAX_VOICES) return null;
    const src = actx.createBufferSource();
    src.buffer = NOISE;
    const filt = actx.createBiquadFilter();
    filt.type = o.type || 'bandpass';
    if (o.Q != null) filt.Q.value = o.Q;
    const j = o.jitter != null ? o.jitter : 0;
    filt.frequency.setValueAtTime(Math.max(20, o.f0 * R(j)), t0);
    if (o.f1 != null) {
      filt.frequency.exponentialRampToValueAtTime(
        Math.max(20, o.f1 * R(j)), t0 + (o.glide || 0.15));
    }
    const g = actx.createGain();
    let tail = filt;
    if (o.lp) {
      const lp = actx.createBiquadFilter(); lp.type = 'lowpass';
      lp.frequency.setValueAtTime(o.lp, t0);
      if (o.lpTo) lp.frequency.exponentialRampToValueAtTime(o.lpTo, t0 + (o.lpGlide || 0.5));
      filt.connect(lp); tail = lp;
    }
    src.connect(filt); tail.connect(g);
    wire(g, t0, o);
    if (o.loop) {
      src.loop = true;
      src.start(t0);
      return { src, g };
    }
    const dur = (o.atk || 0.003) + (o.hold || 0) + (o.dec != null ? o.dec : 0.20) + 0.08;
    adsr(g.gain, t0, (o.peak || 0.2) * R(o.lvlJitter != null ? o.lvlJitter : 0.1),
      o.atk != null ? o.atk : 0.003, o.hold || 0, o.dec != null ? o.dec : 0.20);
    countVoice(src);
    src.start(t0, Math.random() * (2.0 - Math.min(1.9, dur)), Math.min(1.95, dur));
    return { src, g };
  }

  // ── Ducking — used in exactly three places (transform, barrage,
  // final boom). Over-ducking is how games start pumping; resist more.
  function duckAt(names, t, amount, hold, atk, rel) {
    names.forEach(n => {
      const g = buses[n].duck.gain;
      g.cancelScheduledValues(t);
      g.setValueAtTime(1, t);
      g.linearRampToValueAtTime(amount, t + atk);
      g.setValueAtTime(amount, t + atk + hold);
      g.linearRampToValueAtTime(1, t + atk + hold + rel);
    });
  }

  // ── Ambience — night air. Not a loop you can learn: the filter
  // drifts on a ~40 s cycle and the source is broadband noise. Ships
  // at "is that even on?" level, full-volume state only, defeatable.
  let amb = null;
  function startAmbience() {
    if (!actx || S.state !== 'full') return;
    if (amb) {
      // Re-enabled during a fade-out: cancel the fade and breathe back in.
      // (Starting a SECOND chain here is what stacked ambience beds on a
      // fast full → off → full cycle of the sound button.)
      if (amb.stopping) {
        amb.stopping = false;
        const t = actx.currentTime;
        [[amb.g, 0.012], [amb.dg, 0.008]].forEach(([g, lvl]) => {
          g.gain.cancelScheduledValues(t);
          g.gain.setValueAtTime(Math.max(0.0001, g.gain.value), t);
          g.gain.linearRampToValueAtTime(lvl, t + 2);
        });
      }
      return;
    }
    const t = actx.currentTime;
    const src = actx.createBufferSource();
    src.buffer = NOISE; src.loop = true;
    const lp = actx.createBiquadFilter(); lp.type = 'lowpass'; lp.frequency.value = 650;
    const lfo = actx.createOscillator(); lfo.frequency.value = 1 / 40;
    const lfoAmt = actx.createGain(); lfoAmt.gain.value = 250;
    lfo.connect(lfoAmt); lfoAmt.connect(lp.frequency);
    const g = actx.createGain();
    g.gain.setValueAtTime(0.0001, t);
    g.gain.linearRampToValueAtTime(0.012, t + 4);   // fades in AFTER first interaction
    src.connect(lp); lp.connect(g);
    const drone = actx.createOscillator(); drone.type = 'sine'; drone.frequency.value = 65.41; // C2
    const dg = actx.createGain();
    dg.gain.setValueAtTime(0.0001, t);
    dg.gain.linearRampToValueAtTime(0.008, t + 4);
    drone.connect(dg);
    wire(g, t, { bus: 'amb', send: 0.10 });
    wire(dg, t, { bus: 'amb', send: 0.10 });
    src.start(t); lfo.start(t); drone.start(t);
    amb = { src, lfo, drone, g, dg, stopping: false };
  }
  function stopAmbience(fade) {
    if (!amb || !actx || amb.stopping) return;
    amb.stopping = true;
    const t = actx.currentTime;
    [amb.g, amb.dg].forEach(g => {
      g.gain.cancelScheduledValues(t);
      g.gain.setValueAtTime(Math.max(0.0001, g.gain.value), t);
      g.gain.linearRampToValueAtTime(0.0001, t + fade);
    });
    // Kill the sources only if nothing restarts the fade first — the chain
    // is REUSED if the user cycles back to full mid-fade (a started source
    // can only be stopped once, so the stop can't be scheduled up front).
    const chain = amb;
    setTimeout(() => {
      if (amb === chain && chain.stopping) {
        [chain.src, chain.lfo, chain.drone].forEach(n => { try { n.stop(); } catch (e) {} });
        amb = null;
      }
    }, fade * 1000 + 100);
  }

  // ════ 3 · CUES — tock, pop, uiTick, whoomp, the boom coalescer + bed ════

  // ── Placement / landing "tock" — pitch climbs with stack height ──
  // Jitter is ±3%, NOT ±5%: the whole-tone climb is the game's one
  // melodic idea, and wider jitter smears the scale.
  S.tock = (height, strength = 1, at) => {
    if (!ensure()) return;
    const t = actx.currentTime;
    const semis = Math.min(24, height * 2);
    const f = 220 * Math.pow(2, semis / 12);
    const s = Math.min(1, strength);
    const p = panOf(at);
    // Transient: a wooden click that tracks pitch so it never detaches
    noise(t, { dur: 0.05, type: 'bandpass', f0: f * 6, Q: 1.6,
      peak: 0.10 * s, atk: 0.001, dec: 0.035, bus: 'impact', pan: p, jitter: 0.08 });
    // Body — the tail (the platform answering) comes free via the bus send
    tone(t + Rn(0, 0.003), { type: 'triangle', f0: f, f1: f * 0.92, glide: 0.10,
      peak: 0.5 * s, atk: 0.003, dec: 0.13, bus: 'impact', pan: p, jitter: 0.03 });
  };

  // ── Pickup "pop" — stays centred deliberately: it fires during fast
  // pointer movement, and panning it reads as jitter, not location.
  S.pop = () => {
    if (!ensure()) return;
    tone(actx.currentTime, { type: 'sine', f0: 520, f1: 880, glide: 0.06,
      peak: 0.3, atk: 0.004, dec: 0.08, bus: 'ui', jitter: 0.06 });
  };

  // ── UI ticks — all derived from pop's family, all quiet, all dry.
  // One timbre family: a distinct sound per control is how UIs get noisy.
  S.uiTick = (kind) => {
    if (!ensure()) return;
    const t = actx.currentTime;
    const k = {
      open:   { f0: 420, f1: 640, peak: 0.07, dec: 0.07 },
      close:  { f0: 640, f1: 420, peak: 0.06, dec: 0.06 },
      slot:   { f0: 480, f1: 620, peak: 0.06, dec: 0.05 },
      swatch: { f0: 560, f1: 700, peak: 0.05, dec: 0.045 },
      rotate: { f0: 340, f1: 420, peak: 0.035, dec: 0.04 },
    }[kind] || { f0: 500, f1: 600, peak: 0.05, dec: 0.05 };
    tone(t, { type: 'sine', f0: k.f0, f1: k.f1, glide: 0.05,
      peak: k.peak, atk: 0.004, dec: k.dec, bus: 'ui', jitter: 0.05 });
  };

  // ── Abe's dig — paw scuffs under the travelling mound ──────────
  // Alternating samples + rate jitter so no two steps match. Played
  // SLOW (0.82) and lowpassed hard because he is UNDER the turf: the
  // sound must read as through-the-ground, not footsteps on it.
  // Panned to the mound like any world sound.
  let digFoot = 0;
  S.goferStep = (at) => {
    if (!ensure()) return;
    sample(actx.currentTime, (digFoot++ & 1) ? 'dig2' : 'dig1', {
      peak: 0.20, rate: 0.82, jitter: 0.06, lp: 1500,
      bus: 'impact', send: 0.10, pan: panOf(at),
    });
  };

  // ── Abe's dialog blip — the RPG text-box sound, once per line he
  // says in the chat. UI bus, centred: it is chrome, not world.
  S.chatBlip = () => {
    if (!ensure()) return;
    sample(actx.currentTime, 'blip', {
      peak: 0.16, jitter: 0.03, bus: 'ui', send: 0.05,
    });
  };

  // ── Abe's dive — the knock, pitched down and muffled: a thump felt
  // through the turf as he punches into it.
  S.goferDuck = (at) => {
    if (!ensure()) return;
    sample(actx.currentTime, 'knock', {
      peak: 0.22, rate: 0.85, jitter: 0.05, lp: 2200,
      bus: 'impact', send: 0.15, pan: panOf(at),
    });
  };

  // ── Abe's eruption — the drink, full and bright: the cork-pop of a
  // gopher clearing the surface. No lowpass: he is OUT of the ground.
  S.goferPop = (at) => {
    if (!ensure()) return;
    sample(actx.currentTime, 'drink', {
      peak: 0.26, jitter: 0.05,
      bus: 'impact', send: 0.20, pan: panOf(at),
    });
  };

  // ── #dev audition hook — play any wav under site/ by url, so sound
  // choices are made by EAR on the live island, not by file name:
  //   document.dispatchEvent(new CustomEvent('vh-dev-sample',
  //     { detail: { url: 'sfx/audition/47_grass.wav', rate: 1, peak: 0.2, lp: 0 } }))
  if (location.hash === '#dev') {
    document.addEventListener('vh-dev-sample', async (e) => {
      const d = e.detail || {};
      if (!d.url) { console.log('[dev-sample] need {url}'); return; }
      if (!ensure()) { console.log('[dev-sample] audio locked — click the page once, and check the mute button'); return; }
      if (!BUFS[d.url]) {
        try {
          BUFS[d.url] = normalizeBuf(
            await actx.decodeAudioData(await (await fetch(d.url)).arrayBuffer()));
        } catch { console.log('[dev-sample] could not load', d.url); return; }
      }
      sample(actx.currentTime, d.url, {
        peak: d.peak != null ? d.peak : 0.2, rate: d.rate || 1,
        jitter: 0, lp: d.lp || 0, bus: 'impact',
        send: d.send != null ? d.send : 0.1,
      });
      console.log('[dev-sample] played', d.url,
        'rate', d.rate || 1, 'peak', d.peak != null ? d.peak : 0.2, 'lp', d.lp || 0);
    });
  }

  // ── "Whoomp" — now the Clear anticipation thump only (the off-platform
  // drop has its own cue). Retuned shorter and lower: a crouch, not a blast.
  S.whoomp = () => {
    if (!ensure()) return;
    const t = actx.currentTime;
    noise(t, { type: 'lowpass', f0: 500, f1: 70, glide: 0.18,
      peak: 0.6, atk: 0.010, dec: 0.22, bus: 'impact', jitter: 0.10 });
    tone(t, { type: 'sine', f0: 120, f1: 38, glide: 0.25,
      peak: 0.5, atk: 0.010, dec: 0.26, bus: 'impact', jitter: 0.05 });
  };

  // ── Booms: frame-coalesced, tiered, never silently dropped ─────
  // Tier A (hero): full crack + body + sparkle. Tier B (mid): body +
  // tail, NO transient (the transient is the part that repeats
  // identically — removing it is what kills the machine-gun), darker,
  // wider, wetter. Tier C: the crackle bed — one long filtered noise
  // source whose gain each unvoiced shell bumps, so thirty "dropped"
  // booms become a dense breathing crackle that tracks the real
  // barrage density (exactly what igniteStars is drawing on screen).
  let pending = [];
  let flushQueued = false;
  let heroTimes = [];
  let midTimes = [];
  let barrage = null;       // { until, heroCap, heroUsed } — set by beginBarrage
  let sweepBudget = 0;      // per-ceremony budget for leftover-sweep booms

  function boomFull(t, size, pan, o = {}) {
    const mul = o.mul || 1;
    const send = o.send;
    // Crack — the report now speaks nessfx (Viet's call: "use explode
    // for the Clear"): the 8-bit shell crack, rate-jittered wide so it
    // reads as DIFFERENT SHELLS, with the synth body + sub below still
    // carrying the weight. Falls back to the old synth crack until the
    // sample decodes, so the first Clear of a session never goes thin.
    if (!o.noCrack) {
      const s = sample(t, 'explode', { peak: 0.30 * size * mul, jitter: 0.15,
        bus: 'blast', pan, send });
      if (!s) {
        noise(t, { type: 'bandpass', Q: 0.9, f0: 1800 / size, f1: 400, glide: 0.15,
          peak: 0.28 * size * mul, atk: 0.0012, dec: 0.18, bus: 'blast',
          pan, jitter: 0.12, lvlJitter: 0.12, send });
      }
    }
    // Body — pulled back slightly (0.22 → 0.18) so the sub below carries
    // the weight instead of the mids
    tone(t + Rn(0, 0.004), { type: 'sine', f0: 90 / size, f1: 38, glide: 0.22,
      peak: 0.18 * size * mul, atk: 0.008, dec: 0.26 * size * R(0.18),
      bus: 'blast', pan, jitter: 0.10, lvlJitter: 0.12, lp: o.lp, send });
    // Sub thump — the chest-hit part of a real shell: deep, a touch slower
    // than the body, longer to let go
    tone(t + Rn(0.002, 0.006), { type: 'sine', f0: 34, peak: 0.18 * size * mul,
      atk: 0.012, dec: 0.6 * size * R(0.15), bus: 'blast', pan: pan * 0.5,
      jitter: 0.06, lvlJitter: 0.12 });
    // Sparkle tail (the pinked shared buffer already softened the top end)
    noise(t + Rn(0.006, 0.018), { type: 'highpass', f0: 5000,
      peak: 0.05 * mul, atk: 0.006, dec: 0.5 * size, bus: 'blast',
      pan, jitter: 0.20, lvlJitter: 0.15, send });
    // Hero-tier extras (o.roll): the rolling report + the sputter. Reserved
    // for lead shells and the finale so a barrage doesn't turn to mud.
    if (o.roll) {
      // The roll — the single biggest "pop" vs "explosion" difference: a
      // long low rumble that rolls away across the sky, mostly reverb
      noise(t + Rn(0.03, 0.07), { type: 'lowpass', f0: 400, f1: 150,
        glide: 1.6, peak: 0.10 * size, atk: 0.05, hold: 0.15,
        dec: 1.6 * R(0.2), bus: 'blast', pan: pan * 0.6, send: 0.7,
        lvlJitter: 0.15 });
      // Crackle sputter — the sparks themselves burning, timed to the
      // falling embers now on screen
      const blips = 5;
      for (let i = 0; i < blips; i++) {
        noise(t + Rn(0.15, 0.9), { type: 'bandpass', Q: 2.5,
          f0: 3000 * R(0.4), peak: 0.035, atk: 0.002, dec: 0.04,
          bus: 'blast', pan: pan + Rn(-0.15, 0.15), lvlJitter: 0.3 });
      }
    }
  }

  // The crackle bed. One looping source at gain 0, kept warm while sound
  // is on; stopBed() (the "off" path) kills it — it used to discard its
  // source handle and loop for the life of the page, un-stoppable.
  let bed = null, bedLevel = 0, bedLast = 0;
  function ensureBed() {
    if (bed || !actx) return;
    bed = noise(actx.currentTime, { type: 'bandpass', f0: 4500, Q: 3,
      loop: true, bus: 'blast', send: 0.45 });
    if (bed) bed.g.gain.value = 0.0001;
  }
  function stopBed() {
    if (!bed) return;
    try { bed.src.stop(); } catch (e) {}
    bed = null; bedLevel = 0;
  }
  function bumpBed(amount) {
    ensureBed();
    if (!bed) return; // voice ceiling hit — the crackle just goes unheard
    const t = actx.currentTime;
    bedLevel = bedLevel * Math.exp(-(t - bedLast) / 0.22) + amount;
    bedLevel = Math.min(0.30, bedLevel);
    bedLast = t;
    const g = bed.g.gain;
    g.cancelScheduledValues(t);
    g.setValueAtTime(Math.max(0.0001, bedLevel), t);
    g.setTargetAtTime(0.0001, t, 0.22);
  }

  S.boom = (size = 1, at, opts) => {
    if (!ensure()) return;
    pending.push({ size, at, cls: opts && opts.cls, t: actx.currentTime });
    if (!flushQueued) {
      flushQueued = true;
      // Microtask = this frame's batch exactly: all of a render tick's
      // detonations coalesce with zero added latency, and a hidden tab
      // can't pile frames into one giant crack.
      queueMicrotask(flushBooms);
    }
  };
  document.addEventListener('visibilitychange', () => { pending = []; });

  function flushBooms() {
    flushQueued = false;
    if (!actx) { pending = []; return; }
    const t = actx.currentTime;
    const list = pending; // same-tick microtask: nothing here can be stale
    pending = [];
    if (!list.length) return;

    // Leftover-sweep booms: small, far, and behind the monument's bloom.
    // Own budget + darker + wetter = a different depth plane, so they
    // stop competing with the transform bell (and can't eat Clear's).
    const sweeps = list.filter(b => b.cls === 'sweep');
    const shells = list.filter(b => b.cls !== 'sweep');
    sweeps.forEach(b => {
      if (sweepBudget > 0) {
        sweepBudget--;
        boomFull(t + Rn(0, 0.03), b.size, panOf(b.at, 1.2),
          { mul: 0.45, lp: 900, send: 0.6, noCrack: true });
      } else bumpBed(0.02);
    });

    if (!shells.length) return;
    shells.sort((a, b) => b.size - a.size);       // hero budget → biggest first
    heroTimes = heroTimes.filter(x => t - x < 0.5);
    midTimes = midTimes.filter(x => t - x < 0.12);
    const inBarrage = barrage && t < barrage.until;
    let heroBudget = Math.min(2, Math.max(0, 6 - heroTimes.length));

    for (const b of shells) {
      // Strict >: ordinary shells clamp to exactly 1.3 (world.js/game.js),
      // and the finale doesn't come through here at all — S.finalBoom
      // calls boomFull directly. At >=, every max-height Clear shell
      // skipped the hero budget AND polluted heroTimes, starving the
      // shells the budget was tuned for.
      const forced = b.size > 1.3;
      const capOk = !inBarrage || barrage.heroUsed < barrage.heroCap;
      if (forced || (heroBudget > 0 && capOk)) {
        boomFull(t + Rn(0, inBarrage ? 0.045 : 0.008), b.size, panOf(b.at, 1.4),
          { roll: b.size >= 0.9 }); // the roll is a lead-shell privilege
        heroTimes.push(t);
        if (!forced) { heroBudget--; if (inBarrage) barrage.heroUsed++; }
      } else if (midTimes.length < 4) {
        boomFull(t + Rn(0, 0.045), b.size, panOf(b.at, 1.6),
          { mul: 0.45, lp: 1400, send: 0.55, noCrack: true });
        midTimes.push(t);
      } else {
        bumpBed(0.035);
      }
    }
    // A genuinely dense frame gets a room-wide duck so the barrage owns
    // the moment — and MORE send, because a big show has more sky in it.
    if (shells.length >= 3) {
      duckAt(['ui', 'impact', 'music', 'amb'], t, 0.55, 0.25, 0.03, 0.4);
    }
  }

  // ════ 4 · SHOWS — barrage/finale, the ceremony (+ its voices), fall, warm ════

  // ── Clear / fireworks choreography ─────────────────────────────
  S.beginBarrage = (n) => {
    if (!ensure()) return;
    const t = actx.currentTime;
    barrage = {
      // Back to 3s: launches are one tight wave again, and the per-shell
      // fuse puts the last detonation at ~1.4s — comfortably inside the
      // window. (Shells detonating OUTSIDE it would each claim a hero
      // boom, which is the machine-gun this window exists to prevent.)
      until: t + 3,
      heroCap: clamp(Math.round(n * 0.25), 2, 10),  // a 6-block board: EVERY shell is a hero
      heroUsed: 0,
    };
    ensureBed();
    S.whoomp();                                      // the crouch
    // Whistles, plural — one whistle for a whole barrage is the biggest
    // tell. They shadow the real launch stagger and end BEFORE the first
    // apex: the 0.30–0.42 s gap is deliberate. Do not fill it.
    const sweeps = [[220, 860], [260, 980], [300, 1250], [340, 1500]];
    const count = clamp(Math.round(n / 8), 1, 4);
    for (let i = 0; i < count; i++) {
      const [f0, f1] = sweeps[i];
      const pan = count === 1 ? 0 : -0.8 + (1.6 * i) / (count - 1);
      tone(t + 0.02 + i * 0.07 + Rn(0, 0.04), { type: 'triangle', f0, f1,
        glide: 0.32, peak: 0.055, atk: 0.008, dec: 0.38, lp: 2500,
        bus: 'blast', pan, jitter: 0.04 });
    }
  };

  // The final beat — the boom that never played (the old cooldown ate it
  // in the same tick, every time). Bypasses the coalescer entirely.
  S.finalBoom = () => {
    if (!ensure()) return;
    const t = actx.currentTime;
    duckAt(['ui', 'impact', 'music', 'amb'], t, 0.4, 0.12, 0.02, 0.9);
    boomFull(t, 1.4, 0, { send: 0.6, roll: true });
    tone(t, { type: 'sine', f0: 44, peak: 0.18, atk: 0.012, dec: 1.8,
      bus: 'blast', jitter: 0.03 });
    // C2 — the same tonic as the monument cue: Clear ends in the game's key.
    tone(t + 0.02, { type: 'sine', f0: 65.41, peak: 0.05, atk: 0.03, dec: 2.4,
      bus: 'music', send: 0.5, jitter: 0 });
  };

  // Reduced-motion Clear: everything dissolves in place on screen, so a
  // barrage cue would be a lie — but the ARC survives: thump → one soft
  // break → low crackle → the night returns. (~2 s, matches the bloom.)
  S.clearReduced = () => {
    if (!ensure()) return;
    const t = actx.currentTime;
    S.whoomp();
    boomFull(t + 0.25, 1.0, 0, { mul: 0.5, lp: 1400, send: 0.55, noCrack: true });
    ensureBed();
    for (let i = 0; i < 5; i++) {
      // Gate on STATE, not just context existence: muting mid-Clear used
      // to keep these crackle swells firing after the button said "off".
      setTimeout(() => { if (actx && S.state !== 'off') bumpBed(0.03); }, 300 + i * 280);
    }
    tone(t + 0.60, { type: 'sine', f0: 65.41, peak: 0.05, atk: 0.03, dec: 2.4,
      bus: 'music', send: 0.5, jitter: 0 });
    tone(t + 0.60, { type: 'sine', f0: 44, peak: 0.12, atk: 0.012, dec: 1.6,
      bus: 'blast', jitter: 0.03 });
  };

  // ── The monument transform ─────────────────────────────────────
  // Scheduled as ONE phrase on the audio clock from startCeremony —
  // per-frame triggering would smear the melody on any hitch. Note
  // times reuse the exact appearAt expression, so note and pop-in are
  // frame-locked by construction.
  //
  // The rise is MELODIC (user decision 2026-08-21): one note per layer
  // (a 40-piece pyramid = 5 notes, not 40 blips — the anti-slot-machine
  // move), C major pentatonic (no semitones → overlapping tails never
  // clash; no leading tone → no cadence, no "cha-ching"), and the last
  // note deliberately is NOT the tonic — the settle answers it with C3.
  const PENT = [261.63, 293.66, 329.63, 392.00, 440.00, 523.25,
                587.33, 659.25, 783.99, 880.00, 1046.50, 1174.66];

  S.ceremony = (spec) => {
    if (!ensure()) return;
    const t0 = actx.currentTime;
    const reduced = RM();
    const centerPan = panOf(spec.center);
    sweepBudget = 3;                       // the leftover sweep's boom allowance

    // 0 → 0.66: the gather. A breath in. Sub + inhale + a pad whose
    // opening filter IS the rise.
    tone(t0, { type: 'sine', f0: 55, peak: 0.11, atk: 0.55, dec: 0.11,
      bus: 'music', pan: centerPan, jitter: 0 });
    tone(t0, { type: 'sine', f0: 82.4, peak: 0.08, atk: 0.55, dec: 0.11,
      bus: 'music', pan: centerPan, jitter: 0 });
    noise(t0, { type: 'highpass', f0: 900, f1: 4000, glide: 0.6,
      peak: 0.05, atk: 0.60, dec: 0.06, bus: 'music', pan: centerPan });
    // The pad: C3 + G3 saws behind an OPENING lowpass — a filter opening
    // IS the rise. (Custom voice: the primitives' lp is static.)
    padVoice(t0, 130.81, centerPan, reduced);
    padVoice(t0, 196.00, centerPan, reduced);

    // 0.66 → 0.70: forty milliseconds of TRUE SILENCE before the payoff.
    // (All gather envelopes end at 0.66; nothing is scheduled here.)

    // 0.70: the flash. A bell, not an arpeggio — flammed partials with an
    // inharmonic top, and the one moment you hear the whole void (wet 0.5).
    const tF = t0 + 0.70;
    duckAt(['ui', 'impact', 'blast', 'amb'], tF, 0.5, 0.12, 0.02, 0.5);
    noise(tF, { type: 'bandpass', Q: 0.8, f0: 2400, f1: 700, glide: 0.09,
      peak: 0.30, atk: 0.0015, dec: 0.16, bus: 'music', pan: centerPan, send: 0.5 });
    const bell = [[261.63, 0.26], [392.00, 0.20], [523.25, 0.16], [1174.66, 0.08]];
    bell.forEach(([f, pk], i) => {
      tone(tF + i * 0.008, { type: 'sine', f0: f * R(0.0023), peak: pk,
        atk: 0.006, dec: 1.4, bus: 'music', pan: centerPan, send: 0.5, jitter: 0 });
    });
    tone(tF, { type: 'sine', f0: 65.41, f1: 49, glide: 0.5, peak: 0.22,
      atk: 0.008, dec: 0.5, bus: 'music', pan: centerPan, jitter: 0 });

    // 0.70 → ~1.45: the rise. One mallet note per layer; wide base = louder
    // note; sparser above layer 7 so a spire opens out instead of speeding up.
    const layers = spec.layers || [];
    let noteIdx = 0;
    layers.forEach((L, i) => {
      if (i >= 8 && (i - 8) % 2 === 1) return;   // every other, high up
      const f = PENT[Math.min(noteIdx, PENT.length - 1)];
      noteIdx++;
      const tN = t0 + L.at + Rn(0, 0.008);
      const peak = 0.10 + 0.10 * Math.min(1, L.n / 6);
      const dec = 0.55 + 0.35 * (1 - i / Math.max(1, layers.length - 1));
      const pan = clamp(panOf(L, 1), -0.35, 0.35);
      malletNote(tN, f, peak, dec, pan);
    });

    // ~1.55: the settle — the exhale that RESOLVES the rise's hanging
    // note to the tonic. No transient (it already happened).
    const tS = t0 + 1.55;
    tone(tS, { type: 'triangle', f0: 130.81, peak: 0.09, atk: 0.03, dec: 1.6,
      bus: 'music', pan: centerPan, send: 0.55, jitter: 0 });
    tone(tS, { type: 'sine', f0: 98.00, peak: 0.07, atk: 0.03, dec: 1.6,
      bus: 'music', pan: centerPan, send: 0.55, jitter: 0 });
    noise(tS, { type: 'highpass', f0: 3000, peak: 0.03, atk: 0.010, dec: 1.1,
      bus: 'music', pan: centerPan });
  };

  // Pad voice: tone() with an OPENING filter (the gather's rising feeling
  // — lpTo is what the primitive gained for exactly this) plus a gentle
  // tremolo (skipped under reduced motion — an amplitude wobble is a
  // motion analogue).
  function padVoice(t0, f, pan, reduced) {
    const v = tone(t0, { type: 'sawtooth', f0: f, jitter: 0.005,
      peak: 0.06, lvlJitter: 0, atk: 0.15, hold: 0.47, dec: 0.04,
      lp: 300, lpTo: 1800, lpGlide: 0.66, bus: 'music', pan });
    if (v && !reduced) {
      const lfo = actx.createOscillator(); lfo.frequency.value = 5.5;
      const la = actx.createGain(); la.gain.value = 0.06 * 0.25;
      lfo.connect(la); la.connect(v.g.gain);
      lfo.start(t0); lfo.stop(t0 + 0.7);
    }
  }

  // A mallet on stone: fundamental + octave + a slightly INHARMONIC third
  // partial (3.01×: stone, not glass). Starts 1.2% sharp and glides true
  // over 35 ms — the audio twin of the pop-in's easeOutBack overshoot.
  function malletNote(t, f0, peak, dec, pan) {
    const f = f0 * R(0.015);
    [[1, 1, 'triangle'], [2, 0.35, 'sine'], [3.01, 0.12, 'sine']].forEach(([m, amt, type]) => {
      if (activeVoices >= MAX_VOICES) return;
      const osc = actx.createOscillator();
      osc.type = type;
      osc.frequency.setValueAtTime(f * m * 1.012, t);
      osc.frequency.exponentialRampToValueAtTime(f * m, t + 0.035);
      const lp = actx.createBiquadFilter(); lp.type = 'lowpass'; lp.frequency.value = 3200;
      const g = actx.createGain();
      adsr(g.gain, t, peak * amt, 0.004, 0, dec);
      osc.connect(lp); lp.connect(g);
      wire(g, t, { bus: 'music', pan });
      countVoice(osc);
      osc.start(t); osc.stop(t + dec + 0.1);
    });
  }

  // ── Off-platform drop — loss with grace, not a failure buzzer ──
  // The whole trajectory is knowable at release (gravity 648, fade
  // 0.72/s → gone at 1.39 s), so the entire cue is scheduled up front.
  // The last 240 ms are DELIBERATELY source-free: nothing but the
  // reverb tail, because the void has no floor. The absence of an
  // impact is the finality.
  S.fall = (o = {}) => {
    if (!ensure()) return;
    const t = actx.currentTime;
    const pan = typeof o.pan === 'number' ? clamp(o.pan, -0.6, 0.6) : panOf(o.at, 1.1);
    const mass = Math.max(1, o.mass || 1);

    // Letting go: pop() inverted — pickup and release, the same gesture mirrored
    tone(t, { type: 'sine', f0: 420, f1: 300, glide: 0.09, peak: 0.10,
      atk: 0.003, dec: 0.14, bus: 'impact', pan, jitter: 0.06 });

    if (o.reduced) {
      // On screen nothing falls (it just vanishes) — a long tumble would
      // describe something that didn't happen, but a deliberate action
      // still needs confirmation: one short, soft, dark descent.
      noise(t + 0.02, { type: 'bandpass', Q: 1.2, f0: 700, f1: 300, glide: 0.4,
        peak: 0.09, atk: 0.03, dec: 0.4, bus: 'impact', pan });
      tone(t + 0.02, { type: 'sine', f0: 160, f1: 60, glide: 0.4, peak: 0.07,
        atk: 0.02, dec: 0.4, bus: 'impact', pan, jitter: 0.05 });
      return;
    }

    // The fall: 1–3 staggered layers (a big monument is a loose group,
    // not one object). The descent now speaks nessfx (Viet's call) —
    // the 8-bit falling whistle, rate-jittered per layer so a monument
    // is three slightly detuned falls — riding the same "distance"
    // ramps the synth version owned: the dry darkens (lp 6000→700)
    // while the reverb send opens (0.25→0.85), so the further it
    // falls, the more it is only room. The low sine stays underneath
    // for weight; the old noise band is the fallback until the sample
    // decodes.
    const layerCount = mass > 1 ? 3 : 1;
    const bodyF = 180 / (1 + 0.35 * Math.log2(mass));
    for (let i = 0; i < layerCount; i++) {
      const tL = t + [0, 0.07, 0.145][i];
      const s = sample(tL, 'fall', { peak: 0.16, jitter: 0.07,
        lp: 6000, lpTo: 700, lpGlide: 1.1,
        bus: 'impact', pan, send: 0.25, sendTo: 0.85, sendGlide: 1.1 });
      if (!s) {
        noise(tL, { type: 'bandpass', Q: 1.4, f0: 900, f1: 190, glide: 1.1,
          peak: 0.13, lvlJitter: 0, atk: 0.2, hold: 0.35, dec: 0.6,
          lp: 6000, lpTo: 700, lpGlide: 1.1,
          bus: 'impact', pan, send: 0.25, sendTo: 0.85, sendGlide: 1.1 });
      }
      tone(tL, { type: 'sine', f0: bodyF * R(0.06), f1: 42, glide: 1.05,
        peak: 0.09, atk: 0.02, dec: 1.05, bus: 'impact', pan, jitter: 0.04 });
    }

    // A monument knocks on the way out: five descending stone hits —
    // its own rise cue played backwards and downward as you lose it.
    if (o.tumble) {
      const tumbleNotes = [659.25, 523.25, 440.00, 392.00, 329.63]; // E5 C5 A4 G4 E4
      tumbleNotes.forEach((f, i) => {
        malletNote(t + [0, 0.055, 0.13, 0.19, 0.265][i], f, 0.06, 0.08, pan);
      });
    }
  };

  // ── The near-miss hint — the quietest sound in the game ────────
  // A two-note open interval in the SAME pentatonic (so it subconsciously
  // reads as "near one of those"), almost entirely reverb: it should live
  // "somewhere out there", never ping like UI. Retrigger-guarded: replays
  // only when the arrangement CHANGED (new spot, or you got closer).
  let warmState = { key: null, missing: 99, at: -10 };
  S.warm = (missing, at, key) => {
    if (!ensure()) return;
    const t = actx.currentTime;
    const changed = key !== warmState.key || missing < warmState.missing;
    if (!changed || t - warmState.at < 2.5) {
      warmState.key = key; warmState.missing = Math.min(warmState.missing, missing);
      return;
    }
    warmState = { key, missing, at: t };
    const peak = RM() ? 0.060 : 0.045;   // reduced motion dims the visual hint → sound carries more
    const pan = clamp(panOf(at, 1), -0.4, 0.4);
    const pair = missing <= 1
      ? [[783.99, 0], [1046.50, 0.17]]    // G5 → C6, a rising fourth: "almost"
      : [[659.25, 0], [783.99, 0.22]];    // E5 → G5, a smaller step: less certain
    pair.forEach(([f, dt]) => {
      tone(t + dt, { type: 'sine', f0: f, peak, atk: 0.025, dec: 1.3,
        bus: 'music', pan, send: 0.7, jitter: 0.003 });
    });
  };

  // ════ 5 · DEV — live tuning (vh-dev-audio) ════
  S.tune = (o = {}) => {
    if (o.wet != null && wetMaster) { WET = o.wet; wetMaster.gain.value = o.wet; }
    if (o.spread != null) SPREAD = o.spread;
    if (o.master != null && preMaster) preMaster.gain.value = o.master;
    if (o.amb != null && amb) amb.g.gain.setTargetAtTime(o.amb, actx.currentTime, 0.1);
    return { wet: WET, spread: SPREAD, master: preMaster ? preMaster.gain.value : 0.16 };
  };
})();
