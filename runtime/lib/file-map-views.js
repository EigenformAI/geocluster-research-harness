import crypto from "node:crypto"
import path from "node:path"
import { Readable } from "node:stream"
import { FileError, canonicalPath, capturedSourceIdentity, fileError, identifier, observation, observationToken, stableStringify } from "./file-contract.js"

const MAX_BYTES = 64 * 1024
const MAX_LAYERS = 64
const MAX_SOURCES = 32
const sha256 = /^[0-9a-f]{64}$/
const failure = (status, error, message, details = {}) => new FileError(status, error, message, { agent: "file-service", tool: "file-map-views", action: "Inspect the map document and current file observation, then save with a new operation ID if needed.", ...details })
const invalid = (name) => failure(400, "invalid_map_view", `${name} does not match the closed map-view schema.`)
const mismatch = () => failure(409, "map_view_source_mismatch", "The recorded layer does not match its exact retained source identities, ordered input SHA-256 evidence, kind or preparation recipe.")
const sameSource = (a, b) => Boolean(a && b && stableStringify(capturedSourceIdentity(a)) === stableStringify(capturedSourceIdentity(b)))
const sameDigest = (source, digest) => source.digest.state !== "ready" || !digest || source.digest.sha256 === digest
const unavailable = (error) => [403, 404, 410, 422, 503].includes(error?.status)
const missing = (error) => error?.code === "ENOENT" || error?.error === "not_found"
const reason = (error) => error?.error || fileError(error, "file-map-views").error

