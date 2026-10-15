import assert from "node:assert/strict"
import crypto from "node:crypto"
import fs from "node:fs/promises"
import os from "node:os"
import path from "node:path"
import { Readable } from "node:stream"
import { setTimeout as wait } from "node:timers/promises"
import { test } from "node:test"
import { FileMapViews } from "../lib/file-map-views.js"
import { FileError, stableStringify } from "../lib/file-contract.js"
import { WorkspaceFiles } from "../lib/workspace-files.js"

const sha = (bytes) => crypto.createHash("sha256").update(bytes).digest("hex")
const logger = { info() {}, warn() {}, error() {} }
const blank = (identity) => ({ schemaVersion: 1, id: "view-1", title: "Recorded map", workspace: { ...identity }, camera: { crs: "EPSG:3857", center: [12000000, -3000000], zoom: 6, rotation: 0 }, context: "topographic", layers: [], output: { layerIds: [], format: "png" } })
const vectorRecipe = () => ({ prepare: { type: "vector", options: {} }, query: { operation: "preview", displayOptions: { allowApproximate: false } } })
const layer = (manifest, id = "roads") => ({ id, title: "Roads", sources: structuredClone(manifest.inputs.map((i) => i.source)), prepared: { id: manifest.id, kind: "vector" }, locationRecipe: vectorRecipe(), style: { kind: "vector", color: "#336699", width: 2, pointSize: 5 }, visible: true, opacity: 0.8, ownership: "client-owned", credits: ["Client survey"] })
const save = (files, document, operationId = "save", extra = {}) => files.maps.save({ operationId, path: "views/recorded.map.json", mode: "create", document, ...extra })

async function fixture(t) {
	// Real safe-fs, upload receipts, protected captures and retained manifests;
	// the synthetic GIS reader deliberately makes no scientific-placement claim.
	const base = await fs.mkdtemp(path.join(os.homedir(), ".gc-map-view-")), workspaceDir = path.join(base, "project")
	await fs.mkdir(workspaceDir)
	const reader = { calls: 0, availability: { state: "available", build: "synthetic-map-gis/1" }, async init() {}, async read({ members }) {
		this.calls++
		const inputDigests = []
		for (const member of members) inputDigests.push({ name: member.name, sha256: sha(await fs.readFile(`/proc/self/fd/${member.handle.fd}`)) })
		return { schemaVersion: 1, parser: "synthetic-map-gis/1", coverage: "geometry not requested", warnings: [], inputDigests, layers: [{ id: "layer-0", name: "roads", fields: [], crsWkt: null, axisMapping: null, reportedFeatureCount: 1 }] }
	} }
	const config = { workspaceDir, filesStateDir: path.join(base, "state"), filesAgentUids: [20001], filesWorkerUids: [20003], filesWorkbookWorkerEnabled: false, filesGisReader: reader, processingFactory: () => ({ async init() {}, async reconcileOperations() {}, async releaseFailedUpload() {}, async close() {}, async capabilities() { return { enabled: false } }, async drain() { return { complete: true } } }) }
	let files = await WorkspaceFiles.open(config, logger)
	files.maps = new FileMapViews(files)
	t.after(async () => { await files.close(); await fs.rm(base, { recursive: true, force: true }) })
	const sources = []
	for (const extension of ["shp", "shx", "dbf"]) {
		const name = `roads.${extension}`
		await fs.writeFile(path.join(workspaceDir, name), `retained:${name}`)
		sources.push((await files.captures.create({ requestId: `capture-${extension}`, path: name, computeDigest: true })).source)
	}
	const accepted = await files.preparation({ requestId: "prepare", type: "vector", source: sources[0], companions: sources.slice(1) })
	let manifest = accepted.representation
	for (let n = 0; !manifest && n < 300; n++) {
		const job = await files.job(accepted.jobId)
		if (["succeeded", "failed"].includes(job.state)) { assert.equal(job.state, "succeeded", JSON.stringify(job.error)); manifest = job.result.representation }
		else await wait(5)
	}
	assert.ok(manifest, "The synthetic preparation must settle.")
	await Promise.allSettled([...files.gis.pending])
	const document = blank(files.identity)
	document.layers = [layer(manifest), layer(manifest, "roads-second-style")]
	document.layers[1].style.color = "#990033"
	document.output.layerIds = document.layers.map((l) => l.id)
	return { reader, root: workspaceDir, manifest, document, get files() { return files }, async restart() { await files.close(); files = await WorkspaceFiles.open(config, logger); files.maps = new FileMapViews(files) } }
}

