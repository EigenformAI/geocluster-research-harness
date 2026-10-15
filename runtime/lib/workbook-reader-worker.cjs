"use strict"
const XLSX = require("xlsx")
const { SaxesParser } = require("saxes")
const { inflateRawSync } = require("node:zlib")
const { createHash } = require("node:crypto")
const fs = require("node:fs")
const net = require("node:net")
const { spawn } = require("node:child_process")
const { once } = require("node:events")

const PARSER = "sheetjs-ce/0.20.3+native-workbook/3"
const fail = (reason, message) => { throw Object.assign(new Error(message), { reason }) }
const check = (ok, reason, message) => { if (!ok) fail(reason, message) }
const memoryFailure = error => ["ERR_MEMORY_ALLOCATION_FAILED", "ENOMEM"].includes(error.code) || error instanceof RangeError && /array buffer allocation failed|out of memory/i.test(error.message)
// Do not expose library diagnostics or workbook contents through stderr.
console.log = console.warn = console.error = () => {}

function crc32(bytes) {
	let crc = -1
	for (const byte of bytes) { crc ^= byte; for (let bit = 0; bit < 8; bit++) crc = (crc >>> 1) ^ (0xedb88320 & -(crc & 1)) }
	return (crc ^ -1) >>> 0
}

/** Validate local/central coverage, CRC and actual bounded inflation before SheetJS sees any bytes. */
function unzip(bytes, limits) {
	let end = bytes.length - 22
	while (end >= Math.max(0, bytes.length - 65557) && bytes.readUInt32LE(end) !== 0x06054b50) end--
	check(end >= 0 && end + 22 <= bytes.length, "malformed", "ZIP end record is missing.")
	check(end + 22 + bytes.readUInt16LE(end + 20) === bytes.length, "malformed", "ZIP has trailing data.")
	check(!bytes.readUInt16LE(end + 4) && !bytes.readUInt16LE(end + 6), "unsupported", "Multi-disk ZIP is unsupported.")
	const count = bytes.readUInt16LE(end + 10), offset = bytes.readUInt32LE(end + 16), size = bytes.readUInt32LE(end + 12)
	check(count !== 65535 && offset !== 0xffffffff && size !== 0xffffffff && !(end >= 20 && bytes.readUInt32LE(end - 20) === 0x07064b50), "unsupported", "ZIP64 is unsupported.")
	check(count === bytes.readUInt16LE(end + 8) && offset + size === end, "malformed", "ZIP directory bounds are invalid.")
	check(count <= limits.zipEntries, "budget", "ZIP entry count exceeds the configured limit.")
	const members = new Map(), names = new Set(), regions = []; let p = offset, expandedBytes = 0
	const extras = (start, length) => {
		const last = start + length
		while (start < last) { check(start + 4 <= last, "malformed", "ZIP extra field is truncated."); check(bytes.readUInt16LE(start) !== 1, "unsupported", "ZIP64 is unsupported."); start += 4 + bytes.readUInt16LE(start + 2); check(start <= last, "malformed", "ZIP extra field exceeds its bounds.") }
	}
	for (let i = 0; i < count; i++) {
		check(p + 46 <= end && bytes.readUInt32LE(p) === 0x02014b50, "malformed", "ZIP central entry is invalid.")
		const flags = bytes.readUInt16LE(p + 8), method = bytes.readUInt16LE(p + 10), crc = bytes.readUInt32LE(p + 16), compressed = bytes.readUInt32LE(p + 20), expanded = bytes.readUInt32LE(p + 24)
		const nl = bytes.readUInt16LE(p + 28), el = bytes.readUInt16LE(p + 30), cl = bytes.readUInt16LE(p + 32), local = bytes.readUInt32LE(p + 42)
		check(!(flags & 0x41), "encrypted", "Encrypted workbook ZIP members are unsupported.")
		check(!(flags & ~0x080e) && [0, 8].includes(method) && !bytes.readUInt16LE(p + 34), "unsupported", "ZIP compression or flags are unsupported.")
		check(![compressed, expanded, local].includes(0xffffffff), "unsupported", "ZIP64 is unsupported.")
		check(p + 46 + nl + el + cl <= end && local + 30 <= offset, "malformed", "ZIP entry exceeds its bounds."); extras(p + 46 + nl, el)
		const filename = bytes.subarray(p + 46, p + 46 + nl)
		check(filename.every(b => b > 31 && b < 127), "unsupported", "ZIP package member names must be ASCII.")
		const name = filename.toString("ascii"), normalized = name.replace(/\/$/, "")
		check(normalized && !name.startsWith("/") && !/[\\:]/.test(name) && !normalized.split("/").some(s => !s || s === "." || s === ".."), "malformed", "ZIP member path is invalid.")
		check(!names.has(normalized.toLowerCase()), "malformed", "ZIP member names collide."); names.add(normalized.toLowerCase())
		check((bytes.readUInt32LE(p + 38) >>> 16 & 0xf000) !== 0xa000, "malformed", "ZIP symlinks are unsupported.")
		check(bytes.readUInt32LE(local) === 0x04034b50 && bytes.readUInt16LE(local + 6) === flags && bytes.readUInt16LE(local + 8) === method, "malformed", "ZIP local entry does not match its directory.")
		const lnl = bytes.readUInt16LE(local + 26), lel = bytes.readUInt16LE(local + 28), data = local + 30 + lnl + lel
		check(data + compressed <= offset && lnl === nl && bytes.subarray(local + 30, local + 30 + lnl).equals(filename), "malformed", "ZIP local data exceeds its bounds."); extras(local + 30 + lnl, lel)
		let last = data + compressed
		if (flags & 8) {
			check([0, crc].includes(bytes.readUInt32LE(local + 14)) && [0, compressed].includes(bytes.readUInt32LE(local + 18)) && [0, expanded].includes(bytes.readUInt32LE(local + 22)), "malformed", "ZIP local sizes are inconsistent.")
			check(last + 12 <= offset, "malformed", "ZIP descriptor is missing."); if (bytes.readUInt32LE(last) === 0x08074b50) last += 4
			check(last + 12 <= offset && bytes.readUInt32LE(last) === crc && bytes.readUInt32LE(last + 4) === compressed && bytes.readUInt32LE(last + 8) === expanded, "malformed", "ZIP descriptor is inconsistent."); last += 12
		} else check(bytes.readUInt32LE(local + 14) === crc && bytes.readUInt32LE(local + 18) === compressed && bytes.readUInt32LE(local + 22) === expanded, "malformed", "ZIP local sizes are inconsistent.")
		regions.push([local, last])
		check(expanded <= limits.memberBytes && expandedBytes + expanded <= limits.expandedBytes, "budget", "ZIP expansion exceeds the configured limit.")
		let inflated
		try {
			inflated = method === 0 ? bytes.subarray(data, data + compressed) : inflateRawSync(bytes.subarray(data, data + compressed), { maxOutputLength: Math.max(1, Math.min(limits.memberBytes, limits.expandedBytes - expandedBytes)), info: true })
			if (method === 8) { check(inflated.engine.bytesWritten === compressed, "malformed", "ZIP compressed data has trailing bytes."); inflated = inflated.buffer }
		} catch (e) { if (e.reason) throw e; fail(e.code === "ERR_BUFFER_TOO_LARGE" ? "budget" : "malformed", "ZIP inflation failed or exceeded its limit.") }
		expandedBytes += inflated.length
		check(expandedBytes <= limits.expandedBytes && inflated.length <= limits.memberBytes, "budget", "Actual ZIP expansion exceeds the configured limit.")
		check(inflated.length === expanded && crc32(inflated) === crc, "malformed", "ZIP actual length or checksum differs from its declaration.")
		if (/\.(xml|rels)$/i.test(name)) check(!/<!DOCTYPE|<!ENTITY/i.test(inflated.toString("utf8")), "unsupported", "Workbook XML DTDs and entities are unsupported.")
		members.set(name, inflated); p += 46 + nl + el + cl
	}
	check(p === end, "malformed", "ZIP directory length is invalid."); regions.sort((a, b) => a[0] - b[0]); let covered = 0
	for (const [first, last] of regions) { check(first === covered, "malformed", "ZIP contains overlapping or unindexed local bytes."); covered = last }
	check(covered === offset, "malformed", "ZIP contains unindexed local bytes.")
	check(members.has("xl/workbook.xml"), "unsupported", "The ZIP is not an XLSX workbook.")
	return { members, expandedBytes }
}

