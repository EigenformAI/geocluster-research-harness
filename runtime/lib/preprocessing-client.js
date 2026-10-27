import { FileError, identifier } from "./file-contract.js"
import { parseTags, strongIfMatch, weakIfNoneMatch } from "./files.js"
import { managedDenial } from "../../opencode/config/lib/managed-usage.js"

const downloadHeaders = ["range", "if-range"]
const preconditionHeaders = ["if-match", "if-none-match", "if-modified-since", "if-unmodified-since"]
const responseHeaders = ["content-type", "content-length", "content-range", "accept-ranges", "etag", "last-modified", "cache-control", "content-disposition"]
const fail = (status, code, operation, retryable = false, action = "Check preprocessing status and retry the same request when the dependency is ready.") => new FileError(status, code, `Preprocessing ${operation}: ${code.replaceAll("_", " ")}.`, { agent: "preprocessing", tool: operation, retryable, action })
const httpDate = (value) => {
	if (!/^(?:[A-Za-z]{3}, \d{2} [A-Za-z]{3} \d{4} \d{2}:\d{2}:\d{2} GMT|[A-Za-z]+, \d{2}-[A-Za-z]{3}-\d{2} \d{2}:\d{2}:\d{2} GMT|[A-Za-z]{3} [A-Za-z]{3} {1,2}\d{1,2} \d{2}:\d{2}:\d{2} \d{4})$/.test(value || "")) return NaN
	const fields = value.split(/[ ,\-]+/), comma = value.includes(","), day = fields[comma ? 1 : 2], month = fields[comma ? 2 : 1], year = fields[comma ? 3 : 4], date = new Date(Date.parse(value))
	// Date.parse normalizes impossible calendar dates; invalid HTTP dates must instead be ignored.
	return date.getUTCDate() === Number(day) && date.toUTCString().split(" ")[2]?.toLowerCase() === month.toLowerCase() && (year.length === 2 || date.getUTCFullYear() === Number(year)) ? date.getTime() : NaN
}
const validateRange = (headers) => { const range = headers.get("range"); if (range && !/^bytes=(?:\d+-\d*|-\d+)$/.test(range)) throw fail(416, "invalid_range", "download", false, "Request one byte range using bytes=start-end or bytes=-suffix.") }

