import http from "node:http"
import fs from "node:fs/promises"
import { constants } from "node:fs"
import path from "node:path"
import { CLIENT_TIMEOUT_MS, PROCESSING_ENDPOINT, PROCESSING_SOCKET, exactFields, object, ordinaryPath, sameScope, text, validScope } from "./processing-contract.js"

const failure = (code, message, details = {}) => Object.assign(new Error(message), { code, ...details })
const privateMode = (stat, mode) => stat.uid === process.geteuid?.() && (stat.mode & 0o7777) === mode
const MAX_DESCRIPTOR = 16 * 1024
const validHandle = (value) => typeof value === "string" && /^[A-Za-z0-9_.:-]{1,128}$/.test(value)
const ERROR_HANDLES = ["requestId", "jobId", "exportId", "waitId"]

function currentObservation(value, scope, sourcePath) {
	if (value === null) return null
	if (!exactFields(value, ["token", "ref", "observedAt", "sizeBytes"], ["token", "ref"]) || typeof value.token !== "string" || !/^[A-Za-z0-9_:-]{1,512}$/.test(value.token)) return undefined
	const ref = value.ref
	if (!exactFields(ref, ["workspaceId", "workspaceEpoch", "path"]) || !sameScope({ workspaceId: ref.workspaceId, workspaceEpoch: ref.workspaceEpoch }, scope) || !ordinaryPath(ref.path) || sourcePath !== undefined && ref.path !== sourcePath) return undefined
	if (value.observedAt !== undefined && (!text(value.observedAt, 64) || !/^\d{4}-\d\d-\d\dT/.test(value.observedAt) || !Number.isFinite(Date.parse(value.observedAt)))) return undefined
	if (value.sizeBytes !== undefined && (!Number.isSafeInteger(value.sizeBytes) || value.sizeBytes < 0)) return undefined
	return { token: value.token, ref: { ...ref }, ...(value.observedAt !== undefined ? { observedAt: new Date(value.observedAt).toISOString() } : {}), ...(value.sizeBytes !== undefined ? { sizeBytes: value.sizeBytes } : {}) }
}

/** Native wraps its error; managed sends a flat error/code envelope. Never spread wire data into errors. */
function bridgeError(value, status, body) {
	const nested = object(value?.error), fields = ["code", "message", "action", ...ERROR_HANDLES, "currentObservation"]
	const candidate = nested ? value.error : value
	const raw = (nested ? exactFields(value, ["error"]) : typeof value?.error === "string" && text(value.error, 128)) && exactFields(candidate, nested ? fields : ["error", ...fields], ["code", "message"]) ? candidate : null
	const code = typeof raw?.code === "string" && /^[A-Za-z][A-Za-z0-9_]{0,127}$/.test(raw.code) ? raw.code : "PROCESSING_FAILED"
	const details = { status }
	if (text(raw?.action, 4096)) details.action = raw.action
	for (const key of ERROR_HANDLES) if (validHandle(raw?.[key])) details[key] = raw[key]
	if (code.toUpperCase() === "SOURCE_CHANGED" && raw.currentObservation !== undefined) {
		const observation = currentObservation(raw.currentObservation, body.scope, body.input?.source?.path ?? body.input?.path)
		if (observation !== undefined) details.currentObservation = observation
	}
	return failure(code, text(raw?.message, 4096) ? raw.message : "Processing bridge request failed. Inspect retained receipt history before starting new work.", details)
}

/** Discovery is trusted runtime input, never a model argument. No symlink component or permissive private leaf. */
export async function readConnection(clientDir) {
	if (!text(clientDir, 4096) || !path.isAbsolute(clientDir)) throw failure("PROCESSING_DISABLED", "Native processing is unavailable. Reopen the native runtime with an explicit --processing-model and injected client directory.")
	const dir = path.resolve(clientDir)
	let directory = await fs.open("/", constants.O_RDONLY | constants.O_DIRECTORY), handle
	try {
		// Descriptor-relative traversal pins each checked parent, unlike lstat followed by pathname open.
		for (const part of dir.split(path.sep).filter(Boolean)) {
			const next = await fs.open(`/proc/self/fd/${directory.fd}/${part}`, constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW)
			await directory.close(); directory = next
		}
		if (!privateMode(await directory.stat(), 0o700)) throw failure("UNSAFE_CONNECTION", "Native client directory must have private mode 0700 and current ownership.")
		handle = await fs.open(`/proc/self/fd/${directory.fd}/connection.json`, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK)
		const stat = await handle.stat()
		if (!stat.isFile() || !privateMode(stat, 0o600) || stat.nlink !== 1 || stat.size > MAX_DESCRIPTOR) throw failure("UNSAFE_CONNECTION", "Native connection must be a private bounded regular file (mode 0600, current owner, one link).")
		const bytes = Buffer.alloc(MAX_DESCRIPTOR + 1); let size = 0
		while (size < bytes.length) { const read = await handle.read(bytes, size, bytes.length - size, null); if (!read.bytesRead) break; size += read.bytesRead }
		if (size > MAX_DESCRIPTOR) throw failure("UNSAFE_CONNECTION", "Native connection exceeds its size bound.")
		const value = JSON.parse(bytes.subarray(0, size).toString("utf8"))
		if (!exactFields(value, ["scope", "invocationId", "model", "socketPath"]) || !validScope(value.scope) || !text(value.invocationId) || !text(value.model, 512) || value.socketPath !== path.join(dir, "documents.sock")) throw failure("UNSAFE_CONNECTION", "Native connection has an invalid identity or socket endpoint outside the client directory.")
		const socket = await fs.lstat(`/proc/self/fd/${directory.fd}/documents.sock`)
		if (!socket.isSocket() || socket.isSymbolicLink() || !privateMode(socket, 0o600)) throw failure("UNSAFE_CONNECTION", "Native endpoint must be a private owned Unix socket (mode 0600).")
		return Object.freeze({ ...value, scope: Object.freeze({ ...value.scope }) })
	} catch (error) {
		if (["ELOOP", "ENOTDIR"].includes(error.code)) throw failure("UNSAFE_CONNECTION", "Native discovery contains an unsafe symlink or non-directory.")
		throw error
	} finally { await handle?.close(); await directory.close() }
}

