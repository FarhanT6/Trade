import type {
  DeployerHistory,
  Freshness,
  HolderSnapshot,
  LiquidityEvent,
  MarketFeatures,
  Pool,
  Quote,
  RiskAssessment,
  RiskFinding,
  SocialVelocity,
  TokenSecurity,
  WalletCluster,
} from '../types.js';
import { MS, clamp } from '../util/stats.js';

export interface RiskInput {
  tokenMint: string;
  now: number;
  security: TokenSecurity | null;
  pool: Pool | null;
  holders: HolderSnapshot | null;
  deployer: DeployerHistory | null;
  liquidityEvents: LiquidityEvent[];
  market: MarketFeatures | null;
  /** Clusters that include holders of this token. */
  clusters: WalletCluster[];
  social?: SocialVelocity | null;
  /** Result of the execution engine's sell-route probe. */
  sellQuote: Quote | null;
  /** Data considered stale after this many ms (default 60s during fast events). */
  maxStalenessMs?: number;
  /** Set when the token is currently in a fast-moving event (volume accel > 3x). */
  fastMoving?: boolean;
}

const DANGEROUS_EXTENSIONS = new Set(['permanentDelegate', 'defaultAccountState', 'transferHook', 'confidentialTransfer', 'nonTransferable']);

function stale(f: Freshness | undefined, now: number, max: number): boolean {
  return !f || now - f.asOf > max || f.confidence < 0.3;
}