/** Bounded CFB chain walking, including mini streams, precedes the general BIFF decoder. */
function biffPreflight(bytes, limits) {
	check(bytes.length >= 512 && bytes.readUInt16LE(28) === 0xfffe, "malformed", "CFB header is invalid.")
	const major = bytes.readUInt16LE(26), shift = bytes.readUInt16LE(30), sectorSize = 2 ** shift
	check((major === 3 && shift === 9 || major === 4 && shift === 12) && bytes.readUInt16LE(32) === 6 && bytes.readUInt32LE(56) === 4096, "malformed", "CFB sector geometry is invalid.")
	check(bytes.length % sectorSize === 0 && bytes.length >= sectorSize * 2, "malformed", "CFB sectors are truncated.")
	const sectors = bytes.length / sectorSize - 1, fatCount = bytes.readUInt32LE(44), difCount = bytes.readUInt32LE(72), miniCount = bytes.readUInt32LE(64), dirCount = bytes.readUInt32LE(40)
	check(fatCount > 0 && fatCount <= sectors && difCount <= sectors && miniCount <= sectors && (major === 3 ? dirCount === 0 : dirCount <= sectors), "malformed", "CFB declared sector counts exceed the file.")
	const FREE = 0xffffffff, END = 0xfffffffe, FAT = 0xfffffffd, DIF = 0xfffffffc, used = new Set(), difats = [], fatIds = []
	const sector = id => { check(id < sectors, "malformed", "CFB sector address exceeds the file."); return bytes.subarray((id + 1) * sectorSize, (id + 2) * sectorSize) }
	const claim = id => { sector(id); check(!used.has(id), "malformed", "CFB sector chains overlap or cycle."); used.add(id) }
	for (let p = 76; p < 512; p += 4) { const id = bytes.readUInt32LE(p); if (id !== FREE) fatIds.push(id) }
	let next = bytes.readUInt32LE(68)
	for (let i = 0; i < difCount; i++) { claim(next); difats.push(next); const data = sector(next); for (let p = 0; p < sectorSize - 4; p += 4) { const id = data.readUInt32LE(p); if (id !== FREE) fatIds.push(id) } next = data.readUInt32LE(sectorSize - 4) }
	check((difCount ? next === END : [END, FREE].includes(next)) && fatIds.length === fatCount, "malformed", "CFB DIFAT count or termination is invalid.")
	const fat = []
	for (const id of fatIds) { claim(id); const data = sector(id); for (let p = 0; p < sectorSize; p += 4) fat.push(data.readUInt32LE(p)) }
	check(fat.length >= sectors && fatIds.every(id => fat[id] === FAT) && difats.every(id => fat[id] === DIF), "malformed", "CFB FAT sector markers are invalid.")
	const chain = (first, count) => {
		const ids = []; let id = first
		while (id !== END) { check(ids.length < sectors && (count === undefined || ids.length < count), "malformed", "CFB chain exceeds its declared size."); claim(id); ids.push(id); id = fat[id] }
		check(count === undefined || ids.length === count, "malformed", "CFB chain length differs from its declared size.")
		return Buffer.concat(ids.map(sector))
	}
	const directory = chain(bytes.readUInt32LE(48), major === 4 ? dirCount : undefined), entries = []
	for (let p = 0; p < directory.length; p += 128) {
		const type = directory[p + 66]; if (!type) { entries.push(null); continue }
		const nl = directory.readUInt16LE(p + 64), size = directory.readBigUInt64LE(p + 120)
		check([1, 2, 5].includes(type) && nl >= 2 && nl <= 64 && nl % 2 === 0 && directory.readUInt16LE(p + nl - 2) === 0 && size <= BigInt(limits.expandedBytes), "malformed", "CFB directory entry is invalid.")
		entries.push({ type, name: directory.toString("utf16le", p, p + nl - 2), first: directory.readUInt32LE(p + 116), size: Number(size), links: [68, 72, 76].map(n => directory.readUInt32LE(p + n)) })
	}
	check(entries[0]?.type === 5 && entries.filter(e => e?.type === 5).length === 1, "malformed", "CFB root directory is invalid.")
	for (const entry of entries.filter(Boolean)) for (const id of entry.links) check(id === FREE || id < entries.length && entries[id], "malformed", "CFB directory link exceeds its bounds.")
	const reachable = new Set([0]), pending = [entries[0].links[2]]
	while (pending.length) { const id = pending.pop(); if (id === FREE) continue; check(!reachable.has(id), "malformed", "CFB directory links cycle or overlap."); reachable.add(id); const entry = entries[id]; check(entry.type !== 2 || entry.links[2] === FREE, "malformed", "CFB stream has a child directory."); pending.push(...entry.links) }
	check(entries.every((entry, id) => !entry || reachable.has(id)), "malformed", "CFB contains unreachable directory entries.")
	check(!entries.some(e => e && /^(EncryptionInfo|EncryptedPackage)$/i.test(e.name)), "encrypted", "Encrypted Office workbooks are unsupported.")
	const miniFatBytes = miniCount ? chain(bytes.readUInt32LE(60), miniCount) : Buffer.alloc(0), miniFat = []
	for (let p = 0; p < miniFatBytes.length; p += 4) miniFat.push(miniFatBytes.readUInt32LE(p))
	const root = entries[0], miniStream = root.size ? chain(root.first, Math.ceil(root.size / sectorSize)).subarray(0, root.size) : Buffer.alloc(0), miniUsed = new Set()
	let workbook, total = root.size
	for (const entry of entries.filter(e => e?.type === 2)) {
		total += entry.size; check(total <= limits.expandedBytes, "budget", "CFB streams exceed the expanded limit.")
		let stream
		if (!entry.size) stream = Buffer.alloc(0)
		else if (entry.size >= 4096) stream = chain(entry.first, Math.ceil(entry.size / sectorSize)).subarray(0, entry.size)
		else {
			const chunks = []; let id = entry.first
			for (let i = 0; i < Math.ceil(entry.size / 64); i++) { check(id < miniFat.length && (id + 1) * 64 <= miniStream.length && !miniUsed.has(id), "malformed", "CFB mini stream exceeds its bounds or cycles."); miniUsed.add(id); chunks.push(miniStream.subarray(id * 64, (id + 1) * 64)); id = miniFat[id] }
			check(id === END, "malformed", "CFB mini stream length is inconsistent."); stream = Buffer.concat(chunks).subarray(0, entry.size)
		}
		if (/^(Workbook|Book)$/i.test(entry.name)) { check(!workbook, "malformed", "CFB has duplicate workbook streams."); workbook = stream }
	}
	check(workbook, "unsupported", "CFB has no BIFF workbook stream.")
	let depth = 0, globals = false, globalsEnd = null; const starts = new Map(), tabs = [], names = new Set(), offsets = new Set()
	for (let p = 0; p < workbook.length;) {
		check(p + 4 <= workbook.length, "malformed", "BIFF record header is truncated.")
		const id = workbook.readUInt16LE(p), length = workbook.readUInt16LE(p + 2), data = p + 4
		check(data + length <= workbook.length && length <= 8224, "malformed", "BIFF record exceeds its bounds.")
		check(id !== 0x2f, "encrypted", "Encrypted BIFF workbooks are unsupported.")
		if ([0x809, 0x409, 0x209, 0x9].includes(id)) {
			check(length >= 4 && depth < 16, "malformed", "BIFF substream header is invalid."); starts.set(p, { kind: workbook.readUInt16LE(data + 2), version: workbook.readUInt16LE(data), record: id, topLevel: depth === 0 }); depth++
			if (p === 0) { check(workbook.readUInt16LE(data) === 0x600 && workbook.readUInt16LE(data + 2) === 5, "unsupported", "Only BIFF8 XLS workbooks are supported."); globals = true }
		} else if (id === 0x0a) { check(depth > 0 && length === 0, "malformed", "BIFF substream end is invalid."); if (depth === 1 && globalsEnd === null) globalsEnd = p; depth-- }
		else if (id === 0x85) {
			check(depth === 1 && globalsEnd === null && length >= 8, "malformed", "BIFF sheet inventory is outside workbook globals or truncated.")
			const count = workbook[data + 6], flags = workbook[data + 7], width = flags === 1 ? 2 : 1
			check(count >= 1 && count <= 31 && flags <= 1 && length === 8 + count * width, "malformed", "BIFF tab name encoding or length is invalid.")
			const name = workbook.toString(width === 2 ? "utf16le" : "latin1", data + 8, data + length), offset = workbook.readUInt32LE(data)
			check(!/[\x00-\x1f\x7f\[\]:*?\\/]/.test(name) && !names.has(name.toLowerCase()) && !offsets.has(offset), "malformed", "BIFF tab names or stream offsets collide or are invalid.")
			names.add(name.toLowerCase()); offsets.add(offset); tabs.push({ name, offset, hidden: workbook[data + 4], kind: workbook[data + 5] })
		}
		else check(depth > 0, "malformed", "BIFF record is outside a substream.")
		p = data + length
	}
	check(globals && depth === 0 && tabs.length && tabs.every(tab => {
		const bof = starts.get(tab.offset)
		return bof?.topLevel && bof.record === 0x809 && bof.version === 0x600 && tab.hidden <= 2 && Object.hasOwn({ 0: 0x10, 1: 0x40, 2: 0x20, 6: 0x06 }, tab.kind) && bof.kind === ({ 0: 0x10, 1: 0x40, 2: 0x20, 6: 0x06 })[tab.kind]
	}), "malformed", "BIFF workbook tab kind, BOF type or sheet offsets are inconsistent.")
	return { expandedBytes: total, tabs }
}

