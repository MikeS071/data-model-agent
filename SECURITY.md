# Security policy

## Supported versions

Security fixes are applied to the latest published release. Older releases may not receive
backported fixes.

## Reporting a vulnerability

Please report suspected vulnerabilities through
[GitHub private vulnerability reporting](https://github.com/MikeS071/data-model-agent/security/advisories/new).
Do not open a public issue for an unresolved security problem.

Include the affected version, impact, reproduction steps and any suggested remediation.
Do not include provider credentials, proprietary schemas, personal information or live
organisational data. The maintainer will acknowledge the report as soon as practical and
coordinate disclosure after a fix is available.

## Pilot security boundary

Data Model Agent is currently a local, single-user pilot. It does not provide
authentication, authorization, encrypted application storage or production deployment
hardening. Model requirements, source files, drafts and chat history are stored in a local
SQLite database. Generation and chat send selected context to the configured
OpenAI-compatible provider.

Use only approved test or organisational data, keep `apps/web/.env.local` private, and do
not expose the local server to untrusted networks. A production deployment requires a new
security design covering identity, access control, encryption, retention, audit logging,
provider approval, monitoring and incident response.

