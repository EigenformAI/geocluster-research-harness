import assert from "node:assert/strict"
import fs from "node:fs/promises"
import path from "node:path"
import { spawnSync } from "node:child_process"
import { test } from "node:test"

test("managed bootstrap creates the processor's private relay channel without a static upstream token", async (t) => {
	const root = await fs.mkdtemp("/tmp/opencode/processor-channel-")
	t.after(() => fs.rm(root, { recursive: true, force: true }))
	const entrypoint = (await fs.readFile(new URL("../../entrypoint.sh", import.meta.url), "utf8")).replace(/launch_runtime "\$@"\s*$/, "")
	await fs.writeFile(path.join(root, "machine-gateway.js"), `
const fs=require('node:fs');
fs.writeFileSync(process.env.IDE_MACHINE_CREDENTIALS_FILE,JSON.stringify({datasetToken:'dataset-fixture',preprocessingProxyToken:process.env.PREPROCESSING_PROXY_TOKEN}),{mode:0o600});
`)
	const result = spawnSync("bash", ["-c", `${entrypoint}
RUN_DIR=${JSON.stringify(root)}
RUNTIME_CODE_DIR=${JSON.stringify(root)}
jq() { echo dataset-fixture; }
configure_machine_credentials
`], { env: { PATH: process.env.PATH, IDE_MACHINE_TOKEN: "renewal-fixture", IDE_MACHINE_CREDENTIALS_URL: "http://backend.invalid/renew", PREPROCESSING_MODEL: "proxy/new-maker/model", LLM_PROXY_URL: "http://backend.invalid/v1" }, encoding: "utf8", timeout: 5000 })
	assert.equal(result.status, 0, result.stdout + result.stderr)
	const boot = JSON.parse(await fs.readFile(path.join(root, "machine-credentials.json")))
	assert.match(boot.preprocessingProxyToken ?? "", /^[a-f0-9]{64}$/)
	assert.doesNotMatch(result.stdout + result.stderr, new RegExp(boot.preprocessingProxyToken))
})
