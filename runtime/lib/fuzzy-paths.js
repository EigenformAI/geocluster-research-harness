import initFrizbee, { Matcher } from "frizbee"

/**
 * Typo-tolerant path matching with frizbee, the Smith-Waterman matcher inside the fff file finder.
 * Its WebAssembly module loads on the first fuzzy query; a failed load is retried on the next one.
 */
let loading

export function fuzzyPaths() {
	loading ??= initFrizbee().then(() => ({ scores, positions })).catch((error) => { loading = undefined; throw error })
	return loading
}

function matching(q, paths, indices) {
	// One typo per four typed characters.
	const matcher = new Matcher(q, { maxTypos: Math.floor([...q].length / 4) })
	try { return indices ? matcher.matchListIndices(paths) : matcher.matchList(paths) } finally { matcher.free() }
}

/** The score of each path `q` matches, keyed by its index in `paths`; higher is better. */
function scores(q, paths) {
	return new Map(matching(q, paths, false).map((match) => [match.index, match.score]))
}

/** For each path, the code point offsets of the characters `q` matched, ascending. */
function positions(q, paths) {
	const found = new Map(matching(q, paths, true).map((match) => [match.index, match.indices]))
	return paths.map((path, index) => codePoints(path, found.get(index) ?? []))
}

// frizbee reports UTF-8 byte offsets.
function codePoints(text, bytes) {
	const offsets = new Map()
	let byte = 0, point = 0
	for (const character of text) {
		offsets.set(byte, point++)
		byte += Buffer.byteLength(character)
	}
	return bytes.filter((offset) => offsets.has(offset)).map((offset) => offsets.get(offset)).sort((a, b) => a - b)
}
