import assert from "node:assert/strict"
import fs from "node:fs/promises"
import os from "node:os"
import path from "node:path"
import { spawn, spawnSync } from "node:child_process"
import { once } from "node:events"
import { test } from "node:test"

const entrypoint = await fs.readFile(new URL("../../entrypoint.sh", import.meta.url), "utf8")
// The host may keep Node outside the image's trusted PATH. Use this test's
// interpreter while retaining the production helper's clean environment.
const definitions = entrypoint.replace(/launch_runtime "\$@"\s*$/, "").replace('node "$RUNTIME_CODE_DIR/local-workspace.mjs"', `${JSON.stringify(process.execPath)} "$RUNTIME_CODE_DIR/local-workspace.mjs"`)
const runtime = new URL("../", import.meta.url).pathname.replace(/\/$/, "")
const configuredDefinitions = definitions.replace('RUNTIME_CODE_DIR="/opt/geocluster-runtime"', `RUNTIME_CODE_DIR=${JSON.stringify(runtime)}`)

async function nativeFixture(t) {
	await fs.mkdir("/tmp/opencode", { recursive: true })
	const root = await fs.mkdtemp("/tmp/opencode/local-native-entrypoint-")
	t.after(() => fs.rm(root, { recursive: true, force: true }))
	// Replace privileged effects, not the native dispatcher or setup being tested.
	const setup = `${configuredDefinitions}
WORKSPACE_DIR=${JSON.stringify(`${root}/project`)}
RUNTIME_STATE_ROOT=${JSON.stringify(`${root}/.runtime`)}
validate_launch() { RUNTIME_PROFILE=native; export RUNTIME_PROFILE; }
prepare_protected_parents() { echo parents; }
root_directory() { :; }
ensure_real_dir() { if [ "$1" = "$WORKSPACE_DIR" ]; then echo project; fi; }
chmod() { if [ "$2" = "$WORKSPACE_DIR" ]; then echo "chmod:$1"; fi; }
rm() { :; }
node() { echo native-prepare; exit 0; }
`
	return { root, setup }
}

function runNative(setup, env = {}, invocation = "launch_runtime --runtime-lock-held tui 9</dev/null") {
	return spawnSync("bash", ["-c", `${setup}\n${invocation}`], {
		env: { PATH: process.env.PATH, LOCAL_WORKSPACE_HOST_UID: "20001", ...env }, encoding: "utf8", timeout: 10000,
	})
}

test("native startup provisions sharing before native preparation and writers, without a preliminary chmod", async (t) => {
	const { setup } = await nativeFixture(t)
	const result = runNative(`${setup}\nrun_local_workspace() { echo "$1"; }`)
	assert.equal(result.status, 0, result.stdout + result.stderr)
	assert.deepEqual(result.stdout.trim().split("\n"), ["validate", "parents", "project", "provision", "native-prepare"])
})

test("native provisioning failure stops before native preparation, writers and shutdown writes", async (t) => {
	const { setup } = await nativeFixture(t)
	const result = runNative(`${setup}
run_local_workspace() { echo "$1"; if [ "$1" = provision ]; then echo scan_limit >&2; return 53; fi; }
native_shutdown() { echo shutdown; }
`)
	assert.equal(result.status, 53, result.stdout + result.stderr)
	assert.match(result.stderr, /scan_limit/)
	assert.doesNotMatch(result.stdout, /native-prepare|shutdown/)
})

test("native invalid sharing configuration is rejected before lifecycle metadata or startup writes", async (t) => {
	const { root, setup } = await nativeFixture(t)
	const script = `${setup}
exec() { touch ${JSON.stringify(`${root}/lifecycle-mutation`)}; exit 77; }
native_shutdown() { touch ${JSON.stringify(`${root}/shutdown`)}; }
`
	for (const env of [
		{ LOCAL_WORKSPACE_HOST_UID: "0999" },
		{ LOCAL_WORKSPACE_HOST_UID: "20001", FLY_MACHINE_ID: "managed" },
		{ LOCAL_WORKSPACE_HOST_UID: "20001", FILES_LIMITS: '{"subtreeEntries":0}' },
	]) {
		const result = runNative(script, { NODE_OPTIONS: "--require=/nonexistent/injection", ...env }, "launch_runtime tui")
		assert.equal(result.status, 1, result.stdout + result.stderr)
		assert.match(result.stderr, /invalid_host_uid|managed_local_workspace|invalid_scan_budget/)
		assert.doesNotMatch(result.stdout + result.stderr, /native-prepare|parents|Cannot find module/)
		for (const name of ["lifecycle-mutation", "shutdown"]) await assert.rejects(fs.stat(`${root}/${name}`), { code: "ENOENT" })
	}
})

