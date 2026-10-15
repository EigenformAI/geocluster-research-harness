import assert from "node:assert/strict"
import crypto from "node:crypto"
import fs from "node:fs/promises"
import os from "node:os"
import path from "node:path"
import { test } from "node:test"
import { setTimeout as wait } from "node:timers/promises"
import { WorkspaceFiles } from "../lib/workspace-files.js"
import { FileError, stableStringify } from "../lib/file-contract.js"
import Database from "better-sqlite3"
import { createFilesServer } from "../files-server.js"
import gate from "../gate.cjs"
import http from "node:http"
import { spawn } from "node:child_process"
import { FileIndex } from "../lib/file-index.js"
import { DEMO_MEMBERS } from "../lib/owned-demo.js"

const sha = (b) => crypto.createHash("sha256").update(b).digest("hex")
const logger = { info() {}, warn() {}, error() {} }
const digestOf = (members) => sha(stableStringify(members))
async function until(check) { const end = Date.now() + 5000; while (!check()) { if (Date.now() >= end) throw new Error("lifecycle observation did not settle"); await wait(2) } }
async function fixture(t, { logger: log = logger } = {}) {
	const base = await fs.mkdtemp(path.join(os.homedir(), ".gc-owned-demo-")), workspaceDir = path.join(base, "project"), bundleDir = path.join(base, "bundle")
	await fs.mkdir(workspaceDir); await fs.mkdir(bundleDir)
	const contents = { "README.md": "Owned training files\n", "assays/surface_samples.csv": "id,x,y,Au\na,10,30,2\n", "drilling/collars.csv": "id,x,y\nA,10,30\n", "drilling/assays.csv": "id,from,to,Au\nA,0,10,2\n", "gis/training_area.geojson": '{"type":"FeatureCollection","features":[]}', "examples/copper_summary.md": "Cu example\n", "LICENSE.txt": "Test fixture only\n" }
	contents["examples/copper_by_sample_type.csv"] = "type,Cu\nrock,2\n"
	const memberHashes = Object.fromEntries(Object.entries(contents).map(([name, bytes]) => [name, sha(bytes)]))
	contents["provenance/manifest.json"] = JSON.stringify({ templateId: "wattle-creek", version: 1, memberHashes })
	memberHashes["provenance/manifest.json"] = sha(contents["provenance/manifest.json"])
	for (const [name, bytes] of Object.entries(contents)) { await fs.mkdir(path.dirname(path.join(bundleDir, name)), { recursive: true }); await fs.writeFile(path.join(bundleDir, name), bytes) }
	// Portable recipe has paths, no donor workspace/capture/product identifiers.
	const style = { kind: "assay", scale: "linear", breaks: [0.1, 1], colors: ["#eeeeee", "#ffcc00", "#cc0000"], symbol: "circle", size: 5, unit: "ppm", belowDetectionColor: "#aaaaaa", missingColor: "#dddddd", invalidColor: "#ff00ff" }
	const shared = { sourceCrs: { code: "OGC:CRS84", axisOrder: "xy" }, unit: { name: "ppm", basis: "source-declared" } }
	const layer = (id, paths, options) => ({ id, title: id, paths, locationRecipe: { prepare: { type: "assay", options }, query: { operation: "preview" } }, style, visible: true, opacity: 1, ownership: "client-owned", credits: [] })
	const recipe = { schemaVersion: 1, id: "overview", title: "Wattle Creek overview", camera: { crs: "EPSG:3857", center: [0, 0], zoom: 6, rotation: 0 }, context: "off", layers: [layer("surface-au", ["assays/surface_samples.csv"], { ...shared, mode: "surface", columns: { id: "id", x: "x", y: "y", analyte: "Au" } }), layer("collar-au", ["drilling/assays.csv", "drilling/collars.csv"], { ...shared, mode: "collar-summary", columns: { hole: "id", from: "from", to: "to", analyte: "Au" }, collars: { member: "collars.csv", columns: { hole: "id", x: "x", y: "y" } }, depthUnit: "m" }), { id: "training-outline", title: "Training outline", paths: ["gis/training_area.geojson"], locationRecipe: { prepare: { type: "vector", options: {} }, query: { operation: "preview", displayOptions: { allowApproximate: false } } }, style: { kind: "vector", color: "#336699", width: 2, pointSize: 5 }, visible: true, opacity: 1, ownership: "client-owned", credits: [] }], output: { layerIds: ["surface-au", "collar-au", "training-outline"], format: "png" } }
	await fs.writeFile(path.join(bundleDir, "overview.recipe.json"), JSON.stringify(recipe))
	memberHashes["overview.recipe.json"] = sha(JSON.stringify(recipe))
	let demo = { assignmentId: crypto.randomUUID(), projectId: "project", origin: "initial-demo", assignmentState: "assigned", attempt: { startedAt: new Date().toISOString(), deadlineAt: new Date(Date.now() + 600000).toISOString(), failedAt: null }, initialReadyAt: null, template: { id: "wattle-creek", version: 1, seed: 20261008, bundleSha256: digestOf(memberHashes) }, filesState: "pending", mapState: "pending", memberHashes: {}, retryRevision: 0 }
	const checkpoints = [], permits = [], replay = new Map(), admitted = new Map()
	const adapter = {
		ownerRuntimeId: "runtime", ownerFenced: false,
		bind(w) { this.workspace = w },
		async demoStatus() {
			const current = Object.fromEntries(["files", "map"].map((stage) => [stage, structuredClone(permits.findLast((p) => p.stage === stage) || null)]))
			const failed = demo.filesState === "failed" || demo.mapState === "failed" || demo.attempt.failedAt || Date.parse(demo.attempt.deadlineAt) <= Date.now(), unresolved = Object.values(current).some((p) => p?.state === "granted")
			return { demo: { ...structuredClone(demo), initialPreparationState: demo.initialReadyAt ? "ready" : failed ? "failed" : demo.paused ? "paused" : "preparing", retry: { action: failed && !unresolved ? "retry-setup" : "none" } }, permits: current }
		},
		async demoPermit(requestId, stage) {
			if (demo.attempt.failedAt || Date.parse(demo.attempt.deadlineAt) <= Date.now()) throw new FileError(409, "demo_attempt_expired", "Attempt expired.")
			if (this.ownerRuntimeId !== "runtime" && !this.ownerFenced) throw new FileError(409, "owner_reconciliation_required", "The prior owner lacks fence evidence.")
			if (admitted.has(requestId)) return admitted.get(requestId)
			const permit = { permitId: crypto.randomUUID(), operationId: `${stage}-${demo.retryRevision}`, stage, runtimeId: this.ownerRuntimeId, ...this.workspace.identity, retryRevision: demo.retryRevision, deadlineAt: demo.attempt.deadlineAt, state: "granted" }
			admitted.set(requestId, permit); permits.push(permit); return permit
		},
		async demoCheckpoint(body) {
			if (body.outcome === "map-ready" && body.mode !== "settlement" && (Object.keys(demo.memberHashes).length !== 9 || stableStringify(body.memberHashes) !== stableStringify(demo.memberHashes))) throw new FileError(422, "invalid_demo_evidence", "Map publication and validation require all nine exact top-level seed hashes.")
			const old = replay.get(body.requestId)
			if (old) assert.deepEqual(old, body)
			else {
				const permit = permits.find((p) => p.permitId === body.permitId)
				const success = body.outcome === `${permit.stage}-ready`
				// Opt-in backend rule (owned_demo.py checkpoint): a new request needs a granted permit, except an exact ready settlement.
				if (this.strict && permit.state !== "granted" && !(body.mode === "settlement" && permit.state === "completed" && success)) throw new FileError(409, "stale_demo_permit", "The permit is no longer granted.")
				replay.set(body.requestId, structuredClone(body)); checkpoints.push(body)
				if (success) {
					if (body.mode !== "validation") {
						if (permit.stage === "files") { demo.filesState = "ready"; demo.memberHashes = body.memberHashes }
						else demo.mapState = "ready"
					}
					permit.state = "completed"
				} else { demo[`${permit.stage}State`] = body.outcome; permit.state = body.outcome === "failed" ? "failed" : "conflict"; if (this.strict) demo.attempt.failedAt ||= new Date().toISOString() }
			}
			if (this.loseResponse === body.outcome) { this.loseResponse = null; throw new Error("injected response lost after commit") }
			return { demo: (await this.demoStatus()).demo, readinessAccepted: ["files-ready", "map-ready"].includes(body.outcome) && body.mode !== "settlement" && !demo.attempt.failedAt && Date.parse(demo.attempt.deadlineAt) > Date.now() }
		},
	}
	const reader = { calls: 0, availability: { state: "available", build: "injected-owned-demo/1" }, async init() {}, async read({ members, operation, kind, options }) {
		if (operation === "manifest") { this.calls++; await this.beforeRead?.() }
		const inputDigests = []; for (const m of members) inputDigests.push({ name: m.name, sha256: sha(await fs.readFile(`/proc/self/fd/${m.handle.fd}`)) })
		const envelope = { parser: "injected-owned-demo/1", coverage: "lifecycle fixture", warnings: [], inputDigests }
		if (kind === "assay") {
			const surface = options.mode === "surface", memberName = members[0].name, locator = `${memberName}:2`, collar = !surface && { memberName: members[1].name, recordOrdinal: 2, locator: `${members[1].name}:2`, id: "A", raw: { hole: "A", x: "10", y: "30" }, duplicate: false, geometry: { type: "Point", coordinates: [10, 30] } }
			const row = { memberName, recordOrdinal: 2, locator, id: surface ? "a" : "A", raw: surface ? { id: "a", x: "10", y: "30", analyte: "2", qualifier: "" } : { hole: "A", from: "0", to: "10", analyte: "2", qualifier: "" }, value: { state: "detected", value: 2, qualifier: null }, joinState: surface ? "surface" : "matched", depth: surface ? null : { from: 0, to: 10, valid: true, inWindow: true } }
			const origin = surface ? row : collar, point = { memberName: origin.memberName, recordOrdinal: 2, locator: origin.locator, id: origin.id, geometry: { type: "Point", coordinates: [10, 30] }, value: row.value, locationMeaning: surface ? "surface-sample" : "collar-summary", rowLocators: [locator], maximumLocators: [locator] }
			const counts = Object.fromEntries(["dataRows", "collarRows", "points", "mapped", "unmapped", "detected", "censored", "missing", "invalid", "duplicateCollarIds", "duplicateCollarRows", "unmatchedRows", "ambiguousRows", "invalidDepthRows", "outsideWindowRows", "invalidCoordinateRows", "missingIdRows"].map((k) => [k, 0])); Object.assign(counts, { dataRows: 1, collarRows: surface ? 0 : 1, points: 1, mapped: 1, detected: 1 })
			return { ...envelope, parser: "bounded-gdal-assay-v1", schemaVersion: 1, kind, recipe: options, unit: options.unit, summaryRule: surface ? "source-value" : "maximum-detected", operationFingerprint: sha("fixture"), tables: members.map((m, n) => ({ memberName: m.name, format: "csv", dataRows: 1, columns: Object.values(n ? options.collars.columns : options.columns) })), rows: [row], collarRows: surface ? [] : [collar], points: [point], diagnostics: [], counts, placement: { state: "ready", displayCrs: "OGC:CRS84", displayByLocator: { [point.locator]: point.geometry }, extent: [10, 30, 10, 30], environmentFingerprint: "fixture", reasons: [], sourceFrame: { basis: "user-assumed", wkt: "CRS84", dataAxisMapping: [1, 2], units: "degree" }, operation: { engine: "fixture", policy: "strict", identity: null, accuracy: null }, coverage: { sourceFeatures: 1, retainedDrawable: 1, nullOrEmpty: 0, decodeOmitted: 0, displayed: 1 } }, limits: { inputBytes: 1024, rowsPerTable: 10, points: 10, columns: 10, cellBytes: 100, manifestBytes: 65536, responseBytes: 65536, timeoutMs: 1000 } }
		}
		if (operation === "manifest") return { ...envelope, schemaVersion: 1, layers: [{ id: "layer-0", name: "outline", fields: [], crsWkt: null, axisMapping: null, reportedFeatureCount: 0 }] }
		return { ...envelope, schemaVersion: 3, displayOptions: { allowApproximate: false }, layers: [{ id: "layer-0", name: "outline", features: [], fields: [], geometryTypes: [], extent: null, positionCount: 0, coordinateLabel: "lifecycle fixture", crsDeclarations: [], plotWarning: null, placement: { state: "ready", displayCrs: "OGC:CRS84", displayByLocator: {}, extent: null, environmentFingerprint: "fixture", reasons: [], sourceFrame: { basis: "format-convention", wkt: null, dataAxisMapping: null, units: "degree" }, operation: null, coverage: { sourceFeatures: 0, retainedDrawable: 0, nullOrEmpty: 0, decodeOmitted: 0, displayed: 0 } } }] }
	} }
	const config = { projectId: "project", machineId: "runtime", workspaceDir, filesStateDir: path.join(base, "state"), filesAgentUids: [20001], filesWorkerUids: [20003], filesWorkbookWorkerEnabled: false, filesGisReader: reader, ownedDemo: { enabled: true, bundleDir, adapter, memberHashes }, processingFactory: () => ({ async init() {}, async reconcileOperations() {}, async releaseFailedUpload() {}, async close() {}, async drain() { return { complete: true } }, async capabilities() { return { enabled: false } } }) }
	let files; const deferred = []
	t.after(async () => { for (const app of deferred) await app.shutdown(new Date(Date.now() + 5000).toISOString()); await files?.close(); await fs.rm(base, { recursive: true, force: true }) })
	return { config, base, root: workspaceDir, bundleDir, memberHashes, contents, reader, adapter, permits, checkpoints, get demo() { return demo }, set demo(v) { demo = v }, get files() { return files }, async open() { files = await WorkspaceFiles.open(config, log); return files }, async deferredServer() { const app = await createFilesServer({ config, secret: "a".repeat(64), logger, deferWorkspace: true }); deferred.push(app); return app }, async openServer() { const app = await createFilesServer({ config, secret: "a".repeat(64), logger }); files = app.files.workspace; return app }, async restart() { await files.close(); return this.open() }, async settle() { await files.demo.runOnce(); await Promise.allSettled([...files.gis.pending]); return adapter.demoStatus() } }
}

