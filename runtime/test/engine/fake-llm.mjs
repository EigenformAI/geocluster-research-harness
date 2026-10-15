/**
 * fake-llm.mjs — a scripted OpenAI/OpenRouter-compatible chat-completions server for driving the REAL OpenCode
 * engine without a real model or token. No npm dependencies (Node >= 20).
 *
 *   import { startFakeLlm } from "./fake-llm.mjs"
 *   const llm = await startFakeLlm({ log: "/path/llm.ndjson" })   // 127.0.0.1, free port
 *   // engine env: LLM_PROXY_URL = llm.url   (llm.url already ends in /v1)
 *   ...
 *   await llm.close()
 *
 * Behaviour is scripted by a DIRECTIVE in the text of the latest `user` message of each request (the first
 * directive keyword found, as an upper-case word; its arguments run to the end of that line):
 *
 *   SAY <text>                 stream <text> in ~3 SSE chunks, finish_reason "stop" ("\n" in <text> = newline);
 *                              the engine forwards them to ACP as one chunk (see chunkGapMs)
 *   SLOW <ms> <text>           stream <text> in 3–10 chunks spread over <ms> (>= ~200 ms per chunk to see
 *                              separate ACP agent_message_chunk updates)
 *   HANG [text]                stream one chunk, then keep the response open until the client disconnects
 *                              (the abort time is recorded as `abortedAt` on the request record)
 *   ERR <status> [message]     answer HTTP <status> with an OpenAI-style error JSON
 *   DELEGATE <agent> <prompt>  one `subagent` tool call {agent, description, prompt}; once the tool result is the
 *                              last message: "parent done: " + first 200 chars of the result
 *   DELEGATE_BG <agent> <p>    the same with "background": true
 *   TOOL <name> <json-args>    one tool call <name>(<json-args>); after the result: "tool done: " + 200 chars
 *   RESULT [text]              a valid SpecialistResult (opencode/config/lib/result-protocol.js):
 *                              {"type":"completion","status":"success","results":{"summary":<text|"ok">}} in a
 *                              ```json fence
 *   WAIT <gate> <directive…>   hold the request until llm.release(<gate>) is called, then run <directive…>
 *   DELEGATE_PAR <a>,<b> <p>   several parallel `subagent` calls in one response (ids call_fake_<seq>_<i>)
 *   DROP [text]                200 + optional one text chunk, then the socket is destroyed (no finish, no [DONE])
 *   RESET                      the socket is destroyed before any HTTP response
 *   (intercept plans may also set `calls: [{tool, input}]` and `preText` on a {kind: "tool"} plan)
 *
 * No directive → "fake-llm: no directive". Directives chain through delegation because the parent's `prompt`
 * argument becomes the child's user message: "DELEGATE orchestrator DELEGATE dataops RESULT ok".
 *
 * The answer to a request whose LAST message is a tool result is derived from the latest user message's directive
 * (DELEGATE, DELEGATE_BG, TOOL → the "... done: " text), so it needs no per-session state.
 *
 * Auxiliary engine calls (title generation) are recognised by their system prompt and answered with a short
 * title, never with a directive action.
 *
 * Every request is recorded in `requests[]` and appended to the ndjson `log` file:
 *   {seq, t, path, session, headers, body, agent, aux, directive, lastRole, tools, response, durationMs, abortedAt?}
 *   (`session` = the x-opencode-session header. Observed on 2.0.19: the root id for a root agent, but the PARENT
 *    session id for a child — so it is not a reliable "which session is calling" key)
 */
import fs from "node:fs"
import http from "node:http"

/** Agents recognised from the first system message (first match wins). Prompt files: opencode/config/prompts/. */
export const AGENT_SIGNATURES = [
	["orchestrator", /You are the Analysis Orchestrator/],
	["dataops", /You are the DataOps Specialist/],
	["transform", /You are the Transform Specialist/],
	["analytics", /You are the Analytics Specialist/],
	["geoviz", /You are the GeoViz Specialist/],
	["voxel", /You are the Voxel Specialist/],
	["extended", /You are the Extended Capability Agent/],
	["report-analysis", /Report Analysis agent \(Layer 1\)/],
	["geology", /You are operating inside a geological analysis environment/],
	// `standard` has no `system` in config: it runs OpenCode's own prompt (observed on 2.0.19)
	["standard", /You are an AI agent running in OpenCode/],
]

