#!/usr/bin/env node
// Computes the desired set of preview stacks from the open PRs across all repos.
//
// Grouping rule:
//   - A PR labelled `preview:<name>` joins the shared stack `g-<name>`.
//     PRs with the same label in different repos land in the same stack.
//   - An unlabelled PR gets its own stack `<short>-pr-<number>` (a-pr-52).
//   - Any service without a PR in the stack runs the `main` image.
//
// Usage:
//   node plan.mjs                        -> full desired state as JSON
//   node plan.mjs --for service-a#10     -> only the stack containing that PR
//
// Because the plan is derived from GitHub's current state rather than from
// accumulated events, it is idempotent: replaying it converges, and a missed
// workflow run is repaired by the next reconcile.

const OWNER = requireEnv("OWNER");
const REPOS = requireEnv("REPOS").split(",").map((r) => r.trim()).filter(Boolean);
const TOKEN = requireEnv("GH_TOKEN");
const LABEL_PREFIX = process.env.GROUP_LABEL_PREFIX || "preview:";
const MAIN_TAG = process.env.MAIN_TAG || "main";

function requireEnv(name) {
  const value = process.env[name];
  if (!value) {
    console.error(`missing required env var: ${name}`);
    process.exit(1);
  }
  return value;
}

// service-a -> a, so URLs read a-pr-52 rather than service-a-pr-52.
function shortName(repo) {
  const match = repo.match(/^service-([a-z0-9]+)$/i);
  return match ? match[1].toLowerCase() : repo.replace(/[^a-z0-9]/gi, "").toLowerCase();
}

// GitHub Actions sets GITHUB_API_URL; keeping it configurable also lets the
// planner run against a mock server in tests.
const API = process.env.GITHUB_API_URL || "https://api.github.com";

async function gh(path) {
  const res = await fetch(`${API}${path}`, {
    headers: {
      authorization: `Bearer ${TOKEN}`,
      accept: "application/vnd.github+json",
      "x-github-api-version": "2022-11-28",
      "user-agent": "preview-planner",
    },
  });
  if (!res.ok) {
    throw new Error(`GET ${path} -> ${res.status} ${await res.text()}`);
  }
  return res.json();
}

async function openPullRequests(repo) {
  const prs = await gh(`/repos/${OWNER}/${repo}/pulls?state=open&per_page=100`);
  return prs.map((pr) => ({
    repo,
    number: pr.number,
    head_sha: pr.head.sha,
    head_ref: pr.head.ref,
    draft: pr.draft,
    labels: pr.labels.map((l) => l.name),
  }));
}

function groupIdFor(pr) {
  const groupLabel = pr.labels.find((name) => name.startsWith(LABEL_PREFIX));
  if (groupLabel) {
    const raw = groupLabel.slice(LABEL_PREFIX.length).trim();
    return `g-${raw.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "")}`;
  }
  return `${shortName(pr.repo)}-pr-${pr.number}`;
}

function buildStacks(pullRequests) {
  const byGroup = new Map();

  for (const pr of pullRequests) {
    if (pr.draft && process.env.SKIP_DRAFTS === "true") continue;
    const id = groupIdFor(pr);
    if (!byGroup.has(id)) byGroup.set(id, []);
    byGroup.get(id).push(pr);
  }

  const stacks = [];
  for (const [id, prs] of byGroup) {
    const services = {};
    const warnings = [];

    for (const repo of REPOS) {
      const candidates = prs.filter((pr) => pr.repo === repo);
      if (candidates.length === 0) {
        // No PR from this repo in the group -> pin it to main.
        services[repo] = { tag: MAIN_TAG, ref: "main", sha: "", source: "main" };
        continue;
      }
      // Two PRs from the same repo sharing a label is ambiguous; the highest
      // number wins and we surface a warning on the PR comment.
      const chosen = candidates.sort((a, b) => b.number - a.number)[0];
      if (candidates.length > 1) {
        warnings.push(
          `${repo}: PRs ${candidates.map((c) => `#${c.number}`).join(", ")} share the same group label; using #${chosen.number}`
        );
      }
      services[repo] = {
        tag: `pr-${chosen.number}`,
        ref: chosen.head_ref,
        sha: chosen.head_sha,
        source: `pr-${chosen.number}`,
      };
    }

    stacks.push({
      id,
      shared: prs.length > 1,
      prs: prs.map((pr) => ({ repo: pr.repo, number: pr.number })),
      services,
      warnings,
    });
  }

  return stacks.sort((a, b) => a.id.localeCompare(b.id));
}

async function main() {
  const forArg = process.argv.indexOf("--for");
  const target = forArg === -1 ? null : process.argv[forArg + 1];

  const all = (await Promise.all(REPOS.map(openPullRequests))).flat();
  const stacks = buildStacks(all);

  if (!target) {
    console.log(JSON.stringify({ stacks, all_stack_ids: stacks.map((s) => s.id) }, null, 2));
    return;
  }

  const [repo, numberRaw] = target.split("#");
  const number = Number(numberRaw);
  const stack = stacks.find((s) =>
    s.prs.some((pr) => pr.repo === repo && pr.number === number)
  );

  if (!stack) {
    // The PR is closed or filtered out: no stack should exist for it.
    console.log(JSON.stringify({ stack: null, all_stack_ids: stacks.map((s) => s.id) }, null, 2));
    return;
  }

  console.log(JSON.stringify({ stack, all_stack_ids: stacks.map((s) => s.id) }, null, 2));
}

main().catch((err) => {
  console.error(err.message);
  process.exit(1);
});