test("map view: exact canonical upload bytes, same-source instances and replay survive restart", async (t) => {
	const f = await fixture(t), result = await save(f.files, f.document)
	assert.equal(result.status, 201); assert.equal(result.operation.state, "committed")
	const bytes = await fs.readFile(path.join(f.root, "views/recorded.map.json"))
	assert.equal(bytes.toString(), stableStringify(f.document))
	assert.equal(result.operation.intent.declaredSize, bytes.length)
	assert.equal(result.operation.publishedSource.digest.sha256, sha(bytes))
	const changed = structuredClone(f.document); changed.title = "Altered view"
	assert.equal(Buffer.byteLength(stableStringify(changed)), bytes.length, "The changed-content replay must conflict even when its byte length is unchanged.")
	await assert.rejects(save(f.files, changed), { status: 409, error: "operation_id_reused" })
	assert.equal(result.operation.intent.declaredDigest, sha(bytes))
	await f.restart()
	const loaded = await f.files.maps.load("views/recorded.map.json")
	assert.deepEqual(loaded.document, f.document)
	assert.deepEqual(loaded.layers.map((l) => l.id), ["roads", "roads-second-style"])
	assert.ok(loaded.layers.every((l) => l.prepared.availability === "available"))
	assert.ok(loaded.layers.flatMap((l) => l.sources).every((s) => s.currentRelation === "same-observation"))
	assert.deepEqual(loaded.observation.ref, f.files.ref("views/recorded.map.json"))
	assert.equal((await save(f.files, f.document)).duplicate, true)
	assert.equal(f.reader.calls, 1, "Save/load must never invoke a preparation or GIS query.")
})

test("map view: jittered observation-conditioned writers have exactly one winner per observed base", async (t) => {
	const f = await fixture(t)
	await save(f.files, f.document)
	for (let round = 0; round < 6; round++) {
		const { observation } = await f.files.maps.load("views/recorded.map.json")
		const docs = [0, 1].map((writer) => ({ ...structuredClone(f.document), title: `round-${round}-writer-${writer}` }))
		const attempts = await Promise.allSettled(docs.map(async (document, writer) => { await wait(Math.floor(Math.random() * 8)); return save(f.files, document, `replace-${round}-${writer}`, { mode: "replace", baseObservation: observation }) }))
		assert.equal(attempts.filter((a) => a.status === "fulfilled").length, 1)
		const loser = attempts.find((a) => a.status === "rejected").reason
		assert.equal(loser.status, 409); assert.equal(loser.error, "source_changed")
		const winner = attempts.findIndex((a) => a.status === "fulfilled")
		assert.deepEqual((await f.files.maps.load("views/recorded.map.json")).document, docs[winner])
	}
})

test("map view: changed/missing Current is independent of exact retained-product availability", async (t) => {
	const f = await fixture(t)
	await save(f.files, f.document)
	await fs.writeFile(path.join(f.root, "roads.shp"), "new Current")
	await fs.unlink(path.join(f.root, "roads.dbf"))
	await f.restart()
	const loaded = await f.files.maps.load("views/recorded.map.json"), first = loaded.layers[0]
	assert.deepEqual(first.sources.map((s) => s.currentRelation), ["newer-current", "missing", "same-observation"])
	assert.equal(first.prepared.availability, "available")
	assert.ok(first.recovery.actions.includes("keep-recorded-view"))
	assert.deepEqual(loaded.document, f.document)
	assert.equal(f.reader.calls, 1)
})

