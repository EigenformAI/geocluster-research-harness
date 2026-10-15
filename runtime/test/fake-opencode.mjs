#!/usr/bin/env node
/**
 * A fake `opencode acp` (OpenCode 2.0.19) for the gateway's tests.
 *
 * It is a raw NDJSON JSON-RPC loop over stdio (no ACP SDK), so frames reach the gateway exactly as
 * written here, like the real engine's do. It reproduces the contract measured on the real engine
 * on 2026-10-01 (s43/result-protocol.md, result-children.md, result-sdk.md):
 *   - initialize: the measured capabilities, including _meta["opencode/child-session-updates"];
 *     it answers even when the private server is dead;
 *   - a private "server" child (`node -e … serve --stdio`, a direct child, argv has "serve"). When
 *     it dies, every request except initialize fails -32603 ClientError, and an in-flight prompt
 *     fails the same way about 50 ms later. acp itself stays alive and silent (finding Q9);
 *   - MCP readiness only on stderr: `message="mcp connected" server=geocluster` or
 *     `message="mcp connect failed" server=geocluster`, once, about 100 ms after start, decided
 *     by GET <GEOCLUSTER_MCP_URL with /mcp → /healthz>;
 *   - session/new: available_commands_update (init, review) BEFORE the response, then
 *     {sessionId:"ses_…", configOptions:[model, effort, mode]}; no modes, no models;
 *   - sessions persist in <XDG_DATA_HOME>/fake-opencode/sessions.json, but a new process knows no
 *     session until session/resume or session/load (-32602 "session not found" otherwise);
 *   - one prompt per session, not queued (-32603 "Session already has an active ACP prompt");
 *   - a finished turn ends with one usage_update, then {stopReason, usage, _meta}; a cancelled turn
 *     sends it only if a model step finished (a root tool call); a failed turn sends none; assistant
 *     chunks carry a stable messageId;
 *   - children as `opencode/session/child_update` with the measured ordering (duplicate
 *     in_progress right after `created`, links only at completion via rawOutput.metadata.sessionID);
 *   - permission requests on the ROOT session id, engine request ids from 0, `$/cancel_request`
 *     on a cancel while one is pending, and PermissionNotFoundError for any later answer;
 *   - every resource_link of a prompt is inlined: its URI is parsed again (WHATWG URL, as the real
 *     engine does, so %2e%2e is "..", %41 is "A", and # or ? cut the path) and the file read; an
 *     unreadable one fails the prompt -32603 InvalidRequestError "Internal service failure" before
 *     any model request (measured for # and ? names, s43 review SEC-1);
 *   - a cancel during a provider retry's backoff answers {stopReason:"cancelled",
 *     _meta:{"opencode/retry":{…}}} (result-protocol Q6(c)); every other answer has `_meta: {}`;
 *   - exit 0 on stdin EOF, exit 130 on SIGTERM (an in-flight prompt first fails with ClientError).
 *
 * Prompt scripts: the first word of the first text block.
 *   echo <text>        say <text>
 *   slow <ms>          "part 1", wait <ms> (cancellable), "part 2"
 *   hang               a chunk, then wait for cancel/close/delete → cancelled
 *   deaf               a chunk, ignores session/cancel; close/delete end it cancelled
 *   crash              a chunk, then exit 3 (its server goes ≤100 ms later by itself, as the real one does)
 *   serverdie          kill the private server: this prompt fails ClientError
 *   delegate           root → orchestrator (S1) → dataops (S2), the full measured sequence
 *   delegatepar        two dataops children of the root in parallel (same description)
 *   delegatehang       like delegate, but S2 waits for a cancel (→ interrupted, cancelled)
 *   resume <child>     a later turn resumes <child> (a child of this root from an earlier turn) by its
 *                      sessionID (s43 Q7 run J): the root's subagent call goes in_progress with
 *                      rawInput.sessionID=<child> TWICE, then the child reports `running` with NO
 *                      `created` and its first (stale) title, an update, `completed`, and the call
 *                      completes with rawOutput.metadata.sessionID; then "resumed"
 *   resumepar <child>  the same, with a fresh dataops call in progress first (its own new child is
 *                      created after the resumed one starts): "resumed 2"
 *   resumesame         run J itself: a fresh child runs and completes, then the same turn resumes it
 *                      (`resume` on a child the gateway still tracks): "resumed"
 *   ask                S1 asks a permission on the root id: once/always → "done";
 *                      reject → "declined"; cancelled outcome or an error answer → cancelled
 *   error auth|400|500 the measured provider errors (500: two retry notices first)
 *   retrywait          a session_info_update announcing provider retry attempt 2, then wait for a
 *                      cancel: answered {stopReason:"cancelled", _meta:{"opencode/retry":{attempt:2,…}}}
 *                      with no usage_update (the measured shape of a cancel during the backoff)
 *   read <p…> | <answer> [|| <corrected>]   read tool calls (completed if the file exists under
 *                      the session cwd, failed "File not found: <abs>" otherwise), then <answer>
 *                      ("\n" → newline); a later prompt starting "Citation check FAILED" gets <corrected>
 *   attached           say "<path>: <content>" for each resource_link the engine read (one per
 *                      line; "attached nothing" when there is none)
 *   kid / kidhang      start a detached grandchild with GEOCLUSTER_RUN_DIR=runs/<sessionId>, say
 *                      "kid <pid>"; kidhang then waits for a cancel and leaves the kid running
 *   kiddetach          a backgrounded job (`sh -c '… &'`, double fork) with GEOCLUSTER_RUN_DIR=
 *                      runs/<sessionId>: re-parented away from the engine at once, as `nohup … &`
 *                      in a tool shell is; say "kid <pid>", end_turn (the job keeps running)
 *   lost <script…>     the first time in this process: the engine forgets the session's binding
 *                      and answers -32602 "session not found" (as after a restart or a session/close);
 *                      once the session is bound again, the same prompt runs <script…>
 *   mcpreconnect       print the stderr line `mcp connected` (the engine re-initialized its MCP),
 *                      say "reconnected"
 *   origin             say "new", "resume" or "load": how this process bound the session
 *   model              say the session's model
 *   anything else      "unknown script: <text>"
 *
 * Test knobs. The gateway gives the engine a whitelisted env only, so a test sets knobs in its
 * OPENCODE_BIN wrapper before importing this file:
 *   #!/abs/path/to/node
 *   process.env.FAKE_OPENCODE_KNOBS = "/tmp/x/knobs.json"
 *   import("/abs/path/runtime/test/fake-opencode.mjs")
 * FAKE_OPENCODE_* variables are left out of agentInfo._meta.envKeys. Knobs (env or the JSON file,
 * which is re-read at each start, so a test can change them between restarts):
 *   FAKE_OPENCODE_MCP_DELAY_MS     when the MCP line is printed (default 100)
 *   FAKE_OPENCODE_MCP_FAIL=1       always `mcp connect failed`, even with the MCP up (tools missing)
 *   FAKE_OPENCODE_NO_CHILD_CAP=1   initialize without the child-session capability
 *   FAKE_OPENCODE_EXIT_AT_START=N  exit N right away (a broken engine)
 *   FAKE_OPENCODE_SIGTERM_EXIT_MS  how long after SIGTERM it exits (default 20): a slow stop
 *   FAKE_OPENCODE_ATTACH_MAX_KB    an inlined resource_link above this fails the prompt -32603
 *                                  ClientError "Internal service failure" (the real engine fails so
 *                                  between 5 and 10 MB); unset: no limit
 *   FAKE_OPENCODE_PERMISSION_WITHDRAW_MS   `ask`: when nobody answered the permission within this,
 *                                  the engine withdraws it itself ($/cancel_request) and the late
 *                                  answer fails the prompt PermissionNotFoundError
 *   FAKE_OPENCODE_EFFORTS          knobs-only object: model ID → effort choices ({value,name,description?});
 *                                  unspecified models use their managed catalog efforts
 *   FAKE_OPENCODE_CONFIG_UPDATES   emit raw config_option_update frames during setters, before the response
 *   FAKE_OPENCODE_TRAP_FILE        a one-shot trap, checked on every request (default:
 *                                  fake-opencode-trap.json next to the knobs file). A test writes
 *                                  {"method": "<ACP method>", "action": "die"|"serverdie",
 *                                  "sessionId"?: "<only for this id>"}; the first matching request
 *                                  deletes the file (so a restarted engine doesn't fire it again), then
 *                                  "die": the engine SIGKILLs itself without answering (an OOM kill);
 *                                  "serverdie": its private server is SIGKILLed and the request is
 *                                  answered -32603 ClientError (what the real engine answers then)
 */
