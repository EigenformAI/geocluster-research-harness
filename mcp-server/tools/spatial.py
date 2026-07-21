# NOTE: Heavy imports (pandas, geopandas, shapely, rasterio, numpy) deferred
# to function bodies for fast MCP startup (<2s). See config.py header for rationale.

import os

from .config import get_output_dir, save_raster, read_tabular


def reproject(
    path: str,
    target_crs: str = "EPSG:4326",
    x_col: str = None,
    y_col: str = None,
    source_crs: str = None,
):
    """Reproject dataset to a new CRS. For CSV: provide x_col, y_col, source_crs."""
    try:
        import pandas as pd
        import geopandas as gpd
        from shapely.geometry import Point

        if path.endswith(".csv"):
            if not x_col or not y_col:
                return "Error: CSV files require 'x_col' and 'y_col' arguments."

            df = read_tabular(path)
            geometry = [Point(xy) for xy in zip(df[x_col], df[y_col])]
            gdf = gpd.GeoDataFrame(df, geometry=geometry)

            if source_crs:
                gdf.set_crs(source_crs, inplace=True)

            if gdf.crs is None:
                return "Error: Input CSV has no CRS. Please provide 'source_crs' (e.g., 'EPSG:32750')."

        else:
            gdf = gpd.read_file(path)
            if source_crs:
                gdf.to_crs(source_crs, inplace=True)

        gdf_transformed = gdf.to_crs(target_crs)

        output_dir = get_output_dir(path)
        filename = os.path.basename(path)
        name, ext = os.path.splitext(filename)

        safe_target = target_crs.replace(":", "-").replace(" ", "")
        output_path = os.path.join(output_dir, f"{name}_{safe_target}{ext}")

        if path.endswith(".csv"):
            gdf_transformed[x_col] = gdf_transformed.geometry.x
            gdf_transformed[y_col] = gdf_transformed.geometry.y
            pd.DataFrame(gdf_transformed.drop(columns="geometry")).to_csv(
                output_path, index=False
            )
        else:
            gdf_transformed.to_file(output_path, driver="GeoJSON")

        return {"output_path": output_path, "target_crs": target_crs}

    except Exception as e:
        return f"Error reprojecting data: {str(e)}"


def resample(path: str, scale_factor: float = 0.5):
    """Resample raster resolution (0.5=half, 2.0=double)."""
    try:
        import rasterio
        from rasterio.warp import reproject as rio_reproject
        from rasterio.enums import Resampling

        with rasterio.open(path) as src:
            new_width = int(src.width * scale_factor)
            new_height = int(src.height * scale_factor)

            dst_transform = src.transform * src.transform.scale(
                (src.width / new_width), (src.height / new_height)
            )

            kwargs = src.meta.copy()
            kwargs.update(
                {"transform": dst_transform, "width": new_width, "height": new_height}
            )

            output_dir = get_output_dir(path)
            name, ext = os.path.splitext(os.path.basename(path))
            output_path = os.path.join(
                output_dir, f"{name}_resampled_{scale_factor}x{ext}"
            )

            with rasterio.open(output_path, "w", **kwargs) as dst:
                for i in range(1, src.count + 1):
                    rio_reproject(
                        source=rasterio.band(src, i),
                        destination=rasterio.band(dst, i),
                        src_transform=src.transform,
                        src_crs=src.crs,
                        dst_transform=dst_transform,
                        dst_crs=src.crs,
                        resampling=Resampling.bilinear,
                    )

            return {"output_path": output_path}

    except Exception as e:
        return f"Error resampling: {str(e)}"


def clip_to_extent(
    path: str, min_x: float, min_y: float, max_x: float, max_y: float, crs: str = None
):
    """Clip raster to bounding box. crs defaults to raster's CRS."""
    try:
        import rasterio
        import geopandas as gpd
        from shapely.geometry import box
        from rasterio.mask import mask

        with rasterio.open(path) as src:
            bbox = box(min_x, min_y, max_x, max_y)

            box_crs = crs if crs else src.crs

            geo = gpd.GeoDataFrame({"geometry": bbox}, index=[0], crs=box_crs)

            if str(box_crs) != str(src.crs):
                geo = geo.to_crs(src.crs)

            out_image, out_transform = mask(src, geo.geometry, crop=True)
            out_meta = src.meta.copy()

            out_meta.update(
                {
                    "driver": "GTiff",
                    "height": out_image.shape[1],
                    "width": out_image.shape[2],
                    "transform": out_transform,
                }
            )

            output_dir = get_output_dir(path)
            name, ext = os.path.splitext(os.path.basename(path))
            output_path = os.path.join(output_dir, f"{name}_clipped{ext}")

            with rasterio.open(output_path, "w", **out_meta) as dest:
                dest.write(out_image)

            return {"output_path": output_path}

    except Exception as e:
        return f"Error clipping: {str(e)}"


def align_grids(source_path: str, reference_path: str):
    """Align source raster to match reference raster's grid and CRS."""
    try:
        import rasterio
        from rasterio.warp import reproject as rio_reproject
        from rasterio.enums import Resampling

        with rasterio.open(reference_path) as ref:
            dst_crs = ref.crs
            dst_transform = ref.transform
            dst_width = ref.width
            dst_height = ref.height
            dst_profile = ref.profile.copy()

        with rasterio.open(source_path) as src:
            dst_profile.update(
                {
                    "crs": dst_crs,
                    "transform": dst_transform,
                    "width": dst_width,
                    "height": dst_height,
                    "driver": "GTiff",
                }
            )

            output_dir = get_output_dir(source_path)
            name = os.path.splitext(os.path.basename(source_path))[0]
            ref_name = os.path.splitext(os.path.basename(reference_path))[0]
            output_path = os.path.join(output_dir, f"{name}_aligned_to_{ref_name}.tif")

            with rasterio.open(output_path, "w", **dst_profile) as dst:
                for i in range(1, src.count + 1):
                    rio_reproject(
                        source=rasterio.band(src, i),
                        destination=rasterio.band(dst, i),
                        src_transform=src.transform,
                        src_crs=src.crs,
                        dst_transform=dst_transform,
                        dst_crs=dst_crs,
                        resampling=Resampling.bilinear,
                    )

            return {"output_path": output_path}

    except Exception as e:
        return f"Error aligning grids: {str(e)}"
