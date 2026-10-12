import assert from 'node:assert/strict';
import { existsSync, readFileSync } from 'node:fs';
import { test } from 'node:test';
import { parseInstanceEntry } from './instance-entry.mjs';

// The README and CONTRIBUTING say where the other Wasmward repositories keep the contract ID and the hashes. When
// those repositories are checked out next to this one (they are not in CI), this checks that what is said is true:
// the file exists and holds the value. It would have caught a README that still named a file that had been renamed.

const config = JSON.parse(readFileSync(new URL('../fixture.wasmward.json', import.meta.url), 'utf8'));
const { contractId, supported } = config.contracts.fixture;
const v1 = supported.find((build) => build.label === 'v1').wasmHash;

const frontend = new URL('../../Wasmward-frontend/', import.meta.url);
const backend = new URL('../../Wasmward-backend/', import.meta.url);
const docs = ['README.md', 'CONTRIBUTING.md', 'docs/RECOVERY.md'].map((name) => readFileSync(new URL(`../${name}`, import.meta.url), 'utf8')).join('\n');

test('the docs name the frontend files that keep the contract, and those files hold it', { skip: !existsSync(frontend) && 'Wasmward-frontend is not checked out next to this repository' }, () => {
  for (const file of ['src/demo-config.js', 'wasmward.json']) {
    assert.ok(docs.includes(`\`${file}\``), `the docs no longer name ${file}`);
    const text = readFileSync(new URL(file, frontend), 'utf8');
    assert.ok(text.includes(contractId), `${file} in the frontend does not hold this contract ID`);
    assert.ok(text.includes(v1), `${file} in the frontend does not hold the v1 hash`);
  }
});

test('the docs do not name a frontend file that is gone', () => {
  for (const [, file] of docs.matchAll(/`(src\/[\w.-]+\.js)`/g)) {
    if (existsSync(frontend)) assert.ok(existsSync(new URL(file, frontend)), `the docs name ${file}, which the frontend does not have`);
  }
});

test('the backend README example holds this contract ID and the v1 hash', { skip: !existsSync(backend) && 'Wasmward-backend is not checked out next to this repository' }, () => {
  const readme = readFileSync(new URL('README.md', backend), 'utf8');
  assert.ok(readme.includes(contractId), 'the backend README example uses another contract');
  assert.ok(readme.includes(v1), 'the backend README example uses another v1 hash');
});

test('the backend recorded testnet response is for this contract, and its instance entry runs v1', { skip: !existsSync(new URL('test/fixtures/recorded/testnet-v1.json', backend)) && 'no recorded response next to this repository' }, () => {
  const recorded = JSON.parse(readFileSync(new URL('test/fixtures/recorded/testnet-v1.json', backend), 'utf8'));
  assert.equal(recorded.contractId, contractId);
  assert.equal(recorded.expectedWasmHash, v1);
  // The recorded answer itself says which code the contract ran, read with the same parser live-build.mjs uses.
  assert.deepEqual(parseInstanceEntry(recorded.getLedgerEntries.result.entries[0].xdr), { kind: 'wasm', wasmHash: v1 });
});
