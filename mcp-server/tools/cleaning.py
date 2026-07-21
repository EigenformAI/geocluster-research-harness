# NOTE: All heavy imports (pandas, numpy, re) are deferred to function bodies
# for fast MCP server startup (<2s). After the first call, Python's
# sys.modules cache makes repeated imports free.

from typing import Optional

from .config import resolve_path, read_tabular, save_csv
from .dataframe_cache import load, drop

# ── Column classification patterns (extracted from backend) ──────────
# Source: geocluster-ai-BE/app/services/dataset_validator.py (lines 33-65)
# Source: geocluster-ai-BE/app/services/format_converter.py (lines 25-116)

HOLE_ID_PATTERNS = [
    r"^hole_?id$",
    r"^drill_?hole",
    r"^borehole",
    r"^hole$",
    r"^well",
    r"^site_?id$",
    r"hole.*number",
    r"^sample.*id$",
    r"^collar.*id$",
    r"^filename$",
    r"^sample$",
]

LAT_PATTERNS = [
    r"^lat(itude)?(_.*)?$",
    r"^lat_?y$",
    r"^northing(_.*)?$",
    r"^coord_?y$",
    r"^y$",
    r"latitude.*gda",
    r"northing.*gda",
]

LON_PATTERNS = [
    r"^lon(g(itude)?)?(_.*)?$",
    r"^lon_?x$",
    r"^easting(_.*)?$",
    r"^coord_?x$",
    r"^x$",
    r"longitude.*gda",
    r"easting.*gda",
]

METADATA_PATTERNS = [
    r"^hole_?id$",
    r"^drill_?hole",
    r"^sample",
    r"^filename",
    r"^well",
    r"^lat(itude)?",
    r"^lon(gitude)?",
    r"^northing",
    r"^easting",
    r"^x$",
    r"^y$",
    r"^depth",
    r"^from",
    r"^to",
    r"^interval",
    r"^zone",
    r"^lithology",
    r"^rock_type",
    r"^description",
    r"^date",
    r"^timestamp",
    r"^project",
    r"^area",
    r"^site",
]

GEOCHEM_PATTERNS = [
    # Major oxides
    r"^SiO2$", r"^Al2O3$", r"^Fe2O3$", r"^FeO$", r"^MgO$", r"^CaO$",
    r"^Na2O$", r"^K2O$", r"^TiO2$", r"^P2O5$", r"^MnO$", r"^Cr2O3$",
    # Trace elements
    r"^Cu$", r"^Pb$", r"^Zn$", r"^Au$", r"^Ag$", r"^Ni$", r"^Co$",
    r"^As$", r"^Sb$", r"^Bi$", r"^Mo$", r"^W$", r"^Sn$", r"^U$",
    r"^Th$", r"^Ba$", r"^Sr$", r"^Rb$", r"^Cs$", r"^Li$", r"^Be$",
    # REE
    r"^La$", r"^Ce$", r"^Pr$", r"^Nd$", r"^Sm$", r"^Eu$", r"^Gd$",
    r"^Tb$", r"^Dy$", r"^Ho$", r"^Er$", r"^Tm$", r"^Yb$", r"^Lu$",
    r"^Y$", r"^Sc$",
    # Other
    r"^S$", r"^C$", r"^LOI$", r"^Total$",
    # With unit suffixes
    r"^[A-Z][a-z]?_ppm$",
    r"^[A-Z][a-z]?_pct$",
    r"^[A-Z][a-z]?_ppb$",
    r"^[A-Z][a-z]?%$",
]

# Detection limit pattern and special values
# Source: geocluster-ai-BE/app/services/format_converter.py (lines 156-196)
DL_PATTERN = r"^([<>≤≥]|<=|>=)\s*([\d.]+)$"

SPECIAL_DL_VALUES = {
    "nd": None,     # Not Detected — no numeric value can be inferred
    "bdl": None,    # Below Detection Limit — same
    "na": None,     # Not Available
    "trace": None,  # Trace amount — ambiguous, cannot assign a value safely
    "nil": None,    # Nil
    "-": None,      # Dash — missing
}


# ── Helpers ──────────────────────────────────────────────────────────

