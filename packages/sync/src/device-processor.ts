import { DeviceStorage } from '@mayacardio/device-storage';
import { processWindow } from '@mayacardio/processing';

export interface DeviceProcessorOptions {
  storage: DeviceStorage;
  sessionId: string;
}

export class DeviceProcessor {
  private storage: DeviceStorage;
  private sessionId: string;

  constructor(options: DeviceProcessorOptions) {
    this.storage = options.storage;
    this.sessionId = options.sessionId;
  }

  public setSessionId(id: string): void {
    this.sessionId = id;
  }

  /**
   * Process all newly completed windows up to the minimum received checkpoint of both sensors
   */
  public processCompletedWindows(): number {
    const cp1 = this.storage.getCheckpoint(this.sessionId, 1);
    const cp2 = this.storage.getCheckpoint(this.sessionId, 2);

    if (!cp1 || !cp2) return 0;

    const minReceivedIdx = Math.min(cp1.last_received_index, cp2.last_received_index);
    if (minReceivedIdx < 399) {
      // Less than 1 full second collected
      return 0;
    }

    const maxCompletedWindow = Math.floor((minReceivedIdx + 1) / 400) - 1;
    const lastProcessed = Math.min(cp1.last_processed_window, cp2.last_processed_window);

    let processedCount = 0;

    for (let w = lastProcessed + 1; w <= maxCompletedWindow; w++) {
      const winStart = w * 400;
      const winEnd = winStart + 399;

      const s1Map = this.storage.getSamplesRange(this.sessionId, 1, winStart, winEnd);
      const s2Map = this.storage.getSamplesRange(this.sessionId, 2, winStart, winEnd);

      const hrStart = Math.max(0, 400 * (w - 4));
      const hrEnd = 400 * (w + 1);
      const s1Ch2Range = this.storage.getSamplesRange(this.sessionId, 1, hrStart, hrEnd);

      const result = processWindow({
        sessionId: this.sessionId,
        window: w,
        mode: 'offline',
        sensor1Samples: s1Map,
        sensor2Samples: s2Map,
        extendedS1Ch2Accessor: {
          has: (idx) => s1Ch2Range.has(idx),
          get: (idx) => s1Ch2Range.get(idx)?.[1],
        },
      });

      this.storage.saveWindowResult(result);
      this.storage.updateProcessedWindow(this.sessionId, 1, w);
      this.storage.updateProcessedWindow(this.sessionId, 2, w);
      processedCount++;
    }

    return processedCount;
  }
}
