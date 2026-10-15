import assert from "node:assert/strict"
import fs from "node:fs/promises"
import path from "node:path"
import { spawn, spawnSync } from "node:child_process"
import { once } from "node:events"
import { test } from "node:test"
import { EventEmitter } from "node:events"

const root = new URL("../../", import.meta.url).pathname
const ptyRunner = "import os,pty,subprocess,sys; master,slave=pty.openpty(); result=subprocess.run(sys.argv[1:],stdin=slave,stdout=slave,stderr=slave); os.close(slave); output=b'';\nwhile True:\n try: output+=os.read(master,65536)\n except OSError: break\nsys.stdout.buffer.write(output); sys.exit(result.returncode)"

test("entrypoint rejects invalid frontend/profile, missing terminal, and static managed credentials before boot", () => {
	for (const [args, env, message] of [
		[["tui"], { RUNTIME_PROFILE: "managed" }, /profile.*conflict/i],
		[["headless"], { RUNTIME_PROFILE: "native" }, /profile.*conflict/i],
		[["tui"], {}, /native TUI requires a terminal/],
		[[], { IDE_LLM_TOKEN: "static-secret" }, /managed.*machine.*relay/i],
	]) {
		const result = spawnSync("bash", [path.join(root, "entrypoint.sh"), ...args], {
			env: { PATH: process.env.PATH, ...env }, encoding: "utf8", timeout: 5000,
		})
		assert.equal(result.status, 2, result.stdout + result.stderr)
		assert.match(result.stderr, message)
		assert.doesNotMatch(result.stdout, /Runtime machine starting|Daemon started/)
	}
})

test("managed startup rejects native supplier authority before any unprivileged child starts", () => {
	for (const name of ["ANTHROPIC_API_KEY", "OPENAI_API_KEY", "PROVIDER_AUTH_TOKEN", "PROVIDER_ACCESS_TOKEN", "AWS_SECRET_ACCESS_KEY", "GOOGLE_APPLICATION_CREDENTIALS"]) {
		const result = spawnSync("bash", [path.join(root, "entrypoint.sh"), "headless"], {
			env: { PATH: process.env.PATH, IDE_MACHINE_TOKEN: "root-renewal", IDE_MACHINE_CREDENTIALS_URL: "http://backend.invalid/renew", [name]: "must-not-reach-an-agent" },
			encoding: "utf8", timeout: 5000,
		})
		assert.equal(result.status, 2, result.stdout + result.stderr)
		assert.match(result.stderr, /must not receive supplier credentials/)
		assert.doesNotMatch(result.stdout + result.stderr, /must-not-reach-an-agent|Runtime machine starting/)
	}
})

test("terminal launch rejects managed-only native services and unprivileged bootstrap before services", () => {
	const entrypoint = path.join(root, "entrypoint.sh")
	const service = spawnSync("python3", ["-c", ptyRunner, "bash", entrypoint, "tui"], {
		env: { PATH: process.env.PATH, PREPROCESSING_ENABLED: "true" }, encoding: "utf8", timeout: 5000,
	})
	assert.equal(service.status, 2, service.stdout + service.stderr)
	assert.match(service.stdout, /native profile does not support PREPROCESSING_ENABLED/)
	if (process.getuid?.() !== 0) {
		for (const args of [["tui"], []]) {
			const result = spawnSync("python3", ["-c", ptyRunner, "bash", entrypoint, ...args], {
				env: { PATH: process.env.PATH, IDE_MACHINE_TOKEN: "root-renewal", IDE_MACHINE_CREDENTIALS_URL: "http://backend.invalid/renew" }, encoding: "utf8", timeout: 5000,
			})
			assert.equal(result.status, 2, result.stdout + result.stderr)
			assert.match(result.stdout, /requires a root container entrypoint/)
			assert.doesNotMatch(result.stdout, /Daemon started|Runtime machine starting/)
		}
	}
})

