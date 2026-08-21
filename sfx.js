/* ============================================================
   sfx.js — synthesized sound effects (WebAudio, zero assets)
   ON by default; the mute toggle opts out and persists. (Browsers
   gate audio behind the first user interaction, so the first sound
   lands on the first click — ensure() resumes the context then.)
   Placement "tock" pitch rises with stack height (musical stacking).
   ============================================================ */
(() => {
  'use strict';
  const VH = (window.VH = window.VH || {});

  const S = (VH.sfx = {});
  const PREF_KEY = 'vh-sound';

  S.enabled = localStorage.getItem(PREF_KEY) !== 'off'; // on unless muted before
  let actx = null;
  let master = null;

  function ensure() {
    if (!S.enabled) return null;
    if (!actx) {
      const AC = window.AudioContext || window.webkitAudioContext;
      if (!AC) return null;
      actx = new AC();
      master = actx.createGain();
      master.gain.value = 0.16;
      master.connect(actx.destination);
    }
    if (actx.state === 'suspended') actx.resume();
    return actx;
  }

  S.setEnabled = (on) => {
    S.enabled = on;
    localStorage.setItem(PREF_KEY, on ? 'on' : 'off');
    if (on) ensure();
  };

  // Small helpers ------------------------------------------------
  function env(param, t0, peak, decay) {
    param.setValueAtTime(0.0001, t0);
    param.exponentialRampToValueAtTime(Math.max(0.001, peak), t0 + 0.006);
    param.exponentialRampToValueAtTime(0.0001, t0 + decay);
  }

  function noiseBuffer(ctx, seconds) {
    const buf = ctx.createBuffer(1, ctx.sampleRate * seconds, ctx.sampleRate);
    const d = buf.getChannelData(0);
    for (let i = 0; i < d.length; i++) d[i] = Math.random() * 2 - 1;
    return buf;
  }

  // Placement / landing "tock" — pitch climbs with stack height
  S.tock = (height, strength = 1) => {
    const ctx = ensure(); if (!ctx) return;
    const t = ctx.currentTime;
    const semis = Math.min(24, height * 2); // whole-tone climb, capped
    const freq = 220 * Math.pow(2, semis / 12);
    const osc = ctx.createOscillator();
    const g = ctx.createGain();
    osc.type = 'triangle';
    osc.frequency.setValueAtTime(freq, t);
    osc.frequency.exponentialRampToValueAtTime(freq * 0.92, t + 0.1);
    env(g.gain, t, 0.5 * Math.min(1, strength), 0.13);
    osc.connect(g); g.connect(master);
    osc.start(t); osc.stop(t + 0.16);
  };

  // Pickup "pop"
  S.pop = () => {
    const ctx = ensure(); if (!ctx) return;
    const t = ctx.currentTime;
    const osc = ctx.createOscillator();
    const g = ctx.createGain();
    osc.type = 'sine';
    osc.frequency.setValueAtTime(520, t);
    osc.frequency.exponentialRampToValueAtTime(880, t + 0.06);
    env(g.gain, t, 0.3, 0.08);
    osc.connect(g); g.connect(master);
    osc.start(t); osc.stop(t + 0.1);
  };

  // Blast "whoomp" — filtered noise + low sine drop
  S.whoomp = () => {
    const ctx = ensure(); if (!ctx) return;
    const t = ctx.currentTime;
    const noise = ctx.createBufferSource();
    noise.buffer = noiseBuffer(ctx, 0.4);
    const filt = ctx.createBiquadFilter();
    filt.type = 'lowpass';
    filt.frequency.setValueAtTime(500, t);
    filt.frequency.exponentialRampToValueAtTime(70, t + 0.35);
    const ng = ctx.createGain();
    env(ng.gain, t, 0.6, 0.38);
    noise.connect(filt); filt.connect(ng); ng.connect(master);
    noise.start(t);

    const osc = ctx.createOscillator();
    const og = ctx.createGain();
    osc.type = 'sine';
    osc.frequency.setValueAtTime(120, t);
    osc.frequency.exponentialRampToValueAtTime(45, t + 0.3);
    env(og.gain, t, 0.5, 0.32);
    osc.connect(og); og.connect(master);
    osc.start(t); osc.stop(t + 0.4);
  };

  // Firework report — noise crack + low body + sparkle tail.
  // Rate-limited: a full-board barrage must not clip the master bus.
  let lastBoom = 0;
  S.boom = (size = 1) => {
    const ctx = ensure(); if (!ctx) return;
    const t = ctx.currentTime;
    if (t - lastBoom < 0.035) return; // voice limiter
    lastBoom = t;
    // Crack: bandpassed noise burst (bigger shells crack lower)
    const noise = ctx.createBufferSource();
    noise.buffer = noiseBuffer(ctx, 0.3);
    const filt = ctx.createBiquadFilter();
    filt.type = 'bandpass';
    filt.Q.value = 0.9;
    filt.frequency.setValueAtTime(1800 / size, t);
    filt.frequency.exponentialRampToValueAtTime(400, t + 0.15);
    const ng = ctx.createGain();
    env(ng.gain, t, 0.28 * size, 0.18);
    noise.connect(filt); filt.connect(ng); ng.connect(master);
    noise.start(t);
    // Body: low sine drop
    const osc = ctx.createOscillator();
    const og = ctx.createGain();
    osc.type = 'sine';
    osc.frequency.setValueAtTime(90 / size, t);
    osc.frequency.exponentialRampToValueAtTime(38, t + 0.22);
    env(og.gain, t, 0.22 * size, 0.26 * size);
    osc.connect(og); og.connect(master);
    osc.start(t); osc.stop(t + 0.45);
    // Sparkle tail: quiet highpassed noise
    const tail = ctx.createBufferSource();
    tail.buffer = noiseBuffer(ctx, 0.6);
    const tf = ctx.createBiquadFilter();
    tf.type = 'highpass';
    tf.frequency.value = 5000;
    const tg = ctx.createGain();
    env(tg.gain, t, 0.05, 0.5 * size);
    tail.connect(tf); tf.connect(tg); tg.connect(master);
    tail.start(t);
  };

  // Firework launch whistle — one rising sweep as the shells go up
  S.whistle = () => {
    const ctx = ensure(); if (!ctx) return;
    const t = ctx.currentTime;
    const osc = ctx.createOscillator();
    const g = ctx.createGain();
    const filt = ctx.createBiquadFilter();
    filt.type = 'lowpass';
    filt.frequency.value = 2500;
    osc.type = 'triangle';
    osc.frequency.setValueAtTime(300, t);
    osc.frequency.exponentialRampToValueAtTime(1250, t + 0.42);
    env(g.gain, t, 0.10, 0.45);
    osc.connect(filt); filt.connect(g); g.connect(master);
    osc.start(t); osc.stop(t + 0.5);
  };

  // Discovery fanfare — rising arpeggio with a soft shimmer tail
  S.fanfare = () => {
    const ctx = ensure(); if (!ctx) return;
    const notes = [523.25, 659.25, 783.99, 1046.5]; // C5 E5 G5 C6
    notes.forEach((freq, i) => {
      const t = ctx.currentTime + i * 0.09;
      const osc = ctx.createOscillator();
      const g = ctx.createGain();
      osc.type = 'triangle';
      osc.frequency.setValueAtTime(freq, t);
      env(g.gain, t, i === notes.length - 1 ? 0.5 : 0.32, i === notes.length - 1 ? 0.7 : 0.22);
      osc.connect(g); g.connect(master);
      osc.start(t); osc.stop(t + 0.8);
    });
    // Shimmer: quiet filtered noise swell under the final note
    const t = ctx.currentTime + 0.27;
    const noise = ctx.createBufferSource();
    noise.buffer = noiseBuffer(ctx, 0.6);
    const filt = ctx.createBiquadFilter();
    filt.type = 'highpass';
    filt.frequency.value = 4000;
    const ng = ctx.createGain();
    env(ng.gain, t, 0.12, 0.55);
    noise.connect(filt); filt.connect(ng); ng.connect(master);
    noise.start(t);
  };

  // Dog bark — two short square bursts
  S.bark = () => {
    const ctx = ensure(); if (!ctx) return;
    for (let i = 0; i < 2; i++) {
      const t = ctx.currentTime + i * 0.14;
      const osc = ctx.createOscillator();
      const g = ctx.createGain();
      osc.type = 'square';
      osc.frequency.setValueAtTime(300 - i * 40, t);
      osc.frequency.exponentialRampToValueAtTime(180, t + 0.07);
      env(g.gain, t, 0.22, 0.09);
      osc.connect(g); g.connect(master);
      osc.start(t); osc.stop(t + 0.11);
    }
  };
})();
