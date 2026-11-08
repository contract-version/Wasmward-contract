import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';
import { LEDGERS_PER_DAY } from './audit-fleet.mjs';
import { codeKeyXdr, instanceKeyXdr } from './ledger-keys.mjs';
import {
  buildUpgradePlan,
  generateRollbackManifest,
  inspectCandidateWasm,
  main,
  MAX_SOROBAN_WASM_BYTES,
  parseArgs,
  renderPlanMarkdown,
  renderPlanText,
} from './upgrade-plan.mjs';
import { parseCodeEntry } from './wasm-code.mjs';

const recorded = JSON.parse(readFileSync(new URL('./fixtures/testnet-code-entries.json', import.meta.url), 'utf8'));
const v1Bytes = parseCodeEntry(recorded.builds.v1.xdr).code;
const v2Bytes = parseCodeEntry(recorded.builds.v2.xdr).code;
const V1 = recorded.builds.v1.wasmHash;
const V2 = recorded.builds.v2.wasmHash;
const ID = 'CBR5ZFDI2GBXG66DAEWWHSAK4NDLKSKHWVUEUSOM4UOBM66TI6DYPDPV';
const FIXED_NOW = Date.parse('2026-11-08T00:00:00Z');

const u32 = (...values) => Buffer.from(values.flatMap((v) => [(v >>> 24) & 255, (v >>> 16) & 255, (v >>> 8) & 255, v & 255]));
const instanceXdr = (hash) => Buffer.concat([u32(6, 0, 1), Buffer.alloc(32, 3), u32(20, 1, 19, 0), Buffer.from(hash, 'hex')]).toString('base64');

function sampleConfig() {
  return {
    network: {
      rpcUrl: 'https://soroban-testnet.stellar.org',
      passphrase: 'Test SDF Network ; September 2015',
    },
    contracts: {
      fixture: {
        contractId: ID,
        supported: [
          { wasmHash: V1, label: 'v1' },
          { wasmHash: V2, label: 'v2' },
        ],
      },
    },
  };
}

function fakeLookup({ live = V1, instanceDays = 20, codeDays = { [V1]: 20, [V2]: 20 }, instancePresent = true } = {}) {
  return async (key) => {
    if (key === instanceKeyXdr(ID)) {
      if (!instancePresent) return { latestLedger: 500, entries: [] };
      return {
        latestLedger: 500,
        entries: [{ xdr: instanceXdr(live), liveUntilLedgerSeq: 500 + Math.round(instanceDays * LEDGERS_PER_DAY) }],
      };
    }
    for (const [hash, days] of Object.entries(codeDays)) {
      if (key === codeKeyXdr(hash)) {
        if (days === null || days === undefined) return { latestLedger: 500, entries: [] };
        return {
          latestLedger: 500,
          entries: [{ liveUntilLedgerSeq: 500 + Math.round(days * LEDGERS_PER_DAY) }],
        };
      }
    }
    return { latestLedger: 500, entries: [] };
  };
}

test('parseArgs reads candidate file or target-label and validates flags', () => {
  const byFile = parseArgs(['build/v2.wasm']);
  assert.equal(byFile.wasm, 'build/v2.wasm');
  assert.equal(byFile.minDays, 3);
  assert.equal(byFile.offline, false);

  const byFlags = parseArgs([
    '--wasm', 'v2.wasm',
    '--target-label', 'v2',
    '--contract', 'fixture',
    '--min-days', '5',
    '--warn-ledgers', '90000',
    '--offline',
    '--rollback-out', 'rollback.json',
    '--json',
    '--verbose',
  ]);
  assert.equal(byFlags.wasm, 'v2.wasm');
  assert.equal(byFlags.targetLabel, 'v2');
  assert.equal(byFlags.contract, 'fixture');
  assert.equal(byFlags.minDays, 5);
  assert.equal(byFlags.warnLedgers, 90000);
  assert.equal(byFlags.offline, true);
  assert.equal(byFlags.rollbackOut, 'rollback.json');
  assert.equal(byFlags.json, true);
  assert.equal(byFlags.verbose, true);

  assert.throws(() => parseArgs([]), /give --wasm <file\.wasm> or --target-label <label>/);
  assert.throws(() => parseArgs(['a.wasm', 'b.wasm']), /unexpected positional argument b\.wasm/);
  assert.throws(() => parseArgs(['--wasm', 'a.wasm', '--json', '--markdown']), /cannot be used together/);
  assert.throws(() => parseArgs(['--wasm', 'a.wasm', '--min-days', '-1']), /--min-days must be/);
  assert.throws(() => parseArgs(['--nope']), /unknown option --nope/);
});

