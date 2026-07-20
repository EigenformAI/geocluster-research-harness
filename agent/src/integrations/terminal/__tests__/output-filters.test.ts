import { expect } from "chai"
import { describe, it } from "mocha"
import { collapseTabularOutput, extractMarkedResult, filterSubagentOutput } from "../output-filters"

describe("extractMarkedResult", () => {
	it("returns null when no markers found", () => {
		const lines = ["hello", "world", "some output"]
		expect(extractMarkedResult(lines)).to.be.null
	})

	it("extracts content between start and end markers", () => {
		const lines = [
			"Loading data...",
			"Processing...",
			"===RESULT===",
			'{"mean": 42, "sd": 3.14}',
			"===END_RESULT===",
			"Done.",
		]
		expect(extractMarkedResult(lines)).to.deep.equal(['{"mean": 42, "sd": 3.14}'])
	})

	it("returns lines from start marker to end when no end marker", () => {
		const lines = ["Loading data...", "===RESULT===", "line 1", "line 2"]
		expect(extractMarkedResult(lines)).to.deep.equal(["line 1", "line 2"])
	})

	it("handles multiple marker pairs — takes the last pair", () => {
		const lines = [
			"===RESULT===",
			"first result",
			"===END_RESULT===",
			"intermediate output",
			"===RESULT===",
			"final result",
			"===END_RESULT===",
		]
		expect(extractMarkedResult(lines)).to.deep.equal(["final result"])
	})

	it("handles markers with surrounding whitespace", () => {
		const lines = ["  ===RESULT===  ", "content", "  ===END_RESULT===  "]
		expect(extractMarkedResult(lines)).to.deep.equal(["content"])
	})

	it("handles multiple lines between markers", () => {
		const lines = ["===RESULT===", "line 1", "line 2", "line 3", "===END_RESULT==="]
		expect(extractMarkedResult(lines)).to.deep.equal(["line 1", "line 2", "line 3"])
	})

	it("ignores end marker before start marker", () => {
		const lines = ["===END_RESULT===", "noise", "===RESULT===", "real content", "===END_RESULT==="]
		expect(extractMarkedResult(lines)).to.deep.equal(["real content"])
	})
})

describe("collapseTabularOutput", () => {
	it("collapses CSV-like runs of 5+ lines", () => {
		const lines = ["col1,col2,col3,col4", "1,2,3,4", "5,6,7,8", "9,10,11,12", "13,14,15,16", "17,18,19,20"]
		const result = collapseTabularOutput(lines)
		expect(result).to.deep.equal([
			"col1,col2,col3,col4",
			"[5 data rows collapsed — use result markers to surface specific values]",
		])
	})

	it("passes through short tabular runs unchanged", () => {
		const lines = ["col1,col2,col3", "1,2,3", "4,5,6"]
		const result = collapseTabularOutput(lines)
		expect(result).to.deep.equal(lines)
	})

	it("preserves non-tabular lines around collapsed data", () => {
		const lines = [
			"Loading file...",
			"col1,col2,col3,col4",
			"1,2,3,4",
			"5,6,7,8",
			"9,10,11,12",
			"13,14,15,16",
			"17,18,19,20",
			"Processing complete.",
		]
		const result = collapseTabularOutput(lines)
		expect(result).to.deep.equal([
			"Loading file...",
			"col1,col2,col3,col4",
			"[5 data rows collapsed — use result markers to surface specific values]",
			"Processing complete.",
		])
	})

	it("preserves error/warning lines", () => {
		const lines = [
			"Error: something went wrong",
			"Traceback (most recent call last):",
			"WARNING: low memory",
			"# comment line",
			"// another comment",
		]
		const result = collapseTabularOutput(lines)
		expect(result).to.deep.equal(lines)
	})

	it("collapses DataFrame repr-style output", () => {
		const lines = [
			"   0  1.234  5.678  -0.9  2.1",
			"   1  2.345  6.789  -1.0  3.2",
			"   2  3.456  7.890  -1.1  4.3",
			"   3  4.567  8.901  -1.2  5.4",
			"   4  5.678  9.012  -1.3  6.5",
			"   5  6.789  0.123  -1.4  7.6",
		]
		const result = collapseTabularOutput(lines)
		expect(result).to.have.lengthOf(2)
		expect(result[0]).to.equal(lines[0])
		expect(result[1]).to.contain("DataFrame rows collapsed")
	})

	it("handles tab-delimited data", () => {
		const lines = ["col1\tcol2\tcol3\tcol4", "1\t2\t3\t4", "5\t6\t7\t8", "9\t10\t11\t12", "13\t14\t15\t16", "17\t18\t19\t20"]
		const result = collapseTabularOutput(lines)
		expect(result).to.deep.equal([
			"col1\tcol2\tcol3\tcol4",
			"[5 data rows collapsed — use result markers to surface specific values]",
		])
	})

	it("handles multiple separate tabular runs", () => {
		const lines = [
			"First table:",
			"a,b,c,d",
			"1,2,3,4",
			"5,6,7,8",
			"9,10,11,12",
			"13,14,15,16",
			"17,18,19,20",
			"Second table:",
			"x,y,z,w",
			"10,20,30,40",
			"50,60,70,80",
			"90,100,110,120",
			"130,140,150,160",
			"170,180,190,200",
		]
		const result = collapseTabularOutput(lines)
		expect(result).to.deep.equal([
			"First table:",
			"a,b,c,d",
			"[5 data rows collapsed — use result markers to surface specific values]",
			"Second table:",
			"x,y,z,w",
			"[5 data rows collapsed — use result markers to surface specific values]",
		])
	})

	it("does not collapse lines with fewer than 2 delimiters", () => {
		const lines = ["hello world", "foo bar", "baz qux", "one two", "three four", "five six"]
		const result = collapseTabularOutput(lines)
		expect(result).to.deep.equal(lines)
	})
})

describe("filterSubagentOutput", () => {
	it("uses marker extraction when markers are present", () => {
		const lines = [
			"col1,col2,col3,col4",
			"1,2,3,4",
			"5,6,7,8",
			"9,10,11,12",
			"13,14,15,16",
			"===RESULT===",
			'{"answer": 42}',
			"===END_RESULT===",
		]
		const result = filterSubagentOutput(lines)
		expect(result).to.deep.equal(['{"answer": 42}'])
	})

	it("falls back to tabular collapsing when no markers", () => {
		const lines = ["col1,col2,col3,col4", "1,2,3,4", "5,6,7,8", "9,10,11,12", "13,14,15,16", "17,18,19,20"]
		const result = filterSubagentOutput(lines)
		expect(result).to.have.lengthOf(2)
		expect(result[1]).to.contain("data rows collapsed")
	})

	it("passes through non-tabular output without markers unchanged", () => {
		const lines = ["Step 1: Loading model", "Step 2: Training", "Step 3: Done"]
		const result = filterSubagentOutput(lines)
		expect(result).to.deep.equal(lines)
	})

	it("marker extraction takes priority over tabular collapsing", () => {
		const lines = [
			"a,b,c,d,e",
			"1,2,3,4,5",
			"6,7,8,9,10",
			"11,12,13,14,15",
			"16,17,18,19,20",
			"21,22,23,24,25",
			"===RESULT===",
			"Only this matters",
			"===END_RESULT===",
		]
		const result = filterSubagentOutput(lines)
		expect(result).to.deep.equal(["Only this matters"])
	})
})
