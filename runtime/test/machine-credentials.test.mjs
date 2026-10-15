import assert from "node:assert/strict"
import fs from "node:fs/promises"
import http from "node:http"
import os from "node:os"
import path from "node:path"
import { test } from "node:test"
import { spawn } from "node:child_process"
import { loadConfig } from "../lib/config.js"
import { say, startGateway, until } from "./gateway-harness.mjs"
import { managedDiscovery } from "./managed-catalog-fixture.mjs"

const logger = (events) => ({ info: (message, data) => events.push({ message, ...data }), warn: (message, data) => events.push({ message, ...data }) })

function clock() {
	let now = Date.parse("2026-10-06T00:00:00Z"), sequence = 0
	const timers = new Map()
	return {
		now: () => now,
		setTimeoutImpl(fn, delay) { const id = ++sequence; timers.set(id, { fn, at: now + delay }); return id },
		clearTimeoutImpl(id) { timers.delete(id) },
		async advance(ms) {
			const target = now + ms
			while (true) {
				const next = [...timers.entries()].filter(([, task]) => task.at <= target).sort((a, b) => a[1].at - b[1].at)[0]
				if (!next) break
				now = next[1].at; timers.delete(next[0]); await next[1].fn()
			}
			now = target
		},
		pending: () => timers.size,
	}
}

async function backend(t, time) {
	const root = await fs.mkdtemp(path.join(os.tmpdir(), "machine-renew-")), tokenFile = path.join(root, "machine-token")
	await fs.writeFile(tokenFile, "private-machine-token", { mode: 0o600 })
	const requests = [], calls = []
	let generation = 0, failure = false, malformed = false, cleanup = false
	const server = http.createServer(async (req, res) => {
		const chunks = []; for await (const chunk of req) chunks.push(chunk)
		const body = Buffer.concat(chunks)
		if (req.url === "/renew") {
			requests.push({ method: req.method, headers: req.headers, body: body.toString() })
			res.setHeader("content-type", "application/json")
			if (failure) { res.writeHead(503); res.end(JSON.stringify({ error: "offline", secret: "must-not-be-logged" })); return }
			generation++
			if (cleanup) { res.end(JSON.stringify({ cleanupToken: `cleanup-${generation}`, expiresAt: new Date(time.now() + 10000).toISOString() })); return }
			res.end(JSON.stringify({ llmToken: `llm-${generation}`, activityToken: `activity-${generation}`, datasetToken: malformed ? "" : `dataset-${generation}`, filesToken: `files-${generation}`, workToken: `work-${generation}`, expiresAt: new Date(time.now() + 10000).toISOString() }))
			return
		}
		calls.push({ path: req.url, authorization: req.headers.authorization, cookie: req.headers.cookie, kind: req.headers["x-geocluster-kind"], body })
		if (req.url === "/v1/account") { res.writeHead(200, { "content-type": "application/json" }); res.end(JSON.stringify(managedDiscovery())); return }
		res.writeHead(200, { "content-type": "text/event-stream", "x-test-stream": "preserved" }); res.end("data: ok\n\n")
	})
	await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve))
	t.after(async () => { server.closeAllConnections(); await new Promise((resolve) => server.close(resolve)); await fs.rm(root, { recursive: true, force: true }) })
	const base = `http://127.0.0.1:${server.address().port}`
	const config = loadConfig({ IDE_MACHINE_TOKEN_FILE: tokenFile, IDE_MACHINE_CREDENTIALS_URL: `${base}/renew`, LLM_PROXY_URL: `${base}/v1`, RUNTIME_ACTIVITY_URL: `${base}/activity` })
	return { root, config, requests, calls, fail: (value) => { failure = value }, malformed: (value) => { malformed = value }, cleanup: (value) => { cleanup = value } }
}

test("machine renewal config captures root file material without adding it to the agent environment", () => {
	const config = loadConfig({ IDE_MACHINE_TOKEN: "private", IDE_MACHINE_TOKEN_FILE: "/run/runtime/machine-token", IDE_MACHINE_CREDENTIALS_URL: "http://localhost/renew" })
	assert.equal(config.machineTokenFile, "/run/runtime/machine-token")
	assert.equal(config.machineCredentialsUrl, "http://localhost/renew")
	for (const name of ["IDE_MACHINE_TOKEN", "IDE_MACHINE_TOKEN_FILE", "IDE_MACHINE_CREDENTIALS_URL"]) assert.equal(config.agentEnv[name], undefined)
	assert.ok(!JSON.stringify(config).includes('"private"'))
})

