import assert from "node:assert/strict"
import { spawn } from "node:child_process"
import { EventEmitter } from "node:events"
import { existsSync } from "node:fs"
import path from "node:path"
import { PassThrough } from "node:stream"
import { test } from "node:test"
import { fakeCtx } from "./fake-ctx.mjs"
import { setup, runPdfToText, MAX_INPUT_BYTES, MAX_STDOUT_BYTES, MAX_CHARS, MAX_LINES } from "../config/lib/pdf-read.js"

const PDF = Buffer.from("%PDF-1.4\nfixture bytes\n%%EOF")
const event = (input = {}) => ({
	tool: "read", agent: "report-analysis", sessionID: "ses_root", id: "pdf1", status: "completed",
	input: { path: "/workspace/reports/ore.pdf", ...input },
	result: {
		output: { type: "file", mime: "application/pdf", encoding: "base64", content: PDF.toString("base64") },
		content: [{ type: "text", text: "PDF read successfully" }, { type: "file", mime: "application/pdf", name: "/workspace/reports/ore.pdf", uri: `data:application/pdf;base64,${PDF.toString("base64")}` }],
		metadata: { truncated: false },
	},
})
const textOf = (e) => e.result.content.map((p) => p.text).join("\n")
async function hook(runner) {
	const fake = fakeCtx({ directory: "/workspace" })
	await setup(fake.ctx, { runner })
	return (e) => fake.fire("tool", "execute.after", e)
}

test("PDF read replaces the engine placeholder and binary with page-labelled original-file evidence", async () => {
	const fire = await hook(async (bytes) => {
		assert.deepEqual(bytes, PDF, "convert the authorized bytes, not a reopened path")
		return "Ore grade 2.4 g/t\n\fReserve 18 Mt\n\f"
	})
	const e = event()
	await fire(e)
	assert.match(textOf(e), /reports\/ore\.pdf/)
	assert.match(textOf(e), /Page 1[\s\S]*Ore grade 2\.4 g\/t[\s\S]*Page 2[\s\S]*Reserve 18 Mt/)
	assert.ok(e.result.content.every((p) => p.type === "text"), "no PDF attachment may reach a text model")
	assert.doesNotMatch(JSON.stringify(e.result), /PDF read successfully|data:application\/pdf|base64/)
	assert.equal(e.result.output.type, "text-page")
})

test("empty/scanned PDF extraction rejects the hook, never returns a completed read", async () => {
	const fire = await hook(async () => "\n\f\n\f")
	await assert.rejects(fire(event()), /report-analysis.*read[\s\S]*no extractable text[\s\S]*Next step:/i)
})

test("non-PDF reads preserve content and never invoke the converter", async () => {
	const fire = await hook(async () => assert.fail("non-PDF converted"))
	for (const content of ["Read file note.md, lines 1-1\n1: hello", [{ type: "file", mime: "image/png", uri: "data:image/png;base64,AAAA" }]]) {
		const e = { ...event(), result: { content, metadata: { truncated: false } } }
		const original = e.result
		await fire(e)
		assert.equal(e.result, original)
	}
})

test("only completed read results are converted; failures and other tools stay untouched", async () => {
	const fire = await hook(async () => assert.fail("unauthorized or unsuccessful result converted"))
	for (const change of [{ status: "error" }, { tool: "shell" }]) {
		const e = { ...event(), ...change }
		const original = e.result
		await fire(e)
		assert.equal(e.result, original)
	}
})

test("offset and limit require positive safe integers, before any converter runs", async () => {
	const fire = await hook(async () => assert.fail("invalid page arguments converted"))
	for (const key of ["offset", "limit"]) {
		for (const value of [0, -1, 1.5, "2", null, false, NaN, Infinity, Number.MAX_SAFE_INTEGER + 1]) {
			await assert.rejects(fire(event({ [key]: value })), new RegExp(`PDF ${key} must be a positive safe integer`))
		}
	}
})

test("line limit and mid-page continuation never skip or repeat extracted lines", async () => {
	const fire = await hook(async () => "first\nsecond\n\fthird\n\f")
	const first = event({ limit: 2 })
	await fire(first)
	assert.equal(first.result.output.content, "[Page 1]\nfirst")
	assert.equal(first.result.output.next, 3)
	assert.match(textOf(first), /offset: 3, limit: 2/)
	const rest = event({ offset: 3, limit: 20 })
	await fire(rest)
	assert.match(textOf(rest), /page 1/)
	assert.equal(rest.result.output.content, "second\n[Page 2]\nthird")
	assert.equal(rest.result.output.truncated, false)
	assert.equal(rest.result.output.next, undefined)
	await assert.rejects(fire(event({ offset: 6 })), /out of range \(5 extracted lines\)/)
})

