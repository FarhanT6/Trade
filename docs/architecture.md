# Architecture: spec → implementation map

The core operating loop (spec §1) is implemented by `IntelligenceEngine`
(`packages/core/src/pipeline/engine.ts`):

```
DATA INGESTION      SourceAdapter.poll() -> EventBus (in-memory | Redis Streams)
ON-CHAIN EVENTS     chain.token.created / trade / transfer / liquidity / authority / pool / security / holders
MARKET FEATURES     features/market.ts        computeMarketFeatures, computeVolumeQuality
WALLET / TRADER     wallets/*                 FIFO PnL, profiles, archetypes, clustering, cohort consensus
SOCIAL + NARRATIVE  social/*                  entities, velocity, bot estimate, narrative clustering, lead/lag
TOKEN / LIQ RISK    risk/token-risk.ts        findings + hard-block rules
STATISTICAL SCORING scoring/scores.ts         8 scores + rug probability + Net EV -> decision card
AI EXPLANATION      agents/agents.ts          9 role-scoped agents, deterministic drafts + optional LLM
ALERT / PAPER /     alerts/rules.ts, execution/engine.ts, portfolio/limits.ts
EXECUTION
POSITION MONITORING exits/distribution.ts, exits/manager.ts
OUTCOME LABEL       engine.labelOutcomes -> similarity/knn.ts (point-in-time safe index)
BACKTEST / RECAL.   backtest/*, research/ (Python)
```

