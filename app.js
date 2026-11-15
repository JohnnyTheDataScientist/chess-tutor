// Play against the networks in the browser. The rules come from chess.js; the networks run with onnxruntime-web.
import { Chess } from "https://cdn.jsdelivr.net/npm/chess.js@1.0.0/+esm";
import { encode } from "./encode.js?v=7";
import { search } from "./search.js?v=7";
import * as sound from "./sound.js?v=7";

// Ratings: no search, Stockfish's UCI_Elo scale at 120+1 (chess/logs/ratings_table.md, 2026-11-14).
const MODELS = [
  { id: "human", name: "The Student", elo: "about 1430", mb: 2.1,
    what: "Learned by imitating 979,070 games between strong human players." },
  { id: "engine", name: "The Apprentice", elo: "about 1490", mb: 2.1,
    what: "The same small network, taught by Stockfish's verdicts instead of human moves." },
  { id: "transformer", name: "The Transformer", elo: "about 1950", mb: 10.1,
    what: "A larger network with attention, taught by Stockfish. Plays instantly." },
  // the same network with search. 200 simulations (rated 2878 +- 57) took ~19 s a move in the browser, too slow
  // (the user, 2026-11-15), so it thinks 50 positions. 50 simulations has not been rated yet.
  { id: "transformer50", file: "transformer", name: "The Transformer, thinking", elo: "stronger, not rated yet",
    mb: 10.1, sims: 50,
    what: "The same network, but it looks ahead: 50 positions per move. Stronger than the plain Transformer, a few seconds a move (beta)." },
];
const MIN_REPLY_MS = 700;     // the shortest time between the visitor's move and the model's reply
const VARIETY_MOVES = 3;      // the model's first moves are sampled among its top choices, so games differ

const $ = (id) => document.getElementById(id);
const boardEl = $("board"), statusEl = $("status"), movesEl = $("moves");
const game = new Chess();
const sessions = {};
let model = null;             // the chosen MODELS entry
let human = "w";              // the colour the visitor plays
let colourChoice = "w";
let flipped = false;
let selected = null;          // selected square name
let lastMove = null;
let busy = false;             // the model is thinking or a file is loading
let modelScore = null;        // the model's expected score for itself, 0..1
let token = 0;                // cancels a pending model move when a new game starts

ort.env.wasm.numThreads = self.crossOriginIsolated ? Math.min(4, navigator.hardwareConcurrency || 1) : 1;

function squareName(file, rank) { return "abcdefgh"[file] + (rank + 1); }

