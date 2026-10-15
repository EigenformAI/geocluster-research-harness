/** Backend refusal integration contract, not a model inventory or eligibility policy. */
const reasons = {
	usage_limit_reached: ["Your model allowance is used for this period.", "Restore your allowance or upgrade, then make an explicit new submission."],
	model_not_allowed: ["This model is not available for your account.", "Choose an eligible model or restore its entitlement, then make an explicit new submission."],
	account_inactive: ["This account is inactive. New model requests are paused.", "Restore account access before making an explicit new submission."],
	request_already_admitted: ["This model request has already been admitted.", "Inspect the retained result and request status before making an explicit new submission."],
	usage_unavailable: ["Usage could not be checked. New model requests are paused.", "Retry account status after the usage service recovers, then make an explicit new submission."],
}
export const denialFor = (code) => Object.hasOwn(reasons, code) ? { code, message: reasons[code][0], retryable: false, recovery: reasons[code][1] } : null
export const denialMessage = (denial) => `[geocluster:${denial.code}] ${denial.message} ${denial.recovery}`

/** Engine wrappers may serialize nested provider errors. Inspect error fields, never prompts. */
export function managedDenial(value) {
	const seen = new Set()
	function visit(item, depth) {
		if (depth > 8 || item == null) return null
		if (typeof item === "string") {
			const direct = denialFor(item.toLowerCase())
			if (direct) return direct
			const marker = /\[geocluster:([a-z_]+)\]/.exec(item)
			if (marker) return denialFor(marker[1])
			// JSON can be prefixed by ACP's "Internal error:" or a subagent envelope.
			const start = item.indexOf("{"), end = item.lastIndexOf("}")
			if (start >= 0 && end > start) { try { return visit(JSON.parse(item.slice(start, end + 1)), depth + 1) } catch {} }
			return null
		}
		if (typeof item !== "object" || seen.has(item)) return null
		seen.add(item)
		for (const key of ["code", "type", "errorName", "usageDenial", "error", "data", "cause", "reason", "responseBody", "body", "message"]) {
			const denial = visit(item[key], depth + 1)
			if (denial) return denial
		}
		return null
	}
	return visit(value, 0)
}
