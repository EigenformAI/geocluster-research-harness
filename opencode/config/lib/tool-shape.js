/**
 * tool-shape: per-agent tool lists that permission rules can't express.
 *
 * L3-3: the transform specialist writes new files but must not edit existing ones in place (the fork gave it
 * write_to_file but no replace_in_file). OpenCode files both tools under the one `edit` permission action, so the
 * rules can't tell them apart. The `session context` hook can: its `tools` map is what the model is offered on
 * that call. In-place editors are found by their input schema, not by id, so an engine upgrade that renames a tool
 * still can't hand it back: 2.0.19's edit tool takes {path, oldString, newString} and its write tool
 * {path, content} (probe records).
 */

/** Agents that may create files but not edit existing ones in place. */
export const NO_IN_PLACE_EDIT = new Set(["transform"])

const IN_PLACE_KEYS = ["oldString", "old_string", "patchText", "patch"]

export function isInPlaceEditor(tool) {
	const props = tool?.input?.properties
	return !!props && IN_PLACE_KEYS.some((key) => key in props)
}

export async function setup(ctx, { log = (msg) => console.error(`[tool-shape] ${msg}`) } = {}) {
	const reported = new Set()
	await ctx.session.hook("context", (e) => {
		if (!NO_IN_PLACE_EDIT.has(e.agent)) return
		for (const [id, tool] of Object.entries(e.tools)) {
			if (!isInPlaceEditor(tool)) continue
			delete e.tools[id]
			if (!reported.has(id)) {
				reported.add(id)
				log(`L3-3: ${e.agent} is not offered the in-place editor "${id}"`)
			}
		}
	})
}
