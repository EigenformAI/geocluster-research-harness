import fs from "node:fs/promises"
import http from "node:http"
import path from "node:path"
import net from "node:net"
import { randomUUID } from "node:crypto"
import { ProcessingError } from "./processing-operations.js"
import { NativeProcessingOperations } from "./native-processing-operations.js"
import { fdPath, publishPrivateJSON } from "./native-processing-receipts.js"

const fail = (code, message, details) => new ProcessingError(code, message, details)
const actions = new Set(["capabilities", "history", "submit", "status", "wait", "cancel", "result", "readTable", "readText", "exportProduct"])
const sameScope = (a, b) => a?.workspaceId === b?.workspaceId && a?.workspaceEpoch === b?.workspaceEpoch && Object.keys(a).length === 2
function reply(res, status, value) {
	if (res.destroyed) return
	const bytes = Buffer.from(JSON.stringify(value))
	res.writeHead(status, { "content-type": "application/json", "content-length": bytes.length, "cache-control": "no-store" }); res.end(bytes)
}
function readBody(req, signal) {
	return new Promise((resolve, reject) => {
		let size = 0; const chunks = []
		const cleanup = () => { req.off("data", data); req.off("end", end); req.off("error", error); req.off("aborted", aborted); signal.removeEventListener("abort", aborted) }
		const error = (reason) => { cleanup(); req.pause(); reject(reason) }
		const aborted = () => error(fail("ABORTED", "Document request ended before admission."))
		const data = (chunk) => { size += chunk.length; if (size > 1024 * 1024) return error(fail("BODY_LIMIT", "Document requests are limited to 1 MiB.")); chunks.push(chunk) }
		const end = () => { cleanup(); try { const value = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(Buffer.concat(chunks))); if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error(); resolve(value) } catch { reject(fail("INVALID_REQUEST", "Send a UTF-8 JSON object.")) } }
		req.on("data", data); req.on("end", end); req.on("error", error); req.on("aborted", aborted); signal.addEventListener("abort", aborted, { once: true })
		if (signal.aborted) aborted()
	})
}