function biffInventory(tabs, workbook) {
	// SheetJS 0.20.3 orders BIFF SheetNames by stream offset, not BoundSheet order.
	// Validate that decoder projection, then publish names/visibility/kinds from BIFF.
	const physicalOrder = [...tabs].sort((a, b) => a.offset - b.offset)
	check(Array.isArray(workbook.SheetNames) && workbook.SheetNames.length === tabs.length && physicalOrder.every((tab, i) => workbook.SheetNames[i] === tab.name), "malformed", "BIFF tab names, count or physical order disagree with the workbook decoder.")
	check(tabs.every(tab => tab.kind !== 0 || workbook.Sheets?.[tab.name] && !["macro", "chart"].includes(workbook.Sheets[tab.name]["!type"])), "malformed", "BIFF worksheet is missing or has a different decoded tab kind.")
	return tabs.map(tab => ({ name: tab.name, visibility: ["visible", "hidden", "very-hidden"][tab.hidden], kind: tab.kind === 0 ? "worksheet" : "unsupported" }))
}

function xml(bytes, handlers) {
	check(bytes, "malformed", "A required workbook XML member is missing.")
	const parser = new SaxesParser({ xmlns: true })
	parser.on("doctype", () => fail("unsupported", "Workbook XML DTDs are unsupported."))
	parser.on("error", () => fail("malformed", "Workbook XML is malformed."))
	for (const [event, fn] of Object.entries(handlers)) parser.on(event, fn)
	try { parser.write(bytes.toString("utf8")).close() } catch (e) { if (e.reason) throw e; fail("malformed", "Workbook XML is malformed.") }
}
const attrs = tag => Object.fromEntries(Object.values(tag.attributes).map(a => [a.local, a.value]))
function reference(ref) {
	check(typeof ref === "string" && /^[A-Z]{1,3}[1-9][0-9]{0,6}$/i.test(ref), "malformed", "Workbook cell reference is invalid.")
	const coordinate = XLSX.utils.decode_cell(ref)
	check(coordinate.r < 1048576 && coordinate.c < 16384, "malformed", "Workbook cell reference exceeds Excel bounds."); return coordinate
}
function range(ref) {
	const parts = ref.split(":"); check(parts.length <= 2, "malformed", "Workbook range is invalid.")
	const s = reference(parts[0]), e = reference(parts[1] || parts[0]); check(s.r <= e.r && s.c <= e.c, "malformed", "Workbook range is reversed."); return { s, e }
}
function textBudget(value) { check(value.length <= 32767, "budget", "Cell text exceeds Excel's 32767-character limit."); return value }

