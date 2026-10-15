/** Real identities, retained-volume restarts, and process death. Run inside the Linux test image. */
import assert from "node:assert/strict"
import crypto from "node:crypto"
import fs from "node:fs/promises"
import { spawn } from "node:child_process"
import path from "node:path"
import { test } from "node:test"
const enabled = process.env.FILES_CONTAINER_TEST === "1"
const secret = crypto.randomBytes(32).toString("hex")
const options = { skip: !enabled }
const pause = (ms) => new Promise((resolve) => setTimeout(resolve, ms))
async function fixture(t) {
	const base = `/workspace/test-${crypto.randomUUID()}`, root = `${base}/project`, state = `${base}/private`
	await fs.mkdir(base, { mode: 0o755 }); await fs.mkdir(root, { mode: 0o2775 }); await fs.chown(root, 999, 999); await fs.chmod(root, 0o2775)
	await fs.mkdir(state, { mode: 0o700 }); await fs.chown(state, 998, 999)
	let child, stdout = ""
	t.after(async () => { if (child && child.exitCode === null) { child.kill("SIGKILL"); await new Promise((resolve) => child.once("close", resolve)) } await fs.rm(base, { recursive: true, force: true }) })
	async function start(crashStage) {
		stdout = ""
		child = spawn(process.execPath, ["test/files-process-worker.mjs"], { uid: 998, gid: 999, cwd: "/opt/geocluster-runtime", env: { PATH: "/usr/bin:/bin", TEST_WORKSPACE: root, TEST_STATE: state, TEST_SECRET: secret, TEST_CRASH_STAGE: crashStage || "" }, stdio: ["ignore", "pipe", "pipe", "ipc"] })
		child.stderr.on("data", (part) => { stdout += part.toString() })
		const port = await new Promise((resolve, reject) => {
			const timer = setTimeout(() => reject(new Error(`No daemon readiness: ${stdout}`)), 15000)
			child.on("message", (message) => { if (message.port) { clearTimeout(timer); resolve(message.port) } })
			child.once("exit", (code) => { clearTimeout(timer); reject(new Error(`Daemon exited ${code}: ${stdout}`)) })
		})
		return `http://127.0.0.1:${port}`
	}
	let baseUrl = await start()
	return { root, state, get child() { return child }, get logs() { return stdout }, request: (route, init = {}) => fetch(`${baseUrl}/files/${route}`, { ...init, headers: { "x-gc-gate": secret, ...init.headers } }), async restart(stage) { child.kill("SIGKILL"); await new Promise((resolve) => child.once("close", resolve)); baseUrl = await start(stage) } }
}
async function json(f, route, body, method = "POST") { const response = await f.request(route, { method, body: JSON.stringify(body), headers: { "content-type": "application/json" } }); return { status: response.status, body: await response.json() } }

async function command(executable, args, options = {}) {
	const child = spawn(executable, args, options)
	let stdout = "", stderr = ""
	child.stdout.on("data", (part) => { stdout += part }); child.stderr.on("data", (part) => { stderr += part })
	assert.equal(await new Promise((resolve, reject) => { child.once("error", reject); child.once("close", resolve) }), 0, stderr)
	return stdout
}
async function acl(filename, uid = 999) {
	await command("python3", ["-c", "import os,struct,sys; os.setxattr(sys.argv[1], 'system.posix_acl_access', struct.pack('<I',2)+b''.join(struct.pack('<HHI',*e) for e in [(1,6,0xffffffff),(2,6,int(sys.argv[2])),(4,0,0xffffffff),(16,0,0xffffffff),(32,0,0xffffffff)]))", filename, String(uid)])
}
async function permissionSnapshot(filename) {
	const stat = await fs.stat(filename)
	const attributes = await command("python3", ["-c", "import os,sys; print(sorted((k,os.getxattr(sys.argv[1],k).hex()) for k in os.listxattr(sys.argv[1])))", filename])
	return { uid: stat.uid, gid: stat.gid, mode: stat.mode & 0o7777, ino: stat.ino, attributes }
}
async function privateDirectory(f, name) {
	return JSON.parse(await command(process.execPath, ["--input-type=module", "-e", `
		import assert from 'node:assert/strict';
		import { SafeFs } from './lib/safe-fs/index.js';
		import { WorkspaceFiles } from './lib/workspace-files.js';
		const safeFs = await SafeFs.open(${JSON.stringify(f.root)});
		try {
			const checked = await safeFs.checkOwnership(${JSON.stringify(`${f.state}/sources`)}, {agentUids:[999],workerUids:[997]});
			assert.equal(checked.ok, true, JSON.stringify(checked));
			const storeHandle = checked.ancestorHandles.find(h => h.path === ${JSON.stringify(f.state)});
			const handles = safeFs.handles.size;
			try {
				const handle = await WorkspaceFiles.prototype.privateDirectory.call({safeFs,storeHandle}, ${JSON.stringify(name)});
				await handle.close(); console.log(JSON.stringify({ok:true}));
			} catch (error) {
				assert.equal(safeFs.handles.size, handles, 'rejected directories release their descriptor');
				console.log(JSON.stringify({ok:false,error:error.error,code:error.code,message:error.message}));
			}
		} finally { await safeFs.close(); }
	`], { uid: 998, gid: 999, cwd: "/opt/geocluster-runtime" }))
}

