/** Dependency-free, valid two-page PDFs for real-engine/Poppler tests. No model or document generator. */
export const PDF_TEXT = ["TEXT page one: Ore grade 2.4 g/t", "TEXT page two: Reserve 18 Mt"]

function stream(text) {
	return `<< /Length ${Buffer.byteLength(text)} >>\nstream\n${text}endstream`
}

/** `empty` has blank pages; `scanned` has an actual raster image on each page and no text objects. */
export function tinyPdf(kind = "text") {
	if (!["text", "empty", "scanned"].includes(kind)) throw new Error(`unknown PDF fixture: ${kind}`)
	const contents = (page) => kind === "text"
		? `BT /F1 12 Tf 30 240 Td (${PDF_TEXT[page]}) Tj ET\n`
		: kind === "scanned" ? "q 220 0 0 220 30 30 cm /Im1 Do Q\n" : "q Q\n"
	const resources = kind === "scanned" ? "/XObject << /Im1 8 0 R >>" : "/Font << /F1 7 0 R >>"
	const page = (content) => `<< /Type /Page /Parent 2 0 R /MediaBox [0 0 300 300] /Resources << ${resources} >> /Contents ${content} 0 R >>`
	const objects = [
		"<< /Type /Catalog /Pages 2 0 R >>",
		"<< /Type /Pages /Kids [3 0 R 5 0 R] /Count 2 >>",
		page(4), stream(contents(0)), page(6), stream(contents(1)),
		"<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>",
	]
	if (kind === "scanned") objects.push("<< /Type /XObject /Subtype /Image /Width 1 /Height 1 /ColorSpace /DeviceGray /BitsPerComponent 8 /Filter /ASCIIHexDecode /Length 4 >>\nstream\n00>\nendstream")
	let pdf = "%PDF-1.4\n"
	const offsets = [0]
	objects.forEach((object, i) => {
		offsets.push(Buffer.byteLength(pdf))
		pdf += `${i + 1} 0 obj\n${object}\nendobj\n`
	})
	const xref = Buffer.byteLength(pdf)
	pdf += `xref\n0 ${offsets.length}\n0000000000 65535 f \n${offsets.slice(1).map((n) => `${String(n).padStart(10, "0")} 00000 n \n`).join("")}trailer\n<< /Size ${offsets.length} /Root 1 0 R >>\nstartxref\n${xref}\n%%EOF\n`
	return Buffer.from(pdf)
}

/** Passes the engine's PDF media sniff, but has no valid catalog, pages, or xref. */
export const malformedPdf = () => Buffer.from("%PDF-1.4\nnot a valid PDF object\n%%EOF\n")
