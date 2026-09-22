# Codex empty-project initialisation prompt

Open Codex in the empty directory that should become the project and paste this prompt.
The project name and GitHub owner are deliberately not hard-coded.

```text
This current directory is empty and should become a new dev-stack project. Bootstrap it
from https://github.com/EtnaJamesCapital/dev-stack.git, then start the guided feature
intake. Do not ask me for a release path, digest, hash, branch commit or adapter file.

First confirm the directory is empty. Ask me these bootstrap questions one at a time,
skipping any answer I have already supplied:

1. What should the project be called? Use that user-defined name for the repository name
   and readable project references.
2. Which GitHub user or organisation will own it?
3. Does that GitHub repository already exist? If it does, confirm its URL. If it does not,
   do not create a remote repository unless I separately authorize that external action.

Then show me a short readable bootstrap plan. It should initialise this directory as a
`main` Git repository, add the confirmed project origin only when it exists, create a
secret-free `dev-stack.adapter.json` for `<owner>/<project-name>` with `feature`, `fix`
and `chore` work prefixes, and install dev-stack from GitHub. Verification commands may
start empty because the application's stack has not been designed yet. Wait for my
approval of the plan before writing local project files.

After approval, clone the dev-stack GitHub repository into a temporary directory outside
this project. Read its `AGENTS.md`, project-initialisation skill and quickstart fully.
Use its installer to run `doctor`, then `plan` against this project and adapter. Show me
the installer's readable paths/actions and release version; keep internal identities
private. If the plan matches the approved bootstrap, run `apply` and `verify`. Do not copy
the dev-stack source tree by hand. Remove only the temporary clone you created after the
installation has verified.

Commit the local governance baseline on `main`, create `feature/<project-name>`, and run
$dev-stack-session-initialisation. Immediately begin the guided intake by asking one
critical unanswered question at a time about the first feature's intent, users,
boundaries and observable acceptance. Draft the human-readable request and ask me to
accept or revise it. Only after that request gate, clarify the technical foundation one
critical question at a time, including runtime, framework, storage, external services,
verification, sensitive-data and deployment boundaries. Draft the architecture/design
with Mermaid diagrams and decisions and ask me to accept or revise it as a separate gate.
Do not implement the application before both gates and separate implementation approval.

If the accepted feature contains visual or interactive UI work, use $ui-ux-pro-max only
for that UI portion. Do not use it for backend, API, database, infrastructure or other
non-visual work. Do not call a model provider, merge, deploy or activate a worker unless
I separately authorize that action.
```

The GitHub clone is only an installation source. It does not create the new project's
remote repository, publish code, select an application stack or authorize implementation.
