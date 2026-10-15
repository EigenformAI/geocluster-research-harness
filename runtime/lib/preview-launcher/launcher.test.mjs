import assert from "node:assert/strict"
import fs from "node:fs"
import os from "node:os"
import path from "node:path"
import { spawn } from "node:child_process"
import test from "node:test"
import vm from "node:vm"

const enabled = process.env.GC_PREVIEW_LAUNCHER_CONTAINER_TEST === "1" && process.getuid?.() === 0
const command = "/opt/geocluster-runtime/lib/preview-launcher/build/preview-launcher"
const worker = "/opt/geocluster-runtime/lib/file-segments-worker.js"
const pause = (ms) => new Promise((resolve) => setTimeout(resolve, ms))
const alive = (pid) => { try { const raw = fs.readFileSync(`/proc/${pid}/stat`, "utf8"); return raw.slice(raw.lastIndexOf(")") + 2).split(" ")[0] !== "Z" } catch { return false } }

function launch({ uid = 998, args = [process.execPath, "--max-old-space-size=128", worker], env = {}, stdio = ["pipe", "pipe", "pipe"] } = {}) {
	const child = spawn(command, args, { uid, gid: uid === 997 ? 997 : 999, env, stdio })
	child.stdin?.on("error", () => {}) // Early caller/descriptor rejection closes the input pipe.
	let output = "", errors = "", timer
	const done = new Promise((resolve, reject) => {
		child.stdout?.on("data", (chunk) => { output += chunk; if (output.length > 5 * 1024 * 1024) child.kill("SIGKILL") })
		child.stderr?.on("data", (chunk) => errors += chunk)
		child.on("error", reject)
		child.on("close", (code, signal) => { clearTimeout(timer); resolve({ code, signal, output, errors, messages: output.trim() ? output.trim().split("\n").map((line) => JSON.parse(line)) : [] }) })
		timer = setTimeout(() => { child.kill("SIGKILL"); reject(new Error(`launcher timeout: ${errors}`)) }, 4000)
	})
	done.catch(() => {})
	const ready = new Promise((resolve, reject) => {
		let line = ""
		child.stdout?.on("data", (chunk) => { line += chunk; if (line.includes("\n")) { try { resolve(JSON.parse(line.split("\n")[0])) } catch (error) { reject(error) } } })
		child.on("error", reject)
		child.on("close", () => reject(new Error(`no worker handshake: ${errors}`)))
	})
	ready.catch(() => {})
	return { child, done, ready, send(header, bytes = Buffer.alloc(0)) { child.stdin.end(Buffer.concat([Buffer.from(JSON.stringify({ ...header, byteLength: bytes.length }) + "\n"), bytes])) } }
}

function parserPid(monitor) {
	const children = fs.readFileSync(`/proc/${monitor}/task/${monitor}/children`, "utf8").trim().split(/\s+/).filter(Boolean).map(Number)
	return children.find((pid) => fs.readFileSync(`/proc/${pid}/comm`, "utf8").trim() === "node") || monitor
}