test("owned demo: first authorized start publishes verified root files before ordinary indexing; restart never restores user deletions", async (t) => {
	const f = await fixture(t); await f.open()
	assert.equal(await fs.readFile(path.join(f.root, "README.md"), "utf8"), f.contents["README.md"])
	assert.equal((await f.files.stat("drilling/assays.csv")).type, "file")
	assert.equal(f.demo.filesState, "ready")
	assert.deepEqual(f.demo.memberHashes, Object.fromEntries(Object.entries(f.memberHashes).filter(([p]) => p !== "overview.recipe.json")))
	await f.settle(); assert.equal(f.demo.mapState, "ready", JSON.stringify(f.checkpoints))
	f.demo.initialReadyAt = new Date().toISOString()
	await fs.rm(path.join(f.root, "README.md")); await f.restart(); await f.settle()
	await assert.rejects(fs.stat(path.join(f.root, "README.md")), { code: "ENOENT" })
	assert.equal(f.permits.filter((p) => p.stage === "files").length, 1)
})

test("owned demo: corrupted staged bundle publishes no partial editable files", async (t) => {
	const f = await fixture(t); await fs.writeFile(path.join(f.bundleDir, "drilling/assays.csv"), "corrupt")
	await assert.rejects(f.open(), { error: "demo_bundle_mismatch" })
	assert.deepEqual(await fs.readdir(f.root), [])
})

test("owned demo: preparation failure stays explicitly retryable across visits; current-source edits terminate retry without overwrite", async (t) => {
	const f = await fixture(t); f.reader.beforeRead = async () => { throw new Error("injected reader failure") }
	await f.open(); await f.settle(); assert.equal(f.demo.mapState, "failed")
	const calls = f.reader.calls; await f.restart(); await f.settle(); assert.equal(f.reader.calls, calls)
	await fs.writeFile(path.join(f.root, "gis/training_area.geojson"), "user edit")
	f.demo.retryRevision++; f.demo.mapState = "pending"; f.reader.beforeRead = null
	await f.settle(); assert.equal(f.demo.mapState, "source-conflict")
	await assert.rejects(fs.stat(path.join(f.root, "maps/overview.map.json")), { code: "ENOENT" })
	assert.equal(await fs.readFile(path.join(f.root, "gis/training_area.geojson"), "utf8"), "user edit")
})

test("owned demo: jittered retries converge on three native products and one create-only save; completed sample edits survive reopen", async (t) => {
	const f = await fixture(t); f.reader.beforeRead = () => wait(Math.floor(Math.random() * 15))
	await f.open()
	for (let round = 0; round < 8; round++) await Promise.all(Array.from({ length: 24 }, async () => { await wait(Math.floor(Math.random() * 20)); await f.files.demo.runOnce() }))
	assert.equal(f.reader.calls, 3); assert.equal(f.checkpoints.filter((c) => c.outcome === "map-ready").length, 1)
	const loaded = await f.files.mapViewLoad("maps/overview.map.json")
	assert.deepEqual(loaded.document.workspace, f.files.identity); assert.equal(loaded.layers[0].prepared.availability, "available")
	assert.equal(loaded.document.layers[2].sources[0].digest.sha256, f.memberHashes["gis/training_area.geojson"])
	f.demo.initialReadyAt = new Date().toISOString()
	await fs.writeFile(path.join(f.root, "maps/overview.map.json"), "user's edited map")
	await f.restart(); await f.settle()
	assert.equal(await fs.readFile(path.join(f.root, "maps/overview.map.json"), "utf8"), "user's edited map")
})

test("owned demo: root admission closure during an in-flight reader prevents later map publication", async (t) => {
	const f = await fixture(t); let release, started
	const entered = new Promise((r) => { started = r }), blocked = new Promise((r) => { release = r })
	f.reader.beforeRead = async () => { started(); await blocked }
	await f.open(); await entered
	// Same flag closed by root's /internal/files/drain admissionOnly channel.
	f.files.draining = true; release(); await assert.rejects(f.settle(), { error: "draining" })
	await assert.rejects(fs.stat(path.join(f.root, "maps/overview.map.json")), { code: "ENOENT" })
	assert.equal(f.demo.mapState, "pending"); assert.equal(f.files.demo.record.mapFailureRevision, undefined)
	assert.equal(await fs.readFile(path.join(f.root, "README.md"), "utf8"), f.contents["README.md"])
})

test("owned demo: source and destination changes during preparation cannot be overwritten", async (t) => {
	for (const change of ["source", "destination"]) {
		await t.test(change, async (t) => {
			const f = await fixture(t)
			f.reader.beforeRead = async () => { if (change === "source") await fs.writeFile(path.join(f.root, "gis/training_area.geojson"), "user source"); else { await fs.mkdir(path.join(f.root, "maps")); await fs.writeFile(path.join(f.root, "maps/overview.map.json"), "user destination") } }
			await f.open(); await f.settle()
			assert.equal(f.demo.mapState, `${change}-conflict`)
			if (change === "source") await assert.rejects(fs.stat(path.join(f.root, "maps/overview.map.json")), { code: "ENOENT" })
			else assert.equal(await fs.readFile(path.join(f.root, "maps/overview.map.json"), "utf8"), "user destination")
			const calls = f.reader.calls; await f.restart(); await f.settle(); assert.equal(f.reader.calls, calls)
		})
	}
})

test("owned demo: files checkpoint lost after backend commit reconciles exact receipt and never reseeds an emptied project", async (t) => {
	const f = await fixture(t); f.adapter.loseResponse = "files-ready"
	await assert.rejects(f.open(), /injected response lost/)
	assert.equal(f.demo.filesState, "ready")
	for (const name of await fs.readdir(f.root)) await fs.rm(path.join(f.root, name), { recursive: true, force: true })
	await f.open(); await f.settle()
	assert.deepEqual(await fs.readdir(f.root), []); assert.equal(f.demo.mapState, "source-conflict")
	assert.equal(f.permits.filter((p) => p.stage === "files").length, 1)
})

test("owned demo: epoch replacement rejects old preparation completion and leaves initial setup unavailable without reseeding", async (t) => {
	const f = await fixture(t); let entered, release
	const started = new Promise((r) => { entered = r }), blocked = new Promise((r) => { release = r })
	f.reader.beforeRead = async () => { entered(); await blocked }
	await f.open(); await started
	const oldIdentity = f.files.identity
	f.files.identity = { ...oldIdentity, workspaceEpoch: crypto.randomUUID() }; release(); await assert.rejects(f.settle(), { error: "demo_owner_fenced" })
	await assert.rejects(fs.stat(path.join(f.root, "maps/overview.map.json")), { code: "ENOENT" })
	assert.equal(f.checkpoints.some((c) => c.outcome === "map-ready"), false)
	// Replacement of FileState preserves the independent publication receipt.
	await f.files.close(); const db = new Database(path.join(f.base, "state/files.sqlite"))
	const epoch = crypto.randomUUID(); db.prepare("UPDATE identity SET workspace_epoch=?").run(epoch); db.close()
	f.reader.beforeRead = null; f.demo.retryRevision++; f.demo.mapState = "pending"
	await f.open(); await assert.rejects(f.settle(), { error: "demo_publication_missing" })
	assert.equal(f.demo.mapState, "pending", JSON.stringify(f.checkpoints))
	await assert.rejects(fs.stat(path.join(f.root, "maps/overview.map.json")), { code: "ENOENT" })
	assert.equal(f.permits.filter((p) => p.stage === "files").length, 1)
})

test("owned demo: lost map checkpoint response preserves later edits but cannot release initial access from old evidence", async (t) => {
	const f = await fixture(t); f.adapter.loseResponse = "map-ready"
	await f.open(); await assert.rejects(f.settle(), /injected response lost/)
	await fs.writeFile(path.join(f.root, "maps/overview.map.json"), "edited after publication")
	await f.restart(); await assert.rejects(f.settle(), { error: "source-conflict" })
	assert.equal(await fs.readFile(path.join(f.root, "maps/overview.map.json"), "utf8"), "edited after publication")
	assert.equal(f.reader.calls, 3); assert.equal(f.checkpoints.filter((c) => c.outcome === "map-ready").length, 1)
	assert.equal(f.files.demo.bootstrap(), undefined)
})

test("review checkpoint gap: closure after local map-ready retains publication but fresh validation refuses the edited map", async (t) => {
	for (const receipt of ["durable-intent", "publication-only"]) await t.test(receipt, async (t) => {
		const f = await fixture(t), processing = f.config.processingFactory
		f.config.processingFactory = (workspace) => {
			const persist = workspace.demo.persist.bind(workspace.demo)
			workspace.demo.persist = (fields) => { persist(fields); if (fields.mapOutcome === "map-ready") workspace.startup.closeAdmission() }
			return processing()
		}
		await f.open(); await until(() => f.files.startup.closed)
		await f.files.demo.inflight?.catch((error) => assert.equal(error.error, "draining"))
		assert.equal(f.demo.mapState, "pending"); assert.equal(f.checkpoints.filter((c) => c.outcome === "map-ready").length, 0)
		const intent = structuredClone(f.files.demo.record.pendingCheckpoint)
		assert.equal(intent?.outcome, "map-ready", "Closed admission must retain exact local intent without dispatching it.")
		const published = structuredClone(f.files.demo.record.map), original = await f.files.mapViewLoad(published.path), inode = (await fs.stat(path.join(f.root, published.path))).ino
		const edited = { ...original.document, title: "My retained map edits" }
		await fs.writeFile(path.join(f.root, published.path), stableStringify(edited))
		if (receipt === "publication-only") f.files.demo.persist({ pendingCheckpoint: null }) // A process can stop before creating checkpoint intent.
		f.config.processingFactory = processing
		await f.restart(); await assert.rejects(f.settle(), { error: "source-conflict" })
		assert.equal(f.demo.mapState, receipt === "durable-intent" ? "ready" : "pending", "Only an already-retained report can replay the historical milestone.")
		assert.deepEqual((await f.files.mapViewLoad(published.path)).document, edited)
		assert.equal((await fs.stat(path.join(f.root, published.path))).ino, inode)
		assert.equal(f.reader.calls, 3, "Reconciliation must not prepare or publish another map.")
		assert.equal(f.checkpoints.filter((c) => c.outcome === "map-ready").length, receipt === "durable-intent" ? 1 : 0)
		assert.equal(f.files.demo.bootstrap(), undefined)
		if (receipt === "durable-intent") assert.deepEqual(f.checkpoints.find((c) => c.outcome === "map-ready"), intent)
	})
})

test("review checkpoint gap: a retained map-ready intent cannot bypass a same-owner deletion fence", async (t) => {
	const f = await fixture(t), processing = f.config.processingFactory
	f.config.processingFactory = (workspace) => {
		const persist = workspace.demo.persist.bind(workspace.demo)
		workspace.demo.persist = (fields) => { persist(fields); if (fields.mapOutcome === "map-ready") workspace.startup.closeAdmission("runtime") }
		return processing()
	}
	await f.open(); await until(() => f.files.startup.closed); await f.files.demo.inflight?.catch((error) => assert.equal(error.error, "draining"))
	assert.equal(f.files.demo.record.pendingCheckpoint?.outcome, "map-ready"); assert.equal(f.checkpoints.filter((c) => c.outcome === "map-ready").length, 0)
	f.config.processingFactory = processing
	await f.restart()
	try { await f.settle() } catch (error) { assert.equal(error.error, "demo_owner_fenced") }
	assert.equal(f.checkpoints.filter((c) => c.outcome === "map-ready").length, 0)
	assert.equal(f.demo.mapState, "pending"); assert.equal(f.files.startup.authorityLost, true)
})

test("owned demo: explicitly revised backend retry resumes failed preparation; status reads never execute work", async (t) => {
	const f = await fixture(t); f.reader.beforeRead = () => { throw new Error("reader unavailable") }
	await f.open(); await f.settle(); assert.equal(f.demo.mapState, "failed")
	const calls = f.reader.calls
	for (let n = 0; n < 20; n++) await f.files.demo.status()
	assert.equal(f.reader.calls, calls)
	f.demo.retryRevision++; f.demo.mapState = "pending"; f.reader.beforeRead = null
	await f.settle(); assert.equal(f.demo.mapState, "ready"); assert.equal(f.reader.calls, calls + 3)
})

