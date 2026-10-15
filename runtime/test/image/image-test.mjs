#!/usr/bin/env node
/**
 * image-test.mjs — boot the combined runtime image and check its offline engine and file-service boundaries.
 *
 *   node runtime/test/image/image-test.mjs [--image geocluster-runtime:latest] [--keep] [--skip-engine-smoke]
 *
 * Needs docker and nothing else: no real model, token or network. The container runs the real entrypoint on a throwaway
 * named volume with `--network none`, so a hidden download (ripgrep, models, plugins) fails the test. The engine's
 * managed backend supplies machine renewal, schema-2 discovery and a scripted fake LLM on the container's loopback,
 * ready before the real entrypoint starts. runtime/test is mounted
 * read-only at /opt/geocluster-runtime/test, where the image's own node_modules resolve it; opencode/ for the engine
 * smoke. --keep leaves the container and volume for inspection (the test prints how to remove them).
 * RUNTIME_AUTH_DISABLED=1 is set only for this local, network-isolated image test; all traffic uses the public :3000.
 *
 * Checks (one PASS/FAIL line each; exit 0 when all pass):
 *   static    engine version = the pin; no cline; every prompt both profiles name; nothing under /opt/opencode, the
 *             gateway or the entrypoint writable by geocluster or owned by anyone but root; no writable PATH folder;
 *             gc-files=998, parser=997, agent=999; native bindings load, root-owned setuid launcher;
 *             rg and libgomp present; no /tmp/opencode baked in; the OpenCode notice shipped
 *   boot      /readyz 200, engine ready with its geocluster tools connected, offline; /files/info contract 1,
 *             protected captures, separate preview parser and verified XLS/XLSX workbook reader available
 *   turns     gateway-smoke.mjs passes inside the container; a geology glob works with the image's rg (no
 *             "downloading ripgrep"); tool shells get the tool HOME/XDG folders and no proxy token or server password
 *   engine    engine-smoke.mjs against the installed binary and baked shared sources (plugins load, offered tools,
 *             retry sequence); the real managed engine uses its root-generated catalog/config, not a test override
 *   plants    as geocluster, every root-owned config source refuses a write, including /workspace/opencode.json;
 *             project plants are ignored after an engine restart (same geology tools, no marker in any geology
 *             or standard model request, none in the engine log)
 *   logs      no EACCES / permission denied in the engine log; root writes nothing into /var/log/runtime
 *   reboot    links a tool shell can leave on the volume cannot modify root-owned config when a fresh
 *             container boots on the same volume; .runtime/archive planting is refused by its protected parent;
 *             /readyz 200, trusted code still root-owned, file-service receipts/captures and ownership retained;
 *             unchanged live tokens permit preboot conditional saves; same-size/exact-mtime edits reject stale saves
 */
import { spawnSync } from "node:child_process"
import crypto from "node:crypto"
import fs from "node:fs"
import path from "node:path"
import { fileURLToPath } from "node:url"
import { requireNativeProviders } from '../../scripts/lib/workspace-qualification.mjs'

const HERE = path.dirname(fileURLToPath(import.meta.url))
const REPO = path.resolve(HERE, "..", "..", "..")
const args = process.argv.slice(2)
const opt = (name, fallback) => {
	const i = args.indexOf(name)
	return i === -1 ? fallback : args[i + 1]
}
const IMAGE = opt("--image", "geocluster-runtime:latest")
const KEEP = args.includes("--keep")
const SKIP_ENGINE_SMOKE = args.includes("--skip-engine-smoke")
const NAME = `gc-image-test-${process.pid}`
const PROJECT = "imagetest"
const WS = `/workspace/${PROJECT}`
const LLM_PORT = 7799
const RUNTIME_DIR = "/opt/geocluster-runtime"
const TEST_DIR = `${RUNTIME_DIR}/test` // the mount: `ws` and the ACP SDK resolve from ../node_modules
const FILES_STATE_DIR = `/workspace/.runtime/file-service/${PROJECT}`
const LAUNCHER = `${RUNTIME_DIR}/lib/preview-launcher/build/preview-launcher`
const ENGINE_LOG = "/var/log/runtime/agent.stderr.log"
const LLM_LOG = "/tmp/fake-llm.ndjson"
const MARKER = "PLANTMARKER" // no directive keyword (SAY, TOOL, …) so the fake LLM never acts on it
const PIN = JSON.parse(fs.readFileSync(path.join(REPO, "opencode", "engine", "source-build.json"), "utf8")).version
let managedConfigDir

let failures = 0
function check(name, ok, detail = "") {
	if (!ok) failures++
	console.log(`${ok ? "PASS" : "FAIL"}  ${name}${!ok && detail ? `\n      ${String(detail).slice(0, 1500).replace(/\n/g, "\n      ")}` : ""}`)
	return ok
}

function docker(argv, { input, timeoutMs = 600_000 } = {}) {
	const r = spawnSync("docker", argv, { encoding: "utf8", input, timeout: timeoutMs, maxBuffer: 64 * 1024 * 1024 })
	return { code: r.status ?? -1, out: r.stdout ?? "", err: r.stderr ?? "", error: r.error }
}
/** Run `script` with bash in the test container, as `user` (root by default). */
const inside = (script, { user, timeoutMs } = {}) => docker(["exec", ...(user ? ["-u", user] : []), NAME, "bash", "-c", script], { timeoutMs })
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
const q = (s) => `'${String(s).replace(/'/g, `'\\''`)}'`

function readyz() {
	const r = inside("curl -s -m 5 http://127.0.0.1:3000/readyz -w '\\n%{http_code}'")
	const lines = r.out.trim().split("\n")
	const status = Number(lines.pop())
	try {
		return { status, body: JSON.parse(lines.join("\n")) }
	} catch {
		return { status, body: null }
	}
}

/** HTTP through the public gate, never the gateway's removed in-process file API. */
function fileRequest(route, init = {}) {
	const script = `const res = await fetch(${JSON.stringify(`http://127.0.0.1:3000${route}`)}, { ...${JSON.stringify(init)}, signal: AbortSignal.timeout(10000) });
