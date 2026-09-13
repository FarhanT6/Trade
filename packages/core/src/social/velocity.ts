import type { SocialPost, SocialVelocity } from '../types.js';
import { MS, acceleration, clamp, mean, ratio, unique } from '../util/stats.js';

export interface VelocityOptions {
  bucketMs?: number;
  buckets?: number;
  /** Followers threshold to count as "larger" account for diffusion. */
  influencerFollowers?: number;
  /** Accounts younger than this are "new-account participation". */
  newAccountMs?: number;
}

export function bucketize(posts: SocialPost[], now: number, bucketMs: number, buckets: number): SocialPost[][] {
  const out: SocialPost[][] = Array.from({ length: buckets }, () => []);
  for (const p of posts) {
    const idx = buckets - 1 - Math.floor((now - p.timestamp) / bucketMs);
    if (idx >= 0 && idx < buckets) out[idx].push(p);
  }
  return out;
}

/** Copy-paste / bot amplification estimate from language repetition and account features. */
export function estimateBotLikelihood(posts: SocialPost[], now: number, newAccountMs = 30 * MS.d): number {
  if (posts.length < 5) return 0;
  const norm = posts.map((p) => p.text.toLowerCase().replace(/https?:\/\/\S+/g, '').replace(/[^a-z0-9 ]/g, '').trim());
  const dup = 1 - ratio(unique(norm).length, norm.length);
  const authors = unique(posts.map((p) => p.authorId)).length;
  const authorRatio = ratio(authors, posts.length);
  const newAcc = ratio(posts.filter((p) => now - p.authorCreatedAt < newAccountMs).length, posts.length);
  const engagementQuality = mean(
    posts.map((p) => {
      const e = p.engagement.likes + p.engagement.reposts + p.engagement.replies + p.engagement.quotes;
      return p.authorFollowers > 0 ? clamp(e / Math.sqrt(p.authorFollowers), 0, 1) : 0;
    }),
  );
  // Posts far below expected engagement per follower with heavy repetition read as amplification.
  return clamp(0.45 * dup + 0.25 * (1 - authorRatio) + 0.2 * newAcc + 0.1 * (1 - engagementQuality), 0, 1);
}

/** Narrative velocity features (spec §4.4). */
export function computeSocialVelocity(subject: string, posts: SocialPost[], now: number, opts: VelocityOptions = {}): SocialVelocity {
  const bucketMs = opts.bucketMs ?? 15 * MS.m;
  const buckets = opts.buckets ?? 8;
  const influencer = opts.influencerFollowers ?? 50_000;
  const b = bucketize(posts, now, bucketMs, buckets);
  const mentions = b.map((x) => x.length);
  const uniqueAuthors = b.map((x) => unique(x.map((p) => p.authorId)).length);
  const engagement = b.map((x) => x.reduce((s, p) => s + p.engagement.likes + p.engagement.reposts + p.engagement.replies + p.engagement.quotes, 0));
  const last = buckets - 1;
  const cur = (arr: number[]) => arr[last] + arr[last - 1];
  const prev = (arr: number[]) => arr[last - 2] + arr[last - 3];
  const mentionAcceleration = acceleration(cur(mentions), prev(mentions), 50, 3);
  const uniqueAuthorAcceleration = acceleration(cur(uniqueAuthors), prev(uniqueAuthors), 50, 3);
  const engagementAcceleration = acceleration(cur(engagement), prev(engagement), 50, 10);

  const recent = [...b[last], ...b[last - 1]];
  const earlier = b.slice(0, last - 1).flat();
  const quoteVelocity = ratio(recent.filter((p) => p.isQuote).length, Math.max(1, recent.length));
  const newAccountShare = ratio(recent.filter((p) => now - p.authorCreatedAt < (opts.newAccountMs ?? 30 * MS.d)).length, Math.max(1, recent.length));
  const bigEarly = ratio(earlier.filter((p) => p.authorFollowers >= influencer).length, Math.max(1, earlier.length));
  const bigRecent = ratio(recent.filter((p) => p.authorFollowers >= influencer).length, Math.max(1, recent.length));
  // Diffusion: narrative moving from small to large accounts.
  const influencerDiffusion = clamp(bigRecent - bigEarly + (bigRecent > 0 && bigEarly === 0 ? 0.3 : 0), 0, 1);
  const platformsEarly = unique(earlier.map((p) => p.platform)).length;
  const platformsRecent = unique(recent.map((p) => p.platform)).length;
  const crossPlatformDiffusion = clamp((platformsRecent - platformsEarly) / 3 + (platformsRecent >= 3 ? 0.3 : 0), 0, 1);
  // Saturation: mention volume relative to a broad baseline (posts/hour), extremely crowded = late-entry warning.
  const perHour = (cur(mentions) / (2 * bucketMs)) * MS.h;
  const saturation = clamp(Math.log10(1 + perHour) / 4, 0, 1);
  const botLikelihood = estimateBotLikelihood(posts, now, opts.newAccountMs);

  const raw =
    0.3 * clamp(Math.log2(mentionAcceleration + 1e-9) / 3, -1, 1) +
    0.3 * clamp(Math.log2(uniqueAuthorAcceleration + 1e-9) / 3, -1, 1) +
    0.15 * clamp(Math.log2(engagementAcceleration + 1e-9) / 3, -1, 1) +
    0.15 * influencerDiffusion +
    0.1 * crossPlatformDiffusion;
  const velocityScore = clamp(50 + 50 * raw, 0, 100) * (1 - 0.6 * botLikelihood) * (1 - 0.3 * Math.max(0, saturation - 0.7));

  return {
    subject,
    timestamp: now,
    mentions,
    uniqueAuthors,
    engagement,
    mentionAcceleration,
    uniqueAuthorAcceleration,
    engagementAcceleration,
    quoteVelocity,
    newAccountShare,
    influencerDiffusion,
    crossPlatformDiffusion,
    saturation,
    botLikelihood,
    velocityScore: clamp(velocityScore, 0, 100),
  };
}

export function momentumLabel(v: SocialVelocity): 'accelerating' | 'stable' | 'fading' {
  if (v.mentionAcceleration > 1.5 && v.uniqueAuthorAcceleration > 1.2) return 'accelerating';
  if (v.mentionAcceleration < 0.7) return 'fading';
  return 'stable';
}
