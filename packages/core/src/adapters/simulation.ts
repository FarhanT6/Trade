import type {
  AuthorityChange, Chain, DeployerHistory, HolderSnapshot, LaunchType, LiquidityEvent, MarketRegime, Pool, SocialPlatform, SocialPost, Token, TokenSecurity, Trade, Transfer,
} from '../types.js';
import type { Envelope } from '../events/bus.js';
import { MS, hashString, rng } from '../util/stats.js';
import type { SourceAdapter } from './types.js';

export type TokenArchetype = 'organic-runner' | 'pump-dump' | 'rug' | 'honeypot' | 'slow-bleed' | 'dead';

export interface SimWallet {
  address: string;
  skill: number; // 0..1 latent skill
  cluster: string | null;
  funder: string;
  kind: 'trader' | 'bot' | 'deployer' | 'exchange';
  style: 'sniper' | 'momentum' | 'swing' | 'scalper' | 'narrative';
}

export interface SimToken {
  token: Token;
  archetype: TokenArchetype;
  narrative: string;
  /** Minute-resolution price path from createdAt. */
  prices: number[];
  liquidity: number[];
  rugAt: number | null;
  security: TokenSecurity;
  deployer: DeployerHistory;
  holders: HolderSnapshot;
  pool: Pool;
}

export interface SimulationOptions {
  seed?: number;
  tokens?: number;
  wallets?: number;
  /** Simulated span in ms. */
  spanMs?: number;
  start?: number;
  chain?: Chain;
}

const NARRATIVES: Array<{ label: string; words: string[]; catalyst: string }> = [
  { label: 'ai agents', words: ['ai', 'agent', 'agents', 'autonomous', 'framework', 'gpt', 'llm'], catalyst: 'new agent framework launch' },
  { label: 'dog coins', words: ['dog', 'doge', 'shiba', 'puppy', 'woof', 'bark'], catalyst: 'viral dog video' },
  { label: 'political', words: ['election', 'president', 'trump', 'vote', 'maga', 'politics'], catalyst: 'political headline' },
  { label: 'celebrity', words: ['elon', 'celebrity', 'rapper', 'drake', 'tweet', 'posted'], catalyst: 'celebrity post' },
  { label: 'cat coins', words: ['cat', 'kitten', 'meow', 'popcat', 'purr'], catalyst: 'viral cat meme' },
];

const BULL_WORDS = ['moon', 'send it', 'lfg', 'gem', 'early', 'bullish', 'ape', 'accumulate', 'breakout'];
const BEAR_WORDS = ['rug', 'scam', 'dump', 'exit', 'jeet', 'dead', 'avoid'];

function addr(r: () => number, prefix = ''): string {
  const alphabet = '123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz';
  let s = prefix;
  while (s.length < 44) s += alphabet[Math.floor(r() * alphabet.length)];
  return s.slice(0, 44);
}

/**
 * Deterministic synthetic market used for development, tests and the paper-trading
 * loop. Every artifact the pipeline needs is generated with explicit timestamps so it can
 * be replayed point-in-time.
 */
export class SimulationWorld {
  readonly wallets: SimWallet[] = [];
  readonly tokens: SimToken[] = [];
  readonly trades: Trade[] = [];
  readonly transfers: Transfer[] = [];
  readonly posts: SocialPost[] = [];
  readonly liquidityEvents: LiquidityEvent[] = [];
  readonly authorityChanges: AuthorityChange[] = [];
  readonly start: number;
  readonly end: number;
  readonly chain: Chain;
  private r: () => number;

  constructor(opts: SimulationOptions = {}) {
    const seed = opts.seed ?? 1337;
    this.r = rng(seed);
    this.chain = opts.chain ?? 'solana';
    this.start = opts.start ?? Date.UTC(2026, 8, 1);
    this.end = this.start + (opts.spanMs ?? 3 * MS.d);
    this.buildWallets(opts.wallets ?? 240);
    this.buildTokens(opts.tokens ?? 36);
  }

