import net from 'node:net';
import crypto from 'node:crypto';
import {
  SAMPLE_RATE,
  calculateCrc32Hex,
  type SensorId,
  type MockReadReply,
  type MockLostRange,
} from '@mayacardio/shared';
import { BiosignalGenerator, type MockMode } from './generator.js';
import { SensorRingBuffer } from './ring-buffer.js';

export interface MockServerOptions {
  port?: number;
  mode?: MockMode;
  seed?: number;
  duration?: number; // duration in seconds
}

export interface FaultConfig {
  corruptNextCrc?: boolean;
  duplicateNextReply?: boolean;
  pauseMs?: number;
  suppressSensor?: SensorId | null;
}

export class BiosignalMockServer {
  private port: number;
  private mode: MockMode;
  private seed: number;
  private durationSeconds: number;
  private server: net.Server | null = null;
  private activeSocket: net.Socket | null = null;

  private sessionId: string;
  private startTime: number = 0;
  private generator: BiosignalGenerator;
  private buffer1: SensorRingBuffer;
  private buffer2: SensorRingBuffer;

  // Next unread index pointers
  private readPointer1 = 0;
  private readPointer2 = 0;
  private highestGeneratedIndex = -1;

  // Fault injection state
  public faults: FaultConfig = {};

  constructor(options?: MockServerOptions) {
    this.port = options?.port ?? 7100;
    this.mode = options?.mode ?? 'signal';
    this.seed = options?.seed ?? 7;
    this.durationSeconds = options?.duration ?? 3600;

    this.sessionId = crypto.randomBytes(4).toString('hex');
    this.generator = new BiosignalGenerator(this.mode, this.seed);
    this.buffer1 = new SensorRingBuffer();
    this.buffer2 = new SensorRingBuffer();
  }

  public getSessionId(): string {
    return this.sessionId;
  }

  public restartSession(): string {
    this.sessionId = crypto.randomBytes(4).toString('hex');
    this.readPointer1 = 0;
    this.readPointer2 = 0;
    this.highestGeneratedIndex = -1;
    this.buffer1.clear();
    this.buffer2.clear();
    this.startTime = Date.now();
    return this.sessionId;
  }

  public start(): Promise<void> {
    return new Promise((resolve, reject) => {
      this.startTime = Date.now();

      this.server = net.createServer((socket) => {
        // Enforce: one client at a time
        if (this.activeSocket && !this.activeSocket.destroyed) {
          socket.end(
            JSON.stringify({ error: 'Connection rejected: another client is active' }) + '\n'
          );
          return;
        }

        this.activeSocket = socket;
        let lineBuffer = '';

        const cleanup = () => {
          if (this.activeSocket === socket) {
            this.activeSocket = null;
          }
        };

        socket.on('close', cleanup);
        socket.on('end', cleanup);
        socket.on('error', cleanup);

        socket.on('data', (chunk) => {
          lineBuffer += chunk.toString('utf-8');
          let newlineIdx = lineBuffer.indexOf('\n');
          while (newlineIdx !== -1) {
            const line = lineBuffer.slice(0, newlineIdx).trim();
            lineBuffer = lineBuffer.slice(newlineIdx + 1);
            if (line.length > 0) {
              this.handleCommand(line, socket);
            }
            newlineIdx = lineBuffer.indexOf('\n');
          }
        });

        socket.on('close', () => {
          if (this.activeSocket === socket) {
            this.activeSocket = null;
          }
        });

        socket.on('error', () => {
          if (this.activeSocket === socket) {
            this.activeSocket = null;
          }
        });
      });

      this.server.listen(this.port, '127.0.0.1', () => {
        resolve();
      });

      this.server.on('error', (err) => {
        reject(err);
      });
    });
  }

  public stop(): Promise<void> {
    return new Promise((resolve) => {
      if (this.activeSocket) {
        this.activeSocket.destroy();
        this.activeSocket = null;
      }
      if (this.server) {
        this.server.close(() => resolve());
      } else {
        resolve();
      }
    });
  }

