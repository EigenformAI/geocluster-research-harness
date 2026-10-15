/**
 * The gateway's list of conversations (session/list) and the archive of the Cline era.
 *
 * One `opencode acp` serves every conversation, but the gateway still keeps its own index: the engine's own
 * session/list knows nothing of the api-1/api-2 conversations, of run folders or of agent modes, and the gateway is
 * the only writer of this file.
 *
 * Two kinds of entries:
 *   - engine conversations, id `ses_…`: {sessionId, engine: "opencode", runDir, agentMode, title, createdAt,
 *     updatedAt, modelId?, contextUsed?, contextSize?}. Tokens and cost are not known (null); the context
 *     occupancy comes from the engine's usage_update, through touch().
 *   - archived conversations, any other id (13-digit Cline task ids): the api-1 legacy imports and the api-2
 *     per-conversation entries, `archived: true`. They keep legacy, runDir, title and dataDir; their tokens, cost,
 *     model and size are read ONCE from the Cline taskHistory.json into `stats`, so session/list never opens a Cline
 *     file again. They replay from the gateway log only; the broker never sends their id to the engine.
 *
 * load() is idempotent: the one-time legacy import (as in api 2), then the migration to version 3. Before the first
 * write over a pre-v3 index.json it is copied to index.v2.json (never overwritten): an api-2 image's list() throws
 * on entries without a dataDir, so a rollback means restoring that backup.
 *
 * A malformed entry never breaks a boot or a list: it is skipped with a warning, kept verbatim in the file, and its
 * id (when it looks like one) still counts as known, so pruneOrphans() can't delete its folders.
 */
import crypto from "node:crypto"
import fs from "node:fs/promises"
import path from "node:path"

const PAGE_SIZE = 50
export const INDEX_VERSION = 3
/** Engine session ids (opencode 2.0.19: `ses_` + base62). Everything else in the index is archived. */
export const ENGINE_ID = /^ses_[A-Za-z0-9]+$/
/** Cline task ids (Date.now()): the api-1/api-2 data dirs, logs and run folders. */
const CLINE_ID = /^\d{13}$/
/** Any id the index accepts. Ids become path segments (logs, run folders, data dirs): nothing else gets in. */
const SAFE_ID = /^[A-Za-z0-9_-]{1,128}$/
/** Fields touch() may set; anything else is ignored with a warning (sessionId/archived/stats are the index's own). */
const TOUCH_FIELDS = ["title", "modelId", "contextUsed", "contextSize"]

export const isEngineId = (id) => typeof id === "string" && ENGINE_ID.test(id)

const isObject = (value) => value !== null && typeof value === "object" && !Array.isArray(value)
const finite = (value) => (typeof value === "number" && Number.isFinite(value) ? value : null)

/** {value} for parsed JSON, {missing: true} for ENOENT, {error} when the file is unreadable or not JSON. */
async function readJsonFile(file) {
	let text
	try {
		text = await fs.readFile(file, "utf8")
	} catch (error) {
		return error.code === "ENOENT" ? { missing: true } : { error }
	}
	try {
		return { value: JSON.parse(text) }
	} catch (error) {
		return { error }
	}
}

const exists = (file) => fs.access(file).then(() => true, () => false)
const nonEmpty = (file) => fs.stat(file).then((s) => s.size > 0, () => false)

/** A finite number outside Date's range (±8.64e15) would make toISOString throw; it lists as the epoch instead. */
function isoDate(ms) {
	const date = new Date(ms)
	return Number.isNaN(date.getTime()) ? new Date(0).toISOString() : date.toISOString()
}

export class SessionIndex {
	constructor(config, logger) {
		this.config = config
		this.logger = logger
		this.file = path.join(config.gatewayStateDir, "index.json")
		this.backupFile = path.join(config.gatewayStateDir, "index.v2.json")
		this.entries = new Map() // sessionId -> entry
		/** Raw entries that failed validation, written back verbatim (nothing is lost) and never used. */
		this.quarantine = []
		this.legacyImported = false
		/**
		 * index.json was unreadable, not an index, or missing while conversation logs exist: the entries
		 * were rebuilt from the logs' meta.json, and the caller must skip this boot's pruning (an empty
		 * known set would make pruneOrphans treat every log as an orphan).
		 */
		this.damaged = false
		this.writeQueue = Promise.resolve()
	}

