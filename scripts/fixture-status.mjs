#!/usr/bin/env node
// One command for "is the fixture all right?": which build is live, and how long the instance and the Wasm code
// of every supported build have left. It is check-lifetimes.mjs and live-build.mjs together, asking the RPC for
// each contract's instance once instead of twice.
//
//   node scripts/fixture-status.mjs [--config fixture.wasmward.json] [--min-days 3] [--expect v1] [--json]
//                                   [--rpc-url URL] [--timeout-ms N]
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
import { parseRpcUrl, parseTimeout, valueAfter } from './cli-options.mjs';
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
    else if (flag === '--expect') options.expect = valueAfter(argv, i++, flag);
    else if (flag === '--rpc-url') options.rpcUrl = parseRpcUrl(valueAfter(argv, i++, flag));
    else if (flag === '--timeout-ms') options.timeoutMs = parseTimeout(valueAfter(argv, i++, flag));
    else if (flag === '--json') options.json = true;
    else throw new Error(`unknown option ${flag}`);
  }
  if (!Number.isFinite(options.minDays) || options.minDays < 0) throw new Error('--min-days must be a number of days, 0 or more');
  return options;
}

/**
 * The verdicts for a config, given a function that asks the RPC for one ledger key. Returns
 * { ok, contracts, builds }. Throws if an answer is not what an RPC gives, so the caller can exit 2.
 */
export async function statusOf(config, options, lookup) {
  const contracts = [];
  const builds = [];
  let ok = true;

  for (const [name, contract] of Object.entries(config.contracts ?? {})) {
    if (typeof contract?.contractId !== 'string') continue;
    const result = await lookup(instanceKeyXdr(contract.contractId));
    const instance = judgeInstance(name, contract.contractId, result, options.minDays);
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
      const verdict = judge(label, build.wasmHash, await lookup(codeKeyXdr(build.wasmHash)), options.minDays);
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
    status = await statusOf(config, options, (key) => rpcLookup(rpcUrl, key, { timeoutMs: options.timeoutMs }));
  } catch (error) {
    console.error(`error: ${error.message}`);
    return 2;
  }
  if (options.json) {
    console.log(JSON.stringify({ ok: status.ok, minDays: options.minDays, contracts: status.contracts, builds: status.builds }));
  } else {
    for (const contract of status.contracts) {
      console.log(contract.live.message);
      console.log(contract.instance.message);
    }
    for (const build of status.builds) console.log(build.message);
    console.log(status.ok ? 'The fixture is all right.' : 'The fixture needs attention: see docs/RECOVERY.md.');
  }
  return status.ok ? 0 : 1;
}

if (process.argv[1] !== undefined && import.meta.url === pathToFileURL(process.argv[1]).href) {
  process.exitCode = await main(process.argv.slice(2));
}
