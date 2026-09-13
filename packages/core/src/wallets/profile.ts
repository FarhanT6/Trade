import type { LeaderboardWindow, MarketRegime, Position, Token, TraderProfile } from '../types.js';
import { MS, clamp, mean, median, quantile, ratio, sigmoid } from '../util/stats.js';
import { classifyArchetype } from './archetype.js';

export const WINDOW_MS: Record<LeaderboardWindow, number> = {
  '24h': MS.d,
  '7d': 7 * MS.d,
  '30d': 30 * MS.d,
  '90d': 90 * MS.d,
  all: Number.POSITIVE_INFINITY,
};

export interface ProfileContext {
  now: number;
  tokens: Map<string, Token>;
  /** Risk per trade used for R multiples; default = entry size * 0.5 (meme-coin realistic stop). */
  riskFraction?: number;
  /** Mark-to-market for open positions; when provided, unrealized PnL counts toward skill (bags are not free). */
  priceAt?: (mint: string, ts: number) => number;
  clusterLabel?: (wallet: string) => 'insider-cluster' | 'market-maker' | null;
}

/**
 * Max drawdown of the cumulative PnL curve. `capitalBase` (e.g. typical deployed capital)
 * floors the denominator so a trader whose peak is tiny is not shown with a 600% drawdown.
 */
export function drawdownStats(pnls: number[], capitalBase = 0): { maxDrawdownPct: number; recoveryTimeIdx: number | null } {
  let equity = 0;
  let peak = 0;
  let maxDd = 0;
  let ddStart = -1;
  let recovery: number | null = null;
  let worstDdStart = -1;
  for (let i = 0; i < pnls.length; i++) {
    equity += pnls[i];
    if (equity >= peak) {
      if (ddStart >= 0 && worstDdStart === ddStart) recovery = i - ddStart;
      peak = equity;
      ddStart = -1;
    } else {
      if (ddStart < 0) ddStart = i;
      const base = Math.max(peak, capitalBase);
      const dd = base > 0 ? Math.min(1, (peak - equity) / base) : equity < 0 ? 1 : 0;
      if (dd > maxDd) {
        maxDd = dd;
        worstDdStart = ddStart;
        recovery = null;
      }
    }
  }
  return { maxDrawdownPct: maxDd * 100, recoveryTimeIdx: recovery };
}

function tokenCategory(token: Token | undefined, p: Position): string[] {
  const cats: string[] = [];
  if (token) {
    cats.push(`chain:${token.chain}`);
    cats.push(`launch:${token.launchType}`);
    const ageH = (p.openedAt - token.createdAt) / MS.h;
    cats.push(`age:${ageH < 1 ? '<1h' : ageH < 24 ? '<1d' : ageH < 168 ? '<1w' : '>1w'}`);
  }
  const mc = p.entryPriceUsd * (token?.totalSupply ?? 0);
  cats.push(`mcap:${mc < 100_000 ? '<100k' : mc < 1_000_000 ? '<1m' : mc < 10_000_000 ? '<10m' : '>10m'}`);
  return cats;
}

