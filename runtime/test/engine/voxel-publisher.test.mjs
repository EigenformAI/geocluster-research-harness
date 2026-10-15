/** Real 2.0.19 native tools → Unix listener → WorkspaceFiles captures/workers/publication.
 * Only the LLM is scripted; the plugin's HTTP destination is redirected to a HOME sandbox.
 */
import { test } from "node:test"
import assert from "node:assert/strict"
import crypto from "node:crypto"
import fs from "node:fs"
import os from "node:os"
import path from "node:path"
import { isDeepStrictEqual } from "node:util"
import { execFileSync } from "node:child_process"
import { createFilesServer } from "../../files-server.js"
import { startEngine, prepareSandbox } from "./engine.mjs"
import { startFakeLlm, plan, classify, specialistResult, systemOf, textOf } from "./fake-llm.mjs"

const bin = process.env.OPENCODE_BIN
const skip = !bin && "Set OPENCODE_BIN to the pinned 2.0.19 binary; acceptance requires real execution."
const nativeTools = ["voxel_resolve", "voxel_inspect", "voxel_prepare", "voxel_validate", "voxel_submit", "voxel_status"].sort()
const shape = [16, 16, 12], cells = 3072, target = [15, 14, 11], editedLabel = "replacement-category"
const hash = (bytes) => crypto.createHash("sha256").update(bytes).digest("hex")

function indexed(scope) {
	return { kind: "indexed-grid", revision: null, recipe: {
		schemaVersion: 1, algorithm: "geocluster-indexed-v1", name: "Engine category pattern", scope,
		indices: { x: 0, y: 1, z: 2, base: 0 }, shape,
		placement: { origin: [0, 0, 0], spacing: [1, 1, 1], unit: "grid-unit", horizontalReference: { type: "unreferenced", definition: "" }, verticalReference: null },
		field: { kind: "categorical", column: 3, name: "Category", trim: false },
		numbers: { decimal: ".", thousands: "none", missingTokens: [], sentinels: [], censored: "exclude" },
		emptyCells: "forbid", predecessor: null,
	} }
}

// Independent NPY reader: do not share the production decoder/indexer with the acceptance oracle.
function decodeMember(bytes, dtype) {
	assert.deepEqual([...bytes.subarray(0, 8)], [147, 78, 85, 77, 80, 89, 1, 0])
	const offset = 10 + bytes.readUInt16LE(8), header = bytes.subarray(10, offset).toString("ascii")
	assert.match(header, new RegExp(`'descr': '${dtype.replace(/[|]/g, "\\|")}'`))
	assert.match(header, /'fortran_order': False/)
	assert.deepEqual(header.match(/'shape': \(([^)]+)\)/)[1].split(",").map((n) => n.trim()).filter(Boolean).map(Number), shape)
	const width = dtype === "|u1" ? 1 : 4
	assert.equal(bytes.length, offset + cells * width)
	return Array.from({ length: cells }, (_, n) => width === 1 ? bytes[offset + n] : bytes.readUInt32LE(offset + n * width))
}