def _classify_column(col_name: str) -> str:
    """Classify a column as 'hole_id', 'lat', 'lon', 'geochem', 'metadata', or 'unknown'."""
    import re
    lower = col_name.lower()
    for pat in HOLE_ID_PATTERNS:
        if re.match(pat, lower):
            return "hole_id"
    for pat in LAT_PATTERNS:
        if re.match(pat, lower):
            return "lat"
    for pat in LON_PATTERNS:
        if re.match(pat, lower):
            return "lon"
    for pat in GEOCHEM_PATTERNS:
        if re.match(pat, col_name, re.IGNORECASE):
            return "geochem"
    for pat in METADATA_PATTERNS:
        if re.match(pat, lower):
            return "metadata"
    return "unknown"


def _detect_dl_strings(series) -> int:
    """Count detection limit strings in a series."""
    import re
    count = 0
    for val in series.dropna():
        s = str(val).strip()
        if s.lower() in SPECIAL_DL_VALUES:
            count += 1
        elif re.match(DL_PATTERN, s):
            count += 1
    return count


def _is_comma_decimal(s: str) -> bool:
    """Check if a string is a comma-decimal value (not a thousand separator).

    Thousand separators have exactly 3 digits after the comma (e.g., '1,234').
    Comma-decimals have any other count (e.g., '1,5', '12,34', '0,001').
    Ambiguous case (3 digits) is excluded to avoid silent data corruption.
    """
    import re
    m = re.match(r"^\d+,(\d+)$", s)
    if not m:
        return False
    # Exactly 3 digits after comma → ambiguous (could be thousand separator)
    return len(m.group(1)) != 3


def _detect_comma_decimals(series) -> dict:
    """Count comma-decimal values in a series, separating definite from ambiguous.

    Returns dict with 'definite' (non-3-digit fractional) and 'ambiguous'
    (exactly 3 digits — could be thousand separator) counts.
    """
    import re
    definite = 0
    ambiguous = 0
    for val in series.dropna():
        s = str(val).strip()
        m = re.match(r"^\d+,(\d+)$", s)
        if m:
            if len(m.group(1)) == 3:
                ambiguous += 1
            else:
                definite += 1
    return {"definite": definite, "ambiguous": ambiguous}


def _truncate_result(result: dict, max_chars: int = 1800) -> dict:
    """Return a copy of result with list fields trimmed to stay under max_chars."""
    import copy
    import json
    text = json.dumps(result)
    if len(text) <= max_chars:
        return result

    out = copy.deepcopy(result)
    for key in list(out.keys()):
        if isinstance(out[key], dict):
            for subkey in list(out[key].keys()):
                if isinstance(out[key][subkey], list) and len(out[key][subkey]) > 5:
                    out[key][subkey] = out[key][subkey][:5] + [f"... and {len(out[key][subkey]) - 5} more"]
        elif isinstance(out[key], list) and len(out[key]) > 5:
            out[key] = out[key][:5] + [f"... and {len(out[key]) - 5} more"]

    return out


# ═══════════════════════════════════════════════════════════════════════
# DIAGNOSTIC TOOLS (read-only — DataOps specialist)
# ═══════════════════════════════════════════════════════════════════════


