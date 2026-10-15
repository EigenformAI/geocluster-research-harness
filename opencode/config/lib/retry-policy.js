/**
 * retry-policy: model-request retries end quickly and visibly, as they did with Cline.
 *
 * Cline retried a failed request up to 3 times (2 s, 4 s, 8 s) and never retried authentication or
 * insufficient-credit errors. The user then saw "API request failed". In api 3 that becomes `Error:` text from the
 * gateway when the prompt fails. OpenCode decides retries itself; the `session retry` hook can override each
 * decision (SessionRetry: error {type, message, status?}, attempt = the next attempt's number, mutable decision).
 * This plugin:
 *   - stops on errors a retry can't fix: 401/402/403, 400, 404, 413, and "insufficient credits/balance" messages
 *     (the proxy's token expired, the account is out of credit, the request is malformed or too large);
 *   - allows at most MAX_RETRIES retries, waiting at least 2 s, 4 s, 8 s (the engine may ask for longer, e.g. a
 *     Retry-After; capped at MAX_DELAY_MS so a turn never sits silent for minutes);
 *   - logs every decision (the engine log is kept: OPENCODE_PRINT_LOGS=1).
 */
import { managedDenial } from "./managed-usage.js"
export const MAX_RETRIES = 3
export const MAX_DELAY_MS = 30_000
const NO_RETRY_STATUS = new Set([400, 401, 402, 403, 404, 409, 413])
const NO_RETRY_MESSAGE = /insufficient (credits?|balance|funds|quota)|invalid api key|unauthori[sz]ed|token (has )?expired/i

/**
 * The decision for one failed request. `attempt` is the number of the attempt that would come next: 2.0.19 calls the
 * hook with 2, 3, 4 … after the 1st, 2nd, 3rd failed request (measured 2026-10-01), so retry number = attempt - 1.
 */
export function decide({ error, attempt, decision }) {
	const retry = Math.max(1, (Number(attempt) || 2) - 1)
	if (managedDenial(error) || error?.retryable === false || NO_RETRY_STATUS.has(Number(error?.status)) || NO_RETRY_MESSAGE.test(error?.message ?? "")) return { retry: false }
	if (retry > MAX_RETRIES || decision?.retry === false) return { retry: false }
	const backoff = 2000 * 2 ** (retry - 1)
	return { retry: true, delay: Math.min(Math.max(decision?.delay ?? 0, backoff), MAX_DELAY_MS) }
}

export async function setup(ctx, { managedProviderID = "proxy", log = (msg) => console.error(`[retry-policy] ${msg}`) } = {}) {
	await ctx.session.hook("retry", (e) => {
		if (e.model.providerID !== managedProviderID) return
		e.decision = decide(e)
		const what = e.decision.retry ? `retry in ${Math.round(e.decision.delay / 1000)} s` : "giving up"
		log(
			`session=${e.sessionID} agent=${e.agent} attempt=${e.attempt} status=${e.error?.status ?? "-"} ` +
				`type=${e.error?.type ?? "-"}: ${(e.error?.message ?? "").slice(0, 200)} → ${what}`,
		)
	})
}
