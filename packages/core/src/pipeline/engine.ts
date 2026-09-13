import type {
  Alert, AuthorityChange, DecisionCard, DeployerHistory, HolderSnapshot, LeaderboardSnapshot, LeaderboardWindow, LiquidityEvent, MarketFeatures, Narrative, Order, Outcome, Pool, Position, Signal, SocialPost, SocialVelocity, Token, TokenSecurity, Trade, TraderProfile, Transfer, RiskAssessment, PortfolioLimits,
} from '../types.js';
import type { EventBus } from '../events/bus.js';
import { computeMarketFeatures } from '../features/market.js';
import { buildPositions } from '../wallets/pnl.js';
import { buildTraderProfile } from '../wallets/profile.js';
import { buildWalletGraph, type WalletGraph } from '../wallets/clustering.js';
import { analyzeCohort, rankTraders, repeatedAcrossWindows, type CohortAnalysis, type CommonToken } from '../wallets/consensus.js';
import { computeSocialVelocity } from '../social/velocity.js';
import { clusterNarratives } from '../social/narrative.js';
import { assessTokenRisk } from '../risk/token-risk.js';
import { buildDecisionCard, type RegimeState, type SmartMoneyInput } from '../scoring/scores.js';
import { SimilarityIndex, categoryBucket, type TokenStateVector } from '../similarity/knn.js';
import { distributionScore, type DistributionReport } from '../exits/distribution.js';
import { planExit, volatilityStopPct, type OpenPositionState } from '../exits/manager.js';
import { checkPortfolioLimits, DEFAULT_LIMITS, type PortfolioState } from '../portfolio/limits.js';
import { AuditLog, ExecutionEngine, KillSwitch, PoolQuoteSource, QuoteEngine, RpcRouter, type QuoteSource, type TransactionSender } from '../execution/engine.js';
import { evaluateAlerts } from '../alerts/rules.js';
import type { TradeResult } from '../backtest/metrics.js';
import { MS, clamp, mean, ratio, unique } from '../util/stats.js';
import { newId } from '../util/ids.js';
import type { LlmProvider } from '../agents/agents.js';
import { MarketScoutAgent, SecurityAnalystAgent, SocialAnalystAgent, TradeReviewerAgent, WalletAnalystAgent, type AgentReport } from '../agents/agents.js';

export interface PriceHistory {
  priceAt(mint: string, ts: number): number;
  peakAfter(mint: string, ts: number, horizonMs: number): number;
  liquidityAt(mint: string, ts: number): number;
}

export interface EngineOptions {
  bus: EventBus;
  now: () => number;
  intendedSizeUsd?: number;
  startEquityUsd?: number;
  limits?: PortfolioLimits;
  rpcUrls?: string[];
  llm?: LlmProvider;
  /** Override for point-in-time prices (simulation / backtests). Defaults to trade-derived history. */
  priceHistory?: PriceHistory;
  outcomeHorizonMs?: number;
  paperTrading?: boolean;
  topN?: number;
  /**
   * 'paper' (default) simulates fills. 'live' routes every order through `sender` with real
   * quotes from `quoteSources`; it is refused unless a sender is configured. Live orders are
   * additionally capped by `liveLimits`.
   */
  executionMode?: 'paper' | 'live';
  quoteSources?: QuoteSource[];
  sender?: TransactionSender;
  liveLimits?: { maxTradeUsd: number; dailyCapUsd: number };
}

export interface TokenEvaluation {
  token: Token;
  market: MarketFeatures;
  social: SocialVelocity | null;
  risk: RiskAssessment;
  card: DecisionCard;
  alerts: Alert[];
  distribution: DistributionReport;
  consensus: CommonToken | null;
  smartMoney: SmartMoneyInput & { buyers: string[] };
  similar: ReturnType<SimilarityIndex['query']> | null;
  agentNotes: AgentReport[];
}

export interface PaperPosition extends OpenPositionState {
  sizeUsd: number;
  signalId: string;
  card: DecisionCard;
  narrativeIds: string[];
  correlationKey: string;
  highRisk: boolean;
  realizedUsd: number;
  orders: Order[];
}

export interface EngineSnapshot {
  now: number;
  regime: RegimeState;
  watchlist: Array<{ symbol: string; tokenMint: string; decision: string; alpha: number; netEvPct: number; security: number; rugProbability: number; catalyst: string | null; freshnessMs: number; momentum: number; smartMoney: number; narrative: number; liquidityUsd: number; priceUsd: number; marketCapUsd: number }>;
  alerts: Alert[];
  narratives: Narrative[];
  leaderboards: Record<LeaderboardWindow, TraderProfile[]>;
  cohorts: CohortAnalysis[];
  repeatedTraders: Array<{ wallet: string; windows: LeaderboardWindow[] }>;
  clusters: number;
  portfolio: { equityUsd: number; cashUsd: number; open: number; realizedUsd: number; halted: boolean; haltReason: string | null };
  paperPositions: Array<{ symbol: string; tokenMint: string; sizeUsd: number; entryPriceUsd: number; currentPriceUsd: number; pnlPct: number; remainingFraction: number; openedAt: number }>;
  closedTrades: TradeResult[];
  execution: { rpcHealth: number; killSwitch: { tripped: boolean; reason: string | null }; orders: number; auditEvents: number; mode: 'paper' | 'live'; liveLimits: { maxTradeUsd: number; dailyCapUsd: number }; wallet: string | null };
  feed: Array<{ ts: number; kind: string; text: string; tokenMint?: string }>;
  outcomes: number;
  similarityCases: number;
  health: Record<string, { ok: boolean; detail?: string }>;
}

/**
 * The decision engine: DATA INGESTION -> ON-CHAIN EVENTS -> MARKET FEATURES -> WALLET /
 * TRADER INTELLIGENCE -> SOCIAL + NARRATIVE -> TOKEN / LIQUIDITY RISK -> SCORING -> AI
 * EXPLANATION -> ALERT / PAPER TRADE / EXECUTION -> POSITION MONITORING -> EXIT -> OUTCOME
 * LABEL -> RECALIBRATION (spec §1 core operating loop).
 */
