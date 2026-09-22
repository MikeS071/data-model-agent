# Codex project initialisation prompt

Use this prompt in Codex from the directory that should become the project. Replace the
bracketed release path with the location of the reviewed dev-stack release.

```text
Use $dev-stack-project-initialisation to create or initialise the project in the current
directory from the reviewed dev-stack release at [DEV_STACK_RELEASE_PATH]. If that named
skill is not yet available, read [DEV_STACK_RELEASE_PATH]/.governance/skills/project-initialisation/SKILL.md
and [DEV_STACK_RELEASE_PATH]/.governance/docs/quickstart.md in full and follow them.

Inspect this directory before proposing changes. Ask me one critical unanswered question
at a time to establish the project purpose, users, repository identity, technical
foundation, verification approach, external-data boundaries, deployment boundary, and
whether the work includes a visual or interactive UI. Skip anything I have already
answered. Do not ask me for digests, hashes, or commit identifiers.

When the foundation is clear, show me a readable plan covering assumptions, intended
files, commands, dev-stack adapter settings, and anything that remains manual. Wait for
my approval of that plan before writing. Do not create a remote repository, call a model
provider, deploy, or activate a worker unless I separately authorize that action.

After project initialisation, use separate human gates for the first feature request and
technical design. If the accepted feature contains visual or interactive UI work, use
$ui-ux-pro-max only for that UI portion. Do not use it for backend, API, database,
infrastructure, or other non-visual work.
```

The prompt deliberately separates project initialisation from feature intent and design.
Approval of the initialisation plan authorizes only the reviewed local changes, not a
remote repository, paid provider call, merge, deployment, or worker activation.
