import assert from "node:assert/strict"
import fs from "node:fs/promises"
import http from "node:http"
import os from "node:os"
import path from "node:path"
import { spawn } from "node:child_process"
import { test } from "node:test"
import { Health } from "../lib/health.js"

const grant = { slug: "reference", version: "1", bucket: "private", prefix: "reference/", endpoint_url: "https://storage.invalid", size_bytes: 0, file_count: 1, expires_at: "2099-01-01T00:00:00Z", credentials: { access_key_id: "test", secret_access_key: "test", session_token: "test" } }
const oldStatus = { state: "ready", updatedAt: "2026-10-13T00:00:00Z", datasets: [] }
const oldMarkdown = "# Private datasets\n\nDatasets granted to this workspace are copied into `datasets/<slug>/` at boot.\n"

async function boot(t, { datasets = [], code = 200, token = true, copyFails = false, seed } = {}) {
	const root = await fs.mkdtemp(path.join(os.tmpdir(), "dataset-boot-"))
	t.after(() => fs.rm(root, { recursive: true, force: true }))
	const workspace = path.join(root, "project"), gatewayStateDir = path.join(root, "state/gateway")
	await fs.mkdir(workspace)
	await seed?.({ root, workspace, gatewayStateDir })
	const server = http.createServer((req, res) => {
		assert.equal(req.headers.authorization, "Bearer test-dataset")
		res.writeHead(code, { "content-type": "application/json" })
		res.end(JSON.stringify({ datasets }))
	})
	await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve))
	t.after(() => { server.closeAllConnections(); server.close() })
	const entrypoint = (await fs.readFile(new URL("../../entrypoint.sh", import.meta.url), "utf8"))
		.replace('WORKSPACE_DIR="/workspace/${PROJECT_ID}"', `WORKSPACE_DIR=${JSON.stringify(workspace)}`)
		.replace('RUNTIME_STATE_ROOT="/workspace/.runtime"', `RUNTIME_STATE_ROOT=${JSON.stringify(path.join(root, "state"))}`)
		.replace(/launch_runtime "\$@"\s*$/, "")
	// Keep real boot/status/hydration functions. Replace privilege changes and R2
	// transfer only; the manifest fetch uses an actual local HTTP endpoint.
	const script = entrypoint + `
trap - EXIT SIGTERM SIGINT SIGQUIT
LOG_DIR=${JSON.stringify(path.join(root, "logs"))}
ROOT_LOG_DIR="$LOG_DIR"
DATASETS_LOG="$LOG_DIR/datasets.log"
DATASETS_STATE_DIR=${JSON.stringify(path.join(root, "run/datasets-status"))}
DATASETS_MANIFEST=${JSON.stringify(path.join(root, "manifest.json"))}
DATASETS_CONF=${JSON.stringify(path.join(root, "rclone.conf"))}
run_as_geocluster() { "$@"; }
chown() { :; }
sleep() { :; }
rclone() {
    printf 'transfer\n' >> ${JSON.stringify(path.join(root, "transfers"))}
    [ ${copyFails ? "true" : "false"} = false ] || return 1
    [ ! -e "$DATASETS_DIR" ] || [ -f "$DATASETS_DIR/reference/.dataset.json" ] || return 1
    mkdir -p "$3"
    printf 'value\n42\n' > "$3/sample.csv"
}
prepare_runtime_state
start_dataset_hydrator
[ -z "$DATASETS_PID" ] || wait "$DATASETS_PID"
wait
`
	const result = await new Promise((resolve, reject) => {
		const child = spawn("bash", [], { timeout: 15000, env: { PATH: process.env.PATH, HOME: root, IDE_DATASET_TOKEN: token ? "test-dataset" : "", IDE_DATASETS_URL: `http://127.0.0.1:${server.address().port}/datasets` } })
		let stdout = "", stderr = ""
		child.stdout.on("data", (data) => { stdout += data }); child.stderr.on("data", (data) => { stderr += data })
		child.on("error", reject); child.on("close", (code) => resolve({ code, stdout, stderr }))
		child.stdin.end(script)
	})
	assert.equal(result.code, 0, `${result.stdout}\n${result.stderr}`)
	const health = new Health({ workspaceDir: workspace, gatewayStateDir }, { mcp: { state: "unavailable" }, status: () => ({ engine: { state: "ready" }, mcp: { state: "unavailable" } }) })
	return { root, workspace, gatewayStateDir, health, status: JSON.parse(await fs.readFile(path.join(gatewayStateDir, "datasets/status.json"), "utf8")) }
}

