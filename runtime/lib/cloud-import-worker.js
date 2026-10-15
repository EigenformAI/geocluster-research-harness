import crypto from "node:crypto"
import { AsyncLocalStorage } from "node:async_hooks"
import { cloudError, cloudPath, headEntry, pathKey, permitOwner, put, remove, sameOwner, sourceIdentity, stableId } from "./cloud-file-contract.js"
import { fileError, identifier, stableStringify } from "./file-contract.js"

const terminal = new Set(["succeeded", "partial", "failed", "cancelled", "interrupted"])
const observedStates = new Set(["queued", "running", "cancelling", ...terminal])
const now = () => new Date().toISOString()
const permanent = new Set(["digest_mismatch", "size_mismatch", "invalid_source", "invalid_source_url", "invalid_source_validator", "source_validator_mismatch", "source_substitution", "invalid_path", "reserved_intake_path", "protected_resource", "invalid_remote_change", "invalid_atomic_move", "unsupported_resource"])

/** Browser-independent delivery and convergence. Persisted identities, rather than timers, own work. */
export class CloudImportWorker {
	constructor(workspace, adapter, config = {}) {
		this.workspace = workspace; this.state = workspace.state; this.adapter = adapter; this.config = { pollMs: 5000, observationMs: 2000, maxClaimPages: 100, background: true, ...config }; this.controllers = new Set(); this.needsReconcile = true; this.receiptContext = new AsyncLocalStorage()
		if (!Number.isSafeInteger(this.config.observationMs) || this.config.observationMs <= 0) throw cloudError(503, "invalid_observation_config")
		adapter.bind(workspace)
	}
	start() { if (this.config.background) { this.wake(); this.wakeObservations() } }
	wakeObservations() {
		if (this.closed || this.draining || !this.config.background) return
		clearTimeout(this.observationTimer)
		this.observationTimer = setTimeout(() => { this.observationTimer = null; this.reportOnce().finally(() => this.wakeObservations()) }, this.config.observationMs)
		this.observationTimer.unref?.()
	}
	reportOnce() {
		if (this.reporting) return this.reporting
		if (this.closed || this.draining) return Promise.resolve()
		this.reporting = (async () => { await this.reconcile(); if (!this.draining) await this.retryReceipts({ observationsOnly: true }) })().catch((e) => {
			this.lastError = { status: e.status || 503, error: e.error || "receipt_unconfirmed" }
			this.workspace.logger.warn?.("cloud processing observation retry", this.lastError)
		}).finally(() => { this.reporting = null })
		return this.reporting
	}
	serialReceipt(operationId, work) {
		const held = this.receiptContext.getStore() || new Set()
		if (held.has(operationId)) return work()
		return this.workspace.remote.serial(operationId, () => this.receiptContext.run(new Set([...held, operationId]), work))
	}
	serialReceipts(records, work, index = 0) {
		if (index === records.length) return work()
		return this.serialReceipt(records[index].receipt.operationId, () => this.serialReceipts(records, work, index + 1))
	}
	wake(delay = 0) {
		if (this.closed || this.draining || !this.config.background) return
		clearTimeout(this.timer); this.timer = setTimeout(() => this.runOnce().finally(() => this.wake(this.config.pollMs)), delay); this.timer.unref?.()
	}
	status() { return { enabled: true, state: this.lastError ? "retrying" : this.hydrated ? "ready" : "hydrating", lastError: this.lastError || null, checkedAt: this.checkedAt || null } }
	runOnce() {
		if (this.running) return this.running
		if (this.closed || this.draining) return Promise.resolve()
		this.running = this.run().catch((e) => { this.lastError = { status: e.status || 503, error: e.error || "backend_unavailable" }; this.workspace.logger.warn?.("cloud import retry", this.lastError) }).finally(() => { this.running = null; this.checkedAt = now() })
		return this.running
	}
	async run() {
		this.lastError = null
		await this.reconcile()
		await this.retryReceipts()
		if (this.adapter.cleanupOnly) return // Observations and settlement may continue; execution authority cannot.
		const attempted = new Set()
		let claimError, hydrationError
		try {
			try { await this.drainClaims(attempted) }
			catch (error) { claimError = error }
			if (this.draining) return
			try { await this.hydrate() }
			catch (error) {
				hydrationError = error
				if (!claimError) throw error
				this.workspace.logger.warn?.("cloud import hydration retry", { status: error.status || 503, error: error.error || "backend_unavailable" })
			}
			finally {
				// Hydration may expose uploads saved after the first claim pass, even
				// when a later head fails. Give those files receipts in this invocation.
				// A failed initial page keeps its poll for the next cycle's replay.
				if (!this.draining && !claimError) try { await this.drainClaims(attempted) }
				catch (error) {
					if (!hydrationError) throw error
					this.workspace.logger.warn?.("cloud import catch-up retry", { status: error.status || 503, error: error.error || "backend_unavailable" })
				}
			}
			if (claimError) throw claimError
		} finally {
			if (!this.draining) {
				try { await this.retryReceipts({ observationsOnly: true }) }
				finally { await this.pushLocal() }
			}
		}
	}
	async drainClaims(attempted) {
		// The page cap lets local pushing proceed under continuous intake. Zero
		// disables it. Each page gets its own durable idempotency key; response
		// loss replays that page before any subsequent claim request is allocated.
		for (let page = 0; !this.draining && (!this.config.maxClaimPages || page < this.config.maxClaimPages); page++) {
			let poll = await this.state.get("cloud-sync", "poll")
			if (!poll) { poll = { requestId: crypto.randomUUID() }; await this.state.put("cloud-sync", "poll", poll) }
			const response = await this.adapter.claim(poll.requestId)
			if (!Array.isArray(response.claims)) throw cloudError(502, "invalid_claim_response")
			const fresh = response.claims.some((claim) => !attempted.has(claim.workId))
			const claimed = new Map()
			for (const claim of response.claims) {
				this.validateClaim(claim)
				const existing = await this.state.get("cloud-deliveries", claim.workId)
				if (existing && existing.claim.source.fileVersionId !== claim.source.fileVersionId) throw cloudError(409, "work_source_changed")
				if (existing?.failureReport && !existing.failureReport.retryable) continue // Report replay never allocates another source attempt.
				const delivery = { ...existing, claim: this.workspace.remote.claimMetadata(claim), progressSeq: existing?.claim.attemptId === claim.attemptId ? existing.progressSeq || 0 : 0, ...(existing?.claim.attemptId === claim.attemptId ? {} : { pendingProgress: null }), state: "pending" }
				await this.state.put("cloud-deliveries", claim.workId, delivery)
				claimed.set(claim.workId, delivery)
			}
			await this.state.delete("cloud-sync", "poll")
			// Include retained retries once per pass, then only this page's work.
			for (const delivery of page === 0 ? await this.state.list("cloud-deliveries") : claimed.values()) {
				if (this.draining) return
				if (attempted.has(delivery.claim.workId)) continue
				attempted.add(delivery.claim.workId)
				if (delivery.state === "failure-reporting") { await this.reportFailure(delivery); continue }
				if (delivery.state !== "pending") continue
				try { await this.deliver(delivery) }
				catch (cause) { const e = cause.code ? fileError(cause, "cloud-import") : cause; await this.failure(delivery, e); this.lastError = { status: e.status || 503, error: e.error || "backend_unavailable" } }
			}
			// A backend may return unresolved/reassigned old work. Keep its updated
			// claim for the next invocation instead of spinning or repeating effects.
			if (!fresh) return
		}
	}
	validateClaim(claim) {
		const ws = this.workspace
		if (claim.workspaceId !== ws.identity.workspaceId || claim.workspaceEpoch !== ws.identity.workspaceEpoch || !["new", "reconcile", "wait-owner", "rehydrate"].includes(claim.recovery) || !["auto", "skip"].includes(claim.processingPolicy) || !Number.isSafeInteger(claim.attemptRevision) || claim.attemptRevision < 1 || claim.processingRequestId !== `auto:${claim.workId}`) throw cloudError(409, "claim_identity_mismatch")
		identifier(claim.operationId); identifier(claim.workId)
	}
	async failure(delivery, e) {
		const op = await this.state.get("operations", delivery.claim.operationId)
		const uncertain = op?.state === "indeterminate" || op?.state === "publishing" || op?.effectApplied || delivery.claim.recovery === "reconcile" || delivery.claim.recovery === "wait-owner"
		if (permanent.has(e.error) && !uncertain) {
			delivery.failureReport ||= { stage: delivery.stage || "downloading", error: e.error, retryable: false }
			delivery.state = "failure-reporting"; delivery.error = { status: e.status || 422, error: e.error }
			await this.state.put("cloud-deliveries", delivery.claim.workId, delivery)
			if (op && op.state !== "committed") await this.state.put("operations", op.operationId, { ...op, state: "failed", finishedAt: now(), error: delivery.error })
			await this.reportFailure(delivery); return
		}
		if (["source_changed", "waiting_local_writer"].includes(e.error)) await this.progress(delivery, "waiting-local-base").catch(() => {})
		const superseded = e.status === 409 && ["head_changed", "source_superseded", "remote_superseded", "work_superseded", "claim_conflict"].includes(e.error)
		await this.state.put("cloud-deliveries", delivery.claim.workId, { ...delivery, state: superseded ? "superseded" : "pending", error: { status: e.status || 503, error: e.error || "backend_unavailable" } })
	}
	async reportFailure(delivery) {
		const response = await this.adapter.reportFailure(delivery.claim, delivery.failureReport)
		if (response.workId !== delivery.claim.workId || response.deliveryState !== "failed") throw cloudError(502, "invalid_failure_response")
		await this.state.put("cloud-deliveries", delivery.claim.workId, { ...delivery, state: "failed", failureAcknowledged: true })
	}
	async progress(delivery, stage, downloadedBytes = 0, receiptId = null) {
		delivery.stage = stage
		if (!(Date.parse(delivery.claim.leaseExpiresAt) > Date.now())) return
		// Persist the exact sequence/payload before dispatch so response loss replays, never mutates it.
		if (!delivery.pendingProgress) {
			delivery.pendingProgress = { progressSeq: (delivery.progressSeq || 0) + 1, stage, downloadedBytes, receiptId }
			await this.state.put("cloud-deliveries", delivery.claim.workId, delivery)
		}
		const result = await this.adapter.progress(delivery.claim, delivery.pendingProgress)
		delivery.progressSeq = delivery.pendingProgress.progressSeq; delete delivery.pendingProgress
		if (result.leaseExpiresAt) delivery.claim.leaseExpiresAt = result.leaseExpiresAt
		await this.state.put("cloud-deliveries", delivery.claim.workId, delivery)
	}
	async grant(op, kind) {
		const claim = op.claim, key = kind === "publication" ? "publicationPermit" : "processingPermit"
		if (op[key]) return permitOwner(op[key], this.workspace, claim.runtimeId, kind)
		if (op[`${key}Intent`]) await this.inspectPermit(op, kind)
		if (op[key]) return op[key]
		if (claim.recovery === "wait-owner" || !(Date.parse(claim.leaseExpiresAt) > Date.now())) throw cloudError(409, "reconciliation_required")
		if (kind === "processing" && claim.processingReceipt?.state === "historical") throw cloudError(409, "historical_processing_unresolved")
		if (claim.recovery === "reconcile") {
			if (kind !== "processing" || !op.publicationPermit || !op.publishedSource || ["publishing", "indeterminate"].includes(op.state)) throw cloudError(409, "reconciliation_required")
			const work = await this.adapter.getWork(claim.workId)
			if (work.recovery === "wait-owner" || work.processingReceipt?.state === "historical" || !sameOwner(work.publicationPermit, claim) || work.publicationPermit.permitId !== op.publicationPermit.permitId) throw cloudError(409, "reconciliation_required")
			if (work.processingPermit) { op.processingPermit = permitOwner(work.processingPermit, this.workspace, claim.runtimeId, kind); await this.state.put("operations", op.operationId, op); return op.processingPermit }
		}
		op[`${key}Intent`] = true; await this.state.put("operations", op.operationId, op)
		op[key] = permitOwner(await this.adapter.permit(claim, kind, op.receiptId, op.publicationPermit?.permitId), this.workspace, claim.runtimeId, kind)
		await this.state.put("operations", op.operationId, op); return op[key]
	}
	async inspectPermit(op, kind) {
		const key = kind === "publication" ? "publicationPermit" : "processingPermit", work = await this.adapter.getWork(op.claim.workId)
		if (work.recovery === "wait-owner" || kind === "processing" && work.processingReceipt?.state === "historical") throw cloudError(409, "reconciliation_required")
		if (work[key]) op[key] = permitOwner(work[key], this.workspace, op.claim.runtimeId, kind)
		await this.state.put("operations", op.operationId, op)
		return op[key] || null
	}
	reconcile() {
		if (this.reconciling) return this.reconciling
		this.reconciling = (async () => {
			const records = (await this.state.list("cloud-imports")).sort((a, b) => a.receipt.operationId.localeCompare(b.receipt.operationId))
			if (!this.needsReconcile && !records.some((r) => r.reconcileRequired)) return
			// Recovery locks the batch before reading receipt payloads. Expired acknowledgements
			// request recovery only after releasing their operation lock, avoiding lock inversion.
			await this.serialReceipts(records, async () => this.reconcileSerial((await Promise.all(records.map((r) => this.state.get("cloud-imports", r.workId)))).filter(Boolean)))
		})().finally(() => { this.reconciling = null })
		return this.reconciling
	}
	async reconcileSerial(records) {
		if (!this.needsReconcile && !records.some((r) => r.reconcileRequired)) return
		// Fence fresh local dispatch before any asynchronous authority inspection. Already
		// submitted processor work keeps its mapping and is never cancelled or resubmitted here.
		for (const record of records) this.workspace.processing.revokeCloud(record)
		for (let at = 0; at < records.length; at += 50) {
			const group = []
			for (let record of records.slice(at, at + 50)) {
				record = { ...record, reconcileRequired: true }
				await this.state.put("cloud-imports", record.workId, record)
				const work = await this.adapter.getWork(record.workId)
				if (work.recovery === "wait-owner") { this.workspace.processing.revokeCloud(record); await this.state.put("cloud-imports", record.workId, { ...record, ownerRecovery: "wait-owner" }); continue }
				if (work.recovery === "rehydrate" && (!work.publicationPermit || !sameOwner(work.publicationPermit, record.claim) || work.publicationPermit.permitId !== record.publicationPermit.permitId)) {
					this.workspace.processing.revokeCloud(record)
					await this.state.transaction([put("cloud-import-history", stableId(`${record.receipt.operationId}:${record.claim.runtimeId}`), { ...record, ownerRecovery: "fenced" }), remove("cloud-imports", record.workId)])
					continue
				}
				group.push(record)
			}
			if (!group.length) continue
			const response = await this.adapter.reconcile(group)
			// A malformed batch is transport/protocol uncertainty, not a per-item rejection.
			// Validate its complete membership and every accepted authority before restoring any.
			if (!Array.isArray(response?.results) || response.results.length !== group.length || new Set(response.results.map((r) => r?.workId)).size !== group.length || response.results.some((r) => !r || !group.some((record) => record.workId === r.workId) || !["accepted", "stale", "conflict"].includes(r.status) || r.status === "accepted" && !["reuse-ticket", "record-skip", "resume-publication", "rehydrate", "wait-owner"].includes(r.action))) throw cloudError(502, "invalid_reconciliation_response")
			const accepted = []
			for (const record of group) {
				const result = response.results.find((r) => r.workId === record.workId)
				if (result.status !== "accepted") { this.lastError = { status: 409, error: "receipt_reconciliation_required" }; continue }
				if (result.action === "wait-owner") throw cloudError(409, "receipt_reconciliation_required")
				if (result.action === "rehydrate") {
					const publication = result.publicationPermit, processing = record.processingReceipt
					if (!sameOwner(publication, record.claim) || publication.kind !== "publication" || publication.permitId !== record.publicationPermit.permitId || publication.ownerRevision !== record.publicationPermit.ownerRevision || !["granted", "completed"].includes(publication.state) || record.processingPermit || !["historical", "skipped"].includes(processing.state) || processing.state === "skipped" && (result.processingPermit || processing.processingPermitId)) throw cloudError(409, "receipt_reconciliation_required")
				}
				let processingPermit = null, observationOnly = false
				if (record.processingReceipt.state === "ticket") {
					const permit = result.processingPermit || record.processingPermit
					if (!sameOwner(permit, record.claim) || permit.permitId !== record.processingReceipt.processingPermitId) throw cloudError(409, "permit_owner_mismatch")
					const job = await this.workspace.processing.record(record.processingReceipt.ticketId)
					observationOnly = job.deliveryStage === "terminal"
					if (permit.kind !== "processing" || permit.ownerRevision !== job.processingOwnerRevision || !(observationOnly ? ["granted", "reconciliation-pending", "completed"].includes(permit.state) : permit.state === "granted")) throw cloudError(409, "permit_owner_mismatch")
					processingPermit = permit
				}
				accepted.push({ record, processingPermit, observationOnly })
			}
			for (const { record, processingPermit, observationOnly } of accepted) {
				await this.state.put("cloud-imports", record.workId, { ...record, ownerRecovery: null, ackedRevision: record.receiptRevision, reconcileRequired: false, ...(record.observedProcessing ? { acknowledgedObservation: record.observedProcessing } : {}) })
				if (processingPermit) this.workspace.processing.authorizeCloud({ ...record, processingPermit }, { observationOnly })
			}
		}
		this.needsReconcile = false
	}
	async deliver(delivery) {
		const confirmed = await this.serialReceipt(delivery.claim.operationId, () => this.deliverSerial(delivery))
		if (confirmed === false) {
			await this.reconcile()
			await this.serialReceipt(delivery.claim.operationId, async () => {
				const receipt = await this.reconciledReceipt(delivery.claim.workId)
				await this.settle(receipt)
				delivery.state = "delivered"; await this.state.put("cloud-deliveries", delivery.claim.workId, delivery)
			})
		}
	}
	async deliverSerial(delivery) {
		const claim = delivery.claim, ws = this.workspace, existing = await this.state.get("cloud-imports", claim.workId)
		if (claim.recovery === "wait-owner") { if (existing) { ws.processing.revokeCloud(existing); await this.state.put("cloud-imports", claim.workId, { ...existing, ownerRecovery: "wait-owner" }) } delivery.state = "wait-owner"; await this.state.put("cloud-deliveries", claim.workId, delivery); return }
		sourceIdentity(claim.source); cloudPath(claim.destination.path, { intake: true }); headEntry({ ...claim.destination, kind: "file", fileVersionId: claim.source.fileVersionId, sizeBytes: claim.source.sizeBytes, sha256: claim.source.sha256 })
		if (existing) {
			if (!sameOwner(existing.claim, claim)) throw cloudError(409, "receipt_owner_mismatch")
			if (existing.reconcileRequired || existing.ownerRecovery) throw cloudError(409, "receipt_reconciliation_required")
			if (claim.recovery === "reconcile" || !(existing.ackedRevision > 0) && !(Date.parse(claim.leaseExpiresAt) > Date.now())) { this.needsReconcile = true; return false }
			const confirmed = await this.ack(existing, claim); delivery.state = "delivered"; await this.state.put("cloud-deliveries", claim.workId, delivery); return confirmed
		}
		let op = await this.state.get("operations", claim.operationId)
		if (op?.claim && !sameOwner(op.claim, claim)) op = await ws.remote.rehome(op, claim)
		if (claim.recovery === "reconcile") {
			// Resume only this same-owner prepared journal. A fresh live claim may
			// obtain the first processing permit after existing authority is inspected.
			const work = await this.adapter.getWork(claim.workId)
			if (!op || !op.publishedSource || ["publishing", "indeterminate"].includes(op.state)) throw cloudError(409, "reconciliation_required")
			op.publicationPermit = permitOwner(work.publicationPermit || claim.publicationPermit, ws, claim.runtimeId, "publication")
			if (work.processingPermit || claim.processingPermit) op.processingPermit = permitOwner(work.processingPermit || claim.processingPermit, ws, claim.runtimeId, "processing")
			op.claim = ws.remote.claimMetadata(claim); await this.state.put("operations", op.operationId, op)
			if (!op.processingAdmission) {
				if ((await this.state.list("processing-jobs")).some((job) => job.cloudWorkId === claim.workId) || await this.state.get("processing-requests", claim.processingRequestId)) throw cloudError(409, "processing_mapping_conflict")
				// Reuse a registered permit, or admit the first one for this uncommitted journal.
				let reader
				try {
					if (!op.processingPermit && claim.processingPolicy === "auto" && !["skipped", "historical", "ticket"].includes(claim.processingReceipt?.state)) {
						reader = await ws.captures.open("capture", op.publishedSource.captureId)
						const source = reader.source
						if (op.intent.source?.fileVersionId !== claim.source.fileVersionId || source.captureId !== op.publishedSource.captureId || source.ref.workspaceId !== ws.identity.workspaceId || source.ref.workspaceEpoch !== ws.identity.workspaceEpoch || source.ref.path !== claim.destination.path || source.sizeBytes !== claim.source.sizeBytes || source.digest?.sha256 !== claim.source.sha256) throw cloudError(409, "source_substitution")
						// Reassignment clears backend progress. Prove this retained capture and
						// durably report verification for the fresh attempt before its first grant.
						await this.progress(delivery, "verified", source.sizeBytes, op.receiptId)
						op.claim = ws.remote.claimMetadata(delivery.claim)
						await this.state.put("operations", op.operationId, op)
					}
					await ws.processing.reserveCloud(op, () => this.grant(op, "processing"), () => this.inspectPermit(op, "processing"))
				} finally { await reader?.release() }
			}
		} else {
			if (!(Date.parse(claim.leaseExpiresAt) > Date.now())) throw cloudError(409, "reconciliation_required")
			const entry = { ...claim.destination, kind: "file", fileVersionId: claim.source.fileVersionId, sizeBytes: claim.source.sizeBytes, sha256: claim.source.sha256 }
			if (!op?.publishedSource) {
				await this.progress(delivery, "downloading")
				const instruction = this.adapter.sourceUrl ? await this.adapter.sourceUrl(claim) : await this.adapter.source(claim.source.fileVersionId)
				const source = instruction.source || instruction
				if (stableStringify(sourceIdentity(source)) !== stableStringify(sourceIdentity(claim.source))) throw cloudError(409, "source_substitution")
				const controller = new AbortController(); this.controllers.add(controller)
				let last = Date.now()
				let body
				try {
					body = await this.adapter.download(source, controller.signal)
					op = await ws.remote.prepare({ operationId: claim.operationId, path: entry.path, remoteEtag: entry.headToken, entries: [entry], processingPolicy: "skip", claim, onProgress: async (size) => { if (Date.now() - last >= 30000) { await this.progress(delivery, "downloading", size); last = Date.now() } } }, body)
				} finally { body?.destroy?.(); this.controllers.delete(controller) }
			}
			await this.progress(delivery, "verified", op.sizeBytes, op.receiptId)
			op.claim = ws.remote.claimMetadata(delivery.claim)
			await this.state.put("operations", op.operationId, op)
			await this.grant(op, "publication")
			await ws.processing.reserveCloud(op, () => this.grant(op, "processing"), () => this.inspectPermit(op, "processing"))
		}
		await ws.remote.publish(op)
		const receipt = await this.state.get("cloud-imports", claim.workId)
		if (receipt.processingReceipt.state === "ticket") ws.processing.authorizeCloud(receipt)
		ws.processing.wake()
		await this.progress(delivery, receipt.processingReceipt.state === "awaiting-capacity" ? "awaiting-capacity" : receipt.processingReceipt.state === "ticket" ? "processing-linked" : "published", op.sizeBytes, op.receiptId)
		const confirmed = await this.ack(receipt, claim)
		if (confirmed === false) return false // Settlement follows confirmed receipt recovery outside this operation lock.
		await this.settle(receipt)
		delivery.state = "delivered"; await this.state.put("cloud-deliveries", claim.workId, delivery)
		return confirmed
	}
	async reconciledReceipt(workId) {
		const record = await this.state.get("cloud-imports", workId)
		if (!record || record.ownerRecovery || record.reconcileRequired) throw cloudError(409, "receipt_reconciliation_required")
		return record
	}
	async retryReceipts({ observationsOnly = false } = {}) {
		for (const snapshot of await this.state.list("cloud-imports")) {
			if (this.draining) return
			const confirmed = await this.serialReceipt(snapshot.receipt.operationId, () => this.retryReceiptSerial(snapshot.workId, observationsOnly))
			if (confirmed === false) {
				await this.reconcile()
				if (!observationsOnly) await this.serialReceipt(snapshot.receipt.operationId, () => this.settle(snapshot))
			}
		}
	}
	async retryReceiptSerial(workId, observationsOnly) {
		// An earlier expired acknowledgement can reconcile and reject a later item.
		// The list supplies identities, never authority for the rest of this pass.
		let record = await this.state.get("cloud-imports", workId)
		if (!record || record.ownerRecovery || record.reconcileRequired) return
		if (observationsOnly && record.processingReceipt.state !== "ticket") return
		try {
			if (record.processingReceipt.state === "awaiting-capacity" && !this.adapter.cleanupOnly) {
				const op = await this.state.get("operations", record.receipt.operationId)
				const delivery = await this.state.get("cloud-deliveries", record.workId)
				if (delivery) { await this.progress(delivery, "awaiting-capacity", record.source.sizeBytes, record.receipt.receiptId); op.claim = this.workspace.remote.claimMetadata(delivery.claim) }
				// Retention opens the original capture; never reconstruct it from the live path.
				const reader = await this.workspace.captures.open("capture", record.source.captureId)
				try {
					record = await this.reconciledReceipt(record.workId)
					await this.workspace.processing.reserveCloud(op, async () => { await this.reconciledReceipt(record.workId); return this.grant(op, "processing") }, () => this.inspectPermit(op, "processing"))
					if (op.processingAdmission.state !== "awaiting-capacity") {
						await this.workspace.captures.withRetentionMetadata("capture", record.source.captureId, async () => {
							const metadata = await this.workspace.processing.cloudMetadata(op)
							// Metadata construction awaits storage. Merge only the still-accepted
							// current receipt; never overwrite a rejection with a cached flag.
							record = await this.reconciledReceipt(record.workId)
							record = { ...record, processingReceipt: metadata.processingReceipt, processingPermit: op.processingPermit || null, receiptRevision: record.receiptRevision + 1 }
							return { metadata: [...metadata.metadata, put("cloud-imports", record.workId, record), put("operations", op.operationId, { ...op, processing: record.processingReceipt })], result: record }
						})
						record = await this.reconciledReceipt(record.workId)
						if (record.processingReceipt.state === "ticket") this.workspace.processing.authorizeCloud(record)
						this.workspace.processing.wake()
					}
				} finally { await reader.release() }
			}
			if (record.processingReceipt.state === "ticket") {
				const job = await this.workspace.processing.record(record.processingReceipt.ticketId)
				record = await this.reconciledReceipt(record.workId)
				if (job.processorJobId && !record.processingReceipt.processorJobId) { record = { ...record, receiptRevision: record.receiptRevision + 1, processingReceipt: { ...record.processingReceipt, processorJobId: job.processorJobId } }; await this.state.put("cloud-imports", record.workId, record) }
				// Only processor polls establish liveness. Receipt writes, retries and
				// terminal cleanup must never manufacture a fresh running sample.
				// The first terminal sample is immutable, including its timestamp. Later
				// publication checks update the local job without replacing that observation.
				if (!terminal.has(record.observedProcessing?.state) && observedStates.has(job.processorState) && job.lastCheckedAt) {
					const observedProcessing = { state: job.processorState, observedAt: job.lastCheckedAt, ownerRevision: record.processingPermit.ownerRevision, startedAt: job.startedAt ?? null, finishedAt: job.finishedAt ?? null, interruptedAt: job.processorInterruptedAt ?? null, stage: job.processorStage ?? null, progress: job.processorProgress ?? null, queueAhead: job.processorState === "queued" ? job.queueAhead ?? null : null }
					if (stableStringify(record.observedProcessing) !== stableStringify(observedProcessing)) { record = { ...record, observedProcessing }; await this.state.put("cloud-imports", record.workId, record) }
				}
			}
			if (record.ackedRevision < record.receiptRevision || record.observedProcessing && stableStringify(record.acknowledgedObservation) !== stableStringify(record.observedProcessing)) { if (await this.ack(record) === false) return false }
			if (!observationsOnly) await this.settle(record)
		} catch (e) { this.lastError = { status: e.status || 503, error: e.error || "receipt_unconfirmed" } }
	}
	async ack(record, claim = record.claim) {
		record = await this.state.get("cloud-imports", record.workId)
		if (record.reconcileRequired || record.ownerRecovery) throw cloudError(409, "receipt_reconciliation_required")
		// A confirmed receipt remains eligible for attempt/owner-checked acknowledgement
		// after delivery expiry. An unknown first receipt must reconcile outside this lane.
		if (!(record.ackedRevision > 0) && !(Date.parse(claim.leaseExpiresAt) > Date.now())) {
			this.needsReconcile = true
			return false
		}
		let result
		try { result = await this.adapter.ack(claim, record) }
		catch (error) {
			if (error.status === 409 || error.status === 410) { this.workspace.processing.revokeCloud(record); this.needsReconcile = true; await this.state.put("cloud-imports", record.workId, { ...record, reconcileRequired: true }) }
			throw error
		}
		if (!["available", "superseded"].includes(result.deliveryState)) throw cloudError(502, "invalid_ack_response")
		record = { ...record, claim, ackedRevision: record.receiptRevision, deliveryState: result.deliveryState, ...(record.observedProcessing ? { acknowledgedObservation: record.observedProcessing } : {}) }
		await this.state.put("cloud-imports", record.workId, record)
		return true
	}
	async evidence(record, localState, job = null) {
		const captureId = job?.captureId || record.source?.captureId, held = captureId && (await this.state.list("holds")).some((h) => h.source?.kind === "capture" && h.source.id === captureId)
		// An admitted ticket's submission identity cannot be removed or combined with
		// not-submitted. Only a matching terminal processor job discharges that mapping.
		const processorTerminal = job && terminal.has(job.processorState) && job.processorJobId && terminal.has(job.outcome)
		return { owner: { runtimeId: record.claim.runtimeId, ...this.workspace.identity }, local: { state: localState, receiptId: record.receipt.receiptId, ticketId: job?.runtimeJobId || null, sourceHold: held ? "retained" : "released" }, processor: { submissionKey: job?.upstreamSubmissionKey || null, jobId: job?.processorJobId || null, state: job ? processorTerminal ? "terminal" : "unknown" : "not-submitted", outcome: processorTerminal ? job.outcome === "succeeded" ? "completed" : job.outcome : null } }
	}
	async settle(record) {
		record = await this.state.get("cloud-imports", record.workId)
		if (!record || record.ownerRecovery || record.reconcileRequired) return
		if (!record.publicationSettled) {
			const job = record.processingReceipt.state === "ticket" ? await this.workspace.processing.record(record.processingReceipt.ticketId) : null
			record = await this.settlementIntent(record, "publication", { receiptId: record.receipt.receiptId, state: "completed", evidence: await this.evidence(record, "terminal", job) })
			const result = await this.adapter.settle(record.publicationPermit, record.publicationSettlementIntent)
			if (result.state !== "completed") throw cloudError(409, "publication_settlement_unconfirmed")
			record = { ...record, publicationSettled: true }; await this.state.put("cloud-imports", record.workId, record)
		}
		if (record.processingPermit && !record.processingSettled && record.processingReceipt.state === "ticket") {
			const job = await this.workspace.processing.record(record.processingReceipt.ticketId)
			if (job.deliveryStage !== "terminal") return
			const neverSubmitted = !job.dispatchIntentAt && !job.processorJobId
			if (!terminal.has(job.processorState) && !neverSubmitted) return
			const interrupted = job.processorState === "interrupted"
			// Completed settlement can freeze backend terminal metadata. A job that ended
			// during an earlier acknowledgement must first confirm its own terminal sample.
			if (!neverSubmitted && !interrupted && (record.observedProcessing?.state !== job.processorState || stableStringify(record.acknowledgedObservation) !== stableStringify(record.observedProcessing))) return
			const evidence = await this.evidence(record, "terminal", job)
			if (interrupted && !neverSubmitted) evidence.processor.state = "unknown"
			record = await this.settlementIntent(record, "processing", { receiptId: record.receipt.receiptId, state: neverSubmitted || interrupted ? "interrupted" : "completed", evidence })
			const result = await this.adapter.settle(record.processingPermit, record.processingSettlementIntent)
			if (result.state === "reconciliation-pending") return
			if (result.state !== record.processingSettlementIntent.state) throw cloudError(409, "processing_settlement_unconfirmed")
			record = { ...record, processingSettled: true }; await this.state.put("cloud-imports", record.workId, record)
		}
		if (record.processingPermit && !record.processingSettled && record.processingReceipt.state === "skipped") {
			record = await this.settlementIntent(record, "processing", { receiptId: record.receipt.receiptId, state: "skipped", evidence: await this.evidence(record, "not-admitted") })
			const result = await this.adapter.settle(record.processingPermit, record.processingSettlementIntent)
			if (result.state === "reconciliation-pending") return
			if (result.state !== record.processingSettlementIntent.state) throw cloudError(409, "processing_settlement_unconfirmed")
			record = { ...record, processingSettled: true }; await this.state.put("cloud-imports", record.workId, record)
		}
		if (record.publicationSettled && (!record.processingPermit || record.processingSettled) && record.ackedRevision === record.receiptRevision && record.processingReceipt.state !== "awaiting-capacity" && record.sourceHoldId) {
			await this.state.transaction([remove("holds", record.sourceHoldId), put("cloud-imports", record.workId, { ...record, sourceHoldId: null })])
		}
	}
	async settlementIntent(record, kind, body) {
		const key = `${kind}SettlementIntent`
		if (!record[key]) { record = { ...record, [key]: body }; await this.state.put("cloud-imports", record.workId, record) }
		return record
	}
	async hydrate() {
		let checkpoint = await this.state.get("cloud-sync", "checkpoint")
		if (!checkpoint) {
			let snapshot = await this.state.get("cloud-sync", "snapshot")
			if (!snapshot) { snapshot = { requestId: crypto.randomUUID(), entries: [], cursor: null }; await this.state.put("cloud-sync", "snapshot", snapshot) }
			try {
				if (!snapshot.snapshotId) { const created = this.adapter.createSnapshot ? await this.adapter.createSnapshot(snapshot.requestId) : await this.adapter.snapshot(); snapshot = { ...snapshot, ...created }; await this.state.put("cloud-sync", "snapshot", snapshot) }
				if (this.adapter.snapshotPage && !snapshot.complete) {
					do { const page = await this.adapter.snapshotPage(snapshot.snapshotId, snapshot.cursor); if (page.snapshotId !== snapshot.snapshotId || page.throughSeq !== snapshot.throughSeq) throw cloudError(502, "snapshot_boundary_changed"); snapshot.entries.push(...page.entries.map(headEntry)); snapshot.cursor = page.nextCursor; snapshot.complete = !page.nextCursor; await this.state.put("cloud-sync", "snapshot", snapshot) } while (!snapshot.complete)
				}
				const sorted = snapshot.entries.map(headEntry).sort((a, b) => {
					if (a.kind === "tombstone" || b.kind === "tombstone") return a.kind === b.kind ? b.path.split("/").length - a.path.split("/").length : a.kind === "tombstone" ? -1 : 1
					return a.path.split("/").length - b.path.split("/").length || (a.kind === "directory" ? -1 : 1)
				})
				for (const entry of sorted) await this.applyEntries([entry], `hydrate:${stableId(`${snapshot.snapshotId}:${entry.path}:${entry.headToken}`)}`)
				// The complete snapshot carries authoritative tombstones. A genuinely absent
				// old record has no observed CAS token; retain bytes and require reconciliation.
				await this.workspace.locks.run(async () => {
					const metadata = []
					for (const baseline of await this.state.list("cloud-heads")) if (baseline.changeSeq <= snapshot.throughSeq && !sorted.some((e) => e.path === baseline.path)) metadata.push(put("cloud-heads", pathKey(baseline.path), { ...baseline, headKnown: false, lastKnownHeadToken: baseline.lastKnownHeadToken || baseline.headToken, headToken: null, checkedThroughSeq: snapshot.throughSeq }))
					if (metadata.length) await this.state.transaction(metadata)
				})
				checkpoint = { afterSeq: snapshot.throughSeq }; await this.state.transaction([put("cloud-sync", "checkpoint", checkpoint), remove("cloud-sync", "snapshot")])
			} catch (e) { if (e.status === 410) await this.state.delete("cloud-sync", "snapshot"); throw e }
		}
		let cursor = null, throughSeq = null, previous = checkpoint.afterSeq
		try {
			do {
				const page = await this.adapter.changesAfter(checkpoint.afterSeq, cursor)
				if (page.afterSeq !== checkpoint.afterSeq || throughSeq !== null && page.throughSeq !== throughSeq || !Number.isSafeInteger(page.throughSeq) || page.throughSeq < checkpoint.afterSeq) throw cloudError(502, "change_boundary_changed")
				throughSeq = page.throughSeq
				for (const change of page.changes) { if (change.changeSeq <= previous || change.changeSeq > throughSeq || change.entries.some((e) => e.changeSeq !== change.changeSeq)) throw cloudError(502, "unordered_changes"); await this.applyEntries(change.entries, `cloud-change:${this.workspace.identity.workspaceEpoch}:${change.changeSeq}`); previous = change.changeSeq }
				cursor = page.nextCursor
			} while (cursor)
			await this.state.put("cloud-sync", "checkpoint", { afterSeq: throughSeq })
			this.hydrated = true
		} catch (e) { if (e.status === 410 || e.error === "remote_superseded") await this.state.delete("cloud-sync", "checkpoint"); throw e }
	}
	async applyEntries(values, operationId) {
		const entries = values.map(headEntry), baselines = await Promise.all(entries.map((e) => this.workspace.remote.baseline(e.path)))
		if (entries.every((e, i) => baselines[i]?.changeSeq >= e.changeSeq && (baselines[i].changeSeq > e.changeSeq || baselines[i].headToken === e.headToken))) return
		// Do not split moves or silently combine an old entry with a newer locally applied half.
		if (entries.some((e, i) => baselines[i]?.changeSeq > e.changeSeq)) throw cloudError(409, "remote_superseded")
		const failed = (await this.state.list("cloud-deliveries")).find((d) => d.failureReport?.retryable === false && entries.some((e) => e.fileVersionId === d.claim.source.fileVersionId))
		if (failed) throw cloudError(422, "delivery_validation_failed")
		let body = null
		if (entries.length === 1 && entries[0].kind === "file") {
			const source = await this.adapter.source(entries[0].fileVersionId)
			if (source.sizeBytes !== entries[0].sizeBytes || source.sha256 !== entries[0].sha256) throw cloudError(409, "source_substitution")
			body = await this.adapter.download(source)
		}
		try {
			await this.workspace.applyRemote({ operationId, path: entries[0].path, remoteEtag: entries[0].headToken, entries, processingPolicy: "skip" }, body)
			await this.state.delete("cloud-pending", pathKey(entries[0].path))
		} catch (error) {
			if (["source_changed", "waiting_local_writer"].includes(error.error)) await this.state.put("cloud-pending", pathKey(entries[0].path), { operationId, entries, error: error.error })
			throw error
		}
	}
	async pushLocal() {
		if (!this.adapter.upload) return
		const operations = (await this.state.list("operations")).sort((a, b) => (a.committedAt || a.acceptedAt).localeCompare(b.committedAt || b.acceptedAt))
		const blocked = new Set(), overlaps = (name) => [...blocked].some((other) => name === other || name.startsWith(`${other}/`) || other.startsWith(`${name}/`))
		for (const op of operations) {
			if (this.draining) return
			if (op.state !== "committed" || op.action === "apply-remote" || op.persistence?.state === "clean") continue
			if (op.cloudConflict || op.addresses.some((ref) => overlaps(ref.path))) { for (const ref of op.addresses) blocked.add(ref.path); continue }
			try {
			if (op.action === "upload") {
				const head = await this.workspace.remote.baseline(op.intent.path)
				if (head?.headKnown === false) throw cloudError(409, "cloud_head_unknown")
				if (op.cloudBaseHead === undefined) { op.cloudBaseHead = op.cloudBaseHeads && Object.hasOwn(op.cloudBaseHeads, op.intent.path) ? op.cloudBaseHeads[op.intent.path] : head?.headToken || null; await this.state.put("operations", op.operationId, op) }
				const transfer = await this.workspace.persistence.captureForTransfer(op.addresses[0], op.localGeneration), source = await this.workspace.captures.open("capture", transfer.source.captureId)
				try {
					const result = await this.adapter.upload(op, source)
					if (result?.status !== "ready") { const error = cloudError(result?.status === "conflict" ? 409 : 503, "cloud_write_unconfirmed"); error.currentHead = result?.currentHead || null; throw error }
					if (result.sha256 !== source.source.digest.sha256 || result.sizeBytes !== source.source.sizeBytes) throw cloudError(502, "cloud_write_integrity")
					await this.workspace.persistence.recordAcknowledgement({ ref: op.addresses[0], localGeneration: op.localGeneration, holdId: transfer.holdId, remoteEtag: result.headToken, remoteIntegrity: "digest-verified", sha256: result.sha256, sizeBytes: result.sizeBytes, cloudHead: headEntry({ ...result, kind: "file" }) })
				} finally { await source.release() }
			} else if (["mkdir", "move", "delete"].includes(op.action)) {
				let intent = op.cloudWriteIntent
				if (!intent) {
					const name = op.intent.path || op.intent.from, head = await this.workspace.remote.baseline(name), to = op.action === "move" ? await this.workspace.remote.baseline(op.intent.to) : null
					if (head?.headKnown === false || to?.headKnown === false) throw cloudError(409, "cloud_head_unknown")
					intent = { operationId: op.operationId, kind: op.action, path: name, expectedHead: op.cloudBaseHeads && Object.hasOwn(op.cloudBaseHeads, name) ? op.cloudBaseHeads[name] : head?.headToken || null, ...(op.action === "move" ? { toPath: op.intent.to, expectedDestination: op.cloudBaseHeads && Object.hasOwn(op.cloudBaseHeads, op.intent.to) ? op.cloudBaseHeads[op.intent.to] : to?.headToken || null } : {}) }
					await this.state.put("operations", op.operationId, { ...op, cloudWriteIntent: intent })
				}
				const result = (await this.adapter.mutations([intent])).results?.[0]
				if (result?.status !== "ready") throw cloudError(result?.status === "conflict" ? 409 : 503, "cloud_mutation_unconfirmed")
				await this.workspace.locks.run(async () => {
					const metadata = [], latest = await this.state.get("operations", op.operationId)
					for (const value of result.entries) {
						const e = headEntry(value), current = await this.workspace.remote.baseline(e.path)
						if (current?.changeSeq > e.changeSeq) continue
						const local = await this.workspace.remote.local(e.path)
						metadata.push(put("cloud-heads", pathKey(e.path), { ...e, headKnown: true, localGeneration: op.localGeneration, observation: local.generation === op.localGeneration ? local.observation?.token || null : null }))
					}
					await this.state.transaction([put("operations", op.operationId, { ...latest, cloudWriteIntent: intent, persistence: { ...latest.persistence, state: "clean" } }), ...metadata])
				})
			}
			} catch (error) {
				for (const ref of op.addresses) blocked.add(ref.path)
				if (error.status === 409) await this.workspace.locks.run(async () => {
					const latest = await this.state.get("operations", op.operationId)
					if (latest?.persistence.state === "clean") return
					await this.state.put("operations", op.operationId, { ...latest, cloudConflict: { error: error.error, currentHead: error.currentHead ? headEntry(error.currentHead) : null }, persistence: { ...latest.persistence, state: error.error === "cloud_head_unknown" ? "recovery-blocked" : "blocked-path" } })
				})
				this.lastError = { status: error.status || 503, error: error.error || "cloud_write_unconfirmed" }
			}
		}
	}
	async drain(deadline) {
		this.draining = true; clearTimeout(this.timer); clearTimeout(this.observationTimer)
		for (const controller of this.controllers) controller.abort()
		let timer; try { await Promise.race([Promise.all([this.running, this.reporting, this.reconciling]), new Promise((resolve) => { timer = setTimeout(resolve, Math.max(0, Date.parse(deadline) - Date.now())) })]) } finally { clearTimeout(timer) }
		const deliveries = await this.state.list("cloud-deliveries"), receipts = await this.state.list("cloud-imports"), operations = await this.state.list("operations"), holds = await this.state.list("holds"), jobs = await this.state.list("processing-jobs"), history = await this.state.list("cloud-import-history")
		const accounting = { claimsPending: 0, waitingOwner: 0, failuresAwaitingAcknowledgement: 0, acknowledgementsPending: 0, capacityWaiting: 0, publicationPermitsUnsettled: 0, processingPermitsUnsettled: 0, historicalPermitsUnsettled: 0, unconfirmedAdmissions: 0, indeterminateOperations: 0, heldSources: 0 }
		const obligations = []
		for (const workId of new Set([...deliveries.map((d) => d.claim.workId), ...receipts.map((r) => r.workId), ...operations.filter((o) => o.claim).map((o) => o.claim.workId)])) {
			const delivery = deliveries.find((d) => d.claim.workId === workId), record = receipts.find((r) => r.workId === workId), op = operations.find((o) => o.operationId === (record?.receipt.operationId || delivery?.claim.operationId)), processing = record?.processingReceipt || op?.processingAdmission || { state: "pending" }
			const claim = record?.claim || delivery?.claim || op.claim, job = jobs.find((j) => j.runtimeJobId === processing.ticketId || j.runtimeJobId === op?.processingAdmission?.jobId)
			const source = record?.source || op?.publishedSource, held = holds.filter((h) => h.source?.id === source?.captureId)
			const pub = record?.publicationPermit || op?.publicationPermit, proc = record?.processingPermit || op?.processingPermit
			const historical = processing.state === "historical" && claim.processingPermit && !sameOwner(claim.processingPermit, claim) && ["granted", "reconciliation-pending"].includes(claim.processingPermit.state)
			const counts = { claimsPending: delivery?.state === "pending", waitingOwner: delivery?.state === "wait-owner" || record?.ownerRecovery === "wait-owner", failuresAwaitingAcknowledgement: delivery?.state === "failure-reporting", acknowledgementsPending: Boolean(record && (record.reconcileRequired || record.ackedRevision < record.receiptRevision)), capacityWaiting: processing.state === "awaiting-capacity", publicationPermitsUnsettled: Boolean(pub && !record?.publicationSettled), processingPermitsUnsettled: Boolean(proc && !record?.processingSettled), historicalPermitsUnsettled: Boolean(historical), unconfirmedAdmissions: Boolean(op?.publicationPermitIntent && !pub || op?.processingPermitIntent && !proc && processing.state !== "historical"), indeterminateOperations: op?.state === "indeterminate" || op?.state === "publishing", heldSources: held.length > 0 }
			for (const [key, yes] of Object.entries(counts)) if (yes) accounting[key]++
			if (Object.entries(counts).some(([key, yes]) => key !== "heldSources" && yes)) obligations.push({ workId, operationId: op?.operationId || claim.operationId, owner: { runtimeId: claim.runtimeId, workspaceId: claim.workspaceId, workspaceEpoch: claim.workspaceEpoch }, stage: delivery?.stage || null, deliveryState: delivery?.state || null, receiptRevision: record?.receiptRevision || null, ackedRevision: record?.ackedRevision || 0, publicationPermit: pub ? { ...pub, state: record?.publicationSettled ? "completed" : "unsettled" } : null, processingPermit: proc ? { ...proc, state: record?.processingSettled ? "settled" : "unsettled" } : null, processing: { state: processing.state, ticketId: job?.runtimeJobId || null, processorJobId: job?.processorJobId || null, processorState: job?.processorState || null, outcome: processing.outcome || job?.outcome || null, ...(processing.state === "historical" ? { previousOwner: processing.previousOwner, previousProcessingReceipt: processing.previousProcessingReceipt } : {}) }, sourceHold: { state: held.length ? "retained" : source ? "released" : "not-captured", captureId: source?.captureId || null, holdIds: held.map((h) => h.holdId) }, localState: op?.state || null })
		}
		const referenced = new Set(obligations.filter((o) => o.processing.state === "historical").map((o) => o.processing.previousProcessingReceipt?.processingPermitId))
		const historicalObligations = history.filter((r) => r.processingPermit && !r.processingSettled && !referenced.has(r.processingPermit.permitId)).map((r) => ({ workId: r.workId, operationId: r.receipt.operationId, owner: { runtimeId: r.claim.runtimeId, workspaceId: r.claim.workspaceId, workspaceEpoch: r.claim.workspaceEpoch }, processingPermit: r.processingPermit, processingReceipt: r.processingReceipt, outcome: "owner-lost", providerSettlement: "unconfirmed" }))
		accounting.historicalPermitsUnsettled += historicalObligations.length
		const localPending = Number(Boolean(this.running)) + Number(Boolean(this.reporting)) + Number(Boolean(this.reconciling))
		return { ...this.workspace.identity, admittingImports: false, checkedAt: now(), accounting, obligations, historicalObligations, localPending, remotePending: obligations.length + historicalObligations.length, complete: !localPending && !obligations.length && !historicalObligations.length }
	}
	async close() { this.closed = true; this.draining = true; clearTimeout(this.timer); clearTimeout(this.observationTimer); for (const c of this.controllers) c.abort(); await Promise.all([this.running, this.reporting, this.reconciling]) }
}
