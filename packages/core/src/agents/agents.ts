import type { Alert, DecisionCard, MarketFeatures, Narrative, RiskAssessment, SocialVelocity, TraderProfile, WalletCluster } from '../types.js';
import type { CohortAnalysis } from '../wallets/consensus.js';
import type { SimilarityResult } from '../similarity/knn.js';
import type { TradeResult } from '../backtest/metrics.js';
import { MS } from '../util/stats.js';

/**
 * LLM provider abstraction. The LLM is used for classification, clustering
 * assistance, explanations and research synthesis: never as the sole trading
 * signal (spec §14). Every agent has a deterministic fallback so the platform
 * degrades gracefully without a key.
 */
export interface LlmProvider {
  complete(system: string, user: string, maxTokens?: number): Promise<string>;
}

export interface AgentReport {
  agent: string;
  timestamp: number;
  summary: string;
  facts: Record<string, unknown>;
  /** true when an LLM refined the deterministic draft. */
  llm: boolean;
}

export abstract class BaseAgent {
  abstract readonly name: string;
  abstract readonly role: string;
  constructor(protected llm?: LlmProvider) {}
  protected async refine(draft: string, facts: Record<string, unknown>): Promise<{ text: string; llm: boolean }> {
    if (!this.llm) return { text: draft, llm: false };
    try {
      const text = await this.llm.complete(
        `You are the ${this.name} agent in a meme-coin market intelligence terminal. Role: ${this.role}. Rewrite the draft as a concise, evidence-bound analyst note. Never invent numbers; only use the JSON facts. Separate blockchain facts, statistical signals, social signals and interpretation. Never recommend sizing.`,
        `DRAFT:\n${draft}\n\nFACTS:\n${JSON.stringify(facts)}`,
        500,
      );
      return { text: text.trim() || draft, llm: true };
    } catch {
      return { text: draft, llm: false };
    }
  }
  protected report(summary: string, facts: Record<string, unknown>, llm: boolean, timestamp = Date.now()): AgentReport {
    return { agent: this.name, timestamp, summary, facts, llm };
  }
}

const pct = (x: number) => `${x.toFixed(0)}%`;
const usd = (x: number) => `$${Math.round(x).toLocaleString('en-US')}`;

export class MarketScoutAgent extends BaseAgent {
  name = 'Market Scout';
  role = 'find abnormal price/volume/liquidity activity';
  async analyze(m: MarketFeatures, symbol: string): Promise<AgentReport> {
    const abnormal: string[] = [];
    if (m.volumeAcceleration['5m'] >= 2) abnormal.push(`5m volume ${m.volumeAcceleration['5m'].toFixed(1)}x previous window`);
    if (m.buyerAcceleration >= 1.5) abnormal.push(`unique buyers ${m.buyerAcceleration.toFixed(1)}x`);
    if (Math.abs(m.intervals['15m'].priceChangePct) >= 20) abnormal.push(`price ${m.intervals['15m'].priceChangePct > 0 ? '+' : ''}${m.intervals['15m'].priceChangePct.toFixed(0)}% in 15m`);
    if (m.volumeQuality.score < 0.5) abnormal.push(`only ${pct(m.volumeQuality.score * 100)} of reported volume looks economic`);
    const draft = abnormal.length ? `$${symbol}: ${abnormal.join('; ')}. Liquidity ${usd(m.liquidityUsd)}, mcap ${usd(m.marketCapUsd)}, buy/sell imbalance ${m.buySellImbalance.toFixed(2)}.` : `$${symbol}: no abnormal activity. Liquidity ${usd(m.liquidityUsd)}.`;
    const r = await this.refine(draft, { volumeAcceleration: m.volumeAcceleration, buyerAcceleration: m.buyerAcceleration, volumeQuality: m.volumeQuality.score, liquidityUsd: m.liquidityUsd });
    return this.report(r.text, { abnormal }, r.llm, m.timestamp);
  }
}

