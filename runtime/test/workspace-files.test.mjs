import assert from "node:assert/strict"
import crypto from "node:crypto"
import fs from "node:fs/promises"
import os from "node:os"
import path from "node:path"
import { Readable } from "node:stream"
import { test } from "node:test"
import { noPersistence } from "../lib/file-contract.js"
import { WorkspaceFiles } from "../lib/workspace-files.js"

const logger = { info() {}, warn() {}, error() {} }
const processingFactory = () => ({
	async init() {}, async reconcileOperations() {}, async releaseFailedUpload() {}, async close() {},
	capabilities() { return { enabled: false } }, async drain() { return { complete: true } },
	async reserveUpload() { throw new Error("An internal upload must not reserve processing.") },
	async uploadMetadata() { throw new Error("An internal upload must not create a processing ticket.") },
})
async function fixture(t) {
	// Protected source storage requires non-writable ancestors, including outside the worktree.
	const base = await fs.mkdtemp(path.join(os.homedir(), ".gc-file-"))
	await fs.chmod(base, 0o700)
	const workspaceDir = path.join(base, "project"), filesStateDir = path.join(base, "state")
	await fs.mkdir(workspaceDir, { mode: 0o2775 })
	const config = { workspaceDir, filesStateDir, filesAgentUids: [20001], filesWorkerUids: [20003], rgBin: "rg", filesLimits: { trashMs: 10000 }, processingFactory }
	let files = await WorkspaceFiles.open(config, logger)
	t.after(async () => { await files.close(); await fs.rm(base, { recursive: true, force: true }) })
	return { config, root: workspaceDir, get files() { return files }, async restart() { await files.close(); files = await WorkspaceFiles.open(config, logger); return files } }
}
const upload = (files, operationId, name, text, extra = {}) => files.upload(Readable.from([Buffer.from(text)]), { path: name, operationId, declaredSize: Buffer.byteLength(text), ...extra })

test("workspace: nested upload creates durable parents and preserves the first body across restart", async (t) => {
	const f = await fixture(t)
	const first = await upload(f.files, "nested", "new/deep/notes.txt", "first")
	assert.equal(first.status, 201)
	assert.equal(first.operation.state, "committed")
	const parentId = first.operation.parentOperationId
	assert.equal(parentId, `upload-parents:${crypto.createHash("sha256").update("nested").digest("hex")}`)
	const parents = await f.files.operation(parentId)
	assert.equal(parents.state, "committed")
	assert.deepEqual(parents.intent, { action: "mkdir", path: "new/deep", parents: true })
	assert.deepEqual(parents.evidence.directories.map((entry) => entry.path), ["new", "new/deep"])
	await f.restart()
	const duplicate = await upload(f.files, "nested", "new/deep/notes.txt", "wrong")
	assert.equal(duplicate.duplicate, true)
	assert.equal(duplicate.operation.parentOperationId, parentId)
	assert.equal((await f.files.operation(parentId)).state, "committed")
	assert.equal(await fs.readFile(path.join(f.root, "new/deep/notes.txt"), "utf8"), "first")
})

test("workspace: invalid upload size or digest creates no parent directories", async (t) => {
	const f = await fixture(t)
	for (const [id, extra, error] of [["bad-size", { declaredSize: 99 }, "size_mismatch"], ["bad-digest", { declaredDigest: "0".repeat(64) }, "digest_mismatch"]]) {
		await assert.rejects(upload(f.files, id, `${id}/deep/notes.txt`, "bytes", extra), { error })
		await assert.rejects(fs.stat(path.join(f.root, id)), { code: "ENOENT" })
		assert.equal((await f.files.operation(id)).parentOperationId, undefined)
	}
})

test("workspace: automatic upload parents reject symlinks, files, protected and reserved paths", async (t) => {
	const f = await fixture(t)
	const outside = path.join(path.dirname(f.root), "outside")
	await fs.mkdir(outside)
	await fs.symlink(outside, path.join(f.root, "link"))
	await fs.writeFile(path.join(f.root, "plain"), "keep")
	await fs.mkdir(path.join(f.root, "protected"))
	await f.files.safeFs.policy.register({ path: "protected", access: "read-only" })
	for (const [n, name, error] of [[0, "link/new/a.txt", "invalid_path"], [1, "plain/new/a.txt", "invalid_path"], [2, "protected/new/a.txt", "protected_resource"], [3, "fresh/.runtime/new/a.txt", "protected_resource"], [4, "datasets/new/a.txt", "protected_resource"]]) {
		await assert.rejects(upload(f.files, `denied-${n}`, name, "bytes"), { error })
	}
	assert.deepEqual(await fs.readdir(outside), [])
	assert.deepEqual(await fs.readdir(path.join(f.root, "protected")), [])
	assert.equal(await fs.readFile(path.join(f.root, "plain"), "utf8"), "keep")
	await assert.rejects(fs.stat(path.join(f.root, "fresh")), { code: "ENOENT" })
})

