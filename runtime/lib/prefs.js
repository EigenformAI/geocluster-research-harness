/**
 * "Always allow" rules, persisted per machine in <stateDir>/prefs.json.
 *
 * The fork translates allow_always as a one-off yes; remembering it is the gateway's job.
 * Identifiers follow permissionHandler.ts (getAutoApprovalIdentifier): the first word of a
 * command, the tool name, or the MCP server name.
 */
import fs from "node:fs/promises"
import path from "node:path"

export function permissionIdentifier(toolCall) {
	const raw = toolCall?.rawInput && typeof toolCall.rawInput === "object" ? toolCall.rawInput : {}
	if (typeof raw.command === "string") return { kind: "command", id: raw.command.trim().split(/\s+/)[0] || "" }
	if (typeof raw.serverName === "string") return { kind: "mcp", id: raw.serverName }
	if (typeof raw.tool === "string") return { kind: "tool", id: raw.tool }
	if (toolCall?.kind === "execute") return { kind: "command", id: String(toolCall.title || "").replace(/^Execute command:\s*/, "").split(/\s+/)[0] }
	return null
}

export class Prefs {
	constructor(file) {
		this.file = file
		this.rules = { command: [], mcp: [], tool: [] }
	}

	static async load(stateDir) {
		const prefs = new Prefs(path.join(stateDir, "prefs.json"))
		try {
			const parsed = JSON.parse(await fs.readFile(prefs.file, "utf8"))
			for (const kind of Object.keys(prefs.rules)) {
				if (Array.isArray(parsed?.rules?.[kind])) prefs.rules[kind] = parsed.rules[kind].filter((v) => typeof v === "string")
			}
		} catch {
			// first boot
		}
		return prefs
	}

	isAllowed(toolCall) {
		const ident = permissionIdentifier(toolCall)
		if (!ident || !ident.id) return false
		return this.rules[ident.kind].includes(ident.id)
	}

	async allowAlways(toolCall) {
		const ident = permissionIdentifier(toolCall)
		if (!ident || !ident.id) return false
		if (!this.rules[ident.kind].includes(ident.id)) {
			this.rules[ident.kind].push(ident.id)
			await fs.mkdir(path.dirname(this.file), { recursive: true, mode: 0o700 })
			await fs.writeFile(this.file, JSON.stringify({ version: 1, rules: this.rules }, null, 2), { mode: 0o600 })
		}
		return true
	}
}