export class WalletAnalystAgent extends BaseAgent {
  name = 'Wallet Analyst';
  role = 'explain relevant wallet and cluster behavior';
  async analyze(symbol: string, buyers: TraderProfile[], clusters: WalletCluster[], now: number): Promise<AgentReport> {
    const skilled = buyers.filter((b) => b.riskAdjustedSkill >= 60);
    const related = clusters.filter((c) => c.wallets.length > 1 && c.sameEntityScore > 0.5);
    const draft = `$${symbol}: ${buyers.length} tracked wallets active, ${skilled.length} with risk-adjusted skill ≥60 (archetypes: ${summarize(skilled.map((s) => s.archetype))}). ${related.length ? `${related.length} wallet cluster(s) look like a single entity (max same-entity ${pct(Math.max(...related.map((c) => c.sameEntityScore)) * 100)}), which discounts apparent consensus.` : 'No strong same-entity clusters detected.'}`;
    const r = await this.refine(draft, { buyers: buyers.length, skilled: skilled.length, relatedClusters: related.length });
    return this.report(r.text, { skilledWallets: skilled.map((s) => s.wallet), relatedClusters: related.map((c) => c.id) }, r.llm, now);
  }
}

export class TraderCohortAnalystAgent extends BaseAgent {
  name = 'Trader Cohort Analyst';
  role = 'study top 10/20 traders across 24H/7D/30D/longer windows';
  async analyze(analyses: CohortAnalysis[], repeated: Array<{ wallet: string; windows: string[] }>, now: number): Promise<AgentReport> {
    const lines = analyses.map((a) => {
      const top = a.commonTokens[0];
      return `${a.window}: ${a.size} traders in ${a.independentClusters} independent clusters; median entry mcap ${usd(a.commonEntryZone.medianMcapUsd)}, median hold ${(a.commonHoldTime.medianMs / MS.h).toFixed(1)}h${top ? `; strongest consensus $${top.symbol} (${top.traders.length} traders, score ${top.consensusScore.toFixed(0)})` : ''}`;
    });
    const draft = `${lines.join('. ')}. ${repeated.length} wallet(s) repeat across windows (repeatability > luck).`;
    const r = await this.refine(draft, { windows: analyses.map((a) => a.window), repeated: repeated.length });
    return this.report(r.text, { repeated }, r.llm, now);
  }
}

export class SocialAnalystAgent extends BaseAgent {
  name = 'Social Analyst';
  role = 'summarize X/Reddit/community activity';
  async analyze(symbol: string, v: SocialVelocity | null, now: number): Promise<AgentReport> {
    const draft = v
      ? `$${symbol}: mentions ${v.mentionAcceleration.toFixed(1)}x, unique authors ${v.uniqueAuthorAcceleration.toFixed(1)}x, engagement ${v.engagementAcceleration.toFixed(1)}x; influencer diffusion ${pct(v.influencerDiffusion * 100)}, cross-platform ${pct(v.crossPlatformDiffusion * 100)}; bot likelihood ${pct(v.botLikelihood * 100)}, new-account share ${pct(v.newAccountShare * 100)}; saturation ${pct(v.saturation * 100)}.`
      : `$${symbol}: no social data available (treated as unknown, not neutral).`;
    const r = await this.refine(draft, v ? { ...v, mentions: undefined, uniqueAuthors: undefined, engagement: undefined } : {});
    return this.report(r.text, { velocityScore: v?.velocityScore ?? null }, r.llm, now);
  }
}

