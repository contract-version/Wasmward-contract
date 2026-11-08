#!/usr/bin/env node
// Multi-contract and multi-profile fleet health and drift auditor: inspects live contract state and Wasm code
// entries, compares against wasmward.json and optional release manifests, computes TTL burn rates and estimated
// expiration timestamps, detects hash drift or unindexed versions, and outputs human-readable tables, JSON, or
// Markdown reports.
//
//   node scripts/audit-fleet.mjs [--config fixture.wasmward.json] [--manifest FILE] [--profile NAME]
//                                [--expect LABEL] [--min-days 3] [--warn-ledgers N] [--json] [--markdown]
//                                [--verbose] [--rpc-url URL] [--timeout-ms N] [--retries N]
//
// --manifest compares live and configured hashes against a release manifest (such as testnet.json or a map of
// labels/contracts to expected hashes). --profile selects a named profile or contract subset when the config
// defines multiple contracts or profiles. --warn-ledgers flags entries within N ledgers of expiry as warnings
// even if they still clear --min-days.
//
// Exit codes: 0 all audited contracts and Wasm code entries are healthy and free of drift, 1 drift, missing
// entry, or low TTL detected, 2 options, config, manifest, or RPC could not be used. No dependencies; needs
// Node 18 or newer.
import { readFileSync } from 'node:fs';
import { pathToFileURL } from 'node:url';
import { daysFor } from './check-lifetimes.mjs';
import { parseRetries, parseRpcUrl, parseTimeout, valueAfter } from './cli-options.mjs';
import { helpFromHeader, wantsHelp } from './help.mjs';
import { parseInstanceEntry } from './instance-entry.mjs';
import { codeKeyXdr, instanceKeyXdr } from './ledger-keys.mjs';
import { rpcLookup } from './rpc.mjs';

export const SECONDS_PER_LEDGER = 5;
export const LEDGERS_PER_HOUR = Math.round(3600 / SECONDS_PER_LEDGER);
export const LEDGERS_PER_DAY = Math.round(86_400 / SECONDS_PER_LEDGER);

/** Parses a positive or zero integer option for --warn-ledgers. */
export function parseWarnLedgers(text) {
  const trimmed = String(text).trim();
  const n = Number(trimmed);
  if (trimmed === '' || !Number.isInteger(n) || n < 0) {
    throw new Error('--warn-ledgers must be a whole number of ledgers, 0 or more');
  }
  return n;
}

/** Reads command line flags for audit-fleet.mjs. */
export function parseArgs(argv) {
  const options = {
    config: 'fixture.wasmward.json',
    minDays: 3,
    json: false,
    markdown: false,
    verbose: false,
    timeoutMs: 15_000,
  };
  for (let i = 0; i < argv.length; i += 1) {
    const flag = argv[i];
    if (flag === '--config') options.config = valueAfter(argv, i++, flag);
    else if (flag === '--manifest') options.manifest = valueAfter(argv, i++, flag);
    else if (flag === '--profile') options.profile = valueAfter(argv, i++, flag);
    else if (flag === '--expect') options.expect = valueAfter(argv, i++, flag);
    else if (flag === '--min-days') options.minDays = Number(valueAfter(argv, i++, flag));
    else if (flag === '--warn-ledgers') options.warnLedgers = parseWarnLedgers(valueAfter(argv, i++, flag));
    else if (flag === '--rpc-url') options.rpcUrl = parseRpcUrl(valueAfter(argv, i++, flag));
    else if (flag === '--timeout-ms') options.timeoutMs = parseTimeout(valueAfter(argv, i++, flag));
    else if (flag === '--retries') options.retries = parseRetries(valueAfter(argv, i++, flag));
    else if (flag === '--json') options.json = true;
    else if (flag === '--markdown') options.markdown = true;
    else if (flag === '--verbose') options.verbose = true;
    else throw new Error(`unknown option ${flag}`);
  }
  if (!Number.isFinite(options.minDays) || options.minDays < 0) {
    throw new Error('--min-days must be a number of days, 0 or more');
  }
  if (options.json && options.markdown) {
    throw new Error('--json and --markdown cannot be used together');
  }
  return options;
}

/**
 * Normalizes a release manifest (either a deployment file like testnet.json with v1/v2 objects, or a map of
 * contract/build labels to expected hashes) into { contractId?, builds: Map<label, wasmHash>, hashes: Set<wasmHash> }.
 */
