import assert from "node:assert/strict"
import fs from "node:fs/promises"
import path from "node:path"
import { execFileSync } from "node:child_process"
import { test } from "node:test"
import { AccountUsage } from "../lib/account-usage.js"

const declaration = () => ({ name: "Unknown maker model", capabilities: { tools: true, input: ["text", "image"], output: ["text"] }, limit: { context: 24000, input: 20000, output: 4000 }, variants: [{ id: "high", settings: { reasoning: { effort: "high" } } }] })
export const discovery = (ids = ["new/maker/model"]) => ({ discovery_schema_version: 2, allowed_model_ids: ids, default_model_id: ids[0] ?? null, managed_models: Object.fromEntries(ids.map((id) => [id, declaration()])) })
const identity = { backendBaseUrl: "https://backend.test/llm", projectId: "p1", runtimeGeneration: "generation-1" }

test("discovery has no cold fallback and retains explicitly stale eligibility, including empty", async () => {
	let value = discovery(), outage = true
	const usage = new AccountUsage({ llmProxyUrl: identity.backendBaseUrl, llmToken: "secret", managedCatalog: { catalog: discovery() } }, { fetchImpl: async () => { if (outage) throw Error("offline"); return new Response(JSON.stringify(value)) } })
	await usage.refresh()
	assert.equal(usage.allowed("proxy/openai/gpt-6-luna"), false, "cold outage must not manufacture Standard IDs")
	assert.equal(usage.allowed("proxy/new/maker/model"), false)
	assert.equal(usage.status().state, "unavailable")
	outage = false; await usage.refresh()
	assert.equal(usage.allowed("proxy/new/maker/model"), true)
	outage = true; await usage.refresh()
	assert.equal(usage.status().state, "stale")
	assert.equal(usage.allowed("proxy/new/maker/model"), true)
	outage = false; value = discovery([]); await usage.refresh()
	assert.equal(usage.allowed("proxy/new/maker/model"), false)
	outage = true; await usage.refresh()
	assert.equal(usage.allowed("proxy/new/maker/model"), false)
})

test("validated catalog is exact v2, opaque IDs, strict fields and safe budgets", async () => {
	const { validateDiscovery } = await import("../lib/managed-catalog.js")
	assert.deepEqual(validateDiscovery(discovery()), discovery())
	for (const version of [undefined, 1, 3, "2"]) assert.throws(() => validateDiscovery({ ...discovery(), discovery_schema_version: version }), /managed_discovery_schema_unsupported/)
	for (const mutate of [
		(v) => v.allowed_model_ids.push(v.allowed_model_ids[0]),
		(v) => v.default_model_id = "missing/model",
		(v) => v.managed_models["new/maker/model"].headers = { authorization: "secret" },
		(v) => v.managed_models["new/maker/model"].limit.input = 22000,
		(v) => v.managed_models["new/maker/model"].limit.context = Number.MAX_SAFE_INTEGER + 1,
		(v) => v.managed_models["new/maker/model"].capabilities.tools = "true",
		(v) => v.managed_models["new/maker/model"].variants[0].settings.extraBody = {},
		(v) => v.managed_models["new/maker/model"].variants[0].settings.reasoning.effort = "invented-effort",
		(v) => v.managed_models["new/maker/model"].variants.push(v.managed_models["new/maker/model"].variants[0]),
	]) { const v = discovery(); mutate(v); assert.throws(() => validateDiscovery(v), /managed_discovery_invalid:/) }
	for (const id of ["maker/model#effort", "maker/model\n", "maker/model?key", "maker/model\\escape"]) assert.throws(() => validateDiscovery(discovery([id])), /managed_discovery_invalid:/)
	assert.deepEqual(validateDiscovery(discovery([])), discovery([]))
})

test("bounded discovery refuses redirects and accounts for the full response", async () => {
	const { fetchDiscovery } = await import("../lib/managed-catalog.js")
	let init
	const config = { llmProxyUrl: identity.backendBaseUrl, llmToken: "secret", managedDiscoveryMaxBytes: 1024 }
	await assert.rejects(fetchDiscovery(config, { fetchImpl: async (_url, options) => { init = options; return new Response(JSON.stringify({ ...discovery(), accountPadding: "x".repeat(1024) })) } }), /managed_discovery_response_too_large/)
	assert.equal(init.redirect, "error")
	await assert.rejects(fetchDiscovery(config, { fetchImpl: async () => new Response("{}", { status: 302, headers: { location: "https://elsewhere.test" } }) }), /managed_discovery_unavailable/)
})