test("timed machine renewal changes future LLM and activity auth while a live agent turn keeps its process and state", async (t) => {
	const time = clock(), b = await backend(t, time), events = []
	const { createMachineGateway } = await import("../machine-gateway.js")
	const machine = await createMachineGateway({ config: b.config, logger: logger(events), renewalOptions: time })
	await new Promise((resolve) => machine.server.listen(0, "127.0.0.1", resolve))
	t.after(() => machine.close())
	const base = `http://127.0.0.1:${machine.server.address().port}`
	const g = await startGateway(t, { env: { LLM_PROXY_URL: `${base}/llm`, IDE_LLM_TOKEN: "runtime-relay", RUNTIME_ACTIVITY_URL: `${base}/activity`, RUNTIME_ACTIVITY_TOKEN: "runtime-relay", IDE_MACHINE_TOKEN: "not-for-agent", IDE_MACHINE_TOKEN_FILE: b.config.machineTokenFile, IDE_MACHINE_CREDENTIALS_URL: b.config.machineCredentialsUrl } })
	g.app.activity.fetch = fetch
	const c = await g.client(), session = await c.conn.newSession({ cwd: g.workspace, mcpServers: [] })
	const pending = c.conn.prompt(say(session.sessionId, "hang"))
	await until(() => c.text(session.sessionId).length > 0)
	const pid = g.app.broker.engine.pid, generation = g.app.broker.engine.generation
	const sendLlm = () => fetch(`${g.config.agentEnv.LLM_PROXY_URL}/chat/completions?stream=1`, { method: "POST", headers: { authorization: `Bearer ${g.config.agentEnv.IDE_LLM_TOKEN}`, cookie: "browser=ignored", "content-type": "application/json" }, body: '{"messages":[]}' })
	assert.equal(await (await sendLlm()).text(), "data: ok\n\n")
	await time.advance(8000)
	assert.equal(b.config.llmToken, "llm-2")
	assert.equal(b.config.datasetToken, "dataset-2")
	assert.equal((await sendLlm()).headers.get("x-test-stream"), "preserved")
	g.app.activity.start("another-live-interest")
	await until(() => b.calls.some((call) => call.path === "/activity" && call.authorization === "Bearer activity-2"))
	assert.deepEqual(b.calls.filter((call) => call.path.startsWith("/v1/chat/")).map((call) => [call.path, call.authorization, call.body.toString()]), [["/v1/chat/completions?stream=1", "Bearer llm-1", '{"messages":[]}'], ["/v1/chat/completions?stream=1", "Bearer llm-2", '{"messages":[]}']])
	assert.ok(b.calls.some((call) => call.path === "/v1/account" && call.authorization === "Bearer llm-1"))
	assert.ok(b.calls.every((call) => call.cookie === undefined))
	assert.equal(g.app.broker.engine.pid, pid)
	assert.equal(g.app.broker.engine.generation, generation)
	assert.equal(g.app.activity.state, "prompt_running")
	assert.deepEqual(c.turnEnds(session.sessionId), [])
	for (const key of ["IDE_MACHINE_TOKEN", "IDE_MACHINE_TOKEN_FILE", "IDE_MACHINE_CREDENTIALS_URL"]) assert.ok(!g.engineMeta().envKeys.includes(key))
	assert.ok(b.requests.every((req) => req.method === "POST" && req.headers.authorization === "Bearer private-machine-token" && req.headers.cookie === undefined))
	await c.conn.cancel({ sessionId: session.sessionId }); await pending
	g.app.activity.stop("another-live-interest")
})