def validate_geology(path: str) -> dict:
    """
    Validate a geological dataset for common data quality issues.

    Performs deterministic checks: column classification, missing required columns,
    detection limit strings, comma-decimal values, negative concentrations, and
    duplicate rows. Returns a structured diagnostic report.

    Does NOT modify the source file.

    Args:
        path: Path to CSV/Excel/LAS file

    Returns:
        dict with keys: column_classification, issues, row_count, duplicate_count,
        detection_limit_columns, comma_decimal_columns, negative_geochem_columns
    """
    import re
    import pandas as pd

    resolved = resolve_path(path)
    df = load(resolved)

    result = {
        "path": resolved,
        "row_count": len(df),
        "column_count": len(df.columns),
        "issues": [],
        "column_classification": {},
        "detection_limit_columns": {},
        "comma_decimal_columns": {},
        "negative_geochem_columns": {},
        "duplicate_count": 0,
    }

    # 1. Classify columns
    has_hole_id = False
    has_lat = False
    has_lon = False
    geochem_cols = []

    for col in df.columns:
        ctype = _classify_column(col)
        result["column_classification"][col] = ctype
        if ctype == "hole_id":
            has_hole_id = True
        elif ctype == "lat":
            has_lat = True
        elif ctype == "lon":
            has_lon = True
        elif ctype == "geochem":
            geochem_cols.append(col)

    # 2. Missing required columns
    if not has_hole_id:
        result["issues"].append("No hole_id column detected")
    if not has_lat:
        result["issues"].append("No latitude/northing column detected")
    if not has_lon:
        result["issues"].append("No longitude/easting column detected")
    if not geochem_cols:
        result["issues"].append("No geochemistry columns detected")

    # 3. Detection limit strings in geochem columns
    for col in geochem_cols:
        if pd.api.types.is_string_dtype(df[col]):
            dl_count = _detect_dl_strings(df[col])
            if dl_count > 0:
                result["detection_limit_columns"][col] = dl_count

    if result["detection_limit_columns"]:
        total_dl = sum(result["detection_limit_columns"].values())
        result["issues"].append(
            f"Detection limit strings found in {len(result['detection_limit_columns'])} columns ({total_dl} total values)"
        )

    # 4. Comma-decimal values
    ambiguous_columns = {}
    for col in df.columns:
        if pd.api.types.is_string_dtype(df[col]):
            counts = _detect_comma_decimals(df[col])
            if counts["definite"] > 0:
                result["comma_decimal_columns"][col] = counts["definite"]
            if counts["ambiguous"] > 0:
                ambiguous_columns[col] = counts["ambiguous"]

    if result["comma_decimal_columns"]:
        total_comma = sum(result["comma_decimal_columns"].values())
        result["issues"].append(
            f"Comma-decimal values found in {len(result['comma_decimal_columns'])} columns ({total_comma} total values)"
        )

    if ambiguous_columns:
        result["comma_decimal_ambiguous"] = ambiguous_columns
        result["issues"].append(
            f"Ambiguous comma values (could be thousand separators) in {len(ambiguous_columns)} columns — review manually or specify columns explicitly"
        )

    # 5. Negative concentrations in geochem columns
    for col in geochem_cols:
        if pd.api.types.is_numeric_dtype(df[col]):
            neg_count = int((df[col] < 0).sum())
            if neg_count > 0:
                result["negative_geochem_columns"][col] = neg_count

    if result["negative_geochem_columns"]:
        result["issues"].append(
            f"Negative concentrations in {len(result['negative_geochem_columns'])} geochem columns"
        )

    # 6. Duplicate rows
    dup_count = int(df.duplicated().sum())
    result["duplicate_count"] = dup_count
    if dup_count > 0:
        result["issues"].append(f"{dup_count} exact duplicate rows found")

    # 7. Hole_id + depth duplicates (if both exist)
    hole_id_col = None
    depth_cols = []
    for col in df.columns:
        ct = result["column_classification"].get(col)
        if ct == "hole_id" and hole_id_col is None:
            hole_id_col = col
        if col.lower() in ("depth", "from", "from_m", "depth_from"):
            depth_cols.append(col)

    if hole_id_col and depth_cols:
        subset = [hole_id_col] + depth_cols[:1]
        key_dups = int(df.duplicated(subset=subset).sum())
        if key_dups > 0:
            result["issues"].append(
                f"{key_dups} duplicate rows by {subset} (same hole + depth)"
            )

    return _truncate_result(result)


