/**
 * End of turn: the RE-4 citation guard (lib/citation-guard.js), the answer + read ledger
 * (lib/turn-tracker.js) on real OpenCode 2.0.19 frame shapes, and the report export (lib/report-export.js) with a
 * fake pandoc. Real pandoc/weasyprint tests run only when the host has them. Run: `node --test test/report.test.mjs`
 */
import assert from "node:assert/strict"
import { spawnSync } from "node:child_process"
import fs from "node:fs/promises"
import os from "node:os"
import path from "node:path"
import { describe, it, test } from "node:test"
import { findFabricatedCitations } from "../lib/citation-guard.js"
import { ReportExporter } from "../lib/report-export.js"
import { TurnTracker } from "../lib/turn-tracker.js"

const DIR = "/workspace/test-project-456/gold_x2_mining"
const reads = (...rel) => new Set(rel.map((r) => `${DIR}/${r}`))

// =====================================================================================================================
// citation-guard.js
// =====================================================================================================================

describe("citation guard: filename matching", () => {
	it("flags invented filenames the agent never read (but allows files it did read)", () => {
		const answer = [
			"> **Data:** peak 1.2 g/t [source: text/01_summary.md | p:1]",
			"> **Data:** 23 of 156 [source: text/07_exploration.md | p:23-24]",
			"> **Data:** Au-AA25 [source: text/09_sample_preparation_analyses_and_security.md | p:32]",
			"> **Data:** no stat testing [source: analysis/findings.json | statistical_analysis]",
			"> **Data:** flagged [source: analysis/flags.json]",
		].join("\n")
		assert.deepEqual(findFabricatedCitations(answer, reads("sections.json", "analysis/findings.json", "analysis/flags.json")).sort(), [
			"text/01_summary.md",
			"text/07_exploration.md",
			"text/09_sample_preparation_analyses_and_security.md",
		])
	})
	it("treats an honest INSUFFICIENT answer (no file citations) as clean", () => {
		assert.deepEqual(findFabricatedCitations("> **Verdict:** ⚪ INSUFFICIENT — report not readable [not found in report]", new Set()), [])
	})
	it("ignores web citations (not file sources)", () => {
		assert.deepEqual(findFabricatedCitations("> **Data:** gold $2400/oz [source: web | https://example.com/price]", new Set()), [])
	})
	it("matches a basename-only citation against a deeper read path", () => {
		assert.deepEqual(findFabricatedCitations("[source: findings.json | stage]", reads("analysis/findings.json")), [])
	})
})

describe("citation guard: edge case 1, the prompt's figure grammar", () => {
	const fig = "> **Data:** TMI high in the north [source: images/fig_p0044_1 | p:44]"
	it("accepts images/fig_pNNNN_S when its .description.md was read (fork flagged it)", () => {
		assert.deepEqual(findFabricatedCitations(fig, reads("images/fig_p0044_1.description.md")), [])
	})
	it("accepts the figure id when only the image itself was read", () => {
		assert.deepEqual(findFabricatedCitations(fig, reads("images/fig_p0044_1.jpg")), [])
	})
	it("accepts a cited .jpg when its .description.md was read, and the reverse", () => {
		assert.deepEqual(findFabricatedCitations("[source: images/fig_p0044_1.jpg | p:44]", reads("images/fig_p0044_1.description.md")), [])
		assert.deepEqual(findFabricatedCitations("[source: images/fig_p0044_1.description.md | p:44]", reads("images/fig_p0044_1.jpg")), [])
	})
	it("still flags a figure nobody read, and a different figure on the same page", () => {
		assert.deepEqual(findFabricatedCitations(fig, reads("images/fig_p0044_2.description.md")), ["images/fig_p0044_1"])
		assert.deepEqual(findFabricatedCitations(fig, new Set()), ["images/fig_p0044_1"])
	})
	it("validates a bare figure id (no folder, no extension), which the fork skipped", () => {
		assert.deepEqual(findFabricatedCitations("[source: fig_p0044_1 | p:44]", new Set()), ["fig_p0044_1"])
		assert.deepEqual(findFabricatedCitations("[source: fig_p0044_1 | p:44]", reads("images/fig_p0044_1.description.md")), [])
	})
	it("does not extend the family rule to tables: a .csv citation needs the .csv read", () => {
		assert.deepEqual(
			findFabricatedCitations(
				"[source: tables/10_drilling_t1__p0095.csv | p:95]",
				reads("tables/10_drilling_t1__p0095.meta.json", "tables/10_drilling_t1__p0095.crop.png"),
			),
			["tables/10_drilling_t1__p0095.csv"],
		)
	})
})

describe("citation guard: edge case 2, several files in one bracket", () => {
	it("comma list, both read: clean (fork flagged the joined string)", () => {
		assert.deepEqual(
			findFabricatedCitations("[source: text/01_summary.md, text/07_geology.md | p:3, 41]", reads("text/01_summary.md", "text/07_geology.md")),
			[],
		)
	})
	it("comma list, one unread: flags only that one", () => {
		assert.deepEqual(findFabricatedCitations("[source: text/01_summary.md, text/07_geology.md | p:3, 41]", reads("text/01_summary.md")), [
			"text/07_geology.md",
		])
	})
	it("semicolon clauses: the second file is checked (fork never looked at it)", () => {
		assert.deepEqual(findFabricatedCitations("[source: text/01_summary.md | p:3; text/09_invented.md | p:41]", reads("text/01_summary.md")), [
			"text/09_invented.md",
		])
		assert.deepEqual(
			findFabricatedCitations("[source: text/01_summary.md | p:3; source: text/09_invented.md | p:41]", reads("text/01_summary.md")),
			["text/09_invented.md"],
		)
	})
	it("semicolon list, both read: clean (fork flagged the joined string, E2b)", () => {
		assert.deepEqual(findFabricatedCitations("[source: text/01_summary.md; tables/t3.csv | p:3]", reads("text/01_summary.md", "tables/t3.csv")), [])
	})
	it("a later '| source:' field starts a new clause", () => {
		assert.deepEqual(findFabricatedCitations("[source: text/01_summary.md | p:3 | source: tables/t9.csv | p:9]", reads("text/01_summary.md")), [
			"tables/t9.csv",
		])
	})
	it("'and' / '&' / '+' joins", () => {
		assert.deepEqual(findFabricatedCitations("[source: text/01_summary.md and text/09_invented.md | p:3]", reads("text/01_summary.md")), [
			"text/09_invented.md",
		])
		assert.deepEqual(findFabricatedCitations("[source: text/01_summary.md & tables/t3.csv]", reads("text/01_summary.md", "tables/t3.csv")), [])
		assert.deepEqual(findFabricatedCitations("[source: text/01_summary.md + tables/t3.csv]", reads("text/01_summary.md")), ["tables/t3.csv"])
	})
	it("a web source and a file in one bracket: the file is still checked", () => {
		assert.deepEqual(findFabricatedCitations("[source: web | https://kitco.com; text/22_economics.md | p:300]", new Set()), [
			"text/22_economics.md",
		])
	})
	it("a real file whose name contains a comma is accepted whole", () => {
		assert.deepEqual(findFabricatedCitations("[source: tables/au, cu summary.csv | p:3]", reads("tables/au, cu summary.csv")), [])
	})
	it("separators inside a quoted qualifier never split", () => {
		assert.deepEqual(findFabricatedCitations('[source: text/11_qaqc.md | section: "QA/QC; data/verification"]', reads("text/11_qaqc.md")), [])
	})
})

