/** Real-engine shell deadlines, without substituting the production launcher or HTTP transport. */
import assert from "node:assert/strict"
import fs from "node:fs"
import { test } from "node:test"
import { startEngine } from "./engine.mjs"
import { startFakeLlm, textOf } from "./fake-llm.mjs"

const skip = process.platform !== "linux" ? "Linux engine harness required" : !process.env.OPENCODE_BIN && "set OPENCODE_BIN to the pinned engine"
const shell = (command, options = {}) => `TOOL shell ${JSON.stringify({ command, ...options })}`

test("real engine preserves explicit shell deadlines and permits unlimited foreground compute", { skip, timeout: 180000 }, async (t) => {
	const sandbox = fs.mkdtempSync("/tmp/opencode/shell-deadlines-")
	const llm = await startFakeLlm()
	let engine
	t.after(async () => {
		await engine?.stop()
		await llm.close()
		fs.rmSync(sandbox, { recursive: true, force: true })
	})
	engine = await startEngine({ sandbox, llmUrl: llm.url })
	await engine.initialize()
	await t.test("an explicit deadline reports the shell execution boundary", async () => {
		const sid = await engine.newSession("standard")
		const turn = await engine.turn(sid, shell("sleep 2; printf 'must-not-finish'", { timeout: 100 }), { timeoutMs: 20000 })
		assert.equal(turn.error, null, JSON.stringify(turn))
		assert.equal(turn.timeout, false)
		assert.equal(turn.stopReason, "end_turn")
		const results = llm.requests.flatMap((r) => r.body?.messages ?? []).filter((m) => m.role === "tool").map((m) => textOf(m.content))
		assert.ok(results.some((text) => text.includes("Command exceeded timeout of 100 ms")))
		assert.ok(!results.some((text) => text.includes("must-not-finish\n")))
		const card = engine.frames.find((f) => f.msg?.params?.sessionId === sid && f.msg.params.update?.rawOutput?.metadata?.timeout === true)
		assert.equal(card?.msg.params.update.rawOutput.metadata.executionBoundary, "shell_runtime")
	})
	await t.test("omitted timeout allows a shell beyond the native 120-second default", {
		skip: process.env.WORKFLOW_LONG_SHELL !== "1" && "set WORKFLOW_LONG_SHELL=1 (adds 121 seconds)",
	}, async () => {
		const sid = await engine.newSession("standard")
		const turn = await engine.turn(sid, shell("sleep 121; printf 'beyond-native-default'"), { timeoutMs: 140000 })
		assert.equal(turn.error, null, JSON.stringify(turn))
		assert.equal(turn.timeout, false)
		assert.equal(turn.stopReason, "end_turn")
		assert.ok(turn.ms > 120000, JSON.stringify(turn))
		assert.match(turn.text, /beyond-native-default/)
	})
})
