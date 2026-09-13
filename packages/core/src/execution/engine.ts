import type { ExecutionEvent, Order, Pool, Quote, TradeSide } from '../types.js';
import { newId } from '../util/ids.js';
import { clamp, mean } from '../util/stats.js';
import { constantProductImpactPct } from '../features/market.js';

// ---------------------------------------------------------------------------
// RPC routing: multiple providers scored by latency and success (spec §12)
// ---------------------------------------------------------------------------

export interface RpcProviderStats {
  url: string;
  latencies: number[];
  successes: number;
  failures: number;
  lastError?: string;
  disabledUntil?: number;
}

export class RpcRouter {
  private providers: RpcProviderStats[];
  constructor(urls: string[]) {
    this.providers = urls.map((url) => ({ url, latencies: [], successes: 0, failures: 0 }));
  }
  score(p: RpcProviderStats, now: number): number {
    if (p.disabledUntil && p.disabledUntil > now) return -1;
    const total = p.successes + p.failures;
    const success = total === 0 ? 0.8 : p.successes / total;
    const lat = p.latencies.length ? mean(p.latencies.slice(-20)) : 500;
    return success * 100 - lat / 50;
  }
  best(now = Date.now()): RpcProviderStats | null {
    const ranked = this.providers.map((p) => ({ p, s: this.score(p, now) })).filter((x) => x.s >= 0).sort((a, b) => b.s - a.s);
    return ranked[0]?.p ?? null;
  }
  record(url: string, ok: boolean, latencyMs: number, error?: string, now = Date.now()): void {
    const p = this.providers.find((x) => x.url === url);
    if (!p) return;
    p.latencies.push(latencyMs);
    if (p.latencies.length > 200) p.latencies.shift();
    if (ok) p.successes++;
    else {
      p.failures++;
      p.lastError = error;
      const recent = p.failures / Math.max(1, p.successes + p.failures);
      if (recent > 0.5 && p.failures >= 3) p.disabledUntil = now + 60_000;
    }
  }
  /** 0..1 overall health: share of providers usable weighted by their score. */
  health(now = Date.now()): number {
    const scores = this.providers.map((p) => this.score(p, now));
    const usable = scores.filter((s) => s >= 0);
    if (usable.length === 0) return 0;
    return clamp((usable.length / this.providers.length) * (Math.max(...usable) / 100), 0, 1);
  }
  snapshot(): RpcProviderStats[] {
    return this.providers.map((p) => ({ ...p, latencies: p.latencies.slice(-20) }));
  }
}

// ---------------------------------------------------------------------------
// Priority fee adaptation to congestion
// ---------------------------------------------------------------------------

export interface CongestionState {
  /** 0..1 estimate of network congestion. */
  level: number;
  /** Recent landing rate of our transactions. */
  landingRate: number;
}

export function priorityFeeUsd(c: CongestionState, base = 0.02, max = 2.5): number {
  const f = base * (1 + 8 * c.level ** 2) * (c.landingRate < 0.8 ? 1.5 : 1);
  return clamp(f, base, max);
}

// ---------------------------------------------------------------------------
// Quote + slippage + simulation
// ---------------------------------------------------------------------------

export interface QuoteSource {
  name: string;
  quote(pool: Pool, side: TradeSide, sizeUsd: number, now: number): Promise<Quote | null>;
}

/** Deterministic constant-product quoting against the pool's own reserves (always available). */
export class PoolQuoteSource implements QuoteSource {
  name = 'pool-cpmm';
  constructor(private feeBps = 30, private congestion: () => CongestionState = () => ({ level: 0.2, landingRate: 0.95 }), private latency = () => 120) {}
  async quote(pool: Pool, side: TradeSide, sizeUsd: number, now: number): Promise<Quote | null> {
    if (pool.quoteReserveUsd <= 0) return null;
    const impact = constantProductImpactPct(pool.quoteReserveUsd, sizeUsd);
    const c = this.congestion();
    const worst = clamp(impact * (1.3 + c.level) + 0.5, 0, 100);
    const fee = (sizeUsd * this.feeBps) / 10_000;
    const success = clamp(0.98 - 0.4 * c.level ** 2 - (impact > 30 ? 0.3 : 0) - (1 - c.landingRate) * 0.5, 0.05, 0.99);
    return {
      route: `${pool.dex}:${pool.id}`,
      provider: this.name,
      inputUsd: sizeUsd,
      expectedOutputUsd: sizeUsd * (1 - impact / 100) - fee,
      expectedImpactPct: impact,
      worstCaseImpactPct: worst,
      estimatedFeeUsd: fee,
      priorityFeeUsd: priorityFeeUsd(c),
      simulatedSuccessProbability: success,
      latencyMs: this.latency(),
      quotedAt: now,
    };
  }
}

