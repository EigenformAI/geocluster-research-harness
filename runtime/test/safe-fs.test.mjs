import assert from "node:assert/strict"
import crypto from "node:crypto"
import fs from "node:fs/promises"
import net from "node:net"
import path from "node:path"
import { execFile } from "node:child_process"
import { promisify } from "node:util"
import { fileURLToPath } from "node:url"
import { setTimeout as wait } from "node:timers/promises"
import { Worker } from "node:worker_threads"
import { test } from "node:test"
import { SafePolicy, canonicalPath } from "../lib/safe-fs/policy.js"
import { SafeFs } from "../lib/safe-fs/index.js"

const run = promisify(execFile)
const directory = fileURLToPath(new URL("../lib/safe-fs/", import.meta.url))
const moduleUrl = new URL("../lib/safe-fs/index.js", import.meta.url).href
const staging = () => `.gc-file-${crypto.randomUUID()}`
const untrusted = { agentUids: [process.geteuid() === 20001 ? 20002 : 20001], workerUids: [process.geteuid() === 20003 ? 20004 : 20003] }
async function fixture(t, { secure = false, options = {} } = {}) {
	const base = await fs.mkdtemp(path.join(secure ? directory : "/tmp/opencode", secure ? ".gc-file-tests-" : "safe-fs-tests-"))
	await fs.chmod(base, 0o700)
	const root = path.join(base, "workspace"), outside = path.join(base, "outside")
	await fs.mkdir(root, { mode: 0o700 }); await fs.mkdir(outside, { mode: 0o700 })
	const safe = await SafeFs.open(root, options)
	t.after(async () => { await safe.close(); await fs.rm(base, { recursive: true, force: true }) })
	return { safe, base, root, outside }
}
async function text(handle) {
	const chunks = []
	for await (const chunk of handle.createReadStream({ start: 0, autoClose: false })) chunks.push(chunk)
	return Buffer.concat(chunks).toString("utf8")
}
async function collect(iterable) { const out = []; for await (const entry of iterable) out.push(entry); return out }
let helperPromise
function helper() {
	helperPromise ||= run(process.env.CC || "cc", ["-std=c11", "-O2", "-Wall", "-Wextra", "-Werror", path.join(directory, "syscall-denial.c"), "-o", path.join(directory, "build/syscall-denial")]).then(() => path.join(directory, "build/syscall-denial"))
	return helperPromise
}

test("policy rejects lexical escapes and every reserved component", () => {
	const policy = new SafePolicy()
	for (const name of ["/etc/passwd", "..", "a/../b", "a/./b", "a//b", "a/", "a\\b", "a\0b", "a\nb", "\ud800"]) assert.throws(() => canonicalPath(name), { code: "EINVAL" })
	assert.equal(canonicalPath(""), "")
	assert.equal(canonicalPath("岩石/🪨.txt"), "岩石/🪨.txt")
	for (const name of [".runtime", ".git", ".upload-tmp", ".datasets-staging", ".ide-state", ".clinerules", ".gc-file-anything"]) {
		assert.equal(policy.visible(`project/${name}/file`), false)
		assert.throws(() => policy.assertWrite(`project/${name}`), { code: "EACCES", reason: "reserved_component" })
	}
	assert.equal(policy.visible("project/.github/readme"), true)
})

test("policy protects a registered descendant from moving or deleting its parent", () => {
	const policy = new SafePolicy({ protectedRoots: ["project/datasets"], hiddenRoots: ["private/state"] })
	assert.equal(policy.assertRead("project/datasets/a.csv"), "project/datasets/a.csv")
	assert.throws(() => policy.assertWrite("project/datasets/a.csv"), { reason: "read_only_root" })
	assert.throws(() => policy.assertWrite("project", { subtree: true }), { reason: "protected_descendant" })
	assert.throws(() => policy.assertWrite("private", { subtree: true }), { reason: "protected_descendant" })
	assert.equal(policy.assertWrite("project/datasets-copy", { subtree: true }), "project/datasets-copy")
})

test("native descriptors provide bigint metadata, regular reads, writes, sync, streams and close", async (t) => {
	const { safe, root } = await fixture(t)
	const parent = await safe.parent("岩石.txt")
	assert.equal(parent.path, ""); assert.equal(parent.name, "岩石.txt")
	const stage = staging(), handle = await safe.create(parent.handle.fd, stage, 0o600)
	assert.ok(handle.fd >= 0)
	assert.equal((await handle.write(Buffer.from("abcdef"), 0, 6, 0)).bytesWritten, 6)
	await handle.sync()
	const stat = await handle.stat({ bigint: true })
	assert.equal(stat.size, 6n); assert.equal(typeof stat.ino, "bigint"); assert.equal(typeof stat.mtimeNs, "bigint"); assert.equal(stat.isFile(), true)
	assert.equal((await handle.stat()).size, 6)
	const buffer = Buffer.alloc(3)
	assert.equal((await handle.read(buffer, 0, 3, 1)).bytesRead, 3); assert.equal(buffer.toString(), "bcd")
	let ranged = ""
	for await (const chunk of handle.createReadStream({ start: 2, end: 4, autoClose: false, encoding: "utf8", highWaterMark: 2 })) ranged += chunk
	assert.equal(ranged, "cde")
	await handle.close(); await handle.close()
	assert.equal(handle.fd, -1)
	await assert.rejects(handle.read(buffer), { code: "EBADF" })
	await safe.rename(parent.handle, stage, parent.handle, parent.name)
	assert.equal(await fs.readFile(path.join(root, parent.name), "utf8"), "abcdef")
	assert.equal((await collect(safe.entries())).some((entry) => entry.name === parent.name && entry.type === "file"), true)
	assert.equal(await safe.prove(parent.name, stat, parent.parentIdentity), true)
	const reading = await safe.open(parent.name)
	assert.equal(await text(reading), "abcdef")
	await assert.rejects(reading.write(Buffer.from("no")), { code: "EBADF" })
	const metadata = await safe.open(parent.name, { metadata: true })
	await assert.rejects(metadata.read(buffer), { code: "EBADF" })
})