test("container: literal trash retains permissions through daemon delete/restart/restore", options, async (t) => {
	const f = await fixture(t), expected = new Map()
	for (const [name, uid, mode, withAcl] of [["shared", 999, 0o664, false], ["service", 998, 0o664, false], ["private", 999, 0o600, false], ["masked-acl", 999, 0o600, true], ["directory", 999, 0o2775, false]]) {
		const filename = `${f.root}/${name}`
		if (name === "directory") { await fs.mkdir(filename, { mode }); await fs.writeFile(`${filename}/nested`, "nested", { mode: 0o600 }); await fs.chown(`${filename}/nested`, 999, 999); await acl(`${filename}/nested`) }
		else await fs.writeFile(filename, name, { mode })
		await fs.chown(filename, uid, 999); await fs.chmod(filename, mode)
		if (withAcl) await acl(filename)
		expected.set(name, await permissionSnapshot(filename))
		if (name === "directory") expected.set("directory/nested", await permissionSnapshot(`${filename}/nested`))
		const stat = await (await f.request(`stat?path=${name}`)).json()
		const removed = await json(f, "entry", { operationId: `delete-${name}`, path: name, baseObservation: stat.observation.token, recursive: name === "directory" }, "DELETE")
		assert.equal(removed.status, 200, JSON.stringify(removed.body))
	}
	await f.restart()
	assert.equal((await (await f.request("info")).json()).captures.state, "available", f.logs)
	const recovery = await (await f.request("recovery")).json()
	assert.equal(recovery.items.length, 5)
	for (const record of recovery.items) {
		const name = record.original.path
		const restored = await json(f, `recovery/${encodeURIComponent(record.id)}/restore`, { operationId: `restore-${name}`, to: name })
		assert.equal(restored.status, 200, JSON.stringify(restored.body))
		assert.deepEqual(await permissionSnapshot(`${f.root}/${name}`), expected.get(name))
	}
	assert.deepEqual(await permissionSnapshot(`${f.root}/directory/nested`), expected.get("directory/nested"))
})

