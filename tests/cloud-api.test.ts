import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { buildCloudServer } from '../packages/cloud-api/src/server.js';
import { MemoryCloudStorage } from '../packages/cloud-api/src/db/repository.js';

describe('Cloud API Service (§2.2, §4 #4, §4 #6, §5)', () => {
  let server: FastifyInstance;
  let storage: MemoryCloudStorage;
  const apiKey = 'test-secret-key-123';

  beforeAll(async () => {
    storage = new MemoryCloudStorage();
    server = buildCloudServer({ apiKey, storage });
    await server.ready();
  });

  afterAll(async () => {
    await server.close();
  });

  it('responds 200 OK on /health without requiring authentication', async () => {
    const res = await server.inject({
      method: 'GET',
      url: '/health',
    });
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.status).toBe('ok');
    expect(typeof body.uptime).toBe('number');
  });

  it('rejects unauthenticated requests to /api/ routes with 401', async () => {
    const res = await server.inject({
      method: 'POST',
      url: '/api/v1/sessions',
      payload: { session_id: 's1', device_id: 'd1' },
    });
    expect(res.statusCode).toBe(401);
  });

  it('allows authenticated session registration with correct API key', async () => {
    const res = await server.inject({
      method: 'POST',
      url: '/api/v1/sessions',
      headers: { 'x-api-key': apiKey },
      payload: { session_id: 'session_cloud_01', device_id: 'bedside-01' },
    });
    expect(res.statusCode).toBe(200);
    expect(res.json().success).toBe(true);
  });

  it('ingests batch of samples and losses, computing online window results', async () => {
    const sessionId = 'session_cloud_batch_01';

    // Create 400 samples for window 0
    const s1Samples = Array.from({ length: 400 }, (_, i) => ({
      sensor: 1 as const,
      index: i,
      values: [100, 200, 300],
    }));
    const s2Samples = Array.from({ length: 400 }, (_, i) => ({
      sensor: 2 as const,
      index: i,
      values: [300, 400],
    }));

    const res = await server.inject({
      method: 'POST',
      url: '/api/v1/sync/batch',
      headers: { 'x-api-key': apiKey },
      payload: {
        device_id: 'bedside-01',
        session_id: sessionId,
        samples: [...s1Samples, ...s2Samples],
        losses: [
          {
            sensor: 1,
            from_index: 4000,
            to_index: 4399,
            reason: 'buffer_overflow',
          },
        ],
      },
    });

    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.success).toBe(true);
    expect(body.inserted_samples).toBe(800);
    expect(body.duplicate_samples).toBe(0);
    expect(body.inserted_losses).toBe(1);

    // Verify online window result was produced
    const resultsRes = await server.inject({
      method: 'GET',
      url: `/api/v1/results?session_id=${sessionId}`,
      headers: { 'x-api-key': apiKey },
    });
    expect(resultsRes.statusCode).toBe(200);
    const results = resultsRes.json();
    expect(results.length).toBeGreaterThan(0);
    expect(results[0].window).toBe(0);
    expect(results[0].mode).toBe('online');
    expect(results[0].complete).toBe(true);
    expect(results[0].magnitude).toBe(500.0);
  });

  it('handles duplicate batch submissions idempotently without creating duplicate rows', async () => {
    const sessionId = 'session_dup_test';
    const batch = {
      device_id: 'bedside-01',
      session_id: sessionId,
      samples: [
        { sensor: 1 as const, index: 0, values: [10, 20, 30] },
        { sensor: 1 as const, index: 1, values: [11, 21, 31] },
      ],
      losses: [],
    };

    const firstRes = await server.inject({
      method: 'POST',
      url: '/api/v1/sync/batch',
      headers: { 'x-api-key': apiKey },
      payload: batch,
    });
    expect(firstRes.json().inserted_samples).toBe(2);

    // Resend exact batch
    const secondRes = await server.inject({
      method: 'POST',
      url: '/api/v1/sync/batch',
      headers: { 'x-api-key': apiKey },
      payload: batch,
    });
    expect(secondRes.json().inserted_samples).toBe(0);
    expect(secondRes.json().duplicate_samples).toBe(2);

    const all = await storage.getAllSamples(sessionId);
    expect(all.length).toBe(2);
  });

  it('streams JSON lines in exact required order (samples then losses) on /export', async () => {
    const sessionId = 'session_export_test';
    await server.inject({
      method: 'POST',
      url: '/api/v1/sync/batch',
      headers: { 'x-api-key': apiKey },
      payload: {
        device_id: 'bedside-01',
        session_id: sessionId,
        samples: [{ sensor: 1, index: 0, values: [1, 2, 3] }],
        losses: [{ sensor: 2, from_index: 10, to_index: 20, reason: 'test_loss' }],
      },
    });

    const exportRes = await server.inject({
      method: 'GET',
      url: `/api/v1/export?session_id=${sessionId}`,
      headers: { 'x-api-key': apiKey },
    });

    expect(exportRes.statusCode).toBe(200);
    const lines = exportRes.body.trim().split('\n');
    expect(lines.length).toBe(2);

    const sampleObj = JSON.parse(lines[0]!);
    expect(sampleObj.sensor).toBe(1);
    expect(sampleObj.index).toBe(0);

    const lossObj = JSON.parse(lines[1]!);
    expect(lossObj.sensor).toBe(2);
    expect(lossObj.from_index).toBe(10);
    expect(lossObj.reason).toBe('test_loss');
  });
});
