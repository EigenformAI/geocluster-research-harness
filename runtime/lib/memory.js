/**
 * Container memory (cgroup v2), for the broker's memory guard: a new turn is refused (-32005) while
 * the machine is above RUNTIME_MEMORY_GUARD_PCT. With one engine for every conversation there is
 * nothing left to stop to make room (api 2 evicted idle conversations' processes), so the guard
 * only refuses.
 */
import fs from "node:fs/promises"
import path from "node:path"

/** Container memory in use, excluding reclaimable page cache; null when unlimited/unknown. */
export async function cgroupMemory(root = "/sys/fs/cgroup") {
	try {
		const maxRaw = (await fs.readFile(path.join(root, "memory.max"), "utf8")).trim()
		if (maxRaw === "max") return null
		const current = Number(await fs.readFile(path.join(root, "memory.current"), "utf8"))
		const stat = await fs.readFile(path.join(root, "memory.stat"), "utf8").catch(() => "")
		const inactiveFile = Number(/^inactive_file (\d+)$/m.exec(stat)?.[1] ?? 0)
		return { used: Math.max(0, current - inactiveFile), max: Number(maxRaw) }
	} catch {
		return null
	}
}
