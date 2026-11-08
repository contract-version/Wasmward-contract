#!/usr/bin/env node
// Records what testnet says about the deployed fixture, in the form the backend's replay tests serve: the instance
// entry, the network, and the Wasm code entry of v1. After a redeploy the backend's test/fixtures/recorded/testnet-v1.json
// has to be recorded again, because it names the old contract, and this does it from the live network instead of by hand.
//
//   node scripts/record-testnet.mjs [--config fixture.wasmward.json] [--out FILE] [--rpc-url URL] [--timeout-ms N]
//
// --out defaults to ../Wasmward-backend/test/fixtures/recorded/testnet-v1.json. Only reads: no transaction is sent and no
// key is used. It refuses to write a recording of a fixture that is missing, expired, runs a build other than v1, or
// whose code is missing, because the replay tests expect to see a healthy v1.
//
// Exit codes: 0 recorded, 1 the fixture is not in the state the recording must show (nothing written), 2 the config or
// the RPC could not be used. No dependencies; needs Node 18 or newer.
import { readFileSync, writeFileSync } from 'node:fs';
import { pathToFileURL } from 'node:url';
import { parseRpcUrl, parseTimeout, valueAfter } from './cli-options.mjs';
import { helpFromHeader, wantsHelp } from './help.mjs';
import { parseInstanceEntry } from './instance-entry.mjs';
import { codeKeyXdr, instanceKeyXdr } from './ledger-keys.mjs';
import { pinnedFrom } from './sync-siblings.mjs';

const DEFAULT_OUT = '../Wasmward-backend/test/fixtures/recorded/testnet-v1.json';

/** Reads the command line. Throws an Error whose message says what is wrong. */
export function parseArgs(argv) {
  const options = { config: 'fixture.wasmward.json', out: DEFAULT_OUT, timeoutMs: 15_000 };
  for (let i = 0; i < argv.length; i += 1) {
    const flag = argv[i];
    if (flag === '--config') options.config = valueAfter(argv, i++, flag);
    else if (flag === '--out') options.out = valueAfter(argv, i++, flag);
    else if (flag === '--rpc-url') options.rpcUrl = parseRpcUrl(valueAfter(argv, i++, flag));
    else if (flag === '--timeout-ms') options.timeoutMs = parseTimeout(valueAfter(argv, i++, flag));
    else throw new Error(`unknown option ${flag}`);
  }
  return options;
}

/** Wraps a JSON-RPC result the way an RPC answers, which is the way the replay tests serve it. */
const answer = (result) => ({ jsonrpc: '2.0', id: 1, result });

/**
 * Builds the recording. `asks` is { instance, network, code }: three functions that return the RPC's `result` for the
 * instance entry, `getNetwork` and v1's code entry. Throws an Error naming what is wrong with the fixture if it is not
 * a healthy v1, so that nothing is recorded from a broken one.
 */
export async function buildRecording(pinned, asks, now = () => new Date().toISOString()) {
  const recordedAt = now();
  const instance = await asks.instance();
  const entry = instance?.entries?.[0];
  if (entry === undefined) throw new Error('the instance entry was not found (expired and archived, or never deployed)');
  if (!(entry.liveUntilLedgerSeq >= instance.latestLedger)) throw new Error('the instance has expired');
  const live = parseInstanceEntry(entry.xdr);
  if (live.kind !== 'wasm' || live.wasmHash !== pinned.v1Hash) {
    throw new Error(`the instance runs ${live.kind === 'wasm' ? live.wasmHash : 'a Stellar Asset Contract'}, not v1 (${pinned.v1Hash})`);
  }
  const network = await asks.network();
  const codeRecordedAt = now();
  const code = await asks.code();
  const codeEntry = code?.entries?.[0];
  if (codeEntry === undefined) throw new Error("v1's Wasm code entry was not found (expired and archived, or never uploaded)");
  if (!(codeEntry.liveUntilLedgerSeq >= code.latestLedger)) throw new Error("v1's Wasm code has expired");
  return {
    recordedAt,
    contractId: pinned.contractId,
    expectedWasmHash: pinned.v1Hash,
    getLedgerEntries: answer(instance),
    getNetwork: answer(network),
    getCodeEntries: answer(code),
    codeRecordedAt,
  };
}

/** A JSON-RPC call over fetch. Returns the `result`; throws an Error that says what went wrong. */
async function call(rpcUrl, timeoutMs, method, params) {
  let response;
  try {
    response = await fetch(rpcUrl, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ jsonrpc: '2.0', id: 1, method, ...(params === undefined ? {} : { params }) }),
      signal: AbortSignal.timeout(timeoutMs),
    });
  } catch (cause) {
    throw new Error(`could not reach the RPC: ${cause.name === 'TimeoutError' ? `no answer within ${timeoutMs}ms` : cause.message}`);
  }
  if (!response.ok) throw new Error(`the RPC answered HTTP ${response.status} to ${method}`);
  const body = await response.json();
  if (body?.error !== undefined) throw new Error(`the RPC returned an error to ${method}: ${body.error.message ?? JSON.stringify(body.error)}`);
  if (body?.result === undefined) throw new Error(`the RPC answered ${method} without a result`);
  return body.result;
}

/** Errors that mean the RPC or the config could not be used, as opposed to the fixture not being healthy. */
class UsageError extends Error {}

async function main(argv) {
  if (wantsHelp(argv)) {
    console.log(helpFromHeader(import.meta.url));
    return 0;
  }
  let options;
  let config;
  let pinned;
  try {
    options = parseArgs(argv);
    config = JSON.parse(readFileSync(options.config, 'utf8'));
    pinned = pinnedFrom(config);
  } catch (error) {
    console.error(`error: ${error.message}`);
    return 2;
  }
  const rpcUrl = options.rpcUrl ?? config?.network?.rpcUrl;
  if (typeof rpcUrl !== 'string') {
    console.error('error: the config has no network.rpcUrl');
    return 2;
  }

  const guarded = (fn) => async () => {
    try {
      return await fn();
    } catch (error) {
      throw new UsageError(error.message);
    }
  };
  const asks = {
    instance: guarded(() => call(rpcUrl, options.timeoutMs, 'getLedgerEntries', { keys: [instanceKeyXdr(pinned.contractId)] })),
    network: guarded(() => call(rpcUrl, options.timeoutMs, 'getNetwork')),
    code: guarded(() => call(rpcUrl, options.timeoutMs, 'getLedgerEntries', { keys: [codeKeyXdr(pinned.v1Hash)] })),
  };
  let recording;
  try {
    recording = await buildRecording(pinned, asks);
  } catch (error) {
    console.error(`error: ${error.message}`);
    return error instanceof UsageError ? 2 : 1;
  }
  writeFileSync(options.out, `${JSON.stringify(recording, null, 2)}\n`);
  console.log(`Recorded ${pinned.contractId.slice(0, 8)}... (v1 ${pinned.v1Hash.slice(0, 8)}...) to ${options.out}`);
  return 0;
}

if (process.argv[1] !== undefined && import.meta.url === pathToFileURL(process.argv[1]).href) {
  process.exitCode = await main(process.argv.slice(2));
}
