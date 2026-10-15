/** Run inside the runtime image as root: daemon effects run as real UID 998. */
import assert from "node:assert/strict"
import crypto from "node:crypto"
import fs from "node:fs/promises"
import { spawn } from "node:child_process"
import { Readable } from "node:stream"
import test from "node:test"
import { WorkspaceClient } from "../lib/workspace-client.js"

test("container client: real UID 998 publication, collision, replay fence, digest, status and drain", { skip: process.env.FILES_CONTAINER_TEST !== "1", timeout: 30000 }, async t => {
	const base = `/workspace/client-${crypto.randomUUID()}`, root = `${base}/project`, state = `${base}/private`
	await fs.mkdir(base, { mode: 0o755 }); await fs.mkdir(root, { mode: 0o2775 })
	await fs.chown(root, 999, 999); await fs.chmod(root, 0o2775)
	await fs.mkdir(state, { mode: 0o700 }); await fs.chown(state, 998, 999)
	const secret = crypto.randomBytes(32).toString("hex")
	const child = spawn(process.execPath, ["test/workspace-client-worker.mjs"], { uid: 998, gid: 999, cwd: "/opt/geocluster-runtime", env: { PATH: "/usr/bin:/bin", TEST_WORKSPACE: root, TEST_STATE: state, TEST_SECRET: secret }, stdio: ["ignore", "pipe", "pipe", "ipc"] })
	let errors = ""; child.stderr.on("data", bytes => { errors += bytes })
	t.after(async () => { if (child.exitCode === null) { child.kill("SIGKILL"); await new Promise(resolve => child.once("close", resolve)) }; await fs.rm(base, { recursive: true, force: true }) })
	const port = await new Promise((resolve, reject) => { child.on("message", value => { if (value.port) resolve(value.port) }); child.once("exit", code => reject(new Error(`Daemon exited ${code}: ${errors}`))) })
	const client = new WorkspaceClient({ base: `http://127.0.0.1:${port}`, fetch: (url, options) => fetch(url, { ...options, headers: { ...options.headers, "x-gc-gate": secret } }) })
	const own = await client.info()
	assert.equal(own.captures.state, "available", JSON.stringify(own.captures))
	assert.deepEqual(await client.admission(own), { admission: "open" })
	const bytes = "private-host-source", intent = { ...own, operationId: "container-client", path: "nested/source.txt", mode: "create", processing: "skip", length: bytes.length, digest: crypto.createHash("sha256").update(bytes).digest("hex") }
	assert.equal((await client.upload(intent, Readable.from([bytes]))).code, 0)
	assert.equal((await fs.stat(`${root}/${intent.path}`)).uid, 998)
	assert.equal(await fs.readFile(`${root}/${intent.path}`, "utf8"), bytes)
	const collision = await client.upload({ ...intent, operationId: "collision" }, Readable.from([bytes]))
	assert.equal(collision.code, 1); assert.equal(collision.result.error, "exists")
	const duplicate = await client.upload(intent, Readable.from(["x".repeat(bytes.length)]))
	assert.equal(duplicate.code, 0); assert.equal(duplicate.result.currentSourcePublished, false)
	const stale = await client.upload({ ...intent, workspaceEpoch: "old-epoch" }, Readable.from([bytes]))
	assert.equal(stale.code, 1); assert.equal(stale.result.error, "workspace_changed")
	const bad = await client.upload({ ...intent, operationId: "bad", path: "bad.txt", digest: "b".repeat(64) }, Readable.from([bytes]))
	assert.equal(bad.code, 1); assert.equal(bad.result.error, "digest_mismatch")
	assert.equal((await client.status(intent)).code, 0)
	assert.equal((await client.status({ ...intent, operationId: "missing" })).code, 2)
	assert.equal(await fs.readFile(`${root}/${intent.path}`, "utf8"), bytes)
	const entries = await fs.readdir(root)
	const drain = await fetch(`http://127.0.0.1:${port}/internal/files/drain`, { method: "POST", headers: { "x-gc-files-control": secret, "content-type": "application/json" }, body: JSON.stringify({ admissionOnly: true, deadline: new Date(Date.now() + 5000).toISOString() }) })
	assert.equal(drain.status, 200)
	await assert.rejects(client.admission(own), error => error.receipt?.error === "draining")
	assert.deepEqual(await fs.readdir(root), entries, "closed admission check has no namespace effects")
})
