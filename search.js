// Monte Carlo tree search guided by the network: a JavaScript port of chess/agent/mcts.py (AlphaZero's PUCT rule),
// with the same settings as the rated games (c_puct 1.5, first-play urgency 0.25, no noise).
//
// Each simulation walks from the root, at every node picking the child with the highest
//     Q(child) + c_puct * P(child) * sqrt(N(parent) + 1) / (1 + N(child))
// (P = the network's prior, N = visits, Q = average score for the player who moved into the child). At a new leaf
// the network gives priors and a value, and the value is backed up the path, flipping sides at each ply.
// Checkmate, stalemate, the 50-move rule and insufficient material are scored exactly; any repetition of an earlier
// position (in the game or on the search path) counts as a draw. The move played is the most-visited root child.
import { Chess } from "https://cdn.jsdelivr.net/npm/chess.js@1.0.0/+esm";
import { encode } from "./encode.js";

const C_PUCT = 1.5, FPU = 0.25;

// Without threads the network runs on the page's own thread, and a chain of awaits never lets the browser repaint:
// the page froze for the whole search (2026-11-15, 19 s on the public site). A MessageChannel message is a real
// task, so awaiting one hands control back to the browser without setTimeout's 4 ms minimum.
const channel = new MessageChannel();
let wake = null;
channel.port1.onmessage = () => { const w = wake; wake = null; if (w) w(); };
function breathe() { return new Promise((r) => { wake = r; channel.port2.postMessage(0); }); }

function key(fen) { return fen.split(" ", 4).join(" "); }      // pieces, side to move, castling, en passant

function expand(node, moves, logits) {
  let mx = -Infinity;
  for (const m of moves) if (logits[m.index] > mx) mx = logits[m.index];
  let sum = 0;
  const prior = moves.map((m) => { const e = Math.exp(logits[m.index] - mx); sum += e; return e; });
  node.moves = moves.map((m) => m.move);
  node.prior = prior.map((p) => p / sum);
  node.children = new Array(moves.length).fill(null);
  node.n = new Float64Array(moves.length);
  node.w = new Float64Array(moves.length);
}

function value(v) {                                            // win/draw/loss logits -> expected score, 0..1
  const mx = Math.max(v[0], v[1], v[2]);
  const e = [Math.exp(v[0] - mx), Math.exp(v[1] - mx), Math.exp(v[2] - mx)];
  return (e[0] + 0.5 * e[1]) / (e[0] + e[1] + e[2]);
}

// game: chess.js game (not changed). run(x) -> {p, v} runs the network on one position.
// Returns {move, score (the mover's expected score), visits: [{move, n}], sims}.
export async function search(game, run, sims, onProgress, cancelled) {
  const board = new Chess();
  const history = new Set();
  for (const h of game.history({ verbose: true })) history.add(key(h.before));
  board.load(game.fen());
  const root = {};
  {
    const { x, moves } = encode(board);
    const out = await run(x);
    expand(root, moves, out.p);
    root.v = value(out.v);
  }
  let done = 0;
  while (done < sims) {
    if (cancelled && cancelled()) return null;
    let node = root, pushed = 0, v;
    const path = [];
    const keys = new Set(history);
    keys.add(key(board.fen()));
    for (;;) {
      let total = 0, wsum = 0;
      for (let i = 0; i < node.n.length; i++) { total += node.n[i]; wsum += node.w[i]; }
      const unvisited = Math.max(0, (total ? wsum / total : 0.5) - FPU);
      const root_n = Math.sqrt(total + 1);
      let a = 0, best = -Infinity;
      for (let i = 0; i < node.n.length; i++) {
        const q = node.n[i] > 0 ? node.w[i] / node.n[i] : unvisited;
        const s = q + C_PUCT * node.prior[i] * root_n / (1 + node.n[i]);
        if (s > best) { best = s; a = i; }
      }
      path.push([node, a]);
      const m = node.moves[a];
      board.move({ from: m.from, to: m.to, promotion: m.promotion });
      pushed++;
      let child = node.children[a];
      if (child === null) {
        child = node.children[a] = { terminal: null };
        const enc = encode(board);
        if (!enc.moves.length) child.terminal = board.inCheck() ? 0 : 0.5;
        else if (board.isInsufficientMaterial() || +board.fen().split(" ")[4] >= 100 || keys.has(key(board.fen())))
          child.terminal = 0.5;
        if (child.terminal !== null) { v = child.terminal; break; }
        const out = await run(enc.x);
        expand(child, enc.moves, out.p);
        v = value(out.v);
        break;
      }
      if (child.terminal !== null) { v = child.terminal; break; }
      keys.add(key(board.fen()));
      node = child;
    }
    for (let i = 0; i < pushed; i++) board.undo();
    for (let i = path.length - 1; i >= 0; i--) {              // v: score for the side to move at the leaf
      v = 1 - v;
      path[i][0].n[path[i][1]] += 1;
      path[i][0].w[path[i][1]] += v;
    }
    done++;
    if (onProgress && (done % 5 === 0 || done === sims)) onProgress(done, sims);
    if (done % 2 === 0) await breathe();              // let the page repaint and take input
  }
  let a = 0, total = 0, wsum = 0;
  for (let i = 0; i < root.n.length; i++) {
    if (root.n[i] > root.n[a]) a = i;
    total += root.n[i]; wsum += root.w[i];
  }
  return { move: root.moves[a], score: total ? wsum / total : root.v, sims: done,
           visits: root.moves.map((m, i) => ({ move: m, n: root.n[i] })) };
}