function xlsxMetadata(members) {
	const inventory = [], relationships = new Map(); let dateSystem = "1900"
	xml(members.get("xl/workbook.xml"), { opentag(tag) { const a = attrs(tag); if (tag.local === "workbookPr" && ["1", "true"].includes(a.date1904)) dateSystem = "1904"; if (tag.local === "sheet") inventory.push({ name: a.name, relation: a.id, visibility: a.state || "visible" }) } })
	xml(members.get("xl/_rels/workbook.xml.rels"), { opentag(tag) { if (tag.local === "Relationship") { const a = attrs(tag); check(!relationships.has(a.Id), "malformed", "Workbook relationship IDs collide."); relationships.set(a.Id, a) } } })
	check(inventory.length > 0 && inventory.length <= 4096 && new Set(inventory.map(s => s.name)).size === inventory.length, "malformed", "Workbook sheet inventory is invalid.")
	for (const sheet of inventory) {
		const relation = relationships.get(sheet.relation); check(relation && relation.TargetMode !== "External", "malformed", "Workbook sheet relationship is missing or external.")
		check(["visible", "hidden", "veryHidden"].includes(sheet.visibility), "malformed", "Workbook sheet visibility is invalid.")
		sheet.visibility = sheet.visibility === "veryHidden" ? "very-hidden" : sheet.visibility
		const target = relation.Target; check(typeof target === "string" && !target.includes("\\") && !target.includes(":"), "malformed", "Workbook sheet relationship path is invalid.")
		sheet.path = require("node:path").posix.normalize(target.startsWith("/") ? target.slice(1) : `xl/${target}`)
		check(sheet.path.startsWith("xl/") && members.has(sheet.path), "malformed", "Workbook sheet relationship leaves its package or is missing.")
		sheet.kind = relation.Type?.endsWith("/worksheet") ? "worksheet" : "unsupported"
	}
	return { inventory, dateSystem }
}

