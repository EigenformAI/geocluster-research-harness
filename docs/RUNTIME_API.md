# Connect a conversation client

The runtime exposes ACP JSON-RPC through `/agent` and project files through HTTP.
Your application backend provisions a project runtime and issues its access token.
This guide covers the managed headless frontend, not the native TUI. Native users
connect providers through `/connect` and select models through `/models`; native
startup exposes no browser gateway. Use the
[ACP specification](https://agentclientprotocol.com) for standard message schemas.

## Authenticate to the project

Exchange the backend-issued token at `POST /auth/exchange`:

```js
await fetch(`${runtimeUrl}/auth/exchange`, {
	method: "POST",
	credentials: "include",
	headers: { "Content-Type": "application/json" },
	body: JSON.stringify({ token: authToken }),
});
```

Success returns 204 and an HttpOnly project cookie. Use `credentials:"include"`
for file and status fetches and `withCredentials:true` for EventSource.
WebSocket uses the applicable browser cookie automatically.

On an expired or consumed exchange token, obtain a fresh token from your backend.
On an authenticated HTTP 401, exchange again. A network error or 5xx can mean the
machine is starting or unavailable; retry with backoff instead of repeatedly
exchanging tokens. Probe authenticated `/session/info` to distinguish these cases
after a failed WebSocket connection.

Configure `RUNTIME_ALLOWED_ORIGINS` for your client origin. That setting replaces
the default origin list. Configure `RUNTIME_FRAME_ANCESTORS` separately if you
embed file previews. Cross-site cookie delivery depends on browser policy;
prefer credentialed fetch for previews where direct image or download URLs lose
their cookie.

Use `POST /auth/logout` to clear the cookie. Close reconnecting sockets,
EventSources, and polling when stopping or leaving the runtime. Requests can
autostart a stopped machine.

## Check readiness and open ACP

Poll `/readyz` without credentials and decide readiness from HTTP status.
Its body can differ while services start. Engine readiness does not imply
MCP connectivity, completed dataset hydration, file readiness, or model access.
Use authenticated `/files/info` for the independent file service.

Open a WebSocket with subprotocol `acp.jsonrpc.v1`. Send one JSON-RPC object per
text frame. Do not batch messages or use newline-delimited framing. Advertise no
client filesystem or terminal capabilities; execution happens on the runtime.

Call `initialize` first on every socket:

```json
{
	"jsonrpc": "2.0",
	"id": 1,
	"method": "initialize",
	"params": {"protocolVersion": 1, "clientCapabilities": {}}
}
```

Check `agentCapabilities._meta.api` and advertised extensions before relying on
runtime-specific behavior. The current gateway advertises API 3. Treat session
IDs as opaque strings.

For backend-relayed connections, bind the transport to the current workspace ID
and epoch. On `workspace_changed`, reconnect through your backend. Stale epoch
closure detaches delivery; it does not cancel already accepted work.

## Create and configure a conversation

Call `session/new` with `cwd:""`, `mcpServers:[]`, and optional
`_meta.agentMode`. Choose `geology`, `report-analysis`, or `standard`.
The mode is fixed for that conversation. Use the returned `sessionId` and
`_meta.runDir`; do not reconstruct paths from another identity.

Render the returned model and effort `configOptions`. Use the exact advertised
choice values. Select the model before setting effort: changing models resets
effort to the configured default when available. Resume and same-model selection
preserve supported explicit effort choices. Restoration resets an unsupported
saved effort to supplier `default`, persists the correction, and emits an
informational `_gc/notice` with `kind: "effort_reset"`. The selected model and
conversation history are preserved. Models without an effort selector also clear
unsupported saved efforts without adding a selector.

The engine records the reset in `session_info_update._meta["geocluster/effort-reset"]`
with `modelId`, `previousEffort`, and `effort: "default"`. Replaying this historical
update does not repeat the live notice. Restoration makes no supplier request.
If saving the correction fails, resume or load returns an error with
`data.errorName: "configuration.reconciliation"`; retry restoration explicitly.

`models.availableModels` and model `configOptions` contain installed declarations
filtered by backend eligibility. Read names, capabilities, limits, and efforts
from discovery and returned choices, not a runtime-wide model table. The backend
owns plan membership and request admission. Model option values add `proxy/` to
the bare supplier ID. Split a qualified reference at its first slash; the bare ID
can contain further slashes.

For example, if the returned options advertise these exact values:

```json
{"jsonrpc":"2.0","id":3,"method":"session/set_config_option","params":{"sessionId":"<returned-session-id>","configId":"model","value":"proxy/maker/example-model"}}
{"jsonrpc":"2.0","id":4,"method":"session/set_config_option","params":{"sessionId":"<returned-session-id>","configId":"effort","value":"high"}}
```

An effort of `default` leaves supplier effort unspecified. Models without
qualified variants use supplier defaults and have no effort selector. A model's
presence does not establish image capability or extraction compatibility.

Refresh account eligibility through `_gc/status`. Inspect authenticated gateway
`modelDiscovery` status: `state` is `fresh`, `stale`, or `unavailable`, alongside
`schemaVersion`, `installedCatalogDigest`, and `catalogRestartRequired`.
Managed discovery requires `/account` schema version 2 with `managed_models`,
`allowed_model_ids`, and nullable `default_model_id`. Version 1 and unknown
versions report `managed_discovery_schema_unsupported`.

Declarations stay immutable for the engine lifetime. Newly advertised IDs and
changed execution metadata set `catalogRestartRequired`; an operator must request
a drained container restart to install them. Refresh does not restart active
turns, change selected models, or reload the catalog. No image rebuild is needed.

Fresh empty eligibility offers no models. During an outage, the picker retains
its last successful same-identity snapshot and labels it stale. A cold outage
offers no models. Retained validated declarations can supply stale execution
metadata, never current permission: the backend still authorizes each request.
A null startup default leaves model sessions unavailable without inventing a
fallback. Independent file services can remain usable.

An unavailable restored model remains in history. Present its unavailable state
and require explicit selection when the installed engine cannot resolve it.
A null current model does not mean a replacement was silently selected. Never
automatically replay a denied turn or replace the user's saved model.

Use `session/list` for conversation history. Dedupe pages by session ID and
refresh the first page after activity; updates can reorder the list during
paging. Show `archived:true` conversations read-only.

## Submit and cancel a turn

Assign a stable `_meta.submissionId` to each intended prompt:

```json
{
	"jsonrpc": "2.0",
	"id": 2,
	"method": "session/prompt",
	"params": {
		"sessionId": "<returned-session-id>",
		"prompt": [{"type": "text", "text": "Check the drilling inputs."}],
		"_meta": {"submissionId": "drilling-check-1"}
	}
}
```

Reuse that ID only after a lost send outcome. A retained completed ID returns
its recorded result, including a failed result, without another prompt. A
deliberate continuation needs a new ID. Idempotency has bounded retention and
does not guarantee recovery of a turn cut off by a gateway crash.

Observe `_gc/turn_end` to finish the UI turn. It reaches attached observers before
the prompt response, which only reaches the submitting socket. Route events by
`params.sessionId`; one socket can follow several conversations.

Send `session/cancel` as a notification, without a JSON-RPC `id`. Include the
running submission ID to avoid cancelling a newer turn from a stale button.
Disconnecting the browser does not cancel work. Cancellation stops the
conversation's engine-owned processes, including background jobs from earlier
turns. An already running shared MCP thread can still finish and write output.

For attachments, use a percent-encoded `file://` resource link to a regular file
inside the workspace. Respect the configured attachment size limit. Mention a
large dataset's path rather than embedding its complete content. A model catalog's
image declaration does not establish working image transport through your proxy.

## Render updates and edit approval

Merge tool fields by `toolCallId`; later frames often omit earlier input,
locations, or titles. Append text in sequence order. Use `messageId` to group
chunks, but do not assume a changed message ID starts a separate final answer:
provider retries can split one response.

Keep `_gc/child_update` attached to its root conversation. Link the child to
its spawning card using `child.toolCallId`. Handle `relinked:true` corrections
without treating them as lifecycle changes. A resumed child can become running
again with the same identity and title.

Missing child activity is not proof of completion or inactivity. The
`geocluster/child-observation` incomplete marker describes an observation gap,
not execution failure. Replay contains captured root-log activity, not a complete
independent engine history. Exclude hidden reasoning from customer-visible output.

Support `session/request_permission`. Writing agents ask for ordinary workspace
saves outside their automatic-output folder. Geology and report analysis delegate
saves. Protected runtime paths and other conversations' folders cannot be
approved.

Respond with an offered selected option to approve or reject the tool.
`outcome:"cancelled"` cancels the whole turn; it is not a dialog-dismiss action.
The first answer from any tab wins. Close other dialogs on
`_gc/permission_resolved`. Open dialogs from actual requests, not both requests
and the pending-permission summary.

If you use `@agentclientprotocol/sdk`, verify that it preserves runtime updates
and wire ordering. Version 0.13.1 drops `usage_update` and strips `messageId`.
Version 1.5.1 preserves those fields but can deliver `_gc/*` handlers after later
wire messages. A raw-frame client or tap must preserve ordering across updates,
notifications, permission requests, and responses.

## Reconnect without repeating work

1. Initialize the replacement socket.
2. Call `_gc/attach` once for each displayed conversation with its highest
   received `seq` as `afterSeq`.
3. Apply replay and live frames in their delivered order.
4. Use the attach response's `turn` and pending permissions to restore controls.

Root updates, child updates, and turn ends share one sequence per conversation.
Gaps are valid. Dedupe repeated frames by sequence. `truncated:true` indicates
missing retained history. If `lastSeq` is below your cursor, attach from zero and
rebuild the view.

`session/load` replays the full transcript but does not return authoritative turn
state. Follow it with attach. After a gateway restart, use `session/resume` when
needed to restore model choices. If attach says idle, do not leave the UI running
because its last recorded tool was in progress. A new user message after an
unclosed recorded turn marks that earlier turn interrupted.

## Recover model access and interpret outcomes

Handle `-32001` as conversation busy, `-32003` as engine or workspace admission
unavailable, and `-32005` as machine capacity. Wait, reconnect, or cancel according
to the returned details. `-32006` is read-only history. `-32007` carries an account
restriction in `data.usageDenial`.

Managed model refusals produce `reason:"paused_for_usage"` and `usageDenial` on
the turn outcome. Show the supplied recovery action. Restored service or account
access does not replay a prompt. Continuation is an explicit new submission,
not a checkpointed workflow resume guarantee. Account inactivity requires account
access recovery; it is not a temporary balance error.

Read `timeoutPolicy` rather than assuming one workflow deadline. Browser detach,
model transport, explicit shell timeout, MCP observation, cancellation, and machine
shutdown are different boundaries. The turn-age notice is advisory and does not
cancel live conversation work. Activity reporting is not a guarantee against a
machine stop.

Use context occupancy for the context gauge. Runtime `usage_update.cost` does
not measure supplier spend; use your backend's account ledger for usage.

Open reports only when `_gc/turn_end._meta.report` supplies a path. Markdown
export can precede document and PDF conversion. Failed or citation-flagged turns
can have no report. Report analysis checks citations after text streams and can
request one correction; the unsupported first answer can remain visible.
