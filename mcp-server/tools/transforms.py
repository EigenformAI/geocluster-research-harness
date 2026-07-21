# NOTE: Heavy imports (pandas, numpy, sklearn) deferred to function bodies
# for fast MCP startup (<2s). See config.py header for rationale.

from .config import save_csv, read_tabular


def log_transform(path: str, columns: list[str], base: str = "e"):
    """Log transform columns (log1p). base: 'e' or '10'."""
    try:
        import numpy as np

        df = read_tabular(path)
        df_new = df.copy()

        for col in columns:
            if col not in df.columns:
                return f"Error: Column {col} not found."

            if (df[col] < 0).any():
                return f"Error: Column {col} contains negative values. Log transform impossible."

            if base == "10":
                df_new[f"{col}_log10"] = np.log1p(df[col]) / np.log(10)
            else:
                df_new[f"{col}_log"] = np.log1p(df[col])

        output_path = save_csv(df_new, path, "log")

        return {"output_path": output_path}
    except Exception as e:
        return f"Error: {str(e)}"


def standardize(path: str, columns: list[str]):
    """Z-score standardize columns (mean=0, std=1)."""
    try:
        from sklearn.preprocessing import StandardScaler

        df = read_tabular(path)
        scaler = StandardScaler()

        data = df[columns].fillna(df[columns].mean())
        transformed = scaler.fit_transform(data)

        df_new = df.copy()
        new_cols = []
        for i, col in enumerate(columns):
            new_col_name = f"{col}_z"
            df_new[new_col_name] = transformed[:, i]
            new_cols.append(new_col_name)

        output_path = save_csv(df_new, path, "std")

        return {"output_path": output_path}
    except Exception as e:
        return f"Error: {str(e)}"


def normalize(path: str, columns: list[str], method: str = "minmax"):
    """Normalize columns to [0,1] range."""
    try:
        from sklearn.preprocessing import MinMaxScaler

        df = read_tabular(path)

        if method == "minmax":
            scaler = MinMaxScaler()
        else:
            return "Error: Only 'minmax' method supported currently."

        data = df[columns].fillna(df[columns].mean())
        transformed = scaler.fit_transform(data)

        df_new = df.copy()
        for i, col in enumerate(columns):
            df_new[f"{col}_norm"] = transformed[:, i]

        output_path = save_csv(df_new, path, "norm")
        return {"status": "success", "output_path": output_path}
    except Exception as e:
        return f"Error: {str(e)}"


def smooth(path: str, columns: list[str], window: int = 3, method: str = "mean"):
    """Rolling window smooth. method: 'mean' or 'median'."""
    try:
        df = read_tabular(path)
        df_new = df.copy()

        for col in columns:
            if method == "mean":
                df_new[f"{col}_smooth"] = (
                    df[col].rolling(window=window, center=True).mean()
                )
            elif method == "median":
                df_new[f"{col}_smooth"] = (
                    df[col].rolling(window=window, center=True).median()
                )

        output_path = save_csv(df_new, path, f"smooth_{window}")
        return {"status": "success", "output_path": output_path}
    except Exception as e:
        return f"Error: {str(e)}"


def pivot(path: str, index: list[str], columns: str, values: list[str], aggfunc: str = "first"):
    """Pivot table: reshape long-to-wide. Creates columns from unique values in 'columns' field."""
    try:
        import pandas as pd

        df = read_tabular(path)

        for col in index + [columns] + values:
            if col not in df.columns:
                return f"Error: Column '{col}' not found. Available: {list(df.columns)}"

        result = pd.pivot_table(df, index=index, columns=columns, values=values, aggfunc=aggfunc)

        # Flatten MultiIndex columns to {value}_{column_value} format
        if isinstance(result.columns, pd.MultiIndex):
            result.columns = [f"{v}_{c}" for v, c in result.columns]
        else:
            result.columns = [str(c) for c in result.columns]

        result = result.reset_index()
        output_path = save_csv(result, path, "pivot")
        return {"status": "success", "output_path": output_path, "shape": list(result.shape)}
    except Exception as e:
        return f"Error: {str(e)}"


def melt(path: str, id_vars: list[str], value_vars: list[str], var_name: str = "variable", value_name: str = "value"):
    """Melt (unpivot): reshape wide-to-long. Keeps id_vars fixed, melts value_vars into rows."""
    try:
        import pandas as pd

        df = read_tabular(path)

        for col in id_vars + value_vars:
            if col not in df.columns:
                return f"Error: Column '{col}' not found. Available: {list(df.columns)}"

        result = pd.melt(df, id_vars=id_vars, value_vars=value_vars, var_name=var_name, value_name=value_name)
        output_path = save_csv(result, path, "melt")
        return {"status": "success", "output_path": output_path, "shape": list(result.shape)}
    except Exception as e:
        return f"Error: {str(e)}"


