import crypto from "node:crypto"
import { constants } from "node:fs"
import fs from "node:fs/promises"
import path from "node:path"
import { setImmediate as yieldTurn } from "node:timers/promises"
import { FILE_LIMITS, FileError, budget, canonicalPath, capturedSourceIdentity, fileError, identifier, observation, observationToken, sameObject, stableStringify } from "./file-contract.js"
import { FileSegments } from "./file-segments.js"
import { utf8Prefix } from "./file-segments-worker.js"

const terminal = new Set(["succeeded", "failed", "cancelled", "interrupted"])
const kinds = { capture: "captures", fragment: "fragments", index: "workbook-indexes" }
const uuid = "[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}"
const uuidPattern = new RegExp(`^${uuid}$`)
const partialPattern = new RegExp(`^(${uuid})\\.(${uuid})\\.partial$`)
const unresolved = (publication) => ["publishing", "indeterminate"].includes(publication.state)
const now = () => new Date().toISOString()
const failure = (status, error, message, details = {}) => new FileError(status, error, `FileCaptures: ${message}`, { agent: "file-service", tool: "file-captures", action: "Inspect the source and retained state, then submit a new request if needed.", ...details })
const cancelled = () => failure(409, "job_cancelled", "Work was cancelled before completion.")
const expired = (kind) => failure(410, `${kind}_expired`, kind === "index" ? "The retained representation is unavailable; submit a new preparation request ID using the same retained captures if they are still available." : "The retained source bytes are unavailable; create a new source explicitly.")
const report = (error) => { const e = fileError(error, "file-captures"); return { status: e.status, ...e.toJSON(), tool: "file-captures" } }
const fromReport = (error) => new FileError(error.status || 503, error.error, error.message, error)
export const VOXEL_CAPTURE_METADATA_BYTES = 4096

