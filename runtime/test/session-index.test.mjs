/**
 * SessionIndex (lib/session-index.js): the api-2 → api-3 index migration (archive, stats snapshot, rollback backup),
 * boot pruning, session/list and the write path. Each test builds its own state tree under os.tmpdir().
 *
 * The fixture mirrors the dev server's state as the parity inventory recorded it (s43 result-parity.md §4): legacy
 * entries imported from the shared Cline dir (runDir null), api-2 entries with a per-conversation Cline data dir,
 * some never prompted, gateway logs (one api-1 log nobody indexed), and run folders with and without outputs.
 */
import { test } from "node:test"
import assert from "node:assert/strict"
import fs from "node:fs/promises"
import os from "node:os"
import path from "node:path"
import { SessionIndex, isEngineId, INDEX_VERSION } from "../lib/session-index.js"

// ---- helpers -------------------------------------------------------------------------------------------------

function captureLogger() {
	const lines = []
	const make = (component) => ({
		info: (message, extra) => lines.push({ level: "info", component, message, extra }),
		warn: (message, extra) => lines.push({ level: "warn", component, message, extra }),
		error: (message, extra) => lines.push({ level: "error", component, message, extra }),
		child: (name) => make(`${component}:${name}`),
	})
	return { logger: make("index"), lines, of: (level) => lines.filter((l) => l.level === level) }
}

async function sandbox(t) {
	const root = await fs.mkdtemp(path.join(os.tmpdir(), "session-index-"))
	t.after(() => fs.rm(root, { recursive: true, force: true }))
	const state = path.join(root, "state")
	const config = {
		workspaceDir: path.join(root, "ws"),
		gatewayStateDir: path.join(state, "gateway"),
		clineDataDir: path.join(state, "cline"),
		conversationsDir: path.join(state, "conversations"),
		runsSubdir: "runs",
	}
	await fs.mkdir(path.join(config.workspaceDir, "runs"), { recursive: true })
	await fs.mkdir(config.gatewayStateDir, { recursive: true })
	return { root, config }
}

async function writeJson(file, value) {
	await fs.mkdir(path.dirname(file), { recursive: true })
	await fs.writeFile(file, typeof value === "string" ? value : JSON.stringify(value))
}

const readJson = async (file) => JSON.parse(await fs.readFile(file, "utf8"))
const exists = (file) => fs.access(file).then(() => true, () => false)
const indexFile = (config) => path.join(config.gatewayStateDir, "index.json")
const logDir = (config, id) => path.join(config.gatewayStateDir, "sessions", id)
const runDir = (config, id) => path.join(config.workspaceDir, "runs", id)
const dataDir = (config, id) => path.join(config.conversationsDir, id)

async function writeLog(config, id, events = 3) {
	const dir = logDir(config, id)
	await fs.mkdir(dir, { recursive: true })
	const lines = Array.from({ length: events }, (_, i) => JSON.stringify({ seq: i + 1, ts: 1790000000000 + i, kind: "update" }))
	if (events) await fs.writeFile(path.join(dir, "events.ndjson"), lines.join("\n") + "\n")
	await writeJson(path.join(dir, "meta.json"), { seq: events })
}

/** A Cline HistoryItem (cline-fork src/shared/HistoryItem.ts). */
const historyItem = (id, ts, task, n, extra = {}) => ({
	id, ulid: `01J${id}`, ts, task, tokensIn: 1000 * n, tokensOut: 100 * n, cacheWrites: 5, cacheReads: 7,
	totalCost: 0.01 * n, size: 4096 * n, modelId: `anthropic/claude-sonnet-4.5`, cwdOnTaskInitialization: "/workspace/p1", ...extra,
})

// Legacy (api 1, the shared Cline dir), api-2 prompted, api-2 never prompted.
const L = ["1789500000001", "1789500000002", "1789500000003"]
const P = ["1790100000001", "1790100000002"]
const U = ["1790100000003", "1790100000004"]
const API1_ORPHAN_LOG = "1789400000009"

