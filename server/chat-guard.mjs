import { createHmac, randomBytes, timingSafeEqual } from "crypto";
import { roleRank } from "../src/features/chat/chatRoles.ts";

const COOKIE = "lyra_chat_browser";
const RETENTION_MS = 90 * 24 * 60 * 60_000;

export function createChatGuard(db) {
  db.exec(`
    CREATE TABLE IF NOT EXISTS chat_guard_secret (id INTEGER PRIMARY KEY CHECK (id = 1), secret TEXT NOT NULL);
    CREATE TABLE IF NOT EXISTS chat_browser_links (
      user_id INTEGER NOT NULL, username TEXT NOT NULL, browser TEXT NOT NULL, seen_at INTEGER NOT NULL,
      PRIMARY KEY (user_id, username, browser)
    );
    CREATE INDEX IF NOT EXISTS idx_chat_browser_links_browser ON chat_browser_links(browser);
    CREATE INDEX IF NOT EXISTS idx_chat_browser_links_seen ON chat_browser_links(seen_at);
    CREATE TABLE IF NOT EXISTS chat_browser_restrictions (
      user_id INTEGER NOT NULL, username TEXT NOT NULL, kind TEXT NOT NULL, until INTEGER NOT NULL, role TEXT NOT NULL,
      PRIMARY KEY (user_id, username, kind)
    );
  `);
  db.query("INSERT OR IGNORE INTO chat_guard_secret VALUES (1, ?)").run(randomBytes(32).toString("hex"));
  const { secret } = db.query("SELECT secret FROM chat_guard_secret WHERE id = 1").get();
  const digest = (value) => createHmac("sha256", secret).update(value).digest("base64url");
  const link = db.query(`INSERT INTO chat_browser_links VALUES ($id, $username, $browser, $time)
    ON CONFLICT (user_id, username, browser) DO UPDATE SET seen_at = excluded.seen_at`);
  const pruneLinks = db.query("DELETE FROM chat_browser_links WHERE seen_at < $cutoff");
  const pruneRestrictions = db.query("DELETE FROM chat_browser_restrictions WHERE until <= $time");
  const restrict = db.query(`INSERT INTO chat_browser_restrictions VALUES ($id, $username, $kind, $until, $role)
    ON CONFLICT (user_id, username, kind) DO UPDATE SET until = excluded.until, role = excluded.role`);
  const clear = db.query("DELETE FROM chat_browser_restrictions WHERE user_id = $id AND kind = $kind");
  const linked = db.query(`SELECT DISTINCT r.kind, r.until, r.role FROM chat_browser_links mine
    JOIN chat_browser_links source ON source.browser = mine.browser
    JOIN chat_browser_restrictions r ON r.user_id = source.user_id AND r.username = source.username
    WHERE mine.user_id = $id AND mine.username = $username AND mine.seen_at >= $cutoff
      AND source.seen_at >= $cutoff AND r.until > $time`);
  let cleanedAt = -Infinity;

  return {
    browser(request) {
      const cookies = (request.headers.get("cookie") || "").split(";");
      const value = cookies.find((part) => part.trim().startsWith(`${COOKIE}=`))?.trim().slice(COOKIE.length + 1);
      const match = /^([A-Za-z0-9_-]{43})\.([A-Za-z0-9_-]{43})$/.exec(value || "");
      const valid = match && timingSafeEqual(Buffer.from(match[2]), Buffer.from(digest(`cookie:${match[1]}`)));
      return {
        token: valid ? match[1] : null,
        secure: new URL(request.url).protocol === "https:" || request.headers.get("x-forwarded-proto") === "https",
        authenticated: false,
      };
    },
    observe(row, browser, time) {
      if (time - cleanedAt >= 60 * 60_000) {
        pruneLinks.run({ cutoff: time - RETENTION_MS });
        pruneRestrictions.run({ time });
        cleanedAt = time;
      }
      const token = browser.token ?? digest(`identity:${row.id}:${row.username}`);
      link.run({ id: row.id, username: row.username, browser: digest(`browser:${token}`), time });
      browser.cookie = `${COOKIE}=${token}.${digest(`cookie:${token}`)}; Path=/api/chat; HttpOnly; SameSite=Strict; Max-Age=${RETENTION_MS / 1000}${browser.secure ? "; Secure" : ""}`;
      browser.authenticated = true;
    },
    restrict(row, kind, until) {
      if (!until) clear.run({ id: row.id, kind });
      else restrict.run({ id: row.id, username: row.username, kind, until, role: row.role });
    },
    apply(row, time) {
      const result = { ...row };
      for (const restriction of linked.all({ id: row.id, username: row.username, cutoff: time - RETENTION_MS, time })) {
        if (roleRank(row.role) > roleRank(restriction.role)) continue;
        const column = restriction.kind === "ban" ? "banned_until" : "muted_until";
        if (restriction.until > result[column]) {
          result[column] = restriction.until;
          if (restriction.kind === "ban") result.ban_reason = null;
        }
      }
      return result;
    },
  };
}