/** Token and rug-risk engine (spec §6) with hard-block rules (§6.1). */
export function assessTokenRisk(input: RiskInput): RiskAssessment {
  const f: RiskFinding[] = [];
  const now = input.now;
  const maxStale = input.maxStalenessMs ?? (input.fastMoving ? 60 * MS.s : 5 * MS.m);
  const add = (family: RiskFinding['family'], severity: RiskFinding['severity'], code: string, message: string, hardBlock = false) =>
    f.push({ family, severity, code, message, hardBlock });

  // --- Data quality / freshness (hard blocks: stale or unavailable during fast events) ---
  if (!input.security) add('data-quality', 'critical', 'SECURITY_UNAVAILABLE', 'Token security data unavailable', true);
  else if (stale(input.security.freshness, now, 30 * MS.m)) add('data-quality', 'high', 'SECURITY_STALE', 'Token security data is stale', input.fastMoving === true);
  if (!input.pool) add('data-quality', 'critical', 'POOL_UNAVAILABLE', 'No pool/liquidity data', true);
  else if (stale(input.pool.freshness, now, maxStale)) add('data-quality', 'critical', 'POOL_STALE', 'Liquidity data is stale', true);
  if (!input.holders) add('data-quality', 'medium', 'HOLDERS_UNAVAILABLE', 'Holder distribution unavailable', input.fastMoving === true);
  else if (stale(input.holders.freshness, now, 15 * MS.m)) add('data-quality', 'medium', 'HOLDERS_STALE', 'Holder snapshot stale');
  if (input.market && input.pool && Math.abs(input.market.liquidityUsd - input.pool.liquidityUsd) / Math.max(1, input.pool.liquidityUsd) > 0.5)
    add('data-quality', 'critical', 'FEEDS_CONFLICT', 'Market feed and pool state disagree on liquidity by >50%', true);

  // --- Authorities ---
  const s = input.security;
  if (s) {
    if (s.mintAuthority) add('authorities', 'critical', 'MINT_AUTHORITY', `Mint authority active (${s.mintAuthority.slice(0, 6)}…): supply can be inflated`, true);
    if (s.freezeAuthority) add('authorities', 'critical', 'FREEZE_AUTHORITY', 'Freeze authority active: holders can be frozen', true);
    if (s.metadataMutable) add('authorities', 'low', 'METADATA_MUTABLE', 'Metadata is mutable (impersonation/rebrand risk)');
    // --- Token-2022 ---
    for (const ext of s.token2022Extensions) {
      if (DANGEROUS_EXTENSIONS.has(ext)) add('token-2022', 'critical', `EXT_${ext.toUpperCase()}`, `Token-2022 extension ${ext} can block or seize transfers`, true);
      else if (ext === 'transferFee') {
        const bps = s.transferFeeBps ?? 0;
        if (bps > 500) add('token-2022', 'critical', 'TRANSFER_FEE_HIGH', `Transfer fee ${bps / 100}%`, true);
        else if (bps > 0) add('token-2022', 'medium', 'TRANSFER_FEE', `Transfer fee ${bps / 100}%`);
      } else add('token-2022', 'low', `EXT_${ext.toUpperCase()}`, `Token-2022 extension present: ${ext}`);
    }
    if (s.permanentDelegate) add('contract-behavior', 'critical', 'PERMANENT_DELEGATE', 'Permanent delegate can move any holder balance', true);
    if (s.defaultAccountStateFrozen) add('contract-behavior', 'critical', 'DEFAULT_FROZEN', 'New accounts frozen by default', true);
  }

  // --- Liquidity ---
  const p = input.pool;
  if (p) {
    if (p.liquidityUsd < 5_000) add('liquidity', 'high', 'LIQ_TINY', `Liquidity $${p.liquidityUsd.toFixed(0)} is too thin`);
    else if (p.liquidityUsd < 25_000) add('liquidity', 'medium', 'LIQ_LOW', 'Liquidity below $25k');
    if (p.lpLockedPct < 0.5) add('liquidity', 'high', 'LP_UNLOCKED', `Only ${(p.lpLockedPct * 100).toFixed(0)}% of LP locked/burned`);
    const recentRemovals = input.liquidityEvents.filter((e) => e.kind === 'remove' && now - e.timestamp < MS.h).reduce((a, e) => a + e.amountUsd, 0);
    if (recentRemovals > 0.3 * (p.liquidityUsd + recentRemovals)) add('liquidity', 'critical', 'LIQ_WITHDRAWAL', 'Extreme liquidity withdrawal in the last hour', true);
    else if (recentRemovals > 0.1 * (p.liquidityUsd + recentRemovals)) add('liquidity', 'high', 'LIQ_REMOVALS', 'Material liquidity removals in the last hour');
    if (input.deployer && p.lpOwner === input.deployer.deployer && p.lpLockedPct < 0.9) add('liquidity', 'high', 'LP_DEPLOYER_CONTROL', 'Deployer controls unlocked LP');
  }

  // --- Holders ---
  const h = input.holders;
  if (h) {
    const top10 = h.top.slice(0, 10).reduce((a, x) => a + x.pct, 0);
    const top20 = h.top.slice(0, 20).reduce((a, x) => a + x.pct, 0);
    if (top10 > 0.5) add('holders', 'critical', 'TOP10_CONC', `Top-10 holders own ${(top10 * 100).toFixed(0)}%`);
    else if (top10 > 0.3) add('holders', 'high', 'TOP10_CONC', `Top-10 holders own ${(top10 * 100).toFixed(0)}%`);
    else if (top20 > 0.4) add('holders', 'medium', 'TOP20_CONC', `Top-20 holders own ${(top20 * 100).toFixed(0)}%`);
    if (h.deployerPct > 0.1) add('holders', 'high', 'DEPLOYER_BAG', `Deployer holds ${(h.deployerPct * 100).toFixed(1)}%`);
    // Related wallets: sum holdings by cluster.
    const clusterPct = new Map<string, number>();
    for (const c of input.clusters) {
      const pct = h.top.filter((t) => c.wallets.includes(t.wallet)).reduce((a, t) => a + t.pct, 0);
      if (pct > 0 && c.wallets.length > 1) clusterPct.set(c.id, pct * (0.5 + 0.5 * c.sameEntityScore));
    }
    const maxCluster = Math.max(0, ...clusterPct.values());
    if (maxCluster > 0.25) add('holders', 'high', 'CLUSTER_HOLDINGS', `One wallet cluster controls ~${(maxCluster * 100).toFixed(0)}% of supply`);
    if (h.holderCount < 50) add('holders', 'medium', 'FEW_HOLDERS', `Only ${h.holderCount} holders`);
  }

  // --- Deployer ---
  const d = input.deployer;
  if (d) {
    if (d.knownMaliciousClusterMatch) add('deployer', 'critical', 'MALICIOUS_CLUSTER', 'Deployer matches a known malicious cluster', true);
    const rugRate = d.launches > 0 ? d.ruggedLaunches / d.launches : 0;
    if (d.launches >= 2 && rugRate >= 0.5) add('deployer', 'critical', 'SERIAL_RUGGER', `${d.ruggedLaunches}/${d.launches} previous launches rugged`, rugRate >= 0.75);
    else if (d.ruggedLaunches > 0) add('deployer', 'high', 'PRIOR_RUG', `${d.ruggedLaunches} prior rug(s)`);
    if (d.launches > 10) add('deployer', 'medium', 'SERIAL_DEPLOYER', `${d.launches} prior launches`);
  }

  // --- Trading integrity ---
  const m = input.market;
  if (m) {
    const wash = m.volumeQuality.suspectedWashRatio;
    if (wash > 0.6) add('trading-integrity', 'critical', 'WASH_VOLUME', `~${(wash * 100).toFixed(0)}% of volume looks non-economic`);
    else if (wash > 0.3) add('trading-integrity', 'high', 'WASH_VOLUME', `~${(wash * 100).toFixed(0)}% of volume looks non-economic`);
    if (m.intervals['1h'].trades > 50 && m.volumeQuality.uniqueTraders < 8) add('trading-integrity', 'high', 'BOT_CLUSTER', 'Volume concentrated in very few wallets');
  }

  // --- Sellability ---
  const q = input.sellQuote;
  if (!q) add('sellability', 'critical', 'NO_SELL_ROUTE', 'Cannot reliably estimate a sell route', true);
  else {
    if (q.simulatedSuccessProbability < 0.8) add('sellability', 'critical', 'SELL_SIM_FAIL', `Sell simulation success ${(q.simulatedSuccessProbability * 100).toFixed(0)}%`, q.simulatedSuccessProbability < 0.6);
    if (q.expectedImpactPct > 15) add('sellability', 'high', 'SELL_IMPACT', `Expected sell impact ${q.expectedImpactPct.toFixed(1)}%`);
    else if (q.expectedImpactPct > 5) add('sellability', 'medium', 'SELL_IMPACT', `Expected sell impact ${q.expectedImpactPct.toFixed(1)}%`);
    const roundTrip = q.expectedOutputUsd / Math.max(1, q.inputUsd);
    if (roundTrip < 0.5) add('contract-behavior', 'critical', 'HONEYPOT_LIKE', 'Sell returns <50% of value: honeypot-like tax/restriction', true);
  }

  // --- Social risk ---
  const so = input.social;
  if (so) {
    if (so.botLikelihood > 0.6) add('social-risk', 'high', 'FAKE_ENGAGEMENT', `Bot-like amplification (${(so.botLikelihood * 100).toFixed(0)}%)`);
    if (so.newAccountShare > 0.5) add('social-risk', 'medium', 'NEW_ACCOUNTS', 'Majority of mentions from new accounts');
  }

  // --- Aggregate ---
  const weight: Record<RiskFinding['severity'], number> = { info: 0, low: 3, medium: 8, high: 18, critical: 35 };
  const securityFamilies = new Set(['authorities', 'token-2022', 'liquidity', 'holders', 'deployer', 'contract-behavior', 'sellability', 'data-quality']);
  const manipFamilies = new Set(['trading-integrity', 'social-risk', 'holders']);
  let secPenalty = 0;
  let manip = 0;
  for (const x of f) {
    if (securityFamilies.has(x.family)) secPenalty += weight[x.severity];
    if (manipFamilies.has(x.family)) manip += weight[x.severity];
  }
  const hard = f.filter((x) => x.hardBlock);
  const securityScore = hard.length ? Math.min(10, clamp(100 - secPenalty, 0, 100)) : clamp(100 - secPenalty, 0, 100);
  const manipulationScore = clamp(manip * 1.5 + (m ? m.volumeQuality.suspectedWashRatio * 40 : 0), 0, 100);
  // Rug probability: logistic over penalty mass, with hard-blocks dominating.
  const rugProbability = hard.length ? clamp(0.6 + 0.1 * hard.length, 0, 0.99) : clamp(1 / (1 + Math.exp(-(secPenalty - 45) / 12)), 0.01, 0.6);
  return {
    tokenMint: input.tokenMint,
    timestamp: now,
    findings: f,
    securityScore,
    manipulationScore,
    hardBlocked: hard.length > 0,
    hardBlockReasons: hard.map((x) => x.code),
    rugProbability,
  };
}
