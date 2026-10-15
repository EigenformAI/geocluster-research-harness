import { AsyncLocalStorage } from "node:async_hooks"
import crypto from "node:crypto"
import { createRequire } from "node:module"
import { Readable } from "node:stream"
import { SafeFsError, SafePolicy, canonicalPath, contains, isReserved } from "./policy.js"

export { SafeFsError, SafePolicy, canonicalPath } from "./policy.js"
const require = createRequire(import.meta.url)
let binding
function native() {
	if (process.platform !== "linux") throw new SafeFsError("ENOSYS", "load", "Native Linux is required; no pathname fallback is available.")
	if (!binding) {
		try { binding = require("./build/safe_fs.node") }
		catch (cause) { throw new SafeFsError("ENOSYS", "load", "Build the native binding with node lib/safe-fs/build.mjs before opening a workspace.", { cause }) }
	}
	return binding
}

// Registration, parent acquisition, and mutations share a process-wide lock.
// withLock permits a caller's larger transaction to use these same methods.
const context = new AsyncLocalStorage()
let tail = Promise.resolve()
function scope(work) {
	const token = { active: true, children: Promise.resolve() }
	return context.run(token, async () => {
		try { return await work() }
		finally {
			// Promise.all may reject before its siblings finish. Drain all admitted
			// children, including descendants queued while an earlier tail settles.
			for (;;) { const pending = token.children; await pending; if (token.children === pending) break }
			token.active = false
		}
	})
}
function locked(work) {
	const parent = context.getStore()
	if (parent?.active) {
		const result = parent.children.then(() => scope(work))
		parent.children = result.catch(() => {}) // The operation's own promise retains its rejection.
		return result
	}
	const result = tail.then(() => scope(work))
	tail = result.catch(() => {}) // Rejection is delivered to the caller, never suppressed there.
	return result
}

