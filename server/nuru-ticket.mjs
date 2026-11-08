import { createHmac, randomBytes } from "node:crypto";

const NURU_TICKET_PREFIX = "auth.";
const TICKET_SECONDS = 30;
const KEY_PERIOD_SECONDS = 3600;

const hmac = (key, message) => createHmac("sha256", key).update(message).digest();

export function nuruTicketMinter(secret, now = Date.now) {
  if (!secret) return null;
  if (Buffer.byteLength(secret) < 32) throw new Error("invalid nuru ticket configuration... /ᐠ - ˕ -マ");
  return () => {
    const seconds = Math.floor(now() / 1000);
    const expires = seconds + TICKET_SECONDS;
    const nonce = randomBytes(16).toString("base64url");
    const key = hmac(secret, `lyra-nuru/key/${Math.floor(seconds / KEY_PERIOD_SECONDS)}`);
    const signature = hmac(key, `lyra-nuru/v1\n${expires}\n${nonce}`).toString("base64url");
    return { ticket: `${NURU_TICKET_PREFIX}${expires}.${nonce}.${signature}`, expires: expires * 1000 };
  };
}