test("artifact publication is identity bound and leaves previous bytes intact on failure", async (t) => {
	const { publishCatalog, readCatalogArtifact, startupCatalog } = await import("../lib/managed-catalog.js")
	const dir = await fs.mkdtemp("/tmp/opencode/catalog-test-"); t.after(() => fs.rm(dir, { recursive: true, force: true }))
	const file = path.join(dir, "catalog.json")
	const oldMask = process.umask(0o077)
	let published
	try { published = await publishCatalog(file, discovery(), identity) } finally { process.umask(oldMask) }
	assert.equal((await fs.stat(file)).mode & 0o777, 0o644, "public metadata must remain readable under root's restrictive bootstrap umask")
	const before = await fs.readFile(file, "utf8")
	const cliEnv = { PATH: process.env.PATH, PROJECT_ID: identity.projectId, RUNTIME_MANAGED_BACKEND_BASE_URL: identity.backendBaseUrl, RUNTIME_MANAGED_GENERATION: identity.runtimeGeneration, RUNTIME_MANAGED_CATALOG_PATH: file }
	const cli = new URL("../lib/managed-catalog.js", import.meta.url).pathname
	assert.deepEqual(JSON.parse(execFileSync(process.execPath, [cli, "read"], { env: cliEnv, encoding: "utf8" })), discovery())
	if (process.getuid() !== 0) assert.throws(() => execFileSync(process.execPath, [cli, "startup"], { env: cliEnv, stdio: "pipe" }), (error) => error.status === 1 && /managed_catalog_root_startup_required/.test(error.stderr.toString()))
	assert.equal((await readCatalogArtifact(file, identity)).digest, published.digest)
	assert.equal((await readCatalogArtifact(file, { ...identity, backendBaseUrl: "https://BACKEND.test:443/llm/" })).digest, published.digest)
	await assert.rejects(readCatalogArtifact(file, { ...identity, backendBaseUrl: "https://another-backend.test/llm" }), /managed_catalog_identity_mismatch/)
	await assert.rejects(readCatalogArtifact(file, { ...identity, projectId: "other" }), /managed_catalog_identity_mismatch/)
	await assert.rejects(readCatalogArtifact(file, { ...identity, runtimeGeneration: "generation-2" }), /managed_catalog_identity_mismatch/)
	await assert.rejects(publishCatalog(file, { ...discovery(), discovery_schema_version: 1 }, identity))
	await assert.rejects(publishCatalog(file, discovery(["other/model"]), identity, { beforeRename: () => { throw Error("simulated crash") } }), /simulated crash/)
	assert.equal(await fs.readFile(file, "utf8"), before)
	const config = { llmProxyUrl: identity.backendBaseUrl, llmToken: "secret", projectId: identity.projectId, runtimeGeneration: identity.runtimeGeneration, managedCatalogPath: file }
	assert.equal((await startupCatalog(config, { fetchImpl: async () => { throw Error("offline") } })).state, "stale")
	assert.equal((await startupCatalog({ ...config, projectId: "other" }, { fetchImpl: async () => { throw Error("offline") } })).state, "unavailable")
	const damaged = JSON.parse(before); damaged.catalog.managed_models["new/maker/model"].name = "changed"; await fs.writeFile(file, JSON.stringify(damaged))
	await assert.rejects(readCatalogArtifact(file, identity), /managed_catalog_digest_mismatch/)
})

test("refresh never installs new declarations and reports restart for changed execution metadata", async () => {
	const { createCatalogArtifact } = await import("../lib/managed-catalog.js")
	const installed = createCatalogArtifact(discovery(), identity)
	let value = discovery(["new/maker/model", "another/new/model"])
	const usage = new AccountUsage({ llmProxyUrl: identity.backendBaseUrl, projectId: identity.projectId, runtimeGeneration: identity.runtimeGeneration, managedCatalog: installed }, { fetchImpl: async () => new Response(JSON.stringify(value)) })
	await usage.refresh()
	assert.equal(usage.allowed("proxy/new/maker/model"), true)
	assert.equal(usage.allowed("proxy/another/new/model"), false)
	assert.equal(usage.status().catalogRestartRequired, true)
	value = discovery(); value.managed_models["new/maker/model"].limit.output = 3000
	await usage.refresh()
	assert.equal(usage.status().catalogRestartRequired, true)
	assert.equal(installed.catalog.managed_models["new/maker/model"].limit.output, 4000)
})

test("an identity change cannot reuse stale picker evidence or an installed catalog", async () => {
	const { createCatalogArtifact } = await import("../lib/managed-catalog.js")
	const config = { llmProxyUrl: identity.backendBaseUrl, projectId: identity.projectId, runtimeGeneration: identity.runtimeGeneration, managedCatalog: createCatalogArtifact(discovery(), identity) }
	const usage = new AccountUsage(config, { fetchImpl: async () => new Response(JSON.stringify(discovery())) })
	await usage.refresh()
	assert.equal(usage.allowed("proxy/new/maker/model"), true)
	config.projectId = "different-project"
	await usage.refresh()
	assert.equal(usage.status().state, "unavailable")
	assert.equal(usage.allowed("proxy/new/maker/model"), false)
})

test("managed bootstrap preserves upstream identity while discovery crosses only the relay", async () => {
	const { loadConfig } = await import("../lib/config.js")
	const { catalogIdentity, createCatalogArtifact } = await import("../lib/managed-catalog.js")
	const relay = "http://127.0.0.1:3003/llm", calls = []
	const config = loadConfig({ PROJECT_ID: identity.projectId, RUNTIME_STATE_ROOT: "/retained/runtime", LLM_PROXY_URL: relay, IDE_LLM_TOKEN: "runtime-relay", RUNTIME_MANAGED_BACKEND_BASE_URL: identity.backendBaseUrl, RUNTIME_MANAGED_GENERATION: identity.runtimeGeneration, RUNTIME_MANAGED_DISCOVERY_MAX_BYTES: "1048576" })
	assert.deepEqual(catalogIdentity(config), identity)
	assert.equal(config.managedCatalogPath, "/retained/runtime/managed-catalog.json")
	config.managedCatalog = createCatalogArtifact(discovery(), identity)
	const usage = new AccountUsage(config, { fetchImpl: async (url, init) => { calls.push({ url, authorization: init.headers.authorization }); return new Response(JSON.stringify(discovery())) } })
	await usage.refresh()
	assert.equal(usage.status().state, "fresh")
	assert.equal(usage.allowed("proxy/new/maker/model"), true)
	assert.deepEqual(calls, [{ url: relay + "/account", authorization: "Bearer runtime-relay" }])
	config.runtimeGeneration = "different-generation"
	await usage.refresh()
	assert.equal(usage.status().state, "unavailable")
	assert.equal(usage.allowed("proxy/new/maker/model"), false)
	assert.equal(calls.length, 1, "identity mismatch must not adopt eligibility from a different generation")
})
