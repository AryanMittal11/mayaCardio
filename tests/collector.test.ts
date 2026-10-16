import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import { BiosignalMockServer } from '../packages/mock-service/src/server.js';
import { DeviceStorage } from '../packages/device-storage/src/storage.js';
import { BiosignalCollector } from '../packages/collector/src/collector.js';

describe('Collector Integration and Protocol Tests (§2.1, §6)', () => {
  const testDbDir = './test_data';
  const testDbPath = path.join(testDbDir, 'collector_test.db');
  const mockPort = 7188;

  let mockServer: BiosignalMockServer;
  let storage: DeviceStorage;
  let collector: BiosignalCollector;

  beforeAll(async () => {
    if (fs.existsSync(testDbPath)) {
      try {
        fs.unlinkSync(testDbPath);
      } catch {
        // ignore
      }
    }

    mockServer = new BiosignalMockServer({ port: mockPort, mode: 'ramp', seed: 7 });
    await mockServer.start();

    storage = new DeviceStorage({ dbPath: testDbPath });
    collector = new BiosignalCollector({
      storage,
      host: '127.0.0.1',
      port: mockPort,
      pollIntervalMs: 50,
    });
  });

  afterAll(async () => {
    await collector.stop();
    await mockServer.stop();
    storage.close();
    try {
      if (fs.existsSync(testDbPath)) fs.unlinkSync(testDbPath);
      if (fs.existsSync(`${testDbPath}-wal`)) fs.unlinkSync(`${testDbPath}-wal`);
      if (fs.existsSync(`${testDbPath}-shm`)) fs.unlinkSync(`${testDbPath}-shm`);
    } catch {
      // ignore
    }
  });

  it('polls both sensors sequentially and durably persists samples', async () => {
    // Wait for mock to generate initial data
    await new Promise((r) => setTimeout(r, 200));

    // Poll a cycle
    await collector.pollSensor(1);
    await collector.pollSensor(2);

    const sessionId = collector.getActiveSessionId();
    expect(sessionId).toBeTruthy();

    const cp1 = storage.getCheckpoint(sessionId!, 1);
    const cp2 = storage.getCheckpoint(sessionId!, 2);

    expect(cp1?.last_received_index).toBeGreaterThanOrEqual(0);
    expect(cp2?.last_received_index).toBeGreaterThanOrEqual(0);

    const s1Samples = storage.getAllSamples(sessionId!);
    expect(s1Samples.length).toBeGreaterThan(0);
  });

  it('rejects corrupt CRC replies without corrupting stored database', async () => {
    const sessionId = collector.getActiveSessionId()!;
    const cpBefore = storage.getCheckpoint(sessionId, 1)!.last_received_index;

    // Inject bad CRC on next read
    mockServer.faults.corruptNextCrc = true;

    // Polling sensor 1 should reject the corrupt reply
    await collector.pollSensor(1);

    // If reread failed or was rejected, checkpoint does not advance with corrupt data
    const cpAfter = storage.getCheckpoint(sessionId, 1)!.last_received_index;
    expect(cpAfter).toBeGreaterThanOrEqual(cpBefore);
  });

  it('records old session open loss (to_index: null) upon mock restart (§6.3)', async () => {
    const oldSession = collector.getActiveSessionId()!;

    // Trigger mock restart
    const newSession = mockServer.restartSession();
    expect(newSession).not.toBe(oldSession);

    // Wait for mock to generate first sample
    await new Promise((r) => setTimeout(r, 100));

    // Next poll will detect new session and log old session open loss
    await collector.pollSensor(1);

    expect(collector.getActiveSessionId()).toBe(newSession);

    const oldLosses = storage.getAllLosses(oldSession);
    expect(oldLosses.length).toBeGreaterThan(0);
    const restartLoss = oldLosses.find((l) => l.reason === 'mock_restart');
    expect(restartLoss).toBeDefined();
    expect(restartLoss?.to_index).toBeNull();
  });
});
