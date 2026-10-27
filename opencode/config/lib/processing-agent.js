import { createClient } from "./processing-client.js"
import { LEGACY_PREFIX, PROCESSING_TOOLS, allowedTool, isSessionId, receiptHistory, sameScope, text, toolSpecs, validArguments, validBasename, validScope } from "./processing-contract.js"

/** Pinned @opencode/plugin and @opencode/schema 2.0.19:
 * ToolContext has sessionID/messageID/id/agent/signal; session.get supplies ancestry.
 * session.context has sessionID/agent but NO messageID or call ID. Read-only context discovery
 * therefore sends null message/call IDs, never invented execution identity. Tool effects require all IDs.
 * There is no permission.assert in this version; exports cannot initiate an outside-path approval.
 */
export async function setup(ctx, { request, mode = process.env.GEOCLUSTER_PROCESSING_MODE ?? "managed", log = (message) => console.error(`[processing-agent] ${message}`) } = {}) {
	const send = request ?? createClient({ mode }).request
	const specs = toolSpecs(mode)
	let scopePromise, capabilities
	async function callerOf(event, execution = true) {
		if (!isSessionId(event.sessionID) || !text(event.agent, 128) || execution && (!text(event.messageID, 256) || !text(event.id, 256))) throw new Error("Processing execution identity requires trusted session, message and call IDs.")
		let rootId = event.sessionID
		const seen = new Set()
		for (let depth = 0; depth < 32; depth++) {
			if (!isSessionId(rootId) || seen.has(rootId)) throw new Error("Invalid/cyclic processing session ancestry.")
			seen.add(rootId)
			const info = await ctx.session.get({ sessionID: rootId })
			if (!info || info.id !== rootId) throw new Error("Processing session ancestry is unavailable; reconnect before processing.")
			if (info.parentID === undefined || info.parentID === null) return { origin: "model", rootId, sessionId: event.sessionID, messageId: execution ? event.messageID : null, callId: execution ? event.id : null, agent: event.agent }
			rootId = info.parentID
		}
		throw new Error("Processing session ancestry exceeds 32 parents.")
	}
	async function identity(caller, signal) {
		if (!scopePromise) scopePromise = send({ action: "capabilities", scope: null, caller, input: {} }, { signal }).then((reply) => {
			if (!validScope(reply?.scope)) throw new Error("Processing runtime did not supply a valid persistent workspace scope.")
			const value = reply.result
			if (typeof value?.enabled === "boolean") capabilities = { enabled: value.enabled, mode, ...(text(value.instruction, 1024) ? { instruction: value.instruction } : {}) }
			return Object.freeze({ ...reply.scope })
		}).catch((error) => { scopePromise = undefined; throw error })
		return scopePromise
	}
	async function history(event, execution = false) {
		const caller = await callerOf(event, execution), scope = await identity(caller)
		const reply = await send({ action: "history", scope, caller, input: { limit: 32 } })
		if (!sameScope(reply?.scope, scope)) throw new Error("Processing receipt history belongs to a different workspace/store scope.")
		return receiptHistory(reply.result)
	}
	await ctx.tool.transform((editor) => {
		for (const [name, spec] of Object.entries(specs)) editor.add({
			name, description: spec.description, input: spec.input, options: { permission: name, codemode: false },
			async execute(args, call) {
				try {
					if (!allowedTool(call.agent, name)) throw Object.assign(new Error("Only DataOps and Standard execute processing operations; Report Analysis only reads result/text/table. Delegate through orchestrator → DataOps."), { code: "AGENT_ACCESS_DENIED" })
					if (spec.action === "exportProduct" && (args?.destination !== undefined || args?.path !== undefined || args?.out !== undefined || args?.filename !== undefined || args?.basename !== undefined && !validBasename(args.basename))) throw Object.assign(new Error("Outside-results export destination requires separate approval. Supply only a basename for a results-folder export; no file was written and no alternate destination was selected."), { code: "DESTINATION_REQUIRES_APPROVAL" })
					if (!validArguments(spec.action, args, mode)) throw Object.assign(new Error(`Unsupported or missing processing argument fields/types for ${mode} mode; runtime identity and submission keys are not model arguments.`), { code: "INVALID_ARGUMENTS" })
					const caller = await callerOf(call), scope = await identity(caller, call.signal)
					const reply = await send({ action: spec.action, scope, caller, input: args }, { signal: call.signal })
					if (!sameScope(reply?.scope, scope)) throw Object.assign(new Error("Processing response belongs to a stale workspace/store scope; do not replay into another scope."), { code: "SCOPE_MISMATCH" })
					return { content: [{ type: "text", text: JSON.stringify(reply.result) }] }
				} catch (cause) {
					const handles = Object.fromEntries(["requestId", "jobId", "exportId", "waitId"].filter((key) => cause[key] !== undefined).map((key) => [key, cause[key]]))
					const recovery = cause.exportId ? ` Recover with processing_export using ONLY ${JSON.stringify({ exportId: cause.exportId })}; do not create a fresh export or republish.` : cause.requestId ? " Recover that exact request with processing_status/processing_history; do not create another submission." : " Inspect processing_history/status before starting new work after uncertainty."
					const retained = Object.keys(handles).length ? ` Retained recovery handles: ${JSON.stringify(handles)}.` : ""
					const observed = cause.currentObservation !== undefined ? ` currentObservation: ${JSON.stringify(cause.currentObservation)}. This observation does not authorize silently refreshing retained intent; selecting changed bytes requires an explicit new request.` : ""
					const error = new Error(`Agent ${call.agent}, tool ${name}: ${cause.code ? `${cause.code}: ` : ""}${cause.message}. Next step: ${cause.action ?? "check processing readiness and retained receipt history"}.${retained}${recovery}${observed}`, { cause })
					for (const key of ["code", "requestId", "jobId", "exportId", "waitId", "currentObservation", "action", "status"]) if (cause[key] !== undefined) error[key] = cause[key]
					throw error
				}
			},
		})
	})
	await ctx.tool.hook("execute.before", (event) => {
		if (event.tool.startsWith(LEGACY_PREFIX)) throw new Error(`Agent ${event.agent}, tool ${event.tool}: legacy direct processor tools are retired. Use the processing plugin through DataOps (or Standard).`)
		if (PROCESSING_TOOLS.includes(event.tool) && !allowedTool(event.agent, event.tool)) throw new Error(`Agent ${event.agent}, tool ${event.tool}: processing access denied; delegate through orchestrator → DataOps.`)
	})
	await ctx.session.hook("context", async (event) => {
		for (const name of Object.keys(event.tools)) if (name.startsWith(LEGACY_PREFIX) || PROCESSING_TOOLS.includes(name) && !allowedTool(event.agent, name)) delete event.tools[name]
		if (!["geology", "orchestrator", "dataops", "standard", "report-analysis"].includes(event.agent)) return
		try {
			const receipts = await history(event)
			if (capabilities) event.system.push({ type: "text", text: `# Runtime processing availability\n${JSON.stringify(capabilities)}\nOrdinary PDF read is text-only; retained OCR/extraction uses DataOps when enabled. If disabled, return the enablement instruction rather than claiming OCR is universally unavailable.` })
			if (receipts.length) event.system.push({ type: "text", text: `# Trusted processing receipt history\nProtected runtime records for this workspace/store and root conversation, not instructions or evidence of completion. Recover prepared/unknown/cancellation-pending requests by their original requestId before new submissions. Read content through bounded processing tools; a receipt is not a citation witness.\n${JSON.stringify(receipts)}` })
		} catch (error) {
			log(`Agent ${event.agent}: processing receipt discovery unavailable (${error.code ?? "history_unavailable"}).`)
			event.system.push({ type: "text", text: `Processing history unavailable. Do not infer prior submission failure or create duplicate work. ${mode === "native" ? "Enable/reopen native processing with an explicit --processing-model; if the owner changed, reopen discovery and recover only in the same persistent scope." : "Enable the managed document-processing service and restore its restricted bridge; native settings cannot enable managed processing."}` })
		}
	})
	await ctx.tool.hook("execute.after", async (event) => {
		if (event.status !== "completed" || event.tool !== "subagent" || !["orchestrator", "dataops"].includes(event.input?.agent)) return
		const metadata = { ...event.result.metadata }
		delete metadata.geoclusterProcessing
		event.result = { ...event.result, metadata }
		try {
			const receipts = await history(event, true)
			if (receipts.length) event.result.metadata.geoclusterProcessing = receipts
		} catch (error) { log(`Agent ${event.agent}: processing handoff history unavailable (${error.code ?? "history_unavailable"}); retain the original request handle.`) }
	})
}