/** Protected byte representations, durable retention, and one bounded copy/hash queue. */
export class FileCaptures {
	constructor({ safeFs, state, storeDir, limits = {}, ref, onEvent = () => {}, ownership = {} }) {
		this.safeFs = safeFs; this.state = state; this.storeDir = storeDir; this.limits = { orphanPartialMs: 30 * 60 * 1000, ...FILE_LIMITS, ...limits }
		this.ref = ref || ((name) => ({ ...state.identity, path: name })); this.onEvent = onEvent; this.ownership = ownership
		this.availability = { state: "unavailable", reason: "ownership" }
		this.parser = new FileSegments({ state, limits: this.limits, ownership })
		this.readers = new Map(); this.queue = []; this.tasks = new Map(); this.running = null
		this.retentionTail = Promise.resolve(); this.admissionTail = Promise.resolve(); this.operations = new Set(); this.operationKinds = new Map()
		this.draining = false; this.closed = false
		this.activeStages = new Map(); this.stageNames = new WeakMap(); this.stagePublications = new WeakMap()
	}
	serial(name, work) {
		const result = this[name].then(work)
		this[name] = result.catch(() => {}) // The caller owns the error; subsequent independent work can proceed.
		return result
	}
	track(promise, kind) { this.operations.add(promise); this.operationKinds.set(promise, kind); promise.finally(() => { this.operations.delete(promise); this.operationKinds.delete(promise) }).catch(() => {}); return promise }
	async init() {
		if (this.initializing) return this.initializing
		this.initializing = (async () => {
			const { agentUids, workerUids } = this.ownership, uid = process.geteuid()
			const valid = (values) => Array.isArray(values) && values.length > 0 && values.every((value) => Number.isSafeInteger(value) && value >= 0 && value !== uid)
			if (!valid(agentUids) || !valid(workerUids) || !path.isAbsolute(this.storeDir || "")) return
			let phase = "ownership"
			try {
				await fs.mkdir(this.storeDir, { recursive: true, mode: 0o700 })
				if (!(await fs.lstat(this.storeDir)).isDirectory()) return
				this.ownershipCheck = await this.safeFs.checkOwnership(this.storeDir, { agentUids, workerUids })
				if (this.ownershipCheck?.ok !== true) return
				this.blobDir = path.join(this.storeDir, "blobs")
				await fs.mkdir(this.blobDir, { mode: 0o700 }).catch((error) => { if (error.code !== "EEXIST") throw error })
				const blobs = await fs.lstat(this.blobDir, { bigint: true })
				if (!blobs.isDirectory() || Number(blobs.uid) !== uid || (Number(blobs.mode) & 0o077)) return
				this.storeAnchor = await fs.open(this.storeDir, constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW)
				this.blobAnchor = await fs.open(this.blobDir, constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW)
				this.storeIdentity = await this.storeAnchor.stat({ bigint: true }); this.blobIdentity = await this.blobAnchor.stat({ bigint: true })
				await this.assertPrivateStore()
				phase = "storage"
				this.provenStrategies = await this.safeFs.probe()
				// First persist an interrupted outcome, then release that job's durable source hold.
				for (const job of await this.state.list("jobs")) {
					if (!terminal.has(job.state)) {
						job.state = "interrupted"; job.stage = "interrupted"; job.finishedAt = now()
						job.error = report(failure(503, "job_interrupted", "The file service stopped before this job completed."))
						await this.state.put("jobs", job.jobId, job)
					}
					if (!["capture", "retain"].includes(job.type)) continue
					if (job.source && job.state !== "succeeded") await this.failDigest(job.source.id, job.error)
					if (job.holdId) await this.state.delete("holds", job.holdId)
					const request = job.requestId ? await this.state.get("requests", job.requestId) : null
					if (request && !terminal.has(request.state)) await this.state.put("requests", request.requestId, { ...request, state: job.state, error: job.error || null, result: job.result || null })
				}
				for (const request of await this.state.list("requests")) {
					if (request.type !== "capture" || terminal.has(request.state)) continue
					await this.state.put("requests", request.requestId, { ...request, state: "interrupted", finishedAt: now(), error: report(failure(503, "job_interrupted", "Capture admission was interrupted; submit a new request ID to retry.")) })
				}
				await this.recoverPublications()
				await this.recoverEvictions()
				await this.collectOrphanPartials()
				await this.parser.init()
				this.availability = { state: "available" }
			} catch (error) {
				this.availability = { state: "unavailable", reason: phase }; this.startupError = report(error)
			}
		})()
		return this.initializing
	}
	requireAvailable() {
		if (this.closed || this.availability.state !== "available") throw failure(503, "capture_store_unavailable", "Protected source storage is unavailable.", { reason: this.closed ? "closed" : this.availability.reason, ...(this.startupError ? { cause: this.startupError } : {}), action: this.availability.reason === "ownership" ? "Configure distinct service, agent and worker UIDs and verify protected store ancestors, ACLs and hardlinks." : "Inspect protected storage and the metadata journal, then restart the file service." })
	}
	requireAdmission() { this.requireAvailable(); if (this.draining) throw failure(503, "draining", "The file service is draining accepted work.", { action: "Retry after the file service restarts." }) }
	normalKind(kind) { if (!Object.hasOwn(kinds, kind)) throw failure(400, "invalid_source", "Source kind must be capture or fragment."); return kinds[kind] }
	address(name) {
		const ref = typeof this.ref === "function" ? this.ref(name) : { ...this.ref, path: name }
		if (!ref || ref.workspaceId !== this.state.identity.workspaceId || ref.workspaceEpoch !== this.state.identity.workspaceEpoch) throw failure(400, "invalid_source", "Source address must bind this workspace epoch.")
		return { ...ref, path: canonicalPath(name, { root: false }) }
	}
	async statFile(handle) {
		const stat = await handle.stat({ bigint: true })
		if (!stat.isFile()) throw failure(400, "unsupported_resource", "Only regular files can supply source bytes.")
		if (!Number.isSafeInteger(Number(stat.size)) || stat.size < 0n) throw failure(400, "unsupported_size", "Source size exceeds the supported byte-offset domain.")
		return stat
	}
	checkBase(base, ref, stat) {
		if (base === undefined || base === null) return
		const token = this.baseToken(base, ref)
		if (token !== observationToken(stat)) throw failure(409, "source_changed", "The selected pathname no longer has the requested observation.", { currentObservation: observation(ref, stat) })
	}
	baseToken(base, ref) {
		if (base === undefined || base === null) return null
		const token = typeof base === "string" ? base : base.token
		if (typeof token !== "string" || !token || token.length > 512 || (base.ref && stableStringify(base.ref) !== stableStringify(ref))) throw failure(400, "invalid_observation", "baseObservation must identify this workspace address.")
		return token
	}
	privatePath(basename) { return `/proc/self/fd/${this.blobAnchor.fd}/${basename}` }
	blobPath(record) { return this.privatePath(`${record.kind}.${record.id}`) }
	stageBasename(publication) {
		const match = typeof publication.stagingBasename === "string" && partialPattern.exec(publication.stagingBasename)
		return match && match[1] === publication.id ? publication.stagingBasename : null
	}
	inspectionRef(publication) { const name = this.stageBasename(publication); return name ? `blobs/${name}` : `${publication.kind}/${publication.id}` }
	publicationError(publication) { return failure(503, "storage_unavailable", "Source publication remains indeterminate; retained evidence must be inspected before this source can be used.", { state: "indeterminate", inspectionRef: this.inspectionRef(publication), candidateSource: publication.source }) }
	async assertPrivateStore() {
		for (const [name, anchor, expected] of [[this.storeDir, this.storeAnchor, this.storeIdentity], [this.blobDir, this.blobAnchor, this.blobIdentity]]) {
			const stat = await anchor.stat({ bigint: true }), named = await fs.lstat(name, { bigint: true })
			if (!stat.isDirectory() || !named.isDirectory() || !sameObject(stat, expected) || !sameObject(named, expected) || Number(stat.uid) !== process.geteuid() || (Number(stat.mode) & 0o077)) throw failure(503, "capture_store_unavailable", "Protected store ancestor identity or ownership changed.", { state: "indeterminate", reason: "ownership" })
		}
	}
	async evidence(basename, candidate, sizeBytes, protectedMode = true) {
		let handle
		try {
			await this.assertPrivateStore()
			handle = await fs.open(this.privatePath(basename), constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK)
			const stat = await handle.stat({ bigint: true }), mode = Number(stat.mode) & 0o777
			const safe = stat.isFile() && Number(stat.uid) === process.geteuid() && stat.nlink === 1n && (protectedMode ? mode === 0o400 : [0o400, 0o600].includes(mode))
			const match = safe && (!candidate || sameObject(stat, candidate)) && (sizeBytes === undefined || Number(stat.size) === sizeBytes) && (!candidate?.mtimeNs || String(stat.mtimeNs) === String(candidate.mtimeNs))
			return { state: match ? "match" : "mismatch", stat }
		} catch (error) {
			if (error.code === "ENOENT") return { state: "missing" }
			if (["ELOOP", "EACCES", "EPERM"].includes(error.code)) return { state: "mismatch" }
			throw error
		} finally { await handle?.close() }
	}
	async unlinkExpected(basename, candidate, protectedMode = false, sizeBytes) {
		const checked = await this.evidence(basename, candidate, sizeBytes, protectedMode)
		if (checked.state === "missing") return true
		if (checked.state !== "match") return false
		// Linux has no compare-and-unlink. The retention mutex plus the protected, sole-writer
		// namespace excludes replacement here; anchored lookup and inode recheck reject stale evidence.
		const named = await fs.lstat(this.privatePath(basename), { bigint: true })
		if (!sameObject(named, checked.stat)) return false
		await fs.unlink(this.privatePath(basename)); await this.syncDir()
		return true
	}
	validPublication(publication) {
		try {
			const ops = publication.metadataOperations
			if (publication.kind === "index") return uuidPattern.test(publication.id) && this.stageBasename(publication) && publication.candidate?.dev && publication.candidate?.ino &&
				publication.source?.kind === "runtime-capture" && publication.source.ref.workspaceId === this.state.identity.workspaceId && publication.source.ref.workspaceEpoch === this.state.identity.workspaceEpoch &&
				Number.isSafeInteger(publication.sizeBytes) && publication.sizeBytes >= 0 && Array.isArray(ops) && ops.length === 2 &&
				ops[0].type === "put" && ops[0].kind === kinds.index && ops[0].id === publication.id && ops[0].value.kind === "index" && ops[0].value.id === publication.id &&
				this.validIndexDependencies(ops[0].value) && stableStringify(publication.dependencies || this.indexDependencies(ops[0].value)) === stableStringify(this.indexDependencies(ops[0].value)) && stableStringify(ops[0].value.source) === stableStringify(publication.source) &&
				ops[1].type === "delete" && ops[1].kind === "index-reservations" && ops[1].id === ops[0].value.reservationId
			return uuidPattern.test(publication.id) && Object.hasOwn(kinds, publication.kind) && this.stageBasename(publication) && publication.candidate?.dev && publication.candidate?.ino &&
				publication.source?.kind === `runtime-${publication.kind}` && (publication.source.captureId || publication.source.fragmentId) === publication.id &&
				publication.source.ref.workspaceId === this.state.identity.workspaceId && publication.source.ref.workspaceEpoch === this.state.identity.workspaceEpoch &&
				Number.isSafeInteger(publication.sizeBytes) && publication.sizeBytes >= 0 && Array.isArray(ops) && ops.length >= 2 &&
				ops[0].type === "put" && ops[0].kind === kinds[publication.kind] && ops[0].id === publication.id && stableStringify(ops[0].value.source) === stableStringify(publication.source) &&
				ops.some((op) => op.kind === "leases") && (!publication.holdId || ops.some((op) => op.kind === "holds" && op.id === publication.holdId)) &&
				ops.every((op) => op.type === "put" && (op.kind === kinds[publication.kind] ? op.id === publication.id && op.value.id === publication.id && op.value.kind === publication.kind :
					["leases", "holds"].includes(op.kind) ? op.value.source?.kind === publication.kind && op.value.source?.id === publication.id && op.id === (op.value.leaseId || op.value.holdId) :
					publication.kind === "capture" && this.validVoxelConversion(publication, op))) &&
				(!publication.reservationId || ops.filter((op) => op.kind === "voxel-owned-captures").length === 1 && ops.filter((op) => op.kind === "voxel-reservations").length === 1)
		} catch { return false }
	}
	validVoxelConversion(publication, op) {
		const binding = publication.reservationBinding
		if (!publication.reservationId || !binding || Object.keys(binding).length !== 7 || Object.keys(binding).some((k) => !["reservationId", "artifactId", "workspaceEpoch", "key", "captureId", "sizeBytes", "metadataBytes"].includes(k)) || binding.reservationId !== publication.reservationId || binding.captureId !== publication.id || binding.sizeBytes !== publication.sizeBytes || binding.metadataBytes !== VOXEL_CAPTURE_METADATA_BYTES || binding.workspaceEpoch !== this.state.identity.workspaceEpoch || publication.metadataOperations[0].value.metadataBytes !== binding.metadataBytes || publication.metadataOperations[0].value.sizeBytes !== binding.sizeBytes) return false
		if (op.kind === "voxel-owned-captures") return op.id === publication.id && stableStringify(op.value) === stableStringify(binding)
		if (op.kind !== "voxel-reservations" || op.id !== publication.reservationId) return false
		const reservation = op.value, entry = reservation.entries?.find((e) => e.key === binding.key)
		return this.validVoxelReservation(reservation) && reservation.id === op.id && reservation.artifactId === binding.artifactId && reservation.workspaceEpoch === binding.workspaceEpoch && entry?.captureId === publication.id && entry.converted === true && entry.sizeBytes === binding.sizeBytes && entry.metadataBytes === binding.metadataBytes && entry.path === publication.source.ref.path && entry.sha256 === publication.source.digest.sha256 && entry.staging?.basename === publication.stagingBasename && sameObject(entry.staging.candidate, publication.candidate)
	}
	validVoxelReservation(r) {
		try {
			if (!r || Object.keys(r).some((k) => !["id", "artifactId", "operationId", "workspaceEpoch", "entries", "registryMetadataBytes", "createdAt", "reclaimedStagingBytes"].includes(k)) || !uuidPattern.test(r.id) || r.workspaceEpoch !== this.state.identity.workspaceEpoch || !Number.isSafeInteger(r.registryMetadataBytes) || r.registryMetadataBytes < 0 || r.reclaimedStagingBytes !== undefined && (!Number.isSafeInteger(r.reclaimedStagingBytes) || r.reclaimedStagingBytes < 0) || !Number.isFinite(Date.parse(r.createdAt)) || !Array.isArray(r.entries) || r.entries.length > 5 || new Set(r.entries.map((e) => e.key)).size !== r.entries.length) return false
			identifier(r.artifactId); identifier(r.operationId)
			return r.entries.every((e) => Object.keys(e).length === 7 + (e.staging ? 1 : 0) + (e.cleanupState ? 1 : 0) && Object.keys(e).every((k) => ["key", "captureId", "path", "sha256", "sizeBytes", "metadataBytes", "converted", "staging", "cleanupState"].includes(k)) && ["values", "valid", "counts", "weights", "manifest"].includes(e.key) && (uuidPattern.test(e.captureId) || e.captureId === null && e.key === "manifest" && !e.converted) && canonicalPath(e.path, { root: false }) === e.path && /^[0-9a-f]{64}$/.test(e.sha256) && Number.isSafeInteger(e.sizeBytes) && e.sizeBytes >= 0 && e.metadataBytes === VOXEL_CAPTURE_METADATA_BYTES && typeof e.converted === "boolean" && (!e.staging || this.validVoxelStage(e)) && (e.cleanupState === undefined || e.cleanupState === "indeterminate"))
		} catch { return false }
	}
	validVoxelStage(e) {
		const s = e.staging, match = typeof s.basename === "string" && partialPattern.exec(s.basename)
		return match && match[1] === e.captureId && Object.keys(s).every((k) => ["basename", "candidate", "cleanupState"].includes(k)) && Object.keys(s.candidate).length === 2 && Object.keys(s.candidate).every((k) => ["dev", "ino"].includes(k)) && /^[0-9]+$/.test(s.candidate.dev) && /^[0-9]+$/.test(s.candidate.ino) && (s.cleanupState === undefined || ["pending", "indeterminate"].includes(s.cleanupState))
	}
	async recoveryMetadata(publication) {
		if (!publication.reservationId) return publication.metadataOperations
		const reservation = await this.state.get("voxel-reservations", publication.reservationId), binding = publication.reservationBinding, entry = reservation?.entries.find((e) => e.key === binding.key)
		if (!this.validVoxelReservation(reservation) || reservation.artifactId !== binding.artifactId || reservation.workspaceEpoch !== binding.workspaceEpoch || !entry || entry.path !== publication.source.ref.path || entry.sha256 !== publication.source.digest.sha256 || entry.sizeBytes !== publication.sizeBytes || entry.captureId && entry.captureId !== publication.id || entry.staging?.basename !== publication.stagingBasename || !sameObject(entry.staging.candidate, publication.candidate)) throw failure(503, "storage_unavailable", "Artifact reservation no longer matches interrupted capture publication.")
		return publication.metadataOperations.map((op) => op.kind === "voxel-reservations" ? { ...op, value: { ...reservation, entries: reservation.entries.map((e) => e.key === binding.key ? { ...e, captureId: publication.id, converted: true } : e) } } : op)
	}
	indexDependencies(index) { return index.dependencies || (index.dependency ? [index.dependency] : []) }
	indexInputs(index) { return index.manifest?.inputs || [{ source: index.source, sha256: index.manifest?.inputSha256 }] }
	validIndexDependencies(index) {
		const dependencies = this.indexDependencies(index), inputs = this.indexInputs(index)
		return dependencies.length > 0 && dependencies.length === inputs.length && dependencies[0].id === index.source.captureId && stableStringify(capturedSourceIdentity(index.source)) === stableStringify(capturedSourceIdentity(inputs[0].source)) && new Set(dependencies.map((d) => d.id)).size === dependencies.length &&
			dependencies.every((d, n) => d.kind === "capture" && d.id === inputs[n].source?.captureId && inputs[n].source?.kind === "runtime-capture" && inputs[n].source.ref?.workspaceId === this.state.identity.workspaceId && inputs[n].source.ref?.workspaceEpoch === this.state.identity.workspaceEpoch && /^[0-9a-f]{64}$/.test(inputs[n].sha256 || ""))
	}
	async validateIndexInputs(index) {
		if (!this.validIndexDependencies(index)) throw failure(409, "source_changed", "Index dependencies do not match the exact retained input set.")
		for (const input of this.indexInputs(index)) {
			const record = await this.record("capture", input.source.captureId), handle = await this.privateFile(record); await handle.close()
			if (stableStringify(capturedSourceIdentity(record.source)) !== stableStringify(capturedSourceIdentity(input.source)) || record.source.digest.state === "ready" && record.source.digest.sha256 !== input.sha256) throw failure(409, "source_changed", "Index publication no longer binds its retained input and verified SHA-256.")
		}
	}
	async markIndeterminate(publication, cause) {
		await this.state.put("source-publications", publication.id, { ...publication, state: "indeterminate", inspectionRef: this.inspectionRef(publication), ...(cause ? { error: report(cause) } : {}) })
	}
	async recoverPublications(ids) {
		for (const publication of await this.state.list("source-publications")) {
			if (ids && !ids.has(publication.id)) continue
			if (!unresolved(publication) && !(publication.state === "aborted-before-publication" && publication.cleanupPending)) continue
			if (!this.validPublication(publication)) { await this.markIndeterminate(publication); continue }
			const basename = this.stageBasename(publication)
			const final = await this.evidence(`${publication.kind}.${publication.id}`, publication.candidate, publication.sizeBytes)
			const staged = await this.evidence(basename, publication.candidate, publication.sizeBytes)
			if (final.state === "match" && staged.state === "missing" && publication.state !== "aborted-before-publication") {
				if (publication.kind === "index") { try { await this.validateIndexInputs(publication.metadataOperations[0].value) } catch (error) { await this.markIndeterminate(publication, error); continue } }
				await this.syncDir()
				let recovery
				try { recovery = await this.recoveryMetadata(publication) } catch (error) { await this.markIndeterminate(publication, error); continue }
				const metadataOperations = recovery.map((op) => op.kind === kinds[publication.kind] ? { ...op, value: { ...op.value, blobObservation: observationToken(final.stat) } } : op)
				await this.state.transaction([...metadataOperations, { type: "put", kind: "source-publications", id: publication.id, value: { ...publication, state: "committed", recovered: true, recoveredAt: now() } }])
			} else if (final.state === "missing" && (staged.state === "match" || (staged.state === "missing" && publication.state === "aborted-before-publication")) && !await this.state.get(kinds[publication.kind], publication.id)) {
				const aborted = { ...publication, state: "aborted-before-publication", cleanupPending: true, inspectionRef: this.inspectionRef(publication), recoveredAt: now() }
				await this.state.put("source-publications", publication.id, aborted)
				if (await this.unlinkExpected(basename, publication.candidate, true, publication.sizeBytes)) await this.state.put("source-publications", publication.id, { ...aborted, cleanupPending: false, cleanedAt: now() })
				else await this.markIndeterminate(aborted)
			} else await this.markIndeterminate(publication)
		}
	}
	async collectOrphanPartials() {
		await this.assertPrivateStore()
		const publications = (await this.state.list("source-publications")).filter((pub) => unresolved(pub) || pub.cleanupPending)
		const protectedIds = new Set(publications.map((pub) => pub.id)), protectedNames = new Set(publications.map((pub) => this.stageBasename(pub)).filter(Boolean))
		for (const reservation of await this.state.list("voxel-reservations")) for (const entry of reservation.entries) { if (entry.captureId) protectedIds.add(entry.captureId); if (entry.staging) protectedNames.add(entry.staging.basename) }
		for (const [key, count] of this.readers) if (count) protectedIds.add(key.split("/")[1])
		for (const job of await this.state.list("jobs")) if (!terminal.has(job.state)) {
			if (job.source?.id) protectedIds.add(job.source.id)
			if (job.resultRef) protectedIds.add(job.resultRef)
			for (const name of [job.stagingBasename, job.stageBasename]) if (typeof name === "string" && partialPattern.test(name)) protectedNames.add(name)
		}
		let orphaned = 0, orphanedBytes = 0
		for (const basename of await fs.readdir(`/proc/self/fd/${this.blobAnchor.fd}`)) {
			const match = partialPattern.exec(basename)
			if (!match || this.activeStages.has(basename) || protectedNames.has(basename) || protectedIds.has(match[1])) continue
			const checked = await this.evidence(basename, undefined, undefined, false)
			if (checked.state !== "match" || Date.now() - Number(checked.stat.mtimeMs) < this.limits.orphanPartialMs) continue
			if (await this.unlinkExpected(basename, checked.stat)) { orphaned++; orphanedBytes += Number(checked.stat.size) }
		}
		return { orphaned, orphanedBytes }
	}
	async retainedUsage(records, publications) {
		const known = new Map(records.map((record) => [record.id, record.sizeBytes + (record.metadataBytes || 0)])), entries = await fs.readdir(`/proc/self/fd/${this.blobAnchor.fd}`)
		let unresolvedBytes = 0
		const accounted = new Map(known)
		for (const publication of publications.filter(unresolved)) {
			const names = new Set(entries.filter((name) => partialPattern.exec(name)?.[1] === publication.id))
			if (uuidPattern.test(publication.id) && Object.hasOwn(kinds, publication.kind)) names.add(`${publication.kind}.${publication.id}`)
			const inodes = new Set(); let physicalBytes = 0
			for (const name of names) {
				try { const stat = await fs.lstat(this.privatePath(name), { bigint: true }), key = `${stat.dev}/${stat.ino}`; if (stat.isFile() && !inodes.has(key)) { inodes.add(key); physicalBytes += Number(stat.size) } }
				catch (error) { if (error.code !== "ENOENT") throw error }
			}
			const bytes = Math.max(publication.sizeBytes || 0, physicalBytes) + (publication.metadataOperations?.[0]?.value.metadataBytes || 0)
			unresolvedBytes += Math.max(0, bytes - (known.get(publication.id) || 0))
			accounted.set(publication.id, Math.max(accounted.get(publication.id) || 0, bytes))
		}
		for (const entry of (await this.state.list("voxel-owned-captures")).filter((e) => !e.reclaimedAt)) {
			const bytes = Math.max(entry.sizeBytes, await this.voxelPhysicalBytes(entry.captureId, entries)) + entry.metadataBytes, previous = accounted.get(entry.captureId) || 0
			if (previous < bytes) { unresolvedBytes += bytes - previous; accounted.set(entry.captureId, bytes) }
		}
		let voxelReserved = 0
		for (const reservation of await this.state.list("voxel-reservations")) {
			voxelReserved += reservation.registryMetadataBytes
			for (const entry of reservation.entries) if (!entry.converted) voxelReserved += Math.max(0, Math.max(entry.sizeBytes, entry.captureId ? await this.voxelPhysicalBytes(entry.captureId, entries) : 0) + entry.metadataBytes - (entry.captureId ? accounted.get(entry.captureId) || 0 : 0))
		}
		const reservedBytes = voxelReserved + (await this.state.list("index-reservations")).reduce((sum, reservation) => sum + Math.max(0, reservation.sizeBytes - (accounted.get(reservation.representationId) || 0)), 0)
		return { retainedBytes: records.reduce((sum, record) => sum + record.sizeBytes + (record.metadataBytes || 0), 0) + unresolvedBytes + reservedBytes, unresolvedBytes, reservedBytes }
	}
	async retainedRecords() { return [...await this.state.list("captures"), ...await this.state.list("fragments"), ...await this.state.list(kinds.index)].filter((record) => !record.evictedAt || record.cleanupPending) }
	async voxelPhysicalBytes(id, entries) {
		entries ||= await fs.readdir(`/proc/self/fd/${this.blobAnchor.fd}`)
		const names = entries.filter((name) => name === `capture.${id}` || partialPattern.exec(name)?.[1] === id), inodes = new Set(); let bytes = 0
		for (const name of names) try { const stat = await fs.lstat(this.privatePath(name), { bigint: true }), key = `${stat.dev}/${stat.ino}`; if (!inodes.has(key)) { inodes.add(key); bytes += Number(stat.size) } } catch (error) { if (error.code !== "ENOENT") throw error }
		return bytes
	}
	async voxelUsage() {
		const owned = (await this.state.list("voxel-owned-captures")).filter((e) => !e.reclaimedAt), reservations = await this.state.list("voxel-reservations"), byId = new Map(owned.map((e) => [e.captureId, e])), publications = await this.state.list("source-publications"), entries = await fs.readdir(`/proc/self/fd/${this.blobAnchor.fd}`)
		let reservedBytes = 0, registryMetadataBytes = 0, unresolvedBytes = 0, stagingCleanupUncertainty = 0, cleanupPendingBytes = 0
		for (const r of reservations) {
			registryMetadataBytes += r.registryMetadataBytes
			for (const e of r.entries) if (!e.converted && !byId.has(e.captureId)) {
				const p = publications.find((p) => p.reservationId === r.id && p.reservationBinding?.key === e.key && unresolved(p)), bytes = Math.max(e.sizeBytes, e.captureId ? await this.voxelPhysicalBytes(e.captureId, entries) : p ? await this.voxelPhysicalBytes(p.id, entries) : 0) + e.metadataBytes
				reservedBytes += bytes; if (p) unresolvedBytes += bytes
				if (e.cleanupState === "indeterminate" || e.staging?.cleanupState === "indeterminate") stagingCleanupUncertainty++
				if (e.cleanupState || e.staging?.cleanupState) cleanupPendingBytes += bytes
			}
		}
		let captureBytes = 0
		for (const e of owned) { const bytes = Math.max(e.sizeBytes, await this.voxelPhysicalBytes(e.captureId, entries)) + e.metadataBytes; captureBytes += bytes; if (e.cleanupRequestedAt) cleanupPendingBytes += bytes }
		return { retainedBytes: captureBytes + registryMetadataBytes, reservedBytes, unresolvedBytes, totalBytes: captureBytes + registryMetadataBytes + reservedBytes, cleanupPendingBytes, stagingCleanupUncertainty }
	}
	reserveVoxel(reservation, ceiling, metadata = []) {
		return this.withRetention(async () => {
			if (!this.validVoxelReservation(reservation) || !Number.isSafeInteger(ceiling) || ceiling < 1 || metadata.length !== 1 || metadata[0].type !== "put" || metadata[0].kind !== "voxel-artifacts" || metadata[0].id !== reservation.artifactId || metadata[0].value.reservationId !== reservation.id || metadata[0].value.operationId !== reservation.operationId) throw failure(400, "invalid_reservation", "Whole-artifact reservation must contain exact bounded entries and its producer registration.")
			if (await this.state.get("voxel-reservations", reservation.id)) throw failure(409, "reservation_conflict", "Artifact reservation ID already exists.")
			const requiredBytes = reservation.registryMetadataBytes + reservation.entries.reduce((sum, e) => sum + e.sizeBytes + e.metadataBytes, 0), usage = await this.voxelUsage(), shared = await this.retainedUsage(await this.retainedRecords(), await this.state.list("source-publications"))
			if (usage.totalBytes + requiredBytes > ceiling) throw failure(507, "artifact_storage_limit", "The complete artifact exceeds available artifact storage.", { requiredBytes, availableBytes: Math.max(0, ceiling - usage.totalBytes), action: "Delete unused voxel artifacts and wait for cleanup, or raise artifactRetainedBytes." })
			if (shared.retainedBytes + requiredBytes > this.limits.retainedBytes) throw failure(507, "insufficient_storage", "The complete artifact exceeds shared protected storage.", { requiredBytes, availableBytes: Math.max(0, this.limits.retainedBytes - shared.retainedBytes), action: "Release unused protected captures and wait for cleanup." })
			await this.state.transaction([{ type: "put", kind: "voxel-reservations", id: reservation.id, value: reservation }, ...metadata])
		})
	}
	releaseVoxelReservation(id, uncertainKeys = []) {
		return this.withRetention(async () => {
			let reservation = await this.state.get("voxel-reservations", id); if (!reservation) return
			const keys = new Set(uncertainKeys), entries = []
			for (let entry of reservation.entries) {
				if (entry.converted || keys.has(entry.key)) { entries.push(entry); continue }
				const names = (await fs.readdir(`/proc/self/fd/${this.blobAnchor.fd}`)).filter((name) => name === `capture.${entry.captureId}` || partialPattern.exec(name)?.[1] === entry.captureId)
				if (!names.length) continue
				const knownStage = entry.staging && this.validVoxelStage(entry) && names.length === 1 && names[0] === entry.staging.basename && !this.activeStages.has(names[0])
				if (knownStage) {
					const checked = await this.evidence(names[0], entry.staging.candidate, undefined, false)
					if (checked.state === "match") {
						entry = { ...entry, staging: { ...entry.staging, cleanupState: "pending" } }; reservation = { ...reservation, entries: reservation.entries.map((e) => e.key === entry.key ? entry : e) }
						await this.state.put("voxel-reservations", id, reservation)
						if (await this.unlinkExpected(names[0], entry.staging.candidate)) { reservation.reclaimedStagingBytes = (reservation.reclaimedStagingBytes || 0) + Number(checked.stat.size); continue }
					}
				}
				entries.push({ ...entry, cleanupState: "indeterminate" })
			}
			await this.state.put("voxel-reservations", id, { ...reservation, entries })
		})
	}
	async captureBlockers(id) {
		const blockers = [], publications = await this.state.list("source-publications")
		const owned = await this.state.get("voxel-owned-captures", id)
		if (owned?.key === "manifest") { const interest = this.voxelPersistenceInterest ? await this.voxelPersistenceInterest(owned) : { needed: true, blocker: "persistenceEvidence" }; if (interest.needed) blockers.push(interest.blocker) }
		if (publications.some((p) => unresolved(p) && (p.id === id || p.dependencies?.some((d) => d.id === id)))) blockers.push("publicationReconciliation")
		if ((await this.state.list("holds")).some((h) => h.source.kind === "capture" && h.source.id === id)) blockers.push("hold")
		if ((await this.state.list("leases")).some((l) => l.source.kind === "capture" && l.source.id === id && Date.parse(l.expiresAt) > Date.now())) blockers.push("lease")
		if (this.readers.get(`capture/${id}`) > 0) blockers.push("reader")
		for (const index of await this.state.list(kinds.index)) if (this.indexDependencies(index).some((d) => d.id === id) && this.readers.get(`index/${index.id}`) > 0) blockers.push("indexReader")
		return [...new Set(blockers)]
	}
	cleanupVoxelCaptures(ids) {
		return this.withRetention(async () => {
			const results = []
			for (const id of new Set(ids)) {
				let owned = await this.state.get("voxel-owned-captures", id)
				if (!owned) { results.push({ captureId: id, reclaimed: false, blockers: ["unknownOwnership"], indeterminate: true }); continue }
				if (owned.reclaimedAt) { results.push({ captureId: id, reclaimed: true, bytes: owned.reclaimedBytes || 0, blockers: [] }); continue }
				owned = { ...owned, cleanupRequestedAt: owned.cleanupRequestedAt || now() }; await this.state.put("voxel-owned-captures", id, owned)
				const blockers = await this.captureBlockers(id)
				if (blockers.length) { results.push({ captureId: id, reclaimed: false, blockers, indeterminate: blockers.includes("publicationReconciliation") }); continue }
				const record = await this.state.get("captures", id)
				if (!record) { results.push({ captureId: id, reclaimed: false, blockers: ["unknownBytes"], indeterminate: true }); continue }
				try {
					const tombstone = { ...record, evictedAt: record.evictedAt || now(), cleanupPending: true }; await this.state.put("captures", id, tombstone); await this.finishEviction(tombstone)
					const reclaimed = await this.state.get("voxel-owned-captures", id); results.push({ captureId: id, reclaimed: true, bytes: reclaimed.reclaimedBytes || 0, blockers: [] })
				} catch (error) { await this.state.put("voxel-owned-captures", id, { ...owned, cleanupIndeterminate: true, cleanupError: report(error) }); results.push({ captureId: id, reclaimed: false, blockers: ["unknownBytes"], indeterminate: true, error: report(error) }) }
			}
			return results
		})
	}
	/** Called under retention: source bytes, index staging and publication use one capacity ledger. */
	async reserveIndex(reservation, metadata = []) {
		const { retainedBytes } = await this.retainedUsage(await this.retainedRecords(), await this.state.list("source-publications"))
		if (retainedBytes + reservation.sizeBytes > this.limits.retainedBytes) throw failure(507, "insufficient_storage", "Derived index headroom exceeds retained storage capacity.", { action: "Release unused captures or increase retainedBytes before preparing this input set.", limits: { retainedBytes: this.limits.retainedBytes, indexReservationBytes: reservation.sizeBytes } })
		await this.state.transaction([{ type: "put", kind: "index-reservations", id: reservation.id, value: reservation }, ...metadata])
	}
	async finishEviction(record) {
		// The tombstone is committed before any deletion. A restart resumes the same cascade.
		const dependents = record.kind === "capture" ? (await this.state.list(kinds.index)).filter((index) => this.indexDependencies(index).some((d) => d.id === record.id) && (!index.evictedAt || index.cleanupPending)) : []
		for (const index of dependents) {
			const tombstone = { ...index, evictedAt: index.evictedAt || record.evictedAt, cleanupPending: true }
			await this.state.put(kinds.index, index.id, tombstone)
			if (!await this.unlinkExpected(`index.${index.id}`, (await this.state.get("source-publications", index.id))?.candidate, true, index.sizeBytes)) throw failure(503, "storage_unavailable", "Dependent index eviction found uncertain bytes; the tombstone and bytes were preserved.")
			await this.state.put(kinds.index, index.id, { ...tombstone, cleanupPending: false })
		}
		const owned = record.kind === "capture" && await this.state.get("voxel-owned-captures", record.id), candidate = (await this.state.get("source-publications", record.id))?.candidate
		if (owned && (await fs.readdir(`/proc/self/fd/${this.blobAnchor.fd}`)).some((name) => partialPattern.exec(name)?.[1] === record.id)) throw failure(503, "storage_unavailable", "Artifact cleanup found additional candidate bytes; identities remain retained for inspection.")
		const before = owned ? await this.evidence(`${record.kind}.${record.id}`, candidate, record.sizeBytes) : null
		if (!await this.unlinkExpected(`${record.kind}.${record.id}`, candidate, true, record.sizeBytes)) throw failure(503, "storage_unavailable", "Source eviction found uncertain bytes; the tombstone and bytes were preserved.")
		await this.state.transaction([{ type: "put", kind: kinds[record.kind], id: record.id, value: { ...record, cleanupPending: false } }, ...(owned ? [{ type: "put", kind: "voxel-owned-captures", id: record.id, value: { ...owned, reclaimedAt: now(), reclaimedBytes: before.state === "match" ? record.sizeBytes : 0 } }] : [])])
	}
	async recoverEvictions() {
		for (const record of await this.retainedRecords()) if (record.evictedAt && record.cleanupPending) try {
			const owned = record.kind === "capture" && await this.state.get("voxel-owned-captures", record.id)
			// Boot precedes persistence construction. Unavailable evidence cannot
			// prove that an independently admitted push no longer needs its bytes.
			if (owned && (await this.captureBlockers(record.id)).length) continue
			await this.finishEviction(record)
		} catch (error) {
			const owned = record.kind === "capture" && await this.state.get("voxel-owned-captures", record.id)
			if (!owned) throw error
			await this.state.put("voxel-owned-captures", record.id, { ...owned, cleanupRequestedAt: owned.cleanupRequestedAt || now(), cleanupIndeterminate: true, cleanupError: report(error) })
		}
	}
	async privateFile(record) {
		let handle
		try {
			handle = await fs.open(this.blobPath(record), constants.O_RDONLY | constants.O_NOFOLLOW)
			const stat = await this.statFile(handle)
			if (Number(stat.uid) !== process.geteuid() || stat.nlink !== 1n || (Number(stat.mode) & 0o022) || observationToken(stat) !== record.blobObservation) throw failure(503, "capture_store_unavailable", "The protected representation changed unexpectedly; it cannot be rebound to replacement bytes.", { reason: "integrity" })
			return handle
		} catch (error) {
			await handle?.close()
			if (error.code === "ENOENT") {
				const held = (await this.state.list("holds")).some((hold) => hold.source.kind === record.kind && hold.source.id === record.id)
				if (held) throw failure(503, "transfer_source_missing", "Durably held source bytes are missing; retained work is indeterminate.", { state: "indeterminate" })
				throw expired(record.kind)
			}
			throw fileError(error, "file-captures.open")
		}
	}
	async record(kind, id) {
		identifier(id, `${kind}Id`)
		this.normalKind(kind)
		const publication = await this.state.get("source-publications", id)
		if (publication?.kind === kind && unresolved(publication)) throw this.publicationError(publication)
		const record = await this.state.get(this.normalKind(kind), id)
		if (!record) {
			try { await fs.lstat(this.blobPath({ kind, id })); throw failure(503, "storage_unavailable", "Protected candidate bytes exist without confirmed metadata.", { state: "indeterminate", inspectionRef: `${kind}/${id}` }) }
			catch (error) { if (error.code !== "ENOENT") throw error }
		}
		if (!record || record.evictedAt) throw expired(kind)
		return record
	}
	async get(kind, id) {
		this.requireAvailable()
		return this.serial("retentionTail", async () => {
			const record = await this.record(kind, id), handle = await this.privateFile(record)
			await handle.close()
			const leases = (await this.state.list("leases")).filter((lease) => lease.source.kind === kind && lease.source.id === id && Date.parse(lease.expiresAt) > Date.now())
			let currentObservation = null, currentRelation = "unknown", currentError
			try {
				currentObservation = observation(record.source.ref, await this.safeFs.stat(record.source.ref.path))
				currentRelation = record.sourceObservation?.token === currentObservation.token ? "same-observation" : "newer-current"
			} catch (error) { if (error.code === "ENOENT" || error.error === "not_found") currentRelation = "missing"; else { currentRelation = "unavailable"; currentError = report(error) } }
			return { source: record.source, availability: "available", leaseExpiresAt: leases.map((lease) => lease.expiresAt).sort().at(-1) || null, currentObservation, currentRelation, ...(currentError ? { currentError } : {}) }
		})
	}
	async open(kind, id) {
		this.requireAvailable()
		return this.serial("retentionTail", async () => {
			const record = await this.record(kind, id), reader = await this.reader(record)
			try { await this.state.put(kinds[kind], id, { ...record, lastAccessAt: now() }); return reader }
			catch (error) { await reader.release(); throw error }
		})
	}
	// Called with retention serialized; the returned reader remains protected until release.
	async reader(record) {
		const handle = await this.privateFile(record), key = `${record.kind}/${record.id}`
		this.readers.set(key, (this.readers.get(key) || 0) + 1)
		let released = false
		return { handle, source: record.source, release: async () => {
			if (released) return; released = true
			try { await handle.close() } finally { const remaining = (this.readers.get(key) || 1) - 1; if (remaining) this.readers.set(key, remaining); else { this.readers.delete(key); if (record.kind === "capture" && record.metadataBytes === VOXEL_CAPTURE_METADATA_BYTES) this.onVoxelInterestReleased?.() } }
		} }
	}
	/** Serialize a short metadata commit with retention. Work must not call retention-lock methods. */
	withRetention(work) {
		this.requireAvailable()
		return this.track(this.serial("retentionTail", async () => { this.requireAvailable(); return work() }), "metadata")
	}
	/** Protect exact retained bytes while building and committing metadata, including source holds.
	 * build(record, reader) returns { metadata: FileState operations, result }.
	 * The reader is scoped to this callback; copying and network work belong outside this lock.
	 */
	withRetentionMetadata(kind, id, build) {
		return this.withRetention(async () => {
			const record = await this.record(kind, id), reader = await this.reader(record)
			try {
				const { metadata = [], result } = await build(record, reader)
				await this.state.transaction([{ type: "put", kind: kinds[kind], id, value: { ...record, lastAccessAt: now() } }, ...metadata])
				return result
			} finally { await reader.release() }
		})
	}
	makeLease(kind, id, ttlSeconds = this.limits.leaseSeconds, leaseId = crypto.randomUUID()) {
		if (kind === "index") throw failure(400, "invalid_source", "Derived indexes share their input capture leases.")
		return { leaseId, source: { kind, id }, expiresAt: new Date(Date.now() + ttlSeconds * 1000).toISOString(), ttlSeconds }
	}
	async lease({ source, leaseId, ttlSeconds } = {}) {
		if (source?.kind === "index") throw failure(400, "invalid_source", "Derived indexes share their input capture leases.")
		this.requireAvailable(); this.normalKind(source?.kind); identifier(source.id, "source id")
		if (leaseId !== undefined) identifier(leaseId, "leaseId")
		const ttl = budget(ttlSeconds, this.limits.leaseSeconds, this.limits.leaseMaxSeconds, "ttlSeconds")
		return this.serial("retentionTail", async () => {
			const record = await this.record(source.kind, source.id), handle = await this.privateFile(record); await handle.close()
			if (leaseId !== undefined) {
				const existing = await this.state.get("leases", leaseId)
				if (!existing) throw failure(404, "not_found", "This lease no longer exists; acquire a new lease for resident bytes.")
				if (stableStringify(existing.source) !== stableStringify(source)) throw failure(409, "lease_id_reused", "A lease cannot rebind to another source.")
			}
			const lease = this.makeLease(source.kind, source.id, ttl, leaseId)
			await this.state.transaction([{ type: "put", kind: "leases", id: lease.leaseId, value: lease }, { type: "put", kind: kinds[source.kind], id: source.id, value: { ...record, lastAccessAt: now() } }])
			return lease
		})
	}
	releaseLease(id) { this.requireAvailable(); identifier(id, "leaseId"); return this.serial("retentionTail", () => this.state.delete("leases", id)) }
	async hold(kind, id, reason, holdId = crypto.randomUUID()) {
		if (kind === "index") throw failure(400, "invalid_source", "Derived indexes share their input capture retention.")
		this.requireAvailable(); this.normalKind(kind); identifier(holdId, "holdId")
		if (typeof reason !== "string" || !reason || reason.length > 256) throw failure(400, "invalid_hold", "A durable hold requires a short reason.")
		return this.serial("retentionTail", async () => {
			const record = await this.record(kind, id), handle = await this.privateFile(record); await handle.close()
			const hold = { holdId, source: { kind, id }, reason, createdAt: now() }
			const existing = await this.state.get("holds", holdId)
			if (existing && (stableStringify(existing.source) !== stableStringify(hold.source) || existing.reason !== reason)) throw failure(409, "hold_id_reused", "A durable hold cannot rebind to another source or reason.")
			if (!existing) await this.state.put("holds", holdId, hold)
			return holdId
		})
	}
	releaseHold(id) { this.requireAvailable(); identifier(id, "holdId"); return this.serial("retentionTail", () => this.state.delete("holds", id)) }
	releaseBoundHolds(bindings) {
		return this.withRetention(async () => {
			const metadata = [], conflicts = []
			for (const binding of bindings) { identifier(binding.holdId, "holdId"); const hold = await this.state.get("holds", binding.holdId); if (!hold) continue; if (hold.reason !== binding.reason || stableStringify(hold.source) !== stableStringify(binding.source)) { conflicts.push(binding.holdId); continue }; metadata.push({ type: "delete", kind: "holds", id: binding.holdId }) }
			await this.state.transaction(metadata); return { released: metadata.length, conflicts }
		})
	}
	async sweep() {
		this.requireAvailable()
		return this.serial("retentionTail", async () => {
			await this.assertPrivateStore()
			const publications = await this.state.list("source-publications")
			const protectedSources = new Set(), expired = [], time = Date.now()
			for (const publication of publications) if (unresolved(publication)) { protectedSources.add(`${publication.kind}/${publication.id}`); if (publication.kind === "index") for (const d of publication.dependencies || this.indexDependencies(publication.metadataOperations?.[0]?.value || {})) protectedSources.add(`capture/${d.id}`) }
			for (const lease of await this.state.list("leases")) {
				if (Date.parse(lease.expiresAt) <= time) expired.push({ type: "delete", kind: "leases", id: lease.leaseId })
				else protectedSources.add(`${lease.source.kind}/${lease.source.id}`)
			}
			for (const hold of await this.state.list("holds")) protectedSources.add(`${hold.source.kind}/${hold.source.id}`)
			for (const [key, count] of this.readers) if (count) { protectedSources.add(key); if (key.startsWith("index/")) { const index = await this.state.get(kinds.index, key.slice(6)); if (index) for (const d of this.indexDependencies(index)) protectedSources.add(`capture/${d.id}`) } }
			await this.state.transaction(expired)
			await this.recoverEvictions()
			const records = await this.retainedRecords()
			const usage = await this.retainedUsage(records, publications)
			let retainedBytes = usage.retainedBytes, evictedBytes = 0, evicted = 0
			const accountedIndexes = new Set()
			for (const record of records.sort((a, b) => a.lastAccessAt.localeCompare(b.lastAccessAt))) {
				if (record.kind === "index") continue // Its input captures are the retention authority.
				if (protectedSources.has(`${record.kind}/${record.id}`)) continue
				const owned = record.kind === "capture" && await this.state.get("voxel-owned-captures", record.id)
				if (owned) { const artifact = await this.state.get("voxel-artifacts", owned.artifactId); if (artifact && !artifact.deletion && artifact.publicationState !== "failed" || (await this.captureBlockers(record.id)).length) continue }
				if (retainedBytes <= this.limits.previewBytes && time - Date.parse(record.lastAccessAt) < this.limits.previewIdleMs) continue
				const tombstone = { ...record, evictedAt: now(), cleanupPending: true }
				await this.state.transaction([{ type: "put", kind: kinds[record.kind], id: record.id, value: tombstone }, ...(owned ? [{ type: "put", kind: "voxel-owned-captures", id: record.id, value: { ...owned, cleanupRequestedAt: owned.cleanupRequestedAt || now() } }] : [])])
				try { await this.finishEviction(tombstone) } catch (error) { if (!owned) throw error; await this.state.put("voxel-owned-captures", record.id, { ...owned, cleanupRequestedAt: owned.cleanupRequestedAt || now(), cleanupIndeterminate: true, cleanupError: report(error) }); continue }
				const bytes = record.sizeBytes + records.filter((index) => index.kind === "index" && !accountedIndexes.has(index.id) && this.indexDependencies(index).some((d) => d.id === record.id)).reduce((sum, index) => { accountedIndexes.add(index.id); return sum + index.sizeBytes + (index.metadataBytes || 0) }, 0)
				retainedBytes -= bytes; evictedBytes += bytes; evicted++
			}
			const garbage = await this.collectOrphanPartials()
			return { evicted, evictedBytes, retainedBytes, unresolvedBytes: usage.unresolvedBytes, overBudget: retainedBytes > this.limits.previewBytes, ...garbage }
		})
	}
	async staging(id, { reservationId, key } = {}) {
		if (!uuidPattern.test(id)) throw failure(400, "invalid_id", "Private staging requires a generated UUID.")
		await this.assertPrivateStore()
		const basename = `${id}.${crypto.randomUUID()}.partial`, name = path.join(this.blobDir, basename)
		this.activeStages.set(basename, null)
		let handle, bound = false
		try {
			handle = await fs.open(this.privatePath(basename), constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW, 0o600)
			const stat = await handle.stat({ bigint: true }), stage = { name, handle }
			this.activeStages.set(basename, { dev: String(stat.dev), ino: String(stat.ino) }); this.stageNames.set(stage, basename)
			if (reservationId) await this.withRetention(async () => {
				const r = await this.state.get("voxel-reservations", reservationId), entry = r?.entries.find((e) => e.key === key && !e.converted && (!e.captureId || e.captureId === id) && !e.staging)
				if (!this.validVoxelReservation(r) || !entry) throw failure(409, "reservation_conflict", "Staging must bind an unused producer reservation entry once.")
				bound = true
				await this.state.put("voxel-reservations", reservationId, { ...r, entries: r.entries.map((e) => e.key === key ? { ...e, captureId: id, staging: { basename, candidate: this.activeStages.get(basename) } } : e) })
			})
			return stage
		} catch (error) { await handle?.close(); if (!bound && this.activeStages.get(basename)) await this.unlinkExpected(basename, this.activeStages.get(basename)); this.activeStages.delete(basename); throw error }
	}
	/** A trusted producer creates an exclusive file at a reserved private staging name. */
	async producerStage(id) {
		const stage = await this.staging(id), basename = this.stageNames.get(stage), candidate = this.activeStages.get(basename)
		await stage.handle.close(); stage.handle = null
		if (!await this.unlinkExpected(basename, candidate)) throw failure(503, "storage_unavailable", "Reserved producer staging identity changed.")
		this.activeStages.set(basename, null)
		return stage
	}
	async adoptProducerStage(stage) {
		const basename = this.stageNames.get(stage), checked = await this.evidence(basename, null, undefined, false)
		if (checked.state === "missing") return false
		if (checked.state !== "match") { stage.preserve = true; throw failure(503, "storage_unavailable", "Trusted producer staging has uncertain ownership or identity.", { state: "indeterminate", inspectionRef: `blobs/${basename}` }) }
		this.activeStages.set(basename, { dev: String(checked.stat.dev), ino: String(checked.stat.ino) })
		stage.handle = await fs.open(this.privatePath(basename), constants.O_RDONLY | constants.O_NOFOLLOW)
		return true
	}
	async write(handle, bytes, position) {
		let offset = 0
		while (offset < bytes.length) { const { bytesWritten } = await handle.write(bytes, offset, bytes.length - offset, position + offset); if (!bytesWritten) throw failure(503, "storage_unavailable", "A private-store write made no progress."); offset += bytesWritten }
	}
	async copy(handle, target, size, task, hash) {
		const buffer = Buffer.alloc(Math.min(64 * 1024, Math.max(1, size))); let position = 0
		while (position < size) {
			if (task?.controller.signal.aborted) throw cancelled()
			const { bytesRead } = await handle.read(buffer, 0, Math.min(buffer.length, size - position), position)
			if (!bytesRead) break
			const bytes = buffer.subarray(0, bytesRead)
			if (target) await this.write(target, bytes, position)
			hash?.update(bytes); position += bytesRead
			if (task) await this.progress(task, target ? "copying" : "hashing", position, size)
			if ((position & ((1024 * 1024) - 1)) === 0) await yieldTurn()
		}
		if (task?.controller.signal.aborted) throw cancelled()
		return position
	}
	async syncDir() { await this.assertPrivateStore(); await this.blobAnchor.sync() }
	async publish(stage, record, { task, hold, reservationId } = {}) {
		return this.serial("retentionTail", async () => {
			if (task?.controller.signal.aborted) throw cancelled()
			await this.assertPrivateStore()
			const records = await this.retainedRecords()
			const { retainedBytes } = await this.retainedUsage(records, await this.state.list("source-publications"))
			const derived = record.kind === "index", reservation = derived && await this.state.get("index-reservations", record.reservationId)
			let voxelReservation, entry, reservationBinding
			if (reservationId) {
				voxelReservation = await this.state.get("voxel-reservations", reservationId)
				entry = voxelReservation?.entries.find((e) => !e.converted && (!e.captureId || e.captureId === record.id) && e.path === record.source.ref.path && e.sha256 === record.source.digest.sha256 && e.sizeBytes === record.sizeBytes)
				if (record.kind !== "capture" || !entry || entry.staging?.basename !== this.stageNames.get(stage) || voxelReservation.workspaceEpoch !== this.state.identity.workspaceEpoch) throw failure(409, "reservation_conflict", "Capture does not match an unused artifact reservation entry and staging identity.")
				record.metadataBytes = entry.metadataBytes
				reservationBinding = { reservationId, artifactId: voxelReservation.artifactId, workspaceEpoch: voxelReservation.workspaceEpoch, key: entry.key, captureId: record.id, sizeBytes: record.sizeBytes, metadataBytes: record.metadataBytes }
			}
			if (derived) {
				await this.validateIndexInputs(record)
				if (!reservation || record.sizeBytes + (record.metadataBytes || 0) > reservation.sizeBytes) throw failure(409, "source_changed", "Index publication exceeds its reserved capacity.")
			}
			if (retainedBytes + record.sizeBytes + (record.metadataBytes || 0) - (reservation?.sizeBytes || 0) - (entry ? entry.sizeBytes + entry.metadataBytes : 0) > this.limits.retainedBytes) throw failure(507, "insufficient_storage", "Retained source bytes reached the deployment ceiling; held or indeterminate bytes cannot be evicted.", { limits: { retainedBytes: this.limits.retainedBytes }, action: "Release unneeded preview leases or resolve retained work before requesting more storage." })
			const lease = derived ? null : this.makeLease(record.kind, record.id), ops = [{ type: "put", kind: kinds[record.kind], id: record.id, value: record }, derived ? { type: "delete", kind: "index-reservations", id: record.reservationId } : { type: "put", kind: "leases", id: lease.leaseId, value: lease }]
			if (entry) ops.push({ type: "put", kind: "voxel-owned-captures", id: record.id, value: reservationBinding }, { type: "put", kind: "voxel-reservations", id: reservationId, value: { ...voxelReservation, entries: voxelReservation.entries.map((e) => e.key === entry.key ? { ...e, captureId: record.id, converted: true } : e) } })
			if (hold) {
				const reason = typeof hold === "string" ? hold : hold.reason, holdId = typeof hold === "object" ? hold.id || hold.holdId || crypto.randomUUID() : crypto.randomUUID()
				identifier(holdId, "holdId")
				if (typeof reason !== "string" || !reason) throw failure(400, "invalid_hold", "A retained source hold requires a reason.")
				if (await this.state.get("holds", holdId)) throw failure(409, "hold_id_reused", "The requested hold identifier already exists.")
				ops.push({ type: "put", kind: "holds", id: holdId, value: { holdId, reason, source: { kind: record.kind, id: record.id }, createdAt: now() } })
				record.initialHoldId = holdId
			}
			let publication
			try {
				await stage.handle.sync(); await stage.handle.chmod(0o400); await stage.handle.sync()
				const stat = await stage.handle.stat({ bigint: true })
				if (stat.nlink !== 1n || Number(stat.uid) !== process.geteuid()) throw failure(503, "capture_store_unavailable", "A protected representation must have no write-through hardlink aliases.")
				if (entry && Number(stat.size) !== entry.sizeBytes) throw failure(409, "reservation_conflict", "Staged bytes exceed the exact artifact reservation.")
				record.sizeBytes = Number(stat.size)
				record.blobObservation = observationToken(stat)
				publication = { id: record.id, kind: record.kind, state: "publishing", source: record.source, sizeBytes: record.sizeBytes, stagingBasename: this.stageNames.get(stage), metadataOperations: ops, lease,
					...(derived ? { dependencies: this.indexDependencies(record) } : {}),
					...(entry ? { reservationId, reservationBinding } : {}),
					candidate: { dev: String(stat.dev), ino: String(stat.ino), mtimeNs: String(stat.mtimeNs) }, jobId: task?.job.jobId || null, createdAt: now(), holdId: record.initialHoldId || null }
				if (!this.validPublication(publication)) throw failure(503, "storage_unavailable", "Source publication intent is incomplete.")
				// A journal acknowledgement can be lost. Once attempted, cleanup must preserve its evidence.
				this.stagePublications.set(stage, publication); stage.preserve = true
				await this.state.put("source-publications", record.id, publication)
				await stage.handle.close(); stage.handle = null
				if (task?.controller.signal.aborted) throw cancelled()
				const blobPath = this.blobPath(record)
				const staged = await this.evidence(publication.stagingBasename, publication.candidate, record.sizeBytes)
				if (staged.state !== "match") throw failure(503, "storage_unavailable", "Private staging identity changed before publication.")
				const final = await this.evidence(`${record.kind}.${record.id}`, publication.candidate, record.sizeBytes)
				if (final.state !== "missing") throw failure(503, "storage_unavailable", "The unique protected publication name is already occupied; both candidates were preserved.")
				await fs.rename(this.privatePath(publication.stagingBasename), blobPath); stage.name = blobPath
				await this.syncDir()
				// Rename can change ctime. Persist the observation of the final protected name.
				record.blobObservation = observationToken(await fs.lstat(blobPath, { bigint: true }))
				await this.state.transaction([...ops, { type: "put", kind: "source-publications", id: record.id, value: { ...publication, state: "committed" } }])
			} catch (error) {
				if (!stage.preserve) throw error
				const mapped = fileError(error, "file-captures.publish")
				throw failure(mapped.status, mapped.error, "Protected publication metadata could not be confirmed; candidate bytes are retained for inspection.", { state: "indeterminate", inspectionRef: publication ? this.inspectionRef(publication) : `${record.kind}/${record.id}`, candidateSource: record.source, cause: report(error) })
			}
			stage.published = true
			return { source: record.source, lease, ...(record.initialHoldId ? { holdId: record.initialHoldId } : {}) }
		})
	}
	async cleanup(stage) {
		if (!stage) return
		const basename = this.stageNames.get(stage), candidate = this.activeStages.get(basename)
		try {
			await stage.handle?.close(); stage.handle = null
			if (!stage.published && !stage.preserve && basename && candidate && !await this.unlinkExpected(basename, candidate)) throw failure(503, "storage_unavailable", "Private cleanup found a different inode; candidate bytes were preserved.", { state: "indeterminate", inspectionRef: `blobs/${basename}` })
		} finally { this.activeStages.delete(basename) }
	}
	async reusable(ref, stat) {
		return this.serial("retentionTail", async () => {
			const token = observationToken(stat)
			const record = (await this.state.list("captures")).find((record) => !record.evictedAt && ["service-published", "remote-conditional"].includes(record.source.consistency) && stableStringify(record.source.ref) === stableStringify(ref) && record.sourceObservation?.token === token)
			if (!record) return null
			const handle = await this.privateFile(record); await handle.close()
			const lease = this.makeLease("capture", record.id)
			await this.state.put("leases", lease.leaseId, lease)
			return { source: record.source, lease, record }
		})
	}
	create(request = {}) { return this.track(this.createRequest(request), "capture") }
	async createRequest({ requestId, path: name, baseObservation, requireCoherentSource = false, computeDigest = false }) {
		this.requireAdmission(); identifier(requestId, "requestId"); name = canonicalPath(name, { root: false })
		if (typeof requireCoherentSource !== "boolean" || typeof computeDigest !== "boolean") throw failure(400, "invalid_request", "Capture options must be boolean.")
		const ref = this.address(name), intent = { type: "capture", path: name, baseObservation: this.baseToken(baseObservation, ref), requireCoherentSource, computeDigest }
		const admitted = await this.serial("admissionTail", async () => {
			this.requireAdmission()
			const existing = await this.state.get("requests", requestId)
			if (!existing && this.queue.length >= this.limits.queueSize) throw failure(429, "capacity", "The capture queue is full.", { retryAfter: 1, limits: { queueSize: this.limits.queueSize }, action: "Retry after an accepted capture reaches a terminal state." })
			const jobId = crypto.randomUUID(), request = { requestId, type: "capture", state: "accepted", jobId, intent, acceptedAt: now(), result: null, error: null }
			const claimed = await this.state.claim("requests", requestId, intent, request)
			if (claimed.duplicate) return { duplicate: claimed.record }
			let handle
			try {
				handle = await this.safeFs.open(name)
				const stat = await this.statFile(handle)
				this.checkBase(baseObservation, ref, stat)
				const reused = await this.reusable(ref, stat), needsHash = reused && computeDigest && reused.source.digest.state !== "ready"
				if (reused && !needsHash) {
					await handle.close(); handle = null
					const result = { status: 201, source: reused.source, lease: reused.lease }
					await this.state.put("requests", requestId, { ...request, state: "succeeded", result, finishedAt: now() })
					return { result }
				}
				const job = { jobId, requestId, type: "capture", state: "queued", stage: "queued", acceptedAt: request.acceptedAt, progress: { bytesDone: 0, totalBytes: Number(stat.size), elapsedMs: 0 }, result: null, error: null }
				request.state = "queued"; request.sourceObservation = observation(ref, stat)
				const ops = [{ type: "put", kind: "requests", id: requestId, value: request }, { type: "put", kind: "jobs", id: jobId, value: job }]
				let hashRecord
				if (needsHash) {
					await handle.close(); handle = null
					job.holdId = `job-${jobId}`; job.source = { kind: "capture", id: reused.record.id }; job.resultRef = reused.record.id
					hashRecord = { ...reused.record, source: { ...reused.source, digest: { state: "pending", sha256: null } } }
					ops.push({ type: "put", kind: "captures", id: hashRecord.id, value: hashRecord }, { type: "put", kind: "holds", id: job.holdId, value: { holdId: job.holdId, source: job.source, reason: "job", jobId, createdAt: now() } })
				}
				await this.state.transaction(ops)
				const task = { job, request, handle, initialStat: stat, ref, baseObservation, requireCoherentSource, computeDigest, controller: new AbortController() }
				if (needsHash) { task.hashSource = hashRecord.id; task.perform = () => this.hashTask(task, hashRecord.id, reused.lease) }
				task.promise = new Promise((resolve, reject) => { task.resolve = resolve; task.reject = reject }); task.promise.catch(() => {})
				const inline = Number(stat.size) <= this.limits.captureInlineBytes && !this.running && !this.queue.length
				this.tasks.set(jobId, task); this.queue.push(task); queueMicrotask(() => this.pump())
				return { task, inline, ...(needsHash ? { source: hashRecord.source, lease: reused.lease } : {}) }
			} catch (error) {
				await handle?.close()
				const errorRecord = report(error)
				await this.state.put("requests", requestId, { ...request, state: "failed", error: errorRecord, finishedAt: now() })
				throw fromReport(errorRecord)
			}
		})
		if (admitted.result) return admitted.result
		if (admitted.duplicate) {
			const record = admitted.duplicate
			if (["failed", "cancelled", "interrupted"].includes(record.state)) throw fromReport(record.error || report(failure(503, "job_interrupted", "This submission did not complete; use a new request ID to retry.")))
			if (record.result) return record.result
			if (terminal.has(record.state)) throw fromReport(record.error || report(failure(503, "job_interrupted", "This submission did not complete; use a new request ID to retry.")))
			return { status: 202, jobId: record.jobId }
		}
		return admitted.inline ? admitted.task.promise : { status: 202, jobId: admitted.task.job.jobId, ...(admitted.source ? { source: admitted.source, lease: admitted.lease } : {}) }
	}
	async pump() {
		if (this.running || !this.queue.length) return
		const task = this.queue.shift(); this.running = task; task.started = Date.now()
		try {
			if (task.controller.signal.aborted) throw cancelled()
			await this.progress(task, task.hashSource ? "hashing" : "copying", 0, task.initialStat ? Number(task.initialStat.size) : null, true)
			const result = await (task.perform ? task.perform() : this.captureTask(task))
			task.result = result
			task.job = { ...task.job, state: "succeeded", stage: "complete", result, resultRef: result.source.captureId, finishedAt: now() }
			const ops = [{ type: "put", kind: "jobs", id: task.job.jobId, value: task.job }]
			if (task.request) { task.request = { ...task.request, state: "succeeded", result, finishedAt: task.job.finishedAt }; ops.push({ type: "put", kind: "requests", id: task.request.requestId, value: task.request }) }
			await this.state.transaction(ops)
			if (task.job.holdId) await this.state.delete("holds", task.job.holdId)
			await this.emit(task.job); task.resolve(result)
		} catch (error) {
			if (task.result) { const mapped = fileError(error, "file-captures.complete-job"); error = failure(mapped.status, mapped.error, "Captured bytes were published but the terminal job receipt could not be confirmed.", { state: "indeterminate", inspectionRef: `capture/${task.result.source.captureId}`, candidateSource: task.result.source, cause: report(error) }) }
			const state = task.controller.signal.aborted && !task.result ? "cancelled" : "failed", errorRecord = report(error)
			task.job = { ...task.job, state, stage: state, result: null, error: errorRecord, finishedAt: now() }
			const ops = [{ type: "put", kind: "jobs", id: task.job.jobId, value: task.job }]
			if (task.request) { task.request = { ...task.request, state, result: null, error: errorRecord, finishedAt: task.job.finishedAt }; ops.push({ type: "put", kind: "requests", id: task.request.requestId, value: task.request }) }
			try { if (task.hashSource) await this.failDigest(task.hashSource, errorRecord); await this.state.transaction(ops); if (task.job.holdId) await this.state.delete("holds", task.job.holdId); await this.emit(task.job) }
			catch (storageError) { task.reject(storageError) }
			task.reject(fromReport(errorRecord))
		} finally {
			try { await task.handle?.close() } catch (error) { task.reject(fileError(error, "file-captures.close-source")) }
			this.tasks.delete(task.job.jobId); this.running = null; queueMicrotask(() => this.pump())
		}
	}
	async emit(job) { await this.onEvent("job", { jobId: job.jobId, state: job.state, stage: job.stage, progress: job.progress, resultRef: job.resultRef || null }) }
	async progress(task, stage, bytesDone, totalBytes, force = false) {
		const time = Date.now()
		if (!force && time - (task.lastProgress || 0) < 250 && bytesDone !== totalBytes) return
		task.lastProgress = time
		task.job = { ...task.job, state: task.controller.signal.aborted ? "cancel_requested" : "running", stage, progress: { bytesDone, totalBytes, elapsedMs: time - task.started } }
		await this.state.put("jobs", task.job.jobId, task.job); await this.emit(task.job)
	}
	async failDigest(id, error) {
		const record = await this.state.get("captures", id)
		if (record?.source.digest.state === "pending") await this.state.put("captures", id, { ...record, source: { ...record.source, digest: { state: "failed", sha256: null } }, digestError: error || report(cancelled()) })
	}
	async hashTask(task, id, lease) {
		const opened = await this.open("capture", id)
		try {
			const hash = crypto.createHash("sha256"), size = opened.source.sizeBytes
			await this.progress(task, "hashing", 0, size, true)
			if (await this.copy(opened.handle, null, size, task, hash) !== size) throw failure(503, "capture_store_unavailable", "A protected source was truncated while hashing.")
			return await this.serial("retentionTail", async () => {
				const record = await this.record("capture", id), source = { ...record.source, digest: { state: "ready", sha256: hash.digest("hex") } }
				await this.state.put("captures", id, { ...record, source, digestError: null, lastAccessAt: now() })
				return { status: 201, source, lease }
			})
		} finally { await opened.release() }
	}
	async captureTask(task) {
		const id = crypto.randomUUID(); let stage
		try {
			for (let attempt = 0; attempt < 3; attempt++) {
				if (task.controller.signal.aborted) throw cancelled()
				const before = await this.statFile(task.handle)
				this.checkBase(task.baseObservation, task.ref, before)
				if (attempt === 0 && observationToken(before) !== observationToken(task.initialStat)) throw failure(409, "source_changed", "The accepted source changed while queued; submit a new capture request.", { currentObservation: observation(task.ref, before) })
				stage = await this.staging(id)
				const cloned = await this.safeFs.clone(task.handle.fd, stage.handle.fd)
				if (cloned !== true && task.requireCoherentSource) throw failure(409, "coherent_source_unavailable", "No matching service-published source or actual atomic reflink is available; checked-copy is not coherent-source support.")
				let hash = task.computeDigest ? crypto.createHash("sha256") : null, size
				if (cloned === true) {
					size = Number((await this.statFile(stage.handle)).size)
					if (hash) {
						const read = await fs.open(stage.name, constants.O_RDONLY | constants.O_NOFOLLOW)
						try { await this.progress(task, "hashing", 0, size, true); if (await this.copy(read, null, size, task, hash) !== size) throw failure(503, "storage_unavailable", "An atomic clone was truncated before hashing.") } finally { await read.close() }
					}
				} else size = await this.copy(task.handle, stage.handle, Number(before.size), task, hash)
				const after = await this.statFile(task.handle)
				let pathStat
				try { pathStat = await this.safeFs.stat(task.ref.path) } catch (error) { if (error.code !== "ENOENT" && error.error !== "not_found") throw error }
				const unchanged = observationToken(before) === observationToken(after) && pathStat && observationToken(after) === observationToken(pathStat)
				if (task.baseObservation && !pathStat) throw failure(409, "source_changed", "The requested workspace address disappeared while capturing.", { currentObservation: null })
				if (task.baseObservation) this.checkBase(task.baseObservation, task.ref, pathStat)
				if (cloned !== true && (!unchanged || size !== Number(before.size))) { await this.cleanup(stage); stage = null; continue }
				const source = { kind: "runtime-capture", ref: task.ref, captureId: id, etag: `"capture-${id}"`, sizeBytes: size, consistency: cloned === true ? "atomic-clone" : "checked-copy", digest: { state: hash ? "ready" : "not-requested", sha256: hash ? hash.digest("hex") : null } }
				const record = { id, kind: "capture", source, sourceObservation: observation(task.ref, before), createdAt: now(), lastAccessAt: now(), sizeBytes: size }
				return { status: 201, ...await this.publish(stage, record, { task }) }
			}
			throw failure(409, "source_changing", "The source changed during all three checked-copy attempts; try a bounded preview or a new capture later.")
		} finally { await this.cleanup(stage) }
	}
	retainStaged(filePath, ref, options = {}) { return this.track(this.retainRequest(filePath, ref, options), "retain") }
	async retainRequest(filePath, ref, options) {
		if (options.reservationId) this.requireAvailable(); else this.requireAdmission()
		const task = await this.serial("admissionTail", async () => {
			if (options.reservationId) this.requireAvailable(); else this.requireAdmission()
			if (this.queue.length >= this.limits.queueSize) throw failure(429, "capacity", "The capture/retention queue is full.", { retryAfter: 1 })
			const jobId = crypto.randomUUID(), task = { controller: new AbortController(), job: { jobId, type: "retain", state: "queued", stage: "queued", acceptedAt: now(), progress: { bytesDone: 0, totalBytes: null, elapsedMs: 0 }, error: null, result: null } }
			task.perform = () => this.retain(filePath, ref, options, task)
			task.promise = new Promise((resolve, reject) => { task.resolve = resolve; task.reject = reject }); task.promise.catch(() => {})
			await this.state.put("jobs", jobId, task.job)
			this.tasks.set(jobId, task); this.queue.push(task); queueMicrotask(() => this.pump())
			return task
		})
		return task.promise
	}
	async retain(filePath, ref, { consistency = "service-published", digest, hold, reservationId } = {}, task) {
		this.requireAvailable()
		if (!path.isAbsolute(filePath) || !["service-published", "remote-conditional", "atomic-clone", "checked-copy"].includes(consistency)) throw failure(400, "invalid_source", "Retained staging needs an absolute path and a supported consistency label.")
		if (stableStringify(this.address(ref.path)) !== stableStringify(ref)) throw failure(400, "invalid_source", "The retained source must bind this workspace epoch.")
		const expectedDigest = typeof digest === "string" ? digest : digest?.sha256
		if (digest !== undefined && !/^[0-9a-f]{64}$/.test(expectedDigest || "")) throw failure(400, "invalid_digest", "Use a lowercase SHA-256 digest for staged-byte verification.")
		const handle = await fs.open(filePath, constants.O_RDONLY | constants.O_NOFOLLOW), id = crypto.randomUUID(); let stage
		try {
			const before = await this.statFile(handle); stage = await this.staging(id, reservationId ? { reservationId, key: "manifest" } : {})
			const hash = digest === undefined ? null : crypto.createHash("sha256"), size = await this.copy(handle, stage.handle, Number(before.size), task, hash)
			if (size !== Number(before.size) || observationToken(before) !== observationToken(await this.statFile(handle))) throw failure(409, "source_changing", "Controlled staging changed while being retained.")
			const sha256 = hash?.digest("hex") || null
			if (expectedDigest && sha256 !== expectedDigest) throw failure(422, "digest_mismatch", "The declared digest does not match retained staging bytes.")
			let sourceObservation = null
			try { const current = await this.safeFs.stat(ref.path); if (sameObject(current, before) && observationToken(current) === observationToken(before)) sourceObservation = observation(ref, current) }
			catch (error) { if (error.code !== "ENOENT" && error.error !== "not_found") throw error }
			const source = { kind: "runtime-capture", ref, captureId: id, etag: `"capture-${id}"`, sizeBytes: size, consistency, digest: { state: hash ? "ready" : "not-requested", sha256 } }
			return await this.publish(stage, { id, kind: "capture", source, sourceObservation, sizeBytes: size, createdAt: now(), lastAccessAt: now() }, { task, hold, reservationId })
		} catch (error) { throw fileError(error, "file-captures.retainStaged") }
		finally { await handle.close(); await this.cleanup(stage) }
	}
	async readPrefix(handle, maxBytes, deadline = Infinity) {
		const buffer = Buffer.alloc(maxBytes); let size = 0
		while (size < maxBytes && Date.now() < deadline) { const { bytesRead } = await handle.read(buffer, size, Math.min(64 * 1024, maxBytes - size), size); if (!bytesRead) break; size += bytesRead }
		return buffer.subarray(0, size)
	}
	async text(kind, id, { maxBytes } = {}) {
		const limit = budget(maxBytes, this.limits.editorBytes, this.limits.editorBytes, "maxBytes"), opened = await this.open(kind, id)
		try {
			const size = kind === "capture" ? opened.source.sizeBytes : opened.source.byteEnd - opened.source.byteStart
			const bytes = await this.readPrefix(opened.handle, Math.min(limit, size)), complete = bytes.length === size && (kind === "capture" || opened.source.sourceEof)
			let decoded
			try { decoded = utf8Prefix(bytes, bytes.length === size && (kind === "capture" || opened.source.sourceEof)) } catch (error) { throw failure(415, "encoding_unavailable", error.message) }
			return { source: opened.source, text: decoded.text, binary: /[\u0000-\u0008\u000b\u000c\u000e-\u001f]/u.test(decoded.text), encoding: "utf-8", byteStart: kind === "fragment" ? opened.source.byteStart : 0, byteEnd: (kind === "fragment" ? opened.source.byteStart : 0) + decoded.byteEnd, complete, truncated: !complete, stable: true, coverage: kind === "fragment" ? "fragment" : complete ? "complete" : "prefix" }
		} finally { await opened.release() }
	}
	async window(work) {
		this.requireAvailable(); this.parser.requireAvailable()
		if (this.windowActive) throw failure(429, "capacity", "A bounded preview/segment read is already active.", { retryAfter: 1, action: "Retry the window after the active reader and parser finish." })
		this.windowActive = true
		try { return await work() } finally { this.windowActive = false }
	}
	preview(request = {}) { return this.track(this.window(() => this.previewRequest(request)), "preview") }
	async previewRequest(request) {
		this.requireAdmission(); this.parser.requireAvailable()
		const name = canonicalPath(request.path, { root: false }), ref = this.address(name), input = this.parser.normalize(request)
		if (input.operation !== "segment" || input.cursor) throw failure(400, "invalid_request", "A first preview starts at the source beginning; use fragment segments for paging and detail.")
		const started = Date.now(), handle = await this.safeFs.open(name), id = crypto.randomUUID(); let stage
		try {
			const before = await this.statFile(handle), beforeObservation = observation(ref, before)
			const buffer = Buffer.alloc(Math.min(input.limits.readBytes, Number(before.size))), position = { offset: 0, ordinal: 1 }; let size = 0, parsed, readEof = Number(before.size) === 0
			stage = await this.staging(id)
			while (size < buffer.length && Date.now() - started < input.limits.timeMs) {
				const { bytesRead } = await handle.read(buffer, size, Math.min(64 * 1024, buffer.length - size), size)
				if (!bytesRead) { readEof = true; break }
				await this.write(stage.handle, buffer.subarray(size, size + bytesRead), size); size += bytesRead
				readEof = size === Number(before.size)
				// Small read blocks provide early rows; complete records alone become displayed evidence.
				parsed = await this.parser.bounded({ bytes: buffer.subarray(0, size), ...input, limits: { ...input.limits, timeMs: Math.max(1, input.limits.timeMs - (Date.now() - started)) }, position, sourceEof: readEof })
				if (parsed.stopReason !== "read-budget" || size === buffer.length) break
			}
			const after = await this.statFile(handle)
			let current
			try { current = await this.safeFs.stat(name) } catch (error) { if (error.code !== "ENOENT" && error.error !== "not_found") throw error }
			const changed = observationToken(before) !== observationToken(after) || !current || observationToken(after) !== observationToken(current)
			const checkedEof = readEof && !changed
			if (!parsed || changed) parsed = Date.now() - started >= input.limits.timeMs ? this.parser.stopped(input, position, size) : await this.parser.bounded({ bytes: buffer.subarray(0, size), ...input, limits: { ...input.limits, timeMs: Math.max(1, input.limits.timeMs - (Date.now() - started)) }, position, sourceEof: checkedEof })
			const retained = ["row-limit", "text-limit", "response-budget"].includes(parsed.stopReason) && parsed.consumedBytes ? parsed.consumedBytes : size
			await stage.handle.truncate(retained)
			const source = { kind: "runtime-fragment", ref, fragmentId: id, etag: `"fragment-${id}"`, byteStart: 0, byteEnd: retained, sourceSizeObserved: Number(before.size), sourceObservation: beforeObservation, sourceMayHaveChanged: Boolean(changed), sourceEof: checkedEof && retained === size, completeSource: false }
			parsed.metrics.bytesRead = size; parsed.metrics.elapsedMs = Date.now() - started
			const result = this.parser.envelope(source, { ...input, position, atFragmentEnd: true }, parsed)
			// Account for the initial lease/coverage in the actual browser response budget.
			const previewLease = this.makeLease("fragment", id)
			const response = { ...result, lease: previewLease, coverage: "fragment" }
			this.parser.responseSize(response)
			if (response.metrics.responseBytes > input.limits.responseBytes) throw failure(400, "invalid_budget", "responseBytes cannot fit the fragment, lease and selected window.")
			const retainedSource = await this.publish(stage, { id, kind: "fragment", source, sourceObservation: beforeObservation, sizeBytes: retained, createdAt: now(), lastAccessAt: now() })
			response.lease = retainedSource.lease; this.parser.responseSize(response)
			return response
		} catch (error) { throw fileError(error, "file-captures.preview") }
		finally { await handle.close(); await this.cleanup(stage) }
	}
	segments(kind, id, request = {}) { return this.track(this.window(() => this.segmentRequest(kind, id, request)), "preview") }
	async segmentRequest(kind, id, request) {
		this.requireAvailable(); this.parser.requireAvailable()
		const input = this.parser.normalize(request), opened = await this.open(kind, id), started = Date.now()
		try {
			const position = this.parser.position(opened.source, input), size = kind === "capture" ? opened.source.sizeBytes : opened.source.byteEnd - opened.source.byteStart
			const buffer = Buffer.alloc(Math.min(input.limits.readBytes, size - position.offset)); let read = 0
			while (read < buffer.length && Date.now() - started < input.limits.timeMs) { const { bytesRead } = await opened.handle.read(buffer, read, Math.min(64 * 1024, buffer.length - read), position.offset + read); if (!bytesRead) throw failure(503, "capture_store_unavailable", "Protected bytes were truncated during a held segment read."); read += bytesRead }
			const atEnd = read + position.offset === size, sourceEof = atEnd && (kind === "capture" || opened.source.sourceEof)
			const parsed = Date.now() - started >= input.limits.timeMs ? this.parser.stopped(input, position, read) : await this.parser.bounded({ bytes: buffer.subarray(0, read), ...input, limits: { ...input.limits, timeMs: Math.max(1, input.limits.timeMs - (Date.now() - started)) }, position, sourceEof })
			parsed.metrics.bytesRead = read; parsed.metrics.elapsedMs = Date.now() - started
			return this.parser.envelope(opened.source, { ...input, position, atFragmentEnd: kind === "fragment" && atEnd }, parsed)
		} finally { await opened.release() }
	}
	async getRequest(id) { identifier(id, "requestId"); const record = await this.state.get("requests", id); if (!record) throw failure(404, "not_found", "No capture request has this identifier."); return record }
	async getJob(id) { identifier(id, "jobId"); const record = await this.state.get("jobs", id); if (!record) throw failure(404, "not_found", "No job has this identifier."); return record }
	async cancelJob(id) {
		const job = await this.getJob(id)
		if (terminal.has(job.state)) return job
		const task = this.tasks.get(id)
		if (!task) return job
		if (terminal.has(task.job.state)) return task.job
		task.controller.abort()
		task.job = { ...task.job, state: "cancel_requested", cancelRequestedAt: now() }
		await this.state.put("jobs", id, task.job); await this.emit(task.job)
		return task.job
	}
	async drain(deadline = new Date(Date.now() + 30000).toISOString()) {
		this.draining = true
		const end = typeof deadline === "number" ? deadline : Date.parse(deadline)
		if (!Number.isFinite(end)) throw failure(400, "invalid_request", "A drain deadline must be a timestamp.")
		let timer
		try { await Promise.race([Promise.allSettled([...this.operations, ...[...this.tasks.values()].map((task) => task.promise)]), new Promise((resolve) => { timer = setTimeout(resolve, Math.max(0, end - Date.now())) })]) } finally { clearTimeout(timer) }
		const jobs = (await this.state.list("jobs")).filter((job) => ["capture", "retain"].includes(job.type))
		const pendingJobs = jobs.filter((job) => !terminal.has(job.state)), knownJobs = new Set(jobs.map((job) => job.jobId))
		const accepting = (await this.state.list("requests")).filter((request) => request.type === "capture" && !terminal.has(request.state) && !knownJobs.has(request.jobId)).length
		const standalone = [...this.operationKinds.values()].filter((kind) => ["preview", "metadata"].includes(kind)).length
		const retaining = Math.max(pendingJobs.filter((job) => job.type === "retain").length, [...this.operationKinds.values()].filter((kind) => kind === "retain").length)
		const localPending = pendingJobs.filter((job) => job.type === "capture").length + accepting + retaining + standalone
		const publications = (await this.state.list("source-publications")).filter(unresolved), publicationJobs = new Set(publications.map((pub) => pub.jobId).filter(Boolean))
		const indeterminate = publications.length + jobs.filter((job) => job.error?.state === "indeterminate" && !publicationJobs.has(job.jobId)).length
		return { localPending, remotePending: 0, failed: jobs.filter((job) => ["failed", "interrupted"].includes(job.state)).length, indeterminate, complete: localPending === 0 && indeterminate === 0 }
	}
	close() {
		if (this.closing) return this.closing
		this.draining = true
		this.closing = (async () => {
			await this.admissionTail
			for (const task of this.tasks.values()) task.controller.abort()
			await Promise.allSettled([...this.operations, ...[...this.tasks.values()].map((task) => task.promise)])
			await this.parser.close(); await this.blobAnchor?.close(); await this.storeAnchor?.close(); this.closed = true
		})()
		return this.closing
	}
}
