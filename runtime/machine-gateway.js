#!/usr/bin/env node
/** Root-only credential renewal and streaming service forwarding on loopback. */
import fs from "node:fs/promises"
import http from "node:http"
import https from "node:https"
import crypto from "node:crypto"
import { pathToFileURL } from "node:url"
import { loadConfig } from "./lib/config.js"
import { MachineCredentials, serviceUrl } from "./lib/machine-credentials.js"
import { createLogger } from "./lib/log.js"
import { denialFor } from "../opencode/config/lib/managed-usage.js"

function failure(res, status, error) {
	res.writeHead(status, { "content-type": "application/json", "cache-control": "no-store" })
	res.end(JSON.stringify({ error, agent: "machine-gateway", tool: "service-forwarder", action: "Inspect machine credential renewal and service endpoint logs, then retry." }))
}

function modelFailure(res, status, code) {
	const denial = denialFor(code)
	res.writeHead(status, { "content-type": "application/json", "cache-control": "no-store" })
	res.end(JSON.stringify({ error: { code, message: denial.message, retryable: false } }))
}

function forwardingHeaders(headers, token) {
	const out = { ...headers }
	const hop = String(headers.connection || "").split(",").map((name) => name.trim().toLowerCase())
	for (const name of [...hop, "connection", "host", "cookie", "authorization", "proxy-authorization", "proxy-authenticate", "keep-alive", "upgrade", "te", "trailer", "transfer-encoding", "x-gc-files-control"]) delete out[name]
	if (token) out.authorization = `Bearer ${token}`
	return out
}

