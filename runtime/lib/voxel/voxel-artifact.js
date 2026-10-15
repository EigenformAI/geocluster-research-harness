// Runtime-owned deterministic module; indexed extensions are maintained here.
import { decodeNpyArray } from "./npy.js";
import { cellCount, upperCorner, validShape, validSpacing } from "./voxel-grid.js";
import { canonicalJson, sha256Hex, validateHorizontalReference, validateImportRecipe, validateIndexedRecipe, validateObservationRecipe, validateSourceRevision, VoxelRecipeError } from "./voxel-recipe.js";
import { INDEXED_ALGORITHM, INDEXED_SUMMARY_FIELDS, indexedGrid } from "./voxel-indexed.js";
import { compareCodePoints } from "./voxel-compute.js";
import { VOXEL_EXCLUSION_LABELS, VOXEL_MANIFEST_FORMAT, } from "./voxel-types.js";
import { MAX_CATEGORIES, MAX_CATEGORY_LABEL_UNITS, validCategoryLabel, validatePredecessor } from "./voxel-constraints.js";
/**
 * Pure artifact validation. A manifest is accepted only when every field is
 * well formed and its generation equals the SHA-256 of its canonical body.
 * Member bytes are accepted only when their size, hash, NPY header, dtype,
 * shape, mask values and ancillary shapes agree with the manifest.
 */
