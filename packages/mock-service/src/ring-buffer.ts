import { MOCK_BUFFER_SAMPLES, type MockLostRange } from '@mayacardio/shared';

export interface BufferSample {
  index: number;
  values: number[];
}

export class SensorRingBuffer {
  private capacity: number;
  private buffer: Map<number, number[]> = new Map();
  private oldestIndex = 0;
  private newestIndex = -1;

  constructor(capacity = MOCK_BUFFER_SAMPLES) {
    this.capacity = capacity;
  }

  public push(index: number, values: number[]): MockLostRange | null {
    this.buffer.set(index, values);
    this.newestIndex = Math.max(this.newestIndex, index);

    let lostRange: MockLostRange | null = null;
    const threshold = this.newestIndex - this.capacity + 1;

    if (this.oldestIndex < threshold) {
      lostRange = {
        from_index: this.oldestIndex,
        to_index: threshold - 1,
        reason: 'buffer_overflow',
      };
      for (let i = this.oldestIndex; i < threshold; i++) {
        this.buffer.delete(i);
      }
      this.oldestIndex = threshold;
    }

    return lostRange;
  }

  public getOldestIndex(): number {
    return this.oldestIndex;
  }

  public getNewestIndex(): number {
    return this.newestIndex;
  }

  public readRange(
    startIndex: number,
    maxCount = 400
  ): {
    firstIndex: number;
    count: number;
    data: number[][];
    lost: MockLostRange[];
  } {
    const lost: MockLostRange[] = [];
    let effectiveStart = startIndex;

    if (this.buffer.size === 0) {
      return { firstIndex: startIndex, count: 0, data: [], lost: [] };
    }

    // Check if requested start index has already fallen out of the buffer
    if (startIndex < this.oldestIndex) {
      lost.push({
        from_index: startIndex,
        to_index: this.oldestIndex - 1,
        reason: 'buffer_overflow',
      });
      effectiveStart = this.oldestIndex;
    }

    const data: number[][] = [];
    const limit = Math.min(this.newestIndex + 1, effectiveStart + maxCount);

    for (let i = effectiveStart; i < limit; i++) {
      const sample = this.buffer.get(i);
      if (sample) {
        data.push(sample);
      } else {
        break;
      }
    }

    return {
      firstIndex: effectiveStart,
      count: data.length,
      data,
      lost,
    };
  }

  public clear(): void {
    this.buffer.clear();
    this.oldestIndex = 0;
    this.newestIndex = -1;
  }
}
