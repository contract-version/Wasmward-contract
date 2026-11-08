import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { test } from 'node:test';
import {
  analyzeFailoverReadiness,
  benchmarkEndpoints,
  computeLatencyStats,
  detectLedgerLag,
  main,
  parseArgs,
  parseBoundedInt,
  renderBenchmarkMarkdown,
  renderBenchmarkText,
  resolveTargets,
} from './rpc-benchmark.mjs';

const ID = 'CBR5ZFDI2GBXG66DAEWWHSAK4NDLKSKHWVUEUSOM4UOBM66TI6DYPDPV';
const V1 = 'a7a82511fa284650178b02fe3a4bafc587b95212f2f8ce647f2df5ef4cf42509';

function sampleConfig() {
  return {
    network: {
      rpcUrl: 'https://primary.rpc.example.org',
      fallbackRpcUrls: ['https://backup.rpc.example.org'],
    },
    contracts: {
      fixture: {
        contractId: ID,
        supported: [{ wasmHash: V1, label: 'v1' }],
      },
    },
  };
}

test('parseArgs reads defaults and multiple --rpc-url flags', () => {
  assert.deepEqual(parseArgs([]), {
    config: 'fixture.wasmward.json',
    rpcUrls: [],
    samples: 3,
    maxLagLedgers: 15,
    warnLatencyMs: 1500,
    timeoutMs: 15_000,
    json: false,
    markdown: false,
    verbose: false,
  });

  const parsed = parseArgs([
    '--rpc-url', 'https://a.example.org',
    '--rpc-url', 'https://b.example.org',
    '--samples', '5',
    '--max-lag-ledgers', '25',
    '--warn-latency-ms', '800',
    '--timeout-ms', '4000',
    '--retries', '2',
    '--json',
    '--verbose',
  ]);
  assert.deepEqual(parsed.rpcUrls, ['https://a.example.org', 'https://b.example.org']);
  assert.equal(parsed.samples, 5);
  assert.equal(parsed.maxLagLedgers, 25);
  assert.equal(parsed.warnLatencyMs, 800);
  assert.equal(parsed.timeoutMs, 4000);
  assert.equal(parsed.retries, 2);
  assert.equal(parsed.json, true);
  assert.equal(parsed.verbose, true);
});

