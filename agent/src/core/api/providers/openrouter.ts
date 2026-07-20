import { setTimeout as setTimeoutPromise } from "node:timers/promises"
import { StateManager } from "@core/storage/StateManager"
import { ModelInfo, openRouterDefaultModelId, openRouterDefaultModelInfo } from "@shared/api"
import { shouldSkipReasoningForModel } from "@utils/model-utils"
import axios from "axios"
import OpenAI from "openai"
import type { ChatCompletionTool as OpenAITool } from "openai/resources/chat/completions"
import { ClineStorageMessage } from "@/shared/messages/content"
import { createOpenAIClient, getAxiosSettings } from "@/shared/net"
import { Logger } from "@/shared/services/Logger"
import { ApiHandler, CommonApiHandlerOptions } from "../"
import { withRetry } from "../retry"
import { createOpenRouterStream } from "../transform/openrouter-stream"
import { ApiStream, ApiStreamUsageChunk } from "../transform/stream"
import { ToolCallProcessor } from "../transform/tool-call-processor"
import { OpenRouterErrorResponse } from "./types"

interface OpenRouterHandlerOptions extends CommonApiHandlerOptions {
	openRouterApiKey?: string
	openRouterModelId?: string
	openRouterModelInfo?: ModelInfo
	openRouterProviderSorting?: string
	reasoningEffort?: string
	thinkingBudgetTokens?: number
	geminiThinkingLevel?: string
}

export class OpenRouterHandler implements ApiHandler {
	private options: OpenRouterHandlerOptions
	private client: OpenAI | undefined
	lastGenerationId?: string

	constructor(options: OpenRouterHandlerOptions) {
		this.options = options
	}

	/**
	 * Reset the HTTP client to force a fresh connection on the next request.
	 * Prevents UND_ERR_SOCKET errors after long-running child processes
	 * (specialist dispatch) where the socket may have been terminated.
	 */
	resetClient(): void {
		this.client = undefined
	}

	private ensureClient(): OpenAI {
		if (!this.client) {
			if (!this.options.openRouterApiKey) {
				throw new Error("OpenRouter API key is required")
			}
			try {
				this.client = createOpenAIClient({
					baseURL: "https://openrouter.ai/api/v1",
					apiKey: this.options.openRouterApiKey,
				})
			} catch (error: any) {
				throw new Error(`Error creating OpenRouter client: ${error.message}`)
			}
		}
		return this.client
	}