export class QuoteEngine {
  constructor(private sources: QuoteSource[]) {}
  /** Compare all routes and return the best expected output (spec §12 "Quote engine"). */
  async best(pool: Pool, side: TradeSide, sizeUsd: number, now: number): Promise<Quote | null> {
    const quotes = (await Promise.all(this.sources.map((s) => s.quote(pool, side, sizeUsd, now).catch(() => null)))).filter((q): q is Quote => !!q);
    if (quotes.length === 0) return null;
    return quotes.sort((a, b) => b.expectedOutputUsd * b.simulatedSuccessProbability - a.expectedOutputUsd * a.simulatedSuccessProbability)[0];
  }
}

// ---------------------------------------------------------------------------
// Kill switch + audit log
// ---------------------------------------------------------------------------

export interface KillSwitchConfig {
  minRpcHealth: number;
  minRecentLandingRate: number;
  maxRecentSlippageErrorPct: number;
  window: number;
}

export class KillSwitch {
  private recent: Array<{ landed: boolean; slippageErrPct: number }> = [];
  private manual = false;
  private reason: string | null = null;
  constructor(private cfg: KillSwitchConfig = { minRpcHealth: 0.4, minRecentLandingRate: 0.7, maxRecentSlippageErrorPct: 4, window: 20 }) {}
  record(landed: boolean, slippageErrPct: number): void {
    this.recent.push({ landed, slippageErrPct });
    if (this.recent.length > this.cfg.window) this.recent.shift();
  }
  trip(reason: string): void {
    this.manual = true;
    this.reason = reason;
  }
  reset(): void {
    this.manual = false;
    this.reason = null;
    this.recent = [];
  }
  evaluate(rpcHealth: number): { tripped: boolean; reason: string | null } {
    if (this.manual) return { tripped: true, reason: this.reason };
    if (rpcHealth < this.cfg.minRpcHealth) return { tripped: true, reason: `rpc health ${rpcHealth.toFixed(2)} below ${this.cfg.minRpcHealth}` };
    if (this.recent.length >= 5) {
      const landing = this.recent.filter((r) => r.landed).length / this.recent.length;
      if (landing < this.cfg.minRecentLandingRate) return { tripped: true, reason: `landing rate ${(landing * 100).toFixed(0)}%` };
      const err = mean(this.recent.filter((r) => r.landed).map((r) => Math.abs(r.slippageErrPct)));
      if (err > this.cfg.maxRecentSlippageErrorPct) return { tripped: true, reason: `quoted-vs-actual slippage error ${err.toFixed(1)}%` };
    }
    return { tripped: false, reason: null };
  }
}

export class AuditLog {
  private events: ExecutionEvent[] = [];
  constructor(private sink?: (e: ExecutionEvent) => void) {}
  record(orderId: string, kind: ExecutionEvent['kind'], detail: Record<string, unknown>, timestamp = Date.now()): ExecutionEvent {
    const e: ExecutionEvent = { id: newId('xev'), orderId, kind, timestamp, detail };
    this.events.push(e);
    this.sink?.(e);
    return e;
  }
  forOrder(orderId: string): ExecutionEvent[] {
    return this.events.filter((e) => e.orderId === orderId);
  }
  all(): ExecutionEvent[] {
    return [...this.events];
  }
}

// ---------------------------------------------------------------------------
// Execution engine (paper + live adapter interface)
// ---------------------------------------------------------------------------

export interface TransactionFill {
  filledPriceUsd: number;
  filledUsd: number;
  signature: string;
  /** Token quantity received (buy) or sold (sell), in token units. */
  filledTokenAmount?: number;
}

export interface TransactionSender {
  /** Submit a swap; returns fill or throws. Implementations must simulate before sending. */
  send(order: Order, quote: Quote): Promise<TransactionFill>;
  /** Wallet public key, for auditing. */
  readonly walletAddress: string;
}

export interface ExecutionConfig {
  maxImpactPct: number;
  minSuccessProbability: number;
  maxQuoteAgeMs: number;
  /** For paper mode: realized slippage noise as a fraction of expected impact. */
  paperSlippageNoise: () => number;
}

export const DEFAULT_EXECUTION_CONFIG: ExecutionConfig = {
  maxImpactPct: 8,
  minSuccessProbability: 0.85,
  maxQuoteAgeMs: 3000,
  paperSlippageNoise: () => 0.2,
};