export class IntelligenceEngine {
  readonly tokens = new Map<string, Token>();
  readonly pools = new Map<string, Pool>();
  readonly tradesByToken = new Map<string, Trade[]>();
  readonly transfers: Transfer[] = [];
  readonly posts: SocialPost[] = [];
  readonly security = new Map<string, TokenSecurity>();
  readonly holders = new Map<string, HolderSnapshot>();
  readonly deployers = new Map<string, DeployerHistory>();
  readonly liquidityEvents = new Map<string, LiquidityEvent[]>();
  readonly authorityChanges = new Map<string, AuthorityChange[]>();
  readonly leaderboardSnapshots: LeaderboardSnapshot[] = [];

  // derived state
  walletGraph: WalletGraph = { clusters: [], clusterOf: new Map(), fundingAncestor: new Map() };
  positions: Position[] = [];
  profiles = new Map<string, TraderProfile>(); // key wallet|window
  ranked: Record<LeaderboardWindow, TraderProfile[]> = { '24h': [], '7d': [], '30d': [], '90d': [], all: [] };
  cohorts: CohortAnalysis[] = [];
  narratives: Narrative[] = [];
  evaluations = new Map<string, TokenEvaluation>();
  prevMarket = new Map<string, MarketFeatures>();
  prevRisk = new Map<string, RiskAssessment>();
  prevHolders = new Map<string, HolderSnapshot>();
  signals: Signal[] = [];
  cards = new Map<string, DecisionCard>();
  outcomes: Outcome[] = [];
  alerts: Alert[] = [];
  feed: EngineSnapshot['feed'] = [];
  similarity: SimilarityIndex;
  regime: RegimeState = { regime: 'neutral', breadth: 0.5, majorsReturn24h: 0, volumeVsAverage: 1 };
  health: Record<string, { ok: boolean; detail?: string }> = {};

  // execution / portfolio
  readonly rpc: RpcRouter;
  readonly killSwitch = new KillSwitch();
  readonly audit = new AuditLog();
  readonly execution: ExecutionEngine;
  readonly quotes: QuoteEngine;
  paperPositions = new Map<string, PaperPosition>();
  closedTrades: TradeResult[] = [];
  orders: Order[] = [];
  equityCurve: Array<{ ts: number; equityUsd: number }> = [];
  cashUsd: number;
  realizedUsd = 0;
  haltReason: string | null = null;
  private lastExit = new Map<string, { at: number; pnlUsd: number }>();
  executionMode: 'paper' | 'live';
  liveLimits: { maxTradeUsd: number; dailyCapUsd: number };
  /** USD notionally bought live in the trailing 24h (spend cap). */
  private liveSpend: Array<{ at: number; usd: number }> = [];

  private agents: { scout: MarketScoutAgent; wallet: WalletAnalystAgent; social: SocialAnalystAgent; security: SecurityAnalystAgent; reviewer: TradeReviewerAgent };
  private readonly opts: Required<Pick<EngineOptions, 'intendedSizeUsd' | 'startEquityUsd' | 'limits' | 'outcomeHorizonMs' | 'paperTrading' | 'topN'>> & EngineOptions;
  private readonly history: PriceHistory;
  private lastHeavyRecompute = 0;

  constructor(options: EngineOptions) {
    this.opts = { intendedSizeUsd: 500, startEquityUsd: 25_000, limits: DEFAULT_LIMITS, outcomeHorizonMs: 24 * MS.h, paperTrading: true, topN: 20, ...options };
    this.cashUsd = this.opts.startEquityUsd;
    this.rpc = new RpcRouter(options.rpcUrls ?? ['sim://rpc-a', 'sim://rpc-b']);
    this.quotes = new QuoteEngine(options.quoteSources?.length ? options.quoteSources : [new PoolQuoteSource()]);
    this.execution = new ExecutionEngine(this.quotes, this.rpc, this.killSwitch, this.audit, undefined, options.sender);
    if (options.executionMode === 'live' && !options.sender) throw new Error('executionMode=live requires a TransactionSender');
    this.executionMode = options.executionMode ?? 'paper';
    this.liveLimits = options.liveLimits ?? { maxTradeUsd: 100, dailyCapUsd: 500 };
    this.similarity = new SimilarityIndex(this.opts.outcomeHorizonMs);
    this.history = options.priceHistory ?? this.tradeDerivedHistory();
    const llm = options.llm;
    this.agents = { scout: new MarketScoutAgent(llm), wallet: new WalletAnalystAgent(llm), social: new SocialAnalystAgent(llm), security: new SecurityAnalystAgent(llm), reviewer: new TradeReviewerAgent(llm) };
    this.attach(options.bus);
  }