export function normalizeManifest(raw) {
  if (raw === undefined || raw === null) return undefined;
  if (typeof raw !== 'object' || Array.isArray(raw)) {
    throw new Error('the release manifest must be a JSON object');
  }
  const builds = new Map();
  const hashes = new Set();
  const addBuild = (label, hash) => {
    if (typeof hash === 'string' && /^[0-9a-f]{64}$/i.test(hash)) {
      const lower = hash.toLowerCase();
      builds.set(label, lower);
      hashes.add(lower);
    }
  };

  for (const [key, value] of Object.entries(raw)) {
    if (key === 'contractId' || key === 'network' || key === 'admin' || key === 'deployedAt') continue;
    if (typeof value === 'string') addBuild(key, value);
    else if (value !== null && typeof value === 'object' && typeof value.wasmHash === 'string') {
      addBuild(key, value.wasmHash);
    }
  }
  if (Array.isArray(raw.builds)) {
    for (const item of raw.builds) {
      if (item && typeof item.label === 'string' && typeof item.wasmHash === 'string') {
        addBuild(item.label, item.wasmHash);
      }
    }
  }
  return {
    contractId: typeof raw.contractId === 'string' ? raw.contractId : undefined,
    builds,
    hashes,
  };
}

/**
 * Computes TTL health, burn rate metrics, and estimated expiration timestamp for one ledger entry.
 */
export function computeTtlMetrics(result, { minDays = 3, warnLedgers, nowMs = Date.now(), secondsPerLedger = SECONDS_PER_LEDGER } = {}) {
  const entry = Array.isArray(result?.entries) ? result.entries[0] : undefined;
  const burnRate = {
    secondsPerLedger,
    ledgersPerHour: Math.round(3600 / secondsPerLedger),
    ledgersPerDay: Math.round(86_400 / secondsPerLedger),
  };

  if (entry === undefined) {
    return {
      ok: false,
      status: 'missing',
      ledgersLeft: null,
      daysLeft: null,
      hoursLeft: null,
      estimatedExpiresAt: null,
      burnRate,
      marginLedgers: null,
    };
  }

  const until = entry.liveUntilLedgerSeq;
  const latest = result?.latestLedger;
  if (!Number.isFinite(until) || !Number.isFinite(latest)) {
    return {
      ok: false,
      status: 'undated',
      ledgersLeft: null,
      daysLeft: null,
      hoursLeft: null,
      estimatedExpiresAt: null,
      burnRate,
      marginLedgers: null,
    };
  }

  const ledgersLeft = until - latest;
  const minLedgers = Math.ceil((minDays * 86_400) / secondsPerLedger);
  const warnThreshold = warnLedgers !== undefined ? Math.max(minLedgers, warnLedgers) : minLedgers;
  const marginLedgers = ledgersLeft - minLedgers;
  const secondsLeft = Math.max(0, ledgersLeft) * secondsPerLedger;
  const daysLeft = ledgersLeft < 0 ? 0 : daysFor(ledgersLeft);
  const hoursLeft = ledgersLeft < 0 ? 0 : Math.floor(secondsLeft / 3600);
  const estimatedExpiresAt = new Date(nowMs + ledgersLeft * secondsPerLedger * 1000).toISOString();

  if (ledgersLeft < 0) {
    return {
      ok: false,
      status: 'expired',
      liveUntilLedgerSeq: until,
      latestLedger: latest,
      ledgersLeft,
      daysLeft: 0,
      hoursLeft: 0,
      estimatedExpiresAt,
      burnRate,
      marginLedgers,
    };
  }

  if (ledgersLeft < minLedgers) {
    return {
      ok: false,
      status: 'critical',
      liveUntilLedgerSeq: until,
      latestLedger: latest,
      ledgersLeft,
      daysLeft,
      hoursLeft,
      estimatedExpiresAt,
      burnRate,
      marginLedgers,
    };
  }

  if (ledgersLeft < warnThreshold) {
    return {
      ok: false,
      status: 'warning',
      liveUntilLedgerSeq: until,
      latestLedger: latest,
      ledgersLeft,
      daysLeft,
      hoursLeft,
      estimatedExpiresAt,
      burnRate,
      marginLedgers,
    };
  }

  return {
    ok: true,
    status: 'healthy',
    liveUntilLedgerSeq: until,
    latestLedger: latest,
    ledgersLeft,
    daysLeft,
    hoursLeft,
    estimatedExpiresAt,
    burnRate,
    marginLedgers,
  };
}

/**
 * Detects contract state and version drift against supported builds, expected label, and optional release manifest.
 */
