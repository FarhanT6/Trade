import type { MarketRegime, Position, Token, Trade } from '../types.js';
import { groupBy } from '../util/stats.js';

export interface PnlContext {
  tokens: Map<string, Token>;
  /** Pool liquidity at a timestamp (used for size-to-liquidity). */
  liquidityAt?: (tokenMint: string, ts: number) => number;
  /** Highest price reached in the window after `ts` (for exit quality). */
  localPeakAfter?: (tokenMint: string, ts: number) => number;
  ruggedTokens?: Set<string>;
  regimeAt?: (ts: number) => MarketRegime;
}

/**
 * FIFO realized PnL accounting (spec §3.2). Each wallet+token forms a lot queue;
 * sells consume the oldest lots. Fees are subtracted. Transfers-in are ignored
 * for cost basis (treated as zero-cost airdrops) unless supplied as trades.
 */
export function buildPositions(trades: Trade[], ctx: PnlContext): Position[] {
  const positions: Position[] = [];
  const byKey = groupBy(trades, (t) => `${t.wallet}|${t.tokenMint}`);
  for (const [, ts] of byKey) {
    const sorted = [...ts].sort((a, b) => a.timestamp - b.timestamp);
    const lots: Array<{ qty: number; price: number; ts: number; fee: number }> = [];
    let open: Position | null = null;
    let sellQty = 0;
    let sellUsd = 0;
    let fees = 0;
    const wallet = sorted[0].wallet;
    const mint = sorted[0].tokenMint;
    const token = ctx.tokens.get(mint);
    const launchTs = token ? (token.migratedAt ?? token.createdAt) : sorted[0].timestamp;

    const close = (t: Trade) => {
      if (!open) return;
      open.closedAt = t.timestamp;
      open.exitPriceUsd = sellQty > 0 ? sellUsd / sellQty : t.priceUsd;
      open.holdMs = t.timestamp - open.openedAt;
      open.feesUsd = fees;
      const peak = ctx.localPeakAfter ? ctx.localPeakAfter(mint, open.openedAt) : null;
      open.exitQuality = peak && peak > 0 && open.exitPriceUsd ? Math.min(1, open.exitPriceUsd / peak) : null;
      positions.push(open);
      open = null;
      sellQty = 0;
      sellUsd = 0;
      fees = 0;
    };

    for (const t of sorted) {
      if (t.side === 'buy') {
        if (!open) {
          const liq = ctx.liquidityAt ? ctx.liquidityAt(mint, t.timestamp) : 0;
          open = {
            wallet,
            tokenMint: mint,
            openedAt: t.timestamp,
            closedAt: null,
            entryPriceUsd: t.priceUsd,
            exitPriceUsd: null,
            sizeUsd: 0,
            quantity: 0,
            realizedPnlUsd: 0,
            feesUsd: 0,
            holdMs: null,
            sizeToLiquidity: liq > 0 ? t.amountUsd / liq : 0,
            entryLatencyMs: Math.max(0, t.timestamp - launchTs),
            tokenRugged: ctx.ruggedTokens?.has(mint) ?? false,
            exitQuality: null,
            regime: ctx.regimeAt ? ctx.regimeAt(t.timestamp) : 'neutral',
          };
        }
        lots.push({ qty: t.amountToken, price: t.priceUsd, ts: t.timestamp, fee: t.feeUsd });
        open.sizeUsd += t.amountUsd;
        open.quantity += t.amountToken;
        fees += t.feeUsd;
        // Weighted average entry for reporting.
        open.entryPriceUsd = open.quantity > 0 ? open.sizeUsd / open.quantity : t.priceUsd;
      } else {
        if (!open) continue; // sale of airdropped / transferred tokens: no cost basis, skip
        let remaining = t.amountToken;
        let pnl = 0;
        while (remaining > 0 && lots.length > 0) {
          const lot = lots[0];
          const take = Math.min(lot.qty, remaining);
          pnl += take * (t.priceUsd - lot.price);
          lot.qty -= take;
          remaining -= take;
          if (lot.qty <= 1e-12) lots.shift();
        }
        open.realizedPnlUsd += pnl - t.feeUsd;
        fees += t.feeUsd;
        sellQty += t.amountToken - remaining;
        sellUsd += (t.amountToken - remaining) * t.priceUsd;
        open.quantity = lots.reduce((s, l) => s + l.qty, 0);
        if (open.quantity <= 1e-9 * Math.max(1, t.amountToken)) close(t);
      }
    }
    if (open) positions.push(open); // still open
  }
  return positions;
}