test("map view: eviction preserves editable recipe and reports explicit successor recovery without pinning inputs", async (t) => {
	const f = await fixture(t)
	await save(f.files, f.document)
	for (const lease of await f.files.state.list("leases")) await f.files.captures.releaseLease(lease.leaseId)
	f.files.captures.limits.previewIdleMs = 0
	await f.files.captures.sweep()
	assert.ok((await f.files.state.get("workbook-indexes", f.manifest.id)).evictedAt)
	const loaded = await f.files.maps.load("views/recorded.map.json"), first = loaded.layers[0]
	assert.equal(first.prepared.availability, "unavailable")
	assert.ok(first.sources.every((s) => s.captureAvailability === "unavailable" && s.currentRelation === "same-observation"))
	assert.deepEqual(first.recovery.recipe, f.document.layers[0].locationRecipe)
	assert.deepEqual(first.recovery.actions, ["capture-current", "prepare-recorded-recipe", "review-changed-inputs", "save-successor"])
	assert.equal((await save(f.files, loaded.document, "save-unavailable", { path: "unavailable.map.json" })).operation.state, "committed")
	const holds = await f.files.state.list("holds"), ids = f.manifest.inputs.map((i) => i.source.captureId)
	assert.ok(holds.every((h) => !ids.includes(h.source.id)), "Saving a map must not durably hold its scientific inputs.")
	assert.equal(f.reader.calls, 1)
})

test("map view: source identities, verified SHA and ordered complete product inputs cannot be substituted", async (t) => {
	const f = await fixture(t)
	const mutations = [
		(d) => { d.layers[0].sources[0].etag = '"forged"' },
		(d) => { d.layers[0].sources[0].digest.sha256 = "0".repeat(64) },
		(d) => { d.layers[0].sources.reverse() },
		(d) => { d.layers[0].sources.pop() },
		(d) => { d.layers[0].prepared.kind = "raster"; d.layers[0].style = { kind: "raster", band: 1, palette: "grayscale", stretch: { kind: "sample-min-max" } }; d.layers[0].locationRecipe = { prepare: { type: "raster", options: {} }, query: { operation: "map-display", band: 1, displayOptions: {} } } },
	]
	for (const [n, mutate] of mutations.entries()) {
		const document = structuredClone(f.document); mutate(document)
		await assert.rejects(save(f.files, document, `forged-${n}`), { status: 409, error: "map_view_source_mismatch" })
		assert.equal(await f.files.state.get("operations", `forged-${n}`), null)
	}
	// The saved digest can precede hashing; manifest SHA still checks retained evidence.
	const beforeHash = structuredClone(f.document)
	beforeHash.layers[0].sources[0].digest = { state: "not-requested", sha256: null }
	assert.equal((await save(f.files, beforeHash, "before-hash")).operation.state, "committed")
	const edited = structuredClone(f.document); edited.layers[0].sources.reverse()
	await f.files.upload(Readable.from([stableStringify(edited)]), { operationId: "ordinary-edit", path: "views/recorded.map.json", mode: "force-replace" })
	const loaded = await f.files.maps.load("views/recorded.map.json")
	assert.equal(loaded.layers[0].prepared.availability, "unavailable")
	assert.equal(loaded.layers[0].prepared.reason, "map_view_source_mismatch")
	assert.equal(loaded.layers[1].prepared.availability, "available")
})

