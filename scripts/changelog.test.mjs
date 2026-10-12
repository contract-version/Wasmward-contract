import assert from 'node:assert/strict';
import { existsSync, readFileSync } from 'node:fs';
import { test } from 'node:test';

// The changelog names scripts, the compiler and the deployed hashes. These check that what it names is true: the
// scripts exist, and the versions and hashes are the ones in the files that are the source of them.

const read = (path) => readFileSync(new URL(`../${path}`, import.meta.url), 'utf8');
const changelog = read('CHANGELOG.md');
const config = JSON.parse(read('fixture.wasmward.json')).contracts.fixture;

test('it has a title, says there are no releases, and has an Unreleased section with groups under it', () => {
  assert.match(changelog, /^# Changelog$/m);
  assert.match(changelog, /has no releases/);
  assert.match(changelog, /^## Unreleased$/m);
  for (const group of ['The deployed fixture', 'Build', 'Scripts', 'Workflows', 'Tests and documentation', 'The contract']) {
    assert.match(changelog, new RegExp(`^### ${group}$`, 'm'), `missing "### ${group}"`);
  }
});

test('every script it names exists', () => {
  const named = new Set([...changelog.matchAll(/`(scripts\/[\w-]+\.(?:mjs|sh))`/g)].map((match) => match[1]));
  assert.ok(named.size >= 6, [...named].join(', '));
  for (const path of named) assert.ok(existsSync(new URL(`../${path}`, import.meta.url)), `the changelog names ${path}, which does not exist`);
});

test('the deployed contract and builds it describes are the ones in the config', () => {
  assert.ok(changelog.includes(fixture().contractId.slice(0, 8)), 'the changelog names another contract');
  assert.ok(changelog.includes(`v1 \`${config.supported[0].wasmHash.slice(0, 8)}…\``), 'the changelog names another v1 hash');
  assert.ok(changelog.includes(`v2 \`${config.supported[1].wasmHash.slice(0, 8)}…\``), 'the changelog names another v2 hash');
});

function fixture() {
  return config;
}

test('the compiler it says is pinned is the one in rust-toolchain.toml', () => {
  const pinned = read('rust-toolchain.toml').match(/^channel = "([^"]+)"$/m)[1];
  assert.ok(changelog.includes(`pinned to ${pinned}`), `the changelog does not say the compiler is pinned to ${pinned}`);
});

test('the contract section says it is unchanged', () => {
  assert.match(changelog.slice(changelog.indexOf('### The contract')), /^Unchanged\./m);
});

test('it is linked from the README', () => {
  assert.ok(read('README.md').includes('CHANGELOG.md'));
});
