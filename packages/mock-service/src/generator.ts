import {
  SAMPLE_RATE,
  MOD_INT24,
  type SensorId,
} from '@mayacardio/shared';

export type MockMode = 'signal' | 'ramp';

/**
 * Seedable PRNG (Mulberry32) for deterministic reproducible testing
 */
export function createRng(seed: number): () => number {
  let s = seed >>> 0;
  return () => {
    s = (s + 0x6d2b79f5) >>> 0;
    let t = Math.imul(s ^ (s >>> 15), 1 | s);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

export class BiosignalGenerator {
  private mode: MockMode;
  private seed: number;
  private rng: () => number;

  constructor(mode: MockMode = 'signal', seed = 7) {
    this.mode = mode;
    this.seed = seed;
    this.rng = createRng(seed);
  }

  /**
   * Generates sample at index `i` for Sensor 1: [ch1, ch2, ch3]
   * Ramp mode: Sensor 1 channel c at sample i = (3i + c) mod 8,388,608. (c in 1..3)
   */
  public generateSensor1(i: number): [number, number, number] {
    if (this.mode === 'ramp') {
      const ch1 = (3 * i + 1) % MOD_INT24;
      const ch2 = (3 * i + 2) % MOD_INT24;
      const ch3 = (3 * i + 3) % MOD_INT24;
      return [ch1, ch2, ch3];
    }

    // Realistic synthetic ECG data (§6.1)
    // Heart rate is 60 bpm for min 0-2, 90 bpm for min 2-4, 72 bpm for min 4-6, repeating.
    const second = i / SAMPLE_RATE;
    const minuteInCycle = (second / 60) % 6;

    let targetBpm = 60;
    let beatIntervalSamples = 400; // 60 bpm = 1 beat/sec = 400 samples

    if (minuteInCycle >= 2 && minuteInCycle < 4) {
      targetBpm = 90;
      beatIntervalSamples = Math.round((60 * SAMPLE_RATE) / 90); // ~267 samples
    } else if (minuteInCycle >= 4) {
      targetBpm = 72;
      beatIntervalSamples = Math.round((60 * SAMPLE_RATE) / 72); // ~333 samples
    }

    // Phase within heartbeat
    const beatPhase = i % beatIntervalSamples;

    // ECG waveform approximation on Channel 2:
    // Sharp QRS peak at beatPhase == 0 (e.g. value 2000), baseline ~200 with slight P and T waves
    let ch2 = 200;
    if (beatPhase === 0) {
      ch2 = 2500; // Sharp peak
    } else if (beatPhase === 1 || beatPhase === beatIntervalSamples - 1) {
      ch2 = 150; // Q / S dip
    } else if (beatPhase > 20 && beatPhase < 50) {
      ch2 = 280; // T wave
    } else if (beatPhase > beatIntervalSamples - 40 && beatPhase < beatIntervalSamples - 10) {
      ch2 = 240; // P wave
    }

    // Sensor 1, channels 1 and 3 are channel 2 * 0.6 and * 1.3
    const ch1 = Math.round(ch2 * 0.6);
    const ch3 = Math.round(ch2 * 1.3);

    return [ch1, ch2, ch3];
  }

  /**
   * Generates sample at index `i` for Sensor 2: [ch1, ch2]
   * Ramp mode: Sensor 2 channel c = (2i + c) mod 8,388,608. (c in 1..2)
   */
  public generateSensor2(i: number): [number, number] {
    if (this.mode === 'ramp') {
      const ch1 = (2 * i + 1) % MOD_INT24;
      const ch2 = (2 * i + 2) % MOD_INT24;
      return [ch1, ch2];
    }

    // Sensor 2 has channel 1 near 400,000 and channel 2 near 150,000, varying slowly.
    const second = i / SAMPLE_RATE;
    const slowVar1 = Math.sin((2 * Math.PI * second) / 30) * 5000;
    const slowVar2 = Math.cos((2 * Math.PI * second) / 45) * 3000;

    const ch1 = Math.round(400_000 + slowVar1);
    const ch2 = Math.round(150_000 + slowVar2);

    return [ch1, ch2];
  }

  public generate(sensor: SensorId, i: number): number[] {
    return sensor === 1 ? this.generateSensor1(i) : this.generateSensor2(i);
  }
}
