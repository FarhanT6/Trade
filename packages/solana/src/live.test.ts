import { describe, expect, it } from 'vitest';
import { Keypair, PublicKey, SystemProgram, TransactionMessage, VersionedTransaction } from '@solana/web3.js';
import type { Order, Quote } from '@meme-intel/core';
import { JupiterClient, JupiterQuoteSource } from './jupiter.js';
import { SolanaTransactionSender } from './sender.js';
import { createLiveExecution, LIVE_ACK } from './guard.js';
import { LAMPORTS_PER_SOL, SOL_MINT, type ParsedTx, type SolanaRpc } from './types.js';
import bs58 from 'bs58';

const MINT = 'MemeMint1111111111111111111111111111111111';
const wallet = Keypair.generate();
const NOW = 1_800_000_000_000;

/** A real, signable v0 transaction so deserialize/sign/serialize run for real. */
function dummySwapTxBase64(): string {
  const msg = new TransactionMessage({
    payerKey: wallet.publicKey,
    recentBlockhash: bs58.encode(new Uint8Array(32).fill(7)),
    instructions: [SystemProgram.transfer({ fromPubkey: wallet.publicKey, toPubkey: Keypair.generate().publicKey, lamports: 1 })],
  }).compileToV0Message();
  return Buffer.from(new VersionedTransaction(msg).serialize()).toString('base64');
}

function fakeFetch(overrides: { quote?: Partial<Record<string, unknown>>; swapStatus?: number } = {}) {
  const calls: string[] = [];
  const fn = async (url: string, init?: RequestInit): Promise<Response> => {
    calls.push(url);
    const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });
    if (url.includes('/price/')) return json({ [SOL_MINT]: { usdPrice: 200, decimals: 9 }, [MINT]: { usdPrice: 0.001, decimals: 6 } });
    if (url.includes('/quote')) {
      const u = new URL(url);
      const buy = u.searchParams.get('inputMint') === SOL_MINT;
      const amount = Number(u.searchParams.get('amount'));
      // buy: lamports in -> tokens out at $0.001 with 1% impact; sell: tokens in -> lamports out
      const out = buy ? Math.floor(((amount / LAMPORTS_PER_SOL) * 200) / 0.001 * 0.99 * 1e6) : Math.floor(((amount / 1e6) * 0.001) / 200 * 0.99 * LAMPORTS_PER_SOL);
      return json({ inputMint: u.searchParams.get('inputMint'), outputMint: u.searchParams.get('outputMint'), inAmount: String(amount), outAmount: String(out), otherAmountThreshold: String(out), slippageBps: 300, priceImpactPct: '0.01', routePlan: [{ swapInfo: { label: 'Raydium' }, percent: 100 }], ...overrides.quote });
    }
    if (url.endsWith('/swap')) {
      expect(init?.method).toBe('POST');
      return json({ swapTransaction: dummySwapTxBase64(), lastValidBlockHeight: 1 }, overrides.swapStatus ?? 200);
    }
    return json({ error: 'unexpected' }, 404);
  };
  return { fn, calls };
}

function fakeRpc(opts: { simErr?: unknown; statusErr?: unknown; parsed?: ParsedTx | null; balanceLamports?: number } = {}) {
  const sent: Uint8Array[] = [];
  const rpc: SolanaRpc = {
    async simulateTransaction() {
      return { value: { err: opts.simErr ?? null, logs: ['ok'], unitsConsumed: 120_000 } };
    },
    async sendRawTransaction(raw) {
      sent.push(raw);
      return 'SIG'.padEnd(64, '1');
    },
    async getSignatureStatuses() {
      return { value: [{ confirmationStatus: 'confirmed', err: opts.statusErr ?? null }] };
    },
    async getParsedTransaction() {
      return opts.parsed === undefined ? null : opts.parsed;
    },
    async getBalance() {
      return opts.balanceLamports ?? 0.5 * LAMPORTS_PER_SOL;
    },
  };
  return { rpc, sent };
}