/** A private, fixed-loopback client. Caller credentials and URLs never cross this boundary. */
export class PreprocessingClient {
	constructor(config = {}) {
		this.port = config.port ?? 8765; this.token = config.token || ""
		this.jsonBytes = config.jsonBytes ?? 16 * 1024 * 1024; this.transportMs = config.transportMs ?? 15000
		this.storeScope = config.storeScope || config.expectedStoreScope || null
		if (![this.port, this.jsonBytes, this.transportMs].every((n) => Number.isSafeInteger(n) && n > 0) || this.port > 65535 || typeof this.token !== "string" || /[\r\n]/.test(this.token)) throw fail(503, "invalid_preprocessing_config", "configuration", false, "Configure a loopback port, private token, and positive JSON/transport limits.")
	}
	async request(endpoint, { method = "GET", body, key, headers, streaming = false } = {}) {
		if (!["GET", "HEAD"].includes(method)) await this.checkStoreScope()
		const operation = endpoint.includes("/products/") ? "download" : endpoint.includes("/tables/") ? "rows" : endpoint.endsWith("/results") ? "results" : endpoint.endsWith("/reconcile") ? "recovery" : endpoint.endsWith("/cancel") ? "cancel" : "jobs"
		const upstreamHeaders = new Headers({ accept: "application/json" })
		if (this.token) upstreamHeaders.set("authorization", `Bearer ${this.token}`)
		if (body !== undefined) upstreamHeaders.set("content-type", "application/json")
		if (key) upstreamHeaders.set("idempotency-key", key)
		if (!["GET", "HEAD"].includes(method)) upstreamHeaders.set("x-processing-store-scope", this.storeScope)
		if (streaming) {
			const selected = new Headers(headers)
			for (const name of downloadHeaders) if (selected.has(name)) upstreamHeaders.set(name, selected.get(name))
		}
		const controller = new AbortController(), timer = setTimeout(() => controller.abort(), this.transportMs)
		timer.unref?.()
		try {
			const response = await fetch(`http://127.0.0.1:${this.port}/preprocessing${endpoint}`, { method, headers: upstreamHeaders, ...(body !== undefined ? { body: JSON.stringify(body) } : {}), redirect: "manual", signal: controller.signal })
			if (response.status >= 300 && response.status < 400 && response.status !== 304) { await response.body?.cancel(); throw fail(502, "processor_protocol_error", operation, true) }
			if (streaming && response.status === 416) {
				await response.body?.cancel()
				const message = "The requested byte range is not satisfiable.", selected = new Headers({ "content-type": "text/plain; charset=utf-8", "content-length": String(Buffer.byteLength(message)), "x-content-type-options": "nosniff" })
				const range = response.headers.get("content-range")
				if (/^bytes \*\/\d+$/.test(range || "")) selected.set("content-range", range)
				return new Response(method === "HEAD" ? null : message, { status: 416, headers: selected })
			}
			if (streaming && (response.ok || response.status === 304)) {
				clearTimeout(timer)
				const selected = new Headers()
				for (const name of responseHeaders) if (response.headers.has(name)) selected.set(name, response.headers.get(name))
				selected.set("x-content-type-options", "nosniff")
				if (!response.body || method === "HEAD") return new Response(null, { status: response.status, headers: selected })
				const reader = response.body.getReader()
				// Pull-driven streaming bounds memory. Each read gets a transport deadline, not a total download budget.
				const stream = new ReadableStream({
					pull: async (sink) => {
						const idle = setTimeout(() => controller.abort(), this.transportMs); idle.unref?.()
						try { const { value, done } = await reader.read(); if (done) sink.close(); else sink.enqueue(value) }
						catch { sink.error(fail(503, "processor_unavailable", operation, true)) }
						finally { clearTimeout(idle) }
					},
					cancel: async (reason) => { controller.abort(); await reader.cancel(reason).catch(() => {}) },
				}, { highWaterMark: 0 })
				return new Response(stream, { status: response.status, headers: selected })
			}
			if (streaming && method === "HEAD") {
				// HEAD errors carry no JSON body. Keep the upstream status rather than inventing a parse error.
				const error = fail(response.status, response.status === 404 ? "not_found" : "processor_unavailable", operation, response.status === 429 || response.status >= 500)
				error.upstreamRejected = true
				throw error
			}
			const reader = response.body?.getReader(), chunks = []; let size = 0
			if (Number(response.headers.get("content-length")) > this.jsonBytes) { await reader?.cancel(); throw this.tooLarge(operation) }
			if (reader) while (true) {
				const { value, done } = await reader.read(); if (done) break
				size += value.byteLength
				if (size > this.jsonBytes) { await reader.cancel(); throw this.tooLarge(operation) }
				chunks.push(value)
			}
			let value
			try { value = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(Buffer.concat(chunks, size))) }
			catch { throw fail(502, "processor_protocol_error", operation, true) }
			if (!response.ok) {
				const denial = managedDenial(value)
				if (denial) {
					const error = fail(response.status, denial.code, operation, false, denial.recovery)
					error.usageDenial = denial; error.upstreamRejected = true
					throw error
				}
				const code = value?.error?.code || value?.code
				const safeCode = typeof code === "string" && /^[A-Z][A-Z0-9_]{0,80}$/.test(code) ? code.toLowerCase() : "processor_unavailable"
				const error = fail(response.status, safeCode, operation, response.status === 429 || response.status >= 500, safeCode === "row_too_large" || safeCode === "response_too_large" ? "Download the complete manifest-listed typed JSONL or CSV product." : undefined)
				error.upstreamRejected = true
				throw error
			}
			if (!value || typeof value !== "object" || Array.isArray(value)) throw fail(502, "processor_protocol_error", operation, true)
			return value
		} catch (error) {
			if (error instanceof FileError) throw error
			throw fail(503, controller.signal.aborted ? "processor_timeout" : "processor_unavailable", operation, true)
		} finally { clearTimeout(timer) }
	}
	tooLarge(operation) { return fail(413, "result_metadata_too_large", operation, false, `Raise the adapter JSON ceiling above ${this.jsonBytes} bytes and retry; metadata was not truncated.`) }
	capabilities() { return this.request("/capabilities") }
	bindStoreScope(scope) {
		if (typeof scope !== "string" || !/^[A-Za-z0-9_.:-]{1,128}$/.test(scope)) throw fail(502, "processor_protocol_error", "identity")
		if (this.storeScope && this.storeScope !== scope) throw fail(409, "processing_store_changed", "identity", false, "Restore the original processor store; never replay retained requests into a replacement store.")
		this.storeScope = scope
		return scope
	}
	async checkStoreScope() { const value = await this.capabilities(); return this.bindStoreScope(value.storeScope) }
	lookup(key) { return this.request(`/jobs?submissionKey=${encodeURIComponent(key)}`).then((value) => value.job) }
	submit(key, body) { return this.request("/jobs", { method: "POST", key, body }) }
	get(id) { return this.request(`/jobs/${encodeURIComponent(identifier(id, "processor job ID"))}`) }
	cancel(id) { return this.request(`/jobs/${encodeURIComponent(identifier(id, "processor job ID"))}/cancel`, { method: "POST" }) }
	cancelSubmission(key, request) { return this.request(`/submissions/${encodeURIComponent(identifier(key, "submission key"))}/cancel`, { method: "POST", body: { request } }) }
	results(id) { return this.request(`/jobs/${encodeURIComponent(identifier(id, "processor job ID"))}/results`) }
	rows(id, tableId, { offset = 0, limit = 100 } = {}) { return this.request(`/jobs/${encodeURIComponent(identifier(id))}/tables/${encodeURIComponent(identifier(tableId))}/rows?offset=${offset}&limit=${limit}`) }
	product(id, productId, { method = "GET", headers } = {}) {
		if (!["GET", "HEAD"].includes(method)) throw fail(400, "invalid_request", "download")
		const selected = new Headers(headers), endpoint = `/jobs/${encodeURIComponent(identifier(id))}/products/${encodeURIComponent(identifier(productId))}`
		if (method === "HEAD") { selected.delete("range"); selected.delete("if-range") }
		if (preconditionHeaders.some((name) => selected.has(name))) return this.conditionalProduct(endpoint, method, selected)
		validateRange(selected)
		return this.request(endpoint, { method, headers: selected, streaming: true })
	}
	async conditionalProduct(endpoint, method, headers) {
		// Sealed products are immutable. Probe their actual validators under the normal transport deadline.
		const probe = await this.request(endpoint, { method: "HEAD", streaming: true }), etag = probe.headers.get("etag"), modified = httpDate(probe.headers.get("last-modified"))
		const match = parseTags(headers.get("if-match")), none = parseTags(headers.get("if-none-match"))
		const unmodified = httpDate(headers.get("if-unmodified-since")), since = httpDate(headers.get("if-modified-since"))
		if (match ? !strongIfMatch(match, etag) : modified > unmodified) {
			const error = fail(412, "precondition_failed", "download", false, "Refresh the product validators and retry using its current ETag or Last-Modified value.")
			if (etag !== null) error.etag = etag
			throw error
		}
		if (none ? weakIfNoneMatch(none, etag) : modified <= since) {
			const selected = new Headers(probe.headers)
			selected.delete("content-length"); selected.delete("content-range")
			return new Response(null, { status: 304, headers: selected })
		}
		if (method === "HEAD") return probe
		validateRange(headers)
		return this.request(endpoint, { headers, streaming: true })
	}
	reconcile() { return this.request("/engine/reconcile", { method: "POST" }) }
}
