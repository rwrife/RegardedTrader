# @regardedtrader/server

Local-only API surface for RegardedTrader. This package wires `@regardedtrader/core` into Express endpoints and streaming feeds consumed by both CLI and web.

- Repo rules: [AGENTS.md](../../AGENTS.md)
- Surface parity contract: [docs/surface-parity.md](../../docs/surface-parity.md)

## Local auth + bind model

- Server startup validates loopback host only (`127.0.0.1` / `localhost` / `::1` family).
- Cross-origin requests are rejected unless Origin is loopback.
- Runtime auth is token-gated by default for dashboard sessions (`regard dashboard` flow); `--allow-no-auth` is dev-only.
- No cloud/multi-tenant assumptions: this is one local user + one local process.

## Endpoint inventory (grouped)

Primary routes live in `src/app.ts`.

### Health/version

- `GET /health`
- `GET /version`

### Config

- `GET /config`
- `PUT /config`
- `POST /config/risk`
- `POST /config/providers`
- `DELETE /config/providers/:id`
- `POST /config/activate`
- `POST /config/test`
- `POST /config/market-data/providers`
- `DELETE /config/market-data/providers/:id`
- `POST /config/market-data/activate`
- `POST /config/market-data/test`

### Tickers / watchlist

- `GET /tickers`
- `POST /tickers`
- `DELETE /tickers/:sym`
- `POST /tickers/validate`
- `POST /tickers/quick-add`
- `GET /tickers/resolve`
- `GET /quote/:symbol`
- `GET /tickers/:symbol/quote`
- `GET /history/:symbol`
- `GET /options/:symbol`

### Briefing + plans

- `GET /briefing/:symbol`
- `POST /briefing/:symbol`
- `GET /briefing/:symbol/history`
- `GET /technician/:symbol`
- `GET /news/:symbol`
- `POST /plans`

### Polling + SSE

- `GET /polling/status`
- `POST /polling/pause`
- `POST /polling/resume`
- `GET /polling/watch` (SSE stream)
- `GET /polling/tail/:symbol` (SSE tail stream)
- `GET /events` (dashboard sentiment SSE)

### Recommender / sentiment context

- `GET /sentiment/:symbol/latest`
- `GET /sentiment/:symbol`
- `GET /mentions/:symbol`

Recommendation outputs are included in briefing/plan response payloads from core orchestration paths.

### Calendar

- `GET /calendar/events`
- `GET /calendar/earnings/:symbol`
- `POST /calendar/refresh`
- `GET /calendar/status`
- `GET /calendar/upcoming`

### Paper trading (simulation only)

- `POST /paper/orders`
- `GET /paper/orders`
- `GET /paper/positions`
- `GET /paper/plans`

## Adding a route + Zod schema pair

1. **Define/extend schema in core first** (`packages/core/src/schemas/*`) and export it.
2. **Parse request body/query/path early** in `src/app.ts` using Zod (`safeParse` + structured error).
3. **Validate response payload** with shared core schemas before `res.json(...)`.
4. **Keep business logic in core** (or server service module) so route handlers stay thin.
5. Add focused tests in `src/*.test.ts` for success + failure paths.

## Development

From repo root:

```bash
npm --workspace @regardedtrader/server run dev
npm --workspace @regardedtrader/server run test
npm --workspace @regardedtrader/server run lint
```