test("native engine forwarding is explicit and rejects bootstrap controls without rejecting OpenRouter", async () => {
	const { nativeEngineEnv, validateEngineNames } = await import("../native-engine-env.mjs")
	for (const name of ["HOME", "PATH", "OPENCODE_CONFIG", "GEOCLUSTER_TOKEN", "RUNTIME_ACTIVITY_TOKEN", "IDE_LLM_TOKEN", "PREPROCESSING_TOKEN", "R2_KEY", "XDG_DATA_HOME", "NODE_OPTIONS", "BUN_OPTIONS", "LD_PRELOAD", "PYTHONHOME", "PYTHONPATH", "bad-name", "LLM_PROXY_URL"]) {
		assert.throws(() => validateEngineNames([name]), /reserved|invalid/)
	}
	const env = nativeEngineEnv({ OPENROUTER_API_KEY: "native-secret", IDE_LLM_TOKEN: "stale-secret", ANTHROPIC_API_KEY: "not-opted-in", HOME: "/root" }, ["OPENROUTER_API_KEY"], {
		stateDir: "/private/native/opencode", configDir: "/opt/opencode/native", workspace: "/workspace/demo", mcpUrl: "http://127.0.0.1:7710/mcp",
	})
	assert.equal(env.OPENROUTER_API_KEY, "native-secret")
	assert.equal(env.IDE_LLM_TOKEN, undefined)
	assert.equal(env.ANTHROPIC_API_KEY, undefined)
	assert.equal(env.OPENCODE_DISABLE_MODELS_FETCH, undefined)
	assert.equal(env.OPENCODE_DISABLE_PROJECT_CONFIG, undefined)
	assert.equal(env.OPENCODE_CONFIG_DIR, undefined)
	assert.equal(env.OPENCODE_CONFIG, "/opt/opencode/native/opencode.json")
	assert.equal(env.XDG_CONFIG_HOME, "/private/native/opencode/config")
})

test("managed startup materializes the validated artifact catalog rather than its envelope", async (t) => {
	const dir = await fs.mkdtemp("/tmp/opencode/managed-profile-launch-test-")
	t.after(() => fs.rm(dir, { recursive: true, force: true }))
	const opencode = path.join(dir, "opencode"), runtime = path.join(dir, "runtime")
	await fs.mkdir(path.join(opencode, "scripts"), { recursive: true })
	await fs.mkdir(path.join(opencode, "config"))
	await fs.mkdir(path.join(runtime, "lib"), { recursive: true })
	await fs.writeFile(path.join(runtime, "package.json"), '{"type":"module"}')
	await fs.symlink(path.join(root, "opencode/scripts/build-config.mjs"), path.join(opencode, "scripts/build-config.mjs"))
	for (const name of ["prompts", "plugins"]) await fs.symlink(path.join(root, "opencode/config", name), path.join(opencode, "config", name))
	await fs.writeFile(path.join(runtime, "lib/config.js"), 'export function loadConfig() { return process.env }')
	await fs.writeFile(path.join(runtime, "lib/managed-catalog.js"), `
export async function startupCatalog(config, options) {
 if (!options.protectedParent || config.RUNTIME_MANAGED_BACKEND_BASE_URL !== "https://backend.invalid/llm" || config.IDE_LLM_TOKEN !== "runtime-relay" || config.RUNTIME_MANAGED_CATALOG_PATH !== "/workspace/.runtime/custom-catalog.json" || config.RUNTIME_MANAGED_GENERATION !== "generation-42" || config.RUNTIME_MANAGED_DISCOVERY_MAX_BYTES !== "234567" || config.RUNTIME_STATE_ROOT !== "/workspace/.runtime") throw Error("wrong bootstrap boundary");
 return { state:"fresh", reason:null, artifact: { artifactSchemaVersion:1, digest:"startup-digest", discoverySchemaVersion:2,
 catalog: { managed_models: { "maker/new/nested": { name:"New", capabilities:{tools:true,input:["text"],output:["text"]},limit:{context:1000,input:700,output:200},variants:[] } }, default_model_id:"maker/new/nested" } } };
}`)
	const entrypoint = await fs.readFile(path.join(root, "entrypoint.sh"), "utf8")
	const script = entrypoint.replace(/launch_runtime "\$@"\s*$/, "") + `\nOPENCODE_ROOT=${JSON.stringify(opencode)}; RUNTIME_CODE_DIR=${JSON.stringify(runtime)}; MANAGED_BACKEND_BASE_URL=https://backend.invalid/llm; LLM_PROXY_URL=http://127.0.0.1:3003/llm; configure_managed_profile`
	const sharedEnv = { PATH: process.env.PATH, RUNTIME_MANAGED_CATALOG_PATH: "/workspace/.runtime/custom-catalog.json", RUNTIME_MANAGED_GENERATION: "generation-42", RUNTIME_MANAGED_DISCOVERY_MAX_BYTES: "234567" }
	const result = spawnSync("bash", ["-c", script], { env: sharedEnv, encoding: "utf8", timeout: 10000 })
	assert.equal(result.status, 0, result.stdout + result.stderr)
	const config = JSON.parse(await fs.readFile(path.join(opencode, "config/managed/opencode.json"), "utf8"))
	assert.equal(config.model, "proxy/maker/new/nested")
	assert.equal(config.agents.title.model, config.model)
	assert.deepEqual(Object.keys(config.providers.proxy.models), ["maker/new/nested"])
	assert.match(result.stdout, /startup-digest/)
	const provision = entrypoint.match(/PROJECT_ID="\$PROJECT_ID" PREPROCESSING_ENABLED="\$PREPROCESSING_ENABLED" RUNTIME_AGGREGATE_ACTIVITY="\$RUNTIME_AGGREGATE_ACTIVITY"[\s\S]*?node "\$RUNTIME_CODE_DIR\/lib\/preprocessing-provision.js"/)[0]
	const gateway = entrypoint.match(/exec env -u RUNTIME_GATE_DISABLED -u RUNTIME_GATE_SECRET[\s\S]*?gosu geocluster node "\$RUNTIME_CODE_DIR\/server.js"/)[0]
	const selected = ["RUNTIME_MANAGED_CATALOG_PATH", "RUNTIME_MANAGED_BACKEND_BASE_URL", "RUNTIME_MANAGED_GENERATION", "RUNTIME_MANAGED_DISCOVERY_MAX_BYTES", "RUNTIME_STATE_ROOT"]
	const inspect = `${JSON.stringify(process.execPath)} -e 'console.log(JSON.stringify(Object.fromEntries(${JSON.stringify(selected)}.map(name=>[name,process.env[name]]))))'`
	for (const command of [provision.replace('node "$RUNTIME_CODE_DIR/lib/preprocessing-provision.js"', inspect), gateway.replace('gosu geocluster node "$RUNTIME_CODE_DIR/server.js"', inspect)]) {
		const launched = spawnSync("bash", ["-c", entrypoint.replace(/launch_runtime "\$@"\s*$/, "") + `\nMANAGED_BACKEND_BASE_URL=https://backend.invalid/llm; LLM_PROXY_URL=http://127.0.0.1:3003/llm; ${command}`], { env: sharedEnv, encoding: "utf8", timeout: 10000 })
		assert.equal(launched.status, 0, launched.stdout + launched.stderr)
		assert.deepEqual(JSON.parse(launched.stdout), { RUNTIME_MANAGED_CATALOG_PATH: sharedEnv.RUNTIME_MANAGED_CATALOG_PATH, RUNTIME_MANAGED_BACKEND_BASE_URL: "https://backend.invalid/llm", RUNTIME_MANAGED_GENERATION: sharedEnv.RUNTIME_MANAGED_GENERATION, RUNTIME_MANAGED_DISCOVERY_MAX_BYTES: sharedEnv.RUNTIME_MANAGED_DISCOVERY_MAX_BYTES, RUNTIME_STATE_ROOT: "/workspace/.runtime" })
	}
})

