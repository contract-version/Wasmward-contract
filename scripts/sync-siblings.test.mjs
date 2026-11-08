import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { applyTarget, parseArgs, pinnedFrom, TARGETS } from './sync-siblings.mjs';

const OLD_ID = 'CBR5ZFDI2GBXG66DAEWWHSAK4NDLKSKHWVUEUSOM4UOBM66TI6DYPDPV';
const NEW_ID = 'CD23JAK5WMRFWGOYUCU25JNWAPWWHI6Y2YCK5XANP4MK3JHIOAHEHCHN';
const OLD_HASH = 'a7a82511fa284650178b02fe3a4bafc587b95212f2f8ce647f2df5ef4cf42509';
const NEW_HASH = 'b8b93622fb395761289c13af5b5cc698c68a6323a3f9e3f69fa3d6ff5da53610';
const V2 = 'ec040ead4e157695a16a9723a5d95a44268f1b8da4c5f6aee7bf4f218dbdc875';

const config = (contractId, v1) => ({
  version: 1,
  network: { rpcUrl: 'https://rpc.example.org', passphrase: 'x' },
  contracts: { fixture: { contractId, supported: [{ wasmHash: v1, label: 'v1' }, { wasmHash: V2, label: 'v2' }] } },
});

// What each file looks like in the sibling repository, with the old values.
const FILES = {
  'frontend/src/demo-config.js': `export const CONTRACT_ID = '${OLD_ID}';\nexport const V1_HASH = '${OLD_HASH}';\nexport const RPC_URL = 'https://x';\n`,
  'frontend/wasmward.json': `{\n  "contracts": {\n    "vault": {\n      "contractId": "${OLD_ID}",\n      "supported": [\n        {\n          "wasmHash": "${OLD_HASH}",\n          "label": "v1"\n        }\n      ]\n    }\n  }\n}\n`,
  'backend/README.md': `# Wasmward\n\n    vault: {\n      contractId: '${OLD_ID}',\n      supported: [\n        {\n          wasmHash: '${OLD_HASH}',\n          label: 'v1',\n        },\n      ],\n    },\n`,
};
const target = (repo, file) => TARGETS.find((entry) => entry.repo === repo && entry.file === file);
const pinned = { contractId: NEW_ID, v1Hash: NEW_HASH };

test('the pinned values are the contract ID and the v1 hash, read from a one-contract config', () => {
  assert.deepEqual(pinnedFrom(config(NEW_ID, NEW_HASH)), pinned);
});

test('a config that cannot be pinned says why', () => {
  assert.throws(() => pinnedFrom({ contracts: {} }), /exactly one contract, it has 0/);
  assert.throws(() => pinnedFrom({ contracts: { a: config(NEW_ID, NEW_HASH).contracts.fixture, b: config(NEW_ID, NEW_HASH).contracts.fixture } }), /it has 2/);
  assert.throws(() => pinnedFrom(config('not-an-id', NEW_HASH)), /no valid contractId/);
  assert.throws(() => pinnedFrom(config(NEW_ID, 'abc')), /no valid hash for the build labelled v1/);
  assert.throws(() => pinnedFrom({ contracts: { f: { contractId: NEW_ID, supported: [{ wasmHash: NEW_HASH, label: 'v2' }] } } }), /labelled v1/);
});

test('each file gets both values replaced, and only those, and says what changed', () => {
  for (const [path, text] of Object.entries(FILES)) {
    const [repo, ...rest] = path.split('/');
    const result = applyTarget(target(repo, rest.join('/')), text, pinned);
    assert.deepEqual(result.problems, [], path);
    assert.deepEqual(result.changed, ['contract ID', 'v1 hash'], path);
    assert.ok(result.text.includes(NEW_ID) && result.text.includes(NEW_HASH), path);
    assert.ok(!result.text.includes(OLD_ID) && !result.text.includes(OLD_HASH), path);
    // Everything else is as it was: swapping the values back gives the original file.
    assert.equal(result.text.replace(NEW_ID, OLD_ID).replace(NEW_HASH, OLD_HASH), text, path);
  }
});

test('a file that already holds the pinned values has nothing to change', () => {
  const text = FILES['frontend/src/demo-config.js'].replace(OLD_ID, NEW_ID).replace(OLD_HASH, NEW_HASH);
  assert.deepEqual(applyTarget(target('frontend', 'src/demo-config.js'), text, pinned), { text, changed: [], problems: [] });
});

test('only the one value that is out of date is reported', () => {
  const text = FILES['frontend/src/demo-config.js'].replace(OLD_ID, NEW_ID);
  assert.deepEqual(applyTarget(target('frontend', 'src/demo-config.js'), text, pinned).changed, ['v1 hash']);
});

test('the v1 hash is the one labelled v1, not another hash in the file', () => {
  const text = FILES['frontend/wasmward.json'].replace(`"label": "v1"\n        }`, `"label": "v1"\n        },\n        {\n          "wasmHash": "${V2}",\n          "label": "v2"\n        }`);
  const result = applyTarget(target('frontend', 'wasmward.json'), text, pinned);
  assert.ok(result.text.includes(V2), 'the v2 hash was touched');
  assert.equal(result.text.split(NEW_HASH).length - 1, 1);
});

test('a value this script cannot find is a problem, not a quiet skip', () => {
  const result = applyTarget(target('frontend', 'src/demo-config.js'), "export const SOMETHING = 'else';\n", pinned);
  assert.deepEqual(result.problems, ['src/demo-config.js has no contract ID where this script expects it', 'src/demo-config.js has no v1 hash where this script expects it']);
  assert.deepEqual(result.changed, []);
});