const identity = (stat) => Object.freeze({ dev: String(stat.dev), ino: String(stat.ino) })
const same = (a, b) => a && b && String(a.dev) === String(b.dev) && String(a.ino) === String(b.ino)
const join = (parent, name) => !name ? parent : parent === "/" ? `/${name}` : parent ? `${parent}/${name}` : name
const parts = (name) => { const i = name.lastIndexOf("/"); return { path: i < 0 ? "" : name.slice(0, i), name: name.slice(i + 1) } }
const missing = (error) => error.code === "ENOENT"
const stale = (path) => new SafeFsError("ESTALE", "parent", "The held parent no longer occupies its captured root address.", { reason: "parent_moved", path })
const staging = (name) => /^\.gc-file-[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(name)
const typeNames = new Map([[1, "fifo"], [2, "character"], [4, "directory"], [6, "block"], [8, "file"], [10, "symlink"], [12, "socket"]])
const decoder = new TextDecoder("utf-8", { fatal: true, ignoreBOM: true })

function absolute(value) {
	if (typeof value !== "string" || !value.startsWith("/")) throw new SafeFsError("EINVAL", "root", "Use a canonical absolute root path.")
	canonicalPath(value === "/" ? "" : value.slice(1))
	return value
}
function mode(value) {
	if (!Number.isInteger(value) || value < 0 || value > 0o7777) throw new SafeFsError("EINVAL", "mode", "Use a POSIX mode from 0 to 07777.")
	return value
}
function limit(value, name) {
	if (!Number.isSafeInteger(value) || value < 1) throw new SafeFsError("EINVAL", "limit", `${name} must be a positive safe integer.`)
	return value
}
function entryName(bytes) {
	try { const name = decoder.decode(bytes); canonicalPath(name, { root: false }); if (name.includes("/")) throw new Error("not a component"); return name }
	catch { return null }
}
function diagnostic(code, message) { return { code, message, agent: "file-service", tool: "safe-fs.entries", action: "Rename the unaddressable entry using a trusted filesystem tool." } }

class Stat {
	constructor(raw, bigint) {
		for (const name of ["atime", "mtime", "ctime"]) {
			raw[`${name}Ns`] = raw[`${name}Seconds`] * 1000000000n + raw[`${name}Nanoseconds`]
			delete raw[`${name}Seconds`]; delete raw[`${name}Nanoseconds`]
		}
		for (const [name, value] of Object.entries(raw)) if (bigint || !name.endsWith("Ns")) this[name] = bigint ? value : Number(value)
		for (const name of ["atime", "mtime", "ctime", "birthtime"]) {
			this[`${name}Ms`] = bigint ? raw[`${name}Ns`] / 1000000n : Number(raw[`${name}Ns`]) / 1e6
			this[name] = new Date(Number(raw[`${name}Ns`]) / 1e6)
		}
	}
	isFile() { return (Number(this.mode) & 0o170000) === 0o100000 }
	isDirectory() { return (Number(this.mode) & 0o170000) === 0o040000 }
	isSymbolicLink() { return (Number(this.mode) & 0o170000) === 0o120000 }
	isFIFO() { return (Number(this.mode) & 0o170000) === 0o010000 }
	isSocket() { return (Number(this.mode) & 0o170000) === 0o140000 }
	isCharacterDevice() { return (Number(this.mode) & 0o170000) === 0o020000 }
	isBlockDevice() { return (Number(this.mode) & 0o170000) === 0o060000 }
}

// Native handles and provenance live in a WeakMap. Public fd numbers are accepted
// for known live parents, but never used to recover authority after fd reuse.
const descriptors = new WeakMap()
const byFd = new Map()
function state(descriptor) {
	const value = descriptors.get(descriptor)
	if (!value || value.closing) throw new SafeFsError("EBADF", "descriptor", "Use a live SafeFs descriptor.")
	return value
}
function resolveDescriptor(value) {
	const descriptor = typeof value === "number" ? byFd.get(value)?.deref() : value?.handle instanceof Descriptor ? value.handle : value
	state(descriptor)
	return descriptor
}

export class Descriptor {
	constructor(token, owner, path, { metadata = false, store = false, parentIdentity = null } = {}) {
		descriptors.set(this, { token, owner, path, metadata, store, parentIdentity, closing: null })
		byFd.set(token.fd, new WeakRef(this))
		owner.handles.add(this)
	}
	get fd() { const value = descriptors.get(this); return value.closing ? -1 : value.token.fd }
	get path() { return descriptors.get(this).path }
	async stat({ bigint = false } = {}) { return new Stat(await native().stat(state(this).token), bigint) }
	async acl() { return native().acl(state(this).token) }
	async read(buffer, offset = 0, length = buffer?.length - offset, position = null) {
		if (!Buffer.isBuffer(buffer) && buffer && typeof buffer === "object") ({ buffer, offset = 0, length = buffer?.length - offset, position = null } = buffer)
		const value = state(this)
		if (value.metadata) throw new SafeFsError("EBADF", "read", "Metadata descriptors cannot read bytes.")
		const bytesRead = await native().read(value.token, buffer, offset, length, position)
		return { bytesRead, buffer }
	}
	async write(buffer, offset = 0, length = buffer?.length - offset, position = null) {
		if (typeof buffer === "string") {
			const stringPosition = arguments.length > 1 && arguments[1] !== undefined ? offset : null
			const encoding = typeof length === "string" ? length : "utf8"
			const bytes = Buffer.from(buffer, encoding)
			const bytesWritten = await native().write(state(this).token, bytes, 0, bytes.length, stringPosition)
			return { bytesWritten, buffer }
		}
		const bytesWritten = await native().write(state(this).token, buffer, offset, length, position)
		return { bytesWritten, buffer }
	}
	async sync() { await native().sync(state(this).token) }
	createReadStream(options = {}) {
		state(this)
		const descriptor = this, { start, end = Infinity, autoClose = true, ...streamOptions } = options
		if ((start !== undefined && (!Number.isSafeInteger(start) || start < 0)) || (end !== Infinity && (!Number.isSafeInteger(end) || end < (start ?? 0)))) throw new SafeFsError("EINVAL", "stream", "Use nonnegative inclusive byte offsets with end >= start.")
		let position = start ?? null, remaining = end === Infinity ? Infinity : end - (start ?? 0) + 1, reading = false
		return new Readable({ ...streamOptions,
			read(size) {
				if (reading) return
				if (!remaining) { this.push(null); return }
				reading = true
				const buffer = Buffer.alloc(Math.min(Math.max(1, size), remaining, 1024 * 1024))
				descriptor.read(buffer, 0, buffer.length, position).then(({ bytesRead }) => {
					reading = false
					if (this.destroyed) return
					if (position !== null) position += bytesRead
					remaining -= bytesRead
					this.push(bytesRead ? buffer.subarray(0, bytesRead) : null)
				}, (error) => { reading = false; this.destroy(error) })
			},
			destroy(error, done) { if (autoClose) descriptor.close().then(() => done(error), (failure) => done(error || failure)); else done(error) },
		})
	}
	close() {
		const value = descriptors.get(this)
		if (!value.closing) {
			byFd.delete(value.token.fd)
			value.closing = native().close(value.token).finally(() => { value.owner.handles.delete(this) })
		}
		return value.closing
	}
	[Symbol.asyncDispose]() { return this.close() }
}

export class SafeFs {
	constructor(root, options) {
		Object.defineProperty(this, "root", { value: root, enumerable: true })
		this.handles = new Set()
		this.anchors = new Set()
		this._generation = 0
		this.noXdev = Boolean(options.noXdev)
		this.scanLimit = limit(options.scanLimit ?? 10000, "scanLimit")
		this.policy = new SafePolicy(options)
		this.policy.bind((entry) => this.withLock(() => this._register(entry)))
	}
	get generation() { return this._generation }
	static async open(root, options = {}) {
		absolute(root)
		return locked(async () => {
			const fs = new SafeFs(root, options)
			try {
				fs.rootHandle = new Descriptor(await native().openRoot(root), fs, "")
				fs.anchors.add(fs.rootHandle)
				for (const entry of fs.policy.roots) await fs._pinRegistration(entry)
				return fs
			} catch (error) { await fs.close(); throw error }
		})
	}
	withLock(work) {
		return locked(() => {
			if (this.closed || this.closing) throw new SafeFsError("EBADF", "workspace", "The workspace is closed.")
			return work()
		})
	}
	_wrap(token, path, options) { return new Descriptor(token, this, path, options) }
	async _rawOpen(parent, path, options = {}) {
		const value = state(parent)
		return this._wrap(await native().open(value.token, path || ".", options.metadata ? 2 : options.directory ? 1 : 0, (options.noXdev ?? this.noXdev) ? 1 : 0), !path || path === "." ? value.path : join(value.path, path), { ...options, store: value.store })
	}
	async _policyOpen(parent, path, options = {}, access = "read") {
		const held = [], components = path ? path.split("/") : [], full = join(state(parent).path, path)
		let current = parent, parentStat, finalStat
		try {
			finalStat = await current.stat({ bigint: true })
			this.policy.assertIdentity(finalStat, access)
			for (let i = 0; i < components.length; i++) {
				if (!finalStat.isDirectory()) throw new SafeFsError(finalStat.isSymbolicLink() ? "ELOOP" : "ENOTDIR", "open", "An ancestor must be a nonsymlink directory.")
				parentStat = finalStat
				current = await this._rawOpen(current, components[i], { metadata: true, noXdev: options.noXdev })
				held.push(current)
				finalStat = await current.stat({ bigint: true })
				this.policy.assertIdentity(finalStat, access)
			}
			if (!components.length) { current = await this._rawOpen(parent, "", { metadata: true }); held.push(current) }
			// Confirm that the selected capabilities still occupy the root address.
			// The data reopen below uses current itself, never this proof pathname.
			if (full) {
				const proof = await this._rawOpen(this.rootHandle, full, { metadata: true, noXdev: options.noXdev })
				held.push(proof)
				if (!same(finalStat, await proof.stat({ bigint: true }))) throw stale(full)
				if (parentStat) {
					const proofParent = await this._rawOpen(this.rootHandle, parts(full).path, { directory: true, noXdev: options.noXdev })
					held.push(proofParent)
					if (!same(parentStat, await proofParent.stat({ bigint: true }))) throw stale(parts(full).path)
				}
			}
			if (options.metadata) { held.splice(held.indexOf(current), 1); return current }
			return this._wrap(await native().reopen(state(current).token, options.directory ? 1 : 0), full, { store: false })
		} finally { for (const handle of held.reverse()) await handle.close() }
	}
	async _checkPinned(path, access) {
		if (!this.policy.hasPins) return
		let handle
		try { handle = await this._policyOpen(this.rootHandle, path, { metadata: true }, access) }
		catch (error) { if (!missing(error)) throw error }
		finally { await handle?.close() }
	}
	async _open(path, options = {}) {
		this.policy.assertRead(path)
		if (this.policy.hasPins) return this._policyOpen(this.rootHandle, path, options)
		return this._rawOpen(this.rootHandle, path, options)
	}
	open(path, options = {}) { return this.withLock(() => this._open(path, options)) }
	async _stat(path, { allowSymlink = false } = {}) {
		const handle = await this._open(path, { metadata: true })
		try {
			const stat = await handle.stat({ bigint: true })
			if (!allowSymlink && stat.isSymbolicLink()) throw new SafeFsError("ELOOP", "stat", "Final symlinks require allowSymlink: true.", { reason: "symlink" })
			return stat
		} finally { await handle.close() }
	}
	stat(path, options = {}) { return this.withLock(() => this._stat(path, options)) }
	async *entries(path = "") {
		const handle = await this.open(path, { directory: true })
		try {
			for (;;) {
				const entries = await native().entries(state(handle).token)
				if (!entries.length) return
				for (const entry of entries) {
					const name = entryName(entry.name)
					if (name === null) { yield { name: null, type: "unknown", diagnostic: diagnostic("EINVAL", "Entry name is not an addressable canonical UTF-8 component.") }; continue }
					const full = join(path, name)
					if (!this.policy.visible(full)) continue
					try {
						// Recheck physical roots too, including renamed registered directories.
						await this.withLock(() => this._checkPinned(full, "read"))
						let type = typeNames.get(entry.type)
						if (!type) { const s = await this.stat(full, { allowSymlink: true }); type = s.isFile() ? "file" : s.isDirectory() ? "directory" : s.isSymbolicLink() ? "symlink" : "other" }
						yield { name, type }
					} catch (error) {
						if (error.code === "EACCES") continue
						if (["ENOENT", "ELOOP", "ENOTDIR"].includes(error.code)) yield { name, type: "unknown", diagnostic: { code: error.code, message: error.message, agent: error.agent, tool: error.tool, action: error.action } }
						else throw error
					}
				}
			}
		} finally { await handle.close() }
	}
	parent(path) {
		return this.withLock(async () => {
			this.policy.assertRead(canonicalPath(path, { root: false }))
			const address = parts(path), handle = await this._open(address.path, { directory: true })
			const parentIdentity = identity(await handle.stat({ bigint: true }))
			descriptors.get(handle).parentIdentity = parentIdentity
			return { handle, name: address.name, path: address.path, parentIdentity, generation: this.generation }
		})
	}
	async _checkParent(descriptor) {
		const value = state(descriptor)
		if (value.owner !== this && !value.store) throw new SafeFsError("EINVAL", "parent", "Workspace parents must belong to this SafeFs instance.")
		const stat = await descriptor.stat({ bigint: true })
		if (!stat.isDirectory()) throw new SafeFsError("ENOTDIR", "parent", "Use a directory descriptor.")
		if (value.store) return value
		let current
		try {
			current = await this._rawOpen(this.rootHandle, value.path, { directory: true })
			if (!same(stat, await current.stat({ bigint: true }))) throw stale(value.path)
		} catch (error) { if (["ENOENT", "ELOOP", "ENOTDIR"].includes(error.code)) throw stale(value.path); throw error }
		finally { await current?.close() }
		this.policy.assertWrite(value.path)
		await this._checkPinned(value.path, "write")
		return value
	}
	async _mutation(parent, name, { subtree = false, internal = false } = {}) {
		canonicalPath(name, { root: false })
		if (name.includes("/")) throw new SafeFsError("EINVAL", "name", "A descriptor-relative mutation takes one basename.")
		const value = await this._checkParent(parent), full = join(value.path, name)
		if (!value.store) {
			if (!(internal && staging(name))) this.policy.assertWrite(full, { subtree })
			await this._checkPinned(full, "write")
			if (subtree) await this._scanMutation(parent, name)
		}
		return value
	}
	async _scanMutation(parent, name) {
		let count = 0
		const walk = async (parent, name, depth) => {
			if (++count > this.scanLimit || depth > 64) throw new SafeFsError("E2BIG", "subtree", "The protected-descendant scan exceeded its bound; increase scanLimit or use a smaller subtree.", { reason: "scan_limit" })
			let meta, dir
			try {
				meta = await this._rawOpen(parent, name, { metadata: true })
				const stat = await meta.stat({ bigint: true })
				this.policy.assertIdentity(stat, "write")
				if (!stat.isDirectory()) return
				dir = await this._rawOpen(parent, name, { directory: true })
				if (!same(stat, await dir.stat({ bigint: true }))) throw stale(dir.path)
				for (;;) {
					const entries = await native().entries(state(dir).token)
					if (!entries.length) break
					for (const entry of entries) {
						const child = entryName(entry.name)
						if (!child || isReserved(child)) throw new SafeFsError("EACCES", "subtree", "The subtree contains a reserved or unaddressable entry.", { reason: "protected_descendant", path: dir.path, protectedPath: child && join(dir.path, child) })
						this.policy.assertWrite(join(dir.path, child), { subtree: true })
						await walk(dir, child, depth + 1)
					}
				}
			} catch (error) { if (!missing(error)) throw error }
			finally { await meta?.close(); await dir?.close() }
		}
		await walk(parent, name, 0)
	}
	rename(fromParent, fromName, toParent, toName, { noReplace = true } = {}) {
		return this.withLock(async () => {
			if (typeof noReplace !== "boolean") throw new SafeFsError("EINVAL", "rename", "noReplace must be boolean.")
			const from = resolveDescriptor(fromParent), to = resolveDescriptor(toParent)
			await this._mutation(from, fromName, { subtree: true, internal: true })
			await this._mutation(to, toName, { subtree: true })
			await native().rename(state(from).token, fromName, state(to).token, toName, noReplace)
		})
	}
	mkdir(parent, name, permissions = 0o2775) {
		return this.withLock(async () => { const dir = resolveDescriptor(parent); await this._mutation(dir, name); await native().mkdir(state(dir).token, name, mode(permissions)) })
	}
	stageDirectory(parent) {
		return this.withLock(async () => {
			const dir = resolveDescriptor(parent), name = `.gc-file-${crypto.randomUUID()}`
			await this._mutation(dir, name, { internal: true })
			await native().mkdir(state(dir).token, name, 0o700)
			const handle = await this._rawOpen(dir, name, { directory: true })
			return { name, handle }
		})
	}
	inspectStage(parent, name) {
		return this.withLock(async () => {
			if (!staging(name)) throw new SafeFsError("EINVAL", "inspectStage", "Use a generated internal staging basename.")
			const dir = resolveDescriptor(parent)
			await this._mutation(dir, name, { internal: true })
			const handle = await this._rawOpen(dir, name, { metadata: true })
			try { return await handle.stat({ bigint: true }) } finally { await handle.close() }
		})
	}
	unlink(parent, name, directory = false) {
		return this.withLock(async () => { const dir = resolveDescriptor(parent); await this._mutation(dir, name, { subtree: true, internal: true }); await native().unlink(state(dir).token, name, Boolean(directory)) })
	}
	create(parent, name, permissions = 0o600) {
		return this.withLock(async () => {
			const dir = resolveDescriptor(parent), value = await this._mutation(dir, name, { internal: true })
			return this._wrap(await native().create(value.token, name, mode(permissions), this.noXdev ? 1 : 0), join(value.path, name), { store: value.store })
		})
	}
	// Trusted, checked store descriptors may live outside the workspace root.
	// Workspace descriptors still undergo the same root-address and policy checks.
	openAt(parent, path, options = {}) {
		return this.withLock(async () => {
			canonicalPath(path)
			const dir = resolveDescriptor(parent), value = state(dir)
			if (!value.store) {
				if (value.owner !== this) throw new SafeFsError("EINVAL", "openAt", "Use this workspace's descriptor or a checked store descriptor.")
				const current = await this._open(value.path, { directory: true })
				try { if (!same(await dir.stat({ bigint: true }), await current.stat({ bigint: true }))) throw stale(value.path) } finally { await current.close() }
				this.policy.assertRead(join(value.path, path))
				if (this.policy.hasPins) return this._policyOpen(dir, path, options)
			}
			return this._rawOpen(dir, path, options)
		})
	}
	clone(source, target) {
		const argument = (value) => typeof value === "number" && !byFd.get(value)?.deref() ? value : state(resolveDescriptor(value)).token
		return native().clone(argument(source), argument(target))
	}
	probe() { return this.withLock(() => native().probe(state(this.rootHandle).token, `.gc-file-${crypto.randomUUID()}`)) }
	prove(path, expectedObject, parentIdentity) {
		return this.withLock(async () => {
			canonicalPath(path, { root: false })
			if (!expectedObject || !parentIdentity) return false
			let parent
			try {
				parent = await this.parent(path)
				return Boolean(same(parent.parentIdentity, parentIdentity) && same(await this._stat(path, { allowSymlink: true }), expectedObject))
			} catch (error) { if (["ENOENT", "ELOOP", "ENOTDIR", "ESTALE", "EACCES", "EXDEV"].includes(error.code)) return false; throw error }
			finally { await parent?.handle.close() }
		})
	}
	async _pinRegistration(entry, publish = true) {
		const address = parts(entry.path)
		const parent = await this._rawOpen(this.rootHandle, address.path, { directory: true })
		let object
		try {
			const parentIdentity = identity(await parent.stat({ bigint: true }))
			try {
				object = await this._rawOpen(parent, address.name || ".", { metadata: true })
			} catch (error) { if (!missing(error)) throw error }
			const objectStat = object ? await object.stat({ bigint: true }) : null
			if (objectStat && !objectStat.isFile() && !objectStat.isDirectory()) throw new SafeFsError("EOPNOTSUPP", "register", "Existing registration roots must be regular files or directories.", { reason: "registration_type", path: entry.path })
			const objectIdentity = objectStat ? identity(objectStat) : null
			if (publish) this.policy.pin(entry.path, objectIdentity, parentIdentity)
			this.anchors.add(parent)
			if (object) this.anchors.add(object)
			return { identity: objectIdentity, parentIdentity }
		} catch (error) { await object?.close(); await parent.close(); throw error }
	}
	async _register(entry) {
		this.policy.checkRegistration(entry)
		// Pin before publication. A failed pin must not install a partial policy.
		const pinned = await this._pinRegistration(entry, false)
		this.policy.add({ path: entry.path, access: entry.access, ...pinned })
		this._generation++
		return { path: entry.path, access: entry.access, ...pinned, generation: this.generation }
	}
	checkOwnership(storeDir, { agentUids, workerUids, maxEntries = 10000, maxDepth = 64, maxMs = 5000 } = {}) {
		return this.withLock(async () => {
			const serviceUid = process.geteuid(), held = []
			const uidList = (values) => {
				if (!Array.isArray(values) || !values.length) return null
				const result = []
				for (let i = 0; i < values.length; i++) {
					const uid = values[i]
					if (!Object.hasOwn(values, i) || !Number.isInteger(uid) || uid < 0 || uid > 0xffffffff) return null
					result.push(uid)
				}
				return result
			}
			const agents = uidList(agentUids), workers = uidList(workerUids)
			if (!agents || !workers) return { ok: false, reason: "uid_configuration", serviceUid }
			if ([...agents, ...workers].includes(serviceUid)) return { ok: false, reason: "same_uid", serviceUid }
			if ([...agents, ...workers].includes(0)) return { ok: false, reason: "untrusted_root_uid", serviceUid }
			try {
				absolute(storeDir); limit(maxEntries, "maxEntries"); limit(maxDepth, "maxDepth"); limit(maxMs, "maxMs")
				if (storeDir === this.root || this.root.startsWith(storeDir === "/" ? "/" : `${storeDir}/`)) throw new SafeFsError("EACCES", "ownership", "Store storage must not contain the workspace root.", { reason: "store_overlaps_workspace", path: storeDir })
				const workspaceIdentity = identity(await this.rootHandle.stat({ bigint: true }))
				const deadline = performance.now() + maxMs
				let scanned = 0
				const fail = (reason, path, extra = {}) => { throw new SafeFsError("EACCES", "ownership", "Protected storage does not meet ownership requirements.", { reason, path, ...extra }) }
				const check = async (handle, path, ancestor = false) => {
					if (performance.now() > deadline) fail("scan_limit", path)
					const stat = await handle.stat({ bigint: true })
					if (!ancestor && stat.isDirectory() && same(stat, workspaceIdentity)) fail("store_overlaps_workspace", path)
					if (Number(stat.uid) !== serviceUid && !(ancestor && stat.uid === 0n)) fail("owner", path, { uid: Number(stat.uid) })
					if ((Number(stat.mode) & 0o022) !== 0) fail("writable_mode", path)
					if (ancestor && !stat.isDirectory()) fail("ancestor_type", path)
					if (!ancestor && !stat.isDirectory() && !stat.isFile()) fail("object_type", path)
					if (stat.isFile() && stat.nlink !== 1n) fail("hardlink", path, { nlink: String(stat.nlink) })
					const acl = await native().acl(state(handle).token)
					if (acl.access || acl.default) fail("extended_acl", path)
					return stat
				}
				let handle = this._wrap(await native().openRoot("/"), "/", { store: true })
				held.push(handle)
				await check(handle, "/", true)
				for (const component of storeDir === "/" ? [] : storeDir.slice(1).split("/")) {
					handle = await this._rawOpen(handle, component, { directory: true, noXdev: false })
					held.push(handle)
					await check(handle, handle.path, true)
				}
				const storeStat = await handle.stat({ bigint: true })
				if (same(storeStat, workspaceIdentity)) fail("store_overlaps_workspace", storeDir)
				if (Number(storeStat.uid) !== serviceUid) fail("store_owner", storeDir)
				const scan = async (dir, depth) => {
					if (depth > maxDepth) fail("scan_limit", dir.path)
					for (;;) {
						const entries = await native().entries(state(dir).token)
						if (!entries.length) break
						for (const entry of entries) {
							if (++scanned > maxEntries || performance.now() > deadline) fail("scan_limit", dir.path)
							const name = entryName(entry.name)
							if (name === null) fail("entry_name", dir.path)
							let meta, child
							try {
								meta = await this._rawOpen(dir, name, { metadata: true, noXdev: true })
								const stat = await meta.stat({ bigint: true })
								if (!stat.isDirectory() && !stat.isFile()) fail("object_type", meta.path)
								child = await this._rawOpen(dir, name, { directory: stat.isDirectory(), noXdev: true })
								if (!same(stat, await child.stat({ bigint: true }))) fail("object_changed", child.path)
								await check(child, child.path)
								if (stat.isDirectory()) await scan(child, depth + 1)
							} finally { await meta?.close(); await child?.close() }
						}
					}
				}
				await scan(handle, 0)
				// Pin and hide an in-workspace store before exposing its capability.
				const prefix = this.root === "/" ? "/" : `${this.root}/`
				if (storeDir.startsWith(prefix)) {
					const relative = storeDir.slice(prefix.length)
					if (relative && !relative.split("/").some(isReserved) && !this.policy.roots.some((entry) => entry.access === "hidden" && contains(entry.path, relative))) await this._register({ path: relative, access: "hidden" })
				}
				// Identity hiding also covers a store already beneath an implicit or
				// registered hidden parent, and aliases of an external checked store.
				const storeIdentity = identity(await handle.stat({ bigint: true }))
				if (this.policy.protectIdentity(storeDir, storeIdentity)) this._generation++
				for (const anchor of held) this.anchors.add(anchor)
				return { ok: true, reason: null, serviceUid, scanned, handle, identity: storeIdentity, ancestors: held.map((anchor) => anchor.path), ancestorHandles: [...held] }
			} catch (error) {
				for (const handle of held.reverse()) await handle.close()
				return { ok: false, reason: error.reason || "inspection_failed", serviceUid, code: error.code, path: error.path, message: error.message, agent: "file-service", tool: "safe-fs.checkOwnership", action: "Configure distinct non-root agent/worker UIDs and secure every store ancestor, mode, ACL, and blob hardlink." }
			}
		})
	}
	close() {
		if (!this.closing) this.closing = locked(async () => {
			this.closed = true
			const results = await Promise.allSettled([...this.handles].map((handle) => handle.close()))
			this.anchors.clear()
			const failed = results.find((result) => result.status === "rejected")
			if (failed) throw failed.reason
		})
		return this.closing
	}
	[Symbol.asyncDispose]() { return this.close() }
}

export default SafeFs
