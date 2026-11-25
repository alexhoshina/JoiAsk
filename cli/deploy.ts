import { spawnSync } from 'node:child_process';
import { parseArgs } from 'node:util';

const { values } = parseArgs({
  options: {
    'dry-run': { type: 'boolean' },
    'secrets-file': { type: 'string' },
    help: { type: 'boolean', short: 'h' },
  },
});

function wrangler(...args: string[]) {
  const result = spawnSync(process.execPath, [
    'node_modules/wrangler/bin/wrangler.js', ...args, '--config', 'dist/server/wrangler.json',
  ], { stdio: 'inherit' });
  if (result.error) throw result.error;
  if (result.status !== 0) process.exit(result.status ?? 1);
}

if (values.help) {
  console.log('Usage: npm run deploy -- [--dry-run] [--secrets-file PATH]');
} else {
  // Use the same built DB binding for the migration and upload. A dry run is local.
  if (!values['dry-run']) wrangler('d1', 'migrations', 'apply', 'DB', '--remote', '--force');
  wrangler('deploy', ...process.argv.slice(2));
}
