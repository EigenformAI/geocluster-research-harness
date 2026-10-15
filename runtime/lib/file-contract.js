import crypto from "node:crypto"

export const FILES_CONTRACT_VERSION = 1
export const FILE_ID_PATTERN = /^[A-Za-z0-9_.:-]{1,128}$/
export const SEGMENT_PROVIDER_LIMIT_NAMES = Object.freeze(["rowLimit", "rowMaxLimit", "columnLimit", "columnMaxLimit", "readBytes", "readMaxBytes", "responseBytes", "responseMaxBytes", "elapsedMs", "cellCodePoints", "textWindowBytes"])
export const FILE_LIMITS = Object.freeze({
	liveTextBytes: 256 * 1024, liveTextMaxBytes: 1024 * 1024, editorBytes: 4 * 1024 * 1024,
	pageSize: 200, pageMaxSize: 1000, views: 32, viewBytes: 64 * 1024 * 1024,
	viewIdleMs: 10 * 60 * 1000, viewAgeMs: 60 * 60 * 1000,
	readBytes: 8 * 1024 * 1024, responseBytes: 1024 * 1024, elapsedMs: 2000,
	rowLimit: 100, columnLimit: 20, cellCodePoints: 512, textWindowBytes: 64 * 1024,
	readMaxBytes: 32 * 1024 * 1024, responseMaxBytes: 4 * 1024 * 1024,
	rowMaxLimit: 1000, columnMaxLimit: 200,
	uploadBytes: 8 * 1024 * 1024 * 1024, captureInlineBytes: 8 * 1024 * 1024,
	leaseSeconds: 300, leaseMaxSeconds: 900, previewIdleMs: 30 * 60 * 1000,
	previewBytes: 1024 * 1024 * 1024, recoveryMs: 7 * 24 * 60 * 60 * 1000,
	retainedBytes: 16 * 1024 * 1024 * 1024,
	orphanPartialMs: 30 * 60 * 1000,
	receiptMs: 7 * 24 * 60 * 60 * 1000, trashMs: 24 * 60 * 60 * 1000,
	searchResults: 200, searchMaxResults: 2000, searchFileBytes: 20 * 1024 * 1024,
	searchEventBytes: 64 * 1024, searchExcerptBytes: 16 * 1024,
	eventCount: 5000, eventBytes: 4 * 1024 * 1024, subscriberBytes: 1024 * 1024,
	queueSize: 16, scanIntervalMs: 60 * 1000,
	subtreeEntries: 10000, indexScanEntries: 100000, indexScanMs: 5000, indexBatchSize: 128,
	watchDebounceMs: 50, treeEntries: 5000, treeMaxEntries: 50000,
	searchEntries: 100000, searchExclusions: 200, searchWorkerBytes: 256 * 1024 * 1024,
	workbookInputBytes: 40 * 1024 * 1024, workbookExpandedBytes: 256 * 1024 * 1024,
	workbookIndexBytes: 256 * 1024 * 1024, workbookPrepareMs: 60000,
	workbookManifestBytes: 1024 * 1024,
	workbookCells: 2000000, workbookZipEntries: 20000,
	workbookMemberBytes: 256 * 1024 * 1024, workbookRowBytes: 8 * 1024 * 1024,
	workbookRowLimit: 100, workbookColumnLimit: 20, workbookRowMaxLimit: 1000, workbookColumnMaxLimit: 100,
	workbookPageBytes: 4 * 1024 * 1024, workbookQueryMs: 5000, workbookExportMs: 10000,
	workbookExportBytes: 16 * 1024 * 1024, workbookSelectedRows: 4096, workbookWorkerHeapMiB: 128,
	gisInputBytes: 40 * 1024 * 1024, gisMembers: 32, gisManifestBytes: 1024 * 1024,
	gisResponseBytes: 2 * 1024 * 1024, gisElapsedMs: 30000,
	gisFeatures: 1000, gisPositions: 20000, gisAttributeRows: 50,
	gisAttributeOffset: 1000000,
	gisBands: 32, gisPreviewEdge: 512, gisMemoryBytes: 512 * 1024 * 1024,
	gisSourcePixels: 100000000, gisDecodedBlockBytes: 128 * 1024 * 1024,
	gisAssayRows: 10000, gisAssayPoints: 10000, gisAssayColumns: 128, gisAssayCellBytes: 4096,
	gisAssayManifestBytes: 16 * 1024 * 1024, gisAssayResponseBytes: 16 * 1024 * 1024,
})

export class FileError extends Error {
	constructor(status, error, message, details = {}) {
		super(message)
		this.status = status
		this.error = error
		Object.assign(this, details)
	}
	toJSON() {
		const { status, stack, name, ...details } = this
		return { error: this.error, message: this.message, agent: "file-service", tool: details.action || "files", action: "Inspect the request and retry with current metadata.", ...details }
	}
}

