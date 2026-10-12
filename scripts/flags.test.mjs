import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';

// Where the documentation shows a script with an option, the script has to accept that option. A flag that was
// renamed in the script and not in the README sends people to an "unknown option" error.

const markdown = execFileSync('git', ['ls-files', '*.md', '.github/**/*.yml'], { encoding: 'utf8' }).split('\n').filter(Boolean);
const source = (name) => readFileSync(new URL(`./${name}`, import.meta.url), 'utf8');

/** [script, flag] for every `--flag` that follows a script name on the same line (up to the next script name). */
function documentedFlags(text) {
  const found = [];
  for (const line of text.split('\n')) {
    const parts = line.split(/(?=(?:scripts\/)[\w-]+\.(?:mjs|sh))/);
    for (const part of parts) {
      const script = part.match(/^scripts\/([\w-]+\.(?:mjs|sh))/)?.[1];
      if (script === undefined) continue;
      // Only the words after the script name, up to a backtick, a pipe or a redirect that ends the command.
      const rest = part.slice(part.indexOf(script) + script.length).split(/[`|>]|\s#\s/)[0];
      for (const flag of rest.matchAll(/(?<![\w-])(--[a-z][a-z-]*)/g)) found.push([script, flag[1]]);
    }
  }
  return found;
}

test('the reader finds the flags the documentation shows', () => {
  const all = markdown.flatMap((path) => documentedFlags(readFileSync(path, 'utf8')));
  assert.ok(all.length >= 8, JSON.stringify(all));
  assert.ok(all.some(([script, flag]) => script === 'live-build.mjs' && flag === '--expect'));
  assert.ok(all.some(([script, flag]) => script === 'extend.sh' && flag === '--dry-run'));
});

test('every option the documentation shows after a script is one that script accepts', () => {
  for (const path of markdown) {
    for (const [script, flag] of documentedFlags(readFileSync(path, 'utf8'))) {
      assert.ok(source(script).includes(flag), `${path} shows ${script} with ${flag}, which the script does not have`);
    }
  }
});

test('the flag reader itself: a flag after another command on the line is not blamed on the script', () => {
  assert.deepEqual(documentedFlags('node scripts/live-build.mjs --expect v1 | cat --number'), [['live-build.mjs', '--expect']]);
  assert.deepEqual(documentedFlags('`scripts/extend.sh [--dry-run] [ledgers]` | Extends'), [['extend.sh', '--dry-run']]);
  assert.deepEqual(documentedFlags('run scripts/a.mjs --x and then scripts/b.mjs --y'), [['a.mjs', '--x'], ['b.mjs', '--y']]);
});
