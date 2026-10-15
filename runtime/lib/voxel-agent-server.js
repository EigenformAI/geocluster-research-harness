import crypto from "node:crypto"
import { constants } from "node:fs"
import fs from "node:fs/promises"
import http from "node:http"
import net from "node:net"
import path from "node:path"
import { Readable } from "node:stream"
import { setTimeout as wait } from "node:timers/promises"
import { createVoxelAgentBridge } from "./voxel-agent.js"
import { createVoxelAgentReferences } from "./voxel-agent-references.js"
import { exactFields, ordinaryPath, sameScope, VOXEL_ENDPOINT, VOXEL_SOCKET } from "./voxel-agent-contract.js"
import { canonicalPath, FileError } from "./file-contract.js"
import { fail, VoxelError } from "./voxel-request.js"
import { checkNpyVolume, describeNpy, NpyError, parseNpyHeader } from "./voxel/npy.js"

export const VOXEL_AGENT_BODY_BYTES = 1024 * 1024
const sameObject = (a, b) => a && b && a.dev === b.dev && a.ino === b.ino
const socketFailure = () => fail(503, "socket_unavailable", "Provision a service-owned 0750 socket directory and the geocluster connection group before enabling voxel agent work.")

function reply(res, status, body) {
	const bytes = Buffer.from(JSON.stringify(body))
	res.writeHead(status, { "content-type": "application/json; charset=utf-8", "content-length": bytes.length, "cache-control": "no-store", "x-content-type-options": "nosniff" })
	res.end(bytes)
}
function publicFailure(error) {
	if (error instanceof VoxelError) return error
	const codes = { EACCES: [403, "invalid_source_path"], ELOOP: [403, "invalid_source_path"], ENOTDIR: [403, "invalid_source_path"], ENOENT: [404, "source_not_found"], EINVAL: [400, "invalid_source_path"], EEXIST: [409, "exists"] }
	const [status, code] = codes[error.code] || [error.status || 503, error.error || "storage_unavailable"]
	// File/native exceptions can carry private paths. Only the voxel service's
	// public errors are exposed verbatim; private adapters keep details in logs.
	const failure = fail(status, code, "Voxel work could not complete. Check the source path, retained operation and runtime storage before retrying.")
	// Only typed file-service retry scalars are safe across this private boundary.
	// Never forward its free text, nested details or native exception properties.
	if (error instanceof FileError) {
		if (Number.isSafeInteger(error.retryAfter) && error.retryAfter >= 0) failure.retryAfter = error.retryAfter
		if (typeof error.retryAt === "string" && /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/.test(error.retryAt) && Number.isFinite(Date.parse(error.retryAt)) && new Date(error.retryAt).toISOString() === error.retryAt) failure.retryAt = error.retryAt
	}
	return failure
}
async function body(req, signal) {
	if (req.headers["content-encoding"] !== undefined && req.headers["content-encoding"] !== "identity") throw fail(415, "unsupported_encoding", "Send uncompressed JSON bytes.")
	const declared = req.headers["content-length"]
	if (declared !== undefined && (!/^\d+$/.test(declared) || Number(declared) > VOXEL_AGENT_BODY_BYTES)) throw fail(413, "body_limit", "Voxel agent requests are limited to 1 MiB of JSON bytes.")
	// Event-based bounded accumulation lets us reply 413 without the async
	// iterator destroying the socket when it stops before the request's end.
	return new Promise((resolve, reject) => {
		const chunks = []; let bytes = 0
		const cleanup = () => { req.off("data", data); req.off("end", end); req.off("error", failed); req.off("aborted", aborted); signal.removeEventListener("abort", stopped) }
		const failed = (error) => { cleanup(); reject(error) }
		const aborted = () => failed(fail(400, "invalid_request", "The JSON request ended before completion."))
		const stopped = () => { req.pause(); failed(signal.reason) }
		const data = (chunk) => {
			bytes += chunk.length
			if (bytes > VOXEL_AGENT_BODY_BYTES) { req.pause(); failed(fail(413, "body_limit", "Voxel agent requests are limited to 1 MiB of JSON bytes.")); return }
			chunks.push(chunk)
		}
		const end = () => {
			cleanup()
			try {
				const value = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(Buffer.concat(chunks)))
				if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error()
				resolve(value)
			} catch { reject(fail(400, "invalid_request", "Send a complete UTF-8 JSON object.")) }
		}
		req.on("data", data); req.on("end", end); req.on("error", failed); req.on("aborted", aborted)
		signal.addEventListener("abort", stopped, { once: true })
		if (signal.aborted) stopped()
	})
}

