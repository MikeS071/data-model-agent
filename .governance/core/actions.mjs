import { inspectDelivery } from "./delivery.mjs";
import { execFileSync } from "node:child_process";
import { existsSync, lstatSync, mkdirSync, readFileSync, realpathSync, writeFileSync, openSync, closeSync, unlinkSync } from "node:fs";
import { basename, dirname, join, relative, resolve, sep } from "node:path";
import { digest, validateScope } from "./scope.mjs";
import { inspectConfig } from "./contracts.mjs";
import { fail, makePlan, requireState, validatePlan, validateRequest } from "./plan.mjs";

const sha = value => /^[a-f0-9]{40}$/u.test(value);
const read = path => JSON.parse(readFileSync(path, "utf8"));
export const git = (root, ...args) => execFileSync("git", ["--no-optional-locks", "-C", root, ...args], { encoding: "utf8", timeout: 30000, stdio: ["ignore", "pipe", "pipe"] }).trim();
export function github(path, data, paginate = false, execute = execFileSync) {
  const args = ["api", "--hostname", "github.com", path];
  if (data !== undefined) args.push("--method", data.method, "--input", "-");
  if (paginate) args.push("--paginate", "--jq", ".[] | @json");
  try {
    const output = execute("gh", args, { encoding: "utf8", timeout: 30000, input: data === undefined ? undefined : JSON.stringify(data.body), stdio: ["pipe", "pipe", "pipe"] }).trim();
    return paginate ? (output ? output.split("\n").map(line => JSON.parse(line)) : []) : JSON.parse(output);
  } catch { fail(2, "github-state-unavailable"); }
}
export function context(cwd, delivery) {
  inspectDelivery(delivery); const { repository } = delivery.project;
  const root = git(cwd, "rev-parse", "--show-toplevel");
  requireState([`https://github.com/${repository}`, `https://github.com/${repository}.git`, `git@github.com:${repository}.git`].includes(git(root, "remote", "get-url", "origin")), 1, "repository-invalid");
  const config = read(projectFile(root, ".governance/config.json")); inspectConfig(config);
  return { root, config, delivery, get templates() { return { issue: readFileSync(projectFile(root, delivery.templates.issue), "utf8"), pr: readFileSync(projectFile(root, delivery.templates.pr), "utf8") }; } };
}
export function projectFile(root, input) {
  requireState(typeof input === "string", 1, "input-file-required");
  const path = resolve(root, input), rel = relative(root, path);
  requireState(rel && !rel.startsWith(`..${sep}`) && rel !== ".." && !lstatSync(path).isSymbolicLink() && realpathSync(path) === path, 1, "input-path-invalid");
  requireState(lstatSync(path).isFile() && lstatSync(path).size <= 200000, 1, "input-size-invalid");
  return path;
}
export function localSnapshot(ctx, scope) {
  validateScope(scope); const { repository } = ctx.delivery.project; const ref = git(ctx.root, "branch", "--show-current"), head = git(ctx.root, "rev-parse", "HEAD");
  requireState(sha(head) && /^[a-z][a-z0-9-]*\/[a-z0-9][a-z0-9/-]*$/u.test(ref) && ctx.delivery.project.branchPrefixes.includes(ref.split("/")[0]), 3, "source-conflict");
  let scopeAncestor = false;
  try { git(ctx.root, "merge-base", "--is-ancestor", scope.source.sha, head); scopeAncestor = true; } catch { /* Conflict, not a fallback source. */ }
  const instructions = [...new Set([...ctx.delivery.instructionPaths, ...Object.values(ctx.delivery.templates)])];
  return { repository, baseBranch: ctx.delivery.baseBranch, rootDigest: digest(ctx.root), ref, head, clean: git(ctx.root, "status", "--porcelain") === "", scopeAncestor,
    configDigest: digest(ctx.config), deliveryDigest: digest(ctx.delivery), instructionsDigest: digest(instructions.map(path => [path, digest(readFileSync(projectFile(ctx.root, path), "utf8"))])) };
}
const metadata = record => ({ labels: (record.labels ?? []).map(x => typeof x === "string" ? x : x.name).sort(), milestone: record.milestone?.number ?? null });
const core = (record, kind) => ({ title: record.title, body: record.body, state: record.state, ...(kind === "pr" ? { head: record.head?.sha, ref: record.head?.ref, base: record.base?.ref, repository: record.head?.repo?.full_name } : {}) });
const marker = plan => `<!-- governance-plan-${plan.planDigest} -->`;
const expectedCore = (plan, request) => ({ title: request.payload.title, body: `${request.payload.body}\n\n${marker(plan)}`, state: "open",
  ...(request.kind === "pr" ? { head: plan.snapshot.local.head, ref: plan.snapshot.local.ref, base: plan.snapshot.local.baseBranch, repository: plan.snapshot.local.repository } : {}) });
