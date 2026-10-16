import {
  WINDOW_SIZE,
  type ProcessingMode,
  type WindowResult,
} from '@mayacardio/shared';
import { calculateChannelStats, calculateMagnitude } from './stats.js';
import { calculateHeartRateForWindow, type SampleAccessor } from './heart-rate.js';

export interface WindowProcessingInput {
  sessionId: string;
  window: number;
  mode: ProcessingMode;
  // Sensor 1 samples indexed by sample index in [400*w, 400*w + 399] (and history for HR)
  sensor1Samples: Map<number, number[]>;
  // Sensor 2 samples indexed by sample index in [400*w, 400*w + 399]
  sensor2Samples: Map<number, number[]>;
  // Optional precomputed peak list for the session
  knownPeaks?: number[];
  // Extended sample accessor for Sensor 1 Channel 2 covering [400*(w-4), 400*(w+1)]
  extendedS1Ch2Accessor?: SampleAccessor;
}

/**
 * Process a single 1-second window w (samples 400w to 400w + 399)
 * Strictly conforms to Section 3 outputs and rules.
 */
export function processWindow(input: WindowProcessingInput): WindowResult {
  const { sessionId, window: w, mode, sensor1Samples, sensor2Samples, knownPeaks } = input;
  const startIdx = w * WINDOW_SIZE;
  const endIdx = startIdx + WINDOW_SIZE - 1;

  let missing_1 = 0;
  let missing_2 = 0;

  const s1_ch1_vals: number[] = [];
  const s1_ch2_vals: number[] = [];
  const s1_ch3_vals: number[] = [];

  const s2_ch1_vals: number[] = [];
  const s2_ch2_vals: number[] = [];
  const s2_pairs: Array<[number, number]> = [];

  for (let idx = startIdx; idx <= endIdx; idx++) {
    const s1 = sensor1Samples.get(idx);
    if (!s1) {
      missing_1++;
    } else {
      if (s1[0] !== undefined) s1_ch1_vals.push(s1[0]);
      if (s1[1] !== undefined) s1_ch2_vals.push(s1[1]);
      if (s1[2] !== undefined) s1_ch3_vals.push(s1[2]);
    }

    const s2 = sensor2Samples.get(idx);
    if (!s2) {
      missing_2++;
    } else {
      const ch1 = s2[0] ?? 0;
      const ch2 = s2[1] ?? 0;
      s2_ch1_vals.push(ch1);
      s2_ch2_vals.push(ch2);
      s2_pairs.push([ch1, ch2]);
    }
  }

  const complete = missing_1 === 0 && missing_2 === 0;

  // Descriptive statistics
  const s1_c1 = calculateChannelStats(s1_ch1_vals);
  const s1_c2 = calculateChannelStats(s1_ch2_vals);
  const s1_c3 = calculateChannelStats(s1_ch3_vals);

  const s2_c1 = calculateChannelStats(s2_ch1_vals);
  const s2_c2 = calculateChannelStats(s2_ch2_vals);

  // Magnitude over available Sensor 2 samples
  const magnitude = calculateMagnitude(s2_pairs);

  // Heart Rate
  // Sample accessor for Sensor 1 Channel 2
  const s1Ch2Accessor: SampleAccessor = input.extendedS1Ch2Accessor ?? {
    has: (idx: number) => sensor1Samples.has(idx),
    get: (idx: number) => sensor1Samples.get(idx)?.[1],
  };

  const heart_rate = calculateHeartRateForWindow(w, s1Ch2Accessor, knownPeaks);

  return {
    session_id: sessionId,
    window: w,
    missing_1,
    missing_2,
    complete,
    s1_ch1_mean: s1_c1.mean,
    s1_ch1_min: s1_c1.min,
    s1_ch1_max: s1_c1.max,
    s1_ch2_mean: s1_c2.mean,
    s1_ch2_min: s1_c2.min,
    s1_ch2_max: s1_c2.max,
    s1_ch3_mean: s1_c3.mean,
    s1_ch3_min: s1_c3.min,
    s1_ch3_max: s1_c3.max,
    s2_ch1_mean: s2_c1.mean,
    s2_ch1_min: s2_c1.min,
    s2_ch1_max: s2_c1.max,
    s2_ch2_mean: s2_c2.mean,
    s2_ch2_min: s2_c2.min,
    s2_ch2_max: s2_c2.max,
    magnitude,
    heart_rate,
    mode,
  };
}
