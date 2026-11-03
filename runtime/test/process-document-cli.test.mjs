import assert from "node:assert/strict"
import { test } from "node:test"
import fs from "node:fs/promises"
import os from "node:os"
import path from "node:path"
import { spawnSync } from "node:child_process"
import { fileURLToPath } from "node:url"
import { documentExitCode, parseDocumentArguments, runDocumentCLI } from "../process-document.mjs"

test("CLI exit outcomes distinguish admission, pending, partial extraction and verified partial export", () => {
	assert.equal(documentExitCode("submit", { operationOutcome: "accepted", state: "running" }), 0)
	assert.equal(documentExitCode("wait", { state: "running" }), 3)
	assert.equal(documentExitCode("wait", { state: "partial" }), 2)
	assert.equal(documentExitCode("submit-wait", { state: "failed" }), 1)
	assert.equal(documentExitCode("result", { state: "partial" }), 0)
	assert.equal(documentExitCode("export", { operationOutcome: "exported", jobOutcome: "partial" }), 0)
	assert.equal(documentExitCode("cancel", { operationOutcome: "cancel_pending" }), 3)
})

test("CLI persists and prints request before dispatch; wait returns partial exit 2", async () => {
	const events = [], output = [], scope = { workspaceId: "project", workspaceEpoch: "store" }
	const client = { request: async ({ action, input }) => { events.push([action, input]); return { scope, invocationId: "owner", result: action === "submit" ? input.prepareOnly ? { requestId: "receipt", state: "prepared" } : { requestId: "receipt", state: "running", operationOutcome: "accepted" } : action === "wait" ? { requestId: "receipt", jobId: "job", state: "partial", jobOutcome: "partial", resultAvailable: true } : {} } } }
	const code = await runDocumentCLI(["submit", "scan.pdf", "--wait", "--json"], { client, progress: (value) => { events.push(["printed", JSON.parse(value)]) }, output: (value) => output.push(JSON.parse(value)) })
	assert.equal(code, 2)
	assert.deepEqual(events.map(([action]) => action), ["capabilities", "submit", "printed", "submit", "wait"])
	assert.deepEqual(events[3][1], { requestId: "receipt" })
	assert.equal(output[0].jobOutcome, "partial")
	assert.equal(typeof output[0].operationOutcome, "string")
})

test("CLI uncertain submit prints recoverable handle and does not replay", async () => {
	let submits = 0; const output = []
	const client = { request: async ({ action, input }) => ({ scope: { workspaceId: "p", workspaceEpoch: "s" }, result: action !== "submit" ? {} : (submits++, input.prepareOnly ? { requestId: "retained", state: "prepared" } : { requestId: "retained", state: "unknown", operationOutcome: "dispatch_unknown" }) }) }
	assert.equal(await runDocumentCLI(["submit", "file.pdf", "--wait"], { client, output: (value) => output.push(JSON.parse(value)), progress: () => {} }), 3)
	assert.equal(submits, 2)
	assert.equal(output[0].requestId, "retained")
})

test("CLI interruption after preparation preserves its handle without dispatch or cancellation", async () => {
	const controller = new AbortController(), actions = [], output = []
	const client = { request: async ({ action }) => { actions.push(action); return { scope: { workspaceId: "p", workspaceEpoch: "s" }, result: action === "submit" ? { requestId: "prepared", state: "prepared" } : {} } } }
	const code = await runDocumentCLI(["submit", "file.pdf", "--wait"], { client, signal: controller.signal, progress: () => controller.abort(), output: (value) => output.push(JSON.parse(value)) })
	assert.equal(code, 3)
	assert.deepEqual(actions, ["capabilities", "submit"])
	assert.equal(output[0].requestId, "prepared")
})

test("CLI parser rejects changed-intent recovery, silent overwrite and invalid option combinations", () => {
	assert.throws(() => parseDocumentArguments(["submit", "changed.pdf", "--request", "existing"]))
	assert.throws(() => parseDocumentArguments(["status", "--request", "r", "--job", "j"]))
	assert.throws(() => parseDocumentArguments(["export", "--job", "j", "--product", "p"]))
	assert.throws(() => parseDocumentArguments(["export", "--export-id", "e", "--overwrite"]))
	assert.equal(parseDocumentArguments(["export", "--job", "j", "--product", "p", "--out", "out.csv"]).values.overwrite, undefined)
})

test("CLI full manifest retrieval is explicit, independent of JSON formatting", async () => {
	const calls = [], output = []
	const client = { request: async ({ action, input }) => { calls.push({ action, input }); return { scope: { workspaceId: "p", workspaceEpoch: "s" }, result: action === "result" ? { view: "sanitized-sealed-manifest", manifest: { jobId: "job", resultId: "result" } } : {} } } }
	assert.equal(await runDocumentCLI(["result", "--job", "job", "--full-manifest", "--json"], { client, output: (value) => output.push(JSON.parse(value)) }), 0)
	assert.deepEqual(calls[1], { action: "result", input: { jobId: "job", fullManifest: true } })
	assert.equal(output[0].manifest.resultId, "result")
	assert.equal(parseDocumentArguments(["result", "--job", "job", "--json"]).values["full-manifest"], undefined)
})

