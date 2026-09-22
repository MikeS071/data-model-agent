---
name: project-initialisation
description: Create or initialise a new project with dev-stack, or inspect, install, verify, upgrade, recover, rollback or remove an explicitly selected pinned release.
---

# Project initialisation and lifecycle

## New or empty project

Start by confirming the selected directory is empty. Ask for the user-defined project
name, GitHub owner or organisation, and whether that project repository already exists,
one question at a time. Do not invent a GitHub owner or create a remote repository. Show
a readable bootstrap plan before writes. After approval, initialise `main`, add the
confirmed origin only when it exists, and create a secret-free adapter for the resulting
`owner/project-name`; verification commands may be empty until design selects the stack.

Obtain the installation source by cloning
`https://github.com/EtnaJamesCapital/dev-stack.git` into a temporary directory outside
the project. Read that checkout's root instructions, this skill and quickstart. Run its
installer `doctor`, `plan`, present the readable release version/paths/actions, then
`apply` and `verify` when the reviewed plan matches the approved bootstrap. Do not ask the
human for release paths, digests, hashes or commit identifiers, and do not hand-copy the
source tree. Remove only the temporary clone created by this workflow after verification.
Network access to clone the named public source is within this bootstrap request; remote
repository creation, pushes and other external writes still require separate authority.

The governance installation and the application feature are distinct. Commit the local
governance baseline, create `feature/<project-name>`, then immediately run
[session initialisation](../session-initialisation/SKILL.md) for the first feature. Ask
one critical unanswered request question at a time and pass the human request gate;
afterward ask the technical-foundation questions and pass the separate design gate before
implementation. If the accepted work has a
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
