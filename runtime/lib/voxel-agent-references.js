import crypto from "node:crypto"
import { isConversationId, MAX_REFERENCES, sameScope, validateReference } from "./voxel-agent-contract.js"
import { canonicalJson } from "./voxel/voxel-recipe.js"
import { fail } from "./voxel-request.js"

const KIND = "voxel-agent-references"
// All adapters sharing the daemon's FileState port share this queue. SQL epoch
// scoping supplies restart isolation; the queue protects read/modify/write retention.
const queues = new WeakMap()
const equal = (a, b) => canonicalJson(a) === canonicalJson(b)
const committed = (ref) => ["named-created", "head-advanced"].includes(ref.outcome)

export function createVoxelAgentReferences(workspace) {
	const state = workspace.state, identity = { ...workspace.identity }
	function fence(key) {
		if (!sameScope(identity, workspace.identity) || !sameScope(identity, state.identity) || !sameScope(key?.scope, identity)) throw fail(409, "stale_workspace", "Reference scope belongs to another workspace epoch. Reconnect before starting fresh work.")
		if (!isConversationId(key.conversationId)) throw fail(400, "invalid_conversation", "Use the root conversation's ses_ identity.")
		return crypto.createHash("sha256").update(JSON.stringify([identity.workspaceId, identity.workspaceEpoch, key.conversationId])).digest("hex")
	}
	async function read(key, id) {
		const record = await state.get(KIND, id)
		fence(key)
		if (!record) return []
		if (!sameScope(record.scope, identity) || record.conversationId !== key.conversationId || !Array.isArray(record.references) || record.references.length > MAX_REFERENCES) throw fail(503, "reference_store_unavailable", "Retained voxel references could not be verified. Resolve the intended voxel explicitly.")
		const refs = record.references.map((ref) => validateReference(ref, identity))
		if (refs.some((ref) => !ref)) throw fail(503, "reference_store_unavailable", "Retained voxel references could not be verified. Resolve the intended voxel explicitly.")
		return refs
	}
	return {
		async list(key) {
			const id = fence(key)
			await queues.get(state)
			fence(key)
			return read(key, id)
		},
		remember(key, value) {
			const work = async () => {
				const id = fence(key), incoming = validateReference(value, identity)
				if (!incoming) throw fail(502, "invalid_receipt", "The service returned an invalid voxel reference. Check the retained operation.")
				const refs = await read(key, id), at = refs.findIndex((ref) => ref.operationId === incoming.operationId), prior = refs[at]
				let ref = incoming
				if (prior) {
					// Late accepted receipts and exact inspections cannot erase a ready
					// result, its known logical association, or its committed outcome.
					if (prior.artifact && !incoming.artifact || prior.outcome !== "accepted" && incoming.outcome === "accepted") ref = prior
					else if (equal(prior.artifact, incoming.artifact)) {
						const named = !incoming.named || prior.named?.voxelId === incoming.named.voxelId && prior.named.headRevision && !incoming.named.headRevision ? prior.named : incoming.named
						ref = { ...incoming, ...(named ? { named } : {}), ...(committed(prior) && !committed(incoming) ? { outcome: prior.outcome } : {}) }
					}
				}
				const head = ref.named ? await state.get("voxel-named", ref.named.voxelId) : null
				const isHead = (r) => head && r.named?.voxelId === head.voxelId && r.named.headRevision === head.headRevision && equal(r.artifact, head.artifact)
				// Validators are opaque. Only the authoritative current SQL head can
				// rank two named hints; timestamps, names and generations cannot.
				if (prior && isHead(prior) && !isHead(ref)) ref = prior
				if (at >= 0) refs.splice(at, 1)
				const newer = ref.named && !isHead(ref) ? refs.findIndex((r) => r.named?.voxelId === ref.named.voxelId && isHead(r)) : -1
				if (newer >= 0) refs.splice(newer, 0, ref)
				else refs.push(ref)
				fence(key)
				await state.put(KIND, id, { schemaVersion: 1, scope: identity, conversationId: key.conversationId, references: refs.slice(-MAX_REFERENCES) })
				fence(key)
			}
			const pending = (queues.get(state) || Promise.resolve()).then(work)
			queues.set(state, pending.catch(() => {}))
			return pending
		},
	}
}
