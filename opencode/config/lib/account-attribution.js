import crypto from "node:crypto"
import { rootResolver } from "./run-dir.js"
import { managedDenial, denialMessage } from "./managed-usage.js"

/** Native request identity: one UUID per transport attempt, one work segment per root prompt. */
export async function setup(ctx, { managedProviderID = "proxy", titleProviderID } = {}) {
	const { resolveRoot } = rootResolver(ctx)
	const work = new Map()
	const newWork = (id = crypto.randomUUID()) => ({ id, mainDenial: null, titleDenial: null })
	const stateFor = (root) => {
		if (!work.has(root)) work.set(root, newWork())
		return work.get(root)
	}
	await ctx.session.hook("prompt", async (e) => {
		const root = await resolveRoot(e.sessionID)
		if (root === e.sessionID) work.set(root, newWork(e.messageID || crypto.randomUUID()))
	})
	await ctx.session.hook("title", async (e) => {
		// This profile explicitly funds titles through the managed provider. The
		// pinned engine otherwise falls back to the conversation model on failure.
		// A stateless guard also covers late/concurrent title attempts. Native
		// profiles do not load this adapter; an independently native title setting
		// need not configure this managed-title guard.
		if (titleProviderID === managedProviderID && e.model.providerID !== titleProviderID) e.result = ""
	})
	await ctx.session.hook("http.request", async (e) => {
		if (e.model.providerID !== managedProviderID) return
		const root = await resolveRoot(e.sessionID), state = stateFor(root)
		// Only the native title kind is auxiliary. An agent name is not request scope.
		const denial = state.mainDenial || (e.kind === "title" ? state.titleDenial : null)
		if (denial) throw new Error(denialMessage(denial))
		const kind = e.kind === "title" ? "title" : e.agent === "preprocessing" ? "preprocessing" : e.kind === "primary" ? (root === e.sessionID ? "primary" : "delegate") : e.kind === "compaction" ? "compaction" : "unknown"
		const headers = new Headers(e.request.headers)
		for (const [key, value] of Object.entries({ "request-id": crypto.randomUUID(), "work-id": state.id, "conversation-id": root, agent: e.agent, kind })) headers.set(`x-geocluster-${key}`, value || "unknown")
		e.request = new Request(e.request, { headers })
	})
	await ctx.session.hook("http.response", async (e) => {
		if (e.model.providerID !== managedProviderID) return
		if (e.response.ok) return
		let value
		try { value = await e.response.clone().json() } catch { return }
		const denial = managedDenial(value)
		if (!denial) return
		const state = stateFor(await resolveRoot(e.sessionID))
		// Each scope ignores responses from earlier work; titles cannot pause main work.
		if (e.request.headers.get("x-geocluster-work-id") === state.id) state[e.kind === "title" ? "titleDenial" : "mainDenial"] = denial
		const headers = new Headers(e.response.headers)
		headers.delete("content-length"); headers.delete("content-encoding"); headers.set("content-type", "application/json")
		// The engine classifies 403 as authentication before ACP serialization, losing
		// the marker. This is a local adapter status; the backend refusal remains 403.
		e.response = new Response(JSON.stringify({ error: { code: denial.code, message: denialMessage(denial), retryable: false } }), { status: e.response.status === 403 ? 400 : e.response.status, headers })
	})
	// Native serialization may retain only a 503 and generic message. The observed managed response is decisive.
	await ctx.session.hook("retry", async (e) => {
		if (e.model.providerID !== managedProviderID) return
		// Native retry events have no request kind. A title latch must not disable
		// main supplier-capacity retry; title fallback is fenced by http.request.
		if (managedDenial(e.error) || stateFor(await resolveRoot(e.sessionID)).mainDenial) e.decision = { retry: false }
	})
}
