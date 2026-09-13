"""Continuously recalibrated Net-EV model (spec §24). A ridge-regularized linear model on
interpretable scores; LightGBM/XGBoost can replace `fit` without changing the interface."""
from __future__ import annotations

from dataclasses import dataclass, field

import numpy as np
import pandas as pd

SCORE_COLS = ["momentum", "smartMoney", "narrative", "liquidity", "security", "manipulation", "execution", "marketRegime"]


@dataclass
class NetEvModel:
    coef: np.ndarray
    intercept: float
    mu: np.ndarray
    sd: np.ndarray
    cols: list[str] = field(default_factory=lambda: list(SCORE_COLS))
    version: str = "ridge-v1"

    def predict(self, df: pd.DataFrame) -> np.ndarray:
        Z = (df[self.cols].to_numpy(dtype=float) - self.mu) / self.sd
        return self.intercept + Z @ self.coef

    def weights(self) -> dict[str, float]:
        return {c: float(w) for c, w in zip(self.cols, self.coef)}


def fit_net_ev_model(df: pd.DataFrame, target: str = "fwd_24h", cols: list[str] | None = None, l2: float = 1.0) -> NetEvModel:
    cols = cols or list(SCORE_COLS)
    X = df[cols].to_numpy(dtype=float)
    mu, sd = X.mean(axis=0), X.std(axis=0) + 1e-9
    Z = (X - mu) / sd
    y = df[target].to_numpy(dtype=float) * 100
    n, k = Z.shape
    A = np.column_stack([np.ones(n), Z])
    reg = l2 * np.eye(k + 1)
    reg[0, 0] = 0
    beta = np.linalg.solve(A.T @ A + reg, A.T @ y)
    return NetEvModel(coef=beta[1:], intercept=float(beta[0]), mu=mu, sd=sd, cols=cols)


def drift_report(train: pd.DataFrame, live: pd.DataFrame, cols: list[str]) -> pd.DataFrame:
    """Model-drift monitor: share of live rows outside the train 1st–99th percentile band per feature."""
    rows = []
    for c in cols:
        lo, hi = train[c].quantile(0.01), train[c].quantile(0.99)
        ood = ((live[c] < lo) | (live[c] > hi)).mean() if len(live) else 0.0
        rows.append({"feature": c, "train_lo": float(lo), "train_hi": float(hi), "live_ood_share": float(ood)})
    return pd.DataFrame(rows)
