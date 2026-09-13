export const API_URL = process.env.NEXT_PUBLIC_API_URL ?? 'http://localhost:4000';

export interface WatchRow { symbol: string; tokenMint: string; decision: string; alpha: number; netEvPct: number; security: number; rugProbability: number; catalyst: string | null; freshnessMs: number; momentum: number; smartMoney: number; narrative: number; liquidityUsd: number; priceUsd: number; marketCapUsd: number }
export interface AlertRow { id: string; kind: string; symbol: string; tokenMint: string; timestamp: number; rank: number; severity: string; title: string; explanation: string }
export interface Snapshot {
  now: number;
  regime: { regime: string; breadth: number; volumeVsAverage: number };
  watchlist: WatchRow[];
  alerts: AlertRow[];
  narratives: Array<{ id: string; label: string; momentum: string; momentumScore: number; authenticity: number; catalyst?: string; tokenMints: string[]; sentiment: { bullish: number; bearish: number } }>;
  leaderboards: Record<string, Array<{ wallet: string; riskAdjustedSkill: number; realizedPnlUsd: number; winRate: number; profitFactor: number; averageR: number; sampleSize: number; archetype: string; medianHoldMs: number; maxDrawdownPct: number; rugExposure: number; survivability: number }>>;
  cohorts: Array<{ window: string; size: number; independentClusters: number; commonTokens: Array<{ symbol: string; tokenMint: string; traders: string[]; independentClusters: number; consensusScore: number; medianEntryMcapUsd: number; medianEntryAgeMs: number; medianHoldMs: number; firstEntry: { wallet: string; at: number }; leadLagMs: number[] }>; commonEntryZone: { medianMcapUsd: number; medianAgeMs: number }; commonHoldTime: { medianMs: number; p25Ms: number; p75Ms: number }; commonNarratives: Array<{ narrative: string; count: number }>; commonChains: Array<{ chain: string; share: number }>; commonLaunchTypes: Array<{ launchType: string; share: number }>; walletBehavior: { scaledIn: number; partialExits: number; rapidFlips: number }; leaders: Array<{ wallet: string; firstMoverRate: number }>; traderOverlap: Array<{ a: string; b: string; sharedTokens: number }> }>;
  repeatedTraders: Array<{ wallet: string; windows: string[] }>;
  clusters: number;
  portfolio: { equityUsd: number; cashUsd: number; open: number; realizedUsd: number; halted: boolean; haltReason: string | null };
  paperPositions: Array<{ symbol: string; tokenMint: string; sizeUsd: number; entryPriceUsd: number; currentPriceUsd: number; pnlPct: number; remainingFraction: number; openedAt: number }>;
  closedTrades: Array<{ tokenMint: string; pnlPct: number; pnlUsd: number; sizeUsd: number; rugged: boolean; exitAt: number }>;
  execution: { rpcHealth: number; killSwitch: { tripped: boolean; reason: string | null }; orders: number; auditEvents: number; mode: 'paper' | 'live'; liveLimits: { maxTradeUsd: number; dailyCapUsd: number }; wallet: string | null };
  feed: Array<{ ts: number; kind: string; text: string; tokenMint?: string }>;
  outcomes: number;
  similarityCases: number;
  health: Record<string, { ok: boolean; detail?: string }>;
}

export async function getJson<T>(path: string): Promise<T> {
  const r = await fetch(`${API_URL}${path}`, { cache: 'no-store' });
  if (!r.ok) throw new Error(`${path}: ${r.status}`);
  return r.json() as Promise<T>;
}

export const fmtUsd = (x: number) => (x >= 1e6 ? `$${(x / 1e6).toFixed(2)}M` : x >= 1e3 ? `$${(x / 1e3).toFixed(1)}k` : `$${x.toFixed(0)}`);
export const fmtPct = (x: number, d = 1) => `${x >= 0 ? '+' : ''}${x.toFixed(d)}%`;
export const fmtAge = (ms: number) => (ms < 60_000 ? `${Math.round(ms / 1000)}s` : ms < 3_600_000 ? `${Math.round(ms / 60_000)}m` : ms < 86_400_000 ? `${(ms / 3_600_000).toFixed(1)}h` : `${(ms / 86_400_000).toFixed(1)}d`);
export const short = (a: string) => `${a.slice(0, 4)}…${a.slice(-4)}`;
export const fmtTime = (ts: number) => new Date(ts).toISOString().slice(11, 16);
