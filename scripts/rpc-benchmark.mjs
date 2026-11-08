#!/usr/bin/env node
// Soroban RPC endpoint health, latency distribution (min/avg/p50/p95/max), ledger lag detection, and failover
// readiness analyzer across one or more RPC endpoints.
//
//   node scripts/rpc-benchmark.mjs [--config fixture.wasmward.json] [--rpc-url URL ...] [--samples 3]
//                                  [--max-lag-ledgers 15] [--warn-latency-ms 1500] [--timeout-ms N]
//                                  [--retries N] [--json] [--markdown] [--verbose]
//
// Pass --rpc-url more than once to compare a primary RPC against backup providers and evaluate failover
// readiness. When no --rpc-url is given, the script benchmarks network.rpcUrl (and any network.fallbackRpcUrls)
// from the config file.
//
// Exit codes: 0 at least one healthy, non-lagging endpoint is ready (and no tested endpoint failed completely
// unless a healthy backup exists when multiple are given; all configured endpoints must be healthy if only one
// is tested), 1 all endpoints failed, lagged beyond --max-lag-ledgers, or exceeded latency/health checks,
// 2 options or config could not be used. No dependencies; needs Node 18 or newer.
import { readFileSync } from 'node:fs';
import { performance } from 'node:perf_hooks';
import { pathToFileURL } from 'node:url';
import { parseRetries, parseRpcUrl, parseTimeout, valueAfter } from './cli-options.mjs';
import { helpFromHeader, wantsHelp } from './help.mjs';
import { codeKeyXdr, instanceKeyXdr } from './ledger-keys.mjs';
import { rpcLookup } from './rpc.mjs';

/** Parses a positive integer option within bounds. */
export function parseBoundedInt(text, flag, min, max) {
  const trimmed = String(text).trim();
  const n = Number(trimmed);
  if (trimmed === '' || !Number.isInteger(n) || n < min || n > max) {
    throw new Error(`${flag} must be a whole number from ${min} to ${max}`);
  }
  return n;
}

/** Reads command line arguments for rpc-benchmark.mjs. */
export function parseArgs(argv) {
  const options = {
    config: 'fixture.wasmward.json',
    rpcUrls: [],
    samples: 3,
    maxLagLedgers: 15,
    warnLatencyMs: 1500,
    timeoutMs: 15_000,
    json: false,
    markdown: false,
    verbose: false,
  };
  for (let i = 0; i < argv.length; i += 1) {
    const flag = argv[i];
    if (flag === '--config') options.config = valueAfter(argv, i++, flag);
    else if (flag === '--rpc-url') options.rpcUrls.push(parseRpcUrl(valueAfter(argv, i++, flag)));
    else if (flag === '--samples') options.samples = parseBoundedInt(valueAfter(argv, i++, flag), flag, 1, 50);
    else if (flag === '--max-lag-ledgers') options.maxLagLedgers = parseBoundedInt(valueAfter(argv, i++, flag), flag, 0, 100_000);
    else if (flag === '--warn-latency-ms') options.warnLatencyMs = parseBoundedInt(valueAfter(argv, i++, flag), flag, 50, 120_000);
    else if (flag === '--timeout-ms') options.timeoutMs = parseTimeout(valueAfter(argv, i++, flag));
    else if (flag === '--retries') options.retries = parseRetries(valueAfter(argv, i++, flag));
    else if (flag === '--json') options.json = true;
    else if (flag === '--markdown') options.markdown = true;
    else if (flag === '--verbose') options.verbose = true;
    else throw new Error(`unknown option ${flag}`);
  }
  if (options.json && options.markdown) {
    throw new Error('--json and --markdown cannot be used together');
  }
  return options;
}

function round2(n) {
  return Math.round(n * 100) / 100;
}

/**
 * Computes latency distribution metrics (min, avg, p50, p95, max, jitter) from an array of durations in ms.
 */