for (const [name, options] of [["empty grants", {}], ["rejected token", { code: 403 }], ["backend unavailable", { code: 503 }], ["missing token", { token: false }]]) {
	test(`${name}: boot keeps bookkeeping private and leaves the project empty`, async (t) => {
		const b = await boot(t, options)
		assert.deepEqual(await fs.readdir(b.workspace), [])
		assert.equal(b.status.state, "idle")
		assert.deepEqual(b.status.datasets, [])
		const ready = await b.health.ready()
		assert.equal(ready.ready, true)
		assert.deepEqual(ready.components.datasets, b.status)
	})
}

test("completed grant publishes data only, exposes private progress, and reuses the version on restart", async (t) => {
	const b = await boot(t, { datasets: [grant] })
	assert.deepEqual(await fs.readdir(path.join(b.workspace, "datasets")), ["reference"])
	assert.equal(await fs.readFile(path.join(b.workspace, "datasets/reference/sample.csv"), "utf8"), "value\n42\n")
	assert.equal(b.status.state, "ready")
	assert.equal(b.status.datasets[0].slug, "reference")
	assert.match(await fs.readFile(path.join(b.gatewayStateDir, "datasets/STATUS.md"), "utf8"), /ready — version 1/)
	assert.equal((await b.health.ready()).components.datasets.state, "ready")
	const reused = await boot(t, { datasets: [grant], seed: async ({ workspace }) => {
		await fs.cp(path.join(b.workspace, "datasets"), path.join(workspace, "datasets"), { recursive: true })
	} })
	await assert.rejects(fs.stat(path.join(reused.root, "transfers")), { code: "ENOENT" })
	assert.match(reused.status.datasets[0].status, /already on this volume/)
})

test("failed copy reports private error without creating a visible dataset folder or blocking readiness", async (t) => {
	const b = await boot(t, { datasets: [grant], copyFails: true })
	await assert.rejects(fs.stat(path.join(b.workspace, "datasets")), { code: "ENOENT" })
	assert.equal(b.status.state, "error")
	assert.equal((await b.health.ready()).ready, true)
})

test("restart removes generated status-only clutter and resets stale private progress even with no token", async (t) => {
	const b = await boot(t, { token: false, seed: async ({ workspace, gatewayStateDir }) => {
		await fs.mkdir(path.join(workspace, "datasets"))
		await fs.writeFile(path.join(workspace, "datasets/.status.json"), JSON.stringify(oldStatus))
		await fs.writeFile(path.join(workspace, "datasets/STATUS.md"), oldMarkdown)
		await fs.mkdir(path.join(gatewayStateDir, "datasets"), { recursive: true })
		await fs.writeFile(path.join(gatewayStateDir, "datasets/status.json"), JSON.stringify({ ...oldStatus, state: "error" }))
		await fs.writeFile(path.join(gatewayStateDir, "datasets/STATUS.md"), "stale error")
	} })
	assert.deepEqual(await fs.readdir(b.workspace), [])
	assert.equal(b.status.state, "idle")
	await assert.rejects(fs.stat(path.join(b.gatewayStateDir, "datasets/STATUS.md")), { code: "ENOENT" })
})

