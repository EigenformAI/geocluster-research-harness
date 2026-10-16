/**
 * What is running here (API-01): lets a client tie a trace to exact code and notice that the
 * runtime behind an unchanged URL was replaced or restarted.
 *
 *   bootId          random per gateway start: a new value = in-memory state is gone (reconnect,
 *                   re-attach, re-list watched folders)
 *   gitSha          RUNTIME_BUILD_SHA, baked in at image build (Dockerfile ARG; "-dirty" suffix when
 *                   built from a modified tree). null when not built as an image.
 *   gatewayDigest   sha256 (12 hex) of the gateway's own sources, whatever the tree state
 *   engineDigest    sha256 (12 hex) of the opencode binary; hashed after listen (~200 MB, about a
 *                   second), null until done
 *   engineConfigDigest  sha256 (12 hex) of the engine's config dir (opencode.json, prompts, plugins):
 *                   the agents' behaviour can change without a new binary
 */
import crypto from "node:crypto"
import { createReadStream } from "node:fs"
import fs from "node:fs/promises"
import path from "node:path"
import { fileURLToPath } from "node:url"

export const BOOT_ID = crypto.randomUUID()
const STARTED_AT = new Date().toISOString()
const RUNTIME_DIR = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..")

/** Behaviour a client may check before relying on it (agentCapabilities._meta.features; SessionBroker.capabilities()). */
export const FEATURES = [
	"replaySnapshot",
	// api 3
	"childUpdates",
	"submissionIds",
	"archive",
	"replayOrdering",
]

function short(hash) {
	return hash.digest("hex").slice(0, 12)
}

async function hashFile(file, hash) {
	await new Promise((resolve, reject) => {
		createReadStream(file)
			.on("data", (chunk) => hash.update(chunk))
			.on("end", resolve)
			.on("error", reject)
	})
}

/** Every regular file under dir (relative, sorted), skipping node_modules. */
async function listFiles(dir, rel = "") {
	const out = []
	for (const entry of (await fs.readdir(path.join(dir, rel), { withFileTypes: true })).sort((a, b) => a.name.localeCompare(b.name))) {
		const child = rel ? `${rel}/${entry.name}` : entry.name
		if (entry.isDirectory()) {
			if (entry.name !== "node_modules") out.push(...(await listFiles(dir, child)))
		} else if (entry.isFile()) out.push(child)
	}
	return out
}

export class BuildInfo {
	constructor(config) {
		this.config = config
		this.gatewayDigest = null
		this.engineDigest = null
		this.engineConfigDigest = null
	}

	/** Never throws: an unreadable file leaves its digest null. */
	async compute() {
		try {
			const lib = (await fs.readdir(path.join(RUNTIME_DIR, "lib"))).filter((name) => name.endsWith(".js")).sort()
			const hash = crypto.createHash("sha256")
			for (const rel of ["server.js", "gate.cjs", ...lib.map((name) => `lib/${name}`)]) {
				hash.update(`${rel}\0`)
				await hashFile(path.join(RUNTIME_DIR, rel), hash)
			}
			this.gatewayDigest = short(hash)
		} catch {
			this.gatewayDigest = null
		}
		try {
			const hash = crypto.createHash("sha256")
			await hashFile(await fs.realpath(this.config.opencodeBin), hash)
			this.engineDigest = short(hash)
		} catch {
			this.engineDigest = null
		}
		try {
			const hash = crypto.createHash("sha256")
			for (const rel of await listFiles(this.config.engineConfigDir)) {
				hash.update(`${rel}\0`)
				await hashFile(path.join(this.config.engineConfigDir, rel), hash)
			}
			this.engineConfigDigest = short(hash)
		} catch {
			this.engineConfigDigest = null
		}
		return this
	}

	toJSON() {
		return {
			bootId: BOOT_ID,
			startedAt: STARTED_AT,
			gitSha: this.config.buildSha || null,
			gatewayDigest: this.gatewayDigest,
			engine: "opencode",
			engineDigest: this.engineDigest,
			engineConfigDigest: this.engineConfigDigest,
		}
	}
}
