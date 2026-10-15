/** Operator transport only: the running daemon owns publication and retained receipts. */
import { constants } from "node:fs"
import fs from "node:fs/promises"
import path from "node:path"
import { spawnSync } from "node:child_process"
import { canonicalPath, identifier } from "./file-contract.js"
import { SafePolicy } from "./safe-fs/policy.js"

export const cleanEnvironment = { PATH: "/usr/local/bin:/usr/bin:/bin", LANG: "C.UTF-8", LC_ALL: "C.UTF-8" }
export const clientFailure = (error, message, action = "Inspect the selected Compose service and retry.") => ({ error, message, agent: "local-workspace", tool: "workspace-client", action })

export function fenceHeaders(value) {
	for (const key of ["workspaceId", "workspaceEpoch"]) {
		if (typeof value[key] !== "string" || !/^[A-Za-z0-9_-]{1,128}$/.test(value[key])) throw new Error(`Supply the original ${key}.`)
	}
	return { "X-GC-Workspace-ID": value.workspaceId, "X-GC-Workspace-Epoch": value.workspaceEpoch }
}

export function operationResult(receipt, intent, sourceSubmitted = false) {
	fenceHeaders(intent)
	const statusCommand = `./scripts/workspace.sh status ${identifier(intent.operationId)} --workspace-id ${intent.workspaceId} --workspace-epoch ${intent.workspaceEpoch}`
	const valid = receipt?.operationId === intent.operationId && !receipt.error && (!receipt.addresses || receipt.addresses.every(ref => ref.workspaceId === intent.workspaceId && ref.workspaceEpoch === intent.workspaceEpoch))
	const committed = valid && receipt.state === "committed"
	const rejected = receipt?.error && (!receipt.operationId || receipt.operationId === intent.operationId) && [undefined, "rejected", "failed", "aborted-before-publication"].includes(receipt.state) && receipt.error !== "operation_indeterminate" && receipt.error !== "transport_unknown" || valid && ["failed", "aborted-before-publication"].includes(receipt.state)
	return {
		code: committed ? 0 : rejected ? 1 : 2,
		result: { ...receipt, operationId: intent.operationId, workspaceId: intent.workspaceId, workspaceEpoch: intent.workspaceEpoch,
			...(committed ? { publication: receipt.duplicate ? "original-operation-committed" : "committed", currentSourcePublished: sourceSubmitted && !receipt.duplicate } : { statusCommand }),
			...(receipt.duplicate ? { replayNotice: "The retained receipt describes the original accepted bytes; this body did not replace them." } : {}),
		},
	}
}

export class WorkspaceClient {
	constructor({ base = "http://127.0.0.1:3000", fetch: fetcher = fetch } = {}) { this.base = base; this.fetch = fetcher }
	async request(route, { method = "GET", fence, body, headers = {}, timeout = 30000 } = {}) {
		const response = await this.fetch(`${this.base}${route}`, { method, headers: { accept: "application/json", ...(fence ? fenceHeaders(fence) : {}), ...headers }, ...(body === undefined ? {} : { body, ...(typeof body !== "string" ? { duplex: "half" } : {}) }), redirect: "error", signal: AbortSignal.timeout(timeout) })
		let value, bytes = 0, chunks = []
		for await (const chunk of response.body) { bytes += chunk.length; if (bytes > 2 * 1024 * 1024) throw new Error("Response exceeds the diagnostic JSON bound."); chunks.push(Buffer.from(chunk)) }
		try { value = JSON.parse(Buffer.concat(chunks).toString("utf8")) } catch { throw new Error("The gate did not return structured JSON.") }
		if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("Expected a structured file API result.")
		if (!response.ok) throw Object.assign(new Error(value.message || "File API rejected the request."), { ...(typeof value.error === "string" ? { receipt: value } : {}), status: response.status })
		return value
	}
	async info(fence) {
		const info = await this.request("/files/info", { fence })
		fenceHeaders(info)
		if (info.filesContractVersion !== 1) throw new Error("Unsupported files contract.")
		return info
	}
	async admission(fence) {
		// This invalid body cannot name an operation or path. The daemon's drain
		// gate runs before validation, so this observes admission without effects.
		try { await this.request("/files/mkdir", { method: "POST", fence, body: "{}", headers: { "content-type": "application/json" } }) }
		catch (error) { if (error.status === 400 && error.receipt?.error === "invalid_id") return { admission: "open" }; throw error }
		throw new Error("Admission validation unexpectedly accepted an empty mkdir request.")
	}
	async upload(intent, stream) {
		canonicalPath(intent.path, { root: false }); identifier(intent.operationId); fenceHeaders(intent)
		if (!["create", "force-replace"].includes(intent.mode) || !["auto", "skip"].includes(intent.processing) || !Number.isSafeInteger(intent.length) || intent.length < 0 || !/^[a-f0-9]{64}$/.test(intent.digest)) throw new Error("Invalid upload intent.")
		try {
			return operationResult(await this.request(`/files/upload?${new URLSearchParams({ path: intent.path, operationId: intent.operationId, mode: intent.mode })}`, {
				method: "PUT", fence: intent, body: stream, timeout: 600000,
				headers: { "content-type": "application/octet-stream", "content-length": String(intent.length), "X-Content-SHA256": intent.digest, ...(intent.processing === "skip" ? { "X-GC-Process-Document": "skip" } : {}) },
			}), intent, true)
		} catch (error) { return operationResult(error.receipt || clientFailure("transport_unknown", error.message, "Query the original operation before any replay."), intent, true) }
	}
	async status(intent) {
		identifier(intent.operationId); fenceHeaders(intent)
		try { return operationResult(await this.request(`/files/operations/${encodeURIComponent(intent.operationId)}`, { fence: intent }), intent) }
		catch (error) {
			// Missing/expired receipts cannot prove that publication never happened.
			return operationResult(error.status === 404 ? { ...error.receipt, error: "transport_unknown", receiptError: error.receipt?.error, state: "unknown", action: "A missing receipt does not prove that publication never happened. Inspect the destination and retained state before deciding whether to replay the original intent." } : error.receipt || clientFailure("transport_unknown", error.message), intent)
		}
	}
	stat(intent) { return this.request(`/files/stat?${new URLSearchParams({ path: canonicalPath(intent.path) })}`, { fence: intent }) }
	async cleanup(intent) {
		const metadata = await this.stat(intent)
		if (!metadata.observation?.token) throw new Error("Cleanup requires a fresh directory observation.")
		try {
			const receipt = await this.request("/files/entry", { method: "DELETE", fence: intent, body: JSON.stringify({ operationId: intent.operationId, path: intent.path, baseObservation: metadata.observation, recursive: true }), headers: { "content-type": "application/json" } })
			return operationResult(receipt, intent)
		} catch (error) { return operationResult(error.receipt || clientFailure("transport_unknown", error.message, "Query the cleanup operation and inspect the visible probe directory."), intent) }
	}
}

