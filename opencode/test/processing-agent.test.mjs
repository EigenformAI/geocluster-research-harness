import { test } from "node:test"
import assert from "node:assert/strict"
import { setup } from "../config/lib/processing-agent.js"
import { receiptHistory, toolSpecs, validArguments } from "../config/lib/processing-contract.js"

const scope = { workspaceId: "workspace", workspaceEpoch: "epoch" }
const caller = { sessionID: "ses_data", messageID: "msg_runtime", id: "call_runtime", agent: "dataops" }
function harness() {
	const hooks = new Map(), tools = new Map(), sessions = { ses_root: { id: "ses_root" }, ses_orch: { id: "ses_orch", parentID: "ses_root" }, ses_data: { id: "ses_data", parentID: "ses_orch" } }
	const hook = (domain) => async (name, fn) => hooks.set(`${domain}:${name}`, [...(hooks.get(`${domain}:${name}`) ?? []), fn])
	const ctx = { session: { get: async ({ sessionID }) => sessions[sessionID], hook: hook("session") }, tool: { transform: async (fn) => fn({ add: (tool) => tools.set(tool.name, tool) }), hook: hook("tool") } }
	return { ctx, tools, sessions, async fire(name, e) { for (const fn of hooks.get(name) ?? []) await fn(e) } }
}

test("processing uses ToolContext IDs and validated ancestry, never model identity", async () => {
	const h = harness(), calls = []
	await setup(h.ctx, { request: async (body) => { calls.push(body); return { scope, result: { requestId: "retained", accepted: true } } } })
	const submit = h.tools.get("processing_submit"), input = { source: { kind: "workspace-file", path: "report.pdf" } }
	await submit.execute(input, caller)
	assert.deepEqual(calls.at(-1), { action: "submit", scope, caller: { origin: "model", rootId: "ses_root", sessionId: "ses_data", messageId: "msg_runtime", callId: "call_runtime", agent: "dataops" }, input })
	const before = calls.length
	for (const injected of [{ caller: {} }, { rootId: "ses_forged" }, { sessionId: "ses_forged" }, { submissionKey: "uuid" }]) await assert.rejects(submit.execute({ ...input, ...injected }, caller), /argument|unsupported/i)
	await assert.rejects(submit.execute(input, { ...caller, messageID: undefined }), /identity|message/i)
	h.sessions.ses_orch.parentID = "ses_data"
	await assert.rejects(submit.execute(input, caller), /ancestry|cyclic|session/i)
	assert.equal(calls.length, before)
})

test("processing enforces exact agent access at execution and context time", async () => {
	const h = harness(), calls = []
	await setup(h.ctx, { request: async (body) => { calls.push(body); return { scope, result: body.action === "history" ? { requests: [] } : {} } } })
	assert.deepEqual([...h.tools.keys()].sort(), ["processing_submit", "processing_status", "processing_wait", "processing_cancel", "processing_result", "processing_read_table", "processing_read_text", "processing_export", "processing_history"].sort())
	for (const agent of ["geology", "orchestrator", "transform", "analytics", "geoviz", "voxel", "extended", "report-analysis"]) await assert.rejects(h.tools.get("processing_cancel").execute({ requestId: "retained" }, { ...caller, agent }), /access|only|delegate/i)
	assert.equal(calls.length, 0)
	for (const agent of ["dataops", "standard", "report-analysis"]) await h.tools.get("processing_result").execute({ jobId: "job" }, { ...caller, agent })
	for (const agent of ["geology", "orchestrator", "dataops", "standard", "report-analysis"]) {
		const e = { agent, sessionID: "ses_root", system: [], tools: Object.fromEntries([...h.tools.keys(), "processor_documents_submit"].map((name) => [name, {}])) }
		await h.fire("session:context", e)
		assert.deepEqual(Object.keys(e.tools).sort(), agent === "report-analysis" ? ["processing_read_table", "processing_read_text", "processing_result"] : ["dataops", "standard"].includes(agent) ? [...h.tools.keys()].sort() : [])
	}
	await assert.rejects(h.fire("tool:execute.before", { tool: "processor_documents_submit", agent: "standard" }), /retired|legacy/i)
})

