import type { SocialPost } from '../types.js';
import type { Envelope } from '../events/bus.js';
import { extractEntities } from '../social/entities.js';
import { RateLimiter, type HttpClient, type SourceAdapter } from './types.js';

/** X API v2 recent search (official API; usage/cost controls via rate limiter). */
export class XAdapter implements SourceAdapter {
  name = 'x';
  kind = 'social' as const;
  private limiter: RateLimiter;
  constructor(private bearer: string | undefined, private queries: string[], private highSignalAuthors: Set<string> = new Set(), private fetchFn: HttpClient = fetch, perMinute = 10) {
    this.limiter = new RateLimiter(perMinute);
  }
  async health() {
    if (!this.bearer) return { ok: false, detail: 'X_BEARER_TOKEN not configured' };
    return { ok: true };
  }
  async poll(since: number, now: number): Promise<Envelope[]> {
    if (!this.bearer) return [];
    const out: Envelope[] = [];
    for (const q of this.queries) {
      if (!this.limiter.take()) break;
      const url = new URL('https://api.x.com/2/tweets/search/recent');
      url.searchParams.set('query', `${q} -is:retweet`);
      url.searchParams.set('max_results', '100');
      url.searchParams.set('start_time', new Date(since).toISOString());
      url.searchParams.set('tweet.fields', 'created_at,public_metrics,author_id,referenced_tweets');
      url.searchParams.set('expansions', 'author_id');
      url.searchParams.set('user.fields', 'created_at,public_metrics');
      const r = await this.fetchFn(url.toString(), { headers: { authorization: `Bearer ${this.bearer}` } });
      if (!r.ok) continue;
      const j = (await r.json()) as { data?: any[]; includes?: { users?: any[] } };
      const users = new Map((j.includes?.users ?? []).map((u: any) => [u.id, u]));
      for (const t of j.data ?? []) {
        const u = users.get(t.author_id) ?? {};
        const ent = extractEntities(t.text ?? '');
        const post: SocialPost = {
          id: `x_${t.id}`,
          platform: 'x',
          authorId: t.author_id,
          authorFollowers: u.public_metrics?.followers_count ?? 0,
          authorCreatedAt: u.created_at ? Date.parse(u.created_at) : now,
          authorHighSignal: this.highSignalAuthors.has(t.author_id),
          text: t.text ?? '',
          timestamp: t.created_at ? Date.parse(t.created_at) : now,
          engagement: { likes: t.public_metrics?.like_count ?? 0, reposts: t.public_metrics?.retweet_count ?? 0, replies: t.public_metrics?.reply_count ?? 0, quotes: t.public_metrics?.quote_count ?? 0 },
          isQuote: (t.referenced_tweets ?? []).some((r: any) => r.type === 'quoted'),
          tickers: ent.tickers,
          contracts: ent.contracts,
          urls: ent.urls,
        };
        out.push({ topic: 'social.post', payload: post, timestamp: post.timestamp, source: this.name });
      }
    }
    return out;
  }
}

/** Reddit official API (OAuth client credentials) adapter for subreddit new posts + comments. */
export class RedditAdapter implements SourceAdapter {
  name = 'reddit';
  kind = 'social' as const;
  private token: { value: string; expires: number } | null = null;
  private limiter = new RateLimiter(60);
  constructor(private clientId: string | undefined, private clientSecret: string | undefined, private userAgent: string, private subreddits: string[], private fetchFn: HttpClient = fetch) {}
  async health() {
    if (!this.clientId || !this.clientSecret) return { ok: false, detail: 'REDDIT_CLIENT_ID/SECRET not configured' };
    return { ok: true };
  }
  private async auth(now: number): Promise<string | null> {
    if (!this.clientId || !this.clientSecret) return null;
    if (this.token && this.token.expires > now) return this.token.value;
    const r = await this.fetchFn('https://www.reddit.com/api/v1/access_token', {
      method: 'POST',
      headers: { authorization: `Basic ${btoa(`${this.clientId}:${this.clientSecret}`)}`, 'content-type': 'application/x-www-form-urlencoded', 'user-agent': this.userAgent },
      body: 'grant_type=client_credentials',
    });
    if (!r.ok) return null;
    const j = (await r.json()) as { access_token: string; expires_in: number };
    this.token = { value: j.access_token, expires: now + (j.expires_in - 60) * 1000 };
    return j.access_token;
  }
  async poll(since: number, now: number): Promise<Envelope[]> {
    const tok = await this.auth(now);
    if (!tok) return [];
    const out: Envelope[] = [];
    for (const sub of this.subreddits) {
      if (!this.limiter.take()) break;
      const r = await this.fetchFn(`https://oauth.reddit.com/r/${sub}/new?limit=100`, { headers: { authorization: `Bearer ${tok}`, 'user-agent': this.userAgent } });
      if (!r.ok) continue;
      const j = (await r.json()) as { data: { children: Array<{ data: any }> } };
      for (const { data: d } of j.data.children) {
        const ts = d.created_utc * 1000;
        if (ts < since) continue;
        const text = `${d.title ?? ''} ${d.selftext ?? ''}`;
        const ent = extractEntities(text);
        const post: SocialPost = {
          id: `rd_${d.id}`,
          platform: 'reddit',
          authorId: d.author,
          authorFollowers: 0,
          authorCreatedAt: now - 365 * 86_400_000, // author age requires a separate call; treated as established
          authorHighSignal: false,
          text,
          timestamp: ts,
          engagement: { likes: d.ups ?? 0, reposts: 0, replies: d.num_comments ?? 0, quotes: 0 },
          isQuote: false,
          tickers: ent.tickers,
          contracts: ent.contracts,
          urls: ent.urls,
          community: sub,
        };
        out.push({ topic: 'social.post', payload: post, timestamp: ts, source: this.name });
      }
    }
    return out;
  }
}
