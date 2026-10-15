import path from "node:path"

export const NATIVE_PATH = "/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin"
const RESERVED = /^(?:OPENCODE_|GEOCLUSTER_|RUNTIME_|IDE_|PREPROCESSING_|R2_|XDG_|LD_)|^(?:HOME|PATH|NODE_OPTIONS|BUN_OPTIONS|PYTHONHOME|PYTHONPATH|LLM_PROXY_URL|SYNC_ENABLED|FILES_SYNC_ADAPTER|OWNED_DEMO_ENABLED)$/

export function validateEngineNames(names) {
	for (const name of names) {
		if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(name)) throw new Error(`invalid engine environment name: ${name}`)
		if (RESERVED.test(name)) throw new Error(`reserved engine environment name: ${name}; configure the native launch directly to change bootstrap controls`)
	}
	return [...new Set(names)]
}

export function nativeEngineEnv(source, names, { stateDir, configDir, mcpUrl }) {
	const env = {
		PATH: NATIVE_PATH, LANG: "C.UTF-8", HOME: path.join(stateDir, "home"),
		XDG_DATA_HOME: path.join(stateDir, "data"), XDG_STATE_HOME: path.join(stateDir, "state"),
		XDG_CACHE_HOME: path.join(stateDir, "cache"), XDG_CONFIG_HOME: path.join(stateDir, "config"),
		OPENCODE_CONFIG: path.join(configDir, "opencode.json"), OPENCODE_DISABLE_AUTOUPDATE: "1",
		GEOCLUSTER_MCP_URL: mcpUrl, GEOCLUSTER_TOOL_HOME: path.join(stateDir, "home"),
	}
	for (const name of ["TERM", "COLORTERM", "TERM_PROGRAM", "NO_COLOR"]) if (source[name] !== undefined) env[name] = source[name]
	for (const name of validateEngineNames(names)) {
		if (source[name] === undefined) throw new Error(`engine environment variable ${name} is not set`)
		env[name] = source[name]
	}
	return env
}
