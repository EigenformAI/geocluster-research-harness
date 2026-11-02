import assert from "node:assert/strict"
import fs from "node:fs/promises"
import path from "node:path"
import { EventEmitter } from "node:events"
import { test } from "node:test"
import { setTimeout as sleep } from "node:timers/promises"
import { runNative } from "../native-tui.mjs"
import { acquireNativeProcessingLease } from "../lib/native-processing-receipts.js"
import { createNativeProcessingBridge } from "../lib/native-processing-bridge.js"

const token = "a".repeat(64)
const logger = { info() {}, error() {} }
const deferred = () => { let resolve; const promise = new Promise((done) => { resolve = done }); return { promise, resolve } }

async function fixture(t) {
	const dir = await fs.mkdtemp("/tmp/opencode/native-lifecycle-")
	t.after(() => fs.rm(dir, { recursive: true, force: true }))
	const calls = [], exited = deferred()
	const owner = { settings: { stateDir: dir, model: "extract/vision", projectId: "trusted-project" }, invocationId: "current-invocation", exited: exited.promise,
		async start() { calls.push("processor-start"); return { url: "http://127.0.0.1:4321", password: "private-password", processorToken: token } },
		async stop() { calls.push("processor-stop"); return { complete: true } } }
	return { dir, calls, owner, exited, options: { stateDir: dir, workspace: dir, engineEnv: { GEOCLUSTER_NATIVE_PROCESSING_TOKEN: "must-not-reach-engine" }, processingOwner: owner,
		mcp: { async start() { calls.push("mcp-start") }, async stop() { calls.push("mcp-stop") } }, logger, signals: new EventEmitter() } }
}

test("native lifecycle acquires writer exclusion before Python, publishes after readiness, and releases after both drains", async (t) => {
	const f = await fixture(t)
	const client = { capabilities: async () => ({ storeScope: "persistent-store", serviceGeneration: "generation" }) }
	f.owner.start = async () => {
		f.calls.push("processor-start")
		await assert.rejects(acquireNativeProcessingLease({ clientDir: path.join(f.dir, "client") }).then(async (contender) => { await contender.release(); return contender }), { code: "WRITER_IN_USE" })
		return { url: "http://127.0.0.1:4321", password: "private-password", processorToken: token }
	}
	const code = await runNative({ ...f.options,
		async acquireProcessingLease(options) { f.calls.push("lease-acquire"); return acquireNativeProcessingLease(options) },
		createProcessingClient(options) { assert.deepEqual(options, { port: 8765, token }); f.calls.push("client-create"); return client },
		async createProcessingBridge(options) {
			assert.equal(options.projectId, "trusted-project")
			assert.equal(options.invocationId, f.owner.invocationId)
			assert.equal(options.model, f.owner.settings.model)
			f.calls.push("bridge-create")
			const bridge = await createNativeProcessingBridge(options)
			return { async closeAdmission() { f.calls.push("bridge-close"); await bridge.closeAdmission() }, async drain(options) { f.calls.push("bridge-drain"); return bridge.drain(options) } }
		},
		spawnImpl(binary, args, options) {
			f.calls.push("tui-start")
			assert.equal(options.env.GEOCLUSTER_NATIVE_PROCESSING_TOKEN, undefined)
			assert.ok(!JSON.stringify(options.env).includes(token))
			const child = Object.assign(new EventEmitter(), { exitCode: 0, signalCode: null })
			process.nextTick(() => child.emit("exit", 0, null)); return child
		},
	})
	assert.equal(code, 0)
	assert.deepEqual(f.calls, ["mcp-start", "lease-acquire", "processor-start", "client-create", "bridge-create", "tui-start", "bridge-close", "bridge-drain", "processor-stop", "mcp-stop"])
	await assert.rejects(fs.stat(path.join(f.dir, "client/connection.json")), { code: "ENOENT" })
	const successor = await acquireNativeProcessingLease({ clientDir: path.join(f.dir, "client") }); await successor.release()
})

