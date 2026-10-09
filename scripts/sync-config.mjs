#!/usr/bin/env node
// Writes fixture.wasmward.json, the public Wasmward config for the fixture, from testnet.json, which
// scripts/deploy.sh writes. After a redeploy the contract ID and both hashes change; this replaces copying
// them by hand into the config.
//
//   node scripts/sync-config.mjs [--testnet testnet.json] [--out fixture.wasmward.json] [--check]
//
// With --check nothing is written: the exit code is 0 when the file already matches testnet.json and 1 when
// it does not, so it can guard against a stale config. Exit code 2 means a file could not be read or is not
// what was expected. No dependencies; needs Node 18 or newer. testnet.json holds public values only, and
// only the contract ID, the hashes and the network are copied from it.
import { readFileSync, writeFileSync } from 'node:fs';
import { pathToFileURL } from 'node:url';

const HASH = /^[0-9a-f]{64}$/;
const CONTRACT = /^C[A-Z2-7]{55}$/;

/** The Wasmward config for what testnet.json describes. Throws an Error that says what is wrong with it. */
export function configFrom(testnet) {
  const need = (condition, message) => {
    if (!condition) throw new Error(`testnet.json ${message}`);
  };
  need(typeof testnet?.rpcUrl === 'string' && testnet.rpcUrl.startsWith('http'), 'has no rpcUrl');
  need(typeof testnet?.passphrase === 'string' && testnet.passphrase !== '', 'has no passphrase');
  need(CONTRACT.test(testnet?.contractId ?? ''), 'has no valid contractId');
  need(HASH.test(testnet?.v1?.wasmHash ?? ''), 'has no valid v1.wasmHash');
  need(HASH.test(testnet?.v2?.wasmHash ?? ''), 'has no valid v2.wasmHash');
  need(testnet.v1.wasmHash !== testnet.v2.wasmHash, 'has the same hash for v1 and v2');
  return {
    version: 1,
    network: { rpcUrl: testnet.rpcUrl, passphrase: testnet.passphrase },
    contracts: {
      fixture: {
        contractId: testnet.contractId,
        supported: [
          { wasmHash: testnet.v1.wasmHash, label: 'v1' },
          { wasmHash: testnet.v2.wasmHash, label: 'v2' },
        ],
      },
    },
  };
}

/** The file text for a config: two-space JSON and a final newline, like the one in the repository. */
export function render(config) {
  return `${JSON.stringify(config, null, 2)}\n`;
}

export function parseArgs(argv) {
  const options = { testnet: 'testnet.json', out: 'fixture.wasmward.json', check: false };
  for (let i = 0; i < argv.length; i += 1) {
    const flag = argv[i];
    if (flag === '--check') options.check = true;
    else if (flag === '--testnet' || flag === '--out') {
      const value = argv[i + 1];
      if (value === undefined || value.trim() === '' || value.startsWith('--')) throw new Error(`${flag} needs a value`);
      options[flag.slice(2)] = value;
      i += 1;
    } else throw new Error(`unknown option ${flag}`);
  }
  return options;
}

function main(argv) {
  let options;
  let wanted;
  try {
    options = parseArgs(argv);
    wanted = render(configFrom(JSON.parse(readFileSync(options.testnet, 'utf8'))));
  } catch (error) {
    console.error(`error: ${error.message}`);
    return 2;
  }

  let current = null;
  try {
    current = readFileSync(options.out, 'utf8');
  } catch (error) {
    if (error.code !== 'ENOENT') {
      console.error(`error: ${error.message}`);
      return 2;
    }
  }

  if (current === wanted) {
    console.log(`${options.out} already matches ${options.testnet}.`);
    return 0;
  }
  if (options.check) {
    console.error(`${options.out} does not match ${options.testnet}. Run: node scripts/sync-config.mjs`);
    return 1;
  }
  writeFileSync(options.out, wanted);
  console.log(`Wrote ${options.out} from ${options.testnet}.`);
  return 0;
}

if (process.argv[1] !== undefined && import.meta.url === pathToFileURL(process.argv[1]).href) {
  process.exitCode = main(process.argv.slice(2));
}
