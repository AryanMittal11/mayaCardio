/**
 * Core type definitions for MayaCardio system
 */

export type SensorId = 1 | 2;

export type ProcessingMode = 'online' | 'offline';
export type DeviceState = 'online' | 'offline' | 'recovering';

/**
 * Sensor 1 sample: 3 signed 24-bit integer values [ch1, ch2, ch3]
 */
export type Sensor1Values = [number, number, number];

/**
 * Sensor 2 sample: 2 signed 24-bit integer values [ch1, ch2]
 */
export type Sensor2Values = [number, number];

export interface StoredSample {
  session_id: string;
  sensor: SensorId;
  index: number;
  values: number[]; // 3 values for s1, 2 for s2
  created_at?: string;
}

export interface StoredLossRecord {
  session_id: string;
  sensor: SensorId;
  from_index: number;
  to_index: number | null; // null when end of session is unknown
  reason: string;
  created_at?: string;
}

/**
 * Section 3 Output schema for each 1-second window
 */
export interface WindowResult {
  session_id: string;
  window: number; // w where window w holds samples 400w to 400w + 399
  missing_1: number;
  missing_2: number;
  complete: boolean;
  
  // Sensor 1 per-channel statistics (null if no samples available)
  s1_ch1_mean: number | null;
  s1_ch1_min: number | null;
  s1_ch1_max: number | null;
  s1_ch2_mean: number | null;
  s1_ch2_min: number | null;
  s1_ch2_max: number | null;
  s1_ch3_mean: number | null;
  s1_ch3_min: number | null;
  s1_ch3_max: number | null;

  // Sensor 2 per-channel statistics (null if no samples available)
  s2_ch1_mean: number | null;
  s2_ch1_min: number | null;
  s2_ch1_max: number | null;
  s2_ch2_mean: number | null;
  s2_ch2_min: number | null;
  s2_ch2_max: number | null;

  // Magnitude: mean of sqrt(ch1^2 + ch2^2) over available sensor 2 samples
  magnitude: number | null;

  // Heart rate: BPM from sensor 1, channel 2 (null if conditions not met)
  heart_rate: number | null;

  // Processing mode: 'online' or 'offline'
  mode: ProcessingMode;

  computed_at?: string;
}

/**
 * Section 4 CLI Status Output Contract
 */
export interface PipelineStatus {
  mode: DeviceState;
  samples_saved: number;
  samples_in_cloud: number;
  backlog: number;
}

/**
 * Section 6.2 Mock TCP Request & Response format
 */
export interface MockReadRequest {
  cmd: 'read';
  sensor: SensorId;
  from_index?: number;
}

export interface MockLostRange {
  from_index: number;
  to_index: number | null;
  reason: string;
}

export interface MockReadReply {
  session_id: string;
  sensor: SensorId;
  first_index: number;
  count: number;
  lost: MockLostRange[];
  session_end: boolean;
  crc32: string; // 8-char hex string
  data: number[][]; // array of sample values
}

/**
 * Cloud Sync Batch Protocol
 */
export interface SyncBatchRequest {
  device_id: string;
  session_id: string;
  samples: Array<{
    sensor: SensorId;
    index: number;
    values: number[];
  }>;
  losses: Array<{
    sensor: SensorId;
    from_index: number;
    to_index: number | null;
    reason: string;
  }>;
  device_timestamp: string;
}

export interface SyncBatchResponse {
  success: boolean;
  acknowledged_samples_count: number;
  acknowledged_losses_count: number;
  cloud_timestamp: string;
}
