import assert from "node:assert/strict"
import { execFile, spawnSync } from "node:child_process"
import { promisify } from "node:util"
import { test } from "node:test"

const exec = promisify(execFile)
const fixture = (name) => new URL(`./setup-workspace-${name}.py`, import.meta.url).pathname

test("setup transfer host contract and hostile archive rejection", { timeout: 30000 }, async () => {
	const { stderr } = await exec("python3", ["-B", fixture("transfer")], { timeout: 25000 })
	assert.match(stderr, /\nOK\n/)
})

test("root setup, lifecycle fencing, publication and restart recovery", { timeout: 120000 }, async (t) => {
	const root = process.getuid?.() === 0
	if (!root && spawnSync("sudo", ["-n", "true"]).status !== 0) {
		t.skip("root fixture requires sudo -n or a root container")
		return
	}
	const { stderr } = await exec(root ? "python3" : "sudo", root ? ["-B", fixture("runtime")] : ["-n", "python3", "-B", fixture("runtime")], { timeout: 110000 })
	assert.match(stderr, /\nOK\n/)
})