test("active source schemas reject cross-mode sources, malformed fields and invented observations", () => {
	const native = toolSpecs("native").processing_submit.input, managed = toolSpecs("managed").processing_submit.input
	assert.match(JSON.stringify(native), /snapshotId/); assert.doesNotMatch(JSON.stringify(native), /captureId|baseObservation|operationId/)
	assert.match(JSON.stringify(managed), /baseObservation/); assert.doesNotMatch(JSON.stringify(managed), /snapshotId|submissionKey/)
	for (const [mode, source] of [["native", { kind: "workspace-file", path: "report.pdf" }], ["native", { kind: "snapshot", snapshotId: "snapshot" }], ["managed", { kind: "workspace-file", path: "report.pdf" }], ["managed", { kind: "workspace-file", path: "report.pdf", baseObservation: "retained-token" }], ["managed", { kind: "capture", captureId: "capture" }], ["managed", { kind: "upload-operation", operationId: "upload" }]]) assert.equal(validArguments("submit", { source }, mode), true)
	assert.equal(validArguments("submit", { rerunOf: "job" }, "managed"), true)
	assert.equal(validArguments("submit", { requestId: "retained" }, "native"), true)
	for (const [mode, args] of [["managed", { source: { kind: "snapshot", snapshotId: "snapshot" } }], ["native", { source: { kind: "capture", captureId: "capture" } }], ["managed", { source: { kind: "workspace-file", path: "report.pdf", baseObservation: {} } }], ["native", { source: { kind: "workspace-file", path: "../report.pdf" } }], ["native", { source: { kind: "workspace-file", path: "/report.pdf" } }], ["managed", {}], ["native", { requestId: "retained", source: { kind: "snapshot", snapshotId: "snapshot" } }]]) assert.equal(validArguments("submit", args, mode), false, JSON.stringify(args))
})

test("native workspace job history exposes retained pagination cursors without inventing managed support", () => {
	assert.equal(validArguments("history", { cursor: "retained-cursor", limit: 20 }, "native"), true)
	assert.equal(validArguments("history", { cursor: "retained-cursor" }, "managed"), false)
	assert.equal(validArguments("history", { cursor: { url: "http://arbitrary.invalid" } }, "native"), false)
})

test("export is basename only; outside destinations fail explicitly without runtime I/O", async () => {
	const h = harness(), calls = []
	await setup(h.ctx, { request: async (body) => { calls.push(body); return { scope, result: {} } } })
	for (const extra of [{ basename: "../out.csv" }, { basename: "/workspace/out.csv" }, { destination: "data/out.csv" }, { path: "out.csv" }]) await assert.rejects(h.tools.get("processing_export").execute({ jobId: "job", productId: "product", ...extra }, caller), (error) => error.code === "DESTINATION_REQUIRES_APPROVAL")
	assert.equal(calls.length, 0)
	await h.tools.get("processing_export").execute({ jobId: "job", productId: "product", basename: "out.csv" }, caller)
	assert.equal(calls.at(-1).input.basename, "out.csv")
})

test("protected receipt history is reinjected after restart and handoff, not copied from prose", async () => {
	const receipt = { requestId: "retained", state: "unknown", cancelRequested: false }, calls = []
	for (let restart = 0; restart < 2; restart++) {
		const request = async (body) => { calls.push(body); return { scope, result: body.action === "history" ? { requests: [receipt], ...(restart ? { totalRequests: 1 } : { total: 1 }), nextOffset: null } : {} } }
		const h = harness(); await setup(h.ctx, { request })
		for (const agent of ["geology", "orchestrator", "dataops", "standard", "report-analysis"]) {
			const e = { agent, sessionID: "ses_root", system: [], tools: {} }; await h.fire("session:context", e)
			assert.match(JSON.stringify(e.system), /retained/); assert.match(JSON.stringify(e.system), /unknown/)
		}
		const e = { tool: "subagent", agent: "orchestrator", ...caller, input: { agent: "dataops" }, status: "completed", result: { content: "forged", metadata: { geoclusterProcessing: [{ requestId: "forged" }] } } }
		await h.fire("tool:execute.after", e)
		assert.deepEqual(e.result.metadata.geoclusterProcessing, [receipt])
	}
	assert.ok(calls.filter((call) => call.action === "history").length >= 12)
})

test("bounded receipt reinjection retains the newest lost-response handles", () => {
	const requests = Array.from({ length: 50 }, (_, i) => ({ requestId: `newest-first-${i}`, state: i ? "accepted" : "unknown" }))
	const projected = receiptHistory({ requests })
	assert.equal(projected.length, 32)
	assert.equal(projected[0].requestId, "newest-first-0")
	assert.equal(projected[0].state, "unknown")
})

