import type { CliConfig, CliDeps } from './types/cli.ts';
import { pathToFileURL } from 'node:url';
import { setFailed } from '@actions/core';
import { parseConfig } from './config.ts';
import { runReview } from './commands/review.ts';
import { runMention } from './commands/mention.ts';

const run = async (config: CliConfig, deps: CliDeps = {}): Promise<void> => {
  if (config.mode === 'review') {
    await runReview(config, deps);
    return;
  }
  await runMention(config, deps);
};

if (import.meta.url === pathToFileURL(process.argv[1]).href) {
  Promise.resolve()
    .then(() => run(parseConfig(process.env)))
    .catch((error) => {
      setFailed(error instanceof Error ? error.message : String(error));
      process.exit(1);
    });
}