function parsedBuy(tokensOut: number, solSpent: number): ParsedTx {
  const w = wallet.publicKey.toBase58();
  return {
    meta: { err: null, fee: 5000, preBalances: [LAMPORTS_PER_SOL, 0], postBalances: [LAMPORTS_PER_SOL - solSpent * LAMPORTS_PER_SOL, 0], preTokenBalances: [], postTokenBalances: [{ mint: MINT, owner: w, uiTokenAmount: { uiAmount: tokensOut, amount: String(tokensOut * 1e6), decimals: 6 } }] },
    transaction: { message: { accountKeys: [{ pubkey: w }, { pubkey: 'other' }] } },
  };
}

const order = (side: 'buy' | 'sell', extra: Partial<Order> = {}): Order => ({ id: 'o1', tokenMint: MINT, side, sizeUsd: 50, status: 'requested', mode: 'live', createdAt: NOW, updatedAt: NOW, ...extra });
const quote: Quote = { route: 'Raydium', provider: 'jupiter', inputUsd: 50, expectedOutputUsd: 49.5, expectedImpactPct: 1, worstCaseImpactPct: 4, estimatedFeeUsd: 0.01, priorityFeeUsd: 0.4, simulatedSuccessProbability: 0.95, latencyMs: 200, quotedAt: NOW };

describe('JupiterQuoteSource', () => {
  it('maps a Jupiter quote into the execution engine Quote shape for buys and sells', async () => {
    const jup = new JupiterClient({ fetchFn: fakeFetch().fn });
    const src = new JupiterQuoteSource(jup, () => 100);
    const pool = { id: 'p', chain: 'solana' as const, tokenMint: MINT, quoteMint: SOL_MINT, dex: 'raydium', tokenReserve: 1e9, quoteReserveUsd: 50_000, liquidityUsd: 100_000, lpOwner: 'x', lpLockedPct: 1, createdAt: NOW, freshness: { asOf: NOW, source: 't', confidence: 1 } };
    const buy = await src.quote(pool, 'buy', 50, NOW);
    expect(buy).not.toBeNull();
    expect(buy!.expectedImpactPct).toBeCloseTo(1, 5);
    expect(buy!.expectedOutputUsd).toBeCloseTo(49.5, 1);
    expect(buy!.route).toBe('Raydium');
    const sell = await src.quote(pool, 'sell', 50, NOW);
    expect(sell!.expectedOutputUsd).toBeCloseTo(49.5, 1);
  });
  it('rejects routes through DEXes outside the allowlist', async () => {
    const jup = new JupiterClient({ fetchFn: fakeFetch().fn, allowedDexes: ['Orca'] });
    await expect(jup.quote(SOL_MINT, MINT, 1000n)).rejects.toThrow(/allowlist/);
  });
});

