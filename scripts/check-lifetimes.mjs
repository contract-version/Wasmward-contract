#!/usr/bin/env node
// Checks how long the fixture has left on the network: the instance of each contract that has a contractId
// in the config, and the Wasm code of every supported build.
//
// Wasmward itself checks the instance and the code of the build that is live now. It cannot see the other
// build: the upgrade tests move the fixture from v1 to v2, and if v2's code entry has expired by then the
// upgrade fails. This reads the code entry of every build listed in the config, using only the RPC, and the
// instance too, so it can be used without Wasmward.
//
//   node scripts/check-lifetimes.mjs [--config fixture.wasmward.json] [--min-days 3] [--warn-ledgers N]
//                                    [--json] [--markdown] [--verbose] [--rpc-url URL] [--timeout-ms N]
//                                    [--retries N]
//
// --rpc-url asks that RPC instead of the one in the config. --timeout-ms is how long to wait for one answer
// (default 15000); a timeout, a 5xx or a 429 is tried once more before giving up (or --retries times).
//
// With --json it prints one JSON object instead of text: { ok, minDays, contracts: [{ name, contractId, ok,
// ledgersLeft?, daysLeft?, message }], builds: [{ label, wasmHash, ok, ledgersLeft?, daysLeft?, message }] },
// and the exit code means the same.
//
// Exit codes: 0 all builds have at least --min-days left, 1 one is missing or too close to expiring,
// 2 the config or the RPC could not be used. No dependencies; needs Node 18 or newer. Nothing secret is read.
import { readFileSync } from 'node:fs';
import { pathToFileURL } from 'node:url';
import { parseRetries, parseRpcUrl, parseTimeout, valueAfter } from './cli-options.mjs';
import { codeKeyXdr, instanceKeyXdr } from './ledger-keys.mjs';
import { rpcLookup } from './rpc.mjs';
import { helpFromHeader, wantsHelp } from './help.mjs';

export { codeKeyXdr, rpcLookup };

const SECONDS_PER_LEDGER = 5;

/** Whole days, rounded down, that a number of ledgers lasts at about 5 seconds each. */
export function daysFor(ledgers) {
  return Math.floor((ledgers * SECONDS_PER_LEDGER) / 86_400);
}

/**
 * Judges one ledger entry from an RPC `getLedgerEntries` result. `noun` names it in the text ("Wasm code",
 * "contract instance") and `neverMade` says how it could be missing without having expired.
 * Returns { ok, text, ledgersLeft? }. A missing entry, or one the RPC gave no lifetime for, is never ok.
 */
function judgeEntry(name, noun, neverMade, result, minDays, { warnLedgers, verbose = false } = {}) {
  const entry = Array.isArray(result?.entries) ? result.entries[0] : undefined;
  if (entry === undefined) return { ok: false, text: `${name}  ${noun} not found (expired and archived, or ${neverMade}); if it expired, bash scripts/extend.sh restores it` };
  const until = entry.liveUntilLedgerSeq;
  const latest = result.latestLedger;
  if (!Number.isFinite(until) || !Number.isFinite(latest)) {
    return { ok: false, text: `${name}  the RPC did not say when the ${noun} expires, so expiry cannot be ruled out` };
  }
  const left = until - latest;
  if (left < 0) return { ok: false, text: `${name}  ${noun} has expired (archived): bash scripts/extend.sh restores and extends it`, ledgersLeft: left };
  const days = daysFor(left);
  const tooClose = left * SECONDS_PER_LEDGER < minDays * 86_400;
  const underWarn = !tooClose && warnLedgers !== undefined && left < warnLedgers;
  const suffix = tooClose
    ? `: under the ${minDays}-day minimum`
    : underWarn
      ? `: under the ${warnLedgers}-ledger warning threshold (${left} ledgers left)`
      : '';
  const detail = verbose ? ` (${left} ledgers left, until #${until})` : '';
  return {
    ok: !tooClose && !underWarn,
    ledgersLeft: left,
    ...(underWarn ? { warning: true } : {}),
    text: `${name}  ${noun} lives about ${days} more days${detail}${suffix}`,
  };
}

/** Judges the Wasm code entry of one build. */
export function judge(label, wasmHash, result, minDays, extra) {
  return judgeEntry(`${label} ${wasmHash.slice(0, 8)}...`, 'Wasm code', 'never uploaded', result, minDays, extra);
}

/** Judges the instance entry of one contract. */
export function judgeInstance(name, contractId, result, minDays, extra) {
  return judgeEntry(`${name} ${contractId.slice(0, 8)}...`, 'contract instance', 'never deployed', result, minDays, extra);
}

/** Computes summary statistics across contract instance and Wasm code lifetime entries. */
export function summarizeLifetimes(contracts = [], builds = []) {
  const all = [...contracts, ...builds];
  const ledgers = all.map((e) => e.ledgersLeft).filter((n) => typeof n === 'number');
  const shortestLedgersLeft = ledgers.length > 0 ? Math.min(...ledgers) : null;
  const longestLedgersLeft = ledgers.length > 0 ? Math.max(...ledgers) : null;
  return {
    totalEntries: all.length,
    okEntries: all.filter((e) => e.ok).length,
    failingEntries: all.filter((e) => !e.ok).length,
    shortestLedgersLeft,
    shortestDaysLeft: shortestLedgersLeft === null ? null : daysFor(Math.max(0, shortestLedgersLeft)),
    longestLedgersLeft,
    longestDaysLeft: longestLedgersLeft === null ? null : daysFor(Math.max(0, longestLedgersLeft)),
  };
}

