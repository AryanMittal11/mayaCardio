export const PG_SCHEMA_SQL = `
-- MayaCardio PostgreSQL Cloud Storage Schema

CREATE TABLE IF NOT EXISTS cloud_sessions (
  session_id VARCHAR(64) PRIMARY KEY,
  device_id VARCHAR(64) NOT NULL,
  first_seen_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  last_seen_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  is_ended BOOLEAN NOT NULL DEFAULT FALSE
);

CREATE TABLE IF NOT EXISTS cloud_samples (
  session_id VARCHAR(64) NOT NULL,
  sensor INT2 NOT NULL,
  sample_index INT8 NOT NULL,
  ch1 INT4 NOT NULL,
  ch2 INT4 NOT NULL,
  ch3 INT4,
  ingested_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  PRIMARY KEY (session_id, sensor, sample_index)
);

CREATE INDEX IF NOT EXISTS idx_cloud_samples_lookup 
ON cloud_samples (session_id, sensor, sample_index);

CREATE TABLE IF NOT EXISTS cloud_losses (
  id BIGSERIAL PRIMARY KEY,
  session_id VARCHAR(64) NOT NULL,
  sensor INT2 NOT NULL,
  from_index INT8 NOT NULL,
  to_index INT8,
  reason VARCHAR(255) NOT NULL,
  ingested_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE(session_id, sensor, from_index, reason)
);

CREATE INDEX IF NOT EXISTS idx_cloud_losses_lookup 
ON cloud_losses (session_id, sensor, from_index);

CREATE TABLE IF NOT EXISTS cloud_results (
  session_id VARCHAR(64) NOT NULL,
  window INT4 NOT NULL,
  missing_1 INT2 NOT NULL,
  missing_2 INT2 NOT NULL,
  complete BOOLEAN NOT NULL,
  s1_ch1_mean NUMERIC(10,1),
  s1_ch1_min INT4,
  s1_ch1_max INT4,
  s1_ch2_mean NUMERIC(10,1),
  s1_ch2_min INT4,
  s1_ch2_max INT4,
  s1_ch3_mean NUMERIC(10,1),
  s1_ch3_min INT4,
  s1_ch3_max INT4,
  s2_ch1_mean NUMERIC(10,1),
  s2_ch1_min INT4,
  s2_ch1_max INT4,
  s2_ch2_mean NUMERIC(10,1),
  s2_ch2_min INT4,
  s2_ch2_max INT4,
  magnitude NUMERIC(10,1),
  heart_rate NUMERIC(10,1),
  mode VARCHAR(16) NOT NULL,
  computed_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  PRIMARY KEY (session_id, window)
);

CREATE TABLE IF NOT EXISTS cloud_integrity_faults (
  id BIGSERIAL PRIMARY KEY,
  session_id VARCHAR(64) NOT NULL,
  sensor INT2 NOT NULL,
  sample_index INT8 NOT NULL,
  existing_values JSONB NOT NULL,
  received_values JSONB NOT NULL,
  reason TEXT NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
`;
