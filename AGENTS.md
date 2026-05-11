# AGENTS.md — RegardedTrader

> Rules and context for AI coding agents (and humans) working on this repo.

## What This Is

**RegardedTrader** is a **local-only** desktop assistant that helps a single user do
**company stock analysis** and **day-trading of stock options** with AI in the loop.

It is **not** a SaaS, **not** multi-tenant, and **not** an automated trader. It is a
**personal research/analysis portal** that runs on the user's own machine, reads
public market data, and uses OpenAI (or another LLM) to reason about it.

Two front-ends share one local backend:

1. **Ink CLI** — fast terminal UI built with [`ink`](https://github.com/vadimdemedes/ink),
   inspired by tools like OpenClaw / Claude Code. The CLI binary is **`regard`**.
   Primary daily-driver surface.
2. **React Web Dashboard** — Vite + React + Tailwind, served from the same local
   Node server. For charts, watchlists, options chains, and richer visualizations.

Both talk to the same in-process **core** library, so analysis logic lives in one
place and never diverges between surfaces.

### Surface parity (hard requirement)

**Everything the dashboard can do, the CLI must also do — and vice versa.**

- Every web view has an equivalent `regard <subcommand>`.
- Every `regard <subcommand>` has an equivalent web route.
- Neither surface gets a feature first as a permanent exclusive. If a feature
  lands on one side, an issue/PR for the other side must follow in the same
  release.
- The pairing table lives in `docs/surface-parity.md` and must be updated in the
  same PR that adds or removes a feature on either surface. CI/PR review should
  reject changes that break parity without an accompanying tracking issue.
- Both surfaces are thin clients over the same `server` endpoints and the same
  `core` functions. If you find yourself implementing logic in one surface that
  doesn't exist on the other, stop and move the logic into `core`/`server` and
  expose it to both.

## Architecture

```
RegardedTrader/
├── packages/
│   ├── core/      # Pure TS: AI agents, analyzers, market-data clients, types
│   ├── server/    # Express HTTP + WebSocket API, OpenAI bridge, local persistence
│   ├── cli/       # Ink-based CLI; spawns or attaches to the local server
│   └── web/       # Vite + React dashboard (served by `server` in prod, dev via Vite)
└── AGENTS.md      # This file
```

### Data flow

```
 ┌────────────┐        ┌─────────────┐        ┌──────────────┐
 │  Ink CLI   │──HTTP──▶│   server    │──fn────▶│     core     │
 │  (ink)     │◀──WS───│ (express)   │◀────────│ (agents, ta) │
 └────────────┘        └─────────────┘        └──────────────┘
        ▲                     ▲                      │
        │                     │                      │
        └─── React web ───────┘                      ▼
                                              ┌──────────────┐
                                              │ OpenAI / LLM │
                                              │ Market data  │
                                              └──────────────┘
```

- **`core`** has zero I/O frameworks. It exposes functions and agent classes.
- **`server`** is the *only* place that touches the OpenAI key, secrets, and disk.
- **`cli`** and **`web`** are pure clients. They never read `.env` or call OpenAI
  directly.

## Hard Rules for Agents

These are non-negotiable. Violating them is a bug, not a tradeoff.

1. **Local-only.** No code that listens on `0.0.0.0`, no cloud deploy targets, no
   telemetry. Default bind is `127.0.0.1`. CORS is locked to localhost.
2. **No autonomous trading.** This project must never place real orders. Any
   "execute" code path must be a clearly-labeled **paper/simulation** primitive,
   refuse to run against real brokerage credentials, and require an explicit
   `--paper` flag plus a typed confirmation.
3. **No secrets in the repo.** Real keys belong in `.env` (gitignored). Use
   `.env.example` for the schema. The server is the only consumer.
4. **Not financial advice.** Every user-facing surface that emits an LLM opinion
   must include a "not financial advice / educational" disclaimer.
5. **Deterministic core.** `core` functions should be pure where possible and unit
   testable without network. Network calls live behind injected clients.
6. **Single source of truth.** Any analyzer, prompt, or schema used by both CLI
   and web lives in `core`. Do not duplicate logic across surfaces.
7. **Stay local-first on storage.** SQLite (better-sqlite3) or flat JSON under
   `~/.regardedtrader/`. No external databases.
8. **No scraping ToS violations.** Use official/free APIs (Yahoo Finance via
   `yahoo-finance2`, Alpha Vantage, Polygon free tier, etc.). Cache aggressively.
9. **Type-safe wire format.** All server <-> client payloads have Zod schemas in
   `core/src/schemas/`. Both sides import the same schema.
10. **No `any` in new TypeScript code** unless commented with a justification.

## Soft Rules / Style

- TypeScript everywhere, ESM (`"type": "module"`).
- Node >= 20.
- Prettier defaults, no bikeshedding.
- Tests with `vitest`. Co-locate as `*.test.ts`.
- Conventional commits (`feat:`, `fix:`, `chore:`, `docs:`).
- Small PRs > big PRs. One feature per branch.
- Prefer composition over class hierarchies in `core`.
- React: function components + hooks. Tailwind for styling. No CSS-in-JS.
- Ink: keep components small; route screens through a `Router` component.

## Domain Notes

### "Stock analysis" means
- Pull recent OHLCV, fundamentals snapshot, news headlines.
- Compute classic TA (RSI, MACD, SMA/EMA crossovers, ATR, IV when available).
- Ask the LLM to summarize bull/bear theses, catalysts, risks. Always cite which
  inputs it used.

### "Day-trading options" means
- Pull the options chain for a ticker for a given expiration.
- Surface useful metrics: bid/ask spread, OI, volume, IV, delta/gamma/theta/vega
  when broker data provides them; otherwise compute with Black-Scholes.
- Let the user describe an idea ("bullish $NVDA into earnings, defined risk, <$500
  max loss"); the **OptionsStrategist** agent proposes 2-3 candidate structures
  (long call, vertical, calendar, etc.) with break-evens and P/L at expiry.
- Never auto-place. Output is a *trade plan*, not an order.

### Agents (in `core/src/agents/`)
- `Analyst` — high-level company/ticker brief.
- `Technician` — chart-pattern / indicator commentary.
- `OptionsStrategist` — structures + risk graph data.
- `NewsScout` — fetches and ranks headlines for relevance.
- `RiskOfficer` — sanity-checks any proposed trade against user-configured caps
  (max % of account, max DTE, no naked shorts on margin, etc.).

All agents implement a small `Agent` interface and are composed by a top-level
`Orchestrator` so the CLI and web can both invoke "Give me a full briefing on
TICKER" with one call.

## Design Language (web dashboard)

The web dashboard should feel like a **modern Bloomberg/Reuters terminal** —
clean, dense, professional, dark — but with the warmth and clarity of a 2026
product, not a 1995 one. It also has to do something old terminals never did:
make **AI-generated insights feel approachable**, not buried in walls of text.

See [`docs/design.md`](./docs/design.md) for the full spec. Highlights:

- **Dark by default, always.** Background `#0A0F14` (near-black with a hint of
  blue/green), surfaces in steps of `#0F1620` / `#141C28`. No pure black, no
  pure white. Light theme is out of scope for v1.
- **Color is data, not decoration.** Reserve green/red for P/L and price
  change, amber for warnings/risk caps, cyan/teal for AI output, neutral grays
  for chrome. Don't use those colors for branding accents.
- **Typography:** monospace tabular numerics for prices, P/L, strikes, greeks
  (e.g. JetBrains Mono / IBM Plex Mono). Sans-serif (Inter) for prose, labels,
  and AI summaries. Numbers always right-aligned in tables.
- **Density over whitespace** in data regions (chains, watchlists, tape).
  Generous whitespace in AI/prose regions. The two modes live side-by-side and
  shouldn't fight each other.
- **Charts are first-class.** Use a single charting library across the app
  (lightweight-charts or visx). Candles + volume + overlayable indicators
  (SMA/EMA/RSI/MACD). Crosshair, scrubbable, keyboard-navigable.
- **AI surfaces** get their own visual treatment: a left-edge accent stripe in
  the AI accent color, a small "AI" badge, and a per-section
  "sources used" disclosure. Bull/bear/risks/catalysts render as scannable
  cards, not paragraphs. Always include the disclaimer at the bottom.
- **Status & realtime:** a thin top status bar shows market open/closed,
  connection state, and last-refresh time. Live values pulse subtly when they
  update; never flash aggressively.
- **Keyboard-first.** Global ⌘K / Ctrl-K command palette for ticker jump,
  view switching, and AI actions. `/` focuses the ticker bar. Same keymap as
  the CLI where it makes sense.
- **Accessibility:** WCAG AA contrast for all text on dark surfaces; never
  rely on color alone to convey state (use icons or text too); respect
  `prefers-reduced-motion`.

When building a new web view, default to: dark surface, mono numbers, sans
prose, charts where data is sequential, AI output in its own card with the
accent stripe + disclaimer. If your view doesn't fit that pattern, write down
why in the PR.

## Configuration & AI Providers

Users configure RegardedTrader through a single, file-backed config persisted
at `$REGARDEDTRADER_HOME/config.json` (default `~/.regardedtrader/config.json`,
`chmod 600`). Both surfaces edit the same file via the local server's
`/config` endpoints; they never edit the file directly. See
[`docs/configuration.md`](./docs/configuration.md) for the full reference.

**AI provider model.** The user can register one or more providers and pick
an active one. Two kinds are supported:

1. **OpenAI-compatible HTTP endpoint** — a base URL + API key + default model.
   Works with OpenAI, Azure OpenAI, OpenRouter, Groq, Together, Fireworks,
   local Ollama / vLLM / LM Studio, and anything else that speaks the
   `/v1/chat/completions` shape.
2. **Local AI CLI backends** — RegardedTrader spawns an installed coding CLI
   per turn and parses its output. Same idea OpenClaw uses. Supported:
   - `codex-cli` — OpenAI Codex CLI (`codex exec --json ...`)
   - `claude-cli` — Claude Code (`claude -p --output-format stream-json`)
   - `copilot-cli` — GitHub Copilot CLI (`gh copilot ...`)

   The user is responsible for installing and authenticating each CLI on their
   own machine (`codex auth login`, `claude auth login`, `gh auth login`,
   etc.). RegardedTrader never stores those credentials and never invokes auth
   flows itself.

**Hard rules for provider code:**

- API keys live ONLY in the local config file. Never in the repo, never in
  logs, never returned over the network. The `/config` GET endpoint must
  return a `redactConfig`-masked view (`sk-1234••••9abc`).
- Adding/changing providers must be possible from BOTH surfaces (parity rule).
  The CLI uses `regard config`; the web uses a Settings view. Both call the
  same `/config` endpoints.
- Switching the active provider must hot-swap the orchestrator without
  restarting the server.
- A provider "smoke test" (`POST /config/test`) sends one tiny prompt and
  reports success/failure; both surfaces expose it as a "Test connection"
  button/command.
- Failure to configure a provider must produce a clear, actionable error
  pointing at `regard config`, never a stack trace.
- Risk caps and server bind also live in this config; only `127.0.0.1` /
  `localhost` are accepted for `server.host`.

## Commands

From the repo root:

```bash
npm install              # installs all workspaces
npm run dev              # starts server + web (concurrent)
npm run dev:server       # server only
npm run dev:web          # web only (Vite)
regard briefing NVDA     # run the Ink CLI (after `npm link` or `npm install -g`)
npm run cli -- briefing NVDA   # same thing, without a global install
npm run build            # builds all packages
npm test                 # runs vitest across workspaces
npm run lint             # tsc --noEmit + prettier --check
```

## When You're An Agent Working Here

- Read this file first. Then read `packages/<pkg>/README.md` for the area you
  touch.
- Prefer adding to `core` over duplicating logic in `cli` or `web`.
- New external API? Wrap it in `core/src/clients/` with an interface. No raw
  `fetch` in `server` route handlers.
- New LLM prompt? Put it in `core/src/prompts/` as a named exported template.
  Never inline a multi-paragraph prompt in a route file.
- Adding a CLI screen? Add a route in `cli/src/router.tsx` and a component under
  `cli/src/screens/`. **Also** add (or open a tracking issue for) the matching
  web view and update `docs/surface-parity.md`.
- Adding a web view? Add a route under `web/src/routes/` and a matching server
  endpoint if needed. **Also** add (or open a tracking issue for) the matching
  `regard` subcommand and update `docs/surface-parity.md`.
- Before finishing: `npm run lint && npm test && npm run build`.

## Milestones

### M1 — Ticker intake & validation (FIRST GOAL) 🎯

Before anything else, the app must let a user enter one or more stock ticker
symbols and confirm they are real, tradable US equities, with a basic profile
attached. Everything downstream (briefings, options plans, watchlists) depends
on this.

**Acceptance criteria**

- `regard add <SYM> [<SYM> ...]` and a web input field both accept tickers.
- Each ticker is validated via a **web search tool** (not just a price-API
  ping) so we can disambiguate (e.g. `META` the company vs. unrelated noise)
  and surface a short profile.
- For each ticker we extract and persist:
  - canonical symbol, company name, exchange (NYSE/NASDAQ/etc.)
  - sector, industry
  - 1-2 sentence company description
  - source URLs used for validation
- Invalid / ambiguous tickers return a clear error with suggested matches.
- Validated tickers land in a local watchlist (SQLite or JSON under
  `~/.regardedtrader/`).
- Both surfaces show the same validated list and the same profile fields
  (parity rule applies).
- Results are cached so we don't re-search on every command. Default TTL 7 days,
  refreshable with `--refresh` / a web "refresh" button.

**Implementation notes**

- New module: `core/src/agents/ticker-validator.ts` — takes a candidate symbol,
  runs a web search via an injected `WebSearch` client, asks the LLM to extract
  a structured `TickerProfile` (Zod schema in `core/src/schemas/`), and returns
  `{ ok, profile, sources, alternatives }`.
- New schema: `TickerProfile { symbol, name, exchange, sector, industry,
  description, sources: string[], validatedAt }`.
- New server endpoints: `POST /tickers/validate` (body: `{ symbols: string[] }`),
  `GET /tickers`, `DELETE /tickers/:sym`.
- New CLI: `regard add <SYM>...`, `regard ls`, `regard rm <SYM>`.
- New web view: a home-screen ticker-input bar + validated-list panel.
- Cross-check the symbol against the market-data client (Yahoo) as a secondary
  sanity check; treat web-search as the canonical extractor for the profile.

Until M1 ships, `briefing` / `plan` should refuse unknown symbols and direct
the user to `regard add` first.

### M2+

Later: `Technician`, `NewsScout`, richer options strategist, charts, SQLite
caching layer, WebSocket streaming, etc. Tracked as GitHub issues.

## Out of Scope (for now)

- Mobile apps.
- Multi-user / accounts / auth (it's a local single-user app).
- Real brokerage integrations beyond read-only paper.
- Backtesting framework (maybe later, keep `core` friendly to it).
- Crypto. This is equities + equity options.

---

_Not financial advice. Educational tool. You are responsible for your own trades._
