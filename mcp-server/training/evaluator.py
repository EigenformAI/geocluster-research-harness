"""
Hypothesis evaluation logic.

Evaluates structured hypotheses against actual results,
computing correctness and specificity scores.
"""

from __future__ import annotations

import re
import math
from dataclasses import dataclass, field
from typing import Any, Optional, Literal
from enum import Enum


class ClaimType(str, Enum):
    """Types of claims that can be evaluated."""
    CORRELATION = "correlation"
    DISTRIBUTION = "distribution"
    CLUSTER = "cluster"
    ANOMALY = "anomaly"
    COMPARISON = "comparison"
    EXISTENCE = "existence"
    COUNT = "count"
    TREND = "trend"
    GENERAL = "general"


@dataclass
class StructuredHypothesis:
    """
    A structured, testable hypothesis.
    
    The model is prompted to output hypotheses in this format
    to enable programmatic evaluation.
    """
    text: str  # Human-readable hypothesis text
    claim_type: ClaimType
    
    # Claim-specific fields (not all apply to every type)
    column_a: Optional[str] = None
    column_b: Optional[str] = None
    direction: Optional[Literal["positive", "negative", "none"]] = None
    magnitude_range: Optional[tuple[float, float]] = None
    value_range: Optional[tuple[float, float]] = None
    expected_count: Optional[int] = None
    count_range: Optional[tuple[int, int]] = None
    cluster_id: Optional[int] = None
    threshold: Optional[float] = None
    reasoning: Optional[str] = None
    
    # Evaluation results (filled after evaluation)
    is_correct: Optional[bool] = None
    actual_value: Optional[Any] = None
    specificity_score: int = 0
    
    def to_dict(self) -> dict:
        return {
            "text": self.text,
            "claim_type": self.claim_type.value,
            "column_a": self.column_a,
            "column_b": self.column_b,
            "direction": self.direction,
            "magnitude_range": list(self.magnitude_range) if self.magnitude_range else None,
            "value_range": list(self.value_range) if self.value_range else None,
            "expected_count": self.expected_count,
            "count_range": list(self.count_range) if self.count_range else None,
            "cluster_id": self.cluster_id,
            "threshold": self.threshold,
            "reasoning": self.reasoning,
            "is_correct": self.is_correct,
            "actual_value": self.actual_value,
            "specificity_score": self.specificity_score,
        }
    
    @classmethod
    def from_dict(cls, data: dict) -> "StructuredHypothesis":
        claim_type = ClaimType(data.get("claim_type", "general"))

        count_range = _coerce_range(data.get("count_range"))
        value_range = _coerce_range(data.get("value_range"))
        magnitude_range = _coerce_range(data.get("magnitude_range"))

        # Forgiving field mapping: training LLM frequently puts the constraint in
        # the wrong field for the claim_type (e.g. count claims with value_range).
        # Re-route obvious mismatches so the evaluator still has something to grade.
        if claim_type == ClaimType.COUNT and count_range is None and value_range is not None:
            # Only remap if the value_range looks count-like (whole numbers >= 1).
            # Fractional value_ranges (proportions like [0.6, 0.75]) belong elsewhere
            # and would collapse to (0, 0) under int() — worse than leaving unset.
            lo, hi = value_range
            if lo >= 1 and hi >= 1 and lo == int(lo) and hi == int(hi):
                count_range = (int(lo), int(hi))
        elif claim_type in (ClaimType.CORRELATION, ClaimType.TREND) and magnitude_range is None and value_range is not None:
            magnitude_range = value_range
        elif claim_type == ClaimType.DISTRIBUTION and value_range is None and magnitude_range is not None:
            value_range = magnitude_range

        h = cls(
            text=data.get("text", ""),
            claim_type=claim_type,
            column_a=data.get("column_a"),
            column_b=data.get("column_b"),
            direction=data.get("direction"),
            magnitude_range=magnitude_range,
            value_range=value_range,
            expected_count=data.get("expected_count"),
            count_range=count_range,
            cluster_id=data.get("cluster_id"),
            threshold=data.get("threshold"),
            reasoning=data.get("reasoning"),
        )
        # Preserve evaluation fields when reconstructing from an already-evaluated dict
        # (end_training_session rehydrates hypotheses from session.evaluation_results).
        # Without this, is_correct resets to None and session_to_samples drops every
        # sample on the floor — the bug that made correct/rejected JSONL files empty.
        if "is_correct" in data:
            h.is_correct = data["is_correct"]
        if "actual_value" in data:
            h.actual_value = data["actual_value"]
        if "specificity_score" in data:
            try:
                h.specificity_score = int(data["specificity_score"])
            except (TypeError, ValueError):
                pass
        return h