export function detectContractDrift(name, contractConfig, instanceResult, { expect, manifest } = {}) {
  const contractId = contractConfig.contractId;
  const supported = contractConfig.supported ?? [];
  const expectedLabel = expect ?? contractConfig.expect;
  const entry = Array.isArray(instanceResult?.entries) ? instanceResult.entries[0] : undefined;

  const manifestIssues = [];
  if (manifest !== undefined) {
    if (manifest.contractId !== undefined && manifest.contractId !== contractId) {
      manifestIssues.push(`contractId ${contractId.slice(0, 8)}... differs from manifest (${manifest.contractId.slice(0, 8)}...)`);
    }
    for (const build of supported) {
      const lower = String(build.wasmHash).toLowerCase();
      if (build.label !== undefined && manifest.builds.has(build.label)) {
        const expectedHash = manifest.builds.get(build.label);
        if (expectedHash !== lower) {
          manifestIssues.push(`label ${build.label} hash ${lower.slice(0, 8)}... drifts from manifest (${expectedHash.slice(0, 8)}...)`);
        }
      }
    }
  }

  if (entry === undefined) {
    return {
      ok: false,
      driftStatus: 'missing-instance',
      liveWasmHash: null,
      liveLabel: null,
      manifestAligned: manifestIssues.length === 0,
      manifestIssues,
      reason: `${name} (${contractId.slice(0, 8)}...) instance not found on network`,
    };
  }

  const parsed = parseInstanceEntry(entry.xdr);
  if (parsed.kind === 'stellar-asset') {
    return {
      ok: false,
      driftStatus: 'stellar-asset',
      liveWasmHash: null,
      liveLabel: null,
      manifestAligned: manifestIssues.length === 0,
      manifestIssues,
      reason: `${name} (${contractId.slice(0, 8)}...) is a Stellar Asset Contract without Wasm code`,
    };
  }

  const liveWasmHash = parsed.wasmHash.toLowerCase();
  const matched = supported.find((b) => String(b.wasmHash).toLowerCase() === liveWasmHash);
  if (matched === undefined) {
    return {
      ok: false,
      driftStatus: 'unindexed-wasm',
      liveWasmHash,
      liveLabel: null,
      manifestAligned: manifestIssues.length === 0,
      manifestIssues,
      reason: `${name} runs unindexed Wasm ${liveWasmHash.slice(0, 12)}... not listed in supported builds`,
    };
  }

  const liveLabel = matched.label ?? 'unlabelled';
  if (expectedLabel !== undefined && liveLabel !== expectedLabel) {
    return {
      ok: false,
      driftStatus: 'version-drift',
      liveWasmHash,
      liveLabel,
      expectedLabel,
      manifestAligned: manifestIssues.length === 0,
      manifestIssues,
      reason: `${name} runs ${liveLabel} (${liveWasmHash.slice(0, 8)}...), expected ${expectedLabel}`,
    };
  }

  if (manifestIssues.length > 0) {
    return {
      ok: false,
      driftStatus: 'manifest-drift',
      liveWasmHash,
      liveLabel,
      manifestAligned: false,
      manifestIssues,
      reason: `${name} has manifest drift: ${manifestIssues.join('; ')}`,
    };
  }

  return {
    ok: true,
    driftStatus: 'aligned',
    liveWasmHash,
    liveLabel,
    manifestAligned: true,
    manifestIssues: [],
    reason: `${name} runs ${liveLabel} (${liveWasmHash.slice(0, 8)}...)`,
  };
}

/**
 * Selects contracts to audit from config (supporting top-level `contracts` and optional `profiles.<name>.contracts`).
 */
export function selectContracts(config, profileName) {
  if (profileName !== undefined) {
    const profile = config?.profiles?.[profileName];
    if (profile?.contracts && typeof profile.contracts === 'object') {
      return Object.entries(profile.contracts);
    }
    if (config?.contracts?.[profileName] !== undefined) {
      return [[profileName, config.contracts[profileName]]];
    }
    const available = [
      ...Object.keys(config?.profiles ?? {}),
      ...Object.keys(config?.contracts ?? {}),
    ];
    throw new Error(`--profile ${profileName} not found in config (available: ${available.join(', ') || 'none'})`);
  }
  return Object.entries(config?.contracts ?? {});
}

/**
 * Runs a full fleet audit over the selected contracts and their supported builds.
 */
