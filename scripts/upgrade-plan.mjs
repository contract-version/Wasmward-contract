#!/usr/bin/env node
// Pre-upgrade readiness and rollback verifier: validates candidate Wasm files (size, Soroban section headers,
// ledger key computation, SHA-256 digest, machine-path leaks, and exported contract interface), compares against
// the current live hash and configured builds, checks TTL safety margins, and generates a rollback manifest.
//
//   node scripts/upgrade-plan.mjs [--wasm FILE] [--target-label LABEL] [--contract NAME]
//                                 [--config fixture.wasmward.json] [--min-days 3] [--warn-ledgers N]
//                                 [--offline] [--rollback-out FILE] [--json] [--markdown] [--verbose]
//                                 [--rpc-url URL] [--timeout-ms N] [--retries N]
//
// Give --wasm <file.wasm> to inspect a local candidate binary, or --target-label <label> to plan an upgrade to a
// build already listed in the config (or both, to verify the local file matches the configured label's hash).
// With --offline, only local Wasm inspection and config alignment checks are run, without contacting the RPC.
//
// Exit codes: 0 ready to upgrade with rollback verified, 1 candidate validation, hash alignment, or TTL check
// failed, 2 options, files, config, or RPC could not be used. No dependencies; needs Node 18 or newer.
import { readFileSync, writeFileSync } from 'node:fs';
import { pathToFileURL } from 'node:url';
import { computeTtlMetrics, parseWarnLedgers } from './audit-fleet.mjs';
import { EXPECTED_FUNCTIONS } from './check-builds.mjs';
import { parseRetries, parseRpcUrl, parseTimeout, valueAfter } from './cli-options.mjs';
import { helpFromHeader, wantsHelp } from './help.mjs';
import { parseInstanceEntry } from './instance-entry.mjs';
import { codeKeyXdr, instanceKeyXdr } from './ledger-keys.mjs';
import { rpcLookup } from './rpc.mjs';
import { metaValue, readWasm, sectionLabel } from './wasm-sections.mjs';
import { machinePaths } from './wasm-strings.mjs';

export const MAX_SOROBAN_WASM_BYTES = 65_536;

/** Parses command line arguments for upgrade-plan.mjs. */
export function parseArgs(argv) {
  const options = {
    config: 'fixture.wasmward.json',
    minDays: 3,
    offline: false,
    json: false,
    markdown: false,
    verbose: false,
    timeoutMs: 15_000,
  };
  for (let i = 0; i < argv.length; i += 1) {
    const word = argv[i];
    if (word === '--wasm') options.wasm = valueAfter(argv, i++, word);
    else if (word === '--target-label') options.targetLabel = valueAfter(argv, i++, word);
    else if (word === '--contract') options.contract = valueAfter(argv, i++, word);
    else if (word === '--config') options.config = valueAfter(argv, i++, word);
    else if (word === '--min-days') options.minDays = Number(valueAfter(argv, i++, word));
    else if (word === '--warn-ledgers') options.warnLedgers = parseWarnLedgers(valueAfter(argv, i++, word));
    else if (word === '--rollback-out') options.rollbackOut = valueAfter(argv, i++, word);
    else if (word === '--rpc-url') options.rpcUrl = parseRpcUrl(valueAfter(argv, i++, word));
    else if (word === '--timeout-ms') options.timeoutMs = parseTimeout(valueAfter(argv, i++, word));
    else if (word === '--retries') options.retries = parseRetries(valueAfter(argv, i++, word));
    else if (word === '--offline') options.offline = true;
    else if (word === '--json') options.json = true;
    else if (word === '--markdown') options.markdown = true;
    else if (word === '--verbose') options.verbose = true;
    else if (word.startsWith('--')) throw new Error(`unknown option ${word}`);
    else if (options.wasm === undefined) options.wasm = word;
    else throw new Error(`unexpected positional argument ${word}`);
  }
  if (!Number.isFinite(options.minDays) || options.minDays < 0) {
    throw new Error('--min-days must be a number of days, 0 or more');
  }
  if (options.json && options.markdown) {
    throw new Error('--json and --markdown cannot be used together');
  }
  if (options.wasm === undefined && options.targetLabel === undefined) {
    throw new Error('give --wasm <file.wasm> or --target-label <label> (or both)');
  }
  return options;
}

/**
 * Inspects a candidate Wasm binary buffer and checks Soroban section headers, metadata, exported functions,
 * size limits, machine-path leaks, and ledger key derivation.
 */
