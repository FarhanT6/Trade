/**
 * Core domain model for the Meme-Coin Trading Intelligence Platform.
 *
 * Design rule (spec "Evidence" principle): blockchain facts, statistical
 * signals, social signals and AI interpretation are kept as separate types so
 * that no layer can silently masquerade as another.
 */

export type Chain = 'solana' | 'ethereum' | 'base' | 'bsc';

export type LaunchType =
  | 'pump-style'
  | 'migration'
  | 'established-meme'
  | 'celebrity-news'
  | 'unknown';

export type MarketRegime = 'bull' | 'neutral' | 'bear' | 'meme-mania';

/** Every critical feature carries freshness so stale data can never be "neutral". */
export interface Freshness {
  /** Unix ms timestamp the value was observed at. */
  asOf: number;
  /** Which adapter/source produced it. */
  source: string;
  /** 0..1 confidence in the value (chain-derived = 1). */
  confidence: number;
}

// ---------------------------------------------------------------------------
// Blockchain facts
// ---------------------------------------------------------------------------

export interface Token {
  mint: string;
  chain: Chain;
  symbol: string;
  name: string;
  decimals: number;
  totalSupply: number;
  createdAt: number;
  launchType: LaunchType;
  migrated: boolean;
  migratedAt?: number;
  deployer: string;
  metadataUri?: string;
}

export interface Pool {
  id: string;
  chain: Chain;
  tokenMint: string;
  quoteMint: string;
  dex: string;
  /** Token reserve in token units. */
  tokenReserve: number;
  /** Quote reserve in USD-equivalent. */
  quoteReserveUsd: number;
  liquidityUsd: number;
  lpOwner: string;
  lpLockedPct: number;
  createdAt: number;
  freshness: Freshness;
}

export type TradeSide = 'buy' | 'sell';

export interface Trade {
  id: string;
  chain: Chain;
  tokenMint: string;
  poolId: string;
  wallet: string;
  side: TradeSide;
  amountToken: number;
  amountUsd: number;
  priceUsd: number;
  feeUsd: number;
  timestamp: number;
  txSignature: string;
  /** Set when the swap was routed through a known bot/aggregator program. */
  program?: string;
}

export interface Transfer {
  id: string;
  chain: Chain;
  from: string;
  to: string;
  mint: string;
  amount: number;
  amountUsd?: number;
  timestamp: number;
}

export type LiquidityEventKind = 'add' | 'remove' | 'migrate' | 'lock' | 'unlock';

export interface LiquidityEvent {
  id: string;
  poolId: string;
  tokenMint: string;
  kind: LiquidityEventKind;
  amountUsd: number;
  wallet: string;
  timestamp: number;
}

export type AuthorityKind = 'mint' | 'freeze' | 'metadata' | 'owner';

export interface AuthorityChange {
  id: string;
  tokenMint: string;
  kind: AuthorityKind;
  previous: string | null;
  current: string | null;
  timestamp: number;
}

export interface HolderSnapshot {
  tokenMint: string;
  timestamp: number;
  holderCount: number;
  /** Sorted descending: fraction of supply held by wallet. */
  top: Array<{ wallet: string; pct: number }>;
  deployerPct: number;
  freshness: Freshness;
}

export interface TokenSecurity {
  tokenMint: string;
  mintAuthority: string | null;
  freezeAuthority: string | null;
  metadataMutable: boolean;
  /** Token-2022 extensions present on the mint. */
  token2022Extensions: string[];
  transferFeeBps?: number;
  permanentDelegate?: string | null;
  defaultAccountStateFrozen?: boolean;
  freshness: Freshness;
}

export interface DeployerHistory {
  deployer: string;
  launches: number;
  ruggedLaunches: number;
  fundingSources: string[];
  knownMaliciousClusterMatch: boolean;
  freshness: Freshness;
}

// ---------------------------------------------------------------------------
// Market state (derived, statistical)
// ---------------------------------------------------------------------------

export interface MarketSnapshot {
  tokenMint: string;
  poolId: string;
  timestamp: number;
  priceUsd: number;
  liquidityUsd: number;
  marketCapUsd: number;
  fdvUsd: number;
  freshness: Freshness;
}

export type Interval = '1m' | '5m' | '15m' | '1h';

export interface IntervalStats {
  volumeUsd: number;
  buyVolumeUsd: number;
  sellVolumeUsd: number;
  trades: number;
  uniqueBuyers: number;
  uniqueSellers: number;
  priceChangePct: number;
}

export interface MarketFeatures {
  tokenMint: string;
  timestamp: number;
  priceUsd: number;
  liquidityUsd: number;
  marketCapUsd: number;
  tokenAgeMs: number;
  intervals: Record<Interval, IntervalStats>;
  /** Ratio of current-window volume to previous-window volume (per interval). */
  volumeAcceleration: Record<Interval, number>;
  priceAcceleration: number;
  volatility: number;
  volatilityRegime: 'low' | 'normal' | 'high' | 'extreme';
  buyerAcceleration: number;
  sellerAcceleration: number;
  avgTradeSizeUsd: number;
  medianTradeSizeUsd: number;
  buySellImbalance: number; // -1..1
  liquidityToMcap: number;
  /** Highest trade price in the lookback window and how far price sits below it (0..1). */
  recentHighUsd: number;
  drawdownFromHigh: number;
  depthUsd: { bid1pct: number; ask1pct: number; bid5pct: number; ask5pct: number };
  expectedImpactPct: (sizeUsd: number) => number;
  volumeQuality: VolumeQuality;
  freshness: Freshness;
}