test("failed renewal retries with backoff, reports expiry, and never partially installs malformed credentials", async (t) => {
	const time = clock(), b = await backend(t, time), events = []
	const { createMachineGateway } = await import("../machine-gateway.js")
	const machine = await createMachineGateway({ config: b.config, logger: logger(events), renewalOptions: { ...time, retryMs: 1000, retryMaxMs: 4000 } })
	const renewal = machine.credentials
	await new Promise((resolve) => machine.server.listen(0, "127.0.0.1", resolve))
	t.after(() => machine.close())
	const llm = `http://127.0.0.1:${machine.server.address().port}/llm/chat/completions`
	b.malformed(true)
	await time.advance(8000)
	assert.equal(b.config.llmToken, "llm-1", "an invalid dataset token cannot partially rotate the LLM credential")
	b.malformed(false); b.fail(true)
	await time.advance(7000)
	assert.equal(b.requests.length, 5, "one attempt at boot and retries at 8, 9, 11 and 15 seconds")
	assert.ok(events.some((event) => event.message === "machine credentials expired"))
	assert.deepEqual(events.filter((event) => event.message === "machine credential renewal failed").map((event) => event.retryInMs), [1000, 2000, 4000, 4000])
	assert.ok(!JSON.stringify(events).includes("private-machine-token"))
	assert.ok(!JSON.stringify(events).includes("must-not-be-logged"))
	const expired = await fetch(llm, { method: "POST", body: "{}" })
	assert.equal(expired.status, 503)
	assert.equal((await expired.json()).error.code, "usage_unavailable")
	assert.equal(b.calls.length, 0, "expired credentials cannot dispatch a new service request")
	b.fail(false)
	await time.advance(4000)
	assert.equal(b.config.llmToken, "llm-3")
	assert.ok(Date.parse(b.config.machineCredentialsExpiresAt) > time.now())
	assert.equal((await fetch(llm, { method: "POST", body: "{}" })).status, 200)
	assert.equal(b.calls.at(-1).authorization, "Bearer llm-3")
	await renewal.close()
	assert.equal(time.pending(), 0)
})

test("direct no-config mode requires no credential service", async () => {
	const { MachineCredentials } = await import("../lib/machine-credentials.js")
	const config = loadConfig({ IDE_LLM_TOKEN: "direct" })
	const renewal = new MachineCredentials(config, logger([]), { fetchImpl: () => { throw new Error("unexpected online call") } })
	assert.equal(await renewal.start(), false)
	assert.equal(config.agentEnv.IDE_LLM_TOKEN, "direct")
	await renewal.close()
})

test("private preprocessing channel uses renewed model authority and stops on expiry or cleanup", async (t) => {
	const time = clock(), b = await backend(t, time)
	b.config.preprocessingProxyToken = "private-processor-channel"
	const { createMachineGateway } = await import("../machine-gateway.js")
	const machine = await createMachineGateway({ config: b.config, logger: logger([]), renewalOptions: time })
	await new Promise((resolve) => machine.server.listen(0, "127.0.0.1", resolve))
	t.after(() => machine.close())
	const url = `http://127.0.0.1:${machine.server.address().port}/llm/chat/completions`
	const send = () => fetch(url, { method: "POST", headers: { authorization: "Bearer private-processor-channel", "x-geocluster-kind": "primary" }, body: "{}" })
	assert.equal((await send()).status, 200)
	assert.equal(b.calls.at(-1).authorization, "Bearer llm-1")
	assert.equal(b.calls.at(-1).kind, "preprocessing")
	await time.advance(8000)
	assert.equal((await send()).status, 200)
	assert.equal(b.calls.at(-1).authorization, "Bearer llm-2")
	assert.equal(b.calls.at(-1).kind, "preprocessing")
	assert.equal(b.config.preprocessingProxyToken, "private-processor-channel", "engine channel stays stable across renewal")
	b.fail(true); await time.advance(10000)
	assert.equal((await send()).status, 503)
	assert.equal(b.calls.length, 2)
	b.fail(false); b.cleanup(true); await machine.credentials.refresh()
	assert.equal((await send()).status, 403)
	assert.equal(b.calls.length, 2)
})

