import { randomUUID } from "node:crypto"
import { setTimeout as sleep } from "node:timers/promises"

export const TERMINAL_PROCESSING_STATES = new Set(["succeeded", "partial", "failed", "cancelled", "interrupted"])

const events = new Set(["request.prepared", "dispatch.unknown", "request.accepted", "wait.expired", "job.transition", "export.verified", "source.prepared", "cancellation.pending", "cancellation.settled"])
const eventIds = ["workspaceId", "workspaceEpoch", "rootId", "sessionId", "requestId", "jobId", "exportId", "invocationId", "waitId", "origin", "operationOutcome", "jobOutcome"]
const eventDigests = ["sourceSha256", "profileDigest", "destinationSha256", "productSha256"]

/** Operational logs are an allowlist, not a serialization of requests or supplier errors. */
export function processingEvent(logger, event, values = {}) {
	if (!events.has(event)) return
	const fields = {}
	for (const key of eventIds) if (typeof values[key] === "string" && /^[A-Za-z0-9_.:-]{1,256}$/.test(values[key])) fields[key] = values[key]
	for (const key of eventDigests) if (typeof values[key] === "string" && /^[a-f0-9]{64}$/.test(values[key])) fields[key] = values[key]
	if (Number.isSafeInteger(values.bytes) && values.bytes >= 0) fields.bytes = values.bytes
	try { Promise.resolve(logger?.info?.(`processing.${event}`, fields)).catch(() => {}) } catch {}
}

export class ProcessingError extends Error {
	constructor(code, message, details = {}) {
		super(message)
		this.name = "ProcessingError"
		Object.assign(this, { code, status: 400, action: "Inspect the retained request before starting new work." }, details)
	}
}

function integer(value, fallback, minimum, maximum, name) {
	const number = value ?? fallback
	if (!Number.isSafeInteger(number) || number < minimum || number > maximum) throw new ProcessingError("INVALID_REQUEST", `${name} must be an integer from ${minimum} to ${maximum}.`)
	return number
}

const observationKey = (value) => JSON.stringify([value.state, value.stage, value.progress, value.resultAvailable, value.resultId, value.cancelRequestedAt, value.hold, value.operationOutcome])

function abortable(work, signal) {
	signal.throwIfAborted()
	return new Promise((resolve, reject) => {
		const abort = () => reject(signal.reason)
		signal.addEventListener("abort", abort, { once: true })
		Promise.resolve().then(work).then(resolve, reject).finally(() => signal.removeEventListener("abort", abort))
	})
}

/** Observation only. Neither a timeout nor caller interruption authorizes execution effects. */
export class ProcessingWaits {
	constructor({ pollMs = 200, random = Math.random } = {}) {
		this.pollMs = pollMs
		this.random = random
		this.pending = new Map()
	}