	@withRetry()
	async *createMessage(systemPrompt: string, messages: ClineStorageMessage[], tools?: OpenAITool[]): ApiStream {
		const client = this.ensureClient()
		this.lastGenerationId = undefined

		let stream
		try {
			stream = await createOpenRouterStream(
				client,
				systemPrompt,
				messages,
				this.getModel(),
				this.options.reasoningEffort,
				this.options.thinkingBudgetTokens,
				this.options.openRouterProviderSorting,
				tools,
				this.options.geminiThinkingLevel,
			)
		} catch (error: any) {
			// OpenAI SDK throws raw HTTP errors — convert to user-friendly messages
			const status = error?.status || error?.statusCode
			const friendlyMessages: Record<number, string> = {
				401: "API key is invalid or expired. Please check your OpenRouter API key.",
				402: "Insufficient credits. Please top up your OpenRouter account.",
				403: "Insufficient credits. Please top up your OpenRouter account.",
				408: "Request timed out. Please try again.",
				429: "Too many requests. Please wait a moment and try again.",
				502: "AI service is temporarily unavailable. Please try again later.",
				503: "AI service is under maintenance. Please try again later.",
			}
			if (status && friendlyMessages[status]) {
				throw new Error(friendlyMessages[status])
			}
			throw error
		}

		let didOutputUsage: boolean = false
		const toolCallProcessor = new ToolCallProcessor()

		// OpenRouter-specific error codes for credits/quota exhaustion
		const openRouterQuotaCodes = new Set([17000, 1600])
		// HTTP status codes that indicate quota/billing/rate-limit issues
		const httpQuotaCodes = new Set([402, 403, 429])

		for await (const chunk of stream) {
			// openrouter returns an error object instead of the openai sdk throwing an error
			// Check for error field directly on chunk
			if ("error" in chunk) {
				const error = chunk.error as OpenRouterErrorResponse["error"]
				Logger.error(`OpenRouter API Error: ${error?.code} - ${error?.message}`)
				if (openRouterQuotaCodes.has(error?.code) || httpQuotaCodes.has(error?.code)) {
					// Use the upstream message if available
					throw new Error(error?.message || "The AI model quota has been reached. Please wait and try again.")
				}
				// Include metadata in the error message if available
				const metadataStr = error.metadata ? `\nMetadata: ${JSON.stringify(error.metadata, null, 2)}` : ""
				throw new Error(`OpenRouter API Error ${error.code}: ${error.message}${metadataStr}`)
			}

			// Check for error in choices[0].finish_reason
			// OpenRouter may return errors in a non-standard way within choices
			const choice = chunk.choices?.[0]
			// Use type assertion since OpenRouter uses non-standard "error" finish_reason
			if ((choice?.finish_reason as string) === "error") {
				// Use type assertion since OpenRouter adds non-standard error property
				const choiceWithError = choice as any
				if (choiceWithError.error) {
					const error = choiceWithError.error
					Logger.error(
						`OpenRouter Mid-Stream Error: ${error?.code || "Unknown"} - ${error?.message || "Unknown error"}`,
					)
					if (openRouterQuotaCodes.has(error?.code) || httpQuotaCodes.has(error?.code)) {
						throw new Error(error?.message || "The AI model quota has been reached. Please wait and try again.")
					}
					// Format error details
					const errorDetails = typeof error === "object" ? JSON.stringify(error, null, 2) : String(error)
					throw new Error(`OpenRouter Mid-Stream Error: ${errorDetails}`)
				} else {
					// Fallback if error details are not available
					throw new Error(
						`OpenRouter Mid-Stream Error: Stream terminated with error status but no error details provided`,
					)
				}
			}

			if (!this.lastGenerationId && chunk.id) {
				this.lastGenerationId = chunk.id
			}

			const delta = chunk.choices?.[0]?.delta
			if (delta?.content) {
				yield {
					type: "text",
					text: delta.content,
				}
			}

			if (delta?.tool_calls) {
				yield* toolCallProcessor.processToolCallDeltas(delta.tool_calls)
			}

			// Reasoning tokens are returned separately from the content
			// Skip reasoning content for Grok 4 models since it only displays "thinking" without providing useful information
			if (
				delta &&
				"reasoning" in delta &&
				delta.reasoning &&
				!shouldSkipReasoningForModel(this.options.openRouterModelId)
			) {
				yield {
					type: "reasoning",
					reasoning: typeof delta.reasoning === "string" ? delta.reasoning : JSON.stringify(delta.reasoning),
				}
			}

			// OpenRouter passes reasoning details that we can pass back unmodified in api requests to preserve reasoning traces for model
			// See: https://openrouter.ai/docs/use-cases/reasoning-tokens#preserving-reasoning-blocks
			if (
				delta &&
				"reasoning_details" in delta &&
				delta.reasoning_details &&
				// @ts-expect-error-next-line
				delta.reasoning_details.length && // exists and non-0
				!shouldSkipReasoningForModel(this.options.openRouterModelId)
			) {
				yield {
					type: "reasoning",
					reasoning: "",
					details: delta.reasoning_details,
				}
			}

			if (!didOutputUsage && chunk.usage) {
				yield {
					type: "usage",
					cacheWriteTokens: 0,
					cacheReadTokens: chunk.usage.prompt_tokens_details?.cached_tokens || 0,
					inputTokens: (chunk.usage.prompt_tokens || 0) - (chunk.usage.prompt_tokens_details?.cached_tokens || 0),
					outputTokens: chunk.usage.completion_tokens || 0,
					// @ts-expect-error-next-line
					totalCost: (chunk.usage.cost || 0) + (chunk.usage.cost_details?.upstream_inference_cost || 0),
				}
				didOutputUsage = true
			}
		}

		// Fallback to generation endpoint if usage chunk not returned
		if (!didOutputUsage) {
			const apiStreamUsage = await this.getApiStreamUsage()
			if (apiStreamUsage) {
				yield apiStreamUsage
			}
		}
	}

	async getApiStreamUsage(): Promise<ApiStreamUsageChunk | undefined> {
		if (this.lastGenerationId) {
			await setTimeoutPromise(500) // FIXME: necessary delay to ensure generation endpoint is ready
			try {
				const generationIterator = this.fetchGenerationDetails(this.lastGenerationId)
				const generation = (await generationIterator.next()).value
				// Logger.log("OpenRouter generation details:", generation)
				return {
					type: "usage",
					cacheWriteTokens: 0,
					cacheReadTokens: generation?.native_tokens_cached || 0,
					// openrouter generation endpoint fails often
					inputTokens: (generation?.native_tokens_prompt || 0) - (generation?.native_tokens_cached || 0),
					outputTokens: generation?.native_tokens_completion || 0,
					totalCost: generation?.total_cost || 0,
				}
			} catch (error) {
				// ignore if fails
				Logger.error("Error fetching OpenRouter generation details:", error)
			}
		}
		return undefined
	}

	@withRetry({ maxRetries: 4, baseDelay: 250, maxDelay: 1000, retryAllErrors: true })
	async *fetchGenerationDetails(genId: string) {
		// Logger.log("Fetching generation details for:", genId)
		try {
			const response = await axios.get(`https://openrouter.ai/api/v1/generation?id=${genId}`, {
				headers: {
					Authorization: `Bearer ${this.options.openRouterApiKey}`,
				},
				timeout: 15_000, // this request hangs sometimes
				...getAxiosSettings(),
			})
			yield response.data?.data
		} catch (error) {
			// ignore if fails
			Logger.error("Error fetching OpenRouter generation details:", error)
			throw error
		}
	}

	getModel(): { id: string; info: ModelInfo } {
		const modelId = this.options.openRouterModelId || openRouterDefaultModelId
		const cachedModelInfo = StateManager.get().getModelInfo("openRouter", modelId)
		return {
			id: modelId,
			info: cachedModelInfo || openRouterDefaultModelInfo,
		}
	}
}