export function computeLatencyStats(samplesMs) {
  if (!Array.isArray(samplesMs) || samplesMs.length === 0) {
    return {
      count: 0,
      minMs: null,
      avgMs: null,
      p50Ms: null,
      p95Ms: null,
      maxMs: null,
      jitterMs: null,
    };
  }
  const sorted = [...samplesMs].sort((a, b) => a - b);
  const count = sorted.length;
  const minMs = round2(sorted[0]);
  const maxMs = round2(sorted[count - 1]);
  const sum = sorted.reduce((acc, v) => acc + v, 0);
  const avgMs = round2(sum / count);

  const percentile = (p) => {
    const idx = Math.min(count - 1, Math.max(0, Math.ceil((p / 100) * count) - 1));
    return round2(sorted[idx]);
  };
  const p50Ms = percentile(50);
  const p95Ms = percentile(95);
  const jitterMs = round2(maxMs - minMs);

  return { count, minMs, avgMs, p50Ms, p95Ms, maxMs, jitterMs };
}

/**
 * Computes ledger lag across endpoint reports relative to the highest observed ledger sequence.
 */
export function detectLedgerLag(endpoints, maxLagLedgers = 15) {
  const ledgers = endpoints
    .map((e) => e.latestLedger)
    .filter((l) => typeof l === 'number' && Number.isFinite(l));
  const highestLedger = ledgers.length > 0 ? Math.max(...ledgers) : null;

  const annotated = endpoints.map((endpoint) => {
    if (highestLedger === null || typeof endpoint.latestLedger !== 'number') {
      return {
        ...endpoint,
        lagLedgers: null,
        lagging: false,
      };
    }
    const lagLedgers = highestLedger - endpoint.latestLedger;
    const lagging = lagLedgers > maxLagLedgers;
    return {
      ...endpoint,
      lagLedgers,
      lagging,
    };
  });

  return { highestLedger, endpoints: annotated };
}

/**
 * Evaluates failover readiness and ranks healthy endpoints by availability, freshness, and p95 latency.
 */
export function analyzeFailoverReadiness(endpoints, { warnLatencyMs = 1500 } = {}) {
  const healthy = endpoints
    .filter((e) => e.reachable && !e.lagging && e.successRate === 1)
    .sort((a, b) => {
      if ((a.lagLedgers ?? 0) !== (b.lagLedgers ?? 0)) return (a.lagLedgers ?? 0) - (b.lagLedgers ?? 0);
      return (a.latency.p95Ms ?? Infinity) - (b.latency.p95Ms ?? Infinity);
    });

  const degraded = endpoints.filter((e) => e.reachable && (!healthy.includes(e)));
  const unreachable = endpoints.filter((e) => !e.reachable);

  const primaryEndpoint = healthy[0]?.rpcUrl ?? degraded[0]?.rpcUrl ?? null;
  const backupEndpoints = healthy.slice(1).map((e) => e.rpcUrl);
  const failoverReady = healthy.length >= 2;

  const warnings = [];
  const recommendations = [];

  for (const e of endpoints) {
    if (!e.reachable) {
      warnings.push(`${e.rpcUrl} is unreachable (${e.lastError ?? 'no response'})`);
    } else if (e.lagging) {
      warnings.push(`${e.rpcUrl} lags by ${e.lagLedgers} ledgers behind head`);
    } else if (e.latency.p95Ms !== null && e.latency.p95Ms > warnLatencyMs) {
      warnings.push(`${e.rpcUrl} p95 latency (${e.latency.p95Ms}ms) exceeds warning threshold (${warnLatencyMs}ms)`);
    }
  }

  if (endpoints.length === 1) {
    recommendations.push('Only 1 RPC endpoint configured; add a secondary endpoint via --rpc-url for automatic failover.');
  } else if (!failoverReady && healthy.length === 1) {
    recommendations.push(`Only 1 endpoint (${primaryEndpoint}) is fully healthy; repair degraded/unreachable backup endpoints.`);
  } else if (healthy.length === 0) {
    recommendations.push('No healthy RPC endpoints available; check network connectivity or switch provider.');
  }

  return {
    failoverReady,
    totalEndpoints: endpoints.length,
    healthyCount: healthy.length,
    degradedCount: degraded.length,
    unreachableCount: unreachable.length,
    primaryEndpoint,
    backupEndpoints,
    warnings,
    recommendations,
  };
}

/**
 * Default probe function that measures one rpcLookup call and returns { ok, durationMs, latestLedger, entryFound, error }.
 */
