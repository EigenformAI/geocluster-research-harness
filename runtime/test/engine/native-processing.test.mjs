/** Opt-in exact-image native processing gate; no host network or provider accounts. */
import assert from "node:assert/strict"
import crypto from "node:crypto"
import fs from "node:fs"
import path from "node:path"
import { fileURLToPath } from "node:url"
import { spawnSync } from "node:child_process"
import { test } from "node:test"
import { plan } from "./fake-llm.mjs"
import { assertProcessingSurface, assertDefaultObservation, processingDirective, conversationSettled } from "./native-processing-tui-qualification.mjs"
import { CLIENT_TIMEOUT_MS, WAIT_DEFAULT_MS, PROCESSING_TOOLS, READ_TOOLS, toolSpecs, validArguments } from "../../../opencode/config/lib/processing-contract.js"

const here = path.dirname(fileURLToPath(import.meta.url))
const recipe = JSON.parse(fs.readFileSync(path.resolve(here, "../../../opencode/engine/source-build.json")))
const image = process.env.NATIVE_PROCESSING_IMAGE

test("native qualification drives plugin tools without coaching model-generated identity", () => {
	const input = { source: { kind: "workspace-file", path: "scan.pdf" } }
	let prompt = processingDirective("dataops", "processing_submit", input)
	assert.doesNotMatch(prompt, /submissionKey|requestId|messageId|callId|UUID/)
	for (const agent of ["orchestrator", "dataops"]) {
		const call = plan({ messages: [{ role: "user", content: prompt }] })
		assert.equal(call.tool, "subagent"); assert.equal(call.input.agent, agent)
		prompt = call.input.prompt
	}
	const call = plan({ messages: [{ role: "user", content: prompt }] })
	assert.equal(call.tool, "processing_submit"); assert.deepEqual(call.input, input)
	assert.equal(validArguments("submit", call.input, "native"), true)
	assert.equal(validArguments("submit", { ...input, submissionKey: "model-chosen" }, "native"), false)
	assert.equal(validArguments("submit", { requestId: "retained", ...input }, "native"), false)
})

test("native qualification rejects leaked legacy tools and execution access in reader/delegator roles", () => {
	for (const agent of ["dataops", "standard"]) assertProcessingSurface({ agent, tools: PROCESSING_TOOLS })
	assertProcessingSurface({ agent: "report-analysis", tools: READ_TOOLS })
	for (const agent of ["geology", "orchestrator"]) assertProcessingSurface({ agent, tools: ["read", "subagent"] })
	assert.throws(() => assertProcessingSurface({ agent: "geology", tools: ["processing_submit"] }))
	assert.throws(() => assertProcessingSurface({ agent: "report-analysis", tools: PROCESSING_TOOLS }))
	assert.throws(() => assertProcessingSurface({ agent: "dataops", tools: [...PROCESSING_TOOLS, "processor_documents_submit"] }))
})

test("native qualification requires the full default observation within the 25-second transport budget", () => {
	assert.equal(CLIENT_TIMEOUT_MS, 25000); assert.equal(WAIT_DEFAULT_MS, 20000)
	assert.equal(toolSpecs("native").processing_wait.input.properties.timeoutMs.default, WAIT_DEFAULT_MS)
	const value = { requestId: "retained", state: "running", timedOut: true, resultAvailable: false, continuation: "Continue observing with processing_wait" }
	assertDefaultObservation(value, 20100)
	assert.throws(() => assertDefaultObservation(value, 10000), /20-second/)
	assert.throws(() => assertDefaultObservation(value, 25001), /25-second/)
	assert.throws(() => assertDefaultObservation({ ...value, state: "failed" }, 20100))
	assert.throws(() => assertDefaultObservation({ ...value, timedOut: false }, 20100))
})

test("native conversation settlement excludes independent extraction but waits for root and nested delegation", async () => {
	const sessions = { root: { id: "root" }, child: { id: "child", parentID: "root" }, nested: { id: "nested", parentID: "child" }, extraction: { id: "extraction" } }
	let active = { extraction: {} }
	const api = async (route) => ({ data: route === "/api/session/active" ? active : sessions[route.slice("/api/session/".length)] })
	assert.equal(await conversationSettled(api, "root"), true, "independent extraction may remain intentionally active")
	for (const id of ["root", "child", "nested"]) {
		active = { extraction: {}, [id]: {} }
		assert.equal(await conversationSettled(api, "root"), false, `active ${id} must prevent premature handback`)
	}
	active = { unknown: {} }
	await assert.rejects(conversationSettled(api, "root"), /ancestry unavailable/, "unverifiable active ancestry must not count as settled")
	active = { extraction: {} }
	assert.equal(await conversationSettled(api, "root"), true)
})
function docker(args, timeout = 20000) {
	const result = spawnSync("docker", args, { encoding: "utf8", timeout, maxBuffer: 4 * 1024 * 1024 })
	assert.equal(result.status, 0, `${args.slice(0, 3).join(" ")}: ${result.error ?? ""}\n${result.stdout}\n${result.stderr}`)
	return (args[0] === "logs" ? result.stdout + result.stderr : result.stdout).trim()
}

