import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { describe, load, parseArgs, parseTarget, rpcUrlFor, sectionLabel } from './wasm-info.mjs';
import { parseCodeEntry } from './wasm-code.mjs';
import { readWasm } from './wasm-sections.mjs';

const HASH = 'a7a82511fa284650178b02fe3a4bafc587b95212f2f8ce647f2df5ef4cf42509';
const SCRIPT = fileURLToPath(new URL('./wasm-info.mjs', import.meta.url));
const recorded = JSON.parse(readFileSync(new URL('./fixtures/testnet-code-entries.json', import.meta.url), 'utf8'));
const deployed = (label) => parseCodeEntry(recorded.builds[label].xdr).code;

/** Runs the script with these files written into a temp directory. Resolves { status, stdout, stderr, dir }. */
function run(args, files = {}) {
  const dir = mkdtempSync(join(tmpdir(), 'wasm-info-'));
  for (const [name, bytes] of Object.entries(files)) writeFileSync(join(dir, name), bytes);
  return new Promise((resolve) =>
    execFile(process.execPath, [SCRIPT, ...args], { cwd: dir }, (error, stdout, stderr) => {
      rmSync(dir, { recursive: true, force: true });
      resolve({ status: error ? error.code : 0, stdout, stderr });
    }),
  );
}

test('names every standard section, and says what it does not know', () => {
  assert.equal(sectionLabel({ id: 10, size: 1 }), 'code');
  assert.equal(sectionLabel({ id: 12, size: 1 }), 'data count');
  assert.equal(sectionLabel({ id: 0, name: 'contractmetav0', size: 1 }), 'custom contractmetav0');
  assert.equal(sectionLabel({ id: 99, size: 1 }), 'unknown (id 99)');
});

