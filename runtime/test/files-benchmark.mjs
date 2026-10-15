#!/usr/bin/env node
/** Disposable Linux/Node 20 benchmark. Run as root in the files integration image.
 * The image's COPY runtime/test already includes this script on the next build.
 * Existing images can bind just this file read-only at its normal test path.
 * Output is JSONL; all workspace/state fixtures are owned and removed by this run.
 */
import assert from "node:assert/strict"
import crypto from "node:crypto"
import fs from "node:fs/promises"
import os from "node:os"
import path from "node:path"
import { spawn } from "node:child_process"
import { fileURLToPath } from "node:url"
import { setTimeout as pause } from "node:timers/promises"

const script = fileURLToPath(import.meta.url)
const MiB = 1024 ** 2, GiB = 1024 ** 3
const rounded = (n) => Math.round(n * 100) / 100
const emit = (event, values) => console.log(JSON.stringify({ event, ...values }))
const terminal = new Set(["succeeded", "failed", "cancelled", "interrupted"])

// Same real identity/provisioning path as files-process-worker.mjs, with IPC
// observation and per-fixture limits confined to this disposable driver.
async function daemon() {
	const { loadFilesConfig, createFilesServer } = await import("../files-server.js")
	const config = loadFilesConfig({ WORKSPACE_DIR: process.env.TEST_WORKSPACE, FILES_STATE_DIR: process.env.TEST_STATE, FILES_AGENT_UIDS: "999", FILES_WORKER_UIDS: "997", FILES_WORKER_UID: "997", FILES_LIMITS: process.env.BENCH_LIMITS || "{}" })
	const logger = { info() {}, warn(...args) { console.error(...args) }, error(...args) { console.error(...args) }, child() { return this } }
	const app = await createFilesServer({ config, secret: process.env.TEST_SECRET, logger })
	await new Promise((resolve) => app.server.listen(0, "127.0.0.1", resolve))
	process.send({ port: app.server.address().port, uid: process.geteuid(), node: process.version })
	process.on("message", async (message) => {
		try {
			if (message === "stop") { const drain = await app.shutdown(); process.send({ drain }); process.exit(0) }
			if (message?.snapshot) {
				const io = Object.fromEntries((await fs.readFile("/proc/self/io", "utf8")).trim().split("\n").map((line) => { const [key, value] = line.split(":"); return [key, Number(value.trim())] }))
				process.send({ snapshot: message.snapshot, memory: process.memoryUsage(), io })
			}
		} catch (error) { console.error("files-benchmark daemon:", error); process.exitCode = 1 }
	})
}