async function qualify(t, ownerLoss = false) {
	const name = `native-processing-${crypto.randomBytes(6).toString("hex")}`
	const volume = `${name}-workspace`
	let complete = false, currentStage = "setup"
	t.after(() => {
		if (!complete) {
			const archive = fs.mkdtempSync("/tmp/opencode/native-processing-qualification-")
			fs.chmodSync(archive, 0o700)
			const logs = spawnSync("docker", ["logs", name], { encoding: "utf8", timeout: 20000, maxBuffer: 16 * 1024 * 1024 })
			fs.writeFileSync(path.join(archive, "container.log"), `${logs.stdout || ""}${logs.stderr || ""}`, { mode: 0o600 })
			const copied = spawnSync("docker", ["cp", `${name}:/workspace/.runtime/native/opencode/logs`, path.join(archive, "runtime-logs")], { encoding: "utf8", timeout: 20000 })
			fs.writeFileSync(path.join(archive, "capture.json"), JSON.stringify({ image, name, stage: currentStage, dockerLogsStatus: logs.status, runtimeLogsCopyStatus: copied.status }), { mode: 0o600 })
			t.diagnostic(`Private failure logs retained before cleanup: ${archive}`)
		}
		spawnSync("docker", ["rm", "-f", name], { timeout: 20000 })
		spawnSync("docker", ["volume", "rm", volume], { timeout: 20000 })
	})
	docker(["volume", "create", volume])
	for (const stage of ["fresh", "replacement", "store-replacement"]) {
		currentStage = stage
		const replacement = stage !== "fresh", storeReplacement = stage === "store-replacement"
		docker(["run", "-d", "--name", name, "--no-healthcheck", "--network", "none",
			"--mount", `type=volume,source=${volume},target=/workspace`,
			"--mount", `type=bind,source=${here},target=/fixtures,readonly`,
			"-e", "NATIVE_PROCESSING_QUALIFICATION=1", "-e", `NATIVE_PROCESSING_REPLACEMENT=${replacement ? "1" : "0"}`,
			"-e", `NATIVE_PROCESSING_OWNER_LOSS=${ownerLoss ? "1" : "0"}`,
			"-e", `NATIVE_PROCESSING_STORE_REPLACEMENT=${storeReplacement ? "1" : "0"}`,
			"--entrypoint", "node", image, "/fixtures/native-processing-tui-qualification.mjs"])
		const identity = JSON.parse(docker(["exec", name, "cat", "/opt/opencode/engine/build-identity.json"]))
		for (const [key, value] of Object.entries(recipe)) assert.deepEqual(identity[key], value, key)
		const installedSha256 = docker(["exec", name, "sha256sum", "/usr/local/bin/opencode"]).split(/\s+/)[0]
		assert.match(installedSha256, /^[0-9a-f]{64}$/)
		assert.equal(installedSha256, identity.binarySha256, "installed engine bytes must match the build identity for the pinned source/patch recipe")
		assert.equal(installedSha256, "3f7abdc7ba07cc96a2f3fd21166d62d44a58f66b87269ef6dca9ae5ef2ed3f68", "qualify the explicitly approved candidate engine artifact")
		assert.deepEqual(JSON.parse(docker(["inspect", name, "--format", "{{json .HostConfig.PortBindings}}"])), {})
		assert.equal(docker(["inspect", name, "--format", "{{.HostConfig.NetworkMode}}"]), "none")
		const wait = docker(["wait", name], 240000)
		const output = docker(["logs", name])
		t.diagnostic(`${stage} container: ${output}`)
		assert.equal(wait, "0", output)
		assert.match(output, /NATIVE_PROCESSING_PASSED/)
		if (storeReplacement) assert.match(output, /processor-store replacement rejects the original receipt without replay/)
		else {
			assert.match(output, /scheduled synthetic PDF terminal=/)
			assert.match(output, /Geology\/Orchestrator cannot execute, Report Analysis reads retained content only/)
			assert.match(output, /CLI export preserves sealed product byte count\/SHA-256 and job quality/)
			if (replacement) assert.match(output, /normal conversation unchanged and no inference replay; same store, new invocation/)
			else {
				assert.match(output, /lost supplier handback after accepted plugin submission recovers/)
				assert.match(output, /actual tool budget supports default 20-second observation within 25-second client deadline/)
				assert.match(output, /accepted in-flight PDF cancellation settles locally/)
			}
			if (ownerLoss) assert.match(output, replacement ? /active extraction owner loss recovers as interrupted with no replay/ : /SIGKILL during real extraction ends the TUI nonzero/)
		}
		docker(["rm", name]) // Retain only /workspace; second container gets a new root filesystem.
	}
	complete = true
}

const options = { skip: !image && "Set NATIVE_PROCESSING_IMAGE to a processing-enabled exact runtime image", timeout: 750000 }
test("native exact image: plugin role boundaries, trusted request identity, 20-second wait, CLI bytes, cancellation and scoped replacement", options, (t) => qualify(t))
test("native exact image: owner loss during extraction retains work and replacement settles without inference replay", options, (t) => qualify(t, true))