test("native sharing is revalidated under ownership before protected-parent preparation", async (t) => {
	const { setup } = await nativeFixture(t)
	const result = runNative(`${setup}
run_local_workspace() { echo "$1"; if [ "$1" = validate ]; then echo ancestor_acl >&2; return 54; fi; }
`)
	assert.equal(result.status, 54, result.stdout + result.stderr)
	assert.equal(result.stdout.trim(), "validate")
	assert.match(result.stderr, /ancestor_acl/)
})

test("disabled native sharing retains root chmod without invoking either sharing repair path", async (t) => {
	const { setup } = await nativeFixture(t)
	const result = runNative(`${setup}
run_local_workspace() { echo unexpected-local-helper; return 91; }
fix_workspace_ownership() { echo unexpected-managed-repair; return 92; }
`, { LOCAL_WORKSPACE_HOST_UID: "" })
	assert.equal(result.status, 0, result.stdout + result.stderr)
	assert.deepEqual(result.stdout.trim().split("\n"), ["parents", "project", "chmod:2775", "native-prepare"])
})

test("competing native startups cannot provision or mutate project metadata under a live owner", { timeout: 15000 }, async (t) => {
	const { root, setup } = await nativeFixture(t)
	const project = `${root}/project`, helper = `${runtime}/lifecycle-lock.py`
	await fs.mkdir(project)
	const owner = spawn("python3", ["-I", helper, root, "native", "bash", "-c", "echo LOCKED; read -r release"], { stdio: ["pipe", "pipe", "pipe"] })
	t.after(() => owner.kill("SIGKILL"))
	let errors = ""
	owner.stderr.on("data", (chunk) => { errors += chunk })
	await Promise.race([once(owner.stdout, "data"), once(owner, "exit").then(() => { throw Error(errors) })])
	const before = await fs.stat(project, { bigint: true })
	const script = `${setup}
exec() { builtin exec python3 -I ${JSON.stringify(helper)} ${JSON.stringify(root)} native bash -c 'echo unexpected-lock-owner'; }
run_local_workspace() { if [ "$1" = provision ]; then command chmod 2775 "$WORKSPACE_DIR"; echo unexpected-provision; fi; }
launch_runtime tui
`
	await Promise.all(Array.from({ length: 8 }, async () => {
		await new Promise((resolve) => setTimeout(resolve, Math.floor(Math.random() * 30)))
		const child = spawn("bash", ["-c", script], { env: { PATH: process.env.PATH, LOCAL_WORKSPACE_HOST_UID: "20001" }, stdio: ["ignore", "pipe", "pipe"] })
		let stdout = "", stderr = ""
		child.stdout.on("data", (chunk) => { stdout += chunk }); child.stderr.on("data", (chunk) => { stderr += chunk })
		const [code] = await once(child, "close")
		assert.equal(code, 2, stdout + stderr)
		assert.match(stderr, /already owned by another runtime/)
		assert.doesNotMatch(stdout, /parents|project|provision|native-prepare|unexpected-lock-owner/)
	}))
	const after = await fs.stat(project, { bigint: true })
	assert.deepEqual([after.mode, after.ctimeNs], [before.mode, before.ctimeNs])
	const exited = once(owner, "exit")
	owner.stdin.end("release\n")
	assert.equal((await exited)[0], 0, errors)
})

test("native engine rejects workspace sharing and filesystem bootstrap controls", async () => {
	const { validateEngineNames } = await import("../native-engine-env.mjs")
	for (const name of ["LOCAL_WORKSPACE_HOST_UID", "LOCAL_WORKSPACE_SCAN_MS", "LOCAL_WORKSPACE_FUTURE_SETTING", "FILES_LIMITS", "FILES_STATE_DIR", "VOXEL_LIMITS"]) {
		assert.throws(() => validateEngineNames([name]), /reserved engine environment name/, name)
	}
	assert.deepEqual(validateEngineNames(["OPENROUTER_API_KEY"]), ["OPENROUTER_API_KEY"])
})

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

