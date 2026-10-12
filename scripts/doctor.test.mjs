import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { test } from 'node:test';
import { checkTools, render, STELLAR_CLI_VERSION, versionIn } from './doctor.mjs';

/** A stand-in for running commands: `known` maps "command arg arg" to the text it prints; anything else is missing. */
const runner = (known) => (command, args) => known[[command, ...args].join(' ')];

const EVERYTHING = {
  'git --version': 'git version 2.51.2',
  'rustc --version': 'rustc 1.96.1 (31fca3adb 2026-06-26)',
  'cargo --version': 'cargo 1.96.1 (356927216 2026-06-26)',
  'cargo fmt --version': 'rustfmt 1.9.0-stable',
  'cargo clippy --version': 'clippy 0.1.96',
  'rustup target list --installed': 'wasm32-unknown-unknown\nwasm32v1-none\nx86_64-pc-windows-msvc',
  'stellar --version': `stellar ${STELLAR_CLI_VERSION} (5a7c5fe)\nstellar-xdr 27.0.0`,
};
const byName = (results, name) => results.find((entry) => entry.name === name);

test('versions are read as three numbers from the first x.y.z in the text', () => {
  assert.deepEqual(versionIn('rustc 1.96.1 (31fca3adb 2026-06-26)'), [1, 96, 1]);
  assert.deepEqual(versionIn('stellar 27.0.0 (5a7c5fe)'), [27, 0, 0]);
  assert.equal(versionIn('no numbers here'), undefined);
  assert.equal(versionIn(undefined), undefined);
});

test('with everything installed, every tool is ok and none has a fix to suggest', () => {
  const results = checkTools(runner(EVERYTHING), '22.4.0');
  assert.ok(results.length >= 9);
  for (const entry of results) {
    assert.equal(entry.ok, true, `${entry.name} should be ok`);
    assert.equal(entry.fix, undefined);
  }
  assert.equal(byName(results, 'stellar').found, `stellar ${STELLAR_CLI_VERSION} (5a7c5fe)`);
});

test('Node 17 is too old, and the message says how to get a newer one', () => {
  const node = byName(checkTools(runner(EVERYTHING), '17.9.1'), 'node');
  assert.equal(node.ok, false);
  assert.equal(node.required, true);
  assert.match(node.fix, /Node 18 or newer/);
  assert.equal(byName(checkTools(runner(EVERYTHING), '18.0.0'), 'node').ok, true);
});

test('only Node and git are required: the Rust and Stellar tools are optional', () => {
  const required = checkTools(runner({}), '22.4.0').filter((entry) => entry.required).map((entry) => entry.name);
  assert.deepEqual(required, ['node', 'git']);
});

test('a missing git is required, and a missing Rust tool is not', () => {
  const { 'git --version': _git, ...withoutGit } = EVERYTHING;
  assert.equal(byName(checkTools(runner(withoutGit), '22.4.0'), 'git').ok, false);
  const { 'cargo clippy --version': _clippy, ...withoutClippy } = EVERYTHING;
  const clippy = byName(checkTools(runner(withoutClippy), '22.4.0'), 'clippy');
  assert.deepEqual([clippy.ok, clippy.required, clippy.fix], [false, false, 'rustup component add clippy']);
});

test('the Wasm target is found among the installed ones, by exact name', () => {
  const only = { ...EVERYTHING, 'rustup target list --installed': 'wasm32-unknown-unknown' };
  assert.equal(byName(checkTools(runner(only), '22.4.0'), 'wasm32v1-none').ok, false);
  const noRustup = { ...EVERYTHING };
  delete noRustup['rustup target list --installed'];
  assert.equal(byName(checkTools(runner(noRustup), '22.4.0'), 'wasm32v1-none').ok, false);
});

test('another Stellar CLI version is reported as one that may give other hashes', () => {
  const other = { ...EVERYTHING, 'stellar --version': 'stellar 28.1.0 (abc)' };
  const entry = byName(checkTools(runner(other), '22.4.0'), 'stellar version');
  assert.equal(entry.ok, false);
  assert.equal(entry.found, '28.1.0');
  assert.match(entry.fix, new RegExp(`Stellar CLI ${STELLAR_CLI_VERSION}`));
  assert.equal(byName(checkTools(runner(other), '22.4.0'), 'stellar').ok, true, 'it is installed, just not that version');
});

test('without the Stellar CLI there is no version line to judge', () => {
  const { 'stellar --version': _stellar, ...without } = EVERYTHING;
  const results = checkTools(runner(without), '22.4.0');
  assert.equal(byName(results, 'stellar').ok, false);
  assert.equal(byName(results, 'stellar version'), undefined);
});

test('the report says the script tests can run when only optional things are missing', () => {
  const lines = render(checkTools(runner({ 'git --version': 'git version 2' }), '22.4.0'));
  const text = lines.join('\n');
  assert.match(text, /^ok {7}node/m);
  assert.match(text, /^missing {2}rustc/m);
  assert.match(text, /The script tests can run: node --test scripts\/\*\.test\.mjs/);
  assert.match(text, /Not found, needed only for the Rust and deploy work: rustc, cargo, rustfmt, clippy, wasm32v1-none, stellar\./);
});

test('the report names what is missing and required, in capitals for the mark', () => {
  const text = render(checkTools(runner(EVERYTHING), '16.0.0')).join('\n');
  assert.match(text, /^MISSING {2}node {2}16\.0\.0/m);
  assert.match(text, /Missing, and needed for the script tests: node\./);
  assert.doesNotMatch(text, /The script tests can run/);
});

/** Runs the script for real. */
const run = (args) =>
  new Promise((resolve) => execFile(process.execPath, ['scripts/doctor.mjs', ...args], (error, stdout, stderr) => resolve({ status: error ? error.code : 0, stdout, stderr })));

test('run for real: this machine can run the script tests, so exit 0, and --json says the same', async () => {
  const text = await run([]);
  assert.equal(text.status, 0, text.stdout);
  assert.match(text.stdout, /^ok {7}node/m);
  const json = await run(['--json']);
  assert.equal(json.status, 0);
  const report = JSON.parse(json.stdout);
  assert.equal(report.ok, true);
  assert.ok(report.tools.some((entry) => entry.name === 'node' && entry.ok));
});

test('run for real: an unknown option exits 2', async () => {
  const result = await run(['--nope']);
  assert.equal(result.status, 2);
  assert.match(result.stderr, /unknown option --nope/);
});
