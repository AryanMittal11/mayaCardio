import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import net from 'node:net';
import { BiosignalGenerator } from '../packages/mock-service/src/generator.js';
import { SensorRingBuffer } from '../packages/mock-service/src/ring-buffer.js';
import { BiosignalMockServer } from '../packages/mock-service/src/server.js';
import { GroundTruthChecker } from '../packages/mock-service/src/ground-truth.js';
import { calculateCrc32Hex, type MockReadReply } from '@mayacardio/shared';

describe('Biosignal Mock Service (§6)', () => {
  describe('Deterministic Biosignal Generator (§6.1)', () => {
    it('produces exact ramp mode values for both sensors', () => {
      const gen = new BiosignalGenerator('ramp', 7);
      // Sensor 1 channel c at sample i = (3i + c) mod 8388608
      expect(gen.generateSensor1(0)).toEqual([1, 2, 3]);
      expect(gen.generateSensor1(10)).toEqual([31, 32, 33]);

      // Sensor 2 channel c at sample i = (2i + c) mod 8388608
      expect(gen.generateSensor2(0)).toEqual([1, 2]);
      expect(gen.generateSensor2(10)).toEqual([21, 22]);
    });

    it('generates consistent values for identical seeds', () => {
      const gen1 = new BiosignalGenerator('signal', 42);
      const gen2 = new BiosignalGenerator('signal', 42);

      for (let i = 0; i < 50; i++) {
        expect(gen1.generateSensor1(i)).toEqual(gen2.generateSensor1(i));
        expect(gen1.generateSensor2(i)).toEqual(gen2.generateSensor2(i));
      }
    });
  });

  describe('10-Second Ring Buffer (§6.2)', () => {
    it('evicts samples older than 4000 samples and returns buffer_overflow', () => {
      const buf = new SensorRingBuffer(4000);
      // Push 4500 samples
      for (let i = 0; i < 4500; i++) {
        buf.push(i, [i, i * 2]);
      }

      // Oldest should be 4500 - 4000 = 500
      expect(buf.getOldestIndex()).toBe(500);
      expect(buf.getNewestIndex()).toBe(4499);

      // Attempt to read from index 100
      const readRes = buf.readRange(100, 400);
      expect(readRes.lost.length).toBe(1);
      expect(readRes.lost[0]?.from_index).toBe(100);
      expect(readRes.lost[0]?.to_index).toBe(499);
      expect(readRes.lost[0]?.reason).toBe('buffer_overflow');
      expect(readRes.firstIndex).toBe(500);
      expect(readRes.count).toBe(400);
    });
  });

  describe('TCP NDJSON Protocol & CRC-32 Validation (§6.2)', () => {
    let mockServer: BiosignalMockServer;
    const testPort = 7123;

    beforeAll(async () => {
      mockServer = new BiosignalMockServer({ port: testPort, mode: 'ramp', seed: 7 });
      await mockServer.start();
    });

    afterAll(async () => {
      await mockServer.stop();
    });

    it('answers read command with valid NDJSON and exact matching CRC-32', async () => {
      const client = net.createConnection({ port: testPort, host: '127.0.0.1' });

      const replyPromise = new Promise<MockReadReply>((resolve) => {
        let buf = '';
        client.on('data', (chunk) => {
          buf += chunk.toString('utf-8');
          const nl = buf.indexOf('\n');
          if (nl !== -1) {
            const line = buf.slice(0, nl);
            resolve(JSON.parse(line));
            client.end();
          }
        });
      });

      await new Promise((r) => client.on('connect', r));
      client.write(JSON.stringify({ cmd: 'read', sensor: 1 }) + '\n');

      const reply = await replyPromise;
      await new Promise((r) => client.on('close', r));
      // Give server a few ms to reset activeSocket
      await new Promise((r) => setTimeout(r, 50));

      expect(reply.sensor).toBe(1);
      expect(reply.session_id).toBe(mockServer.getSessionId());
      expect(reply.session_end).toBe(false);

      // Verify CRC-32 against data string
      const dataText = JSON.stringify(reply.data);
      const computedCrc = calculateCrc32Hex(dataText);
      expect(reply.crc32).toBe(computedCrc);
    });

    it('enforces one client at a time rule by rejecting concurrent connection', async () => {
      const client1 = net.createConnection({ port: testPort, host: '127.0.0.1' });
      await new Promise((r) => client1.on('connect', r));

      const client2 = net.createConnection({ port: testPort, host: '127.0.0.1' });

      const rejectionPromise = new Promise<string>((resolve) => {
        let msg = '';
        client2.on('data', (d) => {
          msg += d.toString('utf-8');
        });
        client2.on('close', () => {
          resolve(msg);
        });
      });

      const rejectionMsg = await rejectionPromise;
      expect(rejectionMsg).toContain('Connection rejected: another client is active');

      client1.end();
      await new Promise((r) => client1.on('close', r));
    });
  });

  describe('Ground Truth Checker (§6.3)', () => {
    it('verifies valid export against ground truth', () => {
      const checker = new GroundTruthChecker('ramp', 7);
      const gen = new BiosignalGenerator('ramp', 7);

      const samples = [
        { sensor: 1 as const, index: 0, values: gen.generateSensor1(0) },
        { sensor: 1 as const, index: 1, values: gen.generateSensor1(1) },
        { sensor: 2 as const, index: 0, values: gen.generateSensor2(0) },
        { sensor: 2 as const, index: 1, values: gen.generateSensor2(1) },
      ];

      const res = checker.verify(samples, []);
      expect(res.valid).toBe(true);
      expect(res.unaccountedGaps.length).toBe(0);
      expect(res.corruptedSamples.length).toBe(0);
      expect(res.duplicateSamples.length).toBe(0);
    });

    it('flags unrecorded gaps as failure', () => {
      const checker = new GroundTruthChecker('ramp', 7);
      const gen = new BiosignalGenerator('ramp', 7);

      // Omit index 1 for Sensor 1
      const samples = [
        { sensor: 1 as const, index: 0, values: gen.generateSensor1(0) },
        { sensor: 1 as const, index: 2, values: gen.generateSensor1(2) },
      ];

      const res = checker.verify(samples, []);
      expect(res.valid).toBe(false);
      expect(res.unaccountedGaps).toEqual([{ sensor: 1, index: 1 }]);
    });
  });
});
