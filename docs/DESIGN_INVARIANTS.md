# Agent design constraints

The geological agent system has four layers: a user-facing agent, an analysis
orchestrator, domain specialists, and an extended-capability agent. These
constraints preserve that division of responsibility. Tool inventories and
permission rules belong in executable configuration, not in this document.

## Keep responsibilities separate

- **L1-1, L1-2, L1-5:** Layer 1 is read-only. Its MCP access is limited to compact
  hygiene and provenance checks. Dataset inspection and execution belong to
  specialists. Large inspection responses consume the user-facing context without
  advancing the conversation.
- **L1-3, L1-4:** Layer 1 delegates through the orchestrator. Its prompt states
  when delegation is required. Direct specialist dispatch would bypass planning
  and result coordination.
- **L2-1, L2-2, L2-3:** Layer 2 plans and routes. It has no MCP, shell, or write
  access. Execution must remain attributable to a specialist.
- **L2-4:** Specialist history belongs to the conversation and survives context
  compaction and engine restart. Losing that history can repeat work or contradict
  earlier results.
- **L3-1, L3-2:** New tools receive no layered agent access until deliberately
  assigned. Exact allowlists prevent accidental access through substring matches.
  Within the hierarchy, retained document processing belongs to DataOps so that
  source preparation and extraction have one responsible specialist.
- **L3-3:** Transform prefers domain tools for simple operations and saves scripts
  for operations that need them. Automatic scripts remain in the conversation's
  output folder so their results are reproducible.
- **L3-4, X-5:** Treating arbitrary prose as a successful specialist result would
  hide incomplete work. Unparseable output must remain an error.
- **L3-5, L4-1:** Within the layered system, only Extended installs packages.
  Specialists report capability gaps through the orchestrator. This keeps
  dependency changes under one responsibility.
- **L4-2, L4-3, L4-4:** Extended has no geological MCP tools. It verifies installs
  and records the package, version, timestamp, reason, and task in
  `environment.yaml`. A successful installer exit alone does not prove a usable
  dependency.

Standard mode is a separate coding mode. It does not use the specialist hierarchy.
Its file tools still follow the protected-path and edit-approval boundaries below.

## Preserve source and output meaning

- **X-1:** MCP paths resolve inside `WORKSPACE_ROOT`. File and attachment access
  also validate containment. Model-supplied paths cannot grant access elsewhere.
- **X-2:** Data expressions must not expose general-purpose code execution
  through a data operation.
- **X-6:** Failures identify the originating agent, tool, cause, and next action.
  Silent fallbacks must not turn unknown or failed work into success.
- **X-7:** Automatic conversation outputs stay under `runs/<id>/`. Requested
  ordinary workspace saves use edit approval at the user's exact destination.
  File tools cannot edit private runtime state, another conversation's run folder,
  the current run's `_orchestrator/` records, or paths outside the workspace.
  Extended's shared install record is the explicit automatic-write exception.
  Retained document jobs and results remain private processor state accessed by
  tools. Automatic exports, unlike retained results, follow the run-folder rule.
- **L3-6:** Canonical voxel operations belong only to the Voxel specialist and
  use exact tool assignment. All geological voxel requests follow Layer 1 →
  orchestrator → Voxel. Runtime-issued workspace identity and conversation scope
  authorize effects. Model prose and agent-writable files are not authority.

Voxel grids and observations have different scientific meanings. Edited grid
cells become derived imported data, not original observations with invented
counts or weights. A named revision binds the inspected artifact and expected
head. A conflict requires inspecting and preparing against the new head.

## Report-analysis constraints

**RE-1:** Report analysis keeps Layer 1's read-only posture. **RE-2:** It can read
compact extracted prose, tables, and figure descriptions directly. **RE-3:**
Citations distinguish observations, interpretation, and assumptions, including
page and figure evidence.

**RE-4:** For gateway-managed turns, the gateway checks cited files against
successful reads by the root agent and its depth-one children. It requests one
correction for unsupported citations. A second failure produces a warning and
suppresses report export.
This check establishes that a file was read, not that the answer correctly
interprets it. Native TUI report analysis retains RE-1 through RE-3, but has no
enforced citation correction or gateway-managed report export.

## Security limits

The permission layer guides the model. It does not sandbox code the model writes
or runs. Shell processes share the engine's Unix identity. They can access
same-user process information and writable engine or MCP state. Root-owned
configuration reduces writable entry points but does not remove that boundary.

Shell restrictions match command text. They cannot prevent a script from
installing packages or writing outside its automatic-output folder. File-tool
symlink checks occur during permission evaluation and do not pin the destination
through an approval wait. Another same-user process can change the path afterward.

Shared MCP cancellation stops observation, not an already running Python thread.
That thread can still finish and write output after a cancelled turn. Report
citation checks run after text has streamed, so an unsupported first answer can
remain visible during correction.

Root workspace provisioning and dataset hydration require separate filesystem
care. Concurrent agent writes can race dataset-copy operations. Descriptor-based
file operations also cannot atomically prevent an external writer from moving a
checked directory between validation and mutation.
