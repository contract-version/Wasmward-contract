import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { createServer } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { judgeLive, parseArgs } from './live-build.mjs';

const V1 = 'a7a82511fa284650178b02fe3a4bafc587b95212f2f8ce647f2df5ef4cf42509';
const V2 = 'ec040ead4e157695a16a9723a5d95a44268f1b8da4c5f6aee7bf4f218dbdc875';
const ID = 'CBR5ZFDI2GBXG66DAEWWHSAK4NDLKSKHWVUEUSOM4UOBM66TI6DYPDPV';
const SUPPORTED = [
  { wasmHash: V1, label: 'v1' },
  { wasmHash: V2, label: 'v2' },
];

const u32 = (...values) => Buffer.from(values.flatMap((value) => [(value >>> 24) & 255, (value >>> 16) & 255, (value >>> 8) & 255, value & 255]));
/** An instance entry that runs the given hash (a hex string), or a Stellar Asset Contract when it is undefined. */
function instanceXdr(hash) {
  const head = Buffer.concat([u32(6, 0, 1), Buffer.alloc(32, 3), u32(20, 1, 19, hash === undefined ? 1 : 0)]);
  return (hash === undefined ? head : Buffer.concat([head, Buffer.from(hash, 'hex')])).toString('base64');
}
const answer = (hash) => ({ latestLedger: 10, entries: [{ xdr: instanceXdr(hash), liveUntilLedgerSeq: 99 }] });

test('a contract on a listed build is fine and the build is named', () => {
  const verdict = judgeLive('fixture', ID, answer(V1), SUPPORTED);
  assert.equal(verdict.ok, true);
  assert.equal(verdict.live, 'supported');
  assert.equal(verdict.label, 'v1');
  assert.match(verdict.message, /^fixture CBR5ZFDI\.\.\.  runs v1 \(a7a82511\.\.\.\)$/);
});

test('the other listed build is fine too, unless it is not the one expected', () => {
  assert.equal(judgeLive('f', ID, answer(V2), SUPPORTED).ok, true);
  const wrong = judgeLive('f', ID, answer(V2), SUPPORTED, 'v1');
  assert.equal(wrong.ok, false);
  assert.equal(wrong.live, 'supported');
  assert.match(wrong.message, /runs v2 \(ec040ead\.\.\.\), expected v1/);
  assert.equal(judgeLive('f', ID, answer(V1), SUPPORTED, 'v1').ok, true);
});

test('a build that is not on the list is never fine, even with nothing expected', () => {
  const other = 'ab'.repeat(32);
  const verdict = judgeLive('f', ID, answer(other), SUPPORTED);
  assert.equal(verdict.ok, false);
  assert.equal(verdict.live, 'unknown');
  assert.equal(verdict.wasmHash, other);
  assert.match(verdict.message, /not on the supported list/);
});

test('a hash written in capitals in the config still matches', () => {
  assert.equal(judgeLive('f', ID, answer(V1), [{ wasmHash: V1.toUpperCase(), label: 'v1' }]).ok, true);
});

test('a listed build with no label is called unlabelled', () => {
  const verdict = judgeLive('f', ID, answer(V1), [{ wasmHash: V1 }]);
  assert.equal(verdict.label, 'unlabelled');
  assert.equal(verdict.ok, true);
});

test('a missing instance and a Stellar Asset Contract are both reported, not guessed at', () => {
  const missing = judgeLive('f', ID, { latestLedger: 10, entries: [] }, SUPPORTED);
  assert.deepEqual([missing.ok, missing.live], [false, 'missing']);
  const asset = judgeLive('f', ID, answer(undefined), SUPPORTED);
  assert.deepEqual([asset.ok, asset.live], [false, 'stellar-asset']);
  assert.equal(judgeLive('f', ID, {}, SUPPORTED).live, 'missing');
});

test('an answer that is not an instance entry throws, so the run ends with exit 2', () => {
  assert.throws(() => judgeLive('f', ID, { entries: [{ xdr: Buffer.alloc(8).toString('base64') }] }, SUPPORTED), /not a contract instance|ends early/);
});

