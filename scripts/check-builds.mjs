#!/usr/bin/env node
// Checks that the two builds of the fixture differ the way they are meant to: in their code, and nothing else.
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
import { readWasm } from './wasm-sections.mjs';

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

function main(argv) {
  if (argv.length !== 2 || argv.some((word) => word.startsWith('--'))) {
    console.error('error: give the two Wasm files: node scripts/check-builds.mjs <v1.wasm> <v2.wasm>');
    return 2;
  }
  const modules = [];
  for (const path of argv) {
    try {
      modules.push(readWasm(readFileSync(path)));
    } catch (error) {
      console.error(`error: ${path}: ${error.message}`);
      return 2;
    }
  }
  const problems = problemsWith(...modules);
  if (problems.length === 0) {
    console.log('v1 and v2 differ only in their code section, as intended.');
    return 0;
  }
  for (const problem of problems) console.error(`problem: ${problem}`);
  return 1;
}

if (process.argv[1] !== undefined && import.meta.url === pathToFileURL(process.argv[1]).href) {
  process.exitCode = main(process.argv.slice(2));
}
