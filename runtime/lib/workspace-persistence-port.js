import crypto from "node:crypto"
import { headEntry, pathKey } from "./cloud-file-contract.js"
import { FILE_LIMITS, FileError, budget, canonicalPath, fileError, identifier, noPersistence, stableStringify } from "./file-contract.js"

const TRANSFERS = "persistence-transfers", REPLACEMENTS = "persistence-replacements"
const REQUIREMENTS = Object.freeze(Array.from({ length: 9 }, (_, n) => `INT-0${n + 1}`))
const now = () => new Date().toISOString()
const compare = (a, b) => a < b ? -1 : a > b ? 1 : 0
const sameRef = (a, b) => Boolean(a && b && a.workspaceId === b.workspaceId && a.workspaceEpoch === b.workspaceEpoch && a.path === b.path)
const generation = (op) => op?.localGeneration ?? op?.persistence?.localGeneration ?? null
const sameSource = (a, b) => a?.kind === "runtime-capture" && b?.kind === "runtime-capture" && a.captureId === b.captureId && sameRef(a.ref, b.ref) && a.etag === b.etag && a.sizeBytes === b.sizeBytes && a.consistency === b.consistency
const invalidProtectedSource = (error) => (error.error === "capture_store_unavailable" && error.reason === "integrity") || ["unsupported_resource", "unsupported_size", "invalid_source", "invalid_id"].includes(error.error) || (error.error === "invalid_path" && error.reason === "symlink")
const sourceUnavailable = (error) => ["capture_expired", "transfer_source_missing", "not_found"].includes(error.error) || error.code === "ENOENT" || invalidProtectedSource(error)
const failure = (status, error, message, details = {}) => new FileError(status, error, `WorkspacePersistencePort: ${message}`, { agent: "file-service", tool: "workspace-persistence-port", action: "Inspect the generation's operation receipt and protected source before retrying.", ...details })
const mapped = (error, method) => {
	const e = fileError(error, `workspace-persistence-port.${method}`)
	return new FileError(e.status, e.error, e.message, { ...e.toJSON(), agent: e.agent || "file-service", tool: e.tool || `workspace-persistence-port.${method}`, action: e.action && e.action !== `workspace-persistence-port.${method}` ? e.action : "Inspect retained file-service state and retry with the recorded generation." })
}
const report = (error) => ({ status: error.status, ...error.toJSON() })
const put = (kind, id, value) => ({ type: "put", kind, id, value })
const isoTime = (value) => typeof value === "string" && /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/.test(value) && Number.isFinite(Date.parse(value)) && new Date(value).toISOString() === value
const priority = ["indeterminate", "failed", "recovery-blocked", "blocked-permission", "blocked-path", "blocked-limit", "waiting-for-local-writer", "remote-replacement-pending", "transferring", "queued", "clean", "not-configured"]

/**
 * Local integration seam. No transport, remote retry, path mapping, or lifecycle authority.
 * An injected adapter object configures callbacks; booleans do not. All remote capabilities
 * remain disabled until the backend integration requirements have been resolved.
 *
 * Parent contract:
 * - identity/ref(path) bind canonical addresses to the retained workspace epoch.
 * - locks.run(work) globally serializes this port with every managed mutation.
 * - state get/put/list/transaction store JSON metadata; transaction accepts atomic put/delete
 *   batches. Parent commits operations and their local-changes journal entries together.
 * - LocalChange is a committed LocalOperation plus {id: UUID, cursor: committedAt}. Parent
 *   assigns strictly increasing ISO-millisecond committedAt values under the same lock,
 *   including across restart. UUID record IDs and generation IDs have no ordering meaning.
 * - captures.open("capture", id) validates protected bytes and pins them until release().
 *   It returns {source, handle, release}; transfer callers stream that ID, never ref.path.
 * - applyRemote(change, bytes, baseLocalGeneration) owns final base/writer/quiet-window
 *   revalidation, recovery retention, publication/address proof, and the atomic local receipt
 *   plus remote baseline. It acquires the managed lock itself; this port calls it unlocked.
 *
 * Port-owned transfers bind {holdId, operationId, ref, localGeneration, source}. The source
 * and durable hold are recorded in one transaction while a transient reader prevents sweep.
 * Parent must retain unacknowledged operations, sources, journal entries, and holds; never
 * prune indeterminate work as preview cache. Parent-owned evidence holds remain its concern.
 */