import { spawn } from "node:child_process"
import crypto from "node:crypto"
import fs from "node:fs"
import http from "node:http"
import path from "node:path"
import readline from "node:readline"
import { fileURLToPath } from "node:url"

const env = process.env
const KNOBS = (() => {
	try {
		return env.FAKE_OPENCODE_KNOBS ? JSON.parse(fs.readFileSync(env.FAKE_OPENCODE_KNOBS, "utf8")) : {}
	} catch {
		return {}
	}
})()
const knob = (name) => KNOBS[name] ?? env[name]

if (knob("FAKE_OPENCODE_EXIT_AT_START")) process.exit(Number(knob("FAKE_OPENCODE_EXIT_AT_START")) || 3)

const MODELS = knob("FAKE_OPENCODE_MODELS") ?? [
	{ value: "proxy/openai/gpt-6-luna", name: "GPT-6 Luna" },
	{ value: "proxy/z-ai/glm-5.3-flash", name: "GLM 5.3 Flash" },
	{ value: "proxy/google/gemini-3.8-flash", name: "Gemini 3.8 Flash" },
	{ value: "proxy/deepseek/deepseek-v4.1-flash", name: "DeepSeek V4.1 Flash" },
	{ value: "proxy/openai/gpt-6.1-sol", name: "GPT 6.1 Sol" },
	{ value: "proxy/anthropic/claude-haiku-5.5", name: "Claude Haiku 5.5" },
	{ value: "proxy/anthropic/claude-opus-5.5", name: "Claude Opus 5.5" },
	{ value: "proxy/xiaomi/mimo-v2.6-pro", name: "MiMo-V2.6-Pro" },
]
const MODEL_EFFORTS = {
	"proxy/openai/gpt-6-luna": ["none", "low", "medium", "high", "xhigh", "max"],
	"proxy/z-ai/glm-5.3-flash": ["low", "high", "max"],
	"proxy/google/gemini-3.8-flash": ["low", "medium", "high"],
	"proxy/deepseek/deepseek-v4.1-flash": ["low", "high", "max"],
	"proxy/openai/gpt-6.1-sol": ["low", "medium", "high", "xhigh", "max"],
	"proxy/anthropic/claude-haiku-5.5": ["low", "medium", "high", "xhigh", "max"],
	"proxy/anthropic/claude-opus-5.5": ["low", "medium", "high", "xhigh", "max"],
	"proxy/xiaomi/mimo-v2.6-pro": [],
}
const effortsFor = (model) => knob("FAKE_OPENCODE_EFFORTS")?.[model] ?? (MODEL_EFFORTS[model]?.length ? [...MODEL_EFFORTS[model], "default"].map((value) => ({ value, name: value[0].toUpperCase() + value.slice(1) })) : [])
const MODES = [
	{ value: "geology", name: "geology", description: "Layer 1 Geology Agent: user-facing, read-only, delegates analysis to the orchestrator." },
	{ value: "report-analysis", name: "report-analysis", description: "Report Analysis mode: answers one Mining-evals question over an extracted report; read-only like Layer 1." },
	{ value: "standard", name: "standard", description: "Standard mode: OpenCode's own coding prompt with every tool, outside the specialist system." },
]
const AVAILABLE_COMMANDS = [
	{ name: "init", description: "guided AGENTS.md setup" },
	{ name: "review", description: "review changes [commit|branch|pr], defaults to uncommitted" },
]
const USAGE = { inputTokens: 10, outputTokens: 5, totalTokens: 15 }
/** The env values initialize reports (agentInfo._meta.env); every other variable is reported by name only. */
const ECHOED_ENV = new Set([
	"HOME",
	"LANG",
	"XDG_DATA_HOME",
	"XDG_STATE_HOME",
	"XDG_CACHE_HOME",
	"XDG_CONFIG_HOME",
	"OPENCODE_CONFIG_DIR",
	"OPENCODE_MODELS_PATH",
	"OPENCODE_CONFIG_PROJECT_DISABLE",
	"OPENCODE_DISABLE_PROJECT_CONFIG",
	"OPENCODE_DISABLE_MODELS_FETCH",
	"OPENCODE_DISABLE_AUTOUPDATE",
	"OPENCODE_PRINT_LOGS",
	"GEOCLUSTER_MCP_URL",
	"GEOCLUSTER_TOOL_HOME",
	"GEOCLUSTER_RUN_DIR",
	"LLM_PROXY_URL",
])
const CLIENT_ERROR = { code: -32603, message: "Internal error: Internal service failure", data: { errorName: "ClientError" } }
const INVALID_REQUEST = { code: -32603, message: "Internal error: Internal service failure", data: { errorName: "InvalidRequestError" } }
const PAGE_SIZE = 100
const TRAP_FILE = knob("FAKE_OPENCODE_TRAP_FILE") ?? (env.FAKE_OPENCODE_KNOBS ? path.join(path.dirname(env.FAKE_OPENCODE_KNOBS), "fake-opencode-trap.json") : null)

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms))
const base62 = (n) => {
	const alphabet = "0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz"
	return Array.from(crypto.randomBytes(n), (b) => alphabet[b % 62]).join("")
}
const newSessionId = () => `ses_${base62(26)}`
const newMessageId = () => `msg_${base62(26)}`
let callCounter = 0
const newCallId = () => `call_${++callCounter}`
const rpcError = (code, message, data) => Object.assign(new Error(message), { rpc: { code, message, data } })
const notFound = (sessionId) => rpcError(-32602, `Invalid params: session not found: ${sessionId}`, { sessionId })

