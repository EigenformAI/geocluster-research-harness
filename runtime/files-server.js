#!/usr/bin/env node
/** Private workspace file daemon. The root access gate is its browser-facing transport. */
import crypto from "node:crypto"
import fs from "node:fs"
import http from "node:http"
import path from "node:path"
import { pathToFileURL } from "node:url"
import { FilesApi, workspaceFenceError } from "./lib/files.js"
import { WorkspaceFiles } from "./lib/workspace-files.js"
import { createLogger } from "./lib/log.js"
import { FILE_LIMITS } from "./lib/file-contract.js"
import gate from "./gate.cjs"
import { LifecycleAdmission, authorityLost } from "./lib/lifecycle-admission.js"
import { VOXEL_LIMITS, voxelFamily, voxelOriginError } from "./lib/voxels.js"
import { fail as voxelFailure } from "./lib/voxel-request.js"
import { createVoxelAgentServer } from "./lib/voxel-agent-server.js"
import { VOXEL_SOCKET } from "./lib/voxel-agent-contract.js"

const GATE_HEADER = "x-gc-gate"
const CONTROL_HEADER = "x-gc-files-control"
const MAX_CONTROL_BYTES = 4096
const PREVIEW_LAUNCHER = "/opt/geocluster-runtime/lib/preview-launcher/build/preview-launcher"
const PREVIEW_WORKER = "/opt/geocluster-runtime/lib/file-segments-worker.js"
const PREVIEW_NODE = "/usr/local/bin/node"

function trustedWorker(config) {
	const unavailable = (reason) => ({ filesWorkerEnabled: false, filesWorkerBridge: undefined, filesWorkerAvailability: { state: "unavailable", reason } })
	if (config.filesWorkerUid !== 997 || !config.filesWorkerUids?.includes(997) || config.filesAgentUids?.includes(997)) return unavailable("worker-uid")
	if (![0, 998].includes(process.getuid?.())) return unavailable("caller-uid")
	try {
		for (const filename of [PREVIEW_LAUNCHER, PREVIEW_WORKER, PREVIEW_NODE]) {
			const file = fs.lstatSync(filename)
			if (!file.isFile() || file.uid !== 0 || file.gid !== 0 || (file.mode & 0o022)) return unavailable("trusted-code")
			if (filename === PREVIEW_LAUNCHER && ((file.mode & 0o7777) !== 0o4755 || file.nlink !== 1)) return unavailable("launcher-mode")
			let parent = path.dirname(filename)
			while (true) {
				const directory = fs.lstatSync(parent)
				if (!directory.isDirectory() || directory.uid !== 0 || directory.gid !== 0 || (directory.mode & 0o022)) return unavailable("trusted-ancestor")
				if (parent === "/") break
				parent = path.dirname(parent)
			}
		}
		return { filesWorkerEnabled: true, filesWorkerBridge: { uid: 997, command: PREVIEW_LAUNCHER }, filesWorkerAvailability: { state: "provisioned" } }
	} catch {
		return unavailable("launcher-unavailable")
	}
}

function matchesSecret(secret, value) {
	if (!secret || typeof value !== "string") return false
	const expected = Buffer.from(secret)
	const actual = Buffer.from(value)
	return expected.length === actual.length && crypto.timingSafeEqual(expected, actual)
}

function sendJson(res, status, body) {
	const payload = JSON.stringify(body)
	res.writeHead(status, { "content-type": "application/json; charset=utf-8", "content-length": Buffer.byteLength(payload), "cache-control": "no-store", "x-content-type-options": "nosniff" })
	res.end(payload)
}

function failure(error, message, action) {
	return { error, message, agent: "file-service", tool: "files-server", action }
}

function uids(value, fallback, name) {
	const entries = (value || fallback).split(",").map((part) => part.trim())
	if (entries.some((part) => !/^\d+$/.test(part) || !Number.isSafeInteger(Number(part)))) throw new Error(`${name} must contain comma-separated Unix UIDs`)
	return [...new Set(entries.map(Number))]
}

