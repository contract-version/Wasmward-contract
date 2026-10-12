import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { readdirSync, readFileSync } from 'node:fs';
import { test } from 'node:test';

// Every command line script answers --help with its own description, and says what its exit codes are. A script that
// is added without it (or one whose header stops saying how it exits) fails here.

const scriptsDir = new URL('./', import.meta.url);
/** The Node scripts that are commands: the ones that start with a shebang. */
const commands = readdirSync(scriptsDir)
  .filter((name) => name.endsWith('.mjs') && !name.endsWith('.test.mjs'))
  .filter((name) => readFileSync(new URL(name, scriptsDir), 'utf8').startsWith('#!'));

const run = (script, args) =>
  new Promise((resolve) => execFile(process.execPath, [`scripts/${script}`, ...args], (error, stdout, stderr) => resolve({ status: error ? error.code : 0, stdout, stderr })));

test('there are command line scripts to check', () => {
  assert.ok(commands.length >= 8, commands.join(', '));
  for (const name of ['check-lifetimes.mjs', 'live-build.mjs', 'fixture-status.mjs', 'sync-config.mjs', 'wasm-info.mjs', 'check-builds.mjs', 'doctor.mjs', 'wasm-paths.mjs']) {
    assert.ok(commands.includes(name), `${name} is not seen as a command`);
  }
});

for (const name of commands) {
  test(`${name} --help prints its description and how it exits, and exits 0`, async () => {
    const result = await run(name, ['--help']);
    assert.equal(result.status, 0, result.stderr);
    assert.equal(result.stderr, '');
    assert.match(result.stdout, new RegExp(`node scripts/${name.replace('.', '\\.')}`), 'the help does not show how to run it');
    assert.match(result.stdout, /Exit codes?:?/i, 'the help does not say what the exit codes are');
    assert.ok(result.stdout.split('\n').length >= 6, 'the help is too short to describe it');
  });

  test(`${name} -h is the same as --help`, async () => {
    const [short, long] = await Promise.all([run(name, ['-h']), run(name, ['--help'])]);
    assert.equal(short.stdout, long.stdout);
    assert.equal(short.status, 0);
  });

  test(`${name} still refuses an option it does not know, with exit 2`, async () => {
    const result = await run(name, ['--no-such-option-at-all']);
    assert.equal(result.status, 2, `${result.stdout}${result.stderr}`);
  });
}
