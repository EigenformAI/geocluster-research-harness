import assert from "node:assert/strict"
import { FileSegments } from "../file-segments.js"

assert.equal(process.getuid(), 998, "Run this smoke check as UID 998 inside the isolated container.")
const values = new Map()
const state = {
	get: async (kind, id) => values.get(kind + id),
	claim: async (kind, id, intent, record) => { values.set(kind + id, record); return { record } },
}
const parser = new FileSegments({ state, ownership: {
	agentUids: [999], workerUids: [997],
	workerBridge: { uid: 997, command: "/opt/geocluster-runtime/lib/preview-launcher/build/preview-launcher" },
} })
await parser.init()
if (process.argv.includes("--expect-unavailable")) {
	assert.equal(parser.availability.state, "unavailable")
	assert.throws(() => parser.requireAvailable(), (error) => error.error === "worker_unavailable")
	await parser.close()
	console.log("PASS: kernel-blocked setuid leaves parser capability unavailable")
} else {
	parser.requireAvailable()
	const source = { kind: "runtime-capture", captureId: "smoke", etag: "exact", sizeBytes: 8, ref: { workspaceId: "w", workspaceEpoch: "e", path: "a.csv" } }
	const csv = await parser.parse(source, Buffer.from("a,b\n1,2\n"), parser.normalize({ format: "csv" }), { offset: 0, ordinal: 1 }, true)
	const text = await parser.parse(source, Buffer.from("hello\n"), parser.normalize({ format: "text" }), { offset: 0, ordinal: 1 }, true)
	assert.equal(csv.rows[1].cells[0].text, "1")
	assert.equal(text.excerpt.text, "hello\n")
	await parser.close()
	console.log("PASS: unprivileged service 998 receives CSV/text previews from verified parser 997 without extra container capabilities")
}