export function loadFilesConfig(env = process.env) {
	let voxelLimits = {}
	if (env.VOXEL_LIMITS) {
		if (Buffer.byteLength(env.VOXEL_LIMITS) > 4096) throw new Error("VOXEL_LIMITS is limited to 4096 JSON bytes")
		voxelLimits = JSON.parse(env.VOXEL_LIMITS)
		if (!voxelLimits || typeof voxelLimits !== "object" || Array.isArray(voxelLimits) || Object.entries(voxelLimits).some(([key, value]) => !Object.hasOwn(VOXEL_LIMITS, key) || !Number.isSafeInteger(value) || value < 1)) throw new Error("VOXEL_LIMITS requires known positive safe integer limits")
	}
	let filesLimits = {}
	if (env.FILES_LIMITS) {
		if (Buffer.byteLength(env.FILES_LIMITS) > 4096) throw new Error("FILES_LIMITS is limited to 4096 JSON bytes")
		filesLimits = JSON.parse(env.FILES_LIMITS)
		if (!filesLimits || typeof filesLimits !== "object" || Array.isArray(filesLimits) || Object.entries(filesLimits).some(([key, value]) => !Object.hasOwn(FILE_LIMITS, key) || !Number.isSafeInteger(value) || value < 1)) throw new Error("FILES_LIMITS requires known numeric limits with positive safe integer values")
	}
	const port = Number(env.RUNTIME_FILES_PORT || 3002)
	if (!Number.isInteger(port) || port < 1 || port > 65535) throw new Error("RUNTIME_FILES_PORT must be between 1 and 65535")
	const workerUid = uids(env.FILES_WORKER_UID, "997", "FILES_WORKER_UID")
	if (workerUid.length !== 1) throw new Error("FILES_WORKER_UID must identify one Unix user")
	const projectId = env.PROJECT_ID || ""
	if (!projectId && !env.WORKSPACE_DIR) throw new Error("PROJECT_ID or WORKSPACE_DIR is required")
	const flag = (name, fallback = false) => {
		if (env[name] !== undefined && !["true", "false"].includes(env[name])) throw new Error(`${name} must be true or false`)
		return env[name] === undefined ? fallback : env[name] === "true"
	}
	const number = (name, fallback, minimum = 1) => {
		const value = env[name] === undefined || env[name] === "" ? fallback : Number(env[name])
		if (!Number.isSafeInteger(value) || value < minimum) throw new Error(`${name} must be a safe integer >= ${minimum}`)
		return value
	}
	const enabled = flag("PREPROCESSING_ENABLED"), aggregateActivity = flag("RUNTIME_AGGREGATE_ACTIVITY")
	if (enabled && !aggregateActivity) throw new Error("PREPROCESSING_ENABLED requires RUNTIME_AGGREGATE_ACTIVITY=true")
	const processorPort = number("PREPROCESSING_PORT", 8765)
	if (processorPort > 65535 || env.PREPROCESSING_URL && env.PREPROCESSING_URL !== `http://127.0.0.1:${processorPort}`) throw new Error("Preprocessing requires its fixed loopback endpoint")
	let token = ""
	if (env.PREPROCESSING_TOKEN_FILE) {
		const raw = fs.readFileSync(env.PREPROCESSING_TOKEN_FILE)
		if (raw.length > MAX_CONTROL_BYTES) throw new Error("The private preprocessing token is too large")
		token = raw.toString("utf8").trim()
		if (!/^[\x21-\x7e]+$/.test(token)) throw new Error("The private preprocessing token must be printable ASCII without spaces")
	}
	if (enabled && !token) throw new Error("Enabled preprocessing requires PREPROCESSING_TOKEN_FILE")
	const hours = env.PREPROCESSING_ACTIVITY_MAX_HOURS === undefined ? 6 : Number(env.PREPROCESSING_ACTIVITY_MAX_HOURS)
	if (!Number.isFinite(hours) || hours < 0 || !Number.isSafeInteger(hours * 3600000)) throw new Error("PREPROCESSING_ACTIVITY_MAX_HOURS must give a nonnegative safe millisecond duration")
	const preprocessing = {
		enabled, aggregateActivity, token, port: processorPort,
		inboxDir: path.resolve(env.PREPROCESSING_INBOX_DIR || path.join("/workspace/.runtime/preprocessing", projectId || "local", "inbox")),
		model: env.PREPROCESSING_MODEL || null, profileId: "default", bundleDigest: env.PREPROCESSING_BUNDLE_DIGEST || null,
		activeTickets: number("PREPROCESSING_MAX_ACTIVE_TICKETS", 100), inputBytes: number("PREPROCESSING_MAX_INPUT_BYTES", 256 * 1024 * 1024),
		transportMs: number("PREPROCESSING_TRANSPORT_TIMEOUT_MS", 5000), jsonBytes: number("PREPROCESSING_JSON_MAX_BYTES", 16 * 1024 * 1024),
		runningPollMs: number("PREPROCESSING_POLL_RUNNING_MS", 2000), queuedPollMs: number("PREPROCESSING_POLL_QUEUED_MS", 2000),
		heldWarningBytes: number("PREPROCESSING_HELD_INPUT_WARN_BYTES", 1024 * 1024 * 1024, 0),
		storageReserveBytes: env.PREPROCESSING_STORAGE_RESERVE_BYTES === undefined || env.PREPROCESSING_STORAGE_RESERVE_BYTES === "" ? null : number("PREPROCESSING_STORAGE_RESERVE_BYTES", 0, 0),
		activityMaxAgeMs: hours * 3600000,
	}
	const config = {
		ownedDemo: { enabled: flag("OWNED_DEMO_ENABLED"), bundleDir: path.join(path.dirname(new URL(import.meta.url).pathname), "demo-bundles/wattle-creek/v1"), pollMs: number("RUNTIME_FILE_WORK_POLL_MS", 5000) },
		voxelAgentEnabled: flag("VOXEL_AGENT_ENABLED", true),
		voxelAgentSocket: VOXEL_SOCKET,
		voxelAgentGid: 999,
		preprocessing,
		allowedOrigins: gate.parseAllowedOrigins(env.RUNTIME_ALLOWED_ORIGINS),
		filesLimits,
		voxelLimits,
		projectId,
		machineId: env.FLY_MACHINE_ID || "",
		workspaceDir: path.resolve(env.WORKSPACE_DIR || path.join("/workspace", projectId)),
		filesStateDir: path.resolve(env.FILES_STATE_DIR || path.join("/workspace/.runtime/file-service", projectId || "local")),
		filesAgentUids: uids(env.FILES_AGENT_UIDS, "999", "FILES_AGENT_UIDS"),
		filesWorkerUids: uids(env.FILES_WORKER_UIDS, "997", "FILES_WORKER_UIDS"),
		filesWorkerUid: workerUid[0],
		filesWorkbookWorkerBin: env.FILES_WORKBOOK_WORKER_BIN || "/opt/geocluster-runtime/workbook-launcher",
		filesWorkbookWorkerEnabled: env.FILES_WORKBOOK_WORKER_ENABLED !== "false",
		filesGisWorkerBin: env.FILES_GIS_WORKER_BIN || "/opt/geocluster-runtime/gis-launcher",
		filesGisWorkerEnabled: env.FILES_GIS_WORKER_ENABLED !== "false",
		// False is a deployment veto, never a replacement for the filesystem's rename probe.
		filesTrashAvailable: env.FILES_TRASH_AVAILABLE !== "false",
		writerRegistry: null,
		filesSyncAdapter: env.FILES_SYNC_ADAPTER === "true",
		cloudImport: { enabled: env.FILES_SYNC_ADAPTER === "true", gatewayPort: number("RUNTIME_MACHINE_GATEWAY_PORT", 3003), pollMs: number("RUNTIME_FILE_WORK_POLL_MS", 5000), maxClaimPages: number("RUNTIME_FILE_WORK_MAX_CLAIM_PAGES", 100, 0) },
		rgBin: "rg",
		listenHost: "127.0.0.1",
		listenPort: port,
	}
	if (env.FILES_WORKBOOK_WORKER_ENABLED !== undefined && !["true", "false"].includes(env.FILES_WORKBOOK_WORKER_ENABLED)) throw new Error("FILES_WORKBOOK_WORKER_ENABLED must be true or false")
	if (env.VOXEL_AGENT_SOCKET !== undefined && env.VOXEL_AGENT_SOCKET !== VOXEL_SOCKET) throw new Error(`VOXEL_AGENT_SOCKET is fixed at ${VOXEL_SOCKET}; alternate paths are test-only factory configuration`)
	if (env.FILES_SYNC_ADAPTER !== undefined && !["true", "false"].includes(env.FILES_SYNC_ADAPTER)) throw new Error("FILES_SYNC_ADAPTER must be true or false")
	if (env.FILES_GIS_WORKER_ENABLED !== undefined && !["true", "false"].includes(env.FILES_GIS_WORKER_ENABLED)) throw new Error("FILES_GIS_WORKER_ENABLED must be true or false")
	if (config.ownedDemo.enabled && !config.cloudImport.enabled) throw new Error("OWNED_DEMO_ENABLED requires the root work-backend channel and FILES_SYNC_ADAPTER=true")
	return { ...config, ...trustedWorker(config) }
}

