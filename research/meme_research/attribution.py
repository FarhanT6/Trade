"""Signal attribution: which features contributed to wins and losses (spec §24)."""
from __future__ import annotations

import numpy as np
import pandas as pd


def feature_lift(df: pd.DataFrame, features: list[str], target: str = "reached_2x", bins: int = 3, min_support: int = 10) -> pd.DataFrame:
    """Lift of the target rate inside each feature tercile vs. the base rate."""
    base = df[target].mean()
    rows = []
    for f in features:
        try:
            q = pd.qcut(df[f], bins, labels=False, duplicates="drop")
        except ValueError:
            continue
        for b, sub in df.groupby(q):
            if len(sub) < min_support:
                continue
            rate = sub[target].mean()
            rows.append({"feature": f, "bucket": int(b), "lo": float(sub[f].min()), "hi": float(sub[f].max()), "support": int(len(sub)), "rate": float(rate), "lift": float(rate / base) if base > 0 else 0.0})
    return pd.DataFrame(rows).sort_values("lift", ascending=False) if rows else pd.DataFrame(columns=["feature", "bucket", "lo", "hi", "support", "rate", "lift"])


def signal_attribution(df: pd.DataFrame, features: list[str], outcome: str = "fwd_24h") -> pd.DataFrame:
    """Linear attribution: standardized-feature regression of forward return; coefficient × feature z-score
    gives the per-signal contribution. Simple, interpretable, and fits on small samples."""
    X = df[features].to_numpy(dtype=float)
    mu, sd = X.mean(axis=0), X.std(axis=0) + 1e-9
    Z = (X - mu) / sd
    y = df[outcome].to_numpy(dtype=float)
    A = np.column_stack([np.ones(len(Z)), Z])
    coef, *_ = np.linalg.lstsq(A, y, rcond=None)
    contrib = Z * coef[1:]
    out = pd.DataFrame(contrib, columns=[f"attr_{f}" for f in features], index=df.index)
    out["predicted"] = A @ coef
    return out


def survivorship_check(tokens: pd.DataFrame) -> dict:
    """Guard against survivorship bias: the research set must retain dead/rugged tokens."""
    n = len(tokens)
    dead = int(tokens.get("rugged", pd.Series(False, index=tokens.index)).sum()) if n else 0
    return {"tokens": n, "rugged": dead, "rugged_share": dead / n if n else 0.0, "ok": n == 0 or dead > 0}