test("host wrapper only inspects and execs a matching live native container; never starts an owner", async (t) => {
	const directory = await fs.mkdtemp(path.join(os.tmpdir(), "document-cli-")), calls = path.join(directory, "calls.jsonl")
	t.after(() => fs.rm(directory, { recursive: true, force: true }))
	await fs.writeFile(path.join(directory, "docker"), `#!${process.execPath}\nconst fs = require('node:fs'); const args = process.argv.slice(2); fs.appendFileSync(process.env.MOCK_CALLS, JSON.stringify(args)+'\\n'); if(args[0]==='ps') console.log('live'); else if(args[0]==='inspect') console.log(JSON.stringify([{Id:'live', State:{Running:true}, Config:{Env:['RUNTIME_PROFILE=native','PROJECT_ID=default','RUNTIME_NATIVE_PROCESSING_MODEL=provider/model']},Mounts:[{Destination:'/workspace',Type:'volume',Name:'geocluster-native-workspace'}]}])); else if(args[0]==='exec') process.exit(0); else process.exit(9);\n`, { mode: 0o755 })
	const result = spawnSync("bash", [fileURLToPath(new URL("../../scripts/process-document.sh", import.meta.url)), "status", "--request", "retained"], { encoding: "utf8", env: { ...process.env, PATH: `${directory}:${process.env.PATH}`, MOCK_CALLS: calls } })
	assert.equal(result.status, 0, result.stderr)
	const commands = (await fs.readFile(calls, "utf8")).trim().split("\n").map(JSON.parse)
	assert.deepEqual(commands.map(([command]) => command), ["ps", "inspect", "exec"])
	assert.deepEqual(commands[2].slice(-3), ["status", "--request", "retained"])
	assert.ok(commands[2].includes("/opt/geocluster-runtime/process-document.mjs"))
	assert.ok(commands[2].includes("PROJECT_ID=default"))
})

test("host wrapper rejects removed project selectors before contacting Docker", async (t) => {
	const directory = await fs.mkdtemp("/tmp/opencode/document-selector-"), calls = path.join(directory, "calls")
	t.after(() => fs.rm(directory, { recursive: true, force: true }))
	await fs.writeFile(path.join(directory, "docker"), '#!/bin/sh\nprintf called > "$MOCK_CALLS"\n', { mode: 0o755 })
	for (const args of [["--project", "named", "status"], ["--project=default", "status"], ["status", "--project", "named"]]) {
		const result = spawnSync("bash", [fileURLToPath(new URL("../../scripts/process-document.sh", import.meta.url)), ...args], { encoding: "utf8", env: { ...process.env, PATH: `${directory}:${process.env.PATH}`, MOCK_CALLS: calls } })
		assert.equal(result.status, 2, result.stderr)
		assert.match(result.stderr, /--project.*(removed|supported)|removed.*--project/i)
		await assert.rejects(fs.stat(calls), { code: "ENOENT" })
	}
})

test("explicit container selection cannot bypass fixed workspace or attachment validation", async (t) => {
	const directory = await fs.mkdtemp("/tmp/opencode/document-attachment-"), calls = path.join(directory, "calls")
	t.after(() => fs.rm(directory, { recursive: true, force: true }))
	await fs.writeFile(path.join(directory, "docker"), `#!${process.execPath}\nconst fs = require('node:fs'); const args = process.argv.slice(2); fs.appendFileSync(process.env.MOCK_CALLS, JSON.stringify(args)+'\\n'); if(args[0]==='inspect') console.log(process.env.MOCK_ENTRIES); else process.exit(9);\n`, { mode: 0o755 })
	const valid = { Id: "selected", State: { Running: true }, Config: { Env: ["RUNTIME_PROFILE=native", "PROJECT_ID=default", "RUNTIME_NATIVE_PROCESSING_MODEL=provider/model"] }, Mounts: [{ Destination: "/workspace", Type: "volume", Name: "geocluster-native-workspace" }] }
	for (const entries of [
		[{ ...valid, Config: { Env: valid.Config.Env.map((item) => item === "PROJECT_ID=default" ? "PROJECT_ID=named" : item) } }],
		[{ ...valid, State: { Running: false } }],
		[{ ...valid, Config: { Env: valid.Config.Env.map((item) => item === "RUNTIME_PROFILE=native" ? "RUNTIME_PROFILE=managed" : item) } }],
		[{ ...valid, Config: { Env: valid.Config.Env.filter((item) => !item.startsWith("RUNTIME_NATIVE_PROCESSING_MODEL=")) } }],
		[{ ...valid, Mounts: [{ ...valid.Mounts[0], Name: "different-workspace" }] }],
		[valid, { ...valid, Id: "another" }],
	]) {
		await fs.writeFile(calls, "")
		const result = spawnSync("bash", [fileURLToPath(new URL("../../scripts/process-document.sh", import.meta.url)), "--container", "selected", "status"], { encoding: "utf8", env: { ...process.env, PATH: `${directory}:${process.env.PATH}`, MOCK_CALLS: calls, MOCK_ENTRIES: JSON.stringify(entries) } })
		assert.equal(result.status, 1, result.stderr)
		assert.match(result.stderr, /exactly one running processing-enabled native runtime/)
		assert.deepEqual((await fs.readFile(calls, "utf8")).trim().split("\n").map(JSON.parse), [["inspect", "selected"]])
	}
})
