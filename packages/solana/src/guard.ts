import { Connection } from '@solana/web3.js';
import { JupiterClient, JupiterQuoteSource, type JupiterOptions } from './jupiter.js';
import { loadKeypair } from './keypair.js';
import { SolanaTransactionSender } from './sender.js';
import { LAMPORTS_PER_SOL, type SolanaRpc } from './types.js';

export interface LiveExecutionConfig {
  /** Must be literally true; anything else keeps execution in paper mode. */
  enabled: boolean;
  /** Must equal "I-ACCEPT-TOTAL-LOSS"; a second, explicit acknowledgement that real funds are at risk. */
  acknowledgement?: string;
  rpcUrls: string[];
  maxTradeUsd: number;
  dailyCapUsd: number;
  /** Refuse to start if the hot wallet holds less SOL than this (fees + at least one trade). */
  minWalletSol?: number;
  /** Refuse to start if the hot wallet holds more SOL than this (protects against pointing it at a main wallet). */
  maxWalletSol?: number;
  jupiter?: JupiterOptions;
  env?: NodeJS.ProcessEnv;
}

export const LIVE_ACK = 'I-ACCEPT-TOTAL-LOSS';

export interface LiveExecution {
  sender: SolanaTransactionSender;
  quoteSource: JupiterQuoteSource;
  jupiter: JupiterClient;
  walletAddress: string;
  walletSol: number;
  limits: { maxTradeUsd: number; dailyCapUsd: number };
}

/**
 * Gate for live on-chain execution (spec §23 phase 6: "live execution with strict limits and
 * kill switches"). Every check must pass or the platform stays in paper mode:
 * explicit enable flag + acknowledgement phrase, positive caps, a loadable hot-wallet key,
 * a reachable RPC, and a wallet balance inside the [min, max] SOL band.
 */
export async function createLiveExecution(cfg: LiveExecutionConfig, rpc?: SolanaRpc): Promise<LiveExecution> {
  if (cfg.enabled !== true) throw new Error('live execution is disabled (LIVE_EXECUTION_ENABLED != true)');
  if (cfg.acknowledgement !== LIVE_ACK) throw new Error(`live execution requires LIVE_EXECUTION_ACK=${LIVE_ACK}`);
  if (!(cfg.maxTradeUsd > 0) || !(cfg.dailyCapUsd > 0)) throw new Error('LIVE_MAX_TRADE_USD and LIVE_DAILY_CAP_USD must be positive');
  if (cfg.maxTradeUsd > cfg.dailyCapUsd) throw new Error('LIVE_MAX_TRADE_USD cannot exceed LIVE_DAILY_CAP_USD');
  if (!cfg.rpcUrls.length) throw new Error('SOLANA_RPC_URLS required');
  const keypair = loadKeypair(cfg.env ?? process.env);
  const connection = rpc ?? (new Connection(cfg.rpcUrls[0], 'confirmed') as unknown as SolanaRpc);
  const lamports = await connection.getBalance(keypair.publicKey);
  const sol = lamports / LAMPORTS_PER_SOL;
  const min = cfg.minWalletSol ?? 0.05;
  const max = cfg.maxWalletSol ?? 50;
  if (sol < min) throw new Error(`hot wallet ${keypair.publicKey.toBase58()} holds ${sol.toFixed(4)} SOL (< ${min}); fund it or lower LIVE_MIN_WALLET_SOL`);
  if (sol > max) throw new Error(`hot wallet holds ${sol.toFixed(2)} SOL (> ${max}); refusing: use a small dedicated hot wallet`);
  const jupiter = new JupiterClient(cfg.jupiter);
  await jupiter.solPriceUsd(); // proves the price API is reachable before arming
  const sender = new SolanaTransactionSender(connection, jupiter, keypair);
  return { sender, quoteSource: new JupiterQuoteSource(jupiter), jupiter, walletAddress: keypair.publicKey.toBase58(), walletSol: sol, limits: { maxTradeUsd: cfg.maxTradeUsd, dailyCapUsd: cfg.dailyCapUsd } };
}
