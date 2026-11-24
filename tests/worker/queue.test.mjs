import assert from 'node:assert/strict';
import { readFile, readdir } from 'node:fs/promises';
import { join } from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import { build } from 'esbuild';
import { convertV4MiniflareOptions, Miniflare } from 'miniflare';
import { unstable_getMiniflareWorkerOptions, unstable_splitSqlQuery } from 'wrangler';
import { encryptSecret } from '../../worker/common.ts';

const root = fileURLToPath(new URL('../../', import.meta.url));

test('HTTP submission traverses the configured queue and commits the model verdict to D1', { timeout: 35000 }, async t => {
  const { workerOptions } = unstable_getMiniflareWorkerOptions(join(root, 'wrangler.jsonc'));
  const compiled = await build({
    entryPoints: [join(root, 'worker/index.ts')], bundle: true, write: false,
    platform: 'node', format: 'esm', mainFields: ['module', 'main'],
    external: ['cloudflare:workers'],
    plugins: [{
      name: 'omit-vite-ssr',
      setup(plugin) {
        // Only the frontend SSR entry depends on Vite's virtual modules.
        plugin.onResolve({ filter: /^\.\/ssr$/ }, () => ({ path: 'ssr', namespace: 'test' }));
        plugin.onLoad({ filter: /^ssr$/, namespace: 'test' }, () => ({
          contents: "export default {fetch(){ throw new Error('Unexpected SSR request'); }}",
        }));
      },
    }],
  });
  const settingsKey = 'isolated-settings-key-for-queue-test';
  const content = 'A test submission for the moderation queue';
  const model = Promise.withResolvers();
  let modelRequest;
  const { compatibilityDate, compatibilityFlags, d1Databases, r2Buckets, durableObjects, queueProducers, queueConsumers } = workerOptions;
  const runtime = new Miniflare(convertV4MiniflareOptions({
    modules: true, script: compiled.outputFiles[0].text,
    compatibilityDate, compatibilityFlags, d1Databases, r2Buckets, durableObjects, queueProducers, queueConsumers,
    bindings: { SETTINGS_KEY: settingsKey, SESSION_SECRET: 'test-only-session-key-for-queue-dispatch' },
    async outboundService(request) {
      modelRequest = { url: request.url, method: request.method,
        authorization: request.headers.get('Authorization'), body: await request.json() };
      await model.promise;
      return Response.json({ choices: [{ message: { content: '{"is_spam":true}' } }] });
    },
  }));
  try {
    const db = await runtime.getD1Database('DB');
    const migrations = join(root, 'migrations');
    for (const file of (await readdir(migrations)).filter(name => name.endsWith('.sql')).sort()) {
      const sql = await readFile(join(migrations, file), 'utf8');
      await db.batch(unstable_splitSqlQuery(sql).map(statement => db.prepare(statement)));
    }
    await db.prepare('UPDATE config SET ai_api_key=?, ai_base_url=?, ai_model=? WHERE id=1')
      .bind(await encryptSecret('test-api-key', settingsKey), 'https://model.example.test/v1', 'queue-test-model').run();

    const response = await runtime.dispatchFetch('https://ask.example.test/api/question', {
      method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({ tag_id: '1', content }).toString(),
    });
    assert.equal(response.status, 200);
    assert.equal((await response.json()).code, 200);
    const status = db.prepare('SELECT q.id,q.is_spam,o.question_id AS pending FROM questions q ' +
      'LEFT JOIN moderation_outbox o ON o.question_id=q.id WHERE q.content=?').bind(content);
    await t.waitFor(() => assert.ok(modelRequest, 'consumer should call the mock model'), { timeout: 18000 });
    const pending = await status.first();
    assert.equal(pending.is_spam, 0);
    assert.equal(pending.pending, pending.id);
    assert.equal(modelRequest.url, 'https://model.example.test/v1/chat/completions');
    assert.equal(modelRequest.method, 'POST');
    assert.equal(modelRequest.authorization, 'Bearer test-api-key');
    assert.equal(modelRequest.body.model, 'queue-test-model');
    assert.deepEqual(JSON.parse(modelRequest.body.messages.find(message => message.role === 'user').content),
      { content, images_num: 0 });

    model.resolve();
    await t.waitFor(async () => {
      assert.deepEqual(await status.first(), { id: pending.id, is_spam: 1, pending: null });
    }, { timeout: 5000 });
  } finally {
    model.resolve();
    await runtime.dispose();
  }
});
