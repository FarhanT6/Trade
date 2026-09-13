'use client';
import Link from 'next/link';
import { usePathname } from 'next/navigation';
import { useEffect, useState } from 'react';
import { useSnapshot } from './useSnapshot';
import { getJson, postJson } from '@/lib/api';

interface SimState { speed: number; paused: boolean; simNow: number; stepMs: number }

export function Nav() {
  const path = usePathname();
  const { snap, connected } = useSnapshot();
  const [sim, setSim] = useState<SimState | null>(null);
  const isSim = !!snap?.health?.simulation;
  useEffect(() => {
    if (!isSim) return;
    getJson<SimState>('/api/sim').then(setSim).catch(() => {});
  }, [isSim]);
  const setSimState = async (body: Partial<SimState>) => setSim(await postJson<SimState>('/api/sim', body));
  const link = (href: string, label: string) => <Link href={href} className={path === href ? 'active' : ''}>{label}</Link>;
  const sources = snap ? Object.entries(snap.health).filter(([n]) => n !== 'simulation') : [];
  return (
    <div className="topbar">
      <span className="brand">MEME INTEL</span>
      <nav>{link('/', 'Terminal')}{link('/pattern-lab', 'Top-Trader Pattern Lab')}{link('/portfolio', 'Portfolio & Execution')}</nav>
      <span style={{ flex: 1 }} />
      {isSim && (
        <span className="simctl" title="This is a synthetic market. The clock is simulated; pause it or change how many simulated minutes pass per real second.">
          <span className="pill warn">SIMULATED MARKET</span>
          <button onClick={() => setSimState({ paused: !sim?.paused })}>{sim?.paused ? '▶ resume' : '⏸ pause'}</button>
          {[1, 2, 5, 15].map((s) => <button key={s} className={sim && !sim.paused && sim.speed === s ? 'on' : ''} onClick={() => setSimState({ speed: s, paused: false })}>{s}x</button>)}
        </span>
      )}
      {snap && <span className="pill">regime {snap.regime.regime} · breadth {(snap.regime.breadth * 100).toFixed(0)}%</span>}
      {snap && <span className={`pill ${snap.execution.mode === 'live' ? 'bad' : 'warn'}`} title={snap.execution.mode === 'live' ? `LIVE: real funds · max $${snap.execution.liveLimits.maxTradeUsd}/trade · $${snap.execution.liveLimits.dailyCapUsd}/day` : 'paper trading: simulated fills'}>{snap.execution.mode === 'live' ? '● LIVE ON-CHAIN' : 'paper'}</span>}
      {snap && <span className={`pill ${snap.execution.killSwitch.tripped ? 'bad' : 'ok'}`}>exec {snap.execution.killSwitch.tripped ? 'HALTED' : 'ok'} · rpc {(snap.execution.rpcHealth * 100).toFixed(0)}%</span>}
      {sources.map(([n, h]) => <span key={n} className={`pill ${h.ok ? 'ok' : ''}`} title={h.detail}>{n}</span>)}
      <span className={`pill ${connected ? 'ok' : 'bad'}`}>{connected ? 'live' : 'reconnecting'}</span>
      {snap && <span className="muted" title={isSim ? 'simulated clock' : 'wall clock'}>{isSim ? '⌚ ' : ''}{new Date(snap.now).toISOString().replace('T', ' ').slice(0, 16)}</span>}
    </div>
  );
}
