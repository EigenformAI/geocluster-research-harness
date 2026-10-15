/** Run as root in the native runtime image with LOCAL_WORKSPACE_CONTAINER_TEST=1. */
import assert from "node:assert/strict"
import fs from "node:fs/promises"
import path from "node:path"
import crypto from "node:crypto"
import { spawn, spawnSync } from "node:child_process"
import { test } from "node:test"
import { SafeFs } from "../lib/safe-fs/index.js"
import { observationToken } from "../lib/file-contract.js"

const enabled = process.env.LOCAL_WORKSPACE_CONTAINER_TEST === "1"
const options = { skip: !enabled, timeout: 30000 }
const hostUid = 20001
const pause = (ms) => new Promise((resolve) => setTimeout(resolve, ms))
const helper = () => import("../lib/local-workspace.js")
function command(tool, args) {
	const result = spawnSync(tool, args, { encoding: "utf8" })
	assert.equal(result.status, 0, result.stderr)
	return result.stdout
}
const acl = (name) => command("/usr/bin/getfacl", ["-cpn", "--", name])
async function fixture(t) {
	const base = `/workspace/local-acl-${crypto.randomUUID()}`, workspaceDir = `${base}/project`, storeDir = `${base}/private/nested/store`
	await fs.mkdir(workspaceDir, { recursive: true, mode: 0o755 })
	await fs.chmod(base, 0o755)
	await fs.mkdir(storeDir, { recursive: true, mode: 0o755 })
	await fs.chown(storeDir, 998, 999); await fs.chmod(storeDir, 0o700)
	t.after(() => fs.rm(base, { recursive: true, force: true }))
	return { base, workspaceDir, storeDir, hostUid, maxMs: 20000 }
}
async function as(uid, gid, code) {
	const child = spawn(process.execPath, ["-e", `if (process.getuid() !== ${uid}) throw Error('identity'); ${code}`], { uid, gid, env: { PATH: "/usr/bin:/bin" }, stdio: ["ignore", "pipe", "pipe"] })
	let errors = ""
	child.stderr.on("data", (part) => { errors += part })
	assert.equal(await new Promise((resolve, reject) => { child.once("error", reject); child.once("close", resolve) }), 0, errors)
}

test("local workspace validates canonical host UID, managed settings and literal identity maps before writes", options, async () => {
	const { validateLocalWorkspace } = await helper()
	let reads = 0
	const readFile = async () => { reads++; return "  0\t0 4294967295\n" }
	assert.equal(await validateLocalWorkspace({ FLY_MACHINE_ID: "managed" }, { readFile }), null)
	assert.equal(await validateLocalWorkspace({ LOCAL_WORKSPACE_HOST_UID: "" }, { readFile }), null)
	assert.equal(reads, 0)
	for (const uid of ["0", "01", "+1", " 1", "1\n", "20001\n", "1.0", "1e3", "4294967295", "996", "997", "998", "999"]) {
		await assert.rejects(validateLocalWorkspace({ LOCAL_WORKSPACE_HOST_UID: uid }, { readFile }), { error: "invalid_host_uid" })
	}
	for (const name of ["FLY_MACHINE_ID", "IDE_MACHINE_TOKEN", "IDE_MACHINE_TOKEN_FILE", "IDE_MACHINE_CREDENTIALS_URL", "IDE_MACHINE_CREDENTIALS_FILE", "RUNTIME_FILES_URL", "RUNTIME_FILE_WORK_URL", "FILES_SYNC_ADAPTER", "OWNED_DEMO_ENABLED"]) {
		await assert.rejects(validateLocalWorkspace({ LOCAL_WORKSPACE_HOST_UID: "20001", [name]: ["FILES_SYNC_ADAPTER", "OWNED_DEMO_ENABLED"].includes(name) ? "true" : "present" }, { readFile }), { error: "managed_local_workspace" })
	}
	for (const map of ["0 100000 65536", "0 0 4294967294", "0 0 4294967295\n1 1 1", "00 0 4294967295", ""]) {
		await assert.rejects(validateLocalWorkspace({ LOCAL_WORKSPACE_HOST_UID: "20001" }, { readFile: async () => map }), { error: "unsupported_uid_mapping" })
	}
	await assert.rejects(validateLocalWorkspace({ LOCAL_WORKSPACE_HOST_UID: "20001" }, { readFile: async () => { throw Error("unreadable") } }), { error: "unsupported_uid_mapping" })
	for (const uid of ["1", "20001", "4294967294"]) assert.equal((await validateLocalWorkspace({ LOCAL_WORKSPACE_HOST_UID: uid }, { readFile })).hostUid, Number(uid))
	assert.equal((await validateLocalWorkspace({ LOCAL_WORKSPACE_HOST_UID: "20001" })).hostUid, hostUid)
	const configured = await validateLocalWorkspace({ LOCAL_WORKSPACE_HOST_UID: "20001", FILES_LIMITS: '{"subtreeEntries":123}', LOCAL_WORKSPACE_SCAN_MS: "456" }, { readFile })
	assert.equal(configured.scanLimit, 123); assert.equal(configured.maxMs, 456)
})

