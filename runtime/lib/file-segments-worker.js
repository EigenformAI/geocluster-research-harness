import { pathToFileURL } from "node:url"

export const SEGMENT_PARSER = "bounded-utf8-segments-v1"

/** Decode only whole UTF-8 code points. An incomplete budget tail is not malformed input. */
export function utf8Prefix(bytes, eof = false) {
	let end = bytes.length
	if (!eof && end) {
		let lead = end - 1
		while (lead >= 0 && (bytes[lead] & 0xc0) === 0x80) lead--
		if (lead >= 0) {
			const first = bytes[lead], width = first < 0x80 ? 1 : first >= 0xc2 && first <= 0xdf ? 2 : first <= 0xef && first >= 0xe0 ? 3 : first <= 0xf4 && first >= 0xf0 ? 4 : 1
			if (lead + width > end) end = lead
		}
	}
	const prefix = bytes.subarray(0, end)
	if (prefix.includes(0)) throw new Error("NUL bytes are not supported text.")
	return { text: new TextDecoder("utf-8", { fatal: true, ignoreBOM: true }).decode(prefix), byteEnd: end }
}

function fieldText(bytes, field, absoluteStart) {
	let value = utf8Prefix(bytes.subarray(field.start + (field.quoted ? 1 : 0), field.end - (field.quoted ? 1 : 0)), true).text
	if (field.quoted) value = value.replace(/""/g, '"')
	if (absoluteStart + field.start === 0 && value.startsWith("\ufeff")) value = value.slice(1)
	return value
}

function clip(value, points, bytes = Infinity, offset = 0, responseBytes = Infinity) {
	let text = "", index = 0, size = 0, encodedSize = 0, clipped = false, stopReason
	for (const point of value) {
		if (index++ < offset) continue
		const width = Buffer.byteLength(point)
		const encodedWidth = responseBytes === Infinity ? 0 : Buffer.byteLength(JSON.stringify(point)) - 2
		if (index - offset > points || size + width > bytes || encodedSize + encodedWidth > responseBytes) {
			clipped = true; stopReason = encodedSize + encodedWidth > responseBytes ? "response-budget" : "text-limit"; break
		}
		text += point; size += width; encodedSize += encodedWidth
	}
	return { text, clipped, stopReason, end: offset + [...text].length }
}