/** The realistic api-2 state: returns the exact bytes of index.json. */
async function api2State(config) {
	// the shared legacy dir: 3 conversations and 7 specialist children (children are never listed or imported)
	const shared = [
		historyItem(L[0], 1789500100000, "Summarise the drill database", 1),
		historyItem(L[1], 1789500200000, "Cluster the geochem", 2, { modelId: undefined }),
		historyItem(L[2], 1789500300000, "Plot Au by hole", 3),
		...Array.from({ length: 7 }, (_, i) => historyItem(String(1789500000100 + i), 1789500000100 + i, "child", 9, { specialist: "dataops" })),
	]
	await writeJson(path.join(config.clineDataDir, "state", "taskHistory.json"), shared)
	// api 2: one Cline data dir per conversation; the never-prompted ones have no history item
	await writeJson(path.join(dataDir(config, P[0]), "state", "taskHistory.json"), [
		historyItem(P[0], 1790100100000, "Evaluate QA/QC", 4),
		historyItem("1790100000101", 1790100100100, "child", 9, { specialist: "analytics" }),
	])
	await writeJson(path.join(dataDir(config, P[1]), "state", "taskHistory.json"), [historyItem(P[1], 1790100200000, "Resource check", 5, { modelId: "z-ai/glm-4.7-flash" })])
	for (const id of U) await fs.mkdir(path.join(dataDir(config, id), "settings"), { recursive: true })
	// gateway logs: every indexed conversation (never-prompted ones: meta only), plus an api-1 log nobody indexed
	for (const id of [...L, ...P]) await writeLog(config, id)
	for (const id of [...U, API1_ORPHAN_LOG]) await writeLog(config, id, 0)
	// run folders: P0 has outputs, P1 is empty; U0 empty, U1 has a file someone wrote before any prompt
	await writeJson(path.join(runDir(config, P[0]), "results", "summary.csv"), "a,b\n1,2\n")
	await fs.mkdir(runDir(config, P[1]), { recursive: true })
	await fs.mkdir(runDir(config, U[0]), { recursive: true })
	await writeJson(path.join(runDir(config, U[1]), "notes.txt"), "keep me")

	const legacy = (id, title, ts) => ({ sessionId: id, dataDir: config.clineDataDir, runDir: null, legacy: true, title, createdAt: ts, updatedAt: ts })
	const api2 = (id, title, ts, agentMode) => ({ sessionId: id, dataDir: dataDir(config, id), runDir: `runs/${id}`, legacy: false, agentMode, title, createdAt: ts, updatedAt: ts + 5000 })
	const body = JSON.stringify({
		legacyImported: true,
		sessions: [
			legacy(L[0], "Summarise the drill database", 1789500100000),
			legacy(L[1], "Cluster the geochem", 1789500200000),
			legacy(L[2], "Plot Au by hole", 1789500300000),
			api2(P[0], "Evaluate QA/QC", 1790100100000, "report-analysis"),
			api2(P[1], "Resource check", 1790100200000, "geology"),
			api2(U[0], null, 1790100300000, "geology"),
			api2(U[1], null, 1790100400000, "geology"),
		],
	})
	await fs.writeFile(indexFile(config), body)
	return body
}

// ---- migration -----------------------------------------------------------------------------------------------

test("migration: an api-2 index becomes version 3 — archived entries, a stats snapshot, the v2 backup", async (t) => {
	const { config } = await sandbox(t)
	const original = await api2State(config)
	const log = captureLogger()
	const index = await SessionIndex.load(config, log.logger)

	const disk = await readJson(indexFile(config))
	assert.equal(disk.version, INDEX_VERSION)
	assert.equal(disk.legacyImported, true)
	assert.equal(disk.sessions.length, 7)
	for (const entry of disk.sessions) assert.equal(entry.archived, true, entry.sessionId)
	assert.equal(await fs.readFile(path.join(config.gatewayStateDir, "index.v2.json"), "utf8"), original, "the backup is the api-2 file, byte for byte")

	// legacy, runDir, title and dataDir are kept
	const l0 = index.get(L[0])
	assert.deepEqual(
		{ legacy: l0.legacy, runDir: l0.runDir, title: l0.title, dataDir: l0.dataDir },
		{ legacy: true, runDir: null, title: "Summarise the drill database", dataDir: config.clineDataDir },
	)
	const p0 = index.get(P[0])
	assert.deepEqual({ legacy: p0.legacy, runDir: p0.runDir, agentMode: p0.agentMode, dataDir: p0.dataDir }, { legacy: false, runDir: `runs/${P[0]}`, agentMode: "report-analysis", dataDir: dataDir(config, P[0]) })
	assert.ok(index.isArchived(L[0]) && index.isArchived(P[0]) && index.isArchived(U[0]))
	assert.equal(index.isArchived("ses_unknown"), false)

	// the stats come from each entry's own Cline task history
	assert.deepEqual(l0.stats, { tokensIn: 1000, tokensOut: 100, totalCost: 0.01, modelId: "anthropic/claude-sonnet-4.5", size: 4096 })
	assert.deepEqual(index.get(L[1]).stats, { tokensIn: 2000, tokensOut: 200, totalCost: 0.02, modelId: null, size: 8192 }, "no modelId in the item")
	assert.deepEqual(p0.stats, { tokensIn: 4000, tokensOut: 400, totalCost: 0.04, modelId: "anthropic/claude-sonnet-4.5", size: 16384 })
	assert.deepEqual(index.get(P[1]).stats.modelId, "z-ai/glm-4.7-flash")
	assert.deepEqual(index.get(U[0]).stats, { tokensIn: 0, tokensOut: 0, totalCost: 0, modelId: null, size: null }, "never prompted: no history item")
	assert.equal(index.has("1789500000100"), false, "specialist children are not conversations")

	const migrated = log.lines.find((l) => l.message === "conversation index at version 3")
	assert.equal(migrated.extra.from, "v2")
	assert.equal(migrated.extra.archived, 7)
	assert.equal(migrated.extra.emptyLogs, 0, "every prompted archived conversation has a log to replay")
	assert.equal(log.of("error").length, 0)
})

