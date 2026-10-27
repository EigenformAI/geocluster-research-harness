/**
 * geocluster-share (share-export.mjs): run-folder containment, image checks, output naming, per-format failure,
 * timeout cleanup and the CLI contract, against a fake pandoc; plus one real-pandoc run when pandoc is on PATH.
 */
import assert from "node:assert/strict"
import { spawn, spawnSync } from "node:child_process"
import fs from "node:fs/promises"
import os from "node:os"
import path from "node:path"
import { describe, it } from "node:test"
import { fileURLToPath } from "node:url"
import { briefTitle, imageTargets, shareBrief, ShareError, slugify } from "../share-export.mjs"

const CLI = fileURLToPath(new URL("../share-export.mjs", import.meta.url))
const NOW = new Date(Date.UTC(2026, 9, 27, 9, 30, 0))
const RUN = "runs/ses_root"
/** A 1x1 PNG. */
const PNG = Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==", "base64")

const isAlive = (pid) => {
	try {
		process.kill(pid, 0)
		return true
	} catch {
		return false
	}
}

/** A workspace with runs/ses_root/results/share/, a sibling run, and an "outside" dir; removed after the test. */
async function sandbox(t) {
	const root = await fs.mkdtemp(path.join(os.tmpdir(), "share-"))
	const workspace = path.join(root, "ws")
	const outside = path.join(root, "outside")
	const share = path.join(workspace, RUN, "results", "share")
	await fs.mkdir(path.join(share, "figures"), { recursive: true })
	await fs.mkdir(path.join(workspace, "runs", "ses_other", "results"), { recursive: true })
	await fs.mkdir(path.join(workspace, RUN, "_orchestrator"), { recursive: true })
	await fs.mkdir(outside)
	const pids = []
	t.after(async () => {
		for (const pid of pids) if (isAlive(pid)) process.kill(pid, "SIGKILL")
		await fs.rm(root, { recursive: true, force: true })
	})
	return { root, workspace, outside, share, pids }
}

/**
 * A fake pandoc: `<md> … -o <out> …`. Appends {fmt, cwd, args, envKeys} to <dir>/calls.ndjson and writes
 * "<fmt>:<md text>" to <out>. Directives in the markdown: `FAIL:<fmt>` (exit 3 with stderr for that format);
 * `HANG:pdf` (writes a partial PDF and an html2pdf temp file, starts a grandchild, never exits).
 */
async function fakePandoc(dir) {
	const bin = path.join(dir, "pandoc")
	const calls = path.join(dir, "calls.ndjson")
	const pidFile = path.join(dir, "grandchild.pid")
	const script = `#!${process.execPath}
"use strict"
const fs = require("node:fs")
const path = require("node:path")
const { spawn } = require("node:child_process")
const args = process.argv.slice(2)
const out = args[args.indexOf("-o") + 1]
const fmt = path.extname(out).slice(1)
const text = fs.readFileSync(args[0], "utf8")
fs.appendFileSync(${JSON.stringify(calls)}, JSON.stringify({ fmt, cwd: process.cwd(), args, envKeys: Object.keys(process.env) }) + "\\n")
if (text.includes("FAIL:" + fmt)) {
	process.stderr.write("pandoc: Could not convert image: boom\\n")
	process.exit(3)
}
if (text.includes("HANG:" + fmt)) {
	fs.writeFileSync(out, "%PDF-1.7 partial")
	fs.writeFileSync(path.join(process.cwd(), "html2pdf4242.html"), "<html></html>")
	const grandchild = spawn(process.execPath, ["-e", "setTimeout(() => {}, 60000)"], { stdio: "ignore" })
	fs.writeFileSync(${JSON.stringify(pidFile)}, String(grandchild.pid))
	setInterval(() => {}, 1000)
	return
}
fs.writeFileSync(out, fmt + ":" + text)
`
	await fs.writeFile(bin, script, { mode: 0o755 })
	const readCalls = async () =>
		(await fs.readFile(calls, "utf8").catch(() => ""))
			.split("\n")
			.filter(Boolean)
			.map((l) => JSON.parse(l))
	return { bin, readCalls, pidFile }
}

const BRIEF = `---
title: Copper anomalies at Wattle Creek
date: 2026-10-27
---

# Summary

Three surface samples exceed 120 ppm Cu.

![Copper in surface samples, ppm](figures/cu.png){width=100%}
`

async function writeBrief(share, text = BRIEF) {
	await fs.writeFile(path.join(share, "figures", "cu.png"), PNG)
	const file = path.join(share, "brief.md")
	await fs.writeFile(file, text)
	return file
}

