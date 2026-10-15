/**
 * Model-independent PDF reads on OpenCode 2.0.19. Only convert the bytes in an authorized, completed read;
 * never reopen its path. A rejected after hook fails the tool instead of committing successful read evidence.
 * Extracted-line offsets include page markers and lossless wraps of long lines, and are stable across reads.
 */
import { spawn } from "node:child_process"
import path from "node:path"

export const MAX_INPUT_BYTES = 16 * 1024 * 1024
export const MAX_STDOUT_BYTES = 8 * 1024 * 1024
export const MAX_STDERR_BYTES = 16 * 1024
export const TIMEOUT_MS = 10_000
export const MAX_LINES = 2000
export const MAX_CHARS = 28 * 1024
const WRAP_CHARS = 2000
const PDF_URI = "data:application/pdf;base64,"

/** Bounded subprocess adapter. No document path or engine credentials are supplied to Poppler. */
function runPoppler(bin, args, bytes, { spawnProcess = spawn, timeoutMs = TIMEOUT_MS, maxStdoutBytes = MAX_STDOUT_BYTES, maxStderrBytes = MAX_STDERR_BYTES } = {}) {
	return new Promise((resolve, reject) => {
		const child = spawnProcess(bin, args, {
			shell: false, stdio: ["pipe", "pipe", "pipe"], cwd: "/", env: { PATH: "/usr/bin:/bin", LC_ALL: "C.UTF-8" },
		})
		const stdout = [], stderr = []
		let outBytes = 0, errBytes = 0, failure = null
		const stop = (error) => {
			if (failure) return
			failure = error
			child.kill("SIGKILL")
		}
		const timer = setTimeout(() => stop(new Error(`PDF converter timed out after ${timeoutMs} ms`)), timeoutMs)
		child.on("error", (error) => { clearTimeout(timer); reject(error) })
		child.stdin.on("error", (error) => { if (error.code !== "EPIPE") stop(error) })
		child.stdout.on("data", (chunk) => {
			if (failure) return
			outBytes += chunk.length
			if (outBytes > maxStdoutBytes) return stop(new Error(`PDF extracted text exceeds ${maxStdoutBytes} byte converter output limit`))
			stdout.push(chunk)
		})
		child.stderr.on("data", (chunk) => {
			if (failure) return
			errBytes += chunk.length
			if (errBytes > maxStderrBytes) return stop(new Error(`PDF converter diagnostics exceed ${maxStderrBytes} bytes`))
			stderr.push(chunk)
		})
		child.on("close", (code, signal) => {
			clearTimeout(timer)
			if (failure) return reject(failure)
			const diagnostic = Buffer.concat(stderr).toString("utf8").trim().slice(0, 1000)
			// Poppler can recover malformed PDFs with exit 0 and syntax warnings. Do not label those as verified reads.
			if (code !== 0 || signal || diagnostic) return reject(new Error(`PDF converter failed (exit ${code}, signal ${signal ?? "none"})${diagnostic ? `: ${diagnostic}` : ""}`))
			resolve(Buffer.concat(stdout).toString("utf8"))
		})
		child.stdin.end(bytes)
	})
}

/** Both utilities ship in poppler-utils. pdfinfo rejects even encryption that permits password-free extraction. */
export async function runPdfToText(bytes, options = {}) {
	const started = Date.now()
	const timeoutMs = options.timeoutMs ?? TIMEOUT_MS
	const info = await runPoppler("/usr/bin/pdfinfo", ["-enc", "UTF-8", "-"], bytes, options)
	const encrypted = /^Encrypted:\s+(yes|no)\b/im.exec(info)?.[1].toLowerCase()
	if (!encrypted) throw new Error("PDF converter could not determine whether the PDF is encrypted")
	if (encrypted === "yes") throw new Error("PDF is encrypted; provide an unlocked PDF")
	const remaining = timeoutMs - (Date.now() - started)
	if (remaining <= 0) throw new Error(`PDF converter timed out after ${timeoutMs} ms`)
	return runPoppler("/usr/bin/pdftotext", ["-layout", "-enc", "UTF-8", "-", "-"], bytes, { ...options, timeoutMs: remaining })
}

function decode(part) {
	if (typeof part.uri !== "string" || !part.uri.startsWith(PDF_URI)) throw new Error("PDF read did not supply an inline base64 PDF")
	const base64 = part.uri.slice(PDF_URI.length)
	if (base64.length > 4 * Math.ceil(MAX_INPUT_BYTES / 3)) throw new Error(`PDF exceeds ${MAX_INPUT_BYTES} byte input limit`)
	// Buffer.from silently accepts invalid base64; the supplied content must be complete and canonical.
	if (!base64 || base64.length % 4 !== 0 || !/^[A-Za-z0-9+/]*={0,2}$/.test(base64)) throw new Error("PDF read supplied malformed base64 bytes")
	const bytes = Buffer.from(base64, "base64")
	if (bytes.length > MAX_INPUT_BYTES) throw new Error(`PDF exceeds ${MAX_INPUT_BYTES} byte input limit`)
	if (bytes.toString("base64") !== base64 || !bytes.subarray(0, 1024).includes(Buffer.from("%PDF-"))) throw new Error("PDF read supplied malformed PDF bytes")
	return bytes
}

