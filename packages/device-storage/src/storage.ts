import type { SensorId, StoredSample, StoredLossRecord, WindowResult } from '@mayacardio/shared';
import { openSqliteDatabase, type SqliteDb } from './sqlite-adapter.js';
import { initializeDatabase } from './schema.js';

export interface StorageOptions {
  dbPath?: string;
}

export class DeviceStorage {
  private db: SqliteDb;

  constructor(options?: StorageOptions) {
    const dbPath = options?.dbPath ?? './data/maya_device.db';
    this.db = openSqliteDatabase(dbPath);
    initializeDatabase(this.db);
  }

  public getRawDb(): SqliteDb {
    return this.db;
  }

  public close(): void {
    this.db.close();
  }

  public ensureSession(sessionId: string): void {
    const stmt = this.db.prepare(`
      INSERT INTO sessions (session_id, last_seen_at) 
      VALUES (?, datetime('now'))
      ON CONFLICT(session_id) DO UPDATE SET last_seen_at = datetime('now');
    `);
    stmt.run(sessionId);

    // Ensure checkpoints exist for both sensors
    const cpStmt = this.db.prepare(`
      INSERT INTO checkpoints (session_id, sensor, last_received_index, last_synced_index, last_processed_window)
      VALUES (?, ?, -1, -1, -1)
      ON CONFLICT(session_id, sensor) DO NOTHING;
    `);
    cpStmt.run(sessionId, 1);
    cpStmt.run(sessionId, 2);
  }

  public markSessionEnded(sessionId: string): void {
    const stmt = this.db.prepare(`
      UPDATE sessions SET is_ended = 1, last_seen_at = datetime('now') WHERE session_id = ?;
    `);
    stmt.run(sessionId);
  }

  /**
   * Atomically insert samples and update checkpoint within a single transaction.
   * Checks for duplicate and conflicting samples.
   */
  public insertSamplesAtomic(
    sessionId: string,
    sensor: SensorId,
    firstIndex: number,
    samplesData: number[][]
  ): { inserted: number; duplicates: number; conflicts: number } {
    this.ensureSession(sessionId);

    const checkExistingStmt = this.db.prepare(`
      SELECT ch1, ch2, ch3 FROM samples 
      WHERE session_id = ? AND sensor = ? AND sample_index = ?;
    `);

    const insertSampleStmt = this.db.prepare(`
      INSERT INTO samples (session_id, sensor, sample_index, ch1, ch2, ch3)
      VALUES (?, ?, ?, ?, ?, ?);
    `);

    const recordFaultStmt = this.db.prepare(`
      INSERT INTO integrity_faults (session_id, sensor, sample_index, existing_values, received_values, reason)
      VALUES (?, ?, ?, ?, ?, ?);
    `);

    const updateCheckpointStmt = this.db.prepare(`
      UPDATE checkpoints 
      SET last_received_index = MAX(last_received_index, ?), updated_at = datetime('now')
      WHERE session_id = ? AND sensor = ?;
    `);

    let inserted = 0;
    let duplicates = 0;
    let conflicts = 0;
    let maxIdx = firstIndex - 1;

    const executeTx = this.db.transaction(() => {
      for (let i = 0; i < samplesData.length; i++) {
        const sampleIdx = firstIndex + i;
        const vals = samplesData[i]!;
        const ch1 = vals[0] ?? 0;
        const ch2 = vals[1] ?? 0;
        const ch3 = sensor === 1 ? (vals[2] ?? 0) : null;

        const existing = checkExistingStmt.get(sessionId, sensor, sampleIdx) as
          | { ch1: number; ch2: number; ch3: number | null }
          | undefined;

        if (existing) {
          const isSame =
            existing.ch1 === ch1 &&
            existing.ch2 === ch2 &&
            (sensor === 2 || existing.ch3 === ch3);

          if (isSame) {
            duplicates++;
          } else {
            conflicts++;
            recordFaultStmt.run(
              sessionId,
              sensor,
              sampleIdx,
              JSON.stringify(existing),
              JSON.stringify(vals),
              'Sample value conflict on duplicate receive'
            );
          }
        } else {
          insertSampleStmt.run(sessionId, sensor, sampleIdx, ch1, ch2, ch3);
          inserted++;
        }

        if (sampleIdx > maxIdx) {
          maxIdx = sampleIdx;
        }
      }

      if (maxIdx >= firstIndex) {
        updateCheckpointStmt.run(maxIdx, sessionId, sensor);
      }
    });

    executeTx();

    return { inserted, duplicates, conflicts };
  }