const refusal = async (promise, error) => {
	await assert.rejects(promise, (e) => e instanceof ShareError && e.error === error && typeof e.action === "string")
}

describe("briefTitle, slugify, imageTargets", () => {
	it("takes the YAML title, else the first level-1 heading", () => {
		assert.equal(briefTitle(BRIEF), "Copper anomalies at Wattle Creek")
		assert.equal(briefTitle("---\ntitle: 'Quoted: yes'\n---\n# Other\n"), "Quoted: yes")
		assert.equal(briefTitle("intro\n\n# Gold in soils\n"), "Gold in soils")
		assert.equal(briefTitle("no heading"), null)
	})
	it("slugs to lower-case ASCII words, at most 60 characters", () => {
		assert.equal(slugify("Copper anomalies — Wattle Creek (µ/ppm)"), "copper-anomalies-wattle-creek-ppm")
		assert.equal(slugify("Ünïcödé"), "unicode")
		assert.equal(slugify("!!!"), "brief")
		assert.ok(slugify("x".repeat(100)).length <= 60)
	})
	it("finds Markdown and raw HTML image targets", () => {
		assert.deepEqual(imageTargets('![a](figures/a.png "t"){width=50%}\n<img alt="b" src="figures/b.svg">\n![c](<figures/c.png>)'), [
			"figures/a.png",
			"figures/c.png",
			"figures/b.svg",
		])
	})
})

