#!/usr/bin/env node
/**
 * Real-model end-to-end check of concurrent conversations against a running api-3 gateway (one
 * `opencode acp` for every conversation, one shared geocluster MCP). Opt-in: it costs model credit,
 * so it uses a cheap model.
 *
 *   node runtime/test/concurrent-e2e.mjs --url http://127.0.0.1:3000 [--cookie C] \
 *     [--files-url http://127.0.0.1:3000] [--gate-secret S] \
 *     [--model proxy/z-ai/glm-5.3-flash] [--analysis "<prompt for a geology-mode conversation>"] \
 *     [--quick "<prompt for a standard one>"] [--filler "<prompt for the extra standard ones>"]
 *
 * --model is the engine's model id ("<provider>/<model>" from its `model` config option; the api-2
 * Cline ids such as openrouter/z-ai/glm-4.7-flash are refused -32602). The script aborts before any
 * prompt when the engine does not offer it.
 * Use the public gate for /files. Direct ACP probes need --files-url at the gate and --gate-secret
 * at the gateway. --files-url defaults to --url. Metadata discovery is eventually consistent;
 * E2E_FILES_TIMEOUT_MS (default 90 s) bounds its polling independently of model turns.
 *
 * Conversations, each on its own socket, all switched to --model:
 *   A  geology mode, the analysis: dispatches through the orchestrator to specialists;
 *   B  standard mode, a quick question;
 *   F  maxRunning - 2 more standard ones (--filler, default the quick question), so that A, B and
 *      the fillers fill the gateway's capacity (initialize._meta.capacity.maxRunning);
 *   C  one more standard one, prompted once the others run: refused with -32005 (capacity).
 * Permission requests are answered allow_once, but only after the capacity check (a turn waiting
 * for one is still running when C is refused; the shipped agents have no `ask` rule anyway).
 *
 * Checks: own engine ids and run folders; the model switch; C refused -32005 with data.maxRunning
 * while the others run; A and B end with end_turn (fillers are reported); every session/update,
 * _gc/child_update and _gc/turn_end reached only its own socket; A used tools and its specialists
 * streamed as _gc/child_update frames (created/running status, streamed content, each child linked
 * to the tool call that spawned it, depths and titles reported); A and B listed by session/list with
 * _meta.archived false; A's results/reports are in runs/<A>/ and each finished turn names its
 * exported report (runs/<id>/_reports/REPORT_<ts>.md, readable through the file API).
 * session/list is also counted before the run, archived (api-1/2) conversations separately.
 *
 * Per-turn timeout: E2E_TURN_TIMEOUT_MS (default 20 min). Exit code 0 when every check passed.
 * Locally against the fake engine, the prompts are its scripts, e.g. --analysis ask --quick ask
 * --filler ask (each specialist asks a permission, which holds the turn until the capacity check).
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
const MODEL = opt("--model", "proxy/z-ai/glm-5.3-flash") // the engine's model id: "<provider>/<model>"
const ANALYSIS = opt(
	"--analysis",
	"Using results/wamex_geochem_cleaned.csv, compute summary statistics of Au_ppm per prospect (count, mean, median, max) " +
		"and save them as a CSV table, plus one histogram of Au_ppm as a PNG. Keep the final answer short.",
)
const QUICK = opt("--quick", "In two sentences: what does README.md in this workspace say?")
const FILLER = opt("--filler", QUICK)
const TURN_TIMEOUT_MS = Number(process.env.E2E_TURN_TIMEOUT_MS || 20 * 60_000)
const FILES_TIMEOUT_MS = Number(process.env.E2E_FILES_TIMEOUT_MS || 90_000)

const headers = {}
if (GATE_SECRET) headers["x-gc-gate"] = GATE_SECRET
if (COOKIE) headers.cookie = COOKIE

let failures = 0
const check = (label, ok, detail = "") => {
	console.log(`${ok ? "PASS" : "FAIL"} ${label}${detail ? ` — ${detail}` : ""}`)
	if (!ok) failures++
}
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
const t0 = Date.now()
const elapsed = () => `${((Date.now() - t0) / 1000).toFixed(0)}s`
const say = (sessionId, text) => ({ sessionId, prompt: [{ type: "text", text }] })

/** Answered once the capacity check is done (see the header). */
let releasePermissions
const permissionsReleased = new Promise((resolve) => (releasePermissions = resolve))

/**
 * One socket. session/update is renamed before the SDK parses it, so frames arrive as sent (SDK
 * 0.13.1 drops usage_update and strips messageId). `arrivals`: updates and notifications in order.
 */
