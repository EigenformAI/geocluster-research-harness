import fs from "node:fs/promises"
import { constants } from "node:fs"
import path from "node:path"
import { pathToFileURL } from "node:url"
import { spawnSync } from "node:child_process"
import { NATIVE_PATH, nativeEngineEnv } from "./native-engine-env.mjs"

export function nativeProcessingSettings(source) {
	const model = source.RUNTIME_NATIVE_PROCESSING_MODEL
	const descriptorPath = source.RUNTIME_NATIVE_PROCESSING_ENGINE_DESCRIPTOR
	if (descriptorPath && !model) throw new Error("an engine descriptor requires a processing model (--processing-model)")
	if (!model) return undefined
	if (!/^[^/\s\x00-\x1f\x7f#]+\/[^\s\x00-\x1f\x7f#]+(?:#[A-Za-z0-9._-]+)?$/.test(model)) {
		throw new Error("processing model must be provider/model[#variant]; model IDs may contain slashes")
	}
	return { model, ...(descriptorPath ? { descriptorPath } : {}) }
}

async function readDescriptorFile(file) {
	const handle = await fs.open(file, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK)
	try {
		const stat = await handle.stat()
		if (!stat.isFile() || stat.size > 4 * 1024 * 1024) throw new Error("engine descriptor must be a bounded regular JSON file")
		const bytes = Buffer.alloc(4 * 1024 * 1024 + 1)
		let size = 0
		while (size < bytes.length) {
			const result = await handle.read(bytes, size, bytes.length - size, null)
			if (!result.bytesRead) break
			size += result.bytesRead
		}
		if (size === bytes.length) throw new Error("engine descriptor exceeds its byte bound")
		const value = JSON.parse(bytes.subarray(0, size).toString("utf8"))
		if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("invalid engine descriptor")
		return value // The installed processor validates the complete descriptor and extraction context.
	} finally { await handle.close() }
}

async function readDescriptor(file) {
	try { return await readDescriptorFile(file) }
	catch { throw new Error("engine descriptor must be a bounded regular JSON object, not a symlink or special file") }
}

export async function prepareNativeLaunch(source, { stateDir, processingRoot, configDir }) {
	const settings = nativeProcessingSettings(source)
	const names = (source.RUNTIME_NATIVE_ENGINE_ENV || "").split(",").filter(Boolean)
	const engineEnv = nativeEngineEnv(source, names, { stateDir, configDir, mcpUrl: "http://127.0.0.1:7710/mcp" })
	if (!settings) return { engineEnv }
	if (!processingRoot) throw new Error("native processing requires a private state directory")
	const engineDescriptor = settings.descriptorPath ? await readDescriptor(settings.descriptorPath) : undefined
	const moduleURL = pathToFileURL(path.resolve(configDir, "../../scripts/build-config.mjs")).href
	const options = {
		directory: path.join(processingRoot, "config"), sourceDirectory: path.dirname(configDir),
		localServices: { processing: { url: "http://127.0.0.1:8765/mcp", token: "{env:GEOCLUSTER_NATIVE_PROCESSING_TOKEN}" } },
	}
	if (process.getuid?.() === 0) {
		// Never write as root through a native-user-writable retained subtree.
		const code = 'import {readFileSync} from "node:fs"; const {moduleURL,options}=JSON.parse(readFileSync(0,"utf8")); const {materializeProfile}=await import(moduleURL); materializeProfile("native",options);'
		const result = spawnSync("gosu", ["geocluster", process.execPath, "--input-type=module", "-e", code], {
			env: { PATH: NATIVE_PATH, LANG: "C.UTF-8" }, input: JSON.stringify({ moduleURL, options }), encoding: "utf8", timeout: 10000,
		})
		if (result.status !== 0) throw new Error("could not generate native processing configuration as the native identity")
	} else {
		const { materializeProfile } = await import(moduleURL)
		materializeProfile("native", options)
	}
	engineEnv.OPENCODE_CONFIG = path.join(options.directory, "opencode.json")
	return { engineEnv, processing: { model: settings.model, stateDir: processingRoot, ...(engineDescriptor ? { engineDescriptor } : {}) } }
}
