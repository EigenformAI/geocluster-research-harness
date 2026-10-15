// Lengths use JavaScript UTF-16 units, not code points or UTF-8 bytes.
export const MAX_CATEGORY_LABEL_UNITS = 1024;
export const MAX_PREDECESSOR_GENERATION_UNITS = 64;
export const MAX_CATEGORIES = 65536;
export function validCategoryLabel(value) {
    return typeof value === "string" && value.length > 0 && value.length <= MAX_CATEGORY_LABEL_UNITS;
}
export function validatePredecessor(value, fail, name = "predecessor") {
    if (value === null) return null;
    if (!value || typeof value !== "object" || Array.isArray(value) || Object.keys(value).length !== 2 || !Object.hasOwn(value, "artifactId") || !Object.hasOwn(value, "generation")) return fail(`${name} must contain exactly artifactId and generation.`);
    const text = (item, max, field) => typeof item === "string" && item.length <= max && item.trim().length > 0 && !item.includes("\0") ? item : fail(`${name}.${field} must be nonempty text up to ${max} UTF-16 code units.`);
    return { artifactId: text(value.artifactId, 128, "artifactId"), generation: text(value.generation, MAX_PREDECESSOR_GENERATION_UNITS, "generation") };
}
