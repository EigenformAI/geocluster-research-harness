import { validateLocalWorkspace, inspectStoreAncestors, provisionLocalWorkspace } from "./lib/local-workspace.js"

try {
	const mode = process.argv[2]
	if (!["validate", "provision"].includes(mode) || process.argv.length !== 3) throw Error("Use local-workspace.mjs validate|provision")
	const config = await validateLocalWorkspace(process.env)
	if (config) {
		if (mode === "validate") await inspectStoreAncestors(config.storeDir)
		else console.log(`[workspace] ${JSON.stringify(await provisionLocalWorkspace(config))}`)
	}
} catch (cause) {
	console.error(`[workspace] ${JSON.stringify({ ...cause.progress, error: cause.error || "setup_failed", agent: "local-workspace", tool: "provision", path: cause.path, message: cause.message, action: cause.action || "Inspect local provisioning configuration and recreate the container with its workspace retained." })}`)
	process.exitCode = 1
}
