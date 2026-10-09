#!/usr/bin/env node
// Shows what is inside a Wasm file: its size, hash, the compiler and SDK versions it was built with, and its
// sections. It exists to explain why two builds of the same source have different hashes.
//
//   node scripts/wasm-info.mjs <file.wasm>
//
// Exit codes: 0 shown, 2 the file could not be read or is not a Wasm module. No dependencies; needs Node 18
// or newer. Nothing is sent anywhere.
import { readFileSync } from 'node:fs';
import { pathToFileURL } from 'node:url';
import { readWasm } from './wasm-sections.mjs';

const SECTION_NAMES = {
  1: 'type',
  2: 'import',
  3: 'function',
  4: 'table',
  5: 'memory',
  6: 'global',
  7: 'export',
  8: 'start',
  9: 'element',
  10: 'code',
  11: 'data',
  12: 'data count',
};

/** A section's name as shown: "code", or "custom contractmetav0". */
export function sectionLabel(section) {
  if (section.id === 0) return `custom ${section.name}`;
  return SECTION_NAMES[section.id] ?? `unknown (id ${section.id})`;
}

/** The value of the first metadata entry with this key, or undefined. */
function metaValue(info, key) {
  return info.meta.find((entry) => entry.key === key)?.value;
}

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

export function parseArgs(argv) {
  const targets = [];
  for (const word of argv) {
    if (word.startsWith('--')) throw new Error(`unknown option ${word}`);
    targets.push(word);
  }
  if (targets.length === 0) throw new Error('give the Wasm file to look at: node scripts/wasm-info.mjs <file.wasm>');
  if (targets.length > 1) throw new Error('give one Wasm file');
  return { targets };
}

function main(argv) {
  let options;
  try {
    options = parseArgs(argv);
  } catch (error) {
    console.error(`error: ${error.message}`);
    return 2;
  }
  const [target] = options.targets;
  let info;
  try {
    info = readWasm(readFileSync(target));
  } catch (error) {
    console.error(`error: ${target}: ${error.message}`);
    return 2;
  }
  console.log(describe(target, info).join('\n'));
  return 0;
}

if (process.argv[1] !== undefined && import.meta.url === pathToFileURL(process.argv[1]).href) {
  process.exitCode = main(process.argv.slice(2));
}
