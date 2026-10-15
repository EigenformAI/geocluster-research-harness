import assert from "node:assert/strict"
import fs from "node:fs/promises"
import os from "node:os"
import path from "node:path"
import { spawnSync } from "node:child_process"
import { test } from "node:test"

const entrypoint = await fs.readFile(new URL("../../entrypoint.sh", import.meta.url), "utf8")
// The host may keep Node outside the image's trusted PATH. Use this test's
// interpreter while retaining the production helper's clean environment.
const definitions = entrypoint.replace(/launch_runtime "\$@"\s*$/, "").replace('node "$RUNTIME_CODE_DIR/local-workspace.mjs"', `${JSON.stringify(process.execPath)} "$RUNTIME_CODE_DIR/local-workspace.mjs"`)
const runtime = new URL("../", import.meta.url).pathname.replace(/\/$/, "")

test("invalid local configuration exits before startup and EXIT-trap writes even with NODE_OPTIONS injection", async (t) => {
	const root = await fs.mkdtemp(path.join(os.tmpdir(), "local-entrypoint-"))
	t.after(() => fs.rm(root, { recursive: true, force: true }))
	const script = definitions.replace('RUNTIME_CODE_DIR="/opt/geocluster-runtime"', `RUNTIME_CODE_DIR=${JSON.stringify(runtime)}`) + `
prepare_protected_parents() { touch ${JSON.stringify(`${root}/mutation`)}; exit 77; }
shutdown_handler() { touch ${JSON.stringify(`${root}/shutdown`)}; }
main
`
	for (const env of [{ LOCAL_WORKSPACE_HOST_UID: "0999" }, { LOCAL_WORKSPACE_HOST_UID: "20001", FLY_MACHINE_ID: "managed" }]) {
		const result = spawnSync("bash", ["-c", script], { env: { PATH: process.env.PATH, NODE_OPTIONS: "--require=/nonexistent/injection", ...env }, encoding: "utf8", timeout: 10000 })
		assert.equal(result.status, 1, result.stdout + result.stderr)
		assert.match(result.stderr, /invalid_host_uid|managed_local_workspace/)
		assert.doesNotMatch(result.stderr, /Cannot find module/)
		for (const name of ["mutation", "shutdown"]) await assert.rejects(fs.stat(`${root}/${name}`), { code: "ENOENT" })
	}
})

test("empty local setting keeps ordinary sharing and does not invoke ACL helpers", async () => {
	const script = definitions + `
trap - EXIT SIGTERM SIGINT SIGQUIT
env() { echo UNEXPECTED_HELPER >&2; return 91; }
find() { echo ORIGINAL_SHARING; }
fix_workspace_ownership
`
	const result = spawnSync("bash", ["-c", script], { env: { PATH: process.env.PATH, LOCAL_WORKSPACE_HOST_UID: "", FLY_MACHINE_ID: "managed" }, encoding: "utf8", timeout: 10000 })
	assert.equal(result.status, 0, result.stdout + result.stderr)
	assert.match(result.stdout, /ORIGINAL_SHARING/); assert.doesNotMatch(result.stderr, /UNEXPECTED_HELPER/)
})

test("ancestor ACL rejection precedes protected-parent repair and EXIT-trap writes", { skip: process.env.LOCAL_WORKSPACE_CONTAINER_TEST !== "1" }, async (t) => {
	const root = await fs.mkdtemp("/workspace/.runtime/file-service/local-entrypoint-").catch(async (error) => {
		if (error.code !== "ENOENT") throw error
		await fs.mkdir("/workspace/.runtime/file-service", { recursive: true })
		return fs.mkdtemp("/workspace/.runtime/file-service/local-entrypoint-")
	})
	t.after(() => fs.rm(root, { recursive: true, force: true }))
	const ancestor = `${root}/nested`, store = `${ancestor}/store`
	await fs.mkdir(store, { recursive: true })
	const setup = spawnSync("/usr/bin/setfacl", ["-m", "d:u:20001:r-x", "--", ancestor], { encoding: "utf8" })
	assert.equal(setup.status, 0, setup.stderr)
	const before = await fs.stat(ancestor, { bigint: true })
	const script = definitions.replace('RUNTIME_CODE_DIR="/opt/geocluster-runtime"', `RUNTIME_CODE_DIR=${JSON.stringify(runtime)}`) + `
prepare_protected_parents() { touch ${JSON.stringify(`${root}/mutation`)}; exit 77; }
shutdown_handler() { touch ${JSON.stringify(`${root}/shutdown`)}; }
main
`
	const result = spawnSync("bash", ["-c", script], { env: { PATH: process.env.PATH, LOCAL_WORKSPACE_HOST_UID: "20001", FILES_STATE_DIR: store }, encoding: "utf8", timeout: 10000 })
	assert.equal(result.status, 1, result.stdout + result.stderr)
	assert.match(result.stderr, /ancestor_acl/); assert.ok(result.stderr.includes(ancestor))
	assert.equal((await fs.stat(ancestor, { bigint: true })).ctimeNs, before.ctimeNs)
	for (const name of ["mutation", "shutdown"]) await assert.rejects(fs.stat(`${root}/${name}`), { code: "ENOENT" })
})