const raw = await res.text(); let body = raw; try { body = JSON.parse(raw) } catch {}
console.log(JSON.stringify({ status: res.status, body, etag: res.headers.get("etag") }));`
	const r = inside(`node --input-type=module -e ${q(script)}`, { timeoutMs: 15_000 })
	try { return JSON.parse(r.out.trim()) }
	catch { return { status: 0, body: { error: `file request failed (exit ${r.code}): ${r.out}${r.err}` } } }
}

async function waitFiles(timeoutMs = 60_000) {
	const deadline = Date.now() + timeoutMs
	let result
	do {
		result = fileRequest("/files/info")
		if (result.status === 200 && result.body?.ready === true) return result.body
		await sleep(1000)
	} while (Date.now() < deadline)
	check("/files/info becomes ready through the public gate", false, JSON.stringify(result))
	return null
}

async function waitReady(predicate, timeoutMs, what) {
	const t0 = Date.now()
	let last = null
	while (Date.now() - t0 < timeoutMs) {
		last = readyz()
		if (last.status === 200 && predicate(last.body?.components?.engine ?? {})) return last
		await sleep(1000)
	}
	check(what, false, `after ${timeoutMs / 1000} s: ${last?.status} ${JSON.stringify(last?.body?.components ?? last?.body)}`)
	return null
}

function acpTurn(mode, prompt, timeoutMs = 120_000) {
	const r = inside(`node ${TEST_DIR}/image/acp-turn.mjs --mode ${q(mode)} --prompt ${q(prompt)} --timeout-ms ${timeoutMs}`, { timeoutMs: timeoutMs + 30_000 })
	try {
		return JSON.parse(r.out.trim().split("\n").pop())
	} catch {
		return { error: `no JSON (exit ${r.code}): ${r.out}${r.err}` }
	}
}

function llmRequests() {
	const r = inside(`cat ${LLM_LOG} 2>/dev/null`)
	return r.out
		.split("\n")
		.filter(Boolean)
		.map((line) => {
			try {
				return JSON.parse(line)
			} catch {
				return null
			}
		})
		.filter(Boolean)
}

/** The tool result text of the request that followed a tool call (the latest tool message in its body). */
function lastToolResult(request) {
	const tools = (request?.body?.messages ?? []).filter((m) => m.role === "tool")
	const content = tools.at(-1)?.content
	return typeof content === "string" ? content : Array.isArray(content) ? content.map((c) => c.text ?? "").join("") : ""
}

// ---------------------------------------------------------------------------------------------------------------
function staticChecks() {
	console.log(`\n== static (${IMAGE}, engine pin ${PIN})`)
	const script = String.raw`
