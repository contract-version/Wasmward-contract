import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';

// docs/ARCHITECTURE.md is a map. A map that leaves out a script, a workflow or a whole folder is how a new contributor
// ends up not knowing the thing exists, and one that names a file that is gone sends them looking for it.

const doc = readFileSync(new URL('../docs/ARCHITECTURE.md', import.meta.url), 'utf8');
const tracked = execFileSync('git', ['ls-files'], { encoding: 'utf8' }).split('\n').filter(Boolean);

test('every script that is not a test is on the map, by its path', () => {
  const scripts = tracked.filter((path) => /^scripts\/[\w-]+\.(mjs|sh)$/.test(path) && !path.endsWith('.test.mjs'));
  assert.ok(scripts.length >= 20, `only ${scripts.length} scripts`);
  for (const path of scripts) assert.ok(doc.includes(`\`${path}\``), `docs/ARCHITECTURE.md does not mention ${path}`);
});

test('every workflow is on the map', () => {
  const workflows = tracked.filter((path) => path.startsWith('.github/workflows/'));
  assert.equal(workflows.length, 3);
  for (const path of workflows) assert.ok(doc.includes(`\`${path}\``), `docs/ARCHITECTURE.md does not mention ${path}`);
});

test('the contract files are on the map', () => {
  for (const path of ['contracts/fixture/src/lib.rs', 'contracts/fixture/src/test.rs', 'contracts/fixture/tests/upgrade.rs', 'rust-toolchain.toml', 'fixture.wasmward.json']) {
    assert.ok(doc.includes(`\`${path}\``), `docs/ARCHITECTURE.md does not mention ${path}`);
  }
});

test('every path the map names in backticks exists', () => {
  const named = [...doc.matchAll(/`((?:scripts|contracts|\.github|docs)\/[\w./-]+|rust-toolchain\.toml|fixture\.wasmward\.json|Cargo\.(?:toml|lock))`/g)].map((match) => match[1]);
  assert.ok(named.length >= 30, `only ${named.length} paths`);
  for (const path of named) assert.ok(tracked.includes(path), `docs/ARCHITECTURE.md names ${path}, which is not in the repository`);
});

test('every test file that tests the repository rather than one script is named', () => {
  // A test file with no script of the same name is one of these.
  const own = tracked
    .filter((path) => /^scripts\/[\w-]+\.test\.mjs$/.test(path))
    .filter((path) => {
      const base = path.replace(/\.test\.mjs$/, '');
      return !tracked.includes(`${base}.mjs`) && !tracked.includes(`${base}.sh`);
    });
  assert.ok(own.length >= 10, own.join(', '));
  for (const path of own) assert.ok(doc.includes(`\`${path}\``), `docs/ARCHITECTURE.md does not mention ${path}`);
});

test('it is linked from the README and from CONTRIBUTING', () => {
  assert.ok(readFileSync(new URL('../README.md', import.meta.url), 'utf8').includes('docs/ARCHITECTURE.md'));
  assert.ok(readFileSync(new URL('../CONTRIBUTING.md', import.meta.url), 'utf8').includes('docs/ARCHITECTURE.md'));
});