/** Absolute deadline covers response streaming as well as connection establishment. Never retries any request. */
function send(socketPath, body, { signal, timeoutMs }) {
	const bytes = Buffer.from(JSON.stringify(body))
	if (bytes.length > 1024 * 1024) return Promise.reject(failure("REQUEST_TOO_LARGE", "Processing request exceeds 1 MiB."))
	return new Promise((resolve, reject) => {
		const req = http.request({ socketPath, path: PROCESSING_ENDPOINT, method: "POST", signal, headers: { "content-type": "application/json", "content-length": bytes.length } }, (res) => {
			const chunks = []; let size = 0
			res.on("data", (chunk) => { size += chunk.length; if (size > 2 * 1024 * 1024) req.destroy(failure("RESPONSE_TOO_LARGE", "Processing response exceeds 2 MiB; request bounded reads.")); else chunks.push(chunk) })
			res.on("error", reject)
			res.on("end", () => {
				try {
					const value = JSON.parse(Buffer.concat(chunks).toString("utf8"))
					if (object(value) && Object.hasOwn(value, "error") || res.statusCode < 200 || res.statusCode >= 300) return reject(bridgeError(value, res.statusCode, body))
					resolve(value)
				} catch (error) { reject(error) }
			})
		})
		const deadline = setTimeout(() => req.destroy(failure("PROCESSING_TIMEOUT", "Processing observation timed out; inspect retained history/status before any new submission.")), timeoutMs)
		req.once("close", () => clearTimeout(deadline))
		req.once("error", reject)
		req.end(bytes)
	})
}

export function createClient({ mode = process.env.GEOCLUSTER_PROCESSING_MODE ?? "managed", clientDir = process.env.GEOCLUSTER_PROCESSING_CLIENT_DIR, timeoutMs = CLIENT_TIMEOUT_MS } = {}) {
	if (!["native", "managed"].includes(mode)) throw failure("INVALID_MODE", "Processing mode must be native or managed.")
	if (!Number.isSafeInteger(timeoutMs) || timeoutMs < 1 || timeoutMs > CLIENT_TIMEOUT_MS) throw failure("INVALID_TIMEOUT", "Processing transport timeout must be within 25 seconds.")
	let connection, stale = false, generation = 0
	return {
		mode,
		// Reopen only refreshes discovery. It never recovers/replays a mutation; callers must choose the retained handle.
		async reopen() { connection = undefined; stale = false; generation++ },
		async request(body, { signal } = {}) {
			const started = Date.now(), epoch = generation
			const exchange = async (socket, input) => {
				const remaining = timeoutMs - (Date.now() - started)
				if (remaining <= 0) throw failure("PROCESSING_TIMEOUT", "Processing deadline expired before dispatch; inspect the retained request before new work.")
				return send(socket, input, { signal, timeoutMs: remaining })
			}
			try {
				if (mode === "managed") return await exchange(PROCESSING_SOCKET, body)
				if (stale) throw failure("OWNER_CHANGED", "Native owner changed. Reopen discovery, then inspect/recover the retained request only if persistent scope still matches.")
				if (!connection) connection = readConnection(clientDir).catch((error) => { connection = undefined; throw error })
				const descriptor = await connection
				if (body.scope !== null && !sameScope(body.scope, descriptor.scope)) throw failure("SCOPE_MISMATCH", "Processing scope differs from current discovery; do not replay into another store.")
				const envelope = { ...body, scope: descriptor.scope, invocationId: descriptor.invocationId }
				const check = (reply) => {
					if (!sameScope(reply?.scope, descriptor.scope)) throw failure("SCOPE_MISMATCH", "Native processing reply has a different persistent scope.")
					if (reply.invocationId !== descriptor.invocationId || epoch !== generation) throw failure("OWNER_CHANGED", "Native owner changed. Reopen discovery and recover the original request; do not start duplicate work.")
					return reply
				}
				// A fresh capabilities handshake precedes every operation, including mutations after an owner restart.
				const capability = check(await exchange(descriptor.socketPath, { action: "capabilities", scope: descriptor.scope, invocationId: descriptor.invocationId, caller: body.caller, input: {} }))
				if (body.action === "capabilities") return capability
				if (signal?.aborted) throw signal.reason ?? failure("ABORTED", "Processing observation aborted.")
				return check(await exchange(descriptor.socketPath, envelope))
			} catch (error) {
				if (error.code === "OWNER_CHANGED") stale = true
				for (const key of ERROR_HANDLES) if (!error[key] && validHandle(body.input?.[key])) error[key] = body.input[key]
				throw error
			}
		},
	}
}

let defaultClient
export const request = (body, options) => (defaultClient ??= createClient()).request(body, options)