test("migration is idempotent: a second load writes nothing, and the stats are a one-time snapshot", async (t) => {
	const { config } = await sandbox(t)
	const original = await api2State(config)
	await SessionIndex.load(config, captureLogger().logger)
	const before = await fs.stat(indexFile(config))
	const bytes = await fs.readFile(indexFile(config), "utf8")

	// a later change to the Cline history must not reach the archive (no per-load or per-list reads)
	await writeJson(path.join(config.clineDataDir, "state", "taskHistory.json"), [historyItem(L[0], 1, "x", 50)])
	const log = captureLogger()
	const again = await SessionIndex.load(config, log.logger)
	const after = await fs.stat(indexFile(config))
	assert.equal(after.ino, before.ino, "not rewritten (a save renames a new file into place)")
	assert.equal(await fs.readFile(indexFile(config), "utf8"), bytes)
	assert.equal(again.get(L[0]).stats.tokensIn, 1000)
	assert.equal(log.lines.length, 0, log.lines.map((l) => l.message).join("; "))
	assert.equal(await fs.readFile(path.join(config.gatewayStateDir, "index.v2.json"), "utf8"), original)
})

test("migration after a rollback: an api-2 rewrite (no version) is migrated again; the first backup is never overwritten", async (t) => {
	const { config } = await sandbox(t)
	const original = await api2State(config)
	await SessionIndex.load(config, captureLogger().logger)
	// the api-2 image ran again: its save drops `version` and `archived`, and it added a conversation
	const rolledBack = (await readJson(indexFile(config))).sessions.map(({ archived, stats, ...rest }) => rest)
	const added = "1790200000001"
	await writeJson(path.join(dataDir(config, added), "state", "taskHistory.json"), [historyItem(added, 1790200000500, "After rollback", 6)])
	rolledBack.push({ sessionId: added, dataDir: dataDir(config, added), runDir: `runs/${added}`, legacy: false, title: "After rollback", createdAt: 1790200000000, updatedAt: 1790200000500 })
	await writeJson(indexFile(config), { legacyImported: true, sessions: rolledBack })

	const index = await SessionIndex.load(config, captureLogger().logger)
	assert.equal((await readJson(indexFile(config))).version, 3)
	assert.equal(index.isArchived(added), true)
	assert.equal(index.get(added).stats.tokensIn, 6000)
	assert.equal(await fs.readFile(path.join(config.gatewayStateDir, "index.v2.json"), "utf8"), original, "the pre-migration backup is kept")

	// and a backup that existed before the first migration is never replaced either
	const other = await sandbox(t)
	await api2State(other.config)
	await fs.writeFile(path.join(other.config.gatewayStateDir, "index.v2.json"), "OLDER BACKUP")
	await SessionIndex.load(other.config, captureLogger().logger)
	assert.equal(await fs.readFile(path.join(other.config.gatewayStateDir, "index.v2.json"), "utf8"), "OLDER BACKUP")
	assert.deepEqual((await fs.readdir(other.config.gatewayStateDir)).filter((n) => n.endsWith(".tmp")), [])
})

test("legacy import: a fresh gateway imports the shared Cline history once, archived; nothing to back up", async (t) => {
	const { config } = await sandbox(t)
	await api2State(config)
	await fs.rm(indexFile(config))
	// a fresh gateway: no index and no gateway logs (a lost index WITH logs is rebuilt, see below)
	await fs.rm(path.join(config.gatewayStateDir, "sessions"), { recursive: true, force: true })
	const log = captureLogger()
	const index = await SessionIndex.load(config, log.logger)
	assert.equal(index.damaged, false)
	assert.deepEqual([...index.entries.keys()].sort(), [...L].sort(), "the 3 conversations, not the 7 specialist children")
	for (const id of L) {
		const entry = index.get(id)
		assert.equal(entry.legacy, true)
		assert.equal(entry.archived, true)
		assert.equal(entry.runDir, null)
		assert.equal(entry.dataDir, config.clineDataDir)
		assert.ok(entry.stats.tokensIn > 0)
	}
	assert.equal(index.get(L[2]).title, "Plot Au by hole")
	assert.equal(await exists(path.join(config.gatewayStateDir, "index.v2.json")), false)
	const disk = await readJson(indexFile(config))
	assert.equal(disk.version, 3)
	assert.equal(disk.legacyImported, true)
	assert.ok(log.lines.some((l) => l.message === "imported legacy conversations" && l.extra.count === 3))

	// imported once: a conversation added to the shared history later is not imported
	const history = await readJson(path.join(config.clineDataDir, "state", "taskHistory.json"))
	history.push(historyItem("1789600000001", 1789600000001, "late", 1))
	await writeJson(path.join(config.clineDataDir, "state", "taskHistory.json"), history)
	assert.equal((await SessionIndex.load(config, captureLogger().logger)).has("1789600000001"), false)

	// an empty machine: version 3, no entries, no error
	const empty = await sandbox(t)
	const fresh = await SessionIndex.load(empty.config, captureLogger().logger)
	assert.equal(fresh.entries.size, 0)
	assert.deepEqual(await readJson(indexFile(empty.config)), { version: 3, legacyImported: true, sessions: [] })
})