async function decodedArtifact(workspace, binding, expected, predecessor) {
	const record = await workspace.state.get("voxel-artifacts", binding.artifactId)
	assert.equal(record.state, "ready"); assert.deepEqual(record.link, binding)
	const capturedBytes = async (source) => {
		const capture = await workspace.state.get("captures", source.revision.slice(8))
		assert.equal(capture.source.digest.state, "ready")
		const bytes = fs.readFileSync(workspace.captures.blobPath(capture))
		assert.equal(hash(bytes), source.sha256)
		return bytes
	}
	const manifestBytes = await capturedBytes(binding.manifest), manifest = JSON.parse(manifestBytes)
	assert.deepEqual(manifest, record.manifest)
	const canonical = (v) => Array.isArray(v) ? v.map(canonical) : v && typeof v === "object" ? Object.fromEntries(Object.keys(v).sort().map((k) => [k, canonical(v[k])])) : v
	const { generation, ...body } = manifest
	assert.equal(hash(JSON.stringify(canonical(body))), generation)
	assert.equal(generation, binding.generation)
	assert.equal(manifest.artifactId, binding.artifactId)
	assert.deepEqual(manifest.predecessor, predecessor)
	assert.equal(manifest.creation.algorithm, "geocluster-indexed-v1")
	assert.equal(manifest.recipe.type, "indexed-grid")
	assert.deepEqual(manifest.grid, { shape, origin: [0, 0, 0], spacing: [1, 1, 1], axes: "x,y,z", order: "C-z-fastest", unit: "grid-unit", horizontalReference: { type: "unreferenced", definition: "" }, verticalReference: null })
	assert.equal(manifest.statistics.validCells, cells)
	assert.equal(manifest.statistics.absentRecordCells, 0)
	assert.equal(manifest.statistics.emptySuppliedValueCells, 0)
	assert.equal(manifest.statistics.duplicateCellGroups, 0)
	assert.deepEqual(manifest.arrays.map((m) => m.role).sort(), ["valid", "values"])
	const arrays = {}
	for (const member of manifest.arrays) {
		const bytes = await capturedBytes(record.members[member.role].source)
		assert.equal(bytes.length, member.byteLength); assert.equal(hash(bytes), member.sha256)
		assert.equal(member.contentId, `sha256:${member.sha256}`)
		const dtype = member.role === "valid" ? "|u1" : "<u4"
		assert.equal(member.dtype, dtype)
		arrays[member.role] = decodeMember(bytes, dtype)
	}
	assert.deepEqual(manifest.field.categories, [...new Set(expected)].sort().map((label, code) => ({ code, label })))
	const labels = arrays.values.map((code, n) => {
		assert.equal(arrays.valid[n], 1, `mask at cell ${n}`)
		assert.ok(manifest.field.categories[code], `dictionary code at cell ${n}`)
		const label = manifest.field.categories[code].label
		assert.equal(label, expected[n], `category at cell ${n}`)
		return label
	})
	assert.equal(arrays.values[0], 0); assert.equal(labels[0], "0"); assert.equal(arrays.valid[0], 1)
	assert.equal(fs.readFileSync(path.join(workspace.config.workspaceDir, binding.manifest.path), "utf8"), manifestBytes.toString())
	return labels
}

