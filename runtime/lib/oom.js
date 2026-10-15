/**
 * OOM-killer preference for conversation processes.
 *
 * With several conversations on one 4 GB machine, the kernel's OOM killer must pick a
 * conversation's process (its agent, a specialist child, its MCP server) rather than the gateway
 * or the gate, whose death ends every conversation at once. The entrypoint lowers the gateway and
 * gate where it can (needs CAP_SYS_RESOURCE, which Fly VMs have and default Docker does not); the
 * gateway raises each conversation process here, which any process may do for its own children.
 * Specialist children and the Python scripts they run inherit the value from their `cline` parent.
 */
import fs from "node:fs/promises"

export async function raiseOomScore(pid, adj, logger) {
	if (!pid || !adj) return
	try {
		await fs.writeFile(`/proc/${pid}/oom_score_adj`, String(adj))
	} catch (error) {
		// Not Linux, or the process already exited: the preference is best-effort
		logger?.debug?.("oom_score_adj not set", { pid, error: String(error?.message ?? error) })
	}
}
