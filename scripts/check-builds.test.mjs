import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { EXPECTED_FUNCTIONS, exportProblems, problemsWith } from './check-builds.mjs';
import { parseCodeEntry } from './wasm-code.mjs';
import { readWasm } from './wasm-sections.mjs';

const SCRIPT = fileURLToPath(new URL('./check-builds.mjs', import.meta.url));
const recorded = JSON.parse(readFileSync(new URL('./fixtures/testnet-code-entries.json', import.meta.url), 'utf8'));
const deployedBytes = (label) => parseCodeEntry(recorded.builds[label].xdr).code;

const HEADER = Buffer.from('0061736d01000000', 'hex');
const u32 = (value) => {
  const bytes = Buffer.alloc(4);
  bytes.writeUInt32BE(value);
  return bytes;
};
const section = (id, body) => Buffer.concat([Buffer.from([id]), Buffer.from([body.length]), body]);
const custom = (name, body) => section(0, Buffer.concat([Buffer.from([name.length]), Buffer.from(name), body]));
const xdrString = (text) => Buffer.concat([u32(text.length), Buffer.from(text), Buffer.alloc((4 - (text.length % 4)) % 4)]);
const meta = (pairs) => custom('contractmetav0', Buffer.concat(pairs.flatMap(([k, v]) => [u32(0), xdrString(k), xdrString(v)])));
const env = (protocol) => custom('contractenvmetav0', Buffer.concat([u32(0), u32(protocol), u32(0)]));

/** A small module as bytes, with the given code, data, metadata and interface version. */
function moduleBytes({ code = 'code-1', data = 'data-1', pairs = [['rsver', '1.96.1'], ['rssdkver', '26.1.1']], protocol = 26, extra = [] } = {}) {
  return Buffer.concat([HEADER, section(10, Buffer.from(code)), section(11, Buffer.from(data)), env(protocol), meta(pairs), ...extra]);
}
const read = (options) => readWasm(moduleBytes(options));

test('the real deployed v1 and v2 are a clean pair', () => {
  assert.deepEqual(problemsWith(readWasm(deployedBytes('v1')), readWasm(deployedBytes('v2'))), []);
});

test('a pair that differs only in its code is clean', () => {
  assert.deepEqual(problemsWith(read(), read({ code: 'code-2' })), []);
});

test('the same Wasm twice is a problem: the v2 feature did nothing', () => {
  assert.deepEqual(problemsWith(read(), read()), ['v1 and v2 are the same Wasm, so the v2 feature changed nothing']);
});

test('a different compiler or SDK is a problem, saying what each side has', () => {
  const problems = problemsWith(read(), read({ code: 'code-2', pairs: [['rsver', '1.99.0'], ['rssdkver', '27.0.0']] }));
  assert.deepEqual(problems, [
    'the compiler differs between v1 and v2 (v1 1.96.1, v2 1.99.0)',
    'the sdk differs between v1 and v2 (v1 26.1.1, v2 27.0.0)',
    // The metadata is itself a section, so its content differing is reported as well.
    'sections other than the code differ: custom contractmetav0',
  ]);
});

test('a Stellar CLI entry on one side only is a problem', () => {
  const problems = problemsWith(read(), read({ code: 'code-2', extra: [meta([['cliver', '27.0.0']])] }));
  assert.ok(problems.includes('the cli differs between v1 and v2 (v1 none, v2 27.0.0)'));
  assert.ok(problems.some((problem) => problem.startsWith('sections other than the code differ: custom contractmetav0')));
});

test('a different interface version is a problem', () => {
  assert.deepEqual(problemsWith(read(), read({ code: 'code-2', protocol: 25 })), [
    'the interface version differs between v1 and v2 (v1 26, v2 25)',
    'sections other than the code differ: custom contractenvmetav0',
  ]);
});

test('another section that differs is a problem even when the code differs as well', () => {
  assert.deepEqual(problemsWith(read(), read({ code: 'code-2', data: 'data-2' })), ['sections other than the code differ: data']);
});

test('a section present on one side only is a problem', () => {
  const problems = problemsWith(read(), read({ code: 'code-2', extra: [custom('extra', Buffer.from('x'))] }));
  assert.deepEqual(problems, ['only v2 has the sections: custom extra']);
});

/** Runs the script on the given files (name to bytes) in a temp directory. */
function run(args, files = {}) {
  const dir = mkdtempSync(join(tmpdir(), 'check-builds-'));
  for (const [name, bytes] of Object.entries(files)) writeFileSync(join(dir, name), bytes);
  return new Promise((resolve) =>
    execFile(process.execPath, [SCRIPT, ...args], { cwd: dir }, (error, stdout, stderr) => {
      rmSync(dir, { recursive: true, force: true });
      resolve({ status: error ? error.code : 0, stdout, stderr });
    }),
  );
}

test('exits 0 and says so for a clean pair', async () => {
  const result = await run(['v1.wasm', 'v2.wasm'], { 'v1.wasm': deployedBytes('v1'), 'v2.wasm': deployedBytes('v2') });
  assert.equal(result.status, 0, result.stderr);
  assert.equal(result.stdout, 'v1 and v2 differ only in their code section, and export the same interface, as intended.\n');
  assert.equal(result.stderr, '');
});