// ---- pruning -------------------------------------------------------------------------------------------------

test("pruneUnprompted: never-prompted ses_ and 13-digit entries go (log, empty run folder, Cline data dir); outputs stay", async (t) => {
	const { config } = await sandbox(t)
	await api2State(config)
	const index = await SessionIndex.load(config, captureLogger().logger)
	// engine conversations: two never prompted (one wrote a file), one prompted
	for (const id of ["ses_aaa", "ses_bbb", "ses_ccc"]) {
		await index.add({ sessionId: id, runDir: `runs/${id}`, agentMode: "geology" })
		await fs.mkdir(runDir(config, id), { recursive: true })
		await writeLog(config, id, 1)
	}
	await writeJson(path.join(runDir(config, "ses_bbb"), "results", "early.csv"), "x\n")
	await index.touch("ses_ccc", { title: "Prompted" })
	// a legacy import without a task text has no title, but it was prompted: kept
	index.entries.set("1789500000004", { sessionId: "1789500000004", dataDir: config.clineDataDir, runDir: null, legacy: true, title: null, createdAt: 1, updatedAt: 1, archived: true, stats: {} })

	const log = captureLogger()
	index.logger = log.logger
	const removed = await index.pruneUnprompted()
	assert.deepEqual(removed.sort(), ["ses_aaa", "ses_bbb"], "only the engine sessions the broker must delete")

	for (const id of [...U, "ses_aaa", "ses_bbb"]) {
		assert.equal(index.has(id), false, id)
		assert.equal(await exists(logDir(config, id)), false, `log ${id}`)
	}
	assert.equal(await exists(runDir(config, U[0])), false, "an empty run folder goes")
	assert.equal(await exists(runDir(config, "ses_aaa")), false)
	assert.equal(await fs.readFile(path.join(runDir(config, U[1]), "notes.txt"), "utf8"), "keep me", "a run folder with a file is kept")
	assert.equal(await fs.readFile(path.join(runDir(config, "ses_bbb"), "results", "early.csv"), "utf8"), "x\n")
	for (const id of U) assert.equal(await exists(dataDir(config, id)), false, `Cline data dir ${id}`)

	for (const id of [...L, ...P, "ses_ccc", "1789500000004"]) assert.ok(index.has(id), id)
	for (const id of [...L, ...P, "ses_ccc"]) assert.ok(await exists(logDir(config, id)), `log ${id} kept`)
	assert.ok(await exists(path.join(runDir(config, P[0]), "results", "summary.csv")))
	assert.ok(await exists(runDir(config, P[1])), "a prompted conversation's empty run folder is kept")
	assert.ok(await exists(dataDir(config, P[0])))
	assert.ok(await exists(path.join(config.clineDataDir, "state", "taskHistory.json")), "the shared Cline dir is never touched")

	const disk = await readJson(indexFile(config))
	assert.deepEqual(disk.sessions.map((s) => s.sessionId).sort(), [...L, ...P, "ses_ccc", "1789500000004"].sort())
	const done = log.lines.find((l) => l.message === "removed conversations that were never prompted")
	assert.deepEqual(done.extra, { count: 4, engine: 2, keptRunDirs: 2 })
	assert.deepEqual(await index.pruneUnprompted(), [], "nothing left the second time")
})

test("pruneUnprompted: a Cline data dir is removed only when it is <conversationsDir>/<id>", async (t) => {
	const { config } = await sandbox(t)
	const elsewhere = path.join(config.workspaceDir, "not-ours")
	await fs.mkdir(path.join(elsewhere, "state"), { recursive: true })
	await fs.mkdir(dataDir(config, "1790300000002"), { recursive: true })
	await writeJson(indexFile(config), {
		version: 3,
		legacyImported: true,
		sessions: [
			{ sessionId: "1790300000001", dataDir: elsewhere, runDir: "runs/1790300000001", title: null, archived: true, stats: {}, createdAt: 1, updatedAt: 1 },
			{ sessionId: "1790300000003", dataDir: dataDir(config, "1790300000002"), runDir: null, title: null, archived: true, stats: {}, createdAt: 1, updatedAt: 1 },
		],
	})
	const index = await SessionIndex.load(config, captureLogger().logger)
	assert.deepEqual(await index.pruneUnprompted(), [])
	assert.ok(await exists(path.join(elsewhere, "state")), "a dataDir outside conversationsDir is never deleted")
	assert.ok(await exists(dataDir(config, "1790300000002")), "another conversation's data dir is never deleted")
	assert.equal(index.entries.size, 0)
})

