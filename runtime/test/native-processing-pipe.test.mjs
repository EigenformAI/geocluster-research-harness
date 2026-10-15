import assert from "node:assert/strict"
import fs from "node:fs/promises"
import path from "node:path"
import { spawn } from "node:child_process"
import { test } from "node:test"
import { NativeProcessingOwner } from "../lib/native-processing-owner.js"

test("processing owner uses a finite private handoff, consumes readiness, and sends the absolute drain deadline", async (t) => {
	const dir = await fs.mkdtemp("/tmp/opencode/native-owner-pipe-")
	t.after(() => fs.rm(dir, { recursive: true, force: true }))
	const log = await fs.open(path.join(dir, "private.log"), "a", 0o600)
	t.after(() => log.close())
	let child
	const owner = new NativeProcessingOwner({ settings: { model: "extract/vision", stateDir: dir, engineDescriptor: { password: "borrowed-secret" } }, workspace: dir,
		engineEnv: { OPENAI_API_KEY: "engine-only-secret" }, drainTimeoutMs: 10000, logFd: log.fd,
		spawnImpl(binary, args, options) {
			assert.equal(binary, "/opt/geocluster-preprocessing/bin/python")
			assert.ok(!JSON.stringify(args).includes("secret"))
			assert.deepEqual(Object.keys(options.env).sort(), ["LANG", "PATH"])
			child = spawn(process.execPath, ["--input-type=module", "-e", `
				import fs from 'node:fs';
				const launch=JSON.parse(fs.readFileSync(3,'utf8'));
				if(launch.engineEnv.OPENAI_API_KEY!=='engine-only-secret'||launch.engineDescriptor.password!=='borrowed-secret')process.exit(12);
				process.stdout.write(JSON.stringify({url:'http://127.0.0.1:4321',password:'local-private-password'})+'\\n');
				let control=''; process.stdin.on('data',data=>control+=data); process.stdin.on('end',()=>{
					const {deadlineMs}=JSON.parse(control);
					fs.writeFileSync(${JSON.stringify(path.join(dir, "control.json"))},JSON.stringify({deadlineMs}),{mode:0o600});
					fs.writeFileSync(${JSON.stringify(path.join(dir, "drain.json"))},JSON.stringify({complete:true}),{mode:0o600});
				});
			`], options)
			return child
		},
	})
	t.after(() => child?.kill("SIGKILL"))
	assert.deepEqual(await owner.start(), { url: "http://127.0.0.1:4321", password: "local-private-password" })
	const deadlineMs = Date.now() + 5000
	await owner.stop({ deadlineMs })
	assert.deepEqual(JSON.parse(await fs.readFile(path.join(dir, "control.json"))), { deadlineMs })
	assert.equal(await fs.readFile(path.join(dir, "private.log"), "utf8"), "")
	assert.deepEqual(await owner.exited, { code: 0, signal: null })
})

test("invalid owner readiness is rejected without exposing secret-bearing output", async (t) => {
	const dir = await fs.mkdtemp("/tmp/opencode/native-owner-invalid-")
	t.after(() => fs.rm(dir, { recursive: true, force: true }))
	let child
	const owner = new NativeProcessingOwner({ settings: { model: "extract/vision", stateDir: dir }, workspace: dir,
		engineEnv: {}, drainTimeoutMs: 10000, logFd: "ignore",
		spawnImpl(binary, args, options) {
			child = spawn(process.execPath, ["-e", "require('fs').readFileSync(3); console.log('{bad-secret-readiness');"], options)
			return child
		},
	})
	t.after(() => child?.kill("SIGKILL"))
	await assert.rejects(owner.start(), (error) => /owner unavailable/.test(error.message) && !/bad-secret/.test(error.message))
})

test("a missing completion receipt reports incomplete drain and tells the operator to retain state", async (t) => {
	const dir = await fs.mkdtemp("/tmp/opencode/native-owner-no-receipt-")
	t.after(() => fs.rm(dir, { recursive: true, force: true }))
	let child
	const owner = new NativeProcessingOwner({ settings: { model: "extract/vision", stateDir: dir }, workspace: dir,
		engineEnv: {}, drainTimeoutMs: 10000, logFd: "ignore",
		spawnImpl(binary, args, options) {
			child = spawn(process.execPath, ["-e", "require('fs').readFileSync(3); console.log(JSON.stringify({url:'http://127.0.0.1:4321',password:'private'})); process.stdin.resume();"], options)
			return child
		},
	})
	t.after(() => child?.kill("SIGKILL"))
	await owner.start()
	await assert.rejects(owner.stop({ deadlineMs: Date.now() + 5000 }), /drain is incomplete; retain processing state/)
})
