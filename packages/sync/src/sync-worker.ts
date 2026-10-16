import { pino } from 'pino';
import { DeviceStorage } from '@mayacardio/device-storage';
import { DeviceStateMachine } from '@mayacardio/state-machine';
import type { SensorId, SyncBatchRequest } from '@mayacardio/shared';
import { CloudApiClient, type CloudClientOptions } from './cloud-client.js';
import { DeviceProcessor } from './device-processor.js';

export interface SyncWorkerOptions extends CloudClientOptions {
  storage: DeviceStorage;
  stateMachine: DeviceStateMachine;
  deviceId?: string;
  batchSize?: number;
  syncIntervalMs?: number;
}

export class SyncWorker {
  private storage: DeviceStorage;
  private stateMachine: DeviceStateMachine;
  private cloudClient: CloudApiClient;
  private deviceId: string;
  private batchSize: number;
  private syncIntervalMs: number;

  private isRunning = false;
  private timer: NodeJS.Timeout | null = null;
  private activeSessionId: string | null = null;
  private deviceProcessor: DeviceProcessor | null = null;
  private logger = pino({ level: process.env.LOG_LEVEL || 'info' });

  constructor(options: SyncWorkerOptions) {
    this.storage = options.storage;
    this.stateMachine = options.stateMachine;
    this.cloudClient = new CloudApiClient(options);
    this.deviceId = options.deviceId ?? process.env.DEVICE_ID ?? 'bedside-device-01';
    this.batchSize = options.batchSize ?? 1000;
    this.syncIntervalMs = options.syncIntervalMs ?? 500;
  }

  public setSessionId(id: string): void {
    this.activeSessionId = id;
    if (!this.deviceProcessor) {
      this.deviceProcessor = new DeviceProcessor({ storage: this.storage, sessionId: id });
    } else {
      this.deviceProcessor.setSessionId(id);
    }
  }

  public async start(): Promise<void> {
    if (this.isRunning) return;
    this.isRunning = true;
    this.logger.info('SyncWorker started.');
    this.scheduleNext(0);
  }

  public async stop(): Promise<void> {
    this.isRunning = false;
    if (this.timer) {
      clearTimeout(this.timer);
      this.timer = null;
    }
    this.logger.info('SyncWorker stopped.');
  }

  private scheduleNext(delayMs: number): void {
    if (!this.isRunning) return;
    this.timer = setTimeout(() => {
      this.cycle().finally(() => {
        this.scheduleNext(this.syncIntervalMs);
      });
    }, delayMs);
  }

  public async cycle(): Promise<void> {
    if (!this.activeSessionId) return;

    const state = this.stateMachine.getState();

    if (state === 'offline') {
      // Offline mode: process windows locally on device (§2.3)
      if (this.deviceProcessor) {
        this.deviceProcessor.processCompletedWindows();
      }
      return;
    }

    // Online or Recovering: push data to cloud
    try {
      if (state === 'recovering') {
        // In recovering mode, burst sync batches until backlog is drained
        let syncedInBurst = 0;
        let lastSynced = 0;
        do {
          const s1Count = await this.syncSensor(this.activeSessionId, 1);
          const s2Count = await this.syncSensor(this.activeSessionId, 2);
          lastSynced = s1Count + s2Count;
          syncedInBurst += lastSynced;
        } while (lastSynced > 0 && syncedInBurst < 10000);

        await this.handleRecovery(this.activeSessionId);
      } else {
        await this.syncSession(this.activeSessionId);
      }
    } catch (err) {
      this.logger.warn({ err: (err as Error).message }, 'Sync cycle encountered network/API error');
    }
  }

  /**
   * Syncs pending samples and losses for a sensor to the cloud
   */
  public async syncSensor(sessionId: string, sensor: SensorId): Promise<number> {
    const unsynced = this.storage.getUnsyncedSamples(sessionId, sensor, this.batchSize);
    if (unsynced.length === 0) return 0;

    const losses = this.storage.getAllLosses(sessionId).filter((l) => l.sensor === sensor);

    const batch: SyncBatchRequest = {
      device_id: this.deviceId,
      session_id: sessionId,
      samples: unsynced.map((s) => ({
        sensor: s.sensor,
        index: s.index,
        values: s.values,
      })),
      losses: losses.map((l) => ({
        sensor: l.sensor,
        from_index: l.from_index,
        to_index: l.to_index,
        reason: l.reason,
      })),
      device_timestamp: new Date().toISOString(),
    };

    const res = await this.cloudClient.postBatch(batch);
    if (res.success) {
      const maxBatchIndex = unsynced[unsynced.length - 1]!.index;
      this.storage.updateSyncCheckpoint(sessionId, sensor, maxBatchIndex);
    }

    return unsynced.length;
  }

  public async syncSession(sessionId: string): Promise<void> {
    await this.syncSensor(sessionId, 1);
    await this.syncSensor(sessionId, 2);
  }

  private async handleRecovery(sessionId: string): Promise<void> {
    const stats = this.storage.getStats(sessionId);
    if (stats.backlog === 0) {
      // Upload any offline computed results
      const localResults = this.storage.getWindowResults(sessionId);
      const offlineResults = localResults.filter((r) => r.mode === 'offline');
      if (offlineResults.length > 0) {
        await this.cloudClient.postResults(offlineResults).catch(() => {});
      }

      // Reconcile coverage with cloud (§2.5)
      const [cov1, cov2] = await Promise.all([
        this.cloudClient.getCoverage(sessionId, 1),
        this.cloudClient.getCoverage(sessionId, 2),
      ]);

      const cp1 = this.storage.getCheckpoint(sessionId, 1);
      const cp2 = this.storage.getCheckpoint(sessionId, 2);

      const s1Complete = cov1.lastIndex >= (cp1?.last_received_index ?? -1);
      const s2Complete = cov2.lastIndex >= (cp2?.last_received_index ?? -1);

      if (s1Complete && s2Complete) {
        this.logger.info({ sessionId }, 'Catch-up complete! Cloud copy reconciled. Transitioning to ONLINE.');
        this.stateMachine.markCatchUpComplete();
      }
    }
  }
}
