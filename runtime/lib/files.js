/** HTTP v1 adapter. WorkspaceFiles owns filesystem effects, policy, durable state, and scheduling. */
import path from "node:path"
import { Readable } from "node:stream"
import { pipeline } from "node:stream/promises"
import { FILE_LIMITS, FILES_CONTRACT_VERSION, FileError, fileError, identifier, observationToken } from "./file-contract.js"
import { FILES_JSON_MAX_BYTES, FILES_ROUTES, buildFilesOpenApi } from "./files-openapi.js"
import workspaceRelay from "./workspace-relay.cjs"

const MIME = {
	".txt": "text/plain; charset=utf-8", ".md": "text/markdown; charset=utf-8", ".csv": "text/csv; charset=utf-8", ".tsv": "text/tab-separated-values; charset=utf-8",
	".json": "application/json; charset=utf-8", ".geojson": "application/geo+json; charset=utf-8", ".xml": "application/xml; charset=utf-8", ".yaml": "text/yaml; charset=utf-8", ".yml": "text/yaml; charset=utf-8",
	".py": "text/x-python; charset=utf-8", ".js": "text/javascript; charset=utf-8", ".ts": "text/typescript; charset=utf-8", ".html": "text/html; charset=utf-8", ".htm": "text/html; charset=utf-8", ".css": "text/css; charset=utf-8", ".las": "text/plain; charset=utf-8",
	".pdf": "application/pdf", ".png": "image/png", ".jpg": "image/jpeg", ".jpeg": "image/jpeg", ".gif": "image/gif", ".svg": "image/svg+xml", ".webp": "image/webp", ".tif": "image/tiff", ".tiff": "image/tiff", ".zip": "application/zip", ".parquet": "application/vnd.apache.parquet",
}
const activeExtensions = new Set([".html", ".htm", ".xhtml", ".svg", ".svgz", ".xml", ".xsl", ".xslt", ".css", ".js", ".mjs", ".cjs"])
const fail = (status, error, message, details = {}) => new FileError(status, error, message, { agent: "file-service", tool: "files-http", action: "Correct the request and retry using the current file metadata.", ...details })
const productRequestHeaders = ["range", "if-range", "if-match", "if-none-match", "if-modified-since", "if-unmodified-since"]
const productResponseHeaders = ["content-type", "content-length", "content-range", "accept-ranges", "etag", "last-modified", "cache-control", "content-disposition"]

/** Identity is retained and immutable for the lifetime of this service, never request-selected. */
export function workspaceFenceError(req, identity) {
	const details = { state: "rejected", action: "Reconnect to the current workspace before submitting a new request." }
	let expected
	try { expected = workspaceRelay.parseWorkspaceFence(req) } catch (error) { return fail(error.status, error.error, error.message, details) }
	if (expected && (expected.workspaceId !== identity?.workspaceId || expected.workspaceEpoch !== identity?.workspaceEpoch)) return fail(409, "workspace_changed", "The requested workspace identity or epoch does not match this file service.", details)
	return null
}

function correlateFence(error, values) {
	for (const name of ["operationId", "requestId"]) {
		const value = values?.[name]
		if (typeof value === "string" && /^[A-Za-z0-9_.:-]{1,128}$/.test(value) && value !== "." && value !== "..") error[name] = value
	}
	return error
}

