#!/usr/bin/env node
/**
 * Stand-in for the shared geocluster MCP (geocluster-mcp/main.py with MCP_TRANSPORT=http) in runtime tests.
 *
 * It serves only what the gateway may touch: GET /healthz → {ok:true, mode:"shared", in_flight:N}. Every other
 * path is a 404 and is reported on stderr as FAKE_MCP_UNEXPECTED (so it lands in mcp.log, where a test can assert
 * that nobody requested /mcp: in the real server each request without a session id leaks a session). Every request
 * also gets uvicorn's access line on stdout, as the real server prints it.
 *
 * Startup checks mirror main.py configure(), with the same messages: it refuses to start (stderr, exit 2) when
 * MCP_TRANSPORT is not sse/http, or, in http mode, when MCP_HOST is not loopback, GEOCLUSTER_RUN_DIR is set,
 * GEOCLUSTER_TRAINING_ENABLED=1, or MCP_TOOL_THREADS / MCP_TOOL_THREADS_PER_RUN is not a positive integer.
 * (The real server exits 1: Python's SystemExit with a message.) With MCP_TRANSPORT=sse (also the default, as in
 * main.py) it serves /healthz with mode "single", like the real per-conversation server.
 *
 * Test hooks (env; the supervisor passes a whitelisted env only, so tests prepend them with /usr/bin/env):
 *   FAKE_MCP_START_DELAY_MS   wait this long before listening (Python imports + warm-up)
 *   FAKE_MCP_EXIT_AFTER_MS    exit 1 this long after the process started (a crash, or an exit during start)
 *   FAKE_MCP_IN_FLIGHT_FILE   its integer content is reported as in_flight (missing or invalid → 0)
 *   FAKE_MCP_ENV_DUMP         write the sorted names of its environment there (JSON array) at startup
 *   FAKE_MCP_WORKER_PID_FILE  start a long-lived child (a joblib/loky worker) that ignores SIGTERM, write its pid
 *   FAKE_MCP_IGNORE_SIGTERM=1 ignore SIGTERM (a server stuck in a tool call), so a stop needs SIGKILL
 * Otherwise it exits 0 on SIGTERM.
 */
import { spawn } from "node:child_process"
import fs from "node:fs"
import http from "node:http"

const startedAt = Date.now()
const env = process.env

/** Python's repr() of a str, enough for the messages below. */
function pyRepr(value) {
	if (value === undefined) return "None"
	if (value.includes("'") && !value.includes('"')) return `"${value}"`
	return `'${value.replace(/\\/g, "\\\\").replace(/'/g, "\\'")}'`
}

/** main.py configure(): {transport, host, port}, or {error} with the message SystemExit would print. */
function configure() {
	const raw = env.MCP_TRANSPORT ?? "sse"
	const transport = raw.trim().toLowerCase()
	if (transport !== "sse" && transport !== "http") return { error: `MCP_TRANSPORT must be 'sse' or 'http', got ${pyRepr(raw)}` }
	const rawPort = env.MCP_PORT ?? "7654"
	if (!/^\s*[+-]?\d+\s*$/.test(rawPort)) return { error: `ValueError: invalid literal for int() with base 10: ${pyRepr(rawPort)}` }
	const port = Number(rawPort)
	if (transport === "sse") return { transport, host: env.MCP_HOST ?? "0.0.0.0", port }

	const host = env.MCP_HOST ?? "127.0.0.1"
	const problems = []
	if (!["127.0.0.1", "localhost", "::1"].includes(host)) {
		problems.push(`MCP_HOST must be a loopback address, got ${pyRepr(host)} (no auth, and each call names its folder)`)
	}
	if ((env.GEOCLUSTER_RUN_DIR ?? "").trim()) problems.push("unset GEOCLUSTER_RUN_DIR (every call brings its own run_dir)")
	if ((env.GEOCLUSTER_TRAINING_ENABLED ?? "0") === "1") {
		problems.push("unset GEOCLUSTER_TRAINING_ENABLED (one training session would record every conversation)")
	}
	for (const name of ["MCP_TOOL_THREADS", "MCP_TOOL_THREADS_PER_RUN"]) {
		const value = env[name] ?? "1"
		if (!/^\d+$/.test(value) || Number(value) < 1) problems.push(`${name} must be a positive integer, got ${pyRepr(env[name])}`)
	}
	if (problems.length) return { error: `geocluster-mcp with MCP_TRANSPORT=http: ${problems.join("; ")}` }
	return { transport, host, port }
}