// ---- wire ----------------------------------------------------------------------------------------

function send(message) {
	try {
		process.stdout.write(`${JSON.stringify({ jsonrpc: "2.0", ...message })}\n`)
	} catch {
		// stdout closed: the client is gone
	}
}
const notify = (method, params) => send({ method, params })
let nextEngineRequestId = 0 // the engine's own request ids start at 0 (measured)
const outbound = new Map()
function request(method, params) {
	const id = nextEngineRequestId++
	send({ id, method, params })
	return { id, answer: new Promise((resolve) => outbound.set(id, resolve)) }
}

// ---- the private server child ------------------------------------------------------------------

// Like the real `serve`, it goes away when acp does (the real one exits ~140 ms after a SIGKILL of acp)
const SERVER_SRC = "const p=process.ppid;setInterval(()=>{let gone=process.ppid!==p;try{process.kill(p,0)}catch{gone=true}if(gone)process.exit(0)},100)"
const server = spawn(process.execPath, ["-e", SERVER_SRC, "serve", "--stdio", "--port", "0"], { stdio: "ignore" })
let serverDead = false
server.once("exit", () => {
	serverDead = true
	// acp logs nothing and never respawns it; in-flight prompts fail ~50 ms later (measured 53 ms)
	for (const s of bound.values()) {
		const turn = s.turn
		if (turn) setTimeout(() => turn.fail(CLIENT_ERROR), 50)
	}
})
/**
 * Checked on every request, not only from the "exit" event: a SIGKILLed server is a zombie, or already
 * reaped, before Node emits "exit", and a request handled in between must still fail (the real
 * engine notices through its connection to the server).
 */
function serverIsDead() {
	if (serverDead) return true
	try {
		process.kill(server.pid, 0)
		const stat = fs.readFileSync(`/proc/${server.pid}/stat`, "utf8")
		return stat.slice(stat.lastIndexOf(")") + 2, stat.lastIndexOf(")") + 3) === "Z"
	} catch (error) {
		return error?.code === "ESRCH" || error?.code === "ENOENT"
	}
}
/** `crash`: like the real one, the server outlives acp (~140 ms) and goes away by itself (its parent watch) */
let serverOutlivesExit = false
process.on("exit", () => {
	if (serverOutlivesExit) return
	try {
		server.kill("SIGKILL")
	} catch {}
})

// ---- MCP readiness line (stderr only, once) -------------------------------------------------------