  // ---------------------------------------------------------------------------
  private buildWallets(n: number): void {
    const r = this.r;
    const exchanges = Array.from({ length: 3 }, (_, i) => addr(r, `EXCH${i}`));
    const ancestors = Array.from({ length: 6 }, (_, i) => addr(r, `ANC${i}`));
    for (const e of exchanges) this.wallets.push({ address: e, skill: 0, cluster: null, funder: '', kind: 'exchange', style: 'swing' });
    const styles: SimWallet['style'][] = ['sniper', 'momentum', 'swing', 'scalper', 'narrative'];
    for (let i = 0; i < n; i++) {
      const isCluster = r() < 0.25;
      const isBot = !isCluster && r() < 0.1;
      const ancestor = isCluster ? ancestors[Math.floor(r() * ancestors.length)] : exchanges[Math.floor(r() * exchanges.length)];
      const skill = isBot ? 0.2 : isCluster ? 0.5 + 0.4 * r() : Math.min(1, Math.max(0, r() ** 1.6 + (r() < 0.1 ? 0.5 : 0)));
      const w: SimWallet = { address: addr(r), skill, cluster: isCluster ? ancestor : null, funder: ancestor, kind: isBot ? 'bot' : 'trader', style: styles[Math.floor(r() * styles.length)] };
      this.wallets.push(w);
      const t0 = this.start - Math.floor(r() * 30 * MS.d);
      this.transfers.push({ id: `tr_${i}`, chain: this.chain, from: ancestor, to: w.address, mint: 'SOL', amount: 5 + r() * 50, amountUsd: 500 + r() * 5000, timestamp: t0 });
    }
    for (let i = 0; i < 8; i++) this.wallets.push({ address: addr(r, `DEP${i}`), skill: 0, cluster: null, funder: '', kind: 'deployer', style: 'sniper' });
  }

