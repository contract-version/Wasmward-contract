import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { findings } from './wasm-paths.mjs';

const wasmWith = (text) => Buffer.concat([Buffer.from('0061736d01000000', 'hex'), Buffer.from([0]), Buffer.from(text, 'latin1'), Buffer.from([0])]);

test('finds a home-folder path, with the file and the byte it starts at', () => {
  const read = () => wasmWith('C:\\Users\\dell\\contract\\src\\lib.rs');
  assert.deepEqual(findings(['a.wasm'], read), [{ file: 'a.wasm', offset: 9, text: 'C:\\Users\\dell\\contract\\src\\lib.rs' }]);
});

test('finds nothing in a file with only a relative path and ordinary text', () => {
  assert.deepEqual(findings(['a.wasm'], () => wasmWith('contracts/fixture/src/lib.rs')), []);
  assert.deepEqual(findings(['a.wasm'], () => wasmWith('admin not set')), []);
});

test('reports every file that has one, each under its own name', () => {
  const read = (file) => wasmWith(file === 'b.wasm' ? '/home/runner/work/x/src/lib.rs' : 'upgrade');
  assert.deepEqual(findings(['a.wasm', 'b.wasm', 'c.wasm'], read).map((entry) => entry.file), ['b.wasm']);
});

test('a very long path is shortened for display', () => {
  const [entry] = findings(['a.wasm'], () => wasmWith(`/home/runner/${'x'.repeat(300)}`));
  assert.ok(entry.text.endsWith('...'));
  assert.ok(entry.text.length < 120);
});

test('a file that cannot be read throws, so the command can exit 2', () => {
  assert.throws(() => findings(['missing.wasm']), /ENOENT|no such file/);
});

/** Runs the script for real on files with the given contents. */
async function run(contents, extra = []) {
  const dir = mkdtempSync(join(tmpdir(), 'wasm-paths-'));
  try {
    const names = contents.map((content, index) => {
      const name = join(dir, `f${index}.wasm`);
      writeFileSync(name, content);
      return name;
    });
    return await new Promise((resolve) =>
      execFile(process.execPath, ['scripts/wasm-paths.mjs', ...names, ...extra], (error, stdout, stderr) => resolve({ status: error ? error.code : 0, stdout, stderr, names })),
    );
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

test('run for real: exit 0 and a sentence when the files are clean', async () => {
  const out = await run([wasmWith('upgrade'), wasmWith('version')]);
  assert.equal(out.status, 0);
  assert.match(out.stdout, /No path from the building machine in any of 2 files\./);
  assert.equal(out.stderr, '');
});

test('run for real: exit 1 and the path on stderr when one file leaks', async () => {
  const out = await run([wasmWith('upgrade'), wasmWith('/Users/someone/code/lib.rs')]);
  assert.equal(out.status, 1);
  assert.match(out.stderr, /f1\.wasm at byte \d+: \/Users\/someone\/code\/lib\.rs/);
  assert.equal(out.stdout, '');
});

test('run for real: --json carries the same verdict', async () => {
  const clean = JSON.parse((await run([wasmWith('upgrade')], ['--json'])).stdout);
  assert.equal(clean.ok, true);
  const leak = await run([wasmWith('C:\\build\\lib.rs')], ['--json']);
  assert.equal(leak.status, 1);
  assert.equal(JSON.parse(leak.stdout).findings.length, 1);
});

test('run for real: exit 2 for no files, an unknown option, or a file that is not there', async () => {
  const none = await run([]);
  assert.equal(none.status, 2);
  assert.match(none.stderr, /give at least one Wasm file/);
  const flag = await run([wasmWith('x')], ['--nope']);
  assert.equal(flag.status, 2);
  assert.match(flag.stderr, /unknown option --nope/);
  const missing = await new Promise((resolve) =>
    execFile(process.execPath, ['scripts/wasm-paths.mjs', join(tmpdir(), 'no-such-wasm-paths.wasm')], (error, stdout, stderr) => resolve({ status: error ? error.code : 0, stderr })),
  );
  assert.equal(missing.status, 2);
  assert.match(missing.stderr, /^error: /);
});
