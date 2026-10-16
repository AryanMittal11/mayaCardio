import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import { DeviceStorage } from '../packages/device-storage/src/storage.js';
import { executeStatus } from '../packages/cli/src/commands/status.js';
import { executeExport } from '../packages/cli/src/commands/export.js';
import { executeResults } from '../packages/cli/src/commands/results.js';

describe('Required CLI Commands (§4)', () => {
  const testDbDir = './test_data';
  const testDbPath = path.join(testDbDir, 'cli_test.db');
  const sessionId = 'cli_session_test_01';
  let storage: DeviceStorage;

  beforeAll(() => {
    if (fs.existsSync(testDbPath)) {
      try {
        fs.unlinkSync(testDbPath);
      } catch {
        // ignore
      }
    }

    storage = new DeviceStorage({ dbPath: testDbPath });
    storage.ensureSession(sessionId);

    // Insert samples: 400 for sensor 1, 400 for sensor 2
    const s1 = Array.from({ length: 400 }, () => [720, 1200, 1560]);
    const s2 = Array.from({ length: 400 }, () => [400000, 150000]);
    storage.insertSamplesAtomic(sessionId, 1, 0, s1);
    storage.insertSamplesAtomic(sessionId, 2, 0, s2);

    // Insert a loss record
    storage.recordLoss({
      session_id: sessionId,
      sensor: 2,
      from_index: 4000,
      to_index: 4399,
      reason: 'buffer_overflow',
    });

    // Save window 0 result
    storage.saveWindowResult({
      session_id: sessionId,
      window: 0,
      missing_1: 0,
      missing_2: 0,
      complete: true,
      s1_ch1_mean: 720.0,
      s1_ch1_min: 720,
      s1_ch1_max: 720,
      s1_ch2_mean: 1200.0,
      s1_ch2_min: 1200,
      s1_ch2_max: 1200,
      s1_ch3_mean: 1560.0,
      s1_ch3_min: 1560,
      s1_ch3_max: 1560,
      s2_ch1_mean: 400000.0,
      s2_ch1_min: 400000,
      s2_ch1_max: 400000,
      s2_ch2_mean: 150000.0,
      s2_ch2_min: 150000,
      s2_ch2_max: 150000,
      magnitude: 427200.2,
      heart_rate: null,
      mode: 'offline',
    });
  });

  afterAll(() => {
    storage.close();
    try {
      if (fs.existsSync(testDbPath)) fs.unlinkSync(testDbPath);
      if (fs.existsSync(`${testDbPath}-wal`)) fs.unlinkSync(`${testDbPath}-wal`);
      if (fs.existsSync(`${testDbPath}-shm`)) fs.unlinkSync(`${testDbPath}-shm`);
    } catch {
      // ignore
    }
  });

  it('pipeline status prints exactly one JSON line matching contract (§4)', async () => {
    let captured = '';
    const originalWrite = process.stdout.write;
    process.stdout.write = (chunk: any) => {
      captured += chunk.toString();
      return true;
    };

    try {
      const status = await executeStatus({ dbPath: testDbPath, session: sessionId });
      expect(status.samples_saved).toBe(800);
      expect(status.backlog).toBe(800);
      expect(['online', 'offline', 'recovering']).toContain(status.mode);

      const parsed = JSON.parse(captured.trim());
      expect(parsed.samples_saved).toBe(800);
      expect(parsed.backlog).toBe(800);
      expect(parsed).toHaveProperty('mode');
      expect(parsed).toHaveProperty('samples_in_cloud');
    } finally {
      process.stdout.write = originalWrite;
    }
  });

  it('pipeline export exports JSON Lines: samples first, then losses (§4)', async () => {
    let captured = '';
    const originalWrite = process.stdout.write;
    process.stdout.write = (chunk: any) => {
      captured += chunk.toString();
      return true;
    };

    try {
      await executeExport({
        session: sessionId,
        from: 'device',
        dbPath: testDbPath,
      });

      const lines = captured.trim().split('\n');
      // 800 samples + 1 loss record = 801 lines
      expect(lines.length).toBe(801);

      // First line should be a sample
      const firstLine = JSON.parse(lines[0]!);
      expect(firstLine.sensor).toBe(1);
      expect(firstLine.index).toBe(0);
      expect(firstLine.values).toEqual([720, 1200, 1560]);

      // Last line should be a loss record
      const lastLine = JSON.parse(lines[lines.length - 1]!);
      expect(lastLine.sensor).toBe(2);
      expect(lastLine.from_index).toBe(4000);
      expect(lastLine.to_index).toBe(4399);
      expect(lastLine.reason).toBe('buffer_overflow');
    } finally {
      process.stdout.write = originalWrite;
    }
  });

  it('pipeline results prints JSON Lines matching section 3 fields (§4)', async () => {
    let captured = '';
    const originalWrite = process.stdout.write;
    process.stdout.write = (chunk: any) => {
      captured += chunk.toString();
      return true;
    };

    try {
      const results = await executeResults({
        session: sessionId,
        dbPath: testDbPath,
      });

      expect(results.length).toBe(1);
      const parsed = JSON.parse(captured.trim());
      expect(parsed.session_id).toBe(sessionId);
      expect(parsed.window).toBe(0);
      expect(parsed.complete).toBe(true);
      expect(parsed.missing_1).toBe(0);
      expect(parsed.missing_2).toBe(0);
      expect(parsed.mode).toBe('offline');
      expect(parsed.magnitude).toBe(427200.2);
    } finally {
      process.stdout.write = originalWrite;
    }
  });

  it('pipeline results computes completed windows on-demand if not pre-saved (RISK-03 regression)', async () => {
    const rawSession = 'cli_raw_session_ondemand';
    storage.ensureSession(rawSession);
    const s1 = Array.from({ length: 400 }, () => [100, 200, 300]);
    const s2 = Array.from({ length: 400 }, () => [300, 400]);
    storage.insertSamplesAtomic(rawSession, 1, 0, s1);
    storage.insertSamplesAtomic(rawSession, 2, 0, s2);

    // Note: NOT calling saveWindowResult - storage.getWindowResults will initially be empty
    const results = await executeResults({
      session: rawSession,
      dbPath: testDbPath,
    });

    expect(results.length).toBe(1);
    expect(results[0]!.window).toBe(0);
    expect(results[0]!.complete).toBe(true);
    expect(results[0]!.magnitude).toBe(500.0);
  });
});
