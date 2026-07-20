/**
 * Shared types, enums, and interfaces for the specialist multi-agent system.
 *
 * Architecture layers:
 * - Layer 1: User-Facing Agent (geology variant — talks to user)
 * - Layer 2: Analysis Orchestrator (orchestrator variant — routes work)
 * - Layer 3: Specialists (dataops, transform, analytics, geoviz — spawned children)
 * - Layer 4: Extended Capability Agent (extended — installs, web research, custom scripts)
 */

import { ModelFamily } from "./prompts"

// ── Specialist Types ──────────────────────────────────────────────────

export enum SpecialistType {
	ORCHESTRATOR = "orchestrator",
	DATAOPS = "dataops",
	TRANSFORM = "transform",
	ANALYTICS = "analytics",
	GEOVIZ = "geoviz",
	EXTENDED = "extended",
}

/**
 * Maps each specialist type to the ModelFamily used for prompt variant matching.
 */
export const SPECIALIST_TO_MODEL_FAMILY: Record<SpecialistType, ModelFamily> = {
	[SpecialistType.ORCHESTRATOR]: ModelFamily.SPECIALIST_ORCHESTRATOR,
	[SpecialistType.DATAOPS]: ModelFamily.SPECIALIST_DATAOPS,
	[SpecialistType.TRANSFORM]: ModelFamily.SPECIALIST_TRANSFORM,
	[SpecialistType.ANALYTICS]: ModelFamily.SPECIALIST_ANALYTICS,
	[SpecialistType.GEOVIZ]: ModelFamily.SPECIALIST_GEOVIZ,
	[SpecialistType.EXTENDED]: ModelFamily.SPECIALIST_EXTENDED,
}

// ── Type Guards ───────────────────────────────────────────────────────

/**
 * Validates that a string is a known specialist type.
 */
export function isValidSpecialist(value: string): value is SpecialistType {
	return Object.values(SpecialistType).includes(value as SpecialistType)
}

/**
 * Returns true for specialists that are dispatched as child processes (not variant-switched).
 * Orchestrator is activated (variant switch), not dispatched.
 */
export function isDispatchableSpecialist(value: string): boolean {
	return isValidSpecialist(value) && value !== SpecialistType.ORCHESTRATOR
}

// ── Result Interfaces ─────────────────────────────────────────────────

/**
 * Structured result returned by specialists via attempt_completion.
 */
export interface SpecialistResult {
	task_id: string
	type: "completion" | "capability_gap"
	status: "success" | "partial" | "error"
	results: Record<string, unknown>
	hypothesis_evidence?: {
		supports?: string[]
		contradicts?: string[]
		new_hypotheses?: string[]
	}
	recommendations?: string[]
	errors?: string[]
}

/**
 * Returned when a specialist needs a package that isn't installed.
 */
export interface CapabilityGapResult {
	task_id: string
	type: "capability_gap"
	permission_request: {
		package: string
		version?: string
		manager: "pip" | "apt" | "conda"
		reason: string
		fallback?: string
	}
	resume_on_completion: boolean
}

/**
 * Type guard for SpecialistResult.
 */
export function isSpecialistResult(value: unknown): value is SpecialistResult {
	if (!value || typeof value !== "object") return false
	const obj = value as Record<string, unknown>
	return (
		typeof obj.task_id === "string" &&
		(obj.type === "completion" || obj.type === "capability_gap") &&
		typeof obj.status === "string"
	)
}

/**
 * Type guard for CapabilityGapResult.
 */
export function isCapabilityGap(value: unknown): value is CapabilityGapResult {
	if (!value || typeof value !== "object") return false
	const obj = value as Record<string, unknown>
	return obj.type === "capability_gap" && typeof obj.permission_request === "object" && obj.permission_request !== null
}

// ── Hypothesis Tracking ───────────────────────────────────────────────

export interface HypothesisEntry {
	hypothesis_id: string
	claim: string
	evidence_for: string[]
	evidence_against: string[]
	confidence: number
	status: "active" | "testing" | "confirmed" | "refuted" | "revised"
	spawned_tasks: string[]
	parent_hypothesis: string | null
}

// ── MCP Tool Filtering ───────────────────────────────────────────────

/**
 * Controls which MCP servers and tools are visible to a specialist variant.
 */
export interface McpToolFilter {
	allowedServers?: string[]
	blockedServers?: string[]
	allowedToolPatterns?: string[]
	blockedToolPatterns?: string[]
}