test("2.0.19 real publisher retains a complete categorical voxel through engine/daemon restart and one-cell revision", { skip, timeout: 180000 }, async (t) => {
	assert.match(execFileSync(bin, ["--version"], { encoding: "utf8" }), /v?2\.0\.19\b/)
	const sandbox = fs.mkdtempSync(path.join(os.homedir(), ".gc-publisher-")), paths = prepareSandbox(sandbox)
	const socketDir = path.join(sandbox, "socket"), socketPath = path.join(socketDir, "voxels.sock"), traceFile = path.join(sandbox, "publisher.ndjson")
	fs.mkdirSync(socketDir, { mode: 0o750 })
	const config = { workspaceDir: paths.ws, filesStateDir: path.join(sandbox, "private"), filesAgentUids: [20001], filesWorkerUids: [20003], filesWorkbookWorkerEnabled: false, filesGisWorkerEnabled: false, filesLimits: { captureInlineBytes: 1 }, voxelAgentEnabled: true, voxelAgentSocket: socketPath, voxelAgentGid: process.getegid() }
	const logger = { info() {}, warn() {}, error(...args) { t.diagnostic(JSON.stringify(args)) } }
	let engine, app
	const llm = await startFakeLlm()
	t.after(async () => {
		await engine?.stop(); await app?.shutdown(); await llm.close()
		for (const r of llm.requests.filter((r) => r.response?.kind === "harness-error")) t.diagnostic(`Scripted planner rejected: ${r.response.error}`)
		if (process.env.VOXEL_PUBLISHER_EVIDENCE_DIR) {
			fs.mkdirSync(process.env.VOXEL_PUBLISHER_EVIDENCE_DIR, { recursive: true })
			if (fs.existsSync(traceFile)) fs.copyFileSync(traceFile, path.join(process.env.VOXEL_PUBLISHER_EVIDENCE_DIR, "publisher.ndjson"))
			fs.writeFileSync(path.join(process.env.VOXEL_PUBLISHER_EVIDENCE_DIR, "planner-errors.json"), JSON.stringify(llm.requests.filter((r) => r.response?.kind === "harness-error").map((r) => ({ response: r.response, lastMessages: r.body.messages.slice(-3) })), null, 2))
		}
		fs.rmSync(sandbox, { recursive: true, force: true })
	})
	const expected = [], csv = ["x,y,z,category"]
	// Deliberately shuffled source rows; independently specified C-z-fastest oracle below.
	for (let z = 11; z >= 0; z--) for (let y = 15; y >= 0; y--) for (let x = 15; x >= 0; x--) csv.push(`${x},${y},${z},${(x + 2 * y + 3 * z) % 4}`)
	for (let n = 0; n < cells; n++) expected.push(String((Math.floor(n / 192) + 2 * (Math.floor(n / 12) % 16) + 3 * (n % 12)) % 4))
	const categoryCSV = csv.join("\n") + "\n"
	fs.writeFileSync(path.join(paths.ws, "category.csv"), categoryCSV)
	const trace = () => fs.readFileSync(traceFile, "utf8").trim().split("\n").filter(Boolean).map(JSON.parse)
	// Real HTTP client; receipts and captures are supplied only by createFilesServer.
	const plugin = `import fs from "node:fs";
import http from "node:http";
import {setup} from "../lib/voxel-agent.js";
export default {id:"geocluster-voxel-agent",setup:async(ctx)=>{
const trace=${JSON.stringify(traceFile)}, socketPath=${JSON.stringify(socketPath)};
await setup(ctx,{request:(body,{signal}={})=>new Promise((resolve,reject)=>{
const bytes=Buffer.from(JSON.stringify(body));
const req=http.request({socketPath,path:"/agent/voxels",method:"POST",signal,headers:{"content-type":"application/json","content-length":bytes.length}},res=>{
const parts=[]; res.on("data",b=>parts.push(b)); res.on("error",reject); res.on("end",()=>{try{
const reply=JSON.parse(Buffer.concat(parts).toString());
fs.appendFileSync(trace,JSON.stringify({kind:"http",body,status:res.statusCode,retryAfter:res.headers["retry-after"]??null,reply})+"\\n");
if(res.statusCode<200||res.statusCode>=300)reject(new Error(JSON.stringify(reply)));else resolve(reply);
}catch(e){reject(e)}})});req.setTimeout(30000,()=>req.destroy(new Error("test Unix HTTP timeout")));req.on("error",reject);req.end(bytes);
})});
await ctx.tool.hook("execute.after",e=>{if(e.status==="completed"&&(e.tool.startsWith("voxel_")||e.tool==="subagent")){
fs.appendFileSync(trace,JSON.stringify({kind:"tool",tool:e.tool,agent:e.agent,input:e.input,result:e.result})+"\\n")}});
}};`
	const tool = (name, input) => ({ kind: "tool", agent: "voxel", tool: name, input })
	let specialistStarts = 0, retryStartedAt
	const retries = []
	llm.intercept = (body) => {
		if (classify(body).agent !== "voxel") return plan(body)
		const system = systemOf(body), messages = body.messages, user = textOf([...messages].reverse().find((m) => m.role === "user")?.content)
		const revision = user.includes("REVISE_PATTERN")
		if (!user.includes("CREATE_PATTERN") && !revision) return plan(body)
		const calls = new Map(messages.flatMap((m) => m.tool_calls ?? []).map((call) => [call.id, { name: call.function.name, input: JSON.parse(call.function.arguments) }]))
		const results = messages.filter((m) => m.role === "tool").map((m) => { const text = textOf(m.content); let result; try { result = JSON.parse(text) } catch { result = { errorText: text } }; return { ...calls.get(m.tool_call_id), result } })
		assert.ok(results.length < 30, "bounded native specialist planner must settle within 30 calls")
		const last = (name) => results.findLast((r) => r.name === name)?.result
		const latest = results.at(-1)
		// The scripted agent reacts to a real service rejection. The socket adapter
		// never retries, and no read is replaced with a fabricated successful result.
		if (latest && ["voxel_inspect", "voxel_prepare"].includes(latest.name) && latest.input?.artifact) {
			const action = latest.name === "voxel_inspect" ? "inspect" : "prepare"
			const response = trace().findLast((e) => e.kind === "http" && e.body.action === action)
			assert.deepEqual(response.body.artifact, latest.input.artifact)
			if (response.status !== 200) {
				assert.ok([429, 503].includes(response.status), JSON.stringify(response))
				assert.ok(["artifact_verifying", "capacity", "artifact_unavailable", "capture_store_unavailable"].includes(response.reply.error), JSON.stringify(response))
				assert.deepEqual(latest.input.artifact, last("voxel_resolve").artifact, "retry freezes the complete resolved artifact; it never resolves a newer head")
				const advertised = response.retryAfter ?? response.reply.retryAfter ?? (response.reply.retryAt ? Math.max(0, (Date.parse(response.reply.retryAt) - Date.now()) / 1000) : undefined)
				// The Unix surface currently omits a duration for artifact_verifying.
				// The agent's explicit fallback policy is a 250 ms read-only wait.
				const seconds = advertised === undefined ? 0.25 : Number(advertised)
				assert.ok(Number.isFinite(seconds) && seconds >= 0 && seconds <= 10, "the service hint or explicit fallback must fit the bounded retry policy")
				retryStartedAt ??= Date.now(); assert.ok(retries.length < 8 && Date.now() - retryStartedAt + seconds * 1000 <= 30000, "exact-read retries have eight-attempt and 30-second cumulative bounds")
				const retry = { action, artifact: structuredClone(latest.input.artifact), status: response.status, error: response.reply.error, waitSeconds: seconds, waitSource: advertised === undefined ? "explicit-agent-fallback" : "service-hint" }; retries.push(retry)
				const gate = `exact-read-${retries.length}`; setTimeout(() => llm.release(gate), Math.max(20, seconds * 1000)).unref()
				return { kind: "wait", gate, then: tool(latest.name, structuredClone(latest.input)) }
			}
		}
		if (!results.length) {
			specialistStarts++
			assert.deepEqual(body.tools.map((t) => t.function.name).filter((n) => n.startsWith("voxel_")).sort(), nativeTools)
			assert.match(system, /Runtime voxel capabilities/)
			assert.match(system, /geocluster-indexed-v1/)
			if (!revision) return tool("voxel_prepare", { path: "category.csv" })
			const refs = JSON.parse(system.split("# Trusted voxel references\n")[1].split("\n")[1])
			assert.equal(refs.at(-1).summary.validCells, cells)
			assert.ok(!/active.view|activeView|voxelId|vox-/.test(user), "fresh specialist gets no target from its user prompt")
			return tool("voxel_resolve", { reference: refs.at(-1) })
		}
		const resolved = last("voxel_resolve")
		if (revision && !last("voxel_inspect")) return tool("voxel_inspect", { artifact: resolved.artifact, options: { indices: [[0, 0, 0], target], limit: 2 } })
		if (revision && !last("voxel_prepare")) {
			assert.equal(last("voxel_inspect").integrity, "verified")
			const root = llm.requests.find((r) => r.agent === "geology")?.session
			return tool("voxel_prepare", { artifact: resolved.artifact, destination: `runs/${root}/results/replacement.csv`, options: { edits: [{ index: target, valid: true, value: editedLabel }] } })
		}
		const prepared = last("voxel_prepare")
		if (revision) { assert.equal(prepared.complete, true); assert.equal(prepared.rows, cells) }
		const submission = revision ? { kind: "indexed-grid", recipe: prepared.recipe, revision: { voxelId: resolved.voxelId, expectedHeadRevision: resolved.headRevision, base: resolved.artifact } } : indexed(prepared.description.scope)
		if (!last("voxel_validate")) return tool("voxel_validate", { submission })
		assert.equal(last("voxel_validate").scanComplete, true); assert.deepEqual(last("voxel_validate").blockingErrors, [])
		const idempotencyKey = revision ? "engine-revision" : "engine-initial"
		if (!last("voxel_submit")) return tool("voxel_submit", { submission, idempotencyKey })
		const status = last("voxel_status")
		if (!status || !["ready", "failed"].includes(status.phase)) return tool("voxel_status", { idempotencyKey })
		assert.equal(status.phase, "ready", JSON.stringify(status)); assert.equal(status.named.outcome, "committed")
		return { kind: "text", agent: "voxel", text: specialistResult(revision ? "Replaced one category; all other cells retained." : "Published the complete categorical grid.") }
	}
	const start = async () => {
		app = await createFilesServer({ config, secret: "a".repeat(64), logger })
		await new Promise((resolve) => app.server.listen(0, "127.0.0.1", resolve))
		engine = await startEngine({ sandbox, bin, llmUrl: llm.url, extraPlugins: { "voxel-agent.js": plugin } })
		await engine.initialize()
	}
	const turn = async (sid, prompt) => {
		const result = await engine.turn(sid, prompt, { timeoutMs: 60000 })
		assert.equal(result.error, null, JSON.stringify(result)); assert.equal(result.timeout, false)
		assert.equal(result.stopReason, "end_turn", JSON.stringify(result))
	}
	const committed = (key) => trace().findLast((e) => e.kind === "http" && e.body.action === "status" && e.body.idempotencyKey === key && e.reply.result.phase === "ready")?.reply.geoclusterVoxel
	const handoffs = (ref, events, frames) => {
		const rows = events.filter((e) => e.kind === "tool" && e.tool === "subagent")
		assert.equal(rows.length, 2)
		assert.deepEqual(rows.map((e) => [e.agent, e.input.agent]), [["orchestrator", "voxel"], ["geology", "orchestrator"]])
		for (const row of rows) {
			assert.deepEqual(row.result.metadata.geoclusterVoxel, ref, "both real native handoffs retain the daemon receipt")
			assert.deepEqual(row.result.metadata.geoclusterVoxelReferences.at(-1), ref)
			assert.match(row.result.metadata.sessionID, /^ses_/)
		}
		assert.equal(new Set(rows.map((r) => r.result.metadata.sessionID)).size, 2)
		const raw = frames.map((f) => f.msg?.params?.update?.rawOutput).filter((r) => r?.metadata?.geoclusterVoxel?.operationId === ref.operationId)
		assert.ok(raw.length >= 3, "ACP rawOutput carries native tool and both handoffs")
		for (const row of rows) assert.ok(raw.some((r) => r.metadata.sessionID === row.result.metadata.sessionID && isDeepStrictEqual(r.metadata.geoclusterVoxel, ref)), "each distinct handoff is streamed, not only observed inside the plugin")
	}
	await start()
	const sid = await engine.newSession("geology")
	await turn(sid, "DELEGATE orchestrator DELEGATE voxel CREATE_PATTERN publish the supplied category table, preserving category 0.")
	const initial = committed("engine-initial")
	assert.ok(initial, "real capture, validation, submission and status reach ready")
	assert.equal(initial.outcome, "named-created"); assert.equal(initial.summary.validCells, cells)
	handoffs(initial, trace(), engine.frames)
	const prepared = trace().find((e) => e.kind === "http" && e.body.action === "prepare").reply.result
	assert.equal(prepared.source.sha256, hash(categoryCSV)); assert.equal(prepared.description.rows, cells)
	assert.ok((await app.files.workspace.state.list("jobs")).some((j) => j.type === "capture" && j.state === "succeeded"), "canonical asynchronous capture completed")
	const originalLabels = await decodedArtifact(app.files.workspace, initial.artifact, expected, null)
	const stored = await app.files.workspace.state.list("voxel-agent-references")
	assert.equal(stored.length, 1); assert.equal(stored[0].conversationId, sid); assert.deepEqual(stored[0].scope, initial.scope)
	assert.deepEqual(stored[0].references.at(-1), initial)
	const restart = async () => { await engine.stop(); await app.shutdown(); await start(); await engine.loadSession(sid) }
	const beforeRestart = trace().length
	await restart()
	assert.ok(engine.frames.some((f) => isDeepStrictEqual(f.msg?.params?.update?.rawOutput?.metadata?.geoclusterVoxel, initial)), "session/load replays the real receipt after engine restart")
	assert.deepEqual(await app.files.workspace.state.list("voxel-agent-references"), stored)
	assert.equal((await app.files.workspace.state.list("voxel-artifacts")).length, 1, "load replay does not republish")
	const at = engine.frames.length
	await turn(sid, `DELEGATE orchestrator DELEGATE voxel REVISE_PATTERN change cell [${target}] to ${editedLabel}, preserving the rest of the grid.`)
	const updated = committed("engine-revision")
	assert.ok(updated); assert.equal(updated.outcome, "head-advanced"); assert.equal(updated.summary.validCells, cells)
	assert.equal(updated.named.voxelId, initial.named.voxelId); assert.notEqual(updated.named.headRevision, initial.named.headRevision)
	assert.notEqual(updated.artifact.artifactId, initial.artifact.artifactId); assert.notEqual(updated.artifact.generation, initial.artifact.generation)
	const revisionEvents = trace().slice(beforeRestart)
	handoffs(updated, revisionEvents, engine.frames.slice(at))
	const firstChild = trace().find((e) => e.kind === "tool" && e.tool === "subagent" && e.input.agent === "voxel").result.metadata.sessionID
	const freshChild = revisionEvents.find((e) => e.kind === "tool" && e.tool === "subagent" && e.input.agent === "voxel").result.metadata.sessionID
	assert.notEqual(freshChild, firstChild, "revision is dispatched to a fresh specialist session")
	const resolution = revisionEvents.find((e) => e.kind === "http" && e.body.action === "resolve")
	assert.deepEqual(resolution.reply.result.artifact, initial.artifact); assert.equal(resolution.reply.result.headRevision, initial.named.headRevision)
	assert.ok(revisionEvents.some((e) => e.kind === "http" && e.body.action === "references" && e.body.conversationId === sid && e.reply.references.some((r) => r.operationId === initial.operationId)), "fresh child requests protected root-conversation references")
	const replacement = revisionEvents.find((e) => e.kind === "http" && e.body.action === "prepare" && e.status === 200).reply.result
	const upload = (await app.files.workspace.state.list("operations")).find((o) => o.intent?.path === replacement.path)
	assert.equal(upload.intent.mode, "create"); assert.equal(upload.intent.processingPolicy, "skip")
	assert.equal(replacement.source.revision, `capture:${upload.publishedSource.captureId}`)
	const revisedExpected = [...expected], changedIndex = (target[0] * 16 + target[1]) * 12 + target[2]
	revisedExpected[changedIndex] = editedLabel
	const revisedLabels = await decodedArtifact(app.files.workspace, updated.artifact, revisedExpected, { artifactId: initial.artifact.artifactId, generation: initial.artifact.generation })
	assert.deepEqual(revisedLabels.flatMap((label, n) => label !== originalLabels[n] ? [n] : []), [changedIndex], "exactly one decoded category changed")
	const submitted = revisionEvents.find((e) => e.kind === "http" && e.body.action === "submit").body
	const stateBeforeReplay = await app.files.workspace.state.list("voxel-artifacts")
	await restart()
	assert.deepEqual((await app.files.workspace.state.list("voxel-agent-references"))[0].references.at(-1), updated, "latest protected reference survives the second daemon restart")
	await turn(sid, `DELEGATE orchestrator DELEGATE voxel TOOL voxel_submit ${JSON.stringify({ submission: submitted.submission, idempotencyKey: submitted.idempotencyKey })}`)
	const replay = trace().findLast((e) => e.kind === "http" && e.body.action === "submit").reply
	assert.equal(replay.result.operation.id, updated.operationId); assert.deepEqual(replay.geoclusterVoxel, updated)
	const exactRegistrations = (records) => records.map(({ artifactId, link, manifest }) => ({ artifactId, link, manifest })).sort((a, b) => a.artifactId.localeCompare(b.artifactId))
	assert.deepEqual(exactRegistrations(await app.files.workspace.state.list("voxel-artifacts")), exactRegistrations(stateBeforeReplay), "retained-key replay after restart preserves exact registrations; lazy verification remains current lifecycle state")
	assert.equal(stateBeforeReplay.length, 2)
	assert.deepEqual((await app.files.workspace.voxels.namedResolve({ voxelId: initial.named.voxelId })).artifact, updated.artifact)
	assert.equal(specialistStarts, 2, "restart revision uses a fresh specialist workflow")
	for (const event of trace().filter((e) => e.kind === "http")) {
		if (event.status !== 200) assert.ok(retries.some((r) => r.action === event.body.action && r.status === event.status && r.error === event.reply.error && isDeepStrictEqual(r.artifact, event.body.artifact)), JSON.stringify(event))
		assert.equal(event.body.conversationId, sid)
		if (event.body.scope !== null) assert.deepEqual(event.body.scope, initial.scope)
	}
	for (const request of llm.requests.filter((r) => r.body?.tools && classify(r.body).agent !== "voxel")) assert.ok(!request.body.tools.some((t) => t.function.name.startsWith("voxel_")), "actual parent permissions do not offer specialist tools")
	const socket = fs.lstatSync(socketPath)
	assert.ok(socket.isSocket()); assert.equal(socket.mode & 0o777, 0o660); assert.equal(socket.gid, process.getegid())
	assert.ok(retries.some((r) => r.error === "artifact_verifying"), "post-restart lazy verification must be observed as a real retry response")
	t.diagnostic(`Real 2.0.19 + listening daemon + Unix listener + native safe-fs: 3072 initial and revised cells decoded; one changed; two artifacts after restart/replay; exact read retries=${JSON.stringify(retries)}.`)
})
