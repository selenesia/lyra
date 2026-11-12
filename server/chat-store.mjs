import fs from "fs";
import path from "path";
import { Database } from "bun:sqlite";
import { CHAT_REACTION_FACES } from "../src/features/chat/chatProtocol.ts";

export const PERMANENT = 8_640_000_000_000_000;

export function chatDatabasePath(root) {
  return process.env.LYRA_CHAT_DB || path.join(root, "data", "chat.db");
}

const SCHEMA = `
  CREATE TABLE IF NOT EXISTS chat_users (
    id INTEGER PRIMARY KEY,
    username TEXT NOT NULL,
    role TEXT NOT NULL DEFAULT 'member',
    joined_at INTEGER NOT NULL,
    account_created_at INTEGER,
    last_seen INTEGER NOT NULL,
    muted_until INTEGER NOT NULL DEFAULT 0,
    banned_until INTEGER NOT NULL DEFAULT 0,
    ban_reason TEXT,
    strike_points INTEGER NOT NULL DEFAULT 0,
    strike_updated INTEGER NOT NULL DEFAULT 0,
    mute_count INTEGER NOT NULL DEFAULT 0
  );
  CREATE INDEX IF NOT EXISTS idx_chat_users_username ON chat_users(username COLLATE NOCASE);
  CREATE TABLE IF NOT EXISTS chat_messages (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    channel TEXT NOT NULL,
    user_id INTEGER NOT NULL REFERENCES chat_users(id) ON DELETE CASCADE,
    text TEXT NOT NULL,
    created_at INTEGER NOT NULL,
    edited_at INTEGER,
    reply_id INTEGER,
    reply_user_id INTEGER,
    reply_name TEXT,
    reply_text TEXT,
    notice TEXT
  );
  CREATE INDEX IF NOT EXISTS idx_chat_messages_channel ON chat_messages(channel, id);
  CREATE INDEX IF NOT EXISTS idx_chat_messages_user ON chat_messages(user_id, created_at);
  CREATE TABLE IF NOT EXISTS chat_attachments (
    message_id INTEGER PRIMARY KEY REFERENCES chat_messages(id) ON DELETE CASCADE,
    type TEXT NOT NULL,
    width INTEGER NOT NULL,
    height INTEGER NOT NULL,
    hash TEXT NOT NULL,
    bytes BLOB NOT NULL
  );
  CREATE TABLE IF NOT EXISTS chat_reactions (
    message_id INTEGER NOT NULL REFERENCES chat_messages(id) ON DELETE CASCADE,
    user_id INTEGER NOT NULL,
    emoji TEXT NOT NULL,
    created_at INTEGER NOT NULL,
    PRIMARY KEY (message_id, user_id, emoji)
  );
  CREATE TABLE IF NOT EXISTS chat_profiles (
    user_id INTEGER PRIMARY KEY REFERENCES chat_users(id) ON DELETE CASCADE,
    display TEXT,
    pronouns TEXT,
    status TEXT,
    bio TEXT,
    accent TEXT,
    avatar_hash TEXT,
    banner_hash TEXT,
    updated_at INTEGER NOT NULL
  );
  CREATE TABLE IF NOT EXISTS chat_media (
    user_id INTEGER NOT NULL REFERENCES chat_users(id) ON DELETE CASCADE,
    kind TEXT NOT NULL,
    type TEXT NOT NULL,
    hash TEXT NOT NULL,
    bytes BLOB NOT NULL,
    PRIMARY KEY (user_id, kind)
  );
  CREATE TABLE IF NOT EXISTS chat_audit (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    at INTEGER NOT NULL,
    actor_id INTEGER,
    action TEXT NOT NULL,
    target_id INTEGER,
    detail TEXT
  );
`;

const MESSAGE_COLUMNS = `
  m.id, m.channel, m.user_id, m.text, m.created_at, m.edited_at,
  m.reply_id, m.reply_user_id, m.reply_name, m.reply_text, m.notice, u.username, u.role, p.display, p.avatar_hash,
  a.type AS attachment_type, a.width AS attachment_width, a.height AS attachment_height
`;
const MESSAGE_SOURCE = "chat_messages m JOIN chat_users u ON u.id = m.user_id LEFT JOIN chat_profiles p ON p.user_id = m.user_id LEFT JOIN chat_attachments a ON a.message_id = m.id";
const USER_COLUMNS = "u.*, p.display, p.pronouns, p.status, p.bio, p.accent, p.avatar_hash, p.banner_hash";
const USER_SOURCE = "chat_users u LEFT JOIN chat_profiles p ON p.user_id = u.id";
const PROFILE_FIELDS = ["display", "pronouns", "status", "bio", "accent"];

