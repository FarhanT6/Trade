import { describe, expect, it } from 'vitest';
import { computeSocialVelocity, estimateBotLikelihood } from '../social/velocity.js';
import { clusterNarratives, detectContradiction, sentimentOf, socialPriceLeadLag } from '../social/narrative.js';
import { extractEntities, resolveTokens } from '../social/entities.js';
import type { SocialPost } from '../types.js';
import { MS } from '../util/stats.js';
import { NOW } from './helpers.js';

function post(over: Partial<SocialPost>): SocialPost {
  return { id: Math.random().toString(36), platform: 'x', authorId: 'a', authorFollowers: 1000, authorCreatedAt: NOW - 400 * MS.d, authorHighSignal: false, text: 'hello', timestamp: NOW - MS.m, engagement: { likes: 5, reposts: 1, replies: 1, quotes: 0 }, isQuote: false, tickers: [], contracts: [], urls: [], ...over };
}

describe('entities', () => {
  it('extracts cashtags, contracts and urls; contract wins over ambiguous ticker', () => {
    const e = extractEntities('$PEPE is back https://x.com/a 7EYnhQoR9YM3N7UoaKRoA44Uy8JeaZV3qyouov87awMs');
    expect(e.tickers).toEqual(['PEPE']);
    expect(e.contracts[0]).toBe('7EYnhQoR9YM3N7UoaKRoA44Uy8JeaZV3qyouov87awMs');
    expect(e.urls).toHaveLength(1);
    const r = resolveTokens(e, new Map([['PEPE', ['m1', 'm2']]]), new Set(['7EYnhQoR9YM3N7UoaKRoA44Uy8JeaZV3qyouov87awMs']));
    expect(r.mints).toEqual(['7EYnhQoR9YM3N7UoaKRoA44Uy8JeaZV3qyouov87awMs']);
    expect(r.ambiguous).toBe(false);
    expect(resolveTokens(extractEntities('$PEPE'), new Map([['PEPE', ['m1', 'm2']]]), new Set()).ambiguous).toBe(true);
  });
});

describe('velocity', () => {
  it('scores accelerating unique-author mentions higher than flat ones', () => {
    const flat: SocialPost[] = [];
    const accel: SocialPost[] = [];
    for (let i = 0; i < 8; i++) for (let k = 0; k < 5; k++) flat.push(post({ authorId: `f${i}_${k}`, timestamp: NOW - i * 15 * MS.m - k * 1000 - 1 }));
    for (let i = 0; i < 8; i++) for (let k = 0; k < (i < 2 ? 25 : 3); k++) accel.push(post({ authorId: `a${i}_${k}`, timestamp: NOW - i * 15 * MS.m - k * 1000 - 1 }));
    const vf = computeSocialVelocity('x', flat, NOW);
    const va = computeSocialVelocity('x', accel, NOW);
    expect(va.mentionAcceleration).toBeGreaterThan(3);
    expect(va.velocityScore).toBeGreaterThan(vf.velocityScore);
  });
  it('flags copy-paste amplification from new accounts as bot-like', () => {
    const bots = Array.from({ length: 30 }, (_, i) => post({ authorId: `b${i % 5}`, authorCreatedAt: NOW - 2 * MS.d, authorFollowers: 10, text: 'BUY $X NOW 100x guaranteed', engagement: { likes: 0, reposts: 0, replies: 0, quotes: 0 } }));
    const organic = Array.from({ length: 30 }, (_, i) => post({ authorId: `o${i}`, text: `thought ${i}: ${['ai', 'dog', 'cat'][i % 3]} coin ${i * 7} looks interesting` }));
    expect(estimateBotLikelihood(bots, NOW)).toBeGreaterThan(0.6);
    expect(estimateBotLikelihood(organic, NOW)).toBeLessThan(0.3);
  });
});

describe('narratives', () => {
  it('clusters posts into themes without a fixed list', async () => {
    const posts: SocialPost[] = [];
    for (let i = 0; i < 12; i++) posts.push(post({ authorId: `a${i}`, text: `ai agents framework autonomous $AGNT agent launch is bullish ${i}`, timestamp: NOW - i * MS.m }));
    for (let i = 0; i < 12; i++) posts.push(post({ authorId: `d${i}`, text: `dog coin doge puppy woof $WOOF moon ${i}`, timestamp: NOW - i * MS.m }));
    const n = await clusterNarratives(posts, NOW, { minClusterSize: 4 });
    expect(n.length).toBe(2);
    expect(n.map((x) => x.label).join(' ')).toMatch(/ai|agents/);
    expect(n.every((x) => x.sentiment.bullish > 0.5)).toBe(true);
  });
  it('sentiment and contradiction', () => {
    expect(sentimentOf('this is a rug, scam, dump')).toBe('bearish');
    expect(sentimentOf('moon gem lfg')).toBe('bullish');
    expect(detectContradiction(80, 3, 0.5, 0.3).contradiction).toBe(true);
    expect(detectContradiction(80, 3, 1.5, 0.9).contradiction).toBe(false);
  });
  it('lead/lag finds social leading price', () => {
    const mentions = [1, 1, 1, 10, 30, 40, 20, 10, 5, 5, 5, 5];
    const price = [1, 1, 1, 1, 1.05, 1.4, 2.2, 2.6, 2.4, 2.2, 2.0, 1.9];
    const r = socialPriceLeadLag(mentions, price, 4);
    expect(r.relation).toBe('leads');
    expect(r.lagBuckets).toBeGreaterThan(0);
  });
});