test('describes the real deployed v1', () => {
  const lines = describe('v1.wasm', readWasm(deployed('v1')));
  assert.equal(lines[0], 'v1.wasm');
  assert.deepEqual(lines.slice(1, 3), ['  size      1204 bytes', `  sha256    ${recorded.builds.v1.wasmHash}`]);
  assert.match(lines[3], /^ {2}compiler {2}\d+\.\d+\.\d+$/);
  assert.match(lines[4], /^ {2}sdk {7}26\.1\.1#[0-9a-f]{40}$/);
  assert.match(lines[5], /^ {2}cli {7}\d+\.\d+\.\d+#[0-9a-f]{40}$/);
  assert.equal(lines[6], '  interface protocol 26');
  assert.match(lines[7], /^ {2}sections {2}type 23, import 49, .*, code 352, data 14, custom contractspecv0 387/);
  assert.equal(lines.length, 8);
});

test('says plainly when a module records no versions or was not processed by the Stellar CLI', () => {
  const bare = Buffer.from('0061736d01000000', 'hex');
  const lines = describe('bare.wasm', readWasm(bare));
  assert.ok(lines.includes('  compiler  (not recorded)'));
  assert.ok(lines.includes('  sdk       (not recorded)'));
  assert.ok(lines.includes('  cli       (none: not processed by the Stellar CLI)'));
  assert.ok(lines.includes('  interface (not recorded)'));
  assert.ok(lines.includes('  sections  '));
});

test('parseArgs wants exactly one target and knows only its own options', () => {
  assert.deepEqual(parseArgs(['a.wasm']), {
    targets: [{ kind: 'file', path: 'a.wasm' }],
    config: 'fixture.wasmward.json',
    timeoutMs: 15_000,
  });
  assert.throws(() => parseArgs([]), /give the Wasm to look at/);
  assert.throws(() => parseArgs(['a.wasm', 'b.wasm']), /give one target/);
  assert.throws(() => parseArgs(['--bogus', 'a.wasm']), /unknown option --bogus/);
});

test('parseArgs reads the network options, in any position', () => {
  const options = parseArgs(['--rpc-url', 'http://127.0.0.1:1', 'a.wasm', '--timeout-ms', '500', '--config', 'c.json']);
  assert.equal(options.rpcUrl, 'http://127.0.0.1:1');
  assert.equal(options.timeoutMs, 500);
  assert.equal(options.config, 'c.json');
  assert.throws(() => parseArgs(['a.wasm', '--rpc-url']), /--rpc-url needs a value/);
  assert.throws(() => parseArgs(['a.wasm', '--timeout-ms', '5']), /--timeout-ms must be/);
});

test('parseTarget tells a file from a deployed hash, and checks the hash', () => {
  assert.deepEqual(parseTarget('build/v1.wasm'), { kind: 'file', path: 'build/v1.wasm' });
  assert.deepEqual(parseTarget(`deployed:${HASH}`), { kind: 'deployed', hash: HASH });
  for (const bad of ['deployed:', 'deployed:abc', `deployed:${HASH.toUpperCase()}`, `deployed:${HASH}0`]) {
    assert.throws(() => parseTarget(bad), /64 lowercase hex characters/, bad);
  }
});

test('rpcUrlFor prefers --rpc-url, then the config, and otherwise says what to do', () => {
  const config = () => JSON.stringify({ network: { rpcUrl: 'https://from.config' } });
  assert.equal(rpcUrlFor({ rpcUrl: 'https://flag', config: 'x' }, config), 'https://flag');
  assert.equal(rpcUrlFor({ config: 'x' }, config), 'https://from.config');
  assert.throws(() => rpcUrlFor({ config: 'missing.json' }, () => { throw new Error('ENOENT'); }), /no RPC to ask: give --rpc-url.*missing\.json/);
  assert.throws(() => rpcUrlFor({ config: 'x' }, () => '{}'), /x has no network\.rpcUrl/);
  assert.throws(() => rpcUrlFor({ config: 'x' }, () => 'not json'), /no RPC to ask/);
});

test('prints the description of a file and exits 0', async () => {
  const result = await run(['v1.wasm'], { 'v1.wasm': deployed('v1') });
  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /^v1\.wasm\n {2}size {6}1204 bytes\n {2}sha256 {4}a7a82511/);
  assert.equal(result.stderr, '');
});

test('exits 2, with the file name and the reason, for a file that is not Wasm', async () => {
  const result = await run(['notes.txt'], { 'notes.txt': Buffer.from('not wasm at all') });
  assert.equal(result.status, 2);
  assert.match(result.stderr, /^error: notes\.txt: this is not a Wasm module/);
  assert.equal(result.stdout, '');
});

test('exits 2 for a file that does not exist, and for a damaged one', async () => {
  const missing = await run(['nothing.wasm']);
  assert.equal(missing.status, 2);
  assert.match(missing.stderr, /^error: nothing\.wasm: ENOENT/);
  const damaged = await run(['half.wasm'], { 'half.wasm': deployed('v1').subarray(0, 600) });
  assert.equal(damaged.status, 2);
  assert.match(damaged.stderr, /says it is \d+ bytes but only \d+ remain/);
});

test('exits 2 with a usage message when called wrongly', async () => {
  for (const args of [[], ['a', 'b'], ['--nope']]) {
    const result = await run(args);
    assert.equal(result.status, 2, args.join(' '));
    assert.match(result.stderr, /^error: /);
    assert.equal(result.stdout, '');
  }
});

/**
 * A local RPC that answers getLedgerEntries from the recorded testnet entries, by the hash in the key.
 * `tamper(hash, xdrBase64)` may change an answer, and `answer(res)` may replace the whole reply.
 */
async function rpcServing({ tamper = (hash, xdr) => xdr, answer } = {}) {
  const { createServer } = await import('node:http');
  const byHash = new Map(Object.values(recorded.builds).map((build) => [build.wasmHash, build.xdr]));
  const server = createServer((req, res) => {
    let body = '';
    req.on('data', (chunk) => (body += chunk));
    req.on('end', () => {
      if (answer !== undefined) return answer(res);
      const hash = Buffer.from(JSON.parse(body).params.keys[0], 'base64').subarray(4).toString('hex');
      const xdr = byHash.get(hash);
      const entries = xdr === undefined ? [] : [{ liveUntilLedgerSeq: 99, xdr: tamper(hash, xdr) }];
      res.setHeader('content-type', 'application/json');
      res.end(JSON.stringify({ jsonrpc: '2.0', id: 1, result: { entries, latestLedger: 1 } }));
    });
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  return {
    url: `http://127.0.0.1:${server.address().port}`,
    close: async () => {
      server.closeAllConnections();
      await new Promise((resolve) => server.close(resolve));
    },
  };
}

test('a deployed hash is read from the RPC and described like a file', async () => {
  const rpc = await rpcServing();
  try {
    const loaded = await load({ kind: 'deployed', hash: HASH }, { rpcUrl: rpc.url, timeoutMs: 5000 });
    assert.equal(loaded.name, 'deployed:a7a82511...');
    assert.equal(loaded.info.sha256, HASH);
    assert.deepEqual(loaded.info.meta.map((m) => m.key), ['rsver', 'rssdkver', 'cliver']);
  } finally {
    await rpc.close();
  }
});

test('says so when the network has no Wasm with that hash', async () => {
  const rpc = await rpcServing();
  try {
    await assert.rejects(load({ kind: 'deployed', hash: 'ab'.repeat(32) }, { rpcUrl: rpc.url, timeoutMs: 5000 }), /the network has no Wasm with hash abab.*never uploaded/);
  } finally {
    await rpc.close();
  }
});

test('refuses code that does not have the hash that was asked for, instead of showing it', async () => {
  // The RPC answers a request for v1 with the entry of v2: a real entry, but not the one asked for.
  const v2 = recorded.builds.v2.xdr;
  const rpc = await rpcServing({ tamper: () => v2 });
  try {
    await assert.rejects(load({ kind: 'deployed', hash: HASH }, { rpcUrl: rpc.url, timeoutMs: 5000 }), /does not have hash a7a82511.*not shown/);
  } finally {
    await rpc.close();
  }
});

test('refuses code whose bytes were changed while the stated hash was kept', async () => {
  const flip = (hash, xdr) => {
    const bytes = Buffer.from(xdr, 'base64');
    bytes[bytes.length - 5] ^= 0xff; // inside the Wasm, after the hash
    return bytes.toString('base64');
  };
  const rpc = await rpcServing({ tamper: flip });
  try {
    await assert.rejects(load({ kind: 'deployed', hash: HASH }, { rpcUrl: rpc.url, timeoutMs: 5000 }), /does not have hash/);
  } finally {
    await rpc.close();
  }
});

test('reports a network failure with the reason, and uses --config when there is no --rpc-url', async () => {
  const down = await rpcServing({ answer: (res) => { res.statusCode = 500; res.end('no'); } });
  try {
    await assert.rejects(load({ kind: 'deployed', hash: HASH }, { rpcUrl: down.url, timeoutMs: 5000 }), /HTTP 500/);
  } finally {
    await down.close();
  }
  const rpc = await rpcServing();
  const result = await run(['--config', 'net.json', `deployed:${HASH}`], { 'net.json': JSON.stringify({ network: { rpcUrl: rpc.url } }) });
  await rpc.close();
  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /^deployed:a7a82511\.\.\.\n {2}size {6}1204 bytes/);
});

test('exits 2 with advice when there is no RPC to ask', async () => {
  const result = await run([`deployed:${HASH}`]); // no config in the temp directory, no --rpc-url
  assert.equal(result.status, 2);
  assert.match(result.stderr, /^error: no RPC to ask: give --rpc-url/);
});
