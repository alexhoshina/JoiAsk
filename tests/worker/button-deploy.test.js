import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { copyFile, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { test } from 'node:test';

test('button deployment migrates the bound database before publishing', async t => {
  const directory = await mkdtemp(join(tmpdir(), 'joiask button '));
  t.after(() => rm(directory, { recursive: true, force: true, maxRetries: 5 }));
  const wrangler = join(directory, 'node_modules/wrangler');
  const bin = join(directory, 'node_modules/.bin');
  const config = join(directory, 'dist/server/wrangler.json');
  const calls = join(directory, 'calls.jsonl');
  await mkdir(join(directory, 'cli'));
  await mkdir(join(directory, 'dist/server'), { recursive: true });
  await mkdir(join(wrangler, 'bin'), { recursive: true });
  await mkdir(bin);
  await copyFile(new URL('../../package.json', import.meta.url), join(directory, 'package.json'));
  await copyFile(new URL('../../cli/deploy.ts', import.meta.url), join(directory, 'cli/deploy.ts'));
  await writeFile(config, JSON.stringify({ name: 'fixture', d1_databases: [{ binding: 'DB', migrations_dir: '../../migrations' }] }));
  await writeFile(join(wrangler, 'package.json'), '{"name":"wrangler","bin":{"wrangler":"bin/wrangler.js"}}');
  await writeFile(join(wrangler, 'bin/wrangler.js'), `
    const args = process.argv.slice(2);
    require('node:fs').appendFileSync(process.env.WRANGLER_TEST_CALLS, JSON.stringify(args) + '\\n');
    if (args[0] === 'd1' && process.env.FAIL_TEST_MIGRATION === '1') process.exitCode = 1;
  `);
  // Shadow Wrangler on PATH too, including if deploy returns to a shell command.
  await writeFile(join(bin, 'wrangler'), '#!/usr/bin/env node\nrequire("../wrangler/bin/wrangler.js");\n', { mode: 0o755 });
  await writeFile(join(bin, 'wrangler.cmd'), '@node "%~dp0..\\wrangler\\bin\\wrangler.js" %*\r\n');

  async function deploy(args = [], failMigration = false) {
    await writeFile(calls, '');
    const result = spawnSync(process.execPath, ['--run', 'deploy', '--', ...args], {
      cwd: directory, encoding: 'utf8', windowsHide: true,
      env: { ...process.env, WRANGLER_TEST_CALLS: calls, FAIL_TEST_MIGRATION: failMigration ? '1' : '0' },
    });
    assert.ifError(result.error);
    assert.equal(result.status === 0, !failMigration, result.stderr);
    const log = await readFile(calls, 'utf8');
    return log.trim().split('\n').filter(Boolean).map(line => JSON.parse(line));
  }

  const [migration, upload, ...extra] = await deploy();
  assert.deepEqual(extra, []);
  assert.deepEqual(migration.slice(0, 4), ['d1', 'migrations', 'apply', 'DB']);
  assert.ok(migration.includes('--remote'));
  assert.ok(migration.includes('--force'));
  assert.equal(upload[0], 'deploy');
  assert.ok(!upload.includes('--dry-run'));
  for (const args of [migration, upload]) {
    assert.equal(resolve(directory, args[args.indexOf('--config') + 1]), config);
  }
  assert.deepEqual(await deploy([], true), [migration]);

  const secrets = 'local settings/worker secrets.env';
  const preview = await deploy(['--dry-run', '--secrets-file', secrets]);
  assert.equal(preview.length, 1);
  assert.equal(preview[0][0], 'deploy');
  assert.ok(preview[0].includes('--dry-run'));
  assert.equal(preview[0][preview[0].indexOf('--secrets-file') + 1], secrets);
});
