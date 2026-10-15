import fs from "node:fs/promises"
import { fchmod, fchown } from "node:fs"
import { promisify } from "node:util"
import { spawn } from "node:child_process"
import { SafeFs, canonicalPath } from "./safe-fs/index.js"
import { contains, isReserved } from "./safe-fs/policy.js"
import { FILE_LIMITS } from "./file-contract.js"

const chmod = promisify(fchmod), chown = promisify(fchown)
const trustedPath = "/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin"
const same = (a, b) => a.dev === b.dev && a.ino === b.ino
const permissions = (bits) => `${bits & 4 ? "r" : "-"}${bits & 2 ? "w" : "-"}${bits & 1 ? "x" : "-"}`
const bits = (text) => (text[0] === "r" ? 4 : 0) | (text[1] === "w" ? 2 : 0) | (text[2] === "x" ? 1 : 0)

export class LocalWorkspaceError extends Error {
	constructor(error, path, message, action, cause) {
		super(message, { cause })
		Object.assign(this, { error, path, agent: "local-workspace", tool: "provision", action })
	}
}
function fail(error, path, message, action, cause) { throw new LocalWorkspaceError(error, path, message, action, cause) }
function hostUid(value) {
	if (typeof value !== "string" || !/^[1-9][0-9]*$/.test(value) || Number(value) > 4294967294 || [996, 997, 998, 999].includes(Number(value))) {
		fail("invalid_host_uid", "LOCAL_WORKSPACE_HOST_UID", "Use a canonical decimal host UID from 1 through 4294967294, excluding 996–999.", "Correct LOCAL_WORKSPACE_HOST_UID and recreate the container, or leave it empty for custom permission setup.")
	}
	return Number(value)
}
function positive(value, name) {
	if (!Number.isSafeInteger(value) || value < 1) fail("invalid_scan_budget", name, `${name} must be a positive safe integer.`, "Correct the scan budget and retry.")
	return value
}
function absolute(value) {
	if (typeof value !== "string" || !value.startsWith("/")) fail("invalid_path", value, "Use a canonical absolute directory path.", "Correct the workspace/store path and recreate the container.")
	canonicalPath(value === "/" ? "" : value.slice(1))
	return value
}

/** Read-only enablement validation. Disabled mode performs no map or ACL inspection. */
export async function validateLocalWorkspace(env, { readFile = fs.readFile } = {}) {
	if (!env.LOCAL_WORKSPACE_HOST_UID) return null
	const uid = hostUid(env.LOCAL_WORKSPACE_HOST_UID)
	if (["FLY_MACHINE_ID", "IDE_MACHINE_TOKEN", "IDE_MACHINE_TOKEN_FILE", "IDE_MACHINE_CREDENTIALS_URL", "IDE_MACHINE_CREDENTIALS_FILE", "RUNTIME_FILES_URL", "RUNTIME_FILE_WORK_URL"].some((name) => env[name]) || env.FILES_SYNC_ADAPTER === "true" || env.OWNED_DEMO_ENABLED === "true") {
		fail("managed_local_workspace", "LOCAL_WORKSPACE_HOST_UID", "Local workspace ACLs require a local installation without managed machine/demo settings.", "Leave LOCAL_WORKSPACE_HOST_UID empty for managed deployments and recreate the container.")
	}
	for (const map of ["uid_map", "gid_map"]) {
		let raw
		try { raw = await readFile(`/proc/self/${map}`, "utf8") }
		catch (cause) { fail("unsupported_uid_mapping", `/proc/self/${map}`, "The process identity map is unreadable.", "Leave LOCAL_WORKSPACE_HOST_UID empty and use custom permission setup.", cause) }
		if (raw.trim().split(/\s+/).join(" ") !== "0 0 4294967295") {
			fail("unsupported_uid_mapping", `/proc/self/${map}`, "Local workspace ACLs require a single full-range identity map: 0 0 4294967295.", "Leave LOCAL_WORKSPACE_HOST_UID empty and use custom permission setup.")
		}
	}
	const projectId = canonicalPath(env.PROJECT_ID || "default", { root: false })
	if (projectId.includes("/") || isReserved(projectId) || projectId === "_orchestrator") fail("invalid_path", "PROJECT_ID", "Select one non-reserved project directory.", "Correct PROJECT_ID and recreate the container.")
	const workspaceDir = `/workspace/${projectId}`, storeDir = absolute(env.FILES_STATE_DIR || `/workspace/.runtime/file-service/${projectId}`)
	if (!storeDir.startsWith("/workspace/.runtime/file-service/")) fail("invalid_path", storeDir, "File-service state must be under /workspace/.runtime/file-service/.", "Correct FILES_STATE_DIR and recreate the container.")
	let limits = {}
	if (env.FILES_LIMITS) {
		try {
			if (Buffer.byteLength(env.FILES_LIMITS) > 4096) throw Error("too large")
			limits = JSON.parse(env.FILES_LIMITS)
			if (!limits || typeof limits !== "object" || Array.isArray(limits) || Object.entries(limits).some(([key, value]) => !Object.hasOwn(FILE_LIMITS, key) || !Number.isSafeInteger(value) || value < 1)) throw Error("invalid limits")
		} catch (cause) { fail("invalid_scan_budget", "FILES_LIMITS", "FILES_LIMITS requires known positive safe integer limits in at most 4096 JSON bytes.", "Correct FILES_LIMITS and recreate the container.", cause) }
	}
	return { hostUid: uid, workspaceDir, storeDir, scanLimit: limits.subtreeEntries ?? FILE_LIMITS.subtreeEntries, maxMs: positive(env.LOCAL_WORKSPACE_SCAN_MS ? Number(env.LOCAL_WORKSPACE_SCAN_MS) : 30000, "LOCAL_WORKSPACE_SCAN_MS"), maxDepth: 64 }
}

