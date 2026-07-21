# NOTE: Heavy imports (pandas, rasterio, numpy) deferred to function bodies
# for fast MCP startup (<2s). See config.py header for rationale.

import math
import os
from typing import List

from .config import resolve_path, read_tabular
from . import dataframe_cache


def _safe_float(value, decimals: int = 4):
    """Convert a numeric value to a JSON-safe float. Returns None for NaN/Inf."""
    f = float(value)
    if math.isnan(f) or math.isinf(f):
        return None
    return round(f, decimals)


def _sanitize_for_json(obj):
    """Recursively replace NaN/Inf with None in nested dicts/lists for JSON safety."""
    if isinstance(obj, dict):
        return {k: _sanitize_for_json(v) for k, v in obj.items()}
    if isinstance(obj, list):
        return [_sanitize_for_json(v) for v in obj]
    if isinstance(obj, float) and (math.isnan(obj) or math.isinf(obj)):
        return None
    return obj


def _resolve_columns(requested: List[str], actual_columns) -> tuple[list[str], list[str]]:
    """Match requested column names case-insensitively. Returns (matched, not_found)."""
    lookup = {c.lower(): c for c in actual_columns}
    matched = []
    not_found = []
    for col in requested:
        real = lookup.get(col.lower())
        if real:
            matched.append(real)
        else:
            not_found.append(col)
    return matched, not_found


def list_files(directory: str = "."):
    """List files in a directory."""
    try:
        resolved = resolve_path(directory)
        if not os.path.isdir(resolved):
            return f"Error: '{directory}' is not a directory."

        files = os.listdir(resolved)
        count = len(files)
        # Limit the number of files returned to prevent context overflow
        if count > 500:
            return {
                "files": files[:500],
                "count": count,
                "warning": f"Output truncated. Showing 500 of {count} files.",
            }

        return {"files": files, "count": count}
    except Exception as e:
        return f"Error listing files: {str(e)}"


def inspect_dataset(path: str):
    """Load dataset into memory and return structural summary.
    The dataset remains cached for subsequent query_data calls."""
    try:
        import pandas as pd

        df = dataframe_cache.load(path)

        col_info = {}
        for col in df.columns:
            info = {"dtype": str(df[col].dtype), "nulls": int(df[col].isnull().sum())}
            if pd.api.types.is_numeric_dtype(df[col]):
                info["min"] = _safe_float(df[col].min())
                info["max"] = _safe_float(df[col].max())
                info["mean"] = _safe_float(df[col].mean())
            else:
                info["unique"] = int(df[col].nunique())
            col_info[col] = info

        return {
            "shape": {"rows": len(df), "columns": len(df.columns)},
            "columns": col_info,
            "status": "cached — use query_data for detailed analysis"
        }
    except Exception as e:
        return f"Error: {str(e)}"


def inspect_specific_columns(path: str, columns: List[str], get_stats: bool = False, get_unique_values: bool = False, get_value_counts: bool = False, max_unique: int = 30):
    """Column summary. get_stats for min/max, get_unique_values for value lists, get_value_counts for top values by frequency."""
    try:
        import pandas as pd

        if not columns:
            return "Error: Specify columns. Run inspect_dataset() first."

        df_full = dataframe_cache.load(path)
        resolved_cols, missing = _resolve_columns(columns, df_full.columns)
        if missing:
            return f"Error: Columns {missing} not found."

        df = df_full[resolved_cols]

        report = {"row_count": len(df)}

        for col in resolved_cols:
            col_info = {"unique": int(df[col].nunique()), "nulls": int(df[col].isnull().sum())}

            if pd.api.types.is_numeric_dtype(df[col]) and get_stats:
                col_info["min"] = _safe_float(df[col].min(), 2)
                col_info["max"] = _safe_float(df[col].max(), 2)

            if get_unique_values and not pd.api.types.is_numeric_dtype(df[col]):
                uniques = df[col].dropna().unique().tolist()
                col_info["total_unique"] = len(uniques)
                col_info["values"] = uniques[:max_unique]

            if get_value_counts and not pd.api.types.is_numeric_dtype(df[col]):
                counts = df[col].value_counts().head(max_unique)
                col_info["top_values"] = {str(k): int(v) for k, v in counts.items()}

            report[col] = col_info

        return report

    except Exception as e:
        return f"Error inspecting columns: {str(e)}"


