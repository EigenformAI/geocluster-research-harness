/**
 * Report export: the root agent's final answer saved as `<run>/_reports/REPORT_<ts>.md`, then converted to `.docx` and
 * `.pdf` with pandoc (fork parity: AttemptCompletionHandler.saveCompletionReport; s43/fork-ports/SPEC.md §6, §8).
 *
 * Why the gateway does it: the fork wrote the report when the top-level agent's `attempt_completion` was accepted, and
 * never when the citation guard rejected it. v2 has no completion tool and no veto hook, so only the broker knows the
 * answer as it stands after RE-4's correction. The broker writes the `.md` BEFORE `turn_end` (its path goes in
 * `turn_end._meta.report`) and starts the conversions after it, in the background, as the fork's turn also ended first.
 *
 * Differences from the fork, each for a reason:
 *  - the `.md` is opened with `wx` and a same-second name gets `_2`, `_3`…: the fork's `writeFile` overwrote, and
 *    concurrent conversations now share one engine. A base name is only taken when its `.docx`/`.pdf` don't exist
 *    either, so a conversion never overwrites (or, on failure, deletes) a file it didn't create;
 *  - the timestamp is UTC explicitly (the fork used process local time, which is UTC in the image);
 *  - pandoc runs through `execFile` (no shell, no quoting), with a minimal env (no gateway secrets), at most
 *    `timeoutMs` each, and ONE report at a time in the whole process (the queue below): a WeasyPrint render peaked at
 *    ~94 MB, and parallel chats finishing together must not stack them;
 *  - the timeout kills pandoc's whole process tree. execFile's own `timeout` would SIGKILL pandoc only and orphan the
 *    `weasyprint` child it waits on, which is exactly the process that hangs. A timed-out or failed conversion leaves no
 *    partial output, and a timed-out PDF leaves no `html2pdf*.html` temp file in the reports folder.
 * Kept: the commands (`pandoc <md> -o <docx>`, `pandoc <md> -o <pdf> --pdf-engine=weasyprint`), cwd = the reports
 * folder (pandoc writes its html2pdf temp file into the cwd), both formats of one report in parallel, the content
 * verbatim, and failures that are logged and never fatal. The PDF glyph and relative-image defects (D5) wait for 5.4.
 */
import { execFile } from "node:child_process"
import fs from "node:fs/promises"
import path from "node:path"
import { createLogger } from "./log.js"
import { descendants, stillRunning } from "./proc-tree.js"

/** The only run folders reports go to: `runs/<sessionId>` (X-7). */
const RUN_DIR = /^runs\/[A-Za-z0-9_-]+$/
const REPORTS_SUBDIR = "_reports"
/** `_2` … `_99` after the plain name; a hundred reports of one conversation in one second means something is wrong. */
const MAX_SUFFIX = 99
const STDERR_TAIL = 2048
const MAX_BUFFER = 4 * 1024 * 1024
/** pandoc's HTML -> PDF temp file, left in the cwd when pandoc is killed. */
const HTML2PDF_TEMP = /^html2pdf.*\.html$/
/** The env pandoc and weasyprint get: enough to find binaries, fonts and caches, nothing secret. */
const ENV_KEYS = [
	"PATH",
	"HOME",
	"LANG",
	"LC_ALL",
	"LC_CTYPE",
	"TZ",
	"TMPDIR",
	"XDG_CACHE_HOME",
	"XDG_CONFIG_HOME",
	"XDG_DATA_HOME",
	"FONTCONFIG_FILE",
	"FONTCONFIG_PATH",
	"LD_LIBRARY_PATH",
	"PYTHONPATH",
	"PYTHONHOME",
]

/**
 * The tail of the conversion queue, shared by every exporter in this process: one report's conversions at a time.
 * Each job resolves (never rejects), so one failure never blocks the next.
 */
let queueTail = Promise.resolve()

const pad = (n) => String(n).padStart(2, "0")
/** `YYYYMMDD_HHmmss` in UTC. */
export function reportTimestamp(now) {
	return (
		`${now.getUTCFullYear()}${pad(now.getUTCMonth() + 1)}${pad(now.getUTCDate())}_` +
		`${pad(now.getUTCHours())}${pad(now.getUTCMinutes())}${pad(now.getUTCSeconds())}`
	)
}

