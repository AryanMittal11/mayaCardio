import { z } from 'zod';

export const SensorIdSchema = z.union([z.literal(1), z.literal(2)]);

export const MockReadRequestSchema = z.object({
  cmd: z.literal('read'),
  sensor: SensorIdSchema,
  from_index: z.number().int().nonnegative().optional(),
});

export const MockLostRangeSchema = z.object({
  from_index: z.number().int().nonnegative(),
  to_index: z.number().int().nonnegative().nullable(),
  reason: z.string(),
});

export const MockReadReplySchema = z.object({
  session_id: z.string().min(1),
  sensor: SensorIdSchema,
  first_index: z.number().int().nonnegative(),
  count: z.number().int().nonnegative(),
  lost: z.array(MockLostRangeSchema),
  session_end: z.boolean(),
  crc32: z.string().length(8),
  data: z.array(z.array(z.number().int())),
});

export const SyncSampleSchema = z.object({
  sensor: SensorIdSchema,
  index: z.number().int().nonnegative(),
  values: z.array(z.number().int()),
});

export const SyncLossSchema = z.object({
  sensor: SensorIdSchema,
  from_index: z.number().int().nonnegative(),
  to_index: z.number().int().nonnegative().nullable(),
  reason: z.string(),
});

export const SyncBatchRequestSchema = z.object({
  device_id: z.string().min(1),
  session_id: z.string().min(1),
  samples: z.array(SyncSampleSchema),
  losses: z.array(SyncLossSchema),
  device_timestamp: z.string().datetime().optional(),
});

export const CliExportSampleSchema = z.object({
  sensor: SensorIdSchema,
  index: z.number().int().nonnegative(),
  values: z.array(z.number().int()),
});

export const CliExportLossSchema = z.object({
  sensor: SensorIdSchema,
  from_index: z.number().int().nonnegative(),
  to_index: z.number().int().nonnegative().nullable(),
  reason: z.string(),
});

export const PipelineStatusSchema = z.object({
  mode: z.enum(['online', 'offline', 'recovering']),
  samples_saved: z.number().int().nonnegative(),
  samples_in_cloud: z.number().int().nonnegative(),
  backlog: z.number().int().nonnegative(),
});
