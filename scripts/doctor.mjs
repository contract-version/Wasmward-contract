#!/usr/bin/env node
// Checks that this machine has what the checks in CONTRIBUTING.md need, and says what is missing and how to get it.
//
//   node scripts/doctor.mjs [--json]
//
// Needed for the script tests: Node 18 or newer and git. Needed for the contract tests: Rust (rustc, cargo, rustfmt,
// clippy) and the wasm32v1-none target. Needed for scripts/verify-hashes.sh and scripts/deploy.sh: the Stellar CLI,
// version 27.0.0 to reproduce the deployed hashes. Anything else the repository does not need is not looked at.
//
// Exit codes: 0 everything needed for the script tests is there (the rest is reported, not required), 1 something
// needed for the script tests is missing, 2 the options could not be read. No dependencies; needs Node 18 or newer.
import { spawnSync } from 'node:child_process';
import { pathToFileURL } from 'node:url';

/** The Stellar CLI version the deployed fixture was built with. A different one may give different hashes. */
export const STELLAR_CLI_VERSION = '27.0.0';

/** How to run a command and get its text, or undefined if it is not there or fails. */
export function realRun(command, args) {
  // On Windows the Stellar CLI and rustup are found only through the shell. The words are fixed ones from this file,
  // so joining them is safe, and passing them as one string avoids Node's warning about shell and arguments together.
  const result = process.platform === 'win32'
    ? spawnSync([command, ...args].join(' '), { encoding: 'utf8', shell: true })
    : spawnSync(command, args, { encoding: 'utf8' });
  if (result.error !== undefined || result.status !== 0) return undefined;
  return `${result.stdout}${result.stderr}`.trim();
}

/** The first x.y.z in some text, as numbers, or undefined. */
export function versionIn(text) {
  const match = /(\d+)\.(\d+)\.(\d+)/.exec(text ?? '');
  return match === null ? undefined : [Number(match[1]), Number(match[2]), Number(match[3])];
}

/**
 * Looks at the tools through `run(command, args)`, which returns the command's output or undefined. Returns a list of
 * { name, needFor, required, ok, found?, fix? }. `nodeVersion` is the running Node's version string.
 */
export function checkTools(run, nodeVersion = process.versions.node) {
  const results = [];
  const add = (name, needFor, required, ok, found, fix) => results.push({ name, needFor, required, ok, ...(found === undefined ? {} : { found }), ...(ok ? {} : { fix }) });

  const node = versionIn(nodeVersion);
  add('node', 'the script tests', true, node !== undefined && node[0] >= 18, nodeVersion, 'install Node 18 or newer: https://nodejs.org');

  const git = run('git', ['--version']);
  add('git', 'the script tests, which ask git what is tracked', true, git !== undefined, git, 'install git: https://git-scm.com');

  const rustc = run('rustc', ['--version']);
  add('rustc', 'the contract tests', false, rustc !== undefined, rustc, 'install Rust: https://rustup.rs');
  const cargo = run('cargo', ['--version']);
  add('cargo', 'the contract tests', false, cargo !== undefined, cargo, 'install Rust: https://rustup.rs');
  const fmt = run('cargo', ['fmt', '--version']);
  add('rustfmt', 'cargo fmt --check', false, fmt !== undefined, fmt, 'rustup component add rustfmt');
  const clippy = run('cargo', ['clippy', '--version']);
  add('clippy', 'cargo clippy', false, clippy !== undefined, clippy, 'rustup component add clippy');
  const targets = run('rustup', ['target', 'list', '--installed']);
  add('wasm32v1-none', 'building the Wasm', false, targets !== undefined && targets.split(/\s+/).includes('wasm32v1-none'), targets === undefined ? undefined : 'installed', 'rustup target add wasm32v1-none');

  const stellar = run('stellar', ['--version']);
  const first = stellar?.split('\n')[0];
  add('stellar', 'scripts/deploy.sh and scripts/verify-hashes.sh', false, stellar !== undefined, first, 'install the Stellar CLI: https://developers.stellar.org/docs/tools/cli');
  if (stellar !== undefined) {
    const found = versionIn(first)?.join('.');
    add('stellar version', `reproducing the deployed hashes (they were built with ${STELLAR_CLI_VERSION})`, false, found === STELLAR_CLI_VERSION, found, `install Stellar CLI ${STELLAR_CLI_VERSION} to get the deployed hashes; another version may give others`);
  }
  return results;
}

/** The report as lines of text. */
export function render(results) {
  const lines = results.map((entry) => {
    const mark = entry.ok ? 'ok     ' : entry.required ? 'MISSING' : 'missing';
    const found = entry.found === undefined ? '' : `  ${entry.found}`;
    return `${mark}  ${entry.name}${found}${entry.ok ? '' : `\n          needed for ${entry.needFor}; ${entry.fix}`}`;
  });
  const lacking = results.filter((entry) => entry.required && !entry.ok);
  const optional = results.filter((entry) => !entry.required && !entry.ok);
  lines.push('');
  if (lacking.length > 0) lines.push(`Missing, and needed for the script tests: ${lacking.map((entry) => entry.name).join(', ')}.`);
  else lines.push('The script tests can run: node --test scripts/*.test.mjs');
  if (optional.length > 0) lines.push(`Not found, needed only for the Rust and deploy work: ${optional.map((entry) => entry.name).join(', ')}.`);
  return lines;
}

function main(argv) {
  const unknown = argv.find((word) => word !== '--json');
  if (unknown !== undefined) {
    console.error(`error: unknown option ${unknown}`);
    return 2;
  }
  const results = checkTools(realRun);
  const failed = results.some((entry) => entry.required && !entry.ok);
  if (argv.includes('--json')) console.log(JSON.stringify({ ok: !failed, tools: results }));
  else for (const line of render(results)) console.log(line);
  return failed ? 1 : 0;
}

if (process.argv[1] !== undefined && import.meta.url === pathToFileURL(process.argv[1]).href) {
  process.exitCode = main(process.argv.slice(2));
}
