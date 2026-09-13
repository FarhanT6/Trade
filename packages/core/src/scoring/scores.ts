import type { DecisionCard, Decision, MarketFeatures, MarketRegime, Quote, RiskAssessment, ScoreSet, SocialVelocity, Token } from '../types.js';
import { MS, clamp, scale100 } from '../util/stats.js';
import type { SimilarityResult } from '../similarity/knn.js';

export interface SmartMoneyInput {
  /** Independent-cluster consensus 0..100 for the top-trader cohort on this token. */
  consensusScore: number;
  /** Mean risk-adjusted skill (0..100) of wallets currently accumulating. */
  meanSkillOfBuyers: number;
  /** Net USD flow from high-skill wallets over the last 15m (positive = accumulation). */
  smartNetFlowUsd: number;
  /** Number of independent high-skill wallets holding. */
  independentSmartWallets: number;
  liquidityUsd: number;
}

export function momentumScore(m: MarketFeatures): number {
  const v5 = Math.log2(Math.max(0.01, m.volumeAcceleration['5m']));
  const v15 = Math.log2(Math.max(0.01, m.volumeAcceleration['15m']));
  const b = Math.log2(Math.max(0.01, m.buyerAcceleration));
  const p = clamp(m.intervals['15m'].priceChangePct / 50, -1, 1);
  const imb = m.buySellImbalance;
  const raw = 0.25 * clamp(v5 / 3, -1, 1) + 0.2 * clamp(v15 / 3, -1, 1) + 0.25 * clamp(b / 3, -1, 1) + 0.15 * p + 0.15 * imb;
  return clamp(50 + 50 * raw, 0, 100) * (0.4 + 0.6 * m.volumeQuality.score);
}

export function smartMoneyScore(s: SmartMoneyInput): number {
  const flow = clamp(s.smartNetFlowUsd / Math.max(1000, 0.05 * s.liquidityUsd), -1, 1);
  const wallets = clamp(s.independentSmartWallets / 6, 0, 1);
  return clamp(0.35 * s.consensusScore + 0.25 * s.meanSkillOfBuyers + 20 * flow + 20 * wallets + 20 * Math.max(0, flow) * wallets, 0, 100);
}

export function narrativeScore(v: SocialVelocity | null): number {
  if (!v) return 0;
  return clamp(v.velocityScore * (1 - 0.5 * Math.max(0, v.saturation - 0.8)), 0, 100);
}

export function liquidityScore(m: MarketFeatures, intendedSizeUsd: number): number {
  const depth = scale100(Math.log10(Math.max(1, m.liquidityUsd)), 3.5, 6); // $3k..$1M
  const impact = m.expectedImpactPct(intendedSizeUsd);
  const impactScore = clamp(100 - impact * 8, 0, 100);
  const ratioScore = scale100(m.liquidityToMcap, 0, 0.2);
  return clamp(0.45 * depth + 0.4 * impactScore + 0.15 * ratioScore, 0, 100);
}

export function executionScore(q: Quote | null, rpcHealth: number): number {
  if (!q) return 0;
  const impact = clamp(100 - q.worstCaseImpactPct * 6, 0, 100);
  const success = q.simulatedSuccessProbability * 100;
  const latency = clamp(100 - q.latencyMs / 20, 0, 100);
  const fees = clamp(100 - ((q.estimatedFeeUsd + q.priorityFeeUsd) / Math.max(1, q.inputUsd)) * 2000, 0, 100);
  return clamp(0.35 * success + 0.3 * impact + 0.15 * latency + 0.1 * fees + 0.1 * rpcHealth * 100, 0, 100);
}

export interface RegimeState {
  regime: MarketRegime;
  /** 0..1 breadth: share of tracked tokens with positive 1h return. */
  breadth: number;
  /** SOL / majors 24h return, in fraction. */
  majorsReturn24h: number;
  /** Aggregate meme volume vs 7d average. */
  volumeVsAverage: number;
}

export function marketRegimeScore(r: RegimeState | null): number {
  if (!r) return 50;
  const base = { bull: 75, 'meme-mania': 85, neutral: 55, bear: 25 }[r.regime];
  return clamp(base + 20 * (r.breadth - 0.5) + 10 * clamp(r.majorsReturn24h / 0.1, -1, 1) + 10 * clamp(Math.log2(Math.max(0.1, r.volumeVsAverage)) / 2, -1, 1), 0, 100);
}