def check_missing(path: str):
    """Report columns with missing values (skips complete columns)."""
    try:
        df = dataframe_cache.load(path)
        missing_pct = ((df.isnull().sum() / len(df)) * 100).round(1)
        has_missing = missing_pct[missing_pct > 0]
        if has_missing.empty:
            return {"status": "no_missing", "total_columns": len(df.columns)}
        return {"columns_with_missing": has_missing.to_dict(), "total_columns": len(df.columns)}
    except Exception as e:
        return f"Error: {str(e)}"


def inspect_raster(path: str, verbose: bool = False):
    """Inspect raster (GeoTIFF). Set verbose=true for bounds, transform, and band stats."""
    try:
        import rasterio
        import numpy as np

        resolved_path = resolve_path(path)
        with rasterio.open(resolved_path) as src:
            info = {
                "width": src.width,
                "height": src.height,
                "bands": src.count,
                "crs": str(src.crs),
            }
            if verbose:
                info["transform"] = [x for x in src.transform]
                info["nodata"] = src.nodata
                info["bounds"] = {
                    "left": src.bounds.left,
                    "bottom": src.bounds.bottom,
                    "right": src.bounds.right,
                    "top": src.bounds.top,
                }
                band1 = src.read(1)
                if src.nodata is not None:
                    data = band1[band1 != src.nodata]
                else:
                    data = band1
                info["statistics"] = {
                    "min": float(np.min(data)),
                    "max": float(np.max(data)),
                    "mean": round(float(np.mean(data)), 2),
                    "std": round(float(np.std(data)), 2),
                }
            return info
    except Exception as e:
        return f"Error reading raster: {str(e)}"


def profile_geochem(
    path: str,
    from_col: str,
    to_col: str,
    element_cols: List[str],
):
    """Depth-weighted stats for geochem columns. Returns weighted mean, max, and grade-thickness."""
    try:
        df = dataframe_cache.load(path)

        all_requested = [from_col, to_col] + element_cols
        resolved_cols, missing = _resolve_columns(all_requested, df.columns)
        if missing:
            return f"Error: Columns {missing} not found."

        # Map back to resolved names
        from_col = resolved_cols[0]
        to_col = resolved_cols[1]
        element_cols = resolved_cols[2:]

        df = df.dropna(subset=[from_col, to_col])
        thickness = df[to_col] - df[from_col]

        if (thickness <= 0).any():
            return "Error: Some intervals have zero or negative thickness. Check from/to columns."

        total_thickness = float(thickness.sum())
        report = {
            "total_intervals": len(df),
            "total_thickness_m": round(total_thickness, 2),
            "depth_range": [round(float(df[from_col].min()), 2), round(float(df[to_col].max()), 2)],
        }

        for col in element_cols:
            if col not in df.columns:
                continue
            vals = df[col]
            valid = vals.notna() & thickness.notna()
            v = vals[valid]
            t = thickness[valid]

            if t.sum() == 0:
                continue

            weighted_mean = float((v * t).sum() / t.sum())
            max_val = float(v.max())
            max_gt = float((v * t).max())

            report[col] = {
                "weighted_mean": round(weighted_mean, 4),
                "max": round(max_val, 4),
                "max_grade_thickness": round(max_gt, 4),
                "nulls": int(vals.isnull().sum()),
            }

        return report

    except Exception as e:
        return f"Error: {str(e)}"


