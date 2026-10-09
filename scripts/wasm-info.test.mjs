import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { createHash } from 'node:crypto';
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
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

test('parseArgs wants one target, or two to compare, and knows only its own options', () => {
  assert.deepEqual(parseArgs(['a.wasm']), {
    targets: [{ kind: 'file', path: 'a.wasm' }],
    config: 'fixture.wasmward.json',
    timeoutMs: 15_000,
    json: false,
  });
  assert.equal(parseArgs(['--json', 'a.wasm']).json, true);
  assert.throws(() => parseArgs([]), /give the Wasm to look at/);
  assert.deepEqual(parseArgs(['a.wasm', 'b.wasm']).targets.map((t) => t.path), ['a.wasm', 'b.wasm']);
  assert.throws(() => parseArgs(['a', 'b', 'c']), /give one target to look at, or two to compare/);
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

test('two identical files compare as the same Wasm and exit 0', async () => {
  const result = await run(['a.wasm', 'b.wasm'], { 'a.wasm': deployed('v1'), 'b.wasm': deployed('v1') });
  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /^A {2}a\.wasm\nB {2}b\.wasm\nhash {6}same\n/);
  assert.match(result.stdout, /The two are the same Wasm/);
});

test('two different files compare, say how, and exit 1', async () => {
  const result = await run(['v1.wasm', 'v2.wasm'], { 'v1.wasm': deployed('v1'), 'v2.wasm': deployed('v2') });
  assert.equal(result.status, 1, result.stderr);
  assert.match(result.stdout, /hash {6}different\n/);
  assert.match(result.stdout, /section {3}code: same size \(352\), different content/);
  assert.match(result.stdout, /The recorded tools are the same but the code differs/);
  assert.equal(result.stderr, '');
});

test('a target that cannot be read makes the whole comparison exit 2, with no report', async () => {
  const result = await run(['v1.wasm', 'missing.wasm'], { 'v1.wasm': deployed('v1') });
  assert.equal(result.status, 2);
  assert.match(result.stderr, /^error: missing\.wasm: ENOENT/);
  assert.equal(result.stdout, '');
});

test('a local file compared with the deployed Wasm of the same hash is the same Wasm', async () => {
  const rpc = await rpcServing();
  try {
    const result = await run(['--rpc-url', rpc.url, 'mine.wasm', `deployed:${HASH}`], { 'mine.wasm': deployed('v1') });
    assert.equal(result.status, 0, result.stderr);
    assert.match(result.stdout, /^A {2}mine\.wasm\nB {2}deployed:a7a82511\.\.\.\nhash {6}same/);
  } finally {
    await rpc.close();
  }
});

test('a local build that is not the deployed one is reported as different, with the reason', async () => {
  const rpc = await rpcServing();
  try {
    const result = await run(['--rpc-url', rpc.url, 'mine.wasm', `deployed:${HASH}`], { 'mine.wasm': deployed('v2') });
    assert.equal(result.status, 1, result.stderr);
    assert.match(result.stdout, /section {3}code: same size \(352\), different content/);
  } finally {
    await rpc.close();
  }
});

test('--json for one target is the module as data, with null for what is not recorded', async () => {
  const bare = Buffer.from('0061736d01000000', 'hex');
  const real = await run(['--json', 'v1.wasm'], { 'v1.wasm': deployed('v1') });
  assert.equal(real.status, 0, real.stderr);
  const info = JSON.parse(real.stdout);
  assert.deepEqual(Object.keys(info), ['name', 'size', 'sha256', 'compiler', 'sdk', 'cli', 'interfaceProtocol', 'sections']);
  assert.equal(info.name, 'v1.wasm');
  assert.equal(info.sha256, HASH);
  assert.match(info.cli, /^\d+\.\d+\.\d+#/);
  assert.equal(info.interfaceProtocol, 26);
  assert.deepEqual(info.sections.find((s) => s.section === 'code'), { section: 'code', size: 352, digest: info.sections.find((s) => s.section === 'code').digest });
  assert.match(info.sections[0].digest, /^[0-9a-f]{64}$/);

  const empty = JSON.parse((await run(['--json', 'bare.wasm'], { 'bare.wasm': bare })).stdout);
  assert.deepEqual([empty.compiler, empty.sdk, empty.cli, empty.interfaceProtocol, empty.sections], [null, null, null, null, []]);
});

test('--json for two targets has the verdict, both modules, the differences and the explanation', async () => {
  const result = await run(['--json', 'v1.wasm', 'v2.wasm'], { 'v1.wasm': deployed('v1'), 'v2.wasm': deployed('v2') });
  assert.equal(result.status, 1, 'the exit code still says they differ');
  const report = JSON.parse(result.stdout);
  assert.equal(report.same, false);
  assert.equal(report.a.name, 'v1.wasm');
  assert.equal(report.b.name, 'v2.wasm');
  assert.deepEqual(report.differences.sections.differ, [{ label: 'code', a: [352], b: [352], sameSizes: true }]);
  assert.deepEqual(report.explanation, ['The recorded tools are the same but the code differs, so the source (or an unrecorded build setting) is different.']);
  const same = JSON.parse((await run(['--json', 'a.wasm', 'b.wasm'], { 'a.wasm': deployed('v1'), 'b.wasm': deployed('v1') })).stdout);
  assert.equal(same.same, true);
});

test('--json keeps a value that is missing on one side as null, not left out', async () => {
  const plain = Buffer.from('0061736d01000000', 'hex');
  const result = await run(['--json', 'plain.wasm', 'v1.wasm'], { 'plain.wasm': plain, 'v1.wasm': deployed('v1') });
  const cli = JSON.parse(result.stdout).differences.toolchain.find((t) => t.what === 'cli');
  assert.ok('a' in cli, 'the missing side was left out');
  assert.deepEqual([cli.a, typeof cli.b], [null, 'string']);
});

test('--json errors still go to stderr with exit 2 and leave stdout empty', async () => {
  const result = await run(['--json', 'missing.wasm']);
  assert.equal(result.status, 2);
  assert.equal(result.stdout, '');
  assert.match(result.stderr, /^error: missing\.wasm: ENOENT/);
});

/** Like run(), but also reports what the temp directory held afterwards, for the files named in `read`. */
function runKeeping(args, files, read) {
  const dir = mkdtempSync(join(tmpdir(), 'wasm-info-keep-'));
  for (const [name, bytes] of Object.entries(files)) writeFileSync(join(dir, name), bytes);
  return new Promise((resolve) =>
    execFile(process.execPath, [SCRIPT, ...args], { cwd: dir }, (error, stdout, stderr) => {
      const after = Object.fromEntries(read.map((name) => [name, existsSync(join(dir, name)) ? readFileSync(join(dir, name)) : null]));
      rmSync(dir, { recursive: true, force: true });
      resolve({ status: error ? error.code : 0, stdout, stderr, after });
    }),
  );
}

test('--out saves the deployed Wasm, and the saved bytes hash to the deployed hash', async () => {
  const rpc = await rpcServing();
  try {
    const result = await runKeeping(['--rpc-url', rpc.url, `deployed:${HASH}`, '--out', 'saved.wasm'], {}, ['saved.wasm']);
    assert.equal(result.status, 0, result.stderr);
    assert.equal(createHash('sha256').update(result.after['saved.wasm']).digest('hex'), HASH);
    assert.ok(result.after['saved.wasm'].equals(deployed('v1')));
    assert.equal(result.stderr, `Saved 1204 bytes to saved.wasm (sha256 ${HASH}).\n`);
    assert.match(result.stdout, /^deployed:a7a82511\.\.\.\n {2}size {6}1204 bytes/, 'the description is still printed');
  } finally {
    await rpc.close();
  }
});

test('--out never overwrites a file that is already there', async () => {
  const rpc = await rpcServing();
  try {
    const result = await runKeeping(['--rpc-url', rpc.url, `deployed:${HASH}`, '--out', 'mine.wasm'], { 'mine.wasm': Buffer.from('precious') }, ['mine.wasm']);
    assert.equal(result.status, 2);
    assert.match(result.stderr, /^error: mine\.wasm: already exists, not overwriting it/);
    assert.equal(result.after['mine.wasm'].toString(), 'precious');
    assert.equal(result.stdout, '');
  } finally {
    await rpc.close();
  }
});

test('--out saves nothing when the code that came back is not the code that was asked for', async () => {
  const rpc = await rpcServing({ tamper: () => recorded.builds.v2.xdr });
  try {
    const result = await runKeeping(['--rpc-url', rpc.url, `deployed:${HASH}`, '--out', 'saved.wasm'], {}, ['saved.wasm']);
    assert.equal(result.status, 2);
    assert.match(result.stderr, /does not have hash/);
    assert.equal(result.after['saved.wasm'], null, 'unverified bytes were written to disk');
  } finally {
    await rpc.close();
  }
});

test('--out is refused unless there is exactly one deployed target', async () => {
  const cases = [
    [['mine.wasm', '--out', 'x.wasm'], { 'mine.wasm': deployed('v1') }],
    [[`deployed:${HASH}`, 'mine.wasm', '--out', 'x.wasm'], { 'mine.wasm': deployed('v1') }],
    [[`deployed:${HASH}`, `deployed:${'ab'.repeat(32)}`, '--out', 'x.wasm'], {}],
  ];
  for (const [args, files] of cases) {
    const result = await runKeeping(args, files, ['x.wasm']);
    assert.equal(result.status, 2, args.join(' '));
    assert.match(result.stderr, /--out saves one deployed Wasm/);
    assert.equal(result.after['x.wasm'], null);
  }
  assert.throws(() => parseArgs([`deployed:${HASH}`, '--out']), /--out needs a value/);
});

test('--out into a place that cannot be written is an error that names the file', async () => {
  const rpc = await rpcServing();
  try {
    const result = await runKeeping(['--rpc-url', rpc.url, `deployed:${HASH}`, '--out', 'no-such-directory/saved.wasm'], {}, []);
    assert.equal(result.status, 2);
    assert.match(result.stderr, /^error: no-such-directory\/saved\.wasm: ENOENT/);
  } finally {
    await rpc.close();
  }
});

test('--out works together with --json, keeping stdout to the JSON alone', async () => {
  const rpc = await rpcServing();
  try {
    const result = await runKeeping(['--json', '--rpc-url', rpc.url, `deployed:${HASH}`, '--out', 'saved.wasm'], {}, ['saved.wasm']);
    assert.equal(result.status, 0, result.stderr);
    assert.equal(JSON.parse(result.stdout).sha256, HASH);
    assert.match(result.stderr, /^Saved 1204 bytes/);
    assert.notEqual(result.after['saved.wasm'], null);
  } finally {
    await rpc.close();
  }
});
