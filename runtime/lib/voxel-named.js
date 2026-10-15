import crypto from "node:crypto"
import { identifier } from "./file-contract.js"
import { canonicalJson } from "./voxel/voxel-recipe.js"
import { fail } from "./voxel-request.js"

const validName = (name) => typeof name === "string" && name.trim() && name.length <= 256 && !name.includes("\0")
export function namedIntent(intent) {
	const revision = intent.revision ?? null
	if (revision) identifier(revision.voxelId, "voxelId")
	return { voxelId: revision?.voxelId ?? `voxel-${crypto.randomUUID()}`, name: intent.recipe.name ?? intent.recipe.metadata.fieldName, revision }
}
export class NamedVoxels {
	constructor(service) { this.service = service; this.state = service.state; this.scope = service.workspace.identity }
	async list({ limit = 25, cursor = null, name = null } = {}) {
		if (!Number.isSafeInteger(limit) || limit < 1 || limit > 100 || name !== null && !validName(name)) throw fail(400, "invalid_parameter", "Use limit 1–100 and an exact name of at most 256 characters.")
		let after = ""
		if (cursor !== null) {
			try {
				if (typeof cursor !== "string" || cursor.length > 2048 || !/^[A-Za-z0-9_-]+$/.test(cursor)) throw new Error()
				const decoded = JSON.parse(Buffer.from(cursor, "base64url").toString("utf8"))
				if (canonicalJson(decoded.scope) !== canonicalJson(this.scope) || decoded.name !== name || Object.keys(decoded).sort().join() !== "after,name,scope") throw new Error()
				identifier(decoded.after, "cursor"); after = decoded.after
			} catch { throw fail(400, "invalid_cursor", "The cursor must belong to this workspace epoch and exact name filter.") }
		}
		const rows = await this.state.voxelNamedList({ limit, after, name }), more = rows.length > limit, items = rows.slice(0, limit)
		return { voxels: await Promise.all(items.map((r) => this.public(r))), cursor: more ? Buffer.from(JSON.stringify({ scope: this.scope, name, after: items.at(-1).voxelId })).toString("base64url") : null }
	}
	async resolve({ voxelId, name } = {}) {
		if (voxelId !== undefined && name !== undefined) throw fail(400, "invalid_parameter", "Resolve exactly one voxelId or exact name.")
		if (voxelId !== undefined) {
			identifier(voxelId, "voxelId")
			const head = await this.state.get("voxel-named", voxelId)
			if (!head) throw fail(404, "voxel_not_found", "No named voxel has this ID in the current workspace epoch.")
			return this.public(head)
		}
		if (!validName(name)) throw fail(400, "invalid_parameter", "Supply voxelId or an exact voxel name.")
		const rows = await this.state.voxelNamedList({ limit: 1, after: "", name })
		if (!rows.length) throw fail(404, "voxel_not_found", "No named voxel has this exact name.")
		if (rows.length > 1) throw fail(409, "ambiguous_name", "Several voxels have this name. List exact-name matches and choose a voxelId.")
		return this.public(rows[0])
	}
	// Each save publishes its own artifact, so at most one named voxel has it as head.
	async headOf(link) {
		const head = (await this.state.voxelNamedByArtifact(link.artifactId)).find((row) => canonicalJson(row.artifact) === canonicalJson(link))
		return head ? this.public(head) : null
	}
	async public(head) {
		// Metadata evidence only: listing never performs a full member read.
		const availability = await this.service.artifactAvailability(head.artifact)
		return { ...head, scope: this.scope, availability }
	}
	async settle(op) {
		const settled = await this.state.voxelNamedCommit(op.id)
		if (settled.named.outcome === "committed") this.notify(settled.named)
		return settled
	}
	notify(head) {
		try { this.service.workspace.events?.publish("invalidation", { changes: [{ type: "change", path: head.artifact.manifest.path }], voxelId: head.voxelId }) }
		catch (error) { this.service.workspace.logger.error?.("voxel head notification failed", { voxelId: head.voxelId, error: error.message }) }
	}
	async rename({ voxelId, name, expectedHeadRevision }) {
		if (!validName(name)) throw fail(400, "invalid_parameter", "Enter a nonempty voxel name of at most 256 characters.")
		const head = await this.state.voxelNamedRename(voxelId, name, expectedHeadRevision)
		this.notify(head); return this.public(head)
	}
}