function connect(label) {
	const ws = new WebSocket(`${BASE.replace(/^http/, "ws")}/agent`, "acp.jsonrpc.v1", { headers })
	const updates = []
	const notices = []
	const arrivals = []
	const waiters = new Set()
	const push = (entry) => {
		arrivals.push(entry)
		for (const waiter of [...waiters]) waiter(entry)
	}
	const client = {
		requestPermission: async (params) => {
			await permissionsReleased
			const option = params.options.find((o) => o.kind === "allow_once") ?? params.options[0]
			console.log(`  [${label}] ${elapsed()} permission "${params.toolCall?.title}" -> ${option.optionId}`)
			return { outcome: { outcome: "selected", optionId: option.optionId } }
		},
		sessionUpdate: async (params) => {
			updates.push(params)
			push({ kind: "update", sessionId: params.sessionId, seq: params.update?._meta?.seq, update: params.update })
			const u = params.update
			if (u.sessionUpdate === "tool_call") console.log(`  [${label}] ${elapsed()} tool: ${u.title}`)
		},
		extNotification: async (method, params) => {
			if (method === "_raw/session/update") return client.sessionUpdate(params)
			notices.push({ method, params })
			push({ kind: method, sessionId: params?.sessionId ?? null, seq: params?.seq, params })
			if (method === "_gc/notice") console.log(`  [${label}] notice: ${params.message}`)
			if (method === "_gc/child_update" && params.type === "status") {
				console.log(`  [${label}] ${elapsed()} specialist ${params.child?.title ?? params.child?.sessionId} (depth ${params.child?.depth}): ${params.status}`)
			}
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
	const writable = new WritableStream({
		write(message) {
			return new Promise((resolve) => ws.send(JSON.stringify(message), () => resolve()))
		},
	})
	const opened = new Promise((resolve, reject) => {
		ws.once("open", resolve)
		ws.once("error", reject)
		ws.once("unexpected-response", (_req, res) => reject(new Error(`ws upgrade rejected: ${res.statusCode}`)))
	})
	opened.catch(() => {})
	/** The first arrival matching `pred`; null when `until` settles first or after `ms`. Never rejects. */
	const waitFor = (pred, { ms = 60_000, until = null } = {}) =>
		new Promise((resolve) => {
			const found = arrivals.find(pred)
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
	return { label, ws, conn: new ClientSideConnection(() => client, { readable, writable }), updates, notices, arrivals, opened, waitFor }
}

async function main() {
	const a = connect("A")
	await withTimeout(a.opened, 15_000, "ws open")
	const init = await a.conn.initialize({ protocolVersion: 1, clientCapabilities: {} })
	const maxRunning = init.agentCapabilities?._meta?.capacity?.maxRunning
	console.log(`gateway=${BASE} api=${init.agentCapabilities?._meta?.api} engine=${init.agentInfo?.name} ${init.agentInfo?.version} maxRunning=${maxRunning}`)
	if (!Number.isInteger(maxRunning) || maxRunning < 2) throw new Error(`needs a gateway that runs at least 2 conversations at once (capacity.maxRunning=${maxRunning})`)
	const b = connect("B")
	const c = connect("C")
	const fillers = Array.from({ length: maxRunning - 2 }, (_, i) => connect(`F${i + 1}`))
	const others = [b, c, ...fillers]
	await withTimeout(Promise.all(others.map((x) => x.opened)), 15_000, "ws open")
	await Promise.all(others.map((x) => x.conn.initialize({ protocolVersion: 1, clientCapabilities: {} })))

	const before = await a.conn.unstable_listSessions({})
	const archivedBefore = before.sessions.filter((s) => s._meta?.archived)
	console.log(
		`session/list before: ${before.sessions.length} (${archivedBefore.length} archived from api 1/2, ${archivedBefore.filter((s) => s._meta?.legacy).length} of them legacy)`,
	)

	const newSession = (x, agentMode) => x.conn.newSession({ cwd: "/ignored", mcpServers: [], _meta: { agentMode } })
	const [sa, sb, sc, ...sf] = await withTimeout(
		Promise.all([newSession(a, "geology"), newSession(b, "standard"), newSession(c, "standard"), ...fillers.map((f) => newSession(f, "standard"))]),
		180_000,
		"session/new",
	)
	const all = [sa, sb, sc, ...sf]
	check(
		"every conversation: own engine id and run folder",
		new Set(all.map((s) => s.sessionId)).size === all.length && all.every((s) => /^[A-Za-z0-9_-]+$/.test(s.sessionId) && s._meta?.runDir === `runs/${s.sessionId}`),
		all.map((s) => s._meta?.runDir).join(" "),
	)
	check("A is a geology conversation, B a standard one", sa._meta?.agentMode === "geology" && sb._meta?.agentMode === "standard", `${sa._meta?.agentMode} ${sb._meta?.agentMode}`)

	const models = (sa.models?.availableModels ?? []).map((m) => m.modelId)
	console.log(`model: ${MODEL} (was ${sa.models?.currentModelId}; the engine offers ${JSON.stringify(models)})`)
	if (!models.includes(MODEL)) throw new Error(`the engine does not offer ${MODEL}; pass --model with one of ${JSON.stringify(models)}`)
	const sockets = [a, b, c, ...fillers]
	await Promise.all(sockets.map((x, i) => x.conn.unstable_setSessionModel({ sessionId: all[i].sessionId, modelId: MODEL })))
	const current = await Promise.all(sockets.map((x, i) => x.conn.extMethod("_gc/attach", { sessionId: all[i].sessionId, afterSeq: 1e12 })))
	check(`every conversation now runs ${MODEL}`, current.every((s) => s.models?.currentModelId === MODEL), current.map((s) => s.models?.currentModelId).join(" "))

	// ---- A, B and the fillers at the same time; C once they all run ----
	const running = [a, b, ...fillers]
	const runningIds = [sa, sb, ...sf].map((s) => s.sessionId)
	console.log(`${elapsed()} prompting A (analysis), B (quick question)${fillers.length ? ` and ${fillers.length} filler(s)` : ""} at the same time`)
	const turns = running.map((x, i) =>
		settle(withTimeout(x.conn.prompt(say(runningIds[i], x === a ? ANALYSIS : x === b ? QUICK : FILLER)), TURN_TIMEOUT_MS, `turn ${x.label}`)),
	)
	// The gateway echoes a prompt once its turn runs: wait for every echo (or that turn's end)
	await Promise.all(
		running.map((x, i) => x.waitFor((e) => e.kind === "update" && e.sessionId === runningIds[i] && e.update.sessionUpdate === "user_message_chunk", { until: turns[i] })),
	)
	const st = await c.conn.extMethod("_gc/status", {})
	const refused = await settle(withTimeout(c.conn.prompt(say(sc.sessionId, "Say OK.")), 120_000, "turn C"))
	check(
		`a conversation beyond capacity is refused with -32005 while ${maxRunning} run`,
		refused.code === -32005 && refused.data?.maxRunning === maxRunning,
		`${refused.code} ${refused.error ?? `(it ran: ${refused.stopReason})`} data=${JSON.stringify(refused.data)}; running=${st.running}`,
	)
	releasePermissions()

	const results = await Promise.all(turns)
	console.log(`${elapsed()} turns ended`)
	const [ra, rb, ...rf] = results
	check("A (analysis through specialists) ends", ra.stopReason === "end_turn", JSON.stringify(ra))
	check("B (quick question) ends", rb.stopReason === "end_turn", JSON.stringify(rb))
	rf.forEach((r, i) => console.log(`  filler F${i + 1}: ${r.stopReason ?? r.error}${r._meta?.reason ? `/${r._meta.reason}` : ""}`))
	const textOf = (x, id) =>
		x.updates
			.filter((u) => u.sessionId === id && u.update.sessionUpdate === "agent_message_chunk")
			.map((u) => u.update.content?.text ?? "")
			.join("")
	console.log(`B said: ${textOf(b, sb.sessionId).slice(-300).replace(/\s+/g, " ")}`)
	console.log(`A said (end): ${textOf(a, sa.sessionId).slice(-400).replace(/\s+/g, " ")}`)

	const routed = (x, id) => x.arrivals.every((e) => e.sessionId === id || (e.sessionId === null && !["update", "_gc/turn_end", "_gc/child_update"].includes(e.kind)))
	check(
		"every update, child frame and turn end reached only its own socket",
		sockets.every((x, i) => routed(x, all[i].sessionId)),
		sockets.map((x) => `${x.label} ${x.arrivals.length}`).join(", "),
	)

	// ---- A's specialists ----
	const rootTools = a.updates.filter((u) => u.sessionId === sa.sessionId && u.update.sessionUpdate === "tool_call")
	check("A used tools (the dispatch card at least)", rootTools.length > 0, `${rootTools.length} root tool calls: ${[...new Set(rootTools.map((u) => u.update.title))].join(", ")}`)
	const childFrames = a.notices.filter((n) => n.method === "_gc/child_update").map((n) => n.params)
	const children = new Map() // child id -> its last frame
	for (const frame of childFrames) children.set(frame.child?.sessionId, frame)
	check(
		"A's specialists stream as _gc/child_update (status and content frames, with seqs)",
		children.size > 0 &&
			childFrames.some((f) => f.type === "status" && ["created", "running"].includes(f.status)) &&
			childFrames.some((f) => f.type === "update" && f.update?.sessionUpdate) &&
			childFrames.every((f) => f.sessionId === sa.sessionId && Number.isInteger(f.seq)),
		`${childFrames.length} frames from ${children.size} specialist(s): ${[...children.values()].map((f) => `${f.child.title ?? "?"} (depth ${f.child.depth}, ${f.status ?? "?"})`).join("; ")}`,
	)
	const rootCallIds = new Set(rootTools.map((u) => u.update.toolCallId))
	const unlinked = [...children.values()].filter((f) =>
		f.child.depth === 1 ? !rootCallIds.has(f.child.toolCallId) : !String(f.child.toolCallId ?? "").startsWith(`${f.child.parentSessionId}:`),
	)
	check(
		"each specialist is linked to the tool call that spawned it",
		children.size > 0 && unlinked.length === 0,
		unlinked.length ? `unlinked: ${JSON.stringify(unlinked.map((f) => f.child))}` : `${children.size} linked`,
	)
	const lastStatus = [...children.keys()].map((id) => childFrames.filter((f) => f.child.sessionId === id && f.type === "status").pop()?.status)
	console.log(`  specialists' final status: ${JSON.stringify(lastStatus)}`)

	// ---- listing, run folders, reports ----
	const after = await a.conn.unstable_listSessions({})
	check(
		"A and B listed by session/list (title, not archived, their agent)",
		[sa, sb].every((s) => after.sessions.some((x) => x.sessionId === s.sessionId && x.title && x._meta?.archived === false && x._meta?.agentMode === s._meta?.agentMode)),
	)
	const getJson = async (path) => {
		const res = await fetch(`${FILES_BASE}${path}`, { headers, signal: AbortSignal.timeout(15_000) })
		return { status: res.status, body: await res.json().catch(() => null) }
	}
	console.log(`file API=${FILES_BASE}`)
	const treePath = `/files/tree?path=${encodeURIComponent(sa._meta.runDir)}`
	const deadline = Date.now() + FILES_TIMEOUT_MS
	let tree
	do {
		tree = await getJson(treePath)
		const items = tree.body?.items ?? []
		if (tree.status !== 200 || (tree.body?.coverage?.state === "ready" && (!ra._meta?.report || items.some((e) => e.path === ra._meta.report)))) break
		await new Promise((r) => setTimeout(r, 1000))
	} while (Date.now() < deadline)
	check("A's run tree is discovered (v1 items, eventual coverage)", tree.status === 200 && tree.body?.filesContractVersion === 1 && Array.isArray(tree.body?.items) && tree.body.coverage?.state === "ready" && tree.body.truncated === false, `${tree.status} ${JSON.stringify(tree.body?.coverage ?? tree.body)}`)
	const files = (tree.body?.items ?? []).filter((e) => e.type === "file").map((e) => e.path)
	console.log(`${sa._meta.runDir}/: ${JSON.stringify(files)}`)
	check("A's results/reports are in its run folder (not only scripts)", files.some((f) => /\/(results|_reports)\//.test(`/${f}`)), `${files.length} files`)
	for (const [label, session, result] of [
		["A", sa, ra],
		["B", sb, rb],
	]) {
		const report = result._meta?.report
		const text = report ? await getJson(`/files/text?path=${encodeURIComponent(report)}`) : null
		const readable = text?.status === 200 && text.body?.filesContractVersion === 1 && typeof text.body?.text === "string" && text.body.text.length > 0 && text.body.observation?.ref?.path === report
		check(
			`${label}'s answer exported to its run folder (turn_end _meta.report)`,
			result.stopReason === "end_turn" && new RegExp(`^${session._meta.runDir}/_reports/REPORT_\\d{8}_\\d{6}(_\\d+)?\\.md$`).test(report ?? "") && readable,
			`${report ?? "(none)"}${report && !readable ? " (unreadable)" : ""}`,
		)
	}
	const tokens = (r) => (r.usage ? `${r.usage.inputTokens} in / ${r.usage.outputTokens} out` : "n/a")
	console.log(`usage: A ${tokens(ra)}, B ${tokens(rb)}`)

	for (const x of sockets) x.ws.close()
	console.log(JSON.stringify({ A: sa.sessionId, B: sb.sessionId, C: sc.sessionId, fillers: sf.map((s) => s.sessionId), model: MODEL }))
	console.log(failures === 0 ? `ALL PASS in ${elapsed()}` : `${failures} FAILED`)
	process.exit(failures === 0 ? 0 : 1)
}

main().catch((error) => {
	console.error("e2e aborted:", error)
	process.exit(1)
})
