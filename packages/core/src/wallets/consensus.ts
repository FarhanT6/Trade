import type { LeaderboardWindow, Narrative, Position, Token, TraderProfile, WalletCluster } from '../types.js';
import { MS, clamp, groupBy, median, ratio, unique } from '../util/stats.js';

export interface CohortInput {
  window: LeaderboardWindow;
  /** Top-N trader profiles for the window (already ranked by risk-adjusted skill). */
  cohort: TraderProfile[];
  positions: Position[];
  tokens: Map<string, Token>;
  clusters: WalletCluster[];
  clusterOf: Map<string, string>;
  narratives?: Narrative[];
  now: number;
  /** Price series lookup for "what changed before exits" analysis (optional). */
  volumeAt?: (mint: string, ts: number) => number;
}

export interface CommonToken {
  tokenMint: string;
  symbol: string;
  traders: string[];
  independentClusters: number;
  /** Consensus-without-correlation score 0..100. */
  consensusScore: number;
  medianEntryMcapUsd: number;
  medianEntryAgeMs: number;
  medianHoldMs: number;
  firstEntry: { wallet: string; at: number };
  leadLagMs: number[];
}

export interface CohortAnalysis {
  window: LeaderboardWindow;
  size: number;
  commonTokens: CommonToken[];
  commonEntryZone: { medianMcapUsd: number; medianLiquidityRatio: number; medianAgeMs: number };
  commonHoldTime: { medianMs: number; p25Ms: number; p75Ms: number };
  commonNarratives: Array<{ narrative: string; count: number }>;
  commonChains: Array<{ chain: string; share: number }>;
  commonLaunchTypes: Array<{ launchType: string; share: number }>;
  walletBehavior: { scaledIn: number; partialExits: number; rapidFlips: number };
  commonExitSignal: { medianVolumeDecayBeforeExit: number | null };
  traderOverlap: Array<{ a: string; b: string; sharedTokens: number }>;
  leaders: Array<{ wallet: string; firstMoverRate: number }>;
  independentClusters: number;
  repeatedAcrossWindows?: string[];
}

/**
 * Consensus Without Correlation (spec §17): weight independent clusters, not raw wallet count.
 * 12 wallets with 9 sharing a funding ancestor ≈ 4 independent voices, further discounted by
 * each cluster's same-entity likelihood.
 */
export function consensusWithoutCorrelation(wallets: string[], clusterOf: Map<string, string>, clusters: WalletCluster[]): { independent: number; score: number } {
  const byCluster = groupBy(wallets, (w) => clusterOf.get(w) ?? w);
  const clusterMap = new Map(clusters.map((c) => [c.id, c]));
  let effective = 0;
  for (const [cid, ws] of byCluster) {
    const c = clusterMap.get(cid);
    const same = c?.sameEntityScore ?? 0;
    // One fully independent voice + a diminishing share for extra members depending on how likely they are one entity.
    effective += 1 + (ws.length - 1) * (1 - same) * 0.25;
  }
  // Score saturates around 6 independent voices.
  const score = 100 * (1 - Math.exp(-effective / 3));
  return { independent: byCluster.size, score: clamp(score, 0, 100) };
}