describe("shareBrief (fake pandoc)", () => {
	it("writes <date>_<slug>.pdf, .docx and .pptx beside the brief, from its folder, with the run folder as resource path", async (t) => {
		const { root, workspace, share } = await sandbox(t)
		const pandoc = await fakePandoc(root)
		await writeBrief(share)
		const env = { PATH: process.env.PATH, HOME: "/home/x", IDE_LLM_TOKEN: "secret", GEOCLUSTER_RUN_DIR: RUN }
		const result = await shareBrief({ brief: `${RUN}/results/share/brief.md`, cwd: workspace, runDir: RUN, pandocBin: pandoc.bin, now: NOW, env })
		const stem = `${RUN}/results/share/2026-10-27_copper-anomalies-at-wattle-creek`
		assert.deepEqual(result, { written: { pdf: `${stem}.pdf`, docx: `${stem}.docx`, pptx: `${stem}.pptx` }, failed: {} })
		for (const f of ["pdf", "docx", "pptx"]) assert.match(await fs.readFile(path.join(workspace, `${stem}.${f}`), "utf8"), new RegExp(`^${f}:---`))
		const calls = await pandoc.readCalls()
		assert.deepEqual(calls.map((c) => c.fmt), ["pdf", "docx", "pptx"])
		const realShare = await fs.realpath(share)
		const realRun = await fs.realpath(path.join(workspace, RUN))
		for (const call of calls) {
			assert.equal(call.cwd, realShare)
			assert.ok(call.args.includes(`--resource-path=${realShare}${path.delimiter}${realRun}`))
			assert.ok(call.args.includes("--metadata=pagetitle:Copper anomalies at Wattle Creek"))
			assert.ok(!call.args.some((a) => a.startsWith("--metadata=title:")), "the brief's own title is kept")
			assert.ok(!call.envKeys.includes("IDE_LLM_TOKEN") && !call.envKeys.includes("GEOCLUSTER_RUN_DIR"))
		}
		const pdf = calls.find((c) => c.fmt === "pdf").args
		assert.ok(pdf.includes("--pdf-engine=weasyprint"))
		assert.ok(pdf.some((a) => a.startsWith("--css=") && a.endsWith("share-export.css")))
	})

	it("--title replaces the brief's title in the metadata and the file name", async (t) => {
		const { root, workspace, share } = await sandbox(t)
		const pandoc = await fakePandoc(root)
		await writeBrief(share)
		const result = await shareBrief({ brief: `${RUN}/results/share/brief.md`, title: "Cu for the board", cwd: workspace, runDir: RUN, pandocBin: pandoc.bin, now: NOW })
		assert.equal(result.written.docx, `${RUN}/results/share/2026-10-27_cu-for-the-board.docx`)
		assert.ok((await pandoc.readCalls())[0].args.includes("--metadata=title:Cu for the board"))
	})

	it("refuses an unset, malformed, missing or symlinked run folder", async (t) => {
		const { root, workspace, outside, share } = await sandbox(t)
		const pandoc = await fakePandoc(root)
		await writeBrief(share)
		const call = (runDir) => shareBrief({ brief: `${RUN}/results/share/brief.md`, cwd: workspace, runDir, pandocBin: pandoc.bin, now: NOW })
		await refusal(call(undefined), "run_dir_unknown")
		await refusal(call("runs/../outside"), "run_dir_unknown")
		await refusal(call("/tmp/x"), "run_dir_unknown")
		await refusal(call("runs/ses_missing"), "run_dir_unknown")
		await fs.symlink(outside, path.join(workspace, "runs", "ses_link"))
		await refusal(call("runs/ses_link"), "run_dir_unknown")
		// run from a subfolder instead of the workspace root
		await refusal(shareBrief({ brief: "results/share/brief.md", cwd: path.join(workspace, RUN), runDir: RUN, pandocBin: pandoc.bin }), "run_dir_unknown")
		assert.deepEqual(await pandoc.readCalls(), [])
	})

	it("refuses a brief outside the run folder, in another run, in _orchestrator, through an escaping symlink, or not .md", async (t) => {
		const { root, workspace, outside, share } = await sandbox(t)
		const pandoc = await fakePandoc(root)
		await writeBrief(share)
		const call = (brief) => shareBrief({ brief, cwd: workspace, runDir: RUN, pandocBin: pandoc.bin, now: NOW })
		await fs.writeFile(path.join(workspace, "top.md"), "# x\n")
		await fs.writeFile(path.join(workspace, "runs/ses_other/results/b.md"), "# x\n")
		await fs.writeFile(path.join(workspace, RUN, "_orchestrator/b.md"), "# x\n")
		await fs.writeFile(path.join(outside, "b.md"), "# x\n")
		await fs.symlink(path.join(outside, "b.md"), path.join(share, "linked.md"))
		await refusal(call("top.md"), "brief_refused")
		await refusal(call("runs/ses_other/results/b.md"), "brief_refused")
		await refusal(call(`${RUN}/_orchestrator/b.md`), "brief_refused")
		await refusal(call(`${RUN}/results/share/linked.md`), "brief_refused")
		await refusal(call(path.join(outside, "b.md")), "brief_refused")
		await refusal(call(`${RUN}/results/share/missing.md`), "brief_missing")
		await refusal(call(`${RUN}/results/share/brief.txt`), "brief_refused")
		assert.deepEqual(await pandoc.readCalls(), [])
	})

	it("refuses image URLs, absolute paths, missing images and images outside the run folder; accepts ../ inside it", async (t) => {
		const { root, workspace, outside, share } = await sandbox(t)
		const pandoc = await fakePandoc(root)
		await fs.writeFile(path.join(outside, "x.png"), PNG)
		await fs.writeFile(path.join(workspace, RUN, "results", "plot.png"), PNG)
		await fs.symlink(path.join(outside, "x.png"), path.join(share, "figures", "escape.png"))
		const call = async (image) => {
			await fs.writeFile(path.join(share, "brief.md"), `# T\n\n![alt](${image})\n`)
			return shareBrief({ brief: `${RUN}/results/share/brief.md`, cwd: workspace, runDir: RUN, pandocBin: pandoc.bin, now: NOW })
		}
		await refusal(call("https://example.com/x.png"), "image_refused")
		await refusal(call(path.join(outside, "x.png")), "image_refused")
		await refusal(call("figures/none.png"), "image_missing")
		await refusal(call("../../../../../outside/x.png"), "image_refused")
		await refusal(call("figures/escape.png"), "image_refused")
		assert.deepEqual(await pandoc.readCalls(), [])
		const ok = await call("../plot.png")
		assert.deepEqual(Object.keys(ok.written), ["pdf", "docx", "pptx"])
	})

	it("never overwrites: when any output of a name exists, the next free _N is used", async (t) => {
		const { root, workspace, share } = await sandbox(t)
		const pandoc = await fakePandoc(root)
		await writeBrief(share)
		await fs.writeFile(path.join(share, "2026-10-27_copper-anomalies-at-wattle-creek.pptx"), "someone else's")
		const call = () => shareBrief({ brief: `${RUN}/results/share/brief.md`, cwd: workspace, runDir: RUN, pandocBin: pandoc.bin, now: NOW })
		assert.equal((await call()).written.pdf, `${RUN}/results/share/2026-10-27_copper-anomalies-at-wattle-creek_2.pdf`)
		assert.equal((await call()).written.pdf, `${RUN}/results/share/2026-10-27_copper-anomalies-at-wattle-creek_3.pdf`)
		assert.equal(await fs.readFile(path.join(share, "2026-10-27_copper-anomalies-at-wattle-creek.pptx"), "utf8"), "someone else's")
	})

	it("a failed format is reported with pandoc's stderr and leaves no file; the other formats are kept", async (t) => {
		const { root, workspace, share } = await sandbox(t)
		const pandoc = await fakePandoc(root)
		await writeBrief(share, `${BRIEF}\nFAIL:pptx\n`)
		const result = await shareBrief({ brief: `${RUN}/results/share/brief.md`, cwd: workspace, runDir: RUN, pandocBin: pandoc.bin, now: NOW })
		assert.deepEqual(Object.keys(result.written), ["pdf", "docx"])
		assert.match(result.failed.pptx, /Could not convert image: boom/)
		assert.equal(await fs.stat(path.join(share, "2026-10-27_copper-anomalies-at-wattle-creek.pptx")).catch(() => null), null)
	})

	it("timeout: kills pandoc and its children, removes the partial PDF and the html2pdf temp file, then continues", async (t) => {
		const { root, workspace, share, pids } = await sandbox(t)
		const pandoc = await fakePandoc(root)
		await writeBrief(share, `${BRIEF}\nHANG:pdf\n`)
		const result = await shareBrief({ brief: `${RUN}/results/share/brief.md`, cwd: workspace, runDir: RUN, pandocBin: pandoc.bin, now: NOW, timeoutMs: 800 })
		const grandchild = Number(await fs.readFile(pandoc.pidFile, "utf8"))
		pids.push(grandchild)
		assert.match(result.failed.pdf, /timed out/)
		assert.deepEqual(Object.keys(result.written), ["docx", "pptx"])
		const left = await fs.readdir(share)
		assert.ok(!left.some((n) => n.endsWith(".pdf") || n.startsWith("html2pdf")), left.join(", "))
		for (let i = 0; i < 50 && isAlive(grandchild); i++) await new Promise((r) => setTimeout(r, 20))
		assert.equal(isAlive(grandchild), false)
	})
})

