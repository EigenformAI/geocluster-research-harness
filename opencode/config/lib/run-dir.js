/**
 * run-dir (invariant X-7): automatic outputs stay under runs/<root session id>/; requested workspace saves ask.
 *
 * One engine serves every conversation. A conversation is a ROOT session; its orchestrator and specialists are
 * descendant sessions (parentID chain). This plugin resolves the root of whichever session acts (cached: a root
 * never changes) and:
 *
 *   tool execute.before   geocluster_* (MCP): input.run_dir = "runs/<root>", mutated in place; the MCP pops it and
 *                         uses it for that call only. shell: remember command → root for create.before.
 *   tool execute.after    geocluster_*: delete input.run_dir again. The same object is the tool part's stored input,
 *                         so it would otherwise show on the tool card and in the model's own history.
 *   shell create.before   has env but no sessionID (2.0.19): take the root queued for this exact command (FIFO) and
 *                         set GEOCLUSTER_RUN_DIR. The env is a copy of the private server's, so tool shells also get
 *                         a writable HOME and XDG folders under GEOCLUSTER_TOOL_HOME (the engine's HOME and config
 *                         home are read-only so a script can't plant config; its data/cache dirs hold its database),
 *                         and lose the secrets a tool never needs (/proc still shows them to the same uid).
 *   permission evaluate   all editing agents: own-run writes are automatic; ordinary workspace writes ask.
 *                         Private state, other runs, own _orchestrator and workspace escapes are denied, including
 *                         symlink destinations. Shell writes are not covered (advisory).
 *   session context       every model call in the tree gets the run-folder brief (the prompts say results/…).
 *
 * Verified in the probe (P4: 37/37 files in their own run folder, shell env correct at depth 2).
 */
import path from "node:path"
import fs from "node:fs/promises"

const QUEUE_TTL_MS = 10 * 60 * 1000 // a queued shell root not consumed by then belongs to a call that never ran

/**
 * Workspace files an agent may write outside its run folder. L4-3: extended records every install in
 * environment.yaml; the installs change the machine's one Python environment, so the record is shared too.
 */
export const SHARED_FILES = { extended: ["environment.yaml"] }

export const runDirOf = (root) => `runs/${root}`

/** XDG folders a tool shell gets under its own HOME (the defaults those programs would use). */
export const TOOL_XDG = [
	["XDG_CONFIG_HOME", ".config"],
	["XDG_DATA_HOME", ".local/share"],
	["XDG_STATE_HOME", ".local/state"],
	["XDG_CACHE_HOME", ".cache"],
]

/** In every tool shell's env by inheritance (the proxy token; the private server's lease password), never needed by a tool. */
export const TOOL_ENV_SCRUB = ["IDE_LLM_TOKEN", "OPENCODE_PASSWORD", "OPENCODE_SERVER_PASSWORD"]

export function brief(run) {
	return (
		`Output folder for this conversation: ${run}/ (your instructions write it as <run>/). Other conversations use ` +
		`the same workspace at the same time. Save automatic analysis outputs under ${run}/results/ ` +
		`(scripts under ${run}/scripts/<your specialist>/). When the user requests an exact workspace path, use the file write tool ` +
		`at that exact path and the existing panel edit approval. After approval, complete the write there and report that path. ` +
		`Do not redirect the requested save. Read inputs in place. Never edit private runtime state, other conversations' run folders, ` +
		`or ${run}/_orchestrator/. In shell commands the automatic output folder is ` +
		`$GEOCLUSTER_RUN_DIR (relative to the workspace root, which is the working directory).`
	)
}

/** Shared by the plugins: root session of any session, through the parent chain (cached). */
export function rootResolver(ctx) {
	const rootOf = new Map()
	const hasParent = new Map()
	async function resolveRoot(sessionID) {
		const chain = []
		let cur = sessionID
		for (let depth = 0; depth < 16; depth++) {
			const known = rootOf.get(cur)
			if (known) {
				for (const s of chain) rootOf.set(s, known)
				return known
			}
			chain.push(cur)
			const info = await ctx.session.get({ sessionID: cur })
			hasParent.set(cur, !!info.parentID)
			if (!info.parentID) {
				for (const s of chain) rootOf.set(s, info.id)
				return info.id
			}
			cur = info.parentID
		}
		throw new Error(`run-dir: the parent chain of ${sessionID} is deeper than 16`)
	}
	/** True for orchestrator and specialist sessions; known once resolveRoot(sessionID) has run. */
	const isDescendant = (sessionID) => hasParent.get(sessionID) === true
	return { resolveRoot, isDescendant }
}

