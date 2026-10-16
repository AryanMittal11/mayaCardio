#!/usr/bin/env node
import { pino } from 'pino';
import { DeviceStorage } from '@mayacardio/device-storage';
import { BiosignalCollector } from '@mayacardio/collector';
import { DeviceStateMachine } from '@mayacardio/state-machine';
import { SyncWorker } from '@mayacardio/sync';

const logger = pino({ level: process.env.LOG_LEVEL || 'info' });

async function main() {
  const dbPath = process.env.DEVICE_SQLITE_PATH ?? './data/maya_device.db';
  const mockHost = process.env.MOCK_HOST ?? '127.0.0.1';
  const mockPort = parseInt(process.env.MOCK_PORT ?? '7100', 10);
  const cloudUrl = process.env.CLOUD_API_URL ?? 'http://127.0.0.1:8080';
  const apiKey = process.env.CLOUD_API_KEY ?? 'mayacardio-edge-secret-token-2026';
  const deviceId = process.env.DEVICE_ID ?? 'bedside-device-01';

  logger.info({ dbPath, mockHost, mockPort, cloudUrl }, 'Starting MayaCardio Device Daemon...');

  const storage = new DeviceStorage({ dbPath });

  const stateMachine = new DeviceStateMachine({
    cloudUrl,
    initialState: 'offline',
    intervalMs: 2000,
    timeoutMs: 1500,
    failureThreshold: 2,
    successThreshold: 1,
  });

  const collector = new BiosignalCollector({
    storage,
    host: mockHost,
    port: mockPort,
    pollIntervalMs: 100,
  });

  const syncWorker = new SyncWorker({
    storage,
    stateMachine,
    cloudUrl,
    apiKey,
    deviceId,
    batchSize: 1000,
    syncIntervalMs: 500,
  });

  // Start components
  stateMachine.start();
  await collector.start();
  await syncWorker.start();

  // Watch for active session change in collector to update syncWorker
  const sessionCheckInterval = setInterval(() => {
    const activeSession = collector.getActiveSessionId();
    if (activeSession) {
      syncWorker.setSessionId(activeSession);
    }
  }, 200);

  const shutdown = async (signal: string) => {
    logger.info({ signal }, 'Received shutdown signal. Stopping MayaCardio device daemon gracefully...');
    clearInterval(sessionCheckInterval);
    await collector.stop();
    await syncWorker.stop();
    stateMachine.stop();
    storage.close();
    logger.info('MayaCardio device daemon stopped.');
    process.exit(0);
  };

  process.on('SIGINT', () => shutdown('SIGINT'));
  process.on('SIGTERM', () => shutdown('SIGTERM'));
}

main().catch((err) => {
  logger.fatal({ err: (err as Error).message }, 'Device daemon fatal crash');
  process.exit(1);
});
