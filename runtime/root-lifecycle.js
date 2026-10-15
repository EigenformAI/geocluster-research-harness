#!/usr/bin/env node
import fs from "node:fs"
import http from "node:http"
import path from "node:path"
import { execFile } from "node:child_process"
import { promisify } from "node:util"
import { RootActivityReporter } from "./lib/root-activity.js"
import { PreprocessingPair } from "./lib/preprocessing-pair.js"

const exec = promisify(execFile)
const run = "/run/runtime/preprocessing"
const boot = JSON.parse(fs.readFileSync(`${run}/boot.json`, "utf8"))
const code = path.dirname(new URL(import.meta.url).pathname)
const clean = { PATH: "/usr/local/bin:/usr/bin:/bin", LANG: "C.UTF-8", HOME: "/nonexistent", PYTHONDONTWRITEBYTECODE: "1", PYTHONUNBUFFERED: "1", RUNTIME_MANAGED_DISCOVERY_MAX_BYTES: String(boot.managedDiscoveryMaxBytes ?? 1024 * 1024) }
const token = (name) => fs.readFileSync(`${run}/${name}`, "utf8").trim()
const filesToken = fs.readFileSync("/run/runtime/files-control", "utf8").trim()
const filesPort = Number(process.env.RUNTIME_FILES_PORT || 3002)

async function control(port, endpoint, header, secret, body) {
	const response = await fetch(`http://127.0.0.1:${port}${endpoint}`, { method: body ? "POST" : "GET", redirect: "error", headers: { [header]: secret, ...(body ? { "content-type": "application/json" } : {}) }, ...(body ? { body: JSON.stringify(body) } : {}), signal: AbortSignal.timeout(2000) })
	if (!response.ok) { await response.body?.cancel(); throw new Error("private control unavailable") }
	const reader = response.body.getReader(), chunks = []
	let bytes = 0
	while (true) {
		const { value, done } = await reader.read()
		if (done) break
		bytes += value.byteLength
		if (bytes > 1024 * 1024) { await reader.cancel(); throw new Error("private control response too large") }
		chunks.push(value)
	}
	return JSON.parse(Buffer.concat(chunks, bytes).toString("utf8"))
}

const pair = new PreprocessingPair({ command: "/opt/geocluster-preprocessing/bin/python", args: [path.join(code, "preprocessing-pair.py"), run], env: clean, maxAttempts: boot.restartMaxAttempts, backoffMs: boot.restartBackoffMs, cooldownMs: boot.retryCooldownMs })
if (boot.configured) pair.start()
let activitySnapshot = null, storageSnapshot = null, storageInflight = null, publishInflight = null, closing = false
function publishStorage() {
	// Coalesce observer/reporter updates so a delayed older measurement cannot
	// overwrite a newer one through concurrently outstanding control requests.
	if (publishInflight) return publishInflight
	publishInflight = control(filesPort, "/internal/files/storage", "x-gc-files-control", filesToken, { ...(storageSnapshot ?? { complete: false, observedAt: new Date().toISOString() }), bundleDigest: boot.bundleDigest, pair: pair.snapshot(), activity: activitySnapshot }).catch(() => {}).finally(() => { publishInflight = null })
	return publishInflight
}
async function observeStorage() {
	if (storageInflight || closing) return
	storageInflight = (async () => {
		try {
			const { stdout } = await exec("/usr/bin/python3", [path.join(code, "root-storage.py"), `${boot.base}/data`], { env: clean, timeout: 5000, maxBuffer: 65536 })
			storageSnapshot = JSON.parse(stdout)
		} catch { storageSnapshot = { complete: false, observedAt: new Date().toISOString(), error: "storage_accounting_unavailable" } }
		await publishStorage()
	})().finally(() => { storageInflight = null })
	await storageInflight
}
const gatewayActivity = () => control(3001, "/internal/runtime/activity", "x-gc-runtime-control", token("runtime-control"))
const reporter = boot.aggregate ? new RootActivityReporter({ url: boot.activityUrl, token: token("activity-token"), intervalMs: boot.activityIntervalMs, maxInterestMs: boot.maxInterestMs,
	storageDir: "/workspace", storageIntervalMs: boot.storageReportIntervalMs, agentSource: gatewayActivity,
	sources: [gatewayActivity, () => control(filesPort, "/internal/files/activity", "x-gc-files-control", filesToken)],
	onSnapshot: async (snapshot) => { activitySnapshot = { ...snapshot, observedAt: new Date().toISOString() }; await publishStorage() },
}) : null
reporter?.start()
void observeStorage()
const storageTimer = setInterval(() => void observeStorage(), boot.storageIntervalMs)

const socket = "/run/runtime/lifecycle.sock"
fs.rmSync(socket, { force: true })
let drainPromise
const server = http.createServer((req, res) => {
	if (req.method !== "POST" || req.url !== "/stop-pair") { res.writeHead(404); res.end(); return }
	let raw = ""
	req.on("data", (chunk) => { raw += chunk; if (raw.length > 4096) req.destroy() })
	req.on("end", async () => {
		try {
			const deadlineMs = Number(JSON.parse(raw).deadlineMs)
			if (!Number.isFinite(deadlineMs)) throw new Error("invalid deadline")
			drainPromise ??= pair.stop(deadlineMs)
			const result = await drainPromise
			res.writeHead(200, { "content-type": "application/json" }); res.end(JSON.stringify(result))
		} catch { res.writeHead(400); res.end() }
	})
})
server.listen(socket, () => fs.chmodSync(socket, 0o600))
async function close() {
	if (closing) return
	closing = true
	clearInterval(storageTimer)
	await (drainPromise ?? pair.stop(Date.now() + 210000))
	await storageInflight
	await reporter?.close()
	server.close(() => process.exit(0))
}
process.on("SIGTERM", () => void close())
process.on("SIGINT", () => void close())