  // ---------------------------------------------------------------------------
  // Ingestion
  // ---------------------------------------------------------------------------
  private attach(bus: EventBus): void {
    bus.subscribe('chain.token.created', (e) => {
      this.tokens.set(e.payload.mint, e.payload);
      this.pushFeed(e.timestamp, 'token', `New token $${e.payload.symbol} (${e.payload.launchType})`, e.payload.mint);
    });
    bus.subscribe('chain.pool', (e) => {
      this.pools.set(e.payload.tokenMint, e.payload);
    });
    bus.subscribe('chain.trade', (e) => {
      const arr = this.tradesByToken.get(e.payload.tokenMint) ?? [];
      arr.push(e.payload);
      this.tradesByToken.set(e.payload.tokenMint, arr);
      if (e.payload.amountUsd >= 1000) {
        const skill = this.profiles.get(`${e.payload.wallet}|30d`)?.riskAdjustedSkill ?? 0;
        if (skill >= 60) this.pushFeed(e.timestamp, 'wallet', `Skilled wallet ${e.payload.wallet.slice(0, 6)}… ${e.payload.side} $${e.payload.amountUsd.toFixed(0)} of $${this.tokens.get(e.payload.tokenMint)?.symbol ?? '?'}`, e.payload.tokenMint);
      }
    });
    bus.subscribe('chain.transfer', (e) => {
      this.transfers.push(e.payload);
    });
    bus.subscribe('chain.security', (e) => {
      this.security.set(e.payload.tokenMint, e.payload);
    });
    bus.subscribe('chain.holders', (e) => {
      const prev = this.holders.get(e.payload.tokenMint);
      if (prev) this.prevHolders.set(e.payload.tokenMint, prev);
      this.holders.set(e.payload.tokenMint, e.payload);
    });
    bus.subscribe('chain.liquidity', (e) => {
      const arr = this.liquidityEvents.get(e.payload.tokenMint) ?? [];
      arr.push(e.payload);
      this.liquidityEvents.set(e.payload.tokenMint, arr);
      if (e.payload.kind === 'remove') this.pushFeed(e.timestamp, 'liquidity', `Liquidity removed: $${e.payload.amountUsd.toFixed(0)} from $${this.tokens.get(e.payload.tokenMint)?.symbol ?? '?'}`, e.payload.tokenMint);
    });
    bus.subscribe('chain.authority', (e) => {
      const arr = this.authorityChanges.get(e.payload.tokenMint) ?? [];
      arr.push(e.payload);
      this.authorityChanges.set(e.payload.tokenMint, arr);
      this.pushFeed(e.timestamp, 'security', `${e.payload.kind} authority changed on $${this.tokens.get(e.payload.tokenMint)?.symbol ?? '?'}`, e.payload.tokenMint);
    });
    bus.subscribe('social.post', (e) => {
      this.posts.push(e.payload);
    });
    bus.subscribe('platform.leaderboard', (e) => {
      this.leaderboardSnapshots.push(e.payload);
    });
  }

  setDeployerHistory(d: DeployerHistory): void {
    this.deployers.set(d.deployer, d);
  }

  private modeLabel(): string {
    return this.executionMode === 'live' ? 'LIVE' : 'Paper';
  }

  private pushFeed(ts: number, kind: string, text: string, tokenMint?: string): void {
    this.feed.push({ ts, kind, text, tokenMint });
    if (this.feed.length > 500) this.feed.splice(0, this.feed.length - 500);
  }

  private tradeDerivedHistory(): PriceHistory {
    const self = this;
    return {
      priceAt(mint, ts) {
        let best: Trade | undefined;
        for (const t of self.tradesByToken.get(mint) ?? []) if (t.timestamp <= ts && (!best || t.timestamp > best.timestamp)) best = t;
        return best?.priceUsd ?? 0;
      },
      peakAfter(mint, ts, horizon) {
        let p = 0;
        for (const t of self.tradesByToken.get(mint) ?? []) if (t.timestamp > ts && t.timestamp <= ts + horizon) p = Math.max(p, t.priceUsd);
        return p;
      },
      liquidityAt(mint) {
        return self.pools.get(mint)?.liquidityUsd ?? 0;
      },
    };
  }

  // ---------------------------------------------------------------------------
  // Recompute
  // ---------------------------------------------------------------------------
  async recompute(now = this.opts.now(), opts: { heavy?: boolean } = {}): Promise<void> {
    const heavy = opts.heavy ?? now - this.lastHeavyRecompute >= 15 * MS.m;
    if (heavy) {
      this.recomputeTraderIntelligence(now);
      await this.recomputeNarratives(now);
      this.lastHeavyRecompute = now;
    }
    this.recomputeRegime(now);
    for (const token of this.tokens.values()) {
      if (token.createdAt > now) continue;
      const trades = this.tradesByToken.get(token.mint) ?? [];
      const lastTrade = trades.length ? trades[trades.length - 1].timestamp : token.createdAt;
      if (now - lastTrade > 6 * MS.h && !this.paperPositions.has(token.mint)) continue; // dormant
      await this.evaluateToken(token, now);
    }
    if (this.opts.paperTrading) await this.managePaperPositions(now);
    this.labelOutcomes(now);
    const equity = this.equityUsd(now);
    this.equityCurve.push({ ts: now, equityUsd: equity });
    if (this.equityCurve.length > 5000) this.equityCurve.splice(0, this.equityCurve.length - 5000);
  }

  private recomputeRegime(now: number): void {
    const active = [...this.tokens.values()].filter((t) => t.createdAt <= now && (this.tradesByToken.get(t.mint)?.length ?? 0) > 5);
    const ups = active.filter((t) => {
      const p0 = this.history.priceAt(t.mint, now - MS.h);
      const p1 = this.history.priceAt(t.mint, now);
      return p0 > 0 && p1 > p0;
    }).length;
    const breadth = active.length ? ups / active.length : 0.5;
    const vol1h = active.reduce((s, t) => s + (this.tradesByToken.get(t.mint) ?? []).filter((x) => x.timestamp > now - MS.h && x.timestamp <= now).reduce((a, x) => a + x.amountUsd, 0), 0);
    const vol24h = active.reduce((s, t) => s + (this.tradesByToken.get(t.mint) ?? []).filter((x) => x.timestamp > now - MS.d && x.timestamp <= now).reduce((a, x) => a + x.amountUsd, 0), 0);
    const volumeVsAverage = vol24h > 0 ? vol1h / (vol24h / 24) : 1;
    const regime = breadth > 0.65 && volumeVsAverage > 1.5 ? 'meme-mania' : breadth > 0.55 ? 'bull' : breadth < 0.35 ? 'bear' : 'neutral';
    this.regime = { regime, breadth, majorsReturn24h: 0, volumeVsAverage };
  }

