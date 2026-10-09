import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { createHash } from 'node:crypto';
import { chmodSync, copyFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { delimiter, join } from 'node:path';
import { test } from 'node:test';

// deploy.sh builds the contract, uploads it to testnet, deploys it with a secret key and writes testnet.json.
// These tests run it in a throwaway copy of the repository with a stand-in `stellar`, so what it does (and what
// it must never do with the secret) can be checked without a network, an account or any money.

const SECRET = 'SBZVMB74Z76QZ3ZOY7UTDFYKMEGKW5XFJEB6PFKBF4UYSSWHG4EDH7PY';
const ADMIN = 'GDQP2KPQGKIHYJGXNUIYOMHARUARCA7DJT5FO2FFOOKY3B2WSQHG4W37';
const CONTRACT = 'CBR5ZFDI2GBXG66DAEWWHSAK4NDLKSKHWVUEUSOM4UOBM66TI6DYPDPV';

const sha256 = (text) => createHash('sha256').update(text).digest('hex');
/** What the stand-in "builds": the build is a function of the variant, so v1 and v2 differ, and so do their hashes. */
const builtWasm = (variant) => `wasm-built-as-${variant}`;

const STUB = `#!/usr/bin/env bash
printf '%s\\n' "$*" >> "$STELLAR_CALLS"
case "$1 $2" in
  "keys generate") exit 0 ;;
  "keys secret") echo "$STUB_SECRET" ;;
  "keys add")
    # The secret arrives on stdin. Keep a copy where the test can look, apart from the call log.
    cat > "$STELLAR_CALLS.stdin"
    [ -z "\${STUB_KEYS_ADD_FAILS:-}" ] || exit 1
    ;;
  "keys address") echo "$STUB_ADMIN" ;;
  "keys fund") [ -z "\${STUB_FUND_FAILS:-}" ] || exit 1 ;;
  "contract build")
    out=""; variant=v1
    while [ $# -gt 0 ]; do
      case "$1" in
        --out-dir) out="$2"; shift ;;
        --features) variant=v2 ;;
      esac
      shift
    done
    [ -z "\${STUB_SAME_BUILD:-}" ] || variant=v1
    mkdir -p "$out"
    printf 'wasm-built-as-%s' "$variant" > "$out/wasmward_fixture.wasm"
    ;;
  "contract upload")
    wasm=""
    while [ $# -gt 0 ]; do
      [ "$1" = "--wasm" ] && wasm="$2"
      shift
    done
    if [ -n "\${STUB_UPLOAD_HASH:-}" ]; then echo "$STUB_UPLOAD_HASH"; else sha256sum "$wasm" | cut -d' ' -f1; fi
    ;;
  "contract deploy") echo "\${STUB_DEPLOY_OUTPUT:-$STUB_CONTRACT}" ;;
esac
exit 0
`;

/** A copy of the repository with the stub `stellar`, and a function that runs deploy.sh in it. */
function sandbox({ env: dotenv } = {}) {
  const dir = mkdtempSync(join(tmpdir(), 'deploy-'));
  mkdirSync(join(dir, 'scripts'));
  copyFileSync(new URL('./deploy.sh', import.meta.url), join(dir, 'scripts', 'deploy.sh'));
  if (dotenv !== undefined) writeFileSync(join(dir, '.env'), dotenv);
  const bin = join(dir, 'bin');
  mkdirSync(bin);
  writeFileSync(join(bin, 'stellar'), STUB);
  chmodSync(join(bin, 'stellar'), 0o755);
  const calls = join(dir, 'calls.log');
  writeFileSync(calls, '');

  return {
    dir,
    calls: () => readFileSync(calls, 'utf8').split('\n').filter(Boolean),
    stdin: () => (existsSync(`${calls}.stdin`) ? readFileSync(`${calls}.stdin`, 'utf8') : null),
    file: (name) => (existsSync(join(dir, name)) ? readFileSync(join(dir, name), 'utf8') : null),
    run: (env = {}) =>
      new Promise((resolve) => {
        execFile(
          'bash',
          ['scripts/deploy.sh'],
          {
            cwd: dir,
            env: {
              ...process.env,
              FIXTURE_SECRET: '',
              STUB_SECRET: SECRET,
              STUB_ADMIN: ADMIN,
              STUB_CONTRACT: CONTRACT,
              ...env,
              PATH: `${bin}${delimiter}${process.env.PATH}`,
              STELLAR_CALLS: calls,
            },
          },
          (error, stdout, stderr) => resolve({ status: error ? error.code : 0, stdout, stderr }),
        );
      }),
    cleanup: () => rmSync(dir, { recursive: true, force: true }),
  };
}

test('deploys v1 and writes testnet.json with the hashes of what was built', async () => {
  const box = sandbox();
  try {
    const run = await box.run();
    assert.equal(run.status, 0, run.stderr);
    const written = JSON.parse(box.file('testnet.json'));
    assert.equal(written.network, 'testnet');
    assert.equal(written.contractId, CONTRACT);
    assert.equal(written.admin, ADMIN);
    assert.equal(written.v1.wasmHash, sha256(builtWasm('v1')));
    assert.equal(written.v2.wasmHash, sha256(builtWasm('v2')));
    assert.notEqual(written.v1.wasmHash, written.v2.wasmHash);
    assert.equal(written.v1.file, 'build/v1/wasmward_fixture.wasm');
    assert.match(written.deployedAt, /^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\dZ$/);
  } finally {
    box.cleanup();
  }
});

test('uploads both builds, deploys the v1 hash, and passes the admin to the constructor', async () => {
  const box = sandbox();
  try {
    assert.equal((await box.run()).status, 0);
    const calls = box.calls();
    const uploads = calls.filter((call) => call.startsWith('contract upload'));
    assert.equal(uploads.length, 2);
    assert.match(uploads[0], /--wasm build\/v1\/wasmward_fixture\.wasm /);
    assert.match(uploads[1], /--wasm build\/v2\/wasmward_fixture\.wasm /);
    const deploy = calls.find((call) => call.startsWith('contract deploy'));
    assert.match(deploy, new RegExp(`--wasm-hash ${sha256(builtWasm('v1'))} `));
    assert.match(deploy, new RegExp(` -- --admin ${ADMIN}$`));
    assert.equal(calls.filter((call) => call.startsWith('contract build')).length, 2);
    assert.ok(calls.some((call) => call.startsWith('contract build') && call.includes('--features v2')));
  } finally {
    box.cleanup();
  }
});

test('generates an identity when there is no secret, and saves it only to .env', async () => {
  const box = sandbox();
  try {
    assert.equal((await box.run()).status, 0);
    assert.equal(box.file('.env'), `FIXTURE_SECRET=${SECRET}\n`);
    assert.ok(box.calls().some((call) => call.startsWith('keys generate generated --as-secret')));
  } finally {
    box.cleanup();
  }
});

test('uses the secret from .env instead of generating one, and never writes it back', async () => {
  const box = sandbox({ env: `FIXTURE_SECRET=${SECRET}\n` });
  try {
    assert.equal((await box.run({ STUB_SECRET: 'SOMETHINGELSEENTIRELY' })).status, 0);
    assert.ok(!box.calls().some((call) => call.startsWith('keys generate')));
    assert.equal(box.file('.env'), `FIXTURE_SECRET=${SECRET}\n`, '.env was changed');
    assert.equal(box.stdin(), SECRET, 'the identity was imported from a different secret');
  } finally {
    box.cleanup();
  }
});

test('the secret is handed over on stdin, never in a command line, and never printed', async () => {
  for (const dotenv of [undefined, `FIXTURE_SECRET=${SECRET}\n`]) {
    const box = sandbox({ env: dotenv });
    try {
      const run = await box.run();
      assert.equal(run.status, 0, run.stderr);
      assert.equal(box.stdin(), SECRET);
      assert.ok(!box.calls().some((call) => call.includes(SECRET)), 'the secret was in a command line (visible to other users)');
      assert.ok(!run.stdout.includes(SECRET) && !run.stderr.includes(SECRET), 'the secret was printed');
      assert.ok(!(box.file('testnet.json') ?? '').includes(SECRET), 'the secret is in testnet.json');
    } finally {
      box.cleanup();
    }
  }
});

const OLD_TESTNET_JSON = '{"contractId":"the previous deployment"}\n';

/** Files a sandbox should still hold after a run that failed: nothing was deployed, nothing was overwritten. */
function sandboxWithPreviousDeployment() {
  const box = sandbox();
  writeFileSync(join(box.dir, 'testnet.json'), OLD_TESTNET_JSON);
  return box;
}

test('stops, deploys nothing and keeps the old testnet.json when the v1 hash on chain is not the one built', async () => {
  const box = sandboxWithPreviousDeployment();
  try {
    const run = await box.run({ STUB_UPLOAD_HASH: 'ab'.repeat(32) });
    assert.equal(run.status, 1);
    assert.match(run.stderr, /error: v1 hash mismatch: local [0-9a-f]{64}, on-chain abab/);
    assert.ok(!box.calls().some((call) => call.startsWith('contract deploy')), 'it deployed anyway');
    assert.equal(box.file('testnet.json'), OLD_TESTNET_JSON);
  } finally {
    box.cleanup();
  }
});

test('treats an upload that prints Windows line endings as the same hash', async () => {
  const box = sandbox();
  try {
    const run = await box.run({ STUB_UPLOAD_HASH: `${sha256(builtWasm('v1'))}\r` });
    // v2's upload prints the same value, so v2 is the one that does not match; v1 passing is the point here.
    assert.match(run.stderr, /error: v2 hash mismatch/);
    assert.ok(!run.stderr.includes('v1 hash mismatch'));
  } finally {
    box.cleanup();
  }
});

test('stops before uploading when v1 and v2 build to the same bytes', async () => {
  const box = sandboxWithPreviousDeployment();
  try {
    const run = await box.run({ STUB_SAME_BUILD: '1' });
    assert.equal(run.status, 1);
    assert.match(run.stderr, /v1 and v2 have the same hash; the v2 feature had no effect/);
    assert.ok(!box.calls().some((call) => call.startsWith('contract upload')), 'it uploaded identical builds');
    assert.equal(box.file('testnet.json'), OLD_TESTNET_JSON);
  } finally {
    box.cleanup();
  }
});

test('refuses a deploy result that is not a contract address, and keeps the old testnet.json', async () => {
  const box = sandboxWithPreviousDeployment();
  try {
    const run = await box.run({ STUB_DEPLOY_OUTPUT: 'Error: transaction failed' });
    assert.equal(run.status, 1);
    assert.match(run.stderr, /error: unexpected deploy output: Error: transaction failed/);
    assert.equal(box.file('testnet.json'), OLD_TESTNET_JSON);
  } finally {
    box.cleanup();
  }
});

test('stops before building when the secret cannot be imported, without echoing it', async () => {
  const box = sandbox({ env: `FIXTURE_SECRET=${SECRET}\n` });
  try {
    const run = await box.run({ STUB_KEYS_ADD_FAILS: '1' });
    assert.equal(run.status, 1);
    assert.match(run.stderr, /could not import the identity from FIXTURE_SECRET/);
    assert.ok(!run.stderr.includes(SECRET) && !run.stdout.includes(SECRET));
    assert.ok(!box.calls().some((call) => call.startsWith('contract build')), 'it built with no usable identity');
  } finally {
    box.cleanup();
  }
});

test('carries on when friendbot cannot fund the account, in case it is already funded', async () => {
  const box = sandbox();
  try {
    const run = await box.run({ STUB_FUND_FAILS: '1' });
    assert.equal(run.status, 0, run.stderr);
    assert.match(run.stderr, /note: friendbot did not fund the account; continuing/);
    assert.ok(box.file('testnet.json') !== null);
  } finally {
    box.cleanup();
  }
});

test('writes testnet.json last, so any failure above leaves the previous one alone', async () => {
  const box = sandboxWithPreviousDeployment();
  try {
    assert.equal((await box.run()).status, 0);
    assert.notEqual(box.file('testnet.json'), OLD_TESTNET_JSON);
    assert.equal(JSON.parse(box.file('testnet.json')).contractId, CONTRACT);
  } finally {
    box.cleanup();
  }
});

test('tells the user what to run next', async () => {
  const box = sandbox();
  try {
    const run = await box.run();
    assert.match(run.stderr, /Next: node scripts\/sync-config\.mjs/);
  } finally {
    box.cleanup();
  }
});

/** Runs deploy.sh with these arguments in a fresh sandbox. */
async function runWithArguments(args) {
  const box = sandbox();
  const result = await new Promise((resolve) => {
    execFile('bash', ['scripts/deploy.sh', ...args], {
      cwd: box.dir,
      env: { ...process.env, FIXTURE_SECRET: '', STUB_SECRET: SECRET, STUB_ADMIN: ADMIN, STUB_CONTRACT: CONTRACT, PATH: `${join(box.dir, 'bin')}${delimiter}${process.env.PATH}`, STELLAR_CALLS: join(box.dir, 'calls.log') },
    }, (error, stdout, stderr) => resolve({ status: error ? error.code : 0, stdout, stderr }));
  });
  return { box, result };
}

test('--help prints the usage and exits 0 without touching anything', async () => {
  for (const flag of ['--help', '-h']) {
    const { box, result } = await runWithArguments([flag]);
    try {
      assert.equal(result.status, 0, result.stderr);
      assert.match(result.stderr, /Usage: bash scripts\/deploy\.sh/);
      assert.deepEqual(box.calls(), [], 'it called the Stellar CLI');
      assert.equal(box.file('.env'), null, 'it created .env');
      assert.equal(box.file('testnet.json'), null);
    } finally {
      box.cleanup();
    }
  }
});

test('refuses any argument it does not know, instead of ignoring it and deploying', async () => {
  for (const args of [['--dry-run'], ['--forever'], ['v2'], ['--dry-run', '--help-me'], ['']]) {
    const { box, result } = await runWithArguments(args);
    try {
      assert.equal(result.status, 1, `${JSON.stringify(args)} was accepted`);
      assert.match(result.stderr, /unknown argument/);
      assert.match(result.stderr, /Usage:/);
      assert.deepEqual(box.calls(), [], `${args.join(' ')} reached the Stellar CLI`);
      assert.equal(box.file('testnet.json'), null);
    } finally {
      box.cleanup();
    }
  }
});

test('--help is honoured wherever it is, even after an argument that would be refused', async () => {
  const { box, result } = await runWithArguments(['--dry-run', '--help']);
  try {
    assert.equal(result.status, 0);
    assert.match(result.stderr, /Usage:/);
    assert.deepEqual(box.calls(), []);
  } finally {
    box.cleanup();
  }
});
