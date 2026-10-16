import type { SqliteDb } from './sqlite-adapter.js';

export const SCHEMA_SQL = `
-- MayaCardio Device Storage Schema

CREATE TABLE IF NOT EXISTS sessions (
  session_id TEXT PRIMARY KEY,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  last_seen_at TEXT NOT NULL DEFAULT (datetime('now')),
  is_ended INTEGER NOT NULL DEFAULT 0
);

CREATE TABLE IF NOT EXISTS samples (
  session_id TEXT NOT NULL,
  sensor INTEGER NOT NULL,
  sample_index INTEGER NOT NULL,
  ch1 INTEGER NOT NULL,
  ch2 INTEGER NOT NULL,
  ch3 INTEGER,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  PRIMARY KEY (session_id, sensor, sample_index)
);

CREATE INDEX IF NOT EXISTS idx_samples_lookup 
ON samples (session_id, sensor, sample_index);

CREATE TABLE IF NOT EXISTS losses (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  session_id TEXT NOT NULL,
  sensor INTEGER NOT NULL,
  from_index INTEGER NOT NULL,
  to_index INTEGER,
  reason TEXT NOT NULL,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  UNIQUE(session_id, sensor, from_index, reason)
);

CREATE INDEX IF NOT EXISTS idx_losses_lookup 
ON losses (session_id, sensor, from_index);

CREATE TABLE IF NOT EXISTS checkpoints (
  session_id TEXT NOT NULL,
  sensor INTEGER NOT NULL,
  last_received_index INTEGER NOT NULL DEFAULT -1,
  last_synced_index INTEGER NOT NULL DEFAULT -1,
  last_processed_window INTEGER NOT NULL DEFAULT -1,
  updated_at TEXT NOT NULL DEFAULT (datetime('now')),
  PRIMARY KEY (session_id, sensor)
);

CREATE TABLE IF NOT EXISTS results (
  session_id TEXT NOT NULL,
  window INTEGER NOT NULL,
  missing_1 INTEGER NOT NULL,
  missing_2 INTEGER NOT NULL,
  complete INTEGER NOT NULL,
  s1_ch1_mean REAL,
  s1_ch1_min INTEGER,
  s1_ch1_max INTEGER,
  s1_ch2_mean REAL,
  s1_ch2_min INTEGER,
  s1_ch2_max INTEGER,
  s1_ch3_mean REAL,
  s1_ch3_min INTEGER,
  s1_ch3_max INTEGER,
  s2_ch1_mean REAL,
  s2_ch1_min INTEGER,
  s2_ch1_max INTEGER,
  s2_ch2_mean REAL,
  s2_ch2_min INTEGER,
  s2_ch2_max INTEGER,
  magnitude REAL,
  heart_rate REAL,
  mode TEXT NOT NULL,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  PRIMARY KEY (session_id, window)
);

CREATE INDEX IF NOT EXISTS idx_results_lookup 
ON results (session_id, window);

CREATE TABLE IF NOT EXISTS integrity_faults (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  session_id TEXT NOT NULL,
  sensor INTEGER NOT NULL,
  sample_index INTEGER NOT NULL,
  existing_values TEXT NOT NULL,
  received_values TEXT NOT NULL,
  reason TEXT NOT NULL,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);
`;

export function initializeDatabase(db: SqliteDb): void {
  db.exec(SCHEMA_SQL);
}