export interface NetEvInput {
  scores: Omit<ScoreSet, 'netEvPct' | 'alpha'>;
  rugProbability: number;
  roundTripCostPct: number;
  /** Historical analog outcomes; used when available (spec §9). */
  similar?: SimilarityResult | null;
}

/**
 * Net expected value after fees, slippage, execution failure and catastrophic loss.
 * Uses historical analog forward-return distribution when available, otherwise a
 * score-conditioned prior. Catastrophic loss = rug (−90%) weighted by rug probability.
 */
export function netExpectedValue(i: NetEvInput): number {
  const s = i.scores;
  const edge = (0.3 * s.momentum + 0.3 * s.smartMoney + 0.2 * s.narrative + 0.2 * s.marketRegime) / 100; // 0..1
  const prior = -8 + 60 * edge; // prior: −8% at zero edge, +52% at max edge
  let expectedGrossPct = prior;
  if (i.similar && i.similar.neighbors.length >= 8) {
    // Analog estimate (median-ish + mild mean blend), shrunk toward the prior by sample size and
    // by how close the analogs actually are: a thin or distant neighborhood should not dominate.
    const analog = 0.6 * i.similar.medianForwardReturnPct + 0.4 * i.similar.meanForwardReturnPct;
    const meanDist = i.similar.neighbors.reduce((s, n) => s + n.distance, 0) / i.similar.neighbors.length;
    const closeness = clamp(1 - meanDist / 6, 0, 1);
    const w = clamp(i.similar.neighbors.length / 25, 0, 1) * 0.7 * closeness;
    expectedGrossPct = w * analog + (1 - w) * prior;
  }
  const manipPenalty = (s.manipulation / 100) * 15;
  const execFailure = (1 - s.execution / 100) * 0.3; // probability-ish of failed/poor execution
  const survivable = 1 - i.rugProbability;
  const ev = survivable * (expectedGrossPct - i.roundTripCostPct - manipPenalty) * (1 - execFailure) + i.rugProbability * -90;
  return clamp(ev, -100, 500);
}

export interface DecisionInput {
  token: Token;
  market: MarketFeatures;
  risk: RiskAssessment;
  smartMoney: SmartMoneyInput;
  social: SocialVelocity | null;
  regime: RegimeState | null;
  buyQuote: Quote | null;
  sellQuote: Quote | null;
  rpcHealth: number;
  intendedSizeUsd: number;
  similar?: SimilarityResult | null;
  now: number;
  /** Fraction of freshness confidence across critical inputs. */
  dataConfidence: number;
}

