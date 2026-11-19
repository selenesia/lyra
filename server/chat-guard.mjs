import { createHmac, randomBytes, timingSafeEqual } from "crypto";
import { isIP } from "net";
import { roleRank } from "../src/features/chat/chatRoles.ts";

const COOKIE = "lyra_chat_browser";
const RETENTION_MS = 90 * 24 * 60 * 60_000;
const NETWORK_RETENTION_MS = 14 * 24 * 60 * 60_000;

export function clientNetwork(ip) {
  let address = String(ip || "").trim().replace(/^\[|\]$/g, "").replace(/%.*$/, "");
  const mapped = /^::ffff:(\d{1,3}(?:\.\d{1,3}){3})$/i.exec(address);
  if (mapped) address = mapped[1];
  const family = isIP(address);
  if (family === 4) return address.startsWith("127.") ? null : address;
  if (family !== 6) return null;
  const [head, tail = ""] = address.toLowerCase().split("::");
  const left = head ? head.split(":") : [];
  const right = address.includes("::") && tail ? tail.split(":") : [];
  if ([...left, ...right].some((part) => part.includes("."))) return null;
  const groups = [...left, ...Array(8 - left.length - right.length).fill("0"), ...right].map((part) => part.padStart(4, "0"));
  if (groups.slice(0, 7).every((part) => part === "0000") && groups[7] === "0001") return null;
  return `${groups.slice(0, 4).join(":")}::/64`;
}