function pageInput(input) {
	const offset = input?.offset === undefined ? 1 : input.offset
	const limit = input?.limit === undefined ? MAX_LINES : input.limit
	// The engine permits 0; PDF pagination deliberately requires positive, safe integers instead of truthy defaults.
	if (!Number.isSafeInteger(offset) || offset < 1) throw new Error("PDF offset must be a positive safe integer (1-based)")
	if (!Number.isSafeInteger(limit) || limit < 1) throw new Error("PDF limit must be a positive safe integer")
	return { offset, limit: Math.min(limit, MAX_LINES) }
}

function extractedLines(text) {
	if (typeof text !== "string") throw new Error("PDF converter returned no plaintext")
	if (Buffer.byteLength(text, "utf8") > MAX_STDOUT_BYTES) throw new Error(`PDF extracted text exceeds ${MAX_STDOUT_BYTES} byte converter output limit`)
	if (!text.trim()) throw new Error("PDF has no extractable text (empty or scanned); OCR is required for scanned pages")
	if (text.includes("\0")) throw new Error("PDF converter returned invalid plaintext")
	const pages = text.replace(/\r\n?/g, "\n").split("\f")
	// pdftotext emits one final form feed; it is a terminator, not another page.
	if (pages.length > 1 && !pages.at(-1).trim()) pages.pop()
	const lines = []
	for (const [index, raw] of pages.entries()) {
		const page = index + 1
		lines.push({ page, text: `[Page ${page}]` })
		const body = raw.replace(/\n$/, "")
		if (!body.trim()) {
			lines.push({ page, text: "[No extractable text on this page; image content was not read]" })
			continue
		}
		for (let line of body.split("\n")) {
			while (line.length > WRAP_CHARS) {
				const end = /[\uD800-\uDBFF]/.test(line[WRAP_CHARS - 1]) ? WRAP_CHARS - 1 : WRAP_CHARS
				lines.push({ page, text: line.slice(0, end) })
				line = line.slice(end)
			}
			lines.push({ page, text: line })
		}
	}
	return { lines, pages: pages.length }
}

function select(text, filename, input) {
	const { offset, limit } = pageInput(input)
	const { lines, pages } = extractedLines(text)
	if (offset > lines.length) throw new Error(`PDF offset ${offset} is out of range (${lines.length} extracted lines); read with offset 1`)
	const header = `Read PDF ${JSON.stringify(filename)}, extracted lines from ${offset} of ${lines.length} (page ${lines[offset - 1].page}; text only, images not read)\n`
	const continuation = (next) => `\n[Output truncated. Continue reading with offset: ${next}, limit: ${limit}]`
	const reserve = continuation(lines.length).length
	const numbered = [], selected = []
	let size = header.length
	for (let i = offset - 1; i < lines.length && selected.length < limit; i++) {
		const row = `${i + 1}: ${lines[i].text}`
		const added = row.length + (numbered.length ? 1 : 0)
		if (size + added + reserve > MAX_CHARS) break
		numbered.push(row)
		selected.push(lines[i].text)
		size += added
	}
	if (!selected.length) throw new Error("PDF filename leaves no room for bounded text; use a shorter filename")
	const next = offset + selected.length
	const truncated = next <= lines.length
	return {
		content: [{ type: "text", text: header + numbered.join("\n") + (truncated ? continuation(next) : "") }],
		output: { type: "text-page", mime: "text/plain", content: selected.join("\n"), offset, truncated, ...(truncated ? { next } : {}) },
		metadata: { truncated, pdf: { pages, totalLines: lines.length, ...(truncated ? { nextOffset: next } : {}) } },
	}
}

export async function setup(ctx, { runner = runPdfToText } = {}) {
	await ctx.tool.hook("execute.after", async (e) => {
		if (e.tool !== "read" || e.status !== "completed" || !Array.isArray(e.result?.content)) return
		const parts = e.result.content.filter((p) => p?.type === "file" && (p.mime === "application/pdf" || p.uri?.startsWith("data:application/pdf")))
		if (!parts.length) return
		const source = parts[0].name ?? e.input?.path
		const filename = typeof source === "string" ? path.relative(ctx.location.directory, path.resolve(ctx.location.directory, source)) : "(unnamed PDF)"
		try {
			if (parts.length !== 1) throw new Error("PDF read supplied multiple PDF attachments")
			pageInput(e.input)
			const bytes = decode(parts[0])
			const converted = select(await runner(bytes), filename, e.input)
			e.result = { ...e.result, ...converted, metadata: { ...e.result.metadata, ...converted.metadata } }
		} catch (error) {
			// Do not return a success-shaped error string: RE-4 records completed read calls as evidence.
			throw new Error(`Agent "${e.agent ?? "unknown"}" (read) could not extract PDF ${JSON.stringify(filename)}: ${String(error?.message ?? error).slice(0, 1200)}. Next step: provide a valid, unlocked text PDF or extracted text; for scanned pages, provide OCR text.`, { cause: error })
		}
	})
}