export function inspectCandidateWasm(bytes, { expectedFunctions = EXPECTED_FUNCTIONS, maxBytes = MAX_SOROBAN_WASM_BYTES } = {}) {
  const info = readWasm(bytes);
  const issues = [];
  const warnings = [];

  if (info.size > maxBytes) {
    issues.push(`Wasm size (${info.size} bytes) exceeds maximum limit (${maxBytes} bytes)`);
  }

  const compiler = metaValue(info, 'rsver') ?? null;
  const sdk = metaValue(info, 'rssdkver') ?? null;
  const cli = metaValue(info, 'cliver') ?? null;
  const interfaceProtocol = info.interface?.protocol ?? null;
  const hasSpecSection = info.sections.some((s) => s.id === 0 && s.name === 'contractspecv0');
  const hasEnvMetaSection = info.sections.some((s) => s.id === 0 && s.name === 'contractenvmetav0');
  const hasMetaSection = info.sections.some((s) => s.id === 0 && s.name === 'contractmetav0');

  if (!hasEnvMetaSection || interfaceProtocol === null) {
    issues.push('missing Soroban contractenvmetav0 interface protocol section');
  }
  if (!hasSpecSection) {
    issues.push('missing Soroban contractspecv0 interface specification section');
  }
  if (!hasMetaSection || compiler === null || sdk === null) {
    warnings.push('contractmetav0 compiler or SDK version is not recorded');
  }

  const missingFns = expectedFunctions.filter((fn) => !info.functions.includes(fn));
  const extraFns = info.functions.filter((fn) => !expectedFunctions.includes(fn));
  if (missingFns.length > 0) {
    issues.push(`missing required exported functions: ${missingFns.join(', ')}`);
  }
  if (extraFns.length > 0) {
    issues.push(`exports unexpected functions: ${extraFns.join(', ')}`);
  }

  const leakedPaths = machinePaths(bytes);
  if (leakedPaths.length > 0) {
    issues.push(`contains ${leakedPaths.length} build-machine path(s), starting with "${leakedPaths[0].text}" at byte ${leakedPaths[0].offset}`);
  }

  const codeLedgerKey = codeKeyXdr(info.sha256);

  return {
    ok: issues.length === 0,
    size: info.size,
    sha256: info.sha256,
    codeLedgerKey,
    compiler,
    sdk,
    cli,
    interfaceProtocol,
    hasSpecSection,
    hasEnvMetaSection,
    hasMetaSection,
    functions: info.functions,
    sections: info.sections.map((s) => ({ section: sectionLabel(s), size: s.size, digest: s.digest })),
    leakedPaths,
    issues,
    warnings,
  };
}

/**
 * Generates a structured rollback manifest with pre-computed ledger keys and Stellar CLI commands.
 */
export function generateRollbackManifest({
  contractName,
  contractId,
  networkPassphrase,
  rpcUrl,
  candidateHash,
  candidateLabel,
  rollbackHash,
  rollbackLabel,
  nowIso = new Date().toISOString(),
}) {
  const instanceLedgerKey = instanceKeyXdr(contractId);
  const candidateCodeLedgerKey = codeKeyXdr(candidateHash);
  const rollbackCodeLedgerKey = rollbackHash ? codeKeyXdr(rollbackHash) : null;

  return {
    schemaVersion: 1,
    generatedAt: nowIso,
    contractName,
    contractId,
    network: {
      rpcUrl: rpcUrl ?? null,
      passphrase: networkPassphrase ?? null,
    },
    ledgerKeys: {
      instance: instanceLedgerKey,
      candidateCode: candidateCodeLedgerKey,
      rollbackCode: rollbackCodeLedgerKey,
    },
    target: {
      label: candidateLabel ?? null,
      wasmHash: candidateHash,
      upgradeCommand: `stellar contract invoke --id ${contractId} --source-account wasmward-fixture --network testnet -- upgrade --new_wasm_hash ${candidateHash}`,
    },
    rollback: rollbackHash
      ? {
          label: rollbackLabel ?? null,
          wasmHash: rollbackHash,
          rollbackCommand: `stellar contract invoke --id ${contractId} --source-account wasmward-fixture --network testnet -- upgrade --new_wasm_hash ${rollbackHash}`,
        }
      : null,
  };
}

/**
 * Builds the full pre-upgrade readiness and rollback plan.
 */
