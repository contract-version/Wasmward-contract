import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { pathToFileURL } from 'node:url';
import { helpFromHeader, wantsHelp } from './help.mjs';

function script(text) {
  const dir = mkdtempSync(join(tmpdir(), 'help-'));
  const path = join(dir, 'tool.mjs');
  writeFileSync(path, text);
  return { url: pathToFileURL(path).href, cleanup: () => rmSync(dir, { recursive: true, force: true }) };
}

test('help is asked for by --help or -h, anywhere in the arguments', () => {
  assert.equal(wantsHelp(['--help']), true);
  assert.equal(wantsHelp(['-h']), true);
  assert.equal(wantsHelp(['a.wasm', '--json', '--help']), true);
  assert.equal(wantsHelp([]), false);
  assert.equal(wantsHelp(['--helpful']), false);
});

test('the help is the leading comment, without the slashes and without the shebang', () => {
  const tool = script('#!/usr/bin/env node\n// Does a thing.\n//\n//   node scripts/tool.mjs [--flag]\n//\n// Exit codes: 0 fine.\nimport x from "y";\n// not part of it\n');
  try {
    assert.equal(helpFromHeader(tool.url), 'Does a thing.\n\n  node scripts/tool.mjs [--flag]\n\nExit codes: 0 fine.');
  } finally {
    tool.cleanup();
  }
});

test('it stops at the first line that is not a comment, and works without a shebang', () => {
  const tool = script('// First.\n// Second.\n\n// Third, after a blank line.\n');
  try {
    assert.equal(helpFromHeader(tool.url), 'First.\nSecond.');
  } finally {
    tool.cleanup();
  }
});

test('Windows line endings do not leave a carriage return in the help', () => {
  const tool = script('#!/usr/bin/env node\r\n// One.\r\n// Two.\r\nconst x = 1;\r\n');
  try {
    assert.equal(helpFromHeader(tool.url), 'One.\nTwo.');
  } finally {
    tool.cleanup();
  }
});

test('a script with no leading comment has empty help rather than an error', () => {
  const tool = script('const x = 1;\n');
  try {
    assert.equal(helpFromHeader(tool.url), '');
  } finally {
    tool.cleanup();
  }
});
