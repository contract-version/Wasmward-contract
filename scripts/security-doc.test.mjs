import assert from 'node:assert/strict';
import { existsSync, readFileSync } from 'node:fs';
import { test } from 'node:test';

// SECURITY.md makes claims about the scripts and the ignore rules. Each one is checked by another test; this ties the
// document to those tests, so that a claim cannot stay in the document after what backs it is removed.

const read = (path) => readFileSync(new URL(`../${path}`, import.meta.url), 'utf8');
const doc = read('SECURITY.md');

test('the document says what is worth reporting, what is not, and how to report', () => {
  for (const heading of ['What is worth reporting', 'What is not', 'How to report', 'If the admin key leaks']) {
    assert.match(doc, new RegExp(`^## ${heading}$`, 'm'), `missing "## ${heading}"`);
  }
});

test('it names the files that hold a secret, and every one of them is git-ignored', () => {
  const ignore = read('.gitignore');
  for (const file of ['.env', '.stellar-keys/', 'testnet.json']) {
    assert.ok(doc.includes(file), `the document no longer names ${file}`);
    assert.ok(ignore.split('\n').includes(file), `${file} is not in .gitignore`);
  }
});

test('each promise it makes has a test that checks it', () => {
  const backing = {
    'prints, logs, commits or sends a secret key': 'scripts/deploy.test.mjs',
    'make `.env`, `.stellar-keys/` or `testnet.json` get committed': 'scripts/secrets.test.mjs',
    'a weekly workflow reports it': 'scripts/workflows.test.mjs',
  };
  for (const [claim, file] of Object.entries(backing)) {
    assert.ok(doc.includes(claim), `the document no longer makes the claim "${claim}"`);
    assert.ok(existsSync(new URL(`../${file}`, import.meta.url)), `${file} does not exist`);
  }
  assert.match(read('scripts/deploy.test.mjs'), /the secret was printed/, 'deploy.test.mjs no longer checks that the secret is not printed');
  assert.match(read('scripts/secrets.test.mjs'), /git-ignored/, 'secrets.test.mjs no longer checks the ignore rules');
});

test('the scripts it says read only public values do not read the identity', () => {
  for (const script of ['check-lifetimes', 'live-build', 'fixture-status', 'sync-config', 'wasm-info', 'check-builds', 'verify-hashes']) {
    const file = existsSync(new URL(`../scripts/${script}.mjs`, import.meta.url)) ? `${script}.mjs` : `${script}.sh`;
    const text = read(`scripts/${file}`);
    assert.doesNotMatch(text, /FIXTURE_SECRET|\.stellar-keys|\.env\b/, `${file} touches the identity`);
  }
});

test('it promises no contact address that this repository cannot stand behind', () => {
  assert.doesNotMatch(doc, /[\w.+-]+@[\w-]+\.[\w.]+/, 'an email address in SECURITY.md');
});