export function analyzeCohort(input: CohortInput): CohortAnalysis {
  const cohortWallets = new Set(input.cohort.map((p) => p.wallet));
  const pos = input.positions.filter((p) => cohortWallets.has(p.wallet));
  const byToken = groupBy(pos, (p) => p.tokenMint);

  const commonTokens: CommonToken[] = [];
  for (const [mint, ps] of byToken) {
    const traders = unique(ps.map((p) => p.wallet));
    if (traders.length < 2) continue;
    const token = input.tokens.get(mint);
    const cwc = consensusWithoutCorrelation(traders, input.clusterOf, input.clusters);
    const sorted = [...ps].sort((a, b) => a.openedAt - b.openedAt);
    const first = sorted[0];
    commonTokens.push({
      tokenMint: mint,
      symbol: token?.symbol ?? mint.slice(0, 6),
      traders,
      independentClusters: cwc.independent,
      consensusScore: cwc.score,
      medianEntryMcapUsd: median(ps.map((p) => p.entryPriceUsd * (token?.totalSupply ?? 0))),
      medianEntryAgeMs: median(ps.map((p) => p.openedAt - (token?.createdAt ?? p.openedAt))),
      medianHoldMs: median(ps.map((p) => p.holdMs ?? input.now - p.openedAt)),
      firstEntry: { wallet: first.wallet, at: first.openedAt },
      leadLagMs: sorted.map((p) => p.openedAt - first.openedAt),
    });
  }
  commonTokens.sort((a, b) => b.consensusScore - a.consensusScore);

  const mcaps = pos.map((p) => p.entryPriceUsd * (input.tokens.get(p.tokenMint)?.totalSupply ?? 0));
  const holds = pos.map((p) => p.holdMs ?? input.now - p.openedAt).sort((a, b) => a - b);
  const q = (arr: number[], f: number) => (arr.length ? arr[Math.min(arr.length - 1, Math.floor(arr.length * f))] : 0);

  const narrativeCounts = new Map<string, number>();
  for (const n of input.narratives ?? []) {
    const hits = n.tokenMints.filter((m) => byToken.has(m)).length;
    if (hits > 0) narrativeCounts.set(n.label, hits);
  }
  const chainCounts = groupBy(pos, (p) => input.tokens.get(p.tokenMint)?.chain ?? 'unknown');
  const launchCounts = groupBy(pos, (p) => input.tokens.get(p.tokenMint)?.launchType ?? 'unknown');

  // Wallet behavior heuristics from position shape.
  const rapidFlips = ratio(pos.filter((p) => (p.holdMs ?? Infinity) < 10 * MS.m).length, pos.length);
  const partialExits = ratio(pos.filter((p) => p.closedAt === null && p.realizedPnlUsd !== 0).length, pos.length);
  const scaledIn = ratio(pos.filter((p) => p.sizeToLiquidity > 0.02).length, pos.length);

  // Exit signal: volume at exit vs 15m before.
  let decays: number[] = [];
  if (input.volumeAt) {
    for (const p of pos) {
      if (p.closedAt === null) continue;
      const before = input.volumeAt(p.tokenMint, p.closedAt - 15 * MS.m);
      const at = input.volumeAt(p.tokenMint, p.closedAt);
      if (before > 0) decays.push(at / before);
    }
  }

  // Trader overlap and lead/lag.
  const overlap: CohortAnalysis['traderOverlap'] = [];
  const wallets = [...cohortWallets];
  const tokensOf = new Map(wallets.map((w) => [w, new Set(pos.filter((p) => p.wallet === w).map((p) => p.tokenMint))]));
  for (let i = 0; i < wallets.length; i++) {
    for (let j = i + 1; j < wallets.length; j++) {
      const a = tokensOf.get(wallets[i])!;
      const b = tokensOf.get(wallets[j])!;
      const shared = [...a].filter((m) => b.has(m)).length;
      if (shared >= 2) overlap.push({ a: wallets[i], b: wallets[j], sharedTokens: shared });
    }
  }
  overlap.sort((x, y) => y.sharedTokens - x.sharedTokens);
  const firstMoves = new Map<string, number>();
  for (const ct of commonTokens) firstMoves.set(ct.firstEntry.wallet, (firstMoves.get(ct.firstEntry.wallet) ?? 0) + 1);
  const leaders = wallets
    .map((w) => ({ wallet: w, firstMoverRate: ratio(firstMoves.get(w) ?? 0, commonTokens.filter((c) => c.traders.includes(w)).length) }))
    .filter((l) => !Number.isNaN(l.firstMoverRate))
    .sort((a, b) => b.firstMoverRate - a.firstMoverRate);

  const independentClusters = unique(wallets.map((w) => input.clusterOf.get(w) ?? w)).length;

  return {
    window: input.window,
    size: input.cohort.length,
    commonTokens,
    commonEntryZone: {
      medianMcapUsd: median(mcaps),
      medianLiquidityRatio: median(pos.map((p) => p.sizeToLiquidity)),
      medianAgeMs: median(pos.map((p) => p.openedAt - (input.tokens.get(p.tokenMint)?.createdAt ?? p.openedAt))),
    },
    commonHoldTime: { medianMs: median(holds), p25Ms: q(holds, 0.25), p75Ms: q(holds, 0.75) },
    commonNarratives: [...narrativeCounts].map(([narrative, count]) => ({ narrative, count })).sort((a, b) => b.count - a.count),
    commonChains: [...chainCounts].map(([chain, ps]) => ({ chain, share: ratio(ps.length, pos.length) })),
    commonLaunchTypes: [...launchCounts].map(([launchType, ps]) => ({ launchType, share: ratio(ps.length, pos.length) })),
    walletBehavior: { scaledIn, partialExits, rapidFlips },
    commonExitSignal: { medianVolumeDecayBeforeExit: decays.length ? median(decays) : null },
    traderOverlap: overlap.slice(0, 20),
    leaders: leaders.slice(0, 20),
    independentClusters,
  };
}

/** Wallets that appear in the top-N of more than one window (repeatability). */
export function repeatedAcrossWindows(topByWindow: Record<LeaderboardWindow, TraderProfile[]>): Array<{ wallet: string; windows: LeaderboardWindow[] }> {
  const m = new Map<string, LeaderboardWindow[]>();
  for (const [w, profiles] of Object.entries(topByWindow) as Array<[LeaderboardWindow, TraderProfile[]]>) {
    for (const p of profiles) m.set(p.wallet, [...(m.get(p.wallet) ?? []), w]);
  }
  return [...m].filter(([, ws]) => ws.length > 1).map(([wallet, windows]) => ({ wallet, windows })).sort((a, b) => b.windows.length - a.windows.length);
}

/** Rank traders by risk-adjusted skill, never by raw PnL alone (spec §3.1). */
export function rankTraders(profiles: TraderProfile[], minSample = 5): TraderProfile[] {
  return [...profiles]
    .filter((p) => p.sampleSize >= minSample && p.archetype !== 'insider-cluster')
    .sort((a, b) => b.riskAdjustedSkill - a.riskAdjustedSkill || b.realizedPnlUsd - a.realizedPnlUsd);
}
