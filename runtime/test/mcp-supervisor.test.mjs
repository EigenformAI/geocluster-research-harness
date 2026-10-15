import assert from "node:assert/strict"
import { randomInt } from "node:crypto"
import { spawn } from "node:child_process"
import { once } from "node:events"
import { existsSync, readFileSync } from "node:fs"
import fs from "node:fs/promises"
import http from "node:http"
import net from "node:net"
import os from "node:os"
import path from "node:path"
import { after, test } from "node:test"
import { fileURLToPath } from "node:url"
import { loadConfig } from "../lib/config.js"
import { McpSupervisor, portOpen } from "../lib/mcp-supervisor.js"

const here = path.dirname(fileURLToPath(import.meta.url))
const FAKE_MCP = path.join(here, "fake-mcp.mjs")
const ENV_BIN = "/usr/bin/env"
const MCP_DIR = path.resolve(here, "../../geocluster-mcp")

/** Every process a test started (servers and fake workers): none may be alive at the end. */
const startedPids = new Set()

after(async () => {
	await sleep(200)
	const alive = [...startedPids].filter(isAlive)
	for (const pid of alive) {
		try {
			process.kill(pid, "SIGKILL")
		} catch {}
	}
	assert.deepEqual(alive, [], "processes left running by the tests")
})

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms))

/** Alive = /proc/<pid> exists and isn't a zombie (an orphan's reaper may be slow to collect it). */
function isAlive(pid) {
	try {
		const stat = readFileSync(`/proc/${pid}/stat`, "utf8")
		return stat.slice(stat.lastIndexOf(")") + 2, stat.lastIndexOf(")") + 3) !== "Z"
	} catch {
		return false
	}
}

async function waitFor(predicate, timeoutMs, what) {
	const deadline = Date.now() + timeoutMs
	while (Date.now() < deadline) {
		if (await predicate()) return
		await sleep(20)
	}
	assert.fail(`timed out after ${timeoutMs} ms waiting for ${what}`)
}

async function freePort() {
	// A delayed child cannot inherit the listener. Avoid the kernel's ephemeral
	// listener pool, where parallel HTTP fixtures can immediately reuse a port
	// after this probe closes and before the fake MCP binds it.
	for (let attempt = 0; attempt < 64; attempt++) {
		const server = net.createServer(), port = randomInt(20000, 30000)
		try {
			await new Promise((resolve, reject) => { server.once("error", reject); server.listen(port, "127.0.0.1", resolve) })
			await new Promise((resolve) => server.close(resolve))
			return port
		} catch (error) { if (error.code !== "EADDRINUSE") throw error }
	}
	throw new Error("No available MCP fixture port in the non-ephemeral test range")
}

function recordingLogger() {
	const lines = []
	const record = (level) => (message, extra) => lines.push({ level, message, extra })
	const logger = { lines, info: record("info"), warn: record("warn"), error: record("error"), debug: () => {} }
	logger.child = () => logger
	logger.find = (message) => lines.filter((line) => line.message === message)
	return logger
}