test("owned demo: an independent local publication receipt vetoes reseeding even if backend files observation is stale", async (t) => {
	const f = await fixture(t); await f.open(); await f.settle(); await f.files.close()
	for (const name of await fs.readdir(f.root)) await fs.rm(path.join(f.root, name), { recursive: true, force: true })
	// Simulates loss of FileState's epoch-scoped rows, without destroying independent setup metadata.
	await fs.rm(path.join(f.base, "state/files.sqlite")); f.demo.filesState = "pending"; f.demo.mapState = "pending"
	await assert.rejects(f.open(), { error: "demo_owner_fenced" })
	assert.deepEqual(await fs.readdir(f.root), [])
	assert.equal(f.permits.filter((p) => p.stage === "files").length, 1)
})

test("owned demo: a second daemon cannot materialize or publish using the same admitted operation", async (t) => {
	const f = await fixture(t); await f.open(); await f.settle()
	await assert.rejects(WorkspaceFiles.open(f.config, logger), { error: "demo_setup_in_progress" })
	assert.equal(f.reader.calls, 3); assert.equal(f.checkpoints.filter((c) => c.outcome === "files-ready").length, 1)
})

test("owned demo: a failing map checkpoint transport cannot hide published files on restart", async (t) => {
	const f = await fixture(t), checkpoint = f.adapter.demoCheckpoint.bind(f.adapter)
	f.adapter.demoCheckpoint = async (body) => { if (body.outcome === "map-ready") throw new Error("checkpoint transport offline"); return checkpoint(body) }
	await f.open(); await assert.rejects(f.settle(), /checkpoint transport offline/)
	await f.restart()
	assert.equal(await fs.readFile(path.join(f.root, "README.md"), "utf8"), f.contents["README.md"])
	assert.equal((await f.files.stat("maps/overview.map.json")).type, "file")
	await assert.rejects(f.settle(), /checkpoint transport offline/)
	assert.equal(f.reader.calls, 3)
})

test("owned demo: startup interruption before/within installation keeps no ordinary access and resumes only the unpublished file set", async (t) => {
	for (const point of ["staged", "installed-member", "published"]) await t.test(point, async (t) => {
		const f = await fixture(t); let once = true
		f.config.ownedDemo.installCheckpoint = async (stage) => { if (once && stage === point) { once = false; throw new Error("startup interrupted") } }
		await assert.rejects(f.open(), /startup interrupted/)
		assert.equal(f.demo.filesState, "pending"); assert.equal(f.checkpoints.length, 0)
		if (point !== "published") assert.deepEqual(await fs.readdir(f.root), point === "staged" ? [] : ["README.md"])
		await f.open(); await f.settle(); assert.equal(f.demo.filesState, "ready"); assert.equal(f.demo.mapState, "ready")
		assert.equal(f.permits.filter((p) => p.stage === "files").length, 1)
	})
})

test("owned demo: actual root drain channel fences a map upload already staged before create-only rename", async (t) => {
	const f = await fixture(t); let entered, release
	const started = new Promise((r) => { entered = r }), blocked = new Promise((r) => { release = r })
	f.config.controlSecret = "c".repeat(64)
	f.config.filesCheckpoint = async (stage, operation) => { if (stage === "staged" && operation.intent.path === "maps/overview.map.json") { entered(); await blocked } }
	const app = await f.openServer()
	await new Promise((r) => app.server.listen(0, "127.0.0.1", r))
	t.after(async () => { app.server.closeAllConnections(); await new Promise((r) => app.server.close(r)) })
	await started
	const response = await fetch(`http://127.0.0.1:${app.server.address().port}/internal/files/drain`, { method: "POST", headers: { "x-gc-files-control": f.config.controlSecret, "content-type": "application/json" }, body: JSON.stringify({ admissionOnly: true, deadline: new Date(Date.now() + 5000).toISOString() }) })
	assert.equal(response.status, 200); assert.equal((await response.json()).admittingMutations, false)
	release(); await assert.rejects(f.settle(), { error: "draining" })
	await assert.rejects(fs.stat(path.join(f.root, "maps/overview.map.json")), { code: "ENOENT" })
	const saved = await f.files.state.get("operations", f.files.demo.record.mapSaveOperationId)
	assert.equal(saved.state, "failed"); assert.equal(saved.error.error, "draining")
	assert.equal(f.demo.mapState, "pending", "The closed checkpoint gate cannot dispatch a failure while deletion holds the backend lock.")
})

test("early deletion HTTP: root drain waits for the paused install critical section and prohibits every later seed link/checkpoint", async (t) => {
	const f = await fixture(t); let entered, release, app, rootGate
	const paused = new Promise((r) => { entered = r }), blocked = new Promise((r) => { release = r })
	f.config.controlSecret = "c".repeat(64)
	f.config.ownedDemo.installCheckpoint = async (stage, name) => { if (stage === "before-link" && name === "README.md") { entered(); await blocked } }
	t.after(async () => { release(); rootGate?.closeAllConnections(); await new Promise((r) => rootGate ? rootGate.close(r) : r()); await app?.shutdown(new Date(Date.now() + 5000).toISOString()) })
	app = await createFilesServer({ config: f.config, secret: "a".repeat(64), logger, deferWorkspace: true })
	await new Promise((r) => app.server.listen(0, "127.0.0.1", r))
	const base = `http://127.0.0.1:${app.server.address().port}`
	assert.equal((await fetch(`${base}/files/info`, { headers: { "x-gc-gate": "a".repeat(64) } })).status, 503, "Ordinary files must be unavailable before deferred initialization.")
	const keyFile = path.join(f.base, "key"), controlFile = path.join(f.base, "files-control")
	await fs.writeFile(keyFile, "e".repeat(64), { mode: 0o600 }); await fs.writeFile(controlFile, f.config.controlSecret, { mode: 0o600 })
	rootGate = gate.createGateServer({ ...gate.loadConfig({ PROJECT_ID: "project", FLY_MACHINE_ID: "runtime" }), keyFile, filesControlFile: controlFile, filesPort: app.server.address().port }, { logger: { log() {}, error() {}, warn() {} } })
	await new Promise((r) => rootGate.listen(0, "127.0.0.1", r))
	const initialization = app.initialize(); initialization.catch(() => {})
	await paused
	const rootBase = `http://127.0.0.1:${rootGate.address().port}`, headers = { "x-ide-proxy-key": "e".repeat(64), "x-gc-project-id": "project", "x-gc-machine-id": "runtime", "content-type": "application/json" }
	const body = JSON.stringify({ admissionOnly: true, runtimeId: "runtime", deadline: new Date(Date.now() + 5000).toISOString() })
	for (const rejected of [{ "x-ide-proxy-key": "wrong" }, { cookie: "browser-cookie" }, { origin: "https://geocluster.net" }, { "x-ide-proxy-key": undefined }]) {
		const supplied = { ...headers, ...rejected }; if (!supplied["x-ide-proxy-key"]) delete supplied["x-ide-proxy-key"]
		assert.equal((await fetch(`${rootBase}/internal/files/drain`, { method: "POST", headers: supplied, body })).status, 404)
	}
	assert.equal((await fetch(`${rootBase}/internal/files/drain`, { method: "POST", headers: { ...headers, "x-gc-machine-id": "another-machine" }, body })).status, 409)
	assert.equal((await fetch(`${rootBase}/internal/files/drain`, { method: "POST", headers, body: JSON.stringify({ admissionOnly: true, runtimeId: "another-owner", deadline: new Date(Date.now() + 5000).toISOString() }) })).status, 409)
	assert.equal((await fetch(`${rootBase}/internal/files/drain?extra=1`, { method: "POST", headers, body })).status, 404)
	assert.equal(app.startup.closed, false, "Rejected root authority must not close admission or publish a fence.")
	let acknowledged = false
	const request = fetch(`http://127.0.0.1:${rootGate.address().port}/internal/files/drain`, { method: "POST", headers: { "x-ide-proxy-key": "e".repeat(64), "x-gc-project-id": "project", "x-gc-machine-id": "runtime", "content-type": "application/json" }, body: JSON.stringify({ admissionOnly: true, runtimeId: "runtime", deadline: new Date(Date.now() + 5000).toISOString() }) }).then(async (r) => { const body = await r.json(); acknowledged = true; return { status: r.status, body } })
	await until(() => app.startup.closed); await wait(20); assert.equal(acknowledged, false, "The acknowledgement must wait for the active namespace critical section.")
	release()
	const result = await request
	assert.equal(result.status, 200); assert.equal(result.body.publicationFenced, true); assert.equal(result.body.admittingMutations, false)
	await assert.rejects(initialization, { error: "draining" })
	const atFence = await fs.readdir(f.root)
	assert.deepEqual(atFence, ["README.md"])
	await wait(30); assert.deepEqual(await fs.readdir(f.root), atFence)
	assert.equal(f.checkpoints.length, 0, "Lifecycle closure must not dispatch setup checkpoints while backend deletion holds its lock.")
	assert.equal((await fetch(`${base}/files/info`, { headers: { "x-gc-gate": "a".repeat(64) } })).status, 503)
	const original = await fs.stat(path.join(f.root, "README.md"))
	f.config.ownedDemo.installCheckpoint = null
	await assert.rejects(f.open(), { error: "demo_owner_fenced" })
	assert.deepEqual(await fs.readdir(f.root), atFence)
	f.adapter.ownerRuntimeId = "successor"; f.config.machineId = "runtime-successor"
	await assert.rejects(f.open(), { error: "owner_reconciliation_required" })
	assert.deepEqual(await fs.readdir(f.root), atFence)
	f.adapter.ownerFenced = true
	await f.open(); await f.settle()
	assert.equal(f.demo.filesState, "ready"); assert.equal(f.demo.mapState, "ready")
	assert.equal((await fs.stat(path.join(f.root, "README.md"))).ino, original.ino, "A successor must adopt the verified member instead of replacing it.")
	f.demo.initialReadyAt = new Date().toISOString()
	await fs.rm(path.join(f.root, "README.md")); await f.restart(); await f.settle()
	await assert.rejects(fs.stat(path.join(f.root, "README.md")), { code: "ENOENT" })
})

test("early deletion HTTP: deadline failure never acknowledges a fence or reopens admission", async (t) => {
	const f = await fixture(t); let entered, release, app
	const paused = new Promise((r) => { entered = r }), blocked = new Promise((r) => { release = r })
	f.config.controlSecret = "c".repeat(64)
	f.config.ownedDemo.installCheckpoint = async (stage, name) => { if (stage === "before-link" && name === "README.md") { entered(); await blocked } }
	t.after(async () => { release(); await app?.shutdown(new Date(Date.now() + 5000).toISOString()) })
	app = await createFilesServer({ config: f.config, secret: "a".repeat(64), logger, deferWorkspace: true })
	await new Promise((r) => app.server.listen(0, "127.0.0.1", r))
	const initialization = app.initialize(); initialization.catch(() => {}); await paused
	const request = (deadline) => fetch(`http://127.0.0.1:${app.server.address().port}/internal/files/drain`, { method: "POST", headers: { "x-gc-files-control": f.config.controlSecret, "content-type": "application/json" }, body: JSON.stringify({ deadline, admissionOnly: true, runtimeId: "runtime" }) })
	const timedOut = await request(new Date(Date.now() + 30).toISOString())
	assert.equal(timedOut.status, 503); assert.equal((await timedOut.json()).publicationFenced, undefined); assert.equal(app.startup.closed, true)
	release(); await assert.rejects(initialization, { error: "draining" })
	const resumed = await request(new Date(Date.now() + 5000).toISOString())
	assert.equal(resumed.status, 200); assert.equal((await resumed.json()).publicationFenced, true)
	assert.deepEqual(await fs.readdir(f.root), ["README.md"]); assert.equal(f.checkpoints.length, 0)
})

test("early deletion HTTP: closure does not wait for a checkpoint blocked by the backend lifecycle lock", async (t) => {
	const f = await fixture(t); let entered, release, app
	const checkpointEntered = new Promise((r) => { entered = r }), blocked = new Promise((r) => { release = r })
	f.config.controlSecret = "c".repeat(64)
	f.adapter.demoCheckpoint = async () => { entered(); await blocked; throw new FileError(401, "demo_owner_fenced", "The deleted owner was rejected.") }
	t.after(async () => { release(); await app?.shutdown(new Date(Date.now() + 5000).toISOString()) })
	app = await createFilesServer({ config: f.config, secret: "a".repeat(64), logger, deferWorkspace: true })
	await new Promise((r) => app.server.listen(0, "127.0.0.1", r))
	const initialization = app.initialize(); initialization.catch(() => {}); await checkpointEntered
	const response = await fetch(`http://127.0.0.1:${app.server.address().port}/internal/files/drain`, { method: "POST", headers: { "x-gc-files-control": f.config.controlSecret, "content-type": "application/json" }, body: JSON.stringify({ deadline: new Date(Date.now() + 1000).toISOString(), admissionOnly: true, runtimeId: "runtime" }) })
	assert.equal(response.status, 200); assert.equal((await response.json()).publicationFenced, true)
	release(); await assert.rejects(initialization, { error: "demo_owner_fenced" })
	assert.equal(f.demo.filesState, "pending"); assert.equal(f.reader.calls, 0)
	assert.equal((await fetch(`http://127.0.0.1:${app.server.address().port}/files/info`, { headers: { "x-gc-gate": "a".repeat(64) } })).status, 503)
	const records = new Database(path.join(f.base, "state/owned-demo.sqlite")), receipt = JSON.parse(records.prepare("SELECT value FROM receipt WHERE project='project'").get().value); records.close()
	assert.equal(receipt.files, "published"); assert.equal(receipt.lifecycleFence.runtimeId, "runtime")
	f.adapter.demoCheckpoint = async () => { throw new Error("No checkpoint is allowed for the fenced owner.") }
	await assert.rejects(f.open(), { error: "demo_owner_fenced" })
})

