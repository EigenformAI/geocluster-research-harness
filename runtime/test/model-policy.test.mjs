import assert from "node:assert/strict"
import { execFile } from "node:child_process"
import { promisify } from "node:util"
import { test } from "node:test"
import fs from "node:fs/promises"
import http from "node:http"
import os from "node:os"
import path from "node:path"
import { loadConfig } from "../lib/config.js"
import { createMachineGateway } from "../machine-gateway.js"

const exec = promisify(execFile)
const privileged = (args) => process.getuid() === 0 ? exec(args[0], args.slice(1), { timeout: 14000 }) : exec("sudo", ["-n", "--", ...args], { timeout: 14000 })

test("root model discovery: authenticated bounded network, atomic privacy, freshness and cancellation", { timeout: 15000 }, async () => {
	const { stdout } = await privileged(["python3", "-B", new URL("./model-policy-fixture.py", import.meta.url).pathname])
	assert.match(stdout, /model policy behavior verified/)
	assert.match(stdout, /image detail original retained; auto rejected without replacing or renewing snapshot/)
})

test("Python discovery uses the production machine gateway's current renewed authority", { timeout: 15000 }, async (t) => {
	const root = await fs.mkdtemp(path.join(os.tmpdir(), "model-policy-gateway-"))
	t.after(() => fs.rm(root, { recursive: true, force: true }))
	const tokenFile = path.join(root, "machine-token")
	await fs.writeFile(tokenFile, "fixture-machine-secret", { mode: 0o600 })
	const calls = [], logs = []
	let generation = 0, unavailable = false
	const server = http.createServer((req, res) => {
		res.setHeader("content-type", "application/json")
		if (req.url === "/renew") {
			generation++
			res.end(JSON.stringify({ llmToken: `renewed-llm-${generation}`, activityToken: "activity-secret", datasetToken: "dataset-secret", expiresAt: new Date(Date.now() + 3600000).toISOString() }))
			return
		}
		calls.push({ path: req.url, auth: req.headers.authorization })
		if (unavailable) { res.writeHead(503); res.end('{"credential":"must-not-log"}'); return }
		res.end(JSON.stringify({ discovery_schema_version: 2, managed_access_enabled: true, allowed_model_ids: [], default_model_id: null, managed_models: {}, model_limits: {}, model_capabilities: {}, as_of: "2026-10-14T00:00:00Z", credential: "must-not-project" }))
	})
	await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve))
	t.after(async () => { server.closeAllConnections(); await new Promise((resolve) => server.close(resolve)) })
	const backend = `http://127.0.0.1:${server.address().port}`
	const config = loadConfig({ IDE_MACHINE_TOKEN_FILE: tokenFile, IDE_MACHINE_CREDENTIALS_URL: `${backend}/renew`, LLM_PROXY_URL: `${backend}/api/v1/llm-proxy`, PREPROCESSING_PROXY_TOKEN: "fixture-private-channel" })
	const gateway = await createMachineGateway({ config, logger: { info: (...args) => logs.push(args), warn: (...args) => logs.push(args) } })
	await new Promise((resolve) => gateway.server.listen(0, "127.0.0.1", resolve))
	t.after(() => gateway.close())
	const url = `http://127.0.0.1:${gateway.server.address().port}/llm`
	const program = `
import asyncio, importlib.util, json, pathlib, sys, tempfile
s=importlib.util.spec_from_file_location('policy',sys.argv[1]); m=importlib.util.module_from_spec(s); s.loader.exec_module(m)
async def run():
    with tempfile.TemporaryDirectory() as directory:
        p=pathlib.Path(directory)/'model-policy.json'
        adapter=m.ModelPolicy(sys.argv[2], 'fixture-private-channel', p)
        success=await adapter.refresh()
        print(json.dumps({'success':success,'snapshot':json.loads(p.read_text()) if p.exists() else None}))
asyncio.run(run())
`
	const refresh = async () => {
		const result = await privileged(["python3", "-B", "-c", program, new URL("../preprocessing-model-policy.py", import.meta.url).pathname, url])
		assert.ok(!result.stdout.includes("secret") && !result.stdout.includes("credential") && !result.stderr.includes("must-not-log"))
		return JSON.parse(result.stdout)
	}
	assert.equal((await refresh()).success, true)
	await gateway.credentials.refresh()
	assert.equal((await refresh()).success, true)
	unavailable = true
	assert.deepEqual(await refresh(), { success: false, snapshot: null })
	assert.deepEqual(calls, [1, 2, 2].map((generation) => ({ path: "/api/v1/llm-proxy/account", auth: `Bearer renewed-llm-${generation}` })))
	assert.equal(config.preprocessingProxyToken, "fixture-private-channel")
	assert.ok(!JSON.stringify(logs).includes("fixture-private-channel") && !JSON.stringify(logs).includes("renewed-llm"))
})