/** Runtime-owned effect adapters. Live files are opened only through SafeFs;
 * replacements use the same create-only protected publication as browser files. */
function adapters(workspace) {
	const service = workspace.voxels, identity = { ...workspace.identity }
	function fence(scope) { if (!sameScope(scope, identity) || !sameScope(identity, workspace.identity) || !sameScope(identity, workspace.state.identity)) throw fail(409, "stale_workspace", "Voxel scope belongs to another workspace epoch. Reconnect before starting fresh work.") }
	function sourcePath(resource, conversationId) {
		if (!ordinaryPath(resource) || canonicalPath(resource, { root: false }) !== resource || resource.startsWith("runs/") && !resource.startsWith(`runs/${conversationId}/`)) throw fail(400, "invalid_source_path", "Use an ordinary source in the workspace or this conversation's run folder.")
		return resource
	}
	async function preflight(resource, conversationId, destination = false) {
		sourcePath(resource, conversationId)
		if (!destination) {
			const opened = await workspace.safeFs.open(resource)
			try {
				const stat = await opened.stat()
				if (!stat.isFile()) throw fail(400, "invalid_source_path", "Select a regular source file.")
				if (stat.size > service.limits.sourceBytes) throw fail(413, "source_limit", "The source exceeds the voxel byte ceiling. Select a smaller source.")
			} finally { await opened.close() }
			return
		}
		// Check existing parents and the final target before upload admission can
		// claim state or retain bytes. Publication repeats SafeFs checks at commit.
		const parts = resource.split("/")
		for (let i = 1; i <= parts.length; i++) {
			const prefix = parts.slice(0, i).join("/")
			workspace.safeFs.policy.assertWrite(prefix)
			let stat
			try { stat = await workspace.safeFs.stat(prefix) } catch (error) { if (error.code === "ENOENT") break; throw error }
			if (i === parts.length) throw fail(409, "exists", "The replacement destination already exists. Choose a new CSV path in this conversation's results folder.")
			if (!stat.isDirectory()) throw fail(400, "invalid_destination", "Replacement parents must be ordinary directories.")
		}
	}
	async function completed(result, scope) {
		if (!result.jobId) return result
		for (;;) {
			fence(scope)
			const job = await workspace.job(result.jobId)
			if (job.state === "succeeded") return job.result
			if (["failed", "cancelled", "interrupted"].includes(job.state)) throw fail(job.error?.status || 503, "preparation_failed", "Source preparation did not complete. Check runtime storage or select another source.")
			await wait(10)
		}
	}
	function binding(captured, resource, scope) {
		fence(scope)
		if (!captured?.ref || !sameScope({ workspaceId: captured.ref.workspaceId, workspaceEpoch: captured.ref.workspaceEpoch }, scope) || captured.ref.path !== resource || captured.digest?.state !== "ready" || !/^[0-9a-f]{64}$/.test(captured.digest.sha256) || !/^[0-9a-f-]{36}$/.test(captured.captureId)) throw fail(503, "invalid_capture", "Source preparation requires a complete ready SHA-256 capture in this workspace epoch.")
		return { root: "workspace", resourceId: resource, path: resource, sha256: captured.digest.sha256, revision: `capture:${captured.captureId}` }
	}
	async function npyDescription(source) {
		const opened = await service.resolve(source)
		try {
			// The shared parser accepts a bounded header prefix. No array values or
			// full payload allocation are needed to describe captured NPY metadata.
			if (opened.source.sizeBytes > service.limits.sourceBytes) throw fail(413, "source_limit", "The captured NPY exceeds the voxel byte ceiling. Select a smaller source.")
			const bytes = Buffer.alloc(Math.min(opened.source.sizeBytes, 1024 * 1024 + 12)); let at = 0
			while (at < bytes.length) {
				const { bytesRead } = await opened.handle.read(bytes, at, bytes.length - at, at)
				if (!bytesRead) throw fail(503, "source_integrity", "The protected NPY header is truncated. Capture the source again.")
				at += bytesRead
			}
			const header = parseNpyHeader(bytes), shape = checkNpyVolume(header, opened.source.sizeBytes, service.limits.cells)
			return { shape, dtype: header.dtype.descr, fortranOrder: header.fortranOrder, version: header.version, label: describeNpy(header) }
		} catch (error) { if (error instanceof NpyError) throw fail(422, "invalid_npy", error.message); throw error }
		finally { await opened.release() }
	}
	return {
		fence, sourcePath, preflight,
		async captureSource({ path: resource, options = {}, scope, conversationId }) {
			fence(scope); service.requireAdmission()
			if (!exactFields(options, ["range", "headerRows", "sheet"], [])) throw fail(400, "invalid_request", "Source preparation options are range, headerRows and workbook sheet.")
			const extension = path.posix.extname(resource).toLowerCase()
			if (![".csv", ".tsv", ".npy", ".xls", ".xlsx"].includes(extension)) throw fail(415, "unsupported_source", "Prepare a CSV, TSV, numeric NPY or supported stored-value workbook source.")
			if ([".xls", ".xlsx"].includes(extension) && workspace.workbooks.availability.state !== "available") throw fail(503, "workbook_unavailable", "Stored workbook values are unavailable. Enable the workbook provider or export the sheet as CSV or TSV.")
			await preflight(resource, conversationId)
			fence(scope)
			const capture = await completed(await workspace.captures.create({ requestId: crypto.randomUUID(), path: resource, computeDigest: true }), scope)
			const source = binding(capture.source, resource, scope), common = { path: resource, source, sizeBytes: capture.source.sizeBytes }
			if (extension === ".npy") return { ...common, profile: "npy", description: await npyDescription(source) }
			let input, workbook
			if ([".xls", ".xlsx"].includes(extension)) {
				fence(scope)
				const prepared = await completed(await workspace.preparation({ requestId: crypto.randomUUID(), type: "workbook", source: capture.source, options: {} }), scope)
				workbook = prepared.representation
				const sheet = options.sheet === undefined ? workbook.sheets.find((s) => s.kind === "worksheet" && s.modes.includes("stored")) : workbook.sheets.find((s) => s.id === options.sheet)
				if (!sheet) throw fail(400, "unsupported_sheet", "Choose a prepared worksheet with stored values.")
				input = { type: "workbook", resourceId: resource, source, workbookId: workbook.id, sheet: sheet.id }
			} else {
				if (options.sheet !== undefined) throw fail(400, "invalid_request", "Only workbook sources accept a sheet selector.")
				input = { type: "delimited", resourceId: resource, source, delimiter: extension === ".tsv" ? "\t" : "," }
			}
			fence(scope)
			const description = await service.describe(input, options.range ?? null, options.headerRows ?? [0])
			return { ...common, profile: workbook ? "workbook-stored" : extension.slice(1), input, description, ...(workbook ? { sheets: workbook.sheets.map(({ id, name, rows, columns, kind, modes }) => ({ id, name, rows, columns, kind, modes })) } : {}) }
		},
		async saveReplacement({ csv, destination, scope, conversationId }) {
			fence(scope); service.requireAdmission()
			if (!destination.startsWith(`runs/${conversationId}/results/`) || !destination.endsWith(".csv")) throw fail(400, "invalid_destination", "Choose a new CSV path in this conversation's results folder.")
			await preflight(destination, conversationId, true)
			const bytes = Buffer.from(csv)
			fence(scope)
			const published = await workspace.upload(Readable.from([bytes]), { operationId: `voxel-agent-${crypto.randomUUID()}`, path: destination, mode: "create", declaredSize: bytes.length, declaredDigest: crypto.createHash("sha256").update(bytes).digest("hex"), processingPolicy: "skip" })
			if (published.operation.state !== "committed") throw fail(503, "publication_unknown", "Replacement publication is unconfirmed. Inspect runtime file operations before preparing another replacement.")
			const source = binding(published.operation.publishedSource, destination, scope)
			return { source, input: { type: "delimited", resourceId: destination, source, delimiter: "," } }
		},
	}
}