describe("citation guard: other fixes and kept behaviour", () => {
	it("strips backticks and quotes around a path (fork flagged `text/x.md`)", () => {
		assert.deepEqual(findFabricatedCitations("[source: `text/01_summary.md` | p:3]", reads("text/01_summary.md")), [])
		assert.deepEqual(findFabricatedCitations('[source: "text/01_summary.md" | p:3]', reads("text/01_summary.md")), [])
	})
	it("checks an unclosed bracket at the end of a line", () => {
		assert.deepEqual(findFabricatedCitations("> **Data:** x [source: text/09_invented.md | p:3\n> next", new Set()), ["text/09_invented.md"])
	})
	it("reports each fabricated file once, in order of first appearance", () => {
		const a = "[source: text/b.md | p:1] [source: text/a.md] [source: text/b.md | p:2]"
		assert.deepEqual(findFabricatedCitations(a, new Set()), ["text/b.md", "text/a.md"])
	})
	it("keeps the fork's lenient rules: absolute citation, ./ prefix, case, backslashes", () => {
		const r = reads("text/01_summary.md")
		assert.deepEqual(findFabricatedCitations(`[source: ${DIR}/text/01_summary.md | p:3]`, r), [])
		assert.deepEqual(findFabricatedCitations("[source: ./TEXT/01_Summary.md | p:3]", r), [])
		assert.deepEqual(findFabricatedCitations("[source: text\\01_summary.md | p:3]", r), [])
	})
	it("keeps the fork's skip of labels that don't look like files (E6)", () => {
		assert.deepEqual(findFabricatedCitations("> **Data:** x [source: Table 14-3 | p:120]", new Set()), [])
	})
	it("takes any iterable of reads and tolerates a non-string answer", () => {
		assert.deepEqual(findFabricatedCitations("[source: text/01_summary.md]", [`${DIR}/text/01_summary.md`]), [])
		assert.deepEqual(findFabricatedCitations(undefined, new Set()), [])
		assert.deepEqual(findFabricatedCitations("[source: text/01_summary.md]", undefined), ["text/01_summary.md"])
	})
	it("a pathological bracket body is cut, not scanned quadratically", () => {
		const line = `[source: text/09_invented.md ${" ".repeat(200_000)}x]`
		const started = Date.now()
		assert.deepEqual(findFabricatedCitations(line, new Set()), ["text/09_invented.md"])
		assert.ok(Date.now() - started < 2000, `took ${Date.now() - started} ms`)
	})
})

// =====================================================================================================================
// turn-tracker.js: frames as OpenCode 2.0.19 sends them (s43/fork-ports/live run and the v2 probe), trimmed
// =====================================================================================================================

const WS = "/workspace/proj-1"
const ROOT_ID = "ses_f08d4e761ffeWHa760E43Qawz4"
const CHILD_1 = "ses_f0f008546ffeypAmE6OSK4sc0A"
const CHILD_2 = "ses_f0eb8af86ffeJr4Xb8MooSn46v"

const chunk = (messageId, text) => ({ sessionUpdate: "agent_message_chunk", messageId, content: { type: "text", text } })
const pending = (id, title = "read", kind = "read") => ({ sessionUpdate: "tool_call", toolCallId: id, title, kind, status: "pending", locations: [], rawInput: {} })
const inProgress = (id, p, title = "read") => ({
	sessionUpdate: "tool_call_update",
	toolCallId: id,
	status: "in_progress",
	kind: "read",
	title,
	locations: [{ path: p }],
	rawInput: { path: p },
})
const completed = (id, text = "Read file …") => ({
	sessionUpdate: "tool_call_update",
	toolCallId: id,
	status: "completed",
	content: [{ type: "content", content: { type: "text", text } }],
	rawOutput: { metadata: { truncated: false } },
})
const failed = (id, p, error = `File not found: ${p}`) => ({
	sessionUpdate: "tool_call_update",
	toolCallId: id,
	status: "failed",
	kind: "read",
	title: "read",
	locations: [{ path: p }],
	rawInput: { path: p },
	content: [{ type: "content", content: { type: "text", text: error } }],
	rawOutput: { metadata: {}, error },
})
/** The gateway's child frame (what `_gc/child_update` carries and the SessionLog stores as kind `child`). */
const childFrame = (sessionId, depth, update, title = "Execute steps with tool calls") => ({
	child: { sessionId, parentSessionId: depth === 1 ? ROOT_ID : CHILD_1, depth, title, toolCallId: depth === 1 ? "call_fake_2" : null },
	type: "update",
	update: { ...update, _meta: { "opencode/child-session": { id: sessionId, parentID: ROOT_ID, depth, title } } },
})