/** One supervisor on a free port, its fake started through /usr/bin/env with the given hooks. */
async function setup(t, { hooks = {}, configEnv = {}, opts = {}, command } = {}) {
	const dir = await fs.mkdtemp(path.join(os.tmpdir(), "mcp-sup-"))
	const port = await freePort()
	const config = loadConfig({
		PATH: process.env.PATH,
		LANG: "C.UTF-8",
		HOME: path.join(dir, "gateway-home"),
		RUNTIME_LOG_DIR: path.join(dir, "logs"),
		RUNTIME_TOOL_HOME: path.join(dir, "tool-home"),
		WORKSPACE_DIR: path.join(dir, "ws"),
		RUNTIME_STATE_ROOT: path.join(dir, "state"),
		RUNTIME_MCP_CMD: ENV_BIN,
		RUNTIME_MCP_CWD: dir,
		RUNTIME_MCP_PORT: String(port),
		RUNTIME_MCP_START_TIMEOUT_S: "10",
		RUNTIME_TREE_SNAPSHOT_MS: "100",
		// Must never reach the MCP
		IDE_LLM_TOKEN: "test-token-not-for-the-mcp",
		LLM_PROXY_URL: "http://127.0.0.1:9/proxy",
		RUNTIME_GATE_SECRET: "test-gate-secret",
		...configEnv,
	})
	const setHooks = (next) => {
		config.mcpArgs = [...Object.entries(next).map(([name, value]) => `${name}=${value}`), process.execPath, FAKE_MCP]
	}
	setHooks(hooks)
	if (command) Object.assign(config, command)
	const logger = recordingLogger()
	const sup = new McpSupervisor({ config, logger, backoffMs: [100, 150, 200, 250, 300], pollMs: 25, ...opts })
	const events = []
	for (const name of ["ready", "exit", "unavailable"]) sup.on(name, (payload) => events.push({ name, payload, at: Date.now() }))
	sup.on("ready", ({ pid }) => startedPids.add(pid))
	const spawned = () => logger.find("mcp spawned").map((line) => line.extra.pid)
	t.after(async () => {
		await sup.stop({ drainMs: 0, graceMs: 500 })
		for (const pid of spawned()) startedPids.add(pid)
		await fs.rm(dir, { recursive: true, force: true })
	})
	const mcpLog = () => fs.readFile(path.join(config.logDir, "mcp.log"), "utf8").catch(() => "")
	return { dir, port, config, logger, sup, events, setHooks, spawned, mcpLog }
}

/** A server that isn't ours on 127.0.0.1:port. */
async function foreignServer(t, port, handler) {
	const server = http.createServer(handler)
	await new Promise((resolve) => server.listen(port, "127.0.0.1", resolve))
	t.after(
		() =>
			new Promise((resolve) => {
				server.closeAllConnections?.()
				server.close(resolve)
			}),
	)
	return server
}

// ---- start / ready ---------------------------------------------------------------------------------

test("start: ready via /healthz; url, pid, state, lastHealth; idempotent; clean stop; never /mcp", async (t) => {
	const { sup, port, events, spawned, mcpLog } = await setup(t, { hooks: { FAKE_MCP_START_DELAY_MS: 300 } })
	assert.equal(sup.state, "stopped")
	assert.equal(sup.pid, null)
	assert.equal(sup.url, `http://127.0.0.1:${port}/mcp`)

	const started = Date.now()
	const pending = sup.start()
	assert.equal(sup.state, "starting")
	await pending
	assert.ok(Date.now() - started >= 280, "ready only once the server answers /healthz")
	assert.equal(sup.state, "ready")
	const pid = sup.pid
	assert.ok(pid > 0)
	assert.deepEqual(events.map((e) => e.name), ["ready"])
	assert.deepEqual(events[0].payload, { restarted: false, pid })
	assert.equal(sup.lastHealth.ok, true)
	assert.equal(sup.lastHealth.mode, "shared")
	assert.equal(sup.lastHealth.inFlight, 0)
	assert.equal(typeof sup.lastHealth.at, "number")

	assert.deepEqual(await sup.health(), { ok: true, mode: "shared", inFlight: 0 })
	await sup.start() // already ready: nothing new
	assert.equal(sup.pid, pid)
	assert.equal(spawned().length, 1)

	await sup.stop()
	assert.equal(sup.state, "stopped")
	assert.equal(sup.pid, null)
	assert.equal(isAlive(pid), false)
	assert.equal(await portOpen(port), false)
	assert.deepEqual(events.at(-1).payload, { code: 0, signal: null, expected: true })

	assert.equal(await sup.health(), null)
	assert.equal(sup.lastHealth.ok, false)

	const log = await mcpLog()
	assert.match(log, new RegExp(`mcp start pid=${pid} port=${port} \\(start\\)`))
	assert.match(log, new RegExp(`Starting Geocluster MCP on http://127\\.0\\.0\\.1:${port}/mcp`))
	assert.doesNotMatch(log, /FAKE_MCP_UNEXPECTED/, "the supervisor requested something other than /healthz")
	assert.doesNotMatch(log, /GET \/healthz/, "the supervisor's own /healthz access lines stay out of mcp.log")
	assert.match(log, /--- .* mcp start pid=\d+/)
})

