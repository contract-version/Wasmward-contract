#!/usr/bin/env node
// Checks how long the fixture has left on the network: the instance of each contract that has a contractId
// in the config, and the Wasm code of every supported build.
//
// Wasmward itself checks the instance and the code of the build that is live now. It cannot see the other
// build: the upgrade tests move the fixture from v1 to v2, and if v2's code entry has expired by then the
// upgrade fails. This reads the code entry of every build listed in the config, using only the RPC, and the
// instance too, so it can be used without Wasmward.
//
//   node scripts/check-lifetimes.mjs [--config fixture.wasmward.json] [--min-days 3] [--json] [--rpc-url URL]
//
// --rpc-url asks that RPC instead of the one in the config. --timeout-ms is how long to wait for one answer
// (default 15000); a timeout, a 5xx or a 429 is tried once more before giving up.
//
// With --json it prints one JSON object instead of text: { ok, minDays, contracts: [{ name, contractId, ok,
// ledgersLeft?, daysLeft?, message }], builds: [{ label, wasmHash, ok, ledgersLeft?, daysLeft?, message }] },
// and the exit code means the same.
//
// Exit codes: 0 all builds have at least --min-days left, 1 one is missing or too close to expiring,
// 2 the config or the RPC could not be used. No dependencies; needs Node 18 or newer. Nothing secret is read.
import { readFileSync } from 'node:fs';
import { pathToFileURL } from 'node:url';
import { codeKeyXdr, instanceKeyXdr } from './ledger-keys.mjs';

export { codeKeyXdr };

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
function judgeEntry(name, noun, neverMade, result, minDays) {
  const entry = Array.isArray(result?.entries) ? result.entries[0] : undefined;
  if (entry === undefined) return { ok: false, text: `${name}  ${noun} not found (expired and archived, or ${neverMade})` };
  const until = entry.liveUntilLedgerSeq;
  const latest = result.latestLedger;
  if (!Number.isFinite(until) || !Number.isFinite(latest)) {
    return { ok: false, text: `${name}  the RPC did not say when the ${noun} expires, so expiry cannot be ruled out` };
  }
  const left = until - latest;
  if (left < 0) return { ok: false, text: `${name}  ${noun} has expired`, ledgersLeft: left };
  const days = daysFor(left);
  const tooClose = left * SECONDS_PER_LEDGER < minDays * 86_400;
  return {
    ok: !tooClose,
    ledgersLeft: left,
    text: `${name}  ${noun} lives about ${days} more days${tooClose ? `: under the ${minDays}-day minimum` : ''}`,
  };
}

/** Judges the Wasm code entry of one build. */
export function judge(label, wasmHash, result, minDays) {
  return judgeEntry(`${label} ${wasmHash.slice(0, 8)}...`, 'Wasm code', 'never uploaded', result, minDays);
}

/** Judges the instance entry of one contract. */
export function judgeInstance(name, contractId, result, minDays) {
  return judgeEntry(`${name} ${contractId.slice(0, 8)}...`, 'contract instance', 'never deployed', result, minDays);
}

function parseRpcUrl(text) {
  let url;
  try {
    url = new URL(text);
  } catch {
    throw new Error(`--rpc-url is not a URL: ${text}`);
  }
  if (url.protocol !== 'https:' && url.protocol !== 'http:') throw new Error('--rpc-url must start with https:// or http://');
  return text;
}

/** How long to wait for one answer, in whole milliseconds: from 100 to 120000 (two minutes). */
function parseTimeout(text) {
  const ms = Number(text);
  if (!Number.isInteger(ms) || ms < 100 || ms > 120_000) throw new Error('--timeout-ms must be a whole number from 100 to 120000');
  return ms;
}