function render() {
  boardEl.textContent = "";
  const pos = game.board();                       // [rank 8 .. rank 1][file a .. h]
  const targets = selected ? game.moves({ square: selected, verbose: true }).map((m) => m.to) : [];
  const inCheck = game.inCheck();
  for (let row = 0; row < 8; row++) {
    for (let col = 0; col < 8; col++) {
      const rank = flipped ? row : 7 - row, file = flipped ? 7 - col : col;
      const name = squareName(file, rank);
      const piece = pos[7 - rank][file];
      const sq = document.createElement("div");
      sq.className = "sq " + ((rank + file) % 2 ? "l" : "d");
      sq.dataset.sq = name;
      if (lastMove && (lastMove.from === name || lastMove.to === name)) sq.classList.add("last");
      if (selected === name) sq.classList.add("sel");
      if (drag && drag.active && drag.from === name) sq.classList.add("lifted");
      if (targets.includes(name)) sq.classList.add("target", ...(piece ? ["occ"] : []));
      if (inCheck && piece && piece.type === "k" && piece.color === game.turn()) sq.classList.add("check");
      if (col === 0) sq.insertAdjacentHTML("beforeend", `<span class="coord rank">${rank + 1}</span>`);
      if (row === 7) sq.insertAdjacentHTML("beforeend", `<span class="coord file">${"abcdefgh"[file]}</span>`);
      if (piece) {
        const img = document.createElement("img");
        img.src = `img/${piece.color}${piece.type}.png`;
        img.alt = (piece.color === "w" ? "white " : "black ") +
          { p: "pawn", n: "knight", b: "bishop", r: "rook", q: "queen", k: "king" }[piece.type];
        sq.appendChild(img);
      }
      boardEl.appendChild(sq);
    }
  }
  const top = flipped ? "w" : "b", bottom = flipped ? "b" : "w";
  for (const [el, c] of [[$("top-label"), top], [$("bottom-label"), bottom]]) {
    const who = c === human ? "You" : (model ? model.name : "Model");
    const thinking = busy && c !== human && model ? ' <span class="thinking">is thinking…</span>' : "";
    el.innerHTML = `<span class="dot ${c}"></span>${who}${thinking}`;
  }
  const hist = game.history();
  movesEl.innerHTML = hist.length ? hist.map((san, i) =>
    (i % 2 === 0 ? `<span><span class="n">${i / 2 + 1}.</span>${san}` : ` ${san}</span>`)).join("") +
    (hist.length % 2 ? "</span>" : "") : '<span class="thinking">No moves yet.</span>';
  movesEl.scrollTop = movesEl.scrollHeight;
  const you = modelScore == null ? 50 : Math.round(100 * (1 - modelScore));
  $("bar-fill").style.width = you + "%";
  $("bar-you").textContent = `You ${you}%`;
  $("bar-model").textContent = `${model ? model.name : "Model"} ${100 - you}%`;
  $("think").hidden = !(busy && model && model.sims);
  if (!busy) $("think-fill").style.width = "0%";
  $("think-time").textContent = lastThinkMs && model && model.sims
    ? `Last move: ${(lastThinkMs / 1000).toFixed(1)} s of thinking` : "";
  $("undo").disabled = busy || game.history().length < (human === "w" ? 2 : 3) && !(human === "b" && game.history().length === 2);
}

// The result is announced on the board itself (2026-11-15, the user): win, loss or draw, with the reason.
let resultDismissed = false;
let resultReady = false;      // true once the pause after the last move is over
let resultTimer = null;
function showResult() {
  const el = $("result");
  if (!model || !game.isGameOver()) {
    el.hidden = true; resultDismissed = false; resultReady = false;
    clearTimeout(resultTimer); resultTimer = null;
    return;
  }
  if (resultDismissed) { el.hidden = true; return; }
  // The card waits, so the last move is seen on the board first (the user lost a game and never saw the mating
  // move, 2026-11-15): 1.8 s after the model's move, 0.9 s after the visitor's own.
  if (!resultReady) {
    el.hidden = true;
    if (!resultTimer) {
      const modelMovedLast = game.turn() === human;
      resultTimer = setTimeout(() => { resultTimer = null; resultReady = true; showResult(); },
                               modelMovedLast ? 1800 : 900);
    }
    return;
  }
  let kind, title, why;
  if (game.isCheckmate()) {
    const won = game.turn() !== human;
    kind = won ? "win" : "loss";
    title = won ? "You win!" : "You lost";
    why = won ? `Checkmate. You beat ${model.name}.` : `Checkmate. ${model.name} wins this one.`;
  } else {
    kind = "draw"; title = "Draw";
    why = game.isStalemate() ? "Stalemate: the side to move has no legal move."
      : game.isThreefoldRepetition() ? "The same position came up three times."
      : game.isInsufficientMaterial() ? "Neither side has enough pieces to checkmate."
      : "Fifty moves without a capture or a pawn move.";
  }
  el.className = "result " + kind;
  el.innerHTML = `<div class="card"><div class="title">${title}</div><div class="why">${why}</div>` +
    '<div class="row"><button data-a="new">New game</button><button data-a="see">See the board</button></div></div>';
  el.hidden = false;
}
$("result").onclick = (ev) => {
  const b = ev.target.closest("button");
  if (!b) return;
  if (b.dataset.a === "new") newGame(); else { resultDismissed = true; showResult(); }
};

