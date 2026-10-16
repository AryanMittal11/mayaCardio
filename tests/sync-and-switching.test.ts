import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import type { FastifyInstance } from 'fastify';
import { DeviceStorage } from '../packages/device-storage/src/storage.js';
import { DeviceStateMachine } from '../packages/state-machine/src/state-machine.js';
import { SyncWorker } from '../packages/sync/src/sync-worker.js';
import { DeviceProcessor } from '../packages/sync/src/device-processor.js';
import { buildCloudServer } from '../packages/cloud-api/src/server.js';
import { MemoryCloudStorage } from '../packages/cloud-api/src/db/repository.js';

describe('Automatic Mode Switching, Offline Processing, and Catch-Up (§2.3, §2.4, §2.5, §4 #5, #6)', () => {
  const testDbDir = './test_data';
  const testDbPath = path.join(testDbDir, 'sync_switch_test.db');
  const cloudPort = 8124;
  const cloudUrl = `http://127.0.0.1:${cloudPort}`;
  const apiKey = 'sync-test-api-key';

  let cloudServer: FastifyInstance;
  let cloudStorage: MemoryCloudStorage;
  let deviceStorage: DeviceStorage;
  let stateMachine: DeviceStateMachine;
  let syncWorker: SyncWorker;

  beforeAll(async () => {
    if (fs.existsSync(testDbPath)) {
      try {
        fs.unlinkSync(testDbPath);
      } catch {
        // ignore
      }
    }

    cloudStorage = new MemoryCloudStorage();
    cloudServer = buildCloudServer({ port: cloudPort, apiKey, storage: cloudStorage });
    await cloudServer.listen({ port: cloudPort, host: '127.0.0.1' });

    deviceStorage = new DeviceStorage({ dbPath: testDbPath });
    stateMachine = new DeviceStateMachine({
      cloudUrl,
      initialState: 'offline',
      intervalMs: 200,
      timeoutMs: 300,
      failureThreshold: 2,
      successThreshold: 1,
    });

    syncWorker = new SyncWorker({
      cloudUrl,
      apiKey,
      storage: deviceStorage,
      stateMachine,
      batchSize: 500,
      syncIntervalMs: 100,
    });
  });

  afterAll(async () => {
    stateMachine.stop();
    await syncWorker.stop();
    await cloudServer.close();
    deviceStorage.close();
    try {
      if (fs.existsSync(testDbPath)) fs.unlinkSync(testDbPath);
      if (fs.existsSync(`${testDbPath}-wal`)) fs.unlinkSync(`${testDbPath}-wal`);
      if (fs.existsSync(`${testDbPath}-shm`)) fs.unlinkSync(`${testDbPath}-shm`);
    } catch {
      // ignore
    }
  });

  it('performs local offline processing while offline (§2.3)', () => {
    const sessionId = 'session_offline_proc';
    deviceStorage.ensureSession(sessionId);

    // Insert 800 samples for both sensors (2 complete windows: 0 and 1)
    const s1Samples = Array.from({ length: 800 }, () => [100, 200, 300]);
    const s2Samples = Array.from({ length: 800 }, () => [400, 500]);

    deviceStorage.insertSamplesAtomic(sessionId, 1, 0, s1Samples);
    deviceStorage.insertSamplesAtomic(sessionId, 2, 0, s2Samples);

    const processor = new DeviceProcessor({ storage: deviceStorage, sessionId });
    const processedCount = processor.processCompletedWindows();

    expect(processedCount).toBe(2);

    const results = deviceStorage.getWindowResults(sessionId);
    expect(results.length).toBe(2);
    expect(results[0]?.window).toBe(0);
    expect(results[0]?.mode).toBe('offline');
    expect(results[0]?.complete).toBe(true);
    expect(results[1]?.window).toBe(1);
    expect(results[1]?.mode).toBe('offline');
  });

  it('detects healthy cloud, transitions to recovering, and catches up backlog (§2.5)', async () => {
    const sessionId = 'session_catchup_01';
    deviceStorage.ensureSession(sessionId);
    syncWorker.setSessionId(sessionId);

    // Save 1200 samples locally on device while offline
    const s1 = Array.from({ length: 1200 }, (_, i) => [i, i * 2, i * 3]);
    const s2 = Array.from({ length: 1200 }, (_, i) => [i * 2, i * 3]);
    deviceStorage.insertSamplesAtomic(sessionId, 1, 0, s1);
    deviceStorage.insertSamplesAtomic(sessionId, 2, 0, s2);

    const statsBefore = deviceStorage.getStats(sessionId);
    expect(statsBefore.samples_saved).toBe(2400);
    expect(statsBefore.backlog).toBe(2400);

    // Start health check and sync loop
    stateMachine.start();
    // Wait for health checker to probe and trigger recovering
    await new Promise((r) => setTimeout(r, 400));
    expect(['recovering', 'online']).toContain(stateMachine.getState());

    // Run sync cycle to upload backlog and recover
    await syncWorker.cycle();

    const statsAfter = deviceStorage.getStats(sessionId);
    expect(statsAfter.backlog).toBe(0);

    // Cloud must have complete copy with every sample exactly once
    const cloudS1 = await cloudStorage.getCoverage(sessionId, 1);
    const cloudS2 = await cloudStorage.getCoverage(sessionId, 2);

    expect(cloudS1.totalSamples).toBe(1200);
    expect(cloudS2.totalSamples).toBe(1200);
    expect(cloudS1.gaps.length).toBe(0);
    expect(cloudS2.gaps.length).toBe(0);

    // Should return to stable ONLINE mode
    await syncWorker.cycle();
    expect(stateMachine.getState()).toBe('online');
  });
});
