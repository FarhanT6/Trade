import type { TokenSecurity } from '../types.js';
import type { Envelope } from '../events/bus.js';
import type { HttpClient, SourceAdapter } from './types.js';

/**
 * Solana JSON-RPC adapter for ground-truth mint state (authorities + Token-2022 extensions).
 * Uses jsonParsed account data so no borsh dependency is required.
 */
export class SolanaRpcAdapter implements SourceAdapter {
  name = 'solana-rpc';
  kind = 'chain' as const;
  private watch = new Set<string>();
  constructor(private urls: string[], private fetchFn: HttpClient = fetch) {}
  track(mint: string): void {
    this.watch.add(mint);
  }
  private async rpc(method: string, params: unknown[]): Promise<any> {
    let lastErr: Error | null = null;
    for (const url of this.urls) {
      try {
        const r = await this.fetchFn(url, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ jsonrpc: '2.0', id: 1, method, params }) });
        if (!r.ok) throw new Error(`rpc ${r.status}`);
        const j = (await r.json()) as { result?: unknown; error?: { message: string } };
        if (j.error) throw new Error(j.error.message);
        return j.result;
      } catch (e) {
        lastErr = e as Error;
      }
    }
    throw lastErr ?? new Error('no rpc');
  }
  async health() {
    try {
      const v = await this.rpc('getVersion', []);
      return { ok: true, detail: `solana-core ${v?.['solana-core'] ?? '?'}` };
    } catch (e) {
      return { ok: false, detail: (e as Error).message };
    }
  }
  async fetchSecurity(mint: string, now: number): Promise<TokenSecurity | null> {
    const res = await this.rpc('getAccountInfo', [mint, { encoding: 'jsonParsed' }]);
    const parsed = res?.value?.data?.parsed;
    if (!parsed || parsed.type !== 'mint') return null;
    const info = parsed.info ?? {};
    const exts: Array<{ extension: string; state?: any }> = info.extensions ?? [];
    const names = exts.map((e) => e.extension);
    const fee = exts.find((e) => e.extension === 'transferFeeConfig');
    const pd = exts.find((e) => e.extension === 'permanentDelegate');
    const das = exts.find((e) => e.extension === 'defaultAccountState');
    return {
      tokenMint: mint,
      mintAuthority: info.mintAuthority ?? null,
      freezeAuthority: info.freezeAuthority ?? null,
      metadataMutable: names.includes('tokenMetadata') ? true : false,
      token2022Extensions: names.map(normalizeExt),
      transferFeeBps: fee?.state?.newerTransferFee?.transferFeeBasisPoints ?? undefined,
      permanentDelegate: pd?.state?.delegate ?? null,
      defaultAccountStateFrozen: das?.state?.accountState === 'frozen',
      freshness: { asOf: now, source: this.name, confidence: 1 },
    };
  }
  async poll(_since: number, now: number): Promise<Envelope[]> {
    const out: Envelope[] = [];
    for (const mint of this.watch) {
      try {
        const s = await this.fetchSecurity(mint, now);
        if (s) out.push({ topic: 'chain.security', payload: s, timestamp: now, source: this.name });
      } catch {
        /* keep going; missing data surfaces as SECURITY_UNAVAILABLE downstream */
      }
    }
    return out;
  }
}

function normalizeExt(name: string): string {
  const map: Record<string, string> = { transferFeeConfig: 'transferFee', permanentDelegate: 'permanentDelegate', defaultAccountState: 'defaultAccountState', transferHook: 'transferHook', confidentialTransferMint: 'confidentialTransfer', nonTransferable: 'nonTransferable', tokenMetadata: 'metadata', metadataPointer: 'metadataPointer', interestBearingConfig: 'interestBearing' };
  return map[name] ?? name;
}
