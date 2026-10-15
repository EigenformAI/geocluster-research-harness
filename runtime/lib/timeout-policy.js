/** Timeout inventory for runtime status. Unknown settings are never advertised as unlimited. */
import fs from "node:fs/promises"
import path from "node:path"

export function timeoutPolicy(config) {
	return {
		workflow: { wallDeadlineMs: null },
		browser: { disconnect: "detach_observer", heartbeatMs: config.wsPingMs },
		inference: { applicationDeadlineMs: null, providerDeadline: "unknown", retries: 3 },
		shell: { defaultRuntimeMs: null, explicitCallerTimeout: "honored", execution: "foreground_engine_owned" },
		mcp: { configuration: "unavailable", startupMs: null, catalogMs: null, observationMs: null, cancellation: "observer_only_thread_may_continue" },
		explicitCancel: { engineGraceMs: config.cancelGraceMs, processReapGraceMs: config.cancelReapMs },
		machineLifecycle: { turnAgeNoticeMs: config.maxTurnMs || null, activityAfterNotice: "continues", shutdown: "supervisor_drain" },
	}
}

export async function loadTimeoutPolicy(config, logger) {
	const inventory = timeoutPolicy(config)
	try {
		const engine = JSON.parse(await fs.readFile(path.join(config.engineConfigDir, "opencode.json"), "utf8"))
		const limits = engine.mcp?.servers?.geocluster?.timeout
		if (!limits || ![limits.startup, limits.catalog, limits.execution].every((n) => Number.isSafeInteger(n) && n > 0)) {
			throw new Error("explicit positive MCP startup, catalog and execution values are unavailable")
		}
		Object.assign(inventory.mcp, { configuration: "configured", startupMs: limits.startup, catalogMs: limits.catalog, observationMs: limits.execution })
	} catch (error) {
		logger.warn("gateway / timeout-policy: MCP observation policy is unknown; next step: inspect the engine configuration", { error: String(error?.message ?? error) })
	}
	return inventory
}
