import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { createServer } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { parseArgs, statusOf } from './fixture-status.mjs';
import { codeKeyXdr, instanceKeyXdr } from './ledger-keys.mjs';

const V1 = 'a7a82511fa284650178b02fe3a4bafc587b95212f2f8ce647f2df5ef4cf42509';
const V2 = 'ec040ead4e157695a16a9723a5d95a44268f1b8da4c5f6aee7bf4f218dbdc875';
const ID = 'CBR5ZFDI2GBXG66DAEWWHSAK4NDLKSKHWVUEUSOM4UOBM66TI6DYPDPV';
const DAY = 17_280;

const u32 = (...values) => Buffer.from(values.flatMap((value) => [(value >>> 24) & 255, (value >>> 16) & 255, (value >>> 8) & 255, value & 255]));
const instanceXdr = (hash) => Buffer.concat([u32(6, 0, 1), Buffer.alloc(32, 3), u32(20, 1, 19, 0), Buffer.from(hash, 'hex')]).toString('base64');

const config = () => ({
  network: { rpcUrl: 'http://127.0.0.1:9' },
  contracts: { fixture: { contractId: ID, supported: [{ wasmHash: V1, label: 'v1' }, { wasmHash: V2, label: 'v2' }] } },
});

/** A stand-in RPC: the instance runs `live`, with `days` left; each build's code has `codeDays` left (or is missing). */
function fakeLookup({ live = V1, days = 20, codeDays = { [V1]: 20, [V2]: 20 }, instance = true } = {}) {
  const calls = [];
  const lookup = async (key) => {
    calls.push(key);
    if (key === instanceKeyXdr(ID)) {
      return instance ? { latestLedger: 100, entries: [{ xdr: instanceXdr(live), liveUntilLedgerSeq: 100 + days * DAY }] } : { latestLedger: 100, entries: [] };
    }
    for (const [hash, left] of Object.entries(codeDays)) {
      if (key === codeKeyXdr(hash)) return left === undefined ? { latestLedger: 100, entries: [] } : { latestLedger: 100, entries: [{ liveUntilLedgerSeq: 100 + left * DAY }] };
    }
    throw new Error(`unexpected key ${key}`);
  };
  return { lookup, calls };
}
const options = (extra = {}) => ({ minDays: 3, ...extra });

test('a healthy fixture on v1 is ok, and the instance is asked for once, not twice', async () => {
  const { lookup, calls } = fakeLookup();
  const status = await statusOf(config(), options({ expect: 'v1' }), lookup);
  assert.equal(status.ok, true);
  assert.equal(status.contracts[0].live.label, 'v1');
  assert.equal(status.contracts[0].instance.daysLeft, 20);
  assert.deepEqual(status.builds.map((build) => [build.label, build.ok, build.daysLeft]), [['v1', true, 20], ['v2', true, 20]]);
  assert.equal(calls.filter((key) => key === instanceKeyXdr(ID)).length, 1);
  assert.equal(calls.length, 3);
});

test('the wrong build fails it even when everything has plenty of life left', async () => {
  const status = await statusOf(config(), options({ expect: 'v1' }), fakeLookup({ live: V2 }).lookup);
  assert.equal(status.ok, false);
  assert.equal(status.contracts[0].ok, false);
  assert.equal(status.contracts[0].instance.ok, true);
  assert.match(status.contracts[0].live.message, /runs v2 .*expected v1/);
});

test('without --expect any listed build is fine', async () => {
  assert.equal((await statusOf(config(), options(), fakeLookup({ live: V2 }).lookup)).ok, true);
});

test('an unlisted build fails it', async () => {
  const status = await statusOf(config(), options(), fakeLookup({ live: 'ab'.repeat(32) }).lookup);
  assert.equal(status.ok, false);
  assert.equal(status.contracts[0].live.live, 'unknown');
});

test('an instance with too little life fails it, and so does a build whose code has too little', async () => {
  assert.equal((await statusOf(config(), options(), fakeLookup({ days: 2 }).lookup)).ok, false);
  const status = await statusOf(config(), options(), fakeLookup({ codeDays: { [V1]: 20, [V2]: 1 } }).lookup);
  assert.equal(status.ok, false);
  assert.deepEqual(status.builds.map((build) => build.ok), [true, false]);
  assert.match(status.builds[1].message, /under the 3-day minimum/);
});

test('--min-days is the limit: exactly that many days passes', async () => {
  assert.equal((await statusOf(config(), options({ minDays: 5 }), fakeLookup({ days: 5, codeDays: { [V1]: 5, [V2]: 5 } }).lookup)).ok, true);
  assert.equal((await statusOf(config(), options({ minDays: 6 }), fakeLookup({ days: 5, codeDays: { [V1]: 5, [V2]: 5 } }).lookup)).ok, false);
});