async function readControlBody(req) {
	const chunks = []
	let bytes = 0
	// Keep the connection alive long enough to return an actionable 413, including
	// for chunked bodies with no declared length. Returning the iterator must not destroy it.
	for await (const chunk of req.iterator({ destroyOnReturn: false })) {
		bytes += chunk.length
		if (bytes > MAX_CONTROL_BYTES) { req.resume(); throw Object.assign(new Error("Private control requests are limited to 4096 bytes"), { status: 413, error: "body_too_large" }) }
		chunks.push(chunk)
	}
	try {
		const body = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(Buffer.concat(chunks)))
		if (!body || typeof body !== "object" || Array.isArray(body)) throw new Error("not an object")
		return body
	} catch {
		throw Object.assign(new Error("A private control request must contain a JSON object"), { status: 400, error: "invalid_request" })
	}
}

function checkedDeadline(value) {
	if (typeof value !== "string" || !/^\d{4}-\d{2}-\d{2}T.*(?:Z|[+-]\d{2}:\d{2})$/.test(value) || !Number.isFinite(Date.parse(value))) throw Object.assign(new Error("deadline must be an ISO timestamp with a timezone"), { status: 400 })
	return new Date(value).toISOString()
}

function beforeDeadline(work, deadline) {
	let timer
	return Promise.race([
		work,
		new Promise((_, reject) => {
			timer = setTimeout(() => reject(Object.assign(new Error("Drain deadline elapsed; pending work requires the retained volume"), { status: 503, error: "drain_timeout" })), Math.max(0, Date.parse(deadline) - Date.now()))
		}),
	]).finally(() => clearTimeout(timer))
}

