import XLSX from "xlsx"
import { deflateRawSync } from "node:zlib"

export function crc32(bytes) {
	let crc = -1
	for (const byte of bytes) { crc ^= byte; for (let bit = 0; bit < 8; bit++) crc = (crc >>> 1) ^ (0xedb88320 & -(crc & 1)) }
	return (crc ^ -1) >>> 0
}

/** Small ZIP builder also permits deliberately inconsistent declared lengths in rejection tests. */
export function zipFixture(members, { declaredDelta = 0 } = {}) {
	const local = [], central = []; let offset = 0
	for (const [name, value] of Object.entries(members)) {
		const content = Buffer.from(value), data = deflateRawSync(content), filename = Buffer.from(name), crc = crc32(content)
		const header = Buffer.alloc(30); header.writeUInt32LE(0x04034b50); header.writeUInt16LE(20, 4); header.writeUInt16LE(8, 8)
		header.writeUInt32LE(crc, 14); header.writeUInt32LE(data.length, 18); header.writeUInt32LE(content.length + declaredDelta, 22); header.writeUInt16LE(filename.length, 26)
		const entry = Buffer.alloc(46); entry.writeUInt32LE(0x02014b50); entry.writeUInt16LE(20, 4); entry.writeUInt16LE(20, 6); entry.writeUInt16LE(8, 10)
		entry.writeUInt32LE(crc, 16); entry.writeUInt32LE(data.length, 20); entry.writeUInt32LE(content.length + declaredDelta, 24); entry.writeUInt16LE(filename.length, 28); entry.writeUInt32LE(offset, 42)
		local.push(header, filename, data); central.push(entry, filename); offset += header.length + filename.length + data.length
	}
	const directory = Buffer.concat(central), end = Buffer.alloc(22); end.writeUInt32LE(0x06054b50); end.writeUInt16LE(central.length / 2, 8); end.writeUInt16LE(central.length / 2, 10); end.writeUInt32LE(directory.length, 12); end.writeUInt32LE(offset, 16)
	return Buffer.concat([...local, directory, end])
}