/** The live run's first turn (report-analysis root): narration, 7 reads + a glob, 2 failures, the answer. */
function liveTurn1() {
	return [
		chunk("msg_0f72b191d001i7aqJlELimAYyz", "Listing and reading the report files."),
		pending("call_1"),
		pending("call_2"),
		pending("call_3"),
		pending("call_5"),
		pending("call_6"),
		pending("call_8", "glob", "search"),
		inProgress("call_1", "report"),
		inProgress("call_2", "report/text/01_summary.md"),
		inProgress("call_3", `${WS}/report/images/fig_p0044_1.description.md`),
		inProgress("call_5", `${WS}/report/text/06_exploration.md`),
		inProgress("call_6", `${WS}/report/tables/t3.csv`),
		{ sessionUpdate: "tool_call_update", toolCallId: "call_8", status: "in_progress", kind: "search", title: "glob", locations: [], rawInput: { pattern: "report/text/*.md" } },
		failed("call_5", `${WS}/report/text/06_exploration.md`),
		completed("call_6"),
		completed("call_1", "Read directory report, entries 1-4\nanalysis/\nimages/\ntables/\ntext/"),
		completed("call_3"),
		completed("call_2", "Read file report/text/01_summary.md, lines 1-3"),
		completed("call_8", `${WS}/report/text/01_summary.md`),
		chunk("msg_0f72b1b39001CobNCcWsch02IW", "**Question:** Is QA/QC adequate?\n\n> **Data:** Orogenic gold [source: text/01_summary.md | p:3]"),
		{ sessionUpdate: "usage_update", used: 120, size: 200000, cost: { amount: 0, currency: "USD" } },
	]
}

describe("TurnTracker: the read ledger", () => {
	it("root read flow pending -> in_progress -> completed, relative path resolved against the cwd", () => {
		const t = new TurnTracker({ cwd: WS })
		t.beginTurn()
		for (const u of liveTurn1()) t.onUpdate(u)
		assert.deepEqual([...t.reads].sort(), [
			`${WS}/report`, // a directory read completes too (harmless: never equals a file citation)
			`${WS}/report/images/fig_p0044_1.description.md`,
			`${WS}/report/tables/t3.csv`,
			`${WS}/report/text/01_summary.md`,
		])
		assert.deepEqual(t.stats, { committed: 4, failed: 1, completedWithoutPath: 0, pending: 0 })
	})

	it("a failed read drops its path; a completed frame without a known path is counted, not guessed", () => {
		const t = new TurnTracker({ cwd: WS })
		t.onUpdate(pending("call_4"))
		t.onUpdate(inProgress("call_4", `${WS}/report/images/fig_p0044_1`))
		t.onUpdate(failed("call_4", `${WS}/report/images/fig_p0044_1`))
		t.onUpdate(completed("call_4")) // a stray completed for the same id after the failure
		t.onUpdate(pending("call_9"))
		t.onUpdate(completed("call_9")) // never seen on 2.0.19: no in_progress frame
		assert.equal(t.reads.size, 0)
		assert.deepEqual(t.stats, { committed: 0, failed: 1, completedWithoutPath: 1, pending: 0 })
	})

	it("never counts grep, glob, MCP tools or subagent results", () => {
		const t = new TurnTracker({ cwd: WS })
		const other = (id, title, kind, rawInput) => [
			pending(id, title, kind),
			{ sessionUpdate: "tool_call_update", toolCallId: id, status: "in_progress", kind, title, locations: [{ path: "report/text/01_summary.md" }], rawInput },
			completed(id),
		]
		for (const u of [
			...other("c1", "grep", "search", { pattern: "gold", path: "report/text/01_summary.md" }),
			...other("c2", "glob", "search", { pattern: "*.md", path: "report" }),
			...other("chatcmpl-tool-b084fdf8dac7b5fa", "geocluster_list_files", "other", { path: "report" }),
			...other("call_fake_2", "subagent", "think", { agent: "orchestrator", prompt: "read report/text/01_summary.md" }),
		])
			t.onUpdate(u)
		assert.equal(t.reads.size, 0)
		assert.equal(t.stats.pending, 0)
	})

	it("a reused root id names a new call: a stale read path is not committed by another tool", () => {
		const t = new TurnTracker({ cwd: WS })
		t.onUpdate(pending("call_1"))
		t.onUpdate(inProgress("call_1", "report/text/01_summary.md")) // turn 1: cancelled before it ended
		t.beginTurn()
		t.onUpdate(pending("call_1", "glob", "search")) // turn 2: the provider restarts its ids
		t.onUpdate(completed("call_1"))
		assert.equal(t.reads.size, 0)
		t.onUpdate(pending("call_1")) // a read with the same id again, its pending frame has no path
		t.onUpdate(inProgress("call_1", "report/text/11_qaqc.md"))
		t.onUpdate(completed("call_1"))
		assert.deepEqual([...t.reads], [`${WS}/report/text/11_qaqc.md`])
	})

	it("pending reads are keyed by (sessionId, toolCallId): a child's call never completes a root call", () => {
		const t = new TurnTracker({ cwd: WS })
		t.onUpdate(pending("call_1"))
		t.onUpdate(inProgress("call_1", "report/a.md"))
		t.onChild(childFrame(CHILD_1, 1, completed("call_1"))) // synthetic: real child ids are prefixed
		assert.equal(t.reads.size, 0)
		t.onUpdate(completed("call_1"))
		assert.deepEqual([...t.reads], [`${WS}/report/a.md`])
	})

	it("children: depth 1 counted (relative path), depth 2 not; maxChildDepth 0 counts none; status frames ignored", () => {
		const id1 = `${CHILD_1}:chatcmpl-tool-90690dfebd7680dd`
		const id2 = `${CHILD_2}:chatcmpl-tool-ae8d47372ef1d845`
		const t1 = "Execute steps with tool calls"
		const t2 = "Find max Cu and weighted averages"
		const frames = [
			{ child: { sessionId: CHILD_1, parentSessionId: ROOT_ID, depth: 1, title: t1, toolCallId: "call_fake_2" }, type: "status", status: "created" },
			childFrame(CHILD_1, 1, pending(id1, `${t1}: read`), t1),
			childFrame(CHILD_1, 1, inProgress(id1, "drill.csv", `${t1}: read`), t1),
			childFrame(CHILD_1, 1, completed(id1, "Read file drill.csv, lines 1-4"), t1),
			childFrame(CHILD_2, 2, pending(id2, `${t2}: read`), t2),
			childFrame(CHILD_2, 2, inProgress(id2, "/workspace/proj-1/assays.csv", `${t2}: read`), t2),
			childFrame(CHILD_2, 2, completed(id2), t2),
			{ child: { sessionId: CHILD_1, parentSessionId: ROOT_ID, depth: 1, title: t1, toolCallId: "call_fake_2" }, type: "status", status: "completed" },
		]
		const parity = new TurnTracker({ cwd: WS })
		const strict = new TurnTracker({ cwd: WS, maxChildDepth: 0 })
		const deep = new TurnTracker({ cwd: WS, maxChildDepth: 2 })
		for (const f of frames) for (const t of [parity, strict, deep]) t.onChild(f)
		assert.deepEqual([...parity.reads], [`${WS}/drill.csv`])
		assert.equal(strict.reads.size, 0)
		assert.deepEqual([...deep.reads].sort(), [`${WS}/assays.csv`, `${WS}/drill.csv`])
	})

	it("rejects a relative cwd and a bad maxChildDepth", () => {
		assert.throws(() => new TurnTracker({ cwd: "ws" }), TypeError)
		assert.throws(() => new TurnTracker({ cwd: WS, maxChildDepth: -1 }), TypeError)
	})
})

