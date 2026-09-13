import type { MarketFeatures, RiskAssessment } from '../types.js';
import { clamp } from '../util/stats.js';
import type { DistributionReport } from './distribution.js';

export interface OpenPositionState {
  tokenMint: string;
  entryPriceUsd: number;
  quantity: number;
  remainingFraction: number; // 1 = full position
  highWaterPriceUsd: number;
  openedAt: number;
  /** Profit-taking ladder already executed (indices). */
  takenLevels: number[];
  /** Discretionary trims already taken (distribution / divergence); capped so a position is not bled away. */
  discretionaryTrims?: number;
}

export interface ExitPlan {
  action: 'hold' | 'partial' | 'exit' | 'emergency-exit';
  fraction: number; // fraction of remaining to sell
  reason: string;
  stopPriceUsd: number;
  trailingStopUsd: number;
  maxSellChunkUsd: number;
}

export interface ExitConfig {
  /** Stop distance in units of hourly volatility (default 1.5σ). */
  stopSigma: number;
  minStopPct: number;
  maxStopPct: number;
  /** Take-profit ladder: [multiple, fraction of remaining to sell]. */
  ladder: Array<[number, number]>;
  /** Max sell chunk as fraction of 1%-impact depth. */
  chunkDepthFraction: number;
}

export const DEFAULT_EXIT_CONFIG: ExitConfig = {
  stopSigma: 1.5,
  minStopPct: 12,
  maxStopPct: 45,
  ladder: [
    [2, 0.35],
    [3, 0.35],
    [5, 0.5],
  ],
  chunkDepthFraction: 0.8,
};

/** Volatility-adjusted stop distance (spec §10: not arbitrary fixed percentages). */
export function volatilityStopPct(m: MarketFeatures, cfg: ExitConfig = DEFAULT_EXIT_CONFIG): number {
  return clamp(m.volatility * 100 * cfg.stopSigma, cfg.minStopPct, cfg.maxStopPct);
}

export function planExit(
  pos: OpenPositionState,
  m: MarketFeatures,
  risk: RiskAssessment | null,
  dist: DistributionReport,
  cfg: ExitConfig = DEFAULT_EXIT_CONFIG,
): ExitPlan {
  const price = m.priceUsd;
  const stopPct = volatilityStopPct(m, cfg);
  const stopPriceUsd = pos.entryPriceUsd * (1 - stopPct / 100);
  // Trailing stop tightens as liquidity thins and as the position is deeper in profit.
  const liqTighten = m.liquidityUsd < 25_000 ? 0.7 : 1;
  const multiple = pos.highWaterPriceUsd / pos.entryPriceUsd;
  const trailPct = stopPct * liqTighten * (multiple > 3 ? 0.6 : multiple > 2 ? 0.8 : 1);
  const trailingStopUsd = pos.highWaterPriceUsd * (1 - trailPct / 100);
  const maxSellChunkUsd = m.depthUsd.bid1pct * cfg.chunkDepthFraction;

  // Emergency: security/liquidity state changed.
  if (risk?.hardBlocked) return { action: 'emergency-exit', fraction: 1, reason: `security/liquidity hard-block: ${risk.hardBlockReasons.join(', ')}`, stopPriceUsd, trailingStopUsd, maxSellChunkUsd };
  if (dist.signals.liquidity === 'weakening' && m.liquidityUsd < 10_000) return { action: 'emergency-exit', fraction: 1, reason: 'liquidity collapsing', stopPriceUsd, trailingStopUsd, maxSellChunkUsd };

  if (price <= stopPriceUsd) return { action: 'exit', fraction: 1, reason: `volatility stop hit (${stopPct.toFixed(0)}%)`, stopPriceUsd, trailingStopUsd, maxSellChunkUsd };
  if (multiple > 1.2 && price <= trailingStopUsd) return { action: 'exit', fraction: 1, reason: `trailing stop hit (${trailPct.toFixed(0)}% from high)`, stopPriceUsd, trailingStopUsd, maxSellChunkUsd };

  const trims = pos.discretionaryTrims ?? 0;
  if (dist.level === 'HIGH' && trims < 2) return { action: 'partial', fraction: 0.5, reason: `distribution HIGH: ${describe(dist)}`, stopPriceUsd, trailingStopUsd, maxSellChunkUsd };

  const curMultiple = price / pos.entryPriceUsd;
  for (let i = 0; i < cfg.ladder.length; i++) {
    const [mult, frac] = cfg.ladder[i];
    if (curMultiple >= mult && !pos.takenLevels.includes(i)) {
      return { action: 'partial', fraction: frac, reason: `take-profit ladder ${mult}x`, stopPriceUsd, trailingStopUsd, maxSellChunkUsd };
    }
  }
  if (trims < 1) {
    if (dist.level === 'MEDIUM' && curMultiple > 1.3) return { action: 'partial', fraction: 0.25, reason: `distribution MEDIUM while in profit: ${describe(dist)}`, stopPriceUsd, trailingStopUsd, maxSellChunkUsd };
    // Divergence: price up while buyers/quality/smart money deteriorate.
    if (dist.signals.price === 'rising' && dist.signals.newBuyers === 'falling' && dist.signals.smartWalletSells === 'rising')
      return { action: 'partial', fraction: 0.3, reason: 'divergence: price rising while buyers slow and smart wallets sell', stopPriceUsd, trailingStopUsd, maxSellChunkUsd };
  }
  return { action: 'hold', fraction: 0, reason: 'no exit trigger', stopPriceUsd, trailingStopUsd, maxSellChunkUsd };
}

function describe(d: DistributionReport): string {
  return Object.entries(d.signals).filter(([, v]) => v !== 'flat' && v !== 'stable').map(([k, v]) => `${k} ${v}`).join(', ');
}

/** Liquidity-aware exit sizing: split a sell into chunks that each stay under the impact cap. */
export function chunkSell(totalUsd: number, maxChunkUsd: number): number[] {
  if (totalUsd <= 0) return [];
  const chunk = Math.max(1, maxChunkUsd);
  const n = Math.ceil(totalUsd / chunk);
  return Array.from({ length: n }, (_, i) => (i === n - 1 ? totalUsd - chunk * (n - 1) : chunk));
}
