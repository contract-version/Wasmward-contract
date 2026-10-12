import assert from 'node:assert/strict';
import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { test } from 'node:test';

// The workflows run with the repository's permissions on a schedule and on every push. These checks keep them
// least-privileged, pinned, bounded in time, and pointing at scripts that exist. There is no YAML parser here (the
// scripts have no dependencies), so they read the files line by line.

const dir = new URL('../.github/workflows/', import.meta.url);
const workflows = readdirSync(dir)
  .filter((name) => name.endsWith('.yml'))
  .map((name) => ({ name, text: readFileSync(new URL(name, dir), 'utf8') }));

/** The text of each job: from its "  name:" line at two spaces to the next one, under the top-level "jobs:". */
function jobsOf(text) {
  const after = text.slice(text.search(/^jobs:\s*$/m));
  const heads = [...after.matchAll(/^ {2}([\w-]+):\s*$/gm)];
  return heads.map((head, i) => ({ id: head[1], text: after.slice(head.index, heads[i + 1]?.index ?? after.length) }));
}

test('there are three workflows, and they have jobs', () => {
  assert.deepEqual(workflows.map((w) => w.name).sort(), ['ci.yml', 'fixture-health.yml', 'reproducibility.yml']);
  for (const { name, text } of workflows) assert.ok(jobsOf(text).length >= 1, `${name} has no jobs`);
});

test('every workflow limits what its token can do, at the top, to reading the repository', () => {
  for (const { name, text } of workflows) {
    assert.match(text, /^permissions:\s*\n {2}contents: read\s*$/m, `${name} does not start from "permissions: contents: read"`);
    assert.doesNotMatch(text, /(write-all|contents: write|pull-requests: write|id-token: write)/, `${name} asks for more than reading`);
  }
});

test('no workflow runs on pull_request_target, and none uses a secret', () => {
  for (const { name, text } of workflows) {
    assert.doesNotMatch(text, /pull_request_target/, `${name} runs with write access on pull requests from forks`);
    assert.doesNotMatch(text.replace(/secrets\.GITHUB_TOKEN/g, ''), /secrets\./, `${name} uses a secret; this repository has none`);
  }
});

test('every action is pinned to a major version, except this project\'s own at main', () => {
  for (const { name, text } of workflows) {
    const uses = [...text.matchAll(/^\s*(?:- )?uses:\s*(\S+)/gm)].map((match) => match[1]);
    assert.ok(uses.length >= 1, `${name} uses no actions, not even checkout`);
    for (const action of uses) {
      const ok = /^[\w.-]+\/[\w.-]+@v\d+$/.test(action) || action === 'contract-version/Wasmward-backend@main';
      assert.ok(ok, `${name}: ${action} is not pinned to a major version`);
    }
  }
});

test('every job has a time limit, so a stuck job cannot run for six hours', () => {
  for (const { name, text } of workflows) {
    for (const job of jobsOf(text)) {
      assert.match(job.text, /^ {4}timeout-minutes: \d+\s*$/m, `${name}: job "${job.id}" has no timeout-minutes`);
    }
  }
});

test('every script a workflow runs exists', () => {
  const scripts = new Set();
  for (const { text } of workflows) {
    for (const match of text.matchAll(/\b(?:node|bash) (scripts\/[\w.-]+\.(?:mjs|sh))\b/g)) scripts.add(match[1]);
  }
  assert.ok(scripts.size >= 3, [...scripts].join(', '));
  for (const script of scripts) assert.ok(existsSync(new URL(`../${script}`, import.meta.url)), `a workflow runs ${script}, which does not exist`);
});

test('the scheduled run is weekly, and can also be started by hand', () => {
  const health = workflows.find((w) => w.name === 'fixture-health.yml').text;
  assert.match(health, /^ {4}- cron: '\d+ \d+ \* \* [0-6]'/m);
  assert.match(health, /^ {2}workflow_dispatch:/m);
});
