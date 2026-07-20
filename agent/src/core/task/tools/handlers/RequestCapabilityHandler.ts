import type { ToolUse } from "@core/assistant-message"
import { formatResponse } from "@core/prompts/responses"
import type { CapabilityGapResult } from "@shared/specialists"
import { Logger } from "@/shared/services/Logger"
import { ClineDefaultTool } from "@/shared/tools"
import type { ToolResponse } from "../../index"
import type { IToolHandler } from "../ToolExecutorCoordinator"
import type { TaskConfig } from "../types/TaskConfig"

/**
 * Handler for request_capability tool.
 *
 * Called by specialist children when they need a package that isn't installed.
 * Returns a structured capability_gap result. The specialist's system prompt
 * instructs it to relay this back to the orchestrator via attempt_completion.
 * The orchestrator then handles installation via the Extended Capability agent.
 */
export class RequestCapabilityHandler implements IToolHandler {
	readonly name = ClineDefaultTool.REQUEST_CAPABILITY

	getDescription(block: ToolUse): string {
		const pkg = block.params.package || "unknown"
		return `[${block.name} requesting "${pkg}"]`
	}

	async execute(config: TaskConfig, block: ToolUse): Promise<ToolResponse> {
		const pkg = block.params.package
		const reason = block.params.reason

		if (!pkg) {
			config.taskState.consecutiveMistakeCount++
			return await config.callbacks.sayAndCreateMissingParamError(block.name, "package")
		}

		if (!reason) {
			config.taskState.consecutiveMistakeCount++
			return await config.callbacks.sayAndCreateMissingParamError(block.name, "reason")
		}

		config.taskState.consecutiveMistakeCount = 0

		const version = block.params.version
		const manager = (block.params.manager || "pip") as "pip" | "apt" | "conda"
		const fallback = block.params.fallback

		const capabilityGap: CapabilityGapResult = {
			task_id: `capability_${Date.now()}`,
			type: "capability_gap",
			permission_request: {
				package: pkg,
				version: version || undefined,
				manager,
				reason,
				fallback: fallback || undefined,
			},
			resume_on_completion: true,
		}

		// V-3: Set pending flag so AttemptCompletionHandler can enforce relay
		config.taskState.capabilityGapPending = capabilityGap

		Logger.log(`[Specialist] request_capability("${pkg}") — manager: ${manager}, reason: ${reason.substring(0, 100)}`)
		return formatResponse.toolResult(
			`Capability gap detected. You must now return this result to the orchestrator by calling attempt_completion with the following JSON as the result:\n\n${JSON.stringify(capabilityGap, null, 2)}\n\nDo NOT attempt to install the package yourself.`,
		)
	}
}