export async function buildUpgradePlan(config, options, { wasmBytes, lookup, nowMs = Date.now() } = {}) {
  const contractEntries = Object.entries(config?.contracts ?? {}).filter(([, c]) => typeof c?.contractId === 'string');
  if (contractEntries.length === 0) {
    throw new Error('the config has no contract with a contractId');
  }
  const selectedEntry = options.contract !== undefined
    ? contractEntries.find(([name]) => name === options.contract)
    : contractEntries[0];
  if (selectedEntry === undefined) {
    const names = contractEntries.map(([name]) => name).join(', ');
    throw new Error(`--contract ${options.contract} is not in the config (${names})`);
  }

  const [contractName, contract] = selectedEntry;
  const supported = contract.supported ?? [];
  const checks = [];
  const recordCheck = (name, ok, detail) => checks.push({ name, ok, detail });

  let wasmInspection = null;
  if (wasmBytes !== undefined) {
    wasmInspection = inspectCandidateWasm(wasmBytes);
    recordCheck(
      'candidate-wasm-binary',
      wasmInspection.ok,
      wasmInspection.ok
        ? `valid Soroban Wasm (${wasmInspection.size} bytes, protocol ${wasmInspection.interfaceProtocol}, functions: ${wasmInspection.functions.join(', ')})`
        : wasmInspection.issues.join('; '),
    );
  }

  let candidateHash = wasmInspection?.sha256 ?? null;
  let candidateLabel = options.targetLabel ?? null;

  if (options.targetLabel !== undefined) {
    const configuredTarget = supported.find((b) => b.label === options.targetLabel);
    if (configuredTarget === undefined) {
      const labels = supported.map((b) => b.label).filter(Boolean).join(', ');
      throw new Error(`--target-label ${options.targetLabel} is not in supported builds (${labels})`);
    }
    const configuredHash = String(configuredTarget.wasmHash).toLowerCase();
    if (candidateHash !== null && candidateHash !== configuredHash) {
      recordCheck(
        'target-label-alignment',
        false,
        `candidate file sha256 (${candidateHash.slice(0, 12)}...) does not match configured ${options.targetLabel} hash (${configuredHash.slice(0, 12)}...)`,
      );
    } else {
      candidateHash = configuredHash;
      recordCheck(
        'target-label-alignment',
        true,
        `candidate matches configured build ${options.targetLabel} (${configuredHash.slice(0, 12)}...)`,
      );
    }
  } else if (candidateHash !== null) {
    const matched = supported.find((b) => String(b.wasmHash).toLowerCase() === candidateHash);
    if (matched !== undefined) {
      candidateLabel = matched.label ?? 'unlabelled';
      recordCheck('supported-list-membership', true, `candidate is listed in config as ${candidateLabel}`);
    } else {
      recordCheck('supported-list-membership', false, `candidate hash ${candidateHash.slice(0, 12)}... is not listed in supported builds`);
    }
  }

  let liveState = null;
  let rollbackHash = null;
  let rollbackLabel = null;
  let ttlSafety = null;

  if (!options.offline) {
    if (typeof lookup !== 'function') {
      throw new Error('no RPC lookup available for online verification');
    }
    const ttlOpts = { minDays: options.minDays, warnLedgers: options.warnLedgers, nowMs };
    const instanceRes = await lookup(instanceKeyXdr(contract.contractId));
    const instanceTtl = computeTtlMetrics(instanceRes, ttlOpts);
    recordCheck(
      'instance-ttl',
      instanceTtl.ok,
      instanceTtl.ledgersLeft === null
        ? `contract instance is ${instanceTtl.status}`
        : `contract instance has ${instanceTtl.daysLeft}d (${instanceTtl.ledgersLeft} ledgers) left (${instanceTtl.status})`,
    );

    const instanceEntry = Array.isArray(instanceRes?.entries) ? instanceRes.entries[0] : undefined;
    if (instanceEntry !== undefined) {
      const parsed = parseInstanceEntry(instanceEntry.xdr);
      if (parsed.kind === 'wasm') {
        rollbackHash = parsed.wasmHash.toLowerCase();
        const knownLive = supported.find((b) => String(b.wasmHash).toLowerCase() === rollbackHash);
        rollbackLabel = knownLive?.label ?? 'unindexed';
        const isNoOp = rollbackHash === candidateHash;
        liveState = {
          wasmHash: rollbackHash,
          label: rollbackLabel,
          alreadyOnCandidate: isNoOp,
        };
        recordCheck(
          'live-vs-candidate',
          true,
          isNoOp
            ? `contract already runs ${candidateLabel ?? candidateHash.slice(0, 8)} (${candidateHash.slice(0, 12)}...)`
            : `upgrade transitions ${rollbackLabel} (${rollbackHash.slice(0, 8)}...) -> ${candidateLabel ?? 'candidate'} (${candidateHash.slice(0, 8)}...)`,
        );
      } else {
        recordCheck('live-vs-candidate', false, 'contract is a Stellar Asset Contract and cannot be upgraded');
      }
    } else {
      recordCheck('live-vs-candidate', false, 'contract instance not found on network');
    }

    const candidateCodeRes = await lookup(codeKeyXdr(candidateHash));
    const candidateCodeTtl = computeTtlMetrics(candidateCodeRes, ttlOpts);
    recordCheck(
      'candidate-code-ttl',
      candidateCodeTtl.ok,
      candidateCodeTtl.ledgersLeft === null
        ? `candidate Wasm code entry is ${candidateCodeTtl.status} on network (upload required before upgrade)`
        : `candidate Wasm code has ${candidateCodeTtl.daysLeft}d (${candidateCodeTtl.ledgersLeft} ledgers) left (${candidateCodeTtl.status})`,
    );

    let rollbackCodeTtl = null;
    if (rollbackHash !== null) {
      const rollbackCodeRes = rollbackHash === candidateHash
        ? candidateCodeRes
        : await lookup(codeKeyXdr(rollbackHash));
      rollbackCodeTtl = computeTtlMetrics(rollbackCodeRes, ttlOpts);
      recordCheck(
        'rollback-code-ttl',
        rollbackCodeTtl.ok,
        rollbackCodeTtl.ledgersLeft === null
          ? `rollback Wasm code (${rollbackLabel}) is ${rollbackCodeTtl.status} on network`
          : `rollback Wasm code (${rollbackLabel}) has ${rollbackCodeTtl.daysLeft}d (${rollbackCodeTtl.ledgersLeft} ledgers) left (${rollbackCodeTtl.status})`,
      );
    }

    ttlSafety = {
      instance: instanceTtl,
      candidateCode: candidateCodeTtl,
      rollbackCode: rollbackCodeTtl,
    };
  } else {
    const fallbackRollback = supported.find((b) => String(b.wasmHash).toLowerCase() !== candidateHash);
    if (fallbackRollback !== undefined) {
      rollbackHash = String(fallbackRollback.wasmHash).toLowerCase();
      rollbackLabel = fallbackRollback.label ?? null;
    }
  }

  const rollbackManifest = generateRollbackManifest({
    contractName,
    contractId: contract.contractId,
    networkPassphrase: config?.network?.passphrase,
    rpcUrl: options.rpcUrl ?? config?.network?.rpcUrl,
    candidateHash,
    candidateLabel,
    rollbackHash,
    rollbackLabel,
    nowIso: new Date(nowMs).toISOString(),
  });

  const ok = checks.every((c) => c.ok);
  return {
    ok,
    mode: options.offline ? 'offline' : 'online',
    contractName,
    contractId: contract.contractId,
    candidate: {
      label: candidateLabel,
      wasmHash: candidateHash,
      codeLedgerKey: codeKeyXdr(candidateHash),
      inspection: wasmInspection,
    },
    liveState,
    ttlSafety,
    checks,
    rollbackManifest,
  };
}

