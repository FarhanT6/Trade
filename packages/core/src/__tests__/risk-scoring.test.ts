import { describe, expect, it } from 'vitest';
import { assessTokenRisk, type RiskInput } from '../risk/token-risk.js';
import { buildDecisionCard, formatDecisionCard, netExpectedValue } from '../scoring/scores.js';
import { NOW, fresh, marketStub, pool, token } from './helpers.js';
import type { Quote } from '../types.js';
import { MS } from '../util/stats.js';

const goodQuote: Quote = { route: 'r', provider: 'p', inputUsd: 500, expectedOutputUsd: 488, expectedImpactPct: 2, worstCaseImpactPct: 3, estimatedFeeUsd: 1.5, priorityFeeUsd: 0.05, simulatedSuccessProbability: 0.97, latencyMs: 120, quotedAt: NOW };

function base(over: Partial<RiskInput> = {}): RiskInput {
  return {
    tokenMint: token().mint, now: NOW,
    security: { tokenMint: token().mint, mintAuthority: null, freezeAuthority: null, metadataMutable: false, token2022Extensions: [], freshness: fresh() },
    pool: pool(), holders: { tokenMint: token().mint, timestamp: NOW, holderCount: 800, top: Array.from({ length: 20 }, (_, i) => ({ wallet: `h${i}`, pct: 0.01 })), deployerPct: 0.01, freshness: fresh() },
    deployer: { deployer: 'DEPLOYER', launches: 2, ruggedLaunches: 0, fundingSources: [], knownMaliciousClusterMatch: false, freshness: fresh() },
    liquidityEvents: [], market: marketStub(), clusters: [], social: null, sellQuote: goodQuote, ...over,
  };
}

describe('risk engine', () => {
  it('clean token scores high with no hard block', () => {
    const r = assessTokenRisk(base());
    expect(r.hardBlocked).toBe(false);
    expect(r.securityScore).toBeGreaterThan(85);
    expect(r.rugProbability).toBeLessThan(0.1);
  });
  it('hard-blocks mint authority, missing sell route, stale pool, and liquidity withdrawal', () => {
    expect(assessTokenRisk(base({ security: { ...base().security!, mintAuthority: 'X' } })).hardBlockReasons).toContain('MINT_AUTHORITY');
    expect(assessTokenRisk(base({ sellQuote: null })).hardBlockReasons).toContain('NO_SELL_ROUTE');
    expect(assessTokenRisk(base({ pool: pool({ freshness: fresh(NOW - 20 * MS.m) }) })).hardBlockReasons).toContain('POOL_STALE');
    expect(assessTokenRisk(base({ liquidityEvents: [{ id: 'l', poolId: 'pool1', tokenMint: token().mint, kind: 'remove', amountUsd: 40_000, wallet: 'd', timestamp: NOW - MS.m }] })).hardBlockReasons).toContain('LIQ_WITHDRAWAL');
    expect(assessTokenRisk(base({ security: { ...base().security!, token2022Extensions: ['permanentDelegate'] } })).hardBlocked).toBe(true);
    expect(assessTokenRisk(base({ sellQuote: { ...goodQuote, expectedOutputUsd: 100 } })).hardBlockReasons).toContain('HONEYPOT_LIKE');
  });
  it('escalates staleness to a hard block during fast-moving events', () => {
    const stale = { ...base().holders!, freshness: fresh(NOW - 3 * MS.h) };
    expect(assessTokenRisk(base({ holders: null })).hardBlocked).toBe(false);
    expect(assessTokenRisk(base({ holders: null, fastMoving: true })).hardBlocked).toBe(true);
    expect(assessTokenRisk(base({ holders: stale })).findings.some((f) => f.code === 'HOLDERS_STALE')).toBe(true);
  });
  it('raises manipulation score for wash volume and bot amplification', () => {
    const r = assessTokenRisk(base({ market: marketStub({ volumeQuality: { ...marketStub().volumeQuality, suspectedWashRatio: 0.7, score: 0.3 } }), social: { botLikelihood: 0.8, newAccountShare: 0.6 } as any }));
    expect(r.manipulationScore).toBeGreaterThan(50);
  });
});

