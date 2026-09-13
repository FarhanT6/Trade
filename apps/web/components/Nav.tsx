'use client';
import Link from 'next/link';
import { usePathname } from 'next/navigation';
import { useSnapshot } from './useSnapshot';

export function Nav() {
  const path = usePathname();
  const { snap, connected } = useSnapshot();
  const link = (href: string, label: string) => <Link href={href} className={path === href ? 'active' : ''}>{label}</Link>;
  const sources = snap ? Object.entries(snap.health) : [];
  return (
    <div className="topbar">
      <span className="brand">MEME INTEL</span>
      <nav>{link('/', 'Terminal')}{link('/pattern-lab', 'Top-Trader Pattern Lab')}{link('/portfolio', 'Portfolio & Execution')}</nav>
      <span style={{ flex: 1 }} />
      {snap && <span className="pill">regime {snap.regime.regime} · breadth {(snap.regime.breadth * 100).toFixed(0)}%</span>}
      {snap && <span className={`pill ${snap.execution.killSwitch.tripped ? 'bad' : 'ok'}`}>exec {snap.execution.killSwitch.tripped ? 'HALTED' : 'ok'} · rpc {(snap.execution.rpcHealth * 100).toFixed(0)}%</span>}
      {sources.map(([n, h]) => <span key={n} className={`pill ${h.ok ? 'ok' : ''}`} title={h.detail}>{n}</span>)}
      <span className={`pill ${connected ? 'ok' : 'bad'}`}>{connected ? 'live' : 'reconnecting'}</span>
      {snap && <span className="muted">{new Date(snap.now).toISOString().replace('T', ' ').slice(0, 16)}</span>}
    </div>
  );
}