test("early deletion HTTP: jittered duplicate drains share one closure and leave no late member writes", async (t) => {
	for (let round = 0; round < 6; round++) await t.test(`round-${round}`, async (t) => {
		const f = await fixture(t); let entered, release, app
		const paused = new Promise((r) => { entered = r }), blocked = new Promise((r) => { release = r })
		f.config.controlSecret = "c".repeat(64)
		f.config.ownedDemo.installCheckpoint = async (stage, name) => { if (stage === "before-link" && name === "README.md") { entered(); await blocked } }
		t.after(async () => { release(); await app?.shutdown(new Date(Date.now() + 5000).toISOString()) })
		app = await createFilesServer({ config: f.config, secret: "a".repeat(64), logger, deferWorkspace: true }); await new Promise((r) => app.server.listen(0, "127.0.0.1", r))
		const initialization = app.initialize(); initialization.catch(() => {}); await paused
		const requests = Array.from({ length: 16 }, async () => { await wait(Math.floor(Math.random() * 12)); const r = await fetch(`http://127.0.0.1:${app.server.address().port}/internal/files/drain`, { method: "POST", headers: { "x-gc-files-control": f.config.controlSecret, "content-type": "application/json" }, body: JSON.stringify({ deadline: new Date(Date.now() + 5000).toISOString(), admissionOnly: true, runtimeId: "runtime" }) }); assert.equal(r.status, 200); assert.equal((await r.json()).publicationFenced, true) })
		await until(() => app.startup.closed); await wait(Math.floor(Math.random() * 10)); release(); await Promise.all(requests)
		await assert.rejects(initialization, { error: "draining" })
		const names = await fs.readdir(f.root); assert.deepEqual(names, ["README.md"])
		await wait(Math.floor(Math.random() * 15)); assert.deepEqual(await fs.readdir(f.root), names); assert.equal(f.checkpoints.length, 0)
	})
})

test("early deletion HTTP: map authority observation cannot hold the namespace lock while backend deletion waits for the barrier", async (t) => {
	let release = () => {}; t.after(() => release())
	const f = await fixture(t); let entered
	const paused = new Promise((r) => { entered = r }), blocked = new Promise((r) => { release = r })
	f.config.controlSecret = "c".repeat(64)
	const status = f.adapter.demoStatus.bind(f.adapter)
	f.adapter.demoStatus = async () => { if (f.reader.calls) { entered(); await blocked } return status() }
	const app = await f.deferredServer(); await new Promise((r) => app.server.listen(0, "127.0.0.1", r)); const workspace = await app.initialize()
	await paused
	const response = await fetch(`http://127.0.0.1:${app.server.address().port}/internal/files/drain`, { method: "POST", headers: { "x-gc-files-control": f.config.controlSecret, "content-type": "application/json" }, body: JSON.stringify({ admissionOnly: true, runtimeId: "runtime", deadline: new Date(Date.now() + 200).toISOString() }) })
	assert.equal(response.status, 200); assert.equal((await response.json()).publicationFenced, true)
	release(); await assert.rejects(workspace.demo.runOnce(), { error: "draining" })
	await assert.rejects(fs.stat(path.join(f.root, "maps/overview.map.json")), { code: "ENOENT" })
})

test("review F1: ordinary closure before and after permit admission resumes the same owner on normal restart", async (t) => {
	for (const point of ["status", "staged", "map"]) await t.test(point, async (t) => {
		let release = () => {}; t.after(() => release())
		const f = await fixture(t); let entered
		const paused = new Promise((r) => { entered = r }), blocked = new Promise((r) => { release = r })
		const originalStatus = f.adapter.demoStatus.bind(f.adapter)
		if (point === "status") f.adapter.demoStatus = async () => { entered(); await blocked; return originalStatus() }
		if (point === "staged") f.config.ownedDemo.installCheckpoint = async (stage) => { if (stage === "staged") { entered(); await blocked } }
		if (point === "map") f.reader.beforeRead = async () => { entered(); await blocked }
		f.config.controlSecret = "c".repeat(64)
		const app = await f.deferredServer(); await new Promise((r) => app.server.listen(0, "127.0.0.1", r))
		const initialization = app.initialize(); initialization.catch(() => {}); await paused
		const inFlight = point === "map" ? app.startup.workspace.demo.inflight : initialization
		assert.ok(inFlight, "Observe the admitted work before closing its lifecycle admission.")
		inFlight.catch(() => {})
		const response = await fetch(`http://127.0.0.1:${app.server.address().port}/internal/files/drain`, { method: "POST", headers: { "x-gc-files-control": f.config.controlSecret, "content-type": "application/json" }, body: JSON.stringify({ admissionOnly: true, deadline: new Date(Date.now() + 5000).toISOString() }) })
		assert.equal(response.status, 200); assert.equal((await response.json()).publicationFenced, true)
		release()
		await assert.rejects(inFlight, { error: "draining" })
		await app.shutdown()
		f.adapter.demoStatus = originalStatus; f.config.ownedDemo.installCheckpoint = null; f.reader.beforeRead = null
		await f.open(); await f.settle()
		assert.equal(f.demo.filesState, "ready"); assert.equal(f.demo.mapState, "ready", `Normal closure must not persist a terminal map failure or deletion veto: ${JSON.stringify(f.checkpoints)}`)
		assert.equal(await fs.readFile(path.join(f.root, "README.md"), "utf8"), f.contents["README.md"])
	})
})

test("review F3: backend authority loss leaves startup/map inert and resumes without terminal failure on normal restart", async (t) => {
	for (const point of ["status", "permit", "files-checkpoint", "map-status", "map-checkpoint"]) await t.test(point, async (t) => {
		const f = await fixture(t), status = f.adapter.demoStatus.bind(f.adapter), permit = f.adapter.demoPermit.bind(f.adapter), checkpoint = f.adapter.demoCheckpoint.bind(f.adapter)
		let revoked = true
		f.adapter.demoStatus = async () => { if (revoked && (point === "status" || point === "map-status" && f.reader.calls)) throw new FileError(401, "stale_runtime", "Authority was lost."); return status() }
		f.adapter.demoPermit = async (...args) => { if (revoked && point === "permit") throw new FileError(401, "stale_runtime", "Authority was lost."); return permit(...args) }
		f.adapter.demoCheckpoint = async (body) => { if (revoked && (point === "files-checkpoint" && body.outcome === "files-ready" || point === "map-checkpoint" && body.outcome === "map-ready")) throw new FileError(401, "stale_runtime", "Authority was lost."); return checkpoint(body) }
		f.config.controlSecret = "c".repeat(64)
		const app = await f.deferredServer(); await new Promise((r) => app.server.listen(0, "127.0.0.1", r))
		if (point.startsWith("map-")) {
			const workspace = await app.initialize()
			try { await workspace.demo.runOnce() } catch (error) { assert.equal(error.status, 401) }
			await until(() => app.startup.authorityLost)
		} else await assert.rejects(app.initialize(), { status: 401 })
		const response = await fetch(`http://127.0.0.1:${app.server.address().port}/files/info`, { headers: { "x-gc-gate": "a".repeat(64) } })
		assert.equal(response.status, 503); assert.equal((await response.json()).error, "draining")
		assert.equal(f.checkpoints.some((c) => c.outcome === "failed"), false)
		const db = new Database(path.join(f.base, "state/owned-demo.sqlite")), row = db.prepare("SELECT value FROM receipt WHERE project='project'").get(); db.close()
		const receipt = JSON.parse(row?.value || "{}")
		assert.equal(receipt.mapFailureRevision, undefined); assert.equal(receipt.filesFailureRevision, undefined)
		await app.shutdown(); revoked = false
		await f.open(); await f.settle(); assert.equal(f.demo.filesState, "ready"); assert.equal(f.demo.mapState, "ready", JSON.stringify(f.checkpoints))
	})
})

test("review F3: the real daemon stays alive and serves only lifecycle control after startup backend 401", async (t) => {
	const f = await fixture(t), backend = http.createServer((req, res) => { req.resume(); res.writeHead(401, { "content-type": "application/json" }); res.end(JSON.stringify({ detail: "stale_runtime" })) })
	await new Promise((r) => backend.listen(0, "127.0.0.1", r))
	const portProbe = http.createServer(); await new Promise((r) => portProbe.listen(0, "127.0.0.1", r)); const port = portProbe.address().port; await new Promise((r) => portProbe.close(r))
	const child = spawn(process.execPath, [new URL("../files-server.js", import.meta.url).pathname], { env: { PATH: process.env.PATH, HOME: process.env.HOME, PROJECT_ID: "project", FLY_MACHINE_ID: "runtime", WORKSPACE_DIR: f.root, FILES_STATE_DIR: path.join(f.base, "daemon-state"), OWNED_DEMO_ENABLED: "true", FILES_SYNC_ADAPTER: "true", FILES_AGENT_UIDS: "20001", FILES_WORKER_UIDS: "20003", RUNTIME_FILES_PORT: String(port), RUNTIME_MACHINE_GATEWAY_PORT: String(backend.address().port) }, stdio: ["pipe", "pipe", "pipe"] })
	let output = ""; child.stdout.on("data", (b) => { output += b }); child.stderr.on("data", (b) => { output += b }); child.stdin.end(`${"a".repeat(64)}\n${"c".repeat(64)}\n`)
	t.after(async () => { child.kill("SIGTERM"); await new Promise((r) => { if (child.exitCode !== null) return r(); child.once("exit", r); setTimeout(() => child.kill("SIGKILL"), 3000).unref() }); backend.closeAllConnections(); await new Promise((r) => backend.close(r)) })
	await until(() => output.includes("authority") || child.exitCode !== null)
	assert.equal(child.exitCode, null, output)
	const response = await fetch(`http://127.0.0.1:${port}/files/info`, { headers: { "x-gc-gate": "a".repeat(64) } })
	assert.equal(response.status, 503); assert.equal((await response.json()).error, "draining")
	const drained = await fetch(`http://127.0.0.1:${port}/internal/files/drain`, { method: "POST", headers: { "x-gc-files-control": "c".repeat(64), "content-type": "application/json" }, body: JSON.stringify({ runtimeId: "runtime", admissionOnly: true, deadline: new Date(Date.now() + 5000).toISOString() }) })
	assert.equal(drained.status, 200); assert.equal((await drained.json()).publicationFenced, true)
})

test("deletion identity: a retained historical permit owner cannot reject the current machine's deletion fence", async (t) => {
	const f = await fixture(t); await f.open(); await f.settle(); await f.files.close()
	f.demo.initialReadyAt = new Date().toISOString()
	f.adapter.ownerRuntimeId = "successor"; f.adapter.ownerFenced = true; f.config.machineId = "runtime-successor"; f.config.controlSecret = "c".repeat(64)
	const app = await f.deferredServer(); await new Promise((r) => app.server.listen(0, "127.0.0.1", r)); await app.initialize()
	const response = await fetch(`http://127.0.0.1:${app.server.address().port}/internal/files/drain`, { method: "POST", headers: { "x-gc-files-control": f.config.controlSecret, "content-type": "application/json" }, body: JSON.stringify({ runtimeId: "successor", admissionOnly: true, deadline: new Date(Date.now() + 1000).toISOString() }) })
	assert.equal(response.status, 200); assert.equal((await response.json()).publicationFenced, true)
})

test("native lifecycle: demo preview waits for its preparation to release the native slot after its success receipt", async (t) => {
	let release = () => {}; t.after(() => release())
	const f = await fixture(t); let entered
	const published = new Promise((r) => { entered = r }), blocked = new Promise((r) => { release = r })
	const processing = f.config.processingFactory
	f.config.processingFactory = (workspace) => {
		const transaction = workspace.state.transaction.bind(workspace.state)
		workspace.state.transaction = async (operations) => { await transaction(operations); if (operations.some((op) => op.kind === "jobs" && op.value?.preparationType === "vector" && op.value.state === "succeeded")) { entered(); await blocked } }
		return processing()
	}
	await f.open()
	await Promise.race([published, wait(1500).then(() => { throw new Error(`The preparation success hook was not reached: ${JSON.stringify(f.checkpoints)}`) })])
	await wait(30)
	assert.equal(f.demo.mapState, "pending", "A completed receipt must not trigger a query against this preparation's still-owned native slot.")
	release(); await f.settle(); assert.equal(f.demo.mapState, "ready", JSON.stringify(f.checkpoints))
})

