import assert from "node:assert/strict"
import crypto from "node:crypto"
import { spawnSync } from "node:child_process"
import { constants } from "node:fs"
import fs from "node:fs/promises"
import os from "node:os"
import path from "node:path"
import { setTimeout as wait } from "node:timers/promises"
import { test } from "node:test"
import { Worker } from "node:worker_threads"
import { FileIndex } from "../lib/file-index.js"
import { FileSearch } from "../lib/file-search.js"
import { FileError, canonicalPath } from "../lib/file-contract.js"
import { buildFilesOpenApi } from "../lib/files-openapi.js"

const identity = { workspaceId: "workspace", workspaceEpoch: "epoch" }
const ref = (path) => ({ ...identity, path })
const clone = (value) => JSON.parse(JSON.stringify(value))
const MiB = 1024 * 1024
// V8 reserves far more virtual address space than rg. Only the bounded JS test helpers use this override.
const NODE_WORKER_LIMITS = { searchWorkerBytes: 64 * 1024 * MiB }
const NATIVE_HEADERS = `
#define _GNU_SOURCE
#include <errno.h>
#include <signal.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <sys/mman.h>
#include <sys/resource.h>
#include <unistd.h>
`

class MemoryState {
	identity = identity
	records = new Map()
	get(kind, id) { return Promise.resolve(clone(this.records.get(`${kind}:${id}`) ?? null)) }
	put(kind, id, value) { this.records.set(`${kind}:${id}`, clone(value)); return Promise.resolve(value) }
	delete(kind, id) { return Promise.resolve(this.records.delete(`${kind}:${id}`)) }
	list(kind) { return Promise.resolve([...this.records].filter(([key]) => key.startsWith(`${kind}:`)).map(([, value]) => clone(value))) }
	async transaction(ops) { for (const op of ops) await (op.type === "put" ? this.put(op.kind, op.id, op.value) : this.delete(op.kind, op.id)) }
}

async function fixture(t, limits = {}) {
	const dir = await fs.mkdtemp(path.join(os.tmpdir(), "file-discovery-"))
	const root = path.join(dir, "ws")
	await fs.mkdir(root)
	const denied = new Map()
	const calls = { entries: 0, open: [], stat: [] }
	let generation = 0
	let gate
	const visible = (name) => !name.split("/").some((part) => part === ".private")
	// A controllable contract adapter, not a replacement for SafeFs containment tests.
	const safeFs = {
		root, get generation() { return generation },
		policy: {
			visible,
			assertRead(name) {
				canonicalPath(name)
				if (!visible(name)) throw new FileError(403, "protected_resource", "Private runtime state is hidden.")
				if (denied.get(name) === "stat") throw Object.assign(new Error("permission denied"), { code: "EACCES" })
			},
			assertWrite() { throw new Error("Discovery cannot write.") },
		},
		async checked(name, allowSymlink = false) {
			this.policy.assertRead(name)
			const parts = name ? name.split("/") : []
			for (let n = 1; n <= parts.length; n++) {
				const stat = await fs.lstat(path.join(root, ...parts.slice(0, n)), { bigint: true })
				if (stat.isSymbolicLink() && !(allowSymlink && n === parts.length)) throw new FileError(400, "invalid_path", "Symlinks are not followed.", { reason: "symlink" })
			}
			return path.join(root, name)
		},
		async stat(name, { allowSymlink = false } = {}) { calls.stat.push(name); return fs.lstat(await this.checked(name, allowSymlink), { bigint: true }) },
		async open(name) {
			calls.open.push(name)
			const handle = await fs.open(await this.checked(name), constants.O_RDONLY | constants.O_NOFOLLOW)
			return { fd: handle.fd, stat: (options) => handle.stat(options), read: (...args) => handle.read(...args), createReadStream: (...args) => handle.createReadStream(...args), close: () => handle.close() }
		},
		async *entries(name) {
			calls.entries++
			await this.checked(name)
			if (denied.get(name) === "entries") throw Object.assign(new Error("cannot enumerate folder"), { code: "EACCES" })
			if (gate) await gate
			for (const entry of await fs.readdir(path.join(root, name), { withFileTypes: true, encoding: "buffer" })) {
				let text
				try { text = new TextDecoder("utf-8", { fatal: true }).decode(entry.name); canonicalPath(text, { root: false }) } catch { text = null }
				yield { name: text, diagnostic: text === null ? `bytes:${entry.name.toString("hex")}` : undefined, type: entry.isSymbolicLink() ? "symlink" : entry.isDirectory() ? "dir" : entry.isFile() ? "file" : "other" }
			}
		},
	}
	const state = new MemoryState()
	const events = []
	const indexes = []
	const index = new FileIndex({ safeFs, state, ref, limits: { scanIntervalMs: 60000, ...limits }, onEvent: (type, payload) => events.push({ type, payload }) })
	indexes.push(index)
	t.after(async () => { for (const index of indexes) await index.close(); await fs.rm(dir, { recursive: true, force: true }) })
	return {
		dir, root, safeFs, state, index, calls, events, denied,
		write: async (name, text) => { await fs.mkdir(path.dirname(path.join(root, name)), { recursive: true }); await fs.writeFile(path.join(root, name), text) },
		async start() { await index.init(); await index.ready },
		pause() { let resolve; gate = new Promise((r) => { resolve = r }); return () => { gate = null; resolve() } },
		bumpPolicy() { generation++ },
		async restart() { await index.close(); const next = new FileIndex({ safeFs, state, ref, limits: { scanIntervalMs: 60000, ...limits } }); indexes.push(next); await next.init(); await next.ready; return next },
		async rg(script) { const bin = path.join(dir, `rg-${crypto.randomUUID()}`); await fs.writeFile(bin, `#!${process.execPath}\n${script}`, { mode: 0o755 }); return bin },
		async nativeWorker(body) {
			const bin = path.join(dir, `rg-native-${crypto.randomUUID()}`)
			const compiled = spawnSync(process.env.CC || "cc", ["-x", "c", "-std=c11", "-O2", "-Wall", "-Werror", "-o", bin, "-"], { input: NATIVE_HEADERS + body, encoding: "utf8", timeout: 15000 })
			assert.equal(compiled.error, undefined, `Native limit-proof test requires cc: ${compiled.error}`)
			assert.equal(compiled.status, 0, compiled.stderr)
			return bin
		},
	}
}

