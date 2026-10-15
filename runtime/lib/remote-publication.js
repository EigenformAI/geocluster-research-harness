import crypto from "node:crypto"
import { constants, fchmod } from "node:fs"
import fs from "node:fs/promises"
import path from "node:path"
import { promisify } from "node:util"
import { noPersistence, objectIdentity, observation, sameObject, stableStringify } from "./file-contract.js"
import { cloudError, headEntry, historicalReceipt, pathKey, put, sameOwner, stableId } from "./cloud-file-contract.js"

const chmod = promisify(fchmod), missing = (e) => e.code === "ENOENT" || e.error === "not_found"
const now = () => new Date().toISOString()
const generation = (op) => op?.localGeneration || null

/** SafeFs owns namespace effects; SQLite owns prepared effects, sequence fences and receipts. */
export class RemotePublication {
	constructor(workspace) { this.workspace = workspace; this.state = workspace.state; this.inflight = new Map() }
	serial(operationId, work) {
		const result = (this.inflight.get(operationId) || Promise.resolve()).then(work), tail = result.catch(() => {})
		this.inflight.set(operationId, tail)
		tail.finally(() => { if (this.inflight.get(operationId) === tail) this.inflight.delete(operationId) })
		return result
	}
	async baseline(name) { return this.state.get("cloud-heads", pathKey(name)) }
	async directoryInventory(name) {
		const inventory = {}; let count = 0
		for await (const entry of this.workspace.safeFs.entries(name)) {
			if (!entry.name || ++count > this.workspace.limits.subtreeEntries) throw cloudError(409, "directory_inventory_unavailable")
			const child = `${name}/${entry.name}`, stat = await this.workspace.safeFs.stat(child, { allowSymlink: true })
			inventory[entry.name] = observation(this.workspace.ref(child), stat).token
		}
		return inventory
	}
	async captureDirectories(paths) {
		const evidence = {}
		for (const name of new Set(paths.flatMap((value) => value.split("/").slice(0, -1).map((_, i, parts) => parts.slice(0, i + 1).join("/"))))) {
			const baseline = await this.baseline(name)
			if (baseline?.kind !== "directory") continue
			const stat = await this.workspace.safeFs.stat(name), token = observation(this.workspace.ref(name), stat).token
			if (token !== baseline.observation) continue
			evidence[name] = { token, headToken: baseline.headToken, identity: objectIdentity(stat), mode: String(stat.mode), inventory: await this.directoryInventory(name) }
		}
		return evidence
	}
	async directoryMetadata(evidence = {}, paths) {
		const metadata = []
		for (const [name, before] of Object.entries(evidence)) {
			const baseline = await this.baseline(name)
			if (baseline?.kind !== "directory" || baseline.headToken !== before.headToken || baseline.observation !== before.token) continue
			let stat; try { stat = await this.workspace.safeFs.stat(name) } catch (e) { if (missing(e)) continue; throw e }
			if (!stat.isDirectory() || !sameObject(stat, before.identity) || String(stat.mode) !== before.mode) continue
			const inventory = await this.directoryInventory(name), affected = new Set(paths.filter((p) => p.startsWith(`${name}/`)).map((p) => p.slice(name.length + 1).split("/")[0]))
			if ([...new Set([...Object.keys(inventory), ...Object.keys(before.inventory)])].some((child) => !affected.has(child) && inventory[child] !== before.inventory[child])) continue
			metadata.push(put("cloud-heads", pathKey(name), { ...baseline, observation: observation(this.workspace.ref(name), stat).token, directoryInventory: inventory }))
		}
		return metadata
	}
	async local(name) {
		const records = (await this.state.list("operations")).filter((op) => ["committed", "indeterminate"].includes(op.state) && op.addresses?.some((ref) => ref.path === name))
		records.sort((a, b) => (a.committedAt || a.acceptedAt).localeCompare(b.committedAt || b.acceptedAt))
		let stat = null
		try { stat = await this.workspace.safeFs.stat(name) } catch (e) { if (!missing(e)) throw e }
		const baseline = await this.baseline(name), current = stat ? observation(this.workspace.ref(name), stat) : null
		return { generation: generation(records.at(-1)) || (baseline && baseline.observation === (current?.token || null) ? baseline.localGeneration : null), observation: current, stat, baseline, operation: records.at(-1) || null }
	}
	async rehome(op, claim) {
		const ws = this.workspace
		return ws.captures.withRetention(async () => {
			let source = op.publishedSource, reader
			try {
				if (source) {
					try { reader = await ws.captures.reader(await ws.captures.record("capture", source.captureId)) }
					catch (e) { if (!["capture_expired", "transfer_source_missing"].includes(e.error)) throw e; source = null }
				}
				return await ws.locks.run(async () => {
					const previous = await this.state.get("operations", op.operationId)
					if (claim.recovery !== "rehydrate" || !previous || !sameOwner(previous.claim, op.claim) || sameOwner(previous.claim, claim) || previous.state !== "committed") throw cloudError(409, "receipt_owner_mismatch")
					if (claim.processingReceipt?.state === "historical") {
						const history = historicalReceipt(claim.processingReceipt, claim)
						if (previous.processing?.state === "historical" ? stableStringify(previous.processing) !== stableStringify(history) : !sameOwner(previous.claim, history.previousOwner)) throw cloudError(409, "historical_processing_unresolved")
					} else if (claim.processingReceipt?.state !== "skipped" || previous.processing?.state !== "skipped" || claim.processingPermit || previous.processingPermit || claim.processingReceipt.reason !== previous.processing.reason) throw cloudError(409, "receipt_owner_mismatch")
					const bases = {}, paths = previous.intent.entries.map((entry) => entry.path)
					for (const name of paths) { const local = await this.local(name); bases[name] = { generation: local.generation, observation: local.observation?.token || null } }
					await this.check(previous.intent.entries, bases, previous.intent)
					const holdId = `import-source:${stableId(`${previous.operationId}:${claim.runtimeId}`)}`, metadata = []
					if (source) {
						if (previous.publishedSource?.captureId !== source.captureId || stableStringify(reader.source) !== stableStringify(source)) throw cloudError(409, "source_substitution")
						const hold = await this.state.get("holds", holdId)
						if (hold && (hold.source?.kind !== "capture" || hold.source.id !== source.captureId || hold.reason !== "cloud-import")) throw cloudError(409, "hold_id_reused")
						metadata.push(put("holds", holdId, hold || { holdId, source: { kind: "capture", id: source.captureId }, reason: "cloud-import", createdAt: now() }))
					}
					const next = { ...previous, claim: this.claimMetadata(claim), bases, directoryBefore: await this.captureDirectories(paths), state: source ? "staged" : "accepted", localGeneration: stableId(`${previous.operationId}:${claim.runtimeId}`), publishedSource: source, publishedObservation: null, evidenceHoldId: source ? holdId : null, processing: null, processingAdmission: null, publicationPermit: null, processingPermit: null, publicationPermitIntent: false, processingPermitIntent: false, effectApplied: false, evidence: null, recovery: [], committedAt: null, persistence: noPersistence(), reconciliation: { required: false, inspectionRef: null, replayAllowed: false } }
					// The replacement is resumable as soon as it becomes visible: source hold,
					// complete validated bases, and predecessor archive share this transaction.
					await this.state.transaction([put("cloud-operation-history", stableId(`${previous.operationId}:${previous.claim.runtimeId}`), previous), put("operations", next.operationId, next), ...metadata])
					return next
				})
			} finally { await reader?.release() }
		})
	}
	async check(entries, bases, { applyNow = false, discardLocal = false } = {}) {
		for (const entry of entries) {
			this.workspace.safeFs.policy.assertWrite(entry.path, { subtree: entry.kind !== "file" })
			const local = await this.local(entry.path), base = bases[entry.path]
			if (local.baseline?.changeSeq > entry.changeSeq || local.baseline?.changeSeq === entry.changeSeq && local.baseline.headToken !== entry.headToken) throw cloudError(409, "remote_superseded")
			if (local.operation?.state === "indeterminate" || local.generation !== base.generation || (local.observation?.token || null) !== base.observation) throw cloudError(409, "source_changed")
			if (!discardLocal && local.stat && (!local.baseline || local.baseline.observation !== local.observation.token)) throw cloudError(409, "source_changed")
			if (local.stat?.isDirectory() && (entry.kind === "tombstone" || entries.length === 2)) {
				const handle = await this.workspace.safeFs.open(entry.path, { directory: true }), listing = await fs.opendir(`/proc/self/fd/${handle.fd}`)
				try { if (await listing.read()) throw cloudError(409, "directory_not_empty") } finally { await listing.close(); await handle.close() }
			}
			// New addresses have no active writer to displace. Existing addresses require known idle.
			if (local.stat && local.baseline?.headToken !== entry.headToken && !applyNow && (await this.workspace.config.writerRegistry?.status(this.workspace.ref(entry.path)))?.state !== "idle") throw cloudError(409, "waiting_local_writer")
		}
	}
	async prepare(change, bytes, baseLocalGeneration) {
		const ws = this.workspace, entries = (change.entries || []).map(headEntry)
		if (!entries.length || entries.length > 2 || new Set(entries.map((e) => e.path)).size !== entries.length) throw cloudError(422, "invalid_remote_change")
		if (entries.length === 2 && (entries.filter((e) => e.kind === "tombstone").length !== 1 || entries.some((e) => e.changeSeq !== entries[0].changeSeq))) throw cloudError(422, "invalid_atomic_move")
		const intent = { action: "apply-remote", entries, processingPolicy: "skip", workId: change.claim?.workId || null, source: change.claim ? { fileVersionId: change.claim.source.fileVersionId, objectIdentity: change.claim.source.objectIdentity, sizeBytes: change.claim.source.sizeBytes, sha256: change.claim.source.sha256 } : null, applyNow: change.applyNow === true, discardLocal: change.discardLocal === true }
		let op = await this.state.get("operations", change.operationId)
		if (op) {
			if (stableStringify(op.intent) !== stableStringify(intent)) throw cloudError(409, "operation_id_reused")
			if (["publishing", "indeterminate"].includes(op.state)) throw cloudError(503, "operation_indeterminate")
			if (op.state === "committed" || op.publishedSource || entries.every((e) => e.kind !== "file")) return op
		} else {
			await ws.locks.run(async () => {
				ws.requireMutation()
				const bases = {}
				for (const entry of entries) { const local = await this.local(entry.path); bases[entry.path] = { generation: local.generation, observation: local.observation?.token || null } }
				await this.check(entries, bases, change)
				if (baseLocalGeneration !== undefined && bases[change.path || entries[0].path].generation !== baseLocalGeneration) throw cloudError(409, "source_changed")
				op = (await this.state.claim("operations", change.operationId, intent, { operationId: change.operationId, action: "apply-remote", intent, addresses: entries.map((e) => ws.ref(e.path)), bases, directoryBefore: await this.captureDirectories(entries.map((e) => e.path)), state: "accepted", acceptedAt: now(), committedAt: null, publishedSource: null, publishedObservation: null, reconciliation: { required: false, inspectionRef: null, replayAllowed: false }, persistence: noPersistence(), localGeneration: stableId(change.operationId), receiptId: `import-receipt:${stableId(change.operationId)}`, claim: change.claim ? this.claimMetadata(change.claim) : null })).record
			})
		}
		const file = entries.find((e) => e.kind === "file")
		if (file && entries.length === 1 && !op.publishedSource) {
			const held = await this.state.get("holds", `import-source:${stableId(op.operationId)}`)
			if (held) {
				const record = await ws.captures.record("capture", held.source.id), handle = await ws.captures.privateFile(record)
				await handle.close()
				if (record.source.ref.path !== file.path || record.source.digest?.sha256 !== file.sha256 || record.source.sizeBytes !== file.sizeBytes) throw cloudError(409, "source_substitution")
				op.publishedSource = record.source; op.evidenceHoldId = held.holdId; op.sizeBytes = file.sizeBytes; op.state = "staged"
				await this.state.put("operations", op.operationId, op); return op
			}
			if (!bytes) throw cloudError(503, "exact_source_missing")
			const stagingName = crypto.randomUUID(), stagingPath = path.join(ws.storeDir, "staging", stagingName)
			let handle
			try {
				handle = await fs.open(stagingPath, constants.O_RDWR | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW, 0o600)
				await this.state.put("operations", op.operationId, { ...op, stagingName, state: "streaming" })
				let size = 0; const hash = crypto.createHash("sha256")
				for await (const chunk of bytes) {
					const buffer = Buffer.from(chunk); if (size + buffer.length > file.sizeBytes || size + buffer.length > ws.limits.uploadBytes) throw cloudError(422, "size_mismatch")
					hash.update(buffer); let at = 0
					while (at < buffer.length) { const result = await handle.write(buffer, at, buffer.length - at, size + at); if (!result.bytesWritten) throw cloudError(503, "storage_unavailable"); at += result.bytesWritten }
					size += buffer.length; await change.onProgress?.(size)
				}
				if (size !== file.sizeBytes) throw cloudError(422, "size_mismatch")
				if (hash.digest("hex") !== file.sha256) throw cloudError(422, "digest_mismatch")
				await handle.sync(); await handle.close(); handle = null
				const retained = await ws.captures.retainStaged(stagingPath, ws.ref(file.path), { consistency: "remote-conditional", digest: file.sha256, hold: { id: `import-source:${stableId(op.operationId)}`, reason: "cloud-import" } })
				op.publishedSource = retained.source; op.evidenceHoldId = retained.holdId; op.sizeBytes = size
				op.state = "staged"; await this.state.put("operations", op.operationId, op)
			} finally { await handle?.close(); await fs.unlink(stagingPath).catch((e) => { if (!missing(e)) throw e }) }
		}
		return op
	}
	claimMetadata(claim) {
		// Download capabilities are refreshable transport, not part of the durable source identity.
		const { url, requiredHeaders, expiresAt, ...source } = claim.source
		return { ...claim, source }
	}
	async parents(name) {
		const parts = name.split("/").slice(0, -1)
		for (let i = 1; i <= parts.length; i++) {
			const child = parts.slice(0, i).join("/")
			try { const h = await this.workspace.safeFs.open(child, { directory: true }); await h.close() }
			catch (e) { if (!missing(e)) throw e; const p = await this.workspace.safeFs.parent(child); try { await this.workspace.safeFs.mkdir(p.handle, p.name); await p.handle.sync() } finally { await p.handle.close() } }
		}
	}
	async displaced(op) {
		if (op.recovery) return
		const metadata = []
		for (const entry of op.intent.entries) {
			const local = await this.local(entry.path)
			if (!local.stat?.isFile() || op.intent.entries.length === 2 && entry.kind === "tombstone") continue
			const capture = await this.workspace.captures.create({ requestId: `displaced:${stableId(`${op.operationId}:${entry.path}`)}`, path: entry.path, baseObservation: local.observation.token, computeDigest: true })
			if (!capture.source || capture.status === 202) throw cloudError(503, "recovery_capture_pending")
			const id = `remote-recovery:${stableId(`${op.operationId}:${entry.path}`)}`, holdId = `recovery-hold:${stableId(id)}`
			await this.workspace.captures.hold("capture", capture.source.captureId, "recovery", holdId)
			metadata.push(put("recovery", id, { id, kind: "remote-replacement", original: this.workspace.ref(entry.path), source: capture.source, holdId, createdAt: now(), expiresAt: new Date(Date.now() + this.workspace.limits.recoveryMs).toISOString(), restoreAvailable: true, restoreDisposition: "copy", state: "available" }))
		}
		op.recovery = metadata; await this.state.put("operations", op.operationId, op)
	}
	async apply(change, bytes, baseLocalGeneration) {
		return this.serial(change.operationId, async () => {
			try {
				const op = await this.prepare(change, bytes, baseLocalGeneration)
				if (op.state === "committed") return op
				return await this.publish(op, change)
			} finally { bytes?.destroy?.() }
		})
	}
	async publish(op, change = {}) {
		const ws = this.workspace, entries = op.intent.entries, file = entries.find((e) => e.kind !== "tombstone") || entries[0]
		if (op.state === "committed") return op
		if (["publishing", "indeterminate"].includes(op.state)) throw cloudError(503, "operation_indeterminate")
		if (op.claim && !op.publicationPermit) throw cloudError(409, "publication_permit_required")
		if (op.claim && entries.length === 1 && file.kind === "file") {
			await ws.locks.run(async () => {
				const local = await this.local(file.path)
				// A frozen snapshot can finish the same sealed source while its grant response is lost.
				// Adopt only that verified unchanged cloud baseline, never a changed live file or newer head.
				if (local.operation?.state === "committed" && local.baseline?.headToken === file.headToken && local.baseline.fileVersionId === file.fileVersionId && local.baseline.sha256 === file.sha256 && local.baseline.observation === local.observation?.token) {
					op.bases[file.path] = { generation: local.generation, observation: local.observation.token }
					await this.state.put("operations", op.operationId, op)
				}
			})
		}
		const baseline = entries.length === 1 && file.kind === "file" ? await this.baseline(file.path) : null
		const reuseBaseline = baseline?.headToken === file.headToken && baseline.observation === op.bases[file.path].observation
		if (!reuseBaseline) await this.displaced(op)
		let candidate, parent
		try {
			if (entries.length === 1 && file.kind === "file" && !reuseBaseline) {
				await ws.locks.run(async () => {
					await this.check(entries, op.bases, op.intent); await this.parents(file.path)
					parent = await ws.safeFs.parent(file.path); const candidateName = `.gc-file-${crypto.randomUUID()}`
					candidate = await ws.safeFs.create(parent.handle, candidateName)
					op.evidence = { path: file.path, candidateName, candidate: objectIdentity(await candidate.stat({ bigint: true })), parent: parent.parentIdentity, parentPath: parent.path }
					await this.state.put("operations", op.operationId, op)
				})
				const source = await ws.captures.open("capture", op.publishedSource.captureId)
				try { await ws.copy(source.handle, candidate, file.sizeBytes) } finally { await source.release() }
				await candidate.sync()
				op.evidence.sizeBytes = file.sizeBytes; op.evidence.mtimeNs = String((await candidate.stat({ bigint: true })).mtimeNs)
			}
			// Retention -> managed lock is the common order. Ticket metadata is built before this section.
			return await ws.captures.withRetention(async () => ws.locks.run(async () => {
				await this.check(entries, op.bases, op.intent)
				if (ws.draining || ws.closed) throw cloudError(503, "draining")
				op.state = "publishing"; await this.state.put("operations", op.operationId, op)
				if (entries.length === 2) await this.move(op)
				else if (file.kind === "file" && reuseBaseline) {
					const current = await this.local(file.path), p = await ws.safeFs.parent(file.path)
					try { op.evidence = { path: file.path, candidate: objectIdentity(current.stat), parent: p.parentIdentity, sizeBytes: file.sizeBytes, mtimeNs: String(current.stat.mtimeNs) }; await this.state.put("operations", op.operationId, op) } finally { await p.handle.close() }
				} else if (file.kind === "file") {
					await chmod(candidate.fd, 0o664); await candidate.sync()
					await ws.safeFs.rename(parent.handle, op.evidence.candidateName, parent.handle, parent.name, { noReplace: !op.bases[file.path].observation }); op.effectApplied = true
					await parent.handle.sync()
					if (!await ws.safeFs.prove(file.path, op.evidence.candidate, op.evidence.parent)) throw cloudError(503, "operation_indeterminate")
				} else await this.entryEffect(op, file)
				await ws.checkpoint("remote-published", op)
				return this.commit(op)
			}))
		} catch (error) {
			const stored = await this.state.get("operations", op.operationId)
			if (stored?.state === "committed") return stored
			if (op.effectApplied || op.state === "publishing") { op.state = "indeterminate"; op.reconciliation = { required: true, inspectionRef: `operations/${op.operationId}`, replayAllowed: false }; await this.state.put("operations", op.operationId, op) }
			throw error
		} finally { await candidate?.close(); await parent?.handle.close() }
	}
	async move(op) {
		const ws = this.workspace, from = op.intent.entries.find((e) => e.kind === "tombstone"), to = op.intent.entries.find((e) => e.kind !== "tombstone")
		const source = await this.local(from.path)
		if (!source.stat || source.baseline?.fileVersionId !== to.fileVersionId || source.baseline?.kind !== to.kind) throw cloudError(409, "move_source_unavailable")
		await this.parents(to.path)
		const a = await ws.safeFs.parent(from.path), b = await ws.safeFs.parent(to.path)
		try {
			op.evidence = { path: to.path, from: from.path, candidate: objectIdentity(source.stat), parent: b.parentIdentity, fromParent: a.parentIdentity }
			await this.state.put("operations", op.operationId, op)
			await ws.safeFs.rename(a.handle, a.name, b.handle, b.name, { noReplace: !op.bases[to.path].observation }); op.effectApplied = true
			await a.handle.sync(); await b.handle.sync()
		} finally { await a.handle.close(); await b.handle.close() }
	}
	async entryEffect(op, entry) {
		const ws = this.workspace, local = await this.local(entry.path)
		if (entry.kind === "tombstone" && !local.stat) { op.evidence = { path: entry.path, absent: true }; await this.state.put("operations", op.operationId, op); return }
		if (entry.kind !== "tombstone") await this.parents(entry.path)
		const parent = await ws.safeFs.parent(entry.path)
		try {
			if (entry.kind === "tombstone") {
				if (!ws.trashAvailable) throw cloudError(409, "trash_unavailable")
				const trashName = `remote-${stableId(op.operationId)}`
				op.evidence = { path: entry.path, candidate: objectIdentity(local.stat), parent: parent.parentIdentity, trashName }
				await this.state.put("operations", op.operationId, op)
				await ws.safeFs.rename(parent.handle, parent.name, ws.trashHandle, trashName); op.effectApplied = true
				await parent.handle.sync(); await ws.trashHandle.sync()
			} else {
				if (local.stat) { if (!local.stat.isDirectory()) throw cloudError(409, "source_changed"); op.evidence = { path: entry.path, candidate: objectIdentity(local.stat), parent: parent.parentIdentity }; await this.state.put("operations", op.operationId, op); return }
				const stage = await ws.safeFs.stageDirectory(parent.handle)
				try {
					await chmod(stage.handle.fd, 0o2775); await stage.handle.sync()
					op.evidence = { path: entry.path, candidateName: stage.name, candidate: objectIdentity(await stage.handle.stat({ bigint: true })), parent: parent.parentIdentity }
					await this.state.put("operations", op.operationId, op)
					await ws.safeFs.rename(parent.handle, stage.name, parent.handle, parent.name); op.effectApplied = true; await parent.handle.sync()
				} finally { await stage.handle.close() }
			}
		} finally { await parent.handle.close() }
	}
	async commit(op) {
		const ws = this.workspace, metadata = [...(op.recovery || [])]; let publishedObservation = null
		for (const entry of op.intent.entries) {
			let stat = null; try { stat = await ws.safeFs.stat(entry.path) } catch (e) { if (!missing(e)) throw e }
			if (entry.kind === "tombstone" ? stat : !stat || !sameObject(stat, op.evidence.candidate) || entry.kind === "file" && (Number(stat.size) !== entry.sizeBytes || op.evidence.mtimeNs && String(stat.mtimeNs) !== op.evidence.mtimeNs)) throw cloudError(503, "operation_indeterminate")
			const currentObservation = stat ? observation(ws.ref(entry.path), stat) : null
			if (entry.kind !== "tombstone") publishedObservation = currentObservation
			metadata.push(put("cloud-heads", pathKey(entry.path), { ...entry, headKnown: true, localGeneration: op.localGeneration, observation: currentObservation?.token || null, ...(entry.kind === "directory" ? { directoryInventory: await this.directoryInventory(entry.path) } : {}) }))
		}
		if (op.publishedSource) { const capture = await ws.captures.record("capture", op.publishedSource.captureId); metadata.push(put("captures", capture.id, { ...capture, sourceObservation: publishedObservation })) }
		if (op.claim) {
			const claim = op.claim, receipt = { receiptId: op.receiptId, ...ws.identity, operationId: op.operationId, fileVersionId: claim.source.fileVersionId, sha256: claim.source.sha256, path: claim.destination.path, localGeneration: op.localGeneration, cloudHeadToken: claim.destination.headToken, publicationPermitId: op.publicationPermit.permitId }
			const hold = await this.state.get("holds", op.evidenceHoldId)
			if (hold?.source?.kind !== "capture" || hold.source.id !== op.publishedSource?.captureId) throw cloudError(503, "import_source_hold_missing")
			metadata.push(put("holds", hold.holdId, { ...hold, workId: claim.workId, receiptId: op.receiptId, localGeneration: op.localGeneration }))
			const processing = await ws.processing.cloudMetadata(op)
			op.processing = processing.processingReceipt
			metadata.push(...processing.metadata, put("cloud-imports", claim.workId, { workId: claim.workId, claim, receipt, receiptRevision: 1, processingReceipt: processing.processingReceipt, source: op.publishedSource, sourceHoldId: op.evidenceHoldId, publicationPermit: op.publicationPermit, processingPermit: op.processingPermit || null, ackedRevision: 0, publicationSettled: false, processingSettled: false }))
		}
		op.persistence = { ...noPersistence(), state: "clean", acknowledgedRemoteEtag: op.intent.entries.find((e) => e.kind !== "tombstone")?.headToken || op.intent.entries[0].headToken, remoteIntegrity: "digest-verified", localGeneration: op.localGeneration, checkedAt: now() }
		return ws.committed(op, { publishedObservation, metadata })
	}
	async recover() {
		const ws = this.workspace
		for (const op of await this.state.list("operations")) {
			if (op.action !== "apply-remote" || op.state === "committed" || !["publishing", "indeterminate"].includes(op.state)) continue
			await ws.captures.withRetention(async () => ws.locks.run(async () => {
				try {
					// A newer applied local sequence forbids receipt recovery against a displaced address.
					for (const entry of op.intent.entries) if ((await this.baseline(entry.path))?.changeSeq > entry.changeSeq) throw cloudError(409, "remote_superseded")
					const e = op.evidence; if (!e) return
					let proved = e.absent
					if (e.trashName) { const retained = await ws.safeFs.openAt(ws.trashHandle, e.trashName, { metadata: true }); try { proved = sameObject(await retained.stat({ bigint: true }), e.candidate) } finally { await retained.close() } }
					else if (!e.absent) proved = await ws.safeFs.prove(e.path, e.candidate, e.parent)
					if (!proved) return
					if (op.publishedSource) { const source = await ws.captures.privateFile(await ws.captures.record("capture", op.publishedSource.captureId)); await source.close() }
					await this.commit(op)
				} catch { /* Unproved effects remain retained and block further execution. */ }
			}))
		}
	}
}