test("container: trash stays opaque and cannot authorize captured sources", options, async (t) => {
	const f = await fixture(t), trash = `${f.state}/trash`
	const uploaded = await f.request("upload?path=source.txt&operationId=source", { method: "PUT", body: "protected source" })
	assert.equal(uploaded.status, 201)
	const source = (await uploaded.json()).publishedSource
	await fs.symlink(`${f.state}/sources/blobs`, `${trash}/outward`)
	await command("mkfifo", [`${trash}/fifo`]); await command("mknod", [`${trash}/device`, "c", "1", "3"])
	await fs.writeFile(`${trash}/payload`, "workspace", { mode: 0o666 }); await fs.chown(`${trash}/payload`, 999, 999)
	await fs.link(`${trash}/payload`, `${trash}/alias`)
	await fs.symlink(`${trash}/payload`, `${f.root}/trash-source`)
	assert.notEqual((await f.request("raw?path=trash-source")).status, 200)
	const forbidden = await json(f, "captures", { requestId: "trash-source", path: "trash-source" })
	assert.ok(forbidden.status >= 400, JSON.stringify(forbidden.body))
	await f.restart()
	assert.equal((await (await f.request("info")).json()).captures.state, "available", f.logs)
	assert.equal(await (await f.request(`captures/${source.captureId}/raw`)).text(), "protected source")
	const blobs = await fs.readdir(`${f.state}/sources/blobs`)
	assert.ok(blobs.length > 0)
	await acl(`${f.state}/sources/blobs/${blobs[0]}`)
	await f.restart()
	assert.equal((await (await f.request("info")).json()).captures.state, "unavailable")
	assert.notEqual((await f.request(`captures/${source.captureId}/raw`)).status, 200)
	await command("python3", ["-c", "import os,sys; os.removexattr(sys.argv[1], 'system.posix_acl_access')", `${f.state}/sources/blobs/${blobs[0]}`])
	await f.restart()
	assert.equal((await (await f.request("info")).json()).captures.state, "available")
	await fs.link(`${f.state}/sources/blobs/${blobs[0]}`, `${trash}/protected-alias`)
	await f.restart()
	assert.equal((await (await f.request("info")).json()).captures.state, "unavailable")
	assert.notEqual((await f.request(`captures/${source.captureId}/raw`)).status, 200)
})

for (const name of ["trash", "staging"]) {
	test(`container: ${name} root masked access/default ACL prevents daemon initialization`, options, async (t) => {
		for (const kind of ["access", "default"]) await t.test(kind, async (t) => {
			const f = await fixture(t), directory = `${f.state}/${name}`
			if (kind === "access") await command("setfacl", ["-m", "u:999:rwx,m::---", directory])
			else await command("setfacl", ["-d", "-m", "u:999:rwx", directory])
			assert.equal((await fs.stat(directory)).mode & 0o7777, 0o700, "Unix mode alone still looks private")
			assert.equal((await privateDirectory(f, name)).ok, false)
			await assert.rejects(f.restart(), /unsafe ownership, permissions, or ACLs/)
		})
	})
	test(`container: ${name} root requires exact private mode and service owner`, options, async (t) => {
		const f = await fixture(t), directory = `${f.state}/${name}`
		assert.equal((await privateDirectory(f, name)).ok, true)
		for (const mode of [0o500, 0o1700, 0o750]) {
			await fs.chmod(directory, mode)
			assert.equal((await privateDirectory(f, name)).ok, false, `reject mode ${mode.toString(8)}`)
		}
		await fs.chmod(directory, 0o700); await fs.chown(directory, 999, 999)
		assert.equal((await privateDirectory(f, name)).ok, false)
		await fs.chown(directory, 998, 999)
		assert.equal((await privateDirectory(f, name)).ok, true)
	})
}

test("container: private directory ACL inspection fails closed when the syscall is unavailable", options, async (t) => {
	const f = await fixture(t), helper = `${path.dirname(f.root)}/syscall-denial`
	await command("cc", ["-std=c11", "-O2", "-Wall", "-Wextra", "-Werror", new URL("../lib/safe-fs/syscall-denial.c", import.meta.url).pathname, "-o", helper])
	await command(helper, ["acl-inspection", process.execPath, "--input-type=module", "-e", `
		import assert from 'node:assert/strict';
		import { SafeFs } from './lib/safe-fs/index.js';
		import { WorkspaceFiles } from './lib/workspace-files.js';
		const safeFs = await SafeFs.open(${JSON.stringify(f.state)});
		try {
			const handles = safeFs.handles.size;
			await assert.rejects(WorkspaceFiles.prototype.privateDirectory.call({safeFs,storeHandle:safeFs.rootHandle}, 'trash'), {code:'ENOSYS'});
			assert.equal(safeFs.handles.size, handles, 'ACL inspection failure releases the directory descriptor');
		} finally { await safeFs.close(); }
	`], { uid: 998, gid: 999, cwd: "/opt/geocluster-runtime" })
})

