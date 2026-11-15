// Board and move encoding for the networks: a JavaScript port of chess/engine/encode.py. It must match the Python
// code exactly (checked on 150 positions by test/index.html against test/vectors.json).
//
// Everything is seen from the side to move: with Black to move the board is mirrored (ranks flipped, colours
// swapped), so the network always plays "up the board".
// Input: 18 planes of 8x8 (plane * 64 + square, a1 = 0 ... h8 = 63):
//   0-5 our P N B R Q K, 6-11 theirs, 12-15 castling (our O-O, our O-O-O, their O-O, their O-O-O),
//   16 en-passant target (only when an en-passant capture is legal), 17 all ones.
// Moves: 73 x 64, index = plane * 64 + from. Planes 0-55 queen-style moves (8 directions x distance 1-7; queen
// promotions use these), 56-63 knight jumps, 64-72 under-promotions (left, straight, right) x (N, B, R).

const PIECE = { p: 0, n: 1, b: 2, r: 3, q: 4, k: 5 };
const DIRS = [[1, 0], [1, 1], [0, 1], [-1, 1], [-1, 0], [-1, -1], [0, -1], [1, -1]];   // (drank, dfile)
const KNIGHT = [[2, 1], [1, 2], [-1, 2], [-2, 1], [-2, -1], [-1, -2], [1, -2], [2, -1]];
const UNDER = { n: 0, b: 1, r: 2 };

export function squareIndex(name) {          // "e4" -> 28
  return (name.charCodeAt(1) - 49) * 8 + (name.charCodeAt(0) - 97);
}

// fen: the position; epSquare: the en-passant target ("e3") when an en-passant capture is legal, else null
export function planes(fen, epSquare) {
  const [placement, turn, castling] = fen.split(" ");
  const black = turn === "b";
  const x = new Float32Array(18 * 64);
  let rank = 7, file = 0;
  for (const ch of placement) {
    if (ch === "/") { rank--; file = 0; continue; }
    if (ch >= "1" && ch <= "8") { file += +ch; continue; }
    const white = ch === ch.toUpperCase();
    const ours = white !== black;
    let sq = rank * 8 + file;
    if (black) sq ^= 56;
    x[((ours ? 0 : 6) + PIECE[ch.toLowerCase()]) * 64 + sq] = 1;
    file++;
  }
  const has = (c) => castling.includes(c);
  const rights = black ? [has("k"), has("q"), has("K"), has("Q")] : [has("K"), has("Q"), has("k"), has("q")];
  rights.forEach((on, k) => { if (on) x.fill(1, (12 + k) * 64, (13 + k) * 64); });
  if (epSquare) {
    let sq = squareIndex(epSquare);
    if (black) sq ^= 56;
    x[16 * 64 + sq] = 1;
  }
  x.fill(1, 17 * 64, 18 * 64);
  return x;
}

// from, to: square names; promotion: "q" | "r" | "b" | "n" | undefined; blackToMove: the side making the move
export function moveIndex(from, to, promotion, blackToMove) {
  let f = squareIndex(from), t = squareIndex(to);
  if (blackToMove) { f ^= 56; t ^= 56; }
  const dr = (t >> 3) - (f >> 3), df = (t & 7) - (f & 7);
  if (promotion && promotion !== "q") return (64 + (df + 1) * 3 + UNDER[promotion]) * 64 + f;
  const k = KNIGHT.findIndex(([a, b]) => a === dr && b === df);
  if (k >= 0) return (56 + k) * 64 + f;
  const dist = Math.max(Math.abs(dr), Math.abs(df));
  const d = DIRS.findIndex(([a, b]) => a === Math.sign(dr) && b === Math.sign(df));
  return (d * 7 + dist - 1) * 64 + f;
}

// chess: a chess.js game. Returns {x, moves: [{move, index}]} for the position on the board.
export function encode(chess) {
  const verbose = chess.moves({ verbose: true });
  const ep = verbose.find((m) => m.flags.includes("e"));
  const black = chess.turn() === "b";
  return {
    x: planes(chess.fen(), ep ? ep.to : null),
    moves: verbose.map((m) => ({ move: m, index: moveIndex(m.from, m.to, m.promotion, black) })),
  };
}

// logits: Float32Array(4672) from the network; v: Float32Array(3) win/draw/loss logits for the side to move
export function pick(logits, v, moves) {
  let best = moves[0];
  for (const m of moves) if (logits[m.index] > logits[best.index]) best = m;
  const mx = Math.max(v[0], v[1], v[2]);
  const e = [Math.exp(v[0] - mx), Math.exp(v[1] - mx), Math.exp(v[2] - mx)];
  const score = (e[0] + 0.5 * e[1]) / (e[0] + e[1] + e[2]);     // expected score of the side to move, 0..1
  return { best, score };
}
