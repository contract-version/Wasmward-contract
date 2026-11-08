#!/usr/bin/env node
// Rewrites the contract ID and the v1 hash that the other two Wasmward repositories pin, from fixture.wasmward.json,
// so that a redeploy does not mean hunting for them by hand: the frontend's src/demo-config.js and wasmward.json, and
// the example in the backend's README. (The backend's recorded testnet answers are not text: record them with
// scripts/record-testnet.mjs.)
//
//   node scripts/sync-siblings.mjs [--config fixture.wasmward.json] [--frontend DIR] [--backend DIR] [--check] [--json]
//
// --frontend and --backend name the other checkouts (default ../Wasmward-frontend and ../Wasmward-backend). With
// --check nothing is written: exit 0 if every file already holds the pinned values, 1 if one does not. A file that
// does not have the line it is expected to have is an error (exit 2), not something to skip: it means the other
// repository changed shape and this script has to be updated with it.
//
// Exit codes: 0 everything holds (or was updated), 1 --check found a file out of date, 2 a checkout, a file or the
// config could not be used. No dependencies; needs Node 18 or newer.
import { readFileSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { valueAfter } from './cli-options.mjs';
import { helpFromHeader, wantsHelp } from './help.mjs';

const CONTRACT = /C[A-Z2-7]{55}/;
const HASH = /[0-9a-f]{64}/;

/**
 * The places that pin the contract, per sibling: the file, and for each value the pattern that finds it. A pattern has
 * the text before the value in group 1, the old value, and the text after in group 3.
 */
export const TARGETS = [
  {
    repo: 'frontend',
    file: 'src/demo-config.js',
    edits: [
      { name: 'contract ID', value: 'contractId', pattern: new RegExp(`(export const CONTRACT_ID = ')(${CONTRACT.source})(')`) },
      { name: 'v1 hash', value: 'v1Hash', pattern: new RegExp(`(export const V1_HASH = ')(${HASH.source})(')`) },
    ],
  },
  {
    repo: 'frontend',
    file: 'wasmward.json',
    edits: [
      { name: 'contract ID', value: 'contractId', pattern: new RegExp(`("contractId": ")(${CONTRACT.source})(")`) },
      { name: 'v1 hash', value: 'v1Hash', pattern: new RegExp(`("wasmHash": ")(${HASH.source})(",\\s*"label": "v1")`) },
    ],
  },
  {
    repo: 'backend',
    file: 'README.md',
    edits: [
      { name: 'contract ID', value: 'contractId', pattern: new RegExp(`(contractId: ')(${CONTRACT.source})(')`) },
      { name: 'v1 hash', value: 'v1Hash', pattern: new RegExp(`(wasmHash: ')(${HASH.source})(',\\s*label: 'v1')`) },
    ],
  },
];

/** The values to pin, from a parsed fixture.wasmward.json. Throws an Error that says what is wrong with it. */
export function pinnedFrom(config) {
  const contracts = Object.values(config?.contracts ?? {});
  if (contracts.length !== 1) throw new Error(`the config must describe exactly one contract, it has ${contracts.length}`);
  const [contract] = contracts;
  const v1 = (contract.supported ?? []).find((build) => build.label === 'v1');
  if (!CONTRACT.test(contract.contractId ?? '') || contract.contractId.length !== 56) throw new Error('the config has no valid contractId');
  if (v1 === undefined || !/^[0-9a-f]{64}$/.test(v1.wasmHash ?? '')) throw new Error('the config has no valid hash for the build labelled v1');
  return { contractId: contract.contractId, v1Hash: v1.wasmHash };
}

/**
 * Applies one target's edits to the text of its file. Returns { text, changed: [names], problems: [sentences] }. A value
 * the pattern cannot find is a problem, not a skip.
 */
export function applyTarget(target, text, pinned) {
  let out = text;
  const changed = [];
  const problems = [];
  for (const edit of target.edits) {
    const match = edit.pattern.exec(out);
    if (match === null) {
      problems.push(`${target.file} has no ${edit.name} where this script expects it`);
      continue;
    }
    if (match[2] !== pinned[edit.value]) {
      out = out.replace(edit.pattern, (_all, before, _old, after) => `${before}${pinned[edit.value]}${after}`);
      changed.push(edit.name);
    }
  }
  return { text: out, changed, problems };
}

/** Reads the command line. Throws an Error whose message says what is wrong. */
export function parseArgs(argv) {
  const options = { config: 'fixture.wasmward.json', frontend: '../Wasmward-frontend', backend: '../Wasmward-backend', check: false, json: false };
  for (let i = 0; i < argv.length; i += 1) {
    const flag = argv[i];
    if (flag === '--config') options.config = valueAfter(argv, i++, flag);
    else if (flag === '--frontend') options.frontend = valueAfter(argv, i++, flag);
    else if (flag === '--backend') options.backend = valueAfter(argv, i++, flag);
    else if (flag === '--check') options.check = true;
    else if (flag === '--json') options.json = true;
    else throw new Error(`unknown option ${flag}`);
  }
  return options;
}

function main(argv) {
  if (wantsHelp(argv)) {
    console.log(helpFromHeader(import.meta.url));
    return 0;
  }
  let options;
  let pinned;
  try {
    options = parseArgs(argv);
    pinned = pinnedFrom(JSON.parse(readFileSync(options.config, 'utf8')));
  } catch (error) {
    console.error(`error: ${error.message}`);
    return 2;
  }

  const dirs = { frontend: resolve(options.frontend), backend: resolve(options.backend) };
  const report = [];
  const problems = [];
  const pending = [];
  for (const target of TARGETS) {
    const path = join(dirs[target.repo], target.file);
    let text;
    try {
      text = readFileSync(path, 'utf8');
    } catch (error) {
      problems.push(`cannot read ${path}: ${error.code ?? error.message}`);
      continue;
    }
    const result = applyTarget(target, text, pinned);
    problems.push(...result.problems.map((sentence) => `${target.repo}: ${sentence}`));
    report.push({ repo: target.repo, file: target.file, changed: result.changed });
    if (result.changed.length > 0) pending.push({ path, text: result.text });
  }
  if (problems.length > 0) {
    for (const problem of problems) console.error(`error: ${problem}`);
    return 2;
  }

  const stale = report.filter((entry) => entry.changed.length > 0);
  if (!options.check) for (const { path, text } of pending) writeFileSync(path, text);
  if (options.json) {
    console.log(JSON.stringify({ ok: options.check ? stale.length === 0 : true, check: options.check, pinned, files: report }));
  } else if (stale.length === 0) {
    console.log(`Every file already holds ${pinned.contractId.slice(0, 8)}... and v1 ${pinned.v1Hash.slice(0, 8)}...`);
  } else {
    for (const entry of stale) console.log(`${options.check ? 'out of date' : 'updated'}  ${entry.repo}/${entry.file}  (${entry.changed.join(', ')})`);
    if (options.check) console.error('Run: node scripts/sync-siblings.mjs');
  }
  return options.check && stale.length > 0 ? 1 : 0;
}

if (process.argv[1] !== undefined && import.meta.url === pathToFileURL(process.argv[1]).href) {
  process.exitCode = main(process.argv.slice(2));
}