test("map view: recursively closed syntax, finite values and output eligibility are enforced before effects", async (t) => {
	const f = await fixture(t)
	const mutations = [
		(d) => { d.url = "https://example.com/key" },
		(d) => { d.camera.center[0] = Infinity },
		(d) => { d.camera.zoom = "6" },
		(d) => { d.layers[0].opacity = "0.8" },
		(d) => { d.layers[0].sources[0].ref.url = "https://example.com" },
		(d) => { d.layers[0].sources[0].digest.credentials = { token: "secret" } },
		(d) => { d.layers[0].locationRecipe.query.displayOptions.sourceCrs = { layerId: "layer-0", code: "EPSG:4326", axisOrder: "xy", url: "https://example.com" } },
		(d) => { d.layers[0].style.image = { url: "https://example.com" } },
		(d) => { d.layers[0].visible = 1 },
		(d) => { d.layers[0].ownership = "external" },
		(d) => { d.layers[0].ownership = "unknown" },
		(d) => { d.output.layerIds = ["topographic"] },
		(d) => { d.output.layerIds = ["roads", "roads"] },
		(d) => { d.output.context = "satellite" },
		(d) => { d.layers[1].id = d.layers[0].id },
		(d) => { d.layers[0].title = "x".repeat(257) },
		(d) => { d.layers[0].credits = ["x".repeat(2049)] },
		(d) => { delete d.layers[0].locationRecipe },
		(d) => { d.layers = Array.from({ length: 65 }, (_, n) => ({ ...d.layers[0], id: `layer-${n}` })); d.output.layerIds = [] },
	]
	for (const [n, mutate] of mutations.entries()) {
		const document = structuredClone(f.document); mutate(document)
		await assert.rejects(save(f.files, document, `invalid-${n}`), { status: 400, error: "invalid_map_view" })
		assert.equal(await f.files.state.get("operations", `invalid-${n}`), null)
	}
	await assert.rejects(save(f.files, f.document, "force", { mode: "force-replace" }), { status: 400, error: "invalid_mode" })
	await assert.rejects(save(f.files, f.document, "no-base", { mode: "replace" }), { status: 400, error: "invalid_observation" })
	await assert.rejects(save(f.files, f.document, "wrong-path", { path: "view.json" }), { status: 400, error: "invalid_path" })
})

test("map view: ordinary edits reject invalid JSON/schema, foreign workspace and epoch distinctly", async (t) => {
	const f = await fixture(t), name = "edited.map.json"
	for (const [n, text, expected] of [
		[0, "{", "invalid_map_view"],
		[1, JSON.stringify({ ...blank(f.files.identity), schemaVersion: 2 }), "map_view_schema_unsupported"],
		[2, JSON.stringify({ ...blank(f.files.identity), workspace: { ...f.files.identity, workspaceId: "foreign" } }), "map_view_workspace_mismatch"],
		[3, JSON.stringify({ ...blank(f.files.identity), workspace: { ...f.files.identity, workspaceEpoch: "foreign" } }), "map_view_epoch_mismatch"],
		[4, JSON.stringify({ ...blank(f.files.identity), camera: { crs: "EPSG:3857", center: [0, 0], zoom: null, rotation: 0 } }), "invalid_map_view"],
	]) {
		await f.files.upload(Readable.from([text]), { operationId: `edit-${n}`, path: name, mode: "force-replace" })
		await assert.rejects(f.files.maps.load(name), { error: expected })
	}
	const foreignSource = structuredClone(f.document); foreignSource.layers[0].sources[0].ref.workspaceEpoch = "foreign"
	await assert.rejects(save(f.files, foreignSource, "foreign-source"), { error: "map_view_epoch_mismatch" })
})

