import { BiosignalGenerator, type MockMode } from './generator.js';
import type { SensorId } from '@mayacardio/shared';

export interface ExportSampleLine {
  sensor: SensorId;
  index: number;
  values: number[];
}

export interface ExportLossLine {
  sensor: SensorId;
  from_index: number;
  to_index: number | null;
  reason: string;
}

export interface GroundTruthVerificationResult {
  valid: boolean;
  totalSamples: number;
  totalLosses: number;
  unaccountedGaps: Array<{ sensor: SensorId; index: number }>;
  corruptedSamples: Array<{ sensor: SensorId; index: number; expected: number[]; actual: number[] }>;
  duplicateSamples: Array<{ sensor: SensorId; index: number }>;
  summary: string;
}

export class GroundTruthChecker {
  private generator: BiosignalGenerator;

  constructor(mode: MockMode = 'ramp', seed = 7) {
    this.generator = new BiosignalGenerator(mode, seed);
  }

  public verify(
    samples: ExportSampleLine[],
    losses: ExportLossLine[],
    maxExpectedIndex?: number
  ): GroundTruthVerificationResult {
    const s1Seen = new Map<number, number[]>();
    const s2Seen = new Map<number, number[]>();
    const duplicateSamples: Array<{ sensor: SensorId; index: number }> = [];
    const corruptedSamples: Array<{ sensor: SensorId; index: number; expected: number[]; actual: number[] }> = [];

    let maxS1 = -1;
    let maxS2 = -1;

    for (const s of samples) {
      const map = s.sensor === 1 ? s1Seen : s2Seen;
      if (map.has(s.index)) {
        duplicateSamples.push({ sensor: s.sensor, index: s.index });
      } else {
        map.set(s.index, s.values);
      }

      if (s.sensor === 1 && s.index > maxS1) maxS1 = s.index;
      if (s.sensor === 2 && s.index > maxS2) maxS2 = s.index;

      // Verify value against generator
      const expected = this.generator.generate(s.sensor, s.index);
      const isMatch =
        s.values.length === expected.length &&
        s.values.every((val, idx) => val === expected[idx]);

      if (!isMatch) {
        corruptedSamples.push({
          sensor: s.sensor,
          index: s.index,
          expected,
          actual: s.values,
        });
      }
    }

    // Build lost intervals coverage
    const isLost = (sensor: SensorId, index: number): boolean => {
      for (const loss of losses) {
        if (loss.sensor === sensor) {
          if (loss.to_index === null) {
            if (index >= loss.from_index) return true;
          } else {
            if (index >= loss.from_index && index <= loss.to_index) return true;
          }
        }
      }
      return false;
    };

    const targetMax1 = maxExpectedIndex !== undefined ? maxExpectedIndex : maxS1;
    const targetMax2 = maxExpectedIndex !== undefined ? maxExpectedIndex : maxS2;
    const unaccountedGaps: Array<{ sensor: SensorId; index: number }> = [];

    // Verify Sensor 1 coverage from 0 to targetMax1
    for (let i = 0; i <= targetMax1; i++) {
      if (!s1Seen.has(i) && !isLost(1, i)) {
        unaccountedGaps.push({ sensor: 1, index: i });
      }
    }

    // Verify Sensor 2 coverage from 0 to targetMax2
    for (let i = 0; i <= targetMax2; i++) {
      if (!s2Seen.has(i) && !isLost(2, i)) {
        unaccountedGaps.push({ sensor: 2, index: i });
      }
    }

    const valid =
      duplicateSamples.length === 0 &&
      corruptedSamples.length === 0 &&
      unaccountedGaps.length === 0;

    const summary = valid
      ? `PASS: Verified ${samples.length} samples with ${losses.length} loss records. Zero unaccounted loss, zero corruption, zero duplicates.`
      : `FAIL: Duplicates: ${duplicateSamples.length}, Corrupted: ${corruptedSamples.length}, Unaccounted Gaps: ${unaccountedGaps.length}`;

    return {
      valid,
      totalSamples: samples.length,
      totalLosses: losses.length,
      unaccountedGaps,
      corruptedSamples,
      duplicateSamples,
      summary,
    };
  }
}
