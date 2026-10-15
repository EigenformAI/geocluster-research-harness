import path from "node:path"
import { Worker } from "node:worker_threads"
import { FileError, identifier } from "./file-contract.js"

const unavailable = (message) => new FileError(503, "storage_unavailable", `FileState: ${message}`, {
	agent: "file-service", tool: "file-state", action: "Inspect file-state storage and restart the file service.",
})

// Validate on both sides of the worker boundary: byte buffers never enter its message queue.
export function validateMetadata(value, seen = new Set()) {
	if (value === null || typeof value === "string" || typeof value === "boolean" || (typeof value === "number" && Number.isFinite(value))) return
	const invalid = () => new FileError(400, "invalid_state_value", "FileState accepts JSON metadata only; store source bytes outside SQLite.", { agent: "file-service", tool: "file-state", action: "Supply finite JSON values and dense arrays; retain source bytes separately." })
	if (!value || typeof value !== "object" || ArrayBuffer.isView(value) || value instanceof ArrayBuffer || seen.has(value) || (!Array.isArray(value) && Object.getPrototypeOf(value) !== Object.prototype)) throw invalid()
	seen.add(value)
	if (Array.isArray(value)) {
		if (Object.keys(value).length !== value.length) throw invalid()
		for (let index = 0; index < value.length; index++) { if (!Object.hasOwn(value, index)) throw invalid(); validateMetadata(value[index], seen) }
	} else for (const child of Object.values(value)) if (child !== undefined) validateMetadata(child, seen)
	seen.delete(value)
}

export function validateVoxelStateRequest(type, args) {
	validateMetadata(args)
	const invalid = () => { throw new FileError(400, "invalid_state_operation", "Supply a bounded named-voxel metadata request.") }
	if (type === "voxel-artifact-delete") {
		identifier(args.id, "artifactId"); identifier(args.key, "idempotencyKey")
		if (typeof args.generation !== "string" || !args.generation || args.generation.length > 64 || !args.requester || Object.keys(args).some((k) => !["id", "generation", "key", "requester"].includes(k))) invalid()
	} else if (type === "voxel-named-list") {
		if (!Number.isSafeInteger(args.limit) || args.limit < 1 || args.limit > 100 || typeof args.after !== "string" || args.name !== null && (typeof args.name !== "string" || !args.name.trim() || args.name.length > 256 || args.name.includes("\0")) || Object.keys(args).some((k) => !["limit", "after", "name"].includes(k))) invalid()
		if (args.after) identifier(args.after, "cursor id")
	} else {
		identifier(args.id, "voxel operation or record id")
		if (type === "voxel-named-rename") {
			if (typeof args.name !== "string" || !args.name.trim() || args.name.length > 256 || args.name.includes("\0") || typeof args.expectedHeadRevision !== "string" || !args.expectedHeadRevision || args.expectedHeadRevision.length > 256 || Object.keys(args).some((k) => !["id", "name", "expectedHeadRevision"].includes(k))) invalid()
		} else if (Object.keys(args).some((k) => k !== "id")) invalid()
	}
}

/** One SQLite connection in a worker; the serving thread only sends metadata messages. */
export class FileState {
	static async open({ dir } = {}) {
		if (typeof dir !== "string" || !path.isAbsolute(dir)) throw unavailable("dir must be an absolute private-state directory.")
		const worker = new Worker(new URL("./file-state-worker.js", import.meta.url), { workerData: { dir }, execArgv: [] })
		const state = new FileState(worker)
		try { await state.ready; return state } catch (error) { await worker.terminate(); throw error }
	}

	constructor(worker) {
		this.worker = worker
		this.pending = new Map()
		this.sequence = 0
		this.closed = false
		this.ready = new Promise((resolve, reject) => { this.resolveReady = resolve; this.rejectReady = reject })
		worker.on("message", (message) => {
			if (message.ready) {
				this.identity = Object.freeze(message.identity)
				this.resolveReady()
				return
			}
			const error = message.error && new FileError(message.error.status, message.error.error, message.error.message, message.error.details)
			if (message.fatal) { this.fail(error); return }
			const pending = this.pending.get(message.sequence)
			if (!pending) return
			this.pending.delete(message.sequence)
			if (error) pending.reject(error)
			else pending.resolve(message.result)
		})
		worker.on("error", (error) => this.fail(unavailable(error.message)))
		worker.on("exit", (code) => {
			if (!this.closed || this.pending.size) this.fail(unavailable(`database worker exited (${code}).`))
		})
	}

	fail(error) {
		this.closed = true
		this.rejectReady(error)
		for (const pending of this.pending.values()) pending.reject(error)
		this.pending.clear()
	}

	async call(type, args) {
		if (this.closed || (this.closing && type !== "close")) throw unavailable("database worker is closed or closing.")
		try {
			if (type.startsWith("voxel-named-") || type === "voxel-artifact-delete") validateVoxelStateRequest(type, args)
			else if (!["close", "transaction"].includes(type)) { identifier(args.kind, "record kind"); if (type !== "list") identifier(args.id, "record id") }
			if (type === "put") validateMetadata(args.value)
			if (type === "claim") { validateMetadata(args.intent); validateMetadata(args.record) }
			if (type === "transaction") {
				if (!Array.isArray(args.operations)) throw new FileError(400, "invalid_state_operation", "A transaction must be an array of put/delete operations.")
				for (const op of args.operations) {
					if (!op || !["put", "delete"].includes(op.type)) throw new FileError(400, "invalid_state_operation", "A transaction accepts only put/delete operations.")
					identifier(op.kind, "record kind"); identifier(op.id, "record id")
					if (op.type === "put") validateMetadata(op.value)
				}
			}
		} catch (error) {
			if (error instanceof FileError) { error.agent = "file-service"; error.tool = "file-state"; error.action ||= "Supply JSON metadata with valid identifiers and put/delete operations." }
			throw error
		}
		await this.ready
		if (this.closed) throw unavailable("database worker is closed.")
		const sequence = ++this.sequence
		return new Promise((resolve, reject) => {
			this.pending.set(sequence, { resolve, reject })
			try { this.worker.postMessage({ sequence, type, args }) } catch (error) {
				this.pending.delete(sequence)
				reject(unavailable(error.message))
			}
		})
	}

	get(kind, id) { return this.call("get", { kind, id }) }
	put(kind, id, value) { return this.call("put", { kind, id, value }) }
	delete(kind, id) { return this.call("delete", { kind, id }) }
	// Claims are insert-only and outlive their records: whether this epoch ever admitted the ID.
	wasClaimed(kind, id) { return this.call("was-claimed", { kind, id }) }
	list(kind) { return this.call("list", { kind }) }
	transaction(operations) { return this.call("transaction", { operations }) }
	claim(kind, id, intent, record) { return this.call("claim", { kind, id, intent, record }) }
	voxelNamedCommit(id) { return this.call("voxel-named-commit", { id }) }
	voxelNamedList({ limit, after = "", name = null }) { return this.call("voxel-named-list", { limit, after, name }) }
	voxelNamedByArtifact(artifactId) { return this.call("voxel-named-by-artifact", { id: artifactId }) }
	voxelNamedRename(id, name, expectedHeadRevision) { return this.call("voxel-named-rename", { id, name, expectedHeadRevision }) }
	voxelArtifactDelete(args) { return this.call("voxel-artifact-delete", args) }

	close() {
		if (this.closing) return this.closing
		if (this.closed) return Promise.resolve()
		this.closing = this.call("close", {}).then(async () => {
			this.closed = true
			await this.worker.terminate()
		})
		return this.closing
	}
}
