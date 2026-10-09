import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { configFrom, parseArgs, render } from './sync-config.mjs';

const CONTRACT = 'CBR5ZFDI2GBXG66DAEWWHSAK4NDLKSKHWVUEUSOM4UOBM66TI6DYPDPV';
const V1 = 'a7a82511fa284650178b02fe3a4bafc587b95212f2f8ce647f2df5ef4cf42509';
const V2 = 'ec040ead4e157695a16a9723a5d95a44268f1b8da4c5f6aee7bf4f218dbdc875';

/** What scripts/deploy.sh writes, including fields the config must not copy. */
const testnet = () => ({
  network: 'testnet',
  rpcUrl: 'https://soroban-testnet.stellar.org',
  passphrase: 'Test SDF Network ; September 2015',
  contractId: CONTRACT,
  admin: 'GADMINADMINADMINADMINADMINADMINADMINADMINADMINADMINADMINADM',
  v1: { wasmHash: V1, file: 'build/v1/wasmward_fixture.wasm' },
  v2: { wasmHash: V2, file: 'build/v2/wasmward_fixture.wasm' },
  deployedAt: '2026-10-07T14:20:26Z',
});

test('builds the Wasmward config from what deploy.sh wrote', () => {
  assert.deepEqual(configFrom(testnet()), {
    version: 1,
    network: { rpcUrl: 'https://soroban-testnet.stellar.org', passphrase: 'Test SDF Network ; September 2015' },
    contracts: {
      fixture: {
        contractId: CONTRACT,
        supported: [
          { wasmHash: V1, label: 'v1' },
          { wasmHash: V2, label: 'v2' },
        ],
      },
    },
  });
});

test('copies nothing else from testnet.json: not the admin, the file paths or the date', () => {
  const text = render(configFrom(testnet()));
  for (const leaked of ['GADMIN', 'build/v1', 'deployedAt', '2026-10-07']) assert.ok(!text.includes(leaked), leaked);
});

test('renders two-space JSON with one final newline', () => {
  const text = render(configFrom(testnet()));
  assert.ok(text.endsWith('}\n') && !text.endsWith('\n\n'));
  assert.ok(text.startsWith('{\n  "version": 1,'));
});

test('refuses a testnet.json that is missing or has bad values, saying which', () => {
  const broken = (change) => {
    const value = testnet();
    change(value);
    return value;
  };
  const cases = [
    [(t) => delete t.rpcUrl, /no rpcUrl/],
    [(t) => (t.rpcUrl = 'ftp://x'), /no rpcUrl/],
    [(t) => (t.passphrase = ''), /no passphrase/],
    [(t) => (t.contractId = 'GBR5ZFDI2GBXG66DAEWWHSAK4NDLKSKHWVUEUSOM4UOBM66TI6DYPDPV'), /no valid contractId/],
    [(t) => delete t.contractId, /no valid contractId/],
    [(t) => (t.v1.wasmHash = V1.toUpperCase()), /no valid v1\.wasmHash/],
    [(t) => (t.v2.wasmHash = 'abc'), /no valid v2\.wasmHash/],
    [(t) => delete t.v2, /no valid v2\.wasmHash/],
    [(t) => (t.v2.wasmHash = t.v1.wasmHash), /same hash for v1 and v2/],
  ];
  for (const [change, message] of cases) assert.throws(() => configFrom(broken(change)), message);
  assert.throws(() => configFrom(null), /no rpcUrl/);
});

test('parseArgs applies defaults and reads each option', () => {
  assert.deepEqual(parseArgs([]), { testnet: 'testnet.json', out: 'fixture.wasmward.json', check: false });
  assert.deepEqual(parseArgs(['--testnet', 'a.json', '--out', 'b.json', '--check']), { testnet: 'a.json', out: 'b.json', check: true });
  assert.throws(() => parseArgs(['--out']), /--out needs a value/);
  assert.throws(() => parseArgs(['--testnet', '--check']), /--testnet needs a value/);
  assert.throws(() => parseArgs(['--bogus']), /unknown option --bogus/);
});

const SCRIPT = fileURLToPath(new URL('./sync-config.mjs', import.meta.url));

/**
 * Runs the script in a temp directory holding `files`. Resolves with its status and output, and with what
 * the directory held afterwards in `after` (a file that does not exist is null), read before cleaning up.
 */
function runIn(files, args) {
  const dir = mkdtempSync(join(tmpdir(), 'sync-config-'));
  for (const [name, text] of Object.entries(files)) writeFileSync(join(dir, name), text);
  return new Promise((resolve) =>
    execFile(process.execPath, [SCRIPT, ...args], { cwd: dir }, (error, stdout, stderr) => {
      const after = (name) => (existsSync(join(dir, name)) ? readFileSync(join(dir, name), 'utf8') : null);
      const result = { status: error ? error.code : 0, stdout, stderr, config: after('fixture.wasmward.json') };
      rmSync(dir, { recursive: true, force: true });
      resolve(result);
    }),
  );
}

const WANTED = render(configFrom(testnet()));
const TESTNET = JSON.stringify(testnet());

test('writes the config when there is none, and says so', async () => {
  const run = await runIn({ 'testnet.json': TESTNET }, []);
  assert.equal(run.status, 0, run.stderr);
  assert.match(run.stdout, /Wrote fixture\.wasmward\.json/);
  assert.equal(run.config, WANTED);
});

test('replaces a stale config', async () => {
  const stale = render(configFrom({ ...testnet(), v2: { wasmHash: 'b'.repeat(64), file: 'x' } }));
  const run = await runIn({ 'testnet.json': TESTNET, 'fixture.wasmward.json': stale }, []);
  assert.equal(run.status, 0);
  assert.equal(run.config, WANTED);
});

test('leaves a config that already matches alone', async () => {
  const run = await runIn({ 'testnet.json': TESTNET, 'fixture.wasmward.json': WANTED }, []);
  assert.equal(run.status, 0);
  assert.match(run.stdout, /already matches/);
});

test('--check exits 1 and writes nothing when the config is stale or missing', async () => {
  const stale = render(configFrom({ ...testnet(), v2: { wasmHash: 'b'.repeat(64), file: 'x' } }));
  const staleRun = await runIn({ 'testnet.json': TESTNET, 'fixture.wasmward.json': stale }, ['--check']);
  assert.equal(staleRun.status, 1);
  assert.match(staleRun.stderr, /does not match testnet\.json/);
  assert.equal(staleRun.config, stale, '--check changed the file');

  const missingRun = await runIn({ 'testnet.json': TESTNET }, ['--check']);
  assert.equal(missingRun.status, 1);
  assert.equal(missingRun.config, null, '--check created the file');
});

test('--check exits 0 for a config that matches', async () => {
  assert.equal((await runIn({ 'testnet.json': TESTNET, 'fixture.wasmward.json': WANTED }, ['--check'])).status, 0);
});

test('exits 2, and writes nothing, when testnet.json is missing, not JSON or not valid', async () => {
  for (const files of [{}, { 'testnet.json': 'not json' }, { 'testnet.json': JSON.stringify({ ...testnet(), contractId: 'x' }) }]) {
    const run = await runIn(files, []);
    assert.equal(run.status, 2);
    assert.match(run.stderr, /^error: /);
    assert.equal(run.config, null);
  }
});

test('--out and --testnet choose the files', async () => {
  const run = await runIn({ 'a.json': TESTNET }, ['--testnet', 'a.json', '--out', 'b.json', '--check']);
  assert.equal(run.status, 1); // b.json does not exist, so it cannot match
  assert.match(run.stderr, /b\.json does not match a\.json/);
});
