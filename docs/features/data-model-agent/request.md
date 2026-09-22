---
kind: request
version: 1
revision: 1
status: accepted
slug: data-model-agent
---

# Data-modelling agent

## Intent

Give Michal a single-user Next.js application for developing, reviewing, revising,
saving and exporting insurance data models from requirements and existing technical
artifacts.

## Intent source

Direct user guided intake.

## Boundaries

- Pilot for a large insurance organisation.
- Accept free-form requirements, existing schemas, DDL and Markdown.
- Use a configurable OpenAI integration through a server-side boundary.
- Persist and retrieve models and generate Mermaid ER and draw.io XML.
- Provide preview, editing, regeneration, versioning and downloads through a web UI.

## Assumptions

- The pilot has one user and requires no authentication.
- Inputs may contain sensitive organisational information and may be stored and retrieved.
- A fake OpenAI client is sufficient for acceptance; no live paid model call is required.

## Exclusions

- Multi-user access control and production hardening.
- Deployment, provider provisioning, live paid model calls and repository merge.
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

### OPENAI-BOUNDARY

**Outcome:** Model generation uses a configurable OpenAI client boundary and converts
validated structured responses into the canonical model without exposing credentials to
browser code or persisted records.

**Proof:** Run server-side integration tests with a fake OpenAI client and inspect client
bundles and stored fixtures for credential material; do not make a live provider call.

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
intake; this Markdown document preserves the semantics of that accepted request.