export function workbookMembers(bytes) {
	const archive = XLSX.CFB.read(bytes, { type: "buffer" }), members = {}
	for (let i = 0; i < archive.FileIndex.length; i++) { const entry = archive.FileIndex[i]; if (entry.type === 2 && entry.name !== "\u0001Sh33tJ5") members[archive.FullPaths[i].replace(/^Root Entry\//, "")] = Buffer.from(entry.content) }
	return members
}

export function patchBiffFixture(bytes, mutate) {
	const cfb = XLSX.CFB.read(bytes, { type: "buffer" }), stream = cfb.FileIndex.find(f => f.name === "Workbook").content, tabs = []
	for (let p = 0; p + 4 <= stream.length; p += 4 + stream.readUInt16LE(p + 2)) if (stream.readUInt16LE(p) === 0x85) tabs.push({ position: p, length: stream.readUInt16LE(p + 2), offset: stream.readUInt32LE(p + 4) })
	mutate(stream, tabs)
	return Buffer.from(XLSX.CFB.write(cfb, { type: "buffer" }))
}

/** Genuine OOXML or BIFF8, with source-coordinate gaps and independent stored formulas. */
export function makeWorkbookFixture(format = "xlsx", options = {}) {
	if (!["xls", "xlsx"].includes(format)) throw new Error("Choose xls or xlsx")
	const book = XLSX.utils.book_new(), sheet = {
		A1: { t: "s", v: "Identifier" }, B1: { t: "s", v: "Result" },
		A2: { t: "s", v: "00123" }, B2: { t: "n", v: 2, f: "1+1", bf: [7, 0, 0x1e, 1, 0, 0x1e, 1, 0, 0x03] },
		C2: { t: "n", v: 1.23, z: "0.00000" }, D2: { t: "n", v: 45292, z: "yyyy-mm-dd" },
		E2: { t: "n", f: "99+1" }, F2: { t: "b", v: true },
		A5: { t: "s", v: options.text ?? "Tail" }, "!ref": "A1:F5", "!merges": [{ s: { r: 0, c: 2 }, e: { r: 0, c: 3 } }],
	}
	XLSX.utils.book_append_sheet(book, sheet, "Data")
	XLSX.utils.book_append_sheet(book, { A1: { t: "s", v: "secret" }, "!ref": "A1" }, "Hidden")
	XLSX.utils.book_append_sheet(book, {}, "Empty")
	if (format === "xls" && options.unsupported) XLSX.utils.book_append_sheet(book, {}, "Chart")
	book.Workbook = { WBProps: { date1904: options.date1904 ?? false }, Sheets: [{ Hidden: 0 }, { Hidden: 1 }, { Hidden: 2 }] }
	if (format === "xls" && options.biffTabs) {
		book.SheetNames = []; book.Sheets = {}; book.Workbook.Sheets = []
		for (const tab of options.biffTabs) {
			const cells = tab.empty ? {} : { A1: { t: "s", v: `marker:${tab.name}` }, B2: { t: "n", v: 17, bf: [7, 0, 0x1e, 1, 0, 0x1e, 1, 0, 0x03] }, "!ref": "A1:B2" }
			XLSX.utils.book_append_sheet(book, cells, tab.name); book.Workbook.Sheets.push({ Hidden: tab.hidden ?? 0 })
		}
	}
	let bytes = Buffer.from(XLSX.write(book, { type: "buffer", bookType: format === "xls" ? "biff8" : "xlsx", compression: true }))
	if (format === "xls") {
		if (options.biffTabs) bytes = patchBiffFixture(bytes, (stream, tabs) => {
			for (const [i, tab] of tabs.entries()) { const kind = options.biffTabs[i].kind ?? 0; stream[tab.position + 9] = kind; stream.writeUInt16LE(({ 0: 0x10, 1: 0x40, 2: 0x20, 6: 0x06 })[kind], tab.offset + 6) }
			if (options.biffTabOrder) Buffer.concat(options.biffTabOrder.map(i => Buffer.from(stream.subarray(tabs[i].position, tabs[i].position + 4 + tabs[i].length)))).copy(stream, tabs[0].position)
		})
		if (options.encrypted || options.unsupported) {
			const cfb = XLSX.CFB.read(bytes, { type: "buffer" }), stream = cfb.FileIndex.find(f => f.name === "Workbook").content
			let tab = 0
			for (let p = 0; p + 4 <= stream.length; p += 4 + stream.readUInt16LE(p + 2)) {
				if (options.encrypted && stream.readUInt16LE(p) === 0x22) stream.writeUInt16LE(0x2f, p)
				if (stream.readUInt16LE(p) === 0x85 && tab++ === 3 && options.unsupported) { stream[p + 9] = 2; stream.writeUInt16LE(0x20, stream.readUInt32LE(p + 4) + 6) }
			}
			bytes = Buffer.from(XLSX.CFB.write(cfb, { type: "buffer" }))
		}
		return bytes
	}
	const members = workbookMembers(bytes)
	members["xl/worksheets/sheet1.xml"] = members["xl/worksheets/sheet1.xml"].toString().replace(/(<c r="C2"[^>]*><v>)[^<]*(<\/v>)/, `$1${options.numeric ?? "12345678901234567890.00100"}$2`)
	if (options.unsupported) {
		members["xl/workbook.xml"] = members["xl/workbook.xml"].toString().replace("</sheets>", '<sheet name="Chart" sheetId="4" r:id="rId99"/></sheets>')
		members["xl/_rels/workbook.xml.rels"] = members["xl/_rels/workbook.xml.rels"].toString().replace("</Relationships>", '<Relationship Id="rId99" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/chartsheet" Target="chartsheets/sheet1.xml"/></Relationships>')
		members["xl/chartsheets/sheet1.xml"] = '<chartsheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main"/>'
	}
	return zipFixture(members)
}