export async function defaultProbe(rpcUrl, key, { timeoutMs, retries }) {
  const start = performance.now();
  try {
    const result = await rpcLookup(rpcUrl, key, { timeoutMs, retries });
    const durationMs = round2(performance.now() - start);
    const entryFound = Array.isArray(result?.entries) && result.entries.length > 0;
    return {
      ok: true,
      durationMs,
      latestLedger: typeof result?.latestLedger === 'number' ? result.latestLedger : null,
      entryFound,
    };
  } catch (error) {
    const durationMs = round2(performance.now() - start);
    return {
      ok: false,
      durationMs,
      latestLedger: null,
      entryFound: false,
      error: error.message,
    };
  }
}

/**
 * Benchmarks all specified RPC URLs across `options.samples` iterations.
 */
export async function benchmarkEndpoints(rpcUrls, probeKey, options, probeFn = defaultProbe) {
  const rawReports = [];
  for (const rpcUrl of rpcUrls) {
    const samples = [];
    const latencies = [];
    let latestLedger = null;
    let entryFoundCount = 0;
    let lastError = null;

    for (let i = 0; i < options.samples; i += 1) {
      const sample = await probeFn(rpcUrl, probeKey, {
        timeoutMs: options.timeoutMs,
        retries: options.retries,
        sampleIndex: i,
      });
      samples.push(sample);
      if (sample.ok) {
        latencies.push(sample.durationMs);
        if (typeof sample.latestLedger === 'number') {
          latestLedger = latestLedger === null ? sample.latestLedger : Math.max(latestLedger, sample.latestLedger);
        }
        if (sample.entryFound) entryFoundCount += 1;
      } else {
        lastError = sample.error ?? 'probe failed';
      }
    }

    const successCount = latencies.length;
    const successRate = round2(successCount / options.samples);
    const latency = computeLatencyStats(latencies);
    rawReports.push({
      rpcUrl,
      reachable: successCount > 0,
      successCount,
      sampleCount: options.samples,
      successRate,
      entryFound: entryFoundCount > 0,
      latestLedger,
      latency,
      lastError,
      samples,
    });
  }

  const { highestLedger, endpoints: withLag } = detectLedgerLag(rawReports, options.maxLagLedgers);
  const endpoints = withLag.map((e) => {
    const latencyOk = e.latency.p95Ms !== null && e.latency.p95Ms <= options.warnLatencyMs;
    const ok = e.reachable && e.successRate === 1 && !e.lagging && latencyOk;
    return { ...e, ok };
  });

  const failover = analyzeFailoverReadiness(endpoints, { warnLatencyMs: options.warnLatencyMs });
  const ok = endpoints.length > 0 && endpoints.every((e) => e.ok);

  return {
    ok,
    highestLedger,
    samplesPerEndpoint: options.samples,
    maxLagLedgers: options.maxLagLedgers,
    warnLatencyMs: options.warnLatencyMs,
    endpoints,
    failover,
  };
}

/** Renders the benchmark report as human-readable aligned text lines. */
export function renderBenchmarkText(report, { verbose = false } = {}) {
  const lines = [];
  lines.push(`Soroban RPC Benchmark — ${report.ok ? 'HEALTHY' : 'ISSUES DETECTED'} (head ledger: ${report.highestLedger ?? 'unknown'})`);
  lines.push('');
  lines.push('Endpoints:');
  for (const e of report.endpoints) {
    const badge = e.ok ? 'ok  ' : 'WARN';
    const lat = e.latency.count === 0
      ? 'unreachable'
      : `min ${e.latency.minMs}ms / avg ${e.latency.avgMs}ms / p50 ${e.latency.p50Ms}ms / p95 ${e.latency.p95Ms}ms / max ${e.latency.maxMs}ms`;
    const lag = e.lagLedgers === null ? 'n/a' : `${e.lagLedgers} ledgers${e.lagging ? ' (LAGGING)' : ''}`;
    lines.push(`  ${badge}  ${e.rpcUrl}`);
    lines.push(`        success: ${e.successCount}/${e.sampleCount} | ledger: ${e.latestLedger ?? 'n/a'} (lag: ${lag}) | ${lat}`);
    if (e.lastError !== null) lines.push(`        error: ${e.lastError}`);
    if (verbose && e.latency.jitterMs !== null) {
      lines.push(`        jitter: ${e.latency.jitterMs}ms | entry present: ${e.entryFound ? 'yes' : 'no'}`);
    }
  }
  lines.push('');
  lines.push(`Failover Readiness: ${report.failover.failoverReady ? 'READY' : 'SINGLE-POINT / DEGRADED'} (primary: ${report.failover.primaryEndpoint ?? 'none'})`);
  for (const w of report.failover.warnings) lines.push(`  warning: ${w}`);
  for (const r of report.failover.recommendations) lines.push(`  advice:  ${r}`);
  return lines;
}

