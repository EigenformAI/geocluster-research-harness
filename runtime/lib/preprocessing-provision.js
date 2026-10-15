import crypto from "node:crypto"
import fs from "node:fs"
import path from "node:path"
import { discoveryMaxBytes, modelId } from "./managed-catalog.js"

export function preprocessingConfig(env = process.env) {
	for (const key of ["PREPROCESSING_ENABLED", "RUNTIME_AGGREGATE_ACTIVITY", "PREPROCESSING_ALLOW_MODEL_FALLBACK"]) if (env[key] !== undefined && !["true", "false"].includes(env[key])) throw new Error(`${key} must be true or false`)
	const enabled = env.PREPROCESSING_ENABLED === "true", aggregate = env.RUNTIME_AGGREGATE_ACTIVITY === "true"
	if (enabled && !aggregate) throw new Error("Preprocessing admission requires aggregate activity")
	if (aggregate && !(env.RUNTIME_ACTIVITY_URL && env.RUNTIME_ACTIVITY_TOKEN)) throw new Error("Aggregate activity requires a receiver URL and root credential")
	const configured = Boolean(env.PREPROCESSING_MODEL && env.LLM_PROXY_URL && env.PREPROCESSING_PROXY_TOKEN)
	if (enabled && !configured) throw new Error("Preprocessing enablement requires model, proxy URL and private proxy credential")
	const positive = (name, fallback, maximum = Number.MAX_SAFE_INTEGER) => {
		const raw = env[name] ?? fallback
		if (!(typeof raw === "number" || typeof raw === "string" && /^[0-9]+$/.test(raw))) throw new Error(`${name} must be a positive safe integer`)
		const value = Number(raw)
		if (!Number.isSafeInteger(value) || value <= 0 || value > maximum) throw new Error(`${name} must be a positive safe integer <= ${maximum}`)
		return value
	}
	let preferences
	try { preferences = JSON.parse(env.PREPROCESSING_FALLBACK_MODELS ?? "[]") } catch { throw new Error("PREPROCESSING_FALLBACK_MODELS must be a JSON array of exact proxy model references") }
	const exact = (value) => {
		if (typeof value !== "string" || value.length > 166 || !value.startsWith("proxy/")) return false
		const [id, ...variants] = value.slice(6).split("#")
		return modelId(id) && (variants.length === 0 || variants.length === 1 && /^[A-Za-z0-9][A-Za-z0-9_.-]{0,63}$/.test(variants[0]))
	}
	if (!Array.isArray(preferences) || preferences.length > 128 || !preferences.every(exact)) throw new Error("PREPROCESSING_FALLBACK_MODELS must contain at most 128 bounded exact proxy model references")
	if (env.PREPROCESSING_MODEL && !exact(env.PREPROCESSING_MODEL)) throw new Error("PREPROCESSING_MODEL must be an exact proxy model reference")
	const modelPolicyRefreshMs = positive("PREPROCESSING_MODEL_POLICY_REFRESH_MS", 30000)
	const modelPolicyMaxAgeMs = positive("PREPROCESSING_MODEL_POLICY_MAX_AGE_MS", 120000)
	const modelPolicyWarnings = []
	if (modelPolicyRefreshMs < 5000) modelPolicyWarnings.push("Model policy refresh below 5000 ms increases discovery request load")
	if (modelPolicyRefreshMs >= modelPolicyMaxAgeMs) modelPolicyWarnings.push("Model policy refresh at or above maximum age can leave new processing unready between observations")
	// Unset floors let the processor derive each candidate's extraction needs from
	// qualified image costs, requestBytes and its installed default output budget.
	const tokenFloor = (name) => env[name] === undefined ? null : positive(name, undefined, 2 ** 31 - 1)
	return { enabled, aggregate, configured, allowModelFallback: env.PREPROCESSING_ALLOW_MODEL_FALLBACK !== "false", fallbackModels: [...new Set(preferences)], minContextTokens: tokenFloor("PREPROCESSING_MIN_CONTEXT_TOKENS"), minOutputTokens: tokenFloor("PREPROCESSING_MIN_OUTPUT_TOKENS"), modelPolicyRefreshMs, modelPolicyMaxAgeMs, modelPolicyWarnings, retryCooldownMs: positive("PREPROCESSING_RETRY_COOLDOWN_MS", 300000) }
}

function directory(target, uid, gid, mode) {
	if (fs.existsSync(target) || fs.lstatSync(target, { throwIfNoEntry: false })) {
		const stat = fs.lstatSync(target)
		if (!stat.isDirectory() || stat.isSymbolicLink()) throw new Error("Protected preprocessing path must be a real directory")
	} else fs.mkdirSync(target)
	fs.chownSync(target, uid, gid)
	fs.chmodSync(target, mode)
}

function repair(root, uid, gid, dirMode, fileMode) {
	for (const entry of fs.readdirSync(root, { withFileTypes: true })) {
		const target = path.join(root, entry.name)
		if (entry.isSymbolicLink() || (!entry.isDirectory() && !entry.isFile())) throw new Error("Unexpected object in private preprocessing state; inspect retained volume")
		fs.chownSync(target, uid, gid)
		fs.chmodSync(target, entry.isDirectory() ? dirMode : fileMode)
		if (entry.isDirectory()) repair(target, uid, gid, dirMode, fileMode)
	}
}

