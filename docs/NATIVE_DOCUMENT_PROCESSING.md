# Process documents in the terminal

Native document processing uses your OpenCode connections. Choose its model
separately from the conversation model. You do not need a GeoCluster model proxy,
machine token, or backend activity endpoint.

## Connect the providers

Start the native runtime with your usual workspace options:

```sh
./scripts/run-runtime-tui.sh --image geocluster-runtime:local
```

Run `/connect` for each provider you want to use. Run `/models` to select the
conversation model. Connections persist in this retained container workspace.
Host OpenCode accounts are not imported automatically.

For a custom processing provider, put its declaration in ordinary native user
configuration. A declaration present only in the conversation's project is not
automatically copied into the extraction context. The writable native XDG config
root is `/workspace/.runtime/native/opencode/config`.

## Enable processing

Exit the TUI, then restart with an explicit processing model:

```sh
./scripts/run-runtime-tui.sh --image geocluster-runtime:local \
	--processing-model 'provider/vision-model#high'
```

Replace the reference with an available model. Omit `#high` when you do not want
a variant. Model IDs can contain additional slashes. Reuse the same workspace
options on every start.

The runtime attaches the TUI and processor to one owned OpenCode server. OpenCode
keeps the provider accounts. The processor receives a private server connection,
not a copied provider key or a second credential database.

`/models` changes the conversation selection, not the processing selection.
Changing the processing model requires an explicit restart. Processing does not
fall back to another model, provider, or account. PDF extraction normally needs
image input. Model availability is not proof that authentication or inference
will succeed. Startup does not perform paid inference.

Without `--processing-model`, the launcher does not start the processor.

## Submit and inspect a document

Place the source in the project directory, as you would for other native file
analysis. Then ask:

> Process survey.pdf as a retained extraction job. Show its progress, then read
> the extracted text and tables. Identify incomplete coverage and cite the source
> pages.

Geology routes processing through the Orchestrator and DataOps. Standard mode can
use processing tools directly. Report Analysis stays read-only and delegates new
processing work. Ordinary PDF reads extract bounded existing text. They do not
replace OCR or create retained extraction jobs.

Keep the returned `requestId` and `jobId`. The runtime allocates the request ID
before dispatch. You do not need to generate a UUID. Recover an uncertain request
with its existing handle rather than submitting the document again. A deliberate
new submission creates separate work, even for identical bytes. Cancellation can
remain pending until the owning processor settles admission or execution.

Job history is shared across the workspace. Model request recovery is limited to
the same root conversation and its specialists. The native operator can inspect
and recover requests from either chat or the CLI. Native job reads and cancellation
by job ID remain workspace-wide. Receipt scoping does not make jobs private to a
conversation. Results live in private retained
processor storage, not automatically beside the source. Use processing tools to
read them.

Ask for a sealed-product export when you need an ordinary file. The runtime
verifies its SHA-256 and byte count without asking the model to reconstruct CSV.
Model exports accept only a basename under `runs/<root-session-id>/results/`.
An outside destination returns `DESTINATION_REQUIRES_APPROVAL` without writing.
Use the CLI for an explicit ordinary destination. Rewriting a table with ordinary
file tools is not a byte-preserving product export.

Results bind the captured source bytes, model, and extraction profile. A current
file with the same pathname is not proof that its bytes match an older result.
Check coverage and findings before relying on a partial extraction.

Native citation tokens identify an extracted artifact and byte or row range. The
native TUI does not run the managed gateway's citation-access check. A token is
not proof that the model read that range or interpreted it correctly. Review the
returned source pages and retained content before using a report.

## Process a document without chat

Keep the processing-enabled TUI running. In another terminal, select the same
workspace and project options used by the launcher:

```sh
./scripts/process-document.sh submit survey.pdf --wait
./scripts/process-document.sh list
./scripts/process-document.sh status --request REQUEST_ID
./scripts/process-document.sh wait --job JOB_ID --timeout 300
./scripts/process-document.sh result --job JOB_ID --json
./scripts/process-document.sh result --job JOB_ID --full-manifest --json
./scripts/process-document.sh export --job JOB_ID --product PRODUCT_ID --out tables.csv
```

