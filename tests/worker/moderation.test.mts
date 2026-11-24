import { test } from 'node:test';
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import { readdirSync, readFileSync } from 'node:fs';
import { classify, moderate, recoverModeration } from '../../worker/moderation.ts';
import { encryptSecret, decryptSecret } from '../../worker/common.ts';

test('settings secrets are randomized, authenticated and require the deployment key', async () => {
  const key = 'a'.repeat(32);
  const first = await encryptSecret('secret', key);
  assert.notEqual(first, await encryptSecret('secret', key));
  assert.equal(await decryptSecret(first, key), 'secret');
  await assert.rejects(decryptSecret(first, 'b'.repeat(32)));
});

test('chat completions accepts only a boolean decision and posts minimal input', async () => {
  const config = { ai_base_url: 'https://model.example/v1', ai_model: 'model', spam_prompt: 'spam' };
  const question = { content: 'hello', images_num: 2 };
  const response = (content: string) => Response.json({ choices: [{ message: { content } }] });
  assert.equal(await classify(config, 'key', question, async (url, init) => {
    assert.equal(url, 'https://model.example/v1/chat/completions');
    const payload = JSON.parse(String(init?.body));
    assert.equal(payload.model, 'model');
    assert.deepEqual(JSON.parse(payload.messages[1].content), question);
    return response('{"is_spam":false}');
  }), false);
  await assert.rejects(classify(config, 'key', question, async () => response('{"is_spam":"false"}')));
  await assert.rejects(classify(config, 'key', question, async () => new Response(null, { status: 429 })));
});

function database() {
  const sqlite = new DatabaseSync(':memory:');
  const dir = new URL('../../migrations/', import.meta.url);
  for (const file of readdirSync(dir).filter(f => f.endsWith('.sql')).sort()) sqlite.exec(readFileSync(new URL(file, dir), 'utf8'));
  function prepare(sql: string, params: (string | number)[] = []) {
    const st = sqlite.prepare(sql);
    return {
      bind: (...values: (string | number)[]) => prepare(sql, values),
      first: () => st.get(...params),
      run: () => st.run(...params),
      all: () => ({ results: st.all(...params) }),
    };
  }
  const DB = { prepare, batch: (items: {run(): unknown}[]) => {
    sqlite.exec('BEGIN');
    try { const values = items.map(s => s.run()); sqlite.exec('COMMIT'); return values; }
    catch (err) { sqlite.exec('ROLLBACK'); throw err; }
  }};
  return { DB, sqlite };
}

test('transient retry, crash recovery, manual review during model call, and duplicate delivery', async () => {
  const { DB, sqlite } = database();
  const modelKey = 'k'.repeat(32);
  const key = await encryptSecret('fixture-api', modelKey);
  DB.prepare('UPDATE config SET ai_api_key=?').bind(key).run();
  DB.prepare("INSERT INTO questions(id,tag_id,content) VALUES(101,1,'fixture')").run();
  DB.prepare('INSERT OR IGNORE INTO moderation_outbox(question_id) VALUES(101)').run();
  const sent: unknown[] = [];
  const env = { DB, SETTINGS_KEY: modelKey, MODERATION: { sendBatch: (messages: unknown[]) => sent.push(...messages) } } as unknown as Env;
  const original = globalThis.fetch;
  let ack = 0, retry = 0, requests = 0;
  const batch = { messages: [{ body: { questionId: 101 }, ack: () => ack++, retry: () => retry++, attempts: 1 }] } as unknown as MessageBatch<{questionId:number}>;
  try {
    await recoverModeration(env);
    assert.deepEqual(sent, [{ body: { questionId: 101 } }]);
    await recoverModeration(env);
    assert.equal(sent.length, 1);
    globalThis.fetch = async () => new Response(null, { status: 503 });
    await moderate(batch, env);
    assert.equal(retry, 1);
    assert.equal(ack, 0);
    globalThis.fetch = async () => {
      requests++;
      DB.prepare('UPDATE questions SET moderation_version=1,is_spam=0 WHERE id=101').run();
      return Response.json({ choices: [{ message: { content: '{"is_spam":true}' } }] });
    };
    await moderate(batch, env);
    await moderate(batch, env);
    assert.equal(requests, 1);
    assert.equal(ack, 2);
    assert.equal(DB.prepare('SELECT is_spam FROM questions WHERE id=101').first()?.is_spam, 0);
    assert.equal(DB.prepare('SELECT count(*) AS n FROM moderation_outbox').first()?.n, 0);
  } finally { globalThis.fetch = original; sqlite.close(); }
});
