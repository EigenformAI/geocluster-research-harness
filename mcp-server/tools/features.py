# NOTE: Heavy imports (numpy, rasterio, pandas, skimage) deferred to function
# bodies for fast MCP startup (<2s). See config.py header for rationale.

import ast
import os

from .config import save_raster, save_csv, get_output_dir, read_tabular


def _validate_band_math_expr(expression: str, allowed_names: set[str]) -> None:
    """Validate a band math expression using AST analysis.

    Raises ValueError if the expression contains unsafe operations.
    """
    try:
        tree = ast.parse(expression, mode="eval")
    except SyntaxError as e:
        raise ValueError(f"Invalid expression syntax: {e}")

    for node in ast.walk(tree):
        if isinstance(node, (ast.Expression, ast.BinOp, ast.UnaryOp, ast.Compare)):
            continue
        # Context nodes (Load appears on Name/Attribute/Subscript in eval mode)
        if isinstance(node, (ast.Load, ast.Store, ast.Del)):
            continue
        if isinstance(node, ast.Constant):
            continue
        if isinstance(
            node,
            (
                ast.Add,
                ast.Sub,
                ast.Mult,
                ast.Div,
                ast.FloorDiv,
                ast.Mod,
                ast.Pow,
                ast.USub,
                ast.UAdd,
                ast.Gt,
                ast.Lt,
                ast.GtE,
                ast.LtE,
                ast.Eq,
                ast.NotEq,
            ),
        ):
            continue
        if isinstance(node, ast.Name):
            if node.id not in allowed_names:
                raise ValueError(
                    f"Name '{node.id}' is not allowed. Allowed: {allowed_names}"
                )
            continue
        if isinstance(node, ast.Attribute):
            # Only allow np.function_name (one level of attribute access)
            if isinstance(node.value, ast.Name) and node.value.id == "np":
                continue
            raise ValueError("Attribute access not allowed except on 'np'")
        if isinstance(node, ast.Call):
            # Only allow calls to np.* functions
            if (
                isinstance(node.func, ast.Attribute)
                and isinstance(node.func.value, ast.Name)
                and node.func.value.id == "np"
            ):
                continue
            raise ValueError(
                "Function calls only allowed on 'np' (e.g., np.log, np.sqrt)"
            )
        if isinstance(node, ast.Subscript):
            continue
        if isinstance(node, (ast.BoolOp, ast.And, ast.Or)):
            continue
        if isinstance(node, ast.IfExp):
            continue
        if isinstance(node, ast.Tuple):
            continue
        raise ValueError(f"Unsafe AST node type: {type(node).__name__}")


def select_bands(path: str, indices: list[int]):
    """Extract selected bands from raster. indices are 1-based."""
    try:
        import rasterio

        with rasterio.open(path) as src:
            max_band = src.count
            if any(i < 1 or i > max_band for i in indices):
                return f"Error: Invalid indices {indices}. Input raster only has {max_band} bands."

            data = src.read(indices)

            meta = src.meta.copy()
            meta.update({"count": len(indices)})

            suffix = "bands_" + "-".join(map(str, indices))
            output_path = save_raster(data, meta, path, suffix)

            return {"output_path": output_path}

    except Exception as e:
        return f"Error selecting bands: {str(e)}"


def band_math(path: str, expression: str):
    """Band math on raster. Use b1,b2.. e.g. '(b1-b2)/(b1+b2)'."""
    try:
        import numpy as np
        import rasterio

        with rasterio.open(path) as src:
            meta = src.meta.copy()
            bands = {f"b{i}": src.read(i) for i in range(1, src.count + 1)}

            # AST-validate expression before evaluation (X-2 invariant)
            allowed_names = set(bands.keys()) | {"np"}
            try:
                _validate_band_math_expr(expression, allowed_names)
            except ValueError as e:
                return f"Error: Unsafe expression — {e}"

            try:
                result = eval(
                    compile(ast.parse(expression, mode="eval"), "<band_math>", "eval"),
                    {"__builtins__": {}, "np": np, **bands},
                )
            except Exception as math_err:
                return f"Error in math expression: {str(math_err)}"

            if isinstance(result, (int, float)):
                result = np.full(src.shape, result, dtype=np.float32)

            meta.update({"dtype": "float32", "count": 1})

            safe_expr = "".join(c for c in expression if c.isalnum())
            output_path = save_raster(
                result.astype(np.float32), meta, path, f"math_{safe_expr}"
            )

            return {"output_path": output_path}

    except Exception as e:
        return f"Error: {str(e)}"


def compute_gradient(path: str, method: str = "sobel"):
    """Compute gradient (edge detection) on raster. method: 'sobel'."""
    try:
        import numpy as np
        import rasterio
        from skimage.filters import sobel

        with rasterio.open(path) as src:
            data = src.read(1)
            meta = src.meta.copy()

            if method == "sobel":
                edges = sobel(data)
            else:
                return "Error: Only 'sobel' method is supported currently."

            meta.update({"dtype": "float32"})

            output_path = save_raster(edges.astype(np.float32), meta, path, "gradient")

            return {"output_path": output_path}

    except Exception as e:
        return f"Error computing gradient: {str(e)}"


