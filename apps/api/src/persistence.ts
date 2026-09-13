import type { Config } from './config.js';
import type { Runtime } from './runtime.js';

/**
 * Optional Postgres sink for the learning loop (signals, outcomes, alerts, orders,
 * execution events). Enabled only when DATABASE_URL is set; the in-memory engine is
 * the source of truth for the live process, Postgres is the durable research store.
 */
export async function attachPersistence(rt: Runtime, cfg: Config): Promise<void> {
  if (!cfg.databaseUrl) return;
  const { default: pg } = await import('pg');
  const pool = new pg.Pool({ connectionString: cfg.databaseUrl });
  await pool.query('select 1');
  const seen = { signals: 0, outcomes: 0, alerts: 0, orders: 0, audit: 0 };
  const { engine } = rt;
  rt.onSnapshot(async () => {
    try {
      const sigs = engine.signals.slice(seen.signals);
      for (const s of sigs) await pool.query('insert into signals(id, token_mint, ts, features, scores, decision, model_version) values ($1,$2,to_timestamp($3/1000.0),$4,$5,$6,$7) on conflict (id) do nothing', [s.id, s.tokenMint, s.timestamp, s.features, s.scores, s.decision, s.modelVersion]);
      seen.signals = engine.signals.length;
      const outs = engine.outcomes.slice(seen.outcomes);
      for (const o of outs) await pool.query('insert into outcomes(signal_id, token_mint, decision_at, forward_returns, max_forward_return, max_drawdown, reached_2x, reached_5x, rugged, time_to_target_ms, realized_pnl_pct) values ($1,$2,to_timestamp($3/1000.0),$4,$5,$6,$7,$8,$9,$10,$11) on conflict (signal_id) do nothing', [o.signalId, o.tokenMint, o.decisionAt, o.forwardReturns, o.maxForwardReturn, o.maxDrawdown, o.reached2x, o.reached5x, o.rugged, o.timeToTargetMs, o.realizedPnlPct]);
      seen.outcomes = engine.outcomes.length;
      const alerts = engine.alerts.slice(seen.alerts);
      for (const a of alerts) await pool.query('insert into alerts(id, kind, token_mint, ts, rank, severity, title, explanation, evidence) values ($1,$2,$3,to_timestamp($4/1000.0),$5,$6,$7,$8,$9) on conflict (id) do nothing', [a.id, a.kind, a.tokenMint, a.timestamp, a.rank, a.severity, a.title, a.explanation, a.evidence]);
      seen.alerts = engine.alerts.length;
      const orders = engine.orders.slice(seen.orders);
      for (const o of orders) await pool.query('insert into orders(id, token_mint, side, size_usd, status, mode, quote, filled_price_usd, filled_usd, slippage_pct, reject_reason, created_at) values ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,to_timestamp($12/1000.0)) on conflict (id) do update set status = excluded.status, filled_price_usd = excluded.filled_price_usd, filled_usd = excluded.filled_usd, slippage_pct = excluded.slippage_pct, reject_reason = excluded.reject_reason', [o.id, o.tokenMint, o.side, o.sizeUsd, o.status, o.mode, o.quote ?? null, o.filledPriceUsd ?? null, o.filledUsd ?? null, o.slippagePct ?? null, o.rejectReason ?? null, o.createdAt]);
      seen.orders = engine.orders.length;
      const audit = engine.audit.all().slice(seen.audit);
      for (const e of audit) await pool.query('insert into execution_events(id, order_id, kind, ts, detail) values ($1,$2,$3,to_timestamp($4/1000.0),$5) on conflict (id) do nothing', [e.id, e.orderId, e.kind, e.timestamp, e.detail]);
      seen.audit = engine.audit.all().length;
    } catch (e) {
      console.error('[persistence] write failed', (e as Error).message);
    }
  });
  console.log('[persistence] postgres sink attached');
}