  private advanceGenerator(): void {
    const elapsedSeconds = (Date.now() - this.startTime) / 1000;
    const maxTargetIndex = Math.floor(elapsedSeconds * SAMPLE_RATE);
    const maxAllowedIndex = this.durationSeconds * SAMPLE_RATE - 1;
    const targetIndex = Math.min(maxTargetIndex, maxAllowedIndex);

    while (this.highestGeneratedIndex < targetIndex) {
      this.highestGeneratedIndex++;
      const idx = this.highestGeneratedIndex;
      const s1 = this.generator.generateSensor1(idx);
      const s2 = this.generator.generateSensor2(idx);
      this.buffer1.push(idx, s1);
      this.buffer2.push(idx, s2);
    }
  }

  private handleCommand(line: string, socket: net.Socket): void {
    let req: { cmd?: string; sensor?: number; from_index?: number };
    try {
      req = JSON.parse(line);
    } catch {
      socket.write(JSON.stringify({ error: 'malformed_json' }) + '\n');
      return;
    }

    if (req.cmd !== 'read' || (req.sensor !== 1 && req.sensor !== 2)) {
      socket.write(JSON.stringify({ error: 'invalid_command' }) + '\n');
      return;
    }

    const sensor = req.sensor as SensorId;

    // Check fault injection for pause
    const pause = this.faults.pauseMs ?? 0;
    if (pause > 0) {
      this.faults.pauseMs = 0;
      setTimeout(() => this.processRead(req, sensor, socket), pause);
      return;
    }

    this.processRead(req, sensor, socket);
  }

  private processRead(
    req: { from_index?: number },
    sensor: SensorId,
    socket: net.Socket
  ): void {
    this.advanceGenerator();

    const buffer = sensor === 1 ? this.buffer1 : this.buffer2;
    let readPointer = sensor === 1 ? this.readPointer1 : this.readPointer2;

    if (typeof req.from_index === 'number') {
      readPointer = req.from_index;
    }

    // Check fault injection: sensor suppression
    if (this.faults.suppressSensor === sensor) {
      const lostRange: MockLostRange = {
        from_index: readPointer,
        to_index: readPointer + 399,
        reason: 'sensor_outage_injected',
      };
      const reply: MockReadReply = {
        session_id: this.sessionId,
        sensor,
        first_index: readPointer,
        count: 0,
        lost: [lostRange],
        session_end: false,
        crc32: '00000000',
        data: [],
      };
      this.sendReply(reply, socket);
      return;
    }

    const readRes = buffer.readRange(readPointer, 400); // at most 1 second of data
    const isSessionEnd =
      this.highestGeneratedIndex >= this.durationSeconds * SAMPLE_RATE - 1 &&
      readRes.firstIndex + readRes.count >= this.durationSeconds * SAMPLE_RATE;

    const dataText = JSON.stringify(readRes.data);
    let crcHex = calculateCrc32Hex(dataText);

    // Fault injection: corrupt CRC
    if (this.faults.corruptNextCrc) {
      this.faults.corruptNextCrc = false;
      crcHex = 'deadbeef'; // intentionally wrong CRC
    }

    const reply: MockReadReply = {
      session_id: this.sessionId,
      sensor,
      first_index: readRes.firstIndex,
      count: readRes.count,
      lost: readRes.lost,
      session_end: isSessionEnd,
      crc32: crcHex,
      data: readRes.data,
    };

    // Update read pointer only for normal sequential reads
    if (typeof req.from_index !== 'number') {
      if (sensor === 1) {
        this.readPointer1 = readRes.firstIndex + readRes.count;
      } else {
        this.readPointer2 = readRes.firstIndex + readRes.count;
      }
    }

    this.sendReply(reply, socket);

    // Fault injection: duplicate reply
    if (this.faults.duplicateNextReply) {
      this.faults.duplicateNextReply = false;
      setTimeout(() => this.sendReply(reply, socket), 20);
    }
  }

  private sendReply(reply: MockReadReply, socket: net.Socket): void {
    if (socket.destroyed) return;
    const json = JSON.stringify(reply);
    socket.write(json + '\n');
  }
}
