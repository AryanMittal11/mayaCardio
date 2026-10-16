#!/usr/bin/env node
import fs from 'node:fs';
import readline from 'node:readline';
import { Command } from 'commander';
import { GroundTruthChecker, type ExportSampleLine, type ExportLossLine } from './ground-truth.js';
import type { MockMode } from './generator.js';

const program = new Command();

program
  .name('check_ground_truth')
  .description('Verify exported session against ground truth')
  .argument('<exportFile>', 'Path to exported JSON Lines file')
  .option('--mode <mode>', 'Mock mode: signal or ramp', 'ramp')
  .option('--seed <number>', 'RNG seed', '7')
  .action(async (exportFilePath, options) => {
    if (!fs.existsSync(exportFilePath)) {
      console.error(`Error: File not found: ${exportFilePath}`);
      process.exit(1);
    }

    const mode = options.mode as MockMode;
    const seed = parseInt(options.seed, 10);

    const fileStream = fs.createReadStream(exportFilePath);
    const rl = readline.createInterface({ input: fileStream, crlfDelay: Infinity });

    const samples: ExportSampleLine[] = [];
    const losses: ExportLossLine[] = [];

    for await (const line of rl) {
      const trimmed = line.trim();
      if (!trimmed) continue;
      try {
        const obj = JSON.parse(trimmed);
        if (typeof obj.index === 'number') {
          samples.push(obj as ExportSampleLine);
        } else if (typeof obj.from_index === 'number') {
          losses.push(obj as ExportLossLine);
        }
      } catch (err) {
        console.error(`Malformed line in export: ${trimmed}`);
      }
    }

    const checker = new GroundTruthChecker(mode, seed);
    const result = checker.verify(samples, losses);

    console.log(result.summary);
    if (!result.valid) {
      process.exit(1);
    }
  });

program.parse(process.argv);