test("mcp.log keeps the server's other lines, split per stream, and flushes a last line without newline", async (t) => {
	const { sup, port, mcpLog } = await setup(t)
	await sup.start()
	// A request that isn't the supervisor's: its access line stays (and the fake reports it as unexpected)
	await fetch(`http://127.0.0.1:${port}/other`).then((r) => r.text())
	await sup.stop()
	const log = await mcpLog()
	assert.match(log, /"GET \/other HTTP\/1\.1" 404 Not Found\n/)
	assert.match(log, /FAKE_MCP_UNEXPECTED GET \/other\n/)
	assert.doesNotMatch(log, /GET \/healthz/)

	// A refusal's message without a trailing newline still reaches the start error and the log
	const partial = await setup(t, { command: { mcpCommand: process.execPath, mcpArgs: ["-e", "process.stderr.write('no newline at the end'); process.exit(3)"] } })
	await assert.rejects(partial.sup.start(), /exited during start \(code 3\): no newline at the end/)
	await partial.sup.stop()
	assert.match(await partial.mcpLog(), /no newline at the end$/)
})

test("env: only the whitelist reaches the MCP, with the shared-mode values", async (t) => {
	const { dir, sup, config, port, mcpLog, setHooks } = await setup(t)
	const dump = path.join(dir, "env.json")
	setHooks({ FAKE_MCP_ENV_DUMP: dump })
	await sup.start()

	const names = JSON.parse(await fs.readFile(dump, "utf8")).filter((name) => !name.startsWith("FAKE_MCP_"))
	assert.deepEqual(names, [
		"FASTMCP_CHECK_FOR_UPDATES",
		"FASTMCP_ENV_FILE",
		"HOME",
		"LANG",
		"MCP_CACHE_MAX_MB",
		"MCP_HOST",
		"MCP_PORT",
		"MCP_TOOL_THREADS",
		"MCP_TOOL_THREADS_PER_RUN",
		"MCP_TRANSPORT",
		"MCP_WORKSPACE_ROOT",
		"NUMBA_THREADING_LAYER",
		"OPENBLAS_NUM_THREADS",
		"PATH",
		"PYTHONUNBUFFERED",
	])

	const line = (await mcpLog()).split("\n").filter((l) => l.startsWith("FAKE_MCP_ENV ")).pop()
	const env = JSON.parse(line.slice("FAKE_MCP_ENV ".length))
	assert.equal(env.HOME, config.toolHome)
	assert.equal(env.LANG, "C.UTF-8")
	assert.equal(env.MCP_TRANSPORT, "http")
	assert.equal(env.MCP_HOST, "127.0.0.1")
	assert.equal(env.MCP_PORT, String(port))
	assert.equal(env.MCP_WORKSPACE_ROOT, config.mcpWorkspaceRoot)
	assert.equal(env.MCP_CACHE_MAX_MB, "1024")
	assert.equal(env.MCP_TOOL_THREADS, "8")
	assert.equal(env.MCP_TOOL_THREADS_PER_RUN, "4")
	assert.equal(env.OPENBLAS_NUM_THREADS, "1")
	assert.equal(env.NUMBA_THREADING_LAYER, "omp")
	assert.equal(env.FASTMCP_ENV_FILE, "/nonexistent")
	assert.equal(env.FASTMCP_CHECK_FOR_UPDATES, "off")
	assert.equal(env.PYTHONUNBUFFERED, "1")
	assert.equal(env.GEOCLUSTER_RUN_DIR, undefined, "the shared server refuses GEOCLUSTER_RUN_DIR")
})

// ---- failed starts ---------------------------------------------------------------------------------

