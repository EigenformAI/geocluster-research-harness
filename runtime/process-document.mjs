#!/usr/bin/env node
import { randomUUID } from "node:crypto"
import path from "node:path"
import { pathToFileURL } from "node:url"
import { createClient } from "../opencode/config/lib/processing-client.js"

const usage = "process-document submit PATH [--wait] | submit --request ID | status|wait|cancel|result --request ID|--job ID [result: --full-manifest --json] | list [--cursor CURSOR] | export --job ID --product ID --out PATH [--overwrite]"
const failure = (message) => Object.assign(new Error(message), { code: "INVALID_ARGUMENTS" })
export function parseDocumentArguments(args) {
	const [command, ...rest] = args
	if (command === "--help" || command === "-h" || command === "help") return { help: true }
	if (!["submit", "status", "wait", "cancel", "result", "list", "export", "read-table", "read-text"].includes(command)) throw failure(usage)
	const values = {}, positional = [], booleans = new Set(["wait", "json", "overwrite", "full-manifest"])
	const options = new Set(["request", "job", "product", "table", "out", "export-id", "snapshot", "expected-sha256", "profile", "table-recovery", "rerun-of", "timeout", "deadline", "offset", "limit", "cursor", ...booleans])
	for (let i = 0; i < rest.length; i++) {
		const arg = rest[i]
		if (!arg.startsWith("--")) { positional.push(arg); continue }
		const key = arg.slice(2)
		if (!options.has(key) || values[key] !== undefined) throw failure(`Unknown or repeated option ${arg}.`)
		if (booleans.has(key)) values[key] = true
		else { if (!rest[i + 1] || rest[i + 1].startsWith("--")) throw failure(`${arg} requires a value.`); values[key] = rest[++i] }
	}
	const allowed = {
		submit: ["request", "snapshot", "expected-sha256", "profile", "table-recovery", "rerun-of", "wait", "timeout", "deadline", "json"],
		status: ["request", "job", "json"], wait: ["request", "job", "timeout", "deadline", "json"], cancel: ["request", "job", "json"], result: ["request", "job", "offset", "limit", "full-manifest", "json"], list: ["offset", "limit", "cursor", "json"],
		export: ["request", "job", "product", "out", "overwrite", "export-id", "json"], "read-table": ["request", "job", "table", "offset", "limit", "json"], "read-text": ["request", "job", "product", "offset", "limit", "json"],
	}[command]
	if (Object.keys(values).some((key) => !allowed.includes(key)) || positional.length > (command === "submit" ? 1 : 0)) throw failure("Options do not apply to this command.")
	if (values["full-manifest"] && (values.offset !== undefined || values.limit !== undefined)) throw failure("--full-manifest cannot be combined with summary pagination.")
	if (values.timeout !== undefined && (!Number.isFinite(Number(values.timeout)) || Number(values.timeout) < 0)) throw failure("--timeout is a nonnegative number of observation seconds.")
	if (values.deadline !== undefined && !Number.isFinite(Date.parse(values.deadline))) throw failure("--deadline must be an ISO timestamp.")
	for (const key of ["offset", "limit"]) if (values[key] !== undefined && (!Number.isSafeInteger(Number(values[key])) || Number(values[key]) < (key === "limit" ? 1 : 0))) throw failure(`--${key} must be a valid integer.`)
	if (command === "submit") {
		if (values.request) { if (positional.length || Object.keys(values).some((key) => !["request", "wait", "timeout", "deadline", "json"].includes(key))) throw failure("Recovery uses --request with no new source/options.") }
		else if (Number(Boolean(positional.length)) + Number(Boolean(values.snapshot)) + Number(Boolean(values["rerun-of"] && !positional.length && !values.snapshot)) !== 1) throw failure("Submit requires a path, --snapshot, or --rerun-of.")
	} else if (command !== "list" && !values["export-id"] && Number(Boolean(values.request)) + Number(Boolean(values.job)) !== 1) throw failure("Supply exactly one of --request or --job.")
	if (command === "export") {
		if (values["export-id"]) { if (Object.keys(values).some((key) => !["export-id", "json"].includes(key))) throw failure("Export recovery accepts only --export-id.") }
		else if (!values.product || !values.out) throw failure("Export requires --product and --out; default publication is create-only.")
	}
	if (command === "read-table" && !values.table || command === "read-text" && !values.product) throw failure("Select --table or --product for this read.")
	let tableRecovery
	if (values["table-recovery"]) { try { tableRecovery = JSON.parse(values["table-recovery"]) } catch { throw failure("--table-recovery must be a JSON options object.") }; if (!tableRecovery || typeof tableRecovery !== "object" || Array.isArray(tableRecovery)) throw failure("--table-recovery must be a JSON options object.") }
	return { command, values, sourcePath: positional[0], tableRecovery }
}

export function documentExitCode(command, result) {
	if (result.operationOutcome === "rejected") return 1
	if (["wait", "submit-wait"].includes(command)) {
		const state = result.jobOutcome || result.state
		return state === "succeeded" ? 0 : state === "partial" ? 2 : ["failed", "cancelled", "interrupted"].includes(state) ? 1 : 3
	}
	if (["dispatch_unknown", "cancel_pending", "pending"].includes(result.operationOutcome)) return 3
	return result.operationOutcome === "rejected" ? 1 : 0
}