test("root file/work channel requires its private secret, fixed routes and workspace headers; renewal replaces both purpose tokens", async (t) => {
	const time = clock(), b = await backend(t, time), events = []
	const { createMachineGateway } = await import("../machine-gateway.js")
	const backendBase = b.config.machineCredentialsUrl.replace(/\/renew$/, "")
	Object.assign(b.config, { filesUrl: `${backendBase}/runtime/files`, fileWorkUrl: `${backendBase}/runtime/file-work`, filesControlSecret: "f".repeat(64) })
	const app = await createMachineGateway({ config: b.config, logger: logger(events), renewalOptions: time })
	await new Promise((r) => app.server.listen(0, "127.0.0.1", r)); t.after(() => app.close())
	const base = `http://127.0.0.1:${app.server.address().port}`
	const headers = { "x-gc-files-control": "f".repeat(64), "x-gc-workspace-id": "workspace", "x-gc-workspace-epoch": "epoch", authorization: "Bearer caller-must-not-forward", cookie: "browser=ignored" }
	assert.equal((await fetch(`${base}/work-backend/claims`, { method: "POST", body: "{}" })).status, 403)
	assert.equal((await fetch(`${base}/files-backend/snapshots`, { method: "POST", body: "{}", headers: { "x-gc-files-control": headers["x-gc-files-control"] } })).status, 400)
	assert.equal((await fetch(`${base}/files-backend/../../admin`, { headers })).status, 404)
	assert.equal((await fetch(`${base}/files-backend/limits`, { headers })).status, 200)
	assert.equal(b.calls.at(-1).authorization, "Bearer files-1")
	await time.advance(8000)
	assert.equal((await fetch(`${base}/work-backend/claims`, { method: "POST", headers, body: "{}" })).status, 200)
	assert.equal(b.calls.at(-1).authorization, "Bearer work-2")
	assert.equal(b.config.filesToken, "files-2")
	for (const [method, route] of [["GET", "status"], ["POST", "permit"], ["POST", "checkpoint"]]) {
		assert.equal((await fetch(`${base}/work-backend/demo/${route}`, { method, headers, ...(method === "POST" ? { body: "{}" } : {}) })).status, 200)
		assert.equal(b.calls.at(-1).authorization, "Bearer work-2")
	}
	for (const [method, route] of [["POST", "status"], ["GET", "permit"], ["GET", "checkpoint"], ["POST", "retry"], ["POST", "arbitrary"]]) assert.equal((await fetch(`${base}/work-backend/demo/${route}`, { method, headers, ...(method === "POST" ? { body: "{}" } : {}) })).status, 404)
	assert.ok(b.calls.every((c) => c.cookie === undefined))
	assert.equal((await fetch(`${base}/work-backend/claims`, { method: "DELETE", headers })).status, 404)
	assert.ok(!JSON.stringify(events).includes("work-2"))
})

test("entrypoint renews before dataset hydration, stores private material, and scrubs renewal env", async (t) => {
	const root = await fs.mkdtemp(path.join(os.tmpdir(), "machine-boot-"))
	const calls = []
	const server = http.createServer(async (req, res) => {
		for await (const _chunk of req) { /* drain */ }
		calls.push([req.url, req.headers.authorization])
		res.setHeader("content-type", "application/json")
		res.end(JSON.stringify(req.url === "/renew" ? { llmToken: "boot-llm", activityToken: "boot-activity", datasetToken: "boot-dataset", expiresAt: new Date(Date.now() + 3600000).toISOString() } : { datasets: [] }))
	})
	await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve))
	t.after(async () => { server.closeAllConnections(); await new Promise((resolve) => server.close(resolve)); await fs.rm(root, { recursive: true, force: true }) })
	const base = `http://127.0.0.1:${server.address().port}`
	const entrypoint = await fs.readFile(new URL("../../entrypoint.sh", import.meta.url), "utf8")
	// Exercise the real boot functions against local endpoints; no system provisioning or agent starts.
	const script = entrypoint.replace(/launch_runtime "\$@"\s*$/, "") + `
trap - EXIT SIGTERM SIGINT SIGQUIT
RUN_DIR=${JSON.stringify(root)}
RUNTIME_CODE_DIR=${JSON.stringify(path.resolve(new URL("..", import.meta.url).pathname))}
DATASETS_MANIFEST="$RUN_DIR/datasets.json"
DATASETS_LOG="$RUN_DIR/datasets.log"
configure_machine_credentials
fetch_dataset_entitlements
scrub_secrets
node --input-type=module -e 'import {loadConfig} from ${JSON.stringify(new URL("../lib/config.js", import.meta.url).href)}; console.log("BOOT_ENV="+JSON.stringify({keys:Object.keys(process.env),agent:loadConfig().agentEnv}))'
`
	const result = await new Promise((resolve) => {
		const child = spawn("bash", [], { env: { PATH: process.env.PATH, HOME: root, IDE_MACHINE_TOKEN: "boot-machine-private", IDE_MACHINE_CREDENTIALS_URL: `${base}/renew`, IDE_DATASETS_URL: `${base}/datasets`, LLM_PROXY_URL: `${base}/v1`, RUNTIME_ACTIVITY_URL: `${base}/activity`, IDE_DATASET_TOKEN: "stale-dataset" }, stdio: ["pipe", "pipe", "pipe"] })
		let stdout = "", stderr = ""
		child.stdout.on("data", (bytes) => { stdout += bytes }); child.stderr.on("data", (bytes) => { stderr += bytes })
		child.on("close", (code) => resolve({ code, stdout, stderr })); child.stdin.end(script)
	})
	assert.equal(result.code, 0, result.stderr)
	assert.deepEqual(calls, [["/renew", "Bearer boot-machine-private"], ["/datasets", "Bearer boot-dataset"]])
	const env = JSON.parse(result.stdout.split("BOOT_ENV=")[1])
	for (const key of ["IDE_MACHINE_TOKEN", "IDE_MACHINE_TOKEN_FILE", "IDE_MACHINE_CREDENTIALS_URL", "IDE_MACHINE_CREDENTIALS_FILE", "IDE_DATASET_TOKEN"]) assert.ok(!env.keys.includes(key), `${key} reached the scrubbed environment`)
	assert.equal(env.agent.IDE_LLM_TOKEN, "runtime-relay")
	assert.equal(env.agent.LLM_PROXY_URL, "http://127.0.0.1:3003/llm")
	const tokenFile = path.join(root, "machine-token"), credentialFile = path.join(root, "machine-credentials.json")
	assert.equal(await fs.readFile(tokenFile, "utf8"), "boot-machine-private")
	for (const file of [tokenFile, credentialFile]) assert.equal((await fs.stat(file)).mode & 0o777, 0o600)
	assert.equal(JSON.parse(await fs.readFile(credentialFile, "utf8")).datasetToken, "boot-dataset")
	assert.ok(!result.stdout.includes("boot-machine-private"))
})