const isInside = (root, p) => p === root || p.startsWith(root + path.sep)
const exists = (p) =>
	fs.lstat(p).then(
		() => true,
		(error) => {
			if (error.code === "ENOENT") return false
			throw error
		},
	)
const tail = (s) => {
	const text = String(s ?? "")
	return text.length > STDERR_TAIL ? text.slice(-STDERR_TAIL) : text
}

class RefusedError extends Error {}

export class ReportExporter {
	/** close() was called: convert() refuses new work */
	#closed = false
	/** close() hit its cap: queued conversions of this exporter are skipped */
	#aborted = false
	/** conversion jobs of this exporter that haven't finished (queued or running) */
	#jobs = new Set()
	/** pandoc processes of this exporter that are running: child -> {kill()} */
	#running = new Map()

	/**
	 * @param {object} options
	 * @param {string} options.workspaceDir The workspace root (config.workspaceDir).
	 * @param {string} [options.pandocBin="pandoc"] config.pandocBin.
	 * @param {boolean} [options.enabled=true] config.reportExport; false makes every call a no-op.
	 * @param {number} [options.timeoutMs=60000] Per conversion (config.reportTimeoutMs).
	 * @param {object} [options.logger] {info, warn, error}.
	 */
	constructor({ workspaceDir, pandocBin = "pandoc", enabled = true, timeoutMs = 60000, logger } = {}) {
		if (typeof workspaceDir !== "string" || !path.isAbsolute(workspaceDir)) {
			throw new TypeError("ReportExporter: workspaceDir must be an absolute path")
		}
		this.workspaceDir = workspaceDir
		this.pandocBin = pandocBin
		this.enabled = enabled !== false
		this.timeoutMs = timeoutMs
		this.logger = logger ?? createLogger("report")
		this.env = Object.fromEntries(ENV_KEYS.filter((k) => process.env[k] !== undefined).map((k) => [k, process.env[k]]))
	}

	/**
	 * Write `<workspace>/<runDir>/_reports/REPORT_<YYYYMMDD_HHmmss UTC>[_N].md` holding `text` verbatim (UTF-8).
	 * Never throws: a refusal or failure is logged and gives null.
	 *
	 * @param {string} runDir Workspace-relative `runs/<id>`; anything else, or one that resolves outside the
	 *   workspace through a symlink, is refused.
	 * @param {string} text The final answer (non-empty).
	 * @param {{now?: Date}} [options]
	 * @returns {Promise<{relPath: string, absPath: string} | null>} relPath is workspace-relative (POSIX).
	 */
	async writeMarkdown(runDir, text, { now = new Date() } = {}) {
		if (!this.enabled) return null
		try {
			if (typeof runDir !== "string" || !RUN_DIR.test(runDir)) throw new RefusedError("run dir must be runs/<id>")
			if (typeof text !== "string" || text.length === 0) throw new RefusedError("empty answer")
			const reportsDir = await this.#reportsDir(runDir)
			const stamp = reportTimestamp(now instanceof Date && !Number.isNaN(now.getTime()) ? now : new Date())
			for (let n = 1; n <= MAX_SUFFIX; n++) {
				const base = n === 1 ? `REPORT_${stamp}` : `REPORT_${stamp}_${n}`
				// the conversions will write these: never take a name whose outputs already exist
				if ((await exists(path.join(reportsDir, `${base}.docx`))) || (await exists(path.join(reportsDir, `${base}.pdf`)))) continue
				const file = path.join(reportsDir, `${base}.md`)
				let handle
				try {
					// wx = O_CREAT|O_EXCL: never overwrites, and refuses a planted symlink (EEXIST) instead of following it
					handle = await fs.open(file, "wx")
				} catch (error) {
					if (error.code === "EEXIST") continue
					throw error
				}
				try {
					await handle.writeFile(text, "utf8")
				} catch (error) {
					await handle.close().catch(() => {})
					await fs.rm(file, { force: true }).catch(() => {})
					throw error
				}
				await handle.close()
				const relPath = `${runDir}/${REPORTS_SUBDIR}/${base}.md`
				this.logger.info(`Saved completion report to ${relPath}`, { runDir, bytes: Buffer.byteLength(text, "utf8") })
				return { relPath, absPath: path.join(this.workspaceDir, relPath) }
			}
			throw new Error(`no free report name for ${stamp} after ${MAX_SUFFIX} tries`)
		} catch (error) {
			if (error instanceof RefusedError) {
				this.logger.warn(`Report not saved: ${error.message}`, { runDir: String(runDir).slice(0, 200) })
			} else {
				this.logger.error("Failed to save completion report (non-fatal)", { runDir, error: error.message, code: error.code })
			}
			return null
		}
	}