test("workspace: failed or indeterminate parent operations stop upload and are never replayed", async (t) => {
	const f = await fixture(t)
	for (const [id, checkpoint, expected] of [["failed-parent", "publishing", "aborted-before-publication"], ["uncertain-parent", "published", "indeterminate"]]) {
		let injected = false
		f.files.config.filesCheckpoint = async (stage, op) => {
			if (!injected && op.action === "mkdir" && stage === checkpoint) { injected = true; throw Object.assign(new Error("parent interruption"), { code: checkpoint === "publishing" ? "EPERM" : "EIO" }) }
		}
		await assert.rejects(upload(f.files, id, `${id}/deep/a.txt`, "first"), { error: checkpoint === "publishing" ? "permission_denied" : "operation_indeterminate" })
		const parentId = (await f.files.operation(id)).parentOperationId
		assert.equal((await f.files.operation(parentId)).state, expected)
		delete f.files.config.filesCheckpoint
		await f.restart()
		const duplicate = await upload(f.files, id, `${id}/deep/a.txt`, "wrong")
		assert.equal(duplicate.duplicate, true)
		assert.equal((await f.files.operation(parentId)).state, expected)
		await assert.rejects(fs.stat(path.join(f.root, `${id}/deep/a.txt`)), { code: "ENOENT" })
	}
})

test("workspace: a later upload failure retains created directories and their linked receipt", async (t) => {
	const f = await fixture(t)
	f.files.config.filesCheckpoint = async (stage, op) => {
		if (op.action === "upload" && stage === "staged") throw Object.assign(new Error("file publication denied"), { code: "EPERM" })
	}
	await assert.rejects(upload(f.files, "late-failure", "left/deep/a.txt", "bytes"), { error: "permission_denied" })
	const failed = await f.files.operation("late-failure")
	assert.equal((await f.files.operation(failed.parentOperationId)).state, "committed")
	delete f.files.config.filesCheckpoint
	await f.restart()
	assert.equal((await fs.stat(path.join(f.root, "left/deep"))).isDirectory(), true)
	assert.equal((await f.files.operation(failed.parentOperationId)).state, "committed")
	await assert.rejects(fs.stat(path.join(f.root, "left/deep/a.txt")), { code: "ENOENT" })
})

test("workspace: an existing noncommitted parent receipt cannot be treated as successful mkdir", async (t) => {
	const f = await fixture(t)
	for (const [id, checkpoint] of [["old-failed", "publishing"], ["old-indeterminate", "published"]]) {
		const parentId = `upload-parents:${crypto.createHash("sha256").update(id).digest("hex")}`
		const fixtureId = `fixture-parent-${id}`
		let injected = false
		f.files.config.filesCheckpoint = async (stage, op) => {
			if (!injected && op.operationId === fixtureId && stage === checkpoint) { injected = true; throw Object.assign(new Error("interrupted parent"), { code: checkpoint === "publishing" ? "EPERM" : "EIO" }) }
		}
		await assert.rejects(f.files.mkdir({ operationId: fixtureId, path: `${id}/deep`, parents: true }))
		delete f.files.config.filesCheckpoint
		const fixtureReceipt = await f.files.operation(fixtureId)
		await f.files.state.claim("operations", parentId, fixtureReceipt.intent, { ...fixtureReceipt, operationId: parentId })
		await f.files.state.delete("operations", fixtureId)
		const prior = await f.files.operation(parentId)
		await assert.rejects(upload(f.files, id, `${id}/deep/a.txt`, "bytes"), { error: "operation_indeterminate", parentOperationId: parentId, parentOperationState: prior.state })
		assert.deepEqual(await f.files.operation(parentId), prior)
		await assert.rejects(fs.stat(path.join(f.root, `${id}/deep`)), { code: "ENOENT" })
	}
})

test("workspace: an indeterminate parent receipt blocks upload even when its full directory exists", async (t) => {
	const f = await fixture(t)
	const id = "existing-uncertain", parentId = `upload-parents:${crypto.createHash("sha256").update(id).digest("hex")}`
	const fixtureId = "fixture-existing-parent"
	f.files.config.filesCheckpoint = async (stage, op) => {
		if (op.operationId === fixtureId && stage === "published") throw Object.assign(new Error("lost directory publication confirmation"), { code: "EIO" })
	}
	await assert.rejects(f.files.mkdir({ operationId: fixtureId, path: id, parents: true }), { error: "operation_indeterminate" })
	delete f.files.config.filesCheckpoint
	const fixtureReceipt = await f.files.operation(fixtureId)
	await f.files.state.claim("operations", parentId, fixtureReceipt.intent, { ...fixtureReceipt, operationId: parentId })
	await f.files.state.delete("operations", fixtureId)
	assert.equal((await fs.stat(path.join(f.root, id))).isDirectory(), true)
	await assert.rejects(upload(f.files, id, `${id}/a.txt`, "bytes"), { error: "operation_indeterminate", parentOperationId: parentId })
	assert.equal((await f.files.operation(id)).parentOperationId, parentId)
	assert.equal((await f.files.operation(parentId)).state, "indeterminate")
	await assert.rejects(fs.stat(path.join(f.root, `${id}/a.txt`)), { code: "ENOENT" })
})