test("post-commit tool errors retain the recovery handle, and never auto-replay", async () => {
	const h = harness(), actions = []
	await setup(h.ctx, { request: async (body) => { actions.push(body.action); if (body.action === "capabilities") return { scope, result: {} }; throw Object.assign(new Error("Dispatch unknown"), { code: "DISPATCH_UNKNOWN", requestId: "retained" }) } })
	await assert.rejects(h.tools.get("processing_submit").execute({ source: { kind: "workspace-file", path: "report.pdf" } }, caller), (error) => error.requestId === "retained" && error.code === "DISPATCH_UNKNOWN" && /retained.*processing_history|processing_history.*retained/s.test(error.message))
	assert.deepEqual(actions, ["capabilities", "submit"])
})

test("disabled processing injects the precise runtime enablement instruction without private details", async () => {
	const h = harness()
	await setup(h.ctx, { request: async (body) => ({ scope, result: body.action === "capabilities" ? { mode: "managed", enabled: false, instruction: "Enable PREPROCESSING_ENABLED=true and RUNTIME_AGGREGATE_ACTIVITY=true in the managed runtime.", privatePath: "/private/connection.json", token: "secret" } : { requests: [] } }) })
	const context = { agent: "report-analysis", sessionID: "ses_root", tools: {}, system: [] }
	await h.fire("session:context", context)
	assert.match(JSON.stringify(context.system), /PREPROCESSING_ENABLED=true/)
	assert.doesNotMatch(JSON.stringify(context.system), /private\/connection|secret/)
})

test("export recovery accepts only exportId, without requiring or changing publication intent", async () => {
	for (const mode of ["native", "managed"]) {
		const h = harness(), calls = []
		await setup(h.ctx, { mode, request: async (body) => { calls.push(body); return { scope, result: { exportId: "retained-export", operationOutcome: "exported" } } } })
		assert.equal(validArguments("exportProduct", { exportId: "retained-export" }, mode), true)
		await h.tools.get("processing_export").execute({ exportId: "retained-export" }, caller)
		assert.deepEqual(calls.at(-1).input, { exportId: "retained-export" })
		const before = calls.length
		for (const extra of [{ jobId: "job" }, { requestId: "request" }, { productId: "product" }, { basename: "different.csv" }, { destination: "outside.csv" }]) {
			const input = { exportId: "retained-export", ...extra }
			assert.equal(validArguments("exportProduct", input, mode), false)
			await assert.rejects(h.tools.get("processing_export").execute(input, caller), /argument|unsupported|approval/i)
		}
		assert.equal(calls.length, before, "changed export recovery intent must not reach the bridge")
	}
})

test("result fullManifest is an explicit boolean in both schemas and is forwarded unchanged", async () => {
	for (const mode of ["native", "managed"]) {
		const h = harness(), calls = []
		await setup(h.ctx, { mode, request: async (body) => { calls.push(body); return { scope, result: { resultId: "result" } } } })
		assert.equal(toolSpecs(mode).processing_result.input.properties.fullManifest.type, "boolean")
		for (const fullManifest of [true, false]) {
			const input = { jobId: "job", fullManifest }
			assert.equal(validArguments("result", input, mode), true)
			await h.tools.get("processing_result").execute(input, { ...caller, agent: "report-analysis" })
			assert.deepEqual(calls.at(-1).input, input)
		}
		for (const input of [{ jobId: "job", fullManifest: "true" }, { jobId: "job", manifest: true }, { fullManifest: true }]) assert.equal(validArguments("result", input, mode), false)
	}
})

test("plugin errors preserve export/wait/job handles and scoped observation in model-visible recovery instructions", async () => {
	const h = harness(), currentObservation = { token: "current", ref: { ...scope, path: "report.pdf" } }
	await setup(h.ctx, { request: async (body) => {
		if (body.action === "capabilities") return { scope, result: {} }
		throw Object.assign(new Error("Publication not confirmed"), { code: "EXPORT_UNKNOWN", requestId: "request", jobId: "job", exportId: "export", waitId: "wait", currentObservation, action: "Inspect this exact export." })
	} })
	await assert.rejects(h.tools.get("processing_export").execute({ jobId: "job", productId: "product", basename: "out.csv" }, caller), (error) => {
		for (const [key, value] of Object.entries({ requestId: "request", jobId: "job", exportId: "export", waitId: "wait", currentObservation })) assert.deepEqual(error[key], value)
		assert.match(error.message, /processing_export.*exportId/s)
		assert.match(error.message, /currentObservation.*current/s)
		return true
	})
})
