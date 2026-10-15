#!/usr/bin/env node
/** Source-build step only. Deployed profile assembly consumes these bundled public contracts. */
import fs from "node:fs"
import path from "node:path"
import { fileURLToPath } from "node:url"

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..")

export function syncConfigContracts({ check = false } = {}) {
	const version = JSON.parse(fs.readFileSync(path.join(ROOT, "engine", "source-build.json"), "utf8")).version
	const files = {
		"voxel-contract.js": "// GENERATED from runtime/lib/voxel-agent-contract.js; run npm run build.\n" + fs.readFileSync(path.join(ROOT, "..", "runtime", "lib", "voxel-agent-contract.js"), "utf8"),
		"engine-identity.js": "// GENERATED from engine/source-build.json; run npm run build.\n" + `export const OPENCODE_VERSION = ${JSON.stringify(version)}\n`,
	}
	for (const [name, text] of Object.entries(files)) {
		const file = path.join(ROOT, "config", "lib", name)
		if (fs.existsSync(file) && fs.readFileSync(file, "utf8") === text) continue
		if (check) throw new Error(`stale: config/lib/${name} (run npm --prefix opencode run build)`)
		fs.mkdirSync(path.dirname(file), { recursive: true })
		fs.writeFileSync(file, text)
	}
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) syncConfigContracts({ check: process.argv.includes("--check") })
