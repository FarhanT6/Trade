import type { Chain, Pool } from '../types.js';
import type { Envelope } from '../events/bus.js';
import { RateLimiter, type HttpClient, type SourceAdapter } from './types.js';

/** DexScreener public API adapter: pairs, liquidity, volume, prices (secondary to chain truth). */
export class DexScreenerAdapter implements SourceAdapter {
  name = 'dexscreener';
  kind = 'dex' as const;
  private limiter = new RateLimiter(280);
  constructor(private baseUrl = 'https://api.dexscreener.com', private fetchFn: HttpClient = fetch, private chains: Chain[] = ['solana']) {}
  async health() {
    try {
      const r = await this.fetchFn(`${this.baseUrl}/token-boosts/latest/v1`);
      return { ok: r.ok, detail: `status ${r.status}` };
    } catch (e) {
      return { ok: false, detail: (e as Error).message };
    }
  }
  async poll(_since: number, now: number): Promise<Envelope[]> {
    const out: Envelope[] = [];
    for (const chain of this.chains) {
      if (!this.limiter.take()) break;
      const r = await this.fetchFn(`${this.baseUrl}/token-profiles/latest/v1`);
      if (!r.ok) continue;
      const profiles = (await r.json()) as Array<{ chainId: string; tokenAddress: string }>;
      const addrs = profiles.filter((p) => p.chainId === chain).slice(0, 30).map((p) => p.tokenAddress);
      if (addrs.length === 0) continue;
      const pr = await this.fetchFn(`${this.baseUrl}/tokens/v1/${chain}/${addrs.join(',')}`);
      if (!pr.ok) continue;
      const pairs = (await pr.json()) as Array<{ pairAddress: string; dexId: string; baseToken: { address: string }; quoteToken: { address: string }; liquidity?: { usd?: number; base?: number; quote?: number }; pairCreatedAt?: number }>;
      for (const p of pairs) {
        const pool: Pool = {
          id: p.pairAddress,
          chain,
          tokenMint: p.baseToken.address,
          quoteMint: p.quoteToken.address,
          dex: p.dexId,
          tokenReserve: p.liquidity?.base ?? 0,
          quoteReserveUsd: (p.liquidity?.usd ?? 0) / 2,
          liquidityUsd: p.liquidity?.usd ?? 0,
          lpOwner: 'unknown',
          lpLockedPct: 0,
          createdAt: p.pairCreatedAt ?? now,
          freshness: { asOf: now, source: this.name, confidence: 0.7 },
        };
        out.push({ topic: 'chain.pool', payload: pool, timestamp: now, source: this.name });
      }
    }
    return out;
  }
}
