#!/usr/bin/env node
// Shows what is inside a Wasm file: its size, hash, the compiler and SDK versions it was built with, and its
// sections. It exists to explain why two builds of the same source have different hashes.
//
//   node scripts/wasm-info.mjs <target> [--json] [--markdown] [--verbose]
//   node scripts/wasm-info.mjs <target> <target> [--json] [--markdown] [--verbose]       compare two
//
// A target is a file, or deployed:<hash> to read the Wasm of that hash from the network. For that, give
// [--rpc-url URL] or [--config FILE] (default fixture.wasmward.json, whose network is used) and optionally
// [--timeout-ms N] and [--retries N]. The bytes that come back are checked: their SHA-256 must be the hash that was asked for.
//
// With one target it describes it. With two it compares them and says how they differ, which answers
// "why does my build have a different hash from the deployed one?". Add --json for one JSON object instead
// of text: the module as data for one target, { same, a, b, differences, explanation } for two.
//
// Exit codes: for one target, 0 shown. For two, like diff: 0 the same Wasm, 1 different. Always 2 when a
// target could not be read or is not what it should be. No dependencies; needs Node 18 or newer. Only a
// deployed: target talks to the network, and then only to read.
import { readFileSync, writeFileSync } from 'node:fs';
import { pathToFileURL } from 'node:url';
import { parseRetries, parseRpcUrl, parseTimeout, valueAfter } from './cli-options.mjs';
import { codeKeyXdr } from './ledger-keys.mjs';
import { rpcLookup } from './rpc.mjs';
import { parseCodeEntry } from './wasm-code.mjs';
import { compareReport, diff, explain } from './wasm-compare.mjs';
import { metaValue, readWasm, sectionLabel } from './wasm-sections.mjs';
import { helpFromHeader, wantsHelp } from './help.mjs';

export { sectionLabel };

/** Computes section breakdown and ledger key statistics for a parsed Wasm module. */
export function computeWasmStats(info) {
  const codeSection = info.sections.find((s) => s.id === 10);
  const codeSize = codeSection ? codeSection.size : 0;
  const customSections = info.sections.filter((s) => s.id === 0);
  const customSize = customSections.reduce((sum, s) => sum + s.size, 0);
  const standardSections = info.sections.filter((s) => s.id !== 0);
  const standardSize = standardSections.reduce((sum, s) => sum + s.size, 0);
  const codeSharePct = info.size > 0 ? Math.round((codeSize / info.size) * 1000) / 10 : 0;
  return {
    totalSize: info.size,
    codeSize,
    customSize,
    standardSize,
    codeSharePct,
    standardSectionCount: standardSections.length,
    customSectionCount: customSections.length,
    exportCount: info.functions.length,
    codeLedgerKey: codeKeyXdr(info.sha256),
  };
}

/** The lines that describe one module. `name` is what the user asked about, such as a file name. */
export function describe(name, info, { verbose = false } = {}) {
  const lines = [name];
  const row = (label, value) => lines.push(`  ${label.padEnd(10)}${value}`);
  row('size', `${info.size} bytes`);
  row('sha256', info.sha256);
  row('compiler', metaValue(info, 'rsver') ?? '(not recorded)');
  row('sdk', metaValue(info, 'rssdkver') ?? '(not recorded)');
  row('cli', metaValue(info, 'cliver') ?? '(none: not processed by the Stellar CLI)');
  row('interface', info.interface === undefined ? '(not recorded)' : `protocol ${info.interface.protocol}`);
  row('functions', info.functions.length === 0 ? '(none exported)' : info.functions.join(', '));
  row('sections', info.sections.map((s) => `${sectionLabel(s)} ${s.size}`).join(', '));
  if (verbose) {
    const stats = computeWasmStats(info);
    row('codeKey', stats.codeLedgerKey);
    row('breakdown', `code ${stats.codeSize}B (${stats.codeSharePct}%), custom ${stats.customSize}B (${stats.customSectionCount} sections), standard ${stats.standardSize}B`);
    for (const s of info.sections) {
      lines.push(`    - ${sectionLabel(s).padEnd(24)} ${String(s.size).padStart(5)} bytes  sha256:${s.digest.slice(0, 16)}...`);
    }
  }
  return lines;
}

