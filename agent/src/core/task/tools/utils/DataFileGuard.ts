import * as fs from "node:fs"
import * as path from "node:path"
import { Logger } from "@/shared/services/Logger"

/**
 * File read truncation guard — prevents large data files from overflowing the LLM context window.
 *
 * Layer 1: Data file extensions get line-count truncation (first 5 lines if > 50 lines).
 * Layer 2: Token-based safety net for ALL files (truncate if > 15% of context window).
 *
 * Token estimation uses content.length / 3 (conservative — code has many short tokens
 * like braces, semicolons, newlines that each cost 1 token but only 1-2 chars).
 */

export interface TruncationResult {
	content: string
	wasTruncated: boolean
}

const DATA_FILE_EXTENSIONS = new Set([".csv", ".tsv", ".json", ".jsonl", ".ndjson", ".xlsx", ".xls", ".log", ".dat", ".las"])

const MAX_DATA_FILE_LINES = 50
const DATA_FILE_PREVIEW_LINES = 5
const SMALL_JSON_THRESHOLD_BYTES = 50 * 1024 // 50KB
const CHARS_PER_TOKEN = 3 // conservative estimate (code-heavy content averages ~2.5-3.5 chars/token)

/**
 * Hardcoded fallback token budget for code paths without API context (e.g., user-attached files).
 * 20k tokens ≈ 60k chars at /3 ratio. Generous enough for most useful files,
 * small enough to prevent context overflow.
 */
const FALLBACK_MAX_TOKENS = 20_000

/**
 * Returns true if the file extension is a known data file type that should be
 * subject to Layer 1 line-count truncation.
 */
export function isDataFile(filePath: string): boolean {
	const ext = path.extname(filePath).toLowerCase()
	return DATA_FILE_EXTENSIONS.has(ext)
}

/**
 * Layer 1 — Data file line-count limit.
 * For known data extensions, truncate to first 5 lines if the file exceeds 50 lines.
 * Exception: .json files under 50KB are skipped (likely config files).
 */
export function truncateDataFilePreview(content: string, filePath: string): TruncationResult {
	const ext = path.extname(filePath).toLowerCase()

	// Exception: small JSON files are likely config files (package.json, tsconfig.json, etc.)
	if (ext === ".json") {
		try {
			const stats = fs.statSync(filePath)
			if (stats.size < SMALL_JSON_THRESHOLD_BYTES) {
				return { content, wasTruncated: false }
			}
		} catch {
			// If we can't stat the file, proceed with truncation
		}
	}

	const lines = content.split("\n")
	const totalLines = lines.length

	if (totalLines <= MAX_DATA_FILE_LINES) {
		return { content, wasTruncated: false }
	}

	const preview = lines.slice(0, DATA_FILE_PREVIEW_LINES).join("\n")
	Logger.info(
		`DataFileGuard: Layer 1 truncated ${path.basename(filePath)} from ${totalLines} lines to ${DATA_FILE_PREVIEW_LINES}`,
	)
	return {
		content: `${preview}\n[Showing first ${DATA_FILE_PREVIEW_LINES} of ${totalLines} lines — file truncated]`,
		wasTruncated: true,
	}
}

/**
 * Layer 2 — Token-based safety net for ALL files.
 * Estimates token count as content.length / CHARS_PER_TOKEN. If it exceeds maxAllowedTokens,
 * truncates to fit that budget.
 */
export function applyTokenSafetyNet(content: string, maxAllowedTokens: number): TruncationResult {
	const estimatedTokens = content.length / CHARS_PER_TOKEN

	if (estimatedTokens <= maxAllowedTokens) {
		return { content, wasTruncated: false }
	}

	const maxChars = maxAllowedTokens * CHARS_PER_TOKEN
	const truncated = content.slice(0, maxChars)

	Logger.info(
		`DataFileGuard: Layer 2 truncated content from ~${Math.round(estimatedTokens)} to ~${maxAllowedTokens} estimated tokens (${maxChars} of ${content.length} chars)`,
	)
	return {
		content: `${truncated}\n[Content truncated to fit context window — showing first ${maxChars} of ${content.length} characters]`,
		wasTruncated: true,
	}
}

/**
 * Apply token safety net with a hardcoded fallback budget.
 * Use this for code paths that don't have access to the API handler / context window info
 * (e.g., user-attached files via processFilesIntoText).
 */
export function applyFallbackTokenSafetyNet(content: string): TruncationResult {
	return applyTokenSafetyNet(content, FALLBACK_MAX_TOKENS)
}