test("map view: bounded complete safe live reads reject oversize, changed, non-UTF8 and symlink files", async (t) => {
	const f = await fixture(t), name = "large.map.json"
	await fs.writeFile(path.join(f.root, name), " ".repeat(65537))
	await assert.rejects(f.files.maps.load(name), { status: 413, error: "map_view_limit" })
	const huge = structuredClone(f.document)
	huge.layers[0].credits = Array.from({ length: 32 }, () => "x".repeat(2048))
	await assert.rejects(save(f.files, huge, "large-save"), { status: 413, error: "map_view_limit" })
	const nearLimit = structuredClone(f.document)
	nearLimit.layers[0].credits = []
	while (Buffer.byteLength(stableStringify(nearLimit)) < 65520) {
		nearLimit.layers[0].credits.push("")
		const remaining = 65520 - Buffer.byteLength(stableStringify(nearLimit))
		nearLimit.layers[0].credits[nearLimit.layers[0].credits.length - 1] = "x".repeat(Math.min(2048, remaining))
	}
	assert.equal(Buffer.byteLength(stableStringify(nearLimit)), 65520)
	assert.ok(nearLimit.layers[0].credits.length <= 32)
	await assert.rejects(save(f.files, nearLimit, "large-envelope"), { status: 413, error: "map_view_limit" })
	await save(f.files, f.document)
	const original = f.files.captures.readPrefix.bind(f.files.captures)
	f.files.captures.readPrefix = async (...args) => { const bytes = await original(...args); await fs.writeFile(path.join(f.root, "views/recorded.map.json"), "{}"); return bytes }
	await assert.rejects(f.files.maps.load("views/recorded.map.json"), { status: 409, error: "map_view_changing" })
	f.files.captures.readPrefix = original
	await fs.writeFile(path.join(f.root, "bad-utf8.map.json"), Buffer.from([0xff]))
	await assert.rejects(f.files.maps.load("bad-utf8.map.json"), { error: "invalid_map_view" })
	await fs.symlink(path.join(f.root, name), path.join(f.root, "link.map.json"))
	await assert.rejects(f.files.maps.load("link.map.json"), { status: 400, error: "invalid_path" })
})

test("map view: pending and indeterminate saves retain ordinary operation inspection semantics", async (t) => {
	const f = await fixture(t)
	let entered, release
	const started = new Promise((resolve) => { entered = resolve }), gate = new Promise((resolve) => { release = resolve })
	f.files.config.filesCheckpoint = async (stage, op) => { if (op.operationId === "pending" && stage === "streaming") { entered(); await gate } }
	const pending = save(f.files, f.document, "pending")
	await started
	try { const duplicate = await save(f.files, f.document, "pending"); assert.equal(duplicate.status, 202); assert.equal(duplicate.operation.state, "streaming"); assert.equal(duplicate.duplicate, true) }
	finally { release() }
	assert.equal((await pending).operation.state, "committed")
	f.files.config.filesCheckpoint = async (stage, op) => { if (op.operationId === "uncertain" && stage === "published") throw Object.assign(new Error("Injected acknowledgement loss"), { code: "EIO" }) }
	await assert.rejects(save(f.files, f.document, "uncertain", { path: "uncertain.map.json" }), { status: 503, error: "operation_indeterminate", operationId: "uncertain" })
	const duplicate = await save(f.files, f.document, "uncertain", { path: "uncertain.map.json" })
	assert.equal(duplicate.status, 202); assert.equal(duplicate.operation.state, "indeterminate")
	assert.equal(duplicate.operation.reconciliation.required, true)
	assert.equal(duplicate.operation.reconciliation.replayAllowed, false)
	assert.deepEqual((await f.files.maps.load("uncertain.map.json")).document, f.document)
})

test("map view: absent capture metadata gives unknown Current and independent layer recovery", async (t) => {
	const f = await fixture(t), document = structuredClone(f.document)
	document.layers[0].sources = [structuredClone(document.layers[0].sources[0])]
	document.layers[0].sources[0].captureId = crypto.randomUUID()
	document.layers[0].sources[0].etag = '"unknown-capture"'
	document.layers[0].prepared.id = crypto.randomUUID()
	await save(f.files, document)
	const loaded = await f.files.maps.load("views/recorded.map.json")
	assert.equal(loaded.layers[0].sources[0].currentRelation, "unknown")
	assert.equal(loaded.layers[0].prepared.availability, "unavailable")
	assert.equal(loaded.layers[1].prepared.availability, "available")
	assert.equal(f.reader.calls, 1)
})