def merge_datasets(path: str, right_path: str, on: list[str], how: str = "inner"):
    """Merge two datasets on shared columns. how: 'inner', 'outer', 'left', 'right'."""
    try:
        import pandas as pd
        from .config import resolve_path

        resolve_path(path)
        resolve_path(right_path)

        left = read_tabular(path)
        right = read_tabular(right_path)

        if how not in ("inner", "outer", "left", "right"):
            return f"Error: Invalid merge type '{how}'. Use: inner, outer, left, right."

        for col in on:
            if col not in left.columns:
                return f"Error: Column '{col}' not found in left dataset. Available: {list(left.columns)}"
            if col not in right.columns:
                return f"Error: Column '{col}' not found in right dataset. Available: {list(right.columns)}"

        result = pd.merge(left, right, on=on, how=how)
        output_path = save_csv(result, path, "merged")
        return {"status": "success", "output_path": output_path, "shape": list(result.shape)}
    except Exception as e:
        return f"Error: {str(e)}"


def filter_rows(path: str, column: str, operator: str, value: str = ""):
    """Filter rows by condition. operator: ==, !=, >, <, >=, <=, in, not_in, contains, not_null. For 'in'/'not_in', pass comma-separated values (e.g. '9989,138128,134159')."""
    try:
        import pandas as pd

        df = read_tabular(path)

        if column not in df.columns:
            return f"Error: Column '{column}' not found. Available: {list(df.columns)}"

        valid_ops = ("==", "!=", ">", "<", ">=", "<=", "in", "not_in", "contains", "not_null")
        if operator not in valid_ops:
            return f"Error: Invalid operator '{operator}'. Use: {valid_ops}"

        col = df[column]

        if operator == "not_null":
            mask = col.notna()
        elif operator == "contains":
            mask = col.astype(str).str.contains(str(value), case=False, na=False)
        elif operator in ("in", "not_in"):
            # Parse comma-separated values, coerce to column dtype
            raw_values = [v.strip() for v in str(value).split(",") if v.strip()]
            if pd.api.types.is_numeric_dtype(col):
                typed_values = []
                for v in raw_values:
                    try:
                        typed_values.append(float(v))
                    except ValueError:
                        typed_values.append(v)
            else:
                typed_values = raw_values
            if operator == "in":
                mask = col.isin(typed_values)
            else:
                mask = ~col.isin(typed_values)
        else:
            # Try numeric comparison first, fall back to string
            try:
                typed_value = float(value) if pd.api.types.is_numeric_dtype(col) else value
            except (ValueError, TypeError):
                typed_value = value

            if operator == "==":
                mask = col == typed_value
            elif operator == "!=":
                mask = col != typed_value
            elif operator == ">":
                mask = col > typed_value
            elif operator == "<":
                mask = col < typed_value
            elif operator == ">=":
                mask = col >= typed_value
            elif operator == "<=":
                mask = col <= typed_value

        result = df[mask]
        output_path = save_csv(result, path, "filtered")
        return {
            "status": "success",
            "output_path": output_path,
            "rows_before": len(df),
            "rows_after": len(result),
            "rows_removed": len(df) - len(result),
        }
    except Exception as e:
        return f"Error: {str(e)}"


def convert_dtype(path: str, columns: list[str], dtype: str = "numeric", errors: str = "coerce"):
    """Convert column data types. dtype: 'numeric', 'int', 'float', 'str', 'datetime'. errors: 'coerce' (invalid→NaN), 'raise' (fail on invalid)."""
    try:
        import pandas as pd

        df = read_tabular(path)

        for col in columns:
            if col not in df.columns:
                return f"Error: Column '{col}' not found. Available: {list(df.columns)}"

        valid_dtypes = ("numeric", "int", "float", "str", "datetime")
        if dtype not in valid_dtypes:
            return f"Error: Invalid dtype '{dtype}'. Use: {valid_dtypes}"

        df_new = df.copy()
        converted = []

        for col in columns:
            original_dtype = str(df_new[col].dtype)
            if dtype == "numeric":
                df_new[col] = pd.to_numeric(df_new[col], errors=errors)
            elif dtype == "int":
                df_new[col] = pd.to_numeric(df_new[col], errors=errors)
                df_new[col] = df_new[col].astype("Int64")  # nullable int
            elif dtype == "float":
                df_new[col] = pd.to_numeric(df_new[col], errors=errors).astype(float)
            elif dtype == "str":
                df_new[col] = df_new[col].astype(str)
            elif dtype == "datetime":
                df_new[col] = pd.to_datetime(df_new[col], errors=errors)

            new_dtype = str(df_new[col].dtype)
            null_count = int(df_new[col].isna().sum())
            converted.append({"column": col, "from": original_dtype, "to": new_dtype, "nulls_after": null_count})

        output_path = save_csv(df_new, path, "converted")
        return {
            "status": "success",
            "output_path": output_path,
            "conversions": converted,
        }
    except Exception as e:
        return f"Error: {str(e)}"
