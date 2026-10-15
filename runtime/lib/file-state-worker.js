import crypto from "node:crypto"
import fs from "node:fs"
import path from "node:path"
import { parentPort, workerData } from "node:worker_threads"
import Database from "better-sqlite3"
import { FileError, identifier, stableStringify } from "./file-contract.js"
import { validateMetadata as metadata, validateVoxelStateRequest } from "./file-state.js"

function key(kind, id) {
	identifier(kind, "record kind")
	if (id !== undefined) identifier(id, "record id")
}

function report(error) {
	const full = error.code?.startsWith("SQLITE_FULL") || ["ENOSPC", "EDQUOT"].includes(error.code)
	return {
		status: error.status || (full ? 507 : 503), error: error.error || (full ? "insufficient_storage" : "storage_unavailable"), message: `FileState: ${error.message}`,
		details: { agent: "file-service", tool: "file-state", action: "Inspect file-state storage and retry with the original intent.", ...(error.action ? { action: error.action } : {}) },
	}
}

let db
try {
	fs.mkdirSync(workerData.dir, { recursive: true, mode: 0o700 })
	const directory = fs.lstatSync(workerData.dir)
	if (!directory.isDirectory() || directory.uid !== process.geteuid() || (directory.mode & 0o077)) throw new Error("Private metadata state requires a service-owned 0700 directory, not a symlink or shared location.")
	const dbPath = path.join(workerData.dir, "files.sqlite")
	for (const file of [dbPath, `${dbPath}-wal`, `${dbPath}-shm`]) {
		let stat
		try { stat = fs.lstatSync(file) } catch (error) { if (error.code !== "ENOENT") throw error }
		if (stat && (!stat.isFile() || stat.uid !== process.geteuid() || stat.nlink !== 1 || (stat.mode & 0o077))) throw new Error("Metadata database files must be service-owned private regular files without hardlink aliases.")
	}
	db = new Database(dbPath, { timeout: 5000 })
	fs.chmodSync(dbPath, 0o600)
	db.pragma("journal_mode = WAL")
	db.pragma("synchronous = FULL")
	db.exec(`
		CREATE TABLE IF NOT EXISTS identity (singleton INTEGER PRIMARY KEY CHECK(singleton = 1), workspace_id TEXT NOT NULL, workspace_epoch TEXT NOT NULL);
		CREATE TABLE IF NOT EXISTS records (epoch TEXT NOT NULL, kind TEXT NOT NULL, id TEXT NOT NULL, value TEXT NOT NULL, PRIMARY KEY(epoch, kind, id)) WITHOUT ROWID;
		CREATE TABLE IF NOT EXISTS claims (epoch TEXT NOT NULL, kind TEXT NOT NULL, id TEXT NOT NULL, intent TEXT NOT NULL, initial_record TEXT NOT NULL, PRIMARY KEY(epoch, kind, id)) WITHOUT ROWID;
		CREATE INDEX IF NOT EXISTS voxel_named_name ON records(epoch, kind, json_extract(value, '$.name'), id) WHERE kind = 'voxel-named';
	`)
	db.prepare("INSERT OR IGNORE INTO identity VALUES (1, ?, ?)").run(crypto.randomUUID(), crypto.randomUUID())
	const stored = db.prepare("SELECT workspace_id, workspace_epoch FROM identity WHERE singleton = 1").get()
	const identity = { workspaceId: stored.workspace_id, workspaceEpoch: stored.workspace_epoch }
	const epoch = identity.workspaceEpoch
	const get = db.prepare("SELECT value FROM records WHERE epoch = ? AND kind = ? AND id = ?")
	const put = db.prepare("INSERT INTO records VALUES (?, ?, ?, ?) ON CONFLICT(epoch, kind, id) DO UPDATE SET value = excluded.value")
	const remove = db.prepare("DELETE FROM records WHERE epoch = ? AND kind = ? AND id = ?")
	const list = db.prepare("SELECT id, value FROM records WHERE epoch = ? AND kind = ? ORDER BY id")
	const read = (kind, id) => { const row = get.get(epoch, kind, id); return row ? JSON.parse(row.value) : null }
	const write = (kind, id, value) => {
		metadata(value)
		const current = ["voxel-artifacts", "voxel-owned-captures", "voxel-reservations", "captures"].includes(kind) ? read(kind, id) : null
		// Lifecycle authority is monotonic at the committing boundary. Producer
		// metadata and crash replay cannot reopen access or erase cleanup history.
		if (kind === "voxel-artifacts" && current) {
			value = { ...value, ...(current.link ? { link: current.link } : {}), ...(current.deletion ? { deletion: current.deletion } : {}) }
		}
		if (kind === "voxel-owned-captures") {
			if (current) for (const field of ["reservationId", "artifactId", "workspaceEpoch", "key", "captureId", "sizeBytes", "metadataBytes"]) if (current[field] !== value[field]) throw new FileError(409, "publication_ownership", "Capture ownership cannot be rebound by publication metadata.")
			for (const field of ["cleanupRequestedAt", "cleanupIndeterminate", "cleanupError", "reclaimedAt", "reclaimedBytes"]) if (current?.[field] !== undefined) value = { ...value, [field]: current[field] }
			const artifact = read("voxel-artifacts", value.artifactId)
			if (artifact?.deletion) value = { ...value, cleanupRequestedAt: value.cleanupRequestedAt || artifact.deletion.requestedUtc }
		}
		if (kind === "voxel-reservations" && current) {
			value = { ...value, reclaimedStagingBytes: Math.max(value.reclaimedStagingBytes || 0, current.reclaimedStagingBytes || 0), entries: value.entries.map((entry) => {
				const prior = current.entries.find((e) => e.key === entry.key)
				return { ...entry, ...(prior?.converted ? { converted: true, captureId: prior.captureId } : {}), ...(prior?.cleanupState ? { cleanupState: prior.cleanupState } : {}), ...(entry.staging && prior?.staging?.cleanupState ? { staging: { ...entry.staging, cleanupState: prior.staging.cleanupState } } : {}) }
			}) }
		}
		if (kind === "captures" && current?.evictedAt) value = { ...value, evictedAt: current.evictedAt, cleanupPending: current.cleanupPending && value.cleanupPending !== false }
		// Recovery and late failure handlers cannot replace a committed receipt
		// with an older in-memory version after the atomic named transaction.
		if (["voxel-operations", "voxel-keys"].includes(kind) && value?.id) value = read("voxel-named-outcomes", value.id)?.operation ?? value
		put.run(epoch, kind, id, stableStringify(value)); return value
	}
	// Acquire the writer lock before lifecycle reads, just as batch/claim/named
	// mutations do. A standalone merge must not race another connection's commit.
	const standalonePut = db.transaction(({ kind, id, value }) => write(kind, id, value))
	const batch = db.transaction((operations) => {
		if (!Array.isArray(operations)) throw new FileError(400, "invalid_state_operation", "A transaction must be an array of put/delete operations.")
		for (const operation of operations) {
			if (!operation || !["put", "delete"].includes(operation.type)) throw new FileError(400, "invalid_state_operation", "A transaction accepts only put/delete operations.")
			identifier(operation.id, "record id")
			key(operation.kind, operation.id)
			if (operation.type === "put") write(operation.kind, operation.id, operation.value)
			else remove.run(epoch, operation.kind, operation.id)
		}
	})
	const claimed = db.prepare("SELECT intent, initial_record FROM claims WHERE epoch = ? AND kind = ? AND id = ?")
	const insertClaim = db.prepare("INSERT INTO claims VALUES (?, ?, ?, ?, ?)")
	const claim = db.transaction(({ kind, id, intent, record }) => {
		metadata(intent)
		const normalized = stableStringify(intent)
		const existing = claimed.get(epoch, kind, id)
		if (existing) {
			if (existing.intent !== normalized) throw new FileError(409, /^operations?$/.test(kind) ? "operation_id_reused" : "request_id_reused", "This identifier already binds a different intent; submit a new identifier.")
			const current = get.get(epoch, kind, id)
			return { duplicate: true, record: JSON.parse(current ? current.value : existing.initial_record) }
		}
		metadata(record)
		insertClaim.run(epoch, kind, id, normalized, stableStringify(record))
		write(kind, id, record)
		return { duplicate: false, record }
	})
	const namedPage = db.prepare("SELECT value FROM records WHERE epoch = ? AND kind = 'voxel-named' AND id > ? ORDER BY id LIMIT ?")
	const namedByName = db.prepare("SELECT value FROM records WHERE epoch = ? AND kind = 'voxel-named' AND json_extract(value, '$.name') = ? AND id > ? ORDER BY id LIMIT ?")
	const namedByArtifact = db.prepare("SELECT value FROM records WHERE epoch = ? AND kind = 'voxel-named' AND json_extract(value, '$.artifact.artifactId') = ? ORDER BY id LIMIT 100")
	// Outcome, head and both discovery receipts commit together. A journaled
	// operation is replayed as evidence; it never executes its old CAS again.
	const namedCommit = db.transaction(({ id }) => {
		const journal = read("voxel-named-outcomes", id)
		if (journal) return journal.operation
		const op = read("voxel-operations", id)
		if (!op?.namedIntent || !op.artifact) throw new FileError(409, "artifact_not_registered", "The named operation needs a registered artifact before association.")
		const artifact = read("voxel-artifacts", op.artifact.artifactId)
		if (!artifact || !artifact.deletion && artifact.state !== "ready" || stableStringify(artifact.link) !== stableStringify(op.artifact)) throw new FileError(409, "artifact_not_registered", "The complete artifact binding is not registered ready.")
		const intent = op.namedIntent, current = read("voxel-named", intent.voxelId), target = intent.revision
		const matches = target ? current && current.headRevision === target.expectedHeadRevision && stableStringify(current.artifact) === stableStringify(target.base) : !current
		let named
		if (artifact.deletion) named = { outcome: "failed", voxelId: intent.voxelId, name: current?.name ?? intent.name, reasonCode: "artifact_deleted", reason: "The saved candidate was deleted before named association." }
		else if (matches) {
			const stamp = new Date().toISOString()
			const head = { voxelId: intent.voxelId, name: current?.name ?? intent.name, headRevision: crypto.randomUUID(), artifact: op.artifact, createdUtc: current?.createdUtc ?? stamp, updatedUtc: stamp }
			write("voxel-named", head.voxelId, head)
			named = { outcome: "committed", ...head }
		} else named = { outcome: target ? "conflict" : "failed", voxelId: intent.voxelId, name: current?.name ?? intent.name, reason: target ? "The expected head validator and exact artifact base no longer match." : "The reserved logical identity is already associated." }
		const settled = { ...op, phase: "ready", detail: "Voxel artifact published.", error: null, named, updatedUtc: new Date().toISOString() }
		write("voxel-named-outcomes", id, { operationId: id, intent, artifact: op.artifact, operation: settled })
		write("voxel-operations", id, settled); write("voxel-keys", op.key, settled)
		return settled
	})
	const namedRename = db.transaction(({ id, name, expectedHeadRevision }) => {
		const head = read("voxel-named", id)
		if (!head) throw new FileError(404, "voxel_not_found", "No named voxel has this ID in the current epoch.")
		if (head.headRevision !== expectedHeadRevision) throw new FileError(409, "head_conflict", "The voxel changed before rename; resolve its current head and retry.")
		const updated = { ...head, name, headRevision: crypto.randomUUID(), updatedUtc: new Date().toISOString() }
		write("voxel-named", id, updated); return updated
	})
	// Deletion and head CAS share one SQLite ordering boundary. Read heads here,
	// never accept a parent's precomputed snapshot of names or validators.
	const artifactDelete = db.transaction(({ id, generation, key, requester }) => {
		const artifact = read("voxel-artifacts", id)
		if (!artifact) throw new FileError(404, "artifact_not_found", "No artifact has this ID in the current epoch.")
		if (artifact.manifest.generation !== generation) throw new FileError(409, "artifact_generation_conflict", "Generation differs from the exact registration.")
		const intent = { workspaceEpoch: epoch, artifactId: id, generation }, prior = read("voxel-deletion-keys", key)
		if (prior && stableStringify(prior.intent) !== stableStringify(intent)) throw new FileError(409, "idempotency_conflict", "Deletion key binds another artifact or generation.")
		const existing = artifact.deletion && read("voxel-deletions", artifact.deletion.id)
		if (artifact.deletion && !existing) throw new FileError(503, "storage_unavailable", "Artifact tombstone has no durable deletion receipt.")
		const receipt = existing || { id: crypto.randomUUID(), ...intent, requestedUtc: new Date().toISOString(), requester, access: "closed", logicalDeletion: true, holdsReleased: false, cleanupPending: true, reclaimedBytes: 0, blockers: [], indeterminate: false }
		const namedIds = []
		if (!existing) {
			write("voxel-artifacts", id, { ...artifact, deletion: { id: receipt.id, requestedUtc: receipt.requestedUtc }, retryAt: null })
			write("voxel-deletions", receipt.id, receipt)
			for (const row of list.all(epoch, "voxel-owned-captures")) {
				const owned = JSON.parse(row.value)
				if (owned.artifactId === id && !owned.reclaimedAt) write("voxel-owned-captures", row.id, { ...owned, cleanupRequestedAt: receipt.requestedUtc })
			}
			for (const row of list.all(epoch, "voxel-named")) {
				const head = JSON.parse(row.value)
				if (artifact.link && stableStringify(head.artifact) === stableStringify(artifact.link)) {
					write("voxel-named", row.id, { ...head, headRevision: crypto.randomUUID(), updatedUtc: receipt.requestedUtc }); namedIds.push(row.id)
				}
			}
		}
		write("voxel-deletion-keys", key, { intent, deletionId: receipt.id })
		return { deletion: receipt, namedIds }
	})

	// Job outcomes precede hold release. Operations belong to the parent's crash reconciliation.
	db.transaction(() => {
		for (const kind of ["jobs", "job"]) for (const row of list.all(epoch, kind)) {
			const job = JSON.parse(row.value)
			if (!["queued", "accepted", "running", "cancel_requested", "copying", "hashing"].includes(job.state)) continue
			write(kind, row.id, { ...job, state: "interrupted", stage: "interrupted", finishedAt: new Date().toISOString(), error: {
				error: "job_interrupted", message: "The file service stopped before this job completed.", agent: "file-service", tool: "file-job", action: "Inspect retained source bytes and submit a new request to retry.",
			} })
		}
	}).immediate()
	parentPort.postMessage({ ready: true, identity })
	parentPort.on("message", ({ sequence, type, args }) => {
		try {
			if (type.startsWith("voxel-named-") || type === "voxel-artifact-delete") validateVoxelStateRequest(type, args)
			else if (!["close", "transaction"].includes(type)) { key(args.kind, args.id); if (type !== "list") identifier(args.id, "record id") }
			let result
			switch (type) {
				case "get": result = read(args.kind, args.id); break
				case "put": result = standalonePut.immediate(args); break
				case "delete": result = remove.run(epoch, args.kind, args.id).changes > 0; break
				case "list": result = list.all(epoch, args.kind).map((row) => JSON.parse(row.value)); break
				case "transaction": batch.immediate(args.operations); result = null; break
				case "claim": result = claim.immediate(args); break
				case "was-claimed": result = Boolean(claimed.get(epoch, args.kind, args.id)); break
				case "voxel-named-commit": result = namedCommit.immediate(args); break
				case "voxel-named-rename": result = namedRename.immediate(args); break
				case "voxel-artifact-delete": result = artifactDelete.immediate(args); break
				case "voxel-named-by-artifact": result = namedByArtifact.all(epoch, args.id).map((row) => JSON.parse(row.value)); break
				case "voxel-named-list": result = (args.name === null ? namedPage.all(epoch, args.after, args.limit + 1) : namedByName.all(epoch, args.name, args.after, args.limit + 1)).map((row) => JSON.parse(row.value)); break
				case "close": db.close(); result = null; break
				default: throw new FileError(400, "invalid_state_operation", "Unknown metadata operation.")
			}
			parentPort.postMessage({ sequence, result })
		} catch (error) { parentPort.postMessage({ sequence, error: report(error) }) }
	})
} catch (error) {
	if (db?.open) db.close()
	parentPort.postMessage({ fatal: true, error: report(error) })
}