function sharedStrings(bytes) {
	const strings = []; if (!bytes) return strings
	let value = null, text = false, phonetic = 0
	xml(bytes, {
		opentag(tag) { if (tag.local === "si") value = ""; if (tag.local === "rPh") phonetic++; if (tag.local === "t") text = true },
		text(chunk) { if (value !== null && text && !phonetic) value += chunk },
		cdata(chunk) { if (value !== null && text && !phonetic) value += chunk },
		closetag(tag) { if (tag.local === "t") text = false; if (tag.local === "rPh") phonetic--; if (tag.local === "si") { strings.push(textBudget(value)); value = null } },
	})
	return strings
}
function sheetOverlay(bytes, worksheet, shared, styleCount) {
	const cells = new Map(), merges = []; let current, field, value, formula, richText, phonetic = 0, bounds = null, storedRange = null, dimensionSeen = false, depth = 0, worksheetNamespace, row = -1, column = -1
	xml(bytes, {
		opentag(tag) {
			depth++
			if (depth === 1) { check(tag.local === "worksheet", "malformed", "Workbook worksheet XML has an invalid root."); worksheetNamespace = tag.uri }
			const a = attrs(tag)
			if (depth === 2 && tag.uri === worksheetNamespace && tag.local === "dimension") {
				check(!dimensionSeen, "malformed", "Workbook declares multiple stored dimensions."); dimensionSeen = true
				const ref = tag.attributes.ref?.value
				if (ref !== undefined) { bounds = range(ref); storedRange = ref }
			}
			if (tag.local === "mergeCell") merges.push(XLSX.utils.encode_range(range(a.ref)))
			if (tag.local === "row") { const next = a.r === undefined ? row + 1 : Number(a.r) - 1; check(Number.isSafeInteger(next) && next > row && next < 1048576, "malformed", "Workbook row positions are invalid."); row = next; column = -1 }
			if (tag.local === "c") {
				check(["n", "s", "b", "e", "d", "str", "inlineStr"].includes(a.t || "n"), "unsupported", "Workbook cell type is unsupported.")
				if (a.s !== undefined) check(/^[0-9]+$/.test(a.s) && Number(a.s) < styleCount, "malformed", "Workbook cell references an unknown style.")
				const ref = a.r || XLSX.utils.encode_cell({ r: row, c: column + 1 }), coordinate = reference(ref)
				check(coordinate.r === row && coordinate.c > column && !cells.has(ref), "malformed", "Workbook cell positions are inconsistent."); column = coordinate.c
				current = { ref, coordinate, kind: a.t || "n", hasValue: false, hasFormula: false }; value = ""; formula = ""; richText = ""
			}
			if (current && tag.local === "rPh") phonetic++
			if (current && ["v", "f", "t"].includes(tag.local)) { field = tag.local; if (field === "v") current.hasValue = true; if (field === "f") current.hasFormula = true }
		},
		text(text) { if (!current) return; if (field === "v") value += text; if (field === "f") formula += text; if (field === "t" && !phonetic) richText += text },
		cdata(text) { if (field === "t" && current && !phonetic) richText += text },
		closetag(tag) {
			if (["v", "f", "t"].includes(tag.local)) field = null
			if (tag.local === "rPh") phonetic--
			if (tag.local === "c") {
				const parsed = worksheet?.[current.ref], format = parsed?.z ?? null
				let raw = parsed?.v ?? null, type = parsed?.t || current.kind, display = parsed?.w ?? (raw === null ? "" : String(raw))
				const formulaText = current.hasFormula ? (parsed?.f ?? formula) : null
				const present = current.hasValue && (value.length > 0 || current.kind === "str")
				if (current.kind === "n" && present) { check(/^[+-]?(?:[0-9]+(?:\.[0-9]*)?|\.[0-9]+)(?:[eE][+-]?[0-9]+)?$/.test(value) && Number.isFinite(Number(value)), "malformed", "Workbook numeric value is invalid."); raw = value; type = "n" }
				if (current.kind === "b" && present) { check(["0", "1"].includes(value), "malformed", "Workbook boolean value is invalid."); raw = value === "1"; type = "b" }
				if (["str", "e", "d"].includes(current.kind) && present) { raw = value; type = current.kind === "str" ? "s" : current.kind; display = parsed?.w ?? value }
				if (current.kind === "inlineStr") { raw = richText; type = "s"; display = richText }
				if (current.kind === "s" && present) { check(/^[0-9]+$/.test(value) && Number(value) < shared.length, "malformed", "Workbook cell references an unknown shared string."); raw = shared[Number(value)]; type = "s"; display = raw }
				if (current.hasFormula && !present) { raw = null; display = ""; type = parsed?.t ?? current.kind }
				if (!current.hasFormula && !current.hasValue && current.kind !== "inlineStr") { raw = null; display = ""; type = "z" }
				if (typeof raw === "string") textBudget(raw); textBudget(display); if (formulaText !== null) textBudget(formulaText)
				cells.set(current.ref, { coordinate: current.coordinate, cell: { type, raw, display, format, formula: formulaText, cache: current.hasFormula ? present ? "present" : "missing" : "not-formula" } }); current = null
			}
			depth--
		},
	})
	return { cells, merges, bounds, storedRange }
}

