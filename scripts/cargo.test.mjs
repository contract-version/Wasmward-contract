import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';

// The deployed Wasm hashes are pinned in three repositories. Anything in the build settings can change the Wasm, so
// these settings are held where a change shows up as a failing test, with the reason, instead of as a new hash
// that nobody asked for. (A Rust toolchain change does the same, which no test here can stop; see
// docs/HASH-PROVENANCE.md.)

const read = (path) => readFileSync(new URL(`../${path}`, import.meta.url), 'utf8');
const workspace = read('Cargo.toml');
const crate = read('contracts/fixture/Cargo.toml');
const lock = read('Cargo.lock');
const readme = read('README.md');
const ci = read('.github/workflows/ci.yml');
const contributing = read('CONTRIBUTING.md');

/** The lines under a `[table]` header, up to the next one. */
function section(text, header) {
  const start = text.indexOf(`[${header}]`);
  assert.notEqual(start, -1, `no [${header}] in the manifest`);
  const rest = text.slice(start + header.length + 2);
  const end = rest.search(/^\[/m);
  return end === -1 ? rest : rest.slice(0, end);
}

test('the release profile is the one the deployed hashes were built with', () => {
  const release = section(workspace, 'profile.release');
  for (const setting of ['opt-level = "z"', 'overflow-checks = true', 'debug = 0', 'strip = "symbols"', 'debug-assertions = false', 'panic = "abort"', 'codegen-units = 1', 'lto = true']) {
    assert.ok(release.includes(setting), `[profile.release] no longer has ${setting}; this changes the Wasm and so its hash`);
  }
});

test('soroban-sdk is pinned to one exact version, and the lock file, README and manifest agree', () => {
  const pin = workspace.match(/^soroban-sdk = "=(\d+\.\d+\.\d+)"/m)?.[1];
  assert.ok(pin, 'the workspace does not pin soroban-sdk with =x.y.z');
  assert.match(lock, new RegExp(`name = "soroban-sdk"\\nversion = "${pin.replaceAll('.', '\\.')}"`), 'Cargo.lock has another soroban-sdk');
  assert.ok(readme.includes(`\`=${pin}\``), `the README does not say the pin is =${pin}`);
});

test('the crate takes the SDK and the lints from the workspace, so there is one place to change them', () => {
  assert.match(section(crate, 'dependencies'), /^soroban-sdk = \{ workspace = true \}$/m);
  assert.match(section(crate, 'dev-dependencies'), /soroban-sdk = \{ workspace = true, features = \["testutils"\] \}/);
  assert.match(section(crate, 'lints'), /^workspace = true$/m);
  assert.match(section(workspace, 'workspace.lints.rust'), /^unsafe_code = "deny"$/m);
});

test('the crate is a Wasm library with a v2 feature that turns nothing else on', () => {
  assert.match(crate, /^crate-type = \["lib", "cdylib"\]$/m);
  assert.match(section(crate, 'features'), /^v2 = \[\]$/m);
  assert.match(crate, /^publish = false$/m);
});

test('the package name is the one CI builds', () => {
  const name = crate.match(/^name = "([^"]+)"/m)[1];
  assert.equal(name, 'wasmward-fixture');
  assert.ok(ci.includes(`-p ${name}`), 'CI builds a different package');
  assert.ok(ci.includes(`${name.replaceAll('-', '_')}.wasm`), 'CI copies a different Wasm file');
});

test('every cargo command CONTRIBUTING asks for is one CI runs', () => {
  const asked = contributing
    .split('```bash')[1]
    .split('```')[0]
    .split('\n')
    .map((line) => line.trim())
    .filter((line) => line.startsWith('cargo '));
  assert.ok(asked.length >= 5, asked.join(' | '));
  const ran = ci.split('\n').map((line) => line.trim().replace(/^run: /, ''));
  for (const command of asked) assert.ok(ran.includes(command), `CONTRIBUTING runs "${command}" but CI does not`);
});
