import type { ToolUse } from "@core/assistant-message"
import { formatResponse } from "@core/prompts/responses"
import { SpecialistType } from "@shared/specialists"
import { Logger } from "@/shared/services/Logger"
import { ClineDefaultTool } from "@/shared/tools"
import type { ToolResponse } from "../../index"
import type { IToolHandler } from "../ToolExecutorCoordinator"
import type { TaskConfig } from "../types/TaskConfig"

/**
 * Handler for activate_specialist tool.
 *
 * Performs in-process variant switching by setting TaskState.activeSpecialist.
 * The next API turn will load the corresponding specialist variant automatically.
 *
 * Valid values:
 * - "orchestrator": switch to Analysis Orchestrator (Layer 2)
 * - "default": return to geology user-facing agent (Layer 1)
 */
export class ActivateSpecialistHandler implements IToolHandler {
	readonly name = ClineDefaultTool.ACTIVATE_SPECIALIST

	getDescription(block: ToolUse): string {
		const specialist = block.params.specialist || "unknown"
		return `[${block.name} to switch to "${specialist}" variant]`
	}

	async execute(config: TaskConfig, block: ToolUse): Promise<ToolResponse> {
		const specialist = block.params.specialist
		const reason = block.params.reason

		if (!specialist) {
			config.taskState.consecutiveMistakeCount++
			return await config.callbacks.sayAndCreateMissingParamError(block.name, "specialist")
		}

		if (!reason) {
			config.taskState.consecutiveMistakeCount++
			return await config.callbacks.sayAndCreateMissingParamError(block.name, "reason")
		}

		// Validate: only "orchestrator" and "default" are valid for variant switching
		if (specialist !== "default" && specialist !== SpecialistType.ORCHESTRATOR) {
			config.taskState.consecutiveMistakeCount++
			return formatResponse.toolError(
				`Invalid specialist "${specialist}" for activate_specialist. Use "orchestrator" or "default". To spawn other specialists, use dispatch_specialist instead.`,
			)
		}

		config.taskState.consecutiveMistakeCount = 0

		if (specialist === "default") {
			config.taskState.activeSpecialist = null
			Logger.log(
				`[Specialist] activate_specialist("default") — returning to geology variant. Reason: ${reason.substring(0, 200)}`,
			)
			return formatResponse.toolResult(
				`Specialist mode deactivated. Returning to geology user-facing agent. Reason: ${reason}`,
			)
		}

		config.taskState.activeSpecialist = SpecialistType.ORCHESTRATOR
		Logger.log(
			`[Specialist] activate_specialist("orchestrator") — switching to orchestrator variant. Reason: ${reason.substring(0, 200)}`,
		)
		return formatResponse.toolResult(
			`Specialist mode activated: orchestrator. The next turn will load the orchestrator variant. Objective: ${reason}`,
		)
	}
}