test("index: full-view sorting/filtering, immutable paging, and live stat metadata", async (t) => {
	const f = await fixture(t)
	await f.write("a.txt", "large".repeat(10))
	await f.write("b.txt", "bb")
	await f.write("sub/c.txt", "c")
	await f.write(".private/secret", "hidden")
	await fs.symlink("sub", path.join(f.root, "alias"))
	await f.start()
	const first = await f.index.find({ kind: "file", sort: "size", limit: 1 })
	assert.deepEqual(first.items.map((row) => row.path), ["sub/c.txt"], "sorting happens before slicing, not on the first directory page")
	assert.deepEqual(first.count, { value: 3, relation: "exact" })
	assert.equal(first.coverage.state, "ready")
	assert.equal(first.filesContractVersion, 1)
	assert.ok(Object.isFrozen(first.items[0].persistence))
	assert.throws(() => { first.items[0].sizeBytes = 999 }, TypeError)
	await f.write("b.txt", "changed-to-large".repeat(100))
	await fs.rm(path.join(f.root, "a.txt"))
	await f.index.refresh()
	const rest = await f.index.find({ kind: "file", sort: "size", limit: 10, cursor: first.nextCursor })
	assert.deepEqual(rest.items.map((row) => [row.path, row.sizeBytes]), [["b.txt", 2], ["a.txt", 50]])
	assert.equal(rest.viewId, first.viewId)
	assert.equal(rest.nextCursor, null)
	const live = await f.index.stat("b.txt")
	assert.equal(live.sizeBytes, 1600)
	assert.equal(live.availability, "local")
	assert.deepEqual(live.ref, ref("b.txt"))
	assert.ok(live.observation.token)
	assert.equal(live.persistence.state, "not-configured")
	await assert.rejects(f.index.stat("a.txt"), { status: 404, error: "not_found" })
	const listing = await f.index.list()
	assert.equal(listing.items[0].type, "dir")
	assert.equal(listing.items.find((row) => row.name === "alias").type, "symlink")
	assert.ok(!listing.items.some((row) => row.path.startsWith(".private") || row.path.startsWith("alias/")))
})

test("index: fuzzy find tolerates typos, ranks the best match first and marks the matched characters", async (t) => {
	const f = await fixture(t)
	const files = ["geology/collars.csv", "geology/assays.csv", "tables/table-02-assays.csv", "notes/geología_map.md", "photos/🙂site.jpg", ".private/collars.csv"]
	for (const [age, name] of files.entries()) {
		await f.write(name, name)
		const time = new Date(Date.UTC(2026, 0, 1) - age * 60_000)
		await fs.utimes(path.join(f.root, name), time, time)
	}
	await f.start()
	const fuzzy = (q) => f.index.find({ q, mode: "fuzzy", kind: "file", sort: "relevance" })
	const marked = (item) => [...item.path].filter((_, index) => item.matches.includes(index)).join("")

	// "collers" is neither part of a name nor a subsequence of one; only a typo-tolerant match finds collars.csv.
	assert.equal((await f.index.find({ q: "collers", kind: "file" })).items.length, 0)
	const collars = await fuzzy("collers")
	assert.deepEqual(collars.items.map((row) => row.path), ["geology/collars.csv"])
	assert.deepEqual(collars.count, { value: 1, relation: "exact" })
	assert.equal((await fuzzy("tabass")).items[0].path, "tables/table-02-assays.csv")

	// Matched characters are counted in code points, so accented and emoji names mark the right letters.
	const [map] = (await fuzzy("ía_map")).items
	assert.equal(map.path, "notes/geología_map.md")
	assert.equal(marked(map), "ía_map")
	const [site] = (await fuzzy("site")).items
	assert.deepEqual(site.matches, [8, 9, 10, 11])
	assert.equal(marked(site), "site")

	// With nothing typed every file ties, so the most recently changed comes first.
	const all = await fuzzy("")
	assert.deepEqual(all.items.map((row) => row.path), files.slice(0, -1))
	assert.ok(all.items.every((row) => row.matches.length === 0))
	assert.equal((await f.index.find({ q: "assays", kind: "file" })).items[0].matches, undefined)
})

test("index: a fuzzy view keeps only as many of the best matches as one page can hold", async (t) => {
	const f = await fixture(t, { pageMaxSize: 2 })
	// Newest last, so keeping the most recent matches instead of the best would keep the wrong two.
	for (const [age, name] of ["d/notes.md", "c/s_u_r_v_e_y.csv", "b/sur-vey.csv", "a/survey.csv"].entries()) {
		await f.write(name, name)
		const time = new Date(Date.UTC(2026, 0, 1) - age * 60_000)
		await fs.utimes(path.join(f.root, name), time, time)
	}
	await f.start()
	const page = await f.index.find({ q: "survey", mode: "fuzzy", kind: "file" })
	assert.deepEqual(page.items.map((row) => row.path), ["a/survey.csv", "b/sur-vey.csv"])
	assert.deepEqual(page.count, { value: 2, relation: "at-least" })
	assert.equal(page.nextCursor, null)
	await assert.rejects(f.index.find({ q: "survey", mode: "fuzzy", sort: "name" }), { status: 400, error: "invalid_filter" })
})

test("index: sending the documented find defaults gives the same page as omitting them, in every mode", async (t) => {
	const f = await fixture(t)
	await f.write("a/survey.csv", "survey")
	await f.write("b/notes.md", "notes")
	await f.start()
	// What a client that fills in every documented default sends, as query strings.
	const defaults = Object.fromEntries(buildFilesOpenApi().paths["/files/find"].get.parameters
		.filter((parameter) => parameter.in === "query" && parameter.schema.default !== undefined)
		.map((parameter) => [parameter.name, String(parameter.schema.default)]))
	const page = async (options) => (await f.index.find(options)).items.map((row) => row.path)
	for (const [mode, q] of [["names", "survey"], ["raw-path", "a/survey.csv"], ["fuzzy", "survey"], ["fuzzy", ""]]) {
		assert.deepEqual(await page({ ...defaults, mode, q }), await page({ mode, q }), `${mode} ${JSON.stringify(q)}`)
	}
})

