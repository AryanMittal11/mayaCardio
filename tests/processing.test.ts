import { describe, it, expect } from 'vitest';
import {
  calculateChannelStats,
  calculateMagnitude,
} from '../packages/processing/src/stats.js';
import {
  isPeak,
  calculateHeartRateForWindow,
  StreamingHeartRateDetector,
} from '../packages/processing/src/heart-rate.js';
import { processWindow } from '../packages/processing/src/windowing.js';

describe('Shared Signal Processing Engine (§3)', () => {
  describe('Channel Descriptive Statistics', () => {
    it('returns nulls for empty channel samples', () => {
      const stats = calculateChannelStats([]);
      expect(stats.mean).toBeNull();
      expect(stats.min).toBeNull();
      expect(stats.max).toBeNull();
    });

    it('calculates min, max, and rounds mean to 1 decimal place', () => {
      // 10 + 20 + 35 = 65 / 3 = 21.666... -> 21.7
      const stats = calculateChannelStats([10, 20, 35]);
      expect(stats.min).toBe(10);
      expect(stats.max).toBe(35);
      expect(stats.mean).toBe(21.7);
    });

    it('handles negative 24-bit values accurately', () => {
      const stats = calculateChannelStats([-100, -200, -150]);
      expect(stats.min).toBe(-200);
      expect(stats.max).toBe(-100);
      expect(stats.mean).toBe(-150.0);
    });
  });

  describe('Sensor 2 Magnitude', () => {
    it('returns null when no Sensor 2 samples are available', () => {
      expect(calculateMagnitude([])).toBeNull();
    });

    it('calculates mean of sqrt(ch1^2 + ch2^2) rounded to 1 decimal place', () => {
      // [3, 4] -> sqrt(9+16) = 5
      // [6, 8] -> sqrt(36+64) = 10
      // mean = 7.5
      const samples: Array<[number, number]> = [
        [3, 4],
        [6, 8],
      ];
      expect(calculateMagnitude(samples)).toBe(7.5);
    });
  });

  describe('Heart Rate Detection Rules (§3)', () => {
    it('returns null if window w < 4', () => {
      const dummyAccessor = {
        has: () => true,
        get: () => 100,
      };
      expect(calculateHeartRateForWindow(0, dummyAccessor)).toBeNull();
      expect(calculateHeartRateForWindow(1, dummyAccessor)).toBeNull();
      expect(calculateHeartRateForWindow(2, dummyAccessor)).toBeNull();
      expect(calculateHeartRateForWindow(3, dummyAccessor)).toBeNull();
    });

    it('returns null if any sample in [400*(w-4), 400*(w+1)-1] is missing', () => {
      const sampleMap = new Map<number, number>();
      // Populate 2000 samples but omit one at index 1000
      for (let i = 0; i <= 2000; i++) {
        if (i !== 1000) {
          sampleMap.set(i, 100);
        }
      }
      const accessor = {
        has: (idx: number) => sampleMap.has(idx),
        get: (idx: number) => sampleMap.get(idx),
      };

      // Window 4 covers [0, 1999]
      expect(calculateHeartRateForWindow(4, accessor)).toBeNull();
    });

    it('evaluates peak criteria strictly (all 4 conditions)', () => {
      const sampleMap = new Map<number, number>();
      // Baseline 100
      for (let i = 0; i <= 1000; i++) {
        sampleMap.set(i, 100);
      }
      const accessor = {
        has: (idx: number) => sampleMap.has(idx),
        get: (idx: number) => sampleMap.get(idx),
      };

      // Sample 850: not a peak yet because it's flat
      expect(isPeak(850, accessor, null)).toBe(false);

      // Make 850 a sharp peak: value 300, while neighbours are 100
      // 800 samples before have max 100. 300 > 0.5 * 100 = 50.
      // 300 > 100 (prev) and 300 > 100 (next).
      sampleMap.set(850, 300);
      expect(isPeak(850, accessor, null)).toBe(true);

      // Rule 4: If previous peak was at 800, 850 is only 50 samples away (< 100 refractory) -> should reject
      expect(isPeak(850, accessor, 800)).toBe(false);

      // But if previous peak was at 700 (150 samples away), it should pass
      expect(isPeak(850, accessor, 700)).toBe(true);
    });

    it('calculates 60.0 BPM for 1 beat/second (400 samples gap)', () => {
      const sampleMap = new Map<number, number>();
      // Construct 6 seconds (2400 samples)
      for (let i = 0; i < 2400; i++) {
        sampleMap.set(i, 100);
      }
      // Put sharp peaks at 800, 1200, 1600 (gap 400 samples = 1 sec)
      sampleMap.set(800, 500);
      sampleMap.set(1200, 500);
      sampleMap.set(1600, 500);

      const detector = new StreamingHeartRateDetector();
      const accessor = {
        has: (idx: number) => sampleMap.has(idx),
        get: (idx: number) => sampleMap.get(idx),
      };

      detector.updatePeaks(2000, accessor);
      // Window 4 covers [0, 1999], interval [0, 1999] has peaks 800, 1200, 1600
      const hr = detector.calculateForWindow(4, accessor);
      expect(hr).toBe(60.0);
    });

    it('calculates heart rate accurately for window w >= 5 without precomputed peaks (BUG-01 regression)', () => {
      // Window 6 covers interval [400*(6-4), 400*(6+1)-1] = [800, 2799]
      // Needs samples from at least [800 - 800, 2800] = [0, 2800]
      const sampleMap = new Map<number, number>();
      for (let i = 0; i <= 3000; i++) {
        sampleMap.set(i, 100);
      }
      // Place peaks at 800, 1200, 1600, 2000, 2400 (400 samples gap = 60 bpm)
      sampleMap.set(800, 500);
      sampleMap.set(1200, 500);
      sampleMap.set(1600, 500);
      sampleMap.set(2000, 500);
      sampleMap.set(2400, 500);

      const accessor = {
        has: (idx: number) => sampleMap.has(idx),
        get: (idx: number) => sampleMap.get(idx),
      };

      // Calling directly without precomputed peaks should scan and find peaks in [800, 2799]
      const hr = calculateHeartRateForWindow(6, accessor);
      expect(hr).toBe(60.0);
    });
  });

  describe('Full Window Processing Contract', () => {
    it('produces all Section 3 output fields accurately', () => {
      const s1 = new Map<number, number[]>();
      const s2 = new Map<number, number[]>();

      // Populate window 0 [0 .. 399]
      for (let i = 0; i < 400; i++) {
        s1.set(i, [100, 200, 300]);
        s2.set(i, [300, 400]);
      }

      const result = processWindow({
        sessionId: 'test_sess_win',
        window: 0,
        mode: 'online',
        sensor1Samples: s1,
        sensor2Samples: s2,
      });

      expect(result.window).toBe(0);
      expect(result.complete).toBe(true);
      expect(result.missing_1).toBe(0);
      expect(result.missing_2).toBe(0);
      expect(result.s1_ch1_mean).toBe(100.0);
      expect(result.s1_ch2_mean).toBe(200.0);
      expect(result.s1_ch3_mean).toBe(300.0);
      expect(result.magnitude).toBe(500.0); // sqrt(300^2 + 400^2) = 500
      expect(result.heart_rate).toBeNull(); // window < 4
      expect(result.mode).toBe('online');
    });

    it('marks complete=false and increments missing counts if samples are omitted', () => {
      const s1 = new Map<number, number[]>();
      const s2 = new Map<number, number[]>();

      // Omit 10 samples from s1, 20 from s2
      for (let i = 0; i < 390; i++) s1.set(i, [10, 20, 30]);
      for (let i = 0; i < 380; i++) s2.set(i, [10, 20]);

      const result = processWindow({
        sessionId: 'test_sess_win',
        window: 0,
        mode: 'offline',
        sensor1Samples: s1,
        sensor2Samples: s2,
      });

      expect(result.complete).toBe(false);
      expect(result.missing_1).toBe(10);
      expect(result.missing_2).toBe(20);
      expect(result.mode).toBe('offline');
    });
  });
});
