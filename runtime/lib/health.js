/**
 * Liveness and readiness.
 *
 *   GET /livez   200 as soon as this process serves HTTP (Docker HEALTHCHECK, gate probe)
 *   GET /readyz  200 when a new conversation can start without waiting: the engine (`opencode acp`)
 *                is initialized and warmed up. Its geocluster tools (`engine.tools`), the shared MCP
 *                and the datasets hydration state are reported but do not gate: an engine whose MCP
 *                is down still answers (and is restarted once the MCP is back, see the broker).
 *   GET /session/info   what a fresh browser needs before it opens the socket
 */
import fs from "node:fs/promises"
import path from "node:path"
import { BOOT_ID } from "./build-info.js"

export class Health {
	constructor(config, broker, build = null) {
		this.config = config
		this.broker = broker
		this.build = build
		this.startedAt = Date.now()
	}

	/** Written by the entrypoint's dataset hydrator: {state: idle|hydrating|ready|error, datasets: [...]} */
	async datasetsState() {
		try {
			const raw = await fs.readFile(path.join(this.config.gatewayStateDir, "datasets", "status.json"), "utf8")
			const parsed = JSON.parse(raw)
			return { state: parsed.state ?? "unknown", datasets: parsed.datasets ?? [], updatedAt: parsed.updatedAt ?? null }
		} catch {
			return { state: "idle", datasets: [], updatedAt: null }
		}
	}

	live() {
		return { status: "live", runtime: "gateway", uptimeS: Math.round((Date.now() - this.startedAt) / 1000), machineId: this.config.machineId, bootId: BOOT_ID }
	}

	async ready() {
		const datasets = await this.datasetsState()
		// components.mcp.inFlight is read from a fresh /healthz (the supervisor keeps those lines out of mcp.log)
		const mcp = this.broker.mcp
		if (mcp.state === "ready") await mcp.health?.(500).catch(() => null)
		const status = this.broker.status()
		const ready = status.engine.state === "ready"
		return {
			status: ready ? "ready" : "not_ready",
			ready,
			runtime: "gateway",
			api: 3,
			machineId: this.config.machineId,
			build: this.build?.toJSON() ?? null,
			components: { engine: status.engine, mcp: status.mcp, datasets },
			running: status.running,
			capacity: status.capacity,
			sessions: status.sessions,
			timestamp: new Date().toISOString(),
		}
	}

	info() {
		const engine = this.broker.engine
		return {
			...this.broker.status(),
			projectId: this.config.projectId,
			cwd: this.config.workspaceDir,
			machineId: this.config.machineId,
			build: this.build?.toJSON() ?? null,
			// the gateway's whitelisted capabilities (as in initialize), never the engine's raw ones
			agent: { info: engine.agentInfo ?? null, capabilities: this.broker.capabilities() },
		}
	}
}