test("map view: an invalid retained product is unavailable per layer and never damages the ordinary document", async (t) => {
	const f = await fixture(t)
	await save(f.files, f.document)
	f.files.representation = async () => { throw new FileError(422, "invalid_gis_result", "Invalid retained product metadata.") }
	const loaded = await f.files.maps.load("views/recorded.map.json")
	assert.deepEqual(loaded.document, f.document)
	assert.ok(loaded.layers.every((l) => l.prepared.availability === "unavailable" && l.prepared.reason === "invalid_gis_result"))
	assert.ok(loaded.layers.every((l) => l.sources.every((s) => s.captureAvailability === "available")))
	assert.equal((await save(f.files, loaded.document, "save-invalid-product", { path: "still-editable.map.json" })).operation.state, "committed")
})

test("map view: retained bytes without a recorded source observation cannot claim that Current is newer", async (t) => {
	const f = await fixture(t), source = f.document.layers[0].sources[0]
	const record = await f.files.state.get("captures", source.captureId)
	await f.files.state.put("captures", source.captureId, { ...record, sourceObservation: null })
	await save(f.files, f.document)
	const loaded = await f.files.maps.load("views/recorded.map.json")
	assert.equal(loaded.layers[0].sources[0].currentRelation, "unknown")
	assert.equal(loaded.layers[0].sources[0].captureAvailability, "available")
	assert.equal(loaded.layers[0].prepared.availability, "available")
})

async function publishSynthetic(f, kind, names, options = {}) {
	const sources = []
	for (const name of names) {
		await fs.writeFile(path.join(f.root, name), `synthetic:${name}`)
		sources.push((await f.files.captures.create({ requestId: `capture-${name}`, path: name, computeDigest: true })).source)
	}
	const id = crypto.randomUUID(), reservationId = `synthetic-${id}`, createdAt = new Date().toISOString()
	const manifest = { ...f.manifest, id, kind, source: sources[0], inputs: sources.map((source) => ({ name: source.ref.path, source, sha256: source.digest.sha256 })), options, provider: { id: kind, build: "synthetic-map-gis/1" }, metadata: kind === "raster" ? { bandCount: 1 } : { recipe: options } }
	const bytes = Buffer.from(JSON.stringify(manifest)), stage = await f.files.captures.staging(id)
	try {
		await f.files.captures.write(stage.handle, bytes, 0)
		await f.files.captures.withRetention(() => f.files.captures.reserveIndex({ id: reservationId, representationId: id, sizeBytes: bytes.length * 2, createdAt }))
		await f.files.captures.publish(stage, { id, kind: "index", source: manifest.source, dependencies: sources.map((s) => ({ kind: "capture", id: s.captureId })), manifest, metadataBytes: bytes.length, reservationId, sizeBytes: bytes.length, createdAt, lastAccessAt: createdAt })
	} finally { await f.files.captures.cleanup(stage) }
	return manifest
}