export function buildTraderProfile(
  wallet: string,
  positions: Position[],
  window: LeaderboardWindow,
  ctx: ProfileContext,
): TraderProfile {
  const since = ctx.now - WINDOW_MS[window];
  const mine = positions
    .filter((p) => p.wallet === wallet && p.openedAt >= since)
    .sort((a, b) => a.openedAt - b.openedAt);
  const closed = mine.filter((p) => p.closedAt !== null);
  const open = mine.filter((p) => p.closedAt === null);
  const unrealized = ctx.priceAt
    ? open.map((p) => {
        const px = ctx.priceAt!(p.tokenMint, ctx.now);
        return px > 0 ? p.quantity * px - p.sizeUsd + p.realizedPnlUsd : 0;
      })
    : [];
  const unrealizedPnlUsd = unrealized.reduce((s, x) => s + x, 0);
  // Bags: open positions marked down >50% count against win rate (losses that were never taken).
  const bagCount = ctx.priceAt ? open.filter((p) => { const px = ctx.priceAt!(p.tokenMint, ctx.now); return px > 0 && px < 0.5 * p.entryPriceUsd; }).length : 0;
  const pnls = closed.map((p) => p.realizedPnlUsd);
  const wins = pnls.filter((x) => x > 0);
  const losses = pnls.filter((x) => x < 0);
  const grossProfit = wins.reduce((s, x) => s + x, 0) + unrealized.filter((x) => x > 0).reduce((s, x) => s + x, 0);
  const grossLoss = -losses.reduce((s, x) => s + x, 0) - unrealized.filter((x) => x < 0).reduce((s, x) => s + x, 0);
  const riskFraction = ctx.riskFraction ?? 0.5;
  const rs = closed.map((p) => (p.sizeUsd > 0 ? p.realizedPnlUsd / (p.sizeUsd * riskFraction) : 0));
  const sizesClosed = closed.map((p) => p.sizeUsd);
  const dd = drawdownStats(pnls, median(sizesClosed) * 5);
  const holdTimes = closed.map((p) => p.holdMs ?? 0);

  const regimeConsistency: Record<MarketRegime, number | null> = { bull: null, neutral: null, bear: null, 'meme-mania': null };
  for (const regime of Object.keys(regimeConsistency) as MarketRegime[]) {
    const rp = closed.filter((p) => p.regime === regime);
    regimeConsistency[regime] = rp.length >= 3 ? ratio(rp.filter((p) => p.realizedPnlUsd > 0).length, rp.length) : null;
  }

  const categoryPerformance: TraderProfile['categoryPerformance'] = {};
  for (const p of closed) {
    for (const c of tokenCategory(ctx.tokens.get(p.tokenMint), p)) {
      const e = (categoryPerformance[c] ??= { trades: 0, pnlUsd: 0, winRate: 0 });
      e.trades += 1;
      e.pnlUsd += p.realizedPnlUsd;
      e.winRate += p.realizedPnlUsd > 0 ? 1 : 0;
    }
  }
  for (const c of Object.keys(categoryPerformance)) categoryPerformance[c].winRate /= categoryPerformance[c].trades;

  const exitQ = closed.map((p) => p.exitQuality).filter((x): x is number => x !== null);
  const winRate = ratio(wins.length, closed.length + bagCount);
  const profitFactor = grossLoss === 0 ? (grossProfit > 0 ? 10 : 0) : Math.min(10, grossProfit / grossLoss);

  // Survivability: does performance persist? Compare first-half vs second-half PnL sign & win rate.
  let survivability = 0;
  if (closed.length >= 6) {
    const half = Math.floor(closed.length / 2);
    const a = closed.slice(0, half);
    const b = closed.slice(half);
    const wa = ratio(a.filter((p) => p.realizedPnlUsd > 0).length, a.length);
    const wb = ratio(b.filter((p) => p.realizedPnlUsd > 0).length, b.length);
    const pa = a.reduce((s, p) => s + p.realizedPnlUsd, 0);
    const pb = b.reduce((s, p) => s + p.realizedPnlUsd, 0);
    survivability = clamp(0.5 * (1 - Math.abs(wa - wb)) + 0.5 * (pa > 0 && pb > 0 ? 1 : pa > 0 || pb > 0 ? 0.4 : 0), 0, 1);
  }

  const rugExposure = ratio(mine.filter((p) => p.tokenRugged).length, mine.length);
  const sampleFactor = sigmoid(closed.length, 6, 0.5); // ~0.5 at 6 trades, ~0.95 at 12+
  const regimeValues = Object.values(regimeConsistency).filter((x): x is number => x !== null);
  const regimeDependence = regimeValues.length >= 2 ? Math.max(...regimeValues) - Math.min(...regimeValues) : 0.5;
  const avgR = mean(rs);
  const deployed = mine.reduce((s, p) => s + p.sizeUsd, 0);
  const returnOnCapital = deployed > 0 ? (pnls.reduce((s, x) => s + x, 0) + unrealizedPnlUsd) / deployed : 0;
  // Risk-adjusted skill in 0..100: edge per unit risk, consistency, survivability and
  // regime independence, discounted by sample size and rug exposure (never raw PnL alone).
  const riskAdjustedSkill =
    100 *
    clamp(
      sampleFactor *
        (0.25 * clamp(avgR / 1.5, -1, 1) +
          0.15 * clamp(profitFactor / 3, 0, 1) +
          0.15 * winRate +
          0.15 * clamp(returnOnCapital, -1, 1) +
          0.1 * (1 - clamp(dd.maxDrawdownPct / 100, 0, 1)) +
          0.1 * survivability +
          0.1 * (1 - regimeDependence)) *
        (1 - 0.5 * rugExposure),
      0,
      1,
    );

  const sizes = mine.map((p) => p.sizeUsd);
  const base: Omit<TraderProfile, 'archetype' | 'archetypeConfidence'> = {
    wallet,
    window,
    realizedPnlUsd: pnls.reduce((s, x) => s + x, 0),
    unrealizedPnlUsd,
    winRate,
    profitFactor,
    averageR: avgR,
    medianHoldMs: median(holdTimes),
    medianEntryLatencyMs: median(mine.map((p) => p.entryLatencyMs)),
    positionSizing: {
      avgUsd: mean(sizes),
      medianUsd: median(sizes),
      maxUsd: sizes.length ? Math.max(...sizes) : 0,
      medianSizeToLiquidity: median(mine.map((p) => p.sizeToLiquidity)),
    },
    maxDrawdownPct: dd.maxDrawdownPct,
    recoveryTimeMs:
      dd.recoveryTimeIdx !== null && closed.length > dd.recoveryTimeIdx
        ? (closed[Math.min(closed.length - 1, dd.recoveryTimeIdx)].closedAt ?? 0) - (closed[0].openedAt ?? 0)
        : null,
    regimeConsistency,
    categoryPerformance,
    rugExposure,
    exitQuality: exitQ.length ? mean(exitQ) : 0,
    survivability,
    sampleSize: closed.length,
    riskAdjustedSkill,
  };
  const arch = classifyArchetype(mine, base, ctx.clusterLabel?.(wallet) ?? null);
  return { ...base, archetype: arch.archetype, archetypeConfidence: arch.confidence };
}

/** Quantile of hold time for tests/reporting. */
export const holdQuantile = quantile;
