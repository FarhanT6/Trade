import type { PortfolioLimits } from '../types.js';
import { MS } from '../util/stats.js';

export const DEFAULT_LIMITS: PortfolioLimits = {
  maxRiskPerTradePct: 1.5,
  maxExposurePerTokenPct: 5,
  maxExposurePerNarrativePct: 15,
  maxCorrelatedExposurePct: 25,
  dailyLossLimitPct: 5,
  weeklyDrawdownLimitPct: 12,
  maxSimultaneousHighRisk: 3,
  minReservePct: 20,
};

export interface OpenExposure {
  tokenMint: string;
  narrativeIds: string[];
  /** Correlation bucket (chain + launch type + narrative), used for correlated exposure. */
  correlationKey: string;
  valueUsd: number;
  highRisk: boolean;
}

export interface PortfolioState {
  equityUsd: number;
  cashUsd: number;
  open: OpenExposure[];
  /** Realized+unrealized PnL history points (ts, equity). */
  equityCurve: Array<{ ts: number; equityUsd: number }>;
  dataHealthy: boolean;
  executionHealthy: boolean;
}

export interface SizingRequest {
  tokenMint: string;
  narrativeIds: string[];
  correlationKey: string;
  requestedUsd: number;
  stopDistancePct: number;
  highRisk: boolean;
  now: number;
}

export interface SizingDecision {
  allowedUsd: number;
  halted: boolean;
  reasons: string[];
}

function equityAt(curve: PortfolioState['equityCurve'], ts: number, fallback: number): number {
  let best: number | null = null;
  for (const p of curve) if (p.ts <= ts) best = p.equityUsd;
  if (best !== null) return best;
  // No sample at/before the cutoff: use the earliest sample after it (conservative).
  const after = curve.filter((p) => p.ts > ts).sort((a, b) => a.ts - b.ts)[0];
  return after ? after.equityUsd : fallback;
}

/** Portfolio risk engine (spec §11). Returns the allowed size, or 0 with reasons; `halted` blocks all new trades. */
export function checkPortfolioLimits(state: PortfolioState, req: SizingRequest, limits: PortfolioLimits = DEFAULT_LIMITS): SizingDecision {
  const reasons: string[] = [];
  const eq = state.equityUsd;
  if (!state.dataHealthy || !state.executionHealthy) return { allowedUsd: 0, halted: true, reasons: ['automatic halt: data or execution failure'] };

  const dayStart = equityAt(state.equityCurve, req.now - MS.d, eq);
  const weekStart = equityAt(state.equityCurve, req.now - 7 * MS.d, eq);
  const weekPeak = Math.max(weekStart, ...state.equityCurve.filter((p) => p.ts >= req.now - 7 * MS.d).map((p) => p.equityUsd));
  const dailyLossPct = ((dayStart - eq) / Math.max(1, dayStart)) * 100;
  const weeklyDdPct = ((weekPeak - eq) / Math.max(1, weekPeak)) * 100;
  if (dailyLossPct >= limits.dailyLossLimitPct) return { allowedUsd: 0, halted: true, reasons: [`daily loss limit hit (${dailyLossPct.toFixed(1)}%)`] };
  if (weeklyDdPct >= limits.weeklyDrawdownLimitPct) return { allowedUsd: 0, halted: true, reasons: [`weekly drawdown limit hit (${weeklyDdPct.toFixed(1)}%)`] };

  let allowed = req.requestedUsd;
  const cap = (v: number, why: string) => {
    if (v < allowed) {
      allowed = Math.max(0, v);
      reasons.push(why);
    }
  };
  // Risk per trade: size * stop distance <= max risk.
  const riskCap = (eq * limits.maxRiskPerTradePct) / 100 / Math.max(0.01, req.stopDistancePct / 100);
  cap(riskCap, `risk-per-trade cap (${limits.maxRiskPerTradePct}% at ${req.stopDistancePct.toFixed(0)}% stop)`);
  const tokenNow = state.open.filter((o) => o.tokenMint === req.tokenMint).reduce((s, o) => s + o.valueUsd, 0);
  cap((eq * limits.maxExposurePerTokenPct) / 100 - tokenNow, 'per-token exposure cap');
  for (const n of req.narrativeIds) {
    const narNow = state.open.filter((o) => o.narrativeIds.includes(n)).reduce((s, o) => s + o.valueUsd, 0);
    cap((eq * limits.maxExposurePerNarrativePct) / 100 - narNow, `per-narrative exposure cap (${n})`);
  }
  const corrNow = state.open.filter((o) => o.correlationKey === req.correlationKey).reduce((s, o) => s + o.valueUsd, 0);
  cap((eq * limits.maxCorrelatedExposurePct) / 100 - corrNow, 'correlated exposure cap');
  if (req.highRisk && state.open.filter((o) => o.highRisk).length >= limits.maxSimultaneousHighRisk) cap(0, 'max simultaneous high-risk positions reached');
  const reserve = (eq * limits.minReservePct) / 100;
  cap(state.cashUsd - reserve, 'cash/SOL reserve floor');
  return { allowedUsd: Math.max(0, allowed), halted: false, reasons };
}
