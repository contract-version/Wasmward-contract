import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';
import { RUSTC_VERSION, STELLAR_CLI_VERSION } from './doctor.mjs';

// The deployed hashes are a function of the source, the Stellar CLI and the Rust compiler. The versions of the last two
// are written in several places (the pin, the doctor, the workflow that reproduces the hashes, the guides). They have to
// be the same everywhere, or one of them tells people to use a toolchain that does not give the deployed hashes.

const read = (path) => readFileSync(new URL(`../${path}`, import.meta.url), 'utf8');
const toolchain = read('rust-toolchain.toml');

test('the repository pins the compiler, with what CI and a contributor need', () => {
  assert.match(toolchain, /^channel = "(\d+\.\d+\.\d+)"$/m, 'the channel must be an exact version, not stable');
  assert.match(toolchain, /^components = \[[^\]]*"rustfmt"[^\]]*"clippy"[^\]]*\]$/m);
  assert.match(toolchain, /^targets = \["wasm32v1-none"\]$/m);
  assert.match(toolchain, /^profile = "minimal"$/m);
});

test('the pinned compiler is the one the doctor and the guides name', () => {
  const pinned = toolchain.match(/^channel = "([^"]+)"$/m)[1];
  assert.equal(pinned, RUSTC_VERSION, 'rust-toolchain.toml and doctor.mjs disagree');
  assert.ok(read('docs/HASH-PROVENANCE.md').includes(`| **${pinned}** |`) || read('docs/HASH-PROVENANCE.md').includes(`| ${pinned} |`), 'HASH-PROVENANCE.md does not show the pinned compiler');
  assert.ok(read('scripts/verify-hashes.sh').includes(`rustc ${pinned}`), 'verify-hashes.sh names another compiler');
});

test('the workflow that reproduces the hashes runs the pinned compiler and the pinned CLI', () => {
  const workflow = read('.github/workflows/reproducibility.yml');
  const pinned = toolchain.match(/^channel = "([^"]+)"$/m)[1];
  assert.ok(workflow.includes(`- rust: '${pinned}'`), 'the workflow does not test the pinned compiler');
  assert.ok(workflow.includes(`--version ${STELLAR_CLI_VERSION}`), 'the workflow installs another Stellar CLI');
  assert.ok(read('scripts/verify-hashes.sh').includes(`Stellar CLI ${STELLAR_CLI_VERSION}`), 'verify-hashes.sh names another CLI');
});

test('the file says why it is pinned and what changing it means', () => {
  assert.match(toolchain, /Changing the version changes the hashes/);
  assert.match(toolchain, /HASH-PROVENANCE\.md/);
});
