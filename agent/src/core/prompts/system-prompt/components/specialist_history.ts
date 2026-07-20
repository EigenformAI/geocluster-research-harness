import { isCapabilityGap } from "@shared/specialists"
import type { PromptVariant, SystemPromptContext } from "../types"

const MAX_RENDERED_ENTRIES = 20

/**
 * Component that renders specialist dispatch history for the orchestrator.
 * Only shows content when there is history to display (invariant L2: traceability).
 * Caps rendered entries at MAX_RENDERED_ENTRIES most recent to prevent prompt bloat (V-6).
 */
export async function getSpecialistHistory(_variant: PromptVariant, context: SystemPromptContext): Promise<string | undefined> {
	const history = context.specialistHistory
	if (!history || history.length === 0) {
		return undefined
	}

	// Summary line for older entries beyond the render cap
	let summaryLine = ""
	if (history.length > MAX_RENDERED_ENTRIES) {
		const older = history.slice(0, history.length - MAX_RENDERED_ENTRIES)
		let successCount = 0
		let errorCount = 0
		let pendingCount = 0
		for (const entry of older) {
			if (!entry.result) {
				pendingCount++
			} else if (isCapabilityGap(entry.result)) {
				errorCount++ // capability gaps count as needing attention
			} else if (entry.result.status === "success") {
				successCount++
			} else {
				errorCount++
			}
		}
		summaryLine = `[${older.length} earlier dispatches: ${successCount} success, ${errorCount} error, ${pendingCount} pending]\n\n`
	}

	// Only render the most recent entries
	const recentHistory = history.slice(-MAX_RENDERED_ENTRIES)

	const entries = recentHistory.map((entry) => {
		let status = "pending"
		let errors = ""

		if (entry.result) {
			if (isCapabilityGap(entry.result)) {
				status = `capability_gap (needs ${entry.result.permission_request.package})`
			} else {
				status = entry.result.status ?? "unknown"
				errors = entry.result.errors?.length ? `\n    Errors: ${entry.result.errors.join("; ")}` : ""
			}
		}

		const duration = entry.completedAt ? `${Math.round((entry.completedAt - entry.startedAt) / 1000)}s` : "running"
		return `- [${entry.task_id}] ${entry.specialist}: ${status} (${duration})${errors}\n  Objective: ${entry.objective}`
	})

	return `SPECIALIST DISPATCH HISTORY

The following specialists have been dispatched in this session. Use this to avoid redundant dispatches and to track workflow progress.

${summaryLine}${entries.join("\n\n")}`
}
