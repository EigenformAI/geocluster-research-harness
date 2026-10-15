#!/usr/bin/env node
/**
 * End-to-end smoke against a running api-3 gateway (one `opencode acp` for every conversation, one
 * shared geocluster MCP), through the public gate (agent and file traffic have separate upstreams).
 *
 *   node runtime/test/gateway-smoke.mjs --url http://127.0.0.1:3000 [--cookie C] [--write]
 *        [--files-url http://127.0.0.1:3000] [--gate-secret S]
 *        [--prompt "<short prompt>"] [--long-prompt "<prompt that streams for a while>"]
 *
 * --cookie is the browser cookie for the public gate. Local offline images use RUNTIME_AUTH_DISABLED=1.
 * To probe ACP directly on :3001, pass --gate-secret (the per-boot X-GC-Gate secret) and --files-url
 * pointing to the public gate: the gateway no longer serves /files. --files-url defaults to --url.
 *
 * Checks (one PASS/FAIL line each; SKIP = could not be tested here):
 *   - /livez; /readyz becomes 200 with api 3, build identity (same bootId as /livez, engine
 *     "opencode"), components.engine ready (generation, version), the SHARED MCP ready
 *     (components.mcp: state, pid, port) and the engine's geocluster tools connected; no api-2
 *     fields (resident, spare, maxAgents, per-conversation MCP servers);
 *   - initialize (gateway, api 3, features, extensions, no engine mcpCapabilities); _gc/status shape;
 *   - session/new: an opaque engine id (ses_…, treated as opaque), runs/<id>, model/effort options
 *     only; _gc/attach right after it (API-24), nothing logged before the first prompt;
 *   - a prompt: the gateway's user echo with seq and submissionId, usage_update forwarded, turn_end;
 *   - reconnect: _gc/attach replays from the log (replay flag, seq order), incremental attach;
 *   - session/list; cancel (sent once the engine has started the turn; _meta.reason "cancelled",
 *     API-09 processesStopped); busy (-32001 for a second prompt of the same conversation); a
 *     cancelled turn always ends;
 *   - early cancel: a cancel that arrives together with its prompt (one socket write: the prompt is
 *     still being admitted) ends that turn, reason "cancelled" (a dropped cancel FAILs; the smoke
 *     re-cancels after 5 s so it never hangs). Fixed 2026-10-01, was a known bug (s43 review TQ-2);
 *   - two conversations created and prompted at the same time from two sockets: routing (updates,
 *     _gc/child_update and _gc/turn_end only to their own socket), _gc/status afterwards;
 *   - the shared MCP is still the same process after every conversation;
 *   - the file API (list/text/raw/search/find, path escape, hidden state dir, search scope 404).
 *     --write also creates runs/smoke-<time>/, uploads one file with an operationId and checks its receipt
 *     (never on a shared workspace unless you mean it).
 * _gc/child_update frames (specialists) are tolerated anywhere: counted, routed, and part of the
 * seq bookkeeping. Every session/update reaches this script raw (the ACP SDK 0.13.1 client would
 * drop usage_update and strip messageId).
 *
 * The no-token path: on a machine without a usable model token, every turn ends after the
 * provider retries (about 2+4+8 s for a transport error, at once for a 401) as stopReason
 * "cancelled", _meta.reason "error", with an "Error: …" line in the transcript. The smoke accepts
 * that as a finished turn and says so ("no model token?"); it still proves the turn/replay/cancel
 * machinery. Per-turn timeout: ACP_SMOKE_TURN_TIMEOUT_MS (default 60 s, room for ~20 s no-token
 * turns); readiness wait: ACP_SMOKE_READY_TIMEOUT_MS (default 120 s).
 * Metadata discovery wait: ACP_SMOKE_FILES_TIMEOUT_MS (default 90 s, covering descendant reconciliation).
 *
 * Locally, against the fake engine (the prompts are its scripts; start the gateway with
 * OPENCODE_BIN = a wrapper around test/fake-opencode.mjs, RUNTIME_MCP_CMD/ARGS = node
 * test/fake-mcp.mjs and RUNTIME_GATE_DISABLED=1, as test/gateway-harness.mjs wires them):
 *   --prompt "echo OK" --long-prompt "hang"                every check
 *   --prompt "error 500" --long-prompt "error 500"         no token, retried provider errors
 *   --prompt "error auth" --long-prompt "error auth"       no token, an immediate 401 (cancel SKIPs)
 * Exit code 0 when every check passed (SKIP lines don't count).
 */
import { ClientSideConnection } from "@agentclientprotocol/sdk"
import WebSocket from "ws"

