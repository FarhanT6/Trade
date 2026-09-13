'use client';
import { useEffect, useState } from 'react';
import { useSnapshot } from './useSnapshot';
import { Bar } from './Bar';
import { Sparkline } from './Sparkline';
import { fmtAge, fmtPct, fmtUsd, getJson, short, fmtTime, type WatchRow } from '@/lib/api';

type Detail = any;

export function Terminal() {
  const { snap } = useSnapshot();
  const [sel, setSel] = useState<string | null>(null);
  const [detail, setDetail] = useState<Detail | null>(null);
  const [tab, setTab] = useState<'market' | 'wallets' | 'social' | 'risk'>('market');
  const [showHelp, setShowHelp] = useState(false);
  // The selection is pinned: it is set once (first token seen, or the user's click) and never
  // follows the watchlist ranking, which reshuffles on every tick.
  useEffect(() => {
    if (sel === null && snap?.watchlist.length) setSel(snap.watchlist[0].tokenMint);
  }, [sel, snap?.watchlist.length]);
  useEffect(() => {
    try {
      if (localStorage.getItem('meme-intel-help-dismissed') !== '1') setShowHelp(true);
    } catch {}
  }, []);
  const mint = sel;
  useEffect(() => {
    if (!mint) return;
    let alive = true;
    setDetail(null);
    const load = () => getJson<Detail>(`/api/tokens/${mint}`).then((d) => alive && setDetail(d)).catch(() => {});
    load();
    const t = setInterval(load, 4000);
    return () => {
      alive = false;
      clearInterval(t);
    };
  }, [mint]);
  const dismissHelp = () => {
    setShowHelp(false);
    try { localStorage.setItem('meme-intel-help-dismissed', '1'); } catch {}
  };

  if (!snap) return <div className="page muted">Connecting to API…</div>;
  const m = detail?.market;
  const isSim = !!snap.health?.simulation;
  return (
    <>
    {showHelp && (
      <div className="help">
        <button className="close" onClick={dismissHelp}>got it ✕</button>
        <b>What you are looking at.</b> {isSim ? 'This is a synthetic market (no real tokens, no real money) so every engine can be watched end to end. Use ⏸ pause and the speed buttons in the top bar; the clock next to ⌚ is simulated time.' : 'Live market data; execution mode is shown in the top bar.'} Click a token on the left to pin it; the selection does not move on its own.
        <div className="cols3">
          <div><b>Watchlist (left)</b> · every token the engine is tracking, best setups first. <b>decision</b>: ENTER / CONF ENTRY (wait for buyer confirmation) / WATCH / PASS / BLOCK (a security hard-block, never tradeable). <b>α</b> alpha 0–100. <b>EV</b> net expected value after fees, slippage and rug risk. <b>sec</b> security score. <b>rug</b> rug probability. ✦ = a narrative catalyst is attached.</div>
          <div><b>Token terminal (center)</b> · price, liquidity, volume, buyer acceleration and how much of the volume looks real, with tabs for the market tape, the wallets and clusters trading it, social velocity, and the risk findings behind the security score.</div>
          <div><b>Intelligence (right)</b> · the decision card (all scores + the reason), suggested size, what happened to historically similar tokens, and short analyst notes. <b>Live feed (bottom)</b> · alerts, notable wallet trades, liquidity and security events, paper trades and post-mortems. Pattern Lab and Portfolio are in the top nav.</div>
        </div>
      </div>
    )}
    <div className="grid">
      <section className="panel left">
        <h2>Watchlist <span className="muted">{snap.watchlist.length} live<button className="iconbtn" title="what am I looking at?" onClick={() => setShowHelp(true)}>?</button></span></h2>
        <div className="body">
          <table>
            <thead><tr><th>token</th><th>decision</th><th className="num">α</th><th className="num">EV</th><th className="num">sec</th><th className="num">rug</th><th>fresh</th></tr></thead>
            <tbody>
              {snap.watchlist.map((w: WatchRow) => (
                <tr key={w.tokenMint} className={`row ${w.tokenMint === mint ? 'sel' : ''}`} onClick={() => setSel(w.tokenMint)}>
                  <td title={w.catalyst ?? ''}>${w.symbol}{w.catalyst && <span className="muted"> ✦</span>}</td>
                  <td className={`d-${w.decision}`}>{w.decision.replace('CONFIRMATION_', 'CONF ').replace('HARD_', '')}</td>
                  <td className="num">{w.alpha.toFixed(0)}</td>
                  <td className={`num ${w.netEvPct >= 0 ? 'pos' : 'neg'}`}>{fmtPct(w.netEvPct, 0)}</td>
                  <td className="num">{w.security.toFixed(0)}</td>
                  <td className={`num ${w.rugProbability > 0.2 ? 'neg' : ''}`}>{(w.rugProbability * 100).toFixed(0)}%</td>
                  <td className="muted">{fmtAge(w.freshnessMs)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </section>

      <section className="panel center">
        <h2>Token terminal {detail && <span>${detail.token.symbol} · <span className="muted">{short(detail.token.mint)} · {detail.token.launchType} · age {fmtAge(m.tokenAgeMs)}</span></span>}</h2>
        {!detail ? <div className="body muted">select a token</div> : (
          <>
            <div className="stat">
              <div><b>{m.priceUsd.toExponential(3)}</b><span>price</span></div>
              <div><b>{fmtUsd(m.marketCapUsd)}</b><span>mcap</span></div>
              <div><b>{fmtUsd(m.liquidityUsd)}</b><span>liquidity</span></div>
              <div><b>{fmtUsd(m.intervals['1h'].volumeUsd)}</b><span>vol 1h</span></div>
              <div><b className={m.intervals['15m'].priceChangePct >= 0 ? 'pos' : 'neg'}>{fmtPct(m.intervals['15m'].priceChangePct)}</b><span>15m</span></div>
              <div><b>{m.volumeAcceleration['5m'].toFixed(1)}x</b><span>vol accel 5m</span></div>
              <div><b>{m.buyerAcceleration.toFixed(1)}x</b><span>buyer accel</span></div>
              <div><b>{(m.volumeQuality.score * 100).toFixed(0)}%</b><span>real volume</span></div>
              <div><b>{detail.holders?.holderCount ?? '–'}</b><span>holders</span></div>
              <div><b className={m.drawdownFromHigh > 0.4 ? 'warn' : ''}>{(m.drawdownFromHigh * 100).toFixed(0)}%</b><span>below 12h high</span></div>
            </div>
            <div style={{ padding: '6px 10px' }}><Sparkline points={detail.priceSeries} /></div>
            <div className="tabs">{(['market', 'wallets', 'social', 'risk'] as const).map((t) => <button key={t} className={tab === t ? 'on' : ''} onClick={() => setTab(t)}>{t}</button>)}</div>
            <div className="body">
              {tab === 'market' && (
                <div className="cols">
                  <div>
                    <table>
                      <thead><tr><th>window</th><th className="num">vol</th><th className="num">buys</th><th className="num">sells</th><th className="num">buyers</th><th className="num">sellers</th><th className="num">Δpx</th></tr></thead>
                      <tbody>{(['1m', '5m', '15m', '1h'] as const).map((iv) => { const s = m.intervals[iv]; return <tr key={iv}><td>{iv}</td><td className="num">{fmtUsd(s.volumeUsd)}</td><td className="num pos">{fmtUsd(s.buyVolumeUsd)}</td><td className="num neg">{fmtUsd(s.sellVolumeUsd)}</td><td className="num">{s.uniqueBuyers}</td><td className="num">{s.uniqueSellers}</td><td className={`num ${s.priceChangePct >= 0 ? 'pos' : 'neg'}`}>{fmtPct(s.priceChangePct)}</td></tr>; })}</tbody>
                    </table>
                    <div className="kv" style={{ marginTop: 8 }}>
                      <div>buy/sell imbalance</div><div className={m.buySellImbalance >= 0 ? 'pos' : 'neg'}>{m.buySellImbalance.toFixed(2)}</div>
                      <div>volatility regime</div><div>{m.volatilityRegime} ({(m.volatility * 100).toFixed(0)}%/h)</div>
                      <div>depth @1% / @5%</div><div>{fmtUsd(m.depthUsd.ask1pct)} / {fmtUsd(m.depthUsd.ask5pct)}</div>
                      <div>liq / mcap</div><div>{(m.liquidityToMcap * 100).toFixed(1)}%</div>
                      <div>wash ratio</div><div className={m.volumeQuality.suspectedWashRatio > 0.3 ? 'neg' : ''}>{(m.volumeQuality.suspectedWashRatio * 100).toFixed(0)}% · {m.volumeQuality.uniqueTraders} traders</div>
                      <div>distribution</div><div className={detail.distribution.level === 'HIGH' ? 'neg' : detail.distribution.level === 'MEDIUM' ? 'warn' : ''}>{detail.distribution.level} ({detail.distribution.score.toFixed(0)}) → {detail.distribution.action}</div>
                    </div>
                  </div>
                  <div>
                    <table>
                      <thead><tr><th>time</th><th>side</th><th className="num">usd</th><th>wallet</th></tr></thead>
                      <tbody>{detail.trades.slice(0, 25).map((t: any) => <tr key={t.id}><td className="muted">{fmtTime(t.timestamp)}</td><td className={t.side === 'buy' ? 'pos' : 'neg'}>{t.side}</td><td className="num">{fmtUsd(t.amountUsd)}</td><td className="muted">{short(t.wallet)}</td></tr>)}</tbody>
                    </table>
                  </div>
                </div>
              )}
              {tab === 'wallets' && (
                <div className="cols">
                  <div>
                    <h3 className="muted" style={{ margin: '4px 0' }}>Top traders in this token (30d risk-adjusted)</h3>
                    <table>
                      <thead><tr><th>wallet</th><th className="num">skill</th><th className="num">pnl</th><th className="num">wr</th><th className="num">R</th><th>archetype</th></tr></thead>
                      <tbody>{detail.topTraders.map((p: any) => <tr key={p.wallet}><td>{short(p.wallet)}</td><td className="num"><Bar v={p.riskAdjustedSkill} /> {p.riskAdjustedSkill.toFixed(0)}</td><td className={`num ${p.realizedPnlUsd >= 0 ? 'pos' : 'neg'}`}>{fmtUsd(p.realizedPnlUsd)}</td><td className="num">{(p.winRate * 100).toFixed(0)}%</td><td className="num">{p.averageR.toFixed(2)}</td><td>{p.archetype}</td></tr>)}</tbody>
                    </table>
                  </div>
                  <div>
                    <h3 className="muted" style={{ margin: '4px 0' }}>Wallet map</h3>
                    <div className="kv">
                      <div>smart-money flow 15m</div><div className={detail.smartMoney.smartNetFlowUsd >= 0 ? 'pos' : 'neg'}>{fmtUsd(detail.smartMoney.smartNetFlowUsd)}</div>
                      <div>independent smart wallets</div><div>{detail.smartMoney.independentSmartWallets}</div>
                      <div>mean skill of buyers</div><div>{detail.smartMoney.meanSkillOfBuyers.toFixed(0)}</div>
                      <div>top-trader consensus</div><div>{detail.consensus ? `${detail.consensus.traders.length} traders / ${detail.consensus.independentClusters} clusters → ${detail.consensus.consensusScore.toFixed(0)}` : 'none'}</div>
                      <div>top-10 holders</div><div>{detail.holders ? `${(detail.holders.top.slice(0, 10).reduce((a: number, x: any) => a + x.pct, 0) * 100).toFixed(0)}% · deployer ${(detail.holders.deployerPct * 100).toFixed(1)}%` : '–'}</div>
                    </div>
                    <h3 className="muted" style={{ margin: '10px 0 4px' }}>Clusters active here</h3>
                    {detail.clusters.length === 0 && <div className="muted">no multi-wallet clusters</div>}
                    {detail.clusters.map((c: any) => <div key={c.id} className="finding">{c.id} · {c.size} wallets · same-entity {(c.sameEntityScore * 100).toFixed(0)}%{c.fundingAncestor ? ` · funded by ${short(c.fundingAncestor)}` : ''}</div>)}
                  </div>
                </div>
              )}
              {tab === 'social' && (
                <div className="cols">
                  <div>
                    {detail.social ? (
                      <div className="kv">
                        <div>velocity score</div><div><Bar v={detail.social.velocityScore} /> {detail.social.velocityScore.toFixed(0)}</div>
                        <div>mention accel</div><div>{detail.social.mentionAcceleration.toFixed(1)}x</div>
                        <div>unique-author accel</div><div>{detail.social.uniqueAuthorAcceleration.toFixed(1)}x</div>
                        <div>engagement accel</div><div>{detail.social.engagementAcceleration.toFixed(1)}x</div>
                        <div>influencer diffusion</div><div>{(detail.social.influencerDiffusion * 100).toFixed(0)}%</div>
                        <div>cross-platform</div><div>{(detail.social.crossPlatformDiffusion * 100).toFixed(0)}%</div>
                        <div>bot likelihood</div><div className={detail.social.botLikelihood > 0.5 ? 'neg' : ''}>{(detail.social.botLikelihood * 100).toFixed(0)}%</div>
                        <div>new-account share</div><div>{(detail.social.newAccountShare * 100).toFixed(0)}%</div>
                        <div>saturation</div><div className={detail.social.saturation > 0.8 ? 'warn' : ''}>{(detail.social.saturation * 100).toFixed(0)}%</div>
                        <div>narrative</div><div>{detail.narrative ? `"${detail.narrative.label}" (${detail.narrative.momentum}${detail.narrative.catalyst ? `, ${detail.narrative.catalyst}` : ''})` : '–'}</div>
                      </div>
                    ) : <div className="muted">no social data (treated as unknown, not neutral)</div>}
                  </div>
                  <div>
                    {detail.social.slice(0, 15).map((p: any) => <div key={p.id} className="note"><span className="muted">{fmtTime(p.timestamp)} · {p.platform} · {p.authorFollowers.toLocaleString()} followers</span><br />{p.text.slice(0, 160)}</div>)}
                  </div>
                </div>
              )}
              {tab === 'risk' && (
                <div>
                  <div className="kv" style={{ marginBottom: 8 }}>
                    <div>security score</div><div><Bar v={detail.risk.securityScore} /> {detail.risk.securityScore.toFixed(0)}</div>
                    <div>manipulation score</div><div><Bar v={100 - detail.risk.manipulationScore} /> {detail.risk.manipulationScore.toFixed(0)}</div>
                    <div>rug probability</div><div className={detail.risk.rugProbability > 0.2 ? 'neg' : ''}>{(detail.risk.rugProbability * 100).toFixed(0)}%</div>
                    <div>hard block</div><div className={detail.risk.hardBlocked ? 'neg' : 'pos'}>{detail.risk.hardBlocked ? detail.risk.hardBlockReasons.join(', ') : 'no'}</div>
                  </div>
                  {detail.risk.findings.map((f: any, i: number) => <div key={i} className={`finding ${f.severity}`}>[{f.severity}] {f.family} · {f.code}: {f.message}{f.hardBlock ? ' (HARD BLOCK)' : ''}</div>)}
                </div>
              )}
            </div>
          </>
        )}
      </section>

      <section className="panel right">
        <h2>Intelligence</h2>
        <div className="body">
          {detail && (
            <>
              <pre className="card">{detail.cardText}</pre>
              <div style={{ marginTop: 8 }}>
                <div className="kv">
                  <div>suggested size</div><div>{fmtUsd(detail.card.suggestedSizeUsd)}</div>
                  <div>execution est.</div><div>{detail.card.scores.execution.toFixed(0)}/100 · round-trip {detail.card.expectedRoundTripCostPct.toFixed(1)}%</div>
                  <div>data confidence</div><div className={detail.card.freshness.confidence < 0.6 ? 'neg' : ''}>{(detail.card.freshness.confidence * 100).toFixed(0)}%</div>
                </div>
              </div>
              <h3 className="muted" style={{ margin: '10px 0 4px' }}>Similar historical tokens</h3>
              {detail.similar && detail.similar.sampleSize > 0 ? (
                <div className="kv">
                  <div>analogs</div><div>{detail.similar.sampleSize}</div>
                  <div>median fwd 24h</div><div className={detail.similar.medianForwardReturnPct >= 0 ? 'pos' : 'neg'}>{fmtPct(detail.similar.medianForwardReturnPct)}</div>
                  <div>p10 / p90</div><div>{fmtPct(detail.similar.p10ForwardReturnPct)} / {fmtPct(detail.similar.p90ForwardReturnPct)}</div>
                  <div>P(2x) / P(5x)</div><div>{(detail.similar.probability2x * 100).toFixed(0)}% / {(detail.similar.probability5x * 100).toFixed(0)}%</div>
                  <div>P(−50% dd)</div><div className="neg">{(detail.similar.probabilitySevereDrawdown * 100).toFixed(0)}%</div>
                  <div>rug rate</div><div className="neg">{(detail.similar.rugRate * 100).toFixed(0)}%</div>
                  <div>median time to 2x</div><div>{detail.similar.medianTimeToTargetMs ? fmtAge(detail.similar.medianTimeToTargetMs) : '–'}</div>
                </div>
              ) : <div className="muted">not enough labeled history yet ({snap.similarityCases} cases)</div>}
              <h3 className="muted" style={{ margin: '10px 0 4px' }}>AI explanation</h3>
              {detail.agentNotes.length === 0 && <div className="muted">agents run when a token is actionable or alerting</div>}
              {detail.agentNotes.map((n: any) => <div key={n.agent} className="note"><b>{n.agent}</b>{n.llm ? <span className="muted"> · llm</span> : ''}<br />{n.summary}</div>)}
            </>
          )}
        </div>
      </section>

      <section className="panel bottom">
        <h2>Live feed <span className="muted">{snap.alerts.length} alerts · {snap.outcomes} labeled outcomes · {snap.clusters} clusters</span></h2>
        <div className="body feed" style={{ columns: 2, columnGap: 24 }}>
          {snap.feed.map((f, i) => <div key={i} style={{ breakInside: 'avoid' }}><span className={`k ${f.kind.split(':')[0]}`}>{fmtTime(f.ts)} {f.kind}</span>{f.tokenMint ? <a onClick={() => setSel(f.tokenMint!)}>{f.text}</a> : f.text}</div>)}
        </div>
      </section>
    </div>
    </>
  );
}