test("installed owned demo: ordinary three-layer CSV/collar/vector map save and retained reopen use private native captures", { skip: !process.env.OWNED_DEMO_NATIVE_LAUNCHER && "Set OWNED_DEMO_NATIVE_LAUNCHER to an installed trusted GIS launcher." }, async (t) => {
	const f = await fixture(t)
	delete f.config.filesGisReader; f.config.filesGisWorkerBin = process.env.OWNED_DEMO_NATIVE_LAUNCHER
	const outline = JSON.stringify({ type: "FeatureCollection", features: [{ type: "Feature", properties: {}, geometry: { type: "Polygon", coordinates: [[[10, 30], [11, 30], [11, 31], [10, 31], [10, 30]]] } }] })
	await fs.writeFile(path.join(f.bundleDir, "gis/training_area.geojson"), outline); f.memberHashes["gis/training_area.geojson"] = sha(outline)
	const manifest = JSON.parse(await fs.readFile(path.join(f.bundleDir, "provenance/manifest.json"), "utf8"))
	manifest.memberHashes["gis/training_area.geojson"] = sha(outline)
	const manifestBytes = JSON.stringify(manifest); await fs.writeFile(path.join(f.bundleDir, "provenance/manifest.json"), manifestBytes); f.memberHashes["provenance/manifest.json"] = sha(manifestBytes)
	f.demo.template.bundleSha256 = digestOf(f.memberHashes)
	await f.open(); await f.settle(); assert.equal(f.demo.mapState, "ready", JSON.stringify(f.checkpoints))
	const loaded = await f.files.mapViewLoad("maps/overview.map.json")
	assert.equal(loaded.layers.length, 3); assert.ok(loaded.layers.every((l) => l.prepared.availability === "available"))
	for (const l of loaded.document.layers.slice(0, 2)) {
		const query = await f.files.representationQuery(l.prepared.id, { operation: "preview" })
		assert.equal(query.placement.state, "ready"); assert.equal(query.points.length, 1); assert.equal(query.points[0].value.value, 2)
		assert.ok(l.sources.every((s) => s.ref.workspaceEpoch === f.files.identity.workspaceEpoch && s.digest.sha256 === f.memberHashes[s.ref.path]))
	}
	await f.restart(); await f.settle()
	assert.deepEqual((await f.files.mapViewLoad("maps/overview.map.json")).document, loaded.document)
})

test("installed Wattle Creek v1: immutable full seed verifies, prepares all native layers and reopens the same owned saved map", { skip: !process.env.OWNED_DEMO_NATIVE_LAUNCHER && "Set OWNED_DEMO_NATIVE_LAUNCHER to qualify the bundled Wattle Creek seed." }, async (t) => {
	const f = await fixture(t), bundleDir = new URL("../demo-bundles/wattle-creek/v1/", import.meta.url).pathname
	const bytes = await fs.readFile(path.join(bundleDir, "provenance/manifest.json")), manifest = JSON.parse(bytes)
	const members = { ...manifest.memberHashes, "provenance/manifest.json": sha(bytes) }
	assert.equal(digestOf(members), "101d5b89bddff69f98c66be050cd152767d85bb09384f3e0c6427330fe61ee52", "The immutable v1 bundle must match the approved digest.")
	f.config.ownedDemo.bundleDir = bundleDir; delete f.config.ownedDemo.memberHashes
	delete f.config.filesGisReader; f.config.filesGisWorkerBin = process.env.OWNED_DEMO_NATIVE_LAUNCHER
	f.demo.template.bundleSha256 = digestOf(members)
	await f.open(); await f.settle(); assert.equal(f.demo.mapState, "ready", JSON.stringify(f.checkpoints))
	const saved = await f.files.mapViewLoad("maps/overview.map.json")
	assert.equal(saved.document.layers.length, 3); assert.ok(saved.layers.every((l) => l.prepared.availability === "available"))
	const surface = await f.files.representationQuery(saved.document.layers[0].prepared.id, { operation: "preview" })
	const drilling = await f.files.representationQuery(saved.document.layers[1].prepared.id, { operation: "preview" })
	assert.equal(surface.rows.length, 196); assert.equal(surface.points.length, 196); assert.equal(surface.counts.missing, 9); assert.equal(surface.counts.censored, 27)
	const above = surface.rows.filter((r) => r.value.state === "detected" && r.value.value >= 0.1).sort((a, b) => b.value.value - a.value.value)
	assert.equal(above.length, 35); assert.equal(above[0].id, "WCS0114"); assert.equal(above[0].value.value, 2.79)
	assert.equal(drilling.rows.length, 3152); assert.equal(drilling.collarRows.length, 140); assert.equal(drilling.counts.unmatchedRows, 12)
	for (const layer of saved.document.layers) for (const source of layer.sources) { assert.deepEqual({ workspaceId: source.ref.workspaceId, workspaceEpoch: source.ref.workspaceEpoch }, f.files.identity); assert.equal(source.digest.sha256, members[source.ref.path]) }
	await f.restart(); await f.settle(); assert.deepEqual((await f.files.mapViewLoad("maps/overview.map.json")).document, saved.document)
	console.log(`Wattle Creek v1: bundleSha256=${digestOf(members)}; verified workspace members=${Object.keys(f.demo.memberHashes).length}; native rows=196/140/3152; unmatched=12; map layers=3; retained reopen=equal`)
})

test("eager evidence: files reject partial, stale, truncated and missing-member catalogue observations", async (t) => {
	for (const defect of ["partial", "stale", "truncated", "missing"]) await t.test(defect, async (t) => {
		const f = await fixture(t), find = FileIndex.prototype.find
		FileIndex.prototype.find = async function (input) { const page = await find.call(this, input); return { ...page, ...(defect === "partial" || defect === "stale" ? { coverage: { ...page.coverage, state: defect } } : defect === "truncated" ? { truncated: true } : { items: page.items.filter((r) => r.path !== "LICENSE.txt"), count: { value: page.count.value - 1, relation: "exact" } }) } }
		try { await assert.rejects(f.open(), { error: "demo_catalogue_incomplete" }); assert.equal(f.checkpoints.some((c) => c.outcome === "files-ready"), false) } finally { FileIndex.prototype.find = find }
	})
})

test("eager evidence: drains one frozen paginated catalogue and binds both exact committed publication identities", async (t) => {
	const f = await fixture(t); f.config.filesLimits = { pageSize: 2, pageMaxSize: 2, indexScanEntries: 5 }
	await f.open(); await f.settle()
	const files = f.checkpoints.find((c) => c.outcome === "files-ready"), map = f.checkpoints.find((c) => c.outcome === "map-ready")
	assert.ok(files.evidence, "files-ready must include complete evidence")
	assert.deepEqual(files.evidence.publication, { operationId: f.permits[0].operationId, state: "committed" })
	assert.deepEqual(files.evidence.catalogue.paths, [...DEMO_MEMBERS].sort())
	assert.deepEqual(map.evidence.catalogue.paths, [...DEMO_MEMBERS, "maps/overview.map.json"].sort())
	assert.equal(map.evidence.publication.operationId, `${f.permits.find((p) => p.stage === "map").operationId}:map`)
	assert.equal(map.evidence.publication.sha256, map.map.sha256)
	assert.equal(map.evidence.sources.length, 4); assert.equal(map.evidence.products.length, 3); assert.equal(map.evidence.holds.length, 4)
	assert.equal(map.evidence.heldBytes, map.evidence.sources.reduce((n, s) => n + s.sizeBytes, 0))
	const permit = f.permits.find((p) => p.stage === "map")
	for (const s of map.evidence.sources) { assert.equal(s.sha256, f.memberHashes[s.path]); assert.ok(map.evidence.holds.some((h) => h.holdId === `demo-initial:${permit.permitId}:${s.captureId}` && h.reason === `owned-demo-initial:${f.demo.assignmentId}:${permit.permitId}` && h.source.id === s.captureId)) }
})

test("eager bootstrap: lost acknowledgement replays verbatim and restart validates with a fresh persisted random request", async (t) => {
	const f = await fixture(t); f.adapter.loseResponse = "map-ready"
	await f.open(); await assert.rejects(f.settle(), /injected response lost/)
	assert.equal((await f.files.info({ privateBootstrap: true })).initialPreparation, undefined)
	const pending = structuredClone(f.files.demo.record.pendingCheckpoint)
	assert.equal(pending.mode, "publication")
	await f.settle(); assert.deepEqual((await f.files.info({ privateBootstrap: true })).initialPreparation, { checkpointRequestId: pending.requestId })
	assert.equal((await f.files.info()).initialPreparation, undefined, "Ordinary info never exposes the private pointer")
	const operationId = f.files.demo.record.mapSaveOperationId, calls = f.reader.calls
	await f.restart(); await f.settle()
	const validation = f.checkpoints.at(-1)
	assert.equal(validation.mode, "validation"); assert.notEqual(validation.requestId, pending.requestId)
	assert.equal(f.files.demo.record.mapSaveOperationId, operationId); assert.equal(f.reader.calls, calls)
	assert.deepEqual((await f.files.info({ privateBootstrap: true })).initialPreparation, { checkpointRequestId: validation.requestId })
	assert.equal((await f.files.state.list("operations")).filter((o) => o.intent.path === "maps/overview.map.json").length, 1)
})

test("eager bootstrap: old report replay never advertises a pointer when fresh saved-map, seed, product, placement or hold checks fail", async (t) => {
	for (const defect of ["seed", "map", "product", "placement", "hold"]) await t.test(defect, async (t) => {
		const f = await fixture(t); f.adapter.loseResponse = "map-ready"; await f.open(); await assert.rejects(f.settle(), /injected response lost/)
		const saved = await f.files.mapViewLoad("maps/overview.map.json")
		if (defect === "seed") await fs.writeFile(path.join(f.root, "LICENSE.txt"), "edited")
		if (defect === "map") await fs.writeFile(path.join(f.root, "maps/overview.map.json"), stableStringify({ ...saved.document, title: "edited" }))
		if (defect === "product") { const index = await f.files.state.get("workbook-indexes", saved.document.layers[0].prepared.id); await fs.rm(f.files.captures.blobPath(index)) }
		if (defect === "hold") await f.files.captures.releaseHold(`demo-initial:${f.permits.find((p) => p.stage === "map").permitId}:${saved.document.layers[0].sources[0].captureId}`)
		if (defect === "placement") { const read = f.reader.read.bind(f.reader); f.reader.read = async (input) => { const result = await read(input); if (input.operation === "preview") for (const layer of result.layers || []) layer.placement.state = "unavailable"; return result } }
		await f.restart(); await f.settle().catch(() => {})
		assert.equal((await f.files.info({ privateBootstrap: true })).initialPreparation, undefined, `${defect} must prevent a current process pointer`)
		assert.equal(f.checkpoints.filter((c) => c.mode === "validation").length, 0)
	})
})

async function expirePreview(f) {
	for (const lease of await f.files.state.list("leases")) await f.files.captures.releaseLease(lease.leaseId)
	for (const kind of ["captures", "workbook-indexes"]) for (const record of await f.files.state.list(kind)) await f.files.state.put(kind, record.id, { ...record, lastAccessAt: "2000-01-01T00:00:00.000Z" })
	f.files.captures.limits.previewBytes = 1
	return f.files.captures.sweep()
}

test("eager retention: durable exact input ownership precedes publication and survives delayed eviction pressure, restart and all ordinary map edits", async (t) => {
	const f = await fixture(t)
	f.config.filesCheckpoint = async (stage, op) => { if (stage === "accepted" && op.intent.path === "maps/overview.map.json") { const holds = (await f.adapter.workspace.state.list("holds")).filter((h) => h.reason.startsWith("owned-demo-initial:")); assert.equal(holds.length, 4); assert.equal(f.adapter.workspace.demo.record.retention.holds.length, 4) } }
	await f.open(); await f.settle(); f.demo.initialReadyAt = new Date().toISOString()
	const saved = await f.files.mapViewLoad("maps/overview.map.json"), originalHolds = (await f.files.state.list("holds")).filter((h) => h.reason.startsWith("owned-demo-initial:"))
	assert.equal(originalHolds.length, 4)
	await expirePreview(f); await f.restart(); await f.settle()
	assert.ok((await f.files.mapViewLoad("maps/overview.map.json")).layers.every((l) => l.prepared.availability === "available"))
	await f.files.move({ operationId: "move-map", from: "maps/overview.map.json", to: "maps/moved.map.json", baseObservation: (await f.files.stat("maps/overview.map.json")).observation })
	await fs.writeFile(path.join(f.root, "maps/moved.map.json"), "raw overwrite"); await fs.rm(path.join(f.root, "maps/moved.map.json"))
	await expirePreview(f)
	assert.deepEqual((await f.files.state.list("holds")).filter((h) => h.reason.startsWith("owned-demo-initial:")), originalHolds)
	for (const l of saved.document.layers) assert.equal((await f.files.representationQuery(l.prepared.id, l.locationRecipe.query)).representationId, l.prepared.id)
	const foreign = "foreign-operator-hold"; await f.files.captures.hold("capture", saved.document.layers[0].sources[0].captureId, "another-owner", foreign)
	const result = await f.files.demo.releaseRetention({ assignmentId: f.demo.assignmentId, permitId: f.permits.find((p) => p.stage === "map").permitId })
	assert.equal(result.released, 4); assert.ok(await f.files.state.get("holds", foreign))
})

test("eager retention: authenticated operator release requires completed initial preparation and rejects rebound ownership", async (t) => {
	const f = await fixture(t); f.config.controlSecret = "c".repeat(64); const app = await f.openServer(); await f.settle()
	await new Promise((r) => app.server.listen(0, "127.0.0.1", r)); t.after(async () => { app.server.closeAllConnections(); await new Promise((r) => app.server.close(r)) })
	const body = { assignmentId: f.demo.assignmentId, permitId: f.permits.find((p) => p.stage === "map").permitId }, url = `http://127.0.0.1:${app.server.address().port}/internal/files/demo/retention/release`
	const request = (secret) => fetch(url, { method: "POST", headers: { "x-gc-files-control": secret, "content-type": "application/json" }, body: JSON.stringify(body) })
	assert.equal((await request("wrong")).status, 403); assert.equal((await request(f.config.controlSecret)).status, 409)
	f.demo.initialReadyAt = new Date().toISOString()
	const binding = f.files.demo.record.retention.holds[0], hold = await f.files.state.get("holds", binding.holdId)
	await f.files.state.put("holds", binding.holdId, { ...hold, reason: "foreign-owner" })
	assert.equal((await request(f.config.controlSecret)).status, 409); assert.equal((await f.files.state.list("holds")).filter((h) => h.reason.startsWith("owned-demo-initial:")).length, 3)
})

