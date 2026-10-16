import { DeviceStorage } from '@mayacardio/device-storage';
import { CloudApiClient } from '@mayacardio/sync';
import type { DeviceState, PipelineStatus } from '@mayacardio/shared';

export interface StatusCommandOptions {
  dbPath?: string;
  cloudUrl?: string;
  apiKey?: string;
  session?: string;
}

export async function executeStatus(options: StatusCommandOptions): Promise<PipelineStatus> {
  const dbPath = options.dbPath ?? process.env.DEVICE_SQLITE_PATH ?? './data/maya_device.db';
  const cloudUrl = options.cloudUrl ?? process.env.CLOUD_API_URL ?? 'http://127.0.0.1:8080';
  const apiKey = options.apiKey ?? process.env.CLOUD_API_KEY;

  const storage = new DeviceStorage({ dbPath });
  const client = new CloudApiClient({ cloudUrl, apiKey, timeoutMs: 1500, maxRetries: 1 });

  let mode: DeviceState = 'offline';
  try {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 1200);
    const res = await fetch(`${cloudUrl}/health`, { signal: controller.signal });
    clearTimeout(timeout);
    if (res.ok) {
      mode = 'online';
    }
  } catch {
    mode = 'offline';
  }

  const localStats = storage.getStats(options.session);
  const samplesSaved = localStats.samples_saved;
  let samplesInCloud = localStats.samples_synced;

  // If online and session provided, query cloud for accurate count
  if (mode === 'online' && options.session) {
    try {
      const [cov1, cov2] = await Promise.all([
        client.getCoverage(options.session, 1),
        client.getCoverage(options.session, 2),
      ]);
      samplesInCloud = cov1.totalSamples + cov2.totalSamples;
    } catch {
      // fallback to local sync checkpoints
    }
  }

  const backlog = Math.max(0, samplesSaved - samplesInCloud);

  if (mode === 'online' && backlog > 0) {
    mode = 'recovering';
  }

  storage.close();

  const status: PipelineStatus = {
    mode,
    samples_saved: samplesSaved,
    samples_in_cloud: samplesInCloud,
    backlog,
  };

  process.stdout.write(JSON.stringify(status) + '\n');
  return status;
}
