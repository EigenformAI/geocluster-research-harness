/**
 * geocluster-share: turn a Markdown brief in this conversation's run folder into PDF, Word and PowerPoint files beside
 * it, for a reader who will email or present them. The geoviz specialist runs it from its shell (prompt-src/geoviz).
 *
 *   geocluster-share <brief.md> [--title TEXT]
 *
 * Run it from the workspace root, which is the tool shell's working directory. GEOCLUSTER_RUN_DIR (run-dir.js) names
 * this conversation's run folder, and the brief and every image it references must resolve inside it. Shell writes
 * bypass the file-permission layer, so this check catches a wrong path from the model. It is not a security boundary:
 * the same shell can run pandoc directly (DESIGN_INVARIANTS "Security limits").
 *
 * Prints one JSON object. Exit 0: every format was written. Exit 1: refused, or at least one format failed (the
 * formats that succeeded are kept and listed). Exit 2: usage error.
 */
import fs from "node:fs/promises"
import path from "node:path"
import { fileURLToPath } from "node:url"
import { html2pdfTemps, pandocEnv, removeNewHtml2pdf, runPandoc, stderrTail } from "./lib/pandoc.js"

const RUN_DIR = /^runs\/[A-Za-z0-9_-]+$/
/** `_2` … `_99` after the plain name, as in report-export.js. */
const MAX_SUFFIX = 99
const TIMEOUT_MS = 120_000
const CSS = fileURLToPath(new URL("./share-export.css", import.meta.url))
/** Written in this order; a failed format never stops the next one. */
const FORMATS = ["pdf", "docx", "pptx"]
/** `![alt](target "title")`, with optional angle brackets around the target. */
const MARKDOWN_IMAGE = /!\[[^\]]*\]\(\s*<?([^)\s>]+)>?(?:\s+"[^"]*")?\s*\)/g
const HTML_IMAGE = /<img\b[^>]*\bsrc\s*=\s*["']([^"']+)["']/gi
const URL_SCHEME = /^[A-Za-z][A-Za-z0-9+.-]*:/

