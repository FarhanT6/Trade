/** Small, dependency-free statistics helpers used across engines. */

export function sum(xs: number[]): number {
  let s = 0;
  for (const x of xs) s += x;
  return s;
}

export function mean(xs: number[]): number {
  return xs.length === 0 ? 0 : sum(xs) / xs.length;
}

export function median(xs: number[]): number {
  if (xs.length === 0) return 0;
  const s = [...xs].sort((a, b) => a - b);
  const mid = Math.floor(s.length / 2);
  return s.length % 2 === 0 ? (s[mid - 1] + s[mid]) / 2 : s[mid];
}

export function quantile(xs: number[], q: number): number {
  if (xs.length === 0) return 0;
  const s = [...xs].sort((a, b) => a - b);
  const pos = (s.length - 1) * q;
  const lo = Math.floor(pos);
  const hi = Math.ceil(pos);
  if (lo === hi) return s[lo];
  return s[lo] + (s[hi] - s[lo]) * (pos - lo);
}

export function stddev(xs: number[]): number {
  if (xs.length < 2) return 0;
  const m = mean(xs);
  return Math.sqrt(sum(xs.map((x) => (x - m) ** 2)) / (xs.length - 1));
}

export function clamp(x: number, lo: number, hi: number): number {
  return Math.max(lo, Math.min(hi, x));
}

/** Map x in [lo, hi] to 0..100 linearly, clamped. */
export function scale100(x: number, lo: number, hi: number): number {
  if (hi === lo) return 0;
  return clamp(((x - lo) / (hi - lo)) * 100, 0, 100);
}

/** Logistic squashing to 0..1 with a midpoint and slope. */
export function sigmoid(x: number, mid = 0, k = 1): number {
  return 1 / (1 + Math.exp(-k * (x - mid)));
}

/** Ratio helper that never divides by zero; returns `fallback` when denominator is 0. */
export function ratio(num: number, den: number, fallback = 0): number {
  return den === 0 ? fallback : num / den;
}

/**
 * Acceleration = current / previous, capped; 1 = flat, >1 accelerating. `floor` is the
 * smallest denominator considered meaningful, so one trade after silence is not "50x".
 */
export function acceleration(current: number, previous: number, cap = 50, floor = 1): number {
  const base = Math.max(previous, floor);
  if (base <= 0) return current > 0 ? cap : 1;
  return clamp(current / base, 0, cap);
}

export function pearson(xs: number[], ys: number[]): number {
  const n = Math.min(xs.length, ys.length);
  if (n < 2) return 0;
  const mx = mean(xs.slice(0, n));
  const my = mean(ys.slice(0, n));
  let num = 0;
  let dx = 0;
  let dy = 0;
  for (let i = 0; i < n; i++) {
    const a = xs[i] - mx;
    const b = ys[i] - my;
    num += a * b;
    dx += a * a;
    dy += b * b;
  }
  const den = Math.sqrt(dx * dy);
  return den === 0 ? 0 : num / den;
}

/** Cross-correlation for lags -maxLag..maxLag; positive lag means xs leads ys. */
export function leadLag(xs: number[], ys: number[], maxLag: number): { lag: number; corr: number } {
  let best = { lag: 0, corr: -Infinity };
  for (let lag = -maxLag; lag <= maxLag; lag++) {
    const a: number[] = [];
    const b: number[] = [];
    for (let i = 0; i < xs.length; i++) {
      const j = i + lag;
      if (j >= 0 && j < ys.length) {
        a.push(xs[i]);
        b.push(ys[j]);
      }
    }
    const c = pearson(a, b);
    if (c > best.corr) best = { lag, corr: c };
  }
  if (best.corr === -Infinity) best.corr = 0;
  return best;
}

/** Deterministic seeded PRNG (mulberry32). */
export function rng(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

export function hashString(s: string): number {
  let h = 2166136261;
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 16777619);
  }
  return h >>> 0;
}

export function unique<T>(xs: Iterable<T>): T[] {
  return [...new Set(xs)];
}

export function groupBy<T, K extends string | number>(xs: T[], key: (x: T) => K): Map<K, T[]> {
  const m = new Map<K, T[]>();
  for (const x of xs) {
    const k = key(x);
    const arr = m.get(k);
    if (arr) arr.push(x);
    else m.set(k, [x]);
  }
  return m;
}

export const MS = { s: 1000, m: 60_000, h: 3_600_000, d: 86_400_000 } as const;

export const INTERVAL_MS = { '1m': MS.m, '5m': 5 * MS.m, '15m': 15 * MS.m, '1h': MS.h } as const;
