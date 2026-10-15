# Managed upload status

With `FILES_SYNC_ADAPTER=true`, cloud delivery runs without a browser connection.
Download and backend request duration determine the cycle's elapsed time.
`RUNTIME_FILE_WORK_POLL_MS` defaults to a 5,000 ms delay after the cycle finishes;
it is not a five-second delivery deadline.

Each pass accepts up to `RUNTIME_FILE_WORK_MAX_CLAIM_PAGES` pages, default 100.
The cap lets local synchronization proceed under continuous intake. Raise it for
larger backlogs, or set it to zero to disable it. A response containing only work
already attempted in this cycle also ends the pass. Updated claims remain stored
for the next cycle. Lost claim responses reuse the same persisted request ID.

## Delivery and processing states

The backend projects acknowledged delivery as `delivery_state: available` when
the delivered source remains the current cloud head. A changed head can instead
produce `superseded`. Readable bytes alone do not authorize an acknowledgement;
the runtime still verifies the source and obtains publication authority.

Automatic processing admission accompanies each file's publication:

- `ticket` identifies an admitted runtime processing job.
- `awaiting-capacity` retains the exact source until a ticket can be admitted.
- `skipped` records the backend-authorized policy or supported skip reason.

Admission does not wait for other jobs to finish. The processing coordinator
wakes after each publication. Ticket admission is distinct from processor
execution: a processor can report `queued`, `running`, `cancelling`, or a terminal
state. The runtime reports actual observations and does not infer execution from
readability. No processor-start deadline is established. A final observation pass
reports acknowledged ticket changes seen during the cycle. Delivery failures and
capacity requests retry on later cycles with their stored identities.

## File events and background lifetime

Delivery and cloud-head hydration use the shared workspace publication path.
Both emit scoped `invalidation` events on `GET /files/watch`, with the workspace
identity and changed paths. Subscribers can re-list files without reloading the
page. File invalidations do not carry authoritative upload-record state.

Fly proxy autostop is disabled. The application backend's lifecycle reconciler
uses desired runtime state and durable delivery or execution interest. The
activity receiver reports state; it does not stop, resume, or extend a runtime.
Closing a browser tab does not stop delivery or processing under this contract.
An explicit stop or infrastructure failure remains a separate lifecycle event.

## Browser integration requirement

The browser reads upload records from the application backend. Runtime file
events do not reach a project card without a runtime connection and do not
replace those records. To show backend upload-record changes within five seconds,
the application must poll its existing upload-record endpoint at that interval
or provide a backend status-change channel.