const expectedMetadata = request => ({ labels: [...request.payload.labels].sort(), milestone: request.payload.milestone });
const equal = (a, b) => digest(a) === digest(b);

export function adapter(ctx, api = github) {
  const { repository } = ctx.delivery.project;
  const repoPath = path => `repos/${repository}/${path}`;
  const issue = number => api(repoPath(`issues/${number}`));
  const target = (kind, number) => api(repoPath(`${kind === "pr" ? "pulls" : "issues"}/${number}`));
  const worktreePath = request => join(basename(dirname(ctx.root)) === ".worktrees" ? dirname(ctx.root) : join(ctx.root, ".worktrees"), request.payload.name);
  const worktree = request => {
    const path = worktreePath(request);
    if (!existsSync(path)) return null;
    requireState(!lstatSync(path).isSymbolicLink() && realpathSync(path) === path, 3, "worktree-path-conflict");
    const registered = git(ctx.root, "worktree", "list", "--porcelain").split("\n").includes(`worktree ${path}`);
    requireState(registered, 3, "worktree-path-conflict");
    return { pathDigest: digest(path), ref: git(path, "branch", "--show-current"), head: git(path, "rev-parse", "HEAD") };
  };
  return {
    snapshot(request, scope, ownedNumber = null) {
      validateRequest(request, scope, ctx.templates, ctx.delivery);
      const local = localSnapshot(ctx, scope), user = api("user"), repo = api(`repos/${repository}`);
      requireState(/^[a-zA-Z0-9-]{1,39}$/u.test(user.login), 2, "actor-unavailable");
      const parent = issue(request.target.parent), queue = ctx.delivery.queue === null ? null : issue(ctx.delivery.queue), active = request.target.issue ? issue(request.target.issue) : null;
      const deps = request.dependencies.map(issue);
      let duplicates = [], current = null, targetValid = true, labelsValid = true, milestoneValid = true;
      if (request.kind === "worktree") {
        current = worktree(request); targetValid = current === null;
        const base = dirname(worktreePath(request)); requireState(existsSync(base) ? realpathSync(base) === base : base === join(ctx.root, ".worktrees"), 3, "worktree-path-conflict");
        try { git(ctx.root, "show-ref", "--verify", "--quiet", `refs/heads/${request.payload.branch}`); targetValid = false; } catch (error) { if (error.status !== 1) fail(2, "branch-state-unavailable"); }
      } else {
        const labels = api(repoPath("labels?per_page=100"), undefined, true).map(x => x.name);
        labelsValid = request.payload.labels.every(label => labels.includes(label));
        const milestones = api(repoPath("milestones?state=all&per_page=100"), undefined, true);
        milestoneValid = request.payload.milestone === null || milestones.some(x => x.number === request.payload.milestone && x.state === "open");
        if (request.target.number) {
          current = target(request.kind, request.target.number);
          targetValid = current.state === "open" && (request.kind === "pr" ? current.head?.ref === local.ref && current.head?.sha === local.head && current.base?.ref === ctx.delivery.baseBranch && current.head?.repo?.full_name === repository : !current.pull_request);
        }
        if (request.kind === "pr") {
          const remote = api(repoPath(`git/ref/heads/${local.ref}`));
          targetValid = targetValid && remote.object?.sha === local.head;
          duplicates = api(repoPath(`pulls?state=all&head=${encodeURIComponent(`${repository.split("/")[0]}:${local.ref}`)}&per_page=100`), undefined, true).filter(x => x.number !== request.target.number && x.number !== ownedNumber).map(x => x.number);
          if (request.operation === "create") targetValid = targetValid && duplicates.length === 0;
        } else {
          const words = request.payload.title.replace(/[^a-zA-Z0-9 -]/gu, " ");
          const found = api(`search/issues?q=${encodeURIComponent(`repo:${repository} is:issue in:title ${words}`)}&per_page=100`);
          requireState(found.incomplete_results === false && found.total_count <= 100, 2, "duplicate-search-incomplete");
          duplicates = found.items.filter(x => x.number !== request.target.number && x.number !== ownedNumber && x.title.toLowerCase() === request.payload.title.toLowerCase()).map(x => x.number);
        }
      }
      const staging = api(repoPath(`git/ref/heads/${ctx.delivery.baseBranch}`)); requireState(sha(staging.object?.sha), 2, "staging-source-unavailable");
      return { local, actor: { login: user.login, canWrite: repo.full_name === repository && repo.permissions?.push === true },
        context: { parentOpen: parent.state === "open", queueLinked: queue === null || queue.body.includes(`#${request.target.parent}`), issueOpen: !active || active.state === "open",
          dependenciesClosed: deps.every(x => x.state === "closed"), labelsValid, milestoneValid, duplicates: duplicates.sort((a,b) => a-b), targetValid,
          recordsDigest: digest([parent, queue, active, ...deps].map(x => x ? [x.number, x.state, x.body, x.updated_at] : null)), staging: staging.object.sha,
          targetDigest: current === null ? null : digest(request.kind === "worktree" ? current : { core: core(current, request.kind), metadata: metadata(current), state: current.state }), beforeMetadata: current === null || request.kind === "worktree" ? null : metadata(current) } };
    },
    read: target,
    find(plan, request) {
      const found = api(`search/issues?q=${encodeURIComponent(`repo:${repository} in:body governance-plan-${plan.planDigest}`)}&per_page=100`);
      requireState(found.incomplete_results === false && found.total_count <= 100, 2, "write-outcome-unknown");
      const matches = found.items.filter(x => x.body?.includes(marker(plan)) && Boolean(x.pull_request) === (request.kind === "pr"));
      requireState(matches.length <= 1, 3, "duplicate-operation-conflict");
      return matches[0]?.number ?? null;
    },
    writeCore(plan, request) {
      const payload = expectedCore(plan, request), number = request.target.number;
      const body = { title: payload.title, body: payload.body };
      if (request.kind === "issue") Object.assign(body, expectedMetadata(request));
      if (request.kind === "pr" && !number) Object.assign(body, { head: payload.ref, base: ctx.delivery.baseBranch });
      return api(repoPath(`${request.kind === "pr" ? "pulls" : "issues"}${number ? `/${number}` : ""}`), { method: number ? "PATCH" : "POST", body }).number;
    },
    writeMetadata: (number, request) => api(repoPath(`issues/${number}`), { method: "PATCH", body: expectedMetadata(request) }),
    worktree,
    prepare(plan, request) {
      const path = worktreePath(request); mkdirSync(dirname(path), { recursive: true });
      requireState(realpathSync(dirname(path)) === dirname(path), 3, "worktree-path-conflict");
      git(ctx.root, "worktree", "add", "-b", request.payload.branch, path, plan.snapshot.local.head);
    },
  };
}

