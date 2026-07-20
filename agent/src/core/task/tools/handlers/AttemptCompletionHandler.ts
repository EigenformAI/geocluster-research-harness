import type Anthropic from "@anthropic-ai/sdk"
import type { ToolUse } from "@core/assistant-message"
import { getHooksEnabledSafe } from "@core/hooks/hooks-utils"
import { formatResponse } from "@core/prompts/responses"
import { processFilesIntoText } from "@integrations/misc/extract-text"
import { showSystemNotification } from "@integrations/notifications"
import { telemetryService } from "@services/telemetry"
import { findLastIndex } from "@shared/array"
import { COMPLETION_RESULT_CHANGES_FLAG } from "@shared/ExtensionMessage"
import { isCapabilityGap } from "@shared/specialists"
import { ClineDefaultTool } from "@shared/tools"
import { exec } from "child_process"
import * as fs from "fs/promises"
import * as path from "path"
import { promisify } from "util"

const execAsync = promisify(exec)

import { Logger } from "@/shared/services/Logger"
import type { ToolResponse } from "../../index"
import { buildUserFeedbackContent } from "../../utils/buildUserFeedbackContent"
import type { IPartialBlockHandler, IToolHandler } from "../ToolExecutorCoordinator"
import type { TaskConfig } from "../types/TaskConfig"
import type { StronglyTypedUIHelpers } from "../types/UIHelpers"
import { ToolResultUtils } from "../utils/ToolResultUtils"
import { findFabricatedCitations } from "../utils/citationGuard"

export class AttemptCompletionHandler implements IToolHandler, IPartialBlockHandler {
	readonly name = ClineDefaultTool.ATTEMPT

	getDescription(block: ToolUse): string {
		return `[${block.name}]`
	}

	/**
	 * Handle partial block streaming for attempt_completion
	 * Matches the original conditional logic structure for command vs no-command cases
	 */
	async handlePartialBlock(block: ToolUse, uiHelpers: StronglyTypedUIHelpers): Promise<void> {
		const result = block.params.result
		const command = block.params.command

		if (!command) {
			// no command, still outputting partial result
			await uiHelpers.say(
				"completion_result",
				uiHelpers.removeClosingTag(block, "result", result),
				undefined,
				undefined,
				block.partial,
			)
		}
	}

