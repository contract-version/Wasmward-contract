import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { describe, parseArgs, sectionLabel } from './wasm-info.mjs';
import { parseCodeEntry } from './wasm-code.mjs';
import { readWasm } from './wasm-sections.mjs';

const SCRIPT = fileURLToPath(new URL('./wasm-info.mjs', import.meta.url));
const recorded = JSON.parse(readFileSync(new URL('./fixtures/testnet-code-entries.json', import.meta.url), 'utf8'));
const deployed = (label) => parseCodeEntry(recorded.builds[label].xdr).code;

/** Runs the script with these files written into a temp directory. Resolves { status, stdout, stderr, dir }. */
function run(args, files = {}) {
  const dir = mkdtempSync(join(tmpdir(), 'wasm-info-'));
  for (const [name, bytes] of Object.entries(files)) writeFileSync(join(dir, name), bytes);
  return new Promise((resolve) =>
    execFile(process.execPath, [SCRIPT, ...args], { cwd: dir }, (error, stdout, stderr) => {
      rmSync(dir, { recursive: true, force: true });
      resolve({ status: error ? error.code : 0, stdout, stderr });
    }),
  );
}

test('names every standard section, and says what it does not know', () => {
  assert.equal(sectionLabel({ id: 10, size: 1 }), 'code');
  assert.equal(sectionLabel({ id: 12, size: 1 }), 'data count');
  assert.equal(sectionLabel({ id: 0, name: 'contractmetav0', size: 1 }), 'custom contractmetav0');
  assert.equal(sectionLabel({ id: 99, size: 1 }), 'unknown (id 99)');
});

test('describes the real deployed v1', () => {
  const lines = describe('v1.wasm', readWasm(deployed('v1')));
  assert.equal(lines[0], 'v1.wasm');
  assert.deepEqual(lines.slice(1, 3), ['  size      1204 bytes', `  sha256    ${recorded.builds.v1.wasmHash}`]);
  assert.match(lines[3], /^ {2}compiler {2}\d+\.\d+\.\d+$/);
  assert.match(lines[4], /^ {2}sdk {7}26\.1\.1#[0-9a-f]{40}$/);
  assert.match(lines[5], /^ {2}cli {7}\d+\.\d+\.\d+#[0-9a-f]{40}$/);
  assert.equal(lines[6], '  interface protocol 26');
  assert.match(lines[7], /^ {2}sections {2}type 23, import 49, .*, code 352, data 14, custom contractspecv0 387/);
  assert.equal(lines.length, 8);
});

test('says plainly when a module records no versions or was not processed by the Stellar CLI', () => {
  const bare = Buffer.from('0061736d01000000', 'hex');
  const lines = describe('bare.wasm', readWasm(bare));
  assert.ok(lines.includes('  compiler  (not recorded)'));
  assert.ok(lines.includes('  sdk       (not recorded)'));
  assert.ok(lines.includes('  cli       (none: not processed by the Stellar CLI)'));
  assert.ok(lines.includes('  interface (not recorded)'));
  assert.ok(lines.includes('  sections  '));
});

test('parseArgs wants exactly one file and no options yet', () => {
  assert.deepEqual(parseArgs(['a.wasm']), { targets: ['a.wasm'] });
  assert.throws(() => parseArgs([]), /give the Wasm file/);
  assert.throws(() => parseArgs(['a.wasm', 'b.wasm']), /give one Wasm file/);
  assert.throws(() => parseArgs(['--json', 'a.wasm']), /unknown option --json/);
});

test('prints the description of a file and exits 0', async () => {
  const result = await run(['v1.wasm'], { 'v1.wasm': deployed('v1') });
  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /^v1\.wasm\n {2}size {6}1204 bytes\n {2}sha256 {4}a7a82511/);
  assert.equal(result.stderr, '');
});

test('exits 2, with the file name and the reason, for a file that is not Wasm', async () => {
  const result = await run(['notes.txt'], { 'notes.txt': Buffer.from('not wasm at all') });
  assert.equal(result.status, 2);
  assert.match(result.stderr, /^error: notes\.txt: this is not a Wasm module/);
  assert.equal(result.stdout, '');
});

test('exits 2 for a file that does not exist, and for a damaged one', async () => {
  const missing = await run(['nothing.wasm']);
  assert.equal(missing.status, 2);
  assert.match(missing.stderr, /^error: nothing\.wasm: ENOENT/);
  const damaged = await run(['half.wasm'], { 'half.wasm': deployed('v1').subarray(0, 600) });
  assert.equal(damaged.status, 2);
  assert.match(damaged.stderr, /says it is \d+ bytes but only \d+ remain/);
});

test('exits 2 with a usage message when called wrongly', async () => {
  for (const args of [[], ['a', 'b'], ['--nope']]) {
    const result = await run(args);
    assert.equal(result.status, 2, args.join(' '));
    assert.match(result.stderr, /^error: /);
    assert.equal(result.stdout, '');
  }
});