t=$(mktemp -d); chown geocluster "$t"
v=$(gosu geocluster env -i PATH="$PATH" HOME="$t" TMPDIR="$t" XDG_DATA_HOME="$t/d" XDG_CONFIG_HOME="$t/c" XDG_STATE_HOME="$t/s" XDG_CACHE_HOME="$t/k" OPENCODE_DISABLE_AUTOUPDATE=1 opencode --version 2>&1)
echo "version	$v"
rm -rf "$t"
echo "prompts	$(node -e '
const fs = require("fs"); let count = 0; const missing = [];
for (const profile of ["native", "managed"]) {
  const root = "/opt/opencode/config/" + profile, c = JSON.parse(fs.readFileSync(root + "/opencode.json", "utf8"));
  const refs = [...JSON.stringify(c).matchAll(/\{file:\.\/([^}]+)\}/g)].map((m) => m[1]); count += refs.length;
  missing.push(...refs.filter((f) => !fs.existsSync(root + "/" + f)).map(f => profile + "/" + f));
}
console.log(count + " " + missing.join(","))')"
echo "writable	$(for u in geocluster gc-files gc-preview; do gosu "$u" find /opt/opencode /opt/geocluster-runtime /entrypoint.sh /usr/share/doc/geocluster-runtime -writable -print 2>&1; done | head -5 | tr '\n' ' ')"
echo "notroot	$(find /opt/opencode /opt/geocluster-runtime /entrypoint.sh /usr/share/doc/geocluster-runtime \( ! -user root -o ! -group root \) -print 2>&1 | head -5 | tr '\n' ' ')"
echo "identities	$(id -u geocluster):$(id -g geocluster) $(id -u gc-files):$(id -g gc-files) $(id -u gc-preview):$(id -g gc-preview)"
echo "launcher	$(stat -c '%u:%g:%a:%h' /opt/geocluster-runtime/lib/preview-launcher/build/preview-launcher)"
echo "native	$(gosu gc-files node -e '
const fs = require("node:fs");
const files = ["/opt/geocluster-runtime/lib/safe-fs/build/safe_fs.node", "/opt/geocluster-runtime/node_modules/better-sqlite3/build/Release/better_sqlite3.node"];
for (const file of files) { const s = fs.lstatSync(file); if (!s.isFile() || s.uid !== 0 || s.gid !== 0 || (s.mode & 0o022) || s.nlink !== 1) throw new Error("unsafe native helper: " + file); }
require(files[0]); const Database = require("/opt/geocluster-runtime/node_modules/better-sqlite3");
const db = new Database(":memory:"); db.prepare("SELECT 1").get(); db.close(); console.log("loaded root-owned bindings");')"
P=/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin
w=""; for d in $(echo "$P" | tr ':' ' '); do gosu geocluster test -w "$d" && w="$w $d"; done
echo "pathwritable	$w"
echo "rg	$(command -v rg) $(rg --version | head -1)"
echo "libgomp	$(ldconfig -p | grep -c 'libgomp.so.1')"
echo "poppler	$(command -v pdftotext) $(command -v pdfinfo)"
echo "tmpopencode	$(ls -d /tmp/opencode 2>/dev/null)"
echo "notice	$(grep -c 'OpenCode' /usr/share/doc/geocluster-runtime/ThirdPartyNotices.txt 2>/dev/null)"
echo "home	$(ls -A /opt/opencode/home)$(ls -A /opt/opencode/xdg-config)"
echo "confighash	$(cd /opt/opencode/config && find . -type f -print0 | LC_ALL=C sort -z | xargs -0 sha256sum | sha256sum | cut -c1-64)"
`
	const r = docker(["run", "--rm", "--network", "none", "--entrypoint", "bash", IMAGE, "-c", script])
	const kv = Object.fromEntries(
		r.out
			.split("\n")
			.filter((l) => l.includes("\t"))
			.map((l) => [l.slice(0, l.indexOf("\t")), l.slice(l.indexOf("\t") + 1).trim()]),
	)
	check("the image runs", r.code === 0, r.err || r.out)
	check(`opencode --version is the pin (v${PIN})`, kv.version === `opencode v${PIN}`, kv.version)
	const [count, missing] = (kv.prompts ?? "0 x").split(" ")
	check("every prompt native/managed opencode.json names is in the image", Number(count) >= 18 && !missing, kv.prompts || r.err)
	check("trusted engine/runtime code, entrypoint and notice are not writable by agent, file service or parser", kv.writable === "", kv.writable)
	check("all of it is owned by root:root", kv.notroot === "", kv.notroot)
	check("agent 999:999, file service 998:999 and parser 997:997 are distinct", kv.identities === "999:999 998:999 997:997", kv.identities)
	check("preview launcher is root:root, mode 4755, with one link", kv.launcher === "0:0:4755:1", kv.launcher)
	check("safe-fs and SQLite native bindings are root-owned and load as gc-files", kv.native === "loaded root-owned bindings", kv.native || r.err)
	check("no PATH folder is writable by geocluster (the engine resolves rg, git, the shell from PATH)", kv.pathwritable === "", kv.pathwritable)
	check("ripgrep at /usr/bin/rg", /^\/usr\/bin\/rg ripgrep \d/.test(kv.rg ?? ""), kv.rg)
	check("libgomp.so.1 installed", Number(kv.libgomp) >= 1, kv.libgomp)
	check("PDF extraction utilities are installed at their fixed paths", kv.poppler === "/usr/bin/pdftotext /usr/bin/pdfinfo", kv.poppler)
	check("no /tmp/opencode baked into the image", kv.tmpopencode === "", kv.tmpopencode)
	check("the OpenCode MIT notice ships in the image", Number(kv.notice) >= 1, kv.notice)
	check("the engine's HOME and XDG_CONFIG_HOME are empty", kv.home === "", kv.home)
	check("the image's /opt/opencode/config is byte-identical to the repo's opencode/config (no stale image)", kv.confighash === repoConfigHash(), `image ${kv.confighash}\nrepo  ${repoConfigHash()}`)
}

/** sha256 over `sha256sum` lines of every file in the repo's opencode/config, as the image's check computes it. */
function repoConfigHash() {
	const root = path.join(REPO, "opencode", "config")
	const files = []
	const walk = (dir) => {
		for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
			const full = path.join(dir, entry.name)
			if (entry.isDirectory()) walk(full)
			else if (entry.isFile()) files.push("./" + path.relative(root, full))
		}
	}
	walk(root)
	files.sort((a, b) => (Buffer.from(a) < Buffer.from(b) ? -1 : Buffer.from(a) > Buffer.from(b) ? 1 : 0))
	const lines = files.map((f) => `${crypto.createHash("sha256").update(fs.readFileSync(path.join(root, f))).digest("hex")}  ${f}\n`).join("")
	return crypto.createHash("sha256").update(lines).digest("hex")
}

/** The image through its real entrypoint, offline, on the test volume (extra: more `docker run` args). */
function startContainer(extra = []) {
	return docker([
		"run", "-d", "--name", NAME, "--network", "none",
		"--entrypoint", "/bin/bash",
		"-e", `PROJECT_ID=${PROJECT}`, "-e", "USER_ID=image-test",
		"-e", "RUNTIME_AUTH_DISABLED=1",
		"-e", "RUNTIME_PROFILE=managed",
		"-e", `LLM_PROXY_URL=http://127.0.0.1:${LLM_PORT}/v1`,
		"-e", `IDE_MACHINE_CREDENTIALS_URL=http://127.0.0.1:${LLM_PORT}/renew`, "-e", "IDE_MACHINE_TOKEN=local-machine-only",
		...extra,
		"-v", `${NAME}:/workspace`,
		"-v", `${path.join(REPO, "runtime", "test")}:${TEST_DIR}:ro`,
		"-v", `${path.join(REPO, "opencode")}:/opt/gc-opencode:ro`,
		IMAGE, "-c", "for i in {1..300}; do if [ -f /tmp/image-backend-ready ]; then exec /entrypoint.sh headless; fi; sleep .1; done; exit 2",
	])
}

async function startBackend() {
	const fixture = docker(["exec", "-d", "-e", `IMAGE_BACKEND_PORT=${LLM_PORT}`, NAME, "bash", "-c", `exec node ${TEST_DIR}/image/image-backend.mjs >/tmp/image-backend.log 2>&1`])
	if (!check("loopback backend process launched before the managed entrypoint", fixture.code === 0, fixture.err)) return false
	for (let i = 0; i < 100; i++) {
		if (inside("test -f /tmp/image-backend-ready").code === 0) return check("renewal, schema-2 discovery and fake LLM listeners ready", true)
		await sleep(100)
	}
	return check("renewal, schema-2 discovery and fake LLM listeners ready", false, inside("cat /tmp/image-backend.log").out)
}

