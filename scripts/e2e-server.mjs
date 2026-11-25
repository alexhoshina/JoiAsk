import { randomBytes } from 'node:crypto';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { adminCredentials, port } from '../tests/e2e/environment.mjs';
import { finished, startNode, withLocalSecrets, wrangler, wranglerBin } from './worker-cli.mjs';

const directory = await mkdtemp(path.join(tmpdir(), 'joiask-e2e-'));
const local = ['--local', '--persist-to', directory];
let child;
let stopping = false;
for (const signal of ['SIGTERM', 'SIGINT']) {
  process.on(signal, () => { stopping = true; child?.kill(signal); });
}
try {
  const secretFile = path.join(directory, '.env');
  await writeFile(secretFile, 'SESSION_SECRET=' + randomBytes(32).toString('hex') +
    '\nSETTINGS_KEY=' + randomBytes(32).toString('hex') +
    '\nJOIASK_INITIAL_ADMIN_PASSWORD=' + adminCredentials.password + '\n', { mode: 0o600 });
  await wrangler('d1', 'migrations', 'apply', 'DB', ...local, '--config', 'wrangler.jsonc');
  await withLocalSecrets(secretFile, async config => {
    child = startNode(wranglerBin, ['dev', ...local, '--port', String(port), '--ip', '127.0.0.1',
      '--var', 'JOIASK_INITIAL_ADMIN_USERNAME:' + adminCredentials.username,
      '--env-file', secretFile, '--config', config, '--show-interactive-dev-session=false']);
    try { await finished(child); } catch (err) { if (!stopping) throw err; }
  });
} finally {
  await rm(directory, { recursive: true, force: true, maxRetries: 5 });
}
