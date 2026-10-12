// Reading an unsigned LEB128 number from Wasm bytes, with no dependencies. Wasm writes every size, count and index in
// this form: seven bits per byte, the top bit set on every byte but the last. Shared by the modules that read Wasm.

/** The most bytes a 32-bit value can take. A longer run is a corrupt (or hostile) module, not a big number. */
const MAX_BYTES = 5;

/**
 * Reads an unsigned LEB128 of at most 32 bits from `bytes` at `at`. Returns [value, nextOffset]. `what` names the
 * number in the error, such as "the size of section 7". Throws an Error if the bytes end first or it is too long.
 */
export function readLeb128(bytes, at, what) {
  let value = 0;
  for (let shift = 0, count = 0; ; shift += 7, count += 1) {
    if (count === MAX_BYTES) throw new Error(`the Wasm has an oversized number in ${what}`);
    if (at >= bytes.length) throw new Error(`the Wasm ends inside ${what}`);
    const byte = bytes[at++];
    value += (byte & 0x7f) * 2 ** shift;
    if ((byte & 0x80) === 0) return [value, at];
  }
}