export async function auditFleet(config, options, lookup) {
  const entries = selectContracts(config, options.profile);
  const addressed = entries.filter(([, contract]) => typeof contract?.contractId === 'string');
  if (addressed.length === 0) {
    throw new Error('the config has no contract with a contractId for the selected profile');
  }

  const manifest = normalizeManifest(options.manifestData);
  const nowMs = options.nowMs ?? Date.now();
  const ttlOptions = { minDays: options.minDays, warnLedgers: options.warnLedgers, nowMs };

  const contracts = [];
  const builds = [];
  const seenHashes = new Set();

  for (const [name, contract] of addressed) {
    const instanceResult = await lookup(instanceKeyXdr(contract.contractId));
    const ttl = computeTtlMetrics(instanceResult, ttlOptions);
    const drift = detectContractDrift(name, contract, instanceResult, { expect: options.expect, manifest });
    const ok = ttl.ok && drift.ok;
    contracts.push({
      name,
      contractId: contract.contractId,
      ok,
      ttl,
      drift,
    });
  }

  for (const [contractName, contract] of addressed) {
    for (const build of contract.supported ?? []) {
      const wasmHash = String(build.wasmHash).toLowerCase();
      if (seenHashes.has(wasmHash)) continue;
      seenHashes.add(wasmHash);
      const label = build.label ?? 'build';
      const codeResult = await lookup(codeKeyXdr(wasmHash));
      const ttl = computeTtlMetrics(codeResult, ttlOptions);
      const inManifest = manifest === undefined
        ? true
        : (manifest.builds.has(label) ? manifest.builds.get(label) === wasmHash : manifest.hashes.has(wasmHash));
      const ok = ttl.ok && inManifest;
      builds.push({
        label,
        wasmHash,
        referencedBy: contractName,
        ok,
        inManifest,
        ttl,
      });
    }
  }

  const allTtls = [
    ...contracts.map((c) => c.ttl.ledgersLeft).filter((n) => typeof n === 'number'),
    ...builds.map((b) => b.ttl.ledgersLeft).filter((n) => typeof n === 'number'),
  ];
  const shortestTtlLedgers = allTtls.length > 0 ? Math.min(...allTtls) : null;
  const shortestTtlDays = shortestTtlLedgers === null ? null : daysFor(Math.max(0, shortestTtlLedgers));

  const summary = {
    totalContracts: contracts.length,
    healthyContracts: contracts.filter((c) => c.ok).length,
    driftedContracts: contracts.filter((c) => !c.drift.ok).length,
    expiringContracts: contracts.filter((c) => !c.ttl.ok).length,
    totalBuilds: builds.length,
    healthyBuilds: builds.filter((b) => b.ok).length,
    expiringBuilds: builds.filter((b) => !b.ttl.ok).length,
    shortestTtlLedgers,
    shortestTtlDays,
  };

  const ok = contracts.every((c) => c.ok) && builds.every((b) => b.ok);
  return {
    ok,
    profile: options.profile ?? 'default',
    minDays: options.minDays,
    ...(options.warnLedgers === undefined ? {} : { warnLedgers: options.warnLedgers }),
    summary,
    contracts,
    builds,
  };
}

/** Formats the fleet audit report as human-readable aligned text lines. */
export function renderTable(report, { verbose = false } = {}) {
  const lines = [];
  lines.push(`Fleet Audit (${report.profile}) — ${report.ok ? 'HEALTHY' : 'ATTENTION NEEDED'}`);
  lines.push('');
  lines.push('Contracts:');
  for (const c of report.contracts) {
    const badge = c.ok ? 'ok   ' : 'ALERT';
    const ttlText = c.ttl.ledgersLeft === null
      ? c.ttl.status
      : `${c.ttl.daysLeft}d (${c.ttl.ledgersLeft} ledgers, ${c.ttl.status})`;
    lines.push(`  ${badge}  ${c.name.padEnd(10)} ${c.contractId.slice(0, 8)}...  live: ${(c.drift.liveLabel ?? c.drift.driftStatus).padEnd(15)} ttl: ${ttlText}`);
    if (!c.drift.ok) lines.push(`         drift: ${c.drift.reason}`);
    if (verbose && c.ttl.estimatedExpiresAt !== null) {
      lines.push(`         expires: ${c.ttl.estimatedExpiresAt} (burn: ${c.ttl.burnRate.ledgersPerDay} ledgers/day, margin: ${c.ttl.marginLedgers} ledgers)`);
    }
  }
  lines.push('');
  lines.push('Wasm Code Entries:');
  for (const b of report.builds) {
    const badge = b.ok ? 'ok   ' : 'ALERT';
    const ttlText = b.ttl.ledgersLeft === null
      ? b.ttl.status
      : `${b.ttl.daysLeft}d (${b.ttl.ledgersLeft} ledgers, ${b.ttl.status})`;
    const manifestNote = b.inManifest ? '' : ' [manifest mismatch]';
    lines.push(`  ${badge}  ${b.label.padEnd(10)} ${b.wasmHash.slice(0, 8)}...  ttl: ${ttlText}${manifestNote}`);
    if (verbose && b.ttl.estimatedExpiresAt !== null) {
      lines.push(`         expires: ${b.ttl.estimatedExpiresAt} (margin: ${b.ttl.marginLedgers} ledgers)`);
    }
  }
  lines.push('');
  const s = report.summary;
  const shortest = s.shortestTtlLedgers === null ? 'n/a' : `${s.shortestTtlDays}d (${s.shortestTtlLedgers} ledgers)`;
  lines.push(`Summary: ${s.healthyContracts}/${s.totalContracts} contracts ok, ${s.healthyBuilds}/${s.totalBuilds} builds ok, shortest TTL: ${shortest}.`);
  return lines;
}

