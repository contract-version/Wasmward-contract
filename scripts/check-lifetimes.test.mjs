import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { test } from 'node:test';
import { codeKeyXdr, daysFor, judge, parseArgs, rpcLookup } from './check-lifetimes.mjs';

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
  assert.deepEqual(parseArgs([]), { config: 'fixture.wasmward.json', minDays: 3, json: false, timeoutMs: 15_000 });
});

test('parseArgs reads each option', () => {
  assert.deepEqual(parseArgs(['--config', 'x.json', '--min-days', '0.5', '--json']), {
    config: 'x.json',
    minDays: 0.5,
    json: true,
    timeoutMs: 15_000,
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

test('parseArgs accepts an RPC URL and refuses things that are not one', () => {
  assert.equal(parseArgs(['--rpc-url', 'https://rpc.example.org/x']).rpcUrl, 'https://rpc.example.org/x');
  assert.equal(parseArgs([]).rpcUrl, undefined);
  assert.throws(() => parseArgs(['--rpc-url', 'not a url']), /not a URL/);
  assert.throws(() => parseArgs(['--rpc-url', 'file:///etc/passwd']), /https:\/\/ or http:\/\//);
  assert.throws(() => parseArgs(['--rpc-url']), /--rpc-url needs a value/);
});

test('--rpc-url overrides the one in the config', async () => {
  const { createServer } = await import('node:http');
  const { mkdtempSync, writeFileSync, rmSync } = await import('node:fs');
  const { tmpdir } = await import('node:os');
  const { join } = await import('node:path');
  const { execFile } = await import('node:child_process');
  const server = createServer((req, res) => {
    req.resume();
    req.on('end', () => {
      res.setHeader('content-type', 'application/json');
      res.end(JSON.stringify({ jsonrpc: '2.0', id: 1, result: { entries: [{ liveUntilLedgerSeq: 1_000 + 17_280 * 9 }], latestLedger: 1_000 } }));
    });
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const dir = mkdtempSync(join(tmpdir(), 'lifetimes-url-'));
  try {
    const file = join(dir, 'config.json');
    // The config points at a port nothing listens on; only the flag can make this succeed.
    writeFileSync(file, JSON.stringify({ network: { rpcUrl: 'http://127.0.0.1:9' }, contracts: { v: { supported: [{ wasmHash: HASH, label: 'v1' }] } } }));
    const url = `http://127.0.0.1:${server.address().port}`;
    const out = await new Promise((resolve) =>
      execFile(process.execPath, ['scripts/check-lifetimes.mjs', '--config', file, '--rpc-url', url, '--json'], (error, stdout) => resolve({ status: error ? error.code : 0, stdout })),
    );
    assert.equal(out.status, 0);
    assert.equal(JSON.parse(out.stdout).builds[0].daysLeft, 9);
  } finally {
    server.closeAllConnections();
    await new Promise((resolve) => server.close(resolve));
    rmSync(dir, { recursive: true, force: true });
  }
});

/** A local RPC that answers each request with the next handler in `script`, and counts requests. */
async function scriptedRpc(script) {
  const { createServer } = await import('node:http');
  const seen = { requests: 0 };
  const server = createServer((req, res) => {
    req.resume();
    req.on('end', () => {
      const step = script[Math.min(seen.requests, script.length - 1)];
      seen.requests += 1;
      step(res);
    });
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  return {
    seen,
    url: `http://127.0.0.1:${server.address().port}`,
    close: async () => {
      server.closeAllConnections();
      await new Promise((resolve) => server.close(resolve));
    },
  };
}

const ok = (res) => {
  res.setHeader('content-type', 'application/json');
  res.end(JSON.stringify({ jsonrpc: '2.0', id: 1, result: { entries: [], latestLedger: 7 } }));
};
const status = (code) => (res) => {
  res.statusCode = code;
  res.end('no');
};
const KEY = codeKeyXdr(HASH);
const FAST = { delayMs: 0 };

test('rpcLookup tries again after a server error and returns the second answer', async () => {
  const rpc = await scriptedRpc([status(503), ok]);
  try {
    assert.deepEqual(await rpcLookup(rpc.url, KEY, FAST), { entries: [], latestLedger: 7 });
    assert.equal(rpc.seen.requests, 2);
  } finally {
    await rpc.close();
  }
});

test('rpcLookup also tries again after 429, but gives up after the retries are used', async () => {
  const rpc = await scriptedRpc([status(429)]);
  try {
    await assert.rejects(rpcLookup(rpc.url, KEY, { ...FAST, retries: 2 }), /HTTP 429/);
    assert.equal(rpc.seen.requests, 3);
  } finally {
    await rpc.close();
  }
});

test('rpcLookup does not retry an answer that asking again cannot fix', async () => {
  for (const step of [status(400), status(404), (res) => res.end(JSON.stringify({ jsonrpc: '2.0', id: 1, error: { code: -32602, message: 'bad key' } }))]) {
    const rpc = await scriptedRpc([step, ok]);
    try {
      await assert.rejects(rpcLookup(rpc.url, KEY, FAST));
      assert.equal(rpc.seen.requests, 1);
    } finally {
      await rpc.close();
    }
  }
});

test('rpcLookup retries when nothing is listening, then says it could not reach the RPC', async () => {
  await assert.rejects(rpcLookup('http://127.0.0.1:9', KEY, { ...FAST, retries: 1 }), /could not reach the RPC/);
});

test('rpcLookup gives up on a server that never answers, and says how long it waited', async () => {
  const rpc = await scriptedRpc([() => undefined]); // takes the request and never replies
  try {
    await assert.rejects(rpcLookup(rpc.url, KEY, { ...FAST, retries: 0, timeoutMs: 150 }), /no answer within 150ms/);
  } finally {
    await rpc.close();
  }
});

test('parseArgs reads --timeout-ms and keeps it within sensible bounds', () => {
  assert.equal(parseArgs(['--timeout-ms', '2500']).timeoutMs, 2500);
  for (const bad of ['99', '120001', '1.5', 'abc', '-5']) {
    assert.throws(() => parseArgs(['--timeout-ms', bad]), /--timeout-ms must be/, bad);
  }
  assert.throws(() => parseArgs(['--timeout-ms']), /--timeout-ms needs a value/);
});

test('--timeout-ms is what the script waits for, end to end', async () => {
  const { execFile } = await import('node:child_process');
  const { mkdtempSync, writeFileSync, rmSync } = await import('node:fs');
  const { tmpdir } = await import('node:os');
  const { join } = await import('node:path');
  const rpc = await scriptedRpc([() => undefined]); // never answers
  const dir = mkdtempSync(join(tmpdir(), 'lifetimes-timeout-'));
  try {
    const file = join(dir, 'config.json');
    writeFileSync(file, JSON.stringify({ network: { rpcUrl: rpc.url }, contracts: { v: { supported: [{ wasmHash: HASH }] } } }));
    const started = Date.now();
    const run = await new Promise((resolve) =>
      execFile(process.execPath, ['scripts/check-lifetimes.mjs', '--config', file, '--timeout-ms', '200'], (error, stdout, stderr) =>
        resolve({ status: error ? error.code : 0, stderr }),
      ),
    );
    assert.equal(run.status, 2);
    assert.match(run.stderr, /no answer within 200ms/);
    // Two tries of 200ms plus the pause between them: nowhere near the 15 seconds of the default.
    assert.ok(Date.now() - started < 5_000);
  } finally {
    await rpc.close();
    rmSync(dir, { recursive: true, force: true });
  }
});

/**
 * Runs the script against a local RPC that answers per kind of key: `instance` and `code` are the number of
 * days left for that kind of entry, or null for no entry at all. Returns { status, stdout, stderr }.
 */
async function runAgainst({ instance, code, args = [], contractId = 'CBR5ZFDI2GBXG66DAEWWHSAK4NDLKSKHWVUEUSOM4UOBM66TI6DYPDPV' }) {
  const { createServer } = await import('node:http');
  const { execFile } = await import('node:child_process');
  const { mkdtempSync, writeFileSync, rmSync } = await import('node:fs');
  const { tmpdir } = await import('node:os');
  const { join } = await import('node:path');
  const entryFor = (days) => (days === null ? [] : [{ liveUntilLedgerSeq: 1_000 + Math.round(days * 17_280) }]);
  const server = createServer((req, res) => {
    let body = '';
    req.on('data', (chunk) => (body += chunk));
    req.on('end', () => {
      const keyType = Buffer.from(JSON.parse(body).params.keys[0], 'base64').readUInt32BE(0);
      const entries = entryFor(keyType === 6 ? instance : code);
      res.setHeader('content-type', 'application/json');
      res.end(JSON.stringify({ jsonrpc: '2.0', id: 1, result: { entries, latestLedger: 1_000 } }));
    });
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const dir = mkdtempSync(join(tmpdir(), 'lifetimes-instance-'));
  try {
    const file = join(dir, 'config.json');
    const vault = { supported: [{ wasmHash: HASH, label: 'v1' }] };
    if (contractId !== null) vault.contractId = contractId;
    writeFileSync(file, JSON.stringify({ network: { rpcUrl: `http://127.0.0.1:${server.address().port}` }, contracts: { vault } }));
    return await new Promise((resolve) =>
      execFile(process.execPath, ['scripts/check-lifetimes.mjs', '--config', file, ...args], (error, stdout, stderr) =>
        resolve({ status: error ? error.code : 0, stdout, stderr }),
      ),
    );
  } finally {
    server.closeAllConnections();
    await new Promise((resolve) => server.close(resolve));
    rmSync(dir, { recursive: true, force: true });
  }
}

test('checks the instance as well as the code, instance first', async () => {
  const run = await runAgainst({ instance: 20, code: 10 });
  assert.equal(run.status, 0);
  assert.deepEqual(run.stdout.trim().split('\n').map((line) => line.replace(/\s+/g, ' ')), [
    'vault CBR5ZFDI... contract instance lives about 20 more days',
    'v1 a7a82511... Wasm code lives about 10 more days',
  ]);
});

test('a live build does not hide an instance that is about to expire', async () => {
  const run = await runAgainst({ instance: 1, code: 20, args: ['--min-days', '3'] });
  assert.equal(run.status, 1);
  assert.match(run.stdout, /contract instance lives about 1 more days: under the 3-day minimum/);
  assert.match(run.stdout, /Wasm code lives about 20 more days\n/);
});

test('a missing instance fails the check even when the code is fine', async () => {
  const run = await runAgainst({ instance: null, code: 20 });
  assert.equal(run.status, 1);
  assert.match(run.stdout, /contract instance not found \(expired and archived, or never deployed\)/);
});

test('contracts without an address are not looked up as instances', async () => {
  // The fake RPC would say "no instance" for any instance key, so a lookup would fail the run.
  const run = await runAgainst({ instance: null, code: 20, contractId: null });
  assert.equal(run.status, 0);
  assert.doesNotMatch(run.stdout, /instance/);
});

test('the JSON report lists contracts and builds separately', async () => {
  const run = await runAgainst({ instance: 7, code: 30, args: ['--json'] });
  const report = JSON.parse(run.stdout);
  assert.deepEqual(report.contracts.map((c) => [c.name, c.ok, c.daysLeft]), [['vault', true, 7]]);
  assert.deepEqual(report.builds.map((b) => [b.label, b.ok, b.daysLeft]), [['v1', true, 30]]);
  assert.equal(report.contracts[0].contractId, 'CBR5ZFDI2GBXG66DAEWWHSAK4NDLKSKHWVUEUSOM4UOBM66TI6DYPDPV');
});

test('a mistyped contract address is a usage error (exit 2), not a lookup of something else', async () => {
  const run = await runAgainst({ instance: 7, code: 30, contractId: 'CBR5ZFDI2GBXG66DAEWWHSAK4NDLKSKHWVUEUSOM4UOBM66TI6DYPDPA' });
  assert.equal(run.status, 2);
  assert.match(run.stderr, /checksum does not match/);
});
