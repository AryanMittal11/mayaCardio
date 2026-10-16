import type {
  SensorId,
  StoredSample,
  StoredLossRecord,
  WindowResult,
} from '@mayacardio/shared';

export interface IngestBatchInput {
  sessionId: string;
  deviceId: string;
  samples: Array<{ sensor: SensorId; index: number; values: number[] }>;
  losses: Array<{ sensor: SensorId; from_index: number; to_index: number | null; reason: string }>;
}

export interface IngestBatchResult {
  insertedSamples: number;
  duplicateSamples: number;
  conflictSamples: number;
  insertedLosses: number;
}

export interface CloudCoverage {
  sessionId: string;
  sensor: SensorId;
  totalSamples: number;
  lastIndex: number;
  gaps: Array<{ from_index: number; to_index: number }>;
}

export interface ICloudStorage {
  initialize(): Promise<void>;
  close(): Promise<void>;
  ensureSession(sessionId: string, deviceId: string): Promise<void>;
  ingestBatch(input: IngestBatchInput): Promise<IngestBatchResult>;
  getCoverage(sessionId: string, sensor: SensorId): Promise<CloudCoverage>;
  saveResult(result: WindowResult): Promise<void>;
  getResults(sessionId: string): Promise<WindowResult[]>;
  getAllSamples(sessionId: string): Promise<StoredSample[]>;
  getAllLosses(sessionId: string): Promise<StoredLossRecord[]>;
  getSamplesForRange(sessionId: string, sensor: SensorId, fromIdx: number, toIdx: number): Promise<Map<number, number[]>>;
}

/**
 * High-performance In-Memory / Embedded Cloud Storage Implementation
 * Guarantees atomic writes, duplicate detection, and exact conflict checking.
 */
export class MemoryCloudStorage implements ICloudStorage {
  private sessions = new Map<string, { deviceId: string; firstSeen: Date; lastSeen: Date }>();
  // Key: `${sessionId}:${sensor}:${sampleIndex}`
  private samples = new Map<string, { session_id: string; sensor: SensorId; index: number; values: number[] }>();
  // Key: `${sessionId}:${sensor}:${fromIndex}:${reason}`
  private losses = new Map<string, StoredLossRecord>();
  // Key: `${sessionId}:${window}`
  private results = new Map<string, WindowResult>();
  private integrityFaults: Array<{ sessionId: string; sensor: SensorId; index: number; existing: number[]; received: number[]; reason: string }> = [];

  public async initialize(): Promise<void> {
    // Ready immediately
  }

  public async close(): Promise<void> {
    // Nothing to close
  }

  public async ensureSession(sessionId: string, deviceId: string): Promise<void> {
    const existing = this.sessions.get(sessionId);
    if (!existing) {
      this.sessions.set(sessionId, { deviceId, firstSeen: new Date(), lastSeen: new Date() });
    } else {
      existing.lastSeen = new Date();
    }
  }

  public async ingestBatch(input: IngestBatchInput): Promise<IngestBatchResult> {
    await this.ensureSession(input.sessionId, input.deviceId);

    let insertedSamples = 0;
    let duplicateSamples = 0;
    let conflictSamples = 0;
    let insertedLosses = 0;

    for (const sample of input.samples) {
      const key = `${input.sessionId}:${sample.sensor}:${sample.index}`;
      const existing = this.samples.get(key);

      if (existing) {
        const isMatch =
          existing.values.length === sample.values.length &&
          existing.values.every((v, i) => v === sample.values[i]);

        if (isMatch) {
          duplicateSamples++;
        } else {
          conflictSamples++;
          this.integrityFaults.push({
            sessionId: input.sessionId,
            sensor: sample.sensor,
            index: sample.index,
            existing: existing.values,
            received: sample.values,
            reason: 'Conflicting sample value during cloud ingestion',
          });
        }
      } else {
        this.samples.set(key, {
          session_id: input.sessionId,
          sensor: sample.sensor,
          index: sample.index,
          values: [...sample.values],
        });
        insertedSamples++;
      }
    }

    for (const loss of input.losses) {
      const key = `${input.sessionId}:${loss.sensor}:${loss.from_index}:${loss.reason}`;
      if (!this.losses.has(key)) {
        this.losses.set(key, {
          session_id: input.sessionId,
          sensor: loss.sensor,
          from_index: loss.from_index,
          to_index: loss.to_index,
          reason: loss.reason,
        });
        insertedLosses++;
      }
    }

    return {
      insertedSamples,
      duplicateSamples,
      conflictSamples,
      insertedLosses,
    };
  }

  public async getCoverage(sessionId: string, sensor: SensorId): Promise<CloudCoverage> {
    let total = 0;
    let maxIdx = -1;
    const indices: number[] = [];

    for (const sample of this.samples.values()) {
      if (sample.session_id === sessionId && sample.sensor === sensor) {
        total++;
        indices.push(sample.index);
        if (sample.index > maxIdx) maxIdx = sample.index;
      }
    }

    indices.sort((a, b) => a - b);
    const gaps: Array<{ from_index: number; to_index: number }> = [];

    for (let i = 0; i < indices.length - 1; i++) {
      const cur = indices[i]!;
      const nxt = indices[i + 1]!;
      if (nxt > cur + 1) {
        gaps.push({ from_index: cur + 1, to_index: nxt - 1 });
      }
    }

    return {
      sessionId,
      sensor,
      totalSamples: total,
      lastIndex: maxIdx,
      gaps,
    };
  }

  public async saveResult(result: WindowResult): Promise<void> {
    const key = `${result.session_id}:${result.window}`;
    this.results.set(key, { ...result });
  }

  public async getResults(sessionId: string): Promise<WindowResult[]> {
    const list: WindowResult[] = [];
    for (const res of this.results.values()) {
      if (res.session_id === sessionId) {
        list.push(res);
      }
    }
    return list.sort((a, b) => a.window - b.window);
  }

  public async getAllSamples(sessionId: string): Promise<StoredSample[]> {
    const list: StoredSample[] = [];
    for (const s of this.samples.values()) {
      if (s.session_id === sessionId) {
        list.push(s);
      }
    }
    return list.sort((a, b) => {
      if (a.sensor !== b.sensor) return a.sensor - b.sensor;
      return a.index - b.index;
    });
  }

  public async getAllLosses(sessionId: string): Promise<StoredLossRecord[]> {
    const list: StoredLossRecord[] = [];
    for (const l of this.losses.values()) {
      if (l.session_id === sessionId) {
        list.push(l);
      }
    }
    return list.sort((a, b) => {
      if (a.sensor !== b.sensor) return a.sensor - b.sensor;
      return a.from_index - b.from_index;
    });
  }

  public async getSamplesForRange(
    sessionId: string,
    sensor: SensorId,
    fromIdx: number,
    toIdx: number
  ): Promise<Map<number, number[]>> {
    const map = new Map<number, number[]>();
    for (let i = fromIdx; i <= toIdx; i++) {
      const key = `${sessionId}:${sensor}:${i}`;
      const sample = this.samples.get(key);
      if (sample) {
        map.set(i, sample.values);
      }
    }
    return map;
  }
}
