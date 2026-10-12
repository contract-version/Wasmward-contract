import assert from 'node:assert/strict';
import { test } from 'node:test';
import { readLeb128 } from './leb128.mjs';

test('a number under 128 is one byte', () => {
  assert.deepEqual(readLeb128(Buffer.from([0]), 0, 'x'), [0, 1]);
  assert.deepEqual(readLeb128(Buffer.from([127]), 0, 'x'), [127, 1]);
});

test('larger numbers take seven bits per byte, least significant first', () => {
  assert.deepEqual(readLeb128(Buffer.from([0x80, 0x01]), 0, 'x'), [128, 2]);
  assert.deepEqual(readLeb128(Buffer.from([0xe5, 0x8e, 0x26]), 0, 'x'), [624485, 3]);
  assert.deepEqual(readLeb128(Buffer.from([0xff, 0xff, 0xff, 0xff, 0x0f]), 0, 'x'), [4294967295, 5]);
});

test('it starts where it is told, and says where the next thing begins', () => {
  assert.deepEqual(readLeb128(Buffer.from([9, 9, 0x80, 0x01, 7]), 2, 'x'), [128, 4]);
});

test('bytes that end in the middle of a number are refused, naming the number', () => {
  assert.throws(() => readLeb128(Buffer.from([0x80]), 0, 'the size of section 7'), /the Wasm ends inside the size of section 7/);
  assert.throws(() => readLeb128(Buffer.alloc(0), 0, 'x'), /ends inside x/);
  assert.throws(() => readLeb128(Buffer.from([1]), 5, 'x'), /ends inside x/);
});

test('a number longer than five bytes is refused as oversized, not read as a huge value', () => {
  assert.throws(() => readLeb128(Buffer.from([0x80, 0x80, 0x80, 0x80, 0x80, 0x01]), 0, 'a count'), /oversized number in a count/);
});