test("reviewed contract: cleanup-only renewal clears normal authority and restricts forwarding to authenticated work observations and settlement", async (t) => {
	const time = clock(), b = await backend(t, time), events = [], base = b.config.machineCredentialsUrl.replace(/\/renew$/, "")
	const { createMachineGateway } = await import("../machine-gateway.js")
	Object.assign(b.config, { filesUrl: `${base}/runtime/files`, fileWorkUrl: `${base}/runtime/file-work`, filesControlSecret: "a".repeat(64) })
	const app = await createMachineGateway({ config: b.config, logger: logger(events), renewalOptions: time })
	await new Promise((r) => app.server.listen(0, "127.0.0.1", r)); t.after(() => app.close())
	b.cleanup(true); await time.advance(8000)
	assert.equal(b.config.cleanupToken, "cleanup-2")
	for (const key of ["llmToken", "datasetToken", "activityToken", "filesToken", "workToken"]) assert.equal(b.config[key], "")
	const gateway = `http://127.0.0.1:${app.server.address().port}`, headers = { "x-gc-files-control": "a".repeat(64), "x-gc-workspace-id": "workspace", "x-gc-workspace-epoch": "epoch" }
	for (const [url, method] of [["/files-backend/limits", "GET"], ["/work-backend/claims", "POST"], ["/work-backend/work/source-url", "POST"], ["/work-backend/work/permits", "POST"], ["/work-backend/work/ack", "POST"], ["/llm/chat/completions", "POST"], ["/activity", "POST"]]) assert.equal((await fetch(gateway + url, { method, headers, ...(method === "POST" ? { body: "{}" } : {}) })).status, 403)
	assert.equal((await fetch(`${gateway}/work-backend/work`, { headers })).status, 200)
	assert.equal((await fetch(`${gateway}/work-backend/permits/permit/settle`, { method: "POST", headers, body: "{}" })).status, 200)
	assert.equal(b.calls.at(-1).authorization, "Bearer cleanup-2")
	assert.equal((await fetch(`${gateway}/work-backend/work`)).status, 403)
	for (const [method, route] of [["GET", "status"], ["POST", "permit"], ["POST", "checkpoint"]]) assert.equal((await fetch(`${gateway}/work-backend/demo/${route}`, { method, headers, ...(method === "POST" ? { body: "{}" } : {}) })).status, 403)
	assert.ok(!JSON.stringify(events).includes("cleanup-2"))
})