test("refusal: the start fails with the server's own message, and the next attempt is scheduled", async (t) => {
	const cases = [
		[{ GEOCLUSTER_RUN_DIR: "runs/ses_a", GEOCLUSTER_TRAINING_ENABLED: "1" }, /unset GEOCLUSTER_RUN_DIR .*; unset GEOCLUSTER_TRAINING_ENABLED/],
		[{ MCP_HOST: "0.0.0.0" }, /MCP_HOST must be a loopback address, got '0\.0\.0\.0'/],
		[{ MCP_TRANSPORT: "htp" }, /MCP_TRANSPORT must be 'sse' or 'http', got 'htp'/],
	]
	for (const [hooks, message] of cases) {
		const { sup, events, spawned } = await setup(t, { hooks })
		const error = await sup.start().then(
			() => assert.fail("start should fail"),
			(e) => e,
		)
		assert.equal(error.code, "MCP_EARLY_EXIT")
		assert.match(error.message, /exited during start \(code 2\)/)
		assert.match(error.message, message)
		assert.deepEqual(events[0].payload, { code: 2, signal: null, expected: false })
		assert.equal(sup.state, "starting", "a failed start schedules the next attempt")
		await waitFor(() => spawned().length >= 2, 2000, "the retry after a failed start")
		await sup.stop()
		const count = spawned().length
		await sleep(300) // longer than the backoff: nothing after stop()
		assert.equal(spawned().length, count)
		assert.equal(sup.state, "stopped")
	}
})

test("refusal on every attempt: more than 5 restarts → unavailable; a spawn failure fails clearly", async (t) => {
	const { sup, events, spawned, logger } = await setup(t, {
		hooks: { GEOCLUSTER_RUN_DIR: "runs/x" },
		opts: { backoffMs: [20, 30, 40, 50, 60] },
	})
	const unavailable = once(sup, "unavailable", { signal: AbortSignal.timeout(8000) })
	await assert.rejects(sup.start(), { code: "MCP_EARLY_EXIT" })
	await unavailable
	assert.equal(sup.state, "unavailable")
	assert.equal(spawned().length, 6, "the first start plus 5 restarts")
	assert.deepEqual(
		logger.find("mcp restart scheduled").map((line) => line.extra.delayMs),
		[20, 30, 40, 50, 60],
	)
	await sleep(200)
	assert.equal(spawned().length, 6, "no attempt while unavailable")
	assert.equal(events.filter((e) => e.name === "unavailable").length, 1)

	const missing = await setup(t, { command: { mcpCommand: "/nonexistent/python", mcpArgs: ["-u", "main.py"] } })
	await assert.rejects(missing.sup.start(), (error) => {
		assert.equal(error.code, "MCP_SPAWN_FAILED")
		assert.match(error.message, /could not be started \(\/nonexistent\/python\): .*ENOENT/)
		return true
	})
	await missing.sup.stop()
})

test("a foreign server on the port fails the start clearly, without spawning", async (t) => {
	const plain = await setup(t)
	await foreignServer(t, plain.port, (req, res) => {
		res.writeHead(404)
		res.end()
	})
	await assert.rejects(plain.sup.start(), (error) => {
		assert.equal(error.code, "MCP_PORT_IN_USE")
		assert.match(error.message, new RegExp(`127\\.0\\.0\\.1:${plain.port} is already in use by another process \\(its /healthz answers HTTP 404\\)`))
		return true
	})
	assert.equal(plain.spawned().length, 0)
	await plain.sup.stop()

	// Most likely in production: a shared MCP an earlier gateway left running
	const orphan = await setup(t)
	await foreignServer(t, orphan.port, (req, res) => {
		res.writeHead(200, { "content-type": "application/json" })
		res.end(JSON.stringify({ ok: true, mode: "shared", in_flight: 0 }))
	})
	await assert.rejects(orphan.sup.start(), /mode="shared", probably a shared MCP an earlier gateway left running/)
	assert.equal(orphan.spawned().length, 0)
	assert.equal(orphan.sup.lastHealth, null, "a foreign /healthz is not our health")
	await orphan.sup.stop()
})