test("index: cursor binds query/scope/epoch, expires, and uses access-ordered LRU budgets", async (t) => {
	const f = await fixture(t, { views: 2, viewIdleMs: 35 })
	for (const name of ["a", "b", "c", "sub/x"]) await f.write(name, name)
	await f.start()
	const a = await f.index.find({ kind: "file", limit: 1 })
	await assert.rejects(f.index.find({ path: "sub", kind: "file", limit: 1, cursor: a.nextCursor }), { status: 400, error: "invalid_cursor" })
	await assert.rejects(f.index.find({ kind: "file", sort: "size", cursor: a.nextCursor }), { status: 400, error: "invalid_cursor" })
	await assert.rejects(f.index.find({ cursor: "bad" }), { status: 400, error: "invalid_cursor" })
	const b = await f.index.list({ limit: 1 })
	await f.index.find({ kind: "file", cursor: a.nextCursor, limit: 1 })
	await f.index.find({ q: "c" })
	await assert.rejects(f.index.list({ cursor: b.nextCursor }), { status: 409, error: "cursor_expired" })
	await f.index.find({ kind: "file", cursor: a.nextCursor, limit: 1 })
	await wait(45)
	await assert.rejects(f.index.find({ kind: "file", cursor: a.nextCursor }), { status: 409, error: "cursor_expired" })
	const fresh = await f.index.list({ limit: 1 })
	f.bumpPolicy()
	await assert.rejects(f.index.list({ cursor: fresh.nextCursor }), { status: 409, error: "cursor_expired" })
	const tiny = await fixture(t, { viewBytes: 1100 })
	await tiny.write("one", "one")
	await tiny.write("two", "two")
	await tiny.start()
	await assert.rejects(tiny.index.list(), { status: 429, error: "capacity" })
})

test("index: initial partial pages, invalid names, scan limits, and permissions never imply completeness", async (t) => {
	const f = await fixture(t)
	await f.write("folder/good.txt", "good")
	await f.write("locked/secret.txt", "secret")
	await fs.writeFile(Buffer.concat([Buffer.from(`${f.root}/`), Buffer.from([0xff])]), "inaccessible-name")
	f.denied.set("locked", "entries")
	const release = f.pause()
	await f.index.init()
	const cold = await f.index.list()
	assert.equal(cold.coverage.state, "indexing")
	assert.notEqual(cold.count.relation, "exact")
	release()
	await f.index.ready
	const full = await f.index.find()
	assert.equal(full.coverage.state, "partial")
	assert.equal(full.coverage.excludedNames, 1)
	assert.equal(full.count.relation, "at-least")
	assert.ok(full.coverage.diagnostics.some((entry) => entry.diagnostic.includes("ff")))
	await assert.rejects(f.index.list({ path: "locked" }), { status: 403, error: "permission_denied" })
	f.denied.set("folder/good.txt", "stat")
	await f.index.refresh()
	const inaccessible = (await f.index.find()).items.find((row) => row.path === "folder/good.txt")
	assert.equal(inaccessible.availability, "unavailable")
	assert.equal(inaccessible.sizeBytes, null)
	assert.equal(inaccessible.error.error, "permission_denied")
	assert.equal(inaccessible.error.agent, "file-service")
	assert.equal(inaccessible.error.tool, "file-index.stat")
	assert.match(inaccessible.error.action, /inspect|retry/i)
	await assert.rejects(f.index.stat("folder/good.txt"), { status: 403, error: "permission_denied" })
	assert.ok(f.events.some((event) => event.type === "reset" && event.payload.reason === "scan-error"))
	const bounded = await fixture(t, { indexScanEntries: 2 })
	for (const name of ["a", "b", "c"]) await bounded.write(name, "x")
	await bounded.start()
	assert.equal((await bounded.index.find()).coverage.state, "partial")
})

test("index: background reconciliation works without a subscription; warm paging does not enumerate", async (t) => {
	const f = await fixture(t, { scanIntervalMs: 25, watchDebounceMs: 5 })
	await f.write("nested/first", "one")
	await f.start()
	await f.write("nested/second", "two")
	const deadline = Date.now() + 1500
	const notified = () => f.events.some((event) => event.type === "invalidation" && event.payload.changes.some((change) => change.path === "nested/second"))
	while (!(await f.index.find({ q: "second" })).items.length || !notified()) { assert.ok(Date.now() < deadline, "continuous reconciliation discovers and publishes descendant changes"); await wait(15) }
	assert.ok(f.events.some((event) => event.type === "invalidation" && event.payload.changes.some((change) => change.path === "nested/second")))
	await f.index.close()
	const restarted = await f.restart()
	const before = f.calls.entries
	for (let n = 0; n < 8; n++) await restarted.list({ path: "nested", limit: 1 })
	assert.equal(f.calls.entries, before, "warm views page indexed metadata without directory re-enumeration")
	const tree = await restarted.tree({ maxEntries: 1 })
	assert.equal(tree.items.length, 1)
	assert.equal(tree.truncated, true)
	assert.equal(tree.stopReason, "entry-limit")
})

test("index: recursive watcher discovers nested writes without waiting for periodic reconciliation", async (t) => {
	const f = await fixture(t, { scanIntervalMs: 60000, watchDebounceMs: 5 })
	await f.write("nested/first", "one")
	await f.start()
	f.events.length = 0
	await f.write("nested/second", "two")
	const deadline = Date.now() + 2000
	for (;;) {
		const event = f.events.find((entry) => entry.type === "invalidation" && entry.payload.changes.some((change) => change.path === "nested/second"))
		if (event && (await f.index.find({ q: "second" })).items.length) break
		assert.ok(Date.now() < deadline, "recursive watch should trigger prompt safe reconciliation")
		await wait(10)
	}
	assert.equal(f.index.info().watcher.scope, "recursive")
})

test("index: a file the file service cannot read is skipped, and the watcher stays ready", async (t) => {
	if (process.getuid?.() === 0) return t.skip("root can watch files it cannot read")
	const f = await fixture(t, { scanIntervalMs: 60000, watchDebounceMs: 5 })
	await f.write("runs/r/_reports/report.md", "# Report")
	await f.start()
	// A report export's temporary file is private to the process that writes it.
	const temporary = path.join(f.root, "runs/r/_reports/html2pdf626-1.pdf")
	await fs.writeFile(temporary, "%PDF-")
	await fs.chmod(temporary, 0o000)
	await wait(100)
	await f.write("runs/r/_reports/next.md", "# Next")
	const deadline = Date.now() + 2000
	while (!(await f.index.find({ q: "next" })).items.length) {
		assert.ok(Date.now() < deadline, "the watcher should keep reporting new files")
		await wait(10)
	}
	assert.equal(f.index.info().watcher.state, "ready")
	assert.equal(f.index.info().watcher.error, undefined)
})