export async function setup(ctx, { env = process.env, log = (msg) => console.error(`[run-dir] ${msg}`), now = Date.now } = {}) {
	const workspace = path.resolve(ctx.location.directory)
	const realWorkspace = await fs.realpath(workspace)
	const toolHome = env.GEOCLUSTER_TOOL_HOME || ""
	const { resolveRoot } = rootResolver(ctx)
	const shellQueue = new Map() // command → [{root, at}] waiting for create.before

	const inside = (base, target) => target === base || target.startsWith(base + path.sep)
	// Match the file service's protected names, including staging entries at any depth.
	const privateNames = new Set([".runtime", ".ide-state", ".datasets-staging", ".clinerules", ".git", ".upload-tmp"])
	const isPrivate = (relative) => relative.split(path.sep).some((name) =>
		privateNames.has(name) || name.startsWith(".gc-file-") || name === ".env" || name.startsWith(".env."))

	// The write tool creates missing parents. Resolve the deepest existing ancestor, not just the immediate parent.
	// lstat distinguishes an absent component from a dangling symlink, whose destination must not be guessed.
	async function destination(absolute) {
		let current = absolute
		const missing = []
		for (;;) {
			let stat
			try { stat = await fs.lstat(current) } catch (error) {
				if (error.code !== "ENOENT" || current === path.dirname(current)) throw error
				missing.unshift(path.basename(current))
				current = path.dirname(current)
				continue
			}
			const real = await fs.realpath(current)
			if (missing.length && !stat.isDirectory() && !(stat.isSymbolicLink() && (await fs.stat(real)).isDirectory())) {
				throw new Error("a parent is not a directory")
			}
			return path.join(real, ...missing)
		}
	}
	const statePaths = []
	for (const name of ["RUNTIME_STATE_ROOT", "OPENCODE_CONFIG_DIR", "XDG_CONFIG_HOME", "XDG_DATA_HOME", "XDG_STATE_HOME", "XDG_CACHE_HOME"]) {
		if (!env[name]) continue
		const absolute = path.resolve(workspace, env[name])
		if (inside(workspace, absolute)) statePaths.push(absolute)
	}

	function blocked(relative, root) {
		if (isPrivate(relative)) return "private runtime state"
		const parts = relative.split(path.sep)
		if (parts[0] !== "runs") return
		if (parts[1] !== root) return "another conversation's run folder"
		if (parts[2] === "_orchestrator") return "the runtime's own record of this conversation"
	}

	async function editPolicy(resource, root, agent) {
		const absolute = path.resolve(workspace, resource)
		if (!inside(workspace, absolute)) return { reason: "outside the workspace" }
		const lexical = path.relative(workspace, absolute)
		const lexicalBlock = blocked(lexical, root)
		if (lexicalBlock) return { reason: lexicalBlock }
		const real = await destination(absolute)
		if (!inside(realWorkspace, real)) return { reason: "outside the workspace after resolving symlinks" }
		const realBlock = blocked(path.relative(realWorkspace, real), root)
		if (realBlock) return { reason: realBlock }
		// Verify state aliases at permission time. A bad state path must deny the edit, not abort hook registration.
		for (const state of statePaths) {
			if (inside(state, absolute)) return { reason: "private runtime state" }
			if (inside(await destination(state), real)) return { reason: "private runtime state" }
		}
		const ownRun = inside(path.join(workspace, runDirOf(root)), absolute)
		const realOwnRun = inside(path.join(realWorkspace, runDirOf(root)), real)
		if (ownRun && !realOwnRun) return { reason: "this conversation's run folder resolves to a different destination" }
		const shared = (SHARED_FILES[agent] ?? []).some((file) =>
			absolute === path.join(workspace, file) && real === path.join(realWorkspace, file))
		return { effect: (ownRun && realOwnRun) || shared ? "allow" : "ask" }
	}

	function pruneShellQueue() {
		const cutoff = now() - QUEUE_TTL_MS
		for (const [command, queue] of shellQueue) {
			while (queue.length && queue[0].at < cutoff) queue.shift()
			if (queue.length === 0) shellQueue.delete(command)
		}
	}

	await ctx.tool.hook("execute.before", async (e) => {
		const input = e.input
		if (e.tool.startsWith("geocluster_")) {
			if (input && typeof input === "object") input.run_dir = runDirOf(await resolveRoot(e.sessionID))
			else log(`GAP: ${e.tool} call ${e.id} has no input object; run_dir not injected`)
			return
		}
		if (e.tool === "shell" && input && typeof input.command === "string") {
			pruneShellQueue()
			const queue = shellQueue.get(input.command) ?? []
			queue.push({ root: await resolveRoot(e.sessionID), at: now() })
			shellQueue.set(input.command, queue)
		}
	})

	await ctx.tool.hook("execute.after", (e) => {
		const input = e.input
		if (e.tool.startsWith("geocluster_") && input && typeof input === "object") delete input.run_dir
	})

	await ctx.shell.hook("create.before", (e) => {
		if (toolHome) {
			e.env.HOME = toolHome
			for (const [name, sub] of TOOL_XDG) e.env[name] = path.join(toolHome, sub)
		}
		for (const name of TOOL_ENV_SCRUB) delete e.env[name]
		const queue = shellQueue.get(e.command)
		const entry = queue?.shift()
		if (queue && queue.length === 0) shellQueue.delete(e.command)
		if (entry) e.env.GEOCLUSTER_RUN_DIR = runDirOf(entry.root)
		else log(`GAP: shell command without a known session: ${e.command.slice(0, 80)}`)
	})

	await ctx.permission.hook("evaluate", async (e) => {
		if (e.action !== "edit" || e.effect === "deny") return
		const root = await resolveRoot(e.sessionID)
		let effect = "allow"
		for (const resource of e.resources) {
			let policy
			try { policy = await editPolicy(resource, root, e.agent) } catch (error) {
				policy = { reason: "the destination cannot be verified" }
				log(`cannot verify edit ${resource}: ${error.message}`)
			}
			if (policy.reason) {
				e.effect = "deny"
				e.message = `Refused: ${resource} is ${policy.reason}. Choose an ordinary workspace file or write under ${runDirOf(root)}/results/.`
				log(`refused edit ${resource} (session ${e.sessionID}, agent ${e.agent}, root ${root}): ${policy.reason}`)
				return
			}
			if (policy.effect === "ask") effect = "ask"
		}
		e.effect = effect
	})

	await ctx.session.hook("context", async (e) => {
		e.system.push({ type: "text", text: brief(runDirOf(await resolveRoot(e.sessionID))) })
	})

	log(`loaded for ${workspace}${toolHome ? `; tool shells get HOME=${toolHome}` : ""}`)
}
