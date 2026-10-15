import test from "node:test"
import assert from "node:assert/strict"
import fs from "node:fs/promises"
import os from "node:os"
import path from "node:path"
import { spawn } from "node:child_process"
import { once } from "node:events"

test("build helper compiles fixed launcher and post-exec seccomp library without granting setuid", async t => {
	const dir = await fs.mkdtemp(path.join(os.tmpdir(), "workbook-build-")); t.after(() => fs.rm(dir, { recursive: true, force: true }))
	const child = spawn(process.execPath, [new URL("./build.mjs", import.meta.url).pathname, `--targetdir=${dir}`, "--node=/usr/local/bin/node", "--worker=/opt/geocluster-runtime/lib/workbook-reader-worker.cjs"], { stdio: ["ignore", "pipe", "pipe"] })
	let diagnostics = ""; child.stderr.on("data", data => { diagnostics += data }); assert.equal((await once(child, "close"))[0], 0, diagnostics)
	for (const name of ["workbook-launcher", "workbook-policy.so"]) assert.equal((await fs.stat(path.join(dir, name))).mode & 0o7777, 0o755)
	await t.test("preloaded Node reads dependencies and writes IPC while file mutation is EPERM", async () => {
		const file = path.join(dir, "readonly-input"); await fs.writeFile(file, "unchanged")
		const script = `
			const fs = require("node:fs"), assert = require("node:assert/strict"), file = process.argv[1]
			assert.equal(fs.readFileSync(file, "utf8"), "unchanged")
			assert.ok(fs.readdirSync(require("node:path").dirname(file)).includes(require("node:path").basename(file)))
			for (const flags of ["w", "a", "r+", fs.constants.O_RDONLY | fs.constants.O_CREAT, fs.constants.O_RDONLY | fs.constants.O_TRUNC])
				assert.throws(() => fs.openSync(file, flags), { code: "EPERM" })
			const fd = fs.openSync(file, "r")
			assert.throws(() => fs.ftruncateSync(fd, 0), { code: "EPERM" }); fs.closeSync(fd)
			for (const mutate of [() => fs.truncateSync(file, 0), () => fs.chmodSync(file, 0o600), () => fs.utimesSync(file, 0, 0), () => fs.unlinkSync(file), () => fs.renameSync(file, file + ".moved"), () => fs.mkdirSync(file + ".dir")])
				assert.throws(mutate, { code: "EPERM" })
			assert.equal(process.env.GC_WORKBOOK_READONLY_PROBES, "1")
			assert.equal(process.env.GC_WORKBOOK_DESCRIPTOR_PROBES, "1")
			process.stdout.write("readonly-policy-verified\\n")
		`
		const probe = spawn(process.execPath, ["--openssl-config=/dev/null", "-e", script, file], { env: { LANG: "C.UTF-8", LD_PRELOAD: path.join(dir, "workbook-policy.so") }, stdio: ["pipe", "pipe", "pipe"] })
		let output = "", errors = ""; probe.stdout.on("data", data => { output += data }); probe.stderr.on("data", data => { errors += data }); probe.stdin.end()
		assert.equal((await once(probe, "close"))[0], 0, errors)
		assert.equal(output, "readonly-policy-verified\n")
		assert.equal(await fs.readFile(file, "utf8"), "unchanged")
	})
})

const launcherPath = process.env.WORKBOOK_INSTALLED_LAUNCHER
test("installed launcher verifies fixed jail deny probes and real XLS/XLSX readiness", { skip: !launcherPath || process.env.WORKBOOK_EXPECT_UNAVAILABLE === "true" }, async t => {
	const { WorkbookReader } = await import("../workbook-reader.js")
	const reader = new WorkbookReader({ launcherPath }); t.after(() => reader.close())
	await reader.init(); assert.equal(reader.availability.state, "available", JSON.stringify(reader.availability))
	assert.equal(reader.availability.confinement, "verified")
	assert.deepEqual(reader.availability.probe, { filesystemDenied: true, socketDenied: true, executionDenied: true, signalDenied: true, decoded: ["xls", "xlsx"] })
})

test("installed launcher fails closed when chroot is unavailable", { skip: !launcherPath || process.env.WORKBOOK_EXPECT_UNAVAILABLE !== "true" }, async t => {
	const { WorkbookReader } = await import("../workbook-reader.js")
	const reader = new WorkbookReader({ launcherPath }); t.after(() => reader.close())
	await reader.init(); assert.equal(reader.availability.state, "unavailable")
	assert.match(reader.availability.diagnostic, /stage=chroot-installation result=-1 errno=38(?:\s|;|$)/)
})
