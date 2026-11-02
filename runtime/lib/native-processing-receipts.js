import fs from "node:fs/promises"
import { constants } from "node:fs"
import path from "node:path"
import { randomUUID } from "node:crypto"
import { spawn } from "node:child_process"
import { ProcessingError } from "./processing-operations.js"
import { stableStringify } from "./file-contract.js"

const failure = (code, message) => new ProcessingError(code, message)
const privateStat = (stat, directory = false) => (directory ? stat.isDirectory() : stat.isFile()) && stat.uid === process.geteuid() && (stat.mode & 0o7777) === (directory ? 0o700 : 0o600) && (directory || stat.nlink === 1)
export const fdPath = (handle, name = "") => `/proc/self/fd/${handle.fd}${name ? `/${name}` : ""}`

/** Walk through directory descriptors so a pathname replacement cannot redirect effects. */
export async function openNativeDirectory(directory, { create = false, privateMode = false } = {}) {
	if (!path.isAbsolute(directory) || path.normalize(directory) !== directory) throw failure("INVALID_PATH", "Use a canonical absolute directory.")
	let current = await fs.open("/", constants.O_RDONLY | constants.O_DIRECTORY)
	try {
		const parts = directory.split("/").filter(Boolean)
		for (let i = 0; i < parts.length; i++) {
			const entry = fdPath(current, parts[i])
			if (create) { try { await fs.mkdir(entry, { mode: 0o700 }); await current.sync() } catch (error) { if (error.code !== "EEXIST") throw error } }
			const next = await fs.open(entry, constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW)
			await current.close(); current = next
			if (privateMode && i === parts.length - 1 && !privateStat(await current.stat(), true)) throw failure("UNSAFE_CLIENT_DIRECTORY", "The native client directory must be owned by this user and mode 0700.")
		}
		return current
	} catch (error) { await current.close(); throw error }
}

export async function readPrivateJSON(directory, name, maxBytes = 1024 * 1024) {
	const handle = await fs.open(fdPath(directory, name), constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK)
	try {
		const stat = await handle.stat()
		// Exclusive publication uses link+unlink. A crash between those calls may
		// retain the private temporary link; it must not make committed intent unreadable.
		if (!stat.isFile() || stat.uid !== process.geteuid() || (stat.mode & 0o7777) !== 0o600 || stat.size > maxBytes) throw failure("INVALID_RECEIPT", "Native records must be bounded private regular files.")
		const bytes = Buffer.alloc(maxBytes + 1); let count = 0
		while (count < bytes.length) { const { bytesRead } = await handle.read(bytes, count, bytes.length - count, null); if (!bytesRead) break; count += bytesRead }
		if (count > maxBytes) throw failure("INVALID_RECEIPT", "Native record exceeds the byte ceiling.")
		return JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes.subarray(0, count)))
	} finally { await handle.close() }
}

export async function publishPrivateJSON(directory, name, value, { exclusive = false } = {}) {
	const temporary = `.${name}.${randomUUID()}.tmp`, temporaryPath = fdPath(directory, temporary), destination = fdPath(directory, name)
	let handle
	try {
		handle = await fs.open(temporaryPath, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW, 0o600)
		await handle.writeFile(JSON.stringify(value)); await handle.sync(); await handle.close(); handle = null
		if (exclusive) { await fs.link(temporaryPath, destination); await fs.unlink(temporaryPath) }
		else await fs.rename(temporaryPath, destination)
		await directory.sync()
	} finally { await handle?.close(); await fs.unlink(temporaryPath).catch((error) => { if (error.code !== "ENOENT") throw error }) }
}

/** flock(2) attaches to this retained open file description, not to the short-lived helper. */
export async function acquireNativeProcessingLease({ clientDir, helperTimeoutMs = 2000 }) {
	const directory = await openNativeDirectory(clientDir, { create: true, privateMode: true })
	let handle
	try {
		handle = await fs.open(fdPath(directory, "writer.lock"), constants.O_RDWR | constants.O_CREAT | constants.O_NOFOLLOW | constants.O_NONBLOCK, 0o600)
		if (!privateStat(await handle.stat())) throw failure("UNSAFE_WRITER_LOCK", "The writer lock must be a private regular file.")
		await new Promise((resolve, reject) => {
			const helper = spawn("flock", ["--exclusive", "--nonblock", "3"], { stdio: ["ignore", "ignore", "ignore", handle.fd] })
			const timer = setTimeout(() => { helper.kill("SIGKILL"); reject(failure("LOCK_HELPER_TIMEOUT", "Native writer lock acquisition exceeded its deadline.")) }, helperTimeoutMs)
			helper.once("error", () => { clearTimeout(timer); reject(failure("LOCK_HELPER_UNAVAILABLE", "Install util-linux flock before starting native processing.")) })
			helper.once("close", (code) => { clearTimeout(timer); code === 0 ? resolve() : reject(failure("WRITER_IN_USE", "Another native bridge still owns this workspace's document effects.")) })
		})
		const effects = new Set(); let released = false
		return {
			clientDir, directory, get fd() { return handle.fd }, get released() { return released },
			track(work) {
				if (released) throw failure("DRAINING", "Native writer lease has been released.")
				const active = Promise.resolve(work); effects.add(active); active.then(() => effects.delete(active), () => effects.delete(active)); return active
			},
			spawnEffect(command, args, options = {}) {
				if (released) throw failure("DRAINING", "Native writer lease has been released.")
				const child = spawn(command, args, { ...options, stdio: ["ignore", "ignore", "ignore", handle.fd] })
				this.track(new Promise((resolve) => { child.once("close", resolve); child.once("error", resolve) }))
				return child
			},
			async join() { await Promise.allSettled([...effects]) },
			async release() {
				if (released) return
				if (effects.size) throw failure("CLEANUP_UNVERIFIED", "Native effects remain active; writer exclusion is retained.")
				released = true
				// Never LOCK_UN: a surviving inherited effect descriptor must keep the lease.
				await handle.close(); await directory.close()
			},
		}
	} catch (error) { await handle?.close(); await directory.close(); throw error }
}

