/**
 * A fake OpenCode 2.0 plugin context: the hook registration surface the plugins use (`ctx.<domain>.hook(name, cb)`,
 * shapes from @opencode/plugin 2.0.19 dist/promise/*.d.ts) plus a session tree. `fire()` runs every callback
 * registered for a hook in order, on one mutable event object, as the engine does.
 */
import fs from "node:fs"
import os from "node:os"
import path from "node:path"

// A fresh temp workspace per ctx unless a test passes one: result-protocol writes <workspace>/runs/<root>/_orchestrator/,
// and a real default path ("/workspace" before 2026-10-02) got written outside any temp dir. Removed at exit.
const made = []
process.on("exit", () => made.forEach((dir) => fs.rmSync(dir, { recursive: true, force: true })))
function tempWorkspace() {
	const dir = fs.mkdtempSync(path.join(os.tmpdir(), "fake-ctx-"))
	made.push(dir)
	return dir
}

export function fakeCtx({ directory = tempWorkspace(), sessions = {} } = {}) {
	const hooks = new Map() // "domain:name" → [callback]
	const calls = { prompts: [] }
	const hook = (domain) => async (name, callback) => {
		const key = `${domain}:${name}`
		hooks.set(key, [...(hooks.get(key) ?? []), callback])
		return { dispose: async () => hooks.set(key, (hooks.get(key) ?? []).filter((c) => c !== callback)) }
	}
	const ctx = {
		location: { directory },
		tool: { hook: hook("tool") },
		shell: { hook: hook("shell") },
		permission: { hook: hook("permission") },
		session: {
			hook: hook("session"),
			async get({ sessionID }) {
				if (!(sessionID in sessions)) throw new Error(`no session ${sessionID}`)
				return { id: sessionID, parentID: sessions[sessionID] ?? undefined }
			},
			async prompt(input) {
				calls.prompts.push(input)
			},
		},
	}
	async function fire(domain, name, event) {
		for (const callback of hooks.get(`${domain}:${name}`) ?? []) await callback(event)
		return event
	}
	return { ctx, fire, calls, hooks }
}

/** A tree: root "ses_root" → orchestrator "ses_orch" → specialist "ses_spec"; a second root "ses_other". */
export const TREE = { ses_root: null, ses_orch: "ses_root", ses_spec: "ses_orch", ses_other: null }
