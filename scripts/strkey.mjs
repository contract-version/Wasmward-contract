// Reads a Stellar contract address ("C...") into its 32 bytes, with no dependencies.
//
// An address is 56 characters of base32 that decode to 35 bytes: a version byte (0x10 for contracts), the 32
// bytes, and a 2-byte CRC16 checksum (XModem, little endian) over the first 33. A typo anywhere changes the
// checksum, so a wrong character is refused instead of quietly looking up some other contract.

const ALPHABET = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567';
const CONTRACT_VERSION_BYTE = 2 << 3; // "C"

/** CRC16-XModem: polynomial 0x1021, initial value 0. */
export function crc16(bytes) {
  let crc = 0;
  for (const byte of bytes) {
    crc ^= byte << 8;
    for (let bit = 0; bit < 8; bit += 1) {
      crc = crc & 0x8000 ? ((crc << 1) ^ 0x1021) & 0xffff : (crc << 1) & 0xffff;
    }
  }
  return crc;
}

/** Decodes base32 (RFC 4648, upper case, no padding). Throws on a character outside the alphabet. */
function base32Decode(text) {
  const bytes = [];
  let buffer = 0;
  let bits = 0;
  for (const char of text) {
    const value = ALPHABET.indexOf(char);
    if (value < 0) throw new Error(`not a contract address: unexpected character ${JSON.stringify(char)}`);
    buffer = (buffer << 5) | value;
    bits += 5;
    if (bits >= 8) {
      bits -= 8;
      bytes.push((buffer >> bits) & 0xff);
      buffer &= (1 << bits) - 1;
    }
  }
  return Uint8Array.from(bytes);
}

/** The 32 bytes behind a contract address. Throws an Error that says why if it is not a valid one. */
export function decodeContractId(address) {
  if (typeof address !== 'string' || address.length !== 56) throw new Error('not a contract address: it must be 56 characters');
  if (address[0] !== 'C') throw new Error('not a contract address: it must start with C');
  const raw = base32Decode(address);
  if (raw.length !== 35 || raw[0] !== CONTRACT_VERSION_BYTE) throw new Error('not a contract address: wrong type or length');
  const checksum = raw[33] | (raw[34] << 8);
  if (crc16(raw.subarray(0, 33)) !== checksum) throw new Error('not a contract address: the checksum does not match (a typo?)');
  return raw.slice(1, 33);
}
