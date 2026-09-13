import { MS } from '@meme-intel/core';
import { loadConfig } from '../config.js';
import { createRuntime } from '../runtime.js';
import { runBacktest } from '../app.js';

const hours = Number(process.argv[2] ?? '60');
const cfg = loadConfig({ mode: 'simulation' });
const rt = createRuntime(cfg);
const t0 = rt.now();
console.log(`Replaying ${hours}h (seed ${cfg.simSeed})…`);
while (rt.now() - t0 < hours * MS.h) await rt.tick();
const bt = runBacktest(rt.engine, rt);
const row = (name: string, m: { trades: number; metrics: any }) => `${name.padEnd(14)} n ${String(m.trades).padStart(4)}  EV ${m.metrics.netExpectedValuePct.toFixed(1).padStart(6)}%  CI [${m.metrics.evConfidenceInterval.map((x: number) => x.toFixed(1)).join(', ')}]  PF ${Number.isFinite(m.metrics.profitFactor) ? m.metrics.profitFactor.toFixed(2) : '∞'}  WR ${(m.metrics.winRate * 100).toFixed(0)}%  maxDD ${m.metrics.maxDrawdownPct.toFixed(1)}%  median ${m.metrics.medianTradePct.toFixed(1)}%  tail ${m.metrics.tailLossPct.toFixed(1)}%  FP ${(m.metrics.falsePositiveRate * 100).toFixed(0)}%  capture ${(m.metrics.opportunityCapture * 100).toFixed(0)}%`;
console.log(`\nlabeled signals: ${bt.signals}\n\n=== OVERALL (system vs baselines, costs + failures modeled) ===`);
for (const r of bt.overall) console.log(row(r.policy, r));
console.log('\n=== WALK-FORWARD (out-of-sample folds) ===');
for (const f of bt.walkForward) {
  console.log(`fold ${f.fold}: train ${f.train} / test ${f.test}`);
  for (const r of f.results) console.log('  ' + row(r.policy, r));
}