function publicOperation(operation) {
	const publicFields = ["operationId", "action", "state", "addresses", "localGeneration", "publishedSource", "publishedObservation", "committedAt", "acceptedAt", "finishedAt", "persistence", "reconciliation", "processing", "sourceRetention", "parentOperationId", "error", "duplicate", "deferred", "reason", "recovered", "tombstones"]
	const receipt = Object.fromEntries(publicFields.filter((key) => Object.hasOwn(operation, key)).map((key) => [key, operation[key]])), claim = operation.claim
	if (operation.intent) {
		const fields = ["action", "path", "from", "to", "mode", "baseObservation", "destinationObservation", "replace", "recursive", "parents", "processingPolicy", "declaredSize", "declaredDigest", "requireRemotePersistable", "ifMatch", "ifNoneMatch", "recoveryId", "applyNow", "discardLocal", "entries", "workId"]
		receipt.intent = Object.fromEntries(fields.filter((key) => Object.hasOwn(operation.intent, key)).map((key) => [key, operation.intent[key]]))
	}
	if (operation.action === "apply-remote" && operation.processing) {
		const processing = operation.processing, jobId = processing.ticketId || null
		const reasons = { "policy-skip": "opt_out", "processing-disabled": "disabled", "unsupported-format": "unsupported_format", "too-large": "input_too_large" }
		receipt.processing = { policy: claim?.processingPolicy || "skip", state: processing.state === "historical" ? "historical" : processing.state === "skipped" ? "skipped" : "pending", jobId, statusUrl: jobId ? `/files/processing/jobs/${jobId}` : null, reason: reasons[processing.reason] || null, mayUseModel: path.extname(operation.intent.entries[0].path).toLowerCase() === ".pdf", ...(processing.state === "awaiting-capacity" ? { waitingFor: "capacity" } : {}), ...(processing.state === "historical" ? { outcome: processing.outcome } : {}) }
	}
	return receipt
}

function uploadProcessingPolicy(req) {
	let fields = 0
	for (let index = 0; index < (req.rawHeaders?.length || 0); index += 2) if (req.rawHeaders[index].toLowerCase() === "x-gc-process-document") fields++
	const value = req.headers["x-gc-process-document"]
	if (fields > 1 || value !== undefined && (typeof value !== "string" || !["auto", "skip"].includes(value.trim()))) throw fail(400, "invalid_processing_policy", "Supply X-GC-Process-Document once, with auto or skip. Omission means auto.")
	return value === undefined ? "auto" : value.trim()
}

export function mimeFor(name) { return MIME[path.posix.extname(name).toLowerCase()] || "application/octet-stream" }

/** Stat observations are weak validators, never exact byte revisions. Kept as a named export for callers. */
export function etagFor(statOrObservation) { return `W/"${statOrObservation.token || observationToken(statOrObservation)}"` }

/** Parse an entire entity-tag field, including opaque commas. Reject partially parsed conditions. */
export function parseTags(header) {
	if (header === undefined || header === null) return null
	if (typeof header !== "string") throw fail(400, "invalid_precondition", "Entity-tag conditions must be a single HTTP field.")
	const value = header.trim()
	if (value === "*") return "*"
	const tags = []
	let offset = 0
	while (offset < value.length) {
		const match = /^(W\/)?("[\x21\x23-\x7e\x80-\xff]*")/.exec(value.slice(offset))
		if (!match) throw fail(400, "invalid_precondition", "Use * or a comma-separated list of quoted entity tags.")
		tags.push({ weak: Boolean(match[1]), tag: match[2] })
		offset += match[0].length
		while (value[offset] === " " || value[offset] === "\t") offset++
		if (offset === value.length) return tags
		if (value[offset++] !== ",") break
		while (value[offset] === " " || value[offset] === "\t") offset++
		if (offset === value.length) break
	}
	throw fail(400, "invalid_precondition", "Use * or a comma-separated list of quoted entity tags.")
}

export function strongIfMatch(tags, etag) {
	if (tags === "*") return true
	const current = parseTags(etag)?.[0]
	return Boolean(current && !current.weak && tags?.some((tag) => !tag.weak && tag.tag === current.tag))
}
export function weakIfNoneMatch(tags, etag) {
	if (tags === "*") return true
	const current = parseTags(etag)?.[0]
	return Boolean(current && tags?.some((tag) => tag.tag === current.tag))
}