def _iter_results(tool_calls):
    """Yield (tool_name, result_dict) for each tool call.

    Accepts either ToolCall dataclass instances (have .tool / .result attrs) or
    plain dicts with 'tool' / 'result' keys (test-friendly).
    """
    for tc in tool_calls or []:
        if hasattr(tc, "tool"):
            yield getattr(tc, "tool", None) or "unknown", getattr(tc, "result", None) or {}
        elif isinstance(tc, dict):
            yield tc.get("tool", "unknown"), tc.get("result") or {}


def _find_scalar(tool_calls, names, prefer_tool=None):
    """Walk all tool results, return first scalar matching any key in `names`.

    `names` is a list of synonyms (e.g. ["row_count","total_rows","count"]).
    If `prefer_tool` is set, results from that tool are checked first.
    """
    pairs = list(_iter_results(tool_calls))
    if prefer_tool:
        pairs.sort(key=lambda p: 0 if p[0] == prefer_tool else 1)
    for _tool, result in pairs:
        if not isinstance(result, dict):
            continue
        for n in names:
            if n in result and isinstance(result[n], (int, float)) and not isinstance(result[n], bool):
                return result[n]
    return None


def _find_column_stat(tool_calls, column, stat):
    """Find result[<container>][column][stat] across all tool calls.

    Looks under common containers: describe, stats, profile, summary, columns,
    column_stats, profile_geochem (and bare top-level result[column][stat]).
    """
    if not column or not stat:
        return None
    containers = ("describe", "stats", "profile", "summary", "columns", "column_stats", "profile_geochem")
    for _tool, result in _iter_results(tool_calls):
        if not isinstance(result, dict):
            continue
        # bare result[column][stat]
        col = result.get(column)
        if isinstance(col, dict) and stat in col and isinstance(col[stat], (int, float)):
            return col[stat]
        # nested under a container
        for container in containers:
            blob = result.get(container)
            if isinstance(blob, dict):
                col2 = blob.get(column)
                if isinstance(col2, dict) and stat in col2 and isinstance(col2[stat], (int, float)):
                    return col2[stat]
    return None


def _find_cluster_count(tool_calls):
    """Return number of clusters (len of clusters dict) from any tool result."""
    for _tool, result in _iter_results(tool_calls):
        if isinstance(result, dict) and isinstance(result.get("clusters"), dict):
            return len(result["clusters"])
    return None


def _find_cluster_size(tool_calls, cluster_id):
    """Return size of a specific cluster, looking in clusters dict or value_counts."""
    if cluster_id is None:
        return None
    targets = (str(cluster_id), str(int(cluster_id)) if isinstance(cluster_id, (int, float)) else None,
               f"{int(cluster_id)}.0" if isinstance(cluster_id, (int, float)) else None)
    targets = tuple(t for t in targets if t)
    for _tool, result in _iter_results(tool_calls):
        if not isinstance(result, dict):
            continue
        clusters = result.get("clusters")
        if isinstance(clusters, dict):
            for t in targets:
                if t in clusters and isinstance(clusters[t], (int, float)):
                    return clusters[t]
        value_counts = result.get("value_counts")
        if isinstance(value_counts, dict):
            for col_vc in value_counts.values():
                if isinstance(col_vc, dict):
                    for t in targets:
                        if t in col_vc and isinstance(col_vc[t], (int, float)):
                            return col_vc[t]
    return None


