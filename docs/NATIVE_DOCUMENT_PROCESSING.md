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

The processor exposes submission, job history, cancellation, result navigation,
table reads, and text reads. Keep the returned job ID. Reusing the same submission
UUID with the identical request recovers that submission. A new UUID creates new
work. Cancellation can remain pending until execution is settled.

Processing history is shared across the workspace. Its results live in private
retained processor storage, not automatically beside the source or in the file
daemon's managed upload history. Use the result tools to read them. Ask explicitly
for an export when you need an ordinary workspace file. Automatic conversation
exports stay under `runs/<session-id>/results/`. Other destinations retain normal
edit approval.

Results bind the captured source bytes, model, and extraction profile. A current
file with the same pathname is not proof that its bytes match an older result.
Check coverage and findings before relying on a partial extraction.

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