test("the 2000-line ceiling applies even to an oversized requested limit", async () => {
	const fire = await hook(async () => Array.from({ length: 2500 }, (_, i) => `v${i}`).join("\n") + "\f")
	const first = event({ limit: 100_000 })
	await fire(first)
	assert.equal(first.result.output.content.split("\n").length, MAX_LINES)
	assert.equal(first.result.output.next, 2001)
	const rest = event({ offset: first.result.output.next })
	await fire(rest)
	assert.match(textOf(rest), /2001: v1999/)
	assert.equal(rest.result.output.truncated, false)
})

test("character-capped continuation preserves long lines losslessly and keeps Unicode intact", async () => {
	const long = "🔷".repeat(40_000) + "TAIL"
	const fire = await hook(async () => `${long}\nsecond\f`)
	let offset = 1, recovered = "", calls = 0
	do {
		const e = event({ offset })
		await fire(e)
		assert.ok(textOf(e).length <= MAX_CHARS)
		assert.equal(textOf(e).includes("\uFFFD"), false)
		recovered += e.result.output.content.replace(/^\[Page 1\]\n/, "").replace(/\n/g, "")
		if (!e.result.output.truncated) break
		assert.ok(e.result.output.next > offset)
		assert.equal(e.result.output.next, offset + e.result.output.content.split("\n").length)
		offset = e.result.output.next
		assert.ok(++calls < 10)
	} while (true)
	assert.equal(recovered, long + "second")
})

test("missing, malformed, and oversized inline bytes fail without running a converter", async () => {
	const fire = await hook(async () => assert.fail("invalid bytes converted"))
	for (const uri of ["file:///workspace/reports/ore.pdf", "data:application/pdf;base64,AA?=", "data:application/pdf;base64,AAAA", `data:application/pdf;base64,${Buffer.alloc(MAX_INPUT_BYTES + 1, 65).toString("base64")}`]) {
		const e = event()
		e.result.content[1].uri = uri
		await assert.rejects(fire(e), /inline base64 PDF|malformed|input limit/)
	}
})

test("converter errors and output overflow reject; plaintext is never reported as a successful failure", async () => {
	for (const runner of [async () => { throw new Error("Incorrect password") }, async () => "a".repeat(MAX_STDOUT_BYTES + 1), async () => "bad\0text", async () => null]) {
		await assert.rejects((await hook(runner))(event()), /report-analysis.*read[\s\S]*Next step:/)
	}
})

/** A controllable subprocess, exercising the real bounded adapter without installed binaries. */
function fakeSpawn({ mode = "ok", text = "grade 2.4\f" } = {}) {
	const calls = []
	const spawnProcess = (bin, args, options) => {
		const child = new EventEmitter()
		child.stdin = new PassThrough()
		child.stdout = new PassThrough()
		child.stderr = new PassThrough()
		const input = []
		const call = { bin, args, options, input, killed: null }
		calls.push(call)
		child.kill = (signal) => { call.killed = signal; queueMicrotask(() => child.emit("close", null, signal)); return true }
		child.stdin.on("data", (bytes) => input.push(bytes))
		child.stdin.on("finish", () => queueMicrotask(() => {
			if (bin.endsWith("pdfinfo")) {
				child.stdout.write(`Encrypted: ${mode === "encrypted" ? "yes" : "no"}\n`)
				child.emit("close", 0, null)
				return
			}
			if (mode === "hang") return
			if (mode === "stderr") child.stderr.write("x".repeat(100))
			else if (mode === "warning") child.stderr.write("Syntax Warning: damaged PDF")
			else if (mode === "error") { child.emit("error", new Error("ENOENT")); return }
			else child.stdout.write(text)
			child.emit("close", mode === "fail" ? 1 : 0, null)
		}))
		return child
	}
	return { spawnProcess, calls }
}

