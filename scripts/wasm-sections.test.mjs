import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';
import { parseCodeEntry } from './wasm-code.mjs';
import { parseEnvMeta, parseMeta, readWasm } from './wasm-sections.mjs';

const recorded = JSON.parse(readFileSync(new URL('./fixtures/testnet-code-entries.json', import.meta.url), 'utf8'));
const deployed = (label) => parseCodeEntry(recorded.builds[label].xdr).code;

const HEADER = Buffer.from('0061736d01000000', 'hex');
const u32 = (value) => {
  const bytes = Buffer.alloc(4);
  bytes.writeUInt32BE(value);
  return bytes;
};
function leb(value) {
  const out = [];
  do {
    let byte = value & 0x7f;
    value = Math.floor(value / 128);
    if (value > 0) byte |= 0x80;
    out.push(byte);
  } while (value > 0);
  return Buffer.from(out);
}
const section = (id, body) => Buffer.concat([Buffer.from([id]), leb(body.length), body]);
const custom = (name, body) => section(0, Buffer.concat([leb(name.length), Buffer.from(name), body]));
const xdrString = (text) => Buffer.concat([u32(Buffer.byteLength(text)), Buffer.from(text), Buffer.alloc((4 - (Buffer.byteLength(text) % 4)) % 4)]);
const metaBody = (pairs) => Buffer.concat(pairs.flatMap(([key, value]) => [u32(0), xdrString(key), xdrString(value)]));
const envBody = (protocol, preRelease = 0) => Buffer.concat([u32(0), u32(protocol), u32(preRelease)]);

test('reads the real deployed v1: its sections, versions and interface', () => {
  const info = readWasm(deployed('v1'));
  assert.equal(info.size, 1204);
  assert.equal(info.sha256, recorded.builds.v1.wasmHash);
  assert.deepEqual(info.meta.map((m) => m.key), ['rsver', 'rssdkver', 'cliver']);
  assert.match(info.meta[0].value, /^\d+\.\d+\.\d+$/);
  assert.match(info.meta[1].value, /^26\.1\.1#[0-9a-f]{40}$/);
  assert.match(info.meta[2].value, /^\d+\.\d+\.\d+#[0-9a-f]{40}$/);
  assert.deepEqual(info.interface, { protocol: 26, preRelease: 0 });
  assert.deepEqual(
    info.sections.filter((s) => s.id === 0).map((s) => s.name),
    ['contractspecv0', 'contractenvmetav0', 'contractmetav0', 'contractmetav0'],
  );
});

test('the two real builds differ only in what the code does, not in their metadata', () => {
  const [v1, v2] = ['v1', 'v2'].map((label) => readWasm(deployed(label)));
  assert.deepEqual(v1.meta, v2.meta);
  assert.deepEqual(v1.interface, v2.interface);
  assert.notEqual(v1.sha256, v2.sha256);
});

test('reads a module built by hand, with its sections in order', () => {
  const wasm = Buffer.concat([
    HEADER,
    section(1, Buffer.from([0])),
    custom('contractenvmetav0', envBody(25, 3)),
    custom('contractmetav0', metaBody([['rsver', '1.90.0']])),
    custom('contractmetav0', metaBody([['cliver', '9.9.9']])),
    custom('somethingelse', Buffer.from('ignored')),
  ]);
  const info = readWasm(wasm);
  assert.deepEqual(info.sections.map((s) => [s.id, s.name]), [[1, undefined], [0, 'contractenvmetav0'], [0, 'contractmetav0'], [0, 'contractmetav0'], [0, 'somethingelse']]);
  assert.deepEqual(info.meta, [{ key: 'rsver', value: '1.90.0' }, { key: 'cliver', value: '9.9.9' }]);
  assert.deepEqual(info.interface, { protocol: 25, preRelease: 3 });
  assert.equal(info.sha256, createHash('sha256').update(wasm).digest('hex'));
});

test('a module with no sections is valid and has nothing to report', () => {
  const info = readWasm(HEADER);
  assert.deepEqual([info.size, info.sections, info.meta, info.interface], [8, [], [], undefined]);
});

test('sizes that need more than one LEB128 byte are read correctly', () => {
  for (const size of [127, 128, 300, 16_384, 70_000]) {
    const info = readWasm(Buffer.concat([HEADER, section(10, Buffer.alloc(size, 1)), custom('contractmetav0', metaBody([['k', 'v']]))]));
    assert.equal(info.sections[0].size, size, `size ${size}`);
    assert.deepEqual(info.meta, [{ key: 'k', value: 'v' }]);
  }
});

test('metadata strings of every padding length are read back exactly', () => {
  for (const text of ['', 'a', 'ab', 'abc', 'abcd', 'abcde', 'rsver-1.96.1#0123456789']) {
    assert.deepEqual(parseMeta(metaBody([[text, text + '!']])), [{ key: text, value: `${text}!` }], JSON.stringify(text));
  }
});

test('refuses what is not a Wasm module', () => {
  assert.throws(() => readWasm(Buffer.from('hello world')), /not a Wasm module/);
  assert.throws(() => readWasm(Buffer.alloc(0)), /not a Wasm module/);
  assert.throws(() => readWasm(Buffer.from('0061736d', 'hex')), /not a Wasm module/);
  assert.throws(() => readWasm(Buffer.from('0061736d02000000', 'hex')), /version 2/);
});

test('refuses sections that run past the end, however the file was cut', () => {
  const whole = deployed('v1');
  const info = readWasm(whole);
  // Cut in the middle of each section: the size it announces can no longer be there.
  let start = 8;
  for (const s of info.sections) {
    const headerBytes = 1 + leb(s.size).length;
    const middle = start + headerBytes + Math.floor(s.size / 2);
    if (s.size > 1) assert.throws(() => readWasm(whole.subarray(0, middle)), /says it is \d+ bytes but only \d+ remain/, `cut inside section ${s.id} ${s.name ?? ''}`);
    start += headerBytes + s.size;
  }
});

test('refuses a size that is cut off or oversized, and a custom name that does not fit', () => {
  assert.throws(() => readWasm(Buffer.concat([HEADER, Buffer.from([10, 0x80])])), /ends inside the size of section 10/);
  assert.throws(() => readWasm(Buffer.concat([HEADER, Buffer.from([10, 0x80, 0x80, 0x80, 0x80, 0x80, 0x01])])), /oversized number/);
  assert.throws(() => readWasm(Buffer.concat([HEADER, section(0, Buffer.concat([leb(50), Buffer.from('short')]))])), /name longer than the section/);
});

test('refuses metadata it cannot read fully, or of a kind it does not know', () => {
  assert.throws(() => parseMeta(Buffer.concat([u32(1), xdrString('k'), xdrString('v')])), /entry kind \(1\)/);
  const whole = metaBody([['rsver', '1.96.1']]);
  for (let length = 1; length < whole.length; length += 1) {
    assert.throws(() => parseMeta(whole.subarray(0, length)), /ends inside/, `cut at ${length}`);
  }
  assert.deepEqual(parseMeta(Buffer.alloc(0)), []);
});

test('refuses environment metadata of the wrong size or kind', () => {
  assert.deepEqual(parseEnvMeta(envBody(26)), { protocol: 26, preRelease: 0 });
  assert.throws(() => parseEnvMeta(Buffer.alloc(8)), /8 bytes, expected 12/);
  assert.throws(() => parseEnvMeta(Buffer.concat([u32(1), u32(26), u32(0)])), /entry kind \(1\)/);
});
