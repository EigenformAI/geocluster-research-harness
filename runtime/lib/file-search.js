import { spawn } from "node:child_process"
import { basename, isAbsolute } from "node:path"
import { setImmediate as yieldTurn } from "node:timers/promises"
import { FILE_LIMITS, FILES_CONTRACT_VERSION, FileError, budget, canonicalPath, fileError as mapFileError, observation, observationToken, sameObject } from "./file-contract.js"

function fileError(error, tool) {
	const mapped = mapFileError(error, tool)
	return new FileError(mapped.status, mapped.error, mapped.message, {
		...mapped.toJSON(), agent: mapped.agent || "file-service", tool: mapped.tool || tool,
		action: mapped.action && mapped.action !== tool ? mapped.action : "Inspect the requested scope, permissions, and storage; retry within the same search scope.",
	})
}

const flag = (value, name) => {
	if ([undefined, null, false, 0, "0", "false"].includes(value)) return false
	if ([true, 1, "1", "true"].includes(value)) return true
	throw new FileError(400, "invalid_filter", `${name} must be a boolean or 0/1.`)
}

function globFilter(glob) {
	if (glob === undefined || glob === null || glob === "") return () => true
	if (typeof glob !== "string" || glob.length > 200 || /[\u0000-\u001f\u007f\\]/u.test(glob) || /[\[\]{}]/u.test(glob)) throw new FileError(400, "invalid_filter", "glob supports literals, *, **, and ? (at most 200 characters).")
	const characters = Array.from(glob)
	const tokens = []
	for (let n = 0; n < characters.length; n++) {
		const character = characters[n]
		if (character === "*" && characters[n + 1] === "*") {
			n++
			if (characters[n + 1] === "/") { tokens.push({ type: "prefix" }); n++ } else tokens.push({ type: "deep" })
		} else tokens.push({ type: character === "*" ? "star" : character === "?" ? "any" : "literal", character })
	}
	return (path) => {
		const text = Array.from(glob.includes("/") ? path : path.split("/").at(-1))
		let previous = new Uint8Array(text.length + 1)
		let current = new Uint8Array(text.length + 1)
		previous[0] = 1
		// Dynamic programming avoids exponential regex backtracking on public globs.
		for (const token of tokens) {
			current.fill(0)
			const wildcard = ["star", "deep", "prefix"].includes(token.type)
			if (wildcard) current[0] = previous[0]
			let reachable = previous[0]
			for (let n = 1; n <= text.length; n++) {
				const character = text[n - 1]
				if (token.type === "prefix") { current[n] = previous[n] || (reachable && character === "/"); reachable ||= previous[n] }
				else if (wildcard) current[n] = previous[n] || (current[n - 1] && (token.type === "deep" || character !== "/"))
				else current[n] = previous[n - 1] && (token.type === "any" ? character !== "/" : character === token.character)
			}
			const swap = previous
			previous = current
			current = swap
		}
		return Boolean(previous[text.length])
	}
}

function excerpt(text, limit) {
	const bytes = Buffer.from(text.replace(/\r?\n$/, ""), "utf8")
	return new TextDecoder("utf-8").decode(bytes.subarray(0, limit), { stream: bytes.length > limit })
}

/** One bounded live scan. Only a safely opened file descriptor is inherited by ripgrep. */
export class FileSearch {
	constructor({ safeFs, index, limits = {}, rgBin = "rg", limitBin = "prlimit" }) {
		this.safeFs = safeFs
		this.index = index
		this.rgBin = rgBin
		if (typeof limitBin !== "string" || (limitBin !== "prlimit" && !isAbsolute(limitBin)) || /[\u0000-\u001f\u007f]/u.test(limitBin)) throw new FileError(400, "invalid_path", "limitBin must be a trusted absolute executable path, or the fixed prlimit name on the trusted runtime PATH.", { tool: "file-search.limits" })
		this.limitBin = limitBin
		this.limitProof = null
		this.limits = { ...FILE_LIMITS, searchEntries: 100000, searchExclusions: 200, searchWorkerBytes: 256 * 1024 * 1024, ...limits }
		for (const key of ["searchFileBytes", "searchEventBytes", "searchExcerptBytes", "searchEntries", "searchExclusions", "elapsedMs", "responseBytes", "readBytes", "searchWorkerBytes"]) {
			if (!Number.isSafeInteger(this.limits[key]) || this.limits[key] < 1) throw new FileError(400, "invalid_budget", `${key} must be a positive integer.`)
		}
	}

