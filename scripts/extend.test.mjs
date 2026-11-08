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
if [ -n "\${STUB_FAIL_ON:-}" ] && [ "$1 $2" = "contract $STUB_FAIL_ON" ]; then echo "stub: $2 failed" >&2; exit 1; fi
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
    dir,
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

test('restores each entry before extending it, because an archived entry cannot be extended', async () => {
  const box = sandbox();
  try {
    assert.equal((await box.run()).status, 0);
    const calls = box.calls().filter((call) => /^contract (restore|extend)/.test(call));
    assert.deepEqual(
      calls.map((call) => call.split(' ').slice(0, 3).join(' ')),
      [
        'contract restore --id',
        'contract extend --id',
        'contract restore --wasm-hash',
        'contract extend --wasm-hash',
        'contract restore --wasm-hash',
        'contract extend --wasm-hash',
      ],
    );
    // The restore and the extend for an entry name the same entry and the same number of ledgers.
    assert.equal(calls[0].replace('restore', 'extend'), calls[1]);
    assert.equal(calls[2].replace('restore', 'extend'), calls[3]);
    assert.equal(calls[4].replace('restore', 'extend'), calls[5]);
    assert.match(calls[2], new RegExp(`--wasm-hash ${V1} `));
    assert.match(calls[4], new RegExp(`--wasm-hash ${V2} `));
  } finally {
    box.cleanup();
  }
});

test('an extend that follows a failed restore is not attempted: the failure ends the run', async () => {
  const box = sandbox();
  try {
    const run = await box.run([], { STUB_FAIL_ON: 'restore' });
    assert.notEqual(run.status, 0);
    assert.deepEqual(box.calls().filter((call) => /^contract (restore|extend)/.test(call)).map((call) => call.split(' ')[1]), ['restore']);
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

test('--dry-run prints the six commands (a restore and an extend for each entry) and runs none of them', async () => {
  const box = sandbox();
  try {
    const run = await box.run(['--dry-run', '777']);
    assert.equal(run.status, 0, run.stderr);
    assert.deepEqual(box.calls(), [], 'the stand-in Stellar CLI was called');
    const lines = run.stdout.trim().split('\n');
    assert.equal(lines.length, 6);
    assert.match(lines[0], new RegExp(`^would run: stellar contract restore --id ${CONTRACT} --durability persistent --ledgers-to-extend 777 `));
    assert.match(lines[1], new RegExp(`^would run: stellar contract extend --id ${CONTRACT} --durability persistent --ledgers-to-extend 777 `));
    assert.match(lines[2], new RegExp(`restore --wasm-hash ${V1} --ledgers-to-extend 777 `));
    assert.match(lines[3], new RegExp(`extend --wasm-hash ${V1} --ledgers-to-extend 777 `));
    assert.match(lines[4], new RegExp(`restore --wasm-hash ${V2} --ledgers-to-extend 777 `));
    assert.match(lines[5], new RegExp(`extend --wasm-hash ${V2} --ledgers-to-extend 777 `));
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

test('after a real extend it points at the script in this repository for checking, not at a tool that may not be installed', async () => {
  const box = sandbox();
  try {
    const run = await box.run([]);
    assert.equal(run.status, 0, run.stderr);
    assert.match(run.stderr, /Done\. Check the result with: node scripts\/fixture-status\.mjs --expect v1/);
    assert.doesNotMatch(run.stderr, /wasmward check/);
  } finally {
    box.cleanup();
  }
});

// --- The check that follows a real extend ---------------------------------------------------------------------

const u32 = (...values) => Buffer.from(values.flatMap((value) => [(value >>> 24) & 255, (value >>> 16) & 255, (value >>> 8) & 255, value & 255]));
const instanceXdr = (hash) => Buffer.concat([u32(6, 0, 1), Buffer.alloc(32, 3), u32(20, 1, 19, 0), Buffer.from(hash, 'hex')]).toString('base64');

/**
 * A sandbox that also has the real status scripts, a config, and a local stand-in RPC that says the instance runs `live`
 * with `days` left and that both builds' code has `codeDays` left.
 */
async function sandboxWithStatus({ live = V1, days = 28, codeDays = 28 } = {}) {
  const { createServer } = await import('node:http');
  const { codeKeyXdr, instanceKeyXdr } = await import('./ledger-keys.mjs');
  const { readdirSync } = await import('node:fs');
  const box = sandbox();
  const DAY = 17_280;
  const server = createServer((req, res) => {
    let body = '';
    req.on('data', (chunk) => (body += chunk));
    req.on('end', () => {
      const key = JSON.parse(body).params.keys[0];
      let result = { latestLedger: 100, entries: [] };
      if (key === instanceKeyXdr(CONTRACT)) result = { latestLedger: 100, entries: [{ xdr: instanceXdr(live), liveUntilLedgerSeq: 100 + days * DAY }] };
      else if (key === codeKeyXdr(V1) || key === codeKeyXdr(V2)) result = { latestLedger: 100, entries: [{ liveUntilLedgerSeq: 100 + codeDays * DAY }] };
      res.setHeader('content-type', 'application/json');
      res.end(JSON.stringify({ jsonrpc: '2.0', id: 1, result }));
    });
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const here = new URL('./', import.meta.url);
  for (const name of readdirSync(here).filter((file) => file.endsWith('.mjs') && !file.endsWith('.test.mjs'))) {
    copyFileSync(new URL(name, here), join(box.dir, 'scripts', name));
  }
  writeFileSync(
    join(box.dir, 'fixture.wasmward.json'),
    JSON.stringify({
      version: 1,
      network: { rpcUrl: `http://127.0.0.1:${server.address().port}`, passphrase: 'x' },
      contracts: { fixture: { contractId: CONTRACT, supported: [{ wasmHash: V1, label: 'v1' }, { wasmHash: V2, label: 'v2' }] } },
    }),
  );
  return {
    ...box,
    cleanup: async () => {
      server.closeAllConnections();
      await new Promise((resolve) => server.close(resolve));
      box.cleanup();
    },
  };
}

test('after a real extend it looks at the fixture and says Done only if all is right', async () => {
  const box = await sandboxWithStatus();
  try {
    const run = await box.run();
    assert.equal(run.status, 0, run.stderr);
    assert.match(run.stderr, /Checking the result\.\.\./);
    assert.match(run.stderr, /The fixture is all right\./);
    assert.match(run.stderr, /^Done\.$/m);
  } finally {
    await box.cleanup();
  }
});

test('if the fixture still needs attention after the extend, the script fails and says so', async () => {
  const box = await sandboxWithStatus({ codeDays: 1 });
  try {
    const run = await box.run();
    assert.equal(run.status, 1);
    assert.match(run.stderr, /under the 3-day minimum/);
    assert.match(run.stderr, /error: the transactions went through, but the fixture still needs attention/);
    assert.doesNotMatch(run.stderr, /^Done\.$/m);
  } finally {
    await box.cleanup();
  }
});

test('a fixture left on the wrong build is reported after the extend too', async () => {
  const box = await sandboxWithStatus({ live: V2 });
  try {
    const run = await box.run();
    assert.equal(run.status, 1);
    assert.match(run.stderr, /runs v2 .*expected v1/);
  } finally {
    await box.cleanup();
  }
});

test('a dry run does not look at the network, even where the status script is there', async () => {
  const box = await sandboxWithStatus({ codeDays: 1 });
  try {
    const run = await box.run(['--dry-run']);
    assert.equal(run.status, 0, run.stderr);
    assert.doesNotMatch(run.stderr, /Checking the result/);
  } finally {
    await box.cleanup();
  }
});