	async wait(callerKey, handle, observe, { timeoutMs = 20000, signal } = {}) {
		const budget = integer(timeoutMs, 20000, 0, 20000, "timeoutMs")
		const previous = this.pending.get(callerKey)
		if (previous) throw new ProcessingError("WAIT_IN_PROGRESS", "An observation wait is already pending for this caller.", { status: 409, waitId: previous.waitId, ...previous.handle })
		const controller = new AbortController(), waitId = randomUUID(), deadline = Date.now() + budget
		const expired = new DOMException("The observation budget expired.", "TimeoutError")
		const timer = setTimeout(() => controller.abort(expired), budget)
		const abort = () => controller.abort(signal.reason)
		signal?.addEventListener("abort", abort, { once: true })
		if (signal?.aborted) abort()
		this.pending.set(callerKey, { waitId, controller, handle })
		let last = { ...handle, state: "unknown", resultAvailable: false }
		try {
			let baseline, attempt = 0
			for (;;) {
				controller.signal.throwIfAborted()
				const observation = await abortable(() => observe({ signal: controller.signal }), controller.signal)
				controller.signal.throwIfAborted()
				last = observation
				const key = observationKey(observation)
				const changed = baseline !== undefined && baseline !== key
				const ready = observation.resultAvailable === true || TERMINAL_PROCESSING_STATES.has(observation.state)
				const timedOut = !changed && !ready && Date.now() >= deadline
				if (changed || ready || timedOut) return { ...handle, ...observation, waitId, timedOut, continuation: ready ? "Inspect available results and job quality; do not resubmit this request." : "Continue observing with processing_wait and the same requestId or jobId. Waiting does not resubmit or cancel extraction." }
				baseline = key
				const backoff = Math.min(1000, this.pollMs * 1.5 ** Math.min(attempt++, 8))
				await sleep(Math.max(1, Math.min(deadline - Date.now(), backoff * (0.75 + this.random() * 0.5))), undefined, { signal: controller.signal })
			}
		} catch (error) {
			if (controller.signal.reason !== expired) throw error
			return { ...handle, ...last, waitId, timedOut: true, continuation: "Continue observing with processing_wait and the same requestId or jobId. Waiting does not resubmit or cancel extraction." }
		} finally {
			clearTimeout(timer)
			signal?.removeEventListener("abort", abort)
			this.pending.delete(callerKey)
		}
	}

	abortAll() {
		for (const { controller } of this.pending.values()) controller.abort()
	}
}

/** Keep quality outside the inventory budget: a long product list cannot erase partial coverage. */
export function summarizeResult(manifest, job = {}, { offset = 0, limit = 50, maxBytes = 65536 } = {}) {
	const start = integer(offset, 0, 0, Number.MAX_SAFE_INTEGER, "offset"), count = integer(limit, 50, 1, 100, "limit")
	const navigation = {}, inventory = {}
	const quality = {
		jobId: job.id || job.jobId || manifest.jobId,
		resultId: manifest.resultId || job.resultId,
		resultAvailable: true,
		outcome: manifest.outcome || job.state || null,
		source: manifest.source || job.source || null,
		selectedModel: job.modelSelection?.selectedModel || job.resolvedProfile?.model || manifest.pipeline?.models?.vision || manifest.profile?.models?.vision || manifest.selectedModel || null,
		coverage: manifest.coverage ?? null,
		stages: manifest.stages ?? [],
		provenance: manifest.provenance ?? null,
	}
	const inventoryBudget = integer(maxBytes, 65536, 4096, 262144, "maxBytes") - Buffer.byteLength(JSON.stringify(quality)) - 2048
	if (inventoryBudget < 1024) throw new ProcessingError("SUMMARY_QUALITY_TOO_LARGE", "The complete quality metadata exceeds this response budget; retrieve the full sealed manifest or raise the summary byte budget.", { status: 413 })
	for (const key of ["tables", "products", "figures", "findings"]) {
		let remaining = Math.floor(inventoryBudget / 4)
		const all = Array.isArray(manifest[key]) ? manifest[key] : []
		inventory[key] = []
		for (const entry of all.slice(start, start + count)) {
			const item = key === "tables" ? { ...entry, header: "not-inferred", rowMeaning: "source/logical rows, including any header-looking rows" } : entry
			const bytes = Buffer.byteLength(JSON.stringify(item))
			if (bytes > remaining) {
				if (inventory[key].length || remaining < 256) break
				// Advance over an oversized entry only with an explicit pointer to its full inventory record.
				const stub = { id: entry.id ?? null, ...(key === "findings" ? { code: entry.code ?? null } : {}), truncated: true, fullEntry: "sealed-manifest", inventoryOffset: start }
				inventory[key].push(stub)
				remaining -= Buffer.byteLength(JSON.stringify(stub))
				break
			}
			inventory[key].push(item)
			remaining -= bytes
		}
		const next = start + inventory[key].length
		navigation[key] = { offset: start, count: inventory[key].length, total: all.length, nextOffset: next < all.length ? next : null }
	}
	const tableConfirmation = {}
	for (const table of manifest.tables || []) {
		const reported = typeof table.confirmation === "string" ? table.confirmation : table.confirmation?.status || table.confirmation?.state
		const status = ["confirmed", "agreed", "unresolved", "failed", "pending", "not_checked", "not-checked", "not-applicable"].includes(reported) ? reported : "unresolved"
		tableConfirmation[status] = (tableConfirmation[status] || 0) + 1
	}
	return {
		...quality,
		tableConfirmation,
		...inventory,
		truncated: Object.values(navigation).some((page) => page.nextOffset !== null || start > 0 && page.total > 0) || Object.values(inventory).some((items) => items.some((item) => item.truncated)),
		navigation,
		manifestAvailable: true,
		qualityNotice: "Stage completion and overall coverage are separate. Exports preserve product bytes, not independent table confirmation.",
	}
}

