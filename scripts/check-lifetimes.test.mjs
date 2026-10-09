import assert from 'node:assert/strict';
import { test } from 'node:test';
import { codeKeyXdr, daysFor, judge } from './check-lifetimes.mjs';

const HASH = 'a7a82511fa284650178b02fe3a4bafc587b95212f2f8ce647f2df5ef4cf42509';

test('the code key is key type 7 followed by the hash', () => {
  const bytes = Buffer.from(codeKeyXdr(HASH), 'base64');
  assert.equal(bytes.length, 36);
  assert.deepEqual([...bytes.subarray(0, 4)], [0, 0, 0, 7]);
  assert.equal(bytes.subarray(4).toString('hex'), HASH);
});

test('a hash that is not 64 lowercase hex characters is refused', () => {
  assert.throws(() => codeKeyXdr('abc'), /64-character/);
  assert.throws(() => codeKeyXdr(HASH.toUpperCase()), /64-character/);
});

test('ledgers become whole days at five seconds each', () => {
  assert.equal(daysFor(17_280), 1);
  assert.equal(daysFor(17_279), 0);
  assert.equal(daysFor(500_000), 28);
});

test('a build with plenty of life left is fine', () => {
  const verdict = judge('v2', HASH, { latestLedger: 100, entries: [{ liveUntilLedgerSeq: 100 + 500_000 }] }, 3);
  assert.equal(verdict.ok, true);
  assert.match(verdict.text, /v2 a7a82511\.\.\.  Wasm code lives about 28 more days$/);
});

test('the minimum is exact: equal passes, one ledger fewer fails', () => {
  const minimum = 3 * 17_280;
  assert.equal(judge('v', HASH, { latestLedger: 0, entries: [{ liveUntilLedgerSeq: minimum }] }, 3).ok, true);
  const short = judge('v', HASH, { latestLedger: 0, entries: [{ liveUntilLedgerSeq: minimum - 1 }] }, 3);
  assert.equal(short.ok, false);
  assert.match(short.text, /under the 3-day minimum/);
});

test('an expired, missing or undated code entry is never fine', () => {
  assert.equal(judge('v', HASH, { latestLedger: 100, entries: [{ liveUntilLedgerSeq: 99 }] }, 0).ok, false);
  assert.match(judge('v', HASH, { latestLedger: 100, entries: [] }, 0).text, /not found/);
  assert.equal(judge('v', HASH, { latestLedger: 100 }, 0).ok, false);
  assert.match(judge('v', HASH, { latestLedger: 100, entries: [{}] }, 0).text, /did not say/);
  assert.equal(judge('v', HASH, undefined, 0).ok, false);
});

test('a code entry live until exactly the latest ledger has not expired yet', () => {
  assert.equal(judge('v', HASH, { latestLedger: 100, entries: [{ liveUntilLedgerSeq: 100 }] }, 0).ok, true);
});
