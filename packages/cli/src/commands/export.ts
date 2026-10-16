import { DeviceStorage } from '@mayacardio/device-storage';
import { CloudApiClient } from '@mayacardio/sync';

export interface ExportCommandOptions {
  session: string;
  from: 'device' | 'cloud';
  dbPath?: string;
  cloudUrl?: string;
  apiKey?: string;
}

export async function executeExport(options: ExportCommandOptions): Promise<void> {
  const sessionId = options.session;
  if (!sessionId) {
    console.error('Error: --session ID is required');
    process.exit(1);
  }

  const fromSource = options.from || 'device';

  if (fromSource === 'device') {
    const dbPath = options.dbPath ?? process.env.DEVICE_SQLITE_PATH ?? './data/maya_device.db';
    const storage = new DeviceStorage({ dbPath });

    const samples = storage.getAllSamples(sessionId);
    const losses = storage.getAllLosses(sessionId);

    // Stream samples first
    for (const s of samples) {
      process.stdout.write(
        JSON.stringify({
          sensor: s.sensor,
          index: s.index,
          values: s.values,
        }) + '\n'
      );
    }

    // Stream loss records next
    for (const l of losses) {
      process.stdout.write(
        JSON.stringify({
          sensor: l.sensor,
          from_index: l.from_index,
          to_index: l.to_index,
          reason: l.reason,
        }) + '\n'
      );
    }

    storage.close();
  } else if (fromSource === 'cloud') {
    const cloudUrl = options.cloudUrl ?? process.env.CLOUD_API_URL ?? 'http://127.0.0.1:8080';
    const apiKey = options.apiKey ?? process.env.CLOUD_API_KEY;
    const client = new CloudApiClient({ cloudUrl, apiKey });

    const rawExport = await client.exportLines(sessionId);
    process.stdout.write(rawExport);
  } else {
    console.error(`Error: Invalid --from option '${fromSource}'. Must be 'device' or 'cloud'.`);
    process.exit(1);
  }
}