test('the options are read and refused like the other scripts', () => {
  assert.deepEqual(parseArgs([]), { config: 'fixture.wasmward.json', json: false, timeoutMs: 15_000 });
  const options = parseArgs(['--expect', 'v1', '--json', '--config', 'x.json', '--timeout-ms', '500', '--rpc-url', 'https://rpc.example.org']);
  assert.deepEqual(options, { config: 'x.json', json: true, timeoutMs: 500, expect: 'v1', rpcUrl: 'https://rpc.example.org' });
  assert.throws(() => parseArgs(['--expect']), /--expect needs a value/);
  assert.throws(() => parseArgs(['--expect', '--json']), /--expect needs a value/);
  assert.throws(() => parseArgs(['--nope']), /unknown option --nope/);
  assert.throws(() => parseArgs(['--rpc-url', 'file:///x']), /https:\/\/ or http:\/\//);
});

/** Runs the script against a local RPC that always answers with `body`, and a config pointing at it. */
async function runScript(body, { args = [], contracts } = {}) {
  const server = createServer((req, res) => {
    req.resume();
    req.on('end', () => {
      res.setHeader('content-type', 'application/json');
      res.end(JSON.stringify({ jsonrpc: '2.0', id: 1, result: body }));
    });
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const dir = mkdtempSync(join(tmpdir(), 'live-build-'));
  try {
    const file = join(dir, 'config.json');
    const config = { network: { rpcUrl: `http://127.0.0.1:${server.address().port}` }, contracts: contracts ?? { fixture: { contractId: ID, supported: SUPPORTED } } };
    writeFileSync(file, JSON.stringify(config));
    return await new Promise((resolve) =>
      execFile(process.execPath, ['scripts/live-build.mjs', '--config', file, ...args], (error, stdout, stderr) =>
        resolve({ status: error ? error.code : 0, stdout, stderr }),
      ),
    );
  } finally {
    server.closeAllConnections();
    await new Promise((resolve) => server.close(resolve));
    rmSync(dir, { recursive: true, force: true });
  }
}

test('run for real: exit 0 and a line naming the build when the fixture is on v1', async () => {
  const out = await runScript(answer(V1), { args: ['--expect', 'v1'] });
  assert.equal(out.status, 0);
  assert.match(out.stdout, /fixture CBR5ZFDI\.\.\.  runs v1/);
});

test('run for real: exit 1 when the fixture is left on v2 and v1 is expected', async () => {
  const out = await runScript(answer(V2), { args: ['--expect', 'v1'] });
  assert.equal(out.status, 1);
  assert.match(out.stdout, /runs v2 .*expected v1/);
});

test('run for real: --json carries the same verdict', async () => {
  const out = await runScript(answer(V2), { args: ['--json', '--expect', 'v1'] });
  assert.equal(out.status, 1);
  const report = JSON.parse(out.stdout);
  assert.equal(report.ok, false);
  assert.deepEqual(report.contracts.map((entry) => [entry.name, entry.live, entry.label]), [['fixture', 'supported', 'v2']]);
});

test('run for real: exit 2 for a label that is not in the config, before asking the network', async () => {
  const out = await runScript(answer(V1), { args: ['--expect', 'v9'] });
  assert.equal(out.status, 2);
  assert.match(out.stderr, /--expect v9 is not a label in the config \(v1, v2\)/);
});

test('run for real: exit 2 when the RPC answers something that is not an instance', async () => {
  const out = await runScript({ latestLedger: 1, entries: [{ xdr: 'AAAA' }] });
  assert.equal(out.status, 2);
  assert.match(out.stderr, /^error: /);
});

test('run for real: exit 2 for a config with no contract address', async () => {
  const out = await runScript(answer(V1), { contracts: { fixture: { supported: SUPPORTED } } });
  assert.equal(out.status, 2);
  assert.match(out.stderr, /no contract with a contractId/);
});

test('run for real: exit 2 for a config file that does not exist', async () => {
  const out = await new Promise((resolve) =>
    execFile(process.execPath, ['scripts/live-build.mjs', '--config', join(tmpdir(), 'no-such-live-build.json')], (error, stdout, stderr) =>
      resolve({ status: error ? error.code : 0, stderr }),
    ),
  );
  assert.equal(out.status, 2);
  assert.match(out.stderr, /^error: /);
});