/** Formats the fleet audit report as a GitHub-Flavored Markdown document. */
export function renderMarkdown(report) {
  const lines = [];
  lines.push(`# Fleet Audit Report (${report.profile})`);
  lines.push('');
  lines.push(`**Status:** ${report.ok ? 'HEALTHY' : 'ATTENTION NEEDED'} | **Minimum TTL:** ${report.minDays} days`);
  lines.push('');
  lines.push('## Contracts');
  lines.push('');
  lines.push('| Contract | Address | Live Build | Drift Status | TTL (Days) | Ledgers Left | Estimated Expiry |');
  lines.push('|---|---|---|---|---|---|---|');
  for (const c of report.contracts) {
    const days = c.ttl.daysLeft ?? 'n/a';
    const ledgers = c.ttl.ledgersLeft ?? 'n/a';
    const expiry = c.ttl.estimatedExpiresAt ?? 'n/a';
    lines.push(`| \`${c.name}\` | \`${c.contractId.slice(0, 8)}...\` | \`${c.drift.liveLabel ?? 'none'}\` | ${c.drift.driftStatus} | ${days} | ${ledgers} | ${expiry} |`);
  }
  lines.push('');
  lines.push('## Wasm Code Entries');
  lines.push('');
  lines.push('| Label | Wasm Hash | TTL Status | Days Left | Ledgers Left | Estimated Expiry |');
  lines.push('|---|---|---|---|---|---|');
  for (const b of report.builds) {
    const days = b.ttl.daysLeft ?? 'n/a';
    const ledgers = b.ttl.ledgersLeft ?? 'n/a';
    const expiry = b.ttl.estimatedExpiresAt ?? 'n/a';
    lines.push(`| \`${b.label}\` | \`${b.wasmHash.slice(0, 12)}...\` | ${b.ttl.status} | ${days} | ${ledgers} | ${expiry} |`);
  }
  lines.push('');
  const s = report.summary;
  lines.push(`**Summary:** ${s.healthyContracts}/${s.totalContracts} contracts healthy, ${s.healthyBuilds}/${s.totalBuilds} builds healthy, ${s.driftedContracts} drifted.`);
  return lines;
}

export async function main(argv, { lookup, readText = (path) => readFileSync(path, 'utf8') } = {}) {
  if (wantsHelp(argv)) {
    console.log(helpFromHeader(import.meta.url));
    return 0;
  }
  let options;
  let config;
  try {
    options = parseArgs(argv);
    config = JSON.parse(readText(options.config));
    if (options.manifest !== undefined) {
      options.manifestData = JSON.parse(readText(options.manifest));
    }
  } catch (error) {
    console.error(`error: ${error.message}`);
    return 2;
  }

  const rpcUrl = options.rpcUrl ?? config?.network?.rpcUrl;
  if (typeof rpcUrl !== 'string' && lookup === undefined) {
    console.error('error: the config has no network.rpcUrl and --rpc-url was not given');
    return 2;
  }

  const activeLookup = lookup ?? ((key) => rpcLookup(rpcUrl, key, { timeoutMs: options.timeoutMs, retries: options.retries }));
  let report;
  try {
    report = await auditFleet(config, options, activeLookup);
  } catch (error) {
    console.error(`error: ${error.message}`);
    return 2;
  }

  if (options.json) {
    console.log(JSON.stringify(report));
  } else if (options.markdown) {
    console.log(renderMarkdown(report).join('\n'));
  } else {
    console.log(renderTable(report, { verbose: options.verbose }).join('\n'));
  }
  return report.ok ? 0 : 1;
}

if (process.argv[1] !== undefined && import.meta.url === pathToFileURL(process.argv[1]).href) {
  process.exitCode = await main(process.argv.slice(2));
}
