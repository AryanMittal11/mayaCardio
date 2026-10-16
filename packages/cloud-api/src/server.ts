import fastify, { type FastifyInstance } from 'fastify';
import {
  SyncBatchRequestSchema,
  type WindowResult,
} from '@mayacardio/shared';
import { processWindow } from '@mayacardio/processing';
import { MemoryCloudStorage, type ICloudStorage } from './db/repository.js';
import { PgCloudStorage } from './db/pg-storage.js';

export interface CloudServerOptions {
  port?: number;
  host?: string;
  apiKey?: string;
  storage?: ICloudStorage;
  databaseUrl?: string;
}

export function buildCloudServer(options?: CloudServerOptions): FastifyInstance {
  const server = fastify({ logger: false });

  const apiKey = options?.apiKey ?? process.env.CLOUD_API_KEY ?? 'mayacardio-edge-secret-token-2026';

  let storage: ICloudStorage;
  if (options?.storage) {
    storage = options.storage;
  } else if (options?.databaseUrl || process.env.DATABASE_URL) {
    storage = new PgCloudStorage(options?.databaseUrl ?? process.env.DATABASE_URL!);
  } else {
    storage = new MemoryCloudStorage();
  }

  // Native CORS handling
  server.addHook('onRequest', async (req, reply) => {
    reply.header('Access-Control-Allow-Origin', '*');
    reply.header('Access-Control-Allow-Methods', 'GET, POST, PUT, DELETE, OPTIONS');
    reply.header('Access-Control-Allow-Headers', 'Content-Type, Authorization, x-api-key');
    if (req.method === 'OPTIONS') {
      return reply.status(204).send();
    }
  });

  // Decorate server with storage
  server.decorate('storage', storage);

  // Authentication hook for /api/ routes
  server.addHook('preHandler', async (request, reply) => {
    if (request.url.startsWith('/api/')) {
      const authHeader =
        (request.headers['x-api-key'] as string | undefined) ||
        (request.headers['authorization'] as string | undefined)?.replace('Bearer ', '');

      if (authHeader !== apiKey) {
        return reply.status(401).send({ error: 'Unauthorized: Invalid API key' });
      }
    }
  });

  // Health check
  server.get('/health', async () => {
    return {
      status: 'ok',
      uptime: process.uptime(),
      timestamp: new Date().toISOString(),
    };
  });

  // Register session
  server.post('/api/v1/sessions', async (request, reply) => {
    const body = request.body as { session_id?: string; device_id?: string };
    if (!body?.session_id || !body?.device_id) {
      return reply.status(400).send({ error: 'session_id and device_id are required' });
    }
    await storage.ensureSession(body.session_id, body.device_id);
    return { success: true, session_id: body.session_id };
  });

  // Ingest batch
  server.post('/api/v1/sync/batch', async (request, reply) => {
    const parseRes = SyncBatchRequestSchema.safeParse(request.body);
    if (!parseRes.success) {
      return reply.status(400).send({
        error: 'Invalid batch payload',
        details: parseRes.error.format(),
      });
    }

    const { device_id, session_id, samples, losses } = parseRes.data;

    const ingestRes = await storage.ingestBatch({
      deviceId: device_id,
      sessionId: session_id,
      samples,
      losses,
    });

    // Online real-time window processing (§2.2, §4 #4)
    // Identify any windows covered in this batch
    if (samples.length > 0) {
      const minIdx = Math.min(...samples.map((s) => s.index));
      const maxIdx = Math.max(...samples.map((s) => s.index));
      const startWin = Math.floor(minIdx / 400);
      const endWin = Math.floor(maxIdx / 400);

      for (let w = startWin; w <= endWin; w++) {
        const winStart = w * 400;
        const winEnd = winStart + 399;

        // Fetch sensor 1 and sensor 2 samples for window
        const [s1Map, s2Map] = await Promise.all([
          storage.getSamplesForRange(session_id, 1, winStart, winEnd),
          storage.getSamplesForRange(session_id, 2, winStart, winEnd),
        ]);

        // Extended sensor 1 channel 2 samples for heart-rate calculation
        const hrStart = Math.max(0, 400 * (w - 4));
        const hrEnd = 400 * (w + 1);
        const s1Ch2Range = await storage.getSamplesForRange(session_id, 1, hrStart, hrEnd);

        const winResult = processWindow({
          sessionId: session_id,
          window: w,
          mode: 'online',
          sensor1Samples: s1Map,
          sensor2Samples: s2Map,
          extendedS1Ch2Accessor: {
            has: (idx) => s1Ch2Range.has(idx),
            get: (idx) => s1Ch2Range.get(idx)?.[1],
          },
        });

        await storage.saveResult(winResult);
      }
    }

    return {
      success: true,
      acknowledged_samples_count: ingestRes.insertedSamples + ingestRes.duplicateSamples,
      inserted_samples: ingestRes.insertedSamples,
      duplicate_samples: ingestRes.duplicateSamples,
      conflict_samples: ingestRes.conflictSamples,
      inserted_losses: ingestRes.insertedLosses,
      cloud_timestamp: new Date().toISOString(),
    };
  });

  // Coverage check
  server.get('/api/v1/sync/coverage', async (request, reply) => {
    const query = request.query as { session_id?: string; sensor?: string };
    if (!query.session_id || !query.sensor) {
      return reply.status(400).send({ error: 'session_id and sensor query params required' });
    }
    const sensor = parseInt(query.sensor, 10) as 1 | 2;
    const coverage = await storage.getCoverage(query.session_id, sensor);
    return coverage;
  });

  // Post offline results (e.g. catch up offline computed windows)
  server.post('/api/v1/results', async (request, reply) => {
    const body = request.body as { results?: WindowResult[] };
    if (!Array.isArray(body?.results)) {
      return reply.status(400).send({ error: 'results array required' });
    }
    for (const res of body.results) {
      await storage.saveResult(res);
    }
    return { success: true, count: body.results.length };
  });

  // Get results
  server.get('/api/v1/results', async (request, reply) => {
    const query = request.query as { session_id?: string };
    if (!query.session_id) {
      return reply.status(400).send({ error: 'session_id query param required' });
    }
    const results = await storage.getResults(query.session_id);
    return results;
  });

  // Cloud Export (streaming JSON Lines format matching §4)
  server.get('/api/v1/export', async (request, reply) => {
    const query = request.query as { session_id?: string };
    if (!query.session_id) {
      return reply.status(400).send({ error: 'session_id query param required' });
    }

    const sessionId = query.session_id;
    const [samples, losses] = await Promise.all([
      storage.getAllSamples(sessionId),
      storage.getAllLosses(sessionId),
    ]);

    reply.raw.setHeader('Content-Type', 'application/x-ndjson');

    // First samples
    for (const s of samples) {
      reply.raw.write(
        JSON.stringify({
          sensor: s.sensor,
          index: s.index,
          values: s.values,
        }) + '\n'
      );
    }

    // Then losses
    for (const l of losses) {
      reply.raw.write(
        JSON.stringify({
          sensor: l.sensor,
          from_index: l.from_index,
          to_index: l.to_index,
          reason: l.reason,
        }) + '\n'
      );
    }

    reply.raw.end();
  });

  return server;
}