  private buildTokens(n: number): void {
    const r = this.r;
    const deployers = this.wallets.filter((w) => w.kind === 'deployer');
    const archetypes: TokenArchetype[] = ['organic-runner', 'organic-runner', 'pump-dump', 'rug', 'honeypot', 'slow-bleed', 'slow-bleed', 'dead'];
    const deployerRugs = new Map<string, { launches: number; rugs: number }>();
    for (let i = 0; i < n; i++) {
      const archetype = archetypes[Math.floor(r() * archetypes.length)];
      const nar = NARRATIVES[Math.floor(r() * NARRATIVES.length)];
      const deployer = archetype === 'rug' || archetype === 'honeypot' ? deployers[Math.floor(r() * 3)] : deployers[3 + Math.floor(r() * 5)];
      // A quarter of tokens are already live when the world starts (the market is never empty).
      const createdAt = r() < 0.25 ? this.start - Math.floor(r() * 12 * MS.h) : this.start + Math.floor(r() * (this.end - this.start - 6 * MS.h));
      const symbol = `${nar.words[Math.floor(r() * nar.words.length)].toUpperCase().slice(0, 5)}${i.toString(36).toUpperCase()}`;
      const launchType: LaunchType = r() < 0.6 ? 'pump-style' : r() < 0.5 ? 'migration' : 'established-meme';
      const supply = 1_000_000_000;
      const mint = addr(r, `M${i}`);
      const token: Token = { mint, chain: this.chain, symbol, name: `${symbol} coin`, decimals: 6, totalSupply: supply, createdAt, launchType, migrated: launchType === 'migration', migratedAt: launchType === 'migration' ? createdAt + 20 * MS.m : undefined, deployer: deployer.address };
      const minutes = Math.floor((this.end - createdAt) / MS.m);
      const p0 = (20_000 + r() * 80_000) / supply; // $20k-100k starting mcap
      const prices: number[] = [p0];
      const liquidity: number[] = [8_000 + r() * 30_000];
      let rugAt: number | null = null;
      const runStart = Math.floor(30 + r() * 120); // minute the run begins
      const runLen = Math.floor(60 + r() * 240);
      for (let m = 1; m < minutes; m++) {
        const prev = prices[m - 1];
        let drift = 0;
        let vol = 0.02;
        switch (archetype) {
          case 'organic-runner':
            drift = m > runStart && m < runStart + runLen ? 0.012 : m >= runStart + runLen && m < runStart + runLen + 90 ? -0.006 : m >= runStart + runLen ? -0.0005 : 0.001;
            vol = 0.03;
            break;
          case 'pump-dump':
            drift = m > runStart && m < runStart + 40 ? 0.03 : m >= runStart + 40 && m < runStart + 70 ? -0.06 : -0.003;
            vol = 0.05;
            break;
          case 'rug':
            drift = m < runStart + 30 ? 0.01 : 0;
            if (m === runStart + 30) rugAt = createdAt + m * MS.m;
            vol = 0.03;
            break;
          case 'honeypot':
            drift = 0.008;
            vol = 0.01;
            break;
          case 'slow-bleed':
            drift = -0.004;
            vol = 0.025;
            break;
          case 'dead':
            drift = -0.001;
            vol = 0.01;
            break;
        }
        const shock = (r() - 0.5) * 2 * vol;
        let next = prev * Math.exp(drift + shock);
        if (rugAt !== null && createdAt + m * MS.m >= rugAt) next = prev * 0.03;
        prices.push(Math.max(1e-12, next));
        const liqPrev = liquidity[m - 1];
        liquidity.push(rugAt !== null && createdAt + m * MS.m >= rugAt ? 200 : Math.max(500, liqPrev * (1 + drift * 0.6 + (r() - 0.5) * 0.01)));
      }
      const dh = deployerRugs.get(deployer.address) ?? { launches: 0, rugs: 0 };
      dh.launches++;
      if (archetype === 'rug') dh.rugs++;
      deployerRugs.set(deployer.address, dh);
      const security: TokenSecurity = {
        tokenMint: mint,
        mintAuthority: archetype === 'rug' && r() < 0.5 ? deployer.address : null,
        freezeAuthority: archetype === 'honeypot' && r() < 0.5 ? deployer.address : null,
        metadataMutable: r() < 0.3,
        token2022Extensions: archetype === 'honeypot' ? ['transferFee'] : [],
        transferFeeBps: archetype === 'honeypot' ? 900 : undefined,
        permanentDelegate: archetype === 'honeypot' && r() < 0.3 ? deployer.address : null,
        defaultAccountStateFrozen: false,
        freshness: { asOf: createdAt, source: 'sim-chain', confidence: 1 },
      };
      const pool: Pool = { id: `pool_${mint.slice(0, 8)}`, chain: this.chain, tokenMint: mint, quoteMint: 'SOL', dex: launchType === 'migration' ? 'raydium' : 'pumpswap', tokenReserve: supply * 0.3, quoteReserveUsd: liquidity[0] / 2, liquidityUsd: liquidity[0], lpOwner: archetype === 'rug' ? deployer.address : 'burn', lpLockedPct: archetype === 'rug' ? 0.1 : 1, createdAt, freshness: { asOf: createdAt, source: 'sim-chain', confidence: 1 } };
      const topN = archetype === 'pump-dump' || archetype === 'rug' ? 0.45 : 0.18;
      const holders: HolderSnapshot = { tokenMint: mint, timestamp: createdAt, holderCount: archetype === 'dead' ? 30 : 200 + Math.floor(r() * 2000), top: Array.from({ length: 20 }, (_, k) => ({ wallet: k === 0 ? deployer.address : this.wallets[10 + k].address, pct: (topN / 20) * (1.5 - k / 20) })), deployerPct: archetype === 'rug' ? 0.12 : 0.02, freshness: { asOf: createdAt, source: 'sim-chain', confidence: 1 } };
      this.tokens.push({ token, archetype, narrative: nar.label, prices, liquidity, rugAt, security, deployer: { deployer: deployer.address, launches: 0, ruggedLaunches: 0, fundingSources: [], knownMaliciousClusterMatch: false, freshness: { asOf: createdAt, source: 'sim-graph', confidence: 0.9 } }, holders, pool });
      if (rugAt !== null) {
        this.liquidityEvents.push({ id: `liq_${i}`, poolId: pool.id, tokenMint: mint, kind: 'remove', amountUsd: liquidity[Math.max(0, Math.floor((rugAt - createdAt) / MS.m) - 1)], wallet: deployer.address, timestamp: rugAt });
        if (security.mintAuthority) this.authorityChanges.push({ id: `auth_${i}`, tokenMint: mint, kind: 'mint', previous: null, current: deployer.address, timestamp: rugAt - 10 * MS.m });
      }
      this.generateTrades(this.tokens[this.tokens.length - 1], runStart, runLen);
      this.generatePosts(this.tokens[this.tokens.length - 1], nar, runStart);
    }
    for (const t of this.tokens) {
      const h = deployerRugs.get(t.token.deployer)!;
      t.deployer.launches = h.launches;
      t.deployer.ruggedLaunches = h.rugs;
    }
    this.trades.sort((a, b) => a.timestamp - b.timestamp);
    this.posts.sort((a, b) => a.timestamp - b.timestamp);
  }

