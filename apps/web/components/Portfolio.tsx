'use client';
import { useEffect, useState } from 'react';
import { useSnapshot } from './useSnapshot';
import { fmtAge, fmtPct, fmtUsd, fmtTime, getJson, short, API_URL } from '@/lib/api';

export function Portfolio() {
  const { snap } = useSnapshot();
  const [exec, setExec] = useState<any>(null);
  const [bt, setBt] = useState<any>(null);
  const [btBusy, setBtBusy] = useState(false);
  useEffect(() => {
    const load = () => getJson<any>('/api/execution').then(setExec).catch(() => {});
    load();
    const t = setInterval(load, 5000);
    return () => clearInterval(t);
  }, []);
  const runBacktest = async () => {
    setBtBusy(true);
    try { setBt(await getJson<any>('/api/backtest')); } finally { setBtBusy(false); }
  };
  const toggleKill = async () => {
    const tripped = snap?.execution.killSwitch.tripped;
    await fetch(`${API_URL}/api/execution/kill-switch`, { method: tripped ? 'DELETE' : 'POST', headers: { 'content-type': 'application/json' }, body: tripped ? undefined : JSON.stringify({ reason: 'manual from dashboard' }) });
  };
  if (!snap) return <div className="page muted">Connecting…</div>;
  const p = snap.portfolio;
  return (
    <div className="page">
      <div className="cols">
        <section className="panel"><h2>{snap.execution.mode === 'live' ? 'Live portfolio (real funds)' : 'Paper portfolio'} <span>{snap.execution.mode === 'live' && <span className="pill bad" style={{ marginRight: 6 }}>● LIVE · max {fmtUsd(snap.execution.liveLimits.maxTradeUsd)}/trade · {fmtUsd(snap.execution.liveLimits.dailyCapUsd)}/day</span>}<span className={`pill ${p.halted ? 'bad' : 'ok'}`}>{p.halted ? `HALTED: ${p.haltReason}` : 'trading'}</span></span></h2>
          <div className="stat">
            <div><b>{fmtUsd(p.equityUsd)}</b><span>equity</span></div>
            <div><b>{fmtUsd(p.cashUsd)}</b><span>cash / reserve</span></div>
            <div><b className={p.realizedUsd >= 0 ? 'pos' : 'neg'}>{fmtUsd(p.realizedUsd)}</b><span>realized</span></div>
            <div><b>{p.open}</b><span>open</span></div>
            <div><b>{snap.closedTrades.length}</b><span>closed (recent)</span></div>
          </div>
          <div className="body">
            <table><thead><tr><th>token</th><th className="num">size</th><th className="num">entry</th><th className="num">now</th><th className="num">pnl</th><th className="num">remaining</th><th className="num">age</th></tr></thead>
              <tbody>{snap.paperPositions.map((x) => <tr key={x.tokenMint}><td>${x.symbol}</td><td className="num">{fmtUsd(x.sizeUsd)}</td><td className="num">{x.entryPriceUsd.toExponential(2)}</td><td className="num">{x.currentPriceUsd.toExponential(2)}</td><td className={`num ${x.pnlPct >= 0 ? 'pos' : 'neg'}`}>{fmtPct(x.pnlPct)}</td><td className="num">{(x.remainingFraction * 100).toFixed(0)}%</td><td className="num muted">{fmtAge(snap.now - x.openedAt)}</td></tr>)}</tbody></table>
            {snap.paperPositions.length === 0 && <div className="muted">no open positions</div>}
            <h3 className="muted" style={{ margin: '10px 0 4px' }}>Closed trades</h3>
            <table><thead><tr><th>exit</th><th>token</th><th className="num">size</th><th className="num">pnl</th><th></th></tr></thead>
              <tbody>{snap.closedTrades.slice().reverse().map((t, i) => <tr key={i}><td className="muted">{fmtTime(t.exitAt)}</td><td>{short(t.tokenMint)}</td><td className="num">{fmtUsd(t.sizeUsd)}</td><td className={`num ${t.pnlPct >= 0 ? 'pos' : 'neg'}`}>{fmtPct(t.pnlPct)} ({fmtUsd(t.pnlUsd)})</td><td className="neg">{t.rugged ? 'rug' : ''}</td></tr>)}</tbody></table>
          </div>
        </section>
        <section className="panel"><h2>Execution engine <button onClick={toggleKill} style={{ font: 'inherit', background: 'none', color: snap.execution.killSwitch.tripped ? '#3ddc97' : '#ff5c7a', border: '1px solid currentColor', borderRadius: 4, padding: '1px 8px', cursor: 'pointer' }}>{snap.execution.killSwitch.tripped ? 'reset kill switch' : 'trip kill switch'}</button></h2>
          <div className="stat">
            <div><b className={snap.execution.rpcHealth < 0.5 ? 'neg' : 'pos'}>{(snap.execution.rpcHealth * 100).toFixed(0)}%</b><span>rpc health</span></div>
            <div><b className={snap.execution.killSwitch.tripped ? 'neg' : 'pos'}>{snap.execution.killSwitch.tripped ? 'TRIPPED' : 'armed'}</b><span>{snap.execution.killSwitch.reason ?? 'kill switch'}</span></div>
            <div><b>{snap.execution.orders}</b><span>orders</span></div>
            <div><b>{snap.execution.auditEvents}</b><span>audit events</span></div>
          </div>
          <div className="body">
            <h3 className="muted" style={{ margin: '4px 0' }}>RPC providers</h3>
            <table><thead><tr><th>provider</th><th className="num">ok</th><th className="num">fail</th><th className="num">latency</th><th>status</th></tr></thead>
              <tbody>{(exec?.rpc ?? []).map((r: any) => <tr key={r.url}><td>{r.url}</td><td className="num pos">{r.successes}</td><td className="num neg">{r.failures}</td><td className="num">{r.latencies.length ? `${Math.round(r.latencies.reduce((a: number, b: number) => a + b, 0) / r.latencies.length)}ms` : '–'}</td><td className="muted">{r.disabledUntil && r.disabledUntil > snap.now ? 'disabled' : 'active'}</td></tr>)}</tbody></table>
            <h3 className="muted" style={{ margin: '10px 0 4px' }}>Orders (quote → simulate → submit → confirm)</h3>
            <table><thead><tr><th>time</th><th>side</th><th className="num">size</th><th>status</th><th className="num">impact q</th><th className="num">slip</th><th>reason</th></tr></thead>
              <tbody>{(exec?.orders ?? []).slice(0, 30).map((o: any) => <tr key={o.id}><td className="muted">{fmtTime(o.createdAt)}</td><td className={o.side === 'buy' ? 'pos' : 'neg'}>{o.side}</td><td className="num">{fmtUsd(o.sizeUsd)}</td><td className={o.status === 'filled' ? 'pos' : o.status === 'rejected' ? 'neg' : ''}>{o.status}</td><td className="num">{o.quote ? `${o.quote.expectedImpactPct.toFixed(2)}%` : '–'}</td><td className="num">{o.slippagePct !== undefined ? `${o.slippagePct.toFixed(2)}%` : '–'}</td><td className="muted">{o.rejectReason ?? ''}</td></tr>)}</tbody></table>
          </div>
        </section>
      </div>
      <section className="panel"><h2>Backtest: system vs baselines (walk-forward, costs + failures modeled) <button onClick={runBacktest} disabled={btBusy} style={{ font: 'inherit', background: 'none', color: '#5aa9ff', border: '1px solid currentColor', borderRadius: 4, padding: '1px 8px', cursor: 'pointer' }}>{btBusy ? 'running…' : 'run on labeled signals'}</button></h2>
        <div className="body">
          {!bt && <div className="muted">Replays every labeled signal ({snap.outcomes} outcomes) through the system policy, buy-and-hold, momentum-only and random-entry controls.</div>}
          {bt && (
            <>
              <div className="muted" style={{ marginBottom: 6 }}>{bt.signals} labeled signals</div>
              {[{ title: 'overall', rows: bt.overall }, ...bt.walkForward.map((f: any) => ({ title: `fold ${f.fold} (train ${f.train} / test ${f.test})`, rows: f.results }))].map((g) => (
                <div key={g.title} style={{ marginBottom: 10 }}>
                  <div className="muted">{g.title}</div>
                  <table><thead><tr><th>policy</th><th className="num">trades</th><th className="num">net EV</th><th className="num">95% CI</th><th className="num">PF</th><th className="num">win</th><th className="num">max DD</th><th className="num">median</th><th className="num">tail 5%</th><th className="num">false +</th><th className="num">capture</th><th className="num">slip</th></tr></thead>
                    <tbody>{g.rows.map((r: any) => <tr key={r.policy}><td className={r.policy === 'system' ? 'pos' : ''}>{r.policy}</td><td className="num">{r.trades}</td><td className={`num ${r.metrics.netExpectedValuePct >= 0 ? 'pos' : 'neg'}`}>{fmtPct(r.metrics.netExpectedValuePct)}</td><td className="num muted">[{r.metrics.evConfidenceInterval.map((x: number) => x.toFixed(1)).join(', ')}]</td><td className="num">{Number.isFinite(r.metrics.profitFactor) ? r.metrics.profitFactor.toFixed(2) : '∞'}</td><td className="num">{(r.metrics.winRate * 100).toFixed(0)}%</td><td className="num">{r.metrics.maxDrawdownPct.toFixed(1)}%</td><td className="num">{fmtPct(r.metrics.medianTradePct)}</td><td className="num neg">{fmtPct(r.metrics.tailLossPct)}</td><td className="num">{(r.metrics.falsePositiveRate * 100).toFixed(0)}%</td><td className="num">{(r.metrics.opportunityCapture * 100).toFixed(0)}%</td><td className="num">{r.metrics.executionSlippagePct.toFixed(2)}%</td></tr>)}</tbody></table>
                </div>
              ))}
            </>
          )}
        </div>
      </section>
    </div>
  );
}