test("pruneOrphans: unknown logs (both id kinds), empty unknown run folders and unknown 13-digit Cline dirs go", async (t) => {
	const { config } = await sandbox(t)
	await api2State(config)
	// a malformed entry whose id is still readable: its folders are not orphans
	const raw = await readJson(indexFile(config))
	raw.sessions.push({ sessionId: "ses_quarantined", title: 42 })
	await writeJson(indexFile(config), raw)
	const index = await SessionIndex.load(config, captureLogger().logger)
	await index.add({ sessionId: "ses_known", agentMode: "geology" })
	await writeLog(config, "ses_known", 1)
	await writeLog(config, "ses_quarantined", 1)

	await writeLog(config, "ses_orphanlog", 2) // killed between engine session/new and the index write
	await fs.mkdir(path.join(config.gatewayStateDir, "sessions", "not-an-id"), { recursive: true })
	await fs.writeFile(path.join(config.gatewayStateDir, "sessions", "ses_file"), "a file, not a log dir")
	await fs.mkdir(runDir(config, "ses_orphanrun"), { recursive: true })
	await writeJson(path.join(runDir(config, "1790400000001"), "results", "out.csv"), "keep\n")
	await fs.mkdir(runDir(config, "not-an-id"), { recursive: true })
	await fs.mkdir(runDir(config, "ses_known"), { recursive: true })
	await fs.mkdir(path.join(dataDir(config, "1790400000002"), "state"), { recursive: true })
	await fs.mkdir(dataDir(config, "ses_notcline"), { recursive: true })

	const log = captureLogger()
	index.logger = log.logger
	const count = await index.pruneOrphans()
	assert.equal(count, 4, "2 logs (api-1 13-digit + ses_), 1 run folder, 1 Cline data dir")
	assert.equal(await exists(logDir(config, API1_ORPHAN_LOG)), false, "the api-1 log nobody pruned")
	assert.equal(await exists(logDir(config, "ses_orphanlog")), false)
	assert.equal(await exists(runDir(config, "ses_orphanrun")), false)
	assert.equal(await exists(dataDir(config, "1790400000002")), false)

	assert.equal(await fs.readFile(path.join(runDir(config, "1790400000001"), "results", "out.csv"), "utf8"), "keep\n", "outputs are never deleted")
	for (const kept of [
		logDir(config, "ses_known"), logDir(config, "ses_quarantined"), logDir(config, "not-an-id"),
		path.join(config.gatewayStateDir, "sessions", "ses_file"), runDir(config, "not-an-id"), runDir(config, "ses_known"),
		dataDir(config, "ses_notcline"), ...[...L, ...P, ...U].map((id) => logDir(config, id)), ...[...P, ...U].map((id) => dataDir(config, id)),
		runDir(config, P[1]), runDir(config, U[0]),
	]) {
		assert.ok(await exists(kept), kept)
	}
	assert.deepEqual(log.lines.at(-1).extra, { logs: 2, runDirs: 1, dataDirs: 1, keptRunDirs: 1 })
	assert.equal(await index.pruneOrphans(), 0)
})

// ---- list, touch, add, remove ----------------------------------------------------------------------------------

