import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { test } from 'node:test';
import {
  auditFleet,
  computeTtlMetrics,
  detectContractDrift,
  LEDGERS_PER_DAY,
  LEDGERS_PER_HOUR,
  main,
  normalizeManifest,
  parseArgs,
  parseWarnLedgers,
  renderMarkdown,
  renderTable,
  selectContracts,
} from './audit-fleet.mjs';
import { codeKeyXdr, instanceKeyXdr } from './ledger-keys.mjs';

const V1 = 'a7a82511fa284650178b02fe3a4bafc587b95212f2f8ce647f2df5ef4cf42509';
const V2 = 'ec040ead4e157695a16a9723a5d95a44268f1b8da4c5f6aee7bf4f218dbdc875';
const UNINDEXED = '99'.repeat(32);
const ID1 = 'CBR5ZFDI2GBXG66DAEWWHSAK4NDLKSKHWVUEUSOM4UOBM66TI6DYPDPV';
const FIXED_NOW = Date.parse('2026-11-08T00:00:00Z');

const u32 = (...values) => Buffer.from(values.flatMap((v) => [(v >>> 24) & 255, (v >>> 16) & 255, (v >>> 8) & 255, v & 255]));
const instanceXdr = (hash) => Buffer.concat([u32(6, 0, 1), Buffer.alloc(32, 3), u32(20, 1, 19, 0), Buffer.from(hash, 'hex')]).toString('base64');
const assetInstanceXdr = () => Buffer.concat([u32(6, 0, 1), Buffer.alloc(32, 3), u32(20, 1, 19, 1)]).toString('base64');

function sampleConfig() {
  return {
    network: { rpcUrl: 'https://soroban-testnet.stellar.org' },
    contracts: {
      fixture: {
        contractId: ID1,
        supported: [
          { wasmHash: V1, label: 'v1' },
          { wasmHash: V2, label: 'v2' },
        ],
      },
    },
    profiles: {
      staging: {
        contracts: {
          fixtureStaging: {
            contractId: ID1,
            expect: 'v2',
            supported: [
              { wasmHash: V1, label: 'v1' },
              { wasmHash: V2, label: 'v2' },
            ],
          },
        },
      },
    },
  };
}

function fakeLookup({ live = V1, instanceDays = 20, codeDays = { [V1]: 20, [V2]: 20 }, instancePresent = true } = {}) {
  return async (key) => {
    if (key === instanceKeyXdr(ID1)) {
      if (!instancePresent) return { latestLedger: 1000, entries: [] };
      const xdr = live === 'stellar-asset' ? assetInstanceXdr() : instanceXdr(live);
      return {
        latestLedger: 1000,
        entries: [{ xdr, liveUntilLedgerSeq: 1000 + Math.round(instanceDays * LEDGERS_PER_DAY) }],
      };
    }
    for (const [hash, days] of Object.entries(codeDays)) {
      if (key === codeKeyXdr(hash)) {
        if (days === null || days === undefined) return { latestLedger: 1000, entries: [] };
        return {
          latestLedger: 1000,
          entries: [{ liveUntilLedgerSeq: 1000 + Math.round(days * LEDGERS_PER_DAY) }],
        };
      }
    }
    throw new Error(`unexpected lookup key ${key}`);
  };
}

test('parseArgs reads defaults and validates all fleet audit options', () => {
  assert.deepEqual(parseArgs([]), {
    config: 'fixture.wasmward.json',
    minDays: 3,
    json: false,
    markdown: false,
    verbose: false,
    timeoutMs: 15_000,
  });

  const parsed = parseArgs([
    '--config', 'custom.json',
    '--manifest', 'testnet.json',
    '--profile', 'staging',
    '--expect', 'v1',
    '--min-days', '5',
    '--warn-ledgers', '100000',
    '--rpc-url', 'https://rpc.example.org',
    '--timeout-ms', '5000',
    '--retries', '2',
    '--markdown',
    '--verbose',
  ]);
  assert.equal(parsed.config, 'custom.json');
  assert.equal(parsed.manifest, 'testnet.json');
  assert.equal(parsed.profile, 'staging');
  assert.equal(parsed.expect, 'v1');
  assert.equal(parsed.minDays, 5);
  assert.equal(parsed.warnLedgers, 100000);
  assert.equal(parsed.rpcUrl, 'https://rpc.example.org');
  assert.equal(parsed.timeoutMs, 5000);
  assert.equal(parsed.retries, 2);
  assert.equal(parsed.markdown, true);
  assert.equal(parsed.verbose, true);
});