test("entrypoint preserves Origins and adjustable import page limits in the private daemon environment", async (t) => {
	const root = await fs.mkdtemp(path.join(os.tmpdir(), "machine-origin-"))
	t.after(() => fs.rm(root, { recursive: true, force: true }))
	const entrypoint = await fs.readFile(new URL("../../entrypoint.sh", import.meta.url), "utf8")
	// Execute the production launch commands, replacing only privilege dropping and
	// service mains with config probes. No root provisioning, sockets or agents start.
	const filesLaunch = entrypoint.slice(entrypoint.indexOf("    # Private file service:"), entrypoint.indexOf("    # Pair startup"))
	const gateLaunch = `${entrypoint.slice(entrypoint.indexOf("start_access_gate() {"), entrypoint.indexOf("\nmain() {"))}\nstart_access_gate`
	assert.ok(filesLaunch && gateLaunch, "Production service launch commands must be available to the boot fixture.")
	await fs.writeFile(path.join(root, "gosu"), '#!/bin/sh\nshift\nexec "$@"\n', { mode: 0o755 })
	await fs.writeFile(path.join(root, "files-input"), "private fixture input\n")
	await fs.writeFile(path.join(root, "processor-token"), "private-fixture-token")
	await fs.writeFile(path.join(root, "files-server.js"), `
const {loadFilesConfig} = await import(${JSON.stringify(new URL("../files-server.js", import.meta.url).href)});
const config=loadFilesConfig();
console.log("ORIGIN_FILES="+JSON.stringify({raw:process.env.RUNTIME_ALLOWED_ORIGINS??null,allowed:config.allowedOrigins}));
console.log("IMPORT_PAGES="+config.cloudImport.maxClaimPages);
`)
	await fs.writeFile(path.join(root, "gate.cjs"), `
const gate=require(${JSON.stringify(new URL("../gate.cjs", import.meta.url).pathname)});
console.log("ORIGIN_GATE="+JSON.stringify({raw:process.env.RUNTIME_ALLOWED_ORIGINS??null,allowed:gate.loadConfig().allowedOrigins}));
`)
	const launch = entrypoint.replace(/launch_runtime "\$@"\s*$/, "") + `
trap - EXIT SIGTERM SIGINT SIGQUIT
RUNTIME_CODE_DIR=${JSON.stringify(root)}
FILES_INPUT_FILE="$RUNTIME_CODE_DIR/files-input"
PREPROCESSING_TOKEN_FILE="$RUNTIME_CODE_DIR/processor-token"
boot_step() { :; }
wait_for_tcp() { :; }
launch_services_for_test() {
${filesLaunch}
${gateLaunch}
wait "$FILES_PID" "$GATE_PID"
}
launch_services_for_test
`
	for (const [origins, expected, pages] of [
		["http://localhost:3203, https://*.preview.example, http://127.0.0.1:3203", ["http://localhost:3203", "https://*.preview.example", "http://127.0.0.1:3203"], "7"],
		["", [], "0"],
		[undefined, ["https://geocluster.net", "https://www.geocluster.net"], undefined],
	]) {
		const result = await new Promise((resolve) => {
			const child = spawn("bash", [], { env: { PATH: `${root}:${process.env.PATH}`, HOME: root, ...(origins === undefined ? {} : { RUNTIME_ALLOWED_ORIGINS: origins }), ...(pages === undefined ? {} : { RUNTIME_FILE_WORK_MAX_CLAIM_PAGES: pages }) }, stdio: ["pipe", "pipe", "pipe"] })
			let stdout = "", stderr = ""
			child.stdout.on("data", (bytes) => { stdout += bytes }); child.stderr.on("data", (bytes) => { stderr += bytes })
			child.on("close", (code) => resolve({ code, stdout, stderr })); child.stdin.end(launch)
		})
		assert.equal(result.code, 0, result.stderr)
		assert.match(result.stdout, new RegExp(`IMPORT_PAGES=${pages ?? "100"}\\n`))
		const observed = Object.fromEntries(result.stdout.split("\n").filter((line) => line.startsWith("ORIGIN_")).map((line) => [line.split("=")[0], JSON.parse(line.slice(line.indexOf("=") + 1))]))
		for (const service of ["ORIGIN_GATE", "ORIGIN_FILES"]) {
			assert.deepEqual(observed[service], { raw: origins ?? null, allowed: expected }, `${service} must use the deployment's one Origin setting (${JSON.stringify(origins)}).`)
		}
	}
})
