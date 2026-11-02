import assert from "node:assert/strict"
import test from "node:test"
import { ProcessingWaits, processingEvent, readProductText, summarizeResult } from "../lib/processing-operations.js"

test("bounded processing summaries retain quality independently of inventory pagination", () => {
	const manifest = { resultId: "result_one", outcome: "partial", source: { sha256: "a".repeat(64), bytes: 10 }, coverage: { total: 2, completed: 1 }, stages: [{ id: "ocr", coverage: { total: 2, completed: 2 } }], provenance: { adapter: "pdf" }, tables: Array.from({ length: 3 }, (_, i) => ({ id: `table_${i}`, rows: 4, confirmation: i ? "unresolved" : "confirmed" })), products: [{ id: "csv" }], findings: [{ code: "unresolved_table" }] }
	const summary = summarizeResult(manifest, { id: "job_one", state: "partial", modelSelection: { selectedModel: "provider/model" } }, { limit: 1 })
	assert.deepEqual(summary.coverage, { total: 2, completed: 1 })
	assert.deepEqual(summary.stages, manifest.stages)
	assert.equal(summary.outcome, "partial")
	assert.deepEqual(summary.tableConfirmation, { confirmed: 1, unresolved: 2 })
	assert.equal(summary.tables.length, 1)
	assert.equal(summary.tables[0].rows, 4)
	assert.equal(summary.tables[0].header, "not-inferred")
	assert.equal(summary.navigation.tables.nextOffset, 1)
	assert.equal(summary.navigation.tables.total, 3)
	assert.equal(summary.truncated, true)
	assert.equal(summary.selectedModel, "provider/model")
})

test("oversized inventory records never crowd quality or findings out of a summary", () => {
	const summary = summarizeResult({ resultId: "result", outcome: "partial", coverage: { completed: 1, total: 2 }, stages: [{ id: "page-ocr", completed: 2 }], products: [{ id: "large", description: "x".repeat(100000) }, { id: "next" }], findings: [{ code: "confirmation_unresolved" }], tables: [{ id: "table", rows: 4, columns: Array(10000).fill({ label: "Column" }) }] }, {}, { maxBytes: 4096 })
	assert.ok(Buffer.byteLength(JSON.stringify(summary)) <= 4096)
	assert.equal(summary.products[0].id, "large")
	assert.equal(summary.products[0].truncated, true)
	assert.equal(summary.navigation.products.nextOffset, 1)
	assert.equal(summary.findings[0].code, "confirmation_unresolved")
	assert.deepEqual(summary.coverage, { completed: 1, total: 2 })
	assert.deepEqual(summary.stages, [{ id: "page-ocr", completed: 2 }])
	assert.equal(summary.truncated, true)
})

test("wait observes transitions, returns terminal failure without results and never submits", async () => {
	const waits = new ProcessingWaits({ pollMs: 1, random: () => 0.5 })
	let calls = 0
	const changed = await waits.wait("session", { requestId: "request" }, async () => ({ state: ++calls > 1 ? "running" : "queued", resultAvailable: false }), { timeoutMs: 100 })
	assert.equal(changed.state, "running")
	assert.equal(changed.timedOut, false)
	const failed = await waits.wait("session", { jobId: "job" }, async () => ({ state: "failed", resultAvailable: false }), { timeoutMs: 100 })
	assert.equal(failed.state, "failed")
	assert.equal(failed.resultAvailable, false)
	assert.equal(failed.timedOut, false)
})

test("same-caller waits are exclusive and abort releases observation, not execution", async () => {
	const waits = new ProcessingWaits({ pollMs: 1 }), controller = new AbortController()
	let observed
	const started = new Promise((resolve) => { observed = resolve })
	const pending = waits.wait("session", { jobId: "job" }, async () => { observed(); return { state: "running", resultAvailable: false } }, { timeoutMs: 1000, signal: controller.signal })
	await started
	await assert.rejects(waits.wait("session", { jobId: "job" }, async () => ({})), (error) => error.code === "WAIT_IN_PROGRESS" && typeof error.waitId === "string")
	controller.abort()
	await assert.rejects(pending, (error) => error.name === "AbortError")
	const next = await waits.wait("session", { jobId: "job" }, async () => ({ state: "succeeded", resultAvailable: true }))
	assert.equal(next.state, "succeeded")
})

test("unchanged progress times out with handles; owner drain aborts pending observations", async () => {
	const waits = new ProcessingWaits({ pollMs: 1 })
	const result = await waits.wait("session", { requestId: "request", jobId: "job" }, async () => ({ state: "running", resultAvailable: false, lastCheckedAt: Date.now() }), { timeoutMs: 5 })
	assert.equal(result.timedOut, true)
	assert.equal(result.requestId, "request")
	assert.equal(result.jobId, "job")
	const pending = waits.wait("session", { jobId: "job" }, async () => ({ state: "running" }), { timeoutMs: 1000 })
	waits.abortAll()
	await assert.rejects(pending, (error) => error.name === "AbortError")
})

test("an unresponsive status transport cannot exceed the observation deadline", async () => {
	const waits = new ProcessingWaits({ pollMs: 1 })
	let calls = 0
	const result = await waits.wait("session", { jobId: "job" }, async () => ++calls === 1 ? { state: "running", resultAvailable: false } : new Promise(() => {}), { timeoutMs: 10 })
	assert.equal(result.timedOut, true)
	assert.equal(result.state, "running")
	assert.equal(result.jobId, "job")
})

test("text reads report exact UTF-8 byte ranges without splitting characters", async () => {
	const bytes = Buffer.from("AéB\nC"), product = { id: "text", bytes: bytes.length, mediaType: "text/plain", sha256: "a".repeat(64) }
	const download = async ({ headers }) => {
		const [, start, end] = /^bytes=(\d+)-(\d+)$/.exec(headers.range)
		const value = bytes.subarray(Number(start), Math.min(Number(end) + 1, bytes.length))
		return new Response(value, { status: 206, headers: { "content-range": `bytes ${start}-${Number(start) + value.length - 1}/${bytes.length}` } })
	}
	const first = await readProductText(product, download, { limit: 2 })
	assert.equal(first.text, "A")
	assert.deepEqual(first.range, { offset: 0, bytes: 1 })
	assert.equal(first.nextOffset, 1)
	const second = await readProductText(product, download, { offset: first.nextOffset, limit: 4 })
	assert.equal(second.text, "éB\n")
	assert.deepEqual(second.range, { offset: 1, bytes: 4 })
	await assert.rejects(readProductText(product, async () => new Response("wrong"), { limit: 2 }), (error) => error.code === "PRODUCT_INTEGRITY")
})

test("processing events contain bounded operational identity, never source text or credentials", () => {
	const entries = [], logger = { info(event, fields) { entries.push({ event, fields }) } }
	processingEvent(logger, "export.verified", { workspaceId: "workspace", requestId: "request", jobId: "job", sourceSha256: "a".repeat(64), bytes: 72, destinationSha256: "b".repeat(64), token: "private", submissionKey: "private", source: { text: "private" }, path: "/private/processor/data", modelOutput: "private", rootId: "oversized".repeat(100) })
	assert.deepEqual(entries, [{ event: "processing.export.verified", fields: { workspaceId: "workspace", requestId: "request", jobId: "job", sourceSha256: "a".repeat(64), bytes: 72, destinationSha256: "b".repeat(64) } }])
	assert.doesNotThrow(() => processingEvent({ info() { throw new Error("failed log") } }, "wait.expired", {}))
	assert.doesNotThrow(() => processingEvent(logger, "untrusted-name\nprivate", {}))
	assert.equal(entries.length, 1)
})
