# Recommender Eval Harness

Offline scaffold for scoring persisted recommender decisions against cached quote moves.

## Run

```bash
npm --workspace @regardedtrader/core run eval:recommender
```

Optional flags:

- `--root <snapshots-root>`: override snapshots root (default `~/.regardedtrader/snapshots`).
- `--symbol NVDA,TSLA`: evaluate only specific symbols.
- `--outDir <path>`: override report output directory.

## Output

Writes a markdown report to `packages/core/eval/reports/` with:

- Aggregate and per-symbol metrics at +1d and +5d
- Hit-rate by action bucket (`BUY`, `SELL`, `HOLD`, `AVOID`)
- Average realized return and expectancy per bucket