const args = process.argv.slice(2)
const opt = (name, fallback) => {
	const i = args.indexOf(name)
	return i === -1 ? fallback : args[i + 1]
}
const BASE = (opt("--url", "http://127.0.0.1:3000") || "").replace(/\/$/, "")
const FILES_BASE = (opt("--files-url", BASE) || "").replace(/\/$/, "")
const GATE_SECRET = opt("--gate-secret", process.env.RUNTIME_GATE_SECRET || "")
const COOKIE = opt("--cookie", "")
const PROMPT = opt("--prompt", "Reply with the single word OK and nothing else.")
const LONG_PROMPT = opt("--long-prompt", "Count from 1 to 300, one number per line, then write DONE.")
const WRITE = args.includes("--write")
const TURN_TIMEOUT_MS = Number(process.env.ACP_SMOKE_TURN_TIMEOUT_MS || 60_000)
const READY_TIMEOUT_MS = Number(process.env.ACP_SMOKE_READY_TIMEOUT_MS || 120_000)
const FILES_TIMEOUT_MS = Number(process.env.ACP_SMOKE_FILES_TIMEOUT_MS || 90_000)
/** A cancel the gateway dropped is re-sent after this, so the smoke never waits on a turn forever. */
const RECANCEL_MS = 5000

const headers = {}
if (GATE_SECRET) headers["x-gc-gate"] = GATE_SECRET
if (COOKIE) headers.cookie = COOKIE

let failures = 0
const check = (label, ok, detail = "") => {
	console.log(`${ok ? "PASS" : "FAIL"} ${label}${detail ? ` — ${detail}` : ""}`)
	if (!ok) failures++
}
const skip = (label, why) => console.log(`SKIP ${label} — ${why}`)
const info = (text) => console.log(`     ${text}`)
const t0 = Date.now()
const secs = (ms) => `${(ms / 1000).toFixed(1)} s`
const withTimeout = (p, ms, label) => {
	let timer
	return Promise.race([p, new Promise((_, reject) => (timer = setTimeout(() => reject(new Error(`${label} timed out after ${ms} ms`)), ms)))]).finally(() =>
		clearTimeout(timer),
	)
}
const settle = (p) =>
	p.then(
		(value) => value,
		(error) => ({ error: String(error?.message ?? error), code: error?.code, data: error?.data }),
	)
const say = (sessionId, text, _meta) => ({ sessionId, prompt: [{ type: "text", text }], ...(_meta ? { _meta } : {}) })
const isEngineId = (id) => typeof id === "string" && /^[A-Za-z0-9_-]{1,128}$/.test(id) && !/^\d{13}$/.test(id)
const API2_KEYS = ["resident", "spare", "maxAgents", "perConversation"]
const api2Leftovers = (object) => API2_KEYS.filter((k) => object && Object.hasOwn(object, k))

async function getJson(path, init = {}, base = BASE) {
	const res = await fetch(`${base}${path}`, { signal: AbortSignal.timeout(15_000), ...init, headers: { ...headers, ...(init.headers ?? {}) } })
	let body = null
	try {
		body = await res.json()
	} catch {
		body = null
	}
	return { status: res.status, body, headers: res.headers }
}

const getFilesJson = (path, init = {}) => getJson(path, init, FILES_BASE)
/** Each request starts a fresh metadata view; a frozen indexing page never becomes ready itself. */
async function discover(path, predicate = () => true) {
	const deadline = Date.now() + FILES_TIMEOUT_MS
	let result
	do {
		result = await getFilesJson(path)
		if (result.status !== 200 || (result.body?.coverage?.state === "ready" && predicate(result.body))) return result
		await new Promise((r) => setTimeout(r, 1000))
	} while (Date.now() < deadline)
	return result
}

/**
 * One browser socket. session/update is renamed before the SDK parses it, so every frame arrives
 * as sent (SDK 0.13.1 drops usage_update and strips messageId). `arrivals` holds updates and
 * notifications in arrival order; `waitFor` awaits the next matching one.
 */
