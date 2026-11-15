# Johnny the Chess Tutor: play my chess models

Play chess in your browser against three neural networks trained from scratch. No account, nothing uploaded: the
models are downloaded once and run on your device.

Site: https://johnnythedatascientist.github.io/chess-tutor/

| Opponent | What it is | Rating (no search, Stockfish's scale) |
|---|---|---|
| The Student | a small network that learned from 979,070 human games | about 1430 |
| The Apprentice | the same network, taught by Stockfish's verdicts | about 1490 |
| The Transformer | a larger attention network, taught by Stockfish | about 1950 |

Chess rules: [chess.js](https://github.com/jhlywa/chess.js). Model runtime: [onnxruntime-web](https://onnxruntime.ai/).
Chess pieces by Cburnett, CC BY-SA 3.0, via Wikimedia Commons.
YouTube: https://www.youtube.com/@JohnnyTheChessTutor
