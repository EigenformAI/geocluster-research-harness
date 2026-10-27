import assert from "node:assert/strict"
import fs from "node:fs/promises"
import path from "node:path"
import { spawn, spawnSync } from "node:child_process"
import { EventEmitter } from "node:events"
import { test } from "node:test"

const root = new URL("../../", import.meta.url).pathname
const ptyRunner = "import os,pty,subprocess,sys; m,s=pty.openpty(); p=subprocess.run(sys.argv[1:],stdin=s,stdout=s,stderr=s); os.close(s); output=b'';\nwhile True:\n try: output+=os.read(m,65536)\n except OSError: break\nsys.stdout.buffer.write(output); sys.exit(p.returncode)"
const processorToken = "a".repeat(64)
function processingHooks(dir, owner) {
	owner.settings = { stateDir: dir, model: "extract/vision", projectId: "project" }
	owner.invocationId = "test-invocation"
	return {
		async acquireProcessingLease() { return { released: false, async release() { this.released = true } } },
		createProcessingClient() { return {} },
		async createProcessingBridge() { return { async closeAdmission() {}, async drain() { return { complete: true } } } },
	}
}

test("native processing selection is explicit, preserves slash IDs and variants, and never follows chat selection", async () => {
	const { nativeProcessingSettings } = await import("../native-processing-settings.mjs")
	assert.equal(nativeProcessingSettings({ PREPROCESSING_MODEL: "proxy/managed", OPENCODE_MODEL: "chat/model" }), undefined)
	assert.deepEqual(nativeProcessingSettings({ RUNTIME_NATIVE_PROCESSING_MODEL: "second-maker/a/b#high", OPENCODE_MODEL: "chat/model" }), { model: "second-maker/a/b#high" })
	assert.deepEqual(nativeProcessingSettings({ RUNTIME_NATIVE_PROCESSING_MODEL: "local/vision", RUNTIME_NATIVE_PROCESSING_ENGINE_DESCRIPTOR: "/private/engine.json" }), { model: "local/vision", descriptorPath: "/private/engine.json" })
	assert.throws(() => nativeProcessingSettings({ RUNTIME_NATIVE_PROCESSING_ENGINE_DESCRIPTOR: "/private/engine.json" }), /requires.*processing.*model/i)
	for (const model of ["provider", "/model", "provider/", "provider/model#", "provider/model#one#two", "provider/a\nb", "provider/a b", "provider/model#bad variant"]) {
		assert.throws(() => nativeProcessingSettings({ RUNTIME_NATIVE_PROCESSING_MODEL: model }), /processing model/i, model)
	}
})

