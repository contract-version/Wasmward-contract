import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { copyFileSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';

// redeploy.sh runs the real scripts in order. Here each of them is a stand-in that only writes down how it was called
// (and fails when the test says so), so the order, the stopping and the messages can be checked with no network and no key.

const STEPS = ['deploy.sh', 'sync-config.mjs', 'extend.sh', 'sync-siblings.mjs', 'record-testnet.mjs', 'sync-siblings.mjs --check'];

function sandbox() {
  const dir = mkdtempSync(join(tmpdir(), 'redeploy-'));
  mkdirSync(join(dir, 'scripts'));
  copyFileSync(new URL('./redeploy.sh', import.meta.url), join(dir, 'scripts', 'redeploy.sh'));
  const calls = join(dir, 'calls.log');
  writeFileSync(calls, '');
  for (const name of ['deploy.sh', 'extend.sh']) {
    writeFileSync(join(dir, 'scripts', name), `#!/usr/bin/env bash\nline="${name} $*"; line="\${line% }"\necho "$line" >> "${calls.replaceAll('\\', '/')}"\n[ "\${STUB_FAIL:-}" != "$line" ] || exit 1\n`);
  }
  for (const name of ['sync-config.mjs', 'sync-siblings.mjs', 'record-testnet.mjs']) {
    writeFileSync(
      join(dir, 'scripts', name),
      `import { appendFileSync } from 'node:fs';\nconst line = ['${name}', ...process.argv.slice(2)].join(' ');\nappendFileSync(${JSON.stringify(calls)}, line + '\\n');\nif (process.env.STUB_FAIL === line) process.exit(1);\n`,
    );
  }
  return {
    calls: () => readFileSync(calls, 'utf8').split('\n').filter(Boolean),
    run: (args, env = {}) =>
      new Promise((resolve) =>
        execFile('bash', ['scripts/redeploy.sh', ...args], { cwd: dir, env: { ...process.env, ...env } }, (error, stdout, stderr) => resolve({ status: error ? error.code : 0, stdout, stderr })),
      ),
    cleanup: () => rmSync(dir, { recursive: true, force: true }),
  };
}

async function inBox(body) {
  const box = sandbox();
  try {
    await body(box);
  } finally {
    box.cleanup();
  }
}

test('runs the six steps in order, and says what it leaves for the person', async () => {
  await inBox(async (box) => {
    const run = await box.run(['--yes']);
    assert.equal(run.status, 0, run.stderr);
    assert.deepEqual(box.calls(), STEPS);
    assert.match(run.stderr, /All 6 steps passed\./);
    assert.match(run.stderr, /Not done: run the tests in Wasmward-frontend and Wasmward-backend, commit what changed in the three repositories, and push/);
  });
});

test('the order is the one that works: the config before the extend, the extend before the recording, the check last', async () => {
  await inBox(async (box) => {
    await box.run(['--yes']);
    const calls = box.calls();
    assert.ok(calls.indexOf('deploy.sh') < calls.indexOf('sync-config.mjs'));
    assert.ok(calls.indexOf('sync-config.mjs') < calls.indexOf('extend.sh'), 'extend.sh checks the fixture named in fixture.wasmward.json');
    assert.ok(calls.indexOf('extend.sh') < calls.indexOf('record-testnet.mjs'), 'the recording needs a healthy v1');
    assert.ok(calls.indexOf('sync-siblings.mjs') < calls.indexOf('record-testnet.mjs'));
    assert.equal(calls.at(-1), 'sync-siblings.mjs --check');
  });
});

test('without --yes it deploys nothing, and says why', async () => {
  await inBox(async (box) => {
    const run = await box.run([]);
    assert.equal(run.status, 2);
    assert.match(run.stderr, /deploys a new contract to testnet.*--yes.*--dry-run/);
    assert.deepEqual(box.calls(), []);
  });
});

test('--dry-run lists the six steps on stdout and runs none of them, with or without --yes', async () => {
  await inBox(async (box) => {
    for (const args of [['--dry-run'], ['--dry-run', '--yes'], ['--yes', '--dry-run']]) {
      const run = await box.run(args);
      assert.equal(run.status, 0, run.stderr);
      assert.deepEqual(run.stdout.trim().split('\n'), STEPS.map((step, index) => `would run ${index + 1}: ${/\.sh/.test(step) ? 'bash' : 'node'} scripts/${step}`));
      assert.match(run.stderr, /Dry run: nothing was run\./);
    }
    assert.deepEqual(box.calls(), []);
  });
});

test('a failing step stops the run, is named with its number, and no later step runs', async () => {
  for (const [failing, ran] of [
    ['deploy.sh', 1],
    ['sync-config.mjs', 2],
    ['extend.sh', 3],
    ['sync-siblings.mjs', 4],
    ['record-testnet.mjs', 5],
    ['sync-siblings.mjs --check', 6],
  ]) {
    await inBox(async (box) => {
      const run = await box.run(['--yes'], { STUB_FAIL: failing });
      assert.equal(run.status, 1, failing);
      assert.equal(box.calls().length, ran, `${failing}: ${box.calls().join(' | ')}`);
      assert.match(run.stderr, new RegExp(`error: step ${ran} failed`));
      assert.match(run.stderr, /docs\/RECOVERY\.md/);
      assert.doesNotMatch(run.stderr, /All 6 steps passed/);
    });
  }
});

test('a failed deploy never reaches the steps that would write a half-made contract into the other repositories', async () => {
  await inBox(async (box) => {
    await box.run(['--yes'], { STUB_FAIL: 'deploy.sh' });
    assert.deepEqual(box.calls(), ['deploy.sh']);
  });
});

test('--help prints the description, with the steps and the exit codes, and runs nothing', async () => {
  await inBox(async (box) => {
    const run = await box.run(['--help']);
    assert.equal(run.status, 0);
    assert.match(run.stderr, /Redeploys the testnet fixture/);
    assert.match(run.stderr, /Exit codes: 0 all six steps passed/);
    assert.deepEqual(box.calls(), []);
  });
});

test('an unknown argument is refused with the usage, before anything runs', async () => {
  await inBox(async (box) => {
    const run = await box.run(['--yes', '--fast']);
    assert.equal(run.status, 2);
    assert.match(run.stderr, /error: unknown argument '--fast'/);
    assert.deepEqual(box.calls(), []);
  });
});

test('every script it runs exists in this repository, and the steps it lists are the ones in the recovery guide', () => {
  const real = (name) => readFileSync(new URL(`./${name.split(' ')[0]}`, import.meta.url), 'utf8');
  for (const step of STEPS) assert.ok(real(step).length > 0, `${step} does not exist`);
  const source = readFileSync(new URL('./redeploy.sh', import.meta.url), 'utf8');
  for (const step of STEPS) assert.ok(source.includes(step.replace(/^/, step.endsWith('.sh') ? 'bash scripts/' : 'node scripts/')), `redeploy.sh does not run ${step}`);
  const guide = readFileSync(new URL('../docs/RECOVERY.md', import.meta.url), 'utf8');
  for (const script of ['deploy.sh', 'sync-config.mjs', 'sync-siblings.mjs', 'record-testnet.mjs']) assert.ok(guide.includes(script), `docs/RECOVERY.md does not mention ${script}`);
});
