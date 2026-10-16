/**
 * CRC-32 (zlib standard, polynomial 0xEDB88320) implementation
 * Compatible with Node.js built-in zlib and RFC 1952 / IEEE 802.3
 */

import { crc32 as nodeCrc32 } from 'node:zlib';

// Precomputed CRC table for maximum performance and portability fallback
const CRC_TABLE = new Uint32Array(256);
for (let i = 0; i < 256; i++) {
  let c = i;
  for (let j = 0; j < 8; j++) {
    c = (c & 1) ? (0xedb88320 ^ (c >>> 1)) : (c >>> 1);
  }
  CRC_TABLE[i] = c;
}

/**
 * Compute CRC-32 of a UTF-8 string or Buffer using standard zlib polynomial
 * Returns 8-character lowercase hexadecimal string
 */
export function calculateCrc32Hex(data: string | Buffer): string {
  if (typeof nodeCrc32 === 'function') {
    const buf = typeof data === 'string' ? Buffer.from(data, 'utf-8') : data;
    const crcNum = nodeCrc32(buf);
    // Convert unsigned 32-bit integer to 8-character hex
    return (crcNum >>> 0).toString(16).padStart(8, '0').toLowerCase();
  }

  // Fallback table computation
  const buf = typeof data === 'string' ? Buffer.from(data, 'utf-8') : data;
  let crc = 0xffffffff;
  for (let i = 0; i < buf.length; i++) {
    const byte = buf[i]!;
    crc = (crc >>> 8) ^ CRC_TABLE[(crc ^ byte) & 0xff]!;
  }
  crc = (crc ^ 0xffffffff) >>> 0;
  return crc.toString(16).padStart(8, '0').toLowerCase();
}

/**
 * Verify whether a provided hex CRC-32 matches the computed CRC-32 of raw data text
 */
export function verifyCrc32(rawText: string, expectedCrcHex: string): boolean {
  const computed = calculateCrc32Hex(rawText);
  return computed.toLowerCase() === expectedCrcHex.trim().toLowerCase();
}