test("index: closing during recursive watcher registration does not hang", async (t) => {
	const f = await fixture(t)
	const opening = f.index.init()
	await Promise.race([
		f.index.close(),
		wait(1000).then(() => { throw new Error("close waited indefinitely for watcher registration") }),
	])
	await Promise.allSettled([opening, f.index.ready])
})

test("index: completed status marks whether a reconciliation observed content changes", async (t) => {
	const f = await fixture(t)
	await f.write("one", "one")
	await f.start()
	f.events.length = 0
	await f.index.refresh()
	let completed = f.events.filter((event) => event.type === "index").at(-1)
	assert.equal(completed.payload.contentChanged, false)
	assert.equal(completed.payload.changeCount, 0)
	await f.write("one", "changed")
	await f.index.refresh()
	completed = f.events.filter((event) => event.type === "index").at(-1)
	assert.equal(completed.payload.contentChanged, true)
	assert.equal(completed.payload.changeCount, 1)
})

test("index: counts and tree cover the selected scope, including a literal file scope", async (t) => {
	const f = await fixture(t)
	await f.write("clean/file.txt", "x")
	await f.write("locked/file.txt", "unreadable")
	f.denied.set("locked", "entries")
	await f.start()
	assert.equal((await f.index.find()).coverage.state, "partial")
	const clean = await f.index.list({ path: "clean" })
	assert.equal(clean.coverage.state, "ready")
	assert.deepEqual(clean.count, { value: 1, relation: "exact" })
	const literal = await f.index.find({ path: "clean/file.txt", mode: "raw-path", q: "clean/file.txt" })
	assert.equal(literal.coverage.state, "ready")
	assert.deepEqual(literal.count, { value: 1, relation: "exact" })
	const tree = await f.index.tree({ path: "clean" })
	assert.deepEqual(tree.items.map((row) => row.path), ["clean/file.txt"])
	assert.equal(tree.count.relation, "exact")
	await assert.rejects(f.index.find({ kind: "invented" }), { error: "invalid_filter" })
})

test("index: retained-view bytes include excluded-name diagnostics, not just items", async (t) => {
	const f = await fixture(t, { viewBytes: 1200 })
	for (let n = 0; n < 3; n++) {
		const bytes = Buffer.alloc(255, 0xff)
		bytes[254] = n + 65
		await fs.writeFile(Buffer.concat([Buffer.from(`${f.root}/`), bytes]), "unaddressable")
	}
	await f.start()
	await assert.rejects(f.index.list(), { status: 429, error: "capacity" })
})

test("index: refresh requested during reconciliation waits for a new observation pass", async (t) => {
	const f = await fixture(t)
	await f.write("a", "old")
	await f.write("b", "b")
	await f.start()
	const stat = f.safeFs.stat.bind(f.safeFs)
	let entered, release
	const started = new Promise((resolve) => { entered = resolve })
	const blocked = new Promise((resolve) => { release = resolve })
	let once = true
	f.safeFs.stat = async (path, options) => {
		if (path === "b" && once) { once = false; entered(); await blocked }
		return stat(path, options)
	}
	const previous = f.index.refresh()
	await started
	await f.write("a", "new-length")
	const requested = f.index.refresh()
	release()
	await previous
	await requested
	assert.equal((await f.index.list()).items.find((row) => row.path === "a").sizeBytes, 10)
})

test("index: directory replacement removes descendants from fresh and restarted views, retaining frozen views", async (t) => {
	for (const replacement of ["file", "symlink"]) {
		const f = await fixture(t)
		await f.write("folder/a.txt", "a")
		await f.write("folder/b.txt", "bb")
		await fs.mkdir(path.join(f.root, "destination"))
		await f.start()
		const frozen = await f.index.find({ kind: "file", limit: 1 })
		await fs.rm(path.join(f.root, "folder"), { recursive: true })
		if (replacement === "file") await f.write("folder", "replacement")
		else await fs.symlink("destination", path.join(f.root, "folder"))
		await f.index.refresh()
		const fresh = await f.index.find()
		assert.ok(!fresh.items.some((row) => row.path.startsWith("folder/")), `${replacement} retains nonexistent descendants`)
		assert.equal(fresh.items.find((row) => row.path === "folder").type, replacement)
		assert.equal(fresh.coverage.state, "ready")
		assert.equal(fresh.count.relation, "exact")
		const rest = await f.index.find({ kind: "file", cursor: frozen.nextCursor })
		assert.deepEqual(rest.items.map((row) => row.path), ["folder/b.txt"])
		assert.deepEqual(rest.count, { value: 2, relation: "exact" })
		const restarted = await f.restart()
		assert.ok(!(await restarted.find()).items.some((row) => row.path.startsWith("folder/")))
	}
})

test("index: budgeted reconciliation eventually visits and updates entries beyond the first prefix", async (t) => {
	const f = await fixture(t, { indexScanEntries: 2 })
	for (let n = 0; n < 8; n++) await f.write(`early-${n}`, "early")
	await f.write("z-folder/later.txt", "old")
	await f.start()
	let discovered = false
	for (let pass = 0; pass < 20; pass++) {
		await f.index.refresh()
		if ((await f.index.find({ q: "later.txt" })).items.length) { discovered = true; break }
	}
	assert.equal(discovered, true, "each budgeted pass must make forward progress")
	await f.write("z-folder/later.txt", "new-length")
	let updated = false
	for (let pass = 0; pass < 20; pass++) {
		await f.index.refresh()
		if ((await f.index.find({ q: "later.txt" })).items[0]?.sizeBytes === 10) { updated = true; break }
	}
	assert.equal(updated, true, "later changes must not be starved by early names")
})