export function buildDecisionCard(i: DecisionInput): DecisionCard {
  const partial = {
    momentum: momentumScore(i.market),
    smartMoney: smartMoneyScore(i.smartMoney),
    narrative: narrativeScore(i.social),
    liquidity: liquidityScore(i.market, i.intendedSizeUsd),
    security: i.risk.securityScore,
    manipulation: i.risk.manipulationScore,
    execution: executionScore(i.buyQuote, i.rpcHealth),
    marketRegime: marketRegimeScore(i.regime),
  };
  const buyCost = i.buyQuote ? i.buyQuote.expectedImpactPct + ((i.buyQuote.estimatedFeeUsd + i.buyQuote.priorityFeeUsd) / Math.max(1, i.buyQuote.inputUsd)) * 100 : 5;
  const sellCost = i.sellQuote ? i.sellQuote.expectedImpactPct + ((i.sellQuote.estimatedFeeUsd + i.sellQuote.priorityFeeUsd) / Math.max(1, i.sellQuote.inputUsd)) * 100 : 5;
  const roundTrip = buyCost + sellCost;
  const netEvPct = netExpectedValue({ scores: partial, rugProbability: i.risk.rugProbability, roundTripCostPct: roundTrip, similar: i.similar });
  const alpha = clamp(
    (0.2 * partial.momentum + 0.2 * partial.smartMoney + 0.15 * partial.narrative + 0.1 * partial.liquidity + 0.15 * partial.security + 0.1 * partial.execution + 0.1 * partial.marketRegime) *
      (1 - 0.5 * (partial.manipulation / 100)),
    0,
    100,
  );
  const scores: ScoreSet = { ...partial, netEvPct, alpha };

  let decision: Decision;
  const reasons: string[] = [];
  if (i.risk.hardBlocked) {
    decision = 'HARD_BLOCK';
    reasons.push(`hard-block: ${i.risk.hardBlockReasons.join(', ')}`);
  } else if (i.dataConfidence < 0.6) {
    decision = 'PASS';
    reasons.push('data confidence too low to act');
  } else if (netEvPct <= 0 || scores.security < 50 || scores.execution < 40) {
    decision = 'PASS';
    if (netEvPct <= 0) reasons.push('negative net EV after costs');
    if (scores.security < 50) reasons.push('security score below floor');
    if (scores.execution < 40) reasons.push('execution quality unacceptable');
  } else if (i.market.drawdownFromHigh > 0.4 && i.market.tokenAgeMs > MS.h) {
    decision = 'WATCH';
    reasons.push(`post-peak: price ${(i.market.drawdownFromHigh * 100).toFixed(0)}% below recent high; wait for a new base`);
  } else if (netEvPct >= 12 && scores.smartMoney >= 70 && scores.liquidity >= 60 && scores.manipulation < 30 && i.risk.rugProbability < 0.1) {
    decision = 'ENTER';
    reasons.push('strong independent smart-money participation with acceptable liquidity and low rug probability');
  } else if (netEvPct >= 6 && scores.manipulation < 45) {
    decision = 'CONFIRMATION_ENTRY';
    reasons.push(scores.smartMoney >= 60 ? 'independent wallet accumulation' : 'momentum-led setup');
    if (scores.narrative >= 65) reasons.push('accelerating narrative');
    if (scores.liquidity < 60) reasons.push('liquidity acceptable but not deep enough for large sizing');
    reasons.push('wait for buyer-acceleration confirmation');
  } else {
    decision = 'WATCH';
    reasons.push(netEvPct > 0 ? 'positive but thin edge' : 'no edge');
    if (scores.manipulation >= 45) reasons.push('manipulation risk elevated');
  }
  const ageH = (i.now - i.token.createdAt) / MS.h;
  if (ageH < 0.25 && decision !== 'HARD_BLOCK' && decision !== 'PASS') reasons.push('token <15m old: sample too small, size down');

  // Suggested size: cap at 1% price impact and at the EV-scaled intended size.
  const depthCap = i.market.depthUsd.ask1pct;
  const evScale = clamp(netEvPct / 20, 0, 1);
  const suggestedSizeUsd = decision === 'ENTER' || decision === 'CONFIRMATION_ENTRY' ? Math.min(i.intendedSizeUsd * (0.5 + 0.5 * evScale), depthCap) * (ageH < 0.25 ? 0.5 : 1) : 0;

  return {
    tokenMint: i.token.mint,
    symbol: i.token.symbol,
    timestamp: i.now,
    scores,
    rugProbability: i.risk.rugProbability,
    expectedRoundTripCostPct: roundTrip,
    decision,
    reason: reasons.join('; '),
    suggestedSizeUsd,
    freshness: { asOf: i.now, source: 'scoring', confidence: i.dataConfidence },
  };
}

export function formatDecisionCard(c: DecisionCard): string {
  const s = c.scores;
  const line = (k: string, v: string) => `${k.padEnd(26)}${v}`;
  return [
    `TOKEN: $${c.symbol}`,
    line('Alpha score:', `${s.alpha.toFixed(0)}/100`),
    line('Momentum:', s.momentum.toFixed(0)),
    line('Smart money:', s.smartMoney.toFixed(0)),
    line('Narrative:', s.narrative.toFixed(0)),
    line('Liquidity:', s.liquidity.toFixed(0)),
    line('Security:', s.security.toFixed(0)),
    line('Manipulation risk:', s.manipulation.toFixed(0)),
    line('Execution quality:', s.execution.toFixed(0)),
    line('Market regime:', s.marketRegime.toFixed(0)),
    line('Rug probability:', `${(c.rugProbability * 100).toFixed(0)}%`),
    line('Expected round-trip cost:', `${c.expectedRoundTripCostPct.toFixed(1)}%`),
    line('Net expected value:', `${s.netEvPct >= 0 ? '+' : ''}${s.netEvPct.toFixed(1)}%`),
    `Decision: ${c.decision.replace('_', ' ')}`,
    `Reason: ${c.reason}`,
  ].join('\n');
}
