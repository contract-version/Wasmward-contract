import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { createServer } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { buildRecording, parseArgs } from './record-testnet.mjs';
import { codeKeyXdr, instanceKeyXdr } from './ledger-keys.mjs';

const ID = 'CD23JAK5WMRFWGOYUCU25JNWAPWWHI6Y2YCK5XANP4MK3JHIOAHEHCHN';
const V1 = 'a7a82511fa284650178b02fe3a4bafc587b95212f2f8ce647f2df5ef4cf42509';
const V2 = 'ec040ead4e157695a16a9723a5d95a44268f1b8da4c5f6aee7bf4f218dbdc875';
const pinned = { contractId: ID, v1Hash: V1 };
const NETWORK = { friendbotUrl: 'https://friendbot.example/', passphrase: 'Test SDF Network ; September 2015', protocolVersion: 29 };

const u32 = (...values) => Buffer.from(values.flatMap((value) => [(value >>> 24) & 255, (value >>> 16) & 255, (value >>> 8) & 255, value & 255]));
const instanceXdr = (hash) => Buffer.concat([u32(6, 0, 1), Buffer.alloc(32, 3), u32(20, 1, 19, 0), Buffer.from(hash, 'hex')]).toString('base64');
const instanceResult = (hash = V1, until = 1_000) => ({ latestLedger: 500, entries: [{ key: 'k', xdr: instanceXdr(hash), lastModifiedLedgerSeq: 1, liveUntilLedgerSeq: until }] });
const codeResult = (until = 1_000) => ({ latestLedger: 500, entries: [{ key: 'c', xdr: 'AAAA', liveUntilLedgerSeq: until }] });
const asks = (over = {}) => ({ instance: async () => instanceResult(), network: async () => NETWORK, code: async () => codeResult(), ...over });
const clock = () => {
  const times = ['2026-11-08T10:00:00.000Z', '2026-11-08T10:00:01.000Z'];
  return () => times.shift() ?? '2026-11-08T10:00:09.000Z';
};

test('records the three answers in the shape the replay tests read, with the times they were taken', async () => {
  const recording = await buildRecording(pinned, asks(), clock());
  assert.deepEqual(Object.keys(recording), ['recordedAt', 'contractId', 'expectedWasmHash', 'getLedgerEntries', 'getNetwork', 'getCodeEntries', 'codeRecordedAt']);
  assert.equal(recording.contractId, ID);
  assert.equal(recording.expectedWasmHash, V1);
  assert.equal(recording.recordedAt, '2026-11-08T10:00:00.000Z');
  assert.equal(recording.codeRecordedAt, '2026-11-08T10:00:01.000Z');
  assert.deepEqual(recording.getNetwork, { jsonrpc: '2.0', id: 1, result: NETWORK });
  assert.equal(recording.getLedgerEntries.jsonrpc, '2.0');
  assert.equal(recording.getLedgerEntries.result.entries[0].liveUntilLedgerSeq, 1_000);
  assert.equal(recording.getCodeEntries.result.entries.length, 1);
});

test('the answers are recorded as the RPC gave them, not rebuilt', async () => {
  const instance = instanceResult();
  const recording = await buildRecording(pinned, asks({ instance: async () => instance }), clock());
  assert.deepEqual(recording.getLedgerEntries.result, instance);
});

test('nothing is recorded from a fixture that is gone, expired or on another build, and the reason is named', async () => {
  const refuses = (over, message) => assert.rejects(buildRecording(pinned, asks(over), clock()), message);
  await refuses({ instance: async () => ({ latestLedger: 500, entries: [] }) }, /instance entry was not found/);
  await refuses({ instance: async () => instanceResult(V1, 499) }, /the instance has expired/);
  await refuses({ instance: async () => instanceResult(V2) }, new RegExp(`runs ${V2}, not v1`));
  await refuses({ code: async () => ({ latestLedger: 500, entries: [] }) }, /Wasm code entry was not found/);
  await refuses({ code: async () => codeResult(499) }, /Wasm code has expired/);
});

test('an entry that lives until exactly the latest ledger has not expired', async () => {
  await buildRecording(pinned, asks({ instance: async () => instanceResult(V1, 500), code: async () => codeResult(500) }), clock());
});

test('an answer that is not an instance is an error from the parser, not a recording', async () => {
  await assert.rejects(buildRecording(pinned, asks({ instance: async () => ({ latestLedger: 1, entries: [{ xdr: 'AAAA', liveUntilLedgerSeq: 9 }] }) }), clock()), /not a contract instance|ends early/);
});