  private recomputeTraderIntelligence(now: number): void {
    const allTrades = [...this.tradesByToken.values()].flat().filter((t) => t.timestamp <= now);
    this.walletGraph = buildWalletGraph(this.transfers.filter((t) => t.timestamp <= now), allTrades);
    const rugged = new Set<string>();
    for (const [mint, evs] of this.liquidityEvents) if (evs.some((e) => e.kind === 'remove' && e.timestamp <= now && e.amountUsd > 0.3 * (this.pools.get(mint)?.liquidityUsd ?? 0) + 1)) rugged.add(mint);
    this.positions = buildPositions(allTrades, {
      tokens: this.tokens,
      liquidityAt: (m, ts) => this.history.liquidityAt(m, ts),
      localPeakAfter: (m, ts) => this.history.peakAfter(m, ts, 6 * MS.h),
      ruggedTokens: rugged,
    });
    const wallets = unique(allTrades.map((t) => t.wallet));
    const clusterLabel = (w: string) => {
      const c = this.walletGraph.clusters.find((x) => x.id === this.walletGraph.clusterOf.get(w));
      if (!c || c.wallets.length < 3) return null;
      return c.sameEntityScore > 0.7 && c.synchronizedEntries >= 5 ? ('insider-cluster' as const) : null;
    };
    const windows: LeaderboardWindow[] = ['24h', '7d', '30d', '90d', 'all'];
    for (const window of windows) {
      const profiles: TraderProfile[] = [];
      for (const w of wallets) {
        const p = buildTraderProfile(w, this.positions, window, { now, tokens: this.tokens, clusterLabel, priceAt: (m, ts) => this.history.priceAt(m, ts) });
        this.profiles.set(`${w}|${window}`, p);
        profiles.push(p);
      }
      this.ranked[window] = rankTraders(profiles, window === '24h' ? 3 : 5).slice(0, this.opts.topN);
    }
    this.cohorts = windows.map((window) =>
      analyzeCohort({ window, cohort: this.ranked[window], positions: this.positions, tokens: this.tokens, clusters: this.walletGraph.clusters, clusterOf: this.walletGraph.clusterOf, narratives: this.narratives, now }),
    );
    // Fold platform leaderboards into the candidate pool: any wallet ranked by an external platform gets profiled even with few local trades.
    for (const snap of this.leaderboardSnapshots.slice(-20)) for (const e of snap.entries) if (!this.profiles.has(`${e.wallet}|${snap.window}`)) this.profiles.set(`${e.wallet}|${snap.window}`, buildTraderProfile(e.wallet, this.positions, snap.window, { now, tokens: this.tokens, priceAt: (m, ts) => this.history.priceAt(m, ts) }));
  }

  private async recomputeNarratives(now: number): Promise<void> {
    const recent = this.posts.filter((p) => p.timestamp <= now && p.timestamp > now - 12 * MS.h);
    this.narratives = await clusterNarratives(recent.slice(-4000), now, { minClusterSize: 4 });
  }

  // ---------------------------------------------------------------------------
  // Per-token evaluation
  // ---------------------------------------------------------------------------
  private socialFor(token: Token, now: number): SocialVelocity | null {
    const posts = this.posts.filter((p) => p.timestamp <= now && p.timestamp > now - 2 * MS.h && (p.contracts.includes(token.mint) || p.tickers.includes(token.symbol)));
    if (posts.length === 0) return null;
    return computeSocialVelocity(token.symbol, posts, now);
  }

  private smartMoneyFor(token: Token, trades: Trade[], now: number, liquidityUsd: number): SmartMoneyInput & { buyers: string[] } {
    const recent = trades.filter((t) => t.timestamp > now - 15 * MS.m && t.timestamp <= now);
    const skillOf = (w: string) => this.profiles.get(`${w}|30d`)?.riskAdjustedSkill ?? this.profiles.get(`${w}|all`)?.riskAdjustedSkill ?? 0;
    const buyers = unique(recent.filter((t) => t.side === 'buy').map((t) => t.wallet));
    const skilled = buyers.filter((w) => skillOf(w) >= 60);
    const flow = recent.filter((t) => skillOf(t.wallet) >= 60).reduce((s, t) => s + (t.side === 'buy' ? t.amountUsd : -t.amountUsd), 0);
    const independent = unique(skilled.map((w) => this.walletGraph.clusterOf.get(w) ?? w)).length;
    const consensus = this.consensusFor(token.mint);
    return { consensusScore: consensus?.consensusScore ?? 0, meanSkillOfBuyers: buyers.length ? mean(buyers.map(skillOf)) : 0, smartNetFlowUsd: flow, independentSmartWallets: independent, liquidityUsd, buyers: skilled };
  }

  private consensusFor(mint: string): CommonToken | null {
    let best: CommonToken | null = null;
    for (const c of this.cohorts) for (const ct of c.commonTokens) if (ct.tokenMint === mint && (!best || ct.consensusScore > best.consensusScore)) best = ct;
    return best;
  }

  private dataConfidence(token: Token, now: number): number {
    const parts: number[] = [];
    const f = (fr: { asOf: number; confidence: number } | undefined, maxAge: number) => parts.push(fr ? fr.confidence * clamp(1 - (now - fr.asOf) / maxAge, 0, 1) : 0);
    f(this.pools.get(token.mint)?.freshness, 10 * MS.m);
    f(this.security.get(token.mint)?.freshness, 24 * MS.h);
    f(this.holders.get(token.mint)?.freshness, 6 * MS.h);
    return mean(parts);
  }