test("workspace: jittered uploads to a shared missing parent preserve every distinct body", async (t) => {
	const f = await fixture(t)
	const results = await Promise.all(Array.from({ length: 12 }, async (_, n) => {
		await new Promise((resolve) => setTimeout(resolve, Math.random() * 12))
		return upload(f.files, `shared-${n}`, `shared/deep/${n}.txt`, `body-${n}`)
	}))
	for (let n = 0; n < results.length; n++) {
		assert.equal(results[n].operation.state, "committed")
		assert.equal(await fs.readFile(path.join(f.root, `shared/deep/${n}.txt`), "utf8"), `body-${n}`)
	}
})

test("workspace: mkdir accepts an external directory publication race without replacing it and recovers its proof", async (t) => {
	const f = await fixture(t)
	let external
	f.files.config.filesCheckpoint = async (stage, op) => {
		if (op.operationId !== "raced-parent" || stage !== "publishing" || external) return
		await fs.mkdir(path.join(f.root, "raced"))
		external = await fs.stat(path.join(f.root, "raced"), { bigint: true })
	}
	const made = (await f.files.mkdir({ operationId: "raced-parent", path: "raced", parents: true })).operation
	assert.equal((await fs.stat(path.join(f.root, "raced"), { bigint: true })).ino, external.ino)
	assert.equal(made.evidence.directories[0].created, false)
	assert.deepEqual(await fs.readdir(f.root), ["raced"])
	await f.files.state.put("operations", made.operationId, { ...made, state: "publishing", committedAt: null, localGeneration: null })
	delete f.files.config.filesCheckpoint
	await f.restart()
	assert.equal((await f.files.operation(made.operationId)).state, "committed")
})

test("workspace: mkdir race-loser cleanup preserves a substituted staging directory across restart", async (t) => {
	const f = await fixture(t)
	let raced = false, replacement
	f.files.config.filesCheckpoint = async (stage, op) => {
		if (raced || op.operationId !== "cleanup-race" || stage !== "publishing") return
		raced = true; await fs.mkdir(path.join(f.root, "raced"))
	}
	async function substitute(parent, name) {
		if (replacement || parent.path !== "" || !name.startsWith(".gc-file-")) return
		await fs.rename(path.join(f.root, name), path.join(f.root, "original-candidate"))
		await fs.mkdir(path.join(f.root, name))
		replacement = await fs.stat(path.join(f.root, name), { bigint: true })
	}
	const unlink = f.files.safeFs.unlink.bind(f.files.safeFs), rename = f.files.safeFs.rename.bind(f.files.safeFs)
	f.files.safeFs.unlink = async (parent, name, directory) => { if (directory) await substitute(parent, name); return unlink(parent, name, directory) }
	f.files.safeFs.rename = async (parent, name, to, target, options) => { if (to === f.files.trashHandle) await substitute(parent, name); return rename(parent, name, to, target, options) }
	const made = (await f.files.mkdir({ operationId: "cleanup-race", path: "raced", parents: true })).operation
	assert.equal(made.state, "committed")
	assert.equal(made.cleanup?.state, "indeterminate")
	const retained = path.join(f.config.filesStateDir, "trash", made.cleanup.pendingTrash.name)
	assert.equal((await fs.stat(retained, { bigint: true })).ino, replacement.ino)
	delete f.files.config.filesCheckpoint
	await f.restart()
	assert.equal((await f.files.operation("cleanup-race")).cleanup.state, "indeterminate")
	assert.equal((await fs.stat(retained, { bigint: true })).ino, replacement.ino)
	assert.equal((await fs.stat(path.join(f.root, "original-candidate"))).isDirectory(), true)
})

test("workspace: mkdir publication races cannot turn symlinks, files or protected parents into upload destinations", async (t) => {
	const f = await fixture(t)
	const outside = path.join(path.dirname(f.root), "outside")
	await fs.mkdir(outside)
	for (const [id, kind, error] of [["race-link", "link", "invalid_path"], ["race-file", "file", "invalid_path"], ["race-protected", "protected", "protected_resource"]]) {
		let injected = false
		f.files.config.filesCheckpoint = async (stage, op) => {
			if (injected || op.action !== "mkdir" || stage !== "publishing") return
			injected = true
			if (kind === "link") await fs.symlink(outside, path.join(f.root, id))
			else if (kind === "file") await fs.writeFile(path.join(f.root, id), "keep")
			else { await fs.mkdir(path.join(f.root, id)); await f.files.safeFs.policy.register({ path: id, access: "read-only" }) }
		}
		await assert.rejects(upload(f.files, id, `${id}/deep/a.txt`, "bytes"), { error })
		delete f.files.config.filesCheckpoint
	}
	assert.deepEqual(await fs.readdir(outside), [])
	assert.equal(await fs.readFile(path.join(f.root, "race-file"), "utf8"), "keep")
	assert.deepEqual(await fs.readdir(path.join(f.root, "race-protected")), [])
})

