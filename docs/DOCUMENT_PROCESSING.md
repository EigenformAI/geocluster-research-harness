# Process documents

Document processing extracts PDF, CSV, TSV, XLSX, and XLSM sources into retained,
source-linked results. It does not clean tables or replace originals. Configure
the [processing deployment](RUNTIME_FILES_DEPLOYMENT.md#document-processing-enablement)
before enabling admission; the default is disabled.

This guide describes managed headless processing through the file API. It requires
backend discovery, a root-held machine relay, and explicit processor configuration.
For optional terminal processing with native OpenCode connections and an
independently selected model, use [native document processing](NATIVE_DOCUMENT_PROCESSING.md).
The two paths have separate job history and admission. The full image still needs
the processor source at build time even when extraction is disabled. Building an
image does not enable processing admission.

Use the project's runtime cookie. All members with runtime access can read and
cancel project jobs. Read request and result schemas from `/files/openapi.json`.
Check `/files/processing/capabilities` for admission, dependency observations,
limits, and backlog before offering processing.

## Choose upload processing policy

Eligible uploads use automatic processing when enabled. To opt out for a single
upload, send `X-GC-Process-Document: skip`:

```sh
curl --cookie "$COOKIE_JAR" --request PUT \
	--header 'X-GC-Process-Document: skip' \
	--data-binary @report.pdf \
	"$RUNTIME_URL/files/upload?path=reports/report.pdf&operationId=report-upload-1"
```

The upload receipt records its admission decision. Follow `processing.statusUrl`
for current status rather than treating the receipt as live extraction state.
Distinguish upload failure from successful upload with skipped or failed processing.

An upload can fit the file-service limit but exceed the processing limit.
Capacity or format skips do not reject an otherwise valid upload. An admitted
ticket can remain pending while the processor is unavailable.

Use `skip` for editor and internal saves that must not start extraction.
Opt-out does not cancel earlier jobs or prevent manual processing later.

## Submit an explicit source

Send a fresh UUID `requestId` to `POST /files/processing/jobs`. Choose one source:

- For a workspace file, supply its path and the current `baseObservation` from
  `/files/stat`.
- For a retained capture, supply its complete capture ID.
- For an upload, supply its committed upload operation ID.

For example, process the original bytes of a skipped upload:

```json
{
	"requestId": "3548179d-27ee-48f8-9430-e58d5f0c6fe3",
	"source": {"kind": "upload-operation", "operationId": "report-upload-1"}
}
```

Check the upload's `sourceRetention.availabilityUrl` first if its receipt hold
has expired. If the original capture is unavailable, explicitly select the
current file or upload the original again. The runtime does not substitute newer
path bytes for an earlier upload.

An upload-operation request with default options reuses an existing automatic
ticket, even if terminal. To run extraction again, use a fresh UUID and `rerunOf`
for the previous runtime processing job. If its retained processor snapshot is
unavailable, select a new explicit source.

If your work requires a coherent snapshot, set `requireCoherentSource:true`.
Inspect the returned source consistency rather than assuming a checked copy is
instantaneously coherent under arbitrary writers.

PDF processing can use image-model calls and project usage without a manual
override. `tableRecovery.vision:"off"` disables table recovery vision, not every
PDF model task. Native CSV, TSV, and workbook extraction make no model calls,
but the service still requires its engine to be ready.

The extraction model can differ from the conversation model. The backend supplies
managed declarations and authorizes every extraction request. Default image
extraction requires a qualified image-capable declaration. A trusted custom
text-only extraction configuration remains limited by its operation contract;
catalog presence alone does not establish compatibility. Revocation does not
reroute denied work automatically or authorize a restored job from old metadata.

## Observe status and recover

Retain the returned runtime job ID and follow its status URL. Delivery, extraction,
private publication, and cleanup are separate outcomes. Successful extraction
can coexist with pending private publication. Existing sealed results can remain
readable during publication recovery.

After a lost acknowledgement, retry the same request ID and intent. A failed,
cancelled, or interrupted request does not restart under that ID. Use a new ID
only for a deliberate new extraction attempt.

To cancel, call the runtime job's cancellation route and wait for observed
settlement. `cancelling` is not proof of cancellation. A completed result can win
if cancellation arrives too late. A timeout or empty upstream lookup does not
establish that dispatched work stopped.

Browser disconnection does not cancel accepted work. After a service restart,
an interrupted extraction needs an explicit new attempt. Disabling admission
preserves accepted jobs and their source evidence.

## Read and retain results

Fetch the job's results and follow manifest-listed product and table URLs.
Associate results with the accepted source identity and hash, not its pathname
alone. Rename, deletion, or replacement of that path does not change the result.

Use typed rows or typed JSONL for cell meaning. CSV and TSV cells preserve text
lexemes. Workbook formulas retain expressions and cached values without execution;
header rows are not inferred or removed. CSV downloads preserve formulas rather
than sanitizing them for spreadsheet applications.

Follow row pagination until `nextOffset` is null. Byte budgets can return fewer
rows than requested. Inspect coverage and partial-extraction findings before
claiming a complete result.

Snapshots and sealed results persist for the processor data-root lifetime.
There is no automatic result pruning or public result-deletion route. Monitor
storage and preserve the retained volume. A local result is not proof of cloud
persistence. Fresh storage observations are not proof that accounting is complete
or that concurrent workload headroom has been measured.