test("string writes with omitted or undefined positions use the current fd offset", async (t) => {
	const { safe } = await fixture(t)
	const parent = await safe.open("", { directory: true }), handle = await safe.create(parent, "sequential")
	await handle.write("abc"); await handle.write("def", undefined, "utf8")
	assert.equal(await text(handle), "abcdef")
})

test("bigint timestamps match Node metadata beyond signed nanosecond range", async (t) => {
	const { safe, root } = await fixture(t), filename = path.join(root, "future")
	await fs.writeFile(filename, "data")
	const future = new Date("2300-01-01T00:00:00Z")
	await fs.utimes(filename, future, future)
	const actual = await safe.stat("future"), expected = await fs.stat(filename, { bigint: true })
	assert.equal(actual.mtimeNs, expected.mtimeNs)
	assert.equal(actual.atimeNs, expected.atimeNs)
})

test("root pin rejects symlinks and remains anchored after root pathname replacement", async (t) => {
	const { safe, root, base, outside } = await fixture(t)
	await fs.writeFile(path.join(root, "file"), "original")
	await fs.writeFile(path.join(outside, "file"), "outside")
	const alias = path.join(base, "alias")
	await fs.symlink(root, alias)
	await assert.rejects(SafeFs.open(alias), (error) => ["ELOOP", "ENOTDIR"].includes(error.code))
	await assert.rejects(SafeFs.open(path.join(alias, "nested")), { code: "ELOOP" })
	await fs.rename(root, path.join(base, "old-root"))
	await fs.symlink(outside, root)
	const handle = await safe.open("file")
	assert.equal(await text(handle), "original")
	assert.equal(safe.root, root)
})

test("metadata permits only the final symlink; ancestors never follow links", async (t) => {
	const { safe, root, outside } = await fixture(t)
	await fs.writeFile(path.join(outside, "secret"), "outside bytes")
	await fs.symlink(path.join(outside, "secret"), path.join(root, "link"))
	await fs.symlink(outside, path.join(root, "ancestor"))
	await assert.rejects(safe.open("link"), { code: "ELOOP" })
	await assert.rejects(safe.stat("link"), { code: "ELOOP" })
	assert.equal((await safe.stat("link", { allowSymlink: true })).isSymbolicLink(), true)
	assert.equal((await (await safe.open("link", { metadata: true })).stat()).isSymbolicLink(), true)
	for (const op of [() => safe.open("ancestor/secret"), () => safe.stat("ancestor/secret", { allowSymlink: true }), () => safe.parent("ancestor/new")]) await assert.rejects(op(), { code: "ELOOP" })
})

test("special files are metadata-only and cannot block a regular-file read", { timeout: 10000 }, async (t) => {
	const { safe, root } = await fixture(t)
	await run("mkfifo", [path.join(root, "fifo")])
	const server = net.createServer()
	await new Promise((resolve, reject) => { server.once("error", reject); server.listen(path.join(root, "socket"), resolve) })
	t.after(() => new Promise((resolve) => server.close(resolve)))
	assert.equal((await safe.stat("fifo")).isFIFO(), true)
	assert.equal((await safe.stat("socket")).isSocket(), true)
	await assert.rejects(safe.open("fifo"), { code: "EOPNOTSUPP" })
	await assert.rejects(safe.open("socket"), { code: "EOPNOTSUPP" })
	const devices = await SafeFs.open("/dev")
	try { await assert.rejects(devices.open("null"), { code: "EOPNOTSUPP" }) } finally { await devices.close() }
})

test("entries hide reserved components and report invalid UTF-8 without rebinding names", async (t) => {
	const { safe, root } = await fixture(t)
	for (const name of [".git", ".runtime", ".upload-tmp", ".datasets-staging", ".ide-state", ".clinerules", staging(), "visible", "🪨"]) await fs.writeFile(path.join(root, name), "x")
	await fs.writeFile(Buffer.concat([Buffer.from(`${root}/`), Buffer.from([0xff])]), "bad utf8")
	await fs.writeFile(path.join(root, "line\nbreak"), "control")
	const entries = await collect(safe.entries())
	assert.deepEqual(entries.filter((entry) => entry.name !== null).map((entry) => entry.name).sort(), ["visible", "🪨"].sort())
	assert.equal(entries.filter((entry) => entry.name === null && entry.diagnostic.code === "EINVAL").length, 2)
	assert.ok(entries.filter((entry) => entry.name === null).every((entry) => entry.diagnostic.agent && entry.diagnostic.tool && entry.diagnostic.action))
})

