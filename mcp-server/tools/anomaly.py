# NOTE: Heavy imports deferred to function bodies for fast MCP startup.

from .config import save_csv, read_tabular


def compute_anomaly(path: str, columns: list[str], method: str = "zscore"):
    """Compute anomaly scores. method: 'zscore', 'mad', or 'ratio'."""
    try:
        df = read_tabular(path)
        df_new = df.copy()

        for col in columns:
            if col not in df.columns:
                return f"Error: Column {col} not found."

            data = df[col]

            if method == "zscore":
                # (Value - Mean) / StdDev
                mean = data.mean()
                std = data.std()
                df_new[f"{col}_anom_z"] = (data - mean) / std

            elif method == "mad":
                # Robust Z-Score using Median
                median = data.median()
                mad = (data - median).abs().median()
                # 0.6745 constant makes it comparable to Z-score
                df_new[f"{col}_anom_mad"] = 0.6745 * (data - median) / mad

            elif method == "ratio":
                # Value / Mean (Times Background)
                bg = data.mean()
                df_new[f"{col}_anom_ratio"] = data / bg

            else:
                return "Error: Method not supported. Use 'zscore', 'mad', or 'ratio'."

        output_path = save_csv(df_new, path, f"anom_{method}")
        return {"output_path": output_path}
    except Exception as e:
        return f"Error: {str(e)}"


def threshold(path: str, column: str, value: float, mode: str = "above"):
    """Filter rows by threshold. mode: 'above' or 'below'."""
    try:
        df = read_tabular(path)

        if column not in df.columns:
            return f"Error: Column {column} not found."

        if mode == "above":
            df_filtered = df[df[column] > value]
        elif mode == "below":
            df_filtered = df[df[column] < value]
        else:
            return "Error: Mode must be 'above' or 'below'."

        output_path = save_csv(df_filtered, path, f"thresh_{column}")

        return {"output_path": output_path, "kept": len(df_filtered)}
    except Exception as e:
        return f"Error: {str(e)}"


def rank_by_metric(path: str, metric: str, top_n: int = 10):
    """Return top N rows sorted by metric descending."""
    try:
        df = read_tabular(path)

        if metric not in df.columns:
            return f"Error: Column {metric} not found."

        # Sort descending (Highest first)
        df_sorted = df.sort_values(by=metric, ascending=False).head(top_n)

        output_path = save_csv(df_sorted, path, f"top_{top_n}_{metric}")

        return {"output_path": output_path}
    except Exception as e:
        return f"Error: {str(e)}"