/** Pure bounded parser. It receives bytes, never a path or a protected-store descriptor. */
export function parseSegment({ bytes, format, operation = "segment", limits, position = { offset: 0, ordinal: 1 }, sourceEof = false }) {
	bytes = Buffer.from(bytes.buffer, bytes.byteOffset, bytes.byteLength)
	if (bytes.length > limits.readBytes) { bytes = bytes.subarray(0, limits.readBytes); sourceEof = false }
	const started = performance.now(), base = position.offset, rows = []
	const result = {
		kind: format === "text" ? "text-segment" : operation === "detail" ? "cell-detail" : "table-segment",
		rows, nextPosition: null, eof: false, stopReason: "read-budget", consumedBytes: 0,
		metrics: { bytesRead: bytes.length, recordsScanned: 0, recordsReturned: 0, responseBytes: 0, elapsedMs: 0 },
	}
	if (operation === "detail") Object.assign(result, { ordinal: position.ordinal, column: position.column, text: "", valueOffset: position.valueOffset || 0, valueEnd: position.valueOffset || 0 })
	const finish = () => {
		result.metrics.recordsReturned = rows.length
		result.metrics.elapsedMs = Math.ceil(performance.now() - started)
		if (format === "text" || operation === "detail") delete result.rows
		return result
	}
	if (format === "text") {
		const length = Math.min(bytes.length, limits.textBytes)
		try {
			const decoded = utf8Prefix(bytes.subarray(0, length), sourceEof && length === bytes.length)
			const part = clip(decoded.text, Infinity, limits.textBytes, 0, Math.max(0, limits.responseBytes - 2048)), end = Buffer.byteLength(part.text)
			result.excerpt = { text: part.text, byteStart: base, byteEnd: base + end, startsMidLine: Boolean(position.startsMidLine), lineContinues: end > 0 && bytes[end - 1] !== 10 && !(sourceEof && end === bytes.length) }
			result.consumedBytes = end
			result.eof = sourceEof && end === bytes.length
			result.stopReason = result.eof ? "eof" : part.clipped ? part.stopReason : length < bytes.length ? "text-limit" : "read-budget"
			if (!result.eof && end) result.nextPosition = { offset: base + end, ordinal: position.ordinal, startsMidLine: result.excerpt.lineContinues }
		} catch (error) {
			result.excerpt = { text: "", byteStart: base, byteEnd: base, startsMidLine: Boolean(position.startsMidLine), lineContinues: false }
			result.stopReason = "encoding-unavailable"
			result.warning = error.message
		}
		return finish()
	}
	const delimiter = format === "tsv" ? 9 : 44
	const bom = base === 0 && bytes[0] === 0xef && bytes[1] === 0xbb && bytes[2] === 0xbf ? 3 : 0
	let ordinal = position.ordinal, recordStart = bom, at = bom, column = 0, fieldStart = bom, state = "start", quoted = false, fields = [], responseBytes = 0
	const selected = (n) => operation === "detail" ? n === position.column : n >= limits.columnOffset && n < limits.columnOffset + limits.columnLimit
	const endField = (end) => { if (selected(column)) fields.push({ column, start: fieldStart, end, quoted }); column++ }
	const fail = (reason, warning) => { result.stopReason = reason; if (warning) result.warning = warning; result.nextPosition = null; return finish() }
	const record = (end, next) => {
		endField(end)
		// Validate all record bytes, including unselected fields. Never silently replace malformed UTF-8.
		try { utf8Prefix(bytes.subarray(recordStart, end), true) } catch (error) { return fail("encoding-unavailable", error.message) }
		result.metrics.recordsScanned++
		if (operation === "detail") {
			const field = fields[0]
			if (!field) return fail("malformed-record", "The detail column is absent from this record.")
			const value = fieldText(bytes, field, base), offset = position.valueOffset || 0
			const part = clip(value, Infinity, limits.textBytes, offset, Math.max(0, limits.responseBytes - 2048))
			Object.assign(result, { ordinal, column: position.column, text: part.text, valueOffset: offset, valueEnd: part.end, eof: !part.clipped, stopReason: part.clipped ? part.stopReason : "eof", consumedBytes: next })
			if (part.clipped && part.end > offset) result.nextPosition = { ...position, valueOffset: part.end }
			return finish()
		}
		const cells = fields.map((field) => {
			const value = fieldText(bytes, field, base), part = clip(value, limits.displayCodepoints)
			return { column: field.column, text: part.text, clipped: part.clipped, ...(part.clipped ? { detailPosition: { offset: base + recordStart, ordinal, column: field.column, valueOffset: 0 } } : {}) }
		})
		const row = { ordinal, cells, blank: end === recordStart }
		const rowBytes = Buffer.byteLength(JSON.stringify(row)) + cells.filter((cell) => cell.clipped).length * 768
		if (responseBytes + rowBytes > limits.responseBytes - 2048) {
			result.stopReason = "response-budget"
			return finish()
		}
		rows.push(row); responseBytes += rowBytes
		result.observedColumns = Math.max(result.observedColumns || 0, column)
		result.consumedBytes = next
		ordinal++
		result.nextPosition = { offset: base + next, ordinal }
		if (rows.length >= (operation === "header" ? 1 : limits.rowLimit)) {
			result.eof = sourceEof && next === bytes.length
			result.stopReason = result.eof ? "eof" : "row-limit"
			if (result.eof) result.nextPosition = null
			return finish()
		}
		recordStart = next; fieldStart = next; fields = []; column = 0; state = "start"; quoted = false
		return null
	}
	while (at < bytes.length) {
		if ((at & 4095) === 0 && performance.now() - started >= limits.timeMs) { result.stopReason = "time-budget"; return finish() }
		const byte = bytes[at]
		if (state === "quoted") {
			if (byte === 34) state = "after-quote"
			at++; continue
		}
		if (state === "after-quote" && byte === 34) { state = "quoted"; at++; continue }
		if (byte === delimiter) {
			endField(at); at++; fieldStart = at; quoted = false; state = "start"; continue
		}
		if (byte === 10 || byte === 13) {
			if (byte === 13 && at + 1 === bytes.length && !sourceEof) break
			const next = at + (byte === 13 && bytes[at + 1] === 10 ? 2 : 1)
			const done = record(at, next)
			if (done) return done
			at = next; continue
		}
		if (state === "after-quote" || (state === "unquoted" && byte === 34)) return fail("malformed-record", "Unexpected bytes after a closing quote or a quote inside an unquoted field.")
		if (state === "start" && byte === 34) { state = "quoted"; quoted = true }
		else state = "unquoted"
		at++
	}
	if (sourceEof) {
		if (state === "quoted") return fail("malformed-record", "Unterminated quoted field at checked source EOF.")
		if (recordStart < bytes.length) {
			const done = record(bytes.length, bytes.length)
			if (done) return done
		}
		result.eof = true; result.stopReason = "eof"; result.nextPosition = null
	}
	return finish()
}

// One request per process: small JSON header, then bounded binary stdin. No filesystem input.
async function main() {
	process.stdout.write(`${JSON.stringify({ ready: true, uid: process.geteuid(), parser: SEGMENT_PARSER })}\n`)
	let header = Buffer.alloc(0), input, chunks = [], size = 0
	for await (const chunk of process.stdin) {
		let data = chunk
		if (!input) {
			header = Buffer.concat([header, chunk])
			const newline = header.indexOf(10)
			if (newline < 0) { if (header.length > 16384) throw new Error("Parser header exceeds its budget."); continue }
			if (newline > 16384) throw new Error("Parser header exceeds its budget.")
			input = JSON.parse(header.subarray(0, newline).toString("utf8")); data = header.subarray(newline + 1); header = null
			if (!Number.isSafeInteger(input.byteLength) || input.byteLength < 0 || input.byteLength > 32 * 1024 * 1024) throw new Error("Parser input exceeds its budget.")
		}
		size += data.length
		if (size > input.byteLength) throw new Error("Parser input exceeds the declared length.")
		chunks.push(data)
	}
	if (!input || size !== input.byteLength) throw new Error("Parser input was incomplete.")
	const result = input.probe ? null : parseSegment({ ...input, bytes: Buffer.concat(chunks, size) })
	process.stdout.write(`${JSON.stringify({ uid: process.geteuid(), result })}\n`)
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
	main().catch((error) => { process.stderr.write(`file-segments: ${error.message}\n`); process.exitCode = 1 })
}