/** One module as plain data, for --json. Anything not recorded in the module is null. */
export function toJson(name, info, { verbose = false } = {}) {
  const base = {
    name,
    size: info.size,
    sha256: info.sha256,
    compiler: metaValue(info, 'rsver') ?? null,
    sdk: metaValue(info, 'rssdkver') ?? null,
    cli: metaValue(info, 'cliver') ?? null,
    interfaceProtocol: info.interface?.protocol ?? null,
    functions: info.functions,
    sections: info.sections.map((s) => ({ section: sectionLabel(s), size: s.size, digest: s.digest })),
  };
  if (verbose) {
    base.codeLedgerKey = codeKeyXdr(info.sha256);
    base.stats = computeWasmStats(info);
  }
  return base;
}

/** Renders a single Wasm module description as GitHub-Flavored Markdown. */
export function renderMarkdownInfo(name, info) {
  const stats = computeWasmStats(info);
  const lines = [
    `# Wasm Module: \`${name}\``,
    '',
    `- **Size:** ${info.size} bytes (code: ${stats.codeSize}B / ${stats.codeSharePct}%, custom: ${stats.customSize}B)`,
    `- **SHA-256:** \`${info.sha256}\``,
    `- **Ledger Key XDR:** \`${stats.codeLedgerKey}\``,
    `- **Compiler:** \`${metaValue(info, 'rsver') ?? '(not recorded)'}\``,
    `- **SDK:** \`${metaValue(info, 'rssdkver') ?? '(not recorded)'}\``,
    `- **CLI:** \`${metaValue(info, 'cliver') ?? '(none)'}\``,
    `- **Interface:** ${info.interface === undefined ? '(not recorded)' : `protocol ${info.interface.protocol}`}`,
    `- **Functions:** ${info.functions.length === 0 ? '(none exported)' : info.functions.map((f) => `\`${f}\``).join(', ')}`,
    '',
    '## Sections',
    '',
    '| Section | Size (bytes) | SHA-256 Digest |',
    '|---|---|---|',
  ];
  for (const s of info.sections) {
    lines.push(`| \`${sectionLabel(s)}\` | ${s.size} | \`${s.digest.slice(0, 16)}...\` |`);
  }
  return lines;
}

/** Renders a two-target Wasm comparison as GitHub-Flavored Markdown. */
export function renderMarkdownComparison(aName, bName, aInfo, bInfo) {
  const d = diff(aInfo, bInfo);
  const explanation = explain(d);
  const lines = [
    `# Wasm Comparison: \`${aName}\` vs \`${bName}\``,
    '',
    `**Verdict:** ${d.sameHash ? 'Identical Wasm' : 'Different Wasm'}`,
    '',
    '| Property | A | B |',
    '|---|---|---|',
    `| Name | \`${aName}\` | \`${bName}\` |`,
    `| Size | ${aInfo.size} bytes | ${bInfo.size} bytes |`,
    `| SHA-256 | \`${aInfo.sha256.slice(0, 16)}...\` | \`${bInfo.sha256.slice(0, 16)}...\` |`,
    '',
    '## Explanation',
    '',
    ...explanation.map((line) => `- ${line}`),
  ];
  return lines;
}

const HASH = /^[0-9a-f]{64}$/;

