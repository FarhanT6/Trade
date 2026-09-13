import { describe, expect, it } from 'vitest';
import { buildPositions } from '../wallets/pnl.js';
import { buildTraderProfile, drawdownStats } from '../wallets/profile.js';
import { buildWalletGraph } from '../wallets/clustering.js';
import { consensusWithoutCorrelation, rankTraders } from '../wallets/consensus.js';
import { NOW, token, trade } from './helpers.js';
import { MS } from '../util/stats.js';
import type { Transfer } from '../types.js';

describe('FIFO PnL', () => {
  it('realizes pnl across lots in FIFO order and closes the position', () => {
    const tokens = new Map([[token().mint, token()]]);
    const trades = [
      trade({ wallet: 'w', side: 'buy', amountUsd: 100, priceUsd: 1, timestamp: NOW - 30 * MS.m }),
      trade({ wallet: 'w', side: 'buy', amountUsd: 200, priceUsd: 2, timestamp: NOW - 20 * MS.m }),
      trade({ wallet: 'w', side: 'sell', amountUsd: 150 * 3, priceUsd: 3, timestamp: NOW - 10 * MS.m }), // 150 tokens at 3
      trade({ wallet: 'w', side: 'sell', amountUsd: 50 * 4, priceUsd: 4, timestamp: NOW - 5 * MS.m }),
    ];
    const [p] = buildPositions(trades, { tokens });
    // lots: 100@1, 100@2. Sell 150@3: 100*(3-1)+50*(3-2)=250. Sell 50@4: 50*(4-2)=100. fees 0.4 total on 4 trades.
    expect(p.realizedPnlUsd).toBeCloseTo(350 - 0.2, 5);
    expect(p.closedAt).not.toBeNull();
    expect(p.holdMs).toBe(25 * MS.m);
  });
  it('ignores sells with no cost basis', () => {
    const tokens = new Map([[token().mint, token()]]);
    expect(buildPositions([trade({ wallet: 'w', side: 'sell' })], { tokens })).toHaveLength(0);
  });
});

describe('trader profile', () => {
  it('computes drawdown and recovery', () => {
    const dd = drawdownStats([100, -50, -30, 100, 50]);
    expect(dd.maxDrawdownPct).toBeCloseTo(80, 5);
    expect(dd.recoveryTimeIdx).toBe(2);
  });
  it('does not rank a one-trade lucky wallet above a consistent one', () => {
    const tokens = new Map([[token().mint, token()]]);
    const trades = [] as ReturnType<typeof trade>[];
    for (let i = 0; i < 12; i++) {
      trades.push(trade({ wallet: 'steady', side: 'buy', amountUsd: 100, priceUsd: 1, timestamp: NOW - (30 - i * 2) * MS.h }));
      trades.push(trade({ wallet: 'steady', side: 'sell', amountUsd: 100 * (i % 4 === 0 ? 0.8 : 1.4), priceUsd: i % 4 === 0 ? 0.8 : 1.4, timestamp: NOW - (29 - i * 2) * MS.h }));
    }
    trades.push(trade({ wallet: 'lucky', side: 'buy', amountUsd: 100, priceUsd: 1, timestamp: NOW - 3 * MS.h }));
    trades.push(trade({ wallet: 'lucky', side: 'sell', amountUsd: 5000, priceUsd: 50, timestamp: NOW - 2 * MS.h }));
    const positions = buildPositions(trades, { tokens });
    const steady = buildTraderProfile('steady', positions, '7d', { now: NOW, tokens });
    const lucky = buildTraderProfile('lucky', positions, '7d', { now: NOW, tokens });
    expect(lucky.realizedPnlUsd).toBeGreaterThan(steady.realizedPnlUsd);
    expect(steady.riskAdjustedSkill).toBeGreaterThan(lucky.riskAdjustedSkill);
    const ranked = rankTraders([steady, lucky], 3);
    expect(ranked[0].wallet).toBe('steady');
    expect(ranked).toHaveLength(1); // lucky filtered for sample size
  });
});

describe('wallet graph + consensus without correlation', () => {
  it('groups wallets by funding ancestor and discounts consensus', () => {
    const transfers: Transfer[] = [];
    const wallets: string[] = [];
    for (let i = 0; i < 12; i++) {
      const w = `w${i}`;
      wallets.push(w);
      transfers.push({ id: `tr${i}`, chain: 'solana', from: i < 9 ? 'ANCESTOR' : `EX${i}`, to: w, mint: 'SOL', amount: 10, amountUsd: 1000, timestamp: NOW - MS.d });
    }
    const trades = wallets.map((w, i) => trade({ wallet: w, timestamp: NOW - i * MS.m }));
    const g = buildWalletGraph(transfers, trades);
    const big = g.clusters.find((c) => c.wallets.length === 9);
    expect(big).toBeDefined();
    expect(big!.fundingAncestor).toBe('ANCESTOR');
    expect(big!.fundingOverlap).toBe(1);
    const cwc = consensusWithoutCorrelation(wallets, g.clusterOf, g.clusters);
    expect(cwc.independent).toBe(4);
    const naive = consensusWithoutCorrelation(wallets, new Map(), []);
    expect(cwc.score).toBeLessThan(naive.score);
  });
  it('does not treat an exchange hot wallet as a cluster ancestor', () => {
    const transfers: Transfer[] = [];
    for (let i = 0; i < 80; i++) transfers.push({ id: `t${i}`, chain: 'solana', from: 'HOT', to: `u${i}`, mint: 'SOL', amount: 1, amountUsd: 500, timestamp: NOW - MS.d });
    const trades = Array.from({ length: 80 }, (_, i) => trade({ wallet: `u${i}`, timestamp: NOW - i * 10 * MS.m }));
    const g = buildWalletGraph(transfers, trades, { maxFanout: 50 });
    expect(g.clusters.every((c) => c.wallets.length === 1)).toBe(true);
  });
});
