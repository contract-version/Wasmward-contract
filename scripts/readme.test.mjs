import assert from 'node:assert/strict';
import { readdirSync, readFileSync } from 'node:fs';
import { test } from 'node:test';

// The README says what each script is for. A script added without a line there, or a line left behind after a script
// is removed, is the kind of drift nobody notices until someone follows the README and it does not work.

const readme = readFileSync(new URL('../README.md', import.meta.url), 'utf8');
const scriptsDir = new URL('./', import.meta.url);
const files = readdirSync(scriptsDir);
const scripts = files.filter((name) => /\.(mjs|sh)$/.test(name) && !name.endsWith('.test.mjs'));

test('there are scripts to check, and tests next to the ones that have a command line', () => {
  assert.ok(scripts.length >= 10, scripts.join(', '));
  for (const name of scripts.filter((script) => script.endsWith('.mjs'))) {
    assert.ok(files.includes(name.replace(/\.mjs$/, '.test.mjs')), `${name} has no test file next to it`);
  }
});

test('every script is named in the README', () => {
  for (const name of scripts) {
    assert.ok(readme.includes(name.replace(/\.(mjs|sh)$/, '')) || readme.includes(name), `README.md never mentions ${name}`);
  }
});

test('every script with a command line has a row in the scripts table', () => {
  const table = readme.slice(readme.indexOf('| Script | What it does'), readme.indexOf('## CI'));
  const library = /`(rpc|cli-options|strkey|ledger-keys|instance-entry|wasm-code|wasm-exports|wasm-sections|wasm-compare)`/;
  for (const name of scripts) {
    const bare = name.replace(/\.(mjs|sh)$/, '');
    if (library.test(`\`${bare}\``) && readme.includes(`\`${bare}\``)) continue; // listed as a building block
    assert.ok(table.includes(`scripts/${name}`), `the scripts table has no row for scripts/${name}`);
  }
});

test('every script the README points at exists', () => {
  const mentioned = new Set([...readme.matchAll(/scripts\/([\w-]+\.(?:mjs|sh))/g)].map((match) => match[1]));
  assert.ok(mentioned.size >= 5, [...mentioned].join(', '));
  for (const name of mentioned) assert.ok(files.includes(name), `README.md mentions scripts/${name}, which does not exist`);
});

test('every building block the README lists is a module that exists, and has no command line', () => {
  const sentence = readme.match(/The other modules in `scripts\/` \(([^)]*)\)/)?.[1] ?? '';
  const names = [...sentence.matchAll(/`([\w-]+)`/g)].map((match) => match[1]);
  assert.ok(names.length >= 8, names.join(', '));
  for (const name of names) {
    assert.ok(files.includes(`${name}.mjs`), `${name}.mjs does not exist`);
    assert.doesNotMatch(readFileSync(new URL(`./${name}.mjs`, import.meta.url), 'utf8'), /^#!/, `${name}.mjs has a shebang, so it is a command, not a building block`);
  }
});
