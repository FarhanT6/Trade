import { describe, expect, it } from 'vitest';
import { computeMetrics, signalHalfLife, type TradeResult } from '../backtest/metrics.js';
import { POLICIES, outOfDistributionShare, replay, walkForwardFolds } from '../backtest/replay.js';
import { SimilarityIndex, type TokenStateVector } from '../similarity/knn.js';
import { NOW } from './helpers.js';
import { MS } from '../util/stats.js';
import type { Outcome } from '../types.js';

function state(i: number, over: Partial<TokenStateVector> = {}): TokenStateVector {
  return { tokenMint: `m${i}`, timestamp: NOW - i * MS.h, tokenAgeMs: MS.h, migrated: 0, initialLiquidityUsd: 20_000, marketCapUsd: 200_000, liquidityUsd: 40_000, volume1hUsd: 50_000, volatility: 0.2, uniqueBuyers15m: 30, buyerAcceleration: 1.5, volumeQuality: 0.8, socialVelocity: 50, narrativeCategory: 0.2, influencerDiffusion: 0.2, topTraderConsensus: 40, smartEntryLatencyMs: 0, deployerRugRate: 0, top10Concentration: 0.15, authorityRisk: 0, ...over };
}
function outcome(i: number, ret: number, rugged = false): Outcome {
  return { signalId: `s${i}`, tokenMint: `m${i}`, decisionAt: NOW - i * MS.h, forwardReturns: { '15m': ret / 4, '1h': ret / 2, '4h': ret, '24h': ret }, maxForwardReturn: Math.max(ret, 0) + 0.1, maxDrawdown: Math.min(0, ret) - 0.05, reached2x: ret >= 1, reached5x: ret >= 4, rugged, timeToTargetMs: ret >= 1 ? MS.h : null, realizedPnlPct: null };
}

describe('similarity index', () => {
  it('finds analogs and never returns cases whose outcome window is still open', () => {
    const idx = new SimilarityIndex(24 * MS.h);
    for (let i = 30; i < 60; i++) idx.add({ state: state(i, { topTraderConsensus: 85, buyerAcceleration: 3 }), outcome: outcome(i, 1.5) });
    for (let i = 60; i < 90; i++) idx.add({ state: state(i, { topTraderConsensus: 5, deployerRugRate: 0.8 }), outcome: outcome(i, -0.9, true) });
    idx.add({ state: state(1, { topTraderConsensus: 85, buyerAcceleration: 3 }), outcome: outcome(1, 9) }); // too recent: leaks
    const good = idx.query(state(0, { topTraderConsensus: 85, buyerAcceleration: 3 }), 10, NOW);
    expect(good.neighbors.every((n) => n.case.outcome.decisionAt + 24 * MS.h <= NOW)).toBe(true);
    expect(good.probability2x).toBeGreaterThan(0.8);
    const bad = idx.query(state(0, { topTraderConsensus: 5, deployerRugRate: 0.8 }), 10, NOW);
    expect(bad.rugRate).toBeGreaterThan(0.8);
  });
});

describe('backtest', () => {
  it('walk-forward folds are strictly time ordered', () => {
    const items = Array.from({ length: 100 }, (_, i) => ({ timestamp: NOW + i * MS.h }));
    const folds = walkForwardFolds(items, 4, 0.6);
    expect(folds).toHaveLength(4);
    for (const f of folds) {
      const maxTrain = Math.max(...f.train.map((x) => x.timestamp));
      const minTest = Math.min(...f.test.map((x) => x.timestamp));
      expect(maxTrain).toBeLessThan(minTest);
    }
    expect(folds.reduce((s, f) => s + f.test.length, 0)).toBe(40);
  });
  it('metrics: profit factor, drawdown, tail loss, CI', () => {
    const trades: TradeResult[] = [20, -10, 30, -5, -95, 15].map((pct, i) => ({ signalId: `s${i}`, tokenMint: 'm', entryAt: NOW + i * MS.h, exitAt: NOW + (i + 1) * MS.h, sizeUsd: 100, pnlUsd: pct, pnlPct: pct, quotedPriceUsd: 1, filledPriceUsd: 1.01, rugged: pct === -95, majorMove: pct > 15 }));
    const m = computeMetrics(trades, 1000, 2);
    expect(m.profitFactor).toBeCloseTo(65 / 110, 5);
    expect(m.maxDrawdownPct).toBeGreaterThan(9);
    expect(m.tailLossPct).toBeLessThan(-50);
    expect(m.falsePositiveRate).toBeCloseTo(2 / 6, 5);
    expect(m.opportunityCapture).toBeCloseTo(2 / 4, 5);
    expect(m.evConfidenceInterval[0]).toBeLessThan(m.netExpectedValuePct);
    expect(m.executionSlippagePct).toBeCloseTo(1, 5);
    expect(signalHalfLife([{ delayMs: 0, meanReturnPct: 10 }, { delayMs: 60_000, meanReturnPct: 7 }, { delayMs: 120_000, meanReturnPct: 4 }])).toBe(120_000);
  });
  it('replay compares the system against baselines with execution costs', () => {
    const steps = Array.from({ length: 40 }, (_, i) => {
      const good = i % 2 === 0;
      const scores = { momentum: good ? 85 : 40, smartMoney: good ? 80 : 20, narrative: 50, liquidity: 70, security: 90, manipulation: 10, execution: 90, marketRegime: 60, netEvPct: good ? 15 : -5, alpha: good ? 80 : 30 };
      const card = { tokenMint: `m${i}`, symbol: 'X', timestamp: NOW + i * MS.h, scores, rugProbability: 0.03, expectedRoundTripCostPct: 3, decision: good ? ('ENTER' as const) : ('PASS' as const), reason: '', suggestedSizeUsd: 200, freshness: { asOf: NOW, source: 't', confidence: 1 } };
      return { timestamp: NOW + i * MS.h, tokenMint: `m${i}`, card, signal: { id: `s${i}`, tokenMint: `m${i}`, timestamp: NOW + i * MS.h, features: {}, scores, decision: card.decision, modelVersion: 't' } };
    });
    const resolver = { resolve: (s: (typeof steps)[number]) => outcome(0, s.card.decision === 'ENTER' ? 0.6 : -0.4) };
    const sys = replay(steps, resolver, POLICIES.system, { startEquityUsd: 10_000, liquidityAt: () => 50_000, seed: 1 });
    const bh = replay(steps, resolver, POLICIES['buy-and-hold'], { startEquityUsd: 10_000, liquidityAt: () => 50_000, seed: 1 });
    expect(sys.metrics.netExpectedValuePct).toBeGreaterThan(bh.metrics.netExpectedValuePct);
    expect(sys.trades.every((t) => t.pnlPct < 60)).toBe(true); // costs applied
    expect(outOfDistributionShare(Array.from({ length: 50 }, (_, i) => ({ a: i, b: 1 })), { a: 500, b: 1 })).toBe(0.5);
  });
});
