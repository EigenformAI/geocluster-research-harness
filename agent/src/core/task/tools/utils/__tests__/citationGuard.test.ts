import { describe, it } from "mocha"
import "should"
import { findFabricatedCitations } from "../citationGuard"

/**
 * Tests for the Report Analysis citation guard.
 *
 * The report-eval agent fabricated answers by guessing filenames (e.g.
 * `text/08_drilling.md`) that 404'd and then citing them for invented data.
 * findFabricatedCitations is the mechanical seatbelt: it flags any
 * `[source: <file> | ...]` whose file was never successfully read, so the
 * AttemptCompletionHandler can reject the completion and force a correction.
 */
describe("findFabricatedCitations (Report Analysis citation guard)", () => {
	const DIR = "/workspace/test-project-456/gold_x2_mining"

	it("flags invented filenames the agent never read (but allows files it did read)", () => {
		const answer = [
			"> **Data:** peak 1.2 g/t [source: text/01_summary.md | p:1]",
			"> **Data:** 23 of 156 [source: text/07_exploration.md | p:23-24]",
			"> **Data:** Au-AA25 [source: text/09_sample_preparation_analyses_and_security.md | p:32]",
			"> **Data:** no stat testing [source: analysis/findings.json | statistical_analysis]",
			"> **Data:** flagged [source: analysis/flags.json]",
		].join("\n")
		const reads = new Set([`${DIR}/sections.json`, `${DIR}/analysis/findings.json`, `${DIR}/analysis/flags.json`])
		findFabricatedCitations(answer, reads)
			.sort()
			.should.deepEqual([
				"text/01_summary.md",
				"text/07_exploration.md",
				"text/09_sample_preparation_analyses_and_security.md",
			])
	})

	it("passes when every cited file was read (relative citation vs absolute read path)", () => {
		const answer = [
			"> **Data:** 215,000 line-km [source: text/10_6_history.md | p:42-43]",
			"> **Data:** TMI map [source: images/fig_p0044_1.description.md | p:44]",
		].join("\n")
		const reads = new Set([`${DIR}/text/10_6_history.md`, `${DIR}/images/fig_p0044_1.description.md`])
		findFabricatedCitations(answer, reads).should.deepEqual([])
	})

	it("treats an honest INSUFFICIENT answer (no file citations) as clean", () => {
		findFabricatedCitations(
			"> **Verdict:** ⚪ INSUFFICIENT — report not readable [not found in report]",
			new Set(),
		).should.deepEqual([])
	})

	it("ignores web citations (not file sources)", () => {
		findFabricatedCitations(
			"> **Data:** gold $2400/oz [source: web | https://example.com/price]",
			new Set(),
		).should.deepEqual([])
	})

	it("flags a file citation when nothing was read at all", () => {
		findFabricatedCitations("[source: text/05_1_summary.md | p:1]", new Set()).should.deepEqual(["text/05_1_summary.md"])
	})

	it("matches a basename-only citation against a deeper read path", () => {
		findFabricatedCitations("[source: findings.json | stage]", new Set([`${DIR}/analysis/findings.json`])).should.deepEqual(
			[],
		)
	})
})
