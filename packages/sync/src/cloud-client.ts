import type {
  SensorId,
  SyncBatchRequest,
  SyncBatchResponse,
  WindowResult,
} from '@mayacardio/shared';

export interface CloudClientOptions {
  cloudUrl: string;
  apiKey?: string;
  timeoutMs?: number;
  maxRetries?: number;
}

export class CloudApiClient {
  private cloudUrl: string;
  private apiKey: string;
  private timeoutMs: number;
  private maxRetries: number;

  constructor(options: CloudClientOptions) {
    this.cloudUrl = options.cloudUrl.replace(/\/+$/, '');
    this.apiKey = options.apiKey ?? process.env.CLOUD_API_KEY ?? 'mayacardio-edge-secret-token-2026';
    this.timeoutMs = options.timeoutMs ?? 3000;
    this.maxRetries = options.maxRetries ?? 3;
  }

  private async request<T>(
    endpoint: string,
    options: RequestInit,
    retries = this.maxRetries
  ): Promise<T> {
    const url = `${this.cloudUrl}${endpoint}`;
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), this.timeoutMs);

    const headers: Record<string, string> = {
      'Content-Type': 'application/json',
      'x-api-key': this.apiKey,
      ...((options.headers as Record<string, string>) || {}),
    };

    try {
      const res = await fetch(url, {
        ...options,
        headers,
        signal: controller.signal,
      });

      if (!res.ok) {
        const errorText = await res.text().catch(() => '');
        throw new Error(`Cloud API error ${res.status}: ${errorText}`);
      }

      return (await res.json()) as T;
    } catch (err) {
      if (retries > 0) {
        // Exponential backoff with jitter
        const backoff = Math.floor(Math.random() * 200 + Math.pow(2, 4 - retries) * 100);
        await new Promise((r) => setTimeout(r, backoff));
        return this.request<T>(endpoint, options, retries - 1);
      }
      throw err;
    } finally {
      clearTimeout(timeout);
    }
  }

  public async registerSession(sessionId: string, deviceId: string): Promise<{ success: boolean }> {
    return this.request('/api/v1/sessions', {
      method: 'POST',
      body: JSON.stringify({ session_id: sessionId, device_id: deviceId }),
    });
  }

  public async postBatch(batch: SyncBatchRequest): Promise<SyncBatchResponse> {
    return this.request('/api/v1/sync/batch', {
      method: 'POST',
      body: JSON.stringify(batch),
    });
  }

  public async getCoverage(
    sessionId: string,
    sensor: SensorId
  ): Promise<{
    sessionId: string;
    sensor: SensorId;
    totalSamples: number;
    lastIndex: number;
    gaps: Array<{ from_index: number; to_index: number }>;
  }> {
    return this.request(`/api/v1/sync/coverage?session_id=${sessionId}&sensor=${sensor}`, {
      method: 'GET',
    });
  }

  public async postResults(results: WindowResult[]): Promise<{ success: boolean; count: number }> {
    return this.request('/api/v1/results', {
      method: 'POST',
      body: JSON.stringify({ results }),
    });
  }

  public async getResults(sessionId: string): Promise<WindowResult[]> {
    return this.request(`/api/v1/results?session_id=${sessionId}`, {
      method: 'GET',
    });
  }

  public async exportLines(sessionId: string): Promise<string> {
    const url = `${this.cloudUrl}/api/v1/export?session_id=${sessionId}`;
    const res = await fetch(url, {
      method: 'GET',
      headers: { 'x-api-key': this.apiKey },
    });
    if (!res.ok) {
      throw new Error(`Export failed with status ${res.status}`);
    }
    return res.text();
  }
}
