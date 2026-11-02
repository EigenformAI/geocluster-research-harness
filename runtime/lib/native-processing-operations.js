import fs from "node:fs/promises"
import { constants } from "node:fs"
import path from "node:path"
import { createHash, randomUUID } from "node:crypto"
import { ProcessingError, ProcessingWaits, processingEvent, summarizeResult, readProductText } from "./processing-operations.js"
import { stableStringify } from "./file-contract.js"
import { NativeProcessingReceipts, fdPath, openNativeDirectory } from "./native-processing-receipts.js"

const fail = (code, message, details) => new ProcessingError(code, message, details)
const terminal = new Set(["succeeded", "partial", "failed", "cancelled", "interrupted"])
const digest = (value) => createHash("sha256").update(value).digest("hex")
const callUUID = (value) => {
	// Locate the old receipt even after store replacement; its immutable full scope
	// must reject recovery instead of letting the same call allocate fresh work.
	const lookup = { ...value }; delete lookup.workspaceEpoch
	const hash = digest(stableStringify(lookup))
	return `${hash.slice(0, 8)}-${hash.slice(8, 12)}-5${hash.slice(13, 16)}-a${hash.slice(17, 20)}-${hash.slice(20, 32)}`
}
const identifier = (value) => typeof value === "string" && /^[A-Za-z0-9_.:-]{1,128}$/.test(value)
const unwrap = (value) => value?.job || value
const recovery = (requestId) => `Recover the exact retained intent with requestId ${requestId}; do not create a new request to retry.`
const privateField = (key) => /token|secret|credential|password|authorization|apikey|accesskey|privatekey|submissionkey|connection|descriptor|invocationid|servicegeneration|storescope|projectid|workspaceepoch|workspaceid|snapshotid|instanceid|sessionid|messageid|callid|operationid|leaseid|ownerid|^upstream|^requestedsource$|^correlation$|^environment$|^engineenv$|^headers$|^socketpath$|^pid$|^intent$|^request$|^origin$|^replay/i.test(key.replaceAll(/[_-]/g, ""))
const inventoryPath = (value) => typeof value === "string" && !value.includes(":") && !value.includes("\\") && !/[\x00-\x1f\x7f]/.test(value) && value.split("/").every((part) => part && ![".", "..", ".runtime", ".preprocessing", ".ide-state", ".git"].includes(part))
/** Metadata projection only: extracted cell values are preserved by the table reader. */
function publicMetadata(value, { paths = false, content = false } = {}) {
	if (Array.isArray(value)) return value.map((child) => publicMetadata(child, { paths, content })).filter((child) => child !== undefined)
	if (value && typeof value === "object") return Object.fromEntries(Object.entries(value).filter(([key]) => content || !privateField(key) && !/url$/i.test(key)).map(([key, child]) => [key, publicMetadata(child, { paths: paths || /(?:paths?|roots?|director(?:y|ies)|filename)$/i.test(key), content })]).filter(([, child]) => child !== undefined))
	if (typeof value !== "string" || content) return value
	if (paths) return inventoryPath(value) ? value : undefined
	if (/^(?:\/|[A-Za-z]:[\\/])/.test(value) || /:\/\/|(?:^|[\s"'=(])\/(?:[^\s"'<>),;]+)|(?:^|\/)\.(?:runtime|preprocessing)(?:\/|$)/.test(value)) return undefined
	return value
}
const sourcePages = (...entries) => [...new Set(entries.flatMap((entry) => entry ? [entry.page, entry.sourcePage, ...(Array.isArray(entry.pages) ? entry.pages : []), ...(Array.isArray(entry.sourcePages) ? entry.sourcePages : [])] : []).filter((page) => Number.isSafeInteger(page) && page > 0))].sort((a, b) => a - b)
const ordinary = (resource) => {
	if (typeof resource !== "string" || resource.length > 4096 || resource.includes("\\") || /[\x00-\x1f\x7f\ud800-\udfff]/u.test(resource) || resource.split("/").some((p) => !p || p === "." || p === ".." || p.startsWith(".env") || p.startsWith(".gc-file-") || [".runtime", ".ide-state", ".git", ".preprocessing", ".opencode", ".clinerules", ".datasets-staging", ".upload-tmp", "_orchestrator"].includes(p))) throw fail("INVALID_PATH", "Use an ordinary canonical workspace-relative path without links or private directories.")
	return resource
}
function handleInput(input, allowed) {
	if (!input || typeof input !== "object" || Array.isArray(input) || Number(input.requestId !== undefined) + Number(input.jobId !== undefined) !== 1 || input.requestId !== undefined && !identifier(input.requestId) || input.jobId !== undefined && !identifier(input.jobId) || allowed && Object.keys(input).some((key) => !["requestId", "jobId", ...allowed].includes(key))) throw fail("INVALID_REQUEST", "Supply exactly one requestId or jobId with this operation's supported options.")
}
const publicJob = (job) => job ? publicMetadata({ ...Object.fromEntries(["id", "state", "resultId", "resultAvailable", "stage", "progress", "createdAt", "updatedAt", "finishedAt", "modelSelection", "coverage", "outcome"].filter((key) => job[key] !== undefined).map((key) => [key, job[key]])), ...(job.source ? { source: Object.fromEntries(["sha256", "bytes"].filter((key) => job.source[key] !== undefined).map((key) => [key, job.source[key]])) } : {}) }) : null

/** All native filesystem effects remain in this process and retain its writer lease. */
export class NativeProcessingOperations {
	static async open({ lease, workspace, scope, client, logger, invocationId, inputBytes = 8 * 1024 ** 3, waits = new ProcessingWaits() }) {
		if (!Number.isSafeInteger(inputBytes) || inputBytes < 1) throw fail("INVALID_CONFIGURATION", "Native source byte ceiling must be a positive safe integer.")
		const capabilities = await client.capabilities()
		if (!capabilities.storeScope || capabilities.storeScope !== scope.workspaceEpoch) throw fail("PROCESSING_STORE_CHANGED", "The authenticated processor store does not match the selected native scope.")
		client.bindStoreScope?.(scope.workspaceEpoch); client.storeScope = scope.workspaceEpoch
		const receipts = await NativeProcessingReceipts.open({ lease, scope })
		const operations = new NativeProcessingOperations({ lease, workspace, scope, client, receipts, inputBytes, waits, logger, invocationId })
		operations.lifetime = lease.track(new Promise((resolve) => { operations.endLifetime = resolve }))
		return operations
	}
	constructor(options) { Object.assign(this, options); this.active = new Set(); this.submitting = new Map(); this.allocating = new Map(); this.exporting = new Map(); this.admitting = true }
	event(event, receipt, extra = {}) { processingEvent(this.logger, event, { ...this.scope, invocationId: this.invocationId, origin: receipt.origin, rootId: receipt.rootId, sessionId: receipt.identity?.sessionId, requestId: receipt.requestId, jobId: receipt.jobId, exportId: receipt.exportId, sourceSha256: receipt.intent?.source?.expectedSha256, ...extra }) }
	checkCaller(caller, action) {
		if (caller?.origin === "operator") { if (!identifier(caller.sessionId)) throw fail("INVALID_CALLER", "Operator connections require a runtime-issued session identity."); return }
		const discovery = ["capabilities", "history"].includes(action)
		const executionId = (value) => typeof value === "string" && value.length > 0 && value.length <= 256 && !/[\x00-\x1f\x7f]/.test(value)
		if (caller?.origin !== "model" || !["rootId", "sessionId", "agent"].every((key) => identifier(caller[key])) || !discovery && !["messageId", "callId"].every((key) => executionId(caller[key]))) throw fail("INVALID_CALLER", "Model effects require exact runtime execution identity; context discovery requires root and acting session identity.")
		if (discovery && ["geology", "orchestrator", "report-analysis", "dataops", "standard"].includes(caller.agent)) return
		const readonly = ["result", "readTable", "readText"].includes(action)
		if (!["dataops", "standard"].includes(caller.agent) && !(readonly && caller.agent === "report-analysis")) throw fail("AGENT_NOT_ALLOWED", "Delegate processing execution through orchestrator to dataops; report-analysis is read-only.")
	}
	async fence() {
		const capabilities = await this.client.capabilities()
		if (capabilities.storeScope !== this.scope.workspaceEpoch) throw fail("PROCESSING_STORE_CHANGED", "The processor store changed. Restore the original store; retained requests must not be replayed into its replacement.")
		this.client.bindStoreScope?.(this.scope.workspaceEpoch)
		return capabilities
	}
	perform(action, caller, work) {
		this.checkCaller(caller, action)
		if (!this.admitting) throw fail("DRAINING", "Native processing admission is closed.")
		return this.trackEffect(Promise.resolve().then(async () => { await this.fence(); return work() }))
	}
	trackEffect(work) {
		const active = this.lease.track(work)
		this.active.add(active); active.then(() => this.active.delete(active), () => this.active.delete(active)); return active
	}
	visible(caller, receipt) { return caller.origin === "operator" || receipt.origin === "model" && receipt.rootId === caller.rootId }
	async receipt(caller, id, kind = "requests") { const receipt = await this.receipts.get(id, kind); if (!this.visible(caller, receipt)) throw fail("SCOPE_MISMATCH", "This request belongs to another root conversation or the native operator."); return receipt }
	view(receipt, job) {
		return { requestId: receipt.requestId, state: receipt.cancelRequested && receipt.cancellationAcknowledged && !receipt.jobId ? "cancelled" : receipt.state, receiptState: receipt.state, createdAt: receipt.createdAt, updatedAt: receipt.updatedAt || receipt.createdAt, jobId: receipt.jobId || null, cancelRequested: Boolean(receipt.cancelRequested), cancellationAcknowledged: Boolean(receipt.cancellationAcknowledged), operationOutcome: receipt.cancelRequested ? receipt.cancellationAcknowledged && (!receipt.jobId || job && terminal.has(job.state)) ? "cancelled" : "cancel_pending" : receipt.state === "accepted" ? "accepted" : receipt.state === "unknown" || receipt.state === "dispatching" ? "dispatch_unknown" : receipt.state,
			jobOutcome: job?.state || null, resultAvailable: Boolean(job?.resultId || job?.resultAvailable), ...(job ? { job: publicJob(job), ...publicJob(job), requestId: receipt.requestId, jobId: receipt.jobId } : {}), continuation: receipt.cancelRequested ? `Observe or repeat cancel with requestId ${receipt.requestId} until cancellation is settled; submission is permanently disabled for this request.` : recovery(receipt.requestId) }
	}
	async parent(resource, { create = false } = {}) {
		ordinary(resource)
		let directory = await openNativeDirectory(this.workspace)
		try {
			const parts = resource.split("/"), name = parts.pop()
			for (const part of parts) {
				const target = fdPath(directory, part)
				if (create) { try { await fs.mkdir(target, { mode: 0o755 }); await directory.sync() } catch (error) { if (error.code !== "EEXIST") throw error } }
				const next = await fs.open(target, constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW)
				await directory.close(); directory = next
			}
			const expectedParent = path.join(this.workspace, path.dirname(resource))
			const verify = async () => {
				ordinary(resource)
				if (await fs.realpath(fdPath(directory)) !== expectedParent) throw fail("INVALID_PATH", "The pinned ordinary parent moved; select the current destination explicitly.")
			}
			await verify()
			return { directory, name, address: fdPath(directory, name), verify }
		} catch (error) { await directory.close(); throw error }
	}
	async hashPath(resource, expected) {
		const parent = await this.parent(resource); let handle
		try {
			handle = await fs.open(parent.address, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK)
			const before = await handle.stat({ bigint: true })
			if (!before.isFile() || before.size > BigInt(this.inputBytes)) throw fail("INVALID_SOURCE", "Select a bounded regular document file.")
			const buffer = Buffer.alloc(1024 * 1024), hash = createHash("sha256"); let bytes = 0
			for (;;) { const { bytesRead } = await handle.read(buffer, 0, buffer.length, null); if (!bytesRead) break; bytes += bytesRead; if (bytes > this.inputBytes) throw fail("SOURCE_LIMIT", "Document exceeds the native input byte ceiling."); hash.update(buffer.subarray(0, bytesRead)) }
			const after = await handle.stat({ bigint: true }), current = await fs.lstat(parent.address, { bigint: true })
			await parent.verify()
			if (![after, current].every((stat) => ["dev", "ino", "size", "mtimeNs", "ctimeNs"].every((key) => stat[key] === before[key])) || BigInt(bytes) !== before.size) throw fail("SOURCE_CHANGED", "Source changed during preparation; select current bytes with a new explicit request.")
			const sha256 = hash.digest("hex")
			if (expected !== undefined && expected !== sha256) throw fail("SOURCE_CHANGED", "The selected file does not match the requested SHA-256.")
			return sha256
		} finally { await handle?.close(); await parent.directory.close() }
	}
	inputIntent(input) {
		const allowed = ["path", "source", "snapshotId", "expectedSha256", "profileId", "tableRecovery", "rerunOf", "requestId", "prepareOnly"]
		if (!input || typeof input !== "object" || Array.isArray(input) || Object.keys(input).some((key) => !allowed.includes(key))) throw fail("INVALID_REQUEST", "Unsupported native submission fields; identity and submission keys are runtime-owned.")
		const copy = structuredClone(input); delete copy.requestId; delete copy.prepareOnly; return copy
	}
	async allocate(caller, input) {
		const original = this.inputIntent(input), fingerprint = digest(stableStringify(original))
		const identity = caller.origin === "model" ? { ...this.scope, rootId: caller.rootId, sessionId: caller.sessionId, messageId: caller.messageId, callId: caller.callId, action: "submit" } : null
		const requestId = identity ? callUUID(identity) : randomUUID()
		const existing = await this.receipts.get(requestId).catch((error) => { if (error.code !== "ENOENT") { error.requestId ||= requestId; throw error } return null })
		if (existing) { if (existing.inputFingerprint !== fingerprint) throw fail("IDEMPOTENCY_CONFLICT", "This exact runtime call already has different retained intent.", { requestId, action: recovery(requestId) }); return existing }
		if (this.allocating.has(requestId)) { const value = await this.allocating.get(requestId); if (value.inputFingerprint !== fingerprint) throw fail("IDEMPOTENCY_CONFLICT", "Concurrent exact call changed intent.", { requestId }); return value }
		const preparing = (async () => {
			const sources = Number(input.path !== undefined) + Number(input.source !== undefined) + Number(input.snapshotId !== undefined)
			if (sources !== 1 && !(sources === 0 && identifier(input.rerunOf))) throw fail("INVALID_SOURCE", "Select exactly one project path or retained snapshot.")
			let source = input.source || (input.snapshotId ? { kind: "snapshot", snapshotId: input.snapshotId } : input.path ? { kind: "workspace-file", path: input.path } : null)
			if (!source) { const previous = unwrap(await this.client.get(input.rerunOf)); if (!identifier(previous?.source?.snapshotId)) throw fail("SOURCE_UNAVAILABLE", "The rerun job has no retained snapshot; select an explicit source."); source = { kind: "snapshot", snapshotId: previous.source.snapshotId } }
			if (source.kind === "workspace-file") {
				if (Object.keys(source).some((key) => !["kind", "path", "expectedSha256"].includes(key))) throw fail("INVALID_SOURCE", "Unsupported path source fields.")
				if (source.expectedSha256 !== undefined && input.expectedSha256 !== undefined && source.expectedSha256 !== input.expectedSha256) throw fail("SOURCE_CHANGED", "Supplied expected source digests disagree.")
				const expected = source.expectedSha256 ?? input.expectedSha256
				source = { kind: "workspace-file", path: ordinary(source.path), expectedSha256: await this.hashPath(source.path, expected) }
			} else if (source.kind !== "snapshot" || !identifier(source.snapshotId) || Object.keys(source).some((key) => !["kind", "snapshotId"].includes(key)) || input.expectedSha256 !== undefined) throw fail("INVALID_SOURCE", "Use a retained snapshot ID without path/hash overrides.")
			const intent = { source, ...(input.profileId !== undefined ? { profileId: input.profileId } : {}), ...(input.tableRecovery !== undefined ? { tableRecovery: input.tableRecovery } : {}), ...(input.rerunOf !== undefined ? { rerunOf: input.rerunOf } : {}) }
			try {
				const receipt = await this.receipts.claim({ requestId, scope: this.scope, origin: caller.origin, ...(caller.origin === "model" ? { rootId: caller.rootId, identity } : {}), inputFingerprint: fingerprint, submissionKey: randomUUID(), intent, state: "prepared", cancelRequested: false, revision: 1, createdAt: new Date().toISOString() })
				this.event("request.prepared", receipt)
				return receipt
			}
			catch (error) { error.requestId = requestId; throw error }
		})()
		this.allocating.set(requestId, preparing)
		try { return await preparing } finally { this.allocating.delete(requestId) }
	}
	submit(caller, input = {}) {
		return this.perform("submit", caller, async () => {
			const receipt = input.requestId ? await this.receipt(caller, input.requestId) : await this.allocate(caller, input)
			if (input.requestId && Object.keys(input).some((key) => !["requestId", "prepareOnly"].includes(key))) throw fail("IDEMPOTENCY_CONFLICT", "Recovery accepts only the original requestId; it never refreshes source or options.", { requestId: receipt.requestId })
			if (input.prepareOnly) return this.view(receipt)
			if (this.submitting.has(receipt.requestId)) return this.submitting.get(receipt.requestId)
			const work = this.dispatch(receipt.requestId)
			this.submitting.set(receipt.requestId, work)
			try { return await work } catch (error) { error.requestId ||= receipt.requestId; throw error } finally { this.submitting.delete(receipt.requestId) }
		})
	}
	async accept(requestId, value) {
		const job = unwrap(value)
		const receipt = await this.receipts.update(requestId, (receipt) => { this.validateMapping(receipt, job); return { state: "accepted", jobId: job.id } })
		this.event("request.accepted", receipt)
		return receipt
	}
	validateMapping(receipt, job) {
		// The processor exposes store scope as projectId on every job, and as
		// storeScope on capabilities. Never accept an id-only or wrong-key reply.
		if (!identifier(job?.id) || job.submissionKey !== receipt.submissionKey || (job.storeScope ?? job.projectId) !== this.scope.workspaceEpoch || job.storeScope !== undefined && job.storeScope !== this.scope.workspaceEpoch || job.projectId !== undefined && job.projectId !== this.scope.workspaceEpoch || receipt.jobId && receipt.jobId !== job.id) throw fail("PROCESSOR_IDENTITY_MISMATCH", "Processor reply does not bind the retained submission key, store scope and job mapping.", { status: 502, requestId: receipt.requestId })
	}
	async dispatch(requestId) {
		let receipt = await this.receipts.get(requestId)
		let submitting = false
		try {
			if (receipt.jobId) { const job = unwrap(await this.client.get(receipt.jobId)); this.validateMapping(receipt, job); return this.view(receipt, job) }
			if (receipt.cancelRequested || receipt.state === "rejected") return this.view(receipt)
			if (receipt.state !== "prepared") {
				const found = await this.client.lookup(receipt.submissionKey)
				if (found) { receipt = await this.accept(requestId, found); return this.view(receipt, unwrap(found)) }
			}
			receipt = await this.receipts.update(requestId, (latest) => latest.cancelRequested ? null : { state: "dispatching" })
			if (receipt.cancelRequested) return this.view(receipt)
			await this.fence()
			// Keyed cancellation fences even a POST that arrives after this final local check.
			receipt = await this.receipts.get(requestId)
			if (receipt.cancelRequested) return this.view(receipt)
			submitting = true
			const job = unwrap(await this.client.submit(receipt.submissionKey, receipt.intent))
			receipt = await this.accept(requestId, job)
			return this.view(receipt, job)
		} catch (error) {
			const code = String(error.code || error.error || "").toUpperCase()
			receipt = await this.receipts.update(requestId, (latest) => latest.state === "accepted" ? null : { state: submitting && error.upstreamRejected && error.status >= 400 && error.status < 500 && ![408, 429].includes(error.status) ? "rejected" : "unknown", errorCode: /^[A-Z_]{1,80}$/.test(code) ? code : "DISPATCH_UNKNOWN" })
			if (receipt.state === "unknown") this.event("dispatch.unknown", receipt)
			if (["PROCESSING_STORE_CHANGED", "PROCESSOR_IDENTITY_MISMATCH"].includes(code) || receipt.state === "rejected") throw fail(code || "SUBMISSION_REJECTED", "The retained submission did not return a verified acceptance. Inspect its handle before an explicit new attempt.", { status: code === "PROCESSOR_IDENTITY_MISMATCH" ? 502 : 409, requestId, action: recovery(requestId) })
			return this.view(receipt)
		}
	}
	async observe(caller, input, includePrivateJob = false) {
		handleInput(input)
		if (input.requestId) {
			let receipt = await this.receipt(caller, input.requestId), job = receipt.jobId ? unwrap(await this.client.get(receipt.jobId)) : null
			if (receipt.jobId) this.validateMapping(receipt, job)
			if (!job && ["unknown", "dispatching"].includes(receipt.state)) { const found = await this.client.lookup(receipt.submissionKey); if (found) { receipt = await this.accept(receipt.requestId, found); job = unwrap(found) } }
			const observation = this.view(receipt, job)
			return includePrivateJob ? { observation, job } : observation
		}
		if (!identifier(input.jobId)) throw fail("INVALID_REQUEST", "Supply requestId or jobId.")
		const job = unwrap(await this.client.get(input.jobId))
		if (job?.id !== input.jobId || job.storeScope !== undefined && job.storeScope !== this.scope.workspaceEpoch || job.projectId !== undefined && job.projectId !== this.scope.workspaceEpoch) throw fail("PROCESSOR_IDENTITY_MISMATCH", "Processor status did not match the requested job and store scope.", { status: 502 })
		const observation = { ...publicJob(job), jobId: input.jobId, jobOutcome: job?.state || null, resultAvailable: Boolean(job?.resultId || job?.resultAvailable), operationOutcome: "observed" }
		return includePrivateJob ? { observation, job } : observation
	}
	status(caller, input = {}) { return this.perform("status", caller, () => { handleInput(input, []); return this.observe(caller, input) }) }
	wait(caller, input = {}, { signal } = {}) { return this.perform("wait", caller, async () => {
		handleInput(input, ["timeoutMs"])
		const result = await this.waits.wait(`${caller.origin}:${caller.sessionId}`, { requestId: input.requestId, jobId: input.jobId }, ({ signal: observationSignal }) => { observationSignal.throwIfAborted(); return this.trackEffect(this.observe(caller, input)) }, { timeoutMs: input.timeoutMs ?? 20000, signal })
		if (result.timedOut) this.event("wait.expired", { ...input, origin: caller.origin, rootId: caller.rootId, identity: caller }, { waitId: result.waitId })
		return result
	}) }
	cancel(caller, input = {}) {
		return this.perform("cancel", caller, async () => {
			handleInput(input, [])
			if (!input.requestId) { if (!identifier(input.jobId)) throw fail("INVALID_REQUEST", "Supply requestId or jobId."); const job = unwrap(await this.client.cancel(input.jobId)); return { jobId: input.jobId, jobOutcome: job?.state, state: job?.state, operationOutcome: terminal.has(job?.state) ? "cancelled" : "cancel_pending" } }
			let receipt = await this.receipt(caller, input.requestId)
			receipt = await this.receipts.update(receipt.requestId, () => ({ cancelRequested: true }))
			this.event("cancellation.pending", receipt)
			try {
				const answer = await this.client.cancelSubmission(receipt.submissionKey, receipt.intent), job = answer.job || null
				if (answer.cancelled !== true) throw fail("CANCEL_PENDING", "Processor cancellation authority is not settled.")
				if (job) receipt = await this.accept(receipt.requestId, job)
				receipt = await this.receipts.update(receipt.requestId, () => ({ cancellationAcknowledged: true }))
				this.event(job && !terminal.has(job.state) ? "cancellation.pending" : "cancellation.settled", receipt)
				return this.view(receipt, job)
			} catch (error) { const code = String(error.code || error.error).toUpperCase(); if (["PROCESSING_STORE_CHANGED", "PROCESSOR_IDENTITY_MISMATCH"].includes(code)) throw fail(code, "Processor cancellation reply could not be bound to the original request and store.", { status: 502, requestId: receipt.requestId }); return { ...this.view(receipt), operationOutcome: "cancel_pending" } }
		})
	}
	history(caller, input = {}) {
		return this.perform("history", caller, async () => {
			const { offset = 0, limit = 50, cursor } = input
			if (Object.keys(input).some((key) => !["offset", "limit", "cursor"].includes(key)) || !Number.isSafeInteger(offset) || offset < 0 || !Number.isSafeInteger(limit) || limit < 1 || limit > 100 || cursor !== undefined && (typeof cursor !== "string" || !cursor || cursor.length > 4096 || /[\x00-\x1f\x7f]/.test(cursor))) throw fail("INVALID_REQUEST", "History uses receipt offset, limit 1–100 and an optional opaque job cursor.")
			const receipts = (await this.receipts.list()).filter((receipt) => this.visible(caller, receipt)).sort((a, b) => b.createdAt.localeCompare(a.createdAt))
			const upstream = this.client.request ? await this.client.request(`/jobs?limit=${limit}${cursor !== undefined ? `&cursor=${encodeURIComponent(cursor)}` : ""}`) : { jobs: [] }
			if (!Array.isArray(upstream.jobs) || upstream.nextCursor !== undefined && upstream.nextCursor !== null && (typeof upstream.nextCursor !== "string" || upstream.nextCursor.length > 4096 || /[\x00-\x1f\x7f]/.test(upstream.nextCursor))) throw fail("PROCESSOR_PROTOCOL_ERROR", "Processor history did not return a bounded job page and opaque continuation cursor.")
			if (upstream.jobs.some((job) => !identifier(job?.id) || job.storeScope !== undefined && job.storeScope !== this.scope.workspaceEpoch || job.projectId !== undefined && job.projectId !== this.scope.workspaceEpoch)) throw fail("PROCESSOR_IDENTITY_MISMATCH", "Processor history contains a job outside the selected store scope.", { status: 502 })
			return { requests: receipts.slice(offset, offset + limit).map((receipt) => this.view(receipt)), total: receipts.length, jobs: (upstream.jobs || []).map(publicJob), offset, nextOffset: offset + limit < receipts.length ? offset + limit : null, nextCursor: upstream.nextCursor || null }
		})
	}
	capabilities(caller) { return this.perform("capabilities", caller, async () => ({ mode: "native", enabled: true, available: true, scope: this.scope, actions: ["history", "submit", "status", "wait", "cancel", "result", "readTable", "readText", "exportProduct"], sourceKinds: ["workspace-file", "snapshot"], inputBytes: this.inputBytes })) }
	async inventory(caller, input) {
		const { observation, job } = await this.observe(caller, input, true), jobId = observation.jobId
		if (!jobId || !observation.resultAvailable) throw fail("RESULT_NOT_AVAILABLE", "No sealed result is available yet. Observe this request; do not resubmit.", { requestId: input.requestId, jobId })
		const response = await this.client.results(jobId), manifest = response.manifest || response
		if (manifest.jobId !== jobId || manifest.resultId !== observation.resultId || !Array.isArray(manifest.products)) throw fail("PRODUCT_INTEGRITY", "Sealed manifest does not match this job and result.")
		const source = job?.source
		if (source && ["sha256", "bytes", "snapshotId"].some((key) => source[key] !== undefined && source[key] !== manifest.source?.[key])) throw fail("PRODUCT_INTEGRITY", "Sealed manifest does not match the job's retained source.")
		return { observation, manifest, jobId }
	}
	result(caller, input = {}) {
		return this.perform("result", caller, async () => {
			handleInput(input, ["offset", "limit", "maxBytes", "fullManifest"])
			if (input.fullManifest !== undefined && typeof input.fullManifest !== "boolean" || input.fullManifest && ["offset", "limit", "maxBytes"].some((key) => input[key] !== undefined)) throw fail("INVALID_REQUEST", "fullManifest is an explicit boolean and cannot be combined with summary pagination.")
			const { manifest, observation, jobId } = await this.inventory(caller, input), safeManifest = publicMetadata(manifest)
			if (input.fullManifest) return { jobId, resultId: manifest.resultId, resultAvailable: true, outcome: manifest.outcome, view: "sanitized-sealed-manifest", manifest: safeManifest }
			return summarizeResult(safeManifest, publicMetadata(observation.job || observation), input)
		})
	}
	provenance(manifest, artifact, kind, pages, range, nonempty) {
		const sourceHash = manifest.source?.sha256
		if (!/^[a-f0-9]{64}$/.test(sourceHash || "")) throw fail("PRODUCT_INTEGRITY", "The retained result has no valid source hash for bounded-read provenance.")
		return { resultId: manifest.resultId, sourceHash, sourceSha256: sourceHash, pages, range, ...(nonempty ? { citationToken: `processing/${encodeURIComponent(this.scope.workspaceEpoch)}/${encodeURIComponent(manifest.resultId)}/${kind}-${encodeURIComponent(artifact.id)}/${range.kind}-${range.start}-${range.end}` } : {}) }
	}
	readTable(caller, input = {}) {
		return this.perform("readTable", caller, async () => {
			handleInput(input, ["tableId", "offset", "limit"])
			const offset = input.offset ?? 0, limit = input.limit ?? 100
			if (!identifier(input.tableId) || !Number.isSafeInteger(offset) || offset < 0 || !Number.isSafeInteger(limit) || limit < 1 || limit > 1000) throw fail("INVALID_REQUEST", "Table reads require tableId, nonnegative offset and limit 1–1000.")
			const { manifest, jobId } = await this.inventory(caller, input), table = manifest.tables?.find((table) => table.id === input.tableId)
			if (!table) throw fail("NOT_FOUND", "Select a table from the sealed inventory.")
			const read = await this.client.rows(jobId, input.tableId, { offset, limit })
			if (read.offset !== offset || !Array.isArray(read.rows) || read.count !== read.rows.length || read.count > limit || read.total !== table.rows || read.count > 0 && offset + read.count > read.total || read.rows.some((row, index) => row.index !== offset + index + 1)) throw fail("PROCESSOR_PROTOCOL_ERROR", "Processor rows do not match the requested immutable row range.")
			const rowPages = sourcePages(...read.rows.flatMap((row) => [row.source, row, ...(row.cells || []).flatMap((cell) => [cell.source, cell])]))
			const pages = rowPages.length ? rowPages : sourcePages(table.source, table)
			const safe = publicMetadata({ ...read, rows: undefined })
			safe.rows = read.rows.map((row) => ({ ...publicMetadata({ ...row, cells: undefined }), cells: (row.cells || []).map((cell) => Object.fromEntries(Object.entries(cell).filter(([key]) => !privateField(key)).map(([key, value]) => [key, publicMetadata(value, { content: ["value", "text", "formula", "display", "raw"].includes(key) })]).filter(([, value]) => value !== undefined))) }))
			return { ...safe, jobId, tableId: table.id, header: "not-inferred", ...this.provenance(manifest, table, "table", pages, { kind: "rows", start: offset, end: offset + read.count }, read.count > 0) }
		})
	}
	readText(caller, input = {}) {
		return this.perform("readText", caller, async () => {
			handleInput(input, ["productId", "offset", "limit"])
			const { manifest, jobId } = await this.inventory(caller, input), product = manifest.products.find((product) => product.id === input.productId)
			if (!product) throw fail("NOT_FOUND", "Select a product from the sealed inventory.")
			const read = await readProductText(product, (options) => this.client.product(jobId, product.id, options), input)
			return { ...read, jobId, byteRange: read.range, ...this.provenance(manifest, product, "product", sourcePages(product.source, product), { kind: "bytes", start: read.range.offset, end: read.range.offset + read.range.bytes }, read.range.bytes > 0) }
		})
	}
	async existingExport(parent, record) {
		let handle
		try {
			await parent.verify()
			handle = await fs.open(parent.address, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK)
			const before = await handle.stat({ bigint: true })
			if (!before.isFile() || before.size !== BigInt(record.bytes)) throw fail("EXPORT_CONFLICT", "Destination differs from the retained export; recovery never overwrites edits.")
			const hash = createHash("sha256"), buffer = Buffer.alloc(1024 * 1024); let bytes = 0
			for (;;) { const { bytesRead } = await handle.read(buffer, 0, buffer.length, null); if (!bytesRead) break; bytes += bytesRead; if (bytes > record.bytes) throw fail("EXPORT_CONFLICT", "Destination changed during export verification."); hash.update(buffer.subarray(0, bytesRead)) }
			const after = await handle.stat({ bigint: true }), entry = await fs.lstat(parent.address, { bigint: true })
			await parent.verify()
			if (hash.digest("hex") !== record.sha256 || bytes !== record.bytes || ![after, entry].every((stat) => ["dev", "ino", "size", "mtimeNs", "ctimeNs"].every((key) => stat[key] === before[key]))) throw fail("EXPORT_CONFLICT", "Destination differs from the retained export; make a new explicit export decision.")
			return true
		} catch (error) { if (error.code === "ENOENT") return false; throw error } finally { await handle?.close() }
	}
	exportProduct(caller, input = {}) {
		return this.perform("exportProduct", caller, async () => {
			let record, recovering = Boolean(input.exportId)
			if (input.exportId) {
				if (Object.keys(input).some((key) => key !== "exportId")) throw fail("IDEMPOTENCY_CONFLICT", "Export recovery accepts only exportId.")
				record = await this.receipt(caller, input.exportId, "exports")
			} else {
				if (caller.origin === "model" && Object.keys(input).some((key) => ["out", "destination", "path", "filename", "overwrite"].includes(key))) throw fail("DESTINATION_REQUIRES_APPROVAL", "Model exports accept only a basename inside the runtime-issued results folder.")
				handleInput(input, ["productId", "basename", "out", "destination", "overwrite"])
				const { manifest, observation, jobId } = await this.inventory(caller, input), product = manifest.products.find((product) => product.id === input.productId)
				if (!product || !/^[a-f0-9]{64}$/.test(product.sha256) || !Number.isSafeInteger(product.bytes) || product.bytes < 0) throw fail("PRODUCT_INTEGRITY", "Select a sealed product with a byte count and SHA-256.")
				let destination
				if (caller.origin === "model") {
					if (input.out !== undefined || input.destination !== undefined || input.overwrite || typeof input.basename !== "string" || input.basename.startsWith(".") || input.basename.includes("/")) throw fail("DESTINATION_REQUIRES_APPROVAL", "Model exports accept an ordinary basename only, inside the runtime-issued results folder.")
					destination = `runs/${caller.rootId}/results/${ordinary(input.basename)}`
				} else destination = ordinary(input.out || input.destination)
				const identity = caller.origin === "model" ? { ...this.scope, rootId: caller.rootId, sessionId: caller.sessionId, messageId: caller.messageId, callId: caller.callId, action: "exportProduct" } : null
				const exportId = identity ? callUUID(identity) : randomUUID()
				recovering = Boolean(await this.receipts.get(exportId, "exports").catch((error) => { if (error.code !== "ENOENT") { error.exportId ||= exportId; throw error } return null }))
				record = await this.receipts.claim({ exportId, scope: this.scope, origin: caller.origin, ...(identity ? { rootId: caller.rootId, identity } : {}), jobId, resultId: manifest.resultId, productId: product.id, destination, sha256: product.sha256, bytes: product.bytes, overwrite: caller.origin === "operator" && input.overwrite === true, state: "prepared", revision: 1, jobOutcome: observation.jobOutcome, createdAt: new Date().toISOString() }, "exports")
				if (record.destination !== destination || record.productId !== product.id || record.jobId !== jobId || record.overwrite !== Boolean(input.overwrite)) throw fail("IDEMPOTENCY_CONFLICT", "This exact export call already retained different intent.", { exportId })
			}
			if (this.exporting.has(record.exportId)) return this.exporting.get(record.exportId)
			const work = this.publishExport(record, recovering)
			this.exporting.set(record.exportId, work)
			try { return await work } finally { this.exporting.delete(record.exportId) }
		})
	}
	async publishExport(record, recoveryOnly) {
		let parent, temporary, handle
		const answer = () => {
			this.event("export.verified", record, { productSha256: record.sha256, destinationSha256: record.sha256, bytes: record.bytes, jobOutcome: record.jobOutcome })
			return { exportId: record.exportId, jobId: record.jobId, resultId: record.resultId, operationOutcome: "exported", jobOutcome: record.jobOutcome, destination: record.destination, sha256: record.sha256, destinationSha256: record.sha256, bytes: record.bytes }
		}
		try {
			parent = await this.parent(record.destination, { create: !recoveryOnly })
			if (recoveryOnly || record.state !== "prepared") {
				if (!await this.existingExport(parent, record)) throw fail("EXPORT_NOT_PUBLISHED", "Export was not found. Recovery cannot republish after interruption; make a new explicit export decision.")
				record = await this.receipts.update(record.exportId, () => ({ state: "published" }), "exports"); return answer()
			}
			record = await this.receipts.update(record.exportId, () => ({ state: "publishing" }), "exports")
			if (!this.admitting) throw fail("DRAINING", "Export stopped before publication; recover by exportId without automatic republication.")
			await parent.verify()
			temporary = fdPath(parent.directory, `.processing-${record.exportId}-${randomUUID()}.tmp`)
			handle = await fs.open(temporary, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW, 0o600)
			const response = await this.client.product(record.jobId, record.productId)
			if (response.status !== 200 || !response.body) { await response.body?.cancel(); throw fail("PRODUCT_INTEGRITY", "Sealed product download was not complete.") }
			const reader = response.body.getReader(), hash = createHash("sha256"); let bytes = 0
			try {
				for (;;) { const part = await reader.read(); if (part.done) break; bytes += part.value.length; if (bytes > record.bytes) throw fail("PRODUCT_INTEGRITY", "Product exceeds its sealed byte count."); hash.update(part.value); await handle.writeFile(part.value); if (!this.admitting) throw fail("DRAINING", "Export interrupted before publication.") }
			} finally { await reader.cancel().catch(() => {}) }
			if (bytes !== record.bytes || hash.digest("hex") !== record.sha256) throw fail("PRODUCT_INTEGRITY", "Product bytes do not match the sealed inventory.")
			await handle.sync(); await handle.close(); handle = null
			await this.fence()
			if (!this.admitting) throw fail("DRAINING", "Export interrupted before publication.")
			await parent.verify()
			// Parent is pinned. NOFOLLOW lstat is repeated at the actual publication boundary.
			let target; try { target = await fs.lstat(parent.address) } catch (error) { if (error.code !== "ENOENT") throw error }
			if (target && !target.isFile()) throw fail("INVALID_DESTINATION", "Export cannot replace links, directories or special files.")
			// Overwrite replaces this pinned directory entry, never a symlink's target.
			// Same-user edits racing the final lstat are not a separate native sandbox.
			if (record.overwrite) await fs.rename(temporary, parent.address)
			else { try { await fs.link(temporary, parent.address) } catch (error) { if (error.code === "EEXIST") throw fail("EXPORT_CONFLICT", "Destination already exists; create-only export never overwrites it."); throw error }; await fs.unlink(temporary) }
			temporary = null; await parent.directory.sync()
			record = await this.receipts.update(record.exportId, () => ({ state: "published" }), "exports")
			return answer()
		} catch (error) {
			if (error instanceof ProcessingError) { error.exportId = record.exportId; throw error }
			throw fail("EXPORT_FAILED", "Export could not complete. Inspect the retained exportId before a new explicit attempt.", { exportId: record.exportId })
		} finally { await handle?.close(); if (temporary) await fs.unlink(temporary).catch(() => {}); await parent?.directory.close() }
	}
	closeAdmission() { this.admitting = false; this.waits.abortAll() }
	async close({ deadlineMs = Date.now() + 25000 } = {}) {
		this.closeAdmission()
		let timer
		try {
			await Promise.race([Promise.allSettled([...this.active]), new Promise((_, reject) => { timer = setTimeout(() => reject(fail("CLEANUP_UNVERIFIED", "Native effects did not join by the deadline; writer exclusion remains held.")), Math.max(0, deadlineMs - Date.now())) })])
			if (!this.closed) { await this.receipts.close(); this.closed = true; this.endLifetime(); await this.lifetime }
			return { complete: true }
		} finally { clearTimeout(timer) }
	}
}