test("host helper forwards named provider values without argv values, ports, healthcheck, or host accounts", async (t) => {
	const dir = await fs.mkdtemp("/tmp/opencode/native-helper-test-")
	t.after(() => fs.rm(dir, { recursive: true, force: true }))
	await fs.writeFile(path.join(dir, "docker"), '#!/bin/sh\nprintf "%s\\n" "$@" > "$CAPTURE"\nprintf "%s" "$OPENROUTER_API_KEY" > "$CAPTURE.provider"\n', { mode: 0o755 })
	const env = { PATH: `${dir}:${process.env.PATH}`, CAPTURE: path.join(dir, "args"), OPENROUTER_API_KEY: "do-not-log-this-secret" }
	const helper = path.join(root, "scripts/run-runtime-tui.sh")
	const reserved = spawnSync("bash", [helper, "--engine-env", "NODE_OPTIONS"], { env, encoding: "utf8" })
	assert.equal(reserved.status, 2)
	assert.match(reserved.stderr, /reserved/)
	const conflict = spawnSync("python3", ["-c", ptyRunner, "bash", helper], { env: { ...env, RUNTIME_PROFILE: "managed" }, encoding: "utf8", timeout: 10000 })
	assert.equal(conflict.status, 2, conflict.stdout + conflict.stderr)
	assert.match(conflict.stdout, /profile\/frontend conflict/)
	const run = spawnSync("python3", ["-c", ptyRunner, "bash", helper, "--engine-env", "OPENROUTER_API_KEY"], { env, encoding: "utf8", timeout: 10000 })
	assert.equal(run.status, 0, run.stdout + run.stderr)
	const args = (await fs.readFile(env.CAPTURE, "utf8")).trim().split("\n")
	assert.ok(args.includes("--no-healthcheck"))
	assert.ok(args.includes("RUNTIME_PROFILE=native"))
	assert.ok(args.includes("OPENROUTER_API_KEY"))
	assert.equal(args.at(-1), "tui")
	assert.ok(!args.some((arg) => /do-not-log|\/home|\/root|publish/.test(arg) || ["-p", "-P"].includes(arg)))
	assert.equal(await fs.readFile(`${env.CAPTURE}.provider`, "utf8"), env.OPENROUTER_API_KEY)
})