test("unexpected Python exit withdraws discovery before killing the TUI and drains before processor stop", async (t) => {
	const f = await fixture(t)
	let admissionClosed = false, drained = false
	const code = await runNative({ ...f.options,
		createProcessingClient() { return { capabilities: async () => ({ storeScope: "store", serviceGeneration: "generation" }) } },
		async createProcessingBridge(options) {
			const bridge = await createNativeProcessingBridge(options)
			return { async closeAdmission() { await bridge.closeAdmission(); admissionClosed = true; f.calls.push("bridge-close") }, async drain(options) { const result = await bridge.drain(options); drained = true; f.calls.push("bridge-drain"); return result } }
		},
		spawnImpl() {
			const child = Object.assign(new EventEmitter(), { pid: 2147483647, exitCode: null, signalCode: null,
				kill(signal) { assert.equal(admissionClosed, true); f.calls.push("tui-kill"); child.signalCode = signal; process.nextTick(() => child.emit("exit", null, signal)); return true } })
			process.nextTick(() => f.exited.resolve({ code: 1 })); return child
		},
	})
	assert.equal(code, 1)
	assert.equal(drained, true)
	assert.ok(f.calls.indexOf("bridge-close") < f.calls.indexOf("tui-kill"))
	assert.ok(f.calls.indexOf("bridge-drain") < f.calls.indexOf("processor-stop"))
	await assert.rejects(fs.stat(path.join(f.dir, "client/connection.json")), { code: "ENOENT" })
})

test("failed bridge drain still stops Python and MCP, retains writer exclusion, and reports bridge independently", async (t) => {
	const f = await fixture(t)
	let lease
	await assert.rejects(runNative({ ...f.options,
		async acquireProcessingLease(options) { lease = await acquireNativeProcessingLease(options); return lease },
		createProcessingClient() { return {} },
		async createProcessingBridge() { return { async closeAdmission() { f.calls.push("bridge-close") }, async drain() { f.calls.push("bridge-drain"); throw new Error("private-bridge-failure") } } },
		spawnImpl() { const child = Object.assign(new EventEmitter(), { exitCode: 0, signalCode: null }); process.nextTick(() => child.emit("exit", 0, null)); return child },
	}), (error) => {
		assert.equal(error.code, "cleanup_unverified")
		assert.equal(error.cleanup.leaseRetained, true)
		assert.deepEqual(error.cleanup.failures, [{ component: "bridge", code: "cleanup_unverified" }])
		assert.ok(!JSON.stringify(error).includes("private-bridge-failure")); return true
	})
	assert.deepEqual(f.calls, ["mcp-start", "processor-start", "bridge-close", "bridge-drain", "processor-stop", "mcp-stop"])
	assert.equal(lease.released, false)
	await assert.rejects(acquireNativeProcessingLease({ clientDir: lease.clientDir }), { code: "WRITER_IN_USE" })
	await lease.release() // Test bridge has no effects; production retains the failed-drain lease.
})

test("Python exit during bridge creation adopts and drains late discovery without starting a TUI", async (t) => {
	const f = await fixture(t), entered = deferred(), resume = deferred()
	const running = runNative({ ...f.options,
		createProcessingClient() { return { capabilities: async () => ({ storeScope: "store", serviceGeneration: "generation" }) } },
		async createProcessingBridge(options) { entered.resolve(); await resume.promise; return createNativeProcessingBridge(options) },
		spawnImpl() { assert.fail("owner loss during bridge startup must not start a TUI") },
	})
	await entered.promise
	f.exited.resolve({ code: 1 })
	await sleep(Math.random() * 10)
	await assert.rejects(acquireNativeProcessingLease({ clientDir: path.join(f.dir, "client") }), { code: "WRITER_IN_USE" })
	resume.resolve()
	assert.equal(await running, 1)
	await assert.rejects(fs.stat(path.join(f.dir, "client/connection.json")), { code: "ENOENT" })
	const successor = await acquireNativeProcessingLease({ clientDir: path.join(f.dir, "client") }); await successor.release()
})

test("signal races during lease acquisition retain and release the late lease without starting Python", async (t) => {
	for (let round = 0; round < 4; round++) {
		const f = await fixture(t), entered = deferred(), resume = deferred()
		const running = runNative({ ...f.options,
			async acquireProcessingLease(options) { const lease = await acquireNativeProcessingLease(options); entered.resolve(); await resume.promise; return lease },
			createProcessingBridge() { assert.fail("shutdown must not create a bridge") },
			spawnImpl() { assert.fail("shutdown must not start a TUI") },
		})
		await entered.promise
		await sleep(Math.random() * 10)
		f.options.signals.emit("SIGTERM")
		resume.resolve()
		assert.equal(await running, 130)
		assert.ok(!f.calls.includes("processor-start"))
		const successor = await acquireNativeProcessingLease({ clientDir: path.join(f.dir, "client") }); await successor.release()
	}
})