test("index: paused iterators re-prove their address and release directory descriptors on reset/close", async (t) => {
	const f = await fixture(t, { indexScanEntries: 2, watchDebounceMs: 60000 })
	for (const name of ["a", "b", "c"]) await f.write(`folder/${name}`, name)
	const entries = f.safeFs.entries.bind(f.safeFs)
	const closed = []
	const opened = []
	f.safeFs.entries = async function* (name) {
		const descriptor = await this.open(name)
		opened.push(name)
		try { yield* entries(name) } finally { await descriptor.close(); closed.push(name) }
	}
	await f.start()
	for (let pass = 0; !opened.includes("folder") && pass < 10; pass++) await f.index.refresh()
	assert.ok(opened.includes("folder"))
	assert.ok(!closed.includes("folder"))
	await fs.rename(path.join(f.root, "folder"), path.join(f.root, "moved"))
	await f.write("folder/new", "new")
	await f.index.refresh()
	assert.ok(closed.includes("folder"), "a moved directory cannot keep its suspended descriptor")
	assert.ok(f.events.some((event) => event.type === "reset" && event.payload.path === "folder" && event.payload.error.error === "source_changed"))
	await f.index.refresh()
	await f.index.close()
	assert.equal(closed.length, opened.length, "closing releases every suspended directory iterator")
})

test("index: bulk disappearance is reconciled through bounded pruning passes", async (t) => {
	const f = await fixture(t, { indexScanEntries: 2, watchDebounceMs: 60000 })
	for (let n = 0; n < 10; n++) await f.write(`entry-${n}`, "x")
	await f.start()
	for (let pass = 0; f.index.info().state !== "ready" && pass < 30; pass++) await f.index.refresh()
	assert.equal(f.index.info().state, "ready")
	for (let n = 0; n < 10; n++) await fs.rm(path.join(f.root, `entry-${n}`))
	f.events.length = 0
	await f.index.refresh()
	const removed = f.events.filter((event) => event.type === "invalidation").flatMap((event) => event.payload.changes).filter((change) => change.type === "unlink")
	assert.ok(removed.length <= 2, `one two-step pass removed ${removed.length} entries`)
	assert.notEqual((await f.index.find()).coverage.state, "ready", "unfinished pruning cannot advertise a ready catalogue")
	for (let pass = 0; f.index.info().state !== "ready" && pass < 30; pass++) await f.index.refresh()
	const final = await f.index.find()
	assert.equal(final.coverage.state, "ready")
	assert.deepEqual(final.count, { value: 0, relation: "exact" })
})

test("index: jittered public stats share one admission with reconciliation stats", async (t) => {
	const f = await fixture(t)
	await f.write("a", "a")
	await f.write("b", "b")
	await f.start()
	const stat = f.safeFs.stat.bind(f.safeFs)
	let active = 0, peak = 0
	f.safeFs.stat = async (...args) => {
		active++
		peak = Math.max(peak, active)
		try { await wait(Math.floor(Math.random() * 5) + 1); return await stat(...args) } finally { active-- }
	}
	const scanning = f.index.refresh()
	const lookups = Array.from({ length: 12 }, async () => { await wait(Math.floor(Math.random() * 5)); return f.index.stat("b") })
	await Promise.all([scanning, ...lookups])
	assert.equal(peak, 1, "public requests must not fan out filesystem stats while a scan is active")
})

test("index: saturated public stat admission cannot discard reconciliation progress", async (t) => {
	const f = await fixture(t, { watchDebounceMs: 60000 })
	await f.write("a", "a")
	await f.start()
	const stat = f.safeFs.stat.bind(f.safeFs)
	let entered, release
	const started = new Promise((resolve) => { entered = resolve })
	const blocked = new Promise((resolve) => { release = resolve })
	f.safeFs.stat = async (path, options) => { if (path === "a") { entered(); await blocked }; return stat(path, options) }
	const lookups = Array.from({ length: 16 }, () => f.index.stat("a"))
	await started
	const result = f.index.refresh().then(() => null, (error) => error)
	release()
	await Promise.all(lookups)
	assert.equal(await result, null, "internal reconciliation must wait for admission rather than abort with429")
	assert.equal(f.index.info().state, "ready")
})

test("search: safe descriptor input, exclusions, literal options, and explicit local-live coverage", async (t) => {
	const f = await fixture(t)
	await f.write("sub/a.txt", "Needle first\nsecond needle\n")
	await f.write("sub/large.txt", "needle ".repeat(40))
	await f.write("sub/skip.bin", "needle")
	await f.write(".private/secret.txt", "needle")
	await fs.symlink("a.txt", path.join(f.root, "sub/link.txt"))
	const search = new FileSearch({ safeFs: f.safeFs, index: f.index, limits: { searchFileBytes: 100 } })
	const result = await search.search({ path: "sub", q: "needle", glob: "*.txt" })
	assert.deepEqual(result.results.map((match) => [match.path, match.line]), [["sub/a.txt", 1], ["sub/a.txt", 2]])
	assert.ok(result.exclusions.some((entry) => entry.reason === "file-bytes" && entry.path === "sub/large.txt"))
	assert.ok(result.exclusions.some((entry) => entry.reason === "symlink"))
	assert.equal(result.coverage.state, "partial")
	assert.equal(result.consistency, "local-live")
	assert.equal(result.nextCursor, null)
	assert.equal(result.filesContractVersion, 1)
	assert.ok(result.bytesSearched > 0)
	const deepGlob = await search.search({ path: "sub", q: "needle", glob: "**/*.txt" })
	assert.deepEqual(deepGlob.results.map((match) => match.path), ["sub/a.txt", "sub/a.txt"], "**/ also matches files directly in the selected folder")
	assert.ok(!f.calls.open.some((name) => name.startsWith(".private") || name === "sub/link.txt" || name === "sub/large.txt"))
	await assert.rejects(search.search({ path: "missing", q: "needle" }), { status: 404, error: "not_found" })
	await assert.rejects(search.search({ path: "sub/link.txt", q: "needle" }), { status: 400, error: "invalid_path", reason: "symlink" })
	await assert.rejects(search.search({ q: "needle", maxResults: -1 }), { status: 400, error: "invalid_budget" })
})