test("list: titled entries only, newest first, 50 a page with a numeric cursor; _meta per entry kind", async (t) => {
	const { config } = await sandbox(t)
	const sessions = []
	for (let i = 0; i < 110; i++) {
		sessions.push({ sessionId: `ses_n${i}`, engine: "opencode", runDir: `runs/ses_n${i}`, agentMode: i % 2 ? "geology" : "report-analysis", title: `chat ${i}`, createdAt: 1790000000000 + i, updatedAt: 1790000000000 + i * 1000, modelId: "proxy/z-ai/glm-4.7-flash", contextUsed: 100 * i, contextSize: 200000 })
	}
	sessions.push({ sessionId: "ses_untitled", engine: "opencode", runDir: "runs/ses_untitled", agentMode: "geology", title: null, createdAt: 1, updatedAt: 1890000000000 })
	sessions.push({ sessionId: "ses_bare", engine: "opencode", runDir: "runs/ses_bare", agentMode: "geology", title: "no usage yet", createdAt: 1, updatedAt: 1790000500000 })
	sessions.push({ sessionId: L[0], dataDir: config.clineDataDir, runDir: null, legacy: true, title: "old legacy", createdAt: 1, updatedAt: 1789000000000, archived: true, stats: { tokensIn: 11, tokensOut: 22, totalCost: 0.5, modelId: "anthropic/claude-sonnet-4.5", size: 999 } })
	sessions.push({ sessionId: P[0], dataDir: dataDir(config, P[0]), runDir: `runs/${P[0]}`, legacy: false, agentMode: "geology", title: "api 2", createdAt: 1, updatedAt: 1890000000001, archived: true, stats: { tokensIn: 3, tokensOut: 4, totalCost: 0, modelId: null, size: null } })
	await writeJson(indexFile(config), { version: 3, legacyImported: true, sessions })
	const index = await SessionIndex.load(config, captureLogger().logger)
	await fs.rm(config.clineDataDir, { recursive: true, force: true }) // list never opens Cline files

	const page1 = await index.list(undefined)
	assert.equal(page1.sessions.length, 50)
	assert.equal(page1.nextCursor, "50")
	assert.equal(page1.sessions[0].sessionId, P[0], "newest updatedAt first")
	assert.equal(page1.sessions[1].sessionId, "ses_bare")
	assert.equal(page1.sessions[2].sessionId, "ses_n109")
	const page2 = await index.list("50")
	const page3 = await index.list(page2.nextCursor)
	assert.equal(page2.nextCursor, "100")
	assert.equal(page3.sessions.length, 13)
	assert.equal(page3.nextCursor, null)
	const all = [...page1.sessions, ...page2.sessions, ...page3.sessions]
	assert.ok(all.every((session) => !Object.hasOwn(session._meta, "totalCost")), "Public lists conceal supplier amounts for engine and archived conversations")
	assert.equal(new Set(all.map((s) => s.sessionId)).size, 113, "every titled entry once")
	assert.ok(!all.some((s) => s.sessionId === "ses_untitled"), "an entry without a title is not listed")
	assert.equal(all.at(-1).sessionId, L[0])
	for (let i = 1; i < all.length; i++) assert.ok(all[i - 1].updatedAt >= all[i].updatedAt, "ISO strings sort like the times")
	assert.deepEqual((await index.list("abc")).sessions[0], page1.sessions[0], "a bad cursor is the first page")
	assert.deepEqual((await index.list("-5")).sessions[0], page1.sessions[0])
	assert.deepEqual((await index.list("500")).sessions, [])

	const n = all.find((s) => s.sessionId === "ses_n7")
	assert.deepEqual(n, {
		sessionId: "ses_n7",
		cwd: config.workspaceDir,
		title: "chat 7",
		updatedAt: new Date(1790000007000).toISOString(),
		_meta: { archived: false, legacy: false, runDir: "runs/ses_n7", agentMode: "geology", modelId: "proxy/z-ai/glm-4.7-flash", tokensIn: null, tokensOut: null, contextUsed: 700, contextSize: 200000, size: null },
	})
	assert.deepEqual(all.find((s) => s.sessionId === "ses_bare")._meta, { archived: false, legacy: false, runDir: "runs/ses_bare", agentMode: "geology", modelId: null, tokensIn: null, tokensOut: null, contextUsed: null, contextSize: null, size: null })
	assert.deepEqual(all.at(-1)._meta, { archived: true, legacy: true, runDir: null, agentMode: null, modelId: "anthropic/claude-sonnet-4.5", tokensIn: 11, tokensOut: 22, contextUsed: null, contextSize: null, size: 999 })
	assert.deepEqual(page1.sessions[0]._meta, { archived: true, legacy: false, runDir: `runs/${P[0]}`, agentMode: "geology", modelId: null, tokensIn: 3, tokensOut: 4, contextUsed: null, contextSize: null, size: null })
})

test("add, touch, remove: engine entries, whitelisted touch fields, persisted; concurrent saves stay atomic", async (t) => {
	const { config } = await sandbox(t)
	const log = captureLogger()
	const index = await SessionIndex.load(config, log.logger)
	const t0 = Date.now()
	await index.add({ sessionId: "ses_t1", runDir: "runs/ses_t1", agentMode: "report-analysis" })
	const entry = index.get("ses_t1")
	assert.deepEqual({ ...entry, createdAt: 0, updatedAt: 0 }, { sessionId: "ses_t1", engine: "opencode", runDir: "runs/ses_t1", agentMode: "report-analysis", title: null, createdAt: 0, updatedAt: 0 })
	assert.ok(entry.createdAt >= t0 && entry.updatedAt === entry.createdAt)
	assert.equal(index.isArchived("ses_t1"), false)
	await index.add({ sessionId: "ses_t2" })
	assert.equal(index.get("ses_t2").runDir, "runs/ses_t2", "runDir defaults to runs/<id>")
	for (const bad of ["1790000000001", "../x", "ses_", "ses_a/b", undefined]) {
		await assert.rejects(index.add({ sessionId: bad }), TypeError, String(bad))
	}
	assert.ok(isEngineId("ses_f08aa3f17ffeyjDGhsveJjFqLr") && !isEngineId("1790000000001") && !isEngineId(42))

	index.get("ses_t1").updatedAt = 1 // so the bump is visible
	assert.equal(await index.touch("ses_t1", { title: "First question", modelId: "proxy/x", contextUsed: 1200, contextSize: 200000, sessionId: "evil", archived: true, stats: {} }), true)
	const touched = index.get("ses_t1")
	assert.deepEqual(
		{ title: touched.title, modelId: touched.modelId, contextUsed: touched.contextUsed, contextSize: touched.contextSize, sessionId: touched.sessionId, archived: touched.archived, stats: touched.stats },
		{ title: "First question", modelId: "proxy/x", contextUsed: 1200, contextSize: 200000, sessionId: "ses_t1", archived: undefined, stats: undefined },
	)
	assert.ok(touched.updatedAt >= t0)
	assert.deepEqual(log.of("warn").at(-1).extra, { sessionId: "ses_t1", ignored: ["sessionId", "archived", "stats"] })
	await index.touch("ses_t1", { title: undefined, contextUsed: 1500 })
	assert.equal(index.get("ses_t1").title, "First question", "undefined leaves a field as is")
	assert.equal(index.get("ses_t1").contextUsed, 1500)
	await index.touch("ses_t1")
	assert.equal(await index.touch("ses_nope", { title: "x" }), false)

	const reloaded = await SessionIndex.load(config, captureLogger().logger)
	assert.deepEqual(reloaded.get("ses_t1"), index.get("ses_t1"))

	assert.equal(await index.remove("ses_t2"), true)
	assert.equal(await index.remove("ses_t2"), false)
	assert.equal((await SessionIndex.load(config, captureLogger().logger)).has("ses_t2"), false)

	// many writers at once: every save lands whole, the last one wins, no tmp file is left behind
	await Promise.all(Array.from({ length: 30 }, (_, i) => (i % 2 ? index.add({ sessionId: `ses_c${i}` }) : index.touch("ses_t1", { contextUsed: i }))))
	const disk = await readJson(indexFile(config))
	assert.equal(disk.sessions.length, 1 + 15)
	assert.equal(disk.sessions.find((s) => s.sessionId === "ses_t1").contextUsed, 28)
	assert.deepEqual((await fs.readdir(config.gatewayStateDir)).filter((n) => n.endsWith(".tmp")), [])
	assert.equal((await fs.stat(indexFile(config))).mode & 0o777, 0o600)
})