async function checkedSocket(socketPath, gid, workspace) {
	const uid = process.geteuid(), agents = workspace.config.filesAgentUids || [999]
	if (!path.isAbsolute(socketPath) || path.normalize(socketPath) !== socketPath || agents.includes(uid) || !Number.isSafeInteger(gid) || gid < 0 || gid > 0xffffffff) throw socketFailure()
	// Production has one address and group. Factory overrides exist only under
	// Node's test runner; no environment-supplied alternate endpoint is accepted.
	if ((socketPath !== VOXEL_SOCKET || gid !== 999) && !process.env.NODE_TEST_CONTEXT) throw socketFailure()
	const parentPath = path.dirname(socketPath)
	for (let current = parentPath; ; current = path.dirname(current)) {
		const stat = await fs.lstat(current)
		if (!stat.isDirectory() || ![0, uid].includes(stat.uid) || agents.includes(stat.uid) || (stat.mode & 0o022)) throw socketFailure()
		if (current === parentPath && ((stat.mode & 0o7777) !== 0o750 || stat.gid !== gid)) throw socketFailure()
		if (current === "/") break
	}
	const parent = await fs.open(parentPath, constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW)
	try {
		if (!sameObject(await parent.stat(), await fs.lstat(parentPath))) throw socketFailure()
		// Pin bind, mode changes and cleanup to this trusted directory capability.
		const address = `/proc/self/fd/${parent.fd}/${path.basename(socketPath)}`
		let existing
		try { existing = await fs.lstat(address) } catch (error) { if (error.code !== "ENOENT") throw error }
		if (existing) {
			if (!existing.isSocket() || existing.uid !== uid || existing.gid !== gid || (existing.mode & 0o777) !== 0o660) throw socketFailure()
			await new Promise((resolve, reject) => {
				const probe = net.createConnection(address)
				probe.once("connect", () => { probe.destroy(); reject(fail(503, "socket_in_use", "The voxel agent socket is already in use.")) })
				probe.once("error", (error) => { probe.destroy(); error.code === "ECONNREFUSED" ? resolve() : reject(socketFailure()) })
				probe.setTimeout(1000, () => { probe.destroy(); reject(socketFailure()) })
			})
			if (!sameObject(existing, await fs.lstat(address))) throw socketFailure()
			await fs.unlink(address) // Only our own stale socket, never a symlink or live listener.
		}
		return { parent, address }
	} catch (error) { await parent.close(); throw error }
}

