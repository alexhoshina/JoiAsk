import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile, mkdtemp, readdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { deploymentName, targetDatabase, targetManifest, withDeployConfig } from '../../scripts/worker-cli.mjs';
import { deployBuild } from '../../scripts/deploy.mjs';

const source = JSON.parse(await readFile(new URL('../../wrangler.jsonc',import.meta.url),'utf8'));

test('fresh installs with different Worker names use disjoint storage and exactly one matching queue', () => {
  assert.equal(source.queues.producers[0].queue,source.queues.consumers[0].queue);
  for (const name of ['joiask','another-box']) {
    const config = targetManifest(source,name);
    assert.equal(config.name,name);
    assert.equal(config.d1_databases[0].database_name,name + '-db');
    assert.equal(config.r2_buckets[0].bucket_name,name + '-files');
    assert.equal(config.queues.producers[0].queue,name + '-moderation');
    assert.equal(config.queues.consumers[0].queue,config.queues.producers[0].queue);
    assert.deepEqual(config.d1_databases[0],targetDatabase(source,name));
  }
  assert.equal(source.d1_databases[0].database_name,undefined);
});

test('Deploy Button resource choices take precedence over derived names, including for the admin CLI', () => {
  const template = structuredClone(source);
  const explicit = {binding:'DB', database_id:'65c7c263-8292-4264-8d04-effa83147c7c',migrations_dir:'migrations'};
  template.d1_databases[0] = explicit;
  template.r2_buckets[0].bucket_name = 'selected-uploads';
  template.queues.producers[0].queue = 'selected-review';
  const name = deploymentName(template,undefined,'button-worker');
  const deployed = targetManifest(template,name);
  assert.deepEqual(deployed.d1_databases[0],explicit);
  assert.deepEqual(deployed.d1_databases[0],targetDatabase(template,name));
  assert.equal(deployed.r2_buckets[0].bucket_name,'selected-uploads');
  assert.equal(deployed.queues.consumers[0].queue,'selected-review');
  assert.throws(() => deploymentName(template,'other','button-worker'));
});

test('custom consumer name, named D1 and long Worker names remain valid and independent', () => {
  const template = structuredClone(source);
  template.d1_databases[0].database_name = 'selected-db';
  template.queues.consumers[0].queue = 'selected-queue';
  const first = targetManifest(template,'a'.repeat(60)+'b');
  const second = targetManifest(template,'a'.repeat(60)+'c');
  assert.equal(first.d1_databases[0].database_name,'selected-db');
  assert.equal(first.queues.producers[0].queue,'selected-queue');
  assert.ok(first.r2_buckets[0].bucket_name.length <= 63);
  assert.notEqual(first.r2_buckets[0].bucket_name,second.r2_buckets[0].bucket_name);
});

test('concurrent deploys keep separate build-relative manifests and remove them after failure', async () => {
  const dir = await mkdtemp(path.join(tmpdir(),'joiask-config-'));
  try {
    const first = targetManifest(source,'one'), second = targetManifest(source,'two');
    await withDeployConfig(path.join(dir,'wrangler.json'),first,async a => {
      await assert.rejects(withDeployConfig(path.join(dir,'wrangler.json'),second,async b => {
        assert.equal(path.dirname(a),path.dirname(b));
        assert.notEqual(a,b);
        assert.equal(JSON.parse(await readFile(a,'utf8')).name,'one');
        assert.equal(JSON.parse(await readFile(b,'utf8')).name,'two');
        throw new Error('fixture');
      }),/fixture/);
    });
    assert.deepEqual(await readdir(dir),[]);
  } finally { await rm(dir,{recursive:true,force:true}); }
});

test('a fresh account creates and pins its DB before migrations; existing UUIDs skip provisioning', async () => {
  const dir = await mkdtemp(path.join(tmpdir(),'joiask-fresh-'));
  try {
    // Match a CI-provided Worker name when running this regression in Workers Builds.
    const name = process.env.WRANGLER_CI_OVERRIDE_NAME || 'button-test';
    const file = path.join(dir,'wrangler.json');
    await writeFile(file,JSON.stringify(source));
    const uuid = '65c7c263-8292-4264-8d04-effa83147c7c';
    const calls = [];
    let exists = false;
    const cli = {
      findDatabase: (_file, db) => {
        assert.equal(db.database_name,name + '-db');
        return exists ? uuid : undefined;
      },
      wrangler: async (...args) => {
        const config = JSON.parse(await readFile(args[args.indexOf('--config') + 1],'utf8'));
        if (args[1] === 'create') {
          assert.equal(args[2],name + '-db'); exists = true; calls.push('create');
        } else {
          assert.equal(config.d1_databases[0].database_id,uuid);
          assert.equal(config.name,name);
          calls.push(args.includes('--remote') ? 'remote migrations' : args[0]);
        }
      },
    };
    await deployBuild(file,{name},cli);
    assert.deepEqual(calls,['create','remote migrations','deploy']);

    const selected = structuredClone(source);
    selected.d1_databases[0].database_id = uuid;
    await writeFile(file,JSON.stringify(selected));
    calls.length = 0;
    cli.findDatabase = () => assert.fail('explicit database ID should require no lookup');
    await deployBuild(file,{name},cli);
    assert.deepEqual(calls,['remote migrations','deploy']);

    await deployBuild(file,{name,dryRun:true},{
      findDatabase: () => assert.fail('dry-run must not access the account'),
      wrangler: async (...args) => assert.deepEqual(args.slice(0,2),['deploy','--dry-run']),
    });
  } finally { await rm(dir,{recursive:true,force:true}); }
});
