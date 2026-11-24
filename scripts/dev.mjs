import { randomBytes } from 'node:crypto';
import { writeFile } from 'node:fs/promises';
import path from 'node:path';
import { builtConfig, finished, root, startNode, wrangler, wranglerBin } from './worker-cli.mjs';

const secretFile = path.join(root, '.dev.vars');
try {
  await writeFile(secretFile, 'SESSION_SECRET=' + randomBytes(32).toString('hex') + '\nSETTINGS_KEY=' +
    randomBytes(32).toString('hex') + '\n', { flag: 'wx', mode: 0o600 });
} catch (err) { if (err.code !== 'EEXIST') throw err; }
await finished(startNode(path.join(root, 'scripts/build.mjs'), []));
await wrangler('d1', 'migrations', 'apply', 'DB', '--local', '--config', 'wrangler.jsonc');
const child = startNode(wranglerBin, ['dev', '--local', '--config', await builtConfig(), '--env-file', secretFile,
  '--persist-to', path.join(root, '.wrangler/state'), ...process.argv.slice(2)]);
process.on('SIGINT', () => child.kill('SIGINT'));
process.on('SIGTERM', () => child.kill('SIGTERM'));
await finished(child);