  private stateVector(token: Token, m: MarketFeatures, social: SocialVelocity | null, risk: RiskAssessment, sm: SmartMoneyInput, now: number): TokenStateVector {
    const d = this.deployers.get(token.deployer);
    const h = this.holders.get(token.mint);
    const s = this.security.get(token.mint);
    const nar = this.narratives.find((n) => n.tokenMints.includes(token.mint) || n.keywords.includes(`$${token.symbol}`));
    return {
      tokenMint: token.mint, timestamp: now, tokenAgeMs: m.tokenAgeMs, migrated: token.migrated ? 1 : 0, initialLiquidityUsd: this.pools.get(token.mint)?.liquidityUsd ?? m.liquidityUsd,
      marketCapUsd: m.marketCapUsd, liquidityUsd: m.liquidityUsd, volume1hUsd: m.intervals['1h'].volumeUsd, volatility: m.volatility,
      uniqueBuyers15m: m.intervals['15m'].uniqueBuyers, buyerAcceleration: m.buyerAcceleration, volumeQuality: m.volumeQuality.score,
      socialVelocity: social?.velocityScore ?? 0, narrativeCategory: nar ? categoryBucket(nar.label) : 0, influencerDiffusion: social?.influencerDiffusion ?? 0,
      topTraderConsensus: sm.consensusScore, smartEntryLatencyMs: 0, deployerRugRate: d && d.launches ? d.ruggedLaunches / d.launches : 0,
      top10Concentration: h ? h.top.slice(0, 10).reduce((a, x) => a + x.pct, 0) : 0, authorityRisk: s ? (s.mintAuthority ? 1 : 0) + (s.freezeAuthority ? 1 : 0) : 1,
    };
  }

  async evaluateToken(token: Token, now: number): Promise<TokenEvaluation | null> {
    const pool = this.pools.get(token.mint);
    const trades = (this.tradesByToken.get(token.mint) ?? []).filter((t) => t.timestamp <= now);
    if (!pool) return null;
    const priceUsd = this.history.priceAt(token.mint, now) || (trades.length ? trades[trades.length - 1].priceUsd : 0);
    if (priceUsd <= 0) return null;
    const recentHighUsd = this.history.peakAfter(token.mint, now - 12 * MS.h, 12 * MS.h - 1);
    const market = computeMarketFeatures({ token, pool, trades: trades.filter((t) => t.timestamp > now - 3 * MS.h), fundingAncestor: this.walletGraph.fundingAncestor, now, priceUsd, freshness: pool.freshness, recentHighUsd });
    const social = this.socialFor(token, now);
    const sm = this.smartMoneyFor(token, trades, now, pool.liquidityUsd);
    const fastMoving = market.volumeAcceleration['5m'] > 3;
    const sizeUsd = this.opts.intendedSizeUsd;
    const sellQuote = await this.execution.probeExit(pool, sizeUsd, now);
    const buyQuote = await this.quotes.best(pool, 'buy', sizeUsd, now);
    const holderClusters = this.walletGraph.clusters.filter((c) => c.wallets.length > 1 && (this.holders.get(token.mint)?.top ?? []).some((h) => c.wallets.includes(h.wallet)));
    const risk = assessTokenRisk({
      tokenMint: token.mint, now, security: this.security.get(token.mint) ?? null, pool, holders: this.holders.get(token.mint) ?? null, deployer: this.deployers.get(token.deployer) ?? null,
      liquidityEvents: (this.liquidityEvents.get(token.mint) ?? []).filter((e) => e.timestamp <= now), market, clusters: holderClusters, social, sellQuote, fastMoving,
    });
    const dataConfidence = this.dataConfidence(token, now);
    const state = this.stateVector(token, market, social, risk, sm, now);
    const similar = this.similarity.size() >= 8 ? this.similarity.query(state, 25, now) : null;
    const card = buildDecisionCard({ token, market, risk, smartMoney: sm, social, regime: this.regime, buyQuote, sellQuote, rpcHealth: this.rpc.health(now), intendedSizeUsd: sizeUsd, similar, now, dataConfidence });
    const prevM = this.prevMarket.get(token.mint) ?? null;
    const prevH = this.prevHolders.get(token.mint);
    const curH = this.holders.get(token.mint);
    const conc = (h?: HolderSnapshot) => (h ? h.top.slice(0, 10).reduce((a, x) => a + x.pct, 0) : 0);
    const distribution = distributionScore({ market, prevMarket: prevM, social, smartNetFlowUsd: sm.smartNetFlowUsd, whaleConcentrationDelta: conc(curH) - conc(prevH ?? curH), liquidityDeltaPct: prevM ? ((market.liquidityUsd - prevM.liquidityUsd) / Math.max(1, prevM.liquidityUsd)) * 100 : 0 });
    const consensus = this.consensusFor(token.mint);
    const alerts = evaluateAlerts({
      token, now, market, prevMarket: prevM, risk, prevRisk: this.prevRisk.get(token.mint) ?? null, card, social, consensus, distribution, smartNetFlowUsd: sm.smartNetFlowUsd, smartBuyers: sm.independentSmartWallets,
      liquidityEvents: (this.liquidityEvents.get(token.mint) ?? []).filter((e) => e.timestamp <= now), authorityChanges: (this.authorityChanges.get(token.mint) ?? []).filter((a) => a.timestamp <= now),
      executionOk: !this.killSwitch.evaluate(this.rpc.health(now)).tripped, dataConfidence, oodShare: 0,
    });
    // Dedupe alerts: same kind for same token within 30 minutes is not re-raised.
    const fresh = alerts.filter((a) => !this.alerts.some((x) => x.tokenMint === a.tokenMint && x.kind === a.kind && now - x.timestamp < 30 * MS.m));
    this.alerts.push(...fresh);
    if (this.alerts.length > 2000) this.alerts.splice(0, this.alerts.length - 2000);
    for (const a of fresh) this.pushFeed(now, `alert:${a.kind}`, `${a.title}: $${token.symbol} — ${a.explanation}`, token.mint);

    // Signal log (features at decision time) for the learning loop.
    const prevCard = this.cards.get(token.mint);
    if (!prevCard || prevCard.decision !== card.decision || now - prevCard.timestamp >= 15 * MS.m) {
      this.signals.push({ id: newId('sig'), tokenMint: token.mint, timestamp: now, features: stateToFeatures(state), scores: card.scores, decision: card.decision, modelVersion: 'v0.1-heuristic' });
      if (prevCard && prevCard.decision !== card.decision) this.pushFeed(now, 'model', `$${token.symbol}: ${prevCard.decision} → ${card.decision} (net EV ${card.scores.netEvPct.toFixed(1)}%)`, token.mint);
    }
    this.cards.set(token.mint, card);
    this.prevMarket.set(token.mint, market);
    this.prevRisk.set(token.mint, risk);

    const agentNotes: AgentReport[] = [];
    if (card.decision !== 'PASS' || fresh.length) {
      const buyerProfiles = sm.buyers.map((w) => this.profiles.get(`${w}|30d`)).filter((p): p is TraderProfile => !!p);
      agentNotes.push(await this.agents.scout.analyze(market, token.symbol), await this.agents.wallet.analyze(token.symbol, buyerProfiles, holderClusters, now), await this.agents.social.analyze(token.symbol, social, now), await this.agents.security.analyze(token.symbol, risk));
    }
    const ev: TokenEvaluation = { token, market, social, risk, card, alerts: fresh, distribution, consensus, smartMoney: sm, similar, agentNotes };
    this.evaluations.set(token.mint, ev);
    return ev;
  }