test("eager retention: safely failed attempt and deletion barrier release only exact ownership; uncertain publication retains it", async (t) => {
	for (const disposition of ["abandon", "uncertain", "delete"]) await t.test(disposition, async (t) => {
		const f = await fixture(t)
		if (disposition !== "delete") f.config.filesCheckpoint = async (stage, op) => { if (stage === "staged" && op.intent.path === "maps/overview.map.json") throw new FileError(503, disposition === "uncertain" ? "operation_indeterminate" : "demo_preparation_failed", "Injected save interruption.", disposition === "uncertain" ? { state: "indeterminate" } : {}) }
		await f.open(); await f.settle().catch(() => {})
		if (disposition === "delete") { const binding = f.files.demo.record.retention.holds[0]; await f.files.captures.hold("capture", binding.source.id, "foreign-owner", "foreign-hold"); f.files.startup.closeAdmission("runtime"); await f.files.startup.barrier(); assert.ok(await f.files.state.get("holds", "foreign-hold")) }
		assert.equal((await f.files.state.list("holds")).filter((h) => h.reason.startsWith("owned-demo-initial:")).length, disposition === "uncertain" ? 4 : 0)
	})
})

test("eager deadline: lost readiness report expires into a separate settlement request, never a bootstrap pointer or new stage admission", async (t) => {
	const f = await fixture(t); f.adapter.loseResponse = "map-ready"; await f.open(); await assert.rejects(f.settle(), /injected response lost/)
	const ready = structuredClone(f.files.demo.record.pendingCheckpoint), permits = f.permits.length
	await pastDeadline(f, async () => {
		f.demo.attempt.failedAt = new Date().toISOString()
		await f.settle(); assert.equal(f.checkpoints.at(-1).mode, "settlement"); assert.notEqual(f.checkpoints.at(-1).requestId, ready.requestId)
		assert.equal((await f.files.info({ privateBootstrap: true })).initialPreparation, undefined); assert.equal(f.permits.length, permits)
		assert.equal((await f.files.state.list("holds")).filter((h) => h.reason.startsWith("owned-demo-initial:")).length, 4)
	})
})

test("eager deadline: bounded job waits stop subsequent stage work without claiming that active native work stopped", async (t) => {
	const f = await fixture(t); await f.open(); await f.settle()
	f.demo.attempt.deadlineAt = new Date(Date.now() + 30).toISOString(); f.files.demo.deadlineAt = f.demo.attempt.deadlineAt
	const job = f.files.job; f.files.job = async () => ({ state: "running" })
	try { await assert.rejects(f.files.demo.settleJob({ jobId: "still-running" }), { error: "demo_attempt_expired" }) } finally { f.files.job = job }
})

test("eager authority: old epoch and stale retry validation never republish, release committed holds or advertise readiness", async (t) => {
	for (const change of ["epoch", "revision"]) await t.test(change, async (t) => {
		const f = await fixture(t); await f.open(); await f.settle(); const op = f.files.demo.record.mapSaveOperationId
		await f.files.close()
		if (change === "epoch") { const db = new Database(path.join(f.base, "state/files.sqlite")); db.prepare("UPDATE identity SET workspace_epoch=?").run(crypto.randomUUID()); db.close() } else f.demo.retryRevision++
		await f.open(); await f.settle().catch(() => {})
		assert.equal((await f.files.info({ privateBootstrap: true })).initialPreparation, undefined); assert.equal(f.files.demo.record.mapSaveOperationId, op)
		assert.equal(f.checkpoints.filter((c) => c.mode === "validation").length, 0); assert.equal(f.checkpoints.filter((c) => c.outcome === "map-ready").length, 1)
	})
})

test("eager authority: current process drops its acknowledged bootstrap pointer after assignment, retry or owner changes", async (t) => {
	for (const change of ["assignment", "revision", "runtime", "epoch"]) await t.test(change, async (t) => {
		const f = await fixture(t); await f.open(); await f.settle()
		assert.ok(f.files.demo.bootstrap())
		if (change === "assignment") f.demo.assignmentId = crypto.randomUUID()
		if (change === "revision") f.demo.retryRevision++
		if (change === "runtime") f.permits.find((p) => p.stage === "map").runtimeId = "successor"
		if (change === "epoch") f.files.identity = { ...f.files.identity, workspaceEpoch: crypto.randomUUID() }
		await f.files.demo.status()
		assert.equal(f.files.demo.bootstrap(), undefined, "A prior process observation must not survive changed authority.")
	})
})

test("eager retention: repeated safe retries release each failed input set without carrying forward the prior map dispatch intent", async (t) => {
	const f = await fixture(t)
	f.config.filesCheckpoint = async (stage, op) => { if (stage === "staged" && op.intent.path === "maps/overview.map.json") throw new FileError(503, "demo_preparation_failed", "Save failed before rename.") }
	await f.open(); await f.settle()
	assert.equal(f.demo.mapState, "failed"); assert.equal(f.files.demo.record.retention.releasedAt !== undefined, true)
	f.config.filesCheckpoint = null
	f.reader.beforeRead = () => { throw new Error("The next attempt fails before map admission") }
	for (let round = 0; round < 3; round++) {
		f.demo.retryRevision++; f.demo.mapState = "pending"
		await f.settle()
		assert.equal(f.demo.mapState, "failed")
		assert.equal((await f.files.state.list("holds")).filter((h) => h.reason.startsWith("owned-demo-initial:")).length, 0, "A safely failed retry must release its exact set.")
	}
})

test("eager bootstrap: completed-permit validation persists a fresh random body and replays it verbatim through lost acknowledgement", async (t) => {
	const f = await fixture(t); await f.open(); await f.settle()
	const publication = f.checkpoints.at(-1)
	// A completed permit remains read-only even if a stage observation lags.
	f.demo.mapState = "pending"; f.adapter.loseResponse = "map-ready"
	await f.restart()
	await assert.rejects(f.settle(), /injected response lost/)
	const pending = structuredClone(f.files.demo.record.pendingCheckpoint)
	assert.equal(pending.mode, "validation"); assert.notEqual(pending.requestId, publication.requestId)
	assert.equal(f.files.demo.bootstrap(), undefined)
	await f.settle()
	assert.deepEqual(f.checkpoints.at(-1), pending)
	assert.deepEqual(f.files.demo.bootstrap(), { checkpointRequestId: pending.requestId })
	assert.equal(f.checkpoints.filter((c) => c.mode === "validation").length, 1)
})

test("eager deadline: expiry after a committed save settles that publication once without releasing its inputs", async (t) => {
	const f = await fixture(t), checkpoint = f.adapter.demoCheckpoint.bind(f.adapter)
	f.adapter.demoCheckpoint = async (body) => {
		if (body.outcome === "map-ready" && body.mode === "publication") { f.demo.attempt.failedAt = new Date().toISOString(); throw new Error("Readiness acknowledgement uncertain at expiry") }
		return checkpoint(body)
	}
	await f.open(); await assert.rejects(f.settle(), /acknowledgement uncertain/)
	await f.settle(); await f.settle()
	assert.equal(f.checkpoints.filter((c) => c.mode === "settlement" && c.outcome === "map-ready").length, 1, "Effect settlement must not duplicate a map observation on every poll.")
	assert.equal(f.files.demo.bootstrap(), undefined)
	assert.equal((await f.files.state.list("holds")).filter((h) => h.reason.startsWith("owned-demo-initial:")).length, 4)
})

test("eager private bootstrap HTTP: no-browser worker completes independently of liveness and only authenticated machine info exposes its pointer", async (t) => {
	const f = await fixture(t); f.config.controlSecret = "c".repeat(64)
	let entered, release; const paused = new Promise((r) => { entered = r }), blocked = new Promise((r) => { release = r })
	f.reader.beforeRead = async () => { entered(); await blocked }
	const app = await f.openServer(); await new Promise((r) => app.server.listen(0, "127.0.0.1", r)); await paused
	t.after(async () => { release(); app.server.closeAllConnections(); await new Promise((r) => app.server.close(r)) })
	const local = `http://127.0.0.1:${app.server.address().port}`
	assert.equal((await fetch(`${local}/livez`, { headers: { "x-gc-gate": "a".repeat(64) } })).status, 200)
	assert.equal(f.demo.mapState, "pending")
	release(); await f.settle()
	const keyFile = path.join(f.base, "proxy-key"), controlFile = path.join(f.base, "files-control"), gateFile = path.join(f.base, "gate-secret")
	await fs.writeFile(keyFile, "e".repeat(64), { mode: 0o600 }); await fs.writeFile(controlFile, f.config.controlSecret, { mode: 0o600 }); await fs.writeFile(gateFile, "a".repeat(64), { mode: 0o600 })
	const root = gate.createGateServer({ ...gate.loadConfig({ PROJECT_ID: "project", FLY_MACHINE_ID: "runtime", IDE_AUTH_DISABLED: "true" }), keyFile, filesControlFile: controlFile, gateFile, filesPort: app.server.address().port }, { logger: { log() {}, error() {}, warn() {} } })
	await new Promise((r) => root.listen(0, "127.0.0.1", r)); t.after(async () => { root.closeAllConnections(); await new Promise((r) => root.close(r)) })
	const url = `http://127.0.0.1:${root.address().port}/files/info`, headers = { "x-ide-proxy-key": "e".repeat(64), "x-gc-project-id": "project", "x-gc-machine-id": "runtime" }
	const response = await fetch(url, { headers }); assert.equal(response.status, 200)
	assert.deepEqual((await response.json()).initialPreparation, f.files.demo.bootstrap())
	for (const extra of [{ "x-ide-proxy-key": "wrong" }, { cookie: "browser-cookie" }, { origin: "https://geocluster.net" }]) assert.equal((await fetch(url, { headers: { ...headers, ...extra } })).status, 404)
	assert.equal((await fetch(url, { headers: { ...headers, "x-gc-machine-id": "another-machine" } })).status, 409)
	const ordinary = await fetch(`${local}/files/info`, { headers: { "x-gc-gate": "a".repeat(64) } })
	assert.equal((await ordinary.json()).initialPreparation, undefined)
	const control = `${local}/internal/files/demo/retention/release`, body = JSON.stringify({ assignmentId: f.demo.assignmentId, permitId: f.permits.find((p) => p.stage === "map").permitId })
	f.demo.initialReadyAt = new Date().toISOString()
	for (const extra of [{ cookie: "browser-cookie" }, { origin: "https://geocluster.net" }]) assert.equal((await fetch(control, { method: "POST", headers: { "x-gc-files-control": f.config.controlSecret, ...extra }, body })).status, 403)
	assert.equal((await fetch(`${control}?extra=1`, { method: "POST", headers: { "x-gc-files-control": f.config.controlSecret }, body })).status, 405)
	const released = await fetch(control, { method: "POST", headers: { "x-gc-files-control": f.config.controlSecret }, body })
	assert.equal(released.status, 200); const result = await released.json(); assert.equal(result.released, 4); assert.equal(result.heldBytes, 0); assert.ok(result.releasedBytes > 0)
})

test("eager bootstrap: a settlement-only acknowledgement or acknowledgement after deadline never creates readiness", async (t) => {
	for (const disposition of ["settled-only", "expired"]) await t.test(disposition, async (t) => {
		const f = await fixture(t), checkpoint = f.adapter.demoCheckpoint.bind(f.adapter)
		f.adapter.demoCheckpoint = async (body) => {
			const result = await checkpoint(body)
			if (body.outcome === "map-ready") {
				if (disposition === "expired") { f.demo.attempt.failedAt = new Date().toISOString(); result.demo = structuredClone(f.demo) }
				else result.readinessAccepted = false
			}
			return result
		}
		await f.open(); await f.settle().catch((e) => assert.equal(e.error, "demo_attempt_expired"))
		assert.equal(f.files.demo.bootstrap(), undefined)
		assert.equal((await f.files.info({ privateBootstrap: true })).initialPreparation, undefined)
	})
})

test("eager deadline: expiry between committed map save and evidence reports the granted effect without readiness or duplicate publication", async (t) => {
	const f = await fixture(t), processing = f.config.processingFactory
	f.config.processingFactory = (workspace) => {
		const save = workspace.mapViewSave.bind(workspace)
		workspace.mapViewSave = async (...args) => { const result = await save(...args); f.demo.attempt.failedAt = new Date().toISOString(); workspace.demo.currentDemo.attempt.failedAt = f.demo.attempt.failedAt; return result }
		return processing()
	}
	await f.open(); await assert.rejects(f.settle(), { error: "demo_attempt_expired" })
	assert.equal((await f.files.state.get("operations", f.files.demo.record.mapSaveOperationId)).state, "committed")
	await f.settle(); await f.settle()
	assert.equal(f.checkpoints.filter((c) => c.outcome === "map-ready" && c.mode === "settlement").length, 1)
	assert.equal(f.checkpoints.filter((c) => c.outcome === "map-ready" && c.mode !== "settlement").length, 0)
	assert.equal(f.files.demo.bootstrap(), undefined)
	assert.equal((await f.files.state.list("holds")).filter((h) => h.reason.startsWith("owned-demo-initial:")).length, 4)
})