export function provisionPreprocessing(env = process.env) {
	const config = { ...preprocessingConfig(env), projectId: env.PROJECT_ID || "default", managedCatalogPath: env.RUNTIME_MANAGED_CATALOG_PATH || path.join(env.RUNTIME_STATE_ROOT || "/workspace/.runtime", "managed-catalog.json"), managedBackendBaseUrl: env.RUNTIME_MANAGED_BACKEND_BASE_URL || env.LLM_PROXY_URL || "", runtimeGeneration: env.RUNTIME_MANAGED_GENERATION || null, managedDiscoveryMaxBytes: discoveryMaxBytes(env.RUNTIME_MANAGED_DISCOVERY_MAX_BYTES) }
	for (const warning of config.modelPolicyWarnings) console.warn(`preprocessing-owner / model-policy: ${warning}; next step: review configured refresh and maximum age`)
	const project = env.PROJECT_ID || "default"
	if (!/^[A-Za-z0-9_-]+$/.test(project)) throw new Error("PROJECT_ID must be a canonical project component")
	const base = `/workspace/.runtime/preprocessing/${project}`, run = "/run/runtime/preprocessing"
	directory("/workspace/.runtime/preprocessing", 0, 0, 0o755)
	directory(base, 0, 996, 0o710)
	directory(`${base}/config`, 0, 996, 0o750)
	for (const name of ["data", "engine"]) { directory(`${base}/${name}`, 996, 996, 0o700); repair(`${base}/${name}`, 996, 996, 0o700, 0o600) }
	directory(`${base}/inbox`, 998, 996, 0o750)
	repair(`${base}/inbox`, 998, 996, 0o750, 0o440)
	// The service traverses these directories to read only credential-free policy.
	// Private root files remain 0600 and neither directory is writable by GID 996.
	directory("/run/runtime", 0, 996, 0o710)
	directory(run, 0, 996, 0o710)
	const write = (name, value, uid = 0, gid = 0, parent = run) => {
		const fd = fs.openSync(`${parent}/${name}`, fs.constants.O_WRONLY | fs.constants.O_CREAT | fs.constants.O_TRUNC | fs.constants.O_NOFOLLOW, 0o600)
		fs.writeFileSync(fd, value); fs.fchownSync(fd, uid, gid); fs.fchmodSync(fd, 0o600); fs.closeSync(fd)
	}
	write("service-token", crypto.randomBytes(32).toString("hex"), 998, 996)
	write("activity-token", env.RUNTIME_ACTIVITY_TOKEN || "")
	write("proxy-token", env.PREPROCESSING_PROXY_TOKEN || "")
	write("runtime-control", crypto.randomBytes(32).toString("hex"))
	// Configuration is credential-free; only the owner receives the named proxy credential.
	const copyConfig = (key, name) => {
		if (!env[key]) return ""
		const target = env[key], stat = fs.lstatSync(target)
		if (!path.isAbsolute(target) || fs.realpathSync(target) !== target || !stat.isFile() || stat.uid !== 0 || (stat.mode & 0o022) || stat.size > 65536) throw new Error(`${key} must be a bounded root-owned credential-free configuration`)
		write(name, fs.readFileSync(target), 0, 996, `${base}/config`)
		fs.chmodSync(`${base}/config/${name}`, 0o640)
		return `${base}/config/${name}`
	}
	const number = (name, fallback, min = 0) => {
		const value = Number(env[name] ?? fallback)
		if (!Number.isFinite(value) || value < min) throw new Error(`${name} must be a finite number >= ${min}`)
		return value
	}
	const port = number("PREPROCESSING_PORT", 8765, 1)
	if (!Number.isInteger(port) || port > 65535 || [3000, 3001, Number(env.RUNTIME_FILES_PORT || 3002), Number(env.RUNTIME_MCP_PORT || 7710)].includes(port)) throw new Error("PREPROCESSING_PORT must be a separate TCP port")
	const attempts = number("PREPROCESSING_RESTART_MAX_ATTEMPTS", 5, 1)
	if (!Number.isSafeInteger(attempts)) throw new Error("PREPROCESSING_RESTART_MAX_ATTEMPTS must be a positive integer")
	write("boot.json", JSON.stringify({ ...config, base, bundleDigest: env.PREPROCESSING_BUNDLE_DIGEST || null, model: env.PREPROCESSING_MODEL || "", proxyUrl: env.LLM_PROXY_URL || "", profile: copyConfig("PREPROCESSING_PROFILE_FILE", "profile.json"), engineConfig: copyConfig("PREPROCESSING_ENGINE_CONFIG_FILE", "engine-custom.json"), port, activityUrl: env.RUNTIME_ACTIVITY_URL || "", activityIntervalMs: number("RUNTIME_ACTIVITY_INTERVAL_S", 60, 1) * 1000, storageReportIntervalMs: number("RUNTIME_STORAGE_REPORT_INTERVAL_S", 300) * 1000, maxInterestMs: number("PREPROCESSING_ACTIVITY_MAX_HOURS", 6) * 3600000, storageIntervalMs: number("PREPROCESSING_STORAGE_INTERVAL_S", 60, 1) * 1000, restartMaxAttempts: attempts, restartBackoffMs: number("PREPROCESSING_RESTART_BACKOFF_S", 1, .01) * 1000, startupSeconds: number("PREPROCESSING_STARTUP_S", 300, .01), serviceShutdownSeconds: number("PREPROCESSING_SERVICE_SHUTDOWN_S", 180, .01), ownerShutdownSeconds: number("PREPROCESSING_OWNER_SHUTDOWN_S", 30, .01) }))
	return config
}

if (process.argv[1] === new URL(import.meta.url).pathname) provisionPreprocessing()