test("cleanup preserves ordinary project data and unrecognized or symlinked status files", async (t) => {
	for (const symlink of [false, true]) {
		const b = await boot(t, { seed: async ({ root, workspace }) => {
			await fs.mkdir(path.join(workspace, "datasets"))
			await fs.writeFile(path.join(workspace, "datasets/input.csv"), "keep")
			await fs.writeFile(path.join(workspace, "datasets/STATUS.md"), "User notes")
			if (symlink) {
				await fs.writeFile(path.join(root, "outside.json"), JSON.stringify(oldStatus))
				await fs.symlink(path.join(root, "outside.json"), path.join(workspace, "datasets/.status.json"))
			} else await fs.writeFile(path.join(workspace, "datasets/.status.json"), '{"user":"notes"}')
		} })
		assert.equal(await fs.readFile(path.join(b.workspace, "datasets/input.csv"), "utf8"), "keep")
		assert.equal(await fs.readFile(path.join(b.workspace, "datasets/STATUS.md"), "utf8"), "User notes")
		if (symlink) {
			assert.ok((await fs.lstat(path.join(b.workspace, "datasets/.status.json"))).isSymbolicLink())
			assert.deepEqual(JSON.parse(await fs.readFile(path.join(b.root, "outside.json"), "utf8")), oldStatus)
		} else assert.equal(await fs.readFile(path.join(b.workspace, "datasets/.status.json"), "utf8"), '{"user":"notes"}')
	}
})

test("revoking the final managed dataset removes its now-empty folder", async (t) => {
	const b = await boot(t, { seed: async ({ workspace }) => {
		await fs.mkdir(path.join(workspace, "datasets/reference"), { recursive: true })
		await fs.writeFile(path.join(workspace, "datasets/reference/.dataset.json"), JSON.stringify({ slug: "reference", version: "1" }))
	} })
	assert.deepEqual(await fs.readdir(b.workspace), [])
	assert.match(b.status.datasets[0].status, /revoked/)
})

test("status cleanup does not traverse a symlinked dataset root", async (t) => {
	const b = await boot(t, { token: false, seed: async ({ root, workspace }) => {
		const outside = path.join(root, "outside")
		await fs.mkdir(outside)
		await fs.writeFile(path.join(outside, ".status.json"), JSON.stringify(oldStatus))
		await fs.writeFile(path.join(outside, "STATUS.md"), oldMarkdown)
		await fs.symlink(outside, path.join(workspace, "datasets"))
	} })
	assert.ok((await fs.lstat(path.join(b.workspace, "datasets"))).isSymbolicLink())
	assert.deepEqual(JSON.parse(await fs.readFile(path.join(b.root, "outside/.status.json"), "utf8")), oldStatus)
	assert.equal(await fs.readFile(path.join(b.root, "outside/STATUS.md"), "utf8"), oldMarkdown)
})

test("cleanup removes generated metadata without removing dataset content", async (t) => {
	const b = await boot(t, { seed: async ({ workspace }) => {
		await fs.mkdir(path.join(workspace, "datasets"))
		await fs.writeFile(path.join(workspace, "datasets/.status.json"), JSON.stringify(oldStatus))
		await fs.writeFile(path.join(workspace, "datasets/STATUS.md"), oldMarkdown)
		await fs.writeFile(path.join(workspace, "datasets/input.csv"), "keep")
	} })
	assert.deepEqual(await fs.readdir(path.join(b.workspace, "datasets")), ["input.csv"])
	assert.equal(await fs.readFile(path.join(b.workspace, "datasets/input.csv"), "utf8"), "keep")
})

test("a planted private Markdown directory cannot prevent runtime boot", async (t) => {
	const b = await boot(t, { token: false, seed: async ({ gatewayStateDir }) => {
		await fs.mkdir(path.join(gatewayStateDir, "datasets/STATUS.md"), { recursive: true })
	} })
	assert.deepEqual(await fs.readdir(b.workspace), [])
	assert.equal(b.status.state, "idle")
	assert.equal((await b.health.ready()).ready, true)
})

test("health reports idle when private progress is missing or malformed", async (t) => {
	const b = await boot(t)
	await fs.writeFile(path.join(b.gatewayStateDir, "datasets/status.json"), "broken")
	assert.deepEqual(await b.health.datasetsState(), { state: "idle", datasets: [], updatedAt: null })
	await fs.rm(path.join(b.gatewayStateDir, "datasets/status.json"))
	assert.deepEqual(await b.health.datasetsState(), { state: "idle", datasets: [], updatedAt: null })
})