test("a server that answers /healthz in another mode is not taken for the shared MCP", async (t) => {
	// Our own process serving SSE (mode "single"), as a wrong RUNTIME_MCP_CMD would
	const { sup, spawned, events } = await setup(t, { hooks: { MCP_TRANSPORT: "sse", MCP_HOST: "127.0.0.1" } })
	await assert.rejects(sup.start(), (error) => {
		assert.equal(error.code, "MCP_WRONG_SERVER")
		assert.match(error.message, /answered mode="single", expected "shared"/)
		return true
	})
	const [pid] = spawned()
	assert.equal(isAlive(pid), false, "the attempt stops what it spawned")
	assert.deepEqual(events.find((e) => e.name === "exit").payload, { code: 0, signal: null, expected: true })
	await sup.stop()
})

test("start timeout: the server is killed and the error quotes its output", async (t) => {
	const { sup, config, spawned } = await setup(t, { hooks: { FAKE_MCP_START_DELAY_MS: 5000 } })
	config.mcpStartTimeoutMs = 500
	await assert.rejects(sup.start(), (error) => {
		assert.equal(error.code, "MCP_START_TIMEOUT")
		assert.match(error.message, /did not answer \/healthz on port \d+ within 500 ms/)
		return true
	})
	assert.equal(isAlive(spawned()[0]), false)
	await sup.stop()
})

// ---- crashes, restarts, unavailable ------------------------------------------------------------------

test("crash: restart after the backoff, ready says restarted:true, the crashed server's workers are reaped", async (t) => {
	const { dir, sup, events, setHooks, spawned, logger } = await setup(t)
	const workerFile = path.join(dir, "worker.pid")
	setHooks({ FAKE_MCP_EXIT_AFTER_MS: 600, FAKE_MCP_WORKER_PID_FILE: workerFile })
	await sup.start()
	const firstPid = sup.pid
	const workerPid = Number(await fs.readFile(workerFile, "utf8"))
	startedPids.add(workerPid)
	assert.equal(isAlive(workerPid), true)

	// The next process must not crash: change the command before the backoff timer fires
	sup.once("exit", () => setHooks({}))
	const [exit] = await once(sup, "exit", { signal: AbortSignal.timeout(5000) })
	const exitAt = Date.now()
	assert.deepEqual(exit, { code: 1, signal: null, expected: false })
	assert.equal(sup.state, "starting")
	assert.equal(sup.pid, null)

	const [ready] = await once(sup, "ready", { signal: AbortSignal.timeout(5000) })
	assert.ok(Date.now() - exitAt >= 100, "restarted only after backoffMs[0]")
	assert.equal(ready.restarted, true)
	assert.notEqual(ready.pid, firstPid)
	assert.equal(sup.state, "ready")
	assert.deepEqual(events.map((e) => e.name), ["ready", "exit", "ready"])
	assert.deepEqual(logger.find("mcp restart scheduled")[0].extra, { delayMs: 100, why: "exited", restartsInWindow: 1 })
	assert.equal(spawned().length, 2)

	// The worker ignored SIGTERM and was re-parented when its server died: the snapshot found it
	await waitFor(() => !isAlive(workerPid), 3000, "the crashed server's worker to be reaped")
})

