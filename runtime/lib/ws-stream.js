/**
 * Adapts a `ws` WebSocket to the ACP SDK's Stream (one JSON-RPC message per text frame).
 *
 * The frame is the delimiter, so no NDJSON framing is needed on the wire. Malformed frames are
 * answered with a JSON-RPC parse error and otherwise ignored.
 */
export function webSocketStream(socket, logger, { beforeMessage } = {}) {
	let controllerRef = null
	let stopped = false, checking = false, queuedBytes = 0
	const queue = []
	const maxQueuedBytes = 16 * 1024 * 1024
	const finish = () => {
		stopped = true; queue.length = 0; queuedBytes = 0
		try { controllerRef?.close() } catch { /* already closed */ }
	}
	const deny = (message, error) => {
		finish()
		const reason = error.error || "workspace_fence_unavailable"
		logger?.warn("ACP epoch fence rejected", { error: reason, action: "Reconnect to the current workspace." })
		// A request gets its original locator. Responses (permission answers) are dropped, never translated.
		if (typeof message?.method === "string" && Object.hasOwn(message, "id")) socket.send(JSON.stringify({ jsonrpc: "2.0", id: message.id, error: { code: -32003, message: `${reason}: reconnect to the current workspace`, data: { error: reason, state: reason, agent: "workspace-relay", tool: "acp-dispatch", action: "Reconnect to the current workspace." } } }))
		socket.resume() // The peer must be able to complete its close handshake after read admission stops.
		socket.close(1008, reason)
		const timer = setTimeout(() => socket.terminate(), 1000)
		timer.unref(); socket.once("close", () => clearTimeout(timer))
	}
	const drain = async () => {
		if (checking || stopped || !controllerRef) return
		checking = true
		try {
			while (queue.length && !stopped && controllerRef.desiredSize > 0) {
				const { message, bytes } = queue.shift()
				try { await beforeMessage(message) } catch (error) { if (!stopped) deny(message, error); return }
				if (stopped || socket.readyState !== socket.OPEN) return
				queuedBytes -= bytes
				controllerRef.enqueue(message)
			}
		} finally {
			checking = false
			if (!stopped && controllerRef.desiredSize > 0) {
				if (queue.length) void drain()
				else socket.resume()
			}
		}
	}

	const readable = new ReadableStream({
		start(controller) {
			controllerRef = controller
			socket.on("message", (data, isBinary) => {
				if (isBinary || stopped) return
				let message
				try {
					message = JSON.parse(data.toString("utf8"))
				} catch {
					socket.send(JSON.stringify({ jsonrpc: "2.0", id: null, error: { code: -32700, message: "Parse error" } }))
					return
				}
				if (message && typeof message === "object") {
					if (!beforeMessage) { controller.enqueue(message); return }
					// Pause TCP reads during verification. Already decoded frames from one read remain bounded.
					socket.pause()
					queuedBytes += data.length
					if (queuedBytes > maxQueuedBytes) { deny(message, { error: "workspace_fence_queue_limit" }); return }
					queue.push({ message, bytes: data.length })
					void drain()
				}
			})
			socket.once("close", finish)
			socket.once("error", (error) => {
				logger?.warn("socket error", String(error?.message ?? error))
				finish()
			})
		},
		pull() { if (beforeMessage) return drain() },
		cancel() {
			socket.close()
		},
	})

	const writable = new WritableStream({
		write(message) {
			if (socket.readyState !== socket.OPEN) return
			return new Promise((resolve) => socket.send(JSON.stringify(message), () => resolve()))
		},
		close() {
			socket.close()
		},
	})

	return { readable, writable, close: () => controllerRef && socket.close() }
}
