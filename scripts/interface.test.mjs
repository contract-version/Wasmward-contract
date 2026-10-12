import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';
import { EXPECTED_FUNCTIONS } from './check-builds.mjs';

// The contract's functions are written down in four places: the source, the list check-builds.mjs pins against the
// built Wasm, the README's table, and the architecture map. A function added to the source without the others is
// either caught by CI late (check-builds on the Wasm) or left undocumented. This catches it at the source.

const read = (path) => readFileSync(new URL(`../${path}`, import.meta.url), 'utf8');
const source = read('contracts/fixture/src/lib.rs');

/** The public functions inside the `#[contractimpl]` block of lib.rs, in source order. */
function contractFunctions() {
  const block = source.slice(source.indexOf('#[contractimpl]'));
  return [...block.matchAll(/^\s+pub fn (\w+)\s*\(/gm)].map((match) => match[1]);
}

test('the source has the three public functions, and reads them out of the contractimpl block', () => {
  assert.deepEqual(contractFunctions(), ['__constructor', 'version', 'upgrade']);
});

test('check-builds pins exactly the functions the source defines', () => {
  assert.deepEqual([...EXPECTED_FUNCTIONS].sort(), [...contractFunctions()].sort());
});

test('the README table lists exactly those functions', () => {
  const table = read('README.md').slice(read('README.md').indexOf('| Function | Behaviour |'), read('README.md').indexOf('The two builds have different Wasm hashes'));
  const listed = [...table.matchAll(/^\| `(\w+)\(/gm)].map((match) => match[1]);
  assert.deepEqual([...listed].sort(), [...contractFunctions()].sort());
});

test('the architecture map describes the same three, by name', () => {
  const map = read('docs/ARCHITECTURE.md');
  for (const name of contractFunctions()) assert.ok(map.includes(`\`${name}`), `docs/ARCHITECTURE.md does not mention ${name}`);
});

test('every function has a doc comment in the source, since the Soroban spec carries it', () => {
  for (const name of contractFunctions()) {
    const at = source.indexOf(`pub fn ${name}(`);
    const before = source.slice(0, at).trimEnd().split('\n').at(-1) ?? '';
    assert.match(before, /^\s*\/\/\//, `${name} has no doc comment above it`);
  }
});

test('the native tests exercise each function', () => {
  const tests = read('contracts/fixture/src/test.rs');
  for (const call of ['.version()', '.upgrade(']) assert.ok(tests.includes(call), `no native test calls ${call}`);
  assert.match(tests, /constructor_records_the_admin/);
});
