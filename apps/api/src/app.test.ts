import { describe, expect, it } from 'vitest';
import { loadConfig } from './config.js';
import { createRuntime } from './runtime.js';
import { buildApp, runBacktest } from './app.js';

describe('api', () => {
  it('serves snapshot, token detail, pattern lab and backtest after simulation ticks', async () => {
    const rt = createRuntime(loadConfig({ mode: 'simulation', simTokens: 16, simWallets: 120, simSeed: 3 }));
    for (let i = 0; i < 80; i++) await rt.tick();
    const app = buildApp(rt);
    const health = await app.inject({ method: 'GET', url: '/api/health' });
    expect(health.json().mode).toBe('simulation');
    const snap = await app.inject({ method: 'GET', url: '/api/snapshot' });
    const body = snap.json();
    expect(body.watchlist.length).toBeGreaterThan(0);
    const detail = await app.inject({ method: 'GET', url: `/api/tokens/${body.watchlist[0].tokenMint}` });
    expect(detail.statusCode).toBe(200);
    expect(detail.json().cardText).toContain('Decision:');
    expect((await app.inject({ method: 'GET', url: '/api/tokens/nope' })).statusCode).toBe(404);
    const lab = await app.inject({ method: 'GET', url: '/api/pattern-lab' });
    expect(lab.json().cohorts).toHaveLength(5);
    const ks = await app.inject({ method: 'POST', url: '/api/execution/kill-switch', payload: { reason: 'test' } });
    expect(ks.json().tripped).toBe(true);
    await app.inject({ method: 'DELETE', url: '/api/execution/kill-switch' });
    const bt = runBacktest(rt.engine, rt);
    expect(bt.overall.map((o) => o.policy)).toContain('random-entry');
    await app.close();
  }, 120_000);
});