/** Renders the upgrade plan as human-readable text lines. */
export function renderPlanText(plan, { verbose = false } = {}) {
  const lines = [];
  lines.push(`Upgrade Readiness Plan: ${plan.contractName} (${plan.contractId.slice(0, 8)}...) — ${plan.ok ? 'READY' : 'BLOCKED'}`);
  lines.push(`  mode          ${plan.mode}`);
  lines.push(`  candidate     ${plan.candidate.label ?? '(unlabelled)'} (${plan.candidate.wasmHash})`);
  lines.push(`  code key XDR  ${plan.candidate.codeLedgerKey}`);
  if (plan.liveState !== null) {
    lines.push(`  current live  ${plan.liveState.label} (${plan.liveState.wasmHash})`);
  }
  lines.push('');
  lines.push('Pre-flight Checks:');
  for (const check of plan.checks) {
    const mark = check.ok ? 'ok  ' : 'FAIL';
    lines.push(`  ${mark}  ${check.name.padEnd(26)} ${check.detail}`);
  }
  if (verbose && plan.candidate.inspection !== null) {
    const ins = plan.candidate.inspection;
    lines.push('');
    lines.push('Candidate Binary Details:');
    lines.push(`  size          ${ins.size} bytes`);
    lines.push(`  compiler      ${ins.compiler ?? '(not recorded)'}`);
    lines.push(`  sdk           ${ins.sdk ?? '(not recorded)'}`);
    lines.push(`  cli           ${ins.cli ?? '(none)'}`);
    lines.push(`  sections      ${ins.sections.map((s) => `${s.section} (${s.size}B)`).join(', ')}`);
  }
  lines.push('');
  lines.push('Rollback Plan:');
  if (plan.rollbackManifest.rollback !== null) {
    lines.push(`  rollback to   ${plan.rollbackManifest.rollback.label ?? 'previous'} (${plan.rollbackManifest.rollback.wasmHash})`);
    lines.push(`  command       ${plan.rollbackManifest.rollback.rollbackCommand}`);
  } else {
    lines.push('  rollback to   (none available)');
  }
  return lines;
}

