import { pino } from 'pino';
import type { SensorId, MockReadReply } from '@mayacardio/shared';
import { DeviceStorage } from '@mayacardio/device-storage';
import { MockTcpClient, type TcpClientOptions } from './tcp-client.js';
import { validateMessageCrc } from './crc-validator.js';

export interface CollectorOptions extends TcpClientOptions {
  storage: DeviceStorage;
  pollIntervalMs?: number;
  maxConsecutiveRereads?: number;
}

export class BiosignalCollector {
  private client: MockTcpClient;
  private storage: DeviceStorage;
  private pollIntervalMs: number;
  private maxConsecutiveRereads: number;

  private isRunning = false;
  private pollTimer: NodeJS.Timeout | null = null;
  private activeSessionId: string | null = null;
  private consecutiveCorruptCount: Record<SensorId, number> = { 1: 0, 2: 0 };
  private logger = pino({ level: process.env.LOG_LEVEL || 'info' });

  constructor(options: CollectorOptions) {
    this.storage = options.storage;
    this.client = new MockTcpClient(options);
    this.pollIntervalMs = options.pollIntervalMs ?? 100;
    this.maxConsecutiveRereads = options.maxConsecutiveRereads ?? 3;
  }

  public getActiveSessionId(): string | null {
    return this.activeSessionId;
  }

  public async start(): Promise<void> {
    if (this.isRunning) return;
    this.isRunning = true;
    this.logger.info('BiosignalCollector starting continuous acquisition loop...');
    this.scheduleNextPoll(0);
  }

  public async stop(): Promise<void> {
    this.isRunning = false;
    if (this.pollTimer) {
      clearTimeout(this.pollTimer);
      this.pollTimer = null;
    }
    this.client.disconnect();
    this.logger.info('BiosignalCollector stopped.');
  }

  private scheduleNextPoll(delayMs: number): void {
    if (!this.isRunning) return;
    this.pollTimer = setTimeout(() => {
      this.pollCycle().catch((err) => {
        this.logger.warn({ err: err.message }, 'Collector poll cycle encountered error; backing off');
        this.scheduleNextPoll(Math.min(1000, this.pollIntervalMs * 2));
      });
    }, delayMs);
  }

  /**
   * Executes one full poll cycle: Sensor 1 followed sequentially by Sensor 2
   */
  public async pollCycle(): Promise<void> {
    if (!this.isRunning) return;

    try {
      await this.pollSensor(1);
    } catch (err) {
      this.logger.debug({ err: (err as Error).message }, 'Error polling sensor 1');
    }

    if (!this.isRunning) return;

    try {
      await this.pollSensor(2);
    } catch (err) {
      this.logger.debug({ err: (err as Error).message }, 'Error polling sensor 2');
    }

    this.scheduleNextPoll(this.pollIntervalMs);
  }

  /**
   * Polls a specific sensor, handles CRC check, rereads, session transitions, and atomic persistence.
   */
  public async pollSensor(sensor: SensorId): Promise<boolean> {
    // Determine expected next index from storage checkpoint if session is known
    let expectedNextIndex: number | undefined;
    if (this.activeSessionId) {
      const cp = this.storage.getCheckpoint(this.activeSessionId, sensor);
      if (cp && cp.last_received_index >= 0) {
        expectedNextIndex = cp.last_received_index + 1;
      }
    }

    let response: { reply: MockReadReply; rawLine: string };
    try {
      response = await this.client.sendRead(sensor);
    } catch (err) {
      this.logger.debug({ sensor, err: (err as Error).message }, 'Failed to read from mock service');
      return false;
    }

    const { reply, rawLine } = response;

    // 1. Strict CRC-32 Validation
    const crcResult = validateMessageCrc(rawLine, reply.crc32);
    if (!crcResult.valid) {
      this.consecutiveCorruptCount[sensor]++;
      this.logger.warn(
        {
          sensor,
          expectedCrc: reply.crc32,
          computedCrc: crcResult.computedCrc,
          consecutive: this.consecutiveCorruptCount[sensor],
        },
        'CRC mismatch detected! Discarding corrupt reply'
      );

      // Attempt immediate reread if within threshold
      if (this.consecutiveCorruptCount[sensor] <= this.maxConsecutiveRereads && expectedNextIndex !== undefined) {
        try {
          const reread = await this.client.sendRead(sensor, expectedNextIndex);
          const rereadCrc = validateMessageCrc(reread.rawLine, reread.reply.crc32);
          if (rereadCrc.valid) {
            this.consecutiveCorruptCount[sensor] = 0;
            return this.handleValidReply(reread.reply, sensor);
          }
        } catch (rereadErr) {
          this.logger.warn({ sensor, err: (rereadErr as Error).message }, 'Reread after corrupt CRC failed');
        }
      }

      return false;
    }

    // CRC valid, reset consecutive corrupt counter
    this.consecutiveCorruptCount[sensor] = 0;
    return this.handleValidReply(reply, sensor);
  }

  private handleValidReply(reply: MockReadReply, sensor: SensorId): boolean {
    const sessionId = reply.session_id;

    // 2. Session transition detection (§6.3)
    if (this.activeSessionId !== null && this.activeSessionId !== sessionId) {
      this.logger.info(
        { oldSession: this.activeSessionId, newSession: sessionId },
        'Mock restarted! Recording open loss for old session'
      );

      // The old session restarted without clean termination
      // Record loss with to_index: null for both sensors as required by §6.3
      const cp1 = this.storage.getCheckpoint(this.activeSessionId, 1);
      const cp2 = this.storage.getCheckpoint(this.activeSessionId, 2);

      this.storage.recordLoss({
        session_id: this.activeSessionId,
        sensor: 1,
        from_index: (cp1?.last_received_index ?? -1) + 1,
        to_index: null,
        reason: 'mock_restart',
      });

      this.storage.recordLoss({
        session_id: this.activeSessionId,
        sensor: 2,
        from_index: (cp2?.last_received_index ?? -1) + 1,
        to_index: null,
        reason: 'mock_restart',
      });

      this.storage.markSessionEnded(this.activeSessionId);
    }

    this.activeSessionId = sessionId;
    this.storage.ensureSession(sessionId);

    // 3. Process reported loss ranges (§6.2, §6.3)
    if (reply.lost && reply.lost.length > 0) {
      for (const loss of reply.lost) {
        this.storage.recordLoss({
          session_id: sessionId,
          sensor,
          from_index: loss.from_index,
          to_index: loss.to_index,
          reason: loss.reason,
        });
      }
    }

    // 4. Check for sequence gap not reported in lost array
    const cp = this.storage.getCheckpoint(sessionId, sensor);
    const lastExpected = (cp?.last_received_index ?? -1) + 1;
    if (reply.count > 0 && reply.first_index > lastExpected) {
      const alreadyReported = reply.lost?.some(
        (l) => l.from_index <= lastExpected && (l.to_index === null || l.to_index >= reply.first_index - 1)
      );
      if (!alreadyReported) {
        this.storage.recordLoss({
          session_id: sessionId,
          sensor,
          from_index: lastExpected,
          to_index: reply.first_index - 1,
          reason: 'unreported_sequence_gap',
        });
      }
    }

    // 5. Atomic persistence of valid samples
    if (reply.count > 0 && reply.data.length > 0) {
      this.storage.insertSamplesAtomic(sessionId, sensor, reply.first_index, reply.data);
    }

    // 6. Check if session ended
    if (reply.session_end) {
      this.storage.markSessionEnded(sessionId);
    }

    return true;
  }
}