function contentDisposition(name, download) {
	const filename = path.posix.basename(name) || "download"
	const ascii = filename.replace(/[^\x20-\x7e]|["\\]/g, "_")
	const utf8 = encodeURIComponent(filename).replace(/['()*]/g, (character) => `%${character.charCodeAt(0).toString(16).toUpperCase()}`)
	return `${download || activeExtensions.has(path.posix.extname(name).toLowerCase()) ? "attachment" : "inline"}; filename="${ascii}"; filename*=UTF-8''${utf8}`
}

function json(res, status, body, headers = {}, { version = true, head = false } = {}) {
	const payload = JSON.stringify(version ? { ...body, filesContractVersion: FILES_CONTRACT_VERSION } : body)
	res.writeHead(status, { "content-type": "application/json; charset=utf-8", "content-length": Buffer.byteLength(payload), "cache-control": "no-store", "x-content-type-options": "nosniff", ...headers })
	res.end(head ? undefined : payload)
}

function contentLength(req) {
	const raw = req.headers["content-length"]
	if (raw === undefined) return undefined
	if (typeof raw !== "string" || !/^[0-9]+$/.test(raw) || !Number.isSafeInteger(Number(raw))) throw fail(400, "invalid_content_length", "Content-Length must be a nonnegative safe decimal integer.")
	return Number(raw)
}

function identityEncoding(req) {
	const encoding = req.headers["content-encoding"]
	if (encoding !== undefined && (typeof encoding !== "string" || encoding.trim().toLowerCase() !== "identity")) throw fail(415, "encoding_unavailable", "Request bodies must use identity content encoding.")
}

/** Event-based reading keeps the request socket available for a structured 413 response. */
export async function jsonBody(req, optional = false) {
	identityEncoding(req)
	const declared = contentLength(req)
	if (declared > FILES_JSON_MAX_BYTES) throw fail(413, "request_limit", "JSON request bodies are limited to 64 KiB.", { limits: { jsonBytes: FILES_JSON_MAX_BYTES } })
	const media = req.headers["content-type"]
	if ((!optional || media !== undefined || (declared !== undefined && declared !== 0)) && (typeof media !== "string" || !/^application\/json(?:\s*;\s*charset\s*=\s*(?:utf-8|"utf-8"))?\s*$/i.test(media))) throw fail(415, "unsupported_media_type", "Use Content-Type: application/json with UTF-8 encoding.")
	const bytes = await new Promise((resolve, reject) => {
		const chunks = []; let length = 0
		const cleanup = () => { req.off("data", data); req.off("end", end); req.off("error", error); req.off("aborted", aborted) }
		const error = (failure) => { cleanup(); reject(failure) }
		const aborted = () => error(fail(400, "request_aborted", "The JSON request ended before its body completed."))
		const data = (chunk) => {
			length += chunk.length
			if (length > FILES_JSON_MAX_BYTES) { req.pause(); error(fail(413, "request_limit", "JSON request bodies are limited to 64 KiB.", { limits: { jsonBytes: FILES_JSON_MAX_BYTES } })); return }
			chunks.push(chunk)
		}
		const end = () => { cleanup(); resolve(Buffer.concat(chunks, length)) }
		req.on("data", data); req.once("end", end); req.once("error", error); req.once("aborted", aborted)
		if (req.aborted) aborted()
		else if (req.readableEnded) end()
	})
	if (declared !== undefined && bytes.length !== declared) throw fail(400, "size_mismatch", "Content-Length does not match the JSON body length.")
	if (!bytes.length && optional) return {}
	if (media === undefined) throw fail(415, "unsupported_media_type", "Nonempty JSON bodies require Content-Type: application/json.")
	try {
		const value = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes))
		if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("not an object")
		return value
	} catch { throw fail(400, "invalid_json", "Supply a valid UTF-8 JSON object.") }
}

const routes = FILES_ROUTES.map((entry) => ({ ...entry, keys: [...entry.path.matchAll(/\{(\w+)\}/g)].map((match) => match[1]), pattern: new RegExp(`^${entry.path.replace(/[.*+?^$()|[\]\\]/g, "\\$&").replace(/\{\w+\}/g, "([^/]+)")}$`) }))

function parameters(entry, url) {
	const allowed = new Set(entry.parameters.filter((parameter) => parameter.in === "query").map((parameter) => parameter.name))
	const params = {}
	const pairs = url.search.slice(1) ? url.search.slice(1).split("&").map((entry) => {
		const separator = entry.indexOf("="), fields = separator < 0 ? [entry, ""] : [entry.slice(0, separator), entry.slice(separator + 1)]
		try { return fields.map((field) => decodeURIComponent(field.replace(/\+/g, " "))) } catch { throw fail(400, "invalid_path", "Query parameters require valid UTF-8 transport encoding.") }
	}) : []
	for (const [name, value] of pairs) {
		if (!allowed.has(name) || Object.hasOwn(params, name)) throw fail(400, "invalid_parameter", `Unsupported or repeated query parameter: ${name}.`)
		params[name] = value
	}
	for (const parameter of entry.parameters) if (parameter.in === "query" && parameter.required && (!Object.hasOwn(params, parameter.name) || !params[parameter.name])) throw fail(400, "invalid_parameter", `${parameter.name} is required.`)
	if (entry.processing) for (const { name, in: location, schema } of entry.parameters) {
		if (location !== "query") continue
		if (!Object.hasOwn(params, name)) { if (schema.default !== undefined) params[name] = schema.default; continue }
		const value = params[name]
		if (schema.type === "integer") {
			const number = Number(value)
			if (!/^[0-9]+$/.test(value) || !Number.isSafeInteger(number) || number < schema.minimum || number > schema.maximum) throw fail(400, "invalid_parameter", `${name} must be a decimal integer from ${schema.minimum} to ${schema.maximum}.`)
			params[name] = number
		} else if (schema.pattern) identifier(value, name)
		else if (!value) throw fail(400, "invalid_parameter", `${name} must not be empty.`)
	}
	return params
}

function singleRange(raw, size) {
	const match = typeof raw === "string" && /^bytes=([0-9]*)-([0-9]*)$/i.exec(raw.trim())
	if (!match || (!match[1] && !match[2])) throw fail(416, "range_not_satisfiable", "Supply one byte range; malformed and multiple ranges are unsupported.", { sizeBytes: size })
	const first = match[1] ? BigInt(match[1]) : null, last = match[2] ? BigInt(match[2]) : null, total = BigInt(size)
	if (first !== null && last !== null && first > last) throw fail(416, "range_not_satisfiable", "The byte range end precedes its start.", { sizeBytes: size })
	return () => {
		if (!size || (first === null && last === 0n) || (first !== null && first >= total)) throw fail(416, "range_not_satisfiable", "The byte range has no bytes in this representation.", { sizeBytes: size })
		const start = first === null ? total > last ? total - last : 0n : first
		const end = first === null || last === null || last >= total ? total - 1n : last
		return { start: Number(start), end: Number(end) }
	}
}

function ifRangeMatches(value, etag) {
	// No Last-Modified date is promoted to a strong validator. Exact resume uses a protected ETag.
	if (typeof value !== "string" || etag.startsWith("W/")) return false
	try { const tags = parseTags(value); return tags !== "*" && tags?.length === 1 && strongIfMatch(tags, etag) } catch { return false }
}

export class FilesApi {
	constructor(workspace, logger) {
		this.logger = logger
		this.active = new Set()
		if (typeof workspace?.info === "function") this.workspace = workspace
		else this.config = workspace
	}

	async #workspace() {
		if (this.closed) throw fail(503, "storage_unavailable", "The HTTP file adapter is closed.", { action: "Restart the file service and retry." })
		if (this.workspace) return this.workspace
		// Gateway callers can pass config; importing/opening native state is lazy and shared once.
		this.opening ||= import("./workspace-files.js").then(({ WorkspaceFiles }) => WorkspaceFiles.open(this.config, this.logger)).then((workspace) => (this.workspace = workspace))
		return this.opening
	}

	#signal(req, res) {
		const controller = new AbortController()
		const abort = () => controller.abort(new DOMException("The file requester disconnected.", "AbortError"))
		const close = () => { if (!res.writableFinished) abort() }
		req.once("aborted", abort); res.once("close", close)
		this.active.add(controller)
		if (req.aborted || res.destroyed) abort()
		return { signal: controller.signal, cleanup: () => { req.off("aborted", abort); res.off("close", close); this.active.delete(controller) } }
	}

	/** Returns false only for another route family. Unknown file routes return a structured 404. */
	async handle(req, res, url = new URL(req.url, "http://files")) {
		if (url.pathname !== "/files" && !url.pathname.startsWith("/files/")) return false
		let entry, params, responseHeaders = {}
		try {
			const workspace = await this.#workspace()
			const fenceError = workspaceFenceError(req, workspace.identity)
			if (fenceError) {
				// Reading a bounded JSON locator cannot admit file work. Upload bytes are never read here.
				const candidate = routes.find((route) => route.pattern.test(url.pathname) && route.method === req.method)
				if (candidate?.body && candidate.body !== "upload") {
					try { correlateFence(fenceError, await jsonBody(req, candidate.body === "optional")) } catch { /* Keep the identity rejection when the locator is unavailable. */ }
				}
				for (const name of ["operationId", "requestId"]) if (url.searchParams.getAll(name).length === 1) correlateFence(fenceError, { [name]: url.searchParams.get(name) })
				throw fenceError
			}
			const matched = routes.filter((candidate) => candidate.pattern.test(url.pathname))
			if (!matched.length) throw fail(404, "not_found", "Unknown file-service route.")
			entry = matched.find((candidate) => candidate.method === req.method)
			if (!entry) { responseHeaders.Allow = matched.map((candidate) => candidate.method).join(", "); throw fail(405, "method_not_allowed", "This route does not support the requested method.") }
			params = parameters(entry, url)
			const ids = {}, match = entry.pattern.exec(url.pathname)
			for (const [index, key] of entry.keys.entries()) {
				try { ids[key] = decodeURIComponent(match[index + 1]) } catch { throw fail(400, "invalid_id", `Malformed encoded ${key}.`) }
				identifier(ids[key], key)
			}
			const id = ids[entry.key]
			if (entry.handler === "openapi") { json(res, 200, buildFilesOpenApi({ limits: this.workspace?.limits }), {}, { version: false }); return true }
			if (entry.processing && !workspace.processing) throw fail(503, "processing_unavailable", "The document processing coordinator is unavailable.", { action: "Restart the file service with document processing configured." })
			const body = entry.body && entry.body !== "upload" ? await jsonBody(req, entry.body === "optional") : undefined
			let result
			switch (entry.handler) {
				case "info": result = await workspace.info({ privateBootstrap: req.privateBootstrap === true }); break
				case "stat": result = await workspace.stat(params.path ?? ""); break
				case "list": case "find": case "tree": result = await workspace[entry.handler](params); break
				case "text": result = await workspace.text(params.path, { maxBytes: params.maxBytes }); break
				case "search": {
					const request = this.#signal(req, res)
					try { result = await workspace.search(params, request.signal) } finally { request.cleanup() }
					break
				}
				case "raw": case "sourceRaw": await this.#raw(workspace, req, res, entry, params, id); return true
				case "watch": await workspace.events.attach(req, res, url); return true
				case "upload": result = await this.#upload(workspace, req, params); break
				case "mkdir": case "move": case "delete": result = await workspace[entry.handler](body); break
				case "applyPendingRemote": result = { status: 200, operation: await workspace.applyPendingRemote(body) }; break
				case "restoreRecovery": result = await workspace.restoreRecovery(id, body); break
				case "operation": result = publicOperation(await workspace.operation(id)); break
				case "request": case "job": case "cancelJob": result = await workspace[entry.handler](id); break
				case "recovery": result = await workspace.recovery(); break
				case "preparation": result = await workspace.preparation(body); break
				case "mapViewSave": result = await workspace.mapViewSave(body); break
				case "mapViewLoad": result = await workspace.mapViewLoad(params.path); break
				case "representation": result = await workspace.representation(id); break
				case "representationQuery": case "workbookExport": {
					const request = this.#signal(req, res)
					try { result = await workspace[entry.handler](id, body, request.signal) } finally { request.cleanup() }
					break
				}
				case "captureCreate": result = await workspace.captures.create(body); break
				case "sourceGet": result = await workspace.captures.get(entry.kind, id); break
				case "sourceText": result = await workspace.captures.text(entry.kind, id, { maxBytes: params.maxBytes }); break
				case "preview": result = await workspace.captures.preview(body); break
				case "segments": result = await workspace.captures.segments(entry.kind, id, body); break
				case "lease": result = await workspace.captures.lease(body); break
				case "releaseLease": await workspace.captures.releaseLease(id); result = { leaseId: id, released: true }; break
				case "processingCapabilities": result = await workspace.processing.capabilities(); break
				case "processingSubmit": result = await workspace.processing.submit(body); break
				case "processingList": result = await workspace.processing.list(params); break
				case "processingGet": result = await workspace.processing.get(id); break
				case "processingCancel": result = await workspace.processing.cancel(id); break
				case "processingResults": result = await workspace.processing.results(id); break
				case "processingRows": result = await workspace.processing.rows(id, ids.tableId, params); break
				case "processingProduct": await this.#product(workspace.processing, req, res, id, ids.productId); return true
				default: throw fail(500, "storage_unavailable", "No HTTP handler is registered for this file route.")
			}
			if (res.destroyed) return true
			if (entry.operation) {
				json(res, result.status, { ...publicOperation(result.operation), ...(result.duplicate ? { duplicate: true } : {}) })
			} else if (entry.resultStatus) {
				const { status, ...payload } = result
				json(res, status, payload, entry.location ? { Location: `/files/processing/jobs/${encodeURIComponent(result.job.id)}` } : {})
			} else json(res, 200, result)
			return true
		} catch (error) {
			if (!req.readableEnded && !req.destroyed) req.resume()
			const mapped = fileError(error, `files-http.${entry?.handler || "route"}`)
			const payload = { ...mapped.toJSON() }
			payload.tool = mapped.tool || `files-http.${entry?.handler || "route"}`
			if (!mapped.action || mapped.action === `files-http.${entry?.handler || "route"}`) payload.action = "Inspect the request, file-service logs, and current metadata before retrying."
			this.logger?.error?.("files request failed", { route: url.pathname, status: mapped.status, ...payload })
			if (res.headersSent || res.destroyed) { res.destroy(); return true }
			if (mapped.retryAfter !== undefined) responseHeaders["Retry-After"] = String(mapped.retryAfter)
			if (mapped.etag) responseHeaders.ETag = mapped.etag
			if (mapped.status === 416 && mapped.sizeBytes !== undefined) responseHeaders["Content-Range"] = `bytes */${mapped.sizeBytes}`
			json(res, mapped.status, payload, responseHeaders, { head: req.method === "HEAD" })
			return true
		}
	}

	async #upload(workspace, req, params) {
		const processingPolicy = uploadProcessingPolicy(req)
		identifier(params.operationId)
		identityEncoding(req)
		const declaredSize = contentLength(req)
		const mode = params.mode ?? "create"
		if (!["create", "replace", "force-replace"].includes(mode)) throw fail(400, "invalid_mode", "mode must be create, replace, or force-replace.")
		const baseObservation = req.headers["x-gc-base-observation"]
		if (baseObservation !== undefined && (typeof baseObservation !== "string" || !baseObservation || baseObservation.length > 512 || /[\s\u0000-\u001f\u007f]/u.test(baseObservation))) throw fail(400, "invalid_observation", "X-GC-Base-Observation must contain one opaque observation token.")
		if (mode === "replace" && !baseObservation) throw fail(400, "invalid_observation", "mode=replace requires X-GC-Base-Observation.")
		const declaredDigest = req.headers["x-content-sha256"]
		if (declaredDigest !== undefined && (typeof declaredDigest !== "string" || !/^[0-9a-f]{64}$/.test(declaredDigest))) throw fail(400, "invalid_digest", "X-Content-SHA256 must be a lowercase SHA-256 digest.")
		const persistable = req.headers["x-gc-require-remote-persistable"]
		if (persistable !== undefined && persistable !== "true" && persistable !== "false") throw fail(400, "invalid_request", "X-GC-Require-Remote-Persistable must be true or false.")
		const ifMatch = req.headers["if-match"], ifNoneMatch = req.headers["if-none-match"]
		parseTags(ifMatch); parseTags(ifNoneMatch)
		if (declaredSize > (workspace.limits?.uploadBytes ?? FILE_LIMITS.uploadBytes)) throw fail(413, "transfer_limit", "Content-Length exceeds the local upload ceiling.", { limits: { uploadBytes: workspace.limits?.uploadBytes ?? FILE_LIMITS.uploadBytes } })
		const result = await workspace.upload(req, { path: params.path, operationId: params.operationId, mode, processingPolicy, baseObservation, declaredSize, declaredDigest, requireRemotePersistable: persistable === "true", ifMatch, ifNoneMatch })
		// Duplicate admission returns before reading. Drain transport bytes without storing/hashing them.
		if (!req.readableEnded && !req.destroyed) req.resume()
		return result
	}

	async #product(processing, req, res, id, productId) {
		const request = this.#signal(req, res)
		let response
		try {
			const selected = {}
			for (const name of productRequestHeaders) {
				if (req.method === "HEAD" && ["range", "if-range"].includes(name)) continue
				const value = req.headers[name]
				if (value === undefined) continue
				if (typeof value !== "string") throw fail(400, "invalid_parameter", `${name} must be one HTTP field.`)
				selected[name] = value
			}
			response = await processing.product(id, productId, { method: req.method, headers: selected })
			const headers = { "cache-control": "private, no-cache, no-transform", "x-content-type-options": "nosniff" }
			for (const name of productResponseHeaders) if (response.headers.has(name)) headers[name] = response.headers.get(name)
			if (request.signal.aborted) throw request.signal.reason
			res.writeHead(response.status, headers)
			if (req.method === "HEAD" || !response.body) { res.end(); return }
			await pipeline(Readable.fromWeb(response.body), res, { signal: request.signal })
		} finally {
			request.cleanup()
			if (response?.body && !response.body.locked) await response.body.cancel().catch(() => {})
		}
	}

	async #raw(workspace, req, res, entry, params, id) {
		const request = this.#signal(req, res)
		let opened
		try {
			opened = entry.kind ? await workspace.captures.open(entry.kind, id) : await workspace.openLive(params.path)
			const source = opened.source
			const size = source ? source.kind === "runtime-fragment" ? source.byteEnd - source.byteStart : source.sizeBytes : Number(opened.stat.size)
			if (!Number.isSafeInteger(size) || size < 0) throw fail(400, "unsupported_size", "This representation exceeds the supported byte-offset domain.")
			const etag = source ? source.etag : etagFor(opened.observation)
			const name = source?.ref.path ?? opened.observation.ref.path
			const stat = opened.stat
			const headers = { "content-type": activeExtensions.has(path.posix.extname(name).toLowerCase()) ? "text/plain; charset=utf-8" : mimeFor(name), ETag: etag, "accept-ranges": "bytes", "content-encoding": "identity", "cache-control": "private, no-cache, no-transform", "x-content-type-options": "nosniff", "content-disposition": contentDisposition(name, params.download === "1") }
			if (stat?.mtime instanceof Date && Number.isFinite(stat.mtime.getTime())) headers["last-modified"] = stat.mtime.toUTCString()
			const match = parseTags(req.headers["if-match"])
			if (match && !strongIfMatch(match, etag)) { json(res, 412, fail(412, "precondition_failed", "If-Match does not strongly match this representation.", { etag }).toJSON(), { ETag: etag }, { head: req.method === "HEAD" }); return }
			const none = parseTags(req.headers["if-none-match"])
			if (none && weakIfNoneMatch(none, etag)) { res.writeHead(304, headers); res.end(); return }
			let start = 0, end = size - 1, status = 200
			if (req.method === "GET" && req.headers.range !== undefined) {
				const select = singleRange(req.headers.range, size)
				if (req.headers["if-range"] === undefined || ifRangeMatches(req.headers["if-range"], etag)) { ({ start, end } = select()); status = 206; headers["content-range"] = `bytes ${start}-${end}/${size}` }
			}
			headers["content-length"] = size ? end - start + 1 : 0
			if (request.signal.aborted) throw request.signal.reason
			if (req.method === "HEAD" || !size) { res.writeHead(status, headers); res.end(); return }
			// The service's protected reader owns the descriptor until release(), including aborts.
			const stream = opened.handle.createReadStream({ start, end, autoClose: false })
			res.writeHead(status, headers)
			await pipeline(stream, res, { signal: request.signal })
		} finally {
			request.cleanup()
			if (opened?.release) await opened.release()
			else if (opened?.handle) await opened.handle.close()
		}
	}

	close() {
		if (this.closing) return this.closing
		this.closed = true
		for (const controller of this.active) controller.abort(new DOMException("The HTTP file adapter is closing.", "AbortError"))
		this.closing = (async () => { if (this.config && this.opening) await (await this.opening).close() })()
		return this.closing
	}
}
