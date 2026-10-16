/**
 * Descriptive statistics and magnitude calculation
 * Strictly adheres to Section 3 of the assessment specification
 */

export interface ChannelStats {
  mean: number | null;
  min: number | null;
  max: number | null;
}

/**
 * Calculates per-channel mean, min, and max over available samples.
 * If no samples are available, returns null for all three.
 * Mean is rounded to 1 decimal place.
 */
export function calculateChannelStats(values: number[]): ChannelStats {
  if (values.length === 0) {
    return { mean: null, min: null, max: null };
  }

  let min = values[0]!;
  let max = values[0]!;
  let sum = 0;

  for (let i = 0; i < values.length; i++) {
    const val = values[i]!;
    if (val < min) min = val;
    if (val > max) max = val;
    sum += val;
  }

  const rawMean = sum / values.length;
  const mean = Number(rawMean.toFixed(1));

  return { mean, min, max };
}

/**
 * Calculates Sensor 2 magnitude:
 * Mean of sqrt(ch1^2 + ch2^2) over available Sensor 2 samples.
 * Returns null if no samples are available.
 * Rounded to 1 decimal place.
 */
export function calculateMagnitude(samples: Array<[number, number]>): number | null {
  if (samples.length === 0) {
    return null;
  }

  let sum = 0;
  for (let i = 0; i < samples.length; i++) {
    const [ch1, ch2] = samples[i]!;
    const mag = Math.sqrt(ch1 * ch1 + ch2 * ch2);
    sum += mag;
  }

  const meanMag = sum / samples.length;
  return Number(meanMag.toFixed(1));
}
