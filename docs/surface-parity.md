# Surface Parity

RegardedTrader has two surfaces — the **`regard` CLI** (Ink) and the **web
dashboard** (React). They are peers. Every feature on one side must exist on
the other.

This file is the source of truth for that mapping. **Update it in the same PR
that adds or changes a feature on either surface.** A PR that breaks parity
without filing a tracking issue should be rejected in review.

_Last audited: 2026-08-06 (feature merges through 2026-08-06)_

## Pairing table

| Capability | CLI (`regard ...`) | Web route | Status |
| --- | --- | --- | --- |
| **Configuration / AI providers** | `regard config` / `regard config show` | `/settings` | ✅ |
| Risk caps editor | `regard config risk` (interactive writer) + `regard config show` (readback) | `/settings` → Risk caps panel + save flow | ✅ |
| Market-data cache controls | `regard cache clear` | `/settings` → Cache panel (`enabled` toggle + clear button) | ✅ |
| Provider smoke test | `regard config test [id]` | `/settings` “Test” button | ✅ |
| **Ticker intake & validation** (M1) | `regard add <SYM>...` / `regard ls` / `regard rm <SYM>` | ticker input bar + validated list on `/` | ✅ |
| Quick quote | `regard quote <SYM>` | `/quote/:sym` | ✅ |
| Full AI briefing | `regard briefing <SYM>` | `/` (home) | ✅ |
| Full briefing pipeline (analyst + TA + news + strategist + POST overrides) | `regard brief <SYM> [--thesis ... --max-loss N --expiry YYYY-MM-DD]` | `#/brief/:symbol` | ✅ |
| Technician (TA) commentary | `regard tech <SYM>` | `Tech` tab on `/` | ✅ |
| NewsScout ranked headlines | `regard news <SYM>` | `News` tab on `/` (live: `GET /news/:symbol`) | ✅ |
| Sentiment aggregate + mentions feed | `regard sentiment <SYM> [--window=30m] [--watch]` / `regard mentions <SYM> [--source=reddit] [--limit=50]` | `Sentiment` tab on `/` (live: `GET /sentiment/:symbol/latest`, `GET /mentions/:symbol`) | ✅ |
| Recommender verdict card + 30d history + recompute | `regard rec <SYM> [--recompute]` / `regard rec <SYM> history [--days=30]` / `regard rec watch [SYM...]` *(alias: `regard recommend <SYM>`)* | `Recommendation` tab on `/` (live: `GET /recommendations/:symbol/latest`, SSE `recommendation.update`, `POST /recommendations/:symbol/recompute`) | ✅ |
| Options trade-plan wizard | `regard plan <SYM>` | `#/plan/:sym` | ✅ |
| Paper trading (simulated only) | `regard paper submit <planId> --paper` / `regard paper positions` / `regard paper orders` | `#/paper` | ✅ |
| Trade-plan risk graph + risk violations panel | `regard plan <SYM>` (textual break-even + violations) | `#/plan/:sym` (SVG risk graph + violations chip panel) | ✅ |
| Options chain explorer + ATM implied-move strip | `regard options <SYM>` | `#/options/:sym` | ✅ |
| Full ticker chart (candles + overlays + RSI/MACD) | `regard chart <SYM>` (ASCII sparkline + indicator readout) | `#/ticker/:sym` | ✅ |
| Watchlist | `regard add <SYM>...` / `regard ls` / `regard rm <SYM>` | `/watchlist` | ✅ |
| Polling tape + tail + controls | `regard watch [SYM...]` / `regard tail <SYM> [--quotes]` / `regard polling <status\|pause\|resume>` | watchlist live polling rows + polling controls | ✅ |
| Market calendar (holidays + earnings) | `regard cal` / `regard cal earnings` / `regard cal refresh` / `regard cal status` | calendar strip + calendar tab (partial; top-bar pill/per-ticker badge tracked in #63) | 🚧 |
| Open the other surface | `regard dashboard` | "Open CLI help" link | ✅ / 🚧 |
| Server version chip | `regard dashboard` connect line (`connected to server X (core Y, api Z)`) | TopBar `srv X · core Y` chip (fetches `GET /version`) | ✅ |

Legend: ✅ implemented · 🚧 planned · ❌ explicitly out of scope.

## Audit coverage (last ~30 days)

Recent feature-bearing work is represented in the table above:

- #126 full briefing pipeline → **Full briefing pipeline** row.
- #131 computeRiskGraph → **Trade-plan risk graph + risk violations panel** row.
- #133 sentiment aggregator → **Sentiment aggregate + mentions feed** row.
- #135 recommender orchestrator + #52 CLI parity → **Recommender verdict card + 30d history + recompute** row.

## Rules

1. **No exclusives.** If a feature lands on one surface, the matching item must
   be in the backlog before the PR merges, and the parity table row must show
   the gap (🚧 ...) until both sides ship.
2. **Logic lives in `core`/`server`.** Both surfaces are thin clients. If the
   CLI and web implementations of the same feature diverge in behavior, that's
   a bug in the surface, not a feature.
3. **Same data, same names.** Use the same Zod schemas, the same field names,
   and the same disclaimers on both surfaces.
4. **Same safety rails.** Risk caps, paper-trading flags, and "not financial
   advice" disclaimers apply identically to both.
