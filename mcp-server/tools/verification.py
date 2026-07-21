# NOTE: All heavy imports (pandas, numpy) are deferred to function bodies
# for fast MCP server startup (<2s). After the first call, Python's
# sys.modules cache makes repeated imports free.

from typing import Optional

from .config import resolve_path
from .dataframe_cache import load


def verify_claims(
    claims: list[dict],
    path: str,
) -> dict:
    """
    Verify AI-generated numeric claims against source data.

    Purely deterministic — loads the dataset and checks each claim
    against the actual data. Does NOT modify the source file.

    Args:
        claims: List of claim dicts, each with:
            - "value": float — the claimed numeric value
            - "column": str — column name in the dataset
            - "operation": "exact"|"mean"|"min"|"max"|"count"|"sum"|"median"|"std"
            - "rows": optional [start, end] — 0-indexed row range (inclusive)
            - "tolerance": optional float — relative tolerance, default 0.01 (1%)
        path: Path to the source data file

    Returns:
        dict with keys:
            - "verified": list of claims that matched within tolerance
            - "failed": list of claims that did not match (includes actual value)
            - "not_found": list of claims where column was missing or operation invalid
            - "source_file": the resolved path
            - "total_rows": number of rows in the dataset
    """
    import numpy as np

    resolved = resolve_path(path)
    df = load(resolved)

    verified = []
    failed = []
    not_found = []

    valid_operations = {"exact", "mean", "min", "max", "count", "sum", "median", "std"}

    for claim in claims:
        column = claim.get("column")
        operation = claim.get("operation", "exact")
        claimed_value = claim.get("value")
        row_range = claim.get("rows")
        tolerance = claim.get("tolerance", 0.01)

        # Validate inputs
        if column is None or claimed_value is None:
            not_found.append({
                **claim,
                "reason": "missing required field 'column' or 'value'",
            })
            continue

        if column not in df.columns:
            not_found.append({
                **claim,
                "reason": f"column '{column}' not found in dataset",
                "available_columns": list(df.columns[:20]),
            })
            continue

        if operation not in valid_operations:
            not_found.append({
                **claim,
                "reason": f"unknown operation '{operation}', must be one of {sorted(valid_operations)}",
            })
            continue

        # Select data slice
        series = df[column]
        if row_range and len(row_range) == 2:
            start, end = int(row_range[0]), int(row_range[1])
            if start < 0 or end >= len(df) or start > end:
                not_found.append({
                    **claim,
                    "reason": f"row range [{start}, {end}] out of bounds (dataset has {len(df)} rows)",
                })
                continue
            series = series.iloc[start:end + 1]

        # Compute actual value
        try:
            numeric_series = series.dropna()
            if operation == "count":
                actual = float(len(series))
            elif operation == "exact":
                # Check if the claimed value exists in the series
                if numeric_series.dtype == object:
                    # String column — exact match
                    if str(claimed_value) in numeric_series.values:
                        verified.append({**claim, "actual": claimed_value, "match": True})
                    else:
                        failed.append({**claim, "actual": None, "reason": "value not found in column"})
                    continue
                else:
                    numeric_series = numeric_series.astype(float)
                    # Check if any value is close
                    if len(numeric_series) == 0:
                        not_found.append({**claim, "reason": "no non-null values in range"})
                        continue
                    closest = numeric_series.iloc[(numeric_series - float(claimed_value)).abs().argmin()]
                    actual = float(closest)
            else:
                numeric_series = numeric_series.astype(float)
                if len(numeric_series) == 0:
                    not_found.append({**claim, "reason": "no non-null numeric values in range"})
                    continue
                actual = float(getattr(numeric_series, operation)())
        except (ValueError, TypeError) as e:
            not_found.append({
                **claim,
                "reason": f"computation error: {str(e)}",
            })
            continue

        # Compare within tolerance
        claimed_float = float(claimed_value)
        if claimed_float == 0 and actual == 0:
            match = True
        elif claimed_float == 0:
            match = abs(actual) < tolerance
        else:
            relative_error = abs(actual - claimed_float) / abs(claimed_float)
            match = relative_error <= tolerance

        result = {
            **claim,
            "actual": round(actual, 6),
            "match": match,
        }
        if not match:
            result["relative_error"] = round(
                abs(actual - claimed_float) / abs(claimed_float) if claimed_float != 0 else abs(actual),
                4,
            )
            failed.append(result)
        else:
            verified.append(result)

    return {
        "verified": verified,
        "failed": failed,
        "not_found": not_found,
        "source_file": resolved,
        "total_rows": len(df),
        "summary": f"{len(verified)} verified, {len(failed)} failed, {len(not_found)} not found",
    }
