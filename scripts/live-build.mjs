#!/usr/bin/env node
// Says which build each contract in the config is running right now, using only the RPC.
//
// The integration tests upgrade the fixture to v2 and back, and the browser demo and the Wasmward README
// both expect v1. After a test run that was interrupted halfway, the fixture can be left on v2. This shows
// that at a glance, and with --expect it fails when the fixture is not on the build you expect.
//
//   node scripts/live-build.mjs [--config fixture.wasmward.json] [--expect v1] [--json] [--rpc-url URL]
//
// --expect takes a label from the config. --timeout-ms is how long to wait for one answer (default 15000).
//
// With --json it prints one JSON object: { ok, contracts: [{ name, contractId, ok, live, label?, wasmHash?,
// message }] }, where `live` is 'supported' (its hash is on the list), 'unknown' (it is not), 'missing' (no
// instance entry), or 'stellar-asset'.
//
// Exit codes: 0 every contract runs a listed build (and the expected one, with --expect), 1 one runs an unlisted
// build, a different one than expected, or is missing, 2 the config or the RPC could not be used.
// No dependencies; needs Node 18 or newer. Nothing secret is read.
import { readFileSync } from 'node:fs';
import { pathToFileURL } from 'node:url';
import { parseRpcUrl, parseTimeout, valueAfter } from './cli-options.mjs';
import { parseInstanceEntry } from './instance-entry.mjs';
import { instanceKeyXdr } from './ledger-keys.mjs';
import { rpcLookup } from './rpc.mjs';

/** Reads the command line. Throws an Error whose message says what is wrong. */
export function parseArgs(argv) {
  const options = { config: 'fixture.wasmward.json', json: false, timeoutMs: 15_000 };
  for (let i = 0; i < argv.length; i += 1) {
    const flag = argv[i];
    if (flag === '--config') options.config = valueAfter(argv, i++, flag);
    else if (flag === '--expect') options.expect = valueAfter(argv, i++, flag);
    else if (flag === '--rpc-url') options.rpcUrl = parseRpcUrl(valueAfter(argv, i++, flag));
    else if (flag === '--timeout-ms') options.timeoutMs = parseTimeout(valueAfter(argv, i++, flag));
    else if (flag === '--json') options.json = true;
    else throw new Error(`unknown option ${flag}`);
  }
  return options;
}

/**
 * Judges the answer of getLedgerEntries for one contract's instance against its supported builds and, if given,
 * the label that is expected. Returns { ok, live, label?, wasmHash?, message }.
 */
export function judgeLive(name, contractId, result, supported, expect) {
  const who = `${name} ${contractId.slice(0, 8)}...`;
  const entry = Array.isArray(result?.entries) ? result.entries[0] : undefined;
  if (entry === undefined) return { ok: false, live: 'missing', message: `${who}  instance not found (expired and archived, or never deployed)` };

  const parsed = parseInstanceEntry(entry.xdr);
  if (parsed.kind === 'stellar-asset') return { ok: false, live: 'stellar-asset', message: `${who}  is a Stellar Asset Contract, which has no Wasm` };

  const { wasmHash } = parsed;
  const known = supported.find((build) => String(build.wasmHash).toLowerCase() === wasmHash);
  if (known === undefined) {
    return { ok: false, live: 'unknown', wasmHash, message: `${who}  runs ${wasmHash}, which is not on the supported list` };
  }
  const label = known.label ?? 'unlabelled';
  if (expect !== undefined && label !== expect) {
    return { ok: false, live: 'supported', label, wasmHash, message: `${who}  runs ${label} (${wasmHash.slice(0, 8)}...), expected ${expect}` };
  }
  return { ok: true, live: 'supported', label, wasmHash, message: `${who}  runs ${label} (${wasmHash.slice(0, 8)}...)` };
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

  const rpcUrl = options.rpcUrl ?? config?.network?.rpcUrl;
  const entries = Object.entries(config?.contracts ?? {}).filter(([, contract]) => typeof contract?.contractId === 'string');
  if (typeof rpcUrl !== 'string' || entries.length === 0) {
    console.error('error: the config has no network.rpcUrl or no contract with a contractId');
    return 2;
  }
  if (options.expect !== undefined) {
    const labels = entries.flatMap(([, contract]) => (contract.supported ?? []).map((build) => build.label));
    if (!labels.includes(options.expect)) {
      console.error(`error: --expect ${options.expect} is not a label in the config (${labels.filter((label) => label !== undefined).join(', ')})`);
      return 2;
    }
  }

  const contracts = [];
  let failed = false;
  try {
    for (const [name, contract] of entries) {
      const result = await rpcLookup(rpcUrl, instanceKeyXdr(contract.contractId), { timeoutMs: options.timeoutMs });
      const verdict = judgeLive(name, contract.contractId, result, contract.supported ?? [], options.expect);
      if (!verdict.ok) failed = true;
      if (!options.json) console.log(verdict.message);
      contracts.push({ name, contractId: contract.contractId, ...verdict });
    }
  } catch (error) {
    console.error(`error: ${error.message}`);
    return 2;
  }
  if (options.json) console.log(JSON.stringify({ ok: !failed, contracts }));
  return failed ? 1 : 0;
}

if (process.argv[1] !== undefined && import.meta.url === pathToFileURL(process.argv[1]).href) {
  process.exitCode = await main(process.argv.slice(2));
}
