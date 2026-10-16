import fs from 'node:fs';
import path from 'node:path';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);

export interface SqliteStatement {
  run(...params: unknown[]): { changes: number; lastInsertRowid: number | bigint };
  get(...params: unknown[]): Record<string, unknown> | undefined;
  all(...params: unknown[]): Record<string, unknown>[];
}

export interface SqliteDb {
  exec(sql: string): void;
  prepare(sql: string): SqliteStatement;
  transaction<T>(fn: () => T): () => T;
  close(): void;
}

export function openSqliteDatabase(dbPath: string): SqliteDb {
  if (dbPath !== ':memory:') {
    const dir = path.dirname(dbPath);
    if (!fs.existsSync(dir)) {
      fs.mkdirSync(dir, { recursive: true });
    }
  }

  // Load DatabaseSync dynamically from built-in node:sqlite
  let DatabaseSync: any;
  try {
    const sqliteModule = require('node:sqlite');
    DatabaseSync = sqliteModule.DatabaseSync;
  } catch (err) {
    throw new Error(`Failed to load node:sqlite: ${(err as Error).message}`);
  }

  const rawDb = new DatabaseSync(dbPath);
  rawDb.exec('PRAGMA journal_mode = WAL;');
  rawDb.exec('PRAGMA synchronous = FULL;');
  rawDb.exec('PRAGMA busy_timeout = 5000;');

  return {
    exec: (sql: string) => rawDb.exec(sql),
    prepare: (sql: string) => {
      const stmt = rawDb.prepare(sql);
      return {
        run: (...params: unknown[]) => {
          const res = stmt.run(...params);
          return {
            changes: res.changes ?? 0,
            lastInsertRowid: res.lastInsertRowid ?? 0,
          };
        },
        get: (...params: unknown[]) => {
          return stmt.get(...params) as Record<string, unknown> | undefined;
        },
        all: (...params: unknown[]) => {
          return stmt.all(...params) as Record<string, unknown>[];
        },
      };
    },
    transaction: <T>(fn: () => T) => {
      return () => {
        rawDb.exec('BEGIN IMMEDIATE;');
        try {
          const result = fn();
          rawDb.exec('COMMIT;');
          return result;
        } catch (err) {
          try {
            rawDb.exec('ROLLBACK;');
          } catch {
            // Ignore rollback errors if transaction already aborted
          }
          throw err;
        }
      };
    },
    close: () => {
      rawDb.close();
    },
  };
}