function parserRoute(pathname) {
	return pathname === "/files/preview" || /^\/files\/(captures|fragments)\/[^/]+\/segments$/.test(pathname)
}

/** Opens file state without starting an ACP engine or listening on a public interface. */
export async function createFilesServer({ config, secret, logger, deferWorkspace = false }) {
	if (!secret) throw new Error("The file daemon requires the access-gate secret on stdin")
	// Factory callers cannot substitute a bridge or bypass deployment checks with a flag.
	const startup = new LifecycleAdmission()
	config = { ...config, ...trustedWorker(config), startupController: startup }
	let workspace = null, files = null, initialization = null, voxelAgent
	let draining = false
	let drainPromise = null
	let shutdownPromise = null
	let checkpointPromise = null
	const fenceResult = (deadline) => ({ admittingMutations: false, publicationFenced: true, projectId: config.projectId || null, machineId: config.machineId || null, deadline, startup: startup.snapshot(), ...(startup.demoRetention ? { demoRetention: startup.demoRetention } : {}), ...(startup.workspace?.identity || {}) })
	const closeAdmission = (runtimeId) => {
		// Demo publication closes synchronously. Normal shutdown lets admitted agent
		// requests finish before closing their workspace dependencies; deletion does not.
		startup.closeAdmission(runtimeId, { drainWorkspace: Boolean(runtimeId) || !voxelAgent })
		draining = true
		voxelAgent?.stopAdmission()
	}
	const checkpoint = (deadline) => {
		closeAdmission()
		// Closing admission is synchronous. The namespace barrier then waits for any
		// already-submitted guarded rename before acknowledging the local fence.
		checkpointPromise ||= beforeDeadline(Promise.resolve().then(async () => {
			await voxelAgent?.drain(deadline)
			if (workspace) workspace.draining = true
			const [processing, imports] = await Promise.all([workspace?.processing.drain(deadline), workspace?.imports?.drain(deadline), startup.barrier()])
			return { ...(processing || { complete: false, recoveryRequired: true }), ...(imports ? { imports, complete: processing.complete && imports.complete } : {}) }
		}), deadline)
		return checkpointPromise
	}
	const drain = (deadline) => {
		closeAdmission()
		if (!drainPromise) drainPromise = beforeDeadline(Promise.resolve().then(async () => {
			await voxelAgent?.drain(deadline)
			await startup.barrier()
			return workspace ? workspace.drain(deadline) : { ...fenceResult(deadline), localPending: null, remotePending: null, indeterminate: null, complete: false, recoveryRequired: true }
		}), deadline)
		return drainPromise
	}
	const server = http.createServer(async (req, res) => {
		try {
			const url = new URL(req.url || "/", "http://files")
			if (url.pathname === "/internal/files/drain") {
				if (!matchesSecret(config.controlSecret, req.headers[CONTROL_HEADER])) return sendJson(res, 403, failure("control", "Drain requires the root supervisor's private credential", "Use the root-owned lifecycle control channel."))
				if (req.method !== "POST") return sendJson(res, 405, failure("method", "Drain requires POST", "Send a POST with a deadline."))
				const body = await readControlBody(req)
				const deadline = checkedDeadline(body?.deadline)
				if (body.admissionOnly !== undefined && typeof body.admissionOnly !== "boolean") return sendJson(res, 400, failure("invalid_request", "admissionOnly must be boolean", "Send a boolean admissionOnly value."))
				if (body.runtimeId !== undefined && (typeof body.runtimeId !== "string" || !/^[A-Za-z0-9_.:-]{1,128}$/.test(body.runtimeId))) return sendJson(res, 400, failure("invalid_request", "runtimeId must identify the runtime owner", "Send the backend's current runtime owner ID."))
				closeAdmission(body.runtimeId)
				if (body.admissionOnly) {
					// Lifecycle deletion needs the local publication barrier, not network
					// processing settlement under the backend lock it already owns.
					await beforeDeadline(startup.barrier(), deadline)
					const processing = body.runtimeId ? { complete: false, state: "deferred-to-drain" } : await checkpoint(deadline)
					return sendJson(res, 200, { ...fenceResult(deadline), processing })
				}
				const result = await drain(deadline)
				return sendJson(res, 200, result)
			}
			if (!workspace || startup.authorityLost) return sendJson(res, 503, failure(startup.closed ? "draining" : "initializing", "The ordinary workspace is not available", "Observe setup status and use normal runtime recovery."))
			if (url.pathname === "/internal/files/demo/retention/release") {
				if (!matchesSecret(config.controlSecret, req.headers[CONTROL_HEADER]) || req.headers.cookie !== undefined || req.headers.origin !== undefined) return sendJson(res, 403, failure("control", "Retention release requires the private operator credential", "Use the root-owned control channel."))
				if (req.method !== "POST" || url.search) return sendJson(res, 405, failure("method", "Retention release requires POST without query parameters", "Name the exact assignment and map permit in the JSON body."))
				if (!workspace.demo) return sendJson(res, 409, failure("demo_unavailable", "This project has no initial sample retention", "Inspect this project's retained ownership."))
				return sendJson(res, 200, await workspace.demo.releaseRetention(await readControlBody(req)))
			}
			if (url.pathname === "/internal/voxels/reconcile") {
				if (!matchesSecret(config.controlSecret, req.headers[CONTROL_HEADER])) return sendJson(res, 403, failure("control", "Voxel reconciliation requires the root supervisor's private credential", "Use the root-owned lifecycle control channel."))
				if (req.method !== "POST") return sendJson(res, 405, failure("method", "Voxel reconciliation requires POST", "Send a POST with exact inspected artifact, upload and capture evidence."))
				return sendJson(res, 200, await workspace.voxels.reconcileArtifact(await readControlBody(req)))
			}
			if (url.pathname === "/internal/files/activity" || url.pathname === "/internal/files/storage") {
				if (!matchesSecret(config.controlSecret, req.headers[CONTROL_HEADER])) return sendJson(res, 403, failure("control", "Private activity and storage require the root credential", "Use the root-owned lifecycle control channel."))
				if (url.pathname.endsWith("/activity") && req.method === "GET") return sendJson(res, 200, await workspace.processing.activity())
				if (url.pathname.endsWith("/storage") && req.method === "POST") return sendJson(res, 200, await workspace.processing.observeStorage(await readControlBody(req)))
				return sendJson(res, 405, failure("method", "Use GET for activity and POST for storage", "Use the documented private control method."))
			}
			if (!matchesSecret(secret, req.headers[GATE_HEADER])) return sendJson(res, 403, failure("gate", "Requests must come through the access gate", "Use the project's authenticated runtime URL."))
			if (req.url === "/files/info" && matchesSecret(config.controlSecret, req.headers[CONTROL_HEADER]) && req.headers.cookie === undefined && req.headers.origin === undefined) req.privateBootstrap = true
			if (url.pathname === "/livez" && ["GET", "HEAD"].includes(req.method)) return sendJson(res, 200, { status: "live", runtime: "files" })
			// Identity rejection precedes route availability gates too; the adapter supplies correlation.
			if ((url.pathname === "/files" || url.pathname.startsWith("/files/")) && workspaceFenceError(req, workspace.identity)) return void await files.handle(req, res, url)
			// Stop browser admission immediately, including while accepted agent
			// requests finish before workspace drain. Keep scope and Origin ordering.
			if (voxelFamily(url.pathname)) {
				if (draining && !["GET", "HEAD"].includes(req.method)) {
					const fence = workspaceFenceError(req, workspace.identity)
					const rejection = fence ? voxelFailure(fence.status, fence.error, fence.message) : voxelOriginError(req, config.allowedOrigins || gate.parseAllowedOrigins()) || voxelFailure(503, "draining", "The voxel service is draining accepted work. Retry after restart.")
					return sendJson(res, rejection.status, rejection.toJSON())
				}
				return void await workspace.voxels.handle(req, res, url)
			}
			const processingMutation = req.method === "PUT" && url.pathname === "/files/upload" || req.method === "POST" && url.pathname.startsWith("/files/processing/")
			if (processingMutation && req.headers.origin !== undefined && !gate.originAllowed(req.headers.origin, config.allowedOrigins || gate.parseAllowedOrigins())) return sendJson(res, 403, failure("bad_origin", "Processing mutations require an allowed Origin when supplied", "Use the project's allowed application origin or an authenticated non-browser client."))
			const cancellation = req.method === "POST" && /^\/files\/(?:processing\/)?jobs\/[^/]+\/cancel$/.test(url.pathname)
			if (draining && !["GET", "HEAD"].includes(req.method) && !cancellation) return sendJson(res, 503, failure("draining", "The file service is draining accepted work", "Retry after the runtime restarts."))
			if (!config.filesWorkerEnabled && parserRoute(url.pathname)) return sendJson(res, 503, failure("worker_unavailable", "Preview parsing requires a separately provisioned worker identity", "Provision the root-controlled gc-preview launcher before enabling parsers."))
			if (config.filesTrashAvailable === false && url.pathname === "/files/entry" && req.method === "DELETE") return sendJson(res, 409, failure("trash_unavailable", "This deployment cannot rename the project entry into protected trash", "Use one retained mount for project and private state, then verify rename support."))
			if (await files.handle(req, res, url)) return
			sendJson(res, 404, failure("not_found", "Unknown file-service route", "Use a supported /files route."))
		} catch (error) {
			logger.error("request failed", { error: String(error?.message || error) })
			if (res.headersSent) res.destroy()
			else sendJson(res, error?.status || 500, typeof error?.toJSON === "function" ? error.toJSON() : failure(error?.error || "storage_unavailable", String(error?.message || error), "Inspect the file-service log and retained state."))
		}
	})
	const startRecovery = () => {
		if (!workspace || startup.closed) return
		try { workspace.voxels.startRecovery() }
		catch (error) {
			logger.error("voxel startup recovery failed", { agent: "file-service", tool: "voxel-start-recovery", error: String(error?.message || error), action: "Retain the volume, inspect interrupted voxel publication evidence, and restart the file service." })
		}
	}
	server.once("listening", startRecovery)
	server.requestTimeout = 0 // Streamed uploads have their own admission/work budgets.
	const shutdown = (deadline = new Date(Date.now() + 30000).toISOString()) => {
		if (shutdownPromise) return shutdownPromise
		deadline = checkedDeadline(deadline)
		closeAdmission()
		shutdownPromise = (async () => {
			const closed = new Promise((resolve) => server.close(resolve))
			const agentClosed = voxelAgent?.close(deadline)
			agentClosed?.catch(() => {}) // Keep timeout rejection observed while workspace drain settles.
			const timeout = setTimeout(() => server.closeAllConnections(), Math.max(0, Date.parse(deadline) - Date.now()))
			try {
				const result = await drain(deadline)
				server.closeAllConnections() // Includes otherwise unbounded watch subscriptions.
				await closed
				await agentClosed
				await beforeDeadline(Promise.resolve().then(async () => {
					await initialization?.catch(() => {})
					await files?.close?.()
					await workspace?.close()
				}), deadline)
				return result
			} finally {
				server.closeAllConnections()
				clearTimeout(timeout)
			}
		})()
		return shutdownPromise
	}
	const initialize = () => {
		if (initialization) return initialization
		initialization = (async () => {
			try {
				startup.assertOpen()
				const opened = await WorkspaceFiles.open(config, logger)
				if (startup.closed) { await opened.close(); startup.assertOpen() }
				workspace = opened; files = new FilesApi(workspace, logger.child?.("http") || logger)
				if (config.voxelAgentEnabled === true) voxelAgent = await createVoxelAgentServer({ workspace, config, logger })
				if (startup.closed) { await voxelAgent?.close(); await workspace.close(); startup.assertOpen() }
				startup.state = "ready"
				if (server.listening) startRecovery()
				return workspace
			} catch (error) { if (authorityLost(error)) startup.loseAuthority(); else startup.state = "failed"; throw error }
		})()
		initialization.catch(() => {})
		return initialization
	}
	const app = { server, get files() { return files }, get voxelAgent() { return voxelAgent }, startup, initialize, shutdown }
	if (!deferWorkspace) { try { await initialize() } catch (error) { if (!startup.authorityLost) await shutdown().catch(() => {}); throw error } }
	return app
}