/** Reads the command line. Throws an Error whose message says what is wrong. */
export function parseArgs(argv) {
  const options = { config: 'fixture.wasmward.json', minDays: 3, json: false, timeoutMs: 15_000 };
  // The value of an option is the next word, which must exist and must not be another option.
  const valueAfter = (index, flag) => {
    const value = argv[index + 1];
    // An empty value would otherwise read as 0 days and quietly switch the gate off.
    if (value === undefined || value.trim() === '' || value.startsWith('--')) throw new Error(`${flag} needs a value`);
    return value;
  };
  for (let i = 0; i < argv.length; i += 1) {
    const flag = argv[i];
    if (flag === '--config') options.config = valueAfter(i++, flag);
    else if (flag === '--min-days') options.minDays = Number(valueAfter(i++, flag));
    else if (flag === '--rpc-url') options.rpcUrl = parseRpcUrl(valueAfter(i++, flag));
    else if (flag === '--timeout-ms') options.timeoutMs = parseTimeout(valueAfter(i++, flag));
    else if (flag === '--json') options.json = true;
    else throw new Error(`unknown option ${flag}`);
  }
  if (!Number.isFinite(options.minDays) || options.minDays < 0) throw new Error('--min-days must be a number of days, 0 or more');
  return options;
}

/** One attempt. `retryable` on the error says whether trying again could help. */
async function rpcAttempt(rpcUrl, key, timeoutMs) {
  let response;
  try {
    response = await fetch(rpcUrl, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'getLedgerEntries', params: { keys: [key] } }),
      signal: AbortSignal.timeout(timeoutMs),
    });
  } catch (cause) {
    // Network failure or timeout: a second try may well work.
    throw Object.assign(new Error(`could not reach the RPC: ${cause.name === 'TimeoutError' ? `no answer within ${timeoutMs}ms` : cause.message}`), { retryable: true });
  }
  if (!response.ok) {
    throw Object.assign(new Error(`the RPC answered HTTP ${response.status}`), { retryable: response.status >= 500 || response.status === 429 });
  }
  const body = await response.json();
  if (body.error !== undefined) throw new Error(`the RPC returned an error: ${body.error.message ?? JSON.stringify(body.error)}`);
  return body.result;
}

/**
 * Asks the RPC for one ledger entry. A busy or briefly unreachable RPC is tried again (default: once more,
 * after half a second); an answer that is wrong is not, because asking again would not change it.
 */
export async function rpcLookup(rpcUrl, key, { timeoutMs = 15_000, retries = 1, delayMs = 500 } = {}) {
  for (let attempt = 0; ; attempt += 1) {
    try {
      return await rpcAttempt(rpcUrl, key, timeoutMs);
    } catch (error) {
      if (!error.retryable || attempt >= retries) throw error;
      await new Promise((resolve) => setTimeout(resolve, delayMs));
    }
  }
}

async function main(argv) {
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
  /** Prints a verdict (unless --json) and turns it into a report entry. */
  const record = (verdict, fields) => {
    if (!options.json) console.log(verdict.text);
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
  const timeoutMs = options.timeoutMs;
  try {
    for (const [name, contract] of Object.entries(config?.contracts ?? {})) {
      if (contract.contractId === undefined) continue;
      const result = await rpcLookup(rpcUrl, instanceKeyXdr(contract.contractId), { timeoutMs });
      const verdict = judgeInstance(name, contract.contractId, result, options.minDays);
      contracts.push(record(verdict, { name, contractId: contract.contractId }));
    }
    for (const build of builds) {
      const result = await rpcLookup(rpcUrl, codeKeyXdr(build.wasmHash), { timeoutMs });
      const verdict = judge(build.label ?? 'build', build.wasmHash, result, options.minDays);
      buildReports.push(record(verdict, { label: build.label ?? 'build', wasmHash: build.wasmHash }));
    }
  } catch (error) {
    console.error(`error: ${error.message}`);
    return 2;
  }
  if (options.json) console.log(JSON.stringify({ ok: !failed, minDays: options.minDays, contracts, builds: buildReports }));
  return failed ? 1 : 0;
}

if (process.argv[1] !== undefined && import.meta.url === pathToFileURL(process.argv[1]).href) {
  process.exitCode = await main(process.argv.slice(2));
}
