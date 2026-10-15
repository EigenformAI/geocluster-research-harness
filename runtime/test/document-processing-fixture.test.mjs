import assert from "node:assert/strict"
import crypto from "node:crypto"
import fs from "node:fs/promises"
import http from "node:http"
import os from "node:os"
import path from "node:path"
import { setTimeout as wait } from "node:timers/promises"
import { FileCaptures } from "../lib/file-captures.js"
import { FileError, observation, stableStringify } from "../lib/file-contract.js"
import { FileState } from "../lib/file-state.js"

export const sha = (bytes) => crypto.createHash("sha256").update(bytes).digest("hex")
export async function until(check, message = "condition", ms = 3000) {
	const end = Date.now() + ms
	while (Date.now() < end) { const result = await check(); if (result) return result; await wait(5) }
	assert.fail(`Timed out waiting for ${message}`)
}
export class MemoryState {
	constructor() { this.identity = { workspaceId: crypto.randomUUID(), workspaceEpoch: crypto.randomUUID() }; this.records = new Map(); this.claims = new Map() }
	async get(kind, id) { return structuredClone(this.records.get(`${kind}/${id}`) ?? null) }
	async list(kind) { return [...this.records].filter(([key]) => key.startsWith(`${kind}/`)).map(([, value]) => structuredClone(value)) }
	async put(kind, id, value) { this.records.set(`${kind}/${id}`, structuredClone(value)) }
	async delete(kind, id) { this.records.delete(`${kind}/${id}`) }
	async transaction(ops) {
		if (this.failCommit?.(ops)) throw new FileError(507, "insufficient_storage", "Injected metadata failure")
		const next = new Map(this.records)
		for (const op of ops) if (op.type === "put") next.set(`${op.kind}/${op.id}`, structuredClone(op.value)); else next.delete(`${op.kind}/${op.id}`)
		this.records = next
	}
	async claim(kind, id, intent, record) {
		const key = `${kind}/${id}`, previous = this.claims.get(key)
		if (previous) {
			if (previous !== stableStringify(intent)) throw new FileError(409, "request_id_reused", "Different intent")
			return { duplicate: true, record: await this.get(kind, id) }
		}
		this.claims.set(key, stableStringify(intent)); await this.put(kind, id, record)
		return { duplicate: false, record }
	}
}

