import fs from "fs";
import path from "path";
import { randomBytes } from "crypto";
import * as opaque from "@serenity-kit/opaque";
import { negativeMessage } from "../src/core/runtime/messages.ts";

await opaque.ready;

const ACCOUNT_SECRETS = ["JWT_SECRET", "SYNC_SECRET", "OPAQUE_SERVER_SETUP"];

function randomHex(bytes = 32) {
  return randomBytes(bytes).toString("hex");
}

function readSecrets(file) {
  try {
    const saved = JSON.parse(fs.readFileSync(file, "utf8"));
    return ACCOUNT_SECRETS.every((name) => typeof saved?.[name] === "string" && saved[name]) ? saved : null;
  } catch {
    return null;
  }
}

function writeSecrets(file) {
  const secrets = { JWT_SECRET: randomHex(64), SYNC_SECRET: randomHex(), OPAQUE_SERVER_SETUP: opaque.server.createSetup() };
  const partial = `${file}.${process.pid}.tmp`;
  fs.writeFileSync(partial, `${JSON.stringify(secrets, null, 2)}\n`, { mode: 0o600 });
  fs.renameSync(partial, file);
  return secrets;
}

function setAside(database) {
  if (!fs.existsSync(database)) return;
  const stamp = new Date().toISOString().replace(/[:.]/g, "-");
  for (const suffix of ["", "-wal", "-shm"]) {
    if (fs.existsSync(`${database}${suffix}`)) fs.renameSync(`${database}${suffix}`, `${database}.unusable-${stamp}${suffix}`);
  }
  console.warn(negativeMessage("dev cloudsync secrets were missing, so the old dev accounts were moved aside"));
}

export function devRuntimeDir(root) {
  return path.join(root, "cache", "dev");
}

export function createDevRuntime(root, baseEnv = process.env) {
  const dir = devRuntimeDir(root);
  fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
  fs.chmodSync(dir, 0o700);
  const secretsFile = path.join(dir, "secrets.json");
  const database = path.join(dir, "cloudsync.db");
  let secrets = readSecrets(secretsFile);
  if (!secrets) {
    setAside(database);
    secrets = writeSecrets(secretsFile);
  }
  fs.chmodSync(secretsFile, 0o600);
  return {
    env: {
      ...baseEnv,
      ...Object.fromEntries(ACCOUNT_SECRETS.map((name) => [name, secrets[name]])),
      TURN_CREDENTIAL: randomHex(24),
      CLOUDSYNC_DB_PATH: database,
    },
  };
}
