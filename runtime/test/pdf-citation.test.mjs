import assert from "node:assert/strict"
import { test } from "node:test"
import { findFabricatedCitations } from "../lib/citation-guard.js"
import { TurnTracker } from "../lib/turn-tracker.js"

test("RE-4 rejects unread PDF basenames, including quoted uppercase filenames and later clauses", () => {
	assert.deepEqual(findFabricatedCitations('[source: ore.pdf | p:1] [source: "UNREAD.PDF" | p:2]', []), ["ore.pdf", "UNREAD.PDF"])
	assert.deepEqual(findFabricatedCitations("[source: read.pdf | p:1; invented.pdf | p:2]", ["/workspace/reports/read.pdf"]), ["invented.pdf"])
})

test("RE-4 allows original PDF page citations only after a successful read", () => {
	const tracker = new TurnTracker({ cwd: "/workspace" })
	const start = (id, file) => tracker.onUpdate({ sessionUpdate: "tool_call", toolCallId: id, title: "read", kind: "read", status: "in_progress", rawInput: { path: file } })
	start("good", "reports/ore.pdf")
	tracker.onUpdate({ sessionUpdate: "tool_call_update", toolCallId: "good", status: "completed" })
	start("bad", "reports/scanned.pdf")
	tracker.onUpdate({ sessionUpdate: "tool_call_update", toolCallId: "bad", status: "failed" })
	tracker.onUpdate({ sessionUpdate: "tool_call_update", toolCallId: "bad", status: "completed" })
	assert.deepEqual([...tracker.reads], ["/workspace/reports/ore.pdf"])
	assert.deepEqual(findFabricatedCitations("[source: ore.pdf | p:1] [source: reports/ore.pdf | p:2] [source: scanned.pdf | p:1]", tracker.reads), ["scanned.pdf"])
	assert.deepEqual(tracker.stats, { committed: 1, failed: 1, completedWithoutPath: 0, pending: 0 })
})
