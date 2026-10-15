/**
 * RE-4 citation guard: flag `[source: <file> | ...]` citations whose file this conversation never read.
 *
 * Why it exists: the report-analysis agent invents plausible NI 43-101 file names (`text/06_exploration.md`) and
 * cites them for invented values. Prompt rules alone don't stop that. The Cline fork rejected `attempt_completion`
 * (cline-fork citationGuard.ts + AttemptCompletionHandler.ts:93-114). OpenCode 2.0 has no hook that can veto a final
 * answer, so the broker runs this check at the engine's `end_turn` and, on a hit, sends ONE correction prompt
 * (correctionPrompt below) inside the same browser turn.
 *
 * Pure string logic, no I/O. Port of the fork's `findFabricatedCitations` with these fixes:
 *  F1 figure families: the prompt's own grammar `[source: images/fig_pNNNN_S | p:N]` has no extension, while the agent
 *     reads `fig_pNNNN_S.description.md` (or the image). Any member of a figure's family (stem, `.description.md`,
 *     `.jpg`, `.jpeg`, `.png`, `.tif(f)`, `.webp`) satisfies a citation of any other member. A bare figure id
 *     (`fig_p0044_1`) is now checked too; the fork skipped it as "not a path". Tables are NOT families: a `.csv`
 *     citation needs the `.csv` read.
 *  F2 every file in a bracket: the fork read one token up to the first `|`, so `a.md, b.md` was one bogus name and a
 *     second clause `; b.md | p:4` was never checked (a fabrication passed). Now clauses split on `;`, a later
 *     `| source:` field opens a clause, and each clause's first field splits on `,` ` and ` ` & ` ` + `. A first field
 *     that is itself a read file (a name containing a comma) is accepted whole.
 *  F3 backticks/quotes around a path are stripped; separators inside "..." or `...` never split.
 *  F4 an unclosed bracket at the end of a line is still checked (the fork's regex caught it too).
 * PDF basenames are checked too: a failed extraction must not allow an unread `report.pdf` citation.
 * Unchanged from the fork on purpose: the web/URL
 * skip, the normalisation (`\` -> `/`, leading `./` and `/` stripped, lower-cased) and the lenient prefix match
 * (`text/NN.md` matches `/abs/.../text/NN.md`). A label with a slash (`[source: QA/QC section]`) is still flagged,
 * as in the fork: one correction prompt is the cost.
 */

/** The fork's extension list plus PDFs, including basename-only original-report citations. */
const FILE_EXT = /\.(md|csv|json|png|jpe?g|txt|tsv|tif|geojson|pdf)$/i
/** Suffixes that make a file a member of a figure's family (the extraction writes `.jpg` + `.description.md`). */
const FIGURE_MEMBER_SUFFIX = /\.(description\.md|jpe?g|png|tiff?|webp)$/i
/** Extraction pipeline figure id, with or without its folder: `images/fig_p0044_1`, `fig_p0044_1`. */
const FIGURE_ID = /(?:^|\/)fig_[a-z0-9_-]+$/i
/**
 * A bracket body longer than this is cut. Real citations are well under 500 chars; the cap keeps the per-index
 * separator scan below from going quadratic on a pathological line (a model emitting a huge whitespace run).
 */
const MAX_BODY = 4096

const norm = (s) =>
	s
		.replace(/\\/g, "/")
		.replace(/^\.?\/+/, "")
		.trim()
		.toLowerCase()

/** `images/fig_p0044_1` for any member of that figure's family (normalised input), else null. */
const figureKey = (n) => {
	const stem = n.replace(FIGURE_MEMBER_SUFFIX, "")
	return FIGURE_ID.test(stem) ? stem : null
}

