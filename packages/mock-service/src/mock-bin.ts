#!/usr/bin/env node
import { Command } from 'commander';
import { BiosignalMockServer } from './server.js';
import type { MockMode } from './generator.js';

const program = new Command();

program
  .name('biosignal-mock')
  .description('MayaCardio biosignal-mock service imitating bedside sensors')
  .option('--mode <mode>', 'Mock mode: signal or ramp', 'signal')
  .option('--seed <number>', 'RNG seed', '7')
  .option('--duration <seconds>', 'Duration in seconds', '3600')
  .option('--port <number>', 'TCP port', '7100')
  .action(async (options) => {
    const port = parseInt(options.port, 10);
    const mode = options.mode as MockMode;
    const seed = parseInt(options.seed, 10);
    const duration = parseInt(options.duration, 10);

    const mock = new BiosignalMockServer({ port, mode, seed, duration });
    await mock.start();
    console.error(`biosignal-mock started on port ${port} (mode: ${mode}, seed: ${seed}, duration: ${duration}s, session: ${mock.getSessionId()})`);

    const shutdown = async () => {
      console.error('Shutting down biosignal-mock...');
      await mock.stop();
      process.exit(0);
    };

    process.on('SIGINT', shutdown);
    process.on('SIGTERM', shutdown);
  });

program.parse(process.argv);
