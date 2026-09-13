import type { Outcome } from '../types.js';
import { clamp, mean, median, quantile } from '../util/stats.js';

/** Feature groups from spec §9. All values are raw; normalization happens inside the index. */
export interface TokenStateVector {
  tokenMint: string;
  timestamp: number;
  // launch state
  tokenAgeMs: number;
  migrated: number; // 0/1
  initialLiquidityUsd: number;
  // market state
  marketCapUsd: number;
  liquidityUsd: number;
  volume1hUsd: number;
  volatility: number;
  // flow state
  uniqueBuyers15m: number;
  buyerAcceleration: number;
  volumeQuality: number;
  // narrative state
  socialVelocity: number;
  narrativeCategory: number; // hashed category id bucket 0..1
  influencerDiffusion: number;
  // trader state
  topTraderConsensus: number;
  smartEntryLatencyMs: number;
  // security state
  deployerRugRate: number;
  top10Concentration: number;
  authorityRisk: number;
}

export interface HistoricalCase {
  state: TokenStateVector;
  outcome: Outcome;
}

export interface SimilarityResult {
  neighbors: Array<{ case: HistoricalCase; distance: number }>;
  medianForwardReturnPct: number;
  meanForwardReturnPct: number;
  p10ForwardReturnPct: number;
  p90ForwardReturnPct: number;
  probability2x: number;
  probability5x: number;
  probabilitySevereDrawdown: number;
  medianTimeToTargetMs: number | null;
  rugRate: number;
  sampleSize: number;
}

const KEYS: Array<keyof Omit<TokenStateVector, 'tokenMint' | 'timestamp'>> = [
  'tokenAgeMs', 'migrated', 'initialLiquidityUsd', 'marketCapUsd', 'liquidityUsd', 'volume1hUsd', 'volatility',
  'uniqueBuyers15m', 'buyerAcceleration', 'volumeQuality', 'socialVelocity', 'narrativeCategory', 'influencerDiffusion',
  'topTraderConsensus', 'smartEntryLatencyMs', 'deployerRugRate', 'top10Concentration', 'authorityRisk',
];
const LOG_KEYS = new Set<string>(['tokenAgeMs', 'initialLiquidityUsd', 'marketCapUsd', 'liquidityUsd', 'volume1hUsd', 'uniqueBuyers15m', 'smartEntryLatencyMs', 'buyerAcceleration']);
const WEIGHTS: Partial<Record<keyof TokenStateVector, number>> = { marketCapUsd: 1.5, liquidityUsd: 1.5, tokenAgeMs: 1.3, buyerAcceleration: 1.2, topTraderConsensus: 1.2, socialVelocity: 1.1, deployerRugRate: 1.2 };

function transform(k: string, v: number): number {
  return LOG_KEYS.has(k) ? Math.log10(1 + Math.max(0, v)) : v;
}

/**
 * Historical-pattern index: nearest historical token states and their forward outcomes.
 * Point-in-time safe: queries only consider cases whose outcome window closed before `asOf`,
 * which prevents leakage in backtests (spec §9, §19).
 */
export class SimilarityIndex {
  private cases: HistoricalCase[] = [];
  private mu: number[] = [];
  private sigma: number[] = [];
  private dirty = true;

  constructor(private outcomeHorizonMs = 24 * 3_600_000) {}

  add(c: HistoricalCase): void {
    this.cases.push(c);
    this.dirty = true;
  }

  addAll(cs: HistoricalCase[]): void {
    for (const c of cs) this.add(c);
  }

  size(): number {
    return this.cases.length;
  }

  private refit(): void {
    const cols = KEYS.map((k) => this.cases.map((c) => transform(k, c.state[k])));
    this.mu = cols.map((c) => mean(c));
    this.sigma = cols.map((c, i) => {
      const s = Math.sqrt(mean(c.map((x) => (x - this.mu[i]) ** 2)));
      return s > 1e-9 ? s : 1;
    });
    this.dirty = false;
  }

  private vec(s: TokenStateVector): number[] {
    return KEYS.map((k, i) => ((transform(k, s[k]) - this.mu[i]) / this.sigma[i]) * (WEIGHTS[k] ?? 1));
  }

  query(state: TokenStateVector, k = 25, asOf = state.timestamp): SimilarityResult {
    const eligible = this.cases.filter((c) => c.outcome.decisionAt + this.outcomeHorizonMs <= asOf && c.state.tokenMint !== state.tokenMint);
    if (eligible.length === 0) return emptyResult();
    if (this.dirty) this.refit();
    const q = this.vec(state);
    const scored = eligible
      .map((c) => {
        const v = this.vec(c.state);
        let d = 0;
        for (let i = 0; i < v.length; i++) d += (v[i] - q[i]) ** 2;
        return { case: c, distance: Math.sqrt(d) };
      })
      .sort((a, b) => a.distance - b.distance)
      .slice(0, k);
    const returns = scored.map((n) => (n.case.outcome.forwardReturns['24h'] ?? n.case.outcome.maxForwardReturn) * 100);
    const ttt = scored.map((n) => n.case.outcome.timeToTargetMs).filter((x): x is number => x !== null);
    return {
      neighbors: scored,
      medianForwardReturnPct: median(returns),
      meanForwardReturnPct: mean(returns),
      p10ForwardReturnPct: quantile(returns, 0.1),
      p90ForwardReturnPct: quantile(returns, 0.9),
      probability2x: mean(scored.map((n) => (n.case.outcome.reached2x ? 1 : 0))),
      probability5x: mean(scored.map((n) => (n.case.outcome.reached5x ? 1 : 0))),
      probabilitySevereDrawdown: mean(scored.map((n) => (n.case.outcome.maxDrawdown <= -0.5 ? 1 : 0))),
      medianTimeToTargetMs: ttt.length ? median(ttt) : null,
      rugRate: mean(scored.map((n) => (n.case.outcome.rugged ? 1 : 0))),
      sampleSize: scored.length,
    };
  }
}

function emptyResult(): SimilarityResult {
  return { neighbors: [], medianForwardReturnPct: 0, meanForwardReturnPct: 0, p10ForwardReturnPct: 0, p90ForwardReturnPct: 0, probability2x: 0, probability5x: 0, probabilitySevereDrawdown: 0, medianTimeToTargetMs: null, rugRate: 0, sampleSize: 0 };
}

export function categoryBucket(label: string): number {
  let h = 0;
  for (let i = 0; i < label.length; i++) h = (h * 31 + label.charCodeAt(i)) >>> 0;
  return clamp((h % 1000) / 1000, 0, 1);
}
