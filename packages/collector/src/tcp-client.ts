import net from 'node:net';
import type { SensorId, MockReadReply } from '@mayacardio/shared';

export interface TcpClientOptions {
  host?: string;
  port?: number;
  timeoutMs?: number;
}

export class MockTcpClient {
  private host: string;
  private port: number;
  private timeoutMs: number;
  private socket: net.Socket | null = null;
  private incomingBuffer = '';
  private pendingRequest: {
    resolve: (val: { reply: MockReadReply; rawLine: string }) => void;
    reject: (err: Error) => void;
    timer: NodeJS.Timeout;
  } | null = null;

  constructor(options?: TcpClientOptions) {
    this.host = options?.host ?? '127.0.0.1';
    this.port = options?.port ?? 7100;
    this.timeoutMs = options?.timeoutMs ?? 3000;
  }

  public isConnected(): boolean {
    return this.socket !== null && !this.socket.destroyed && this.socket.writable;
  }

  public connect(): Promise<void> {
    if (this.isConnected()) {
      return Promise.resolve();
    }

    return new Promise((resolve, reject) => {
      const socket = net.createConnection({ host: this.host, port: this.port });
      this.socket = socket;
      this.incomingBuffer = '';

      let connected = false;

      const connectTimer = setTimeout(() => {
        if (!connected) {
          socket.destroy();
          reject(new Error(`Connection timeout to mock at ${this.host}:${this.port}`));
        }
      }, this.timeoutMs);

      socket.on('connect', () => {
        connected = true;
        clearTimeout(connectTimer);
        resolve();
      });

      socket.on('data', (chunk) => {
        this.incomingBuffer += chunk.toString('utf-8');
        this.processIncoming();
      });

      socket.on('error', (err) => {
        if (!connected) {
          clearTimeout(connectTimer);
          reject(err);
        }
        this.handleDisconnect(err);
      });

      socket.on('close', () => {
        this.handleDisconnect(new Error('Socket closed by remote'));
      });
    });
  }

  public disconnect(): void {
    if (this.pendingRequest) {
      clearTimeout(this.pendingRequest.timer);
      this.pendingRequest.reject(new Error('Client disconnecting'));
      this.pendingRequest = null;
    }
    if (this.socket) {
      this.socket.destroy();
      this.socket = null;
    }
  }

  private handleDisconnect(err: Error): void {
    if (this.socket) {
      this.socket = null;
    }
    if (this.pendingRequest) {
      clearTimeout(this.pendingRequest.timer);
      this.pendingRequest.reject(new Error(`Connection lost during request: ${err.message}`));
      this.pendingRequest = null;
    }
  }

  private processIncoming(): void {
    let newlineIdx = this.incomingBuffer.indexOf('\n');
    while (newlineIdx !== -1) {
      const line = this.incomingBuffer.slice(0, newlineIdx).trim();
      this.incomingBuffer = this.incomingBuffer.slice(newlineIdx + 1);

      if (line.length > 0 && this.pendingRequest) {
        const req = this.pendingRequest;
        this.pendingRequest = null;
        clearTimeout(req.timer);

        try {
          const parsed = JSON.parse(line);
          if (parsed.error) {
            req.reject(new Error(`Mock returned error: ${parsed.error}`));
          } else {
            req.resolve({ reply: parsed as MockReadReply, rawLine: line });
          }
        } catch (parseErr) {
          req.reject(new Error(`Failed to parse NDJSON reply: ${(parseErr as Error).message}`));
        }
      }

      newlineIdx = this.incomingBuffer.indexOf('\n');
    }
  }

  /**
   * Send a read command to the mock and wait for the response.
   * If not connected, connects automatically.
   */
  public async sendRead(
    sensor: SensorId,
    fromIndex?: number,
    timeoutMs?: number
  ): Promise<{ reply: MockReadReply; rawLine: string }> {
    if (!this.isConnected()) {
      await this.connect();
    }

    if (this.pendingRequest) {
      throw new Error('Concurrent request attempted on single TCP connection');
    }

    const effectiveTimeout = timeoutMs ?? this.timeoutMs;
    const cmdObj: { cmd: string; sensor: number; from_index?: number } = {
      cmd: 'read',
      sensor,
    };
    if (typeof fromIndex === 'number') {
      cmdObj.from_index = fromIndex;
    }

    const payload = JSON.stringify(cmdObj) + '\n';

    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        if (this.pendingRequest) {
          this.pendingRequest = null;
          reject(new Error(`Mock read request timed out after ${effectiveTimeout}ms`));
          this.disconnect();
        }
      }, effectiveTimeout);

      this.pendingRequest = { resolve, reject, timer };
      this.socket!.write(payload, 'utf-8', (err) => {
        if (err) {
          clearTimeout(timer);
          this.pendingRequest = null;
          reject(err);
        }
      });
    });
  }
}
