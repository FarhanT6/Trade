# Meme-Coin Trading Intelligence Platform

A Bloomberg-style intelligence terminal for the meme-coin market: on-chain events, wallet
behavior, trader leaderboards, social/narrative intelligence, token/security analysis,
execution quality and portfolio risk in one decision engine.

The system continuously answers five questions:

1. What tokens are gaining **real** demand right now?
2. Which wallets and traders are unusually good at *this* type of trade?
3. What narratives are accelerating before price reflects the attention?
4. Is the apparent opportunity genuine, executable and survivable?
5. After all costs and risks, does the trade have positive expected value?

The full product specification is in [`docs/spec.md`](docs/spec.md); the mapping from
spec sections to code is in [`docs/architecture.md`](docs/architecture.md).

> No strategy can guarantee profit. Meme-coin markets are extremely volatile, manipulated
> and illiquid. Live execution is gated behind paper trading, historical replay,
> out-of-sample validation and strict portfolio-level loss controls.

## Layout

```
packages/core     TypeScript engines: market features, wallet/trader intelligence, social &
                  narrative AI, rug-risk engine, scoring + Net EV, historical similarity,
                  exits, portfolio limits, execution, alerts, backtesting, AI agents,
                  event bus, source adapters, pipeline orchestrator      (35 tests)
packages/db       PostgreSQL schema for the 18 core entities + migration runner
apps/api          Fastify API + SSE stream, simulation/live runtimes, CLIs      (tests)
apps/web          Next.js terminal: Watchlist · Token terminal · Intelligence · Live feed,
                  Top-Trader Pattern Lab, Portfolio & Execution
research/         Python research layer: leakage-safe replay, walk-forward validation,
                  attribution, Net-EV recalibration, drift monitor          (5 tests)
docker-compose    TimescaleDB + Redis + API + Web
```

## Quick start (no API keys needed)

```bash
npm install
npm run build -w @meme-intel/core

# 1. Headless simulation: prints watchlist, decision card, agents, leaderboards, cohorts,
#    narratives, alerts and paper-trading results for 30 simulated hours.
npm run simulate -- 30

# 2. Backtest: system policy vs buy-and-hold / momentum-only / random-entry, walk-forward.
npm run backtest -- 60

# 3. Live terminal (simulation mode, 15 simulated minutes per second):
npm run dev:api          # http://localhost:4000  (REST + /api/stream SSE)
npm run dev:web          # http://localhost:3000
```

The simulation is a deterministic synthetic market (seeded) with organic runners,
pump-and-dumps, rugs, honeypots and bleeders; wallet populations with latent skill and
funding clusters; and narrative-driven social posts with organic and bot-amplified
authors. Every engine runs on it exactly as it would on real data, which is what lets the
whole loop (ingest → evaluate → alert → paper trade → label → learn) be tested end-to-end.

## Live mode

Copy `.env.example` to `.env`, set `MODE=live` and the keys you have:

| Source | Adapter | Access path |
|---|---|---|
| Solana RPC | `SolanaRpcAdapter` | any RPC URL(s); mint/freeze authorities and Token-2022 extensions via `jsonParsed` |
| DexScreener | `DexScreenerAdapter` | public API; pairs/liquidity (secondary to chain truth) |
| X | `XAdapter` | official API v2 recent search, bearer token, rate-limited |
| Reddit | `RedditAdapter` | official OAuth client-credentials API |
| FOMO / Axiom / Fomp | `PlatformAdapter` | only an explicitly configured official/licensed endpoint; never HTML scraping |
| LLM | `AnthropicProvider` | optional; explanations/classification only, never the sole signal |

Every adapter reports `health()`; missing sources are surfaced as unavailable, never as
neutral. Set `DATABASE_URL` to persist signals, outcomes, alerts, orders and execution
events to Postgres (`npm run db:migrate` applies the schema).

## Key ideas implemented

- **Evidence separation**: blockchain facts, statistical signals, social signals and AI
  interpretation are distinct types; every critical feature carries freshness/confidence.
- **Risk-adjusted skill, not PnL**: trader profiles combine average R, profit factor, win
  rate (bags count as losses), return on capital, drawdown, survivability, regime
  dependence, sample size and rug exposure. Realized *and* unrealized PnL are used.
- **Consensus without correlation**: wallets are clustered by funding ancestor, transfer
  paths and synchronized behavior; consensus weights independent clusters, so 12 wallets
  with 9 sharing a funder are not 12 votes.
- **Hard-block rules**: no sell route, stale/conflicting data, extreme liquidity
  withdrawal, malicious deployer cluster, mint/freeze authority, dangerous Token-2022
  extensions, failing simulation. A hard block cannot be overridden by alpha.
- **Interpretable scores + Net EV**: momentum, smart money, narrative, liquidity,
  security, manipulation, execution, market regime, rug probability, round-trip cost.
  Net EV blends historical analog outcomes with a score-conditioned prior.
- **Learning loop**: every signal is logged with its features and labeled with forward
  outcomes; a point-in-time similarity index answers "what happened to tokens like this?".
- **Execution as a subsystem**: quote comparison, slippage model, transaction simulation,
  multi-RPC routing, congestion-adaptive priority fees, exit-path probe before entry,
  kill switch, full audit log.
- **Backtesting**: walk-forward folds, realistic costs and failure probability, baselines
  (buy-and-hold, momentum-only, random-entry), bootstrap confidence intervals, drift monitor.

## API

| Route | Purpose |
|---|---|
| `GET /api/health` | mode, source health, execution health |
| `GET /api/snapshot` · `GET /api/stream` (SSE) | full dashboard state |
| `GET /api/tokens/:mint` | token terminal: market, wallets, social, risk, decision card, analogs, agent notes |
| `GET /api/leaderboards` · `GET /api/traders/:wallet` | trader intelligence |
| `GET /api/pattern-lab` | top-trader cohort analysis per window |
| `GET /api/narratives` · `GET /api/alerts` · `GET /api/signals` | intelligence feeds |
| `GET /api/portfolio` · `GET /api/execution` | paper portfolio, orders, RPC, audit |
| `POST/DELETE /api/execution/kill-switch` | manual halt / reset |
| `GET /api/backtest` | walk-forward replay vs baselines on labeled signals |

## Tests

```bash
npm test                         # core (35) + api (1)
cd research && python -m pytest  # research layer (5)
```