test('parseArgs rejects conflicting or malformed options', () => {
  assert.throws(() => parseArgs(['--json', '--markdown']), /cannot be used together/);
  assert.throws(() => parseArgs(['--min-days', '-2']), /--min-days must be/);
  assert.throws(() => parseArgs(['--warn-ledgers', '-1']), /--warn-ledgers must be/);
  assert.throws(() => parseArgs(['--warn-ledgers', '1.5']), /--warn-ledgers must be/);
  assert.throws(() => parseArgs(['--unknown-flag']), /unknown option --unknown-flag/);
  assert.equal(parseWarnLedgers('0'), 0);
  assert.equal(parseWarnLedgers('50000'), 50000);
});

test('computeTtlMetrics calculates burn rates, expiration timestamps, and status tiers', () => {
  const healthy = computeTtlMetrics(
    { latestLedger: 1000, entries: [{ liveUntilLedgerSeq: 1000 + 10 * LEDGERS_PER_DAY }] },
    { minDays: 3, warnLedgers: 5 * LEDGERS_PER_DAY, nowMs: FIXED_NOW },
  );
  assert.equal(healthy.ok, true);
  assert.equal(healthy.status, 'healthy');
  assert.equal(healthy.daysLeft, 10);
  assert.equal(healthy.hoursLeft, 240);
  assert.equal(healthy.burnRate.ledgersPerHour, LEDGERS_PER_HOUR);
  assert.equal(healthy.burnRate.ledgersPerDay, LEDGERS_PER_DAY);
  assert.equal(healthy.estimatedExpiresAt, new Date(FIXED_NOW + 10 * 86_400 * 1000).toISOString());

  const warning = computeTtlMetrics(
    { latestLedger: 1000, entries: [{ liveUntilLedgerSeq: 1000 + 4 * LEDGERS_PER_DAY }] },
    { minDays: 3, warnLedgers: 6 * LEDGERS_PER_DAY, nowMs: FIXED_NOW },
  );
  assert.equal(warning.ok, false);
  assert.equal(warning.status, 'warning');
  assert.equal(warning.daysLeft, 4);

  const critical = computeTtlMetrics(
    { latestLedger: 1000, entries: [{ liveUntilLedgerSeq: 1000 + 1 * LEDGERS_PER_DAY }] },
    { minDays: 3, nowMs: FIXED_NOW },
  );
  assert.equal(critical.ok, false);
  assert.equal(critical.status, 'critical');

  const expired = computeTtlMetrics(
    { latestLedger: 1000, entries: [{ liveUntilLedgerSeq: 950 }] },
    { minDays: 3, nowMs: FIXED_NOW },
  );
  assert.equal(expired.ok, false);
  assert.equal(expired.status, 'expired');
  assert.equal(expired.ledgersLeft, -50);

  const missing = computeTtlMetrics({ latestLedger: 1000, entries: [] }, { minDays: 3 });
  assert.equal(missing.ok, false);
  assert.equal(missing.status, 'missing');

  const undated = computeTtlMetrics({ latestLedger: 1000, entries: [{}] }, { minDays: 3 });
  assert.equal(undated.ok, false);
  assert.equal(undated.status, 'undated');
});

test('normalizeManifest supports testnet.json layout and direct label maps', () => {
  const fromTestnet = normalizeManifest({
    network: 'testnet',
    contractId: ID1,
    v1: { wasmHash: V1.toUpperCase() },
    v2: { wasmHash: V2 },
  });
  assert.equal(fromTestnet.contractId, ID1);
  assert.equal(fromTestnet.builds.get('v1'), V1);
  assert.equal(fromTestnet.builds.get('v2'), V2);
  assert.ok(fromTestnet.hashes.has(V1));

  const fromBuildsList = normalizeManifest({
    builds: [{ label: 'v1', wasmHash: V1 }],
  });
  assert.equal(fromBuildsList.builds.get('v1'), V1);
  assert.throws(() => normalizeManifest([]), /JSON object/);
});

test('detectContractDrift identifies aligned, version-drift, unindexed-wasm, manifest-drift, and missing instances', () => {
  const contractConfig = sampleConfig().contracts.fixture;
  const okEntry = { latestLedger: 100, entries: [{ xdr: instanceXdr(V1), liveUntilLedgerSeq: 999999 }] };

  const aligned = detectContractDrift('fixture', contractConfig, okEntry, { expect: 'v1' });
  assert.equal(aligned.ok, true);
  assert.equal(aligned.driftStatus, 'aligned');
  assert.equal(aligned.liveLabel, 'v1');

  const wrongVersion = detectContractDrift('fixture', contractConfig, okEntry, { expect: 'v2' });
  assert.equal(wrongVersion.ok, false);
  assert.equal(wrongVersion.driftStatus, 'version-drift');
  assert.match(wrongVersion.reason, /runs v1 .*expected v2/);

  const unindexedEntry = { latestLedger: 100, entries: [{ xdr: instanceXdr(UNINDEXED), liveUntilLedgerSeq: 999999 }] };
  const unindexed = detectContractDrift('fixture', contractConfig, unindexedEntry);
  assert.equal(unindexed.ok, false);
  assert.equal(unindexed.driftStatus, 'unindexed-wasm');
  assert.match(unindexed.reason, /unindexed Wasm/);

  const badManifest = normalizeManifest({ contractId: ID1, v1: { wasmHash: UNINDEXED } });
  const manifestDrift = detectContractDrift('fixture', contractConfig, okEntry, { manifest: badManifest });
  assert.equal(manifestDrift.ok, false);
  assert.equal(manifestDrift.driftStatus, 'manifest-drift');

  const missing = detectContractDrift('fixture', contractConfig, { latestLedger: 100, entries: [] });
  assert.equal(missing.ok, false);
  assert.equal(missing.driftStatus, 'missing-instance');

  const asset = detectContractDrift('fixture', contractConfig, { latestLedger: 100, entries: [{ xdr: assetInstanceXdr() }] });
  assert.equal(asset.ok, false);
  assert.equal(asset.driftStatus, 'stellar-asset');
});

