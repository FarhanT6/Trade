import type { Alert, AlertKind, AuthorityChange, DecisionCard, LiquidityEvent, MarketFeatures, RiskAssessment, RiskSeverity, SocialVelocity, Token } from '../types.js';
import type { CommonToken } from '../wallets/consensus.js';
import type { DistributionReport } from '../exits/distribution.js';
import { detectContradiction } from '../social/narrative.js';
import { newId } from '../util/ids.js';
import { clamp } from '../util/stats.js';

export interface AlertContext {
  token: Token;
  now: number;
  market: MarketFeatures;
  prevMarket: MarketFeatures | null;
  risk: RiskAssessment;
  prevRisk: RiskAssessment | null;
  card: DecisionCard;
  social: SocialVelocity | null;
  consensus: CommonToken | null;
  distribution: DistributionReport | null;
  smartNetFlowUsd: number;
  /** Count of independent high-skill wallets accumulating in last 15m. */
  smartBuyers: number;
  liquidityEvents: LiquidityEvent[];
  authorityChanges: AuthorityChange[];
  executionOk: boolean;
  dataConfidence: number;
  /** Feature drift indicator 0..1 (share of features outside training distribution). */
  oodShare: number;
}

function mk(kind: AlertKind, ctx: AlertContext, severity: RiskSeverity, title: string, explanation: string, evidence: Alert['evidence'], rank: number): Alert {
  return { id: newId('alr'), kind, tokenMint: ctx.token.mint, symbol: ctx.token.symbol, timestamp: ctx.now, rank: clamp(rank, 0, 100), severity, title, explanation, evidence };
}

