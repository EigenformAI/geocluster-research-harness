/**
 * Report Analysis citation guard.
 *
 * The report-eval ("Report Analysis") agent must ground every claim in files it
 * actually read. Prompt rules alone do not reliably stop the model from inventing
 * filenames and data, so the AttemptCompletionHandler runs this check before
 * accepting a completion in report-analysis mode and rejects answers that cite
 * files the agent never successfully read.
 *
 * Pure string logic (no I/O) so it is unit-testable in isolation.
 */

/**
 * Find `[source: <file> | ...]` citations whose file was NOT successfully read.
 *
 * @param result        The answer text the agent is trying to submit.
 * @param readFilePaths Absolute paths of files successfully read this task.
 * @returns The cited file tokens that were never read (fabricated/guessed). Empty = clean.
 *
 * Only path-like file sources are validated; non-path tokens and `web`/URLs are ignored.
 * Matching is lenient on the directory prefix (a citation `text/NN.md` matches an absolute
 * read path ending in `/text/NN.md`) but strict on the trailing path, so a fabricated name
 * like `text/06_exploration.md` (never read) is reliably flagged while a real file cited
 * with a relative path is accepted.
 */
export function findFabricatedCitations(result: string, readFilePaths: Set<string>): string[] {
	const norm = (s: string) => s.replace(/\\/g, "/").replace(/^\.?\/+/, "").trim().toLowerCase()
	const reads = Array.from(readFilePaths).map(norm)
	const wasRead = (cited: string): boolean => {
		const n = norm(cited)
		return reads.some((r) => r === n || r.endsWith("/" + n))
	}

	const cited = new Set<string>()
	const re = /\[source:\s*([^|\]]+?)\s*(?:\||\])/gi
	let m: RegExpExecArray | null
	while ((m = re.exec(result)) !== null) {
		const src = m[1].trim()
		const looksLikeFile = src.includes("/") || /\.(md|csv|json|png|jpe?g|txt|tsv|tif|geojson)$/i.test(src)
		if (!looksLikeFile) {
			continue // skip non-path sources (e.g. "web", a table label, a stat expression)
		}
		if (/^web\b/i.test(src) || /^https?:\/\//i.test(src)) {
			continue
		}
		cited.add(src)
	}

	return Array.from(cited).filter((c) => !wasRead(c))
}
