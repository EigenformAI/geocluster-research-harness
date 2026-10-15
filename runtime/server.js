#!/usr/bin/env node
/**
 * GeoCluster runtime gateway — the machine-side backend the browser talks to.
 *
 *   WS  /agent          ACP JSON-RPC (see lib/acp-bridge.js, lib/session-broker.js)
 * Workspace file requests go from the access gate to files-server.js, under its own identity.
 *   GET /livez /readyz  liveness / readiness (lib/health.js)
 *   GET /session/info
 *
 * Listens on loopback only. The public face is gate.cjs (root): it authenticates the browser
 * (cookie), adds CORS, and injects the per-boot X-GC-Gate secret this process expects on every
 * request. Without that header the gateway answers 403 — the agent runs as the same user and
 * must not be able to drive its own approvals via 127.0.0.1:3001.
 *
 * Config: lib/config.js (env). The gate secret arrives on stdin (production) or via
 * RUNTIME_GATE_SECRET / RUNTIME_GATE_DISABLED=1 (local only).
 *
 * Behind the broker: one `opencode acp` for every conversation and one shared geocluster MCP.
 * They start after listen: /livez answers at once, /readyz
 * once the engine is up.
 */
import crypto from "node:crypto"
import http from "node:http"
import { WebSocketServer } from "ws"
import { SUBPROTOCOL, attachSocket } from "./lib/acp-bridge.js"
import { ActivityReporter } from "./lib/activity.js"
import { BuildInfo } from "./lib/build-info.js"
import { SessionIndex } from "./lib/session-index.js"
import { loadConfig } from "./lib/config.js"
import { Health } from "./lib/health.js"
import { createLogger } from "./lib/log.js"
import { Prefs } from "./lib/prefs.js"
import { SessionBroker } from "./lib/session-broker.js"
import workspaceRelay from "./lib/workspace-relay.cjs"

const GATE_HEADER = "x-gc-gate"
const PUBLIC_PATHS = new Set(["/livez", "/readyz"])

function readSecretFromStdin(timeoutMs = 3000) {
	if (process.stdin.isTTY) return Promise.resolve("")
	return new Promise((resolve) => {
		let data = ""
		const timer = setTimeout(() => resolve(data.trim()), timeoutMs)
		process.stdin.setEncoding("utf8")
		process.stdin.on("data", (chunk) => {
			data += chunk
			if (data.length > 4096) data = data.slice(0, 4096)
		})
		process.stdin.once("end", () => {
			clearTimeout(timer)
			resolve(data.trim())
		})
		process.stdin.once("error", () => {
			clearTimeout(timer)
			resolve(data.trim())
		})
	})
}

function sendJson(res, status, body) {
	const payload = JSON.stringify(body)
	res.writeHead(status, { "content-type": "application/json; charset=utf-8", "content-length": Buffer.byteLength(payload), "cache-control": "no-store" })
	res.end(payload)
}

export function gateCheck(secret, headerValue) {
	if (!secret) return true
	if (typeof headerValue !== "string") return false
	const expected = Buffer.from(secret), actual = Buffer.from(headerValue)
	return actual.length === expected.length && crypto.timingSafeEqual(actual, expected)
}

/**
 * @param {object} opts {config, secret, logger, memory?, engine?, mcp?, exporter?} — engine, mcp and
 *   exporter are injectable for tests. Call `broker.start()` to boot the MCP and the engine.
 */
