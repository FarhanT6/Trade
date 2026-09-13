import type { Trade, Transfer, WalletCluster } from '../types.js';
import { MS, clamp, groupBy, mean, ratio, unique } from '../util/stats.js';

/** Union-find over wallet addresses. */
class DisjointSet {
  private parent = new Map<string, string>();
  find(x: string): string {
    if (!this.parent.has(x)) this.parent.set(x, x);
    let r = x;
    while (this.parent.get(r) !== r) r = this.parent.get(r)!;
    // path compression
    let c = x;
    while (this.parent.get(c) !== r) {
      const n = this.parent.get(c)!;
      this.parent.set(c, r);
      c = n;
    }
    return r;
  }
  union(a: string, b: string): void {
    const ra = this.find(a);
    const rb = this.find(b);
    if (ra !== rb) this.parent.set(ra, rb);
  }
}

export interface ClusterOptions {
  /** Funding transfers below this USD value are ignored (dust). */
  minFundingUsd?: number;
  /** Wallets that fund > this many wallets are exchanges/bridges, not "ancestors". */
  maxFanout?: number;
  /** Entries within this window count as synchronized. */
  syncWindowMs?: number;
  /** Behavioral-only links require at least this many co-occurring synchronized trades... */
  minBehavioralLinks?: number;
  /** ...across at least this many distinct tokens... */
  minSharedTokens?: number;
  /** ...with mean trade-size similarity at or above this (1 = identical sizes). */
  minSizeSimilarity?: number;
  knownExchanges?: Set<string>;
}

export interface WalletGraph {
  clusters: WalletCluster[];
  clusterOf: Map<string, string>;
  fundingAncestor: Map<string, string>;
}

/**
 * Trader network graph (spec §3.5): connect wallets by common funders, transfer
 * paths, synchronized entries/exits, similar sizes and repeated co-occurrence.
 */