def query_data(path: str, operation: str, columns: List[str] = None,
               n: int = 5, threshold: float = 0.7, expression: str = None):
    """Query a cached dataset. Call inspect_dataset first to load.

    Operations:
    - describe: Pandas describe() for specified columns (or all numeric)
    - correlations: Pairs with |r| > threshold
    - head: First n rows (default 5)
    - tail: Last n rows
    - value_counts: Top n values for specified categorical columns
    - sample: Random n rows
    - percentiles: Detailed percentiles for specified numeric columns
    - filter_summary: Count of rows matching expression, with column stats of filtered subset
    """
    try:
        import pandas as pd

        df = dataframe_cache.get(path)
        if df is None:
            df = dataframe_cache.load(path)

        if columns:
            resolved_cols, missing = _resolve_columns(columns, df.columns)
            if missing:
                return f"Error: Columns {missing} not found. Available: {list(df.columns)}"
        else:
            resolved_cols = None

        if operation == "describe":
            subset = df[resolved_cols] if resolved_cols else df.select_dtypes(include="number")
            desc = subset.describe()
            result = {}
            for col in desc.columns:
                result[col] = {k: _safe_float(v) for k, v in desc[col].items()}
            return {"describe": result}

        elif operation == "correlations":
            numeric = df[resolved_cols] if resolved_cols else df.select_dtypes(include="number")
            if numeric.shape[1] < 2:
                return "Error: Need at least 2 numeric columns for correlations."
            corr = numeric.corr()
            pairs = []
            for i in range(len(corr.columns)):
                for j in range(i + 1, len(corr.columns)):
                    r = _safe_float(corr.iloc[i, j])
                    if r is None:
                        continue
                    if abs(r) >= threshold:
                        pairs.append({
                            "col_a": corr.columns[i],
                            "col_b": corr.columns[j],
                            "r": r
                        })
            pairs.sort(key=lambda p: abs(p["r"]), reverse=True)
            return {"threshold": threshold, "pairs": pairs, "total_pairs": len(pairs)}

        elif operation == "head":
            n = min(n, 20)
            subset = df[resolved_cols].head(n) if resolved_cols else df.head(n)
            return {"rows": _sanitize_for_json(subset.to_dict(orient="records")), "count": len(subset)}

        elif operation == "tail":
            n = min(n, 20)
            subset = df[resolved_cols].tail(n) if resolved_cols else df.tail(n)
            return {"rows": _sanitize_for_json(subset.to_dict(orient="records")), "count": len(subset)}

        elif operation == "value_counts":
            if not resolved_cols:
                return "Error: Specify columns for value_counts."
            result = {}
            for col in resolved_cols:
                counts = df[col].value_counts().head(n)
                result[col] = {str(k): int(v) for k, v in counts.items()}
            return {"value_counts": result}

        elif operation == "sample":
            n = min(n, 20)
            n = min(n, len(df))
            subset = df[resolved_cols].sample(n) if resolved_cols else df.sample(n)
            return {"rows": _sanitize_for_json(subset.to_dict(orient="records")), "count": len(subset)}

        elif operation == "percentiles":
            subset = df[resolved_cols] if resolved_cols else df.select_dtypes(include="number")
            pcts = [0.01, 0.05, 0.10, 0.25, 0.50, 0.75, 0.90, 0.95, 0.99]
            result = {}
            for col in subset.columns:
                if pd.api.types.is_numeric_dtype(subset[col]):
                    quantiles = subset[col].quantile(pcts)
                    result[col] = {f"p{int(p*100)}": _safe_float(v) for p, v in quantiles.items()}
            return {"percentiles": result}

        elif operation == "filter_summary":
            if not expression:
                return "Error: Provide an expression for filter_summary (pandas query syntax)."
            filtered = df.query(expression)
            count = len(filtered)
            if count == 0:
                return {"expression": expression, "matching_rows": 0}
            numeric = filtered.select_dtypes(include="number")
            stats = {}
            for col in numeric.columns:
                stats[col] = {
                    "mean": _safe_float(numeric[col].mean()),
                    "min": _safe_float(numeric[col].min()),
                    "max": _safe_float(numeric[col].max()),
                }
            return {
                "expression": expression,
                "matching_rows": count,
                "total_rows": len(df),
                "numeric_stats": stats
            }

        else:
            return f"Error: Unknown operation '{operation}'. Use: describe, correlations, head, tail, value_counts, sample, percentiles, filter_summary."

    except Exception as e:
        return f"Error in query_data: {str(e)}"
