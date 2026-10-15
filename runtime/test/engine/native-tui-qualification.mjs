/** Disposable full-image adapter. Starts the shipped native entrypoint, never a substitute server. */
import assert from "node:assert/strict"
import fs from "node:fs"
import { spawn, execFileSync } from "node:child_process"
import { plan, specialistResult, startFakeLlm } from "./fake-llm.mjs"

if (process.env.NATIVE_TUI_QUALIFICATION !== "1") process.exit(0)
const ws = "/workspace/native-tui-gate"
const state = "/workspace/.runtime/native/opencode"
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
const checks = []
let terminal, terminalExit, text = "", events = [], llm
async function until(fn, label, ms = 45000) {
	const end = Date.now() + ms
	let last
	while (Date.now() < end) {
		try { const value = await fn(); if (value) return value } catch (error) { last = error }
		await sleep(100)
	}
	throw new Error(`${label}: ${ms}ms deadline${last ? `: ${last.message}` : ""}; terminal=${plain().slice(-1500)}`)
}
function record(name) { checks.push(name); console.log(`PASS ${name}`) }
function plain() { return text.replace(/\x1b\][\s\S]*?(?:\x07|\x1b\\)/g, "").replace(/\x1b\[[0-?]*[ -/]*[@-~]/g, "") }
function send(command) { terminal.stdin.write(JSON.stringify(command) + "\n") }
const stale = {
	LLM_PROXY_URL: "http://127.0.0.1:9/v1", IDE_LLM_TOKEN: "must-not-reach-native-engine",
	IDE_MACHINE_TOKEN: "must-not-reach-native-engine", IDE_MACHINE_CREDENTIALS_URL: "http://127.0.0.1:9/renew",
	RUNTIME_ACTIVITY_URL: "http://127.0.0.1:9/activity", IDE_DATASET_TOKEN: "stale-dataset",
	IDE_FILES_TOKEN: "stale-files", IDE_WORK_TOKEN: "stale-work", PREPROCESSING_PROXY_TOKEN: "stale-processing",
	IDE_PROXY_KEY: "stale-gate", R2_ACCESS_KEY_ID: "stale-storage-id",
	R2_SECRET_ACCESS_KEY: "stale-storage", OPENROUTER_API_KEY: "not-explicitly-forwarded",
}
const baseEnv = { PATH: "/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin", HOME: "/root",
	LANG: "C.UTF-8", TERM: "xterm-256color", COLORTERM: "truecolor", PROJECT_ID: "native-tui-gate", RUNTIME_PROFILE: "native" }