function connect() {
	const ws = new WebSocket(`${BASE.replace(/^http/, "ws")}/agent`, "acp.jsonrpc.v1", { headers })
	const updates = []
	const notices = []
	const permissions = []
	const arrivals = []
	const waiters = new Set()
	const push = (entry) => {
		arrivals.push(entry)
		for (const waiter of [...waiters]) waiter(entry)
	}
	const client = {
		requestPermission: async (params) => {
			// OpenCode's agents have no `ask` rule; if one ever asks, decline (nothing is changed on the machine)
			permissions.push(params)
			const option = params.options.find((o) => o.kind === "reject_once") ?? params.options[params.options.length - 1]
			return { outcome: { outcome: "selected", optionId: option.optionId } }
		},
		sessionUpdate: async (params) => {
			updates.push(params)
			push({ kind: "update", sessionId: params.sessionId, seq: params.update?._meta?.seq, update: params.update })
		},
		extNotification: async (method, params) => {
			if (method === "_raw/session/update") return client.sessionUpdate(params)
			notices.push({ method, params })
			push({ kind: method, sessionId: params?.sessionId ?? null, seq: params?.seq, params })
		},
	}
	const readable = new ReadableStream({
		start(controller) {
			ws.on("message", (data) => {
				try {
					const msg = JSON.parse(data.toString())
					controller.enqueue(msg.method === "session/update" ? { ...msg, method: "_raw/session/update" } : msg)
				} catch {
					// not JSON: ignore
				}
			})
			ws.on("close", () => {
				try {
					controller.close()
				} catch {
					// closed
				}
			})
		},
	})
	// pairNext(method, message): the next frame with that method goes out in ONE socket write together
	// with `message`, so the gateway parses both in the same tick (no timing luck involved)
	let pair = null
	const writable = new WritableStream({
		write(message) {
			return new Promise((resolve) => {
				const together = pair && message.method === pair.method ? pair : null
				if (together) {
					pair = null
					ws._socket?.cork?.()
				}
				ws.send(JSON.stringify(message), () => resolve())
				if (together) {
					ws.send(JSON.stringify(together.message))
					process.nextTick(() => ws._socket?.uncork?.())
				}
			})
		},
	})
	const pairNext = (method, message) => (pair = { method, message })
	const opened = new Promise((resolve, reject) => {
		ws.once("open", resolve)
		ws.once("error", reject)
		ws.once("unexpected-response", (_req, res) => reject(new Error(`ws upgrade rejected: ${res.statusCode}`)))
	})
	opened.catch(() => {})
	const conn = new ClientSideConnection(() => client, { readable, writable })
	/**
	 * The first arrival at index >= from matching `pred`; null when `until` settles first or after
	 * `ms`. Never rejects.
	 */
	const waitFor = (pred, { from = 0, ms = TURN_TIMEOUT_MS, until = null } = {}) =>
		new Promise((resolve) => {
			const found = arrivals.slice(from).find(pred)
			if (found) return resolve(found)
			let timer = null
			const done = (value) => {
				clearTimeout(timer)
				waiters.delete(waiter)
				resolve(value)
			}
			const waiter = (entry) => pred(entry) && done(entry)
			waiters.add(waiter)
			timer = setTimeout(() => done(null), ms)
			until?.then(
				() => done(null),
				() => done(null),
			)
		})
	const mine = (sessionId) => arrivals.filter((e) => e.sessionId === sessionId)
	const maxSeq = () => Math.max(0, ...arrivals.filter((e) => e.kind === "update" || e.kind === "_gc/turn_end" || e.kind === "_gc/child_update").map((e) => e.seq ?? 0))
	return { ws, conn, updates, notices, permissions, arrivals, opened, waitFor, mine, maxSeq, pairNext }
}

async function open() {
	const c = connect()
	await withTimeout(c.opened, 15_000, "ws open")
	const init = await withTimeout(c.conn.initialize({ protocolVersion: 1, clientCapabilities: {} }), 60_000, "initialize")
	return { ...c, init }
}

/** A frame the engine produced for this turn (not the gateway's echo or its own "Error:" line). */
const isEngineFrame = (sessionId) => (e) =>
	e.sessionId === sessionId &&
	((e.kind === "update" && e.update?.sessionUpdate !== "user_message_chunk" && !e.update?._meta?.gateway) || e.kind === "_gc/child_update")
const isEcho = (sessionId) => (e) => e.sessionId === sessionId && e.kind === "update" && e.update?.sessionUpdate === "user_message_chunk"

/**
 * How a turn ended, from its response and what the socket saw since `from`:
 *   end_turn | no_token (cancelled, reason error, with an "Error:" line) | cancelled | other
 */
function outcome(c, sessionId, from, response) {
	if (!response || response.error) return { kind: "rejected", text: response?.error ?? "no response" }
	const errorLine = c.arrivals
		.slice(from)
		.find((e) => e.sessionId === sessionId && e.kind === "update" && e.update?.sessionUpdate === "agent_message_chunk" && e.update._meta?.gateway === "error")
	const reason = response._meta?.reason
	if (response.stopReason === "end_turn") return { kind: "end_turn" }
	if (response.stopReason === "cancelled" && reason === "error") {
		const text = errorLine?.update?.content?.text ?? ""
		return { kind: /^Error: /.test(text) ? "no_token" : "error_without_line", errorName: response._meta?.errorName ?? null, text }
	}
	if (response.stopReason === "cancelled") return { kind: "cancelled", reason: reason ?? null }
	return { kind: "other", stopReason: response.stopReason, reason: reason ?? null }
}

const finished = (o) => o.kind === "end_turn" || o.kind === "no_token"
const describe = (o, ms) =>
	o.kind === "no_token"
		? `cancelled/error after ${secs(ms)} (no model token? ${o.errorName}): ${o.text.slice(0, 160).replace(/\s+/g, " ")}`
		: `${o.kind}${o.reason ? `/${o.reason}` : ""} after ${secs(ms)}${o.text ? `: ${o.text}` : ""}`

