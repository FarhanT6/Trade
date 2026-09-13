import type { Position, TraderArchetype, TraderProfile } from '../types.js';
import { MS, mean, median, ratio } from '../util/stats.js';

export interface ArchetypeSignals {
  /** Median entry latency from launch/migration. */
  medianEntryLatencyMs: number;
  medianHoldMs: number;
  tradesPerDay: number;
  /** Fraction of positions with >=3 buy fills before any sell. */
  scaledEntries: number;
  /** Fraction of entries after a >50% 15m price acceleration (set by feature joiner). */
  momentumEntries?: number;
  /** Fraction of entries during accelerating narrative velocity. */
  narrativeEntries?: number;
  /** Fraction of entries during 15m price decline. */
  weaknessEntries?: number;
  exitQuality: number;
  /** Fraction of two-sided volume (buy+sell roughly balanced per token per hour). */
  twoSidedRatio?: number;
}

export function classifyArchetype(
  positions: Position[],
  profile: Omit<TraderProfile, 'archetype' | 'archetypeConfidence'>,
  clusterLabel: 'insider-cluster' | 'market-maker' | null,
  extra?: Partial<ArchetypeSignals>,
): { archetype: TraderArchetype; confidence: number } {
  if (clusterLabel === 'insider-cluster') return { archetype: 'insider-cluster', confidence: 0.9 };
  if (clusterLabel === 'market-maker') return { archetype: 'market-maker', confidence: 0.85 };
  if (positions.length < 3) return { archetype: 'unclassified', confidence: 0 };

  const spanDays = Math.max(1 / 24, (Math.max(...positions.map((p) => p.closedAt ?? p.openedAt)) - Math.min(...positions.map((p) => p.openedAt))) / MS.d);
  const s: ArchetypeSignals = {
    medianEntryLatencyMs: profile.medianEntryLatencyMs,
    medianHoldMs: profile.medianHoldMs,
    tradesPerDay: positions.length / spanDays,
    scaledEntries: extra?.scaledEntries ?? 0,
    exitQuality: profile.exitQuality,
    ...extra,
  };
  const scores: Array<[TraderArchetype, number]> = [
    ['sniper', s.medianEntryLatencyMs < 5 * MS.m ? 1 : s.medianEntryLatencyMs < 30 * MS.m ? 0.5 : 0],
    ['scalper', s.tradesPerDay > 20 && s.medianHoldMs < 15 * MS.m ? 1 : s.tradesPerDay > 8 && s.medianHoldMs < MS.h ? 0.5 : 0],
    ['swing', s.medianHoldMs > 4 * MS.h ? (s.medianHoldMs > 24 * MS.h ? 1 : 0.7) : 0],
    ['accumulator', s.scaledEntries > 0.5 ? 1 : s.scaledEntries > 0.3 ? 0.5 : 0],
    ['momentum', (s.momentumEntries ?? 0) > 0.5 ? 1 : (s.momentumEntries ?? 0) > 0.3 ? 0.5 : 0],
    ['narrative', (s.narrativeEntries ?? 0) > 0.5 ? 1 : 0],
    ['contrarian', (s.weaknessEntries ?? 0) > 0.5 ? 1 : 0],
    ['exit-specialist', s.exitQuality > 0.75 && positions.length >= 8 ? 1 : s.exitQuality > 0.6 ? 0.4 : 0],
    ['market-maker', (s.twoSidedRatio ?? 0) > 0.7 ? 1 : 0],
  ];
  scores.sort((a, b) => b[1] - a[1]);
  const [best, second] = scores;
  if (best[1] === 0) return { archetype: 'unclassified', confidence: 0.2 };
  const confidence = Math.min(1, 0.5 + 0.5 * (best[1] - (second?.[1] ?? 0)));
  return { archetype: best[0], confidence };
}

/** Helper for feature joiners: count multi-fill entries. */
export function scaledEntryRatio(fillsPerPosition: number[]): number {
  return ratio(fillsPerPosition.filter((n) => n >= 3).length, fillsPerPosition.length);
}

export const _internal = { mean, median };
