"""CLI: python -m meme_research.cli signals.json outcomes.json
Reads the API's /api/signals export and prints a walk-forward policy comparison."""
from __future__ import annotations

import json
import sys

import pandas as pd

from .backtest import compare_policies


def load_joined(signals_path: str, outcomes_path: str) -> pd.DataFrame:
    with open(signals_path) as f:
        signals = json.load(f)
    with open(outcomes_path) as f:
        outcomes = json.load(f)
    s = pd.DataFrame([{"signal_id": x["id"], "ts": x["timestamp"], "decision": x["decision"], **x["scores"], **x["features"]} for x in signals])
    o = pd.DataFrame([{"signal_id": x["signalId"], "fwd_24h": x["forwardReturns"].get("24h"), "reached_2x": x["reached2x"], "rugged": x["rugged"]} for x in outcomes])
    j = s.merge(o, on="signal_id")
    j["fwd_24h"] = j["fwd_24h"].fillna(-1.0)
    j["liquidity_usd"] = j.get("liquidityUsd", 50_000)
    return j


if __name__ == "__main__":
    joined = load_joined(sys.argv[1], sys.argv[2])
    pd.set_option("display.width", 200)
    print(compare_policies(joined).round(2).to_string(index=False))