/** Auxiliary (non-agent) engine calls, recognised from the system prompt. See README "auxiliary calls". */
export const AUX_SIGNATURES = [["title", /title generator|generate a (short )?title|Generate a title/i]]

const DIRECTIVE = /(?:^|[\s>"'`(\[])(SAY|SLOW|HANG|ERR|DELEGATE_BG|DELEGATE_PAR|DELEGATE|TOOL|RESULT|WAIT|DROP|RESET)(?=[ \t]|$|\r?\n)/m

/** Plain text of an OpenAI message's content (string or parts). */
export function textOf(content) {
	if (typeof content === "string") return content
	if (Array.isArray(content))
		return content
			.map((p) => (typeof p === "string" ? p : p?.type === "text" ? p.text ?? "" : ""))
			.filter(Boolean)
			.join("\n")
	return ""
}

/** System prompt text of a request body (all system/developer messages joined). */
export function systemOf(body) {
	return (body?.messages ?? [])
		.filter((m) => m.role === "system" || m.role === "developer")
		.map((m) => textOf(m.content))
		.join("\n")
}

/** Which agent (or aux call) a request comes from, by its system prompt. */
export function classify(body) {
	const system = systemOf(body)
	for (const [name, re] of AUX_SIGNATURES) if (re.test(system)) return { agent: null, aux: name }
	const last = body?.messages?.at(-1)
	if (last?.role === "user" && /Return only the structured summary in the requested format|required summary template/.test(textOf(last.content))) return { agent: null, aux: "compaction" }
	for (const [name, re] of AGENT_SIGNATURES) if (re.test(system)) return { agent: name, aux: null }
	return { agent: "unknown", aux: null }
}

/** Tool names offered in a request. */
export const toolsOf = (body) => (body?.tools ?? []).map((t) => t?.function?.name ?? t?.name).filter(Boolean)

/** {name, args, rest} of the first directive in `text`, or null. `args` is the rest of that line. */
export function parseDirective(text) {
	const m = DIRECTIVE.exec(text ?? "")
	if (!m) return null
	const after = text.slice(m.index + m[0].length)
	const nl = after.search(/\r?\n/)
	const args = (nl < 0 ? after : after.slice(0, nl)).trim()
	return { name: m[1], args }
}

function splitFirst(s) {
	const m = /^(\S+)\s*([\s\S]*)$/.exec(s.trim())
	return m ? [m[1], m[2]] : ["", ""]
}

function chunksOf(text, n) {
	if (!text) return [""]
	const size = Math.max(1, Math.ceil(text.length / n))
	const out = []
	for (let i = 0; i < text.length; i += size) out.push(text.slice(i, i + size))
	return out
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
const unescape = (s) => s.replace(/\\n/g, "\n")

/** The SpecialistResult text RESULT answers with. */
export function specialistResult(text) {
	const value = { type: "completion", status: "success", results: { summary: text || "ok" } }
	return "```json\n" + JSON.stringify(value, null, 2) + "\n```"
}

/**
 * Decide the response for one request: {kind: "text"|"tool"|"hang"|"error", ...}.
 * Exported so tests can unit-check the scripting without a server.
 */
export function plan(body) {
	const messages = body?.messages ?? []
	const { agent, aux } = classify(body)
	const last = messages[messages.length - 1]
	const lastUser = [...messages].reverse().find((m) => m.role === "user")
	const userText = textOf(lastUser?.content)
	const directive = parseDirective(userText)
	const base = { agent, aux, directive, lastRole: last?.role ?? null }

	if (aux === "title") return { ...base, kind: "text", text: "Fake title" }
	if (aux === "compaction") return { ...base, kind: "text", text: "## Objective\n- Qualify native inference.\n\n## Requirements\n- Keep native provider selection.\n\n## Decisions\n- Use saved connection.\n\n## Work State\n### Completed\n- Native tool returned.\n\n### Active\n- Await continuation.\n\n### Blocked\n- (none)\n\n## Next Move\n1. Continue when requested.\n\n## Relevant Files\n- `native.txt`: test read fixture.\n\n## Important Context\n- Scripted qualification.\n" }
	if (aux) return { ...base, kind: "text", text: `fake ${aux}` }

	if (last?.role === "tool") {
		const result = textOf(last.content).slice(0, 200)
		let d = directive
		while (d?.name === "WAIT") d = parseDirective(splitFirst(d.args)[1])
		const prefix = d && /^DELEGATE/.test(d.name) ? "parent done: " : "tool done: "
		return { ...base, kind: "text", text: prefix + result }
	}
	return { ...base, ...act(directive) }
}

function act(directive) {
	if (!directive) return { kind: "text", text: "fake-llm: no directive" }
	const { name, args } = directive
	switch (name) {
		case "SAY":
			return { kind: "text", text: unescape(args) }
		case "SLOW": {
			const [ms, text] = splitFirst(args)
			return { kind: "text", text: unescape(text), spreadMs: Number(ms) || 0, chunks: Math.min(10, Math.max(3, text.split(/\s+/).length)) }
		}
		case "HANG":
			return { kind: "hang", text: args || "hanging…" }
		case "ERR": {
			const [status, message] = splitFirst(args)
			return { kind: "error", status: Number(status) || 500, message: message || `fake error ${status}` }
		}
		case "DELEGATE":
		case "DELEGATE_BG": {
			const [agent, prompt] = splitFirst(args)
			const input = { agent, description: `task for ${agent}`, prompt }
			if (name === "DELEGATE_BG") input.background = true
			return { kind: "tool", tool: "subagent", input }
		}
		case "DELEGATE_PAR": {
			// DELEGATE_PAR <agentA>,<agentB>[,…] <prompt>: one response with several parallel subagent calls (same
			// prompt each; descriptions "task for <agent>", so two calls to one agent share a description)
			const [agents, prompt] = splitFirst(args)
			const calls = agents.split(",").filter(Boolean).map((agent) => ({ tool: "subagent", input: { agent, description: `task for ${agent}`, prompt } }))
			return { kind: "tool", tool: "subagent", input: calls[0]?.input, calls }
		}
		case "DROP":
			return { kind: "drop", text: unescape(args) }
		case "RESET":
			return { kind: "reset" }
		case "TOOL": {
			const [tool, json] = splitFirst(args)
			let input
			try {
				input = json ? JSON.parse(json) : {}
			} catch (e) {
				return { kind: "text", text: `fake-llm: TOOL ${tool}: bad JSON args (${e.message})` }
			}
			return { kind: "tool", tool, input }
		}
		case "RESULT":
			return { kind: "text", text: specialistResult(args) }
		case "WAIT": {
			const [gate, rest] = splitFirst(args)
			return { kind: "wait", gate, then: act(parseDirective(rest)) }
		}
	}
	return { kind: "text", text: `fake-llm: unknown directive ${name}` }
}

/**
 * Start the server. Options:
 *   port      0 (default) = a free port; bound to 127.0.0.1 only
 *   log       ndjson file path for request records (optional)
 *   trace     (record) => void, called for every finished request (optional)
 *   usage     {prompt_tokens, completion_tokens} reported per response (default 10/5)
 *   chunkGapMs  pause between the ~3 chunks of a SAY/RESULT/"… done" answer (default 0). 2.0.19 coalesces text
 *               deltas: gaps <= 50 ms reach the ACP client as ONE agent_message_chunk, 100 ms as 2, 200 ms as 3
 *               (observed). Use SLOW (or chunkGapMs >= 200) when a test needs several chunks.
 * Returns {url, port, requests, close(), release(gate), waitForRequest(pred, timeoutMs), intercept}.
 * `url` is "http://127.0.0.1:<port>/v1" — set it as LLM_PROXY_URL. Set `llm.intercept = (body, record) => plan|undefined`
 * to override the scripted plan for chosen requests.
 */
export async function startFakeLlm({ port = 0, log, trace, usage = { prompt_tokens: 10, completion_tokens: 5 }, chunkGapMs = 0, requiredBearer, discovery } = {}) {
	const requests = []
	const gates = new Map() // gate → {released, waiters[]}
	const waiters = new Set()
	const sockets = new Set()
	const t0 = Date.now()
	let seq = 0
	const api = { intercept: null }

	const gate = (name) => {
		if (!gates.has(name)) gates.set(name, { released: false, waiters: [] })
		return gates.get(name)
	}
	const write = (record) => {
		if (log) fs.appendFileSync(log, JSON.stringify(record) + "\n")
	}

	async function serve(req, res, record) {
		const body = record.body
		let p = api.intercept?.(body, record) ?? plan(body)
		Object.assign(record, { agent: p.agent ?? null, aux: p.aux ?? null, directive: p.directive ?? null, lastRole: p.lastRole ?? null })
		let closed = false
		res.on("close", () => {
			if (!res.writableFinished) {
				closed = true
				record.abortedAt = Date.now() - t0
			}
		})
		while (p.kind === "wait") {
			const g = gate(p.gate)
			record.waitedFor = p.gate
			if (!g.released) await new Promise((r) => g.waiters.push(r))
			p = { ...p, ...p.then }
		}
		if (closed) return (record.response = { kind: "aborted-before-answer" })

		const id = `chatcmpl-fake-${record.seq}`
		const created = Math.floor(Date.now() / 1000)
		const model = body.model ?? "fake"
		if (p.kind === "error") {
			record.response = { kind: "error", status: p.status }
			res.writeHead(p.status, { "content-type": "application/json" })
			return res.end(JSON.stringify({ error: { message: p.message, type: "fake_error", code: p.code ?? p.status, ...(p.retryable === undefined ? {} : { retryable: p.retryable }) } }))
		}
		if (p.kind === "reset") {
			// RESET: drop the TCP connection without any HTTP response
			record.response = { kind: "reset" }
			req.socket.destroy()
			return
		}
		const finish = p.kind === "tool" ? "tool_calls" : "stop"
		// p.calls (several parallel tool calls) or p.tool/p.input (one); a single call keeps the id call_fake_<seq>
		const calls = p.kind === "tool" ? p.calls ?? [{ tool: p.tool, input: p.input }] : null
		const toolCalls = calls?.map((c, i) => ({ id: `call_fake_${record.seq}${calls.length > 1 ? `_${i}` : ""}`, type: "function", function: { name: c.tool, arguments: JSON.stringify(c.input) } })) ?? null
		const toolCall = toolCalls?.[0] ?? null
		const uu = p.usage ?? usage // a plan may carry its own {prompt_tokens, completion_tokens}
		const u = { ...uu, total_tokens: uu.prompt_tokens + uu.completion_tokens }
		record.response =
			p.kind === "tool" ? { kind: "tool", tool: p.tool, input: p.input, ...(calls.length > 1 ? { calls } : {}), ...(p.preText ? { preText: p.preText } : {}) } : { kind: p.kind, text: p.text }

		if (!body.stream) {
			const message = { role: "assistant", content: p.kind === "tool" ? p.preText ?? null : p.text }
			if (toolCalls) message.tool_calls = toolCalls
			res.writeHead(200, { "content-type": "application/json" })
			return res.end(JSON.stringify({ id, object: "chat.completion", created, model, choices: [{ index: 0, message, finish_reason: finish }], usage: u }))
		}

		res.writeHead(200, { "content-type": "text/event-stream", "cache-control": "no-cache", connection: "keep-alive" })
		const send = (choice, extra = {}) =>
			!closed && res.write(`data: ${JSON.stringify({ id, object: "chat.completion.chunk", created, model, choices: choice ? [{ index: 0, ...choice }] : [], ...extra })}\n\n`)
		if (p.kind === "drop") {
			// DROP [text]: 200 + optional text chunk, then the connection is destroyed (no finish_reason, no [DONE])
			if (p.text) send({ delta: { role: "assistant", content: p.text }, finish_reason: null })
			await sleep(p.dropAfterMs ?? 100)
			record.response.dropped = true
			res.socket?.destroy()
			return
		}
		if (p.kind === "tool") {
			if (p.preText) {
				// text before the tool call(s) in the same assistant message (optional, intercept plans only)
				send({ delta: { role: "assistant", content: p.preText }, finish_reason: null })
				if (p.preTextGapMs) await sleep(p.preTextGapMs)
			}
			toolCalls.forEach((tc, i) => send({ delta: { ...(i === 0 && !p.preText ? { role: "assistant", content: null } : {}), tool_calls: [{ index: i, ...tc }] }, finish_reason: null }))
		} else {
			const parts = chunksOf(p.text, p.kind === "hang" ? 1 : p.chunks ?? 3)
			const gap = p.spreadMs ? p.spreadMs / parts.length : chunkGapMs
			for (let i = 0; i < parts.length; i++) {
				if (closed) break
				send({ delta: i === 0 ? { role: "assistant", content: parts[i] } : { content: parts[i] }, finish_reason: null })
				if (gap && (p.spreadMs || i < parts.length - 1)) await sleep(gap)
			}
			if (p.kind === "hang") {
				record.response.hung = true
				return // left open; `close` records abortedAt when the client goes away
			}
		}
		if (closed) return
		send({ delta: {}, finish_reason: finish }, { usage: u })
		res.write("data: [DONE]\n\n")
		res.end()
	}

	const server = http.createServer((req, res) => {
		const chunks = []
		req.on("data", (c) => chunks.push(c))
		req.on("end", async () => {
			const raw = Buffer.concat(chunks).toString("utf8")
			let body = null
			try {
				body = raw ? JSON.parse(raw) : null
			} catch {}
			const headers = { ...req.headers }
			if (headers.authorization) headers.authorization = headers.authorization.replace(/^(Bearer\s+).*/i, "$1<redacted>")
			const record = { seq: ++seq, t: Date.now() - t0, method: req.method, path: req.url, session: req.headers["x-opencode-session"] ?? null, headers, body: body ?? raw, tools: toolsOf(body) }
			if (requiredBearer !== undefined) record.authenticated = req.headers.authorization === `Bearer ${requiredBearer}`
			requests.push(record)
			const started = Date.now()
			try {
				if (discovery && req.method === "GET" && /\/account$/.test(req.url)) {
					record.response = { kind: "discovery" }
					res.writeHead(200, { "content-type": "application/json" })
					res.end(JSON.stringify(discovery))
				} else if (record.authenticated === false) {
					record.response = { kind: "error", status: 401 }
					res.writeHead(401, { "content-type": "application/json" })
					res.end(JSON.stringify({ error: { message: "Scripted supplier requires the saved connection", code: "invalid_api_key" } }))
				} else if (req.method === "POST" && /\/chat\/completions(\?|$)/.test(req.url) && body) await serve(req, res, record)
				else {
					record.response = { kind: "not-found" }
					res.writeHead(404, { "content-type": "application/json" })
					res.end(JSON.stringify({ error: { message: `fake-llm: no route ${req.method} ${req.url}`, type: "not_found", code: 404 } }))
				}
			} catch (e) {
				record.response = { kind: "harness-error", error: String(e?.stack ?? e) }
				if (!res.headersSent) res.writeHead(500, { "content-type": "application/json" })
				res.end(JSON.stringify({ error: { message: String(e), type: "fake_internal", code: 500 } }))
			}
			const finished = () => {
				record.durationMs = Date.now() - started
				write(record)
				trace?.(record)
				for (const w of waiters) {
					let hit = false
					try {
						hit = w.pred(record)
					} catch {}
					if (hit) (waiters.delete(w), w.resolve(record))
				}
			}
			if (record.response?.hung && !res.closed) res.on("close", finished)
			else finished()
		})
	})
	server.on("connection", (s) => (sockets.add(s), s.on("close", () => sockets.delete(s))))
	await new Promise((resolve, reject) => {
		server.once("error", reject)
		server.listen(port, "127.0.0.1", resolve)
	})
	const actual = server.address().port

	return Object.assign(api, {
		url: `http://127.0.0.1:${actual}/v1`,
		port: actual,
		/** Epoch ms that the records' relative times (`t`, `abortedAt`) count from. */
		t0,
		requests,
		/** Records of agent calls (aux calls excluded), optionally for one agent. */
		agentCalls: (agent) => requests.filter((r) => !r.aux && r.response?.kind !== "not-found" && (!agent || r.agent === agent)),
		release(name) {
			const g = gate(name)
			g.released = true
			for (const w of g.waiters.splice(0)) w()
		},
		/** Resolves with the first FINISHED request record matching pred (already-finished ones included). */
		waitForRequest(pred, timeoutMs = 30000) {
			const done = requests.find((r) => {
				try {
					return r.durationMs !== undefined && pred(r)
				} catch {
					return false
				}
			})
			if (done) return Promise.resolve(done)
			return new Promise((resolve, reject) => {
				const w = { pred, resolve }
				waiters.add(w)
				setTimeout(() => waiters.delete(w) && reject(new Error(`fake-llm: no matching request in ${timeoutMs} ms`)), timeoutMs).unref()
			})
		},
		async close() {
			for (const g of gates.values()) for (const w of g.waiters.splice(0)) w()
			for (const s of sockets) s.destroy()
			await new Promise((r) => server.close(() => r()))
		},
	})
}