async function seedInterruptedRestore(files, record, operationId, to) {
	const parent = await files.safeFs.parent(to)
	try {
		await files.state.put("operations", operationId, {
			operationId,
			action: "restore",
			intent: { action: "restore", recoveryId: record.id, to },
			state: "publishing",
			addresses: [files.ref(to)],
			publishedSource: null,
			publishedObservation: null,
			acceptedAt: new Date().toISOString(),
			committedAt: null,
			persistence: noPersistence(),
			reconciliation: { required: false, inspectionRef: null, replayAllowed: false },
			evidence: { path: to, candidate: record.candidate, parent: parent.parentIdentity, trashName: record.trashName, recoveryId: record.id, entryType: record.entryType },
		})
	} finally { await parent.handle.close() }
}

test("workspace: create, conditional replacement and durable duplicate receipts preserve the first body", async (t) => {
	const f = await fixture(t)
	assert.equal(f.files.captures.availability.state, "available")
	const first = await upload(f.files, "first", "notes.txt", "old")
	assert.equal(first.operation.state, "committed")
	assert.equal(first.operation.publishedSource.consistency, "service-published")
	assert.equal(first.operation.publishedObservation.token, (await f.files.stat("notes.txt")).observation.token)
	const current = await upload(f.files, "save", "notes.txt", "new", { mode: "replace", baseObservation: first.operation.publishedObservation.token })
	assert.equal(current.operation.state, "committed")
	const again = await upload(f.files, "again", "notes.txt", "newest", { mode: "replace", baseObservation: current.operation.publishedObservation.token })
	assert.equal(again.operation.publishedObservation.token, (await f.files.stat("notes.txt")).observation.token)
	await fs.writeFile(path.join(f.root, "replacement"), "external")
	await fs.rename(path.join(f.root, "replacement"), path.join(f.root, "notes.txt"))
	await assert.rejects(upload(f.files, "stale", "notes.txt", "lost", { mode: "replace", baseObservation: again.operation.publishedObservation.token }), { error: "source_changed" })
	assert.equal(await fs.readFile(path.join(f.root, "notes.txt"), "utf8"), "external")
	const opened = await f.files.captures.open("capture", first.operation.publishedSource.captureId)
	try { let bytes = ""; for await (const part of opened.handle.createReadStream({ autoClose: false })) bytes += part; assert.equal(bytes, "old") } finally { await opened.release() }
	const identity = f.files.identity
	await f.restart()
	assert.deepEqual(f.files.identity, identity)
	assert.equal((await f.files.operation("again")).publishedObservation.token, again.operation.publishedObservation.token)
	const duplicate = await upload(f.files, "first", "notes.txt", "bad")
	assert.equal(duplicate.duplicate, true)
	assert.equal(duplicate.operation.publishedObservation.token, first.operation.publishedObservation.token)
	assert.equal(await fs.readFile(path.join(f.root, "notes.txt"), "utf8"), "external")
	await assert.rejects(upload(f.files, "first", "other.txt", "old"), { error: "operation_id_reused" })
})

test("workspace: jittered same-path creators have one winner and preserve all rejected receipts", async (t) => {
	const f = await fixture(t)
	const results = await Promise.allSettled(Array.from({ length: 12 }, async (_, n) => { await new Promise((r) => setTimeout(r, Math.random() * 8)); return upload(f.files, `race-${n}`, "one.txt", String(n)) }))
	assert.equal(results.filter((r) => r.status === "fulfilled").length, 1)
	for (let n = 0; n < 12; n++) assert.ok(["committed", "failed", "aborted-before-publication"].includes((await f.files.operation(`race-${n}`)).state))
})

