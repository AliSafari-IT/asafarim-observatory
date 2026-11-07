import assert from 'node:assert/strict';
import test from 'node:test';
import { mkdtemp, writeFile, readFile, rm, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { generateKeyPairToFolder, encryptEnv } from '@asafarim/envage';
import { parseProductionEnv, loadEncryptedEnv } from './production-env.mjs';

test('configuration supports dotenv quoting and rejects missing keys and unrelated variables', () => {
  assert.equal(parseProductionEnv('OPENAI_API_KEY="fixture-only"\nOBSERVATORY_OPENAI_MODEL=gpt-5-mini').OPENAI_API_KEY, 'fixture-only');
  assert.throws(() => parseProductionEnv('OPENAI_API_KEY='));
  assert.throws(() => parseProductionEnv('OPENAI_API_KEY=fixture\nNODE_OPTIONS=anything'));
});

test('Envage round trip and wrong-key failure never create plaintext next to ciphertext', async () => {
  const folder = await mkdtemp(join(tmpdir(), 'observatory-test-'));
  try {
    const { keyFile } = await generateKeyPairToFolder('identity', folder);
    const wrong = await generateKeyPairToFolder('other-identity', folder);
    await writeFile(join(folder, '.env.prod'), 'OPENAI_API_KEY=fixture-not-real\nOBSERVATORY_OPENAI_MODEL=gpt-5-mini\n', { mode: 0o600 });
    await encryptEnv({folder, env:'prod', keyFile});
    await rm(join(folder, '.env.prod'));
    assert.equal((await loadEncryptedEnv(join(folder,'.env.prod.age'), keyFile)).OPENAI_API_KEY, 'fixture-not-real');
    await assert.rejects(stat(join(folder,'.env.prod')), {code:'ENOENT'});
    assert.ok(!(await readFile(join(folder,'.env.prod.age'),'utf8')).includes('fixture-not-real'));
    await assert.rejects(loadEncryptedEnv(join(folder,'.env.prod.age'), wrong.keyFile));
  } finally { await rm(folder,{recursive:true,force:true}); }
});