  private generateTrades(st: SimToken, runStart: number, runLen: number): void {
    const r = this.r;
    const traders = this.wallets.filter((w) => w.kind === 'trader' || w.kind === 'bot');
    const minutes = st.prices.length;
    let id = 0;
    const pushTrade = (w: SimWallet, side: 'buy' | 'sell', m: number, usd: number) => {
      const ts = st.token.createdAt + m * MS.m + Math.floor(r() * MS.m);
      const price = st.prices[m];
      this.trades.push({ id: `t_${st.token.mint.slice(1, 5)}_${id++}`, chain: this.chain, tokenMint: st.token.mint, poolId: st.pool.id, wallet: w.address, side, amountToken: usd / price, amountUsd: usd, priceUsd: price, feeUsd: usd * 0.003 + 0.05, timestamp: ts, txSignature: `sig_${st.token.mint.slice(1, 5)}_${id}` });
    };
    const holdings = new Map<string, { qty: number; usd: number; enteredAt: number; entryPrice: number }>();
    const exited = new Set<string>();
    const runEnd = runStart + runLen;
    for (let m = 0; m < minutes; m++) {
      if (st.rugAt !== null && st.token.createdAt + m * MS.m >= st.rugAt) break;
      const inRun = m > runStart && m < runEnd;
      const runProgress = inRun ? (m - runStart) / runLen : m >= runEnd ? 1 : 0;
      const phaseIntensity = st.archetype === 'dead' ? 0.15 : st.archetype === 'slow-bleed' ? 0.4 : inRun ? 2.5 : 0.7;
      const nBuys = Math.floor(phaseIntensity * (1 + r() * 3));
      for (let k = 0; k < nBuys; k++) {
        const w = traders[Math.floor(r() * traders.length)];
        if (holdings.has(w.address)) continue;
        if (exited.has(w.address) && r() > 0.08) continue; // rare re-entry
        // Skilled wallets avoid rugs/honeypots/pump-dumps; unskilled wallets are drawn to them.
        const bad = st.archetype === 'rug' || st.archetype === 'honeypot' || st.archetype === 'pump-dump';
        if (bad && r() < w.skill * 0.9) continue;
        // Skilled wallets enter early in a run; unskilled wallets chase late (FOMO).
        const early = m <= runStart + Math.max(10, runLen * 0.25);
        if (st.archetype === 'organic-runner') {
          if (early && r() > 0.15 + w.skill * 0.8) continue;
          if (!early && inRun && r() > 0.2 + (1 - w.skill) * 0.7 * runProgress) continue;
          if (m >= runEnd && r() > (1 - w.skill) * 0.5) continue; // buying the top / the decline
        }
        if (w.style === 'sniper' && m > 20 && r() < 0.6) continue;
        const usd = 50 + r() * (w.skill > 0.7 ? 1500 : 400);
        pushTrade(w, 'buy', m, usd);
        holdings.set(w.address, { qty: usd / st.prices[m], usd, enteredAt: m, entryPrice: st.prices[m] });
      }
      for (const [a, h] of [...holdings]) {
        const w = traders.find((x) => x.address === a)!;
        const held = m - h.enteredAt;
        const pnl = st.prices[m] / h.entryPrice - 1;
        const nearTop = m >= runEnd - 15 && m <= runEnd + 5;
        const dumpPhase = st.archetype === 'pump-dump' && m >= runStart + 35;
        let sell = false;
        if (w.skill > 0.6 && (nearTop || dumpPhase)) sell = r() < 0.35 + w.skill * 0.4;
        else if (w.skill > 0.6 && pnl < -0.25 && held > 5) sell = r() < 0.5; // disciplined stop
        else if (w.style === 'scalper' && held > 5 && r() < 0.2) sell = true;
        else if (w.skill <= 0.6 && pnl < -0.4 && r() < 0.12) sell = true; // panic sell late
        else if (held > 45 && r() < 0.015 + (m > runEnd + 60 ? 0.05 : 0)) sell = true;
        if (sell) {
          pushTrade(w, 'sell', m, h.qty * st.prices[m]);
          holdings.delete(a);
          exited.add(a);
        }
      }
      if (st.archetype === 'pump-dump' && inRun) {
        const bots = traders.filter((w) => w.kind === 'bot');
        for (let k = 0; k < 3; k++) {
          const b = bots[Math.floor(r() * bots.length)];
          const usd = 300 + r() * 20;
          pushTrade(b, 'buy', m, usd);
          pushTrade(b, 'sell', m, usd * (1 + (r() - 0.5) * 0.02));
        }
      }
    }
  }

