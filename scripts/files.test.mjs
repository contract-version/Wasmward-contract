import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';

// .gitattributes and .editorconfig say how files are written here: LF line endings, a final newline, and no
// trailing spaces (except in Markdown). A shell script with CRLF fails on Linux with an error about "\r", and the
// scripts are written on Windows as well as read on Linux, so this is checked rather than assumed.

const git = (...args) => execFileSync('git', args, { encoding: 'utf8' });
const tracked = git('ls-files').split('\n').filter(Boolean);
// The Soroban test snapshots are written by the test run, without a final newline, and rewritten by the next one.
const isText = (path) => !/\.(wasm|png|jpg|ico)$/.test(path) && !path.startsWith('contracts/fixture/test_snapshots/');
const textFiles = tracked.filter(isText);

test('there are tracked text files to check', () => {
  assert.ok(textFiles.length >= 40, `only ${textFiles.length}`);
});

test('every tracked text file is stored with LF endings', () => {
  // `git ls-files --eol` says what is in the index (i/) and in the working tree (w/).
  const crlf = git('ls-files', '--eol')
    .split('\n')
    .filter((line) => /^i\/(crlf|mixed)/.test(line))
    .map((line) => line.split('\t')[1]);
  assert.deepEqual(crlf, [], 'these are committed with CRLF');
});

test('shell scripts and Node scripts have no carriage return in the working tree either', () => {
  for (const path of tracked.filter((name) => /\.(sh|mjs)$/.test(name))) {
    assert.ok(!readFileSync(path, 'utf8').includes('\r'), `${path} has a carriage return, so bash would fail on it`);
  }
});

test('every tracked text file ends with exactly one newline', () => {
  const bad = textFiles.filter((path) => {
    const text = readFileSync(path, 'utf8');
    return text.length > 0 && (!text.endsWith('\n') || text.endsWith('\n\n'));
  });
  assert.deepEqual(bad, [], 'these do not end with exactly one newline');
});

test('no tracked text file has trailing spaces, except Markdown (where two mean a line break)', () => {
  const bad = textFiles.filter((path) => !path.endsWith('.md') && /[ \t]+$/m.test(readFileSync(path, 'utf8')));
  assert.deepEqual(bad, [], 'these have trailing whitespace');
});

test('the files are indented with spaces, never tabs', () => {
  const bad = textFiles.filter((path) => !/^(Cargo\.lock|LICENSE)$/.test(path) && /^\t/m.test(readFileSync(path, 'utf8')));
  assert.deepEqual(bad, [], 'these are indented with a tab');
});