const ATTRIBUTION = ["request-id", "work-id", "conversation-id", "agent", "kind"].map((key) => `x-geocluster-${key}`)
function llmHeaders(headers, token) {
	const out = forwardingHeaders(headers, token)
	// Account/project/runtime are resolved from the purpose credential, never header claims.
	for (const key of Object.keys(out)) if (key.startsWith("x-geocluster-") && !ATTRIBUTION.includes(key)) delete out[key]
	return out
}
function modelHeaders(headers, token, preprocessing) {
	const out = llmHeaders(headers, token)
	if (!/^[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/i.test(out["x-geocluster-request-id"] || "")) out["x-geocluster-request-id"] = crypto.randomUUID()
	for (const key of ATTRIBUTION.slice(1)) if (typeof out[key] !== "string" || !/^[A-Za-z0-9_.:-]{1,128}$/.test(out[key])) out[key] = "unknown"
	if (preprocessing) out["x-geocluster-kind"] = "preprocessing"
	else if (!["primary", "title", "delegate", "compaction", "preprocessing"].includes(out["x-geocluster-kind"])) out["x-geocluster-kind"] = "unknown"
	return out
}

export async function createMachineGateway({ config, logger = console, renewalOptions, initialCredentials }) {
	const llm = config.llmProxyUrl ? serviceUrl(config.llmProxyUrl, "llm_proxy_url") : null
	const activity = config.activityUrl ? serviceUrl(config.activityUrl, "activity_url") : null
	const files = config.filesUrl ? serviceUrl(config.filesUrl, "files_url") : null
	const work = config.fileWorkUrl ? serviceUrl(config.fileWorkUrl, "file_work_url") : null
	const secret = config.filesControlSecret || (config.filesControlFile ? (await fs.readFile(config.filesControlFile, "utf8")).trim() : "")
	if ((files || work) && !/^[0-9a-f]{64}$/.test(secret)) throw new Error("private_file_channel_required")
	const credentials = new MachineCredentials(config, logger, renewalOptions)
	try { await credentials.start(initialCredentials) } catch (error) { await credentials.close(); throw error }
	const server = http.createServer((req, res) => {
		const url = new URL(req.url, "http://machine")
		const isLlm = url.pathname === "/llm" || url.pathname.startsWith("/llm/")
		const privateFiles = url.pathname.startsWith("/files-backend/"), privateWork = url.pathname.startsWith("/work-backend/")
		if (privateFiles || privateWork) {
			const supplied = req.headers["x-gc-files-control"], expected = Buffer.from(secret)
			if (typeof supplied !== "string" || Buffer.byteLength(supplied) !== expected.length || !expected.length || !crypto.timingSafeEqual(Buffer.from(supplied), expected)) return failure(res, 403, "private_file_channel")
			res.setHeader("x-gc-machine-authority", config.credentialsMode || "normal")
			if (!["x-gc-workspace-id", "x-gc-workspace-epoch"].every((name) => typeof req.headers[name] === "string" && /^[A-Za-z0-9_.:-]{1,128}$/.test(req.headers[name]))) return failure(res, 400, "workspace_headers_required")
			const suffix = url.pathname.slice(privateFiles ? 14 : 13), id = "[A-Za-z0-9_.:-]{1,128}"
			const demoAllowed = privateWork && (req.method === "GET" && suffix === "/demo/status" || req.method === "POST" && ["/demo/permit", "/demo/checkpoint"].includes(suffix))
			const allowed = demoAllowed || (privateFiles ? req.method === "GET" && new RegExp(`^/(?:limits|changes|snapshots/${id})$`).test(suffix) || req.method === "POST" && ["/snapshots", "/versions/urls", "/urls", "/current/upload", "/current/changes"].includes(suffix) : req.method === "GET" && new RegExp(`^/${id}$`).test(suffix) || req.method === "POST" && (suffix === "/claims" || suffix === "/receipts/reconcile" || new RegExp(`^/${id}/(?:progress|source-url|permits|ack|failure)$|^/permits/${id}/settle$`).test(suffix)))
			if (!allowed) return failure(res, 404, "not_found")
			if (config.credentialsMode === "cleanup" && !(privateWork && (req.method === "GET" && new RegExp(`^/${id}$`).test(suffix) || req.method === "POST" && (suffix === "/receipts/reconcile" || new RegExp(`^/permits/${id}/settle$`).test(suffix))))) return failure(res, 403, "cleanup_only")
		} else if (!isLlm && !(url.pathname === "/activity" && req.method === "POST")) return failure(res, 404, "not_found")
		else if (config.credentialsMode === "cleanup") return failure(res, 403, "cleanup_only")
		if (credentials.expired) return isLlm ? modelFailure(res, 503, "usage_unavailable") : failure(res, 503, "machine_credentials_expired")
		const destination = privateFiles ? files : privateWork ? work : isLlm ? llm : activity
		if (!destination) return isLlm ? modelFailure(res, 503, "usage_unavailable") : failure(res, 503, "service_not_configured")
		// Concatenation retains the configured backend prefix, never a caller-selected host.
		const target = new URL(destination.href.replace(/\/$/, "") + (privateFiles ? req.url.slice(14) : privateWork ? req.url.slice(13) : isLlm ? req.url.slice(4) : ""))
		// Read CURRENT config at admission. No copied token closure and no engine restart on rotation.
		// In machine mode the private processor credential selects attribution locally;
		// backend authority uses the same renewed llm_proxy purpose as other model calls.
		// Direct mode retains its separately supplied upstream processor credential.
		const preprocessing = isLlm && Boolean(config.preprocessingProxyToken) && req.headers.authorization === `Bearer ${config.preprocessingProxyToken}`
		const token = privateWork && config.credentialsMode === "cleanup" ? config.cleanupToken : privateFiles ? config.filesToken : privateWork ? config.workToken : preprocessing && !credentials.enabled ? config.preprocessingProxyToken : isLlm ? config.llmToken : config.activityToken
		if ((privateFiles || privateWork) && !token) return failure(res, 503, "purpose_token_unavailable")
		const headers = isLlm ? req.method === "POST" ? modelHeaders(req.headers, token, preprocessing) : llmHeaders(req.headers, token) : forwardingHeaders(req.headers, token)
		const upstream = (target.protocol === "https:" ? https : http).request(target, { method: req.method, headers }, (response) => {
			res.writeHead(response.statusCode, forwardingHeaders(response.headers))
			response.on("error", () => res.destroy())
			response.pipe(res)
		})
		upstream.on("error", () => { if (res.destroyed) return; if (res.headersSent) res.destroy(); else if (isLlm) modelFailure(res, 503, "usage_unavailable"); else failure(res, 502, "service_unavailable") })
		res.on("close", () => { if (!res.writableFinished) upstream.destroy() })
		req.on("aborted", () => upstream.destroy())
		req.pipe(upstream)
	})
	server.requestTimeout = 0
	return { server, credentials, async close() { await credentials.close(); server.closeAllConnections(); await new Promise((resolve) => server.close(resolve)) } }
}

/** Boot snapshot is root-private. Dataset hydration consumes its fresh dataset token. */
export async function bootstrapMachineCredentials(config, logger = console, renewalOptions) {
	const credentials = new MachineCredentials(config, logger, renewalOptions)
	try {
		if (!await credentials.start()) return false
		const purpose = config.credentialsMode === "cleanup" ? { cleanupToken: config.cleanupToken } : { llmToken: config.llmToken, activityToken: config.activityToken, datasetToken: config.datasetToken, filesToken: config.filesToken || undefined, workToken: config.workToken || undefined }
		const boot = { ...purpose, preprocessingProxyToken: config.preprocessingProxyToken || undefined, expiresAt: config.machineCredentialsExpiresAt, llmProxyUrl: config.llmProxyUrl, activityUrl: config.activityUrl, filesUrl: config.filesUrl, fileWorkUrl: config.fileWorkUrl }
		const file = await fs.open(config.machineCredentialsFile, fs.constants.O_WRONLY | fs.constants.O_CREAT | fs.constants.O_TRUNC | fs.constants.O_NOFOLLOW, 0o600)
		try { await file.chmod(0o600); await file.writeFile(JSON.stringify(boot)); await file.sync() } finally { await file.close() }
		return true
	} finally { await credentials.close() }
}

async function main() {
	const config = loadConfig(), logger = createLogger("machine-gateway")
	if (process.argv.includes("--bootstrap")) { await bootstrapMachineCredentials(config, logger); return }
	if (!config.machineTokenFile || !config.machineCredentialsUrl) throw new Error("Machine gateway requires IDE_MACHINE_TOKEN_FILE and IDE_MACHINE_CREDENTIALS_URL")
	const boot = JSON.parse(await fs.readFile(config.machineCredentialsFile, "utf8"))
	config.llmProxyUrl = boot.llmProxyUrl; config.activityUrl = boot.activityUrl; config.filesUrl = boot.filesUrl; config.fileWorkUrl = boot.fileWorkUrl; config.preprocessingProxyToken = boot.preprocessingProxyToken || ""
	const app = await createMachineGateway({ config, logger, initialCredentials: Date.parse(boot.expiresAt) > Date.now() ? boot : undefined })
	await new Promise((resolve, reject) => { app.server.once("error", reject); app.server.listen(config.machineGatewayPort, "127.0.0.1", resolve) })
	logger.info("listening", { host: "127.0.0.1", port: config.machineGatewayPort })
	let closing = false
	const stop = async () => { if (closing) return; closing = true; await app.close(); process.exit(0) }
	process.on("SIGTERM", stop); process.on("SIGINT", stop)
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) main().catch(() => { console.error("[machine-gateway] startup failed; inspect machine renewal configuration and endpoint availability."); process.exit(1) })
