// Reads which code a contract runs from its instance ledger entry, with no dependencies.
//
// getLedgerEntries returns an entry's value as base64 XDR. For a contract's instance (LedgerEntryData type
// CONTRACT_DATA = 6, whose key is the contract instance key) the start is:
//
//   [u32 6]                    the kind of entry
//   [u32 0]                    ContractDataEntry.ext: nothing more
//   [u32 1] [32 bytes]         the contract: ScAddress::Contract and its id
//   [u32 20]                   the entry's key: ScVal::LedgerKeyContractInstance
//   [u32 d]                    durability (1 = persistent)
//   [u32 19]                   the value: ScVal::ContractInstance
//   [u32 e]                    the executable: 0 = Wasm, 1 = Stellar Asset Contract
//   if e = 0: [32 bytes]       the hash of the Wasm the contract runs
//
// What follows (the instance storage) is not needed to answer "which build is live", so it is not read.
// Checked against the answer the testnet gave for the fixture, kept in scripts/fixtures.

const LEDGER_ENTRY_CONTRACT_DATA = 6;
const SC_ADDRESS_CONTRACT = 1;
const SCV_LEDGER_KEY_CONTRACT_INSTANCE = 20;
const SCV_CONTRACT_INSTANCE = 19;
const EXECUTABLE_WASM = 0;
const EXECUTABLE_STELLAR_ASSET = 1;

/**
 * Parses the base64 XDR value of a contract instance entry into { kind: 'wasm', wasmHash } (lowercase hex) or
 * { kind: 'stellar-asset' }. Throws an Error that says what is wrong if it is not an instance entry.
 */
export function parseInstanceEntry(xdrBase64) {
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
  const expect = (value, wanted, what) => {
    if (value !== wanted) throw new Error(`the ledger entry is not a contract instance: ${what} is ${value}, expected ${wanted}`);
  };

  expect(u32('the entry kind'), LEDGER_ENTRY_CONTRACT_DATA, 'the entry kind');
  u32('the extension');
  expect(u32('the address kind'), SC_ADDRESS_CONTRACT, 'the address kind');
  need(32, 'the contract id');
  at += 32;
  expect(u32('the key'), SCV_LEDGER_KEY_CONTRACT_INSTANCE, 'the key type');
  u32('the durability');
  expect(u32('the value'), SCV_CONTRACT_INSTANCE, 'the value type');

  const executable = u32('the executable kind');
  if (executable === EXECUTABLE_STELLAR_ASSET) return { kind: 'stellar-asset' };
  if (executable !== EXECUTABLE_WASM) throw new Error(`the contract has an executable of kind ${executable}, which this script does not know`);
  need(32, 'the Wasm hash');
  return { kind: 'wasm', wasmHash: bytes.subarray(at, at + 32).toString('hex') };
}