export function fileError(error, action = "files") {
	if (error instanceof FileError) return error
	const code = error?.code
	const mapping = {
		EINVAL: [400, "invalid_path"], ENAMETOOLONG: [400, "invalid_path"], ESTALE: [409, "source_changed"], E2BIG: [409, "subtree_limit"], ENOTEMPTY: [409, "directory_not_empty"],
		ENOENT: [404, "not_found"], EACCES: [403, "permission_denied"], EPERM: [403, "permission_denied"],
		EEXIST: [409, "exists"], ELOOP: [400, "invalid_path"], ENOTDIR: [400, "invalid_path"],
		EXDEV: [409, "cross_device_move"], ENOSPC: [507, "insufficient_storage"], EDQUOT: [507, "insufficient_storage"],
		ENOSYS: [503, "storage_unavailable"], EOPNOTSUPP: [503, "storage_unavailable"], EIO: [503, "storage_unavailable"],
	}
	const [status, initialKind] = mapping[code] || [500, "storage_unavailable"]
	const protectedResource = code === "EACCES" && ["reserved_component", "hidden_root", "read_only_root", "protected_descendant"].includes(error.reason)
	return new FileError(status, protectedResource ? "protected_resource" : initialKind, `${action}: ${error?.message || error}`, { agent: error.agent || "file-service", tool: error.tool || action, action: error.action || "Inspect the requested path and storage, then retry using current metadata.", ...(error.reason ? { reason: error.reason } : {}), ...(code === "ELOOP" ? { reason: "symlink" } : {}), ...(status === 403 && !protectedResource ? { access: "read" } : {}) })
}

export function canonicalPath(input, { root = true } = {}) {
	if (typeof input !== "string" || input.includes("\\") || /[\u0000-\u001f\u007f]/u.test(input) || /[\ud800-\udfff]/u.test(input)) throw new FileError(400, "invalid_path", "Use a UTF-8 POSIX relative path without controls or backslashes.")
	if (input === "" && root) return ""
	if (!input || input.split("/").some((part) => !part || part === "." || part === "..")) throw new FileError(400, "invalid_path", "Paths must be canonical, relative, and have no empty, dot, or parent components.")
	return input
}

export function identifier(value, kind = "operationId") {
	if (typeof value !== "string" || !FILE_ID_PATTERN.test(value)) throw new FileError(400, "invalid_id", `${kind} must be 1–128 characters from [A-Za-z0-9_.:-].`)
	return value
}

export function budget(value, fallback, ceiling, name) {
	if (value === undefined || value === null || value === "") return fallback
	const n = Number(value)
	if (!Number.isSafeInteger(n) || n < 1 || n > ceiling) throw new FileError(400, "invalid_budget", `${name} must be an integer from 1 to ${ceiling}.`, { limits: { [name]: ceiling } })
	return n
}

export function observationToken(stat) {
	return crypto.createHash("sha256").update([stat.dev, stat.ino, stat.mode, stat.size, stat.mtimeNs, stat.ctimeNs].map(String).join(":")).digest("base64url")
}

export function observation(ref, stat) {
	const sizeBytes = Number(stat.size)
	if (!Number.isSafeInteger(sizeBytes) || sizeBytes < 0) throw new FileError(400, "unsupported_size", "The resource exceeds the supported byte-offset domain.")
	return { ref, token: observationToken(stat), observedAt: new Date().toISOString(), sizeBytes }
}

export function stableStringify(value) {
	if (Array.isArray(value)) return `[${value.map(stableStringify).join(",")}]`
	if (value && typeof value === "object") return `{${Object.keys(value).sort().filter((key) => value[key] !== undefined).map((key) => `${JSON.stringify(key)}:${stableStringify(value[key])}`).join(",")}}`
	return JSON.stringify(value)
}

/** Digest progress describes evidence about bytes; it does not change their capture identity. */
export function capturedSourceIdentity(source) {
	const { kind, ref, captureId, etag, sizeBytes, consistency } = source
	return { kind, ref, captureId, etag, sizeBytes, consistency }
}

export function noPersistence() {
	return { state: "not-configured", localGeneration: null, acknowledgedRemoteEtag: null, pendingRemoteEtag: null, pendingRemoteDetectedAt: null, checkedAt: null, remoteIntegrity: "unknown" }
}

export function objectIdentity(stat) { return { dev: String(stat.dev), ino: String(stat.ino) } }
export function sameObject(a, b) { return Boolean(a && b && String(a.dev) === String(b.dev) && String(a.ino) === String(b.ino)) }
