#!/usr/bin/env node
// Checks how long the Wasm code of every supported build of the fixture has left on the network.
//
// Wasmward itself checks the instance and the code of the build that is live now. It cannot see the other
// build: the upgrade tests move the fixture from v1 to v2, and if v2's code entry has expired by then the
// upgrade fails. This reads the code entry of every build listed in the config, using only the RPC.
//
//   node scripts/check-lifetimes.mjs [--config fixture.wasmward.json] [--min-days 3]
//
// Exit codes: 0 all builds have at least --min-days left, 1 one is missing or too close to expiring,
// 2 the config or the RPC could not be used. No dependencies; needs Node 18 or newer. Nothing secret is read.
import { readFileSync } from 'node:fs';
import { pathToFileURL } from 'node:url';

const SECONDS_PER_LEDGER = 5;

/** The base64 XDR ledger key for the code entry of a Wasm hash: key type CONTRACT_CODE (7), then the 32-byte hash. */
export function codeKeyXdr(wasmHash) {
  if (!/^[0-9a-f]{64}$/.test(wasmHash)) throw new Error(`not a 64-character lowercase hex Wasm hash: ${wasmHash}`);
  return Buffer.concat([Buffer.from([0, 0, 0, 7]), Buffer.from(wasmHash, 'hex')]).toString('base64');
}

/** Whole days, rounded down, that a number of ledgers lasts at about 5 seconds each. */
export function daysFor(ledgers) {
  return Math.floor((ledgers * SECONDS_PER_LEDGER) / 86_400);
}

/**
 * Judges one build from an RPC `getLedgerEntries` result for its code key.
 * Returns { ok, text }. A missing entry, or one the RPC gave no lifetime for, is never ok.
 */
export function judge(label, wasmHash, result, minDays) {
  const name = `${label} ${wasmHash.slice(0, 8)}...`;
  const entry = Array.isArray(result?.entries) ? result.entries[0] : undefined;
  if (entry === undefined) return { ok: false, text: `${name}  Wasm code not found (expired and archived, or never uploaded)` };
  const until = entry.liveUntilLedgerSeq;
  const latest = result.latestLedger;
  if (!Number.isFinite(until) || !Number.isFinite(latest)) {
    return { ok: false, text: `${name}  the RPC did not say when the Wasm code expires, so expiry cannot be ruled out` };
  }
  const left = until - latest;
  if (left < 0) return { ok: false, text: `${name}  Wasm code has expired` };
  const days = daysFor(left);
  const tooClose = left * SECONDS_PER_LEDGER < minDays * 86_400;
  return {
    ok: !tooClose,
    text: `${name}  Wasm code lives about ${days} more days${tooClose ? `: under the ${minDays}-day minimum` : ''}`,
  };
}

function parseArgs(argv) {
  const options = { config: 'fixture.wasmward.json', minDays: 3 };
  for (let i = 0; i < argv.length; i += 1) {
    const flag = argv[i];
    if (flag === '--config') options.config = argv[++i];
    else if (flag === '--min-days') options.minDays = Number(argv[++i]);
    else throw new Error(`unknown option ${flag}`);
  }
  if (typeof options.config !== 'string' || options.config === '') throw new Error('--config needs a file');
  if (!Number.isFinite(options.minDays) || options.minDays < 0) throw new Error('--min-days must be a number of days, 0 or more');
  return options;
}

async function rpcLookup(rpcUrl, key) {
  const response = await fetch(rpcUrl, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'getLedgerEntries', params: { keys: [key] } }),
    signal: AbortSignal.timeout(15_000),
  });
  if (!response.ok) throw new Error(`the RPC answered HTTP ${response.status}`);
  const body = await response.json();
  if (body.error !== undefined) throw new Error(`the RPC returned an error: ${body.error.message ?? JSON.stringify(body.error)}`);
  return body.result;
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

  const rpcUrl = config?.network?.rpcUrl;
  const builds = Object.values(config?.contracts ?? {}).flatMap((contract) => contract.supported ?? []);
  if (typeof rpcUrl !== 'string' || builds.length === 0) {
    console.error('error: the config has no network.rpcUrl or no supported builds');
    return 2;
  }

  let failed = false;
  for (const build of builds) {
    let verdict;
    try {
      verdict = judge(build.label ?? 'build', build.wasmHash, await rpcLookup(rpcUrl, codeKeyXdr(build.wasmHash)), options.minDays);
    } catch (error) {
      console.error(`error: ${error.message}`);
      return 2;
    }
    console.log(verdict.text);
    if (!verdict.ok) failed = true;
  }
  return failed ? 1 : 0;
}

if (process.argv[1] !== undefined && import.meta.url === pathToFileURL(process.argv[1]).href) {
  process.exitCode = await main(process.argv.slice(2));
}
