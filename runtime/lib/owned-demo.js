import crypto from "node:crypto"
import fs from "node:fs/promises"
import { chmodSync, lstatSync } from "node:fs"
import path from "node:path"
import Database from "better-sqlite3"
import { setTimeout as wait } from "node:timers/promises"
import { FileError, identifier, observationToken, stableStringify } from "./file-contract.js"
import { BackendFileAdapter } from "./backend-file-adapter.js"
import { authorityLost } from "./lifecycle-admission.js"

// Immutable bundle paths are code-owned, never permissions obtained from an editable manifest.
export const DEMO_MEMBERS = Object.freeze(["README.md", "assays/surface_samples.csv", "drilling/collars.csv", "drilling/assays.csv", "gis/training_area.geojson", "examples/copper_by_sample_type.csv", "examples/copper_summary.md", "provenance/manifest.json", "LICENSE.txt"])
const RECIPE = "overview.recipe.json", DESTINATION = "maps/overview.map.json"
const LAYERS = Object.freeze([{ id: "surface-au", kind: "assay", paths: ["assays/surface_samples.csv"] }, { id: "collar-au", kind: "assay", paths: ["drilling/assays.csv", "drilling/collars.csv"] }, { id: "training-outline", kind: "vector", paths: ["gis/training_area.geojson"] }])
const SOURCE_PATHS = LAYERS.flatMap((l) => l.paths).sort()
const same = (a, b) => stableStringify(a) === stableStringify(b)
const expired = () => new FileError(409, "demo_attempt_expired", "The sample preparation deadline elapsed; retain unsettled effects for reconciliation.", { agent: "owned-demo", tool: "preparation", action: "Observe the backend-selected recovery action after prior effects settle." })
const hash = (b) => crypto.createHash("sha256").update(b).digest("hex")
const uuid = (s) => { const h = hash(s); return `${h.slice(0, 8)}-${h.slice(8, 12)}-4${h.slice(13, 16)}-a${h.slice(17, 20)}-${h.slice(20, 32)}` }
const fail = (code, message, details = {}) => new FileError(503, code, message, { agent: "owned-demo", tool: "materialize", action: "Inspect retained setup status and use the applicable explicit setup retry.", ...details })
const CHECKPOINT_ERROR = /^[a-z][a-z0-9_-]{0,100}$/ // The backend's checkpoint error pattern (owned_demo_models.py).
const absent = (e) => e.code === "ENOENT" || e.error === "not_found"
const conflicts = new Set(["source-conflict", "destination-conflict"])
async function syncDir(name) { const h = await fs.open(name, "r"); try { await h.sync() } finally { await h.close() } }
async function regularBytes(root, name) {
	let current = root
	for (const part of name.split("/")) { current = path.join(current, part); const st = await fs.lstat(current); if (st.isSymbolicLink()) throw fail("demo_bundle_mismatch", "Seed members must not contain symbolic links.") }
	const h = await fs.open(current, fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW)
	try { const st = await h.stat(); if (!st.isFile() || st.size > 16 * 1024 * 1024) throw fail("demo_bundle_mismatch", "Seed members must be bounded regular files."); return await h.readFile() } finally { await h.close() }
}

/** One daemon owns setup. Startup runs before SafeFs, index/watchers, HTTP or agent writers.
 * Its independent SQLite receipt is deliberately not scoped to FileState's workspace epoch.
 * Root must keep every other writer stopped until after filesIndexed() succeeds.
 */
