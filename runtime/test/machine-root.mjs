/** Run inside a disposable container as root; no host privilege changes. */
import assert from "node:assert/strict"
import { spawn } from "node:child_process"
import fs from "node:fs/promises"
import http from "node:http"
import { loadConfig } from "../lib/config.js"
import { bootstrapMachineCredentials, createMachineGateway } from "../machine-gateway.js"

assert.equal(process.getuid(), 0, "Run this fixture inside the root test container")
const dir = "/run/runtime"
await fs.mkdir(dir, { recursive: true, mode: 0o700 }); await fs.chmod(dir, 0o700)
const tokenFile = `${dir}/machine-token`, credentialFile = `${dir}/machine-credentials.json`
await fs.writeFile(tokenFile, "container-machine-token", { mode: 0o600 })
const receiver = http.createServer((req, res) => {
	assert.equal(req.method, "POST")
	assert.equal(req.headers.authorization, "Bearer container-machine-token")
	req.resume()
	res.setHeader("content-type", "application/json")
	res.end(JSON.stringify({ llmToken: "llm", activityToken: "activity", datasetToken: "dataset", expiresAt: new Date(Date.now() + 60000).toISOString() }))
})
await new Promise((resolve) => receiver.listen(0, "127.0.0.1", resolve))
const config = loadConfig({ IDE_MACHINE_TOKEN_FILE: tokenFile, IDE_MACHINE_CREDENTIALS_FILE: credentialFile, IDE_MACHINE_CREDENTIALS_URL: `http://127.0.0.1:${receiver.address().port}/renew` })
const logger = { info() {}, warn() {} }
try {
	await bootstrapMachineCredentials(config, logger)
	for (const file of [tokenFile, credentialFile]) {
		const stat = await fs.stat(file)
		assert.equal(stat.uid, 0); assert.equal(stat.mode & 0o777, 0o600)
	}
	const machine = await createMachineGateway({ config, logger, initialCredentials: JSON.parse(await fs.readFile(credentialFile, "utf8")) })
	await new Promise((resolve) => machine.server.listen(0, "127.0.0.1", resolve))
	try {
		const childScript = `const fs=require('node:fs'); for(const file of ${JSON.stringify([tokenFile, credentialFile])}) { try { fs.readFileSync(file); throw new Error('private file readable'); } catch(e) { if(e.code!=='EACCES') throw e; } } for(const key of ['IDE_MACHINE_TOKEN','IDE_MACHINE_TOKEN_FILE','IDE_MACHINE_CREDENTIALS_URL','IDE_MACHINE_CREDENTIALS_FILE']) { if(key in process.env) throw new Error('renewal material in child env'); } console.log('PASS: UID 999 cannot read root credential files; renewal env absent');`
		const child = spawn(process.execPath, ["-e", childScript], { uid: 999, gid: 999, env: config.agentEnv, stdio: ["ignore", "inherit", "inherit"] })
		const code = await new Promise((resolve, reject) => { child.on("error", reject); child.on("exit", resolve) })
		assert.equal(code, 0)
		console.log("PASS: root gateway reads root:root 0600 machine credentials")
	} finally { await machine.close() }
} finally {
	receiver.closeAllConnections(); await new Promise((resolve) => receiver.close(resolve))
	await fs.rm(tokenFile, { force: true }); await fs.rm(credentialFile, { force: true })
}