async function decode(bytes, limits, emit) {
	let preflight, metadata
	if (bytes.length >= 4 && bytes.readUInt32LE(0) === 0x04034b50) { preflight = unzip(bytes, limits); metadata = xlsxMetadata(preflight.members) }
	else if (bytes.subarray(0, 8).equals(Buffer.from("d0cf11e0a1b11ae1", "hex"))) preflight = biffPreflight(bytes, limits)
	else fail("unsupported", "Choose an unencrypted XLS (BIFF8) or XLSX workbook.")
	let workbook
	try { workbook = XLSX.read(bytes, { type: "buffer", dense: false, WTF: true, xlfn: true, cellFormula: true, cellNF: true, cellText: true, cellDates: false, sheetStubs: true, cellHTML: false, bookVBA: false }) }
	catch (error) { fail(memoryFailure(error) ? "resource_limit" : "malformed", memoryFailure(error) ? "Workbook decoding reached the native memory limit." : "Workbook decoding failed after structural validation.") }
	const inventory = metadata?.inventory ?? biffInventory(preflight.tabs, workbook)
	const dateSystem = metadata?.dateSystem ?? (workbook.Workbook?.WBProps?.date1904 ? "1904" : "1900"), sheets = [], warnings = []; let totalCells = 0
	const shared = metadata ? sharedStrings(preflight.members.get("xl/sharedStrings.xml")) : []
	let styleCount = 1, inCellXfs = false
	if (metadata && preflight.members.has("xl/styles.xml")) { styleCount = 0; xml(preflight.members.get("xl/styles.xml"), { opentag(tag) { if (tag.local === "cellXfs") inCellXfs = true; if (inCellXfs && tag.local === "xf") styleCount++ }, closetag(tag) { if (tag.local === "cellXfs") inCellXfs = false } }) }
	for (const [ordinal, item] of inventory.entries()) {
		const ws = workbook.Sheets[item.name], sheet = { id: `sheet-${ordinal}`, name: item.name, ordinal, visibility: item.visibility, kind: item.kind, rows: 0, columns: 0, indexedRows: 0, storedRange: null, populatedCells: 0, merges: [], modes: ["stored", "formula"], warnings: [] }
		if (sheet.kind === "unsupported") { sheet.reason = "Non-worksheet tab"; sheet.warnings.push("This tab is not a worksheet."); sheets.push(sheet); continue }
		const overlay = metadata ? sheetOverlay(preflight.members.get(item.path), ws, shared, styleCount) : null
		sheet.storedRange = overlay?.storedRange ?? null
		if (!metadata) sheet.warnings.push("Stored XLS range is unavailable; row and column bounds are reader-derived.")
		const cells = overlay?.cells ?? new Map(Object.entries(ws || {}).filter(([key]) => !key.startsWith("!")).map(([key, cell]) => {
			const coordinate = reference(key), present = cell.v !== undefined && cell.v !== null, formula = cell.f ?? null
			check(!present || ["string", "number", "boolean"].includes(typeof cell.v), "unsupported", "Workbook contains an unsupported cell value.")
			check(typeof cell.v !== "number" || Number.isFinite(cell.v), "malformed", "Workbook contains a non-finite numeric value.")
			const display = cell.w ?? (present ? String(cell.v) : ""); if (typeof cell.v === "string") textBudget(cell.v); textBudget(display); if (formula !== null) textBudget(formula)
			return [key, { coordinate, cell: { type: cell.t, raw: present ? cell.v : null, display, format: cell.z ?? null, formula, cache: formula === null ? "not-formula" : present ? "present" : "unknown" } }]
		}))
		let bounds = overlay ? overlay.bounds : (ws?.["!ref"] ? range(ws["!ref"]) : null)
		sheet.merges = overlay?.merges ?? (ws?.["!merges"] || []).map(XLSX.utils.encode_range)
		let rowNumber = -1, row = {}
		const flush = async () => { if (rowNumber >= 0 && Object.keys(row).length) { await emit({ row: { sheet: sheet.id, row: rowNumber, cells: row } }); sheet.indexedRows++ }; row = {} }
		const ordered = [...cells.values()].sort((a, b) => a.coordinate.r - b.coordinate.r || a.coordinate.c - b.coordinate.c)
		for (const { coordinate, cell } of ordered) {
			check(++totalCells <= limits.cells, "budget", "Workbook cell count exceeds the configured limit.")
			if (coordinate.r !== rowNumber) { await flush(); rowNumber = coordinate.r }
			row[coordinate.c] = cell; if (cell.raw !== null || cell.formula !== null) sheet.populatedCells++
			if (!bounds) bounds = { s: { ...coordinate }, e: { ...coordinate } }
			else { bounds.s.r = Math.min(bounds.s.r, coordinate.r); bounds.s.c = Math.min(bounds.s.c, coordinate.c); bounds.e.r = Math.max(bounds.e.r, coordinate.r); bounds.e.c = Math.max(bounds.e.c, coordinate.c) }
		}
		await flush()
		if (bounds) { sheet.rows = bounds.e.r + 1; sheet.columns = bounds.e.c + 1 }
		sheets.push(sheet)
	}
	return { schemaVersion: 1, parser: PARSER, origin: "fresh", dateSystem, sheets, warnings, decodedCells: totalCells, expandedBytes: preflight.expandedBytes }
}