def _sum_cluster_sizes(tool_calls):
    """Return total sample count across all clusters (sum of clusters dict values)."""
    for _tool, result in _iter_results(tool_calls):
        if isinstance(result, dict) and isinstance(result.get("clusters"), dict):
            values = [v for v in result["clusters"].values() if isinstance(v, (int, float))]
            if values:
                return sum(values)
    return None


def _find_largest_cluster_size(tool_calls):
    """Return the size of the largest cluster from any clusters dict."""
    for _tool, result in _iter_results(tool_calls):
        if isinstance(result, dict) and isinstance(result.get("clusters"), dict):
            values = [v for v in result["clusters"].values() if isinstance(v, (int, float))]
            if values:
                return max(values)
    return None


def _find_correlation(tool_calls, col_a, col_b):
    """Walk all tool results for a correlation between col_a and col_b."""
    if not (col_a and col_b):
        return None
    for _tool, result in _iter_results(tool_calls):
        if not isinstance(result, dict):
            continue
        # pairs format: [{col_a, col_b, r}, ...]
        for pair in result.get("pairs", []) or []:
            if not isinstance(pair, dict):
                continue
            a, b = pair.get("col_a"), pair.get("col_b")
            r = pair.get("r")
            if isinstance(r, (int, float)) and ((a == col_a and b == col_b) or (a == col_b and b == col_a)):
                return r
        # matrix format: {col_a: {col_b: r}}
        corr_matrix = result.get("correlations")
        if isinstance(corr_matrix, dict):
            row = corr_matrix.get(col_a)
            if isinstance(row, dict) and isinstance(row.get(col_b), (int, float)):
                return row[col_b]
    return None


def _sum_value_counts(tool_calls, column=None):
    """Sum value_counts[column].values() across tool calls. If column is None,
    sum the first value_counts dict found."""
    for _tool, result in _iter_results(tool_calls):
        if not isinstance(result, dict):
            continue
        vc = result.get("value_counts")
        if isinstance(vc, dict):
            if column and column in vc and isinstance(vc[column], dict):
                return sum(v for v in vc[column].values() if isinstance(v, (int, float)))
            if not column:
                # first value_counts col
                for col_vc in vc.values():
                    if isinstance(col_vc, dict):
                        return sum(v for v in col_vc.values() if isinstance(v, (int, float)))
    return None


def _coerce_range(v):
    """Accept None or a 2-element [low, high] of numbers; reject anything else.

    Training LLM has been observed emitting nested arrays for multi-cluster claims
    (e.g. count_range=[[7168,7168],[1683,1683]]). Those crash later unpacking like
    `low, high = h.count_range`. Returning None here drops the malformed constraint
    without losing the hypothesis text — it just becomes ungradable.
    """
    if v is None:
        return None
    if isinstance(v, (list, tuple)) and len(v) == 2 and all(isinstance(x, (int, float)) for x in v):
        return (v[0], v[1])
    return None


