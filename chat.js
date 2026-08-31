/* ============================================================
   chat.js — the conversation with Abe.

   Tapping the gofer used to NAVIGATE to the case study — ripping the
   visitor out of the island they were just convinced to care about.
   Now he talks. Abe (named after Viet's frenchie) greets the visitor
   and answers questions about the Gofer app, Viet's path to design
   engineering, and the island itself.

   HYBRID BRAINS, and the split is the design:
   · The suggested-question CHIPS answer instantly from authored text
     below — no network, no cost, and they are the graceful fallback
     when the relay is down or capped.
   · Free-typed questions POST to a tiny Cloudflare Worker relay that
     holds the API key (a static GitHub Pages site cannot keep a
     secret) and asks Claude, grounded in a curated knowledge doc.

   The product metaphor carries into the rhythm: thinking = DIGGING
   ("Abe is digging…"), a reply = FOUND SOMETHING (his existing blink
   + hop beat fires via VH.gofer.chatReact()). Every answer is
   fetched, because fetching is his whole job.

   House rules kept: codex-style non-modal panel (hidden attr, Escape
   via game.js, uiTick sounds), textContent-only rendering (never
   innerHTML — this is also the XSS backstop for model output),
   session-only memory (nothing persisted), world stays live behind
   the panel.
   ============================================================ */
