# Domain glossary

> ⚠️ **Not financial advice.** Educational/research tool only. No live order placement. You are responsible for your own trades.

Concise project-specific definitions used across RegardedTrader prompts, schemas, CLI, and dashboard.

## General equities

- **Ticker** — Short symbol for a listed security (for example `NVDA`). In RT schemas this is `Ticker` in [`packages/core/src/schemas/index.ts`](../packages/core/src/schemas/index.ts).
- **Exchange** — Listing venue (NASDAQ/NYSE/etc.) used for symbol disambiguation and trading-hours context.
- **Sector / industry** — Company classification fields shown in watchlist profiles; nullable when providers disagree.
- **OHLCV** — Open, high, low, close, volume bar data used by technical indicators and chart views.
- **Volume** — Number of shares traded in a period; used for liquidity and move-confirmation checks.
- **Spread** — Difference between bid and ask; wider spreads imply higher execution friction.

## Technical analysis

Indicator implementations live in [`packages/core/src/indicators/index.ts`](../packages/core/src/indicators/index.ts).

- **RSI** — Momentum oscillator (0-100) that compares recent gains vs losses; extremes can signal overbought/oversold regimes.
- **MACD** — Difference between fast and slow EMAs with a signal line; used for trend/momentum turns.
- **SMA / EMA** — Simple vs exponential moving averages; EMA weights recent prices more heavily.
- **ATR** — Average True Range; a volatility proxy for sizing risk and stop distances.
- **Bollinger Bands** — SMA centerline plus/minus standard deviation bands; shows relative expansion/compression.
- **Stochastic** — Oscillator tracking close location within recent high-low range (`%K/%D`).

## Options basics

- **Strike** — Price at which the option can be exercised.
- **Expiry** — Contract expiration date; together with now gives DTE.
- **DTE** — Days to expiration; RT risk caps often limit maximum allowed DTE.
- **Moneyness (ATM/ITM/OTM)** — Relationship between strike and spot price (at, in, or out of the money).
- **Intrinsic vs extrinsic value** — Immediate exercise value vs time/volatility premium.
- **Bid/ask spread** — Execution-cost proxy for option contracts.
- **OI (open interest)** — Open contract count; rough liquidity/participation signal.
- **Options volume** — Contracts traded in-session; helps gauge where flow is concentrated.

## Greeks

- **Delta** — Approximate option price change for a $1 underlying move.
- **Gamma** — Rate of change of delta as underlying price moves.
- **Theta** — Time-decay sensitivity (often shown per day).
- **Vega** — Sensitivity to implied-volatility changes (often per 1 vol point).

## Volatility

- **IV (implied volatility)** — Vol level backed out from option prices.
- **IV rank** — Position of current IV within a lookback range (high vs low regime context).
- **IV percentile** — Fraction of lookback observations with IV below current IV.
- **IV skew / smile** — Cross-strike IV shape by expiry (asymmetry or U-shape).

See IV regime helpers in [`packages/core/src/options/iv-regime.ts`](../packages/core/src/options/iv-regime.ts).

## Structures

- **Long call** — Bullish, defined-risk upside exposure.
- **Long put** — Bearish, defined-risk downside exposure.
- **Covered call** — Long shares + short call to monetize upside cap.
- **Cash-secured put** — Short put with cash reserved to take assignment.
- **Naked short** — Short option without share/cash coverage; high or theoretically uncapped risk.
- **Vertical spread** — Same expiry, different strikes; defined-risk directional expression.
- **Calendar spread** — Same strike, different expiries; term-structure/volatility expression.
- **Straddle** — Long call + long put same strike/expiry; expects large move either direction.
- **Strangle** — Long call + long put different strikes; cheaper than straddle, needs bigger move.
- **Iron condor** — Two short spreads around spot for range-bound thesis with capped risk.
- **Butterfly** — Multi-leg structure targeting a pin near middle strike.

## Risk / rules of the road

- **Max loss** — Worst-case loss at expiration for a defined position.
- **Break-even** — Underlying price where projected P/L is zero at expiry.
- **Risk graph** — P/L vs underlying-price curve used to inspect payoff shape.
- **Max DTE** — Policy cap on far-dated exposure.
- **Max % of account** — Position-risk ceiling as a fraction of configured account size.
- **Blackout window** — Time window (for example earnings/FOMC) where initiating risk may be disallowed.
- **Paper trading vs live** — RT supports planning/simulation only; it does not place real brokerage orders.

## RegardedTrader-specific terms

- **`AiOutputEnvelope`** — Typed wrapper carrying AI payload + sources metadata. Schema: [`packages/core/src/schemas/envelope.ts`](../packages/core/src/schemas/envelope.ts).
- **`AiEnvelope<T>`** — Type helper matching the output shape of `AiOutputEnvelope`.
- **`Verdict`** — Action + conviction + rationale + signals bundle for a stance. Schema: [`packages/core/src/schemas/recommendation.ts`](../packages/core/src/schemas/recommendation.ts).
- **`RecommendationKind`** — Strategy bucket enum values:
  - `equity`
  - `covered_call`
  - `covered_put`
  - `naked_call`
  - `naked_put`
- **`RiskCaps` / `RiskConfig`** — User-configured guardrails (max loss, DTE, naked-short policy, account-size cap) in [`packages/core/src/schemas/config.ts`](../packages/core/src/schemas/config.ts).
- **`TickerProfile`** — Validated canonical company profile persisted in the watchlist. Schema: [`packages/core/src/schemas/ticker.ts`](../packages/core/src/schemas/ticker.ts).
- **Agent roles** — `Analyst` (thesis), `Technician` (indicators), `OptionsStrategist` (structures), `NewsScout` (headlines), `RiskOfficer` (guardrails).