export function createChatGuard(db) {
  db.exec(`
    CREATE TABLE IF NOT EXISTS chat_guard_secret (id INTEGER PRIMARY KEY CHECK (id = 1), secret TEXT NOT NULL);
    CREATE TABLE IF NOT EXISTS chat_browser_links (
      user_id INTEGER NOT NULL, username TEXT NOT NULL, browser TEXT NOT NULL, seen_at INTEGER NOT NULL,
      PRIMARY KEY (user_id, username, browser)
    );
    CREATE INDEX IF NOT EXISTS idx_chat_browser_links_browser ON chat_browser_links(browser);
    CREATE INDEX IF NOT EXISTS idx_chat_browser_links_seen ON chat_browser_links(seen_at);
    CREATE TABLE IF NOT EXISTS chat_network_links (
      user_id INTEGER NOT NULL, username TEXT NOT NULL, network TEXT NOT NULL, seen_at INTEGER NOT NULL,
      PRIMARY KEY (user_id, username, network)
    );
    CREATE INDEX IF NOT EXISTS idx_chat_network_links_network ON chat_network_links(network);
    CREATE INDEX IF NOT EXISTS idx_chat_network_links_seen ON chat_network_links(seen_at);
    CREATE TABLE IF NOT EXISTS chat_browser_restrictions (
      user_id INTEGER NOT NULL, username TEXT NOT NULL, kind TEXT NOT NULL, until INTEGER NOT NULL, role TEXT NOT NULL,
      since INTEGER,
      PRIMARY KEY (user_id, username, kind)
    );
  `);
  if (!db.query("SELECT 1 FROM pragma_table_info('chat_browser_restrictions') WHERE name = 'since'").get()) {
    db.exec("ALTER TABLE chat_browser_restrictions ADD COLUMN since INTEGER");
  }
  db.query("UPDATE chat_browser_restrictions SET since = $time WHERE since IS NULL").run({ time: Date.now() });
  db.query("INSERT OR IGNORE INTO chat_guard_secret VALUES (1, ?)").run(randomBytes(32).toString("hex"));
  const { secret } = db.query("SELECT secret FROM chat_guard_secret WHERE id = 1").get();
  const digest = (value) => createHmac("sha256", secret).update(value).digest("base64url");
  const link = db.query(`INSERT INTO chat_browser_links VALUES ($id, $username, $browser, $time)
    ON CONFLICT (user_id, username, browser) DO UPDATE SET seen_at = excluded.seen_at`);
  const linkNetwork = db.query(`INSERT INTO chat_network_links VALUES ($id, $username, $network, $time)
    ON CONFLICT (user_id, username, network) DO UPDATE SET seen_at = excluded.seen_at`);
  const pruneLinks = db.query("DELETE FROM chat_browser_links WHERE seen_at < $cutoff");
  const pruneNetworks = db.query("DELETE FROM chat_network_links WHERE seen_at < $cutoff");
  const pruneRestrictions = db.query("DELETE FROM chat_browser_restrictions WHERE until <= $time");
  const restrict = db.query(`INSERT INTO chat_browser_restrictions (user_id, username, kind, until, role, since)
    VALUES ($id, $username, $kind, $until, $role, $time)
    ON CONFLICT (user_id, username, kind) DO UPDATE SET
      since = CASE WHEN chat_browser_restrictions.until <= $time THEN excluded.since ELSE chat_browser_restrictions.since END,
      until = excluded.until, role = excluded.role`);
  const clear = db.query("DELETE FROM chat_browser_restrictions WHERE user_id = $id AND kind = $kind");
  const linked = db.query(`SELECT DISTINCT r.kind, r.until, r.role FROM chat_browser_links mine
    JOIN chat_browser_links source ON source.browser = mine.browser
    JOIN chat_browser_restrictions r ON r.user_id = source.user_id AND r.username = source.username
    WHERE mine.user_id = $id AND mine.username = $username AND mine.seen_at >= $cutoff
      AND source.seen_at >= $cutoff AND r.until > $time`);
  const networkLinked = db.query(`SELECT DISTINCT r.kind, r.until, r.role FROM chat_network_links mine
    JOIN chat_network_links source ON source.network = mine.network
    JOIN chat_browser_restrictions r ON r.user_id = source.user_id AND r.username = source.username
    WHERE mine.user_id = $id AND mine.username = $username AND mine.seen_at >= $cutoff
      AND source.seen_at >= $cutoff AND r.until > $time AND r.since < $created
      AND NOT (source.user_id = mine.user_id AND source.username = mine.username)`);
  let cleanedAt = -Infinity;

  return {
    browser(request, ip) {
      const cookies = (request.headers.get("cookie") || "").split(";");
      const value = cookies.find((part) => part.trim().startsWith(`${COOKIE}=`))?.trim().slice(COOKIE.length + 1);
      const match = /^([A-Za-z0-9_-]{43})\.([A-Za-z0-9_-]{43})$/.exec(value || "");
      const valid = match && timingSafeEqual(Buffer.from(match[2]), Buffer.from(digest(`cookie:${match[1]}`)));
      const network = clientNetwork(ip);
      return {
        token: valid ? match[1] : null,
        network: network && digest(`network:${network}`),
        secure: new URL(request.url).protocol === "https:" || request.headers.get("x-forwarded-proto") === "https",
        authenticated: false,
      };
    },
    observe(row, browser, time) {
      if (time - cleanedAt >= 60 * 60_000) {
        pruneLinks.run({ cutoff: time - RETENTION_MS });
        pruneNetworks.run({ cutoff: time - NETWORK_RETENTION_MS });
        pruneRestrictions.run({ time });
        cleanedAt = time;
      }
      const token = browser.token ?? digest(`identity:${row.id}:${row.username}`);
      link.run({ id: row.id, username: row.username, browser: digest(`browser:${token}`), time });
      if (browser.network) linkNetwork.run({ id: row.id, username: row.username, network: browser.network, time });
      browser.value = `${token}.${digest(`cookie:${token}`)}`;
      browser.cookie = `${COOKIE}=${browser.value}; Path=/api/chat; HttpOnly; SameSite=Strict; Max-Age=${RETENTION_MS / 1000}${browser.secure ? "; Secure" : ""}`;
      browser.authenticated = true;
    },
    restrict(row, kind, until, time) {
      if (!until) clear.run({ id: row.id, kind });
      else restrict.run({ id: row.id, username: row.username, kind, until, role: row.role, time });
    },
    apply(row, time) {
      const result = { ...row };
      const scope = { id: row.id, username: row.username, time };
      const restrictions = [
        ...linked.all({ ...scope, cutoff: time - RETENTION_MS }),
        ...networkLinked.all({ ...scope, cutoff: time - NETWORK_RETENTION_MS, created: row.account_created_at ?? row.joined_at ?? 0 }),
      ];
      for (const restriction of restrictions) {
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
