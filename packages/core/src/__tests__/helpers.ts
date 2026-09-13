import type { Freshness, MarketFeatures, Pool, Token, Trade } from '../types.js';
import { MS } from '../util/stats.js';

export const NOW = Date.UTC(2026, 8, 1, 12);
export const fresh = (asOf = NOW): Freshness => ({ asOf, source: 'test', confidence: 1 });

export function token(over: Partial<Token> = {}): Token {
  return { mint: 'MINT1111111111111111111111111111111111111111', chain: 'solana', symbol: 'TEST', name: 'Test', decimals: 6, totalSupply: 1_000_000_000, createdAt: NOW - 2 * MS.h, launchType: 'pump-style', migrated: false, deployer: 'DEPLOYER', ...over };
}

export function pool(over: Partial<Pool> = {}): Pool {
  return { id: 'pool1', chain: 'solana', tokenMint: token().mint, quoteMint: 'SOL', dex: 'pumpswap', tokenReserve: 300_000_000, quoteReserveUsd: 25_000, liquidityUsd: 50_000, lpOwner: 'burn', lpLockedPct: 1, createdAt: NOW - 2 * MS.h, freshness: fresh(), ...over };
}

let n = 0;
export function trade(over: Partial<Trade> = {}): Trade {
  n++;
  const amountUsd = over.amountUsd ?? 100;
  const priceUsd = over.priceUsd ?? 0.0001;
  return { id: `t${n}`, chain: 'solana', tokenMint: token().mint, poolId: 'pool1', wallet: `W${n}`, side: 'buy', amountUsd, priceUsd, amountToken: amountUsd / priceUsd, feeUsd: 0.1, timestamp: NOW - MS.m, txSignature: `s${n}`, ...over };
}

/** Trades with rising volume + buyers over the last 10 minutes vs the prior 10. */
export function acceleratingTrades(mint = token().mint): Trade[] {
  const out: Trade[] = [];
  out.push(trade({ tokenMint: mint, timestamp: NOW - 20 * MS.m, amountUsd: 80, wallet: 'seed', priceUsd: 0.0001 }));
  for (let i = 0; i < 6; i++) out.push(trade({ tokenMint: mint, timestamp: NOW - 5 * MS.m - i * 50_000 - 1, amountUsd: 80, wallet: `old${i}`, priceUsd: 0.0001 }));
  for (let i = 0; i < 24; i++) out.push(trade({ tokenMint: mint, timestamp: NOW - i * 12_000 - 1, amountUsd: 200 + i, wallet: `new${i}`, priceUsd: 0.00013 }));
  return out;
}

export function marketStub(over: Partial<MarketFeatures> = {}): MarketFeatures {
  const iv = { volumeUsd: 10_000, buyVolumeUsd: 6000, sellVolumeUsd: 4000, trades: 40, uniqueBuyers: 20, uniqueSellers: 10, priceChangePct: 5 };
  return {
    tokenMint: token().mint, timestamp: NOW, priceUsd: 0.0001, liquidityUsd: 50_000, marketCapUsd: 100_000, tokenAgeMs: 2 * MS.h,
    intervals: { '1m': iv, '5m': iv, '15m': iv, '1h': iv }, volumeAcceleration: { '1m': 1, '5m': 1.5, '15m': 1.3, '1h': 1.1 }, priceAcceleration: 1, volatility: 0.15, volatilityRegime: 'normal',
    buyerAcceleration: 1.4, sellerAcceleration: 1, avgTradeSizeUsd: 250, medianTradeSizeUsd: 200, buySellImbalance: 0.2, liquidityToMcap: 0.5,
    recentHighUsd: 0.00012, drawdownFromHigh: 0.16, depthUsd: { bid1pct: 250, ask1pct: 250, bid5pct: 1300, ask5pct: 1300 }, expectedImpactPct: (s) => (s / (25_000 + s)) * 100,
    volumeQuality: { reportedVolumeUsd: 10_000, economicVolumeUsd: 9000, score: 0.9, uniqueTraders: 25, repeatedLoopVolumeUsd: 0, sharedFundingVolumeUsd: 0, suspectedWashRatio: 0.1 }, freshness: fresh(), ...over,
  };
}
