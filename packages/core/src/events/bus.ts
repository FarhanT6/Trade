import type { AuthorityChange, LiquidityEvent, SocialPost, Trade, Transfer, LeaderboardSnapshot, Pool, TokenSecurity, HolderSnapshot, Token } from '../types.js';

/** Typed platform events. Topic names map 1:1 to Kafka/Redis Streams/NATS subjects. */
export interface PlatformEvents {
  'chain.token.created': Token;
  'chain.trade': Trade;
  'chain.transfer': Transfer;
  'chain.liquidity': LiquidityEvent;
  'chain.authority': AuthorityChange;
  'chain.pool': Pool;
  'chain.security': TokenSecurity;
  'chain.holders': HolderSnapshot;
  'social.post': SocialPost;
  'platform.leaderboard': LeaderboardSnapshot;
}

export type Topic = keyof PlatformEvents;

export interface Envelope<T extends Topic = Topic> {
  topic: T;
  payload: PlatformEvents[T];
  /** Event time (from the source), not ingest time. */
  timestamp: number;
  source: string;
}

export type Handler<T extends Topic> = (e: Envelope<T>) => void | Promise<void>;

export interface EventBus {
  publish<T extends Topic>(e: Envelope<T>): Promise<void>;
  subscribe<T extends Topic>(topic: T, handler: Handler<T>): () => void;
}

/** In-process bus for tests, simulation and single-node deployments. */
export class InMemoryEventBus implements EventBus {
  private handlers = new Map<Topic, Set<Handler<any>>>();
  private queue: Envelope[] = [];
  private draining = false;
  published = 0;

  subscribe<T extends Topic>(topic: T, handler: Handler<T>): () => void {
    const set = this.handlers.get(topic) ?? new Set();
    set.add(handler);
    this.handlers.set(topic, set);
    return () => set.delete(handler);
  }

  async publish<T extends Topic>(e: Envelope<T>): Promise<void> {
    this.published++;
    this.queue.push(e);
    if (this.draining) return;
    this.draining = true;
    try {
      while (this.queue.length) {
        const next = this.queue.shift()!;
        for (const h of this.handlers.get(next.topic) ?? []) await h(next);
      }
    } finally {
      this.draining = false;
    }
  }
}

/**
 * Redis Streams bus. Uses a minimal RESP client contract so the core package has no hard
 * dependency; pass any client exposing `xadd`/`xread` (ioredis is compatible).
 */
export interface RedisLike {
  xadd(key: string, id: string, ...fieldValues: string[]): Promise<string>;
  xread(...args: (string | number)[]): Promise<Array<[string, Array<[string, string[]]>]> | null>;
}

export class RedisStreamsEventBus implements EventBus {
  private handlers = new Map<Topic, Set<Handler<any>>>();
  private running = false;
  constructor(private redis: RedisLike, private prefix = 'meme-intel', private blockMs = 1000) {}
  async publish<T extends Topic>(e: Envelope<T>): Promise<void> {
    await this.redis.xadd(`${this.prefix}:${e.topic}`, '*', 'payload', JSON.stringify(e.payload), 'ts', String(e.timestamp), 'source', e.source);
  }
  subscribe<T extends Topic>(topic: T, handler: Handler<T>): () => void {
    const set = this.handlers.get(topic) ?? new Set();
    set.add(handler);
    this.handlers.set(topic, set);
    if (!this.running) void this.loop();
    return () => set.delete(handler);
  }
  stop(): void {
    this.running = false;
  }
  private async loop(): Promise<void> {
    this.running = true;
    const cursors = new Map<string, string>();
    while (this.running) {
      const topics = [...this.handlers.keys()];
      if (topics.length === 0) break;
      const keys = topics.map((t) => `${this.prefix}:${t}`);
      const ids = keys.map((k) => cursors.get(k) ?? '$');
      const res = await this.redis.xread('BLOCK', this.blockMs, 'STREAMS', ...keys, ...ids);
      if (!res) continue;
      for (const [key, entries] of res) {
        const topic = key.slice(this.prefix.length + 1) as Topic;
        for (const [id, fields] of entries) {
          cursors.set(key, id);
          const f: Record<string, string> = {};
          for (let i = 0; i < fields.length; i += 2) f[fields[i]] = fields[i + 1];
          const env: Envelope = { topic, payload: JSON.parse(f.payload), timestamp: Number(f.ts), source: f.source };
          for (const h of this.handlers.get(topic) ?? []) await h(env);
        }
      }
    }
  }
}
