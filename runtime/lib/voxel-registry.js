import crypto from "node:crypto"
import { identifier } from "./file-contract.js"
import { fail, strict } from "./voxel-request.js"
const now = () => new Date().toISOString()
const put = (kind, id, value) => ({ type: "put", kind, id, value })
const del = (kind, id) => ({ type: "delete", kind, id })
/** Registry identity is independent of paths; a version's bytes live as long as a workspace file holds its manifest. */
export class VoxelRegistry {
	constructor(service) { this.service = service; this.state = service.state; this.captures = service.captures }
	async get(id) { identifier(id, "artifactId"); const artifact = await this.state.get("voxel-artifacts", id); if (!artifact) throw fail(404, "artifact_not_found", "No artifact has this ID in the current workspace epoch."); return artifact }
	availability(a) { return { state: a.deletion ? "deleted" : a.recoveryPending ? "recovery-pending" : a.publicationState !== "ready" ? a.publicationState : a.verificationState, publicationState: a.publicationState, verificationState: a.verificationState, retryAt: a.retryAt || null, error: a.verificationError || null } }
	async inspect(a) {
		const owned = (await this.state.list("voxel-owned-captures")).filter((e) => e.artifactId === a.artifactId && !e.reclaimedAt), reservation = a.reservationId && await this.state.get("voxel-reservations", a.reservationId)
		let reservedBytes = 0
		for (const e of (reservation?.entries || []).filter((e) => !e.converted)) reservedBytes += Math.max(e.sizeBytes, e.captureId && this.captures.availability.state === "available" ? await this.captures.voxelPhysicalBytes(e.captureId) : 0) + e.metadataBytes
		const deletion = a.deletion && await this.state.get("voxel-deletions", a.deletion.id), blockers = new Set(deletion?.blockers || [])
		if (a.publicationState === "unresolved") blockers.add("publicationReconciliation")
		if (a.recoveryPending) blockers.add("publicationRecovery")
		if (reservation?.entries.some((e) => e.cleanupState === "indeterminate")) blockers.add("stagingCleanupReconciliation")
		if (owned.some((e) => e.cleanupIndeterminate)) blockers.add("unknownBytes")
		let ownedBytes = 0, cleanupPendingBytes = deletion?.cleanupPending ? reservedBytes : 0
		for (const e of owned) { const bytes = Math.max(e.sizeBytes, this.captures.availability.state === "available" ? await this.captures.voxelPhysicalBytes(e.captureId) : 0) + e.metadataBytes; ownedBytes += bytes; if (e.cleanupRequestedAt || deletion?.cleanupPending) cleanupPendingBytes += bytes }
		return { artifactId: a.artifactId, generation: a.manifest.generation, createdUtc: a.createdUtc, operationId: a.operationId, link: a.link, publicationState: a.publicationState, verificationState: a.verificationState, availability: this.availability(a), deletion: deletion || null, ownedBytes, reservedBytes, cleanupPendingBytes, reclaimedStagingBytes: reservation?.reclaimedStagingBytes || 0, retentionBlockers: [...blockers] }
	}
	async inventory(params = {}) {
		if (Object.keys(params).some((k) => !["cursor", "limit"].includes(k))) throw fail(400, "invalid_parameter", "Artifact inventory accepts cursor and limit only.")
		const limit = params.limit === undefined ? 50 : Number(params.limit)
		if (!Number.isSafeInteger(limit) || limit < 1 || limit > 100 || typeof params.limit === "string" && !/^[1-9][0-9]*$/.test(params.limit)) throw fail(400, "invalid_parameter", "Use an integer limit from 1 to 100.")
		let after = ""
		if (params.cursor !== undefined) try { if (typeof params.cursor !== "string" || !/^[A-Za-z0-9_-]{1,512}$/.test(params.cursor)) throw new Error(); const cursor = JSON.parse(Buffer.from(params.cursor, "base64url").toString("utf8")); strict(cursor, ["workspaceEpoch", "after"], "Artifact cursor"); if (cursor.workspaceEpoch !== this.state.identity.workspaceEpoch) throw new Error(); identifier(cursor.after); after = cursor.after } catch { throw fail(400, "invalid_parameter", "Artifact cursor must bind this workspace epoch and artifact ID.") }
		const records = (await this.state.list("voxel-artifacts")).filter((a) => a.artifactId > after).sort((a, b) => a.artifactId < b.artifactId ? -1 : 1), page = records.slice(0, limit)
		return { artifacts: await Promise.all(page.map((a) => this.inspect(a))), nextCursor: records.length > limit ? Buffer.from(JSON.stringify({ workspaceEpoch: this.state.identity.workspaceEpoch, after: page.at(-1).artifactId })).toString("base64url") : null }
	}
	delete(id, input, requester = { transport: "authenticated-runtime" }) {
		return this.service.track(this.service.serial(async () => {
			this.service.requireAdmission(); strict(input, ["generation", "idempotencyKey"], "Artifact deletion"); identifier(input.idempotencyKey, "idempotencyKey")
			if (typeof input.generation !== "string" || !input.generation || input.generation.length > 64) throw fail(400, "invalid_request", "Artifact generation must contain 1–64 UTF-16 units.")
			const result = await this.captures.withRetention(() => this.state.voxelArtifactDelete({ id, generation: input.generation, key: input.idempotencyKey, requester }))
			this.service.dropVerification(id)
			try { this.service.workspace.events?.publish("invalidation", { changes: [], namedIds: result.namedIds, artifactId: id, reason: "artifact-deleted" }) } catch (error) { this.service.workspace.logger.error?.("voxel deletion notification failed", { artifactId: id, error: error.message }) }
			await this.cleanupOne(await this.get(id)); const deletion = await this.state.get("voxel-deletions", result.deletion.id)
			return { status: deletion.cleanupPending ? 202 : 200, deletion }
		}))
	}
	async cleanupOne(a) {
		a = await this.get(a.artifactId)
		if (!a.deletion) return
		let receipt = await this.state.get("voxel-deletions", a.deletion.id)
		if (!receipt?.cleanupPending) return
		// Accepted work is not cancelled. Keep reservations and real effects until
		// its publisher/verification settles, then resume without a client retry.
		const active = this.service.tasks.has(a.operationId) || [...this.service.verifications.values()].some((v) => v.artifactId === a.artifactId && v.active)
		if (active || a.recoveryPending) { await this.state.put("voxel-deletions", receipt.id, { ...receipt, blockers: [a.recoveryPending ? "publicationRecovery" : this.service.tasks.has(a.operationId) ? "publication" : "reader"], indeterminate: false }); return }
		const evidence = await this.service.publicationEvidence(a)
		if (evidence.uncertain) { await this.state.put("voxel-deletions", receipt.id, { ...receipt, blockers: ["publicationReconciliation"], indeterminate: true }); return }
		if (evidence.committed) {
			const source = evidence.upload.publishedSource
			a = { ...a, state: "ready", publicationState: "ready", recoveryPending: false, link: { artifactId: a.artifactId, generation: a.manifest.generation, manifest: { root: "workspace", resourceId: source.ref.path, path: source.ref.path, revision: `capture:${source.captureId}`, sha256: source.digest.sha256 } } }
			await this.state.put("voxel-artifacts", a.artifactId, a)
		} else if (["staging", "publishing", "unresolved"].includes(a.publicationState)) { a = { ...a, state: "failed", publicationState: "failed", recoveryPending: false }; await this.state.put("voxel-artifacts", a.artifactId, a) }
		const blockers = []
		await this.captures.withRetention(async () => {
			const operations = [], op = await this.state.get("voxel-operations", a.operationId)
			if (op?.holdId && ["ready", "failed"].includes(op.phase)) { const hold = await this.state.get("holds", op.holdId); if (hold?.reason === "voxel-operation" && hold.source.kind === "capture" && `capture:${hold.source.id}` === op.sourceRevisions?.[0]?.revision) operations.push(del("holds", op.holdId)) }
			for (const [holdId, captureId] of [...Object.values(a.members).map((m) => [m.holdId, m.source.revision.slice(8)]), [a.manifestHoldId, evidence.committed ? evidence.upload.publishedSource.captureId : a.link?.manifest.revision.slice(8)]]) { const hold = await this.state.get("holds", holdId); if (hold?.reason === "voxel-artifact" && hold.source.kind === "capture" && hold.source.id === captureId) operations.push(del("holds", holdId)) }
			const upload = evidence.upload
			if (this.service.ownsUpload(a, upload) && ["committed", "failed", "aborted-before-publication"].includes(upload.state)) {
				const independent = upload.reconciliation?.required || upload.publishedSource && !this.service.matchingSource(a, upload.publishedSource) || ["queued", "running", "accepted", "pending"].includes(upload.processing?.state)
				const persistence = upload.publishedSource ? await this.service.persistenceInterest(upload) : { needed: false }
				if (independent) blockers.push("uploadRecovery")
				if (persistence.needed) blockers.push(persistence.blocker)
				if (!independent && !persistence.needed) { const hold = upload.evidenceHoldId && await this.state.get("holds", upload.evidenceHoldId); if (hold?.reason === `receipt:${a.uploadId}` && hold.source.id === upload.publishedSource?.captureId && hold.source.kind === "capture") operations.push(del("holds", hold.holdId)); operations.push(put("operations", a.uploadId, { ...upload, supersededBy: { kind: "voxel-artifact-deletion", id: receipt.id, artifactId: a.artifactId, generation: a.manifest.generation }, sourceRetention: { ...upload.sourceRetention, supersededBy: receipt.id } })) }
			}
			await this.state.transaction([...operations, put("voxel-deletions", receipt.id, { ...receipt, holdsReleased: !blockers.length, holdReleaseUtc: receipt.holdReleaseUtc || now() })])
		})
		await this.service.reconcileReservation(a)
		const owned = (await this.state.list("voxel-owned-captures")).filter((e) => e.artifactId === a.artifactId), results = await this.captures.cleanupVoxelCaptures(owned.map((e) => e.captureId))
		for (const r of results) blockers.push(...r.blockers)
		const reservation = await this.state.get("voxel-reservations", a.reservationId)
		if (reservation?.entries.some((e) => !e.converted)) blockers.push(reservation.entries.some((e) => e.cleanupState === "indeterminate") ? "stagingCleanupReconciliation" : "publicationReconciliation")
		receipt = await this.state.get("voxel-deletions", receipt.id)
		await this.state.put("voxel-deletions", receipt.id, { ...receipt, cleanupPending: blockers.length > 0, blockers: [...new Set(blockers)], indeterminate: results.some((r) => r.indeterminate) || blockers.includes("publicationReconciliation") || blockers.includes("stagingCleanupReconciliation") || blockers.includes("persistenceEvidence"), reclaimedBytes: results.filter((r) => r.reclaimed).reduce((sum, r) => sum + r.bytes, 0), updatedUtc: now() })
	}
	// A version is released one recovery window after the last workspace file with its
	// exact manifest bytes disappears: deleted files stay restorable for that long, and
	// a shell rm or folder delete counts the same as a file delete. Absence is read from
	// the file index only while it is settled, and a version is released only if no pass
	// has run or been scheduled since that read; any doubt changes nothing.
	async releaseUnreferenced() {
		const versions = (await this.state.list("voxel-artifacts")).filter((a) => a.link && !a.deletion && a.publicationState === "ready")
		const index = this.service.workspace.index, generation = index?.settledGeneration() ?? null
		const held = versions.length && generation !== null ? await this.heldManifests() : null
		if (!held) return
		const window = this.service.workspace.limits.trashMs, stamp = Date.now()
		for (const a of versions) {
			const since = a.unreferencedSince ? Date.parse(a.unreferencedSince) : null
			if (held.has(a.link.manifest.sha256)) { if (since !== null) await this.markUnreferenced(a.artifactId, null) }
			else if (since === null) await this.markUnreferenced(a.artifactId, new Date(stamp).toISOString())
			else if (stamp - since >= window && index.settledGeneration() === generation) await this.delete(a.artifactId, { generation: a.manifest.generation, idempotencyKey: `unreferenced:${a.artifactId}` }, { transport: "manifest-file-removed" })
		}
	}
	markUnreferenced(id, unreferencedSince) {
		return this.service.serial(async () => { const current = await this.get(id); if (!current.deletion) await this.state.put("voxel-artifacts", id, { ...current, unreferencedSince }) })
	}
	async heldManifests() {
		const files = this.service.workspace.index?.listedFiles(".voxel.json")
		if (!files) return null
		const held = new Set(), digests = this.manifestDigests ||= new Map()
		for (const file of files) {
			if (file.availability !== "local") return null
			if (file.sizeBytes > this.service.limits.memberBytes) continue
			let known = digests.get(file.path)
			if (known?.token !== file.observation.token) {
				try {
					const opened = await this.service.workspace.openLive(file.path)
					try { known = { token: opened.observation.token, sha256: crypto.createHash("sha256").update(await this.captures.readPrefix(opened.handle, Number(opened.stat.size))).digest("hex") } } finally { await opened.handle.close() }
				} catch (error) { if (error?.code === "ENOENT" || error?.error === "not_found") continue; return null }
				digests.set(file.path, known)
			}
			held.add(known.sha256)
		}
		const listed = new Set(files.map((file) => file.path))
		for (const path of digests.keys()) if (!listed.has(path)) digests.delete(path)
		return held
	}
	async cleanup() { await this.service.reconcilePublications(); for (const a of await this.state.list("voxel-artifacts")) { if (a.deletion) await this.cleanupOne(a); else if (a.publicationState === "failed") await this.service.reconcileReservation(a) }; return this.service.storageUsage() }
}