test("workspace: mkdir, move and logical recursive delete use scoped preconditions and protect descendants", async (t) => {
	const f = await fixture(t)
	assert.ok((await f.files.info()).operations.includes("force-replace"))
	assert.ok((await f.files.info()).operations.includes("recovery"))
	await f.files.mkdir({ operationId: "folder", path: "folder", parents: false })
	await upload(f.files, "input", "folder/a.txt", "a")
	await assert.rejects(f.files.delete({ operationId: "nonempty", path: "folder", baseObservation: (await f.files.stat("folder")).observation.token }), { error: "directory_not_empty" })
	await f.files.mkdir({ operationId: "dest", path: "dest", parents: false })
	await f.files.move({ operationId: "move", from: "folder/a.txt", to: "dest/a.txt", baseObservation: (await f.files.stat("folder/a.txt")).observation.token, replace: false })
	assert.equal(await fs.readFile(path.join(f.root, "dest/a.txt"), "utf8"), "a")
	await fs.mkdir(path.join(f.root, "dest/protected"))
	await f.files.safeFs.policy.register({ path: "dest/protected", access: "read-only" })
	await assert.rejects(f.files.delete({ operationId: "protected", path: "dest", baseObservation: (await f.files.stat("dest")).observation.token, recursive: true }), { error: "protected_resource" })
	await assert.rejects(async () => f.files.move({ operationId: "root", from: "", to: "bad", baseObservation: "x" }), { error: "invalid_path" })
	await f.files.delete({ operationId: "empty", path: "folder", baseObservation: (await f.files.stat("folder")).observation.token, recursive: false })
	await assert.rejects(fs.stat(path.join(f.root, "folder")), { code: "ENOENT" })
	assert.equal((await f.files.operation("empty")).state, "committed")
})

test("workspace: deleted files remain recoverable across restart and restore idempotently without replacement", async (t) => {
	const f = await fixture(t)
	await upload(f.files, "recovery-source", "notes.txt", "recover me")
	await f.files.delete({ operationId: "delete-note", path: "notes.txt", baseObservation: (await f.files.stat("notes.txt")).observation.token })
	let catalogue = await f.files.recovery()
	assert.equal(catalogue.items.length, 1)
	assert.deepEqual({ ...catalogue.items[0], createdAt: "time", expiresAt: "time" }, {
		id: catalogue.items[0].id,
		kind: "deleted-entry",
		original: f.files.ref("notes.txt"),
		entryType: "file",
		createdAt: "time",
		expiresAt: "time",
		restoreAvailable: true,
		restoreDisposition: "consume",
	})
	const recoveryId = catalogue.items[0].id
	await f.restart()
	catalogue = await f.files.recovery()
	assert.equal(catalogue.items[0].id, recoveryId)
	const restored = await f.files.restoreRecovery(recoveryId, { operationId: "restore-note", to: "restored.txt" })
	assert.equal(restored.operation.state, "committed")
	assert.equal(restored.operation.action, "restore")
	assert.equal(await fs.readFile(path.join(f.root, "restored.txt"), "utf8"), "recover me")
	assert.deepEqual((await f.files.recovery()).items, [])
	const duplicate = await f.files.restoreRecovery(recoveryId, { operationId: "restore-note", to: "restored.txt" })
	assert.equal(duplicate.duplicate, true)
	await assert.rejects(f.files.restoreRecovery(recoveryId, { operationId: "restore-note", to: "other.txt" }), { error: "operation_id_reused" })
	await assert.rejects(f.files.restoreRecovery(recoveryId, { operationId: "restore-again", to: "other.txt" }), { error: "not_found" })
})

test("workspace: recursive delete recovery preserves directories and a destination collision does not consume it", async (t) => {
	const f = await fixture(t)
	await f.files.mkdir({ operationId: "recover-folder", path: "folder", parents: false })
	await upload(f.files, "recover-child", "folder/child.txt", "child")
	await fs.symlink("child.txt", path.join(f.root, "folder/link.txt"))
	await f.files.delete({ operationId: "delete-folder", path: "folder", baseObservation: (await f.files.stat("folder")).observation.token, recursive: true })
	const [item] = (await f.files.recovery()).items
	assert.equal(item.entryType, "dir")
	await upload(f.files, "collision", "occupied", "keep")
	await assert.rejects(f.files.restoreRecovery(item.id, { operationId: "restore-collision", to: "occupied" }), { error: "exists" })
	assert.equal((await f.files.recovery()).items[0].id, item.id)
	await f.files.restoreRecovery(item.id, { operationId: "restore-folder", to: "recovered-folder" })
	assert.equal(await fs.readFile(path.join(f.root, "recovered-folder/child.txt"), "utf8"), "child")
	assert.equal(await fs.readlink(path.join(f.root, "recovered-folder/link.txt")), "child.txt")
})

