import crypto from "node:crypto"
import { constants, fchmod } from "node:fs"
import fs from "node:fs/promises"
import path from "node:path"
import { promisify } from "node:util"
import { FileCaptures } from "./file-captures.js"
import { FILE_LIMITS, SEGMENT_PROVIDER_LIMIT_NAMES, FileError, budget, canonicalPath, fileError, identifier, noPersistence, objectIdentity, observation, observationToken, sameObject, stableStringify } from "./file-contract.js"
import { FileEvents } from "./file-events.js"
import { FileIndex } from "./file-index.js"
import { FileSearch } from "./file-search.js"
import { SEGMENT_PARSER, utf8Prefix } from "./file-segments-worker.js"
import { FileState } from "./file-state.js"
import { FileWorkbooks } from "./file-workbooks.js"
import { FileGis } from "./file-gis.js"
import { FileMapViews } from "./file-map-views.js"
import { parseTags, strongIfMatch, weakIfNoneMatch } from "./files.js"
import { SafeFs } from "./safe-fs/index.js"
import { WorkspacePersistencePort } from "./workspace-persistence-port.js"
import { VoxelService } from "./voxels.js"
import { RemotePublication } from "./remote-publication.js"
import { CloudImportWorker } from "./cloud-import-worker.js"
import { BackendFileAdapter } from "./backend-file-adapter.js"
import { cloudPath, pathKey } from "./cloud-file-contract.js"
import { OwnedDemo } from "./owned-demo.js"
import { LifecycleAdmission } from "./lifecycle-admission.js"
import { InternalAdmission } from "./internal-admission.js"

const chmod = promisify(fchmod)
const terminal = new Set(["committed", "failed", "aborted-before-publication"])
const uncertain = (operation, message) => new FileError(503, "operation_indeterminate", message, { operationId: operation.operationId, state: "indeterminate", inspectionRef: `operations/${operation.operationId}`, action: "Inspect the retained operation and candidate before submitting a new operation with current preconditions." })
const time = () => new Date().toISOString()
const put = (kind, id, value) => ({ type: "put", kind, id, value })
const absent = (error) => error?.code === "ENOENT" || error?.error === "not_found"
const tokenOf = (value) => typeof value === "string" ? value : value?.token
const uuidName = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i
const publicationCapability = Symbol("voxel-publication"), parentCapability = Symbol("upload-parent")
const trusted = (capability) => capability === publicationCapability || capability === parentCapability
function claimIdentifier(id, action, capability) {
	identifier(id)
	if (id.startsWith("voxel-publish-") && !(capability === publicationCapability && action === "upload") || id.startsWith("upload-parents:") && !(capability === parentCapability && action === "mkdir")) throw new FileError(400, "reserved_operation_id", "This operation ID prefix is reserved for internal file publication.")
}
function producerBinding(input, identity, name) {
	const binding = input.producerBinding, keys = ["workspaceEpoch", "voxelOperationId", "artifactId", "manifestPath", "expectedSize", "expectedSha256"]
	if (!binding || typeof binding !== "object" || Array.isArray(binding) || Object.keys(binding).some((key) => !keys.includes(key)) || binding.workspaceEpoch !== identity.workspaceEpoch || binding.manifestPath !== name || binding.expectedSize !== input.declaredSize || binding.expectedSha256 !== input.declaredDigest || !Number.isSafeInteger(binding.expectedSize) || binding.expectedSize < 0 || !/^[0-9a-f]{64}$/.test(binding.expectedSha256 || "") || typeof binding.voxelOperationId !== "string" || typeof binding.artifactId !== "string") throw new FileError(400, "invalid_producer_binding", "Voxel publication must bind epoch, producer, artifact, manifest path and exact declared bytes.")
	identifier(binding.voxelOperationId); identifier(binding.artifactId); return Object.fromEntries(keys.map((key) => [key, binding[key]]))
}