  // ---------------------------------------------------------------------------
  // Paper trading + position monitoring
  // ---------------------------------------------------------------------------
  equityUsd(now: number): number {
    let open = 0;
    for (const p of this.paperPositions.values()) open += p.quantity * p.remainingFraction * (this.history.priceAt(p.tokenMint, now) || p.entryPriceUsd);
    return this.cashUsd + open;
  }

  private portfolioState(now: number): PortfolioState {
    const open = [...this.paperPositions.values()].map((p) => ({ tokenMint: p.tokenMint, narrativeIds: p.narrativeIds, correlationKey: p.correlationKey, valueUsd: p.quantity * p.remainingFraction * (this.history.priceAt(p.tokenMint, now) || p.entryPriceUsd), highRisk: p.highRisk }));
    const ks = this.killSwitch.evaluate(this.rpc.health(now));
    return { equityUsd: this.equityUsd(now), cashUsd: this.cashUsd, open, equityCurve: this.equityCurve, dataHealthy: true, executionHealthy: !ks.tripped };
  }

  private async managePaperPositions(now: number): Promise<void> {
    // Exits first (free capital), then entries.
    for (const pos of [...this.paperPositions.values()]) {
      const ev = this.evaluations.get(pos.tokenMint);
      const pool = this.pools.get(pos.tokenMint);
      if (!ev || !pool) continue;
      const price = this.history.priceAt(pos.tokenMint, now) || ev.market.priceUsd;
      pos.highWaterPriceUsd = Math.max(pos.highWaterPriceUsd, price);
      const plan = planExit(pos, ev.market, ev.risk, ev.distribution);
      if (plan.action === 'hold') continue;
      const sellUsd = pos.quantity * pos.remainingFraction * plan.fraction * price;
      if (sellUsd < 5) continue;
      const order = await this.execution.execute(pool, 'sell', sellUsd, this.executionMode, now, price, pos.quantity * pos.remainingFraction * plan.fraction);
      this.orders.push(order);
      if (order.status !== 'filled') {
        this.pushFeed(now, 'execution', `${this.modeLabel()} sell rejected for $${ev.token.symbol}: ${order.rejectReason}`, pos.tokenMint);
        continue;
      }
      pos.orders.push(order);
      this.cashUsd += order.filledUsd ?? 0;
      pos.realizedUsd += (order.filledUsd ?? 0) - pos.sizeUsd * pos.remainingFraction * plan.fraction;
      pos.remainingFraction *= 1 - plan.fraction;
      if (plan.action === 'partial') {
        const idx = (ev.market.priceUsd / pos.entryPriceUsd >= 5 ? 2 : ev.market.priceUsd / pos.entryPriceUsd >= 3 ? 1 : 0);
        if (plan.reason.startsWith('take-profit')) pos.takenLevels.push(idx);
        else pos.discretionaryTrims = (pos.discretionaryTrims ?? 0) + 1;
      }
      this.pushFeed(now, 'execution', `${this.modeLabel()} ${plan.action} ${(plan.fraction * 100).toFixed(0)}% of $${ev.token.symbol}: ${plan.reason}${order.txSignature ? ` (${order.txSignature.slice(0, 8)}…)` : ''}`, pos.tokenMint);
      if (pos.remainingFraction <= 0.1 || plan.action !== 'partial') {
        // Close out any dust remainder so the position is fully realized.
        if (pos.remainingFraction > 0 && plan.action === 'partial') {
          const dustUsd = pos.quantity * pos.remainingFraction * price;
          if (dustUsd >= 5) {
            const dust = await this.execution.execute(pool, 'sell', dustUsd, this.executionMode, now, price, pos.quantity * pos.remainingFraction);
            if (dust.status === 'filled') {
              this.cashUsd += dust.filledUsd ?? 0;
              pos.realizedUsd += (dust.filledUsd ?? 0) - pos.sizeUsd * pos.remainingFraction;
              pos.remainingFraction = 0;
            }
          }
        }
        this.lastExit.set(pos.tokenMint, { at: now, pnlUsd: pos.realizedUsd });
        const pnlUsd = pos.realizedUsd;
        const result: TradeResult = { signalId: pos.signalId, tokenMint: pos.tokenMint, entryAt: pos.openedAt, exitAt: now, sizeUsd: pos.sizeUsd, pnlUsd, pnlPct: (pnlUsd / pos.sizeUsd) * 100, quotedPriceUsd: pos.card.timestamp ? pos.entryPriceUsd / (1 + (pos.orders[0]?.slippagePct ?? 0) / 100) : pos.entryPriceUsd, filledPriceUsd: pos.entryPriceUsd, rugged: ev.risk.hardBlocked && plan.action === 'emergency-exit', majorMove: pos.highWaterPriceUsd / pos.entryPriceUsd >= 2 };
        this.closedTrades.push(result);
        this.realizedUsd += pnlUsd;
        this.paperPositions.delete(pos.tokenMint);
        const review = await this.agents.reviewer.analyze(result, pos.card, now);
        this.pushFeed(now, 'review', review.summary, pos.tokenMint);
      }
    }
    for (const ev of this.evaluations.values()) {
      if (this.paperPositions.has(ev.token.mint)) continue;
      const last = this.lastExit.get(ev.token.mint);
      if (last && (now - last.at < 2 * MS.h || (last.pnlUsd < 0 && now - last.at < 6 * MS.h))) continue; // re-entry cooldown
      const enter = ev.card.decision === 'ENTER' || (ev.card.decision === 'CONFIRMATION_ENTRY' && ev.market.buyerAcceleration >= 1.3 && ev.market.buySellImbalance > 0.1);
      if (!enter || ev.card.timestamp !== ev.market.timestamp) continue;
      const pool = this.pools.get(ev.token.mint);
      if (!pool) continue;
      const nar = this.narratives.filter((n) => n.tokenMints.includes(ev.token.mint) || n.keywords.includes(`$${ev.token.symbol}`)).map((n) => n.id);
      const stopPct = volatilityStopPct(ev.market);
      const sizing = checkPortfolioLimits(this.portfolioState(now), { tokenMint: ev.token.mint, narrativeIds: nar, correlationKey: `${ev.token.chain}|${ev.token.launchType}|${nar[0] ?? 'none'}`, requestedUsd: ev.card.suggestedSizeUsd, stopDistancePct: stopPct, highRisk: ev.card.rugProbability > 0.05 || ev.card.scores.liquidity < 60, now }, this.opts.limits);
      if (sizing.halted) {
        this.haltReason = sizing.reasons.join('; ');
        return;
      }
      this.haltReason = null;
      let sizeUsd = sizing.allowedUsd;
      if (this.executionMode === 'live') {
        // Live caps are hard limits on top of portfolio limits (spec §23 phase 6: strict limits).
        this.liveSpend = this.liveSpend.filter((x) => now - x.at < MS.d);
        const spent = this.liveSpend.reduce((a, x) => a + x.usd, 0);
        sizeUsd = Math.min(sizeUsd, this.liveLimits.maxTradeUsd, this.liveLimits.dailyCapUsd - spent);
        if (sizeUsd < 20) {
          this.pushFeed(now, 'execution', `Live buy skipped for $${ev.token.symbol}: live caps (per-trade $${this.liveLimits.maxTradeUsd}, daily $${this.liveLimits.dailyCapUsd}, spent $${spent.toFixed(0)})`, ev.token.mint);
          continue;
        }
      }
      if (sizeUsd < 20) continue;
      const order = await this.execution.execute(pool, 'buy', sizeUsd, this.executionMode, now, ev.market.priceUsd);
      this.orders.push(order);
      if (order.status !== 'filled') {
        this.pushFeed(now, 'execution', `${this.modeLabel()} buy rejected for $${ev.token.symbol}: ${order.rejectReason}`, ev.token.mint);
        continue;
      }
      if (this.executionMode === 'live') this.liveSpend.push({ at: now, usd: order.filledUsd ?? sizeUsd });
      const filledPx = order.filledPriceUsd ?? ev.market.priceUsd;
      this.cashUsd -= order.filledUsd ?? sizeUsd;
      const sig = this.signals.filter((s) => s.tokenMint === ev.token.mint).at(-1);
      const quantity = order.filledTokenAmount ?? (order.filledUsd ?? sizeUsd) / filledPx;
      this.paperPositions.set(ev.token.mint, { tokenMint: ev.token.mint, entryPriceUsd: filledPx, quantity, remainingFraction: 1, highWaterPriceUsd: filledPx, openedAt: now, takenLevels: [], sizeUsd: order.filledUsd ?? sizeUsd, signalId: sig?.id ?? newId('sig'), card: ev.card, narrativeIds: nar, correlationKey: `${ev.token.chain}|${ev.token.launchType}|${nar[0] ?? 'none'}`, highRisk: ev.card.rugProbability > 0.05, realizedUsd: 0, orders: [order] });
      this.pushFeed(now, 'execution', `${this.modeLabel()} buy $${(order.filledUsd ?? 0).toFixed(0)} of $${ev.token.symbol} (${ev.card.decision}, net EV ${ev.card.scores.netEvPct.toFixed(1)}%${sizing.reasons.length ? `; ${sizing.reasons[0]}` : ''}${order.txSignature ? `; tx ${order.txSignature.slice(0, 8)}…` : ''})`, ev.token.mint);
    }
  }