test("workspace: restart distinguishes unstarted, completed, and ambiguous deleted-entry restores", async (t) => {
	const f = await fixture(t)
	const records = {}
	for (const name of ["before", "after", "ambiguous"]) {
		await upload(f.files, `create-${name}`, `${name}.txt`, name)
		await f.files.delete({ operationId: `delete-${name}`, path: `${name}.txt`, baseObservation: (await f.files.stat(`${name}.txt`)).observation.token })
		const item = (await f.files.recovery()).items.find((entry) => entry.original.path === `${name}.txt`)
		records[name] = await f.files.state.get("recovery", item.id)
		await seedInterruptedRestore(f.files, records[name], `restore-${name}`, `restored-${name}.txt`)
	}
	await fs.rename(path.join(f.config.filesStateDir, "trash", records.after.trashName), path.join(f.root, "restored-after.txt"))
	await fs.link(path.join(f.config.filesStateDir, "trash", records.ambiguous.trashName), path.join(f.root, "restored-ambiguous.txt"))

	await f.restart()
	assert.equal((await f.files.operation("restore-before")).state, "aborted-before-publication")
	assert.equal((await f.files.operation("restore-after")).state, "committed")
	assert.equal((await f.files.operation("restore-ambiguous")).state, "indeterminate")
	assert.equal(await fs.readFile(path.join(f.root, "restored-after.txt"), "utf8"), "after")
	assert.deepEqual((await f.files.recovery()).items.map((entry) => entry.original.path).sort(), ["ambiguous.txt", "before.txt"])
})

test("workspace: remote-replacement recovery remains a reusable create-only copy", async (t) => {
	const f = await fixture(t)
	const source = (await upload(f.files, "remote-source", "notes.txt", "retained remote replacement")).operation.publishedSource
	const createdAt = new Date().toISOString()
	const record = {
		id: "remote:replacement-1",
		kind: "remote-replacement",
		original: f.files.ref("notes.txt"),
		source,
		createdAt,
		expiresAt: new Date(Date.parse(createdAt) + f.files.limits.recoveryMs).toISOString(),
		restoreAvailable: true,
		restoreDisposition: "copy",
		state: "available",
	}
	await f.files.state.put("recovery", record.id, record)
	assert.deepEqual((await f.files.recovery()).items, [{
		id: record.id,
		kind: record.kind,
		original: record.original,
		source,
		createdAt: record.createdAt,
		expiresAt: record.expiresAt,
		restoreAvailable: true,
		restoreDisposition: "copy",
	}])
	await f.files.restoreRecovery(record.id, { operationId: "restore-copy-1", to: "copy-1.txt" })
	await f.files.restoreRecovery(record.id, { operationId: "restore-copy-2", to: "copy-2.txt" })
	assert.equal(await fs.readFile(path.join(f.root, "copy-1.txt"), "utf8"), "retained remote replacement")
	assert.equal(await fs.readFile(path.join(f.root, "copy-2.txt"), "utf8"), "retained remote replacement")
	assert.equal((await f.files.recovery()).items[0].id, record.id)
})

test("workspace: restart reconstructs a proved upload observation and capture relation", async (t) => {
	const f = await fixture(t)
	const published = (await upload(f.files, "recover-upload", "recovered-upload.txt", "published before restart")).operation
	const interrupted = { ...published, state: "publishing", committedAt: null, localGeneration: null, publishedObservation: null }
	await f.files.state.put("operations", interrupted.operationId, interrupted)
	const captureRecord = await f.files.state.get("captures", published.publishedSource.captureId)
	await f.files.state.put("captures", captureRecord.id, { ...captureRecord, sourceObservation: null })

	await f.restart()
	const recovered = await f.files.operation(interrupted.operationId)
	const current = await f.files.stat("recovered-upload.txt")
	assert.equal(recovered.state, "committed")
	assert.equal(recovered.publishedObservation.token, current.observation.token)
	assert.equal((await f.files.state.get("captures", published.publishedSource.captureId)).sourceObservation.token, current.observation.token)
})

test("workspace: restart republishes deleted-entry recovery after a proved trash move", async (t) => {
	const f = await fixture(t)
	await upload(f.files, "delete-crash-source", "deleted-before-receipt.txt", "recover after restart")
	const deleted = (await f.files.delete({ operationId: "delete-before-receipt", path: "deleted-before-receipt.txt", baseObservation: (await f.files.stat("deleted-before-receipt.txt")).observation.token })).operation
	const interrupted = { ...deleted, state: "publishing", committedAt: null, localGeneration: null }
	delete interrupted.trash
	delete interrupted.tombstones
	await f.files.state.put("operations", interrupted.operationId, interrupted)
	await f.files.state.delete("recovery", interrupted.evidence.recovery.id)

	await f.restart()
	const recovered = await f.files.operation(interrupted.operationId)
	assert.equal(recovered.state, "committed")
	assert.equal(recovered.trash.state, "retained")
	const [item] = (await f.files.recovery()).items
	assert.equal(item.id, interrupted.evidence.recovery.id)
	assert.equal(item.original.path, "deleted-before-receipt.txt")
})

test("workspace: digest mismatch and conditional HTTP failure never publish over a target", async (t) => {
	const f = await fixture(t)
	await upload(f.files, "source", "a.txt", "same")
	await assert.rejects(upload(f.files, "bad-hash", "a.txt", "evil", { mode: "force-replace", declaredDigest: crypto.createHash("sha256").update("other").digest("hex") }), { error: "digest_mismatch" })
	await assert.rejects(upload(f.files, "strong-live", "a.txt", "evil", { mode: "force-replace", ifMatch: `"${(await f.files.stat("a.txt")).observation.token}"` }), { status: 412 })
	assert.equal(await fs.readFile(path.join(f.root, "a.txt"), "utf8"), "same")
})

