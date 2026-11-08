#!/usr/bin/env node
// One command for "is the fixture all right?": which build is live, and how long the instance and the Wasm code
// of every supported build have left. It is check-lifetimes.mjs and live-build.mjs together, asking the RPC for
// each contract's instance once instead of twice.
//
//   node scripts/fixture-status.mjs [--config fixture.wasmward.json] [--min-days 3] [--warn-ledgers N]
//                                   [--expect v1] [--json] [--markdown] [--verbose] [--rpc-url URL]
//                                   [--timeout-ms N] [--retries N]
//
// --expect takes a label from the config; --min-days is how much life each entry must have left (default 3).
//
// With --json it prints one object: { ok, minDays, contracts: [{ name, contractId, ok, instance: {...},
// live: {...} }], builds: [{ label, wasmHash, ok, message, ledgersLeft?, daysLeft? }] }.
//
// Exit codes: 0 everything is fine, 1 something is not (an unlisted or unexpected build, a missing or expired entry,
// or under --min-days left), 2 the config or the RPC could not be used. No dependencies; needs Node 18 or newer.
import { readFileSync } from 'node:fs';
import { pathToFileURL } from 'node:url';
import { daysFor, judge, judgeInstance } from './check-lifetimes.mjs';
import { parseRetries, parseRpcUrl, parseTimeout, valueAfter } from './cli-options.mjs';
import { instanceKeyXdr, codeKeyXdr } from './ledger-keys.mjs';
import { judgeLive } from './live-build.mjs';
import { rpcLookup } from './rpc.mjs';
import { helpFromHeader, wantsHelp } from './help.mjs';

/** Reads the command line. Throws an Error whose message says what is wrong. */
export function parseArgs(argv) {
  const options = { config: 'fixture.wasmward.json', minDays: 3, json: false, timeoutMs: 15_000 };
  for (let i = 0; i < argv.length; i += 1) {
    const flag = argv[i];
    if (flag === '--config') options.config = valueAfter(argv, i++, flag);
    else if (flag === '--min-days') options.minDays = Number(valueAfter(argv, i++, flag));
    else if (flag === '--warn-ledgers') {
      const raw = String(valueAfter(argv, i++, flag)).trim();
      const n = Number(raw);
      if (raw === '' || !Number.isInteger(n) || n < 0) throw new Error('--warn-ledgers must be a whole number of ledgers, 0 or more');
      options.warnLedgers = n;
    } else if (flag === '--expect') options.expect = valueAfter(argv, i++, flag);
    else if (flag === '--rpc-url') options.rpcUrl = parseRpcUrl(valueAfter(argv, i++, flag));
    else if (flag === '--timeout-ms') options.timeoutMs = parseTimeout(valueAfter(argv, i++, flag));
    else if (flag === '--retries') options.retries = parseRetries(valueAfter(argv, i++, flag));
    else if (flag === '--json') options.json = true;
    else if (flag === '--markdown') options.markdown = true;
    else if (flag === '--verbose') options.verbose = true;
    else throw new Error(`unknown option ${flag}`);
  }
  if (!Number.isFinite(options.minDays) || options.minDays < 0) throw new Error('--min-days must be a number of days, 0 or more');
  if (options.json && options.markdown) throw new Error('--json and --markdown cannot be used together');
  return options;
}

/** Computes summary statistics for the fixture status report. */
export function summarizeStatus(status) {
  const ttls = [
    ...status.contracts.map((c) => c.instance?.ledgersLeft).filter((n) => typeof n === 'number'),
    ...status.builds.map((b) => b.ledgersLeft).filter((n) => typeof n === 'number'),
  ];
  const shortestLedgersLeft = ttls.length > 0 ? Math.min(...ttls) : null;
  return {
    totalContracts: status.contracts.length,
    healthyContracts: status.contracts.filter((c) => c.ok).length,
    totalBuilds: status.builds.length,
    healthyBuilds: status.builds.filter((b) => b.ok).length,
    shortestLedgersLeft,
    shortestDaysLeft: shortestLedgersLeft === null ? null : daysFor(Math.max(0, shortestLedgersLeft)),
  };
}

/** Renders the fixture status report as GitHub-Flavored Markdown. */
export function renderMarkdownStatus(status, options = {}) {
  const summary = summarizeStatus(status);
  const lines = [
    '# Fixture Status Report',
    '',
    `**Status:** ${status.ok ? 'ALL RIGHT' : 'NEEDS ATTENTION'} | **Minimum Days:** ${options.minDays ?? 3}${options.expect ? ` | **Expected Build:** \`${options.expect}\`` : ''}`,
    '',
    '## Contracts',
    '',
    '| Contract | Address | Live Build | Live OK | Instance Days Left | Instance Ledgers Left |',
    '|---|---|---|---|---|---|',
  ];
  for (const c of status.contracts) {
    lines.push(`| \`${c.name}\` | \`${c.contractId.slice(0, 8)}...\` | \`${c.live.label ?? c.live.live}\` | ${c.live.ok ? 'yes' : 'no'} | ${c.instance.daysLeft ?? 'n/a'} | ${c.instance.ledgersLeft ?? 'n/a'} |`);
  }
  lines.push('', '## Supported Builds', '', '| Label | Wasm Hash | Status | Days Left | Ledgers Left |', '|---|---|---|---|---|');
  for (const b of status.builds) {
    lines.push(`| \`${b.label}\` | \`${b.wasmHash.slice(0, 12)}...\` | ${b.ok ? 'OK' : 'ATTENTION'} | ${b.daysLeft ?? 'n/a'} | ${b.ledgersLeft ?? 'n/a'} |`);
  }
  lines.push('', `**Summary:** ${summary.healthyContracts}/${summary.totalContracts} contracts ok, ${summary.healthyBuilds}/${summary.totalBuilds} builds ok, shortest TTL: ${summary.shortestDaysLeft ?? 'n/a'} days.`);
  return lines;
}