export class NativeProcessingReceipts {
	static async open({ lease, scope }) {
		if (!lease || lease.released) throw failure("WRITER_LEASE_REQUIRED", "Acquire native writer exclusion before opening receipts.")
		const directories = {}
		try {
			for (const kind of ["requests", "exports"]) {
				try { await fs.mkdir(fdPath(lease.directory, kind), { mode: 0o700 }); await lease.directory.sync() } catch (error) { if (error.code !== "EEXIST") throw error }
				directories[kind] = await fs.open(fdPath(lease.directory, kind), constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW)
				if (!privateStat(await directories[kind].stat(), true)) throw failure("INVALID_RECEIPT", "Receipt directories must be private real directories.")
			}
		} catch (error) { await Promise.all(Object.values(directories).map((directory) => directory.close())); throw error }
		return new NativeProcessingReceipts({ lease, scope, directories })
	}
	constructor(options) { Object.assign(this, options); this.queues = new Map() }
	name(id) { if (typeof id !== "string" || !/^[a-zA-Z0-9_-]{1,128}$/.test(id)) throw failure("INVALID_REQUEST", "Invalid native request handle."); return `${id}.json` }
	async get(id, kind = "requests") {
		const value = await readPrivateJSON(this.directories[kind], this.name(id))
		if (stableStringify(value.scope) !== stableStringify(this.scope)) throw failure("PROCESSING_STORE_CHANGED", "This receipt belongs to a different workspace or processor store. Restore the original store before recovery.")
		return value
	}
	async claim(value, kind = "requests") {
		try { await publishPrivateJSON(this.directories[kind], this.name(value.requestId || value.exportId), value, { exclusive: true }); return value }
		catch (error) { if (error.code !== "EEXIST") throw error; return this.get(value.requestId || value.exportId, kind) }
	}
	serial(id, work) {
		const previous = this.queues.get(id) || Promise.resolve(), active = previous.catch(() => {}).then(work)
		this.queues.set(id, active); active.finally(() => { if (this.queues.get(id) === active) this.queues.delete(id) }).catch(() => {})
		return active
	}
	update(id, mutate, kind = "requests", expectedRevision) {
		return this.serial(`${kind}/${id}`, async () => {
			const before = await this.get(id, kind)
			if (expectedRevision !== undefined && before.revision !== expectedRevision) throw failure("RECEIPT_CONFLICT", "Native receipt revision changed; reread the retained handle.")
			const changes = await mutate(structuredClone(before)); if (!changes) return before
			const after = { ...before, ...changes, revision: before.revision + 1, updatedAt: new Date().toISOString() }
			for (const field of ["scope", "origin", "rootId", "identity", "submissionKey", "intent", "inputFingerprint", "jobId", "resultId", "destination", "sha256", "bytes", "overwrite", "productId", "exportId", "requestId"]) {
				if (before[field] !== undefined && before[field] !== null && stableStringify(before[field]) !== stableStringify(after[field])) throw failure("IDEMPOTENCY_CONFLICT", `Retained ${field} cannot change.`)
			}
			if (before.cancelRequested && !after.cancelRequested || before.state === "accepted" && after.state !== "accepted") throw failure("RECEIPT_CONFLICT", "Cancellation and acceptance evidence cannot regress.")
			await publishPrivateJSON(this.directories[kind], this.name(id), after); return after
		})
	}
	async list(kind = "requests") { const names = await fs.readdir(fdPath(this.directories[kind])); return Promise.all(names.filter((name) => /^[A-Za-z0-9_-]+\.json$/.test(name)).map((name) => this.get(name.slice(0, -5), kind))) }
	async close() { await Promise.allSettled([...this.queues.values()]); await Promise.all(Object.values(this.directories).map((directory) => directory.close())) }
}
