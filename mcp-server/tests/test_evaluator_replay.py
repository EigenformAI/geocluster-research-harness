"""Replay tests for the hypothesis evaluator.

Replays the two sessions captured during the 2026-04-21 IDE audit and asserts
that the C1 (2026-04-23) fix for _evaluate_cluster produces the expected
grades: conjunctive claims must satisfy every populated constraint, and
proportion-range claims (value_range max <= 1.0) are normalized against the
total cluster population before comparison.
"""

from __future__ import annotations

import json
import os
import sys
from pathlib import Path

import pytest

# Ensure the geocluster-mcp root is importable when running pytest from repo root
ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT))

from training.evaluator import HypothesisEvaluator, StructuredHypothesis  # noqa: E402


FIXTURES = Path(__file__).parent / "fixtures"


def _load_session(name: str):
    data = json.loads((FIXTURES / name).read_text())
    tool_calls = data["tool_calls"]
    hypotheses = [StructuredHypothesis.from_dict(h) for h in data["hypotheses"]]
    return tool_calls, hypotheses


def _find(hypotheses, text_fragment):
    for h in hypotheses:
        if text_fragment in h.text:
            return h
    raise AssertionError(f"no hypothesis containing {text_fragment!r}")


@pytest.fixture(scope="module")
def evaluator():
    return HypothesisEvaluator(tolerance=0.1)


# -----------------------------------------------------------------------------
# Session 2 (analytics, K-Means k=3): exercises Bug A + Bug B fixes
# -----------------------------------------------------------------------------


@pytest.fixture(scope="module")
def session2_graded(evaluator):
    tool_calls, hypotheses = _load_session("ts_1776762225_2069d8ee.json")
    return evaluator.evaluate_batch(hypotheses, tool_calls)


def test_bug_a_conjunctive_k3_and_largest_40_60_is_now_false(session2_graded):
    """The audit's false positive: 'k=3 AND largest 40-60%'.

    Before C1: is_correct=True (evaluator only checked count_range).
    After C1: is_correct=False (largest is 20639/29489 ~= 70%, outside [0.4, 0.6]).
    """
    h = _find(session2_graded, "K-Means clustering with k=3")
    assert h.is_correct is False, "conjunctive cluster claim must check value_range too"


def test_bug_b_smallest_cluster_actual_value_is_normalized(session2_graded):
    """Per-cluster claim with value_range as a proportion: actual_value is the fraction, not raw count."""
    h = _find(session2_graded, "smallest cluster")
    assert isinstance(h.actual_value, float)
    assert h.actual_value == pytest.approx(7138 / 29489, abs=1e-3)  # ~0.242
    assert h.is_correct is False  # 0.242 is outside [0.1, 0.2]


def test_bug_b_second_largest_cluster_actual_value_is_normalized(session2_graded):
    """Per-cluster claim (cluster_id=1): 1712 / 29489 ~= 0.058, outside [0.25, 0.4]."""
    h = _find(session2_graded, "second largest cluster")
    assert isinstance(h.actual_value, float)
    assert h.actual_value == pytest.approx(1712 / 29489, abs=1e-3)  # ~0.058
    assert h.is_correct is False


# -----------------------------------------------------------------------------
# Session 1 (dataops, inspect/validate): regression guards — must not change
# -----------------------------------------------------------------------------


@pytest.fixture(scope="module")
def session1_graded(evaluator):
    tool_calls, hypotheses = _load_session("ts_1776762164_f8b7d4a6.json")
    return evaluator.evaluate_batch(hypotheses, tool_calls)


def test_regression_row_count_hypothesis_unchanged(session1_graded):
    """Non-cluster count claim — C1 must not affect it."""
    h = _find(session1_graded, "between 500 and 10,000 rows")
    assert h.is_correct is False
    assert h.actual_value == 29489


def test_regression_column_count_hypothesis_unchanged(session1_graded):
    """Known-noisy count claim (C2 territory) — must still grade False with actual_value=29489.

    This row has the garbage `actual_value: 29489` that C2 (not yet shipped)
    would fix. We assert no regression: C1 must leave it alone.
    """
    h = _find(session1_graded, "5 and 20 numeric columns")
    assert h.is_correct is False
    assert h.actual_value == 29489


# -----------------------------------------------------------------------------
# Unit-level safety: proportion normalization only triggers when max <= 1.0
# -----------------------------------------------------------------------------


def test_absolute_count_value_range_not_normalized(evaluator):
    """A cluster hypothesis with value_range like [7000, 20000] (absolute count) must
    NOT be divided by total — must compare raw size against raw range.
    """
    from training.evaluator import ClaimType

    tool_calls = [
        {"tool": "cluster", "result": {"clusters": {"0.0": 7138, "1.0": 1712, "2.0": 20639}}}
    ]
    h = StructuredHypothesis(
        text="Cluster 0 has 5000-10000 samples",
        claim_type=ClaimType.CLUSTER,
        cluster_id=0,
        value_range=(5000.0, 10000.0),
    )
    evaluator.evaluate(h, tool_calls)
    assert h.actual_value == 7138  # raw, not normalized
    assert h.is_correct is True
