import pg from 'pg';
import type {
  SensorId,
  StoredSample,
  StoredLossRecord,
  WindowResult,
} from '@mayacardio/shared';
import type {
  ICloudStorage,
  IngestBatchInput,
  IngestBatchResult,
  CloudCoverage,
} from './repository.js';
import { PG_SCHEMA_SQL } from './schema.js';

const { Pool } = pg;

export class PgCloudStorage implements ICloudStorage {
  private pool: pg.Pool;

  constructor(connectionString: string) {
    this.pool = new Pool({
      connectionString,
      max: 10,
      idleTimeoutMillis: 30000,
      connectionTimeoutMillis: 5000,
    });
  }

  public async initialize(): Promise<void> {
    const client = await this.pool.connect();
    try {
      await client.query(PG_SCHEMA_SQL);
    } finally {
      client.release();
    }
  }

  public async close(): Promise<void> {
    await this.pool.end();
  }

  public async ensureSession(sessionId: string, deviceId: string): Promise<void> {
    await this.pool.query(
      `
      INSERT INTO cloud_sessions (session_id, device_id, last_seen_at)
      VALUES ($1, $2, NOW())
      ON CONFLICT (session_id) DO UPDATE SET last_seen_at = NOW();
      `,
      [sessionId, deviceId]
    );
  }

  public async ingestBatch(input: IngestBatchInput): Promise<IngestBatchResult> {
    await this.ensureSession(input.sessionId, input.deviceId);

    const client = await this.pool.connect();
    let insertedSamples = 0;
    let duplicateSamples = 0;
    let conflictSamples = 0;
    let insertedLosses = 0;

    try {
      await client.query('BEGIN');

      // Process samples
      for (const sample of input.samples) {
        const ch1 = sample.values[0] ?? 0;
        const ch2 = sample.values[1] ?? 0;
        const ch3 = sample.sensor === 1 ? (sample.values[2] ?? 0) : null;

        const checkRes = await client.query(
          `SELECT ch1, ch2, ch3 FROM cloud_samples WHERE session_id = $1 AND sensor = $2 AND sample_index = $3`,
          [input.sessionId, sample.sensor, sample.index]
        );

        if (checkRes.rows.length > 0) {
          const row = checkRes.rows[0];
          const isMatch =
            row.ch1 === ch1 &&
            row.ch2 === ch2 &&
            (sample.sensor === 2 || row.ch3 === ch3);

          if (isMatch) {
            duplicateSamples++;
          } else {
            conflictSamples++;
            await client.query(
              `INSERT INTO cloud_integrity_faults (session_id, sensor, sample_index, existing_values, received_values, reason)
               VALUES ($1, $2, $3, $4, $5, $6)`,
              [
                input.sessionId,
                sample.sensor,
                sample.index,
                JSON.stringify(row),
                JSON.stringify(sample.values),
                'Conflicting sample value during PostgreSQL ingestion',
              ]
            );
          }
        } else {
          await client.query(
            `INSERT INTO cloud_samples (session_id, sensor, sample_index, ch1, ch2, ch3)
             VALUES ($1, $2, $3, $4, $5, $6)`,
            [input.sessionId, sample.sensor, sample.index, ch1, ch2, ch3]
          );
          insertedSamples++;
        }
      }

      // Process losses
      for (const loss of input.losses) {
        const res = await client.query(
          `INSERT INTO cloud_losses (session_id, sensor, from_index, to_index, reason)
           VALUES ($1, $2, $3, $4, $5)
           ON CONFLICT (session_id, sensor, from_index, reason) DO NOTHING`,
          [input.sessionId, loss.sensor, loss.from_index, loss.to_index, loss.reason]
        );
        if ((res.rowCount ?? 0) > 0) {
          insertedLosses++;
        }
      }

      await client.query('COMMIT');
    } catch (err) {
      await client.query('ROLLBACK');
      throw err;
    } finally {
      client.release();
    }

    return {
      insertedSamples,
      duplicateSamples,
      conflictSamples,
      insertedLosses,
    };
  }