test("production preview launcher", { skip: !enabled && "Run inside the isolated root test container; never install or execute setuid helpers on the host." }, async (t) => {
	await t.test("caller 998 launches the fixed parser as UID/GID 997 with bounded privileges and resources", async () => {
		const run = launch()
		try {
			assert.equal((await run.ready).uid, 997)
			const pid = parserPid(run.child.pid)
			const status = fs.readFileSync(`/proc/${pid}/status`, "utf8")
			assert.match(status, /^Uid:\s+997\s+997\s+997\s+997$/m)
			assert.match(status, /^Gid:\s+997\s+997\s+997\s+997$/m)
			assert.match(status, /^Groups:\s*$/m)
			assert.match(status, /^NoNewPrivs:\s+1$/m)
			assert.match(status, /^CapEff:\s+0+$/m)
			assert.equal(fs.readlinkSync(`/proc/${pid}/cwd`), "/")
			const limits = fs.readFileSync(`/proc/${pid}/limits`, "utf8")
			assert.match(limits, /Max cpu time\s+8\s+8\s+seconds/)
			assert.match(limits, /Max data size\s+536870912\s+536870912\s+bytes/)
			assert.match(limits, /Max file size\s+8388608\s+8388608\s+bytes/)
			assert.match(limits, /Max core file size\s+0\s+0\s+bytes/)
			run.send({ probe: true })
			const result = await run.done
			assert.equal(result.code, 0, result.errors)
			assert.equal(result.messages[1].uid, 997)
		} finally { run.child.kill("SIGKILL") }
	})

	await t.test("hostile argv and NODE_OPTIONS never execute caller code", async () => {
		const dir = fs.mkdtempSync(path.join(os.tmpdir(), "preview-injection-"))
		fs.chmodSync(dir, 0o777)
		const marker = path.join(dir, "executed"), poison = path.join(dir, "poison.cjs")
		fs.writeFileSync(poison, `require('node:fs').writeFileSync(${JSON.stringify(marker)},'executed')`)
		const run = launch({ args: ["/bin/sh", "-c", `touch ${marker}`], env: { NODE_OPTIONS: `--require=${poison}`, NODE_PATH: dir, LD_PRELOAD: poison, HOME: dir, FILES_WORKER_UID: "0" } })
		try {
			assert.equal((await run.ready).uid, 997)
			const pid = parserPid(run.child.pid)
			const environment = fs.readFileSync(`/proc/${pid}/environ`, "utf8")
			assert.ok(!environment.includes("NODE_OPTIONS=") && !environment.includes("LD_PRELOAD=") && !environment.includes("HOME="))
			run.send({ probe: true })
			assert.equal((await run.done).code, 0)
			assert.equal(fs.existsSync(marker), false, "caller-controlled code executed")
		} finally { run.child.kill("SIGKILL"); fs.rmSync(dir, { recursive: true, force: true }) }
	})

	await t.test("agent 999 and parser 997 cannot invoke the privilege transition", async () => {
		for (const uid of [999, 997]) {
			const run = launch({ uid })
			run.send({ probe: true })
			const result = await run.done
			assert.notEqual(result.code, 0)
			assert.equal(result.output, "")
			assert.match(result.errors, /caller/)
		}
	})

	await t.test("root probes also execute only the unprivileged fixed parser", async () => {
		const run = launch({ uid: 0 })
		run.send({ probe: true })
		const result = await run.done
		assert.equal(result.code, 0, result.errors)
		assert.equal(result.messages[0].uid, 997)
	})

	await t.test("the 32 MiB input ceiling fits the Node data limit and still returns a bounded text window", async () => {
		const run = launch()
		try {
			await run.ready
			run.send({ format: "text", sourceEof: false, position: { offset: 0, ordinal: 1 }, limits: { readBytes: 32 * 1024 * 1024, textBytes: 64 * 1024, responseBytes: 4 * 1024 * 1024, timeMs: 2000 } }, Buffer.alloc(32 * 1024 * 1024, 97))
			const result = await run.done
			assert.equal(result.code, 0, result.errors)
			assert.equal(result.messages[1].result.excerpt.text.length, 64 * 1024)
			assert.equal(result.messages[1].result.eof, false)
			assert.ok(Buffer.byteLength(result.output) < 4 * 1024 * 1024)
		} finally { run.child.kill("SIGKILL") }
	})

	await t.test("regular-file stdin is rejected and inherited extra descriptors are closed", async () => {
		const filename = path.join(os.tmpdir(), `preview-fd-${process.pid}`)
		fs.writeFileSync(filename, '{"probe":true,"byteLength":0}\n', { mode: 0o600 })
		const fd = fs.openSync(filename, "r")
		try {
			const bad = launch({ stdio: [fd, "pipe", "pipe"] })
			const rejected = await bad.done
			assert.notEqual(rejected.code, 0)
			assert.match(rejected.errors, /IPC/)
			const run = launch({ stdio: ["pipe", "pipe", "pipe", fd] })
			try {
				await run.ready
				const pid = parserPid(run.child.pid)
				const paths = fs.readdirSync(`/proc/${pid}/fd`).map((name) => { try { return fs.readlinkSync(`/proc/${pid}/fd/${name}`) } catch { return "" } })
				assert.ok(!paths.includes(filename), "a private descriptor leaked into the parser")
				run.send({ probe: true }); assert.equal((await run.done).code, 0)
			} finally { run.child.kill("SIGKILL") }
		} finally { fs.closeSync(fd); fs.unlinkSync(filename) }
	})

	await t.test("service 998 can cancel the monitor and no parser survives, with jitter", async () => {
		const runner = `import {spawn} from 'node:child_process'; const c=spawn(${JSON.stringify(command)},[],{stdio:['pipe','pipe','pipe'],env:{}}); c.stdout.once('data',()=>{process.stdout.write(c.pid+'\\n'); process.stdin.once('data',()=>setTimeout(()=>{if(!c.kill('SIGKILL')) process.exitCode=1},Math.random()*40))}); c.once('close',()=>process.exit(process.exitCode||0));`
		for (let iteration = 0; iteration < 12; iteration++) {
			const child = spawn(process.execPath, ["--input-type=module", "-e", runner], { uid: 998, gid: 999, stdio: ["pipe", "pipe", "pipe"] })
			let output = "", error = ""
			child.stdout.on("data", (data) => output += data); child.stderr.on("data", (data) => error += data)
			const monitor = await new Promise((resolve) => child.stdout.once("data", (data) => resolve(Number(data.toString().trim()))))
			const pid = parserPid(monitor)
			child.stdin.end("cancel")
			const code = await new Promise((resolve) => child.on("close", resolve))
			assert.equal(code, 0, error)
			assert.ok(pid > 0)
			for (let tries = 0; alive(pid) && tries < 20; tries++) await pause(10)
			assert.equal(alive(pid), false, "parser outlived the cancelled monitor")
		}
	})

	await t.test("real FileSegments child bridge provides CSV and text windows to service 998", async () => {
		const runner = `import {FileSegments} from './lib/file-segments.js'; const values=new Map(); const state={get:async(k,id)=>values.get(k+id),claim:async(k,id,intent,record)=>{values.set(k+id,record);return{record}}}; const parser=new FileSegments({state,ownership:{agentUids:[999],workerUids:[997],workerBridge:{uid:997,command:${JSON.stringify(command)}}}}); await parser.init(); parser.requireAvailable(); const source={kind:'runtime-capture',captureId:'probe',etag:'exact',sizeBytes:8,ref:{workspaceId:'w',workspaceEpoch:'e',path:'a.csv'}}; const csv=await parser.parse(source,Buffer.from('a,b\\n1,2\\n'),parser.normalize({format:'csv'}),{offset:0,ordinal:1},true); const text=await parser.parse(source,Buffer.from('hello\\n'),parser.normalize({format:'text'}),{offset:0,ordinal:1},true); console.log(JSON.stringify({csv,text})); await parser.close();`
		const child = spawn(process.execPath, ["--input-type=module", "-e", runner], { uid: 998, gid: 999, stdio: ["ignore", "pipe", "pipe"] })
		let output = "", error = ""
		child.stdout.on("data", (data) => output += data); child.stderr.on("data", (data) => error += data)
		assert.equal(await new Promise((resolve) => child.on("close", resolve)), 0, error)
		const result = JSON.parse(output)
		assert.equal(result.csv.rows.length, 2)
		assert.equal(result.csv.rows[1].cells[0].text, "1")
		assert.equal(result.text.excerpt.text, "hello\n")
	})

	await t.test("daemon configuration checks trusted helper metadata and cannot be enabled by a boolean override", async () => {
		let opened
		const workspace = { drain: async () => ({ localPending: 0, remotePending: 0, failed: [], indeterminate: [], complete: true }), close: async () => {} }
		const logger = { error() {}, info() {}, child() { return this } }
		const module = new vm.SourceTextModule(fs.readFileSync("/opt/geocluster-runtime/files-server.js", "utf8"), { identifier: "file:///opt/geocluster-runtime/files-server.js" })
		await module.link(async (specifier) => {
			const exports = specifier === "./lib/workspace-files.js" ? { WorkspaceFiles: { open: async (config) => { opened = config; return workspace } } } : specifier === "./lib/files.js" ? { FilesApi: class { handle() { return false } } } : specifier === "./lib/log.js" ? { createLogger: () => logger } : await import(specifier.startsWith(".") ? new URL(specifier, module.identifier).href : specifier)
			return new vm.SyntheticModule(Object.keys(exports), function () { for (const [name, value] of Object.entries(exports)) this.setExport(name, value) })
		})
		await module.evaluate()
		const { loadFilesConfig, createFilesServer } = module.namespace
		const config = loadFilesConfig({ PROJECT_ID: "probe" })
		assert.equal(config.filesWorkerEnabled, true)
		assert.equal(config.filesWorkerBridge.uid, 997)
		assert.equal(config.filesWorkerBridge.command, command)
		const mismatched = loadFilesConfig({ PROJECT_ID: "probe", FILES_WORKER_UID: "996", FILES_WORKER_UIDS: "996", FILES_WORKER_ENABLED: "true" })
		const app = await createFilesServer({ config: { ...mismatched, filesWorkerEnabled: true, filesWorkerBridge: { uid: 0, command: "/bin/sh" } }, secret: "gate", logger })
		assert.equal(opened.filesWorkerEnabled, false)
		assert.equal(opened.filesWorkerBridge, undefined)
		await app.shutdown()
		fs.chmodSync(command, 0o755)
		try { assert.equal(loadFilesConfig({ PROJECT_ID: "probe", FILES_WORKER_ENABLED: "true" }).filesWorkerEnabled, false) }
		finally { fs.chmodSync(command, 0o4755) }
	})
})
