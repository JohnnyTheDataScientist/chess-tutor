// Move sounds, made in the browser with the Web Audio API (no audio files to download).
// move: a short wooden click; capture: a heavier knock; check: the click plus a high note; and a few notes for the
// end of the game. Browsers only allow sound after the visitor has touched the page, so unlock() is called on the
// first press.
let ctx = null;
let muted = false;
try { muted = localStorage.getItem("muted") === "1"; } catch (e) { /* private mode: keep the default */ }

export function isMuted() { return muted; }
export function setMuted(m) {
  muted = m;
  try { localStorage.setItem("muted", m ? "1" : "0"); } catch (e) { /* ignore */ }
}

export function unlock() {
  if (!ctx) {
    const AC = window.AudioContext || window.webkitAudioContext;
    if (!AC) return;
    ctx = new AC();
  }
  if (ctx.state === "suspended") ctx.resume();
}

function knock(t, freq, dur, gain) {          // filtered noise burst with a fast decay: wood on wood
  const n = Math.max(1, Math.floor(ctx.sampleRate * dur));
  const buf = ctx.createBuffer(1, n, ctx.sampleRate);
  const d = buf.getChannelData(0);
  for (let i = 0; i < n; i++) d[i] = (Math.random() * 2 - 1) * Math.pow(1 - i / n, 3);
  const src = ctx.createBufferSource();
  src.buffer = buf;
  const bp = ctx.createBiquadFilter();
  bp.type = "bandpass"; bp.frequency.value = freq; bp.Q.value = 1.2;
  const g = ctx.createGain();
  g.gain.value = gain;
  src.connect(bp).connect(g).connect(ctx.destination);
  src.start(t);
}

function note(t, freq, dur, gain, type = "sine") {
  const o = ctx.createOscillator();
  o.type = type; o.frequency.value = freq;
  const g = ctx.createGain();
  g.gain.setValueAtTime(0.0001, t);
  g.gain.exponentialRampToValueAtTime(gain, t + 0.012);
  g.gain.exponentialRampToValueAtTime(0.0001, t + dur);
  o.connect(g).connect(ctx.destination);
  o.start(t); o.stop(t + dur + 0.02);
}

// kind: "move" | "capture" | "check" | "win" | "loss" | "draw"
export function play(kind) {
  if (muted || !ctx || ctx.state !== "running") return;
  const t = ctx.currentTime + 0.005;
  if (kind === "move" || kind === "check") {
    knock(t, 1700, 0.045, 0.55); note(t, 190, 0.07, 0.22);
    if (kind === "check") note(t + 0.05, 880, 0.16, 0.12, "triangle");
  } else if (kind === "capture") {
    knock(t, 900, 0.08, 0.8); knock(t + 0.03, 2200, 0.04, 0.35); note(t, 120, 0.11, 0.3);
  } else if (kind === "win") {
    [523.25, 659.25, 783.99, 1046.5].forEach((f, i) => note(t + i * 0.11, f, 0.32, 0.16, "triangle"));
  } else if (kind === "loss") {
    [392.0, 329.63, 261.63].forEach((f, i) => note(t + i * 0.16, f, 0.38, 0.15, "triangle"));
  } else if (kind === "draw") {
    [440.0, 440.0].forEach((f, i) => note(t + i * 0.18, f, 0.26, 0.14, "triangle"));
  }
}

export function state() { return ctx ? ctx.state : "not started"; }   // for testing
