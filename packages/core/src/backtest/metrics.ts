import { mean, median, quantile, stddev, sum } from '../util/stats.js';

export interface TradeResult {
  signalId: string;
  tokenMint: string;
  entryAt: number;
  exitAt: number;
  sizeUsd: number;
  /** Net of fees, slippage and failure costs. */
  pnlUsd: number;
  pnlPct: number;
  quotedPriceUsd: number;
  filledPriceUsd: number;
  rugged: boolean;
  /** Did the token expand ≥2x within the horizon after the signal (whether or not captured)? */
  majorMove: boolean;
}

export interface ProfitabilityMetrics {
  trades: number;
  netExpectedValuePct: number;
  netPnlUsd: number;
  profitFactor: number;
  winRate: number;
  maxDrawdownPct: number;
  sharpe: number;
  sortino: number;
  calmar: number;
  medianTradePct: number;
  tailLossPct: number; // 5th percentile trade return
  opportunityCapture: number;
  falsePositiveRate: number;
  executionSlippagePct: number;
  /** 95% CI on mean trade return via bootstrap. */
  evConfidenceInterval: [number, number];
}

export function equityCurve(trades: TradeResult[], startEquity: number): number[] {
  const curve = [startEquity];
  let eq = startEquity;
  for (const t of [...trades].sort((a, b) => a.exitAt - b.exitAt)) {
    eq += t.pnlUsd;
    curve.push(eq);
  }
  return curve;
}

export function maxDrawdown(curve: number[]): number {
  let peak = curve[0] ?? 0;
  let dd = 0;
  for (const v of curve) {
    if (v > peak) peak = v;
    if (peak > 0) dd = Math.max(dd, (peak - v) / peak);
  }
  return dd * 100;
}

export function bootstrapCI(xs: number[], iters = 500, seed = 7): [number, number] {
  if (xs.length === 0) return [0, 0];
  let a = seed >>> 0;
  const rnd = () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
  const means: number[] = [];
  for (let i = 0; i < iters; i++) {
    let s = 0;
    for (let j = 0; j < xs.length; j++) s += xs[Math.floor(rnd() * xs.length)];
    means.push(s / xs.length);
  }
  return [quantile(means, 0.025), quantile(means, 0.975)];
}

/** Profitability metrics (spec §20). `missedMoves` = major moves the system never alerted on. */
export function computeMetrics(trades: TradeResult[], startEquity: number, missedMoves = 0, periodsPerYear = 365): ProfitabilityMetrics {
  const rets = trades.map((t) => t.pnlPct);
  const wins = trades.filter((t) => t.pnlUsd > 0);
  const losses = trades.filter((t) => t.pnlUsd < 0);
  const gp = sum(wins.map((t) => t.pnlUsd));
  const gl = -sum(losses.map((t) => t.pnlUsd));
  const curve = equityCurve(trades, startEquity);
  const dd = maxDrawdown(curve);
  const dailyRet = rets.map((r) => r / 100);
  const sd = stddev(dailyRet);
  const downside = Math.sqrt(mean(dailyRet.map((r) => Math.min(0, r) ** 2))) || 0;
  const annual = mean(dailyRet) * periodsPerYear;
  const total = curve.length > 1 ? (curve[curve.length - 1] - curve[0]) / curve[0] : 0;
  const captured = trades.filter((t) => t.majorMove).length;
  return {
    trades: trades.length,
    netExpectedValuePct: mean(rets),
    netPnlUsd: sum(trades.map((t) => t.pnlUsd)),
    profitFactor: gl === 0 ? (gp > 0 ? Infinity : 0) : gp / gl,
    winRate: trades.length ? wins.length / trades.length : 0,
    maxDrawdownPct: dd,
    sharpe: sd > 0 ? (mean(dailyRet) / sd) * Math.sqrt(periodsPerYear) : 0,
    sortino: downside > 0 ? (mean(dailyRet) / downside) * Math.sqrt(periodsPerYear) : 0,
    calmar: dd > 0 ? (total * 100) / dd : 0,
    medianTradePct: median(rets),
    tailLossPct: quantile(rets, 0.05),
    opportunityCapture: captured + missedMoves > 0 ? captured / (captured + missedMoves) : 0,
    falsePositiveRate: trades.length ? trades.filter((t) => t.pnlPct <= -10 || t.rugged).length / trades.length : 0,
    executionSlippagePct: mean(trades.map((t) => (t.quotedPriceUsd > 0 ? Math.abs(t.filledPriceUsd / t.quotedPriceUsd - 1) * 100 : 0))),
    evConfidenceInterval: bootstrapCI(rets),
  };
}

/** Signal half-life: how quickly forward edge decays after detection, from (delayMs, meanReturn) samples. */
export function signalHalfLife(samples: Array<{ delayMs: number; meanReturnPct: number }>): number | null {
  const sorted = [...samples].sort((a, b) => a.delayMs - b.delayMs);
  if (sorted.length < 2 || sorted[0].meanReturnPct <= 0) return null;
  const half = sorted[0].meanReturnPct / 2;
  for (const s of sorted) if (s.meanReturnPct <= half) return s.delayMs;
  return null;
}