export class OwnedDemo {
	static async open(workspace, config) {
		// Before any pre-SafeFs pathname effects, validate the private state's ancestors.
		let current = "/"
		for (const component of workspace.storeDir.slice(1).split("/")) {
			current = path.join(current, component); const stat = await fs.lstat(current)
			if (!stat.isDirectory() || ![0, process.geteuid()].includes(stat.uid) || stat.mode & 0o022) throw fail("demo_storage_unavailable", "Demo state ancestors must be private service/root-owned real directories.")
		}
		const root = await fs.lstat(workspace.workspaceDir)
		if (!root.isDirectory()) throw fail("demo_destination_conflict", "The project root must be a real startup-gated directory.")
		return new OwnedDemo(workspace, config)
	}
	constructor(workspace, config) {
		this.workspace = workspace; this.config = config
		this.validatedCheckpoint = null // Process-local only. Never reconstructed from a stored report.
		this.dispatches = new Map() // Process-local only: the raw dispatch per request/operation ID (see dispatch()).
		this.adapter = config.adapter || new BackendFileAdapter({ port: workspace.config.cloudImport?.gatewayPort || 3003, secret: workspace.config.controlSecret })
		this.adapter.bind(workspace)
		const dbPath = path.join(workspace.storeDir, "owned-demo.sqlite"), ownerPath = path.join(workspace.storeDir, "owned-demo-owner.sqlite")
		for (const name of [ownerPath, dbPath, `${dbPath}-wal`, `${dbPath}-shm`]) {
			try { const s = lstatSync(name); if (!s.isFile() || s.uid !== process.geteuid() || s.nlink !== 1 || s.mode & 0o077) throw fail("demo_storage_unavailable", "Demo receipt files must be private and have no aliases.") } catch (e) { if (!absent(e)) throw e }
		}
		// A separate OS-managed SQLite lock protects the daemon's whole lifetime.
		// Process exit releases it; there is no stale pathname lock to delete or steal.
		this.ownerDb = new Database(ownerPath, { timeout: 0 }); chmodSync(ownerPath, 0o600)
		try { this.ownerDb.exec("BEGIN EXCLUSIVE") } catch (e) { this.ownerDb.close(); throw fail("demo_setup_in_progress", "Another file daemon owns this project's setup; observe its backend status.") }
		try {
			this.db = new Database(dbPath); chmodSync(dbPath, 0o600)
			this.db.pragma("journal_mode = WAL"); this.db.pragma("synchronous = FULL")
			this.db.exec("CREATE TABLE IF NOT EXISTS receipt (project TEXT PRIMARY KEY, value TEXT NOT NULL)")
			this.key = workspace.config.projectId
			this.record = JSON.parse(this.db.prepare("SELECT value FROM receipt WHERE project = ?").get(this.key)?.value || "{}")
			this.unlistenFence = workspace.startup.onFence((fence) => {
				if (!fence.runtimeId) return // Normal closure must resume the same owner after restart.
				if (this.runtimeId && fence.runtimeId !== this.runtimeId) throw new FileError(409, "runtime_changed", "The lifecycle request names another admitted runtime owner.")
				this.persist({ lifecycleFence: { ...fence } })
			})
		} catch (error) { this.db?.close(); this.ownerDb.close(); throw error }
	}
	persist(fields) { Object.assign(this.record, fields); this.db.prepare("INSERT INTO receipt VALUES (?, ?) ON CONFLICT(project) DO UPDATE SET value=excluded.value").run(this.key, JSON.stringify(this.record)) }
	requestId(stage, revision) { return uuid(stableStringify([this.key, this.workspace.config.machineId || "local", this.workspace.identity, stage, revision])) }
	checkLocal() {
		this.workspace.startup.assertOpen()
		if (this.closed || this.workspace.draining || this.workspace.closed) throw fail("draining", "Demo publication admission is closed.")
	}
	async backend(dispatch) { try { return await dispatch() } catch (error) { if (authorityLost(error)) this.workspace.startup.loseAuthority(); else if ((!error.status || error.status >= 500) && error.error !== "demo_attempt_expired") error.demoTransport = true; throw error } }
	async bounded(work, deadlineAt = this.deadlineAt) {
		const end = Date.parse(deadlineAt)
		if (!Number.isFinite(end)) throw fail("demo_attempt_invalid", "Preparation requires a persisted attempt deadline.")
		if (end <= Date.now()) throw expired()
		let timer
		try { return await Promise.race([Promise.resolve().then(work), new Promise((_, reject) => { timer = setTimeout(() => reject(expired()), Math.min(2147483647, end - Date.now())) })]) } finally { clearTimeout(timer) }
	}
	observeStatus({ demo, permits }) {
		if (demo && (demo.projectId !== this.key || demo.assignmentState !== "assigned")) { this.workspace.startup.loseAuthority(); throw fail("demo_owner_fenced", "The demo assignment is not admitted for this project.") }
		this.currentDemo = demo; this.currentPermits = permits || { files: null, map: null }; this.deadlineAt = demo?.attempt?.deadlineAt
		if (!this.observationCurrent() || !demo.initialReadyAt && (demo.attempt?.failedAt || Date.parse(this.deadlineAt) <= Date.now())) this.validatedCheckpoint = null
		return demo
	}
	async status() {
		// Status/settlement still work after expiry, with a finite transport bound.
		return this.observeStatus(await this.backend(() => this.bounded(() => this.adapter.demoStatus(), new Date(Date.now() + (this.config.transportMs || 15000)).toISOString())))
	}
	checkAttempt(demo = this.currentDemo) {
		this.checkLocal()
		if (this.authorizedIdentity && !same(this.authorizedIdentity, this.workspace.identity)) throw fail("demo_owner_fenced", "The workspace epoch changed during preparation.")
		if (!demo?.assignmentId || !Number.isFinite(Date.parse(demo.attempt?.deadlineAt))) throw fail("demo_attempt_invalid", "Preparation requires a current assignment and persisted attempt deadline.")
		if (!demo.initialReadyAt && (demo.attempt.failedAt || Date.parse(demo.attempt.deadlineAt) <= Date.now())) { this.validatedCheckpoint = null; throw expired() }
	}
	validatePermit(permit, stage, demo, { validation = false, replay = false } = {}) {
		if (!permit || permit.stage !== stage || permit.retryRevision !== demo.retryRevision || permit.workspaceId !== this.workspace.identity.workspaceId || permit.workspaceEpoch !== this.workspace.identity.workspaceEpoch || !Number.isFinite(Date.parse(permit.deadlineAt)) || permit.deadlineAt !== demo.attempt.deadlineAt || !["granted", ...(validation ? ["completed"] : []), ...(replay ? ["completed", "failed", "conflict"] : [])].includes(permit.state)) throw fail("demo_owner_fenced", "The setup permit belongs to another workspace, deadline or retry.")
		for (const key of ["operationId", "permitId", "runtimeId"]) identifier(permit[key], key)
		identifier(`${permit.operationId}:map`, "map operationId")
		const fence = this.record.lifecycleFence
		if (fence?.runtimeId && fence.runtimeId === permit.runtimeId) throw fail("demo_owner_fenced", "This runtime owner was deletion-fenced. Replacement must use normal backend owner-fenced admission.")
		this.runtimeId = permit.runtimeId
		this.authorizedIdentity = structuredClone(this.workspace.identity)
		return permit
	}
	filesOwner(demo) { return { assignmentId: demo.assignmentId, bundleSha256: demo.template.bundleSha256, machineId: this.workspace.config.machineId || "local" } }
	retainedPermit(stage, demo, options = {}) {
		const permit = this.validatePermit(this.currentPermits[stage], stage, demo, options), original = this.record[`${stage}Permit`], fields = ["permitId", "operationId", "stage", "runtimeId", "workspaceId", "workspaceEpoch", "retryRevision", "deadlineAt"]
		if (!original || fields.some((k) => original[k] !== permit[k]) || stage === "files" && !same(this.record.filesOwner, this.filesOwner(demo)) || stage === "map" && (!same(this.record.mapSaveEpoch, this.workspace.identity) || this.record.mapSaveOperationId !== `${permit.operationId}:map` || this.record.retention && !same(this.record.retention.identity, this.retentionIdentity(permit, demo)))) throw fail("demo_owner_fenced", "The retained setup effects belong to another original permit or assignment.")
		return permit
	}
	async permit(stage, demo) {
		this.checkAttempt(demo)
		const permit = await this.backend(() => this.bounded(() => this.adapter.demoPermit(this.requestId(stage, demo.retryRevision), stage)))
		this.validatePermit(permit, stage, demo)
		const fence = this.record.lifecycleFence
		// Retain admitted file authority before any staging effect, even if normal
		// Stop or expiry has just preempted execution after the permit response.
		this.persist({ lastAuthorizedRuntimeId: permit.runtimeId, lifecycleFence: null, ...(fence ? { pendingCheckpoint: null } : {}), ...(stage === "files" ? { filesPermit: structuredClone(permit), filesOwner: this.filesOwner(demo), files: this.record.files || "staging" } : {}) })
		this.checkAttempt(demo)
		return permit
	}
	async checkpoint(permit, outcome, extra = {}) {
		// Retain intent before admission too: closure may preempt dispatch after the
		// local publication receipt is committed. Persistence is not checkpoint authority.
		if (this.record.pendingCheckpoint) throw fail("demo_checkpoint_pending", "Replay the retained checkpoint before creating another observation.")
		const body = { requestId: crypto.randomUUID(), permitId: permit.permitId, outcome, mode: "publication", ...extra }
		this.persist({ pendingCheckpoint: body, pendingCheckpointStage: permit.stage, checkpointOwner: { ...this.workspace.identity, machineId: this.workspace.config.machineId || "local" } })
		if (outcome === "map-ready" && extra.evidence && body.mode !== "settlement") this.checkedRequestId = body.requestId
		return this.dispatchCheckpoint(body)
	}
	async dispatchCheckpoint(body) {
		// Only readiness needs the attempt deadline. A failure or conflict report must still arrive after it.
		const transportEnd = Date.now() + (this.config.transportMs || 15000), end = body.mode === "settlement" || this.currentDemo?.initialReadyAt || !body.outcome.endsWith("-ready") ? transportEnd : Math.min(transportEnd, Date.parse(this.deadlineAt))
		const result = await this.workspace.startup.checkpoint(() => this.backend(() => this.bounded(() => this.adapter.demoCheckpoint(body), new Date(end).toISOString())))
		const deferred = this.record.deferredMapFailure
		this.persist({ pendingCheckpoint: null, ...(body.mode === "settlement" && this.record.pendingCheckpointStage === "files" ? { filesSettledPermitId: body.permitId } : {}), ...(body.mode === "settlement" && body.outcome === "map-ready" ? { expirySettled: true } : {}), ...(deferred && deferred.permitId === body.permitId && deferred.outcome === body.outcome && deferred.error === body.error ? { deferredMapFailure: null } : {}) })
		// Backend replay proves acceptance of those old bytes, not a current observation.
		if (body.outcome === "map-ready" && body.mode !== "settlement" && this.checkedRequestId === body.requestId && result.readinessAccepted === true) {
			this.checkAttempt(result.demo)
			if (!same(body.evidence && { workspaceId: body.evidence.workspaceId, workspaceEpoch: body.evidence.workspaceEpoch }, this.workspace.identity) || result.demo.retryRevision !== body.evidence.retryRevision || result.demo.assignmentId !== body.evidence.assignmentId) throw fail("demo_owner_fenced", "Checkpoint acknowledgement no longer matches the complete current observation.")
			this.validatedCheckpoint = body.requestId
			this.validatedAuthority = { assignmentId: body.evidence.assignmentId, retryRevision: body.evidence.retryRevision, runtimeId: body.evidence.runtimeId, permitId: body.permitId, workspaceId: body.evidence.workspaceId, workspaceEpoch: body.evidence.workspaceEpoch, deadlineAt: this.deadlineAt }
		}
		return result.demo
	}
	async reconcileCheckpoint(demo = this.currentDemo) {
		if (!this.record.pendingCheckpoint || this.record.lifecycleFence?.runtimeId) return
		const owner = { ...this.workspace.identity, machineId: this.workspace.config.machineId || "local" }
		if (!same(owner, this.record.checkpointOwner)) return // Old epoch evidence remains unavailable, never adopted.
		const permit = this.retainedPermit(this.record.pendingCheckpointStage, demo, { replay: true })
		if (permit.permitId !== this.record.pendingCheckpoint.permitId) throw fail("demo_owner_fenced", "The retained checkpoint belongs to another original permit.")
		let body = this.record.pendingCheckpoint
		// A failure or conflict replays verbatim: the backend answers its committed request ID, or settles it, whereas a
		// new request ID on a permit it already failed is stale. Only readiness becomes a separate settlement request.
		if (!demo.initialReadyAt && (demo.attempt.failedAt || Date.parse(demo.attempt.deadlineAt) <= Date.now()) && body.mode !== "settlement" && body.outcome.endsWith("-ready")) {
			this.persist({ unsettledCheckpoint: body, pendingCheckpoint: { requestId: crypto.randomUUID(), permitId: body.permitId, mode: "settlement", outcome: body.outcome, ...(body.map ? { map: body.map } : {}), ...(body.memberHashes ? { memberHashes: body.memberHashes } : {}), ...(body.error ? { error: body.error } : {}) } })
			body = this.record.pendingCheckpoint; this.checkedRequestId = null; this.validatedCheckpoint = null
		}
		if (body.mode !== "settlement" && body.outcome === "map-ready" && this.checkedRequestId === body.requestId) {
			const permit = this.validatePermit(this.currentPermits.map, "map", demo, { validation: true })
			await this.mapEvidence(permit, demo)
		}
		await this.dispatchCheckpoint(body)
	}
	async inspectInstallation(root, bundle, { privateStage = false } = {}) {
		try { const stat = await fs.lstat(root); if (!stat.isDirectory() || stat.isSymbolicLink()) throw fail("operation_indeterminate", "Interrupted installation has an unproved namespace binding.") }
		catch (error) { if (privateStage && absent(error)) return; throw error }
		const files = new Set(DEMO_MEMBERS), directories = new Set(DEMO_MEMBERS.flatMap((p) => { const parts = p.split("/"); return parts.slice(0, -1).map((_, n) => parts.slice(0, n + 1).join("/")) }))
		const visit = async (prefix = "") => {
			for (const entry of await fs.readdir(path.join(root, prefix), { withFileTypes: true })) {
				const name = prefix ? `${prefix}/${entry.name}` : entry.name
				if (entry.isDirectory() && directories.has(name)) await visit(name)
				else if (entry.isFile() && files.has(name)) {
					const bytes = await regularBytes(root, name), valid = privateStage ? bytes.length <= bundle.bytes[name].length && bytes.equals(bundle.bytes[name].subarray(0, bytes.length)) : hash(bytes) === bundle.memberHashes[name]
					if (!valid) throw fail("operation_indeterminate", "Interrupted installation has unproved member bytes; preserve its namespace for repair.")
				} else throw fail("operation_indeterminate", "Interrupted installation contains another namespace entry; preserve its effects for repair.")
			}
		}
		await visit()
	}
	async settleExpiredFiles(demo) {
		const permit = this.retainedPermit("files", demo, { replay: true })
		if (permit.state !== "granted" || this.record.filesSettledPermitId === permit.permitId) return
		const bundle = await this.bundle(demo), stage = path.join(this.workspace.storeDir, "demo-stage")
		const published = await this.workspace.startup.publication(async () => {
			this.checkLocal()
			// The exclusive daemon owner lock and this namespace barrier exclude every
			// former seeder. Startup still holds all ordinary workspace writers stopped.
			if (this.record.files === "published") {
				if (!same(this.record.filesPublication, { operationId: permit.operationId, state: "committed" }) || !same(this.record.memberHashes, bundle.memberHashes)) throw fail("operation_indeterminate", "The complete original file publication receipt is unavailable.")
				return true // Historical committed bytes are never reseeded or rechecked as pristine owned files.
			}
			if (!["staging", "publishing"].includes(this.record.files) || this.record.files === "publishing" && !same(this.record.memberHashes, bundle.memberHashes)) throw fail("operation_indeterminate", "The original interrupted installation receipt is unavailable.")
			await this.inspectInstallation(this.workspace.workspaceDir, bundle)
			await this.inspectInstallation(stage, bundle, { privateStage: true })
			this.checkLocal(); this.persist({ filesFailureRevision: permit.retryRevision })
			return false
		})
		// Never call the machine backend while the namespace barrier is held.
		await this.checkpoint(permit, published ? "files-ready" : "failed", { mode: "settlement", ...(published ? { memberHashes: bundle.memberHashes } : { error: "demo_attempt_expired" }) })
	}
	async bundle(demo) {
		if (demo.template?.id !== "wattle-creek" || demo.template.version !== 1 || demo.template.seed !== 20261008) throw fail("demo_bundle_mismatch", "The assigned seed version is unsupported.")
		const root = this.config.bundleDir, manifestBytes = await regularBytes(root, "provenance/manifest.json"), manifest = JSON.parse(manifestBytes)
		const members = this.config.memberHashes || { ...manifest.memberHashes, "provenance/manifest.json": hash(manifestBytes) }
		const expected = [...DEMO_MEMBERS, RECIPE].sort()
		if (stableStringify(Object.keys(members).sort()) !== stableStringify(expected) || Object.values(members).some((v) => !/^[0-9a-f]{64}$/.test(v)) || hash(stableStringify(members)) !== demo.template.bundleSha256) throw fail("demo_bundle_mismatch", "The bundled members do not match the assigned immutable digest.")
		const bytes = {}
		for (const name of expected) { bytes[name] = await regularBytes(root, name); if (hash(bytes[name]) !== members[name]) throw fail("demo_bundle_mismatch", `The seed hash does not match for ${name}.`) }
		const recipe = JSON.parse(bytes[RECIPE])
		if (!same(recipe.layers?.map((l) => ({ id: l.id, kind: l.locationRecipe?.prepare?.type, paths: l.paths })), LAYERS)) throw fail("demo_bundle_mismatch", "The initial map requires the exact three approved layers and ordered source bindings.")
		return { bytes, memberHashes: Object.fromEntries(DEMO_MEMBERS.map((p) => [p, members[p]])), recipe }
	}
	async initializeFiles() {
		const stage = path.join(this.workspace.storeDir, "demo-stage")
		let demo = await this.status()
		if (!demo) return
		// Map checkpoint transport failures must not hide already-published files.
		if (this.record.pendingCheckpointStage === "files" && !this.record.lifecycleFence) await this.reconcileCheckpoint(demo)
		demo = await this.status()
		this.active = true
		if (demo.filesState === "ready") {
			// Backend's monotonic milestone is sufficient to veto seed replacement even if local state was lost.
			await this.workspace.startup.publication(async () => { this.persist({ files: "published", memberHashes: this.record.memberHashes || demo.memberHashes }); await fs.rm(stage, { recursive: true, force: true }) }); return
		}
		if (demo.attempt.failedAt || Date.parse(demo.attempt.deadlineAt) <= Date.now()) {
			if (this.currentPermits.files) await this.settleExpiredFiles(demo)
			if (this.record.files !== "published") throw expired()
			return
		}
		if (this.record.files === "published") { await this.workspace.startup.publication(() => fs.rm(stage, { recursive: true, force: true })); return } // independently retained receipt wins over an uncertain backend response
		this.checkAttempt(demo)
		if (demo.filesState === "failed" || this.record.filesFailureRevision === demo.retryRevision) throw fail("demo_retry_required", "Sample file setup requires an explicit retry.")
		const permit = await this.permit("files", demo)
		let bundle
		try { bundle = await this.bundle(demo) }
		catch (error) { this.persist({ filesFailureRevision: demo.retryRevision }); await this.checkpoint(permit, "failed", { error: error.error || "demo_bundle_mismatch" }); throw error }
		// A publication interruption remains uncertain, not failed. No ordinary workspace has been opened.
		await this.workspace.startup.publication(async () => { await fs.rm(stage, { recursive: true, force: true }); await fs.mkdir(stage, { mode: 0o700 }) })
		for (const name of DEMO_MEMBERS) {
			await this.workspace.startup.publication(async () => {
				this.checkAttempt(demo)
				await fs.mkdir(path.dirname(path.join(stage, name)), { recursive: true, mode: 0o700 })
				const handle = await fs.open(path.join(stage, name), "wx", 0o600)
				try { await handle.writeFile(bundle.bytes[name]); await handle.sync() } finally { await handle.close() }
				if (hash(await regularBytes(stage, name)) !== bundle.memberHashes[name]) throw fail("demo_bundle_mismatch", "Private staged bytes failed verification.")
			})
		}
		await this.config.installCheckpoint?.("staged")
		const root = this.workspace.workspaceDir
		await this.workspace.startup.publication(async () => {
			if (this.record.files !== "publishing") {
				if ((await fs.readdir(root)).length) throw fail("demo_destination_conflict", "The unpublished workspace already contains files; setup will not replace them.")
				this.persist({ files: "publishing", filesPermit: permit, memberHashes: bundle.memberHashes })
			}
		})
		// Per-file create-only installation is isolated by the startup writer gate, not a root atomic rename.
		// Only an interrupted, never-exposed installation can finish missing members here.
		for (const name of DEMO_MEMBERS) {
			await this.workspace.startup.publication(async () => {
				this.checkAttempt(demo)
				const target = path.join(root, name)
				await fs.mkdir(path.dirname(target), { recursive: true, mode: 0o2775 })
				await this.config.installCheckpoint?.("before-link", name)
				try { await fs.link(path.join(stage, name), target) }
				catch (error) { if (error.code !== "EEXIST" || hash(await regularBytes(root, name)) !== bundle.memberHashes[name]) throw fail("demo_destination_conflict", "An interrupted installation has a conflicting member.") }
				await fs.chmod(target, 0o664); await syncDir(path.dirname(target))
				await this.config.installCheckpoint?.("installed-member", name)
			})
		}
		await this.workspace.startup.publication(async () => {
			this.checkAttempt(demo)
			await syncDir(root)
			this.persist({ files: "published", filesPermit: permit, filesPublication: { operationId: permit.operationId, state: "committed" }, memberHashes: bundle.memberHashes })
			await fs.rm(stage, { recursive: true, force: true })
		})
		await this.config.installCheckpoint?.("published")
	}
	async filesIndexed() {
		if (!this.active) return
		let demo = await this.status()
		this.checkLocal()
		if (demo.filesState === "ready") return // Historical file readiness is not another deadline-bound setup observation.
		if (demo.attempt.failedAt || Date.parse(demo.attempt.deadlineAt) <= Date.now()) { await this.settleExpiredFiles(demo); return }
		if (this.currentDemo?.initialReadyAt) await this.workspace.index.ready
		else await this.bounded(() => this.workspace.index.ready)
		this.checkLocal()
		if (this.record.filesPermit) {
			demo = await this.status()
			if (demo.filesState !== "ready") {
				if (demo.attempt.failedAt || Date.parse(demo.attempt.deadlineAt) <= Date.now()) { await this.settleExpiredFiles(demo); return }
				const permit = this.validatePermit(this.currentPermits.files, "files", demo)
				if (permit.permitId !== this.record.filesPermit.permitId || this.record.filesPublication?.operationId !== permit.operationId || this.record.files !== "published") throw fail("demo_publication_missing", "The exact committed seed installation receipt is unavailable.")
				const bundle = await this.bundle(demo)
				await this.compareSources(DEMO_MEMBERS, bundle.memberHashes)
				const catalogue = await this.catalogue(DEMO_MEMBERS)
				await this.checkpoint(permit, "files-ready", { memberHashes: bundle.memberHashes, evidence: this.evidence(demo, permit, this.record.filesPublication, catalogue) })
			}
		}
	}
	evidence(demo, permit, publication, catalogue) { return { version: 1, assignmentId: demo.assignmentId, bundleSha256: demo.template.bundleSha256, runtimeId: permit.runtimeId, ...this.workspace.identity, retryRevision: permit.retryRevision, publication, catalogue } }
	async catalogue(expected) {
		// Drain bounded scan passes, then every page of one immutable root observation.
		for (;;) {
			this.checkAttempt()
			const info = await this.bounded(() => this.workspace.index.refresh())
			if (info?.state === "ready") break
			if (!this.workspace.index.scanSession) throw fail("demo_catalogue_incomplete", "The catalogue scan is not complete and successful.")
		}
		const rows = new Map(), cursors = new Set(); let cursor, viewId, total
		do {
			this.checkAttempt()
			const page = await this.bounded(() => this.workspace.index.find({ path: "", kind: "file", sort: "path", ...(cursor ? { cursor } : {}) }))
			if (!page.viewId || page.coverage?.state !== "ready" || page.count?.relation !== "exact" || !Number.isSafeInteger(page.count.value) || page.truncated || viewId && page.viewId !== viewId || total !== undefined && page.count.value !== total) throw fail("demo_catalogue_incomplete", "Readiness requires one complete, current and untruncated catalogue view.")
			identifier(page.viewId, "viewId"); viewId = page.viewId; total = page.count.value
			for (const row of page.items) { if (rows.has(row.path)) throw fail("demo_catalogue_incomplete", "Catalogue pages overlap."); rows.set(row.path, row) }
			cursor = page.nextCursor
			if (cursor && (cursors.has(cursor) || !page.items.length)) throw fail("demo_catalogue_incomplete", "Catalogue paging did not progress.")
			cursors.add(cursor)
		} while (cursor)
		if (rows.size !== total || expected.some((p) => { const r = rows.get(p); return !r || r.type !== "file" || r.availability !== "local" || !r.observation?.token || !same(r.ref, this.workspace.ref(p)) })) throw fail("demo_catalogue_incomplete", "The catalogue does not contain every approved sample member.")
		const observations = await this.compareSources(expected, { ...this.record.memberHashes, ...(this.record.map ? { [DESTINATION]: this.record.map.sha256 } : {}) })
		if (expected.some((p) => rows.get(p).observation.token !== observations[p])) throw fail("demo_catalogue_incomplete", "A catalogue member changed since this frozen observation.")
		return { viewId, coverage: "ready", paths: [...expected].sort() }
	}
	start() {
		if (!this.active) return
		this.errors = 0
		this.tick()
	}
	// Self-scheduling observer: back off on errors and log an error only when it changes.
	tick() {
		this.timer = null
		void this.runOnce().then(() => { this.errors = 0; this.lastError = null }, (error) => {
			this.errors++
			const fields = { error: error.error || error.message, ...(error.blocker ? { blocker: error.blocker } : {}) }, key = stableStringify(fields)
			if (key !== this.lastError) { this.lastError = key; this.workspace.logger.error?.("demo setup observer failed", fields) }
		}).finally(() => { if (!this.closed) { this.timer = setTimeout(() => this.tick(), this.nextDelay()); this.timer.unref?.() } })
	}
	nextDelay() {
		const poll = this.config.pollMs || 5000, demo = this.currentDemo, pending = this.record.pendingCheckpoint || this.record.deferredMapFailure
		if (this.errors) return Math.min(this.config.maxBackoffMs || 60000, poll * 2 ** Math.min(this.errors - 1, 4))
		// Keep a slow poll after readiness: status observation is also how deletion fences this owner.
		if (demo?.initialReadyAt && !pending) return this.config.readyPollMs || 60000
		if (demo?.initialPreparationState === "failed" && !pending && this.currentPermits?.map?.state !== "granted") return this.config.idlePollMs || 30000
		return poll
	}
	runOnce() {
		if (this.inflight) return this.inflight
		if (this.closed || this.workspace.draining || !this.active) return Promise.resolve()
		this.inflight = this.runMap().catch((error) => { if (authorityLost(error)) this.workspace.startup.loseAuthority(); throw error }).finally(() => { this.inflight = null })
		return this.inflight
	}
	async settleJob(accepted) {
		if (accepted.source || accepted.representation) return accepted
		for (;;) {
			this.checkAttempt()
			const job = await this.bounded(() => this.workspace.job(accepted.jobId))
			if (job.state === "succeeded") { await this.bounded(() => this.workspace.gis.waitForSettlement(accepted.jobId)); this.checkAttempt(); return job.result }
			if (["failed", "cancelled", "interrupted"].includes(job.state)) { const error = fail(job.error?.error || "demo_preparation_failed", job.error?.message || "Source preparation failed."); error.state = job.error?.state; throw error }
			await this.bounded(() => wait(10))
		}
	}
	async compareSources(paths, hashes) {
		const observations = {}
		for (const name of paths) {
			this.checkAttempt()
			let opened
			try {
				// Do not race the handle acquisition: the observer owns and closes it even
				// when the attempt expires during filesystem work.
				opened = await this.workspace.openLive(name)
				this.checkAttempt()
				if (!opened.stat.isFile() || opened.stat.size > 16n * 1024n * 1024n) throw fail("source-conflict", "An initial map source is no longer a bounded seed file.")
				const bytes = await this.workspace.captures.readPrefix(opened.handle, Number(opened.stat.size))
				this.checkAttempt()
				if (hash(bytes) !== hashes[name] || observationToken(await opened.handle.stat({ bigint: true })) !== opened.observation.token || observationToken(await this.workspace.safeFs.stat(name)) !== opened.observation.token) throw fail("source-conflict", "The initial map's sources changed.")
				observations[name] = opened.observation.token
			} catch (error) { if (absent(error)) throw fail("source-conflict", "An initial map source is missing."); throw error }
			finally { await opened?.handle.close() }
		}
		return observations
	}
	retentionIdentity(permit, demo) { return { assignmentId: demo.assignmentId, permitId: permit.permitId, runtimeId: permit.runtimeId, retryRevision: permit.retryRevision, ...this.workspace.identity, operationId: `${permit.operationId}:map` } }
	async holdSource(source, permit, demo) {
		return this.workspace.startup.publication(async () => {
		this.checkAttempt(demo)
		identifier(source.captureId, "captureId")
		const retention = this.record.retention, hold = { holdId: `demo-initial:${permit.permitId}:${source.captureId}`, reason: `owned-demo-initial:${demo.assignmentId}:${permit.permitId}`, source: { kind: "capture", id: source.captureId } }
		if (!same(retention.identity, this.retentionIdentity(permit, demo)) || source.digest?.state !== "ready" || source.digest.sha256 !== this.record.memberHashes[source.ref.path] || !SOURCE_PATHS.includes(source.ref.path) || !same(source.ref, this.workspace.ref(source.ref.path))) throw fail("demo_hold_mismatch", "Initial retention must bind the exact approved input and attempt.")
		const prior = retention.sources.find((s) => s.ref.path === source.ref.path)
		if (prior && !same(prior, source)) throw fail("demo_hold_mismatch", "An initial input cannot rebind to another capture.")
		// Persist ownership before creating the hold. A crash in either commit is
		// recoverable by exact binding; publication cannot precede both commits.
		if (!prior) this.persist({ retention: { ...retention, sources: [...retention.sources, source], holds: [...retention.holds, hold], heldBytes: retention.sources.reduce((n, s) => n + s.sizeBytes, source.sizeBytes) } })
		await this.workspace.captures.hold("capture", source.captureId, hold.reason, hold.holdId)
		})
	}
	async admittedJob(requestId, dispatch) {
		this.checkAttempt()
		const r = this.record.retention
		if (!r.requests.includes(requestId)) this.persist({ retention: { ...r, requests: [...r.requests, requestId] } })
		return this.settleJob(await this.bounded(() => this.dispatch(requestId, dispatch)))
	}
	// bounded() can give up at its deadline while a dispatch still waits for provider admission and could claim
	// later. Keep the raw promise per ID until it settles by itself; at most one dispatch per ID is outstanding.
	dispatch(id, work) {
		const live = this.dispatches.get(id)
		if (live) return live
		const promise = Promise.resolve().then(work), clear = () => { if (this.dispatches.get(id) === promise) this.dispatches.delete(id) }
		this.dispatches.set(id, promise); promise.then(clear, clear)
		return promise
	}
	async settleDispatches(ids) {
		const live = ids.map((id) => this.dispatches.get(id)).filter(Boolean)
		if (!live.length) return
		try { await this.bounded(() => Promise.allSettled(live), new Date(Date.now() + (this.config.transportMs || 15000)).toISOString()) }
		catch (error) { if (error.error !== "demo_attempt_expired") throw error }
	}
	// A provider claims an ID (an insert-only claim plus its record, in one transaction) before its dispatch settles.
	// So an ID with no record, no outstanding dispatch here and no claim in the retention's epoch was never admitted
	// and has no effect to settle. A claim whose record is gone stays unknown. Only runMap reaches this, serialised by
	// inflight; call settleDispatches first.
	async claimed(kind, id, r) {
		const record = await this.workspace.state.get(kind, id)
		if (record) return { record }
		if (this.dispatches.has(id)) return { blocker: "outstanding" }
		if (r.identity.workspaceId !== this.workspace.identity.workspaceId || r.identity.workspaceEpoch !== this.workspace.identity.workspaceEpoch) return { blocker: "other-epoch" }
		if (await this.workspace.state.wasClaimed(kind, id)) return { blocker: "record-missing" }
		return { record: null }
	}
	async resumedRequestId(base) {
		const r = this.record.retention, id = r.resumedRequests?.[base] || base, request = await this.workspace.state.get("requests", id)
		if (!request || !["interrupted", "cancelled"].includes(request.state) && request.error?.error !== "job_cancelled") return id
		if (request.jobId) await this.bounded(() => this.workspace.gis.waitForSettlement(request.jobId))
		const job = request.jobId && await this.workspace.state.get("jobs", request.jobId), publications = (await this.workspace.state.list("source-publications")).filter((p) => request.jobId && p.jobId === request.jobId || job?.resultRef === p.id)
		if (publications.some((p) => !["committed", "aborted-before-publication"].includes(p.state) || p.cleanupPending) || (request.error?.state === "indeterminate" || job?.cleanup?.state === "indeterminate") && !publications.length) throw fail("operation_indeterminate", "Interrupted native publication must be reconciled before preparation can resume.")
		// A stopped local job needs a fresh request only after its worker and any
		// protected publication have settled. Resident products are reused by the
		// ordinary preparation API; the map operation and fixed owned inputs stay put.
		const next = crypto.randomUUID()
		this.persist({ retention: { ...r, resumedRequests: { ...r.resumedRequests, [base]: next } } })
		return next
	}
	checkPlacement(kind, preview) { if (kind === "assay" ? preview.placement?.state !== "ready" : !preview.layers?.length || preview.layers.some((l) => l.placement?.state !== "ready")) throw fail("demo_map_placement_unavailable", "A sample layer cannot be placed with its recorded recipe.") }
	async verifyRetention(permit, demo, document) {
		const r = this.record.retention
		if (!r || r.releasedAt || !same(r.identity, this.retentionIdentity(permit, demo)) || !same(r.sources.map((s) => s.ref.path).sort(), SOURCE_PATHS) || r.holds.length !== 4 || new Set(r.sources.map((s) => s.captureId)).size !== 4) throw fail("demo_hold_mismatch", "The exact private initial-map ownership is unavailable.")
		const ownedHolds = (await this.workspace.state.list("holds")).filter((h) => h.reason === `owned-demo-initial:${demo.assignmentId}:${permit.permitId}`)
		if (ownedHolds.length !== 4 || ownedHolds.some((h) => !r.holds.some((b) => b.holdId === h.holdId && same(b.source, h.source)))) throw fail("demo_hold_mismatch", "Initial retention must contain exactly one owned hold for each capture.")
		const sources = []
		for (const source of [...r.sources].sort((a, b) => a.ref.path.localeCompare(b.ref.path))) {
			this.checkAttempt()
			const opened = await this.workspace.captures.open("capture", source.captureId)
			try {
				if (!same(opened.source, source) || source.digest?.state !== "ready" || source.digest.sha256 !== this.record.memberHashes[source.ref.path] || !Number.isSafeInteger(source.sizeBytes) || source.sizeBytes < 0) throw fail("demo_hold_mismatch", "Retained initial-map bytes have another source binding.")
				const bytes = await this.bounded(() => this.workspace.captures.readPrefix(opened.handle, source.sizeBytes))
				if (bytes.length !== source.sizeBytes || hash(bytes) !== source.digest.sha256) throw fail("demo_hold_mismatch", "Retained initial-map bytes do not match the pinned digest and size.")
			} finally { await opened.release() }
			const binding = { holdId: `demo-initial:${permit.permitId}:${source.captureId}`, reason: `owned-demo-initial:${demo.assignmentId}:${permit.permitId}`, source: { kind: "capture", id: source.captureId } }, hold = await this.workspace.state.get("holds", binding.holdId)
			if (!r.holds.some((h) => same(h, binding)) || !hold || hold.reason !== binding.reason || !same(hold.source, binding.source)) throw fail("demo_hold_mismatch", "An exact initial input hold is unavailable or belongs to another owner.")
			sources.push({ path: source.ref.path, captureId: source.captureId, sha256: source.digest.sha256, sizeBytes: source.sizeBytes })
		}
		if (!same(document.layers.map((l) => ({ id: l.id, kind: l.prepared.kind, paths: l.sources.map((s) => s.ref.path) })), LAYERS)) throw fail("demo_map_evidence_invalid", "The saved initial map does not contain the exact approved layers.")
		const products = []
		for (const layer of document.layers) {
			this.checkAttempt()
			if (layer.sources.some((s) => !r.sources.some((owned) => same(s, owned)))) throw fail("demo_hold_mismatch", "The saved map references another input capture.")
			const manifest = await this.bounded(() => this.workspace.representation(layer.prepared.id))
			this.workspace.maps.checkProduct(layer, manifest)
			const index = await this.workspace.state.get("workbook-indexes", manifest.id)
			if (manifest.retention !== "input-captures" || !index || !this.workspace.captures.validIndexDependencies(index)) throw fail("demo_product_retention_invalid", "Every prepared product must share its exact held input retention.")
			const preview = await this.bounded(() => this.workspace.representationQuery(manifest.id, layer.locationRecipe.query))
			this.checkPlacement(manifest.kind, preview)
			products.push({ layerId: layer.id, representationId: manifest.id, kind: manifest.kind, inputCaptureIds: layer.sources.map((s) => s.captureId), placement: "ready" })
		}
		return { sources, products, holds: r.holds, heldBytes: sources.reduce((n, s) => n + s.sizeBytes, 0) }
	}
	async mapEvidence(permit, demo) {
		this.checkAttempt(demo)
		if (!same(this.record.mapSaveEpoch, this.workspace.identity) || this.record.mapSaveOperationId !== `${permit.operationId}:map` || this.record.mapPermit?.permitId !== permit.permitId) throw fail("demo_publication_missing", "An old epoch or another attempt's map cannot be adopted or republished.")
		const bundle = await this.bundle(demo), operation = await this.workspace.state.get("operations", this.record.mapSaveOperationId)
		if (this.record.files !== "published" || this.record.filesPublication?.state !== "committed" || this.record.filesPublication.operationId !== this.record.filesPermit?.operationId || !same(this.record.memberHashes, bundle.memberHashes) || operation?.state !== "committed" || operation.action !== "upload" || operation.intent.path !== DESTINATION || !same(operation.publishedSource.ref, this.workspace.ref(DESTINATION)) || operation.publishedSource.digest.state !== "ready" || operation.publishedSource.digest.sha256 !== this.record.map?.sha256 || this.record.retention?.publication?.sha256 !== this.record.map.sha256) throw fail("demo_publication_missing", "The exact committed seed and ordinary map receipts are required.")
		await this.compareSources(DEMO_MEMBERS, bundle.memberHashes)
		await this.compareSources([DESTINATION], { [DESTINATION]: this.record.map.sha256 })
		const loaded = await this.bounded(() => this.workspace.mapViewLoad(DESTINATION))
		if (hash(stableStringify(loaded.document)) !== this.record.map.sha256 || loaded.layers.some((l) => l.prepared.availability !== "available" || l.sources.some((s) => s.captureAvailability !== "available"))) throw fail("demo_map_evidence_invalid", "The saved map or its exact products are unavailable.")
		for (const [n, layer] of loaded.document.layers.entries()) {
			const approved = bundle.recipe.layers[n], options = approved?.locationRecipe.prepare.type === "assay" ? this.workspace.gis.assayOptions(approved.locationRecipe.prepare.options) : approved?.locationRecipe.prepare.options
			if (!approved || layer.id !== approved.id || !same(layer.locationRecipe, { ...approved.locationRecipe, prepare: { type: approved.locationRecipe.prepare.type, options } })) throw fail("demo_map_evidence_invalid", "Placement must use the exact pinned recipe.")
		}
		const retention = await this.verifyRetention(permit, demo, loaded.document), catalogue = await this.catalogue([...DEMO_MEMBERS, DESTINATION])
		this.checkAttempt(demo)
		return { ...this.evidence(demo, permit, { operationId: operation.operationId, state: "committed", sha256: this.record.map.sha256 }, catalogue), ...retention }
	}
	async releaseBindings(reason) {
		const r = this.record.retention
		if (!r || r.releasedAt) return { released: 0, heldBytes: 0 }
		// holdSource persists each binding before it creates the hold, so no bindings means nothing is held. Skip
		// the capture store: it may be the very thing that is unavailable.
		if (!r.holds.length) { this.persist({ retention: { ...r, releasedAt: new Date().toISOString(), releaseReason: reason } }); return { released: 0, releasedBytes: 0, heldBytes: 0 } }
		return this.workspace.captures.withRetention(async () => {
			const metadata = []; let releasedBytes = 0
			for (const binding of r.holds) {
				const owned = r.sources.find((s) => s.captureId === binding.source.id), hold = await this.workspace.state.get("holds", binding.holdId)
				if (!owned || binding.holdId !== `demo-initial:${r.identity.permitId}:${owned.captureId}` || binding.reason !== `owned-demo-initial:${r.identity.assignmentId}:${r.identity.permitId}` || binding.source.kind !== "capture" || hold && (hold.reason !== binding.reason || !same(hold.source, binding.source))) throw new FileError(409, "demo_hold_mismatch", "Initial retention cleanup found another ownership binding.")
				if (hold) { metadata.push({ type: "delete", kind: "holds", id: binding.holdId }); releasedBytes += owned.sizeBytes }
			}
			// Preflight every binding before deleting any. Lost acknowledgement is an
			// exact idempotent retry, including the gap before the independent receipt.
			await this.workspace.state.transaction(metadata)
			this.persist({ retention: { ...r, releasedAt: new Date().toISOString(), releaseReason: reason } })
			return { released: metadata.length, releasedBytes, heldBytes: 0 }
		})
	}
	async safelyAbandon() {
		const r = this.record.retention
		if (!r || r.releasedAt) return true
		this.abandonBlocker = null
		const block = (kind, id, state) => { this.abandonBlocker = { kind, id, state }; return false }
		await this.settleDispatches([r.identity.operationId, ...r.requests])
		const found = await this.claimed("operations", r.identity.operationId, r), operation = found.record
		if (found.blocker) return block("operation", r.identity.operationId, found.blocker)
		if (operation && (! ["failed", "aborted-before-publication"].includes(operation.state) || operation.error?.state === "indeterminate")) return block("operation", r.identity.operationId, operation.state)
		if (this.record.mapOutcome === "map-ready" || this.record.pendingCheckpoint?.outcome === "map-ready") return block("map", r.identity.operationId, "map-ready")
		for (const id of r.requests) {
			const claim = await this.claimed("requests", id, r), request = claim.record
			if (claim.blocker) return block("request", id, claim.blocker)
			if (!request) continue // Never claimed: no effect exists to settle.
			if (!["succeeded", "failed", "cancelled", "interrupted"].includes(request.state) || request.error?.state === "indeterminate" || request.cleanup?.state === "indeterminate") return block("request", id, request.state)
			if (request.jobId) {
				const job = await this.workspace.state.get("jobs", request.jobId)
				if (!job) { if (request.type !== "capture" || !["succeeded", "failed"].includes(request.state)) return block("job", request.jobId, "missing"); continue }
				if (!["succeeded", "failed", "cancelled", "interrupted"].includes(job.state) || job.error?.state === "indeterminate" || job.cleanup?.state === "indeterminate") return block("job", request.jobId, job.state)
				try { await this.bounded(() => this.workspace.gis.waitForSettlement(request.jobId), new Date(Date.now() + (this.config.transportMs || 15000)).toISOString()) }
				catch (error) { if (error.error === "demo_attempt_expired") return block("job", request.jobId, "settling"); throw error }
			}
		}
		const publications = await this.workspace.state.list("source-publications")
		const publishing = publications.find((p) => ["publishing", "indeterminate"].includes(p.state) && (r.sources.some((s) => s.captureId === p.id) || p.dependencies?.some((d) => r.sources.some((s) => s.captureId === d.id))))
		if (publishing) return block("source-publication", publishing.id, publishing.state)
		await this.releaseBindings("abandoned-attempt"); return true
	}
	async reportMapFailure(permit, outcome, error) {
		this.checkLocal()
		const failure = { permitId: permit.permitId, outcome, error }
		if (this.record.deferredMapFailure && !same(this.record.deferredMapFailure, failure)) throw fail("operation_indeterminate", "The original granted map failure must settle before another failure can be reported.")
		// This is local deferred intent, not a terminal checkpoint or retry admission.
		// Keep it across restart and retain the original permit until effects settle.
		this.persist({ deferredMapFailure: failure })
		if (!await this.safelyAbandon()) throw fail("operation_indeterminate", "Map preparation cleanup is unresolved; retain its granted permit and exact input bindings.", { blocker: this.abandonBlocker })
		this.persist({ mapOutcome: outcome, mapFailureRevision: permit.retryRevision })
		const settlement = error === "demo_attempt_expired" || this.currentDemo?.attempt.failedAt || Date.parse(this.deadlineAt) <= Date.now()
		await this.checkpoint(permit, outcome, { mode: settlement ? "settlement" : "publication", error })
	}
	async releaseRetention(input) {
		this.checkLocal()
		if (!input || typeof input !== "object" || Array.isArray(input) || Object.keys(input).some((k) => !["assignmentId", "permitId"].includes(k))) throw new FileError(400, "invalid_request", "Release names the exact assignment and initial map permit.")
		identifier(input.assignmentId, "assignmentId"); identifier(input.permitId, "permitId")
		const demo = await this.status(), r = this.record.retention
		if (!demo?.initialReadyAt) throw new FileError(409, "demo_initial_incomplete", "Operator release requires completed initial preparation.")
		if (!r || input.assignmentId !== demo.assignmentId || input.assignmentId !== r.identity.assignmentId || input.permitId !== r.identity.permitId) throw new FileError(409, "demo_hold_mismatch", "Release must identify this project's exact original retained inputs.")
		this.checkLocal(); return this.releaseBindings("operator-release")
	}
	async deletionCleanup() {
		if (!this.record.lifecycleFence?.runtimeId) return { complete: false, released: 0 }
		if (!this.workspace.captures && this.record.retention && !this.record.retention.releasedAt) throw fail("demo_cleanup_unavailable", "Private captures must initialize before retained initial-map ownership can be released.")
		if (!this.workspace.captures) return { complete: true, released: 0 }
		const result = await this.releaseBindings("project-deletion")
		this.validatedCheckpoint = null
		return { ...result, complete: true }
	}
	observationCurrent() {
		const a = this.validatedAuthority, d = this.currentDemo, p = this.currentPermits?.map
		return Boolean(a && d && p && a.assignmentId === d.assignmentId && a.retryRevision === d.retryRevision && a.deadlineAt === d.attempt?.deadlineAt && a.permitId === p.permitId && a.runtimeId === p.runtimeId && p.retryRevision === a.retryRevision && same({ workspaceId: a.workspaceId, workspaceEpoch: a.workspaceEpoch }, this.workspace.identity) && p.workspaceId === a.workspaceId && p.workspaceEpoch === a.workspaceEpoch)
	}
	bootstrap() { return this.validatedCheckpoint && this.observationCurrent() && !this.closed && !this.workspace.startup.closed && (this.currentDemo?.initialReadyAt || !this.currentDemo?.attempt.failedAt && Date.parse(this.deadlineAt) > Date.now()) ? { checkpointRequestId: this.validatedCheckpoint } : undefined }
	async runMap() {
		let demo = await this.status()
		if (!demo) return
		const replayed = this.record.pendingCheckpoint
		await this.reconcileCheckpoint(demo)
		if (replayed) demo = await this.status() // Observe again only after a replayed acknowledgement.
		if (demo.initialReadyAt || this.bootstrap() || demo.filesState !== "ready") return
		if (this.record.deferredMapFailure) {
			const failure = this.record.deferredMapFailure, permit = this.retainedPermit("map", demo)
			if (permit.permitId !== failure.permitId || permit.permitId !== this.record.mapPermit?.permitId) throw fail("demo_owner_fenced", "Deferred map failure belongs to another granted permit.")
			await this.reportMapFailure(permit, failure.outcome, failure.error); return
		}
		if (demo.attempt.failedAt || Date.parse(demo.attempt.deadlineAt) <= Date.now()) {
			const operation = this.record.mapSaveOperationId && await this.workspace.state.get("operations", this.record.mapSaveOperationId)
			if (operation?.state === "committed" && !this.record.expirySettled) {
				const permit = this.retainedPermit("map", demo, { validation: true })
				if (!same(this.record.mapSaveEpoch, this.workspace.identity) || operation.operationId !== `${this.record.mapPermit?.operationId}:map` || operation.action !== "upload" || operation.intent.path !== DESTINATION || !same(operation.publishedSource?.ref, this.workspace.ref(DESTINATION)) || operation.publishedSource?.digest.state !== "ready") throw fail("demo_publication_missing", "Settlement requires this owner's exact committed map receipt.")
				const map = { path: DESTINATION, sha256: operation.publishedSource.digest.sha256 }
				this.persist({ map, mapOutcome: "map-ready" })
				await this.checkpoint(permit, "map-ready", { mode: "settlement", map })
			}
			else if (operation?.state !== "committed" && this.currentPermits.map?.state === "granted") await this.reportMapFailure(this.retainedPermit("map", demo), "failed", "demo_attempt_expired")
			return
		}
		if (this.record.mapSaveEpoch && !same(this.record.mapSaveEpoch, this.workspace.identity)) throw fail("demo_publication_missing", "The initial map belongs to an old epoch and remains unavailable for repair.")
		if (this.record.mapSaveOperationId) {
			const previous = await this.workspace.state.get("operations", this.record.mapSaveOperationId)
			if (previous?.state === "committed") {
				const permit = this.validatePermit(this.currentPermits.map, "map", demo, { validation: true })
				if (permit.permitId !== this.record.mapPermit?.permitId) throw fail("demo_publication_missing", "Another map permit cannot adopt the retained publication.")
				this.persist({ mapOutcome: "map-ready", map: this.record.map || { path: DESTINATION, sha256: previous.publishedSource.digest.sha256 } })
				const evidence = await this.mapEvidence(permit, demo)
				await this.checkpoint(permit, "map-ready", { mode: permit.state === "completed" ? "validation" : "publication", memberHashes: { ...this.record.memberHashes }, map: this.record.map, evidence }); return
			}
			if (previous && !["failed", "aborted-before-publication"].includes(previous.state)) throw fail("operation_indeterminate", "The retained map save is unresolved; do not submit another publication.")
		}
		if (demo.mapState !== "pending" || conflicts.has(this.record.mapOutcome) || this.record.mapFailureRevision === demo.retryRevision) { await this.safelyAbandon(); return }
		if (this.record.retention && this.record.retention.identity.retryRevision !== demo.retryRevision && !await this.safelyAbandon()) throw fail("operation_indeterminate", "Prior input ownership is not safely abandoned.")
		const permit = await this.permit("map", demo), identity = structuredClone(this.workspace.identity), saveOperationId = `${permit.operationId}:map`
		if (!this.record.retention || this.record.retention.releasedAt) this.persist({ retention: { identity: this.retentionIdentity(permit, demo), sources: [], holds: [], requests: [] }, mapDispatchIntent: false, expirySettled: false, mapOutcome: null, map: null })
		if (!same(this.record.retention.identity, this.retentionIdentity(permit, demo))) throw fail("demo_hold_mismatch", "The retained attempt belongs to another authority.")
		this.persist({ mapPermit: permit, mapSaveOperationId: saveOperationId, mapSaveEpoch: identity })
		let step = { phase: "inputs" }
		try {
			const bundle = await this.bundle(demo), recipe = bundle.recipe, layers = []
			await this.compareSources(DEMO_MEMBERS, bundle.memberHashes)
			try { await this.workspace.safeFs.stat(DESTINATION); throw fail("destination-conflict", "A file already uses the sample map's name.") } catch (e) { if (!absent(e)) throw e }
			for (const layer of recipe.layers) {
				this.checkAttempt(); const sources = []
				for (const name of layer.paths) {
					step = { phase: "capture", layerId: layer.id, path: name }
					const requestId = await this.resumedRequestId(uuid(`${permit.permitId}:capture:${name}`)), owned = this.record.retention.sources.find((s) => s.ref.path === name), captured = owned ? { source: owned } : await this.admittedJob(requestId, () => this.workspace.captures.create({ requestId, path: name, computeDigest: true }))
					if (captured.source.digest.sha256 !== bundle.memberHashes[name]) throw fail("source-conflict", "Captured sources differ from the publication receipt.")
					this.checkAttempt(); await this.holdSource(captured.source, permit, demo); sources.push(captured.source)
				}
				step = { phase: "prepare", layerId: layer.id }
				const options = layer.locationRecipe.prepare.type === "assay" ? this.workspace.gis.assayOptions(layer.locationRecipe.prepare.options) : layer.locationRecipe.prepare.options, requestId = await this.resumedRequestId(uuid(`${permit.permitId}:prepare:${layer.id}`))
				const prepared = await this.admittedJob(requestId, () => this.workspace.preparation({ requestId, type: layer.locationRecipe.prepare.type, source: sources[0], companions: sources.slice(1), options })), manifest = prepared.representation
				const preview = await this.bounded(() => this.workspace.representationQuery(manifest.id, layer.locationRecipe.query)); this.checkPlacement(manifest.kind, preview)
				layers.push({ id: layer.id, title: layer.title, sources: manifest.inputs.map((i) => i.source), prepared: { id: manifest.id, kind: manifest.kind }, locationRecipe: { ...layer.locationRecipe, prepare: { type: manifest.kind, options: manifest.options || {} } }, style: layer.style, visible: layer.visible, opacity: layer.opacity, ownership: layer.ownership, credits: layer.credits })
			}
			const document = { schemaVersion: 1, id: recipe.id, title: recipe.title, workspace: identity, camera: recipe.camera, context: recipe.context, layers, output: recipe.output }
			step = { phase: "save" }
			await this.verifyRetention(permit, demo, document)
			const current = await this.bounded(() => this.status()); this.checkAttempt(current)
			if (current.retryRevision !== permit.retryRevision || current.mapState !== "pending" || this.currentPermits.map?.permitId !== permit.permitId) throw fail("demo_owner_fenced", "Map setup authority changed during preparation.")
			// Only local checks inside the namespace barrier. No backend request here.
			const guard = async () => { this.checkAttempt(current); if (!same(this.workspace.identity, identity)) throw fail("demo_owner_fenced", "The workspace epoch changed during setup."); await this.compareSources(DEMO_MEMBERS, bundle.memberHashes); this.checkAttempt(current) }
			await this.workspace.startup.publication(async () => { this.checkAttempt(current); this.persist({ mapDispatchIntent: true, retention: { ...this.record.retention, publication: { operationId: saveOperationId, sha256: hash(stableStringify(document)) } } }) })
			const saved = await this.bounded(() => this.dispatch(saveOperationId, () => this.workspace.mapViewSave({ operationId: saveOperationId, path: DESTINATION, mode: "create", document }, guard)))
			if (saved.operation.state !== "committed") throw fail("operation_indeterminate", "Map publication requires receipt reconciliation.")
			this.persist({ map: { path: DESTINATION, sha256: saved.operation.publishedSource.digest.sha256 } })
			const evidence = await this.mapEvidence(permit, current)
			this.persist({ mapOutcome: "map-ready" })
			await this.checkpoint(permit, "map-ready", { memberHashes: { ...this.record.memberHashes }, map: this.record.map, evidence })
		} catch (error) {
			if (authorityLost(error)) { this.workspace.startup.loseAuthority(); throw error }
			if (this.workspace.startup.closed || this.workspace.draining || error.error === "draining") throw error
			if (error.demoTransport) throw error // Retry reads and acknowledgements under the same admitted attempt.
			if (this.record.mapOutcome === "map-ready" || error.error === "operation_indeterminate" || error.state === "indeterminate") throw error
			const operation = await this.workspace.state.get("operations", saveOperationId)
			if (operation && !["failed", "aborted-before-publication"].includes(operation.state)) throw error
			if (error.error === "demo_attempt_expired") { await this.reportMapFailure(permit, "failed", "demo_attempt_expired"); return }
			const outcome = error.error === "exists" || error.code === "EEXIST" || error.error === "destination-conflict" ? "destination-conflict" : error.error === "source-conflict" ? "source-conflict" : "failed"
			// Log the cause once, here: deferred replays carry only its code. Normalise the code before it is stored,
			// so the backend accepts it and a replay compares equal.
			const code = CHECKPOINT_ERROR.test(error.error || "") ? error.error : "demo_preparation_failed"
			this.workspace.logger.warn?.("demo map step failed", { permitId: permit.permitId, retryRevision: permit.retryRevision, step, outcome, error: code, status: error.status, message: error.message, ...(error.reason ? { reason: error.reason } : {}), ...(["gis_unavailable", "capture_store_unavailable"].includes(code) ? { availability: this.workspace.gis.availability } : {}) })
			await this.reportMapFailure(permit, outcome, code)
		}
	}
	async close() { this.closed = true; clearTimeout(this.timer); await this.inflight?.catch(() => {}); this.unlistenFence?.(); this.db.close() }
	// The owner lock outlives provider drain: WorkspaceFiles releases it last, after GIS admission has drained.
	releaseOwner() { if (this.ownerDb.open) this.ownerDb.close() }
}