(() => {
  'use strict';
  const VH = window.VH;

  const C = (VH.chat = {});

  // ── The relay ───────────────────────────────────────────────
  // Hostname switch, not config: the site has no build step. Local
  // dev talks to `wrangler dev` on 8787; before the worker exists (or
  // when it's unreachable) the fetch fails fast and the fallback copy
  // takes over — the panel never breaks, it just gets more scripted.
  const LOCAL = /^(localhost|127\.0\.0\.1)$/.test(location.hostname);
  const API = LOCAL
    ? 'http://127.0.0.1:8787/chat'
    : 'https://abe-chat.vhoang13.workers.dev/chat'; // set at Phase C deploy

  const MAX_TURNS = 10;     // free-typed questions per visit, then sign-off
  const HISTORY_SENT = 8;   // messages sent to the relay (cost + jailbreak-accretion cap)
  const TIMEOUT_MS = 15000;

  // ── Abe's words (DRAFT — Gate B review finalises every line) ──
  const OPENER =
    "Hey, nice to meet you! Welcome to Viet's place — I'm Abe, the gofer " +
    "he made. I can tell you about the Gofer app we built, how Viet became " +
    "a design engineer, or how this little island works. What brings you " +
    "here today?";

  const CHIPS = [
    {
      id: 'hiring',
      label: "I'm hiring — the short version",
      answer:
        "The short version: Viet is a product designer who learned to build. " +
        "He ran design for Wealth at BNY — a team of six, regulated software — " +
        "then went founding designer on a consumer app called Gofer, and ended " +
        "up designing AND building it: the SwiftUI iOS app, the Python backend, " +
        "a design system, shipped to the App Store. This island? He built it " +
        "too. The full story is in the case study — or just ask me anything.",
    },
    {
      id: 'gofer',
      label: 'What is Gofer?',
      answer:
        "Gofer was a social wishlist that learns what you and your friends " +
        "love — save products you find anywhere, see what people you trust " +
        "are into, and it sharpens on your taste as you use it. Viet was the " +
        "founding designer and ended up building most of it himself. It " +
        "shipped to TestFlight and then the App Store with real users. Want " +
        "to hear what he learned building it?",
    },
    {
      id: 'journey',
      label: "Viet's journey",
      answer:
        "Viet spent years as a product designer — Prudential first, then Head " +
        "of Design for Wealth at BNY. In 2025 he left to be founding designer " +
        "on Gofer, and the job turned out to be building the whole thing. He " +
        "taught himself to ship real software by directing AI coding agents " +
        "and reviewing every change on a real device — judgment, not " +
        "keystrokes. Now he takes ideas from zero to one. This island is his " +
        "proof.",
    },
    {
      id: 'island',
      label: 'How does this island work?',
      answer:
        "Everything here is blocks — try dragging one up from the bar at the " +
        "bottom! Certain shapes transform into monuments; the plans are in " +
        "the Monuments panel, and the two towers are Viet's old jobs. Me? I " +
        "dig around looking for things you might like — it's sort of the " +
        "family business. Tap me whenever you want to talk.",
    },
  ];

  const LINE_FALLBACK =
    "Hm — my tunnel to the answers seems blocked right now. I can still " +
    "tell you plenty though: try one of the questions below, or the full " +
    "case study has the whole story.";
  const LINE_RATELIMIT =
    "Whew — I'm digging as fast as I can! Give me a minute and ask me again.";
  const LINE_SIGNOFF =
    "I've dug up about all I can for one visit! The case study has the deep " +
    "version — or email Viet directly. He answers.";

  // ── Elements ────────────────────────────────────────────────
  const panel = document.getElementById('chat');
  const log = document.getElementById('chatLog');
  const chipsRow = document.getElementById('chatChips');
  const form = document.getElementById('chatForm');
  const input = document.getElementById('chatInput');
  const send = document.getElementById('chatSend');

  // ── State (session-only, deliberately not persisted) ────────
  const messages = []; // {role: 'user'|'assistant', content}
  let inFlight = false;
  let turnsUsed = 0;
  let opened = false;      // opener rendered yet?
  let lastFocus = null;    // restore target on close
  let digRow = null;       // the "Abe is digging…" indicator row
  let chipTimer = null;    // a chip's fake-dig beat, so close() could clear it

  // ── Rendering (textContent ONLY — the XSS backstop) ─────────
  // Abe's rows carry a mini portrait, the RPG dialog-box pattern —
  // the speaker's face rides with every line he says. Built from
  // createElement + textContent, never innerHTML: model output stays
  // inert text no matter what it contains.
  function abeFace() {
    const img = document.createElement('img');
    img.className = 'chat-msg-avatar';
    img.src = 'abe.png';
    img.alt = '';
    img.width = 24;
    img.height = 24;
    return img;
  }

  function addRow(role, text) {
    const row = document.createElement('div');
    row.className = 'chat-msg chat-msg--' + role;
    if (role === 'abe') {
      row.appendChild(abeFace());
      const body = document.createElement('span');
      body.className = 'chat-msg-text';
      body.textContent = text;
      row.appendChild(body);
    } else {
      row.textContent = text;
    }
    log.appendChild(row);
    log.scrollTop = log.scrollHeight;
    return row;
  }

  // opts.record === false keeps a line out of `messages` — the error
  // lines (fallback, rate-limit) are things Abe SHOWED, not things he
  // SAID; replaying them to the model reads as him having said them.
  function say(text, opts) {
    if (!opts || opts.record !== false) {
      messages.push({ role: 'assistant', content: text });
    }
    addRow('abe', text);
    // World-visible side effects only while the panel is actually up —
    // a reply landing after close() would otherwise make Abe hop and
    // blip on the island for no reason a visitor can see.
    if (!panel.hidden) {
      if (VH.gofer && VH.gofer.chatReact) VH.gofer.chatReact();
      // The RPG text-box blip — his voice arriving, once per line
      if (VH.sfx && VH.sfx.chatBlip) VH.sfx.chatBlip();
    }
  }

  function startDigging() {
    digRow = document.createElement('div');
    digRow.className = 'chat-msg chat-msg--abe chat-digging';
    digRow.appendChild(abeFace());
    const body = document.createElement('span');
    body.className = 'chat-msg-text';
    body.textContent = 'Abe is digging';
    const dots = document.createElement('span');
    dots.className = 'chat-dots';
    dots.setAttribute('aria-hidden', 'true');
    for (let i = 0; i < 3; i++) dots.appendChild(document.createElement('i'));
    body.appendChild(dots);
    digRow.appendChild(body);
    log.appendChild(digRow);
    log.scrollTop = log.scrollHeight;
  }
  function stopDigging() {
    if (digRow) { digRow.remove(); digRow = null; }
  }

  // ── Chips ───────────────────────────────────────────────────
  // A used chip disappears; the rest stay — they are the zero-cost
  // path, so the panel keeps offering it. Chip answers get a short
  // fake dig beat purely for rhythm (an instant answer after the
  // typed ones went through a real dig would feel like a different
  // creature answering); reduced motion skips the theatre.
  function buildChips() {
    chipsRow.textContent = '';
    for (const chip of CHIPS) {
      if (chip.used) continue;
      const b = document.createElement('button');
      b.type = 'button';
      b.className = 'chat-chip';
      b.textContent = chip.label;
      b.addEventListener('click', () => {
        if (inFlight) return;
        chip.used = true;
        if (VH.sfx) VH.sfx.uiTick('slot');
        messages.push({ role: 'user', content: chip.label });
        addRow('you', chip.label);
        buildChips();
        const reduced = VH.engine && VH.engine.reducedMotion;
        if (reduced) { say(chip.answer); return; }
        // The fake beat holds the same lock as a real request — without
        // it, a second chip (or Enter) inside the 450ms overwrites the
        // single digRow slot and strands a "digging…" row forever.
        inFlight = true;
        startDigging();
        chipTimer = setTimeout(() => {
          chipTimer = null;
          inFlight = false;
          stopDigging();
          say(chip.answer);
        }, 450);
      });
      chipsRow.appendChild(b);
    }
    // Post-signoff the placeholder points at the chips — keep it honest
    // when the last chip is spent after the input has already locked.
    if (input.disabled) input.placeholder = signoffPlaceholder();
  }

  // ── The relay call ──────────────────────────────────────────
  async function ask(text) {
    messages.push({ role: 'user', content: text });
    addRow('you', text);
    turnsUsed++;
    inFlight = true;
    send.disabled = true;
    startDigging();

    // Last N messages, trimmed so the FIRST sent message is a user
    // turn (the worker validates that; the opener is an assistant
    // message and must never lead the transcript).
    const history = messages.slice(-HISTORY_SENT);
    while (history.length && history[0].role !== 'user') history.shift();

    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), TIMEOUT_MS);
    let line = LINE_FALLBACK;
    let fromAbe = false; // a real reply goes in the transcript; error copy doesn't
    try {
      const res = await fetch(API, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ messages: history }),
        signal: ctrl.signal,
      });
      if (res.status === 429) {
        line = LINE_RATELIMIT;
        turnsUsed--; // a throttled question shouldn't spend a turn
      } else if (res.ok) {
        const data = await res.json();
        if (data && typeof data.reply === 'string' && data.reply.trim()) {
          line = data.reply.trim();
          fromAbe = true;
        }
      }
    } catch (_) { /* network/timeout/abort → fallback line */ }
    clearTimeout(timer);

    stopDigging();
    say(line, { record: fromAbe });
    inFlight = false;
    send.disabled = false;

    if (turnsUsed >= MAX_TURNS) {
      input.disabled = true;
      send.disabled = true;
      input.placeholder = signoffPlaceholder();
      // Half a beat later, never the same tick as the answer — two
      // say()s together start their blips on the same audio frame,
      // which stacks into one loud phase-coherent click.
      setTimeout(() => say(LINE_SIGNOFF), 600);
    }
  }

  // Only promise chips if there are chips left to press.
  // DRAFT copy — Gate B reviews both lines with the rest of the panel.
  function signoffPlaceholder() {
    return CHIPS.some((c) => !c.used)
      ? 'Chips still work!'
      : 'Abe has gone back to digging.';
  }

  form.addEventListener('submit', (e) => {
    e.preventDefault();
    const text = input.value.trim();
    if (!text || inFlight || turnsUsed >= MAX_TURNS) return;
    input.value = '';
    if (VH.sfx) VH.sfx.uiTick('slot');
    ask(text);
  });

  // ── Open / close (the codex pattern) ────────────────────────
  C.isOpen = () => !panel.hidden;

  C.open = () => {
    if (!panel.hidden) return;
    panel.hidden = false;
    lastFocus = document.activeElement;
    if (VH.sfx) VH.sfx.uiTick('open');
    if (VH.gofer && VH.gofer.chatOpen) VH.gofer.chatOpen();
    if (!opened) {
      opened = true;
      // The greeting is his, not the network's — instant and free. Through
      // say(), like every line he speaks, so it blips and he reacts; the
      // hand-rolled version here was the one Abe line that never blipped.
      say(OPENER);
      buildChips();
    }
    // Desktop gets the caret ready; on touch, focusing would slam the
    // keyboard open over the island the tap just came from.
    if (window.matchMedia('(pointer: fine)').matches && !input.disabled) {
      input.focus();
    }
  };

  // opts.silent: the codex-open path closes the chat as a side effect
  // and already played its own 'open' tick — two ticks in one press
  // sounds like a stutter. Escape and the ✕ keep their sound.
  C.close = (opts) => {
    if (panel.hidden) return;
    panel.hidden = true;
    // Drop a chip's pending fake-dig beat. Without this the timeout still
    // fires into a hidden panel: the lock stays set (so the next visit's
    // first chip is dead) and Abe's answer is sitting there on reopen with
    // no arrival. The comment on chipTimer promised this; it was never wired.
    if (chipTimer) {
      clearTimeout(chipTimer);
      chipTimer = null;
      inFlight = false;
      stopDigging();
    }
    if (VH.sfx && !(opts && opts.silent)) VH.sfx.uiTick('close');
    if (VH.gofer && VH.gofer.chatClose) VH.gofer.chatClose();
    if (lastFocus && lastFocus.focus && document.contains(lastFocus)) {
      lastFocus.focus();
    }
    lastFocus = null;
  };

  document.getElementById('chatClose').addEventListener('click', () => C.close());
})();