function object(value, keys, name, required = keys) {
	if (!value || typeof value !== "object" || Array.isArray(value) || ![Object.prototype, null].includes(Object.getPrototypeOf(value)) || Object.getOwnPropertySymbols(value).length) throw invalid(name)
	const fields = Object.getOwnPropertyDescriptors(value)
	if (Object.keys(fields).some((key) => !keys.includes(key) || !fields[key].enumerable || !Object.hasOwn(fields[key], "value")) || required.some((key) => !Object.hasOwn(fields, key))) throw invalid(name)
}
function text(value, name, max = 256, min = 1) {
	if (typeof value !== "string" || value.length > max * 2 || [...value].length > max || [...value].length < min || /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/u.test(value)) throw invalid(name)
}
function providerText(value, name, max, empty = false) {
	text(value, name, max, empty ? 0 : 1)
	if (Buffer.byteLength(value) > max || /[\ud800-\udfff]/u.test(value)) throw invalid(name)
}
function list(value, name, max, min = 0) {
	if (!Array.isArray(value) || Object.getPrototypeOf(value) !== Array.prototype || value.length < min || value.length > max || Object.keys(value).length !== value.length || Object.getOwnPropertySymbols(value).length) throw invalid(name)
	for (let n = 0; n < value.length; n++) if (!Object.hasOwn(value, n) || !Object.hasOwn(Object.getOwnPropertyDescriptor(value, String(n)), "value")) throw invalid(name)
}
function choice(value, values, name) { if (!values.includes(value)) throw invalid(name) }
function number(value, name, min = -Infinity, max = Infinity) { if (!Number.isFinite(value) || value < min || value > max) throw invalid(name) }
function integer(value, name, min = 0, max = Number.MAX_SAFE_INTEGER) { if (!Number.isSafeInteger(value) || value < min || value > max) throw invalid(name) }
function boolean(value, name) { if (typeof value !== "boolean") throw invalid(name) }
function id(value, name) { text(value, name, 128); identifier(value, name) }
function color(value, name) { if (typeof value !== "string" || !/^#[0-9a-fA-F]{6}$/.test(value)) throw invalid(name) }
function filePath(value) { text(value, "path", 2048); return canonicalPath(value, { root: false }) }
function mapPath(value) { const name = filePath(value); if (!name.endsWith(".map.json")) throw failure(400, "invalid_path", "Map views use a canonical relative .map.json file path."); return name }

function workspaceRef(value, identity, withPath = false) {
	object(value, ["workspaceId", "workspaceEpoch", ...(withPath ? ["path"] : [])], "workspace reference")
	text(value.workspaceId, "workspaceId"); text(value.workspaceEpoch, "workspaceEpoch")
	if (value.workspaceId !== identity.workspaceId) throw failure(409, "map_view_workspace_mismatch", "The map document belongs to a different workspace.")
	if (value.workspaceEpoch !== identity.workspaceEpoch) throw failure(409, "map_view_epoch_mismatch", "The map document belongs to a different workspace epoch.")
	if (withPath) filePath(value.path)
}
function sourceRef(value, identity) {
	object(value, ["kind", "ref", "captureId", "etag", "sizeBytes", "consistency", "digest"], "captured source")
	choice(value.kind, ["runtime-capture"], "source kind"); workspaceRef(value.ref, identity, true); id(value.captureId, "captureId")
	text(value.etag, "source ETag")
	if (!/^"[\x21\x23-\x7e]+"$/.test(value.etag)) throw invalid("strong source ETag")
	integer(value.sizeBytes, "sizeBytes")
	choice(value.consistency, ["service-published", "remote-conditional", "atomic-clone", "checked-copy"], "source consistency")
	object(value.digest, ["state", "sha256"], "source digest")
	choice(value.digest.state, ["not-requested", "pending", "ready", "failed"], "digest state")
	if (value.digest.state === "ready" ? typeof value.digest.sha256 !== "string" || !sha256.test(value.digest.sha256) : value.digest.sha256 !== null) throw invalid("source SHA-256")
}
function sourceCrs(value, vector = false) {
	object(value, ["code", "axisOrder", ...(vector ? ["layerId"] : [])], "source CRS")
	if (typeof value.code !== "string" || !/^(?:EPSG:[1-9][0-9]{0,6}|OGC:CRS84)$/.test(value.code)) throw invalid("source CRS code")
	choice(value.axisOrder, ["xy", "yx"], "source axis order")
	if (vector) text(value.layerId, "source layerId")
}
function displayOptions(value, vector = false) {
	object(value, ["environmentFingerprint", "allowApproximate", "sourceCrs"], "display options", [])
	if (Object.hasOwn(value, "environmentFingerprint")) text(value.environmentFingerprint, "environment fingerprint", 256, 0)
	if (Object.hasOwn(value, "allowApproximate")) boolean(value.allowApproximate, "allowApproximate")
	if (Object.hasOwn(value, "sourceCrs")) sourceCrs(value.sourceCrs, vector)
}

// Store fully specified assay defaults from manifest.options, rather than allow
// a later provider version to reinterpret omitted number/operation policies.
function assayOptions(value) {
	const shared = ["mode", "columns", "sourceCrs", "unit", "numbers", "allowApproximate", "environmentFingerprint"]
	const collar = value?.mode === "collar-summary"
	object(value, [...shared, ...(collar ? ["collars", "depthUnit", "depthWindow"] : [])], "assay options", [...shared.filter((k) => k !== "environmentFingerprint"), ...(collar ? ["collars", "depthUnit", "depthWindow"] : [])])
	choice(value.mode, ["surface", "collar-summary"], "assay mode")
	const columns = collar ? ["hole", "from", "to", "analyte", "qualifier"] : ["id", "x", "y", "analyte", "qualifier"]
	object(value.columns, columns, "assay columns", columns.filter((k) => k !== "qualifier"))
	for (const column of Object.values(value.columns)) providerText(column, "assay column", 256)
	if (new Set(Object.values(value.columns)).size !== Object.keys(value.columns).length) throw invalid("distinct assay columns")
	sourceCrs(value.sourceCrs)
	object(value.unit, ["name", "basis"], "assay unit"); providerText(value.unit.name, "unit name", 128); choice(value.unit.basis, ["source-declared", "user-assigned"], "unit basis")
	object(value.numbers, ["missingTokens", "sentinels"], "assay number policy")
	list(value.numbers.missingTokens, "missing tokens", 32); list(value.numbers.sentinels, "sentinels", 32)
	for (const token of value.numbers.missingTokens) providerText(token, "missing token", 128, true)
	for (const sentinel of value.numbers.sentinels) number(sentinel, "numerical sentinel")
	boolean(value.allowApproximate, "allowApproximate")
	if (Object.hasOwn(value, "environmentFingerprint")) providerText(value.environmentFingerprint, "environment fingerprint", 256)
	if (collar) {
		object(value.collars, ["member", "columns"], "collar options"); text(value.collars.member, "collar member", 128)
		if (!/^[A-Za-z0-9][A-Za-z0-9_. -]{0,127}$/.test(value.collars.member) || value.collars.member.includes("..") || value.collars.member.endsWith(" ")) throw invalid("collar member")
		object(value.collars.columns, ["hole", "x", "y"], "collar columns")
		for (const column of Object.values(value.collars.columns)) providerText(column, "collar column", 256)
		if (new Set(Object.values(value.collars.columns)).size !== 3) throw invalid("distinct collar columns")
		choice(value.depthUnit, ["m"], "depth unit")
		const range = value.depthWindow?.kind === "range"
		object(value.depthWindow, range ? ["kind", "from", "to"] : ["kind"], "depth window")
		choice(value.depthWindow.kind, ["whole-hole", "range"], "depth window kind")
		if (range) { number(value.depthWindow.from, "window from", 0); number(value.depthWindow.to, "window to", 0); if (value.depthWindow.from >= value.depthWindow.to) throw invalid("half-open depth window") }
	}
}
function recipe(value, kind) {
	object(value, ["prepare", "query"], "location recipe")
	object(value.prepare, ["type", "options"], "preparation recipe")
	choice(value.prepare.type, [kind], "preparation type")
	if (kind === "assay") assayOptions(value.prepare.options)
	else object(value.prepare.options, [], "preparation options")
	const query = value.query
	if (kind === "assay") { object(query, ["operation"], "assay query"); choice(query.operation, ["preview"], "assay query operation") }
	else {
		object(query, ["operation", ...(kind === "raster" ? ["band"] : []), "displayOptions"], "display query", ["operation", ...(kind === "raster" ? ["band"] : [])])
		choice(query.operation, [kind === "raster" ? "map-display" : "preview"], "display query operation")
		if (kind === "raster") integer(query.band, "raster band", 1, 32)
		if (Object.hasOwn(query, "displayOptions")) displayOptions(query.displayOptions, kind === "vector")
	}
}
function style(value, kind) {
	if (kind === "vector") {
		object(value, ["kind", "color", "width", "pointSize"], "vector style")
		color(value.color, "vector color"); number(value.width, "stroke width", 0, 64); number(value.pointSize, "point size", 1, 64)
	} else if (kind === "raster") {
		object(value, ["kind", "band", "palette", "stretch"], "raster style")
		integer(value.band, "raster band", 1, 32); choice(value.palette, ["grayscale", "viridis", "magma"], "raster palette")
		object(value.stretch, ["kind"], "raster stretch"); choice(value.stretch.kind, ["sample-min-max"], "raster stretch kind")
	} else {
		object(value, ["kind", "scale", "breaks", "colors", "symbol", "size", "unit", "belowDetectionColor", "missingColor", "invalidColor"], "assay style")
		choice(value.scale, ["linear", "log"], "assay scale"); list(value.breaks, "class breaks", 32); list(value.colors, "class colors", 33, 1)
		for (const [n, point] of value.breaks.entries()) { number(point, "class break"); if (n && point <= value.breaks[n - 1] || value.scale === "log" && point <= 0) throw invalid("ordered class breaks/log scale") }
		if (value.colors.length !== value.breaks.length + 1) throw invalid("class colors")
		for (const key of ["belowDetectionColor", "missingColor", "invalidColor"]) color(value[key], key)
		for (const entry of value.colors) color(entry, "class color")
		choice(value.symbol, ["circle", "diamond"], "assay symbol"); number(value.size, "symbol size", 1, 64); text(value.unit, "style unit")
	}
	choice(value.kind, [kind], "style kind")
}
function documentSchema(value, identity) {
	object(value, ["schemaVersion", "id", "title", "workspace", "camera", "context", "layers", "output"], "map document")
	if (value.schemaVersion !== 1) throw failure(400, "map_view_schema_unsupported", "Only map-view schemaVersion 1 is supported.")
	id(value.id, "document id"); text(value.title, "map title"); workspaceRef(value.workspace, identity)
	object(value.camera, ["crs", "center", "zoom", "rotation"], "camera")
	choice(value.camera.crs, ["EPSG:3857"], "camera CRS"); list(value.camera.center, "camera center", 2, 2)
	value.camera.center.forEach((n) => number(n, "camera coordinate")); number(value.camera.zoom, "camera zoom"); number(value.camera.rotation, "camera rotation")
	choice(value.context, ["off", "topographic", "satellite"], "hosted context")
	list(value.layers, "layers", MAX_LAYERS)
	const ids = new Set()
	for (const layer of value.layers) {
		object(layer, ["id", "title", "sources", "prepared", "locationRecipe", "style", "visible", "opacity", "ownership", "credits"], "layer")
		id(layer.id, "layer id"); text(layer.title, "layer title"); if (ids.has(layer.id)) throw invalid("unique layer IDs"); ids.add(layer.id)
		list(layer.sources, "captured sources", MAX_SOURCES, 1)
		for (const source of layer.sources) sourceRef(source, identity)
		if (new Set(layer.sources.map((s) => s.captureId)).size !== layer.sources.length) throw invalid("unique captured members")
		object(layer.prepared, ["id", "kind"], "prepared reference"); id(layer.prepared.id, "representation id"); choice(layer.prepared.kind, ["vector", "raster", "assay"], "prepared kind")
		recipe(layer.locationRecipe, layer.prepared.kind); style(layer.style, layer.prepared.kind)
		if (layer.prepared.kind === "assay") {
			const options = layer.locationRecipe.prepare.options
			if (layer.style.unit !== options.unit.name || layer.sources.length !== (options.mode === "surface" ? 1 : 2) || options.collars && path.posix.basename(layer.sources[1].ref.path) !== options.collars.member) throw invalid("assay source members and recorded units")
		}
		if (layer.prepared.kind === "raster" && layer.style.band !== layer.locationRecipe.query.band) throw invalid("raster display band")
		boolean(layer.visible, "layer visibility"); number(layer.opacity, "layer opacity", 0, 1); choice(layer.ownership, ["client-owned", "external", "unknown"], "declared ownership")
		list(layer.credits, "credits", 32); layer.credits.forEach((c) => text(c, "credit", 2048, 0))
	}
	object(value.output, ["layerIds", "format"], "output")
	choice(value.output.format, ["png", "pdf"], "output format"); list(value.output.layerIds, "output layer IDs", MAX_LAYERS)
	const selected = new Set()
	for (const selectedId of value.output.layerIds) {
		id(selectedId, "output layer id")
		if (selected.has(selectedId) || !value.layers.some((l) => l.id === selectedId && l.ownership === "client-owned")) throw invalid("unique client-owned output selection")
		selected.add(selectedId)
	}
}
function bounded(bytes) { if (bytes.length > MAX_BYTES) throw failure(413, "map_view_limit", "Map-view documents and save requests must fit within 64 KiB.", { limits: { mapViewBytes: MAX_BYTES } }) }
function parse(bytes, identity) {
	bounded(bytes)
	let value
	try { value = JSON.parse(new TextDecoder("utf-8", { fatal: true, ignoreBOM: true }).decode(bytes)) }
	catch { throw invalid("complete UTF-8 JSON document") }
	documentSchema(value, identity)
	return value
}

/** Ordinary, editable map files; referenced products retain their existing bounded lifecycle. */
export class FileMapViews {
	constructor(workspace) { this.workspace = workspace }
	descriptor() { return { id: "map-view", schemaVersion: 1, extension: ".map.json", operations: ["save", "load"], modes: ["create", "replace"], limits: { requestBytes: MAX_BYTES, documentBytes: MAX_BYTES, layers: MAX_LAYERS, sourcesPerLayer: MAX_SOURCES, textCodePoints: 256, creditCodePoints: 2048 }, layerOrder: "index-zero-top", retention: "bounded-input-captures", outputOwnership: "client-owned" } }
	async save(input, publicationGuard) {
		object(input, ["operationId", "path", "mode", "baseObservation", "document"], "save request", ["operationId", "path", "mode", "document"])
		id(input.operationId, "operationId"); const name = mapPath(input.path)
		if (!["create", "replace"].includes(input.mode)) throw failure(400, "invalid_mode", "Map-view saves support create or observation-conditioned replace.")
		if (input.mode === "replace") {
			const base = input.baseObservation
			if (typeof base === "string") text(base, "base observation token")
			else if (base && typeof base === "object") {
				object(base, ["ref", "token", "observedAt", "sizeBytes"], "base observation")
				workspaceRef(base.ref, this.workspace.identity, true); text(base.token, "base observation token"); text(base.observedAt, "observation timestamp"); integer(base.sizeBytes, "observation size")
				if (!Number.isFinite(Date.parse(base.observedAt)) || base.ref.path !== name) throw failure(400, "invalid_observation", "baseObservation must describe the map file address.")
			} else throw failure(400, "invalid_observation", "Conditional map replacement needs baseObservation.")
		} else if (Object.hasOwn(input, "baseObservation")) throw failure(400, "invalid_observation", "baseObservation applies only to replacement.")
		documentSchema(input.document, this.workspace.identity)
		// Canonicalize once, then validate and upload this exact immutable buffer.
		const bytes = Buffer.from(stableStringify(input.document)), document = parse(bytes, this.workspace.identity)
		const envelope = { operationId: input.operationId, path: name, mode: input.mode, ...(input.mode === "replace" ? { baseObservation: structuredClone(input.baseObservation) } : {}) }
		bounded({ length: Buffer.byteLength(stableStringify({ ...envelope, document: null })) - 4 + bytes.length })
		await this.reconcile(document, true)
		return this.workspace.upload(Readable.from([bytes]), { ...envelope, declaredSize: bytes.length, declaredDigest: crypto.createHash("sha256").update(bytes).digest("hex"), ...(publicationGuard ? { publicationGuard } : {}) })
	}
	async load(inputPath) {
		const name = mapPath(inputPath)
		let opened
		try {
			opened = await this.workspace.openLive(name)
			if (!opened.stat.isFile()) throw failure(400, "invalid_path", "Map views must be regular workspace files.")
			const size = Number(opened.stat.size)
			if (!Number.isSafeInteger(size) || size < 0) throw failure(413, "map_view_limit", "The map file exceeds its supported size.")
			bounded({ length: size })
			const bytes = await this.workspace.captures.readPrefix(opened.handle, size)
			const current = await opened.handle.stat({ bigint: true })
			let named
			try { named = await this.workspace.safeFs.stat(name) } catch (error) { if (!missing(error)) throw error }
			if (bytes.length !== size || !named || observationToken(current) !== opened.observation.token || observationToken(named) !== opened.observation.token) throw failure(409, "map_view_changing", "The map file changed during its complete read. Read the current file again.")
			const document = parse(bytes, this.workspace.identity)
			return { ref: this.workspace.ref(name), path: name, observation: opened.observation, document, layers: await this.reconcile(document), retention: "bounded-input-captures" }
		} catch (error) { throw fileError(error, "file-map-views.load") }
		finally { await opened?.handle.close() }
	}
	async sourceState(source, saving) {
		try {
			const metadata = await this.workspace.captures.get("capture", source.captureId)
			if (!sameSource(source, metadata.source) || !sameDigest(source, metadata.source.digest.state === "ready" ? metadata.source.digest.sha256 : null)) throw mismatch()
			let currentRelation = ["same-observation", "newer-current", "missing"].includes(metadata.currentRelation) ? metadata.currentRelation : "unknown"
			if (currentRelation === "newer-current" && !(await this.workspace.state.get("captures", source.captureId))?.sourceObservation?.token) currentRelation = "unknown"
			return { source, captureAvailability: "available", currentRelation, currentObservation: metadata.currentObservation || null, ...(metadata.currentError ? { reason: metadata.currentError.error } : {}) }
		} catch (error) {
			if (error.error === "map_view_source_mismatch" && saving) throw error
			if (!unavailable(error) && error.error !== "map_view_source_mismatch") throw error
			const record = await this.workspace.state.get("captures", source.captureId)
			let currentRelation = "unknown", currentObservation = null
			// Tombstoned capture metadata can still establish a Current relation. A
			// pathname alone cannot: without recorded observation evidence it is unknown.
			if (record && sameSource(source, record.source) && sameDigest(source, record.source.digest.state === "ready" ? record.source.digest.sha256 : null)) {
				try {
					const stat = await this.workspace.safeFs.stat(source.ref.path)
					if (stat.isFile()) { currentObservation = observation(source.ref, stat); if (record.sourceObservation?.token) currentRelation = record.sourceObservation.token === currentObservation.token ? "same-observation" : "newer-current" }
				} catch (currentError) { if (missing(currentError)) currentRelation = "missing" }
			}
			return { source, captureAvailability: "unavailable", currentRelation, currentObservation, reason: reason(error) }
		}
	}
	checkProduct(layer, manifest) {
		if (manifest.id !== layer.prepared.id || manifest.kind !== layer.prepared.kind || !sameSource(manifest.source, layer.sources[0]) || !Array.isArray(manifest.inputs) || manifest.inputs.length !== layer.sources.length) throw mismatch()
		for (const [n, input] of manifest.inputs.entries()) if (!sameSource(layer.sources[n], input.source) || typeof input.sha256 !== "string" || !sha256.test(input.sha256) || !sameDigest(layer.sources[n], input.sha256) || !sameDigest(input.source, input.sha256)) throw mismatch()
		if (stableStringify(manifest.options || {}) !== stableStringify(layer.locationRecipe.prepare.options)) throw mismatch()
		const query = layer.locationRecipe.query
		if (layer.prepared.kind === "vector" && query.displayOptions?.sourceCrs && !manifest.metadata?.layers?.some((l) => l.id === query.displayOptions.sourceCrs.layerId)) throw mismatch()
		if (layer.prepared.kind === "raster" && (!Number.isSafeInteger(manifest.metadata?.bandCount) || query.band > manifest.metadata.bandCount)) throw mismatch()
	}
	async reconcile(document, saving = false) {
		const layers = [], sourceCache = new Map(), productCache = new Map()
		for (const layer of document.layers) {
			const sources = []
			for (const source of layer.sources) {
				const key = stableStringify(source)
				if (!sourceCache.has(key)) sourceCache.set(key, await this.sourceState(source, saving))
				sources.push(sourceCache.get(key))
			}
			let prepared = { ...layer.prepared, availability: "available" }
			try {
				if (!productCache.has(layer.prepared.id)) {
					try { productCache.set(layer.prepared.id, { manifest: await this.workspace.representation(layer.prepared.id) }) }
					catch (error) { productCache.set(layer.prepared.id, { error }) }
				}
				const result = productCache.get(layer.prepared.id)
				if (result.error) throw result.error
				this.checkProduct(layer, result.manifest)
				if (sources.some((s) => s.reason === "map_view_source_mismatch")) throw mismatch()
			} catch (error) {
				if (error.error === "map_view_source_mismatch" && saving) throw error
				if (!unavailable(error) && error.error !== "map_view_source_mismatch" && error.error !== "representation_kind" && error.error !== "source_changed") throw error
				prepared = { ...layer.prepared, availability: "unavailable", reason: reason(error) }
			}
			const available = prepared.availability === "available", missingCurrent = sources.some((s) => s.currentRelation === "missing")
			layers.push({ id: layer.id, sources, prepared, recovery: { state: available ? "recorded-product-available" : "rebuild-required", actions: available ? ["keep-recorded-view", ...(missingCurrent ? ["locate-or-replace-sources"] : []), ...(sources.some((s) => s.currentRelation !== "same-observation") ? ["capture-current", "prepare-recorded-recipe", "review-changed-inputs", "save-successor"] : [])] : [...(missingCurrent ? ["locate-or-replace-sources"] : []), "capture-current", "prepare-recorded-recipe", "review-changed-inputs", "save-successor"], recipe: layer.locationRecipe } })
		}
		return layers
	}
}
