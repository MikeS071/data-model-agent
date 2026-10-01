<div align="center">

# Data Model Agent

Turn requirements and existing schemas into reviewable, versioned data models with
consistent Mermaid and draw.io outputs.

[![CI](https://github.com/MikeS071/data-model-agent/actions/workflows/ci.yml/badge.svg)](https://github.com/MikeS071/data-model-agent/actions/workflows/ci.yml)
[![Release](https://img.shields.io/github/v/release/MikeS071/data-model-agent?sort=semver)](https://github.com/MikeS071/data-model-agent/releases/latest)
[![License: MIT](https://img.shields.io/badge/License-MIT-0f766e.svg)](LICENSE)
[![Node.js](https://img.shields.io/badge/Node.js-%3E%3D20.9-339933?logo=nodedotjs&logoColor=white)](https://nodejs.org/)
[![Next.js](https://img.shields.io/badge/Next.js-16-black?logo=nextdotjs)](https://nextjs.org/)

[Getting started](#getting-started) · [Usage](#usage) · [Contributing](CONTRIBUTING.md) · [Security](SECURITY.md) · [Releases](https://github.com/MikeS071/data-model-agent/releases)

</div>

## Purpose

Data Model Agent is a local-first modelling workspace for turning incomplete business
requirements, schemas, DDL and documentation into one editable canonical data model.
It combines structured editing with an AI-assisted clarification workflow, then derives
Mermaid ER and draw.io representations from the same source of truth.

The included pilot is designed around claim-payment modelling for a large insurance
organisation. The modelling workflow is reusable, but the current application is a
single-user local pilot—not a production multi-user service.

## Highlights

- Start with free-form requirements and `.md`, `.txt`, `.sql`, `.ddl` or `.json` files.
- Save, reopen, edit or delete a model before making a provider request.
- Generate and refine a validated canonical model through an OpenAI-compatible Responses
  API.
- Work with a pannable, zoomable model canvas and the model assistant side by side.
- Answer one critical clarification question at a time; successful answers update the
  canonical model.
- Keep the original requirements editable as persistent model instructions.
- Edit entities, attributes, keys, references, cardinalities, rules and layout metadata in
  structured forms.
- Save immutable review versions and reopen any version as a new working draft.
- Preview and download equivalent Mermaid ER and draw.io representations.
- Keep long human, assistant and clarification messages readable with bounded scrolling.

## How it works

```mermaid
flowchart LR
    A[Requirements and source files] --> B[Next.js application]
    B --> C[OpenAI-compatible provider]
    C --> D[Validated canonical model]
    B --> E[(Local SQLite)]
    D --> E
    D --> F[Mermaid ER]
    D --> G[draw.io XML]
    H[Structured editor and chat] --> B
```

The browser never receives the provider credential. DDL and SQL inputs are treated as
inert text and are never executed. Provider responses are validated before they replace
the saved working draft.

## Technology

- Next.js 16 and React 19
- TypeScript
- Node.js built-in SQLite
- Mermaid
- OpenAI-compatible Responses API
- Vitest, Testing Library and Playwright
- dev-stack governance and self-verification records

## Getting started

### Prerequisites

- Node.js 20.9 or newer; Node.js 22 LTS is recommended.
- pnpm 10.32.1.
- Either a GitHub Copilot subscription with CLI OAuth access, or an API key and model name for an OpenAI-compatible Responses API provider.
- VS Code 1.137 or newer for the recommended local VS Code provider bridge.
- Chrome for the end-to-end browser test.

### Installation

1. Clone the repository.

   ```sh
   git clone https://github.com/MikeS071/data-model-agent.git
   cd data-model-agent
   ```

2. Enable the package manager and install dependencies.

   ```sh
   corepack enable
   pnpm install --frozen-lockfile
   ```

3. Create the local environment file.

   ```sh
   cp apps/web/.env.example apps/web/.env.local
   ```

4. Choose a provider in `apps/web/.env.local`.

   For local testing through the signed-in VS Code Copilot provider:

   ```dotenv
   MODEL_PROVIDER=vscode-agent-host
   VSCODE_AGENT_HOST_MODEL=gpt-5.6-sol
   VSCODE_AGENT_HOST_TIMEOUT_MS=300000
   DATA_MODEL_DB_FILE=data-model-agent.db
   ```

   Build the local UI extension, then launch an Extension Development Host:

   ```sh
   pnpm build:vscode-provider
   code --extensionDevelopmentPath=apps/vscode-provider --new-window .
   ```

   To install the compiled extension for subsequent normal VS Code windows, run
   `pnpm --dir apps/vscode-provider install:local` and reload VS Code.

   The extension listens on a user-local named pipe or Unix socket and calls the supported
   `vscode.lm` API. It does not expose an HTTP port, provider credential or tool. A random local
   bridge token and endpoint are written to a user-only connection record. The first request must
   come from an explicit **Generate** or chat action and may display VS Code's model-consent dialog.
   Use `pnpm --dir apps/vscode-provider check:bridge` to verify bridge health and
   `pnpm --dir apps/vscode-provider check:models` to list models without making an inference call.

   For local GitHub Copilot SDK testing:

   ```dotenv
   MODEL_PROVIDER=copilot-sdk
   COPILOT_MODEL=gpt-5.6-sol
   COPILOT_TIMEOUT_MS=120000
   COPILOT_REASONING_EFFORT=xhigh
   DATA_MODEL_DB_FILE=data-model-agent.db
   ```

   The bundled Copilot CLI uses the signed-in user's GitHub OAuth credentials. Model calls use
   the user's Copilot entitlement and may count as premium requests. The server exposes no tools,
   rejects permission requests and deletes each local SDK session after the structured response.
   Sign in once with the GitHub Copilot CLI before starting the server; the SDK reads credentials
   from `COPILOT_HOME` (or `~/.copilot`). On managed Windows devices, IT may need to approve the
   SDK's signed `copilot-runtime.exe`.

   For an OpenAI-compatible Responses API:

   ```dotenv
   MODEL_PROVIDER=openai
   OPENAI_API_KEY=your-provider-key
   OPENAI_BASE_URL=https://api.openai.com/v1
   OPENAI_MODEL=your-approved-model
   OPENAI_TIMEOUT_MS=120000
   OPENAI_REASONING_EFFORT=low
   OPENAI_MAX_OUTPUT_TOKENS=8000
   DATA_MODEL_DB_FILE=data-model-agent.db
   ```

5. Start the application.

   ```sh
   pnpm dev
   ```

6. Open [http://127.0.0.1:3000](http://127.0.0.1:3000).

The provider, configured model and OpenAI-compatible base URL provide defaults for new projects.
You can change those defaults from **Settings** without restarting. Each project stores its own
provider/model selection, initialized from those defaults, so changing global settings does not
silently alter an existing model. Credentials remain server-side and are never displayed or stored
by the settings UI.

## Configuration

| Variable | Required | Default | Purpose |
| --- | --- | --- | --- |
| `MODEL_PROVIDER` | No | `openai` | Provider adapter: `openai`, `copilot-sdk` or `vscode-agent-host`. |
| `OPENAI_API_KEY` | OpenAI mode | — | Server-side credential for the OpenAI-compatible provider. |
| `OPENAI_BASE_URL` | No | `https://api.openai.com/v1` | Initial OpenAI-compatible API base URL. |
| `OPENAI_MODEL` | OpenAI mode | — | Initial OpenAI-compatible provider model name. |
| `OPENAI_TIMEOUT_MS` | No | `120000` | Maximum duration of a generation or chat request. |
| `OPENAI_REASONING_EFFORT` | No | `low` | Reasoning effort sent to compatible providers. |
| `OPENAI_MAX_OUTPUT_TOKENS` | No | `8000` | Combined response budget for a provider request. |
| `COPILOT_MODEL` | Copilot mode | — | Model ID exposed to the signed-in Copilot account. |
| `COPILOT_TIMEOUT_MS` | No | `120000` | Maximum time to wait for the Copilot SDK session. |
| `COPILOT_REASONING_EFFORT` | No | `high` | Copilot reasoning effort (`low` through `max`). |
| `COPILOT_HOME` | No | `~/.copilot` | Copilot CLI credential and state directory. |
| `VSCODE_AGENT_HOST_MODEL` | VS Code mode | — | Copilot model ID selected through `vscode.lm`. |
| `VSCODE_AGENT_HOST_CONNECTION_FILE` | No | `~/.data-model-agent/vscode-provider-v2.json` | Machine-local connection record shared with the extension setting. |
| `VSCODE_AGENT_HOST_TIMEOUT_MS` | No | `300000` | Maximum time to wait for a VS Code language-model response. |
| `DATA_MODEL_DB_FILE` | No | `data-model-agent.db` | SQLite filename under `apps/web/data/`. |

## Usage

1. Select **New model**, enter a model name and describe the domain in **Requirements**.
2. Attach any relevant Markdown, schema, SQL, DDL or JSON files.
3. Choose **Save model** to keep the intake without contacting the provider, or
   **Generate draft** to create the first canonical model.
4. Follow the durable generation job's phases, elapsed time, heartbeat and provider transcript.
   The job survives page reloads; jobs still running after an application restart are marked
   interrupted and can be retried.
5. In the model detail screen, edit the persistent requirements, attachment text, provider and
   model used by subsequent requests. Save those generation inputs without contacting the provider.
6. The canonical model changes only after the complete response passes schema and domain validation.
7. Review the live Mermaid or draw.io view alongside the model assistant. Answer the
   displayed clarification question or request another change in chat.
8. Refine the structured model fields. Draft edits
   autosave locally.
9. Review assumptions, warnings and canonical JSON before selecting **Save version**.
10. Download Mermaid or draw.io from version history, or reopen a prior version as a new
   draft.

Generation and assistant messages send the current requirements, source context and model
to the configured provider. Use only information your organisation permits you to store
locally and transmit to that provider.

## Development and verification

```sh
pnpm test
pnpm --dir apps/web exec tsc --noEmit
pnpm build
pnpm test:e2e
```

Tests use deterministic provider substitutes and never make a live paid model call. The
GitHub Actions workflow runs the unit tests, TypeScript check and production build. Run
the Playwright workflow locally when changing interactive behavior.

The accepted request and design are retained in:

- [`docs/features/data-model-agent/request.md`](docs/features/data-model-agent/request.md)
- [`docs/features/data-model-agent/design.md`](docs/features/data-model-agent/design.md)

## Data, privacy and recovery

The pilot has no authentication and stores model content in an unencrypted local SQLite
database. It is suitable for controlled local evaluation, not production or shared use.

Stop the application before backing up or replacing the database. Copy
`apps/web/data/data-model-agent.db` and any matching `-wal` or `-shm` files together. The
entire `apps/web/data/` directory, local environment files and provider credentials are
excluded from Git.

Production adoption requires an explicit design covering authentication, authorization,
encryption, retention, provider governance, monitoring and deployment.

## Contributing

Contributions are welcome. Read [CONTRIBUTING.md](CONTRIBUTING.md) for the development
workflow and pull-request checklist. Use
[GitHub Issues](https://github.com/MikeS071/data-model-agent/issues) for reproducible bugs
and focused feature proposals.

## Security

Do not report vulnerabilities in public issues. Follow the private reporting process in
[SECURITY.md](SECURITY.md), and never include provider keys, proprietary schemas or live
organisational data in a report.

## License

Distributed under the MIT License. See [LICENSE](LICENSE) for the complete terms.

## Acknowledgements

- README structure inspired by the
  [Best README Template](https://github.com/othneildrew/Best-README-Template).
- Project governance is based on
  [dev-stack](https://github.com/EtnaJamesCapital/dev-stack).
