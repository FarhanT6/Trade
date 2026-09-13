import { describe, expect, it } from 'vitest';
import { distributionScore } from '../exits/distribution.js';
import { chunkSell, planExit, volatilityStopPct } from '../exits/manager.js';
import { checkPortfolioLimits, DEFAULT_LIMITS } from '../portfolio/limits.js';
import { AuditLog, ExecutionEngine, KillSwitch, PoolQuoteSource, QuoteEngine, RpcRouter, priorityFeeUsd } from '../execution/engine.js';
import { NOW, marketStub, pool } from './helpers.js';
import { MS } from '../util/stats.js';

describe('distribution + exits', () => {
  it('flags distribution when price rises while demand deteriorates', () => {
    const m = marketStub({ buyerAcceleration: 0.5, intervals: { ...marketStub().intervals, '15m': { ...marketStub().intervals['15m'], priceChangePct: 12 } } });
    const d = distributionScore({ market: m, prevMarket: marketStub({ volumeQuality: { ...marketStub().volumeQuality, score: 0.95 } }), social: null, smartNetFlowUsd: -3000, whaleConcentrationDelta: 0.05, liquidityDeltaPct: -8 });
    expect(d.level).toBe('HIGH');
    expect(d.action).toBe('reduce-or-exit');
    const calm = distributionScore({ market: marketStub(), prevMarket: null, social: null, smartNetFlowUsd: 500, whaleConcentrationDelta: 0, liquidityDeltaPct: 0 });
    expect(calm.level).toBe('LOW');
  });
  it('uses volatility-adjusted stops, ladders and emergency exits', () => {
    const m = marketStub({ volatility: 0.2 });
    expect(volatilityStopPct(m)).toBeCloseTo(30, 5);
    const pos = { tokenMint: 'x', entryPriceUsd: 1, quantity: 100, remainingFraction: 1, highWaterPriceUsd: 1, openedAt: NOW, takenLevels: [] as number[] };
    const low = distributionScore({ market: m, prevMarket: null, social: null, smartNetFlowUsd: 0, whaleConcentrationDelta: 0, liquidityDeltaPct: 0 });
    expect(planExit(pos, { ...m, priceUsd: 0.65 }, null, low).action).toBe('exit');
    expect(planExit(pos, { ...m, priceUsd: 2.1 }, null, low)).toMatchObject({ action: 'partial', fraction: 0.35 });
    expect(planExit({ ...pos, takenLevels: [0] }, { ...m, priceUsd: 2.1 }, null, low).action).toBe('hold');
    expect(planExit({ ...pos, highWaterPriceUsd: 3 }, { ...m, priceUsd: 2.0 }, null, low).action).toBe('exit'); // trailing
    expect(planExit(pos, m, { hardBlocked: true, hardBlockReasons: ['LIQ_WITHDRAWAL'] } as any, low).action).toBe('emergency-exit');
    expect(chunkSell(1000, 300)).toEqual([300, 300, 300, 100]);
  });
});

describe('portfolio limits', () => {
  const state = { equityUsd: 10_000, cashUsd: 8000, open: [], equityCurve: [{ ts: NOW - 2 * MS.d, equityUsd: 10_000 }], dataHealthy: true, executionHealthy: true };
  const req = { tokenMint: 'a', narrativeIds: ['n1'], correlationKey: 'k', requestedUsd: 2000, stopDistancePct: 30, highRisk: false, now: NOW };
  it('caps size by risk-per-trade and per-token exposure', () => {
    const d = checkPortfolioLimits(state, req);
    expect(d.halted).toBe(false);
    expect(d.allowedUsd).toBeCloseTo(500, 5); // 1.5% of 10k / 30% stop
    expect(d.reasons[0]).toMatch(/risk-per-trade/);
  });
  it('halts on daily loss limit and on unhealthy execution', () => {
    const lossy = { ...state, equityUsd: 9400, equityCurve: [{ ts: NOW - 6 * MS.h, equityUsd: 10_000 }] };
    expect(checkPortfolioLimits(lossy, req).halted).toBe(true);
    expect(checkPortfolioLimits({ ...state, executionHealthy: false }, req).halted).toBe(true);
  });
  it('enforces narrative, correlated and high-risk caps', () => {
    const open = [
      { tokenMint: 'b', narrativeIds: ['n1'], correlationKey: 'k', valueUsd: 1400, highRisk: true },
      { tokenMint: 'c', narrativeIds: [], correlationKey: 'z', valueUsd: 100, highRisk: true },
      { tokenMint: 'd', narrativeIds: [], correlationKey: 'z', valueUsd: 100, highRisk: true },
    ];
    const d = checkPortfolioLimits({ ...state, open }, req, DEFAULT_LIMITS);
    expect(d.allowedUsd).toBeCloseTo(100, 5); // narrative cap 15% = 1500 - 1400
    expect(checkPortfolioLimits({ ...state, open }, { ...req, highRisk: true }).allowedUsd).toBe(0);
  });
});

describe('execution engine', () => {
  it('routes around failing rpc providers and adapts priority fees', () => {
    const r = new RpcRouter(['a', 'b']);
    for (let i = 0; i < 5; i++) r.record('a', false, 900, 'timeout', NOW);
    r.record('b', true, 80, undefined, NOW);
    expect(r.best(NOW)?.url).toBe('b');
    expect(priorityFeeUsd({ level: 0.9, landingRate: 0.5 })).toBeGreaterThan(priorityFeeUsd({ level: 0.1, landingRate: 0.99 }));
  });
  it('paper-fills within impact limits, records audit, and trips kill switch on bad landing', async () => {
    const rpc = new RpcRouter(['a']);
    const ks = new KillSwitch();
    const audit = new AuditLog();
    const eng = new ExecutionEngine(new QuoteEngine([new PoolQuoteSource()]), rpc, ks, audit);
    const o = await eng.execute(pool(), 'buy', 500, 'paper', NOW, 0.0001);
    expect(o.status).toBe('filled');
    expect(o.slippagePct).toBeGreaterThan(0);
    expect(audit.forOrder(o.id).map((e) => e.kind)).toEqual(['quote', 'simulation', 'submit', 'confirm']);
    const big = await eng.execute(pool(), 'buy', 3000, 'paper', NOW, 0.0001);
    expect(big.status).toBe('rejected');
    expect(big.rejectReason).toMatch(/impact/);
    const huge = await eng.execute(pool(), 'buy', 20_000, 'paper', NOW, 0.0001);
    expect(huge.rejectReason).toMatch(/exit path/);
    for (let i = 0; i < 6; i++) ks.record(false, 0);
    const blocked = await eng.execute(pool(), 'buy', 100, 'paper', NOW, 0.0001);
    expect(blocked.rejectReason).toMatch(/kill switch/);
    // Sells are still allowed when the kill switch is tripped (we must be able to exit).
    const sell = await eng.execute(pool(), 'sell', 100, 'paper', NOW, 0.0001);
    expect(sell.status).toBe('filled');
  });
});
