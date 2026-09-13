import {
  AnthropicProvider, DexScreenerAdapter, InMemoryEventBus, IntelligenceEngine, MS, PlatformAdapter, RedditAdapter, SimulationAdapter, SimulationWorld, SolanaRpcAdapter, XAdapter,
  type EngineSnapshot, type SourceAdapter,
} from '@meme-intel/core';
import type { Config } from './config.js';

export interface Runtime {
  engine: IntelligenceEngine;
  adapters: SourceAdapter[];
  world: SimulationWorld | null;
  /** Current (simulated or wall) clock in ms. */
  now(): number;
  /** Advance one tick: poll adapters, publish, recompute. */
  tick(): Promise<void>;
  start(): void;
  stop(): void;
  onSnapshot(cb: (s: EngineSnapshot) => void): () => void;
  ticks: number;
}

export function createRuntime(cfg: Config): Runtime {
  const bus = new InMemoryEventBus();
  const llm = cfg.anthropicApiKey ? new AnthropicProvider(cfg.anthropicApiKey, cfg.llmModel) : undefined;
  const listeners = new Set<(s: EngineSnapshot) => void>();
  let timer: NodeJS.Timeout | null = null;
  let ticks = 0;

  if (cfg.mode === 'simulation') {
    const world = new SimulationWorld({ seed: cfg.simSeed, tokens: cfg.simTokens, wallets: cfg.simWallets, spanMs: 4 * MS.d });
    const adapter = new SimulationAdapter(world);
    let simNow = world.start;
    let cursor = world.start - 40 * MS.d;
    const stepMs = 5 * MS.m;
    const engine = new IntelligenceEngine({ bus, now: () => simNow, priceHistory: world, intendedSizeUsd: cfg.intendedSizeUsd, startEquityUsd: cfg.startEquityUsd, llm, rpcUrls: ['sim://rpc-a', 'sim://rpc-b', 'sim://rpc-c'] });
    for (const st of world.tokens) engine.setDeployerHistory(st.deployer);
    engine.health['simulation'] = { ok: true, detail: `${world.tokens.length} tokens / ${world.wallets.length} wallets / seed ${cfg.simSeed}` };
    for (const n of ['x', 'reddit', 'fomo', 'axiom', 'fomp']) engine.health[n] = { ok: false, detail: 'simulation mode: source not used' };
    const rt: Runtime = {
      engine,
      adapters: [adapter],
      world,
      ticks,
      now: () => simNow,
      async tick() {
        if (simNow >= world.end - MS.h) {
          // Loop the world: restart the clock but keep learned state (similarity index, outcomes).
          simNow = world.start;
          cursor = world.start - 40 * MS.d;
          engine.tokens.clear();
          engine.tradesByToken.clear();
          engine.posts.length = 0;
          engine.evaluations.clear();
          engine.paperPositions.clear();
        }
        simNow += stepMs;
        for (const e of await adapter.poll(cursor, simNow)) await bus.publish(e);
        cursor = simNow;
        engine.rpc.record('sim://rpc-a', true, 80 + Math.random() * 60);
        engine.rpc.record('sim://rpc-b', Math.random() > 0.05, 120 + Math.random() * 200);
        engine.rpc.record('sim://rpc-c', true, 60 + Math.random() * 40);
        await engine.recompute(simNow, { heavy: ticks % 3 === 0 });
        ticks++;
        rt.ticks = ticks;
        const snap = engine.snapshot(simNow);
        for (const l of listeners) l(snap);
      },
      start() {
        if (timer) return;
        const intervalMs = Math.max(200, (stepMs / MS.m / cfg.simSpeed) * 1000);
        const loop = async () => {
          try {
            await rt.tick();
          } catch (e) {
            console.error('[runtime] tick failed', e);
          }
          timer = setTimeout(loop, intervalMs);
        };
        timer = setTimeout(loop, 0);
      },
      stop() {
        if (timer) clearTimeout(timer);
        timer = null;
      },
      onSnapshot(cb) {
        listeners.add(cb);
        return () => listeners.delete(cb);
      },
    };
    return rt;
  }

  // ---- live mode: official adapters only ----
  const adapters: SourceAdapter[] = [
    new SolanaRpcAdapter(cfg.solanaRpcUrls),
    new DexScreenerAdapter(cfg.dexscreenerBaseUrl),
    new XAdapter(cfg.xBearerToken, ['(solana OR pumpfun OR memecoin) (lang:en)']),
    new RedditAdapter(cfg.reddit.clientId, cfg.reddit.clientSecret, cfg.reddit.userAgent, ['memecoins', 'solana', 'CryptoMoonShots']),
    new PlatformAdapter({ name: 'fomo', baseUrl: cfg.platforms.fomo?.baseUrl, apiKey: cfg.platforms.fomo?.apiKey }),
    new PlatformAdapter({ name: 'axiom', baseUrl: cfg.platforms.axiom?.baseUrl, apiKey: cfg.platforms.axiom?.apiKey }),
    new PlatformAdapter({ name: 'fomp', baseUrl: cfg.platforms.fomp?.baseUrl }),
  ];
  const engine = new IntelligenceEngine({ bus, now: () => Date.now(), intendedSizeUsd: cfg.intendedSizeUsd, startEquityUsd: cfg.startEquityUsd, llm, rpcUrls: cfg.solanaRpcUrls });
  let cursor = Date.now() - 15 * MS.m;
  const rt: Runtime = {
    engine,
    adapters,
    world: null,
    ticks,
    now: () => Date.now(),
    async tick() {
      const now = Date.now();
      for (const a of adapters) {
        const t0 = Date.now();
        try {
          const events = await a.poll(cursor, now);
          for (const e of events) {
            await bus.publish(e);
            if (e.topic === 'chain.token.created') (adapters[0] as SolanaRpcAdapter).track((e.payload as { mint: string }).mint);
          }
          engine.health[a.name] = await a.health();
          if (a.kind === 'chain') engine.rpc.record(cfg.solanaRpcUrls[0], true, Date.now() - t0);
        } catch (err) {
          engine.health[a.name] = { ok: false, detail: (err as Error).message };
          if (a.kind === 'chain') engine.rpc.record(cfg.solanaRpcUrls[0], false, Date.now() - t0, (err as Error).message);
        }
      }
      cursor = now;
      await engine.recompute(now);
      ticks++;
      rt.ticks = ticks;
      const snap = engine.snapshot(now);
      for (const l of listeners) l(snap);
    },
    start() {
      if (timer) return;
      const loop = async () => {
        try {
          await rt.tick();
        } catch (e) {
          console.error('[runtime] tick failed', e);
        }
        timer = setTimeout(loop, 20_000);
      };
      timer = setTimeout(loop, 0);
    },
    stop() {
      if (timer) clearTimeout(timer);
      timer = null;
    },
    onSnapshot(cb) {
      listeners.add(cb);
      return () => listeners.delete(cb);
    },
  };
  return rt;
}