describe('scoring', () => {
  const smart = { consensusScore: 80, meanSkillOfBuyers: 75, smartNetFlowUsd: 4000, independentSmartWallets: 5, liquidityUsd: 50_000 };
  const social = { subject: 't', timestamp: NOW, mentions: [], uniqueAuthors: [], engagement: [], mentionAcceleration: 3, uniqueAuthorAcceleration: 2.5, engagementAcceleration: 2, quoteVelocity: 0.1, newAccountShare: 0.1, influencerDiffusion: 0.4, crossPlatformDiffusion: 0.3, saturation: 0.3, botLikelihood: 0.1, velocityScore: 85 };
  const regime = { regime: 'bull' as const, breadth: 0.7, majorsReturn24h: 0.05, volumeVsAverage: 1.4 };
  it('produces ENTER for a strong, clean setup and HARD_BLOCK when risk blocks', () => {
    const risk = assessTokenRisk(base());
    const m = marketStub({ volumeAcceleration: { '1m': 2, '5m': 3, '15m': 2.5, '1h': 1.5 }, buyerAcceleration: 2.5, buySellImbalance: 0.5 });
    const card = buildDecisionCard({ token: token(), market: m, risk, smartMoney: smart, social, regime, buyQuote: goodQuote, sellQuote: goodQuote, rpcHealth: 0.95, intendedSizeUsd: 500, now: NOW, dataConfidence: 0.95 });
    expect(card.decision).toBe('ENTER');
    expect(card.scores.netEvPct).toBeGreaterThan(12);
    expect(card.suggestedSizeUsd).toBeGreaterThan(0);
    expect(card.suggestedSizeUsd).toBeLessThanOrEqual(m.depthUsd.ask1pct);
    expect(formatDecisionCard(card)).toContain('Decision: ENTER');
    const blocked = buildDecisionCard({ token: token(), market: m, risk: assessTokenRisk(base({ sellQuote: null })), smartMoney: smart, social, regime, buyQuote: goodQuote, sellQuote: null, rpcHealth: 0.95, intendedSizeUsd: 500, now: NOW, dataConfidence: 0.95 });
    expect(blocked.decision).toBe('HARD_BLOCK');
    expect(blocked.suggestedSizeUsd).toBe(0);
  });
  it('passes on low data confidence and on negative EV', () => {
    const risk = assessTokenRisk(base());
    const weak = { consensusScore: 0, meanSkillOfBuyers: 10, smartNetFlowUsd: -500, independentSmartWallets: 0, liquidityUsd: 50_000 };
    const m = marketStub({ volumeAcceleration: { '1m': 0.5, '5m': 0.5, '15m': 0.6, '1h': 0.7 }, buyerAcceleration: 0.5, buySellImbalance: -0.5 });
    const c1 = buildDecisionCard({ token: token(), market: m, risk, smartMoney: weak, social: null, regime: { ...regime, regime: 'bear', breadth: 0.2 }, buyQuote: goodQuote, sellQuote: goodQuote, rpcHealth: 0.9, intendedSizeUsd: 500, now: NOW, dataConfidence: 0.9 });
    expect(['PASS', 'WATCH']).toContain(c1.decision);
    expect(c1.scores.netEvPct).toBeLessThan(6);
    const c2 = buildDecisionCard({ token: token(), market: marketStub(), risk, smartMoney: smart, social, regime, buyQuote: goodQuote, sellQuote: goodQuote, rpcHealth: 0.9, intendedSizeUsd: 500, now: NOW, dataConfidence: 0.3 });
    expect(c2.decision).toBe('PASS');
  });
  it('net EV penalizes rug probability heavily', () => {
    const s = { momentum: 80, smartMoney: 80, narrative: 70, liquidity: 70, security: 90, manipulation: 10, execution: 90, marketRegime: 70 };
    expect(netExpectedValue({ scores: s, rugProbability: 0.02, roundTripCostPct: 3 })).toBeGreaterThan(netExpectedValue({ scores: s, rugProbability: 0.3, roundTripCostPct: 3 }) + 20);
  });
});