def detect_cleaning_issues(path: str, columns: list[str] = None) -> dict:
    """
    Granular per-column issue detection for data cleaning.

    For each column (or specified subset), reports: missing count, non-numeric
    values in should-be-numeric columns, detection limit strings, outlier count
    (IQR method), and unique value counts for categoricals.

    Does NOT modify the source file.

    Args:
        path: Path to CSV/Excel/LAS file
        columns: Optional list of column names to inspect (default: all)

    Returns:
        dict with per-column issue details
    """
    import re
    import numpy as np
    import pandas as pd

    resolved = resolve_path(path)
    df = load(resolved)

    target_cols = columns if columns else list(df.columns)

    # Validate requested columns exist
    missing_cols = [c for c in target_cols if c not in df.columns]
    if missing_cols:
        return {"error": f"Columns not found: {missing_cols}", "available_columns": list(df.columns)}

    result = {"path": resolved, "row_count": len(df), "columns": {}}

    for col in target_cols:
        col_info = {
            "dtype": str(df[col].dtype),
            "missing_count": int(df[col].isna().sum()),
            "classification": _classify_column(col),
        }

        if pd.api.types.is_string_dtype(df[col]):
            # String column analysis
            col_info["unique_count"] = int(df[col].nunique())
            col_info["detection_limit_count"] = _detect_dl_strings(df[col])
            comma_counts = _detect_comma_decimals(df[col])
            col_info["comma_decimal_count"] = comma_counts["definite"]
            if comma_counts["ambiguous"] > 0:
                col_info["comma_decimal_ambiguous"] = comma_counts["ambiguous"]

            # Non-numeric values in columns that should be numeric (geochem)
            if col_info["classification"] == "geochem":
                non_numeric = 0
                for val in df[col].dropna():
                    s = str(val).strip()
                    # Skip known DL patterns — they're already counted
                    if s.lower() in SPECIAL_DL_VALUES or re.match(DL_PATTERN, s):
                        continue
                    try:
                        float(s.replace(",", "."))
                    except ValueError:
                        non_numeric += 1
                col_info["non_numeric_count"] = non_numeric

        elif pd.api.types.is_numeric_dtype(df[col]):
            # Numeric column analysis
            valid = df[col].dropna()
            if len(valid) > 0:
                q1 = float(valid.quantile(0.25))
                q3 = float(valid.quantile(0.75))
                iqr = q3 - q1
                lower = q1 - 1.5 * iqr
                upper = q3 + 1.5 * iqr
                outlier_count = int(((valid < lower) | (valid > upper)).sum())
                col_info["outlier_count"] = outlier_count
                col_info["min"] = float(valid.min())
                col_info["max"] = float(valid.max())

                if col_info["classification"] == "geochem":
                    neg_count = int((valid < 0).sum())
                    if neg_count > 0:
                        col_info["negative_count"] = neg_count

        result["columns"][col] = col_info

    return _truncate_result(result)


# ═══════════════════════════════════════════════════════════════════════
# CLEANING TOOLS (mutation — Transform specialist)
# All tools save output to results/ and NEVER modify the source file.
# ═══════════════════════════════════════════════════════════════════════


