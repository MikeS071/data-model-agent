import { inspectProject } from "../core/project.mjs";
// Thin process boundary: keep the existing T1 schemas and outcome precedence authoritative.
import { readFileSync } from "node:fs";
import { validateScope, digest } from "../core/scope.mjs";
import { inspectConfig, inspectResult } from "../core/contracts.mjs";

try {
  const input = JSON.parse(readFileSync(0, "utf8"));
  let output;
  switch (process.argv[2]) {
    case "project": output = inspectProject(input); break;
    case "scope": validateScope(input); output = { digest: digest(input) }; break;
    case "config": output = inspectConfig(input.config, input.limits); break;
    case "result": output = inspectResult(input); break;
    default: throw new Error("unsupported");
  }
  process.stdout.write(JSON.stringify(output));
} catch {
  process.stdout.write(JSON.stringify({ error: "CONTRACT_INVALID" }));
  process.exitCode = 1;
}
