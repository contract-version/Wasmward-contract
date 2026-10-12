import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';

// package.json exists so that `npm test` works the same on every system: `node --test scripts/*.test.mjs` relies on
// the shell to expand the glob, which Windows shells do not, and older Node versions do not either. Nothing is
// published and there are no dependencies, so the file is small, and what it says has to match the rest.

const read = (path) => readFileSync(new URL(`../${path}`, import.meta.url), 'utf8');
const pkg = JSON.parse(read('package.json'));

test('it is private, has no dependencies and is the Apache-2.0 project the crate says it is', () => {
  assert.equal(pkg.private, true);
  assert.equal(pkg.dependencies, undefined);
  assert.equal(pkg.devDependencies, undefined);
  assert.equal(pkg.license, 'Apache-2.0');
  assert.match(read('contracts/fixture/Cargo.toml'), /^license = "Apache-2\.0"$/m);
});

test('it says Node 18 or newer, which is the oldest the CI matrix and the README run', () => {
  assert.equal(pkg.engines.node, '>=18');
  assert.match(read('.github/workflows/ci.yml'), /node: \[18, 20, 22\]/);
  assert.match(read('README.md'), /Node\.js 18 or newer/);
});

test('npm test runs every test file: they all live under scripts/, where plain `node --test` finds them', () => {
  assert.equal(pkg.scripts.test, 'node --test');
  const tests = execFileSync('git', ['ls-files', '*.test.*'], { encoding: 'utf8' }).split('\n').filter(Boolean);
  assert.ok(tests.length >= 40, `only ${tests.length}`);
  for (const path of tests) assert.match(path, /^scripts\/[\w-]+\.test\.mjs$/, `${path} is not where the test runner looks`);
});

test('the other scripts are shortcuts for commands that exist, with the same options the docs show', () => {
  assert.equal(pkg.scripts.doctor, 'node scripts/doctor.mjs');
  assert.equal(pkg.scripts.status, 'node scripts/fixture-status.mjs --expect v1');
  assert.equal(pkg.scripts.verify, 'bash scripts/verify-hashes.sh');
  for (const command of Object.values(pkg.scripts)) {
    const script = command.match(/scripts\/[\w-]+\.(?:mjs|sh)/)?.[0];
    if (script !== undefined) assert.ok(execFileSync('git', ['ls-files', script], { encoding: 'utf8' }).trim() === script, `${script} does not exist`);
  }
});

test('the repository link is the one the other documents use', () => {
  assert.equal(pkg.repository.url, 'git+https://github.com/contract-version/Wasmward-contract.git');
  assert.match(pkg.bugs.url, /^https:\/\/github\.com\/contract-version\/Wasmward-contract\/issues$/);
});