test('a missing instance or missing code is reported, not skipped', async () => {
  const gone = await statusOf(config(), options(), fakeLookup({ instance: false }).lookup);
  assert.equal(gone.ok, false);
  assert.equal(gone.contracts[0].live.live, 'missing');
  const noCode = await statusOf(config(), options(), fakeLookup({ codeDays: { [V1]: 20, [V2]: undefined } }).lookup);
  assert.equal(noCode.ok, false);
  assert.match(noCode.builds[1].message, /not found/);
});

test('a build that two contracts list is looked at once', async () => {
  const shared = config();
  shared.contracts.other = { contractId: ID, supported: [{ wasmHash: V1, label: 'v1' }] };
  const { lookup, calls } = fakeLookup();
  const status = await statusOf(shared, options(), lookup);
  assert.equal(status.builds.length, 2);
  assert.equal(calls.filter((key) => key === codeKeyXdr(V1)).length, 1);
});

test('an entry the RPC answered nonsense for makes it throw, so the run ends with exit 2', async () => {
  const lookup = async (key) => (key === instanceKeyXdr(ID) ? { latestLedger: 1, entries: [{ xdr: 'AAAA', liveUntilLedgerSeq: 99 }] } : { latestLedger: 1, entries: [] });
  await assert.rejects(statusOf(config(), options(), lookup), /not a contract instance|ends early/);
});

test('the options are read like the other scripts, with --expect and --min-days', () => {
  assert.deepEqual(parseArgs([]), { config: 'fixture.wasmward.json', minDays: 3, json: false, timeoutMs: 15_000 });
  const parsed = parseArgs(['--expect', 'v1', '--min-days', '7', '--json', '--timeout-ms', '800']);
  assert.deepEqual([parsed.expect, parsed.minDays, parsed.json, parsed.timeoutMs], ['v1', 7, true, 800]);
  assert.throws(() => parseArgs(['--min-days', '-1']), /0 or more/);
  assert.throws(() => parseArgs(['--min-days', 'soon']), /0 or more/);
  assert.throws(() => parseArgs(['--expect']), /--expect needs a value/);
  assert.throws(() => parseArgs(['--nope']), /unknown option --nope/);
});

/** Runs the script for real against a local RPC that answers like `fakeLookup`. */
async function run(args, behaviour) {
  const { lookup } = fakeLookup(behaviour);
  const server = createServer((req, res) => {
    let body = '';
    req.on('data', (chunk) => (body += chunk));
    req.on('end', async () => {
      const key = JSON.parse(body).params.keys[0];
      res.setHeader('content-type', 'application/json');
      res.end(JSON.stringify({ jsonrpc: '2.0', id: 1, result: await lookup(key) }));
    });
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const dir = mkdtempSync(join(tmpdir(), 'fixture-status-'));
  try {
    const file = join(dir, 'config.json');
    writeFileSync(file, JSON.stringify({ ...config(), network: { rpcUrl: `http://127.0.0.1:${server.address().port}` } }));
    return await new Promise((resolve) =>
      execFile(process.execPath, ['scripts/fixture-status.mjs', '--config', file, ...args], (error, stdout, stderr) => resolve({ status: error ? error.code : 0, stdout, stderr })),
    );
  } finally {
    server.closeAllConnections();
    await new Promise((resolve) => server.close(resolve));
    rmSync(dir, { recursive: true, force: true });
  }
}

test('run for real: exit 0 and a closing line when all is well', async () => {
  const out = await run(['--expect', 'v1']);
  assert.equal(out.status, 0);
  assert.match(out.stdout, /runs v1/);
  assert.match(out.stdout, /Wasm code lives about 20 more days/);
  assert.match(out.stdout, /The fixture is all right\.$/m);
});

test('run for real: exit 1 and a pointer to the recovery guide when it is on v2', async () => {
  const out = await run(['--expect', 'v1'], { live: V2 });
  assert.equal(out.status, 1);
  assert.match(out.stdout, /docs\/RECOVERY\.md/);
});

test('run for real: --json is one object that agrees with the exit code', async () => {
  const out = await run(['--json', '--min-days', '30']);
  assert.equal(out.status, 1);
  const report = JSON.parse(out.stdout);
  assert.equal(report.ok, false);
  assert.equal(report.minDays, 30);
  assert.equal(report.builds.length, 2);
});

test('run for real: exit 2 for an unknown --expect label, before asking the network', async () => {
  const out = await run(['--expect', 'v9']);
  assert.equal(out.status, 2);
  assert.match(out.stderr, /--expect v9 is not a label in the config \(v1, v2\)/);
});
