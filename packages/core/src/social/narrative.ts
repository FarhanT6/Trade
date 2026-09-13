import type { Narrative, SentimentDistribution, SocialPost } from '../types.js';
import { clamp, leadLag, mean, ratio, unique } from '../util/stats.js';
import { computeSocialVelocity, momentumLabel } from './velocity.js';
import { themeText, tokenize } from './entities.js';

/** Pluggable embedding provider. The default is a hashed TF-IDF bag of words (no network). */
export interface Embedder {
  embed(texts: string[]): Promise<number[][]>;
}

export class HashedTfidfEmbedder implements Embedder {
  constructor(private dims = 512) {}
  async embed(texts: string[]): Promise<number[][]> {
    const docs = texts.map(tokenize);
    const df = new Map<string, number>();
    for (const d of docs) for (const w of unique(d)) df.set(w, (df.get(w) ?? 0) + 1);
    const n = docs.length;
    return docs.map((d) => {
      const v = new Array<number>(this.dims).fill(0);
      const tf = new Map<string, number>();
      for (const w of d) tf.set(w, (tf.get(w) ?? 0) + 1);
      for (const [w, c] of tf) {
        const idf = Math.log((1 + n) / (1 + (df.get(w) ?? 0))) + 1;
        let h = 2166136261;
        for (let i = 0; i < w.length; i++) h = Math.imul(h ^ w.charCodeAt(i), 16777619);
        const idx = (h >>> 0) % this.dims;
        const sign = (h >>> 31) === 0 ? 1 : -1;
        v[idx] += sign * (c / d.length) * idf;
      }
      const norm = Math.sqrt(v.reduce((s, x) => s + x * x, 0)) || 1;
      return v.map((x) => x / norm);
    });
  }
}

export function cosine(a: number[], b: number[]): number {
  let s = 0;
  for (let i = 0; i < a.length; i++) s += a[i] * b[i];
  return s;
}

const BULL = ['moon', 'bullish', 'send', 'pump', 'gem', 'ape', 'lfg', 'buy', 'buying', 'accumulate', 'breakout', 'running', 'early', 'undervalued', 'alpha', '100x', '10x'];
const BEAR = ['rug', 'scam', 'dump', 'dumping', 'bearish', 'sell', 'selling', 'exit', 'dead', 'rekt', 'honeypot', 'fake', 'avoid', 'warning', 'jeet', 'crash'];

export function sentimentOf(text: string): 'bullish' | 'bearish' | 'mixed' | 'uncertain' {
  const words = tokenize(text);
  const b = words.filter((w) => BULL.includes(w)).length;
  const r = words.filter((w) => BEAR.includes(w)).length;
  if (b === 0 && r === 0) return 'uncertain';
  if (b > 0 && r > 0 && Math.abs(b - r) <= 1) return 'mixed';
  return b > r ? 'bullish' : 'bearish';
}

export function sentimentDistribution(posts: SocialPost[]): SentimentDistribution {
  const d: SentimentDistribution = { bullish: 0, bearish: 0, mixed: 0, uncertain: 0 };
  for (const p of posts) d[sentimentOf(p.text)] += 1;
  const n = Math.max(1, posts.length);
  return { bullish: d.bullish / n, bearish: d.bearish / n, mixed: d.mixed / n, uncertain: d.uncertain / n };
}

export interface NarrativeOptions {
  similarityThreshold?: number;
  minClusterSize?: number;
  embedder?: Embedder;
  /** Called to label a cluster; default = top keywords. */
  labeler?: (posts: SocialPost[], keywords: string[]) => Promise<string>;
}

/**
 * Narrative engine (spec §4.3): posts -> entities -> embeddings -> clustering ->
 * labels -> sentiment -> velocity -> influencer concentration -> authenticity -> momentum.
 * Clustering is greedy centroid-based (online-friendly) rather than a fixed keyword list.
 */
