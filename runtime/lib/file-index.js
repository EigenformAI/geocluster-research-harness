import crypto from "node:crypto"
import path from "node:path"
import { setImmediate as yieldTurn } from "node:timers/promises"
import { watch as watchFiles } from "chokidar"
import { FILE_LIMITS, FILES_CONTRACT_VERSION, FileError, budget, canonicalPath, fileError as mapFileError, noPersistence, observation, sameObject, stableStringify } from "./file-contract.js"
import { fuzzyPaths } from "./fuzzy-paths.js"

const RECORD_KIND = "file-index"
const keyOf = (path) => crypto.createHash("sha256").update(path).digest("hex")
const parentOf = (path) => path.includes("/") ? path.slice(0, path.lastIndexOf("/")) : ""
const inside = (scope, path) => !scope || path === scope || path.startsWith(`${scope}/`)
const compare = (a, b) => a < b ? -1 : a > b ? 1 : 0
const typeOf = (stat) => stat.isSymbolicLink() ? "symlink" : stat.isDirectory() ? "dir" : stat.isFile() ? "file" : "other"

function fileError(error, tool) {
	const mapped = mapFileError(error, tool)
	return new FileError(mapped.status, mapped.error, mapped.message, {
		...mapped.toJSON(), agent: mapped.agent || "file-service", tool: mapped.tool || tool,
		action: mapped.action && mapped.action !== tool ? mapped.action : "Inspect the requested scope, permissions, and storage; retry with current metadata.",
	})
}

function freeze(value) {
	if (value && typeof value === "object" && !Object.isFrozen(value)) { for (const child of Object.values(value)) freeze(child); Object.freeze(value) }
	return value
}

function modifiedAt(stat) {
	const ms = stat.mtimeNs !== undefined ? Number(stat.mtimeNs / 1000000n) : Number(stat.mtimeMs)
	return Number.isFinite(ms) && Math.abs(ms) <= 8640000000000000 ? new Date(ms).toISOString() : null
}

/** An incrementally reconciled catalogue. Views freeze metadata, never mutable file bytes. */
export class FileIndex {
	constructor({ safeFs, state, limits = {}, ref, onEvent = () => {} }) {
		this.safeFs = safeFs
		this.state = state
		this.ref = ref || ((path) => ({ ...state.identity, path }))
		this.onEvent = onEvent
		this.limits = { ...FILE_LIMITS, indexScanEntries: 100000, indexScanMs: 5000, indexBatchSize: 128, watchDebounceMs: 50, treeEntries: 5000, treeMaxEntries: 50000, ...limits }
		for (const key of ["views", "viewBytes", "viewIdleMs", "viewAgeMs", "scanIntervalMs", "indexScanEntries", "indexScanMs", "indexBatchSize", "watchDebounceMs"]) {
			if (!Number.isSafeInteger(this.limits[key]) || this.limits[key] < 1) throw new FileError(400, "invalid_budget", `${key} must be a positive integer.`)
		}
		this.rows = new Map()
		this.directories = new Map()
		this.views = new Map()
		this.viewBytes = 0
		this.cursorKey = crypto.randomBytes(32)
		this.generation = `${crypto.randomUUID()}.0`
		this.sequence = 0
		this.statTail = Promise.resolve()
		this.statPending = 0
		this.status = "indexing"
		this.observedAt = new Date().toISOString()
		this.closed = false
		this.ready = new Promise((resolve, reject) => { this.resolveReady = resolve; this.rejectReady = reject })
		this.ready.catch(() => {})
	}

