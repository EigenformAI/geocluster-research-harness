import crypto from "node:crypto"
import { FileError, canonicalPath, identifier } from "./file-contract.js"
import { isReserved } from "./safe-fs/policy.js"

export const put = (kind, id, value) => ({ type: "put", kind, id, value })
export const remove = (kind, id) => ({ type: "delete", kind, id })
export const stableId = (intent) => {
	const hex = crypto.createHash("sha256").update(intent).digest("hex")
	return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-5${hex.slice(13, 16)}-a${hex.slice(17, 20)}-${hex.slice(20, 32)}`
}
export const cloudError = (status, code) => new FileError(status, code, `Cloud file integration: ${code.replaceAll("_", " ")}.`, { agent: "file-service", tool: "cloud-import", action: "Inspect the retained work and retry its original identity." })
export const pathKey = (name) => crypto.createHash("sha256").update(name).digest("hex")
export function cloudPath(name, { intake = false } = {}) {
	canonicalPath(name, { root: false })
	if ([...name].length > 512 || Buffer.byteLength(name) > 900 || name.split("/").some((part) => Buffer.byteLength(part) > 255 || /^\p{White_Space}+$/u.test(part))) throw cloudError(422, "invalid_path")
	if (intake && (name.split("/").some(isReserved) || ["datasets", "outputs", "runs", "documents"].includes(name.split("/")[0]))) throw cloudError(422, "reserved_intake_path")
	return name
}
export function historicalReceipt(value, claim) {
	const owner = value?.previousOwner, previous = value?.previousProcessingReceipt
	const badPrevious = previous !== null && (!previous || !["ticket", "awaiting-capacity", "skipped"].includes(previous.state) || previous.requestId !== claim.processingRequestId || previous.sourceFileVersionId !== claim.source.fileVersionId || previous.state === "ticket" && !["ticketId", "processorSubmissionKey", "processingPermitId"].every((key) => typeof previous[key] === "string" && previous[key]))
	if (value?.state !== "historical" || !["interrupted", "owner-lost"].includes(value.outcome) || !owner || !["runtimeId", "workspaceId", "workspaceEpoch"].every((key) => typeof owner[key] === "string" && owner[key]) || owner.runtimeId === claim.runtimeId && owner.workspaceId === claim.workspaceId && owner.workspaceEpoch === claim.workspaceEpoch || claim.recovery !== "rehydrate" || badPrevious || value.outcome === "interrupted" && previous?.state !== "ticket") throw cloudError(409, "historical_processing_unresolved")
	const result = { ...structuredClone(value), requestId: claim.processingRequestId, sourceFileVersionId: claim.source.fileVersionId }
	if (value.requestId !== undefined && value.requestId !== result.requestId || value.sourceFileVersionId !== undefined && value.sourceFileVersionId !== result.sourceFileVersionId) throw cloudError(409, "historical_processing_unresolved")
	return result
}
export const sameOwner = (a, b) => Boolean(a && b && ["runtimeId", "workspaceId", "workspaceEpoch"].every((key) => a[key] === b[key]))
export function sourceIdentity(source) {
	if (!source || !/^[0-9a-f]{64}$/.test(source.sha256 || "") || !Number.isSafeInteger(source.sizeBytes) || source.sizeBytes < 0 || typeof source.objectIdentity !== "string" || !source.objectIdentity || typeof source.fileVersionId !== "string") throw cloudError(422, "invalid_source")
	identifier(source.fileVersionId, "fileVersionId")
	return { fileVersionId: source.fileVersionId, objectIdentity: source.objectIdentity, sizeBytes: source.sizeBytes, sha256: source.sha256 }
}
export function headEntry(entry) {
	if (!entry || !["file", "directory", "tombstone"].includes(entry.kind) || !Number.isSafeInteger(entry.changeSeq) || entry.changeSeq < 0 || typeof entry.headToken !== "string" || !entry.headToken) throw cloudError(422, "invalid_head")
	const value = { path: cloudPath(entry.path), kind: entry.kind, changeSeq: entry.changeSeq, headToken: entry.headToken, fileVersionId: entry.fileVersionId || null, sizeBytes: entry.sizeBytes ?? null, sha256: entry.sha256 ?? null }
	if (entry.kind === "file") sourceIdentity({ ...value, objectIdentity: entry.fileVersionId })
	return value
}
export function permitOwner(permit, workspace, runtimeId, kind) {
	if (!permit || permit.kind !== kind || permit.state !== "granted" || permit.workspaceId !== workspace.identity.workspaceId || permit.workspaceEpoch !== workspace.identity.workspaceEpoch || runtimeId && permit.runtimeId !== runtimeId || !Number.isSafeInteger(permit.ownerRevision) || permit.ownerRevision < 1 || typeof permit.permitId !== "string") throw cloudError(409, "permit_owner_mismatch")
	return permit
}
