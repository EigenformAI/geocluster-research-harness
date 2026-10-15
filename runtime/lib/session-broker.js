/**
 * SessionBroker — owns the user's conversations and what the browser sees of them (api 3).
 *
 * One `opencode acp` (AgentSupervisor) serves every conversation, and one geocluster MCP
 * (McpSupervisor) serves every tool call. Browser sockets come and go; the broker stays. It:
 *   - creates conversations (engine session/new + set_mode) and binds each one to the engine lazily,
 *     once per engine generation (session/resume): after any engine start every id answers
 *     "session not found" until it is resumed, and resume replays nothing;
 *   - appends every update, specialist (child) frame, prompt, permission and turn end to that
 *     conversation's SessionLog and fans it out to every socket attached to it (with `_meta.seq`);
 *     the log is the only replay source (engine session/load is never used);
 *   - runs the end of a turn: the RE-4 citation check (report-analysis) with one correction prompt
 *     inside the same browser turn, then the report export, then `_gc/turn_end`;
 *   - holds permission requests (several per conversation: specialists ask on their root's id),
 *     re-issues them to sockets that attach, answers them from prefs, the first socket, a cancel or a
 *     timeout;
 *   - survives engine restarts: running turns end `cancelled`/`server_restart`, every conversation
 *     re-binds on its next use.
 *
 * Sockets register as "ports": { attached: Set<sessionId>, sessionUpdate(), requestPermission(),
 * extNotification() } (see acp-bridge.js).
 */
import crypto from "node:crypto"
import { EventEmitter } from "node:events"
import fs from "node:fs/promises"
import path from "node:path"
import { pathToFileURL } from "node:url"
import { RequestError } from "@agentclientprotocol/sdk"
import { AgentSupervisor } from "./agent-supervisor.js"
import { FEATURES } from "./build-info.js"
import { correctionPrompt, findFabricatedCitations } from "./citation-guard.js"
import { McpSupervisor } from "./mcp-supervisor.js"
import { cgroupMemory } from "./memory.js"
import { reapTree } from "./proc-tree.js"
import { ReportExporter } from "./report-export.js"
import { SessionLog } from "./session-log.js"
import { TurnTracker } from "./turn-tracker.js"
import { loadTimeoutPolicy, timeoutPolicy } from "./timeout-policy.js"
import { AccountUsage } from "./account-usage.js"
import { managedDenial, denialFor } from "../../opencode/config/lib/managed-usage.js"

export const ERR_SESSION_BUSY = -32001
export const ERR_NOT_FOUND = -32002
export const ERR_ENGINE_NOT_READY = -32003
export const ERR_CAPACITY = -32005
export const ERR_ARCHIVED = -32006

const AGENT_MODES = ["geology", "standard", "report-analysis"]
/** Config options a browser may change; `mode` is fixed at session/new (api 3). */
const CLIENT_CONFIG_IDS = ["model", "effort"]
const clientConfigOptions = (options) => options?.filter?.((o) => CLIENT_CONFIG_IDS.includes(o?.id)) ?? null
/** The runtime's default effort for options the engine left at "default" (no variant), when their model offers it. */
const defaultEffortFor = (options, want) => {
	const effort = options?.find?.((o) => o?.id === "effort")
	return effort?.currentValue === "default" && want !== "default" && effort.options?.some?.((c) => c?.value === want) ? want : null
}
const TURN_END_GRACE_MS = 8000
/** Frames for an id the broker doesn't know yet (they precede the session/new response). */
const EARLY_MAX_FRAMES = 50
const EARLY_MAX_IDS = 100
const EARLY_TTL_MS = 30000
/** How long a prompt waits for the engine to settle a previous (force-ended) prompt of the same conversation. */
const PREVIOUS_PROMPT_WAIT_MS = 5000
/** At most this many engine restarts to reconnect missing MCP tools per window (a broken MCP must not loop). */
const TOOLS_RESTART_MAX = 3
const TOOLS_RESTART_WINDOW_MS = 10 * 60 * 1000
const SUBMISSIONS_KEPT = 64
const ID_RE = /^[A-Za-z0-9_-]{1,128}$/
const ENGINE_ID_RE = /^ses_[A-Za-z0-9]+$/

function busy(sessionId) {
	return new RequestError(ERR_SESSION_BUSY, "session_busy: this conversation's turn is running; cancel it first", { sessionId })
}

function archivedError(sessionId) {
	return new RequestError(
		ERR_ARCHIVED,
		"archived: this conversation was created with the previous agent engine and is read-only; start a new conversation",
		{ sessionId },
	)
}

/** A conversation of this engine that the engine no longer has (its database was reset). */
function lostError(sessionId) {
	return new RequestError(ERR_ARCHIVED, "archived: the agent engine no longer has this conversation; it is read-only — start a new conversation", { sessionId, lost: true })
}

function notReady(state, message = "engine not ready; retry shortly") {
	return new RequestError(ERR_ENGINE_NOT_READY, message, { state })
}

/** turn_end._meta is the gateway's vocabulary: engine keys (e.g. opencode/retry) never leak into it. */
const TURN_END_META = ["reason", "error", "errorName", "usageDenial", "citationFailed", "processesStopped"]

export function capacityError(message, data = {}) {
	return new RequestError(ERR_CAPACITY, `capacity: ${message}`, data)
}

const errorName = (error) => error?.data?.errorName ?? null
const isSessionNotFound = (error) => error?.code === -32602 && /session not found/i.test(String(error?.message ?? ""))
const isEngineBusy = (error) => /already has an active ACP prompt/i.test(String(error?.message ?? ""))
const cleanMessage = (error) => String(error?.message ?? error ?? "unknown error").replace(/^Internal error:\s*/i, "")
// Awaited on request paths (the cancel reap, the previous-prompt wait), so it keeps the event loop alive:
// an unref'd timer let a shutting-down process exit in the middle of a reap
const delay = (ms) => new Promise((resolve) => setTimeout(resolve, ms))

/** One root conversation as the broker tracks it (children are part of their root's record). */
class Conversation {
	constructor(entry) {
		this.id = String(entry.sessionId)
		this.runDir = entry.runDir ?? null
		this.agentMode = entry.agentMode ?? "geology"
		this.archived = Boolean(entry.archived)
		this.lost = Boolean(entry.lost)
		// idle | running | ending (turn_end being written and sent: still busy, see #endTurn)
		this.turn = "idle"
		this.turnStartedAt = null
		this.submissionId = null
		this.inflight = new Map() // submissionId -> the prompt's result promise, while it is admitted or running (API-07)
		this.admitting = new Set() // {submissionId, cancelled} per prompt still between its checks
		this.retrying = false // the last root session_info_update announced a provider retry (cleared at turn end)
		this.cancelRequested = false
		this.forceEndTurn = null // resolves the running turn's engine wait (cancel watchdog)
		this.cancelTimer = null
		this.enginePrompt = null // settles when the engine's in-flight prompt has answered (even after a forced end)
		this.pending = new Map() // reqId -> permission request (see #onEnginePermission)
		this.boundGen = -1 // engine generation this conversation was created or resumed in
		this.binding = null
		this.bindingGen = -1
		this.configOptions = null
		this.savedModelId = entry.modelId ?? null
		this.unavailableModelId = null
		this.defaultEffortPending = false // a model change succeeded but its automatic effort selection is unfinished
		// last usage_update: {used, size}; seeded from the index so a gateway restart keeps it
		this.usage = Number.isFinite(entry.contextUsed) && Number.isFinite(entry.contextSize) ? { used: entry.contextUsed, size: entry.contextSize } : null
		this.children = new Map() // childSessionId -> {sessionId, parentSessionId, depth, title, status, toolCallId}
		this.subagentCalls = new Map() // `${sessionId}\0${toolCallId}` -> spawning call (child linking)
		this.callOrder = 0
		this.tracker = null // TurnTracker (answer text, read ledger) while a turn runs
	}

	get modelId() {
		return this.configOptions?.find?.((o) => o?.id === "model")?.currentValue ?? null
	}
}