test("native protected-ancestor ACL rejection precedes lifecycle setup and under-lock parent repair", { skip: process.env.LOCAL_WORKSPACE_CONTAINER_TEST !== "1" }, async (t) => {
	const { root } = await nativeFixture(t)
	await fs.mkdir("/workspace", { recursive: true })
	const acl = () => spawnSync("/usr/bin/getfacl", ["-cpn", "--", "/workspace"], { encoding: "utf8" }).stdout
	const original = acl()
	t.after(() => {
		const restored = spawnSync("/usr/bin/setfacl", ["--restore=-"], { input: `# file: /workspace\n${original}`, encoding: "utf8" })
		assert.equal(restored.status, 0, restored.stderr)
	})
	const set = spawnSync("/usr/bin/setfacl", ["-m", "d:u:20001:r-x", "--", "/workspace"], { encoding: "utf8" })
	assert.equal(set.status, 0, set.stderr)
	const before = await fs.stat("/workspace", { bigint: true }), beforeAcl = acl()
	const script = `${configuredDefinitions}
validate_launch() { RUNTIME_PROFILE=native; export RUNTIME_PROFILE; }
exec() { touch ${JSON.stringify(`${root}/lifecycle-mutation`)}; exit 77; }
prepare_protected_parents() { touch ${JSON.stringify(`${root}/parent-mutation`)}; exit 78; }
`
	for (const invocation of ["launch_runtime tui", "launch_runtime --runtime-lock-held tui 9</dev/null"]) {
		const result = runNative(script, {}, invocation)
		assert.equal(result.status, 1, result.stdout + result.stderr)
		assert.match(result.stderr, /ancestor_acl/)
		assert.equal(acl(), beforeAcl)
		assert.equal((await fs.stat("/workspace", { bigint: true })).ctimeNs, before.ctimeNs)
		for (const name of ["lifecycle-mutation", "parent-mutation"]) await assert.rejects(fs.stat(`${root}/${name}`), { code: "ENOENT" })
	}
})

test("provisioned native restart preserves project ACLs, modes, ctime and observation tokens", { skip: process.env.LOCAL_WORKSPACE_CONTAINER_TEST !== "1", timeout: 30000 }, async (t) => {
	const { root } = await nativeFixture(t)
	const project = path.basename(root), workspace = `/workspace/${project}`, store = `/workspace/.runtime/file-service/${project}`
	await fs.mkdir(workspace, { recursive: true })
	await fs.chown(workspace, 999, 999)
	t.after(() => fs.rm(workspace, { recursive: true, force: true }))
	t.after(() => fs.rm(store, { recursive: true, force: true }))
	const script = `${configuredDefinitions}
validate_launch() { RUNTIME_PROFILE=native; export RUNTIME_PROFILE; }
node() { echo native-prepare; exit 0; }
launch_runtime --runtime-lock-held tui
`
	const boot = () => spawnSync("python3", ["-I", `${runtime}/lifecycle-lock.py`, "/workspace", "native", "bash", "-c", script], {
		env: { PATH: process.env.PATH, PROJECT_ID: project, LOCAL_WORKSPACE_HOST_UID: "20001" }, encoding: "utf8", timeout: 10000,
	})
	const result = boot()
	assert.equal(result.status, 0, result.stdout + result.stderr)
	const progress = (output) => JSON.parse(output.match(/^\[workspace\] (.+)$/m)?.[1] || "null")
	assert.ok(progress(result.stdout)?.changed > 0, result.stdout)
	for (const [uid, code] of [
		[20001, `process.umask(0o077); fs.mkdirSync(${JSON.stringify(`${workspace}/nested`)}); fs.writeFileSync(${JSON.stringify(`${workspace}/nested/host.csv`)}, 'host')`],
		[998, `fs.writeFileSync(${JSON.stringify(`${workspace}/published.csv`)}, 'published', {mode:0o600}); fs.chmodSync(${JSON.stringify(`${workspace}/published.csv`)},0o664)`],
	]) {
		const created = spawnSync(process.execPath, ["-e", `const fs=require('node:fs'); ${code}`], { uid, gid: uid === 998 ? 999 : uid, env: { PATH: process.env.PATH }, encoding: "utf8" })
		assert.equal(created.status, 0, created.stderr)
	}
	const { observationToken } = await import("../lib/file-contract.js")
	const watched = [workspace, `${workspace}/nested`, `${workspace}/nested/host.csv`, `${workspace}/published.csv`]
	const acl = (name) => {
		const value = spawnSync("/usr/bin/getfacl", ["-cpn", "--", name], { encoding: "utf8" })
		assert.equal(value.status, 0, value.stderr)
		return value.stdout
	}
	const snapshot = async () => Promise.all(watched.map(async (name) => {
		const stat = await fs.stat(name, { bigint: true })
		return { mode: stat.mode, uid: stat.uid, gid: stat.gid, ctime: stat.ctimeNs, token: observationToken(stat), acl: acl(name) }
	}))
	const privatePaths = ["/workspace", "/workspace/.runtime", "/workspace/.runtime/native/opencode", store]
	const privateSnapshot = async () => Promise.all(privatePaths.map(async (name) => {
		const stat = await fs.stat(name)
		return { mode: stat.mode, uid: stat.uid, gid: stat.gid, acl: acl(name) }
	}))
	const before = await snapshot(), beforePrivate = await privateSnapshot()
	assert.match(before[0].acl, /default:user:20001:rwx/)
	const restarted = boot()
	assert.equal(restarted.status, 0, restarted.stdout + restarted.stderr)
	assert.equal(progress(restarted.stdout)?.changed, 0, restarted.stdout)
	assert.deepEqual(await snapshot(), before)
	assert.deepEqual(await privateSnapshot(), beforePrivate)
})