/** Inspect the config the real engine received, including generated /run/runtime roots. */
function managedConfigChecks(engine) {
	// Docker root lacks CAP_SYS_PTRACE; read the engine's environment as its own uid.
	const environment = inside(`cat /proc/${Number(engine.pid)}/environ`, { user: "geocluster" })
	const env = environment.out.split("\0")
	managedConfigDir = env.find(value => value.startsWith("OPENCODE_CONFIG_DIR="))?.slice("OPENCODE_CONFIG_DIR=".length)
	if (!check("real engine uses a managed config directory", managedConfigDir?.startsWith("/run/runtime/") || managedConfigDir === "/opt/opencode/config/managed", managedConfigDir || environment.err)) return
	const script = `const fs = require("node:fs"), path = require("node:path");
const root = ${JSON.stringify(managedConfigDir)}, config = JSON.parse(fs.readFileSync(path.join(root, "opencode.json"), "utf8"));
const fixture = JSON.parse(fs.readFileSync(${JSON.stringify(`${TEST_DIR}/image/processor-discovery-fixture.json`)}, "utf8")).projection;
if (config.model !== "proxy/" + fixture.default_model_id || JSON.stringify(config.providers?.proxy?.models) !== JSON.stringify(fixture.managed_models)) throw new Error("discovered catalog not installed");
if (JSON.stringify(config.experimental?.policies) !== JSON.stringify([{action:"provider.use",resource:"*",effect:"deny"},{action:"provider.use",resource:"proxy",effect:"allow"}])) throw new Error("managed provider policy missing");
for (const ref of JSON.stringify(config).matchAll(/\\{file:\\.\\/([^}]+)\\}/g)) fs.accessSync(path.join(root, ref[1]));
function walk(file) { const s = fs.lstatSync(file); if (s.uid !== 0 || s.gid !== 0 || (s.mode & 0o022)) throw new Error("unsafe generated config: " + file); if (s.isDirectory()) for (const name of fs.readdirSync(file)) walk(path.join(file, name)); }
walk(root); const observed = JSON.parse(fs.readFileSync("/tmp/image-backend-observation.json", "utf8"));
if (!observed.renewals || !observed.discoveries) throw new Error("renewal/discovery not exercised");
console.log("root-owned managed catalog and policy installed after renewal/discovery");`
	const result = inside(`node -e ${q(script)}`)
	check("real managed config contains discovered models, provider policy and protected prompt files", result.code === 0, result.out + result.err)
}

async function boot() {
	console.log(`\n== boot (${NAME}, --network none)`)
	const vol = docker(["volume", "create", NAME])
	if (!check("volume created", vol.code === 0, vol.err)) return false
	const run = startContainer()
	if (!check("container started", run.code === 0, run.err)) return false
	if (!await startBackend()) return false
	const ready = await waitReady((e) => e.state === "ready" && e.tools === "connected", 240_000, "/readyz 200: engine ready, geocluster tools connected")
	if (!ready) return false
	const { engine, mcp } = ready.body.components
	managedConfigChecks(engine)
	check("/readyz 200: engine ready, geocluster tools connected", true)
	check(`engine version ${engine.version}, generation ${engine.generation}; shared MCP ${mcp?.state}`, engine.version === PIN && mcp?.state === "ready", JSON.stringify({ engine, mcp }))
	check("build identity says engine opencode", ready.body.build?.engine === "opencode", JSON.stringify(ready.body.build))
	const files = await waitFiles()
	check("/files/info: ready contract 1, protected captures and separate preview worker available", files?.filesContractVersion === 1 && files.ready === true && files.cwd === WS && files.captures?.state === "available" && files.preview?.state === "available" && ["upload", "mkdir", "capture", "preview", "segments"].every((op) => files.operations?.includes(op)), JSON.stringify(files))
	const workbook = files?.providerDetails?.find((provider) => provider.id === "workbook")
	check("/files/info: installed workbook reader verifies confinement and decodes XLS/XLSX", workbook?.readiness?.state === "available" && workbook.readiness.confinement === "verified" && ["filesystemDenied", "socketDenied", "executionDenied", "signalDenied"].every((probe) => workbook.readiness.probe?.[probe] === true) && JSON.stringify(workbook.readiness.probe?.decoded) === JSON.stringify(["xls", "xlsx"]), JSON.stringify(workbook))
	try { requireNativeProviders(files); check('/files/info: workbook, assay, vector and raster have verified native confinement', true) }
	catch { check('/files/info: workbook, assay, vector and raster have verified native confinement', false) }
	const native = inside(`gosu gc-files node ${RUNTIME_DIR}/scripts/qualify-native-readers.mjs`, { timeoutMs: 140000 })
	check('fresh installed readers pass every decode and denial probe', native.code === 0, native.out + native.err)
	return true
}

function turns() {
	console.log("\n== turns (real engine, fake LLM)")
	const smoke = inside(
		`ACP_SMOKE_TURN_TIMEOUT_MS=90000 node ${TEST_DIR}/gateway-smoke.mjs --url http://127.0.0.1:3000 --write --prompt "SAY OK" --long-prompt "HANG counting"`,
		{ timeoutMs: 600_000 },
	)
	const fails = smoke.out.split("\n").filter((l) => /^\s*FAIL/.test(l))
	check("gateway-smoke.mjs passes inside the container", smoke.code === 0, fails.join("\n") || smoke.out.slice(-1500) + smoke.err.slice(-500))

	// A pattern that matches only the seeded README: the fake LLM echoes just the first 200 chars of a tool result, and
	// the smoke's conversations have already written report files
	const glob = acpTurn("geology", 'TOOL glob {"pattern":"README.md"}')
	check("a geology glob turn ends end_turn and finds the workspace README", glob.stopReason === "end_turn" && /README\.md/.test(glob.text ?? ""), JSON.stringify(glob))
	const rg = inside(`grep -c 'downloading ripgrep' ${ENGINE_LOG}`)
	check("the engine used the image's rg (no 'downloading ripgrep' in its log)", rg.out.trim() === "0", rg.out + rg.err)

	const before = llmRequests().length
	const env = acpTurn("standard", 'TOOL shell {"command":"env | grep -E \'^(HOME|XDG_[A-Z_]+|IDE_LLM_TOKEN|OPENCODE_PASSWORD|OPENCODE_SERVER_PASSWORD|GEOCLUSTER_RUN_DIR)=\' | sort"}')
	const after = llmRequests().slice(before)
	const result = lastToolResult(after.findLast((r) => r.lastRole === "tool")) || ""
	const vars = Object.fromEntries(result.split("\n").filter((l) => /^[A-Z_]+=/.test(l)).map((l) => [l.slice(0, l.indexOf("=")), l.slice(l.indexOf("=") + 1)]))
	check("a standard shell turn ends end_turn", env.stopReason === "end_turn", JSON.stringify(env))
	check(
		"tool shells: HOME and XDG folders under /home/geocluster, the run folder set",
		vars.HOME === "/home/geocluster" &&
			vars.XDG_CONFIG_HOME === "/home/geocluster/.config" &&
			vars.XDG_DATA_HOME === "/home/geocluster/.local/share" &&
			vars.XDG_STATE_HOME === "/home/geocluster/.local/state" &&
			vars.XDG_CACHE_HOME === "/home/geocluster/.cache" &&
			vars.GEOCLUSTER_RUN_DIR === `runs/${env.sessionId}`,
		result || JSON.stringify(after.map((r) => r.lastRole)),
	)
	check(
		"tool shells: no IDE_LLM_TOKEN, OPENCODE_PASSWORD or OPENCODE_SERVER_PASSWORD",
		result.includes("HOME=") && !("IDE_LLM_TOKEN" in vars) && !("OPENCODE_PASSWORD" in vars) && !("OPENCODE_SERVER_PASSWORD" in vars),
		result,
	)
	return glob
}

