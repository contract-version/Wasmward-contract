// The two ledger keys the lifetime check asks the RPC about, written out as base64 XDR by hand so the
// scripts need no dependencies.
//
//   code key:     LedgerKey::ContractCode        = [u32 7] [32-byte Wasm hash]
//   instance key: LedgerKey::ContractData        = [u32 6] [ScAddress::Contract = u32 1, 32 bytes]
//                                                  [ScVal::LedgerKeyContractInstance = u32 20] [persistent = u32 1]
//
// All integers are 4 bytes, big endian (XDR).
import { decodeContractId } from './strkey.mjs';

const LEDGER_KEY_CONTRACT_DATA = 6;
const LEDGER_KEY_CONTRACT_CODE = 7;
const SC_ADDRESS_CONTRACT = 1;
const SCV_LEDGER_KEY_CONTRACT_INSTANCE = 20;
const DURABILITY_PERSISTENT = 1;

function u32(value) {
  const bytes = Buffer.alloc(4);
  bytes.writeUInt32BE(value);
  return bytes;
}

/** The base64 XDR ledger key for the code entry of a Wasm hash (64 lowercase hex characters). */
export function codeKeyXdr(wasmHash) {
  if (!/^[0-9a-f]{64}$/.test(wasmHash)) throw new Error(`not a 64-character lowercase hex Wasm hash: ${wasmHash}`);
  return Buffer.concat([u32(LEDGER_KEY_CONTRACT_CODE), Buffer.from(wasmHash, 'hex')]).toString('base64');
}

/** The base64 XDR ledger key for a contract's instance entry, from its "C..." address. */
export function instanceKeyXdr(contractId) {
  return Buffer.concat([
    u32(LEDGER_KEY_CONTRACT_DATA),
    u32(SC_ADDRESS_CONTRACT),
    Buffer.from(decodeContractId(contractId)),
    u32(SCV_LEDGER_KEY_CONTRACT_INSTANCE),
    u32(DURABILITY_PERSISTENT),
  ]).toString('base64');
}
