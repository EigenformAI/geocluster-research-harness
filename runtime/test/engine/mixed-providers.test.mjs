/** Isolated coexistence fixture, not a supported deployment profile. */
import assert from "node:assert/strict"
import fs from "node:fs"
import { test } from "node:test"
import { prepareSandbox } from "./engine.mjs"
import { plan, startFakeLlm } from "./fake-llm.mjs"
import { buildManagedConfig } from "../../../opencode/scripts/build-config.mjs"
import { NATIVE_MODEL, nativeDeclaration, modelRef, startNativeServer, writeNativeUserConfig, until } from "./native-engine.mjs"

test("managed attribution and refusal latch are scoped by provider identity, not supplier name", {
	skip: !process.env.OPENCODE_BIN, timeout: 60000,
}, async (t) => {
	const sandbox = fs.mkdtempSync("/tmp/opencode/mixed-provider-")
	t.diagnostic(`mixed-provider evidence: ${sandbox}`)
	const paths = prepareSandbox(sandbox, { profile: "managed" })
	const personal = await startFakeLlm({ requiredBearer: "personal-saved-key", log: `${sandbox}/personal.ndjson` })
	const managed = await startFakeLlm({ log: `${sandbox}/managed.ndjson` })
	t.after(async () => { await personal.close(); await managed.close() })
	const config = buildManagedConfig({ managedProxyURL: managed.url }, { managed_models: { [NATIVE_MODEL]: nativeDeclaration() }, default_model_id: NATIVE_MODEL })
	// Explicitly opt this test into coexistence. Production managed routing remains proxy-only.
	delete config.experimental.policies
	fs.writeFileSync(`${paths.config}/opencode.json`, JSON.stringify(config))
	writeNativeUserConfig(paths, personal.url)
	const engine = await startNativeServer({ paths })
	t.after(() => engine.stop())
	await until(async () => (await engine.api("/api/integration")).data.some((i) => i.id === "personal"), "mixed personal integration ready")
	await engine.api("/api/integration/personal/connect/key", { method: "POST", body: { key: "personal-saved-key" } })
	const sid = await engine.create("standard")
	await engine.api(`/api/session/${sid}/model`, { method: "POST", body: { model: modelRef(NATIVE_MODEL, "proxy") } })
	const refusal = { kind: "error", status: 403, code: "model_not_allowed", message: "Managed refusal", retryable: false }
	managed.intercept = (_body, record) => record.headers["x-geocluster-kind"] === "title" ? { kind: "wait", gate: "old-managed-title", then: refusal } : refusal
	await engine.api(`/api/session/${sid}/prompt`, { method: "POST", body: { text: "SAY managed denied" } })
	await until(() => managed.requests.length > 0, "managed refusal dispatched")
	await engine.idle()
	await until(() => managed.requests.some((r) => r.headers["x-geocluster-kind"] === "title"), "managed title request gated")
	assert.ok(managed.requests.every((r) => r.headers["x-geocluster-conversation-id"] === sid))
	assert.equal(managed.requests.filter((r) => r.headers["x-geocluster-kind"] === "primary").length, 1, "managed refusal never retries")
	assert.equal(personal.requests.length, 0, "managed refusal cannot automatically spend a personal connection")
	let nativeAttempts = 0
	personal.intercept = (body) => {
		const p = plan(body)
		// Identical supplier ID and a managed-looking error code still do not make
		// this a managed route. Its normal native 503 retry must remain available.
		if (p.aux) return p
		return nativeAttempts++ === 0 ? { ...p, kind: "error", status: 503, code: "model_not_allowed", message: "Native supplier temporary response" } : p
	}
	await engine.api(`/api/session/${sid}/model`, { method: "POST", body: { model: modelRef() } })
	await engine.api(`/api/session/${sid}/prompt`, { method: "POST", body: { text: "SAY explicitly personal after refusal" } })
	await until(() => personal.requests.length > 0, "explicit native request after managed denial")
	managed.release("old-managed-title")
	await engine.idle()
	await until(() => managed.requests.some((r) => r.headers["x-geocluster-kind"] === "title" && r.durationMs !== undefined), "old title refusal observed")
	assert.equal(personal.requests.filter((r) => !r.aux).length, 2, "managed denial classification must not suppress a native supplier retry")
	assert.ok(personal.requests.every((r) => r.authenticated === true && r.body.model === NATIVE_MODEL))
	assert.ok(personal.requests.every((r) => !Object.keys(r.headers).some((key) => key.startsWith("x-geocluster-"))), "managed hooks leaked attribution to the personal provider")
	assert.match(JSON.stringify(await engine.messages(sid)), /explicitly personal after refusal/)
	// A fresh personal turn still has the configured managed title default. Its
	// refusal may not cause the engine's auxiliary fallback to spend personal funds.
	// The native primary's real 503 backoff also lets the title scope settle.
	nativeAttempts = 0
	const fresh = await engine.create("standard"), mark = personal.requests.length
	await engine.api(`/api/session/${fresh}/model`, { method: "POST", body: { model: modelRef() } })
	await engine.api(`/api/session/${fresh}/prompt`, { method: "POST", body: { text: "SAY fresh personally selected turn" } })
	await until(() => personal.requests.length > mark, "fresh personal primary dispatched")
	await engine.idle()
	assert.equal(personal.requests.filter((r) => r.aux).length, 0, "a managed title refusal must not fall back to personally funded inference")
})
