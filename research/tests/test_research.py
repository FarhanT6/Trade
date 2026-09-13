import numpy as np
import pandas as pd

from meme_research import POLICIES, feature_lift, fit_net_ev_model, label_regimes, profitability_metrics, replay, signal_attribution, walk_forward_folds
from meme_research.attribution import survivorship_check
from meme_research.backtest import compare_policies
from meme_research.recalibrate import drift_report


def synthetic(n=300, seed=1):
    rng = np.random.default_rng(seed)
    ts = np.arange(n) * 3_600_000
    smart = rng.uniform(0, 100, n)
    momentum = rng.uniform(0, 100, n)
    edge = (smart - 50) / 100 + (momentum - 50) / 200
    fwd = np.clip(rng.normal(edge, 0.4), -0.95, 5)
    rugged = rng.random(n) < 0.05
    fwd = np.where(rugged, -0.97, fwd)
    decision = np.where((smart > 65) & (momentum > 55) & ~rugged, "ENTER", np.where(rugged, "HARD_BLOCK", "WATCH"))
    return pd.DataFrame({"signal_id": [f"s{i}" for i in range(n)], "ts": ts, "decision": decision, "momentum": momentum, "smartMoney": smart, "narrative": rng.uniform(0, 100, n), "liquidity": 70, "security": 90, "manipulation": 10, "execution": 90, "marketRegime": 60, "liquidity_usd": 50_000, "fwd_24h": fwd, "reached_2x": fwd >= 1, "rugged": rugged})


def test_metrics_basic():
    t = pd.DataFrame({"pnl_pct": [20, -12, 30, -5, -95, 15], "pnl_usd": [20, -12, 30, -5, -95, 15], "size_usd": 100, "rugged": [0, 0, 0, 0, 1, 0], "major_move": [1, 0, 1, 0, 0, 0], "quoted_price": 1.0, "filled_price": 1.01, "exit_at": range(6)})
    m = profitability_metrics(t, 1000, missed_moves=2)
    assert abs(m["profit_factor"] - 65 / 112) < 1e-9
    assert m["false_positive_rate"] == 2 / 6
    assert m["opportunity_capture"] == 0.5
    assert m["tail_loss_pct"] < -50
    assert m["ev_ci"][0] < m["net_ev_pct"] < m["ev_ci"][1]


def test_walk_forward_is_time_ordered():
    df = synthetic()
    folds = walk_forward_folds(df, 4)
    assert len(folds) == 4
    for train, test in folds:
        assert train["ts"].max() < test["ts"].min()
    assert sum(len(t) for _, t in folds) == 120


def test_system_beats_baselines_on_synthetic_edge():
    df = synthetic()
    res = {name: replay(df, pol, seed=3)["metrics"]["net_ev_pct"] for name, pol in POLICIES.items()}
    assert res["system"] > res["buy-and-hold"]
    assert res["system"] > res["random-entry"]
    table = compare_policies(df, folds=2)
    assert set(table["policy"]) == set(POLICIES)


def test_attribution_and_recalibration_recover_the_true_driver():
    df = synthetic(n=600)
    lift = feature_lift(df, ["smartMoney", "momentum", "narrative"])
    top = lift[lift["bucket"] == 2].set_index("feature")["lift"]
    assert top["smartMoney"] > top["narrative"]
    model = fit_net_ev_model(df)
    w = model.weights()
    assert w["smartMoney"] > w["narrative"]
    assert w["smartMoney"] > w["momentum"]
    attr = signal_attribution(df, ["smartMoney", "momentum", "narrative"])
    assert np.corrcoef(attr["predicted"], df["fwd_24h"])[0, 1] > 0.3
    drift = drift_report(df, df.assign(smartMoney=500), ["smartMoney", "momentum"])
    assert drift.set_index("feature").loc["smartMoney", "live_ood_share"] == 1.0


def test_regimes_and_survivorship():
    m = pd.DataFrame({"breadth": [0.8, 0.6, 0.2, 0.5], "volume_vs_avg": [2.0, 1.0, 1.0, 1.0], "majors_ret_24h": [0.05, 0.0, -0.1, 0.0]})
    assert list(label_regimes(m)) == ["meme-mania", "bull", "bear", "neutral"]
    assert survivorship_check(pd.DataFrame({"rugged": [False, True]}))["ok"]
    assert not survivorship_check(pd.DataFrame({"rugged": [False, False]}))["ok"]