test("search: actual launcher preserves fd3 and sets kernel AS/data/CPU hard limits and metrics", async (t) => {
	const f = await fixture(t)
	await f.write("one", "needle")
	const rgBin = await f.nativeWorker(`
int main(int argc, char **argv) {
	struct rlimit as, data, cpu, core;
	char bytes[16] = {0};
	if (argc < 4 || strcmp(argv[argc - 1], "/proc/self/fd/3") || strcmp(argv[argc - 3], "--") || read(3, bytes, 6) != 6 || strcmp(bytes, "needle")) return 73;
	if (getrlimit(RLIMIT_AS, &as) || getrlimit(RLIMIT_DATA, &data) || getrlimit(RLIMIT_CPU, &cpu) || getrlimit(RLIMIT_CORE, &core)) return 74;
	printf("{\\"type\\":\\"match\\",\\"data\\":{\\"line_number\\":1,\\"lines\\":{\\"text\\":\\"as=%llu:%llu,data=%llu:%llu,cpu=%llu:%llu,core=%llu:%llu,fd3=%s\\"},\\"submatches\\":[{\\"start\\":0}]}}\\n",
		(unsigned long long)as.rlim_cur, (unsigned long long)as.rlim_max, (unsigned long long)data.rlim_cur, (unsigned long long)data.rlim_max,
		(unsigned long long)cpu.rlim_cur, (unsigned long long)cpu.rlim_max, (unsigned long long)core.rlim_cur, (unsigned long long)core.rlim_max, bytes);
	return 0;
}
	`)
	const search = new FileSearch({ safeFs: f.safeFs, index: f.index, rgBin })
	const result = await search.search({ q: "needle" })
	assert.equal(result.results[0].text, `as=${256 * MiB}:${256 * MiB},data=${128 * MiB}:${128 * MiB},cpu=3:3,core=0:0,fd3=needle`)
	assert.equal(result.limits.addressSpaceBytes, 256 * MiB)
	assert.equal(result.limits.dataBytes, 128 * MiB)
	assert.equal(result.limits.cpuSeconds, 3)
	assert.equal(result.metrics.workBytes, result.workBytes)
	assert.equal(result.metrics.outputBytes, result.outputBytes)
	assert.equal(result.metrics.filesScanned, 1)
	assert.equal(result.metrics.workersMemoryLimited, true)
	assert.ok(result.metrics.workerElapsedMs > 0)
	assert.equal(search.capabilities().memoryCapAvailable, true)
	const shorter = await search.search({ q: "needle", elapsedMs: 1000 })
	assert.match(shorter.results[0].text, /cpu=2:2/)
	assert.equal(shorter.limits.cpuSeconds, 2)
	assert.equal(search.capabilities().proof.cpuSeconds, 2)
})

test("search: kernel refuses allocation above memory caps; failure is actionable and capacity recovers", async (t) => {
	const f = await fixture(t)
	await f.write("one", "needle")
	const rgBin = await f.nativeWorker(`
int main(void) {
	volatile unsigned char *memory = malloc(512UL * 1024 * 1024);
	if (!memory) { fprintf(stderr, "worker memory allocation denied: %s\\n", strerror(errno)); raise(SIGABRT); return 75; }
	memory[0] = 1;
	free((void *)memory);
	puts("{\\"type\\":\\"summary\\",\\"data\\":{}}");
	return 0;
}
	`)
	const search = new FileSearch({ safeFs: f.safeFs, index: f.index, rgBin })
	await assert.rejects(search.search({ q: "needle" }), (error) => {
		assert.equal(error.status, 503)
		assert.equal(error.error, "search_unavailable")
		assert.match(error.message, /allocation|memory/i)
		assert.equal(error.worker.signal, "SIGABRT")
		assert.equal(error.limits.addressSpaceBytes, 256 * MiB)
		assert.equal(error.limits.dataBytes, 128 * MiB)
		assert.match(error.action, /limit|budget/i)
		return true
	})
	await assert.rejects(search.search({ q: "needle" }), { status: 503, error: "search_unavailable" })
	const raised = new FileSearch({ safeFs: f.safeFs, index: f.index, rgBin, limits: { searchWorkerBytes: 2 * 1024 * MiB } })
	assert.equal((await raised.search({ q: "needle" })).coverage.state, "complete", "operators can explicitly raise both proportional memory ceilings")
})

test("search: address-space cap also bounds nonresident mappings independently of data allocation", async (t) => {
	const f = await fixture(t)
	await f.write("one", "needle")
	const rgBin = await f.nativeWorker(`
int main(void) {
	size_t size = 512UL * 1024 * 1024;
	void *memory = mmap(NULL, size, PROT_NONE, MAP_PRIVATE | MAP_ANONYMOUS, -1, 0);
	if (memory == MAP_FAILED) { fprintf(stderr, "address-space mapping denied: %s\\n", strerror(errno)); raise(SIGABRT); return 76; }
	munmap(memory, size);
	puts("{\\"type\\":\\"summary\\",\\"data\\":{}}");
	return 0;
}
	`)
	const search = new FileSearch({ safeFs: f.safeFs, index: f.index, rgBin })
	await assert.rejects(search.search({ q: "needle" }), { status: 503, error: "search_unavailable" })
})

test("search: missing or unusable limit primitive never launches unlimited rg", async (t) => {
	const f = await fixture(t)
	await f.write("one", "needle")
	const search = new FileSearch({ safeFs: f.safeFs, index: f.index, limitBin: path.join(f.dir, "missing-prlimit") })
	await assert.rejects(search.search({ q: "needle" }), (error) => {
		assert.equal(error.status, 503)
		assert.equal(error.error, "search_unavailable")
		assert.equal(error.tool, "file-search.limits")
		assert.match(error.action, /util-linux|prlimit/i)
		return true
	})
	assert.equal(search.capabilities().memoryCapAvailable, false)
	const rejectedBin = await f.nativeWorker('int main(void) { fprintf(stderr, "prlimit: failed to set resource limit: Operation not permitted\\n"); return 1; }')
	const rejected = new FileSearch({ safeFs: f.safeFs, index: f.index, limitBin: rejectedBin })
	await assert.rejects(rejected.search({ q: "needle" }), { status: 503, error: "search_unavailable", tool: "file-search.limits" })
	assert.throws(() => new FileSearch({ safeFs: f.safeFs, index: f.index, limitBin: "./untrusted-prlimit" }), { status: 400, error: "invalid_path" })
})

test("search: actual limited rg discards a 26MiB JSON line without allocating it in the serving decoder", async (t) => {
	const f = await fixture(t)
	await f.write("giant", "needle " + "x".repeat(26 * MiB) + "\n")
	const search = new FileSearch({ safeFs: f.safeFs, index: f.index, limits: { searchFileBytes: 32 * MiB, readBytes: 32 * MiB } })
	const parse = JSON.parse
	let largest = 0
	JSON.parse = (value, ...args) => { largest = Math.max(largest, Buffer.byteLength(value)); return parse(value, ...args) }
	let result
	try { result = await search.search({ q: "needle" }) } finally { JSON.parse = parse }
	assert.ok(largest <= 64 * 1024)
	assert.equal(result.discardedEvents, 1)
	assert.equal(result.coverage.state, "partial")
	assert.equal(result.metrics.workersMemoryLimited, true)
	assert.equal(result.limits.addressSpaceBytes, 256 * MiB)
})

