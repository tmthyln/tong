

## Noise

Two sources, both reported:

- **Passage sampling.** Every run prints a 95% bootstrap interval of each F1
  over examples (`summary.json`: `ci`). With 12 douluo windows these are wide
  (RE about ±0.1).
- **Run to run.** Workers AI is not deterministic even at temperature 0.
  `run … --reps=N` (and `sweep --reps=N`) runs N independent replicates of a
  cell, each with its own cache keys (`__rK` run files), and prints mean ± sd;
  `summary.json` folds them into the base row as `replicates`. Measured on
  douluo with gemma-4-26b: NER sd ≈ 0.01, RE sd ≈ 0.04–0.05.

To compare two cells, use the paired test, which cancels the per-passage
difficulty both share and pools all replicates present for both:

```bash
npm run eval:extraction -- compare douluo app-pipeline@@cf/google/gemma-4-26b-a4b-it pipeline-ner-re@@cf/google/gemma-4-26b-a4b-it
# NER Δ F1 +0.010  95% [-0.008, 0.027]  P(a > b) 0.86  (36 pairs, 3 reps)
# RE  Δ F1 +0.026  95% [-0.047, 0.105]  P(a > b) 0.75  (36 pairs, 3 reps)
```

Treat a difference whose paired interval spans 0 as a tie.
