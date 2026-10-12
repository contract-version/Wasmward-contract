// Lists what a Wasm module exports, with no dependencies.
//
// The export section (section id 7) is a vector of entries: [name length (LEB128)] [name bytes] [kind (1 byte)]
// [index (LEB128)]. A Soroban contract exports one function for each public function of the contract, plus its
// memory and a `_` marker. That makes the export list the contract's interface as the network sees it, which is
// the thing that must not change for the deployed hashes to stay valid.
//
// Kinds: 0 function, 1 table, 2 memory, 3 global, 4 tag.

import { readLeb128 } from './leb128.mjs';

const MAGIC = Buffer.from([0x00, 0x61, 0x73, 0x6d]);
const EXPORT_SECTION = 7;
const KINDS = ['function', 'table', 'memory', 'global', 'tag'];

/**
 * The exports of a Wasm module as [{ name, kind, index }], in file order. Throws an Error that says what is wrong
 * if the bytes are not a Wasm module or the export section is cut off. A module with no export section has none.
 */
export function readExports(input) {
  const bytes = Buffer.from(input);
  if (bytes.length < 8 || !bytes.subarray(0, 4).equals(MAGIC)) throw new Error('this is not a Wasm module (it does not start with \\0asm)');
  if (bytes.readUInt32LE(4) !== 1) throw new Error(`this Wasm module has version ${bytes.readUInt32LE(4)}; only version 1 exists`);

  let at = 8;
  while (at < bytes.length) {
    const id = bytes[at++];
    const [size, bodyStart] = readLeb128(bytes, at, `the size of section ${id}`);
    const end = bodyStart + size;
    if (end > bytes.length) throw new Error(`section ${id} says it is ${size} bytes but only ${bytes.length - bodyStart} remain`);
    if (id !== EXPORT_SECTION) {
      at = end;
      continue;
    }
    const exports = [];
    let [count, cursor] = readLeb128(bytes, bodyStart, 'the number of exports');
    for (let i = 0; i < count; i += 1) {
      let length;
      [length, cursor] = readLeb128(bytes, cursor, `the name of export ${i}`);
      if (cursor + length + 1 > end) throw new Error(`export ${i} runs past the end of the export section`);
      const name = bytes.subarray(cursor, cursor + length).toString('utf8');
      cursor += length;
      const kind = KINDS[bytes[cursor]];
      if (kind === undefined) throw new Error(`export "${name}" has a kind (${bytes[cursor]}) that this reader does not know`);
      cursor += 1;
      let index;
      [index, cursor] = readLeb128(bytes, cursor, `the index of export "${name}"`);
      exports.push({ name, kind, index });
    }
    if (cursor !== end) throw new Error('the export section has bytes left over after its last entry');
    return exports;
  }
  return [];
}

/** The names of the exported functions, sorted. For a contract this is its callable interface plus the `_` marker. */
export function functionNames(input) {
  return readExports(input)
    .filter((entry) => entry.kind === 'function')
    .map((entry) => entry.name)
    .sort();
}