function byDeadline(work, deadline) {
	let timer
	return Promise.race([work, new Promise((_, reject) => { timer = setTimeout(() => reject(fail(503, "drain_timeout", "Voxel agent work did not drain before the deadline. Retain runtime state and inspect pending work.")), Math.max(0, Date.parse(deadline) - Date.now())) })]).finally(() => clearTimeout(timer))
}

/** One credential-free, permission-restricted Unix HTTP surface, never a proxy. */
export async function createVoxelAgentServer({ workspace, config, logger }) {
	const effects = adapters(workspace), references = createVoxelAgentReferences(workspace), bridge = createVoxelAgentBridge(workspace.voxels, { ...effects, references })
	const socketPath = config.voxelAgentSocket || VOXEL_SOCKET, gid = config.voxelAgentGid ?? 999
	const { parent, address } = await checkedSocket(socketPath, gid, workspace)
	let admitting = true, closing
	const pending = new Set(), reading = new Set()
	const server = http.createServer((req, res) => {
		const work = (async () => {
			try {
				if (req.url !== VOXEL_ENDPOINT) throw fail(404, "not_found", "Use POST /agent/voxels.")
				if (req.method !== "POST") throw fail(405, "method", "Use POST /agent/voxels.")
				if (!admitting) throw fail(503, "draining", "Voxel agent work is draining. Retry after runtime restart.")
				const controller = new AbortController(); reading.add(controller)
				let value
				try { value = await body(req, controller.signal) } finally { reading.delete(controller) }
				if (value.action !== "capabilities" || value.scope !== null) effects.fence(value.scope)
				if (!admitting) throw fail(503, "draining", "Voxel agent work is draining. Retry after runtime restart.")
				// Only complete, fenced, admitted dispatches join the drain barrier.
				// Connections still reading bodies cannot extend accepted work.
				const active = Promise.resolve().then(async () => {
					// The bridge owns action schemas. This additional path policy applies
					// before materialization, capture, validation or key admission effects.
					if (value.action === "prepare" && value.path !== undefined) await effects.preflight(value.path, value.conversationId)
					if (value.action === "prepare" && value.destination !== undefined) await effects.preflight(value.destination, value.conversationId, true)
					for (const source of [value.artifact?.manifest, value.submission?.recipe?.scope?.input?.source, value.submission?.recipe?.source, value.submission?.revision?.base?.manifest]) if (source?.path !== undefined) effects.sourcePath(source.path, value.conversationId)
					return bridge.dispatch(value)
				})
				pending.add(active)
				try { reply(res, 200, await active) } finally { pending.delete(active) }
			} catch (error) {
				logger.error?.("voxel agent request failed", { error: error.error || error.code || "storage_unavailable" })
				if (!res.headersSent) { res.setHeader("connection", "close"); const failure = publicFailure(error); if (failure.retryAfter !== undefined) res.setHeader("retry-after", String(failure.retryAfter)); reply(res, failure.status, failure.toJSON()) }
				else res.destroy()
			}
		})()
		work.catch(() => res.destroy())
	})
	server.requestTimeout = 30000; server.headersTimeout = 10000
	try {
		await new Promise((resolve, reject) => { server.once("error", reject); server.listen(address, resolve) })
		const stat = await fs.lstat(address)
		if (!stat.isSocket() || stat.uid !== process.geteuid()) throw socketFailure()
		await fs.chown(address, process.geteuid(), gid); await fs.chmod(address, 0o660)
	} catch (error) {
		await new Promise((resolve) => server.close(resolve)); await parent.close(); throw error
	}
	const stopAdmission = () => {
		admitting = false
		for (const controller of reading) controller.abort(fail(503, "draining", "Voxel agent work is draining. Retry after runtime restart."))
	}
	const drain = async (deadline) => {
		stopAdmission()
		await byDeadline((async () => { while (pending.size) await Promise.allSettled([...pending]) })(), deadline)
	}
	const close = (deadline = new Date(Date.now() + 30000).toISOString()) => {
		if (closing) return closing
		stopAdmission()
		closing = (async () => {
			const closed = new Promise((resolve) => server.close(resolve))
			const timer = setTimeout(() => server.closeAllConnections(), Math.max(0, Date.parse(deadline) - Date.now()))
			try { await drain(deadline); server.closeIdleConnections(); await byDeadline(closed, deadline) }
			finally { server.closeAllConnections(); clearTimeout(timer); await closed; await parent.close() }
		})()
		return closing
	}
	return { server, socketPath, references, stopAdmission, drain, close }
}
