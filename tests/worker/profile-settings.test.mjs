import assert from 'node:assert/strict';
import { createHmac, randomBytes } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { after, before, test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { build } from 'esbuild';
import { convertV4MiniflareOptions, Miniflare } from 'miniflare';
import { unstable_splitSqlQuery } from 'wrangler';

const defaultURL = 'https://api.bilibili.com/x/web-interface/card';
const customURL = 'https://profiles.example.org/Bili/Card?source=site';
const uid = '9007199254740993';
const probe = '/api/settings/bilibili/test';
const requests = [];
const cookies = {};
let runtime;

async function call(path, role, method = 'GET', body) {
  const headers = new Headers();
  if (role) headers.set('Cookie', cookies[role]);
  if (body !== undefined) headers.set('Content-Type', 'application/json');
  const response = await runtime.dispatchFetch('https://ask.example.org' + path, {
    headers, method, body: body === undefined ? undefined : JSON.stringify(body),
  });
  return response.json();
}

before(async () => {
  const root = fileURLToPath(new URL('../../', import.meta.url));
  const bundle = await build({
    stdin: { resolveDir: root, contents: "import { settings } from './worker/settings'; export default {fetch: settings};" },
    write: false, bundle: true, platform: 'node', format: 'esm', mainFields: ['module', 'main'],
  });
  const secret = 'profile-settings-test-only-session-secret';
  runtime = new Miniflare(convertV4MiniflareOptions({
    modules: true, script: bundle.outputFiles[0].text, compatibilityDate: '2026-11-24',
    compatibilityFlags: ['nodejs_compat'], d1Databases: ['DB'], bindings: { SESSION_SECRET: secret },
    outboundService(request) {
      const url = new URL(request.url);
      requests.push(url);
      if (url.pathname === '/restricted') return Response.json({ code: -412, message: 'upstream details' });
      const card = { mid: url.pathname === '/wrong-uid' ? '1' : uid, name: '资料接口测试', sign: '公开签名', face: 'https://i0.hdslb.com/example.jpg' };
      return Response.json({ code: 0, data: { card } });
    },
  }));
  const db = await runtime.getD1Database('DB');
  const migrate = async name => {
    const sql = await readFile(new URL('../../migrations/' + name, import.meta.url), 'utf8');
    await db.batch(unstable_splitSqlQuery(sql).map(statement => db.prepare(statement)));
  };
  await migrate('0001_config.sql');
  await migrate('0002_identity.sql');
  await db.prepare("UPDATE config SET site_name='existing site' WHERE id=1").run();
  await migrate('0005_bilibili_profile_url.sql');
  for (const role of ['admin', 'super_admin']) {
    const token = randomBytes(32).toString('hex');
    const digest = createHmac('sha256', secret).update('joi_admin:' + token).digest('hex');
    await db.batch([
      db.prepare("INSERT INTO admins(username,role,password_hash) VALUES(?,?,'unused')").bind(role, role),
      db.prepare('INSERT INTO identity_sessions(digest,admin_id,version,expires_at) SELECT ?,id,0,? FROM admins WHERE role=?')
        .bind(digest, Date.now() + 60000, role),
    ]);
    cookies[role] = 'joi_admin=' + token;
  }
});

after(async () => { if (runtime) await runtime.dispose(); });

test('migration preserves the existing site and exposes the profile URL only in administrator settings', async () => {
  const site = await call('/api/config');
  assert.equal(site.data.site_name, 'existing site');
  assert.equal(Object.hasOwn(site.data, 'bilibili_profile_url'), false);
  assert.equal((await call('/api/settings')).code, 408);
  assert.equal((await call('/api/settings', 'admin')).data.bilibili_profile_url, defaultURL);
});

test('only a super administrator can change the endpoint, while regular settings edits still work', async () => {
  assert.equal((await call('/api/settings', 'admin', 'PUT', { bilibili_profile_url: customURL, ai_model: 'rejected' })).code, 403);
  const saved = await call('/api/settings', 'super_admin', 'PUT', { bilibili_profile_url: customURL });
  assert.equal(saved.code, 200);
  assert.equal(saved.data.bilibili_profile_url, customURL);
  assert.notEqual(saved.data.ai_model, 'rejected');
  const unchanged = await call('/api/settings', 'admin', 'PUT', { bilibili_profile_url: customURL, ai_model: 'new model' });
  assert.equal(unchanged.code, 200);
  assert.equal(unchanged.data.ai_model, 'new model');
  const omitted = await call('/api/settings', 'admin', 'PUT', { spam_prompt: 'new prompt' });
  assert.equal(omitted.code, 200);
  assert.equal(omitted.data.spam_prompt, 'new prompt');
  assert.equal(omitted.data.bilibili_profile_url, customURL);
});

test('the probe reads the candidate without saving it and rejects upstream errors and the wrong identity', async () => {
  const prev = (await call('/api/settings', 'super_admin')).data.bilibili_profile_url;
  const candidate = customURL + '&mid=42&mid=43';
  const start = requests.length;
  const input = { bilibili_uid: uid, bilibili_profile_url: candidate };
  assert.equal((await call(probe, null, 'POST', input)).code, 408);
  assert.equal((await call(probe, 'admin', 'POST', input)).code, 403);
  assert.equal((await call(probe, 'super_admin', 'POST', { ...input, bilibili_uid: 'invalid' })).code, 400);
  assert.equal(requests.length, start);
  const result = await call(probe, 'super_admin', 'POST', input);
  assert.equal(result.code, 200);
  assert.deepEqual(result.data, { uid, name: '资料接口测试', signature: '公开签名' });
  assert.equal(requests.length, start + 1);
  assert.equal(requests.at(-1).origin, 'https://profiles.example.org');
  assert.equal(requests.at(-1).pathname, '/Bili/Card');
  assert.equal(requests.at(-1).searchParams.get('source'), 'site');
  assert.deepEqual(requests.at(-1).searchParams.getAll('mid'), [uid]);
  for (const path of ['restricted', 'wrong-uid']) {
    const failed = await call(probe, 'super_admin', 'POST', { ...input, bilibili_profile_url: 'https://profiles.example.org/' + path });
    assert.equal(failed.code, 502);
    assert.equal(failed.data, null);
    assert.doesNotMatch(failed.message, /upstream details/);
  }
  assert.equal((await call('/api/settings', 'super_admin')).data.bilibili_profile_url, prev);
});

test('saving and probing use the same external HTTPS validation', async () => {
  const prev = (await call('/api/settings', 'super_admin')).data.bilibili_profile_url;
  const start = requests.length;
  for (const value of ['', 'http://example.org/card', 'https://user:pass@example.org/card',
    'https://example.org/card#section', 'https://localhost/card', 'https://127.0.0.1/card', 'https://[::1]/card']) {
    const body = { bilibili_profile_url: value };
    assert.equal((await call(probe, 'super_admin', 'POST', { ...body, bilibili_uid: uid })).code, 400, value);
    assert.equal((await call('/api/settings', 'super_admin', 'PUT', body)).code, 400, value);
  }
  assert.equal(requests.length, start);
  assert.equal((await call('/api/settings', 'super_admin')).data.bilibili_profile_url, prev);
});