test("search: admit one worker, cancel promptly, and bound elapsed/results/response work", async (t) => {
	const f = await fixture(t)
	await f.write("file", "needle\n".repeat(10))
	const rgBin = await f.rg('setTimeout(() => {}, 10000)')
	const search = new FileSearch({ safeFs: f.safeFs, index: f.index, rgBin, limits: { ...NODE_WORKER_LIMITS, elapsedMs: 100 } })
	const active = search.search({ q: "needle" })
	await assert.rejects(search.search({ q: "needle" }), { status: 429, error: "capacity", retryAfter: 1 })
	const timed = await active
	assert.equal(timed.stopReason, "time-budget")
	assert.equal(timed.coverage.state, "partial")
	assert.equal(timed.bytesSearched, null, "a terminated worker cannot report zero bytes as an exact measured total")
	assert.ok(timed.elapsedMs < 1500)
	const controller = new AbortController()
	const cancelled = search.search({ q: "needle" }, { signal: controller.signal })
	await wait(15)
	controller.abort()
	await assert.rejects(cancelled, { name: "AbortError" })
	const real = new FileSearch({ safeFs: f.safeFs, index: f.index })
	const capped = await real.search({ q: "needle", maxResults: 2 })
	assert.equal(capped.results.length, 2)
	assert.equal(capped.stopReason, "result-limit")
	assert.equal(capped.coverage.state, "partial")
	const response = new FileSearch({ safeFs: f.safeFs, index: f.index, limits: { responseBytes: 350 } })
	const small = await response.search({ q: "needle" })
	assert.equal(small.stopReason, "response-budget")
	assert.ok(small.outputBytes <= 350)
})

test("search: discard giant JSON lines before parsing or allocating the whole event", async (t) => {
	const f = await fixture(t)
	await f.write("one", "needle")
	const rgBin = await f.rg(`
		const fs = require("node:fs")
		const args = process.argv.slice(2)
		if (args.at(-1) !== "/proc/self/fd/3" || args[args.length - 3] !== "--") process.exit(2)
		if (fs.readFileSync(3, "utf8") !== "needle") process.exit(2)
		process.stdout.write('{"type":"match","data":{"lines":{"text":"')
		for (let n = 0; n < 100; n++) process.stdout.write("x".repeat(8192))
		process.stdout.write('"}}}\\n')
		process.stdout.write(JSON.stringify({type:"match", data:{line_number:1, lines:{text:"needle\\n"}, submatches:[{start:0,end:6}]}}) + "\\n")
	`)
	const search = new FileSearch({ safeFs: f.safeFs, index: f.index, rgBin, limits: { ...NODE_WORKER_LIMITS, searchEventBytes: 512 } })
	const originalParse = JSON.parse
	let largestParse = 0
	JSON.parse = (value, ...args) => { largestParse = Math.max(largestParse, Buffer.byteLength(value)); return originalParse(value, ...args) }
	let result
	try { result = await search.search({ q: "needle" }) } finally { JSON.parse = originalParse }
	assert.ok(largestParse <= 512, `JSON.parse received ${largestParse} bytes`)
	assert.equal(result.results.length, 1)
	assert.equal(result.discardedEvents, 1)
	assert.equal(result.coverage.state, "partial")
	assert.ok(result.exclusions.some((entry) => entry.reason === "event-bytes"))
})

test("search: replaced scope and inode association fail rather than widening or rebinding", async (t) => {
	const f = await fixture(t)
	await f.write("scope/file", "needle")
	const rgBin = await f.rg(`setTimeout(() => { process.stdout.write(JSON.stringify({type:"match",data:{line_number:1,lines:{text:"needle\\n"},submatches:[{start:0}]}})+"\\n") }, 100)`)
	const search = new FileSearch({ safeFs: f.safeFs, index: f.index, rgBin, limits: NODE_WORKER_LIMITS })
	const running = search.search({ path: "scope", q: "needle" })
	await wait(30)
	await fs.rename(path.join(f.root, "scope"), path.join(f.root, "old-scope"))
	await f.write("scope/different", "replacement")
	await assert.rejects(running, { status: 409, error: "source_changed" })
	const next = search.search({ path: "scope/different", q: "replacement" })
	await wait(30)
	await f.write("scope/new", "new inode")
	await fs.rename(path.join(f.root, "scope/new"), path.join(f.root, "scope/different"))
	await assert.rejects(next, { status: 409, error: "source_changed" })
})

test("search: nested invalid regex and missing worker remain actionable failures", async (t) => {
	const f = await fixture(t)
	await f.write("nested/file", "needle")
	const search = new FileSearch({ safeFs: f.safeFs, index: f.index })
	await assert.rejects(search.search({ q: "[", regex: true }), { status: 400, error: "invalid_query" })
	const unavailable = new FileSearch({ safeFs: f.safeFs, index: f.index, rgBin: path.join(f.dir, "absent-rg") })
	await assert.rejects(unavailable.search({ q: "needle" }), { status: 503, error: "search_unavailable" })
})

test("search: denied file scope rejects; directory coverage reports actionable denied-file exclusions", async (t) => {
	const f = await fixture(t)
	await f.write("private", "needle")
	await f.write("public", "needle")
	const open = f.safeFs.open.bind(f.safeFs)
	f.safeFs.open = async (path) => {
		if (path === "private") throw Object.assign(new Error("permission denied"), { code: "EACCES" })
		return open(path)
	}
	const search = new FileSearch({ safeFs: f.safeFs, index: f.index })
	await assert.rejects(search.search({ path: "private", q: "needle" }), { status: 403, error: "permission_denied", access: "read" })
	const result = await search.search({ q: "needle" })
	assert.deepEqual(result.results.map((match) => match.path), ["public"])
	const denied = result.exclusions.find((entry) => entry.path === "private")
	assert.equal(denied.error.agent, "file-service")
	assert.equal(denied.error.tool, "file-search.file")
	assert.match(denied.error.action, /inspect|retry/i)
	assert.equal(result.coverage.state, "partial")
})

