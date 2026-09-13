import type { Decision, DecisionCard, Outcome, Signal } from '../types.js';
import { computeMetrics, type ProfitabilityMetrics, type TradeResult } from './metrics.js';
import { MS } from '../util/stats.js';

/**
 * Point-in-time market view. Every accessor is bounded by `asOf` so future
 * information cannot leak into features (spec §19).
 */
export interface PointInTimeView {
  asOf: number;
  /** Price path after `asOf` is only used to compute *outcomes*, never features. */
}

export interface ReplayStep {
  timestamp: number;
  tokenMint: string;
  /** Decision made using only data <= timestamp. */
  card: DecisionCard;
  signal: Signal;
}

export interface OutcomeResolver {
  /** Return the realized outcome for a signal using data strictly after decisionAt. */
  resolve(step: ReplayStep, horizonMs: number): Outcome;
}

export interface ExecutionModel {
  /** Round-trip cost in pct for a trade of `sizeUsd` at this liquidity, plus failure probability. */
  cost(sizeUsd: number, liquidityUsd: number): { roundTripPct: number; failureProbability: number; latencyMs: number };
}

export const DEFAULT_EXECUTION_MODEL: ExecutionModel = {
  cost(sizeUsd, liquidityUsd) {
    const impact = (sizeUsd / Math.max(1, liquidityUsd / 2 + sizeUsd)) * 100;
    return { roundTripPct: 2 * impact + 0.6 + 0.3, failureProbability: Math.min(0.5, 0.03 + impact / 100), latencyMs: 400 };
  },
};

export interface StrategyPolicy {
  name: string;
  /** Whether to take the trade given the decision card. */
  enter(card: DecisionCard, rnd: () => number): boolean;
  sizeUsd(card: DecisionCard, equityUsd: number): number;
  /** Exit rule applied to the outcome path (simplified: holds to horizon or stop). */
  exitReturnPct(outcome: Outcome, card: DecisionCard): number;
}

const ENTER_SET = new Set<Decision>(['ENTER', 'CONFIRMATION_ENTRY']);

/**
 * Approximates the exit engine (exits/manager.ts) from an outcome's path summary: a 30%
 * volatility stop, the 2x/3x/5x take-profit ladder, and a trailing exit ~25% below the peak.
 */
export function exitEngineReturnPct(o: Outcome, stopPct = -30): number {
  if (o.realizedPnlPct !== null) return o.realizedPnlPct;
  const stopHitFirst = o.maxDrawdown <= stopPct / 100 && (o.forwardReturns['1h'] ?? 0) <= 0 && !o.reached2x;
  if (stopHitFirst) return stopPct;
  const peak = o.maxForwardReturn; // 1.0 = +100%
  if (o.reached2x) {
    let rem = 1;
    let ret = 0.35 * 100;
    rem -= 0.35;
    if (peak >= 2) {
      ret += rem * 0.35 * 200;
      rem *= 0.65;
    }
    if (peak >= 4) {
      ret += rem * 0.5 * 400;
      rem *= 0.5;
    }
    ret += rem * Math.max(stopPct, peak * 0.75 * 100);
    return ret;
  }
  if (peak >= 0.3) return Math.max(stopPct, peak * 0.75 * 100);
  return Math.max(stopPct, (o.forwardReturns['4h'] ?? o.forwardReturns['24h'] ?? stopPct / 100) * 100);
}

export const POLICIES: Record<string, StrategyPolicy> = {
  system: {
    name: 'system',
    enter: (c) => ENTER_SET.has(c.decision),
    sizeUsd: (c) => c.suggestedSizeUsd,
    exitReturnPct: (o) => exitEngineReturnPct(o),
  },
  'buy-and-hold': {
    name: 'buy-and-hold',
    enter: (c) => c.decision !== 'HARD_BLOCK',
    sizeUsd: (_c, eq) => eq * 0.02,
    exitReturnPct: (o) => (o.forwardReturns['24h'] ?? -1) * 100,
  },
  'momentum-only': {
    name: 'momentum-only',
    enter: (c) => c.scores.momentum >= 70 && c.decision !== 'HARD_BLOCK',
    sizeUsd: (_c, eq) => eq * 0.02,
    exitReturnPct: (o) => (o.forwardReturns['4h'] ?? -1) * 100,
  },
  'random-entry': {
    name: 'random-entry',
    enter: (c, rnd) => c.decision !== 'HARD_BLOCK' && rnd() < 0.15,
    sizeUsd: (_c, eq) => eq * 0.02,
    exitReturnPct: (o) => (o.forwardReturns['4h'] ?? -1) * 100,
  },
};