async function stdinSecrets() {
	let input = ""
	process.stdin.setEncoding("utf8")
	for await (const chunk of process.stdin) {
		input += chunk
		if (Buffer.byteLength(input) > MAX_CONTROL_BYTES) throw new Error("File-service stdin configuration is too large")
	}
	const [secret, controlSecret = ""] = input.trim().split(/\r?\n/)
	if (!/^[0-9a-f]{64}$/.test(secret || "") || (controlSecret && !/^[0-9a-f]{64}$/.test(controlSecret))) throw new Error("Expected the per-boot gate secret and optional root control secret on stdin")
	return { secret, controlSecret }
}

async function main() {
	process.umask(0o002)
	const config = loadFilesConfig()
	const { secret, controlSecret } = await stdinSecrets()
	config.controlSecret = controlSecret
	const logger = createLogger("files")
	const app = await createFilesServer({ config, secret, logger, deferWorkspace: true })
	await new Promise((resolve, reject) => {
		app.server.once("error", reject)
		app.server.listen(config.listenPort, "127.0.0.1", resolve)
	})
	logger.info("private lifecycle listening before workspace initialization", { host: "127.0.0.1", port: config.listenPort })
	let stopping = false
	const stop = async (signal) => {
		if (stopping) return
		stopping = true
		try {
			logger.info("shutdown drain", await app.shutdown())
			process.exit(0)
		} catch (error) {
			logger.error("shutdown failed", { signal, error: String(error?.message || error), action: "Retain the volume and inspect pending work before destruction." })
			process.exit(1)
		}
	}
	process.on("SIGTERM", () => void stop("SIGTERM"))
	process.on("SIGINT", () => void stop("SIGINT"))
	try { await app.initialize() } catch (error) {
		if (app.startup.authorityLost) { logger.warn("workspace authority lost; private lifecycle channel remains available", { error: error.error, action: "Use normal runtime restart after authority is restored." }); return }
		await app.shutdown().catch(() => {}); throw error
	}
	logger.info("workspace initialized", { host: "127.0.0.1", port: config.listenPort, parsers: config.filesWorkerAvailability, writerRegistry: "unknown" })
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
	main().catch((error) => {
		console.error("[files] files-server startup failed:", error?.message || error, "Inspect the identity, protected state, and native build.")
		process.exit(1)
	})
}