  private generatePosts(st: SimToken, nar: (typeof NARRATIVES)[number], runStart: number): void {
    const r = this.r;
    const minutes = st.prices.length;
    let id = 0;
    const authors = Array.from({ length: 60 }, (_, i) => ({ id: `${nar.label.replace(' ', '')}_${i}_${st.token.symbol}`, followers: Math.floor(Math.exp(r() * 12)), createdAt: this.start - Math.floor(r() * 1000 * MS.d) }));
    const botAuthors = Array.from({ length: 25 }, (_, i) => ({ id: `bot_${i}_${st.token.symbol}`, followers: Math.floor(r() * 50), createdAt: this.start - Math.floor(r() * 10 * MS.d) }));
    const platforms: SocialPlatform[] = ['x', 'x', 'x', 'reddit'];
    const template = `$${st.token.symbol} ${nar.words[0]} ${nar.words[1]} narrative is the play, ${BULL_WORDS[0]} ${st.token.mint}`;
    for (let m = 0; m < minutes; m += 3) {
      const lead = st.archetype === 'organic-runner' ? m > runStart - 45 && m < runStart + 60 : m > runStart && m < runStart + 40;
      const base = st.archetype === 'dead' ? 0.05 : 0.25;
      const intensity = lead ? base * 6 : base;
      const n = Math.floor(intensity * (1 + r() * 2));
      for (let k = 0; k < n; k++) {
        const isBot = st.archetype === 'pump-dump' && r() < 0.65;
        const a = isBot ? botAuthors[Math.floor(r() * botAuthors.length)] : authors[Math.floor(r() * authors.length)];
        const w1 = nar.words[Math.floor(r() * nar.words.length)];
        const w2 = nar.words[Math.floor(r() * nar.words.length)];
        const bearish = st.archetype === 'slow-bleed' || st.archetype === 'rug' ? r() < 0.35 : r() < 0.1;
        const mood = bearish ? BEAR_WORDS[Math.floor(r() * BEAR_WORDS.length)] : BULL_WORDS[Math.floor(r() * BULL_WORDS.length)];
        const text = isBot ? template : `$${st.token.symbol} ${w1} ${w2} ${mood} ${r() < 0.3 ? nar.catalyst : ''} ${r() < 0.2 ? st.token.mint : ''}`.trim();
        const ts = st.token.createdAt + m * MS.m + Math.floor(r() * 3 * MS.m);
        const platform = platforms[Math.floor(r() * platforms.length)];
        this.posts.push({ id: `p_${st.token.symbol}_${id++}`, platform, authorId: a.id, authorFollowers: a.followers, authorCreatedAt: a.createdAt, authorHighSignal: a.followers > 100_000, text, timestamp: ts, engagement: { likes: Math.floor(r() * Math.sqrt(a.followers + 1)), reposts: Math.floor(r() * 5), replies: Math.floor(r() * 4), quotes: r() < 0.15 ? 1 : 0 }, isQuote: r() < 0.15, tickers: [st.token.symbol], contracts: text.includes(st.token.mint) ? [st.token.mint] : [], urls: [], community: platform === 'reddit' ? 'r/memecoins' : undefined });
      }
    }
  }