export class VoxelArtifactError extends Error {
}
const fail = (message) => { throw new VoxelArtifactError(message); };
function object(value, keys, name, optional = []) {
    if (value === null || typeof value !== "object" || Array.isArray(value))
        fail(`Manifest ${name} must be an object.`);
    const shape = value;
    for (const key of keys)
        if (!Object.hasOwn(shape, key))
            fail(`Manifest ${name}.${key} is missing.`);
    for (const key of Object.keys(shape))
        if (!keys.includes(key) && !optional.includes(key))
            fail(`Manifest ${name}.${key} is not recognized.`);
    return shape;
}
const string = (value, name, max = 4096) => typeof value === "string" && value.length <= max ? value : fail(`Manifest ${name} must be text.`);
const finiteVec = (value, name) => Array.isArray(value) && value.length === 3 && value.every((item) => typeof item === "number" && Number.isFinite(item)) ? value : fail(`Manifest ${name} must be three finite numbers.`);
const count = (value, name) => typeof value === "number" && Number.isSafeInteger(value) && value >= 0 ? value : fail(`Manifest ${name} must be a whole number.`);
const HEX = /^[0-9a-f]{64}$/;
export const MEMBER_DTYPES = { values: null, valid: "|u1", counts: "<u4", weights: "<f8" };
function grid(value) {
    const shape = object(value, ["shape", "origin", "spacing", "axes", "order", "unit", "horizontalReference", "verticalReference"], "grid");
    const dimensions = shape.shape;
    if (!Array.isArray(dimensions) || !validShape(dimensions))
        fail("Manifest grid.shape must be three positive whole numbers.");
    const spacing = finiteVec(shape.spacing, "grid.spacing");
    if (!validSpacing(spacing))
        fail("Manifest grid.spacing must be positive.");
    if (shape.order !== "C-z-fastest")
        fail("Manifest grid.order must be C-z-fastest.");
    const unit = shape.unit === "m" || shape.unit === "ft" || shape.unit === "grid-unit" ? shape.unit : fail("Manifest grid.unit is not supported.");
    const axes = shape.axes === "easting,northing,elevation" || shape.axes === "x,y,z" ? shape.axes : fail("Manifest grid.axes is not supported.");
    let horizontalReference;
    try {
        horizontalReference = validateHorizontalReference(shape.horizontalReference);
    }
    catch (error) {
        return fail(`Manifest grid: ${error.message}`);
    }
    if (horizontalReference.type !== "unreferenced" && unit === "grid-unit")
        fail("A CRS or local frame needs linear units, not grid units.");
    if (horizontalReference.type !== "unreferenced" && axes !== "easting,northing,elevation")
        fail("A referenced grid uses easting, northing and elevation axes.");
    const verticalReference = shape.verticalReference === null ? null : string(shape.verticalReference, "grid.verticalReference", 256);
    return { shape: [...dimensions], origin: finiteVec(shape.origin, "grid.origin"), spacing, axes, order: "C-z-fastest", unit, horizontalReference, verticalReference };
}
function field(value) {
    const shape = object(value, ["kind", "name", "unit"], "field", ["categories"]);
    const name = string(shape.name, "field.name", 256);
    if (shape.kind === "numeric") {
        object(value, ["kind", "name", "unit"], "field");
        return { kind: "numeric", name, unit: string(shape.unit, "field.unit", 64) };
    }
    if (shape.kind !== "categorical")
        fail("Manifest field.kind must be numeric or categorical.");
    object(value, ["kind", "name", "unit", "categories"], "field");
    if (shape.unit !== "")
        fail("Manifest categorical field.unit must be empty.");
    if (!Array.isArray(shape.categories) || shape.categories.length === 0 || shape.categories.length > MAX_CATEGORIES)
        fail("Manifest field.categories must list the category dictionary.");
    const labels = new Set();
    const categories = shape.categories.map((item, index) => {
        const category = object(item, ["code", "label"], `field.categories[${index}]`);
        if (category.code !== index)
            fail("Manifest category codes must be 0..n-1 in order.");
        if (!validCategoryLabel(category.label)) fail(`Manifest field.categories[${index}].label must be nonempty text up to ${MAX_CATEGORY_LABEL_UNITS} UTF-16 code units.`);
        const label = category.label;
        if (labels.has(label))
            fail(`Manifest category label "${label}" is repeated.`);
        labels.add(label);
        return { code: index, label };
    });
    return { kind: "categorical", name, unit: "", categories };
}
function statistics(value) {
    const shape = object(value, ["rows", "acceptedRows", "excludedRows", "exclusions", "secondaryExclusions", "occupiedCells", "valueRange", "duplicatePositions", "categoryTies", "censoredSubstitutions", "formulaCacheValues", "clipping", "bounds"], "statistics");
    for (const key of ["rows", "acceptedRows", "excludedRows", "occupiedCells", "duplicatePositions", "categoryTies", "censoredSubstitutions", "formulaCacheValues"])
        count(shape[key], `statistics.${key}`);
    const reasons = (item, name) => {
        const record = object(item, [], name, Object.keys(VOXEL_EXCLUSION_LABELS));
        for (const [reason, total] of Object.entries(record))
            count(total, `${name}.${reason}`);
    };
    reasons(shape.exclusions, "statistics.exclusions");
    reasons(shape.secondaryExclusions, "statistics.secondaryExclusions");
    const finite = (item, name) => typeof item === "number" && Number.isFinite(item) ? item : fail(`Manifest ${name} must be a finite number.`);
    if (shape.valueRange !== null) {
        const range = object(shape.valueRange, ["min", "max"], "statistics.valueRange");
        finite(range.min, "statistics.valueRange.min");
        finite(range.max, "statistics.valueRange.max");
    }
    if (shape.clipping !== null) {
        const clipping = object(shape.clipping, ["outsidePoints", "fullyOutsideSegments", "partiallyClippedSegments", "retainedLength", "removedLength"], "statistics.clipping");
        for (const key of ["outsidePoints", "fullyOutsideSegments", "partiallyClippedSegments"])
            count(clipping[key], `statistics.clipping.${key}`);
        for (const key of ["retainedLength", "removedLength"])
            finite(clipping[key], `statistics.clipping.${key}`);
    }
    if (shape.bounds !== null) {
        const bounds = object(shape.bounds, ["min", "max"], "statistics.bounds");
        finiteVec(bounds.min, "statistics.bounds.min");
        finiteVec(bounds.max, "statistics.bounds.max");
    }
    return shape;
}
function members(value, kind, mode) {
    if (!Array.isArray(value))
        return fail("Manifest arrays must be a list.");
    const roles = new Set();
    const parsed = value.map((item, index) => {
        const shape = object(item, ["role", "dtype", "contentId", "sha256", "byteLength"], `arrays[${index}]`);
        const role = shape.role;
        if (!Object.hasOwn(MEMBER_DTYPES, role) || roles.has(role))
            fail(`Manifest array role ${String(shape.role)} is unknown or repeated.`);
        roles.add(role);
        const dtype = MEMBER_DTYPES[role] ?? (kind === "numeric" ? "<f8" : "<u4");
        if (shape.dtype !== dtype)
            fail(`Manifest ${role} member must be ${dtype}.`);
        if (typeof shape.sha256 !== "string" || !HEX.test(shape.sha256))
            fail(`Manifest ${role} member needs a SHA-256 digest.`);
        const contentId = string(shape.contentId, `arrays[${index}].contentId`, 512);
        if (contentId !== `sha256:${shape.sha256}`)
            fail(`Manifest ${role} member must be addressed by its content hash.`);
        return { role, dtype, contentId, sha256: shape.sha256, byteLength: count(shape.byteLength, `arrays[${index}].byteLength`) };
    });
    if (!roles.has("values") || !roles.has("valid"))
        fail("Manifest must include values and valid members.");
    if (mode === "binned-observations" && !roles.has("counts"))
        fail("Binned manifests must include per-cell counts.");
    if (mode === "imported-grid" && roles.size !== 2)
        fail("Imported grids contain values and valid only.");
    return parsed;
}
function indexedStatistics(value, grid, field, recipe) {
    const shape = object(value, [...INDEXED_SUMMARY_FIELDS, "censoredSubstitutions", "formulaCacheValues", "valueRange"], "statistics");
    for (const key of [...INDEXED_SUMMARY_FIELDS, "censoredSubstitutions", "formulaCacheValues"]) count(shape[key], `statistics.${key}`);
    if (shape.duplicateCellGroups !== 0 || shape.inputRows !== shape.suppliedUniqueCells || shape.suppliedUniqueCells !== shape.emptySuppliedValueCells + shape.validCells ||
        shape.absentRecordCells + shape.emptySuppliedValueCells + shape.validCells !== cellCount(grid.shape) || !shape.validCells)
        fail("Indexed statistics must describe a complete, duplicate-free grid with valid cells.");
    if (recipe.emptyCells === "forbid" && (shape.absentRecordCells || shape.emptySuppliedValueCells)) fail("Indexed empty-cell statistics violate the recipe policy.");
    if (shape.censoredSubstitutions > shape.validCells || shape.formulaCacheValues > shape.validCells) fail("Indexed substitution/cache counts exceed valid cells.");
    if (field.kind === "numeric") {
        const range = object(shape.valueRange, ["min", "max"], "statistics.valueRange");
        if (![range.min, range.max].every((v) => typeof v === "number" && Number.isFinite(v)) || range.min > range.max) fail("Indexed numeric valueRange must be finite and ordered.");
    } else if (shape.valueRange !== null || shape.censoredSubstitutions !== 0) fail("Indexed categories have no numeric range or censor substitutions.");
    return shape;
}
/** Strict structural validation; does not check the generation hash. */
export function parseManifest(value) {
    const shape = object(value, ["format", "schemaVersion", "artifactId", "generation", "predecessor", "projectId", "operationId", "createdUtc", "creation", "sourceRevisions", "grid", "field", "arrays", "recipe", "statistics", "warnings", "assumptions"], "root");
    if (shape.format !== VOXEL_MANIFEST_FORMAT)
        fail("This JSON is not a voxel manifest.");
    if (shape.schemaVersion !== 1)
        fail(`Voxel manifest schema ${String(shape.schemaVersion)} is not supported.`);
    const artifactId = string(shape.artifactId, "artifactId", 128);
    if (!/^vox-[A-Za-z0-9-]{1,120}$/.test(artifactId))
        fail("Manifest artifactId is not valid.");
    const generation = string(shape.generation, "generation", 64);
    if (!HEX.test(generation))
        fail("Manifest generation must be a SHA-256 digest.");
    const predecessor = validatePredecessor(shape.predecessor, fail, "Manifest predecessor");
    const creation = object(shape.creation, ["mode", "label", "algorithm", "boundaryPolicy", "accumulation", "parsers", "executionProfile"], "creation");
    const mode = ["binned-observations", "imported-volume", "imported-grid"].includes(creation.mode) ? creation.mode : fail("Manifest creation.mode is not supported.");
    if (!Array.isArray(creation.parsers) || !creation.parsers.every((parser) => typeof parser === "string"))
        fail("Manifest creation.parsers must be text.");
    if (!Array.isArray(shape.sourceRevisions) || shape.sourceRevisions.length === 0)
        fail("Manifest sourceRevisions must list at least one source.");
    const recipe = object(shape.recipe, ["type", "recipe"], "recipe");
    const parsedGrid = grid(shape.grid), parsedField = field(shape.field);
    if (mode === "imported-volume" && parsedField.kind !== "numeric")
        fail("Imported volumes must be numeric.");
    let parsedRecipe;
    try {
        if (mode === "binned-observations" && recipe.type === "table-to-voxel") {
            object(shape.recipe, ["type", "recipe"], "recipe");
            parsedRecipe = { type: "table-to-voxel", recipe: validateObservationRecipe(recipe.recipe) };
        }
        else if (mode === "imported-volume" && recipe.type === "imported-volume") {
            object(shape.recipe, ["type", "recipe"], "recipe");
            parsedRecipe = { type: "imported-volume", recipe: validateImportRecipe(recipe.recipe) };
        }
        else if (mode === "imported-grid" && recipe.type === "indexed-grid") {
            parsedRecipe = { type: "indexed-grid", recipe: validateIndexedRecipe(recipe.recipe) };
        }
        else
            return fail("Manifest recipe type does not match its creation mode.");
    }
    catch (error) {
        if (error instanceof VoxelRecipeError)
            fail(`Manifest recipe: ${error.message}`);
        throw error;
    }
    const texts = (item, name) => Array.isArray(item) && item.every((entry) => typeof entry === "string") ? item : fail(`Manifest ${name} must be text.`);
    let sources;
    try {
        sources = shape.sourceRevisions.map((item, index) => validateSourceRevision(item, `sourceRevisions[${index}]`));
    }
    catch (error) {
        return fail(`Manifest ${error.message}`);
    }
    if (mode === "imported-grid") {
        const r = parsedRecipe.recipe;
        if (creation.algorithm !== INDEXED_ALGORITHM) fail("Indexed creation algorithm must be geocluster-indexed-v1.");
        if (canonicalJson(parsedGrid) !== canonicalJson(indexedGrid(r))) fail("Indexed grid placement/shape differs from its recipe.");
        if (parsedField.kind !== r.field.kind || parsedField.name !== r.field.name || parsedField.unit !== (r.field.kind === "numeric" ? r.field.unit : "")) fail("Indexed field differs from its recipe.");
        if (!sources.some((s) => canonicalJson(s) === canonicalJson(r.scope.input.source))) fail("Indexed source capture differs from its recipe.");
        if (canonicalJson(predecessor) !== canonicalJson(r.predecessor)) fail("Indexed predecessor differs from its recipe.");
        if (parsedField.kind === "categorical" && parsedField.categories.some((c, n, list) => c.label === "" || c.label.includes("\0") || n > 0 && compareCodePoints(list[n - 1].label, c.label) >= 0)) fail("Indexed categories must be nonempty exact labels in code-point order.");
    }
    return {
        format: VOXEL_MANIFEST_FORMAT, schemaVersion: 1, artifactId, generation, predecessor,
        projectId: string(shape.projectId, "projectId", 256), operationId: shape.operationId === null ? null : string(shape.operationId, "operationId", 128),
        createdUtc: string(shape.createdUtc, "createdUtc", 64),
        creation: { mode, label: string(creation.label, "creation.label", 256), algorithm: string(creation.algorithm, "creation.algorithm", 128), boundaryPolicy: string(creation.boundaryPolicy, "creation.boundaryPolicy", 512),
            accumulation: string(creation.accumulation, "creation.accumulation", 512), parsers: creation.parsers, executionProfile: string(creation.executionProfile, "creation.executionProfile", 256) },
        sourceRevisions: sources, grid: parsedGrid, field: parsedField, arrays: members(shape.arrays, parsedField.kind, mode),
        recipe: parsedRecipe, statistics: mode === "imported-grid" ? indexedStatistics(shape.statistics, parsedGrid, parsedField, parsedRecipe.recipe) : statistics(shape.statistics), warnings: texts(shape.warnings, "warnings"), assumptions: texts(shape.assumptions, "assumptions"),
    };
}
export async function manifestGeneration(manifest) {
    const body = { ...manifest };
    delete body.generation;
    return sha256Hex(canonicalJson(body));
}
/** Parses, validates and verifies the generation of manifest bytes. */
export async function readManifest(bytes) {
    let value;
    try {
        value = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes));
    }
    catch {
        return fail("The manifest is not valid UTF-8 JSON.");
    }
    const manifest = parseManifest(value);
    if (await manifestGeneration(manifest) !== manifest.generation)
        fail("Manifest content does not match its generation; the snapshot was altered or truncated.");
    return manifest;
}
/** Decodes and cross-checks members into a render-ready volume. */
export async function assembleVolume(manifest, bytes) {
    const cells = cellCount(manifest.grid.shape);
    const decoded = {};
    for (const member of manifest.arrays) {
        const data = bytes[member.role];
        if (!data)
            fail(`The ${member.role} member is unavailable.`);
        if (data.byteLength !== member.byteLength)
            fail(`The ${member.role} member has ${data.byteLength} bytes; the manifest records ${member.byteLength}.`);
        if (await sha256Hex(data) !== member.sha256)
            fail(`The ${member.role} member does not match its recorded SHA-256.`);
        try {
            decoded[member.role] = decodeNpyArray(data, { descr: member.dtype, shape: manifest.grid.shape });
        }
        catch (error) {
            fail(`The ${member.role} member is not a valid ${member.dtype} array of shape ${manifest.grid.shape.join(" × ")}: ${error.message}`);
        }
    }
    const valid = decoded.valid, values = decoded.values, counts = decoded.counts ?? null, weights = decoded.weights ?? null;
    let occupied = 0, low = Infinity, high = -Infinity;
    const categories = manifest.field.kind === "categorical" ? manifest.field.categories.length : 0;
    const usedCategories = new Set();
    for (let cell = 0; cell < cells; cell++) {
        const flag = valid[cell];
        if (flag > 1)
            fail("The valid mask contains values other than 0 and 1.");
        if (!flag) {
            if (values[cell] !== 0 || (counts && counts[cell] !== 0) || (weights && weights[cell] !== 0))
                fail("Empty cells must store zero values, counts and weights.");
            continue;
        }
        occupied++;
        const value = values[cell];
        if (manifest.field.kind === "categorical") {
            if (value >= categories)
                fail(`Category code ${value} is not in the dictionary.`);
            usedCategories.add(value);
        }
        else if (!Number.isFinite(value))
            fail("A valid numeric cell is not finite.");
        else {
            low = Math.min(low, value);
            high = Math.max(high, value);
        }
    }
    const expectedOccupied = manifest.creation.mode === "imported-grid" ? manifest.statistics.validCells : manifest.statistics.occupiedCells;
    if (occupied !== expectedOccupied)
        fail(`The mask has ${occupied} occupied cells; the manifest records ${expectedOccupied}.`);
    if (manifest.creation.mode === "imported-grid" && manifest.field.kind === "numeric" && (low !== manifest.statistics.valueRange.min || high !== manifest.statistics.valueRange.max))
        fail("The numeric member range differs from indexed statistics.");
    if (manifest.creation.mode === "imported-grid" && manifest.field.kind === "categorical" && usedCategories.size !== categories)
        fail("The indexed dictionary includes unused category labels.");
    return {
        binding: JSON.stringify([manifest.artifactId, manifest.generation]), artifact: { artifactId: manifest.artifactId, generation: manifest.generation },
        grid: manifest.grid, field: manifest.field, values: values instanceof Float64Array ? values : Float64Array.from(values), valid, counts, weights, occupied,
        range: manifest.field.kind === "numeric" && occupied ? { min: low, max: high } : null, creationLabel: manifest.creation.label,
    };
}
export function defaultSpatialMetadata(name) {
    return {
        axisOrder: [0, 1, 2], reversed: [false, false, false], indexOrigin: [0, 0, 0], spacing: [1, 1, 1], unit: "grid-unit",
        horizontalReference: { type: "unreferenced", definition: "" }, verticalReference: null,
        fieldName: name.replace(/\.npy$/i, "") || "Values", fieldUnit: "Unknown", sentinel: null,
    };
}
/** Lower-corner grid for a raw array shape under explicit axis mapping and reversal. */
export function spatialGrid(rawShape, metadata) {
    const shape = metadata.axisOrder.map((axis) => rawShape[axis]);
    const origin = [0, 1, 2].map((axis) => metadata.reversed[axis] ? metadata.indexOrigin[axis] - shape[axis] * metadata.spacing[axis] : metadata.indexOrigin[axis]);
    const referenced = metadata.horizontalReference.type !== "unreferenced";
    return { shape, origin, spacing: [...metadata.spacing], axes: referenced ? "easting,northing,elevation" : "x,y,z", order: "C-z-fastest",
        unit: metadata.unit, horizontalReference: metadata.horizontalReference, verticalReference: metadata.verticalReference };
}
/** Problems that block using metadata. Defaults are always usable as grid coordinates. */
export function spatialMetadataProblems(metadata, edited) {
    const problems = [];
    if ([...metadata.axisOrder].sort().join() !== "0,1,2")
        problems.push("Map each array axis to exactly one of X, Y and Z.");
    if (!validSpacing(metadata.spacing))
        problems.push("Cell sizes must be positive, finite numbers.");
    if (!metadata.indexOrigin.every(Number.isFinite))
        problems.push("The origin must be finite.");
    if (!metadata.fieldName.trim())
        problems.push("Name the field.");
    if (metadata.horizontalReference.type !== "unreferenced") {
        if (!metadata.horizontalReference.definition.trim())
            problems.push("Name the CRS or local frame.");
        if (metadata.unit === "grid-unit")
            problems.push("A CRS or local frame needs linear units (metres or feet).");
        if (!metadata.verticalReference?.trim())
            problems.push("State the elevation reference for Z.");
        if (!edited.includes("indexOrigin") || !edited.includes("spacing"))
            problems.push("Set the origin and cell size in frame units; array indices are not positions.");
    }
    return problems;
}
/** Canonical C-order values and mask after the recorded axis transform. Nonfinite and sentinel entries are empty. */
export function normalizeImported(raw, metadata) {
    const grid = spatialGrid(raw.shape, metadata);
    const [nx, ny, nz] = grid.shape, [, a1, a2] = raw.shape;
    const values = new Float64Array(nx * ny * nz), valid = new Uint8Array(nx * ny * nz);
    const source = [0, 0, 0];
    let occupied = 0, low = Infinity, high = -Infinity;
    for (let i = 0; i < nx; i++)
        for (let j = 0; j < ny; j++)
            for (let k = 0; k < nz; k++) {
                const out = [i, j, k];
                for (let axis = 0; axis < 3; axis++)
                    source[metadata.axisOrder[axis]] = metadata.reversed[axis] ? grid.shape[axis] - 1 - out[axis] : out[axis];
                const value = raw.values[(source[0] * a1 + source[1]) * a2 + source[2]];
                const cell = (i * ny + j) * nz + k;
                if (!Number.isFinite(value) || (metadata.sentinel !== null && value === metadata.sentinel))
                    continue;
                values[cell] = value;
                valid[cell] = 1;
                occupied++;
                low = Math.min(low, value);
                high = Math.max(high, value);
            }
    return { grid, values, valid, occupied, range: occupied ? { min: low, max: high } : null };
}
export function importedVolume(source, raw, metadata) {
    const normalized = normalizeImported(raw, metadata);
    return {
        binding: JSON.stringify([source.resourceId, source.sha256, source.revision, canonicalJson(metadata)]), artifact: null,
        grid: normalized.grid, field: { kind: "numeric", name: metadata.fieldName, unit: metadata.fieldUnit }, values: normalized.values, valid: normalized.valid,
        counts: null, weights: null, occupied: normalized.occupied, range: normalized.range, creationLabel: "Imported volume; aggregation unknown",
    };
}
export function gridExtent(grid) {
    return { lower: grid.origin, upper: upperCorner(grid) };
}
