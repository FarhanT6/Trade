"""Profitability metrics (spec §20). Input: a DataFrame of closed trades with columns
`pnl_pct`, `pnl_usd`, `size_usd`, `rugged`, `major_move`, `quoted_price`, `filled_price`, `exit_at`."""
from __future__ import annotations

import numpy as np
import pandas as pd


def _bootstrap_ci(x: np.ndarray, iters: int = 1000, seed: int = 7) -> tuple[float, float]:
    if len(x) == 0:
        return (0.0, 0.0)
    rng = np.random.default_rng(seed)
    means = rng.choice(x, size=(iters, len(x)), replace=True).mean(axis=1)
    return (float(np.quantile(means, 0.025)), float(np.quantile(means, 0.975)))


def max_drawdown_pct(equity: np.ndarray) -> float:
    if len(equity) == 0:
        return 0.0
    peak = np.maximum.accumulate(equity)
    with np.errstate(divide="ignore", invalid="ignore"):
        dd = np.where(peak > 0, (peak - equity) / peak, 0.0)
    return float(dd.max() * 100)


def profitability_metrics(trades: pd.DataFrame, start_equity: float, missed_moves: int = 0, periods_per_year: int = 365) -> dict:
    if trades.empty:
        return {"trades": 0, "net_ev_pct": 0.0, "profit_factor": 0.0, "win_rate": 0.0, "max_drawdown_pct": 0.0, "sharpe": 0.0, "sortino": 0.0, "calmar": 0.0, "median_trade_pct": 0.0, "tail_loss_pct": 0.0, "opportunity_capture": 0.0, "false_positive_rate": 0.0, "execution_slippage_pct": 0.0, "ev_ci": (0.0, 0.0)}
    t = trades.sort_values("exit_at") if "exit_at" in trades else trades
    rets = t["pnl_pct"].to_numpy(dtype=float)
    pnl = t["pnl_usd"].to_numpy(dtype=float)
    gp = pnl[pnl > 0].sum()
    gl = -pnl[pnl < 0].sum()
    equity = start_equity + np.cumsum(pnl)
    equity = np.concatenate([[start_equity], equity])
    dd = max_drawdown_pct(equity)
    r = rets / 100
    sd = r.std(ddof=1) if len(r) > 1 else 0.0
    downside = np.sqrt(np.mean(np.minimum(r, 0) ** 2))
    total = (equity[-1] - equity[0]) / equity[0]
    captured = int(t["major_move"].sum()) if "major_move" in t else 0
    slip = np.abs(t["filled_price"] / t["quoted_price"] - 1) * 100 if {"filled_price", "quoted_price"} <= set(t.columns) else pd.Series([0.0])
    rugged = t["rugged"] if "rugged" in t else pd.Series(False, index=t.index)
    return {
        "trades": int(len(t)),
        "net_ev_pct": float(rets.mean()),
        "net_pnl_usd": float(pnl.sum()),
        "profit_factor": float(gp / gl) if gl > 0 else float("inf") if gp > 0 else 0.0,
        "win_rate": float((pnl > 0).mean()),
        "max_drawdown_pct": dd,
        "sharpe": float(r.mean() / sd * np.sqrt(periods_per_year)) if sd > 0 else 0.0,
        "sortino": float(r.mean() / downside * np.sqrt(periods_per_year)) if downside > 0 else 0.0,
        "calmar": float(total * 100 / dd) if dd > 0 else 0.0,
        "median_trade_pct": float(np.median(rets)),
        "tail_loss_pct": float(np.quantile(rets, 0.05)),
        "opportunity_capture": captured / (captured + missed_moves) if captured + missed_moves > 0 else 0.0,
        "false_positive_rate": float(((rets <= -10) | rugged.to_numpy()).mean()),
        "execution_slippage_pct": float(np.mean(slip)),
        "ev_ci": _bootstrap_ci(rets),
    }


def signal_half_life(samples: pd.DataFrame) -> float | None:
    """`samples` has `delay_ms` and `mean_return_pct`; returns delay at which edge halves."""
    s = samples.sort_values("delay_ms")
    if s.empty or s.iloc[0]["mean_return_pct"] <= 0:
        return None
    half = s.iloc[0]["mean_return_pct"] / 2
    hit = s[s["mean_return_pct"] <= half]
    return float(hit.iloc[0]["delay_ms"]) if not hit.empty else None