	async execute(config: TaskConfig, block: ToolUse): Promise<ToolResponse> {
		const result: string | undefined = block.params.result
		const command: string | undefined = block.params.command

		// Validate required parameters
		if (!result) {
			config.taskState.consecutiveMistakeCount++
			return await config.callbacks.sayAndCreateMissingParamError(this.name, "result")
		}

		config.taskState.consecutiveMistakeCount = 0

		// V-3: Enforce capability gap relay — specialist must include the gap JSON in its completion result
		if (config.taskState.capabilityGapPending && config.taskState.activeSpecialist) {
			try {
				const parsed = JSON.parse(result)
				if (isCapabilityGap(parsed)) {
					// Specialist correctly relayed the capability gap — clear the flag and proceed
					config.taskState.capabilityGapPending = null
				} else {
					// Specialist returned something else while a capability gap is pending
					config.taskState.consecutiveMistakeCount++
					return formatResponse.toolError(
						`A capability gap was detected via request_capability but your completion result does not contain the capability_gap JSON. ` +
							`You MUST relay the capability gap result to the orchestrator. Call attempt_completion with the JSON from request_capability as the result.`,
					)
				}
			} catch {
				// Result is not valid JSON — specialist did not relay the gap
				config.taskState.consecutiveMistakeCount++
				return formatResponse.toolError(
					`A capability gap was detected via request_capability but your completion result is not valid JSON. ` +
						`You MUST relay the capability gap result to the orchestrator. Call attempt_completion with the JSON from request_capability as the result.`,
				)
			}
		}

		// Report Analysis citation guard (anti-fabrication seatbelt). Prompt rules alone do
		// not reliably stop the model from inventing filenames + data, so before accepting a
		// completion in report-analysis mode we reject any answer that cites files the agent
		// never successfully read, and send it back to fix. Scoped to the top-level agent
		// (not specialists) and only this mode, so other agents are unaffected.
		if (
			!config.taskState.activeSpecialist &&
			config.services.stateManager.getGlobalSettingsKey("agentMode") === "report-analysis"
		) {
			const fabricated = findFabricatedCitations(result, config.taskState.readFilePaths)
			if (fabricated.length > 0) {
				config.taskState.consecutiveMistakeCount++
				return formatResponse.toolError(
					`Citation check FAILED. Your answer cites these files, but you never successfully read them in this task ` +
						`(read_file returned "File not found", or you never opened them):\n` +
						fabricated.map((f) => `  - ${f}`).join("\n") +
						`\n\nEvery [source: <file> | ...] citation MUST point at a file you actually read. Do NOT guess filenames or invent values. ` +
						`Run list_files on the report directory to get the EXACT names (they do NOT follow canonical NI 43-101 item numbering), read the real files, and remove or correct every claim that cites a file you could not read. ` +
						`If the evidence is not in any real file, mark that point [not found in report] or return a ⚪ INSUFFICIENT verdict — never fabricate. Then call attempt_completion again.`,
				)
			}
		}

		// Run PreToolUse hook before execution
		try {
			const { ToolHookUtils } = await import("../utils/ToolHookUtils")
			await ToolHookUtils.runPreToolUseIfEnabled(config, block)
		} catch (error) {
			const { PreToolUseHookCancellationError } = await import("@core/hooks/PreToolUseHookCancellationError")
			if (error instanceof PreToolUseHookCancellationError) {
				return formatResponse.toolDenied()
			}
			throw error
		}

		// Show notification if enabled
		if (config.autoApprovalSettings.enableNotifications) {
			showSystemNotification({
				subtitle: "Task Completed",
				message: result.replace(/\n/g, " "),
			})
		}

		const addNewChangesFlagToLastCompletionResultMessage = async () => {
			// Add newchanges flag if there are new changes to the workspace
			const hasNewChanges = await config.callbacks.doesLatestTaskCompletionHaveNewChanges()
			const clineMessages = config.messageState.getClineMessages()

			const lastCompletionResultMessageIndex = findLastIndex(clineMessages, (m: any) => m.say === "completion_result")
			const lastCompletionResultMessage =
				lastCompletionResultMessageIndex !== -1 ? clineMessages[lastCompletionResultMessageIndex] : undefined
			if (
				lastCompletionResultMessage &&
				lastCompletionResultMessageIndex !== -1 &&
				hasNewChanges &&
				!lastCompletionResultMessage.text?.endsWith(COMPLETION_RESULT_CHANGES_FLAG)
			) {
				await config.messageState.updateClineMessage(lastCompletionResultMessageIndex, {
					text: lastCompletionResultMessage.text + COMPLETION_RESULT_CHANGES_FLAG,
				})
			}
		}

		// Remove any partial completion_result message that may exist
		// Search backwards since other messages may have been inserted after the partial
		const clineMessages = config.messageState.getClineMessages()
		const partialCompletionIndex = findLastIndex(
			clineMessages,
			(m) => m.partial === true && m.type === "say" && m.say === "completion_result",
		)
		if (partialCompletionIndex !== -1) {
			const updatedMessages = [
				...clineMessages.slice(0, partialCompletionIndex),
				...clineMessages.slice(partialCompletionIndex + 1),
			]
			config.messageState.setClineMessages(updatedMessages)
			await config.messageState.saveClineMessagesAndUpdateHistory()
		}

		let commandResult: any
		const lastMessage = config.messageState.getClineMessages().at(-1)

		if (command) {
			if (lastMessage && lastMessage.ask !== "command") {
				// haven't sent a command message yet so first send completion_result then command
				const completionMessageTs = await config.callbacks.say("completion_result", result, undefined, undefined, false)
				await config.callbacks.saveCheckpoint(true, completionMessageTs)
				await addNewChangesFlagToLastCompletionResultMessage()
				telemetryService.captureTaskCompleted(config.ulid)
			} else {
				// we already sent a command message, meaning the complete completion message has also been sent
				await config.callbacks.saveCheckpoint(true)
			}

			// Attempt completion is a special tool where we want to update the focus chain list before the user provides response
			if (!block.partial && config.focusChainSettings.enabled) {
				await config.callbacks.updateFCListFromToolResponse(block.params.task_progress)
			}

			// complete command message - need to ask for approval
			const didApprove = await ToolResultUtils.askApprovalAndPushFeedback("command", command, config)
			if (!didApprove) {
				return formatResponse.toolDenied()
			}

			// User approved, execute the command
			const [userRejected, execCommandResult] = await config.callbacks.executeCommandTool(command!, undefined) // no timeout for attempt_completion command
			if (userRejected) {
				config.taskState.didRejectTool = true
				return execCommandResult
			}
			// user didn't reject, but the command may have output
			commandResult = execCommandResult
		} else {
			// Send the complete completion_result message (partial was already removed above)
			const completionMessageTs = await config.callbacks.say("completion_result", result, undefined, undefined, false)
			await config.callbacks.saveCheckpoint(true, completionMessageTs)
			await addNewChangesFlagToLastCompletionResultMessage()
			telemetryService.captureTaskCompleted(config.ulid)
		}

		// we already sent completion_result says, an empty string asks relinquishes control over button and field
		// in case last command was interactive and in partial state, the UI is expecting an ask response. This ends the command ask response, freeing up the UI to proceed with the completion ask.
		if (config.messageState.getClineMessages().at(-1)?.ask === "command_output") {
			await config.callbacks.say("command_output", "")
		}

		if (!block.partial && config.focusChainSettings.enabled) {
			await config.callbacks.updateFCListFromToolResponse(block.params.task_progress)
		}

		// Run TaskComplete hook BEFORE presenting the "Start New Task" button
		// At this point we know: task is complete, checkpoint saved, result shown to user
		await this.runTaskCompleteHook(config, block)

		// Save completion result to a markdown report file in the workspace (top-level task only, not specialists)
		if (!config.taskState.activeSpecialist) {
			await this.saveCompletionReport(config.cwd, result)
		}

		const { response, text, images, files: completionFiles } = await config.callbacks.ask("completion_result", "", false)
		const prefix = "[attempt_completion] Result: Done"
		if (response === "yesButtonClicked") {
			return prefix // signals to recursive loop to stop (for now this never happens since yesButtonClicked will trigger a new task)
		}

		await config.callbacks.say("user_feedback", text ?? "", images, completionFiles)

		// Run UserPromptSubmit hook when user provides post-completion feedback
		let hookContextModification: string | undefined
		if (text || (images && images.length > 0) || (completionFiles && completionFiles.length > 0)) {
			const userContentForHook = await buildUserFeedbackContent(text, images, completionFiles)

			const hookResult = await config.callbacks.runUserPromptSubmitHook(userContentForHook, "feedback")

			if (hookResult.cancel === true) {
				return formatResponse.toolDenied()
			}

			// Capture hook context modification to add to tool results
			hookContextModification = hookResult.contextModification
		}

		const toolResults: (Anthropic.TextBlockParam | Anthropic.ImageBlockParam)[] = []
		if (commandResult) {
			if (typeof commandResult === "string") {
				toolResults.push({
					type: "text",
					text: commandResult,
				})
			} else if (Array.isArray(commandResult)) {
				toolResults.push(...commandResult)
			}
		}

		if (text) {
			toolResults.push(
				{
					type: "text",
					text: "The user has provided feedback on the results. Consider their input to continue the task, and then attempt completion again.",
				},
				{
					type: "text",
					text: `<feedback>\n${text}\n</feedback>`,
				},
			)
		}

		// Add hook context modification if provided
		if (hookContextModification) {
			toolResults.push({
				type: "text" as const,
				text: `<hook_context source="UserPromptSubmit">\n${hookContextModification}\n</hook_context>`,
			})
		}

		const fileContentString = completionFiles?.length ? await processFilesIntoText(completionFiles) : ""
		if (fileContentString) {
			toolResults.push({
				type: "text" as const,
				text: fileContentString,
			})
		}

		if (images && images.length > 0) {
			toolResults.push(...formatResponse.imageBlocks(images))
		}

		// Return the tool results as a complex response
		return [
			{
				type: "text" as const,
				text: prefix,
			},
			...toolResults,
		]
	}