function engineSmoke() {
	if (SKIP_ENGINE_SMOKE) return console.log("\n== engine smoke: skipped (--skip-engine-smoke)")
	console.log("\n== engine smoke (opencode/scripts/engine-smoke.mjs, installed binary)")
	// The image's own config (copied into the smoke's sandbox), not the mounted working tree
	const r = inside("OPENCODE_BIN=/usr/local/bin/opencode OPENCODE_SMOKE_CONFIG=/opt/opencode/config node /opt/gc-opencode/scripts/engine-smoke.mjs", { user: "geocluster", timeoutMs: 300_000 })
	check("engine-smoke.mjs passes against /usr/local/bin/opencode with baked profile sources", r.code === 0, (r.out + r.err).slice(-1500))
}

/** [path, content]: root-owned config sources. Each write must fail and leave nothing behind. */
const ALLOW_ALL = JSON.stringify({ agents: { geology: { permissions: [{ action: "*", resource: "*", effect: "allow" }] } } })
const ROOT_OWNED = [
	["/opt/opencode/config/native/opencode.json", '{"agents":{}}'],
	["/opt/opencode/config/managed/opencode.json", '{"agents":{}}'],
	["/opt/opencode/config/plugins/zz-plant.js", `export default { id: "zz", async setup() { console.error("${MARKER}") } }`],
	["/opt/opencode/config/agents/plant.md", `---\ndescription: ${MARKER}\n---\n${MARKER}`],
	["/opt/opencode/config/AGENTS.md", MARKER],
	["/opt/opencode/home/.claude/skills/plant/SKILL.md", `---\nname: plant\ndescription: ${MARKER}\n---\n${MARKER}`],
	["/opt/opencode/home/.agents/skills/plant/SKILL.md", `---\nname: plant\ndescription: ${MARKER}\n---\n${MARKER}`],
	["/opt/opencode/home/.gitconfig", "[core]\n\tfsmonitor = /bin/true"],
	["/opt/opencode/xdg-config/git/config", "[core]\n\tfsmonitor = /bin/true"],
	["/opt/opencode/xdg-config/opencode/opencode.json", '{"agents":{}}'],
	["/opt/opencode/node_modules/plant/index.js", MARKER],
	["/opt/node_modules/plant/index.js", MARKER],
	["/node_modules/plant/index.js", MARKER],
	[`${RUNTIME_DIR}/lib/config.js`, MARKER],
	[`${RUNTIME_DIR}/gate.cjs`, MARKER],
	[`${RUNTIME_DIR}/files-server.js`, MARKER],
	[`${RUNTIME_DIR}/lib/safe-fs/build/safe_fs.node`, MARKER],
	[`${RUNTIME_DIR}/node_modules/better-sqlite3/build/Release/better_sqlite3.node`, MARKER],
	[LAUNCHER, MARKER],
	["/workspace/opencode.json", ALLOW_ALL],
	["/workspace/.runtime/archive/plant", MARKER],
	[`${FILES_STATE_DIR}/plant`, MARKER],
	["/entrypoint.sh", MARKER],
	// root's own logs: a link here would let root create or append to any file
	["/var/log/runtime-root/viz-publish.log", MARKER],
	["/var/log/runtime-root/plant.log", MARKER],
]
/** Writable by geocluster inside the project: the write works, the engine must ignore it. */
const PROJECT_PLANTS = [
	[`${WS}/opencode.json`, ALLOW_ALL],
	[`${WS}/opencode.jsonc`, ALLOW_ALL],
	[`${WS}/.opencode/opencode.json`, ALLOW_ALL],
	[`${WS}/.opencode/plugins/zz-plant.js`, `export default { id: "zz-plant", async setup() { console.error("${MARKER}-plugin") } }`],
	// Named like the real agent, with an allow-all rule: if loaded, geology's tools change and the marker is in its prompt
	[`${WS}/.opencode/agents/geology.md`, `---\ndescription: ${MARKER}-agent\npermissions:\n  - action: "*"\n    resource: "*"\n    effect: allow\n---\n${MARKER}-agent`],
	[`${WS}/AGENTS.md`, `${MARKER}-agents-md`],
	[`${WS}/.claude/skills/plant/SKILL.md`, `---\nname: plant\ndescription: ${MARKER}-skill\n---\n${MARKER}-skill`],
	[`${WS}/.agents/skills/plant/SKILL.md`, `---\nname: plant\ndescription: ${MARKER}-skill\n---\n${MARKER}-skill`],
]

