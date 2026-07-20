import type { ToolUse } from "@core/assistant-message"
import { formatResponse } from "@core/prompts/responses"
import type { ApiProvider } from "@shared/api"
import { findLastIndex } from "@shared/array"
import type { ClineSaySpecialistDispatch } from "@shared/ExtensionMessage"
import type { CapabilityGapResult, SpecialistResult } from "@shared/specialists"
import { isCapabilityGap, isDispatchableSpecialist, isSpecialistResult } from "@shared/specialists"
import { ProviderToApiKeyMap, type Secrets } from "@shared/storage"
import * as fs from "fs"
import * as os from "os"
import * as path from "path"
import { HostProvider } from "@/hosts/host-provider"
import { Logger } from "@/shared/services/Logger"
import { ClineDefaultTool } from "@/shared/tools"
import { isClineCliInstalled } from "@/utils/cli-detector"
import type { ToolResponse } from "../../index"
import type { IToolHandler } from "../ToolExecutorCoordinator"
import type { TaskConfig } from "../types/TaskConfig"

const SPECIALIST_TIMEOUT_SECONDS = 600 // 10 minutes

/**
 * Handler for dispatch_specialist tool.
 *
 * Spawns a specialist child process via the CLI with CLINE_SPECIALIST env var set.
 * Parses the child's JSON output and tracks it in TaskState.
 */
export class DispatchSpecialistHandler implements IToolHandler {
	readonly name = ClineDefaultTool.DISPATCH_SPECIALIST
	private cliAvailable: boolean | null = null

	private async ensureCliAvailable(): Promise<boolean> {
		if (this.cliAvailable !== null) {
			Logger.log(`[Specialist] CLI availability cached: ${this.cliAvailable}`)
			return this.cliAvailable
		}
		Logger.log("[Specialist] Checking if Cline CLI is installed (first check)...")
		this.cliAvailable = await isClineCliInstalled()
		if (!this.cliAvailable) {
			Logger.log("[Specialist] ERROR: Cline CLI not found — see [CLI Detect] logs above for details")
		} else {
			Logger.log("[Specialist] Cline CLI detected successfully")
		}
		return this.cliAvailable
	}

	/**
	 * Mirror the active provider's API key(s) into <clineDataDir>/secrets.json
	 * so CLI specialist children can authenticate. The extension stores secrets
	 * in VS Code SecretStorage, which child processes cannot read; the CLI's
	 * SecretStore reads this file instead (see cli/src/vscode-context.ts).
	 * Failures are logged but never block the dispatch.
	 */
	private mirrorProviderSecretsForCli(clineDataDir: string, config: TaskConfig): void {
		try {
			const provider = config.services.stateManager.getGlobalSettingsKey("actModeApiProvider") as ApiProvider | undefined
			if (!provider) {
				return
			}
			const keyField = ProviderToApiKeyMap[provider]
			if (!keyField) {
				return
			}
			const fields = Array.isArray(keyField) ? keyField : [keyField]

			const secretsPath = path.join(clineDataDir, "secrets.json")
			let secrets: Record<string, string> = {}
			if (fs.existsSync(secretsPath)) {
				try {
					secrets = JSON.parse(fs.readFileSync(secretsPath, "utf8"))
				} catch {
					secrets = {}
				}
			}

			let updated = false
			for (const field of fields) {
				const value = config.services.stateManager.getSecretKey(field as keyof Secrets)
				if (value && secrets[field] !== value) {
					secrets[field] = value
					updated = true
				}
			}
			if (updated) {
				fs.mkdirSync(clineDataDir, { recursive: true })
				fs.writeFileSync(secretsPath, JSON.stringify(secrets, null, 2), { mode: 0o600 })
				fs.chmodSync(secretsPath, 0o600)
				Logger.log(`[Specialist] Mirrored ${provider} credentials into CLI secrets store`)
			}
		} catch (error) {
			Logger.error("[Specialist] Failed to mirror provider secrets for CLI child", error as Error)
		}
	}

	getDescription(block: ToolUse): string {
		const specialist = block.params.specialist || "unknown"
		return `[${block.name} spawning "${specialist}" specialist]`
	}