test('inspectCandidateWasm validates real deployed v1 and v2 binaries', () => {
  const v2Info = inspectCandidateWasm(v2Bytes);
  assert.equal(v2Info.ok, true);
  assert.equal(v2Info.sha256, V2);
  assert.equal(v2Info.size, 1204);
  assert.equal(v2Info.codeLedgerKey, codeKeyXdr(V2));
  assert.equal(v2Info.interfaceProtocol, 26);
  assert.equal(v2Info.hasSpecSection, true);
  assert.equal(v2Info.hasEnvMetaSection, true);
  assert.equal(v2Info.hasMetaSection, true);
  assert.deepEqual(v2Info.functions, ['__constructor', 'upgrade', 'version']);
  assert.deepEqual(v2Info.issues, []);
});

test('inspectCandidateWasm catches bare Wasm, oversized binaries, and leaked machine paths', () => {
  const bare = Buffer.from('0061736d01000000', 'hex');
  const bareReport = inspectCandidateWasm(bare);
  assert.equal(bareReport.ok, false);
  assert.ok(bareReport.issues.some((i) => i.includes('contractenvmetav0')));
  assert.ok(bareReport.issues.some((i) => i.includes('contractspecv0')));
  assert.ok(bareReport.issues.some((i) => i.includes('missing required exported functions')));

  const smallCap = inspectCandidateWasm(v1Bytes, { maxBytes: 500 });
  assert.equal(smallCap.ok, false);
  assert.ok(smallCap.issues.some((i) => i.includes('exceeds maximum limit')));
  assert.equal(MAX_SOROBAN_WASM_BYTES, 65_536);

  // Append a custom section with a leaked home path
  const leakPayload = Buffer.from('\x04leak/home/alice/secret/src/lib.rs', 'utf8');
  const leakSection = Buffer.concat([Buffer.from([0, leakPayload.length]), leakPayload]);
  const leakyWasm = Buffer.concat([v2Bytes, leakSection]);
  const leakReport = inspectCandidateWasm(leakyWasm);
  assert.equal(leakReport.ok, false);
  assert.ok(leakReport.issues.some((i) => i.includes('build-machine path')));
});

test('generateRollbackManifest computes ledger keys and upgrade/rollback CLI commands', () => {
  const manifest = generateRollbackManifest({
    contractName: 'fixture',
    contractId: ID,
    networkPassphrase: 'Test SDF Network ; September 2015',
    rpcUrl: 'https://soroban-testnet.stellar.org',
    candidateHash: V2,
    candidateLabel: 'v2',
    rollbackHash: V1,
    rollbackLabel: 'v1',
    nowIso: '2026-11-08T00:00:00.000Z',
  });
  assert.equal(manifest.contractId, ID);
  assert.equal(manifest.ledgerKeys.instance, instanceKeyXdr(ID));
  assert.equal(manifest.ledgerKeys.candidateCode, codeKeyXdr(V2));
  assert.equal(manifest.ledgerKeys.rollbackCode, codeKeyXdr(V1));
  assert.match(manifest.target.upgradeCommand, new RegExp(`--new_wasm_hash ${V2}$`));
  assert.match(manifest.rollback.rollbackCommand, new RegExp(`--new_wasm_hash ${V1}$`));
});

test('buildUpgradePlan succeeds online when candidate Wasm, live state, and TTLs are healthy', async () => {
  const plan = await buildUpgradePlan(
    sampleConfig(),
    { targetLabel: 'v2', minDays: 3, offline: false },
    { wasmBytes: v2Bytes, lookup: fakeLookup({ live: V1 }), nowMs: FIXED_NOW },
  );
  assert.equal(plan.ok, true);
  assert.equal(plan.mode, 'online');
  assert.equal(plan.candidate.wasmHash, V2);
  assert.equal(plan.liveState.label, 'v1');
  assert.equal(plan.liveState.alreadyOnCandidate, false);
  assert.equal(plan.rollbackManifest.rollback.wasmHash, V1);
  assert.ok(plan.checks.every((c) => c.ok));
});