test("entries preserve a leading UTF-8 BOM as part of the exact filesystem name", async (t) => {
	const { safe, root } = await fixture(t)
	await fs.writeFile(path.join(root, "blob"), "plain")
	await fs.writeFile(path.join(root, "\uFEFFblob"), "BOM")
	const entries = await collect(safe.entries())
	assert.deepEqual(entries.map((entry) => entry.name).sort(), ["blob", "\uFEFFblob"].sort())
	for (const entry of entries) assert.equal(await text(await safe.open(entry.name)), entry.name === "blob" ? "plain" : "BOM")
})

test("registration pins generations under the lock, reports collisions, and protects renamed roots", async (t) => {
	const { safe, root } = await fixture(t)
	await fs.mkdir(path.join(root, "project/datasets"), { recursive: true })
	await fs.writeFile(path.join(root, "project/datasets/input"), "data")
	const before = await safe.parent("project/datasets/new")
	assert.equal(safe.generation, 0)
	const registered = await safe.withLock(() => safe.policy.register({ path: "project/datasets", access: "read-only" }))
	assert.equal(registered.generation, 1); assert.ok(registered.identity); assert.ok(registered.parentIdentity)
	assert.equal(before.generation, 0)
	await assert.rejects(safe.create(before.handle, "new"), { code: "EACCES" })
	const parent = await safe.parent("project")
	await assert.rejects(safe.rename(parent.handle, "project", parent.handle, "moved"), { code: "EACCES", reason: "protected_descendant" })
	await assert.rejects(safe.unlink(parent.handle, "project", true), { code: "EACCES", reason: "protected_descendant" })
	for (const entry of [{ path: "project", access: "hidden" }, { path: "project/datasets/child", access: "read-only" }]) await assert.rejects(safe.policy.register(entry), { code: "EEXIST", reason: "policy_collision", conflictPath: "project/datasets" })
	await assert.rejects(safe.policy.register({ path: ".runtime", access: "hidden" }), { reason: "reserved_component" })
	await assert.rejects(safe.policy.register({ path: "absent/child", access: "hidden" }), { code: "ENOENT" })
	assert.equal(safe.generation, 1)
	await fs.rename(path.join(root, "project"), path.join(root, "alias"))
	const alias = await safe.parent("alias/datasets/new")
	await assert.rejects(safe.create(alias.handle, "new"), { code: "EACCES", reason: "read_only_root" })
	await safe.policy.register({ path: "alias/datasets", access: "hidden" })
	await assert.rejects(safe.open("alias/datasets/input"), { code: "EACCES" })
	await fs.rename(path.join(root, "alias"), path.join(root, "again"))
	await assert.rejects(safe.open("again/datasets/input"), { code: "EACCES", reason: "hidden_root" })
})

test("mutation scans reject nested reserved descendants even without explicit registration", async (t) => {
	const { safe, root } = await fixture(t)
	await fs.mkdir(path.join(root, "project/deep/.git"), { recursive: true })
	const parent = await safe.parent("project")
	await assert.rejects(safe.rename(parent.handle, "project", parent.handle, "moved"), { reason: "protected_descendant" })
	await assert.rejects(safe.unlink(parent.handle, "project", true), { reason: "protected_descendant" })
	await assert.rejects(safe.create(parent.handle, ".git"), { reason: "reserved_component" })
})

test("registration also protects regular-file roots and their hardlink aliases", async (t) => {
	const { safe, root } = await fixture(t)
	await fs.writeFile(path.join(root, "private-file"), "secret")
	await safe.policy.register({ path: "private-file", access: "hidden" })
	await fs.link(path.join(root, "private-file"), path.join(root, "alias"))
	await assert.rejects(safe.open("alias"), { reason: "hidden_root" })
	assert.deepEqual(await collect(safe.entries()), [])
})

test("registration rejects symlinks and special files without publishing policy or generation", async (t) => {
	const { safe, root } = await fixture(t)
	await fs.writeFile(path.join(root, "regular"), "data")
	await fs.symlink("regular", path.join(root, "link")); await run("mkfifo", [path.join(root, "fifo")])
	for (const name of ["link", "fifo"]) {
		await assert.rejects(safe.policy.register({ path: name, access: "hidden" }), { code: "EOPNOTSUPP", reason: "registration_type" })
		assert.equal(safe.policy.visible(name), true); assert.equal(safe.generation, 0)
		await assert.rejects(SafeFs.open(root, { hiddenRoots: [name] }), { code: "EOPNOTSUPP", reason: "registration_type" })
	}
})

test("withLock serializes parallel nested registration and mutations with jitter", { timeout: 20000 }, async (t) => {
	const { safe, root } = await fixture(t), parent = await safe.open("", { directory: true })
	for (let i = 0; i < 16; i++) {
		const source = `protected-${i}`, target = `moved-${i}`
		await fs.writeFile(path.join(root, source), "registered first")
		const [registered, result] = await safe.withLock(() => Promise.all([
			safe.withLock(async () => { await wait(10 + i % 3); return safe.policy.register({ path: source, access: "read-only" }) }),
			safe.rename(parent, source, parent, target).then(() => "moved", (error) => error.code),
		]))
		assert.equal(result, "EACCES", "a sibling mutation waits for the registration scope and then honors its policy")
		assert.ok(registered.identity)
		assert.equal(await text(await safe.open(source)), "registered first")
		await assert.rejects(safe.stat(target), { code: "ENOENT" })
	}
})

