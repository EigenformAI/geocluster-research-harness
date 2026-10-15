import crypto from "node:crypto"
import path from "node:path"
import { FILE_LIMITS, FileError, canonicalPath, capturedSourceIdentity, fileError, identifier, stableStringify } from "./file-contract.js"

const terminal = new Set(["succeeded", "failed", "cancelled", "interrupted"])
const kinds = new Set(["vector", "raster", "assay"])
const now = () => new Date().toISOString()
const put = (kind, id, value) => ({ type: "put", kind, id, value })
const failure = (status, error, message, details = {}) => new FileError(status, error, message, { agent: "file-service", tool: "file-gis", action: "Inspect the captured input set, provider readiness and advertised limits, then submit a new request if needed.", ...details })
const report = (error) => { const e = fileError(error, "file-gis"); return { status: e.status, ...e.toJSON() } }
const fromReport = (e) => failure(e.status || 503, e.error, e.message, e)
const missingIndex = (error) => error?.status === 410 && error.error === "index_expired"
const strict = (value, keys, name) => { if (!value || typeof value !== "object" || Array.isArray(value) || Object.keys(value).some((k) => !keys.includes(k))) throw failure(400, "invalid_request", `${name} contains unsupported fields.`) }
const same = (a, b) => stableStringify(capturedSourceIdentity(a)) === stableStringify(capturedSourceIdentity(b))
const sha = (source) => source?.digest?.state === "ready" ? source.digest.sha256 : null
const checkDigest = (source, verified) => { if (source?.digest?.state === "ready" && (!/^[0-9a-f]{64}$/.test(sha(source) || "") || verified && sha(source) !== verified)) throw failure(409, "source_changed", "The supplied SHA-256 contradicts verified retained-byte evidence.") }
const integer = (value, fallback, max, name, min = 0) => { const n = value === undefined ? fallback : value; if (!Number.isSafeInteger(n) || n < min || n > max) throw failure(400, "invalid_budget", `${name} must be an integer from ${min} to ${max}.`); return n }
const strings = (value) => Array.isArray(value) && value.every((v) => typeof v === "string")
const count = (value) => Number.isSafeInteger(value) && value >= 0
const nullableString = (value) => value === null || typeof value === "string"
const recordObject = (value) => value !== null && typeof value === "object" && !Array.isArray(value)
const extent = (value) => value === null || Array.isArray(value) && value.length === 4 && value.every(Number.isFinite) && value[0] <= value[2] && value[1] <= value[3]
const axisMapping = (value) => value === null || Array.isArray(value) && value.every(Number.isSafeInteger)
const field = (value) => value && typeof value.name === "string" && typeof value.type === "string" && count(value.width) && count(value.precision)
const rasterNumber = (value) => value === null || typeof value === "string" || Number.isFinite(value)
const formats = { vector: ["geojson", "json", "shp", "tab", "mif", "gpkg"], raster: ["tif", "tiff", "ers"], assay: ["csv", "tsv"] }
const readerLimitKeys = { inputBytes: "gisInputBytes", members: "gisMembers", responseBytes: "gisResponseBytes", elapsedMs: "gisElapsedMs", features: "gisFeatures", positions: "gisPositions", pageSize: "gisAttributeRows", pageMaxSize: "gisAttributeRows", bands: "gisBands", previewEdge: "gisPreviewEdge", memoryBytes: "gisMemoryBytes", sourcePixels: "gisSourcePixels", decodedBlockBytes: "gisDecodedBlockBytes", assayRows: "gisAssayRows", assayPoints: "gisAssayPoints", assayColumns: "gisAssayColumns", assayCellBytes: "gisAssayCellBytes", assayManifestBytes: "gisAssayManifestBytes", assayResponseBytes: "gisAssayResponseBytes" }

