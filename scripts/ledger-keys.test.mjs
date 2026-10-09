import assert from 'node:assert/strict';
import { test } from 'node:test';
import { codeKeyXdr, instanceKeyXdr } from './ledger-keys.mjs';

const HASH = 'a7a82511fa284650178b02fe3a4bafc587b95212f2f8ce647f2df5ef4cf42509';

// Keys as the Stellar SDK produces them (xdr.LedgerKey.contractData / contractCode ... .toXdr('base64')).
const INSTANCE_KEYS = [
  ['CBR5ZFDI2GBXG66DAEWWHSAK4NDLKSKHWVUEUSOM4UOBM66TI6DYPDPV', 'AAAABgAAAAFj3JRo0YNze8MBLWPICuNGtUlHtWhKSczlHBZ700eHhwAAABQAAAAB'],
  ['CAAAODQVDQRSUMJYH5DE2VC3MJUXA536QWGJHGVBVCX3NPOEZPJNTXZU', 'AAAABgAAAAEABw4VHCMqMTg/Rk1UW2JpcHd+hYyTmqGor7a9xMvS2QAAABQAAAAB'],
  ['CD7777777777777777777777777777777777777777777777777767GY', 'AAAABgAAAAH//////////////////////////////////////////wAAABQAAAAB'],
  ['CAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAABSC4', 'AAAABgAAAAEAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAABQAAAAB'],
];

test('the instance key is what the SDK builds, including the one recorded from testnet', () => {
  for (const [address, key] of INSTANCE_KEYS) assert.equal(instanceKeyXdr(address), key, address);
});

test('the instance key is 52 bytes: key type, address type, 32 bytes, value type, durability', () => {
  const bytes = Buffer.from(instanceKeyXdr(INSTANCE_KEYS[0][0]), 'base64');
  assert.equal(bytes.length, 4 + 4 + 32 + 4 + 4);
  assert.deepEqual([bytes.readUInt32BE(0), bytes.readUInt32BE(4), bytes.readUInt32BE(40), bytes.readUInt32BE(44)], [6, 1, 20, 1]);
});

test('a bad address gives an error, never a key for something else', () => {
  assert.throws(() => instanceKeyXdr('CAAAA'), /not a contract address/);
  assert.throws(() => instanceKeyXdr(`${INSTANCE_KEYS[0][0].slice(0, 55)}A`), /checksum/);
});

test('the code key is key type 7 followed by the hash', () => {
  const bytes = Buffer.from(codeKeyXdr(HASH), 'base64');
  assert.equal(bytes.length, 36);
  assert.equal(bytes.readUInt32BE(0), 7);
  assert.equal(bytes.subarray(4).toString('hex'), HASH);
});

test('a hash that is not 64 lowercase hex characters is refused', () => {
  for (const bad of ['abc', HASH.toUpperCase(), `${HASH}0`, HASH.slice(1), '']) {
    assert.throws(() => codeKeyXdr(bad), /64-character/, bad);
  }
});