	/**
	 * Saves the completion result as .md, .pdf, and .docx in _reports/ directory.
	 * File format: _reports/REPORT_YYYYMMDD_HHmmss.{md,pdf,docx}
	 * PDF/DOCX generated via pandoc (requires pandoc + weasyprint in container).
	 */
	private async saveCompletionReport(cwd: string, result: string): Promise<void> {
		try {
			const reportsDir = path.join(cwd, "_reports")
			await fs.mkdir(reportsDir, { recursive: true })

			const now = new Date()
			const pad = (n: number) => String(n).padStart(2, "0")
			const timestamp =
				`${now.getFullYear()}${pad(now.getMonth() + 1)}${pad(now.getDate())}_` +
				`${pad(now.getHours())}${pad(now.getMinutes())}${pad(now.getSeconds())}`
			const baseName = `REPORT_${timestamp}`
			const mdPath = path.join(reportsDir, `${baseName}.md`)
			await fs.writeFile(mdPath, result, "utf-8")
			Logger.info(`[AttemptCompletion] Saved completion report to ${mdPath}`)

			// Generate PDF and DOCX via pandoc (non-blocking, non-fatal)
			const docxPath = path.join(reportsDir, `${baseName}.docx`)
			const pdfPath = path.join(reportsDir, `${baseName}.pdf`)

			const conversions = [
				execAsync(`pandoc "${mdPath}" -o "${docxPath}"`).then(() =>
					Logger.info(`[AttemptCompletion] Generated DOCX: ${docxPath}`),
				),
				execAsync(`pandoc "${mdPath}" -o "${pdfPath}" --pdf-engine=weasyprint`).then(() =>
					Logger.info(`[AttemptCompletion] Generated PDF: ${pdfPath}`),
				),
			]

			// Run conversions in parallel, don't block on failure
			const results = await Promise.allSettled(conversions)
			for (const r of results) {
				if (r.status === "rejected") {
					Logger.error("[AttemptCompletion] Report conversion failed (non-fatal):", r.reason)
				}
			}
		} catch (error) {
			Logger.error("[AttemptCompletion] Failed to save completion report (non-fatal):", error)
		}
	}

