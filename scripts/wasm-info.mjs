#!/usr/bin/env node
// Shows what is inside a Wasm file: its size, hash, the compiler and SDK versions it was built with, and its
// sections. It exists to explain why two builds of the same source have different hashes.
//
//   node scripts/wasm-info.mjs <target>
//   node scripts/wasm-info.mjs <target> <target>       compare two
//
// A target is a file, or deployed:<hash> to read the Wasm of that hash from the network. For that, give
// [--rpc-url URL] or [--config FILE] (default fixture.wasmward.json, whose network is used) and optionally
// [--timeout-ms N]. The bytes that come back are checked: their SHA-256 must be the hash that was asked for.
//
// With one target it describes it. With two it compares them and says how they differ, which answers
// "why does my build have a different hash from the deployed one?".
//
// Exit codes: for one target, 0 shown. For two, like diff: 0 the same Wasm, 1 different. Always 2 when a
// target could not be read or is not what it should be. No dependencies; needs Node 18 or newer. Only a
// deployed: target talks to the network, and then only to read.
import { readFileSync } from 'node:fs';
import { pathToFileURL } from 'node:url';
import { parseRpcUrl, parseTimeout, valueAfter } from './cli-options.mjs';
import { codeKeyXdr } from './ledger-keys.mjs';
import { rpcLookup } from './rpc.mjs';
import { parseCodeEntry } from './wasm-code.mjs';
import { compareReport } from './wasm-compare.mjs';
import { metaValue, readWasm, sectionLabel } from './wasm-sections.mjs';

export { sectionLabel };

/** The lines that describe one module. `name` is what the user asked about, such as a file name. */
export function describe(name, info) {
  const lines = [name];
  const row = (label, value) => lines.push(`  ${label.padEnd(10)}${value}`);
  row('size', `${info.size} bytes`);
  row('sha256', info.sha256);
  row('compiler', metaValue(info, 'rsver') ?? '(not recorded)');
  row('sdk', metaValue(info, 'rssdkver') ?? '(not recorded)');
  row('cli', metaValue(info, 'cliver') ?? '(none: not processed by the Stellar CLI)');
  row('interface', info.interface === undefined ? '(not recorded)' : `protocol ${info.interface.protocol}`);
  row('sections', info.sections.map((s) => `${sectionLabel(s)} ${s.size}`).join(', '));
  return lines;
}

const HASH = /^[0-9a-f]{64}$/;

/** Reads the command line. Throws an Error whose message says what is wrong. */
export function parseArgs(argv) {
  const options = { targets: [], config: 'fixture.wasmward.json', timeoutMs: 15_000 };
  for (let i = 0; i < argv.length; i += 1) {
    const word = argv[i];
    if (word === '--config') options.config = valueAfter(argv, i++, word);
    else if (word === '--rpc-url') options.rpcUrl = parseRpcUrl(valueAfter(argv, i++, word));
    else if (word === '--timeout-ms') options.timeoutMs = parseTimeout(valueAfter(argv, i++, word));
    else if (word.startsWith('--')) throw new Error(`unknown option ${word}`);
    else options.targets.push(parseTarget(word));
  }
  if (options.targets.length === 0) throw new Error('give the Wasm to look at: a file, or deployed:<wasm hash>');
  if (options.targets.length > 2) throw new Error('give one target to look at, or two to compare');
  return options;
}

/** A word on the command line as a target: { kind: 'deployed', hash } or { kind: 'file', path }. */
export function parseTarget(word) {
  if (!word.startsWith('deployed:')) return { kind: 'file', path: word };
  const hash = word.slice('deployed:'.length);
  if (!HASH.test(hash)) throw new Error(`deployed: needs a Wasm hash of 64 lowercase hex characters, not '${hash}'`);
  return { kind: 'deployed', hash };
}

/** The RPC to ask: --rpc-url, else the network of the config file. Throws an Error that says what to do. */
export function rpcUrlFor(options, readConfig = (path) => readFileSync(path, 'utf8')) {
  if (options.rpcUrl !== undefined) return options.rpcUrl;
  let url;
  try {
    url = JSON.parse(readConfig(options.config))?.network?.rpcUrl;
  } catch {
    throw new Error(`no RPC to ask: give --rpc-url, or --config with a network (could not read ${options.config})`);
  }
  if (typeof url !== 'string') throw new Error(`no RPC to ask: ${options.config} has no network.rpcUrl`);
  return url;
}

/**
 * Loads a target as { name, info }. A file is read from disk. A deployed hash is read from the RPC, and
 * refused unless the code that comes back really has that hash. Throws an Error that says what went wrong.
 */
export async function load(target, options) {
  if (target.kind === 'file') return { name: target.path, info: readWasm(readFileSync(target.path)) };

  const result = await rpcLookup(rpcUrlFor(options), codeKeyXdr(target.hash), { timeoutMs: options.timeoutMs });
  const entry = Array.isArray(result.entries) ? result.entries[0] : undefined;
  if (entry === undefined) throw new Error(`the network has no Wasm with hash ${target.hash} (expired and archived, or never uploaded)`);
  const parsed = parseCodeEntry(entry.xdr);
  if (parsed.hash !== target.hash || !parsed.hashMatches) {
    throw new Error(`the RPC returned code that does not have hash ${target.hash}, so it is not shown`);
  }
  return { name: `deployed:${target.hash.slice(0, 8)}...`, info: readWasm(parsed.code) };
}

async function main(argv) {
  let options;
  try {
    options = parseArgs(argv);
  } catch (error) {
    console.error(`error: ${error.message}`);
    return 2;
  }
  const loaded = [];
  for (const target of options.targets) {
    try {
      loaded.push(await load(target, options));
    } catch (error) {
      console.error(`error: ${target.kind === 'file' ? `${target.path}: ` : ''}${error.message}`);
      return 2;
    }
  }
  if (loaded.length === 1) {
    console.log(describe(loaded[0].name, loaded[0].info).join('\n'));
    return 0;
  }
  const [a, b] = loaded;
  console.log(compareReport(a.name, b.name, a.info, b.info).join('\n'));
  return a.info.sha256 === b.info.sha256 ? 0 : 1;
}

if (process.argv[1] !== undefined && import.meta.url === pathToFileURL(process.argv[1]).href) {
  process.exitCode = await main(process.argv.slice(2));
}
