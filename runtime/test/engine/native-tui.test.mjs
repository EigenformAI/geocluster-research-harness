/** Opt-in full-image gate for entrypoint-owned native --standalone (not managed serve/--server). */
import assert from "node:assert/strict"
import crypto from "node:crypto"
import fs from "node:fs"
import path from "node:path"
import { fileURLToPath } from "node:url"
import { spawnSync } from "node:child_process"
import { test } from "node:test"

const here = path.dirname(fileURLToPath(import.meta.url))
const recipe = JSON.parse(fs.readFileSync(path.resolve(here, "../../../opencode/engine/source-build.json")))
const image = process.env.NATIVE_TUI_IMAGE
function docker(args, timeout = 20000) {
	const result = spawnSync("docker", args, { encoding: "utf8", timeout, maxBuffer: 8 * 1024 * 1024 })
	assert.equal(result.status, 0, `${args.slice(0, 3).join(" ")}: ${result.error ?? ""}\n${result.stdout}\n${result.stderr}`)
	return (args[0] === "logs" ? result.stdout + result.stderr : result.stdout).trim()
}

test("native image starts real standalone TUI without managed authority; retains connections and cleans owned services", {
	skip: !image && "Set NATIVE_TUI_IMAGE to the newly built native-profile image", timeout: 300000,
}, async (t) => {
	const name = `native-profile-${crypto.randomBytes(6).toString("hex")}`
	const volume = `${name}-workspace`
	t.after(() => {
		spawnSync("docker", ["rm", "-f", name], { timeout: 20000 })
		spawnSync("docker", ["volume", "rm", volume], { timeout: 20000 })
	})
	docker(["volume", "create", volume])
	for (const [profile, message] of [["native", /native TUI requires a terminal/], ["managed", /profile\/frontend conflict/]]) {
		const invalid = spawnSync("docker", ["run", "--rm", "--entrypoint", "/entrypoint.sh", "-e", `RUNTIME_PROFILE=${profile}`, image, "tui"], { encoding: "utf8", timeout: 20000 })
		assert.equal(invalid.status, 2, invalid.stderr)
		assert.match(invalid.stderr, message)
	}
	// No -p, host home, provider environment, managed proxy, or purpose credentials.
	// The adapter supplies a real controlling PTY to the actual root entrypoint.
	for (const replacement of [false, true]) {
		docker(["run", "-d", "--name", name, "--no-healthcheck", "--network", "none",
			"--mount", `type=volume,source=${volume},target=/workspace`,
			"--mount", `type=bind,source=${here},target=/fixtures,readonly`,
			"-e", "NATIVE_TUI_QUALIFICATION=1", "-e", `NATIVE_TUI_REUSE_STATE=${replacement ? "1" : "0"}`,
			"--entrypoint", "node", image, "/fixtures/native-tui-qualification.mjs"])
		const identity = JSON.parse(docker(["exec", name, "cat", "/opt/opencode/engine/build-identity.json"]))
		for (const [key, value] of Object.entries(recipe)) assert.deepEqual(identity[key], value, key)
		assert.equal(identity.binarySha256, "9b3fb5f7f27cb167b739493865705f7f197637c4f605e05042e7bd97ab4c0f5a")
		assert.deepEqual(JSON.parse(docker(["inspect", name, "--format", "{{json .HostConfig.PortBindings}}"])), {})
		const wait = docker(["wait", name], 130000)
		const output = docker(["logs", name])
		t.diagnostic(`${replacement ? "replacement container" : "fresh container"}: ${output}`)
		assert.equal(wait, "0", output)
		assert.match(output, /NATIVE_PROFILE_PASSED/)
		docker(["rm", name]) // Keep only the retained workspace, not the first root filesystem.
	}
})
