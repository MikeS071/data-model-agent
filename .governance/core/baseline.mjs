import { validateScope, digest } from './scope.mjs';
import { inspectProject } from './project.mjs';
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { existsSync, readFileSync, realpathSync } from 'node:fs';
import { join } from 'node:path';
const instructionPaths = ['AGENTS.md'];
const fail = code => { throw new Error(code); };
function git(cwd, args) {
  const result = spawnSync("git", ["--no-optional-locks", "-c", "core.fsmonitor=false", ...args], {
    cwd, encoding: "utf8", timeout: 10_000, stdio: ["ignore", "pipe", "pipe"],
  });
  if (result.error || result.status !== 0) fail("GIT_UNAVAILABLE");
  return result.stdout.trim();
}

export function inspectBaseline({ cwd, scope, project }) {
  validateScope(scope);
  const { repository } = inspectProject(project);
  const checkout = git(cwd, ["rev-parse", "--show-toplevel"]);
  const remote = git(checkout, ["remote", "get-url", "origin"]);
  if (![`https://github.com/${repository}`, `git@github.com:${repository}`]
    .some((canonical) => remote === canonical || remote === `${canonical}.git`)) fail("REPOSITORY_MISMATCH");
  const source = { ref: git(checkout, ["branch", "--show-current"]), sha: git(checkout, ["rev-parse", "HEAD"]) };
  if (source.ref !== scope.source.ref || source.sha !== scope.source.sha) fail("SOURCE_MISMATCH");
  if (!project.branchPrefixes.includes(source.ref.split("/")[0])) fail("SOURCE_MISMATCH");
  if (realpathSync(join(checkout, "AGENTS.md")) !== join(checkout, "AGENTS.md")) fail("BASELINE_UNAVAILABLE");
  if (existsSync(join(checkout, "package.json")) && realpathSync(join(checkout, "package.json")) !== join(checkout, "package.json")) fail("BASELINE_UNAVAILABLE");
  let instructions, commands;
  try {
    instructions = instructionPaths.map((path) => ({ path,
      sha256: createHash("sha256").update(readFileSync(join(checkout, path))).digest("hex") }));
    // Report names only; never evaluate package scripts or load environment files.
    commands = existsSync(join(checkout, "package.json")) ? Object.keys(JSON.parse(readFileSync(join(checkout, "package.json"), "utf8")).scripts ?? {}).sort() : [];
  } catch { fail("BASELINE_UNAVAILABLE"); }
  return { status: "incomplete", machineChecks: "passed", repository, remote, checkout, source,
    scopeRevision: scope.revision, dirty: git(checkout, ["status", "--porcelain", "--untracked-files=normal"]) !== "",
    instructions, declaredCommands: commands, projectDigest: digest(project), runtime: "not-observed",
    requiredLeadReview: ["authority-and-intent-coverage", "dirty-work-ownership", "task-specific-instructions", "live-dependencies-and-target"],
    nextAction: "Complete lead review in the existing task record before implementation or dispatch" };
}