test("native launch handoff keeps processing settings and external authority out of engine environment", async (t) => {
	const { prepareNativeLaunch } = await import("../native-processing-settings.mjs")
	const dir = await fs.mkdtemp("/tmp/opencode/native-processing-launch-")
	t.after(() => fs.rm(dir, { recursive: true, force: true }))
	const source = { OPENROUTER_API_KEY: "explicit-engine-key", RUNTIME_NATIVE_ENGINE_ENV: "OPENROUTER_API_KEY", RUNTIME_NATIVE_PROCESSING_MODEL: "independent/vision#high", IDE_LLM_TOKEN: "stale-managed-token" }
	const options = { stateDir: path.join(dir, "opencode"), processingRoot: path.join(dir, "processing"), configDir: path.join(root, "opencode/config/native") }
	const launch = await prepareNativeLaunch(source, options)
	assert.equal(launch.engineEnv.OPENROUTER_API_KEY, source.OPENROUTER_API_KEY)
	assert.equal(launch.engineEnv.IDE_LLM_TOKEN, undefined)
	assert.equal(launch.engineEnv.RUNTIME_NATIVE_PROCESSING_MODEL, undefined)
	assert.equal(launch.engineEnv.GEOCLUSTER_NATIVE_PROCESSING_TOKEN, undefined)
	assert.equal(launch.processing.model, "independent/vision#high")
	assert.equal(launch.processing.stateDir, options.processingRoot)
	const config = JSON.parse(await fs.readFile(launch.engineEnv.OPENCODE_CONFIG, "utf8"))
	assert.equal(config.mcp.servers.processor, undefined)
	assert.ok(config.plugins.includes("./plugins/processing-agent"))
	assert.equal(launch.engineEnv.GEOCLUSTER_PROCESSING_MODE, "native")
	assert.equal(launch.engineEnv.GEOCLUSTER_PROCESSING_CLIENT_DIR, path.join(options.processingRoot, "client"))
	const descriptorPath = path.join(dir, "borrowed.json")
	await fs.writeFile(descriptorPath, JSON.stringify({ serverUrl: "https://engine.invalid", password: "external-authority" }), { mode: 0o600 })
	const borrowed = await prepareNativeLaunch({ ...source, RUNTIME_NATIVE_PROCESSING_ENGINE_DESCRIPTOR: descriptorPath }, options)
	assert.equal(borrowed.processing.engineDescriptor.password, "external-authority")
	assert.ok(!JSON.stringify(borrowed.engineEnv).includes("external-authority"))
	const link = path.join(dir, "linked.json")
	await fs.symlink(descriptorPath, link)
	await assert.rejects(prepareNativeLaunch({ ...source, RUNTIME_NATIVE_PROCESSING_ENGINE_DESCRIPTOR: link }, options), /regular|symlink|descriptor/i)
	const fifo = path.join(dir, "pipe.json")
	assert.equal(spawnSync("mkfifo", [fifo]).status, 0)
	await assert.rejects(prepareNativeLaunch({ ...source, RUNTIME_NATIVE_PROCESSING_ENGINE_DESCRIPTOR: fifo }, options), /regular|descriptor/i)
	await fs.writeFile(descriptorPath, " ".repeat(4 * 1024 * 1024 + 1))
	await assert.rejects(prepareNativeLaunch({ ...source, RUNTIME_NATIVE_PROCESSING_ENGINE_DESCRIPTOR: descriptorPath }, options), /bound|large|descriptor/i)
})

test("native processing attaches the TUI only after service readiness and drains the owner before MCP", async (t) => {
	const { runNative } = await import("../native-tui.mjs")
	const dir = await fs.mkdtemp("/tmp/opencode/native-processing-supervisor-")
	t.after(() => fs.rm(dir, { recursive: true, force: true }))
	const calls = []
	const processingOwner = {
		exited: new Promise(() => {}),
		async start() { calls.push("processing-ready"); return { url: "http://127.0.0.1:4321", password: "private-server-password", processorToken } },
		async stop({ deadlineMs }) { assert.ok(deadlineMs > Date.now()); calls.push("processing-drained") },
	}
	const code = await runNative({ ...processingHooks(dir, processingOwner), stateDir: dir, workspace: dir, engineEnv: { PATH: process.env.PATH }, processingOwner,
		mcp: { async start() { calls.push("mcp-ready") }, async stop() { calls.push("mcp-stopped") } },
		logger: { info() {}, error() {} }, signals: new EventEmitter(),
		spawnImpl(binary, args, options) {
			assert.deepEqual(calls, ["mcp-ready", "processing-ready"])
			assert.deepEqual(args, ["--server", "http://127.0.0.1:4321", dir])
			assert.equal(options.env.OPENCODE_PASSWORD, "private-server-password")
			assert.ok(!args.includes("private-server-password"))
			return spawn(process.execPath, ["-e", "process.exit(23)"], options)
		},
	})
	assert.equal(code, 23)
	assert.deepEqual(calls, ["mcp-ready", "processing-ready", "processing-drained", "mcp-stopped"])
})

