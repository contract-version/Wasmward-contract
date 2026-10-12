#!/usr/bin/env node
// Looks for a path from the machine that built a Wasm file (a home folder, a drive letter, the cargo registry, a CI
// runner) in the file's text, and says where. scripts/deploy.sh runs it before it uploads anything, because what is
// uploaded to a public network cannot be taken back.
//
//   node scripts/wasm-paths.mjs <file.wasm> [<file.wasm> ...] [--json]
//
// Exit codes: 0 no such path in any file, 1 at least one file has one (each is printed, with its offset), 2 a file
// could not be read or the options were wrong. No dependencies; needs Node 18 or newer.
import { readFileSync } from 'node:fs';
import { pathToFileURL } from 'node:url';
import { machinePaths } from './wasm-strings.mjs';

/** How much of a string to show: enough to see what it is, not so much that a long one floods the screen. */
const SHOWN = 100;

/** The findings for some files: [{ file, offset, text }]. `read` returns a file's bytes; it may throw. */
export function findings(files, read = readFileSync) {
  return files.flatMap((file) => machinePaths(read(file)).map(({ offset, text }) => ({ file, offset, text: text.length > SHOWN ? `${text.slice(0, SHOWN)}...` : text })));
}

function main(argv) {
  const json = argv.includes('--json');
  const files = argv.filter((word) => word !== '--json');
  const flag = files.find((word) => word.startsWith('--'));
  if (flag !== undefined) {
    console.error(`error: unknown option ${flag}`);
    return 2;
  }
  if (files.length === 0) {
    console.error('error: give at least one Wasm file: node scripts/wasm-paths.mjs <file.wasm> [...]');
    return 2;
  }
  let found;
  try {
    found = findings(files);
  } catch (error) {
    console.error(`error: ${error.message}`);
    return 2;
  }
  if (json) console.log(JSON.stringify({ ok: found.length === 0, files, findings: found }));
  else if (found.length === 0) console.log(`No path from the building machine in ${files.length === 1 ? files[0] : `any of ${files.length} files`}.`);
  else for (const { file, offset, text } of found) console.error(`${file} at byte ${offset}: ${text}`);
  return found.length === 0 ? 0 : 1;
}

if (process.argv[1] !== undefined && import.meta.url === pathToFileURL(process.argv[1]).href) {
  process.exitCode = main(process.argv.slice(2));
}
