import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';
import { decodeContractId } from './strkey.mjs';
import { SCHEMA_URL } from './sync-config.mjs';

// fixture.wasmward.json is read by Wasmward's action every week and by the frontend's CI. A typo in it (a hash with
// a capital, a contract ID with a bad checksum) fails there, far from the edit. This checks it here, with the
// repository's own tools, and checks the environment file against what deploy.sh reads.

const read = (path) => readFileSync(new URL(`../${path}`, import.meta.url), 'utf8');
const config = JSON.parse(read('fixture.wasmward.json'));
const fixture = config.contracts.fixture;

test('the fixture config has the shape Wasmward reads, with the testnet values', () => {
  assert.equal(config.$schema, SCHEMA_URL);
  assert.equal(config.version, 1);
  assert.equal(config.network.rpcUrl, 'https://soroban-testnet.stellar.org');
  assert.equal(config.network.passphrase, 'Test SDF Network ; September 2015');
  assert.deepEqual(Object.keys(config.contracts), ['fixture']);
  assert.deepEqual(Object.keys(config).sort(), ['$schema', 'contracts', 'network', 'version']);
});

test('the contract ID is a valid address: right length, type and checksum', () => {
  assert.equal(decodeContractId(fixture.contractId).length, 32);
});

test('v1 and v2 are listed, in that order, with lowercase 64-character hashes that differ', () => {
  assert.deepEqual(fixture.supported.map((build) => build.label), ['v1', 'v2']);
  for (const { wasmHash } of fixture.supported) assert.match(wasmHash, /^[0-9a-f]{64}$/);
  assert.notEqual(fixture.supported[0].wasmHash, fixture.supported[1].wasmHash);
  for (const build of fixture.supported) assert.deepEqual(Object.keys(build).sort(), ['label', 'wasmHash']);
});

test('every full hash and contract ID the docs quote is the one in the config, and the deployed hashes are cited', () => {
  const text = ['README.md', 'CONTRIBUTING.md', 'docs/HASH-PROVENANCE.md', 'docs/RECOVERY.md'].map(read).join('\n');
  const pinned = fixture.supported.map((build) => build.wasmHash);
  for (const [quoted] of text.matchAll(/\b[0-9a-f]{64}\b/g)) assert.ok(pinned.includes(quoted), `a document quotes the hash ${quoted}, which is not in the config`);
  for (const [quoted] of text.matchAll(/\bC[A-Z2-7]{55}\b/g)) assert.equal(quoted, fixture.contractId, 'a document names another contract');
  for (const hash of pinned) assert.ok(text.includes(hash.slice(0, 8)), `no document cites ${hash.slice(0, 8)}…`);
});

test('.env.example sets exactly the variables deploy.sh reads', () => {
  const example = read('.env.example');
  const deploy = read('scripts/deploy.sh');
  const set = [...example.matchAll(/^([A-Z_]+)=/gm)].map((match) => match[1]).sort();
  assert.deepEqual(set, ['FIXTURE_SECRET', 'WASMWARD_TESTNET_RPC_URL']);
  for (const name of set) assert.ok(deploy.includes(name), `deploy.sh never reads ${name}`);
  assert.match(example, /^WASMWARD_TESTNET_RPC_URL=https:\/\//m);
});