test("a borrowed processing harness does not change the native conversation provider or server lifecycle", async (t) => {
	const { runNative } = await import("../native-tui.mjs")
	const dir = await fs.mkdtemp("/tmp/opencode/native-processing-borrowed-")
	t.after(() => fs.rm(dir, { recursive: true, force: true }))
	const processingOwner = { exited: new Promise(() => {}), async start() { return { borrowed: true, processorToken } }, async stop() {} }
	assert.equal(await runNative({ ...processingHooks(dir, processingOwner), stateDir: dir, workspace: dir, engineEnv: { PATH: process.env.PATH, OPENAI_API_KEY: "chat-only-key" }, processingOwner,
		mcp: { async start() {}, async stop() {} }, logger: { info() {}, error() {} }, signals: new EventEmitter(),
		spawnImpl(binary, args, options) {
			assert.deepEqual(args, ["--standalone", dir])
			assert.equal(options.env.OPENAI_API_KEY, "chat-only-key")
			assert.equal(options.env.GEOCLUSTER_NATIVE_PROCESSING_TOKEN, undefined)
			assert.equal(options.env.OPENCODE_PASSWORD, undefined)
			return spawn(process.execPath, ["-e", "process.exit(0)"], options)
		},
	}), 0)
})

test("processing owner failure ends the opted-in TUI nonzero and still cleans dependencies", async (t) => {
	const { runNative } = await import("../native-tui.mjs")
	const dir = await fs.mkdtemp("/tmp/opencode/native-processing-failure-")
	t.after(() => fs.rm(dir, { recursive: true, force: true }))
	let fail, stopped = false, mcpStopped = false
	const signals = new EventEmitter()
	const fallback = setTimeout(() => signals.emit("SIGTERM"), 300)
	t.after(() => clearTimeout(fallback))
	const processingOwner = { exited: new Promise((resolve) => { fail = resolve }), async start() { return { url: "http://127.0.0.1:4321", password: "private", processorToken } }, async stop() { stopped = true } }
	const code = await runNative({ ...processingHooks(dir, processingOwner), stateDir: dir, workspace: dir, engineEnv: { PATH: process.env.PATH }, processingOwner,
		mcp: { async start() {}, async stop() { mcpStopped = true } }, logger: { info() {}, error() {} }, signals,
		spawnImpl(binary, args, options) { const child = spawn(process.execPath, ["-e", "setInterval(()=>{},1000)"], options); setTimeout(() => fail({ code: 1 }), 30); return child },
	})
	assert.equal(code, 1)
	assert.ok(stopped && mcpStopped)
})

test("startup cause stays primary while independent processor and MCP cleanup failures are aggregated", async (t) => {
	const { runNative } = await import("../native-tui.mjs")
	const dir = await fs.mkdtemp("/tmp/opencode/native-startup-cleanup-")
	t.after(() => fs.rm(dir, { recursive: true, force: true }))
	const primary = Object.assign(new Error("selected model unavailable"), { code: "selected_model_unavailable" })
	const calls = [], logs = []
	const signals = new EventEmitter()
	const processingOwner = { async start() { throw primary }, async stop() { calls.push("processor"); throw new Error("processor-secret") } }
	await assert.rejects(runNative({ ...processingHooks(dir, processingOwner), stateDir: dir, workspace: dir, engineEnv: {}, signals, processingOwner,
		mcp: { async start() {}, async stop() { calls.push("mcp"); throw new Error("mcp-secret") } },
		logger: { info() {}, error(message, fields) { logs.push({ message, fields }) } },
		spawnImpl() { assert.fail("failed startup must not launch a TUI") },
	}), (error) => {
		assert.equal(error, primary)
		assert.equal(error.cleanup.complete, false)
		assert.deepEqual(error.cleanup.failures.map((failure) => failure.component), ["processor", "mcp"])
		assert.ok(!JSON.stringify(error).includes("secret"))
		return true
	})
	assert.deepEqual(calls, ["processor", "mcp"])
	assert.equal(signals.listenerCount("SIGTERM"), 0)
	assert.ok(!JSON.stringify(logs).includes("secret"))
})