/** Called only AFTER readiness, with a lease acquired BEFORE NativeProcessingOwner.start(). */
export async function createNativeProcessingBridge({ lease, workspace, projectId, model, invocationId = randomUUID(), client, inputBytes, logger }) {
	if (!lease || lease.released) throw fail("WRITER_LEASE_REQUIRED", "Acquire the native writer lease before starting the processor owner.")
	if (typeof projectId !== "string" || !/^[A-Za-z0-9_.:-]{1,128}$/.test(projectId) || typeof invocationId !== "string" || typeof model !== "string") throw fail("INVALID_CONFIGURATION", "Native bridge requires project, invocation and model identity.")
	const capabilities = await client.capabilities()
	if (typeof capabilities.storeScope !== "string" || !/^[A-Za-z0-9_.:-]{1,128}$/.test(capabilities.storeScope) || !capabilities.serviceGeneration) throw fail("PROCESSOR_IDENTITY_UNAVAILABLE", "Authenticated processor capabilities must advertise storeScope and serviceGeneration.")
	client.bindStoreScope?.(capabilities.storeScope); client.storeScope = capabilities.storeScope
	const scope = { workspaceId: projectId, workspaceEpoch: capabilities.storeScope }, socketPath = path.join(lease.clientDir, "documents.sock"), address = fdPath(lease.directory, "documents.sock")
	const operations = await NativeProcessingOperations.open({ lease, workspace, scope, client, logger, invocationId, ...(inputBytes ? { inputBytes } : {}) })
	let endLifetime
	const lifetime = lease.track(new Promise((resolve) => { endLifetime = resolve }))
	let admitting = true, closed = false, closing, socketIdentity
	const reading = new Set(), pending = new Set(), connections = new Set()
	const descriptor = { scope, invocationId, model, socketPath }
	const server = http.createServer((req, res) => {
		const work = (async () => {
			let envelope
			try {
				if (req.method !== "POST" || req.url !== "/agent/documents") throw fail("NOT_FOUND", "Use POST /agent/documents.", { status: 404 })
				if (!admitting) throw fail("DRAINING", "Native document admission is closed.", { status: 503 })
				if (req.headers["content-encoding"] && req.headers["content-encoding"] !== "identity") throw fail("INVALID_REQUEST", "Send uncompressed JSON.")
				const controller = new AbortController(); reading.add(controller)
				try { envelope = await readBody(req, controller.signal) } finally { reading.delete(controller) }
				if (!actions.has(envelope.action) || Object.keys(envelope).some((key) => !["action", "scope", "invocationId", "caller", "input"].includes(key)) || !envelope.input || typeof envelope.input !== "object" || Array.isArray(envelope.input)) throw fail("INVALID_REQUEST", "Use a supported document action and input object.")
				if (!sameScope(envelope.scope, scope)) throw fail("SCOPE_MISMATCH", "Document request belongs to another workspace or processor store.", { status: 409 })
				if (envelope.invocationId !== invocationId) throw fail("OWNER_CHANGED", "Native owner changed; reopen discovery and recover the original handle only if persistent scope still matches.", { status: 409 })
				if (!admitting) throw fail("DRAINING", "Native document admission is closed.", { status: 503 })
				const observation = new AbortController(), disconnect = () => observation.abort()
				res.once("close", disconnect)
				// Only waits are cancelled on disconnect. Admitted receipt/export effects always join drain.
				try {
					const result = await operations[envelope.action](envelope.caller, envelope.input, { signal: observation.signal })
					reply(res, 200, { scope, invocationId, result })
				} finally { res.off("close", disconnect) }
			} catch (error) {
				const typed = error instanceof ProcessingError
				const code = typed ? error.code : error.name === "AbortError" ? "ABORTED" : "PROCESSING_FAILED"
				reply(res, typed ? error.status || 400 : 503, { error: { code, message: typed ? error.message : "Native processing could not complete. Inspect retained history before starting new work.", action: typed ? error.action : "Inspect retained request history and runtime readiness.", ...(error.requestId || envelope?.input?.requestId ? { requestId: error.requestId || envelope.input.requestId } : {}), ...(error.exportId ? { exportId: error.exportId } : {}) } })
			}
		})()
		pending.add(work); work.finally(() => pending.delete(work)).catch(() => {})
	})
	server.on("connection", (socket) => { connections.add(socket); socket.once("close", () => connections.delete(socket)) })
	server.requestTimeout = 10000; server.headersTimeout = 10000
	async function withdraw() { await fs.unlink(fdPath(lease.directory, "connection.json")).catch((error) => { if (error.code !== "ENOENT") throw error }); await lease.directory.sync() }
	async function removeSocket() {
		if (!socketIdentity) return
		const current = await fs.lstat(address).catch((error) => { if (error.code !== "ENOENT") throw error; return null })
		if (current?.dev === socketIdentity.dev && current?.ino === socketIdentity.ino) { await fs.unlink(address); await lease.directory.sync() }
	}
	try {
		// Writer exclusion permits removing only a private stale endpoint, never a live listener.
		const existing = await fs.lstat(address).catch((error) => { if (error.code !== "ENOENT") throw error; return null })
		if (existing) {
			if (!existing.isSocket() || existing.uid !== process.geteuid() || (existing.mode & 0o777) !== 0o600) throw fail("UNSAFE_CONNECTION", "Native endpoint must be an owned mode-0600 Unix socket.")
			await new Promise((resolve, reject) => { const probe = net.connect(address); probe.once("connect", () => { probe.destroy(); reject(fail("SOCKET_IN_USE", "Native endpoint already has a live owner.")) }); probe.once("error", (error) => { probe.destroy(); error.code === "ECONNREFUSED" ? resolve() : reject(error) }); probe.setTimeout(1000, () => { probe.destroy(); reject(fail("SOCKET_IN_USE", "Native endpoint did not respond to the bounded stale-socket probe.")) }) })
			await fs.unlink(address)
		}
		await new Promise((resolve, reject) => { server.once("error", reject); server.listen(address, resolve) })
		await fs.chmod(address, 0o600); socketIdentity = await fs.lstat(address)
		await publishPrivateJSON(lease.directory, "connection.json", descriptor)
	} catch (error) { admitting = false; operations.closeAdmission(); server.close(); for (const socket of connections) socket.destroy(); await operations.close(); await removeSocket(); endLifetime(); await lifetime; throw error }
	return {
		...descriptor, operations,
		async closeAdmission() { admitting = false; operations.closeAdmission(); for (const controller of reading) controller.abort(); await withdraw(); server.close(); server.closeIdleConnections?.() },
		async drain({ deadlineMs = Date.now() + 25000 } = {}) {
			if (closed) return { complete: true }
			if (closing) return closing
			closing = (async () => {
				await this.closeAdmission()
				await operations.close({ deadlineMs })
				let timer
				try { await Promise.race([Promise.allSettled([...pending]), new Promise((_, reject) => { timer = setTimeout(() => reject(fail("CLEANUP_UNVERIFIED", "Native bridge connections did not drain; retain writer exclusion.")), Math.max(0, deadlineMs - Date.now())) })]) } finally { clearTimeout(timer) }
				for (const socket of connections) socket.destroy()
				await removeSocket(); closed = true; endLifetime(); await lifetime
				return { complete: true }
			})()
			try { return await closing } finally { closing = undefined }
		},
		// Lease release is deliberately NOT here: the owner must stop/drain Python afterwards.
	}
}