  public async getCoverage(sessionId: string, sensor: SensorId): Promise<CloudCoverage> {
    const totalRes = await this.pool.query(
      `SELECT COUNT(*) as cnt, MAX(sample_index) as max_idx FROM cloud_samples WHERE session_id = $1 AND sensor = $2`,
      [sessionId, sensor]
    );
    const total = parseInt(totalRes.rows[0]?.cnt ?? '0', 10);
    const maxIdx = totalRes.rows[0]?.max_idx !== null ? parseInt(totalRes.rows[0]?.max_idx, 10) : -1;

    // Detect gaps using SQL window function
    const gapRes = await this.pool.query(
      `
      WITH sequenced AS (
        SELECT sample_index, LEAD(sample_index) OVER (ORDER BY sample_index ASC) as next_idx
        FROM cloud_samples
        WHERE session_id = $1 AND sensor = $2
      )
      SELECT sample_index + 1 as from_index, next_idx - 1 as to_index
      FROM sequenced
      WHERE next_idx > sample_index + 1;
      `,
      [sessionId, sensor]
    );

    const gaps = gapRes.rows.map((r) => ({
      from_index: parseInt(r.from_index, 10),
      to_index: parseInt(r.to_index, 10),
    }));

    return {
      sessionId,
      sensor,
      totalSamples: total,
      lastIndex: maxIdx,
      gaps,
    };
  }

  public async saveResult(result: WindowResult): Promise<void> {
    await this.pool.query(
      `
      INSERT INTO cloud_results (
        session_id, window, missing_1, missing_2, complete,
        s1_ch1_mean, s1_ch1_min, s1_ch1_max,
        s1_ch2_mean, s1_ch2_min, s1_ch2_max,
        s1_ch3_mean, s1_ch3_min, s1_ch3_max,
        s2_ch1_mean, s2_ch1_min, s2_ch1_max,
        s2_ch2_mean, s2_ch2_min, s2_ch2_max,
        magnitude, heart_rate, mode
      ) VALUES (
        $1, $2, $3, $4, $5,
        $6, $7, $8,
        $9, $10, $11,
        $12, $13, $14,
        $15, $16, $17,
        $18, $19, $20,
        $21, $22, $23
      )
      ON CONFLICT (session_id, window) DO UPDATE SET
        missing_1 = EXCLUDED.missing_1,
        missing_2 = EXCLUDED.missing_2,
        complete = EXCLUDED.complete,
        s1_ch1_mean = EXCLUDED.s1_ch1_mean,
        s1_ch1_min = EXCLUDED.s1_ch1_min,
        s1_ch1_max = EXCLUDED.s1_ch1_max,
        s1_ch2_mean = EXCLUDED.s1_ch2_mean,
        s1_ch2_min = EXCLUDED.s1_ch2_min,
        s1_ch2_max = EXCLUDED.s1_ch2_max,
        s1_ch3_mean = EXCLUDED.s1_ch3_mean,
        s1_ch3_min = EXCLUDED.s1_ch3_min,
        s1_ch3_max = EXCLUDED.s1_ch3_max,
        s2_ch1_mean = EXCLUDED.s2_ch1_mean,
        s2_ch1_min = EXCLUDED.s2_ch1_min,
        s2_ch1_max = EXCLUDED.s2_ch1_max,
        s2_ch2_mean = EXCLUDED.s2_ch2_mean,
        s2_ch2_min = EXCLUDED.s2_ch2_min,
        s2_ch2_max = EXCLUDED.s2_ch2_max,
        magnitude = EXCLUDED.magnitude,
        heart_rate = EXCLUDED.heart_rate,
        mode = EXCLUDED.mode;
      `,
      [
        result.session_id,
        result.window,
        result.missing_1,
        result.missing_2,
        result.complete,
        result.s1_ch1_mean,
        result.s1_ch1_min,
        result.s1_ch1_max,
        result.s1_ch2_mean,
        result.s1_ch2_min,
        result.s1_ch2_max,
        result.s1_ch3_mean,
        result.s1_ch3_min,
        result.s1_ch3_max,
        result.s2_ch1_mean,
        result.s2_ch1_min,
        result.s2_ch1_max,
        result.s2_ch2_mean,
        result.s2_ch2_min,
        result.s2_ch2_max,
        result.magnitude,
        result.heart_rate,
        result.mode,
      ]
    );
  }

