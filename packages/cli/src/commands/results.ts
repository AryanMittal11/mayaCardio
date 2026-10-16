import { DeviceStorage } from '@mayacardio/device-storage';
import { CloudApiClient, DeviceProcessor } from '@mayacardio/sync';
import type { WindowResult } from '@mayacardio/shared';

export interface ResultsCommandOptions {
  session: string;
  dbPath?: string;
  cloudUrl?: string;
  apiKey?: string;
}

export async function executeResults(options: ResultsCommandOptions): Promise<WindowResult[]> {
  const sessionId = options.session;
  if (!sessionId) {
    console.error('Error: --session ID is required');
    process.exit(1);
  }

  const dbPath = options.dbPath ?? process.env.DEVICE_SQLITE_PATH ?? './data/maya_device.db';
  const storage = new DeviceStorage({ dbPath });

  let results = storage.getWindowResults(sessionId);

  // If local results are empty, compute from local samples if available
  if (results.length === 0) {
    try {
      const processor = new DeviceProcessor({ storage, sessionId });
      processor.processCompletedWindows();
      results = storage.getWindowResults(sessionId);
    } catch {
      // ignore
    }
  }

  // If still empty, try cloud API if available
  if (results.length === 0) {
    const cloudUrl = options.cloudUrl ?? process.env.CLOUD_API_URL ?? 'http://127.0.0.1:8080';
    const apiKey = options.apiKey ?? process.env.CLOUD_API_KEY;
    try {
      const client = new CloudApiClient({ cloudUrl, apiKey, timeoutMs: 2000, maxRetries: 1 });
      results = await client.getResults(sessionId);
    } catch {
      // ignore
    }
  }

  storage.close();

  for (const r of results) {
    process.stdout.write(JSON.stringify(r) + '\n');
  }

  return results;
}