if (env.FAKE_MCP_ENV_DUMP) fs.writeFileSync(env.FAKE_MCP_ENV_DUMP, JSON.stringify(Object.keys(env).sort()))

const settings = configure()
if (settings.error) {
	process.stderr.write(`${settings.error}\n`)
	process.exit(2)
}

if (env.FAKE_MCP_IGNORE_SIGTERM === "1") process.on("SIGTERM", () => console.log("FAKE_MCP ignoring SIGTERM"))
else process.on("SIGTERM", () => process.exit(0))

const exitAfter = Number(env.FAKE_MCP_EXIT_AFTER_MS)
if (env.FAKE_MCP_EXIT_AFTER_MS && Number.isFinite(exitAfter)) {
	setTimeout(() => {
		process.stderr.write(`FAKE_MCP crashing after ${exitAfter} ms\n`)
		process.exit(1)
	}, Math.max(0, exitAfter - (Date.now() - startedAt)))
}

if (env.FAKE_MCP_WORKER_PID_FILE) {
	// Inherits stdout/stderr like a loky worker does; ignores SIGTERM so only a SIGKILL ends it
	const worker = spawn(process.execPath, ["-e", "process.on('SIGTERM', () => {}); setInterval(() => {}, 1000)"], {
		stdio: ["ignore", "inherit", "inherit"],
	})
	fs.writeFileSync(env.FAKE_MCP_WORKER_PID_FILE, String(worker.pid))
}

function inFlight() {
	if (!env.FAKE_MCP_IN_FLIGHT_FILE) return 0
	try {
		const value = Number.parseInt(fs.readFileSync(env.FAKE_MCP_IN_FLIGHT_FILE, "utf8").trim(), 10)
		return Number.isFinite(value) ? value : 0
	} catch {
		return 0
	}
}

const mode = settings.transport === "http" ? "shared" : "single"
const server = http.createServer((req, res) => {
	const url = new URL(req.url ?? "/", "http://fake")
	// uvicorn's access line, as the real server prints it (the supervisor keeps its own /healthz ones out of mcp.log)
	const access = (status, phrase) =>
		console.log(`INFO:     ${req.socket.remoteAddress}:${req.socket.remotePort} - "${req.method} ${req.url} HTTP/${req.httpVersion}" ${status} ${phrase}`)
	if (url.pathname === "/healthz" && req.method === "GET") {
		res.writeHead(200, { "content-type": "application/json" })
		res.end(JSON.stringify({ ok: true, mode, in_flight: inFlight() }))
		access(200, "OK")
		return
	}
	process.stderr.write(`FAKE_MCP_UNEXPECTED ${req.method} ${url.pathname}\n`)
	res.writeHead(404, { "content-type": "text/plain" })
	res.end("Not Found")
	access(404, "Not Found")
})

setTimeout(() => {
	server.listen(settings.port, settings.host, () => {
		const where = settings.transport === "http" ? "/mcp (Streamable HTTP, shared by every conversation)" : "/sse"
		console.log(`Starting Geocluster MCP on http://${settings.host}:${settings.port}${where}`)
		// The env the server got, as the api-2 gateway tests read it from mcp.log (values only for non-secret keys)
		const shown = {}
		for (const name of Object.keys(env).sort()) {
			if (/^(MCP_|FASTMCP_|OPENBLAS_|NUMBA_|PYTHON|GEOCLUSTER_)/.test(name) || name === "HOME" || name === "LANG") shown[name] = env[name]
		}
		console.log(`FAKE_MCP_ENV ${JSON.stringify({ ...shown, keys: Object.keys(env).sort() })}`)
	})
	server.on("error", (error) => {
		// As uvicorn does when the port is taken: say so and exit 1
		process.stderr.write(`ERROR: [Errno 98] error while attempting to bind on address (${settings.host}, ${settings.port}): ${error.code}\n`)
		process.exit(1)
	})
}, Math.max(0, Number(env.FAKE_MCP_START_DELAY_MS) || 0))