| Spec section | Implementation |
|---|---|
| §2 What to monitor | `types.ts` domain model; adapters per layer (`adapters/*`) |
| §3.1 Leaderboard ingestion (24H/7D/30D/90D/all) | `wallets/profile.ts` `WINDOW_MS`, `engine.recomputeTraderIntelligence`, `platform.leaderboard` events |
| §3.2 Trader profile metrics | `buildTraderProfile`: realized/unrealized PnL, win rate, profit factor, avg R, median hold, entry latency, sizing, max DD, recovery, regime consistency, category performance, rug exposure, exit quality, survivability, risk-adjusted skill |
| §3.3 Archetypes | `wallets/archetype.ts` |
| §3.4 Top-trader consensus engine | `wallets/consensus.ts` `analyzeCohort` (common tokens/entry zone/hold/narrative/chain/launch/behavior/exit signal/overlap/lead-lag) |
| §3.5 Trader network graph | `wallets/clustering.ts` `buildWalletGraph` (funding ancestor union-find, transfer paths, synchronized behavior) |
| §4.1–4.2 X / Reddit | `adapters/social.ts` (official APIs), `social/entities.ts` |
| §4.3 Narrative engine | `social/narrative.ts` `clusterNarratives` (pluggable `Embedder`, greedy centroid clustering, labels, sentiment, catalyst) |
| §4.4 Narrative velocity | `social/velocity.ts` `computeSocialVelocity` (mention/author/engagement acceleration, influencer + cross-platform diffusion, saturation, bot likelihood) |
| §4.5 AI outputs | narratives + `detectContradiction` + `socialPriceLeadLag` + agents |
| §5 Platform intelligence layer | `adapters/platforms.ts` (`PlatformAdapter` for FOMO/Axiom/Fomp: official/licensed endpoints only) |
| §6 Token & rug-risk engine, §6.1 hard blocks | `risk/token-risk.ts` |
| §7 Market & liquidity engine, §7.1 Real Volume Quality | `features/market.ts` |
| §8 Opportunity scoring, decision card | `scoring/scores.ts` (`buildDecisionCard`, `formatDecisionCard`) |
| §9 Similarity / historical patterns | `similarity/knn.ts` `SimilarityIndex` (walk-forward safe) |
| §10 Exit & position management, Distribution Score | `exits/distribution.ts`, `exits/manager.ts` |
| §11 Portfolio risk engine | `portfolio/limits.ts` `checkPortfolioLimits` |
| §12 Execution engine | `execution/engine.ts` (`QuoteEngine`, `PoolQuoteSource`, `RpcRouter`, `priorityFeeUsd`, `KillSwitch`, `AuditLog`, `ExecutionEngine`) |
| §13 Real-time architecture | `events/bus.ts` (`InMemoryEventBus`, `RedisStreamsEventBus`), `apps/api/src/runtime.ts` |
| §14 Technical stack | TypeScript/Node (Fastify, Next.js, SSE), Python (pandas/numpy, sklearn/LightGBM optional), Postgres/Timescale, Redis, pgvector optional, Anthropic LLM optional |
| §15 Data model | `packages/db/migrations/001_init.sql` (all 18 entities) |
| §16 AI agents | `agents/agents.ts` (Market Scout, Wallet Analyst, Trader Cohort Analyst, Social Analyst, Narrative Analyst, Security Analyst, Pattern Miner, Trade Reviewer, Research Analyst) |
| §17 Top-Trader Pattern Lab | `apps/web/components/PatternLab.tsx`, `GET /api/pattern-lab`, `consensusWithoutCorrelation`, `repeatedAcrossWindows` |
| §18 Edge cases | freshness on every feature (`Freshness`), staleness hard-blocks during fast events, mint-address resolution, LP-withdrawal emergency exits, authority subscriptions, Token-2022 decoding, multi-RPC + halt, graceful social degradation, depth-based sizing, walk-forward splits, dead-token retention, drift monitor (`outOfDistributionShare`, `drift_report`), regime conditioning, quoted-vs-actual slippage feedback into the kill switch, replaceable adapters |
| §19 Backtesting framework | `backtest/replay.ts`, `research/meme_research/backtest.py` |
| §20 Profitability metrics | `backtest/metrics.ts`, `research/meme_research/metrics.py` |
| §21 Alert system | `alerts/rules.ts` (11 alert kinds, ranked, explainable, deduplicated) |
| §22 Dashboard layout | `apps/web/components/Terminal.tsx` (LEFT watchlist · CENTER token terminal · RIGHT intelligence · BOTTOM live feed) |
| §23 Build phases | Phases 1–6 implemented (terminal, trader intelligence, social intelligence, Pattern Lab + similarity + backtesting, execution simulator + paper trading + portfolio risk, live execution with strict limits and kill switches). Phase 7 (adaptive models) is scaffolded in `research/` |
| §12 / §23 Live execution | `packages/solana`: `JupiterClient` (quotes, swap transactions, prices), `JupiterQuoteSource` (real quotes + exit-path probe for the `QuoteEngine`), `SolanaTransactionSender` (fresh quote → sign → simulate → send → confirm → fill from balance deltas), `createLiveExecution` gate (flag + acknowledgement + caps + hot-wallet band + reachable services); engine-level per-trade and daily caps in `IntelligenceEngine.liveLimits` |
| §24 Proprietary moat | signal/outcome store (`signals`, `outcomes`), cluster intelligence, cohort history, lead/lag, execution history (`execution_events`), similarity library, archetype model, attribution (`signal_attribution`), recalibrated Net EV (`fit_net_ev_model`) |

## Data flow in one tick

1. `Runtime.tick()` polls every adapter for events since the last cursor and publishes them.
2. `IntelligenceEngine` handlers update raw stores (tokens, pools, trades, transfers, posts,
   security, holders, liquidity/authority events, leaderboards) and the live feed.
3. `recompute(now)`:
   - heavy (every ~15 min): wallet graph → positions (FIFO) → profiles per window → rankings
     → cohort analyses; narrative clustering over the last 12h of posts.
   - always: market regime; per active token: market features → social velocity → smart-money
     input → sell-route probe → risk assessment → similarity query → decision card →
     distribution score → alerts → signal log → agent notes.
   - paper trading: exits first (volatility stop, trailing stop, ladder, distribution,
     divergence, emergency), then entries through portfolio limits and the execution engine.
   - label outcomes for signals older than the horizon; add them to the similarity index.
4. `snapshot()` is pushed to SSE subscribers and, optionally, to Postgres.

## Point-in-time discipline

- Feature computation only reads trades/posts with `timestamp <= now`.
- `SimilarityIndex.query(state, k, asOf)` only returns cases whose outcome window closed
  before `asOf`.
- `walkForwardFolds` never shuffles; test folds strictly follow train folds in time.
- The simulation world exposes `priceAt`/`peakAfter` which the engine uses only for
  outcome labeling and exits, never for decision features.
