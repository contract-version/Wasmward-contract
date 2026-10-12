#!/usr/bin/env node
// Checks that the two builds of the fixture differ the way they are meant to: in their code, and nothing else,
// and that both export exactly the contract's interface (__constructor, upgrade, version).
//
//   node scripts/check-builds.mjs <v1.wasm> <v2.wasm>
//
// The fixture exists so that two builds of one crate have different Wasm hashes while behaving alike except
// for `version()`. If the v2 build were ever made with a different compiler or SDK, or had other sections that
// differ, the two would stop being a clean pair, and tests that upgrade between them would prove less than they
// seem to. CI runs this on the Wasm it just built.
//
// Exit codes: 0 they differ only in the code section, 1 they do not (each problem is printed), 2 a file could not
// be read. No dependencies; needs Node 18 or newer.
import { readFileSync } from 'node:fs';
import { pathToFileURL } from 'node:url';
import { diff } from './wasm-compare.mjs';
import { readExports } from './wasm-exports.mjs';
import { readWasm } from './wasm-sections.mjs';
import { helpFromHeader, wantsHelp } from './help.mjs';

/** What the contract may export as functions: its whole public interface. A new one is a change to the contract. */
export const EXPECTED_FUNCTIONS = ['__constructor', 'upgrade', 'version'];

/** What is wrong with a pair of builds, as an array of sentences. An empty array means the pair is clean. */
export function problemsWith(a, b) {
  const d = diff(a, b);
  const problems = [];
  if (d.sameHash) problems.push('v1 and v2 are the same Wasm, so the v2 feature changed nothing');
  for (const t of d.toolchain) problems.push(`the ${t.what} differs between v1 and v2 (v1 ${t.a ?? 'none'}, v2 ${t.b ?? 'none'})`);
  if (d.interface !== null) problems.push(`the interface version differs between v1 and v2 (v1 ${d.interface.a ?? 'none'}, v2 ${d.interface.b ?? 'none'})`);
  const others = d.sections.differ.map((s) => s.label).filter((label) => label !== 'code');
  if (others.length > 0) problems.push(`sections other than the code differ: ${others.join(', ')}`);
  if (d.sections.onlyA.length > 0) problems.push(`only v1 has the sections: ${d.sections.onlyA.join(', ')}`);
  if (d.sections.onlyB.length > 0) problems.push(`only v2 has the sections: ${d.sections.onlyB.join(', ')}`);
  if (!d.sameHash && !d.sections.differ.some((s) => s.label === 'code')) problems.push('the hashes differ but the code does not: something outside the sections changed');
  return problems;
}

/**
 * What is wrong with the exports of a pair of builds, as an array of sentences. Both must export the same names
 * (so v2 is only a different `version()`), and the functions must be exactly the contract's interface.
 */
export function exportProblems(bytesA, bytesB) {
  const describe = (bytes) => readExports(bytes).map((entry) => `${entry.kind} ${entry.name}`).sort();
  const a = describe(bytesA);
  const b = describe(bytesB);
  const problems = [];
  for (const name of a.filter((entry) => !b.includes(entry))) problems.push(`only v1 exports ${name}`);
  for (const name of b.filter((entry) => !a.includes(entry))) problems.push(`only v2 exports ${name}`);
  for (const [label, bytes] of [['v1', bytesA], ['v2', bytesB]]) {
    const functions = readExports(bytes).filter((entry) => entry.kind === 'function').map((entry) => entry.name).sort();
    const added = functions.filter((name) => !EXPECTED_FUNCTIONS.includes(name));
    const missing = EXPECTED_FUNCTIONS.filter((name) => !functions.includes(name));
    if (added.length > 0) problems.push(`${label} exports functions the contract is not meant to have: ${added.join(', ')}`);
    if (missing.length > 0) problems.push(`${label} no longer exports: ${missing.join(', ')}`);
  }
  return problems;
}

function main(argv) {
  if (wantsHelp(argv)) {
    console.log(helpFromHeader(import.meta.url));
    return 0;
  }
  if (argv.length !== 2 || argv.some((word) => word.startsWith('--'))) {
    console.error('error: give the two Wasm files: node scripts/check-builds.mjs <v1.wasm> <v2.wasm>');
    return 2;
  }
  const modules = [];
  const files = [];
  for (const path of argv) {
    try {
      files.push(readFileSync(path));
      modules.push(readWasm(files.at(-1)));
    } catch (error) {
      console.error(`error: ${path}: ${error.message}`);
      return 2;
    }
  }
  const problems = [...problemsWith(...modules)];
  try {
    problems.push(...exportProblems(...files));
  } catch (error) {
    console.error(`error: ${error.message}`);
    return 2;
  }
  if (problems.length === 0) {
    console.log('v1 and v2 differ only in their code section, and export the same interface, as intended.');
    return 0;
  }
  for (const problem of problems) console.error(`problem: ${problem}`);
  return 1;
}

if (process.argv[1] !== undefined && import.meta.url === pathToFileURL(process.argv[1]).href) {
  process.exitCode = main(process.argv.slice(2));
}
