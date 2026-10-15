import { Readable } from "node:stream"
import { cloudError, sourceIdentity, stableId } from "./cloud-file-contract.js"

/** Machine purpose tokens stay in root. Only the private file daemon knows this channel secret. */
export class BackendFileAdapter {
	constructor({ port = 3003, secret, fetchImpl = globalThis.fetch, timeoutMs = 15000 }) {
		if (!Number.isInteger(port) || port < 1 || port > 65535 || !/^[0-9a-f]{64}$/.test(secret || "")) throw cloudError(503, "invalid_backend_channel")
		this.base = `http://127.0.0.1:${port}`; this.secret = secret; this.fetch = fetchImpl; this.timeoutMs = timeoutMs; this.aligned = true
	}
	bind(workspace) { this.workspace = workspace }
	demoStatus() { return this.request("work", "/demo/status") }
	demoPermit(requestId, stage) { return this.request("work", "/demo/permit", { requestId, stage }) }
	demoCheckpoint(body) { return this.request("work", "/demo/checkpoint", body) }
	async request(purpose, suffix, body, method = body === undefined ? "GET" : "POST") {
		const response = await this.fetch(`${this.base}/${purpose}-backend${suffix}`, { method, redirect: "error", credentials: "omit", cache: "no-store", headers: { "x-gc-files-control": this.secret, "x-gc-workspace-id": this.workspace.identity.workspaceId, "x-gc-workspace-epoch": this.workspace.identity.workspaceEpoch, ...(body === undefined ? {} : { "content-type": "application/json" }) }, ...(body === undefined ? {} : { body: JSON.stringify(body) }), signal: AbortSignal.timeout(this.timeoutMs) })
		if (["normal", "cleanup"].includes(response.headers.get("x-gc-machine-authority"))) this.cleanupOnly = response.headers.get("x-gc-machine-authority") === "cleanup"
		const reader = response.body.getReader(); let size = 0; const chunks = []
		try { for (;;) { const { value, done } = await reader.read(); if (done) break; size += value.length; if (size > 16 * 1024 * 1024) throw cloudError(502, "backend_response_limit"); chunks.push(value) } } finally { await reader.cancel().catch(() => {}) }
		let value
		try { value = JSON.parse(Buffer.concat(chunks).toString("utf8")) } catch { throw cloudError(502, "invalid_backend_response") }
		if (!response.ok) { const code = value.detail || value.error; const error = cloudError(response.status, /^[a-z][a-z0-9_-]{0,100}$/.test(code || "") ? code : "backend_unavailable"); error.retryAfter = Number(response.headers.get("retry-after")) || null; throw error }
		return value
	}
	claim(requestId) { return this.request("work", "/claims", { requestId, limit: 10 }) }
	progress(claim, value) { return this.request("work", `/${claim.workId}/progress`, { attemptId: claim.attemptId, attemptRevision: claim.attemptRevision, ...value }) }
	reportFailure(claim, value) { return this.request("work", `/${claim.workId}/failure`, { attemptId: claim.attemptId, attemptRevision: claim.attemptRevision, ...value }) }
	sourceUrl(claim) { return this.request("work", `/${claim.workId}/source-url`, { attemptId: claim.attemptId, attemptRevision: claim.attemptRevision }) }
	getWork(workId) { return this.request("work", `/${workId}`) }
	permit(claim, kind, receiptId, publicationPermitId) { return this.request("work", `/${claim.workId}/permits`, { requestId: stableId(`${claim.runtimeId}:${claim.workspaceId}:${claim.workspaceEpoch}:${claim.operationId}:${kind}`), attemptId: claim.attemptId, attemptRevision: claim.attemptRevision, kind, operationId: claim.operationId, receiptId, ...(publicationPermitId ? { publicationPermitId } : {}) }) }
	ack(claim, record) { return this.request("work", `/${claim.workId}/ack`, { attemptId: claim.attemptId, attemptRevision: claim.attemptRevision, receiptRevision: record.receiptRevision, receipt: record.receipt, processingReceipt: record.processingReceipt, ...(record.observedProcessing ? { observedProcessing: record.observedProcessing } : {}) }) }
	reconcile(records) { return this.request("work", "/receipts/reconcile", { ...this.workspace.identity, receipts: records.map(({ workId, receiptRevision, receipt, processingReceipt, observedProcessing }) => ({ workId, receiptRevision, receipt, processingReceipt, ...(observedProcessing ? { observedProcessing } : {}) })) }) }
	settle(permit, value) { return this.request("work", `/permits/${permit.permitId}/settle`, { ownerRevision: permit.ownerRevision, ...value }) }
	createSnapshot(requestId) { return this.request("files", "/snapshots", { requestId }) }
	snapshotPage(snapshotId, cursor) { return this.request("files", `/snapshots/${encodeURIComponent(snapshotId)}?limit=500${cursor ? `&cursor=${encodeURIComponent(cursor)}` : ""}`) }
	changesAfter(afterSeq, cursor) { return this.request("files", `/changes?afterSeq=${afterSeq}&limit=500${cursor ? `&cursor=${encodeURIComponent(cursor)}` : ""}`) }
	async source(fileVersionId) { const result = await this.request("files", "/versions/urls", { fileVersionIds: [fileVersionId] }); const source = result.files?.find((file) => file.fileVersionId === fileVersionId); sourceIdentity(source); return source }
	async checkHead(entry) {
		const result = await this.request("files", "/urls", { files: [{ path: entry.path, headToken: entry.headToken }] })
		if (!result.files?.some((file) => file.path === entry.path && file.headToken === entry.headToken && file.fileVersionId === entry.fileVersionId)) throw cloudError(409, "head_changed")
	}
	async download(source, signal) {
		sourceIdentity(source)
		const url = new URL(source.url)
		if (!["http:", "https:"].includes(url.protocol) || url.username || url.password || url.hash) throw cloudError(422, "invalid_source_url")
		const headers = source.requiredHeaders
		if (!headers || typeof headers !== "object" || !Object.entries(headers).some(([key, value]) => key.toLowerCase() === "if-match" && typeof value === "string" && /^"[^\r\n]+"$/.test(value)) || Object.keys(headers).some((key) => ["authorization", "cookie", "host", "proxy-authorization"].includes(key.toLowerCase()))) throw cloudError(422, "invalid_source_validator")
		const response = await this.fetch(url, { headers, redirect: "error", credentials: "omit", cache: "no-store", signal: signal || AbortSignal.timeout(120000) })
		if (!response.ok) { await response.body?.cancel(); throw cloudError(response.status, response.status === 412 ? "source_validator_mismatch" : "source_download_unavailable") }
		return Readable.fromWeb(response.body)
	}
	async upload(change, source) {
		// Multipart streams the protected capture with a bounded chunk buffer. No Current pathname read.
		const boundary = `gc-${stableId(change.operationId)}`
		async function* multipart() {
			for (const [name, value] of [["paths", change.intent.path], ["expectedHeads", change.cloudBaseHead || ""], ["operationIds", change.operationId]]) yield Buffer.from(`--${boundary}\r\nContent-Disposition: form-data; name="${name}"\r\n\r\n${value}\r\n`)
			yield Buffer.from(`--${boundary}\r\nContent-Disposition: form-data; name="files"; filename="source"\r\nContent-Type: application/octet-stream\r\n\r\n`)
			for await (const chunk of source.handle.createReadStream({ start: 0, autoClose: false })) yield chunk
			yield Buffer.from(`\r\n--${boundary}--\r\n`)
		}
		const response = await this.fetch(`${this.base}/files-backend/current/upload`, { method: "POST", headers: { "x-gc-files-control": this.secret, "x-gc-workspace-id": this.workspace.identity.workspaceId, "x-gc-workspace-epoch": this.workspace.identity.workspaceEpoch, "content-type": `multipart/form-data; boundary=${boundary}` }, body: Readable.from(multipart()), duplex: "half", redirect: "error", credentials: "omit", signal: AbortSignal.timeout(120000) })
		if (!response.ok) { await response.body?.cancel(); throw cloudError(response.status, "cloud_write_unavailable") }
		return (await response.json()).results?.[0]
	}
	mutations(operations) { return this.request("files", "/current/changes", { operations }) }
}