test("native supervisor waits for MCP readiness, invokes standalone, and always stops MCP", async (t) => {
	const { runNative } = await import("../native-tui.mjs")
	const dir = await fs.mkdtemp("/tmp/opencode/native-supervisor-test-")
	t.after(() => fs.rm(dir, { recursive: true, force: true }))
	const calls = []
	const mcp = { async start() { await new Promise((resolve) => setTimeout(resolve, 10)); calls.push("ready") }, async stop() { calls.push("stopped") } }
	const logger = { info() {}, error() {} }
	const code = await runNative({ stateDir: dir, workspace: dir, engineEnv: { PATH: process.env.PATH }, mcp, logger, signals: new EventEmitter(),
		spawnImpl(binary, args, options) {
			assert.deepEqual(calls, ["ready"])
			assert.equal(binary, "/usr/local/bin/opencode")
			assert.deepEqual(args, ["--standalone", dir])
			assert.equal(options.stdio, "inherit")
			return spawn(process.execPath, ["-e", "process.exit(23)"], options)
		},
	})
	assert.equal(code, 23)
	assert.deepEqual(calls, ["ready", "stopped"])
	assert.equal((await fs.stat(path.join(dir, "config"))).mode & 0o777, 0o700)
	let spawned = false, stopped = false
	await assert.rejects(runNative({ stateDir: dir, workspace: dir, engineEnv: {}, logger, signals: new EventEmitter(),
		mcp: { async start() { throw new Error("MCP unavailable") }, async stop() { stopped = true } }, spawnImpl() { spawned = true },
	}), /MCP unavailable/)
	assert.equal(spawned, false)
	assert.equal(stopped, true)
})

test("native file daemon retains the two-secret stdin contract without processing descriptors or provider env", async (t) => {
	const dir = await fs.mkdtemp("/tmp/opencode/native-files-launch-test-")
	t.after(() => fs.rm(dir, { recursive: true, force: true }))
	const entrypoint = await fs.readFile(path.join(root, "entrypoint.sh"), "utf8")
	const definitions = entrypoint.replace(/launch_runtime "\$@"\s*$/, "")
	await fs.writeFile(path.join(dir, "gate"), "local-gate-secret")
	const provision = spawnSync("bash", ["-c", `${definitions}\nGATE_SECRET_FILE="$TEST_DIR/gate"; FILES_CONTROL_FILE="$TEST_DIR/control"; FILES_INPUT_FILE="$TEST_DIR/input"; chown() { :; }; write_files_input`], {
		env: { PATH: process.env.PATH, TEST_DIR: dir }, encoding: "utf8",
	})
	assert.equal(provision.status, 0, provision.stderr)
	const source = await fs.readFile(path.join(root, "runtime/native-services.sh"), "utf8")
	const command = source.match(/exec env -i PATH=[\s\S]*?gosu gc-files node "\$RUNTIME_CODE_DIR\/files-server.js"/)[0]
	const inspector = `${JSON.stringify(process.execPath)} -e 'console.log(JSON.stringify({env:process.env,input:require("node:fs").readFileSync(0,"utf8")}))'`
	const result = spawnSync("bash", ["-c", command.replace('gosu gc-files node "$RUNTIME_CODE_DIR/files-server.js"', inspector)], {
		env: { PATH: process.env.PATH, IDE_LLM_TOKEN: "must-not-inherit", OPENROUTER_API_KEY: "engine-only-key", PREPROCESSING_ENABLED: "true", PREPROCESSING_TOKEN_FILE: "/secret", RUNTIME_ACTIVITY_TOKEN: "secret", R2_SECRET_ACCESS_KEY: "secret" },
		input: await fs.readFile(path.join(dir, "input")), encoding: "utf8",
	})
	assert.equal(result.status, 0, result.stderr)
	const { env, input } = JSON.parse(result.stdout)
	assert.equal(input, `local-gate-secret\n${(await fs.readFile(path.join(dir, "control"), "utf8")).trim()}\n`)
	assert.equal(env.FILES_SYNC_ADAPTER, "false")
	assert.equal(env.VOXEL_AGENT_ENABLED, "true")
	assert.ok(!Object.keys(env).some((name) => /^(?:PREPROCESSING_|IDE_|R2_|OPENROUTER_)/.test(name)))
	assert.equal(env.RUNTIME_ACTIVITY_TOKEN, undefined)
})