describe("TurnTracker: the answer", () => {
	it("is the root text after the last root tool_call; narration and child text excluded", () => {
		const t = new TurnTracker({ cwd: WS })
		t.beginTurn()
		const frames = liveTurn1()
		frames.splice(9, 0, childFrame(CHILD_1, 1, chunk("msg_child", "child text that must not leak")))
		for (const u of frames) (u.child ? t.onChild(u) : t.onUpdate(u))
		assert.equal(t.answer(), "**Question:** Is QA/QC adequate?\n\n> **Data:** Orogenic gold [source: text/01_summary.md | p:3]")
	})

	it("ignores tool_call_update, thought chunks, usage and retry state; a turn ending on a tool call has no answer", () => {
		const t = new TurnTracker({ cwd: WS })
		t.beginTurn()
		t.onUpdate(chunk("msg_a", "Final "))
		t.onUpdate({ sessionUpdate: "agent_thought_chunk", messageId: "msg_a:reasoning:0", content: { type: "text", text: "thinking" } })
		t.onUpdate(completed("call_9")) // a late update of an earlier call is not a new step
		t.onUpdate({ sessionUpdate: "agent_message_chunk", messageId: "msg_a", content: { type: "image", data: "…", mimeType: "image/png" } })
		t.onUpdate(chunk("msg_a", "answer."))
		assert.equal(t.answer(), "Final answer.")
		t.onUpdate(pending("call_10"))
		assert.equal(t.answer(), "")
	})

	it("a new messageId does not reset it: a dropped stream continues under a new id", () => {
		const t = new TurnTracker({ cwd: WS })
		t.beginTurn()
		t.onUpdate(chunk("msg_0f73f0f26001M2WrpxMvw78q9V", "The QA/QC program inserted CRMs at 1 in "))
		t.onUpdate({
			sessionUpdate: "session_info_update",
			_meta: { "opencode/retry": { attempt: 2, nextRetryAt: "2026-10-01T11:26:31.656Z", error: { type: "provider.transport", message: "ECONNRESET", status: 200 } } },
		})
		t.onUpdate({ sessionUpdate: "session_info_update", _meta: { "opencode/retry": null } })
		t.onUpdate(chunk("msg_0f73f11400018aI466JeVj16vJ", "20 [source: text/11_qaqc.md | p:57]."))
		assert.equal(t.answer(), "The QA/QC program inserted CRMs at 1 in 20 [source: text/11_qaqc.md | p:57].")
	})

	it("beginTurn() resets the answer only: the reads survive into the correction turn", () => {
		const t = new TurnTracker({ cwd: WS })
		for (const u of liveTurn1()) t.onUpdate(u)
		const before = [...t.reads]
		t.beginTurn() // the broker's correction prompt
		assert.equal(t.answer(), "")
		assert.deepEqual([...t.reads], before)
		t.onUpdate(chunk("msg_0f72b1ba50017NBchmoUhwJPng", "Re-reading the verified findings."))
		t.onUpdate(pending("call_9"))
		t.onUpdate(inProgress("call_9", `${WS}/report/analysis/findings.json`))
		t.onUpdate(completed("call_9"))
		t.onUpdate(chunk("msg_0f72b1bf6001WRFsadMXRs7J8J", "Corrected [source: analysis/findings.json | qaqc]"))
		assert.equal(t.answer(), "Corrected [source: analysis/findings.json | qaqc]")
		assert.ok(t.reads.has(`${WS}/report/analysis/findings.json`))
		assert.deepEqual(findFabricatedCitations(t.answer(), t.reads), [])
	})

	it("accepts the session/update params shape too", () => {
		const t = new TurnTracker({ cwd: WS })
		t.onUpdate({ sessionId: ROOT_ID, update: chunk("msg_a", "hello") })
		assert.equal(t.answer(), "hello")
	})
})

// =====================================================================================================================
// report-export.js
// =====================================================================================================================

function captureLogger() {
	const lines = []
	const at = (level) => (message, extra) => lines.push({ level, message, extra })
	return { lines, info: at("info"), warn: at("warn"), error: at("error"), child: () => captureLogger() }
}

const isAlive = (pid) => {
	try {
		process.kill(pid, 0)
		return true
	} catch {
		return false
	}
}

/** A temp workspace (and a sibling "outside" dir), removed after the test; any pid in `pids` is killed. */
async function sandbox(t) {
	const root = await fs.mkdtemp(path.join(os.tmpdir(), "report-"))
	const workspace = path.join(root, "ws")
	const outside = path.join(root, "outside")
	await fs.mkdir(workspace)
	await fs.mkdir(outside)
	const pids = []
	t.after(async () => {
		for (const pid of pids) if (isAlive(pid)) process.kill(pid, "SIGKILL")
		await fs.rm(root, { recursive: true, force: true })
	})
	return { root, workspace, outside, pids }
}

/**
 * A fake pandoc: `<md> -o <out> [--pdf-engine=…]`. It appends {ev, base, fmt, t, cwd, args} lines to <dir>/calls.ndjson
 * and writes "<fmt>:<md text>" to <out>. Directives in the markdown: `DELAY:<ms>`; `MODE:fail` (exit 3, stderr);
 * `MODE:hang` (PDF only: writes a partial PDF and an html2pdf temp file, starts a grandchild, never exits; the
 * grandchild's pid goes to <dir>/grandchild.pid).
 */