test("eager retention: uncertain request settlement cannot release a failed unpublished attempt's held inputs", async (t) => {
	const f = await fixture(t), processing = f.config.processingFactory; let abandon
	f.reader.beforeRead = () => { throw new Error("Failed unpublished preparation") }
	f.config.processingFactory = (workspace) => { abandon = workspace.demo.safelyAbandon.bind(workspace.demo); workspace.demo.safelyAbandon = async () => false; return processing() }
	await f.open(); await assert.rejects(f.settle(), { error: "operation_indeterminate" })
	const request = (await f.files.state.list("requests")).find((r) => r.type === "capture"), holds = (await f.files.state.list("holds")).filter((h) => h.reason.startsWith("owned-demo-initial:"))
	assert.equal(holds.length, 1)
	await f.files.state.put("requests", request.requestId, { ...request, state: "failed", error: { state: "indeterminate", error: "storage_unavailable" } })
	assert.equal(await abandon(), false, "Terminal labels cannot replace effect-settlement evidence.")
	assert.deepEqual((await f.files.state.list("holds")).filter((h) => h.reason.startsWith("owned-demo-initial:")), holds)
	await f.files.state.put("requests", request.requestId, request)
	const settle = f.files.gis.waitForSettlement.bind(f.files.gis)
	f.files.gis.waitForSettlement = () => new Promise(() => {})
	f.files.demo.config.transportMs = 20
	try { assert.equal(await Promise.race([abandon(), wait(250).then(() => { throw new Error("Safe abandonment exceeded its settlement observation bound") })]), false) }
	finally { f.files.gis.waitForSettlement = settle }
	assert.equal(await abandon(), true)
	assert.equal((await f.files.state.list("holds")).filter((h) => h.reason.startsWith("owned-demo-initial:")).length, 0)
})

test("eager retention: lost independent release receipt replays exact cleanup without double-counting released bytes", async (t) => {
	const f = await fixture(t); await f.open(); await f.settle(); f.demo.initialReadyAt = new Date().toISOString()
	const demo = f.files.demo, persist = demo.persist.bind(demo), input = { assignmentId: f.demo.assignmentId, permitId: f.permits.find((p) => p.stage === "map").permitId }
	demo.persist = (fields) => { if (fields.retention?.releasedAt) throw new Error("Independent release receipt was not acknowledged"); return persist(fields) }
	await assert.rejects(demo.releaseRetention(input), /release receipt was not acknowledged/)
	assert.equal((await f.files.state.list("holds")).filter((h) => h.reason.startsWith("owned-demo-initial:")).length, 0)
	demo.persist = persist
	const result = await demo.releaseRetention(input)
	assert.equal(result.released, 0); assert.equal(result.releasedBytes, 0); assert.equal(result.heldBytes, 0)
	assert.equal(demo.record.retention.releaseReason, "operator-release")
})

test("review corrections: actual map failure catch with indeterminate native cleanup withholds terminal checkpoints and retry until settlement", async (t) => {
	for (const disposition of ["ordinary", "expired"]) await t.test(disposition, async (t) => {
		const f = await fixture(t), processing = f.config.processingFactory
		f.reader.beforeRead = () => { throw new Error("Native preparation failed") }
		f.config.processingFactory = (workspace) => {
			const transaction = workspace.state.transaction.bind(workspace.state)
			workspace.state.transaction = async (operations) => {
				const failed = operations.some((op) => op.kind === "jobs" && op.value?.type === "preparation" && op.value.state === "failed")
				await transaction(operations.map((op) => op.kind === "jobs" && op.value?.type === "preparation" && op.value.state === "failed" ? { ...op, value: { ...op.value, cleanup: { state: "indeterminate" } } } : op))
				if (failed && disposition === "expired") { f.demo.attempt.failedAt = new Date().toISOString(); workspace.demo.currentDemo.attempt.failedAt = f.demo.attempt.failedAt }
			}
			return processing()
		}
		await f.open(); await assert.rejects(f.settle(), { error: "operation_indeterminate" })
		await Promise.allSettled([...f.files.gis.pending])
		const permit = structuredClone(f.permits.find((p) => p.stage === "map")), holds = (await f.files.state.list("holds")).filter((h) => h.reason.startsWith("owned-demo-initial:")), calls = f.reader.calls, permitCount = f.permits.length
		assert.equal(permit.state, "granted"); assert.equal(holds.length, 1)
		assert.equal(f.checkpoints.filter((c) => c.outcome === "failed").length, 0)
		assert.equal((await f.adapter.demoStatus()).demo.retry.action, "none")
		if (disposition === "ordinary") await f.restart()
		await assert.rejects(f.settle(), { error: "operation_indeterminate" })
		assert.equal(f.permits.length, permitCount); assert.equal(f.reader.calls, calls)
		assert.deepEqual((await f.files.state.list("holds")).filter((h) => h.reason.startsWith("owned-demo-initial:")), holds)
		assert.equal((await f.adapter.demoStatus()).permits.map.permitId, permit.permitId)
		const job = (await f.files.state.list("jobs")).find((j) => j.type === "preparation" && j.state === "failed")
		await f.files.state.put("jobs", job.jobId, { ...job, cleanup: { state: "cleaned" } })
		await f.settle()
		const terminal = f.checkpoints.filter((c) => c.outcome === "failed")
		assert.equal(terminal.length, 1); assert.equal(terminal[0].permitId, permit.permitId)
		assert.equal(terminal[0].mode, disposition === "expired" ? "settlement" : "publication")
		assert.equal((await f.adapter.demoStatus()).demo.retry.action, "retry-setup")
		assert.equal((await f.files.state.list("holds")).filter((h) => h.reason.startsWith("owned-demo-initial:")).length, 0)
		assert.equal(f.permits.length, permitCount); assert.equal(f.reader.calls, calls)
	})
})

async function pastDeadline(f, work) {
	// Advance only the wall-clock observation. Keep the durable deadline and every
	// original permit unchanged so expiry cannot masquerade as a new attempt.
	const now = Date.now; Date.now = () => Date.parse(f.demo.attempt.deadlineAt) + 1000
	try { return await work() } finally { Date.now = now }
}

async function interruptedMap(t) {
	const f = await fixture(t), processing = f.config.processingFactory
	let entered, release; const paused = new Promise((r) => { entered = r }), blocked = new Promise((r) => { release = r })
	t.after(() => release())
	f.config.processingFactory = (workspace) => {
		workspace.representationQuery = async () => { entered(); await blocked; throw new FileError(503, "draining", "Stopped before placement query dispatch.") }
		return processing()
	}
	await f.open(); await paused
	const inFlight = f.files.demo.inflight, retained = structuredClone(f.files.demo.record.retention), permit = structuredClone(f.permits.find((p) => p.stage === "map"))
	assert.equal(retained.holds.length, 1)
	assert.equal(await f.files.state.get("operations", retained.identity.operationId), null)
	assert.equal(f.files.demo.record.deferredMapFailure, undefined)
	await f.files.captures.hold("capture", retained.sources[0].captureId, "another-owner", "expiry-foreign-hold")
	f.files.startup.closeAdmission(); f.demo.paused = true; release()
	await assert.rejects(inFlight, { error: "draining" })
	await Promise.allSettled([...f.files.gis.pending]); await f.files.close()
	f.config.processingFactory = processing
	return { f, retained, permit }
}

test("expired interruption: staged and partially installed files settle the original grant once, preserve bytes and allow explicit same-owner retry", async (t) => {
	for (const point of ["staged", "staged-partial", "installed-member"]) await t.test(point, async (t) => {
		const f = await fixture(t)
		f.config.ownedDemo.installCheckpoint = async (stage) => { if (stage === (point === "staged-partial" ? "staged" : point)) throw new Error("Interrupted file installation") }
		await assert.rejects(f.open(), /Interrupted file installation/)
		const permit = structuredClone(f.permits[0]), stageRoot = path.join(f.base, "state/demo-stage")
		if (point === "staged-partial") await fs.truncate(path.join(stageRoot, "README.md"), 4)
		const staged = await fs.stat(path.join(stageRoot, "README.md")), stageBytes = await fs.readFile(path.join(stageRoot, "README.md")), rootEntries = await fs.readdir(f.root), installed = point === "installed-member" && await fs.stat(path.join(f.root, "README.md"))
		assert.notEqual(f.adapter.workspace.demo.record.files, "published")
		const checkpoint = f.adapter.demoCheckpoint.bind(f.adapter)
		f.adapter.demoCheckpoint = async (body) => {
			assert.equal(f.adapter.workspace.safeFs, undefined, "Expired file effects must settle before native workspace initialization.")
			await Promise.race([f.adapter.workspace.startup.publication(async () => {}), wait(500).then(() => { throw new Error("Checkpoint transport held the namespace barrier") })])
			const result = await checkpoint(body); assert.equal(result.readinessAccepted, false); return result
		}
		f.adapter.loseResponse = "failed"
		await pastDeadline(f, async () => {
			await assert.rejects(f.open(), /injected response lost/)
			const pending = structuredClone(f.adapter.workspace.demo.record.pendingCheckpoint)
			assert.equal(pending.mode, "settlement"); assert.equal(pending.permitId, permit.permitId)
			await assert.rejects(f.open(), { error: "demo_attempt_expired" })
			await assert.rejects(f.open(), { error: "demo_attempt_expired" })
			assert.equal(f.checkpoints.length, 1); assert.deepEqual(f.checkpoints[0], pending)
			assert.equal(f.checkpoints[0].outcome, "failed"); assert.equal(f.checkpoints[0].error, "demo_attempt_expired")
			const status = await f.adapter.demoStatus()
			assert.equal(status.permits.files.state, "failed"); assert.equal(status.demo.retry.action, "retry-setup")
			assert.equal(status.demo.initialPreparationState, "failed"); assert.equal(f.adapter.workspace.demo.bootstrap(), undefined)
			assert.notEqual(f.adapter.workspace.demo.record.files, "published")
		})
		assert.deepEqual(await fs.readdir(f.root), rootEntries)
		assert.equal((await fs.stat(path.join(stageRoot, "README.md"))).ino, staged.ino)
		assert.deepEqual(await fs.readFile(path.join(stageRoot, "README.md")), stageBytes)
		if (installed) assert.equal((await fs.stat(path.join(f.root, "README.md"))).ino, installed.ino)
		assert.equal(f.permits.length, 1)
		// Models backend-controlled stop/start after explicit safe retry, not resume.
		f.adapter.demoCheckpoint = checkpoint; f.config.ownedDemo.installCheckpoint = null
		f.demo.retryRevision++; f.demo.filesState = "pending"; f.demo.attempt = { startedAt: new Date().toISOString(), deadlineAt: new Date(Date.now() + 600000).toISOString(), failedAt: null }
		await f.open(); await f.settle(); assert.equal(f.demo.filesState, "ready"); assert.equal(f.demo.mapState, "ready")
		if (installed) assert.equal((await fs.stat(path.join(f.root, "README.md"))).ino, installed.ino)
	})
})

test("expired interruption: a fully committed file receipt settles publication without reseeding later owned deletions", async (t) => {
	const f = await fixture(t)
	f.config.ownedDemo.installCheckpoint = async (stage) => { if (stage === "published") throw new Error("Interrupted after file commit") }
	await assert.rejects(f.open(), /Interrupted after file commit/)
	const permit = structuredClone(f.permits[0]); await fs.rm(path.join(f.root, "README.md"))
	f.config.ownedDemo.installCheckpoint = null
	await pastDeadline(f, async () => {
		await f.open(); await f.settle(); await f.restart(); await f.settle()
		assert.equal(f.checkpoints.length, 1); assert.equal(f.checkpoints[0].permitId, permit.permitId)
		assert.equal(f.checkpoints[0].outcome, "files-ready"); assert.equal(f.checkpoints[0].mode, "settlement")
		assert.equal(f.files.demo.bootstrap(), undefined); assert.equal(f.permits.length, 1)
		await assert.rejects(fs.stat(path.join(f.root, "README.md")), { code: "ENOENT" })
	})
})

