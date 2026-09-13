"""Leakage-safe replay and walk-forward validation (spec §19).

A `signals` frame holds one row per decision with the features/scores *as they were at the
decision timestamp*; an `outcomes` frame holds forward returns computed strictly after it.
Replay joins them, applies a policy and a realistic execution model, and never lets a row
see anything later than its own timestamp."""
from __future__ import annotations

from dataclasses import dataclass
from typing import Callable

import numpy as np
import pandas as pd

from .metrics import profitability_metrics


@dataclass
class ExecutionModel:
    fee_pct: float = 0.6
    priority_fee_pct: float = 0.3
    base_failure: float = 0.03

    def cost(self, size_usd: np.ndarray, liquidity_usd: np.ndarray) -> tuple[np.ndarray, np.ndarray]:
        impact = size_usd / np.maximum(1.0, liquidity_usd / 2 + size_usd) * 100
        round_trip = 2 * impact + self.fee_pct + self.priority_fee_pct
        failure = np.minimum(0.5, self.base_failure + impact / 100)
        return round_trip, failure


Policy = Callable[[pd.DataFrame, np.random.Generator], pd.Series]

POLICIES: dict[str, Policy] = {
    "system": lambda df, rng: df["decision"].isin(["ENTER", "CONFIRMATION_ENTRY"]),
    "buy-and-hold": lambda df, rng: df["decision"] != "HARD_BLOCK",
    "momentum-only": lambda df, rng: (df["momentum"] >= 70) & (df["decision"] != "HARD_BLOCK"),
    "random-entry": lambda df, rng: (df["decision"] != "HARD_BLOCK") & (rng.random(len(df)) < 0.15),
}


def walk_forward_folds(df: pd.DataFrame, folds: int, train_fraction: float = 0.6, ts_col: str = "ts") -> list[tuple[pd.DataFrame, pd.DataFrame]]:
    s = df.sort_values(ts_col)
    if s.empty or folds <= 0:
        return []
    t0, t1 = s[ts_col].min(), s[ts_col].max()
    span = max(1, (t1 - t0))
    test_span = span * (1 - train_fraction) / folds
    out = []
    for f in range(folds):
        start = t0 + span * train_fraction + f * test_span
        end = t1 + 1 if f == folds - 1 else start + test_span
        train = s[s[ts_col] < start]
        test = s[(s[ts_col] >= start) & (s[ts_col] < end)]
        out.append((train, test))
    return out


def replay(joined: pd.DataFrame, policy: Policy, start_equity: float = 10_000.0, size_fraction: float = 0.02, exec_model: ExecutionModel | None = None, seed: int = 42, horizon_col: str = "fwd_24h") -> dict:
    """`joined` = signals ⨝ outcomes with columns: ts, decision, momentum, liquidity_usd, fwd_24h (fraction),
    reached_2x, rugged, quoted_price (optional). Returns metrics + trades frame."""
    exec_model = exec_model or ExecutionModel()
    rng = np.random.default_rng(seed)
    df = joined.sort_values("ts").reset_index(drop=True)
    take = policy(df, rng).to_numpy(dtype=bool)
    missed = int((~take & df["reached_2x"].to_numpy(dtype=bool)).sum())
    sel = df[take].copy()
    if sel.empty:
        return {"metrics": profitability_metrics(pd.DataFrame(), start_equity, missed), "trades": sel, "missed_moves": missed}
    size = np.full(len(sel), start_equity * size_fraction)
    rt_cost, fail_p = exec_model.cost(size, sel["liquidity_usd"].to_numpy(dtype=float))
    failed = rng.random(len(sel)) < fail_p
    gross = sel[horizon_col].to_numpy(dtype=float) * 100
    pnl_pct = np.where(failed, -0.3, np.where(sel["rugged"].to_numpy(dtype=bool), -95.0, gross - rt_cost))
    trades = pd.DataFrame({
        "signal_id": sel.get("signal_id", pd.Series(range(len(sel)), index=sel.index)),
        "exit_at": sel["ts"] + 24 * 3_600_000,
        "size_usd": size,
        "pnl_pct": pnl_pct,
        "pnl_usd": size * pnl_pct / 100,
        "rugged": sel["rugged"].to_numpy(dtype=bool),
        "major_move": sel["reached_2x"].to_numpy(dtype=bool),
        "quoted_price": 1.0,
        "filled_price": 1.0 + rt_cost / 200,
    })
    return {"metrics": profitability_metrics(trades, start_equity, missed), "trades": trades, "missed_moves": missed}


def compare_policies(joined: pd.DataFrame, folds: int = 3, **kw) -> pd.DataFrame:
    """Walk-forward comparison of every policy; one row per (fold, policy)."""
    rows = []
    for i, (_train, test) in enumerate(walk_forward_folds(joined, folds)):
        for name, pol in POLICIES.items():
            r = replay(test, pol, seed=100 + i, **kw)
            rows.append({"fold": i, "policy": name, "test_rows": len(test), **{k: v for k, v in r["metrics"].items() if k != "ev_ci"}, "ev_ci_lo": r["metrics"]["ev_ci"][0], "ev_ci_hi": r["metrics"]["ev_ci"][1]})
    return pd.DataFrame(rows)
