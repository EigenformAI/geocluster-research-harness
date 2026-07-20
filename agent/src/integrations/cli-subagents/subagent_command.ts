/**
 * Pattern to match Cline CLI syntax with optional env-prefix(es):
 *   cline 'prompt'
 *   cline "prompt" --json -y
 *   CLINE_SPECIALIST=dataops cline 'prompt' --json -y
 *   CLINE_SPECIALIST=dataops CLINE_DATA_DIR=/path/to/dir cline 'prompt' --json -y
 *
 * Uses [\s\S] instead of . so prompts containing newlines are matched.
 * Group 1: env prefix(es) (e.g. "CLINE_SPECIALIST=dataops CLINE_DATA_DIR=/path ") or empty string
 * Group 2: quote character
 * Group 3: prompt content
 * Group 4: trailing flags (e.g. " --json -y") or undefined
 */
const CLINE_COMMAND_PATTERN = /^((?:\w+=\S+\s+)*)cline\s+(['"])([\s\S]+?)\2(\s+.*)?$/

/**
 * Detects if a command is a Cline CLI subagent command.
 *
 * Matches the simplified syntax: cline "prompt" or cline 'prompt'
 * Also matches env-prefix form: CLINE_SPECIALIST=dataops CLINE_DATA_DIR=/path cline 'prompt'
 * Supports multi-line prompts.
 *
 * @param command - The command string to check
 * @returns True if the command is a Cline CLI subagent command, false otherwise
 */
export function isSubagentCommand(command: string): boolean {
	return CLINE_COMMAND_PATTERN.test(command)
}

/**
 * Transforms simplified Cline CLI command syntax with subagent settings.
 *
 * Converts: cline "prompt" or cline 'prompt'
 * To: cline "prompt" --json -y
 *
 * Preserves env prefix: CLINE_SPECIALIST=dataops CLINE_DATA_DIR=/path cline 'prompt' → CLINE_SPECIALIST=dataops CLINE_DATA_DIR=/path cline 'prompt' --json -y
 * Preserves additional flags: cline "prompt" --cwd ./path → cline "prompt" --json -y --cwd ./path
 * Skips injection if --json and -y are already present.
 *
 * @param command - The command string to potentially transform
 * @returns The transformed command if it matches the pattern, otherwise the original command
 */
export function transformClineCommand(command: string): string {
	if (!isSubagentCommand(command)) {
		return command
	}

	return injectSubagentSettings(command)
}

/**
 * Injects --json -y flags into Cline CLI commands for autonomous subagent execution.
 *
 * Uses CLINE_COMMAND_PATTERN to safely parse the command structure, preserving
 * env prefixes and avoiding corruption of prompts containing interior quotes.
 * If the regex doesn't match, returns the command unchanged rather than
 * attempting a broken string-split heuristic.
 *
 * @param command - The Cline CLI command
 * @returns The command with injected flags, or unchanged if already present or unparseable
 */
function injectSubagentSettings(command: string): string {
	const postPromptFlags = ["--json", "-y"]

	const match = command.match(CLINE_COMMAND_PATTERN)
	if (match) {
		const envPrefix = match[1] // e.g. "CLINE_SPECIALIST=dataops " or ""
		const quote = match[2]
		const prompt = match[3]
		const existingFlags = match[4]?.trim() || ""

		// Don't double-inject if flags already present
		if (existingFlags.includes("--json") && existingFlags.includes("-y")) {
			return command
		}

		return `${envPrefix}cline ${quote}${prompt}${quote} ${postPromptFlags.join(" ")}${existingFlags ? " " + existingFlags : ""}`
	}

	// If regex doesn't match, return command unchanged — don't corrupt it
	return command
}
