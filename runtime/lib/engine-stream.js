/**
 * The byte stream between the gateway and `opencode acp`, as an ACP SDK Stream, with two inbound
 * renames applied before the SDK sees any frame.
 *
 * Why: SDK 0.13.1 validates `session/update` and `session/request_permission` with zod schemas
 * that predate OpenCode 2.0 (measured, s43/result-sdk.md):
 *   - every `usage_update` fails validation and is dropped (one console.error per turn);
 *   - `messageId` is stripped from message chunks (unknown keys are stripped, not kept);
 *   - a permission request whose shape drifts fails validation, the SDK answers -32602, and the
 *     engine treats that as a decline and cancels the turn without warning.
 * Methods the SDK doesn't know go to the client's extNotification/extMethod raw. So the shim
 * renames the two validated methods into that namespace:
 *   session/update             → _engine/session/update
 *   session/request_permission → _engine/session/request_permission, with the JSON-RPC id copied
 *                                into params._meta["gc/rpcId"] (other _meta keys kept)
 * Every engine frame then reaches the client untouched, and in wire order: the transform is
 * synchronous and the SDK starts each handler as soon as a frame is read. The id copy lets the
 * gateway match the engine's `$/cancel_request {requestId}` to the permission request it withdraws
 * (SDK handlers are never given the id). The SDK still owns ids, responses and outbound calls.
 *
 * Upgrading the SDK (1.x fixes the first two, but reorders ext notifications against session
 * updates) is a separate step.
 */
import { Readable, Writable } from "node:stream"
import { ndJsonStream } from "@agentclientprotocol/sdk"

export const ENGINE_UPDATE_METHOD = "_engine/session/update"
export const ENGINE_PERMISSION_METHOD = "_engine/session/request_permission"
/** The _meta key that carries the engine's JSON-RPC id of a permission request. */
export const RPC_ID_META = "gc/rpcId"

const RENAMES = new Map([
	["session/update", ENGINE_UPDATE_METHOD],
	["session/request_permission", ENGINE_PERMISSION_METHOD],
])

/** One inbound frame, rewritten (a new object) or returned as is. Exported for tests. */
export function rewriteInbound(message) {
	if (!message || typeof message !== "object" || Array.isArray(message) || typeof message.method !== "string") return message
	const renamed = RENAMES.get(message.method)
	if (!renamed) return message
	if (renamed !== ENGINE_PERMISSION_METHOD || !("id" in message)) return { ...message, method: renamed }
	const params = message.params && typeof message.params === "object" && !Array.isArray(message.params) ? message.params : {}
	const meta = params._meta && typeof params._meta === "object" && !Array.isArray(params._meta) ? params._meta : {}
	return { ...message, method: renamed, params: { ...params, _meta: { ...meta, [RPC_ID_META]: message.id } } }
}

const isWebWritable = (s) => typeof s?.getWriter === "function"
const isWebReadable = (s) => typeof s?.getReader === "function"

/**
 * @param stdin  the engine's stdin (Node Writable or WritableStream): what the gateway writes
 * @param stdout the engine's stdout (Node Readable or ReadableStream): what the gateway reads
 * @returns {{readable: ReadableStream, writable: WritableStream}} for `new ClientSideConnection(…, stream)`
 */
export function engineStream(stdin, stdout) {
	const output = isWebWritable(stdin) ? stdin : Writable.toWeb(stdin)
	const input = isWebReadable(stdout) ? stdout : Readable.toWeb(stdout)
	const base = ndJsonStream(output, input)
	const readable = base.readable.pipeThrough(
		new TransformStream({
			transform(message, controller) {
				controller.enqueue(rewriteInbound(message))
			},
		}),
	)
	return { readable, writable: base.writable }
}