  public recordLoss(loss: StoredLossRecord): void {
    this.ensureSession(loss.session_id);
    const stmt = this.db.prepare(`
      INSERT INTO losses (session_id, sensor, from_index, to_index, reason)
      VALUES (?, ?, ?, ?, ?)
      ON CONFLICT(session_id, sensor, from_index, reason) DO NOTHING;
    `);
    stmt.run(loss.session_id, loss.sensor, loss.from_index, loss.to_index, loss.reason);
  }

  public getCheckpoint(
    sessionId: string,
    sensor: SensorId
  ): { last_received_index: number; last_synced_index: number; last_processed_window: number } | null {
    const stmt = this.db.prepare(`
      SELECT last_received_index, last_synced_index, last_processed_window 
      FROM checkpoints 
      WHERE session_id = ? AND sensor = ?;
    `);
    const row = stmt.get(sessionId, sensor) as
      | { last_received_index: number; last_synced_index: number; last_processed_window: number }
      | undefined;
    return row ?? null;
  }

  public updateSyncCheckpoint(sessionId: string, sensor: SensorId, lastSyncedIndex: number): void {
    const stmt = this.db.prepare(`
      UPDATE checkpoints 
      SET last_synced_index = MAX(last_synced_index, ?), updated_at = datetime('now')
      WHERE session_id = ? AND sensor = ?;
    `);
    stmt.run(lastSyncedIndex, sessionId, sensor);
  }

  public updateProcessedWindow(sessionId: string, sensor: SensorId, window: number): void {
    const stmt = this.db.prepare(`
      UPDATE checkpoints 
      SET last_processed_window = MAX(last_processed_window, ?), updated_at = datetime('now')
      WHERE session_id = ? AND sensor = ?;
    `);
    stmt.run(window, sessionId, sensor);
  }

  /**
   * Fetch samples in range [fromIndex, toIndex] inclusive for a sensor
   */
  public getSamplesRange(
    sessionId: string,
    sensor: SensorId,
    fromIndex: number,
    toIndex: number
  ): Map<number, number[]> {
    const stmt = this.db.prepare(`
      SELECT sample_index, ch1, ch2, ch3 FROM samples
      WHERE session_id = ? AND sensor = ? AND sample_index >= ? AND sample_index <= ?
      ORDER BY sample_index ASC;
    `);
    const rows = stmt.all(sessionId, sensor, fromIndex, toIndex) as Array<{
      sample_index: number;
      ch1: number;
      ch2: number;
      ch3: number | null;
    }>;

    const map = new Map<number, number[]>();
    for (const r of rows) {
      if (sensor === 1) {
        map.set(r.sample_index, [r.ch1, r.ch2, r.ch3 ?? 0]);
      } else {
        map.set(r.sample_index, [r.ch1, r.ch2]);
      }
    }
    return map;
  }

  /**
   * Fetch unsynced samples starting from after last_synced_index up to limit
   */
  public getUnsyncedSamples(
    sessionId: string,
    sensor: SensorId,
    limit = 1000
  ): StoredSample[] {
    const cp = this.getCheckpoint(sessionId, sensor);
    const lastSynced = cp?.last_synced_index ?? -1;

    const stmt = this.db.prepare(`
      SELECT session_id, sensor, sample_index, ch1, ch2, ch3, created_at 
      FROM samples
      WHERE session_id = ? AND sensor = ? AND sample_index > ?
      ORDER BY sample_index ASC
      LIMIT ?;
    `);

    const rows = stmt.all(sessionId, sensor, lastSynced, limit) as Array<{
      session_id: string;
      sensor: number;
      sample_index: number;
      ch1: number;
      ch2: number;
      ch3: number | null;
      created_at: string;
    }>;

    return rows.map((r) => ({
      session_id: r.session_id,
      sensor: r.sensor as SensorId,
      index: r.sample_index,
      values: r.sensor === 1 ? [r.ch1, r.ch2, r.ch3 ?? 0] : [r.ch1, r.ch2],
      created_at: r.created_at,
    }));
  }