export interface VolumeQuality {
  reportedVolumeUsd: number;
  economicVolumeUsd: number;
  /** economic / reported, 0..1 */
  score: number;
  uniqueTraders: number;
  repeatedLoopVolumeUsd: number;
  sharedFundingVolumeUsd: number;
  suspectedWashRatio: number;
}

// ---------------------------------------------------------------------------
// Wallet & trader intelligence
// ---------------------------------------------------------------------------

export type WalletLabel =
  | 'smart-money'
  | 'deployer'
  | 'insider-cluster'
  | 'market-maker'
  | 'bot'
  | 'exchange'
  | 'bridge'
  | 'unknown';

export interface Wallet {
  address: string;
  chain: Chain;
  labels: WalletLabel[];
  firstSeen: number;
  reputation: number; // 0..1
}

export interface Position {
  wallet: string;
  tokenMint: string;
  openedAt: number;
  closedAt: number | null;
  entryPriceUsd: number;
  exitPriceUsd: number | null;
  sizeUsd: number;
  quantity: number;
  realizedPnlUsd: number;
  feesUsd: number;
  holdMs: number | null;
  /** Position size relative to pool liquidity at entry. */
  sizeToLiquidity: number;
  /** ms from token creation/migration to first buy. */
  entryLatencyMs: number;
  /** Did the token later suffer a catastrophic liquidity/contract event? */
  tokenRugged: boolean;
  /** Fraction of the subsequent local peak the trader captured (0..1). */
  exitQuality: number | null;
  regime: MarketRegime;
}

export type TraderArchetype =
  | 'sniper'
  | 'momentum'
  | 'narrative'
  | 'swing'
  | 'scalper'
  | 'accumulator'
  | 'contrarian'
  | 'exit-specialist'
  | 'insider-cluster'
  | 'market-maker'
  | 'unclassified';

export type LeaderboardWindow = '24h' | '7d' | '30d' | '90d' | 'all';

export interface TraderProfile {
  wallet: string;
  window: LeaderboardWindow;
  realizedPnlUsd: number;
  unrealizedPnlUsd: number;
  winRate: number;
  profitFactor: number;
  averageR: number;
  medianHoldMs: number;
  medianEntryLatencyMs: number;
  positionSizing: { avgUsd: number; medianUsd: number; maxUsd: number; medianSizeToLiquidity: number };
  maxDrawdownPct: number;
  recoveryTimeMs: number | null;
  regimeConsistency: Record<MarketRegime, number | null>;
  categoryPerformance: Record<string, { trades: number; pnlUsd: number; winRate: number }>;
  rugExposure: number;
  exitQuality: number;
  survivability: number;
  sampleSize: number;
  /** Composite skill after risk, consistency, sample size and regime dependence. */
  riskAdjustedSkill: number;
  archetype: TraderArchetype;
  archetypeConfidence: number;
}

export interface LeaderboardEntry {
  rank: number;
  wallet: string;
  window: LeaderboardWindow;
  pnlUsd: number;
  winRate?: number;
  trades?: number;
}

export interface LeaderboardSnapshot {
  source: string;
  window: LeaderboardWindow;
  capturedAt: number;
  entries: LeaderboardEntry[];
}

export interface WalletCluster {
  id: string;
  wallets: string[];
  fundingAncestor: string | null;
  fundingOverlap: number;
  synchronizedEntries: number;
  synchronizedExits: number;
  sizeSimilarity: number;
  coOccurrence: number;
  /** 0..1 likelihood the wallets are one entity. */
  sameEntityScore: number;
}

// ---------------------------------------------------------------------------
// Social & narrative
// ---------------------------------------------------------------------------

export type SocialPlatform = 'x' | 'reddit' | 'telegram' | 'discord' | 'fomo' | 'fomp' | 'other';

export interface SocialPost {
  id: string;
  platform: SocialPlatform;
  authorId: string;
  authorFollowers: number;
  authorCreatedAt: number;
  authorHighSignal: boolean;
  text: string;
  timestamp: number;
  engagement: { likes: number; reposts: number; replies: number; quotes: number };
  isQuote: boolean;
  /** Extracted entities. */
  tickers: string[];
  contracts: string[];
  urls: string[];
  community?: string;
}

export type EntityKind = 'person' | 'project' | 'token' | 'wallet' | 'url' | 'narrative';

export interface Entity {
  id: string;
  kind: EntityKind;
  label: string;
  aliases: string[];
}

export interface Narrative {
  id: string;
  label: string;
  keywords: string[];
  firstSeen: number;
  lastSeen: number;
  postIds: string[];
  tokenMints: string[];
  sentiment: SentimentDistribution;
  momentum: 'accelerating' | 'stable' | 'fading';
  momentumScore: number;
  authenticity: number;
  influencerConcentration: number;
  catalyst?: string;
}

