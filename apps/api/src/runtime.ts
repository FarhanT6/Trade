import {
  AnthropicProvider, DexScreenerAdapter, InMemoryEventBus, IntelligenceEngine, MS, PlatformAdapter, RedditAdapter, SimulationAdapter, SimulationWorld, SolanaRpcAdapter, XAdapter,
  type EngineSnapshot, type SourceAdapter,
} from '@meme-intel/core';
import { createLiveExecution, type LiveExecution } from '@meme-intel/solana';
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
  /** Simulation clock controls (absent in live mode). */
  sim?: { state(): { speed: number; paused: boolean; simNow: number; stepMs: number }; setSpeed(minutesPerSecond: number): void; setPaused(paused: boolean): void };
}

/**
 * Builds the runtime. In live mode, on-chain execution is armed only when every gate in
 * `createLiveExecution` passes (explicit flag + acknowledgement, caps, hot-wallet key,
 * reachable RPC, wallet balance band); otherwise live mode still runs but trades on paper.
 */
export async function createRuntime(cfg: Config): Promise<Runtime> {
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
    let speed = Math.max(0.1, cfg.simSpeed);
    let paused = false;
    let lastEmit = 0;
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
        // Push to SSE subscribers at most once per second so the UI stays readable at high speeds.
        const wall = Date.now();
        if (wall - lastEmit >= 1000) {
          lastEmit = wall;
          const snap = engine.snapshot(simNow);
          for (const l of listeners) l(snap);
        }
      },
      start() {
        if (timer) return;
        const loop = async () => {
          if (!paused) {
            try {
              await rt.tick();
            } catch (e) {
              console.error('[runtime] tick failed', e);
            }
          }
          const intervalMs = paused ? 500 : Math.max(200, (stepMs / MS.m / speed) * 1000);
          timer = setTimeout(loop, intervalMs);
        };
        timer = setTimeout(loop, 0);
      },
      sim: {
        state: () => ({ speed, paused, simNow, stepMs }),
        setSpeed: (v) => {
          speed = Math.min(120, Math.max(0.1, v));
        },
        setPaused: (p) => {
          paused = p;
          if (p) {
            const snap = engine.snapshot(simNow);
            for (const l of listeners) l(snap);
          }
        },
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
  let live: LiveExecution | null = null;
  let liveError: string | null = null;
  if (cfg.live.enabled) {
    try {
      live = await createLiveExecution({
        enabled: cfg.live.enabled,
        acknowledgement: cfg.live.acknowledgement,
        rpcUrls: cfg.solanaRpcUrls,
        maxTradeUsd: cfg.live.maxTradeUsd,
        dailyCapUsd: cfg.live.dailyCapUsd,
        minWalletSol: cfg.live.minWalletSol,
        maxWalletSol: cfg.live.maxWalletSol,
        jupiter: { swapBaseUrl: cfg.live.jupiterSwapBaseUrl, priceBaseUrl: cfg.live.jupiterPriceBaseUrl, apiKey: cfg.live.jupiterApiKey, slippageBps: cfg.live.slippageBps, maxPriorityFeeLamports: cfg.live.maxPriorityFeeLamports, allowedDexes: cfg.live.allowedDexes },
      });
      console.warn(`\n[LIVE EXECUTION ARMED] wallet ${live.walletAddress} (${live.walletSol.toFixed(3)} SOL) · max $${live.limits.maxTradeUsd}/trade · $${live.limits.dailyCapUsd}/day · kill switch: POST /api/execution/kill-switch\n`);
    } catch (e) {
      liveError = (e as Error).message;
      console.error(`[live execution] NOT armed, staying on paper: ${liveError}`);
    }
  }
  const engine = new IntelligenceEngine({
    bus, now: () => Date.now(), intendedSizeUsd: live ? Math.min(cfg.intendedSizeUsd, live.limits.maxTradeUsd) : cfg.intendedSizeUsd, startEquityUsd: cfg.startEquityUsd, llm, rpcUrls: cfg.solanaRpcUrls,
    executionMode: live ? 'live' : 'paper', quoteSources: live ? [live.quoteSource] : undefined, sender: live?.sender, liveLimits: live?.limits,
  });
  engine.health['live-execution'] = live ? { ok: true, detail: `armed: ${live.walletAddress.slice(0, 6)}… $${live.limits.maxTradeUsd}/trade $${live.limits.dailyCapUsd}/day` } : { ok: false, detail: liveError ?? 'paper mode (LIVE_EXECUTION_ENABLED != true)' };
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
