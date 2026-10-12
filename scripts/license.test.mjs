import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';

// Three places say what the license is: the LICENSE file, the crate's manifest and the README. They must agree, and
// the file must be the whole Apache License, not a stub.

const read = (path) => readFileSync(new URL(`../${path}`, import.meta.url), 'utf8');

test('the LICENSE file is the Apache License, Version 2.0, in full', () => {
  const text = read('LICENSE');
  assert.match(text, /Apache License\s+Version 2\.0, January 2004/);
  assert.match(text, /TERMS AND CONDITIONS FOR USE, REPRODUCTION, AND DISTRIBUTION/);
  assert.match(text, /END OF TERMS AND CONDITIONS/);
  assert.ok(text.split('\n').length > 150, 'the file is too short to be the whole license');
});

test('the crate declares the same license, as an SPDX identifier', () => {
  assert.match(read('contracts/fixture/Cargo.toml'), /^license = "Apache-2\.0"$/m);
});

test('the README names the same license', () => {
  const readme = read('README.md');
  assert.match(readme, /^## License\s*\n+Apache-2\.0\s*$/m);
});