export function buildWalletGraph(transfers: Transfer[], trades: Trade[], opts: ClusterOptions = {}): WalletGraph {
  const minFunding = opts.minFundingUsd ?? 5;
  const maxFanout = opts.maxFanout ?? 50;
  const syncWindow = opts.syncWindowMs ?? 30 * MS.s;
  const minBehavioral = opts.minBehavioralLinks ?? 4;
  const minSharedTokens = opts.minSharedTokens ?? 3;
  const minSizeSimilarity = opts.minSizeSimilarity ?? 0.85;
  const exchanges = opts.knownExchanges ?? new Set<string>();

  const ds = new DisjointSet();
  const walletSet = new Set<string>(trades.map((t) => t.wallet));

  // 1. Funding edges: first inbound native/stable transfer above dust defines the funder.
  const funder = new Map<string, string>();
  const fanout = new Map<string, Set<string>>();
  for (const tr of [...transfers].sort((a, b) => a.timestamp - b.timestamp)) {
    if ((tr.amountUsd ?? 0) < minFunding) continue;
    if (exchanges.has(tr.from)) continue;
    if (!funder.has(tr.to)) funder.set(tr.to, tr.from);
    const f = fanout.get(tr.from) ?? new Set<string>();
    f.add(tr.to);
    fanout.set(tr.from, f);
  }
  const ancestorOf = (w: string): string => {
    const seen = new Set<string>();
    let cur = w;
    while (funder.has(cur) && !seen.has(cur)) {
      seen.add(cur);
      const f = funder.get(cur)!;
      if ((fanout.get(f)?.size ?? 0) > maxFanout) break; // exchange-like hub: stop
      cur = f;
    }
    return cur;
  };
  const fundingAncestor = new Map<string, string>();
  for (const w of walletSet) {
    const a = ancestorOf(w);
    if (a !== w) fundingAncestor.set(w, a);
  }
  for (const [w, a] of fundingAncestor) ds.union(w, a);
  // Direct wallet-to-wallet transfers between traders also link.
  for (const tr of transfers) {
    if ((tr.amountUsd ?? 0) < minFunding) continue;
    if (walletSet.has(tr.from) && walletSet.has(tr.to) && !exchanges.has(tr.from)) ds.union(tr.from, tr.to);
  }

  // 2. Behavioral edges: synchronized entries/exits with similar sizes across multiple tokens.
  const pairLinks = new Map<string, { sync: number; sizeSim: number[]; tokens: Set<string> }>();
  const byToken = groupBy(trades, (t) => t.tokenMint);
  for (const [mint, ts] of byToken) {
    const sorted = [...ts].sort((a, b) => a.timestamp - b.timestamp);
    for (let i = 0; i < sorted.length; i++) {
      for (let j = i + 1; j < sorted.length && sorted[j].timestamp - sorted[i].timestamp <= syncWindow; j++) {
        const a = sorted[i];
        const b = sorted[j];
        if (a.wallet === b.wallet || a.side !== b.side) continue;
        const key = a.wallet < b.wallet ? `${a.wallet}|${b.wallet}` : `${b.wallet}|${a.wallet}`;
        const e = pairLinks.get(key) ?? { sync: 0, sizeSim: [], tokens: new Set<string>() };
        e.sync += 1;
        e.sizeSim.push(1 - Math.abs(a.amountUsd - b.amountUsd) / Math.max(a.amountUsd, b.amountUsd, 1));
        e.tokens.add(mint);
        pairLinks.set(key, e);
      }
    }
  }
  for (const [key, e] of pairLinks) {
    if (e.sync >= minBehavioral && e.tokens.size >= minSharedTokens && mean(e.sizeSim) >= minSizeSimilarity) {
      const [a, b] = key.split('|');
      ds.union(a, b);
    }
  }

  // 3. Materialize clusters with descriptive metrics.
  const members = groupBy([...walletSet], (w) => ds.find(w));
  const clusters: WalletCluster[] = [];
  const clusterOf = new Map<string, string>();
  for (const [root, ws] of members) {
    const id = `cl_${root.slice(0, 8)}`;
    for (const w of ws) clusterOf.set(w, id);
    if (ws.length === 1) {
      clusters.push({ id, wallets: ws, fundingAncestor: fundingAncestor.get(ws[0]) ?? null, fundingOverlap: 0, synchronizedEntries: 0, synchronizedExits: 0, sizeSimilarity: 0, coOccurrence: 0, sameEntityScore: 0 });
      continue;
    }
    const ancestors = ws.map((w) => fundingAncestor.get(w)).filter((x): x is string => !!x);
    const topAncestor = mode(ancestors);
    const fundingOverlap = ratio(ancestors.filter((a) => a === topAncestor).length, ws.length);
    let syncEntries = 0;
    let syncExits = 0;
    const sims: number[] = [];
    const tokenSets: Set<string>[] = [];
    for (const [key, e] of pairLinks) {
      const [a, b] = key.split('|');
      if (clusterOf.get(a) === id && clusterOf.get(b) === id) {
        syncEntries += e.sync;
        sims.push(...e.sizeSim);
        tokenSets.push(e.tokens);
      }
    }
    const sellsByToken = groupBy(trades.filter((t) => t.side === 'sell' && ws.includes(t.wallet)), (t) => t.tokenMint);
    for (const [, ss] of sellsByToken) {
      const sorted = ss.sort((a, b) => a.timestamp - b.timestamp);
      for (let i = 1; i < sorted.length; i++) if (sorted[i].timestamp - sorted[i - 1].timestamp <= syncWindow && sorted[i].wallet !== sorted[i - 1].wallet) syncExits++;
    }
    const allTokens = unique(tokenSets.flatMap((s) => [...s]));
    const coOccurrence = allTokens.length;
    const sizeSimilarity = sims.length ? mean(sims) : 0;
    const sameEntityScore = clamp(
      0.45 * fundingOverlap + 0.2 * Math.min(1, syncEntries / 5) + 0.15 * Math.min(1, syncExits / 5) + 0.1 * sizeSimilarity + 0.1 * Math.min(1, coOccurrence / 3),
      0,
      1,
    );
    clusters.push({ id, wallets: ws, fundingAncestor: topAncestor ?? null, fundingOverlap, synchronizedEntries: syncEntries, synchronizedExits: syncExits, sizeSimilarity, coOccurrence, sameEntityScore });
  }
  return { clusters, clusterOf, fundingAncestor };
}

function mode(xs: string[]): string | undefined {
  const counts = new Map<string, number>();
  let best: string | undefined;
  let bestN = 0;
  for (const x of xs) {
    const n = (counts.get(x) ?? 0) + 1;
    counts.set(x, n);
    if (n > bestN) {
      bestN = n;
      best = x;
    }
  }
  return best;
}