test("local workspace preserves owners and file intent, shares real host/agent/service creations, and repeat setup is metadata-noop", options, async (t) => {
	const { provisionLocalWorkspace } = await helper(), f = await fixture(t)
	const files = [["root-other-x", 0, 0o601, 0o661, "rw-"], ["data", 20001, 0o640, 0o660, "rw-"], ["owner-x", 998, 0o740, 0o770, "rwx"], ["group-x", 999, 0o650, 0o670, "rw-"]]
	for (const [name, uid, mode] of files) { await fs.writeFile(`${f.workspaceDir}/${name}`, name); await fs.chown(`${f.workspaceDir}/${name}`, uid, 1234); await fs.chmod(`${f.workspaceDir}/${name}`, mode) }
	const first = await provisionLocalWorkspace(f)
	assert.ok(first.changed >= 5)
	assert.equal((await fs.stat(f.workspaceDir)).uid, 0)
	assert.equal((await fs.stat(f.workspaceDir)).mode & 0o7777, 0o2775)
	assert.match(acl(f.workspaceDir), /default:user:20001:rwx/)
	for (const [name, uid, , mode, host] of files) {
		const stat = await fs.stat(`${f.workspaceDir}/${name}`)
		assert.equal(stat.uid, uid); assert.equal(stat.gid, 999); assert.equal(stat.mode & 0o7777, mode)
		assert.match(acl(`${f.workspaceDir}/${name}`), new RegExp(`user:20001:${host}`))
	}
	await as(hostUid, hostUid, `const fs = require('node:fs'); process.umask(0o077); fs.mkdirSync(${JSON.stringify(`${f.workspaceDir}/inputs`)}); fs.writeFileSync(${JSON.stringify(`${f.workspaceDir}/inputs/host.csv`)}, 'host');`)
	for (const uid of [999, 998]) await as(uid, 999, `const fs = require('node:fs'); fs.appendFileSync(${JSON.stringify(`${f.workspaceDir}/inputs/host.csv`)}, '${uid}'); fs.writeFileSync(${JSON.stringify(`${f.workspaceDir}/inputs/output-${uid}`)}, 'output');`)
	await as(hostUid, hostUid, `const fs = require('node:fs'); for (const uid of [999,998]) { const p=${JSON.stringify(`${f.workspaceDir}/inputs/output-`)}+uid; fs.appendFileSync(p,'host'); fs.writeFileSync(p+'.tmp','replacement'); fs.renameSync(p+'.tmp',p); }`)
	// The daemon's private candidate remains inaccessible until publication chmod activates the mask.
	await as(998, 999, `const fs = require('node:fs'); fs.writeFileSync(${JSON.stringify(`${f.workspaceDir}/candidate`)}, 'private', { mode: 0o600 });`)
	const masked = spawnSync(process.execPath, ["-e", `require('node:fs').readFileSync(${JSON.stringify(`${f.workspaceDir}/candidate`)})`], { uid: hostUid, gid: hostUid })
	assert.notEqual(masked.status, 0)
	await as(998, 999, `require('node:fs').chmodSync(${JSON.stringify(`${f.workspaceDir}/candidate`)},0o664)`)
	await as(hostUid, hostUid, `require('node:fs').appendFileSync(${JSON.stringify(`${f.workspaceDir}/candidate`)}, 'shared')`)
	await provisionLocalWorkspace(f)
	// Directory defaults retain raw x entries on 0666 creations, but the mask
	// keeps them non-executable. Boot repair must not activate that masked x.
	for (const name of ["inputs/host.csv", "inputs/output-999", "inputs/output-998", "candidate"]) {
		assert.equal((await fs.stat(`${f.workspaceDir}/${name}`)).mode & 0o111, 0, `ordinary inherited file must stay non-executable: ${name}`)
	}
	const watched = [f.workspaceDir, ...files.map(([name]) => `${f.workspaceDir}/${name}`), `${f.workspaceDir}/inputs`, `${f.workspaceDir}/candidate`]
	const before = await Promise.all(watched.map((name) => fs.stat(name, { bigint: true })))
	await pause(15)
	assert.equal((await provisionLocalWorkspace(f)).changed, 0)
	const after = await Promise.all(watched.map((name) => fs.stat(name, { bigint: true })))
	assert.deepEqual(after.map((s) => s.ctimeNs), before.map((s) => s.ctimeNs))
})

