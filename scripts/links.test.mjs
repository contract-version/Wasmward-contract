import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import { dirname, join, normalize } from 'node:path';
import { test } from 'node:test';

// A link in the documentation that points at a file or a heading that is gone is wrong the day someone follows it.
// This checks every relative link and every #anchor in the Markdown files, and every link between them.

const markdown = execFileSync('git', ['ls-files', '*.md'], { encoding: 'utf8' }).split('\n').filter(Boolean);

/** How GitHub turns a heading into an anchor: lower case, punctuation dropped, spaces to dashes. */
function slug(heading) {
  return heading
    .toLowerCase()
    .replace(/`/g, '')
    .replace(/[^\p{L}\p{N}\s-]/gu, '')
    .trim()
    .replace(/\s/g, '-');
}

function headingsOf(path) {
  const text = readFileSync(path, 'utf8').replace(/^```[\s\S]*?^```/gm, '');
  return new Set([...text.matchAll(/^#{1,6}\s+(.+?)\s*#*\s*$/gm)].map((match) => slug(match[1])));
}

/** [text](target) links, without the ones inside code blocks or spans. */
function linksOf(path) {
  const text = readFileSync(path, 'utf8').replace(/^```[\s\S]*?^```/gm, '').replace(/`[^`\n]*`/g, '');
  return [...text.matchAll(/\]\(([^)\s]+)\)/g)].map((match) => match[1]);
}

test('the slug function does what GitHub does to the headings used here', () => {
  assert.equal(slug('Keeping it alive'), 'keeping-it-alive');
  assert.equal(slug('Why the same source has more than one Wasm hash'), 'why-the-same-source-has-more-than-one-wasm-hash');
  assert.equal(slug('`scripts/extend.sh`'), 'scriptsextendsh');
  assert.equal(slug('CI'), 'ci');
});

test('there are Markdown files with links to check', () => {
  assert.ok(markdown.length >= 4, markdown.join(', '));
  const total = markdown.reduce((sum, path) => sum + linksOf(path).length, 0);
  assert.ok(total >= 10, `only ${total} links`);
});

test('every relative link points at a file that exists', () => {
  for (const path of markdown) {
    for (const link of linksOf(path)) {
      if (/^([a-z]+:|#|mailto:)/i.test(link)) continue;
      const target = normalize(join(dirname(path), link.split('#')[0]));
      assert.ok(existsSync(target), `${path} links to ${link}, which does not exist (looked for ${target})`);
    }
  }
});

test('every #anchor points at a heading that exists, in this file or in the one it names', () => {
  for (const path of markdown) {
    for (const link of linksOf(path)) {
      if (/^([a-z]+:|mailto:)/i.test(link) || !link.includes('#')) continue;
      const [file, anchor] = link.split('#');
      const target = file === '' ? path : normalize(join(dirname(path), file));
      if (!target.endsWith('.md')) continue;
      assert.ok(headingsOf(target).has(anchor), `${path} links to ${link}, but ${target} has no such heading`);
    }
  }
});