function setStatus() {
  showResult();
  if (!model) { statusEl.textContent = "Choose an opponent to start."; return; }
  if (game.isCheckmate()) {
    statusEl.textContent = game.turn() === human ? `Checkmate. ${model.name} wins.` : "Checkmate. You win!";
  } else if (game.isStalemate()) statusEl.textContent = "Stalemate. It's a draw.";
  else if (game.isThreefoldRepetition()) statusEl.textContent = "Draw by repetition.";
  else if (game.isInsufficientMaterial()) statusEl.textContent = "Draw: not enough pieces to mate.";
  else if (game.isDraw()) statusEl.textContent = "Draw by the fifty-move rule.";
  else if (busy) statusEl.textContent = `${model.name} is thinking…`;
  else if (game.turn() !== human) statusEl.textContent = `${model.name} to move…`;
  else statusEl.textContent = (game.inCheck() ? "Check. " : "") + "Your move.";
}

async function load(m) {
  const file = m.file || m.id;                      // two opponents can share one network file
  if (sessions[file]) return sessions[file];
  statusEl.textContent = `Loading ${m.name} (${m.mb} MB)…`;
  const res = await fetch(`models/${file}.onnx`);
  if (!res.ok) throw new Error("download failed: " + res.status);
  const buf = await res.arrayBuffer();
  sessions[file] = await ort.InferenceSession.create(buf, { executionProviders: ["wasm"] });
  return sessions[file];
}

// the sound for a move that was just played (chess.js move object), and for the end of the game
function moveSound(m) {
  if (game.isGameOver()) {
    sound.play(m.captured ? "capture" : "move");
    const kind = game.isCheckmate() ? (game.turn() === human ? "loss" : "win") : "draw";
    setTimeout(() => sound.play(kind), game.turn() === human ? 1800 : 900);   // with the result card
  } else sound.play(game.inCheck() ? "check" : m.captured ? "capture" : "move");
}

async function modelMove() {
  if (!model || game.isGameOver() || game.turn() === human) return;
  const mine = ++token;
  busy = true; setStatus(); render();
  try {
    const session = await load(model);
    const run = async (x) => {
      const out = await session.run({ x: new ort.Tensor("float32", x, [1, 18, 8, 8]) });
      return { p: out.p.data, v: out.v.data };
    };
    const t0 = performance.now();
    const modelPlies = Math.floor(game.history().length / 2);
    const pickFrom = (items, weight) => {                   // random choice in proportion to weight
      let r = Math.random() * items.reduce((acc, it) => acc + weight(it), 0);
      for (const it of items) { r -= weight(it); if (r <= 0) return it; }
      return items[items.length - 1];
    };
    let m, score;
    if (model.sims) {
      // search: the most-visited move; in the first moves, any move with at least half the top visits may be played
      const res = await search(game, run, model.sims, (done, of) => {
        if (mine !== token) return;
        statusEl.textContent = `${model.name}… ${done} / ${of}`;
        $("think-fill").style.width = Math.round(100 * done / of) + "%";
      }, () => mine !== token);
      if (!res || mine !== token) return;
      m = res.move; score = res.score;
      if (modelPlies < VARIETY_MOVES) {
        const top = Math.max(...res.visits.map((v) => v.n));
        m = pickFrom(res.visits.filter((v) => v.n >= top / 2), (v) => v.n).move;
      }
      lastThinkMs = Math.round(performance.now() - t0);
    } else {
      const { x, moves } = encode(game);
      const out = await run(x);
      const logits = out.p, v = out.v;
      const mx = Math.max(v[0], v[1], v[2]);
      const e = [0, 1, 2].map((i) => Math.exp(v[i] - mx));
      score = (e[0] + 0.5 * e[1]) / (e[0] + e[1] + e[2]);
      let choice = moves.reduce((x1, x2) => (logits[x2.index] > logits[x1.index] ? x2 : x1));
      if (modelPlies < VARIETY_MOVES) {
        // sample among moves at least half as likely as the first choice, in proportion to their probability
        const top = logits[choice.index];
        choice = pickFrom(moves.filter((c) => logits[c.index] >= top - Math.LN2), (c) => Math.exp(logits[c.index] - top));
      }
      m = choice.move;
    }
    // Every opponent waits at least MIN_REPLY_MS after the visitor's move, so its move is easy to follow. The
    // search can finish at once (a forced mate is found without the network), and then it moved instantly.
    const wait = MIN_REPLY_MS - (performance.now() - t0);
    if (wait > 0) await new Promise((r) => setTimeout(r, wait));
    if (mine !== token) return;                             // a new game started meanwhile
    modelScore = score;
    const played = game.move({ from: m.from, to: m.to, promotion: m.promotion });
    lastMove = { from: m.from, to: m.to };
    moveSound(played);
  } catch (err) {
    statusEl.textContent = "The model could not be loaded: " + err.message;
    busy = false; render();
    return;
  }
  busy = false; setStatus(); render();
}