test("first restart preserves inherited ACLs, ctime and observations for newly published and host-created files", options, async (t) => {
	const { provisionLocalWorkspace } = await helper(), f = await fixture(t)
	await provisionLocalWorkspace(f)
	const published = `${f.workspaceDir}/published.csv`, hostCreated = `${f.workspaceDir}/host.csv`
	await as(998, 999, `const fs = require('node:fs'); fs.writeFileSync(${JSON.stringify(published)}, 'published', { mode: 0o600 }); fs.chmodSync(${JSON.stringify(published)}, 0o664);`)
	await as(hostUid, hostUid, `const fs = require('node:fs'); process.umask(0o077); fs.writeFileSync(${JSON.stringify(hostCreated)}, 'host', { mode: 0o666 });`)
	const watched = [f.workspaceDir, published, hostCreated]
	const before = await Promise.all(watched.map((name) => fs.stat(name, { bigint: true })))
	const beforeAcl = watched.map(acl), beforeTokens = before.map(observationToken)
	for (const raw of beforeAcl.slice(1)) {
		assert.match(raw, /group::rwx\s+#effective:rw-/)
		assert.match(raw, /user:20001:rwx\s+#effective:rw-/)
		assert.match(raw, /mask::rw-/)
	}
	await pause(15)
	const restarted = await provisionLocalWorkspace(f)
	const after = await Promise.all(watched.map((name) => fs.stat(name, { bigint: true })))
	assert.deepEqual(after.map((stat) => stat.ctimeNs), before.map((stat) => stat.ctimeNs), "first restart must preserve creation/publication ctime")
	assert.deepEqual(after.map(observationToken), beforeTokens, "first restart must preserve creation/publication observation tokens")
	assert.deepEqual(watched.map(acl), beforeAcl)
	assert.equal(restarted.changed, 0)
	for (const stat of after.slice(1)) assert.equal(Number(stat.mode) & 0o111, 0)
})

test("inherited raw execute is removed when a shared execute mask would grant it to the wrong principal", options, async (t) => {
	const { provisionLocalWorkspace } = await helper(), f = await fixture(t)
	await provisionLocalWorkspace(f)
	const cases = [["owner-x", 0o740, 0o770, "rwx", "rw-"], ["group-x", 0o670, 0o670, "rw-", "rwx"]]
	for (const [name, mode] of cases) {
		const file = `${f.workspaceDir}/${name}`
		await as(998, 999, `const fs = require('node:fs'); fs.writeFileSync(${JSON.stringify(file)}, 'inherited', { mode: 0o600 }); fs.chmodSync(${JSON.stringify(file)}, ${mode});`)
		assert.match(acl(file), /user:20001:rwx/); assert.match(acl(file), /group::rwx/)
	}
	await provisionLocalWorkspace(f)
	for (const [name, , mode, host, group] of cases) {
		const file = `${f.workspaceDir}/${name}`, stat = await fs.stat(file)
		assert.equal(stat.uid, 998); assert.equal(stat.mode & 0o7777, mode)
		assert.match(acl(file), new RegExp(`user:20001:${host}(?:\\n|\\t)`))
		assert.match(acl(file), new RegExp(`group::${group}(?:\\n|\\t)`))
	}
	assert.equal((await provisionLocalWorkspace(f)).changed, 0)
})

test("local workspace prunes private, reserved, datasets, registered roots, hardlinks and special objects", options, async (t) => {
	const { provisionLocalWorkspace } = await helper(), f = await fixture(t)
	const dirs = ["private", "datasets", ".datasets-staging", "_orchestrator", "nested/_orchestrator", ".runtime/tui/client", ".git", "registered", "nested/registered"]
	for (const name of dirs) { await fs.mkdir(`${f.workspaceDir}/${name}`, { recursive: true }); await fs.writeFile(`${f.workspaceDir}/${name}/secret`, "secret"); await fs.chmod(`${f.workspaceDir}/${name}`, name === "private" ? 0o700 : 0o755) }
	await fs.writeFile(`${f.workspaceDir}/private-file`, "private", { mode: 0o600 })
	await fs.writeFile(`${f.workspaceDir}/not-shared`, "not selected", { mode: 0o604 }); await fs.chown(`${f.workspaceDir}/not-shared`, hostUid, hostUid)
	await fs.writeFile(`${f.base}/external`, "untouched"); await fs.chmod(`${f.base}/external`, 0o644)
	await fs.link(`${f.base}/external`, `${f.workspaceDir}/hardlink`)
	await fs.symlink(`${f.base}/external`, `${f.workspaceDir}/link`)
	command("/usr/bin/mkfifo", [`${f.workspaceDir}/fifo`])
	const protectedFile = `${f.storeDir}/capture`
	await fs.writeFile(protectedFile, "protected bytes", { mode: 0o600 }); await fs.chown(protectedFile, 998, 999)
	const watched = [...dirs.flatMap((d) => [`${f.workspaceDir}/${d}`, `${f.workspaceDir}/${d}/secret`]), `${f.workspaceDir}/private-file`, `${f.workspaceDir}/not-shared`, `${f.base}/external`, `${f.workspaceDir}/fifo`, f.storeDir, protectedFile]
	const before = await Promise.all(watched.map((name) => fs.stat(name, { bigint: true })))
	const safeFs = await SafeFs.open(f.workspaceDir, { protectedRoots: ["registered", "nested/registered"], noXdev: true })
	t.after(() => safeFs.close())
	const result = await provisionLocalWorkspace(f, { safeFs })
	assert.ok(result.skipped >= 5)
	const after = await Promise.all(watched.map((name) => fs.stat(name, { bigint: true })))
	assert.deepEqual(after.map((s) => [s.uid, s.gid, s.mode, s.ctimeNs]), before.map((s) => [s.uid, s.gid, s.mode, s.ctimeNs]))
	assert.doesNotMatch(acl(f.base), /user:20001/)
	assert.doesNotMatch(acl(f.storeDir), /user:20001/)
	await as(998, 999, `require('node:fs').readFileSync(${JSON.stringify(protectedFile)})`)
	for (const uid of [hostUid, 999]) await as(uid, uid === 999 ? 999 : hostUid, `require('node:assert/strict').throws(() => require('node:fs').readFileSync(${JSON.stringify(protectedFile)}), { code: 'EACCES' })`)
})

test("local workspace refuses access/default foreign principals before mutating that entry", options, async (t) => {
	const { provisionLocalWorkspace } = await helper(), f = await fixture(t)
	for (const entry of ["u:20002:r--", "g:20002:r--", "d:u:20002:r--", "d:g:20002:r--"]) {
		const target = `${f.workspaceDir}/conflict`
		await fs.mkdir(target); await fs.chown(target, 20001, 1234); await fs.chmod(target, 0o755)
		command("/usr/bin/setfacl", ["-m", entry, "--", target])
		const before = await fs.stat(target, { bigint: true }), original = acl(target)
		await assert.rejects(provisionLocalWorkspace(f), (error) => error.error === "conflicting_acl" && error.path === target)
		const after = await fs.stat(target, { bigint: true })
		assert.deepEqual([after.uid, after.gid, after.mode, after.ctimeNs], [before.uid, before.gid, before.mode, before.ctimeNs]); assert.equal(acl(target), original)
		await fs.rm(target, { recursive: true })
	}
})

test("local workspace inspects every nested store ancestor and never fixes offending ACLs", options, async (t) => {
	const { provisionLocalWorkspace } = await helper(), f = await fixture(t)
	for (const target of [f.base, `${f.base}/private`, `${f.base}/private/nested`, f.storeDir]) {
		command("/usr/bin/setfacl", ["-m", "u:20001:r-x", "--", target])
		const before = await fs.stat(f.workspaceDir, { bigint: true }), original = acl(target)
		await assert.rejects(provisionLocalWorkspace(f), (error) => error.error === "ancestor_acl" && error.path === target)
		assert.equal((await fs.stat(f.workspaceDir, { bigint: true })).ctimeNs, before.ctimeNs)
		assert.equal(acl(target), original)
		command("/usr/bin/setfacl", ["-b", "--", target])
	}
})

test("local workspace reports unprocessed scope on adjustable entry/depth/time budgets", options, async (t) => {
	const { provisionLocalWorkspace } = await helper(), f = await fixture(t)
	await fs.mkdir(`${f.workspaceDir}/nested/deep`, { recursive: true }); await fs.writeFile(`${f.workspaceDir}/nested/deep/file`, "data")
	for (const bounds of [{ scanLimit: 1 }, { maxDepth: 1 }, { maxMs: 1 }]) {
		await assert.rejects(provisionLocalWorkspace({ ...f, ...bounds }), (error) => error.error === "scan_limit" && error.path.startsWith(f.workspaceDir) && /adjust|increase/i.test(error.action))
	}
})

test("ACL tooling inherits the live directory/file descriptor despite jittered pathname replacement", options, async (t) => {
	const { descriptorAcl } = await helper(), f = await fixture(t)
	for (let i = 0; i < 20; i++) {
		const name = `race-${i}`, target = `${f.workspaceDir}/${name}`, retained = `${f.workspaceDir}/${name}-held`
		if (i % 2) await fs.mkdir(target); else await fs.writeFile(target, "held")
		const safeFs = await SafeFs.open(f.workspaceDir), handle = await safeFs.open(name, { directory: Boolean(i % 2) })
		try {
			const replacing = (async () => { await pause(Math.random() * 5); await fs.rename(target, retained); await fs.symlink(f.storeDir, target) })()
			await pause(Math.random() * 5)
			await descriptorAcl(handle, "setfacl", ["-m", "u:20001:rwx"])
			await replacing
			assert.match(acl(retained), /user:20001:rwx/)
			assert.doesNotMatch(acl(f.storeDir), /user:20001/)
		} finally { await handle.close(); await safeFs.close() }
	}
})

test("local workspace skips a nested Docker bind without touching its mount root or contents", { ...options, skip: !enabled || !process.env.LOCAL_WORKSPACE_MOUNT_FIXTURE }, async (t) => {
	const { provisionLocalWorkspace } = await helper()
	const base = process.env.LOCAL_WORKSPACE_MOUNT_FIXTURE, workspaceDir = `${base}/project`, storeDir = `${base}/private`
	await fs.mkdir(storeDir, { recursive: true })
	t.after(() => fs.rm(storeDir, { recursive: true, force: true }))
	const mount = `${workspaceDir}/foreign`, file = `${mount}/payload`
	await fs.writeFile(file, "foreign inode")
	t.after(() => fs.rm(file, { force: true }))
	const before = await Promise.all([mount, file].map((name) => fs.stat(name, { bigint: true })))
	const result = await provisionLocalWorkspace({ hostUid, workspaceDir, storeDir })
	assert.ok(result.skipped >= 1)
	const after = await Promise.all([mount, file].map((name) => fs.stat(name, { bigint: true })))
	assert.deepEqual(after.map((s) => [s.gid, s.mode, s.ctimeNs]), before.map((s) => [s.gid, s.mode, s.ctimeNs]))
	assert.doesNotMatch(acl(mount), /user:20001/)
})