export class WorkspacePersistencePort {
	constructor(workspace, { adapter = null, writerRegistry = null } = {}) {
		if (!workspace?.identity || typeof workspace.ref !== "function" || typeof workspace.locks?.run !== "function" || !["get", "put", "list", "transaction"].every((name) => typeof workspace.state?.[name] === "function")) throw failure(503, "integration_unavailable", "WorkspaceFiles must supply identity, ref, managed serialization, and durable state.")
		this.workspace = workspace; this.state = workspace.state
		this.adapter = adapter && typeof adapter === "object" && !Array.isArray(adapter) ? adapter : null
		this.writerRegistry = writerRegistry; this.inflight = new Map(); this.draining = false
	}
	capabilities() { return this.adapter?.aligned ? { enabled: true, state: "configured", currentStorage: "logical-heads", import: true, orderedChanges: true, snapshots: true, conditionalWrites: typeof this.adapter.upload === "function" && typeof this.adapter.mutations === "function" } : { enabled: false, state: "disabled", reason: "integration_unavailable", requirements: [...REQUIREMENTS] } }
	/** Called under capture retention, the same boundary used by transfer admission.
	 * Missing transfer rows do not establish no interest: a committed producer can
	 * be waiting for its first cloud push. Never use a newer pathname generation. */
	async sourceInterest(upload) {
		const op = await this.state.get("operations", upload.operationId)
		if (!op || !sameSource(op.publishedSource, upload.publishedSource) || generation(op) !== generation(upload)) return { needed: true, blocker: "persistenceEvidence" }
		const transfers = (await this.state.list(TRANSFERS)).filter((r) => r.source?.captureId === op.publishedSource.captureId)
		if (transfers.some((r) => r.state !== "acknowledged")) return { needed: true, blocker: "persistenceTransfer" }
		if (!this.adapter && op.persistence?.state === "not-configured") return { needed: false, proof: "disabled" }
		const acknowledged = transfers.find((r) => r.operationId === op.operationId && r.localGeneration === generation(op) && sameRef(r.ref, op.publishedSource.ref) && sameSource(r.source, op.publishedSource) && stableStringify(r.source.digest) === stableStringify(op.publishedSource.digest) && r.state === "acknowledged" && sameRef(r.acknowledgement?.ref, r.ref) && r.acknowledgement?.localGeneration === generation(op) && r.acknowledgement?.holdId === r.holdId)
		return acknowledged ? { needed: false, proof: "acknowledged" } : { needed: true, blocker: this.adapter && op.persistence ? "persistence" : "persistenceEvidence" }
	}
	#configured() {
		if (!this.adapter) throw failure(503, "integration_unavailable", "No backend-aligned adapter is configured for this local integration seam.", { requirements: [...REQUIREMENTS], action: "Resolve the backend integration requirements and supply an adapter object; a configuration flag cannot enable sync." })
	}
	#admit() { if (this.draining) throw failure(503, "draining", "The persistence port is draining accepted work.", { action: "Retain pending state and retry after the file service restarts." }) }
	#ref(ref) {
		if (!ref || typeof ref !== "object") throw failure(400, "invalid_source", "Supply a workspace address.")
		if (ref.workspaceId !== this.workspace.identity.workspaceId || ref.workspaceEpoch !== this.workspace.identity.workspaceEpoch) throw failure(409, "workspace_changed", "The address belongs to a different workspace epoch.")
		const path = canonicalPath(ref.path, { root: false }), bound = this.workspace.ref(path)
		if (!sameRef(bound, ref)) throw failure(409, "workspace_changed", "WorkspaceFiles.ref did not confirm this address.")
		return { workspaceId: ref.workspaceId, workspaceEpoch: ref.workspaceEpoch, path }
	}
	#serial(method, work) { return Promise.resolve().then(() => this.workspace.locks.run(work)).catch((error) => { if (error?.name === "AbortError") throw error; throw mapped(error, method) }) }
	#protectedSerial(method, work) {
		const captures = this.workspace.captures
		return typeof captures?.withRetention === "function" && typeof captures.reader === "function" ? captures.withRetention(() => this.#serial(method, () => work(async (id) => captures.reader(await captures.record("capture", id))))) : this.#serial(method, () => work((id) => captures.open("capture", id)))
	}
	#track(kind, operationId, work) {
		const promise = Promise.resolve().then(work).catch((error) => { throw mapped(error, kind) })
		this.inflight.set(promise, { kind, operationId })
		promise.finally(() => this.inflight.delete(promise)).catch(() => {}) // The original caller receives every failure.
		return promise
	}
	#latest(ref, operations) {
		return operations.filter((op) => ["committed", "indeterminate"].includes(op.state) && op.addresses?.some((address) => sameRef(address, ref))).sort((a, b) => compare(a.committedAt || a.acceptedAt || "", b.committedAt || b.acceptedAt || "")).at(-1) || null
	}
	async #snapshot() { return { operations: await this.state.list("operations"), transfers: await this.state.list(TRANSFERS), replacements: await this.state.list(REPLACEMENTS) } }
	#pending(ref, snapshot) {
		return snapshot.replacements.filter((record) => {
			if (!sameRef(record.ref, ref) || record.state === "applied") return false
			// A committed parent receipt resolves a crash between publication and port bookkeeping.
			return !snapshot.operations.some((op) => op.operationId === record.operationId && op.state === "committed" && op.persistence?.acknowledgedRemoteEtag === record.remoteEtag)
		}).sort((a, b) => compare(a.detectedAt, b.detectedAt)).at(-1) || null
	}
	#pendingStatus(record) {
		if (["failed", "indeterminate"].includes(record.state)) return record.state
		if (record.state === "deferred") return "waiting-for-local-writer"
		return [...this.inflight.values()].some((work) => work.operationId === record.operationId) ? "remote-replacement-pending" : "indeterminate"
	}
	#statusFor(ref, snapshot) {
		const op = this.#latest(ref, snapshot.operations)
		let status = { ...noPersistence(), state: "clean", ...(op?.persistence || {}), localGeneration: op ? generation(op) : null }
		if (op?.state === "indeterminate") status.state = "indeterminate"
		const transfer = snapshot.transfers.find((record) => record.operationId === op?.operationId && sameRef(record.ref, ref) && record.localGeneration === generation(op))
		if (transfer?.state === "acknowledged") status = { ...status, state: status.pendingRemoteEtag ? ["clean", "queued", "not-configured"].includes(status.state) ? "remote-replacement-pending" : status.state : "clean", acknowledgedRemoteEtag: transfer.acknowledgement.remoteEtag, remoteIntegrity: transfer.acknowledgement.remoteIntegrity, checkedAt: transfer.acknowledgedAt }
		else if (transfer?.state === "indeterminate") status.state = "indeterminate"
		const indeterminate = status.state === "indeterminate" || op?.state === "indeterminate"
		const pending = this.#pending(ref, snapshot)
		if (pending) status = { ...status, state: this.#pendingStatus(pending), pendingRemoteEtag: pending.remoteEtag, pendingRemoteDetectedAt: pending.detectedAt }
		if (indeterminate) status.state = "indeterminate"
		return status
	}

	/** Finite persisted snapshot, exclusive cursor; {limit=200, signal?}, ceiling 1000. */
	async *changesAfter(cursor = "", { limit, signal } = {}) {
		if (cursor !== "" && !isoTime(cursor)) throw failure(400, "invalid_cursor", "Use the previous LocalChange.cursor or an empty initial cursor.")
		const count = budget(limit, FILE_LIMITS.pageSize, FILE_LIMITS.pageMaxSize, "limit")
		signal?.throwIfAborted()
		const changes = await this.#serial("changesAfter", async () => {
			signal?.throwIfAborted()
			const records = await this.state.list("local-changes")
			for (const record of records) if (!isoTime(record.cursor) || record.cursor !== record.committedAt || record.state !== "committed") throw failure(503, "storage_unavailable", "The local change journal lacks confirmed, monotonic commit cursors.")
			records.sort((a, b) => compare(a.cursor, b.cursor))
			for (let i = 1; i < records.length; i++) if (records[i].cursor === records[i - 1].cursor) throw failure(503, "storage_unavailable", "Duplicate commit cursors cannot be resumed without losing changes.")
			return records.filter((record) => record.cursor > cursor).slice(0, count)
		})
		for (const change of changes) { signal?.throwIfAborted(); yield change }
	}

	/** Exact committed source or 409; retries reuse {source, localGeneration, holdId}. */
	captureForTransfer(ref, localGeneration) {
		return this.#track("captureForTransfer", null, () => this.#protectedSerial("captureForTransfer", async (openCapture) => {
			this.#configured(); this.#admit(); ref = this.#ref(ref); identifier(localGeneration, "localGeneration")
			if (typeof this.workspace.captures?.open !== "function") throw failure(503, "integration_unavailable", "WorkspaceFiles must supply protected capture delivery.")
			const snapshot = await this.#snapshot()
			const op = snapshot.operations.find((record) => record.state === "committed" && generation(record) === localGeneration && record.addresses?.some((address) => sameRef(address, ref)))
			if (!op || op.publishedSource?.kind !== "runtime-capture" || !sameRef(op.publishedSource.ref, ref)) throw failure(409, "source_changed", "This generation has no confirmed captured bytes at the requested address.")
			let transfer = snapshot.transfers.find((record) => sameRef(record.ref, ref) && record.localGeneration === localGeneration)
			if (transfer?.state === "acknowledged") throw failure(409, "source_changed", "This generation's transfer is already acknowledged; its intent is terminal.")
			if (transfer?.state === "indeterminate") throw new FileError(transfer.error.status, transfer.error.error, transfer.error.message, transfer.error)
			if (transfer && (transfer.operationId !== op.operationId || !sameSource(transfer.source, op.publishedSource))) throw failure(503, "storage_unavailable", "A transfer intent no longer matches its operation's source.", { state: "indeterminate" })
			if (transfer) await this.#requireHold(transfer, op)
			const source = transfer?.source || op.publishedSource
			const held = Boolean(transfer) || (await this.state.list("holds")).some((hold) => hold.source.kind === "capture" && hold.source.id === source.captureId)
			let opened
			try {
				try { opened = await openCapture(source.captureId) }
				catch (error) {
					if (!sourceUnavailable(error)) throw error
					if (held) throw await this.#missing(transfer, op, "Durably held transfer bytes are unavailable or invalid; never substitute Current.", error)
					throw failure(409, "source_changed", "The requested generation's captured bytes are no longer available.")
				}
				if (!sameSource(opened.source, source)) {
					if (held) throw await this.#missing(transfer, op, "The protected representation no longer matches the held generation.")
					throw failure(409, "source_changed", "The protected representation no longer matches the published generation.")
				}
				if (!transfer) {
					const holdId = crypto.randomUUID(), createdAt = now()
					transfer = { holdId, operationId: op.operationId, ref, localGeneration, source: opened.source, state: "queued", createdAt, acknowledgement: null, error: null }
					const hold = { holdId, source: { kind: "capture", id: source.captureId }, reason: "sync", ref, localGeneration, createdAt }
					try { await this.state.transaction([put("holds", holdId, hold), put(TRANSFERS, holdId, transfer)]) }
					catch (error) { throw failure(mapped(error, "captureForTransfer").status, "storage_unavailable", "Transfer admission could not be confirmed; inspect its atomic hold/intent transaction.", { state: "indeterminate", inspectionRef: `${TRANSFERS}/${holdId}`, cause: report(mapped(error, "captureForTransfer")) }) }
				}
				return { source: transfer.source, localGeneration, holdId: transfer.holdId }
			} finally { await opened?.release() }
		}))
	}
	async #requireHold(transfer, op) {
		const hold = await this.state.get("holds", transfer.holdId)
		if (!hold || hold.source?.kind !== "capture" || hold.source.id !== transfer.source.captureId || hold.localGeneration !== transfer.localGeneration || !sameRef(hold.ref, transfer.ref)) throw await this.#missing(transfer, op, "The transfer's generation-bound durable hold is unavailable.")
	}
	async #missing(transfer, op, message, cause) {
		const integrity = cause && invalidProtectedSource(cause)
		const error = failure(503, integrity ? "capture_store_unavailable" : "transfer_source_missing", message, { state: "indeterminate", ...(integrity ? { reason: "integrity", cause: report(mapped(cause, "protectedSource")) } : {}), action: "Retain this workspace volume and inspect the held capture and operation receipt; do not rebind or retry using the pathname." })
		const operations = []
		if (transfer) operations.push(put(TRANSFERS, transfer.holdId, { ...transfer, state: "indeterminate", error: report(error) }))
		if (op) operations.push(put("operations", op.operationId, { ...op, persistence: { ...op.persistence, state: "indeterminate", localGeneration: generation(op) }, persistenceError: report(error) }))
		await this.state.transaction(operations)
		return error
	}

	/**
	 * Result: {ref, localGeneration, holdId, remoteEtag, sizeBytes?}. ETags remain opaque.
	 * Size evidence must match the held source; absent evidence means integrity is unknown.
	 * A digest-verified claim is unavailable until a backend integrity contract is supplied.
	 * Exact duplicate receipts are idempotent, including after terminal source eviction.
	 */
	recordAcknowledgement(result) {
		return this.#track("recordAcknowledgement", null, () => this.#protectedSerial("recordAcknowledgement", async (openCapture) => {
			this.#configured()
			const ref = this.#ref(result?.ref); identifier(result.localGeneration, "localGeneration"); identifier(result.holdId, "holdId")
			if (typeof result.remoteEtag !== "string" || !result.remoteEtag) throw failure(400, "invalid_request", "An acknowledgement requires the backend's opaque remoteEtag.")
			if (result.remoteIntegrity === "digest-verified" && !this.adapter.aligned) throw failure(503, "integration_unavailable", "Backend-verified digest acknowledgement is not integrated.", { requirements: ["INT-03", "INT-09"] })
			const snapshot = await this.#snapshot(), transfer = snapshot.transfers.find((record) => record.holdId === result.holdId)
			if (!transfer || !sameRef(transfer.ref, ref) || transfer.localGeneration !== result.localGeneration) throw failure(409, "acknowledgement_mismatch", "The acknowledgement does not identify this held address and generation.")
			const sizeBytes = result.sizeBytes ?? null
			if (sizeBytes !== null && (!Number.isSafeInteger(sizeBytes) || sizeBytes < 0 || sizeBytes !== transfer.source.sizeBytes)) throw failure(409, "transfer_size_mismatch", "The acknowledged size does not match the generation's held capture.")
			if (result.remoteIntegrity === "digest-verified" && (sizeBytes === null || !/^[0-9a-f]{64}$/.test(result.sha256 || "") || result.sha256 !== transfer.source.digest?.sha256)) throw failure(409, "transfer_digest_mismatch", "The backend digest does not match the held source.")
			const acknowledgement = { ref, localGeneration: result.localGeneration, holdId: result.holdId, remoteEtag: result.remoteEtag, sizeBytes, remoteIntegrity: result.remoteIntegrity === "digest-verified" ? "digest-verified" : sizeBytes === null ? "unknown" : "size-acknowledged", ...(result.remoteIntegrity === "digest-verified" ? { sha256: result.sha256 } : {}) }
			if (transfer.state === "acknowledged") {
				if (stableStringify(transfer.acknowledgement) !== stableStringify(acknowledgement)) throw failure(409, "acknowledgement_mismatch", "This transfer already has a different terminal acknowledgement.")
				return
			}
			if (transfer.state === "indeterminate") throw new FileError(transfer.error.status, transfer.error.error, transfer.error.message, transfer.error)
			const op = snapshot.operations.find((record) => record.operationId === transfer.operationId && generation(record) === transfer.localGeneration)
			if (!op || op.state !== "committed" || !sameSource(op.publishedSource, transfer.source)) throw await this.#missing(transfer, op, "The held generation's confirmed operation/source binding is unavailable.")
			await this.#requireHold(transfer, op)
			let opened
			try {
				try { opened = await openCapture(transfer.source.captureId) }
				catch (error) {
					if (sourceUnavailable(error)) throw await this.#missing(transfer, op, "Held bytes are missing or invalid before their acknowledgement could be recorded.", error)
					throw error
				}
				if (!sameSource(opened.source, transfer.source)) throw await this.#missing(transfer, op, "The acknowledged capture does not match the held generation.")
				const acknowledgedAt = now(), acknowledged = { ...transfer, state: "acknowledged", acknowledgement, acknowledgedAt, error: null }
				const allAddressesAcknowledged = op.addresses.every((address) => sameRef(address, ref) || snapshot.transfers.some((record) => record.operationId === op.operationId && record.localGeneration === generation(op) && sameRef(record.ref, address) && record.state === "acknowledged"))
				// Never touch a newer operation or clean a multi-address move after one file result.
				let persistence = op.persistence
				const pending = this.#pending(ref, snapshot)
				const nextState = pending ? this.#pendingStatus(pending) : op.persistence?.pendingRemoteEtag ? ["clean", "queued", "not-configured"].includes(op.persistence.state) ? "remote-replacement-pending" : op.persistence.state : "clean"
				if (allAddressesAcknowledged) persistence = { ...noPersistence(), ...op.persistence, state: nextState, localGeneration: generation(op), acknowledgedRemoteEtag: result.remoteEtag, remoteIntegrity: acknowledgement.remoteIntegrity, checkedAt: acknowledgedAt }
				const metadata = []
				if (result.cloudHead) {
					const head = headEntry(result.cloudHead)
					if (!this.adapter.aligned || head.path !== ref.path || head.headToken !== result.remoteEtag || head.sizeBytes !== sizeBytes || head.sha256 !== result.sha256) throw failure(409, "acknowledgement_mismatch", "The cloud head does not identify the acknowledged captured bytes.")
					const current = await this.state.get("cloud-heads", pathKey(ref.path))
					if (!current || current.changeSeq <= head.changeSeq) metadata.push(put("cloud-heads", pathKey(ref.path), { ...head, localGeneration: op.localGeneration, observation: op.publishedObservation?.token || null, headKnown: true }))
				}
				try { await this.state.transaction([put(TRANSFERS, transfer.holdId, acknowledged), put("operations", op.operationId, { ...op, persistence }), { type: "delete", kind: "holds", id: transfer.holdId }, ...metadata]) }
				catch (error) { throw failure(mapped(error, "recordAcknowledgement").status, "storage_unavailable", "Acknowledgement commit could not be confirmed; inspect the receipt before releasing or retrying its source.", { state: "indeterminate", inspectionRef: `${TRANSFERS}/${transfer.holdId}`, cause: report(mapped(error, "recordAcknowledgement")) }) }
			} finally { await opened?.release() }
		}))
	}

	/**
	 * change: {operationId, ref (or path), remoteEtag, applyNow?, discardLocal?}.
	 * Default admission requires writerRegistry.status(ref) -> {state:"idle"|"active"|"unknown"}.
	 * Unknown/unavailable/busy returns an accepted, deferred LocalOperation-shaped result.
	 * Deferral persists metadata only and never consumes bytes; the caller must supply checked
 * bytes again. applyNow bypasses this advisory gate, not the parent's recovery/base checks.
	 */
	applyRemote(change, bytes, baseLocalGeneration) {
		return this.#track("applyRemote", change?.operationId, async () => {
			this.#configured(); this.#admit(); identifier(change?.operationId)
			const ref = this.#ref(change.ref || this.workspace.ref(canonicalPath(change.path, { root: false })))
			if (change.path !== undefined && change.path !== ref.path) throw failure(400, "invalid_path", "Remote path and address must agree.")
			if (typeof change.remoteEtag !== "string" || !change.remoteEtag || ["applyNow", "discardLocal"].some((key) => change[key] !== undefined && typeof change[key] !== "boolean")) throw failure(400, "invalid_request", "Supply an opaque remoteEtag and boolean replacement overrides.")
			if (baseLocalGeneration !== null) identifier(baseLocalGeneration, "baseLocalGeneration")
			const prepared = await this.#serial("applyRemote", async () => {
				this.#admit()
				const snapshot = await this.#snapshot(), current = this.#latest(ref, snapshot.operations)
				const previous = snapshot.replacements.find((record) => record.operationId === change.operationId)
				if (previous && (!sameRef(previous.ref, ref) || previous.remoteEtag !== change.remoteEtag || previous.baseLocalGeneration !== baseLocalGeneration)) throw failure(409, "operation_id_reused", "This remote operation already identifies a different address, version, or base generation.")
				if (previous) {
					const receipt = snapshot.operations.find((op) => op.operationId === previous.operationId && op.state === "committed" && op.addresses?.some((address) => sameRef(address, ref)) && op.persistence?.acknowledgedRemoteEtag === previous.remoteEtag)
					if (receipt) {
						if (previous.applyNow !== (change.applyNow === true) || previous.discardLocal !== (change.discardLocal === true)) throw failure(409, "operation_id_reused", "A committed remote operation's overrides cannot change.")
						return { receipt }
					}
					if (previous.state === "applied") throw failure(503, "storage_unavailable", "The remote operation's committed parent receipt is unavailable.", { state: "indeterminate", inspectionRef: `operations/${change.operationId}` })
				}
				if ((current ? generation(current) : null) !== baseLocalGeneration) throw failure(409, "source_changed", "The remote replacement's base local generation changed.", { localGeneration: current ? generation(current) : null })
				if (previous && ["failed", "indeterminate", "applying"].includes(previous.state)) throw failure(409, "source_changed", "Inspect this previously admitted remote operation before submitting new work.", { state: previous.state === "failed" ? "failed" : "indeterminate", inspectionRef: `operations/${change.operationId}` })
				let writerState = "unknown", error = null
				if (!change.applyNow && typeof this.writerRegistry?.status === "function") {
					try { writerState = (await this.writerRegistry.status(ref))?.state || "unknown" }
					catch (cause) { error = report(mapped(cause, "writerRegistry.status")) }
				}
				const deferred = !change.applyNow && writerState !== "idle"
				if (!deferred && typeof this.workspace.applyRemote !== "function") throw failure(503, "integration_unavailable", "WorkspaceFiles.applyRemote must implement recovery-aware local publication.")
				const record = { operationId: change.operationId, ref, baseLocalGeneration, remoteEtag: change.remoteEtag, detectedAt: previous?.detectedAt || now(), state: deferred ? "deferred" : "applying", reason: deferred ? writerState === "active" ? "known-local-writer" : "writer-registry-unknown" : null, applyNow: change.applyNow === true, discardLocal: change.discardLocal === true, error }
				await this.state.transaction([put(REPLACEMENTS, record.operationId, record)])
				if (!deferred) return { record }
				return { record, deferred: { operationId: record.operationId, state: "accepted", action: "apply-remote", addresses: [ref], localGeneration: baseLocalGeneration, publishedSource: null, publishedObservation: null, committedAt: null, persistence: { ...noPersistence(), ...(current?.persistence || {}), state: "waiting-for-local-writer", localGeneration: baseLocalGeneration, pendingRemoteEtag: record.remoteEtag, pendingRemoteDetectedAt: record.detectedAt }, reconciliation: { required: false, inspectionRef: null, replayAllowed: false }, deferred: true, reason: record.reason, ...(error ? { error } : {}) } }
			})
			if (prepared.receipt) return prepared.receipt
			if (prepared.deferred) return prepared.deferred
			try {
				if (typeof this.workspace.applyRemote !== "function") throw failure(503, "integration_unavailable", "WorkspaceFiles.applyRemote must implement recovery-aware local publication.")
				const result = await this.workspace.applyRemote(change, bytes, baseLocalGeneration)
				const applied = result?.state === "committed" && result.operationId === change.operationId && result.persistence?.acknowledgedRemoteEtag === change.remoteEtag
				if (result?.state === "committed" && !applied) throw failure(503, "storage_unavailable", "The parent returned a commit without the selected operation's remote baseline.", { state: "indeterminate" })
				await this.#serial("applyRemote.result", () => this.state.transaction([put(REPLACEMENTS, change.operationId, { ...prepared.record, state: applied ? "applied" : ["failed", "indeterminate"].includes(result?.state) ? result.state : "applying" })]))
				return result
			} catch (cause) {
				const error = mapped(cause, "applyRemote")
				await this.#serial("applyRemote.error", () => this.state.transaction([put(REPLACEMENTS, change.operationId, { ...prepared.record, state: error.state === "indeterminate" || error.status >= 500 ? "indeterminate" : "failed", error: report(error) })]))
				throw error
			}
		})
	}

	/** Current per-address status or aggregate of all unresolved work; aggregate generation/ETag fields are null. */
	status(ref) {
		return this.#serial("status", async () => {
			if (ref !== undefined) ref = this.#ref(ref)
			if (!this.adapter) return noPersistence()
			const snapshot = await this.#snapshot()
			if (ref) return this.#statusFor(ref, snapshot)
			const refs = new Map()
			for (const op of snapshot.operations) for (const address of op.addresses || []) refs.set(address.path, address)
			for (const record of snapshot.replacements) refs.set(record.ref.path, record.ref)
			const statuses = [...refs.values()].map((address) => this.#statusFor(address, snapshot))
			const states = statuses.map((status) => status.state)
			for (const op of snapshot.operations) {
				if (op.state === "indeterminate") states.push("indeterminate")
				if (op.persistence?.state && op.persistence.state !== "clean") states.push(op.persistence.state)
			}
			for (const transfer of snapshot.transfers) if (transfer.state !== "acknowledged") states.push(transfer.state)
			for (const record of snapshot.replacements) if (record.state !== "applied" && !snapshot.operations.some((op) => op.operationId === record.operationId && op.state === "committed" && op.persistence?.acknowledgedRemoteEtag === record.remoteEtag)) states.push(this.#pendingStatus(record))
			return { ...noPersistence(), state: priority.find((state) => states.includes(state)) || "clean", checkedAt: statuses.map((status) => status.checkedAt).filter(Boolean).sort().at(-1) || null }
		})
	}

	/** Stops admission and waits for owned callbacks only. A stalled state read is 503 drain_timeout, not invented counts. */
	async drain(deadline = new Date(Date.now() + 30000).toISOString()) {
		const end = typeof deadline === "number" ? deadline : typeof deadline === "string" ? Date.parse(deadline) : NaN
		if (!Number.isFinite(end)) throw failure(400, "invalid_request", "A drain deadline must be a timestamp.")
		this.draining = true
		let timer
		try {
			const timeout = new Promise((resolve) => { timer = setTimeout(resolve, Math.min(2147483647, Math.max(0, end - Date.now()))) })
			while (this.inflight.size && Date.now() < end) await Promise.race([Promise.allSettled([...this.inflight.keys()]), timeout])
		} finally { clearTimeout(timer) }
		// Do not queue behind a managed mutation or database read beyond the deadline.
		let snapshot, snapshotTimer
		try {
			snapshot = await Promise.race([this.#snapshot(), new Promise((_, reject) => {
				snapshotTimer = setTimeout(() => reject(failure(503, "drain_timeout", "The deadline elapsed before persisted drain counts could be read.", { state: "indeterminate", action: "Retain the workspace volume and inspect pending operations when file-state storage responds; no persistence counts or destroy acknowledgement are available." })), Math.min(2147483647, Math.max(0, end - Date.now())))
			})])
		} catch (cause) {
			const error = mapped(cause, "drain"); error.state = "indeterminate"
			error.action = "Retain the workspace volume and inspect pending operations when file-state storage responds; no authoritative drain counts are available."
			throw error
		} finally { clearTimeout(snapshotTimer) }
		const local = new Set(), remote = new Set(), failed = new Set(), indeterminate = new Set()
		for (const op of snapshot.operations) {
			const key = `operation/${op.operationId}`
			if (["accepted", "streaming", "staged", "publishing"].includes(op.state)) local.add(key)
			if (op.state === "committed" && op.persistence?.state !== "clean") remote.add(key)
			if (op.state === "failed" || op.persistence?.state === "failed") failed.add(key)
			if (op.state === "indeterminate" || op.persistence?.state === "indeterminate") indeterminate.add(key)
		}
		for (const transfer of snapshot.transfers) {
			const key = `operation/${transfer.operationId}`
			if (transfer.state !== "acknowledged") remote.add(key)
			if (transfer.state === "failed") failed.add(key)
			if (transfer.state === "indeterminate") indeterminate.add(key)
		}
		for (const record of snapshot.replacements) {
			if (record.state === "applied" || snapshot.operations.some((op) => op.operationId === record.operationId && op.state === "committed" && op.persistence?.acknowledgedRemoteEtag === record.remoteEtag)) continue
			const key = `operation/${record.operationId}`; remote.add(key)
			if (record.state === "failed") failed.add(key)
			if (this.#pendingStatus(record) === "indeterminate") indeterminate.add(key)
		}
		const active = [...this.inflight.values()].filter((work) => work.kind !== "recordAcknowledgement")
		for (let i = 0; i < active.length; i++) local.add(active[i].operationId ? `operation/${active[i].operationId}` : `callback/${i}`)
		// Backend drain/destroy acknowledgement is unresolved even with an empty local queue.
		return { localPending: local.size, remotePending: remote.size, failed: failed.size, indeterminate: indeterminate.size, complete: false }
	}
}
