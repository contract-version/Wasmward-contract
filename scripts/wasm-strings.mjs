// The readable text inside a Wasm file, like the `strings` tool, with no dependencies.
//
// A compiled contract can carry text its author did not mean to publish: the path of a source file from a panic
// message, a crate path from the cargo registry, sometimes a user name inside a build directory. Reading the strings
// is how that is found. It looks at the raw bytes, so it sees the data section, the custom sections and the names.

/**
 * The runs of printable ASCII (space to tilde) of at least `minLength` characters in `input`, in file order, each with
 * the offset where it starts: [{ offset, text }].
 */
export function printableStrings(input, minLength = 6) {
  const bytes = Buffer.from(input);
  const found = [];
  let start = -1;
  for (let i = 0; i <= bytes.length; i += 1) {
    const printable = i < bytes.length && bytes[i] >= 0x20 && bytes[i] <= 0x7e;
    if (printable && start === -1) start = i;
    if (!printable && start !== -1) {
      if (i - start >= minLength) found.push({ offset: start, text: bytes.subarray(start, i).toString('latin1') });
      start = -1;
    }
  }
  return found;
}

/** What marks a path from the machine that built the file: a home folder, a drive letter, the cargo registry, a CI runner. */
const MACHINE_PATH = [/[\\/]Users[\\/]/, /[\\/]home[\\/]/, /[\\/]root[\\/]/, /\b[A-Za-z]:[\\/]/, /\.cargo/, /[\\/]registry[\\/]/, /[\\/]runner[\\/]/, /[\\/]rustc[\\/]/];

/** The strings in `input` that look like a path on the machine that built it. */
export function machinePaths(input) {
  return printableStrings(input).filter(({ text }) => MACHINE_PATH.some((pattern) => pattern.test(text)));
}