	/** Load, import the legacy history once, migrate to version 3. Never throws on bad content. */
	static async load(config, logger) {
		const index = new SessionIndex(config, logger)
		const read = await readJsonFile(index.file)
		const raw = isObject(read.value) ? read.value : null
		if (!read.missing && !raw) {
			// An atomic save can't tear the file, so this is outside damage: keep a copy before anything overwrites it.
			const kept = `${index.file}.unreadable-${Date.now()}`
			await fs.copyFile(index.file, kept).catch(() => {})
			logger.error("the conversation index is unreadable; starting from an empty index", { file: index.file, kept, error: read.error?.message ?? "not a JSON object" })
		}
		index.damaged = Boolean((!read.missing && !raw) || (raw && raw.sessions !== undefined && !Array.isArray(raw.sessions)) || (read.missing && (await index.#hasLogs())))
		index.#ingest(raw?.sessions)
		index.legacyImported = raw?.legacyImported === true
		if (index.damaged) {
			const rebuilt = await index.#rebuildFromLogs()
			logger.error("the conversation index was damaged or missing; rebuilt it from the session logs, and boot pruning is skipped", { file: index.file, rebuilt })
		}

		// "none": no file yet; "unreadable"; otherwise the file's version (an api-2 index has none: "v2")
		const onDisk = read.missing ? "none" : raw ? raw.version ?? "v2" : "unreadable"
		let changed = onDisk !== INDEX_VERSION || index.damaged
		if (!index.legacyImported) {
			await index.#importLegacy()
			changed = true
		}
		const migration = await index.#archive()
		if (migration.archived || migration.snapshots) changed = true
		if (!changed) return index

		// The first write over a readable pre-v3 file is preceded by the rollback backup.
		if (raw && raw.version !== INDEX_VERSION) await index.#backupV2()
		await index.save()
		if (onDisk !== INDEX_VERSION || migration.archived) {
			logger.info("conversation index at version 3", { from: onDisk, entries: index.entries.size, malformed: index.quarantine.length, ...migration })
		}
		return index
	}

	/** Any conversation log with events on disk (to tell a lost index.json from a fresh volume). */
	async #hasLogs() {
		const sessionsDir = path.join(this.config.gatewayStateDir, "sessions")
		for (const entry of await fs.readdir(sessionsDir, { withFileTypes: true }).catch(() => [])) {
			if (entry.isDirectory() && SAFE_ID.test(entry.name) && (await nonEmpty(path.join(sessionsDir, entry.name, "events.ndjson")))) return true
		}
		return false
	}

	/**
	 * Entries for the logs on disk the index lacks, from each log's meta.json (cwd, runDir, agentMode,
	 * title, timestamps). A log with events but no title gets a placeholder title, so it is listed and
	 * never pruned. Cline ids come back archived (by the migration), engine ids as engine entries.
	 */
	async #rebuildFromLogs() {
		const sessionsDir = path.join(this.config.gatewayStateDir, "sessions")
		let count = 0
		for (const dirent of await fs.readdir(sessionsDir, { withFileTypes: true }).catch(() => [])) {
			const id = dirent.name
			if (!dirent.isDirectory() || !SAFE_ID.test(id) || this.entries.has(id)) continue
			const meta = (await readJsonFile(path.join(sessionsDir, id, "meta.json"))).value
			const m = isObject(meta) ? meta : {}
			const hasEvents = await nonEmpty(path.join(sessionsDir, id, "events.ndjson"))
			const createdAt = finite(m.createdAt) ?? 0
			const engine = isEngineId(id)
			this.entries.set(id, {
				sessionId: id,
				...(engine ? { engine: "opencode" } : {}),
				runDir: typeof m.runDir === "string" ? m.runDir : engine ? `${this.config.runsSubdir}/${id}` : null,
				agentMode: typeof m.agentMode === "string" ? m.agentMode : null,
				title: typeof m.title === "string" && m.title ? m.title : hasEvents ? "(recovered conversation)" : null,
				createdAt,
				updatedAt: finite(m.updatedAt) ?? createdAt,
				recovered: true,
			})
			count++
		}
		return count
	}

	/** Valid entries go into the map; anything else is quarantined with a warning (load and list keep working). */
	#ingest(sessions) {
		if (sessions !== undefined && !Array.isArray(sessions)) {
			this.logger.warn("index.json: `sessions` is not an array; ignored", { type: typeof sessions })
			return
		}
		for (const [position, raw] of (sessions ?? []).entries()) {
			const problem = this.#problemOf(raw)
			if (problem) {
				this.quarantine.push(raw)
				this.logger.warn("index.json: malformed conversation entry skipped (kept in the file)", { position, problem })
				continue
			}
			const entry = { ...raw, sessionId: String(raw.sessionId) }
			const createdAt = finite(entry.createdAt) ?? finite(entry.updatedAt) ?? 0
			entry.createdAt = createdAt
			entry.updatedAt = finite(entry.updatedAt) ?? createdAt
			if (entry.title === undefined || entry.title === "") entry.title = null
			this.entries.set(entry.sessionId, entry)
		}
	}

