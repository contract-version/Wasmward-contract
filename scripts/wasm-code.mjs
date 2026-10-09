// Reads the Wasm out of a contract-code ledger entry, with no dependencies.
//
// getLedgerEntries returns an entry's value as base64 XDR. For a contract's code (LedgerEntryData type
// CONTRACT_CODE = 7) that is:
//
//   [u32 7]                                  the kind of entry
//   [u32 v]                                  ContractCodeEntry.ext: 0 = nothing more, 1 = cost inputs follow
//   if v = 1: [u32 ext] [u32 ext] [10 x u32] ExtensionPoint, then ContractCodeCostInputs (an ExtensionPoint
//                                            and nine counts) = 48 bytes the network adds for metering
//   [32 bytes]                               the hash of the code
//   [u32 n] [n bytes] [padding to 4]         the Wasm itself
//
// The hash of a contract's code is the SHA-256 of these bytes, so the result is checked against it: if they
// disagree, what came back is not the code that was asked for.
import { createHash } from 'node:crypto';

const LEDGER_ENTRY_CONTRACT_CODE = 7;
const COST_INPUTS_BYTES = 48;

/**
 * Parses the base64 XDR value of a contract-code entry into { hash, code, hashMatches }, where `hash` is the
 * hash the entry states (lowercase hex), `code` is a Buffer of the Wasm, and `hashMatches` says whether the
 * SHA-256 of `code` equals `hash`. Throws an Error that says what is wrong if it is not such an entry.
 */
export function parseCodeEntry(xdrBase64) {
  if (typeof xdrBase64 !== 'string') throw new Error('the ledger entry is not a string of base64');
  const bytes = Buffer.from(xdrBase64, 'base64');
  let at = 0;
  const need = (count, what) => {
    if (at + count > bytes.length) throw new Error(`the ledger entry ends early: it has no room for ${what}`);
  };
  const u32 = (what) => {
    need(4, what);
    const value = bytes.readUInt32BE(at);
    at += 4;
    return value;
  };

  const kind = u32('the entry kind');
  if (kind !== LEDGER_ENTRY_CONTRACT_CODE) throw new Error(`the ledger entry is of kind ${kind}, not contract code (${LEDGER_ENTRY_CONTRACT_CODE})`);
  const ext = u32('the extension');
  if (ext === 1) {
    need(COST_INPUTS_BYTES, 'the cost inputs');
    at += COST_INPUTS_BYTES;
  } else if (ext !== 0) {
    throw new Error(`the contract code entry has an extension version (${ext}) this script does not know`);
  }
  need(32, 'the code hash');
  const hash = bytes.subarray(at, at + 32).toString('hex');
  at += 32;
  const length = u32('the code length');
  need(length, 'the code');
  const code = bytes.subarray(at, at + length);
  at += length;
  // XDR pads opaque data to a multiple of four bytes; anything after that would be unexplained.
  const padded = at + ((4 - (length % 4)) % 4);
  if (bytes.length !== padded) throw new Error(`the ledger entry has ${bytes.length - padded} unexplained bytes after the code`);

  return { hash, code, hashMatches: createHash('sha256').update(code).digest('hex') === hash };
}
