import { describe, expect, it } from 'vitest';
import { computeMarketFeatures, computeVolumeQuality, constantProductImpactPct, depthForImpact } from '../features/market.js';
import { NOW, acceleratingTrades, pool, token, trade } from './helpers.js';
import { MS } from '../util/stats.js';

describe('market features', () => {
  it('detects volume and buyer acceleration', () => {
    const f = computeMarketFeatures({ token: token(), pool: pool(), trades: acceleratingTrades(), now: NOW, priceUsd: 0.00013 });
    expect(f.volumeAcceleration['5m']).toBeGreaterThan(2);
    expect(f.buyerAcceleration).toBeGreaterThan(2);
    expect(f.buySellImbalance).toBe(1);
    expect(f.intervals['15m'].priceChangePct).toBeCloseTo(30, 0);
  });
  it('constant product impact is monotonic and depth inverts it', () => {
    expect(constantProductImpactPct(25_000, 250)).toBeCloseTo(0.99, 1);
    expect(constantProductImpactPct(25_000, 2500)).toBeGreaterThan(constantProductImpactPct(25_000, 250));
    expect(constantProductImpactPct(25_000, depthForImpact(25_000, 5))).toBeCloseTo(5, 5);
  });
  it('flags wash loops as non-economic volume', () => {
    const clean = Array.from({ length: 20 }, (_, i) => trade({ wallet: `u${i}`, amountUsd: 50 + i * 17, timestamp: NOW - i * 90_000 - ((i * i * 7919) % 60_000) }));
    expect(computeVolumeQuality(clean).score).toBeGreaterThan(0.9);
    const washy: typeof clean = [];
    for (let i = 0; i < 10; i++) {
      washy.push(trade({ wallet: 'bot', side: 'buy', amountUsd: 300, timestamp: NOW - i * 120_000 }));
      washy.push(trade({ wallet: 'bot', side: 'sell', amountUsd: 301, timestamp: NOW - i * 120_000 + 30_000 }));
    }
    const vq = computeVolumeQuality(washy);
    expect(vq.suspectedWashRatio).toBeGreaterThan(0.4);
    expect(vq.score).toBeLessThan(0.6);
  });
  it('discounts balanced two-sided volume inside a funding cluster', () => {
    const anc = new Map([['a1', 'ANC'], ['a2', 'ANC']]);
    const ts = [trade({ wallet: 'a1', side: 'buy', amountUsd: 1000, timestamp: NOW - 5 * MS.m }), trade({ wallet: 'a2', side: 'sell', amountUsd: 1000, timestamp: NOW - 4 * MS.m })];
    expect(computeVolumeQuality(ts, anc).sharedFundingVolumeUsd).toBe(2000);
    expect(computeVolumeQuality(ts, anc).score).toBe(0);
  });
});
