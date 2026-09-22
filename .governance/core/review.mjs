import assert from "node:assert/strict";
import { digest, validateScope } from "./scope.mjs";
import { verificationPlan } from "./verification.mjs";
import { inspectDelivery } from "./delivery.mjs";
const isDocumentationPath = path => /^(?:AGENTS\.md|README\.md|(?:docs|\.governance\/(?:docs|skills|templates))\/[A-Za-z0-9_./-]+\.md)$/u.test(path);
import { git } from "./actions.mjs";

const keys = (value, names) => assert.deepEqual(Object.keys(value).sort(), [...names].sort());
const proof = value => assert.match(value ?? "", /^sha256:[a-f0-9]{64}$/u);
const slug = text => text.toLowerCase().replace(/[^a-z0-9]+/gu, "-").replace(/^-|-$/gu, "");
export function principleEntries(catalogue) {
  const rows = [...catalogue.matchAll(/^\| \[([^\]]+)\]\((skills\/principle-([a-z0-9-]+)\/SKILL\.md)\) \| ([^|]+) \|$/gmu)]
    .map(([, title, path, name, when]) => ({ id: `principle:${name}`, title, skill: `.governance/${path}`, when, conditional: true }));
  assert.ok(rows.length && new Set(rows.map(x => x.id)).size === rows.length, "Invalid principle catalogue");
  assert.equal(catalogue.split("\n").filter(line => line.startsWith("| [")).length, rows.length, "Malformed principle entry");
  return rows;
}