export class SessionBroker extends EventEmitter {
	/**
	 * @param {object} opts {config, prefs, activity, index, logger, memory?, build?, engine?, mcp?, exporter?}
	 * engine/mcp/exporter are injectable for tests; by default the broker creates them.
	 */
	constructor({ config, prefs, activity, index, logger, memory = cgroupMemory, build = null, engine = null, mcp = null, exporter = null }) {
		super()
		this.config = config
		this.accountUsage = new AccountUsage(config, { logger })
		this.build = build
		this.prefs = prefs
		this.activity = activity
		this.index = index
		this.logger = logger
		this.timeoutPolicy = timeoutPolicy(config)
		this.memory = memory
		this.ports = new Set()
		this.convs = new Map()
		this.logs = new Map()
		// In-flight SessionLog.open per session id, so concurrent #logFor calls share one instance
		this.opening = new Map()
		// Evicted logs still flushing: a reopen of the same session waits for them (one writer per file)
		this.closing = new Map()
		this.turnWaiters = new Set()
		this.early = new Map() // sessionId -> {frames, timer}
		this.engineDeletes = new Set() // never-prompted sessions to delete in the engine once it is ready
		this.toolsRestart = { wanted: null, running: false, at: [] }
		this.engineUsers = 0 // session/new and set_config_option calls in progress (a tools restart waits for them)
		this.lastMcpRevive = 0
		this.closed = false

		this.mcp = mcp ?? new McpSupervisor({ config, logger: logger.child("mcp") })
		this.engine = engine ?? new AgentSupervisor({ config, logger: logger.child("engine"), mcpUrl: this.mcp.url })
		this.exporter =
			exporter ??
			new ReportExporter({
				workspaceDir: config.workspaceDir,
				pandocBin: config.pandocBin,
				enabled: config.reportExport,
				timeoutMs: config.reportTimeoutMs,
				logger: logger.child("report"),
			})

		this.engine.on("update", (params) => this.#onEngineUpdate(params))
		this.engine.on("child", (params) => this.#onEngineChild(params))
		this.engine.on("permission", (request) => this.#onEnginePermission(request))
		this.engine.on("cancelRequest", (request) => this.#onEngineCancelRequest(request))
		this.engine.on("exit", (info) => this.#onEngineExit(info))
		this.engine.on("ready", (info) => this.#onEngineReady(info))
		this.engine.on("unavailable", () => this.#broadcastExt(null, "_gc/status", this.status()))
		this.engine.on("tools", (info) => this.#onEngineTools(info))
		this.mcp.on("ready", (info) => this.#onMcpReady(info))
		this.mcp.on("exit", (info) => this.#onMcpExit(info))
		this.mcp.on("unavailable", () =>
			this.#broadcastExt(null, "_gc/notice", {
				sessionId: null,
				level: "warning",
				message: "The data tools (MCP server) keep crashing and were stopped; the agent can still read files. They are tried again with the next message.",
			}),
		)

		activity.onAgeNotice = (sessionId) =>
			this.#broadcastExt(sessionId, "_gc/notice", {
				sessionId,
				level: "warning",
				kind: "turn_age",
				boundary: "machine_activity",
				message: `This turn has run for more than ${config.maxTurnMs / 3600000} h. Activity reporting continues; progress is unknown. Cancel the turn to stop work, or keep waiting.`,
			})
	}

	// ---- ports --------------------------------------------------------------------------------

	addPort(port) {
		this.ports.add(port)
	}

	removePort(port) {
		this.ports.delete(port)
	}

	// ---- lifecycle ------------------------------------------------------------------------------

	/**
	 * Boot: the MCP first (an engine that connects while the MCP is down never gets its tools), then
	 * the engine. Never throws: a failed start is retried by the supervisors, and /readyz tells.
	 */
	async start() {
		this.timeoutPolicy = await loadTimeoutPolicy(this.config, this.logger)
		this.logger.info("runtime timeout policy inventory", this.timeoutPolicy)
		if (this.closed) return
		try {
			await this.mcp.start()
		} catch (error) {
			this.logger.error("mcp failed to start; starting the engine without its tools", { error: String(error?.message ?? error) })
		}
		if (this.closed) return
		try {
			await this.engine.start()
		} catch (error) {
			this.logger.error("engine failed to start", { error: String(error?.message ?? error) })
		}
	}

	/** Sessions removed from the index at boot (never prompted): deleted in the engine once it is ready. */
	forgetEngineSessions(ids) {
		for (const id of ids ?? []) if (ENGINE_ID_RE.test(id)) this.engineDeletes.add(id)
		if (this.engine.state === "ready") void this.#flushEngineDeletes()
	}

	// ---- public API used by acp-bridge --------------------------------------------------------

	async initialize(params) {
		// The engine's prompt capabilities belong in the answer; a starting engine is waited for briefly
		await this.engine.whenReady(Math.min(5000, this.config.engineReadyWaitMs)).catch(() => {})
		return {
			protocolVersion: 1,
			agentCapabilities: this.capabilities(),
			agentInfo: this.engine.agentInfo ?? { name: "OpenCode", version: "unknown" },
			authMethods: [],
			_meta: { clientRequested: params?.protocolVersion ?? null },
		}
	}

	/**
	 * What the gateway offers a browser: a whitelist, never the engine's own capabilities (they list
	 * client MCP servers and session close/delete/fork, which the gateway doesn't serve). Also used by
	 * /session/info.
	 */
	capabilities() {
		const engineCaps = this.engine.agentCapabilities ?? {}
		return {
			loadSession: true,
			promptCapabilities: engineCaps.promptCapabilities ?? { image: true, embeddedContext: true },
			sessionCapabilities: { list: {}, resume: {} },
			_meta: {
				gateway: "geocluster-runtime",
				api: 3,
				extensions: ["_gc/attach", "_gc/status", "_gc/turn_end", "_gc/child_update", "_gc/permission_resolved", "_gc/notice"],
				features: FEATURES,
				build: this.build?.toJSON() ?? null,
				capacity: { maxRunning: this.config.maxRunning },
				agentModes: AGENT_MODES,
			},
		}
	}

	/** Each explicit browser read is a fresh discovery boundary; internal status stays cached. */
	async browserStatus() {
		await this.accountUsage.refresh()
		return this.status()
	}

	status() {
		const engine = this.engine
		const sessions = [...this.convs.values()]
			.filter((c) => c.turn !== "idle" || c.pending.size > 0 || c.boundGen === engine.generation)
			.map((c) => ({
				sessionId: c.id,
				turn: c.turn === "idle" ? "idle" : "running",
				turnStartedAt: c.turnStartedAt,
				submissionId: c.submissionId,
				pendingPermissions: [...c.pending.keys()].map((reqId) => ({ reqId })),
				bound: c.boundGen === engine.generation,
				runDir: c.runDir,
				agentMode: c.agentMode,
			}))
		return {
			modelDiscovery: this.accountUsage.status(),
			engine: {
				state: engine.state,
				pid: engine.pid ?? null,
				generation: engine.generation,
				version: engine.agentInfo?.version ?? null,
				tools: engine.tools ?? "unknown",
				restarts: engine.restarts?.length ?? 0,
			},
			mcp: {
				state: this.mcp.state,
				pid: this.mcp.pid ?? null,
				port: this.config.mcpPort,
				// fresh only when /readyz just asked (health.js); never a stale value for a stopped MCP
				inFlight: this.mcp.state === "ready" && Date.now() - (this.mcp.lastHealth?.at ?? 0) < 30000 ? (this.mcp.lastHealth?.inFlight ?? null) : null,
			},
			newSession: { available: this.accountUsage.modelSessionsAvailable, configOptions: this.accountUsage.filter(clientConfigOptions(this.#newSessionOptions())) },
			sessions,
			running: this.#running().length,
			capacity: { maxRunning: this.config.maxRunning },
			attachedSockets: this.ports.size,
			timeoutPolicy: this.timeoutPolicy,
		}
	}

	async newSession(params, port) {
		const agentMode = params?._meta?.agentMode ?? "geology"
		if (!AGENT_MODES.includes(agentMode)) {
			throw RequestError.invalidParams({ agentMode }, `Unknown agentMode. Expected one of: ${AGENT_MODES.join(", ")}`)
		}
		if (this.closed) throw notReady("stopping", "the runtime is shutting down")
		this.engineUsers++
		try {
			return await this.#createSession(agentMode, port)
		} finally {
			this.engineUsers--
			void this.#maybeRestartForTools()
		}
	}

	async #createSession(agentMode, port) {
		await this.accountUsage.refresh()
		if (!this.accountUsage.modelSessionsAvailable) throw this.#modelUnavailable(null)
		await this.engine.whenReady(this.config.engineReadyWaitMs)
		const generation = this.engine.generation
		const created = await this.engine.newSession({ cwd: this.config.workspaceDir, mcpServers: [] }).catch((error) => this.#engineFailure(error))
		const sessionId = String(created?.sessionId ?? "")
		if (!ENGINE_ID_RE.test(sessionId)) throw new Error(`engine returned an unexpected session id: ${sessionId}`)
		const runDir = `${this.config.runsSubdir}/${sessionId}`
		// Registered synchronously, so frames that arrive from here on are routed to it
		const conv = new Conversation({ sessionId, runDir, agentMode })
		conv.boundGen = generation
		conv.configOptions = Array.isArray(created.configOptions) ? created.configOptions : null
		conv.savedModelId = conv.modelId
		this.convs.set(sessionId, conv)
		const early = this.#takeEarly(sessionId)
		try {
			await this.engine.setMode(sessionId, agentMode).catch((error) => this.#engineFailure(error))
			conv.configOptions = conv.configOptions?.map((o) => (o?.id === "mode" ? { ...o, currentValue: agentMode } : o)) ?? null
			await this.#applyDefaultEffort(conv)
			await this.index.add({ sessionId, runDir, agentMode, modelId: conv.savedModelId })
			await fs.mkdir(path.join(this.config.workspaceDir, runDir), { recursive: true })
			await this.#logFor(sessionId, { cwd: this.config.workspaceDir, runDir, agentMode })
		} catch (error) {
			this.convs.delete(sessionId)
			await this.index.remove?.(sessionId).catch(() => {})
			await this.engine.deleteSession(sessionId).catch(() => {})
			throw error
		}
		// In arrival order, without awaiting between them, so no later frame overtakes them
		for (const frame of early) this.#routeFrame(frame)
		port?.attached.add(sessionId)
		this.logger.info("session created", { sessionId, agentMode, runDir })
		return {
			sessionId,
			configOptions: this.#clientConfigOptions(conv),
			models: this.#models(conv),
			modes: null,
			_meta: { runDir, agentMode },
		}
	}

	/** session/resume: attach this socket and bind the conversation to the engine, without a replay. */
	async resumeSession(params, port) {
		await this.accountUsage.refresh()
		const conv = this.#known(params?.sessionId)
		port?.attached.add(conv.id)
		await this.#bindIfReady(conv)
		return { configOptions: this.#clientConfigOptions(conv), models: this.#models(conv), modes: null, _meta: this.#convMeta(conv) }
	}

	/** session/load: attach, bind when possible, and replay the whole transcript from the gateway's log. */
	async loadSession(params, port) {
		await this.accountUsage.refresh()
		const conv = this.#known(params?.sessionId)
		port.attached.add(conv.id)
		await this.#bindIfReady(conv)
		const log = await this.#logFor(conv.id)
		const replayed = await this.#replayTo(port, log, 0)
		this.#reissuePending(port, conv)
		return {
			configOptions: this.#clientConfigOptions(conv),
			models: this.#models(conv),
			modes: null,
			_meta: { ...this.#convMeta(conv), lastSeq: replayed.until, truncated: replayed.truncated },
		}
	}

	/**
	 * _gc/attach: incremental replay from afterSeq for a (re)connecting socket. Served from the
	 * gateway's log only: attaching never touches the engine (API-03).
	 */
	async attach(params, port) {
		await this.accountUsage.refresh()
		const sessionId = String(params?.sessionId ?? "")
		const afterSeq = Number.isFinite(Number(params?.afterSeq)) ? Number(params.afterSeq) : 0
		if (!sessionId) throw RequestError.invalidParams({ sessionId }, "sessionId is required")
		const conv = this.#known(sessionId)
		port.attached.add(sessionId)
		const log = await this.#logFor(sessionId)
		const replayed = await this.#replayTo(port, log, afterSeq)
		this.#reissuePending(port, conv)
		return {
			sessionId,
			// the last event on disk when the replay started: anything newer arrives live
			lastSeq: replayed.until,
			truncated: replayed.truncated,
			resident: conv.boundGen === this.engine.generation,
			turn: conv.turn === "idle" ? "idle" : "running",
			turnStartedAt: conv.turnStartedAt,
			submissionId: conv.submissionId,
			configOptions: this.#clientConfigOptions(conv),
			models: this.#models(conv),
			modes: null,
			pendingPermission: conv.pending.size ? { reqId: [...conv.pending.keys()][0] } : null,
			pendingPermissions: [...conv.pending.keys()].map((reqId) => ({ reqId })),
			...this.#convMeta(conv),
		}
	}

	listSessions(params) {
		return this.index.list(params?.cursor ?? null)
	}

	async prompt(params, port) {
		const conv = this.#known(params?.sessionId)
		if (conv.archived) throw conv.lost ? lostError(conv.id) : archivedError(conv.id)
		const submissionId = this.#submissionIdOf(params)
		if (!submissionId) return this.#promptOnce(conv, params, port, null)
		// API-07: the same submission twice runs once. Registered before any await, so a duplicate that
		// arrives while the first is still being admitted shares its result instead of hitting -32001
		const inflight = conv.inflight.get(submissionId)
		if (inflight) {
			port?.attached.add(conv.id)
			return inflight
		}
		const run = this.#promptOnce(conv, params, port, submissionId)
		conv.inflight.set(submissionId, run)
		run.then(
			() => conv.inflight.delete(submissionId),
			() => conv.inflight.delete(submissionId),
		)
		return run
	}

	async #promptOnce(conv, params, port, submissionId) {
		if (this.closed) throw notReady("stopping", "the runtime is shutting down")
		// Registered synchronously, one entry per waiting prompt: a cancel that arrives during the
		// admission below (the engine, the bind) is remembered for the prompt it names
		const admission = { submissionId, cancelled: false }
		conv.admitting.add(admission)
		try {
			if (submissionId) {
				const done = await this.#findSubmission(conv, submissionId)
				if (done) return { stopReason: done.stopReason, _meta: { ...(done._meta ?? {}), submissionId, duplicate: true } }
			}
			const blocks = await this.#checkPrompt(params?.prompt)
			// API-04: refuse before the (possibly slow) bind, and again after it with no await between the
			// last check and the state change, so a concurrent prompt can't slip in
			this.#assertCanRun(conv)
			await this.#checkMemory()
			this.#reviveMcp()
			await this.engine.whenReady(this.config.engineReadyWaitMs)
			await this.#bind(conv)
			await this.accountUsage.refresh()
			if (conv.unavailableModelId || !this.accountUsage.allowed(conv.modelId)) throw this.#modelUnavailable(conv.unavailableModelId ?? conv.savedModelId ?? conv.modelId)
			this.#assertCanRun(conv)
			conv.admitting.delete(admission)
			conv.turn = "running"
			conv.turnStartedAt = Date.now()
			conv.submissionId = submissionId
			conv.cancelRequested = admission.cancelled
			port?.attached.add(conv.id)

			let response
			try {
				response = await this.#runTurn(conv, params, blocks)
			} catch (error) {
				// #runTurn ends the turn on every engine failure; this is a gateway bug path
				this.logger.error("turn failed unexpectedly", { sessionId: conv.id, error: String(error?.stack ?? error) })
				response = await this.#endTurn(conv, { stopReason: "cancelled", _meta: { reason: "error", error: cleanMessage(error) } })
			}
			if (response?._meta?.engineBusy) throw busy(conv.id)
			return response
		} finally {
			conv.admitting.delete(admission)
			if (this.toolsRestart.wanted) void this.#maybeRestartForTools()
		}
	}

	/** An MCP that crash-looped to "unavailable" is tried again on a new prompt, at most once a minute. */
	#reviveMcp() {
		if (this.mcp.state !== "unavailable" || Date.now() - this.lastMcpRevive < 60000) return
		this.lastMcpRevive = Date.now()
		this.logger.warn("the shared MCP was unavailable; trying it again for a new prompt")
		void this.mcp.revive?.()
	}

	async cancel(params) {
		const conv = this.convs.get(String(params?.sessionId ?? ""))
		if (!conv) return
		const submissionId = params?._meta?.submissionId
		const stale = (running) => typeof submissionId === "string" && running && submissionId !== running
		if (conv.turn !== "running") {
			// Still being admitted (waiting for the engine or the bind): the turn ends as soon as it starts.
			// While "ending" there is nothing left to cancel
			if (conv.turn === "idle") for (const admission of conv.admitting) if (!stale(admission.submissionId)) admission.cancelled = true
			return
		}
		if (stale(conv.submissionId)) {
			this.logger.info("stale cancel ignored", { sessionId: conv.id, submissionId, running: conv.submissionId })
			return
		}
		conv.cancelRequested = true
		// Answer the engine's pending permission requests BEFORE the cancel: after $/cancel_request any
		// answer fails the prompt with PermissionNotFoundError (measured on 2.0.19)
		for (const reqId of [...conv.pending.keys()]) this.answerPermission(reqId, { outcome: "cancelled" }, "cancel")
		this.#armCancelWatchdog(conv)
		if (this.engine.state === "ready" && conv.boundGen === this.engine.generation) {
			await this.engine.cancel(conv.id).catch((error) => this.logger.warn("engine cancel failed", { sessionId: conv.id, error: String(error?.message ?? error) }))
		}
	}

	async setSessionModel(params) {
		const conv = this.#known(params?.sessionId)
		await this.#setConfigOption(conv, "model", params?.modelId)
		return {}
	}

	async setSessionConfigOption(params) {
		const conv = this.#known(params?.sessionId)
		const configId = String(params?.configId ?? "")
		if (!CLIENT_CONFIG_IDS.includes(configId)) {
			throw RequestError.invalidParams({ configId }, `Only ${CLIENT_CONFIG_IDS.join(" and ")} can be changed; the agent is chosen at session/new`)
		}
		await this.#setConfigOption(conv, configId, params?.value)
		return { configOptions: this.#clientConfigOptions(conv) }
	}

	/**
	 * Answer a pending permission request. `outcome` is an ACP RequestPermissionOutcome
	 * ({outcome:"selected", optionId} | {outcome:"cancelled"}); `by` records who decided.
	 */
	answerPermission(reqId, outcome, by = "user") {
		const conv = [...this.convs.values()].find((c) => c.pending.has(reqId))
		const pending = conv?.pending.get(reqId)
		if (!pending) return false
		conv.pending.delete(reqId)
		clearTimeout(pending.timer)
		const sessionId = conv.id
		this.logs.get(sessionId)?.append("permission_response", { sessionId, reqId, outcome, by }, { sync: true }).catch(() => {})
		let engineOutcome = outcome
		const chosen = outcome?.outcome === "selected" ? pending.params.options?.find((o) => o.optionId === outcome.optionId) : null
		if (chosen?.kind === "allow_always") {
			// "Always allow" is remembered by the gateway (prefs, machine-wide); the engine gets a one-off
			// yes, so the rule lives in one place only
			this.prefs.allowAlways(pending.params.toolCall).catch((error) => this.logger.warn("prefs save failed", String(error)))
			const once = pending.params.options.find((o) => o.kind === "allow_once")
			if (once) engineOutcome = { outcome: "selected", optionId: once.optionId }
		}
		if (conv.turn === "running" && conv.pending.size === 0) this.activity.setState(sessionId, "prompt_running")
		pending.resolve({ outcome: engineOutcome })
		this.#broadcastExt(sessionId, "_gc/permission_resolved", { sessionId, reqId, outcome, by })
		this.logger.info("permission answered", { reqId, by, outcome })
		return true
	}

	/** Graceful shutdown: cancel running turns, wait briefly, stop the engine, drain + stop the MCP, flush logs. */
	async shutdown() {
		this.closed = true
		const running = this.#running()
		for (const conv of running) {
			this.logger.info("shutdown: cancelling running turn", { sessionId: conv.id })
			await this.cancel({ sessionId: conv.id }).catch((error) => this.logger.warn("shutdown: cancel failed", String(error?.message ?? error)))
		}
		if (running.length) await this.#waitTurnEnd(TURN_END_GRACE_MS)
		// In parallel, so the whole shutdown fits the entrypoint's 15 s and a short stop timeout. The MCP
		// is not drained: with the engine gone it has no client left to answer (and its outputs are
		// written atomically)
		const warn = (what) => (error) => this.logger.warn(`shutdown: ${what} failed`, String(error?.message ?? error))
		await Promise.all([
			this.engine.stop().catch(warn("engine stop")),
			this.mcp.stop({ drainMs: 0 }).catch(warn("mcp stop")),
			Promise.all([...this.logs.values()].map((log) => log.flush().catch(() => {}))),
			this.exporter.close?.(3000).catch(() => {}),
		])
	}

	// ---- conversations ------------------------------------------------------------------------

	/** The record of a conversation the index knows; resourceNotFound otherwise (root ids only). */
	#known(rawId) {
		const sessionId = String(rawId ?? "")
		const existing = this.convs.get(sessionId)
		if (existing) return existing
		const entry = ID_RE.test(sessionId) ? this.index.get(sessionId) : null
		if (!entry) throw RequestError.resourceNotFound(`session:${sessionId}`)
		const conv = new Conversation(entry)
		// The broker never sends an api-1/api-2 (Cline, 13-digit) id to the engine
		if (!ENGINE_ID_RE.test(sessionId)) conv.archived = true
		this.convs.set(sessionId, conv)
		return conv
	}

	#convMeta(conv) {
		const selected = conv.unavailableModelId ?? conv.modelId ?? conv.savedModelId
		return { runDir: conv.runDir, agentMode: conv.agentMode, archived: conv.archived, unavailableModelId: conv.unavailableModelId ?? (selected && !this.accountUsage.allowed(selected) ? selected : null) }
	}

	#modelUnavailable(modelId) {
		return new RequestError(-32007, "Managed model unavailable; select an installed eligible model explicitly, or restart after catalog discovery recovers.", { errorName: "model.unavailable", modelId, modelDiscovery: this.accountUsage.status() })
	}

	/** Conversations with a turn running or ending (both count for capacity). */
	#running() {
		return [...this.convs.values()].filter((c) => c.turn !== "idle")
	}

	/** Bind (session/resume) once per engine generation; concurrent callers share one resume. */
	async #bind(conv) {
		const generation = this.engine.generation
		if (conv.boundGen === generation) return
		if (conv.binding && conv.bindingGen === generation) return conv.binding
		conv.bindingGen = generation
		conv.binding = (async () => {
			try {
				const response = await this.engine.resumeSession(conv.id).catch((error) => (isSessionNotFound(error) ? Promise.reject(error) : this.#engineFailure(error)))
				if (this.engine.generation !== generation) throw notReady(this.engine.state, "engine restarted while resuming this conversation; retry")
				conv.boundGen = generation
				if (Array.isArray(response?.configOptions)) conv.configOptions = response.configOptions
				// Preserve a saved selection even if the engine reconciles it to a different default.
				if (conv.savedModelId && (conv.savedModelId !== conv.modelId || !this.accountUsage.installedModel(conv.savedModelId))) conv.unavailableModelId = conv.savedModelId
				this.logger.info("conversation bound", { sessionId: conv.id, generation })
			} catch (error) {
				if (isSessionNotFound(error)) {
					// The engine lost it (its database was reset): keep the transcript, read-only
					conv.archived = true
					conv.lost = true
					await this.index.archive(conv.id, { lost: true }).catch(() => {})
					this.logger.error("engine no longer knows this conversation; archived", { sessionId: conv.id })
					throw lostError(conv.id)
				}
				throw error
			} finally {
				conv.binding = null
			}
		})()
		return conv.binding
	}

	async #bindIfReady(conv) {
		if (conv.archived || this.engine.state !== "ready") return
		await this.#bind(conv).catch((error) => {
			if (error?.code === ERR_ARCHIVED) return
			if (errorName(error) === "configuration.reconciliation") throw error
			this.logger.warn("bind failed", { sessionId: conv.id, error: String(error?.message ?? error) })
		})
	}

	async #setConfigOption(conv, configId, value) {
		if (conv.archived) throw conv.lost ? lostError(conv.id) : archivedError(conv.id)
		if (typeof value !== "string" || !value) throw RequestError.invalidParams({ configId, value }, `${configId} must be a non-empty string`)
		if (configId === "model") {
			if (!this.accountUsage.installedModel(value)) throw RequestError.invalidParams({ configId, value }, `model not installed: ${value}`)
			await this.accountUsage.refresh()
			if (!this.accountUsage.allowed(value)) {
				const usageDenial = denialFor(this.accountUsage.available ? "model_not_allowed" : "usage_unavailable")
				throw new RequestError(-32007, usageDenial.message, { usageDenial })
			}
		}
		let response
		this.engineUsers++
		try {
			await this.engine.whenReady(this.config.engineReadyWaitMs)
			await this.#bind(conv)
			const model = conv.configOptions?.find?.((o) => o?.id === "model")?.currentValue
			response = await this.engine.setConfigOption(conv.id, configId, value).catch((error) => this.#engineFailure(error))
			if (Array.isArray(response?.configOptions)) conv.configOptions = response.configOptions
			if (configId === "effort") conv.defaultEffortPending = false
			if (configId === "model") {
				conv.savedModelId = value
				conv.unavailableModelId = null
				// Keep an unfinished reset retryable, while preserving explicit effort choices on the same model.
				if (value !== model) conv.defaultEffortPending = true
				if (conv.defaultEffortPending) {
					await this.#applyDefaultEffort(conv)
					conv.defaultEffortPending = false
				}
			}
		} finally {
			this.engineUsers--
			void this.#maybeRestartForTools()
		}
		const log = await this.#logFor(conv.id)
		await log.append(configId === "model" ? "model" : "config", { sessionId: conv.id, configId, value, ...(configId === "model" ? { modelId: value } : {}) })
		if (configId === "model") await this.index.touch(conv.id, { modelId: value }).catch(() => {})
		// Publish the final options after a model reset and automatic effort selection, before answering the setter.
		await this.#record(conv.id, { sessionUpdate: "config_option_update", configOptions: this.#clientConfigOptions(conv) })
	}

	/**
	 * Outside a turn, an engine that died under a request answers -32003 {state},
	 * not its raw -32603 EngineExited/ClientError. Other engine errors pass through.
	 */
	async #engineFailure(error) {
		const name = errorName(error)
		const down = name === "EngineExited" || error?.code === ERR_ENGINE_NOT_READY || (name === "ClientError" && !(await this.engine.checkHealth().catch(() => false)))
		if (down) throw notReady(this.engine.state === "ready" ? "restarting" : this.engine.state, "engine restarting; retry shortly")
		throw error
	}

	#clientConfigOptions(conv) {
		const options = this.accountUsage.filter(clientConfigOptions(conv.configOptions))
		return conv.unavailableModelId ? options?.map((option) => option.id === "model" ? { ...option, currentValue: null, _meta: { ...option._meta, unavailableModelId: conv.unavailableModelId } } : option) : options
	}

	/** What a new conversation starts with, before one exists: the engine's warm-up session, on the default effort. */
	#newSessionOptions() {
		const options = this.engine.newSessionConfigOptions
		const effort = defaultEffortFor(options, this.config.defaultEffort)
		return effort ? options.map((o) => (o?.id === "effort" ? { ...o, currentValue: effort } : o)) : options
	}

	/** Puts a conversation the engine left at effort "default" (new, or after a model change) on the default effort. */
	async #applyDefaultEffort(conv) {
		const effort = defaultEffortFor(conv.configOptions, this.config.defaultEffort)
		if (!effort) {
			const option = conv.configOptions?.find?.((o) => o?.id === "effort")
			if (option?.currentValue === "default" && this.config.defaultEffort !== "default") {
				this.logger.warn("runtime default effort is not offered by this model; keeping engine default", {
					sessionId: conv.id, modelId: conv.modelId, effort: this.config.defaultEffort,
					available: option.options?.map((o) => o.value), nextStep: "set RUNTIME_DEFAULT_EFFORT to an advertised value or default",
				})
			}
			return
		}
		const response = await this.engine.setConfigOption(conv.id, "effort", effort).catch((error) => this.#engineFailure(error))
		if (Array.isArray(response?.configOptions)) conv.configOptions = response.configOptions
	}

	/** The api-2 `models` shape, built from the engine's `model` config option. */
	#models(conv) {
		const option = this.#clientConfigOptions(conv)?.find?.((o) => o?.id === "model")
		if (!option) return null
		return {
			currentModelId: option.currentValue ?? null,
			availableModels: (option.options ?? []).map((o) => ({ modelId: o.value, name: o.name ?? o.value, description: o.description ?? null })),
		}
	}

	// ---- prompts ------------------------------------------------------------------------------

	#submissionIdOf(params) {
		const value = params?._meta?.submissionId
		if (value === undefined || value === null) return null
		if (typeof value !== "string" || !value || value.length > 128) {
			throw RequestError.invalidParams({ submissionId: value }, "_meta.submissionId must be a string of 1-128 characters")
		}
		return value
	}

