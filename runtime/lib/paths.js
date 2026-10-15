/**
 * Workspace path containment (the gateway's counterpart of the MCP server's resolve_path(),
 * design invariant X-1).
 *
 * A request path is relative to the workspace root. It must resolve, after symlinks, to a
 * location inside the root; hidden runtime directories are never listed or served.
 */
import fs from "node:fs/promises"
import path from "node:path"

/** Top-level names that belong to the runtime, not the user, and are hidden from the file API. */
export const HIDDEN_NAMES = new Set([".runtime", ".ide-state", ".datasets-staging", ".clinerules", ".git", ".upload-tmp"])

export class PathError extends Error {
	constructor(status, message) {
		super(message)
		this.status = status
	}
}

/** Normalise a client-supplied relative path ("" and "." mean the root). */
export function normalizeRelative(input) {
	if (input === undefined || input === null) return ""
	if (typeof input !== "string") throw new PathError(400, "path must be a string")
	if (input.includes("\0")) throw new PathError(400, "path contains NUL")
	const trimmed = input.replace(/^\/+/, "")
	const normalized = path.posix.normalize(trimmed === "" ? "." : trimmed).replace(/\/+$/, "")
	if (normalized === "." || normalized === "") return ""
	if (normalized === ".." || normalized.startsWith("../")) throw new PathError(403, "path escapes the workspace")
	return normalized
}

export function isHidden(relativePath) {
	const first = relativePath.split("/")[0]
	return first !== "" && HIDDEN_NAMES.has(first)
}

/**
 * Resolve `relativePath` inside `root`. Returns the absolute path and the real path.
 * The real path (symlinks followed) must stay inside the real root; otherwise 403.
 * A missing file resolves to its would-be location (callers decide whether that is an error).
 */
export async function resolveInside(root, relativePath) {
	const rel = normalizeRelative(relativePath)
	if (isHidden(rel)) throw new PathError(404, "not found")
	const realRoot = await fs.realpath(root)
	const absolute = path.join(realRoot, rel)
	if (absolute !== realRoot && !absolute.startsWith(realRoot + path.sep)) {
		throw new PathError(403, "path escapes the workspace")
	}
	let real
	try {
		real = await fs.realpath(absolute)
	} catch (error) {
		if (error.code === "ENOENT") {
			// Check the deepest existing ancestor instead, so a symlinked parent cannot lead outside
			const parentReal = await fs.realpath(path.dirname(absolute)).catch(() => null)
			if (parentReal && parentReal !== realRoot && !parentReal.startsWith(realRoot + path.sep)) {
				throw new PathError(403, "path escapes the workspace")
			}
			return { relative: rel, absolute, real: null, exists: false }
		}
		throw error
	}
	if (real !== realRoot && !real.startsWith(realRoot + path.sep)) {
		throw new PathError(403, "path escapes the workspace")
	}
	return { relative: rel, absolute, real, exists: true }
}
