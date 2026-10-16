/**
 * MayaCardio System Constants
 * Derived strictly from MayaCardio System Engineering Assessment Specification
 */

export const SAMPLE_RATE = 400; // samples per second
export const WINDOW_SIZE = 400; // 1-second window size
export const SENSOR1_CHANNELS = 3;
export const SENSOR2_CHANNELS = 2;

// Heart-rate detection parameters (§3)
export const HR_PREV_SAMPLES_REQUIRED = 800; // 2 seconds before
export const HR_NEXT_SAMPLES_REQUIRED = 1;   // 1 sample lookahead
export const HR_REFRACTORY_SAMPLES = 100;    // at least 100 samples between peaks (0.25s)
export const HR_WINDOW_LOOKBACK_SECONDS = 5; // 5 seconds window [400*(w-4) to 400*(w+1)-1]
export const HR_WINDOW_LOOKBACK_SAMPLES = 2000; // 5 seconds * 400 = 2000 samples

// Mock limits (§6.2)
export const MOCK_BUFFER_SECONDS = 10;
export const MOCK_BUFFER_SAMPLES = 4000; // 10 seconds * 400

// 24-bit signed integer limits
export const MIN_INT24 = -8_388_608;
export const MAX_INT24 = 8_388_607;
export const MOD_INT24 = 8_388_608;

// Latency & SLA bounds (§1, §2.2, §2.4, §4)
export const ONLINE_PROCESSING_SLA_MS = 5000; // 5 seconds SLA per window
export const MODE_SWITCH_SLA_MS = 10000;       // 10 seconds SLA for online/offline switch
export const MAX_CATCHUP_ALLOWED_MS = 15 * 60 * 1000; // 15 minutes for 2h outage catch-up
