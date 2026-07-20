import { isValidSpecialist, SpecialistType } from "@shared/specialists"
import { exec } from "child_process"
import * as fs from "fs"
import { promisify } from "util"
import { Logger } from "../shared/services/Logger"

const execAsync = promisify(exec)

// Module-level cache for CLI detection result
let cachedCliAvailable: boolean | null = null
let cacheTimestamp = 0
const NEGATIVE_CACHE_TTL_MS = 10_000 // Retry after 10s if not found

/**
 * Parameters used to detect CLI subagent context
 */
interface CliSubagentDetectionParams {
	yoloModeToggled: boolean
	maxConsecutiveMistakes: number
	isOneshot?: boolean
	outputFormat?: string
}

/**
 * Check if the Cline CLI tool is installed on the system
 * @returns true if CLI is installed, false otherwise
 */
export async function isClineCliInstalled(): Promise<boolean> {
	// Return cached positive result forever (binary doesn't get uninstalled mid-session)
	if (cachedCliAvailable === true) {
		return true
	}
	// Return cached negative result if within TTL
	if (cachedCliAvailable === false && Date.now() - cacheTimestamp < NEGATIVE_CACHE_TTL_MS) {
		return false
	}

	const envPath = process.env.PATH || "(empty)"
	Logger.log(`[CLI Detect] PATH=${envPath}`)

	// Fast path: check known installation locations
	const knownPaths = ["/usr/local/bin/cline", "/usr/bin/cline"]
	for (const binPath of knownPaths) {
		try {
			await fs.promises.access(binPath, fs.constants.X_OK)
			Logger.log(`[CLI Detect] Found executable cline at ${binPath}`)
			cachedCliAvailable = true
			cacheTimestamp = Date.now()
			return true
		} catch {
			// Not at this path, try next
		}
	}

	// Fallback: resolve via PATH using `which`
	try {
		const { stdout } = await execAsync("which cline 2>/dev/null", { timeout: 3000 })
		const resolvedPath = stdout.trim()
		if (resolvedPath && !resolvedPath.includes("NOT_FOUND")) {
			try {
				await fs.promises.access(resolvedPath, fs.constants.X_OK)
				Logger.log(`[CLI Detect] Found executable cline via which: ${resolvedPath}`)
				cachedCliAvailable = true
				cacheTimestamp = Date.now()
				return true
			} catch {
				Logger.log(`[CLI Detect] which returned ${resolvedPath} but file is not executable`)
			}
		}
	} catch {
		Logger.log("[CLI Detect] 'which cline' failed or timed out")
	}

	Logger.log("[CLI Detect] cline binary not found at known paths or in PATH")
	cachedCliAvailable = false
	cacheTimestamp = Date.now()
	return false
}

/**
 * Detect if the current Cline instance is running as a CLI subagent.
 * CLI subagents are identified by specific parameter patterns set by the transformClineCommand function.
 *     TODO - For now we are relying on the maxConsecutiveMistakes value, which will only ever be "3"
 *     unless users pass in "-s max_consecutive_mistakes=6" via Cline CLI. Would like better detection.
 * @param params The current task parameters to analyze
 * @returns true if this appears to be a CLI subagent context
 */
export function isCliSubagentContext(params: CliSubagentDetectionParams): boolean {
	const hasYoloMode = params.yoloModeToggled === true
	const hasHighMistakeLimit = params.maxConsecutiveMistakes === 6

	return hasYoloMode && hasHighMistakeLimit
}

/**
 * Read CLINE_SPECIALIST env var to detect if running as a spawned specialist child.
 * Validates the value and logs warnings for invalid or missing env vars (invariant X-4).
 * @returns The specialist type if set and valid, null otherwise
 */
export function getSpecialistType(): SpecialistType | null {
	const value = process.env.CLINE_SPECIALIST
	if (!value) return null
	if (isValidSpecialist(value)) {
		return value as SpecialistType
	}
	// Invalid value — log error so it's visible in child process output
	const validTypes = Object.values(SpecialistType).join(", ")
	Logger.error(
		`[CLI] Invalid CLINE_SPECIALIST="${value}". Valid types: ${validTypes}. ` + `Child will run without specialist behavior.`,
	)
	return null
}

/**
 * @returns true if this process was launched as a specialist child
 */
export function isSpecialistContext(): boolean {
	return getSpecialistType() !== null
}
