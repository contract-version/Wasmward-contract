import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';

// SECURITY.md promises that nothing secret can be committed here: the identity lives in the git-ignored .env and
// .stellar-keys/, and testnet.json is git-ignored. These checks hold the repository to that promise.

const git = (...args) => execFileSync('git', args, { encoding: 'utf8' });
const tracked = git('ls-files').split('\n').filter(Boolean);

// A Stellar secret seed is "S" and then 55 base32 characters; the second one is always A to D.
const SEED = /\bS[A-D][A-Z2-7]{54}\b/;

test('the seed pattern matches a seed-shaped string and not a public address', () => {
  assert.match(`secret: S${'A'.repeat(55)}`, SEED);
  assert.doesNotMatch('CBR5ZFDI2GBXG66DAEWWHSAK4NDLKSKHWVUEUSOM4UOBM66TI6DYPDPV', SEED);
  assert.doesNotMatch('GADMINADMINADMINADMINADMINADMINADMINADMINADMINADMINADMINADM', SEED);
  assert.doesNotMatch(`S${'A'.repeat(54)}`, SEED, 'one character short');
});

test('no tracked file contains a Stellar secret seed', () => {
  assert.ok(tracked.length > 20, `only ${tracked.length} tracked files`);
  const found = [];
  for (const path of tracked) {
    const bytes = readFileSync(path);
    if (bytes.includes(0)) continue; // binary
    if (SEED.test(bytes.toString('utf8'))) found.push(path);
  }
  assert.deepEqual(found, [], 'these files look like they hold a secret seed (the value is not printed)');
});

test('what holds the identity is not tracked, and git would refuse to add it', () => {
  for (const secret of ['.env', 'testnet.json', '.stellar-keys/wasmward-fixture.toml', '.stellar-keys/identity/x.toml']) {
    assert.ok(!tracked.includes(secret), `${secret} is tracked`);
    assert.doesNotThrow(() => git('check-ignore', '-q', secret), `${secret} is not git-ignored`);
  }
});

test('the example environment file has no secret in it', () => {
  const example = readFileSync('.env.example', 'utf8');
  assert.match(example, /^FIXTURE_SECRET=$/m, 'FIXTURE_SECRET must be empty in the example');
  assert.doesNotMatch(example, SEED);
  assert.match(example, /Never put a mainnet key/);
});

test('build output and the Rust target folder are git-ignored too', () => {
  for (const path of ['build/v1/wasmward_fixture.wasm', 'target/debug/x']) {
    assert.doesNotThrow(() => git('check-ignore', '-q', path), `${path} is not git-ignored`);
  }
});