/**
 * The verdicts for a config, given a function that asks the RPC for one ledger key. Returns
 * { ok, contracts, builds }. Throws if an answer is not what an RPC gives, so the caller can exit 2.
 */
export async function statusOf(config, options, lookup) {
  const contracts = [];
  const builds = [];
  let ok = true;
  const judgeExtras = { warnLedgers: options.warnLedgers, verbose: Boolean(options.verbose) };

  for (const [name, contract] of Object.entries(config.contracts ?? {})) {
    if (typeof contract?.contractId !== 'string') continue;
    const result = await lookup(instanceKeyXdr(contract.contractId));
    const instance = judgeInstance(name, contract.contractId, result, options.minDays, judgeExtras);
    const live = judgeLive(name, contract.contractId, result, contract.supported ?? [], options.expect);
    const good = instance.ok && live.ok;
    if (!good) ok = false;
    contracts.push({
      name,
      contractId: contract.contractId,
      ok: good,
      instance: { ok: instance.ok, message: instance.text, ...(instance.ledgersLeft === undefined ? {} : { ledgersLeft: instance.ledgersLeft, daysLeft: daysFor(Math.max(0, instance.ledgersLeft)) }) },
      live,
    });
  }

  // Every build once, even if two contracts list it.
  const seen = new Set();
  for (const contract of Object.values(config.contracts ?? {})) {
    for (const build of contract.supported ?? []) {
      if (seen.has(build.wasmHash)) continue;
      seen.add(build.wasmHash);
      const label = build.label ?? 'build';
      const verdict = judge(label, build.wasmHash, await lookup(codeKeyXdr(build.wasmHash)), options.minDays, judgeExtras);
      if (!verdict.ok) ok = false;
      builds.push({
        label,
        wasmHash: build.wasmHash,
        ok: verdict.ok,
        message: verdict.text,
        ...(verdict.ledgersLeft === undefined ? {} : { ledgersLeft: verdict.ledgersLeft, daysLeft: daysFor(Math.max(0, verdict.ledgersLeft)) }),
      });
    }
  }
  return { ok, contracts, builds };
}

async function main(argv) {
  if (wantsHelp(argv)) {
    console.log(helpFromHeader(import.meta.url));
    return 0;
  }
  let options;
  let config;
  try {
    options = parseArgs(argv);
    config = JSON.parse(readFileSync(options.config, 'utf8'));
  } catch (error) {
    console.error(`error: ${error.message}`);
    return 2;
  }
  const rpcUrl = options.rpcUrl ?? config?.network?.rpcUrl;
  const addressed = Object.values(config?.contracts ?? {}).filter((contract) => typeof contract?.contractId === 'string');
  if (typeof rpcUrl !== 'string' || addressed.length === 0) {
    console.error('error: the config has no network.rpcUrl or no contract with a contractId');
    return 2;
  }
  if (options.expect !== undefined) {
    const labels = addressed.flatMap((contract) => (contract.supported ?? []).map((build) => build.label));
    if (!labels.includes(options.expect)) {
      console.error(`error: --expect ${options.expect} is not a label in the config (${labels.filter((label) => label !== undefined).join(', ')})`);
      return 2;
    }
  }

  let status;
  try {
    status = await statusOf(config, options, (key) => rpcLookup(rpcUrl, key, { timeoutMs: options.timeoutMs, retries: options.retries }));
  } catch (error) {
    console.error(`error: ${error.message}`);
    return 2;
  }
  const summary = summarizeStatus(status);
  if (options.json) {
    console.log(JSON.stringify({
      ok: status.ok,
      minDays: options.minDays,
      ...(options.warnLedgers === undefined ? {} : { warnLedgers: options.warnLedgers }),
      ...(options.verbose ? { summary } : {}),
      contracts: status.contracts,
      builds: status.builds,
    }));
  } else if (options.markdown) {
    console.log(renderMarkdownStatus(status, options).join('\n'));
  } else {
    for (const contract of status.contracts) {
      console.log(contract.live.message);
      console.log(contract.instance.message);
    }
    for (const build of status.builds) console.log(build.message);
    if (options.verbose) {
      console.log(`Summary: ${summary.healthyContracts}/${summary.totalContracts} contracts ok, ${summary.healthyBuilds}/${summary.totalBuilds} builds ok, shortest TTL: ${summary.shortestDaysLeft ?? 'n/a'} days (${summary.shortestLedgersLeft ?? 'n/a'} ledgers).`);
    }
    console.log(status.ok ? 'The fixture is all right.' : 'The fixture needs attention: see docs/RECOVERY.md.');
  }
  return status.ok ? 0 : 1;
}

if (process.argv[1] !== undefined && import.meta.url === pathToFileURL(process.argv[1]).href) {
  process.exitCode = await main(process.argv.slice(2));
}