export class ShareError extends Error {
	constructor(error, cause, action) {
		super(cause)
		this.error = error
		this.action = action
	}
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

/** `YYYY-MM-DD` in UTC. */
export function shareDate(now) {
	return now.toISOString().slice(0, 10)
}

/** Lower-case ASCII words joined by `-`, at most 60 characters; "brief" when nothing is left. */
export function slugify(text) {
	const slug = String(text ?? "")
		.normalize("NFKD")
		.replace(/[̀-ͯ]/g, "")
		.toLowerCase()
		.replace(/[^a-z0-9]+/g, "-")
		.replace(/^-+|-+$/g, "")
		.slice(0, 60)
		.replace(/-+$/, "")
	return slug || "brief"
}

/** The `title:` of a leading YAML metadata block, else the first level-1 heading, else null. */
export function briefTitle(markdown) {
	const front = markdown.match(/^---\r?\n([\s\S]*?)\r?\n(?:---|\.\.\.)\r?\n/)
	const yamlTitle = front?.[1].match(/^title:\s*(.+?)\s*$/m)?.[1]
	if (yamlTitle) return yamlTitle.replace(/^(['"])(.*)\1$/, "$2")
	return markdown.match(/^#\s+(.+?)\s*#*\s*$/m)?.[1] ?? null
}

/** Every image target in the brief: Markdown images and raw `<img src>`. */
export function imageTargets(markdown) {
	return [...markdown.matchAll(MARKDOWN_IMAGE), ...markdown.matchAll(HTML_IMAGE)].map((m) => m[1])
}

/** The real run folder: `<cwd>/<runDir>`, which must exist and must not be reached through a symlink. */
async function runFolder(cwd, runDir) {
	if (typeof runDir !== "string" || !RUN_DIR.test(runDir)) {
		throw new ShareError(
			"run_dir_unknown",
			`GEOCLUSTER_RUN_DIR is ${runDir === undefined ? "unset" : `"${String(runDir).slice(0, 80)}"`}, not runs/<id>`,
			"Run geocluster-share from a specialist's shell tool, with the workspace root as the working directory.",
		)
	}
	const lexical = path.resolve(cwd, runDir)
	const real = await fs.realpath(lexical).catch(() => null)
	if (real !== lexical || !(await fs.stat(real)).isDirectory()) {
		throw new ShareError(
			"run_dir_unknown",
			`${runDir} does not exist under ${cwd}, or is reached through a symlink`,
			"Run geocluster-share with the workspace root as the working directory; do not cd elsewhere first.",
		)
	}
	return real
}

/** Refuse image targets that are URLs, absolute, missing, or outside the run folder. Pandoc would fetch, embed or drop them silently. */
async function checkImages(markdown, briefDir, runRoot) {
	for (const target of imageTargets(markdown)) {
		const shown = target.slice(0, 120)
		if (URL_SCHEME.test(target) || path.isAbsolute(target)) {
			throw new ShareError(
				"image_refused",
				`image "${shown}" is a URL or an absolute path`,
				"Reference figures by a path relative to the brief, for example figures/<name>.png.",
			)
		}
		let decoded = target
		try {
			decoded = decodeURI(target)
		} catch {
			// a stray % stays literal, as pandoc reads it
		}
		const lexical = path.resolve(briefDir, decoded)
		const real = await fs.realpath(lexical).catch(() => null)
		if (!real) {
			throw new ShareError("image_missing", `image "${shown}" does not exist`, "Save the figure first, or fix its path in the brief.")
		}
		if (!isInside(runRoot, lexical) || !isInside(runRoot, real)) {
			throw new ShareError(
				"image_refused",
				`image "${shown}" resolves outside this conversation's run folder`,
				"Save or re-render the figure under <run>/results/share/figures/ and reference it there.",
			)
		}
	}
}

/** The first `<date>_<slug>[_N]` whose three outputs are all free. */
async function outputBase(dir, stem) {
	for (let n = 1; n <= MAX_SUFFIX; n++) {
		const base = path.join(dir, n === 1 ? stem : `${stem}_${n}`)
		const taken = await Promise.all(FORMATS.map((f) => exists(`${base}.${f}`)))
		if (!taken.some(Boolean)) return base
	}
	throw new ShareError("name_exhausted", `no free output name for ${stem} after ${MAX_SUFFIX} tries`, "Remove older outputs or pass a different --title.")
}

/**
 * Convert the brief. Throws ShareError when the request is refused; otherwise reports each format.
 *
 * @param {object} options
 * @param {string} options.brief Path to the brief, relative to `cwd` or absolute.
 * @param {string} [options.title] Overrides the brief's own title (metadata, slide 1, and file name).
 * @param {string} options.cwd The workspace root.
 * @param {string|undefined} options.runDir GEOCLUSTER_RUN_DIR.
 * @param {string} [options.pandocBin="pandoc"]
 * @param {Date} [options.now]
 * @param {number} [options.timeoutMs]
 * @param {object} [options.env] The env pandoc derives from (pandocEnv filters it).
 * @returns {Promise<{written: Record<string, string>, failed: Record<string, string>}>} Paths are relative to `cwd`.
 */
export async function shareBrief({ brief, title, cwd, runDir, pandocBin = "pandoc", now = new Date(), timeoutMs = TIMEOUT_MS, env = process.env }) {
	const root = await fs.realpath(cwd)
	const runRoot = await runFolder(root, runDir)
	if (typeof brief !== "string" || !brief.endsWith(".md")) {
		throw new ShareError("brief_refused", "the brief must be a .md file", "Write the brief as Markdown, for example <run>/results/share/brief.md.")
	}
	const lexical = path.resolve(root, brief)
	const real = await fs.realpath(lexical).catch(() => null)
	if (!real) throw new ShareError("brief_missing", `${brief} does not exist`, "Write the brief first, then run geocluster-share on it.")
	const orchestrator = path.join(runRoot, "_orchestrator")
	if (!isInside(runRoot, lexical) || !isInside(runRoot, real) || isInside(orchestrator, real)) {
		throw new ShareError(
			"brief_refused",
			`${brief} is outside this conversation's run folder (${runDir})`,
			"Write the brief under <run>/results/share/ and pass that path.",
		)
	}
	const markdown = await fs.readFile(real, "utf8")
	const dir = path.dirname(real)
	await checkImages(markdown, dir, runRoot)

	const display = title || briefTitle(markdown) || path.basename(real, ".md")
	const base = await outputBase(dir, `${shareDate(now)}_${slugify(display)}`)
	const common = [real, "--from=markdown", `--resource-path=${dir}${path.delimiter}${runRoot}`, `--metadata=pagetitle:${display}`]
	if (title) common.push(`--metadata=title:${title}`)
	const extra = { pdf: ["--pdf-engine=weasyprint", `--css=${CSS}`], docx: [], pptx: [] }
	const written = {}
	const failed = {}
	for (const format of FORMATS) {
		const out = `${base}.${format}`
		const before = format === "pdf" ? await html2pdfTemps(dir) : null
		const result = await runPandoc({ bin: pandocBin, args: [...common, "-o", out, ...extra[format]], cwd: dir, env: pandocEnv(env), timeoutMs })
		if (!result.error) {
			written[format] = path.relative(root, out)
			continue
		}
		await fs.rm(out, { force: true }).catch(() => {})
		if (result.killedBy && before) await removeNewHtml2pdf(dir, before)
		const detail = result.timedOut
			? `timed out after ${Math.round(timeoutMs / 1000)} s`
			: stderrTail(result.stderr).trim().split("\n").slice(-3).join(" ") || String(result.error.message ?? result.error).split("\n")[0]
		failed[format] = detail.slice(0, 500)
	}
	return { written, failed }
}

function parseArgs(argv) {
	let brief
	let title
	for (let i = 0; i < argv.length; i++) {
		const arg = argv[i]
		if (arg === "--title") {
			title = argv[++i]
			if (!title) throw new ShareError("usage", "--title needs a value", "Run geocluster-share <brief.md> [--title TEXT].")
		} else if (arg.startsWith("--title=")) {
			title = arg.slice("--title=".length)
		} else if (arg === "--help" || arg === "-h") {
			return { help: true }
		} else if (arg.startsWith("-") || brief !== undefined) {
			throw new ShareError("usage", `unexpected argument "${arg.slice(0, 80)}"`, "Run geocluster-share <brief.md> [--title TEXT].")
		} else {
			brief = arg
		}
	}
	if (brief === undefined) throw new ShareError("usage", "no brief given", "Run geocluster-share <brief.md> [--title TEXT].")
	return { brief, title }
}

/** X-6: every failure names the agent, the tool, the cause and the next step. */
const failure = (error, cause, action, extra = {}) => ({ ok: false, agent: "geoviz", tool: "geocluster-share", error, cause, action, ...extra })

export async function main(argv = process.argv.slice(2), { cwd = process.cwd(), env = process.env, stdout = process.stdout } = {}) {
	let code
	let report
	try {
		const args = parseArgs(argv)
		if (args.help) {
			stdout.write("usage: geocluster-share <brief.md> [--title TEXT]\n")
			return 0
		}
		const { written, failed } = await shareBrief({ ...args, cwd, runDir: env.GEOCLUSTER_RUN_DIR, env })
		if (Object.keys(failed).length === 0) {
			code = 0
			report = { ok: true, ...written }
		} else {
			code = 1
			report = failure("format_failed", `pandoc could not write ${Object.keys(failed).join(", ")}`, "Fix the brief (see failed) and run geocluster-share again; outputs listed in written are kept.", { written, failed })
		}
	} catch (error) {
		if (error instanceof ShareError) {
			code = error.error === "usage" ? 2 : 1
			report = failure(error.error, error.message, error.action)
		} else {
			code = 1
			report = failure("share_failed", String(error.message ?? error).slice(0, 300), "Check the brief path and the run folder, then run geocluster-share again.")
		}
	}
	stdout.write(`${JSON.stringify(report)}\n`)
	return code
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
	process.exitCode = await main()
}