test("workspace: recovery never replays a publishing operation with uncertain address association", async (t) => {
	const f = await fixture(t)
	await f.files.state.put("operations", "crash", { operationId: "crash", state: "publishing", action: "upload", addresses: [f.files.ref("missing")], publishedSource: null, acceptedAt: new Date().toISOString(), committedAt: null, persistence: {}, reconciliation: { required: false, inspectionRef: null, replayAllowed: false }, evidence: { candidate: { dev: "1", ino: "2" }, parent: { dev: "1", ino: "3" }, path: "missing" } })
	await f.restart()
	assert.equal((await f.files.operation("crash")).state, "indeterminate")
	await assert.rejects(fs.stat(path.join(f.root, "missing")), { code: "ENOENT" })
})

test("workspace: held-source capacity rejects new bytes without evicting receipt evidence", async (t) => {
	const f = await fixture(t)
	f.files.captures.limits.retainedBytes = 3
	const first = await upload(f.files, "held", "first.txt", "old")
	await assert.rejects(upload(f.files, "over", "second.txt", "x"), { status: 507, error: "insufficient_storage" })
	const opened = await f.files.captures.open("capture", first.operation.publishedSource.captureId)
	try { assert.equal((await f.files.captures.text("capture", first.operation.publishedSource.captureId)).text, "old") } finally { await opened.release() }
	await assert.rejects(fs.stat(path.join(f.root, "second.txt")), { code: "ENOENT" })
})

test("workspace: a subsequent namespace replacement cannot associate published bytes with another Current inode", async (t) => {
	const f = await fixture(t)
	f.files.config.filesCheckpoint = async (stage, op) => {
		if (stage !== "published" || op.operationId !== "publish") return
		await fs.writeFile(path.join(f.root, "other"), "external")
		await fs.rename(path.join(f.root, "other"), path.join(f.root, "a.txt"))
	}
	const published = await upload(f.files, "publish", "a.txt", "managed")
	assert.equal(published.operation.state, "committed")
	assert.equal(published.operation.publishedObservation, null)
	const current = await f.files.stat("a.txt")
	const capture = await f.files.captures.create({ requestId: "after-replacement", path: "a.txt", baseObservation: current.observation.token })
	assert.equal((await f.files.captures.text("capture", capture.source.captureId)).text, "external")
	assert.equal((await f.files.captures.text("capture", published.operation.publishedSource.captureId)).text, "managed")
})

test("workspace: valid dot operation IDs delete safely without becoming trash traversal", async (t) => {
	const f = await fixture(t)
	for (const id of [".", ".."]) {
		const name = id === "." ? "one.txt" : "two.txt"
		await upload(f.files, `create-${name}`, name, "x")
		const base = (await f.files.stat(name)).observation
		assert.equal((await f.files.delete({ operationId: id, path: name, baseObservation: base.token })).operation.state, "committed")
		await assert.rejects(fs.stat(path.join(f.root, name)), { code: "ENOENT" })
	}
})

test("workspace: restart proves completed mkdir while retaining uncertainty for a partially created parent chain", async (t) => {
	const f = await fixture(t)
	const made = (await f.files.mkdir({ operationId: "made", path: "made", parents: false })).operation
	await f.files.state.put("operations", "made", { ...made, state: "publishing", committedAt: null, localGeneration: null })
	const parent = (await f.files.mkdir({ operationId: "parent", path: "parent", parents: false })).operation
	await f.files.state.put("operations", "partial", { ...parent, operationId: "partial", intent: { action: "mkdir", path: "parent/child", parents: true }, addresses: [f.files.ref("parent/child")], state: "publishing", committedAt: null, localGeneration: null })
	await f.restart()
	assert.equal((await f.files.operation("made")).state, "committed")
	assert.equal((await f.files.operation("partial")).state, "indeterminate")
	await assert.rejects(fs.stat(path.join(f.root, "parent/child")), { code: "ENOENT" })
})