	init() {
		if (this.closed) return Promise.reject(new FileError(503, "storage_unavailable", "FileIndex is closed."))
		if (this.initializing) return this.initializing
		this.initializing = (async () => {
			if (this.closed) throw new FileError(503, "storage_unavailable", "FileIndex is closed.")
			for (const row of await this.state.list(RECORD_KIND)) {
				canonicalPath(row.path, { root: false })
				if (this.safeFs.policy.visible(row.path)) this.rows.set(row.path, { ...row, ref: this.ref(row.path) })
			}
			await this.#watchRoot()
			this.reconcileTimer = setInterval(() => this.#schedule(), this.limits.scanIntervalMs)
			this.reconcileTimer.unref?.()
			this.refresh().then(this.resolveReady, this.rejectReady)
			return this
		})()
		this.initializing.catch((error) => this.rejectReady(error))
		return this.initializing
	}

	async #watchRoot() {
		this.watchHandle = await this.safeFs.open("", { directory: true })
		try {
			const opened = await this.watchHandle.stat({ bigint: true })
			if (!opened.isDirectory() || !sameObject(opened, await this.#readStat(""))) throw new FileError(409, "source_changed", "The workspace root changed before watcher registration.")
			const watchRoot = `/proc/self/fd/${this.watchHandle.fd}/`
			const ignored = (candidate) => {
				if (typeof candidate !== "string") return true
				const relative = path.relative(watchRoot, candidate).split(path.sep).join("/")
				if (!relative) return false
				if (relative === ".." || relative.startsWith("../") || path.posix.isAbsolute(relative)) return true
				try { return !this.safeFs.policy.visible(canonicalPath(relative, { root: false })) } catch { return true }
			}
			// Watcher paths are hints only. Reconciliation reopens every address through SafeFs.
			// An entry this service cannot read, such as another process's private temporary file, is skipped as the
			// scan skips it; it must not stop the watch for the whole workspace.
			this.watcher = watchFiles(watchRoot, { persistent: false, ignoreInitial: true, followSymlinks: false, atomic: true, awaitWriteFinish: false, ignorePermissionErrors: true, ignored })
			let finishRegistration
			const registered = new Promise((resolve) => { finishRegistration = resolve })
			this.watcher.on("all", () => {
				if (this.closed) return
				this.status = "stale"
				this.#schedule()
			})
			this.watcher.on("ready", () => {
				finishRegistration()
				if (this.closed) return
				this.watcherReady = true
			})
			this.watcher.on("error", (error) => {
				finishRegistration()
				if (this.closed) return
				const first = !this.watchError
				this.watchError = fileError(error, "file-index.watch")
				this.status = "partial"
				if (first) this.onEvent("reset", { path: "", reason: "scan-error", error: this.watchError.toJSON() })
				this.#schedule()
			})
			// Begin the initial safe scan only after recursive registration closes its crawl window.
			await registered
		} catch (error) { await this.watchHandle.close(); this.watchHandle = null; throw fileError(error, "file-index.watch") }
	}

	#schedule() {
		if (this.closed || this.refreshTimer) return
		this.refreshTimer = setTimeout(() => {
			this.refreshTimer = null
			this.refresh().catch(() => {}) // refresh records and publishes its actionable failure.
		}, this.limits.watchDebounceMs)
		this.refreshTimer.unref?.()
	}

	#metadata(path, stat, previous = this.rows.get(path)) {
		const ref = this.ref(path)
		const current = observation(ref, stat)
		const recorded = {}
		for (const field of ["origin", "category", "producer", "backend"]) if (previous?.[field] !== undefined) recorded[field] = previous[field]
		return {
			...recorded, name: path.split("/").at(-1) || "", path, ref, type: typeOf(stat), sizeBytes: current.sizeBytes,
			modifiedAt: modifiedAt(stat), observation: previous?.observation?.token === current.token ? previous.observation : current,
			availability: "local", persistence: previous?.persistence || noPersistence(),
		}
	}