test('the options are read, the output defaults to the backend fixture, and unknown ones are refused', () => {
  assert.deepEqual(parseArgs([]), { config: 'fixture.wasmward.json', out: '../Wasmward-backend/test/fixtures/recorded/testnet-v1.json', timeoutMs: 15_000 });
  assert.deepEqual(parseArgs(['--out', 'x.json', '--timeout-ms', '500', '--rpc-url', 'https://rpc.example.org', '--config', 'c.json']), { config: 'c.json', out: 'x.json', timeoutMs: 500, rpcUrl: 'https://rpc.example.org' });
  assert.throws(() => parseArgs(['--out']), /--out needs a value/);
  assert.throws(() => parseArgs(['--nope']), /unknown option --nope/);
});

/** Runs the script for real against a local RPC whose state is chosen by the test. */
async function run(state = {}, args = []) {
  const { live = V1, until = 100_000, missingCode = false, network = NETWORK } = state;
  const server = createServer((req, res) => {
    let body = '';
    req.on('data', (chunk) => (body += chunk));
    req.on('end', () => {
      const request = JSON.parse(body);
      let result;
      if (request.method === 'getNetwork') result = network;
      else if (request.params.keys[0] === instanceKeyXdr(ID)) result = instanceResult(live, until);
      else if (request.params.keys[0] === codeKeyXdr(V1)) result = missingCode ? { latestLedger: 500, entries: [] } : codeResult(until);
      res.setHeader('content-type', 'application/json');
      res.end(JSON.stringify({ jsonrpc: '2.0', id: 1, result }));
    });
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const dir = mkdtempSync(join(tmpdir(), 'record-'));
  try {
    const config = join(dir, 'config.json');
    const out = join(dir, 'recording.json');
    writeFileSync(config, JSON.stringify({ version: 1, network: { rpcUrl: `http://127.0.0.1:${server.address().port}`, passphrase: 'x' }, contracts: { fixture: { contractId: ID, supported: [{ wasmHash: V1, label: 'v1' }, { wasmHash: V2, label: 'v2' }] } } }));
    const result = await new Promise((resolve) =>
      execFile(process.execPath, [join(process.cwd(), 'scripts/record-testnet.mjs'), '--config', config, '--out', out, ...args], (error, stdout, stderr) => resolve({ status: error ? error.code : 0, stdout, stderr })),
    );
    return { ...result, written: existsSync(out) ? JSON.parse(readFileSync(out, 'utf8')) : null, raw: existsSync(out) ? readFileSync(out, 'utf8') : null };
  } finally {
    server.closeAllConnections();
    await new Promise((resolve) => server.close(resolve));
    rmSync(dir, { recursive: true, force: true });
  }
}

test('run for real: records a healthy v1 to the file, as two-space JSON with a final newline', async () => {
  const out = await run();
  assert.equal(out.status, 0, out.stderr);
  assert.match(out.stdout, /^Recorded CD23JAK5\.\.\. \(v1 a7a82511\.\.\.\) to /);
  assert.equal(out.written.contractId, ID);
  assert.deepEqual(out.written.getNetwork.result, NETWORK);
  assert.ok(out.raw.endsWith('}\n') && out.raw.includes('\n  "contractId"'));
});

test('run for real: exit 1 and no file for a fixture on v2, an expired one, or one without its code', async () => {
  for (const [state, message] of [
    [{ live: V2 }, /not v1/],
    [{ until: 10 }, /has expired/],
    [{ missingCode: true }, /Wasm code entry was not found/],
  ]) {
    const out = await run(state);
    assert.equal(out.status, 1, out.stderr);
    assert.match(out.stderr, message);
    assert.equal(out.written, null, 'a recording was written from a broken fixture');
  }
});

test('run for real: exit 2 when the RPC cannot be reached, with no file', async () => {
  const out = await run({}, ['--rpc-url', 'http://127.0.0.1:9', '--timeout-ms', '500']);
  assert.equal(out.status, 2);
  assert.match(out.stderr, /could not reach the RPC/);
  assert.equal(out.written, null);
});

test('run for real: exit 2 for an unknown option', async () => {
  const out = await run({}, ['--nope']);
  assert.equal(out.status, 2);
  assert.match(out.stderr, /unknown option --nope/);
});