test("native signal cleanup reaps sampled detached tool descendants with jitter", { timeout: 20000 }, async (t) => {
	const { runNative } = await import("../native-tui.mjs")
	const dir = await fs.mkdtemp("/tmp/opencode/native-tree-test-")
	t.after(() => fs.rm(dir, { recursive: true, force: true }))
	for (let round = 0; round < 3; round++) {
		const pidFile = path.join(dir, `worker-${round}`)
		const signals = new EventEmitter()
		const running = runNative({ stateDir: dir, workspace: dir, engineEnv: {}, signals,
			logger: { info() {}, error() {} }, mcp: { async start() {}, async stop() {} },
			spawnImpl(binary, args, options) {
				return spawn(process.execPath, ["-e", `const c=require('node:child_process').spawn(process.execPath,['-e','process.on("SIGTERM",()=>{});setInterval(()=>{},1000)'],{detached:true,stdio:'ignore'});require('node:fs').writeFileSync(${JSON.stringify(pidFile)},String(c.pid));setInterval(()=>{},1000)`], options)
			},
		})
		let pid
		const end = Date.now() + 5000
		while (!pid && Date.now() < end) {
			pid = Number(await fs.readFile(pidFile, "utf8").catch(() => ""))
			if (!pid) await new Promise((resolve) => setTimeout(resolve, 20))
		}
		assert.ok(pid, "tool worker spawned")
		t.after(() => { try { process.kill(pid, "SIGKILL") } catch {} })
		await new Promise((resolve) => setTimeout(resolve, 150 + Math.floor(Math.random() * 150)))
		signals.emit("SIGTERM")
		assert.equal(await running, 143)
		const stat = await fs.readFile(`/proc/${pid}/stat`, "utf8").catch(() => "")
		assert.ok(!stat || stat.slice(stat.lastIndexOf(")") + 2).startsWith("Z "), "detached worker is no longer running")
	}
})

test("retained lifecycle lock rejects overlap and cross-profile reuse and recovers after owner death", async (t) => {
	const dir = await fs.mkdtemp("/tmp/opencode/native-lock-test-")
	t.after(() => fs.rm(dir, { recursive: true, force: true }))
	const helper = path.join(root, "runtime/lifecycle-lock.py")
	const args = (profile, command) => [helper, dir, profile, ...command]
	const owner = spawn("python3", args("native", ["sh", "-c", "echo LOCKED; exec sleep 30"]), { stdio: ["ignore", "pipe", "pipe"] })
	t.after(() => owner.kill("SIGKILL"))
	let stdout = "", stderr = ""
	owner.stderr.on("data", (c) => { stderr += c })
	owner.stdout.on("data", (c) => { stdout += c })
	await Promise.race([once(owner.stdout, "data"), once(owner, "exit").then(() => { throw new Error(stderr) })])
	assert.match(stdout, /LOCKED/)
	const competing = spawnSync("python3", args("native", ["true"]), { encoding: "utf8" })
	assert.equal(competing.status, 2)
	assert.match(competing.stderr, /already.*owned|another runtime/)
	await Promise.all(Array.from({ length: 12 }, async () => {
		await new Promise((resolve) => setTimeout(resolve, Math.floor(Math.random() * 30)))
		const contender = spawn("python3", args("native", ["true"]), { stdio: ["ignore", "ignore", "pipe"] })
		let error = ""
		contender.stderr.on("data", (chunk) => { error += chunk })
		const [code] = await once(contender, "close")
		assert.equal(code, 2, error)
		assert.match(error, /another runtime/)
	}))
	owner.kill("SIGKILL")
	await once(owner, "exit")
	const recovered = spawnSync("python3", args("native", ["true"]), { encoding: "utf8" })
	assert.equal(recovered.status, 0, recovered.stderr)
	const before = await fs.readFile(path.join(dir, ".runtime/profile"), "utf8")
	const other = spawnSync("python3", args("managed", ["true"]), { encoding: "utf8" })
	assert.equal(other.status, 2)
	assert.match(other.stderr, /ordinary files.*project|ordinary project files/)
	assert.equal(await fs.readFile(path.join(dir, ".runtime/profile"), "utf8"), before)
})