test("withLock retains exclusion for admitted children after a callback rejects", async (t) => {
	const { safe } = await fixture(t), events = []
	let release, started
	const gate = new Promise((resolve) => { release = resolve }), entered = new Promise((resolve) => { started = resolve })
	const outcome = safe.withLock(async () => {
		safe.withLock(async () => { events.push("child-start"); started(); await gate; events.push("child-end") }).catch(() => {})
		throw new Error("callback rejected")
	}).then(() => null, (error) => error)
	await entered
	const outside = safe.withLock(() => { events.push("outside") })
	await wait(5)
	const overlapped = events.includes("outside")
	release()
	assert.equal((await outcome).message, "callback rejected")
	await outside
	assert.equal(overlapped, false)
	assert.deepEqual(events, ["child-start", "child-end", "outside"])
})

for (const kind of ["file", "directory"]) test(`jittered hidden-${kind} replacements cannot bypass the policy at open`, { timeout: 20000 }, async (t) => {
	const { safe, root } = await fixture(t)
	if (kind === "directory") {
		await fs.mkdir(path.join(root, "private")); await fs.mkdir(path.join(root, "alias"))
		await fs.writeFile(path.join(root, "private/data"), "SECRET"); await fs.writeFile(path.join(root, "alias/data"), "public")
	} else { await fs.writeFile(path.join(root, "private"), "SECRET"); await fs.writeFile(path.join(root, "alias"), "public") }
	await safe.policy.register({ path: "private", access: "hidden" })
	const address = kind === "directory" ? "alias/data" : "alias"
	const initial = await safe.open(address)
	try { assert.equal(await text(initial), "public") } finally { await initial.close() }
	const observations = []
	const mutator = (async () => {
		for (let i = 0; i < 100; i++) {
			await fs.rename(path.join(root, "alias"), path.join(root, "temporary"))
			await fs.rename(path.join(root, "private"), path.join(root, "alias"))
			await fs.rename(path.join(root, "temporary"), path.join(root, "private")); await wait(i % 2)
			await fs.rename(path.join(root, "private"), path.join(root, "temporary"))
			await fs.rename(path.join(root, "alias"), path.join(root, "private"))
			await fs.rename(path.join(root, "temporary"), path.join(root, "alias")); await wait((i + 1) % 2)
		}
	})()
	const reader = (async () => {
		for (let i = 0; i < 200; i++) {
			let handle
			try { handle = await safe.open(address); observations.push(await text(handle)) }
			catch (error) { assert.ok(["EACCES", "ENOENT", "ESTALE", "EAGAIN", "EXDEV"].includes(error.code), error.stack) }
			finally { await handle?.close() }
			await wait(i % 2)
		}
	})()
	const results = await Promise.allSettled([mutator, reader])
	for (const result of results) if (result.status === "rejected") throw result.reason
	// A scheduler may make every racing proof stale. Stable positive reads reject
	// an implementation that handles hidden identities by denying all reads.
	const stable = await safe.open(address)
	try { assert.equal(await text(stable), "public") } finally { await stable.close() }
	assert.equal(observations.includes("SECRET"), false, "the returned handle must be the actual object inspected by policy")
})

test("hardlink replacement publishes a new inode without writing through the old alias", async (t) => {
	const { safe, root, outside } = await fixture(t)
	await fs.writeFile(path.join(outside, "original"), "old")
	await fs.link(path.join(outside, "original"), path.join(root, "published"))
	const old = await safe.stat("published"), parent = await safe.parent("published"), name = staging()
	assert.equal(old.nlink, 2n)
	const handle = await safe.create(parent.handle, name)
	await handle.write("new", 0); await handle.sync(); await handle.close()
	await safe.rename(parent.handle, name, parent.handle, "published", { noReplace: false })
	assert.equal(await fs.readFile(path.join(root, "published"), "utf8"), "new")
	assert.equal(await fs.readFile(path.join(outside, "original"), "utf8"), "old")
	assert.notEqual((await safe.stat("published")).ino, old.ino)
	assert.equal(await safe.prove("published", old, parent.parentIdentity), false)
})

test("jittered ancestor symlink swaps never return outside bytes", { timeout: 20000 }, async (t) => {
	const { safe, root, outside } = await fixture(t)
	await fs.mkdir(path.join(root, "branch")); await fs.writeFile(path.join(root, "branch/file"), "inside")
	await fs.writeFile(path.join(outside, "file"), "OUTSIDE")
	let swaps = 0, reads = 0
	const mutator = (async () => {
		for (let i = 0; i < 60; i++) {
			await fs.rename(path.join(root, "branch"), path.join(root, "parked"))
			await fs.symlink(outside, path.join(root, "branch")); await wait(i % 3)
			await fs.unlink(path.join(root, "branch")); await fs.rename(path.join(root, "parked"), path.join(root, "branch"))
			await wait((i + 1) % 3); swaps++
		}
	})()
	const reader = (async () => {
		for (let i = 0; i < 180; i++) {
			let handle
			try { handle = await safe.open("branch/file"); assert.equal(await text(handle), "inside"); reads++ }
			catch (error) { assert.ok(["ELOOP", "ENOENT", "EAGAIN", "EXDEV"].includes(error.code), error.stack) }
			finally { await handle?.close() }
			await wait(i % 3)
		}
	})()
	await Promise.all([mutator, reader]); assert.equal(swaps, 60); assert.ok(reads > 0)
})