test('exits 1 and prints every problem on stderr for a pair that is not clean', async () => {
  const result = await run(['a.wasm', 'b.wasm'], { 'a.wasm': moduleBytes(), 'b.wasm': moduleBytes({ code: 'code-2', protocol: 25, data: 'data-2' }) });
  assert.equal(result.status, 1);
  assert.equal(result.stdout, '');
  assert.match(result.stderr, /^problem: the interface version differs/m);
  assert.match(result.stderr, /^problem: sections other than the code differ: data, custom contractenvmetav0/m);
});

test('exits 2 for a file that is missing or not Wasm, naming it, and for the wrong number of arguments', async () => {
  const missing = await run(['v1.wasm', 'nothing.wasm'], { 'v1.wasm': deployedBytes('v1') });
  assert.equal(missing.status, 2);
  assert.match(missing.stderr, /^error: nothing\.wasm: ENOENT/);
  const notWasm = await run(['v1.wasm', 'notes.txt'], { 'v1.wasm': deployedBytes('v1'), 'notes.txt': Buffer.from('hello') });
  assert.equal(notWasm.status, 2);
  assert.match(notWasm.stderr, /^error: notes\.txt: this is not a Wasm module/);
  for (const args of [[], ['one.wasm'], ['a', 'b', 'c'], ['--bogus', 'b']]) {
    const result = await run(args);
    assert.equal(result.status, 2, args.join(' '));
    assert.match(result.stderr, /give the two Wasm files/);
  }
});

/** Export entries as bytes: name, kind (0 function, 3 global), index. */
const exportsOf = (...entries) =>
  section(7, Buffer.concat([Buffer.from([entries.length]), ...entries.map(([name, kind, index]) => Buffer.concat([Buffer.from([name.length]), Buffer.from(name), Buffer.from([kind, index])]))]));
const interfaceEntries = EXPECTED_FUNCTIONS.map((name, index) => [name, 0, index]);
const withExports = (entries, options = {}) => moduleBytes({ ...options, extra: [exportsOf(...entries)] });

test('the real deployed v1 and v2 export exactly the contract interface, and the same of it', () => {
  assert.deepEqual(exportProblems(deployedBytes('v1'), deployedBytes('v2')), []);
});

test('the interface the check pins is the three functions the contract has', () => {
  assert.deepEqual(EXPECTED_FUNCTIONS, ['__constructor', 'upgrade', 'version']);
});

test('a pair with the same exports is clean, whatever order they come in', () => {
  const a = withExports(interfaceEntries);
  const b = withExports([...interfaceEntries].reverse(), { code: 'code-2' });
  assert.deepEqual(exportProblems(a, b), []);
});

test('a function only one build exports is reported for that build', () => {
  const v1 = withExports(interfaceEntries);
  const v2 = withExports([...interfaceEntries, ['drain', 0, 9]], { code: 'code-2' });
  assert.deepEqual(exportProblems(v1, v2), ['only v2 exports function drain', 'v2 exports functions the contract is not meant to have: drain']);
  assert.deepEqual(exportProblems(v2, v1), ['only v1 exports function drain', 'v1 exports functions the contract is not meant to have: drain']);
});

test('a function both builds gained is still a change to the contract', () => {
  const both = withExports([...interfaceEntries, ['set_admin', 0, 9]]);
  assert.deepEqual(exportProblems(both, withExports([...interfaceEntries, ['set_admin', 0, 9]], { code: 'code-2' })), [
    'v1 exports functions the contract is not meant to have: set_admin',
    'v2 exports functions the contract is not meant to have: set_admin',
  ]);
});

test('a function both builds lost is reported, with its name', () => {
  const without = withExports(interfaceEntries.filter(([name]) => name !== 'upgrade'));
  assert.deepEqual(exportProblems(without, without), ['v1 no longer exports: upgrade', 'v2 no longer exports: upgrade']);
});

test('a global or the memory that only one build has is reported by kind', () => {
  const v1 = withExports([...interfaceEntries, ['memory', 2, 0]]);
  const v2 = withExports(interfaceEntries, { code: 'code-2' });
  assert.deepEqual(exportProblems(v1, v2), ['only v1 exports memory memory']);
});

test('the command exits 1 and names the extra function for a pair that adds one', async () => {
  const result = await run(['a.wasm', 'b.wasm'], { 'a.wasm': withExports(interfaceEntries), 'b.wasm': withExports([...interfaceEntries, ['drain', 0, 9]], { code: 'code-2' }) });
  assert.equal(result.status, 1);
  assert.match(result.stderr, /^problem: only v2 exports function drain$/m);
  assert.match(result.stderr, /^problem: v2 exports functions the contract is not meant to have: drain$/m);
});

test('the command exits 2 when an export section is cut off', async () => {
  const cut = withExports(interfaceEntries).subarray(0, -3);
  const result = await run(['a.wasm', 'b.wasm'], { 'a.wasm': withExports(interfaceEntries), 'b.wasm': cut });
  assert.notEqual(result.status, 0);
});
