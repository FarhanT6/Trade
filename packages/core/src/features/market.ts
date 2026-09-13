import type {
  Freshness,
  Interval,
  IntervalStats,
  MarketFeatures,
  Pool,
  Token,
  Trade,
  VolumeQuality,
} from '../types.js';
import { INTERVAL_MS, acceleration, clamp, groupBy, mean, median, ratio, stddev, unique } from '../util/stats.js';

export const INTERVALS: Interval[] = ['1m', '5m', '15m', '1h'];

export interface MarketFeatureInput {
  token: Token;
  pool: Pool;
  /** Trades for this token, any order; only the last ~2h are needed. */
  trades: Trade[];
  /** Wallet -> funding ancestor (from the wallet graph). Optional. */
  fundingAncestor?: Map<string, string>;
  now: number;
  priceUsd: number;
  freshness?: Freshness;
  /** Highest price over a longer lookback (e.g. 12h from the price store); defaults to the trade window's high. */
  recentHighUsd?: number;
}

function intervalStats(trades: Trade[], from: number, to: number, priceAtFrom: number, priceAtTo: number): IntervalStats {
  const w = trades.filter((t) => t.timestamp >= from && t.timestamp < to);
  const buys = w.filter((t) => t.side === 'buy');
  const sells = w.filter((t) => t.side === 'sell');
  return {
    volumeUsd: w.reduce((s, t) => s + t.amountUsd, 0),
    buyVolumeUsd: buys.reduce((s, t) => s + t.amountUsd, 0),
    sellVolumeUsd: sells.reduce((s, t) => s + t.amountUsd, 0),
    trades: w.length,
    uniqueBuyers: unique(buys.map((t) => t.wallet)).length,
    uniqueSellers: unique(sells.map((t) => t.wallet)).length,
    priceChangePct: priceAtFrom > 0 ? ((priceAtTo - priceAtFrom) / priceAtFrom) * 100 : 0,
  };
}

function priceAt(trades: Trade[], ts: number, fallback: number): number {
  let best: Trade | undefined;
  for (const t of trades) {
    if (t.timestamp <= ts && (!best || t.timestamp > best.timestamp)) best = t;
  }
  return best ? best.priceUsd : fallback;
}

/**
 * Constant-product price impact for a buy of `sizeUsd` against the pool.
 * impact = 1 - (k / (x + dx)) / x ... simplified: dx / (x + dx) for the quote side.
 */
export function constantProductImpactPct(quoteReserveUsd: number, sizeUsd: number): number {
  if (quoteReserveUsd <= 0) return 100;
  return clamp((sizeUsd / (quoteReserveUsd + sizeUsd)) * 100, 0, 100);
}

/** Size in USD that would move price by `pct` percent (inverse of the above). */
export function depthForImpact(quoteReserveUsd: number, pct: number): number {
  const f = pct / 100;
  return (f * quoteReserveUsd) / (1 - f);
}

/**
 * Real Volume Quality (spec §7.1):
 * reported volume -> unique traders, repeated wallet loops, shared funding,
 * trade-size distribution, timing -> economic volume estimate.
 */
export function computeVolumeQuality(trades: Trade[], fundingAncestor?: Map<string, string>): VolumeQuality {
  const reported = trades.reduce((s, t) => s + t.amountUsd, 0);
  if (reported === 0) {
    return {
      reportedVolumeUsd: 0,
      economicVolumeUsd: 0,
      score: 0,
      uniqueTraders: 0,
      repeatedLoopVolumeUsd: 0,
      sharedFundingVolumeUsd: 0,
      suspectedWashRatio: 0,
    };
  }
  const byWallet = groupBy(trades, (t) => t.wallet);
  let loopVolume = 0;
  // A wallet that alternates buy/sell many times within a short window with near-identical
  // sizes is treated as a loop (circular / wash pattern).
  for (const [, ws] of byWallet) {
    const sorted = [...ws].sort((a, b) => a.timestamp - b.timestamp);
    for (let i = 1; i < sorted.length; i++) {
      const a = sorted[i - 1];
      const b = sorted[i];
      const sizeSim = 1 - Math.abs(a.amountUsd - b.amountUsd) / Math.max(a.amountUsd, b.amountUsd, 1);
      if (a.side !== b.side && b.timestamp - a.timestamp < 3 * 60_000 && sizeSim > 0.85) {
        loopVolume += b.amountUsd;
      }
    }
  }
  // Shared funding: counterparties funded by the same ancestor trading each other.
  let sharedFunding = 0;
  if (fundingAncestor) {
    const byAncestor = groupBy(
      trades.filter((t) => fundingAncestor.has(t.wallet)),
      (t) => fundingAncestor.get(t.wallet) as string,
    );
    for (const [, ts] of byAncestor) {
      const buys = ts.filter((t) => t.side === 'buy').reduce((s, t) => s + t.amountUsd, 0);
      const sells = ts.filter((t) => t.side === 'sell').reduce((s, t) => s + t.amountUsd, 0);
      // Balanced two-sided volume inside one funding cluster is economically empty.
      sharedFunding += 2 * Math.min(buys, sells);
    }
  }
  // Trade-size distribution: an unnaturally tight size distribution suggests scripted volume.
  const sizes = trades.map((t) => t.amountUsd);
  const cv = mean(sizes) > 0 ? stddev(sizes) / mean(sizes) : 0;
  const sizePenalty = trades.length >= 10 && cv < 0.15 ? 0.3 : 0;
  // Timing: perfectly regular cadence is scripted.
  const ts = [...trades].sort((a, b) => a.timestamp - b.timestamp).map((t) => t.timestamp);
  const gaps: number[] = [];
  for (let i = 1; i < ts.length; i++) gaps.push(ts[i] - ts[i - 1]);
  const gapCv = gaps.length >= 10 && mean(gaps) > 0 ? stddev(gaps) / mean(gaps) : 1;
  const timingPenalty = gaps.length >= 10 && gapCv < 0.2 ? 0.2 : 0;

  const suspicious = Math.min(reported, loopVolume + sharedFunding);
  let economic = reported - suspicious;
  economic *= 1 - sizePenalty - timingPenalty;
  economic = clamp(economic, 0, reported);
  return {
    reportedVolumeUsd: reported,
    economicVolumeUsd: economic,
    score: ratio(economic, reported),
    uniqueTraders: byWallet.size,
    repeatedLoopVolumeUsd: loopVolume,
    sharedFundingVolumeUsd: sharedFunding,
    suspectedWashRatio: ratio(suspicious, reported),
  };
}