export class NarrativeAnalystAgent extends BaseAgent {
  name = 'Narrative Analyst';
  role = 'detect and track emerging themes';
  async analyze(narratives: Narrative[], now: number): Promise<AgentReport> {
    const top = narratives.slice(0, 5);
    const draft = top.length
      ? top.map((n) => `"${n.label}" is ${n.momentum} (score ${n.momentumScore.toFixed(0)}, authenticity ${pct(n.authenticity * 100)}, ${n.tokenMints.length} token(s)${n.catalyst ? `, catalyst: ${n.catalyst}` : ''}; sentiment ${pct(n.sentiment.bullish * 100)} bullish / ${pct(n.sentiment.bearish * 100)} bearish)`).join('. ')
      : 'No narratives with enough posts to cluster.';
    const r = await this.refine(draft, { narratives: top.map((n) => ({ label: n.label, momentum: n.momentum, score: n.momentumScore })) });
    return this.report(r.text, { labels: top.map((n) => n.label) }, r.llm, now);
  }
}

export class SecurityAnalystAgent extends BaseAgent {
  name = 'Security Analyst';
  role = 'interpret token/deployer/holder risk';
  async analyze(symbol: string, risk: RiskAssessment): Promise<AgentReport> {
    const crit = risk.findings.filter((f) => f.severity === 'critical' || f.severity === 'high');
    const draft = `$${symbol}: security ${risk.securityScore.toFixed(0)}/100, manipulation ${risk.manipulationScore.toFixed(0)}/100, rug probability ${pct(risk.rugProbability * 100)}. ${risk.hardBlocked ? `HARD BLOCK: ${risk.hardBlockReasons.join(', ')}.` : ''} ${crit.length ? `Key findings: ${crit.map((f) => f.message).join('; ')}.` : 'No high/critical findings.'}`;
    const r = await this.refine(draft, { findings: risk.findings.map((f) => f.code), hardBlocked: risk.hardBlocked });
    return this.report(r.text, { hardBlocked: risk.hardBlocked, critical: crit.map((f) => f.code) }, r.llm, risk.timestamp);
  }
}

export class PatternMinerAgent extends BaseAgent {
  name = 'Pattern Miner';
  role = 'find recurring combinations among historical winners/losers';
  /** Mines feature buckets with the highest lift for reaching 2x vs. the base rate. */
  async analyze(cases: Array<{ features: Record<string, number>; won: boolean }>, now: number): Promise<AgentReport> {
    if (cases.length < 20) return this.report('Not enough labeled outcomes to mine patterns (need ≥20).', { cases: cases.length }, false, now);
    const base = cases.filter((c) => c.won).length / cases.length;
    const keys = Object.keys(cases[0].features);
    const patterns: Array<{ rule: string; lift: number; support: number }> = [];
    for (const k of keys) {
      const vals = cases.map((c) => c.features[k]).sort((a, b) => a - b);
      const q = [vals[Math.floor(vals.length * 0.33)], vals[Math.floor(vals.length * 0.66)]];
      const buckets: Array<[string, (v: number) => boolean]> = [[`${k} low`, (v) => v <= q[0]], [`${k} mid`, (v) => v > q[0] && v <= q[1]], [`${k} high`, (v) => v > q[1]]];
      for (const [rule, f] of buckets) {
        const sub = cases.filter((c) => f(c.features[k]));
        if (sub.length < 8) continue;
        const rate = sub.filter((c) => c.won).length / sub.length;
        patterns.push({ rule, lift: base > 0 ? rate / base : 0, support: sub.length });
      }
    }
    patterns.sort((a, b) => b.lift - a.lift);
    const top = patterns.slice(0, 5);
    const bottom = patterns.slice(-3);
    const draft = `Base 2x rate ${pct(base * 100)} over ${cases.length} cases. Highest lift: ${top.map((p) => `${p.rule} (${p.lift.toFixed(2)}x, n=${p.support})`).join(', ')}. Lowest: ${bottom.map((p) => `${p.rule} (${p.lift.toFixed(2)}x)`).join(', ')}.`;
    const r = await this.refine(draft, { base, top, bottom });
    return this.report(r.text, { patterns: top }, r.llm, now);
  }
}

