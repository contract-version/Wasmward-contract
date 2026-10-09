import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { chmodSync, copyFileSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { delimiter, join } from 'node:path';
import { test } from 'node:test';

// extend.sh normally talks to Stellar testnet through the Stellar CLI and spends the fixture owner's money.
// These tests run it in a throwaway copy of the repository with a stand-in `stellar` that only writes down
// how it was called, so what the script asks for can be checked without a network or an account.

const CONTRACT = 'CBR5ZFDI2GBXG66DAEWWHSAK4NDLKSKHWVUEUSOM4UOBM66TI6DYPDPV';
const V1 = 'a7a82511fa284650178b02fe3a4bafc587b95212f2f8ce647f2df5ef4cf42509';
const V2 = 'ec040ead4e157695a16a9723a5d95a44268f1b8da4c5f6aee7bf4f218dbdc875';

const STUB = `#!/usr/bin/env bash
printf '%s\\n' "$*" >> "$STELLAR_CALLS"
if [ "$1 $2" = "keys address" ] && [ -n "\${STUB_NO_IDENTITY:-}" ]; then exit 1; fi
if [ "$1 $2" = "keys address" ]; then echo GADMIN; fi
exit "\${STUB_EXIT:-0}"
`;

/** A copy of the repository with a stub `stellar`, and a function that runs extend.sh in it. */
function sandbox({ withTestnetJson = true } = {}) {
  const dir = mkdtempSync(join(tmpdir(), 'extend-'));
  mkdirSync(join(dir, 'scripts'));
  copyFileSync(new URL('./extend.sh', import.meta.url), join(dir, 'scripts', 'extend.sh'));
  if (withTestnetJson) {
    writeFileSync(join(dir, 'testnet.json'), JSON.stringify({ contractId: CONTRACT, v1: { wasmHash: V1 }, v2: { wasmHash: V2 } }));
  }
  const bin = join(dir, 'bin');
  mkdirSync(bin);
  writeFileSync(join(bin, 'stellar'), STUB);
  chmodSync(join(bin, 'stellar'), 0o755);
  const calls = join(dir, 'calls.log');
  writeFileSync(calls, '');

  return {
    calls: () => readFileSync(calls, 'utf8').split('\n').filter(Boolean),
    run: (args = [], env = {}) =>
      new Promise((resolve) => {
        execFile(
          'bash',
          ['scripts/extend.sh', ...args],
          { cwd: dir, env: { ...process.env, ...env, PATH: `${bin}${delimiter}${process.env.PATH}`, STELLAR_CALLS: calls } },
          (error, stdout, stderr) => resolve({ status: error ? error.code : 0, stdout, stderr }),
        );
      }),
    cleanup: () => rmSync(dir, { recursive: true, force: true }),
  };
}

test('extends the instance and the code of both builds, by 500000 ledgers unless told otherwise', async () => {
  const box = sandbox();
  try {
    const run = await box.run();
    assert.equal(run.status, 0, run.stderr);
    const extend = box.calls().filter((call) => call.startsWith('contract extend'));
    assert.equal(extend.length, 3);
    assert.match(extend[0], new RegExp(`--id ${CONTRACT} --durability persistent --ledgers-to-extend 500000 `));
    assert.match(extend[1], new RegExp(`--wasm-hash ${V1} --ledgers-to-extend 500000 `));
    assert.match(extend[2], new RegExp(`--wasm-hash ${V2} --ledgers-to-extend 500000 `));
    for (const call of extend) assert.match(call, /--source-account wasmward-fixture --network testnet /);
  } finally {
    box.cleanup();
  }
});

test('takes the number of ledgers from the first argument', async () => {
  const box = sandbox();
  try {
    assert.equal((await box.run(['12345'])).status, 0);
    for (const call of box.calls().filter((line) => line.startsWith('contract extend'))) assert.match(call, /--ledgers-to-extend 12345 /);
  } finally {
    box.cleanup();
  }
});

test('stops before touching the network when testnet.json is missing', async () => {
  const box = sandbox({ withTestnetJson: false });
  try {
    const run = await box.run();
    assert.equal(run.status, 1);
    assert.match(run.stderr, /testnet\.json not found/);
    assert.deepEqual(box.calls().filter((line) => line.startsWith('contract extend')), []);
  } finally {
    box.cleanup();
  }
});

test('stops when the identity deploy.sh creates is not there', async () => {
  const box = sandbox();
  try {
    const run = await box.run([], { STUB_NO_IDENTITY: '1' });
    assert.equal(run.status, 1);
    assert.match(run.stderr, /identity wasmward-fixture not found/);
    assert.deepEqual(box.calls().filter((line) => line.startsWith('contract extend')), []);
  } finally {
    box.cleanup();
  }
});

test('fails when the Stellar CLI fails, instead of reporting success', async () => {
  const box = sandbox();
  try {
    const run = await box.run([], { STUB_EXIT: '1' });
    assert.notEqual(run.status, 0);
  } finally {
    box.cleanup();
  }
});

test('refuses a number of ledgers that is not a positive whole number, before calling anything', async () => {
  for (const bad of ['abc', '0', '-5', '1.5', '', '007', '1e5', '12 34']) {
    const box = sandbox();
    try {
      const run = await box.run([bad]);
      assert.equal(run.status, 1, `'${bad}' was accepted`);
      assert.match(run.stderr, /whole number greater than 0/, bad);
      assert.deepEqual(box.calls(), [], `'${bad}' reached the CLI`);
    } finally {
      box.cleanup();
    }
  }
});

test('--help prints the usage and exits 0 without calling anything', async () => {
  for (const flag of ['--help', '-h']) {
    const box = sandbox({ withTestnetJson: false });
    try {
      const run = await box.run([flag]);
      assert.equal(run.status, 0);
      assert.match(run.stderr, /Usage: bash scripts\/extend\.sh \[--dry-run\] \[ledgers\]/);
      assert.deepEqual(box.calls(), []);
    } finally {
      box.cleanup();
    }
  }
});

test('an unknown option is refused, with the usage', async () => {
  const box = sandbox();
  try {
    const run = await box.run(['--forever']);
    assert.equal(run.status, 1);
    assert.match(run.stderr, /unknown option --forever/);
    assert.match(run.stderr, /Usage:/);
    assert.deepEqual(box.calls(), []);
  } finally {
    box.cleanup();
  }
});

test('more than one number of ledgers is refused rather than one of them being picked', async () => {
  const box = sandbox();
  try {
    const run = await box.run(['100', '200']);
    assert.equal(run.status, 1);
    assert.match(run.stderr, /expected one number of ledgers/);
    assert.deepEqual(box.calls(), []);
  } finally {
    box.cleanup();
  }
});

test('--dry-run prints the three commands and runs none of them', async () => {
  const box = sandbox();
  try {
    const run = await box.run(['--dry-run', '777']);
    assert.equal(run.status, 0, run.stderr);
    assert.deepEqual(box.calls(), [], 'the stand-in Stellar CLI was called');
    const lines = run.stdout.trim().split('\n');
    assert.equal(lines.length, 3);
    assert.match(lines[0], new RegExp(`^would run: stellar contract extend --id ${CONTRACT} --durability persistent --ledgers-to-extend 777 `));
    assert.match(lines[1], new RegExp(`--wasm-hash ${V1} --ledgers-to-extend 777 `));
    assert.match(lines[2], new RegExp(`--wasm-hash ${V2} --ledgers-to-extend 777 `));
    assert.match(run.stderr, /Dry run: nothing was extended/);
    assert.doesNotMatch(run.stderr, /Done\./);
  } finally {
    box.cleanup();
  }
});

test('--dry-run works in any order and needs neither the Stellar CLI nor the identity', async () => {
  const box = sandbox();
  try {
    const run = await box.run(['888', '--dry-run'], { STUB_NO_IDENTITY: '1', STUB_EXIT: '1' });
    assert.equal(run.status, 0, run.stderr);
    assert.match(run.stdout, /--ledgers-to-extend 888 /);
  } finally {
    box.cleanup();
  }
});

test('--dry-run still checks the ledger count and still needs testnet.json', async () => {
  const bad = sandbox();
  try {
    const run = await bad.run(['--dry-run', '0']);
    assert.equal(run.status, 1);
    assert.equal(run.stdout, '');
  } finally {
    bad.cleanup();
  }
  const noJson = sandbox({ withTestnetJson: false });
  try {
    const run = await noJson.run(['--dry-run']);
    assert.equal(run.status, 1);
    assert.match(run.stderr, /testnet\.json not found/);
  } finally {
    noJson.cleanup();
  }
});