export function computeMarketFeatures(input: MarketFeatureInput): MarketFeatures {
  const { token, pool, trades, now, priceUsd } = input;
  const intervals = {} as Record<Interval, IntervalStats>;
  const prev = {} as Record<Interval, IntervalStats>;
  const volumeAcceleration = {} as Record<Interval, number>;
  for (const iv of INTERVALS) {
    const len = INTERVAL_MS[iv];
    const pStart = priceAt(trades, now - len, priceUsd);
    intervals[iv] = intervalStats(trades, now - len, now, pStart, priceUsd);
    const pPrevStart = priceAt(trades, now - 2 * len, pStart);
    prev[iv] = intervalStats(trades, now - 2 * len, now - len, pPrevStart, pStart);
    volumeAcceleration[iv] = acceleration(intervals[iv].volumeUsd, prev[iv].volumeUsd, 50, 250);
  }
  const lastHour = trades.filter((t) => t.timestamp >= now - INTERVAL_MS['1h'] && t.timestamp < now);
  const sizes = lastHour.map((t) => t.amountUsd);

  // Volatility from 1-minute log returns over the last hour.
  const returns: number[] = [];
  const sorted = [...lastHour].sort((a, b) => a.timestamp - b.timestamp);
  let lastP = priceAt(trades, now - INTERVAL_MS['1h'], priceUsd);
  let bucket = now - INTERVAL_MS['1h'];
  for (let t = bucket + 60_000; t <= now; t += 60_000) {
    const p = priceAt(sorted, t, lastP);
    if (lastP > 0 && p > 0) returns.push(Math.log(p / lastP));
    lastP = p;
  }
  const volatility = stddev(returns) * Math.sqrt(60); // hourly-ish
  const volatilityRegime = volatility < 0.05 ? 'low' : volatility < 0.2 ? 'normal' : volatility < 0.5 ? 'high' : 'extreme';

  const priceAcceleration = acceleration(
    Math.abs(intervals['5m'].priceChangePct) + 1,
    Math.abs(prev['5m'].priceChangePct) + 1,
    10,
  ) * Math.sign(intervals['5m'].priceChangePct || 1);

  let recentHigh = Math.max(priceUsd, input.recentHighUsd ?? 0);
  for (const t of trades) if (t.timestamp <= now && t.priceUsd > recentHigh) recentHigh = t.priceUsd;
  const buyVol = intervals['15m'].buyVolumeUsd;
  const sellVol = intervals['15m'].sellVolumeUsd;
  const marketCapUsd = priceUsd * token.totalSupply;
  const q = pool.quoteReserveUsd;
  const features: MarketFeatures = {
    tokenMint: token.mint,
    timestamp: now,
    priceUsd,
    liquidityUsd: pool.liquidityUsd,
    marketCapUsd,
    tokenAgeMs: now - token.createdAt,
    intervals,
    volumeAcceleration,
    priceAcceleration,
    volatility,
    volatilityRegime,
    buyerAcceleration: acceleration(intervals['5m'].uniqueBuyers, prev['5m'].uniqueBuyers, 50, 3),
    sellerAcceleration: acceleration(intervals['5m'].uniqueSellers, prev['5m'].uniqueSellers, 50, 3),
    avgTradeSizeUsd: mean(sizes),
    medianTradeSizeUsd: median(sizes),
    buySellImbalance: ratio(buyVol - sellVol, buyVol + sellVol),
    liquidityToMcap: ratio(pool.liquidityUsd, marketCapUsd),
    recentHighUsd: recentHigh,
    drawdownFromHigh: recentHigh > 0 ? 1 - priceUsd / recentHigh : 0,
    depthUsd: {
      bid1pct: depthForImpact(q, 1),
      ask1pct: depthForImpact(q, 1),
      bid5pct: depthForImpact(q, 5),
      ask5pct: depthForImpact(q, 5),
    },
    expectedImpactPct: (sizeUsd: number) => constantProductImpactPct(q, sizeUsd),
    volumeQuality: computeVolumeQuality(lastHour, input.fundingAncestor),
    freshness: input.freshness ?? { asOf: now, source: 'chain', confidence: 1 },
  };
  return features;
}
