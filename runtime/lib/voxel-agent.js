import { fail } from "./voxel-request.js"
import { canonicalJson } from "./voxel/voxel-recipe.js"
import { ACTION_FIELDS, MAX_REFERENCES, exactFields, isConversationId, ordinaryPath, sameScope, validArguments, validArtifact, validScope, validateReference } from "./voxel-agent-contract.js"

/** Restricted dispatcher; the parent owns HTTP/Unix listening, capture effects and durable reference storage.
 * captureSource({path, options, scope, conversationId}) -> {source, input, ...description}
 * saveReplacement({csv, recipe, destination, scope, conversationId}) -> {source, input}
 * references.list({scope, conversationId}) / remember(key, serviceGeneratedReference) must use protected storage.
 * All service methods must recheck the workspace fence at their effect boundary.
 */
export function createVoxelAgentBridge(service, { captureSource, saveReplacement, references }) {
	if (typeof captureSource !== "function" || typeof saveReplacement !== "function") throw new TypeError("Voxel agent bridge requires runtime-owned source capture and replacement publication adapters.")
	if (typeof references?.list !== "function" || typeof references?.remember !== "function") throw new TypeError("Voxel agent bridge requires a protected conversation reference store.")
	const currentScope = () => { const s = service.workspace.identity; if (!validScope(s)) throw fail(503, "identity_unavailable", "Workspace identity is unavailable. Reconnect to the runtime."); return { workspaceId: s.workspaceId, workspaceEpoch: s.workspaceEpoch } }
	function requireFence(scope) { if (!sameScope(scope, currentScope())) throw fail(409, "stale_workspace", "Voxel scope belongs to another workspace or epoch. Reconnect before starting fresh work.") }
	function artifactSummary(record, name) {
		const manifest = record.manifest, summary = { name: name || manifest?.recipe?.recipe?.name || manifest?.field?.name || "Voxel" }
		if (manifest?.grid?.shape) summary.shape = manifest.grid.shape
		const count = manifest?.statistics?.validCells ?? manifest?.statistics?.occupiedCells
		if (Number.isSafeInteger(count)) summary.validCells = count
		return summary
	}
	async function remember(value, key) {
		const ref = validateReference(value, key.scope)
		if (!ref) throw fail(502, "invalid_receipt", "Voxel service returned invalid result metadata. Check runtime status before retrying a submission.")
		requireFence(key.scope)
		await references.remember(key, ref)
		return ref
	}
	async function artifactReference(artifact, head, key) {
		requireFence(key.scope)
		const record = await service.artifactRecord(artifact)
		if (head?.scope && !sameScope(head.scope, key.scope)) throw fail(409, "stale_reference", "Resolved named voxel belongs to a stale workspace.")
		let named = head ? { voxelId: head.voxelId, name: head.name, headRevision: head.headRevision } : undefined
		if (!named) {
			// Exact inspection must not erase a known logical target. Only protected matching bindings count;
			// no manifest/predecessor/name inference, and an ambiguous association remains unnamed.
			requireFence(key.scope)
			const stored = await references.list(key)
			const matches = (Array.isArray(stored) ? stored : []).slice(-MAX_REFERENCES).map((ref) => validateReference(ref, key.scope)).filter((ref) => ref?.named && canonicalJson(ref.artifact) === canonicalJson(artifact))
			if (new Set(matches.map((ref) => ref.named.voxelId)).size === 1) named = matches.at(-1).named
		}
		return remember({ schemaVersion: 1, scope: key.scope, operationId: record.manifest.operationId, artifact,
			...(named ? { named } : {}), outcome: "artifact-saved", summary: artifactSummary(record, named?.name) }, key)
	}
	async function resolveNamed(args, key) {
		const result = await service.namedResolve(args)
		return { result, geoclusterVoxel: await artifactReference(result.artifact, result, key) }
	}
	async function receipt(result, key) {
		requireFence(key.scope)
		const op = result?.operation ?? result
		if (!op?.id || !op.phase) throw fail(502, "invalid_receipt", "Voxel service returned no operation receipt. Check the retained key before retrying.")
		const artifact = op.artifact ?? null
		const named = op.named ? { voxelId: op.named.voxelId, name: op.named.name, headRevision: op.named.headRevision ?? null } : undefined
		// Never derive head commitment from phase=ready, an artifact, predecessor or prose.
		const revising = !!op.submission?.revision
		let outcome = op.phase === "failed" ? op.named?.outcome === "conflict" ? "head-conflict" : "failed" : "accepted"
		if (artifact) {
			outcome = !op.named ? "artifact-saved" : op.named.outcome === "committed" ? revising ? "head-advanced" : "named-created" : op.named.outcome === "conflict" ? "head-conflict" : op.named.outcome === "failed" ? revising ? "head-advance-failed" : "named-creation-failed" : revising ? "head-outcome-unknown" : "named-outcome-unknown"
			if (op.named?.outcome === "committed" && canonicalJson(op.named.artifact) !== canonicalJson(artifact)) throw fail(502, "invalid_receipt", "Committed named outcome does not bind this operation's artifact. Check runtime status.")
		}
		const name = named?.name || op.submission?.recipe?.name || "Voxel"
		const summary = artifact ? artifactSummary(await service.artifactRecord(artifact), name) : { name }
		const ref = await remember({ schemaVersion: 1, scope: key.scope, operationId: op.id, artifact, ...(named ? { named } : {}), outcome, summary }, key)
		return { result, geoclusterVoxel: ref }
	}
	return {
		async dispatch(body) {
			const fields = body && Object.hasOwn(ACTION_FIELDS, body.action) ? ACTION_FIELDS[body.action] : null
			if (!fields || !exactFields(body, ["action", "scope", "conversationId", ...fields], ["action", "scope", "conversationId"])) throw fail(400, "invalid_request", "Unsupported voxel action or request fields.")
			if (!isConversationId(body.conversationId)) throw fail(400, "invalid_conversation", "conversationId must be a validated root ses_ identity.")
			const { action, scope, conversationId, ...args } = body
			if (!validArguments(action, args)) throw fail(400, "invalid_request", "Unsupported or missing voxel argument fields or types.")
			// The only unfenced read discovers runtime identity, never project identity from a session ID.
			if (action === "capabilities") { if (scope !== null) requireFence(scope); return { scope: currentScope(), capabilities: service.capabilities() } }
			requireFence(scope)
			const key = { scope: { ...scope }, conversationId }
			if (action === "references") {
				const stored = await references.list(key)
				requireFence(scope)
				return { references: (Array.isArray(stored) ? stored : []).slice(-MAX_REFERENCES).map((ref) => validateReference(ref, scope)).filter(Boolean) }
			}
			if (args.artifact !== undefined && !validArtifact(args.artifact)) throw fail(400, "invalid_artifact", "Supply an exact registered artifact binding.")
			if (action === "resolve") {
				if (args.reference !== undefined) {
					const ref = validateReference(args.reference, scope)
					if (!ref?.named) throw fail(409, "stale_reference", "Invalid or stale named voxel reference. Perform a fresh name lookup.")
					if (args.voxelId !== undefined || args.name !== undefined || args.list !== undefined || args.cursor !== undefined || args.limit !== undefined) throw fail(400, "invalid_request", "Resolve one reference or one explicit selector.")
					return resolveNamed({ voxelId: ref.named.voxelId }, key)
				}
				if (args.limit !== undefined && (!Number.isSafeInteger(args.limit) || args.limit < 1 || args.limit > 100)) throw fail(400, "invalid_request", "List limit must be 1–100.")
				if (args.list === true) {
					if (args.voxelId !== undefined) throw fail(400, "invalid_request", "List and voxelId cannot be combined.")
					return { result: await service.namedList({ ...(args.cursor === undefined ? {} : { cursor: args.cursor }), ...(args.name === undefined ? {} : { name: args.name }), limit: args.limit ?? 20 }) }
				}
				if (!!args.voxelId === !!args.name || args.cursor !== undefined || args.limit !== undefined) throw fail(400, "invalid_request", "Resolve exactly one voxelId or name, or list a bounded page.")
				return resolveNamed(args, key)
			}
			if (action === "inspect") {
				if (!args.artifact) throw fail(400, "invalid_artifact", "Inspection requires an exact artifact.")
				const result = await service.inspectArtifact({ artifact: args.artifact, options: args.options ?? {} })
				return { result, geoclusterVoxel: await artifactReference(args.artifact, null, key) }
			}
			if (action === "prepare") {
				if (!!args.path === !!args.artifact) throw fail(400, "invalid_request", "Prepare one ordinary source path or one full artifact replacement.")
				if (args.path) {
					if (!ordinaryPath(args.path) || args.destination !== undefined) throw fail(400, "invalid_source_path", "Capture an ordinary workspace-relative source path, never private runtime state.")
					return { result: await captureSource({ ...args, scope, conversationId }) }
				}
				if (!ordinaryPath(args.destination) || !args.destination.startsWith(`runs/${conversationId}/results/`) || !args.destination.endsWith(".csv")) throw fail(400, "invalid_destination", "Full replacements need a CSV destination in this conversation's results folder.")
				const materialized = await service.materializeArtifact({ artifact: args.artifact, options: args.options ?? {} })
				if (materialized.complete !== true || typeof materialized.csv !== "string" || materialized.recipe?.scope?.input !== null) throw fail(502, "incomplete_replacement", "Materialization must supply a complete replacement CSV and an unbound input recipe.")
				requireFence(scope)
				const captured = await saveReplacement({ csv: materialized.csv, recipe: materialized.recipe, destination: args.destination, scope, conversationId })
				if (!captured?.input || !captured.source) throw fail(502, "invalid_capture", "Replacement capture must bind a ready source and table input.")
				const { csv, ...result } = materialized
				return { result: { ...result, source: captured.source, path: args.destination, recipe: { ...result.recipe, scope: { ...result.recipe.scope, input: captured.input } } } }
			}
			if (action === "validate") return { result: await service.validateSubmission(args.submission) }
			if (action === "submit") return receipt(await service.submit(args.submission, args.idempotencyKey), key)
			if (action === "status") {
				if (!!args.operationId === !!args.idempotencyKey) throw fail(400, "invalid_request", "Status needs one operationId or retained idempotencyKey.")
				let operationId = args.operationId
				if (!operationId) {
					const found = await service.list({ idempotencyKey: args.idempotencyKey })
					if (!found.length) throw fail(404, "operation_not_found", "No voxel operation has this retained key in the current workspace epoch. Do not silently submit a new key.")
					if (found.length !== 1) throw fail(502, "invalid_receipt", "The retained key resolved to multiple operations. Check runtime status.")
					operationId = found[0].id
				}
				requireFence(scope)
				return receipt(await service.operation(operationId), key)
			}
		},
	}
}
