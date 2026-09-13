import { Keypair, VersionedTransaction, type PublicKey } from '@solana/web3.js';
import type { Order, Quote, TransactionFill, TransactionSender } from '@meme-intel/core';
import type { JupiterClient } from './jupiter.js';
import { LAMPORTS_PER_SOL, SOL_MINT, type ParsedTx, type SolanaRpc } from './types.js';

export interface SenderOptions {
  confirmTimeoutMs?: number;
  pollIntervalMs?: number;
  /** Reject if the on-chain simulation reports more than this many compute units (sanity). */
  maxComputeUnits?: number;
  now?: () => number;
  sleep?: (ms: number) => Promise<void>;
}

/**
 * Live Solana execution: fresh Jupiter quote -> swap transaction -> local signature ->
 * on-chain simulation (rejects on any error) -> send -> confirmation -> fill parsed from the
 * confirmed transaction's balance changes. Throws on any failure so the execution engine
 * records it and the kill switch sees the miss.
 */
export class SolanaTransactionSender implements TransactionSender {
  readonly walletAddress: string;
  private opts: Required<SenderOptions>;
  constructor(private rpc: SolanaRpc, private jup: JupiterClient, private keypair: Keypair, opts: SenderOptions = {}) {
    this.walletAddress = keypair.publicKey.toBase58();
    this.opts = { confirmTimeoutMs: 60_000, pollIntervalMs: 1500, maxComputeUnits: 1_400_000, now: Date.now, sleep: (ms) => new Promise((r) => setTimeout(r, ms)), ...opts };
  }

  get publicKey(): PublicKey {
    return this.keypair.publicKey;
  }

  async send(order: Order, quote: Quote): Promise<TransactionFill> {
    const now = this.opts.now();
    const solUsd = await this.jup.solPriceUsd(now);
    const info = await this.jup.tokenInfo(order.tokenMint, now);
    const decimals = info?.decimals ?? 6;
    const tokenUsd = info?.usdPrice ?? (order.sizeUsd > 0 && order.amountToken ? order.sizeUsd / order.amountToken : 0);

    // Fresh quote at send time (the engine's quote may be a few hundred ms old).
    let q;
    if (order.side === 'buy') {
      q = await this.jup.quote(SOL_MINT, order.tokenMint, BigInt(Math.max(1, Math.floor((order.sizeUsd / solUsd) * LAMPORTS_PER_SOL))));
    } else {
      const tokens = order.amountToken ?? (tokenUsd > 0 ? order.sizeUsd / tokenUsd : 0);
      if (tokens <= 0) throw new Error('sell: unknown token amount');
      q = await this.jup.quote(order.tokenMint, SOL_MINT, BigInt(Math.max(1, Math.floor(tokens * 10 ** decimals))));
    }
    const freshImpact = Math.abs(Number(q.priceImpactPct)) * 100;
    if (freshImpact > quote.worstCaseImpactPct + 1) throw new Error(`impact moved: ${freshImpact.toFixed(2)}% > worst-case ${quote.worstCaseImpactPct.toFixed(2)}%`);

    const swap = await this.jup.swapTransaction(q, this.walletAddress);
    const tx = VersionedTransaction.deserialize(Buffer.from(swap.swapTransaction, 'base64'));
    tx.sign([this.keypair]);

    const sim = await this.rpc.simulateTransaction(tx, { replaceRecentBlockhash: true, commitment: 'processed' });
    if (sim.value.err) throw new Error(`simulation failed: ${JSON.stringify(sim.value.err)} ${(sim.value.logs ?? []).slice(-3).join(' | ')}`);
    if ((sim.value.unitsConsumed ?? 0) > this.opts.maxComputeUnits) throw new Error(`simulation consumed ${sim.value.unitsConsumed} CU`);

    const signature = await this.rpc.sendRawTransaction(tx.serialize(), { skipPreflight: true, maxRetries: 3 });
    await this.confirm(signature);
    const parsed = await this.rpc.getParsedTransaction(signature, { maxSupportedTransactionVersion: 0, commitment: 'confirmed' });
    return this.fillFrom(order, q, parsed, solUsd, tokenUsd, decimals, signature);
  }

  private async confirm(signature: string): Promise<void> {
    const start = this.opts.now();
    while (this.opts.now() - start < this.opts.confirmTimeoutMs) {
      const s = (await this.rpc.getSignatureStatuses([signature])).value[0];
      if (s) {
        if (s.err) throw new Error(`transaction ${signature} failed on-chain: ${JSON.stringify(s.err)}`);
        if (s.confirmationStatus === 'confirmed' || s.confirmationStatus === 'finalized') return;
      }
      await this.opts.sleep(this.opts.pollIntervalMs);
    }
    throw new Error(`transaction ${signature} not confirmed within ${this.opts.confirmTimeoutMs}ms`);
  }

  /** Fill from confirmed balance deltas; falls back to the quote if the parsed tx is unavailable. */
  private fillFrom(order: Order, q: { inAmount: string; outAmount: string }, parsed: ParsedTx | null, solUsd: number, tokenUsd: number, decimals: number, signature: string): TransactionFill {
    const meta = parsed?.meta;
    if (meta && !meta.err) {
      const keys = parsed!.transaction.message.accountKeys.map((k) => (typeof k.pubkey === 'string' ? k.pubkey : k.pubkey.toBase58()));
      const idx = keys.indexOf(this.walletAddress);
      const solDelta = idx >= 0 ? (meta.postBalances[idx] - meta.preBalances[idx]) / LAMPORTS_PER_SOL : 0;
      type TokenBal = NonNullable<NonNullable<ParsedTx['meta']>['preTokenBalances']>[number];
      const bal = (list: TokenBal[] | null | undefined) => (list ?? []).filter((b) => b.mint === order.tokenMint && b.owner === this.walletAddress).reduce((s, b) => s + (b.uiTokenAmount.uiAmount ?? Number(b.uiTokenAmount.amount) / 10 ** b.uiTokenAmount.decimals), 0);
      const tokenDelta = bal(meta.postTokenBalances) - bal(meta.preTokenBalances);
      if (order.side === 'buy' && tokenDelta > 0) {
        const spentUsd = -solDelta * solUsd; // includes network + priority fees
        return { filledTokenAmount: tokenDelta, filledUsd: spentUsd, filledPriceUsd: spentUsd / tokenDelta, signature };
      }
      if (order.side === 'sell' && tokenDelta < 0) {
        const receivedUsd = solDelta * solUsd; // net of fees
        return { filledTokenAmount: -tokenDelta, filledUsd: receivedUsd, filledPriceUsd: receivedUsd / -tokenDelta, signature };
      }
    }
    // Fallback: quote-implied fill.
    if (order.side === 'buy') {
      const tokens = Number(q.outAmount) / 10 ** decimals;
      const usd = (Number(q.inAmount) / LAMPORTS_PER_SOL) * solUsd;
      return { filledTokenAmount: tokens, filledUsd: usd, filledPriceUsd: tokens > 0 ? usd / tokens : tokenUsd, signature };
    }
    const tokens = Number(q.inAmount) / 10 ** decimals;
    const usd = (Number(q.outAmount) / LAMPORTS_PER_SOL) * solUsd;
    return { filledTokenAmount: tokens, filledUsd: usd, filledPriceUsd: tokens > 0 ? usd / tokens : tokenUsd, signature };
  }
}