async function confinementProbe() {
	const readDenied = (path, code) => { try { fs.readFileSync(path); return false } catch (e) { return e.code === code } }
	let sentinelValid = false
	try {
		const sentinel = fs.lstatSync("/.geocluster-isolation-sentinel")
		sentinelValid = sentinel.isFile() && sentinel.uid === 0 && sentinel.gid === 0 && (sentinel.mode & 0o7777) === 0 && readDenied("/.geocluster-isolation-sentinel", "EACCES")
	} catch {}
	const filesystemDenied = sentinelValid && ["/etc/passwd", "/proc/self/environ", "../../../etc/passwd", "../../../proc/self/environ"].every(path => readDenied(path, "ENOENT")) &&
		process.env.GC_WORKBOOK_READONLY_PROBES === "1" && process.env.GC_WORKBOOK_DESCRIPTOR_PROBES === "1"
	const denied = e => e.code === "EPERM"
	const socketDenied = await new Promise(resolve => { try { const socket = net.connect({ host: "127.0.0.1", port: 9 }); socket.once("error", e => { socket.destroy(); resolve(denied(e)) }); socket.once("connect", () => { socket.destroy(); resolve(false) }) } catch (e) { resolve(denied(e)) } })
	const executionDenied = await new Promise(resolve => { try { const child = spawn("/bin/true", [], { stdio: "ignore" }); child.once("error", e => resolve(denied(e))); child.once("close", () => resolve(false)) } catch (e) { resolve(denied(e)) } })
	check(filesystemDenied && socketDenied && executionDenied && process.env.GC_WORKBOOK_SECCOMP === "1" && process.env.GC_WORKBOOK_SYSCALL_PROBES === "1", "unavailable", "Installed workbook confinement denial probes failed.")
	return { filesystemDenied, socketDenied, executionDenied, signalDenied: true }
}

