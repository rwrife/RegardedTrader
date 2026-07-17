# Surface Parity

RegardedTrader has two surfaces — the **`regard` CLI** (Ink) and the **web
dashboard** (React). They are peers. Every feature on one side must exist on
the other.

This file is the source of truth for that mapping. **Update it in the same PR
that adds or changes a feature on either surface.** A PR that breaks parity
without filing a tracking issue should be rejected in review.

## Pairing table

| Capability                    | CLI (`regard ...`)         | Web route             | Status |
| ----------------------------- | -------------------------- | --------------------- | ------ |
| **Configuration / AI providers**  | `regard config` / `regard config show` | `/settings`           | ✅     |
| Risk caps editor              | `regard config` (risk fields)             | `/settings` → Risk caps | ✅     |
| Provider smoke test           | `regard config test [id]`  | `/settings` “Test” button | ✅     |
| **Ticker intake & validation** (M1) | `regard add <SYM>...` / `regard ls` / `regard rm <SYM>` | ticker input bar + validated list on `/` | ✅ |
| Quick quote                   | `regard quote <SYM>`       | `/quote/:sym`         | ✅     |
| Full AI briefing              | `regard briefing <SYM>`    | `/` (home)            | ✅     |
| Full briefing pipeline (analyst + TA + news + strategist) | `regard brief <SYM> [--thesis ... --max-loss N]` | `#/brief/:symbol` | ✅     |
| Technician (TA) commentary    | `regard tech <SYM>`        | `Tech` tab on `/` | ✅     |
| Options trade-plan wizard     | `regard plan <SYM>`        | `#/plan/:sym`         | ✅     |
| Options chain explorer        | `regard options <SYM>`     | `#/options/:sym`      | ✅     |
| Watchlist                     | `regard watch [add\|ls\|rm]` | `/watchlist`        | ✅     |
| Open the other surface        | `regard dashboard`         | "Open CLI help" link  | ✅ / 🚧 |
| Server version chip           | `regard dashboard` connect line (`connected to server X (core Y, api Z)`) | TopBar `srv X · core Y` chip (fetches `GET /version`) | ✅     |

Legend: ✅ implemented · 🚧 planned · ❌ explicitly out of scope.

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