test("cleanup-only failure fails a successful native command", async (t) => {
	const { runNative } = await import("../native-tui.mjs")
	const dir = await fs.mkdtemp("/tmp/opencode/native-cleanup-only-")
	t.after(() => fs.rm(dir, { recursive: true, force: true }))
	await assert.rejects(runNative({ stateDir: dir, workspace: dir, engineEnv: {}, signals: new EventEmitter(),
		mcp: { async start() {}, async stop() { throw new Error("mcp-secret") } }, logger: { info() {}, error() {} },
		spawnImpl(binary, args, options) { return spawn(process.execPath, ["-e", "process.exit(0)"], options) },
	}), (error) => error.code === "cleanup_unverified" && error.cleanup.complete === false && !error.message.includes("secret"))
})

test("engine cleanup failure cannot skip processor or MCP cleanup or mask the runtime error", async (t) => {
	const { runNative } = await import("../native-tui.mjs")
	const dir = await fs.mkdtemp("/tmp/opencode/native-engine-cleanup-")
	t.after(() => fs.rm(dir, { recursive: true, force: true }))
	const primary = new Error("runtime failed"), calls = []
	const processingOwner = { exited: new Promise(() => {}), async start() { return { borrowed: true, processorToken } }, async stop() { calls.push("processor"); throw new Error("processor-secret") } }
	await assert.rejects(runNative({ ...processingHooks(dir, processingOwner), stateDir: dir, workspace: dir, engineEnv: {}, signals: new EventEmitter(), processingOwner,
		mcp: { async start() {}, async stop() { calls.push("mcp"); throw new Error("mcp-secret") } }, logger: { info() {}, error() {} },
		spawnImpl() {
			const child = Object.assign(new EventEmitter(), { pid: 2147483647, exitCode: null, signalCode: null,
				kill() { calls.push("engine"); throw new Error("engine-secret") } })
			process.nextTick(() => child.emit("error", primary))
			return child
		},
	}), (error) => {
		assert.equal(error, primary)
		assert.deepEqual(error.cleanup.failures.map(({ component }) => component), ["engine", "processor", "mcp"])
		return true
	})
	assert.deepEqual(calls, ["engine", "processor", "mcp"])
})

test("host helper explicitly forwards processing choice and mounts only an explicitly selected external descriptor", async (t) => {
	const dir = await fs.mkdtemp("/tmp/opencode/native-processing-helper-")
	t.after(() => fs.rm(dir, { recursive: true, force: true }))
	await fs.writeFile(path.join(dir, "docker"), '#!/bin/sh\nprintf "%s\\n" "$@" > "$CAPTURE"\n', { mode: 0o755 })
	const descriptor = path.join(dir, "external.json")
	await fs.writeFile(descriptor, '{"password":"do-not-copy-to-argv"}')
	const env = { PATH: `${dir}:${process.env.PATH}`, CAPTURE: path.join(dir, "args") }
	const helper = path.join(root, "scripts/run-runtime-tui.sh")
	const invalid = spawnSync("python3", ["-c", ptyRunner, "bash", helper, "--processing-engine-descriptor", descriptor], { env, encoding: "utf8", timeout: 5000 })
	assert.equal(invalid.status, 2)
	assert.match(invalid.stdout, /requires.*processing.*model/i)
	for (const external of [false, true]) {
		const args = ["-c", ptyRunner, "bash", helper, "--processing-model", "separate/a/b#high", ...(external ? ["--processing-engine-descriptor", descriptor] : [])]
		const result = spawnSync("python3", args, { env, encoding: "utf8", timeout: 5000 })
		assert.equal(result.status, 0, result.stdout + result.stderr)
		const capture = await fs.readFile(env.CAPTURE, "utf8")
		assert.match(capture, /RUNTIME_NATIVE_PROCESSING_MODEL=separate\/a\/b#high/)
		assert.equal(capture.includes("RUNTIME_NATIVE_PROCESSING_ENGINE_DESCRIPTOR="), external)
		assert.equal(capture.includes(`src=${descriptor}`), external)
		assert.ok(!capture.includes("do-not-copy-to-argv"))
	}
})