  public getAllLosses(sessionId: string): StoredLossRecord[] {
    const stmt = this.db.prepare(`
      SELECT session_id, sensor, from_index, to_index, reason, created_at
      FROM losses
      WHERE session_id = ?
      ORDER BY sensor ASC, from_index ASC;
    `);
    const rows = stmt.all(sessionId) as Array<{
      session_id: string;
      sensor: number;
      from_index: number;
      to_index: number | null;
      reason: string;
      created_at: string;
    }>;

    return rows.map((r) => ({
      session_id: r.session_id,
      sensor: r.sensor as SensorId,
      from_index: r.from_index,
      to_index: r.to_index,
      reason: r.reason,
      created_at: r.created_at,
    }));
  }

  public getAllSamples(sessionId: string): StoredSample[] {
    const stmt = this.db.prepare(`
      SELECT session_id, sensor, sample_index, ch1, ch2, ch3, created_at
      FROM samples
      WHERE session_id = ?
      ORDER BY sensor ASC, sample_index ASC;
    `);
    const rows = stmt.all(sessionId) as Array<{
      session_id: string;
      sensor: number;
      sample_index: number;
      ch1: number;
      ch2: number;
      ch3: number | null;
      created_at: string;
    }>;

    return rows.map((r) => ({
      session_id: r.session_id,
      sensor: r.sensor as SensorId,
      index: r.sample_index,
      values: r.sensor === 1 ? [r.ch1, r.ch2, r.ch3 ?? 0] : [r.ch1, r.ch2],
      created_at: r.created_at,
    }));
  }

  public saveWindowResult(res: WindowResult): void {
    const stmt = this.db.prepare(`
      INSERT INTO results (
        session_id, window, missing_1, missing_2, complete,
        s1_ch1_mean, s1_ch1_min, s1_ch1_max,
        s1_ch2_mean, s1_ch2_min, s1_ch2_max,
        s1_ch3_mean, s1_ch3_min, s1_ch3_max,
        s2_ch1_mean, s2_ch1_min, s2_ch1_max,
        s2_ch2_mean, s2_ch2_min, s2_ch2_max,
        magnitude, heart_rate, mode
      ) VALUES (
        ?, ?, ?, ?, ?,
        ?, ?, ?,
        ?, ?, ?,
        ?, ?, ?,
        ?, ?, ?,
        ?, ?, ?,
        ?, ?, ?
      )
      ON CONFLICT(session_id, window) DO UPDATE SET
        missing_1 = excluded.missing_1,
        missing_2 = excluded.missing_2,
        complete = excluded.complete,
        s1_ch1_mean = excluded.s1_ch1_mean,
        s1_ch1_min = excluded.s1_ch1_min,
        s1_ch1_max = excluded.s1_ch1_max,
        s1_ch2_mean = excluded.s1_ch2_mean,
        s1_ch2_min = excluded.s1_ch2_min,
        s1_ch2_max = excluded.s1_ch2_max,
        s1_ch3_mean = excluded.s1_ch3_mean,
        s1_ch3_min = excluded.s1_ch3_min,
        s1_ch3_max = excluded.s1_ch3_max,
        s2_ch1_mean = excluded.s2_ch1_mean,
        s2_ch1_min = excluded.s2_ch1_min,
        s2_ch1_max = excluded.s2_ch1_max,
        s2_ch2_mean = excluded.s2_ch2_mean,
        s2_ch2_min = excluded.s2_ch2_min,
        s2_ch2_max = excluded.s2_ch2_max,
        magnitude = excluded.magnitude,
        heart_rate = excluded.heart_rate,
        mode = excluded.mode;
    `);

    stmt.run(
      res.session_id,
      res.window,
      res.missing_1,
      res.missing_2,
      res.complete ? 1 : 0,
      res.s1_ch1_mean,
      res.s1_ch1_min,
      res.s1_ch1_max,
      res.s1_ch2_mean,
      res.s1_ch2_min,
      res.s1_ch2_max,
      res.s1_ch3_mean,
      res.s1_ch3_min,
      res.s1_ch3_max,
      res.s2_ch1_mean,
      res.s2_ch1_min,
      res.s2_ch1_max,
      res.s2_ch2_mean,
      res.s2_ch2_min,
      res.s2_ch2_max,
      res.magnitude,
      res.heart_rate,
      res.mode
    );
  }