function logLine(level, rest) {
	process.stderr.write(`timestamp=${new Date().toISOString()} level=${level} run=fake0001 ${rest} role=server\n`)
}
setTimeout(
	() => {
		const url = String(env.GEOCLUSTER_MCP_URL ?? "")
		const healthz = url.replace(/\/mcp\/?$/, "/healthz")
		const failed = () =>
			logLine("WARN", 'message="mcp connect failed" server=geocluster status.status=failed status.error="Unable to connect. Is the computer able to access the url?"')
		if (!/^http:\/\//.test(healthz) || String(knob("FAKE_OPENCODE_MCP_FAIL")) === "1") return failed()
		let done = false
		const finish = (ok) => {
			if (done) return
			done = true
			if (ok) logLine("INFO", 'message="mcp connected" server=geocluster tools=3')
			else failed()
		}
		const req = http.get(healthz, { timeout: 1000 }, (res) => {
			res.resume()
			finish(res.statusCode === 200)
		})
		req.on("timeout", () => {
			req.destroy()
			finish(false)
		})
		req.on("error", () => finish(false))
	},
	Number(knob("FAKE_OPENCODE_MCP_DELAY_MS") ?? 100),
).unref()

// ---- sessions ------------------------------------------------------------------------------------

const storeFile = path.join(env.XDG_DATA_HOME || path.join(env.HOME || "/tmp", ".local", "share"), "fake-opencode", "sessions.json")
function loadStore() {
	try {
		return JSON.parse(fs.readFileSync(storeFile, "utf8"))
	} catch {
		return {}
	}
}
const store = loadStore() // id → {sessionId, cwd, title, createdAt, updatedAt, parentId, mode, model, effort, history, correction}
function saveStore() {
	fs.mkdirSync(path.dirname(storeFile), { recursive: true })
	const tmp = `${storeFile}.${process.pid}.tmp`
	fs.writeFileSync(tmp, JSON.stringify(store))
	fs.renameSync(tmp, storeFile)
}
function touch(session) {
	session.updatedAt = new Date().toISOString()
	saveStore()
}
function createSession({ cwd, parentId = null, title = null }) {
	const now = new Date().toISOString()
	const session = {
		sessionId: newSessionId(),
		cwd,
		title: title ?? `New session - ${now}`,
		createdAt: now,
		updatedAt: now,
		parentId,
		mode: "geology",
		model: MODELS[0].value,
		effort: "default",
		history: [],
		correction: null,
	}
	store[session.sessionId] = session
	saveStore()
	return session
}

/** Sessions this process has created, resumed or loaded: sessionId → {origin, turn} */
const bound = new Map()
/** Sessions whose binding the `lost` script already dropped in this process */
const lostOnce = new Set()

function configOptions(session) {
	return [
		{ id: "model", name: "Model", category: "model", type: "select", currentValue: session.model, options: MODELS },
		...(effortsFor(session.model).length ? [{
			id: "effort",
			name: "Effort",
			description: "Available effort levels for this model",
			category: "thought_level",
			type: "select",
			currentValue: session.effort,
			options: effortsFor(session.model),
		}] : []),
		{ id: "mode", name: "Session Mode", category: "mode", type: "select", currentValue: session.mode, options: MODES },
	]
}

function boundSession(sessionId) {
	const b = bound.get(sessionId)
	const session = store[sessionId]
	if (!b || !session) throw notFound(sessionId)
	return { b, session }
}

function setMode(session, modeId) {
	if (typeof modeId !== "string") {
		throw rpcError(-32602, "Invalid params", { _errors: [], modeId: { _errors: ["Invalid input: expected string, received undefined"] } })
	}
	if (!MODES.some((m) => m.value === modeId)) throw rpcError(-32602, `Invalid params: mode not found: ${modeId}`, { mode: modeId })
	session.mode = modeId
	touch(session)
}

/** Cancel a running prompt (close/delete force it: even a "deaf" turn ends). */
function cancelTurn(sessionId, force) {
	const turn = bound.get(sessionId)?.turn
	if (turn) turn.cancel(force)
}

function childrenOf(sessionId) {
	const out = []
	for (const s of Object.values(store)) if (s.parentId === sessionId) out.push(s.sessionId, ...childrenOf(s.sessionId))
	return out
}

// ---- requests ------------------------------------------------------------------------------------

function validCwd(cwd) {
	try {
		return typeof cwd === "string" && path.isAbsolute(cwd) && fs.statSync(cwd).isDirectory()
	} catch {
		return false
	}
}

function bindExisting(params, origin) {
	const sessionId = params?.sessionId
	if (origin === "load" && !/^ses_/.test(String(sessionId))) {
		throw rpcError(-32603, "Internal error: Internal service failure", { errorName: "InvalidRequestError" })
	}
	const session = store[sessionId]
	if (!session) throw notFound(sessionId)
	if (params.cwd && path.resolve(params.cwd) !== session.cwd) {
		throw rpcError(-32602, `Invalid params: session ${sessionId} does not belong to cwd: ${params.cwd}`, { sessionId, cwd: params.cwd })
	}
	const previous = bound.get(sessionId)
	bound.set(sessionId, { origin, turn: previous?.turn ?? null })
	notify("session/update", { sessionId, update: { sessionUpdate: "available_commands_update", availableCommands: AVAILABLE_COMMANDS } })
	return session
}

const handlers = {
	initialize() {
		const agentCapabilities = {
			loadSession: true,
			mcpCapabilities: { http: true, sse: false },
			promptCapabilities: { embeddedContext: true, image: true },
			sessionCapabilities: { close: {}, delete: {}, fork: {}, list: {}, resume: {} },
		}
		if (knob("FAKE_OPENCODE_NO_CHILD_CAP") !== "1") agentCapabilities._meta = { "opencode/child-session-updates": true }
		return {
			protocolVersion: 1,
			agentCapabilities,
			authMethods: [{ description: "Run `opencode auth login` in the terminal", name: "Login with opencode", id: "opencode-login" }],
			agentInfo: {
				name: "OpenCode",
				version: "2.0.19",
				// for wiring asserts: what the gateway gave this process
				_meta: {
					envKeys: Object.keys(env)
						.filter((k) => !k.startsWith("FAKE_OPENCODE_"))
						.sort(),
					// values only for these non-secret names: never echo a whole environment
					env: Object.fromEntries(Object.entries(env).filter(([k]) => ECHOED_ENV.has(k))),
					argv: process.argv.slice(2),
					pid: process.pid,
					serverPid: server.pid,
					cwd: process.cwd(),
				},
			},
		}
	},

	"session/new"(params) {
		if (!Array.isArray(params?.mcpServers)) {
			const got = params?.mcpServers === undefined ? "Required value is missing" : `Invalid input: expected array, received ${typeof params.mcpServers}`
			throw rpcError(-32602, "Invalid params", { _errors: [], mcpServers: { _errors: [got] } })
		}
		if (!validCwd(params.cwd)) throw rpcError(CLIENT_ERROR.code, CLIENT_ERROR.message, CLIENT_ERROR.data)
		const session = createSession({ cwd: path.resolve(params.cwd) })
		bound.set(session.sessionId, { origin: "new", turn: null })
		notify("session/update", { sessionId: session.sessionId, update: { sessionUpdate: "available_commands_update", availableCommands: AVAILABLE_COMMANDS } })
		return { sessionId: session.sessionId, configOptions: configOptions(session) }
	},

	"session/set_mode"(params) {
		const { session } = boundSession(params?.sessionId)
		setMode(session, params.modeId)
		return {}
	},

	"session/set_config_option"(params) {
		const { session } = boundSession(params?.sessionId)
		const { configId, value } = params
		if (configId === "model") {
			if (!MODELS.some((m) => m.value === value)) {
				throw rpcError(-32602, `Invalid params: model not found: ${value}`, { providerId: String(value).split("/")[0], modelId: value })
			}
			// 2.0.19 keeps the effort (variant) only when the model stays the same
			if (session.model !== value) session.effort = "default"
			session.model = value
			touch(session)
		} else if (configId === "effort") {
			if (!effortsFor(session.model).some((e) => e.value === value)) throw rpcError(-32602, `Invalid params: effort not found: ${value}`, { effort: value })
			session.effort = value
			touch(session)
		} else if (configId === "mode") {
			setMode(session, value)
		} else {
			throw rpcError(-32602, `Invalid params: unknown config option: ${configId}`, { configId })
		}
		if (knob("FAKE_OPENCODE_CONFIG_UPDATES")) notify("session/update", { sessionId: session.sessionId, update: { sessionUpdate: "config_option_update", configOptions: configOptions(session) } })
		return { configOptions: configOptions(session) }
	},

	"session/resume"(params) {
		const session = bindExisting(params, "resume")
		return { configOptions: configOptions(session) }
	},

	"session/load"(params) {
		const session = bindExisting(params, "load")
		for (const m of session.history) {
			const sessionUpdate = m.role === "user" ? "user_message_chunk" : "agent_message_chunk"
			notify("session/update", { sessionId: session.sessionId, update: { sessionUpdate, messageId: m.messageId, content: { type: "text", text: m.text } } })
		}
		return { configOptions: configOptions(session) }
	},

	"session/close"(params) {
		if (typeof params?.sessionId !== "string") throw rpcError(-32602, "Invalid params", { _errors: [], sessionId: { _errors: ["Required value is missing"] } })
		cancelTurn(params.sessionId, true)
		bound.delete(params.sessionId)
		return {}
	},

	"session/delete"(params) {
		if (typeof params?.sessionId !== "string") throw rpcError(-32602, "Invalid params", { _errors: [], sessionId: { _errors: ["Required value is missing"] } })
		for (const id of [params.sessionId, ...childrenOf(params.sessionId)]) {
			cancelTurn(id, true)
			bound.delete(id)
			delete store[id]
		}
		saveStore()
		return {}
	},

	"session/list"(params) {
		if (params?.cwd !== undefined && !path.isAbsolute(String(params.cwd))) throw rpcError(CLIENT_ERROR.code, CLIENT_ERROR.message, CLIENT_ERROR.data)
		let offset = 0
		if (params?.cursor) {
			try {
				offset = JSON.parse(Buffer.from(String(params.cursor), "base64").toString("utf8")).offset
				if (!Number.isInteger(offset) || offset < 0) throw new Error("bad cursor")
			} catch {
				throw rpcError(-32603, "Internal error: Internal service failure", { errorName: "InvalidCursorError" })
			}
		}
		const all = Object.values(store)
			.filter((s) => params?.cwd === undefined || s.cwd === params.cwd)
			.sort((a, b) => (a.updatedAt < b.updatedAt ? 1 : a.updatedAt > b.updatedAt ? -1 : 0))
		const page = all.slice(offset, offset + PAGE_SIZE)
		const sessions = page.map((s) => ({ sessionId: s.sessionId, cwd: s.cwd, title: s.title, updatedAt: s.updatedAt }))
		// like the real engine: a cursor on every non-empty page, the end is an empty page
		const nextCursor = page.length ? Buffer.from(JSON.stringify({ offset: offset + page.length })).toString("base64") : undefined
		return nextCursor ? { sessions, nextCursor } : { sessions }
	},

	"session/prompt"(params) {
		const { b, session } = boundSession(params?.sessionId)
		if (b.turn) {
			throw rpcError(-32603, `Internal error: Session already has an active ACP prompt: ${session.sessionId}`, { service: "session" })
		}
		return runPrompt(b, session, params)
	},
}

/** Notifications: only session/cancel; never an answer, never an error (measured). */
function onNotification(method, params) {
	if (method === "session/cancel") cancelTurn(params?.sessionId, false)
}

/** The one-shot trap for this request (FAKE_OPENCODE_TRAP_FILE), consumed when it matches. */
function takeTrap(method, params) {
	if (!TRAP_FILE) return null
	let trap
	try {
		trap = JSON.parse(fs.readFileSync(TRAP_FILE, "utf8"))
	} catch {
		return null
	}
	if (trap?.method !== method || (trap.sessionId && trap.sessionId !== params?.sessionId)) return null
	try {
		fs.unlinkSync(TRAP_FILE)
	} catch {
		return null // another engine process took it
	}
	return trap
}

async function onRequest(message) {
	const { id, method, params } = message
	const handler = handlers[method]
	if (!handler) return send({ id, error: { code: -32601, message: `"Method not found": ${method}`, data: { method } } })
	if (method !== "initialize" && serverIsDead()) return send({ id, error: CLIENT_ERROR })
	const trap = takeTrap(method, params)
	if (trap?.action === "die") {
		process.kill(process.pid, "SIGKILL") // no answer, like an OOM kill; the server follows (it watches its parent)
		return
	}
	if (trap?.action === "serverdie") {
		serverDead = true
		server.kill("SIGKILL")
		return send({ id, error: CLIENT_ERROR })
	}
	try {
		const result = await handler(params ?? {})
		send({ id, result: result ?? {} })
	} catch (error) {
		if (error?.rpc) send({ id, error: error.rpc })
		else send({ id, error: { code: -32603, message: `Internal error: ${error?.message ?? error}`, data: { errorName: "FakeError" } } })
	}
}

// ---- turns ---------------------------------------------------------------------------------------

/**
 * One running prompt. `wait(ms)` resolves true when the turn was cancelled meanwhile; `fail(err)`
 * ends the prompt with a JSON-RPC error (the server died). Once the response is sent the turn is
 * done and later frames from its script are dropped.
 */
function newTurn(sessionId) {
	const turn = {
		sessionId,
		done: false,
		cancelled: false,
		deaf: false,
		forced: false,
		waiters: new Set(),
		failure: null,
	}
	turn.failed = new Promise((_, reject) => (turn.rejectFailed = reject))
	turn.failed.catch(() => {})
	turn.cancel = (force) => {
		if (force) turn.forced = true
		if (turn.deaf && !force) return
		turn.cancelled = true
		for (const wake of turn.waiters) wake()
	}
	turn.fail = (error) => {
		if (turn.done) return
		turn.rejectFailed(Object.assign(new Error(error.message), { rpc: error }))
	}
	turn.wait = (ms) =>
		new Promise((resolve) => {
			if (turn.cancelled) return resolve(true)
			const wake = () => {
				clearTimeout(timer)
				turn.waiters.delete(wake)
				resolve(true)
			}
			const timer = setTimeout(() => {
				turn.waiters.delete(wake)
				resolve(turn.cancelled)
			}, ms)
			turn.waiters.add(wake)
		})
	turn.untilCancelled = () => turn.wait(2 ** 31 - 1)
	return turn
}

async function runPrompt(b, session, params) {
	const turn = newTurn(session.sessionId)
	b.turn = turn
	const first = (Array.isArray(params.prompt) ? params.prompt : []).find((block) => block?.type === "text")
	const text = String(first?.text ?? "").trim()
	session.history.push({ role: "user", messageId: newMessageId(), text })
	if (session.title.startsWith("New session - ") && !session.parentId) session.title = "Fake title"
	touch(session)
	try {
		turn.attachments = readAttachments(params.prompt)
		const outcome = await Promise.race([runScript(turn, session, text), turn.failed])
		// Real 2.0.19 sends no usage_update for a cancelled turn in which no model step finished (a
		// cancelled HANG: user, agent, end); a cancelled delegation still sends one (real-engine contract test)
		if (outcome?.stopReason !== "cancelled" || turn.stepFinished) {
			update(turn, { sessionUpdate: "usage_update", used: USAGE.totalTokens, size: 200000, cost: { amount: 0, currency: "USD" } })
		}
		return { stopReason: outcome?.stopReason ?? "end_turn", usage: { ...USAGE }, _meta: outcome?._meta ?? {} }
	} finally {
		turn.done = true
		if (b.turn === turn) b.turn = null
		saveStore()
	}
}

/**
 * The engine inlines every resource_link into the user message: it parses the URI again (WHATWG URL)
 * and reads that file. What it can't read fails the prompt before any model request (measured: a `#`
 * or `?` in an unencoded file:// URI → InvalidRequestError); one above FAKE_OPENCODE_ATTACH_MAX_KB
 * fails ClientError, as the real engine does with ~10 MB.
 */
function readAttachments(prompt) {
	const out = []
	const maxKb = Number(knob("FAKE_OPENCODE_ATTACH_MAX_KB")) || 0
	const fail = (error) => Object.assign(new Error(error.message), { rpc: error })
	for (const block of Array.isArray(prompt) ? prompt : []) {
		if (block?.type !== "resource_link") continue
		let file
		let text
		try {
			file = fileURLToPath(new URL(String(block.uri)))
			const stat = fs.statSync(file)
			if (maxKb && stat.size > maxKb * 1024) throw fail(CLIENT_ERROR)
			text = fs.readFileSync(file, "utf8")
		} catch (error) {
			throw error?.rpc ? error : fail(INVALID_REQUEST)
		}
		out.push({ uri: block.uri, path: file, text })
	}
	return out
}

/** A root session/update frame (dropped once the turn has answered). */
function update(turn, upd) {
	if (turn.done) return
	// a root tool call means a model step finished: a cancelled turn then still reports usage (measured)
	if (upd.sessionUpdate === "tool_call") turn.stepFinished = true
	notify("session/update", { sessionId: turn.sessionId, update: upd })
}

function say(turn, session, text, messageId = newMessageId()) {
	update(turn, { sessionUpdate: "agent_message_chunk", messageId, content: { type: "text", text } })
	const last = session.history[session.history.length - 1]
	if (last?.messageId === messageId) last.text += text
	else session.history.push({ role: "agent", messageId, text })
	return messageId
}

/**
 * A child session, as the engine reports it: status and update frames on the root's stream.
 * `existing`: a stored child being resumed (it keeps its first title, measured).
 */
function makeChild(turn, session, parent, depth, title, existing = null) {
	const child = existing ?? createSession({ cwd: session.cwd, parentId: parent.sessionId, title })
	if (existing) title = existing.title
	const meta = { id: child.sessionId, parentID: parent.sessionId, depth, title }
	const head = { rootSessionId: session.sessionId, childSessionId: child.sessionId, parentSessionId: parent.sessionId, depth, title }
	return {
		id: child.sessionId,
		status(status, extra = {}) {
			if (!turn.done) notify("opencode/session/child_update", { ...head, type: "status", status, ...extra })
		},
		update(upd) {
			if (!turn.done) notify("opencode/session/child_update", { ...head, type: "update", update: { ...upd, _meta: { "opencode/child-session": meta } } })
		},
	}
}

const textContent = (text) => [{ type: "content", content: { type: "text", text } }]
const RESULT_JSON = (taskId) => `{\n  "type": "completion",\n  "status": "success",\n  "results": {\n    "summary": "ok"\n  },\n  "task_id": "${taskId}"\n}`

/** The subagent tool call as one party sees it: `emit` is the root's update() or a child's update(). */
function subagentCall(emit, callId, title, rawInput) {
	const head = { toolCallId: callId, kind: "think", title, locations: [] }
	return {
		pending: () => emit({ sessionUpdate: "tool_call", ...head, status: "pending", rawInput: {} }),
		inProgress: () => emit({ sessionUpdate: "tool_call_update", ...head, status: "in_progress", rawInput }),
		completed: (childId, text) =>
			emit({
				sessionUpdate: "tool_call_update",
				toolCallId: callId,
				status: "completed",
				content: textContent(`<subagent sessionID="${childId}" state="completed">\n${text}\n</subagent>`),
				rawOutput: { metadata: { sessionID: childId, status: "completed", truncated: false } },
			}),
		failed: (message, childId) =>
			emit({
				sessionUpdate: "tool_call_update",
				toolCallId: callId,
				status: "failed",
				content: textContent(message),
				rawOutput: { metadata: { sessionID: childId, status: "running" }, error: message },
			}),
	}
}

const CANCELLED = { stopReason: "cancelled" }
const END = { stopReason: "end_turn" }

async function runScript(turn, session, text) {
	if (text.startsWith("Citation check FAILED")) {
		say(turn, session, session.correction ?? "(no correction)")
		return END
	}
	const word = text.split(/\s+/)[0]
	const rest = text.slice(word.length).trim()
	const rootUpdate = (upd) => update(turn, upd)
	switch (word) {
		case "echo":
			say(turn, session, rest)
			return END

		case "slow": {
			const id = say(turn, session, "part 1")
			if (await turn.wait(Number(rest) || 500)) return CANCELLED
			say(turn, session, "part 2", id)
			return END
		}

		case "hang":
			say(turn, session, "hanging")
			await turn.untilCancelled()
			return CANCELLED

		case "deaf":
			turn.deaf = true
			say(turn, session, "not listening")
			await turn.untilCancelled()
			return CANCELLED

		case "crash":
			say(turn, session, "about to crash")
			// The server is not killed with acp: killing it at the same instant let the supervisor's server watch see
			// it gone before acp's exit, so the exit was sometimes reported "server_died" instead of "crash"
			serverOutlivesExit = true
			process.exit(3)
			break

		case "serverdie":
			say(turn, session, "killing the server")
			server.kill("SIGKILL")
			return new Promise(() => {}) // the server's exit fails this turn (ClientError)

		case "delegate":
		case "delegatehang":
			return delegate(turn, session, rootUpdate, word === "delegatehang")

		case "delegatepar":
			return delegatePar(turn, session, rootUpdate)

		case "resume":
		case "resumepar":
			return resume(turn, session, rootUpdate, rest.split(/\s+/)[0], word === "resumepar")

		case "resumesame": {
			const first = subagentCall(rootUpdate, newCallId(), "subagent", { agent: "dataops", description: "first pass", prompt: "RESULT first" })
			first.pending()
			first.inProgress()
			const kid = makeChild(turn, session, session, 1, "first pass")
			kid.status("created")
			first.inProgress()
			kid.status("running")
			if (await turn.wait(10)) return CANCELLED
			kid.status("completed")
			first.completed(kid.id, RESULT_JSON(kid.id))
			return resume(turn, session, rootUpdate, kid.id, false)
		}

		case "ask":
			return ask(turn, session, rootUpdate)

		case "error":
			return providerError(turn, rest)

		case "retrywait": {
			// result-protocol Q6(c): a cancel during the backoff answers with the retry state, and no
			// "retry over" (opencode/retry: null) is sent
			const retry = {
				attempt: 2,
				nextRetryAt: new Date(Date.now() + 60000).toISOString(),
				error: { type: "provider.internal", message: "upstream exploded", status: 500 },
			}
			update(turn, { sessionUpdate: "session_info_update", _meta: { "opencode/retry": retry } })
			await turn.untilCancelled()
			return { stopReason: "cancelled", _meta: { "opencode/retry": retry } }
		}

		case "read":
			return readScript(turn, session, rest, rootUpdate)

		case "attached":
			say(turn, session, turn.attachments.length ? turn.attachments.map((a) => `${a.path}: ${a.text.trim()}`).join("\n") : "attached nothing")
			return END

		case "kiddetach": {
			// `job &` in a shell that exits at once: the job's parent is gone before any tree snapshot
			const sh = spawn("/bin/sh", ["-c", `'${process.execPath}' -e 'setInterval(()=>{},1e6)' </dev/null >/dev/null 2>&1 & echo $!`], {
				detached: true,
				stdio: ["ignore", "pipe", "ignore"],
				env: { ...env, GEOCLUSTER_RUN_DIR: `runs/${session.sessionId}` },
			})
			let out = ""
			sh.stdout.on("data", (chunk) => (out += chunk))
			await new Promise((resolve) => sh.once("close", resolve))
			say(turn, session, `kid ${Number(out.trim())}`)
			return END
		}

		case "lost":
			if (!lostOnce.has(session.sessionId)) {
				lostOnce.add(session.sessionId)
				bound.delete(session.sessionId)
				throw notFound(session.sessionId)
			}
			return runScript(turn, session, rest)

		case "mcpreconnect":
			logLine("INFO", 'message="mcp connected" server=geocluster tools=3')
			say(turn, session, "reconnected")
			return END

		case "kid":
		case "kidhang": {
			const kid = spawn(process.execPath, ["-e", "setInterval(()=>{},1e6)"], {
				detached: true,
				stdio: "ignore",
				env: { ...env, GEOCLUSTER_RUN_DIR: `runs/${session.sessionId}` },
			})
			kid.unref()
			say(turn, session, `kid ${kid.pid}`)
			if (word === "kid") return END
			await turn.untilCancelled() // and the kid keeps running: the gateway must reap it
			return CANCELLED
		}

		case "origin":
			say(turn, session, bound.get(session.sessionId)?.origin ?? "unbound")
			return END

		case "model":
			say(turn, session, session.model)
			return END

		default:
			say(turn, session, `unknown script: ${text}`)
			return END
	}
}

/** root → orchestrator S1 → dataops S2 (Q7, 2026-10-01); `hang`: S2 waits for a cancel. */
async function delegate(turn, session, rootUpdate, hang) {
	const rootCall = subagentCall(rootUpdate, newCallId(), "subagent", {
		agent: "orchestrator",
		description: "task for orchestrator",
		prompt: "DELEGATE dataops RESULT ok",
	})
	rootCall.pending()
	rootCall.inProgress()
	if (await turn.wait(20)) return CANCELLED
	const s1 = makeChild(turn, session, session, 1, "task for orchestrator")
	s1.status("created")
	rootCall.inProgress() // the duplicate in_progress, right after `created` (the only early link)
	s1.status("running")
	const s1Call = subagentCall(s1.update, `${s1.id}:${newCallId()}`, "task for orchestrator: subagent", {
		agent: "dataops",
		description: "task for dataops",
		prompt: "RESULT ok",
	})
	const interruptS1 = () => {
		rootCall.failed(`Tool execution interrupted (sessionID: ${s1.id})`, s1.id)
		s1.status("interrupted")
		return CANCELLED
	}
	if (await turn.wait(10)) return interruptS1()
	s1Call.pending()
	s1Call.inProgress()
	if (await turn.wait(20)) return interruptS1()
	const s2 = makeChild(turn, session, { sessionId: s1.id }, 2, "task for dataops")
	s2.status("created")
	s1Call.inProgress()
	s2.status("running")
	// measured order on a root cancel: S1's tool fails, S1 interrupted, the root's tool fails, S2 interrupted
	const interruptBoth = () => {
		s1Call.failed(`Tool execution interrupted (sessionID: ${s2.id})`, s2.id)
		s1.status("interrupted")
		rootCall.failed(`Tool execution interrupted (sessionID: ${s1.id})`, s1.id)
		s2.status("interrupted")
		return CANCELLED
	}
	if (hang) {
		s2.update({ sessionUpdate: "agent_message_chunk", messageId: newMessageId(), content: { type: "text", text: "working…" } })
		await turn.untilCancelled()
		return interruptBoth()
	}
	if (await turn.wait(20)) return interruptBoth()
	s2.update({ sessionUpdate: "agent_message_chunk", messageId: newMessageId(), content: { type: "text", text: "```json\n" + RESULT_JSON(s2.id) + "\n```" } })
	s2.status("completed")
	s1Call.completed(s2.id, RESULT_JSON(s2.id))
	if (await turn.wait(10)) return interruptS1()
	s1.update({ sessionUpdate: "agent_message_chunk", messageId: newMessageId(), content: { type: "text", text: `parent done: ${s2.id}` } })
	s1.status("completed")
	rootCall.completed(s1.id, `parent done: ${s2.id}`)
	if (await turn.wait(10)) return CANCELLED
	say(turn, session, "delegated")
	return END
}

/** Two children of the root in parallel, same description: linking by order, confirmed at completion. */
async function delegatePar(turn, session, rootUpdate) {
	const n = newCallId()
	const input = { agent: "dataops", description: "task for dataops", prompt: "RESULT ok" }
	const calls = [subagentCall(rootUpdate, `${n}_0`, "subagent", input), subagentCall(rootUpdate, `${n}_1`, "subagent", input)]
	for (const call of calls) call.pending()
	for (const call of calls) call.inProgress()
	if (await turn.wait(20)) return CANCELLED
	const kids = []
	for (const call of calls) {
		const kid = makeChild(turn, session, session, 1, "task for dataops")
		kid.status("created")
		call.inProgress()
		kid.status("running")
		kids.push(kid)
	}
	const interruptAll = () => {
		kids.forEach((kid, i) => {
			calls[i].failed(`Tool execution interrupted (sessionID: ${kid.id})`, kid.id)
			kid.status("interrupted")
		})
		return CANCELLED
	}
	if (await turn.wait(20)) return interruptAll()
	kids.forEach((kid, i) => {
		kid.update({ sessionUpdate: "agent_message_chunk", messageId: newMessageId(), content: { type: "text", text: RESULT_JSON(kid.id) } })
		kid.status("completed")
		calls[i].completed(kid.id, RESULT_JSON(kid.id))
	})
	say(turn, session, "delegated 2")
	return END
}

/**
 * The root resumes a specialist of an earlier turn by its sessionID (s43 Q7 run J; geology.md resumes
 * the orchestrator so on every follow-up). The resuming call names the child in rawInput.sessionID on
 * its in_progress, sent twice, BEFORE the child's `running`; there is no `created`, and the child keeps
 * its first title. `parallel`: a fresh dataops call is already in progress, and its new child is
 * created after the resumed one started.
 */
async function resume(turn, session, rootUpdate, childId, parallel) {
	const stored = store[childId]
	if (!stored || stored.parentId !== session.sessionId) {
		say(turn, session, `not a child of this conversation: ${childId}`)
		return END
	}
	let fresh = null
	if (parallel) {
		fresh = subagentCall(rootUpdate, newCallId(), "subagent", { agent: "dataops", description: "task for dataops", prompt: "RESULT ok" })
		fresh.pending()
		fresh.inProgress()
	}
	const call = subagentCall(rootUpdate, newCallId(), "subagent", {
		agent: "orchestrator",
		description: "follow-up for orchestrator",
		prompt: "RESULT again",
		sessionID: childId,
	})
	call.pending()
	call.inProgress()
	if (await turn.wait(20)) return CANCELLED
	call.inProgress() // the duplicate comes before `running` for a resumed child
	const kid = makeChild(turn, session, session, 1, null, stored)
	kid.status("running")
	let freshKid = null
	if (fresh) {
		freshKid = makeChild(turn, session, session, 1, "task for dataops")
		freshKid.status("created")
		fresh.inProgress()
		freshKid.status("running")
	}
	const interrupt = () => {
		call.failed(`Tool execution interrupted (sessionID: ${kid.id})`, kid.id)
		kid.status("interrupted")
		if (freshKid) {
			fresh.failed(`Tool execution interrupted (sessionID: ${freshKid.id})`, freshKid.id)
			freshKid.status("interrupted")
		}
		return CANCELLED
	}
	if (await turn.wait(20)) return interrupt()
	kid.update({ sessionUpdate: "agent_message_chunk", messageId: newMessageId(), content: { type: "text", text: "resumed work" } })
	freshKid?.update({ sessionUpdate: "agent_message_chunk", messageId: newMessageId(), content: { type: "text", text: RESULT_JSON(freshKid.id) } })
	if (await turn.wait(10)) return interrupt()
	kid.status("completed")
	call.completed(kid.id, RESULT_JSON(kid.id))
	if (freshKid) {
		freshKid.status("completed")
		fresh.completed(freshKid.id, RESULT_JSON(freshKid.id))
	}
	say(turn, session, parallel ? "resumed 2" : "resumed")
	return END
}

/** A specialist asks for a shell command; the request arrives on the ROOT id (Q12). */
async function ask(turn, session, rootUpdate) {
	const rootCall = subagentCall(rootUpdate, newCallId(), "subagent", { agent: "dataops", description: "task for dataops", prompt: "rm -rf build" })
	rootCall.pending()
	rootCall.inProgress()
	const s1 = makeChild(turn, session, session, 1, "task for dataops")
	s1.status("created")
	rootCall.inProgress()
	s1.status("running")
	const toolCallId = `${s1.id}:call_p`
	s1.update({ sessionUpdate: "tool_call", toolCallId, title: "task for dataops: shell", kind: "execute", status: "pending", locations: [], rawInput: {} })
	const { id, answer } = request("session/request_permission", {
		sessionId: session.sessionId,
		toolCall: { toolCallId, title: "task for dataops: rm -rf build", kind: "execute", status: "pending", rawInput: { command: "rm -rf build" } },
		options: [
			{ optionId: "once", kind: "allow_once", name: "Allow once" },
			{ optionId: "always", kind: "allow_always", name: "Always allow" },
			{ optionId: "reject", kind: "reject_once", name: "Reject" },
		],
	})
	// While the request is pending, a cancel withdraws it: $/cancel_request, then ANY answer is an error.
	// FAKE_OPENCODE_PERMISSION_WITHDRAW_MS: the engine withdraws it on its own when nobody answered
	let withdrawn = false
	const cancelled = turn.untilCancelled().then(() => "cancel")
	const withdrawMs = Number(knob("FAKE_OPENCODE_PERMISSION_WITHDRAW_MS")) || 0
	const racers = [answer.then((reply) => ({ reply })), cancelled]
	if (withdrawMs > 0) racers.push(sleep(withdrawMs).then(() => "withdraw"))
	const first = await Promise.race(racers)
	let reply
	if (first === "cancel" || first === "withdraw") {
		withdrawn = true
		notify("$/cancel_request", { requestId: id })
		if (turn.forced) return CANCELLED // session/close or session/delete: nobody will answer
		reply = await answer
	} else {
		reply = first.reply
	}
	if (withdrawn) {
		throw rpcError(-32603, "Internal error: Internal service failure", { errorName: "PermissionNotFoundError" })
	}
	const outcome = reply.result?.outcome
	const declined = (message) => {
		s1.update({ sessionUpdate: "tool_call_update", toolCallId, status: "failed", content: textContent(message), rawOutput: { error: message } })
		s1.status("interrupted")
		rootCall.failed(`Subagent cancelled (sessionID: ${s1.id})`, s1.id)
	}
	if (reply.error || outcome?.outcome !== "selected") {
		declined("The user declined this tool call")
		return CANCELLED
	}
	if (outcome.optionId === "reject") {
		declined("The user declined this tool call")
		say(turn, session, "declined")
		return END
	}
	// answered first: a cancel now ends the turn cleanly
	if (await turn.wait(30)) {
		s1.status("interrupted")
		rootCall.failed(`Tool execution interrupted (sessionID: ${s1.id})`, s1.id)
		return CANCELLED
	}
	s1.update({ sessionUpdate: "tool_call_update", toolCallId, status: "completed", content: textContent("removed build/"), rawOutput: { metadata: { exit: 0 } } })
	s1.status("completed")
	rootCall.completed(s1.id, "removed build/")
	say(turn, session, "done")
	return END
}

async function providerError(turn, kind) {
	if (kind === "auth") throw rpcError(-32000, "Authentication required: provider authentication required", {})
	if (kind === "400") throw rpcError(-32603, "Internal error: bad request body", { service: "session", errorName: "provider.invalid-request" })
	if (kind === "500") {
		const error = { type: "provider.internal", message: "upstream exploded", status: 500 }
		update(turn, {
			sessionUpdate: "session_info_update",
			_meta: { "opencode/retry": { attempt: 2, nextRetryAt: new Date(Date.now() + 30).toISOString(), error } },
		})
		if (await turn.wait(30)) return CANCELLED
		update(turn, { sessionUpdate: "session_info_update", _meta: { "opencode/retry": null } })
		throw rpcError(-32603, "Internal error: upstream exploded", { service: "session", errorName: "provider.internal" })
	}
	throw rpcError(-32603, `Internal error: unknown fake error ${kind}`, { service: "session", errorName: "provider.unknown" })
}

async function readScript(turn, session, spec, rootUpdate) {
	const [main, corrected] = spec.split("||").map((s) => s.trim())
	const bar = main.indexOf("|")
	const paths = (bar >= 0 ? main.slice(0, bar) : main).split(/\s+/).filter(Boolean)
	const answer = (bar >= 0 ? main.slice(bar + 1) : "").trim().replace(/\\n/g, "\n")
	for (const p of paths) {
		const toolCallId = newCallId()
		const head = { toolCallId, kind: "read", title: "read" }
		rootUpdate({ sessionUpdate: "tool_call", ...head, status: "pending", locations: [], rawInput: {} })
		rootUpdate({ sessionUpdate: "tool_call_update", ...head, status: "in_progress", locations: [{ path: p }], rawInput: { path: p } })
		if (await turn.wait(5)) return CANCELLED
		const abs = path.resolve(session.cwd, p)
		let body = null
		try {
			const stat = fs.statSync(abs)
			body = stat.isDirectory()
				? `Read directory ${p}, entries 1-${fs.readdirSync(abs).length}\n${fs.readdirSync(abs).join("\n")}`
				: (() => {
						const lines = fs.readFileSync(abs, "utf8").split("\n").slice(0, 20)
						return `Read file ${p}, lines 1-${lines.length}\n${lines.map((l, i) => `${i + 1}: ${l}`).join("\n")}`
					})()
		} catch {
			body = null
		}
		if (body !== null) {
			// the completed frame carries no path (measured): the gateway must remember it from in_progress
			rootUpdate({ sessionUpdate: "tool_call_update", toolCallId, status: "completed", content: textContent(body), rawOutput: { metadata: { truncated: false } } })
		} else {
			const message = `File not found: ${abs}`
			rootUpdate({
				sessionUpdate: "tool_call_update",
				...head,
				status: "failed",
				locations: [{ path: abs }],
				rawInput: { path: p },
				content: textContent(message),
				rawOutput: { metadata: {}, error: message },
			})
		}
	}
	session.correction = corrected ? corrected.replace(/\\n/g, "\n") : null
	say(turn, session, answer)
	return END
}

// ---- main loop -----------------------------------------------------------------------------------

process.stdout.on("error", () => process.exit(0)) // EPIPE: the client is gone
const rl = readline.createInterface({ input: process.stdin, crlfDelay: Infinity })
rl.on("line", (line) => {
	const trimmed = line.trim()
	if (!trimmed) return
	let message
	try {
		message = JSON.parse(trimmed)
	} catch {
		process.stderr.write(`fake-opencode: bad JSON line: ${trimmed.slice(0, 200)}\n`)
		return
	}
	if (typeof message.method === "string" && message.id !== undefined) {
		void onRequest(message)
	} else if (typeof message.method === "string") {
		onNotification(message.method, message.params)
	} else if (message.id !== undefined) {
		const resolve = outbound.get(message.id)
		outbound.delete(message.id)
		resolve?.(message.error ? { error: message.error } : { result: message.result })
	}
})
// stdin EOF: exit 0 at once, no answer to an in-flight prompt (measured)
rl.on("close", () => process.exit(0))

process.on("SIGTERM", () => {
	// measured: an in-flight prompt is answered ClientError, then acp exits 130 (its server with it)
	try {
		server.kill("SIGTERM")
	} catch {}
	for (const b of bound.values()) b.turn?.fail(CLIENT_ERROR)
	setTimeout(() => process.exit(130), Number(knob("FAKE_OPENCODE_SIGTERM_EXIT_MS") ?? 20))
})