async function main() {
	console.log(`gateway=${BASE}`)
	const live = await getJson("/livez")
	check("/livez is 200", live.status === 200, JSON.stringify(live.body))

	let ready = await getJson("/readyz")
	while (ready.status !== 200 && Date.now() - t0 < READY_TIMEOUT_MS) {
		await new Promise((r) => setTimeout(r, 1000)) // HTTP readiness has no event to wait on
		ready = await getJson("/readyz")
	}
	const components = ready.body?.components ?? {}
	check("/readyz becomes 200 (api 3)", ready.status === 200 && ready.body?.api === 3, `${ready.status} api=${ready.body?.api} ${JSON.stringify(components.engine ?? ready.body)}`)
	const build = ready.body?.build
	check(
		"/readyz reports build identity (engine opencode); /livez the same bootId",
		/^[0-9a-f-]{36}$/.test(build?.bootId ?? "") && live.body?.bootId === build.bootId && build.engine === "opencode",
		JSON.stringify(build),
	)
	const engine0 = components.engine ?? {}
	check(
		"readyz components.engine: ready, generation, version",
		engine0.state === "ready" && Number.isInteger(engine0.generation) && engine0.generation >= 1 && typeof engine0.version === "string",
		JSON.stringify(engine0),
	)
	const mcp0 = components.mcp ?? {}
	check(
		"readyz components.mcp: ONE shared MCP, ready (pid, port)",
		mcp0.state === "ready" && Number.isInteger(mcp0.pid) && Number.isInteger(mcp0.port) && mcp0.servers === undefined && mcp0.perConversation === undefined,
		JSON.stringify(mcp0),
	)
	check("the engine reached the shared MCP (components.engine.tools connected)", engine0.tools === "connected", `tools=${engine0.tools}`)
	check("/readyz has no api-2 fields (resident/spare/maxAgents)", api2Leftovers(ready.body).length === 0 && api2Leftovers(components).length === 0, api2Leftovers(ready.body).join(","))

	const a = await open()
	const meta = a.init.agentCapabilities?._meta ?? {}
	check("initialize via gateway (api 3)", meta.gateway === "geocluster-runtime" && meta.api === 3, JSON.stringify({ gateway: meta.gateway, api: meta.api, agent: a.init.agentInfo }))
	check(
		"initialize lists ACP features (replaySnapshot, childUpdates, submissionIds, archive, replayOrdering) and _gc/child_update",
		["replaySnapshot", "childUpdates", "submissionIds", "archive", "replayOrdering"].every((f) => meta.features?.includes(f)) && meta.extensions?.includes("_gc/child_update"),
		JSON.stringify(meta.features),
	)
	check("initialize: no engine mcpCapabilities; capacity.maxRunning", a.init.agentCapabilities?.mcpCapabilities === undefined && Number.isInteger(meta.capacity?.maxRunning), JSON.stringify(meta.capacity))

	const status0 = await a.conn.extMethod("_gc/status", {})
	check(
		"_gc/status (api 3: engine, mcp, sessions, running, capacity)",
		status0.engine?.state === "ready" &&
			Number.isInteger(status0.engine?.generation) &&
			status0.mcp?.state === "ready" &&
			Array.isArray(status0.sessions) &&
			Number.isInteger(status0.running) &&
			status0.capacity?.maxRunning === meta.capacity?.maxRunning &&
			api2Leftovers(status0).length === 0,
		JSON.stringify({ engine: status0.engine, mcp: status0.mcp, running: status0.running, capacity: status0.capacity, sessions: status0.sessions?.length }),
	)

	const created = await withTimeout(a.conn.newSession({ cwd: "/ignored", mcpServers: [], _meta: { agentMode: "standard" } }), 60_000, "session/new")
	const sessionId = created.sessionId
	check("session/new returns an engine id (opaque, not a 13-digit task id)", isEngineId(sessionId), sessionId)
	check("session/new returns the conversation's run folder", created._meta?.runDir === `runs/${sessionId}` && created._meta?.agentMode === "standard", JSON.stringify(created._meta))
	check(
		"session/new: model + effort options and models (the mode is fixed)",
		created.configOptions?.every((o) => ["model", "effort"].includes(o.id)) && created.models?.availableModels?.length > 0 && created.modes === null,
		`${created.models?.currentModelId} of ${created.models?.availableModels?.length}`,
	)
	// API-24: seen live 2026-09-28 as -32603 (ENOENT on the not-yet-written event log)
	const early = await settle(withTimeout(a.conn.extMethod("_gc/attach", { sessionId, afterSeq: 0 }), 30_000, "attach before any event"))
	check("_gc/attach right after session/new works", early.error === undefined && early.turn === "idle" && early.resident === true, JSON.stringify(early))
	check("nothing is logged before the first prompt (the engine's own commands are dropped)", early.lastSeq === 0, `lastSeq=${early.lastSeq}`)

	// ---- one turn ----
	let from = a.arrivals.length
	let started = Date.now()
	const turn = await settle(withTimeout(a.conn.prompt(say(sessionId, PROMPT, { submissionId: `smoke-${Date.now()}` })), TURN_TIMEOUT_MS, "prompt"))
	const first = outcome(a, sessionId, from, turn)
	check("prompt ends (end_turn, or the no-token error path)", finished(first), describe(first, Date.now() - started))
	const noToken = first.kind === "no_token"
	const turnEnd = await a.waitFor((e) => e.kind === "_gc/turn_end" && e.sessionId === sessionId, { from, ms: 5000 })
	check("_gc/turn_end received, with the submissionId", turnEnd !== null && turnEnd.params._meta?.submissionId === turn._meta?.submissionId && Number.isInteger(turnEnd.seq), JSON.stringify(turnEnd?.params))
	const userEcho = a.arrivals.slice(from).find(isEcho(sessionId))
	check("user turn is logged and broadcast with a seq and the submissionId", Number.isInteger(userEcho?.seq) && userEcho.update._meta?.submissionId === turn._meta?.submissionId)
	const seqs = a.mine(sessionId).map((e) => e.seq)
	check("seqs on the socket are strictly increasing", seqs.every((s, i) => i === 0 || s > seqs[i - 1]), JSON.stringify(seqs))
	if (first.kind === "end_turn") {
		const usage = a.arrivals.slice(from).find((e) => e.sessionId === sessionId && e.update?.sessionUpdate === "usage_update")
		check("usage_update forwarded (context used/size)", typeof usage?.update?.used === "number", JSON.stringify(usage?.update))
	} else skip("usage_update forwarded", "a failed turn sends none")
	const retries = a.arrivals.slice(from).filter((e) => e.update?.sessionUpdate === "session_info_update" && e.update._meta?.["opencode/retry"]).length
	if (retries) info(`${retries} provider retry notice(s) forwarded (session_info_update _meta["opencode/retry"])`)
	const lastSeq = a.maxSeq()

	// ---- reconnect and replay incrementally ----
	a.ws.close()
	const b = await open()
	const attached = await withTimeout(b.conn.extMethod("_gc/attach", { sessionId, afterSeq: 0 }), 30_000, "attach")
	check("_gc/attach reports lastSeq and idle turn", attached.lastSeq === lastSeq && attached.turn === "idle", JSON.stringify({ attached: attached.lastSeq, lastSeq, turn: attached.turn }))
	const replayed = b.mine(sessionId)
	check(
		"replayed updates carry the replay flag, in seq order",
		replayed.length > 0 &&
			replayed.every((e) => (e.kind === "update" ? e.update._meta?.replay === true : e.params?.replay === true)) &&
			replayed.every((e, i) => i === 0 || e.seq > replayed[i - 1].seq),
		`${replayed.length} replayed`,
	)
	const partial = await open()
	await partial.conn.extMethod("_gc/attach", { sessionId, afterSeq: lastSeq - 1 })
	check("incremental attach replays only newer events", partial.mine(sessionId).length <= 1, `${partial.mine(sessionId).length} replayed`)
	partial.ws.close()

	const listed = await withTimeout(b.conn.unstable_listSessions({}), 30_000, "session/list")
	const entry = listed.sessions?.find((s) => s.sessionId === sessionId)
	check("session/list includes the conversation (api-3 _meta)", entry !== undefined && entry._meta?.archived === false && entry._meta?.runDir === `runs/${sessionId}`, JSON.stringify(entry))
	const archived = (listed.sessions ?? []).filter((s) => s._meta?.archived).length
	info(`session/list: ${listed.sessions?.length} on the first page, ${archived} archived (api-1/2)`)

	// ---- a second turn, cancelled once the engine has started it ----
	from = b.arrivals.length
	started = Date.now()
	const turn2 = settle(withTimeout(b.conn.prompt(say(sessionId, LONG_PROMPT)), TURN_TIMEOUT_MS, "prompt#2"))
	const engineStarted = await b.waitFor(isEngineFrame(sessionId), { from, until: turn2 })
	let cancelledAt = null
	if (engineStarted) {
		cancelledAt = Date.now()
		await b.conn.cancel({ sessionId })
	}
	const r2 = await turn2
	const second = outcome(b, sessionId, from, r2)
	if (!engineStarted) {
		skip("cancel ends the turn", `the turn ended (${describe(second, Date.now() - started)}) before the engine sent anything`)
	} else {
		check(
			"cancel ends the turn (the engine honoured it; API-09 processes stopped)",
			second.kind === "cancelled" && [null, "cancelled"].includes(second.reason) && r2._meta?.processesStopped === true,
			`${describe(second, Date.now() - started)}; ${Date.now() - cancelledAt} ms after the cancel`,
		)
		check('a user cancel says _meta.reason "cancelled"', r2._meta?.reason === "cancelled", `_meta=${JSON.stringify(r2._meta)}`)
	}

	// ---- busy protection: a prompt while another runs is refused ----
	from = b.arrivals.length
	started = Date.now()
	const turn3 = settle(withTimeout(b.conn.prompt(say(sessionId, LONG_PROMPT)), TURN_TIMEOUT_MS, "prompt#3"))
	// the gateway echoes the prompt once the turn is running
	const running3 = await b.waitFor(isEcho(sessionId), { from, until: turn3 })
	if (running3) {
		const busy = await settle(withTimeout(b.conn.prompt(say(sessionId, "again")), TURN_TIMEOUT_MS, "busy prompt"))
		// A turn that fails at once (no token, HTTP 401) may end before the second prompt arrives
		const arrived = b.arrivals.slice(from)
		const end3 = arrived.findIndex((e) => e.kind === "_gc/turn_end" && e.sessionId === sessionId)
		const echoes = arrived.map((e, i) => (isEcho(sessionId)(e) ? i : -1)).filter((i) => i >= 0)
		if (busy.code === undefined && end3 >= 0 && echoes.length > 1 && end3 < echoes[1]) {
			skip("concurrent prompt is refused with -32001 session_busy", `the first turn had already ended (${outcome(b, sessionId, from, busy).kind}) when the second prompt arrived`)
		} else {
			check("concurrent prompt is refused with -32001 session_busy", busy.code === -32001 && /session_busy/.test(busy.error ?? ""), `${busy.code} ${busy.error ?? JSON.stringify(busy)}`)
		}
		await b.conn.cancel({ sessionId }).catch(() => {})
	} else {
		skip("concurrent prompt is refused with -32001 session_busy", "the turn ended before it was running")
	}
	// Ended by the engine, or by the gateway's cancel watchdog (RUNTIME_CANCEL_GRACE_S)
	const r3 = await turn3
	const third = outcome(b, sessionId, from, r3)
	check("a cancelled turn always ends", r3.stopReason === "cancelled", describe(third, Date.now() - started))

	// ---- a cancel that arrives together with its prompt (the user stops at once, or while the
	// conversation is re-bound after an engine restart: the prompt is still being admitted) ----
	from = b.arrivals.length
	started = Date.now()
	b.pairNext("session/prompt", { jsonrpc: "2.0", method: "session/cancel", params: { sessionId } })
	const turn4 = settle(withTimeout(b.conn.prompt(say(sessionId, LONG_PROMPT)), TURN_TIMEOUT_MS, "prompt#4"))
	let recancelled = false
	const recancel = setTimeout(() => {
		recancelled = true
		b.conn.cancel({ sessionId }).catch(() => {})
	}, RECANCEL_MS)
	const r4 = await turn4
	clearTimeout(recancel)
	const fourth = outcome(b, sessionId, from, r4)
	// Dropped: the turn ran on (until the re-cancel, or to its own end). The broker remembers a cancel that
	// arrives during admission; one that lands just after it reaches the engine: both end "cancelled"
	check(
		"a cancel that arrives with its prompt (same socket write) ends that turn",
		fourth.kind === "cancelled" && fourth.reason === "cancelled" && !recancelled,
		`${describe(fourth, Date.now() - started)}${recancelled ? `; DROPPED: the turn ran until a second cancel ${secs(RECANCEL_MS)} later` : ""}`,
	)
	const engineSaw = b.arrivals.slice(from).some(isEngineFrame(sessionId))
	info(`early cancel: ${engineSaw ? "the engine had started the turn (cancelled there)" : "the engine never saw the prompt (cancelled during admission)"}`)
	b.ws.close()

	// ---- concurrent conversations: two new chats from two sockets, prompted at the same time ----
	const c1 = await open()
	const c2 = await open()
	const [n1, n2] = await withTimeout(
		Promise.all([c1, c2].map((c) => c.conn.newSession({ cwd: "/ignored", mcpServers: [], _meta: { agentMode: "standard" } }))),
		120_000,
		"concurrent session/new",
	)
	check(
		"two session/new at once: distinct engine ids and run folders",
		isEngineId(n1.sessionId) && isEngineId(n2.sessionId) && n1.sessionId !== n2.sessionId && n1._meta?.runDir === `runs/${n1.sessionId}` && n2._meta?.runDir === `runs/${n2.sessionId}`,
		`${n1.sessionId} ${n2.sessionId}`,
	)
	started = Date.now()
	const both = await Promise.all([
		settle(withTimeout(c1.conn.prompt(say(n1.sessionId, PROMPT)), TURN_TIMEOUT_MS, "concurrent prompt 1")),
		settle(withTimeout(c2.conn.prompt(say(n2.sessionId, PROMPT)), TURN_TIMEOUT_MS, "concurrent prompt 2")),
	])
	const outcomes = [outcome(c1, n1.sessionId, 0, both[0]), outcome(c2, n2.sessionId, 0, both[1])]
	check("two prompts at once both end", outcomes.every(finished), outcomes.map((o) => describe(o, Date.now() - started)).join(" | "))
	const routed = (c, id) => c.arrivals.every((e) => e.sessionId === id || (e.sessionId === null && !["update", "_gc/turn_end", "_gc/child_update"].includes(e.kind)))
	check(
		"each socket only receives its own conversation's updates, child frames and turn ends",
		routed(c1, n1.sessionId) && routed(c2, n2.sessionId) && c1.mine(n1.sessionId).some((e) => e.kind === "_gc/turn_end") && c2.mine(n2.sessionId).some((e) => e.kind === "_gc/turn_end"),
		`${c1.arrivals.length}/${c2.arrivals.length} frames`,
	)
	const children = [c1, c2].flatMap((c) => c.notices.filter((n) => n.method === "_gc/child_update"))
	if (children.length) {
		check("_gc/child_update frames carry their root id, a seq and the child", children.every((n) => Number.isInteger(n.params.seq) && n.params.child?.sessionId), `${children.length} frames`)
	} else info("no _gc/child_update frames (no specialist ran)")
	const status1 = await c1.conn.extMethod("_gc/status", {})
	const bound = [n1, n2].map((n) => status1.sessions?.find((s) => s.sessionId === n.sessionId))
	check(
		"_gc/status afterwards: nothing running, both conversations bound and idle",
		status1.running === 0 && bound.every((s) => s?.bound === true && s.turn === "idle") && api2Leftovers(status1).length === 0,
		JSON.stringify({ running: status1.running, sessions: bound, engine: status1.engine?.state }),
	)
	const mcp1 = (await getJson("/readyz")).body?.components?.mcp
	check("the shared MCP served every conversation: still ready, same process", mcp1?.state === "ready" && mcp1.pid === mcp0.pid && mcp1.port === mcp0.port, JSON.stringify(mcp1))
	c1.ws.close()
	c2.ws.close()
	if (noToken || outcomes.some((o) => o.kind === "no_token")) info("turns ended on the no-token path: the model was never reached (expected without IDE_LLM_TOKEN/LLM_PROXY_URL)")

	// ---- file API ----
	info(`file API=${FILES_BASE}`)
	const filesInfo = await getFilesJson("/files/info")
	check("/files/info reports the ready v1 file service", filesInfo.status === 200 && filesInfo.body?.filesContractVersion === 1 && filesInfo.body?.ready === true && typeof filesInfo.body.workspaceEpoch === "string", `${filesInfo.status} ${JSON.stringify(filesInfo.body)}`)
	const list = await discover("/files/list?path=&limit=200")
	check("/files/list root (v1 items, eventual coverage)", list.status === 200 && list.body?.filesContractVersion === 1 && Array.isArray(list.body?.items) && list.body.coverage?.state === "ready", JSON.stringify({ items: list.body?.items?.slice(0, 3), coverage: list.body?.coverage }))
	// Metadata uses type; discovery's kind filter selects it. Choose a nonempty text-like regular file.
	const firstFile = list.body?.items?.find((e) => e.type === "file" && e.availability === "local" && e.sizeBytes > 0 && /\.(md|txt|csv|tsv|json|ya?ml)$/i.test(e.path))
	if (firstFile) {
		const text = await getFilesJson(`/files/text?path=${encodeURIComponent(firstFile.path)}`)
		check("/files/text reads a file (v1 text + observation)", text.status === 200 && text.body?.filesContractVersion === 1 && typeof text.body?.text === "string" && text.body.observation?.ref?.path === firstFile.path)
		const raw = await fetch(`${FILES_BASE}/files/raw?path=${encodeURIComponent(firstFile.path)}`, { headers: { ...headers, range: "bytes=0-3" }, signal: AbortSignal.timeout(15_000) })
		const bytes = await raw.arrayBuffer()
		check("/files/raw honours Range", raw.status === 206 && /^bytes 0-[0-3]\/\d+$/.test(raw.headers.get("content-range") ?? "") && bytes.byteLength === Math.min(4, firstFile.sizeBytes), `${raw.status} ${raw.headers.get("content-range")}`)
	} else skip("/files/text and /files/raw", "no nonempty, local text-like file on the root page")
	const runFolder = await getFilesJson(`/files/stat?path=${encodeURIComponent(`runs/${sessionId}`)}`)
	check("the conversation's run folder exists in the workspace", runFolder.status === 200 && runFolder.body?.type === "dir", `runs/${sessionId}: ${runFolder.status}`)
	const escape = await getFilesJson("/files/list?path=../")
	check("path escape is refused", escape.status === 403 || escape.status === 400, String(escape.status))
	const hidden = await getFilesJson("/files/list?path=.runtime")
	check("runtime state dir is hidden", hidden.status === 403 && hidden.body?.error === "protected_resource" && hidden.body.reason === "reserved_component", `${hidden.status} ${JSON.stringify(hidden.body)}`)
	const search = await getFilesJson("/files/search?q=a&maxResults=1")
	check("/files/search answers (v1 live search)", search.status === 200 && search.body?.filesContractVersion === 1 && Array.isArray(search.body?.results) && search.body.consistency === "local-live", `${search.status} ${search.body?.results?.length ?? search.body?.error}`)
	const noScope = await getFilesJson("/files/search?q=%23&path=__no_such_folder__&maxResults=1")
	check("/files/search on a missing folder is 404 (API-13)", noScope.status === 404, `${noScope.status} ${JSON.stringify(noScope.body)}`)
	if (firstFile) {
		const found = await discover(`/files/find?path=${encodeURIComponent(firstFile.path)}&q=${encodeURIComponent(firstFile.name)}&kind=file&limit=1`, (body) => body.items?.some((r) => r.path === firstFile.path))
		check("/files/find matches file names (q, kind, limit)", found.status === 200 && found.body?.coverage?.state === "ready" && found.body?.items?.some((r) => r.path === firstFile.path && r.type === "file"), `${found.status} ${JSON.stringify(found.body)}`)
	}
	if (WRITE) {
		const operationId = `smoke-${Date.now()}`
		const folder = `runs/${operationId}`
		const target = `${folder}/receipt.txt`
		const mkdir = await getFilesJson("/files/mkdir", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ path: folder, parents: true, operationId: `${operationId}-mkdir` }) })
		check("create the upload's contained parent with a mkdir receipt", mkdir.status === 200 && mkdir.body?.state === "committed", `${mkdir.status} ${JSON.stringify(mkdir.body)}`)
		const put = (body) => getFilesJson(`/files/upload?path=${encodeURIComponent(target)}&operationId=${operationId}`, { method: "PUT", body })
		const firstPut = await put("first\n")
		const firstBody = firstPut.body
		const source = firstBody?.publishedSource
		check("upload with operationId → 201 + committed capture digest", firstPut.status === 201 && firstBody?.filesContractVersion === 1 && firstBody.operationId === operationId && firstBody.state === "committed" && source?.ref?.path === target && source.digest?.state === "ready" && /^[0-9a-f]{64}$/.test(source.digest.sha256 ?? ""), `${firstPut.status} ${JSON.stringify(firstBody)}`)
		// Same-length bodies preserve declaredSize (part of the intent); changing intent must be refused.
		const retry = await put("other\n")
		check("retry with the same operationId writes nothing (duplicate receipt)", retry.status === 200 && retry.body?.duplicate === true && retry.body?.state === "committed" && source?.captureId && retry.body.publishedSource?.captureId === source.captureId && retry.body.publishedSource?.etag === source.etag, `${retry.status} ${JSON.stringify(retry.body)}`)
		const receipt = await getFilesJson(`/files/operations/${operationId}`)
		check("GET /files/operations/<operationId> returns the durable receipt", receipt.status === 200 && receipt.body?.operationId === operationId && receipt.body.state === "committed" && receipt.body.addresses?.some((ref) => ref.path === target) && receipt.body.publishedSource?.captureId === source?.captureId, JSON.stringify(receipt.body))
		const text = await getFilesJson(`/files/text?path=${encodeURIComponent(target)}`)
		check("the live file holds the first upload only", text.status === 200 && text.body?.text === "first\n" && text.body.complete === true && text.body.observation?.ref?.path === target, JSON.stringify(text.body))
		if (source?.captureId) {
			const captured = await getFilesJson(`/files/captures/${source.captureId}/text`)
			check("the protected capture holds the first upload and its digest", captured.status === 200 && captured.body?.text === "first\n" && captured.body.source?.digest?.sha256 === source.digest?.sha256 && captured.body.stable === true, JSON.stringify(captured.body))
		}
		const found = await discover(`/files/find?q=${encodeURIComponent(target)}&mode=raw-path&kind=file&limit=1`, (body) => body.items?.some((r) => r.path === target))
		check("uploaded file is eventually discoverable", found.status === 200 && found.body?.coverage?.state === "ready" && found.body.items?.some((r) => r.path === target), `${found.status} ${JSON.stringify(found.body)}`)
	}

	console.log(`${failures === 0 ? "ALL PASS" : `${failures} FAILED`} in ${secs(Date.now() - t0)}`)
	process.exit(failures === 0 ? 0 : 1)
}

main().catch((error) => {
	console.error("smoke aborted:", error)
	process.exit(1)
})
