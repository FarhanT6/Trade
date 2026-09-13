import type { Pool, Quote, QuoteSource, TradeSide } from '@meme-intel/core';
import { LAMPORTS_PER_SOL, SOL_MINT, type Fetch } from './types.js';

export interface JupiterQuoteResponse {
  inputMint: string;
  outputMint: string;
  inAmount: string;
  outAmount: string;
  otherAmountThreshold: string;
  slippageBps: number;
  priceImpactPct: string;
  routePlan: Array<{ swapInfo: { label?: string; ammKey?: string }; percent: number }>;
  contextSlot?: number;
}

export interface JupiterSwapResponse {
  swapTransaction: string;
  lastValidBlockHeight: number;
  prioritizationFeeLamports?: number;
}

export interface JupiterOptions {
  /** Swap API base. Default is Jupiter's free tier; set an api.jup.ag key-based URL for higher limits. */
  swapBaseUrl?: string;
  priceBaseUrl?: string;
  apiKey?: string;
  slippageBps?: number;
  /** Maximum priority fee, in lamports, Jupiter may attach. */
  maxPriorityFeeLamports?: number;
  priorityLevel?: 'medium' | 'high' | 'veryHigh';
  fetchFn?: Fetch;
  /** Only allow routing through these DEX labels (empty = any). */
  allowedDexes?: string[];
}

interface PriceEntry { usdPrice: number; decimals: number; asOf: number }

/** Jupiter (swap aggregator) client: quotes, swap transactions and USD prices. */
export class JupiterClient {
  readonly swapBase: string;
  readonly priceBase: string;
  readonly slippageBps: number;
  readonly maxPriorityFeeLamports: number;
  readonly priorityLevel: 'medium' | 'high' | 'veryHigh';
  private fetchFn: Fetch;
  private apiKey?: string;
  private priceCache = new Map<string, PriceEntry>();
  private allowedDexes: Set<string>;

  constructor(opts: JupiterOptions = {}) {
    this.swapBase = (opts.swapBaseUrl ?? 'https://lite-api.jup.ag/swap/v1').replace(/\/$/, '');
    this.priceBase = (opts.priceBaseUrl ?? 'https://lite-api.jup.ag/price/v3').replace(/\/$/, '');
    this.slippageBps = opts.slippageBps ?? 300;
    this.maxPriorityFeeLamports = opts.maxPriorityFeeLamports ?? 2_000_000; // 0.002 SOL
    this.priorityLevel = opts.priorityLevel ?? 'high';
    this.fetchFn = opts.fetchFn ?? fetch;
    this.apiKey = opts.apiKey;
    this.allowedDexes = new Set(opts.allowedDexes ?? []);
  }

  private headers(): Record<string, string> {
    return { accept: 'application/json', 'content-type': 'application/json', ...(this.apiKey ? { 'x-api-key': this.apiKey } : {}) };
  }

  async quote(inputMint: string, outputMint: string, amount: bigint, slippageBps = this.slippageBps): Promise<JupiterQuoteResponse> {
    const u = new URL(`${this.swapBase}/quote`);
    u.searchParams.set('inputMint', inputMint);
    u.searchParams.set('outputMint', outputMint);
    u.searchParams.set('amount', amount.toString());
    u.searchParams.set('slippageBps', String(slippageBps));
    u.searchParams.set('restrictIntermediateTokens', 'true');
    const r = await this.fetchFn(u.toString(), { headers: this.headers() });
    if (!r.ok) throw new Error(`jupiter quote ${r.status}: ${(await r.text()).slice(0, 200)}`);
    const q = (await r.json()) as JupiterQuoteResponse;
    if (!q.outAmount) throw new Error('jupiter quote: no route');
    if (this.allowedDexes.size && q.routePlan.some((p) => !this.allowedDexes.has(p.swapInfo.label ?? ''))) throw new Error(`jupiter route uses a DEX outside the allowlist: ${q.routePlan.map((p) => p.swapInfo.label).join('>')}`);
    return q;
  }

  async swapTransaction(quoteResponse: JupiterQuoteResponse, userPublicKey: string): Promise<JupiterSwapResponse> {
    const r = await this.fetchFn(`${this.swapBase}/swap`, {
      method: 'POST',
      headers: this.headers(),
      body: JSON.stringify({
        quoteResponse,
        userPublicKey,
        wrapAndUnwrapSol: true,
        dynamicComputeUnitLimit: true,
        dynamicSlippage: false,
        prioritizationFeeLamports: { priorityLevelWithMaxLamports: { maxLamports: this.maxPriorityFeeLamports, priorityLevel: this.priorityLevel } },
      }),
    });
    if (!r.ok) throw new Error(`jupiter swap ${r.status}: ${(await r.text()).slice(0, 200)}`);
    const j = (await r.json()) as JupiterSwapResponse;
    if (!j.swapTransaction) throw new Error('jupiter swap: no transaction returned');
    return j;
  }

