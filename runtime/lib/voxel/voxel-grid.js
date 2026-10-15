// Runtime-owned deterministic module. Reproduce with scripts/vendor-voxel.mjs.
import { VOXEL_SUGGESTED_CELLS } from "./voxel-types.js";
export class VoxelGridError extends Error {
    code;
    constructor(code, message) {
        super(message);
        this.code = code;
    }
}
/** Cell-unit tolerance at which a coordinate/spacing pair is rejected as numerically unresolved. */
export const UNRESOLVED_TOLERANCE = 1e-4;
export function snapTolerance(p, o, s) {
    return Math.max(1e-9, 8 * Number.EPSILON * Math.max(1, Math.abs(p) / s, Math.abs(o) / s));
}
/** Coordinate of p in cell units from o, snapped to the nearest lattice plane within tolerance. */
export function gridCoordinate(p, o, s) {
    const tolerance = snapTolerance(p, o, s);
    if (tolerance >= UNRESOLVED_TOLERANCE) {
        const minimum = 8 * Number.EPSILON * Math.max(Math.abs(p), Math.abs(o)) / UNRESOLVED_TOLERANCE;
        throw new VoxelGridError("unresolved", `Coordinate ${p} cannot be binned reliably at ${s} spacing. Use cells larger than ${minimum.toPrecision(2)} or translate coordinates closer to zero.`);
    }
    const t = (p - o) / s, nearest = Math.round(t);
    return Math.abs(t - nearest) <= tolerance ? nearest : t;
}
export function validSpacing(spacing) {
    return spacing.length === 3 && spacing.every((s) => Number.isFinite(s) && s > 0);
}
/** Auto extent on the zero-anchored lattice: includes maximum-boundary points and flat datasets. */
export function autoFrame(bounds, spacing) {
    if (!validSpacing(spacing))
        throw new VoxelGridError("spacing", "Cell sizes must be positive, finite numbers.");
    const origin = [0, 0, 0], shape = [1, 1, 1];
    for (let axis = 0; axis < 3; axis++) {
        const s = spacing[axis];
        origin[axis] = Math.floor(gridCoordinate(bounds.min[axis], 0, s)) * s;
        shape[axis] = Math.max(1, Math.floor(gridCoordinate(bounds.max[axis], origin[axis], s)) + 1);
    }
    return { origin, shape, spacing: [...spacing] };
}
export function cellCount(shape) {
    return shape[0] * shape[1] * shape[2];
}
export function validShape(shape) {
    return shape.length === 3 && shape.every((n) => Number.isSafeInteger(n) && n >= 1) && Number.isSafeInteger(cellCount(shape));
}
export function flatIndex(shape, i, j, k) {
    return (i * shape[1] + j) * shape[2] + k;
}
export function cellIndex(shape, flat) {
    const plane = shape[1] * shape[2];
    return [Math.floor(flat / plane), Math.floor(flat / shape[2]) % shape[1], flat % shape[2]];
}
export function cellBounds(grid, index) {
    const lower = [0, 1, 2].map((axis) => grid.origin[axis] + index[axis] * grid.spacing[axis]);
    const upper = [0, 1, 2].map((axis) => grid.origin[axis] + (index[axis] + 1) * grid.spacing[axis]);
    const center = [0, 1, 2].map((axis) => grid.origin[axis] + (index[axis] + 0.5) * grid.spacing[axis]);
    return { lower, upper, center };
}
export function upperCorner(grid) {
    return [0, 1, 2].map((axis) => grid.origin[axis] + grid.shape[axis] * grid.spacing[axis]);
}
/** Axis index of a snapped grid coordinate; the outer upper face belongs to the last cell. */
function axisCell(u, n) {
    return u === n ? n - 1 : Math.floor(u);
}
/** Containing cell, or null outside the box. Positions beyond the box are never clamped into it. */
export function pointCell(grid, position) {
    const index = [0, 0, 0];
    for (let axis = 0; axis < 3; axis++) {
        const u = gridCoordinate(position[axis], grid.origin[axis], grid.spacing[axis]);
        if (u < 0 || u > grid.shape[axis])
            return null;
        index[axis] = axisCell(u, grid.shape[axis]);
    }
    return flatIndex(grid.shape, index[0], index[1], index[2]);
}
function lexicographicallyAfter(a, b) {
    for (let axis = 0; axis < 3; axis++)
        if (a[axis] !== b[axis])
            return a[axis] > b[axis];
    return false;
}
/**
 * Exact segment/cell intersection lengths after clipping to the closed grid box.
 * Returns null when no positive length remains inside the box. Endpoint order
 * is canonicalized so reversed segments produce identical results. Crossings
 * closer than the snap tolerance are one crossing (a touch, not a piece), and
 * piece lengths are measured between exact lattice planes.
 */