/** Strip whitespace and wrapping backticks, quotes, angle brackets and parentheses. */
const clean = (tok) =>
	tok
		.trim()
		.replace(/^[`"'<(]+|[`"'>)]+$/g, "")
		.trim()

const isWeb = (src) => /^web\b/i.test(src) || /^https?:\/\//i.test(src)
const looksLikeFile = (src) =>
	!isWeb(src) && (src.includes("/") || FILE_EXT.test(src) || FIGURE_ID.test(src.replace(FIGURE_MEMBER_SUFFIX, "")))

/** Split `str` on `sep` (a regex source) except inside balanced "..." or `...` pairs. */
function splitOutside(str, sep) {
	const protectedRanges = []
	for (const q of str.matchAll(/"[^"]*"|`[^`]*`/g)) protectedRanges.push([q.index, q.index + q[0].length])
	const inQuote = (i) => protectedRanges.some(([a, b]) => i > a && i < b - 1)
	const re = new RegExp(sep, "giy")
	const out = []
	let start = 0
	for (let i = 0; i < str.length; i++) {
		if (inQuote(i)) continue
		re.lastIndex = i
		const m = re.exec(str)
		if (m && m[0].length > 0) {
			out.push(str.slice(start, i))
			start = i + m[0].length
			i = start - 1
		}
	}
	out.push(str.slice(start))
	return out
}

/**
 * Every `[source: ...]` file list in the answer, as groups `{whole, parts}`: `whole` is the list as written (cleaned),
 * `parts` its tokens after splitting on `,` ` and ` ` & ` ` + `. Qualifier fields (`p:3, 41`, `section: "…"`,
 * `confidence: low`, a findings field) are not file lists. Exported for tests and diagnostics.
 *
 * @param {string} answer
 * @returns {{whole: string, parts: string[]}[]}
 */
export function extractSourceGroups(answer) {
	const groups = []
	if (typeof answer !== "string") return groups
	const re = /\[\s*source\s*:([^\]\n]*)(?:\]|$)/gim
	for (const m of answer.matchAll(re)) {
		const body = m[1].length > MAX_BODY ? m[1].slice(0, MAX_BODY) : m[1]
		for (const clause of splitOutside(body, ";")) {
			const fields = splitOutside(clause, "\\|")
			const lists = [fields[0], ...fields.slice(1).filter((f) => /^\s*source\s*:/i.test(f))]
			for (const raw of lists) {
				const list = raw.replace(/^\s*source\s*:\s*/i, "")
				const parts = splitOutside(list, ",|\\s+(?:and|&|\\+)\\s+")
					.map(clean)
					.filter(Boolean)
				groups.push({ whole: clean(list), parts })
			}
		}
	}
	return groups
}

/**
 * The cited files that were NOT successfully read.
 *
 * @param {string} answer The final answer text (TurnTracker.answer()).
 * @param {Iterable<string>} readPaths Absolute paths of the files this conversation read (TurnTracker.reads).
 * @returns {string[]} The cited tokens never read, as written (cleaned), de-duplicated, in order of first
 *   appearance. Empty = clean.
 */
export function findFabricatedCitations(answer, readPaths) {
	if (typeof answer !== "string" || !answer) return []
	const reads = Array.from(readPaths ?? [], (p) => norm(String(p)))
	const readFigures = reads.map(figureKey).filter((k) => k !== null)
	const match = (r, n) => r === n || r.endsWith("/" + n)
	const wasRead = (cited) => {
		const n = norm(cited)
		if (reads.some((r) => match(r, n))) return true
		const key = figureKey(n)
		return key !== null && readFigures.some((rk) => match(rk, key))
	}

	const fabricated = []
	for (const { whole, parts } of extractSourceGroups(answer)) {
		// one real file whose name contains a separator ("tables/au, cu summary.csv")
		if (parts.length > 1 && looksLikeFile(whole) && wasRead(whole)) continue
		for (const p of parts) {
			if (looksLikeFile(p) && !wasRead(p) && !fabricated.includes(p)) fabricated.push(p)
		}
	}
	return fabricated
}

/**
 * The correction prompt sent to the engine when the guard flags files: the fork's text (AttemptCompletionHandler.ts
 * :106-111) with only the Cline-specific words swapped for v2 (SPEC.md §5.4):
 *   "this task" -> "this conversation"; "read_file returned" -> "the read tool returned";
 *   "Run list_files on the report directory" -> "Read the report directory (or use glob)" (the report-analysis agent
 *   has glob/grep/read/subagent, and `read` on a directory lists it);
 *   "Then call attempt_completion again." -> "Then give your complete corrected answer again, in full." (the report
 *   export saves the answer that follows this prompt, so it must be the whole answer, not a diff).
 *
 * @param {string[]} flagged findFabricatedCitations() output (non-empty).
 * @returns {string}
 */
export function correctionPrompt(flagged) {
	return (
		`Citation check FAILED. Your answer cites these files, but you never successfully read them in this conversation ` +
		`(the read tool returned "File not found", or you never opened them):\n` +
		flagged.map((f) => `  - ${f}`).join("\n") +
		`\n\nEvery [source: <file> | ...] citation MUST point at a file you actually read. Do NOT guess filenames or invent values. ` +
		`Read the report directory (or use glob) to get the EXACT names (they do NOT follow canonical NI 43-101 item numbering), read the real files, and remove or correct every claim that cites a file you could not read. ` +
		`If the evidence is not in any real file, mark that point [not found in report] or return a ⚪ INSUFFICIENT verdict — never fabricate. Then give your complete corrected answer again, in full.`
	)
}