describe("geocluster-share CLI", () => {
	const run = (args, { cwd, env }) =>
		new Promise((resolve) => {
			const child = spawn(process.execPath, [CLI, ...args], { cwd, env })
			let stdout = ""
			child.stdout.on("data", (d) => (stdout += d))
			child.on("close", (code) => resolve({ code, lines: stdout.trim().split("\n") }))
		})

	it("prints one JSON object; exit 0 written, 1 refused or failed, 2 usage", async (t) => {
		const { root, workspace, share } = await sandbox(t)
		await fakePandoc(root)
		await writeBrief(share)
		const env = { PATH: `${root}${path.delimiter}${process.env.PATH}`, GEOCLUSTER_RUN_DIR: RUN }
		const ok = await run([`${RUN}/results/share/brief.md`], { cwd: workspace, env })
		assert.equal(ok.code, 0)
		assert.equal(ok.lines.length, 1)
		assert.deepEqual(Object.keys(JSON.parse(ok.lines[0])), ["ok", "pdf", "docx", "pptx"])

		const refused = await run(["top.md"], { cwd: workspace, env })
		const body = JSON.parse(refused.lines[0])
		assert.equal(refused.code, 1)
		assert.equal(body.ok, false)
		for (const key of ["agent", "tool", "error", "cause", "action"]) assert.equal(typeof body[key], "string", key)

		const noRun = await run([`${RUN}/results/share/brief.md`], { cwd: workspace, env: { PATH: env.PATH } })
		assert.equal(noRun.code, 1)
		assert.equal(JSON.parse(noRun.lines[0]).error, "run_dir_unknown")

		assert.equal((await run([], { cwd: workspace, env })).code, 2)
		assert.equal((await run(["a.md", "b.md"], { cwd: workspace, env })).code, 2)
	})
})

const realPandoc = spawnSync("pandoc", ["--version"]).status === 0

describe("real pandoc", () => {
	it("DOCX and PPTX embed the figure", { skip: !realPandoc && "needs pandoc on PATH" }, async (t) => {
		const { workspace, share } = await sandbox(t)
		await writeBrief(share, `${BRIEF}\n# Method and caveats\n\nBelow-detection values (<0.01 ppm) were kept separate.[^1]\n\n[^1]: Source: assays/surface_samples.csv, n = 120.\n`)
		const result = await shareBrief({ brief: `${RUN}/results/share/brief.md`, cwd: workspace, runDir: RUN, now: NOW })
		for (const [format, media] of [
			["docx", "word/media/"],
			["pptx", "ppt/media/"],
		]) {
			assert.ok(result.written[format], `${format}: ${result.failed[format]}`)
			const zip = await fs.readFile(path.join(workspace, result.written[format]))
			assert.ok(zip.includes(media), `${format} has no ${media}`)
		}
	})
})
