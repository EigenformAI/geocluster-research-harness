/**
 * One browser WebSocket = one ACP AgentSideConnection whose "agent" is the SessionBroker.
 *
 * The wire is plain ACP JSON-RPC (one message per text frame). Standard methods are forwarded;
 * `_gc/*` extension methods carry what ACP has no standard for (attach with replay, status).
 * api 3 has no session/set_mode for the browser (the agent is chosen at session/new), so the SDK
 * answers it -32601; session/set_config_option changes the model or effort.
 */
import { AgentSideConnection, RequestError } from "@agentclientprotocol/sdk"
import { webSocketStream } from "./ws-stream.js"

export const SUBPROTOCOL = "acp.jsonrpc.v1"

export function attachSocket(socket, broker, logger, { beforeMessage } = {}) {
	// Includes JSON-RPC responses: a permission answer must be checked before the SDK resolves it.
	const stream = webSocketStream(socket, logger, { beforeMessage })
	const port = {
		attached: new Set(),
		replaying: new Map(), // sessionId -> events queued while this socket is replayed that conversation (API-06)
		conn: null,
		sessionUpdate: (params) => port.conn.sessionUpdate(params),
		requestPermission: (params) => port.conn.requestPermission(params),
		extNotification: (method, params) => port.conn.extNotification(method, params),
	}

	const agent = {
		initialize: (params) => broker.initialize(params),
		newSession: (params) => broker.newSession(params, port),
		loadSession: (params) => broker.loadSession(params, port),
		unstable_resumeSession: (params) => broker.resumeSession(params, port),
		unstable_listSessions: (params) => broker.listSessions(params),
		prompt: (params) => broker.prompt(params, port),
		cancel: (params) => broker.cancel(params),
		unstable_setSessionModel: (params) => broker.setSessionModel(params),
		unstable_setSessionConfigOption: (params) => broker.setSessionConfigOption(params),
		// Authentication is the gate's job (cookie); the agent never needs its own.
		authenticate: async () => ({}),
		extMethod: async (method, params) => {
			switch (method) {
				case "_gc/attach":
					return broker.attach(params ?? {}, port)
				case "_gc/status":
					return broker.browserStatus()
				default:
					throw RequestError.methodNotFound(method)
			}
		},
		extNotification: async (method) => {
			logger.warn("ignoring unknown notification", method)
		},
	}

	port.conn = new AgentSideConnection(() => agent, stream)
	broker.addPort(port)
	logger.info("socket attached", { sockets: broker.ports.size })

	socket.on("close", () => {
		broker.removePort(port)
		logger.info("socket detached", { sockets: broker.ports.size })
	})
	return port
}
