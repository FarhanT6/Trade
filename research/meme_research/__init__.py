"""Research layer: replay, walk-forward validation, metrics, attribution, recalibration."""
from .metrics import profitability_metrics
from .backtest import walk_forward_folds, replay, ExecutionModel, POLICIES
from .attribution import feature_lift, signal_attribution
from .recalibrate import fit_net_ev_model, NetEvModel
from .regime import label_regimes

__all__ = [
    "profitability_metrics", "walk_forward_folds", "replay", "ExecutionModel", "POLICIES",
    "feature_lift", "signal_attribution", "fit_net_ev_model", "NetEvModel", "label_regimes",
]
