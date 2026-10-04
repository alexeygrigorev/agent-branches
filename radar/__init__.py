"""L3 Advisory Radar Engine Package.

Provides in-memory pairwise trial-merge and budgeted combined-tree test runner.
"""

from .engine import (
    AgentHead,
    MatrixResult,
    PairResult,
    RadarEngine,
    create_warning,
    evaluate_pair,
    run_matrix,
)

__all__ = [
    "AgentHead",
    "PairResult",
    "MatrixResult",
    "RadarEngine",
    "create_warning",
    "evaluate_pair",
    "run_matrix",
]