export function traverseSegment(grid, start, end) {
    const [a, b] = lexicographicallyAfter(start, end) ? [end, start] : [start, end];
    const totalLength = Math.hypot(b[0] - a[0], b[1] - a[1], b[2] - a[2]);
    if (!(totalLength > 0))
        return null;
    const u0 = [0, 0, 0], du = [0, 0, 0];
    let enter = { t: 0, planes: [] }, exit = { t: 1, planes: [] }, tolerance = 0;
    for (let axis = 0; axis < 3; axis++) {
        const n = grid.shape[axis], o = grid.origin[axis], s = grid.spacing[axis];
        u0[axis] = gridCoordinate(a[axis], o, s);
        du[axis] = gridCoordinate(b[axis], o, s) - u0[axis];
        tolerance = Math.max(tolerance, snapTolerance(a[axis], o, s), snapTolerance(b[axis], o, s));
        if (du[axis] === 0) {
            if (u0[axis] < 0 || u0[axis] > n)
                return null;
            continue;
        }
        const low = (0 - u0[axis]) / du[axis], high = (n - u0[axis]) / du[axis];
        const [near, far] = low < high ? [{ t: low, plane: 0 }, { t: high, plane: n }] : [{ t: high, plane: n }, { t: low, plane: 0 }];
        if (near.t > enter.t)
            enter = { t: near.t, planes: [[axis, near.plane]] };
        if (far.t < exit.t)
            exit = { t: far.t, planes: [[axis, far.plane]] };
    }
    // Cell units travelled per unit t along the fastest axis: converts parametric gaps into the tolerance's units.
    const scale = Math.max(Math.abs(du[0]), Math.abs(du[1]), Math.abs(du[2]));
    if (!((exit.t - enter.t) * scale > tolerance))
        return null;
    const crossings = [];
    for (let axis = 0; axis < 3; axis++) {
        if (du[axis] === 0)
            continue;
        const from = u0[axis] + du[axis] * enter.t, to = u0[axis] + du[axis] * exit.t;
        const low = Math.max(1, Math.floor(Math.min(from, to)) + 1), high = Math.min(grid.shape[axis] - 1, Math.ceil(Math.max(from, to)) - 1);
        for (let plane = low; plane <= high; plane++) {
            const t = (plane - u0[axis]) / du[axis];
            if (t > enter.t && t < exit.t)
                crossings.push({ t, planes: [[axis, plane]] });
        }
    }
    crossings.sort((x, y) => x.t - y.t);
    // Coincident crossings advance every crossed axis at once; a gap within the snap tolerance is a touch.
    const breaks = [{ t: enter.t, planes: [...enter.planes] }];
    for (const crossing of [...crossings, exit]) {
        const last = breaks[breaks.length - 1];
        if ((crossing.t - last.t) * scale <= tolerance) {
            last.planes.push(...crossing.planes);
            if (crossing === exit)
                last.t = exit.t;
        }
        else
            breaks.push({ t: crossing.t, planes: [...crossing.planes] });
    }
    if (breaks.length < 2)
        return null;
    const point = (at) => [0, 1, 2].map((axis) => {
        const fixed = at.planes.find(([crossed]) => crossed === axis);
        if (fixed)
            return grid.origin[axis] + fixed[1] * grid.spacing[axis];
        return at.t === 0 ? a[axis] : at.t === 1 ? b[axis] : a[axis] + at.t * (b[axis] - a[axis]);
    });
    const lengths = new Map();
    let retainedLength = 0;
    for (let piece = 0; piece + 1 < breaks.length; piece++) {
        const t0 = breaks[piece].t, t1 = breaks[piece + 1].t, middle = (t0 + t1) / 2, index = [0, 0, 0];
        for (let axis = 0; axis < 3; axis++) {
            const n = grid.shape[axis];
            index[axis] = du[axis] === 0 ? axisCell(u0[axis], n) : Math.min(n - 1, Math.max(0, Math.floor(u0[axis] + du[axis] * middle)));
        }
        const p0 = point(breaks[piece]), p1 = point(breaks[piece + 1]);
        const length = Math.hypot(p1[0] - p0[0], p1[1] - p0[1], p1[2] - p0[2]);
        const cell = flatIndex(grid.shape, index[0], index[1], index[2]);
        lengths.set(cell, (lengths.get(cell) ?? 0) + length);
        retainedLength += length;
    }
    return { pieces: [...lengths].map(([cell, length]) => ({ cell, length })), totalLength, retainedLength, clipped: enter.t > 0 || exit.t < 1 };
}
const niceStep = (raw) => {
    const power = Math.pow(10, Math.floor(Math.log10(raw)));
    return [1, 2, 2.5, 5, 10].map((factor) => factor * power).reduce((best, value) => Math.abs(Math.log(value / raw)) < Math.abs(Math.log(best / raw)) ? value : best);
};
/**
 * A 1-2-2.5-5 step near the size that yields roughly the target cell count. Axes thinner than the
 * step would hold one cell, so they leave the estimate and it is recomputed. `zInterval` (typically
 * the median interval length) sets the vertical step for downhole data instead of the isotropic
 * step, capped so the suggestion stays within about 50× the target count. Advisory only.
 */
export function suggestSpacing(bounds, target = VOXEL_SUGGESTED_CELLS, zInterval) {
    const extents = [0, 1, 2].map((axis) => bounds.max[axis] - bounds.min[axis]);
    let axes = [0, 1, 2].filter((axis) => extents[axis] > 0), step = 1;
    while (axes.length) {
        step = niceStep(Math.pow(axes.reduce((product, axis) => product * extents[axis], 1) / target, 1 / axes.length));
        const kept = axes.filter((axis) => extents[axis] >= step);
        if (kept.length === axes.length)
            break;
        axes = kept;
    }
    const spacing = [step, step, step];
    if (zInterval !== undefined && Number.isFinite(zInterval) && zInterval > 0 && extents[2] > 0) {
        spacing[2] = niceStep(zInterval);
        const flat = [0, 1].reduce((product, axis) => product * Math.max(1, Math.ceil(extents[axis] / spacing[axis])), 1);
        const zAllowed = Math.max(1, Math.floor((target * 50) / flat));
        if (Math.ceil(extents[2] / spacing[2]) > zAllowed)
            spacing[2] = niceStep(Math.max(zInterval, extents[2] / zAllowed));
    }
    // Flat axes (a single collar line, a plan surface) take the largest suggested step rather than a sliver.
    for (const axis of [0, 1])
        if (extents[axis] === 0)
            spacing[axis] = spacing[2];
    return spacing;
}