class HypothesisEvaluator:
    """
    Evaluates structured hypotheses against actual results.
    
    Computes:
    - Correctness: Does the hypothesis match the actual result?
    - Specificity score: How specific/testable was the hypothesis?
    """
    
    def __init__(self, tolerance: float = 0.1):
        """
        Args:
            tolerance: Relative tolerance for numeric comparisons (default 10%)
        """
        self.tolerance = tolerance
    
    def evaluate(
        self,
        hypothesis: StructuredHypothesis,
        tool_calls,
        source_data: Optional[Any] = None,
    ) -> StructuredHypothesis:
        """
        Evaluate a single hypothesis against the full session tool-call trace.

        Args:
            hypothesis: The structured hypothesis to evaluate
            tool_calls: list[ToolCall] (or list of {tool, result} dicts).
                        Walked by the helpers so any tool's result can be matched.
            source_data: Optional DataFrame for additional checks

        Returns:
            The hypothesis with is_correct, actual_value, and specificity_score filled
        """
        hypothesis.specificity_score = self._compute_specificity(hypothesis)

        evaluator = getattr(self, f"_evaluate_{hypothesis.claim_type.value}", None)
        if not evaluator:
            hypothesis.is_correct = None
            return hypothesis

        try:
            return evaluator(hypothesis, tool_calls, source_data)
        except Exception as exc:
            hypothesis.is_correct = None
            hypothesis.actual_value = f"evaluator_error: {type(exc).__name__}: {exc}"
            return hypothesis

    def evaluate_batch(
        self,
        hypotheses: list[StructuredHypothesis],
        tool_calls,
        source_data: Optional[Any] = None,
    ) -> list[StructuredHypothesis]:
        """Evaluate multiple hypotheses against the same tool-call trace."""
        return [self.evaluate(h, tool_calls, source_data) for h in hypotheses]
    
    def _compute_specificity(self, h: StructuredHypothesis) -> int:
        """
        Compute specificity score (0-5).
        
        Higher scores for more specific, testable claims.
        """
        score = 0
        
        # +1 for naming specific columns
        if h.column_a:
            score += 1
        if h.column_b:
            score += 1
        
        # +1 for providing numeric range
        if h.magnitude_range or h.value_range or h.count_range:
            score += 1
            # +1 bonus for narrow range
            if h.magnitude_range:
                width = abs(h.magnitude_range[1] - h.magnitude_range[0])
                if width < 0.3:  # Narrow range
                    score += 1
            if h.value_range:
                if h.value_range[0] != 0:  # Not starting from zero
                    width = abs(h.value_range[1] - h.value_range[0]) / abs(h.value_range[0])
                    if width < 0.5:  # Less than 50% relative width
                        score += 1
        
        # +1 for providing reasoning/mechanism
        if h.reasoning and len(h.reasoning) > 20:
            score += 1
        
        return min(score, 5)  # Cap at 5
    
    def _evaluate_correlation(self, h, tool_calls, source_data):
        """Evaluate correlation claims by walking all tool results."""
        actual_corr = _find_correlation(tool_calls, h.column_a, h.column_b)

        if actual_corr is None and source_data is not None and h.column_a and h.column_b:
            try:
                if h.column_a in source_data.columns and h.column_b in source_data.columns:
                    actual_corr = float(source_data[h.column_a].corr(source_data[h.column_b]))
            except Exception:
                pass

        if actual_corr is None:
            h.is_correct = None
            return h

        h.actual_value = round(float(actual_corr), 4)

        direction_correct = True
        if h.direction == "positive" and actual_corr <= 0:
            direction_correct = False
        elif h.direction == "negative" and actual_corr >= 0:
            direction_correct = False
        elif h.direction == "none" and abs(actual_corr) > 0.1:
            direction_correct = False

        magnitude_correct = True
        if h.magnitude_range:
            low, high = h.magnitude_range
            magnitude_correct = low <= actual_corr <= high

        h.is_correct = direction_correct and magnitude_correct
        return h

    def _evaluate_distribution(self, h, tool_calls, source_data):
        """Evaluate distribution claims (mean / median / scalar metrics)."""
        actual_value = None

        # 1. column-scoped stats (e.g., describe[col].mean, profile_geochem[col].mean)
        if h.column_a:
            for stat in ("mean", "median", "value", "score"):
                v = _find_column_stat(tool_calls, h.column_a, stat)
                if v is not None:
                    actual_value = v
                    break

        # 2. scalar metric named by column_a (e.g., column_a="silhouette", "explained_variance")
        if actual_value is None and h.column_a:
            v = _find_scalar(tool_calls, [h.column_a, h.column_a.lower(), f"{h.column_a}_score", f"{h.column_a}_mean"])
            if v is not None:
                actual_value = v

        # 3. fallback to source DataFrame
        if actual_value is None and source_data is not None and h.column_a:
            try:
                if h.column_a in source_data.columns:
                    actual_value = float(source_data[h.column_a].mean())
            except Exception:
                pass

        if actual_value is None:
            h.is_correct = None
            return h

        h.actual_value = round(float(actual_value), 4)

        if h.value_range:
            low, high = h.value_range
            h.is_correct = low <= actual_value <= high
        else:
            h.is_correct = None
        return h

    def _evaluate_cluster(self, h, tool_calls, source_data):
        """Evaluate clustering claims (count of clusters, or per-cluster size).

        AND-combines every populated constraint — a hypothesis with both
        count_range and value_range must satisfy both. value_range with
        max <= 1.0 is interpreted as a proportion of total samples; otherwise
        as an absolute count.
        """
        # Per-cluster size claim
        if h.cluster_id is not None:
            size = _find_cluster_size(tool_calls, h.cluster_id)
            if size is None:
                h.is_correct = False  # claimed cluster doesn't exist
                return h

            size_for_value = size
            if h.value_range is not None and max(h.value_range) <= 1.0:
                total = _sum_cluster_sizes(tool_calls)
                if total and total > 0:
                    size_for_value = size / total
                    h.actual_value = round(size_for_value, 4)
                else:
                    h.actual_value = size
            else:
                h.actual_value = size

            checks = []
            if h.value_range is not None:
                low, high = h.value_range
                checks.append(low <= size_for_value <= high)
            if h.count_range is not None:
                low, high = h.count_range
                checks.append(low <= size <= high)
            h.is_correct = all(checks) if checks else None
            return h

        # Total cluster count claim
        n_clusters = _find_cluster_count(tool_calls)
        if n_clusters is None:
            h.is_correct = None
            return h
        h.actual_value = n_clusters

        checks = []
        if h.count_range is not None:
            low, high = h.count_range
            checks.append(low <= n_clusters <= high)
        if h.expected_count is not None:
            checks.append(n_clusters == h.expected_count)
        # value_range on cluster-total path means largest-cluster proportion
        # (common shape: "k=3 AND largest 40-60%")
        if h.value_range is not None:
            largest = _find_largest_cluster_size(tool_calls)
            total = _sum_cluster_sizes(tool_calls)
            if largest is not None and total and total > 0:
                low, high = h.value_range
                if max(h.value_range) <= 1.0:
                    checks.append(low <= largest / total <= high)
                else:
                    checks.append(low <= largest <= high)
        h.is_correct = all(checks) if checks else None
        return h

    def _evaluate_anomaly(self, h, tool_calls, source_data):
        """Evaluate anomaly-count claims."""
        anomaly_count = _find_scalar(
            tool_calls,
            ["anomaly_count", "n_anomalies", "outlier_count", "n_outliers", "threshold_exceeded_count"],
        )
        if anomaly_count is None:
            # fallback: length of a list-shaped result
            for _tool, result in _iter_results(tool_calls):
                if isinstance(result, dict):
                    anomalies = result.get("anomalies") or result.get("outliers")
                    if isinstance(anomalies, list):
                        anomaly_count = len(anomalies)
                        break

        if anomaly_count is None:
            h.is_correct = None
            return h

        h.actual_value = anomaly_count

        if h.count_range:
            low, high = h.count_range
            h.is_correct = low <= anomaly_count <= high
        elif h.expected_count is not None:
            h.is_correct = abs(anomaly_count - h.expected_count) <= max(1, h.expected_count * 0.1)
        else:
            h.is_correct = None
        return h

    def _evaluate_comparison(self, h, tool_calls, source_data):
        """Comparison claims (A > B, ratio of A:B). Limited support."""
        if not (h.column_a and h.column_b):
            h.is_correct = None
            return h
        a = _find_column_stat(tool_calls, h.column_a, "mean")
        b = _find_column_stat(tool_calls, h.column_b, "mean")
        if a is None or b is None or b == 0:
            h.is_correct = None
            return h
        ratio = a / b
        h.actual_value = round(ratio, 4)
        if h.value_range:
            low, high = h.value_range
            h.is_correct = low <= ratio <= high
        else:
            h.is_correct = None
        return h

    def _evaluate_existence(self, h, tool_calls, source_data):
        """Existence claims: 'count of values above threshold is in [N,M]'."""
        if not (h.threshold is not None and h.column_a):
            h.is_correct = None
            return h

        # Prefer source_data exact count when available
        actual_count = None
        if source_data is not None:
            try:
                col = source_data[h.column_a]
                actual_count = int((col > h.threshold).sum())
            except Exception:
                pass

        # Fallback: any tool result already exposing a threshold-exceeded count
        if actual_count is None:
            actual_count = _find_scalar(tool_calls, ["threshold_exceeded_count", "above_threshold_count"])

        if actual_count is None:
            h.is_correct = None
            return h

        h.actual_value = actual_count

        if h.count_range:
            low, high = h.count_range
            h.is_correct = low <= actual_count <= high
        elif h.expected_count is not None:
            h.is_correct = actual_count == h.expected_count
        else:
            # Bare existence: at least one above threshold
            h.is_correct = actual_count > 0
        return h

    def _evaluate_count(self, h, tool_calls, source_data):
        """Count claims: total rows, value-counts sum, or matching-row count."""
        # 1. direct scalar lookup across all calls
        actual_count = _find_scalar(
            tool_calls,
            ["total_rows", "row_count", "n_rows", "count", "total", "n", "matching_rows"],
        )

        # 2. sum of value_counts (for category-distribution claims)
        if actual_count is None:
            actual_count = _sum_value_counts(tool_calls, h.column_a)

        # 3. cluster-size lookup if hypothesis names a specific cluster
        if actual_count is None and h.cluster_id is not None:
            actual_count = _find_cluster_size(tool_calls, h.cluster_id)

        if actual_count is None:
            h.is_correct = None
            return h

        h.actual_value = actual_count

        if h.count_range:
            low, high = h.count_range
            h.is_correct = low <= actual_count <= high
        elif h.expected_count is not None:
            h.is_correct = actual_count == h.expected_count
        else:
            h.is_correct = None
        return h

    def _evaluate_trend(self, h, tool_calls, source_data):
        """Trend claims need time-series or ordered data — currently unsupported."""
        h.is_correct = None
        return h

    def _evaluate_general(self, h, tool_calls, source_data):
        """Fallback for general claims — needs LLM-as-judge."""
        h.is_correct = None
        return h


def parse_hypothesis_response(response_text: str) -> list[StructuredHypothesis]:
    """
    Parse LLM response into structured hypotheses.
    
    Expects JSON array or numbered list format.
    """
    import json
    
    hypotheses = []
    
    # Try JSON parse first
    try:
        # Look for JSON array in response
        json_match = re.search(r'\[[\s\S]*\]', response_text)
        if json_match:
            data = json.loads(json_match.group())
            for item in data:
                if isinstance(item, dict):
                    hypotheses.append(StructuredHypothesis.from_dict(item))
            if hypotheses:
                return hypotheses
    except json.JSONDecodeError:
        pass
    
    # Fallback: parse numbered list
    lines = response_text.strip().split('\n')
    for line in lines:
        # Match "1. ...", "1) ...", "- ...", etc.
        match = re.match(r'^[\d\-\*\•]+[\.\)]\s*(.+)$', line.strip())
        if match:
            text = match.group(1).strip()
            if text:
                # Create a general hypothesis from text
                hypotheses.append(StructuredHypothesis(
                    text=text,
                    claim_type=ClaimType.GENERAL,
                ))
    
    return hypotheses
