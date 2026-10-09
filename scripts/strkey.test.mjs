import assert from 'node:assert/strict';
import { test } from 'node:test';
import { crc16, decodeContractId } from './strkey.mjs';

// Addresses and their bytes as produced by the Stellar SDK (StrKey.encodeContract / decodeContract), so this
// does not just check the decoder against itself.
const KNOWN = [
  ['CBR5ZFDI2GBXG66DAEWWHSAK4NDLKSKHWVUEUSOM4UOBM66TI6DYPDPV', '63dc9468d183737bc3012d63c80ae346b54947b5684a49cce51c167bd3478787'],
  ['CAAAODQVDQRSUMJYH5DE2VC3MJUXA536QWGJHGVBVCX3NPOEZPJNTXZU', '00070e151c232a31383f464d545b626970777e858c939aa1a8afb6bdc4cbd2d9'],
  ['CAAQQDYWDUSCWMRZIBDU4VK4MNVHC6D7Q2GZJG5CVGYLPPWFZTJ5U2RQ', '01080f161d242b323940474e555c636a71787f868d949ba2a9b0b7bec5ccd3da'],
  ['CD7QMDIUDMRCSMBXHZCUYU22MFUG65T5QSFZFGNAU6XLLPGDZLI5Q55L', 'ff060d141b222930373e454c535a61686f767d848b9299a0a7aeb5bcc3cad1d8'],
  ['CAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAABSC4', '00'.repeat(32)],
  ['CD7777777777777777777777777777777777777777777777777767GY', 'ff'.repeat(32)],
];

test('decodes contract addresses to the bytes the SDK gives', () => {
  for (const [address, hex] of KNOWN) {
    assert.equal(Buffer.from(decodeContractId(address)).toString('hex'), hex, address);
  }
});

test('CRC16-XModem matches its standard check value', () => {
  assert.equal(crc16(Buffer.from('123456789')), 0x31c3);
  assert.equal(crc16(new Uint8Array()), 0);
});

test('a single mistyped character is caught by the checksum', () => {
  const [address] = KNOWN[0];
  for (let i = 1; i < address.length; i += 1) {
    const other = address[i] === 'A' ? 'B' : 'A';
    const typo = address.slice(0, i) + other + address.slice(i + 1);
    assert.throws(() => decodeContractId(typo), /not a contract address/, `position ${i}`);
  }
});

test('anything that is not a contract address is refused, with a reason', () => {
  const [address] = KNOWN[0];
  assert.throws(() => decodeContractId(''), /56 characters/);
  assert.throws(() => decodeContractId(address.slice(1)), /56 characters/);
  assert.throws(() => decodeContractId(`${address}A`), /56 characters/);
  assert.throws(() => decodeContractId(undefined), /56 characters/);
  assert.throws(() => decodeContractId(42), /56 characters/);
  // An account address ("G...") is the right length and valid base32, but not a contract.
  assert.throws(() => decodeContractId(`G${address.slice(1)}`), /must start with C/);
  assert.throws(() => decodeContractId(address.toLowerCase()), /must start with C/);
  assert.throws(() => decodeContractId(`C${address.slice(1, 55)}1`), /unexpected character "1"/);
});