test('parseArgs and parseBoundedInt refuse invalid values and conflicting flags', () => {
  assert.equal(parseBoundedInt('10', '--samples', 1, 50), 10);
  assert.throws(() => parseBoundedInt('0', '--samples', 1, 50), /from 1 to 50/);
  assert.throws(() => parseBoundedInt('51', '--samples', 1, 50), /from 1 to 50/);
  assert.throws(() => parseArgs(['--json', '--markdown']), /cannot be used together/);
  assert.throws(() => parseArgs(['--rpc-url', 'ftp://bad']), /https:\/\/ or http:\/\//);
  assert.throws(() => parseArgs(['--unknown']), /unknown option --unknown/);
});

test('computeLatencyStats computes min, avg, p50, p95, max, and jitter accurately', () => {
  const empty = computeLatencyStats([]);
  assert.equal(empty.count, 0);
  assert.equal(empty.minMs, null);

  const stats = computeLatencyStats([120, 40, 80, 60, 200]);
  assert.equal(stats.count, 5);
  assert.equal(stats.minMs, 40);
  assert.equal(stats.maxMs, 200);
  assert.equal(stats.avgMs, 100);
  assert.equal(stats.p50Ms, 80);
  assert.equal(stats.p95Ms, 200);
  assert.equal(stats.jitterMs, 160);
});

test('detectLedgerLag identifies endpoints lagging behind the pool head ledger', () => {
  const { highestLedger, endpoints } = detectLedgerLag(
    [
      { rpcUrl: 'https://fast.org', latestLedger: 5000 },
      { rpcUrl: 'https://near.org', latestLedger: 4992 },
      { rpcUrl: 'https://stale.org', latestLedger: 4950 },
      { rpcUrl: 'https://down.org', latestLedger: null },
    ],
    15,
  );
  assert.equal(highestLedger, 5000);
  assert.deepEqual(
    endpoints.map((e) => [e.rpcUrl, e.lagLedgers, e.lagging]),
    [
      ['https://fast.org', 0, false],
      ['https://near.org', 8, false],
      ['https://stale.org', 50, true],
      ['https://down.org', null, false],
    ],
  );
});

test('analyzeFailoverReadiness ranks endpoints and reports single-point or degraded pools', () => {
  const ready = analyzeFailoverReadiness([
    { rpcUrl: 'https://slow-primary.org', reachable: true, lagging: false, lagLedgers: 0, successRate: 1, latency: { p95Ms: 250 } },
    { rpcUrl: 'https://fast-backup.org', reachable: true, lagging: false, lagLedgers: 0, successRate: 1, latency: { p95Ms: 90 } },
  ]);
  assert.equal(ready.failoverReady, true);
  assert.equal(ready.primaryEndpoint, 'https://fast-backup.org');
  assert.deepEqual(ready.backupEndpoints, ['https://slow-primary.org']);

  const single = analyzeFailoverReadiness([
    { rpcUrl: 'https://only.org', reachable: true, lagging: false, lagLedgers: 0, successRate: 1, latency: { p95Ms: 80 } },
  ]);
  assert.equal(single.failoverReady, false);
  assert.equal(single.primaryEndpoint, 'https://only.org');
  assert.ok(single.recommendations.some((r) => r.includes('Only 1 RPC endpoint')));
});

test('benchmarkEndpoints aggregates multi-sample probes across healthy, lagging, and down endpoints', async () => {
  const scripted = {
    'https://primary.rpc.example.org': [
      { ok: true, durationMs: 45, latestLedger: 1200, entryFound: true },
      { ok: true, durationMs: 55, latestLedger: 1201, entryFound: true },
      { ok: true, durationMs: 50, latestLedger: 1201, entryFound: true },
    ],
    'https://backup.rpc.example.org': [
      { ok: true, durationMs: 80, latestLedger: 1200, entryFound: true },
      { ok: true, durationMs: 95, latestLedger: 1200, entryFound: true },
      { ok: true, durationMs: 90, latestLedger: 1201, entryFound: true },
    ],
  };

  const probe = async (url, _key, { sampleIndex }) => scripted[url][sampleIndex];
  const report = await benchmarkEndpoints(
    ['https://primary.rpc.example.org', 'https://backup.rpc.example.org'],
    'KEY_XDR',
    { samples: 3, maxLagLedgers: 15, warnLatencyMs: 1500, timeoutMs: 5000 },
    probe,
  );
  assert.equal(report.ok, true);
  assert.equal(report.highestLedger, 1201);
  assert.equal(report.failover.failoverReady, true);
  assert.equal(report.failover.primaryEndpoint, 'https://primary.rpc.example.org');

  // Now simulate a lagging endpoint
  const withStale = await benchmarkEndpoints(
    ['https://primary.rpc.example.org', 'https://stale.rpc.example.org'],
    'KEY_XDR',
    { samples: 2, maxLagLedgers: 10, warnLatencyMs: 1500, timeoutMs: 5000 },
    async (url) =>
      url.includes('stale')
        ? { ok: true, durationMs: 60, latestLedger: 1100, entryFound: true }
        : { ok: true, durationMs: 40, latestLedger: 1200, entryFound: true },
  );
  assert.equal(withStale.ok, false);
  assert.equal(withStale.endpoints[1].lagging, true);
  assert.equal(withStale.endpoints[1].lagLedgers, 100);
});

test('renderBenchmarkText and renderBenchmarkMarkdown format latency and failover tables', async () => {
  const report = await benchmarkEndpoints(
    ['https://primary.rpc.example.org'],
    'KEY_XDR',
    { samples: 2, maxLagLedgers: 15, warnLatencyMs: 1500, timeoutMs: 5000 },
    async () => ({ ok: true, durationMs: 50, latestLedger: 900, entryFound: true }),
  );
  const text = renderBenchmarkText(report, { verbose: true }).join('\n');
  assert.match(text, /Soroban RPC Benchmark — HEALTHY/);
  assert.match(text, /jitter: 0ms/);
  assert.match(text, /Failover Readiness: SINGLE-POINT/);

  const md = renderBenchmarkMarkdown(report).join('\n');
  assert.match(md, /^# Soroban RPC Benchmark Report/m);
  assert.match(md, /\| `https:\/\/primary\.rpc\.example\.org` \| OK \|/);
});

test('resolveTargets and main work with config and CLI flags', async () => {
  const targets = resolveTargets(sampleConfig(), { rpcUrls: [] });
  assert.deepEqual(targets.rpcUrls, ['https://primary.rpc.example.org', 'https://backup.rpc.example.org']);

  const code = await main(
    ['--samples', '2', '--json'],
    {
      readText: () => JSON.stringify(sampleConfig()),
      probeFn: async () => ({ ok: true, durationMs: 35, latestLedger: 777, entryFound: true }),
    },
  );
  assert.equal(code, 0);
});

const runCli = (args) =>
  new Promise((resolve) =>
    execFile(process.execPath, ['scripts/rpc-benchmark.mjs', ...args], (error, stdout, stderr) =>
      resolve({ status: error ? error.code : 0, stdout, stderr }),
    ),
  );

test('CLI --help prints usage and exit codes, and unknown flags exit 2', async () => {
  const help = await runCli(['--help']);
  assert.equal(help.status, 0);
  assert.match(help.stdout, /node scripts\/rpc-benchmark\.mjs/);
  assert.match(help.stdout, /Exit codes:/);

  const bad = await runCli(['--invalid-flag']);
  assert.equal(bad.status, 2);
  assert.match(bad.stderr, /unknown option --invalid-flag/);
});