export interface ReplayOptions {
  startEquityUsd: number;
  horizonMs?: number;
  execution?: ExecutionModel;
  seed?: number;
  /** Liquidity lookup for execution cost. */
  liquidityAt: (tokenMint: string, ts: number) => number;
}

export interface ReplayResult {
  policy: string;
  metrics: ProfitabilityMetrics;
  trades: TradeResult[];
  missedMoves: number;
}

function seeded(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** Replay the decision pipeline output through a policy with realistic execution costs. */
export function replay(steps: ReplayStep[], resolver: OutcomeResolver, policy: StrategyPolicy, opts: ReplayOptions): ReplayResult {
  const horizon = opts.horizonMs ?? 24 * MS.h;
  const exec = opts.execution ?? DEFAULT_EXECUTION_MODEL;
  const rnd = seeded(opts.seed ?? 42);
  let equity = opts.startEquityUsd;
  const trades: TradeResult[] = [];
  let missed = 0;
  for (const step of [...steps].sort((a, b) => a.timestamp - b.timestamp)) {
    const outcome = resolver.resolve(step, horizon);
    const major = outcome.reached2x;
    if (!policy.enter(step.card, rnd)) {
      if (major) missed++;
      continue;
    }
    const size = Math.min(policy.sizeUsd(step.card, equity), equity * 0.1);
    if (size <= 0) {
      if (major) missed++;
      continue;
    }
    const liq = opts.liquidityAt(step.tokenMint, step.timestamp);
    const c = exec.cost(size, liq);
    const failed = rnd() < c.failureProbability;
    let pnlPct: number;
    if (failed) pnlPct = -0.3; // failed tx: priority fee burned, no position
    else if (outcome.rugged) pnlPct = -95;
    else pnlPct = policy.exitReturnPct(outcome, step.card) - c.roundTripPct;
    const pnlUsd = (size * pnlPct) / 100;
    equity += pnlUsd;
    const quoted = 1;
    const filled = 1 + c.roundTripPct / 200; // half of round-trip on entry side
    trades.push({ signalId: step.signal.id, tokenMint: step.tokenMint, entryAt: step.timestamp, exitAt: step.timestamp + horizon, sizeUsd: size, pnlUsd, pnlPct, quotedPriceUsd: quoted, filledPriceUsd: filled, rugged: outcome.rugged, majorMove: major });
  }
  return { policy: policy.name, metrics: computeMetrics(trades, opts.startEquityUsd, missed), trades, missedMoves: missed };
}

/** Walk-forward split: strictly time-ordered train/test folds, no shuffling. */
export function walkForwardFolds<T extends { timestamp: number }>(items: T[], folds: number, trainFraction = 0.6): Array<{ train: T[]; test: T[] }> {
  const sorted = [...items].sort((a, b) => a.timestamp - b.timestamp);
  if (sorted.length === 0 || folds <= 0) return [];
  const t0 = sorted[0].timestamp;
  const t1 = sorted[sorted.length - 1].timestamp;
  const span = Math.max(1, t1 - t0);
  const out: Array<{ train: T[]; test: T[] }> = [];
  const testSpan = (span * (1 - trainFraction)) / folds;
  for (let f = 0; f < folds; f++) {
    const testStart = t0 + span * trainFraction + f * testSpan;
    const testEnd = f === folds - 1 ? t1 + 1 : testStart + testSpan;
    out.push({ train: sorted.filter((x) => x.timestamp < testStart), test: sorted.filter((x) => x.timestamp >= testStart && x.timestamp < testEnd) });
  }
  return out;
}

/** Model-drift monitor: share of features whose live value falls outside the training 1st–99th percentile band. */
export function outOfDistributionShare(train: Array<Record<string, number>>, live: Record<string, number>): number {
  const keys = Object.keys(live);
  if (keys.length === 0 || train.length === 0) return 0;
  let ood = 0;
  for (const k of keys) {
    const col = train.map((r) => r[k]).filter((v) => typeof v === 'number' && !Number.isNaN(v)).sort((a, b) => a - b);
    if (col.length < 10) continue;
    const lo = col[Math.floor(col.length * 0.01)];
    const hi = col[Math.floor(col.length * 0.99)];
    if (live[k] < lo || live[k] > hi) ood++;
  }
  return ood / keys.length;
}