// A deterministic HTTP owner: same-key admissions are unique even while a first POST is delayed.
export async function processor(t, options = {}) {
	const jobs = new Map(), submissions = new Map(), requests = [], products = Buffer.from("<svg>retained product</svg>")
	const f = { jobs, requests, products, posts: 0, cancels: 0, reconciles: 0, lookups: 0, options }
	const server = http.createServer(async (req, res) => {
		try {
			const url = new URL(req.url, "http://localhost"), parts = url.pathname.split("/")
			requests.push({ method: req.method, path: req.url, headers: { ...req.headers } })
			const json = (body, status = 200) => { res.writeHead(status, { "content-type": "application/json" }); res.end(JSON.stringify(body)) }
			if (options.redirect) { res.writeHead(302, { location: "http://127.0.0.1:1/private" }); res.end(); return }
			if (options.down) return json({ error: { code: "PROVIDER_UNAVAILABLE", message: "/private/token secret", retry: "operator-action" } }, 503)
			if (url.pathname.endsWith("/capabilities")) return json({ dependency: { ready: !options.unknown, executionReady: !options.unknown, observedAt: new Date().toISOString(), observationMaxAgeMs: 5000, state: options.unknown ? "blocked" : "ready", ...options.dependency }, activity: { activeJobId: null, settlementUnknown: Boolean(options.unknown), unsettledOperations: options.unknown ? 1 : 0 }, profiles: [{ id: "default" }] })
			if (url.pathname.endsWith("/engine/reconcile")) { f.reconciles++; if (options.recoveryRefused) return json({ settled: false }, 503); options.unknown = false; return json({ settled: true }) }
			if (url.pathname === "/preprocessing/jobs" && req.method === "GET") { f.lookups++; if (options.beforeLookup) await options.beforeLookup(); return json({ job: jobs.get(url.searchParams.get("submissionKey")) || null }) }
			if (url.pathname === "/preprocessing/jobs" && req.method === "POST") {
				let raw = ""; for await (const chunk of req) raw += chunk
				const body = JSON.parse(raw), key = req.headers["idempotency-key"]; f.posts++
				if (options.rejectSubmission) return json({ error: { code: "UNKNOWN_PROFILE", message: "/private/config", retry: "change-input" } }, 422)
				if (f.posts === 1 && options.firstPost) await options.firstPost({ body, key })
				let job = jobs.get(key)
				if (job) { assert.deepEqual(submissions.get(key), body); return json(job) }
				if (options.admissionUnavailable) return json({ error: { code: "MODEL_POLICY_UNAVAILABLE", retry: "check-status" } }, 503)
				job = { id: `job_${crypto.randomUUID().replaceAll("-", "")}`, projectId: "processor-private-scope", submissionKey: key, revision: 1, state: "queued", requestedSource: body.source, source: null, profile: { id: body.profileId }, documents: null, resultId: null }
				if (options.largeJobResponse) job.largeMetadata = "x".repeat(4096)
				jobs.set(key, job); submissions.set(key, structuredClone(body)); f.lastBody = body
				if (options.loseResponse && f.posts === 1) { req.socket.destroy(); return }
				return json(job, 202)
			}
			const job = [...jobs.values()].find((j) => j.id === parts[3])
			if (!job) return json({ error: { code: "NOT_FOUND" } }, 404)
			if (parts[4] === "cancel") { f.cancels++; if (!["succeeded", "partial", "failed", "cancelled", "interrupted"].includes(job.state)) { job.state = "cancelled"; job.revision++ } return json(job) }
			if (parts[4] === "results") return json(options.manifest || {
				jobId: job.id, resultId: job.resultId, source: { ...job.source, origin: job.requestedSource }, pipeline: { id: "default", configPath: "/private/config", token: "secret" }, outcome: "partial", coverage: { completed: 1 }, findings: [], figures: [],
				products: [{ id: "product_svg", path: "private/active.svg", bytes: products.length, sha256: sha(products), mediaType: "image/svg+xml", contentUrl: "/preprocessing/private" }, { id: "product_csv", path: "table.csv", mediaType: "text/csv", bytes: 1, sha256: sha("x") }],
				tables: [{ id: "table_one", rows: 1, columns: ["a"], typedPath: "private/rows.jsonl", csvPath: "table.csv", rowsUrl: "/preprocessing/private", downloads: [{ format: "csv", productId: "product_csv" }] }],
			})
			if (parts[4] === "tables") return options.rowTooLarge ? json({ error: { code: "ROW_TOO_LARGE", message: "Download /private/rows", retry: "change-input" } }, 413) : json({ offset: Number(url.searchParams.get("offset")), rows: [{ index: 1, cells: [{ type: "formula", value: "=1+1" }] }], count: 1, total: 1, nextOffset: null })
			if (parts[4] === "products") {
				if (options.productHeadDelayMs && req.method === "HEAD") await wait(options.productHeadDelayMs)
				if (options.productHeadError && req.method === "HEAD") { res.writeHead(options.productHeadError); res.end(); return }
				const etag = options.productEtag || '"strong"', modified = "Thu, 01 Oct 2026 00:00:00 GMT"
				// Match Python FileResponse: ignore ordinary preconditions but evaluate Range/If-Range.
				const range = req.headers.range && (!req.headers["if-range"] || [etag, modified].includes(req.headers["if-range"])) ? req.headers.range : null
				const match = range && /^bytes=(\d+)-(\d*)$/.exec(range), start = match ? Number(match[1]) : 0, end = match ? Math.min(match[2] ? Number(match[2]) : products.length - 1, products.length - 1) : products.length - 1
				if (range && (options.rangeError || !match || start >= products.length || end < start)) { res.writeHead(416, { "content-type": "application/json", "content-range": `bytes */${products.length}` }); res.end(req.method === "HEAD" ? undefined : JSON.stringify({ error: { message: "/private/product token=secret" } })); return }
				const bytes = range ? products.subarray(start, end + 1) : products
				res.writeHead(range ? 206 : 200, { "content-type": "image/svg+xml", "content-length": bytes.length, etag, "last-modified": modified, "accept-ranges": "bytes", ...(range ? { "content-range": `bytes ${start}-${end}/${products.length}` } : {}), "set-cookie": "private=secret" })
				res.end(req.method === "HEAD" ? undefined : bytes); return
			}
			if (options.jobReadError) return json({ error: { code: "PROVIDER_UNAVAILABLE", message: "/private/read secret" } }, 503)
			return json(job)
		} catch (error) { res.writeHead(500); res.end(JSON.stringify({ error: { code: "INTERNAL_ERROR" } })); f.error = error }
	})
	await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve)); f.port = server.address().port
	t.after(() => new Promise((resolve) => { server.closeAllConnections(); server.close(resolve) }))
	return f
}

export async function workspace(t, options = {}) {
	const dir = await fs.mkdtemp(path.join(os.tmpdir(), "gc-processing-")), root = path.join(dir, "workspace")
	await fs.mkdir(root)
	const state = options.state || (options.sqlite ? await FileState.open({ dir: path.join(dir, "state") }) : new MemoryState()), safeFs = {
		open: (name) => fs.open(path.join(root, name), "r"), stat: (name) => fs.stat(path.join(root, name), { bigint: true }),
		async probe() { return { reflink: false } }, async clone() { return false }, async checkOwnership() { return { ok: true } },
	}
	const captures = new FileCaptures({ state, safeFs, storeDir: path.join(dir, "sources"), ownership: { agentUids: [process.geteuid() + 20001], workerUids: [process.geteuid() + 20002] }, limits: options.limits })
	await captures.init()
	// Until the retention agent lands the real helper, model exactly its specified locking/commit boundary.
	if (!captures.withRetentionMetadata) captures.withRetentionMetadata = (kind, id, build) => captures.serial("retentionTail", async () => {
		const record = await captures.record(kind, id), handle = await captures.privateFile(record)
		try { const value = await build(record); await state.transaction(value.metadata); return value.result } finally { await handle.close() }
	})
	const f = { dir, workspaceDir: root, state, identity: state.identity, captures, safeFs, config: { preprocessing: {} }, ref: (name) => ({ ...state.identity, path: name }), async operation(id) { return state.get("operations", id) } }
	f.capture = async (name = "report.csv", bytes = "a\n1\n") => {
		await fs.writeFile(path.join(root, name), bytes)
		const requestId = crypto.randomUUID(), baseObservation = observation(f.ref(name), await safeFs.stat(name)), result = await captures.create({ path: name, requestId, baseObservation, computeDigest: true })
		return result.status === 202 ? (await until(async () => { const request = await state.get("requests", requestId); return request.state === "succeeded" && request }, "capture completion")).result : result
	}
	t.after(async () => { await captures.close(); await state.close?.(); await fs.rm(dir, { recursive: true, force: true }) })
	return f
}
