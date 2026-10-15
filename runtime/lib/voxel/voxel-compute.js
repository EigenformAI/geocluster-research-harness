// Runtime-owned deterministic module; baseline imported by scripts/vendor-voxel.mjs.
import { autoFrame, cellCount, pointCell, suggestSpacing, traverseSegment, validShape, validSpacing, VoxelGridError } from "./voxel-grid.js";
import { LENGTH_UNIT_METRES, LENGTH_UNIT_LABELS, VOXEL_SUGGESTED_CELLS, VOXEL_TIE_TOLERANCE, } from "./voxel-types.js";
import { MAX_CATEGORIES, MAX_CATEGORY_LABEL_UNITS, validCategoryLabel } from "./voxel-constraints.js";
const EXAMPLES = 8, ISSUES = 25;
const escapeRegExp = (text) => text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
/** Unicode code point order, independent of UTF-16 surrogate layout. */
export function compareCodePoints(a, b) {
    let i = 0, j = 0;
    while (i < a.length && j < b.length) {
        const x = a.codePointAt(i), y = b.codePointAt(j);
        if (x !== y)
            return x < y ? -1 : 1;
        i += x > 0xffff ? 2 : 1;
        j += y > 0xffff ? 2 : 1;
    }
    return (a.length - i) - (b.length - j) === 0 ? 0 : i >= a.length ? -1 : 1;
}
export function numberReader(policy) {
    const decimal = escapeRegExp(policy.decimal);
    const integer = policy.thousands === "none" ? "\\d+" : `(?:\\d{1,3}(?:${escapeRegExp(policy.thousands)}\\d{3})+|\\d+)`;
    const pattern = new RegExp(`^[+-]?(?:${integer}(?:${decimal}\\d*)?|${decimal}\\d+)(?:[eE][+-]?\\d+)?$`);
    const missing = new Set(policy.missingTokens.map((token) => token.trim()));
    const parse = (text) => {
        if (!pattern.test(text))
            return null;
        const plain = policy.thousands === "none" ? text : text.split(policy.thousands).join("");
        return Number(policy.decimal === "." ? plain : plain.replace(policy.decimal, "."));
    };
    /** Coordinates honour missing tokens and number format; sentinels and censoring apply to values and filters only. */
    return (cell, role) => {
        if (!cell || cell.cache === "missing" || cell.raw === null)
            return { ok: false, reason: "missing", text: "" };
        let value;
        const text = typeof cell.raw === "string" ? cell.raw.trim() : String(cell.raw);
        if (typeof cell.raw === "number")
            value = cell.raw;
        else {
            if (!text || missing.has(text))
                return { ok: false, reason: "missing", text };
            if (typeof cell.raw === "boolean")
                return { ok: false, reason: "unparseable", text };
            const censored = /^([<>])\s*(.+)$/.exec(text);
            if (censored) {
                const limit = parse(censored[2]);
                if (role === "coordinate" || limit === null || !Number.isFinite(limit))
                    return { ok: false, reason: "unparseable", text };
                if (policy.censored === "exclude" || (policy.censored === "half-limit" && censored[1] === ">"))
                    return { ok: false, reason: "censored", text };
                return { ok: true, value: policy.censored === "half-limit" ? limit / 2 : limit, substituted: true };
            }
            const parsed = parse(text);
            if (parsed === null)
                return { ok: false, reason: "unparseable", text };
            value = parsed;
        }
        if (!Number.isFinite(value))
            return { ok: false, reason: "nonfinite", text };
        if (role === "value" && policy.sentinels.includes(value))
            return { ok: false, reason: "sentinel", text };
        return { ok: true, value, substituted: false };
    };
}
function labelReader(policy) {
    const missing = new Set(policy.missingTokens.map((token) => token.trim()));
    return (cell, trim) => {
        if (!cell || cell.cache === "missing" || cell.raw === null)
            return { ok: false, text: "" };
        const text = typeof cell.raw === "boolean" ? (cell.raw ? "TRUE" : "FALSE") : String(cell.raw);
        // A whitespace-only cell has no label; "0" and other text are values unless declared missing.
        if (!text.trim() || missing.has(text.trim()))
            return { ok: false, text };
        return { ok: true, label: trim ? text.trim() : text };
    };
}
export function recipeColumns(recipe) {
    const columns = [recipe.value.column, ...recipe.predicates.map((predicate) => predicate.column)];
    const geometry = recipe.geometry;
    const of = (source) => source.type === "column" ? [source.column] : [];
    if (geometry.mode === "points")
        columns.push(geometry.x, geometry.y, geometry.z);
    else if (geometry.mode === "segments")
        columns.push(...geometry.start, ...geometry.end);
    else
        columns.push(...of(geometry.collarX), ...of(geometry.collarY), ...of(geometry.collarElevation), geometry.from, geometry.to, ...(geometry.holeId !== undefined ? [geometry.holeId] : []));
    return [...new Set(columns)];
}
/** Recipe-level assumptions recorded with every artifact. */
export function recipeAssumptions(recipe) {
    const assumptions = ["Binned observations — no interpolation. Empty cells remain empty; values are not estimated between observations."];
    const geometry = recipe.geometry;
    if (geometry.mode === "vertical-intervals") {
        assumptions.push(`Vertical holes: interval end elevations are collar elevation (${LENGTH_UNIT_LABELS[geometry.collarElevationUnit]}) minus depth (${LENGTH_UNIT_LABELS[geometry.depthUnit]}), after conversion to metres.`);
        for (const [name, source] of [["Collar X", geometry.collarX], ["Collar Y", geometry.collarY], ["Collar elevation", geometry.collarElevation]]) {
            if (source.type === "constant")
                assumptions.push(`${name} is the constant ${source.value} for every selected row.`);
        }
    }
    else if (geometry.zMeaning.type === "depth-below-plane") {
        assumptions.push(`Z values are depths below ${geometry.zMeaning.planeName || "a reference plane"} at elevation ${geometry.zMeaning.planeElevation} ${LENGTH_UNIT_LABELS[recipe.reference.verticalUnit]}.`);
    }
    if (geometry.mode === "segments")
        assumptions.push("Segments are straight between their supplied endpoints; no bends or downhole trajectory are inferred.");
    if (recipe.reference.horizontal.type === "local")
        assumptions.push(`Local coordinates (${recipe.reference.horizontal.name}); global placement unavailable.`);
    if (recipe.numbers.censored !== "exclude")
        assumptions.push(`Censored values are substituted with ${recipe.numbers.censored === "limit" ? "their limit" : "half their detection limit"}.`);
    return assumptions;
}
function zValue(z, meaning, unit) {
    return meaning.type === "elevation" ? z * unit : (meaning.planeElevation - z) * unit;
}
function emptyStatistics(rows) {
    return { rows, acceptedRows: 0, excludedRows: 0, exclusions: {}, secondaryExclusions: {}, occupiedCells: 0, valueRange: null,
        duplicatePositions: 0, categoryTies: 0, censoredSubstitutions: 0, formulaCacheValues: 0, clipping: null, bounds: null };
}
export function computeVoxels(input, recipe, options) {
    const statistics = emptyStatistics(input.rows.length);
    const result = { statistics, grid: null, field: null, suggestedSpacing: null, estimate: null, examples: [], issues: [], categories: [], warnings: [...input.warnings], errors: [], arrays: null };
    const { geometry, reference, value, numbers } = recipe;
    if (numbers.thousands !== "none" && numbers.thousands === numbers.decimal)
        result.errors.push("The decimal mark and thousands separator must differ.");
    if (reference.horizontal.type === "geographic" && !options.transforms.includes(`${reference.horizontal.crs}->${reference.horizontal.targetCrs}`)) {
        result.errors.push("Geographic coordinates need a coordinate transformation, which this service does not provide. Supply projected coordinates or a declared local grid.");
    }
    const position = new Map(input.columns.map((column, index) => [column, index]));
    const outside = recipeColumns(recipe).filter((column) => !position.has(column));
    if (outside.length)
        result.errors.push(`Column${outside.length > 1 ? "s" : ""} ${[...new Set(outside)].map((column) => column + 1).join(", ")} ${outside.length > 1 ? "are" : "is"} outside the selected range.`);
    if (!validSpacing(recipe.grid.spacing))
        result.errors.push("Cell sizes must be positive, finite numbers.");
    if (result.errors.length)
        return result;
    const readNumber = numberReader(numbers), readLabel = labelReader(numbers);
    const horizontal = LENGTH_UNIT_METRES[reference.horizontalUnit], vertical = LENGTH_UNIT_METRES[reference.verticalUnit];
    const exclusions = statistics.exclusions, secondary = statistics.secondaryExclusions;
    const exclude = (row, reasons) => {
        const [[primary, detail], ...rest] = reasons;
        exclusions[primary] = (exclusions[primary] ?? 0) + 1;
        for (const [reason] of rest)
            secondary[reason] = (secondary[reason] ?? 0) + 1;
        statistics.excludedRows++;
        if (result.issues.length < ISSUES)
            result.issues.push({ row, reason: primary, detail });
    };
    const observations = [];
    let formulaValues = 0;
    for (const source of input.rows) {
        const cell = (column) => source.cells[position.get(column)];
        const reasons = [];
        let operand = false, filtered = false;
        for (const predicate of recipe.predicates) {
            if (predicate.type === "equals") {
                const label = readLabel(cell(predicate.column), predicate.trim);
                if (!label.ok)
                    operand = true;
                else if (label.label !== (predicate.trim ? predicate.value.trim() : predicate.value))
                    filtered = true;
            }
            else {
                const reading = readNumber(cell(predicate.column), "value");
                if (!reading.ok)
                    operand = true;
                else if ((predicate.min !== null && reading.value < predicate.min) || (predicate.max !== null && reading.value > predicate.max))
                    filtered = true;
            }
        }
        if (operand)
            reasons.push(["predicate-operand", "A row filter's value is missing or not a number."]);
        else if (filtered)
            reasons.push(["filtered", "Did not match the row filters."]);
        let observed = null, substituted = false;
        const valueCell = cell(value.column);
        if (value.kind === "numeric") {
            const reading = readNumber(valueCell, "value");
            if (reading.ok) {
                observed = reading.value;
                substituted = reading.substituted;
            }
            else
                reasons.push([`value-${reading.reason}`, reading.text ? `Value "${reading.text}"` : "Value is blank."]);
        }
        else {
            const label = readLabel(valueCell, value.trim);
            if (label.ok)
                observed = label.label;
            else
                reasons.push(["value-missing", label.text ? `Value "${label.text}" is a declared missing token.` : "Value is blank."]);
        }
        const coordinate = (column, name) => {
            const reading = readNumber(cell(column), "coordinate");
            if (reading.ok)
                return reading.value;
            if (!reasons.some(([reason]) => reason.startsWith("geometry"))) {
                reasons.push(reading.reason === "missing" ? ["geometry-missing", `${name} is blank.`] : ["geometry-unparseable", `${name} "${reading.text}" is not a number.`]);
            }
            return null;
        };
        const either = (source, name) => source.type === "constant" ? source.value : coordinate(source.column, name);
        let positions = null;
        if (geometry.mode === "points") {
            const [x, y, z] = [coordinate(geometry.x, "X"), coordinate(geometry.y, "Y"), coordinate(geometry.z, "Z")];
            if (x !== null && y !== null && z !== null)
                positions = [[x * horizontal, y * horizontal, zValue(z, geometry.zMeaning, vertical)]];
        }
        else if (geometry.mode === "segments") {
            const values = [...geometry.start, ...geometry.end].map((column, index) => coordinate(column, ["Start X", "Start Y", "Start Z", "End X", "End Y", "End Z"][index]));
            if (values.every((item) => item !== null)) {
                const [x0, y0, z0, x1, y1, z1] = values;
                positions = [[x0 * horizontal, y0 * horizontal, zValue(z0, geometry.zMeaning, vertical)], [x1 * horizontal, y1 * horizontal, zValue(z1, geometry.zMeaning, vertical)]];
            }
        }
        else {
            const [x, y, elevation, from, to] = [either(geometry.collarX, "Collar X"), either(geometry.collarY, "Collar Y"), either(geometry.collarElevation, "Collar elevation"), coordinate(geometry.from, "From depth"), coordinate(geometry.to, "To depth")];
            if (x !== null && y !== null && elevation !== null && from !== null && to !== null) {
                if (from < 0 || to < 0 || !(to > from))
                    reasons.push(["interval-invalid", `From ${from}, To ${to}: depths must be nonnegative and To must exceed From.`]);
                else {
                    const collar = elevation * LENGTH_UNIT_METRES[geometry.collarElevationUnit], depth = LENGTH_UNIT_METRES[geometry.depthUnit];
                    positions = [[x * horizontal, y * horizontal, collar - from * depth], [x * horizontal, y * horizontal, collar - to * depth]];
                }
            }
        }
        if (positions?.length === 2 && positions[0].every((component, axis) => component === positions[1][axis])) {
            reasons.push(["segment-zero-length", "Start and end are identical; map it as a point instead."]);
            positions = null;
        }
        if (reasons.length) {
            exclude(source.row, reasons);
            continue;
        }
        if (substituted)
            statistics.censoredSubstitutions++;
        if (valueCell && valueCell.formula !== null)
            formulaValues++;
        observations.push({ row: source.row, value: observed, positions: positions });
    }
    statistics.formulaCacheValues = formulaValues;
    if (!observations.length) {
        result.errors.push("No rows were accepted. Review the exclusions and mappings.");
        return result;
    }
    // A constant collar is valid only for one hole; with a hole column mapped, stacking is detectable.
    if (geometry.mode === "vertical-intervals" && !geometry.sharedCollar && geometry.holeId !== undefined &&
        geometry.collarX.type === "constant" && geometry.collarY.type === "constant" && geometry.collarElevation.type === "constant") {
        const rowCells = new Map(input.rows.map((source) => [source.row, source.cells]));
        const holes = new Map();
        for (const observation of observations) {
            const cell = rowCells.get(observation.row)?.[position.get(geometry.holeId)];
            const label = cell && cell.raw !== null && typeof cell.raw !== "boolean" ? String(cell.raw).trim() : "";
            if (label && !holes.has(label))
                holes.set(label, observation.row);
        }
        if (holes.size > 1) {
            const examples = [...holes.entries()].slice(0, 3).map(([label, row]) => `${label} (row ${row + 1})`).join(", ");
            result.errors.push(`The accepted rows span ${holes.size} distinct hole IDs (${examples}${holes.size > 3 ? ", …" : ""}), but the collar is one constant position, so their intervals would stack in a single column. Map per-row collar columns, or confirm in step 2 that all rows are one hole.`);
            return result;
        }
    }
    const min = [Infinity, Infinity, Infinity], max = [-Infinity, -Infinity, -Infinity];
    for (const observation of observations)
        for (const point of observation.positions) {
            for (let axis = 0; axis < 3; axis++) {
                min[axis] = Math.min(min[axis], point[axis]);
                max[axis] = Math.max(max[axis], point[axis]);
            }
        }
    statistics.bounds = { min, max };
    // Vertical cell sizes below the typical interval length slice observations into noise.
    const intervalLengths = observations.filter((observation) => observation.positions.length === 2)
        .map((observation) => Math.abs(observation.positions[1][2] - observation.positions[0][2])).sort((a, b) => a - b);
    const medianInterval = intervalLengths.length ? intervalLengths[Math.floor(intervalLengths.length / 2)] : null;
    result.suggestedSpacing = suggestSpacing(statistics.bounds, VOXEL_SUGGESTED_CELLS, medianInterval !== null && medianInterval > 0 ? medianInterval : undefined);
    const extent = recipe.grid.extent;
    let frame;
    try {
        if (extent.type === "auto")
            frame = autoFrame(statistics.bounds, recipe.grid.spacing);
        else {
            if (!extent.origin.every(Number.isFinite) || !validShape(extent.shape)) {
                result.errors.push("A custom extent needs a finite origin and a shape of positive whole numbers.");
                return result;
            }
            frame = { origin: [...extent.origin], shape: [...extent.shape], spacing: [...recipe.grid.spacing] };
        }
    }
    catch (error) {
        if (error instanceof VoxelGridError) {
            result.errors.push(error.message);
            return result;
        }
        throw error;
    }
    const cells = cellCount(frame.shape);
    const segments = geometry.mode !== "points";
    const numeric = value.kind === "numeric";
    result.grid = {
        shape: frame.shape, origin: frame.origin, spacing: frame.spacing, axes: "easting,northing,elevation", order: "C-z-fastest", unit: "m",
        horizontalReference: reference.horizontal.type === "local" ? { type: "local", definition: reference.horizontal.name }
            : { type: "crs", definition: reference.horizontal.type === "geographic" ? reference.horizontal.targetCrs : reference.horizontal.crs },
        verticalReference: reference.verticalReference,
    };
    const valueBytes = numeric ? 8 : 4;
    const arrayBytes = cells * (valueBytes + 1 + 4 + (segments ? 8 : 0));
    result.estimate = { cells, arrayBytes, computeBytes: arrayBytes + observations.length * 64, displayBytes: 0 };
    if (!Number.isSafeInteger(cells) || cells > options.limits.cells) {
        result.errors.push(`The grid has ${cells.toLocaleString("en")} cells, above this service's limit of ${options.limits.cells.toLocaleString("en")}. Use larger cells or a smaller extent.`);
        return result;
    }
    if (segments) {
        let work = 0;
        for (const observation of observations)
            for (let axis = 0; axis < 3; axis++)
                work += Math.abs(observation.positions[1][axis] - observation.positions[0][axis]) / frame.spacing[axis] + 1;
        if (work > options.limits.pieces) {
            result.errors.push(`The segments cross about ${Math.round(work).toLocaleString("en")} cell boundaries, above this service's work limit of ${options.limits.pieces.toLocaleString("en")}. Use larger cells or a smaller custom extent.`);
            return result;
        }
    }
    const clipping = { outsidePoints: 0, fullyOutsideSegments: 0, partiallyClippedSegments: 0, retainedLength: 0, removedLength: 0 };
    const accumulators = new Map();
    const checkLabel = (observation) => {
        if (numeric || validCategoryLabel(observation.value)) return true;
        const detail = `Category label in source row ${observation.row + 1} must be nonempty and at most ${MAX_CATEGORY_LABEL_UNITS} UTF-16 code units (${observation.value.length} supplied).`;
        result.errors.push(detail); result.issues.push({ row: observation.row, reason: "category-label", detail }); return false;
    };
    const add = (cell, amount, observation) => {
        let accumulator = accumulators.get(cell);
        if (!accumulator)
            accumulators.set(cell, accumulator = { count: 0, sum: 0, weight: 0, min: Infinity, max: -Infinity, labels: numeric ? null : new Map() });
        accumulator.count++;
        accumulator.weight += amount;
        if (typeof observation.value === "number") {
            accumulator.sum += observation.value * amount;
            accumulator.min = Math.min(accumulator.min, observation.value);
            accumulator.max = Math.max(accumulator.max, observation.value);
        }
        else
            accumulator.labels.set(observation.value, (accumulator.labels.get(observation.value) ?? 0) + amount);
    };
    const seen = new Set();
    try {
        for (const observation of observations) {
            let clipped = false;
            if (!segments) {
                const cell = pointCell(frame, observation.positions[0]);
                if (cell === null) {
                    clipping.outsidePoints++;
                    exclude(observation.row, [["outside-extent", "Point lies outside the confirmed extent."]]);
                    continue;
                }
                const key = observation.positions[0].join(",");
                if (!checkLabel(observation)) return result;
                if (seen.has(key))
                    statistics.duplicatePositions++;
                seen.add(key);
                add(cell, 1, observation);
            }
            else {
                const traversal = traverseSegment(frame, observation.positions[0], observation.positions[1]);
                if (!traversal) {
                    clipping.fullyOutsideSegments++;
                    exclude(observation.row, [["outside-extent", "Segment has no length inside the confirmed extent."]]);
                    continue;
                }
                if (!checkLabel(observation)) return result;
                if (traversal.clipped) {
                    clipped = true;
                    clipping.partiallyClippedSegments++;
                    clipping.retainedLength += traversal.retainedLength;
                    clipping.removedLength += traversal.totalLength - traversal.retainedLength;
                }
                for (const piece of traversal.pieces)
                    add(piece.cell, piece.length, observation);
            }
            statistics.acceptedRows++;
            if (result.examples.length < EXAMPLES)
                result.examples.push({ row: observation.row, positions: observation.positions, value: observation.value, clipped });
        }
    }
    catch (error) {
        if (error instanceof VoxelGridError) {
            result.errors.push(error.message);
            return result;
        }
        throw error;
    }
    if (extent.type === "custom") {
        statistics.clipping = clipping;
        const affected = clipping.outsidePoints + clipping.fullyOutsideSegments + clipping.partiallyClippedSegments;
        if (affected && !extent.acceptClipping)
            result.errors.push("The custom extent excludes or clips rows. Review the counts and confirm the extent to continue.");
    }
    const labels = new Set();
    for (const accumulator of accumulators.values())
        for (const label of accumulator.labels?.keys() ?? [])
            labels.add(label);
    const categories = [...labels].sort(compareCodePoints);
    const categoryLimit = Math.min(options.limits.categories, MAX_CATEGORIES);
    if (categories.length > categoryLimit)
        result.errors.push(`${categories.length} categories exceed this service's limit of ${categoryLimit}.`);
    const codes = new Map(categories.map((label, code) => [label, code]));
    result.categories = categories;
    result.field = numeric ? { kind: "numeric", name: value.name, unit: value.unit } : categories.length ? { kind: "categorical", name: value.name, unit: "", categories: categories.map((label, code) => ({ code, label })) } : null;
    const cellsOut = new Map();
    let low = Infinity, high = -Infinity;
    for (const [cell, accumulator] of accumulators) {
        let cellValue;
        if (numeric) {
            const aggregation = value.aggregation;
            cellValue = aggregation === "min" ? accumulator.min : aggregation === "max" ? accumulator.max : accumulator.sum / accumulator.weight;
            if (!Number.isFinite(cellValue)) {
                result.errors.push("Aggregation produced a non-finite value (overflow). No empty cell is substituted.");
                break;
            }
            low = Math.min(low, cellValue);
            high = Math.max(high, cellValue);
        }
        else {
            let best = -1, amount = -Infinity, tied = false;
            for (const [label, total] of accumulator.labels) {
                const code = codes.get(label);
                const tie = best >= 0 && Math.abs(total - amount) <= VOXEL_TIE_TOLERANCE * Math.max(Math.abs(total), Math.abs(amount));
                if (tie) {
                    tied = true;
                    best = Math.min(best, code);
                    amount = Math.max(amount, total);
                }
                else if (total > amount) {
                    best = code;
                    amount = total;
                    tied = false;
                }
            }
            if (tied)
                statistics.categoryTies++;
            cellValue = best;
        }
        if (accumulator.count > 0xffffffff) {
            result.errors.push("A cell has more contributors than a uint32 count can hold.");
            break;
        }
        cellsOut.set(cell, cellValue);
    }
    statistics.occupiedCells = accumulators.size;
    statistics.valueRange = numeric && accumulators.size ? { min: low, max: high } : null;
    if (!accumulators.size && !result.errors.length)
        result.errors.push("No cells are occupied. Review the extent and exclusions.");
    // Sparse float64 accumulators and one instance matrix, color and cell index per drawn cell.
    result.estimate = { cells, arrayBytes, computeBytes: arrayBytes + accumulators.size * 48 + observations.length * 64, displayBytes: accumulators.size * 80 };
    if (statistics.duplicatePositions)
        result.warnings.push(`${statistics.duplicatePositions} rows share an exact position with an earlier row; each is kept as a separate observation.`);
    if (formulaValues)
        result.warnings.push(`${formulaValues} values come from stored formula results; formulas were not recalculated.`);
    if (statistics.categoryTies)
        result.warnings.push(`${statistics.categoryTies} cells had tied categories; the lowest category code was used.`);
    if (statistics.censoredSubstitutions)
        result.warnings.push(`${statistics.censoredSubstitutions} censored values were substituted (${numbers.censored === "limit" ? "limit" : "half the limit"}).`);
    if (clipping.partiallyClippedSegments)
        result.warnings.push(`${clipping.partiallyClippedSegments} segments cross the extent boundary; only their retained length contributes.`);
    if (options.materialize && !result.errors.length) {
        const values = numeric ? new Float64Array(cells) : new Uint32Array(cells);
        const valid = new Uint8Array(cells), counts = new Uint32Array(cells), weights = segments ? new Float64Array(cells) : null;
        for (const [cell, accumulator] of accumulators) {
            values[cell] = cellsOut.get(cell);
            valid[cell] = 1;
            counts[cell] = accumulator.count;
            if (weights)
                weights[cell] = accumulator.weight;
        }
        result.arrays = { values, valid, counts, weights };
    }
    return result;
}
