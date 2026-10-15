import assert from "node:assert/strict"
import { execFile } from "node:child_process"
import { EventEmitter } from "node:events"
import { promisify } from "node:util"
import fs from "node:fs/promises"
import os from "node:os"
import path from "node:path"
import { test } from "node:test"
import { PreprocessingPair } from "../lib/preprocessing-pair.js"

const exec = promisify(execFile)
const fixture = new URL("./lifecycle-preprocessing-fixture.py", import.meta.url).pathname
for (const behavior of ["graceful", "force", "startup-force"]) test(`standalone ${behavior}: service settles before owner and parser is reaped`, { timeout: 5000 }, async () => {
	const { stdout } = await exec("python3", [fixture, behavior], { timeout: 4000, env: { PATH: process.env.PATH, PYTHONDONTWRITEBYTECODE: "1" } })
	const result = JSON.parse(stdout)
	assert.equal(result.descendantAlive, false)
	assert.equal(result.result, behavior === "graceful" ? 0 : 1)
})

test("standalone supervisor admits an owner-validated future build", { timeout: 5000 }, async () => {
	const { stdout } = await exec("python3", [fixture, "graceful", "owner-approved-future-build"], { timeout: 4000, env: { PATH: process.env.PATH, PYTHONDONTWRITEBYTECODE: "1" } })
	const result = JSON.parse(stdout)
	assert.equal(result.result, 0)
	assert.equal(result.descendantAlive, false)
})

test("rewritten descriptor for the retained instance does not launch a service", { timeout: 5000 }, async () => {
	const { stdout } = await exec("python3", [fixture, "stale"], { timeout: 4000, env: { PATH: process.env.PATH, PYTHONDONTWRITEBYTECODE: "1" } })
	assert.equal(JSON.parse(stdout).result, 0)
})

test("invalid owner handoffs remain pending without launching a service or crashing the supervisor", { timeout: 10000 }, async () => {
	for (const raw of ["[]", "null", '{"mode":"standalone","engineInstanceId":7}', '{"mode":"standalone","engineInstanceId":""}', '{"mode":"runtime","engineInstanceId":"new"}', "{" , "[".repeat(2000), "oversized"]) {
		const { stdout } = await exec("python3", [fixture, "invalid", raw], { timeout: 4000, env: { PATH: process.env.PATH, PYTHONDONTWRITEBYTECODE: "1" } })
		assert.equal(JSON.parse(stdout).result, 0)
	}
})

test("pair keeps the fifth child live, then recovers at a bounded cooldown rate", () => {
	let clock = 0, live = 0, maximumLive = 0, sequence = 0
	const timers = new Map(), children = []
	const pair = new PreprocessingPair({ command: "fixture", args: [], env: {}, backoffMs: 10, cooldownMs: 300000,
		clock: () => clock, random: () => 0, setTimer: (fn, ms) => { const id = ++sequence; timers.set(id, { fn, at: clock + ms }); return id }, clearTimer: (id) => timers.delete(id),
		spawnImpl: () => { const child = new EventEmitter(); child.stdin = new EventEmitter(); children.push(child); maximumLive = Math.max(maximumLive, ++live); return child }, logger: { warn() {} } })
	const tick = () => { assert.equal(timers.size, 1); const [id, timer] = [...timers][0]; timers.delete(id); clock = timer.at; timer.fn() }
	const exit = () => { live--; children.at(-1).emit("exit", 1) }
	pair.start()
	for (let i = 0; i < 4; i++) { pair.start(); exit(); tick() }
	assert.equal(pair.snapshot().childAlive, true)
	assert.equal(pair.snapshot().totalLaunches, 5)
	assert.equal(pair.snapshot().burstCount, 5)
	assert.equal(pair.snapshot().nextRetryAt, null)
	exit()
	assert.equal(pair.snapshot().state, "cooldown")
	assert.equal(Date.parse(pair.snapshot().nextRetryAt) - clock, 240000)
	pair.start()
	assert.equal(pair.attempts, 5)
	tick()
	assert.equal(pair.attempts, 6)
	clock += 3600000 // A long healthy interval must not replenish the fast burst.
	exit()
	assert.equal(Date.parse(pair.snapshot().nextRetryAt) - clock, 240000)
	assert.equal(maximumLive, 1)
	void pair.stop(clock + 1000)
	assert.equal(timers.size, 0)
	pair.start()
	assert.equal(pair.attempts, 6)
})

