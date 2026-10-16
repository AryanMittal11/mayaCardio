/**
 * Exact Heart Rate calculation logic
 * Derived strictly from Section 3 of the assessment specification
 */

import {
  SAMPLE_RATE,
  HR_PREV_SAMPLES_REQUIRED,
  HR_NEXT_SAMPLES_REQUIRED,
  HR_REFRACTORY_SAMPLES,
  HR_WINDOW_LOOKBACK_SECONDS,
} from '@mayacardio/shared';

export interface SampleAccessor {
  has(index: number): boolean;
  get(index: number): number | undefined;
}

/**
 * Checks if sample at index `i` is a valid peak according to the 4 strict rules:
 * 1. The 800 samples before it [i-800, i-1], and the sample after it [i+1], are available.
 * 2. It is strictly larger than both neighbours: v[i] > v[i-1] && v[i] > v[i+1].
 * 3. It is strictly larger than half of the maximum of the 800 samples before it:
 *    v[i] > 0.5 * max(v[i-800 ... i-1]).
 * 4. It is at least 100 samples after the previous peak: (i - lastPeakIndex) >= 100.
 */
export function isPeak(
  i: number,
  samples: SampleAccessor,
  lastPeakIndex: number | null
): boolean {
  // Rule 4 check first (fastest rejection)
  if (lastPeakIndex !== null && i - lastPeakIndex < HR_REFRACTORY_SAMPLES) {
    return false;
  }

  // Rule 1: Check availability of sample after it
  if (!samples.has(i + HR_NEXT_SAMPLES_REQUIRED)) {
    return false;
  }

  const valI = samples.get(i);
  const valNext = samples.get(i + 1);
  const valPrev = samples.get(i - 1);

  if (valI === undefined || valNext === undefined || valPrev === undefined) {
    return false;
  }

  // Rule 2: Strictly larger than both neighbours
  if (valI <= valPrev || valI <= valNext) {
    return false;
  }

  // Rule 1: Check availability of 800 samples before it
  let maxPreceding = -Infinity;
  for (let k = i - HR_PREV_SAMPLES_REQUIRED; k < i; k++) {
    if (!samples.has(k)) {
      return false; // Missing sample in preceding 800
    }
    const valK = samples.get(k)!;
    if (valK > maxPreceding) {
      maxPreceding = valK;
    }
  }

  // Rule 3: Strictly larger than half of the maximum of the 800 samples before it
  const halfMax = 0.5 * maxPreceding;
  if (valI <= halfMax) {
    return false;
  }

  return true;
}

/**
 * Evaluates heart rate for window w:
 * 1. Returns null if w < 4.
 * 2. Interval is [400*(w-4), 400*(w+1)-1].
 * 3. Returns null if ANY sample in that 5-second interval is missing.
 * 4. Takes all qualified peaks within that 5-second interval.
 * 5. Returns null if fewer than 2 peaks qualify.
 * 6. Rate = 60 / (mean gap between consecutive peaks in seconds).
 *    Rate = 24000 * (numPeaks - 1) / (lastPeak - firstPeak).
 *    Rounded to 1 decimal place.
 */
export function calculateHeartRateForWindow(
  w: number,
  samples: SampleAccessor,
  allPeaksInSession?: number[]
): number | null {
  if (w < HR_WINDOW_LOOKBACK_SECONDS - 1) {
    return null; // w < 4
  }

  const intervalStart = SAMPLE_RATE * (w - 4);
  const intervalEnd = SAMPLE_RATE * (w + 1) - 1;

  // Requirement: if ANY sample in those 5 seconds is missing, heart_rate is null
  for (let idx = intervalStart; idx <= intervalEnd; idx++) {
    if (!samples.has(idx)) {
      return null;
    }
  }

  // Find or filter peaks
  let peaksInInterval: number[] = [];

  if (allPeaksInSession) {
    peaksInInterval = allPeaksInSession.filter(
      (p) => p >= intervalStart && p <= intervalEnd
    );
  } else {
    // Scan peaks from beginning up to intervalEnd to respect previous peak refractory period
    let lastPeak: number | null = null;
    for (let idx = HR_PREV_SAMPLES_REQUIRED; idx <= intervalEnd; idx++) {
      if (isPeak(idx, samples, lastPeak)) {
        lastPeak = idx;
        if (idx >= intervalStart && idx <= intervalEnd) {
          peaksInInterval.push(idx);
        }
      }
    }
  }

  if (peaksInInterval.length < 2) {
    return null;
  }

  const firstPeak = peaksInInterval[0]!;
  const lastPeak = peaksInInterval[peaksInInterval.length - 1]!;
  const numGaps = peaksInInterval.length - 1;
  const totalGapSamples = lastPeak - firstPeak;

  // Mean gap in seconds = (totalGapSamples / numGaps) / SAMPLE_RATE
  // Heart rate = 60 / meanGapSeconds = 60 * SAMPLE_RATE * numGaps / totalGapSamples
  const meanGapSeconds = totalGapSamples / (numGaps * SAMPLE_RATE);
  if (meanGapSeconds <= 0) {
    return null;
  }

  const hr = 60 / meanGapSeconds;
  return Number(hr.toFixed(1));
}

/**
 * Stateful class to maintain rolling peaks for continuous streaming
 */
export class StreamingHeartRateDetector {
  private peaks: number[] = [];
  private lastEvaluatedIndex = -1;

  public reset(): void {
    this.peaks = [];
    this.lastEvaluatedIndex = -1;
  }

  public getKnownPeaks(): number[] {
    return [...this.peaks];
  }

  /**
   * Process samples up to maxAvailableIndex and detect any new peaks
   */
  public updatePeaks(maxAvailableIndex: number, samples: SampleAccessor): void {
    // Needs 1 lookahead sample, so can only evaluate up to maxAvailableIndex - 1
    const evalLimit = maxAvailableIndex - HR_NEXT_SAMPLES_REQUIRED;
    const startIndex = Math.max(HR_PREV_SAMPLES_REQUIRED, this.lastEvaluatedIndex + 1);

    let lastPeak = this.peaks.length > 0 ? this.peaks[this.peaks.length - 1]! : null;

    for (let i = startIndex; i <= evalLimit; i++) {
      if (isPeak(i, samples, lastPeak)) {
        this.peaks.push(i);
        lastPeak = i;
      }
      this.lastEvaluatedIndex = i;
    }
  }

  public calculateForWindow(w: number, samples: SampleAccessor): number | null {
    return calculateHeartRateForWindow(w, samples, this.peaks);
  }
}