/** Renders the benchmark report as GitHub-Flavored Markdown. */
export function renderBenchmarkMarkdown(report) {
  const lines = [];
  lines.push('# Soroban RPC Benchmark Report');
  lines.push('');
  lines.push(`**Status:** ${report.ok ? 'HEALTHY' : 'ISSUES DETECTED'} | **Head Ledger:** ${report.highestLedger ?? 'n/a'} | **Failover Ready:** ${report.failover.failoverReady ? 'Yes' : 'No'}`);
  lines.push('');
  lines.push('| Endpoint | Status | Success | Ledger | Lag | Min (ms) | Avg (ms) | p50 (ms) | p95 (ms) | Max (ms) |');
  lines.push('|---|---|---|---|---|---|---|---|---|---|');
  for (const e of report.endpoints) {
    const status = e.ok ? 'OK' : (e.reachable ? 'DEGRADED' : 'DOWN');
    lines.push(`| \`${e.rpcUrl}\` | ${status} | ${e.successCount}/${e.sampleCount} | ${e.latestLedger ?? 'n/a'} | ${e.lagLedgers ?? 'n/a'} | ${e.latency.minMs ?? 'n/a'} | ${e.latency.avgMs ?? 'n/a'} | ${e.latency.p50Ms ?? 'n/a'} | ${e.latency.p95Ms ?? 'n/a'} | ${e.latency.maxMs ?? 'n/a'} |`);
  }
  lines.push('');
  lines.push(`**Primary Endpoint:** \`${report.failover.primaryEndpoint ?? 'none'}\``);
  return lines;
}

/** Resolves the list of RPC URLs and the probe key from options and config. */
export function resolveTargets(config, options) {
  const urls = [...options.rpcUrls];
  if (urls.length === 0) {
    if (typeof config?.network?.rpcUrl === 'string') {
      urls.push(parseRpcUrl(config.network.rpcUrl));
    }
    if (Array.isArray(config?.network?.fallbackRpcUrls)) {
      for (const u of config.network.fallbackRpcUrls) urls.push(parseRpcUrl(u));
    }
  }
  if (urls.length === 0) {
    throw new Error('no RPC endpoints to benchmark: give --rpc-url or a config with network.rpcUrl');
  }

  // Pick an instance key or a code key from the config as the probe key
  for (const contract of Object.values(config?.contracts ?? {})) {
    if (typeof contract?.contractId === 'string') {
      return { rpcUrls: urls, probeKey: instanceKeyXdr(contract.contractId) };
    }
    if (Array.isArray(contract?.supported) && contract.supported.length > 0) {
      return { rpcUrls: urls, probeKey: codeKeyXdr(String(contract.supported[0].wasmHash).toLowerCase()) };
    }
  }
  throw new Error('the config has no contractId or supported wasmHash to probe');
}

export async function main(argv, { probeFn = defaultProbe, readText = (path) => readFileSync(path, 'utf8') } = {}) {
  if (wantsHelp(argv)) {
    console.log(helpFromHeader(import.meta.url));
    return 0;
  }
  let options;
  let config = {};
  let targets;
  try {
    options = parseArgs(argv);
    config = JSON.parse(readText(options.config));
    targets = resolveTargets(config, options);
  } catch (error) {
    console.error(`error: ${error.message}`);
    return 2;
  }

  let report;
  try {
    report = await benchmarkEndpoints(targets.rpcUrls, targets.probeKey, options, probeFn);
  } catch (error) {
    console.error(`error: ${error.message}`);
    return 2;
  }

  if (options.json) {
    console.log(JSON.stringify(report));
  } else if (options.markdown) {
    console.log(renderBenchmarkMarkdown(report).join('\n'));
  } else {
    console.log(renderBenchmarkText(report, { verbose: options.verbose }).join('\n'));
  }
  return report.ok ? 0 : 1;
}

if (process.argv[1] !== undefined && import.meta.url === pathToFileURL(process.argv[1]).href) {
  process.exitCode = await main(process.argv.slice(2));
}