export async function runDocumentCLI(args, { env = process.env, client, output = (value) => console.log(value), progress = (value) => console.error(value), signal } = {}) {
	let handle = {}, options
	try {
		options = parseDocumentArguments(args)
		if (options.help) { output(usage); return 0 }
		const { command, values } = options, projectId = env.PROJECT_ID || "default"
		if (!/^[A-Za-z0-9_.:-]{1,128}$/.test(projectId) || [".", "..", ".runtime", ".ide-state"].includes(projectId)) throw failure("Invalid selected project ID.")
		const selected = client || createClient({ mode: "native", clientDir: env.GEOCLUSTER_PROCESSING_CLIENT_DIR || path.join("/workspace/.runtime/native/processing", projectId, "client") })
		const caller = { origin: "operator", sessionId: `cli-${randomUUID()}` }
		const capability = await selected.request({ action: "capabilities", scope: null, caller, input: {} }, { signal })
		const scope = capability.scope
		const request = async (action, input, observe = false) => (await selected.request({ action, scope, caller, input }, observe ? { signal } : {})).result
		const print = (value) => output(JSON.stringify(value, null, values.json ? 0 : 2))
		const input = { ...(values.request ? { requestId: values.request } : {}), ...(values.job ? { jobId: values.job } : {}), ...(values.offset !== undefined ? { offset: Number(values.offset) } : {}), ...(values.limit !== undefined ? { limit: Number(values.limit) } : {}) }
		handle = { ...input }; let result
		if (command === "submit") {
			if (!values.request) {
				const intent = { ...(options.sourcePath ? { path: options.sourcePath } : {}), ...(values.snapshot ? { snapshotId: values.snapshot } : {}), ...(values["expected-sha256"] ? { expectedSha256: values["expected-sha256"] } : {}), ...(values.profile ? { profileId: values.profile } : {}), ...(options.tableRecovery ? { tableRecovery: options.tableRecovery } : {}), ...(values["rerun-of"] ? { rerunOf: values["rerun-of"] } : {}) }
				const prepared = await request("submit", { ...intent, prepareOnly: true })
				handle = { requestId: prepared.requestId }
				progress(JSON.stringify({ ...handle, operationOutcome: "prepared", continuation: `submit --request ${prepared.requestId}` }))
			} else progress(JSON.stringify({ ...handle, operationOutcome: "recovering" }))
			signal?.throwIfAborted()
			result = await request("submit", handle)
		} else {
			const action = { list: "history", export: "exportProduct", "read-table": "readTable", "read-text": "readText" }[command] || command
			if (values.product) input.productId = values.product
			if (values.table) input.tableId = values.table
			if (values.out) input.out = values.out
			if (values.overwrite) input.overwrite = true
			if (values["export-id"]) input.exportId = values["export-id"]
			if (values["full-manifest"]) input.fullManifest = true
			if (values.cursor) input.cursor = values.cursor
			if (command !== "wait") result = await request(action, input)
		}
		if (command === "wait" || command === "submit" && values.wait && !["dispatch_unknown", "rejected", "cancel_pending"].includes(result.operationOutcome)) {
			if (result?.requestId) handle = { requestId: result.requestId }
			const deadline = values.deadline ? Date.parse(values.deadline) : Date.now() + Number(values.timeout ?? 300) * 1000
			for (;;) {
				if (signal?.aborted) throw signal.reason || Object.assign(new Error("Observation interrupted."), { name: "AbortError" })
				result = await request("wait", { ...handle, timeoutMs: Math.max(0, Math.min(20000, deadline - Date.now())) }, true)
				if (["succeeded", "partial", "failed", "cancelled", "interrupted"].includes(result.jobOutcome || result.state) || Date.now() >= deadline) break
			}
		}
		result = { operationOutcome: result.operationOutcome || "succeeded", jobOutcome: result.jobOutcome || result.outcome || null, ...result }
		print(result)
		return documentExitCode(command === "submit" && values.wait ? "submit-wait" : command, result)
	} catch (error) {
		const pending = signal?.aborted || ["PROCESSING_TIMEOUT", "OWNER_CHANGED", "RESULT_NOT_AVAILABLE", "CANCEL_PENDING", "DISPATCH_UNKNOWN"].includes(error.code)
		output(JSON.stringify({ operationOutcome: pending ? "pending" : "failed", jobOutcome: null, ...handle, ...(error.requestId ? { requestId: error.requestId } : {}), ...(error.exportId ? { exportId: error.exportId } : {}), error: { code: error.code || (signal?.aborted ? "OBSERVATION_INTERRUPTED" : "PROCESSING_FAILED"), message: error.message, ...(error.action ? { action: error.action } : {}) } }))
		return pending ? 3 : 1
	}
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
	const controller = new AbortController()
	process.once("SIGINT", () => controller.abort())
	process.exitCode = await runDocumentCLI(process.argv.slice(2), { signal: controller.signal })
}
