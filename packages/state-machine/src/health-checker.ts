export interface HealthCheckOptions {
  cloudUrl: string;
  intervalMs?: number;
  timeoutMs?: number;
  failureThreshold?: number;
  successThreshold?: number;
}

export class CloudHealthChecker {
  private cloudUrl: string;
  private intervalMs: number;
  private timeoutMs: number;
  private failureThreshold: number;
  private successThreshold: number;

  private isChecking = false;
  private timer: NodeJS.Timeout | null = null;
  private consecutiveFailures = 0;
  private consecutiveSuccesses = 0;
  private isCurrentlyHealthy = false;

  private listeners: Array<(healthy: boolean) => void> = [];

  constructor(options: HealthCheckOptions) {
    this.cloudUrl = options.cloudUrl.replace(/\/+$/, '');
    this.intervalMs = options.intervalMs ?? 2000; // Check every 2s (well within 10s switch requirement)
    this.timeoutMs = options.timeoutMs ?? 1500;
    this.failureThreshold = options.failureThreshold ?? 2; // 2 failures * 2s = 4s <= 10s
    this.successThreshold = options.successThreshold ?? 1; // 1 success -> online immediately
  }

  public isHealthy(): boolean {
    return this.isCurrentlyHealthy;
  }

  public onStatusChange(listener: (healthy: boolean) => void): () => void {
    this.listeners.push(listener);
    return () => {
      this.listeners = this.listeners.filter((l) => l !== listener);
    };
  }

  public start(): void {
    if (this.isChecking) return;
    this.isChecking = true;
    this.scheduleCheck(0);
  }

  public stop(): void {
    this.isChecking = false;
    if (this.timer) {
      clearTimeout(this.timer);
      this.timer = null;
    }
  }

  private scheduleCheck(delayMs: number): void {
    if (!this.isChecking) return;
    this.timer = setTimeout(() => {
      this.probeHealth().finally(() => {
        this.scheduleCheck(this.intervalMs);
      });
    }, delayMs);
  }

  public async probeHealth(): Promise<boolean> {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), this.timeoutMs);

    let success = false;
    try {
      const res = await fetch(`${this.cloudUrl}/health`, {
        method: 'GET',
        signal: controller.signal,
      });
      success = res.ok;
    } catch {
      success = false;
    } finally {
      clearTimeout(timeout);
    }

    if (success) {
      this.consecutiveFailures = 0;
      this.consecutiveSuccesses++;
      if (!this.isCurrentlyHealthy && this.consecutiveSuccesses >= this.successThreshold) {
        this.isCurrentlyHealthy = true;
        this.notify(true);
      }
    } else {
      this.consecutiveSuccesses = 0;
      this.consecutiveFailures++;
      if (this.isCurrentlyHealthy && this.consecutiveFailures >= this.failureThreshold) {
        this.isCurrentlyHealthy = false;
        this.notify(false);
      }
    }

    return success;
  }

  private notify(healthy: boolean): void {
    for (const listener of this.listeners) {
      try {
        listener(healthy);
      } catch {
        // ignore listener errors
      }
    }
  }
}
