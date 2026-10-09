import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { test } from 'node:test';
import { codeKeyXdr, daysFor, judge, parseArgs } from './check-lifetimes.mjs';

const HASH = 'a7a82511fa284650178b02fe3a4bafc587b95212f2f8ce647f2df5ef4cf42509';

test('the code key is key type 7 followed by the hash', () => {
  const bytes = Buffer.from(codeKeyXdr(HASH), 'base64');
  assert.equal(bytes.length, 36);
  assert.deepEqual([...bytes.subarray(0, 4)], [0, 0, 0, 7]);
  assert.equal(bytes.subarray(4).toString('hex'), HASH);
});

test('a hash that is not 64 lowercase hex characters is refused', () => {
  assert.throws(() => codeKeyXdr('abc'), /64-character/);
  assert.throws(() => codeKeyXdr(HASH.toUpperCase()), /64-character/);
});

test('ledgers become whole days at five seconds each', () => {
  assert.equal(daysFor(17_280), 1);
  assert.equal(daysFor(17_279), 0);
  assert.equal(daysFor(500_000), 28);
});

test('a build with plenty of life left is fine', () => {
  const verdict = judge('v2', HASH, { latestLedger: 100, entries: [{ liveUntilLedgerSeq: 100 + 500_000 }] }, 3);
  assert.equal(verdict.ok, true);
  assert.match(verdict.text, /v2 a7a82511\.\.\.  Wasm code lives about 28 more days$/);
});

test('the minimum is exact: equal passes, one ledger fewer fails', () => {
  const minimum = 3 * 17_280;
  assert.equal(judge('v', HASH, { latestLedger: 0, entries: [{ liveUntilLedgerSeq: minimum }] }, 3).ok, true);
  const short = judge('v', HASH, { latestLedger: 0, entries: [{ liveUntilLedgerSeq: minimum - 1 }] }, 3);
  assert.equal(short.ok, false);
  assert.match(short.text, /under the 3-day minimum/);
});

test('an expired, missing or undated code entry is never fine', () => {
  assert.equal(judge('v', HASH, { latestLedger: 100, entries: [{ liveUntilLedgerSeq: 99 }] }, 0).ok, false);
  assert.match(judge('v', HASH, { latestLedger: 100, entries: [] }, 0).text, /not found/);
  assert.equal(judge('v', HASH, { latestLedger: 100 }, 0).ok, false);
  assert.match(judge('v', HASH, { latestLedger: 100, entries: [{}] }, 0).text, /did not say/);
  assert.equal(judge('v', HASH, undefined, 0).ok, false);
});

test('a code entry live until exactly the latest ledger has not expired yet', () => {
  assert.equal(judge('v', HASH, { latestLedger: 100, entries: [{ liveUntilLedgerSeq: 100 }] }, 0).ok, true);
});

test('the verdict carries the ledgers left when they are known', () => {
  assert.equal(judge('v', HASH, { latestLedger: 100, entries: [{ liveUntilLedgerSeq: 350 }] }, 0).ledgersLeft, 250);
  assert.equal(judge('v', HASH, { latestLedger: 100, entries: [{ liveUntilLedgerSeq: 90 }] }, 0).ledgersLeft, -10);
  assert.equal(judge('v', HASH, { latestLedger: 100, entries: [] }, 0).ledgersLeft, undefined);
});

test('--json with a bad option still fails with exit code 2 and no JSON on stdout', () => {
  const run = spawnSync(process.execPath, ['scripts/check-lifetimes.mjs', '--json', '--bogus'], { encoding: 'utf8' });
  assert.equal(run.status, 2);
  assert.equal(run.stdout, '');
  assert.match(run.stderr, /unknown option --bogus/);
});

test('--json prints one report and the exit code agrees with it, against a local RPC', async () => {
  const { createServer } = await import('node:http');
  const { mkdtempSync, writeFileSync, rmSync } = await import('node:fs');
  const { tmpdir } = await import('node:os');
  const { join } = await import('node:path');
  const live = HASH;
  const gone = 'ec040ead4e157695a16a9723a5d95a44268f1b8da4c5f6aee7bf4f218dbdc875';
  const server = createServer((req, res) => {
    let body = '';
    req.on('data', (chunk) => (body += chunk));
    req.on('end', () => {
      const key = JSON.parse(body).params.keys[0];
      const hash = Buffer.from(key, 'base64').subarray(4).toString('hex');
      const entries = hash === live ? [{ liveUntilLedgerSeq: 1_000 + 17_280 * 10 }] : [];
      res.setHeader('content-type', 'application/json');
      res.end(JSON.stringify({ jsonrpc: '2.0', id: 1, result: { entries, latestLedger: 1_000 } }));
    });
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const dir = mkdtempSync(join(tmpdir(), 'lifetimes-'));
  try {
    const file = join(dir, 'config.json');
    const config = (hashes) => ({
      network: { rpcUrl: `http://127.0.0.1:${server.address().port}` },
      contracts: { vault: { supported: hashes.map((wasmHash, i) => ({ wasmHash, label: `v${i + 1}` })) } },
    });
    const run = (args) =>
      new Promise((resolve) => {
        import('node:child_process').then(({ execFile }) =>
          execFile(process.execPath, ['scripts/check-lifetimes.mjs', '--config', file, '--json', ...args], (error, stdout) =>
            resolve({ status: error ? error.code : 0, stdout }),
          ),
        );
      });

    writeFileSync(file, JSON.stringify(config([live])));
    const good = await run(['--min-days', '3']);
    assert.equal(good.status, 0);
    const goodReport = JSON.parse(good.stdout);
    assert.equal(goodReport.ok, true);
    assert.equal(goodReport.minDays, 3);
    assert.deepEqual(goodReport.builds.map((b) => [b.label, b.ok, b.daysLeft]), [['v1', true, 10]]);

    writeFileSync(file, JSON.stringify(config([live, gone])));
    const bad = await run([]);
    assert.equal(bad.status, 1);
    const badReport = JSON.parse(bad.stdout);
    assert.equal(badReport.ok, false);
    assert.deepEqual(badReport.builds.map((b) => [b.label, b.ok]), [['v1', true], ['v2', false]]);
    assert.equal(badReport.builds[1].daysLeft, undefined);
  } finally {
    server.closeAllConnections();
    await new Promise((resolve) => server.close(resolve));
    rmSync(dir, { recursive: true, force: true });
  }
});

test('parseArgs applies the defaults', () => {
  assert.deepEqual(parseArgs([]), { config: 'fixture.wasmward.json', minDays: 3, json: false });
});

test('parseArgs reads each option', () => {
  assert.deepEqual(parseArgs(['--config', 'x.json', '--min-days', '0.5', '--json']), {
    config: 'x.json',
    minDays: 0.5,
    json: true,
  });
});

test('parseArgs says which option has no value, instead of guessing', () => {
  assert.throws(() => parseArgs(['--config']), /--config needs a value/);
  assert.throws(() => parseArgs(['--min-days']), /--min-days needs a value/);
  // The next word is another option, not a value.
  assert.throws(() => parseArgs(['--config', '--json']), /--config needs a value/);
});

test('parseArgs refuses a minimum that is not a number of days', () => {
  for (const bad of ['abc', '-1', 'Infinity', '']) {
    assert.throws(() => parseArgs(['--min-days', bad]), /--min-days/, bad);
  }
  assert.equal(parseArgs(['--min-days', '0']).minDays, 0);
});