  public getWindowResults(sessionId: string): WindowResult[] {
    const stmt = this.db.prepare(`
      SELECT * FROM results WHERE session_id = ? ORDER BY window ASC;
    `);
    const rows = stmt.all(sessionId) as Array<Record<string, unknown>>;
    return rows.map((r) => ({
      session_id: String(r['session_id']),
      window: Number(r['window']),
      missing_1: Number(r['missing_1']),
      missing_2: Number(r['missing_2']),
      complete: Boolean(r['complete']),
      s1_ch1_mean: r['s1_ch1_mean'] === null ? null : Number(r['s1_ch1_mean']),
      s1_ch1_min: r['s1_ch1_min'] === null ? null : Number(r['s1_ch1_min']),
      s1_ch1_max: r['s1_ch1_max'] === null ? null : Number(r['s1_ch1_max']),
      s1_ch2_mean: r['s1_ch2_mean'] === null ? null : Number(r['s1_ch2_mean']),
      s1_ch2_min: r['s1_ch2_min'] === null ? null : Number(r['s1_ch2_min']),
      s1_ch2_max: r['s1_ch2_max'] === null ? null : Number(r['s1_ch2_max']),
      s1_ch3_mean: r['s1_ch3_mean'] === null ? null : Number(r['s1_ch3_mean']),
      s1_ch3_min: r['s1_ch3_min'] === null ? null : Number(r['s1_ch3_min']),
      s1_ch3_max: r['s1_ch3_max'] === null ? null : Number(r['s1_ch3_max']),
      s2_ch1_mean: r['s2_ch1_mean'] === null ? null : Number(r['s2_ch1_mean']),
      s2_ch1_min: r['s2_ch1_min'] === null ? null : Number(r['s2_ch1_min']),
      s2_ch1_max: r['s2_ch1_max'] === null ? null : Number(r['s2_ch1_max']),
      s2_ch2_mean: r['s2_ch2_mean'] === null ? null : Number(r['s2_ch2_mean']),
      s2_ch2_min: r['s2_ch2_min'] === null ? null : Number(r['s2_ch2_min']),
      s2_ch2_max: r['s2_ch2_max'] === null ? null : Number(r['s2_ch2_max']),
      magnitude: r['magnitude'] === null ? null : Number(r['magnitude']),
      heart_rate: r['heart_rate'] === null ? null : Number(r['heart_rate']),
      mode: r['mode'] as 'online' | 'offline',
      computed_at: String(r['created_at']),
    }));
  }

  public getStats(sessionId?: string): { samples_saved: number; samples_synced: number; backlog: number } {
    if (sessionId) {
      const savedStmt = this.db.prepare('SELECT COUNT(*) as cnt FROM samples WHERE session_id = ?;');
      const saved = Number((savedStmt.get(sessionId) as { cnt: number }).cnt);

      const cp1 = this.getCheckpoint(sessionId, 1);
      const cp2 = this.getCheckpoint(sessionId, 2);
      const lastSynced1 = cp1?.last_synced_index ?? -1;
      const lastSynced2 = cp2?.last_synced_index ?? -1;

      const backlogStmt = this.db.prepare(`
        SELECT COUNT(*) as cnt FROM samples 
        WHERE session_id = ? AND (
          (sensor = 1 AND sample_index > ?) OR
          (sensor = 2 AND sample_index > ?)
        );
      `);
      const backlog = Number((backlogStmt.get(sessionId, lastSynced1, lastSynced2) as { cnt: number }).cnt);
      const samplesSynced = Math.max(0, saved - backlog);

      return { samples_saved: saved, samples_synced: samplesSynced, backlog };
    }

    const savedStmt = this.db.prepare('SELECT COUNT(*) as cnt FROM samples;');
    const saved = Number((savedStmt.get() as { cnt: number }).cnt);

    const cpStmt = this.db.prepare(`
      SELECT 
        (SELECT COUNT(*) FROM samples s 
         JOIN checkpoints c ON s.session_id = c.session_id AND s.sensor = c.sensor 
         WHERE s.sample_index > c.last_synced_index) as unsynced_count;
    `);
    const unsyncedRow = cpStmt.get() as { unsynced_count: number | null };
    const backlog = Math.max(0, Number(unsyncedRow?.unsynced_count ?? 0));
    const samplesSynced = Math.max(0, saved - backlog);

    return { samples_saved: saved, samples_synced: samplesSynced, backlog };
  }
}
