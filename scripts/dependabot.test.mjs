import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';

// Dependabot would happily open a pull request that bumps soroban-sdk or a crate in Cargo.lock. Merged, that changes
// the Wasm and so the hash that three repositories pin. So the configuration updates the actions and nothing else,
// and this keeps it that way.

const config = readFileSync(new URL('../.github/dependabot.yml', import.meta.url), 'utf8');
const ecosystems = [...config.matchAll(/^\s*- package-ecosystem:\s*(\S+)/gm)].map((match) => match[1]);

test('it is a version 2 configuration that updates the GitHub Actions weekly', () => {
  assert.match(config, /^version: 2$/m);
  assert.deepEqual(ecosystems, ['github-actions']);
  assert.match(config, /^ {6}interval: weekly$/m);
});

test('it does not update Cargo, and says why', () => {
  assert.ok(!ecosystems.includes('cargo'), 'Cargo is updated, which changes the deployed Wasm hash');
  assert.match(config, /Cargo is left out on purpose/);
  assert.match(config, /soroban-sdk/);
});

test('it does not open an unbounded number of pull requests', () => {
  const limit = Number(config.match(/open-pull-requests-limit:\s*(\d+)/)?.[1]);
  assert.ok(limit >= 1 && limit <= 5, `limit ${limit}`);
});

test('every action the workflows use is one it can update', () => {
  const dir = new URL('../.github/workflows/', import.meta.url);
  const text = ['ci.yml', 'fixture-health.yml'].map((name) => readFileSync(new URL(name, dir), 'utf8')).join('\n');
  const actions = new Set([...text.matchAll(/uses:\s*([\w.-]+\/[\w.-]+)@/g)].map((match) => match[1]));
  assert.ok(actions.has('actions/checkout'));
  for (const action of actions) assert.match(action, /^[\w.-]+\/[\w.-]+$/);
});