/** Reads the command line. Throws an Error whose message says what is wrong. */
export function parseArgs(argv) {
  const options = { targets: [], config: 'fixture.wasmward.json', timeoutMs: 15_000, json: false };
  for (let i = 0; i < argv.length; i += 1) {
    const word = argv[i];
    if (word === '--json') options.json = true;
    else if (word === '--markdown') options.markdown = true;
    else if (word === '--verbose') options.verbose = true;
    else if (word === '--config') options.config = valueAfter(argv, i++, word);
    else if (word === '--rpc-url') options.rpcUrl = parseRpcUrl(valueAfter(argv, i++, word));
    else if (word === '--timeout-ms') options.timeoutMs = parseTimeout(valueAfter(argv, i++, word));
    else if (word === '--retries') options.retries = parseRetries(valueAfter(argv, i++, word));
    else if (word === '--out') options.out = valueAfter(argv, i++, word);
    else if (word.startsWith('--')) throw new Error(`unknown option ${word}`);
    else options.targets.push(parseTarget(word));
  }
  if (options.json && options.markdown) throw new Error('--json and --markdown cannot be used together');
  if (options.targets.length === 0) throw new Error('give the Wasm to look at: a file, or deployed:<wasm hash>');
  if (options.targets.length > 2) throw new Error('give one target to look at, or two to compare');
  if (options.out !== undefined && !(options.targets.length === 1 && options.targets[0].kind === 'deployed')) {
    throw new Error('--out saves one deployed Wasm: give deployed:<wasm hash> and no other target');
  }
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
  if (target.kind === 'file') {
    const bytes = readFileSync(target.path);
    return { name: target.path, info: readWasm(bytes), bytes };
  }

  const result = await rpcLookup(rpcUrlFor(options), codeKeyXdr(target.hash), { timeoutMs: options.timeoutMs, retries: options.retries });
  const entry = Array.isArray(result.entries) ? result.entries[0] : undefined;
  if (entry === undefined) throw new Error(`the network has no Wasm with hash ${target.hash} (expired and archived, or never uploaded)`);
  const parsed = parseCodeEntry(entry.xdr);
  if (parsed.hash !== target.hash || !parsed.hashMatches) {
    throw new Error(`the RPC returned code that does not have hash ${target.hash}, so it is not shown`);
  }
  return { name: `deployed:${target.hash.slice(0, 8)}...`, info: readWasm(parsed.code), bytes: parsed.code };
}

async function main(argv) {
  if (wantsHelp(argv)) {
    console.log(helpFromHeader(import.meta.url));
    return 0;
  }
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
  if (options.out !== undefined) {
    try {
      // 'wx': never replace a file that is already there.
      writeFileSync(options.out, loaded[0].bytes, { flag: 'wx' });
    } catch (error) {
      console.error(`error: ${options.out}: ${error.code === 'EEXIST' ? 'already exists, not overwriting it' : error.message}`);
      return 2;
    }
    console.error(`Saved ${loaded[0].bytes.length} bytes to ${options.out} (sha256 ${loaded[0].info.sha256}).`);
  }
  if (loaded.length === 1) {
    const [one] = loaded;
    if (options.json) console.log(JSON.stringify(toJson(one.name, one.info, { verbose: Boolean(options.verbose) })));
    else if (options.markdown) console.log(renderMarkdownInfo(one.name, one.info).join('\n'));
    else console.log(describe(one.name, one.info, { verbose: Boolean(options.verbose) }).join('\n'));
    return 0;
  }
  const [a, b] = loaded;
  const d = diff(a.info, b.info);
  if (options.json) {
    const report = {
      same: d.sameHash,
      a: toJson(a.name, a.info, { verbose: Boolean(options.verbose) }),
      b: toJson(b.name, b.info, { verbose: Boolean(options.verbose) }),
      differences: d,
      explanation: explain(d),
    };
    // A value that is missing on one side is null, not left out: JSON.stringify would drop an undefined one.
    console.log(JSON.stringify(report, (key, value) => (value === undefined ? null : value)));
  } else if (options.markdown) {
    console.log(renderMarkdownComparison(a.name, b.name, a.info, b.info).join('\n'));
  } else {
    console.log(compareReport(a.name, b.name, a.info, b.info).join('\n'));
  }
  return d.sameHash ? 0 : 1;
}

if (process.argv[1] !== undefined && import.meta.url === pathToFileURL(process.argv[1]).href) {
  process.exitCode = await main(process.argv.slice(2));
}