let lastThinkMs = null;       // how long the last search took (shown under the board, useful on phones)
window.__lastThinkMs = () => lastThinkMs;
window.__soundState = () => sound.state();

function tryMove(from, to, promotion) {
  const legal = game.moves({ square: from, verbose: true }).filter((m) => m.to === to);
  if (!legal.length) return false;
  if (legal[0].promotion && !promotion) { askPromotion(from, to); return true; }
  const played = game.move({ from, to, promotion });
  lastMove = { from, to };
  selected = null;
  moveSound(played);
  setStatus(); render();
  modelMove();
  return true;
}

function askPromotion(from, to) {
  const el = $("promo");
  el.innerHTML = '<div class="box">' + ["q", "r", "b", "n"].map((p) =>
    `<button data-p="${p}" aria-label="promote to ${{ q: "queen", r: "rook", b: "bishop", n: "knight" }[p]}">` +
    `<img src="img/${human}${p}.png" alt=""></button>`).join("") + "</div>";
  el.hidden = false;
  el.onclick = (ev) => {
    const b = ev.target.closest("button");
    el.hidden = true;
    if (b) tryMove(from, to, b.dataset.p); else { selected = null; render(); }
  };
}

// Two ways to move (2026-11-15, the user): click a piece and then a marked square, or drag the piece there.
// A press that moves more than a few pixels becomes a drag; otherwise the click handler below runs as before.
let drag = null;              // {from, x, y, active, ghost} while a pointer is down on one of the visitor's pieces
let suppressClick = false;    // the click event that follows a finished drag is ignored

function canPlay() { return model && !busy && !game.isGameOver() && game.turn() === human; }

boardEl.addEventListener("pointerdown", (ev) => {
  if (ev.button > 0 || !canPlay()) return;
  const sq = ev.target.closest(".sq");
  if (!sq) return;
  const piece = game.get(sq.dataset.sq);
  if (!piece || piece.color !== human) return;
  drag = { from: sq.dataset.sq, x: ev.clientX, y: ev.clientY, active: false, ghost: null, id: ev.pointerId };
});

window.addEventListener("pointermove", (ev) => {
  if (!drag || ev.pointerId !== drag.id) return;
  if (!drag.active) {
    if (Math.hypot(ev.clientX - drag.x, ev.clientY - drag.y) < 6) return;
    drag.active = true;
    selected = drag.from;                           // shows the legal squares, like a click
    render();
    const src = boardEl.querySelector(`[data-sq="${drag.from}"]`);
    const size = src.getBoundingClientRect().width;
    const g = src.querySelector("img").cloneNode();
    g.className = "ghost";
    g.style.width = g.style.height = size + "px";
    document.body.appendChild(g);
    drag.ghost = g;
  }
  drag.ghost.style.left = ev.clientX + "px";
  drag.ghost.style.top = ev.clientY + "px";
  ev.preventDefault();
}, { passive: false });

function endDrag(ev, cancelled) {
  if (!drag || (ev && ev.pointerId !== drag.id)) return;
  const d = drag;
  drag = null;
  if (!d.active) return;                            // it was a click: the click handler takes it
  d.ghost.remove();
  suppressClick = true;
  setTimeout(() => { suppressClick = false; }, 0);
  const el = cancelled ? null : document.elementFromPoint(ev.clientX, ev.clientY);
  const sq = el && el.closest(".sq");
  if (sq && sq.dataset.sq !== d.from && canPlay() && tryMove(d.from, sq.dataset.sq)) return;
  selected = null;                                  // dropped on an illegal square or off the board: put it back
  render();
}
window.addEventListener("pointerup", (ev) => endDrag(ev, false));
window.addEventListener("pointercancel", (ev) => endDrag(ev, true));