async function fakePandoc(dir) {
	const bin = path.join(dir, "fake-pandoc.cjs")
	const calls = path.join(dir, "calls.ndjson")
	const pidFile = path.join(dir, "grandchild.pid")
	const script = `#!${process.execPath}
"use strict"
const fs = require("node:fs")
const path = require("node:path")
const { spawn } = require("node:child_process")
const args = process.argv.slice(2)
const md = args[0]
const out = args[args.indexOf("-o") + 1]
const fmt = args.some((a) => a.startsWith("--pdf-engine")) ? "pdf" : "docx"
const text = fs.readFileSync(md, "utf8")
const log = (ev) => fs.appendFileSync(${JSON.stringify(calls)}, JSON.stringify({ ev, base: path.basename(md, ".md"), fmt, t: Date.now(), cwd: process.cwd(), args, envKeys: Object.keys(process.env) }) + "\\n")
log("start")
const mode = (text.match(/MODE:(\\w+)/) || [])[1] || "ok"
const delay = Number((text.match(/DELAY:(\\d+)/) || [])[1] || 0)
if (mode === "fail") {
	process.stderr.write("pandoc: Could not convert image: boom\\n")
	process.exit(3)
}
if (mode === "orphan" && fmt === "pdf") {
	// pandoc dies while a child it started still holds the gateway's stdout/stderr pipes
	const grandchild = spawn(process.execPath, ["-e", "setTimeout(() => {}, 60000)"], { stdio: "inherit" })
	fs.writeFileSync(${JSON.stringify(pidFile)}, String(grandchild.pid))
	grandchild.unref()
	process.exit(5)
}
if (mode === "hang" && fmt === "pdf") {
	fs.writeFileSync(out, "%PDF-1.7 partial")
	fs.writeFileSync(path.join(process.cwd(), "html2pdf4242.html"), "<html></html>")
	const grandchild = spawn(process.execPath, ["-e", "setTimeout(() => {}, 60000)"], { stdio: "ignore" })
	fs.writeFileSync(${JSON.stringify(pidFile)}, String(grandchild.pid))
	setInterval(() => {}, 1000)
	return
}
setTimeout(() => {
	fs.writeFileSync(out, fmt + ":" + text)
	log("end")
}, delay)
`
	await fs.writeFile(bin, script, { mode: 0o755 })
	const readCalls = async () =>
		(await fs.readFile(calls, "utf8").catch(() => ""))
			.split("\n")
			.filter(Boolean)
			.map((l) => JSON.parse(l))
	return { bin, readCalls, pidFile }
}

const NOW = new Date(Date.UTC(2026, 9, 1, 19, 13, 12))
const ANSWER = "**Question:** QA/QC?\n\n> **Verdict:** 🟡 AMBER — ⚪ partial [source: tables/t3.csv | p:12]\n"

