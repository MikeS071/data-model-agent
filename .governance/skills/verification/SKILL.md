---
name: verification
description: Prove a delivered scope against its recorded intent and acceptance criteria using the project configured checks and actual artifacts.
---

# Verification

Read the recorded intent, revision, boundaries and criterion outcomes before choosing checks. Use the narrowest direct proof for each distinct behavior/safety boundary. Implement the approved scope, then run essential proof; reuse valid accepted evidence and required project CI. Do not initiate unrelated browser campaigns or model pilots.

`tools/governance verify run --scope FILE --project .governance/project.json --check ID` executes a command from committed `.governance/verification.json`, without a shell wrapper or retained raw output. Lead authority for that command is still required. Command success proves only command execution. Unsupported stacks, missing configuration or inaccessible runtime require explicit setup and remain incomplete.

Inspect the actual artifact/diff. Verify every criterion and the whole user intent independently; a worker's tests-passed claim or SCOPE_VERIFIED cannot satisfy this. Use source-bound `review plan`/`review check` and result inspection with the current source and actual native observations. Report process validation separately from functional success and retain defects/remaining criteria. UI behavior needs applicable actual UI/effect proof in the approved environment; docs need structural proof. Never replace required behavior evidence with a green compile or fabricated hashes.