export function createChatStore(file) {
  if (file !== ":memory:") {
    fs.mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
  }
  const db = new Database(file, { create: true, strict: true });
  db.exec("PRAGMA journal_mode = WAL; PRAGMA synchronous = NORMAL; PRAGMA foreign_keys = ON; PRAGMA busy_timeout = 5000;");
  db.exec(SCHEMA);
  if (!db.query("SELECT 1 FROM pragma_table_info('chat_users') WHERE name = 'account_created_at'").get()) {
    db.exec("ALTER TABLE chat_users ADD COLUMN account_created_at INTEGER");
  }
  if (!db.query("SELECT 1 FROM pragma_table_info('chat_messages') WHERE name = 'notice'").get()) {
    db.exec("ALTER TABLE chat_messages ADD COLUMN notice TEXT");
  }
  if (file !== ":memory:") fs.chmodSync(file, 0o600);

  const statements = {
    user: db.query(`SELECT ${USER_COLUMNS} FROM ${USER_SOURCE} WHERE u.id = $id`),
    userByName: db.query(
      `SELECT ${USER_COLUMNS} FROM ${USER_SOURCE} WHERE u.username = $username COLLATE NOCASE ORDER BY u.last_seen DESC LIMIT 1`,
    ),
    ensureProfile: db.query("INSERT OR IGNORE INTO chat_profiles (user_id, updated_at) VALUES ($id, $time)"),
    setProfile: db.query(
      `UPDATE chat_profiles SET display = $display, pronouns = $pronouns, status = $status, bio = $bio, accent = $accent,
        updated_at = $time WHERE user_id = $id`,
    ),
    setAvatarHash: db.query("UPDATE chat_profiles SET avatar_hash = $hash, updated_at = $time WHERE user_id = $id"),
    setBannerHash: db.query("UPDATE chat_profiles SET banner_hash = $hash, updated_at = $time WHERE user_id = $id"),
    dropProfile: db.query("DELETE FROM chat_profiles WHERE user_id = $id"),
    dropMedia: db.query("DELETE FROM chat_media WHERE user_id = $id"),
    putMedia: db.query(
      `INSERT INTO chat_media (user_id, kind, type, hash, bytes) VALUES ($id, $kind, $type, $hash, $bytes)
        ON CONFLICT (user_id, kind) DO UPDATE SET type = excluded.type, hash = excluded.hash, bytes = excluded.bytes`,
    ),
    removeMedia: db.query("DELETE FROM chat_media WHERE user_id = $id AND kind = $kind"),
    media: db.query("SELECT type, hash, bytes FROM chat_media WHERE user_id = $id AND kind = $kind"),
    attachment: db.query("SELECT type, hash, bytes FROM chat_attachments WHERE message_id = $id"),
    putAttachment: db.query("INSERT INTO chat_attachments (message_id, type, width, height, hash, bytes) VALUES ($id, $type, $width, $height, $hash, $bytes)"),
    insertUser: db.query(
      "INSERT INTO chat_users (id, username, joined_at, last_seen) VALUES ($id, $username, $time, $time)",
    ),
    seen: db.query("UPDATE chat_users SET last_seen = $time WHERE id = $id"),
    setAccountCreated: db.query("UPDATE chat_users SET account_created_at = $createdAt WHERE id = $id"),
    resetUser: db.query(
      `UPDATE chat_users SET username = $username, role = 'member', joined_at = $time, last_seen = $time,
        muted_until = 0, banned_until = 0, ban_reason = NULL, strike_points = 0, strike_updated = 0, mute_count = 0
        WHERE id = $id`,
    ),
    dropMessages: db.query("DELETE FROM chat_messages WHERE user_id = $id"),
    setRole: db.query("UPDATE chat_users SET role = $role WHERE id = $id"),
    setMute: db.query("UPDATE chat_users SET muted_until = $until WHERE id = $id"),
    setBan: db.query("UPDATE chat_users SET banned_until = $until, ban_reason = $reason WHERE id = $id"),
    setStrikes: db.query(
      "UPDATE chat_users SET strike_points = $points, strike_updated = $updated, mute_count = $mutes, muted_until = $mutedUntil WHERE id = $id",
    ),
    staff: db.query(`SELECT ${USER_COLUMNS} FROM ${USER_SOURCE} WHERE u.role != 'member' ORDER BY u.username COLLATE NOCASE`),
    insertMessage: db.query(
      `INSERT INTO chat_messages (channel, user_id, text, created_at, reply_id, reply_user_id, reply_name, reply_text, notice)
        VALUES ($channel, $userId, $text, $time, $replyId, $replyUserId, $replyName, $replyText, $notice) RETURNING id`,
    ),
    message: db.query(`SELECT ${MESSAGE_COLUMNS} FROM ${MESSAGE_SOURCE} WHERE m.id = $id`),
    recent: db.query(
      `SELECT * FROM (SELECT ${MESSAGE_COLUMNS} FROM ${MESSAGE_SOURCE}
        WHERE m.channel = $channel AND m.id < $before ORDER BY m.id DESC LIMIT $limit) ORDER BY id`,
    ),
    editMessage: db.query("UPDATE chat_messages SET text = $text, edited_at = $time WHERE id = $id"),
    deleteMessage: db.query("DELETE FROM chat_messages WHERE id = $id"),
    userMessagesSince: db.query("SELECT id, channel FROM chat_messages WHERE user_id = $id AND created_at >= $since AND notice IS NULL"),
    deleteUserMessagesSince: db.query("DELETE FROM chat_messages WHERE user_id = $id AND created_at >= $since AND notice IS NULL"),
    hasReaction: db.query("SELECT 1 FROM chat_reactions WHERE message_id = $id AND user_id = $userId AND emoji = $emoji"),
    addReaction: db.query(
      "INSERT INTO chat_reactions (message_id, user_id, emoji, created_at) VALUES ($id, $userId, $emoji, $time)",
    ),
    removeReaction: db.query("DELETE FROM chat_reactions WHERE message_id = $id AND user_id = $userId AND emoji = $emoji"),
    reactions: db.query(
      `SELECT r.message_id, r.user_id, r.emoji, u.username, p.display, p.avatar_hash FROM chat_reactions r
        LEFT JOIN chat_users u ON u.id = r.user_id LEFT JOIN chat_profiles p ON p.user_id = r.user_id
        WHERE r.message_id IN (SELECT value FROM json_each($ids)) ORDER BY r.created_at, r.rowid`,
    ),
    audit: db.query(
      "INSERT INTO chat_audit (at, actor_id, action, target_id, detail) VALUES ($time, $actorId, $action, $targetId, $detail)",
    ),
    auditLog: db.query(
      `SELECT a.*, actor.username AS actor_name, target.username AS target_name FROM chat_audit a
        LEFT JOIN chat_users actor ON actor.id = a.actor_id LEFT JOIN chat_users target ON target.id = a.target_id
        ORDER BY a.id DESC LIMIT $limit`,
    ),
  };

  function toMessages(rows) {
    if (!rows.length) return [];
    const reactions = new Map();
    const reactors = new Map();
    for (const row of statements.reactions.all({ ids: JSON.stringify(rows.map((message) => message.id)) })) {
      const byEmoji = reactions.get(row.message_id) ?? {};
      const authors = (byEmoji[row.emoji] ??= []);
      authors.push(String(row.user_id));
      reactions.set(row.message_id, byEmoji);
      if (authors.length > CHAT_REACTION_FACES || !row.username) continue;
      const faces = reactors.get(row.message_id) ?? {};
      faces[row.user_id] = {
        name: row.username,
        ...(row.display && { display: row.display }),
        ...(row.avatar_hash && { avatar: row.avatar_hash }),
      };
      reactors.set(row.message_id, faces);
    }
    return rows.map((row) => ({
      id: String(row.id),
      channel: row.channel,
      author: String(row.user_id),
      name: row.username,
      role: row.role,
      text: row.text,
      at: row.created_at,
      ...(row.attachment_type && { attachment: { type: row.attachment_type, width: row.attachment_width, height: row.attachment_height } }),
      ...(row.display && { display: row.display }),
      ...(row.avatar_hash && { avatar: row.avatar_hash }),
      ...(row.edited_at && { editedAt: row.edited_at }),
      ...(row.reply_id && {
        reply: { id: String(row.reply_id), author: String(row.reply_user_id), name: row.reply_name, text: row.reply_text },
      }),
      ...(reactions.has(row.id) && { reactions: reactions.get(row.id) }),
      ...(reactors.has(row.id) && { reactors: reactors.get(row.id) }),
      ...(row.notice && { notice: JSON.parse(row.notice) }),
    }));
  }

  const toggleReaction = db.transaction(({ id, userId, emoji, time }) => {
    if (statements.hasReaction.get({ id, userId, emoji })) statements.removeReaction.run({ id, userId, emoji });
    else statements.addReaction.run({ id, userId, emoji, time });
  });

  const purge = db.transaction(({ id, since }) => {
    const removed = statements.userMessagesSince.all({ id, since });
    statements.deleteUserMessagesSince.run({ id, since });
    return removed.map((row) => ({ id: String(row.id), channel: row.channel }));
  });

  const identify = db.transaction(({ id, username, createdAt, time }) => {
    const existing = statements.user.get({ id });
    if (!existing) {
      statements.insertUser.run({ id, username, time });
    } else if (existing.username !== username) {
      statements.dropMessages.run({ id });
      statements.dropProfile.run({ id });
      statements.dropMedia.run({ id });
      statements.resetUser.run({ id, username, time });
    } else {
      statements.seen.run({ id, time });
    }
    if (createdAt) statements.setAccountCreated.run({ id, createdAt });
    return statements.user.get({ id });
  });

  const updateProfile = db.transaction(({ id, fields, time }) => {
    statements.ensureProfile.run({ id, time });
    const current = statements.user.get({ id });
    const next = Object.fromEntries(PROFILE_FIELDS.map((field) => [field, current[field] ?? null]));
    for (const field of PROFILE_FIELDS) if (field in fields) next[field] = fields[field] || null;
    statements.setProfile.run({ id, time, ...next });
    for (const kind of ["avatar", "banner"]) {
      if (fields[kind] !== null) continue;
      statements.removeMedia.run({ id, kind });
      (kind === "avatar" ? statements.setAvatarHash : statements.setBannerHash).run({ id, hash: null, time });
    }
    return statements.user.get({ id });
  });

  const putMedia = db.transaction(({ id, kind, type, hash, bytes, time }) => {
    statements.ensureProfile.run({ id, time });
    statements.putMedia.run({ id, kind, type, hash, bytes });
    (kind === "avatar" ? statements.setAvatarHash : statements.setBannerHash).run({ id, hash, time });
    return statements.user.get({ id });
  });

  const clearProfile = db.transaction(({ id }) => {
    statements.dropProfile.run({ id });
    statements.dropMedia.run({ id });
    return statements.user.get({ id });
  });

  const insertMessage = db.transaction((message) => {
    const { id } = statements.insertMessage.get({
      channel: message.channel,
      userId: message.userId,
      text: message.text,
      time: message.time,
      replyId: message.reply?.id ?? null,
      replyUserId: message.reply?.userId ?? null,
      replyName: message.reply?.name ?? null,
      replyText: message.reply?.text ?? null,
      notice: message.notice ? JSON.stringify(message.notice) : null,
    });
    if (message.attachment) statements.putAttachment.run({ id, ...message.attachment });
    return id;
  });

  return {
    identify: (user, time) => identify({ id: user.id, username: user.username, createdAt: user.createdAt ?? null, time }),
    user: (id) => statements.user.get({ id }) ?? null,
    userByName: (username) => statements.userByName.get({ username }) ?? null,
    staff: () => statements.staff.all(),
    updateProfile: (id, fields, time) => updateProfile({ id, fields, time }),
    putMedia: (id, kind, media, time) => putMedia({ id, kind, ...media, time }),
    media: (id, kind) => statements.media.get({ id, kind }) ?? null,
    attachment: (id) => statements.attachment.get({ id }) ?? null,
    clearProfile: (id) => clearProfile({ id }),
    setRole: (id, role) => statements.setRole.run({ id, role }),
    setMute: (id, until) => statements.setMute.run({ id, until }),
    setBan: (id, until, reason) => statements.setBan.run({ id, until, reason: reason ?? null }),
    setStrikes: (id, { points, updated, mutes, mutedUntil }) =>
      statements.setStrikes.run({ id, points, updated, mutes, mutedUntil }),
    insertMessage,
    message: (id) => toMessages(statements.message.all({ id }))[0] ?? null,
    recent: (channel, limit, before = Number.MAX_SAFE_INTEGER) => toMessages(statements.recent.all({ channel, limit, before })),
    editMessage: (id, text, time) => statements.editMessage.run({ id, text, time }),
    deleteMessage: (id) => statements.deleteMessage.run({ id }),
    purge: (id, since) => purge({ id, since }),
    toggleReaction: (id, userId, emoji, time) => toggleReaction({ id, userId, emoji, time }),
    audit: (entry) =>
      statements.audit.run({
        time: entry.time,
        actorId: entry.actorId ?? null,
        action: entry.action,
        targetId: entry.targetId ?? null,
        detail: entry.detail ?? null,
      }),
    auditLog: (limit = 20) => statements.auditLog.all({ limit }),
    close: () => db.close(),
  };
}