describe("ReportExporter.writeMarkdown", () => {
	it("writes <run>/_reports/REPORT_<YYYYMMDD_HHmmss UTC>.md with the answer verbatim (UTF-8)", async (t) => {
		const { workspace } = await sandbox(t)
		const logger = captureLogger()
		const exporter = new ReportExporter({ workspaceDir: workspace, logger })
		const result = await exporter.writeMarkdown("runs/ses_f08d4e761ffeWHa760E43Qawz4", ANSWER, { now: NOW })
		assert.deepEqual(result, {
			relPath: "runs/ses_f08d4e761ffeWHa760E43Qawz4/_reports/REPORT_20261001_191312.md",
			absPath: path.join(workspace, "runs/ses_f08d4e761ffeWHa760E43Qawz4/_reports/REPORT_20261001_191312.md"),
		})
		assert.equal(await fs.readFile(result.absPath, "utf8"), ANSWER)
		assert.ok(logger.lines.some((l) => l.level === "info" && l.message.includes(result.relPath)))
	})

	it("never overwrites: a same-second name gets _2, _3 (wx), and a base whose .docx/.pdf exists is skipped", async (t) => {
		const { workspace } = await sandbox(t)
		const exporter = new ReportExporter({ workspaceDir: workspace, logger: captureLogger() })
		const a = await exporter.writeMarkdown("runs/ses_a", "first", { now: NOW })
		const b = await exporter.writeMarkdown("runs/ses_a", "second", { now: NOW })
		const c = await exporter.writeMarkdown("runs/ses_a", "third", { now: NOW })
		assert.deepEqual(
			[a, b, c].map((r) => path.basename(r.relPath)),
			["REPORT_20261001_191312.md", "REPORT_20261001_191312_2.md", "REPORT_20261001_191312_3.md"],
		)
		assert.equal(await fs.readFile(a.absPath, "utf8"), "first")
		assert.equal(await fs.readFile(b.absPath, "utf8"), "second")
		// a stray (or planted) PDF for the next base name: that name is not taken
		const dir = path.dirname(a.absPath)
		await fs.writeFile(path.join(dir, "REPORT_20261001_191312_4.pdf"), "not ours")
		const d = await exporter.writeMarkdown("runs/ses_a", "fourth", { now: NOW })
		assert.equal(path.basename(d.relPath), "REPORT_20261001_191312_5.md")
		assert.equal(await fs.readFile(path.join(dir, "REPORT_20261001_191312_4.pdf"), "utf8"), "not ours")
	})

	it("concurrent writes in the same second get distinct names", async (t) => {
		const { workspace } = await sandbox(t)
		const exporter = new ReportExporter({ workspaceDir: workspace, logger: captureLogger() })
		const results = await Promise.all([1, 2, 3, 4].map((n) => exporter.writeMarkdown("runs/ses_b", `answer ${n}`, { now: NOW })))
		assert.equal(new Set(results.map((r) => r.relPath)).size, 4)
		const texts = await Promise.all(results.map((r) => fs.readFile(r.absPath, "utf8")))
		assert.deepEqual(texts.sort(), ["answer 1", "answer 2", "answer 3", "answer 4"])
	})

	it("refuses a run dir that isn't exactly runs/<id>, and an empty answer", async (t) => {
		const { workspace, root } = await sandbox(t)
		const logger = captureLogger()
		const exporter = new ReportExporter({ workspaceDir: workspace, logger })
		for (const bad of ["runs/../x", "../runs/a", "/abs/runs/a", "runs/a/b", "runs/", "runs", "foo/a", "runs/a b", "runs/..", "runs/a\0", "", null, 42]) {
			assert.equal(await exporter.writeMarkdown(bad, ANSWER, { now: NOW }), null, `runDir ${JSON.stringify(bad)}`)
		}
		assert.equal(await exporter.writeMarkdown("runs/ses_ok", "", { now: NOW }), null)
		assert.deepEqual(await fs.readdir(workspace), [])
		assert.deepEqual((await fs.readdir(root)).sort(), ["outside", "ws"])
		assert.ok(logger.lines.every((l) => l.level === "warn"))
	})

	it("refuses a symlinked runs/<id>, runs or _reports that escapes the workspace", async (t) => {
		const { workspace, outside } = await sandbox(t)
		const logger = captureLogger()
		const exporter = new ReportExporter({ workspaceDir: workspace, logger })
		await fs.mkdir(path.join(workspace, "runs"))
		await fs.symlink(outside, path.join(workspace, "runs", "ses_evil"))
		assert.equal(await exporter.writeMarkdown("runs/ses_evil", ANSWER, { now: NOW }), null)
		// a dangling symlink to a would-be directory outside
		await fs.symlink(path.join(outside, "later"), path.join(workspace, "runs", "ses_dangling"))
		assert.equal(await exporter.writeMarkdown("runs/ses_dangling", ANSWER, { now: NOW }), null)
		// _reports itself
		await fs.mkdir(path.join(workspace, "runs", "ses_c"))
		await fs.symlink(outside, path.join(workspace, "runs", "ses_c", "_reports"))
		assert.equal(await exporter.writeMarkdown("runs/ses_c", ANSWER, { now: NOW }), null)
		assert.deepEqual(await fs.readdir(outside), [])
		assert.equal(logger.lines.filter((l) => l.level === "warn" && /outside the workspace/.test(l.message)).length, 3)

		// the whole runs folder
		const { workspace: ws2, outside: out2 } = await sandbox(t)
		await fs.symlink(out2, path.join(ws2, "runs"))
		const exporter2 = new ReportExporter({ workspaceDir: ws2, logger: captureLogger() })
		assert.equal(await exporter2.writeMarkdown("runs/ses_x", ANSWER, { now: NOW }), null)
		assert.deepEqual(await fs.readdir(out2), [])
	})

	it("a symlink that stays inside the workspace is fine", async (t) => {
		const { workspace } = await sandbox(t)
		await fs.mkdir(path.join(workspace, "data", "runs-real"), { recursive: true })
		await fs.symlink(path.join(workspace, "data", "runs-real"), path.join(workspace, "runs"))
		const exporter = new ReportExporter({ workspaceDir: workspace, logger: captureLogger() })
		const r = await exporter.writeMarkdown("runs/ses_in", ANSWER, { now: NOW })
		assert.equal(r.relPath, "runs/ses_in/_reports/REPORT_20261001_191312.md")
		assert.equal(await fs.readFile(path.join(workspace, "data", "runs-real", "ses_in", "_reports", "REPORT_20261001_191312.md"), "utf8"), ANSWER)
	})

	it("disabled: writes nothing and converts nothing", async (t) => {
		const { workspace } = await sandbox(t)
		const exporter = new ReportExporter({ workspaceDir: workspace, enabled: false, pandocBin: "/nonexistent/pandoc", logger: captureLogger() })
		assert.equal(await exporter.writeMarkdown("runs/ses_a", ANSWER, { now: NOW }), null)
		await exporter.convert(path.join(workspace, "runs/ses_a/_reports/REPORT_x.md"))
		assert.deepEqual(await fs.readdir(workspace), [])
	})

	it("a filesystem failure is logged and gives null, never a throw", async (t) => {
		const { workspace } = await sandbox(t)
		const logger = captureLogger()
		await fs.mkdir(path.join(workspace, "runs"))
		await fs.writeFile(path.join(workspace, "runs", "ses_file"), "a file where the run folder should be")
		const exporter = new ReportExporter({ workspaceDir: workspace, logger })
		assert.equal(await exporter.writeMarkdown("runs/ses_file", ANSWER, { now: NOW }), null)
		assert.ok(logger.lines.some((l) => l.level === "error" && /Failed to save completion report/.test(l.message)))
		const missing = new ReportExporter({ workspaceDir: path.join(workspace, "no-such-workspace"), logger })
		assert.equal(await missing.writeMarkdown("runs/ses_a", ANSWER, { now: NOW }), null)
	})
})

