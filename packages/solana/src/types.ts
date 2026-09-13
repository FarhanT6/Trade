/** Minimal RPC surface used by the sender, so tests can inject a fake and production uses `Connection`. */
export interface SolanaRpc {
  simulateTransaction(tx: import('@solana/web3.js').VersionedTransaction, opts?: { replaceRecentBlockhash?: boolean; commitment?: string; sigVerify?: boolean }): Promise<{ value: { err: unknown; logs?: string[] | null; unitsConsumed?: number } }>;
  sendRawTransaction(raw: Uint8Array, opts?: { skipPreflight?: boolean; maxRetries?: number; preflightCommitment?: string }): Promise<string>;
  getSignatureStatuses(sigs: string[]): Promise<{ value: Array<{ confirmationStatus?: string | null; err: unknown } | null> }>;
  getParsedTransaction(sig: string, opts?: { maxSupportedTransactionVersion?: number; commitment?: string }): Promise<ParsedTx | null>;
  getBalance(pubkey: import('@solana/web3.js').PublicKey): Promise<number>;
}

export interface ParsedTx {
  meta: {
    err: unknown;
    fee: number;
    preBalances: number[];
    postBalances: number[];
    preTokenBalances?: Array<{ mint: string; owner?: string; uiTokenAmount: { uiAmount: number | null; amount: string; decimals: number } }> | null;
    postTokenBalances?: Array<{ mint: string; owner?: string; uiTokenAmount: { uiAmount: number | null; amount: string; decimals: number } }> | null;
  } | null;
  transaction: { message: { accountKeys: Array<{ pubkey: { toBase58(): string } | string }> } };
}

export type Fetch = (url: string, init?: RequestInit) => Promise<Response>;

export const SOL_MINT = 'So11111111111111111111111111111111111111112';
export const LAMPORTS_PER_SOL = 1_000_000_000;
