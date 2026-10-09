import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';
import { compareReport, diff, explain } from './wasm-compare.mjs';
import { parseCodeEntry } from './wasm-code.mjs';
import { readWasm } from './wasm-sections.mjs';

const recorded = JSON.parse(readFileSync(new URL('./fixtures/testnet-code-entries.json', import.meta.url), 'utf8'));
const deployed = (label) => readWasm(parseCodeEntry(recorded.builds[label].xdr).code);

const HEADER = Buffer.from('0061736d01000000', 'hex');
const u32 = (value) => {
  const bytes = Buffer.alloc(4);
  bytes.writeUInt32BE(value);
  return bytes;
};
const section = (id, body) => Buffer.concat([Buffer.from([id]), Buffer.from([body.length]), body]); // bodies stay under 128 bytes
const custom = (name, body) => section(0, Buffer.concat([Buffer.from([name.length]), Buffer.from(name), body]));
const xdrString = (text) => Buffer.concat([u32(text.length), Buffer.from(text), Buffer.alloc((4 - (text.length % 4)) % 4)]);
const meta = (pairs) => custom('contractmetav0', Buffer.concat(pairs.flatMap(([k, v]) => [u32(0), xdrString(k), xdrString(v)])));
const env = (protocol) => custom('contractenvmetav0', Buffer.concat([u32(0), u32(protocol), u32(0)]));

/** A small module: the given code and data, the given metadata pairs, and an interface version. */
function module({ code = 'code-a', data = 'data-a', pairs = [['rsver', '1.96.1'], ['rssdkver', '26.1.1']], protocol = 26, extra = [] } = {}) {
  return readWasm(Buffer.concat([HEADER, section(10, Buffer.from(code)), section(11, Buffer.from(data)), env(protocol), meta(pairs), ...extra]));
}

test('identical modules are said to be the same Wasm', () => {
  const d = diff(module(), module());
  assert.equal(d.sameHash, true);
  assert.deepEqual(explain(d), ['The two are the same Wasm: identical bytes, identical hash.']);
});

test('the real deployed v1 and v2: same tools and size, only the code differs, and it says so', () => {
  const d = diff(deployed('v1'), deployed('v2'));
  assert.equal(d.sameHash, false);
  assert.deepEqual(d.toolchain, []);
  assert.equal(d.interface, null);
  assert.deepEqual(d.sections, { differ: [{ label: 'code', a: [352], b: [352], sameSizes: true }], onlyA: [], onlyB: [] });
  assert.deepEqual(explain(d), ['The recorded tools are the same but the code differs, so the source (or an unrecorded build setting) is different.']);
});

test('a different recorded compiler or SDK is reported as different tools', () => {
  const b = module({ pairs: [['rsver', '1.95.0'], ['rssdkver', '26.1.1']] });
  const d = diff(module(), b);
  assert.deepEqual(d.toolchain, [{ what: 'compiler', a: '1.96.1', b: '1.95.0' }]);
  assert.deepEqual(explain(d), ['They were built with different tools: compiler differ.']);
  const both = diff(module(), module({ pairs: [['rsver', '1.95.0'], ['rssdkver', '25.0.0']] }));
  assert.deepEqual(explain(both), ['They were built with different tools: compiler and sdk differ.']);
});

test('a different interface version is reported as different tools', () => {
  const d = diff(module(), module({ protocol: 25 }));
  assert.deepEqual(d.interface, { a: 26, b: 25 });
  assert.deepEqual(explain(d), ['They were built with different tools: interface version differ.']);
});

test('a cliver entry on one side only means that side was processed by the Stellar CLI', () => {
  const processed = module({ extra: [meta([['cliver', '27.0.0']])] });
  const plain = module();
  const code = diff(plain, module({ code: 'smaller', extra: [meta([['cliver', '27.0.0']])] }));
  assert.deepEqual(explain(code), ['Only B carries a cliver entry, so only B was processed by the Stellar CLI, and its code section differs.']);
  // Same code, so no claim is made about the code.
  assert.deepEqual(explain(diff(plain, processed)).filter((line) => line.startsWith('Only')), ['Only B carries a cliver entry, so only B was processed by the Stellar CLI.']);
  // And from the other side.
  assert.match(explain(diff(processed, plain))[0], /^Only A carries a cliver entry/);
});

test('two different cliver versions are not mistaken for "processed on one side only"', () => {
  const [a, b] = [module({ extra: [meta([['cliver', '27.0.0']])] }), module({ extra: [meta([['cliver', '28.0.0']])] })];
  const d = diff(a, b);
  assert.deepEqual(d.toolchain, [{ what: 'cli', a: '27.0.0', b: '28.0.0' }]);
  assert.ok(!explain(d).some((line) => line.startsWith('Only')));
});

test('sections present on one side only are listed, and repeated sections are compared together', () => {
  const a = module({ extra: [custom('extra', Buffer.from('x'))] });
  const b = module({ extra: [meta([['cliver', '27.0.0']])] });
  const d = diff(a, b);
  assert.deepEqual(d.sections.onlyA, ['custom extra']);
  assert.deepEqual(d.sections.onlyB, []);
  assert.equal(d.sections.differ.find((s) => s.label === 'custom contractmetav0').b.length, 2);
});

test('a difference only outside the code is described as such, not as unexplained bytes', () => {
  const d = diff(module(), module({ data: 'data-b' }));
  assert.deepEqual(d.sections.differ.map((s) => s.label), ['data']);
  assert.deepEqual(explain(d), ['They differ in sections other than the code (listed above), and nothing recorded says why.']);
});

test('the report names both sides and ends with the explanation after a blank line', () => {
  const [a, b] = [module(), module({ code: 'different-code' })];
  const lines = compareReport('local.wasm', 'deployed:a7a82511...', a, b);
  assert.deepEqual(lines.slice(0, 3), ['A  local.wasm', 'B  deployed:a7a82511...', 'hash      different']);
  assert.equal(lines[3], `size      A ${a.size} bytes, B ${b.size} bytes`);
  assert.ok(b.size > a.size);
  assert.ok(lines.includes('compiler  same (1.96.1)'));
  assert.ok(lines.includes('cli       same (none)'));
  assert.ok(lines.includes('section   code: A 6, B 14'));
  assert.equal(lines.at(-2), '');
  assert.match(lines.at(-1), /^The recorded tools are the same but the code differs/);
});

test('the report says "same size, different content" for a section that changed without growing', () => {
  const lines = compareReport('a', 'b', module({ code: 'code-a' }), module({ code: 'code-b' }));
  assert.ok(lines.includes('section   code: same size (6), different content'));
});