/** Ordinary workspace bytes with one authority for safe effects, protected evidence and receipts. */
export class WorkspaceFiles {
	#mutationAdmission
	#mutationPermits = new WeakMap()
	#nativeAdmission
	static async open(config, logger = console) {
		const workspace = new WorkspaceFiles(config, logger)
		try { await workspace.init(); return workspace } catch (error) { await workspace.close().catch(() => {}); throw fileError(error, "workspace-files.open") }
	}
	constructor(config, logger) {
		this.config = config; this.logger = logger; this.limits = { ...FILE_LIMITS, ...config.filesLimits }
		this.workspaceDir = path.resolve(config.workspaceDir)
		this.storeDir = path.resolve(config.filesStateDir || path.join(config.gatewayStateDir || path.join(path.dirname(this.workspaceDir), ".runtime"), "file-service"))
		this.pending = new Set(); this.admissions = 0; this.draining = false
		this.startup = config.startupController || new LifecycleAdmission()
		this.startup.attach(this)
		this.#mutationAdmission = new InternalAdmission({ resource: "mutation", available: () => this.admissions < this.limits.queueSize, waiters: () => this.voxels?.limits.workers ?? this.config.voxelLimits?.workers ?? 1, reserve: () => { this.admissions++; return () => { this.admissions-- } } })
		this.#nativeAdmission = new InternalAdmission({ resource: "workbook", available: () => !this.nativeActive, waiters: () => this.voxels?.limits.workers ?? this.config.voxelLimits?.workers ?? 1, reserve: () => { this.nativeActive = true; return () => { this.nativeActive = false } } })
	}
	async init() {
		this.startup.assertOpen()
		if (this.storeDir === this.workspaceDir || this.storeDir.startsWith(`${this.workspaceDir}/`)) throw new FileError(503, "storage_unavailable", "Private file state must be outside the user workspace.")
		for (const [key, value] of Object.entries(this.limits)) if (!Number.isSafeInteger(value) || value < 1) throw new FileError(400, "invalid_budget", `${key} must be a positive safe integer.`)
		await fs.mkdir(this.storeDir, { recursive: true, mode: 0o700 })
		this.state = await FileState.open({ dir: this.storeDir }); this.identity = this.state.identity
		if (this.config.ownedDemo?.enabled) { this.demo = await OwnedDemo.open(this, this.config.ownedDemo); await this.demo.initializeFiles() }
		this.startup.assertOpen()
		this.safeFs = await SafeFs.open(this.workspaceDir, { protectedRoots: ["datasets", ...(this.config.filesProtectedRoots || [])], scanLimit: this.config.filesSubtreeEntries || this.limits.subtreeEntries })
		this.locks = { run: (work) => this.safeFs.withLock(work) }
		this.events = new FileEvents({ identity: this.identity, limits: this.limits })
		this.ownership = { agentUids: this.config.filesAgentUids || [process.geteuid()], workerUids: this.config.filesWorkerUids || [process.geteuid()], workerBridge: this.config.filesWorkerBridge }
		this.captures = new FileCaptures({ safeFs: this.safeFs, state: this.state, storeDir: path.join(this.storeDir, "sources"), limits: this.limits, ref: (name) => this.ref(name), ownership: this.ownership, onEvent: (type, payload) => this.events.publish(type, payload) })
		await this.captures.init()
		this.workbooks = new FileWorkbooks(this)
		await this.workbooks.init()
		this.gis = new FileGis(this)
		await this.gis.init()
		this.maps = new FileMapViews(this)
		this.trashAvailable = false
		if (this.captures.availability.state === "available") {
			// The source-store ownership check also pins each already verified private-state ancestor.
			this.storeHandle = this.captures.ownershipCheck.ancestorHandles.find((handle) => handle.path === this.storeDir)
			if (!this.storeHandle) throw new FileError(503, "storage_unavailable", "No verified private-state directory capability is available.")
			await fs.mkdir(path.join(this.storeDir, "staging"), { mode: 0o700 }).catch((error) => { if (error.code !== "EEXIST") throw error })
			await fs.mkdir(path.join(this.storeDir, "trash"), { mode: 0o700 }).catch((error) => { if (error.code !== "EEXIST") throw error })
			this.stagingHandle = await this.privateDirectory("staging")
			this.trashHandle = await this.privateDirectory("trash")
			await this.probeTrash()
		}
		this.lastCommitMs = (await this.state.list("operations")).reduce((latest, op) => Math.max(latest, Date.parse(op.committedAt) || 0), 0)
		// Load the configured coordinator lazily so tests can inject the same narrow boundary.
		const processingConfig = this.config.preprocessing || {}
		if (this.config.processingFactory) this.processing = await this.config.processingFactory(this, processingConfig, this.logger)
		else {
			const { DocumentProcessing } = await import("./document-processing.js")
			this.processing = new DocumentProcessing(this, processingConfig, this.logger)
		}
		await this.processing.init()
		this.remote = new RemotePublication(this)
		await this.recoverOperations()
		await this.remote.recover()
		await this.processing.reconcileOperations()
		this.voxels = new VoxelService(this)
		await this.voxels.init()
		if (this.captures.availability.state === "available") {
			for (const op of await this.state.list("operations")) await this.cleanupStaging(op)
		}
		const adapter = this.config.persistenceAdapter || (this.config.cloudImport?.enabled ? new BackendFileAdapter({ port: this.config.cloudImport.gatewayPort, secret: this.config.controlSecret }) : null)
		this.persistence = new WorkspacePersistencePort(this, { adapter, writerRegistry: this.config.writerRegistry })
		this.index = new FileIndex({ safeFs: this.safeFs, state: this.state, limits: this.limits, ref: (name) => this.ref(name), onEvent: (type, payload) => this.events.publish(type, payload) })
		await this.index.init()
		await this.demo?.filesIndexed()
		this.startup.assertOpen()
		if (adapter?.aligned) { this.imports = new CloudImportWorker(this, adapter, this.config.cloudImport); this.imports.start() }
		this.searcher = new FileSearch({ safeFs: this.safeFs, index: this.index, limits: this.limits, rgBin: this.config.rgBin || "rg" })
		this.sweepTimer = setInterval(() => this.sweep().catch((error) => this.logger.error?.("file retention failed", fileError(error, "workspace-files.sweep").toJSON())), Math.min(this.limits.scanIntervalMs, 60000))
		this.sweepTimer.unref?.()
		this.demo?.start()
	}
	ref(name) { return { ...this.identity, path: canonicalPath(name) } }
	acquireNative() {
		if (this.draining || this.closed) throw new FileError(503, "draining", "Native admission is draining.")
		return this.#nativeAdmission.tryAcquire()
	}
	acquireAcceptedNative(wait) { return this.#nativeAdmission.acquire(wait) }
	async privateDirectory(name) {
		const handle = await this.safeFs.openAt(this.storeHandle, name, { directory: true })
		try {
			const stat = await handle.stat({ bigint: true }), acl = await handle.acl()
			if (Number(stat.uid) !== process.geteuid() || (Number(stat.mode) & 0o7777) !== 0o700 || acl.access || acl.default) throw new FileError(503, "storage_unavailable", "A private staging/trash directory has unsafe ownership, permissions, or ACLs.")
			return handle
		} catch (error) { await handle.close(); throw error }
	}
	async probeTrash() {
		if (this.config.filesTrashAvailable === false) return
		const parent = await this.safeFs.open("", { directory: true }), name = `.gc-file-${crypto.randomUUID()}`, destination = crypto.randomUUID()
		let stage, moved = false
		try {
			stage = await this.safeFs.create(parent, name, 0o600); await stage.sync()
			await this.safeFs.rename(parent, name, this.trashHandle, destination); moved = true
			await parent.sync(); await this.trashHandle.sync(); this.trashAvailable = true
		} catch (error) {
			if (!["EXDEV", "ENOSYS", "EOPNOTSUPP", "EINVAL"].includes(error.code)) throw error
			this.trashReason = error.code
		} finally {
			await stage?.close()
			if (moved) await this.safeFs.unlink(this.trashHandle, destination)
			else { try { await this.safeFs.unlink(parent, name) } catch (error) { if (!absent(error)) throw error } }
			await parent.close()
		}
	}
	async info({ privateBootstrap = false } = {}) {
		const protectedBytes = this.captures.availability.state === "available", parser = protectedBytes && this.captures.parser.availability.state === "available"
		const workbook = protectedBytes && this.workbooks?.availability.state === "available"
		const gis = protectedBytes && this.gis?.availability.state === "available"
		const providerReadiness = protectedBytes ? this.captures.parser.availability : this.captures.availability
		const providerLimits = Object.fromEntries(SEGMENT_PROVIDER_LIMIT_NAMES.map((name) => [name, this.limits[name]]))
		return {
			...(privateBootstrap && this.demo?.bootstrap() ? { initialPreparation: this.demo.bootstrap() } : {}),
			filesContractVersion: 1, relayEpochFencingVersion: 1, ...this.identity, bootId: this.events.bootId, projectId: this.config.projectId || null, cwd: this.workspaceDir, ready: !this.closed,
			binding: { state: this.config.projectBindingVerified ? "verified" : "unverified", projectId: this.config.projectId || null },
			operations: ["list", "find", "stat", "search", "raw", "text", "watch", ...(protectedBytes ? ["upload", "force-replace", "mkdir", "move", "capture", "leases", "recovery", "restore", "map-views", ...(this.trashAvailable ? ["delete"] : [])] : []), ...(parser ? ["preview", "segments"] : []), ...(workbook || gis ? ["preparations", "representations"] : []), ...(workbook ? ["workbook-query", "workbook-export"] : []), ...(gis ? ["vector-query", "raster-query", "assay-query"] : [])],
			providers: [...(parser ? ["csv", "tsv", "text"] : []), ...(workbook ? ["workbook"] : []), ...(gis ? ["vector", "raster", "assay"] : [])], captures: { ...this.captures.availability, strategies: protectedBytes ? ["service-published", ...(this.captures.provenStrategies.reflink ? ["atomic-clone"] : []), "checked-copy"] : [], checkedCopyCoherent: false },
			providerDetails: [...["csv", "tsv", "text"].map((format) => ({ id: format, build: SEGMENT_PARSER, readiness: { ...providerReadiness }, inputFormats: [format], queryOperations: format === "text" ? ["segment"] : ["segment", "header", "detail"], limits: { ...providerLimits }, queryScope: "window" })), ...(this.workbooks ? [this.workbooks.descriptor()] : []), ...(this.gis ? this.gis.descriptors() : [])],
			preview: this.captures.parser.availability, limits: { ...this.limits, subtreeEntries: this.safeFs.scanLimit }, index: this.index.info(),
			processing: await this.processing.capabilities(),
			conditionalWriteScope: "service-writers", search: this.searcher.capabilities(), trash: { available: this.trashAvailable, reason: this.trashReason || null },
			maps: this.maps.descriptor(),
			hydration: this.imports?.status() || { state: "not-configured" }, sync: this.persistence.capabilities(), persistence: this.imports ? await this.persistence.status() : noPersistence(), cloudDirectories: this.imports ? "logical-heads" : "unsupported", agentAvailability: "unresolved", retention: this.retention || { state: "initializing" },
		}
	}
	async stat(name) {
		const value = await this.index.stat(canonicalPath(name))
		const records = (await this.state.list("operations")).filter((op) => op.state === "committed" && op.addresses?.some((ref) => ref.path === name)).sort((a, b) => a.committedAt.localeCompare(b.committedAt))
		const live = value.type === "file" && value.availability === "local", capture = live && this.captures.availability.state === "available"
		const workbookFormat = path.posix.extname(value.path).slice(1).toLowerCase(), workbook = capture && this.workbooks?.availability.state === "available" && ["xls", "xlsx"].includes(workbookFormat) && Number.isSafeInteger(value.sizeBytes) && value.sizeBytes >= 0 && value.sizeBytes <= this.workbooks.limits.workbookInputBytes
		return { ...value, persistence: records.at(-1)?.persistence || value.persistence, byteAvailability: live ? "live" : "unsupported", previewCapabilities: { formats: [...(capture && this.captures.parser.availability.state === "available" ? ["csv", "tsv", "text"] : []), ...(workbook ? [workbookFormat] : []), ...(capture && this.gis ? this.gis.eligible(value.path, value.sizeBytes) : [])], capture } }
	}
	list(options) { return this.index.list(options) }
	find(options) { return this.index.find(options) }
	tree(options) { return this.index.tree(options) }
	search(options, signal) { return this.searcher.search(options, { signal }) }
	async openLive(name) {
		name = canonicalPath(name, { root: false })
		const handle = await this.safeFs.open(name)
		try { const stat = await handle.stat({ bigint: true }); return { handle, stat, observation: observation(this.ref(name), stat) } } catch (error) { await handle.close(); throw error }
	}
	async text(name, { maxBytes } = {}) {
		const limit = budget(maxBytes, this.limits.liveTextBytes, this.limits.liveTextMaxBytes, "maxBytes"), opened = await this.openLive(name)
		try {
			const bytes = await this.captures.readPrefix(opened.handle, Math.min(limit, Number(opened.stat.size)))
			const current = await opened.handle.stat({ bigint: true })
			let pathStat
			try { pathStat = await this.safeFs.stat(name) } catch (error) { if (!absent(error)) throw error }
			const stable = Boolean(pathStat && observationToken(current) === opened.observation.token && observationToken(pathStat) === opened.observation.token)
			let decoded
			try { decoded = utf8Prefix(bytes, bytes.length === Number(opened.stat.size)) } catch (error) { throw new FileError(415, "encoding_unavailable", error.message) }
			const complete = decoded.byteEnd === Number(opened.stat.size) && stable
			return { ref: this.ref(name), path: name, text: decoded.text, sizeBytes: Number(opened.stat.size), byteStart: 0, byteEnd: decoded.byteEnd, encoding: "utf-8", complete, stable, truncated: !complete, observation: opened.observation, binary: /[\u0000-\u0008\u000b\u000c\u000e-\u001f]/u.test(decoded.text), coverage: complete ? "complete-live" : "prefix" }
		} finally { await opened.handle.close() }
	}
	requireMutation(capability) {
		if (!trusted(capability) && (this.draining || this.closed)) throw new FileError(503, "draining", "The workspace is draining accepted work.")
		this.captures.requireAvailable()
	}
	track(work) { this.pending.add(work); work.finally(() => this.pending.delete(work)).catch(() => {}); return work }
	async accept(operationId, action, intent, addresses, capability, wait) {
		claimIdentifier(operationId, action, capability)
		const claimSlot = async (release) => {
			let result
			try {
				const cloudBaseHeads = this.persistence?.adapter?.aligned ? Object.fromEntries(await Promise.all(addresses.map(async (ref) => [ref.path, (await this.state.get("cloud-heads", pathKey(ref.path)))?.headToken || null]))) : null
				result = await this.state.claim("operations", operationId, intent, { operationId, action, intent, state: "accepted", addresses, directoryBefore: this.remote ? await this.remote.captureDirectories(addresses.map((a) => a.path)) : {}, publishedSource: null, publishedObservation: null, acceptedAt: time(), committedAt: null, persistence: noPersistence(), ...(cloudBaseHeads ? { cloudBaseHeads } : {}), reconciliation: { required: false, inspectionRef: null, replayAllowed: false } })
				if (result.duplicate) release(); else { this.#mutationPermits.set(result.record, release); await this.checkpoint("accepted", result.record) }; return result
			} catch (error) { if (result) this.#mutationPermits.delete(result.record); release(); throw error }
		}
		let unlock, admission; const unlocked = new Promise((resolve) => { unlock = resolve })
		try { admission = await this.locks.run(async () => {
			const existing = await this.state.get("operations", operationId)
			if (existing) return { result: await this.state.claim("operations", operationId, intent, existing) }
			this.requireMutation(capability)
			let release
			try { release = this.#mutationAdmission.tryAcquire(capability === publicationCapability ? { deadline: wait?.deadline } : undefined) }
			catch (error) {
				if (capability !== publicationCapability || error.error !== "capacity") throw error
				const waiting = this.#mutationAdmission.acquire({ ...wait, onWait: async (info) => { await unlocked; return wait?.onWait?.(info) } }); waiting.catch(() => {}); return { waiting }
			}
			return { result: await claimSlot(release) }
		}) } finally { unlock() }
		if (admission.result) return admission.result
		const release = await admission.waiting
		try { return await this.locks.run(async () => { this.requireMutation(capability); return claimSlot(release) }) } catch (error) { release(); throw error }
	}
	#releaseMutation(op) { const release = this.#mutationPermits.get(op); this.#mutationPermits.delete(op); release?.() }
	get mutationWaiting() { return this.#mutationAdmission.waiting }
	answerDuplicate(record) { return { status: terminal.has(record.state) ? 200 : 202, operation: record, duplicate: true } }
	async saveOperation(op, state, extra = {}) { Object.assign(op, extra, { state }); await this.state.put("operations", op.operationId, op); await this.checkpoint(state, op); return op }
	async checkpoint(stage, op) { if (this.config.filesCheckpoint) await this.config.filesCheckpoint(stage, structuredClone(op)) }
	async checkBase(name, base, { exists = true } = {}) {
		let stat
		try { stat = await this.safeFs.stat(name) } catch (error) { if (!absent(error)) throw error }
		if (exists && (!stat || !tokenOf(base))) throw new FileError(409, "source_changed", "The mutation requires a current baseObservation.", { currentObservation: stat ? observation(this.ref(name), stat) : null })
		if (base?.ref && stableStringify(base.ref) !== stableStringify(this.ref(name))) throw new FileError(400, "invalid_observation", "The observation belongs to a different workspace address.")
		if (base && (!stat || tokenOf(base) !== observationToken(stat))) throw new FileError(409, "source_changed", "The source changed since it was observed.", { currentObservation: stat ? observation(this.ref(name), stat) : null })
		return stat
	}
	checkHttp(stat, ifMatch, ifNoneMatch) {
		const tag = stat ? `W/"${observationToken(stat)}"` : null, match = parseTags(ifMatch), none = parseTags(ifNoneMatch)
		if (match && (!stat || !strongIfMatch(match, tag))) throw new FileError(412, "precondition_failed", "If-Match does not strongly match the mutable workspace observation.")
		if (none && stat && weakIfNoneMatch(none, tag)) throw new FileError(412, "precondition_failed", "If-None-Match matches the existing resource.")
	}
	async committed(op, extra = {}) {
		const { metadata = [], ...receipt } = extra
		this.lastCommitMs = Math.max(Date.now(), this.lastCommitMs + 1)
		const committed = { ...op, ...receipt, state: "committed", committedAt: new Date(this.lastCommitMs).toISOString(), localGeneration: op.localGeneration || crypto.randomUUID(), reconciliation: { required: false, inspectionRef: null, replayAllowed: false } }
		if (op.action === "upload") committed.sourceRetention = { receiptExpiresAt: new Date(this.lastCommitMs + this.limits.receiptMs).toISOString(), availabilityUrl: `/files/captures/${op.publishedSource.captureId}` }
		committed.persistence = { ...noPersistence(), ...op.persistence, localGeneration: committed.localGeneration }
		const change = { ...committed, id: crypto.randomUUID(), cursor: committed.committedAt }
		await this.locks.run(async () => {
			const directories = this.remote ? await this.remote.directoryMetadata(op.directoryBefore, op.addresses.map((a) => a.path)) : []
			await this.state.transaction([put("operations", op.operationId, committed), put("local-changes", change.id, change), ...metadata, ...directories])
		})
		Object.assign(op, committed)
		if (op.action === "upload") await this.processing?.uploadCommitted?.(committed)
		await this.checkpoint("receipt", op)
		this.events.publish("invalidation", { changes: op.action === "move" ? [{ type: "move", from: op.intent.from, path: op.intent.to }] : op.addresses.map((address) => ({ type: op.action === "delete" ? "unlink" : "change", path: address.path })), indexGeneration: this.index?.generation || null })
		if (this.index) this.index.refreshSoon(op.addresses.map((address) => address.path))
		return op
	}
	async failed(op, error) {
		const mapped = fileError(error, `workspace-files.${op.action}`)
		if (op.action === "upload" && op.effectApplied && op.state !== "committed") {
			// SQLite may have committed even when its acknowledgement was lost. Preserve
			// that receipt and its ticket/hold rather than creating a second journal entry.
			const stored = await this.state.get("operations", op.operationId)
			if (stored?.state === "committed") Object.assign(op, stored)
		}
		if (op.state === "committed") throw uncertain(op, "The publication completed but its response could not be confirmed.")
		const uncertainEffect = op.effectApplied || (op.state === "publishing" && !["EEXIST", "ENOENT", "EINVAL", "EXDEV", "EACCES", "EPERM", "ELOOP", "ENOTDIR", "ENOTEMPTY", "ENOSYS", "EOPNOTSUPP", "ESTALE", "E2BIG"].includes(error.code) && !["exists", "source_changed", "protected_resource"].includes(mapped.error))
		if (uncertainEffect) {
			await this.saveOperation(op, "indeterminate", { error: mapped.toJSON(), reconciliation: { required: true, inspectionRef: `operations/${op.operationId}`, replayAllowed: false } })
			throw uncertain(op, "Publication or its address association could not be confirmed; retained evidence requires inspection.")
		}
		const details = { ...mapped.toJSON(), operationId: op.operationId, ...(op.parentOperationId ? { parentOperationId: op.parentOperationId } : {}) }
		await this.saveOperation(op, op.state === "publishing" ? "aborted-before-publication" : "failed", { finishedAt: time(), error: details })
		if (op.action === "upload") await this.processing.releaseFailedUpload(op)
		throw new FileError(mapped.status, mapped.error, mapped.message, details)
	}
	upload(readable, input) { return this.track(this.uploadRequest(readable, input)) }
	uploadVoxel(readable, input) { return this.track(this.uploadRequest(readable, input, publicationCapability)) }
	async uploadRequest(readable, input, capability) {
		claimIdentifier(input.operationId, "upload", capability)
		const name = canonicalPath(input.path, { root: false }), mode = input.mode || "create"
		const internal = capability === publicationCapability
		if (internal && (!input.operationId.startsWith("voxel-publish-") || mode !== "create" || path.posix.dirname(name) !== "." || input.processingPolicy != null && input.processingPolicy !== "skip")) throw new FileError(400, "invalid_producer_binding", "Voxel manifests require reserved create-only root publication with processing disabled.")
		const processingPolicy = input.processingPolicy ?? null
		if (processingPolicy !== null && !["auto", "skip"].includes(processingPolicy)) throw new FileError(400, "invalid_processing_policy", "Choose processingPolicy auto or skip for a public upload.")
		if (!["create", "replace", "force-replace"].includes(mode)) throw new FileError(400, "invalid_mode", "Choose create, replace or force-replace.")
		if (mode === "replace" && !tokenOf(input.baseObservation)) throw new FileError(400, "invalid_observation", "Conditional replacement needs baseObservation.")
		const intent = { action: "upload", path: name, mode, processingPolicy, baseObservation: tokenOf(input.baseObservation) || null, declaredSize: input.declaredSize ?? null, declaredDigest: input.declaredDigest || null, requireRemotePersistable: Boolean(input.requireRemotePersistable), ifMatch: input.ifMatch || null, ifNoneMatch: input.ifNoneMatch || null }
		if (internal) intent.producerBinding = producerBinding(input, this.identity, name)
		if (intent.declaredSize !== null && (!Number.isSafeInteger(intent.declaredSize) || intent.declaredSize < 0)) throw new FileError(400, "invalid_budget", "Declared size must be a nonnegative byte count.")
		if (intent.declaredDigest !== null && !/^[0-9a-f]{64}$/.test(intent.declaredDigest)) throw new FileError(400, "invalid_digest", "Use a lowercase SHA-256 digest.")
		const accepted = await this.accept(input.operationId, "upload", intent, [this.ref(name)], capability, internal ? input.wait : undefined)
		if (accepted.duplicate) return this.answerDuplicate(accepted.record)
		const op = accepted.record, stagingName = crypto.randomUUID(), stagingPath = path.join(this.storeDir, "staging", stagingName)
		let staged, candidate, parent, published
		try {
			this.safeFs.policy.assertWrite(name)
			if (input.requireRemotePersistable) {
				if (!this.persistence.adapter?.aligned) throw new FileError(503, "integration_unavailable", "Remote persistability cannot be checked until the backend adapter contract is configured.")
				cloudPath(name)
			}
			if (intent.declaredSize > this.limits.uploadBytes) throw new FileError(413, "transfer_limit", "The declared upload exceeds the local ceiling.", { limits: { uploadBytes: this.limits.uploadBytes } })
			staged = await fs.open(stagingPath, constants.O_RDWR | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW, 0o600)
			await this.saveOperation(op, "streaming", { stagingName })
			const hash = crypto.createHash("sha256"); let size = 0
			for await (const raw of readable) {
				const chunk = Buffer.isBuffer(raw) ? raw : Buffer.from(raw)
				if (size + chunk.length > this.limits.uploadBytes) throw new FileError(413, "transfer_limit", "The streamed upload exceeds the local ceiling.", { limits: { uploadBytes: this.limits.uploadBytes } })
				hash.update(chunk); let offset = 0
				while (offset < chunk.length) { const result = await staged.write(chunk, offset, chunk.length - offset, size + offset); if (!result.bytesWritten) throw new FileError(503, "storage_unavailable", "The staged upload made no write progress."); offset += result.bytesWritten }
				size += chunk.length
			}
			if (intent.declaredSize !== null && size !== intent.declaredSize) throw new FileError(400, "size_mismatch", "The streamed bytes do not match Content-Length.")
			const digest = hash.digest("hex")
			if (intent.declaredDigest && intent.declaredDigest !== digest) throw new FileError(422, "digest_mismatch", "The streamed bytes do not match the declared SHA-256.")
			await staged.sync(); await staged.close(); staged = null
			op.evidenceHoldId = `receipt-${crypto.createHash("sha256").update(op.operationId).digest("hex")}`
			await this.saveOperation(op, "streaming")
			published = await this.captures.retainStaged(stagingPath, this.ref(name), { consistency: "service-published", digest, hold: { reason: `receipt:${op.operationId}`, id: op.evidenceHoldId }, ...(internal ? { reservationId: input.reservationId } : {}) })
			op.publishedSource = published.source; op.evidenceHoldId = published.holdId
			// Parent creation has its own durable receipt and can outlive a failed upload.
			// Run it outside the upload lock, after validating and retaining the first body.
			await this.uploadParents(op)
			let candidateName
			await this.locks.run(async () => {
				this.safeFs.policy.assertWrite(name)
				const current = await this.checkBase(name, mode === "replace" ? input.baseObservation : null, { exists: mode === "replace" })
				this.checkHttp(current, input.ifMatch, input.ifNoneMatch)
				if (current && !current.isFile()) throw new FileError(400, "invalid_path", "Upload targets must be regular files.")
				if (mode === "create" && current) throw new FileError(409, "exists", "A create-only target already exists.")
				parent = await this.safeFs.parent(name)
				candidateName = `.gc-file-${crypto.randomUUID()}`
				candidate = await this.safeFs.create(parent.handle, candidateName, 0o600)
				await this.saveOperation(op, "streaming", { evidence: { path: name, candidate: objectIdentity(await candidate.stat({ bigint: true })), parent: parent.parentIdentity, candidateName, parentPath: parent.path, policyGeneration: this.safeFs.generation } })
			})
			const source = await this.captures.open("capture", published.source.captureId)
			try { await this.copy(source.handle, candidate, size) } finally { await source.release() }
			await candidate.sync()
			const candidateStat = await candidate.stat({ bigint: true }), object = objectIdentity(candidateStat)
			op.sizeBytes = size
			// Reserve before namespace publication, outside the mutation lock. The accepted
			// operation durably binds the decision/ID even if the receipt commit is lost.
			const processingAdmission = processingPolicy === null ? null : await this.processing.reserveUpload(op)
			await this.saveOperation(op, "staged", { processingAdmission, evidence: { ...op.evidence, sizeBytes: Number(candidateStat.size), mtimeNs: String(candidateStat.mtimeNs) } })
			let publishedObservation
			await this.locks.run(async () => {
				this.safeFs.policy.assertWrite(name)
				const commitParent = await this.safeFs.parent(name)
				try { if (!sameObject(commitParent.parentIdentity, parent.parentIdentity)) throw new FileError(409, "source_changed", "The destination parent moved during staging.") } finally { await commitParent.handle.close() }
				const atCommit = await this.checkBase(name, mode === "replace" ? input.baseObservation : null, { exists: mode === "replace" })
				this.checkHttp(atCommit, input.ifMatch, input.ifNoneMatch)
				if (atCommit && !atCommit.isFile()) throw new FileError(400, "invalid_path", "Upload targets must be regular files.")
				await chmod(candidate.fd, 0o664)
				await candidate.sync()
				await this.saveOperation(op, "publishing")
				if (input.publicationGuard) {
					// A rejected trusted guard has made no namespace effect. Record a settled
					// pre-publication failure rather than an indeterminate rename.
					try { await input.publicationGuard() } catch (error) { op.state = "staged"; throw error }
				}
				await this.safeFs.rename(parent.handle, candidateName, parent.handle, parent.name, { noReplace: mode === "create" }); op.effectApplied = true
				await parent.handle.sync()
				if (!await this.safeFs.prove(name, object, parent.parentIdentity)) throw uncertain(op, "The published object is no longer associated with the requested address.")
				await this.checkpoint("published", op)
				let currentStat
				try { currentStat = await this.safeFs.stat(name) } catch (error) { if (!absent(error)) throw error }
				// A later namespace replacement must not associate this publication with another inode.
				publishedObservation = currentStat && sameObject(currentStat, object) && currentStat.size === candidateStat.size && currentStat.mtimeNs === candidateStat.mtimeNs ? observation(this.ref(name), currentStat) : null
			})
			await this.commitUpload(op, publishedObservation)
			return { status: mode === "create" ? 201 : 200, operation: op }
		} catch (error) { return await this.failed(op, error) }
		finally {
			try {
			await staged?.close(); await candidate?.close()
			if (parent && op.state !== "indeterminate" && op.evidence?.candidateName) { try { await this.safeFs.unlink(parent.handle, op.evidence.candidateName) } catch (error) { if (!absent(error)) this.logger.error?.("candidate cleanup failed", fileError(error, "workspace-files.cleanup").toJSON()) } }
			await parent?.handle.close()
			if (op.state !== "indeterminate") await fs.unlink(stagingPath).catch((error) => { if (!absent(error)) throw error })
			} finally { this.#releaseMutation(op) }
		}
	}
	async commitUpload(op, publishedObservation, extra = {}) {
		// Never wait for retention with the namespace lock held: availability readers
		// can hold retention while observing the workspace. The receipt hold protects
		// this capture across publication and this single metadata transaction.
		return this.captures.withRetention(async () => {
			const sourceRecord = await this.captures.record("capture", op.publishedSource.captureId)
			const handle = await this.captures.privateFile(sourceRecord)
			await handle.close()
			sourceRecord.sourceObservation = publishedObservation
			const { processing, metadata = [] } = op.intent.processingPolicy == null ? { processing: null } : await this.processing.uploadMetadata(op, sourceRecord)
			return this.committed(op, { ...extra, publishedObservation, processing, metadata: [put("captures", sourceRecord.id, sourceRecord), ...metadata] })
		})
	}
	async uploadParents(op) {
		const parentPath = path.posix.dirname(op.intent.path)
		if (op.intent.mode === "replace" || parentPath === ".") return
		const parentOperationId = `upload-parents:${crypto.createHash("sha256").update(op.operationId).digest("hex")}`
		// A retained child receipt is authoritative even if its directories now exist.
		if (!await this.state.get("operations", parentOperationId)) {
			let handle
			try { handle = await this.safeFs.open(parentPath, { directory: true }); return }
			catch (error) { if (!absent(error)) throw error }
			finally { await handle?.close() }
		}
		// Persist the link before admission: restart never replays either operation.
		await this.saveOperation(op, "streaming", { parentOperationId })
		const result = await this.mkdir({ operationId: parentOperationId, path: parentPath, parents: true }, parentCapability)
		if (result.operation.state !== "committed") throw new FileError(503, "operation_indeterminate", "Destination folder creation has not committed. Inspect the linked folder operation before retrying.", { parentOperationId, parentOperationState: result.operation.state, inspectionRef: `operations/${parentOperationId}`, action: "Inspect the folder operation and retained directories before submitting a new upload operation." })
	}
	async copy(source, target, size) {
		const buffer = Buffer.alloc(Math.min(65536, Math.max(1, size))); let at = 0
		while (at < size) {
			const { bytesRead } = await source.read(buffer, 0, Math.min(buffer.length, size - at), at)
			if (!bytesRead) throw new FileError(503, "storage_unavailable", "The protected copy source was truncated.")
			let offset = 0
			while (offset < bytesRead) { const { bytesWritten } = await target.write(buffer, offset, bytesRead - offset, at + offset); if (!bytesWritten) throw new FileError(503, "storage_unavailable", "The candidate copy made no progress."); offset += bytesWritten }
			at += bytesRead
		}
	}
	mutate(input, action, intent, addresses, work, capability) {
		return this.track((async () => {
			const admitted = await this.accept(input.operationId, action, intent, addresses, capability)
			if (admitted.duplicate) return this.answerDuplicate(admitted.record)
			const op = admitted.record
			try { await this.locks.run(() => work(op)); return { status: 200, operation: op } }
			catch (error) { return await this.failed(op, error) }
			finally { this.#releaseMutation(op) }
		})())
	}
	mkdir(input, capability) {
		claimIdentifier(input.operationId, "mkdir", capability)
		const name = canonicalPath(input.path, { root: false }), parents = input.parents ?? false
		if (typeof parents !== "boolean") throw new FileError(400, "invalid_request", "parents must be boolean.")
		return this.mutate(input, "mkdir", { action: "mkdir", path: name, parents }, [this.ref(name)], async (op) => {
			const paths = parents ? name.split("/").map((_, i, parts) => parts.slice(0, i + 1).join("/")) : [name]
			op.evidence = { directories: [] }
			for (const child of paths) {
				this.safeFs.policy.assertWrite(child)
				const existing = await this.checkBase(child, null, { exists: false })
				if (existing) { if (parents && existing.isDirectory()) { this.safeFs.policy.assertIdentity(existing, "write"); continue } throw new FileError(409, "exists", "The mkdir target already exists.") }
				const parent = await this.safeFs.parent(child)
				let candidate
				try {
					const stage = await this.safeFs.stageDirectory(parent.handle), stagedName = stage.name
					candidate = stage.handle
					await chmod(candidate.fd, 0o2775); await candidate.sync()
					const evidence = { path: child, candidate: objectIdentity(await candidate.stat({ bigint: true })), parent: parent.parentIdentity, stagingName: stagedName, created: false }
					op.evidence.directories.push(evidence)
					await this.saveOperation(op, "publishing")
					try {
						await this.safeFs.rename(parent.handle, stagedName, parent.handle, parent.name, { noReplace: true }); op.effectApplied = true; evidence.created = true
					} catch (error) {
						if (error.code !== "EEXIST" || !parents) throw error
						// An external writer won. Reopen through SafeFs rather than replacing its directory.
						const raced = await this.safeFs.open(child, { directory: true })
						try {
							const stat = await raced.stat({ bigint: true })
							this.safeFs.policy.assertWrite(child); this.safeFs.policy.assertIdentity(stat, "write")
							evidence.existing = objectIdentity(stat)
							if (!await this.safeFs.prove(child, evidence.existing, evidence.parent)) throw uncertain(op, "Existing directory address proof failed.")
						} finally { await raced.close() }
						// Retain the losing candidate until protected-trash cleanup can prove its identity.
					}
					await parent.handle.sync()
					if (!await this.safeFs.prove(child, evidence.existing || evidence.candidate, evidence.parent)) throw uncertain(op, "Created directory address proof failed.")
					await this.saveOperation(op, "publishing")
					await this.checkpoint("published", op)
				} finally { await candidate?.close(); await parent.handle.close() }
			}
			await this.committed(op)
			await this.cleanupStaging(op)
		}, capability)
	}
	move(input) {
		claimIdentifier(input.operationId, "move")
		const from = canonicalPath(input.from, { root: false }), to = canonicalPath(input.to, { root: false }), replace = input.replace ?? false
		if (typeof replace !== "boolean") throw new FileError(400, "invalid_request", "replace must be boolean.")
		if (from === to || to.startsWith(`${from}/`) || from.startsWith(`${to}/`)) throw new FileError(409, "invalid_move_target", "Source and destination cannot equal or contain one another.")
		return this.mutate(input, "move", { action: "move", from, to, baseObservation: tokenOf(input.baseObservation) || null, replace, destinationObservation: tokenOf(input.destinationObservation) || null }, [this.ref(from), this.ref(to)], async (op) => {
			this.safeFs.policy.assertWrite(from, { subtree: true }); this.safeFs.policy.assertWrite(to, { subtree: true })
			const source = await this.checkBase(from, input.baseObservation)
			if (!source.isFile() && !source.isDirectory()) throw new FileError(400, "invalid_path", "Only regular files and directories can be moved.")
			const target = await this.checkBase(to, input.destinationObservation, { exists: false })
			if (target && (!replace || !input.destinationObservation)) throw new FileError(409, "exists", "Replacement requires replace:true and destinationObservation.")
			const fromParent = await this.safeFs.parent(from), toParent = await this.safeFs.parent(to)
			try {
				const evidence = { path: to, from, candidate: objectIdentity(source), parent: toParent.parentIdentity, fromParent: fromParent.parentIdentity }
				await this.saveOperation(op, "publishing", { evidence })
				await this.safeFs.rename(fromParent.handle, fromParent.name, toParent.handle, toParent.name, { noReplace: !replace }); op.effectApplied = true
				await fromParent.handle.sync(); await toParent.handle.sync()
				if (!await this.safeFs.prove(to, evidence.candidate, evidence.parent)) throw uncertain(op, "Moved object address proof failed.")
				await this.checkpoint("published", op)
				await this.committed(op, { tombstones: [{ path: from }] })
			} finally { await fromParent.handle.close(); await toParent.handle.close() }
		})
	}
	delete(input) {
		claimIdentifier(input.operationId, "delete")
		const name = canonicalPath(input.path, { root: false }), recursive = input.recursive ?? false
		if (typeof recursive !== "boolean") throw new FileError(400, "invalid_request", "recursive must be boolean.")
		return this.mutate(input, "delete", { action: "delete", path: name, baseObservation: tokenOf(input.baseObservation) || null, recursive }, [this.ref(name)], async (op) => {
			if (!this.trashAvailable) throw new FileError(409, "trash_unavailable", "This workspace cannot rename entries into protected same-filesystem trash.")
			this.safeFs.policy.assertWrite(name, { subtree: true })
			const source = await this.checkBase(name, input.baseObservation)
			if (!source.isFile() && !source.isDirectory()) throw new FileError(400, "invalid_path", "Only regular files and directories can be deleted.")
			if (source.isDirectory() && !recursive) {
				const handle = await this.safeFs.open(name, { directory: true }), directory = await fs.opendir(`/proc/self/fd/${handle.fd}`)
				try { if (await directory.read()) throw new FileError(409, "directory_not_empty", "A nonempty directory requires recursive:true.") } finally { await directory.close(); await handle.close() }
			}
			const parent = await this.safeFs.parent(name), digest = crypto.createHash("sha256").update(`${this.identity.workspaceEpoch}:${op.operationId}`).digest("hex"), trashName = `op-${digest}`
			const createdAt = time(), recovery = { id: `delete:${digest}`, kind: "deleted-entry", original: this.ref(name), entryType: source.isDirectory() ? "dir" : "file", createdAt, expiresAt: new Date(Date.parse(createdAt) + this.limits.trashMs).toISOString(), restoreAvailable: true, restoreDisposition: "consume", state: "available", deleteOperationId: op.operationId, trashName, candidate: objectIdentity(source) }
			try {
				await this.saveOperation(op, "publishing", { evidence: { path: name, candidate: objectIdentity(source), parent: parent.parentIdentity, trashName, recovery } })
				await this.safeFs.rename(parent.handle, parent.name, this.trashHandle, trashName); op.effectApplied = true
				await parent.handle.sync(); await this.trashHandle.sync()
				const trashed = await this.safeFs.openAt(this.trashHandle, trashName, { metadata: true })
				try {
					let stillThere
					try { stillThere = await this.safeFs.stat(name, { allowSymlink: true }) } catch (error) { if (!absent(error)) throw error }
					const currentParent = await this.safeFs.parent(name)
					try { if (!sameObject(await trashed.stat({ bigint: true }), source) || !sameObject(currentParent.parentIdentity, parent.parentIdentity) || (stillThere && sameObject(stillThere, source))) throw uncertain(op, "Logical delete address association failed.") } finally { await currentParent.handle.close() }
				} finally { await trashed.close() }
				await this.checkpoint("published", op)
				await this.committed(op, { tombstones: [{ path: name, recursive }], trash: { name: trashName, cleanupAfter: recovery.expiresAt, state: "retained" }, metadata: [put("recovery", recovery.id, recovery)] })
			} finally { await parent.handle.close() }
		})
	}
	async operation(id) { identifier(id); const record = await this.state.get("operations", id); if (!record) throw new FileError(404, "not_found", "No accepted operation has this identifier."); return record }
	request(id) { return this.captures.getRequest(id) }
	job(id) { return this.captures.getJob(id) }
	async cancelJob(id) { const job = await this.captures.getJob(id); return job.type === "preparation" ? job.preparationType === "workbook" ? this.workbooks.cancel(id) : this.gis.cancel(id) : this.captures.cancelJob(id) }
	async recoverOperations() {
		for (const op of await this.state.list("operations")) {
			if (op.action === "apply-remote") continue // Its prepared journal is reconciled by the remote file owner.
			if (terminal.has(op.state)) {
				if (op.action === "upload" && op.state !== "committed") await this.processing.releaseFailedUpload(op)
				continue
			}
			if (op.state === "indeterminate" && op.action !== "upload") continue
			if (["accepted", "streaming", "staged"].includes(op.state) && !op.effectApplied) {
				await this.saveOperation(op, "aborted-before-publication", { finishedAt: time(), error: { error: "interrupted", message: "The service stopped before namespace publication; submit a new operation ID to retry." } })
				if (op.action === "upload") await this.processing.releaseFailedUpload(op)
				continue
			}
			let proved = false, recovered = {}
			if (this.captures.availability.state === "available" && op.action === "mkdir" && op.evidence?.directories?.length) {
				try {
					proved = op.evidence.directories.some((entry) => entry.path === op.intent.path)
					for (const entry of op.evidence.directories) proved &&= await this.safeFs.prove(entry.path, entry.existing || entry.candidate, entry.parent)
				} catch (error) { this.logger.warn?.("mkdir recovery proof failed", { operationId: op.operationId, error: fileError(error, "workspace-files.recover").toJSON() }); proved = false }
			}
			if (this.captures.availability.state === "available" && op.action === "restore" && op.evidence?.candidate) {
				try {
					const destinationMatches = await this.safeFs.prove(op.evidence.path, op.evidence.candidate, op.evidence.parent)
					let destinationMissing = false
					if (!destinationMatches) {
						try { await this.safeFs.stat(op.evidence.path, { allowSymlink: true }) } catch (error) { if (absent(error)) destinationMissing = true; else throw error }
					}
					let retained, retainedMatches = false, retainedMissing = false
					try {
						try { retained = await this.safeFs.openAt(this.trashHandle, op.evidence.trashName, { metadata: true }) } catch (error) { if (absent(error)) retainedMissing = true; else throw error }
						if (retained) retainedMatches = sameObject(await retained.stat({ bigint: true }), op.evidence.candidate)
					} finally { await retained?.close() }
					const record = await this.state.get("recovery", op.intent.recoveryId)
					const recordMatches = record?.kind === "deleted-entry" && sameObject(record.candidate, op.evidence.candidate)
					if (destinationMatches && retainedMissing && recordMatches) {
						proved = true
						recovered = { metadata: await this.restoredMetadata(record, op) }
					} else if (destinationMissing && retainedMatches && recordMatches) {
						await this.saveOperation(op, "aborted-before-publication", { finishedAt: time(), error: { error: "interrupted", message: "The service stopped before recovery publication; submit a new operation ID to retry." } })
						continue
					}
				} catch (error) { this.logger.warn?.("restore recovery proof failed", { operationId: op.operationId, error: fileError(error, "workspace-files.recover").toJSON() }); proved = false }
			} else if (this.captures.availability.state === "available" && op.evidence?.candidate) {
				try {
					proved = await this.safeFs.prove(op.evidence.path, op.evidence.candidate, op.evidence.parent)
					if (op.action === "upload" && proved) {
						const opened = await this.captures.open("capture", op.publishedSource.captureId); await opened.release()
						let current
						try { current = await this.safeFs.stat(op.evidence.path) } catch (error) { if (!absent(error)) throw error }
						const publishedObservation = current && sameObject(current, op.evidence.candidate) && Number(current.size) === op.evidence.sizeBytes && String(current.mtimeNs) === op.evidence.mtimeNs ? observation(this.ref(op.evidence.path), current) : null
						recovered = { publishedObservation }
					}
					if (op.action === "move" && proved) { try { const old = await this.safeFs.stat(op.evidence.from); if (sameObject(old, op.evidence.candidate)) proved = false } catch (error) { if (!absent(error)) throw error } }
					if (op.action === "delete") {
						const entry = await this.safeFs.openAt(this.trashHandle, op.evidence.trashName, { metadata: true })
						try { proved = sameObject(await entry.stat({ bigint: true }), op.evidence.candidate) } finally { await entry.close() }
						const parent = await this.safeFs.parent(op.evidence.path)
						try { proved &&= sameObject(parent.parentIdentity, op.evidence.parent) } finally { await parent.handle.close() }
						if (proved) { try { if (sameObject(await this.safeFs.stat(op.evidence.path), op.evidence.candidate)) proved = false } catch (error) { if (!absent(error)) throw error } }
					}
				} catch (error) { this.logger.warn?.("operation recovery proof failed", { operationId: op.operationId, error: fileError(error, "workspace-files.recover").toJSON() }); proved = false }
			}
			if (proved && op.action === "upload") await this.commitUpload(op, recovered.publishedObservation, { recovered: true })
			else if (proved) await this.committed(op, { recovered: true, ...recovered, ...(op.action === "delete" ? { tombstones: [{ path: op.intent.path, recursive: op.intent.recursive }], trash: { name: op.evidence.trashName, cleanupAfter: op.evidence.recovery?.expiresAt || new Date(Date.now() + this.limits.trashMs).toISOString(), state: "retained" }, ...(op.evidence.recovery ? { metadata: [put("recovery", op.evidence.recovery.id, op.evidence.recovery)] } : {}) } : op.action === "move" ? { tombstones: [{ path: op.intent.from }] } : {}) })
			else await this.saveOperation(op, "indeterminate", { reconciliation: { required: true, inspectionRef: `operations/${op.operationId}`, replayAllowed: false } })
		}
	}
	async cleanupStaging(op) {
		const mkdirLosers = op.state === "committed" && op.action === "mkdir" && op.evidence?.directories?.some((entry) => entry.existing && entry.stagingName)
		if (op.cleanup?.state === "cleaned" || (!mkdirLosers && !["failed", "aborted-before-publication"].includes(op.state))) return
		const errors = []
		if (op.cleanup?.state === "indeterminate") return
		if (op.cleanup?.pendingTrash) {
			const pending = op.cleanup.pendingTrash
			let handle
			try {
				try { handle = await this.safeFs.openAt(this.trashHandle, pending.name, { metadata: true }) } catch (error) { if (!absent(error)) throw error }
				if (handle) {
					if (!sameObject(await handle.stat({ bigint: true }), pending.candidate)) throw new FileError(409, "source_changed", "Cleanup inspection storage contains another object.")
					pending.state = "removing"; await this.state.put("operations", op.operationId, op)
					await this.cleanTrash(pending.name)
				} else if (pending.state === "moving") {
					const parent = await this.safeFs.open(pending.source.parentPath, { directory: true })
					try {
						if (!sameObject(await parent.stat({ bigint: true }), pending.source.parent) || !sameObject(await this.safeFs.inspectStage(parent, pending.source.name), pending.candidate)) throw new FileError(409, "source_changed", "Cleanup publication cannot be proved or excluded.")
					} finally { await parent.close() }
				}
				delete op.cleanup.pendingTrash; await this.state.put("operations", op.operationId, op)
			} catch (error) {
				op.cleanup.state = "indeterminate"; op.cleanup.error = fileError(error, "workspace-files.cleanup-recovery").toJSON()
				await this.state.put("operations", op.operationId, op); return
			} finally { await handle?.close() }
		}
		try {
			if (op.stagingName) {
				if (!uuidName.test(op.stagingName)) throw new FileError(503, "storage_unavailable", "The recorded private staging basename is invalid.")
				let staged
				try { staged = await this.safeFs.openAt(this.stagingHandle, op.stagingName, { metadata: true }) } catch (error) { if (!absent(error)) throw error }
				if (staged) {
					try { const stat = await staged.stat({ bigint: true }); if (!stat.isFile() || stat.nlink !== 1n || Number(stat.uid) !== process.geteuid()) throw new FileError(503, "storage_unavailable", "Private staging no longer has the expected service-owned file."); await this.safeFs.unlink(this.stagingHandle, op.stagingName); await this.stagingHandle.sync() } finally { await staged.close() }
				}
			}
		} catch (error) { errors.push(fileError(error, "workspace-files.staging-cleanup").toJSON()) }
		const candidates = op.action === "upload" && op.evidence?.candidateName ? [{ ...op.evidence, name: op.evidence.candidateName }] : op.action === "mkdir" ? (op.evidence?.directories || []).filter((entry) => entry.stagingName && (!mkdirLosers || entry.existing)).map((entry) => ({ ...entry, name: entry.stagingName, parentPath: path.posix.dirname(entry.path) === "." ? "" : path.posix.dirname(entry.path) })) : []
		for (const candidate of candidates) {
			let parent
			try {
				parent = await this.safeFs.open(candidate.parentPath, { directory: true })
				if (!sameObject(await parent.stat({ bigint: true }), candidate.parent)) throw new FileError(409, "source_changed", "The staging parent moved; its candidate requires inspection.")
				let current
				try { current = await this.safeFs.inspectStage(parent, candidate.name) } catch (error) { if (!absent(error)) throw error }
				if (!current) continue
				if (!sameObject(current, candidate.candidate) || Number(current.uid) !== process.geteuid() || !(current.isFile() || current.isDirectory())) throw new FileError(409, "source_changed", "The staging name now contains another object; it is preserved.")
				if (!this.trashAvailable) throw new FileError(409, "trash_unavailable", "Temporary workspace cleanup requires same-filesystem protected inspection storage.")
				const cleanupName = `cleanup-${crypto.randomUUID()}`
				// Move to protected inspection storage first; never unlink an unproved mutable name.
				op.cleanup = { state: "pending", pendingTrash: { name: cleanupName, candidate: candidate.candidate, source: candidate, state: "moving" }, inspectionRef: `trash/${cleanupName}` }
				await this.state.put("operations", op.operationId, op)
				await this.safeFs.rename(parent, candidate.name, this.trashHandle, cleanupName)
				await parent.sync(); await this.trashHandle.sync()
				const inspected = await this.safeFs.openAt(this.trashHandle, cleanupName, { metadata: true })
				try {
					if (!sameObject(await inspected.stat({ bigint: true }), candidate.candidate)) {
						op.cleanup.state = "indeterminate"; op.cleanup.error = "A staging-name race moved another object; its bytes are preserved."
						await this.state.put("operations", op.operationId, op)
						return
					}
				} finally { await inspected.close() }
				op.cleanup.pendingTrash.state = "removing"
				await this.state.put("operations", op.operationId, op)
				await this.cleanTrash(cleanupName)
				delete op.cleanup.pendingTrash
			} catch (error) { errors.push(fileError(error, "workspace-files.candidate-cleanup").toJSON()) }
			finally { await parent?.close() }
		}
		op.cleanup = errors.length ? { ...op.cleanup, state: "blocked", errors, inspectionRef: op.cleanup?.inspectionRef || `operations/${op.operationId}` } : { state: "cleaned", cleanedAt: time() }
		await this.state.put("operations", op.operationId, op)
	}
	async sweep() {
		if (this.closed || this.draining || this.captures.availability.state !== "available") return
		const sourceSweep = await this.captures.sweep()
		await this.voxels.releaseUnreferenced()
		await this.voxels.cleanupArtifacts()
		const expiredHolds = []
		await this.locks.run(async () => {
			for (const op of await this.state.list("operations")) {
				if (!terminal.has(op.state) || op.persistence.state !== "not-configured") continue
				await this.cleanupStaging(op)
				const receiptExpiresMs = op.sourceRetention ? Date.parse(op.sourceRetention.receiptExpiresAt) : Date.parse(op.committedAt || op.finishedAt || op.acceptedAt) + this.limits.receiptMs
				if (op.evidenceHoldId && Date.now() >= receiptExpiresMs) {
					expiredHolds.push({ kind: "operations", id: op.operationId, field: "evidenceHoldId", holdId: op.evidenceHoldId })
				}
				if (!["retained", "cleanup-blocked"].includes(op.trash?.state) || Date.parse(op.trash.cleanupAfter) > Date.now() || Date.parse(op.trash.retryAfter || "1970-01-01T00:00:00Z") > Date.now()) continue
				let recovery
				try {
					this.safeFs.policy.assertWrite(op.intent.path, { subtree: true })
					await this.cleanTrash(op.trash.name)
					op.trash.state = "cleaned"; op.trash.cleanedAt = time(); delete op.trash.error; delete op.trash.retryAfter
					if (op.evidence?.recovery?.id) {
						recovery = await this.state.get("recovery", op.evidence.recovery.id)
						if (recovery) recovery = { ...recovery, state: "expired", restoreAvailable: false, expiredAt: time() }
					}
				} catch (error) { op.trash.error = fileError(error, "workspace-files.trash").toJSON(); op.trash.state = "cleanup-blocked"; op.trash.retryAfter = new Date(Date.now() + this.limits.scanIntervalMs).toISOString() }
				await this.state.transaction([put("operations", op.operationId, op), ...(recovery ? [put("recovery", recovery.id, recovery)] : [])])
			}
			for (const record of await this.state.list("recovery")) {
				if (record.holdId && Date.parse(record.expiresAt) <= Date.now()) {
					expiredHolds.push({ kind: "recovery", id: record.id, field: "holdId", holdId: record.holdId })
				}
			}
			const ops = await this.state.list("operations")
			const referenced = new Set(ops.filter((op) => !terminal.has(op.state)).map((op) => op.stagingName))
			const entries = await fs.opendir(`/proc/self/fd/${this.stagingHandle.fd}`)
			try {
				let count = 0
				for await (const entry of entries) {
					if (++count > this.limits.subtreeEntries) break
					if (!uuidName.test(entry.name) || referenced.has(entry.name)) continue
					const handle = await this.safeFs.openAt(this.stagingHandle, entry.name, { metadata: true })
					try { const stat = await handle.stat({ bigint: true }); if (stat.isFile() && Number(stat.uid) === process.geteuid() && stat.nlink === 1n && Date.now() - Number(stat.mtimeMs) > this.limits.previewIdleMs) await this.safeFs.unlink(this.stagingHandle, entry.name) } finally { await handle.close() }
				}
			} finally { await entries.close().catch((error) => { if (error.code !== "ERR_DIR_CLOSED") throw error }) }
			this.retention = { state: "ready", sources: sourceSweep, cleanupBlocked: ops.filter((op) => op.cleanup?.state === "blocked" || op.trash?.state === "cleanup-blocked").length, cleanupIndeterminate: ops.filter((op) => op.cleanup?.state === "indeterminate").length }
		})
		// Retention is acquired only outside managed serialization. Never wait for it
		// while publication can hold retention and wait for the managed namespace lock.
		for (const expired of expiredHolds) {
			await this.captures.releaseHold(expired.holdId)
			await this.locks.run(async () => {
				const current = await this.state.get(expired.kind, expired.id)
				if (current?.[expired.field] === expired.holdId) await this.state.put(expired.kind, expired.id, { ...current, [expired.field]: null, ...(expired.kind === "recovery" ? { expiredAt: time() } : {}) })
			})
		}
	}
	async cleanTrash(name) {
		let work = 0
		const remove = async (parent, child, depth) => {
			if (++work > this.safeFs.scanLimit || depth > 64) throw new FileError(409, "subtree_limit", "Trash cleanup reached its work budget; remaining paths are retained.", { remainingPath: child })
			const metadata = await this.safeFs.openAt(parent, child, { metadata: true })
			let directory
			try {
				const stat = await metadata.stat({ bigint: true }); this.safeFs.policy.assertIdentity(stat, "write")
				if (stat.isDirectory()) {
					directory = await this.safeFs.openAt(parent, child, { directory: true })
					if (!sameObject(await directory.stat({ bigint: true }), stat)) throw new FileError(409, "source_changed", "Trash directory changed during cleanup.")
					const listing = await fs.opendir(`/proc/self/fd/${directory.fd}`, { encoding: "buffer" })
					try { for await (const entry of listing) { const next = new TextDecoder("utf-8", { fatal: true, ignoreBOM: true }).decode(entry.name); canonicalPath(next, { root: false }); if (next.includes("/")) throw new FileError(400, "invalid_path", "Unaddressable trash name."); await remove(directory, next, depth + 1) } } finally { await listing.close().catch((error) => { if (error.code !== "ERR_DIR_CLOSED") throw error }) }
				}
				const current = await this.safeFs.openAt(parent, child, { metadata: true })
				try { if (!sameObject(await current.stat({ bigint: true }), stat)) throw new FileError(409, "source_changed", "Trash entry changed before removal.") } finally { await current.close() }
				await this.safeFs.unlink(parent, child, stat.isDirectory())
			} finally { await directory?.close(); await metadata.close() }
		}
		await remove(this.trashHandle, name, 0); await this.trashHandle.sync()
	}
	async recovery() {
		const items = []
		for (const entry of await this.state.list("recovery")) {
			if (entry.state !== "available" || !entry.restoreAvailable || Date.parse(entry.expiresAt) <= Date.now()) continue
			const common = { id: entry.id, kind: entry.kind, original: entry.original, createdAt: entry.createdAt, expiresAt: entry.expiresAt, restoreAvailable: entry.restoreAvailable, restoreDisposition: entry.restoreDisposition }
			if (entry.kind === "remote-replacement") items.push({ ...common, source: entry.source })
			else if (entry.kind === "deleted-entry") items.push({ ...common, entryType: entry.entryType })
		}
		items.sort((a, b) => b.createdAt.localeCompare(a.createdAt))
		return { items, nextCursor: null }
	}
	async restoreRecovery(id, input) {
		claimIdentifier(input.operationId, "restore")
		identifier(id, "recoveryId")
		const record = await this.state.get("recovery", id)
		if (record?.kind === "remote-replacement") {
			if (record.state !== "available" || !record.restoreAvailable || record.restoreDisposition !== "copy" || Date.parse(record.expiresAt) <= Date.now()) throw new FileError(404, "not_found", "The recovery record is unavailable.")
			const opened = await this.captures.open("capture", record.source.captureId)
			try { return await this.upload(opened.handle.createReadStream({ autoClose: false }), { path: input.to, operationId: input.operationId, declaredSize: record.source.sizeBytes, mode: "create" }) } finally { await opened.release() }
		}
		if (record?.kind !== "deleted-entry") throw new FileError(404, "not_found", "The recovery record is unavailable.")
		const to = canonicalPath(input.to, { root: false })
		return this.mutate(input, "restore", { action: "restore", recoveryId: id, to }, [this.ref(to)], async (op) => {
			const current = await this.state.get("recovery", id)
			if (!current || current.kind !== "deleted-entry" || current.state !== "available" || !current.restoreAvailable || Date.parse(current.expiresAt) <= Date.now()) throw new FileError(404, "not_found", "The recovery record is unavailable.")
			this.safeFs.policy.assertWrite(to, { subtree: true })
			if (await this.checkBase(to, null, { exists: false })) throw new FileError(409, "exists", "The restore destination already exists.")
			let retained, parent
			try {
				retained = await this.safeFs.openAt(this.trashHandle, current.trashName, { metadata: true })
				parent = await this.safeFs.parent(to)
				const retainedStat = await retained.stat({ bigint: true })
				if (!sameObject(retainedStat, current.candidate) || (current.entryType === "file" ? !retainedStat.isFile() : !retainedStat.isDirectory())) throw new FileError(409, "source_changed", "The retained deleted entry no longer matches its recovery record.")
				await this.saveOperation(op, "publishing", { evidence: { path: to, candidate: current.candidate, parent: parent.parentIdentity, trashName: current.trashName, recoveryId: id, entryType: current.entryType } })
				await this.safeFs.rename(this.trashHandle, current.trashName, parent.handle, parent.name); op.effectApplied = true
				await this.trashHandle.sync(); await parent.handle.sync()
				if (!await this.safeFs.prove(to, current.candidate, parent.parentIdentity)) throw uncertain(op, "Restored object address proof failed.")
				await this.checkpoint("published", op)
				await this.committed(op, { metadata: await this.restoredMetadata(current, op) })
			} finally { await retained?.close(); await parent?.handle.close() }
		})
	}
	async restoredMetadata(record, restoreOperation) {
		const restoredAt = time(), restored = { ...record, state: "restored", restoreAvailable: false, restoredAt, restoreOperationId: restoreOperation.operationId, restoredTo: this.ref(restoreOperation.intent.to) }
		const metadata = [put("recovery", record.id, restored)]
		const deleted = await this.state.get("operations", record.deleteOperationId)
		if (deleted?.trash?.name === record.trashName) metadata.push(put("operations", deleted.operationId, { ...deleted, trash: { ...deleted.trash, state: "restored", restoredAt, restoreOperationId: restoreOperation.operationId, restoredTo: restored.restoredTo } }))
		return metadata
	}
	async applyPendingRemote(input) {
		claimIdentifier(input.operationId, "remote-apply")
		const previous = await this.state.get("operations", input.operationId)
		if (previous?.state === "committed") {
			if (previous.action !== "apply-remote" || previous.intent.entries.length !== 1 || previous.intent.entries[0].path !== input.path || previous.intent.entries[0].headToken !== input.remoteEtag || previous.intent.applyNow !== (input.applyNow === true) || previous.intent.discardLocal !== (input.discardLocal === true)) throw new FileError(409, "operation_id_reused", "The operation already records another remote replacement.")
			return previous
		}
		const adapter = this.persistence.adapter
		if (!adapter?.aligned || !adapter.checkHead) throw new FileError(503, "integration_unavailable", "No backend-aligned adapter can revalidate and deliver the selected pending remote replacement.", { requirements: this.persistence.capabilities().requirements })
		const name = cloudPath(input.path), pending = await this.state.get("cloud-pending", pathKey(name)), entry = pending?.entries.find((e) => e.path === name)
		if (!entry || entry.headToken !== input.remoteEtag || pending.entries.length !== 1 || entry.kind !== "file") throw new FileError(409, "source_changed", "Refresh the selected pending remote file before applying it.")
		await adapter.checkHead(entry)
		const base = (await this.remote.local(name)).generation, source = await adapter.source(entry.fileVersionId)
		if (source.sha256 !== entry.sha256 || source.sizeBytes !== entry.sizeBytes) throw new FileError(409, "source_changed", "The selected immutable version does not match the pending file.")
		const result = await this.applyRemote({ ...input, path: name, entries: pending.entries, processingPolicy: "skip" }, await adapter.download(source), base)
		if (result.state === "committed") await this.state.delete("cloud-pending", pathKey(name))
		return result
	}
	applyRemote(change, bytes, baseLocalGeneration) { if (change?.operationId !== undefined) claimIdentifier(change.operationId, "remote-apply"); return this.track(this.remote.apply(change, bytes, baseLocalGeneration)) }
	preparation(input) { return input?.type === "workbook" ? this.workbooks.prepare(input) : this.gis.prepare(input) }
	mapViewSave(input, publicationGuard) { return this.track(this.maps.save(input, publicationGuard)) }
	mapViewLoad(name) { return this.maps.load(name) }
	async representationProvider(id) { identifier(id, "representationId"); const index = await this.captures.record("index", id); return index.manifest?.kind === "workbook" ? this.workbooks : this.gis }
	async representation(id) { return (await this.representationProvider(id)).get(id) }
	async representationQuery(id, input, signal) { return (await this.representationProvider(id)).query(id, input, signal) }
	workbookQuery(id, input, signal) { return this.workbooks.query(id, input, signal) }
	workbookExport(id, input, signal) { return this.workbooks.export(id, input, signal) }
	async drain(deadline = new Date(Date.now() + 30000).toISOString()) {
		this.draining = true
		const end = Date.parse(deadline)
		if (!Number.isFinite(end)) throw new FileError(400, "invalid_request", "Drain requires an ISO deadline.")
		const imports = this.imports ? await this.imports.drain(deadline) : null
		let timer, processing
		try { [processing] = await Promise.all([this.processing.drain(deadline), Promise.race([Promise.allSettled([...this.pending]), new Promise((resolve) => { timer = setTimeout(resolve, Math.max(0, end - Date.now())) })])]) } finally { clearTimeout(timer) }
		const voxels = await this.voxels.drain(deadline), [workbooks, gis] = await Promise.all([this.workbooks.drain(deadline), this.gis.drain(deadline)]), captures = await this.captures.drain(deadline), ops = await this.state.list("operations")
		const localPending = ops.filter((op) => !terminal.has(op.state) && op.state !== "indeterminate").length + captures.localPending + workbooks.localPending + gis.localPending + voxels.localPending
		const publications = (await this.state.list("source-publications")).filter((p) => ["publishing", "indeterminate"].includes(p.state)), evidence = new Set([...ops.filter((op) => op.state === "indeterminate" || op.cleanup?.state === "indeterminate").map((op) => `operation:${op.operationId}`), ...publications.map((p) => `capture:${p.id}`), ...voxels.publicationEvidenceIds])
		const indeterminate = evidence.size + Math.max(0, captures.indeterminate - publications.length) + workbooks.receiptIndeterminate + gis.receiptIndeterminate + voxels.cleanupUncertainty
		const persistence = imports ? await this.persistence.drain(deadline) : { localPending: 0, remotePending: 0, failed: 0, indeterminate: 0, complete: false }
		const remotePending = Math.max(ops.filter((op) => !["not-configured", "clean"].includes(op.persistence?.state)).length, persistence.remotePending) + (imports?.remotePending || 0) + (processing.remotePending || 0)
		return { ...this.identity, admittingMutations: false, deadline, checkedAt: time(), localPending: localPending + (imports?.localPending || 0), remotePending, failed: ops.filter((op) => ["failed", "aborted-before-publication"].includes(op.state)).length + captures.failed + workbooks.failed + gis.failed + voxels.failed, indeterminate: indeterminate + persistence.indeterminate + (processing.indeterminate || 0), complete: !localPending && !remotePending && !indeterminate && !persistence.indeterminate && !processing.indeterminate && processing.complete && workbooks.complete && gis.complete && voxels.complete && (!imports || imports.complete), processing, workbooks, gis, voxels, captures, persistence, ...(imports ? { imports } : {}), cloudPersistence: imports ? "logical-heads" : "not-configured" }
	}
	close() {
		if (this.closing) return this.closing
		this.closed = true; this.draining = true; clearInterval(this.sweepTimer)
		this.closing = (async () => {
			try {
				await this.demo?.close()
				await this.imports?.close()
				await this.voxels?.close()
				this.#mutationAdmission.close(); this.#nativeAdmission.close()
				await Promise.all([this.workbooks?.close(), this.gis?.close()])
				await this.processing?.close()
				await this.searcher?.close(); await Promise.allSettled([...this.pending])
				await this.index?.close(); this.events?.close()
				await this.captures?.close()
				await this.state?.close(); await this.safeFs?.close()
			} finally { this.demo?.releaseOwner() } // Last: no admitted dispatch can still claim for this owner.
		})()
		return this.closing
	}
}