async function main() {
	const start = performance.now(), synthetic = process.env.GC_WORKBOOK_SYNTHETIC === "1"
	check(XLSX.version === "0.20.3", "unavailable", "Workbook reader requires the pinned SheetJS 0.20.3 build.")
	process.stdout.write(`${JSON.stringify({ ready: true, uid: process.getuid(), pid: process.pid, parser: PARSER, confinement: synthetic ? "synthetic-test-only" : "installed" })}\n`)
	let buffer = Buffer.alloc(0), header, chunks = [], length = 0
	for await (const chunk of process.stdin) {
		if (!header) {
			buffer = Buffer.concat([buffer, chunk]); const newline = buffer.indexOf(10)
			check(newline >= 0 || buffer.length <= 16384, "malformed", "Workbook request header exceeds its limit.")
			if (newline < 0) continue
			check(newline <= 16384, "malformed", "Workbook request header exceeds its limit."); header = JSON.parse(buffer.subarray(0, newline).toString("utf8")); buffer = buffer.subarray(newline + 1)
			check(header.limits && Number.isSafeInteger(header.byteLength) && header.byteLength >= 0 && header.byteLength <= header.limits.inputBytes, "budget", "Workbook input length exceeds its limit.")
			const maxima = { inputBytes: 128 * 1048576, expandedBytes: 512 * 1048576, memberBytes: 512 * 1048576, outputBytes: 512 * 1048576, cells: 4000000, zipEntries: 65534, manifestBytes: 4 * 1048576, rowBytes: 32 * 1048576, elapsedMs: 60000 }
			for (const [name, max] of Object.entries(maxima)) check(Number.isSafeInteger(header.limits[name]) && header.limits[name] > 0 && header.limits[name] <= max, "budget", "Workbook configured limit exceeds the physical envelope.")
			if (buffer.length) { chunks.push(buffer); length += buffer.length }; buffer = null
		} else { chunks.push(chunk); length += chunk.length }
		check(length <= header.byteLength, "malformed", "Workbook input exceeds its exact declared length.")
	}
	check(header && length === header.byteLength, "malformed", "Workbook input ended before its exact declared length.")
	const bytes = Buffer.concat(chunks, length), hash = createHash("sha256").update(bytes).digest("hex")
	check(!header.inputSha256 || hash === header.inputSha256, "source_integrity", "Workbook retained input hash differs from its expected digest.")
	let outputBytes = 0
	const emit = async message => {
		const line = `${JSON.stringify(message)}\n`, size = Buffer.byteLength(line)
		check(size <= (message.row ? header.limits.rowBytes : header.limits.manifestBytes), "budget", "Workbook row or manifest exceeds its output limit.")
		outputBytes += size; check(outputBytes <= header.limits.outputBytes + header.limits.manifestBytes, "budget", "Workbook JSONL output exceeds its limit.")
		if (!process.stdout.write(line)) await once(process.stdout, "drain")
	}
	if (header.probe) {
		const policy = synthetic ? { synthetic: true } : await confinementProbe(), decoded = []
		for (const format of ["biff8", "xlsx"]) {
			const book = XLSX.utils.book_new(); XLSX.utils.book_append_sheet(book, XLSX.utils.aoa_to_sheet([["probe", 7]]), "Probe")
			const result = await decode(Buffer.from(XLSX.write(book, { type: "buffer", bookType: format })), header.limits, async () => {})
			check(result.sheets[0]?.populatedCells === 2, "unavailable", "Installed workbook decode probe did not return both cells."); decoded.push(format === "biff8" ? "xls" : "xlsx")
		}
		await emit({ probe: { ...policy, decoded } }); return
	}
	const manifest = await decode(bytes, header.limits, emit)
	manifest.inputSha256 = hash; manifest.metrics = { durationMs: performance.now() - start, peakRssKiB: process.resourceUsage().maxRSS, inputBytes: length, outputBytes }
	await emit({ manifest })
}
main().catch(error => {
	const reason = error.reason || (memoryFailure(error) ? "resource_limit" : "malformed")
	process.stdout.write(`${JSON.stringify({ error: { reason, message: error.reason ? error.message : reason === "resource_limit" ? "Workbook decoding reached the native memory limit." : "Workbook reader rejected malformed input or protocol." } })}\n`)
	process.exitCode = 1
})
