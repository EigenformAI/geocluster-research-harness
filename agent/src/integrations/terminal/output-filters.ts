/**
 * Subagent Output Filters
 *
 * Mechanistic defense against data dumps in conversation context.
 * Applied to subagent command output before truncation in processOutput().
 *
 * Three layers:
 * 1. Result marker extraction — if ===RESULT=== markers found, return only marked content
 * 2. Data-aware collapsing — detect and collapse tabular/CSV-like output runs
 * 3. Fall through to existing truncation in processOutput()
 */

import { RESULT_MARKER_END, RESULT_MARKER_START, TABULAR_RUN_MIN_LINES } from "./constants"

// =============================================================================
// Result Marker Extraction
// =============================================================================

/**
 * Extract content between ===RESULT=== and ===END_RESULT=== markers.
 *
 * - If both markers found: returns only lines between them (exclusive of markers)
 * - If only start marker found: returns lines from start marker to end
 * - If neither found: returns null (signal to fall through to next filter)
 * - Handles multiple marker pairs (takes the last pair — final result wins)
 */
export function extractMarkedResult(lines: string[]): string[] | null {
	let lastStartIdx = -1
	let lastEndIdx = -1

	for (let i = 0; i < lines.length; i++) {
		const trimmed = lines[i].trim()
		if (trimmed === RESULT_MARKER_START) {
			lastStartIdx = i
		} else if (trimmed === RESULT_MARKER_END) {
			// Only count end markers that come after a start marker
			if (lastStartIdx >= 0) {
				lastEndIdx = i
			}
		}
	}

	if (lastStartIdx < 0) {
		return null // No markers found — fall through
	}

	if (lastEndIdx > lastStartIdx) {
		// Both markers found — return content between them
		return lines.slice(lastStartIdx + 1, lastEndIdx)
	}

	// Only start marker found — return from start marker to end
	return lines.slice(lastStartIdx + 1)
}

// =============================================================================
// Tabular Data Detection
// =============================================================================

interface TabularLineResult {
	isTabular: boolean
	delimiterCount: number
}

/**
 * Check if a line looks like tabular/CSV data.
 * A tabular line has 2+ delimiters (commas or tabs), suggesting 3+ fields.
 * If expectedDelimiters is provided, checks consistency (±1).
 */
function isDelimitedTabularLine(line: string, expectedDelimiters?: number): TabularLineResult {
	const trimmed = line.trim()
	if (trimmed.length === 0) return { isTabular: false, delimiterCount: 0 }

	const commas = (trimmed.match(/,/g) || []).length
	const tabs = (trimmed.match(/\t/g) || []).length
	const delimCount = Math.max(commas, tabs)

	// Need at least 2 delimiters (3+ fields)
	if (delimCount < 2) return { isTabular: false, delimiterCount: 0 }

	// If we have an expected count, check consistency
	if (expectedDelimiters !== undefined) {
		const consistent = Math.abs(delimCount - expectedDelimiters) <= 1
		return { isTabular: consistent, delimiterCount: delimCount }
	}

	return { isTabular: true, delimiterCount: delimCount }
}

/**
 * Check if a line looks like pandas DataFrame __repr__ output.
 * Matches patterns like: "  0  1.234  5.678  -0.9" (index + numeric columns)
 */
function isDataFrameReprLine(line: string): boolean {
	// Index followed by whitespace-separated numeric values
	return /^\s*\d+\s+([\d.\-eE+]+\s+){2,}/.test(line)
}

/** Lines that should never be classified as tabular data */
const NON_DATA_PREFIXES = ["#", "//", "Error", "Traceback", "WARNING", "WARN", "INFO", "DEBUG", ">>>", "..."]

/**
 * Check if a line is obviously non-data (error output, comments, etc.)
 */
function isNonDataLine(line: string): boolean {
	const trimmed = line.trim()
	return NON_DATA_PREFIXES.some((prefix) => trimmed.startsWith(prefix))
}

/**
 * Walk through lines detecting and collapsing tabular runs.
 *
 * A "tabular run" is a sequence of consecutive lines where:
 * - The line has consistent delimiter count (commas or tabs) matching a header-like first line
 * - OR the line matches DataFrame repr pattern (index + numeric columns)
 * - The line is not an obvious non-data line
 *
 * When a run of >= TABULAR_RUN_MIN_LINES is detected:
 * - Keep the first line (likely header)
 * - Replace the rest with a summary message
 *
 * Non-tabular lines pass through unchanged.
 */
export function collapseTabularOutput(lines: string[]): string[] {
	const result: string[] = []
	let i = 0

	while (i < lines.length) {
		// Skip non-data lines
		if (isNonDataLine(lines[i])) {
			result.push(lines[i])
			i++
			continue
		}

		// Check for delimited tabular run start
		const firstCheck = isDelimitedTabularLine(lines[i])
		if (firstCheck.isTabular) {
			// Potential tabular run — scan ahead
			const runStart = i
			const expectedDelimiters = firstCheck.delimiterCount
			i++

			while (i < lines.length) {
				if (isNonDataLine(lines[i])) break
				const check = isDelimitedTabularLine(lines[i], expectedDelimiters)
				if (!check.isTabular) break
				i++
			}

			const runLength = i - runStart
			if (runLength >= TABULAR_RUN_MIN_LINES) {
				// Collapse: keep header, replace rest
				result.push(lines[runStart])
				result.push(`[${runLength - 1} data rows collapsed — use result markers to surface specific values]`)
			} else {
				// Too short to collapse — pass through
				for (let j = runStart; j < i; j++) {
					result.push(lines[j])
				}
			}
			continue
		}

		// Check for DataFrame repr run start
		if (isDataFrameReprLine(lines[i])) {
			const runStart = i
			i++

			while (i < lines.length) {
				if (isNonDataLine(lines[i])) break
				if (!isDataFrameReprLine(lines[i])) break
				i++
			}

			const runLength = i - runStart
			if (runLength >= TABULAR_RUN_MIN_LINES) {
				result.push(lines[runStart])
				result.push(`[${runLength - 1} DataFrame rows collapsed — use result markers to surface specific values]`)
			} else {
				for (let j = runStart; j < i; j++) {
					result.push(lines[j])
				}
			}
			continue
		}

		// Non-tabular line — pass through
		result.push(lines[i])
		i++
	}

	return result
}

// =============================================================================
// Orchestrator
// =============================================================================

/**
 * Apply subagent output filters before truncation.
 *
 * Layer 1: Try result marker extraction (if markers found, return only marked content)
 * Layer 2: Collapse tabular data (backstop for when markers are missing)
 */
export function filterSubagentOutput(lines: string[]): string[] {
	// Layer 1: Try result marker extraction
	const marked = extractMarkedResult(lines)
	if (marked !== null) return marked

	// Layer 2: Collapse tabular data
	return collapseTabularOutput(lines)
}
