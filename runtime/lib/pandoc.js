/**
 * One pandoc run with the guarantees both of its callers need: the gateway's report export (report-export.js) and the
 * agent-facing share helper (share-export.mjs).
 *
 *  - `execFile`, no shell: arguments are never quoted or interpreted;
 *  - a minimal env (ENV_KEYS): enough to find binaries, fonts and caches, nothing secret;
 *  - the timeout kills pandoc's whole process tree. execFile's own `timeout` would SIGKILL pandoc only and orphan the
 *    `weasyprint` child it waits on, which is exactly the process that hangs;
 *  - a process that outlives pandoc while holding its pipes cannot keep the run from settling.
 */
import { execFile } from "node:child_process"
import fs from "node:fs/promises"
import path from "node:path"
import { descendants, stillRunning } from "./proc-tree.js"

const STDERR_TAIL = 2048
const MAX_BUFFER = 4 * 1024 * 1024
/** pandoc's HTML -> PDF temp file, left in the cwd when pandoc is killed. */
export const HTML2PDF_TEMP = /^html2pdf.*\.html$/
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

/** The subset of `source` that pandoc and weasyprint may see. */
export function pandocEnv(source = process.env) {
	return Object.fromEntries(ENV_KEYS.filter((k) => source[k] !== undefined).map((k) => [k, source[k]]))
}

/** The last STDERR_TAIL characters of `s`. */
export function stderrTail(s) {
	const text = String(s ?? "")
	return text.length > STDERR_TAIL ? text.slice(-STDERR_TAIL) : text
}

/** Names of the html2pdf temp files in `dir` now; pass the result to removeNewHtml2pdf after a killed PDF run. */
export async function html2pdfTemps(dir) {
	return new Set((await fs.readdir(dir).catch(() => [])).filter((n) => HTML2PDF_TEMP.test(n)))
}

/** Remove the html2pdf temp files that appeared in `dir` since `before` was taken. */
export async function removeNewHtml2pdf(dir, before) {
	const names = await fs.readdir(dir).catch(() => [])
	for (const name of names) {
		if (HTML2PDF_TEMP.test(name) && !before.has(name)) await fs.rm(path.join(dir, name), { force: true }).catch(() => {})
	}
}

/**
 * Run `bin args…` in `cwd`. Resolves when the process ended (or was killed and its pipes released); never throws.
 *
 * @param {object} options
 * @param {string} [options.bin="pandoc"]
 * @param {string[]} options.args
 * @param {string} options.cwd
 * @param {object} options.env Usually pandocEnv().
 * @param {number} options.timeoutMs
 * @param {(run: {kill: (reason: string) => Promise<void>}) => (() => void) | void} [options.onSpawn] Called once the
 *   process is running; it may return a function that is called when the process closes.
 * @returns {Promise<{error: Error | null, stderr: string, timedOut: boolean, killedBy: string | null, ms: number}>}
 */
export async function runPandoc({ bin = "pandoc", args, cwd, env, timeoutMs, onSpawn }) {
	const started = Date.now()
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
			// A process that outlived pandoc while holding our pipes would keep 'close' (and the execFile callback)
			// waiting forever: let go of the pipes.
			for (const stream of [child.stdin, child.stdout, child.stderr]) stream?.destroy()
		}
		try {
			child = execFile(
				bin,
				args,
				{ cwd, env, killSignal: "SIGKILL", maxBuffer: MAX_BUFFER, windowsHide: true },
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
		}, timeoutMs)
		timer.unref?.()
		const release = onSpawn?.({ kill })
		child.once("close", () => {
			clearTimeout(timer)
			release?.()
		})
	})
	return { error: result.error ?? null, stderr: String(result.stderr ?? ""), timedOut, killedBy, ms: Date.now() - started }
}
