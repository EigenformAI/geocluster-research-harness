/** A3: real pinned engine + real Poppler + scripted provider; proves transport, not model intelligence.
 * Run: OPENCODE_BIN=/path/to/opencode node --test runtime/test/engine/pdf-read.test.mjs
 * On hosts without /usr/bin Poppler, set PDFTOTEXT_TEST_BIN=/absolute/path/to/pdftotext (pdfinfo beside it).
 * Only the sandbox plugin's subprocess adapter changes; the production hook and binary paths are untouched.
 * Pin source: anomalyco/opencode@1fd016ef32286de9489b7b24f1029f52c49a27b3, packages/core/src/tool.ts:
 * executeTool awaits execute.after, then reads afterEvent.result.content/output/metadata, including replacement.
 */
import assert from "node:assert/strict"
import fs from "node:fs"
import os from "node:os"
import path from "node:path"
import { test } from "node:test"
import { OPENCODE_VERSION } from "../../../opencode/scripts/build-config.mjs"
import { findFabricatedCitations } from "../../lib/citation-guard.js"
import { TurnTracker } from "../../lib/turn-tracker.js"
import { startEngine } from "./engine.mjs"
import { plan, startFakeLlm, textOf } from "./fake-llm.mjs"
import { malformedPdf, PDF_TEXT, tinyPdf } from "./pdf-fixture.mjs"

const bin = process.env.OPENCODE_BIN
const poppler = process.env.PDFTOTEXT_TEST_BIN ?? "/usr/bin/pdftotext"
const executable = (file) => {
	try { fs.accessSync(file, fs.constants.X_OK); return fs.statSync(file).isFile() } catch { return false }
}
const how = "OPENCODE_BIN=/path/to/opencode PDFTOTEXT_TEST_BIN=/path/to/pdftotext node --test runtime/test/engine/pdf-read.test.mjs"
const skip = process.platform !== "linux" ? `Linux required; ${how}`
	: !bin || !executable(bin) ? `executable OPENCODE_BIN (pinned ${OPENCODE_VERSION}) required; ${how}`
		: !executable(poppler) || !executable(path.join(path.dirname(poppler), "pdfinfo")) ? `real Poppler utilities required; ${how}` : false
const read = (file, paging = {}) => `TOOL read ${JSON.stringify({ path: file, ...paging })}`
const lastUser = (body) => textOf([...body.messages].reverse().find((m) => m.role === "user")?.content)
const placeholder = /PDF read successfully|data:application\/pdf|base64|%PDF-/
const acpText = (update) => (update.content ?? []).map((part) => part.content?.type === "text" ? part.content.text : "").join("\n")

function sandboxPlugins() {
	// Red control: remove only the sandbox copy of the hook to reproduce the shipped engine's unread PDF result.
	if (process.env.PDF_READ_TEST_BASELINE === "1") return { "pdf-read.js": null }
	if (poppler === "/usr/bin/pdftotext") return {}
	return { "pdf-read.js": `
import { spawn } from "node:child_process"
import path from "node:path"
import { setup, runPdfToText } from "../lib/pdf-read.js"
export default { id: "geocluster-pdf-read", setup: (ctx) => setup(ctx, {
  runner: (bytes) => runPdfToText(bytes, {
    spawnProcess: (bin, args, options) => spawn(path.join(${JSON.stringify(path.dirname(poppler))}, path.basename(bin)), args, options),
  }),
}) }
` }
}

