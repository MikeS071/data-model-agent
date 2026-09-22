# Getting started with dev-stack

This guide takes a new user from an empty directory to an accepted feature scope and a
bounded build-test-verify loop. The worked example is a small data-modelling agent that
turns domain requirements into Mermaid ER diagrams and draw.io XML.

## What dev-stack is

dev-stack adds a project-local operating contract around a coding agent. It provides:

- a preserved project instruction entrypoint;
- explicit intent, boundaries and acceptance criteria;
- project-selected verification commands;
- source-bound review and evidence records;
- a bounded loop that routes product defects back to implementation and sends scope,
  test-oracle, authority and environment problems to the correct owner; and
- optional, disabled-by-default worker coordination.

It is not an application generator or an unattended deployment system. Installation
does not download dependencies, call a model provider, create a GitHub repository,
merge a PR, deploy code, or prove that the application works. Those remain explicit
project tasks and human approval gates.

The current private candidate targets Linux, Node 24.14+, Python 3.12+ and Git 2.43+.
Obtain an exact reviewed release directory through a trusted channel. The installer
captures and rechecks release identity internally between plan and apply. Ordinary users
do not need to read, copy or provide machine identifiers; distribution maintainers can
add stronger external pinning without changing this workflow.

## The files to know

For day-to-day use, start with **`AGENTS.md`**. It is the instruction entrypoint for the
human and coding agent. The installer owns only the marked dev-stack block; project rules
outside that block remain yours.

| File | Purpose | Normal owner |
| --- | --- | --- |
| `AGENTS.md` | Project instructions and link to dev-stack session policy. | Project, except the marked installer block. |
| `dev-stack.adapter.json` | Repository identity, branches, instruction paths, templates and verification commands used during install/upgrade. | Project. Keep it secret-free and version it. |
| `.governance-artifacts/<feature>.scope.json` | One feature's agreed intent, boundaries, source and observable acceptance criteria. | Human and agent for that feature; ignored by Git by default. |
| `.governance/delivery.json` | Installed delivery configuration generated from the adapter. | Installer; change the adapter and re-apply instead of hand-editing it. |
| `.governance/verification.json` | Installed allowlist of project verification commands. | Installer, generated from the adapter. |
| `.governance/policy.md` | Reusable always-on dev-stack policy. | Pinned dev-stack release. |
| `.governance/quality.md` | Reusable code-quality review conditions. | Pinned dev-stack release. |
| `.governance/principles.md` | Router for conditional engineering-principle skills. | Pinned dev-stack release. |
| `.governance/self-verification.json` | Maximum iterations, repeated failures and elapsed time for a loop. | Pinned dev-stack release. |

The scope file is the most important file for a particular feature: it says what “done”
means. A passing command cannot silently replace an omitted criterion or change its meaning.

## Worked example: build a data-modelling agent

The example assumes a GitHub repository named `YourOrg/data-model-agent` already exists.
It uses Node for the future application, but dev-stack itself does not choose the
application language, architecture or model provider.

### 1. Create the project repository

```sh
mkdir /work/data-model-agent
cd /work/data-model-agent
git init -b main
git remote add origin https://github.com/YourOrg/data-model-agent.git
```

The remote URL must match the repository declared in the adapter. Nothing is pushed by
these commands or by the installer.

### 2. Create the project adapter

Save the following as `/work/data-model-agent/dev-stack.adapter.json`. The two verification
commands name files the agent will create as part of the feature. Commands are argument
arrays, not shell strings; supported programs are `node`, `python3`, `git`, `pnpm`, `npm`,
`go` and `cargo`.

```json
{
  "delivery": {
    "schemaVersion": 1,
    "project": {
      "schemaVersion": 1,
      "repository": "YourOrg/data-model-agent",
      "branchPrefixes": ["feature", "fix", "chore"]
    },
    "baseBranch": "main",
    "queue": null,
    "instructionPaths": [
      "AGENTS.md",
      ".governance/policy.md",
      ".governance/quality.md",
      ".governance/principles.md"
    ],
    "templates": {
      "issue": ".governance/templates/issue.md",
      "pr": ".governance/templates/pr.md"
    }
  },
  "verification": {
    "schemaVersion": 1,
    "commands": {
      "syntax": ["node", "--check", "src/index.mjs"],
      "unit": ["node", "--test", "test/model.test.mjs"]
    }
  }
}
```