test("held parents reject moved addresses; jittered mutations never touch replacement parents", { timeout: 20000 }, async (t) => {
	const { safe, root } = await fixture(t)
	await fs.mkdir(path.join(root, "branch")); await fs.writeFile(path.join(root, "branch/file"), "original")
	const parent = await safe.parent("branch/file"), observed = await safe.stat("branch/file")
	await fs.rename(path.join(root, "branch"), path.join(root, "parked")); await fs.mkdir(path.join(root, "branch"))
	await fs.writeFile(path.join(root, "branch/file"), "replacement")
	assert.equal(await safe.prove("branch/file", observed, parent.parentIdentity), false)
	await assert.rejects(safe.create(parent.handle, staging()), { code: "ESTALE", reason: "parent_moved" })
	await fs.rm(path.join(root, "branch"), { recursive: true }); await fs.rename(path.join(root, "parked"), path.join(root, "branch"))
	for (let i = 0; i < 24; i++) {
		const name = staging()
		const mover = (async () => {
			await wait(i % 3); await fs.rename(path.join(root, "branch"), path.join(root, "parked"))
			await fs.mkdir(path.join(root, "branch")); await fs.writeFile(path.join(root, "branch/file"), "decoy"); await wait((i + 1) % 3)
			assert.deepEqual(await fs.readdir(path.join(root, "branch")), ["file"])
			await fs.rm(path.join(root, "branch"), { recursive: true }); await fs.rename(path.join(root, "parked"), path.join(root, "branch"))
		})()
		const writer = (async () => {
			await wait((i + 2) % 3)
			try { const handle = await safe.create(parent.handle, name); await handle.write("anchored", 0); await handle.close() }
			catch (error) { assert.ok(["ESTALE", "ENOENT", "EAGAIN", "EXDEV"].includes(error.code), error.stack) }
		})()
		await Promise.all([mover, writer])
		try { assert.equal(await fs.readFile(path.join(root, "branch", name), "utf8"), "anchored"); await safe.unlink(parent.handle, name) } catch (error) { if (error.code !== "ENOENT") throw error }
	}
	assert.equal(await safe.prove("branch/file", observed, parent.parentIdentity), true)
})

test("jittered descriptor close and fd reuse cannot redirect in-flight reads", { timeout: 20000 }, async (t) => {
	const { safe, root } = await fixture(t)
	await fs.writeFile(path.join(root, "original"), "original")
	await fs.writeFile(path.join(root, "replacement"), "REPLACED")
	for (let i = 0; i < 96; i++) {
		const handle = await safe.open("original"), buffer = Buffer.alloc(8)
		const read = handle.read(buffer, 0, buffer.length, 0).then(({ bytesRead }) => { assert.equal(bytesRead, 8); assert.equal(buffer.toString(), "original") }, (error) => assert.equal(error.code, "EBADF"))
		const closing = (async () => { if (i % 3) await wait(i % 3); await handle.close() })()
		const replacement = (async () => { await wait((i + 1) % 3); const next = await safe.open("replacement"); assert.equal(await text(next), "REPLACED"); await next.close() })()
		await Promise.all([read, closing, replacement])
	}
})

test("pending I/O safely handles transfer and detachment of Buffer backing stores", async (t) => {
	const { root } = await fixture(t)
	await fs.writeFile(path.join(root, "original"), "original")
	const script = `
		import assert from 'node:assert/strict'; import fs from 'node:fs/promises'; import {SafeFs} from ${JSON.stringify(moduleUrl)};
		const safe=await SafeFs.open(${JSON.stringify(root)}); try {
		const handle=await safe.open('original'), buffer=Buffer.alloc(4096);
		const pending=handle.read(buffer,0,8,0);
		const transferred=structuredClone(buffer.buffer,{transfer:[buffer.buffer]});
		assert.equal(buffer.length,0); assert.equal(transferred.byteLength,4096);
		await assert.rejects(pending,{code:'EINVAL',reason:'detached_buffer'});
		const parent=await safe.open('',{directory:true}), target=await safe.create(parent,'written');
		const input=Buffer.alloc(4096,65), writing=target.write(input,0,input.length,0);
		const moved=structuredClone(input.buffer,{transfer:[input.buffer]}); new Uint8Array(moved).fill(90);
		assert.equal((await writing).bytesWritten,4096); await target.close();
		assert.equal((await fs.readFile(${JSON.stringify(path.join(root, "written"))})).equals(Buffer.alloc(4096,65)),true);
		console.log('detached read rejected; write snapshot preserved');
		} finally {await safe.close();}
	`
	const result = await run(process.execPath, ["--input-type=module", "-e", script], { timeout: 5000 })
	assert.match(result.stdout, /detached read rejected; write snapshot preserved/)
})