function projectPath(info, relative) {
	canonicalPath(relative, { root: false }); new SafePolicy({ protectedRoots: ["datasets"] }).assertWrite(relative)
	if (!info.projectId || canonicalPath(info.projectId, { root: false }).includes("/") || info.cwd !== `/workspace/${info.projectId}`) throw new Error("The service must select a direct /workspace project subtree.")
	return path.join(info.cwd, relative)
}

async function noSymlinks(info, relative) {
	const target = projectPath(info, relative)
	let current = info.cwd
	if ((await fs.lstat(current)).isSymbolicLink()) throw new Error(`symlink: ${current}`)
	for (const component of relative.split("/")) {
		current = path.join(current, component)
		const stat = await fs.lstat(current)
		if (stat.isSymbolicLink()) throw new Error(`symlink: ${current}`)
	}
	return target
}

export async function pathDiagnostic(info, relative) {
	const target = await noSymlinks(info, relative), stat = await fs.lstat(target)
	const can = async (name, mode) => { try { await fs.access(name, mode); return true } catch { return false } }
	const acl = spawnSync("/usr/bin/getfacl", ["-cpnP", "--", target], { encoding: "utf8", env: cleanEnvironment, timeout: 5000, maxBuffer: 32768 })
	const storage = await fs.statfs(info.cwd)
	return { path: relative, uid: process.getuid(), gid: process.getgid(), owner: stat.uid, group: stat.gid, mode: (stat.mode & 0o7777).toString(8),
		fileServicePolicy: "Read visibility checked through the running service; OS access observations do not authorize writes to additional registered protected roots.",
		readable: await can(target, constants.R_OK), writable: await can(target, constants.W_OK), traversable: stat.isDirectory() ? await can(target, constants.X_OK) : null,
		parentWritable: await can(path.dirname(target), constants.W_OK | constants.X_OK), acl: acl.status === 0 ? acl.stdout : null, aclError: acl.status === 0 ? null : "ACL inspection unavailable; inspect getfacl and filesystem support.",
		storage: { filesystemType: String(storage.type), availableBytes: storage.bavail * storage.bsize, availableInodes: storage.ffree },
		permissionAction: "For unexpected denial, inspect ACL effective masks and SELinux labels (ls -Zd); EACCES alone does not identify the cause." }
}

export async function agentProbe(info, { path: relative, marker, service = false }) {
	const target = await noSymlinks(info, `${relative}/host.txt`)
	const handle = await fs.open(target, constants.O_NOFOLLOW | constants.O_NONBLOCK | (service ? constants.O_RDONLY : constants.O_RDWR))
	try {
		const stat = await handle.stat()
		if (!stat.isFile() || stat.size > 1024) throw new Error("Probe marker must be a bounded regular file.")
		const bytes = Buffer.alloc(stat.size); await handle.read(bytes, 0, bytes.length, 0)
		if (bytes.toString() !== marker) throw new Error("host_roundtrip_failed: container marker differs from the selected host source.")
		if (!service) { await handle.write(Buffer.from("agent-edited"), 0, 12, 0); await handle.truncate(12) }
	} finally { await handle.close() }
	if (!service) {
		const output = await fs.open(projectPath(info, `${relative}/agent.txt`), constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW, 0o664)
		try { await output.writeFile("agent-output") } finally { await output.close() }
	}
	return { boundary: service ? "host-service-read" : "host-agent-edit", uid: process.getuid(), gid: process.getgid(), passed: true }
}