describe("ReportExporter.convert (fake pandoc)", () => {
	it("runs pandoc <md> -o <docx> and pandoc <md> -o <pdf> --pdf-engine=weasyprint in the reports folder, no secrets in env", async (t) => {
		const { workspace, root } = await sandbox(t)
		const fake = await fakePandoc(root)
		const logger = captureLogger()
		const exporter = new ReportExporter({ workspaceDir: workspace, pandocBin: fake.bin, logger })
		const saved = await exporter.writeMarkdown("runs/ses_a", ANSWER, { now: NOW })
		const previous = process.env.RUNTIME_ACTIVITY_TOKEN
		process.env.RUNTIME_ACTIVITY_TOKEN = "secret-should-not-reach-pandoc"
		const exporterWithSecret = new ReportExporter({ workspaceDir: workspace, pandocBin: fake.bin, logger })
		if (previous === undefined) delete process.env.RUNTIME_ACTIVITY_TOKEN
		else process.env.RUNTIME_ACTIVITY_TOKEN = previous
		await exporterWithSecret.convert(saved.absPath)
		const dir = path.dirname(saved.absPath)
		const base = saved.absPath.slice(0, -3)
		assert.equal(await fs.readFile(`${base}.docx`, "utf8"), `docx:${ANSWER}`)
		assert.equal(await fs.readFile(`${base}.pdf`, "utf8"), `pdf:${ANSWER}`)
		const starts = (await fake.readCalls()).filter((c) => c.ev === "start")
		assert.deepEqual(starts.map((c) => c.args).sort((a, b) => a.length - b.length), [
			[saved.absPath, "-o", `${base}.docx`],
			[saved.absPath, "-o", `${base}.pdf`, "--pdf-engine=weasyprint"],
		])
		const realDir = await fs.realpath(dir)
		assert.ok(starts.every((c) => c.cwd === realDir))
		assert.ok(starts.every((c) => !c.envKeys.includes("RUNTIME_ACTIVITY_TOKEN")))
		assert.ok(logger.lines.some((l) => l.level === "info" && l.message === `Generated DOCX: ${base}.docx`))
		assert.ok(logger.lines.some((l) => l.level === "info" && l.message === `Generated PDF: ${base}.pdf`))
		assert.ok(!logger.lines.some((l) => l.level === "error"))
		await exporter.close()
	})

	it("one report at a time across the process; a report's DOCX and PDF run in parallel", async (t) => {
		const { workspace, root } = await sandbox(t)
		const fake = await fakePandoc(root)
		const a = new ReportExporter({ workspaceDir: workspace, pandocBin: fake.bin, logger: captureLogger() })
		const b = new ReportExporter({ workspaceDir: workspace, pandocBin: fake.bin, logger: captureLogger() })
		const r1 = await a.writeMarkdown("runs/ses_1", "one DELAY:300", { now: NOW })
		const r2 = await b.writeMarkdown("runs/ses_2", "two DELAY:300", { now: NOW })
		const r3 = await a.writeMarkdown("runs/ses_3", "three DELAY:50", { now: NOW })
		await Promise.all([a.convert(r1.absPath), b.convert(r2.absPath), a.convert(r3.absPath)])
		const calls = await fake.readCalls()
		const span = (dirName) => {
			const mine = calls.filter((c) => c.cwd.includes(`${path.sep}${dirName}${path.sep}`))
			assert.equal(mine.length, 4, `${dirName}: ${JSON.stringify(mine)}`)
			const starts = mine.filter((c) => c.ev === "start").map((c) => c.t)
			const ends = mine.filter((c) => c.ev === "end").map((c) => c.t)
			return { firstStart: Math.min(...starts), lastStart: Math.max(...starts), firstEnd: Math.min(...ends), lastEnd: Math.max(...ends) }
		}
		const s1 = span("ses_1")
		const s2 = span("ses_2")
		const s3 = span("ses_3")
		assert.ok(s1.lastStart < s1.firstEnd, "DOCX and PDF of one report overlap")
		assert.ok(s1.lastEnd <= s2.firstStart, "report 2 starts after report 1 ended")
		assert.ok(s2.lastEnd <= s3.firstStart, "report 3 starts after report 2 ended (queue order)")
	})

	it("a failure is non-fatal: logged with the stderr, no output left, the next report still converts", async (t) => {
		const { workspace, root } = await sandbox(t)
		const fake = await fakePandoc(root)
		const logger = captureLogger()
		const exporter = new ReportExporter({ workspaceDir: workspace, pandocBin: fake.bin, logger })
		const bad = await exporter.writeMarkdown("runs/ses_a", "MODE:fail", { now: NOW })
		const good = await exporter.writeMarkdown("runs/ses_a", "fine", { now: NOW })
		await Promise.all([exporter.convert(bad.absPath), exporter.convert(good.absPath)])
		const failures = logger.lines.filter((l) => l.level === "error")
		assert.equal(failures.length, 2)
		for (const f of failures) {
			assert.match(f.message, /^Report conversion failed \(non-fatal\): /)
			assert.equal(f.extra.code, 3)
			assert.equal(f.extra.timedOut, false)
			assert.match(f.extra.stderr, /Could not convert image: boom/)
		}
		const names = await fs.readdir(path.dirname(bad.absPath))
		assert.deepEqual(names.sort(), ["REPORT_20261001_191312.md", "REPORT_20261001_191312_2.docx", "REPORT_20261001_191312_2.md", "REPORT_20261001_191312_2.pdf"])
	})

	it("a missing pandoc binary is logged, not thrown", async (t) => {
		const { workspace } = await sandbox(t)
		const logger = captureLogger()
		const exporter = new ReportExporter({ workspaceDir: workspace, pandocBin: path.join(workspace, "no-pandoc"), logger })
		const saved = await exporter.writeMarkdown("runs/ses_a", ANSWER, { now: NOW })
		await exporter.convert(saved.absPath)
		const failures = logger.lines.filter((l) => l.level === "error")
		assert.equal(failures.length, 2)
		assert.ok(failures.every((f) => f.extra.code === "ENOENT"))
		await exporter.convert("relative/REPORT.md") // refused, resolves
		assert.ok(logger.lines.some((l) => l.level === "warn" && /not an absolute \.md path/.test(l.message)))
	})

	it("timeout: SIGKILLs pandoc and its children, removes the partial PDF and the html2pdf temp file", async (t) => {
		const { workspace, root, pids } = await sandbox(t)
		const fake = await fakePandoc(root)
		const logger = captureLogger()
		const exporter = new ReportExporter({ workspaceDir: workspace, pandocBin: fake.bin, timeoutMs: 1500, logger })
		const saved = await exporter.writeMarkdown("runs/ses_a", "MODE:hang", { now: NOW })
		const dir = path.dirname(saved.absPath)
		await fs.writeFile(path.join(dir, "html2pdf-old.html"), "not from this run") // must survive
		const started = Date.now()
		const done = exporter.convert(saved.absPath)
		// while it hangs: the partial PDF and the grandchild exist
		let grandchild = 0
		for (let i = 0; i < 100 && !grandchild; i++) {
			await new Promise((r) => setTimeout(r, 20))
			grandchild = Number(await fs.readFile(fake.pidFile, "utf8").catch(() => 0))
		}
		assert.ok(grandchild > 0, "the fake started its grandchild")
		pids.push(grandchild)
		assert.ok(isAlive(grandchild))
		await done
		const elapsed = Date.now() - started
		assert.ok(elapsed >= 1400 && elapsed < 10000, `elapsed ${elapsed}`)
		for (let i = 0; i < 50 && isAlive(grandchild); i++) await new Promise((r) => setTimeout(r, 20))
		assert.equal(isAlive(grandchild), false, "the grandchild (weasyprint's place) was killed with pandoc")
		const names = (await fs.readdir(dir)).sort()
		assert.deepEqual(names, ["REPORT_20261001_191312.docx", "REPORT_20261001_191312.md", "html2pdf-old.html"])
		const failure = logger.lines.find((l) => l.level === "error")
		assert.equal(failure.message, `Report conversion failed (non-fatal): ${saved.absPath.slice(0, -3)}.pdf`)
		assert.equal(failure.extra.timedOut, true)
		assert.equal(failure.extra.signal, "SIGKILL")
		assert.ok(logger.lines.some((l) => l.level === "info" && l.message.startsWith("Generated DOCX: ")))
	})

	it("a process holding pandoc's pipes after pandoc died can't wedge the queue", async (t) => {
		const { workspace, root, pids } = await sandbox(t)
		const fake = await fakePandoc(root)
		const logger = captureLogger()
		const exporter = new ReportExporter({ workspaceDir: workspace, pandocBin: fake.bin, timeoutMs: 800, logger })
		const orphan = await exporter.writeMarkdown("runs/ses_o", "MODE:orphan", { now: NOW })
		const next = await exporter.writeMarkdown("runs/ses_o", "next", { now: NOW })
		const started = Date.now()
		await Promise.all([exporter.convert(orphan.absPath), exporter.convert(next.absPath)])
		const grandchild = Number(await fs.readFile(fake.pidFile, "utf8").catch(() => 0))
		if (grandchild) pids.push(grandchild) // re-parented, out of our reach: the test reaps it
		assert.ok(Date.now() - started < 8000)
		const failure = logger.lines.find((l) => l.level === "error")
		assert.equal(failure.extra.format, "PDF")
		assert.equal(failure.extra.code, 5)
		assert.ok(await fs.stat(`${next.absPath.slice(0, -3)}.pdf`), "the next report still converted")
	})

	it("close() waits for the queue; at the cap it kills what runs and skips what is queued", async (t) => {
		const { workspace, root, pids } = await sandbox(t)
		const fake = await fakePandoc(root)
		const quick = new ReportExporter({ workspaceDir: workspace, pandocBin: fake.bin, logger: captureLogger() })
		const q = await quick.writeMarkdown("runs/ses_q", "quick DELAY:200", { now: NOW })
		void quick.convert(q.absPath)
		assert.equal(await quick.close(5000), true)
		assert.ok(await fs.stat(`${q.absPath.slice(0, -3)}.pdf`))

		const logger = captureLogger()
		const slow = new ReportExporter({ workspaceDir: workspace, pandocBin: fake.bin, timeoutMs: 60000, logger })
		const hung = await slow.writeMarkdown("runs/ses_h", "MODE:hang", { now: NOW })
		const queued = await slow.writeMarkdown("runs/ses_h", "never converted", { now: NOW })
		const p1 = slow.convert(hung.absPath)
		const p2 = slow.convert(queued.absPath)
		await new Promise((r) => setTimeout(r, 400))
		const started = Date.now()
		assert.equal(await slow.close(300), false)
		assert.ok(Date.now() - started < 3000)
		await Promise.all([p1, p2])
		const grandchild = Number(await fs.readFile(fake.pidFile, "utf8").catch(() => 0))
		if (grandchild) pids.push(grandchild)
		for (let i = 0; i < 50 && grandchild && isAlive(grandchild); i++) await new Promise((r) => setTimeout(r, 20))
		assert.ok(!grandchild || !isAlive(grandchild))
		const names = await fs.readdir(path.dirname(hung.absPath))
		assert.ok(!names.includes("REPORT_20261001_191312.pdf"), names.join(","))
		assert.ok(!names.some((n) => n.startsWith("REPORT_20261001_191312_2.") && !n.endsWith(".md")), names.join(","))
		assert.ok(logger.lines.some((l) => l.level === "warn" && /shutting down/.test(l.message)))
		await slow.convert(queued.absPath) // after close: skipped
	})
})