def fix_decimals(
    path: str,
    columns: list[str] = None,
    from_separator: str = ",",
    to_separator: str = ".",
) -> dict:
    """
    Convert comma-decimal values to dot-decimal in specified columns.

    Only converts values where the fractional part is NOT exactly 3 digits
    (to avoid mangling thousand separators like '1,234'). Values with exactly
    3 digits after the comma are skipped and reported as ambiguous — specify
    those columns explicitly if you're sure they're decimals.

    Non-matching cells in each column are left untouched (no column-wide
    coercion). Only the specific cells matching the comma-decimal pattern
    are converted to numeric.

    Saves output to results/ — source file is NOT modified.

    Args:
        path: Path to CSV/Excel/LAS file
        columns: Optional list of columns to fix (default: auto-detect, skipping ambiguous)
        from_separator: Decimal separator to replace (default: ',')
        to_separator: Replacement decimal separator (default: '.')

    Returns:
        dict with output_path, columns_fixed, values_converted, ambiguous_skipped
    """
    import re
    import pandas as pd

    resolved = resolve_path(path)
    df = load(resolved).copy()

    # Auto-detect columns with definite comma decimals if not specified
    ambiguous_columns = {}
    if columns is None:
        columns = []
        for col in df.columns:
            if pd.api.types.is_string_dtype(df[col]):
                counts = _detect_comma_decimals(df[col])
                if counts["definite"] > 0:
                    columns.append(col)
                if counts["ambiguous"] > 0:
                    ambiguous_columns[col] = counts["ambiguous"]

    if not columns:
        result = {
            "output_path": None,
            "columns_fixed": [],
            "message": "No comma-decimal values detected in any column",
        }
        if ambiguous_columns:
            result["ambiguous_columns"] = ambiguous_columns
            result["message"] += (
                f". {len(ambiguous_columns)} column(s) have ambiguous values "
                "(exactly 3 digits after comma — could be thousand separators). "
                "Specify columns explicitly if these are decimals."
            )
        return result

    # Validate columns exist
    missing = [c for c in columns if c not in df.columns]
    if missing:
        return {"error": f"Columns not found: {missing}"}

    total_converted = 0
    total_ambiguous_skipped = 0
    columns_fixed = []

    for col in columns:
        if not pd.api.types.is_string_dtype(df[col]):
            continue

        col_converted = 0
        col_ambiguous = 0

        # Per-cell conversion: only touch cells matching comma-decimal pattern
        def convert_cell(val):
            nonlocal col_converted, col_ambiguous
            if pd.isna(val):
                return val
            s = str(val).strip()
            m = re.match(r"^\d+,(\d+)$", s)
            if not m:
                return val  # Not a comma-decimal — leave untouched
            if len(m.group(1)) == 3:
                # Ambiguous: could be thousand separator — skip
                col_ambiguous += 1
                return val
            # Safe to convert
            converted = s.replace(from_separator, to_separator)
            try:
                col_converted += 1
                return float(converted)
            except ValueError:
                return val  # Should not happen given the regex, but be safe

        df[col] = df[col].apply(convert_cell)
        total_converted += col_converted
        total_ambiguous_skipped += col_ambiguous
        if col_converted > 0:
            columns_fixed.append(col)

    output_path = save_csv(df, resolved, "fixed_decimals")
    drop(resolved)  # Invalidate cache since we have a new output

    result = {
        "output_path": output_path,
        "columns_fixed": columns_fixed,
        "values_converted": total_converted,
    }
    if total_ambiguous_skipped > 0:
        result["ambiguous_skipped"] = total_ambiguous_skipped
        result["ambiguous_note"] = (
            "Values with exactly 3 digits after comma were skipped "
            "(could be thousand separators). Re-run with explicit columns if these are decimals."
        )
    if ambiguous_columns:
        result["ambiguous_columns_autodetect"] = ambiguous_columns

    return result


def parse_detection_limits(
    path: str,
    columns: list[str],
    method: str = "half",
) -> dict:
    """
    Convert detection limit strings to numeric values in specified columns.

    Handles patterns: <X, >X, ≤X, ≥X, <=X, >=X, ND, BDL, trace, nil, -.
    Methods: 'half' (X/2, industry standard), 'zero' (0), 'value' (X as-is).
    ND/BDL/trace/nil/- → NaN (no numeric value can be inferred safely).

    Saves output to results/ — source file is NOT modified.

    Args:
        path: Path to CSV/Excel/LAS file
        columns: List of columns to parse
        method: How to handle below-detection values: 'half' (default), 'zero', 'value'

    Returns:
        dict with output_path, columns_parsed, counts_per_column, method_used
    """
    import re
    import numpy as np
    import pandas as pd

    resolved = resolve_path(path)
    df = load(resolved).copy()

    # Validate columns
    missing = [c for c in columns if c not in df.columns]
    if missing:
        return {"error": f"Columns not found: {missing}"}

    if method not in ("half", "zero", "value"):
        return {"error": f"Invalid method '{method}'. Use 'half', 'zero', or 'value'."}

    counts_per_column = {}

    for col in columns:
        counts = {"below_detection": 0, "above_detection": 0, "special_to_nan": 0, "parse_error": 0}

        def parse_value(val):
            if pd.isna(val):
                return val

            # Already numeric
            if isinstance(val, (int, float)):
                return float(val)

            s = str(val).strip()

            # Special values → NaN (anti-hallucination: we cannot infer a number)
            if s.lower() in SPECIAL_DL_VALUES:
                counts["special_to_nan"] += 1
                return np.nan

            # Detection limit pattern
            match = re.match(DL_PATTERN, s)
            if match:
                operator = match.group(1)
                limit = float(match.group(2))

                if operator in ("<", "≤", "<="):
                    counts["below_detection"] += 1
                    if method == "half":
                        return limit / 2.0
                    elif method == "zero":
                        return 0.0
                    else:  # value
                        return limit

                elif operator in (">", "≥", ">="):
                    counts["above_detection"] += 1
                    return limit

            # Try plain numeric parse
            try:
                return float(s)
            except ValueError:
                counts["parse_error"] += 1
                return np.nan

        df[col] = df[col].apply(parse_value)
        counts_per_column[col] = counts

    output_path = save_csv(df, resolved, "parsed_dl")
    drop(resolved)

    return {
        "output_path": output_path,
        "columns_parsed": columns,
        "counts_per_column": counts_per_column,
        "method_used": method,
    }