describe('SolanaTransactionSender', () => {
  it('quotes fresh, signs, simulates, sends, confirms and parses the fill from balance deltas', async () => {
    const f = fakeFetch();
    const { rpc, sent } = fakeRpc({ parsed: parsedBuy(24_750, 0.2505) });
    const sender = new SolanaTransactionSender(rpc, new JupiterClient({ fetchFn: f.fn }), wallet, { now: () => NOW, sleep: async () => {} });
    const fill = await sender.send(order('buy'), quote);
    expect(sent).toHaveLength(1);
    const tx = VersionedTransaction.deserialize(sent[0]);
    expect(tx.signatures[0].some((b) => b !== 0)).toBe(true); // actually signed
    expect(fill.filledTokenAmount).toBe(24_750);
    expect(fill.filledUsd).toBeCloseTo(50.1, 5); // 0.2505 SOL * $200 incl. fees
    expect(fill.filledPriceUsd).toBeCloseTo(50.1 / 24_750, 8);
    expect(f.calls.some((u) => u.includes('/quote'))).toBe(true);
    expect(f.calls.some((u) => u.endsWith('/swap'))).toBe(true);
  });
  it('falls back to the quote-implied fill when the parsed transaction is unavailable', async () => {
    const { rpc } = fakeRpc({ parsed: null });
    const sender = new SolanaTransactionSender(rpc, new JupiterClient({ fetchFn: fakeFetch().fn }), wallet, { now: () => NOW, sleep: async () => {} });
    const fill = await sender.send(order('sell', { amountToken: 10_000 }), quote);
    expect(fill.filledTokenAmount).toBe(10_000);
    expect(fill.filledUsd).toBeCloseTo(9.9, 2);
  });
  it('never sends when the on-chain simulation fails', async () => {
    const { rpc, sent } = fakeRpc({ simErr: { InstructionError: [2, 'Custom'] } });
    const sender = new SolanaTransactionSender(rpc, new JupiterClient({ fetchFn: fakeFetch().fn }), wallet, { now: () => NOW, sleep: async () => {} });
    await expect(sender.send(order('buy'), quote)).rejects.toThrow(/simulation failed/);
    expect(sent).toHaveLength(0);
  });
  it('refuses when the fresh quote impact exceeds the engine quote worst case', async () => {
    const { rpc, sent } = fakeRpc({});
    const sender = new SolanaTransactionSender(rpc, new JupiterClient({ fetchFn: fakeFetch({ quote: { priceImpactPct: '0.12' } }).fn }), wallet, { now: () => NOW, sleep: async () => {} });
    await expect(sender.send(order('buy'), quote)).rejects.toThrow(/impact moved/);
    expect(sent).toHaveLength(0);
  });
  it('surfaces on-chain failure after send and requires a sell amount', async () => {
    const { rpc } = fakeRpc({ statusErr: { InstructionError: [3, 'SlippageToleranceExceeded'] } });
    const sender = new SolanaTransactionSender(rpc, new JupiterClient({ fetchFn: fakeFetch().fn }), wallet, { now: () => NOW, sleep: async () => {} });
    await expect(sender.send(order('buy'), quote)).rejects.toThrow(/failed on-chain/);
    const jup = new JupiterClient({ fetchFn: async (u) => (u.includes('/price/') ? new Response(JSON.stringify({ [SOL_MINT]: { usdPrice: 200, decimals: 9 } })) : new Response('{}', { status: 404 })) });
    await expect(new SolanaTransactionSender(rpc, jup, wallet, { now: () => NOW, sleep: async () => {} }).send(order('sell'), quote)).rejects.toThrow(/unknown token amount/);
  });
});

describe('live execution guard', () => {
  const env = { SOLANA_PRIVATE_KEY: bs58.encode(wallet.secretKey) };
  const base = { enabled: true, acknowledgement: LIVE_ACK, rpcUrls: ['http://rpc'], maxTradeUsd: 50, dailyCapUsd: 200, env, jupiter: { fetchFn: fakeFetch().fn } };
  it('refuses unless every gate passes', async () => {
    const { rpc } = fakeRpc({});
    await expect(createLiveExecution({ ...base, enabled: false }, rpc)).rejects.toThrow(/disabled/);
    await expect(createLiveExecution({ ...base, acknowledgement: 'yes' }, rpc)).rejects.toThrow(/LIVE_EXECUTION_ACK/);
    await expect(createLiveExecution({ ...base, maxTradeUsd: 0 }, rpc)).rejects.toThrow(/positive/);
    await expect(createLiveExecution({ ...base, maxTradeUsd: 500 }, rpc)).rejects.toThrow(/cannot exceed/);
    await expect(createLiveExecution({ ...base, env: {} }, rpc)).rejects.toThrow(/no wallet/);
    await expect(createLiveExecution(base, fakeRpc({ balanceLamports: 0.001 * LAMPORTS_PER_SOL }).rpc)).rejects.toThrow(/fund it/);
    await expect(createLiveExecution(base, fakeRpc({ balanceLamports: 500 * LAMPORTS_PER_SOL }).rpc)).rejects.toThrow(/small dedicated hot wallet/);
  });
  it('arms with a funded hot wallet and exposes caps and address', async () => {
    const live = await createLiveExecution(base, fakeRpc({}).rpc);
    expect(live.walletAddress).toBe(wallet.publicKey.toBase58());
    expect(live.walletSol).toBeCloseTo(0.5, 6);
    expect(live.limits).toEqual({ maxTradeUsd: 50, dailyCapUsd: 200 });
    expect(live.sender.walletAddress).toBe(wallet.publicKey.toBase58());
    expect(new PublicKey(live.walletAddress).equals(wallet.publicKey)).toBe(true);
  });
});
