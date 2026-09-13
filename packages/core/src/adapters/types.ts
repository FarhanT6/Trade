import type { Envelope } from '../events/bus.js';

/**
 * Replaceable source adapter (spec "Important implementation note"): every external
 * platform is an adapter behind this interface so it can be swapped when APIs, pricing
 * or terms change. Adapters must use official APIs, public/licensed data or explicit
 * permission and must degrade gracefully: `health()` reports availability so the
 * pipeline never treats missing data as neutral.
 */
export interface SourceAdapter {
  readonly name: string;
  readonly kind: 'chain' | 'dex' | 'social' | 'platform';
  /** Whether the adapter is configured (keys present) and reachable. */
  health(): Promise<{ ok: boolean; detail?: string }>;
  /** Pull events since `since` (ms). Streaming adapters can buffer and drain here. */
  poll(since: number, now: number): Promise<Envelope[]>;
}

export interface HttpClient {
  (url: string, init?: RequestInit): Promise<Response>;
}

export class RateLimiter {
  private tokens: number;
  private last: number;
  constructor(private perMinute: number, private nowFn: () => number = Date.now) {
    this.tokens = perMinute;
    this.last = nowFn();
  }
  take(): boolean {
    const now = this.nowFn();
    this.tokens = Math.min(this.perMinute, this.tokens + ((now - this.last) / 60_000) * this.perMinute);
    this.last = now;
    if (this.tokens >= 1) {
      this.tokens -= 1;
      return true;
    }
    return false;
  }
}