test("A3 real engine: PDF text, continuation, failed extraction evidence, and existing read permissions", { skip, timeout: 120000 }, async (t) => {
	const sandbox = fs.mkdtempSync(path.join(os.tmpdir(), "gc-pdf-read-"))
	let engine, llm
	t.after(async () => {
		const stopped = await engine?.stop()
		await llm?.close()
		fs.rmSync(sandbox, { recursive: true, force: true })
		if (stopped) assert.deepEqual(stopped.tree.filter((p) => p.alive), [], "no orphan engine or converter")
	})
	llm = await startFakeLlm()
	engine = await startEngine({ sandbox, llmUrl: llm.url, bin, extraPlugins: sandboxPlugins() })
	assert.equal((await engine.initialize()).agentInfo.version, OPENCODE_VERSION, "test the pinned result-hook semantics")
	const ws = engine.paths.ws
	fs.writeFileSync(path.join(ws, "original.pdf"), tinyPdf())
	fs.writeFileSync(path.join(ws, "scanned.pdf"), tinyPdf("scanned"))
	fs.writeFileSync(path.join(ws, "malformed.pdf"), malformedPdf())
	fs.writeFileSync(path.join(ws, "notes.txt"), "plain-text read remains available\nsecond line\n")
	fs.writeFileSync(path.join(ws, "assays.csv"), "HOLE_ID,AU_PPM\nHOLE_1,2.4\n")
	fs.writeFileSync(path.join(ws, ".env"), "SECRET=must-not-reach-model\n")
	const permissions = []
	engine.onRequest((msg, fallback) => {
		if (msg.method !== "session/request_permission") return fallback(msg)
		permissions.push(msg.params)
		return { outcome: { outcome: "cancelled" } } // reads must follow the shipped allow/deny rules, never ask
	})
	const runRead = async (mode, file, paging = {}, model) => {
		const delegated = mode === "orchestrator"
		const sid = await engine.newSession(delegated ? "geology" : mode, model)
		const prompt = `${delegated ? "DELEGATE orchestrator " : ""}${read(file, paging)}`
		const turn = await engine.turn(sid, prompt, { timeoutMs: 20000 })
		assert.equal(turn.timeout, false, JSON.stringify(turn))
		assert.equal(turn.error, null, JSON.stringify(turn))
		const rootUpdates = engine.updates(sid, turn)
		const children = engine.childUpdates(sid, turn)
		const updates = delegated ? children.filter((f) => f.depth === 1 && f.type === "update").map((f) => f.update) : rootUpdates
		const start = updates.find((u) => u.sessionUpdate === "tool_call" && u.kind === "read")
		assert.ok(start, `${mode}: real read tool called`)
		const terminals = updates.filter((u) => u.toolCallId === start.toolCallId && ["failed", "completed"].includes(u.status))
		const tracker = new TurnTracker({ cwd: ws })
		tracker.beginTurn()
		for (const u of rootUpdates) tracker.onUpdate(u)
		for (const f of children) tracker.onChild({ ...f, child: { sessionId: f.childSessionId, depth: f.depth } })
		// Root session identity is exact here; prompt wording can change independently of fake-llm's role signatures.
		const requests = llm.agentCalls().filter((r) => r.session === sid && (!delegated || r.agent === "orchestrator"))
		assert.ok(requests[0]?.tools.includes("read"), `${mode}: read offered by the shipped permission rules`)
		const after = requests.find((r) => r.body.messages.at(-1)?.role === "tool")
		assert.ok(after, `${mode}: tool result reached the scripted provider`)
		return { sid, turn, terminals, tracker, requests, modelText: textOf(after.body.messages.at(-1).content) }
	}

	await t.test("authorized two-page PDF reaches a text-only model and ACP as page-labelled text; original citation is grounded", async (st) => {
		llm.intercept = (body) => {
			const base = plan(body)
			if (base.aux || base.lastRole !== "tool" || !lastUser(body).includes('"original.pdf"')) return undefined
			const evidence = textOf(body.messages.at(-1).content)
			return { ...base, kind: "text", text: PDF_TEXT.every((text) => evidence.includes(text))
				? "Ore grade 2.4 g/t [source: original.pdf | p:1]. Reserve 18 Mt [source: original.pdf | p:2]."
				: "No extracted evidence reached the model." }
		}
		try {
			const r = await runRead("report-analysis", "original.pdf")
			assert.equal(r.turn.stopReason, "end_turn")
			assert.deepEqual(r.terminals.map((u) => u.status), ["completed"])
			for (const text of [r.modelText, acpText(r.terminals[0])]) {
				assert.match(text, /\[Page 1\][\s\S]*TEXT page one: Ore grade 2\.4 g\/t[\s\S]*\[Page 2\][\s\S]*TEXT page two: Reserve 18 Mt/)
				assert.doesNotMatch(text, placeholder)
			}
			assert.doesNotMatch(JSON.stringify(r.terminals[0]), placeholder, "ACP raw output has no PDF binary either")
			assert.ok(r.tracker.reads.has(path.join(ws, "original.pdf")))
			assert.match(r.tracker.answer(), /2\.4 g\/t \[source: original\.pdf \| p:1\]/)
			assert.match(r.tracker.answer(), /18 Mt \[source: original\.pdf \| p:2\]/)
			assert.deepEqual(findFabricatedCitations(r.tracker.answer(), r.tracker.reads), [])
			assert.equal(permissions.length, 0)
			st.diagnostic("real read → Poppler → model request + ACP text → original.pdf read ledger and citations")
		} finally { llm.intercept = null }
	})

	await t.test("offset/limit continuation has stable numbered lines with no repeated or skipped evidence", async () => {
		const full = await runRead("report-analysis", "original.pdf")
		const numbered = (text) => [...text.matchAll(/^(\d+): (.*)$/gm)].map((m) => `${m[1]}: ${m[2]}`)
		const expected = numbered(full.modelText)
		assert.ok(expected.length >= 4, "both page markers and both text rows")
		const recovered = []
		let offset = 1
		for (let i = 0; i < 10; i++) {
			const r = await runRead("report-analysis", "original.pdf", { offset, limit: 2 })
			assert.deepEqual(r.terminals.map((u) => u.status), ["completed"])
			const rows = numbered(r.modelText)
			assert.ok(rows.length > 0 && rows.length <= 2)
			assert.deepEqual(numbered(acpText(r.terminals[0])), rows)
			assert.equal(Number(rows[0].split(":")[0]), offset)
			recovered.push(...rows)
			const next = /Continue reading with offset: (\d+), limit: 2/.exec(r.modelText)
			if (!next) break
			assert.equal(Number(next[1]), offset + rows.length)
			offset = Number(next[1])
		}
		assert.deepEqual(recovered, expected)
	})

	for (const file of ["scanned.pdf", "malformed.pdf"]) {
		await t.test(`${file}: extraction rejection is ACP failed, never completed or successful read evidence`, async (st) => {
			const r = await runRead("report-analysis", file)
			assert.deepEqual(r.terminals.map((u) => u.status), ["failed"], `${file}: a success-shaped extraction error commits false evidence`)
			assert.match(acpText(r.terminals[0]), /report-analysis.*read[\s\S]*could not extract PDF[\s\S]*Next step:/)
			assert.match(r.modelText, file === "malformed.pdf" ? /converter failed/ : /no extractable text/)
			assert.doesNotMatch(r.modelText, placeholder)
			assert.deepEqual([...r.tracker.reads], [])
			assert.equal(r.tracker.stats.failed, 1)
			assert.equal(r.tracker.stats.pending, 0)
			assert.deepEqual(findFabricatedCitations(`Claim [source: ${file} | p:1]`, r.tracker.reads), [file])
			st.diagnostic(`${file}: ACP failed; committed reads=0; citation rejected`)
		})
	}

	await t.test("geology, report-analysis, orchestrator and standard retain their authorized reads and deny paths", async () => {
		for (const mode of ["geology", "report-analysis", "orchestrator", "standard"]) {
			const pdf = await runRead(mode, "original.pdf")
			assert.deepEqual(pdf.terminals.map((u) => u.status), ["completed"], mode)
			assert.ok(PDF_TEXT.every((text) => pdf.modelText.includes(text)), mode)
			assert.ok(pdf.tracker.reads.has(path.join(ws, "original.pdf")))
			const text = await runRead(mode, "notes.txt", { offset: 2, limit: 1 })
			assert.deepEqual(text.terminals.map((u) => u.status), ["completed"], mode)
			assert.equal(text.modelText, "Read file notes.txt, lines 2-2\n2: second line", "non-PDF pagination unchanged")
			const csv = await runRead(mode, "assays.csv")
			const denied = ["geology", "orchestrator"].includes(mode)
			assert.deepEqual(csv.terminals.map((u) => u.status), [denied ? "failed" : "completed"], `${mode}: data restriction`)
			assert.equal(csv.tracker.reads.has(path.join(ws, "assays.csv")), !denied)
			if (denied) assert.ok(!csv.modelText.includes("HOLE_1,2.4"))
			else assert.match(csv.modelText, /HOLE_1,2\.4/)
			const secret = await runRead(mode, ".env")
			assert.deepEqual(secret.terminals.map((u) => u.status), ["failed"], `${mode}: secret deny`)
			assert.equal(secret.tracker.reads.size, 0)
			assert.ok(!secret.modelText.includes("must-not-reach-model"))
		}
		assert.equal(permissions.length, 0, "PDF hook does not add approval or bypass shipped denies")
	})
})