test("production recovery jitter remains within the cooldown bounds", () => {
	for (const random of [0, .5, 1]) {
		const timers = [], child = new EventEmitter()
		child.stdin = new EventEmitter()
		const recovery = new PreprocessingPair({ command: "fixture", args: [], env: {}, maxAttempts: 1, random: () => random, spawnImpl: () => child, setTimer: (_, ms) => { timers.push(ms); return 1 }, clearTimer() {}, logger: { warn() {} } })
		recovery.start(); child.emit("exit", 1)
		assert.ok(timers[0] >= 240000 && timers[0] <= 360000)
	}
})

test("a live-child error cannot launch a replacement before ownership exit", () => {
	const child = new EventEmitter(), timers = []
	child.pid = 123; child.stdin = new EventEmitter()
	const pair = new PreprocessingPair({ command: "fixture", args: [], env: {}, spawnImpl: () => child, setTimer: (fn, ms) => { timers.push({ fn, ms }); return timers.length }, logger: { warn() {} } })
	pair.start(); child.emit("error", new Error("write failed")); pair.start()
	assert.equal(pair.snapshot().childAlive, true)
	assert.equal(pair.attempts, 1)
	assert.equal(timers.length, 0)
	child.emit("exit", 1)
	assert.equal(timers.length, 1)
})

test("explicit long cooldown does not overflow Node timers into a rapid retry", () => {
	const child = new EventEmitter(), timers = []
	child.stdin = new EventEmitter()
	const pair = new PreprocessingPair({ command: "fixture", args: [], env: {}, maxAttempts: 1, cooldownMs: 3000000000, random: () => .5, spawnImpl: () => child, setTimer: (fn, ms) => { timers.push({ fn, ms }); return timers.length }, logger: { warn() {} } })
	pair.start(); child.emit("exit", 1)
	assert.equal(timers[0].ms, 2147483647)
	timers[0].fn()
	assert.equal(pair.attempts, 1)
	assert.equal(timers[1].ms, 3000000000 - 2147483647)
	timers[1].fn()
	assert.equal(pair.attempts, 2)
	const extreme = new PreprocessingPair({ command: "fixture", args: [], env: {}, maxAttempts: 1, cooldownMs: Number.MAX_SAFE_INTEGER, random: () => 1, spawnImpl: () => child, setTimer: (_, ms) => { assert.equal(ms, 2147483647); return 1 }, logger: { warn() {} } })
	extreme.start(); child.emit("exit", 1)
	assert.equal(extreme.snapshot().state, "cooldown")
})

test("jittered real-process crashes recover beyond five launches and never reopen drain", { timeout: 10000 }, async () => {
	for (let trial = 0; trial < 10; trial++) {
		const pair = new PreprocessingPair({ command: process.execPath, args: ["-e", "setTimeout(()=>process.exit(1),Math.random()*10)"], env: { PATH: process.env.PATH }, maxAttempts: 5, backoffMs: 1, cooldownMs: 15, logger: { warn() {} } })
		pair.start()
		while (pair.attempts < 7) await new Promise((r) => setTimeout(r, 2))
		await new Promise((r) => setTimeout(r, Math.random() * 20))
		const launches = pair.attempts
		await pair.stop(Date.now() + 500)
		await new Promise((r) => setTimeout(r, 40))
		assert.equal(pair.attempts, launches)
		assert.equal(pair.child, null)
		assert.equal(pair.snapshot().nextRetryAt, null)
	}
})

test("root observer ignores symlink targets and reports incomplete bounded accounting", async (t) => {
	const dir = await fs.mkdtemp(path.join(os.tmpdir(), "lifecycle-storage-"))
	t.after(() => fs.rm(dir, { recursive: true, force: true }))
	await fs.mkdir(path.join(dir, "data"))
	await fs.writeFile(path.join(dir, "data/input"), "12345")
	await fs.writeFile(path.join(dir, "outside"), "x".repeat(10000))
	await fs.symlink(path.join(dir, "outside"), path.join(dir, "data/link"))
	const script = new URL("../root-storage.py", import.meta.url).pathname
	const { stdout } = await exec("python3", [script, path.join(dir, "data")])
	const result = JSON.parse(stdout)
	assert.equal(result.processorDataBytes, 5)
	assert.equal(result.symlinksSkipped, 1)
	assert.equal(result.complete, false)
	assert.ok(result.diskFreeBytes > 0)
	const bounded = await exec("python3", ["-c", "import importlib.util,json,sys; s=importlib.util.spec_from_file_location('storage',sys.argv[1]); m=importlib.util.module_from_spec(s); s.loader.exec_module(m); print(json.dumps(m.scan(sys.argv[2],max_entries=1)))", script, path.join(dir, "data")], { env: { PATH: process.env.PATH, PYTHONDONTWRITEBYTECODE: "1" } })
	assert.equal(JSON.parse(bounded.stdout).entries, 1)
	assert.equal(JSON.parse(bounded.stdout).complete, false)
})
