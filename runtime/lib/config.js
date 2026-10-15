/**
 * Runtime gateway configuration, read once from the environment.
 *
 * The gateway listens on loopback only; the root gate (gate.cjs) is the public face.
 * One `opencode acp` serves every conversation and one geocluster MCP serves every tool call.
 */
import path from "node:path"
import { discoveryMaxBytes } from "./managed-catalog.js"

function intEnv(env, name, fallback) {
	const raw = env[name]
	if (raw === undefined || raw === "") return fallback
	const value = Number(raw)
	return Number.isFinite(value) && value >= 0 ? value : fallback
}

export function loadConfig(env = process.env) {
	const projectId = env.PROJECT_ID || ""
	const workspaceDir = env.WORKSPACE_DIR || (projectId ? path.join("/workspace", projectId) : process.cwd())
	const stateRoot = env.RUNTIME_STATE_ROOT || "/workspace/.runtime"
	const engineStateDir = env.RUNTIME_ENGINE_STATE_DIR || path.join(stateRoot, "opencode")
	const engineConfigDir = env.RUNTIME_OPENCODE_CONFIG_DIR || "/opt/opencode/config"
	return {
		projectId,
		machineId: env.FLY_MACHINE_ID || "",
		listenHost: env.RUNTIME_GATEWAY_HOST || "127.0.0.1",
		listenPort: intEnv(env, "RUNTIME_GATEWAY_PORT", 3001),
		/** Private file identity checks for backend-fenced ACP connections. */
		filesPort: intEnv(env, "RUNTIME_FILES_PORT", 3002),
		workspaceDir: path.resolve(workspaceDir),
		/** Engine stderr, MCP log (CLINE_LOG_DIR is read for one release). */
		logDir: env.RUNTIME_LOG_DIR || env.CLINE_LOG_DIR || "/var/log/runtime",
		gatewayStateDir: env.RUNTIME_GATEWAY_STATE_DIR || path.join(stateRoot, "gateway"),
		mcpWorkspaceRoot: env.MCP_WORKSPACE_ROOT || workspaceDir,
		activityUrl: env.RUNTIME_ACTIVITY_URL || "",
		activityToken: env.RUNTIME_ACTIVITY_TOKEN || "",
		// Root credential gateway only. No renewal material belongs in agentEnv.
		machineTokenFile: env.IDE_MACHINE_TOKEN_FILE || "",
		machineCredentialsUrl: env.IDE_MACHINE_CREDENTIALS_URL || "",
		machineCredentialsFile: env.IDE_MACHINE_CREDENTIALS_FILE || "/run/runtime/machine-credentials.json",
		machineGatewayPort: intEnv(env, "RUNTIME_MACHINE_GATEWAY_PORT", 3003),
		llmProxyUrl: env.LLM_PROXY_URL || "",
		/** Public artifact is root-generated; never contains a bearer token or route override. */
		managedCatalogPath: env.RUNTIME_MANAGED_CATALOG_PATH || path.join(stateRoot, "managed-catalog.json"),
		managedBackendBaseUrl: env.RUNTIME_MANAGED_BACKEND_BASE_URL || env.LLM_PROXY_URL || "",
		runtimeGeneration: env.RUNTIME_MANAGED_GENERATION || null,
		managedDiscoveryMaxBytes: discoveryMaxBytes(env.RUNTIME_MANAGED_DISCOVERY_MAX_BYTES),
		llmToken: env.IDE_LLM_TOKEN || "",
		preprocessingProxyToken: env.PREPROCESSING_PROXY_TOKEN || "",
		datasetToken: env.IDE_DATASET_TOKEN || "",
		filesToken: env.IDE_FILES_TOKEN || "",
		workToken: env.IDE_WORK_TOKEN || "",
		filesUrl: env.RUNTIME_FILES_URL || "",
		fileWorkUrl: env.RUNTIME_FILE_WORK_URL || "",
		filesControlFile: env.RUNTIME_FILES_CONTROL_FILE || "",
		activityIntervalMs: intEnv(env, "RUNTIME_ACTIVITY_INTERVAL_S", 60) * 1000,
		/** Disk-usage posts while idle too, so a quiet project's usage stays current; 0 disables them. */
		storageReportIntervalMs: intEnv(env, "RUNTIME_STORAGE_REPORT_INTERVAL_S", 300) * 1000,
		permissionTimeoutMs: intEnv(env, "RUNTIME_PERMISSION_TIMEOUT_S", 1800) * 1000,
		/** Age-notice threshold only. Zero disables the notice; live turns always count as activity. */
		maxTurnMs: intEnv(env, "RUNTIME_MAX_TURN_HOURS", 6) * 3600 * 1000,
		/** After session/cancel, a turn the engine hasn't ended within this is ended by the gateway. */
		cancelGraceMs: Math.max(1, intEnv(env, "RUNTIME_CANCEL_GRACE_S", 30)) * 1000,
		/** After a cancelled turn, how long the conversation's tool processes get to exit before they are killed (API-09). */
		cancelReapMs: intEnv(env, "RUNTIME_CANCEL_REAP_MS", 3000),
		/** WebSocket ping interval; a socket that misses one pong is terminated. Tests lower it. */
		wsPingMs: intEnv(env, "RUNTIME_WS_PING_MS", 25000),

		// ---- the engine: one `opencode acp` (agent-supervisor.js) ----
		opencodeBin: env.OPENCODE_BIN || "/usr/local/bin/opencode",
		/** OPENCODE_CONFIG_DIR: opencode.json, prompts, plugins (root-owned in the image, §5.4). */
		engineConfigDir,
		/** OPENCODE_MODELS_PATH: an empty catalog, so the engine never offers bundled models (probe finding 1). */
		engineModelsPath: env.RUNTIME_OPENCODE_MODELS_PATH || path.join(engineConfigDir, "models-empty.json"),
		/** The engine's HOME (root-owned in the image: it discovers ~/.claude and ~/.agents). */
		engineHome: env.RUNTIME_ENGINE_HOME || path.join(engineStateDir, "home"),
		/** Root of the engine's XDG data/state/cache dirs (the database is <data>/opencode/opencode.db). */
		engineStateDir,
		/** XDG_CONFIG_HOME for the engine: an empty dir (root-owned in the image). */
		engineXdgConfigHome: env.RUNTIME_ENGINE_XDG_CONFIG_HOME || path.join(engineStateDir, "config"),
		/** HOME given back to tool shells by the run-dir plugin (GEOCLUSTER_TOOL_HOME). */
		toolHome: env.RUNTIME_TOOL_HOME || env.HOME || "/home/geocluster",
		engineInitTimeoutMs: intEnv(env, "RUNTIME_AGENT_INIT_TIMEOUT_S", 120) * 1000,
		/** How long a start waits for "mcp connected server=geocluster" before the engine is ready without tools. */
		engineMcpWaitMs: intEnv(env, "RUNTIME_ENGINE_MCP_WAIT_S", 40) * 1000,
		/** Margin after "mcp connected": prompts within ~72 ms of it had no tools (measured). */
		engineToolsSettleMs: intEnv(env, "RUNTIME_ENGINE_TOOLS_SETTLE_MS", 250),
		/** How often the supervisor checks that acp still has its private `serve` child. */
		engineWatchMs: Math.max(100, intEnv(env, "RUNTIME_ENGINE_WATCH_MS", 2000)),
		/** How long session/new and session/prompt wait for a (re)starting engine before -32003. */
		engineReadyWaitMs: intEnv(env, "RUNTIME_ENGINE_READY_WAIT_S", 15) * 1000,
		/** How often the engine's process tree is snapshotted, so a crash can't leave tool processes running. */
		treeSnapshotMs: Math.max(50, intEnv(env, "RUNTIME_TREE_SNAPSHOT_MS", 5000)),
		/** oom_score_adj (0 disables): the OOM killer takes tool processes and the MCP before the engine, never the gateway. */
		engineOomScoreAdj: Math.min(1000, Math.max(0, intEnv(env, "RUNTIME_ENGINE_OOM_SCORE_ADJ", 300))),
		/** Env passed to the engine besides its own settings; secrets are never forwarded. */
		agentEnv: {
			PATH: env.PATH || "/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin",
			LANG: env.LANG || "C.UTF-8",
			IDE_LLM_TOKEN: env.IDE_LLM_TOKEN || "",
			LLM_PROXY_URL: env.LLM_PROXY_URL || "",
		},

		// ---- conversations ----
		/** Turns that may run at the same time; a further prompt gets -32005 capacity. */
		maxRunning: Math.max(1, intEnv(env, "RUNTIME_MAX_RUNNING", 3)),
		/**
		 * Effort a conversation is put on whenever the engine leaves it at "default" (no variant): when it is
		 * created, and after a model change. "default" keeps the engine's own.
		 */
		defaultEffort: env.RUNTIME_DEFAULT_EFFORT || "high",
		/** Refuse a new turn above this share of the container's memory limit (cgroup v2); 0 disables. */
		memoryGuardPct: intEnv(env, "RUNTIME_MEMORY_GUARD_PCT", 85),
		/** Largest file a prompt may attach by resource_link: the engine inlines it whole (fails at 5–10 MB). */
		attachMaxKb: Math.max(1, intEnv(env, "RUNTIME_ATTACH_MAX_KB", 512)),
		/** Per-conversation outputs, relative to the workspace (X-7): runs/<sessionId>/. */
		runsSubdir: "runs",
		/** Archive only: the Cline data dirs of api-1/api-2 conversations (legacy import, rollback). */
		clineDataDir: env.CLINE_DATA_DIR || path.join(stateRoot, "cline"),
		conversationsDir: env.RUNTIME_CONVERSATIONS_DIR || path.join(stateRoot, "conversations"),

		// ---- the shared MCP (mcp-supervisor.js) ----
		mcpCommand: env.RUNTIME_MCP_CMD || "/home/geocluster/mcp-server/.venv/bin/python",
		mcpArgs: (env.RUNTIME_MCP_ARGS || "-u main.py").split(" ").filter(Boolean),
		mcpCwd: env.RUNTIME_MCP_CWD || "/home/geocluster/mcp-server",
		mcpPort: intEnv(env, "RUNTIME_MCP_PORT", 7710),
		mcpStartTimeoutMs: intEnv(env, "RUNTIME_MCP_START_TIMEOUT_S", 45) * 1000,
		/** DataFrame cache for the whole machine (one MCP process serves every conversation). */
		mcpCacheMb: intEnv(env, "RUNTIME_MCP_CACHE_MB", 1024),
		mcpToolThreads: Math.max(1, intEnv(env, "RUNTIME_MCP_TOOL_THREADS", 8)),
		mcpToolThreadsPerRun: Math.max(1, intEnv(env, "RUNTIME_MCP_TOOL_THREADS_PER_RUN", 4)),
		/** Before the MCP is stopped, wait this long for its in-flight tool calls (FastMCP's own grace is 0). */
		mcpDrainMs: intEnv(env, "RUNTIME_MCP_DRAIN_MS", 3000),
		mcpOomScoreAdj: Math.min(1000, Math.max(0, intEnv(env, "RUNTIME_MCP_OOM_SCORE_ADJ", 500))),

		// ---- end of turn (RE-4, report export) ----
		/** Write <run>/_reports/REPORT_<ts>.md (+ .docx/.pdf) after every root end_turn; "0" disables. */
		reportExport: env.RUNTIME_REPORT_EXPORT !== "0",
		pandocBin: env.RUNTIME_PANDOC_BIN || "pandoc",
		reportTimeoutMs: intEnv(env, "RUNTIME_REPORT_TIMEOUT_S", 60) * 1000,

		/** ripgrep for /files/search and /files/find (the image has /usr/bin/rg) */
		rgBin: env.RUNTIME_RG_BIN || "rg",
		/** Git commit the image was built from (Dockerfile ARG RUNTIME_BUILD_SHA); "" outside an image. */
		buildSha: env.RUNTIME_BUILD_SHA && env.RUNTIME_BUILD_SHA !== "unknown" ? env.RUNTIME_BUILD_SHA : "",
		/** The gate secret can also come from the env for local runs; stdin is the production path. */
		gateSecretFromEnv: env.RUNTIME_GATE_SECRET || "",
		gateDisabled: env.RUNTIME_GATE_DISABLED === "1" && !env.FLY_MACHINE_ID,
	}
}