export interface SentimentDistribution {
  bullish: number;
  bearish: number;
  mixed: number;
  uncertain: number;
}

export interface SocialVelocity {
  subject: string;
  timestamp: number;
  mentions: number[];
  uniqueAuthors: number[];
  engagement: number[];
  mentionAcceleration: number;
  uniqueAuthorAcceleration: number;
  engagementAcceleration: number;
  quoteVelocity: number;
  newAccountShare: number;
  influencerDiffusion: number;
  crossPlatformDiffusion: number;
  saturation: number;
  botLikelihood: number;
  velocityScore: number;
}

// ---------------------------------------------------------------------------
// Risk, scoring, decisions
// ---------------------------------------------------------------------------

export type RiskFamily =
  | 'authorities'
  | 'token-2022'
  | 'liquidity'
  | 'holders'
  | 'deployer'
  | 'trading-integrity'
  | 'sellability'
  | 'contract-behavior'
  | 'social-risk'
  | 'data-quality';

export type RiskSeverity = 'info' | 'low' | 'medium' | 'high' | 'critical';

export interface RiskFinding {
  family: RiskFamily;
  severity: RiskSeverity;
  code: string;
  message: string;
  hardBlock: boolean;
}

export interface RiskAssessment {
  tokenMint: string;
  timestamp: number;
  findings: RiskFinding[];
  securityScore: number;
  manipulationScore: number;
  hardBlocked: boolean;
  hardBlockReasons: string[];
  rugProbability: number;
}

export interface ScoreSet {
  momentum: number;
  smartMoney: number;
  narrative: number;
  liquidity: number;
  security: number;
  manipulation: number;
  execution: number;
  marketRegime: number;
  netEvPct: number;
  alpha: number;
}

export type Decision =
  | 'HARD_BLOCK'
  | 'PASS'
  | 'WATCH'
  | 'CONFIRMATION_ENTRY'
  | 'ENTER';

export interface DecisionCard {
  tokenMint: string;
  symbol: string;
  timestamp: number;
  scores: ScoreSet;
  rugProbability: number;
  expectedRoundTripCostPct: number;
  decision: Decision;
  reason: string;
  suggestedSizeUsd: number;
  freshness: Freshness;
}

export interface Signal {
  id: string;
  tokenMint: string;
  timestamp: number;
  features: Record<string, number>;
  scores: ScoreSet;
  decision: Decision;
  modelVersion: string;
}

export type AlertKind =
  | 'early-momentum'
  | 'smart-money'
  | 'top-trader-consensus'
  | 'narrative-breakout'
  | 'narrative-divergence'
  | 'whale-exit'
  | 'distribution'
  | 'liquidity-shock'
  | 'security-change'
  | 'execution-risk'
  | 'model-confidence-drop';

export interface Alert {
  id: string;
  kind: AlertKind;
  tokenMint: string;
  symbol: string;
  timestamp: number;
  rank: number;
  severity: RiskSeverity;
  title: string;
  explanation: string;
  evidence: Record<string, number | string | boolean>;
}

// ---------------------------------------------------------------------------
// Execution & portfolio
// ---------------------------------------------------------------------------

export interface Quote {
  route: string;
  provider: string;
  inputUsd: number;
  expectedOutputUsd: number;
  expectedImpactPct: number;
  worstCaseImpactPct: number;
  estimatedFeeUsd: number;
  priorityFeeUsd: number;
  simulatedSuccessProbability: number;
  latencyMs: number;
  quotedAt: number;
}

export type OrderStatus = 'requested' | 'quoted' | 'simulated' | 'submitted' | 'filled' | 'failed' | 'rejected';

export interface Order {
  id: string;
  tokenMint: string;
  side: TradeSide;
  sizeUsd: number;
  status: OrderStatus;
  mode: 'paper' | 'live';
  quote?: Quote;
  filledPriceUsd?: number;
  filledUsd?: number;
  slippagePct?: number;
  createdAt: number;
  updatedAt: number;
  rejectReason?: string;
}

export interface ExecutionEvent {
  id: string;
  orderId: string;
  kind: 'quote' | 'simulation' | 'submit' | 'confirm' | 'fail' | 'kill-switch';
  timestamp: number;
  detail: Record<string, unknown>;
}

export interface Outcome {
  signalId: string;
  tokenMint: string;
  decisionAt: number;
  forwardReturns: Record<'15m' | '1h' | '4h' | '24h', number | null>;
  maxForwardReturn: number;
  maxDrawdown: number;
  reached2x: boolean;
  reached5x: boolean;
  rugged: boolean;
  timeToTargetMs: number | null;
  realizedPnlPct: number | null;
}

export interface PortfolioLimits {
  maxRiskPerTradePct: number;
  maxExposurePerTokenPct: number;
  maxExposurePerNarrativePct: number;
  maxCorrelatedExposurePct: number;
  dailyLossLimitPct: number;
  weeklyDrawdownLimitPct: number;
  maxSimultaneousHighRisk: number;
  minReservePct: number;
}