async function boundedBytes(response, ceiling) {
	const reader = response.body?.getReader(), chunks = []
	let size = 0
	if (!reader) return Buffer.alloc(0)
	try {
		for (;;) {
			const { done, value } = await reader.read()
			if (done) break
			size += value.byteLength
			if (size > ceiling) throw new ProcessingError("PRODUCT_INTEGRITY", "The product response exceeded its declared byte range.", { status: 502 })
			chunks.push(value)
		}
		return Buffer.concat(chunks, size)
	} finally { await reader.cancel().catch(() => {}) }
}

/** The owning service serves sealed product ranges; never accept a model-authored replacement. */
export async function readProductText(product, download, { offset = 0, limit = 16384 } = {}) {
	const start = integer(offset, 0, 0, Number.MAX_SAFE_INTEGER, "offset"), count = integer(limit, 16384, 1, 65536, "limit")
	if (!Number.isSafeInteger(product.bytes) || product.bytes < 0 || !/^[0-9a-f]{64}$/.test(product.sha256 || "")) throw new ProcessingError("PRODUCT_INTEGRITY", "The sealed product has invalid byte metadata.", { status: 502 })
	if (!/^(?:text\/|application\/(?:json|(?:[a-z.+-]+\+)?jsonl|x-ndjson))/.test(product.mediaType || "")) throw new ProcessingError("NOT_TEXT_PRODUCT", "Select a sealed transcription or other text product.")
	if (start > product.bytes) throw new ProcessingError("INVALID_REQUEST", "The byte offset is beyond this product.")
	if (start === product.bytes) return { productId: product.id, text: "", range: { offset: start, bytes: 0 }, totalBytes: product.bytes, nextOffset: null, productSha256: product.sha256 }
	const end = Math.min(product.bytes, start + count) - 1
	const response = await download({ headers: { range: `bytes=${start}-${end}` } })
	const range = response.headers.get("content-range")
	if (!(response.status === 206 && range === `bytes ${start}-${end}/${product.bytes}` || response.status === 200 && start === 0 && end === product.bytes - 1)) {
		await response.body?.cancel()
		throw new ProcessingError("PRODUCT_INTEGRITY", "The owning service did not return the requested immutable product range.", { status: 502 })
	}
	const bytes = await boundedBytes(response, end - start + 1)
	if (bytes.length !== end - start + 1) throw new ProcessingError("PRODUCT_INTEGRITY", "The product response was truncated.", { status: 502 })
	let text, used = bytes.length
	for (; used >= Math.max(1, bytes.length - 3); used--) {
		try { text = new TextDecoder("utf-8", { fatal: true }).decode(bytes.subarray(0, used)); break } catch {}
		if (end === product.bytes - 1) break
	}
	if (text === undefined) throw new ProcessingError("INVALID_TEXT_RANGE", "Use a UTF-8 character boundary and a byte limit large enough for one character.")
	return { productId: product.id, text, range: { offset: start, bytes: used }, totalBytes: product.bytes, nextOffset: start + used < product.bytes ? start + used : null, productSha256: product.sha256 }
}
