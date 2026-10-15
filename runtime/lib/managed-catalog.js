/** Public execution metadata only. Backend admission, never this catalog, grants funding. */
import crypto from "node:crypto"
import fs from "node:fs/promises"
import { constants } from "node:fs"
import path from "node:path"
import { pathToFileURL } from "node:url"

export const DISCOVERY_SCHEMA_VERSION = 2
export const DEFAULT_DISCOVERY_MAX_BYTES = 1024 * 1024
const fail = (field) => { throw new Error(`managed_discovery_invalid:${field}`) }
const object = (value) => value !== null && typeof value === "object" && !Array.isArray(value)
const own = (value, key) => Object.hasOwn(value, key)
function fields(value, accepted, field) {
	if (!object(value) || Object.keys(value).length !== accepted.length || accepted.some((key) => !own(value, key))) fail(field)
}
export function modelId(value) {
	// IDs are opaque supplier keys, not path segments. # separates engine variants.
	return typeof value === "string" && value.length > 0 && !/[\s\p{Cc}\p{Cf}#?\\\uFFFD]/u.test(value) && !value.includes(":")
}
export function managedModelId(reference) {
	if (typeof reference !== "string") return null
	const slash = reference.indexOf("/")
	return reference.slice(0, slash) === "proxy" && modelId(reference.slice(slash + 1)) ? reference.slice(slash + 1) : null
}
const effortId = (value) => typeof value === "string" && /^[A-Za-z0-9][A-Za-z0-9_.-]{0,63}$/.test(value)
const reasoningEfforts = new Set(["none", "minimal", "low", "medium", "high", "xhigh", "max"])
const positive = (value) => Number.isSafeInteger(value) && value > 0
function modalities(value, field) {
	if (!Array.isArray(value) || !value.length || new Set(value).size !== value.length || value.some((item) => !["text", "image", "audio", "video", "pdf"].includes(item))) fail(field)
}

export function validateDiscovery(value) {
	if (!object(value) || value.discovery_schema_version !== DISCOVERY_SCHEMA_VERSION) throw new Error("managed_discovery_schema_unsupported")
	const ids = value.allowed_model_ids
	if (!Array.isArray(ids) || ids.some((id) => !modelId(id)) || new Set(ids).size !== ids.length) fail("allowed_model_ids")
	if (!object(value.managed_models) || Object.keys(value.managed_models).length !== ids.length || ids.some((id) => !own(value.managed_models, id))) fail("managed_models")
	if (value.default_model_id !== null && (!modelId(value.default_model_id) || !ids.includes(value.default_model_id))) fail("default_model_id")
	const models = Object.create(null)
	for (const id of ids) {
		const item = value.managed_models[id], field = `managed_models[${JSON.stringify(id)}]`
		fields(item, ["name", "capabilities", "limit", "variants"], field)
		if (typeof item.name !== "string" || !item.name.trim() || /[\p{Cc}\p{Cf}]/u.test(item.name)) fail(`${field}.name`)
		fields(item.capabilities, ["tools", "input", "output"], `${field}.capabilities`)
		if (typeof item.capabilities.tools !== "boolean") fail(`${field}.capabilities.tools`)
		for (const key of ["input", "output"]) modalities(item.capabilities[key], `${field}.capabilities.${key}`)
		fields(item.limit, ["context", "input", "output"], `${field}.limit`)
		for (const key of ["context", "input", "output"]) if (!positive(item.limit[key])) fail(`${field}.limit.${key}`)
		if (item.limit.input > item.limit.context - item.limit.output) fail(`${field}.limit.input+output`)
		if (!Array.isArray(item.variants)) fail(`${field}.variants`)
		const variantIds = new Set()
		for (const variant of item.variants) {
			fields(variant, ["id", "settings"], `${field}.variants[]`)
			if (!effortId(variant.id) || variantIds.has(variant.id)) fail(`${field}.variants[].id`)
			variantIds.add(variant.id)
			fields(variant.settings, ["reasoning"], `${field}.variants[].settings`)
			fields(variant.settings.reasoning, ["effort"], `${field}.variants[].settings.reasoning`)
			if (!reasoningEfforts.has(variant.settings.reasoning.effort)) fail(`${field}.variants[].settings.reasoning.effort`)
		}
		models[id] = structuredClone(item)
	}
	// Account/usage fields may evolve, but never enter generated engine configuration or disk.
	return { discovery_schema_version: 2, allowed_model_ids: [...ids], default_model_id: value.default_model_id, managed_models: { ...models } }
}

export function discoveryMaxBytes(value = DEFAULT_DISCOVERY_MAX_BYTES) {
	if (!positive(Number(value))) throw new Error("RUNTIME_MANAGED_DISCOVERY_MAX_BYTES must be a positive safe integer")
	return Number(value)
}
export function normalizeBackendUrl(value) {
	let url
	try { url = new URL(value) } catch { throw new Error("managed_catalog_invalid_backend_url") }
	if (!["http:", "https:"].includes(url.protocol) || url.username || url.password || url.search || url.hash) throw new Error("managed_catalog_invalid_backend_url")
	return url.href.replace(/\/+$/, "")
}
export function catalogIdentity(config) {
	return normalizeIdentity({ backendBaseUrl: config.managedBackendBaseUrl || config.llmProxyUrl, projectId: config.projectId, runtimeGeneration: config.runtimeGeneration ?? null })
}
function normalizeIdentity(value) {
	if (!object(value) || typeof value.projectId !== "string" || !value.projectId || /[\p{Cc}\p{Cf}]/u.test(value.projectId) || value.runtimeGeneration !== null && (typeof value.runtimeGeneration !== "string" || !value.runtimeGeneration || /[\p{Cc}\p{Cf}]/u.test(value.runtimeGeneration))) throw new Error("managed_catalog_invalid_identity")
	return { backendBaseUrl: normalizeBackendUrl(value.backendBaseUrl), projectId: value.projectId, runtimeGeneration: value.runtimeGeneration }
}
const canonical = (value) => JSON.stringify(value, (_key, item) => object(item) ? Object.fromEntries(Object.keys(item).sort().map((key) => [key, item[key]])) : item)
export const catalogDigest = (catalog) => crypto.createHash("sha256").update(canonical({ default_model_id: catalog.default_model_id, managed_models: catalog.managed_models })).digest("hex")
function freeze(value) { if (value && typeof value === "object") { for (const item of Object.values(value)) freeze(item); Object.freeze(value) } return value }
export function createCatalogArtifact(value, identity) {
	const catalog = validateDiscovery(value)
	return freeze({ artifactSchemaVersion: 1, ...normalizeIdentity(identity), discoverySchemaVersion: 2, digest: catalogDigest(catalog), catalog })
}
export function validateCatalogArtifact(value, identity) {
	fields(value, ["artifactSchemaVersion", "backendBaseUrl", "projectId", "runtimeGeneration", "discoverySchemaVersion", "digest", "catalog"], "artifact")
	fields(value.catalog, ["discovery_schema_version", "allowed_model_ids", "default_model_id", "managed_models"], "artifact.catalog")
	if (value.artifactSchemaVersion !== 1 || value.discoverySchemaVersion !== 2) throw new Error("managed_catalog_schema_unsupported")
	const expected = normalizeIdentity(identity), actual = normalizeIdentity(value)
	if (canonical(expected) !== canonical(actual) || value.backendBaseUrl !== actual.backendBaseUrl) throw new Error("managed_catalog_identity_mismatch")
	const validated = createCatalogArtifact(value.catalog, actual)
	if (value.digest !== validated.digest) throw new Error("managed_catalog_digest_mismatch")
	return validated
}
export async function fetchDiscovery(config, { fetchImpl = globalThis.fetch } = {}) {
	const maxBytes = discoveryMaxBytes(config.managedDiscoveryMaxBytes)
	const response = await fetchImpl(normalizeBackendUrl(config.llmProxyUrl) + "/account", { headers: { authorization: `Bearer ${config.llmToken}` }, redirect: "error", credentials: "omit", cache: "no-store", signal: AbortSignal.timeout(3000) })
	if (!response.ok || !response.body) { await response.body?.cancel(); throw new Error("managed_discovery_unavailable") }
	const reader = response.body.getReader(), chunks = []; let size = 0
	try {
		for (;;) { const { done, value } = await reader.read(); if (done) break; size += value.byteLength; if (size > maxBytes) throw new Error("managed_discovery_response_too_large"); chunks.push(value) }
	} finally { await reader.cancel().catch(() => {}) }
	let value
	try { value = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(Buffer.concat(chunks, size))) } catch { throw new Error("managed_discovery_invalid:json") }
	return validateDiscovery(value)
}
export async function readCatalogArtifact(file, identity, { maxBytes = DEFAULT_DISCOVERY_MAX_BYTES } = {}) {
	const handle = await fs.open(file, constants.O_RDONLY | constants.O_NOFOLLOW)
	try {
		const stat = await handle.stat()
		if (!stat.isFile() || stat.size > maxBytes) throw new Error("managed_catalog_invalid_file")
		const bytes = Buffer.alloc(maxBytes + 1), { bytesRead } = await handle.read(bytes, 0, bytes.length, 0)
		if (bytesRead > maxBytes) throw new Error("managed_catalog_invalid_file")
		return validateCatalogArtifact(JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes.subarray(0, bytesRead))), identity)
	} finally { await handle.close() }
}
async function protectedCatalogParent(file) {
	if (process.getuid() !== 0) throw new Error("managed_catalog_parent_not_protected")
	for (let parent = path.dirname(path.resolve(file));; parent = path.dirname(parent)) {
		const stat = await fs.lstat(parent)
		if (!stat.isDirectory() || stat.uid !== 0 || stat.mode & 0o022) throw new Error("managed_catalog_parent_not_protected")
		if (parent === path.dirname(parent)) break
	}
}
export async function publishCatalog(file, value, identity, { protectedParent = false, beforeRename } = {}) {
	const artifact = createCatalogArtifact(value, identity), directory = path.dirname(path.resolve(file))
	if (protectedParent) await protectedCatalogParent(file)
	const temporary = path.join(directory, `.${path.basename(file)}.${crypto.randomUUID()}`)
	try {
		const handle = await fs.open(temporary, "wx", 0o644)
		try { await handle.chmod(0o644); await handle.writeFile(JSON.stringify(artifact) + "\n"); await handle.sync() } finally { await handle.close() }
		await beforeRename?.()
		await fs.rename(temporary, file)
		const parent = await fs.open(directory, constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW)
		try { await parent.sync() } finally { await parent.close() }
	} finally { await fs.unlink(temporary).catch((error) => { if (error.code !== "ENOENT") throw error }) }
	return artifact
}
export function discoveryReason(error) {
	return /^(managed_discovery_|managed_catalog_)/.test(error?.message ?? "") ? error.message : "managed_discovery_unavailable"
}
export async function startupCatalog(config, { fetchImpl, protectedParent = false } = {}) {
	const identity = catalogIdentity(config)
	if (protectedParent) await protectedCatalogParent(config.managedCatalogPath)
	try {
		const value = await fetchDiscovery(config, { fetchImpl })
		const artifact = await publishCatalog(config.managedCatalogPath, value, identity, { protectedParent })
		return { state: "fresh", artifact, reason: null }
	} catch (error) {
		const reason = discoveryReason(error)
		try { return { state: "stale", artifact: await readCatalogArtifact(config.managedCatalogPath, identity, { maxBytes: discoveryMaxBytes(config.managedDiscoveryMaxBytes) + 4096 }), reason } }
		catch { return { state: "unavailable", artifact: null, reason } }
	}
}

// Root startup only. No credentials or account fields are written or printed.
async function cli() {
	try {
		const { loadConfig } = await import("./config.js")
		const config = loadConfig()
		if (process.argv[2] === "read") {
			const artifact = await readCatalogArtifact(config.managedCatalogPath, catalogIdentity(config), { maxBytes: config.managedDiscoveryMaxBytes + 4096 })
			console.log(JSON.stringify(artifact.catalog))
		} else {
			if (process.argv[2] !== "startup" || process.getuid() !== 0) throw new Error("managed_catalog_root_startup_required")
			const result = await startupCatalog(config, { protectedParent: true })
			console.log(JSON.stringify({ state: result.state, schemaVersion: result.artifact?.discoverySchemaVersion ?? null, installedCatalogDigest: result.artifact?.digest ?? null, reason: result.reason }))
		}
	} catch (error) { console.error(discoveryReason(error)); process.exitCode = 1 }
}
if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) void cli()
