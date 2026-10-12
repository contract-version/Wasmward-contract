// --help for the command line scripts, taken from the comment at the top of each one, so the help and the
// description of the script cannot differ: there is only one text to keep right.

import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

/** True if the arguments ask for help anywhere, the way the shell scripts treat --help. */
export function wantsHelp(argv) {
  return argv.includes('--help') || argv.includes('-h');
}

/**
 * The leading comment of a script, as help text: the lines that start with `//` right after the optional `#!` line,
 * up to the first line that does not, with the `// ` removed. `url` is the script's own `import.meta.url`.
 */
export function helpFromHeader(url) {
  const lines = readFileSync(fileURLToPath(url), 'utf8').split('\n');
  const help = [];
  let started = false;
  for (const raw of lines) {
    const line = raw.endsWith('\r') ? raw.slice(0, -1) : raw;
    if (!started && line.startsWith('#!')) continue;
    if (!line.startsWith('//')) break;
    started = true;
    help.push(line.replace(/^\/\/ ?/, ''));
  }
  return help.join('\n');
}