test('selectContracts resolves named profiles and single-contract names', () => {
  const cfg = sampleConfig();
  assert.equal(selectContracts(cfg)[0][0], 'fixture');
  assert.equal(selectContracts(cfg, 'staging')[0][0], 'fixtureStaging');
  assert.equal(selectContracts(cfg, 'fixture')[0][0], 'fixture');
  assert.throws(() => selectContracts(cfg, 'nonexistent'), /--profile nonexistent not found/);
});

test('auditFleet aggregates multi-contract and build health across profiles', async () => {
  const report = await auditFleet(
    sampleConfig(),
    { minDays: 3, expect: 'v1', nowMs: FIXED_NOW },
    fakeLookup({ live: V1, instanceDays: 15, codeDays: { [V1]: 12, [V2]: 20 } }),
  );
  assert.equal(report.ok, true);
  assert.equal(report.summary.totalContracts, 1);
  assert.equal(report.summary.healthyContracts, 1);
  assert.equal(report.summary.totalBuilds, 2);
  assert.equal(report.summary.healthyBuilds, 2);
  assert.equal(report.summary.shortestTtlDays, 12);

  const stagingReport = await auditFleet(
    sampleConfig(),
    { profile: 'staging', minDays: 3, nowMs: FIXED_NOW },
    fakeLookup({ live: V1 }),
  );
  assert.equal(stagingReport.ok, false);
  assert.equal(stagingReport.summary.driftedContracts, 1);
  assert.equal(stagingReport.contracts[0].drift.driftStatus, 'version-drift');
});

test('renderTable and renderMarkdown format complete reports with verbose and drift details', async () => {
  const report = await auditFleet(
    sampleConfig(),
    { minDays: 3, expect: 'v2', nowMs: FIXED_NOW },
    fakeLookup({ live: V1, instanceDays: 10, codeDays: { [V1]: 10, [V2]: 2 } }),
  );
  const tableLines = renderTable(report, { verbose: true }).join('\n');
  assert.match(tableLines, /Fleet Audit \(default\) — ATTENTION NEEDED/);
  assert.match(tableLines, /drift: fixture runs v1/);
  assert.match(tableLines, /expires: 2026-11-18T00:00:00\.000Z/);
  assert.match(tableLines, /Summary: 0\/1 contracts ok, 1\/2 builds ok/);

  const md = renderMarkdown(report).join('\n');
  assert.match(md, /^# Fleet Audit Report \(default\)/m);
  assert.match(md, /\| `fixture` \|/);
  assert.match(md, /\| `v2` \|/);
  assert.match(md, /1 drifted/);
});

test('main supports --json, --markdown, and table output with injected lookup and readText', async () => {
  const files = {
    'fixture.wasmward.json': JSON.stringify(sampleConfig()),
    'manifest.json': JSON.stringify({ contractId: ID1, v1: { wasmHash: V1 }, v2: { wasmHash: V2 } }),
  };
  const code = await main(
    ['--manifest', 'manifest.json', '--expect', 'v1', '--json'],
    { lookup: fakeLookup(), readText: (p) => files[p] },
  );
  assert.equal(code, 0);
});

const runCli = (args) =>
  new Promise((resolve) =>
    execFile(process.execPath, ['scripts/audit-fleet.mjs', ...args], (error, stdout, stderr) =>
      resolve({ status: error ? error.code : 0, stdout, stderr }),
    ),
  );

test('CLI --help prints usage and exit codes, and unknown flags exit 2', async () => {
  const help = await runCli(['--help']);
  assert.equal(help.status, 0);
  assert.match(help.stdout, /node scripts\/audit-fleet\.mjs/);
  assert.match(help.stdout, /Exit codes:/);

  const bad = await runCli(['--bogus']);
  assert.equal(bad.status, 2);
  assert.match(bad.stderr, /unknown option --bogus/);
});
