"""Market regime labeling for conditioning models (spec §18 "Regime change")."""
from __future__ import annotations

import numpy as np
import pandas as pd


def label_regimes(market: pd.DataFrame, breadth_col: str = "breadth", vol_col: str = "volume_vs_avg", majors_col: str = "majors_ret_24h") -> pd.Series:
    b = market[breadth_col]
    v = market[vol_col]
    m = market[majors_col] if majors_col in market else pd.Series(0.0, index=market.index)
    out = np.select(
        [(b > 0.65) & (v > 1.5), (b > 0.55) | (m > 0.03), (b < 0.35) | (m < -0.05)],
        ["meme-mania", "bull", "bear"],
        default="neutral",
    )
    return pd.Series(out, index=market.index, name="regime")
