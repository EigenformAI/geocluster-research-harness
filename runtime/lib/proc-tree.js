/**
 * Process-tree helpers (Linux /proc) so a conversation's processes never outlive it.
 *
 * The Cline fork starts every command in its own process group and session
 * (StandaloneTerminalProcess: `detached: true`), so neither a signal to the agent nor to the
 * agent's group reaches a running specialist (`cline … -y`) or the Python script it runs. The
 * fork kills that tree itself on a clean shutdown, but not when the agent is SIGKILLed (stop grace
 * exceeded) or crashes; and once the agent is gone its children are re-parented, so they can no
 * longer be found by ancestry. Callers therefore snapshot the tree while the root is alive and
 * signal what is left of it afterwards. Start times guard against PID reuse.
 *
 * Not Linux (no /proc): every function is a no-op.
 *
 * Reads are synchronous on purpose: /proc lives in memory, and a full scan of 360 processes took
 * ~18 ms synchronously vs ~180 ms through libuv's 4-thread pool, whose saturation (one scan per
 * agent per interval) starved the gateway's own file I/O. A synchronous scan also can't overlap
 * itself. In the container (~50 processes) a scan is ~2 ms, every RUNTIME_TREE_SNAPSHOT_MS per agent.
 */
import fs from "node:fs"

function readStat(pid) {
	try {
		const raw = fs.readFileSync(`/proc/${pid}/stat`, "utf8")
		// "pid (comm) state ppid pgrp session tty tpgid flags minflt cminflt majflt cmajflt utime stime
		//  cutime cstime priority nice threads itrealvalue starttime …" — comm may contain spaces/parens
		const fields = raw.slice(raw.lastIndexOf(")") + 2).split(" ")
		return { ppid: Number(fields[1]), start: fields[19] }
	} catch {
		return null
	}
}

/** Every descendant of rootPid (not rootPid itself): [{pid, start}], breadth-first. */
export async function descendants(rootPid) {
	if (!rootPid) return []
	let names
	try {
		names = fs.readdirSync("/proc")
	} catch {
		return []
	}
	const children = new Map()
	const starts = new Map()
	for (const name of names) {
		if (!/^\d+$/.test(name)) continue
		const stat = readStat(name)
		if (!stat) continue
		const pid = Number(name)
		starts.set(pid, stat.start)
		if (!children.has(stat.ppid)) children.set(stat.ppid, [])
		children.get(stat.ppid).push(pid)
	}
	const out = []
	const queue = [...(children.get(rootPid) ?? [])]
	while (queue.length) {
		const pid = queue.shift()
		out.push({ pid, start: starts.get(pid) })
		queue.push(...(children.get(pid) ?? []))
	}
	return out
}

/** The members that are still the same process (pid alive, start time unchanged). */
export function stillRunning(tree) {
	return (tree ?? []).filter((p) => readStat(p.pid)?.start === p.start)
}

/** Union of snapshots (same pid + start time = same process). */
export function mergeTrees(...trees) {
	const seen = new Map()
	for (const tree of trees) for (const p of tree ?? []) seen.set(`${p.pid}:${p.start}`, p)
	return [...seen.values()]
}

/**
 * The members of `tree` whose environment holds exactly `name=value` (/proc/<pid>/environ).
 *
 * With one engine for every conversation, a conversation's tool processes can't be found by
 * ancestry: they are all children of the engine's `serve` process. The run-dir plugin gives each
 * tool shell GEOCLUSTER_RUN_DIR=runs/<sessionId>, so that is what identifies them. environ is the
 * environment at exec time, which is exactly what the plugin sets. A member that is gone, was
 * replaced (start time changed) or can't be read (another uid) is skipped.
 */
/** The members whose parent is `ppid` (e.g. 1: re-parented orphans). */
export function withParent(tree, ppid) {
	return (tree ?? []).filter((p) => {
		const stat = readStat(p.pid)
		return stat?.start === p.start && stat.ppid === ppid
	})
}

export function withEnv(tree, name, value) {
	const wanted = `${name}=${value}`
	return (tree ?? []).filter((p) => {
		if (readStat(p.pid)?.start !== p.start) return false
		try {
			return fs.readFileSync(`/proc/${p.pid}/environ`, "utf8").split("\0").includes(wanted)
		} catch {
			return false
		}
	})
}

/** Signal the members that are still the same process; returns how many were signalled. */
async function signalAlive(tree, signal) {
	let count = 0
	for (const p of tree) {
		const stat = readStat(p.pid)
		if (!stat || stat.start !== p.start) continue
		try {
			process.kill(p.pid, signal)
			count++
		} catch {
			// gone meanwhile, or not ours
		}
	}
	return count
}

/** SIGTERM what is left of a snapshot, SIGKILL whatever survives graceMs. */
export async function reapTree(tree, graceMs = 1000) {
	if (!tree?.length) return 0
	const signalled = await signalAlive(tree, "SIGTERM")
	if (!signalled) return 0
	await new Promise((resolve) => setTimeout(resolve, graceMs))
	await signalAlive(tree, "SIGKILL")
	return signalled
}