test("workspace: restart collects only proven aborted staging and preserves a replaced candidate", async (t) => {
	const f = await fixture(t)
	const parent = await fs.stat(f.root, { bigint: true }), parentIdentity = { dev: String(parent.dev), ino: String(parent.ino) }
	for (const replaced of [false, true]) {
		const id = replaced ? "replacement" : "aborted", candidateName = `.gc-file-${crypto.randomUUID()}`, stagingName = crypto.randomUUID()
		const candidatePath = path.join(f.root, candidateName)
		await fs.writeFile(candidatePath, "candidate", { mode: 0o600 }); const candidate = await fs.stat(candidatePath, { bigint: true })
		if (replaced) { await fs.rename(candidatePath, path.join(f.root, "moved-candidate")); await fs.writeFile(candidatePath, "replacement", { mode: 0o600 }) }
		await fs.writeFile(path.join(f.config.filesStateDir, "staging", stagingName), "staged body", { mode: 0o600 })
		await f.files.state.put("operations", id, { operationId: id, action: "upload", intent: { path: `${id}.txt` }, state: "staged", addresses: [f.files.ref(`${id}.txt`)], publishedSource: null, committedAt: null, acceptedAt: new Date().toISOString(), persistence: { state: "not-configured" }, reconciliation: { required: false, inspectionRef: null, replayAllowed: false }, stagingName, evidence: { candidateName, candidate: { dev: String(candidate.dev), ino: String(candidate.ino) }, parent: parentIdentity, parentPath: "", path: `${id}.txt` } })
	}
	await f.restart()
	const aborted = await f.files.operation("aborted"), replacement = await f.files.operation("replacement")
	assert.equal(aborted.state, "aborted-before-publication")
	await assert.rejects(fs.stat(path.join(f.root, aborted.evidence.candidateName)), { code: "ENOENT" })
	await assert.rejects(fs.stat(path.join(f.config.filesStateDir, "staging", aborted.stagingName)), { code: "ENOENT" })
	assert.equal(await fs.readFile(path.join(f.root, replacement.evidence.candidateName), "utf8"), "replacement")
	assert.equal(replacement.cleanup.state, "blocked")
})

test("workspace: a transient trash cleanup failure is visible and retried without losing its receipt", async (t) => {
	const f = await fixture(t)
	await upload(f.files, "trash-source", "remove.txt", "bytes")
	await f.files.delete({ operationId: "trash", path: "remove.txt", baseObservation: (await f.files.stat("remove.txt")).observation.token })
	const op = await f.files.operation("trash"); op.trash.cleanupAfter = new Date(0).toISOString(); await f.files.state.put("operations", "trash", op)
	const unlink = f.files.safeFs.unlink.bind(f.files.safeFs); let fail = true
	f.files.safeFs.unlink = async (...args) => { if (fail && args[1] === op.trash.name) { fail = false; throw Object.assign(new Error("temporary I/O failure"), { code: "EIO" }) } return unlink(...args) }
	await f.files.sweep()
	const blocked = await f.files.operation("trash")
	assert.equal(blocked.trash.state, "cleanup-blocked"); assert.equal(blocked.state, "committed")
	blocked.trash.retryAfter = new Date(0).toISOString(); await f.files.state.put("operations", "trash", blocked)
	await f.files.sweep()
	assert.equal((await f.files.operation("trash")).trash.state, "cleaned")
	await assert.rejects(fs.stat(path.join(f.config.filesStateDir, "trash", op.trash.name)), { code: "ENOENT" })
})

test("workspace: cleanup restart finishes a proved private move and preserves mismatched inspection bytes", async (t) => {
	const f = await fixture(t)
	const parent = await fs.stat(f.root, { bigint: true }), parentIdentity = { dev: String(parent.dev), ino: String(parent.ino) }
	for (const mismatch of [false, true]) {
		const id = mismatch ? "bad-cleanup" : "good-cleanup", name = `.gc-file-${crypto.randomUUID()}`, garbageName = `cleanup-${crypto.randomUUID()}`
		await fs.writeFile(path.join(f.root, name), "original", { mode: 0o600 }); const stat = await fs.stat(path.join(f.root, name), { bigint: true }), candidate = { dev: String(stat.dev), ino: String(stat.ino) }
		if (!mismatch) await fs.rename(path.join(f.root, name), path.join(f.config.filesStateDir, "trash", garbageName))
		else await fs.writeFile(path.join(f.config.filesStateDir, "trash", garbageName), "inspection replacement", { mode: 0o600 })
		const evidence = { candidateName: name, candidate, parent: parentIdentity, parentPath: "", path: "unused" }
		await f.files.state.put("operations", id, { operationId: id, action: "upload", intent: { path: "unused" }, state: "aborted-before-publication", addresses: [f.files.ref("unused")], acceptedAt: new Date().toISOString(), committedAt: null, publishedSource: null, persistence: { state: "not-configured" }, evidence, cleanup: { state: "pending", pendingTrash: { name: garbageName, candidate, state: "moving", source: { ...evidence, name } } } })
	}
	await f.restart()
	assert.equal((await f.files.operation("good-cleanup")).cleanup.state, "cleaned")
	const bad = await f.files.operation("bad-cleanup")
	assert.equal(bad.cleanup.state, "indeterminate")
	assert.equal(await fs.readFile(path.join(f.config.filesStateDir, "trash", bad.cleanup.pendingTrash.name), "utf8"), "inspection replacement")
})