async function launch(extra = {}) {
	text = ""; events = []; terminalExit = undefined
	terminal = spawn("python3", ["/fixtures/native-tui-pty.py"], { stdio: ["pipe", "pipe", "inherit"] })
	let buffer = ""
	terminal.stdout.on("data", (data) => {
		buffer += data
		let i
		while ((i = buffer.indexOf("\n")) >= 0) {
			const e = JSON.parse(buffer.slice(0, i)); buffer = buffer.slice(i + 1); events.push(e)
			if (e.terminal) text += Buffer.from(e.terminal, "base64").toString("utf8")
			if (e.exit !== undefined) terminalExit = e.exit
		}
	})
	send({ argv: ["/entrypoint.sh", "tui"], cwd: "/", uid: 0, gid: 0, env: { ...baseEnv, ...extra } })
	await until(() => /geology/i.test(plain()) && /connect|provider/i.test(plain()), "real native TUI renders")
}
const processList = () => fs.readdirSync("/proc").filter((p) => /^\d+$/.test(p)).flatMap((pid) => {
	try { return [{ pid: Number(pid), cmd: fs.readFileSync(`/proc/${pid}/cmdline`, "utf8").replace(/\0/g, " ") }] } catch { return [] }
})
function agentEnv(pid) {
	return JSON.parse(execFileSync("node", ["-e", 'const fs=require("fs"); console.log(JSON.stringify(Object.fromEntries(fs.readFileSync(process.argv[1],"utf8").split("\\0").filter(Boolean).map(v=>{const i=v.indexOf("=");return [v.slice(0,i),v.slice(i+1)]}))))', `/proc/${pid}/environ`], { uid: 999, gid: 999, encoding: "utf8" }))
}
async function services() {
	const processes = processList()
	const tui = processes.find((p) => /opencode --standalone /.test(p.cmd))
	assert.ok(tui, "entrypoint launches --standalone, not --server attach")
	const server = processes.find((p) => /opencode serve --stdio/.test(p.cmd))
	assert.ok(server)
	const env = agentEnv(server.pid)
	for (const key of Object.keys(stale)) assert.equal(env[key], undefined, `${key} leaked into native engine`)
	assert.equal(env.OPENCODE_MODELS_PATH, undefined)
	assert.equal(env.OPENCODE_DISABLE_MODELS_FETCH, undefined)
	assert.equal(env.OPENCODE_CONFIG_PROJECT_DISABLE, undefined)
	assert.equal(env.XDG_DATA_HOME, `${state}/data`)
	const mcp = processes.find((p) => /python.*-u main.py/.test(p.cmd))
	assert.ok(mcp, "shipped MCP, not a readiness stub")
	const mcpEnv = agentEnv(mcp.pid)
	for (const key of Object.keys(stale)) assert.equal(mcpEnv[key], undefined, `${key} leaked into MCP`)
	const health = await (await fetch("http://127.0.0.1:7710/healthz")).json()
	assert.equal(health.ok, true)
	assert.equal(health.mode, "shared")
	assert.ok(fs.existsSync("/run/geocluster/voxels.sock"))
	const gate = fs.readFileSync("/run/runtime/gate", "utf8").trim()
	assert.equal((await fetch("http://127.0.0.1:3002/livez", { headers: { "X-GC-Gate": gate } })).status, 200)
	assert.equal((await fetch("http://127.0.0.1:3002/files/info", { headers: { "X-GC-Gate": gate } })).status, 200)
	const privateRead = await fetch("http://127.0.0.1:3002/files/raw?path=../.runtime/native/opencode/data/opencode/opencode.db", { headers: { "X-GC-Gate": gate } })
	assert.ok(privateRead.status >= 400 && privateRead.status < 500, "file API cannot expose native connection state")
	assert.equal((await fetch("http://127.0.0.1:3002/livez")).status, 403, "native file API retains authentication")
	const files = processes.find((p) => /node .*\/files-server\.js/.test(p.cmd))
	assert.ok(files)
	assert.ok(!processes.some((p) => /node .*\/(?:server|gate|machine-gateway)\.js/.test(p.cmd)), "native must not start the managed gateway")
	assert.equal(fs.statSync(state).mode & 0o777, 0o700)
	assert.equal(fs.statSync("/root").mode & 0o777, 0o700, "MCP startup does not widen root's home")
	for (const uid of [995, 996, 997, 998]) {
		assert.throws(() => execFileSync("node", ["-e", `require("fs").readdirSync(${JSON.stringify(state)})`], { uid, gid: uid, stdio: "pipe" }), "other service identities cannot read native credentials")
	}
	// Native trust permits same-UID access. Read the owned server lease privately;
	// never write its password or the credential database to qualification logs.
	const endpoint = JSON.parse(execFileSync("node", ["-e", `
		const fs=require("fs"), p=${server.pid};
		const sockets=new Set(fs.readdirSync('/proc/'+p+'/fd').flatMap(n=>{try{const m=/socket:\\[(\\d+)\\]/.exec(fs.readlinkSync('/proc/'+p+'/fd/'+n));return m?[m[1]]:[]}catch{return []}}));
		const rows=fs.readFileSync('/proc/net/tcp','utf8').trim().split('\\n').slice(1).map(l=>l.trim().split(/\\s+/));
		const row=rows.find(r=>r[3]==='0A'&&sockets.has(r[9])); if(!row)process.exit(2);
		console.log(JSON.stringify({port:parseInt(row[1].split(':')[1],16)}));
	`], { uid: 999, gid: 999, encoding: "utf8" }))
	const password = env.OPENCODE_PASSWORD
	async function api(route, body) {
		const url = new URL(route, `http://127.0.0.1:${endpoint.port}`)
		url.searchParams.set("location[directory]", ws)
		const response = await fetch(url, { method: body ? "POST" : "GET", headers: {
			authorization: `Basic ${Buffer.from(`opencode:${password}`).toString("base64")}`, ...(body ? { "content-type": "application/json" } : {}),
		}, ...(body ? { body: JSON.stringify(body) } : {}), signal: AbortSignal.timeout(10000) })
		assert.ok(response.ok, `${route}: ${response.status}`)
		const value = await response.text(); return value ? JSON.parse(value) : null
	}
	await until(async () => (await api("/api/mcp")).data.some((m) => m.name === "geocluster" && m.status.status === "connected"), "MCP tools available before first prompt")
	const lifecycle = fs.readFileSync(`${state}/logs/lifecycle.log`, "utf8")
	assert.match(lifecycle, /native TUI started/)
	record("native environment, private state, shipped file/MCP/voxel readiness")
	return { api, pids: [tui.pid, server.pid, mcp.pid, files.pid] }
}
async function finish(signal, pids) {
	if (signal) send({ signal })
	else {
		send({ send: "\x1b" }); await sleep(200)
		// First Ctrl+C clears an input/autocomplete; the next invokes app.exit.
		send({ send: "\x03" }); await sleep(200); send({ send: "\x03" })
	}
	await until(() => terminalExit !== undefined, "entrypoint and owned services exit", 30000)
	assert.equal(terminalExit, signal === "SIGTERM" ? 143 : 130)
	terminal.stdin.end()
	await until(() => pids.every((pid) => !fs.existsSync(`/proc/${pid}`)), "native child cleanup", 10000)
	record(signal ?? "Ctrl-C terminal exit")
}
try {
	await launch()
	let current = await services()
	send({ send: "/connect" }); await sleep(250); send({ send: "\r" })
	await until(() => /Connect an integration/.test(plain()) && /Popular/.test(plain()) && /Anthropic|OpenAI/.test(plain()), "real native connection picker with provider choices")
	record("token-free first run reaches /connect without inference")
	await finish(null, current.pids)
	llm = await startFakeLlm({ requiredBearer: "saved-native-image-key" })
	llm.intercept = (body) => {
		const p = plan(body)
		return p.agent === "voxel" && p.lastRole === "tool" ? { ...p, kind: "text", text: specialistResult("image voxel preparation completed") } : p
	}
	const userDir = `${state}/config/opencode`
	fs.mkdirSync(userDir, { recursive: true }); fs.chownSync(userDir, 999, 999)
	const config = { model: "personal/new-maker/slash-model", providers: { personal: {
		name: "Loopback image qualification", package: "@opencode/ai/providers/openrouter", settings: { baseURL: llm.url },
		models: { "new-maker/slash-model": { name: "Text only", capabilities: { tools: true, input: ["text"], output: ["text"] }, limit: { context: 24000, input: 20000, output: 1024 }, variants: [] } },
	} } }
	fs.writeFileSync(`${userDir}/opencode.json`, JSON.stringify(config)); fs.chownSync(`${userDir}/opencode.json`, 999, 999)
	for (let restart = 0; restart < 2; restart++) {
		await launch(stale)
		current = await services()
		if (!restart && process.env.NATIVE_TUI_REUSE_STATE !== "1") await current.api("/api/integration/personal/connect/key", { key: "saved-native-image-key" })
		const sid = (await current.api("/api/session", { agent: "geology", location: { directory: ws } })).data.id
		fs.writeFileSync(`${ws}/native-image.txt`, "image tool fixture"); fs.chownSync(`${ws}/native-image.txt`, 999, 999)
		const mark = llm.requests.length
		await current.api(`/api/session/${sid}/prompt`, { text: 'TOOL read {"path":"native-image.txt"}' })
		await until(() => llm.requests.slice(mark).some((r) => r.lastRole === "tool"), "image supplier tool round trip")
		await until(async () => !Object.keys((await current.api("/api/session/active")).data).length, "image turn completes")
		assert.ok(llm.requests.slice(mark).every((r) => r.authenticated && r.body.model === "new-maker/slash-model"))
		assert.ok(llm.requests.slice(mark).every((r) => !Object.keys(r.headers).some((k) => k.startsWith("x-geocluster-"))))
		assert.ok(llm.requests.slice(mark).filter((r) => !r.aux).every((r) => r.body.max_completion_tokens === 1024 && r.body.reasoning?.effort === undefined))
		if (!restart) {
			fs.writeFileSync(`${ws}/native-grid.csv`, "x,y,z,value\n0,0,0,A\n1,0,0,B\n"); fs.chownSync(`${ws}/native-grid.csv`, 999, 999)
			await current.api(`/api/session/${sid}/prompt`, { text: 'DELEGATE orchestrator DELEGATE voxel TOOL voxel_prepare {"path":"native-grid.csv"}' })
			await until(() => llm.agentCalls("voxel").some((r) => r.lastRole === "tool"), "native specialist canonical voxel operation")
			await until(async () => !Object.keys((await current.api("/api/session/active")).data).length, "native voxel turn completes")
			const returned = llm.agentCalls("voxel").find((r) => r.lastRole === "tool").body.messages.filter((m) => m.role === "tool")
			assert.match(JSON.stringify(returned), /native-grid\.csv/)
			assert.doesNotMatch(JSON.stringify(returned), /ECONNREFUSED|Unauthorized|Permission denied/)
			record("native specialist reaches canonical voxel preparation through owned daemon")
		}
		record(restart ? "saved API connection survives native lifecycle replacement" : "native API connection and custom slash model tool turn")
		send({ resize: [30, 100] }); await until(() => events.some((e) => e.resized), "terminal resize")
		await finish(restart ? "SIGTERM" : null, current.pids)
	}
	console.log(`NATIVE_PROFILE_PASSED ${JSON.stringify(checks)}`)
} catch (error) {
	console.error(`NATIVE_PROFILE_BLOCKED ${error.stack}`)
	process.exitCode = 1
} finally {
	terminal?.stdin.end()
	await llm?.close()
}