export class ExecutionEngine {
  constructor(
    private quotes: QuoteEngine,
    private rpc: RpcRouter,
    private killSwitch: KillSwitch,
    private audit: AuditLog,
    private cfg: ExecutionConfig = DEFAULT_EXECUTION_CONFIG,
    private sender?: TransactionSender,
  ) {}

  /** "Know how to sell before entering": probe the exit path for the intended size. */
  async probeExit(pool: Pool, sizeUsd: number, now: number): Promise<Quote | null> {
    return this.quotes.best(pool, 'sell', sizeUsd, now);
  }

  setSender(sender: TransactionSender | undefined): void {
    this.sender = sender;
  }

  hasSender(): boolean {
    return !!this.sender;
  }

  async execute(pool: Pool, side: TradeSide, sizeUsd: number, mode: 'paper' | 'live', now = Date.now(), currentPriceUsd = pool.quoteReserveUsd / Math.max(1e-9, pool.tokenReserve), amountToken?: number): Promise<Order> {
    const order: Order = { id: newId('ord'), tokenMint: pool.tokenMint, side, sizeUsd, amountToken, status: 'requested', mode, createdAt: now, updatedAt: now };
    const reject = (reason: string) => {
      order.status = 'rejected';
      order.rejectReason = reason;
      order.updatedAt = now;
      this.audit.record(order.id, 'fail', { reason }, now);
      return order;
    };
    const ks = this.killSwitch.evaluate(this.rpc.health(now));
    if (ks.tripped && side === 'buy') {
      this.audit.record(order.id, 'kill-switch', { reason: ks.reason }, now);
      return reject(`kill switch: ${ks.reason}`);
    }
    if (side === 'buy') {
      const exit = await this.probeExit(pool, sizeUsd, now);
      if (!exit || exit.simulatedSuccessProbability < this.cfg.minSuccessProbability) return reject('exit path not viable');
    }
    const quote = await this.quotes.best(pool, side, sizeUsd, now);
    if (!quote) return reject('no route');
    order.quote = quote;
    order.status = 'quoted';
    this.audit.record(order.id, 'quote', { ...quote }, now);
    if (now - quote.quotedAt > this.cfg.maxQuoteAgeMs) return reject('stale quote');
    if (side === 'buy' && quote.expectedImpactPct > this.cfg.maxImpactPct) return reject(`impact ${quote.expectedImpactPct.toFixed(1)}% > ${this.cfg.maxImpactPct}%`);
    // Simulation gate.
    order.status = 'simulated';
    this.audit.record(order.id, 'simulation', { successProbability: quote.simulatedSuccessProbability }, now);
    if (quote.simulatedSuccessProbability < this.cfg.minSuccessProbability) return reject(`simulated success ${(quote.simulatedSuccessProbability * 100).toFixed(0)}% too low`);

    order.status = 'submitted';
    this.audit.record(order.id, 'submit', { route: quote.route, mode }, now);
    try {
      let fill: TransactionFill;
      if (mode === 'live') {
        if (!this.sender) throw new Error('no live transaction sender configured');
        fill = await this.sender.send(order, quote);
        order.txSignature = fill.signature;
        order.filledTokenAmount = fill.filledTokenAmount;
      } else {
        // Paper: realized impact = expected * (1 + noise); sells get value out, buys pay value in.
        const noise = this.cfg.paperSlippageNoise();
        const realizedImpact = quote.expectedImpactPct * (1 + noise);
        const px = side === 'buy' ? currentPriceUsd * (1 + realizedImpact / 100) : currentPriceUsd * (1 - realizedImpact / 100);
        fill = { filledPriceUsd: px, filledUsd: side === 'buy' ? sizeUsd : sizeUsd * (1 - realizedImpact / 100) - quote.estimatedFeeUsd, signature: `paper_${order.id}` };
      }
      order.status = 'filled';
      order.filledPriceUsd = fill.filledPriceUsd;
      order.filledUsd = fill.filledUsd;
      const refPx = currentPriceUsd;
      order.slippagePct = refPx > 0 ? Math.abs(fill.filledPriceUsd / refPx - 1) * 100 : 0;
      order.updatedAt = now;
      this.killSwitch.record(true, order.slippagePct - quote.expectedImpactPct);
      this.audit.record(order.id, 'confirm', { ...fill, slippagePct: order.slippagePct, quotedImpactPct: quote.expectedImpactPct }, now);
    } catch (e) {
      this.killSwitch.record(false, 0);
      return reject(`transaction failed: ${(e as Error).message}`);
    }
    return order;
  }
}
