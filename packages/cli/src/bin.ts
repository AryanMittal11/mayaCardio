#!/usr/bin/env node
import { Command } from 'commander';
import { executeStatus } from './commands/status.js';
import { executeExport } from './commands/export.js';
import { executeResults } from './commands/results.js';

const program = new Command();

program
  .name('pipeline')
  .description('MayaCardio Bedside Data Pipeline CLI')
  .version('1.0.0');

// pipeline status
program
  .command('status')
  .description('Print current pipeline mode, samples saved, samples in cloud, and backlog')
  .option('--session <id>', 'Optional session ID filter')
  .option('--db <path>', 'Path to local SQLite database')
  .option('--cloud-url <url>', 'Cloud API URL')
  .action(async (options) => {
    try {
      await executeStatus({
        dbPath: options.db,
        cloudUrl: options.cloudUrl,
        session: options.session,
      });
    } catch (err) {
      console.error(`Error executing status: ${(err as Error).message}`);
      process.exit(1);
    }
  });

// pipeline export --session ID --from device (or --from cloud)
program
  .command('export')
  .description('Export session data and loss records as JSON Lines')
  .requiredOption('--session <id>', 'Session ID to export')
  .option('--from <source>', 'Source to export from: device or cloud', 'device')
  .option('--db <path>', 'Path to local SQLite database')
  .option('--cloud-url <url>', 'Cloud API URL')
  .action(async (options) => {
    try {
      await executeExport({
        session: options.session,
        from: options.from,
        dbPath: options.db,
        cloudUrl: options.cloudUrl,
      });
    } catch (err) {
      console.error(`Error executing export: ${(err as Error).message}`);
      process.exit(1);
    }
  });

// pipeline results --session ID
program
  .command('results')
  .description('Print one JSON line per window and mode containing section 3 outputs')
  .requiredOption('--session <id>', 'Session ID to query results for')
  .option('--db <path>', 'Path to local SQLite database')
  .option('--cloud-url <url>', 'Cloud API URL')
  .action(async (options) => {
    try {
      await executeResults({
        session: options.session,
        dbPath: options.db,
        cloudUrl: options.cloudUrl,
      });
    } catch (err) {
      console.error(`Error executing results: ${(err as Error).message}`);
      process.exit(1);
    }
  });

program.parse(process.argv);
