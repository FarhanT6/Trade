import Fastify, { type FastifyInstance } from 'fastify';
import cors from '@fastify/cors';
import { POLICIES, formatDecisionCard, replay, walkForwardFolds, type EngineSnapshot, type Outcome, type ReplayStep } from '@meme-intel/core';
import type { Runtime } from './runtime.js';

export function buildApp(rt: Runtime): FastifyInstance {
  const app = Fastify({ logger: false });
  app.register(cors, { origin: true });
  const { engine } = rt;

  app.get('/api/health', async () => ({ ok: true, mode: rt.world ? 'simulation' : 'live', now: rt.now(), ticks: rt.ticks, sources: engine.health, execution: { rpcHealth: engine.rpc.health(rt.now()), killSwitch: engine.killSwitch.evaluate(engine.rpc.health(rt.now())) } }));
  app.get('/api/snapshot', async () => engine.snapshot(rt.now()));
  app.get('/api/tokens', async () => engine.snapshot(rt.now()).watchlist);
  app.get<{ Params: { mint: string } }>('/api/tokens/:mint', async (req, reply) => {
    const d = engine.tokenDetail(req.params.mint, rt.now());
    if (!d) return reply.code(404).send({ error: 'unknown token' });
    return { ...d, cardText: formatDecisionCard(d.card) };
  });
  app.get('/api/leaderboards', async () => ({ windows: engine.ranked, repeated: engine.snapshot(rt.now()).repeatedTraders, clusters: engine.walletGraph.clusters.filter((c) => c.wallets.length > 1).map((c) => ({ ...c, wallets: c.wallets.slice(0, 20) })) }));
  app.get<{ Params: { wallet: string } }>('/api/traders/:wallet', async (req, reply) => {
    const windows = ['24h', '7d', '30d', '90d', 'all'] as const;
    const profiles = Object.fromEntries(windows.map((w) => [w, engine.profiles.get(`${req.params.wallet}|${w}`) ?? null]));
    if (Object.values(profiles).every((p) => !p)) return reply.code(404).send({ error: 'unknown wallet' });
    return { wallet: req.params.wallet, profiles, cluster: engine.walletGraph.clusters.find((c) => c.id === engine.walletGraph.clusterOf.get(req.params.wallet)) ?? null, positions: engine.positions.filter((p) => p.wallet === req.params.wallet).slice(-50) };
  });
  app.get('/api/pattern-lab', async () => ({ cohorts: engine.cohorts, repeated: engine.snapshot(rt.now()).repeatedTraders, leaderboards: engine.ranked, similarityCases: engine.similarity.size() }));
  app.get('/api/narratives', async () => engine.narratives);
  app.get('/api/alerts', async () => engine.alerts.slice(-200).reverse());
  app.get('/api/portfolio', async () => {
    const s = engine.snapshot(rt.now());
    return { portfolio: s.portfolio, positions: s.paperPositions, closedTrades: engine.closedTrades, equityCurve: engine.equityCurve.slice(-500) };
  });
  app.get('/api/execution', async () => ({ rpc: engine.rpc.snapshot(), killSwitch: engine.killSwitch.evaluate(engine.rpc.health(rt.now())), orders: engine.orders.slice(-100).reverse(), audit: engine.audit.all().slice(-200).reverse() }));
  app.post<{ Body: { reason?: string } }>('/api/execution/kill-switch', async (req) => {
    engine.killSwitch.trip(req.body?.reason ?? 'manual');
    return engine.killSwitch.evaluate(engine.rpc.health(rt.now()));
  });
  app.delete('/api/execution/kill-switch', async () => {
    engine.killSwitch.reset();
    return engine.killSwitch.evaluate(engine.rpc.health(rt.now()));
  });
  app.get('/api/signals', async () => ({ signals: engine.signals.slice(-500), outcomes: engine.outcomes.slice(-500) }));
  app.get('/api/backtest', async () => runBacktest(engine, rt));
  app.get('/api/stream', (req, reply) => {
    reply.raw.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-cache', connection: 'keep-alive', 'access-control-allow-origin': '*' });
    const send = (s: EngineSnapshot) => reply.raw.write(`event: snapshot\ndata: ${JSON.stringify(s)}\n\n`);
    send(engine.snapshot(rt.now()));
    const off = rt.onSnapshot(send);
    const ping = setInterval(() => reply.raw.write(': ping\n\n'), 15_000);
    req.raw.on('close', () => {
      off();
      clearInterval(ping);
    });
  });
  return app;
}

/** Replay every labeled signal through the system policy and the baselines, walk-forward. */
export function runBacktest(engine: Runtime['engine'], rt: Runtime) {
  const byId = new Map(engine.outcomes.map((o) => [o.signalId, o]));
  const steps: ReplayStep[] = engine.signals
    .filter((s) => byId.has(s.id))
    .map((s) => {
      const card = { tokenMint: s.tokenMint, symbol: engine.tokens.get(s.tokenMint)?.symbol ?? '?', timestamp: s.timestamp, scores: s.scores, rugProbability: 0.05, expectedRoundTripCostPct: 3, decision: s.decision, reason: '', suggestedSizeUsd: Math.min(500, engine.equityUsd(rt.now()) * 0.02), freshness: { asOf: s.timestamp, source: 'signal', confidence: 1 } };
      return { timestamp: s.timestamp, tokenMint: s.tokenMint, card, signal: s };
    });
  const resolver = { resolve: (step: ReplayStep): Outcome => byId.get(step.signal.id)! };
  const liquidityAt = (m: string, ts: number) => (rt.world ? rt.world.liquidityAt(m, ts) : engine.pools.get(m)?.liquidityUsd ?? 0);
  const folds = walkForwardFolds(steps, 3, 0.5);
  const policies = Object.values(POLICIES);
  const perFold = folds.map((f, i) => ({ fold: i, train: f.train.length, test: f.test.length, results: policies.map((p) => { const r = replay(f.test, resolver, p, { startEquityUsd: 10_000, liquidityAt, seed: 11 + i }); return { policy: p.name, trades: r.trades.length, metrics: r.metrics }; }) }));
  const overall = policies.map((p) => { const r = replay(steps, resolver, p, { startEquityUsd: 10_000, liquidityAt, seed: 3 }); return { policy: p.name, trades: r.trades.length, missedMoves: r.missedMoves, metrics: r.metrics }; });
  return { signals: steps.length, overall, walkForward: perFold };
}
