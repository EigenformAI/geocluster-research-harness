#!/usr/bin/env node
/**
 * engine-smoke.mjs — boot the real OpenCode engine on config/ and check what unit tests can't: that the plugins load,
 * what each root agent is actually offered, and the retry sequence. No model and no token: the provider and the MCP
 * point at a closed port, so every prompt fails after the `session context` hook has run.
 *
 *   OPENCODE_BIN=/path/to/opencode [OPENCODE_SMOKE_CONFIG=<config dir, default ../config>] node scripts/engine-smoke.mjs
 *
 * Runs `opencode acp` only (any other CLI command without --standalone starts a background service), in a throwaway
 * HOME/XDG sandbox, and stops it by PID. Takes about 40 s (two prompts × the 2+4+8 s retry backoff).
 * First run 2026-10-01 against 2.0.19: all checks pass. Run it on every engine upgrade.
 */
import { spawn } from "node:child_process"
import fs from "node:fs"
import path from "node:path"
import { fileURLToPath } from "node:url"
import { materializeProfile } from "./build-config.mjs"

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..")
const BIN = process.env.OPENCODE_BIN
if (!BIN || !fs.existsSync(BIN)) {
	console.error("set OPENCODE_BIN to the opencode binary (the pinned version)")
	process.exit(2)
}

// What each root agent is offered on 2.0.19 with the MCP unreachable (the geocluster_* tools are then absent).
const EXPECTED_TOOLS = {
	geology: ["glob", "read", "subagent"], // grep denied since 2026-10-02 (L1-1: the engine checks it against the pattern)
	standard: ["edit", "glob", "grep", "read", "shell", "skill", "webfetch", "write"],
}
// retry-policy takes max(its 2/4/8 s backoff, the engine's own delay). The engine's schedule is jittered ×0.8–1.2
// (2.0.19 session/runner/retry.ts), so a logged delay is the backoff or up to 20 % more, rounded: 2–3, 4–5, 8–10 s.
const EXPECTED_RETRIES = [[2, 3], [4, 5], [8, 10], "giving up"]
const retriesMatch = (got) =>
	got.length === EXPECTED_RETRIES.length &&
	EXPECTED_RETRIES.every((want, i) => {
		if (typeof want === "string") return got[i] === want
		const s = Number(/^retry in (\d+) s$/.exec(got[i] ?? "")?.[1])
		return s >= want[0] && s <= want[1]
	})

const sandbox = fs.mkdtempSync("/tmp/opencode/oc-smoke-")
for (const dir of ["ws", "home", "xdg/data", "xdg/config", "xdg/state", "xdg/cache"]) fs.mkdirSync(path.join(sandbox, dir), { recursive: true })
// OPENCODE_SMOKE_CONFIG: test another config tree, e.g. the one baked into the image (runtime/test/image/image-test.mjs)
fs.cpSync(process.env.OPENCODE_SMOKE_CONFIG || path.join(ROOT, "config"), path.join(sandbox, "source-config"), { recursive: true })
// Deliberately synthetic execution metadata: this checks closed-port transport, not managed eligibility.
materializeProfile("managed", { directory: path.join(sandbox, "config"), sourceDirectory: path.join(sandbox, "source-config"), catalog: {
	managed_models: { "fixture/transport": { name: "Smoke transport", capabilities: { tools: true, input: ["text"], output: ["text"] }, limit: { context: 24000, input: 16000, output: 4000 }, variants: [] } },
	default_model_id: "fixture/transport",
} })
fs.writeFileSync(
	path.join(sandbox, "config", "plugins", "zz-smoke.js"),
	`export default { id: "zz-smoke", async setup(ctx) {
	await ctx.session.hook("context", (e) => {
		const brief = e.system.some((p) => String(p.text ?? "").startsWith("Output folder for this conversation"))
		console.error("[smoke] " + JSON.stringify({ agent: e.agent, brief, tools: Object.keys(e.tools).sort() }))
	})
}}\n`,
)