  // ---------------------------------------------------------------------------
  // Point-in-time accessors (safe for backtests: never read beyond `ts`).
  // ---------------------------------------------------------------------------
  priceAt(mint: string, ts: number): number {
    const st = this.tokens.find((t) => t.token.mint === mint);
    if (!st) return 0;
    const m = Math.floor((ts - st.token.createdAt) / MS.m);
    if (m < 0) return 0;
    return st.prices[Math.min(m, st.prices.length - 1)];
  }
  liquidityAt(mint: string, ts: number): number {
    const st = this.tokens.find((t) => t.token.mint === mint);
    if (!st) return 0;
    const m = Math.floor((ts - st.token.createdAt) / MS.m);
    if (m < 0) return 0;
    return st.liquidity[Math.min(m, st.liquidity.length - 1)];
  }
  poolAt(mint: string, ts: number): Pool | null {
    const st = this.tokens.find((t) => t.token.mint === mint);
    if (!st || ts < st.token.createdAt) return null;
    const liq = this.liquidityAt(mint, ts);
    const price = this.priceAt(mint, ts);
    return { ...st.pool, liquidityUsd: liq, quoteReserveUsd: liq / 2, tokenReserve: price > 0 ? liq / 2 / price : st.pool.tokenReserve, freshness: { asOf: ts, source: 'sim-chain', confidence: 1 } };
  }
  regimeAt(ts: number): MarketRegime {
    const day = Math.floor((ts - this.start) / MS.d);
    return (['bull', 'meme-mania', 'neutral', 'bear'] as MarketRegime[])[day % 4];
  }
  /** Highest price in the 24h after ts (outcome labeling only). */
  peakAfter(mint: string, ts: number, horizonMs = 24 * MS.h): number {
    const st = this.tokens.find((t) => t.token.mint === mint);
    if (!st) return 0;
    const m0 = Math.max(0, Math.floor((ts - st.token.createdAt) / MS.m));
    const m1 = Math.min(st.prices.length - 1, m0 + Math.floor(horizonMs / MS.m));
    let best = 0;
    for (let m = m0; m <= m1; m++) best = Math.max(best, st.prices[m]);
    return best;
  }
  ruggedTokens(): Set<string> {
    return new Set(this.tokens.filter((t) => t.rugAt !== null).map((t) => t.token.mint));
  }
  simToken(mint: string): SimToken | undefined {
    return this.tokens.find((t) => t.token.mint === mint);
  }
}

/** Adapter facade over the simulation world: replays generated events between `since` and `now`. */
export class SimulationAdapter implements SourceAdapter {
  name = 'simulation';
  kind = 'chain' as const;
  constructor(readonly world: SimulationWorld) {}
  async health() {
    return { ok: true, detail: `${this.world.tokens.length} tokens, ${this.world.trades.length} trades, ${this.world.posts.length} posts` };
  }
  async poll(since: number, now: number): Promise<Envelope[]> {
    const out: Envelope[] = [];
    const inWin = (ts: number) => ts >= since && ts < now;
    for (const st of this.world.tokens) {
      if (inWin(st.token.createdAt)) {
        out.push({ topic: 'chain.token.created', payload: st.token, timestamp: st.token.createdAt, source: this.name });
        out.push({ topic: 'chain.security', payload: st.security, timestamp: st.token.createdAt, source: this.name });
        out.push({ topic: 'chain.holders', payload: st.holders, timestamp: st.token.createdAt, source: this.name });
      }
      if (st.token.createdAt < now) {
        // A chain poller re-reads pool, mint and holder state every cycle; freshness moves with the clock.
        const pool = this.world.poolAt(st.token.mint, now - 1);
        if (pool) out.push({ topic: 'chain.pool', payload: pool, timestamp: now - 1, source: this.name });
        out.push({ topic: 'chain.security', payload: { ...st.security, mintAuthority: st.security.mintAuthority && (st.rugAt === null || now < st.rugAt - 10 * MS.m) ? null : st.security.mintAuthority, freshness: { asOf: now - 1, source: this.name, confidence: 1 } }, timestamp: now - 1, source: this.name });
        out.push({ topic: 'chain.holders', payload: { ...st.holders, timestamp: now - 1, freshness: { asOf: now - 1, source: this.name, confidence: 1 } }, timestamp: now - 1, source: this.name });
      }
    }
    for (const t of this.world.trades) if (inWin(t.timestamp)) out.push({ topic: 'chain.trade', payload: t, timestamp: t.timestamp, source: this.name });
    for (const t of this.world.transfers) if (inWin(t.timestamp) || (since <= this.world.start && t.timestamp < this.world.start && now > this.world.start)) out.push({ topic: 'chain.transfer', payload: t, timestamp: t.timestamp, source: this.name });
    for (const p of this.world.posts) if (inWin(p.timestamp)) out.push({ topic: 'social.post', payload: p, timestamp: p.timestamp, source: this.name });
    for (const e of this.world.liquidityEvents) if (inWin(e.timestamp)) out.push({ topic: 'chain.liquidity', payload: e, timestamp: e.timestamp, source: this.name });
    for (const a of this.world.authorityChanges) if (inWin(a.timestamp)) out.push({ topic: 'chain.authority', payload: a, timestamp: a.timestamp, source: this.name });
    return out.sort((a, b) => a.timestamp - b.timestamp);
  }
}

export const _sim = { hashString, NARRATIVES };
