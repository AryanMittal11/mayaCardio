import { describe, it, expect } from 'vitest';
import { calculateCrc32Hex, verifyCrc32 } from '../packages/shared/src/crc.js';

describe('Shared CRC-32 Validation', () => {
  it('matches the exact CRC-32 example in Section 5 of the assessment doc', () => {
    const dataText = '[[720, 1200, 1560], [708, 1180, 1534], [726, 1210, 1573]]';
    const expectedCrc = 'f9a5bf62';

    const computed = calculateCrc32Hex(dataText);
    expect(computed).toBe(expectedCrc);
    expect(verifyCrc32(dataText, expectedCrc)).toBe(true);
  });

  it('rejects corrupt CRC-32 correctly', () => {
    const dataText = '[[720, 1200, 1560], [708, 1180, 1534], [726, 1210, 1573]]';
    const wrongCrc = 'ffffffff';

    expect(verifyCrc32(dataText, wrongCrc)).toBe(false);
  });

  it('detects altered data payload', () => {
    const originalText = '[[720, 1200, 1560], [708, 1180, 1534], [726, 1210, 1573]]';
    const alteredText = '[[721, 1200, 1560], [708, 1180, 1534], [726, 1210, 1573]]';
    const originalCrc = calculateCrc32Hex(originalText);

    expect(verifyCrc32(alteredText, originalCrc)).toBe(false);
  });
});
