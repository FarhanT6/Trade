'use client';
import { useState } from 'react';
import { useSnapshot } from './useSnapshot';
import { Bar } from './Bar';
import { fmtAge, fmtUsd, short } from '@/lib/api';

const WINDOWS = ['24h', '7d', '30d', '90d', 'all'];

/** Top-Trader Pattern Lab (spec §17): what are the best traders doing that the market has not priced? */
export function PatternLab() {
  const { snap } = useSnapshot();
  const [win, setWin] = useState('30d');
  const [topN, setTopN] = useState(10);
  if (!snap) return <div className="page muted">Connecting…</div>;
  const lb = (snap.leaderboards[win] ?? []).slice(0, topN);
  const cohort = snap.cohorts.find((c) => c.window === win);
  const repeated = new Map(snap.repeatedTraders.map((r) => [r.wallet, r.windows]));
  return (
    <div className="page">
      <div className="tabs" style={{ border: 'none', padding: 0 }}>
        {WINDOWS.map((w) => <button key={w} className={win === w ? 'on' : ''} onClick={() => setWin(w)}>{w}</button>)}
        <span style={{ width: 16 }} />
        {[10, 20].map((n) => <button key={n} className={topN === n ? 'on' : ''} onClick={() => setTopN(n)}>top {n}</button>)}
        <span className="muted" style={{ marginLeft: 'auto' }}>ranked by risk-adjusted skill, never raw PnL · {snap.similarityCases} historical cases · {snap.outcomes} labeled outcomes</span>
      </div>
      <div className="cols">
        <section className="panel">
          <h2>Leaderboard {win} <span className="muted">{lb.length} traders</span></h2>
          <div className="body">
            <table>
              <thead><tr><th>#</th><th>wallet</th><th className="num">skill</th><th className="num">pnl</th><th className="num">wr</th><th className="num">pf</th><th className="num">R</th><th className="num">hold</th><th className="num">dd</th><th className="num">rug</th><th className="num">n</th><th>archetype</th><th>repeat</th></tr></thead>
              <tbody>{lb.map((p, i) => <tr key={p.wallet}><td className="muted">{i + 1}</td><td>{short(p.wallet)}</td><td className="num"><Bar v={p.riskAdjustedSkill} /> {p.riskAdjustedSkill.toFixed(0)}</td><td className={`num ${p.realizedPnlUsd >= 0 ? 'pos' : 'neg'}`}>{fmtUsd(p.realizedPnlUsd)}</td><td className="num">{(p.winRate * 100).toFixed(0)}%</td><td className="num">{p.profitFactor.toFixed(1)}</td><td className="num">{p.averageR.toFixed(2)}</td><td className="num">{fmtAge(p.medianHoldMs)}</td><td className="num">{p.maxDrawdownPct.toFixed(0)}%</td><td className={`num ${p.rugExposure > 0.2 ? 'neg' : ''}`}>{(p.rugExposure * 100).toFixed(0)}%</td><td className="num">{p.sampleSize}</td><td>{p.archetype}</td><td className="muted">{(repeated.get(p.wallet) ?? []).join('/')}</td></tr>)}</tbody>
            </table>
          </div>
        </section>
        <section className="panel">
          <h2>Consensus without correlation <span className="muted">{cohort?.independentClusters ?? 0} independent clusters in cohort</span></h2>
          <div className="body">
            <table>
              <thead><tr><th>token</th><th className="num">traders</th><th className="num">indep.</th><th className="num">consensus</th><th className="num">entry mcap</th><th className="num">entry age</th><th className="num">hold</th><th>first mover</th><th>lag</th></tr></thead>
              <tbody>{(cohort?.commonTokens ?? []).slice(0, 25).map((t) => <tr key={t.tokenMint}><td>${t.symbol}</td><td className="num">{t.traders.length}</td><td className="num">{t.independentClusters}</td><td className="num"><Bar v={t.consensusScore} /> {t.consensusScore.toFixed(0)}</td><td className="num">{fmtUsd(t.medianEntryMcapUsd)}</td><td className="num">{fmtAge(t.medianEntryAgeMs)}</td><td className="num">{fmtAge(t.medianHoldMs)}</td><td>{short(t.firstEntry.wallet)}</td><td className="muted">{t.leadLagMs.length > 1 ? `median +${fmtAge(t.leadLagMs.slice().sort((a, b) => a - b)[Math.floor(t.leadLagMs.length / 2)])}` : '–'}</td></tr>)}</tbody>
            </table>
            {cohort && cohort.commonTokens.length === 0 && <div className="muted">no token bought by ≥2 cohort members yet</div>}
          </div>
        </section>
      </div>
      {cohort && (
        <div className="cols">
          <section className="panel"><h2>Common entry zone</h2><div className="body kv">
            <div>median entry mcap</div><div>{fmtUsd(cohort.commonEntryZone.medianMcapUsd)}</div>
            <div>median token age at entry</div><div>{fmtAge(cohort.commonEntryZone.medianAgeMs)}</div>
            <div>hold time p25 / median / p75</div><div>{fmtAge(cohort.commonHoldTime.p25Ms)} / {fmtAge(cohort.commonHoldTime.medianMs)} / {fmtAge(cohort.commonHoldTime.p75Ms)}</div>
            <div>scaled entries</div><div>{(cohort.walletBehavior.scaledIn * 100).toFixed(0)}%</div>
            <div>partial exits</div><div>{(cohort.walletBehavior.partialExits * 100).toFixed(0)}%</div>
            <div>rapid flips</div><div>{(cohort.walletBehavior.rapidFlips * 100).toFixed(0)}%</div>
          </div></section>
          <section className="panel"><h2>Common chain / launch / narrative</h2><div className="body">
            <div className="kv">
              {cohort.commonChains.map((c) => <><div key={c.chain}>{c.chain}</div><div><Bar v={c.share * 100} tone="g" /> {(c.share * 100).toFixed(0)}%</div></>)}
              {cohort.commonLaunchTypes.map((c) => <><div key={c.launchType}>{c.launchType}</div><div><Bar v={c.share * 100} /> {(c.share * 100).toFixed(0)}%</div></>)}
            </div>
            <div style={{ marginTop: 8 }}>{cohort.commonNarratives.length ? cohort.commonNarratives.map((n) => <div key={n.narrative} className="finding">"{n.narrative}" · {n.count} tokens</div>) : <span className="muted">no narrative overlap yet</span>}</div>
          </div></section>
          <section className="panel"><h2>First movers vs followers</h2><div className="body">
            <table><thead><tr><th>wallet</th><th className="num">first-mover rate</th></tr></thead><tbody>{cohort.leaders.slice(0, 10).map((l) => <tr key={l.wallet}><td>{short(l.wallet)}</td><td className="num"><Bar v={l.firstMoverRate * 100} tone="g" /> {(l.firstMoverRate * 100).toFixed(0)}%</td></tr>)}</tbody></table>
            <h3 className="muted" style={{ margin: '10px 0 4px' }}>Traders who act together</h3>
            {cohort.traderOverlap.slice(0, 8).map((o) => <div key={o.a + o.b} className="finding">{short(o.a)} ↔ {short(o.b)} · {o.sharedTokens} shared tokens</div>)}
          </div></section>
        </div>
      )}
      <section className="panel"><h2>Narratives <span className="muted">clustered from posts, not a fixed list</span></h2><div className="body">
        <table><thead><tr><th>narrative</th><th>momentum</th><th className="num">score</th><th className="num">authenticity</th><th className="num">bullish</th><th>catalyst</th><th className="num">tokens</th></tr></thead>
        <tbody>{snap.narratives.map((n) => <tr key={n.id}><td>{n.label}</td><td className={n.momentum === 'accelerating' ? 'pos' : n.momentum === 'fading' ? 'neg' : ''}>{n.momentum}</td><td className="num">{n.momentumScore.toFixed(0)}</td><td className={`num ${n.authenticity < 0.5 ? 'neg' : ''}`}>{(n.authenticity * 100).toFixed(0)}%</td><td className="num">{(n.sentiment.bullish * 100).toFixed(0)}%</td><td className="muted">{n.catalyst ?? '–'}</td><td className="num">{n.tokenMints.length}</td></tr>)}</tbody></table>
      </div></section>
    </div>
  );
}