// The reviewed plan's adjacent receipt preserves uncertainty, not authority or an agent registry.
export function applyPlan({ plan, request, scope, templates, delivery, adapter: io, receipt: receipts }) {
  inspectDelivery(delivery); const { repository } = delivery.project;
  validateRequest(request, scope, templates, delivery);
  const { planDigest, ...unsigned } = plan;
  requireState(digest(unsigned) === planDigest && plan.requestDigest === digest(request) && plan.scopeDigest === digest(scope) && plan.deliveryDigest === digest(delivery), 1, "plan-invalid");
  requireState(request.authority !== null, 2, "authority-missing");
  let receipt = receipts.read();
  if (receipt) requireState(receipt.version === 1 && receipt.planDigest === plan.planDigest, 3, "receipt-conflict");
  if (request.kind === "worktree") {
    if (receipt) {
      const found = io.worktree(request);
      requireState(found && found.head === plan.snapshot.local.head && found.ref === request.payload.branch, 2, "worktree-outcome-unknown");
      receipts.write({ version: 1, planDigest, state: "verified", number: null });
      return { state: "already-applied", source: found, next: "run-session-baseline; optional-discovery-requires-project-configuration" };
    }
    validatePlan(plan, request, scope, io.snapshot(request, scope), templates, delivery);
    receipts.write({ version: 1, planDigest, state: "started", number: null }, true);
    try { io.prepare(plan, request); } catch { fail(2, "worktree-outcome-unknown"); }
    const found = io.worktree(request);
    requireState(found?.head === plan.snapshot.local.head && found?.ref === request.payload.branch, 2, "worktree-readback-mismatch");
    receipts.write({ version: 1, planDigest, state: "verified", number: null });
    return { state: "applied", source: found, next: "run-session-baseline; optional-discovery-requires-project-configuration" };
  }
  let number = receipt?.number ?? null;
  if (receipt && number === null) number = io.find(plan, request);
  if (receipt) {
    requireState(number !== null && (!request.target.number || number === request.target.number), 2, "write-outcome-unknown");
    const found = io.read(request.kind, number);
    requireState(equal(core(found, request.kind), expectedCore(plan, request)), 3, "target-readback-conflict");
    if (equal(metadata(found), expectedMetadata(request))) {
      receipts.write({ version: 1, planDigest, state: "verified", number });
      return { state: "already-applied", number, repository, next: "reconcile-existing-issue-parent-queue" };
    }
    requireState(request.kind === "pr" && equal(metadata(found), plan.snapshot.context.beforeMetadata ?? { labels: [], milestone: null }), 3, "metadata-readback-conflict");
  }
  const observed = io.snapshot(request, scope, number);
  const current = receipt && request.target.number ? { ...observed, context: { ...observed.context, targetDigest: plan.snapshot.context.targetDigest } } : observed;
  // Partial PR metadata resumes only if every pre-write record/source still matches.
  validatePlan(plan, request, scope, current, templates, delivery);
  if (!receipt) {
    receipts.write({ version: 1, planDigest, state: "started", number: request.target.number }, true);
    try { number = io.writeCore(plan, request); } catch { fail(2, "write-outcome-unknown"); }
    requireState(Number.isSafeInteger(number) && number > 0, 2, "write-outcome-unknown");
    receipts.write({ version: 1, planDigest, state: "written", number });
  }
  requireState(equal(core(io.read(request.kind, number), request.kind), expectedCore(plan, request)), 3, "target-readback-conflict");
  if (request.kind === "pr") { try { io.writeMetadata(number, request); } catch { fail(2, "write-outcome-unknown"); } }
  const verified = io.read(request.kind, number);
  requireState(equal(core(verified, request.kind), expectedCore(plan, request)) && equal(metadata(verified), expectedMetadata(request)), 3, "target-readback-conflict");
  receipts.write({ version: 1, planDigest, state: "verified", number });
  return { state: "applied", number, repository, next: "reconcile-existing-issue-parent-queue" };
}
export function receiptFile(path) {
  const file = `${path}.receipt.json`;
  requireState(relative(git(dirname(path), "rev-parse", "--show-toplevel"), path).startsWith(`.governance-artifacts${sep}`), 1, "plan-artifact-path-invalid");
  git(dirname(path), "check-ignore", "--quiet", file);
  const guard = () => { if (existsSync(file)) requireState(!lstatSync(file).isSymbolicLink() && realpathSync(file) === file && lstatSync(file).size <= 2000, 3, "receipt-conflict"); };
  return { read() { guard(); return existsSync(file) ? read(file) : null; }, write(value, exclusive = false) {
    guard(); writeFileSync(file, `${JSON.stringify(value)}\n`, { mode: 0o600, flag: exclusive ? "wx" : "w" });
  } };
}

export function withApplyLock(path, action) {
  const lock = `${path}.lock`;
  let fd;
  try { fd = openSync(lock, "wx", 0o600); } catch { fail(2, "apply-in-progress-or-interrupted"); }
  try { return action(); } finally { closeSync(fd); unlinkSync(lock); }
}
