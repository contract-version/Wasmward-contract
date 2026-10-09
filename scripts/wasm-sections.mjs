// Reads the structure of a Wasm module and the Soroban metadata inside it, with no dependencies.
//
// A Wasm module is the 8 bytes "\0asm" + version 1, then sections: [id: 1 byte] [size: LEB128] [body]. A
// custom section (id 0) starts its body with a name: [length: LEB128] [bytes]. Soroban stores metadata in
// custom sections:
//
//   contractmetav0     a list of key/value strings. The Rust compiler version ("rsver"), the SDK version
//                      ("rssdkver"), and, if the Stellar CLI optimized the file, the CLI version ("cliver").
//                      There can be more than one of these sections.
//   contractenvmetav0  the host interface version the contract was built against (protocol, pre-release).
//   contractspecv0     the contract's interface (only its size is reported here).
//
// None of this is needed to run Wasmward. It exists to explain why two builds of the same source have
// different hashes. Everything read is bounds-checked: the input may come from the network.
import { createHash } from 'node:crypto';

const MAGIC = Buffer.from([0x00, 0x61, 0x73, 0x6d]);
const SC_META_V0 = 0;
const SC_ENV_META_INTERFACE_VERSION = 0;

/** Reads an unsigned LEB128 of at most 32 bits from `bytes` at `at`. Returns [value, nextOffset]. */
function leb128(bytes, at, what) {
  let value = 0;
  for (let shift = 0, count = 0; ; shift += 7, count += 1) {
    if (count === 5) throw new Error(`the Wasm has an oversized number in ${what}`);
    if (at >= bytes.length) throw new Error(`the Wasm ends inside ${what}`);
    const byte = bytes[at++];
    value += (byte & 0x7f) * 2 ** shift;
    if ((byte & 0x80) === 0) return [value, at];
  }
}

const SECTION_NAMES = {
  1: 'type',
  2: 'import',
  3: 'function',
  4: 'table',
  5: 'memory',
  6: 'global',
  7: 'export',
  8: 'start',
  9: 'element',
  10: 'code',
  11: 'data',
  12: 'data count',
};

/** A section's name as shown: "code", or "custom contractmetav0". */
export function sectionLabel(section) {
  if (section.id === 0) return `custom ${section.name}`;
  return SECTION_NAMES[section.id] ?? `unknown (id ${section.id})`;
}

/** The value of the first metadata entry with this key, or undefined. */
export function metaValue(info, key) {
  return info.meta.find((entry) => entry.key === key)?.value;
}

/** The key/value strings in the body of a `contractmetav0` section. */
export function parseMeta(body) {
  const entries = [];
  let at = 0;
  const u32 = (what) => {
    if (at + 4 > body.length) throw new Error(`the metadata ends inside ${what}`);
    const value = body.readUInt32BE(at);
    at += 4;
    return value;
  };
  const string = (what) => {
    const length = u32(`the length of ${what}`);
    const padded = length + ((4 - (length % 4)) % 4); // XDR pads strings to a multiple of four
    if (at + padded > body.length) throw new Error(`the metadata ends inside ${what}`);
    const text = body.subarray(at, at + length).toString('utf8');
    at += padded;
    return text;
  };
  while (at < body.length) {
    const kind = u32('an entry kind');
    if (kind !== SC_META_V0) throw new Error(`the metadata has an entry kind (${kind}) this script does not know`);
    const key = string('a key');
    entries.push({ key, value: string(`the value of ${key}`) });
  }
  return entries;
}

/** The interface version in the body of a `contractenvmetav0` section: { protocol, preRelease }. */
export function parseEnvMeta(body) {
  if (body.length !== 12) throw new Error(`the environment metadata is ${body.length} bytes, expected 12`);
  const kind = body.readUInt32BE(0);
  if (kind !== SC_ENV_META_INTERFACE_VERSION) throw new Error(`the environment metadata has an entry kind (${kind}) this script does not know`);
  return { protocol: body.readUInt32BE(4), preRelease: body.readUInt32BE(8) };
}

/**
 * Reads a Wasm module. Returns
 *   { size, sha256, sections: [{ id, name?, size }], meta: [{ key, value }], interface?: { protocol, preRelease } }
 * `meta` joins every contractmetav0 section, in file order. Throws an Error that says what is wrong if the
 * bytes are not a Wasm module or are cut off.
 */
export function readWasm(input) {
  const bytes = Buffer.from(input);
  if (bytes.length < 8 || !bytes.subarray(0, 4).equals(MAGIC)) throw new Error('this is not a Wasm module (it does not start with \\0asm)');
  const version = bytes.readUInt32LE(4);
  if (version !== 1) throw new Error(`this Wasm module has version ${version}; only version 1 exists`);

  const info = { size: bytes.length, sha256: createHash('sha256').update(bytes).digest('hex'), sections: [], meta: [] };
  let at = 8;
  while (at < bytes.length) {
    const id = bytes[at++];
    const [size, bodyStart] = leb128(bytes, at, `the size of section ${id}`);
    const end = bodyStart + size;
    if (end > bytes.length) throw new Error(`section ${id} says it is ${size} bytes but only ${bytes.length - bodyStart} remain`);
    const section = { id, size };
    let body = bytes.subarray(bodyStart, end);
    if (id === 0) {
      const [nameLength, nameStart] = leb128(bytes, bodyStart, 'the name of a custom section');
      if (nameStart + nameLength > end) throw new Error('a custom section has a name longer than the section');
      section.name = bytes.subarray(nameStart, nameStart + nameLength).toString('utf8');
      body = bytes.subarray(nameStart + nameLength, end);
    }
    if (section.name === 'contractmetav0') info.meta.push(...parseMeta(body));
    if (section.name === 'contractenvmetav0') info.interface = parseEnvMeta(body);
    info.sections.push(section);
    at = end;
  }
  return info;
}