  /** USD price + decimals for mints, cached for `maxAgeMs`. Unknown mints are omitted. */
  async prices(mints: string[], now = Date.now(), maxAgeMs = 15_000): Promise<Map<string, PriceEntry>> {
    const missing = mints.filter((m) => {
      const p = this.priceCache.get(m);
      return !p || now - p.asOf > maxAgeMs;
    });
    if (missing.length) {
      const r = await this.fetchFn(`${this.priceBase}?ids=${missing.join(',')}`, { headers: this.headers() });
      if (r.ok) {
        const j = (await r.json()) as Record<string, { usdPrice?: number; decimals?: number } | null>;
        for (const [mint, v] of Object.entries(j)) if (v && typeof v.usdPrice === 'number') this.priceCache.set(mint, { usdPrice: v.usdPrice, decimals: v.decimals ?? 6, asOf: now });
      }
    }
    const out = new Map<string, PriceEntry>();
    for (const m of mints) {
      const p = this.priceCache.get(m);
      if (p) out.set(m, p);
    }
    return out;
  }

  async solPriceUsd(now = Date.now()): Promise<number> {
    const p = (await this.prices([SOL_MINT], now)).get(SOL_MINT);
    if (!p) throw new Error('SOL price unavailable');
    return p.usdPrice;
  }

  async tokenInfo(mint: string, now = Date.now()): Promise<{ usdPrice: number; decimals: number } | null> {
    return (await this.prices([mint], now)).get(mint) ?? null;
  }
}

/**
 * Real quotes for the execution engine's QuoteEngine, including the exit-path probe that
 * runs before every entry. Impact and fees come from Jupiter; the success probability is a
 * conservative estimate from route complexity and impact (the transaction is simulated again
 * on-chain before it is sent).
 */
export class JupiterQuoteSource implements QuoteSource {
  name = 'jupiter';
  constructor(private jup: JupiterClient, private latencyMs = () => 250) {}

  async quote(pool: Pool, side: TradeSide, sizeUsd: number, now: number): Promise<Quote | null> {
    const t0 = Date.now();
    const solUsd = await this.jup.solPriceUsd(now);
    const info = await this.jup.tokenInfo(pool.tokenMint, now);
    const tokenUsd = info?.usdPrice ?? (pool.tokenReserve > 0 ? pool.quoteReserveUsd / pool.tokenReserve : 0);
    const decimals = info?.decimals ?? 6;
    if (tokenUsd <= 0) return null;
    let q: JupiterQuoteResponse;
    let expectedOutputUsd: number;
    if (side === 'buy') {
      const lamports = BigInt(Math.max(1, Math.floor((sizeUsd / solUsd) * LAMPORTS_PER_SOL)));
      q = await this.jup.quote(SOL_MINT, pool.tokenMint, lamports);
      expectedOutputUsd = (Number(q.outAmount) / 10 ** decimals) * tokenUsd;
    } else {
      const units = BigInt(Math.max(1, Math.floor((sizeUsd / tokenUsd) * 10 ** decimals)));
      q = await this.jup.quote(pool.tokenMint, SOL_MINT, units);
      expectedOutputUsd = (Number(q.outAmount) / LAMPORTS_PER_SOL) * solUsd;
    }
    const impact = Math.abs(Number(q.priceImpactPct)) * 100;
    const hops = q.routePlan.length;
    const priorityFeeUsd = (this.jup.maxPriorityFeeLamports / LAMPORTS_PER_SOL) * solUsd;
    const networkFeeUsd = (5000 / LAMPORTS_PER_SOL) * solUsd * Math.max(1, hops);
    const success = Math.max(0.5, 0.97 - 0.05 * (hops - 1) - (impact > 10 ? 0.15 : impact > 5 ? 0.05 : 0));
    return {
      route: q.routePlan.map((p) => p.swapInfo.label ?? 'dex').join('>'),
      provider: this.name,
      inputUsd: sizeUsd,
      expectedOutputUsd,
      expectedImpactPct: impact,
      worstCaseImpactPct: impact + q.slippageBps / 100,
      estimatedFeeUsd: networkFeeUsd,
      priorityFeeUsd,
      simulatedSuccessProbability: success,
      latencyMs: Math.max(this.latencyMs(), Date.now() - t0),
      quotedAt: now,
    };
  }
}