const env = {
	PATH: process.env.PATH,
	HOME: `${sandbox}/home`,
	XDG_DATA_HOME: `${sandbox}/xdg/data`,
	XDG_CONFIG_HOME: `${sandbox}/xdg/config`,
	XDG_STATE_HOME: `${sandbox}/xdg/state`,
	XDG_CACHE_HOME: `${sandbox}/xdg/cache`,
	OPENCODE_CONFIG_DIR: `${sandbox}/config`,
	OPENCODE_MODELS_PATH: `${sandbox}/source-config/models-empty.json`,
	OPENCODE_CONFIG_PROJECT_DISABLE: "1", // read first by 2.0.19; the gateway sets both
	OPENCODE_DISABLE_PROJECT_CONFIG: "1",
	OPENCODE_DISABLE_MODELS_FETCH: "1",
	OPENCODE_DISABLE_AUTOUPDATE: "1",
	OPENCODE_PRINT_LOGS: "1",
	GEOCLUSTER_MCP_URL: "http://127.0.0.1:9/mcp",
	LLM_PROXY_URL: "http://127.0.0.1:9/v1",
	IDE_LLM_TOKEN: "smoke",
}
const child = spawn(BIN, ["acp"], { cwd: `${sandbox}/ws`, env, stdio: ["pipe", "pipe", "pipe"] })
let out = ""
let err = ""
const pending = new Map()
child.stdout.on("data", (d) => {
	out += d
	let i
	while ((i = out.indexOf("\n")) >= 0) {
		const line = out.slice(0, i)
		out = out.slice(i + 1)
		try {
			const m = JSON.parse(line)
			if (m.id && pending.has(m.id)) {
				pending.get(m.id)(m)
				pending.delete(m.id)
			}
		} catch {}
	}
})
child.stderr.on("data", (d) => (err += d))
let seq = 0
const call = (method, params) =>
	new Promise((resolve) => {
		const id = ++seq
		pending.set(id, resolve)
		child.stdin.write(JSON.stringify({ jsonrpc: "2.0", id, method, params }) + "\n")
	})
const within = (promise, ms) => Promise.race([promise, new Promise((r) => setTimeout(() => r({ timeout: true }), ms))])

const failures = []
const check = (ok, label) => {
	console.log(`${ok ? "PASS" : "FAIL"} ${label}`)
	if (!ok) failures.push(label)
}
try {
	const init = await within(call("initialize", { protocolVersion: 1, clientCapabilities: { _meta: { "opencode/child-session-updates": true } } }), 30000)
	check(!init.timeout && !init.error, "initialize")
	for (const agent of Object.keys(EXPECTED_TOOLS)) {
		const created = await within(call("session/new", { cwd: `${sandbox}/ws`, mcpServers: [] }), 30000)
		const sessionId = created.result?.sessionId
		check(!!sessionId, `${agent}: session/new`)
		if (agent !== "geology") check(!(await call("session/set_mode", { sessionId, modeId: agent })).error, `${agent}: set_mode`)
		const reply = await within(call("session/prompt", { sessionId, prompt: [{ type: "text", text: "hello" }] }), 60000)
		check(reply.error?.data?.errorName === "provider.transport", `${agent}: prompt fails as provider.transport (got ${JSON.stringify(reply.error ?? reply.result ?? "timeout").slice(0, 120)})`)
	}
} finally {
	child.kill("SIGTERM")
	await new Promise((r) => setTimeout(r, 1500))
	if (child.exitCode === null) child.kill("SIGKILL")
}

const lines = err.split("\n")
check(lines.some((l) => l.startsWith("[run-dir] loaded for")), "plugins load without node_modules (run-dir reported in)")
check(!lines.some((l) => /level=(WARN|ERROR)/.test(l) && /plugin/i.test(l)), "no plugin warnings or errors")
const seen = lines.filter((l) => l.startsWith("[smoke] ")).map((l) => JSON.parse(l.slice(8)))
for (const [agent, tools] of Object.entries(EXPECTED_TOOLS)) {
	const first = seen.find((s) => s.agent === agent)
	check(first && JSON.stringify(first.tools) === JSON.stringify(tools), `${agent} is offered ${tools.join(" ")} (got ${first?.tools.join(" ")})`)
	check(first?.brief === true, `${agent} gets the run-folder brief`)
}
const retries = lines.filter((l) => l.startsWith("[retry-policy]") && l.includes("agent=geology")).map((l) => l.split(" → ")[1])
check(retriesMatch(retries), `retry sequence 2, 4, 8 s (+ the engine's jitter), then giving up (got ${retries.join(", ")})`)

fs.rmSync(sandbox, { recursive: true, force: true })
console.log(failures.length ? `\n${failures.length} check(s) failed` : "\nALL PASS")
process.exit(failures.length ? 1 : 0)
