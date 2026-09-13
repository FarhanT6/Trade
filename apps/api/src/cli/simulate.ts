import { MS, formatDecisionCard } from '@meme-intel/core';
import { loadConfig } from '../config.js';
import { createRuntime } from '../runtime.js';

const hours = Number(process.argv[2] ?? '30');
const cfg = loadConfig({ mode: 'simulation' });
const rt = createRuntime(cfg);
const t0 = rt.now();
console.log(`Simulating ${hours}h of market (seed ${cfg.simSeed}, ${cfg.simTokens} tokens, ${cfg.simWallets} wallets)…`);
while (rt.now() - t0 < hours * MS.h) await rt.tick();
const s = rt.engine.snapshot(rt.now());
console.log('\n=== WATCHLIST (top 10) ===');
for (const w of s.watchlist.slice(0, 10)) console.log(`${w.symbol.padEnd(10)} ${w.decision.padEnd(19)} alpha ${w.alpha.toFixed(0).padStart(3)}  netEV ${w.netEvPct.toFixed(1).padStart(6)}%  sec ${w.security.toFixed(0).padStart(3)}  rug ${(w.rugProbability * 100).toFixed(0).padStart(3)}%  liq $${Math.round(w.liquidityUsd).toLocaleString()}`);
const best = s.watchlist[0];
if (best) {
  const d = rt.engine.tokenDetail(best.tokenMint, rt.now());
  if (d) {
    console.log('\n=== DECISION CARD ===\n' + formatDecisionCard(d.card));
    console.log('\n=== AGENT NOTES ===');
    for (const n of d.agentNotes) console.log(`[${n.agent}] ${n.summary}`);
  }
}
console.log('\n=== TOP TRADERS (30d, risk-adjusted) ===');
for (const p of s.leaderboards['30d'].slice(0, 8)) console.log(`${p.wallet.slice(0, 8)}… skill ${p.riskAdjustedSkill.toFixed(0).padStart(3)}  pnl $${p.realizedPnlUsd.toFixed(0).padStart(7)}  wr ${(p.winRate * 100).toFixed(0)}%  pf ${p.profitFactor.toFixed(1)}  R ${p.averageR.toFixed(2)}  n ${p.sampleSize}  ${p.archetype}`);
console.log(`\nRepeat across windows: ${s.repeatedTraders.slice(0, 5).map((r) => `${r.wallet.slice(0, 6)}…(${r.windows.join('/')})`).join(', ') || 'none yet'}`);
console.log('\n=== TOP-TRADER CONSENSUS (30d) ===');
const c = s.cohorts.find((x) => x.window === '30d');
for (const ct of c?.commonTokens.slice(0, 5) ?? []) console.log(`$${ct.symbol.padEnd(9)} ${ct.traders.length} traders / ${ct.independentClusters} independent clusters -> consensus ${ct.consensusScore.toFixed(0)}  median entry mcap $${Math.round(ct.medianEntryMcapUsd).toLocaleString()}`);
console.log('\n=== NARRATIVES ===');
for (const n of s.narratives.slice(0, 5)) console.log(`"${n.label}" ${n.momentum} (${n.momentumScore.toFixed(0)}) auth ${(n.authenticity * 100).toFixed(0)}%${n.catalyst ? ` catalyst: ${n.catalyst}` : ''}`);
console.log('\n=== ALERTS (latest) ===');
for (const a of s.alerts.slice(0, 8)) console.log(`${a.kind.padEnd(22)} $${a.symbol.padEnd(9)} ${a.explanation}`);
console.log('\n=== PAPER PORTFOLIO ===');
console.log(`equity $${s.portfolio.equityUsd.toFixed(0)} cash $${s.portfolio.cashUsd.toFixed(0)} open ${s.portfolio.open} realized $${s.portfolio.realizedUsd.toFixed(0)} halted ${s.portfolio.halted}${s.portfolio.haltReason ? ` (${s.portfolio.haltReason})` : ''}`);
for (const t of s.closedTrades.slice(-8)) console.log(`  closed ${rt.engine.tokens.get(t.tokenMint)?.symbol ?? '?'} ${t.pnlPct >= 0 ? '+' : ''}${t.pnlPct.toFixed(1)}% on $${t.sizeUsd.toFixed(0)}${t.rugged ? ' (rug)' : ''}`);
console.log(`\noutcomes labeled: ${s.outcomes}, similarity cases: ${s.similarityCases}, wallet clusters: ${s.clusters}`);
