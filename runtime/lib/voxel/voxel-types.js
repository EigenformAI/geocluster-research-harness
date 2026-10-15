// Runtime-owned deterministic module. Reproduce with scripts/vendor-voxel.mjs.
/**
 * Shared voxel models. A voxel artifact is one immutable JSON manifest plus
 * NumPy `.npy` members on a regular, axis-aligned grid. Array shape is
 * [nx, ny, nz] in C order with Z fastest; flat index is (i * ny + j) * nz + k.
 * The origin is the lower cell corner; a cell center is origin + (index + 0.5) * spacing.
 */
export const VOXEL_MANIFEST_FORMAT = "geocluster-voxel";
export const VOXEL_SCHEMA_VERSION = 1;
export const VOXEL_ALGORITHM = "geocluster-binning-v1";
export const VOXEL_BOUNDARY_POLICY = "grid-snap-v2";
/** Relative tolerance under which categorical length totals are a tie (float summation noise). */
export const VOXEL_TIE_TOLERANCE = 1e-12;
export const VOXEL_NPY_PARSER = "bounded-npy-v1";
/** Advisory UI heuristic for suggested cell sizes; not a capacity claim. */
export const VOXEL_SUGGESTED_CELLS = 100_000;
/** Advisory full-box display budget. The viewer can override it explicitly. */
export const VOXEL_DISPLAY_BUDGET = 250_000;
export const LENGTH_UNIT_METRES = { m: 1, ft: 0.3048, "us-ft": 1200 / 3937 };
export const LENGTH_UNIT_LABELS = { m: "metres", ft: "international feet", "us-ft": "US survey feet" };
export const VOXEL_EXCLUSION_LABELS = {
    "predicate-operand": "Row filter value missing or not a number",
    filtered: "Did not match row filters",
    "value-missing": "Value missing",
    "value-sentinel": "Declared sentinel value",
    "value-censored": "Censored value excluded",
    "value-unparseable": "Value is not a number under the declared format",
    "value-nonfinite": "Value is not finite",
    "geometry-missing": "Coordinate or depth missing",
    "geometry-unparseable": "Coordinate or depth is not a number",
    "interval-invalid": "Invalid interval (negative depth or To not greater than From)",
    "segment-zero-length": "Zero-length segment",
    "outside-extent": "Outside the confirmed extent",
};