test("search: a queued descendant becoming denied preserves accessible results and partial coverage", async (t) => {
	const f = await fixture(t)
	await f.write("nested/private", "needle")
	await f.write("public", "needle")
	const stat = f.safeFs.stat.bind(f.safeFs)
	let checks = 0
	f.safeFs.stat = async (path, options) => {
		if (path === "nested" && ++checks === 2) throw Object.assign(new Error("descendant became unreadable"), { code: "EACCES" })
		return stat(path, options)
	}
	const search = new FileSearch({ safeFs: f.safeFs, index: f.index })
	const result = await search.search({ q: "needle" })
	assert.deepEqual(result.results.map((match) => match.path), ["public"])
	assert.equal(result.coverage.state, "partial")
	const denied = result.exclusions.find((entry) => entry.path === "nested")
	assert.equal(denied.error.error, "permission_denied")
	assert.equal(denied.error.tool, "file-search.stat")
	assert.match(denied.error.action, /inspect|retry/i)
})

test("search: sizes outside the integer domain are excluded without rounded byte counts", async (t) => {
	const f = await fixture(t)
	await f.write("giant", "needle")
	const stat = f.safeFs.stat.bind(f.safeFs)
	f.safeFs.stat = async (path, options) => {
		const result = await stat(path, options)
		if (path === "giant") result.size = 2n ** 54n
		return result
	}
	const search = new FileSearch({ safeFs: f.safeFs, index: f.index })
	const result = await search.search({ q: "needle" })
	assert.equal(result.exclusions[0].reason, "unsupported-size")
	assert.equal(result.exclusions[0].sizeBytes, undefined)
	assert.equal(result.coverage.state, "partial")
	assert.ok(!f.calls.open.includes("giant"))
})

test("search: jittered competing requests retain exactly one admission and reusable capacity", async (t) => {
	const f = await fixture(t)
	await f.write("one", "needle")
	const rgBin = await f.rg("setTimeout(() => {}, 10000)")
	const search = new FileSearch({ safeFs: f.safeFs, index: f.index, rgBin, limits: { ...NODE_WORKER_LIMITS, elapsedMs: 100 } })
	const attempts = await Promise.all(Array.from({ length: 32 }, async () => {
		await wait(Math.floor(Math.random() * 15))
		try { return { result: await search.search({ q: "needle" }) } } catch (error) { return { error } }
	}))
	assert.equal(attempts.filter((attempt) => attempt.result).length, 1)
	assert.ok(attempts.filter((attempt) => attempt.error).every((attempt) => attempt.error.status === 429 && attempt.error.error === "capacity"))
	assert.equal((await search.search({ q: "needle" })).stopReason, "time-budget")
})

test("search: pending matches and exclusion diagnostics share one output budget", async (t) => {
	const f = await fixture(t)
	await f.write("one", "needle")
	const rgBin = await f.rg(`
		process.stdout.write(JSON.stringify({type:"match",data:{line_number:1,lines:{text:"${"n".repeat(80)}"},submatches:[{start:0}]}})+"\\n")
		process.stdout.write("x".repeat(4096)+"\\n")
		process.stdout.write("x".repeat(4096)+"\\n")
	`)
	const search = new FileSearch({ safeFs: f.safeFs, index: f.index, rgBin, limits: { ...NODE_WORKER_LIMITS, searchEventBytes: 512, responseBytes: 440 } })
	const result = await search.search({ q: "needle" })
	assert.ok(result.outputBytes <= 440, `pending matches caused ${result.outputBytes} output bytes`)
	assert.equal(result.discardedEvents, 2)
	assert.equal(result.coverage.excludedFiles, 1, "two overlong events are one excluded file, not two files")
})

test("index/search: closure rejects new work and drains an interrupted worker", async (t) => {
	const f = await fixture(t)
	await f.write("one", "needle")
	await f.start()
	await f.index.close()
	await assert.rejects(f.index.list(), { status: 503, error: "storage_unavailable" })
	await assert.rejects(f.index.stat("one"), { status: 503, error: "storage_unavailable" })
	await assert.rejects(f.index.tree(), { status: 503, error: "storage_unavailable" })
	const rgBin = await f.rg("setTimeout(() => {}, 10000)")
	const search = new FileSearch({ safeFs: f.safeFs, index: f.index, rgBin, limits: NODE_WORKER_LIMITS })
	const active = search.search({ q: "needle" })
	await wait(25)
	await search.close()
	assert.equal((await active).stopReason, "aborted")
	await assert.rejects(search.search({ q: "needle" }), { status: 503, error: "search_unavailable" })
})

test("search: adversarial glob selection cannot block the serving thread budget", async (t) => {
	const moduleUrl = new URL("../lib/file-search.js", import.meta.url).href
	const worker = new Worker(`
		const { parentPort } = require("node:worker_threads")
		;(async () => {
			const { FileSearch } = await import(${JSON.stringify(moduleUrl)})
			const name = "a".repeat(49) + "x".repeat(20) + "b"
			const stat = (dir) => ({ dev:1n, ino:dir?1n:2n, mode:dir?16877n:33188n, size:3n, mtimeNs:1n, ctimeNs:1n,
				isDirectory:()=>dir, isFile:()=>!dir, isSymbolicLink:()=>false })
			const safeFs = { generation:0, policy:{visible:()=>true, assertRead(){}},
				stat:async(path)=>stat(path === ""), entries:async function*(){yield {name,type:"file"}},
				open:async()=>{throw new Error("The nonmatching glob opened a file")} }
			const search = new FileSearch({safeFs, limits:{elapsedMs:100}})
			const result = await search.search({q:"needle", glob:"*a".repeat(50)+"?b"})
			parentPort.postMessage({count:result.results.length, state:result.coverage.state, elapsedMs:result.elapsedMs})
		})().catch(error=>parentPort.postMessage({error:error.message}))
	`, { eval: true, execArgv: [], resourceLimits: { maxOldGenerationSizeMb: 64 } })
	t.after(() => worker.terminate())
	const result = await new Promise((resolve, reject) => {
		const timeout = setTimeout(() => { worker.terminate(); reject(new Error("Glob matching blocked the 100ms search budget for over 1500ms")) }, 1500)
		worker.once("message", (value) => { clearTimeout(timeout); resolve(value) })
		worker.once("error", (error) => { clearTimeout(timeout); reject(error) })
	})
	assert.equal(result.error, undefined)
	assert.equal(result.count, 0)
	assert.equal(result.state, "complete")
	assert.ok(result.elapsedMs < 100)
})
