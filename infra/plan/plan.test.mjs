#!/usr/bin/env node
// Runs plan.mjs against a mock GitHub API to verify the grouping rules.
//   node plan.test.mjs

import { createServer } from "node:http";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import assert from "node:assert/strict";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const run = promisify(execFile);
const PLAN = join(dirname(fileURLToPath(import.meta.url)), "plan.mjs");

// service-a #10 and service-b #20 share preview:g1.
// service-a #11 is on its own. service-c has no open PR at all.
const FIXTURE = {
  "service-a": [
    { number: 10, head: { sha: "aaa1111", ref: "feat/checkout" }, draft: false, labels: [{ name: "preview:g1" }] },
    { number: 11, head: { sha: "aaa2222", ref: "fix/typo" }, draft: false, labels: [] },
  ],
  "service-b": [
    { number: 20, head: { sha: "bbb1111", ref: "feat/checkout-api" }, draft: false, labels: [{ name: "preview:g1" }] },
  ],
  "service-c": [],
};

const server = createServer((req, res) => {
  const match = req.url.match(/^\/repos\/[^/]+\/([^/]+)\/pulls/);
  res.setHeader("content-type", "application/json");
  res.end(JSON.stringify(match ? FIXTURE[match[1]] ?? [] : []));
});

await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
const base = `http://127.0.0.1:${server.address().port}`;

const env = {
  ...process.env,
  GITHUB_API_URL: base,
  OWNER: "bbachikk",
  REPOS: "service-a,service-b,service-c",
  GH_TOKEN: "test",
};

async function plan(...args) {
  const { stdout } = await run("node", [PLAN, ...args], { env });
  return JSON.parse(stdout);
}

let failures = 0;
function check(name, fn) {
  try {
    fn();
    console.log(`  ok  ${name}`);
  } catch (err) {
    failures++;
    console.log(`FAIL  ${name}\n      ${err.message}`);
  }
}

const full = await plan();
const byId = Object.fromEntries(full.stacks.map((s) => [s.id, s]));

console.log("\nstacks:", full.all_stack_ids.join(", "), "\n");

check("labelled PRs from two repos collapse into one shared stack", () => {
  assert.ok(byId["g-g1"], "expected stack g-g1");
  assert.equal(byId["g-g1"].shared, true);
  assert.equal(byId["g-g1"].prs.length, 2);
});

check("shared stack runs the PR image of both labelled repos", () => {
  assert.equal(byId["g-g1"].services["service-a"].tag, "pr-10");
  assert.equal(byId["g-g1"].services["service-b"].tag, "pr-20");
});

check("service with no PR in the group falls back to main", () => {
  assert.equal(byId["g-g1"].services["service-c"].tag, "main");
});

check("unlabelled PR gets its own stack named a-pr-11", () => {
  assert.ok(byId["a-pr-11"], "expected stack a-pr-11");
  assert.equal(byId["a-pr-11"].shared, false);
  assert.equal(byId["a-pr-11"].services["service-a"].tag, "pr-11");
  assert.equal(byId["a-pr-11"].services["service-b"].tag, "main");
  assert.equal(byId["a-pr-11"].services["service-c"].tag, "main");
});

check("exactly two stacks exist for three open PRs", () => {
  assert.equal(full.stacks.length, 2);
});

check("stacks never share an id, so networks and volumes cannot collide", () => {
  assert.equal(new Set(full.all_stack_ids).size, full.all_stack_ids.length);
});

check("--for resolves a PR to the stack that contains it", async () => {});
const forB20 = await plan("--for", "service-b#20");
check("service-b#20 resolves to the shared stack, not a solo one", () => {
  assert.equal(forB20.stack.id, "g-g1");
});

const forClosed = await plan("--for", "service-c#99");
check("a PR that is not open resolves to no stack", () => {
  assert.equal(forClosed.stack, null);
});

check("head sha is carried through for traceability", () => {
  assert.equal(byId["g-g1"].services["service-a"].sha, "aaa1111");
});

server.close();
console.log(failures === 0 ? "\nall checks passed" : `\n${failures} check(s) failed`);
process.exit(failures === 0 ? 0 : 1);