  // ---------------------------------------------------------------------------
  // Outcome labeling -> learning loop
  // ---------------------------------------------------------------------------
  private labelOutcomes(now: number): void {
    const horizon = this.opts.outcomeHorizonMs;
    const labeled = new Set(this.outcomes.map((o) => o.signalId));
    for (const s of this.signals) {
      if (labeled.has(s.id) || s.timestamp + horizon > now) continue;
      const p0 = this.history.priceAt(s.tokenMint, s.timestamp);
      if (p0 <= 0) continue;
      const fr = (ms: number) => {
        const p = this.history.priceAt(s.tokenMint, s.timestamp + ms);
        return p > 0 ? p / p0 - 1 : null;
      };
      const peak = this.history.peakAfter(s.tokenMint, s.timestamp, horizon);
      let minP = p0;
      for (let t = s.timestamp; t <= s.timestamp + horizon; t += 15 * MS.m) {
        const p = this.history.priceAt(s.tokenMint, t);
        if (p > 0) minP = Math.min(minP, p);
      }
      // Rug = liquidity pulled inside the horizon, or a crash of >80% within an hour (soft rug / instant dump).
      // A slow bleed is a losing trade, not a rug: exits handle it.
      const rugged = (this.liquidityEvents.get(s.tokenMint) ?? []).some((e) => e.kind === 'remove' && e.timestamp > s.timestamp && e.timestamp <= s.timestamp + horizon) || (fr(MS.h) ?? 0) <= -0.8;
      let timeToTarget: number | null = null;
      for (let t = s.timestamp; t <= s.timestamp + horizon; t += 5 * MS.m) {
        if (this.history.priceAt(s.tokenMint, t) >= 2 * p0) {
          timeToTarget = t - s.timestamp;
          break;
        }
      }
      const outcome: Outcome = { signalId: s.id, tokenMint: s.tokenMint, decisionAt: s.timestamp, forwardReturns: { '15m': fr(15 * MS.m), '1h': fr(MS.h), '4h': fr(4 * MS.h), '24h': fr(horizon) }, maxForwardReturn: peak > 0 ? peak / p0 - 1 : 0, maxDrawdown: minP / p0 - 1, reached2x: peak >= 2 * p0, reached5x: peak >= 5 * p0, rugged, timeToTargetMs: timeToTarget, realizedPnlPct: null };
      this.outcomes.push(outcome);
      this.similarity.add({ state: featuresToState(s), outcome });
    }
  }

