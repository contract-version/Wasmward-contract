import assert from 'node:assert/strict';
import { existsSync, readFileSync } from 'node:fs';
import { test } from 'node:test';
import { functionNames, readExports } from './wasm-exports.mjs';

const HEADER = Buffer.from([0x00, 0x61, 0x73, 0x6d, 1, 0, 0, 0]);
const leb = (value) => {
  const out = [];
  do {
    let byte = value & 0x7f;
    value >>>= 7;
    if (value !== 0) byte |= 0x80;
    out.push(byte);
  } while (value !== 0);
  return Buffer.from(out);
};
/** One section: its id, the size as LEB128, and the body. */
const section = (id, body) => Buffer.concat([Buffer.from([id]), leb(body.length), body]);
const entry = (name, kind, index) => Buffer.concat([leb(Buffer.byteLength(name)), Buffer.from(name), Buffer.from([kind]), leb(index)]);
const exportSection = (...entries) => section(7, Buffer.concat([leb(entries.length), ...entries]));
const module = (...sections) => Buffer.concat([HEADER, ...sections]);

test('reads the name, kind and index of each export, in file order', () => {
  const wasm = module(exportSection(entry('memory', 2, 0), entry('version', 0, 11), entry('_', 3, 1)));
  assert.deepEqual(readExports(wasm), [
    { name: 'memory', kind: 'memory', index: 0 },
    { name: 'version', kind: 'function', index: 11 },
    { name: '_', kind: 'global', index: 1 },
  ]);
});

test('skips sections that come before the exports, and ones after', () => {
  const wasm = module(section(1, Buffer.from([0])), section(0, Buffer.concat([leb(4), Buffer.from('note'), Buffer.from('xx')])), exportSection(entry('upgrade', 0, 3)), section(10, Buffer.from([0])));
  assert.deepEqual(readExports(wasm), [{ name: 'upgrade', kind: 'function', index: 3 }]);
});

test('a module with no export section exports nothing', () => {
  assert.deepEqual(readExports(module(section(1, Buffer.from([0])))), []);
  assert.deepEqual(readExports(HEADER), []);
});

test('functionNames keeps only functions, sorted', () => {
  const wasm = module(exportSection(entry('version', 0, 1), entry('memory', 2, 0), entry('__constructor', 0, 2), entry('upgrade', 0, 3), entry('_', 3, 1)));
  assert.deepEqual(functionNames(wasm), ['__constructor', 'upgrade', 'version']);
});

test('numbers above 127 are read as LEB128, in the index and in a long name', () => {
  const longName = 'f'.repeat(200);
  const wasm = module(exportSection(entry(longName, 0, 70_000)));
  assert.deepEqual(readExports(wasm), [{ name: longName, kind: 'function', index: 70_000 }]);
});

test('something that is not a Wasm module, or has another version, is refused', () => {
  assert.throws(() => readExports(Buffer.from('hello world, not wasm')), /not a Wasm module/);
  assert.throws(() => readExports(Buffer.from([0, 0x61, 0x73, 0x6d, 2, 0, 0, 0])), /version 2/);
  assert.throws(() => readExports(Buffer.alloc(3)), /not a Wasm module/);
});

test('a cut-off or inconsistent export section says what is wrong', () => {
  const whole = exportSection(entry('upgrade', 0, 3));
  assert.throws(() => readExports(module(whole.subarray(0, whole.length - 2))), /only \d+ remain/);
  assert.throws(() => readExports(module(exportSection(entry('x', 9, 0)))), /kind \(9\)/);
  const extra = section(7, Buffer.concat([leb(1), entry('upgrade', 0, 3), Buffer.from([0xff])]));
  assert.throws(() => readExports(module(extra)), /bytes left over/);
  const lying = section(7, Buffer.concat([leb(1), leb(50), Buffer.from('short')]));
  assert.throws(() => readExports(module(lying)), /runs past the end/);
  assert.throws(() => readExports(module(section(7, Buffer.concat([leb(2), entry('a', 0, 0)])))), /ends inside|runs past/);
});

const built = new URL('../build/v1/wasmward_fixture.wasm', import.meta.url);
test('the locally built v1, when there is one, exports exactly the contract interface', { skip: !existsSync(built) && 'run scripts/deploy.sh or a build first' }, () => {
  assert.deepEqual(functionNames(readFileSync(built)), ['__constructor', 'upgrade', 'version']);
});