test("expired interruption: stopped partial map grants settle safely after restart and retain uncertain cleanup until confirmed", async (t) => {
	for (const disposition of ["safe", "unsafe"]) await t.test(disposition, async (t) => {
		const { f, retained, permit } = await interruptedMap(t)
		if (disposition === "unsafe") {
			// Reopen through the ordinary state worker before expiry so the fixture can
			// persist a realistic unconfirmed terminal native cleanup observation.
			const { FileState } = await import("../lib/file-state.js"), state = await FileState.open({ dir: path.join(f.base, "state") })
			const job = (await state.list("jobs")).find((j) => j.type === "preparation")
			await state.put("jobs", job.jobId, { ...job, cleanup: { state: "indeterminate" } }); await state.close()
		}
		await pastDeadline(f, async () => {
			if (disposition === "safe") f.adapter.loseResponse = "failed"
			await f.open()
			if (disposition === "unsafe") {
				await assert.rejects(f.settle(), { error: "operation_indeterminate" })
				assert.equal(f.checkpoints.filter((c) => c.outcome === "failed").length, 0)
				const status = await f.adapter.demoStatus(); assert.equal(status.permits.map.state, "granted"); assert.equal(status.demo.retry.action, "none"); assert.equal(status.demo.initialPreparationState, "failed")
				for (const h of retained.holds) assert.ok(await f.files.state.get("holds", h.holdId))
				await f.restart(); await assert.rejects(f.settle(), { error: "operation_indeterminate" })
				const job = (await f.files.state.list("jobs")).find((j) => j.type === "preparation")
				await f.files.state.put("jobs", job.jobId, { ...job, cleanup: { state: "cleaned" } }); f.adapter.loseResponse = "failed"
			}
			await assert.rejects(f.settle(), /injected response lost/)
			const pending = structuredClone(f.files.demo.record.pendingCheckpoint)
			assert.equal(pending.mode, "settlement"); assert.equal(pending.permitId, permit.permitId)
			await f.restart(); await f.settle(); await f.restart(); await f.settle()
			const reports = f.checkpoints.filter((c) => c.outcome === "failed")
			assert.equal(reports.length, 1); assert.deepEqual(reports[0], pending)
			assert.equal((await f.adapter.demoStatus()).permits.map.state, "failed"); assert.equal((await f.adapter.demoStatus()).demo.retry.action, "retry-setup")
			assert.equal(f.files.demo.bootstrap(), undefined); assert.equal(f.files.demo.record.mapSaveOperationId, retained.identity.operationId)
			assert.equal(await f.files.state.get("operations", retained.identity.operationId), null)
			for (const h of retained.holds) assert.equal(await f.files.state.get("holds", h.holdId), null)
			assert.ok(await f.files.state.get("holds", "expiry-foreign-hold"))
			assert.equal(f.permits.length, 2); assert.equal(f.reader.calls, 1)
		})
	})
})

test("expired interruption: file and map settlement never adopts changed owner, epoch or retry authority", async (t) => {
	for (const stage of ["files", "map"]) for (const change of ["runtime", "epoch", "revision"]) await t.test(`${stage}-${change}`, async (t) => {
		let f
		if (stage === "map") ({ f } = await interruptedMap(t))
		else { f = await fixture(t); f.config.ownedDemo.installCheckpoint = async (point) => { if (point === "installed-member") throw new Error("Interrupted file installation") }; await assert.rejects(f.open(), /Interrupted file installation/) }
		const checkpointCount = f.checkpoints.length, permit = f.permits.find((p) => p.stage === stage), rootEntries = await fs.readdir(f.root)
		if (change === "runtime") permit.runtimeId = "another-runtime"
		if (change === "revision") f.demo.retryRevision++
		if (change === "epoch") { const db = new Database(path.join(f.base, "state/files.sqlite")); db.prepare("UPDATE identity SET workspace_epoch=?").run(crypto.randomUUID()); db.close() }
		await pastDeadline(f, async () => {
			if (stage === "files") await assert.rejects(f.open(), { error: "demo_owner_fenced" })
			else {
				await f.open(); await assert.rejects(f.files.demo.runMap(), { error: "demo_owner_fenced" })
				// FileState reads are epoch-scoped. Inspect the original scope to prove
				// that rejection did not delete another epoch's exact retained holds.
				const db = new Database(path.join(f.base, "state/files.sqlite"), { readonly: true })
				try { for (const id of ["expiry-foreign-hold", ...f.files.demo.record.retention.holds.map((h) => h.holdId)]) assert.ok(db.prepare("SELECT value FROM records WHERE epoch=? AND kind='holds' AND id=?").get(permit.workspaceEpoch, id)) }
				finally { db.close() }
				assert.equal(f.files.demo.record.retention.releasedAt, undefined)
			}
		})
		assert.equal(f.checkpoints.length, checkpointCount); assert.equal(permit.state, "granted"); assert.deepEqual(await fs.readdir(f.root), rootEntries)
	})
})

// A step rejected before its claim settles as never admitted.
const recording = () => { const entries = []; const add = (level) => (message, fields) => entries.push({ level, message, fields }); return { entries, info: add("info"), warn: add("warn"), error: add("error") } }
const ownedHolds = async (f) => (await f.files.state.list("holds")).filter((h) => h.reason.startsWith("owned-demo-initial:"))
const failedMap = (f) => f.checkpoints.filter((c) => c.outcome === "failed" && f.permits.find((p) => p.permitId === c.permitId)?.stage === "map")
const unavailableGis = { state: "unavailable", reason: "confinement-probe", diagnostic: "gis-launcher: stage=landlock-abi-query errno=38" }

test("never claimed: a provider unavailable at admission reports one failed checkpoint and logs its cause once (R2, R5)", async (t) => {
	const log = recording(), f = await fixture(t, { logger: log }); f.reader.availability = unavailableGis
	await f.open(); await f.settle(); await f.settle()
	assert.equal(f.demo.mapState, "failed")
	assert.deepEqual(failedMap(f).map((c) => c.error), ["gis_unavailable"])
	const requests = await f.files.state.list("requests")
	assert.equal(requests.filter((r) => r.type === "capture" && r.state === "succeeded").length, 1, "The first capture was claimed and settled.")
	assert.equal(requests.filter((r) => r.type === "preparation").length, 0, "The rejected preparation was never claimed.")
	assert.equal((await ownedHolds(f)).length, 0)
	assert.equal((await f.adapter.demoStatus()).demo.retry.action, "retry-setup")
	const causes = log.entries.filter((e) => e.message === "demo map step failed")
	assert.equal(causes.length, 1); assert.equal(causes[0].fields.error, "gis_unavailable"); assert.match(causes[0].fields.availability.diagnostic, /landlock-abi-query/)
})

test("never claimed: a capture rejected before its claim fails the attempt without retaining inputs (R2)", async (t) => {
	const f = await fixture(t), processing = f.config.processingFactory
	f.config.processingFactory = (workspace) => { const create = workspace.captures.create.bind(workspace.captures); let once = true; workspace.captures.create = async (input) => { if (once) { once = false; throw new FileError(429, "capacity", "Capture queue is full.", { retryAfter: 1 }) } return create(input) }; return processing() }
	await f.open(); await f.settle()
	assert.deepEqual(failedMap(f).map((c) => c.error), ["capacity"])
	assert.equal((await f.files.state.list("requests")).filter((r) => r.type === "capture").length, 0)
	assert.equal((await ownedHolds(f)).length, 0)
})

test("never claimed: a map save rejected before its claim releases all inputs and a later retry publishes once (R2)", async (t) => {
	const f = await fixture(t), processing = f.config.processingFactory
	f.config.processingFactory = (workspace) => { const save = workspace.mapViewSave.bind(workspace); let once = true; workspace.mapViewSave = async (...args) => { if (once) { once = false; throw new FileError(429, "capacity", "Mutation admission is full.") } return save(...args) }; return processing() }
	await f.open(); await f.settle()
	assert.equal(f.files.demo.record.mapDispatchIntent, true)
	assert.ok(!await f.files.state.get("operations", f.files.demo.record.mapSaveOperationId), "The rejected save was never claimed.")
	assert.deepEqual(failedMap(f).map((c) => c.error), ["capacity"]); assert.equal((await ownedHolds(f)).length, 0)
	f.demo.retryRevision++; f.demo.mapState = "pending"; await f.settle()
	assert.equal(f.demo.mapState, "ready")
	assert.equal((await f.files.state.list("operations")).filter((o) => o.intent?.path === "maps/overview.map.json" && o.state === "committed").length, 1)
})

test("never claimed: a receipt wedged by an older image settles exactly once on restart (R2)", async (t) => {
	for (const timing of ["before-deadline", "after-deadline"]) await t.test(timing, async (t) => {
		const f = await fixture(t), processing = f.config.processingFactory; f.reader.availability = unavailableGis
		// The older image could not prove a never-claimed request settled, so it never abandoned.
		f.config.processingFactory = (workspace) => { workspace.demo.safelyAbandon = async () => false; return processing() }
		await f.open(); await assert.rejects(f.settle(), { error: "operation_indeterminate" })
		assert.equal(f.files.demo.record.deferredMapFailure.error, "gis_unavailable"); assert.equal(failedMap(f).length, 0); assert.equal((await ownedHolds(f)).length, 1)
		f.config.processingFactory = processing; const permits = f.permits.length
		const upgrade = async () => { await f.restart(); await f.settle() }
		if (timing === "after-deadline") await pastDeadline(f, async () => { f.demo.attempt.failedAt = new Date().toISOString(); await upgrade() })
		else await upgrade()
		const failed = failedMap(f); assert.equal(failed.length, 1); assert.equal(failed[0].error, "gis_unavailable")
		assert.equal(failed[0].mode, timing === "after-deadline" ? "settlement" : "publication")
		assert.equal(f.permits.length, permits, "Settlement takes no new permit."); assert.equal((await ownedHolds(f)).length, 0)
	})
})

test("never claimed: absence counts only after the process's own dispatch settles, and only in the retention's epoch (R2)", async (t) => {
	const f = await fixture(t), processing = f.config.processingFactory; let release, entered
	const blocked = new Promise((resolve) => { release = resolve }), reached = new Promise((resolve) => { entered = resolve })
	f.config.processingFactory = (workspace) => { const prepare = workspace.preparation.bind(workspace); let once = true; workspace.preparation = (input) => { if (!once) return prepare(input); once = false; entered(); return blocked.then(() => prepare(input)) }; return processing() }
	await f.open(); await reached
	const demo = f.files.demo; demo.config.transportMs = 20
	try { // Always release: a failed assertion must not leave closure waiting on the blocked dispatch.
		// A deadline rejection must not forget a dispatch that may still be waiting to claim.
		await assert.rejects(demo.bounded(() => demo.dispatch("probe", () => blocked), new Date(Date.now() + 20).toISOString()), { error: "demo_attempt_expired" })
		assert.ok(demo.dispatches.has("probe"))
		assert.equal(await demo.safelyAbandon(), false); assert.equal(demo.abandonBlocker.state, "outstanding")
		assert.equal(failedMap(f).length, 0)
	} finally { release() }
	await f.settle(); assert.equal(f.demo.mapState, "ready"); assert.ok(!demo.dispatches.has("probe"))
	const r = demo.record.retention
	demo.persist({ retention: { identity: { ...r.identity, operationId: "never-claimed-operation", workspaceEpoch: "another-epoch" }, sources: [], holds: [], requests: ["never-claimed-request"] } })
	assert.equal(await demo.safelyAbandon(), false); assert.equal(demo.abandonBlocker.state, "other-epoch")
})

test("lost acknowledgement: a committed failure replays verbatim after the attempt fails, never under a new request (R4)", async (t) => {
	const f = await fixture(t); f.adapter.strict = true; f.adapter.loseResponse = "failed"
	f.reader.beforeRead = () => { throw new Error("Injected preparation failure") }
	await f.open(); await assert.rejects(f.settle(), /injected response lost/)
	assert.ok(f.demo.attempt.failedAt, "The committed failure already failed the attempt, as the backend does.")
	await f.settle()
	assert.equal(failedMap(f).length, 1, "Exactly one failure body reached the backend.")
	assert.equal(f.files.demo.record.pendingCheckpoint, null); assert.equal(f.files.demo.record.deferredMapFailure, null)
	assert.equal(f.demo.mapState, "failed")
})

test("release with nothing held never touches an unavailable capture store (R3)", async (t) => {
	const f = await fixture(t); await f.open(); await f.settle()
	const demo = f.files.demo, captures = f.files.captures.withRetention
	f.files.captures.withRetention = () => { throw new FileError(503, "capture_store_unavailable", "Protected source storage is unavailable.") }
	try {
		demo.persist({ retention: { identity: demo.record.retention.identity, sources: [], holds: [], requests: [] } })
		assert.equal((await demo.releaseBindings("abandoned-attempt")).released, 0); assert.ok(demo.record.retention.releasedAt)
	} finally { f.files.captures.withRetention = captures }
})

test("claim evidence outlives its record: a claimed ID whose record is gone is never read as unclaimed (R2)", async (t) => {
	const f = await fixture(t); await f.open(); await f.settle(); assert.equal(f.demo.mapState, "ready")
	const demo = f.files.demo, capture = (await f.files.state.list("requests")).find((r) => r.type === "capture")
	assert.equal(await f.files.state.wasClaimed("requests", capture.requestId), true)
	assert.equal(await f.files.state.wasClaimed("requests", "never-admitted"), false)
	await f.files.state.delete("requests", capture.requestId)
	demo.persist({ mapOutcome: null, retention: { identity: { ...demo.record.retention.identity, operationId: "never-claimed-operation" }, sources: [], holds: [], requests: [capture.requestId] } })
	assert.equal(await demo.safelyAbandon(), false)
	assert.deepEqual(demo.abandonBlocker, { kind: "request", id: capture.requestId, state: "record-missing" })
})

test("observer: identical failures log once and back off instead of polling every tick (R6)", async (t) => {
	const log = recording(), f = await fixture(t, { logger: log }); f.config.ownedDemo.pollMs = 10; f.config.ownedDemo.maxBackoffMs = 80
	await f.open(); await f.settle()
	let calls = 0; f.adapter.demoStatus = async () => { calls++; throw new FileError(503, "backend_unavailable", "Backend unavailable.") }
	await wait(400)
	assert.equal(log.entries.filter((e) => e.level === "error").length, 1, JSON.stringify(log.entries.map((e) => e.fields)))
	assert.ok(calls <= 12, `Back-off must space ${calls} status calls in 400 ms.`)
})