test("crash loop: more than 5 restarts in the window → unavailable; revive() starts again", async (t) => {
	const { sup, events, setHooks, spawned, logger } = await setup(t, {
		hooks: { FAKE_MCP_EXIT_AFTER_MS: 300 },
		opts: { backoffMs: [50, 60, 70, 80, 90] },
	})
	const unavailable = once(sup, "unavailable", { signal: AbortSignal.timeout(10000) })
	await sup.start()
	await unavailable
	assert.equal(sup.state, "unavailable")
	const readies = events.filter((e) => e.name === "ready")
	assert.equal(readies.length, 6, "the first start plus 5 restarts")
	assert.deepEqual(
		readies.map((e) => e.payload.restarted),
		[false, true, true, true, true, true],
	)
	assert.deepEqual(
		logger.find("mcp restart scheduled").map((line) => line.extra.delayMs),
		[50, 60, 70, 80, 90],
	)
	await sleep(250)
	assert.equal(spawned().length, 6, "nothing is started while unavailable")

	setHooks({})
	assert.equal(await sup.revive(), true)
	assert.equal(sup.state, "ready")
	assert.equal(events.at(-1).name, "ready")
	assert.equal(events.at(-1).payload.restarted, true)
	assert.equal(await sup.revive(), true, "revive() on a ready server is a no-op")
	assert.equal(spawned().length, 7)

	// The window was reset: the next crash is restarted again, starting from the first delay
	process.kill(sup.pid, "SIGKILL")
	await once(sup, "exit", { signal: AbortSignal.timeout(3000) })
	assert.equal(logger.find("mcp restart scheduled").at(-1).extra.delayMs, 50)
	await sup.stop()
	assert.equal(sup.state, "stopped")
	assert.equal(await sup.revive(), false, "revive() does nothing after stop()")
	assert.equal(sup.state, "stopped")
})

// ---- stop: drain, stop during start, SIGKILL ---------------------------------------------------------

test("stop drains: waits for in_flight 0, at most drainMs", async (t) => {
	const { dir, sup, setHooks, logger } = await setup(t)
	const inFlightFile = path.join(dir, "in_flight")
	await fs.writeFile(inFlightFile, "2")
	setHooks({ FAKE_MCP_IN_FLIGHT_FILE: inFlightFile })
	await sup.start()
	assert.equal(sup.lastHealth.inFlight, 2)

	// The calls finish after 400 ms: the stop waits for them, not for drainMs
	setTimeout(() => void fs.writeFile(inFlightFile, "0"), 400)
	let pid = sup.pid
	let started = Date.now()
	await sup.stop({ drainMs: 3000 })
	let elapsed = Date.now() - started
	assert.ok(elapsed >= 380 && elapsed < 2500, `drained in ${elapsed} ms`) // upper bound: no hang (loose: full-suite load)
	assert.equal(isAlive(pid), false)
	assert.equal(logger.find("mcp draining")[0].extra.inFlight, 2)
	assert.equal(logger.find("mcp drained").length, 1)

	// Calls that never finish: the stop goes ahead after drainMs
	await fs.writeFile(inFlightFile, "3")
	await sup.start()
	pid = sup.pid
	started = Date.now()
	await sup.stop({ drainMs: 600 })
	elapsed = Date.now() - started
	assert.ok(elapsed >= 600 && elapsed < 2600, `stopped after ${elapsed} ms`) // well under the 3000 ms it would wait for
	assert.equal(isAlive(pid), false)
	// Under full-suite load a /healthz poll can miss its 2 s timeout: the drain then stops waiting early
	// ("skipped"); either way the stop went ahead without the calls finishing
	const timedOut = logger.find("mcp drain timed out; stopping with tool calls in flight")[0]
	const skipped = logger.find("mcp drain skipped: /healthz not answering")[0]
	assert.ok(timedOut?.extra.inFlight === 3 || skipped, "the drain gave up on the 3 calls in flight")

	// drainMs 0 skips the drain
	await sup.start()
	started = Date.now()
	await sup.stop({ drainMs: 0 })
	assert.ok(Date.now() - started < 400)
})

