import assert from 'node:assert/strict';
import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { test } from 'node:test';

// GitHub silently ignores an issue form that is missing a required key, and then people get a blank box. There is
// no YAML parser here, so these check the keys GitHub requires, line by line, and that the commands the templates
// tell people to run are scripts that exist.

const read = (path) => readFileSync(new URL(`../${path}`, import.meta.url), 'utf8');
const formDir = new URL('../.github/ISSUE_TEMPLATE/', import.meta.url);
const forms = readdirSync(formDir).filter((name) => name !== 'config.yml').sort();

test('there is a form for a bug and one for the fixture being down', () => {
  assert.deepEqual(forms, ['bug_report.yml', 'fixture_problem.yml']);
});

test('every form has a name, a description and a body, and no tab', () => {
  for (const form of forms) {
    const text = read(`.github/ISSUE_TEMPLATE/${form}`);
    for (const key of ['name', 'description', 'body']) assert.match(text, new RegExp(`^${key}:`, 'm'), `${form} has no top-level ${key}:`);
    assert.doesNotMatch(text, /\t/, `${form} has a tab, which YAML does not allow`);
  }
});

test('every input has a type, an id and a label, with ids unique in the form, and at least one is required', () => {
  for (const form of forms) {
    const text = read(`.github/ISSUE_TEMPLATE/${form}`);
    const inputs = text.split(/^ {2}- type: /m).slice(1);
    assert.ok(inputs.length >= 3, `${form} has too few inputs`);
    const ids = [];
    for (const input of inputs) {
      const type = input.split('\n')[0].trim();
      assert.match(type, /^(markdown|textarea|input|dropdown|checkboxes)$/, `${form}: unknown input type ${type}`);
      if (type === 'markdown') continue;
      const id = input.match(/^ {4}id: (\S+)/m)?.[1];
      assert.ok(id, `${form}: a ${type} has no id`);
      assert.match(input, /^ {6}label: \S/m, `${form}: ${id} has no label`);
      ids.push(id);
    }
    assert.equal(new Set(ids).size, ids.length, `${form} repeats an id`);
    assert.match(text, /required: true/, `${form} requires nothing, so it can be sent empty`);
  }
});

test('blank issues are off, and the contact link points at the library repository', () => {
  const config = read('.github/ISSUE_TEMPLATE/config.yml');
  assert.match(config, /^blank_issues_enabled: false$/m);
  assert.match(config, /url: https:\/\/github\.com\/contract-version\/Wasmward-backend\/issues/);
});

test('the forms point at the security policy for a leaked key, and tell nobody to paste one', () => {
  assert.match(read('.github/ISSUE_TEMPLATE/bug_report.yml'), /SECURITY\.md/);
  assert.match(read('.github/ISSUE_TEMPLATE/fixture_problem.yml'), /Do not paste a secret key/);
});

test('the commands the templates ask people to run are scripts that exist', () => {
  const all = [...forms.map((form) => read(`.github/ISSUE_TEMPLATE/${form}`)), read('.github/pull_request_template.md')].join('\n');
  const scripts = new Set([...all.matchAll(/\bscripts\/([\w-]+\.(?:mjs|sh))/g)].map((match) => match[1]));
  for (const name of ['live-build.mjs', 'check-lifetimes.mjs', 'wasm-info.mjs']) assert.ok(scripts.has(name), `no template mentions ${name}`);
  for (const name of scripts) assert.ok(existsSync(new URL(`../scripts/${name}`, import.meta.url)), `a template mentions scripts/${name}, which does not exist`);
});

test('the pull request template asks about the Wasm and for the checks CONTRIBUTING lists', () => {
  const template = read('.github/pull_request_template.md');
  assert.match(template, /Does it change the Wasm\?/);
  assert.match(template, /node --test scripts\/\*\.test\.mjs/);
  assert.ok(read('CONTRIBUTING.md').includes('node --test scripts/*.test.mjs'));
  assert.match(template, /secret key/);
});
