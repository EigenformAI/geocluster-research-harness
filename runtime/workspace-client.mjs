import { WorkspaceClient, agentProbe, pathDiagnostic, clientFailure } from "./lib/workspace-client.js"

const [command, raw = "{}"] = process.argv.slice(2)
let code = 1, result
try {
	if (process.env.RUNTIME_AUTH_DISABLED !== "1" || process.env.FLY_MACHINE_ID) throw new Error("This helper requires local RUNTIME_AUTH_DISABLED=1. Use your existing authenticated file API client for authenticated deployments.")
	if (![998, 999].includes(process.getuid())) throw new Error("Run as geocluster (or gc-files for read-only effective-access diagnostics).")
	const input = JSON.parse(raw), client = new WorkspaceClient()
	if (process.getuid() === 998 && !["path", "probe-service"].includes(command)) throw new Error("gc-files diagnostics are read-only.")
	if (command === "upload" || command === "status" || command === "cleanup") ({ code, result } = await client[command](input, process.stdin))
	else if (command === "info") { result = await client.info(input.workspaceId ? input : undefined); code = 0 }
	else if (command === "admission") { result = await client.admission(input); code = 0 }
	else if (command === "path") {
		await client.stat(input) // Running service policy, including registered protected roots.
		result = await pathDiagnostic(input.info, input.path); code = 0
	} else if (["probe-agent", "probe-service"].includes(command)) {
		await client.stat({ ...input, path: `${input.path}/host.txt` })
		result = await agentProbe(input.info, { ...input, service: command === "probe-service" }); code = 0
	} else throw new Error("Unknown workspace helper command.")
} catch (error) { result = error.receipt || clientFailure("check_failed", error.message) }
process.stdout.write(`${JSON.stringify(result)}\n`)
process.exitCode = code