/** Renders the upgrade plan as a GitHub-Flavored Markdown report. */
export function renderPlanMarkdown(plan) {
  const lines = [];
  lines.push(`# Upgrade Readiness Plan: \`${plan.contractName}\``);
  lines.push('');
  lines.push(`**Verdict:** ${plan.ok ? 'READY' : 'BLOCKED'} | **Mode:** ${plan.mode} | **Contract:** \`${plan.contractId}\``);
  lines.push('');
  lines.push('## Pre-flight Verification');
  lines.push('');
  lines.push('| Check | Status | Detail |');
  lines.push('|---|---|---|');
  for (const check of plan.checks) {
    lines.push(`| \`${check.name}\` | ${check.ok ? 'PASS' : 'FAIL'} | ${check.detail} |`);
  }
  lines.push('');
  lines.push('## Rollback Manifest');
  lines.push('');
  lines.push(`- **Instance Ledger Key:** \`${plan.rollbackManifest.ledgerKeys.instance}\``);
  lines.push(`- **Candidate Code Key:** \`${plan.rollbackManifest.ledgerKeys.candidateCode}\``);
  if (plan.rollbackManifest.rollback !== null) {
    lines.push(`- **Rollback Target:** \`${plan.rollbackManifest.rollback.label ?? 'previous'}\` (\`${plan.rollbackManifest.rollback.wasmHash}\`)`);
    lines.push(`- **Rollback Command:** \`${plan.rollbackManifest.rollback.rollbackCommand}\``);
  }
  return lines;
}

export async function main(
  argv,
  {
    lookup,
    readText = (path) => readFileSync(path, 'utf8'),
    readBytes = (path) => readFileSync(path),
    writeText = (path, content) => writeFileSync(path, content, { flag: 'wx' }),
  } = {},
) {
  if (wantsHelp(argv)) {
    console.log(helpFromHeader(import.meta.url));
    return 0;
  }
  let options;
  let config;
  let wasmBytes;
  try {
    options = parseArgs(argv);
    config = JSON.parse(readText(options.config));
    if (options.wasm !== undefined) {
      wasmBytes = readBytes(options.wasm);
    }
  } catch (error) {
    console.error(`error: ${error.message}`);
    return 2;
  }

  const rpcUrl = options.rpcUrl ?? config?.network?.rpcUrl;
  if (!options.offline && typeof rpcUrl !== 'string' && lookup === undefined) {
    console.error('error: the config has no network.rpcUrl and --rpc-url was not given (or pass --offline)');
    return 2;
  }

  const activeLookup = options.offline
    ? undefined
    : (lookup ?? ((key) => rpcLookup(rpcUrl, key, { timeoutMs: options.timeoutMs, retries: options.retries })));

  let plan;
  try {
    plan = await buildUpgradePlan(config, options, { wasmBytes, lookup: activeLookup });
  } catch (error) {
    console.error(`error: ${error.message}`);
    return 2;
  }

  if (options.rollbackOut !== undefined) {
    try {
      writeText(options.rollbackOut, `${JSON.stringify(plan.rollbackManifest, null, 2)}\n`);
    } catch (error) {
      console.error(`error: ${options.rollbackOut}: ${error.code === 'EEXIST' ? 'already exists, not overwriting it' : error.message}`);
      return 2;
    }
  }

  if (options.json) {
    console.log(JSON.stringify(plan));
  } else if (options.markdown) {
    console.log(renderPlanMarkdown(plan).join('\n'));
  } else {
    console.log(renderPlanText(plan, { verbose: options.verbose }).join('\n'));
  }
  return plan.ok ? 0 : 1;
}

if (process.argv[1] !== undefined && import.meta.url === pathToFileURL(process.argv[1]).href) {
  process.exitCode = await main(process.argv.slice(2));
}
