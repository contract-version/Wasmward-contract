import assert from 'node:assert/strict';
import { test } from 'node:test';
import { parseInstanceEntry } from './instance-entry.mjs';

// What the testnet returned for the fixture's instance on 2026-10-12: it ran v1.
const TESTNET_V1 =
  'AAAABgAAAAAAAAABY9yUaNGDc3vDAS1jyArjRrVJR7VoSknM5RwWe9NHh4cAAAAUAAAAAQAAABMAAAAAp6glEfooRlAXiwL+OkuvxYe5UhLy+M5kfy3170z0JQkAAAABAAAAAQAAABAAAAABAAAAAQAAAA8AAAAFQWRtaW4AAAAAAAASAAAAAAAAAAAlaMSs3Hv+wQ4XPOYZLcD+zoKOC8Ue7eKJWXcJRb5gjw==';
const V1 = 'a7a82511fa284650178b02fe3a4bafc587b95212f2f8ce647f2df5ef4cf42509';

const u32 = (...values) => Buffer.from(values.flatMap((value) => [(value >>> 24) & 255, (value >>> 16) & 255, (value >>> 8) & 255, value & 255]));

/** A hand-built instance entry, so each field can be wrong in turn. */
function entry({ kind = 6, address = 1, key = 20, value = 19, executable = 0, hash = Buffer.alloc(32, 7) } = {}) {
  const parts = [u32(kind, 0, address), Buffer.alloc(32, 9), u32(key, 1, value, executable)];
  if (hash !== undefined) parts.push(hash);
  return Buffer.concat(parts).toString('base64');
}

test('reads the build the real testnet answer says the fixture runs', () => {
  assert.deepEqual(parseInstanceEntry(TESTNET_V1), { kind: 'wasm', wasmHash: V1 });
});

test('reads the hash from a hand-built entry, as lowercase hex', () => {
  assert.deepEqual(parseInstanceEntry(entry({ hash: Buffer.alloc(32, 0xab) })), { kind: 'wasm', wasmHash: 'ab'.repeat(32) });
});

test('a Stellar Asset Contract has no Wasm to report', () => {
  assert.deepEqual(parseInstanceEntry(entry({ executable: 1, hash: undefined })), { kind: 'stellar-asset' });
});

test('anything after the hash (the instance storage) is ignored', () => {
  const longer = Buffer.concat([Buffer.from(entry(), 'base64'), Buffer.alloc(40, 1)]).toString('base64');
  assert.equal(parseInstanceEntry(longer).wasmHash, '07'.repeat(32));
});

test('an entry of another kind is refused, and the message says which part is wrong', () => {
  assert.throws(() => parseInstanceEntry(entry({ kind: 7 })), /entry kind is 7, expected 6/);
  assert.throws(() => parseInstanceEntry(entry({ address: 0 })), /address kind is 0, expected 1/);
  assert.throws(() => parseInstanceEntry(entry({ key: 1 })), /key type is 1, expected 20/);
  assert.throws(() => parseInstanceEntry(entry({ value: 18 })), /value type is 18, expected 19/);
});

test('an executable kind it does not know is refused rather than guessed', () => {
  assert.throws(() => parseInstanceEntry(entry({ executable: 2, hash: undefined })), /executable of kind 2/);
});

test('an entry that ends early says what it was missing, at every length', () => {
  const whole = Buffer.from(TESTNET_V1, 'base64');
  const upToHash = 92;
  for (let length = 0; length < upToHash; length += 1) {
    assert.throws(() => parseInstanceEntry(whole.subarray(0, length).toString('base64')), /ends early|not a contract instance/, `length ${length}`);
  }
  assert.equal(parseInstanceEntry(whole.subarray(0, upToHash).toString('base64')).wasmHash, V1);
});

test('something that is not a string is refused', () => {
  assert.throws(() => parseInstanceEntry(undefined), /not a string of base64/);
  assert.throws(() => parseInstanceEntry(42), /not a string of base64/);
});