async function main() {
	assert.equal(process.platform, "linux", "Use the Linux integration image")
	assert.equal(process.geteuid(), 0, "The fixture driver must launch UID 998 from root")
	assert.equal(Number(process.versions.node.split(".")[0]), 20, "Use the Node 20 integration image")
	const number = (key, fallback, max) => { const value = Number(process.env[key] || fallback); assert(Number.isSafeInteger(value) && value > 0 && value <= max, `${key} must be 1..${max}`); return value }
	const totalMs = number("BENCH_TOTAL_MS", 480000, 600000)
	const createMs = number("BENCH_CREATE_MS", 180000, 180000)
	const scanMs = number("BENCH_SCAN_MS", 90000, 120000)
	const started = performance.now(), deadline = Date.now() + totalMs
	const abort = new AbortController(), fixtures = [], leases = [], failures = [], limitations = []
	const watchdog = setTimeout(() => abort.abort(new Error("Benchmark total time budget elapsed")), totalMs)
	const interrupt = () => abort.abort(new Error("Benchmark interrupted"))
	process.once("SIGTERM", interrupt); process.once("SIGINT", interrupt)
	const checkTime = () => { if (abort.signal.aborted) throw abort.signal.reason }
	const requestTimeout = (ms = 45000) => AbortSignal.any([abort.signal, AbortSignal.timeout(ms)])
	async function optionalRead(filename) { try { return (await fs.readFile(filename, "utf8")).trim() } catch (error) { return { unavailable: error.code } } }
	async function resident(state) {
		const result = { logicalBytes: 0, allocatedBytes: 0, activeLogicalBytes: 0, activeAllocatedBytes: 0, files: 0, activeFiles: 0 }
		let names
		try { names = await fs.readdir(`${state}/sources/blobs`) } catch (error) { if (error.code === "ENOENT") return result; throw error }
		for (const name of names) {
			let stat
			try { stat = await fs.stat(`${state}/sources/blobs/${name}`) } catch (error) { if (error.code === "ENOENT") continue; throw error }
			result.files++; result.logicalBytes += stat.size; result.allocatedBytes += stat.blocks * 512
			if (name.endsWith(".partial")) { result.activeFiles++; result.activeLogicalBytes += stat.size; result.activeAllocatedBytes += stat.blocks * 512 }
		}
		return result
	}
	async function procMemory(pid) {
		try {
			const text = await fs.readFile(`/proc/${pid}/status`, "utf8")
			return { pid, uid: Number(/^Uid:\s+(\d+)/m.exec(text)?.[1]), rssBytes: Number(/^VmRSS:\s+(\d+)/m.exec(text)?.[1] || 0) * 1024 }
		} catch (error) { if (error.code === "ENOENT" || error.code === "ESRCH") return null; throw error }
	}
	async function parsers() {
		const entries = (await fs.readdir("/proc")).filter((name) => /^\d+$/.test(name))
		return (await Promise.all(entries.map((pid) => procMemory(Number(pid))))).filter((entry) => entry?.uid === 997)
	}
	async function fixture(label, limits = {}) {
		checkTime()
		const base = await fs.mkdtemp(`/workspace/files-benchmark-${label}-`), root = `${base}/project`, state = `${base}/private`
		await fs.chmod(base, 0o755); await fs.mkdir(root, { mode: 0o2775 }); await fs.chown(root, 999, 999); await fs.chmod(root, 0o2775)
		await fs.mkdir(state, { mode: 0o700 }); await fs.chown(state, 998, 999)
		const f = { label, base, root, state, jobs: new Set(), logs: "", closed: false }; fixtures.push(f)
		f.start = async () => {
			const secret = crypto.randomBytes(32).toString("hex")
			f.child = spawn(process.execPath, [script, "--daemon"], { uid: 998, gid: 999, cwd: path.dirname(path.dirname(script)), env: { PATH: "/usr/local/bin:/usr/bin:/bin", TEST_WORKSPACE: root, TEST_STATE: state, TEST_SECRET: secret, BENCH_LIMITS: JSON.stringify(limits) }, stdio: ["ignore", "ignore", "pipe", "ipc"] })
			f.closedPromise = new Promise((resolve) => f.child.once("close", (code, signal) => resolve({ code, signal })))
			f.child.stderr.on("data", (part) => { f.logs = (f.logs + part).slice(-16384) })
			const ready = await new Promise((resolve, reject) => {
				const timer = setTimeout(() => reject(new Error(`No ${label} readiness: ${f.logs}`)), 15000)
				f.child.once("error", (error) => { clearTimeout(timer); reject(error) })
				f.child.on("message", (message) => { if (message.port) { clearTimeout(timer); resolve(message) } if (message.drain) f.drain = message.drain })
				f.child.once("exit", (code) => { clearTimeout(timer); reject(new Error(`${label} daemon exited ${code}: ${f.logs}`)) })
			})
			assert.equal(ready.uid, 998); assert.equal(ready.node, process.version)
			f.request = (route, init = {}) => fetch(`http://127.0.0.1:${ready.port}/files/${route}`, { ...init, signal: init.signal || requestTimeout(), headers: { "x-gc-gate": secret, ...init.headers } })
			f.json = async (route, body, method = body === undefined ? "GET" : "POST") => {
				const before = performance.now(), response = await f.request(route, { method, ...(body === undefined ? {} : { body: JSON.stringify(body), headers: { "content-type": "application/json" } }) })
				const text = await response.text(), data = JSON.parse(text)
				return { status: response.status, data, wallMs: rounded(performance.now() - before), responseBytes: Buffer.byteLength(text) }
			}
			f.snapshot = () => new Promise((resolve, reject) => {
				const id = crypto.randomUUID(), timer = setTimeout(() => { f.child.off("message", reply); reject(new Error(`${label} snapshot timeout`)) }, 5000)
				const reply = (message) => { if (message.snapshot === id) { clearTimeout(timer); f.child.off("message", reply); resolve(message) } }
				f.child.on("message", reply); f.child.send({ snapshot: id })
			})
			const info = await f.json("info"); assert.equal(info.status, 200); assert.equal(info.data.captures.state, "available"); assert.equal(info.data.preview.state, "available")
			f.info = info.data
			emit("daemon", { label, uid: ready.uid, parserConfiguredUid: 997, node: ready.node, captures: info.data.captures, limits: info.data.limits })
			return f
		}
		return f
	}
	async function close(f) {
		if (f.closed || !f.child) return
		f.closed = true
		if (f.child.exitCode === null && f.child.signalCode === null) {
			for (const id of f.jobs) { try { await f.json(`jobs/${id}/cancel`, {}) } catch (error) { emit("cleanup-cancel-error", { label: f.label, jobId: id, error: String(error) }) } }
			if (f.child.connected) f.child.send("stop")
			const timer = setTimeout(() => f.child.kill("SIGKILL"), 15000)
			f.exit = await f.closedPromise; clearTimeout(timer)
		} else f.exit = await f.closedPromise
		emit("daemon-closed", { label: f.label, ...f.exit, drain: f.drain || null, ...(f.exit.code !== 0 ? { logs: f.logs } : {}) })
		assert.equal(f.exit.code, 0, `${f.label} did not shut down cleanly`)
	}
	async function measure(f, label, work, { observeParser = false, observeBlobs = true, periodMs = 25 } = {}) {
		const before = await f.snapshot(), blobsBefore = await resident(f.state), clientBefore = process.memoryUsage().rss
		let peakDaemon = before.memory.rss, peakParser = 0, peakClient = clientBefore, peakResident = blobsBefore.allocatedBytes, peakActive = blobsBefore.activeAllocatedBytes, samples = 0, samplingError
		const parserPids = new Set(); let sampling = true
		const sampler = (async () => {
			while (sampling) {
				try {
					const memory = await procMemory(f.child.pid); peakDaemon = Math.max(peakDaemon, memory?.rssBytes || 0); peakClient = Math.max(peakClient, process.memoryUsage().rss)
					if (observeParser) { const workers = await parsers(); for (const worker of workers) parserPids.add(worker.pid); peakParser = Math.max(peakParser, workers.reduce((sum, worker) => sum + worker.rssBytes, 0)) }
					if (observeBlobs) { const bytes = await resident(f.state); peakResident = Math.max(peakResident, bytes.allocatedBytes); peakActive = Math.max(peakActive, bytes.activeAllocatedBytes) }
					samples++
				} catch (error) { samplingError = String(error); break }
				await pause(periodMs)
			}
		})()
		const begin = performance.now()
		try {
			const result = await work(), wallMs = rounded(performance.now() - begin), after = await f.snapshot(), blobsAfter = await resident(f.state)
			peakDaemon = Math.max(peakDaemon, after.memory.rss); peakResident = Math.max(peakResident, blobsAfter.allocatedBytes)
			const observation = { wallMs, daemonRssBefore: before.memory.rss, daemonRssAfter: after.memory.rss, sampledPeakDaemonRss: peakDaemon, sampledPeakParserRss: peakParser, parserUidsObserved: parserPids.size ? [997] : [], parserPids: [...parserPids], clientRssBefore: clientBefore, clientRssAfter: process.memoryUsage().rss, sampledPeakClientRss: peakClient, blobsBefore, blobsAfter, sampledPeakResidentAllocatedBytes: peakResident, sampledPeakActiveAllocatedBytes: peakActive, processIoDelta: Object.fromEntries(Object.keys(after.io).map((key) => [key, after.io[key] - before.io[key]])), samples, periodMs, ...(samplingError ? { samplingError } : {}) }
			emit(label, { ...result, observation }); return { ...result, observation }
		} finally { sampling = false; await sampler }
	}
	async function pollJob(f, id, timeoutMs = 120000) {
		const end = Math.min(Date.now() + timeoutMs, deadline - 15000)
		while (Date.now() < end) {
			checkTime(); const result = await f.json(`jobs/${id}`); assert.equal(result.status, 200)
			if (terminal.has(result.data.state)) { f.jobs.delete(id); return result.data }
			await pause(100)
		}
		await f.json(`jobs/${id}/cancel`, {})
		const cancelEnd = Date.now() + 10000
		while (Date.now() < cancelEnd) {
			checkTime(); const result = await f.json(`jobs/${id}`); assert.equal(result.status, 200)
			if (terminal.has(result.data.state)) { f.jobs.delete(id); throw new Error(`Job ${id} exceeded budget; terminal state ${result.data.state}`) }
			await pause(100)
		}
		throw new Error(`Job ${id} exceeded budget and did not confirm cancellation within 10 seconds`)
	}
	async function capture(f, name, computeDigest = false) {
		const submission = await f.json("captures", { path: name, requestId: crypto.randomUUID(), computeDigest })
		assert([201, 202].includes(submission.status), JSON.stringify(submission))
		if (submission.data.jobId) f.jobs.add(submission.data.jobId)
		const job = submission.status === 202 ? await pollJob(f, submission.data.jobId) : null
		const result = job?.result || submission.data
		if (result.lease) leases.push([f, result.lease.leaseId])
		return { submissionStatus: submission.status, admissionMs: submission.wallMs, job, source: result.source }
	}
	const baseRow = '00000001,"café ""x""",42,"line one\nline two'
	const row = Buffer.from(`${baseRow}${"x".repeat(128 - Buffer.byteLength(baseRow) - 2)}"\n`)
	const header = Buffer.from(`id,name,value,${"notes".padEnd(128 - "id,name,value,".length - 1)}\n`)
	assert.equal(row.length, 128); assert.equal(header.length, 128)
	const block = Buffer.alloc(4 * MiB); for (let offset = 0; offset < block.length; offset += row.length) row.copy(block, offset)
	async function writeAll(handle, bytes, position) {
		let at = 0
		while (at < bytes.length) { const { bytesWritten } = await handle.write(bytes, at, bytes.length - at, position + at); assert(bytesWritten > 0); at += bytesWritten }
	}
	async function csv(root, name, sizeBytes) {
		const start = performance.now(), handle = await fs.open(`${root}/${name}`, "wx", 0o664), hash = crypto.createHash("sha256")
		try {
			await writeAll(handle, header, 0); hash.update(header)
			for (let at = header.length; at < sizeBytes;) { checkTime(); const bytes = block.subarray(0, Math.min(block.length, sizeBytes - at)); await writeAll(handle, bytes, at); hash.update(bytes); at += bytes.length }
			await handle.sync(); await handle.chown(999, 999)
		} finally { await handle.close() }
		const stat = await fs.stat(`${root}/${name}`); assert.equal(stat.size, sizeBytes); assert(stat.blocks * 512 >= sizeBytes, "CSV must be materialized, not sparse")
		const sha256 = hash.digest("hex")
		emit("dataset", { path: name, sizeBytes, allocatedBytes: stat.blocks * 512, logicalRows: sizeBytes / 128, rowBytes: 128, encoding: "utf-8", embeddedQuotedNewline: true, completeLogicalRows: true, constructionIncludesSha256: true, creationMs: rounded(performance.now() - start) })
		return { name, sizeBytes, sha256 }
	}
	function expectedCsv(start, size) { const bytes = Buffer.alloc(size); for (let i = 0; i < size; i++) { const offset = start + i; bytes[i] = offset < 128 ? header[offset] : row[(offset - 128) % 128] } return bytes }
	async function range(f, route, start, size, etag, expected) {
		const before = performance.now(), response = await f.request(route, { headers: { range: `bytes=${start}-${start + size - 1}`, ...(etag ? { "if-match": etag } : {}) } })
		const firstHeadersMs = rounded(performance.now() - before)
		assert.equal(response.status, 206); const bytes = Buffer.from(await response.arrayBuffer()); assert.equal(bytes.length, size)
		if (expected) assert.deepEqual(bytes, expected)
		return { bytes: bytes.length, firstHeadersMs, wallMs: rounded(performance.now() - before), contentRange: response.headers.get("content-range") }
	}
	async function warmRanges(f, source, binary = false) {
		const route = `captures/${source.captureId}/raw`, rows = []
		for (const size of [1024, 64 * 1024, MiB]) {
			const start = binary ? GiB : 256 * MiB, expected = binary ? Buffer.alloc(size) : expectedCsv(start, size)
			await range(f, route, start, size, source.etag, expected)
			const runs = []; for (let i = 0; i < 5; i++) runs.push(await range(f, route, start, size, source.etag, expected))
			const times = runs.map((run) => run.wallMs).sort((a, b) => a - b)
			rows.push({ sizeBytes: size, measuredRequests: 5, bytesTransferred: size * 5, primingRequests: 1, medianMs: times[2], maxMs: times[4], firstHeadersMedianMs: runs.map((run) => run.firstHeadersMs).sort((a, b) => a - b)[2] })
		}
		emit("warm-protected-ranges", { path: source.ref.path, binaryRangesOnly: binary, rows })
	}
	try {
		const disk = await fs.statfs("/workspace"), freeBytes = disk.bavail * disk.bsize
		emit("environment", { node: process.version, image: process.env.BENCH_IMAGE || "gc-runtime-files:integration", imageId: process.env.BENCH_IMAGE_ID || "not-supplied", kernel: os.release(), architecture: os.arch(), cpu: os.cpus()[0]?.model, logicalCpus: os.cpus().length, hostMemoryBytes: os.totalmem(), cgroupMemoryMax: await optionalRead("/sys/fs/cgroup/memory.max"), filesystemType: `0x${disk.type.toString(16)}`, filesystemFreeBytes: freeBytes, workspaceMount: (await fs.readFile("/proc/self/mountinfo", "utf8")).split("\n").filter((line) => line.split(" ")[4] === "/workspace"), network: "container --network=none; HTTP on local loopback only", cacheState: "fresh fixtures and private metadata; OS page cache uncontrolled and writes initially warm data; no drop_caches", totalBudgetMs: totalMs, metadataCreationBudgetMs: createMs, metadataScanBudgetMs: scanMs, observer: "sampled RSS and st_blocks; instrumentation overhead included", scientificPdf: "not exercised; sparse .bin byte ranges only", agentAcpContention: "deferred: concurrent agent interface is not available in this file-daemon run" })
		const f = await fixture("bytes"), datasets = [await csv(f.root, "table-10MiB.csv", 10 * MiB)]
		if (freeBytes >= 7 * GiB) datasets.push(await csv(f.root, "table-1GiB.csv", GiB))
		else limitations.push("Skipped 1 GiB and sparse 2 GiB: fewer than 7 GiB available for materialized sources, captures, and metadata")
		let sparse
		if (datasets.length === 2) {
			const handle = await fs.open(`${f.root}/sparse-2GiB.bin`, "wx", 0o664)
			try { await writeAll(handle, Buffer.from("synthetic byte-range fixture\n"), 0); await handle.truncate(2 * GiB); await writeAll(handle, Buffer.from("END\n"), 2 * GiB - 4); await handle.sync(); await handle.chown(999, 999) } finally { await handle.close() }
			const stat = await fs.stat(`${f.root}/sparse-2GiB.bin`); assert(stat.blocks * 512 < stat.size / 100)
			sparse = { name: "sparse-2GiB.bin", sizeBytes: stat.size }; emit("dataset", { path: sparse.name, sizeBytes: stat.size, allocatedBytes: stat.blocks * 512, binaryRangesOnly: true, scientificStructure: "none" })
		}
		await f.start()
		assert(!f.info.captures.strategies.includes("atomic-clone"), "Use a filesystem with no reflink support to measure checked-copy")
		for (const dataset of datasets) {
			const result = await measure(f, "first-preview", async () => {
				const response = await f.json("preview", { path: dataset.name, format: "csv", rowLimit: 100, readBytes: 64 * 1024 })
				assert.equal(response.status, 200, JSON.stringify(response)); const preview = response.data
				assert.equal(preview.source.kind, "runtime-fragment"); assert.equal(preview.rows.length, 100); assert.equal(preview.rows[1].cells[1].text, 'café "x"'); assert(preview.rows[1].cells[3].text.startsWith("line one\nline two"))
				assert(preview.metrics.bytesRead <= 64 * 1024 && preview.metrics.bytesRead < dataset.sizeBytes)
				const retainedBytes = preview.source.byteEnd - preview.source.byteStart; assert.equal(retainedBytes, 100 * 128)
				leases.push([f, preview.lease.leaseId])
				return { path: dataset.name, sourceSizeBytes: dataset.sizeBytes, readBudgetBytes: 64 * 1024, bytesRead: preview.metrics.bytesRead, fragmentRetainedBytes: retainedBytes, serverElapsedMs: preview.metrics.elapsedMs, httpWallMs: response.wallMs, rows: preview.rows.length, parser: preview.parser, stopReason: preview.stopReason, digest: "not requested", noReflink: true }
			}, { observeParser: true, periodMs: 10 })
			assert.equal(result.observation.blobsAfter.activeFiles, 0)
			assert.equal((await fs.readdir(`${f.state}/sources/blobs`)).filter((name) => name.startsWith("capture.")).length, 0, "First preview must not create a whole-file capture")
			assert.deepEqual(result.observation.parserUidsObserved, [997], "Observe the real parser identity during preview")
		}
		const captured = new Map()
		for (const dataset of [...datasets, ...(sparse ? [sparse] : [])]) {
			const result = await measure(f, "full-capture-copy", async () => {
				const result = await capture(f, dataset.name); assert.equal(result.job?.state, "succeeded"); assert.equal(result.source.consistency, "checked-copy"); assert.equal(result.source.sizeBytes, dataset.sizeBytes); assert.equal(result.source.digest.state, "not-requested")
				return { path: dataset.name, sizeBytes: dataset.sizeBytes, admissionMs: result.admissionMs, state: result.job.state, serverJobElapsedMs: result.job.progress.elapsedMs, consistency: result.source.consistency, digest: result.source.digest.state, source: result.source }
			})
			captured.set(dataset.name, result.source)
		}
		const large = datasets.at(-1)
		await measure(f, "digest-request", async () => {
			const result = await capture(f, large.name, true); assert.equal(result.job?.state, "succeeded"); assert.equal(result.source.digest.state, "ready"); assert.equal(result.source.digest.sha256, large.sha256)
			return { path: large.name, state: result.job.state, admissionMs: result.admissionMs, serverJobElapsedMs: result.job.progress.elapsedMs, sizeBytes: result.source.sizeBytes, digestVerified: true, work: "checked-copy plus SHA-256 in the same pass; checked-copy sources have no hash-only reuse route" }
		})
		if (large.sizeBytes === GiB) {
			const source = captured.get(large.name); await warmRanges(f, source)
			await measure(f, "two-concurrent-protected-streams", async () => {
				let active = 0, maxActive = 0
				const consume = async (start) => {
					const before = performance.now(), size = 64 * MiB, response = await f.request(`captures/${source.captureId}/raw`, { headers: { range: `bytes=${start}-${start + size - 1}`, "if-match": source.etag } }); assert.equal(response.status, 206)
					active++; maxActive = Math.max(maxActive, active); const reader = response.body.getReader(); let bytes = 0, chunks = 0
					try { while (true) { const next = await reader.read(); if (next.done) break; assert.equal(next.value[0], row[(start + bytes - 128) % 128]); bytes += next.value.length; chunks++; await pause(2) } } finally { active--; reader.releaseLock() }
					assert.equal(bytes, size); return { bytes, chunks, wallMs: rounded(performance.now() - before) }
				}
				const streams = await Promise.all([consume(128 * MiB), consume(512 * MiB)]); assert.equal(maxActive, 2)
				return { streams, maxActive, totalBytes: streams.reduce((sum, stream) => sum + stream.bytes, 0), consumerDelayMsPerChunk: 2, note: "Two overlapping local streams; sampled RSS, not a universal concurrency bound" }
			}, { observeBlobs: false })
		}
		if (sparse) {
			const source = captured.get(sparse.name); await warmRanges(f, source, true)
			const end = await range(f, `captures/${source.captureId}/raw`, 2 * GiB - 4, 4, source.etag, Buffer.from("END\n")); emit("sparse-tail-range", end)
		}
		await measure(f, "cancel-job", async () => {
			const submission = await f.json("captures", { path: sparse?.name || large.name, requestId: crypto.randomUUID() }); assert.equal(submission.status, 202); const id = submission.data.jobId; f.jobs.add(id)
			const until = Date.now() + 10000; let active
			while (Date.now() < until) { active = await resident(f.state); if (active.activeLogicalBytes > 0) break; await pause(10) }
			assert(active.activeLogicalBytes > 0, "Observe an active checked-copy before cancelling")
			const before = performance.now(), acknowledgement = await f.json(`jobs/${id}/cancel`, {}), job = await pollJob(f, id, 10000)
			assert.equal(job.state, "cancelled"); assert.equal((await resident(f.state)).activeFiles, 0)
			return { activeBeforeCancel: active, acknowledgementState: acknowledgement.data.state, terminalState: job.state, cancelToTerminalMs: rounded(performance.now() - before), error: job.error.error, physicalEnospc: "not injected" }
		})
		const quota = await fixture("quota", { retainedBytes: MiB })
		await fs.link(`${f.root}/${datasets[0].name}`, `${quota.root}/quota.csv`); await quota.start()
		await measure(quota, "space-job", async () => {
			const submission = await quota.json("captures", { path: "quota.csv", requestId: crypto.randomUUID() }); assert.equal(submission.status, 202); quota.jobs.add(submission.data.jobId)
			const job = await pollJob(quota, submission.data.jobId); assert.equal(job.state, "failed"); assert.equal(job.error.status, 507); assert.equal(job.error.error, "insufficient_storage"); assert.equal((await resident(quota.state)).files, 0)
			return { ceilingBytes: MiB, requestedBytes: 10 * MiB, admissionStatus: submission.status, terminalState: job.state, errorStatus: job.error.status, error: job.error.error, serverJobElapsedMs: job.progress.elapsedMs, physicalEnospc: "not injected; deployment retention-ceiling failure only" }
		})
		await close(quota)
		for (const [owner, id] of leases) { if (!owner.closed) { const released = await owner.json(`leases/${id}`, undefined, "DELETE"); assert.equal(released.status, 200) } }
		await close(f)
		const index = await fixture("index", { indexScanMs: 1000, scanIntervalMs: 300000, viewBytes: 256 * MiB })
		const createStart = performance.now(), createEnd = Math.min(Date.now() + createMs, deadline - scanMs - 20000)
		const targetEntries = 100000, directoryCount = 100, fileTarget = targetEntries - directoryCount - 1
		for (let i = 0; i < directoryCount; i++) { const dir = `${index.root}/bucket-${String(i).padStart(3, "0")}`; await fs.mkdir(dir, { mode: 0o2775 }); await fs.chown(dir, 999, 999); await fs.chmod(dir, 0o2775) }
		await fs.link(`${f.root}/${large.name}`, `${index.root}/large-sentinel.csv`)
		let next = 0, created = 0
		await Promise.all(Array.from({ length: 16 }, async () => {
			while (Date.now() < createEnd && !abort.signal.aborted) {
				const id = next++; if (id >= fileTarget) return
				await fs.writeFile(`${index.root}/bucket-${String(id % directoryCount).padStart(3, "0")}/entry-${String(id).padStart(6, "0")}.txt`, "", { flag: "wx", mode: 0o664 }); created++
			}
		}))
		const creation = { targetEntries, createdEntries: created + directoryCount + 1, emptyFilesCreated: created, directoryCount, largeSentinelBytes: large.sizeBytes, largeSentinel: "hardlink to the earlier materialized CSV; shared inode", parallelCreationCap: 16, creationMs: rounded(performance.now() - createStart), complete: created === fileTarget, budgetMs: createMs }
		emit("metadata-fixture", creation)
		if (!creation.complete) limitations.push(`Metadata creation stopped at ${creation.createdEntries}/100000 entries; creation/time budget respected`)
		await index.start()
		const scanStart = performance.now(), scanEnd = Math.min(Date.now() + scanMs, deadline - 15000), initialIo = await index.snapshot()
		let info = (await index.json("info")).data
		while (info.index.observedCount < 600 && info.index.state !== "ready" && Date.now() < scanEnd) { await pause(25); info = (await index.json("info")).data }
		const query = { path: "", q: "", kind: "file", limit: "200" }
		const findRoute = (cursor) => `find?${new URLSearchParams({ ...query, ...(cursor ? { cursor } : {}) })}`
		const cold = await measure(index, "metadata-cold-partial-view", async () => {
			const response = await index.json(findRoute()); assert.equal(response.status, 200)
			return { pageRows: response.data.items.length, count: response.data.count, coverage: response.data.coverage, httpWallMs: response.wallMs, responseBytes: response.responseBytes, nextCursor: response.data.nextCursor, contentHashRequested: false }
		}, { observeBlobs: false, periodMs: 100 })
		async function warmPage(label, cursor) {
			if (!cursor) { emit(label, { skipped: "No second 200-row page available" }); return }
			const runs = []
			for (let i = 0; i < 5; i++) { const result = await index.json(findRoute(cursor)); assert.equal(result.status, 200); runs.push({ wallMs: result.wallMs, responseBytes: result.responseBytes, rows: result.data.items.length, count: result.data.count, coverageState: result.data.coverage.state }) }
			const times = runs.map((run) => run.wallMs).sort((a, b) => a - b)
			emit(label, { measuredRequests: 5, requestedPageRows: 200, medianMs: times[2], maxMs: times[4], runs, contentHashRequested: false, semantics: "Repeated cursor into one frozen metadata view, not new query/view construction" })
		}
		await warmPage("metadata-warm-partial-200-page", cold.nextCursor)
		await measure(index, "metadata-scan-wait", async () => {
			while (Date.now() < scanEnd) { info = (await index.json("info")).data; if (info.index.state === "ready") break; await pause(250) }
			info = (await index.json("info")).data; const finalIo = await index.snapshot()
			return { scanWaitBudgetMs: scanMs, elapsedSinceReadinessMs: rounded(performance.now() - scanStart), index: info.index, creationComplete: creation.complete, ready: info.index.state === "ready", contentHashRequested: false, daemonLogicalReadCharsDuringScan: finalIo.io.rchar - initialIo.io.rchar, largeSentinelBytes: large.sizeBytes, noExhaustiveRealWorkspaceClaim: true }
		}, { observeBlobs: false, periodMs: 100 })
		if (info.index.state !== "ready") limitations.push(`Metadata index remained ${info.index.state} with ${info.index.observedCount} observations at the scan deadline; results are partial`)
		const finalView = await measure(index, "metadata-final-view", async () => {
			const response = await index.json(findRoute()); assert.equal(response.status, 200)
			return { pageRows: response.data.items.length, count: response.data.count, coverage: response.data.coverage, httpWallMs: response.wallMs, responseBytes: response.responseBytes, nextCursor: response.data.nextCursor, contentHashRequested: false }
		}, { observeBlobs: false, periodMs: 100 })
		await warmPage("metadata-warm-final-200-page", finalView.nextCursor)
		await close(index)
		limitations.push("Fresh application state, not a flushed OS/device cache; CSV creation and copy/hash passes warm the filesystem", "Single bounded local run, no cloud/network-target/PDF-structure measurements or agent/ACP contention", "RSS/allocated-byte peaks are samples; short-lived extrema can be missed and observer overhead is included", "Digest request includes a second checked-copy, not isolated hash-only timing", "Space test exercises the deployment retention ceiling, not physical ENOSPC", "Metadata viewBytes explicitly raised from 64 MiB to 256 MiB; empty-file namespace and one large sentinel are synthetic")
	} catch (error) { failures.push(String(error.stack || error)); emit("benchmark-error", { error: failures.at(-1), action: "Inspect the preceding phase and daemon logs; rerun only in an isolated test container" }); process.exitCode = 1 }
	finally {
		clearTimeout(watchdog)
		for (const f of fixtures.toReversed()) {
			try { await close(f) } catch (error) { failures.push(`Cleanup ${f.label}: ${error}`); process.exitCode = 1 }
			try { await fs.rm(f.base, { recursive: true, force: true }) } catch (error) { failures.push(`Remove ${f.base}: ${error}`); process.exitCode = 1 }
		}
		const remainingParsers = await parsers(); if (remainingParsers.length) { failures.push(`Unreaped parsers: ${JSON.stringify(remainingParsers)}`); process.exitCode = 1 }
		process.off("SIGTERM", interrupt); process.off("SIGINT", interrupt)
		emit("summary", { status: failures.length ? "FAILED" : limitations.length ? "DONE_WITH_CONCERNS" : "DONE", elapsedMs: rounded(performance.now() - started), fixtureDirectoriesRemoved: fixtures.map((f) => f.base), remainingParsers, failures, limitations })
	}
}

if (process.argv.includes("--daemon")) await daemon()
else await main()