Do not put tokens, passwords, private prompts or provider credentials in an adapter.
Empty `commands` are allowed for installation but leave application verification
explicitly unconfigured.

### 3. Plan and install the release

Run the installer from the reviewed release directory:

```sh
RELEASE=/opt/reviewed/dev-stack-0.1.0-candidate.2
PROJECT=/work/data-model-agent
ADAPTER=/work/data-model-agent/dev-stack.adapter.json

python3 "$RELEASE/.governance/install.py" doctor --target "$PROJECT"
python3 "$RELEASE/.governance/install.py" plan \
  --target "$PROJECT" \
  --adapter "$ADAPTER"
```

`plan` prints only the release version plus readable create/update/remove actions. It
writes the detailed identities to an installer-managed local pending-plan file so the
user does not need to handle them. The artifacts directory is automatically ignored
once installed; do not add the first-install artifact to Git. Review the paths and
actions, then apply and verify:

```sh
python3 "$RELEASE/.governance/install.py" apply \
  --target "$PROJECT"

python3 "$RELEASE/.governance/install.py" verify --target "$PROJECT"
```

`apply` reloads the pending plan and refuses if the release, adapter, target state or
planned changes no longer match. A successful apply consumes the pending plan. To
upgrade, run `plan` from the new release's installer with the same adapter, then run its
`apply` and `verify` commands.

The install adds canonical governance files, native skill routers, `tools/governance`,
an ignored `.governance-artifacts/` area, and marked sections in `AGENTS.md` and
`.gitignore`. Existing content outside marked sections survives. Conflicting or locally
modified installer-owned files stop the operation for review.

Commit this governance baseline before feature work:

```sh
cd /work/data-model-agent
git add AGENTS.md .gitignore .agents .governance tools dev-stack.adapter.json
git commit -m "chore: install dev-stack governance"
git switch -c feature/data-model-agent
```

### 4. Ask for guided intake, one question at a time

Yes: dev-stack can conduct a one-question-at-a-time scope interview through the installed
session-initialisation skill. The CLI itself is intentionally non-interactive; the coding
agent asks the questions. In Codex, start with:

```text
Use $dev-stack-session-initialisation.

I want to build a data-modelling agent that turns domain requirements into Mermaid ER
diagrams and draw.io XML. Interview me one critical question at a time. Skip anything I
have already answered. Do not implement yet. When intent, boundaries, acceptance and
proof are clear, propose revision 1 of the scope and ask me to accept or revise it.
```

For an agent host that does not support named skill invocation, use the equivalent:

```text
Read AGENTS.md and .governance/skills/session-initialisation/SKILL.md in full, then run
the same one-question-at-a-time intake. Do not implement until I explicitly accept the
proposed scope.
```

The agent should ask only unanswered questions that materially affect design or proof.
For this example, likely decisions are:

1. Who uses the tool and what decision should its output support?
2. What input is accepted: prose, structured JSON, an existing schema, or several forms?
3. What must Mermaid and draw.io represent: entities, attributes, keys, optionality,
   cardinality, notes, layout, or all of these?
4. When requirements are ambiguous, should the agent ask a question, produce warnings,
   or make labelled assumptions?
5. Is the interface a CLI, library, service or UI?
6. What application runtime and model/provider boundary are allowed?
7. What sensitive data, tenancy, retention and network restrictions apply?
8. Which concrete examples and failure cases prove success?
9. What is explicitly excluded from the first feature?

This is a priority list, not a questionnaire to ask mechanically. The skill skips
answers already supplied and stops interviewing when a reviewable scope is possible.

### 5. Accept a concrete scope

The agent first writes the human-readable request below as
`.governance-artifacts/data-model-agent.request.json`. It contains only intent,
boundaries and acceptance semantics; no branch, commit or hash needs to be supplied by
the human. A reasonable first revision might contain criteria like these:

```json
{
  "version": 1,
  "revision": 1,
  "intent": "Provide a CLI that converts reviewed domain requirements into equivalent Mermaid ER and draw.io data models without silently inventing ambiguous relationships.",
  "intentSource": "direct-user:guided-intake",
  "boundaries": "Local Node CLI, canonical intermediate model, Mermaid ER and draw.io XML outputs. No database migration, deployment, provider provisioning or merge.",
  "criteria": [
    {
      "id": "MODEL-SEMANTICS",
      "outcome": "The canonical model preserves entities, attributes, primary and foreign keys, optionality and relationship cardinality from an accepted fixture.",
      "method": "Run a focused unit test against a literal expected canonical model."
    },
    {
      "id": "MERMAID-OUTPUT",
      "outcome": "The CLI emits a Mermaid ER diagram representing the accepted canonical model.",
      "method": "Run the CLI on the fixture and compare parsed entities and relationships with literal expected values."
    },
    {
      "id": "DRAWIO-OUTPUT",
      "outcome": "The CLI emits importable draw.io XML representing the same entities and relationships.",
      "method": "Parse the XML and assert the expected cells, labels and edges."
    },
    {
      "id": "AMBIGUITY",
      "outcome": "Ambiguous relationship requirements produce explicit clarification items and no invented cardinality.",
      "method": "Run an ambiguous fixture and assert the exact structured clarification result and absence of a fabricated edge."
    },
    {
      "id": "PROJECT-CHECKS",
      "outcome": "Configured syntax and unit checks pass on the exact candidate.",
      "method": "Run the syntax and unit commands configured in .governance/verification.json."
    }
  ]
}
```

The intentionally concrete acceptance checks matter more than the particular example.
For instance, an expected Mermaid relationship might include:

```mermaid
erDiagram
  CUSTOMER ||--o{ ORDER : places
```

The draw.io check should parse XML and establish the same relation; merely checking that
an output file exists is not acceptance.

Review and revise the semantic request first. When its intent, boundaries and acceptance
methods are correct, say:

```text
I accept semantic scope revision 1. Bind it to the current checkout and run the baseline,
but do not start implementation yet.
```

Create the final scope by binding that semantic request to the current checkout. The
command stores the branch and commit internally but prints only a readable success state
and the artifact path:

```sh
tools/governance scope create \
  --request .governance-artifacts/data-model-agent.request.json \
  --output .governance-artifacts/data-model-agent.scope.json

tools/governance scope validate \
  --scope .governance-artifacts/data-model-agent.scope.json

tools/governance baseline \
  --scope .governance-artifacts/data-model-agent.scope.json \
  --project .governance/project.json

tools/governance config validate --config .governance/config.json
```

`baseline` exits 2 and reports `incomplete` by design. It records machine observations,
then requires a human/lead review of authority, intent coverage, dirty-work ownership,
instructions and live dependencies. It is not a readiness oracle. A default config
reports workers as paused with effective capacity zero.

After reviewing the bound source and baseline, authorize implementation explicitly:

```text
Start implementation of accepted scope revision 1 using
$dev-stack-self-verifying-delivery. Do not merge, deploy, configure a provider or
activate a worker. Return to me if the scope or a test oracle is incomplete or
contradictory.
```

### 6. Let the bounded loop run

The delivery skill coordinates the workflow; it does not replace engineering judgment:

```text
accepted scope
  -> acceptance tests
  -> smallest complete implementation
  -> configured checks and direct artifact proof
  -> independent criterion and whole-intent verification
  -> classify the observation
       IMPLEMENTATION_DEFECT -> repair and verify a changed candidate
       SCOPE_GAP             -> human scope review
       TEST_ORACLE_INVALID   -> human acceptance review
       ENVIRONMENT_FAILED    -> repair the environment
       BLOCKED               -> human input or authority
       SCOPE_VERIFIED        -> final report
```

