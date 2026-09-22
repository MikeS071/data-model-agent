---
name: project-initialisation
description: Create or initialise a new project with dev-stack, or inspect, install, verify, upgrade, recover, rollback or remove an explicitly selected pinned release.
---

# Project initialisation and lifecycle

## New or empty project

Start by inspecting the selected directory, Git state, existing instructions and files;
an empty directory is not permission to invent repository identity or overwrite nearby
work. Ask one critical unanswered question at a time. Stop when the following technical
foundation is reviewable, skipping facts the user already supplied:

1. project name, purpose, users and first observable outcome;
2. local-only or hosted repository identity, base branch and allowed work prefixes;
3. application shape, language/runtime, framework and package manager;
4. verification commands or the honest plan for adding them;
5. storage, external services, sensitive-data and deployment boundaries; and
6. whether the feature includes visual/interactive UI work.

Summarize the answers, assumptions, unresolved decisions, intended files and commands in
a readable plan before writing. A human does not provide release digests or Git commit
identifiers. Do not invent a GitHub owner, remote, provider, credential or deployment
target. Initialise Git, create application scaffolding, install dependencies or configure
external services only when those actions are in the user's authorized scope. Existing
files and stronger policy remain authoritative.

The governance installation and the application feature are distinct. Install the
reviewed dev-stack release using the lifecycle below, then use the two request/design
gates for application scaffolding or feature implementation. If the accepted work has a
visual or interactive interface, select `$ui-ux-pro-max` during design and UI work. Never
select that skill for backend, API, data-model, database, infrastructure or other
non-visual work.

Inspect existing project policy, target ownership, native skill entrypoints and actual
required tools. Obtain the exact reviewed release through the approved channel; read
[quickstart](../../docs/quickstart.md) and the requested [lifecycle recipe](../../docs/recipes.md).
Prepare the explicit project adapter with real branches/templates/checks; missing
runtime/provider capabilities remain manual and incomplete.

Run doctor and plan before governed writes. Review every path, action, source version and collision.
The installer stores and revalidates detailed identities in its private pending plan;
people do not copy digests. Apply only within scoped authorization. Do not
overwrite existing AGENTS, local changes, duplicate skill definitions, CI or globals.
Stronger local policy stays authoritative. Configuration cannot activate workers/providers.

Verify installed files and actual public CLI commands, then run
[session initialisation](../session-initialisation/SKILL.md). Confirm the host discovers
the intended native router and reads this canonical leaf; static manifests alone are
not proof of fresh-host invocation. For upgrades, check conflicts and preserve local
policy. Interrupted operations use explicit recover and verification; do not delete
state or guess by age/PID. Removal/rollback touches only owned unchanged files/sections
and retains additions. Report complete, incomplete and manual setup separately.

New feature work starts from `.governance/templates/request.md`, passes the request gate,
then starts from `.governance/templates/design.md` and passes the separate design gate.
Both accepted documents are durable project history under `docs/features/<slug>/`; generated
scope, baseline and loop evidence remain ignored local artifacts.