The wrapper attaches to exactly one matching running container. It never starts
a container, selects a model, connects an account, or opens processor storage.
For a nondefault workspace, put `--workspace-root DIRECTORY` or
`--workspace-volume NAME`, then `--project ID`, before the command. Add
`--container ID` to disambiguate matching containers. Source and output paths are
relative to the selected container's project directory, not your host shell.

Result summaries retain quality fields and provide inventory pagination. Use
`--full-manifest` for the unpaged manifest. Bridge JSON responses have a 2 MiB
ceiling; larger responses fail explicitly rather than truncate. Sealed-product
exports stream bytes separately and are not limited by that JSON ceiling.

Discovery and recovery require a live, ready native processing owner. During a
processor outage, restore the dependency and restart with the same retained
workspace before using history or recovery. Receipts remain retained, but this
CLI does not provide offline access to their private files.

The CLI prints a prepared receipt before dispatch. If observation stops, recover
the same request:

```sh
./scripts/process-document.sh submit --request REQUEST_ID
./scripts/process-document.sh cancel --request REQUEST_ID
```

Ctrl-C stops observation, not extraction. Use `cancel` explicitly to request
execution cancellation. A pending cancellation is not proof of supplier-side
cancellation or zero charges. Restart with the same retained workspace to recover
requests. A replacement processor store cannot replay requests from the old store.

Exports are create-only unless you pass `--overwrite`. Recovery verifies an
existing export's bytes and never republishes it automatically after interruption.
Use a new explicit export decision for changed destinations or files.

Handle these command exit statuses in scripts, especially with `set -e`:

- `0`: the operation succeeded. An accepted submission is not completed extraction.
- `1`: invalid input, operational failure, or failed, cancelled, or interrupted extraction.
- `2`: `wait` or `submit --wait` observed terminal partial extraction.
- `3`: observation ended pending, or dispatch or cancellation remains unresolved.

A verified export exits `0` even for a partial job. Its output still reports job
quality separately from the export outcome. Status, history, and available result
reads also succeed independently of extraction quality.

## Stop and recover

Finish or cancel pending work before exiting. On exit, the runtime stops processing
before its owned OpenCode server. An unexpected processor failure ends a
processing-enabled TUI connection with a nonzero status. It does not erase
conversation history, accounts, accepted jobs, or results.

Restart with the same workspace and processing options to reconcile retained
ownership evidence. Uncertain inference is not automatically replayed. A blocked
recovery needs inspection of private lifecycle logs and retained ownership state.
Do not delete unresolved state to make startup pass. Local cancellation does not
prove supplier-side cancellation, deletion, refunds, or zero charges.

The ordinary session picker defaults to the current project. **All projects** can
show live or unsettled extraction sessions for deliberate inspection.

## Use another compatible extraction engine

Supply an owner-generated descriptor when you deliberately want another harness:

```sh
./scripts/run-runtime-tui.sh --image geocluster-runtime:local \
	--processing-model 'another-provider/vision-model' \
	--processing-engine-descriptor /private/extraction-engine.json
```

The descriptor must be a bounded regular JSON file, not a symlink or FIFO. Its
owner must provide a verified extraction context, engine identity, authentication,
and recovery evidence. The endpoint must be reachable from the container. Plain
HTTP is allowed only for loopback. Remote connections require HTTPS. Selecting
this descriptor authorizes sending document content to that engine and its
selected provider.

The runtime does not rewrite the descriptor or stop the borrowed engine. It still
supervises its own processor writer. Switching harnesses with unsettled operations
can remain blocked until the previous work is reconciled.

## Protect retained state

Native processing state is under
`/workspace/.runtime/native/processing/<PROJECT_ID>/`. Keep the retained volume to
preserve jobs and results. Provision enough disk space. Results remain for the
data-root lifetime. This integration does not automatically evict old results.

Directories and connection handoffs are private to the native Unix identity.
Backups can contain provider credentials and broad OpenCode server authority.
Protect them like secrets. Clean child environments reduce accidental exposure,
but same-user scripts and plugins can still access that identity's credentials.
Native mode is not a credential sandbox.

Shared extraction uses a reviewed set of pinned built-ins and a separate
one-step extraction agent. It does not load geology instructions, ordinary tools,
or arbitrary user provider plugins. OpenCode still adds its built-in date and
private extraction-directory metadata. An unsupported extraction context fails
instead of silently importing conversation behavior. Do not edit the generated
extraction context while jobs are running.
