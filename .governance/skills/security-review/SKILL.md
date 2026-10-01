---
name: security-review
description: Review an affected trust boundary for authorization, untrusted input, secrets, sensitive data, or external side effects.
---

# Security review

Identify the entry point, actor, resource, trust boundary, and sensitive data or side effect in the accepted scope. Follow the data from input through authorization and persistence or provider calls. Check that server-side access is enforced for the relevant identity and object; UI hiding alone is not authorization.

Validate untrusted data at its owning boundary and use safe query or command APIs. Check secret sourcing, redaction, error messages, logs, and responses for exposure. For uploads, webhooks, payments, or other external effects, assess authenticity, size or workload limits, replay and retry behavior, and the project's established controls where relevant.

Use focused negative and positive proof for the affected boundary. Report concrete findings, severity, and evidence; do not turn a scoped review into a generic checklist or silently change product behavior outside the accepted design. A source scan alone cannot prove a runtime access boundary.