def texture_features(path: str, method: str = "entropy"):
    """Compute texture features on raster. method: 'entropy'."""
    try:
        import numpy as np
        import rasterio
        from skimage.filters.rank import entropy
        from skimage.morphology import disk
        from skimage.util import img_as_ubyte

        with rasterio.open(path) as src:
            data = src.read(1)
            meta = src.meta.copy()

            valid_data = np.nan_to_num(data)

            d_min, d_max = valid_data.min(), valid_data.max()
            if d_max == d_min:
                return "Error: Data is flat (constant value), cannot compute texture."
            norm_data = (valid_data - d_min) / (d_max - d_min)

            image_ubyte = img_as_ubyte(norm_data)

            if method == "entropy":
                result = entropy(image_ubyte, disk(3))
            else:
                return "Error: Only 'entropy' method supported currently."

            meta.update({"dtype": "float32"})
            output_path = save_raster(
                result.astype(np.float32), meta, path, f"texture_{method}"
            )

            return {"output_path": output_path}

    except Exception as e:
        return f"Error computing texture: {str(e)}"


def select_columns(path: str, columns: list[str]):
    """Keep only selected columns from CSV."""
    try:
        df = read_tabular(path)

        missing = [c for c in columns if c not in df.columns]
        if missing:
            return f"Error: Columns not found: {missing}"

        df_new = df[columns].copy()
        output_path = save_csv(df_new, path, "subset")
        return {"output_path": output_path}

    except Exception as e:
        return f"Error: {str(e)}"


def compute_ratios(path: str, pairs: list[str]):
    """Compute column ratios. pairs: ['Au_ppb/Cu_ppm']."""
    try:
        df = read_tabular(path)
        df_new = df.copy()
        created_cols = []

        for pair in pairs:
            if "/" not in pair:
                return f"Error: Invalid format '{pair}'. Use 'Numerator/Denominator' (e.g., 'Au/Cu')."

            num, den = pair.split("/")
            if num not in df.columns or den not in df.columns:
                return f"Error: Columns for pair {pair} not found."

            denominator = df[den].replace(0, float("nan"))
            col_name = f"{num}_over_{den}"
            df_new[col_name] = df[num] / denominator
            created_cols.append(col_name)

        output_path = save_csv(df_new, path, "ratios")

        return {"output_path": output_path}
    except Exception as e:
        return f"Error: {str(e)}"


def aggregate(
    path: str,
    spatial_op: str,
    statistic: str = "mean",
    x_col: str = "Easting",
    y_col: str = "Northing",
):
    """Aggregate by grid ('grid:50') or column ('col:RockType'). statistic: mean/median/max/min/sum/count."""
    try:
        import numpy as np

        df = read_tabular(path)

        if spatial_op.startswith("grid:"):
            try:
                resolution = float(spatial_op.split(":")[1])
            except:
                return "Error: Invalid grid format. Use 'grid:50' (number)."

            if x_col not in df.columns or y_col not in df.columns:
                return f"Error: Coordinate columns '{x_col}'/'{y_col}' not found."

            df["X_bin"] = (df[x_col] / resolution).round() * resolution
            df["Y_bin"] = (df[y_col] / resolution).round() * resolution

            group_cols = ["X_bin", "Y_bin"]

        elif spatial_op.startswith("col:"):
            col_name = spatial_op.split(":")[1]
            if col_name not in df.columns:
                return f"Error: Column '{col_name}' not found."
            group_cols = [col_name]

        else:
            return "Error: spatial_op must start with 'grid:' or 'col:'"

        numeric_cols = df.select_dtypes(include=[np.number]).columns.tolist()

        numeric_cols = [
            c for c in numeric_cols if c not in group_cols and c not in [x_col, y_col]
        ]

        if statistic == "mean":
            df_agg = df.groupby(group_cols)[numeric_cols].mean().reset_index()
        elif statistic == "median":
            df_agg = df.groupby(group_cols)[numeric_cols].median().reset_index()
        elif statistic == "max":
            df_agg = df.groupby(group_cols)[numeric_cols].max().reset_index()
        elif statistic == "sum":
            df_agg = df.groupby(group_cols)[numeric_cols].sum().reset_index()
        elif statistic == "count":
            df_agg = (
                df.groupby(group_cols)[numeric_cols[0]]
                .count()
                .reset_index()
                .rename(columns={numeric_cols[0]: "count"})
            )
        else:
            return "Error: Statistic not supported. Use mean/median/max/sum."

        safe_op = spatial_op.replace(":", "_")
        output_path = save_csv(df_agg, path, f"agg_{safe_op}_{statistic}")

        return {"output_path": output_path, "rows": len(df_agg)}

    except Exception as e:
        return f"Error aggregating: {str(e)}"
