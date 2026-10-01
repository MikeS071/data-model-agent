---
kind: request
version: 1
revision: 3
status: accepted
slug: data-model-agent
---

# Data-modelling agent

## Intent

Give Michal a resilient, AustralianSuper-branded single-user Next.js workspace for
developing, reviewing, revising, saving and exporting insurance data models from
requirements and existing technical artifacts. Generation must remain observable and
recoverable during long model-provider calls. CSV data extracts can inform model
structure without sending the complete extract or likely personal data to the provider.

## Intent source

Direct user guided intake.

## Boundaries

- Pilot for a large insurance organisation.
- Accept free-form requirements, existing schemas, DDL, Markdown and CSV data extracts.
- Preserve an attached CSV locally, derive a reviewable provider-safe representation, and
  use only that confirmed representation during generation and chat.
- Let each project select an available server-side provider and model, including the
  signed-in VS Code GitHub Copilot language-model service without extracting credentials.
- Persist and retrieve models and generate Mermaid ER and draw.io XML.
- Persist durable generation jobs with progress, transcript, heartbeat and retry state.
- Provide preview, source editing, regeneration, versioning, image copy and PDF export
  through a branded web UI.

## Assumptions

- The pilot has one user and requires no authentication.
- Inputs may contain sensitive organisational information and may be stored and retrieved.
- The local VS Code extension host is already authenticated to GitHub Copilot by the user.
- CSV input uses text-based comma-separated files; spreadsheet workbooks are not CSV.
- A CSV may not have an obvious header row, so the application may infer candidate
  headers but the user confirms or corrects them before provider use.
- Automated tests use fake providers; a bounded live local bridge check is sufficient to
  prove the signed-in VS Code provider path.

## Exclusions

- Multi-user access control and production hardening.
- Deployment, provider-account provisioning and repository merge.
- Reading, exporting or persisting GitHub, Azure or model-provider credentials.
- Private VS Code Agent Host protocols or model tools.
- Automatic application of generated models as database migrations.
- Excel workbooks, multi-sheet imports, TSV files and general-purpose data cleansing.
- Sending a complete CSV file to a model provider.

## Acceptance criteria

### INPUTS

**Outcome:** Michal can create a modelling request from free-form text and attach
Markdown, DDL, schema text or CSV, and the application preserves the supplied source
material with the saved model.

**Proof:** Run component and service tests using literal text, Markdown, DDL, schema and
CSV fixtures, then inspect the saved and reloaded request.

### CSV-IMPORT-REVIEW

**Outcome:** Attaching a CSV produces a review step showing the inferred header, column
profile and masked sample. The user can confirm or correct the inferred header before the
CSV becomes eligible for generation. Editing the original CSV invalidates that
confirmation, recomputes the analysis and requires confirmation again.

**Proof:** Exercise header-present, ambiguous-header and headerless fixtures; assert the
preview, correction and confirmation states; edit a confirmed CSV and prove generation
remains blocked until the recomputed analysis is confirmed.

### CSV-PROVIDER-CONTEXT

**Outcome:** Generation and chat receive CSV headers, inferred column profiles and a
deterministic distributed sample of at most 100 rows. Likely identifiers and personal
data are masked in sampled values while type and format evidence remains available. The
complete raw CSV is never included in a provider request.

**Proof:** Use a large fixture containing names, email addresses, phone numbers, account
identifiers and ordinary business values; inspect the exact fake-provider request for
stable distributed sampling, useful profiles, masked sensitive values and absence of raw
file content or unsampled sentinel values.

### CSV-VALIDATION

**Outcome:** Malformed, binary, unsupported-encoding, inconsistent-width or oversized CSV
input fails before provider access with a specific correction message. A valid CSV
supports quoted fields, embedded commas, escaped quotes, embedded line breaks and an
optional UTF-8 byte-order mark.

**Proof:** Run parser and boundary tests covering each valid quoting case and each typed
failure, then assert the fake provider was not called for rejected input.

### CSV-RETRIEVE-REGENERATE

**Outcome:** Reopening a project restores the original CSV, its confirmed analysis state
and the provider-safe preview. Regeneration snapshots the latest confirmed analysis so a
retry or reload cannot silently use an older CSV interpretation.

**Proof:** Save, reload and regenerate a project with a confirmed CSV; compare the stored
source, restored review state and durable generation-job snapshot with literal expected
values.

### CANONICAL-MODEL

**Outcome:** The application maintains one editable canonical model containing entities,
attributes, primary and foreign keys, optionality, cardinality, business definitions,
validation rules and layout metadata.

**Proof:** Compare the canonical Claim-Payment model with a literal expected object and
validate its schema.

### CLAIM-PAYMENT