test("real renameat2 NOREPLACE races across independent worker event loops have exactly one winner", { timeout: 30000 }, async (t) => {
	const { safe, root } = await fixture(t)
	assert.equal((await safe.probe()).noReplace, true)
	for (let iteration = 0; iteration < 12; iteration++) {
		const a = `a-${iteration}`, b = `b-${iteration}`, target = `winner-${iteration}`
		await fs.writeFile(path.join(root, a), "A"); await fs.writeFile(path.join(root, b), "B")
		const workers = [a, b].map((source, index) => new Worker(`
			const {parentPort, workerData} = require('node:worker_threads');
			(async () => { const {SafeFs} = await import(workerData.moduleUrl); const safe = await SafeFs.open(workerData.root);
			const parent = await safe.open('', {directory:true}); parentPort.postMessage({ready:true});
			parentPort.once('message', async () => { let result; try { await new Promise(r=>setTimeout(r,workerData.jitter)); await safe.rename(parent,workerData.source,parent,workerData.target,{noReplace:true}); result='won'; } catch(e) { result=e.code; }
			await safe.close(); parentPort.postMessage({result}); }); })().catch(e=>{throw e});
		`, { eval: true, workerData: { moduleUrl, root, source, target, jitter: (iteration + index) % 3 } }))
		t.after(() => Promise.all(workers.map((worker) => worker.terminate())))
		const ready = workers.map((worker) => new Promise((resolve, reject) => { worker.once("message", resolve); worker.once("error", reject) }))
		await Promise.all(ready)
		const results = workers.map((worker) => new Promise((resolve, reject) => { worker.once("message", (value) => resolve(value.result)); worker.once("error", reject) }))
		workers.forEach((worker) => worker.postMessage("go"))
		assert.deepEqual((await Promise.all(results)).sort(), ["EEXIST", "won"])
		const winner = await fs.readFile(path.join(root, target), "utf8")
		assert.ok(["A", "B"].includes(winner))
		assert.equal(await fs.readFile(path.join(root, winner === "A" ? b : a), "utf8"), winner === "A" ? "B" : "A")
	}
})

test("probe tests this root, excludes staging, cleans up and reports actual reflink behavior", async (t) => {
	const { safe, root } = await fixture(t)
	const support = await safe.probe()
	assert.deepEqual(Object.keys(support).sort(), ["noReplace", "openat2", "reflink"])
	assert.equal(support.openat2, true); assert.equal(support.noReplace, true); assert.equal(typeof support.reflink, "boolean")
	assert.deepEqual(await fs.readdir(root), [])
	const parent = await safe.open("", { directory: true })
	const source = await safe.create(parent, "source"), target = await safe.create(parent, staging())
	await source.write("cloned", 0)
	assert.equal(await safe.clone(source.fd, target.fd), support.reflink)
	if (support.reflink) { await source.write("changed", 0); assert.equal(await text(target), "cloned") }
	else assert.equal((await target.stat({ bigint: true })).size, 0n)
	await assert.rejects(safe.clone(source, source), { code: "EINVAL" })
	const borrowedSource = await fs.open(path.join(root, "source"), "r"), borrowedTarget = await fs.open(path.join(root, "borrowed-target"), "wx+", 0o600)
	try { assert.equal(await safe.clone(borrowedSource.fd, borrowedTarget.fd), support.reflink) }
	finally { await borrowedSource.close(); await borrowedTarget.close() }
})

test("clone rejects nonfinite, fractional, negative and out-of-range borrowed fds", async (t) => {
	const { safe } = await fixture(t), parent = await safe.open("", { directory: true }), target = await safe.create(parent, "target")
	for (const fd of [NaN, Infinity, -Infinity, -1, 1.5, 2147483648]) await assert.rejects(async () => safe.clone(fd, target), { code: "EINVAL" })
	assert.equal((await target.stat({ bigint: true })).size, 0n)
})

test("probe cleanup preserves a detected replacement even when an earlier syscall failed", async (t) => {
	const { root } = await fixture(t)
	const preload = path.join(directory, "build/probe-cleanup-fault.so")
	await run(process.env.CC || "cc", ["-std=c11", "-O2", "-shared", "-fPIC", "-Wall", "-Wextra", "-Werror", path.join(directory, "probe-cleanup-fault.c"), "-o", preload])
	const script = `
		import assert from 'node:assert/strict'; import fs from 'node:fs/promises'; import {SafeFs} from ${JSON.stringify(moduleUrl)};
		const safe=await SafeFs.open(${JSON.stringify(root)}); try { await assert.rejects(safe.probe(), {code:'EIO'});
		const entries=await fs.readdir(safe.root); assert.equal(entries.length,2,'both the held probe directory and its replacement must survive');
		assert.equal(entries.filter(name=>name.endsWith('-moved')).length,1); assert.equal(entries.filter(name=>!name.endsWith('-moved')).length,1);
		console.log('replacement preserved'); } finally {await safe.close();}
	`
	const result = await run(process.execPath, ["--input-type=module", "-e", script], { timeout: 5000, env: { ...process.env, LD_PRELOAD: preload } })
	assert.match(result.stdout, /replacement preserved/)
})

