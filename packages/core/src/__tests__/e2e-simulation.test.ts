import { describe, expect, it } from 'vitest';
import { InMemoryEventBus } from '../events/bus.js';
import { SimulationAdapter, SimulationWorld } from '../adapters/simulation.js';
import { IntelligenceEngine } from '../pipeline/engine.js';
import { MS } from '../util/stats.js';

describe('end-to-end simulation', () => {
  it('runs the full loop: ingest -> evaluate -> alert -> paper trade -> label outcomes', async () => {
    const world = new SimulationWorld({ seed: 7, tokens: 24, wallets: 160, spanMs: 2 * MS.d });
    const adapter = new SimulationAdapter(world);
    const bus = new InMemoryEventBus();
    let now = world.start;
    const engine = new IntelligenceEngine({ bus, now: () => now, priceHistory: world, outcomeHorizonMs: 6 * MS.h, intendedSizeUsd: 300 });
    for (const st of world.tokens) engine.setDeployerHistory(st.deployer);
    let cursor = world.start - 40 * MS.d; // include funding transfers before the window
    const step = 15 * MS.m;
    while (now < world.start + 30 * MS.h) {
      now += step;
      for (const e of await adapter.poll(cursor, now)) await bus.publish(e);
      cursor = now;
      await engine.recompute(now, { heavy: true });
    }
    const snap = engine.snapshot(now);
    expect(snap.watchlist.length).toBeGreaterThan(5);
    expect(engine.walletGraph.clusters.some((c) => c.wallets.length > 1)).toBe(true);
    expect(snap.narratives.length).toBeGreaterThan(0);
    expect(snap.alerts.length).toBeGreaterThan(0);
    expect(snap.outcomes).toBeGreaterThan(0);
    // Every token with an active rug/honeypot profile that has been evaluated must be blocked.
    for (const st of world.tokens) {
      const ev = engine.evaluations.get(st.token.mint);
      if (!ev) continue;
      if (st.archetype === 'honeypot') expect(ev.card.decision).toBe('HARD_BLOCK');
      if (st.rugAt !== null && now > st.rugAt) expect(ev.card.decision).toBe('HARD_BLOCK');
    }
    // No paper position should ever have been opened on a honeypot.
    const honeypots = new Set(world.tokens.filter((t) => t.archetype === 'honeypot').map((t) => t.token.mint));
    for (const o of engine.orders) if (o.side === 'buy' && o.status === 'filled') expect(honeypots.has(o.tokenMint)).toBe(false);
    // Skilled wallets should dominate the 30d leaderboard.
    const top = snap.leaderboards['30d'].slice(0, 5);
    const skillOf = new Map(world.wallets.map((w) => [w.address, w.skill]));
    if (top.length >= 3) expect(top.reduce((s, p) => s + (skillOf.get(p.wallet) ?? 0), 0) / top.length).toBeGreaterThan(0.5);
    // Decision card detail is serializable for the API.
    const detail = engine.tokenDetail(snap.watchlist[0].tokenMint, now);
    expect(detail).not.toBeNull();
    expect(() => JSON.stringify(detail)).not.toThrow();
  }, 120_000);
});