export async function clusterNarratives(posts: SocialPost[], now: number, opts: NarrativeOptions = {}): Promise<Narrative[]> {
  if (posts.length === 0) return [];
  const threshold = opts.similarityThreshold ?? 0.35;
  const minSize = opts.minClusterSize ?? 3;
  const embedder = opts.embedder ?? new HashedTfidfEmbedder();
  const vecs = await embedder.embed(posts.map((p) => themeText(p.text)));
  const clusters: Array<{ centroid: number[]; members: number[] }> = [];
  const order = posts.map((_, i) => i).sort((a, b) => posts[a].timestamp - posts[b].timestamp);
  for (const i of order) {
    let best = -1;
    let bestSim = threshold;
    for (let c = 0; c < clusters.length; c++) {
      const sim = cosine(vecs[i], clusters[c].centroid);
      if (sim > bestSim) {
        bestSim = sim;
        best = c;
      }
    }
    if (best === -1) {
      clusters.push({ centroid: [...vecs[i]], members: [i] });
    } else {
      const cl = clusters[best];
      cl.members.push(i);
      const n = cl.members.length;
      for (let k = 0; k < cl.centroid.length; k++) cl.centroid[k] = (cl.centroid[k] * (n - 1) + vecs[i][k]) / n;
    }
  }
  const out: Narrative[] = [];
  for (const cl of clusters) {
    if (cl.members.length < minSize) continue;
    const ps = cl.members.map((i) => posts[i]);
    const freq = new Map<string, number>();
    for (const p of ps) for (const w of unique(tokenize(themeText(p.text)))) freq.set(w, (freq.get(w) ?? 0) + 1);
    const keywords = [...freq].sort((a, b) => b[1] - a[1]).slice(0, 6).map(([w]) => w);
    const label = opts.labeler ? await opts.labeler(ps, keywords) : keywords.slice(0, 3).join(' / ');
    const vel = computeSocialVelocity(label, ps, now);
    const authorPosts = new Map<string, number>();
    for (const p of ps) authorPosts.set(p.authorId, (authorPosts.get(p.authorId) ?? 0) + 1);
    const topAuthorShare = Math.max(...authorPosts.values()) / ps.length;
    const followerWeighted = ps.reduce((s, p) => s + p.authorFollowers, 0);
    const topFollowerShare = followerWeighted > 0 ? Math.max(...[...new Set(ps.map((p) => p.authorId))].map((a) => ps.filter((p) => p.authorId === a)[0].authorFollowers)) / followerWeighted : 0;
    const tokenMints = unique(ps.flatMap((p) => p.contracts));
    const tickers = unique(ps.flatMap((p) => p.tickers));
    out.push({
      id: `nar_${label.replace(/[^a-z0-9]+/gi, '-').slice(0, 24)}_${cl.members[0]}`,
      label,
      keywords: unique([...keywords, ...tickers.map((t) => `$${t}`)]),
      firstSeen: Math.min(...ps.map((p) => p.timestamp)),
      lastSeen: Math.max(...ps.map((p) => p.timestamp)),
      postIds: ps.map((p) => p.id),
      tokenMints,
      sentiment: sentimentDistribution(ps),
      momentum: momentumLabel(vel),
      momentumScore: vel.velocityScore,
      authenticity: clamp(1 - vel.botLikelihood, 0, 1),
      influencerConcentration: clamp(0.5 * topAuthorShare + 0.5 * topFollowerShare, 0, 1),
      catalyst: detectCatalyst(ps),
    });
  }
  return out.sort((a, b) => b.momentumScore - a.momentumScore);
}

const CATALYST_PATTERNS: Array<[RegExp, string]> = [
  [/\b(listing|listed|binance|coinbase|bybit|okx)\b/i, 'exchange listing chatter'],
  [/\b(elon|musk|trump|celebrity|kanye|drake)\b/i, 'celebrity / public-figure mention'],
  [/\b(airdrop|snapshot)\b/i, 'airdrop / snapshot'],
  [/\b(burn|buyback)\b/i, 'burn / buyback'],
  [/\b(partnership|collab|announcement)\b/i, 'partnership / announcement'],
  [/\b(migrat|graduat|bonded|raydium)\b/i, 'launch migration / bonding'],
  [/\b(meme|viral|tiktok|trend)\b/i, 'viral meme'],
];

export function detectCatalyst(posts: SocialPost[]): string | undefined {
  const counts = new Map<string, number>();
  for (const p of posts) for (const [re, label] of CATALYST_PATTERNS) if (re.test(p.text)) counts.set(label, (counts.get(label) ?? 0) + 1);
  const best = [...counts].sort((a, b) => b[1] - a[1])[0];
  return best && best[1] >= Math.max(2, posts.length * 0.15) ? best[0] : undefined;
}

/**
 * Does social attention lead or follow price? Positive lag = social leads price by `lag` buckets.
 * Returns correlation strength so callers can ignore weak relationships.
 */
export function socialPriceLeadLag(mentionSeries: number[], priceSeries: number[], maxLag = 6): { lagBuckets: number; corr: number; relation: 'leads' | 'confirms' | 'follows' | 'unrelated' } {
  const returns: number[] = [];
  for (let i = 1; i < priceSeries.length; i++) returns.push(priceSeries[i - 1] > 0 ? priceSeries[i] / priceSeries[i - 1] - 1 : 0);
  const ll = leadLag(mentionSeries.slice(1), returns, maxLag);
  const relation = Math.abs(ll.corr) < 0.2 ? 'unrelated' : ll.lag > 0 ? 'leads' : ll.lag < 0 ? 'follows' : 'confirms';
  return { lagBuckets: ll.lag, corr: ll.corr, relation };
}

/** Contradiction detection (spec §4.5): social hype rising while on-chain demand falls. */
export function detectContradiction(velocityScore: number, mentionAcceleration: number, buyerAcceleration: number, volumeQuality: number): { contradiction: boolean; severity: number } {
  const hype = velocityScore > 65 && mentionAcceleration > 1.5;
  const demandFalling = buyerAcceleration < 0.8 || volumeQuality < 0.4;
  const severity = hype && demandFalling ? clamp(0.5 * (mentionAcceleration - 1) / 3 + 0.5 * (1 - Math.min(buyerAcceleration, 1)), 0, 1) : 0;
  return { contradiction: hype && demandFalling, severity };
}

export const _test = { mean, ratio };
