import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import { DeviceStorage } from '../packages/device-storage/src/storage.js';

describe('Device Storage Module (SQLite WAL & synchronous=FULL)', () => {
  const testDbDir = './test_data';
  const testDbPath = path.join(testDbDir, 'test_device.db');
  let storage: DeviceStorage;

  beforeEach(() => {
    if (fs.existsSync(testDbPath)) {
      try {
        fs.unlinkSync(testDbPath);
      } catch {
        // ignore
      }
    }
    storage = new DeviceStorage({ dbPath: testDbPath });
  });

  afterEach(() => {
    storage.close();
    try {
      if (fs.existsSync(testDbPath)) fs.unlinkSync(testDbPath);
      if (fs.existsSync(`${testDbPath}-wal`)) fs.unlinkSync(`${testDbPath}-wal`);
      if (fs.existsSync(`${testDbPath}-shm`)) fs.unlinkSync(`${testDbPath}-shm`);
    } catch {
      // ignore
    }
  });

  it('verifies SQLite PRAGMA journal_mode is WAL and synchronous is FULL', () => {
    const rawDb = storage.getRawDb();
    const journalMode = rawDb.prepare('PRAGMA journal_mode;').get();
    const syncMode = rawDb.prepare('PRAGMA synchronous;').get();

    expect(String(journalMode?.['journal_mode']).toLowerCase()).toBe('wal');
    expect(Number(syncMode?.['synchronous'])).toBe(2); // 2 is FULL
  });

  it('atomically inserts samples and updates sensor checkpoint', () => {
    const sessionId = 'session_test_01';
    const samples = [
      [720, 1200, 1560],
      [708, 1180, 1534],
      [726, 1210, 1573],
    ];

    const res = storage.insertSamplesAtomic(sessionId, 1, 0, samples);
    expect(res.inserted).toBe(3);
    expect(res.duplicates).toBe(0);
    expect(res.conflicts).toBe(0);

    const cp = storage.getCheckpoint(sessionId, 1);
    expect(cp?.last_received_index).toBe(2);

    const retrieved = storage.getSamplesRange(sessionId, 1, 0, 2);
    expect(retrieved.size).toBe(3);
    expect(retrieved.get(0)).toEqual([720, 1200, 1560]);
    expect(retrieved.get(1)).toEqual([708, 1180, 1534]);
    expect(retrieved.get(2)).toEqual([726, 1210, 1573]);
  });

  it('handles duplicate replies idempotently without creating duplicate rows', () => {
    const sessionId = 'session_test_02';
    const samples = [
      [100, 200, 300],
      [101, 201, 301],
    ];

    storage.insertSamplesAtomic(sessionId, 1, 10, samples);
    const dupRes = storage.insertSamplesAtomic(sessionId, 1, 10, samples);

    expect(dupRes.inserted).toBe(0);
    expect(dupRes.duplicates).toBe(2);
    expect(dupRes.conflicts).toBe(0);

    const all = storage.getAllSamples(sessionId);
    expect(all.length).toBe(2);
  });

  it('records an integrity fault when conflicting sample values are received', () => {
    const sessionId = 'session_test_03';
    storage.insertSamplesAtomic(sessionId, 1, 0, [[100, 200, 300]]);

    // Now attempt to insert same sample index with different values
    const conflictRes = storage.insertSamplesAtomic(sessionId, 1, 0, [[999, 999, 999]]);
    expect(conflictRes.inserted).toBe(0);
    expect(conflictRes.conflicts).toBe(1);

    // Stored sample should remain original
    const range = storage.getSamplesRange(sessionId, 1, 0, 0);
    expect(range.get(0)).toEqual([100, 200, 300]);

    // Fault must be logged in integrity_faults table
    const fault = storage.getRawDb().prepare('SELECT * FROM integrity_faults WHERE session_id = ?').get(sessionId);
    expect(fault).toBeDefined();
    expect(fault?.['sample_index']).toBe(0);
  });

  it('records loss records and retrieves them ordered', () => {
    const sessionId = 'session_test_04';
    storage.recordLoss({
      session_id: sessionId,
      sensor: 1,
      from_index: 4000,
      to_index: 4399,
      reason: 'buffer_overflow',
    });

    storage.recordLoss({
      session_id: sessionId,
      sensor: 2,
      from_index: 5000,
      to_index: null,
      reason: 'mock_restart',
    });

    const losses = storage.getAllLosses(sessionId);
    expect(losses.length).toBe(2);
    expect(losses[0]?.from_index).toBe(4000);
    expect(losses[0]?.to_index).toBe(4399);
    expect(losses[1]?.to_index).toBeNull();
  });

  it('tracks sync progress and unsynced backlog accurately', () => {
    const sessionId = 'session_test_05';
    const samples = Array.from({ length: 500 }, (_, i) => [i, i * 2, i * 3]);
    storage.insertSamplesAtomic(sessionId, 1, 0, samples);

    let unsynced = storage.getUnsyncedSamples(sessionId, 1, 200);
    expect(unsynced.length).toBe(200);
    expect(unsynced[0]?.index).toBe(0);
    expect(unsynced[199]?.index).toBe(199);

    storage.updateSyncCheckpoint(sessionId, 1, 199);

    unsynced = storage.getUnsyncedSamples(sessionId, 1, 200);
    expect(unsynced.length).toBe(200);
    expect(unsynced[0]?.index).toBe(200);
    expect(unsynced[199]?.index).toBe(399);
  });
});