	/**
	 * Runs the TaskComplete hook after user confirms task completion.
	 * This is a non-cancellable, observation-only hook similar to TaskCancel.
	 * Errors are logged but do not affect task completion.
	 */
	private async runTaskCompleteHook(config: TaskConfig, block: ToolUse): Promise<void> {
		const hooksEnabled = getHooksEnabledSafe()
		if (!hooksEnabled) {
			return
		}

		try {
			const { executeHook } = await import("@core/hooks/hook-executor")

			await executeHook({
				hookName: "TaskComplete",
				hookInput: {
					taskComplete: {
						taskMetadata: {
							taskId: config.taskId,
							ulid: config.ulid,
							result: block.params.result || "",
							command: block.params.command || "",
						},
					},
				},
				isCancellable: false, // Non-cancellable - task is already complete
				say: config.callbacks.say,
				setActiveHookExecution: undefined, // Explicitly undefined for non-cancellable hooks
				clearActiveHookExecution: undefined, // Explicitly undefined for non-cancellable hooks
				messageStateHandler: config.messageState,
				taskId: config.taskId,
				hooksEnabled,
			})
		} catch (error) {
			// TaskComplete hook failed - non-fatal, just log
			Logger.error("[TaskComplete Hook] Failed (non-fatal):", error)
		}
	}
}
