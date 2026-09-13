import type { MarketFeatures, SocialVelocity } from '../types.js';
import { clamp } from '../util/stats.js';

export interface DistributionInput {
  market: MarketFeatures;
  prevMarket: MarketFeatures | null;
  social: SocialVelocity | null;
  /** Net USD flow from smart wallets in last 15m (negative = selling). */
  smartNetFlowUsd: number;
  /** Change in top-10 concentration since previous snapshot (fraction). */
  whaleConcentrationDelta: number;
  liquidityDeltaPct: number;
}

export interface DistributionReport {
  score: number; // 0..100
  level: 'LOW' | 'MEDIUM' | 'HIGH';
  action: 'hold' | 'trim' | 'reduce-or-exit';
  signals: Record<string, 'rising' | 'falling' | 'flat' | 'weakening' | 'stable'>;
}

/** Distribution Score (spec §10): price rising while underlying demand deteriorates. */
export function distributionScore(i: DistributionInput): DistributionReport {
  const m = i.market;
  const price = m.intervals['15m'].priceChangePct > 2 ? 'rising' : m.intervals['15m'].priceChangePct < -2 ? 'falling' : 'flat';
  const newBuyers = m.buyerAcceleration < 0.8 ? 'falling' : m.buyerAcceleration > 1.2 ? 'rising' : 'flat';
  const prevVq = i.prevMarket?.volumeQuality.score ?? m.volumeQuality.score;
  const volumeQuality = m.volumeQuality.score < prevVq - 0.1 ? 'falling' : m.volumeQuality.score > prevVq + 0.1 ? 'rising' : 'flat';
  const smartSells = i.smartNetFlowUsd < -0.01 * m.liquidityUsd ? 'rising' : i.smartNetFlowUsd > 0.01 * m.liquidityUsd ? 'falling' : 'flat';
  const whale = i.whaleConcentrationDelta > 0.02 ? 'rising' : i.whaleConcentrationDelta < -0.02 ? 'falling' : 'flat';
  const social = i.social ? (i.social.mentionAcceleration < 0.8 ? 'falling' : i.social.mentionAcceleration > 1.2 ? 'rising' : 'flat') : 'flat';
  const liquidity = i.liquidityDeltaPct < -5 ? 'weakening' : 'stable';

  let s = 0;
  if (price === 'rising') s += 15; // divergence only matters when price is still up
  if (newBuyers === 'falling') s += 20;
  if (volumeQuality === 'falling') s += 15;
  if (smartSells === 'rising') s += 25;
  if (whale === 'rising') s += 10;
  if (social === 'falling') s += 5;
  if (liquidity === 'weakening') s += 15;
  if (price !== 'rising') s *= 0.6; // if price already falling, it's a drawdown not distribution
  const score = clamp(s, 0, 100);
  const level = score >= 60 ? 'HIGH' : score >= 35 ? 'MEDIUM' : 'LOW';
  return {
    score,
    level,
    action: level === 'HIGH' ? 'reduce-or-exit' : level === 'MEDIUM' ? 'trim' : 'hold',
    signals: { price, newBuyers, volumeQuality, smartWalletSells: smartSells, whaleConcentration: whale, socialVelocity: social, liquidity },
  };
}