const assayStyle = () => ({ kind: "assay", scale: "log", breaks: [0.1, 1], colors: ["#336699", "#669933", "#cc3300"], symbol: "circle", size: 7, unit: "ppm", belowDetectionColor: "#aaaaaa", missingColor: "#eeeeee", invalidColor: "#ff00ff" })
const surfaceOptions = () => ({ mode: "surface", columns: { id: "ID", x: "X", y: "Y", analyte: "Au", qualifier: "Q" }, sourceCrs: { code: "EPSG:4326", axisOrder: "xy" }, unit: { name: "ppm", basis: "user-assigned" }, numbers: { missingTokens: ["", "NA"], sentinels: [-999] }, allowApproximate: false })
test("map view: assay surface/collar and raster recipes retain exact units/policies without nested free-form fields", async (t) => {
	const f = await fixture(t), surface = surfaceOptions()
	const collar = { ...structuredClone(surface), mode: "collar-summary", columns: { hole: "Hole", from: "From", to: "To", analyte: "Au" }, collars: { member: "Collars.tsv", columns: { hole: "Hole", x: "X", y: "Y" } }, depthUnit: "m", depthWindow: { kind: "whole-hole" } }
	const products = [await publishSynthetic(f, "assay", ["Samples.csv"], surface), await publishSynthetic(f, "assay", ["Assays.csv", "Collars.tsv"], collar), await publishSynthetic(f, "raster", ["magnetics.tif"])]
	// These products exercise the saved-recipe contract, not native assay/raster
	// qualification. Keep actual capture/index availability behind this adapter.
	const representation = f.files.representation.bind(f.files)
	f.files.representation = async (id) => {
		const product = products.find((p) => p.id === id)
		if (!product) return representation(id)
		const opened = await f.files.captures.open("index", id)
		try { return product } finally { await opened.release() }
	}
	const document = structuredClone(f.document)
	for (const [n, product] of products.entries()) {
		const saved = { ...layer(product, `product-${n}`), prepared: { id: product.id, kind: product.kind }, locationRecipe: { prepare: { type: product.kind, options: product.options }, query: product.kind === "assay" ? { operation: "preview" } : { operation: "map-display", band: 1, displayOptions: { sourceCrs: { code: "EPSG:4326", axisOrder: "xy" }, allowApproximate: false } } }, style: product.kind === "assay" ? assayStyle() : { kind: "raster", band: 1, palette: "grayscale", stretch: { kind: "sample-min-max" } } }
		if (n === 1) { saved.ownership = "external"; saved.style.symbol = "diamond" }
		document.layers.push(saved)
	}
	document.output.layerIds.push("product-0", "product-2"); document.output.format = "pdf"
	await save(f.files, document)
	const loaded = await f.files.maps.load("views/recorded.map.json")
	assert.deepEqual(loaded.document, document)
	assert.ok(loaded.layers.every((l) => l.prepared.availability === "available"))
	for (const [n, mutate] of [
		(d) => { d.layers[2].style.unit = "g/t" },
		(d) => { d.layers[2].style.breaks = [0, 1] },
		(d) => { d.layers[2].style.breaks = [1, 0.1] },
		(d) => { d.layers[2].style.colors.pop() },
		(d) => { d.layers[2].locationRecipe.prepare.options.columns.x = d.layers[2].locationRecipe.prepare.options.columns.y },
		(d) => { d.layers[2].locationRecipe.prepare.options.unit = { name: "ppm", basis: "user-assigned", url: "https://example.com" } },
		(d) => { d.layers[3].locationRecipe.prepare.options.depthUnit = "ft" },
		(d) => { d.layers[3].locationRecipe.prepare.options.depthWindow = { kind: "range", from: 50, to: 50 } },
		(d) => { d.layers[4].locationRecipe.query.displayOptions.sourceCrs.url = "https://example.com" },
		(d) => { d.layers[4].style.band = "1" },
		(d) => { d.layers[4].style.band = 2 },
	].entries()) { const edited = structuredClone(document); mutate(edited); await assert.rejects(save(f.files, edited, `recipe-invalid-${n}`), { error: "invalid_map_view" }) }
	const reinterpreted = structuredClone(document)
	reinterpreted.layers[2].locationRecipe.prepare.options.unit.name = "g/t"; reinterpreted.layers[2].style.unit = "g/t"
	await assert.rejects(save(f.files, reinterpreted, "different-unit"), { status: 409, error: "map_view_source_mismatch" })
	await fs.unlink(path.join(f.files.captures.blobDir, `index.${products[0].id}`))
	const unavailable = await f.files.maps.load("views/recorded.map.json")
	assert.equal(unavailable.layers[2].prepared.availability, "unavailable")
	assert.deepEqual(unavailable.layers[2].recovery.recipe.prepare.options, surface)
	assert.equal(unavailable.layers[3].prepared.availability, "available")
	assert.equal(f.reader.calls, 1)
})