	/**
	 * Queue the `.docx` and `.pdf` conversions of one report (`<base>.md` -> `<base>.docx`, `<base>.pdf`). Both run in
	 * parallel; reports run one at a time across the process. Never throws, never rejects.
	 *
	 * @param {string} absMdPath The `absPath` writeMarkdown returned.
	 * @returns {Promise<void>} Settles when this report's conversions are done (or skipped).
	 */
	convert(absMdPath) {
		if (!this.enabled) return Promise.resolve()
		if (this.#closed) {
			this.logger.warn("Report conversion skipped: shutting down", { path: absMdPath })
			return Promise.resolve()
		}
		if (typeof absMdPath !== "string" || !path.isAbsolute(absMdPath) || !absMdPath.endsWith(".md")) {
			this.logger.warn("Report conversion skipped: not an absolute .md path", { path: String(absMdPath).slice(0, 200) })
			return Promise.resolve()
		}
		const job = queueTail.then(() => this.#convertNow(absMdPath))
		queueTail = job
		this.#jobs.add(job)
		void job.finally(() => this.#jobs.delete(job))
		return job
	}

	/**
	 * Shutdown: no new conversions; wait for this exporter's queued and running ones, at most `capMs`, then kill what
	 * is still running (removing its partial output) and drop what hasn't started.
	 *
	 * @param {number} [capMs=5000]
	 * @returns {Promise<boolean>} true when everything finished within the cap.
	 */
	async close(capMs = 5000) {
		this.#closed = true
		if (this.#jobs.size === 0) return true
		let timer
		const capped = new Promise((resolve) => {
			timer = setTimeout(() => resolve(false), Math.max(0, capMs))
		})
		const drained = await Promise.race([Promise.allSettled([...this.#jobs]).then(() => true), capped])
		clearTimeout(timer)
		if (drained) return true
		this.#aborted = true
		this.logger.warn("Report conversions still running at shutdown; killing them", { running: this.#running.size, capMs })
		await Promise.all([...this.#running.values()].map((run) => run.kill("shutdown")))
		// the killed jobs settle as soon as pandoc's exit is reaped; queued ones see #aborted and skip
		let grace
		await Promise.race([
			Promise.allSettled([...this.#jobs]),
			new Promise((resolve) => {
				grace = setTimeout(resolve, 2000)
			}),
		])
		clearTimeout(grace)
		return false
	}

	/** `<real workspace>/<runDir>/_reports`, created, after checking every existing part resolves inside the workspace. */
	async #reportsDir(runDir) {
		const realRoot = await fs.realpath(this.workspaceDir)
		const parts = [...runDir.split("/"), REPORTS_SUBDIR]
		let current = realRoot
		for (const part of parts) {
			current = path.join(current, part)
			let stat
			try {
				stat = await fs.lstat(current)
			} catch (error) {
				if (error.code === "ENOENT") break // mkdir creates the rest under a parent checked here
				throw error
			}
			if (stat.isSymbolicLink()) {
				const real = await fs.realpath(current).catch(() => null)
				if (!real || !isInside(realRoot, real)) throw new RefusedError(`${runDir} resolves outside the workspace`)
			}
		}
		const target = path.join(realRoot, ...parts)
		await fs.mkdir(target, { recursive: true })
		// re-check after mkdir: narrows the window for a symlink swapped in between (same uid as the tools, X-1)
		const real = await fs.realpath(target)
		if (!isInside(realRoot, real)) throw new RefusedError(`${runDir} resolves outside the workspace`)
		return real
	}

	async #convertNow(md) {
		if (this.#aborted) {
			this.logger.warn("Report conversion skipped: shutting down", { path: md })
			return
		}
		try {
			const dir = path.dirname(md)
			const base = md.slice(0, -".md".length)
			const before = new Set((await fs.readdir(dir).catch(() => [])).filter((n) => HTML2PDF_TEMP.test(n)))
			await Promise.all([
				this.#run("DOCX", md, `${base}.docx`, [], dir, before),
				this.#run("PDF", md, `${base}.pdf`, ["--pdf-engine=weasyprint"], dir, before),
			])
		} catch (error) {
			// #run never throws; this is a last resort so the queue can't wedge
			this.logger.error("Report conversion failed (non-fatal)", { path: md, error: error.message })
		}
	}

	/** One pandoc run. Resolves when it ended and its leftovers are cleaned; never throws. */
	async #run(format, md, out, extraArgs, cwd, html2pdfBefore) {
		const started = Date.now()
		try {
			if (await exists(out)) {
				this.logger.warn(`Report conversion skipped (non-fatal): ${out} already exists`, { format })
				return
			}
		} catch (error) {
			this.logger.error(`Report conversion failed (non-fatal): ${out}`, { format, error: error.message })
			return
		}
		let timedOut = false
		let killedBy = null
		const result = await new Promise((resolve) => {
			let child
			const kill = async (reason) => {
				if (killedBy) return
				killedBy = reason
				// Snapshot the tree while pandoc is alive: once it dies, weasyprint is re-parented and can't be found.
				// descendants() scans /proc synchronously when called; the await only yields a microtask. Never scan
				// once pandoc has exited: its pid may already belong to an unrelated process.
				const alive = child.exitCode === null && child.signalCode === null
				const tree = alive ? await descendants(child.pid) : []
				try {
					child.kill("SIGKILL")
				} catch {
					// already gone
				}
				for (const p of stillRunning(tree)) {
					try {
						process.kill(p.pid, "SIGKILL")
					} catch {
						// gone meanwhile
					}
				}
				// A process that outlived pandoc while holding our pipes would keep 'close' (and the execFile callback,
				// and with it the process-wide queue) waiting forever: let go of the pipes.
				for (const stream of [child.stdin, child.stdout, child.stderr]) stream?.destroy()
			}
			try {
				child = execFile(
					this.pandocBin,
					[md, "-o", out, ...extraArgs],
					{ cwd, env: this.env, killSignal: "SIGKILL", maxBuffer: MAX_BUFFER, windowsHide: true },
					(error, _stdout, stderr) => resolve({ error, stderr }),
				)
			} catch (error) {
				resolve({ error, stderr: "" })
				return
			}
			if (!child.pid) return // spawn failed (ENOENT…): the callback reports it
			const timer = setTimeout(() => {
				timedOut = true
				void kill("timeout")
			}, this.timeoutMs)
			timer.unref?.()
			this.#running.set(child, { kill })
			child.once("close", () => {
				clearTimeout(timer)
				this.#running.delete(child)
			})
		})
		const ms = Date.now() - started
		if (!result.error) {
			this.logger.info(`Generated ${format}: ${out}`, { ms })
			return
		}
		await fs.rm(out, { force: true }).catch(() => {})
		if (killedBy && format === "PDF") await this.#removeHtml2pdf(cwd, html2pdfBefore)
		const { error } = result
		this.logger.error(`Report conversion failed (non-fatal): ${out}`, {
			format,
			code: error.code ?? null,
			signal: error.signal ?? null,
			timedOut,
			killedBy,
			ms,
			error: killedBy ? undefined : String(error.message ?? error).split("\n")[0].slice(0, 300),
			stderr: tail(result.stderr) || undefined,
		})
	}

	/** Remove the html2pdf temp files that appeared during a killed PDF conversion. */
	async #removeHtml2pdf(dir, before) {
		const names = await fs.readdir(dir).catch(() => [])
		for (const name of names) {
			if (HTML2PDF_TEMP.test(name) && !before.has(name)) await fs.rm(path.join(dir, name), { force: true }).catch(() => {})
		}
	}
}