/** Inherit the held inode as child fd 3; never look its original pathname up again. */
export async function descriptorAcl(handle, tool, args, { timeoutMs = 5000 } = {}) {
	if (!["getfacl", "setfacl"].includes(tool)) throw Error("Use getfacl or setfacl")
	return new Promise((resolve, reject) => {
		const child = spawn(`/usr/bin/${tool}`, [...args, "--", "/proc/self/fd/3"], { env: { PATH: trustedPath, LC_ALL: "C" }, stdio: ["ignore", "pipe", "pipe", handle.fd], timeout: Math.max(1, Math.ceil(timeoutMs)), killSignal: "SIGKILL" })
		let stdout = "", stderr = "", overflow = false
		const collect = (part, output) => {
			if (output === "stdout") stdout += part; else stderr += part
			if (stdout.length + stderr.length > 65536) { overflow = true; child.kill("SIGKILL") }
		}
		child.stdout.on("data", (part) => collect(part, "stdout")); child.stderr.on("data", (part) => collect(part, "stderr"))
		child.once("error", reject)
		child.once("close", (code, signal) => code === 0 && !overflow ? resolve(stdout) : reject(new Error(`${tool} failed (${signal || code}): ${stderr.trim() || "ACL operation unavailable or timed out"}`)))
	})
}
function parseAcl(raw, path) {
	const result = new Map()
	for (const line of raw.split("\n")) {
		const value = line.split("#", 1)[0].trim()
		if (!value) continue
		const match = /^(default:)?(user|group|mask|other):([0-9]*):([r-][w-][x-])$/.exec(value)
		if (!match) fail("acl_inspection_failed", path, "ACL tooling returned an unrecognized entry.", "Inspect ACL support and installed getfacl before retrying.")
		const key = `${match[1] || ""}${match[2]}:${match[3]}`
		if (result.has(key)) fail("acl_inspection_failed", path, "ACL tooling returned duplicate entries.", "Inspect ACL support before retrying.")
		result.set(key, match[4])
	}
	return result
}
async function readAcl(handle, path, timeoutMs) {
	try { return parseAcl(await descriptorAcl(handle, "getfacl", ["-cpn"], { timeoutMs }), path) }
	catch (cause) {
		if (cause instanceof LocalWorkspaceError) throw cause
		fail("acl_inspection_failed", path, cause.message, "Inspect the mount's ACL support and read access; retain the workspace and retry.", cause)
	}
}

