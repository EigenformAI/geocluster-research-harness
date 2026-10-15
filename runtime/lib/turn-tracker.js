/**
 * What the broker observes on one conversation's ACP stream for RE-4 and the report export: the final answer of the
 * current turn, and the files the conversation has read.
 *
 * The answer (fork: the `attempt_completion` result). v2 has no completion tool, so the answer is the root's
 * `agent_message_chunk` text after the last ROOT `tool_call` of the turn: narration before a tool call ("Listing the
 * report files.") is dropped by the next `tool_call`. It is NOT reset on a new `messageId`: when a provider stream drops
 * mid-answer the engine retries with "Continue from where you left off" and the rest arrives under a new id
 * (measured on 2.0.19, s43/result-children.md Q8), so resetting there would keep only the tail. Child text never counts.
 *
 * The read ledger (fork: TaskState.readFilePaths, filled only by read_file after the read succeeded):
 *  - a read is an OpenCode `read` tool call: `kind:"read"` with title `read` (root) or `<child title>: read` (child).
 *    On 2.0.19 glob/grep are kind `search`, MCP tools `other`, subagent `think`, shell `execute`: none of them count
 *    (decision D2: a file seen through grep lines was not "read");
 *  - the path is only on the `in_progress` (and `failed`) update: the `tool_call` (pending) frame has `rawInput: {}` and
 *    the `completed` update has no kind, title or rawInput. So the path is remembered per call and committed when the
 *    call completes; a failed call (File not found, Permission denied, external_directory) drops it;
 *  - pending calls are keyed by (sessionId, toolCallId): root ids are bare provider ids (`call_2`, `toolu_…`) that can
 *    repeat (a fake or a provider restarting its counter each turn), child ids are `<childSessionId>:<id>`;
 *  - `rawInput.path` can be relative (`drill.csv`, `report/text/01_summary.md`): it is resolved against the cwd, so
 *    the set holds absolute paths like the fork's;
 *  - children count up to `maxChildDepth` (decision D1: the fork counted its in-process orchestrator, which is depth 1
 *    under a report-analysis root; 0 gives "root reads only").
 *  - a directory read completes and is added; harmless, a directory never equals a file citation.
 *
 * Lifetime: the conversation, across turns, like the fork's live Task. After a gateway restart the broker rebuilds it
 * by replaying its SessionLog: root `update` events through onUpdate(), `child` events through onChild(). A truncated
 * log can only cause extra false positives (one correction prompt), never a missed fabrication.
 *
 * No I/O, no timers. Feed it ENGINE frames only: a gateway-made chunk (an `Error:` text, a notice) must not reach
 * onUpdate(), or it becomes part of the answer.
 */
import path from "node:path"

const READ_TITLE = /(^|: )read$/
const isReadCall = (u) => u?.kind === "read" && typeof u.title === "string" && READ_TITLE.test(u.title)
/** `rawInput.path ?? locations[0].path` when it is a non-empty string, else null. */
const pathOf = (u) => {
	const p = u.rawInput?.path ?? u.locations?.[0]?.path
	return typeof p === "string" && p ? p : null
}
/** Session key of the root in the pending map; child keys are their `ses_…` ids, which are never empty. */
const ROOT_KEY = ""

export class TurnTracker {
	#cwd
	#maxChildDepth
	#answer = ""
	/** `${sessionKey}\0${toolCallId}` -> path (null while unknown), for read calls that haven't ended */
	#pending = new Map()
	#reads = new Set()
	#stats = { committed: 0, failed: 0, completedWithoutPath: 0 }

	/**
	 * @param {object} options
	 * @param {string} options.cwd Absolute session cwd (the workspace); relative read paths resolve against it.
	 * @param {number} [options.maxChildDepth=1] Child reads count up to this depth (0 = the root's reads only).
	 */
	constructor({ cwd, maxChildDepth = 1 } = {}) {
		if (typeof cwd !== "string" || !path.isAbsolute(cwd)) throw new TypeError("TurnTracker: cwd must be an absolute path")
		if (!Number.isInteger(maxChildDepth) || maxChildDepth < 0) throw new TypeError("TurnTracker: maxChildDepth must be an integer >= 0")
		this.#cwd = cwd
		this.#maxChildDepth = maxChildDepth
	}

	/** Call before every engine prompt, the correction prompt included. Resets the answer only; the reads stay. */
	beginTurn() {
		this.#answer = ""
	}

	/**
	 * One ROOT `session/update`: pass `params.update` (the `{sessionId, update}` params are accepted too).
	 * @param {object} update
	 */
	onUpdate(update) {
		const u = typeof update?.sessionUpdate === "string" ? update : update?.update
		switch (u?.sessionUpdate) {
			case "tool_call":
				this.#answer = ""
				this.#track(ROOT_KEY, u)
				break
			case "tool_call_update":
				this.#track(ROOT_KEY, u)
				break
			case "agent_message_chunk":
				if (u.content?.type === "text" && typeof u.content.text === "string") this.#answer += u.content.text
				break
			default:
			// thought chunks, usage, retry state, plans, user chunks: not part of the answer or the ledger
		}
	}

	/**
	 * One child event in the GATEWAY's frame shape (what the broker fans out as `_gc/child_update` and logs as kind
	 * `child`): `{child: {sessionId, parentSessionId, depth, title, toolCallId}, type: "status"|"update", status?,
	 * update?}`. Extra keys (seq, ts, kind, sessionId) are ignored. Status frames and children deeper than
	 * maxChildDepth are ignored.
	 * @param {object} frame
	 */
	onChild(frame) {
		if (frame?.type !== "update") return
		const child = frame.child
		const depth = child?.depth
		if (!Number.isInteger(depth) || depth < 1 || depth > this.#maxChildDepth) return
		if (typeof child.sessionId !== "string" || !child.sessionId) return
		const u = frame.update
		if (u?.sessionUpdate === "tool_call" || u?.sessionUpdate === "tool_call_update") this.#track(child.sessionId, u)
	}

	/** The root's answer text in the current turn (see the header). "" when the turn ended on a tool call. */
	answer() {
		return this.#answer
	}

	/** Absolute paths of the read calls that completed. The live set: don't mutate it. */
	get reads() {
		return this.#reads
	}

	/** Counters for logs: committed reads, failed reads, completed reads with no known path, reads still pending. */
	get stats() {
		return { ...this.#stats, pending: this.#pending.size }
	}

	#track(sessionKey, u) {
		const id = u.toolCallId
		if (typeof id !== "string" || !id) return
		const key = `${sessionKey}\0${id}`
		if (isReadCall(u)) {
			const p = pathOf(u)
			// A `tool_call` names a new call, so a stale path left by an earlier call with this id is dropped.
			if (p !== null || u.sessionUpdate === "tool_call" || !this.#pending.has(key)) this.#pending.set(key, p)
		} else if (u.sessionUpdate === "tool_call" || u.kind !== undefined) {
			// A different tool under a reused id: it is not a read, whatever an earlier call with this id was.
			this.#pending.delete(key)
			return
		}
		if (!this.#pending.has(key)) return
		if (u.status === "completed") {
			const p = this.#pending.get(key)
			this.#pending.delete(key)
			if (p === null) {
				this.#stats.completedWithoutPath++ // never seen on 2.0.19 (0 of every probe and live run)
				return
			}
			this.#reads.add(path.resolve(this.#cwd, p))
			this.#stats.committed++
		} else if (u.status === "failed") {
			this.#pending.delete(key)
			this.#stats.failed++
		}
	}
}