async function plants(globTurn) {
	console.log("\n== plants (as geocluster, the engine's uid)")
	if (managedConfigDir && managedConfigDir !== "/opt/opencode/config/managed") ROOT_OWNED.push(
		[`${managedConfigDir}/opencode.json`, '{"agents":{}}'],
		[`${managedConfigDir}/plugins/zz-plant/index.js`, MARKER],
		[`${managedConfigDir}/prompts/geology.md`, MARKER],
	)
	const write = ([file, content]) =>
		inside(`mkdir -p ${q(path.dirname(file))} 2>/dev/null; printf '%s' ${q(content)} > ${q(file)}`, { user: "geocluster" })
	const sums = inside(`sha256sum ${ROOT_OWNED.map(([f]) => q(f)).join(" ")} 2>/dev/null`).out
	for (const plant of ROOT_OWNED) {
		const r = write(plant)
		check(`refused: ${plant[0]}`, r.code !== 0, `exit ${r.code} ${r.err}`)
	}
	const renamed = inside(`mv /opt/opencode/config /opt/opencode/config.planted || mv ${RUNTIME_DIR} ${RUNTIME_DIR}.planted`, { user: "geocluster" })
	check("refused: renaming the config or the gateway folder away", renamed.code !== 0, renamed.err)
	check("every root-owned file is unchanged and nothing new appeared", inside(`sha256sum ${ROOT_OWNED.map(([f]) => q(f)).join(" ")} 2>/dev/null`).out === sums)

	for (const plant of PROJECT_PLANTS) {
		const r = write(plant)
		check(`planted (writable, must be ignored): ${plant[0]}`, r.code === 0, r.err)
	}

	// The tools geology was offered before any plant, from the glob turn's first model request
	const requests = llmRequests()
	const geologyTools = (r) => (r.agent === "geology" && !r.aux ? [...(r.tools ?? [])].sort().join(" ") : null)
	const baseline = requests.map(geologyTools).find(Boolean)
	check("baseline: geology's offered tools recorded (no shell, edit or write)", baseline && !/\b(shell|edit|write|grep)\b/.test(baseline), baseline)

	const engine0 = readyz().body?.components?.engine ?? {}
	const killed = inside(`kill -9 ${Number(engine0.pid)}`)
	check(`engine (pid ${engine0.pid}, generation ${engine0.generation}) killed`, killed.code === 0, killed.err)
	const again = await waitReady(
		(e) => e.state === "ready" && e.tools === "connected" && e.generation > engine0.generation,
		120_000,
		"the gateway restarted the engine (ready, tools connected, next generation)",
	)
	if (!again) return
	check(`restarted: generation ${again.body.components.engine.generation}`, true)

	const n = requests.length
	const turn = acpTurn("geology", "SAY plant check")
	check("a geology turn after the restart ends end_turn", turn.stopReason === "end_turn", JSON.stringify(turn))
	// geology has no `skill` tool; standard has, and a loaded skill would be listed in that tool's description
	const std = acpTurn("standard", "SAY plant check")
	check("a standard turn after the restart ends end_turn", std.stopReason === "end_turn", JSON.stringify(std))
	const fresh = llmRequests().slice(n)
	const tools = fresh.map(geologyTools).find(Boolean)
	check("geology is offered exactly the same tools as before the plants", tools === baseline, `before: ${baseline}\nafter:  ${tools}`)
	const leaked = fresh.filter((r) => JSON.stringify(r.body ?? {}).includes(MARKER))
	check(
		"no planted text reaches any geology or standard model request (AGENTS.md, skills, agents)",
		fresh.some((r) => r.agent === "geology") && fresh.some((r) => r.agent === "standard") && leaked.length === 0,
		`agents: ${fresh.map((r) => r.agent).join(",")}; leaked in: ${leaked.map((r) => r.seq).join(",")}`,
	)
	const log = inside(`grep -c ${MARKER} ${ENGINE_LOG}`)
	check("no planted plugin ran (no marker in the engine log)", log.out.trim() === "0", log.out)
	void globTurn
}

/** Validate the retained store without repairing any permissions in the test. */
function fileStoreChecks(label) {
	const script = `const fs = require("node:fs"), path = require("node:path");
const errors = [];
for (const dir of ["/workspace", "/workspace/.runtime", "/workspace/.runtime/file-service"]) {
  const s = fs.lstatSync(dir); if (!s.isDirectory() || s.uid !== 0 || s.gid !== 0 || (s.mode & 0o022)) errors.push("unsafe protected parent: " + dir);
}
const root = ${JSON.stringify(FILES_STATE_DIR)}, entries = [];
function walk(file) {
  const s = fs.lstatSync(file); entries.push({ path: file, uid: s.uid, gid: s.gid, mode: s.mode & 0o7777, dev: s.dev, ino: s.ino });
  if ((!s.isDirectory() && !s.isFile()) || s.uid !== 998 || s.gid !== 999 || (s.mode & 0o077) || (s.isFile() && s.nlink !== 1)) errors.push("unsafe service state: " + file);
  if (s.isDirectory()) for (const name of fs.readdirSync(file)) walk(path.join(file, name));
}
walk(root); console.log(JSON.stringify({ errors, entries }));`
	const r = inside(`node -e ${q(script)}`)
	let state
	try { state = JSON.parse(r.out) } catch { state = null }
	check(`${label}: root-owned volume parents; private file store stays 998:999`, r.code === 0 && state?.errors?.length === 0 && state.entries.some((e) => e.path === `${FILES_STATE_DIR}/files.sqlite`), r.err || JSON.stringify(state))
	for (const user of ["geocluster", "gc-preview"]) {
		const denied = inside(`node -e ${q(`try { require("node:fs").readdirSync(${JSON.stringify(FILES_STATE_DIR)}); process.exit(1) } catch (e) { if (e.code !== "EACCES") throw e }`)}`, { user })
		check(`${label}: ${user} cannot read protected file state`, denied.code === 0, denied.out + denied.err)
	}
	return state
}