test('the options are read, and refused when they are not known', () => {
  assert.deepEqual(parseArgs([]), { config: 'fixture.wasmward.json', frontend: '../Wasmward-frontend', backend: '../Wasmward-backend', check: false, json: false });
  const parsed = parseArgs(['--check', '--json', '--frontend', 'f', '--backend', 'b', '--config', 'c.json']);
  assert.deepEqual(parsed, { config: 'c.json', frontend: 'f', backend: 'b', check: true, json: true });
  assert.throws(() => parseArgs(['--frontend']), /--frontend needs a value/);
  assert.throws(() => parseArgs(['--nope']), /unknown option --nope/);
});

/** A throwaway folder with a config and the three sibling files, then the script run in it. */
function box(files = FILES, pinnedConfig = config(NEW_ID, NEW_HASH)) {
  const dir = mkdtempSync(join(tmpdir(), 'siblings-'));
  for (const [path, text] of Object.entries(files)) {
    const full = join(dir, path);
    mkdirSync(join(full, '..'), { recursive: true });
    writeFileSync(full, text);
  }
  writeFileSync(join(dir, 'config.json'), JSON.stringify(pinnedConfig));
  return {
    dir,
    read: (path) => readFileSync(join(dir, path), 'utf8'),
    run: (args = []) =>
      new Promise((resolve) =>
        execFile(process.execPath, [join(process.cwd(), 'scripts/sync-siblings.mjs'), '--config', join(dir, 'config.json'), '--frontend', join(dir, 'frontend'), '--backend', join(dir, 'backend'), ...args], (error, stdout, stderr) =>
          resolve({ status: error ? error.code : 0, stdout, stderr }),
        ),
      ),
    cleanup: () => rmSync(dir, { recursive: true, force: true }),
  };
}

test('run for real: stale files are rewritten, and a second run finds nothing to do', async () => {
  const b = box();
  try {
    const first = await b.run();
    assert.equal(first.status, 0, first.stderr);
    assert.match(first.stdout, /^updated {2}frontend\/src\/demo-config\.js {2}\(contract ID, v1 hash\)$/m);
    assert.match(first.stdout, /^updated {2}backend\/README\.md/m);
    assert.ok(b.read('frontend/wasmward.json').includes(NEW_ID));
    const second = await b.run();
    assert.equal(second.status, 0);
    assert.match(second.stdout, /Every file already holds CD23JAK5\.\.\. and v1 b8b93622\.\.\./);
  } finally {
    b.cleanup();
  }
});

test('run for real: --check reports what is stale, writes nothing, and exits 1', async () => {
  const b = box();
  try {
    const run = await b.run(['--check']);
    assert.equal(run.status, 1);
    assert.match(run.stdout, /^out of date {2}frontend\/wasmward\.json/m);
    assert.match(run.stderr, /Run: node scripts\/sync-siblings\.mjs/);
    assert.equal(b.read('frontend/src/demo-config.js'), FILES['frontend/src/demo-config.js']);
  } finally {
    b.cleanup();
  }
});

test('run for real: --check exits 0 when everything is current', async () => {
  const current = Object.fromEntries(Object.entries(FILES).map(([path, text]) => [path, text.replace(OLD_ID, NEW_ID).replace(OLD_HASH, NEW_HASH)]));
  const b = box(current);
  try {
    assert.equal((await b.run(['--check'])).status, 0);
  } finally {
    b.cleanup();
  }
});

test('run for real: --json says what was found and whether the check passed', async () => {
  const b = box();
  try {
    const report = JSON.parse((await b.run(['--check', '--json'])).stdout);
    assert.equal(report.ok, false);
    assert.equal(report.check, true);
    assert.deepEqual(report.pinned, pinned);
    assert.deepEqual(report.files.map((file) => [file.repo, file.file, file.changed.length]), [['frontend', 'src/demo-config.js', 2], ['frontend', 'wasmward.json', 2], ['backend', 'README.md', 2]]);
  } finally {
    b.cleanup();
  }
});

test('run for real: a sibling that changed shape stops it with exit 2 and writes nothing at all', async () => {
  const b = box({ ...FILES, 'frontend/src/demo-config.js': "export const SOMETHING = 'else';\n" });
  try {
    const run = await b.run();
    assert.equal(run.status, 2);
    assert.match(run.stderr, /error: frontend: src\/demo-config\.js has no contract ID where this script expects it/);
    assert.equal(b.read('backend/README.md'), FILES['backend/README.md'], 'a file was changed although another could not be');
  } finally {
    b.cleanup();
  }
});

test('run for real: a missing checkout is exit 2 and names the file', async () => {
  const b = box({ 'frontend/src/demo-config.js': FILES['frontend/src/demo-config.js'], 'frontend/wasmward.json': FILES['frontend/wasmward.json'] });
  try {
    const run = await b.run();
    assert.equal(run.status, 2);
    assert.match(run.stderr, /cannot read .*README\.md/);
  } finally {
    b.cleanup();
  }
});

test('run for real: a bad config is exit 2 before any file is read', async () => {
  const b = box(FILES, config('nope', NEW_HASH));
  try {
    const run = await b.run();
    assert.equal(run.status, 2);
    assert.match(run.stderr, /no valid contractId/);
  } finally {
    b.cleanup();
  }
});