export class TradeReviewerAgent extends BaseAgent {
  name = 'Trade Reviewer';
  role = 'post-mortem every completed trade';
  async analyze(trade: TradeResult, card: DecisionCard, now: number): Promise<AgentReport> {
    const s = card.scores;
    const verdict = trade.pnlPct > 0 ? 'winner' : 'loser';
    const attributions: string[] = [];
    if (trade.rugged) attributions.push(`token rugged despite security ${s.security.toFixed(0)} and rug probability ${pct(card.rugProbability * 100)}: security model under-estimated risk`);
    if (!trade.rugged && trade.pnlPct < 0 && s.momentum > 75) attributions.push('momentum was high but did not persist: check late-entry/saturation');
    if (trade.pnlPct > 0 && s.smartMoney > 70) attributions.push('smart-money participation was the leading signal');
    const slippage = Math.abs(trade.filledPriceUsd / trade.quotedPriceUsd - 1) * 100;
    if (slippage > 3) attributions.push(`execution slippage ${slippage.toFixed(1)}% materially reduced result`);
    const draft = `${trade.tokenMint.slice(0, 6)}… ${verdict}: ${trade.pnlPct >= 0 ? '+' : ''}${trade.pnlPct.toFixed(1)}% on ${usd(trade.sizeUsd)}. Decision was ${card.decision} with net EV ${s.netEvPct.toFixed(1)}%. ${attributions.join('; ') || 'Outcome consistent with the score profile.'}`;
    const r = await this.refine(draft, { pnlPct: trade.pnlPct, decision: card.decision, scores: s });
    return this.report(r.text, { attributions }, r.llm, now);
  }
}

export class ResearchAnalystAgent extends BaseAgent {
  name = 'Research Analyst';
  role = 'generate daily/weekly reports of what changed';
  async analyze(input: { alerts: Alert[]; narratives: Narrative[]; cohorts: CohortAnalysis[]; similar?: SimilarityResult | null; period: 'daily' | 'weekly' }, now: number): Promise<AgentReport> {
    const byKind = new Map<string, number>();
    for (const a of input.alerts) byKind.set(a.kind, (byKind.get(a.kind) ?? 0) + 1);
    const draft = `${input.period} report: ${input.alerts.length} alerts (${[...byKind].map(([k, n]) => `${k}: ${n}`).join(', ')}). Top narratives: ${input.narratives.slice(0, 3).map((n) => `"${n.label}" (${n.momentum})`).join(', ') || 'none'}. Cohort consensus leaders: ${input.cohorts.map((c) => c.commonTokens[0] ? `${c.window} $${c.commonTokens[0].symbol}` : `${c.window} none`).join(', ')}.`;
    const r = await this.refine(draft, { alerts: [...byKind], narratives: input.narratives.slice(0, 3).map((n) => n.label) });
    return this.report(r.text, { alertCounts: Object.fromEntries(byKind) }, r.llm, now);
  }
}

function summarize(xs: string[]): string {
  const m = new Map<string, number>();
  for (const x of xs) m.set(x, (m.get(x) ?? 0) + 1);
  return [...m].sort((a, b) => b[1] - a[1]).map(([k, n]) => `${k}×${n}`).join(', ') || 'none';
}

/** Anthropic Messages API provider (optional; only used when a key is configured). */
export class AnthropicProvider implements LlmProvider {
  constructor(private apiKey: string, private model = 'claude-sonnet-5', private fetchFn: typeof fetch = fetch) {}
  async complete(system: string, user: string, maxTokens = 500): Promise<string> {
    const res = await this.fetchFn('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-api-key': this.apiKey, 'anthropic-version': '2023-06-01' },
      body: JSON.stringify({ model: this.model, max_tokens: maxTokens, system, messages: [{ role: 'user', content: user }] }),
    });
    if (!res.ok) throw new Error(`anthropic ${res.status}`);
    const json = (await res.json()) as { content: Array<{ type: string; text?: string }> };
    return json.content.filter((c) => c.type === 'text').map((c) => c.text ?? '').join('');
  }
}