def remove_duplicates(
    path: str,
    subset: list[str] = None,
    keep: str = "first",
) -> dict:
    """
    Remove duplicate rows from a dataset.

    If subset is provided, duplicates are identified by those columns only.
    Otherwise, exact row duplicates are removed.

    Saves output to results/ — source file is NOT modified.

    Args:
        path: Path to CSV/Excel/LAS file
        subset: Optional list of columns to check for duplicates (default: all columns)
        keep: Which duplicate to keep: 'first' (default), 'last', or 'none' (drop all)

    Returns:
        dict with output_path, rows_before, rows_after, rows_removed
    """
    import pandas as pd

    resolved = resolve_path(path)
    df = load(resolved).copy()

    if subset:
        missing = [c for c in subset if c not in df.columns]
        if missing:
            return {"error": f"Columns not found: {missing}"}

    if keep not in ("first", "last", False, "none"):
        return {"error": f"Invalid keep value '{keep}'. Use 'first', 'last', or 'none'."}

    # Convert string 'none' to False for pandas
    keep_val = False if keep == "none" else keep

    rows_before = len(df)
    df = df.drop_duplicates(subset=subset, keep=keep_val)
    rows_after = len(df)

    output_path = save_csv(df, resolved, "deduped")
    drop(resolved)

    return {
        "output_path": output_path,
        "rows_before": rows_before,
        "rows_after": rows_after,
        "rows_removed": rows_before - rows_after,
    }


def standardize_terms(
    path: str,
    column: str,
    mapping: dict = None,
) -> dict:
    """
    Standardize terminology in a categorical column.

    If no mapping provided: strips whitespace and collapses multiple spaces
    (preserves case — geological codes like 'SiO2' must keep casing).
    If mapping provided (e.g., {"GRNT": "Granite", "grntd": "Granite"}):
    applies exact case-insensitive replacements.

    Saves output to results/ — source file is NOT modified.

    Args:
        path: Path to CSV/Excel/LAS file
        column: Name of the column to standardize
        mapping: Optional dict of {original_value: standardized_value}

    Returns:
        dict with output_path, values_changed, unique_before, unique_after
    """
    import re
    import pandas as pd

    resolved = resolve_path(path)
    df = load(resolved).copy()

    if column not in df.columns:
        return {"error": f"Column '{column}' not found. Available: {list(df.columns)}"}

    unique_before = int(df[column].nunique())
    original = df[column].copy()

    if mapping:
        # Case-insensitive mapping: build a lookup from lowercase keys
        lower_mapping = {k.lower().strip(): v for k, v in mapping.items()}

        def apply_mapping(val):
            if pd.isna(val):
                return val
            s = str(val).strip()
            return lower_mapping.get(s.lower(), s)

        df[column] = df[column].apply(apply_mapping)
    else:
        # Default normalization: strip whitespace + collapse multiple spaces.
        # Case is preserved — lowercasing destroys geological codes (SiO2 → sio2)
        # which breaks downstream pattern matching.
        def normalize(val):
            if pd.isna(val):
                return val
            s = str(val).strip()
            s = re.sub(r"\s+", " ", s)
            return s

        df[column] = df[column].apply(normalize)

    unique_after = int(df[column].nunique())
    # Use .fillna() sentinel to avoid NaN != NaN counting as "changed"
    sentinel = "__NAN_SENTINEL__"
    values_changed = int((original.fillna(sentinel) != df[column].fillna(sentinel)).sum())

    output_path = save_csv(df, resolved, "standardized")
    drop(resolved)

    return {
        "output_path": output_path,
        "column": column,
        "values_changed": values_changed,
        "unique_before": unique_before,
        "unique_after": unique_after,
    }