test("ownership is unavailable with the service UID, unknown UIDs or privileged untrusted UIDs", async (t) => {
	const { safe, outside } = await fixture(t)
	assert.equal((await safe.checkOwnership(outside, { agentUids: [process.geteuid()], workerUids: untrusted.workerUids, testOverride: true })).reason, "same_uid")
	assert.equal((await safe.checkOwnership(outside, {})).reason, "uid_configuration")
	if (process.geteuid() !== 0) assert.equal((await safe.checkOwnership(outside, { agentUids: [0], workerUids: untrusted.workerUids })).reason, "untrusted_root_uid")
	assert.equal((await safe.checkOwnership(outside, untrusted)).reason, "writable_mode", "a private leaf beneath world-writable /tmp is still unsafe")
})

test("ownership rejects holes in either explicit UID list", async (t) => {
	const { safe, outside } = await fixture(t, { secure: true })
	for (const config of [{ ...untrusted, agentUids: new Array(1) }, { ...untrusted, workerUids: new Array(1) }, { ...untrusted, agentUids: [, 20010] }]) {
		const result = await safe.checkOwnership(outside, config)
		assert.equal(result.ok, false); assert.equal(result.reason, "uid_configuration")
	}
})

test("ownership rejects the moved pinned workspace and enclosing stores without changing policy", async (t) => {
	const { safe, root, base } = await fixture(t, { secure: true }), moved = path.join(base, "moved-workspace")
	await fs.writeFile(path.join(root, "visible"), "workspace", { mode: 0o600 })
	await fs.rename(root, moved)
	for (const store of [moved, base]) {
		const previousGeneration = safe.generation, result = await safe.checkOwnership(store, untrusted)
		assert.equal(result.ok, false); assert.equal(result.reason, "store_overlaps_workspace")
		assert.equal(safe.generation, previousGeneration)
		assert.equal(await text(await safe.open("visible")), "workspace")
	}
})

test("ownership pins secure store ancestors, bounds scans, checks modes/hardlinks and enables cross-store parents", async (t) => {
	const { safe, root, outside } = await fixture(t, { secure: true })
	await fs.mkdir(path.join(outside, "blobs"), { mode: 0o700 }); await fs.writeFile(path.join(outside, "blobs/blob"), "protected", { mode: 0o400 })
	const result = await safe.checkOwnership(outside, untrusted)
	assert.equal(result.ok, true, JSON.stringify(result)); assert.equal(result.scanned, 2); assert.ok(result.ancestors.includes("/")); assert.equal(result.handle.path, outside)
	const blobs = await safe.openAt(result.handle, "blobs", { directory: true })
	assert.equal(await text(await safe.openAt(blobs, "blob")), "protected")
	assert.equal((await safe.checkOwnership(outside, { ...untrusted, maxEntries: 1 })).reason, "scan_limit")
	await fs.chmod(path.join(outside, "blobs/blob"), 0o422)
	assert.equal((await safe.checkOwnership(outside, untrusted)).reason, "writable_mode")
	await fs.chmod(path.join(outside, "blobs/blob"), 0o400)
	await fs.link(path.join(outside, "blobs/blob"), path.join(root, "alias"))
	assert.equal((await safe.checkOwnership(outside, untrusted)).reason, "hardlink")
	await fs.unlink(path.join(root, "alias"))
	await fs.writeFile(path.join(root, "trash-me"), "trash")
	const parent = await safe.parent("trash-me")
	await safe.rename(parent.handle, parent.name, result.handle, "trashed")
	assert.equal(await text(await safe.openAt(result.handle, "trashed")), "trash")
	// A held store descriptor continues to refer to its approved directory.
	await fs.rename(outside, `${outside}-moved`); await fs.mkdir(outside, { mode: 0o700 })
	assert.equal(await text(await safe.openAt(blobs, "blob")), "protected")
	assert.deepEqual(await fs.readdir(outside), [])
})

test("ownership rejects extended access/default ACLs and symlinks using native xattrs", async (t) => {
	const { safe, outside } = await fixture(t, { secure: true })
	const executable = await helper()
	await fs.writeFile(path.join(outside, "blob"), "protected", { mode: 0o400 })
	await run(executable, ["acl", path.join(outside, "blob"), String(untrusted.agentUids[0])])
	assert.equal((await safe.checkOwnership(outside, untrusted)).reason, "extended_acl")
	await fs.unlink(path.join(outside, "blob"))
	await run(executable, ["default-acl", outside, String(untrusted.agentUids[0])])
	assert.equal((await safe.checkOwnership(outside, untrusted)).reason, "extended_acl")
	await fs.rmdir(outside); await fs.mkdir(outside, { mode: 0o700 })
	await fs.symlink("missing-blob", path.join(outside, "symlink"))
	assert.equal((await safe.checkOwnership(outside, untrusted)).reason, "object_type")
})

test("ownership inspects a BOM-prefixed symlink instead of its acceptable stripped-name neighbor", async (t) => {
	const { safe, outside } = await fixture(t, { secure: true })
	await fs.writeFile(path.join(outside, "blob"), "acceptable", { mode: 0o400 })
	await fs.symlink("missing", path.join(outside, "\uFEFFblob"))
	const result = await safe.checkOwnership(outside, untrusted)
	assert.equal(result.ok, false); assert.equal(result.reason, "object_type")
})