/** Renders the lifetime check report as a GitHub-Flavored Markdown document. */
export function renderMarkdownLifetimes({ ok, minDays, warnLedgers, contracts = [], builds = [] }) {
  const summary = summarizeLifetimes(contracts, builds);
  const lines = [
    '# Lifetime Check Report',
    '',
    `**Status:** ${ok ? 'OK' : 'ATTENTION NEEDED'} | **Minimum Days:** ${minDays}${warnLedgers !== undefined ? ` | **Warn Ledgers:** ${warnLedgers}` : ''}`,
    '',
  ];
  if (contracts.length > 0) {
    lines.push('## Contract Instances', '', '| Contract | Address | Status | Days Left | Ledgers Left |', '|---|---|---|---|---|');
    for (const c of contracts) {
      lines.push(`| \`${c.name}\` | \`${c.contractId.slice(0, 8)}...\` | ${c.ok ? 'OK' : 'LOW/MISSING'} | ${c.daysLeft ?? 'n/a'} | ${c.ledgersLeft ?? 'n/a'} |`);
    }
    lines.push('');
  }
  lines.push('## Supported Builds', '', '| Label | Wasm Hash | Status | Days Left | Ledgers Left |', '|---|---|---|---|---|');
  for (const b of builds) {
    lines.push(`| \`${b.label}\` | \`${b.wasmHash.slice(0, 12)}...\` | ${b.ok ? 'OK' : 'LOW/MISSING'} | ${b.daysLeft ?? 'n/a'} | ${b.ledgersLeft ?? 'n/a'} |`);
  }
  lines.push('', `**Summary:** ${summary.okEntries}/${summary.totalEntries} entries healthy, shortest TTL: ${summary.shortestDaysLeft ?? 'n/a'} days.`);
  return lines;
}

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
    } else if (flag === '--rpc-url') options.rpcUrl = parseRpcUrl(valueAfter(argv, i++, flag));
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

  // --rpc-url wins over the config, for trying another provider without editing the file.
  const rpcUrl = options.rpcUrl ?? config?.network?.rpcUrl;
  const builds = Object.values(config?.contracts ?? {}).flatMap((contract) => contract.supported ?? []);
  if (typeof rpcUrl !== 'string' || builds.length === 0) {
    console.error('error: the config has no network.rpcUrl or no supported builds');
    return 2;
  }

  let failed = false;
  /** Prints a verdict (unless --json or --markdown) and turns it into a report entry. */
  const record = (verdict, fields) => {
    if (!options.json && !options.markdown) console.log(verdict.text);
    if (!verdict.ok) failed = true;
    const entry = { ...fields, ok: verdict.ok, message: verdict.text };
    if (verdict.ledgersLeft !== undefined) {
      entry.ledgersLeft = verdict.ledgersLeft;
      entry.daysLeft = daysFor(Math.max(0, verdict.ledgersLeft));
    }
    return entry;
  };

  // The instance of each contract that has an address, then the Wasm code of every build.
  const buildReports = [];
  const contracts = [];
  const rpcOptions = { timeoutMs: options.timeoutMs, retries: options.retries };
  const judgeExtras = { warnLedgers: options.warnLedgers, verbose: Boolean(options.verbose) };
  try {
    for (const [name, contract] of Object.entries(config?.contracts ?? {})) {
      if (contract.contractId === undefined) continue;
      const result = await rpcLookup(rpcUrl, instanceKeyXdr(contract.contractId), rpcOptions);
      const verdict = judgeInstance(name, contract.contractId, result, options.minDays, judgeExtras);
      contracts.push(record(verdict, { name, contractId: contract.contractId }));
    }
    for (const build of builds) {
      const result = await rpcLookup(rpcUrl, codeKeyXdr(build.wasmHash), rpcOptions);
      const verdict = judge(build.label ?? 'build', build.wasmHash, result, options.minDays, judgeExtras);
      buildReports.push(record(verdict, { label: build.label ?? 'build', wasmHash: build.wasmHash }));
    }
  } catch (error) {
    console.error(`error: ${error.message}`);
    return 2;
  }
  const summary = summarizeLifetimes(contracts, buildReports);
  if (options.json) {
    console.log(JSON.stringify({
      ok: !failed,
      minDays: options.minDays,
      ...(options.warnLedgers === undefined ? {} : { warnLedgers: options.warnLedgers }),
      ...(options.verbose ? { summary } : {}),
      contracts,
      builds: buildReports,
    }));
  } else if (options.markdown) {
    console.log(renderMarkdownLifetimes({ ok: !failed, minDays: options.minDays, warnLedgers: options.warnLedgers, contracts, builds: buildReports }).join('\n'));
  } else if (options.verbose) {
    console.log(`Summary: ${summary.okEntries}/${summary.totalEntries} entries ok, shortest TTL: ${summary.shortestDaysLeft ?? 'n/a'} days (${summary.shortestLedgersLeft ?? 'n/a'} ledgers).`);
  }
  return failed ? 1 : 0;
}

if (process.argv[1] !== undefined && import.meta.url === pathToFileURL(process.argv[1]).href) {
  process.exitCode = await main(process.argv.slice(2));
}