function retainedFiles() {
	console.log("\n== retained file evidence (public gate, gc-files store, gc-preview parser)")
	const info = fileRequest("/files/info").body
	const folder = "runs/image-files", target = `${folder}/retained.csv`, bytes = 'name,value\n"multi\nline",42\n'
	const mkdir = fileRequest("/files/mkdir", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ operationId: "image-files-mkdir", path: folder, parents: true }) })
	check("retained fixture directory committed", mkdir.status === 200 && mkdir.body?.state === "committed", JSON.stringify(mkdir))
	const upload = fileRequest(`/files/upload?path=${target}&operationId=image-files-upload`, { method: "PUT", body: bytes })
	check("retained fixture upload committed with protected bytes", upload.status === 201 && upload.body?.state === "committed" && upload.body.publishedSource?.digest?.sha256 === crypto.createHash("sha256").update(bytes).digest("hex"), JSON.stringify(upload))
	const preview = fileRequest("/files/preview", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ path: target, format: "csv", rowLimit: 2 }) })
	check("the separate parser handles a multiline CSV through the public gate", preview.status === 200 && preview.body?.filesContractVersion === 1 && preview.body.source?.kind === "runtime-fragment" && preview.body.rows?.[1]?.cells?.[0]?.text === "multi\nline", JSON.stringify(preview))
	const live = fileRequest(`/files/stat?path=${target}`), directory = fileRequest(`/files/stat?path=${folder}`)
	check("live file and parent directory observations recorded before reboot", live.status === 200 && live.body?.observation?.token && directory.status === 200 && directory.body?.observation?.token, JSON.stringify({ live, directory }))
	return { info, receipt: upload.body, target, folder, bytes, observation: live.body?.observation, directoryObservation: directory.body?.observation, ownership: fileStoreChecks("before reboot") }
}

function logs() {
	console.log("\n== logs")
	const r = inside(`grep -i -E 'EACCES|permission denied' ${ENGINE_LOG} | head -5`)
	check("no EACCES / permission denied in the engine log", r.out.trim() === "", r.out)
	const rootOwned = inside("find /var/log/runtime ! -user geocluster -print | head -5")
	check("root writes nothing into /var/log/runtime (its logs are in /var/log/runtime-root)", rootOwned.out.trim() === "", rootOwned.out)
}

async function reboot(retained) {
	console.log("\n== reboot with links planted on the volume (root must not follow them)")
	const refused = inside("ln -s /opt/opencode/config /workspace/.runtime/archive", { user: "geocluster" })
	check("refused as geocluster: planting .runtime/archive through its root-owned parent", refused.code !== 0 && inside("test ! -e /workspace/.runtime/archive && test ! -L /workspace/.runtime/archive").code === 0, refused.err)
	const plant = inside(
		[
			"set -e",
			`rm -rf ${WS}/viz && ln -s /opt/opencode/config ${WS}/viz`,
			"mkdir -p /workspace/.runtime/gateway/datasets && ln -sfn /opt/opencode/config/AGENTS.md /workspace/.runtime/gateway/datasets/status.json.tmp",
		].join("\n"),
		{ user: "geocluster" },
	)
	if (!check("planted as geocluster: viz/ and a dataset status temp file as links to root-owned config", plant.code === 0, plant.err)) return
	// Legacy state predates protected parents. Seed it as root on this disposable volume; never grant the agent write access.
	const legacy = inside("mkdir -p /workspace/.ide-state && echo legacy > /workspace/.ide-state/marker")
	check("legacy archive fixture seeded by root", legacy.code === 0, legacy.err)
	const stopped = docker(["stop", "--time", "40", NAME])
	check("container stopped for a retained-volume restart", stopped.code === 0, stopped.err)
	const removed = docker(["rm", NAME])
	if (!check("stopped container removed", removed.code === 0, removed.err)) return
	// A fresh container on the same volume, as after a Fly restart; renewal supplies
	// the dataset purpose token so the status writer exercises the planted link.
	const run = startContainer(["-e", "IDE_DATASETS_URL=http://127.0.0.1:9/datasets"])
	if (!check("fresh container started on the planted volume", run.code === 0, run.err)) return
	if (!await startBackend()) return
	const ready = await waitReady((e) => e.state === "ready", 240_000, "the planted volume still boots (/readyz 200)")
	if (!ready) return
	check("the planted volume still boots (/readyz 200)", true)
	managedConfigChecks(ready.body.components.engine)
	// The read-only test fixture mount has host file owners; it is not shipped runtime code.
	const state = inside(String.raw`
echo "archive	$([ -d /workspace/.runtime/archive ] && [ ! -L /workspace/.runtime/archive ] && echo real) $(ls /workspace/.runtime/archive 2>/dev/null | grep -c ide-state)"
echo "config	$(ls -A /opt/opencode/config | tr '\n' ' ')"
echo "agentsmd	$(ls /opt/opencode/config/AGENTS.md 2>/dev/null)"
echo "writable	$(gosu geocluster find /opt/opencode /opt/geocluster-runtime /entrypoint.sh /usr/bin -writable -print 2>&1 | head -5 | tr '\n' ' ')"
echo "notroot	$(find /opt/opencode /opt/geocluster-runtime /entrypoint.sh -path ${TEST_DIR} -prune -o \( ! -user root -o ! -group root \) -print 2>&1 | head -5 | tr '\n' ' ')"
`)
	const kv = Object.fromEntries(state.out.split("\n").filter((l) => l.includes("\t")).map((l) => [l.slice(0, l.indexOf("\t")), l.slice(l.indexOf("\t") + 1).trim()]))
	check(".runtime/archive is a real folder holding the archived legacy state", kv.archive === "real 1", kv.archive)
	// Exactly the repo's top-level entries: no archive/, ide-state, state dirs or AGENTS.md written through a link
	const expected = fs.readdirSync(path.join(REPO, "opencode", "config")).sort().join(" ")
	check("/opt/opencode/config gained nothing (no archive, no AGENTS.md from the status writer)", kv.config === expected && kv.agentsmd === "", `got: ${kv.config} | ${kv.agentsmd}\nwant: ${expected}`)
	check("after the boot, trusted engine/runtime code, entrypoint and /usr/bin stay read-only to geocluster", kv.writable === "", kv.writable)
	check("after the boot, all of it is still root:root", kv.notroot === "", kv.notroot)
	const files = await waitFiles()
	check("file service retains its workspace identity/epoch with a new bootId", files?.filesContractVersion === 1 && files.captures?.state === "available" && files.preview?.state === "available" && files.workspaceId === retained.info?.workspaceId && files.workspaceEpoch === retained.info?.workspaceEpoch && files.bootId !== retained.info?.bootId, JSON.stringify(files))
	const ownership = fileStoreChecks("after reboot")
	const originalDb = retained.ownership?.entries?.find((e) => e.path === `${FILES_STATE_DIR}/files.sqlite`)
	const currentDb = ownership?.entries?.find((e) => e.path === `${FILES_STATE_DIR}/files.sqlite`)
	check("the retained SQLite store is the same inode after boot ownership repair", originalDb && currentDb && originalDb.dev === currentDb.dev && originalDb.ino === currentDb.ino, JSON.stringify({ before: originalDb, after: currentDb }))
	const receipt = fileRequest("/files/operations/image-files-upload")
	const source = retained.receipt?.publishedSource
	check("the committed upload receipt and capture identity survive restart", receipt.status === 200 && receipt.body?.state === "committed" && source?.captureId && receipt.body.publishedSource?.captureId === source.captureId && receipt.body.publishedSource?.digest?.sha256 === source.digest?.sha256, JSON.stringify(receipt))
	const live = fileRequest(`/files/text?path=${retained.target}`)
	check("gc-files-published workspace bytes survive restart", live.status === 200 && live.body?.text === retained.bytes, JSON.stringify(live))
	if (source?.captureId) {
		const captured = fileRequest(`/files/captures/${source.captureId}/raw`)
		check("protected captured bytes and strong ETag survive restart", captured.status === 200 && captured.body === retained.bytes && captured.etag === source.etag, JSON.stringify(captured))
	}
	const observed = fileRequest(`/files/stat?path=${retained.target}`), directory = fileRequest(`/files/stat?path=${retained.folder}`)
	check("unchanged live file observation token survives actual boot repair", observed.status === 200 && retained.observation?.token && observed.body?.observation?.token === retained.observation.token, JSON.stringify({ before: retained.observation, after: observed }))
	check("unchanged parent directory observation token survives actual boot repair", directory.status === 200 && retained.directoryObservation?.token && directory.body?.observation?.token === retained.directoryObservation.token, JSON.stringify({ before: retained.directoryObservation, after: directory }))
	const replacement = retained.bytes.replace("42", "84")
	const saved = fileRequest(`/files/upload?path=${retained.target}&operationId=image-files-after-reboot&mode=replace`, { method: "PUT", headers: { "x-gc-base-observation": retained.observation?.token || "missing-preboot-observation" }, body: replacement })
	check("conditional upload accepts the live preboot observation after reboot", saved.status === 200 && saved.body?.state === "committed", JSON.stringify(saved))
	check("conditional upload publishes the replacement bytes", fileRequest(`/files/text?path=${retained.target}`).body?.text === replacement, JSON.stringify(saved))
	// Only a file's owner can restore an exact arbitrary mtime. Use an agent-owned input for that regression.
	const agentTarget = `${retained.folder}/agent-edit.csv`
	const seeded = inside(`node -e ${q(`require("node:fs").writeFileSync(${JSON.stringify(`${WS}/${agentTarget}`)}, ${JSON.stringify(replacement)})`)}`, { user: "geocluster" })
	check("agent-owned input created for exact-mtime edit regression", seeded.code === 0, seeded.out + seeded.err)
	const current = fileRequest(`/files/stat?path=${agentTarget}`)
	// Restore the exact nanosecond mtime with GNU touch, rather than round-tripping through a JS Date.
	const edited = inside(`node -e ${q(`const fs = require("node:fs"), { execFileSync } = require("node:child_process");
const file = ${JSON.stringify(`${WS}/${agentTarget}`)}, before = fs.statSync(file, { bigint: true });
fs.writeFileSync(file, ${JSON.stringify(replacement.replace("84", "21"))});
execFileSync("touch", ["-m", "-d", "@" + (before.mtimeNs / 1000000000n) + "." + String(before.mtimeNs % 1000000000n).padStart(9, "0"), file]);
const after = fs.statSync(file, { bigint: true });
console.log(JSON.stringify({ sameSize: before.size === after.size, exactMtime: before.mtimeNs === after.mtimeNs, changedCtime: before.ctimeNs !== after.ctimeNs }));`)}`, { user: "geocluster" })
	let editEvidence
	try { editEvidence = JSON.parse(edited.out) } catch {}
	check("agent edit keeps the same size and exact mtime but advances ctime", edited.code === 0 && editEvidence?.sameSize && editEvidence.exactMtime && editEvidence.changedCtime, edited.out + edited.err)
	const stale = fileRequest(`/files/upload?path=${agentTarget}&operationId=image-files-stale-after-edit&mode=replace`, { method: "PUT", headers: { "x-gc-base-observation": current.body?.observation?.token || "missing-current-observation" }, body: "lost edit" })
	check("same-size/exact-mtime agent edit rejects the stale conditional upload", current.status === 200 && current.body?.observation?.token && stale.status === 409 && stale.body?.error === "source_changed" && fileRequest(`/files/text?path=${agentTarget}`).body?.text === replacement.replace("84", "21"), JSON.stringify(stale))
}