	/**
	 * Programmatic (non-LLM) call to a training-data MCP tool on the geocluster server.
	 * Used to bracket each specialist dispatch with the training lifecycle so the
	 * MCP-side middleware can record the child's tool calls into a session.
	 *
	 * Always fail-soft: any error returns null and is logged. Capture failures
	 * must never block specialist dispatch.
	 */
	private async callTrainingTool(
		config: TaskConfig,
		toolName: string,
		args: Record<string, unknown>,
	): Promise<Record<string, unknown> | null> {
		if (process.env.TRAINING_CAPTURE_ENABLED === "0") {
			return null
		}
		try {
			const response = await config.services.mcpHub.callTool("geocluster", toolName, args, config.ulid)
			const content = (response as { content?: Array<{ type?: string; text?: string }> })?.content
			const firstText = content?.find((c) => c?.type === "text")?.text
			if (!firstText) {
				return null
			}
			return JSON.parse(firstText) as Record<string, unknown>
		} catch (err) {
			Logger.log(
				`[Specialist] training: ${toolName} failed (non-fatal): ${err instanceof Error ? err.message : String(err)}`,
			)
			return null
		}
	}

	async execute(config: TaskConfig, block: ToolUse): Promise<ToolResponse> {
		const specialist = block.params.specialist
		const objective = block.params.objective
		const contextParam = block.params.context

		if (!specialist) {
			config.taskState.consecutiveMistakeCount++
			return await config.callbacks.sayAndCreateMissingParamError(block.name, "specialist")
		}

		if (!objective) {
			config.taskState.consecutiveMistakeCount++
			return await config.callbacks.sayAndCreateMissingParamError(block.name, "objective")
		}

		if (!isDispatchableSpecialist(specialist)) {
			config.taskState.consecutiveMistakeCount++
			return formatResponse.toolError(
				`Invalid specialist "${specialist}" for dispatch_specialist. Must be one of: dataops, transform, analytics, geoviz, extended. Use activate_specialist for orchestrator.`,
			)
		}

		config.taskState.consecutiveMistakeCount = 0

		if (!(await this.ensureCliAvailable())) {
			return formatResponse.toolError(
				`Cline CLI is not installed or not in PATH. Cannot dispatch specialist "${specialist}".`,
			)
		}

		// Build the prompt for the child process, auto-enriching with CSV column metadata
		let prompt = objective
		let enrichedContext = contextParam || ""
		if (contextParam) {
			try {
				const ctx = JSON.parse(contextParam)
				if (ctx.dataset_path && typeof ctx.dataset_path === "string") {
					const columnInfo = this.readCsvHeaders(ctx.dataset_path, config)
					if (columnInfo) {
						enrichedContext =
							contextParam + `\n\nDataset columns (auto-detected from ${ctx.dataset_path}):\n${columnInfo}`
					}
				}
			} catch {
				/* context isn't JSON — use as-is */
			}
			prompt = `${objective}\n\nContext: ${enrichedContext}`
		}

		// Generate a task_id for tracking
		const taskId = `${specialist}_${Date.now()}`

		// Record in specialist history
		config.taskState.specialistHistory.push({
			task_id: taskId,
			specialist,
			objective,
			startedAt: Date.now(),
		})

		// Build and execute the command
		const escapedPrompt = prompt.replace(/'/g, "'\\''")
		// Pass the extension's globalStorage path to CLI children so they find
		// cline_mcp_settings.json and can connect to the MCP server.
		const clineDataDir = HostProvider.get().globalStorageFsPath

		// Pass the parent's model and provider to the child so it uses the same
		// model the user selected, instead of falling back to the default.
		const modelId = config.api.getModel().id
		const provider = config.services.stateManager.getGlobalSettingsKey("actModeApiProvider") || ""
		const modelEnv = `CLINE_PARENT_MODEL_ID=${modelId} CLINE_PARENT_PROVIDER=${provider}`

		// Extension secrets live in VS Code SecretStorage, which the child
		// process cannot read — mirror the active provider's key(s) into the
		// CLI's secrets.json. Never pass keys via the command string: it is
		// logged and rendered in the chat transcript.
		this.mirrorProviderSecretsForCli(clineDataDir, config)

		const command = `CLINE_SPECIALIST=${specialist} CLINE_DATA_DIR=${clineDataDir} ${modelEnv} cline '${escapedPrompt}' --json -y`

		Logger.log(`[Specialist] dispatch_specialist("${specialist}") — spawning child. Task: ${taskId}`)
		Logger.log(`[Specialist] CLINE_DATA_DIR=${clineDataDir}`)
		Logger.log(`[Specialist] Command: ${command.substring(0, 300)}...`)

		// Open a training-data session so the MCP middleware can record the child's tool calls.
		// trainingSessionId is null if capture is disabled, the server is unreachable, or the
		// response shape is unexpected — every later reference is guarded.
		const startResp = await this.callTrainingTool(config, "start_training_session", {
			question: objective,
			specialist_type: specialist,
		})
		const trainingSessionId: string | null =
			typeof startResp?.session_id === "string" ? (startResp.session_id as string) : null
		if (trainingSessionId) {
			Logger.log(`[Specialist] training: started ${trainingSessionId} for task ${taskId}`)
		}

		const startTime = Date.now()
		const truncatedObjective = objective.length > 200 ? objective.substring(0, 200) + "..." : objective

		// Emit "running" status to chat UI before the blocking executeCommandTool call
		await this.emitDispatchStatus(config, {
			specialist,
			taskId,
			objective: truncatedObjective,
			status: "running",
		})

		let tokenUsage = { tokensIn: 0, tokensOut: 0, cacheWrites: 0, cacheReads: 0, cost: 0 }

		try {
			const [success, output, rawOutputLines, completed] = await config.callbacks.executeCommandTool(
				command,
				SPECIALIST_TIMEOUT_SECONDS,
			)

			// Reset HTTP client after long-running specialist dispatch to prevent
			// UND_ERR_SOCKET errors when the orchestrator resumes streaming
			config.api.resetClient?.()

			// Use raw output lines (pre-filter) for token extraction when available;
			// the processed `output` has been through filterSubagentOutput() which
			// strips the api_req_started JSON lines we need.
			tokenUsage = this.extractTokenUsage(rawOutputLines ?? output)
			const toolCalls = this.extractToolCalls(rawOutputLines ?? output)

			Logger.log(
				`[Specialist] Specialist "${specialist}" used tools: ${toolCalls.length > 0 ? toolCalls.join(", ") : "none"}`,
			)
			Logger.log(
				`[Specialist] Token usage for "${specialist}" (${taskId}): ` +
					`in=${tokenUsage.tokensIn}, out=${tokenUsage.tokensOut}, ` +
					`cacheW=${tokenUsage.cacheWrites}, cacheR=${tokenUsage.cacheReads}, ` +
					`cost=$${tokenUsage.cost.toFixed(4)}`,
			)

			const outputStr = typeof output === "string" ? output : JSON.stringify(output)

			// V-7: Detect timeout — use the `completed` flag from CommandOrchestrator.
			// `completed === false` means the orchestrator's timeout fired and killed the process.
			// Previously we matched `outputStr.includes("Command timed out")` which caused
			// false positives when the child process's *internal* command timeout text appeared
			// in the output even though the child exited normally (completed === true).
			if (completed === false) {
				const timeoutResult: SpecialistResult = {
					task_id: taskId,
					type: "completion",
					status: "error",
					results: {},
					errors: [
						`TIMEOUT: Specialist "${specialist}" exceeded ${SPECIALIST_TIMEOUT_SECONDS}s limit. Consider breaking the objective into smaller tasks.`,
					],
				}

				const historyEntry = config.taskState.specialistHistory.find((h) => h.task_id === taskId)
				if (historyEntry) {
					historyEntry.result = timeoutResult
					historyEntry.completedAt = Date.now()
				}

				if (trainingSessionId) {
					await this.callTrainingTool(config, "end_training_session", {
						session_id: trainingSessionId,
						save: false,
					})
				}

				await this.updateDispatchStatus(config, taskId, {
					specialist,
					taskId,
					objective: truncatedObjective,
					status: "timeout",
					durationMs: Date.now() - startTime,
					errorSummary: timeoutResult.errors?.[0],
					...tokenUsage,
					toolCalls,
				})

				Logger.log(`[Specialist] dispatch_specialist("${specialist}") — TIMEOUT. Task: ${taskId}`)
				return formatResponse.toolError(JSON.stringify(timeoutResult, null, 2))
			}

			// Try to parse the specialist's JSON result from the output
			const parsedResult = this.parseSpecialistOutput(output, taskId, specialist)

			// Truncate oversized results to prevent context window bloat
			const finalResult = isCapabilityGap(parsedResult)
				? parsedResult
				: this.truncateResult(parsedResult as SpecialistResult, taskId)

			// Update specialist history with result (store truncated version)
			const historyEntry = config.taskState.specialistHistory.find((h) => h.task_id === taskId)
			if (historyEntry) {
				historyEntry.result = finalResult
				historyEntry.completedAt = Date.now()
			} else {
				Logger.log(`[Specialist] WARNING: history entry for task_id=${taskId} not found — result not tracked`)
			}

			// Close the training session. On success → save:true (writes JSONL + runs hypothesis
			// generation/evaluation). On error/capability-gap → save:false (cleanup only, drops
			// the session without polluting the corpus).
			if (trainingSessionId) {
				const succeeded =
					!isCapabilityGap(finalResult) && finalResult.type === "completion" && finalResult.status === "success"
				if (succeeded) {
					await this.callTrainingTool(config, "generate_hypotheses", { session_id: trainingSessionId })
					await this.callTrainingTool(config, "evaluate_hypotheses", { session_id: trainingSessionId })
					await this.callTrainingTool(config, "end_training_session", {
						session_id: trainingSessionId,
						save: true,
					})
				} else {
					await this.callTrainingTool(config, "end_training_session", {
						session_id: trainingSessionId,
						save: false,
					})
				}
			}

			const resultStatus = "status" in finalResult ? finalResult.status : "n/a"

			Logger.log(
				`[Specialist] dispatch_specialist("${specialist}") — child completed. Task: ${taskId}, Type: ${finalResult.type}, Status: ${resultStatus}`,
			)

			await this.updateDispatchStatus(config, taskId, {
				specialist,
				taskId,
				objective: truncatedObjective,
				status: resultStatus === "error" ? "error" : "completed",
				durationMs: Date.now() - startTime,
				errorSummary: resultStatus === "error" && "errors" in finalResult ? finalResult.errors?.[0] : undefined,
				...tokenUsage,
				toolCalls,
			})

			// V-1: Use toolError for error results so orchestrator gets structural signal
			if (!isCapabilityGap(finalResult) && finalResult.status === "error") {
				return formatResponse.toolError(JSON.stringify(finalResult, null, 2))
			}

			return formatResponse.toolResult(JSON.stringify(finalResult, null, 2))
		} catch (error) {
			// Reset HTTP client even on failure to prevent stale socket errors
			config.api.resetClient?.()

			Logger.log(
				`[Specialist] dispatch_specialist("${specialist}") — child FAILED. Task: ${taskId}, Error: ${error instanceof Error ? error.message : String(error)}`,
			)
			const errorResult: SpecialistResult = {
				task_id: taskId,
				type: "completion",
				status: "error",
				results: {},
				errors: [`Specialist ${specialist} failed: ${error instanceof Error ? error.message : String(error)}`],
			}

			// Update history
			const historyEntry = config.taskState.specialistHistory.find((h) => h.task_id === taskId)
			if (historyEntry) {
				historyEntry.result = errorResult
				historyEntry.completedAt = Date.now()
			} else {
				Logger.log(`[Specialist] WARNING: history entry for task_id=${taskId} not found — error result not tracked`)
			}

			if (trainingSessionId) {
				await this.callTrainingTool(config, "end_training_session", {
					session_id: trainingSessionId,
					save: false,
				})
			}

			await this.updateDispatchStatus(config, taskId, {
				specialist,
				taskId,
				objective: truncatedObjective,
				status: "error",
				durationMs: Date.now() - startTime,
				errorSummary: errorResult.errors?.[0],
				...tokenUsage,
			})

			// V-4: Use toolError (not toolResult) for catch-block errors
			return formatResponse.toolError(JSON.stringify(errorResult, null, 2))
		}
	}

	/**
	 * Scan JSON-line output for api_req_started messages and sum token usage fields.
	 * Only the updated api_req_started emissions (after streaming completes) contain
	 * tokensIn/tokensOut/cost — initial emissions have only {request: "..."}.
	 */
	private extractTokenUsage(output: unknown): {
		tokensIn: number
		tokensOut: number
		cacheWrites: number
		cacheReads: number
		cost: number
	} {
		const totals = { tokensIn: 0, tokensOut: 0, cacheWrites: 0, cacheReads: 0, cost: 0 }
		// Support string[], string, or other types (e.g., ClineToolResponseContent)
		const lines = Array.isArray(output)
			? (output as string[])
			: (typeof output === "string" ? output : JSON.stringify(output)).split("\n")
		for (const rawLine of lines) {
			const line = rawLine.trim()
			if (!line || !line.startsWith("{")) continue
			try {
				const msg = JSON.parse(line)
				if (msg?.say !== "api_req_started" || typeof msg.text !== "string") continue
				const info = JSON.parse(msg.text)
				if (typeof info.tokensIn === "number") totals.tokensIn += info.tokensIn
				if (typeof info.tokensOut === "number") totals.tokensOut += info.tokensOut
				if (typeof info.cacheWrites === "number") totals.cacheWrites += info.cacheWrites
				if (typeof info.cacheReads === "number") totals.cacheReads += info.cacheReads
				if (typeof info.cost === "number") totals.cost += info.cost
			} catch {
				/* skip non-JSON lines */
			}
		}
		return totals
	}

	/**
	 * Scan JSON-line output for tool messages and extract the tool names.
	 * Tracks both native Cline tools (say/ask: "tool") and MCP tools (say/ask: "use_mcp_server").
	 */
	private extractToolCalls(output: unknown): string[] {
		const toolNames: string[] = []
		const lines = Array.isArray(output)
			? (output as string[])
			: (typeof output === "string" ? output : JSON.stringify(output)).split("\n")

		for (const rawLine of lines) {
			const line = rawLine.trim()
			if (!line || !line.startsWith("{")) continue
			try {
				const msg = JSON.parse(line)
				if (typeof msg.text !== "string") continue

				// Native Cline tools: say/ask "tool" — text is JSON with { tool: "readFile", ... }
				if (msg.say === "tool" || msg.ask === "tool") {
					try {
						const toolInfo = JSON.parse(msg.text)
						if (toolInfo.tool) {
							toolNames.push(toolInfo.tool)
						}
					} catch {
						// text isn't JSON, skip
					}
				}

				// MCP tools: say/ask "use_mcp_server" — text is JSON with { serverName, toolName, ... }
				if (msg.say === "use_mcp_server" || msg.ask === "use_mcp_server") {
					try {
						const mcpInfo = JSON.parse(msg.text)
						if (mcpInfo.serverName && mcpInfo.toolName) {
							toolNames.push(`${mcpInfo.serverName}:${mcpInfo.toolName}`)
						} else if (mcpInfo.toolName) {
							toolNames.push(mcpInfo.toolName)
						}
					} catch {
						// text isn't JSON, skip
					}
				}

				// Command execution: say/ask "command" — text is JSON with { command: "..." }
				if (msg.say === "command" || msg.ask === "command") {
					toolNames.push("execute_command")
				}
			} catch {
				/* skip non-JSON lines */
			}
		}
		return [...new Set(toolNames)] // unique names
	}

	/**
	 * Emit a specialist_dispatch status message to the chat UI.
	 */
	private async emitDispatchStatus(config: TaskConfig, payload: ClineSaySpecialistDispatch): Promise<void> {
		try {
			await config.callbacks.say("specialist_dispatch", JSON.stringify(payload))
		} catch {
			// Non-critical — don't fail the dispatch if UI message fails
		}
	}

	/**
	 * Update an existing specialist_dispatch message in the chat UI by taskId.
	 */
	private async updateDispatchStatus(config: TaskConfig, taskId: string, payload: ClineSaySpecialistDispatch): Promise<void> {
		try {
			const messages = config.messageState.getClineMessages()
			const index = findLastIndex(messages, (m) => m.say === "specialist_dispatch" && !!m.text?.includes(taskId))
			if (index !== -1) {
				await config.messageState.updateClineMessage(index, {
					text: JSON.stringify(payload),
				})
			}
		} catch {
			// Non-critical — don't fail the dispatch if UI update fails
		}
	}

	/**
	 * Parse specialist output from CLI --json mode or raw stdout.
	 *
	 * Strategy 1: Parse JSON lines from --json mode, find the completion_result
	 *   ClineMessage, extract its `text` field (the specialist's actual output).
	 * Strategy 2: Legacy regex fallback for non-JSON output modes.
	 * Last resort: Return error with tail-truncated raw output.
	 */
	private parseSpecialistOutput(output: unknown, taskId: string, specialist: string): SpecialistResult | CapabilityGapResult {
		const outputStr = typeof output === "string" ? output : JSON.stringify(output)

		// Diagnostic: detect truncation markers from CommandOrchestrator or processOutput
		const wasTruncatedByFile = outputStr.includes("lines written to")
		const wasTruncatedByProcess = outputStr.includes("(output truncated)")
		if (wasTruncatedByFile || wasTruncatedByProcess) {
			Logger.log(
				`[Specialist] parseSpecialistOutput("${specialist}") — WARNING: output was truncated` +
					`${wasTruncatedByFile ? " (file-based logging)" : ""}${wasTruncatedByProcess ? " (processOutput)" : ""}`,
			)
		}

		// Diagnostic: output characteristics
		const totalChars = outputStr.length
		const lines = outputStr.split("\n")
		const totalLines = lines.length
		Logger.log(
			`[Specialist] parseSpecialistOutput("${specialist}") — output stats: totalChars=${totalChars}, totalLines=${totalLines}`,
		)

		// Strategy 1: Parse JSON-lines output from --json mode.
		// Each line is JSON.stringify(ClineMessage). The specialist's result
		// lives in the `text` field of the completion_result message.
		const completionText = this.extractCompletionText(outputStr)
		if (completionText !== null) {
			// Diagnostic: warn if completion_result text is suspiciously short
			if (completionText.length < 100) {
				Logger.log(
					`[Specialist] parseSpecialistOutput("${specialist}") — WARNING: completion_result text is only ${completionText.length} chars (expected >100 for analysis)`,
				)
			}

			// Try to parse text as structured SpecialistResult JSON
			try {
				const result = JSON.parse(completionText)
				if (isSpecialistResult(result) || isCapabilityGap(result)) {
					Logger.log(
						`[Specialist] parseSpecialistOutput("${specialist}") — strategy=completion_result (structured JSON)`,
					)
					return { ...result, task_id: taskId }
				}
			} catch {
				// text is not JSON — that's fine, specialist wrote natural language
			}

			// Try regex extraction on the unescaped text (specialist may have embedded JSON in prose)
			const extracted = this.extractJsonFromText(completionText)
			if (extracted && (isSpecialistResult(extracted) || isCapabilityGap(extracted))) {
				Logger.log(
					`[Specialist] parseSpecialistOutput("${specialist}") — strategy=completion_result (regex-extracted JSON)`,
				)
				return { ...extracted, task_id: taskId }
			}

			// completion_result found but no structured JSON — return as successful raw result
			Logger.log(
				`[Specialist] parseSpecialistOutput("${specialist}") — strategy=completion_result (raw text, ${completionText.length} chars)`,
			)
			return {
				task_id: taskId,
				type: "completion",
				status: "success",
				results: { raw_output: completionText },
			}
		}

		// Strategy 2: Legacy regex fallback for non-JSON output modes
		const jsonMatches = outputStr.match(/\{[^{}]*(?:\{[^{}]*\}[^{}]*)*"task_id"[^{}]*(?:\{[^{}]*\}[^{}]*)*\}/g)
		if (jsonMatches) {
			for (let i = jsonMatches.length - 1; i >= 0; i--) {
				try {
					const parsed = JSON.parse(jsonMatches[i])
					if (isSpecialistResult(parsed) || isCapabilityGap(parsed)) {
						Logger.log(`[Specialist] parseSpecialistOutput("${specialist}") — strategy=regex_fallback`)
						return { ...parsed, task_id: taskId }
					}
				} catch {}
			}
		}

		// Last resort: no completion_result found at all.
		// Try to extract readable content from the specialist's JSON-line conversation messages
		// (say:text, say:error, error) so the orchestrator gets actionable context instead of raw escaped JSON.
		const readableContent = this.extractReadableContent(lines)
		if (readableContent) {
			Logger.log(
				`[Specialist] parseSpecialistOutput("${specialist}") — strategy=last_resort_readable (extracted ${readableContent.length} chars from conversation messages)`,
			)
			return {
				task_id: taskId,
				type: "completion",
				status: "error",
				results: { raw_output: readableContent },
				errors: [`Specialist "${specialist}" did not complete. Partial conversation output extracted.`],
			}
		}

		Logger.log(
			`[Specialist] parseSpecialistOutput("${specialist}") — strategy=last_resort (no completion_result or task_id JSON found, ${outputStr.length} chars)`,
		)
		const truncatedOutput = outputStr.length > 2000 ? outputStr.slice(-2000) : outputStr
		return {
			task_id: taskId,
			type: "completion",
			status: "error",
			results: { raw_output: truncatedOutput },
			errors: [`Specialist "${specialist}" output contained no completion_result message.`],
		}
	}

	/**
	 * Extract the text from the last completion_result ClineMessage in JSON-lines output.
	 *
	 * Primary strategy: line-by-line JSON parsing (fast path — works when each JSON message
	 * is on a single line, which is the common case).
	 *
	 * Fallback strategy: cross-line reconstruction. If the completion_result JSON message was
	 * split across multiple lines (e.g., due to terminal buffer chunking with very long output),
	 * find the "completion_result" marker in the raw string, extract the enclosing JSON object
	 * by brace-matching, and parse it.
	 */
	private extractCompletionText(outputStr: string): string | null {
		// Primary: line-by-line JSON parsing (fast path)
		const lines = outputStr.split("\n")
		// Scan backwards — last completion_result is the final answer
		for (let i = lines.length - 1; i >= 0; i--) {
			const line = lines[i].trim()
			if (!line || !line.startsWith("{")) continue
			try {
				const msg = JSON.parse(line)
				if (msg && (msg.say === "completion_result" || msg.ask === "completion_result") && typeof msg.text === "string") {
					return msg.text
				}
			} catch {
				// Not valid JSON — skip
			}
		}

		// Fallback: completion_result might be split across lines.
		// Search for the marker in raw output and reconstruct the enclosing JSON object.
		const result = this.extractCompletionTextCrossLine(outputStr)
		if (result !== null) {
			Logger.log(`[Specialist] extractCompletionText — used cross-line fallback`)
		}
		return result
	}

	/**
	 * Cross-line fallback for extractCompletionText.
	 * Finds "completion_result" in the raw output, scans for the enclosing JSON object
	 * by brace-matching, then parses and extracts the .text field.
	 */
	private extractCompletionTextCrossLine(outputStr: string): string | null {
		// Search backwards for the last occurrence of the marker
		const marker = '"completion_result"'
		let searchFrom = outputStr.length
		while (searchFrom > 0) {
			const idx = outputStr.lastIndexOf(marker, searchFrom - 1)
			if (idx === -1) return null

			// Scan backward from the marker to find the opening '{' of the enclosing JSON object
			let braceDepth = 0
			let objectStart = -1
			for (let i = idx - 1; i >= 0; i--) {
				const ch = outputStr[i]
				if (ch === "}") {
					braceDepth++
				} else if (ch === "{") {
					if (braceDepth === 0) {
						objectStart = i
						break
					}
					braceDepth--
				}
			}
			if (objectStart === -1) {
				searchFrom = idx
				continue
			}

			// Scan forward from objectStart to find the matching closing '}'
			braceDepth = 0
			let objectEnd = -1
			let inString = false
			let escaped = false
			for (let i = objectStart; i < outputStr.length; i++) {
				const ch = outputStr[i]
				if (escaped) {
					escaped = false
					continue
				}
				if (ch === "\\") {
					if (inString) escaped = true
					continue
				}
				if (ch === '"') {
					inString = !inString
					continue
				}
				if (inString) continue
				if (ch === "{") {
					braceDepth++
				} else if (ch === "}") {
					braceDepth--
					if (braceDepth === 0) {
						objectEnd = i
						break
					}
				}
			}
			if (objectEnd === -1) {
				searchFrom = idx
				continue
			}

			const candidate = outputStr.substring(objectStart, objectEnd + 1)
			try {
				const msg = JSON.parse(candidate)
				if (msg && (msg.say === "completion_result" || msg.ask === "completion_result") && typeof msg.text === "string") {
					return msg.text
				}
			} catch {
				// Brace-matching produced invalid JSON — try earlier occurrence
			}
			searchFrom = idx
		}
		return null
	}

	/**
	 * Extract readable text from the specialist's JSON-line conversation messages.
	 * When a specialist crashes without producing a completion_result, this method
	 * parses the JSON-line output for say:text, say:error, and error messages,
	 * producing a human-readable summary the orchestrator can act on.
	 *
	 * Returns null if no readable content was extracted.
	 */
	private extractReadableContent(lines: string[]): string | null {
		const textParts: string[] = []
		const errors: string[] = []

		for (const rawLine of lines) {
			const line = rawLine.trim()
			if (!line || !line.startsWith("{")) continue
			try {
				const msg = JSON.parse(line)
				if (!msg) continue

				if (msg.say === "text" && typeof msg.text === "string" && msg.text.length > 0) {
					textParts.push(msg.text)
				} else if (msg.say === "error" && typeof msg.text === "string") {
					errors.push(msg.text)
				} else if (msg.type === "error" && typeof msg.message === "string") {
					errors.push(msg.message)
				}
			} catch {
				// Not valid JSON — skip
			}
		}

		if (textParts.length === 0 && errors.length === 0) return null

		const parts: string[] = []
		if (textParts.length > 0) {
			parts.push("Specialist output:\n" + textParts.join("\n"))
		}
		if (errors.length > 0) {
			parts.push("Errors encountered:\n" + errors.join("\n"))
		}
		const result = parts.join("\n\n")

		// Cap at 4000 chars to avoid bloating the tool result
		return result.length > 4000 ? result.slice(0, 4000) + "\n... (truncated)" : result
	}

	/**
	 * Try to extract a JSON object containing "task_id" from free-form text.
	 */
	private extractJsonFromText(text: string): Record<string, unknown> | null {
		const jsonMatches = text.match(/\{[^{}]*(?:\{[^{}]*\}[^{}]*)*"task_id"[^{}]*(?:\{[^{}]*\}[^{}]*)*\}/g)
		if (!jsonMatches) return null
		for (let i = jsonMatches.length - 1; i >= 0; i--) {
			try {
				return JSON.parse(jsonMatches[i])
			} catch {}
		}
		return null
	}

	/**
	 * Truncate oversized specialist results to prevent context window bloat.
	 *
	 * Preserves top-level SpecialistResult fields (task_id, type, status,
	 * hypothesis_evidence, recommendations, errors). Only the "results" field
	 * is subject to truncation.
	 *
	 * When truncation occurs, the full untruncated result is saved to a temp
	 * file and the path is referenced in the truncated output.
	 */
	private static readonly MAX_RESULT_CHARS = 8000 // ~2k tokens

	private truncateResult(result: SpecialistResult, taskId: string): SpecialistResult {
		const serialized = JSON.stringify(result.results)
		if (serialized.length <= DispatchSpecialistHandler.MAX_RESULT_CHARS) {
			return result
		}

		// Save full result to file for recoverability
		const fullResultPath = path.join(os.tmpdir(), `specialist_${taskId}_full_result.json`)
		try {
			fs.writeFileSync(fullResultPath, JSON.stringify(result, null, 2))
		} catch (err) {
			Logger.log(`[Specialist] WARNING: Failed to save full result to ${fullResultPath}: ${err}`)
		}

		Logger.log(
			`[Specialist] Result truncated: ${serialized.length} -> ${DispatchSpecialistHandler.MAX_RESULT_CHARS} chars. Full result saved to ${fullResultPath}`,
		)

		// Preserve structure, truncate the big "results" field
		const truncatedResults: Record<string, unknown> = {
			_truncation_notice: `Full result (${serialized.length} chars) saved to: ${fullResultPath}`,
		}
		let currentSize = 100 // account for notice

		for (const [key, value] of Object.entries(result.results)) {
			const entryStr = JSON.stringify(value)
			if (currentSize + entryStr.length > DispatchSpecialistHandler.MAX_RESULT_CHARS) {
				truncatedResults[key] = `(truncated — ${entryStr.length} chars)`
				continue
			}
			truncatedResults[key] = value
			currentSize += entryStr.length
		}

		return {
			...result,
			results: truncatedResults,
		}
	}

	/**
	 * Read CSV header row from a dataset file and return column names.
	 * Resolves path relative to workspace root (config.cwd).
	 * Returns null on any error (file not found, not CSV, binary, etc.).
	 *
	 * Security: validates path is within workspace root (invariant L3-6).
	 */
	private readCsvHeaders(datasetPath: string, config: TaskConfig): string | null {
		try {
			const resolved = path.resolve(config.cwd, datasetPath)
			// Security: ensure resolved path is within workspace root
			if (!resolved.startsWith(config.cwd + path.sep) && resolved !== config.cwd) {
				Logger.log(`[Specialist] readCsvHeaders — path traversal blocked: ${datasetPath}`)
				return null
			}

			// Read only the first 4KB to get header row
			const fd = fs.openSync(resolved, "r")
			const buffer = Buffer.alloc(4096)
			const bytesRead = fs.readSync(fd, buffer, 0, 4096, 0)
			fs.closeSync(fd)

			if (bytesRead === 0) return null

			const content = buffer.toString("utf-8", 0, bytesRead)

			// Check for binary content (NUL bytes)
			if (content.includes("\0")) return null

			const lines = content.split("\n")
			if (lines.length === 0 || !lines[0].trim()) return null

			const headerLine = lines[0].trim()
			// Detect delimiter (comma, tab, semicolon)
			let delimiter = ","
			if (headerLine.includes("\t") && !headerLine.includes(",")) delimiter = "\t"
			else if (headerLine.includes(";") && !headerLine.includes(",")) delimiter = ";"

			const columns = headerLine.split(delimiter).map((c) => c.trim().replace(/^["']|["']$/g, ""))
			if (columns.length === 0 || (columns.length === 1 && columns[0] === "")) return null

			const result = `Columns (${columns.length}): ${columns.join(", ")}`

			// If we have a second line, report a sample row count estimate
			if (lines.length > 1 && lines[1].trim()) {
				// Quick row estimate: count newlines in a larger sample
				try {
					const stats = fs.statSync(resolved)
					const avgLineBytes = content.length / lines.length
					const estimatedRows = Math.round(stats.size / avgLineBytes) - 1 // subtract header
					return `${result}\nEstimated rows: ~${estimatedRows.toLocaleString()}`
				} catch {
					return result
				}
			}

			return result
		} catch (err) {
			Logger.log(`[Specialist] readCsvHeaders — error reading ${datasetPath}: ${err}`)
			return null
		}
	}
}