export async function createServer({ config, secret, controlSecret = config.runtimeControlSecret || "", logger, memory, engine, mcp, exporter }) {
	if (config.managedCatalog === undefined) {
		const { catalogIdentity, discoveryReason, readCatalogArtifact } = await import("./lib/managed-catalog.js")
		try { config.managedCatalog = await readCatalogArtifact(config.managedCatalogPath, catalogIdentity(config), { maxBytes: config.managedDiscoveryMaxBytes + 4096 }) }
		catch (error) { config.managedCatalog = null; logger.warn("managed execution catalog unavailable; independent file services remain available", { reason: discoveryReason(error) }) }
	}
	const prefs = await Prefs.load(config.gatewayStateDir)
	const activity = new ActivityReporter(config, logger.child("activity"))
	const index = await SessionIndex.load(config, logger.child("index"))
	// A damaged index was rebuilt from the logs; pruning on its word could delete transcripts, so not this boot
	const pruned = index.damaged ? [] : await index.pruneUnprompted()
	if (!index.damaged) await index.pruneOrphans()
	// digests are hashed in the background (the engine binary is ~200 MB); null until done
	const build = new BuildInfo(config)
	build.ready = build.compute()
	const broker = new SessionBroker({ config, prefs, activity, index, memory, build, engine, mcp, exporter, logger: logger.child("broker") })
	// Never-prompted conversations removed from the index also go from the engine's database
	broker.forgetEngineSessions(pruned)
	const health = new Health(config, broker, build)
	const wss = new WebSocketServer({
		noServer: true,
		maxPayload: 16 * 1024 * 1024,
		handleProtocols: (protocols) => (protocols.has(SUBPROTOCOL) ? SUBPROTOCOL : false),
	})

	const server = http.createServer(async (req, res) => {
		const url = new URL(req.url ?? "/", "http://gateway")
		if (url.pathname.startsWith("/internal/")) {
			if (!controlSecret || !gateCheck(controlSecret, req.headers["x-gc-runtime-control"])) return sendJson(res, 403, { error: "control" })
			if (req.method === "GET" && url.pathname === "/internal/runtime/activity") return sendJson(res, 200, activity.snapshot())
			return sendJson(res, 404, { error: "not_found" })
		}
		const isPublic = PUBLIC_PATHS.has(url.pathname) || (url.pathname === "/" && req.method === "HEAD")
		if (!isPublic && !gateCheck(secret, req.headers[GATE_HEADER])) {
			sendJson(res, 403, { error: "gate", message: "requests must come through the access gate" })
			return
		}
		try {
			if (url.pathname === "/livez") return sendJson(res, 200, health.live())
			if (url.pathname === "/readyz") {
				const body = await health.ready()
				return sendJson(res, body.ready ? 200 : 503, body)
			}
			if (url.pathname === "/" && req.method === "HEAD") {
				res.writeHead(200)
				return res.end()
			}
			if (url.pathname === "/session/info" && req.method === "GET") return sendJson(res, 200, health.info())
			sendJson(res, 404, { error: "not_found", path: url.pathname })
		} catch (error) {
			logger.error("request failed", { path: url.pathname, error: String(error?.message ?? error) })
			if (!res.headersSent) sendJson(res, 500, { error: "internal" })
			else res.end()
		}
	})

	server.on("upgrade", async (req, socket, head) => {
		socket.on("error", () => {})
		const url = new URL(req.url ?? "/", "http://gateway")
		if (url.pathname !== "/agent") {
			socket.write("HTTP/1.1 404 Not Found\r\nConnection: close\r\n\r\n")
			socket.destroy()
			return
		}
		if (!gateCheck(secret, req.headers[GATE_HEADER])) {
			socket.write("HTTP/1.1 403 Forbidden\r\nConnection: close\r\n\r\n")
			socket.destroy()
			return
		}
		const abort = new AbortController()
		const gone = () => abort.abort()
		socket.once("close", gone)
		socket.pause()
		try {
			const expected = workspaceRelay.parseWorkspaceFence(req)
			const check = () => workspaceRelay.checkWorkspaceFence({ filesPort: config.filesPort, gateSecret: secret, signal: abort.signal }, expected)
			await check()
			if (socket.destroyed) return
			wss.handleUpgrade(req, socket, head, (ws) => {
				// Liveness bookkeeping must be wired here: with `noServer` + handleUpgrade, `ws` never
				// emits the server's "connection" event, so a handler registered there would never run
				// and every socket would be terminated on the second ping tick (found 2026-09-22).
				ws.isAlive = true
				ws.on("pong", () => {
					ws.isAlive = true
				})
				attachSocket(ws, broker, logger.child("ws"), expected ? { beforeMessage: check } : {})
				socket.resume()
			})
		} catch (error) {
			logger.warn("WebSocket epoch fence rejected", { error: error.error || "workspace_fence_unavailable" })
			workspaceRelay.rejectWorkspaceUpgrade(socket, error instanceof workspaceRelay.WorkspaceFenceError ? error : new workspaceRelay.WorkspaceFenceError(503, "workspace_fence_unavailable", "The current workspace identity could not be verified."))
		}
	})

	// keep sockets alive through proxies; drop dead ones
	const pingTimer = setInterval(() => {
		for (const ws of wss.clients) {
			if (ws.isAlive === false) {
				ws.terminate()
				continue
			}
			ws.isAlive = false
			ws.ping()
		}
	}, config.wsPingMs)
	pingTimer.unref()

	let closed = false
	const shutdown = async () => {
		if (closed) return // SIGTERM and SIGINT, or a test's explicit call then its teardown
		closed = true
		clearInterval(pingTimer)
		await broker.shutdown()
		activity.close()
		for (const ws of wss.clients) ws.close(1001, "gateway shutting down")
		server.close()
	}

	return { server, broker, health, build, activity, shutdown }
}

async function main() {
	const config = loadConfig()
	config.aggregateActivity = process.env.RUNTIME_AGGREGATE_ACTIVITY === "true"
	if (config.aggregateActivity) config.activityToken = ""
	const logger = createLogger("gateway")
	const [stdinSecret, controlSecret = ""] = (await readSecretFromStdin()).split("\n")
	let secret = config.gateSecretFromEnv || stdinSecret
	if (!secret && config.gateDisabled) {
		logger.warn("RUNTIME_GATE_DISABLED=1: gate header not enforced (local only)")
	} else if (!secret) {
		logger.error("no gate secret on stdin and RUNTIME_GATE_DISABLED is not set: refusing every request but health")
		secret = crypto.randomBytes(32).toString("hex") // nothing can match it → fail closed
	}

	const app = await createServer({ config, secret, controlSecret, logger })
	app.activity.startStorageReports()
	app.server.listen(config.listenPort, config.listenHost, () => {
		logger.info("listening", { host: config.listenHost, port: config.listenPort, workspace: config.workspaceDir, project: config.projectId || "(none)" })
	})

	// The shared MCP, then the engine (initialize, warm-up session, MCP tools); never throws
	void app.broker.start()

	let stopping = false
	const stop = async (signal) => {
		if (stopping) return process.exit(1)
		stopping = true
		logger.info("shutting down", { signal })
		try {
			await app.shutdown()
		} finally {
			process.exit(0)
		}
	}
	process.on("SIGTERM", () => stop("SIGTERM"))
	process.on("SIGINT", () => stop("SIGINT"))
	process.on("uncaughtException", (error) => logger.error("uncaughtException", String(error?.stack ?? error)))
	process.on("unhandledRejection", (reason) => logger.error("unhandledRejection", String(reason?.stack ?? reason)))
}

if (import.meta.url === `file://${process.argv[1]}`) {
	main().catch((error) => {
		console.error("gateway failed to start:", error)
		process.exit(1)
	})
}