/** Check all existing ancestors, including the store itself, before any project mutation. */
export async function inspectStoreAncestors(storeDir) {
	absolute(storeDir)
	const held = []
	try {
		const names = ["/", ...storeDir.slice(1).split("/").filter(Boolean).map((_, i, parts) => `/${parts.slice(0, i + 1).join("/")}`)]
		for (const path of names) {
			let ancestor
			try { ancestor = await SafeFs.open(path) }
			catch (cause) {
				if (cause.code === "ENOENT") break // Future ancestors will be prepared by the existing bootstrap.
				fail("ancestor_inspection_failed", path, cause.message, "Inspect the exact protected ancestor; use real nonsymlink directories before retrying.", cause)
			}
			held.push(ancestor)
			const acl = await readAcl(ancestor.rootHandle, path)
			if ([...acl.keys()].some((key) => !["user:", "group:", "other:"].includes(key))) {
				fail("ancestor_acl", path, "A protected file-service store ancestor has an extended access/default ACL.", "Inspect and deliberately remove the ancestor ACL using custom permission setup, or leave local provisioning disabled; it is never stripped automatically.")
			}
		}
	} finally { for (const ancestor of held.reverse()) await ancestor.close() }
}

/** Boot-only ordinary project sharing. SafeFs may carry additional registered protected roots. */
export async function provisionLocalWorkspace(config, { safeFs } = {}) {
	const uid = hostUid(String(config.hostUid)), workspaceDir = absolute(config.workspaceDir), storeDir = absolute(config.storeDir)
	if (contains(storeDir, workspaceDir) || contains(workspaceDir, storeDir)) fail("invalid_path", storeDir, "Private storage and the ordinary project must not overlap.", "Keep file-service storage in a protected sibling subtree.")
	const scanLimit = positive(config.scanLimit ?? safeFs?.scanLimit ?? FILE_LIMITS.subtreeEntries, "scanLimit")
	const maxMs = positive(config.maxMs ?? 30000, "maxMs"), maxDepth = positive(config.maxDepth ?? 64, "maxDepth")
	await inspectStoreAncestors(storeDir)
	if (safeFs && (safeFs.root !== workspaceDir || !safeFs.noXdev)) fail("invalid_path", workspaceDir, "Use a noXdev SafeFs for this project root.", "Open the selected project with noXdev enabled before provisioning.")
	const ownsFs = !safeFs
	const started = performance.now(), deadline = started + maxMs
	const result = { project: workspaceDir, hostUid: uid, scanned: 0, changed: 0, skipped: 0, durationMs: 0 }
	const checkBudget = (path, depth = 0, count = false) => {
		if (count) result.scanned++
		if (result.scanned > scanLimit || depth > maxDepth || performance.now() >= deadline) fail("scan_limit", path, "Local workspace provisioning stopped with this scope unprocessed; earlier metadata changes may remain.", "Increase FILES_LIMITS.subtreeEntries / LOCAL_WORKSPACE_SCAN_MS (or the callable scanLimit/maxDepth/maxMs budget), or narrow the workspace before retrying.")
	}
	const remaining = (path) => { checkBudget(path); return deadline - performance.now() }
	const excluded = (relative) => relative && (relative.split("/").some((name) => isReserved(name) || name === "datasets" || name === "_orchestrator") || safeFs.policy.roots.some((entry) => contains(entry.path, relative)))
	const repair = async (handle, stat, path) => {
		let acl
		try { acl = await readAcl(handle, path, remaining(path)) }
		catch (cause) { checkBudget(path); throw cause }
		checkBudget(path)
		for (const key of acl.keys()) {
			const normalized = key.replace(/^default:/, "")
			const [kind, principal] = normalized.split(":")
			if (principal && (kind === "group" || kind === "user" && principal !== String(uid))) {
				fail("conflicting_acl", path, "An access/default ACL names another user or a named group.", "Manage this ACL deliberately with local provisioning disabled, or remove the conflicting principal before retrying.")
			}
		}
		const mode = Number(stat.mode) & 0o7777, directory = stat.isDirectory()
		// stat's group bits are the mask. Preserve effective group:: execute,
		// neither masked-off inherited x nor host-only x represented in the mask.
		const group = 6 | (bits(acl.get("group:") || permissions((mode >> 3) & 7)) & (mode >> 3) & 1)
		const host = 6 | ((mode & 0o100) ? 1 : 0), mask = group | host
		// Inherited raw x is harmless while masked off. Keep compliant entries
		// unchanged, but strip that x if the target mask would activate it.
		const groupAcl = group | (mask & 1 ? 0 : bits(acl.get("group:") || "---") & 1)
		const hostAcl = host | (mask & 1 ? 0 : bits(acl.get(`user:${uid}`) || "---") & 1)
		const desired = new Map(directory ? [["user:", "rwx"], [`user:${uid}`, "rwx"], ["group:", "rwx"], ["mask:", "rwx"], ["other:", "r-x"], ["default:user:", "rwx"], [`default:user:${uid}`, "rwx"], ["default:group:", "rwx"], ["default:mask:", "rwx"], ["default:other:", "r-x"]] : [["user:", permissions((mode >> 6) & 7)], [`user:${uid}`, permissions(hostAcl)], ["group:", permissions(groupAcl)], ["mask:", permissions(mask)], ["other:", permissions(mode & 7)]])
		const targetMode = directory ? 0o2775 : (mode & ~0o070) | (mask << 3)
		const aclChanged = acl.size !== desired.size || [...desired].some(([key, value]) => acl.get(key) !== value)
		if (stat.gid === 999n && mode === targetMode && !aclChanged) return
		checkBudget(path)
		if (stat.gid !== 999n) await chown(handle.fd, -1, 999)
		if (aclChanged) {
			try { await descriptorAcl(handle, "setfacl", ["--no-mask", "--set", [...desired].map(([key, value]) => `${key}:${value}`).join(",")], { timeoutMs: remaining(path) }) }
			catch (cause) { checkBudget(path); fail("acl_mutation_failed", path, cause.message, "Inspect mount ACL/write support; earlier metadata changes may remain. Correct the mount and retry.", cause) }
		}
		if ((Number((await handle.stat({ bigint: true })).mode) & 0o7777) !== targetMode) await chmod(handle.fd, targetMode)
		result.changed++
	}
	const walk = async (parent, name, relative, depth) => {
		const path = relative ? `${workspaceDir}/${relative}` : workspaceDir
		checkBudget(path, depth, true)
		if (excluded(relative)) { result.skipped++; return }
		let meta, handle
		try {
			meta = await safeFs.openAt(parent, name, { metadata: true, noXdev: true })
			const stat = await meta.stat({ bigint: true }), mode = Number(stat.mode)
			if ((!stat.isDirectory() && !stat.isFile()) || stat.isFile() && stat.nlink !== 1n || relative && stat.isDirectory() && !(mode & 0o077) || stat.isFile() && !(mode & 0o040) && !(stat.uid === 0n && mode & 0o077)) { result.skipped++; return }
			safeFs.policy.assertWrite(relative)
			safeFs.policy.assertIdentity(stat, "write")
			handle = await safeFs.openAt(parent, name, { directory: stat.isDirectory(), noXdev: true })
			if (!same(stat, await handle.stat({ bigint: true }))) fail("entry_changed", path, "The inspected entry changed before descriptor acquisition.", "Stop concurrent host moves and retry provisioning.")
			await repair(handle, stat, path)
			if (stat.isDirectory()) {
				for await (const entry of safeFs.entries(relative)) {
					if (entry.diagnostic) fail("entry_inspection_failed", path, entry.diagnostic.message, "Rename the unaddressable entry or stop concurrent host moves, then retry.")
					await walk(handle, entry.name, relative ? `${relative}/${entry.name}` : entry.name, depth + 1)
				}
			}
		} catch (cause) {
			if (["EXDEV"].includes(cause.code) || cause.code === "EACCES" && ["read_only_root", "hidden_root", "reserved_component"].includes(cause.reason)) { result.skipped++; return }
			if (cause instanceof LocalWorkspaceError) throw cause
			fail("provisioning_failed", path, cause.message, "Inspect the entry and mount permissions; stop concurrent host moves and retry. Earlier metadata changes may remain.", cause)
		} finally { await handle?.close(); await meta?.close() }
	}
	try {
		safeFs ??= await SafeFs.open(workspaceDir, { noXdev: true, scanLimit, protectedRoots: config.protectedRoots || [] })
		await walk(safeFs.rootHandle, "", "", 0)
		checkBudget(workspaceDir)
		result.durationMs = Math.round(performance.now() - started)
		return result
	} catch (cause) {
		cause.progress = { ...result, durationMs: Math.round(performance.now() - started) }
		throw cause
	} finally { if (ownsFs) await safeFs?.close() }
}
