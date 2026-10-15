/** Root observer integration with authenticated local services in a disposable container. */
import assert from "node:assert/strict"
import fs from "node:fs"
import http from "node:http"
import { spawn } from "node:child_process"
import { once } from "node:events"
import { provisionPreprocessing } from "../lib/preprocessing-provision.js"

fs.mkdirSync("/workspace/.runtime", { recursive: true })
fs.mkdirSync("/run/runtime", { recursive: true, mode: 0o700 })
fs.writeFileSync("/run/runtime/files-control", "files-root-control", { mode: 0o600 })
let chat = "permission_pending", processing = "prompt_running", gatewayDown = false
const sent = [], measurements = []
let storagePosts = 0, peakStoragePosts = 0
const json = (res, body) => { res.writeHead(200, { "content-type": "application/json" }); res.end(JSON.stringify(body)) }
const snapshot = (state, id) => ({ state, session_id: id === "chat" && state !== "idle" ? "conversation" : null, observedAt: new Date().toISOString(), interests: state === "idle" ? [] : [{ id, state, startedAt: new Date().toISOString() }] })
const agent = { permission_pending: "needs_input", prompt_running: "working", idle: "idle" }
const receiver = http.createServer(async (req, res) => {
	assert.equal(req.headers.authorization, "Bearer root-activity-credential")
	let raw = ""; for await (const chunk of req) raw += chunk
	const value = JSON.parse(raw)
	assert.deepEqual(Object.keys(value).sort(), ["agent", "session_id", "state", "storage"])
	assert.ok(Number.isSafeInteger(value.storage.total_bytes) && value.storage.used_bytes <= value.storage.total_bytes)
	sent.push(value); json(res, {})
})
await new Promise((r) => receiver.listen(0, "127.0.0.1", r))
provisionPreprocessing({ PROJECT_ID: "fixture", RUNTIME_AGGREGATE_ACTIVITY: "true", RUNTIME_ACTIVITY_URL: `http://127.0.0.1:${receiver.address().port}/activity`, RUNTIME_ACTIVITY_TOKEN: "root-activity-credential", RUNTIME_ACTIVITY_INTERVAL_S: "1", PREPROCESSING_STORAGE_INTERVAL_S: "1" })
const runtimeControl = fs.readFileSync("/run/runtime/preprocessing/runtime-control", "utf8")
const gateway = http.createServer((req, res) => {
	assert.equal(req.headers["x-gc-runtime-control"], runtimeControl)
	if (gatewayDown) { res.writeHead(503); res.end(); return }
	json(res, { ...snapshot(chat, "chat"), agent: { state: agent[chat], turn_completed_at: null } })
})
const files = http.createServer(async (req, res) => {
	assert.equal(req.headers["x-gc-files-control"], "files-root-control")
	if (req.url === "/internal/files/activity") return json(res, snapshot(processing, "processing"))
	assert.equal(req.url, "/internal/files/storage")
	peakStoragePosts = Math.max(peakStoragePosts, ++storagePosts)
	let raw = ""; for await (const chunk of req) raw += chunk
	await new Promise((r) => setTimeout(r, 120 + Math.floor(Math.random() * 40)))
	measurements.push(JSON.parse(raw)); storagePosts--; json(res, {})
})
await new Promise((r) => gateway.listen(3001, "127.0.0.1", r))
await new Promise((r) => files.listen(0, "127.0.0.1", r))
const child = spawn(process.execPath, [new URL("../root-lifecycle.js", import.meta.url).pathname], { env: { PATH: "/usr/local/bin:/usr/bin:/bin", RUNTIME_FILES_PORT: String(files.address().port) }, stdio: ["ignore", "inherit", "inherit"] })
const exited = once(child, "exit")
async function until(check) {
	const end = Date.now() + 5000
	while (!check()) { assert.ok(Date.now() < end, "root lifecycle did not report expected state"); await new Promise((r) => setTimeout(r, 20)) }
}
try {
	await until(() => sent.some((s) => s.state === "permission_pending" && s.agent.state === "needs_input"))
	chat = "idle"
	await until(() => sent.some((s) => s.state === "prompt_running" && s.session_id === null))
	assert.equal(sent.some((s) => s.state === "idle"), false, "chat ending falsely idled processing")
	processing = "idle"
	await until(() => sent.some((s) => s.state === "idle"))
	gatewayDown = true
	await until(() => sent.at(-1)?.state === "prompt_running")
	assert.ok(measurements.some((m) => Number.isFinite(m.diskFreeBytes) && typeof m.complete === "boolean"))
	const result = await new Promise((resolve, reject) => {
		const req = http.request({ socketPath: "/run/runtime/lifecycle.sock", path: "/stop-pair", method: "POST" }, (res) => {
			let raw = ""; res.on("data", (chunk) => { raw += chunk }); res.on("end", () => resolve(JSON.parse(raw)))
		})
		req.on("error", reject); req.end(JSON.stringify({ deadlineMs: Date.now() + 1000 }))
	})
	assert.equal(result.complete, true)
	child.kill("SIGTERM")
	assert.equal((await exited)[0], 0)
	assert.equal(peakStoragePosts, 1)
	console.log(JSON.stringify({ externalStates: sent.map((s) => s.state), processingOnlySessionId: null, unknownGatewayKeptActive: true, privateStorageMeasurements: measurements.length, peakControlPosts: peakStoragePosts, pairDrainComplete: true, rootExitCode: 0 }))
} finally {
	child.kill("SIGKILL")
	await Promise.all([receiver, gateway, files].map((server) => new Promise((r) => server.close(r))))
}