// ---- real pandoc (the image has pandoc + WeasyPrint; a dev host may have neither) ----
const has = (bin, args = ["--version"]) => !spawnSync(bin, args, { stdio: "ignore" }).error
const PANDOC = process.env.RUNTIME_PANDOC_BIN || "pandoc"
const hasPandoc = has(PANDOC)
const hasWeasy = has("weasyprint")

test("real pandoc + weasyprint: DOCX and PDF are produced", { skip: !(hasPandoc && hasWeasy) && "needs pandoc and weasyprint on PATH" }, async (t) => {
	const { workspace } = await sandbox(t)
	const logger = captureLogger()
	const exporter = new ReportExporter({ workspaceDir: workspace, pandocBin: PANDOC, logger })
	const saved = await exporter.writeMarkdown("runs/ses_real", `# Report\n\n${ANSWER}\n| a | b |\n|---|---|\n| 1 | 2 |\n`, { now: NOW })
	await exporter.convert(saved.absPath)
	const base = saved.absPath.slice(0, -3)
	assert.ok((await fs.stat(`${base}.docx`)).size > 0)
	assert.ok((await fs.stat(`${base}.pdf`)).size > 0)
	assert.deepEqual(
		(await fs.readdir(path.dirname(base))).filter((n) => n.startsWith("html2pdf")),
		[],
	)
})

test("real pandoc without weasyprint: DOCX produced, the PDF failure is logged and leaves nothing", { skip: !(hasPandoc && !hasWeasy) && "needs pandoc without weasyprint" }, async (t) => {
	const { workspace } = await sandbox(t)
	const logger = captureLogger()
	const exporter = new ReportExporter({ workspaceDir: workspace, pandocBin: PANDOC, logger })
	const saved = await exporter.writeMarkdown("runs/ses_real", `# Report\n\n${ANSWER}`, { now: NOW })
	await exporter.convert(saved.absPath)
	const base = saved.absPath.slice(0, -3)
	assert.ok((await fs.stat(`${base}.docx`)).size > 0)
	assert.equal(await fs.stat(`${base}.pdf`).catch(() => null), null)
	const failure = logger.lines.find((l) => l.level === "error")
	assert.ok(failure && failure.extra.format === "PDF", JSON.stringify(logger.lines))
	assert.deepEqual(
		(await fs.readdir(path.dirname(base))).sort(),
		["REPORT_20261001_191312.docx", "REPORT_20261001_191312.md"],
	)
})
