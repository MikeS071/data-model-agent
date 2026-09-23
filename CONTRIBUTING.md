# Contributing to Data Model Agent

Thank you for helping improve Data Model Agent. Keep changes focused, reviewable and
backed by evidence that the user-visible workflow still works.

## Before starting

1. Search existing issues and pull requests for related work.
2. Open an issue before a substantial feature, architectural change or breaking change.
3. Do not include API keys, real insurance records, proprietary schemas or other sensitive
   data in issues, commits, fixtures or screenshots.

## Local setup

```sh
git clone https://github.com/MikeS071/data-model-agent.git
cd data-model-agent
corepack enable
pnpm install --frozen-lockfile
cp apps/web/.env.example apps/web/.env.local
```

Provider credentials are only required for manual provider testing. Automated tests use
local substitutes and must not make paid or external model calls.

## Development workflow

1. Create a focused branch such as `feature/model-review` or `fix/chat-overflow`.
2. Add or update a behavioral test before implementing a bug fix or feature.
3. Make the smallest complete change and preserve unrelated local work.
4. Update the accepted request or design records when intent, acceptance or architecture
   changes materially.
5. Run the verification suite.

```sh
pnpm test
pnpm --dir apps/web exec tsc --noEmit
pnpm build
pnpm test:e2e
```

## Pull requests

A pull request should:

- explain the user problem and the chosen solution;
- stay within one coherent scope;
- identify any provider, persistence, privacy or migration impact;
- include tests for changed behavior;
- include screenshots for material UI changes;
- list the commands used to verify the result; and
- avoid generated databases, environment files, credentials and test artifacts.

By contributing, you agree that your contribution is licensed under the project's MIT
License.

