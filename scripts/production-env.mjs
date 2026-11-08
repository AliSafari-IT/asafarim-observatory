import { decryptEnv, encryptEnv } from "@asafarim/envage";
import { copyFile, mkdtemp, readFile, rm, chmod } from "node:fs/promises";
import { tmpdir } from "node:os";
import { resolve, join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { parseEnv } from "node:util";
import { spawn } from "node:child_process";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const permitted = new Set([
  "OPENAI_API_KEY",
  "OBSERVATORY_OPENAI_MODEL",
  "OBSERVATORY_AUTH_ENABLED",
  "OBSERVATORY_VPS_WORKSPACE",
  "OBSERVATORY_ORIGIN",
  "OBSERVATORY_ISSUER",
  "OBSERVATORY_CLIENT_ID",
  "OBSERVATORY_REDIS_URL",
  "OBSERVATORY_SESSION_SECRET",
  "OBSERVATORY_SMTP_HOST",
  "OBSERVATORY_SMTP_PORT",
  "OBSERVATORY_SMTP_SECURITY",
  "OBSERVATORY_SMTP_USER",
  "OBSERVATORY_SMTP_PASSWORD",
  "OBSERVATORY_SMTP_FROM",
]);

export function parseProductionEnv(text) {
  const values = parseEnv(text);
  if (Object.keys(values).some((key) => !permitted.has(key))) {
    throw new Error(
      "Production configuration contains an unsupported variable. Only documented Observatory runtime variables are allowed.",
    );
  }
  if (!values.OPENAI_API_KEY?.trim()) {
    throw new Error(
      "Enter OPENAI_API_KEY in the local .env.prod file before encrypting.",
    );
  }
  if (
    values.OBSERVATORY_VPS_WORKSPACE &&
    !["true", "false"].includes(values.OBSERVATORY_VPS_WORKSPACE)
  )
    throw new Error("Invalid VPS workspace flag");
  return values;
}

export async function loadEncryptedEnv(cipherPath, keyFile) {
  const folder = await mkdtemp(join(tmpdir(), "observatory-env-"));
  try {
    await copyFile(cipherPath, join(folder, ".env.prod.age"));
    // The enclosing temporary directory is private (0700). Envage never logs plaintext.
    const plaintext = await decryptEnv({ folder, env: "prod", keyFile });
    await chmod(plaintext, 0o600);
    return parseProductionEnv(await readFile(plaintext, "utf8"));
  } finally {
    await rm(folder, { recursive: true, force: true });
  }
}

async function main() {
  const [action, ...args] = process.argv.slice(2);
  const keyFile = resolve(
    process.env.OBSERVATORY_AGE_KEY_FILE ?? join(root, ".age/key.txt"),
  );
  if (action === "encrypt") {
    if (args.length) throw new Error("env:encrypt does not accept arguments.");
    parseProductionEnv(await readFile(join(root, ".env.prod"), "utf8"));
    await chmod(join(root, ".env.prod"), 0o600);
    await encryptEnv({ folder: root, env: "prod", keyFile });
    console.log(
      "Encrypted .env.prod.age. Plaintext .env.prod remains ignored and private.",
    );
    return;
  }
  if (action !== "start") throw new Error("Use encrypt or start.");
  const values = await loadEncryptedEnv(join(root, ".env.prod.age"), keyFile);
  const authenticated = values.OBSERVATORY_AUTH_ENABLED === "true";
  if (process.env.OBSERVATORY_REQUIRE_AUTH === "1" && !authenticated)
    throw new Error("Authentication is required by this runtime");
  const child = spawn(
    authenticated ? process.execPath : join(root, "bin/observatory-api"),
    authenticated ? [join(root, "gateway/server.mjs"), ...args] : args,
    {
      cwd: root,
      stdio: "inherit",
      env: { ...process.env, ...values },
    },
  );
  for (const signal of ["SIGINT", "SIGTERM"]) {
    process.on(signal, () => child.kill(signal));
  }
  child.on("error", () => {
    console.error(
      "Could not start bin/observatory-api. Build it with scripts/check.sh first.",
    );
    process.exitCode = 1;
  });
  child.on("exit", (code, signal) => {
    process.exitCode = code ?? (signal === "SIGINT" ? 130 : 1);
  });
}

if (
  process.argv[1] &&
  resolve(process.argv[1]) === fileURLToPath(import.meta.url)
) {
  main().catch(() => {
    console.error(
      "Production environment operation failed. Check the key path, .env.prod values and encrypted file. No secret values were printed.",
    );
    process.exitCode = 1;
  });
}