test("container: an agent-owned 0600 report temporary file leaves the recursive watcher ready", { ...options, timeout: 15000 }, async (t) => {
	const f = await fixture(t)
	const folder = "runs/a1/_reports", temporary = `${folder}/html2pdf626-1.pdf`, later = `${folder}/next.md`
	async function agent(script) {
		const child = spawn(process.execPath, ["-e", `process.umask(0o002); if (process.getuid() !== 999) throw new Error("wrong agent uid"); ${script}`], { uid: 999, gid: 999 })
		let errors = ""; child.stderr.on("data", (part) => { errors += part })
		assert.equal(await new Promise((resolve, reject) => { child.once("error", reject); child.once("exit", resolve) }), 0, errors)
	}
	async function found(name) {
		const deadline = Date.now() + 3000
		for (;;) {
			const response = await f.request(`find?path=${folder}&q=${name}`)
			if (response.status === 200 && (await response.json()).items.some((item) => item.path === `${folder}/${name}`)) return
			assert.ok(Date.now() < deadline, `recursive watcher must find ${name} before periodic reconciliation: ${f.logs}`)
			await pause(20)
		}
	}
	await agent(`const fs = require("node:fs"); fs.mkdirSync(${JSON.stringify(`${f.root}/${folder}`)}, { recursive: true, mode: 0o2775 }); fs.writeFileSync(${JSON.stringify(`${f.root}/${folder}/report.md`)}, "# Report");`)
	await found("report.md")
	const before = await (await f.request("info")).json()
	assert.equal(before.index.watcher.state, "ready")
	assert.ok(before.limits.scanIntervalMs >= 60000, "the prompt-discovery deadline must be shorter than periodic reconciliation")
	await agent(`require("node:fs").writeFileSync(${JSON.stringify(`${f.root}/${temporary}`)}, "%PDF-private", { mode: 0o600 });`)
	const privateStat = await fs.stat(`${f.root}/${temporary}`)
	assert.equal(privateStat.uid, 999); assert.equal(privateStat.gid, 999); assert.equal(privateStat.mode & 0o777, 0o600)
	const denied = await f.request(`raw?path=${temporary}`)
	assert.equal(denied.status, 403); assert.equal((await denied.json()).access, "read")
	await pause(200) // Let chokidar attempt to register the private temporary file before the later write.
	await agent(`require("node:fs").writeFileSync(${JSON.stringify(`${f.root}/${later}`)}, "# Next");`)
	await found("next.md")
	const after = await (await f.request("info")).json()
	assert.equal(after.index.watcher.state, "ready", JSON.stringify(after.index.watcher))
	assert.equal(after.index.watcher.error, undefined)
})

test("container: distinct service/agent/parser identities deliver protected previews and captured ranges", options, async (t) => {
	const f = await fixture(t)
	const info = await (await f.request("info")).json()
	assert.equal(info.captures.state, "available")
	assert.ok(["csv", "tsv", "text"].every((provider) => info.providers.includes(provider)), JSON.stringify(info.providers))
	const upload = await f.request("upload?path=table.csv&operationId=first", { method: "PUT", body: 'name,value\n"multi\nline",42\n' })
	assert.equal(upload.status, 201, f.logs)
	const receipt = await upload.json(), source = receipt.publishedSource
	assert.equal(receipt.persistence.state, "not-configured")
	const preview = await json(f, "preview", { path: "table.csv", format: "csv", rowLimit: 2 })
	assert.equal(preview.status, 200, JSON.stringify(preview.body)); assert.equal(preview.body.rows[1].cells[0].text, "multi\nline")
	assert.equal(preview.body.source.kind, "runtime-fragment")
	assert.equal(preview.body.source.completeSource, false)
	const before = await (await f.request(`captures/${source.captureId}/raw`, { headers: { range: "bytes=0-3", "if-match": source.etag } })).text()
	assert.equal(before, "name")
	const edit = spawn(process.execPath, ["-e", `require('fs').writeFileSync(${JSON.stringify(`${f.root}/table.csv`)}, 'edited bytes')`], { uid: 999, gid: 999 })
	assert.equal(await new Promise((resolve) => edit.once("exit", resolve)), 0)
	const captured = await (await f.request(`captures/${source.captureId}/raw`)).text()
	assert.equal(captured, 'name,value\n"multi\nline",42\n')
	await f.restart()
	const after = await (await f.request("info")).json(); assert.equal(after.workspaceId, info.workspaceId); assert.equal(after.workspaceEpoch, info.workspaceEpoch); assert.notEqual(after.bootId, info.bootId)
	assert.equal(await (await f.request(`captures/${source.captureId}/raw`)).text(), captured)
	const denied = spawn(process.execPath, ["-e", `try { require('fs').readdirSync(${JSON.stringify(`${f.state}/sources`)}); process.exit(1) } catch(e) { if(e.code!=='EACCES')process.exit(2) }`], { uid: 999, gid: 999 })
	assert.equal(await new Promise((resolve) => denied.once("exit", resolve)), 0)
	const privatePath = `${f.root}/private.txt`; await fs.writeFile(privatePath, "private", { mode: 0o600 }); await fs.chown(privatePath, 999, 999)
	const inaccessible = await f.request("raw?path=private.txt"); assert.equal(inaccessible.status, 403); assert.equal((await inaccessible.json()).access, "read")
})

