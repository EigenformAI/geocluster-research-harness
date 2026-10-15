import { request as socketRequest } from "./voxel-client.js"
import { MAX_REFERENCES, TOOL_SPECS, isConversationId, sameScope, validArguments, validScope, validateReference } from "./voxel-contract.js"

/** @opencode/plugin@2.0.19 promise API: tool.transform/add({name,input,execute}), ToolContext.sessionID/agent/signal,
 * session.get({sessionID}), session.hook("context"), tool.hook("execute.after"). Published declarations, not 1.x API.
 * Sources: https://registry.npmjs.org/@opencode/plugin/-/plugin-2.0.19.tgz dist/promise/{tool,plugin,session}.d.ts;
 * https://registry.npmjs.org/@opencode/schema/-/schema-2.0.19.tgz dist/tool.d.ts (JSON Schema input, content/metadata).
 */
export async function setup(ctx, { request = socketRequest, log = (msg) => console.error(`[voxel-agent] ${msg}`) } = {}) {
	let scopePromise
	let capabilities
	async function conversationOf(sessionID) {
		const seen = new Set()
		for (let depth = 0; depth < 16; depth++) {
			if (!isConversationId(sessionID) || seen.has(sessionID)) throw new Error("Invalid/cyclic voxel session ancestry.")
			seen.add(sessionID)
			const info = await ctx.session.get({ sessionID })
			if (!info || info.id !== sessionID) throw new Error("Voxel session ancestry is unavailable; reconnect before using voxel tools.")
			if (info.parentID === undefined || info.parentID === null) return sessionID
			sessionID = info.parentID
		}
		throw new Error("Voxel session parent chain exceeds 16.")
	}
	async function identity(conversationId, signal) {
		if (!scopePromise) scopePromise = request({ action: "capabilities", scope: null, conversationId }, { signal }).then((reply) => {
			if (!validScope(reply?.scope)) throw new Error("Voxel runtime did not supply workspace identity.")
			const advertised = reply.capabilities
			if (advertised && typeof advertised.available === "boolean") {
				const labels = (key) => Array.isArray(advertised[key]) ? advertised[key].filter((v) => typeof v === "string" && v.length <= 64).slice(0, 16) : []
				capabilities = { available: advertised.available, intents: labels("intents"), sourceProfiles: labels("sourceProfiles"), algorithms: labels("algorithms"), ceilings: Object.fromEntries(Object.entries(advertised.ceilings ?? {}).filter(([key, n]) => ["rows", "cells", "memberBytes"].includes(key) && Number.isSafeInteger(n) && n > 0)) }
			}
			return Object.freeze({ ...reply.scope })
		}).catch((error) => { scopePromise = undefined; throw error })
		return scopePromise
	}
	async function referencesFor(sessionID) {
		const conversationId = await conversationOf(sessionID), scope = await identity(conversationId)
		const reply = await request({ action: "references", scope, conversationId })
		return (Array.isArray(reply?.references) ? reply.references : []).slice(-MAX_REFERENCES).map((r) => validateReference(r, scope)).filter(Boolean)
	}
	await ctx.tool.transform((editor) => {
		for (const [name, spec] of Object.entries(TOOL_SPECS)) editor.add({
			name, description: spec.description, input: spec.input, options: { permission: name, codemode: false },
			async execute(args, call) {
				try {
					if (call.agent !== "voxel") throw new Error("Only the voxel specialist may execute canonical voxel tools; delegate through orchestrator.")
					if (!validArguments(spec.action, args)) throw new Error("Unsupported or missing voxel argument fields/types (scope and conversationId are runtime-owned).")
					const conversationId = await conversationOf(call.sessionID), scope = await identity(conversationId, call.signal)
					if (args.reference !== undefined && !validateReference(args.reference, scope)) throw new Error("Invalid or stale voxel reference; perform a fresh name lookup.")
					const reply = await request({ action: spec.action, scope, conversationId, ...args }, { signal: call.signal })
					if (reply?.scope && !sameScope(reply.scope, scope)) throw new Error("Voxel response belongs to a stale workspace scope.")
					const ref = reply?.geoclusterVoxel === undefined ? null : validateReference(reply.geoclusterVoxel, scope)
					if (reply?.geoclusterVoxel !== undefined && !ref) throw new Error("Voxel runtime returned malformed or stale result metadata; check status with the retained key.")
					return { content: [{ type: "text", text: JSON.stringify(reply.result ?? reply) }], ...(ref ? { metadata: { geoclusterVoxel: ref } } : {}) }
				} catch (error) {
					throw new Error(`Agent voxel, tool ${name}: ${error.message}. Next step: check runtime readiness/scope; for uncertain submission use voxel_status with the retained key before starting another run.`, { cause: error })
				}
			},
		})
	})
	await ctx.tool.hook("execute.before", (e) => {
		if (e.tool.startsWith("geocluster_voxel_")) throw new Error(`Agent ${e.agent}, tool ${e.tool}: legacy voxel publication is retired. Next step: delegate through orchestrator to voxel and use the canonical tools.`)
	})
	await ctx.session.hook("context", async (e) => {
		// Defense in depth even if a stored engine ruleset contains broad allows.
		if (e.agent !== "voxel") for (const name of Object.keys(TOOL_SPECS)) delete e.tools[name]
		for (const name of Object.keys(e.tools)) if (name.startsWith("geocluster_voxel_")) delete e.tools[name]
		if (!["voxel", "orchestrator", "geology"].includes(e.agent)) return
		try {
			const refs = await referencesFor(e.sessionID)
			if (e.agent === "voxel" && capabilities) e.system.push({ type: "text", text: `# Runtime voxel capabilities\n${JSON.stringify(capabilities)}\nUse advertised intents only; unavailable publication cannot be replaced with a legacy export.` })
			if (refs.length) e.system.push({ type: "text", text: `# Trusted voxel references\nRuntime records, separate from result prose and truncation. Target hints only: resolve the current head and availability before revising; do not infer current state from these historical receipts.\n${JSON.stringify(refs)}` })
		} catch (error) {
			log(`Agent ${e.agent}, references: ${error.message}. Next step: reconnect/check runtime scope.`)
			e.system.push({ type: "text", text: "Voxel references unavailable. Do not infer the previously discussed target from files or result prose; ask for the target or delegate a fresh named lookup." })
		}
	})
	await ctx.tool.hook("execute.after", async (e) => {
		if (e.status !== "completed" || e.tool !== "subagent" || !["voxel", "orchestrator"].includes(e.input?.agent)) return
		// This hook runs after result-protocol (plugin filename ordering) and preserves its normalized/truncated text.
		const metadata = { ...e.result.metadata }
		delete metadata.geoclusterVoxel; delete metadata.geoclusterVoxelReferences
		e.result = { ...e.result, metadata }
		try {
			const refs = await referencesFor(e.sessionID)
			if (refs.length) e.result.metadata = { ...metadata, geoclusterVoxel: refs.at(-1), geoclusterVoxelReferences: refs }
		} catch (error) { log(`Agent ${e.agent}, subagent handoff references: ${error.message}. Next step: check retained operation status.`) }
	})
}