Each iteration is bound to the branch, commit and dirty-patch proof. The limits in
`.governance/self-verification.json` stop infinite repair. Tests may implement accepted
criteria, but the agent may not weaken criteria or tests merely to obtain green output.
Where possible, a different authorized agent/session or CI boundary performs the final
verification. If that is unavailable, the report must disclose the limitation and retain
human or CI review as the independent gate.

The final report should identify the candidate, show each criterion and its proof, list
commands run, describe limitations and residual risks, and name any remaining approval.
`SCOPE_VERIFIED` permits reporting only; it does not authorize merge or deployment.

## Starting any new feature or project request

For later work, use the same short sequence:

1. Create or select the approved worktree and a branch whose prefix appears in
   `.governance/project.json`.
2. Invoke `dev-stack-session-initialisation` and ask for guided intake if the request is
   not already precise.
3. Record one semantic scope request with stable criterion IDs, observable outcomes,
   proof methods and boundaries.
4. Have the human explicitly accept the scope and test semantics, then let `scope create`
   bind it to the current checkout automatically.
5. Invoke `dev-stack-self-verifying-delivery`.
6. Review the final source-bound report, then separately approve any PR, merge, release,
   deployment, provider or worker action.

If GitHub issue/PR actions will be used, start from the installed issue template and use
an `intentSource` such as `issue:42`. The reviewed `action plan`/`action apply` flow can
create or update supported repository records under explicit authority, but dev-stack has
no merge action. A direct-user source is sufficient for a local-only feature like the
example above.

## Adding project policy or quality rules

There are two different kinds of customization.

### Rules for one adopting project

Put concise, always-on project rules in root `AGENTS.md`, outside the
`dev-stack:begin`/`dev-stack:end` block. The installer preserves those bytes, and the
source-bound review treats root policy as a required condition.

For a larger project-owned policy:

1. create a user-owned file such as `docs/engineering-policy.md`;
2. link it from the user-owned part of `AGENTS.md`;
3. add its path to `instructionPaths` in `dev-stack.adapter.json`; and
4. run installer `plan`, review its paths/actions, `apply` the pending plan, and `verify`.

Configured instruction paths are included in review bundles and their bytes invalidate
stale repository-action plans. Do not hand-edit installed `delivery.json`: the next
upgrade will correctly stop on the local modification.

Project-specific quality expectations can be written as an explicit checklist in the
project-owned part of `AGENTS.md`. They are reviewed under the project-policy condition.
Use this route when the rule belongs to one product rather than every dev-stack adopter.

### Reusable rules for every dev-stack project

Change the dev-stack source and produce a new pinned release:

- add an always-on rule to `.governance/policy.md`;
- add a separately reported quality condition to the table in `.governance/quality.md`;
- add a conditional principle by creating
  `.governance/skills/principle-<name>/SKILL.md` and registering its trigger in
  `.governance/principles.md`.

Then update the review/test count invariants and `proof.json` where applicable, add any
new file to the sorted `release-inputs.json`, validate changed skills, run the full test
suites, rebuild `release.json`, and install/upgrade only through the reviewed new release.
Never edit an installed canonical file to disguise a project-only exception; local
modifications are deliberately preserved and block upgrades for review.

## Essential operational notes

- The adapter and governance files must not contain secrets.
- Verification commands are reviewed project code and may have side effects; listing a
  command does not authorize running it.
- Green commands prove command execution, not every criterion or the whole intent.
- Git commit, release, plan and evidence hashes remain in private artifacts and audit
  reports; people approve readable intent, criteria, paths, actions and authority.
- Worker support is optional and disabled by default. Model and provider choices are
  explicit local configuration, not bundled defaults.
- Do not run `tools/test-worker` casually. With an explicit worker configuration and
  credential it can make a provider call. Installation and normal local tests need no
  paid model call.
- Upgrade uses the same plan/review/apply/verify pattern. `recover`, `rollback` and
  `remove` preserve user-owned content and refuse uncertain state; see
  [operational recipes](recipes.md).
- Exact command schemas and exit meanings are in the [reference](reference.md); the
  architecture and trust boundaries are in [architecture](architecture.md); optional
  worker setup is in [workers](workers.md).