**Outcome:** The acceptance fixture represents one claim with zero or many payments and
each payment with exactly one claim; payment includes amount, currency, status, method,
requested, approved and paid dates, and an external reference; total paid cannot exceed
the approved claim amount.

**Proof:** Run focused domain tests for exact entities, fields, relationships and the
aggregate payment rule.

### AMBIGUITY

**Outcome:** Conflicting or incomplete requirements produce a draft with explicit
assumptions and warnings, followed by one clarification question at a time; no ambiguous
relationship is silently invented.

**Proof:** Use an ambiguous fixture with a fake model response and assert the draft,
warning, assumption, question order and absence of an invented relationship.

### PROVIDER-BOUNDARY

**Outcome:** Every project can select an available provider and model. OpenAI API-key,
GitHub Copilot SDK and VS Code language-model adapters remain behind one server boundary,
and the VS Code adapter uses only the public `vscode.lm` API over authenticated local IPC.
No provider credentials are exposed to browser code or persisted records.

**Proof:** Run provider contract and project-settings tests, inspect browser bundles and
stored fixtures for credential material, and complete one bounded VS Code bridge health
and model request using the signed-in editor.

### DURABLE-GENERATION

**Outcome:** Starting generation creates a durable project job whose provider/model and
input snapshot cannot change mid-run. The UI shows phase, elapsed time, streamed activity
and heartbeat, survives reload, supports cancellation and retry, and marks unfinished
jobs interrupted after an application restart or stale heartbeat. Only a fully parsed and
validated result may replace the working draft.

**Proof:** Run generation-job and repository tests for queue, heartbeat, completion,
cancellation, stale/restart interruption and atomic draft replacement; reload the browser
while a representative job is active.

### EDITABLE-GENERATION-INPUTS

**Outcome:** Requirements, source-document text, provider and model remain editable on
the model detail screen. Saving them makes no provider call. Regeneration persists all
modified inputs before creating a job and clearly identifies that changes will be used.

**Proof:** Run component and service tests that modify requirements and attachments,
change provider/model, save without generation, and assert the regeneration snapshot
contains the latest persisted values.

### MERMAID-OUTPUT

**Outcome:** The application previews and downloads a Mermaid ER diagram equivalent to
the canonical model, including entities, fields, keys, optionality and relationship
cardinality.

**Proof:** Generate Mermaid for the Claim-Payment fixture and compare parsed entities,
attributes and relationships with literal expectations.

### DRAWIO-OUTPUT

**Outcome:** The application previews and downloads importable draw.io XML equivalent to
the same canonical model and its layout.

**Proof:** Parse generated XML and assert expected entity cells, labels, fields, edges and
layout coordinates.

### MERMAID-COPY-AND-PDF

**Outcome:** Copy always places a PNG rasterized from the rendered Mermaid ER diagram on
the clipboard, even while the draw.io preview is selected. Export PDF always uses that
same Mermaid rendering and includes the visual model plus readable descriptions of every
entity, attribute, relationship, validation rule, assumption and warning.

**Proof:** Select draw.io, invoke both actions, assert the export source is the rendered
Mermaid SVG, inspect the clipboard MIME/size, and verify the downloaded file signature,
diagram image and textual section contents.

### BRANDED-WORKBENCH

**Outcome:** The application follows the supplied AustralianSuper palette, typography and
approved logo in a calm pastel workbench. Model controls occupy one compact toolbar;
entities, assumptions and warnings are collapsed initially; the vector canvas remains
readable when zoomed; and model chat opens from a viewport-fixed lower-left bubble into a
bounded, scrollable panel above it.

**Proof:** Run component accessibility assertions and inspect desktop, tablet and 375px
browser layouts for control overflow, focus order, disclosure defaults, fixed chat
placement, vector clarity and absence of horizontal page scroll.

### EDIT-VERSION-RETRIEVE

**Outcome:** Michal can edit the canonical model, regenerate outputs after clarification,
save a new version, list saved models and reopen any saved version without losing its
source material or prior versions.

**Proof:** Run an end-to-end repository and UI test covering create, edit, clarify,
regenerate, save-version, list and reopen.

### PROJECT-CHECKS

**Outcome:** The Next.js pilot passes its configured syntax and unit checks on the exact
candidate and the final report maps evidence to every accepted criterion and the complete
intent.

**Proof:** Run the commands configured in `.governance/verification.json` plus the focused
build and UI checks introduced by the implementation.

## Approval

Status: accepted. On 2026-10-01, Michal accepted revision 3 after selecting confirmed
header inference, deterministic distributed sampling of at most 100 rows, provider-safe
column profiling, automatic masking of likely identifiers and personal data, and
confirmation invalidation after edits.