export function reviewPolicy(agents, programme, catalogue = "", leaves = {}) {
  const principles = agents.split("## Core engineering principles\n")[1]?.split("\n## ")[0];
  const quality = programme.split("### Additional code-quality review conditions\n")[1]?.split("\n### ")[0];
  assert.ok(principles && quality, "Canonical review policy unavailable");
  const items = [...[...principles.matchAll(/^### (.+)$/gmu)].map(([, title]) => ({ id: `principle:${slug(title)}`, title })),
    ...[...quality.matchAll(/^\| ([^|]+) \| ([^|]+) \|$/gmu)].filter(([, title]) => title !== "Condition" && title !== "---").map(([, title]) => ({ id: `quality:${slug(title)}`, title }))];
  assert.equal(items.filter(x => x.id.startsWith("principle:")).length, 5); assert.equal(items.length, 15);
  assert.ok(catalogue || !agents.includes("principles.md"), "Canonical principle catalogue unavailable");
  for (const item of catalogue ? principleEntries(catalogue) : []) {
    const leaf = leaves[item.skill];
    assert.equal(typeof leaf, "string", "Canonical principle leaf unavailable");
    assert.ok(leaf.startsWith(`---\nname: ${item.id.replace("principle:", "principle-")}\n`) && /^# .+/mu.test(leaf), "Malformed principle leaf");
    items.push(item);
  }
  assert.equal(new Set(items.map(x => x.id)).size, items.length);
  return { version: 2, items, digest: digest({ principles, quality, catalogue, leaves }) };
}
export function category(path) {
  if (/(?:^|\/)(?:pnpm-lock\.yaml|package-lock\.json|yarn\.lock|Cargo\.lock|poetry\.lock)$|(?:^|\/)generated\//u.test(path)) return "generated-lockfile";
  if (isDocumentationPath(path)) return "documentation";
  if (/(?:^|\/)(?:tests?|__tests__|e2e)\/|(?:^|[/.])(?:test|spec)[._/]|(?:^|\/)test[-_][^/]+$/u.test(path)) return "test";
  if (/\.(?:[cm]?[jt]sx?|py|sh|bash|go|rs|sql|prisma|css|scss|html|json|ya?ml|toml)$/u.test(path) || /^(?:(?:\.governance\/tooling\/)?tools\/[^/.]+|(?:\.governance\/adapters\/)?\.githooks\/[^/]+)$/u.test(path)) return "implementation";
  return "other"; // Unknown and binary paths remain visible and conservatively need review.
}
export function diffSize(raw) {
  const files = raw.split("\0").filter(Boolean).map(row => {
    const match = /^(\d+|-)\t(\d+|-)\t([\s\S]+)$/u.exec(row); assert.ok(match, "Invalid numstat");
    const [, adds, dels, path] = match, binary = adds === "-" || dels === "-";
    return { path, category: category(path), additions: binary ? null : Number(adds), deletions: binary ? null : Number(dels), binary };
  }).sort((a, b) => a.path.localeCompare(b.path));
  const sum = rows => ({ textLines: rows.reduce((n, x) => n + (x.additions ?? 0) + (x.deletions ?? 0), 0), binaryFiles: rows.filter(x => x.binary).length });
  const totals = sum(files);
  return { files, ...totals, total: totals.binaryFiles ? null : totals.textLines,
    categories: Object.fromEntries(["implementation", "test", "documentation", "generated-lockfile", "other"].map(name => [name, sum(files.filter(x => x.category === name))])) };
}

export function reviewPlan({ cwd, scope, head, reviewBase, stagingBase, delivery }, select = verificationPlan) {
  validateScope(scope); inspectDelivery(delivery);
  for (const value of [head, reviewBase, stagingBase]) assert.match(value ?? "", /^[a-f0-9]{40}$/u);
  assert.equal(git(cwd, "rev-parse", "HEAD"), head); assert.equal(git(cwd, "branch", "--show-current"), scope.source.ref);
  assert.equal(git(cwd, "status", "--porcelain"), "", "Review requires a committed clean source");
  git(cwd, "merge-base", "--is-ancestor", scope.source.sha, head);
  git(cwd, "merge-base", "--is-ancestor", reviewBase, head);
  const show = (ref, path) => {
    assert.match(path, /^(?:AGENTS\.md|\.governance\/[A-Za-z0-9_./-]+)$/u);
    assert.ok(!path.split("/").includes(".."));
    assert.match(git(cwd, "ls-tree", ref, "--", path), /^100(?:644|755) blob /u);
    return git(cwd, "show", `${ref}:${path}`);
  };
  const readPolicy = ref => {
    const sources = Object.fromEntries(["AGENTS.md", ".governance/policy.md", ".governance/quality.md"].map(path => [path, show(ref, path)]));
    const entries = git(cwd, "ls-tree", "-r", "--name-only", ref, "--", ".governance").split("\n");
    const catalogue = entries.includes(".governance/principles.md") ? show(ref, ".governance/principles.md") : "";
    const leaves = {};
    if (catalogue) {
      sources[".governance/principles.md"] = catalogue;
      for (const { skill } of principleEntries(catalogue)) leaves[skill] = sources[skill] = show(ref, skill);
    }
    const policy = reviewPolicy(sources[".governance/policy.md"], sources[".governance/quality.md"], catalogue, leaves);
    policy.items.push({ id: "principle:project-policy", title: "Local project policy" });
    policy.digest = digest({ policy, projectPolicy: sources["AGENTS.md"] });
    return { sources, policy };
  };
  const basePolicy = readPolicy(stagingBase), headPolicy = readPolicy(head);
  const policy = basePolicy.policy;
  const policySources = [...new Set([...Object.keys(basePolicy.sources), ...Object.keys(headPolicy.sources)])].sort()
    .map(path => ({ path, base: path in basePolicy.sources ? digest(basePolicy.sources[path]) : null, head: path in headPolicy.sources ? digest(headPolicy.sources[path]) : null }));
  const view = base => ({ base, mergeBase: git(cwd, "merge-base", base, head), ...diffSize(git(cwd, "diff", "--numstat", "--no-renames", "-z", `${base}...${head}`)) });
  const review = view(reviewBase), staging = view(stagingBase);
  assert.ok(staging.files.length, "Nonempty staging diff required");
  // A declared stack base cannot hide changes: always retain both diffs and their common ancestry.
  assert.equal(git(cwd, "merge-base", stagingBase, reviewBase), staging.mergeBase, "Foreign review base");
  const acceptance = select({ cwd, base: stagingBase, head, scope });
  const plan = { version: 1, classificationVersion: 1, scopeDigest: digest(scope), scopeRevision: scope.revision,
    source: { repository: delivery.project.repository, ref: scope.source.ref, head, reviewBase, stagingBase },
    configDigest: digest(show(head, ".governance/config.json")), deliveryDigest: digest(delivery), classifierDigest: digest(show(head, ".governance/core/review.mjs")),
    policy, policySources, policyChanged: policySources.some(x => x.base !== x.head), review, staging,
    required: [...review.files, ...staging.files].some(x => x.category !== "documentation"),
    sizeTrigger: review.total === null || review.total > 400,
    acceptance: { applicability: acceptance.applicability, planDigest: acceptance.digest, unresolved: acceptance.unresolved } };
  return { ...plan, digest: digest(plan) };
}

export function inspectReview(plan, record, scope) {
  const gaps = [], findings = [];
  let validation = "missing", code = 2;
  const policyGaps = [...(plan.staging.mergeBase !== plan.source.stagingBase ? ["staging-base-not-integrated"] : []),...(plan.policyChanged ? ["review-policy-changed"] : []), ...(plan.acceptance.unresolved.length ? ["acceptance-impact-unresolved"] : [])];
  if (!plan.required) { validation = "not-applicable"; code = 0; }
  else if (record !== null && record !== undefined) {
    try {
      validateScope(scope);
      keys(record, ["version", "planDigest", "scopeDigest", "reviewer", "reviewedAt", "conditions", "criteria", "intentProof", "size"]);
      assert.equal(record.version, 1); assert.equal(record.reviewer, "lead");
      assert.match(record.reviewedAt, /^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d(?:\.\d{3})?Z$/u); assert.ok(Number.isFinite(Date.parse(record.reviewedAt)));
      assert.match(record.planDigest, /^[a-f0-9]{64}$/u); assert.match(record.scopeDigest, /^[a-f0-9]{64}$/u);
      if (record.planDigest !== plan.digest || record.scopeDigest !== digest(scope) || plan.scopeDigest !== digest(scope)) {
        return { version: 1, validation: "stale", code: 3, ready: false, gaps: ["review-source-scope-or-policy-stale"], findings: [], planDigest: plan.digest };
      }
      assert.equal(record.conditions.length, plan.policy.items.length);
      assert.deepEqual(record.conditions.map(x => x.id).sort(), plan.policy.items.map(x => x.id).sort());
      for (const row of record.conditions) {
        keys(row, ["id", "disposition", "proof"]);
        assert.ok(["satisfied", "not-applicable", "violation", "unverified"].includes(row.disposition));
        if (row.disposition === "unverified") assert.equal(row.proof, null); else proof(row.proof);
        if (row.id.startsWith("principle:") && !plan.policy.items.find(item => item.id === row.id).conditional) assert.notEqual(row.disposition, "not-applicable");
        findings.push({ ...row });
      }
      assert.deepEqual(record.criteria.map(x => x.id).sort(), scope.criteria.map(x => x.id).sort());
      for (const row of record.criteria) { keys(row, ["id", "proof"]); proof(row.proof); }
      proof(record.intentProof);
      keys(record.size, ["kind", "decision", "proof"]); assert.ok(["feature", "other"].includes(record.size.kind));
      const decisions = record.size.kind === "other" ? ["not-feature"] : plan.sizeTrigger ? ["decomposed", "justified"] : ["within-trigger"];
      assert.ok(decisions.includes(record.size.decision));
      if (plan.sizeTrigger) proof(record.size.proof); else assert.equal(record.size.proof, null);
      gaps.push(...findings.filter(x => ["violation", "unverified"].includes(x.disposition)).map(x => x.id));
      validation = "valid"; code = gaps.length ? 2 : 0;
    } catch { validation = "invalid"; code = 1; gaps.push("review-record-invalid"); }
  } else gaps.push("code-review-missing");
  gaps.push(...policyGaps);
  return { version: 1, validation, code: code === 0 && gaps.length ? 2 : code, ready: code === 0 && !gaps.length,
    source: plan.source, planDigest: plan.digest, recordDigest: record ? digest(record) : null, required: plan.required, findings, gaps,
    authority: "record-completeness-only; lead independently judges intent, design and proof; never merge approval" };
}