function teardown() {
	if (KEEP) {
		console.log(`\n--keep: container ${NAME} and volume ${NAME} left running. Remove with:\n  docker rm -f ${NAME} && docker volume rm ${NAME}`)
		return
	}
	docker(["rm", "-f", NAME])
	docker(["volume", "rm", NAME])
}

async function main() {
	const inspect = docker(["image", "inspect", IMAGE])
	if (inspect.code !== 0) {
		console.error(`image ${IMAGE} not found: build it first (scripts/build-docker.sh)`)
		process.exit(2)
	}
	staticChecks()
	try {
		if (await boot()) {
			const glob = turns()
			const retained = retainedFiles()
			engineSmoke()
			await plants(glob)
			logs()
			await reboot(retained)
		}
	} finally {
		if (failures && !KEEP) {
			const tail = inside(`tail -40 ${ENGINE_LOG}; echo ---; tail -20 /var/log/runtime/mcp.log 2>/dev/null`)
			console.log(`\n-- engine log tail --\n${tail.out}`)
			const logsOut = docker(["logs", "--tail", "60", NAME])
			console.log(`-- container log tail --\n${logsOut.out}${logsOut.err}`)
		}
		teardown()
	}
	console.log(`\n${failures === 0 ? "ALL PASS" : `${failures} FAILED`}`)
	process.exit(failures === 0 ? 0 : 1)
}

main().catch((error) => {
	console.error(error)
	teardown()
	process.exit(1)
})