	async #findSubmission(conv, submissionId) {
		const log = await this.#logFor(conv.id)
		return (log.meta.submissions ?? []).find((s) => s.id === submissionId && s.state === "done") ?? null
	}

	/**
	 * Prompt blocks a browser may send. The engine reads a `resource_link` file:// URI from anywhere
	 * its uid can read and sends it to the model (measured), so a link must resolve, after symlinks,
	 * inside the workspace; it is forwarded with the real path.
	 */
	async #checkPrompt(prompt) {
		if (!Array.isArray(prompt) || prompt.length === 0) throw RequestError.invalidParams({}, "prompt must be a non-empty array of content blocks")
		const blocks = []
		let hasContent = false
		for (const block of prompt) {
			if (!block || typeof block !== "object") throw RequestError.invalidParams({}, "every prompt block must be an object")
			if (block.type === "text") {
				if (typeof block.text !== "string") throw RequestError.invalidParams({}, "a text block needs text")
				if (block.text.trim()) hasContent = true
				blocks.push(block)
			} else if (block.type === "resource_link") {
				blocks.push({ ...block, uri: await this.#workspaceFileUri(block.uri) })
				hasContent = true
			} else if (block.type === "resource") {
				const resource = block.resource ?? {}
				if (typeof resource.text !== "string" && typeof resource.blob !== "string") {
					throw RequestError.invalidParams({}, "an embedded resource needs its text or blob; send a resource_link for a workspace file")
				}
				blocks.push(block)
				hasContent = true
			} else if (block.type === "image" || block.type === "audio") {
				blocks.push(block)
				hasContent = true
			} else {
				throw RequestError.invalidParams({ type: block.type }, `unsupported prompt block type: ${block.type}`)
			}
		}
		if (!hasContent) throw RequestError.invalidParams({}, "the prompt is empty")
		return blocks
	}

	async #workspaceFileUri(uri) {
		let file
		try {
			const url = new URL(String(uri ?? ""))
			if (url.protocol !== "file:") throw new Error("not a file URI")
			file = decodeURIComponent(url.pathname)
		} catch {
			throw RequestError.invalidParams({ uri }, "resource_link must be a file:// URI inside the workspace")
		}
		const root = await fs.realpath(this.config.workspaceDir)
		let real
		try {
			real = await fs.realpath(path.isAbsolute(file) ? file : path.join(root, file))
		} catch {
			throw RequestError.invalidParams({ uri }, "resource_link: file not found in the workspace")
		}
		if (real !== root && !real.startsWith(root + path.sep)) throw RequestError.invalidParams({ uri }, "resource_link must point inside the workspace")
		// The engine inlines the whole file into the message: only regular files, and not more than the
		// model can take (it fails between 5 and 10 MB, and ~1 MB already overflows a 200k context)
		const stat = await fs.stat(real)
		const name = path.relative(root, real)
		if (!stat.isFile()) throw RequestError.invalidParams({ uri }, `resource_link: ${name} is not a regular file; attach files, not folders`)
		const maxBytes = this.config.attachMaxKb * 1024
		if (stat.size > maxBytes) {
			throw RequestError.invalidParams(
				{ uri, size: stat.size, maxBytes },
				`resource_link: ${name} is ${Math.round(stat.size / 1024)} KB, above the ${this.config.attachMaxKb} KB attachment limit. Next step: mention its path in your message and ask the agent to inspect or summarise it`,
			)
		}
		// Percent-encoded from the checked realpath: the engine parses the URI again, and a literal
		// %2e%2e, %41, # or ? in a name would otherwise make it read another file (or fail the turn)
		return pathToFileURL(real).href
	}

	#assertCanRun(conv) {
		if (conv.turn !== "idle") throw busy(conv.id)
		const running = this.#running()
		if (running.length >= this.config.maxRunning) {
			throw capacityError(`${this.config.maxRunning} conversations are running; wait for one to finish or cancel it`, {
				maxRunning: this.config.maxRunning,
				running: running.map((c) => c.id),
			})
		}
	}

	/** Refuse a new turn while the machine is nearly out of memory (nothing can be stopped to make room). */
	async #checkMemory() {
		const pct = this.config.memoryGuardPct
		if (!pct) return
		const mem = await this.memory()
		if (mem && (mem.used / mem.max) * 100 > pct) {
			throw capacityError(`machine memory is at ${Math.round((mem.used / mem.max) * 100)}% (limit ${pct}%); wait for a running conversation to finish`, {
				usedMb: Math.round(mem.used / 1048576),
				maxMb: Math.round(mem.max / 1048576),
			})
		}
	}

	async #runTurn(conv, params, blocks) {
		const sessionId = conv.id
		const log = await this.#logFor(sessionId)
		const entry = this.index.get(sessionId)
		if (entry && !entry.title) {
			// A title marks the conversation as prompted (listed, kept at boot), so a prompt without text
			// (an image, a file) gets one too
			const text = blocks.find((b) => b.type === "text" && b.text.trim())?.text?.trim()
			log.meta.title = text ? text.slice(0, 120) : `(${blocks[0]?.type ?? "message"})`
			await this.index.touch(sessionId, { title: log.meta.title })
		}
		const echoMeta = conv.submissionId ? { submissionId: conv.submissionId } : null
		// The engine never echoes a live prompt; the gateway's echo is what every tab and replay shows
		for (const block of params.prompt) {
			await this.#record(sessionId, { sessionUpdate: "user_message_chunk", content: block, ...(echoMeta ? { _meta: echoMeta } : {}) })
		}
		if (conv.submissionId) this.#rememberSubmission(log, { id: conv.submissionId, state: "running" })
		this.activity.start(sessionId, "prompt_running")
		conv.tracker = await this.#trackerFor(conv, log)
		conv.tracker.beginTurn()

		let response
		try {
			response = await this.#enginePrompt(conv, { sessionId, prompt: blocks })
			if (response?.stopReason === "end_turn" && conv.agentMode === "report-analysis" && !conv.cancelRequested) {
				response = await this.#citationCheck(conv, log, response)
			}
		} catch (error) {
			response = await this.#turnFailure(conv, error, { attachments: blocks.some((b) => b.type === "resource_link") })
		}
		// Every cancelled turn says why (the engine's own `cancelled` carries no reason)
		if (response?.stopReason === "cancelled" && !response._meta?.reason) response = { ...response, _meta: { ...(response._meta ?? {}), reason: "cancelled" } }

		let report = null
		if (response?.stopReason === "end_turn" && !response._meta?.citationFailed && !response._meta?.forced) report = await this.#exportReport(conv)
		if (response?.stopReason === "cancelled") response = { ...response, _meta: { ...(response._meta ?? {}), processesStopped: await this.#reapConversation(conv) } }
		if (conv.retrying) {
			// The engine sends no "retry over" when a turn ends during its backoff: clear the banner
			conv.retrying = false
			await this.#record(sessionId, { sessionUpdate: "session_info_update", _meta: { "opencode/retry": null, gateway: "retry_cleared" } }).catch(() => {})
		}
		return this.#endTurn(conv, response, { report })
	}

	/**
	 * One engine prompt, raced against the cancel watchdog. A conversation whose binding was lost
	 * ("session not found": the engine restarted between the bind and the prompt) is re-bound once;
	 * the engine had made no model request.
	 */
	async #enginePrompt(conv, params, { retried = false } = {}) {
		if (conv.enginePrompt) {
			// A force-ended turn's engine prompt must have answered, or the engine refuses this one
			await Promise.race([conv.enginePrompt, delay(PREVIOUS_PROMPT_WAIT_MS)])
		}
		// Cancelled while it was being admitted, or before RE-4's correction: the engine never sees it
		if (conv.cancelRequested) return { stopReason: "cancelled", _meta: { reason: "cancelled" } }
		const generation = this.engine.generation
		const call = this.engine.prompt(params)
		const settled = call.then(
			() => {},
			() => {},
		)
		conv.enginePrompt = settled
		settled.then(() => {
			if (conv.enginePrompt === settled) conv.enginePrompt = null
		})
		let resolveForced
		const forced = new Promise((resolve) => (conv.forceEndTurn = resolveForced = resolve))
		try {
			return await Promise.race([call, forced])
		} catch (error) {
			if (!retried && isSessionNotFound(error) && this.engine.generation === generation && !conv.archived) {
				this.logger.warn("engine lost the binding; resuming and retrying", { sessionId: conv.id })
				conv.boundGen = -1
				await this.#bind(conv)
				return await this.#enginePrompt(conv, params, { retried: true })
			}
			throw error
		} finally {
			// only our own resolver: a retry installed its own, which the watchdog still needs
			if (conv.forceEndTurn === resolveForced) conv.forceEndTurn = null
		}
	}

	/** Map an engine failure to the turn's end (and an X-6 `Error:` line in the transcript). */
	async #turnFailure(conv, error, { attachments = false } = {}) {
		const sessionId = conv.id
		const name = errorName(error)
		const message = cleanMessage(error)
		const agent = `${conv.agentMode} agent`
		this.logger.error("prompt failed", { sessionId, code: error?.code, errorName: name, error: message })
		const usageDenial = managedDenial(error)
		if (usageDenial) {
			await this.#errorLine(conv, `Error: the ${agent}'s model request paused. ${usageDenial.message} Completed results remain in this conversation. Next step: ${usageDenial.recovery}`)
			return { stopReason: "cancelled", _meta: { reason: "paused_for_usage", error: usageDenial.message, errorName: usageDenial.code, usageDenial } }
		}

		if (name === "PermissionNotFoundError") return { stopReason: "cancelled", _meta: { reason: "cancelled" } }
		let restarted = name === "EngineExited" || error?.code === ERR_ENGINE_NOT_READY
		if (!restarted && name === "ClientError") restarted = !(await this.engine.checkHealth().catch(() => false))
		if (restarted) {
			await this.#errorLine(conv, `Error: the agent engine stopped during this turn and is restarting (${agent}). Next step: send your message again to continue the conversation.`)
			return { stopReason: "cancelled", _meta: { reason: "server_restart" } }
		}
		if (isEngineBusy(error)) {
			this.logger.error("engine reports a prompt still active for this conversation (broker serialization bug)", { sessionId })
			return { stopReason: "cancelled", _meta: { reason: "error", error: message, engineBusy: true } }
		}
		let text
		let kind = name ?? (error?.code === -32000 ? "provider.auth" : "engine")
		if (error?.code === -32000) {
			kind = "provider.auth"
			const role = { geology: "Geology", standard: "Standard", "report-analysis": "Report analysis" }[conv.agentMode] ?? "Workspace"
			text = `Error: the ${role} assistant's model request could not be authenticated. Next step: update the runtime's model credentials to restore model access, then send your message again.`
		} else if (name === "provider.quota") {
			text = `Error: the model provider reports insufficient credits (${message}) for the ${agent}. Next step: add credits or ask your administrator, then send the message again.`
		} else if (name === "provider.rate-limit") {
			text = `Error: the model provider kept rate-limiting the ${agent} after 3 retries (${message}). Next step: wait a minute, then send the message again.`
		} else if (name === "provider.internal" || name === "provider.transport") {
			text = `Error: the model provider failed for the ${agent} after 3 retries (${message}). Next step: send the message again, or choose another model.`
		} else if (attachments && (name === "ClientError" || name === "InvalidRequestError")) {
			kind = "attachment"
			text = `Error: the engine could not take the attached file(s) into the ${agent}'s message (${message}). Next step: send the message without the attachment, mention the file's path instead and ask the agent to inspect it.`
		} else if (name === "provider.invalid-request") {
			text = `Error: the model provider rejected the request from the ${agent} (${message}). Next step: shorten the message or its attachments, or choose another model.`
		} else {
			text = `Error: the ${agent} failed (${message}). Next step: send the message again; if it keeps failing, start a new conversation.`
		}
		await this.#errorLine(conv, text)
		return { stopReason: "cancelled", _meta: { reason: "error", error: message, errorName: kind } }
	}

	async #errorLine(conv, text) {
		await this.#record(conv.id, { sessionUpdate: "agent_message_chunk", content: { type: "text", text }, _meta: { gateway: "error" } }).catch(() => {})
	}

	/**
	 * RE-4 (report-analysis): every [source: …] file in the answer must have been read in this
	 * conversation. On fabrication, one correction prompt inside the same browser turn; still failing
	 * → a warning and no report. Weaker than the fork's hard reject: the first answer has streamed.
	 */
	async #citationCheck(conv, log, response) {
		const tracker = conv.tracker
		const answer = tracker.answer()
		if (!answer.trim()) return response
		const flagged = findFabricatedCitations(answer, tracker.reads)
		if (!flagged.length) return response
		const sessionId = conv.id
		this.logger.warn("citation check failed; asking for a correction", { sessionId, flagged })
		await log.append("gateway", { sessionId, type: "citation_check", attempt: 1, flagged })
		this.#broadcastExt(sessionId, "_gc/notice", {
			sessionId,
			level: "info",
			kind: "citation_check",
			flagged,
			message: `The answer cites ${flagged.length} file(s) the agent never read; it is asked to correct the answer.`,
		})
		tracker.beginTurn()
		const second = await this.#enginePrompt(conv, { sessionId, prompt: [{ type: "text", text: correctionPrompt(flagged) }] })
		if (second?.stopReason !== "end_turn") return second
		if (conv.cancelRequested) return { stopReason: "cancelled", _meta: { reason: "cancelled" } }
		const still = findFabricatedCitations(tracker.answer(), tracker.reads)
		if (!still.length) return second
		this.logger.warn("citation check failed again; no report saved", { sessionId, flagged: still })
		await log.append("gateway", { sessionId, type: "citation_check", attempt: 2, flagged: still })
		this.#broadcastExt(sessionId, "_gc/notice", {
			sessionId,
			level: "warning",
			kind: "citation_check",
			flagged: still,
			message: `The corrected answer still cites ${still.length} file(s) the agent never read; treat those claims as unverified. No report was saved.`,
		})
		return { ...second, _meta: { ...(second._meta ?? {}), citationFailed: still } }
	}

	/** The report's .md is written before turn_end (its path goes in it); .docx/.pdf follow in the background. */
	async #exportReport(conv) {
		if (!this.config.reportExport || !conv.runDir) return null
		const text = conv.tracker?.answer() ?? ""
		if (!text.trim()) return null
		const written = await this.exporter.writeMarkdown(conv.runDir, text).catch(() => null)
		if (!written) return null
		void this.exporter.convert(written.absPath)
		return written.relPath
	}

	/**
	 * API-09: a cancelled turn ends only after the conversation's tool processes have stopped. They
	 * are found by GEOCLUSTER_RUN_DIR=runs/<id> (set by the run-dir plugin); stragglers are killed.
	 */
	async #reapConversation(conv) {
		if (!conv.runDir) return true
		const deadline = Date.now() + this.config.cancelReapMs
		let left = await this.engine.conversationProcesses(conv.runDir).catch(() => [])
		while (left.length && Date.now() < deadline) {
			await delay(100)
			left = await this.engine.conversationProcesses(conv.runDir).catch(() => [])
		}
		if (!left.length) return true
		this.logger.warn("tool processes outlived a cancelled turn; stopping them", { sessionId: conv.id, count: left.length })
		await reapTree(left, 1000)
		left = await this.engine.conversationProcesses(conv.runDir).catch(() => [])
		if (left.length) this.logger.error("tool processes survived SIGKILL after a cancel", { sessionId: conv.id, pids: left.map((p) => p.pid) })
		return left.length === 0
	}

	#armCancelWatchdog(conv) {
		if (conv.cancelTimer) return
		const turnStartedAt = conv.turnStartedAt
		conv.cancelTimer = setTimeout(() => {
			conv.cancelTimer = null
			if (conv.turn !== "running" || conv.turnStartedAt !== turnStartedAt || !conv.forceEndTurn) return
			this.logger.warn("cancelled turn did not end; ending it and closing the engine session", { sessionId: conv.id, graceMs: this.config.cancelGraceMs })
			conv.forceEndTurn({ stopReason: "cancelled", _meta: { reason: "cancel_timeout", forced: true } })
			// close cancels the engine's turn (measured: ~30 ms) and unbinds it; the next prompt resumes it.
			// Other conversations are untouched (api 2 had to restart processes here)
			conv.boundGen = -1
			if (this.engine.state === "ready") void this.engine.closeSession(conv.id).catch(() => {})
			this.#broadcastExt(conv.id, "_gc/notice", {
				sessionId: conv.id,
				level: "warning",
				message: "The agent did not stop after cancel, so the gateway ended the turn. Continue with your next message.",
			})
		}, this.config.cancelGraceMs)
		conv.cancelTimer.unref?.()
	}

	/**
	 * End the running turn: turn_end is written (fsynced) and fanned out BEFORE the conversation can be
	 * prompted again. Meanwhile it is "ending" (busy for admission and capacity): a prompt admitted in
	 * that window would echo before this turn_end (seq going backwards on every socket) and lose its own
	 * submission id and tracker to the clears below (review CONC-1).
	 */
	async #endTurn(conv, response, { report = null } = {}) {
		const sessionId = conv.id
		if (conv.turn !== "running") return response
		conv.turn = "ending"
		clearTimeout(conv.cancelTimer)
		conv.cancelTimer = null
		for (const reqId of [...conv.pending.keys()]) this.answerPermission(reqId, { outcome: "cancelled" }, "turn_end")
		const submissionId = conv.submissionId
		const _meta = {}
		for (const key of TURN_END_META) if (response?._meta?.[key] !== undefined) _meta[key] = response._meta[key]
		if (submissionId) _meta.submissionId = submissionId
		if (report) _meta.report = report
		const stopReason = response?.stopReason ?? "cancelled"
		try {
			const log = await this.#logFor(sessionId)
			if (submissionId) this.#rememberSubmission(log, { id: submissionId, state: "done", stopReason, _meta })
			const seq = await log.append("turn_end", { sessionId, stopReason, _meta }, { sync: true })
			this.#fanout(sessionId, { kind: "turn_end", seq, params: { sessionId, stopReason, _meta, seq } })
		} catch (error) {
			this.logger.error("could not record turn_end", { sessionId, error: String(error?.message ?? error) })
		} finally {
			// One synchronous block: admittable again only with a clean slate
			conv.submissionId = null
			conv.tracker = null
			// Spawning calls and the child tree only matter while a turn runs (background subagents are off)
			conv.subagentCalls.clear()
			conv.children.clear()
			conv.turnStartedAt = null
			conv.turn = "idle"
			this.activity.stop(sessionId, { completed: stopReason === "end_turn" && !_meta.reason })
		}
		// Not before the fan-out: the index save is one queue for every conversation. A turn without a
		// usage_update leaves the stored context occupancy as it was (undefined is not written)
		await this.index
			.touch(sessionId, { modelId: conv.modelId ?? undefined, contextUsed: conv.usage ? conv.usage.used : undefined, contextSize: conv.usage ? conv.usage.size : undefined })
			.catch(() => {})
		// Shutdown waits for this: only now, so the prompt's response is sent before the sockets close
		if (!this.#running().length) {
			for (const waiter of this.turnWaiters) waiter()
			this.turnWaiters.clear()
		}
		void this.#maybeRestartForTools()
		const out = { stopReason, _meta }
		if (response?.usage) out.usage = response.usage
		if (response?._meta?.engineBusy) out._meta = { ...out._meta, engineBusy: true }
		return out
	}

	#rememberSubmission(log, record) {
		const list = (log.meta.submissions ?? []).filter((s) => s.id !== record.id)
		list.push(record)
		log.meta.submissions = list.slice(-SUBMISSIONS_KEPT)
	}

	#waitTurnEnd(ms) {
		if (!this.#running().length) return Promise.resolve()
		return new Promise((resolve) => {
			const timer = setTimeout(resolve, ms)
			this.turnWaiters.add(() => {
				clearTimeout(timer)
				resolve()
			})
		})
	}

	/** The answer text and read ledger; report-analysis rebuilds its ledger from the log (reads of earlier turns count). */
	async #trackerFor(conv, log) {
		const tracker = new TurnTracker({ cwd: this.config.workspaceDir })
		if (conv.agentMode !== "report-analysis") return tracker
		await log.replay(0, (event) => {
			if (event.kind === "update") tracker.onUpdate(event.update)
			else if (event.kind === "child") tracker.onChild(event)
		})
		return tracker
	}

	// ---- engine frames ------------------------------------------------------------------------

	#routeFrame(frame) {
		if (frame.kind === "update") void this.#onEngineUpdate(frame.params)
		else if (frame.kind === "child") void this.#onEngineChild(frame.params)
	}

	/** Frames for an id not registered yet: session/new's own frames arrive before its response. */
	#buffer(sessionId, frame) {
		let slot = this.early.get(sessionId)
		if (!slot) {
			if (this.early.size >= EARLY_MAX_IDS) {
				this.logger.warn("dropping an engine frame for an unknown session (buffer full)", { sessionId })
				return
			}
			slot = { frames: [], timer: null }
			slot.timer = setTimeout(() => {
				this.early.delete(sessionId)
				this.logger.warn("dropped engine frames for a session the gateway never registered", { sessionId, count: slot.frames.length })
			}, EARLY_TTL_MS)
			slot.timer.unref?.()
			this.early.set(sessionId, slot)
		}
		if (slot.frames.length < EARLY_MAX_FRAMES) slot.frames.push(frame)
	}

	#takeEarly(sessionId) {
		const slot = this.early.get(sessionId)
		if (!slot) return []
		clearTimeout(slot.timer)
		this.early.delete(sessionId)
		return slot.frames
	}

	async #onEngineUpdate(params) {
		const sessionId = String(params?.sessionId ?? "")
		const update = params?.update
		if (!sessionId || !update || typeof update !== "object") return
		// OpenCode's own slash commands (init, review) mean nothing here
		if (update.sessionUpdate === "available_commands_update") return
		// The gateway owns model/effort setters and publishes their final, filtered options itself.
		if (update.sessionUpdate === "config_option_update") return
		const conv = this.convs.get(sessionId)
		if (!conv) return this.#buffer(sessionId, { kind: "update", params })
		if (update.sessionUpdate === "usage_update") conv.usage = { used: update.used ?? null, size: update.size ?? null }
		if (update.sessionUpdate === "session_info_update" && update._meta && "opencode/retry" in update._meta) conv.retrying = Boolean(update._meta["opencode/retry"])
		const relinked = this.#trackSubagentCall(conv, sessionId, update).map((node) => this.#relinkFrame(node))
		conv.tracker?.onUpdate(update)
		// Appends are queued in call order, so start them all before awaiting: a frame that arrives
		// meanwhile must not overtake this update's relink frames
		const recorded = this.#record(sessionId, update).catch((error) =>
			this.logger.error("failed to record update", { sessionId, error: String(error?.message ?? error) }),
		)
		const relinks = relinked.map((frame) => this.#recordChild(conv, frame))
		await recorded
		await Promise.all(relinks)
		const reset = update.sessionUpdate === "session_info_update" ? update._meta?.["geocluster/effort-reset"] : null
		if (reset?.effort === "default" && typeof reset.modelId === "string" && typeof reset.previousEffort === "string") {
			this.logger.info("unsupported saved effort reset to supplier default", { sessionId, ...reset })
			this.#broadcastExt(sessionId, "_gc/notice", {
				sessionId, level: "info", kind: "effort_reset", reset,
				message: `The saved effort "${reset.previousEffort}" is unavailable for ${reset.modelId}; it was reset to supplier default. Your model and conversation history were preserved.`,
			})
		}
	}

	async #onEngineChild(params) {
		const rootId = String(params?.rootSessionId ?? "")
		const childId = String(params?.childSessionId ?? "")
		if (!rootId || !childId) return
		const conv = this.convs.get(rootId)
		if (!conv) return this.#buffer(rootId, { kind: "child", params })
		const { frame, relinked } = this.#childFrame(conv, params)
		conv.tracker?.onChild(frame)
		// Started together (appends keep call order), built now (a later frame may change a child's status)
		await Promise.all([this.#recordChild(conv, frame), ...relinked.map((node) => this.#recordChild(conv, this.#relinkFrame(node)))])
	}

	async #recordChild(conv, frame) {
		try {
			const log = await this.#logFor(conv.id)
			const seq = await log.append("child", { sessionId: conv.id, ...frame })
			this.#fanout(conv.id, { kind: "child", seq, params: { sessionId: conv.id, seq, ...frame } })
		} catch (error) {
			this.logger.error("failed to record child frame", { sessionId: conv.id, error: String(error?.message ?? error) })
		}
	}

	/** A child whose spawning call was corrected: its current status again, with the right toolCallId. */
	#relinkFrame(node) {
		return {
			child: { sessionId: node.sessionId, parentSessionId: node.parentSessionId, depth: node.depth, title: node.title, toolCallId: node.toolCallId },
			type: "status",
			status: node.status,
			relinked: true,
		}
	}

	/** The api-3 child frame: {child:{sessionId, parentSessionId, depth, title, toolCallId}, type, status?, error?, update?}. */
	#childFrame(conv, params) {
		const childId = String(params.childSessionId)
		let node = conv.children.get(childId)
		if (!node) {
			// A `running` without `created` is a resumed specialist: it keeps the title it reports
			node = {
				sessionId: childId,
				parentSessionId: params.parentSessionId ?? conv.id,
				depth: Number(params.depth) || 1,
				title: params.title ?? null,
				status: null,
				toolCallId: null,
			}
			conv.children.set(childId, node)
			node.toolCallId = this.#linkChild(conv, node)
		}
		if (!node.title && params.title) node.title = params.title
		const frame = {
			child: { sessionId: childId, parentSessionId: node.parentSessionId, depth: node.depth, title: node.title, toolCallId: node.toolCallId },
			type: params.type === "status" ? "status" : "update",
		}
		if (params.type === "status") {
			node.status = params.status ?? null
			frame.status = params.status ?? null
			if (params.error !== undefined) frame.error = params.error
		}
		let relinked = []
		if (params.type !== "status" && params.update && typeof params.update === "object") {
			relinked = this.#trackSubagentCall(conv, childId, params.update)
			frame.update = params.update
		}
		return { frame, relinked }
	}

	/**
	 * Remember `subagent` calls so a new child can name the call that spawned it. Nothing in the
	 * engine's frames links them before completion; the child's `created` follows its call's
	 * in_progress, oldest first (measured, parallel calls included), and the call's completion carries
	 * rawOutput.metadata.sessionID, which corrects a wrong guess. A resumed specialist's call names
	 * its child in rawInput.sessionID.
	 */
	#trackSubagentCall(conv, sessionId, update) {
		const kind = update.sessionUpdate
		if (kind !== "tool_call" && kind !== "tool_call_update") return []
		const toolCallId = update.toolCallId
		if (!toolCallId) return []
		const key = `${sessionId}\0${toolCallId}`
		let call = conv.subagentCalls.get(key)
		const title = String(update.title ?? "")
		const isSubagent = title === "subagent" || title.endsWith(": subagent") || (update.kind === "think" && update.rawInput && "agent" in update.rawInput)
		if (!call) {
			if (!isSubagent) return []
			call = { sessionId, toolCallId, description: null, inProgress: false, child: null, order: conv.callOrder++ }
			conv.subagentCalls.set(key, call)
		}
		const rawInput = update.rawInput && typeof update.rawInput === "object" ? update.rawInput : null
		if (rawInput?.description) call.description = String(rawInput.description)
		if (update.status === "in_progress") call.inProgress = true
		const relinked = []
		if (rawInput?.sessionID && !call.child) relinked.push(...this.#setLink(conv, call, String(rawInput.sessionID), { resume: true }))
		const confirmed = update.rawOutput?.metadata?.sessionID
		if (confirmed) relinked.push(...this.#setLink(conv, call, String(confirmed)))
		if (update.status === "completed" || update.status === "failed") conv.subagentCalls.delete(key)
		return relinked
	}

	#linkChild(conv, node) {
		// A resumed specialist's call names it (rawInput.sessionID) before its `running`: that call wins
		const claimed = [...conv.subagentCalls.values()].find((c) => c.sessionId === node.parentSessionId && c.child === node.sessionId)
		if (claimed) return claimed.toolCallId
		const candidates = [...conv.subagentCalls.values()]
			.filter((c) => c.sessionId === node.parentSessionId && c.inProgress && !c.child)
			.sort((a, b) => a.order - b.order)
		const call = candidates.find((c) => c.description && c.description === node.title) ?? candidates[0]
		if (!call) return null
		call.child = node.sessionId
		return call.toolCallId
	}

	/**
	 * Link `call` to `childId` (a confirmation, or a resumed specialist's sessionID). A wrong order
	 * guess is undone both ways: the call the child was guessed onto is freed, and the child that
	 * was guessed onto this call is guessed again among the free calls. Returns the children whose
	 * link changed (the caller sends each a frame with the corrected toolCallId).
	 */
	#setLink(conv, call, childId, { resume = false } = {}) {
		const changed = []
		if (call.child !== childId) {
			for (const other of conv.subagentCalls.values()) if (other !== call && other.child === childId) other.child = null
			const displacedId = call.child
			call.child = childId
			const displaced = displacedId ? conv.children.get(displacedId) : null
			if (displaced && displaced.toolCallId === call.toolCallId) {
				displaced.toolCallId = this.#linkChild(conv, displaced)
				changed.push(displaced)
			}
		}
		const node = conv.children.get(childId)
		if (node && node.toolCallId !== call.toolCallId) {
			node.toolCallId = call.toolCallId
			// A call that resumes a finished child (rawInput.sessionID): its card must not flash the old
			// "completed" before the child's `running` arrives. A confirmation keeps the real status
			if (resume && ["completed", "interrupted", "failed"].includes(node.status)) node.status = null
			changed.push(node)
		}
		return changed
	}

	async #onEnginePermission({ params, rpcId, resolve }) {
		const sessionId = String(params?.sessionId ?? "")
		const conv = this.convs.get(sessionId)
		const options = Array.isArray(params?.options) ? params.options : []
		if (!conv || !options.length) {
			this.logger.warn("permission request for an unknown session; cancelling it", { sessionId })
			resolve({ outcome: { outcome: "cancelled" } })
			return
		}
		const reqId = crypto.randomUUID()
		// Specialists ask on their root's id; the toolCallId names the child (`ses_<child>:<call>`)
		const childSessionId = /^(ses_[A-Za-z0-9]+):/.exec(String(params.toolCall?.toolCallId ?? ""))?.[1] ?? null
		const log = await this.#logFor(sessionId)
		const toolCall = params.toolCall
		const cleanParams = { ...params, options, _meta: undefined }

		if (this.prefs.isAllowed(toolCall)) {
			const allow = options.find((o) => o.kind === "allow_once") ?? options[0]
			const outcome = { outcome: "selected", optionId: allow.optionId }
			await log.append("permission_request", { sessionId, reqId, childSessionId, toolCall, options })
			await log.append("permission_response", { sessionId, reqId, outcome, by: "policy" }, { sync: true })
			this.logger.info("permission auto-allowed by prefs", { reqId, title: toolCall?.title })
			resolve({ outcome })
			return
		}

		const pending = { reqId, rpcId: rpcId ?? null, generation: this.engine.generation, sessionId, childSessionId, params: cleanParams, resolve, requestedAt: Date.now(), timer: null }
		pending.timer = setTimeout(() => {
			const reject = options.find((o) => o.kind === "reject_once") ?? options[options.length - 1]
			this.logger.warn("permission timed out; rejecting", { reqId })
			this.#broadcastExt(sessionId, "_gc/notice", { sessionId, level: "warning", message: `Permission request timed out after ${this.config.permissionTimeoutMs / 60000} min and was rejected.` })
			this.answerPermission(reqId, { outcome: "selected", optionId: reject.optionId }, "timeout")
		}, this.config.permissionTimeoutMs)
		pending.timer.unref?.()
		conv.pending.set(reqId, pending)
		await log.append("permission_request", { sessionId, reqId, childSessionId, toolCall, options }, { sync: true })
		if (conv.turn === "running") this.activity.setState(sessionId, "permission_pending")

		let asked = 0
		for (const port of this.ports) {
			if (!port.attached.has(sessionId)) continue
			asked++
			this.#askPort(port, pending)
		}
		this.logger.info("permission requested", { reqId, sessionId, childSessionId, title: toolCall?.title, asked })
	}

	/** The engine withdrew its own request (it sends $/cancel_request after a root cancel). */
	#onEngineCancelRequest({ requestId }) {
		for (const conv of this.convs.values()) {
			for (const pending of conv.pending.values()) {
				if (pending.rpcId !== null && pending.rpcId === requestId && pending.generation === this.engine.generation) {
					this.answerPermission(pending.reqId, { outcome: "cancelled" }, "engine")
					return
				}
			}
		}
	}

	#onEngineExit(info) {
		if (info?.expected) return
		this.logger.error("engine exited; running turns end as server_restart", { code: info?.code, signal: info?.signal })
		for (const conv of this.convs.values()) {
			for (const reqId of [...conv.pending.keys()]) this.answerPermission(reqId, { outcome: "cancelled" }, "engine_exit")
			if (conv.turn === "running") {
				this.#broadcastExt(conv.id, "_gc/notice", {
					sessionId: conv.id,
					level: "warning",
					message: "The agent engine stopped and is restarting; this turn was interrupted. Send your message again to continue.",
				})
			}
		}
		this.#broadcastExt(null, "_gc/status", this.status())
	}

	#onEngineReady(info) {
		this.logger.info("engine ready", { generation: info?.generation, restarted: Boolean(info?.restarted), tools: this.engine.tools })
		this.#broadcastExt(null, "_gc/status", this.status())
		void this.#flushEngineDeletes()
		if (this.engine.tools === "missing" && this.mcp.state === "ready") this.#wantToolsRestart("geocluster tools missing after engine start")
	}

	#onEngineTools(info) {
		if (info?.state === "connected") this.toolsRestart.wanted = null
		else if (info?.state === "missing" && this.mcp.state === "ready") this.#wantToolsRestart("engine could not connect to the MCP")
	}

	#onMcpReady(info) {
		this.#broadcastExt(null, "_gc/status", this.status())
		if (info?.restarted) {
			this.#broadcastExt(null, "_gc/notice", { sessionId: null, level: "info", message: "The data tools (MCP server) are back." })
		}
		if (this.engine.state === "ready" && this.engine.tools === "missing") this.#wantToolsRestart("MCP became available after the engine started")
	}

	#onMcpExit(info) {
		if (info?.expected) return
		this.logger.error("shared MCP exited; restarting it", { code: info?.code, signal: info?.signal })
		this.#broadcastExt(null, "_gc/notice", {
			sessionId: null,
			level: "warning",
			message: "The data tools (MCP server) stopped and are restarting; a tool call made meanwhile fails. Ask the agent to retry it once they are back.",
		})
	}

	/**
	 * An engine that started while the MCP was down never gets its tools (measured); once the MCP is
	 * healthy, restart the engine — but never under a running turn, and not in a loop.
	 */
	#wantToolsRestart(reason) {
		this.toolsRestart.wanted = reason
		void this.#maybeRestartForTools()
	}

	async #maybeRestartForTools() {
		const state = this.toolsRestart
		// Never under a running turn, a prompt being admitted (it waits for the engine) or a session/new
		const busyConvs = [...this.convs.values()].some((c) => c.turn !== "idle" || c.admitting.size || c.binding)
		if (!state.wanted || state.running || this.closed || busyConvs || this.engineUsers) return
		if (this.engine.tools !== "missing") {
			state.wanted = null // the engine reconnected its tools meanwhile
			return
		}
		const now = Date.now()
		state.at = state.at.filter((t) => now - t < TOOLS_RESTART_WINDOW_MS)
		if (state.at.length >= TOOLS_RESTART_MAX) {
			this.logger.error("geocluster tools still missing after repeated engine restarts; giving up until the next MCP restart", { reason: state.wanted })
			state.wanted = null
			return
		}
		const reason = state.wanted
		state.wanted = null
		state.running = true
		state.at.push(now)
		this.logger.warn("restarting the engine to connect the geocluster tools", { reason })
		try {
			await this.engine.restart(reason)
		} catch (error) {
			this.logger.error("engine restart for tools failed", { error: String(error?.message ?? error) })
		} finally {
			state.running = false
		}
		// The new engine may still lack its tools (its "ready" arrived while this restart ran): try again
		// while idle, within the window's limit
		if (state.wanted) void this.#maybeRestartForTools()
	}

	async #flushEngineDeletes() {
		if (this.engine.state !== "ready") return
		for (const id of [...this.engineDeletes]) {
			this.engineDeletes.delete(id)
			await this.engine.deleteSession(id).catch((error) => this.logger.warn("engine session delete failed", { sessionId: id, error: String(error?.message ?? error) }))
		}
	}

	// ---- logs and fan-out ---------------------------------------------------------------------

	async #logFor(sessionId, extraMeta = {}) {
		const existing = this.logs.get(sessionId)
		if (existing) return existing
		// Two first frames of one session would race on meta.json.tmp (ENOENT on rename): share the open
		let opening = this.opening.get(sessionId)
		if (!opening) {
			const onError = (error) => this.logger.error("session log write failed", { sessionId, error: String(error?.message ?? error) })
			opening = (async () => {
				await this.closing.get(sessionId) // an evicted instance finishes its writes before the file is reopened
				return SessionLog.open(this.config.gatewayStateDir, sessionId, extraMeta, { onError })
			})().finally(() => this.opening.delete(sessionId))
			this.opening.set(sessionId, opening)
		}
		const log = await opening
		if (this.logs.get(sessionId) === log) return log
		this.logs.set(sessionId, log)
		this.#evictLogs(sessionId)
		return log
	}

	/**
	 * Keep the map small: running conversations and the last few attached ones. Removal is
	 * synchronous and the evicted instance refuses further appends, so no caller can write through
	 * it while a new instance reopens the file (two writers would hand out the same seqs).
	 */
	#evictLogs(keep) {
		if (this.logs.size <= 8 + this.config.maxRunning) return
		for (const [id, old] of this.logs) {
			const conv = this.convs.get(id)
			if (id === keep || old.busy || (conv && conv.turn !== "idle") || conv?.pending.size || conv?.admitting.size) continue
			this.logs.delete(id)
			old.closed = true
			const done = old.flush().catch(() => {})
			this.closing.set(id, done)
			done.then(() => {
				if (this.closing.get(id) === done) this.closing.delete(id)
			})
			return
		}
	}

	/** Log an update and fan it out to attached ports. */
	async #record(sessionId, update) {
		const log = await this.#logFor(sessionId)
		const seq = await log.append("update", { sessionId, update })
		this.#fanout(sessionId, { kind: "update", seq, params: { sessionId, update: { ...update, _meta: { ...(update._meta ?? {}), seq } } } })
		return seq
	}

	/**
	 * Send one logged event to every attached port. API-06: a port being replayed this conversation
	 * queues it; the replay sends the queue (seq > the replay's last event) when it is done.
	 */
	#fanout(sessionId, event) {
		for (const port of this.ports) {
			if (!port.attached.has(sessionId)) continue
			const queue = port.replaying?.get(sessionId)
			if (queue) queue.push(event)
			else this.#deliver(port, event)
		}
	}

	#deliver(port, event, replay = false) {
		const send =
			event.kind === "update"
				? port.sessionUpdate(replay ? { ...event.params, update: { ...event.params.update, _meta: { ...event.params.update._meta, replay: true } } } : event.params)
				: port.extNotification(event.kind === "child" ? "_gc/child_update" : "_gc/turn_end", replay ? { ...event.params, replay: true } : event.params)
		send?.catch?.(() => {})
	}

	#broadcastExt(sessionId, method, params) {
		for (const port of this.ports) {
			if (sessionId && !port.attached.has(sessionId)) continue
			port.extNotification(method, params).catch(() => {})
		}
	}

	async #replayTo(port, log, afterSeq) {
		const sessionId = log.meta.sessionId
		port.replaying ??= new Map()
		// A second replay of the same conversation on this port (two attaches) waits for the first
		while (port.replaying.has(sessionId)) await port.replaying.get(sessionId).done
		const queue = []
		let done
		queue.done = new Promise((resolve) => (done = resolve))
		port.replaying.set(sessionId, queue)
		try {
			const result = await log.replay(afterSeq, async (event) => {
				if (event.kind === "update") {
					await port
						.sessionUpdate({ sessionId: event.sessionId, update: { ...event.update, _meta: { ...(event.update?._meta ?? {}), seq: event.seq, replay: true } } })
						.catch(() => {})
				} else if (event.kind === "child") {
					const { seq: _s, ts: _t, kind: _k, ...frame } = event
					await port.extNotification("_gc/child_update", { ...frame, seq: event.seq, replay: true }).catch(() => {})
				} else if (event.kind === "turn_end") {
					// The live frame's shape ({sessionId, stopReason, _meta, seq}): the log record's ts/kind stay out, and
					// _meta is always an object (api 1/2 logged `_meta: null` for a plain end_turn)
					const { ts: _t, kind: _k, ...frame } = event
					await port.extNotification("_gc/turn_end", { ...frame, _meta: frame._meta ?? {}, replay: true }).catch(() => {})
				}
			})
			port.replaying.delete(sessionId)
			for (const event of queue) if (event.seq > result.until) this.#deliver(port, event)
			return result
		} finally {
			port.replaying.delete(sessionId)
			done()
		}
	}

	/** Re-issue the pending permission requests of a conversation to a port that attached. */
	#reissuePending(port, conv) {
		for (const pending of conv.pending.values()) this.#askPort(port, pending)
	}

	#askPort(port, pending) {
		port
			.requestPermission({
				sessionId: pending.sessionId,
				toolCall: pending.params.toolCall,
				options: pending.params.options,
				_meta: { reqId: pending.reqId, requestedAt: pending.requestedAt, childSessionId: pending.childSessionId },
			})
			.then((response) => {
				if (response?.outcome) this.answerPermission(pending.reqId, response.outcome, "user")
			})
			.catch(() => {
				// socket went away or answered late; the request stays pending for the others
			})
	}
}
