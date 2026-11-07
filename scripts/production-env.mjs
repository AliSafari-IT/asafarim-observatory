import { decryptEnv, encryptEnv } from '@asafarim/envage';
import { copyFile, mkdtemp, readFile, rm, chmod } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { resolve, join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseEnv } from 'node:util';
import { spawn } from 'node:child_process';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const permitted = new Set(['OPENAI_API_KEY', 'OBSERVATORY_OPENAI_MODEL']);

export function parseProductionEnv(text) {
  const values = parseEnv(text);
  if (Object.keys(values).some((key) => !permitted.has(key))) {
    throw new Error('Production configuration contains an unsupported variable. Only OPENAI_API_KEY and OBSERVATORY_OPENAI_MODEL are allowed.');
  }
  if (!values.OPENAI_API_KEY?.trim()) {
    throw new Error('Enter OPENAI_API_KEY in the local .env.prod file before encrypting.');
  }
  return values;
}

export async function loadEncryptedEnv(cipherPath, keyFile) {
  const folder = await mkdtemp(join(tmpdir(), 'observatory-env-'));
  try {
    await copyFile(cipherPath, join(folder, '.env.prod.age'));
    // The enclosing temporary directory is private (0700). Envage never logs plaintext.
    const plaintext = await decryptEnv({ folder, env: 'prod', keyFile });
    await chmod(plaintext, 0o600);
    return parseProductionEnv(await readFile(plaintext, 'utf8'));
  } finally {
    await rm(folder, { recursive: true, force: true });
  }
}

async function main() {
  const [action, ...args] = process.argv.slice(2);
  const keyFile = resolve(process.env.OBSERVATORY_AGE_KEY_FILE ?? join(root, '.age/key.txt'));
  if (action === 'encrypt') {
    if (args.length) throw new Error('env:encrypt does not accept arguments.');
    parseProductionEnv(await readFile(join(root, '.env.prod'), 'utf8'));
    await chmod(join(root, '.env.prod'), 0o600);
    await encryptEnv({ folder: root, env: 'prod', keyFile });
    console.log('Encrypted .env.prod.age. Plaintext .env.prod remains ignored and private.');
    return;
  }
  if (action !== 'start') throw new Error('Use encrypt or start.');
  const values = await loadEncryptedEnv(join(root, '.env.prod.age'), keyFile);
  const child = spawn(join(root, 'bin/observatory-api'), args, {
    cwd: root, stdio: 'inherit', env: { ...process.env, ...values }
  });
  for (const signal of ['SIGINT', 'SIGTERM']) {
    process.on(signal, () => child.kill(signal));
  }
  child.on('error', () => {
    console.error('Could not start bin/observatory-api. Build it with scripts/check.sh first.');
    process.exitCode = 1;
  });
  child.on('exit', (code, signal) => {
    process.exitCode = code ?? (signal === 'SIGINT' ? 130 : 1);
  });
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().catch(() => {
    console.error('Production environment operation failed. Check the key path, .env.prod values and encrypted file. No secret values were printed.');
    process.exitCode = 1;
  });
}