test("stop during a start leaves nothing running and schedules nothing", async (t) => {
	// After the spawn: the server is still "importing"
	const spawnedCase = await setup(t, { hooks: { FAKE_MCP_START_DELAY_MS: 5000 } })
	const pending = spawnedCase.sup.start()
	await waitFor(() => spawnedCase.sup.pid !== null, 3000, "the spawn")
	const pid = spawnedCase.sup.pid
	await spawnedCase.sup.stop()
	await assert.rejects(pending, { code: "MCP_START_CANCELLED" })
	assert.equal(isAlive(pid), false)
	assert.equal(spawnedCase.sup.state, "stopped")
	assert.equal(spawnedCase.sup.pid, null)

	// Before the spawn: stop() right after start(), while the start awaits its log file and the port check
	const early = await setup(t)
	const earlyStart = early.sup.start()
	await early.sup.stop()
	await assert.rejects(earlyStart, { code: "MCP_START_CANCELLED" })
	assert.equal(early.spawned().length, 0, "nothing was spawned")
	assert.equal(early.sup.state, "stopped")

	await sleep(300) // longer than the backoff
	assert.equal(spawnedCase.spawned().length, 1)
	assert.equal(early.spawned().length, 0)
	assert.equal(await portOpen(spawnedCase.port), false)
	assert.equal(await portOpen(early.port), false)

	// start() after a stop works again
	await early.sup.start()
	assert.equal(early.sup.state, "ready")
})

test("stop escalates to SIGKILL after graceMs and reaps the workers", async (t) => {
	const { dir, sup, setHooks, logger } = await setup(t)
	const workerFile = path.join(dir, "worker.pid")
	setHooks({ FAKE_MCP_IGNORE_SIGTERM: 1, FAKE_MCP_WORKER_PID_FILE: workerFile })
	await sup.start()
	const pid = sup.pid
	const workerPid = Number(await fs.readFile(workerFile, "utf8"))
	startedPids.add(workerPid)

	const [[{ signal }]] = await Promise.all([once(sup, "exit"), sup.stop({ drainMs: 0, graceMs: 300 })])
	assert.equal(signal, "SIGKILL")
	assert.equal(isAlive(pid), false)
	// stop() resolves once the leftovers got their SIGKILL; the kernel's teardown takes a moment more
	await waitFor(() => !isAlive(workerPid), 1000, "the SIGKILLed worker to be gone")
	assert.equal(logger.find("mcp did not exit in time; killing").length, 1)
	assert.equal(logger.find("stopped processes the MCP left running")[0].extra.count, 1)
})

// ---- opt-in: the real shared geocluster MCP ------------------------------------------------------------

test(
	"real geocluster MCP: ready, /healthz mode shared, clean stop",
	{ skip: process.env.RUNTIME_TEST_REAL_MCP === "1" ? false : "set RUNTIME_TEST_REAL_MCP=1 to run", timeout: 120000 },
	async (t) => {
		const python = path.join(MCP_DIR, ".venv/bin/python")
		assert.ok(existsSync(python), `${python} missing (this test never creates or syncs the venv)`)
		const { sup, port, config, mcpLog, spawned } = await setup(t, { configEnv: { RUNTIME_MCP_START_TIMEOUT_S: "90" } })
		await fs.mkdir(config.mcpWorkspaceRoot, { recursive: true })
		await fs.mkdir(config.toolHome, { recursive: true })
		config.mcpCwd = MCP_DIR
		// No .pyc next to the sources; everything else is the production command
		config.mcpArgs = ["PYTHONDONTWRITEBYTECODE=1", python, "-u", "main.py"]

		let started = Date.now()
		await sup.start()
		const startMs = Date.now() - started
		const pid = sup.pid
		assert.deepEqual(await sup.health(), { ok: true, mode: "shared", inFlight: 0 })

		started = Date.now()
		await sup.stop()
		const stopMs = Date.now() - started
		assert.equal(isAlive(pid), false)
		assert.equal(await portOpen(port), false)
		assert.equal(spawned().length, 1)
		const log = await mcpLog()
		assert.match(log, new RegExp(`Starting Geocluster MCP on http://127\\.0\\.0\\.1:${port}/mcp`))
		assert.doesNotMatch(log, /"(GET|POST|DELETE) \/mcp/, "nothing may request /mcp")
		assert.doesNotMatch(log, /GET \/healthz/, "the supervisor's own /healthz access lines stay out of mcp.log")
		t.diagnostic(`real MCP: ready in ${startMs} ms, stopped in ${stopMs} ms`)
	},
)
