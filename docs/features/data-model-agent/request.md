---
kind: request
version: 1
revision: 2
status: accepted
slug: data-model-agent
---

# Data-modelling agent

## Intent

Give Michal a resilient, AustralianSuper-branded single-user Next.js workspace for
developing, reviewing, revising, saving and exporting insurance data models from
requirements and existing technical artifacts. Generation must remain observable and
recoverable during long model-provider calls.

## Intent source

Direct user guided intake.

## Boundaries

- Pilot for a large insurance organisation.
- Accept free-form requirements, existing schemas, DDL and Markdown.
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
- Automated tests use fake providers; a bounded live local bridge check is sufficient to
  prove the signed-in VS Code provider path.

## Exclusions

- Multi-user access control and production hardening.
- Deployment, provider-account provisioning and repository merge.
- Reading, exporting or persisting GitHub, Azure or model-provider credentials.
- Private VS Code Agent Host protocols or model tools.
- Automatic application of generated models as database migrations.

## Acceptance criteria

### INPUTS

**Outcome:** Michal can create a modelling request from free-form text and attach
Markdown, DDL or schema text, and the application preserves the supplied source material
with the saved model.

**Proof:** Run component and service tests using literal text, Markdown, DDL and schema
fixtures, then inspect the saved and reloaded request.

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

Status: accepted. Michal explicitly accepted request revision 1 during the guided pilot
intake. On 2026-10-01, Michal authorized the complete resilience, provider, input-editing,
branding and model-workbench delivery sequence and clarified that Copy and Export PDF
must always use the Mermaid diagram. That direct decision accepts request revision 2.
