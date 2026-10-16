import { calculateCrc32Hex } from '@mayacardio/shared';

export interface CrcValidationResult {
  valid: boolean;
  computedCrc: string;
  expectedCrc: string;
  dataText?: string;
  error?: string;
}

/**
 * Extracts the data text from [ to the matching ] corresponding to the "data" field
 * in the raw NDJSON message, and validates its CRC-32 (zlib) against the message's crc32 field.
 */
export function validateMessageCrc(
  rawJsonLine: string,
  expectedCrc: string
): CrcValidationResult {
  const dataKeyIdx = rawJsonLine.indexOf('"data"');
  if (dataKeyIdx === -1) {
    return {
      valid: false,
      computedCrc: '',
      expectedCrc,
      error: 'Field "data" not found in raw line',
    };
  }

  // Find the opening bracket of the data array
  const startBracketIdx = rawJsonLine.indexOf('[', dataKeyIdx);
  if (startBracketIdx === -1) {
    return {
      valid: false,
      computedCrc: '',
      expectedCrc,
      error: 'Opening bracket [ for "data" not found',
    };
  }

  // Scan for matching closing bracket
  let depth = 0;
  let endBracketIdx = -1;
  let inString = false;
  let escape = false;

  for (let i = startBracketIdx; i < rawJsonLine.length; i++) {
    const char = rawJsonLine[i];

    if (escape) {
      escape = false;
      continue;
    }

    if (char === '\\') {
      escape = true;
      continue;
    }

    if (char === '"') {
      inString = !inString;
      continue;
    }

    if (!inString) {
      if (char === '[') {
        depth++;
      } else if (char === ']') {
        depth--;
        if (depth === 0) {
          endBracketIdx = i;
          break;
        }
      }
    }
  }

  if (endBracketIdx === -1 || depth !== 0) {
    return {
      valid: false,
      computedCrc: '',
      expectedCrc,
      error: 'Matching closing bracket ] for "data" not found',
    };
  }

  const dataText = rawJsonLine.slice(startBracketIdx, endBracketIdx + 1);
  const computedCrc = calculateCrc32Hex(dataText);

  const valid = computedCrc.toLowerCase() === expectedCrc.trim().toLowerCase();

  return {
    valid,
    computedCrc,
    expectedCrc: expectedCrc.trim().toLowerCase(),
    dataText,
  };
}