	#problemOf(raw) {
		if (!isObject(raw)) return "not an object"
		const id = typeof raw.sessionId === "number" ? String(raw.sessionId) : raw.sessionId
		if (typeof id !== "string" || !SAFE_ID.test(id)) return "missing or unsafe sessionId"
		if (this.entries.has(id)) return `duplicate sessionId ${id}`
		for (const field of ["title", "runDir", "dataDir"]) {
			if (raw[field] != null && typeof raw[field] !== "string") return `${field} is not a string (${id})`
		}
		return null
	}

	/** Ids that own folders on disk: valid entries plus quarantined ones that carry a usable id. */
	#knownIds() {
		const ids = new Set(this.entries.keys())
		for (const raw of this.quarantine) {
			const id = isObject(raw) ? String(raw.sessionId ?? "") : ""
			if (SAFE_ID.test(id)) ids.add(id)
		}
		return ids
	}

	/** Tasks in the old shared Cline data dir become legacy entries (archived right after, by #archive). */
	async #importLegacy() {
		const read = await readJsonFile(path.join(this.config.clineDataDir, "state", "taskHistory.json"))
		let count = 0
		for (const item of Array.isArray(read.value) ? read.value : []) {
			if (!isObject(item) || !item.id || !item.ts || item.specialist) continue
			const id = String(item.id)
			if (this.entries.has(id) || !SAFE_ID.test(id)) continue
			const ts = finite(item.ts) ?? 0
			this.entries.set(id, {
				sessionId: id,
				dataDir: this.config.clineDataDir,
				runDir: null,
				legacy: true,
				title: typeof item.task === "string" && item.task ? item.task.slice(0, 120) : null,
				createdAt: ts,
				updatedAt: ts,
			})
			count++
		}
		this.legacyImported = true
		if (count) this.logger.info("imported legacy conversations", { count })
	}

	/**
	 * Every non-engine entry is archived, and gets its Cline stats snapshot once. Also catches entries an api-2 image
	 * added after a rollback (its save drops `version`, so this runs again; the first backup is kept).
	 */
	async #archive() {
		let archived = 0
		let snapshots = 0
		let emptyLogs = 0
		const histories = new Map() // dataDir -> taskHistory items (several legacy entries share one dir)
		for (const entry of this.entries.values()) {
			if (isEngineId(entry.sessionId)) continue
			if (entry.archived !== true) {
				entry.archived = true
				archived++
				// An archived conversation replays from its gateway log only; one without a log shows its title and
				// nothing else (parity inventory §4, option c). Counted once, at migration.
				const log = this.#logDir(entry.sessionId)
				if (entry.title && !(await nonEmpty(path.join(log, "events.ndjson"))) && !(await nonEmpty(path.join(log, "events.1.ndjson")))) emptyLogs++
			}
			if (isObject(entry.stats)) continue
			const dataDir = this.#dataDirOf(entry)
			if (!histories.has(dataDir)) {
				const read = await readJsonFile(path.join(dataDir, "state", "taskHistory.json"))
				if (read.error) this.logger.warn("Cline task history unreadable; archived stats are empty", { dataDir, error: read.error.message })
				histories.set(dataDir, Array.isArray(read.value) ? read.value : [])
			}
			const item = histories.get(dataDir).find((h) => isObject(h) && String(h.id) === entry.sessionId)
			entry.stats = {
				tokensIn: finite(item?.tokensIn) ?? 0,
				tokensOut: finite(item?.tokensOut) ?? 0,
				totalCost: finite(item?.totalCost) ?? 0,
				modelId: typeof item?.modelId === "string" ? item.modelId : null,
				size: finite(item?.size),
			}
			snapshots++
		}
		return { archived, snapshots, emptyLogs }
	}

	/** Copy the pre-v3 index once, atomically (tmp + rename), never over an existing backup. */
	async #backupV2() {
		if (await exists(this.backupFile)) {
			this.logger.info("index.v2.json already exists; kept", { file: this.backupFile })
			return
		}
		const tmp = `${this.backupFile}.${process.pid}.${crypto.randomBytes(4).toString("hex")}.tmp`
		try {
			await fs.copyFile(this.file, tmp)
			await fs.rename(tmp, this.backupFile)
			this.logger.info("pre-migration index backed up (restore it to roll back to api 2)", { file: this.backupFile })
		} catch (error) {
			await fs.rm(tmp, { force: true }).catch(() => {})
			// The v3 file is a superset of the v2 one, so the migration goes on; only a rollback gets harder.
			this.logger.error("could not back up the pre-migration index; migrating anyway", { file: this.backupFile, error: error.message })
		}
	}

	#logDir(id) {
		return path.join(this.config.gatewayStateDir, "sessions", id)
	}

	#runDirPath(id) {
		return path.join(this.config.workspaceDir, this.config.runsSubdir, id)
	}

	#dataDirOf(entry) {
		if (entry.dataDir) return entry.dataDir
		return entry.legacy ? this.config.clineDataDir : path.join(this.config.conversationsDir, entry.sessionId)
	}

	/** A Cline data dir the gateway created for one api-2 conversation: <conversationsDir>/<id>, nothing else. */
	#ownedDataDir(entry) {
		if (!entry.dataDir) return null
		const dir = path.resolve(entry.dataDir)
		return dir === path.join(path.resolve(this.config.conversationsDir), entry.sessionId) ? dir : null
	}

	/** rmdir, never recursive: a run folder with any file in it is kept. True when it was removed. */
	async #removeRunDirIfEmpty(id) {
		try {
			await fs.rmdir(this.#runDirPath(id))
			return true
		} catch (error) {
			if (error.code !== "ENOENT") this.logger.info("run folder kept", { sessionId: id, reason: error.code })
			return false
		}
	}

	get(sessionId) {
		return this.entries.get(String(sessionId)) ?? null
	}

	has(sessionId) {
		return this.entries.has(String(sessionId))
	}

	isArchived(sessionId) {
		return this.entries.get(String(sessionId))?.archived === true
	}

	/** A new engine conversation, not yet prompted (no title): pruned at the next boot unless a prompt names it. */
	async add({ sessionId, runDir, agentMode }) {
		if (!isEngineId(sessionId)) throw new TypeError(`SessionIndex.add: not an engine session id: ${JSON.stringify(sessionId)}`)
		const now = Date.now()
		this.entries.set(sessionId, {
			sessionId,
			engine: "opencode",
			runDir: runDir ?? `${this.config.runsSubdir}/${sessionId}`,
			agentMode: agentMode ?? null,
			title: null,
			createdAt: now,
			updatedAt: now,
		})
		await this.save()
	}

	/** Bump updatedAt and set title/modelId/contextUsed/contextSize (undefined leaves a field as is). False if unknown. */
	async touch(sessionId, fields = {}) {
		const entry = this.entries.get(String(sessionId))
		if (!entry) return false
		const ignored = []
		for (const [key, value] of Object.entries(fields ?? {})) {
			if (!TOUCH_FIELDS.includes(key)) ignored.push(key)
			else if (value !== undefined) entry[key] = value
		}
		if (ignored.length) this.logger.warn("touch: fields ignored", { sessionId: entry.sessionId, ignored })
		entry.updatedAt = Date.now()
		await this.save()
		return true
	}

	/**
	 * Make an engine conversation read-only: the engine answered "session not found" for it (its
	 * database was reset or the session deleted elsewhere). Its transcript stays replayable. False if unknown.
	 */
	async archive(sessionId, { lost = false } = {}) {
		const entry = this.entries.get(String(sessionId))
		if (!entry) return false
		entry.archived = true
		if (lost) entry.lost = true
		entry.updatedAt = Date.now()
		await this.save()
		return true
	}

	/** The index entry only (the caller owns the log, the run folder and the engine session). */
	async remove(sessionId) {
		if (!this.entries.delete(String(sessionId))) return false
		await this.save()
		return true
	}

	/**
	 * At boot, before any session/new: conversations that never got a prompt (an extra "New chat", React StrictMode's
	 * double mount) leave nothing behind — the index entry, the gateway log, the run folder if nothing was written
	 * into it (rmdir, never recursive), and for an archived api-2 one its gateway-owned Cline data dir. Legacy imports
	 * came from a task history, so they were prompted; they are kept even without a title.
	 * Returns the ids of the ENGINE conversations removed: the broker deletes those in the engine once it is ready.
	 */
	async pruneUnprompted() {
		const gone = [...this.entries.values()].filter((e) => !e.title && !e.legacy)
		if (!gone.length) return []
		const engineIds = []
		let keptRunDirs = 0
		for (const entry of gone) {
			const id = entry.sessionId
			this.entries.delete(id)
			await fs.rm(this.#logDir(id), { recursive: true, force: true }).catch((error) => this.logger.warn("could not remove a log", { sessionId: id, error: error.message }))
			if (!(await this.#removeRunDirIfEmpty(id))) keptRunDirs++
			const dataDir = entry.archived ? this.#ownedDataDir(entry) : null
			if (dataDir) await fs.rm(dataDir, { recursive: true, force: true }).catch((error) => this.logger.warn("could not remove a Cline data dir", { sessionId: id, error: error.message }))
			if (isEngineId(id) && !entry.archived) engineIds.push(id)
		}
		await this.save()
		this.logger.info("removed conversations that were never prompted", { count: gone.length, engine: engineIds.length, keptRunDirs })
		return engineIds
	}

	/**
	 * At boot: folders of conversations the index doesn't know, from either era — a gateway killed between the
	 * engine's session/new and the index write, or api-1 conversations that were never prompted (their logs were
	 * never pruned). Logs and gateway-owned Cline data dirs go; a run folder goes only when empty (rmdir), so no
	 * output is ever deleted here. Only names that are ids are touched. Returns how many folders were removed.
	 */
	async pruneOrphans() {
		const known = this.#knownIds()
		const unknown = (name, pattern) => pattern.test(name) && !known.has(name)
		const anyId = { test: (name) => ENGINE_ID.test(name) || CLINE_ID.test(name) }
		const dirsIn = async (dir) =>
			(await fs.readdir(dir, { withFileTypes: true }).catch(() => [])).filter((d) => d.isDirectory()).map((d) => d.name)
		let logs = 0
		let runDirs = 0
		let dataDirs = 0
		let keptRunDirs = 0
		const sessionsDir = path.join(this.config.gatewayStateDir, "sessions")
		for (const name of (await dirsIn(sessionsDir)).filter((n) => unknown(n, anyId))) {
			const dir = path.join(sessionsDir, name)
			if (await nonEmpty(path.join(dir, "events.ndjson"))) {
				// A transcript is never deleted on the index's word alone (it may be damaged): set aside
				const aside = path.join(sessionsDir, ".orphaned")
				await fs.mkdir(aside, { recursive: true, mode: 0o700 }).catch(() => {})
				await fs.rename(dir, path.join(aside, `${name}-${Date.now()}`)).then(() => logs++, () => {})
			} else {
				await fs.rm(dir, { recursive: true, force: true }).then(() => logs++, () => {})
			}
		}
		const runsDir = path.join(this.config.workspaceDir, this.config.runsSubdir)
		for (const name of (await dirsIn(runsDir)).filter((n) => unknown(n, anyId))) {
			if (await this.#removeRunDirIfEmpty(name)) runDirs++
			else keptRunDirs++
		}
		for (const name of (await dirsIn(this.config.conversationsDir)).filter((n) => unknown(n, CLINE_ID))) {
			await fs.rm(path.join(this.config.conversationsDir, name), { recursive: true, force: true }).then(() => dataDirs++, () => {})
		}
		const count = logs + runDirs + dataDirs
		if (count || keptRunDirs) this.logger.info("folders of conversations the index does not know", { logs, runDirs, dataDirs, keptRunDirs })
		return count
	}

	/** Atomic, serialized write (unique tmp name: no two writers ever share one). Malformed entries are kept. */
	save() {
		this.writeQueue = this.writeQueue
			.catch(() => {})
			.then(async () => {
				await fs.mkdir(path.dirname(this.file), { recursive: true, mode: 0o700 })
				const tmp = `${this.file}.${process.pid}.${crypto.randomBytes(4).toString("hex")}.tmp`
				const body = JSON.stringify({
					version: INDEX_VERSION,
					legacyImported: this.legacyImported,
					sessions: [...this.entries.values(), ...this.quarantine],
				})
				try {
					await fs.writeFile(tmp, body, { mode: 0o600 })
					await fs.rename(tmp, this.file)
				} catch (error) {
					await fs.rm(tmp, { force: true }).catch(() => {})
					throw error
				}
			})
		return this.writeQueue
	}

	/**
	 * session/list: conversations with at least one prompt (a title), newest first, 50 a page, numeric offset cursor.
	 * Archived numbers come from the snapshot (no file reads); engine conversations have no token or cost count.
	 */
	async list(cursor) {
		const offset = Math.max(0, Number.parseInt(cursor ?? "0", 10) || 0)
		const all = [...this.entries.values()].filter((e) => e.title).sort((a, b) => b.updatedAt - a.updatedAt)
		const sessions = []
		for (const entry of all.slice(offset, offset + PAGE_SIZE)) {
			const archived = entry.archived === true
			// Cline-era numbers come from the stats snapshot; an engine conversation the engine lost keeps its own
			const cline = archived && !isEngineId(entry.sessionId)
			const stats = cline && isObject(entry.stats) ? entry.stats : {}
			sessions.push({
				sessionId: entry.sessionId,
				cwd: this.config.workspaceDir,
				title: entry.title,
				updatedAt: isoDate(entry.updatedAt),
				_meta: {
					archived,
					legacy: Boolean(entry.legacy),
					runDir: entry.runDir ?? null,
					agentMode: entry.agentMode ?? null,
					modelId: (cline ? stats.modelId : entry.modelId) ?? null,
					tokensIn: cline ? stats.tokensIn ?? 0 : null,
					tokensOut: cline ? stats.tokensOut ?? 0 : null,
					contextUsed: cline ? null : entry.contextUsed ?? null,
					contextSize: cline ? null : entry.contextSize ?? null,
					size: cline ? stats.size ?? null : null,
					...(entry.lost === true ? { lost: true } : {}),
				},
			})
		}
		const next = offset + PAGE_SIZE < all.length ? String(offset + PAGE_SIZE) : null
		return { sessions, nextCursor: next }
	}
}