/** Event-driven, ranked, explainable alerts (spec §21). */
export function evaluateAlerts(ctx: AlertContext): Alert[] {
  const out: Alert[] = [];
  const m = ctx.market;
  const s = ctx.card.scores;

  if (s.momentum >= 70 && m.buyerAcceleration >= 1.5 && m.volumeAcceleration['5m'] >= 2 && m.intervals['5m'].trades >= 8 && m.intervals['5m'].uniqueBuyers >= 5 && !ctx.risk.hardBlocked && s.security >= 50)
    out.push(mk('early-momentum', ctx, 'info', 'Early momentum', `5m volume ${m.volumeAcceleration['5m'].toFixed(1)}x and buyers ${m.buyerAcceleration.toFixed(1)}x with security ${s.security.toFixed(0)}`, { volumeAccel5m: m.volumeAcceleration['5m'], buyerAccel: m.buyerAcceleration, volumeQuality: m.volumeQuality.score }, s.alpha));

  if (ctx.smartBuyers >= 3 && ctx.smartNetFlowUsd > 0.01 * m.liquidityUsd)
    out.push(mk('smart-money', ctx, 'info', 'Smart money accumulating', `${ctx.smartBuyers} independent high-skill wallets net-bought $${ctx.smartNetFlowUsd.toFixed(0)} in 15m`, { smartBuyers: ctx.smartBuyers, smartNetFlowUsd: ctx.smartNetFlowUsd }, s.smartMoney));

  if (ctx.consensus && ctx.consensus.independentClusters >= 3 && ctx.consensus.consensusScore >= 60)
    out.push(mk('top-trader-consensus', ctx, 'info', 'Top-trader consensus', `${ctx.consensus.traders.length} top traders across ${ctx.consensus.independentClusters} independent clusters hold ${ctx.token.symbol} (consensus ${ctx.consensus.consensusScore.toFixed(0)})`, { traders: ctx.consensus.traders.length, independentClusters: ctx.consensus.independentClusters, consensusScore: ctx.consensus.consensusScore }, ctx.consensus.consensusScore));

  if (ctx.social && ctx.social.velocityScore >= 70 && ctx.social.mentionAcceleration >= 2 && ctx.social.uniqueAuthorAcceleration >= 1.5)
    out.push(mk('narrative-breakout', ctx, 'info', 'Narrative breakout', `Mentions ${ctx.social.mentionAcceleration.toFixed(1)}x, unique authors ${ctx.social.uniqueAuthorAcceleration.toFixed(1)}x, bot likelihood ${(ctx.social.botLikelihood * 100).toFixed(0)}%`, { mentionAccel: ctx.social.mentionAcceleration, authorAccel: ctx.social.uniqueAuthorAcceleration, botLikelihood: ctx.social.botLikelihood }, ctx.social.velocityScore));

  if (ctx.social) {
    const c = detectContradiction(ctx.social.velocityScore, ctx.social.mentionAcceleration, m.buyerAcceleration, m.volumeQuality.score);
    if (c.contradiction) out.push(mk('narrative-divergence', ctx, 'medium', 'Narrative divergence', 'Social attention rising while on-chain demand falls', { severity: c.severity, buyerAccel: m.buyerAcceleration, volumeQuality: m.volumeQuality.score }, 40 + 60 * c.severity));
  }

  if (ctx.smartNetFlowUsd < -0.02 * m.liquidityUsd)
    out.push(mk('whale-exit', ctx, 'high', 'Smart wallets exiting', `High-quality wallets net-sold $${(-ctx.smartNetFlowUsd).toFixed(0)} in 15m`, { smartNetFlowUsd: ctx.smartNetFlowUsd }, 60 + clamp((-ctx.smartNetFlowUsd / m.liquidityUsd) * 400, 0, 40)));

  if (ctx.distribution && ctx.distribution.level === 'HIGH')
    out.push(mk('distribution', ctx, 'high', 'Distribution', `Price rising while demand deteriorates (score ${ctx.distribution.score.toFixed(0)})`, { score: ctx.distribution.score, ...Object.fromEntries(Object.entries(ctx.distribution.signals)) }, ctx.distribution.score));

  const removed = ctx.liquidityEvents.filter((e) => e.kind === 'remove' && ctx.now - e.timestamp < 15 * 60_000).reduce((a, e) => a + e.amountUsd, 0);
  if (removed > 0.15 * (m.liquidityUsd + removed))
    out.push(mk('liquidity-shock', ctx, 'critical', 'Liquidity shock', `$${removed.toFixed(0)} removed in 15m (${((removed / (m.liquidityUsd + removed)) * 100).toFixed(0)}% of pool)`, { removedUsd: removed, liquidityUsd: m.liquidityUsd }, 95));

  const recentAuth = ctx.authorityChanges.filter((a) => ctx.now - a.timestamp < 15 * 60_000);
  const newHard = ctx.risk.hardBlockReasons.filter((r) => !(ctx.prevRisk?.hardBlockReasons ?? []).includes(r));
  if (recentAuth.length || newHard.length)
    out.push(mk('security-change', ctx, 'critical', 'Security state changed', [...recentAuth.map((a) => `${a.kind} authority ${a.previous ? 'changed' : 'set'}`), ...newHard.map((h) => `new hard-block ${h}`)].join('; '), { authorityChanges: recentAuth.length, newHardBlocks: newHard.length }, 90));

  if (!ctx.executionOk || s.execution < 40)
    out.push(mk('execution-risk', ctx, 'high', 'Execution risk', `Execution quality ${s.execution.toFixed(0)}: slippage, route, latency or failure risk unacceptable`, { executionScore: s.execution, executionOk: ctx.executionOk }, 70));

  if (ctx.dataConfidence < 0.6 || ctx.oodShare > 0.3)
    out.push(mk('model-confidence-drop', ctx, 'medium', 'Model confidence drop', ctx.dataConfidence < 0.6 ? `Data confidence ${(ctx.dataConfidence * 100).toFixed(0)}%: inputs stale or conflicting` : `${(ctx.oodShare * 100).toFixed(0)}% of features outside training distribution`, { dataConfidence: ctx.dataConfidence, oodShare: ctx.oodShare }, 65));

  return out.sort((a, b) => b.rank - a.rank);
}