boardEl.addEventListener("click", (ev) => {
  if (suppressClick) return;
  const sq = ev.target.closest(".sq");
  if (!sq || !canPlay()) return;
  const name = sq.dataset.sq;
  if (selected && selected !== name && tryMove(selected, name)) return;
  const piece = game.get(name);
  selected = piece && piece.color === human && selected !== name ? name : null;
  render();
});

function newGame() {
  token++;
  // ?fen=<position> starts from that position (for tests now, for lessons and puzzles later)
  const fen = new URLSearchParams(location.search).get("fen");
  if (fen) game.load(fen); else game.reset();
  human = colourChoice === "r" ? (Math.random() < 0.5 ? "w" : "b") : colourChoice;
  flipped = human === "b";
  selected = null; lastMove = null; modelScore = null; busy = false; lastThinkMs = null;
  setStatus(); render();
  modelMove();
}

$("new").onclick = newGame;
// sound: browsers allow it only after a press, so the first press anywhere unlocks it
window.addEventListener("pointerdown", () => sound.unlock(), { capture: true });
const soundBtn = $("sound");
const soundLabel = () => { soundBtn.textContent = sound.isMuted() ? "Sound: off" : "Sound: on"; };
soundBtn.onclick = () => { sound.setMuted(!sound.isMuted()); soundLabel(); if (!sound.isMuted()) sound.play("move"); };
soundLabel();
$("flip").onclick = () => { flipped = !flipped; render(); };
$("undo").onclick = () => {
  if (busy) return;
  token++;
  game.undo();                                   // back to the visitor's turn: one or two half-moves
  if (game.turn() !== human && game.history().length) game.undo();
  const h = game.history({ verbose: true });
  lastMove = h.length ? { from: h[h.length - 1].from, to: h[h.length - 1].to } : null;
  selected = null;
  setStatus(); render();
  modelMove();
};
// Two views (2026-11-15, the user): first choose the opponent and the colour, then the board appears.
let picked = null;            // the opponent chosen on the first page, before Start
const startBtn = $("start");

function showView(name) {
  $("setup").hidden = name !== "setup";
  $("play").hidden = name !== "play";
  window.scrollTo(0, 0);
}

$("colour").onclick = (ev) => {
  const b = ev.target.closest("button");
  if (!b) return;
  colourChoice = b.dataset.c;
  for (const x of $("colour").children) x.classList.toggle("on", x === b);
};

const modelsEl = $("models");
for (const m of MODELS) {
  const b = document.createElement("button");
  b.className = "model";
  b.innerHTML = `<span class="name"><span>${m.name}</span><span class="elo">${m.elo}</span></span>` +
    `<span class="what">${m.what}</span><span class="size">${m.mb} MB download, runs on your device</span>`;
  b.onclick = () => {
    picked = m;
    for (const x of modelsEl.children) x.classList.toggle("on", x === b);
    startBtn.disabled = false;
    startBtn.textContent = `Play ${m.name}`;
    $("setup-hint").textContent = "";
  };
  modelsEl.appendChild(b);
}

startBtn.onclick = async () => {
  if (!picked) return;
  startBtn.disabled = true;
  startBtn.textContent = sessions[picked.id] ? "Starting…" : `Loading ${picked.name} (${picked.mb} MB)…`;
  try {
    await load(picked);                            // the download happens here, before the board is shown
  } catch (err) {
    $("setup-hint").textContent = "The model could not be loaded (" + err.message + "). Check your connection and try again.";
    startBtn.disabled = false;
    startBtn.textContent = `Play ${picked.name}`;
    return;
  }
  model = picked;
  $("vs").innerHTML = `<span class="name"><span>${model.name}</span><span class="elo">${model.elo}</span></span>` +
    `<span class="what">${model.what}</span>`;
  startBtn.disabled = false;
  startBtn.textContent = `Play ${picked.name}`;
  showView("play");
  newGame();
};

$("change").onclick = () => { token++; busy = false; showView("setup"); };

setStatus(); render();