test("Poppler uses fixed executables, stdin bytes and no shell/path/engine secrets", async () => {
	const fake = fakeSpawn()
	assert.equal(await runPdfToText(PDF, fake), "grade 2.4\f")
	assert.deepEqual(fake.calls.map((c) => [c.bin, c.args]), [
		["/usr/bin/pdfinfo", ["-enc", "UTF-8", "-"]],
		["/usr/bin/pdftotext", ["-layout", "-enc", "UTF-8", "-", "-"]],
	])
	for (const call of fake.calls) {
		assert.deepEqual(Buffer.concat(call.input), PDF)
		assert.equal(call.options.shell, false)
		assert.deepEqual(call.options.env, { PATH: "/usr/bin:/bin", LC_ALL: "C.UTF-8" })
	}
})

test("timeout, stdout/stderr caps, nonzero exit, spawn failure, and syntax warnings all reject", async () => {
	for (const [mode, options, expected] of [
		["hang", { timeoutMs: 30 }, /timed out/],
		["ok", { maxStdoutBytes: 25 }, /output limit/],
		["stderr", { maxStderrBytes: 20 }, /diagnostics exceed/],
		["fail", {}, /exit 1/],
		["error", {}, /ENOENT/],
		["warning", {}, /Syntax Warning/],
	]) {
		const fake = fakeSpawn({ mode, text: "x".repeat(100) })
		await assert.rejects(runPdfToText(PDF, { ...fake, ...options }), expected)
		if (["hang", "ok", "stderr"].includes(mode)) assert.equal(fake.calls.at(-1).killed, "SIGKILL")
	}
})

test("encryption is a failure even if text extraction would otherwise work", async () => {
	const fake = fakeSpawn({ mode: "encrypted" })
	await assert.rejects(runPdfToText(PDF, fake), /encrypted.*unlocked/)
	assert.equal(fake.calls.length, 1, "do not extract or expose text from an encrypted PDF")
})

/** Minimal valid two-page PDF, kept as supplied bytes: no test document path is ever created. */
function tinyPdf() {
	const stream = (s) => `<< /Length ${Buffer.byteLength(s)} >>\nstream\n${s}endstream`
	const objects = [
		"<< /Type /Catalog /Pages 2 0 R >>",
		"<< /Type /Pages /Kids [3 0 R 5 0 R] /Count 2 >>",
		"<< /Type /Page /Parent 2 0 R /MediaBox [0 0 300 300] /Resources << /Font << /F1 7 0 R >> >> /Contents 4 0 R >>",
		stream("BT /F1 12 Tf 30 240 Td (Ore grade 2.4 g/t) Tj ET\n"),
		"<< /Type /Page /Parent 2 0 R /MediaBox [0 0 300 300] /Resources << /Font << /F1 7 0 R >> >> /Contents 6 0 R >>",
		stream("BT /F1 12 Tf 30 240 Td (Reserve 18 Mt) Tj ET\n"),
		"<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>",
	]
	let pdf = "%PDF-1.4\n"
	const offsets = [0]
	objects.forEach((obj, i) => { offsets.push(Buffer.byteLength(pdf)); pdf += `${i + 1} 0 obj\n${obj}\nendobj\n` })
	const xref = Buffer.byteLength(pdf)
	pdf += `xref\n0 ${offsets.length}\n0000000000 65535 f \n${offsets.slice(1).map((n) => `${String(n).padStart(10, "0")} 00000 n \n`).join("")}trailer\n<< /Size ${offsets.length} /Root 1 0 R >>\nstartxref\n${xref}\n%%EOF\n`
	return Buffer.from(pdf)
}

const realBin = process.env.PDFTOTEXT_TEST_BIN ?? "/usr/bin/pdftotext"
test("real Poppler converts a tiny PDF from supplied bytes and rejects malformed PDF bytes", { skip: !existsSync(realBin) && "requires poppler-utils" }, async () => {
	const runner = (bytes) => runPdfToText(bytes, { spawnProcess: (bin, args, options) => spawn(path.join(path.dirname(realBin), path.basename(bin)), args, options) })
	const e = event({ path: "/workspace/never-created.pdf" })
	e.result.content[1] = { type: "file", mime: "application/pdf", name: "/workspace/never-created.pdf", uri: `data:application/pdf;base64,${tinyPdf().toString("base64")}` }
	await (await hook(runner))(e)
	assert.match(textOf(e), /Page 1[\s\S]*Ore grade 2\.4 g\/t[\s\S]*Page 2[\s\S]*Reserve 18 Mt/)
	assert.equal(e.result.metadata.pdf.pages, 2)
	await assert.rejects((await hook(runner))(event()), /converter failed/)
})