	#readStat(path, options, internal = false) {
		// One extra reserved queue position lets the single scanner make progress under public load.
		if (!internal && this.statPending >= this.limits.queueSize) return Promise.reject(new FileError(429, "capacity", "Metadata stat admission is full.", { retryAfter: 1, tool: "file-index.stat", action: "Retry after current metadata lookups complete." }))
		this.statPending++
		const result = this.statTail.then(() => {
			this.safeFs.policy.assertRead(path)
			return this.safeFs.stat(path, options)
		}).finally(() => { this.statPending-- })
		this.statTail = result.catch(() => {}) // The original caller receives every failure.
		return result
	}

	async #scope(path, directory = false, internal = false) {
		canonicalPath(path)
		try {
			this.safeFs.policy.assertRead(path)
			const stat = await this.#readStat(path, { allowSymlink: !directory }, internal)
			if (directory && !stat.isDirectory()) throw new FileError(400, "invalid_path", "This operation requires a directory.", { ...(stat.isSymbolicLink() ? { reason: "symlink" } : {}) })
			return stat
		} catch (error) { throw fileError(error, "file-index.scope") }
	}

	refresh() {
		if (this.closed) return Promise.reject(new FileError(503, "storage_unavailable", "FileIndex is closed."))
		if (!this.initializing) return this.init().then(() => this.ready)
		if (this.scanning) {
			if (!this.queuedRefresh) this.queuedRefresh = this.scanning.then(() => {
				this.queuedRefresh = null
				return this.closed ? undefined : this.refresh()
			}, (error) => { this.queuedRefresh = null; throw error })
			return this.queuedRefresh
		}
		this.scanning = this.#scan().catch(async (error) => {
			this.status = "partial"
			this.scanError = fileError(error, "file-index.scan")
			try { await this.#releaseScan() } catch (cleanup) { this.scanError.cleanupError = fileError(cleanup, "file-index.scan.close").toJSON() }
			this.onEvent("reset", { path: "", reason: "scan-error", error: this.scanError.toJSON() })
			throw this.scanError
		}).finally(() => {
			this.scanning = null
		})
		return this.scanning
	}

	async #releaseScan() {
		const current = this.scanSession?.current
		this.scanSession = null
		if (current) await current.iterator.return?.()
	}

	#missing(path, session) {
		if (!session) return false
		if (!session.seen.has(path) && session.scanned.get(parentOf(path))?.done) return true
		for (let parent = parentOf(path); parent; parent = parentOf(parent)) {
			if (session.nonDirectories.has(parent) || (!session.seen.has(parent) && session.scanned.get(parentOf(parent))?.done)) return true
		}
		return false
	}

	async #scan() {
		const started = Date.now()
		const policyGeneration = this.safeFs.generation
		const root = await this.#scope("", true, true)
		let session = this.scanSession
		if (session && (!sameObject(session.root, root) || session.policyGeneration !== policyGeneration)) throw new FileError(409, "source_changed", "The workspace or resource policy changed between index passes.")
		if (!session) {
			session = { root, policyGeneration, scanned: new Map(), seen: new Set(), nonDirectories: new Set(), queue: [""], head: 0, current: null }
			this.scanSession = session
			this.directories = session.scanned
		}
		const { scanned, seen, nonDirectories, queue } = session
		const pending = []
		let work = 0
		let stopped = false
		let stopReason = null
		const checked = new Set()
		const changes = []
		let changeCount = 0
		this.status = "indexing"
		this.scanError = null
		this.onEvent("index", { generation: this.generation, state: "indexing", excludedNames: this.#coverage("", true).excludedNames, observedCount: this.rows.size })
		const flush = async () => { if (pending.length) await this.state.transaction(pending.splice(0)) }
		const changed = (type, path) => { changeCount++; changes.push({ type, path }); if (changes.length >= this.limits.indexBatchSize) emitChanges() }
		const emitChanges = () => { if (changes.length) this.onEvent("invalidation", { changes: changes.splice(0), indexGeneration: this.generation }) }
		const step = () => {
			if (work >= this.limits.indexScanEntries || (work > 0 && Date.now() - started >= this.limits.indexScanMs)) { stopped = true; stopReason = work >= this.limits.indexScanEntries ? "entry-budget" : "time-budget"; return false }
			work++
			return true
		}
		const processEntry = async (entry, { directory, coverage }) => {
			if (entry.name === null) {
				coverage.excludedNames++
				if (coverage.diagnostics.length < 32) coverage.diagnostics.push(entry.diagnostic || "Unaddressable filename")
				return
			}
			let path
			try {
				if (typeof entry.name !== "string" || entry.name.includes("/")) throw new FileError(400, "invalid_path", "A directory entry must be one canonical name.")
				path = canonicalPath(directory ? `${directory}/${entry.name}` : entry.name, { root: false })
			} catch (error) {
				if (error.error !== "invalid_path") throw error
				coverage.excludedNames++
				if (coverage.diagnostics.length < 32) coverage.diagnostics.push(JSON.stringify(entry.name))
				return
			}
			if (!this.safeFs.policy.visible(path)) return
			seen.add(path)
			const previous = this.rows.get(path)
			let row
			try {
				this.safeFs.policy.assertRead(path)
				const stat = await this.#readStat(path, { allowSymlink: true }, true)
				row = this.#metadata(path, stat, previous)
				if (row.type === "dir") { nonDirectories.delete(path); queue.push(path) }
				else {
					nonDirectories.add(path)
					if (previous?.type === "dir") for (const known of scanned.keys()) if (inside(path, known)) scanned.delete(known)
				}
			} catch (error) {
				const failure = fileError(error, "file-index.stat")
				if (failure.status === 404) { seen.delete(path); return }
				row = { ...(previous || { name: entry.name, path, ref: this.ref(path), type: ["dir", "file", "symlink"].includes(entry.type) ? entry.type : "other", persistence: noPersistence() }), sizeBytes: null, modifiedAt: null, observation: null, availability: "unavailable", error: failure.toJSON() }
			}
			this.rows.set(path, row)
			pending.push({ type: "put", kind: RECORD_KIND, id: keyOf(path), value: row })
			if (!previous || previous.observation?.token !== row.observation?.token || previous.availability !== row.availability) changed(previous ? "change" : "add", path)
			if (pending.length >= this.limits.indexBatchSize) { await flush(); await yieldTurn() }
		}
		while (!session.pruning && (session.current || session.head < queue.length) && !this.closed) {
			// Check before next(): a budget stop must not consume and lose an entry.
			// One directory/entry step guarantees progress even when the elapsed budget is tiny.
			if (!step()) break
			if (!session.current) {
				const directory = queue[session.head++]
				const coverage = { done: false, excludedNames: 0, diagnostics: [], error: null }
				scanned.set(directory, coverage)
				try {
					const before = await this.#scope(directory, true, true)
					const current = { directory, coverage, before, iterator: this.safeFs.entries(directory)[Symbol.asyncIterator]() }
					session.current = current
					checked.add(current)
				} catch (error) {
					coverage.error = fileError(error, "file-index.entries")
					this.onEvent("reset", { path: directory, reason: "scan-error", error: coverage.error.toJSON() })
				}
				continue
			}
			const current = session.current
			try {
				if (!checked.has(current)) {
					if (!sameObject(current.before, await this.#scope(current.directory, true, true))) throw new FileError(409, "source_changed", "A paused index directory changed addresses.")
					checked.add(current)
				}
				if (this.safeFs.generation !== policyGeneration) throw new FileError(409, "source_changed", "Resource policy changed during indexing.")
				const entry = await current.iterator.next()
				if (entry.done) {
					if (!sameObject(current.before, await this.#scope(current.directory, true, true))) throw new FileError(409, "source_changed", "Directory address changed during indexing.")
					current.coverage.done = true
					session.current = null
				} else await processEntry(entry.value, current)
			} catch (error) {
				current.coverage.error = fileError(error, "file-index.entries")
				await current.iterator.return?.()
				session.current = null
				this.onEvent("reset", { path: current.directory, reason: "scan-error", error: current.coverage.error.toJSON() })
			}
		}
		if (this.closed) return
		if (!sameObject(root, await this.#scope("", true, true)) || this.safeFs.generation !== policyGeneration) throw new FileError(409, "source_changed", "The workspace scope changed during indexing.")
		// Map iteration and durable removals are a resumable part of the same work budget.
		let complete = false
		if (!stopped) {
			session.pruning ||= this.rows.keys()
			while (!this.closed) {
				if (!step()) break
				const entry = session.pruning.next()
				if (entry.done) { complete = true; break }
				const path = entry.value
				if (this.safeFs.policy.visible(path) && !this.#missing(path, session)) continue
				this.rows.delete(path)
				pending.push({ type: "delete", kind: RECORD_KIND, id: keyOf(path) })
				changed("unlink", path)
				if (pending.length >= this.limits.indexBatchSize) { await flush(); await yieldTurn() }
			}
		}
		if (this.closed) return
		await flush()
		if (complete) { this.scanSession = null; this.listed = true }
		this.scanStopReason = stopReason
		this.observedAt = new Date().toISOString()
		this.generation = `${this.generation.slice(0, this.generation.lastIndexOf("."))}.${++this.sequence}`
		this.status = stopped || this.watchError || [...this.directories.values()].some((dir) => dir.error || dir.excludedNames || !dir.done) || [...this.rows.values()].some((row) => row.availability === "unavailable") ? "partial" : "ready"
		emitChanges()
		this.onEvent("index", { generation: this.generation, state: this.status, excludedNames: this.#coverage("", true).excludedNames, observedCount: this.rows.size, contentChanged: changeCount > 0, changeCount })
		if (stopped) this.#schedule()
		return this.info()
	}

	/**
	 * The last pass's generation while the index is settled, otherwise null. Settled means that pass completed and
	 * listed every folder, no pass is running or due, and the watcher is live. A file stays listed until a pass finds
	 * its folder without it, so a file missing from a settled index is gone or arrived too recently to be reported.
	 */
	settledGeneration() {
		if (!this.listed || this.scanSession || this.scanning || this.refreshTimer || this.scanError || !this.watcherReady || this.watchError || [...this.directories.values()].some((dir) => dir.error)) return null
		return this.generation
	}

	/** Known files whose name ends with suffix, or null unless the index is settled. */
	listedFiles(suffix) {
		if (this.settledGeneration() === null) return null
		return [...this.rows.values()].filter((row) => row.type === "file" && row.path.toLowerCase().endsWith(suffix))
	}

	refreshSoon(paths) {
		if (this.closed) throw new FileError(503, "storage_unavailable", "FileIndex is closed.")
		const selected = Array.isArray(paths) ? paths : [paths]
		selected.forEach((path) => canonicalPath(path))
		this.status = "stale"
		this.#schedule()
	}

	#coverage(scope, recursive) {
		const directories = [...this.directories].filter(([path]) => recursive ? inside(scope, path) : path === scope)
		const excludedNames = directories.reduce((sum, [, dir]) => sum + dir.excludedNames, 0)
		const unavailableRoots = directories.filter(([, dir]) => dir.error).map(([path, dir]) => ({ path, error: dir.error.toJSON() }))
		const unavailable = [...this.rows.values()].some((row) => row.availability === "unavailable" && (recursive ? inside(scope, row.path) : parentOf(row.path) === scope))
		const literalFile = this.rows.has(scope) && this.rows.get(scope).type !== "dir"
		const incomplete = Boolean(this.scanSession?.pruning) || (!literalFile && (!directories.length || directories.some(([, dir]) => !dir.done) || (recursive && [...this.rows.values()].some((row) => row.type === "dir" && inside(scope, row.path) && !this.directories.get(row.path)?.done))))
		let state = ["indexing", "stale"].includes(this.status) ? this.status : incomplete ? "partial" : "ready"
		if (excludedNames || unavailableRoots.length || unavailable || this.scanError || this.watchError) state = "partial"
		return { state, excludedNames, observedAt: this.observedAt, unavailableRoots, diagnostics: directories.flatMap(([path, dir]) => dir.diagnostics.map((diagnostic) => ({ path, diagnostic }))), ...(incomplete && this.scanStopReason ? { stopReason: this.scanStopReason } : {}), ...(this.scanError ? { error: this.scanError.toJSON() } : {}) }
	}

	async stat(path) {
		await this.init()
		path = canonicalPath(path)
		const current = await this.#scope(path)
		return freeze(structuredClone(this.#metadata(path, current)))
	}

	#query(options, type) {
		const path = canonicalPath(options.path ?? "")
		if (type === "list") return { type, path, sort: "name" }
		const { q = "", mode = "names", kind = null, origin = null, category = null } = options
		const sort = options.sort ?? (mode === "fuzzy" ? "relevance" : "name")
		if (typeof q !== "string" || q.length > 1024 || /[\u0000-\u001f\u007f]/u.test(q)) throw new FileError(400, "invalid_filter", "q must be a string of at most 1024 characters without controls.")
		if (!["names", "raw-path", "fuzzy"].includes(mode) || !["name", "path", "size", "modified", "kind", "relevance"].includes(sort)) throw new FileError(400, "invalid_filter", "Unsupported find mode or sort.")
		if (mode === "fuzzy" && sort !== "relevance") throw new FileError(400, "invalid_filter", "Fuzzy find orders by relevance; omit sort or use relevance.")
		if (kind !== null && !["dir", "file", "symlink", "other"].includes(kind)) throw new FileError(400, "invalid_filter", "kind must be dir, file, symlink, or other.")
		for (const [name, value] of [["origin", origin], ["category", category]]) if (value !== null && (typeof value !== "string" || !value || value.length > 128)) throw new FileError(400, "invalid_filter", `${name} must be a nonempty recorded metadata value.`)
		if (mode === "raw-path") canonicalPath(q, { root: false })
		return { type, path, q, mode, sort, kind, origin, category }
	}

	#select(query, fuzzy) {
		const needle = query.q?.toLowerCase() || ""
		let items = [...this.rows.values()].filter((row) => {
			if (!this.safeFs.policy.visible(row.path) || this.#missing(row.path, this.scanSession) || !(query.type === "list" ? parentOf(row.path) === query.path : inside(query.path, row.path))) return false
			if (query.type === "list") return true
			return (query.mode === "fuzzy" || (query.mode === "raw-path" ? row.path === query.q : row.name.toLowerCase().includes(needle) || row.path.toLowerCase().includes(needle))) && (!query.kind || row.type === query.kind) && (!query.origin || row.origin === query.origin) && (!query.category || row.category === query.category)
		})
		// A fuzzy q keeps only the paths it matches. With nothing typed, every path ties.
		const scores = new Map()
		if (fuzzy) {
			const matched = fuzzy.scores(query.q, items.map((row) => row.path))
			items.forEach((row, index) => { if (matched.has(index)) scores.set(row, matched.get(index)) })
			items = items.filter((row) => scores.has(row))
		}
		const nullable = (a, b) => a === null || a === undefined ? b === null || b === undefined ? 0 : 1 : b === null || b === undefined ? -1 : compare(a, b)
		const relevance = (row) => row.name.toLowerCase() === needle ? 0 : row.name.toLowerCase().startsWith(needle) ? 1 : 2
		const newer = (a, b) => compare(b.modifiedAt ?? "", a.modifiedAt ?? "")
		items.sort((a, b) => {
			const rank = query.type === "list" ? Number(a.type !== "dir") - Number(b.type !== "dir") : 0
			let ordered = 0
			if (query.sort === "size") ordered = nullable(a.sizeBytes, b.sizeBytes)
			else if (query.sort === "modified") ordered = nullable(a.modifiedAt, b.modifiedAt)
			else if (query.sort === "kind") ordered = compare(a.type, b.type)
			else if (query.sort === "relevance") ordered = query.mode === "fuzzy" ? (scores.get(b) ?? 0) - (scores.get(a) ?? 0) || newer(a, b) : relevance(a) - relevance(b)
			else ordered = compare(query.sort === "path" ? a.path : a.name, query.sort === "path" ? b.path : b.name)
			return rank || ordered || compare(a.path, b.path)
		})
		return items
	}

	#evict(id) { const view = this.views.get(id); if (view) { this.viewBytes -= view.bytes; this.views.delete(id) } }
	#expire(now) { for (const [id, view] of this.views) if (now - view.accessedAt >= this.limits.viewIdleMs || now - view.createdAt >= this.limits.viewAgeMs) this.#evict(id) }
	#expired(query) { return new FileError(409, "cursor_expired", "This metadata view expired or was evicted. Restart the same query.", { query }) }

	#cursor(view, offset) {
		const value = { ...this.state.identity, viewId: view.id, scope: view.query.path, query: view.query, sort: view.query.sort, lastKey: { offset, path: view.items[offset - 1].path } }
		const encoded = Buffer.from(stableStringify(value)).toString("base64url")
		return `${encoded}.${crypto.createHmac("sha256", this.cursorKey).update(encoded).digest("base64url")}`
	}

	#resume(cursor, query) {
		if (typeof cursor !== "string" || cursor.length > 8192 || !/^[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+$/.test(cursor)) throw new FileError(400, "invalid_cursor", "Malformed metadata cursor.")
		const [encoded, signature] = cursor.split(".")
		let value
		try { value = JSON.parse(Buffer.from(encoded, "base64url").toString("utf8")) } catch { throw new FileError(400, "invalid_cursor", "Malformed metadata cursor.") }
		if (!value || value.workspaceId !== this.state.identity.workspaceId || value.workspaceEpoch !== this.state.identity.workspaceEpoch || value.scope !== query.path || value.sort !== query.sort || stableStringify(value.query) !== stableStringify(query) || typeof value.viewId !== "string" || !Number.isSafeInteger(value.lastKey?.offset) || value.lastKey.offset < 1 || typeof value.lastKey.path !== "string") throw new FileError(400, "invalid_cursor", "Cursor scope, query, or workspace does not match this request.")
		const view = this.views.get(value.viewId)
		if (!view) throw this.#expired(query)
		const expected = crypto.createHmac("sha256", this.cursorKey).update(encoded).digest()
		const actual = Buffer.from(signature, "base64url")
		if (actual.length !== expected.length || !crypto.timingSafeEqual(actual, expected) || view.items[value.lastKey.offset - 1]?.path !== value.lastKey.path) throw new FileError(400, "invalid_cursor", "Metadata cursor failed validation.")
		return { view, offset: value.lastKey.offset }
	}

	async #page(options, type) {
		await this.init()
		const query = this.#query(options, type)
		const limit = budget(options.limit, this.limits.pageSize, this.limits.pageMaxSize, "limit")
		const fuzzy = query.mode === "fuzzy" && query.q ? await fuzzyPaths() : null
		const now = Date.now()
		this.#expire(now)
		let view, offset = 0
		if (options.cursor) ({ view, offset } = this.#resume(options.cursor, query))
		else {
			const scopeStat = await this.#scope(query.path, type === "list")
			if (type === "find" && scopeStat.isSymbolicLink()) throw new FileError(400, "invalid_path", "Discovery does not follow symlinks.", { reason: "symlink" })
			const failure = this.directories.get(query.path)?.error
			if (failure) throw failure
			const matched = this.#select(query, fuzzy)
			// Fuzzy find answers each key typed into a picker, so it keeps the best matches instead of copying the whole workspace into a view.
			const selected = query.mode === "fuzzy" ? matched.slice(0, this.limits.pageMaxSize) : matched
			const coverage = freeze(structuredClone(this.#coverage(query.path, type === "find")))
			let bytes = Buffer.byteLength(stableStringify(query)) + Buffer.byteLength(JSON.stringify(coverage)) + 512
			for (const row of selected) {
				bytes += Buffer.byteLength(JSON.stringify(row)) + 1
				if (bytes > this.limits.viewBytes) throw new FileError(429, "capacity", "The selected metadata view exceeds the retained-view byte budget. Narrow the query.", { retryAfter: 1, limits: { viewBytes: this.limits.viewBytes } })
			}
			if (bytes > this.limits.viewBytes) throw new FileError(429, "capacity", "Metadata coverage diagnostics exceed the retained-view byte budget. Narrow the query.", { retryAfter: 1, limits: { viewBytes: this.limits.viewBytes } })
			view = { id: crypto.randomUUID(), query, items: freeze(structuredClone(selected)), coverage, count: freeze({ value: coverage.state === "stale" ? null : selected.length, relation: coverage.state === "ready" && selected.length === matched.length ? "exact" : coverage.state === "stale" ? "unknown" : "at-least" }), createdAt: now, accessedAt: now, bytes, policyGeneration: this.safeFs.generation }
			while (this.views.size >= this.limits.views || this.viewBytes + bytes > this.limits.viewBytes) this.#evict(this.views.keys().next().value)
			this.views.set(view.id, view)
			this.viewBytes += bytes
		}
		if (view.policyGeneration !== this.safeFs.generation) { this.#evict(view.id); throw this.#expired(query) }
		view.accessedAt = Date.now()
		this.views.delete(view.id)
		this.views.set(view.id, view)
		let items = view.items.slice(offset, offset + limit)
		const next = offset + items.length
		if (query.mode === "fuzzy") {
			const matches = fuzzy?.positions(query.q, items.map((row) => row.path))
			items = items.map((row, index) => freeze({ ...row, matches: matches?.[index] ?? [] }))
		}
		return freeze({ filesContractVersion: FILES_CONTRACT_VERSION, viewId: view.id, items, count: view.count, coverage: view.coverage, nextCursor: next < view.items.length ? this.#cursor(view, next) : null })
	}

	list(options = {}) { return this.#page(options, "list") }
	find(options = {}) { return this.#page(options, "find") }

	async tree({ path = "", maxEntries } = {}) {
		await this.init()
		path = canonicalPath(path)
		await this.#scope(path, true)
		if (this.directories.get(path)?.error) throw this.directories.get(path).error
		const limit = budget(maxEntries, this.limits.treeEntries, this.limits.treeMaxEntries, "maxEntries")
		const selected = this.#select({ type: "find", path, q: "", sort: "path", mode: "names" }).filter((row) => row.path !== path)
		const coverage = this.#coverage(path, true)
		return freeze({ filesContractVersion: FILES_CONTRACT_VERSION, path, items: structuredClone(selected.slice(0, limit)), coverage, count: { value: selected.length, relation: coverage.state === "ready" ? "exact" : "at-least" }, truncated: selected.length > limit, stopReason: selected.length > limit ? "entry-limit" : coverage.state === "ready" ? "complete" : "index-coverage", nextCursor: null })
	}

	info() {
		return freeze({ generation: this.generation, ...this.#coverage("", true), observedCount: this.rows.size, retainedViews: this.views.size, retainedViewBytes: this.viewBytes, watcher: { state: this.watcherReady && !this.watchError ? "ready" : "unavailable", scope: "recursive", descendants: "watch-with-reconciliation", ...(this.watchError ? { error: this.watchError.toJSON() } : {}) }, filters: ["kind", "origin", "category"], modes: ["names", "raw-path", "fuzzy"], sorts: ["name", "path", "size", "modified", "kind", "relevance"] })
	}

	close() {
		if (this.closing) return this.closing
		this.closed = true
		clearTimeout(this.refreshTimer)
		clearInterval(this.reconcileTimer)
		this.closing = (async () => {
			try { await this.initializing; await this.scanning; await this.queuedRefresh; await this.statTail } catch (error) { this.closeError = error }
			clearTimeout(this.refreshTimer)
			clearInterval(this.reconcileTimer)
			try { await this.#releaseScan() } catch (error) { this.closeError ||= error }
			await this.watcher?.close()
			if (this.watchHandle) await this.watchHandle.close()
			this.views.clear()
			this.viewBytes = 0
			if (this.closeError) throw fileError(this.closeError, "file-index.close")
		})()
		return this.closing
	}
}
