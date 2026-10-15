/** Opt-in exact-image native processing gate; no host network or provider accounts. */
import assert from "node:assert/strict"
import crypto from "node:crypto"
import fs from "node:fs"
import path from "node:path"
import { fileURLToPath } from "node:url"
import { spawnSync } from "node:child_process"
import { test } from "node:test"

const here = path.dirname(fileURLToPath(import.meta.url))
const recipe = JSON.parse(fs.readFileSync(path.resolve(here, "../../../opencode/engine/source-build.json")))
const image = process.env.NATIVE_PROCESSING_IMAGE
function docker(args, timeout = 20000) {
	const result = spawnSync("docker", args, { encoding: "utf8", timeout, maxBuffer: 4 * 1024 * 1024 })
	assert.equal(result.status, 0, `${args.slice(0, 3).join(" ")}: ${result.error ?? ""}\n${result.stdout}\n${result.stderr}`)
	return (args[0] === "logs" ? result.stdout + result.stderr : result.stdout).trim()
}

async function qualify(t, ownerLoss = false) {
	const name = `native-processing-${crypto.randomBytes(6).toString("hex")}`
	const volume = `${name}-workspace`
	t.after(() => {
		spawnSync("docker", ["rm", "-f", name], { timeout: 20000 })
		spawnSync("docker", ["volume", "rm", volume], { timeout: 20000 })
	})
	docker(["volume", "create", volume])
	for (const replacement of [false, true]) {
		docker(["run", "-d", "--name", name, "--no-healthcheck", "--network", "none",
			"--mount", `type=volume,source=${volume},target=/workspace`,
			"--mount", `type=bind,source=${here},target=/fixtures,readonly`,
			"-e", "NATIVE_PROCESSING_QUALIFICATION=1", "-e", `NATIVE_PROCESSING_REPLACEMENT=${replacement ? "1" : "0"}`,
			"-e", `NATIVE_PROCESSING_OWNER_LOSS=${ownerLoss ? "1" : "0"}`,
			"--entrypoint", "node", image, "/fixtures/native-processing-tui-qualification.mjs"])
		const identity = JSON.parse(docker(["exec", name, "cat", "/opt/opencode/engine/build-identity.json"]))
		for (const [key, value] of Object.entries(recipe)) assert.deepEqual(identity[key], value, key)
		assert.equal(identity.binarySha256, "9b3fb5f7f27cb167b739493865705f7f197637c4f605e05042e7bd97ab4c0f5a")
		assert.deepEqual(JSON.parse(docker(["inspect", name, "--format", "{{json .HostConfig.PortBindings}}"])), {})
		assert.equal(docker(["inspect", name, "--format", "{{.HostConfig.NetworkMode}}"]), "none")
		const wait = docker(["wait", name], 140000)
		const output = docker(["logs", name])
		t.diagnostic(`${replacement ? "replacement container" : "fresh container"}: ${output}`)
		assert.equal(wait, "0", output)
		assert.match(output, /NATIVE_PROCESSING_PASSED/)
		assert.match(output, /scheduled synthetic PDF terminal=/)
		if (replacement) assert.match(output, /normal conversation unchanged and no inference replay/)
		else assert.match(output, /accepted in-flight PDF cancellation settles locally/)
		if (ownerLoss) assert.match(output, replacement ? /active extraction owner loss recovers as interrupted with no replay/ : /SIGKILL during real extraction ends the TUI nonzero/)
		docker(["rm", name]) // Retain only /workspace; second container gets a new root filesystem.
	}
}

const options = { skip: !image && "Set NATIVE_PROCESSING_IMAGE to a processing-enabled exact runtime image", timeout: 300000 }
test("native exact image: independently saved chat/extraction accounts, scheduled PDF MCP publication, cancellation, drain and retained container replacement", options, (t) => qualify(t))
test("native exact image: owner loss during extraction retains work and replacement settles without inference replay", options, (t) => qualify(t, true))
