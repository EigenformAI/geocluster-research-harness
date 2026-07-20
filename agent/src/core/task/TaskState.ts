import { Anthropic } from "@anthropic-ai/sdk"
import { AssistantMessageContent } from "@core/assistant-message"
import type { CapabilityGapResult, HypothesisEntry, SpecialistResult } from "@shared/specialists"
import { SpecialistType } from "@shared/specialists"
import { ClineAskResponse } from "@shared/WebviewMessage"
import type { HookExecution } from "./types/HookExecution"

export class TaskState {
	// Streaming flags
	isStreaming = false
	isWaitingForFirstChunk = false
	didCompleteReadingStream = false

	// Content processing
	currentStreamingContentIndex = 0
	assistantMessageContent: AssistantMessageContent[] = []
	userMessageContent: (Anthropic.TextBlockParam | Anthropic.ImageBlockParam | Anthropic.ToolResultBlockParam)[] = []
	userMessageContentReady = false
	// Map of tool names to their tool_use_id for creating proper ToolResultBlockParam
	toolUseIdMap: Map<string, string> = new Map()

	// Presentation locks
	presentAssistantMessageLocked = false
	presentAssistantMessageHasPendingUpdates = false

	// Ask/Response handling
	askResponse?: ClineAskResponse
	askResponseText?: string
	askResponseImages?: string[]
	askResponseFiles?: string[]
	lastMessageTs?: number

	// Plan mode specific state
	isAwaitingPlanResponse = false
	didRespondToPlanAskBySwitchingMode = false

	// Context and history
	conversationHistoryDeletedRange?: [number, number]

	// Tool execution flags
	didRejectTool = false
	didAlreadyUseTool = false
	didEditFile: boolean = false
	lastToolName: string = "" // Track last tool used for consecutive call detection

	// Absolute paths of files SUCCESSFULLY read via read_file this task. Used by the
	// Report Analysis (report-eval) citation guard to reject answers that cite files
	// the agent never actually read (anti-fabrication seatbelt).
	readFilePaths: Set<string> = new Set<string>()

	// Error tracking
	consecutiveMistakeCount: number = 0
	didAutomaticallyRetryFailedApiRequest = false
	checkpointManagerErrorMessage?: string

	// Retry tracking for auto-retry feature
	autoRetryAttempts: number = 0

	// Task Initialization
	isInitialized = false

	// Focus Chain / Todo List Management
	apiRequestCount: number = 0
	apiRequestsSinceLastTodoUpdate: number = 0
	currentFocusChainChecklist: string | null = null
	todoListWasUpdatedByUser: boolean = false

	// Task Abort / Cancellation
	abort: boolean = false
	didFinishAbortingStream = false
	abandoned = false

	// Hook execution tracking for cancellation
	activeHookExecution?: HookExecution

	// Auto-context summarization
	currentlySummarizing: boolean = false
	lastAutoCompactTriggerIndex?: number

	// Specialist system
	activeSpecialist: SpecialistType | null = null
	hypotheses: HypothesisEntry[] = []
	/** Set by RequestCapabilityHandler; cleared by AttemptCompletionHandler when specialist relays the gap. */
	capabilityGapPending: CapabilityGapResult | null = null
	specialistHistory: Array<{
		task_id: string
		specialist: string
		objective: string
		result?: SpecialistResult | CapabilityGapResult
		startedAt: number
		completedAt?: number
	}> = []
}
