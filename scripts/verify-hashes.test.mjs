import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { createHash } from 'node:crypto';
import { chmodSync, copyFileSync, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { delimiter, join } from 'node:path';
import { test } from 'node:test';

// verify-hashes.sh rebuilds with the Stellar CLI and compares with the pinned hashes. Here the CLI is a stand-in whose
// "build" is a function of the variant, so what the script does with the answer can be checked without Rust.

const sha256 = (text) => createHash('sha256').update(text).digest('hex');
const builtAs = (variant) => `wasm-built-as-${variant}`;
const V1 = sha256(builtAs('v1'));
const V2 = sha256(builtAs('v2'));

const STUB = `#!/usr/bin/env bash
printf '%s\\n' "$*" >> "$STELLAR_CALLS"
[ "$1 $2" = "contract build" ] || exit 0
out=""; variant=v1
while [ $# -gt 0 ]; do
  case "$1" in
    --out-dir) out="$2"; shift ;;
    --features) variant=v2 ;;
  esac
  shift
done
[ -z "\${STUB_BUILD_FAILS:-}" ] || { echo "stub: build failed" >&2; exit 1; }
[ -z "\${STUB_NO_OUTPUT:-}" ] || exit 0
mkdir -p "$out"
printf 'wasm-built-as-%s' "$variant" > "$out/wasmward_fixture.wasm"
`;

const config = (v1, v2) => ({
  version: 1,
  network: { rpcUrl: 'https://rpc.example.org', passphrase: 'x' },
  contracts: { fixture: { contractId: 'C'.padEnd(56, 'A'), supported: [{ wasmHash: v1, label: 'v1' }, { wasmHash: v2, label: 'v2' }] } },
});

/** A copy of the script in a throwaway folder, with a stand-in `stellar` first on the PATH. */
function sandbox(content = config(V1, V2)) {
  const dir = mkdtempSync(join(tmpdir(), 'verify-hashes-'));
  mkdirSync(join(dir, 'scripts'));
  copyFileSync(new URL('./verify-hashes.sh', import.meta.url), join(dir, 'scripts', 'verify-hashes.sh'));
  if (content !== undefined) writeFileSync(join(dir, 'fixture.wasmward.json'), typeof content === 'string' ? content : JSON.stringify(content));
  const bin = join(dir, 'bin');
  mkdirSync(bin);
  writeFileSync(join(bin, 'stellar'), STUB);
  chmodSync(join(bin, 'stellar'), 0o755);
  const calls = join(dir, 'calls.log');
  writeFileSync(calls, '');
  return {
    dir,
    calls: () => readFileSync(calls, 'utf8').split('\n').filter(Boolean),
    leftovers: () => readdirSync(dir).sort(),
    run: (args = [], env = {}) =>
      new Promise((resolve) =>
        execFile('bash', ['scripts/verify-hashes.sh', ...args], { cwd: dir, env: { ...process.env, ...env, PATH: `${bin}${delimiter}${process.env.PATH}`, STELLAR_CALLS: calls } }, (error, stdout, stderr) =>
          resolve({ status: error ? error.code : 0, stdout, stderr }),
        ),
      ),
    cleanup: () => rmSync(dir, { recursive: true, force: true }),
  };
}

async function inBox(options, body) {
  const box = sandbox(options);
  try {
    await body(box);
  } finally {
    box.cleanup();
  }
}

test('exit 0 and one line per build when both builds have the pinned hash', async () => {
  await inBox(undefined, async (box) => {
    const run = await box.run();
    assert.equal(run.status, 0, run.stderr);
    assert.match(run.stdout, new RegExp(`^v1  ${V1.slice(0, 8)}\\.\\.\\.  matches the pinned hash$`, 'm'));
    assert.match(run.stdout, new RegExp(`^v2  ${V2.slice(0, 8)}\\.\\.\\.  matches the pinned hash$`, 'm'));
  });
});

test('it builds both variants locked, with the v2 feature for the second, and nothing else', async () => {
  await inBox(undefined, async (box) => {
    await box.run();
    const calls = box.calls();
    assert.equal(calls.length, 2);
    assert.match(calls[0], /^contract build --locked --out-dir \S+v1$/);
    assert.match(calls[1], /^contract build --locked --features v2 --out-dir \S+v2$/);
  });
});

test('exit 1, with the built and the pinned hash, when a build is not the pinned one', async () => {
  await inBox(config(V1, 'ab'.repeat(32)), async (box) => {
    const run = await box.run();
    assert.equal(run.status, 1);
    assert.match(run.stdout, /^v1  .*matches the pinned hash$/m, 'the build that matches is still reported');
    assert.match(run.stderr, new RegExp(`^v2  built ${V2}$`, 'm'));
    assert.match(run.stderr, new RegExp(`^v2  pinned ${'ab'.repeat(32)}$`, 'm'));
    assert.match(run.stderr, /no longer builds the deployed fixture/);
    assert.match(run.stderr, /CONTRIBUTING\.md/);
  });
});

test('both builds can be wrong at once, and both are named', async () => {
  await inBox(config('cd'.repeat(32), 'ab'.repeat(32)), async (box) => {
    const run = await box.run();
    assert.equal(run.status, 1);
    assert.match(run.stderr, /^v1  built /m);
    assert.match(run.stderr, /^v2  built /m);
  });
});

test('the build goes to a temporary folder, which is removed, and the repository gets nothing new', async () => {
  await inBox(undefined, async (box) => {
    const before = box.leftovers();
    await box.run();
    assert.deepEqual(box.leftovers().filter((name) => !before.includes(name) && name !== 'calls.log'), []);
    assert.ok(!existsSync(join(box.dir, 'build')), 'build/ was created');
  });
});

test('exit 2 when the build fails, saying which', async () => {
  await inBox(undefined, async (box) => {
    const run = await box.run([], { STUB_BUILD_FAILS: '1' });
    assert.equal(run.status, 2);
    assert.match(run.stderr, /error: the v1 build failed/);
  });
});

test('exit 2 when the build produced no Wasm', async () => {
  await inBox(undefined, async (box) => {
    const run = await box.run([], { STUB_NO_OUTPUT: '1' });
    assert.equal(run.status, 2);
    assert.match(run.stderr, /the v1 build did not produce wasmward_fixture\.wasm/);
  });
});

test('exit 2 when the config is missing, or has no valid hash for a label', async () => {
  await inBox(undefined, async (box) => {
    const run = await box.run(['--config', 'nope.json']);
    assert.equal(run.status, 2);
    assert.match(run.stderr, /nope\.json not found/);
    assert.deepEqual(box.calls(), [], 'it must not build before it knows what to compare with');
  });
  await inBox(config(V1, 'not-a-hash'), async (box) => {
    const run = await box.run();
    assert.equal(run.status, 2);
    assert.match(run.stderr, /no valid hash for the build labelled v2/);
    assert.deepEqual(box.calls(), []);
  });
  await inBox('{ not json', async (box) => {
    const run = await box.run();
    assert.equal(run.status, 2);
    assert.match(run.stderr, /no valid hash for the build labelled v1/);
  });
});

test('--config picks another file, and a missing value or an unknown argument is refused', async () => {
  await inBox(undefined, async (box) => {
    writeFileSync(join(box.dir, 'other.json'), JSON.stringify(config(V1, V2)));
    assert.equal((await box.run(['--config', 'other.json'])).status, 0);
    for (const args of [['--config'], ['--config', '--help'], ['--dry-run'], ['extra']]) {
      const run = await box.run(args);
      assert.equal(run.status, 2, `${args.join(' ')}: ${run.stderr}`);
    }
  });
});

test('--help prints the usage and exits 0 without building', async () => {
  await inBox(undefined, async (box) => {
    const run = await box.run(['--help']);
    assert.equal(run.status, 0);
    assert.match(run.stderr, /Usage: bash scripts\/verify-hashes\.sh/);
    assert.deepEqual(box.calls(), []);
  });
});
