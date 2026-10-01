---
name: api-contract-review
description: Design or review an API contract when endpoint behavior, compatibility, authorization, or failure semantics are part of the scope.
---

# API contract review

Start from the consumers and the project's existing API conventions. Identify the resource or action, request and response shapes, authentication and authorization boundary, validation, error behavior, and observable side effects. Make method and status semantics accurate; do not return apparent success for a failed operation.

For collections, define ordering, pagination or workload bounds when volume warrants them. For mutations, decide whether retries can repeat safely and how clients learn about partial success or conflicts. Consider versioning and compatibility only for actual consumers or a planned migration. Keep private data out of error payloads and logs.

Check the contract with a consumer-facing example or behavioral test at the affected boundary. Record decisions that change existing callers or the accepted design; do not impose one naming style or response envelope on a project that already has a coherent convention.