  public async getResults(sessionId: string): Promise<WindowResult[]> {
    const res = await this.pool.query(
      `SELECT * FROM cloud_results WHERE session_id = $1 ORDER BY window ASC`,
      [sessionId]
    );

    return res.rows.map((r) => ({
      session_id: r.session_id,
      window: r.window,
      missing_1: r.missing_1,
      missing_2: r.missing_2,
      complete: r.complete,
      s1_ch1_mean: r.s1_ch1_mean !== null ? parseFloat(r.s1_ch1_mean) : null,
      s1_ch1_min: r.s1_ch1_min,
      s1_ch1_max: r.s1_ch1_max,
      s1_ch2_mean: r.s1_ch2_mean !== null ? parseFloat(r.s1_ch2_mean) : null,
      s1_ch2_min: r.s1_ch2_min,
      s1_ch2_max: r.s1_ch2_max,
      s1_ch3_mean: r.s1_ch3_mean !== null ? parseFloat(r.s1_ch3_mean) : null,
      s1_ch3_min: r.s1_ch3_min,
      s1_ch3_max: r.s1_ch3_max,
      s2_ch1_mean: r.s2_ch1_mean !== null ? parseFloat(r.s2_ch1_mean) : null,
      s2_ch1_min: r.s2_ch1_min,
      s2_ch1_max: r.s2_ch1_max,
      s2_ch2_mean: r.s2_ch2_mean !== null ? parseFloat(r.s2_ch2_mean) : null,
      s2_ch2_min: r.s2_ch2_min,
      s2_ch2_max: r.s2_ch2_max,
      magnitude: r.magnitude !== null ? parseFloat(r.magnitude) : null,
      heart_rate: r.heart_rate !== null ? parseFloat(r.heart_rate) : null,
      mode: r.mode as 'online' | 'offline',
      computed_at: r.computed_at?.toISOString(),
    }));
  }

  public async getAllSamples(sessionId: string): Promise<StoredSample[]> {
    const res = await this.pool.query(
      `SELECT session_id, sensor, sample_index, ch1, ch2, ch3, ingested_at
       FROM cloud_samples
       WHERE session_id = $1
       ORDER BY sensor ASC, sample_index ASC`,
      [sessionId]
    );

    return res.rows.map((r) => ({
      session_id: r.session_id,
      sensor: r.sensor as SensorId,
      index: parseInt(r.sample_index, 10),
      values: r.sensor === 1 ? [r.ch1, r.ch2, r.ch3] : [r.ch1, r.ch2],
      created_at: r.ingested_at?.toISOString(),
    }));
  }

  public async getAllLosses(sessionId: string): Promise<StoredLossRecord[]> {
    const res = await this.pool.query(
      `SELECT session_id, sensor, from_index, to_index, reason, ingested_at
       FROM cloud_losses
       WHERE session_id = $1
       ORDER BY sensor ASC, from_index ASC`,
      [sessionId]
    );

    return res.rows.map((r) => ({
      session_id: r.session_id,
      sensor: r.sensor as SensorId,
      from_index: parseInt(r.from_index, 10),
      to_index: r.to_index !== null ? parseInt(r.to_index, 10) : null,
      reason: r.reason,
      created_at: r.ingested_at?.toISOString(),
    }));
  }

  public async getSamplesForRange(
    sessionId: string,
    sensor: SensorId,
    fromIdx: number,
    toIdx: number
  ): Promise<Map<number, number[]>> {
    const res = await this.pool.query(
      `SELECT sample_index, ch1, ch2, ch3
       FROM cloud_samples
       WHERE session_id = $1 AND sensor = $2 AND sample_index >= $3 AND sample_index <= $4
       ORDER BY sample_index ASC`,
      [sessionId, sensor, fromIdx, toIdx]
    );

    const map = new Map<number, number[]>();
    for (const r of res.rows) {
      const idx = parseInt(r.sample_index, 10);
      map.set(idx, sensor === 1 ? [r.ch1, r.ch2, r.ch3] : [r.ch1, r.ch2]);
    }
    return map;
  }
}
