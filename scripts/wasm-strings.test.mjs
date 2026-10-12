import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';
import { machinePaths, printableStrings } from './wasm-strings.mjs';
import { parseCodeEntry } from './wasm-code.mjs';

const recorded = JSON.parse(readFileSync(new URL('./fixtures/testnet-code-entries.json', import.meta.url), 'utf8'));
const deployed = (label) => parseCodeEntry(recorded.builds[label].xdr).code;
const bytes = (...parts) => Buffer.concat(parts.map((part) => (typeof part === 'string' ? Buffer.from(part, 'latin1') : Buffer.from(part))));

test('finds runs of printable text and where each starts', () => {
  const input = bytes([0, 1], 'hello world', [0], 'tiny', [0xff], 'another one', [10]);
  assert.deepEqual(printableStrings(input), [
    { offset: 2, text: 'hello world' },
    { offset: 19, text: 'another one' },
  ]);
});

test('the minimum length decides what counts, and a run at the very end is kept', () => {
  assert.deepEqual(printableStrings(bytes([0], 'abc'), 3), [{ offset: 1, text: 'abc' }]);
  assert.deepEqual(printableStrings(bytes([0], 'abc'), 4), []);
  assert.deepEqual(printableStrings(bytes('trailing text')), [{ offset: 0, text: 'trailing text' }]);
  assert.deepEqual(printableStrings(Buffer.alloc(0)), []);
});

test('space and tilde are printable, tab, newline and DEL are not', () => {
  assert.deepEqual(printableStrings(bytes(' ~ ~ ~ '), 1).map((s) => s.text), [' ~ ~ ~ ']);
  assert.deepEqual(printableStrings(bytes('abcdef\tghijkl\nmnopqr\x7fstuvwx')).map((s) => s.text), ['abcdef', 'ghijkl', 'mnopqr', 'stuvwx']);
});

test('paths from the building machine are recognised, in the forms they take on each system', () => {
  for (const path of ['C:\\Users\\dell\\project\\src\\lib.rs', '/home/runner/work/x/src/lib.rs', '/Users/someone/code/lib.rs', '/root/.cargo/registry/src/x', 'D:/build/contract.rs', '/rustc/abc123/library/core/src/panicking.rs', '/home/runner/.cargo/registry/src/index.crates.io-1/soroban-sdk/src/lib.rs']) {
    assert.equal(machinePaths(bytes('\0', path, '\0')).length, 1, path);
  }
});

test('a relative source path, a function name and ordinary text are not machine paths', () => {
  for (const text of ['contracts/fixture/src/lib.rs', 'contracts\\fixture\\src\\lib.rs', 'upgrade', 'admin not set', 'Replaces this contract\'s Wasm with an already uploaded one.']) {
    assert.deepEqual(machinePaths(bytes('\0', text, '\0')), [], text);
  }
});

test('the real deployed v1 and v2 carry no path from the machine that built them', () => {
  for (const label of ['v1', 'v2']) assert.deepEqual(machinePaths(deployed(label)), [], `${label} has a machine path in it`);
});

test('the reader does see the text in the real deployed Wasm: the function names are in it', () => {
  const text = printableStrings(deployed('v1'), 4).map((entry) => entry.text).join('\n');
  for (const name of ['upgrade', 'version', '__constructor']) assert.ok(text.includes(name), `${name} was not found, so an empty result above would mean nothing`);
});