  // ---------------------------------------------------------------------------
  snapshot(now = this.opts.now()): EngineSnapshot {
    const watch = [...this.evaluations.values()]
      .map((ev) => ({ symbol: ev.token.symbol, tokenMint: ev.token.mint, decision: ev.card.decision, alpha: ev.card.scores.alpha, netEvPct: ev.card.scores.netEvPct, security: ev.card.scores.security, rugProbability: ev.card.rugProbability, catalyst: this.narratives.find((n) => n.tokenMints.includes(ev.token.mint) || n.keywords.includes(`$${ev.token.symbol}`))?.catalyst ?? null, freshnessMs: now - ev.card.timestamp, momentum: ev.card.scores.momentum, smartMoney: ev.card.scores.smartMoney, narrative: ev.card.scores.narrative, liquidityUsd: ev.market.liquidityUsd, priceUsd: ev.market.priceUsd, marketCapUsd: ev.market.marketCapUsd }))
      .sort((a, b) => rankDecision(b.decision) - rankDecision(a.decision) || b.alpha - a.alpha);
    const ks = this.killSwitch.evaluate(this.rpc.health(now));
    return {
      now,
      regime: this.regime,
      watchlist: watch,
      alerts: this.alerts.slice(-100).reverse(),
      narratives: this.narratives.slice(0, 12),
      leaderboards: this.ranked,
      cohorts: this.cohorts,
      repeatedTraders: repeatedAcrossWindows(this.ranked),
      clusters: this.walletGraph.clusters.filter((c) => c.wallets.length > 1).length,
      portfolio: { equityUsd: this.equityUsd(now), cashUsd: this.cashUsd, open: this.paperPositions.size, realizedUsd: this.realizedUsd, halted: this.haltReason !== null, haltReason: this.haltReason },
      paperPositions: [...this.paperPositions.values()].map((p) => {
        const px = this.history.priceAt(p.tokenMint, now) || p.entryPriceUsd;
        return { symbol: this.tokens.get(p.tokenMint)?.symbol ?? '?', tokenMint: p.tokenMint, sizeUsd: p.sizeUsd, entryPriceUsd: p.entryPriceUsd, currentPriceUsd: px, pnlPct: (px / p.entryPriceUsd - 1) * 100, remainingFraction: p.remainingFraction, openedAt: p.openedAt };
      }),
      closedTrades: this.closedTrades.slice(-50),
      execution: { rpcHealth: this.rpc.health(now), killSwitch: ks, orders: this.orders.length, auditEvents: this.audit.all().length, mode: this.executionMode, liveLimits: this.liveLimits, wallet: this.execution.hasSender() ? 'configured' : null },
      feed: this.feed.slice(-80).reverse(),
      outcomes: this.outcomes.length,
      similarityCases: this.similarity.size(),
      health: this.health,
    };
  }

  tokenDetail(mint: string, now = this.opts.now()) {
    const ev = this.evaluations.get(mint);
    if (!ev) return null;
    const trades = (this.tradesByToken.get(mint) ?? []).slice(-200);
    const topTraders = unique(trades.map((t) => t.wallet)).map((w) => this.profiles.get(`${w}|30d`)).filter((p): p is TraderProfile => !!p).sort((a, b) => b.riskAdjustedSkill - a.riskAdjustedSkill).slice(0, 10);
    const social = this.posts.filter((p) => p.timestamp <= now && (p.contracts.includes(mint) || p.tickers.includes(ev.token.symbol))).slice(-30).reverse();
    const holders = this.holders.get(mint) ?? null;
    const clusters = this.walletGraph.clusters.filter((c) => c.wallets.length > 1 && trades.some((t) => c.wallets.includes(t.wallet)));
    const { expectedImpactPct: _omit, ...market } = ev.market;
    return { ...ev, market, trades: trades.slice(-60).reverse(), topTraders, social, holders, clusters: clusters.map((c) => ({ id: c.id, size: c.wallets.length, sameEntityScore: c.sameEntityScore, fundingAncestor: c.fundingAncestor })), narrative: this.narratives.find((n) => n.tokenMints.includes(mint) || n.keywords.includes(`$${ev.token.symbol}`)) ?? null, priceSeries: this.priceSeries(mint, now) };
  }

  priceSeries(mint: string, now: number, points = 120, stepMs = 5 * MS.m): Array<{ ts: number; priceUsd: number }> {
    const out: Array<{ ts: number; priceUsd: number }> = [];
    for (let i = points - 1; i >= 0; i--) {
      const ts = now - i * stepMs;
      const p = this.history.priceAt(mint, ts);
      if (p > 0) out.push({ ts, priceUsd: p });
    }
    return out;
  }
}

function rankDecision(d: string): number {
  return { ENTER: 5, CONFIRMATION_ENTRY: 4, WATCH: 3, PASS: 1, HARD_BLOCK: 0 }[d] ?? 0;
}

function stateToFeatures(s: TokenStateVector): Record<string, number> {
  const { tokenMint: _m, timestamp: _t, ...rest } = s;
  return rest;
}

function featuresToState(sig: Signal): TokenStateVector {
  return { tokenMint: sig.tokenMint, timestamp: sig.timestamp, ...(sig.features as Omit<TokenStateVector, 'tokenMint' | 'timestamp'>) };
}

export const _pipelineTest = { ratio };
