/**
 * A model of OpenCode 2.0's permission evaluation, for testing generated configuration without the engine.
 *
 * An agent's rules are an ordered list of {action, resource, effect}.
 * The LAST rule whose action and resource both match decides; `*`
 * matches any run of characters including `/`. The engine prepends its own defaults (allow-all), which every
 * geology-layer agent overrides with a leading `*:* deny`, so a list with no match is reported as "allow" here
 * exactly as the engine would treat it.
 */

const cache = new Map()

/** True when `value` matches the wildcard `pattern` (`*` = any characters, `?` = one character, anchored). */
export function wildcard(pattern, value) {
	let re = cache.get(pattern)
	if (!re) {
		const body = pattern.replace(/[.+^${}()|[\]\\]/g, "\\$&").replace(/\*/g, ".*").replace(/\?/g, ".")
		re = new RegExp(`^${body}$`, "s")
		cache.set(pattern, re)
	}
	return re.test(value)
}

/** The effect of `action` on `resource` under `rules`: "allow", "deny" or "ask". */
export function evaluate(rules, action, resource = "*") {
	let effect = "allow"
	for (const rule of rules) {
		if (wildcard(rule.action, action) && wildcard(rule.resource, resource)) effect = rule.effect
	}
	return effect
}

export const allows = (rules, action, resource) => evaluate(rules, action, resource) === "allow"

/** The geocluster MCP tools (bare names) an agent's rules allow. */
export const allowedMcpTools = (rules, tools) => tools.filter((t) => allows(rules, `geocluster_${t}`, "*")).sort()
