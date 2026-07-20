# Report Analysis Mode — Stage-aware Mining-Evals

**Status:** Phase 1 (thin slice) implemented — 2026-06-30
**Where:** `geocluster-ai-ide-BE/cline-fork`

## Why

The geology agent over-focuses on tables and assumes early-stage reports, because its
prompt makes a *tabular* citation grammar (`[source: file | col: column]`) mandatory for
every fact, forbids reading data files (delegating all inspection to pandas specialists), and
forbids economic/mineability claims. As a result it ignores narrative prose, figures and maps,
and refuses the economic questions. The assignment: a process that works out a report's
**project stage** and uses a **variation of the geocluster agent** to answer the
`Mining-evals.xlsx` questions for that stage, in the color-coded UI.

## What was built (Phase 1)

A new **"Report Analysis"** agent mode (a third chip beside Geo/Std) backed by a new
`report-eval` prompt variant. The geology agent is untouched.

### 1. New agent mode
- `src/shared/storage/types.ts` — `AgentMode` gains `"report-analysis"`.
- `webview-ui/src/components/chat/ChatTextArea.tsx` — the 2-position Geo/Std switch becomes a
  3-position **Geo / RA / Std** selector (per-chip click selects the mode; slider generalised
  to N positions). The "RA" chip is the Report Analysis mode.
- `agentMode` already flows into `SystemPromptContext`, so prompt selection needs no new
  plumbing. There are **no behavioral gates** on `agentMode` elsewhere — it is a string
  passthrough that only drives variant selection.

### 2. New `report-eval` variant
- `src/shared/prompts.ts` — new `ModelFamily.REPORT_EVAL`.
- `src/core/prompts/system-prompt/variants/report-eval/config.ts` — mirrors the geology
  variant's structure and **read-only tool set** (no shell, no writes), but:
  - **Broadens citations** to narrative (`text/NN_*.md | p:N`), tables (`tables/<id>.csv`),
    figures (`images/fig_* | p:N`) and pre-verified metrics (`analysis/findings.json`).
  - **Allows** economic / mineability / resource judgments (the evals ask for them).
  - **Targeted retrieval**: read the relevant 1–5 extraction files directly; cite
    `analysis/findings.json` for verified numbers instead of re-deriving; delegate to the
    orchestrator only for heavy multi-table work.
  - **Keeps** the data/interpretation/assumption blockquote color coding and adds a per-answer
    **RAG verdict** (`> **Verdict:** 🟢/🟡/🔴/⚪ …`).
- `variants/index.ts` — registered **before** geology (more specific matcher wins first);
  geology's matcher tightened to exclude `report-analysis`.

### 3. Question bank
- `src/core/prompts/system-prompt/variants/report-eval/question-bank.ts` — the 8-stage ×
  4-category Mining-evals matrix transcribed verbatim, with a `needsWebSearch` flag and a
  best-effort map from the upstream pipeline's coarse stages.

## Report corpus (input — not built here)

A report is represented in the workspace by the upstream `geo-report-pipeline` output
(`/root/extract-reports-to-feed-into-pipeline/output/<slug>/`): `text/` (prose), `tables/`
(pdftotext-verified CSVs), `images/*.description.md` (figures/maps), optional
`analysis/findings.json`. That pipeline is **reused, not modified**.

## Invariants

`report-eval` is a sibling Layer-1 variant. It keeps the same hard read-only posture as geology
(enforced in `design-invariants.test.ts`); it only relaxes the *soft prompt* rule against
reading data files, for the compact extraction artifacts. See `docs/DESIGN_INVARIANTS.md`
(RE-1..RE-3).

## Verification done

- `npx tsc --noEmit` — extension and webview both clean.
- Variant registry/matcher/tools/prompt-content offline checks — 22/22 pass.
- `design-invariants.test.ts` — 174 passed, 0 failed (incl. 43 new report-eval guards).
- Mocha runner itself is broken in this environment (Node/ts-node ESM loader can't load
  `src/test/requires.ts`; reproduces on the untouched command). The self-executing
  invariant/verify scripts were run directly via `ts-node` instead.

## Remaining (manual / follow-on)

- **Live run:** select Report Analysis mode, point the workspace at an extracted sample
  (`new_found_gold_corp_tech_report` = resource, or `gold_x2_mining` = target), feed that
  stage's questions, and confirm answers cite narrative/figures (not only tables), answer the
  economic questions, and render color-coded + RAG verdict. Needs an LLM API key + the MCP
  server (couldn't run headless here).
- Auto stage-classifier + user-confirm; 4→8 stage mapping.
- Web search MCP tool for `needsWebSearch` questions (commodity prices, legal, analogues).
- Report compilation/export; first-class RAG verdict badge in `ChatRow` (proto `ClineSay`).
- Driver that feeds a whole stage's questions in one go (webview flow + headless
  `cline task --json` batch).