test("ownership auto-hides an in-workspace store and protects its parent", async (t) => {
	const { safe, root } = await fixture(t, { secure: true })
	await fs.mkdir(path.join(root, "project/store"), { recursive: true, mode: 0o700 })
	const check = await safe.checkOwnership(path.join(root, "project/store"), untrusted)
	assert.equal(check.ok, true, JSON.stringify(check)); assert.equal(safe.policy.visible("project/store"), false)
	const parent = await safe.parent("project")
	await assert.rejects(safe.rename(parent.handle, "project", parent.handle, "moved"), { reason: "protected_descendant" })
})

for (const kind of ["reserved", "hidden-parent"]) test(`ownership pins the hidden identity of a store beneath a ${kind} path`, async (t) => {
	const { safe, root } = await fixture(t, { secure: true })
	const parent = kind === "reserved" ? ".runtime" : "hidden-parent", store = path.join(root, parent, "store")
	await fs.mkdir(store, { recursive: true, mode: 0o700 }); await fs.writeFile(path.join(store, "blob"), "private", { mode: 0o400 })
	if (kind === "hidden-parent") await safe.policy.register({ path: parent, access: "hidden" })
	const previousGeneration = safe.generation, result = await safe.checkOwnership(store, untrusted)
	assert.equal(result.ok, true, JSON.stringify(result))
	await fs.rename(store, path.join(root, "visible-store"))
	await assert.rejects(safe.open("visible-store/blob"), { code: "EACCES", reason: "hidden_root" })
	assert.equal((await collect(safe.entries())).some((entry) => entry.name === "visible-store"), false)
	assert.equal(await text(await safe.openAt(result.handle, "blob")), "private")
	assert.ok(safe.generation > previousGeneration)
})

test("unsupported openat2, renameat2, reflink and ACL inspection fail closed with real syscall denial", { timeout: 20000 }, async (t) => {
	const { safe, root, outside } = await fixture(t, { secure: true })
	await fs.writeFile(path.join(root, "source"), "source"); await fs.writeFile(path.join(root, "target"), "preserved")
	const executable = await helper()
	for (const primitive of ["openat2", "renameat2", "ioctl", "acl-inspection"]) {
		const script = `
			import assert from 'node:assert/strict'; import {SafeFs} from ${JSON.stringify(moduleUrl)};
			const primitive=${JSON.stringify(primitive)}, root=${JSON.stringify(root)}, store=${JSON.stringify(outside)};
			if (primitive==='openat2') { await assert.rejects(SafeFs.open(root), {code:'ENOSYS'}); }
			else { const safe=await SafeFs.open(root); try {
			if (primitive==='renameat2') { const parent=await safe.open('',{directory:true}); await assert.rejects(safe.rename(parent,'source',parent,'target',{noReplace:true}),{code:'ENOSYS'}); assert.equal((await safe.probe()).noReplace,false); }
			if (primitive==='ioctl') { const parent=await safe.open('',{directory:true}); const source=await safe.open('source'); const target=await safe.create(parent,${JSON.stringify(staging())}); assert.equal(await safe.clone(source,target),false); assert.equal((await target.stat({bigint:true})).size,0n); assert.equal((await safe.probe()).reflink,false); }
			if (primitive==='acl-inspection') { const result=await safe.checkOwnership(store,${JSON.stringify(untrusted)}); assert.equal(result.ok,false); assert.equal(result.code,'ENOSYS'); }
			} finally { await safe.close(); } } console.log('fail-closed '+primitive);
		`
		const result = await run(executable, [primitive, process.execPath, "--input-type=module", "-e", script], { timeout: 6000 })
		assert.match(result.stdout, new RegExp(`fail-closed ${primitive}`))
	}
	assert.equal(await fs.readFile(path.join(root, "source"), "utf8"), "source")
	assert.equal(await fs.readFile(path.join(root, "target"), "utf8"), "preserved")
	assert.equal((await safe.probe()).openat2, true)
})

test("mkdir/unlink are descriptor-relative and cross-mount rename returns EXDEV", async (t) => {
	const { safe, root } = await fixture(t)
	const parent = await safe.parent("dir")
	await safe.mkdir(parent.handle.fd, parent.name)
	assert.equal((await safe.stat("dir")).isDirectory(), true)
	await safe.unlink(parent.handle, parent.name, true)
	await assert.rejects(safe.stat("dir"), { code: "ENOENT" })
	const filesystem = await SafeFs.open("/", { noXdev: false })
	try {
		const source = await filesystem.open(root.slice(1), { directory: true })
		const destination = await filesystem.open("dev/shm", { directory: true })
		if ((await source.stat({ bigint: true })).dev === (await destination.stat({ bigint: true })).dev) { t.diagnostic("cross-device check unavailable: workspace and /dev/shm have the same device"); return }
		await fs.writeFile(path.join(root, "cross-device"), "must stay")
		await assert.rejects(filesystem.rename(source, "cross-device", destination, `safe-fs-${crypto.randomUUID()}`), { code: "EXDEV" })
		const strict = await SafeFs.open("/", { noXdev: true })
		try { await assert.rejects(strict.open("dev/shm", { directory: true }), { code: "EXDEV" }) } finally { await strict.close() }
		assert.equal(await fs.readFile(path.join(root, "cross-device"), "utf8"), "must stay")
	} finally { await filesystem.close() }
})
