import { Keypair } from '@solana/web3.js';
import bs58 from 'bs58';
import { readFileSync } from 'node:fs';

/**
 * Load the hot-wallet keypair from `SOLANA_PRIVATE_KEY` (base58 secret key, or a JSON byte
 * array) or from `SOLANA_KEYPAIR_PATH` (solana-keygen JSON file). The hot wallet should hold
 * only the capital you are willing to lose; never a main wallet.
 */
export function loadKeypair(env: NodeJS.ProcessEnv = process.env): Keypair {
  const raw = env.SOLANA_PRIVATE_KEY?.trim();
  if (raw) {
    if (raw.startsWith('[')) return Keypair.fromSecretKey(Uint8Array.from(JSON.parse(raw) as number[]));
    return Keypair.fromSecretKey(bs58.decode(raw));
  }
  const path = env.SOLANA_KEYPAIR_PATH?.trim();
  if (path) return Keypair.fromSecretKey(Uint8Array.from(JSON.parse(readFileSync(path, 'utf8')) as number[]));
  throw new Error('no wallet: set SOLANA_PRIVATE_KEY (base58 or JSON array) or SOLANA_KEYPAIR_PATH');
}