	#workerLimits(elapsedMs) {
		// RLIMIT_AS includes nonresident mappings; Linux RLIMIT_RSS is not an enforceable cap.
		return { workersMemoryLimited: true, addressSpaceBytes: this.limits.searchWorkerBytes, dataBytes: Math.max(1, Math.floor(this.limits.searchWorkerBytes / 2)), cpuSeconds: Math.ceil(elapsedMs / 1000) + 1, coreBytes: 0 }
	}

	capabilities() {
		return { ...this.#workerLimits(this.limits.elapsedMs), primitive: "linux-prlimit", limitBin: this.limitBin, memoryCapAvailable: this.limitProof?.available ?? null, proof: this.limitProof ? structuredClone(this.limitProof) : { state: "unverified" } }
	}

	async #stat(path, allowSymlink = false) {
		try { this.safeFs.policy.assertRead(path); return await this.safeFs.stat(path, { allowSymlink }) }
		catch (error) { throw fileError(error, "file-search.stat") }
	}

	async #prove(path, before, generation) {
		const after = await this.#stat(path)
		if (!sameObject(before, after) || this.safeFs.generation !== generation) throw new FileError(409, "source_changed", "The requested search scope or resource policy changed. Restart this same scope.", { tool: "file-search", action: "Re-stat the requested path and restart the search without widening its scope." })
	}

	search(options = {}, { signal } = {}) {
		if (this.closed) return Promise.reject(new FileError(503, "search_unavailable", "FileSearch is closed."))
		if (this.running) return Promise.reject(new FileError(429, "capacity", "One content-search worker is already active for this workspace.", { retryAfter: 1, tool: "file-search", action: "Retry after the active search completes." }))
		// Reserve admission synchronously, before any filesystem await.
		this.running = this.#search(options, signal).finally(() => { this.running = null; this.stopWorker = null; this.stopSearch = null })
		return this.running
	}

	async #search(options, signal) {
		const path = canonicalPath(options.path ?? "")
		const q = options.q ?? ""
		if (typeof q !== "string" || !q || q.length > 500 || q.includes("\0")) throw new FileError(400, "invalid_query", "q is required and must be at most 500 characters without NUL.")
		const regex = flag(options.regex, "regex")
		const caseSensitive = flag(options.caseSensitive, "caseSensitive")
		const matchesGlob = globFilter(options.glob)
		const maxResults = budget(options.maxResults, this.limits.searchResults, this.limits.searchMaxResults, "maxResults")
		const fileBytes = budget(options.fileBytes, this.limits.searchFileBytes, this.limits.searchFileBytes, "fileBytes")
		const readBytes = budget(options.readBytes, this.limits.readBytes, this.limits.readMaxBytes, "readBytes")
		const responseBytes = budget(options.responseBytes, this.limits.responseBytes, this.limits.responseMaxBytes, "responseBytes")
		const elapsedMs = budget(options.elapsedMs, this.limits.elapsedMs, this.limits.searchMaxElapsedMs || this.limits.elapsedMs, "elapsedMs")
		const started = Date.now()
		const generation = this.safeFs.generation
		let stopReason = null
		let entries = 0
		let workBytes = 0
		let bytesSearched = 0
		let unmeasuredFiles = 0
		let workerElapsedMs = 0
		let outputBytes = 0
		let pendingMatchBytes = 0
		let filesScanned = 0
		let filesCompleted = 0
		let excludedNames = 0
		let discardedEvents = 0
		const excludedPaths = new Set()
		let exclusionsTruncated = false
		const results = []
		const exclusions = []
		const exclusionCounts = {}
		const exclude = (reason, file = null, details = {}) => {
			if (file !== null) excludedPaths.add(file)
			exclusionCounts[reason] = (exclusionCounts[reason] || 0) + 1
			const entry = { path: file, reason, ...details }
			const bytes = Buffer.byteLength(JSON.stringify(entry)) + 1
			if (exclusions.length < this.limits.searchExclusions && outputBytes + pendingMatchBytes + bytes <= responseBytes) { exclusions.push(entry); outputBytes += bytes }
			else exclusionsTruncated = true
		}
		const stop = (reason) => { if (!stopReason) stopReason = reason; this.stopWorker?.() }
		this.stopSearch = stop
		const check = () => {
			if (signal?.aborted) { stop("aborted"); throw signal.reason || new DOMException("Search was cancelled.", "AbortError") }
			if (Date.now() - started >= elapsedMs) stop("time-budget")
			return !stopReason
		}
		check()
		const scope = await this.#stat(path)
		if (!scope.isDirectory() && !scope.isFile()) throw new FileError(400, "invalid_path", "Content search requires a regular file or directory; symlinks are not followed.", { ...(scope.isSymbolicLink() ? { reason: "symlink" } : {}) })
		const abort = () => stop("aborted")
		signal?.addEventListener("abort", abort, { once: true })
		const timeout = setTimeout(() => stop("time-budget"), Math.max(1, elapsedMs - (Date.now() - started)))
		timeout.unref?.()
		const scanFile = async (file, listed) => {
			if (!check()) return
			if (!matchesGlob(path && file.startsWith(`${path}/`) ? file.slice(path.length + 1) : file)) return
			let handle
			let workerTimeRecorded = false
			try {
				const listedSize = Number(listed.size)
				if (!Number.isSafeInteger(listedSize) || listedSize < 0) { exclude("unsupported-size", file); return }
				if (listedSize > fileBytes) { exclude("file-bytes", file, { sizeBytes: listedSize, limit: fileBytes }); return }
				await this.#prove(path, scope, generation)
				this.safeFs.policy.assertRead(file)
				handle = await this.safeFs.open(file)
				const before = await handle.stat({ bigint: true })
				const size = Number(before.size)
				if (!before.isFile() || !sameObject(before, listed) || !sameObject(before, await this.#stat(file))) { exclude("source-changed", file); return }
				if (!Number.isSafeInteger(size) || size < 0) { exclude("unsupported-size", file); return }
				if (size > fileBytes) { exclude("file-bytes", file, { sizeBytes: size, limit: fileBytes }); return }
				if (workBytes + size > readBytes) { exclude("read-budget", file); stop("read-budget"); return }
				if (!check()) return
				workBytes += size
				const ref = this.index?.ref ? this.index.ref(file) : { ...(this.index?.state?.identity || {}), path: file }
				const observed = observation(ref, before)
				const matches = []
				let matchBytes = 0
				let measured = false
				filesScanned++
				const run = await this.#worker(handle, { q, regex, caseSensitive, fileBytes, elapsedMs, maxResults: maxResults - results.length }, (event) => {
					if (!check()) return
					if (event.type === "end" || event.type === "summary") {
						if (event.type === "end") {
							const bytes = event.data?.stats?.bytes_searched
							if (!measured && Number.isSafeInteger(bytes) && bytes >= 0) { bytesSearched += bytes; measured = true }
							if (event.data?.binary_offset !== undefined && event.data.binary_offset !== null) exclude("binary", file)
						}
						return
					}
					if (event.type !== "match") return
					const data = event.data
					if (!data || !Number.isSafeInteger(data.line_number) || data.line_number < 1 || typeof data.lines?.text !== "string") { exclude("unsupported-event", file); return }
					const column = data.submatches?.[0]?.start
					const match = { path: file, ref, line: data.line_number, column: Number.isSafeInteger(column) && column >= 0 ? column : null, text: excerpt(data.lines.text, this.limits.searchExcerptBytes), observation: observed }
					const bytes = Buffer.byteLength(JSON.stringify(match)) + 1
					if (outputBytes + matchBytes + bytes > responseBytes) { stop("response-budget"); return }
					matches.push(match)
					matchBytes += bytes
					pendingMatchBytes += bytes
					if (results.length + matches.length >= maxResults) stop("result-limit")
				}, () => { discardedEvents++; exclude("event-bytes", file, { limit: this.limits.searchEventBytes }) }, () => Boolean(stopReason))
				workerElapsedMs += run.elapsedMs
				workerTimeRecorded = true
				if (!measured) unmeasuredFiles++
				if (signal?.aborted) check()
				if ((run.signal || (run.code !== 0 && run.code !== 1)) && !run.terminated) {
					const invalidRegex = regex && /regex parse error|regex syntax error|error parsing regex/i.test(run.stderr)
					throw new FileError(invalidRegex ? 400 : 503, invalidRegex ? "invalid_query" : "search_unavailable", `Limited ripgrep worker: ${run.stderr || `exited (${run.signal || run.code})`}`, { tool: "file-search.rg", worker: { exitCode: run.code, signal: run.signal, elapsedMs: run.elapsedMs }, limits: run.limits, action: invalidRegex ? "Correct the regular expression and retry." : "Inspect the worker and configured address-space/data/CPU budgets; raise searchWorkerBytes or narrow the query, then retry the same scope." })
				}
				await this.#prove(path, scope, generation)
				const after = await handle.stat({ bigint: true })
				const current = await this.#stat(file)
				if (!sameObject(before, current) || observationToken(before) !== observationToken(after) || observationToken(after) !== observationToken(current) || Number(after.size) > fileBytes) { pendingMatchBytes = 0; exclude("source-changed", file); return }
				if (!stopReason && (run.code === 0 || run.code === 1)) filesCompleted++
				results.push(...matches)
				outputBytes += matchBytes
			} catch (error) {
				if (signal?.aborted || error.name === "AbortError") throw error
				const failure = fileError(error, "file-search.file")
				if (!workerTimeRecorded && failure.worker) workerElapsedMs += failure.worker.elapsedMs
				if (scope.isFile() || ["source_changed", "search_unavailable", "invalid_query"].includes(failure.error)) throw failure
				exclude(failure.error, file, { error: failure.toJSON() })
			} finally { pendingMatchBytes = 0; if (handle) await handle.close() }
		}
		try {
			if (scope.isFile()) await scanFile(path, scope)
			else {
				const directories = [path]
				while (directories.length && check()) {
					const directory = directories.pop()
					try {
						const before = await this.#stat(directory)
						for await (const entry of this.safeFs.entries(directory)) {
							if (!check()) break
							if (++entries > this.limits.searchEntries) { stop("entry-budget"); break }
							if (entry.name === null) { excludedNames++; exclude("invalid-name", null, { diagnostic: String(entry.diagnostic || "Unaddressable filename").slice(0, 256) }); continue }
							let file
							try {
								if (typeof entry.name !== "string" || entry.name.includes("/")) throw new FileError(400, "invalid_path", "Invalid directory entry.")
								file = canonicalPath(directory ? `${directory}/${entry.name}` : entry.name, { root: false })
							} catch { excludedNames++; exclude("invalid-name", null, { diagnostic: JSON.stringify(entry.name).slice(0, 256) }); continue }
							if (!this.safeFs.policy.visible(file)) { exclude("policy"); continue }
							let stat
							try { stat = await this.#stat(file, true) } catch (error) { exclude(error.error, file, { error: error.toJSON() }); continue }
							if (stat.isSymbolicLink()) { exclude("symlink", file); continue }
							if (stat.isDirectory()) directories.push(file)
							else if (stat.isFile()) await scanFile(file, stat)
							else exclude("unsupported-type", file)
							if (entries % 64 === 0) await yieldTurn()
						}
						if (!sameObject(before, await this.#stat(directory))) throw new FileError(409, "source_changed", "A search directory changed addresses during traversal.")
					} catch (error) {
						if (directory === path || ["source_changed", "search_unavailable", "invalid_query"].includes(error.error) || signal?.aborted) throw error
						const failure = fileError(error, "file-search.entries")
						exclude(failure.error, directory, { error: failure.toJSON() })
					}
				}
			}
			if (signal?.aborted) check()
			await this.#prove(path, scope, generation)
			const complete = !stopReason && Object.keys(exclusionCounts).length === 0 && discardedEvents === 0
			return {
				filesContractVersion: FILES_CONTRACT_VERSION, path, q, results, consistency: "local-live", nextCursor: null,
				coverage: { state: complete ? "complete" : "partial", filesScanned, filesCompleted, excludedFiles: excludedPaths.size, excludedNames, entriesObserved: entries },
				exclusions, exclusionCounts, exclusionsTruncated, stopReason: stopReason || (complete ? "complete" : "exclusions"), truncated: !complete,
				bytesSearched: unmeasuredFiles ? null : bytesSearched, workBytes, outputBytes, discardedEvents, elapsedMs: Date.now() - started,
				metrics: { workBytes, outputBytes, discardedEvents, filesScanned, filesCompleted, elapsedMs: Date.now() - started, workerElapsedMs, workersMemoryLimited: true },
				byteMetrics: { admittedBytes: workBytes, measuredBytesSearched: bytesSearched, unmeasuredFiles },
				limits: { maxResults, fileBytes, readBytes, responseBytes, elapsedMs, eventBytes: this.limits.searchEventBytes, excerptBytes: this.limits.searchExcerptBytes, ...this.#workerLimits(elapsedMs) },
			}
		} catch (error) {
			if (signal?.aborted || error.name === "AbortError") throw error
			const failure = fileError(error, "file-search.scan")
			failure.metrics = { workBytes, outputBytes, discardedEvents, filesScanned, filesCompleted, elapsedMs: Date.now() - started, workerElapsedMs, workersMemoryLimited: true }
			failure.coverage = { state: "partial", filesScanned, filesCompleted, excludedFiles: excludedPaths.size, excludedNames, entriesObserved: entries }
			throw failure
		} finally { clearTimeout(timeout); signal?.removeEventListener("abort", abort) }
	}

	#worker(handle, options, onEvent, onOversize, stopped) {
		if (process.platform !== "linux") return Promise.reject(new FileError(503, "search_unavailable", "Search worker limits require Linux prlimit.", { tool: "file-search.limits", action: "Run the file service on Linux with util-linux prlimit installed." }))
		const limits = this.#workerLimits(options.elapsedMs)
		const args = ["--no-config", "--json", "--no-mmap", "--max-filesize", String(options.fileBytes), "--max-count", String(options.maxResults + 1)]
		if (!options.regex) args.push("--fixed-strings")
		if (!options.caseSensitive) args.push("--ignore-case")
		args.push("--", options.q, "/proc/self/fd/3")
		return new Promise((resolve, reject) => {
			const line = Buffer.alloc(this.limits.searchEventBytes)
			const started = performance.now()
			// prlimit sets both soft/hard kernel limits before exec and preserves inherited fd3.
			// Neither launcher nor rg receives a mutable workspace pathname or a shell command.
			const child = spawn(this.limitBin, [`--as=${limits.addressSpaceBytes}:${limits.addressSpaceBytes}`, `--data=${limits.dataBytes}:${limits.dataBytes}`, `--cpu=${limits.cpuSeconds}:${limits.cpuSeconds}`, "--core=0:0", "--", this.rgBin, ...args], { cwd: "/", stdio: ["ignore", "pipe", "pipe", handle.fd] })
			let length = 0
			let dropping = false
			let stderr = ""
			let killed = false
			let exited = false
			let killTimer
			let failure
			const stop = () => {
				if (killed || exited) return
				killed = child.kill("SIGTERM")
				if (!killed) return
				killTimer = setTimeout(() => child.kill("SIGKILL"), 250)
				killTimer.unref?.()
			}
			this.stopWorker = stop
			const finishLine = () => {
				if (dropping) onOversize()
				else if (length && !stopped()) {
					try { onEvent(JSON.parse(line.subarray(0, length).toString("utf8"))) }
					catch (error) { failure = error instanceof FileError || error.name === "AbortError" ? error : new FileError(503, "search_unavailable", "ripgrep emitted invalid JSON.", { tool: "file-search.rg", action: "Inspect the bounded worker output and retry." }); stop() }
				}
				length = 0
				dropping = false
			}
			child.stdout.on("data", (chunk) => {
				if (failure || stopped()) return
				let offset = 0
				while (offset < chunk.length && !failure && !stopped()) {
					const newline = chunk.indexOf(10, offset)
					const end = newline < 0 ? chunk.length : newline
					const bytes = end - offset
					if (!dropping) {
						if (length + bytes > line.length) { dropping = true; length = 0 }
						else { chunk.copy(line, length, offset, end); length += bytes }
					}
					offset = end + 1
					if (newline >= 0) finishLine()
				}
			})
			child.stderr.on("data", (chunk) => { if (Buffer.byteLength(stderr) < this.limits.searchEventBytes) stderr += chunk.subarray(0, Math.max(0, this.limits.searchEventBytes - Buffer.byteLength(stderr))).toString("utf8") })
			child.once("error", (error) => { failure = new FileError(503, "search_unavailable", `Cannot start the mandatory prlimit launcher: ${error.message}`, { tool: "file-search.limits", action: "Install Debian util-linux (prlimit), or configure a trusted absolute limitBin, then retry. Search never falls back to an unlimited worker." }) })
			child.once("exit", () => { exited = true })
			child.once("close", (code, signal) => {
				clearTimeout(killTimer)
				this.stopWorker = null
				const elapsedMs = performance.now() - started
				const prefix = basename(this.limitBin).replace(/[.*+?^${}()|[\]\\]/g, "\\$&")
				const launcherFailure = code !== 0 && new RegExp(`^(?:prlimit|${prefix}):`, "m").test(stderr)
				if (launcherFailure) failure = new FileError(503, "search_unavailable", `Search resource-limit launcher failed: ${stderr}`, { tool: "file-search.limits", action: "Verify util-linux prlimit and the trusted worker executable; ensure the requested kernel limits are permitted before retrying. No unlimited fallback is used." })
				if (failure?.tool === "file-search.limits") this.limitProof = { state: "unavailable", available: false, checkedAt: new Date().toISOString(), error: failure.toJSON() }
				else if (!killed) this.limitProof = { state: "available", available: true, checkedAt: new Date().toISOString(), mechanism: "trusted-prlimit-exec", ...limits, workerElapsedMs: elapsedMs }
				if (!failure && !stopped() && (length || dropping)) finishLine()
				if (failure) { failure.worker = { exitCode: code, signal, elapsedMs }; failure.limits = limits; reject(failure) }
				else resolve({ code, signal, stderr, limits, elapsedMs, terminated: killed && ["SIGTERM", "SIGKILL"].includes(signal) })
			})
			if (stopped()) stop()
		})
	}

	async close() { this.closed = true; this.stopSearch?.("aborted"); await this.running }
}