// ---- malformed input -----------------------------------------------------------------------------------------

test("a malformed entry doesn't break load or list: skipped with a warning, kept verbatim in the file", async (t) => {
	const { config } = await sandbox(t)
	const malformed = [null, "str", 42, [], {}, { sessionId: "../../etc" }, { sessionId: "ses_bad", title: 5 }, { sessionId: "ses_run", title: "x", runDir: { a: 1 } }, { sessionId: "ses_dup", title: "second" }]
	const good = [
		{ sessionId: "ses_dup", engine: "opencode", runDir: "runs/ses_dup", title: "first", createdAt: 1790000000000, updatedAt: 1790000000000 },
		{ sessionId: "ses_ok", engine: "opencode", runDir: "runs/ses_ok", title: "fine", createdAt: 1790000001000, updatedAt: "garbage" },
		{ sessionId: 1790000000009, dataDir: dataDir(config, "1790000000009"), runDir: "runs/1790000000009", title: "numeric id", createdAt: 1790000000500, updatedAt: 1790000000500 },
		{ sessionId: "ses_huge", engine: "opencode", runDir: "runs/ses_huge", title: "far future", createdAt: 1, updatedAt: 1e20 },
	]
	await writeJson(indexFile(config), { version: 3, legacyImported: true, sessions: [good[0], ...malformed, ...good.slice(1)] })
	const log = captureLogger()
	const index = await SessionIndex.load(config, log.logger)
	assert.equal(log.of("warn").filter((l) => l.message.startsWith("index.json: malformed")).length, malformed.length)
	assert.deepEqual([...index.entries.keys()].sort(), ["1790000000009", "ses_dup", "ses_huge", "ses_ok"])
	assert.equal(index.get("ses_dup").title, "first", "the first of two duplicates wins")
	assert.equal(index.get("ses_ok").updatedAt, 1790000001000, "a bad updatedAt falls back to createdAt")
	assert.equal(index.isArchived("1790000000009"), true, "a numeric legacy id is read as its string and archived")

	const { sessions } = await index.list()
	assert.deepEqual(sessions.map((s) => s.sessionId), ["ses_huge", "ses_ok", "1790000000009", "ses_dup"])
	assert.equal(sessions[0].updatedAt, new Date(0).toISOString(), "an out-of-range time lists as the epoch, never throws")

	await index.touch("ses_ok", { title: "renamed" })
	const disk = await readJson(indexFile(config))
	assert.equal(disk.sessions.length, good.length + malformed.length)
	assert.deepEqual(disk.sessions.slice(-malformed.length), malformed, "malformed entries are written back verbatim")

	// a `sessions` that isn't an array, and an index that isn't JSON at all
	const other = await sandbox(t)
	await writeJson(indexFile(other.config), { version: 3, legacyImported: true, sessions: { not: "an array" } })
	const log2 = captureLogger()
	const notArray = await SessionIndex.load(other.config, log2.logger)
	assert.equal(notArray.entries.size, 0)
	assert.equal(notArray.damaged, true, "not an index: the caller skips this boot's pruning")
	assert.equal(log2.of("warn").length, 1)

	const broken = await sandbox(t)
	await fs.writeFile(indexFile(broken.config), '{"legacyImported":true,"sessions":[{"sessionId":')
	const log3 = captureLogger()
	const fresh = await SessionIndex.load(broken.config, log3.logger)
	assert.equal(fresh.entries.size, 0)
	assert.equal(fresh.damaged, true)
	assert.deepEqual(
		log3.of("error").map((l) => l.message),
		["the conversation index is unreadable; starting from an empty index", "the conversation index was damaged or missing; rebuilt it from the session logs, and boot pruning is skipped"],
	)
	const names = await fs.readdir(broken.config.gatewayStateDir)
	const kept = names.find((n) => n.startsWith("index.json.unreadable-"))
	assert.ok(kept, names.join(", "))
	assert.equal(await fs.readFile(path.join(broken.config.gatewayStateDir, kept), "utf8"), '{"legacyImported":true,"sessions":[{"sessionId":')
	assert.ok(!names.includes("index.v2.json"), "an unreadable file is not a rollback backup")
	assert.equal((await readJson(indexFile(broken.config))).version, 3)
})