test('buildUpgradePlan flags hash mismatch between --wasm and --target-label', async () => {
  const plan = await buildUpgradePlan(
    sampleConfig(),
    { targetLabel: 'v2', minDays: 3, offline: true },
    { wasmBytes: v1Bytes, nowMs: FIXED_NOW },
  );
  assert.equal(plan.ok, false);
  const alignment = plan.checks.find((c) => c.name === 'target-label-alignment');
  assert.equal(alignment.ok, false);
  assert.match(alignment.detail, /does not match configured v2 hash/);
});

test('buildUpgradePlan blocks when candidate Wasm code is not uploaded or rollback TTL is too low', async () => {
  const notUploaded = await buildUpgradePlan(
    sampleConfig(),
    { targetLabel: 'v2', minDays: 3, offline: false },
    { wasmBytes: v2Bytes, lookup: fakeLookup({ live: V1, codeDays: { [V1]: 20, [V2]: null } }), nowMs: FIXED_NOW },
  );
  assert.equal(notUploaded.ok, false);
  assert.equal(notUploaded.checks.find((c) => c.name === 'candidate-code-ttl').ok, false);

  const lowRollbackTtl = await buildUpgradePlan(
    sampleConfig(),
    { targetLabel: 'v2', minDays: 5, offline: false },
    { wasmBytes: v2Bytes, lookup: fakeLookup({ live: V1, codeDays: { [V1]: 2, [V2]: 20 } }), nowMs: FIXED_NOW },
  );
  assert.equal(lowRollbackTtl.ok, false);
  assert.equal(lowRollbackTtl.checks.find((c) => c.name === 'rollback-code-ttl').ok, false);
});

test('renderPlanText and renderPlanMarkdown output detailed readiness and rollback instructions', async () => {
  const plan = await buildUpgradePlan(
    sampleConfig(),
    { targetLabel: 'v2', minDays: 3, offline: false },
    { wasmBytes: v2Bytes, lookup: fakeLookup({ live: V1 }), nowMs: FIXED_NOW },
  );
  const text = renderPlanText(plan, { verbose: true }).join('\n');
  assert.match(text, /Upgrade Readiness Plan: fixture .* — READY/);
  assert.match(text, /Candidate Binary Details:/);
  assert.match(text, /Rollback Plan:/);

  const md = renderPlanMarkdown(plan).join('\n');
  assert.match(md, /^# Upgrade Readiness Plan: `fixture`/m);
  assert.match(md, /\| `candidate-wasm-binary` \| PASS \|/);
  assert.match(md, /## Rollback Manifest/);
});

test('main writes rollback manifest when --rollback-out is given and refuses to overwrite', async () => {
  const written = {};
  const code = await main(
    ['--wasm', 'v2.wasm', '--target-label', 'v2', '--offline', '--rollback-out', 'rb.json', '--json'],
    {
      readText: () => JSON.stringify(sampleConfig()),
      readBytes: () => v2Bytes,
      writeText: (path, text) => {
        written[path] = text;
      },
    },
  );
  assert.equal(code, 0);
  const saved = JSON.parse(written['rb.json']);
  assert.equal(saved.target.wasmHash, V2);
  assert.equal(saved.rollback.wasmHash, V1);

  const existsCode = await main(
    ['--target-label', 'v2', '--offline', '--rollback-out', 'rb.json'],
    {
      readText: () => JSON.stringify(sampleConfig()),
      writeText: () => {
        throw Object.assign(new Error('exists'), { code: 'EEXIST' });
      },
    },
  );
  assert.equal(existsCode, 2);
});

const runCli = (args) =>
  new Promise((resolve) =>
    execFile(process.execPath, ['scripts/upgrade-plan.mjs', ...args], (error, stdout, stderr) =>
      resolve({ status: error ? error.code : 0, stdout, stderr }),
    ),
  );

test('CLI --help prints description and exit codes, and invalid flags exit 2', async () => {
  const help = await runCli(['--help']);
  assert.equal(help.status, 0);
  assert.match(help.stdout, /node scripts\/upgrade-plan\.mjs/);
  assert.match(help.stdout, /Exit codes:/);

  const bad = await runCli(['--unknown-option']);
  assert.equal(bad.status, 2);
  assert.match(bad.stderr, /unknown option --unknown-option/);
});
