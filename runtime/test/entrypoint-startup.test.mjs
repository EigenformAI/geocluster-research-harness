import assert from "node:assert/strict"
import fs from "node:fs/promises"
import os from "node:os"
import path from "node:path"
import { spawnSync } from "node:child_process"
import { test } from "node:test"

async function earlyStartup(t, env, oomScore = 300) {
	const root = await fs.mkdtemp(path.join(os.tmpdir(), "entrypoint-startup-"))
	t.after(() => fs.rm(root, { recursive: true, force: true }))
	const entrypoint = await fs.readFile(new URL("../../entrypoint.sh", import.meta.url), "utf8")
	await fs.writeFile(path.join(root, "gate.cjs"), `
const fs = require("node:fs");
console.log("GATE_OOM=" + fs.readFileSync("/proc/self/oom_score_adj", "utf8").trim());
`)
	// Run the real main through gate startup. Replace root provisioning and later
	// services only; the sync selection, demo validation and gate fork stay real.
	// A positive score lets unprivileged Linux hosts exercise actual inheritance.
	const script = entrypoint.replace(/launch_runtime "\$@"\s*$/, "") + `
trap - EXIT SIGTERM SIGINT SIGQUIT
RUNTIME_CODE_DIR=${JSON.stringify(root)}
CORE_OOM_SCORE_ADJ=${oomScore}
prepare_protected_parents() { :; }
root_directory() { :; }
write_gate_key() { :; }
write_gate_secret() { :; }
write_files_input() { :; }
boot_step() { :; }
wait_for_tcp() { wait "$GATE_PID"; }
configure_machine_credentials() {
    echo "BOOT_CONFIG=$FILES_SYNC_ADAPTER,$SYNC_ENABLED"
    exit 0
}
main
`
	return spawnSync("bash", ["-c", script], { env: { PATH: process.env.PATH, HOME: root, ...env }, encoding: "utf8", timeout: 10000 })
}

const endpoints = {
	RUNTIME_FILES_URL: "http://backend.invalid/files",
	RUNTIME_FILE_WORK_URL: "http://backend.invalid/work",
	IDE_MACHINE_CREDENTIALS_URL: "http://backend.invalid/renew",
}

test("file daemon receives two-second processing poll defaults and explicit overrides", async () => {
	const entrypoint = await fs.readFile(new URL("../../entrypoint.sh", import.meta.url), "utf8")
	const command = entrypoint.match(/exec env -i "\$\{file_origin_env\[@\]\}"[\s\S]*?gosu gc-files node "\$RUNTIME_CODE_DIR\/files-server.js"/)[0]
	const inspect = command.replace('gosu gc-files node "$RUNTIME_CODE_DIR/files-server.js"', `${JSON.stringify(process.execPath)} -e 'console.log(JSON.stringify([Number(process.env.PREPROCESSING_POLL_RUNNING_MS),Number(process.env.PREPROCESSING_POLL_QUEUED_MS)]))'`)
	for (const [overrides, expected] of [[{}, [2000, 2000]], [{ PREPROCESSING_POLL_RUNNING_MS: "1300", PREPROCESSING_POLL_QUEUED_MS: "1700" }, [1300, 1700]]]) {
		const result = spawnSync("bash", ["-c", `file_origin_env=(); ${inspect}`], { env: { PATH: process.env.PATH, ...overrides }, encoding: "utf8", timeout: 10000 })
		assert.equal(result.status, 0, result.stdout + result.stderr)
		assert.deepEqual(JSON.parse(result.stdout), expected)
	}
})

test("owned demo starts with the automatically selected managed adapter and disables legacy sync", async (t) => {
	const result = await earlyStartup(t, { ...endpoints, OWNED_DEMO_ENABLED: "true", SYNC_ENABLED: "true" })
	assert.equal(result.status, 0, result.stdout + result.stderr)
	assert.match(result.stdout, /BOOT_CONFIG=true,false/)
})

test("owned demo accepts an explicit managed adapter and rejects unavailable managed sync", async (t) => {
	const configured = await earlyStartup(t, { ...endpoints, OWNED_DEMO_ENABLED: "true", FILES_SYNC_ADAPTER: "true" })
	assert.equal(configured.status, 0, configured.stdout + configured.stderr)
	assert.match(configured.stdout, /BOOT_CONFIG=true,false/)
	const unavailable = await earlyStartup(t, { OWNED_DEMO_ENABLED: "true" })
	assert.equal(unavailable.status, 1, unavailable.stdout + unavailable.stderr)
	assert.match(unavailable.stdout, /Owned demo startup requires FILES_SYNC_ADAPTER=true/)
})

test("the early access gate inherits the core OOM preference at fork", async (t) => {
	const initial = Number((await fs.readFile("/proc/self/oom_score_adj", "utf8")).trim())
	if (initial === 1000) return t.skip("Host already has the maximum OOM adjustment")
	const target = Math.min(1000, initial + 100)
	const result = await earlyStartup(t, {}, target)
	assert.equal(result.status, 0, result.stdout + result.stderr)
	assert.match(result.stdout, new RegExp(`GATE_OOM=${target}\\b`))
})