/** GIS products use the existing capture/index journal, holds, readers and leases. */
export class FileGis {
	constructor(workspace) {
		this.workspace = workspace; this.config = workspace.config; this.captures = workspace.captures; this.state = workspace.state; this.limits = { ...FILE_LIMITS, ...workspace.limits }
		this.tasks = new Map(); this.pending = new Set(); this.controllers = new Set(); this.admissionTail = Promise.resolve(); this.build = "unavailable"; this.availability = { state: "unavailable", reason: "reader-unavailable" }
		this.limits.gisAttributeOffset = Math.min(this.limits.gisAttributeOffset, 1000000)
	}
	async init() {
		if (this.captures.availability.state !== "available") { this.availability = this.captures.availability; return }
		await this.recover()
		if (this.config.filesGisWorkerEnabled === false && !this.config.filesGisReader) { this.availability = { state: "unavailable", reason: "disabled" }; return }
		try {
			const config = { launcherPath: this.config.filesGisWorkerBin, limits: Object.fromEntries(Object.entries(readerLimitKeys).map(([name, key]) => [name, this.limits[key]])) }
			if (this.config.filesGisReader) this.reader = typeof this.config.filesGisReader === "function" ? await this.config.filesGisReader(config, this.workspace.logger) : this.config.filesGisReader
			else { const { GisReader } = await import("./gis-reader.js"); this.reader = new GisReader(config, this.workspace.logger) }
			await this.reader.init(); this.availability = { ...this.reader.availability }; const build = this.availability.build || this.reader.build || "unavailable"; this.build = typeof build === "string" ? build : stableStringify(build)
			for (const [name, key] of Object.entries(readerLimitKeys)) if (Number.isSafeInteger(this.reader.limits?.[name]) && this.reader.limits[name] > 0) this.limits[key] = Math.min(this.limits[key], this.reader.limits[name])
			if (this.availability.confinement === "verified" && Number.isSafeInteger(this.availability.build?.dataMemoryBytes)) this.limits.gisMemoryBytes = this.availability.build.dataMemoryBytes
		} catch (error) { this.availability = { state: "unavailable", reason: error.code === "ERR_MODULE_NOT_FOUND" ? "reader-unavailable" : "reader-startup" }; this.startupError = report(error) }
	}
	publicLimits() { return Object.fromEntries(Object.entries(this.limits).filter(([key]) => key.startsWith("gis")).map(([key, value]) => [key[3].toLowerCase() + key.slice(4), value])) }
	manifestLimit(kind) { return kind === "assay" ? this.limits.gisAssayManifestBytes : this.limits.gisManifestBytes }
	responseLimit(kind) { return kind === "assay" ? this.limits.gisAssayResponseBytes : this.limits.gisResponseBytes }
	descriptors() {
		return [...kinds].map((kind) => ({ id: kind, build: this.build, readiness: { ...this.availability }, inputFormats: this.availability.state === "available" ? formats[kind].filter((format) => !this.reader.inputFormats || this.reader.inputFormats.includes(format)) : [], ...(kind === "raster" ? { tiffMetadata: "embedded-only" } : {}), unavailableFormats: kind === "assay" ? [] : [{ format: "ecw", reason: "decoder-unavailable" }], queryOperations: kind === "vector" ? ["prepare", "preview", "attributes"] : kind === "raster" ? ["prepare", "preview", "map-display"] : ["prepare", "preview"], queryScope: kind === "assay" ? "complete-recorded-assay-product" : kind === "vector" ? "complete-geometry-or-attribute-page" : "bounded-image-or-map-display", limits: this.publicLimits() }))
	}
	eligible(name, size) { const format = path.posix.extname(name).slice(1).toLowerCase(); return this.availability.state === "available" && count(size) && size <= this.limits.gisInputBytes && this.descriptors().some((p) => p.inputFormats.includes(format)) ? [format] : [] }
	track(work) { this.pending.add(work); work.finally(() => this.pending.delete(work)).catch(() => {}); return work }
	async waitForSettlement(jobId) { identifier(jobId, "jobId"); await this.tasks.get(jobId)?.promise }
	requireAdmission() { this.captures.requireAdmission(); if (this.closed || this.draining || this.workspace.draining) throw failure(503, "draining", "GIS admission is draining."); if (this.availability.state !== "available") throw failure(503, "gis_unavailable", "The GIS reader is unavailable.", { reason: this.availability.reason }) }
	async recover() {
		for (let job of await this.state.list("jobs")) {
			if (job.type !== "preparation" || !kinds.has(job.preparationType)) continue
			if (!terminal.has(job.state)) { job = { ...job, state: "interrupted", stage: "interrupted", result: null, error: report(failure(503, "job_interrupted", "GIS preparation stopped before settlement. Submit a new request ID.")), finishedAt: now() }; await this.state.put("jobs", job.jobId, job) }
			for (const id of job.requestIds || [job.requestId]) { const request = await this.state.get("requests", id); if (request && !terminal.has(request.state)) await this.state.put("requests", id, { ...request, state: job.state, result: job.result, error: job.error, finishedAt: job.finishedAt }) }
			for (const id of job.holdIds || []) await this.captures.releaseHold(id)
		}
		for (const request of await this.state.list("requests")) if (request.type === "preparation" && kinds.has(request.preparationType) && !terminal.has(request.state)) await this.state.put("requests", request.requestId, { ...request, state: "interrupted", error: report(failure(503, "job_interrupted", "GIS admission was interrupted. Submit a new request ID.")), finishedAt: now() })
		for (const index of await this.state.list("workbook-indexes")) if (!index.evictedAt && kinds.has(index.manifest?.kind)) {
			try { const opened = await this.open(index.id); await opened.release() } catch (error) { if (error.status === 410) await this.state.put("workbook-indexes", index.id, { ...index, unavailable: report(error) }); else this.workspace.logger.warn?.("GIS restart validation failed", { representationId: index.id, ...report(error) }) }
		}
	}
	inputSources(input) {
		strict(input, ["requestId", "type", "source", "companions", "options"], "GIS preparation"); identifier(input.requestId, "requestId")
		if (!kinds.has(input.type)) throw failure(400, "unsupported_provider", "Choose workbook, vector, raster or assay preparation.")
		if (input.type === "assay") this.assayOptions(input.options)
		else strict(input.options === undefined ? {} : input.options, [], "GIS options")
		const companions = input.companions === undefined ? [] : input.companions
		if (!Array.isArray(companions) || companions.length >= this.limits.gisMembers) throw failure(400, "invalid_source", "Supply a bounded list of complete captured companions.")
		const sources = [input.source, ...companions]
		for (const source of sources) { if (source?.kind !== "runtime-capture" || !source.ref || !source.digest || !["not-requested", "pending", "ready", "failed"].includes(source.digest.state)) throw failure(400, "invalid_source", "GIS preparation requires complete CapturedSource inputs."); identifier(source.captureId, "captureId"); canonicalPath(source.ref.path, { root: false }); checkDigest(source) }
		return [sources[0], ...sources.slice(1).sort((a, b) => a.ref.path < b.ref.path ? -1 : a.ref.path > b.ref.path ? 1 : 0)]
	}
	assayOptions(options) {
		strict(options, ["mode", "columns", "collars", "sourceCrs", "allowApproximate", "unit", "depthUnit", "depthWindow", "numbers", "environmentFingerprint"], "Assay recipe")
		const text = (v, max, empty = false) => typeof v === "string" && (empty || v.length > 0) && Buffer.byteLength(v) <= max && !/[\u0000\ud800-\udfff]/u.test(v)
		if (!["surface", "collar-summary"].includes(options.mode)) throw failure(400, "invalid_request", "Choose surface or collar-summary mode.")
		const columns = (value, required, qualifier = false) => { strict(value, [...required, ...(qualifier ? ["qualifier"] : [])], "Assay columns"); if (required.some((k) => !text(value[k], 256)) || value.qualifier !== undefined && !text(value.qualifier, 256) || new Set(Object.values(value)).size !== Object.keys(value).length) throw failure(400, "invalid_request", "Select distinct, bounded source column names."); return { ...value } }
		const surface = options.mode === "surface", result = { mode: options.mode, columns: columns(options.columns, surface ? ["id", "x", "y", "analyte"] : ["hole", "from", "to", "analyte"], true) }
		strict(options.sourceCrs, ["code", "axisOrder"], "Assay source CRS")
		if (typeof options.sourceCrs.code !== "string" || !/^(?:EPSG:[1-9][0-9]{0,6}|OGC:CRS84)$/.test(options.sourceCrs.code) || !["xy", "yx"].includes(options.sourceCrs.axisOrder)) throw failure(400, "invalid_request", "Select an EPSG code or OGC:CRS84 and explicit XY or YX order.")
		result.sourceCrs = { ...options.sourceCrs }
		strict(options.unit, ["name", "basis"], "Assay unit")
		if (!text(options.unit.name, 128) || !["user-assigned", "source-declared"].includes(options.unit.basis)) throw failure(400, "invalid_request", "Record a unit name and its assignment basis.")
		result.unit = { ...options.unit }; result.allowApproximate = options.allowApproximate ?? false
		if (typeof result.allowApproximate !== "boolean" || options.allowApproximate === null) throw failure(400, "invalid_request", "allowApproximate must be boolean.")
		if (options.environmentFingerprint !== undefined) { if (!text(options.environmentFingerprint, 256)) throw failure(400, "invalid_request", "Invalid projection environment fingerprint."); result.environmentFingerprint = options.environmentFingerprint }
		if (surface) { if (["collars", "depthUnit", "depthWindow"].some((k) => k in options)) throw failure(400, "invalid_request", "Surface recipes cannot contain collars or depth windows.") }
		else {
			strict(options.collars, ["member", "columns"], "Collar recipe")
			if (typeof options.collars.member !== "string" || !/^[A-Za-z0-9][A-Za-z0-9_. -]{0,127}$/.test(options.collars.member) || options.collars.member.includes("..") || options.collars.member.endsWith(" ") || options.depthUnit !== "m") throw failure(400, "invalid_request", "Select a captured collar basename and record depthUnit m.")
			result.collars = { member: options.collars.member, columns: columns(options.collars.columns, ["hole", "x", "y"]) }; result.depthUnit = "m"
			const window = options.depthWindow === undefined ? { kind: "whole-hole" } : options.depthWindow
			strict(window, window?.kind === "range" ? ["kind", "from", "to"] : ["kind"], "Depth window")
			if (!["whole-hole", "range"].includes(window.kind) || window.kind === "range" && (![window.from, window.to].every(Number.isFinite) || window.from < 0 || window.to <= window.from)) throw failure(400, "invalid_request", "Depth ranges require finite 0 <= from < to in metres.")
			result.depthWindow = { ...window }
		}
		const numbers = options.numbers === undefined ? {} : options.numbers; strict(numbers, ["missingTokens", "sentinels"], "Number conventions")
		const missingTokens = numbers.missingTokens === undefined ? ["", "NA", "N/A", "NULL"] : numbers.missingTokens, sentinels = numbers.sentinels === undefined ? [] : numbers.sentinels
		if (!Array.isArray(missingTokens) || missingTokens.length > 32 || missingTokens.some((v) => !text(v, 128, true)) || !Array.isArray(sentinels) || sentinels.length > 32 || !sentinels.every(Number.isFinite)) throw failure(400, "invalid_request", "Supply bounded missing tokens and finite numerical sentinels.")
		result.numbers = { missingTokens: [...missingTokens], sentinels: [...sentinels] }; return result
	}
	validateBundle(members, kind, options = {}) {
		const names = members.map((m) => m.name), folded = names.map((n) => n.toLowerCase()), primary = folded[0], extension = path.posix.extname(primary).slice(1), stem = primary.slice(0, -(extension.length + 1)), ref = members[0].source.ref
		if (new Set(folded).size !== names.length || new Set(members.map((m) => m.source.captureId)).size !== names.length) throw failure(422, "gis_bundle_ambiguous", "Input basenames or captures are duplicated after case folding.")
		if (names.some((n) => !/^[A-Za-z0-9][A-Za-z0-9_. -]{0,127}$/.test(n) || n.includes("..") || n.endsWith(" "))) throw failure(422, "gis_bundle_member", "GIS member basenames must fit the installed reader's named-input rules.")
		for (const m of members) { const { path: p, ...root } = m.source.ref, { path: primaryPath, ...primaryRoot } = ref; if (stableStringify(root) !== stableStringify(primaryRoot) || kind !== "assay" && path.posix.dirname(p) !== path.posix.dirname(primaryPath)) throw failure(422, "gis_bundle_parent", "Captured inputs must share the authorized workspace root; GIS bundles also require one parent directory.") }
		if (!formats[kind].includes(extension)) throw failure(415, extension === "ecw" ? "gis_decoder_unavailable" : "gis_format_unsupported", "This primary format is unavailable for the selected GIS provider.")
		if (kind === "assay") {
			if (folded.some((n) => !/\.(csv|tsv)$/.test(n))) throw failure(415, "gis_format_unsupported", "Assay inputs must be captured CSV or TSV tables.")
			if (options.mode === "surface" && members.length !== 1) throw failure(422, "gis_bundle_member", "Surface recipes require exactly one primary table.")
			if (options.mode === "collar-summary" && (members.length !== 2 || names[1] !== options.collars.member)) throw failure(422, members.length < 2 ? "gis_bundle_missing" : "gis_bundle_member", "Capture exactly the collar companion named in the recipe.")
			return
		}
		const required = extension === "shp" ? [`${stem}.shx`, `${stem}.dbf`] : extension === "mif" ? [`${stem}.mid`] : []
		if (required.some((n) => !folded.includes(n)) || extension === "ers" && members.length < 2 || extension === "tab" && [/(?:\.dat|\.dbf)$/, /\.map$/, /\.id$/].some((role) => !folded.slice(1).some((n) => role.test(n)))) throw failure(422, "gis_bundle_missing", "Required GIS companions are missing. Capture the complete member set explicitly.")
		if (["tif", "tiff"].includes(extension) && members.length > 1) throw failure(422, "gis_bundle_member", "TIFF previews require embedded metadata and masks. External companions are unsupported.")
		const allowed = extension === "shp" ? ["shx", "dbf", "prj", "cpg"] : extension === "mif" ? ["mid"] : []
		if (extension !== "ers" && folded.slice(1).some((n) => !allowed.some((ext) => n === `${stem}.${ext}`) && !(extension === "tab" && /\.(dat|dbf|map|id)$/.test(n)))) throw failure(422, "gis_bundle_member", "The bundle contains an unsupported or unrelated companion.")
		// The reader verifies declared TAB/ERS names and rejects open GPKG snapshots before GDAL opens them.
	}
	prepare(input) { return this.track(this.prepareRequest(input)) }
	async prepareRequest(input) {
		const supplied = this.inputSources(input), options = input.type === "assay" ? this.assayOptions(input.options) : input.options ?? {}, intent = { type: "preparation", preparationType: input.type, inputs: supplied.map(capturedSourceIdentity), options }
		return this.captures.serial.call(this, "admissionTail", async () => {
			const prior = await this.state.get("requests", input.requestId)
			if (prior) {
				if (stableStringify(prior.intent) !== stableStringify(intent)) throw failure(409, "request_id_reused", "The request ID belongs to a different preparation intent.")
				for (const s of supplied) checkDigest(s, sha((await this.state.get("captures", s.captureId))?.source) || prior.result?.representation?.inputs.find((i) => i.source.captureId === s.captureId)?.sha256)
				return this.answer(prior)
			}
			this.requireAdmission()
			const request = { requestId: input.requestId, type: "preparation", preparationType: input.type, intent, suppliedDigests: supplied.map(sha), state: "accepted", jobId: null, acceptedAt: now(), result: null, error: null }
			await this.state.claim("requests", request.requestId, intent, request)
			try {
				return await this.captures.withRetention(async () => {
					const members = []
					for (const s of supplied) { const record = await this.captures.record("capture", s.captureId), handle = await this.captures.privateFile(record); await handle.close(); if (!same(record.source, s)) throw failure(409, "source_changed", "A supplied input contradicts its authoritative immutable capture binding."); checkDigest(s, sha(record.source)); members.push({ name: path.posix.basename(record.source.ref.path), source: record.source }) }
					this.validateBundle(members, input.type, options)
					const total = members.reduce((sum, m) => sum + m.source.sizeBytes, 0)
					if (!Number.isSafeInteger(total) || total > this.limits.gisInputBytes) throw failure(413, "gis_input_limit", "The captured input set exceeds the aggregate byte ceiling.")
					const key = stableStringify([this.state.identity, input.type, members.map((m) => capturedSourceIdentity(m.source)), this.build, options])
					let resident = (await this.state.list("workbook-indexes")).find((i) => i.preparationKey === key && !i.evictedAt)
					if (resident) {
						const index = await this.captures.record("index", resident.id)
						if (index.unavailable && !missingIndex(index.unavailable)) throw fromReport(index.unavailable)
						await this.captures.validateIndexInputs(index)
						for (const [n, m] of index.manifest.inputs.entries()) checkDigest(supplied[n], m.sha256)
						let handle
						try { handle = await this.captures.privateFile(index) }
						catch (error) {
							if (!missingIndex(error)) throw error
							// Only new admission rebuilds missing derived bytes, after all retained inputs
							// validate. Retire the old ID and its byte accounting; historical receipts stay terminal.
							await this.state.put("workbook-indexes", index.id, { ...index, evictedAt: now(), cleanupPending: false })
							resident = undefined
						}
						if (resident) {
							try { if (index.unavailable) throw fromReport(index.unavailable); await this.readManifest(index, handle) } finally { await handle.close() }
							const result = await this.readyLocked(index.manifest, 200)
							await this.state.put("requests", request.requestId, { ...request, state: "succeeded", result, finishedAt: now() }); return result
						}
					}
					const shared = [...this.tasks.values()].find((t) => t.key === key && !terminal.has(t.job.state))
					if (shared) { for (const [n, source] of supplied.entries()) checkDigest(source, shared.inputDigests?.[n]?.sha256); shared.job.requestIds.push(request.requestId); await this.state.transaction([put("jobs", shared.job.jobId, shared.job), put("requests", request.requestId, { ...request, state: shared.job.state, jobId: shared.job.jobId })]); return { status: 202, jobId: shared.job.jobId } }
					const nativeRelease = this.workspace.acquireNative()
					try {
						const jobId = crypto.randomUUID(), id = crypto.randomUUID(), dependencies = members.map((m) => ({ kind: "capture", id: m.source.captureId })), holdIds = members.map((_, n) => `gis-${jobId}-${n}`)
						const job = { jobId, requestId: request.requestId, requestIds: [request.requestId], type: "preparation", preparationType: input.type, state: "queued", stage: "queued", holdIds, source: dependencies[0], dependencies, resultRef: id, acceptedAt: now(), progress: { bytesDone: 0, totalBytes: total, elapsedMs: 0 }, result: null, error: null }
						await this.captures.reserveIndex({ id: jobId, jobId, representationId: id, preparationType: input.type, sizeBytes: 2 * this.manifestLimit(input.type), createdAt: now() }, [...holdIds.map((holdId, n) => put("holds", holdId, { holdId, source: dependencies[n], reason: "gis", jobId, createdAt: now() })), put("jobs", jobId, job), put("requests", request.requestId, { ...request, state: "queued", jobId })])
						const task = { job, id, key, members, total, options, nativeRelease, controller: new AbortController() }; this.tasks.set(jobId, task)
						task.promise = new Promise((resolve) => { task.start = resolve }); this.track(task.promise); queueMicrotask(() => task.start(this.run(task)))
						return { status: 202, jobId }
					} catch (error) { nativeRelease(); throw error }
				})
			} catch (error) { await this.state.put("requests", request.requestId, { ...request, state: "failed", error: report(error), finishedAt: now() }); throw error }
		})
	}
	async readyLocked(manifest, status) {
		const leases = manifest.inputs.map((i) => this.captures.makeLease("capture", i.source.captureId))
		await this.state.transaction(leases.map((l) => put("leases", l.leaseId, l)))
		const primary = await this.captures.record("capture", manifest.source.captureId)
		return { status, representation: manifest, source: primary.source, leases }
	}
	async answer(request) {
		if (request.error && terminal.has(request.state)) throw fromReport(request.error)
		if (!request.result) return { status: 202, jobId: request.jobId }
		const opened = await this.open(request.result.representation.id)
		try {
			if (stableStringify(opened.manifest) !== stableStringify(request.result.representation) || stableStringify(opened.manifest.inputs.map((i) => capturedSourceIdentity(i.source))) !== stableStringify(request.intent.inputs)) throw failure(410, "representation_unavailable", "The exact completed input set or manifest is unavailable.")
			return await this.captures.withRetention(() => this.readyLocked(opened.manifest, 200))
		} finally { await opened.release() }
	}
	validateAssay(product, members, options) {
		const invalid = (message) => { throw failure(422, "invalid_gis_result", message) }
		let recipe
		try { recipe = this.assayOptions(options) } catch { invalid("Assay metadata lacks a valid recorded recipe.") }
		const sameJson = (a, b) => stableStringify(a) === stableStringify(b), surface = recipe.mode === "surface", trim = (s) => s.replace(/^[ \t\r\n]+|[ \t\r\n]+$/g, "")
		const scalar = (s) => typeof s === "string" && Buffer.byteLength(s) <= this.limits.gisAssayCellBytes && !/[\u0000\ud800-\udfff]/u.test(s)
		const geometry = (g, geographic = false) => recordObject(g) && g.type === "Point" && Array.isArray(g.coordinates) && g.coordinates.length === 2 && g.coordinates.every(Number.isFinite) && (!geographic || Math.abs(g.coordinates[0]) <= 180 && Math.abs(g.coordinates[1]) <= 90)
		const value = (v, summary = false) => recordObject(v) && ["detected", summary ? "all-censored" : "censored", "missing", "invalid"].includes(v.state) && (v.state === "detected" ? Number.isFinite(v.value) && v.qualifier === null : v.state === "censored" ? (v.value === null || Number.isFinite(v.value)) && ["<", "<=", "ND"].includes(v.qualifier) : v.value === null && (v.qualifier === null || !summary && ["<", "<=", "ND"].includes(v.qualifier)))
		if (!recordObject(product) || product.schemaVersion !== 1 || product.kind !== "assay" || product.parser !== "bounded-gdal-assay-v1" || !sameJson(product.recipe, recipe) || !sameJson(product.unit, recipe.unit) || product.summaryRule !== (surface ? "source-value" : "maximum-detected") || typeof product.coverage !== "string" || !strings(product.warnings) || !/^[0-9a-f]{64}$/.test(product.operationFingerprint || "") || !Array.isArray(product.tables) || product.tables.length !== members.length || members.length !== (surface ? 1 : 2) || !Array.isArray(product.rows) || !Array.isArray(product.collarRows) || !Array.isArray(product.points) || !Array.isArray(product.diagnostics)) invalid("Invalid recorded assay product envelope or recipe binding.")
		if (product.rows.length > this.limits.gisAssayRows || product.collarRows.length > this.limits.gisAssayRows || product.points.length > this.limits.gisAssayPoints) throw failure(413, "assay_row_limit", "Recorded assay rows or points exceed their complete-product ceiling.")
		for (const [n, table] of product.tables.entries()) if (!recordObject(table) || table.memberName !== members[n].name || table.format !== path.posix.extname(table.memberName).slice(1).toLowerCase() || !["csv", "tsv"].includes(table.format) || table.dataRows !== (n === 0 ? product.rows.length : product.collarRows.length) || !strings(table.columns) || table.columns.length < 1 || table.columns.length > this.limits.gisAssayColumns || new Set(table.columns).size !== table.columns.length || table.columns.some((s) => !scalar(s) || !s.length) || Object.values(n === 0 ? recipe.columns : recipe.collars.columns).some((s) => !table.columns.includes(s))) invalid("Assay table inventory does not bind every selected captured member and column.")
		if (surface && product.collarRows.length || !surface && product.tables[1].memberName !== recipe.collars.member) invalid("Recorded collar table does not match the recipe.")
		const lineage = (row, table, ordinal) => recordObject(row) && row.memberName === table.memberName && row.recordOrdinal === ordinal && row.locator === `${row.memberName}:${ordinal}` && scalar(row.id) && recordObject(row.raw)
		const raw = (row, keys) => Object.keys(row.raw).length === keys.length && keys.every((k) => scalar(row.raw[k]))
		const rowMap = new Map(), collars = new Map(), collarIds = new Map()
		for (const [n, row] of product.collarRows.entries()) {
			if (!lineage(row, product.tables[1], n + 2) || !raw(row, ["hole", "x", "y"]) || row.id !== trim(row.raw.hole) || typeof row.duplicate !== "boolean" || !(row.geometry === null || geometry(row.geometry))) invalid("Invalid collar row lineage or native point.")
			collars.set(row.locator, row); if (row.id) { if (!collarIds.has(row.id)) collarIds.set(row.id, []); collarIds.get(row.id).push(row) }
		}
		for (const row of product.collarRows) if (row.duplicate !== Boolean(row.id && collarIds.get(row.id).length > 1)) invalid("Collar ambiguity evidence contradicts the retained rows.")
		const calculated = Object.fromEntries(["dataRows", "collarRows", "points", "mapped", "unmapped", "detected", "censored", "missing", "invalid", "duplicateCollarIds", "duplicateCollarRows", "unmatchedRows", "ambiguousRows", "invalidDepthRows", "outsideWindowRows", "invalidCoordinateRows", "missingIdRows"].map((k) => [k, 0]))
		calculated.dataRows = product.rows.length; calculated.collarRows = product.collarRows.length; calculated.points = product.points.length
		for (const list of collarIds.values()) if (list.length > 1) { calculated.duplicateCollarIds++; calculated.duplicateCollarRows += list.length }
		for (const row of product.collarRows) { if (row.geometry === null) calculated.invalidCoordinateRows++; if (!row.id) calculated.missingIdRows++ }
		for (const [n, row] of product.rows.entries()) {
			if (!lineage(row, product.tables[0], n + 2) || !raw(row, surface ? ["id", "x", "y", "analyte", "qualifier"] : ["hole", "from", "to", "analyte", "qualifier"]) || row.id !== trim(row.raw[surface ? "id" : "hole"]) || !value(row.value)) invalid("Invalid assay row, raw cell evidence, value category or locator.")
			rowMap.set(row.locator, row); calculated[row.value.state]++; if (!row.id) calculated.missingIdRows++
			if (surface) { if (row.joinState !== "surface" || row.depth !== null) invalid("Surface row contains collar interpretation.") }
			else {
				const d = row.depth, c = collarIds.get(row.id), join = !row.id ? "missing-id" : !c ? "unmatched" : c.length > 1 ? "ambiguous" : "matched"
				if (row.joinState !== join || !recordObject(d) || typeof d.valid !== "boolean" || typeof d.inWindow !== "boolean" || (d.valid ? ![d.from, d.to].every(Number.isFinite) || d.from < 0 || d.to <= d.from : d.from !== null || d.to !== null) || d.inWindow !== (d.valid && (recipe.depthWindow.kind === "whole-hole" || d.to > recipe.depthWindow.from && d.from < recipe.depthWindow.to))) invalid("Assay join or half-open depth evidence is inconsistent.")
				if (join === "unmatched") calculated.unmatchedRows++; if (join === "ambiguous") calculated.ambiguousRows++; if (!d.valid) calculated.invalidDepthRows++; else if (!d.inWindow) calculated.outsideWindowRows++
			}
		}
		const points = new Map(), contributing = new Set()
		for (const p of product.points) {
			const origin = surface ? rowMap.get(p?.locator) : collars.get(p?.locator)
			if (!origin || points.has(p.locator) || p.memberName !== origin.memberName || p.recordOrdinal !== origin.recordOrdinal || p.id !== origin.id || !p.id || !geometry(p.geometry) || p.locationMeaning !== (surface ? "surface-sample" : "collar-summary") || !value(p.value, !surface) || !strings(p.rowLocators) || surface && !p.rowLocators.length || new Set(p.rowLocators).size !== p.rowLocators.length || !strings(p.maximumLocators) || new Set(p.maximumLocators).size !== p.maximumLocators.length || p.rowLocators.some((locator) => !rowMap.has(locator) || contributing.has(locator))) invalid("Assay point lacks unique source-bound lineage or valid native geometry.")
			points.set(p.locator, p); for (const locator of p.rowLocators) contributing.add(locator)
			const contributors = p.rowLocators.map((locator) => rowMap.get(locator)), detected = contributors.filter((r) => r.value.state === "detected"), max = detected.length ? Math.max(...detected.map((r) => r.value.value)) : null
			const maxima = detected.filter((r) => r.value.value === max).map((r) => r.locator)
			if (!sameJson(p.maximumLocators, maxima)) invalid("Assay maximum locators disagree with detected contributing values.")
			if (surface) { if (!sameJson(p.rowLocators, [origin.locator]) || !sameJson(p.value, origin.value)) invalid("Surface point does not retain its source value.") }
			else {
				const state = detected.length ? "detected" : contributors.some((r) => r.value.state === "invalid") ? "invalid" : contributors.some((r) => r.value.state === "censored") ? "all-censored" : "missing"
				if (origin.duplicate || !sameJson(p.geometry, origin.geometry) || contributors.some((r) => r.id !== p.id || r.joinState !== "matched" || !r.depth.inWindow) || p.value.state !== state || p.value.value !== max || p.value.qualifier !== null) invalid("Collar maximum or censored/missing/invalid summary is inconsistent.")
			}
		}
		if (!surface && product.rows.some((r) => r.joinState === "matched" && r.depth.inWindow && collarIds.get(r.id)[0].geometry !== null && !contributing.has(r.locator))) invalid("Assay product omitted an eligible collar contributor.")
		if (!surface && product.collarRows.some(r => r.id && !r.duplicate && r.geometry !== null && !points.has(r.locator))) invalid("Assay product omitted a valid unambiguous collar, including a missing-only summary.")
		const p = product.placement, frame = p?.sourceFrame, coverage = p?.coverage
		if (!recordObject(p) || !["ready", "unavailable"].includes(p.state) || p.displayCrs !== "OGC:CRS84" || !recordObject(p.displayByLocator) || !extent(p.extent) || typeof p.environmentFingerprint !== "string" || !p.environmentFingerprint || recipe.environmentFingerprint !== undefined && recipe.environmentFingerprint !== p.environmentFingerprint || !strings(p.reasons) || !recordObject(frame) || frame.basis !== "user-assumed" || typeof frame.wkt !== "string" || !frame.wkt || !axisMapping(frame.dataAxisMapping) || frame.dataAxisMapping === null || !nullableString(frame.units) || !(p.operation === null || recordObject(p.operation) && typeof p.operation.engine === "string" && p.operation.policy === (recipe.allowApproximate ? "approximate" : "strict") && nullableString(p.operation.identity) && nullableString(p.operation.accuracy)) || !recordObject(coverage)) invalid("Assay placement lacks source-frame or coordinate-operation evidence.")
		for (const [locator, g] of Object.entries(p.displayByLocator)) if (!points.has(locator) || !geometry(g, true)) invalid("CRS84 point is not bound to a native assay point.")
		calculated.mapped = Object.keys(p.displayByLocator).length; calculated.unmapped = product.points.length - calculated.mapped
		if (coverage.sourceFeatures !== product.points.length || coverage.retainedDrawable !== product.points.length || coverage.nullOrEmpty !== 0 || coverage.decodeOmitted !== 0 || coverage.displayed !== calculated.mapped || p.state === "ready" && (p.operation === null || calculated.unmapped !== 0) || p.operation === null && calculated.mapped !== 0 || !sameJson(product.counts, { ...calculated, invalidCoordinateRows: product.counts?.invalidCoordinateRows })) invalid("Assay row, point, join and placement counts disagree.")
		const diagnosticCodes = ["invalid-value", "invalid-coordinate", "missing-id", "duplicate-collar-id", "unmatched-hole", "ambiguous-hole", "invalid-depth", "outside-depth-window", "unplaced-point"], diagnosticMap = new Map()
		for (const d of product.diagnostics) { if (!recordObject(d) || !diagnosticCodes.includes(d.code) || diagnosticMap.has(d.code) || !strings(d.locators) || !d.locators.length || new Set(d.locators).size !== d.locators.length || d.locators.some((l) => !rowMap.has(l) && !collars.has(l))) invalid("Assay diagnostic locators are not bound to retained rows."); diagnosticMap.set(d.code, d.locators) }
		const diagnosticCount = (code) => diagnosticMap.get(code)?.length || 0
		for (const [code, key] of [["invalid-value", "invalid"], ["invalid-coordinate", "invalidCoordinateRows"], ["missing-id", "missingIdRows"], ["duplicate-collar-id", "duplicateCollarRows"], ["unmatched-hole", "unmatchedRows"], ["ambiguous-hole", "ambiguousRows"], ["invalid-depth", "invalidDepthRows"], ["outside-depth-window", "outsideWindowRows"], ["unplaced-point", "unmapped"]]) if (diagnosticCount(code) !== product.counts[key]) invalid("Assay diagnostic counts disagree with recorded outcomes.")
		if (!count(product.counts.invalidCoordinateRows) || !surface && product.counts.invalidCoordinateRows !== calculated.invalidCoordinateRows || surface && product.rows.length - product.points.length > product.counts.invalidCoordinateRows + product.counts.missingIdRows) invalid("Assay coordinate omissions are not accounted for.")
		const bounds = product.limits, expectedBounds = { inputBytes: this.limits.gisInputBytes, rowsPerTable: this.limits.gisAssayRows, points: this.limits.gisAssayPoints, columns: this.limits.gisAssayColumns, cellBytes: this.limits.gisAssayCellBytes, manifestBytes: this.limits.gisAssayManifestBytes, responseBytes: this.limits.gisAssayResponseBytes, timeoutMs: 30000 }
		if (!recordObject(bounds) || Object.entries(expectedBounds).some(([key, ceiling]) => !count(bounds[key]) || bounds[key] < 1 || bounds[key] > ceiling)) invalid("Assay product lacks bounded parsing evidence.")
	}
	validateRasterMap(reply, query) {
		const invalid = () => { throw failure(422, "invalid_gis_result", "GIS worker returned invalid positioned raster evidence.") }
		const frame = reply.sourceFrame, operation = reply.operation, conversion = operation?.displayConversion, coverage = reply.coverage, environment = reply.environment
		if (reply.kind !== "raster-map-display" || reply.state !== "ready" || reply.displayCrs !== "EPSG:3857" || !extent(reply.extent) || reply.extent === null || reply.extent[0] >= reply.extent[2] || reply.extent[1] >= reply.extent[3] || reply.extent.some(n => Math.abs(n) > 20037508.35) || reply.geoTransform === null || !recordObject(frame) || !["declared", "user-assumed"].includes(frame.basis) || typeof frame.wkt !== "string" || !axisMapping(frame.dataAxisMapping) || !nullableString(frame.units)) invalid()
		if (!recordObject(operation) || typeof operation.engine !== "string" || operation.policy !== (query.displayOptions?.allowApproximate === true ? "approximate" : "strict") || !nullableString(operation.identity) || !nullableString(operation.accuracy) || operation.sourceTargetCrs !== "OGC:CRS84" || operation.inverse !== "Exact inverse of the selected source operation" || !recordObject(conversion) || conversion.sourceCrs !== "OGC:CRS84" || conversion.targetCrs !== "EPSG:3857" || typeof conversion.identity !== "string" || typeof conversion.pipeline !== "string") invalid()
		if (stableStringify(reply.displayOptions) !== stableStringify(query.displayOptions || {}) || typeof reply.environmentFingerprint !== "string" || !reply.environmentFingerprint.length || reply.environmentFingerprint.length > 256 || query.displayOptions?.environmentFingerprint !== undefined && query.displayOptions.environmentFingerprint !== reply.environmentFingerprint || !recordObject(environment) || typeof environment.gdal !== "string" || typeof environment.proj !== "string" || environment.fingerprint !== reply.environmentFingerprint || environment.networkEnabled !== false) invalid()
		const ring = reply.footprint?.coordinates?.[0]
		if (reply.footprint?.type !== "Polygon" || !Array.isArray(reply.footprint.coordinates) || reply.footprint.coordinates.length !== 1 || !Array.isArray(ring) || ring.length < 5 || ring.length > 4097 || stableStringify(ring[0]) !== stableStringify(ring.at(-1)) || ring.some(p => !Array.isArray(p) || p.length !== 2 || !p.every(Number.isFinite) || p[0] < reply.extent[0] - 1e-6 || p[0] > reply.extent[2] + 1e-6 || p[1] < reply.extent[1] - 1e-6 || p[1] > reply.extent[3] + 1e-6)) invalid()
		if (!recordObject(coverage) || ["outputPixels", "sampledSourcePixels", "visiblePixels", "transparentPixels", "decodedBlockBytes", "footprintEdgeSegments"].some(k => !count(coverage[k])) || coverage.outputPixels !== reply.image.width * reply.image.height || coverage.visiblePixels + coverage.transparentPixels !== coverage.outputPixels || coverage.visiblePixels > coverage.sampledSourcePixels || coverage.sampledSourcePixels > coverage.outputPixels || coverage.decodedBlockBytes > this.limits.gisDecodedBlockBytes || coverage.footprintEdgeSegments < 1 || coverage.footprintEdgeSegments > 1024 || reply.image.stretch.label !== "Display stretch") invalid()
		const stretch = reply.image.stretch
		if (coverage.visiblePixels ? ![stretch.minimum, stretch.maximum].every(Number.isFinite) || stretch.minimum > stretch.maximum : stretch.minimum !== null || stretch.maximum !== null) invalid()
		const ceilings = { inputBytes: this.limits.gisInputBytes, bands: this.limits.gisBands, previewEdge: this.limits.gisPreviewEdge, sourcePixels: this.limits.gisSourcePixels, decodedBlockBytes: this.limits.gisDecodedBlockBytes, outputBytes: this.limits.gisResponseBytes, memoryBytes: this.limits.gisMemoryBytes, timeoutMs: 30000 }
		if (Object.entries(ceilings).some(([k, ceiling]) => !count(reply.limits[k]) || reply.limits[k] < 1 || reply.limits[k] > ceiling)) invalid()
	}
	validateReply(reply, members, operation, kind, query = {}) {
		const mapDisplay = kind === "raster" && operation === "map-display"
		if (!reply || typeof reply !== "object" || !strings(reply.warnings) || typeof reply.parser !== "string" || (mapDisplay ? !recordObject(reply.coverage) : typeof reply.coverage !== "string") || "sources" in reply || "representationId" in reply) throw failure(422, "invalid_gis_result", "GIS worker returned an invalid product envelope.")
		if (!Array.isArray(reply.inputDigests) || reply.inputDigests.length !== members.length || reply.inputDigests.some((d, n) => d.name !== members[n].name || !/^[0-9a-f]{64}$/.test(d.sha256 || ""))) throw failure(422, "invalid_gis_result", "GIS worker did not verify every named input in order.")
		for (const [n, m] of members.entries()) { checkDigest(m.source, reply.inputDigests[n].sha256); if (m.sha256 && m.sha256 !== reply.inputDigests[n].sha256) throw failure(409, "source_changed", "GIS query did not process the retained preparation bytes.") }
		if (kind === "assay") this.validateAssay(reply, members, query)
		else if (kind === "raster") {
			if (reply.schemaVersion !== 1 || !["GTiff", "ERS"].includes(reply.driver) || !count(reply.width) || !count(reply.height) || reply.width < 1 || reply.height < 1 || reply.width * reply.height > this.limits.gisSourcePixels || !count(reply.bandCount) || reply.bandCount < 1 || reply.bandCount > this.limits.gisBands || !Array.isArray(reply.bands) || reply.bands.length !== reply.bandCount || reply.bands.some((b, n) => b.band !== n + 1 || typeof b.dataType !== "string") || !reply.image || reply.image.band !== (query.band || 1) || !count(reply.image.width) || !count(reply.image.height) || reply.image.width < 1 || reply.image.height < 1 || Math.max(reply.image.width, reply.image.height) > this.limits.gisPreviewEdge || typeof reply.image.dataUrl !== "string" || !reply.image.dataUrl.startsWith("data:image/png;base64,") || reply.image.resampling !== "nearest" || reply.image.scaleOffsetApplied !== false || reply.image.colorTableApplied !== false) throw failure(422, "invalid_gis_result", "GIS worker returned invalid raster metadata or sampled image bounds.")
			if (reply.parser !== (mapDisplay ? "bounded-gdal-raster-map-v1" : "bounded-gdal-raster-v1") || typeof reply.driverVersion !== "string" || !nullableString(reply.crsWkt) || !(reply.geoTransform === null || Array.isArray(reply.geoTransform) && reply.geoTransform.length === 6 && reply.geoTransform.every(Number.isFinite)) || !recordObject(reply.limits) || ["inputBytes", "bands", "previewEdge", "outputBytes", "memoryBytes", "timeoutMs"].some((k) => !count(reply.limits[k]) || reply.limits[k] < 1) || reply.bands.some((b) => typeof b.description !== "string" || !rasterNumber(b.nodata) || !nullableString(b.unit) || !rasterNumber(b.scale) || !rasterNumber(b.offset) || typeof b.colorInterpretation !== "string" || !count(b.colorTableEntries) || !strings(b.maskFlags) || !Array.isArray(b.overviews) || b.overviews.some((o) => !count(o.width) || !count(o.height))) || reply.image.overviewSelection !== (mapDisplay ? "base-resolution" : "GDAL-auto") || reply.image.stretch?.kind !== "sample-min-max" || ![reply.image.stretch.minimum, reply.image.stretch.maximum].every((n) => n === null || Number.isFinite(n))) throw failure(422, "invalid_gis_result", "GIS worker returned incomplete raster provenance.")
			if (mapDisplay) this.validateRasterMap(reply, query)
		} else if (operation === "manifest") {
			if (reply.schemaVersion !== 1 || !Array.isArray(reply.layers) || new Set(reply.layers.map((l) => l.id)).size !== reply.layers.length || reply.layers.some((l) => typeof l.id !== "string" || typeof l.name !== "string" || !Array.isArray(l.fields) || !l.fields.every(field) || !nullableString(l.crsWkt) || !axisMapping(l.axisMapping) || !(l.reportedFeatureCount === null || count(l.reportedFeatureCount)))) throw failure(422, "invalid_gis_result", "GIS worker returned invalid vector layer metadata.")
		} else if (operation === "attributes") {
			if (reply.schemaVersion !== 1 || reply.layerId !== query.layerId || reply.offset !== query.offset || reply.limit !== query.limit || reply.geometryCoverage !== "not-requested" || !count(reply.scannedFeatures) || !(reply.reportedFeatureCount === null || count(reply.reportedFeatureCount)) || !Array.isArray(reply.rows) || reply.rows.length > query.limit || reply.scannedFeatures < reply.rows.length || !(reply.nextOffset === null || reply.rows.length > 0 && reply.nextOffset === query.offset + reply.rows.length) || reply.rows.some((r) => typeof r.locator !== "string" || "geometry" in r || !recordObject(r.properties) || r.sourceId !== undefined && typeof r.sourceId !== "string") || new Set(reply.rows.map((r) => r.locator)).size !== reply.rows.length) throw failure(422, "invalid_gis_result", "GIS worker returned invalid geometry-free attribute paging evidence.")
		} else {
			if (reply.schemaVersion !== 3 || !Array.isArray(reply.layers) || !reply.displayOptions) throw failure(422, "invalid_gis_result", "GIS worker returned an invalid vector preview.")
			let features = 0, positions = 0
			const geometry = (g, depth = 0) => {
				if (g === null) return
				if (!g || depth > 24 || !["Point", "MultiPoint", "LineString", "MultiLineString", "Polygon", "MultiPolygon", "GeometryCollection"].includes(g.type)) throw failure(422, "invalid_gis_result", "GIS worker returned invalid native geometry.")
				if (g.type === "GeometryCollection") { if (!Array.isArray(g.geometries) || g.geometries.some((c) => c === null)) throw failure(422, "invalid_gis_result", "Invalid geometry collection."); for (const child of g.geometries) geometry(child, depth + 1); return }
				const coordinates = (c, nesting) => { if (!Array.isArray(c)) throw failure(422, "invalid_gis_result", "Invalid geometry coordinates."); if (nesting) { for (const child of c) coordinates(child, nesting - 1) } else { if (c.length === 0) return; if (c.length < 2 || !c.every(Number.isFinite)) throw failure(422, "invalid_gis_result", "Invalid geometry position."); positions++; if (positions > this.limits.gisPositions) throw failure(413, "vector_position_limit", "Vector geometry exceeds the position ceiling.") } }
				coordinates(g.coordinates, { Point: 0, MultiPoint: 1, LineString: 1, MultiLineString: 2, Polygon: 2, MultiPolygon: 3 }[g.type])
			}
			for (const l of reply.layers) {
				const p = l.placement, frame = p?.sourceFrame
				if (typeof l.id !== "string" || typeof l.name !== "string" || !Array.isArray(l.features) || !strings(l.fields) || l.fieldDefinitions !== undefined && (!Array.isArray(l.fieldDefinitions) || !l.fieldDefinitions.every(field)) || !strings(l.geometryTypes) || !extent(l.extent) || !count(l.positionCount) || typeof l.coordinateLabel !== "string" || !Array.isArray(l.crsDeclarations) || !nullableString(l.plotWarning) || !p || !["ready", "unavailable"].includes(p.state) || p.displayCrs !== "OGC:CRS84" || !recordObject(p.displayByLocator) || !extent(p.extent) || typeof p.environmentFingerprint !== "string" || !strings(p.reasons) || !frame || !["declared", "format-convention", "user-assumed", "unknown", "conflicting"].includes(frame.basis) || !nullableString(frame.wkt) || !axisMapping(frame.dataAxisMapping) || !nullableString(frame.units) || !(p.operation === null || recordObject(p.operation) && typeof p.operation.engine === "string" && ["strict", "approximate"].includes(p.operation.policy) && nullableString(p.operation.identity) && nullableString(p.operation.accuracy)) || !recordObject(p.coverage) || ["sourceFeatures", "retainedDrawable", "nullOrEmpty", "decodeOmitted", "displayed"].some((k) => !count(p.coverage[k]))) throw failure(422, "invalid_gis_result", "GIS worker returned invalid vector placement.")
				features += l.features.length; if (features > this.limits.gisFeatures) throw failure(413, "vector_feature_limit", "Vector geometry exceeds the feature ceiling.")
				const before = positions, locators = new Set(), drawableLocators = new Set()
				for (const f of l.features) {
					if (typeof f.locator !== "string" || locators.has(f.locator) || !(f.properties === null || recordObject(f.properties)) || f.sourceId !== undefined && typeof f.sourceId !== "string" && !Number.isFinite(f.sourceId)) throw failure(422, "invalid_gis_result", "Invalid feature locator or attributes.")
					locators.add(f.locator)
					const start = positions; geometry(f.geometry)
					if (positions > start) drawableLocators.add(f.locator)
				}
				const drawable = drawableLocators.size
				if (l.positionCount !== positions - before || p.coverage.sourceFeatures !== l.features.length || p.coverage.retainedDrawable !== drawable || p.coverage.nullOrEmpty !== l.features.length - drawable || p.coverage.decodeOmitted !== 0 || p.coverage.displayed !== Object.keys(p.displayByLocator).length || p.coverage.displayed > drawable) throw failure(422, "invalid_gis_result", "Vector geometry and placement coverage disagree with the returned features.")
				// Display geometry has its own copy of the position budget.
				const nativePositions = positions; positions = 0
				for (const [locator, g] of Object.entries(l.placement.displayByLocator)) {
					if (!drawableLocators.has(locator)) throw failure(422, "invalid_gis_result", "Display geometry is not bound to a nonempty native feature.")
					const start = positions; geometry(g)
					if (positions === start) throw failure(422, "invalid_gis_result", "Displayed geometry must contain retained coordinates.")
				}
				positions = nativePositions
			}
		}
		const { inputDigests, ...payload } = reply
		return { payload, inputDigests }
	}
	async run(task) {
		let opened, stage, settled = false
		const started = Date.now(), timer = setTimeout(() => { task.timedOut = true; task.controller.abort() }, this.limits.gisElapsedMs)
		try {
			if (task.controller.signal.aborted) throw failure(409, "job_cancelled", "GIS preparation was cancelled.")
			task.job = { ...task.job, state: "running", stage: "parsing" }; await this.state.put("jobs", task.job.jobId, task.job)
			opened = await this.openMembers(task.members)
			if (task.controller.signal.aborted) throw failure(409, "job_cancelled", "GIS preparation stopped before native dispatch.")
			const reply = await this.reader.read({ members: opened.members, kind: task.job.preparationType, operation: "manifest", options: task.options, signal: task.controller.signal })
			if (task.controller.signal.aborted) throw failure(409, "job_cancelled", "GIS work stopped after cancellation.")
			const { payload, inputDigests } = this.validateReply(reply, opened.members, "manifest", task.job.preparationType, task.options)
			task.inputDigests = inputDigests
			const inputs = task.members.map((m, n) => ({ name: m.name, source: m.source, sha256: inputDigests[n].sha256 }))
			for (const id of task.job.requestIds) { const r = await this.state.get("requests", id); for (const [n, claimed] of (r.suppliedDigests || []).entries()) if (claimed && claimed !== inputs[n].sha256) throw failure(409, "source_changed", "A supplied SHA-256 contradicts the processed retained bytes.") }
			const manifest = { schemaVersion: 1, kind: task.job.preparationType, id: task.id, source: inputs[0].source, inputs, ...(task.job.preparationType === "assay" ? { options: task.options } : {}), consistency: { basis: inputs.length === 1 ? "single-capture" : "independent-captures", limitations: inputs.length === 1 ? [] : ["The input captures do not establish an atomic cross-file snapshot."] }, provider: { id: task.job.preparationType, build: this.build }, parser: payload.parser, metadata: payload, limits: this.publicLimits(), retention: "input-captures" }
			const bytes = Buffer.from(JSON.stringify(manifest))
			if (bytes.length > this.manifestLimit(manifest.kind)) throw failure(413, manifest.kind === "assay" ? "assay_manifest_limit" : "gis_manifest_limit", "The GIS manifest exceeds its byte ceiling.")
			if (manifest.kind === "assay") {
				const primary = await this.captures.record("capture", manifest.source.captureId)
				if (Buffer.byteLength(JSON.stringify({ filesContractVersion: 1, representation: manifest, source: primary.source, leases: manifest.inputs.map((i) => this.captures.makeLease("capture", i.source.captureId)) })) > this.responseLimit("assay")) throw failure(413, "assay_response_limit", "The complete assay preparation response exceeds its byte ceiling.")
			}
			stage = await this.captures.staging(task.id)
			const reservation = await this.state.get("index-reservations", task.job.jobId)
			await this.state.put("index-reservations", task.job.jobId, { ...reservation, stagingBasename: this.captures.stageNames.get(stage), candidate: this.captures.activeStages.get(this.captures.stageNames.get(stage)) })
			await this.captures.write(stage.handle, bytes, 0)
			// The protected JSON blob and the manifest serialized in FileState are
			// separate stored copies; reserve/account both through the existing index policy.
			await this.captures.publish(stage, { id: task.id, kind: "index", source: manifest.source, dependencies: task.job.dependencies, manifest, metadataBytes: bytes.length, preparationKey: task.key, reservationId: task.job.jobId, sizeBytes: bytes.length, createdAt: now(), lastAccessAt: now() }, { task })
			const result = await this.captures.withRetention(() => this.readyLocked(manifest, 201))
			await this.settle(task, "succeeded", result, null, started); settled = true
		} catch (error) {
			if (task.controller.signal.aborted && !stage?.preserve) error = failure(409, "job_cancelled", "GIS preparation stopped after cancellation.")
			if (task.timedOut && !stage?.preserve) error = failure(408, "gis_time_limit", "GIS preparation exceeded its elapsed-work ceiling.")
			if (stage?.published) error = failure(503, "storage_unavailable", "GIS publication completed but its terminal receipt could not be confirmed.", { state: "indeterminate", inspectionRef: `index/${task.id}`, cause: report(error) })
			await this.settle(task, task.controller.signal.aborted && !task.timedOut && !stage?.preserve ? "cancelled" : "failed", null, report(error), started); settled = true
		} finally {
			clearTimeout(timer)
			try { await opened?.release(); await this.captures.cleanup(stage); if (settled && !stage?.preserve) await this.captures.withRetention(async () => { await this.state.delete("index-reservations", task.job.jobId); for (const id of task.job.holdIds) await this.state.delete("holds", id) }); else if (settled && stage?.published && !task.job.error?.state) for (const id of task.job.holdIds) await this.captures.releaseHold(id) }
			catch (error) { task.job = { ...task.job, cleanup: { state: "indeterminate", error: report(error) } }; await this.state.put("jobs", task.job.jobId, task.job) }
			finally { this.tasks.delete(task.job.jobId); task.nativeRelease() }
		}
	}
	async settle(task, state, result, error, started) {
		return this.captures.serial.call(this, "admissionTail", async () => {
			task.job = { ...task.job, state, stage: state === "succeeded" ? "complete" : state, result, error, finishedAt: now(), progress: { bytesDone: state === "succeeded" ? task.total : 0, totalBytes: task.total, elapsedMs: Date.now() - started } }
			const ops = [put("jobs", task.job.jobId, task.job)]
			for (const id of task.job.requestIds) { const r = await this.state.get("requests", id); ops.push(put("requests", id, { ...r, state, result, error, finishedAt: task.job.finishedAt })) }
			await this.state.transaction(ops); this.workspace.events.publish("job", { jobId: task.job.jobId, state, stage: task.job.stage, resultRef: state === "succeeded" ? task.id : null })
		})
	}
	async membersLocked(inputs, representation = true) {
		const readers = [], members = []
		try {
			for (const input of inputs) {
				const record = await this.captures.record("capture", input.source.captureId)
				if (!same(record.source, input.source)) throw failure(410, "representation_unavailable", "A retained GIS input binding is unavailable.")
				checkDigest(record.source, input.sha256)
				const reader = await this.captures.reader(record); readers.push(reader); members.push({ ...input, handle: reader.handle, source: record.source })
				await this.state.put("captures", record.id, { ...record, lastAccessAt: now() })
			}
			return { members, release: async () => { await Promise.all(readers.map((r) => r.release())) } }
		} catch (error) { await Promise.all(readers.map((r) => r.release())); if (representation && error.error === "transfer_source_missing") throw failure(410, "representation_unavailable", "Retained GIS member bytes are missing."); throw error }
	}
	openMembers(inputs) { return this.captures.withRetention(() => this.membersLocked(inputs, false)) }
	async readManifest(index, handle) {
		if (!count(index.sizeBytes) || index.sizeBytes > this.manifestLimit(index.manifest?.kind)) throw failure(410, "representation_unavailable", "Retained GIS metadata exceeds its byte ceiling.")
		const bytes = await this.captures.readPrefix(handle, index.sizeBytes)
		try { if (bytes.length !== index.sizeBytes || stableStringify(JSON.parse(bytes.toString("utf8"))) !== stableStringify(index.manifest)) throw failure(410, "representation_unavailable", "Retained GIS JSON does not match its published manifest.") }
		catch (error) { if (error instanceof SyntaxError) throw failure(410, "representation_unavailable", "Retained GIS JSON is invalid."); throw error }
		if (index.manifest.kind === "assay") this.validateAssay(index.manifest.metadata, index.manifest.inputs, index.manifest.options)
	}
	async open(id) {
		identifier(id, "representationId")
		return this.captures.withRetention(async () => {
			const index = await this.captures.record("index", id)
			if (!kinds.has(index.manifest?.kind)) throw failure(400, "representation_kind", "This operation requires a GIS representation.")
			if (index.unavailable) throw fromReport(index.unavailable)
			if (!this.captures.validIndexDependencies(index)) throw failure(410, "representation_unavailable", "GIS dependency metadata is unavailable.")
			const opened = await this.membersLocked(index.manifest.inputs)
			let indexReader
			try {
				indexReader = await this.captures.reader(index)
				await this.readManifest(index, indexReader.handle)
				await this.state.put("workbook-indexes", id, { ...index, lastAccessAt: now() })
				return { ...opened, manifest: index.manifest, release: async () => { try { await indexReader.release() } finally { await opened.release() } } }
			} catch (error) { await indexReader?.release(); await opened.release(); throw error }
		})
	}
	async get(id) { const opened = await this.open(id); try { return opened.manifest } finally { await opened.release() } }
	normalize(input, manifest) {
		if (manifest.kind === "assay") { strict(input, ["operation"], "Assay preview query"); if (input.operation !== "preview") throw failure(400, "invalid_operation", "Assay representations support recorded preview queries."); return { operation: "preview" } }
		if (manifest.kind === "raster") {
			const positioned = input?.operation === "map-display"
			strict(input, ["operation", "band", ...(positioned ? ["displayOptions"] : [])], "Raster query")
			if (!["preview", "map-display"].includes(input.operation)) throw failure(400, "invalid_operation", "Raster representations support preview or map-display queries.")
			const band = integer(input.band, 1, manifest.metadata.bandCount, "band", 1)
			if (!positioned) return { operation: "preview", band }
			const displayOptions = input.displayOptions === undefined ? {} : input.displayOptions
			strict(displayOptions, ["environmentFingerprint", "sourceCrs", "allowApproximate"], "Raster display options")
			if (displayOptions.environmentFingerprint !== undefined && (typeof displayOptions.environmentFingerprint !== "string" || displayOptions.environmentFingerprint.length > 256) || displayOptions.allowApproximate !== undefined && typeof displayOptions.allowApproximate !== "boolean") throw failure(400, "invalid_request", "Invalid raster display options.")
			if (displayOptions.sourceCrs !== undefined) { strict(displayOptions.sourceCrs, ["code", "axisOrder"], "Raster source CRS"); const c = displayOptions.sourceCrs; if (typeof c.code !== "string" || !/^(?:EPSG:[1-9][0-9]{0,6}|OGC:CRS84)$/.test(c.code) || !["xy", "yx"].includes(c.axisOrder)) throw failure(400, "invalid_request", "Select an EPSG code or OGC:CRS84 and explicit XY or YX order.") }
			return { operation: "map-display", band, displayOptions }
		}
		if (input?.operation === "attributes") { strict(input, ["operation", "layerId", "offset", "limit"], "Vector attributes query"); if (!manifest.metadata.layers.some((l) => l.id === input.layerId)) throw failure(400, "invalid_layer", "Select a layer from the vector inventory."); return { operation: "attributes", layerId: input.layerId, offset: integer(input.offset, 0, this.limits.gisAttributeOffset, "offset"), limit: integer(input.limit, this.limits.gisAttributeRows, this.limits.gisAttributeRows, "limit", 1) } }
		strict(input, ["operation", "displayOptions"], "Vector preview query"); if (input.operation !== "preview") throw failure(400, "invalid_operation", "Choose preview or attributes for a vector representation.")
		const displayOptions = input.displayOptions === undefined ? {} : input.displayOptions; strict(displayOptions, ["environmentFingerprint", "sourceCrs", "allowApproximate"], "Vector display options")
		if (displayOptions.environmentFingerprint !== undefined && (typeof displayOptions.environmentFingerprint !== "string" || displayOptions.environmentFingerprint.length > 256) || displayOptions.allowApproximate !== undefined && typeof displayOptions.allowApproximate !== "boolean") throw failure(400, "invalid_request", "Invalid vector display options.")
		if (displayOptions.sourceCrs !== undefined) { strict(displayOptions.sourceCrs, ["layerId", "code", "axisOrder"], "Source CRS"); const c = displayOptions.sourceCrs; if (!manifest.metadata.layers.some((l) => l.id === c.layerId) || typeof c.code !== "string" || !/^(?:EPSG:[1-9][0-9]{0,6}|OGC:CRS84)$/.test(c.code) || !["xy", "yx"].includes(c.axisOrder)) throw failure(400, "invalid_request", "Select a known layer, EPSG code or OGC:CRS84, and axis order.") }
		return { operation: "preview", displayOptions }
	}
	query(id, input, signal) { return this.track(this.execute(id, input, signal)) }
	async execute(id, input, signal) {
		this.requireAdmission()
		if (signal?.aborted) throw failure(409, "job_cancelled", "GIS query was cancelled.")
		const opened = await this.open(id)
		let nativeRelease, timer
		const controller = new AbortController(), abort = () => controller.abort(); signal?.addEventListener("abort", abort, { once: true }); if (signal?.aborted) abort()
		try {
			const query = this.normalize(input, opened.manifest), { operation, ...options } = query
			if (opened.manifest.kind === "assay") {
				this.validateAssay(opened.manifest.metadata, opened.members, opened.manifest.options)
				if (controller.signal.aborted) throw failure(409, "job_cancelled", "Assay preview was cancelled.")
				const result = { ...opened.manifest.metadata, sources: opened.members.map((m) => m.source), representationId: id }
				if (Buffer.byteLength(JSON.stringify({ filesContractVersion: 1, ...result })) > this.responseLimit("assay")) throw failure(413, "assay_response_limit", "The recorded assay response exceeds its byte ceiling.")
				return result
			}
			this.requireAdmission()
			nativeRelease = this.workspace.acquireNative(); this.controllers.add(controller)
			let timedOut = false; timer = setTimeout(() => { timedOut = true; controller.abort() }, this.limits.gisElapsedMs)
			let reply
			try { reply = await this.reader.read({ members: opened.members, kind: opened.manifest.kind, operation, options, signal: controller.signal }) } catch (error) { if (timedOut) throw failure(408, "gis_time_limit", "GIS query exceeded its elapsed-work ceiling."); if (controller.signal.aborted) throw failure(409, "job_cancelled", "GIS query stopped after cancellation."); throw error }
			if (controller.signal.aborted) throw failure(timedOut ? 408 : 409, timedOut ? "gis_time_limit" : "job_cancelled", "GIS query stopped before returning a complete result.")
			const { payload } = this.validateReply(reply, opened.members, operation, opened.manifest.kind, query)
			const result = { ...payload, sources: opened.members.map((m) => m.source), representationId: id }
			if (Buffer.byteLength(JSON.stringify({ filesContractVersion: 1, ...result })) > this.limits.gisResponseBytes) throw failure(413, "gis_response_limit", "The GIS query exceeds its response byte ceiling.")
			return result
		} finally { clearTimeout(timer); signal?.removeEventListener("abort", abort); this.controllers.delete(controller); try { await opened.release() } finally { nativeRelease?.() } }
	}
	async cancel(id) { return this.captures.serial.call(this, "admissionTail", async () => { const task = this.tasks.get(id); if (!task || terminal.has(task.job.state)) return this.captures.getJob(id); task.job = { ...task.job, state: "cancel_requested", cancelRequestedAt: now() }; await this.state.put("jobs", id, task.job); task.controller.abort(); return task.job }) }
	async drain(deadline) {
		this.draining = true; await this.admissionTail; for (const task of this.tasks.values()) task.controller.abort(); for (const c of this.controllers) c.abort()
		let timer; try { await Promise.race([Promise.allSettled([...this.pending]), new Promise((resolve) => { timer = setTimeout(resolve, Math.max(0, Date.parse(deadline) - Date.now())) })]) } finally { clearTimeout(timer) }
		const jobs = (await this.state.list("jobs")).filter((j) => j.type === "preparation" && kinds.has(j.preparationType)), publications = (await this.state.list("source-publications")).filter((p) => p.kind === "index" && ["publishing", "indeterminate"].includes(p.state) && kinds.has(p.metadataOperations?.[0]?.value.manifest?.kind)), publicationJobs = new Set(publications.map((p) => p.jobId))
		const receiptIndeterminate = jobs.filter((j) => (j.error?.state === "indeterminate" || j.cleanup?.state === "indeterminate") && !publicationJobs.has(j.jobId)).length, localPending = this.pending.size + jobs.filter((j) => !terminal.has(j.state) && !this.tasks.has(j.jobId)).length, indeterminate = publications.length + receiptIndeterminate
		return { localPending, indeterminate, receiptIndeterminate, failed: jobs.filter((j) => ["failed", "interrupted"].includes(j.state)).length, complete: localPending === 0 && indeterminate === 0 }
	}
	async close() { this.draining = true; await this.admissionTail; for (const t of this.tasks.values()) t.controller.abort(); for (const c of this.controllers) c.abort(); await Promise.allSettled([...this.pending]); await this.reader?.close?.(); this.closed = true }
}
