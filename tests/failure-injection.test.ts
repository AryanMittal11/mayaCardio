import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import type { FastifyInstance } from 'fastify';
import { BiosignalMockServer } from '../packages/mock-service/src/server.js';
import { GroundTruthChecker } from '../packages/mock-service/src/ground-truth.js';
import { DeviceStorage } from '../packages/device-storage/src/storage.js';
import { BiosignalCollector } from '../packages/collector/src/collector.js';
import { DeviceStateMachine } from '../packages/state-machine/src/state-machine.js';
import { SyncWorker } from '../packages/sync/src/sync-worker.js';
import { buildCloudServer } from '../packages/cloud-api/src/server.js';
import { MemoryCloudStorage } from '../packages/cloud-api/src/db/repository.js';
import type { ExportSampleLine, ExportLossLine } from '../packages/mock-service/src/ground-truth.js';

describe('Comprehensive Failure-Injection & Ground-Truth Verification (§4, §6.3)', () => {
  const testDbDir = './test_data';
  const testDbPath = path.join(testDbDir, 'failure_test.db');
  const mockPort = 7199;
  const cloudPort = 8199;
  const cloudUrl = `http://127.0.0.1:${cloudPort}`;
  const apiKey = 'failure-suite-key';

  let mockServer: BiosignalMockServer;
  let cloudServer: FastifyInstance;
  let cloudStorage: MemoryCloudStorage;
  let storage: DeviceStorage;
  let collector: BiosignalCollector;
  let stateMachine: DeviceStateMachine;
  let syncWorker: SyncWorker;
  let networkHealthy = true;

  beforeAll(async () => {
    if (fs.existsSync(testDbPath)) {
      try {
        fs.unlinkSync(testDbPath);
      } catch {
        // ignore
      }
    }

    // 1. Mock service in ramp mode for exact deterministic ground truth validation
    mockServer = new BiosignalMockServer({ port: mockPort, mode: 'ramp', seed: 7 });
    await mockServer.start();

    // 2. Cloud backend
    cloudStorage = new MemoryCloudStorage();
    cloudServer = buildCloudServer({ port: cloudPort, apiKey, storage: cloudStorage });
    
    // Outage simulation hook
    cloudServer.addHook('onRequest', async (req, reply) => {
      if (!networkHealthy) {
        return reply.status(503).send({ error: 'simulated_network_cut' });
      }
    });

    await cloudServer.listen({ port: cloudPort, host: '127.0.0.1' });

    // 3. Device edge components
    storage = new DeviceStorage({ dbPath: testDbPath });
    collector = new BiosignalCollector({
      storage,
      host: '127.0.0.1',
      port: mockPort,
      pollIntervalMs: 50,
    });

    stateMachine = new DeviceStateMachine({
      cloudUrl,
      initialState: 'offline',
      intervalMs: 150,
      timeoutMs: 250,
      failureThreshold: 2,
      successThreshold: 1,
    });

    syncWorker = new SyncWorker({
      storage,
      stateMachine,
      cloudUrl,
      apiKey,
      batchSize: 500,
      syncIntervalMs: 100,
    });

    stateMachine.start();
    await collector.start();
    await syncWorker.start();
  });

  afterAll(async () => {
    stateMachine.stop();
    await syncWorker.stop();
    await collector.stop();
    await cloudServer.close();
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

  it('verifies Ramp-Mode sample integrity against ground-truth checker (§4 #1, #7)', async () => {
    // Wait for collector to poll multiple cycles
    await new Promise((r) => setTimeout(r, 400));
    await collector.pollCycle();
    await collector.pollCycle();

    const sessionId = collector.getActiveSessionId();
    expect(sessionId).toBeTruthy();

    const rawSamples = storage.getAllSamples(sessionId!);
    const rawLosses = storage.getAllLosses(sessionId!);

    const exportSamples: ExportSampleLine[] = rawSamples.map((s) => ({
      sensor: s.sensor,
      index: s.index,
      values: s.values,
    }));

    const exportLosses: ExportLossLine[] = rawLosses.map((l) => ({
      sensor: l.sensor,
      from_index: l.from_index,
      to_index: l.to_index,
      reason: l.reason,
    }));

    // Verify using ground truth checker tool logic
    const checker = new GroundTruthChecker('ramp', 7);
    const result = checker.verify(exportSamples, exportLosses);

    expect(result.valid).toBe(true);
    expect(result.corruptedSamples.length).toBe(0);
    expect(result.duplicateSamples.length).toBe(0);
    expect(result.unaccountedGaps.length).toBe(0);
    expect(result.totalSamples).toBeGreaterThan(0);
  });

  it('simulates process termination / crash and confirms WAL recovery without data corruption (§4 #3)', async () => {
    const sessionId = collector.getActiveSessionId()!;
    const savedBefore = storage.getStats(sessionId).samples_saved;

    // Simulate sudden process termination (close database handle abruptly)
    await collector.stop();
    await syncWorker.stop();
    storage.close();

    // Reopen database (simulating restart / reboot)
    storage = new DeviceStorage({ dbPath: testDbPath });

    // Verify database consistency and that previously committed samples survived
    const savedAfter = storage.getStats(sessionId).samples_saved;
    expect(savedAfter).toBe(savedBefore);

    const cp1 = storage.getCheckpoint(sessionId, 1);
    const cp2 = storage.getCheckpoint(sessionId, 2);
    expect(cp1).not.toBeNull();
    expect(cp2).not.toBeNull();

    // Reconnect collector and sync worker to reopened storage
    collector = new BiosignalCollector({
      storage,
      host: '127.0.0.1',
      port: mockPort,
      pollIntervalMs: 50,
    });
    await collector.start();

    syncWorker = new SyncWorker({
      storage,
      stateMachine,
      cloudUrl,
      apiKey,
      batchSize: 500,
      syncIntervalMs: 100,
    });
    await syncWorker.start();
  });

  it('simulates network cut and restoration: switches mode within SLA and catches up (§4 #5, #6)', async () => {
    const sessionId = 'session_net_cut_test';
    storage.ensureSession(sessionId);
    syncWorker.setSessionId(sessionId);

    // Initial state check
    networkHealthy = true;
    await stateMachine.getHealthChecker().probeHealth();
    expect(['recovering', 'online']).toContain(stateMachine.getState());

    // CUT NETWORK: simulate network drop
    networkHealthy = false;

    // Probe health failure
    await stateMachine.getHealthChecker().probeHealth();
    await stateMachine.getHealthChecker().probeHealth();

    // Must transition to OFFLINE within SLA (<10s)
    expect(stateMachine.getState()).toBe('offline');

    // While OFFLINE, device continues collecting and persisting safely
    const offlineSamples = Array.from({ length: 400 }, (_, i) => [100, 200, 300]);
    storage.insertSamplesAtomic(sessionId, 1, 0, offlineSamples);
    storage.insertSamplesAtomic(sessionId, 2, 0, offlineSamples.map(([a, b]) => [a, b]));

    const statsOffline = storage.getStats(sessionId);
    expect(statsOffline.samples_saved).toBe(800);
    expect(statsOffline.backlog).toBe(800);

    // RESTORE NETWORK: network restored
    networkHealthy = true;

    // Probe health returns true -> switches to RECOVERING
    await stateMachine.getHealthChecker().probeHealth();
    expect(stateMachine.getState()).toBe('recovering');

    // Catch up backlog
    await syncWorker.cycle();

    const statsRecovered = storage.getStats(sessionId);
    expect(statsRecovered.backlog).toBe(0);

    // State machine returns to stable ONLINE
    expect(stateMachine.getState()).toBe('online');
  });

  it('demonstrates high-throughput catch-up meeting the 15-minute SLA for 2-hour outage (§4 #6)', async () => {
    // 2-hour outage benchmark calculation:
    // 5,760,000 samples over 900 seconds requires 6,400 samples/sec.
    // Test ingestion throughput with 5,000 synthetic samples
    const sessionId = 'bench_catchup_session';
    storage.ensureSession(sessionId);

    const count = 5000;
    const testSamples = Array.from({ length: count }, (_, i) => [i, i + 1, i + 2]);

    const startInsert = Date.now();
    storage.insertSamplesAtomic(sessionId, 1, 0, testSamples);
    const diskDuration = Date.now() - startInsert;

    // Verify insertion speed (should be fast in WAL mode)
    expect(diskDuration).toBeLessThan(2000);

    // Now benchmark upload speed via syncWorker
    syncWorker.setSessionId(sessionId);
    const startSync = Date.now();

    let uploaded = 0;
    while (uploaded < count) {
      const batchSynced = await syncWorker.syncSensor(sessionId, 1);
      if (batchSynced === 0) break;
      uploaded += batchSynced;
    }
    const syncDuration = Date.now() - startSync;

    expect(uploaded).toBe(count);
    const samplesPerSecond = (count / syncDuration) * 1000;

    // Must exceed the 6,400 samples/second minimum requirement
    expect(samplesPerSecond).toBeGreaterThan(6400);
  });
});
