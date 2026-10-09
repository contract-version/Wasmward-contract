import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';
import { parseCodeEntry } from './wasm-code.mjs';

// What testnet returned for the code entry of each build of the fixture (see scripts/fixtures).
const recorded = JSON.parse(readFileSync(new URL('./fixtures/testnet-code-entries.json', import.meta.url), 'utf8'));

const sha256 = (bytes) => createHash('sha256').update(bytes).digest('hex');
const u32 = (value) => {
  const bytes = Buffer.alloc(4);
  bytes.writeUInt32BE(value);
  return bytes;
};

/** A contract-code entry built by hand: ext 0 (no cost inputs) unless `ext` says otherwise. */
function entry({ code, hash = sha256(code), ext = 0, trailing = Buffer.alloc(0), kind = 7 }) {
  const padding = Buffer.alloc((4 - (code.length % 4)) % 4);
  const costInputs = ext === 1 ? Buffer.alloc(48) : Buffer.alloc(0);
  return Buffer.concat([u32(kind), u32(ext), costInputs, Buffer.from(hash, 'hex'), u32(code.length), code, padding, trailing]).toString('base64');
}

test('reads the real code entries testnet returned, and their hash is the hash of the Wasm', () => {
  for (const [label, build] of Object.entries(recorded.builds)) {
    const parsed = parseCodeEntry(build.xdr);
    assert.equal(parsed.hash, build.wasmHash, label);
    assert.equal(parsed.hashMatches, true, `${label}: sha256 of the code is not the stated hash`);
    assert.equal(sha256(parsed.code), build.wasmHash, label);
    assert.deepEqual([...parsed.code.subarray(0, 8)], [0, 0x61, 0x73, 0x6d, 1, 0, 0, 0], `${label} is not a Wasm module`);
  }
});

test('the two real builds differ, which is what Wasmward detects', () => {
  const [v1, v2] = ['v1', 'v2'].map((label) => parseCodeEntry(recorded.builds[label].xdr));
  assert.notEqual(v1.hash, v2.hash);
  assert.ok(!v1.code.equals(v2.code));
});

test('reads an entry with no cost inputs (extension 0)', () => {
  const code = Buffer.from('0061736d01000000', 'hex');
  const parsed = parseCodeEntry(entry({ code }));
  assert.equal(parsed.hashMatches, true);
  assert.ok(parsed.code.equals(code));
});

test('handles code whose length is not a multiple of four, which XDR pads', () => {
  for (const length of [1, 2, 3, 4, 5, 7, 8]) {
    const code = Buffer.alloc(length, 0xab);
    const parsed = parseCodeEntry(entry({ code }));
    assert.ok(parsed.code.equals(code), `length ${length}`);
    assert.equal(parsed.hashMatches, true);
  }
});

test('says so, instead of returning the code, when the stated hash is not the code\'s hash', () => {
  const code = Buffer.from('0061736d01000000', 'hex');
  const parsed = parseCodeEntry(entry({ code, hash: 'ab'.repeat(32) }));
  assert.equal(parsed.hash, 'ab'.repeat(32));
  assert.equal(parsed.hashMatches, false);
});

test('every cut-off copy of a real entry is refused, none is read as a shorter entry', () => {
  const whole = Buffer.from(recorded.builds.v1.xdr, 'base64');
  for (let length = 0; length < whole.length; length += 1) {
    assert.throws(() => parseCodeEntry(whole.subarray(0, length).toString('base64')), /ends early|unexplained|not contract code/, `cut at ${length}`);
  }
});

test('refuses bytes after the code, other kinds of entry, and unknown extensions', () => {
  const code = Buffer.from('0061736d01000000', 'hex');
  assert.throws(() => parseCodeEntry(entry({ code, trailing: Buffer.from([1, 2, 3, 4]) })), /4 unexplained bytes/);
  assert.throws(() => parseCodeEntry(entry({ code, kind: 6 })), /kind 6, not contract code/);
  const unknown = Buffer.concat([u32(7), u32(2), Buffer.alloc(100)]).toString('base64');
  assert.throws(() => parseCodeEntry(unknown), /extension version \(2\)/);
});

test('refuses something that is not a string of base64', () => {
  for (const bad of [undefined, null, 42, {}]) assert.throws(() => parseCodeEntry(bad), /not a string/);
  assert.throws(() => parseCodeEntry(''), /ends early/);
});
