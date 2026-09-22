# Data Model Agent

A local, single-user pilot for turning insurance requirements and existing technical
artifacts into one reviewed canonical data model. The application derives Mermaid ER and
draw.io representations from that model, so both exports stay aligned.

The first worked example models Claim and Payment for a large insurance organisation.

## What you can do

- Start from free-form requirements and `.md`, `.txt`, `.sql`, `.ddl` or `.json` files.
- Save, reopen, edit or delete a model before making any OpenAI request.
- Generate a structured draft through a server-side OpenAI integration.
- Review assumptions, warnings and one clarification question at a time.
- Edit model definitions, entities, attributes, keys, references, layout, relationships
  and validation rules in structured forms.
- Ask the project assistant to change a built model while the structured editor remains
  visible beside the conversation.
- Autosave a working draft and deliberately create immutable versions.
- Preview and download Mermaid and draw.io output from the same canonical model.
- Reopen a saved version as a new working draft without changing its history.

## Before you run it

This is a local pilot, not a shared or production service. It has no authentication and
stores source material and models in an unencrypted local SQLite file. Clicking
**Generate** sends the entered requirements and attached source text to OpenAI. Use only
data that your organisation permits you to store locally and send to the configured
provider.

The browser never receives the OpenAI credential. The server validates structured model
responses before storing them, and uploaded DDL or SQL is treated as text—it is never
executed. Model-assistant messages, recent chat context and the current model are also
sent to OpenAI when you select **Send message**.

## Start the application

Requirements: Node.js, pnpm and an OpenAI API key.

```sh
cd /home/mikes/projects/self-verify/data-model-agent
pnpm install
cp apps/web/.env.example apps/web/.env.local
```

Edit `apps/web/.env.local`:

```dotenv
OPENAI_API_KEY=your-key
OPENAI_MODEL=your-approved-model
OPENAI_TIMEOUT_MS=120000
OPENAI_REASONING_EFFORT=low
OPENAI_MAX_OUTPUT_TOKENS=8000
DATA_MODEL_DB_FILE=data-model-agent.db
```

`OPENAI_MODEL` is deliberately a setting rather than a model hard-coded in the project.
Generation allows two minutes by default and uses low reasoning effort so normal model
work is not cut off by the former 45-second deadline. `OPENAI_MAX_OUTPUT_TOKENS` bounds
the combined reasoning and visible response budget. If a valid request reports
`provider-output-incomplete`, raise this value in measured increments; if the provider
reports `provider-timeout`, raise `OPENAI_TIMEOUT_MS` only after checking the server log
for the safe request duration and provider request ID. Restart the server after changing
any provider setting.

`DATA_MODEL_DB_FILE` is only a filename; the application keeps it under
`apps/web/data/`, which is excluded from Git.

Start the local server:

```sh
pnpm dev
```

Open `http://127.0.0.1:3000`.

## Run the Claim Payment workflow

1. Select **New**, name the model `Claim Payment`, and describe the insurance claim
   payment domain in **Requirements**. Select **Save model** whenever you want to keep the
   intake without contacting OpenAI; you can reopen, edit or delete it before generation.
2. Attach any available Markdown, schema, SQL, DDL or JSON files. The UI shows every
   accepted source before generation.
3. Select **Generate draft**. Review the visible transmission notice first.
4. Review the assumptions and warnings. If the draft asks a question, answer it and use
   **Update draft**; only the first open clarification is shown.
5. Refine the canonical model in the structured editor. Draft changes autosave. You can
   also ask the **Model assistant** for a change; its response and the fully validated
   revised model are saved together, and the updated fields remain visible beside chat.
6. Compare the Mermaid and draw.io previews and expand **Canonical JSON · read only** if
   you need to inspect the underlying model.
7. Select **Save version** when the draft is ready for review. Download either format or
   choose **Open as draft** on a historical version to continue from it.

If generation fails, the project, requirements and source files remain saved. A timeout,
rate limit, incomplete output, provider failure or invalid configuration is reported as a
specific error code. Correct the provider setting or retry later; a failed call does not
create a version. Server diagnostics contain timing, status, model configuration and the
provider request ID, but never the API key, requirements or source content.

## Verify the pilot

No test makes a live OpenAI call. Provider behavior is simulated at the server boundary,
and the browser journey uses deterministic API responses.

```sh
pnpm test
pnpm build
pnpm test:e2e
```

The browser test starts a local Next.js server and needs an installed Chrome browser.
The lower-level suite covers source normalization, canonical validation, OpenAI generation
and chat contracts, atomic transcript persistence, immutable versions and both renderers.

## Data and recovery

Stop the application before copying or replacing its SQLite file. To start again without
destroying the old pilot data, move `apps/web/data/data-model-agent.db` and its optional
`-wal`/`-shm` companions to a dated backup directory, then restart the application.

Production use needs a new accepted request and design covering authentication,
authorization, retention, encryption, approved provider configuration, monitoring and
deployment.

## Accepted scope and design

The human-readable two-gate records are:

- [`docs/features/data-model-agent/request.md`](docs/features/data-model-agent/request.md)
- [`docs/features/data-model-agent/design.md`](docs/features/data-model-agent/design.md)

New features and fixes should advance these records when they materially change intent or
architecture; they should not rewrite the accepted history silently.
