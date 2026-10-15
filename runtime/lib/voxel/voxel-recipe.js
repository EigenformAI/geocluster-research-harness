// Runtime-owned deterministic module; indexed extensions are maintained here.
import { VOXEL_ALGORITHM, } from "./voxel-types.js";
import { validatePredecessor } from "./voxel-constraints.js";
/**
 * Strict structural validation for recipes crossing a trust boundary: request
 * bodies, stored operations, and manifests used to seed a new draft. Unknown
 * keys are rejected so a recipe means exactly what its fields say.
 */
export class VoxelRecipeError extends Error {
}
const fail = (message) => { throw new VoxelRecipeError(message); };
function record(value, required, optional = [], name = "value") {
    if (value === null || typeof value !== "object" || Array.isArray(value))
        fail(`${name} must be an object.`);
    const object = value;
    for (const key of required)
        if (!Object.hasOwn(object, key))
            fail(`${name}.${key} is required.`);
    for (const key of Object.keys(object))
        if (!required.includes(key) && !optional.includes(key))
            fail(`${name}.${key} is not a recognized field.`);
    return object;
}
const text = (value, max, name, empty = false) => typeof value === "string" && value.length <= max && (empty || value.trim().length > 0) && !value.includes("\0") ? value : fail(`${name} must be text up to ${max} characters.`);
const finite = (value, name) => typeof value === "number" && Number.isFinite(value) ? value : fail(`${name} must be a finite number.`);
const integer = (value, name, min = 0) => typeof value === "number" && Number.isSafeInteger(value) && value >= min ? value : fail(`${name} must be a whole number of at least ${min}.`);
const oneOf = (value, values, name) => values.includes(value) ? value : fail(`${name} must be one of ${values.join(", ")}.`);
const bool = (value, name) => typeof value === "boolean" ? value : fail(`${name} must be true or false.`);
const vec3 = (value, name, check = finite) => Array.isArray(value) && value.length === 3 ? value.map((item, index) => check(item, `${name}[${index}]`)) : fail(`${name} must have three values.`);
const units = ["m", "ft", "us-ft"];
export function validateSourceRevision(value, name = "source") {
    const source = record(value, ["resourceId", "root", "path", "sha256", "revision"], [], name);
    if (typeof source.sha256 !== "string" || !/^[0-9a-f]{64}$/.test(source.sha256))
        fail(`${name}.sha256 must be a SHA-256 hex digest.`);
    return { resourceId: text(source.resourceId, 4096, `${name}.resourceId`), root: oneOf(source.root, ["source", "eda", "workspace"], `${name}.root`),
        path: text(source.path, 4096, `${name}.path`), sha256: source.sha256, revision: text(source.revision, 256, `${name}.revision`) };
}
function input(value) {
    const shape = record(value, ["type", "resourceId", "source"], ["workbookId", "sheet", "delimiter"], "scope.input");
    const common = { resourceId: text(shape.resourceId, 4096, "scope.input.resourceId"), source: validateSourceRevision(shape.source, "scope.input.source") };
    if (shape.type === "workbook") {
        record(value, ["type", "resourceId", "source", "workbookId", "sheet"], [], "scope.input");
        return { type: "workbook", ...common, workbookId: text(shape.workbookId, 128, "scope.input.workbookId"), sheet: text(shape.sheet, 128, "scope.input.sheet") };
    }
    record(value, ["type", "resourceId", "source", "delimiter"], [], "scope.input");
    if (shape.type !== "delimited")
        fail("scope.input.type must be workbook or delimited.");
    return { type: "delimited", ...common, delimiter: oneOf(shape.delimiter, [",", "\t"], "scope.input.delimiter") };
}
function columnOrConstant(value, name) {
    const shape = record(value, ["type"], ["column", "value"], name);
    if (shape.type === "column") {
        record(value, ["type", "column"], [], name);
        return { type: "column", column: integer(shape.column, `${name}.column`) };
    }
    record(value, ["type", "value"], [], name);
    if (shape.type !== "constant")
        fail(`${name}.type must be column or constant.`);
    return { type: "constant", value: finite(shape.value, `${name}.value`) };
}
function zMeaning(value) {
    const shape = record(value, ["type"], ["planeName", "planeElevation"], "geometry.zMeaning");
    if (shape.type === "elevation") {
        record(value, ["type"], [], "geometry.zMeaning");
        return { type: "elevation" };
    }
    record(value, ["type", "planeName", "planeElevation"], [], "geometry.zMeaning");
    if (shape.type !== "depth-below-plane")
        fail("geometry.zMeaning.type must be elevation or depth-below-plane.");
    return { type: "depth-below-plane", planeName: text(shape.planeName, 256, "geometry.zMeaning.planeName"), planeElevation: finite(shape.planeElevation, "geometry.zMeaning.planeElevation") };
}
function predicate(value, name) {
    const shape = record(value, ["type", "column"], ["value", "trim", "min", "max"], name);
    const column = integer(shape.column, `${name}.column`);
    if (shape.type === "equals") {
        record(value, ["type", "column", "value", "trim"], [], name);
        return { type: "equals", column, value: text(shape.value, 1024, `${name}.value`, true), trim: bool(shape.trim, `${name}.trim`) };
    }
    record(value, ["type", "column", "min", "max"], [], name);
    if (shape.type !== "range")
        fail(`${name}.type must be equals or range.`);
    const bound = (item, key) => item === null ? null : finite(item, `${name}.${key}`);
    const min = bound(shape.min, "min"), max = bound(shape.max, "max");
    if (min === null && max === null)
        fail(`${name} needs a minimum or maximum.`);
    if (min !== null && max !== null && min > max)
        fail(`${name} minimum exceeds its maximum.`);
    return { type: "range", column, min, max };
}
export function validateRecipe(value) {
    if (value?.algorithm === "geocluster-indexed-v1")
        return validateIndexedRecipe(value);
    const shape = record(value, ["schemaVersion", "algorithm", "name", "scope", "geometry", "reference", "value", "numbers", "predicates", "grid", "predecessor"], [], "recipe");
    if (shape.schemaVersion !== 1)
        fail("recipe.schemaVersion must be 1.");
    if (shape.algorithm !== VOXEL_ALGORITHM)
        fail(`recipe.algorithm must be ${VOXEL_ALGORITHM}.`);
    const scope = record(shape.scope, ["input", "range", "headerRows"], [], "scope");
    const range = record(scope.range, ["rowStart", "rowEnd", "columnStart", "columnEnd"], [], "scope.range");
    const rowStart = integer(range.rowStart, "scope.range.rowStart"), columnStart = integer(range.columnStart, "scope.range.columnStart");
    const rowEnd = integer(range.rowEnd, "scope.range.rowEnd", rowStart), columnEnd = integer(range.columnEnd, "scope.range.columnEnd", columnStart);
    if (!Array.isArray(scope.headerRows) || scope.headerRows.length > 32)
        fail("scope.headerRows must list up to 32 rows.");
    const headerRows = scope.headerRows.map((row, index) => integer(row, `scope.headerRows[${index}]`));
    if (new Set(headerRows).size !== headerRows.length)
        fail("scope.headerRows must not repeat a row.");
    const geometry = record(shape.geometry, ["mode"], ["x", "y", "z", "zMeaning", "start", "end", "collarX", "collarY", "collarElevation", "from", "to", "depthUnit", "collarElevationUnit", "holeId", "sharedCollar"], "geometry");
    const column = (item, name) => integer(item, name);
    let parsedGeometry;
    if (geometry.mode === "points") {
        record(shape.geometry, ["mode", "x", "y", "z", "zMeaning"], [], "geometry");
        parsedGeometry = { mode: "points", x: column(geometry.x, "geometry.x"), y: column(geometry.y, "geometry.y"), z: column(geometry.z, "geometry.z"), zMeaning: zMeaning(geometry.zMeaning) };
    }
    else if (geometry.mode === "segments") {
        record(shape.geometry, ["mode", "start", "end", "zMeaning"], [], "geometry");
        parsedGeometry = { mode: "segments", start: vec3(geometry.start, "geometry.start", column), end: vec3(geometry.end, "geometry.end", column), zMeaning: zMeaning(geometry.zMeaning) };
    }
    else if (geometry.mode === "vertical-intervals") {
        record(shape.geometry, ["mode", "collarX", "collarY", "collarElevation", "from", "to", "depthUnit", "collarElevationUnit"], ["holeId", "sharedCollar"], "geometry");
        parsedGeometry = { mode: "vertical-intervals", collarX: columnOrConstant(geometry.collarX, "geometry.collarX"), collarY: columnOrConstant(geometry.collarY, "geometry.collarY"),
            collarElevation: columnOrConstant(geometry.collarElevation, "geometry.collarElevation"), from: column(geometry.from, "geometry.from"), to: column(geometry.to, "geometry.to"),
            depthUnit: oneOf(geometry.depthUnit, units, "geometry.depthUnit"), collarElevationUnit: oneOf(geometry.collarElevationUnit, units, "geometry.collarElevationUnit"),
            ...(geometry.holeId !== undefined ? { holeId: column(geometry.holeId, "geometry.holeId") } : {}),
            ...(geometry.sharedCollar !== undefined ? { sharedCollar: bool(geometry.sharedCollar, "geometry.sharedCollar") } : {}) };
    }
    else
        return fail("geometry.mode must be points, segments, or vertical-intervals.");
    const reference = record(shape.reference, ["horizontal", "horizontalUnit", "verticalUnit", "verticalReference"], [], "reference");
    const horizontal = record(reference.horizontal, ["type"], ["crs", "name", "targetCrs"], "reference.horizontal");
    let parsedHorizontal;
    if (horizontal.type === "crs") {
        record(reference.horizontal, ["type", "crs"], [], "reference.horizontal");
        parsedHorizontal = { type: "crs", crs: text(horizontal.crs, 256, "reference.horizontal.crs") };
    }
    else if (horizontal.type === "local") {
        record(reference.horizontal, ["type", "name"], [], "reference.horizontal");
        parsedHorizontal = { type: "local", name: text(horizontal.name, 256, "reference.horizontal.name") };
    }
    else if (horizontal.type === "geographic") {
        record(reference.horizontal, ["type", "crs", "targetCrs"], [], "reference.horizontal");
        parsedHorizontal = { type: "geographic", crs: text(horizontal.crs, 256, "reference.horizontal.crs"), targetCrs: text(horizontal.targetCrs, 256, "reference.horizontal.targetCrs") };
    }
    else
        return fail("reference.horizontal.type must be crs, local, or geographic.");
    const valueShape = record(shape.value, ["kind", "column", "name"], ["unit", "aggregation", "trim"], "value");
    const parsedValue = valueShape.kind === "numeric"
        ? (record(shape.value, ["kind", "column", "name", "unit", "aggregation"], [], "value"), { kind: "numeric", column: integer(valueShape.column, "value.column"), name: text(valueShape.name, 256, "value.name"),
            unit: text(valueShape.unit, 64, "value.unit", true), aggregation: oneOf(valueShape.aggregation, ["mean", "min", "max"], "value.aggregation") })
        : valueShape.kind === "categorical"
            ? (record(shape.value, ["kind", "column", "name", "trim"], [], "value"), { kind: "categorical", column: integer(valueShape.column, "value.column"), name: text(valueShape.name, 256, "value.name"), trim: bool(valueShape.trim, "value.trim") })
            : fail("value.kind must be numeric or categorical.");
    const numbers = record(shape.numbers, ["decimal", "thousands", "missingTokens", "sentinels", "censored"], [], "numbers");
    const list = (item, name, max, parse) => Array.isArray(item) && item.length <= max ? item.map((entry, index) => parse(entry, `${name}[${index}]`)) : fail(`${name} must list up to ${max} values.`);
    const decimal = oneOf(numbers.decimal, [".", ","], "numbers.decimal"), thousands = oneOf(numbers.thousands, ["none", ",", ".", " ", "'"], "numbers.thousands");
    if (decimal === thousands)
        fail("The decimal mark and thousands separator must differ.");
    const grid = record(shape.grid, ["spacing", "extent"], [], "grid");
    const spacing = vec3(grid.spacing, "grid.spacing");
    if (!spacing.every((size) => size > 0))
        fail("Cell sizes must be positive.");
    const extent = record(grid.extent, ["type"], ["origin", "shape", "acceptClipping"], "grid.extent");
    const parsedExtent = extent.type === "auto" ? (record(grid.extent, ["type"], [], "grid.extent"), { type: "auto" })
        : extent.type === "custom" ? (record(grid.extent, ["type", "origin", "shape", "acceptClipping"], [], "grid.extent"),
            { type: "custom", origin: vec3(extent.origin, "grid.extent.origin"), shape: vec3(extent.shape, "grid.extent.shape", (item, name) => integer(item, name, 1)), acceptClipping: bool(extent.acceptClipping, "grid.extent.acceptClipping") })
            : fail("grid.extent.type must be auto or custom.");
    return {
        schemaVersion: 1, algorithm: VOXEL_ALGORITHM, name: text(shape.name, 256, "recipe.name"),
        scope: { input: input(scope.input), range: { rowStart, rowEnd, columnStart, columnEnd }, headerRows },
        geometry: parsedGeometry,
        reference: { horizontal: parsedHorizontal, horizontalUnit: oneOf(reference.horizontalUnit, units, "reference.horizontalUnit"), verticalUnit: oneOf(reference.verticalUnit, units, "reference.verticalUnit"),
            verticalReference: text(reference.verticalReference, 256, "reference.verticalReference") },
        value: parsedValue,
        numbers: { decimal, thousands, missingTokens: list(numbers.missingTokens, "numbers.missingTokens", 32, (item, name) => text(item, 64, name)),
            sentinels: list(numbers.sentinels, "numbers.sentinels", 32, finite), censored: oneOf(numbers.censored, ["exclude", "limit", "half-limit"], "numbers.censored") },
        predicates: list(shape.predicates, "predicates", 16, predicate),
        grid: { spacing, extent: parsedExtent },
        predecessor: predecessor(shape.predecessor),
    };
}
function predecessor(value) {
    return validatePredecessor(value, fail);
}
export function validateHorizontalReference(value, name = "horizontalReference") {
    const shape = record(value, ["type", "definition"], [], name);
    if (shape.type === "unreferenced") {
        if (shape.definition !== "")
            fail(`${name}.definition must be empty for unreferenced volumes.`);
        return { type: "unreferenced", definition: "" };
    }
    return { type: oneOf(shape.type, ["crs", "local"], `${name}.type`), definition: text(shape.definition, 256, `${name}.definition`) };
}
export function validateSpatialMetadata(value) {
    const shape = record(value, ["axisOrder", "reversed", "indexOrigin", "spacing", "unit", "horizontalReference", "verticalReference", "fieldName", "fieldUnit", "sentinel"], [], "metadata");
    const axisOrder = vec3(shape.axisOrder, "metadata.axisOrder", (item, name) => integer(item, name));
    if ([...axisOrder].sort().join() !== "0,1,2")
        fail("metadata.axisOrder must map each array axis exactly once.");
    const reversed = Array.isArray(shape.reversed) && shape.reversed.length === 3 ? shape.reversed.map((item, index) => bool(item, `metadata.reversed[${index}]`)) : fail("metadata.reversed must have three values.");
    const spacing = vec3(shape.spacing, "metadata.spacing");
    if (!spacing.every((size) => size > 0))
        fail("Cell sizes must be positive.");
    return {
        axisOrder, reversed, indexOrigin: vec3(shape.indexOrigin, "metadata.indexOrigin"), spacing,
        unit: oneOf(shape.unit, ["m", "ft", "grid-unit"], "metadata.unit"),
        horizontalReference: validateHorizontalReference(shape.horizontalReference, "metadata.horizontalReference"),
        verticalReference: shape.verticalReference === null ? null : text(shape.verticalReference, 256, "metadata.verticalReference"),
        fieldName: text(shape.fieldName, 256, "metadata.fieldName"), fieldUnit: text(shape.fieldUnit, 64, "metadata.fieldUnit", true),
        sentinel: shape.sentinel === null ? null : finite(shape.sentinel, "metadata.sentinel"),
    };
}
export const METADATA_FIELDS = ["axisOrder", "reversed", "indexOrigin", "spacing", "unit", "horizontalReference", "verticalReference", "fieldName", "fieldUnit", "sentinel"];
export function validateImportRecipe(value) {
    const shape = record(value, ["schemaVersion", "source", "metadata", "defaults", "predecessor"], [], "recipe");
    if (shape.schemaVersion !== 1)
        fail("recipe.schemaVersion must be 1.");
    const defaults = Array.isArray(shape.defaults) ? shape.defaults.map((item, index) => oneOf(item, METADATA_FIELDS, `recipe.defaults[${index}]`)) : fail("recipe.defaults must list field names.");
    if (new Set(defaults).size !== defaults.length)
        fail("recipe.defaults must not repeat a field.");
    return { schemaVersion: 1, source: validateSourceRevision(shape.source, "recipe.source"), metadata: validateSpatialMetadata(shape.metadata), defaults, predecessor: predecessor(shape.predecessor) };
}
export function validateSubmission(value) {
    const shape = record(value, ["kind", "recipe"], ["revision"], "submission");
    const revision = Object.hasOwn(shape, "revision") ? { revision: validateRevisionTarget(shape.revision) } : {};
    if (shape.kind === "table-to-voxel")
        return { kind: "table-to-voxel", recipe: validateObservationRecipe(shape.recipe), ...revision };
    if (shape.kind === "import-metadata")
        return { kind: "import-metadata", recipe: validateImportRecipe(shape.recipe), ...revision };
    if (shape.kind === "indexed-grid")
        return { kind: "indexed-grid", recipe: validateIndexedRecipe(shape.recipe), ...revision };
    return fail("submission.kind must be table-to-voxel, import-metadata, or indexed-grid.");
}
export function validateObservationRecipe(value) {
    if (value?.algorithm !== VOXEL_ALGORITHM) fail(`recipe.algorithm must be ${VOXEL_ALGORITHM}.`);
    return validateRecipe(value);
}
export function validateRevisionTarget(value) {
    if (value === null) return null;
    const shape = record(value, ["voxelId", "expectedHeadRevision", "base"], [], "revision");
    const base = record(shape.base, ["artifactId", "generation", "manifest"], [], "revision.base");
    if (!/^vox-[A-Za-z0-9-]{1,120}$/.test(base.artifactId)) fail("revision.base.artifactId must identify a voxel artifact.");
    if (typeof base.generation !== "string" || !/^[0-9a-f]{64}$/.test(base.generation)) fail("revision.base.generation must be a SHA-256 digest.");
    return { voxelId: text(shape.voxelId, 128, "revision.voxelId"), expectedHeadRevision: text(shape.expectedHeadRevision, 256, "revision.expectedHeadRevision"),
        base: { artifactId: base.artifactId, generation: base.generation, manifest: validateSourceRevision(base.manifest, "revision.base.manifest") } };
}
export function validateScope(value) {
    const scope = record(value, ["input", "range", "headerRows"], [], "scope");
    const range = record(scope.range, ["rowStart", "rowEnd", "columnStart", "columnEnd"], [], "scope.range");
    const rowStart = integer(range.rowStart, "scope.range.rowStart"), columnStart = integer(range.columnStart, "scope.range.columnStart");
    const rowEnd = integer(range.rowEnd, "scope.range.rowEnd", rowStart), columnEnd = integer(range.columnEnd, "scope.range.columnEnd", columnStart);
    if (!Array.isArray(scope.headerRows) || scope.headerRows.length > 32) fail("scope.headerRows must list up to 32 rows.");
    const headerRows = scope.headerRows.map((v, n) => integer(v, `scope.headerRows[${n}]`));
    if (new Set(headerRows).size !== headerRows.length) fail("scope.headerRows must not repeat a row.");
    const parsedInput = input(scope.input);
    if (parsedInput.resourceId !== parsedInput.source.resourceId) fail("scope.input.resourceId must match its source.");
    return { input: parsedInput, range: { rowStart, rowEnd, columnStart, columnEnd }, headerRows };
}
export function validateNumberPolicy(value) {
    const shape = record(value, ["decimal", "thousands", "missingTokens", "sentinels", "censored"], [], "numbers");
    const decimal = oneOf(shape.decimal, [".", ","], "numbers.decimal"), thousands = oneOf(shape.thousands, ["none", ",", ".", " ", "'"], "numbers.thousands");
    if (decimal === thousands) fail("The decimal mark and thousands separator must differ.");
    const list = (v, name, parse) => Array.isArray(v) && v.length <= 32 ? v.map((item, n) => parse(item, `${name}[${n}]`)) : fail(`${name} must list up to 32 values.`);
    return { decimal, thousands, missingTokens: list(shape.missingTokens, "numbers.missingTokens", (v, name) => text(v, 64, name)),
        sentinels: list(shape.sentinels, "numbers.sentinels", finite), censored: oneOf(shape.censored, ["exclude", "limit", "half-limit"], "numbers.censored") };
}
export function validateIndices(value) {
    const shape = record(value, ["x", "y", "z", "base"], [], "indices");
    return { x: integer(shape.x, "indices.x"), y: integer(shape.y, "indices.y"), z: integer(shape.z, "indices.z"), base: oneOf(shape.base, [0, 1], "indices.base") };
}
export function validateIndexedRecipe(value) {
    const shape = record(value, ["schemaVersion", "algorithm", "scope", "indices", "shape", "placement", "field", "numbers", "emptyCells", "name", "predecessor"], [], "recipe");
    if (shape.schemaVersion !== 1) fail("recipe.schemaVersion must be 1.");
    if (shape.algorithm !== "geocluster-indexed-v1") fail("recipe.algorithm must be geocluster-indexed-v1.");
    const dimensions = vec3(shape.shape, "shape", (v, name) => integer(v, name, 1));
    if (!Number.isSafeInteger(dimensions.reduce((a, b) => a * b, 1))) fail("shape cell count must be a safe integer.");
    const placement = record(shape.placement, ["origin", "spacing", "unit", "horizontalReference", "verticalReference"], [], "placement");
    const origin = vec3(placement.origin, "placement.origin"), spacing = vec3(placement.spacing, "placement.spacing");
    if (!spacing.every((v) => v > 0)) fail("placement.spacing must be positive.");
    if (!origin.every((v, axis) => Number.isFinite(v + dimensions[axis] * spacing[axis]))) fail("placement extent must be finite.");
    const unit = oneOf(placement.unit, ["grid-unit", "m", "ft"], "placement.unit");
    const horizontalReference = validateHorizontalReference(placement.horizontalReference, "placement.horizontalReference");
    const verticalReference = placement.verticalReference === null ? null : text(placement.verticalReference, 256, "placement.verticalReference");
    if (unit === "grid-unit" ? horizontalReference.type !== "unreferenced" || verticalReference !== null : horizontalReference.type === "unreferenced" || verticalReference === null)
        fail("Grid units require unreferenced coordinates and null elevation reference; physical units require horizontal and elevation references.");
    const f = record(shape.field, ["kind", "column", "name"], ["unit", "trim"], "field");
    const common = { column: integer(f.column, "field.column"), name: text(f.name, 256, "field.name") };
    const field = f.kind === "numeric" ? (record(f, ["kind", "column", "name", "unit"], [], "field"), { kind: "numeric", ...common, unit: text(f.unit, 64, "field.unit", true) })
        : f.kind === "categorical" ? (record(f, ["kind", "column", "name", "trim"], [], "field"), { kind: "categorical", ...common, trim: bool(f.trim, "field.trim") }) : fail("field.kind must be numeric or categorical.");
    return { schemaVersion: 1, algorithm: "geocluster-indexed-v1", scope: validateScope(shape.scope), indices: validateIndices(shape.indices), shape: dimensions,
        placement: { origin, spacing, unit, horizontalReference, verticalReference }, field, numbers: validateNumberPolicy(shape.numbers),
        emptyCells: oneOf(shape.emptyCells, ["forbid", "allow"], "emptyCells"), name: text(shape.name, 256, "recipe.name"), predecessor: predecessor(shape.predecessor) };
}
/** Sorted-key JSON; the fingerprint and generation hashes depend on it. */
export function canonicalJson(value) {
    if (Array.isArray(value))
        return `[${value.map(canonicalJson).join(",")}]`;
    if (value !== null && typeof value === "object") {
        return `{${Object.entries(value).filter(([, item]) => item !== undefined).sort(([a], [b]) => a < b ? -1 : a > b ? 1 : 0).map(([key, item]) => `${JSON.stringify(key)}:${canonicalJson(item)}`).join(",")}}`;
    }
    if (typeof value === "number" && !Number.isFinite(value))
        throw new VoxelRecipeError("Non-finite numbers cannot be serialized.");
    return JSON.stringify(value);
}
export async function sha256Hex(data) {
    const bytes = typeof data === "string" ? new TextEncoder().encode(data) : data;
    const digest = await crypto.subtle.digest("SHA-256", bytes);
    return Array.from(new Uint8Array(digest), (byte) => byte.toString(16).padStart(2, "0")).join("");
}
export function recipeFingerprint(submission) {
    return sha256Hex(canonicalJson(submission));
}
