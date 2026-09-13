import type { LeaderboardSnapshot, LeaderboardWindow } from '../types.js';
import type { Envelope } from '../events/bus.js';
import type { HttpClient, SourceAdapter } from './types.js';

export interface PlatformConfig {
  name: 'fomo' | 'axiom' | 'fomp';
  baseUrl?: string;
  apiKey?: string;
  /** Path template for leaderboards; `{window}` is substituted. Must be an official/licensed endpoint. */
  leaderboardPath?: string;
  windows?: LeaderboardWindow[];
  /** Map the platform's JSON into leaderboard entries. Provided per licensed integration. */
  mapLeaderboard?: (json: unknown, window: LeaderboardWindow) => LeaderboardSnapshot['entries'];
}

/**
 * Discovery-platform adapter (FOMO / Axiom / Fomp). These products are signal surfaces,
 * never authoritative truth (spec §5). The adapter only calls an explicitly configured
 * official/licensed endpoint; it never scrapes HTML and never assumes an undocumented API.
 */
export class PlatformAdapter implements SourceAdapter {
  name: string;
  kind = 'platform' as const;
  constructor(private cfg: PlatformConfig, private fetchFn: HttpClient = fetch) {
    this.name = cfg.name;
  }
  async health() {
    if (!this.cfg.baseUrl || !this.cfg.leaderboardPath || !this.cfg.mapLeaderboard) return { ok: false, detail: `${this.cfg.name}: no official/licensed endpoint configured` };
    return { ok: true };
  }
  async poll(_since: number, now: number): Promise<Envelope[]> {
    if (!(await this.health()).ok) return [];
    const out: Envelope[] = [];
    for (const window of this.cfg.windows ?? ['24h', '7d', '30d', 'all']) {
      const url = `${this.cfg.baseUrl}${this.cfg.leaderboardPath!.replace('{window}', window)}`;
      const r = await this.fetchFn(url, { headers: this.cfg.apiKey ? { authorization: `Bearer ${this.cfg.apiKey}` } : {} });
      if (!r.ok) continue;
      const entries = this.cfg.mapLeaderboard!(await r.json(), window);
      out.push({ topic: 'platform.leaderboard', payload: { source: this.cfg.name, window, capturedAt: now, entries }, timestamp: now, source: this.cfg.name });
    }
    return out;
  }
}
