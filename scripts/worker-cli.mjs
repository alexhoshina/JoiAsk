import { spawn } from 'node:child_process';
import { createHash, randomUUID } from 'node:crypto';
import { once } from 'node:events';
import { access, readFile, readdir, unlink, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseEnv } from 'node:util';

export const root = fileURLToPath(new URL('../', import.meta.url));
export const wranglerBin = path.join(root, 'node_modules/wrangler/bin/wrangler.js');
export function childEnvironment(extra) {
  const env = { ...process.env, WRANGLER_SEND_METRICS: 'false', ...extra };
  for (const key of Object.keys(env)) {
    if (/^JOIASK_INITIAL_ADMIN_(USERNAME|PASSWORD)$/i.test(key)) delete env[key];
  }
  return env;
}

export function startNode(script, args, options = {}) {
  return spawn(process.execPath, [script, ...args], {
    cwd: root, stdio: 'inherit', windowsHide: true, ...options,
    env: childEnvironment(options.env),
  });
}
export async function finished(child) {
  const [code, signal] = await once(child, 'exit');
  if (code !== 0) throw new Error('Command failed: ' + (signal || code));
}
export const wrangler = (...args) => finished(startNode(wranglerBin, args));

export async function builtConfig() {
  // Vite writes a deployment pointer alongside its source configuration.
  for (const dir of [path.join(root, 'frontend'), root]) {
    const location = path.join(dir, '.wrangler/deploy');
    try {
      const pointer = JSON.parse(await readFile(path.join(location, 'config.json'), 'utf8'));
      if (pointer.configPath) {
        const config = path.resolve(location, pointer.configPath);
        await access(config);
        return config;
      }
    } catch (err) { if (err.code !== 'ENOENT') throw err; }
  }
  const dist = path.join(root, 'dist');
  const configs = (await readdir(dist, { recursive: true })).filter(file => path.basename(file) === 'wrangler.json');
  if (configs.length !== 1) throw new Error('Build the Worker with npm run build before starting it');
  return path.join(dist, configs[0]);
}

export function deploymentName(config, requested, ciName = process.env.WRANGLER_CI_OVERRIDE_NAME) {
  if (requested && ciName && requested !== ciName) {
    throw new Error('--name disagrees with the Worker selected in Cloudflare Builds: ' + ciName);
  }
  const name = ciName || requested || config.name;
  if (!name) throw new Error('Specify the target Worker using --name or the configuration name.');
  return name;
}

function resourceName(worker, suffix) {
  const candidate = worker + '-' + suffix;
  if (candidate.length <= 63 && /^[a-z0-9][a-z0-9-]*$/.test(candidate)) return candidate;
  // R2 limits bucket names to 63 characters. Keep long instance names distinct.
  const hash = createHash('sha256').update(worker).digest('hex').slice(0,12);
  const prefix = worker.toLowerCase().replace(/[^a-z0-9-]/g,'-').replace(/^-+/,'') || 'joiask';
  return prefix.slice(0, 63 - hash.length - suffix.length - 2) + '-' + hash + '-' + suffix;
}

export function targetDatabase(config, name) {
  const db = config.d1_databases?.find(item => item.binding === 'DB');
  if (!db) throw new Error('Missing D1 binding DB in the target configuration.');
  return db.database_id || db.database_name ? {...db} : {...db, database_name:resourceName(name,'db')};
}

export function targetManifest(source, name) {
  const config = structuredClone(source);
  config.name = name;
  const db = targetDatabase(source, name);
  config.d1_databases = config.d1_databases.map(item => item.binding === 'DB' ? db : item);
  const bucket = config.r2_buckets.find(item => item.binding === 'FILES');
  if (!bucket) throw new Error('Missing R2 binding FILES.');
  bucket.bucket_name ??= resourceName(name,'files');
  const producer = config.queues.producers.find(item => item.binding === 'MODERATION');
  if (!producer) throw new Error('Missing queue producer MODERATION.');
  // A template clone can supply a real queue name on either side. The
  // checked-in names must match so local workerd connects the producer to
  // the consumer even before a remote deployment manifest is produced.
  const placeholder = 'joiask-moderation';
  const consumers = config.queues.consumers;
  const consumer = consumers.find(item => item.queue === producer.queue)
    ?? consumers.find(item => item.queue === placeholder) ?? (consumers.length === 1 ? consumers[0] : null);
  if (!consumer) throw new Error('Could not identify the moderation queue consumer.');
  const producerName = producer.queue === placeholder ? undefined : producer.queue;
  const consumerName = consumer.queue === placeholder ? undefined : consumer.queue;
  if (producerName && consumerName && producerName !== consumerName) {
    throw new Error('The MODERATION producer and consumer select different queues.');
  }
  producer.queue = consumerName || producerName || resourceName(name,'moderation');
  consumer.queue = producer.queue;
  return config;
}

// Keep relative asset, entrypoint, and migration paths relative to the Vite
// output directory. Concurrent deploys must not rewrite one another's config.
export async function withDeployConfig(buildFile, config, run) {
  const file = path.join(path.dirname(buildFile), '.deploy-' + randomUUID() + '.json');
  await writeFile(file, JSON.stringify(config), {flag:'wx', mode:0o600});
  try { return await run(file); }
  finally { await unlink(file); }
}

// With secrets.required configured, Wrangler dev only loads declared keys from the local file.
export async function withLocalSecrets(secretFile, run) {
  const file = await builtConfig();
  const values = parseEnv(await readFile(secretFile, 'utf8'));
  const optional = ['JOIASK_INITIAL_ADMIN_USERNAME', 'JOIASK_INITIAL_ADMIN_PASSWORD']
    .filter(name => values[name]);
  if (!optional.length) return run(file);
  const config = JSON.parse(await readFile(file, 'utf8'));
  config.secrets = { ...config.secrets, required: [...new Set([...(config.secrets?.required ?? []), ...optional])] };
  return withDeployConfig(file, config, run);
}
