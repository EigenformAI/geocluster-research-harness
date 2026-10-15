# Work with workspace files

Authenticate through the runtime gate before calling `/files/*`. Use
`GET /files/info` for readiness, workspace identity, provider availability, and
effective limits. File access does not require the conversation engine to be ready.

Use authenticated `GET /files/openapi.json` for endpoint and field definitions.
The schema is generated from the same route metadata as HTTP dispatch. For
offline tooling, generate it from the repository root:

```sh
node --input-type=module -e 'import { buildFilesOpenApi } from "./runtime/lib/files-openapi.js"; console.log(JSON.stringify(buildFilesOpenApi(), null, 2))'
```

Use [document processing](DOCUMENT_PROCESSING.md) for extraction and the
[map guide](MAP_WORKSPACE_API.md) for spatial preparations.

## Select live or retained bytes

For browsing, list a directory and inspect `coverage` before claiming a complete
inventory. Follow `nextCursor` within the same query. If a cursor expires, restart
that query. Metadata pages freeze metadata, not the file bytes.

For a live download, call `/files/raw?path=...`. For an editor buffer, check
`complete` on the text response. A bounded prefix is not a complete file.

For multi-request reads or source-bound work:

1. Read `/files/stat?path=...` and retain its `observation.token`.
2. Submit `/files/captures` with a new `requestId`, the path, and that
   `baseObservation`.
3. If the response is asynchronous, follow its job to a complete source.
4. Use the returned capture URLs and source identity for subsequent reads.
5. Renew the source lease while your client uses it.

A changed observation requires inspecting the new source before submitting a new
intent. A capture keeps its bytes after path replacement; it does not promise
those bytes are still current. A preview fragment retains only an excerpt and
cannot substitute for a complete captured source.

If your work requires a coherent source, set `requireCoherentSource:true`.
A checked copy alone does not prove one instantaneous version under arbitrary
writers. If coherent capture is unavailable, choose explicitly whether the
reported capture strategy is acceptable.

Use strong capture validators for exact range identity. Live ETags are weak stat
observations, not content hashes. They cannot satisfy strong listed `If-Match`
conditions. Multiple ranges from a live path can read different versions.

## Save with an explicit overwrite policy

For a new file, upload raw bytes with create intent:

```sh
curl --cookie "$COOKIE_JAR" --request PUT \
	--header 'X-GC-Process-Document: skip' \
	--data-binary @notes.md \
	"$RUNTIME_URL/files/upload?path=notes.md&operationId=notes-create-1&mode=create"
```

For an editor save, read the current observation first and submit
`mode=replace` with `X-GC-Base-Observation`. On `source_changed`, show the conflict
and inspect current bytes. Use `force-replace` only for an explicit unconditional
replacement decision.

Supply `X-Content-SHA256` when the intent must bind your exact upload bytes.
Use `X-GC-Process-Document: skip` for editor and internal saves that must not
start automatic document processing.

Give each intended mutation a stable `operationId`. After a lost response, query
`/files/operations/{operationId}` rather than creating another effect under a new
ID. The first accepted upload body belongs to that operation. A duplicate does
not compare or republish a second client buffer.

Treat local commit, processing admission, and remote persistence as separate
outcomes. An upload can succeed while extraction is skipped or remote persistence
is blocked. Inspect each outcome independently.

## Recover uncertain or deleted work

For capture and preparation submissions, retain the `requestId`. Query
`/files/requests/{requestId}` after an unknown outcome. Reuse it only for the same
intent. Use a new ID for a deliberate new attempt.

If an operation is indeterminate, inspect its retained receipt and recovery
action. Do not blindly replay namespace changes. Closing an HTTP connection
does not cancel an accepted durable job; use its cancellation route and observe
the resulting state.

Use `/files/recovery` to find retained deletions or displaced remote-replacement
bytes. Restore to an absent destination. A deleted-entry restore consumes its
trash record; a remote-replacement restore copies retained bytes. Retry an
uncertain restore with its original operation ID.

Renew leases before expiry while using captured products. A saved map recipe is
not an indefinite retention hold. If a source becomes unavailable, ask the user
to select and capture a source again; never silently substitute current-path bytes.

## Refresh after change events

Open `/files/watch` with credentials. Treat events as invalidation hints and
refresh affected metadata. After a reset, restart, or replay gap, obtain a fresh
list and stat observations. File events are not a remote persistence journal.

Keep captured selections bound to their captured bytes while live metadata
changes. File-service conditional writes serialize managed writers, not arbitrary
shell processes. Another writer can still change live files during a read.