test("a damaged or lost index is rebuilt from the session logs' meta.json; pruneOrphans never deletes a transcript (review SEC-2)", async (t) => {
	const { config } = await sandbox(t)
	const sessionsDir = path.join(config.gatewayStateDir, "sessions")
	const writeLog = async (id, meta, events) => {
		await fs.mkdir(path.join(sessionsDir, id), { recursive: true })
		await writeJson(path.join(sessionsDir, id, "meta.json"), meta)
		await fs.writeFile(path.join(sessionsDir, id, "events.ndjson"), events.map((e) => JSON.stringify(e)).join("\n") + (events.length ? "\n" : ""))
	}
	const event = { seq: 1, ts: 1, kind: "update", update: { sessionUpdate: "user_message_chunk" } }
	await writeLog("ses_Prompted1", { sessionId: "ses_Prompted1", runDir: "runs/ses_Prompted1", agentMode: "standard", title: "drill grades", createdAt: 1790000000000, updatedAt: 1790000001000 }, [event])
	await writeLog("ses_NoTitle1", { sessionId: "ses_NoTitle1", createdAt: 1790000002000 }, [event])
	await writeLog("ses_Empty1", { sessionId: "ses_Empty1", createdAt: 1790000003000 }, [])
	await writeLog("1790000000777", { sessionId: "1790000000777", title: "old cline chat", createdAt: 1790000000777 }, [event])

	for (const damage of ["missing", "truncated", "sessions-object"]) {
		if (damage === "missing") await fs.rm(indexFile(config), { force: true })
		if (damage === "truncated") await fs.writeFile(indexFile(config), '{"version":3,"sessions":[')
		if (damage === "sessions-object") await writeJson(indexFile(config), { version: 3, legacyImported: true, sessions: {} })
		const log = captureLogger()
		const index = await SessionIndex.load(config, log.logger)
		assert.equal(index.damaged, true, damage)
		const prompted = index.get("ses_Prompted1")
		assert.deepEqual([prompted.title, prompted.agentMode, prompted.runDir, prompted.archived ?? false], ["drill grades", "standard", "runs/ses_Prompted1", false], damage)
		assert.equal(index.get("ses_NoTitle1").title, "(recovered conversation)", `${damage}: a log with events is listed, never pruned`)
		assert.equal(index.get("ses_Empty1").title, null, `${damage}: an empty log stays unprompted`)
		assert.equal(index.isArchived("1790000000777"), true, `${damage}: a Cline id comes back archived`)
		assert.ok((await index.list()).sessions.some((s) => s.sessionId === "ses_NoTitle1"))
		await fs.rm(indexFile(config), { force: true })
		// the next boot sees the rebuilt (now valid) index, unless it was deleted again as above
	}

	// backstop: even on a healthy boot, an unknown log with events is set aside, an empty one removed
	const healthy = await sandbox(t)
	const hDir = path.join(healthy.config.gatewayStateDir, "sessions")
	await fs.mkdir(path.join(hDir, "ses_Stray1"), { recursive: true })
	await fs.writeFile(path.join(hDir, "ses_Stray1", "events.ndjson"), JSON.stringify(event) + "\n")
	await fs.mkdir(path.join(hDir, "ses_Stray2"), { recursive: true })
	await writeJson(indexFile(healthy.config), { version: 3, legacyImported: true, sessions: [] })
	const index = await SessionIndex.load(healthy.config, captureLogger().logger)
	assert.equal(index.damaged, false)
	await index.pruneOrphans()
	const left = await fs.readdir(hDir)
	assert.ok(!left.includes("ses_Stray1") && !left.includes("ses_Stray2"))
	const aside = await fs.readdir(path.join(hDir, ".orphaned"))
	assert.equal(aside.length, 1)
	assert.match(aside[0], /^ses_Stray1-\d+$/)
	assert.ok((await fs.readFile(path.join(hDir, ".orphaned", aside[0], "events.ndjson"), "utf8")).includes("user_message_chunk"))
})