test("container: every upload crash boundary recovers without blind replay", options, async (t) => {
	for (const stage of ["accepted", "staged", "publishing", "published", "receipt"]) {
		await t.test(stage, async (t) => {
			const f = await fixture(t); await f.restart(stage)
			const checkpoint = new Promise((resolve) => f.child.on("message", (message) => { if (message.checkpoint === stage) resolve() }))
			const request = f.request("upload?path=crash.txt&operationId=crash", { method: "PUT", body: "first" }).catch(() => null)
			await Promise.race([checkpoint, pause(15000).then(() => { throw new Error(`Missing ${stage}: ${f.logs}`) })])
			await f.restart(); await request
			const receipt = await (await f.request("operations/crash")).json()
			assert.equal(receipt.state, ["published", "receipt"].includes(stage) ? "committed" : stage === "publishing" ? "indeterminate" : "aborted-before-publication")
			const retry = await f.request("upload?path=crash.txt&operationId=crash", { method: "PUT", body: "other" })
			assert.equal(retry.status, stage === "publishing" ? 202 : 200)
			const file = await fs.readFile(`${f.root}/crash.txt`, "utf8").catch((error) => { if (error.code !== "ENOENT") throw error; return null })
			assert.equal(file, ["published", "receipt"].includes(stage) ? "first" : null)
		})
	}
})

test("container: moves and logical trash deletion retain receipts and survive hardlink aliases", options, async (t) => {
	const f = await fixture(t)
	assert.equal((await json(f, "mkdir", { operationId: "folder", path: "folder", parents: false })).status, 200)
	await f.request("upload?path=folder/a.txt&operationId=a", { method: "PUT", body: "a" })
	const stat = await (await f.request("stat?path=folder/a.txt")).json()
	assert.equal((await json(f, "move", { operationId: "move", from: "folder/a.txt", to: "a.txt", baseObservation: stat.observation.token, replace: false })).status, 200)
	await fs.link(`${f.root}/a.txt`, `${f.root}/alias.txt`)
	const base = (await (await f.request("stat?path=a.txt")).json()).observation.token
	assert.equal((await json(f, "entry", { operationId: "remove", path: "a.txt", baseObservation: base, recursive: false }, "DELETE")).status, 200)
	assert.equal(await fs.readFile(`${f.root}/alias.txt`, "utf8"), "a")
	await f.restart(); assert.equal((await (await f.request("info")).json()).captures.state, "available")
	assert.equal((await (await f.request("operations/remove")).json()).state, "committed")
})

test("container: mkdir crash recovery proves a finished leaf but does not finish an interrupted parent chain", options, async (t) => {
	for (const parents of [false, true]) await t.test(parents ? "partial parent chain" : "finished leaf", async (t) => {
		const f = await fixture(t); await f.restart("published")
		const checkpoint = new Promise((resolve) => f.child.on("message", (message) => { if (message.checkpoint === "published") resolve() }))
		const request = json(f, "mkdir", { operationId: "crash", path: parents ? "one/two" : "one", parents }).catch(() => null)
		await Promise.race([checkpoint, pause(15000).then(() => { throw new Error(`Missing mkdir checkpoint: ${f.logs}`) })])
		await f.restart(); await request
		assert.equal((await (await f.request("operations/crash")).json()).state, parents ? "indeterminate" : "committed")
		assert.equal((await fs.stat(`${f.root}/one`)).isDirectory(), true)
		if (parents) await assert.rejects(fs.stat(`${f.root}/one/two`), { code: "ENOENT" })
	})
})
