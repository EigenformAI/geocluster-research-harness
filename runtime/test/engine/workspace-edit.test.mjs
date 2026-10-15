/** Real pinned-engine A4 regression: ACP approves the original workspace write, not a redirected artifact.
 * Run: OPENCODE_BIN=/path/to/opencode node --test runtime/test/engine/workspace-edit.test.mjs
 * This uses the shipped config and plugins unchanged in a sandbox, with a scripted provider and no cloud calls.
 */
import assert from "node:assert/strict"
import fs from "node:fs"
import os from "node:os"
import path from "node:path"
import { test } from "node:test"
import { OPENCODE_VERSION } from "../../../opencode/scripts/build-config.mjs"
import { startEngine } from "./engine.mjs"
import { startFakeLlm } from "./fake-llm.mjs"

const bin = process.env.OPENCODE_BIN
const skip = process.platform !== "linux" || !bin ? `Linux and OPENCODE_BIN (pinned ${OPENCODE_VERSION}) required` : false
const write = (file, content = "approved contents\n") => `TOOL write ${JSON.stringify({ path: file, content })}`
const specialist = (directive) => `DELEGATE orchestrator DELEGATE transform ${directive}`

test("A4 real engine: exact workspace edit approval, automatic run output and protected destinations", { skip, timeout: 120000 }, async (t) => {
	const sandbox = fs.mkdtempSync(path.join(os.tmpdir(), "gc-workspace-edit-"))
	let engine, llm
	t.after(async () => {
		await engine?.stop()
		await llm?.close()
		fs.rmSync(sandbox, { recursive: true, force: true })
	})
	llm = await startFakeLlm()
	engine = await startEngine({ sandbox, llmUrl: llm.url, bin })
	const init = await engine.initialize()
	assert.equal(init.agentInfo.version, OPENCODE_VERSION, "verify the pinned hook semantics, not a different installed CLI")
	const ws = engine.paths.ws
	let answer = "allow_once"
	const asked = []
	engine.onRequest((msg, fallback) => {
		if (msg.method !== "session/request_permission") return fallback(msg)
		asked.push(msg.params)
		if (typeof answer === "function") return answer(msg.params)
		const option = msg.params.options.find((o) => o.kind === answer)
		assert.ok(option, `missing ${answer} option`)
		return { outcome: { outcome: "selected", optionId: option.optionId } }
	})
	const complete = async (sid, prompt) => {
		const turn = await engine.turn(sid, prompt, { timeoutMs: 20000 })
		assert.equal(turn.timeout, false, JSON.stringify(turn))
		assert.equal(turn.error, null, JSON.stringify(turn))
		return turn
	}

	await t.test("specialist and standard saves ask once, preserve the file while pending, then write the exact path", async () => {
		for (const mode of ["geology", "standard"]) {
			const sid = await engine.newSession(mode)
			const file = `Requested ${mode}/new/deep/summary.md`
			fs.mkdirSync(path.dirname(path.join(ws, file)), { recursive: true })
			fs.writeFileSync(path.join(ws, file), "original contents\n")
			const before = asked.length
			answer = async (params) => {
				assert.equal(params.sessionId, sid, "specialist approval is requested on the root conversation")
				assert.equal(fs.readFileSync(path.join(ws, file), "utf8"), "original contents\n", "no mutation before approval")
				assert.match(JSON.stringify(params.toolCall), /summary\.md/, "the approval describes the requested file")
				const option = params.options.find((o) => o.kind === "allow_once")
				return { outcome: { outcome: "selected", optionId: option.optionId } }
			}
			const tool = write(path.join(ws, file))
			assert.equal((await complete(sid, mode === "geology" ? specialist(tool) : tool)).stopReason, "end_turn")
			assert.equal(asked.length, before + 1, "one edit approval, no post-approval refusal")
			assert.equal(fs.readFileSync(path.join(ws, file), "utf8"), "approved contents\n")
			assert.equal(fs.existsSync(path.join(ws, `runs/${sid}/results/summary.md`)), false, "no redirected save")
		}
	})

	await t.test("automatic own-run output needs no approval and can create missing parents", async () => {
		const sid = await engine.newSession("geology")
		const file = `runs/${sid}/results/new/deep/automatic.md`
		const before = asked.length
		answer = "reject_once" // any accidental approval request prevents the write
		assert.equal((await complete(sid, specialist(write(file)))).stopReason, "end_turn")
		assert.equal(asked.length, before)
		assert.equal(fs.readFileSync(path.join(ws, file), "utf8"), "approved contents\n")
	})

	await t.test("rejected and cancelled workspace requests do not create a file", async () => {
		for (const mode of ["geology", "standard"]) {
			for (const cancelled of [false, true]) {
				const sid = await engine.newSession(mode)
				const file = `refused/${mode}-${cancelled}.md`
				const before = asked.length
				answer = cancelled ? () => ({ outcome: { outcome: "cancelled" } }) : "reject_once"
				const tool = write(file)
				await complete(sid, mode === "geology" ? specialist(tool) : tool)
				assert.equal(asked.length, before + 1)
				assert.equal(fs.existsSync(path.join(ws, file)), false)
			}
		}
	})

	await t.test("standard cannot approve private state, own records, any foreign run or symlink escapes", async () => {
		const sid = await engine.newSession("standard")
		const foreign = await engine.newSession("standard")
		fs.mkdirSync(path.join(ws, ".runtime"), { recursive: true })
		fs.mkdirSync(path.join(ws, `runs/${foreign}`), { recursive: true })
		fs.symlinkSync(".runtime", path.join(ws, "private-alias"))
		fs.symlinkSync(`runs/${foreign}`, path.join(ws, "foreign-alias"))
		const external = path.join(sandbox, "outside")
		fs.mkdirSync(external)
		fs.symlinkSync(external, path.join(ws, "outside-alias"))
		answer = "allow_once" // protected destinations must not even reach approval
		for (const file of [".env", "notes/.env.local", ".runtime/blocked.md", `runs/${sid}/_orchestrator/blocked.md`, `runs/${foreign}/blocked.md`, "runs/unlisted/blocked.md", "private-alias/new/deep/blocked.md", "foreign-alias/new/deep/blocked.md", "outside-alias/new/deep/blocked.md"]) {
			const before = asked.length
			await complete(sid, write(file))
			assert.equal(asked.length, before, file)
			assert.equal(fs.existsSync(path.join(ws, file)), false, file)
		}
	})

	await t.test("geology, report-analysis and orchestrator still have no write tool", async () => {
		for (const mode of ["geology", "report-analysis"]) {
			const sid = await engine.newSession(mode)
			const file = `${mode}-must-not-write.md`
			const before = asked.length
			await complete(sid, write(file))
			assert.equal(fs.existsSync(path.join(ws, file)), false)
			assert.equal(asked.length, before)
		}
		const sid = await engine.newSession("geology")
		const before = asked.length
		await complete(sid, `DELEGATE orchestrator ${write("orchestrator-must-not-write.md")}`)
		assert.equal(fs.existsSync(path.join(ws, "orchestrator-must-not-write.md")), false)
		assert.equal(asked.length, before)
		for (const call of llm.agentCalls().filter((r) => ["geology", "report-analysis", "orchestrator"].includes(r.agent))) {
			assert.ok(!call.tools.includes("write") && !call.tools.includes("edit"), `${call.agent}: writes not offered`)
		}
	})
})
