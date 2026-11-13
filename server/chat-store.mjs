import fs from "fs";
import path from "path";
import { Database } from "bun:sqlite";
import { CHAT_REACTION_FACES, conversationIdOf, conversationKey, isConversationKey } from "../src/features/chat/chatProtocol.ts";
import { mentionsName } from "../src/features/chat/chatText.ts";

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
    notice TEXT,
    party TEXT
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
  CREATE TABLE IF NOT EXISTS chat_conversations (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    kind TEXT NOT NULL,
    name TEXT,
    owner_id INTEGER,
    dm_key TEXT UNIQUE,
    created_at INTEGER NOT NULL,
    last_message_at INTEGER NOT NULL
  );
  CREATE TABLE IF NOT EXISTS chat_conversation_members (
    conversation_id INTEGER NOT NULL REFERENCES chat_conversations(id) ON DELETE CASCADE,
    user_id INTEGER NOT NULL REFERENCES chat_users(id) ON DELETE CASCADE,
    joined_at INTEGER NOT NULL,
    last_read_id INTEGER NOT NULL DEFAULT 0,
    hidden INTEGER NOT NULL DEFAULT 0,
    PRIMARY KEY (conversation_id, user_id)
  );
  CREATE INDEX IF NOT EXISTS idx_chat_conversation_members_user ON chat_conversation_members(user_id);
`;

const MESSAGE_COLUMNS = `
  m.id, m.channel, m.user_id, m.text, m.created_at, m.edited_at,
  m.reply_id, m.reply_user_id, m.reply_name, m.reply_text, m.notice, m.party, u.username, u.role, p.display, p.avatar_hash,
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
  if (!db.query("SELECT 1 FROM pragma_table_info('chat_messages') WHERE name = 'party'").get()) {
    db.exec("ALTER TABLE chat_messages ADD COLUMN party TEXT");
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
      `INSERT INTO chat_messages (channel, user_id, text, created_at, reply_id, reply_user_id, reply_name, reply_text, notice, party)
        VALUES ($channel, $userId, $text, $time, $replyId, $replyUserId, $replyName, $replyText, $notice, $party) RETURNING id`,
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
    searchUsers: db.query(
      `SELECT ${USER_COLUMNS} FROM ${USER_SOURCE} WHERE u.id != $viewerId AND u.banned_until <= $time
        AND (u.username LIKE $pattern ESCAPE '\\' OR p.display LIKE $pattern ESCAPE '\\') ORDER BY u.last_seen DESC, u.id LIMIT $limit`,
    ),
    conversationInfo: db.query("SELECT id, kind, name, owner_id FROM chat_conversations WHERE id = $id"),
    conversation: db.query(
      `SELECT c.*, m.last_read_id, m.hidden FROM chat_conversations c
        JOIN chat_conversation_members m ON m.conversation_id = c.id AND m.user_id = $userId WHERE c.id = $id`,
    ),
    userConversations: db.query(
      `SELECT c.*, m.last_read_id, m.hidden FROM chat_conversation_members m JOIN chat_conversations c ON c.id = m.conversation_id
        WHERE m.user_id = $userId AND m.hidden = 0 ORDER BY c.last_message_at DESC, c.id DESC`,
    ),
    conversationMembers: db.query(
      `SELECT ${USER_COLUMNS} FROM chat_conversation_members cm JOIN chat_users u ON u.id = cm.user_id
        LEFT JOIN chat_profiles p ON p.user_id = u.id WHERE cm.conversation_id = $id ORDER BY cm.joined_at, cm.rowid`,
    ),
    memberIds: db.query("SELECT user_id FROM chat_conversation_members WHERE conversation_id = $id ORDER BY joined_at, rowid"),
    hiddenMembers: db.query("SELECT user_id FROM chat_conversation_members WHERE conversation_id = $id AND hidden = 1"),
    memberships: db.query(
      "SELECT c.id, c.kind FROM chat_conversation_members m JOIN chat_conversations c ON c.id = m.conversation_id WHERE m.user_id = $userId",
    ),
    groupCount: db.query(
      `SELECT COUNT(*) AS count FROM chat_conversation_members m JOIN chat_conversations c ON c.id = m.conversation_id
        WHERE m.user_id = $userId AND c.kind = 'group'`,
    ),
    lastMessage: db.query(
      `SELECT m.id, m.user_id, m.text, m.party, a.type AS attachment_type, u.username, p.display FROM chat_messages m
        JOIN chat_users u ON u.id = m.user_id LEFT JOIN chat_profiles p ON p.user_id = m.user_id
        LEFT JOIN chat_attachments a ON a.message_id = m.id WHERE m.channel = $channel AND m.notice IS NULL ORDER BY m.id DESC LIMIT 1`,
    ),
    unread: db.query(
      "SELECT COUNT(*) AS count FROM chat_messages WHERE channel = $channel AND id > $after AND user_id != $userId AND notice IS NULL",
    ),
    unreadMentions: db.query(
      `SELECT text, reply_user_id FROM chat_messages WHERE channel = $channel AND id > $after AND user_id != $userId AND notice IS NULL
        AND (reply_user_id = $userId OR instr(lower(text), $handle) > 0) ORDER BY id DESC LIMIT 50`,
    ),
    latestId: db.query("SELECT COALESCE(MAX(id), 0) AS id FROM chat_messages WHERE channel = $channel"),
    dmByKey: db.query("SELECT id FROM chat_conversations WHERE dm_key = $key"),
    insertConversation: db.query(
      `INSERT INTO chat_conversations (kind, name, owner_id, dm_key, created_at, last_message_at)
        VALUES ($kind, $name, $ownerId, $dmKey, $time, $time) RETURNING id`,
    ),
    insertMember: db.query(
      `INSERT OR IGNORE INTO chat_conversation_members (conversation_id, user_id, joined_at, last_read_id)
        VALUES ($id, $userId, $time, $lastRead)`,
    ),
    removeMember: db.query("DELETE FROM chat_conversation_members WHERE conversation_id = $id AND user_id = $userId"),
    oldestMember: db.query("SELECT user_id FROM chat_conversation_members WHERE conversation_id = $id ORDER BY joined_at, rowid LIMIT 1"),
    setOwner: db.query("UPDATE chat_conversations SET owner_id = $ownerId WHERE id = $id"),
    setHidden: db.query(
      "UPDATE chat_conversation_members SET hidden = $hidden WHERE conversation_id = $id AND user_id = $userId AND hidden != $hidden",
    ),
    unhideMembers: db.query("UPDATE chat_conversation_members SET hidden = 0 WHERE conversation_id = $id AND hidden = 1"),
    touchConversation: db.query("UPDATE chat_conversations SET last_message_at = MAX(last_message_at, $time) WHERE id = $id"),
    renameConversation: db.query("UPDATE chat_conversations SET name = $name WHERE id = $id"),
    markRead: db.query(
      "UPDATE chat_conversation_members SET last_read_id = $messageId WHERE conversation_id = $id AND user_id = $userId AND last_read_id < $messageId",
    ),
    dropChannel: db.query("DELETE FROM chat_messages WHERE channel = $channel"),
    dropConversation: db.query("DELETE FROM chat_conversations WHERE id = $id"),
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
      ...(row.party && { party: JSON.parse(row.party) }),
    }));
  }

  function dropConversation(id) {
    statements.dropChannel.run({ channel: conversationKey(id) });
    statements.dropConversation.run({ id });
  }

  function leaveGroup(id, userId) {
    statements.removeMember.run({ id, userId });
    const next = statements.oldestMember.get({ id });
    if (!next) {
      dropConversation(id);
      return { deleted: true };
    }
    if (statements.conversationInfo.get({ id })?.owner_id === userId) statements.setOwner.run({ id, ownerId: next.user_id });
    return { deleted: false };
  }

  function mentionedIn(channel, after, userId) {
    const username = statements.user.get({ id: userId })?.username;
    if (!username) return false;
    return statements.unreadMentions
      .all({ channel, after, userId, handle: `@${username.toLowerCase()}` })
      .some((message) => message.reply_user_id === userId || mentionsName(message.text, username));
  }

  function conversationOf(row, userId) {
    const channel = conversationKey(row.id);
    const unread = statements.unread.get({ channel, after: row.last_read_id, userId }).count;
    return {
      id: row.id,
      kind: row.kind,
      name: row.name,
      owner: row.owner_id,
      createdAt: row.created_at,
      lastAt: row.last_message_at,
      hidden: !!row.hidden,
      members: statements.conversationMembers.all({ id: row.id }),
      last: statements.lastMessage.get({ channel }) ?? null,
      unread,
      mentioned: unread > 0 && row.kind === "group" && mentionedIn(channel, row.last_read_id, userId),
    };
  }

  const openDm = db.transaction(({ userId, targetId, time }) => {
    const dmKey = `${Math.min(userId, targetId)}:${Math.max(userId, targetId)}`;
    const existing = statements.dmByKey.get({ key: dmKey });
    if (existing) {
      const { changes } = statements.setHidden.run({ id: existing.id, userId, hidden: 0 });
      return { id: existing.id, created: false, unhidden: changes > 0 };
    }
    const { id } = statements.insertConversation.get({ kind: "dm", name: null, ownerId: null, dmKey, time });
    statements.insertMember.run({ id, userId, time, lastRead: 0 });
    statements.insertMember.run({ id, userId: targetId, time, lastRead: 0 });
    return { id, created: true, unhidden: false };
  });

  const createGroup = db.transaction(({ ownerId, name, memberIds, time }) => {
    const { id } = statements.insertConversation.get({ kind: "group", name: name || null, ownerId, dmKey: null, time });
    for (const userId of [ownerId, ...memberIds]) statements.insertMember.run({ id, userId, time, lastRead: 0 });
    return id;
  });

  const addMembers = db.transaction(({ id, userIds, time }) => {
    const lastRead = statements.latestId.get({ channel: conversationKey(id) }).id;
    for (const userId of userIds) statements.insertMember.run({ id, userId, time, lastRead });
  });

  const leaveConversation = db.transaction(({ id, userId }) => leaveGroup(id, userId));

  const markRead = db.transaction(({ id, userId, messageId }) => {
    const latest = statements.latestId.get({ channel: conversationKey(id) }).id;
    const next = Math.min(messageId, latest);
    return next > 0 && statements.markRead.run({ id, userId, messageId: next }).changes > 0 ? next : 0;
  });

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
      for (const conversation of statements.memberships.all({ userId: id })) {
        if (conversation.kind === "dm") dropConversation(conversation.id);
        else leaveGroup(conversation.id, id);
      }
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
      party: message.party ? JSON.stringify(message.party) : null,
    });
    if (message.attachment) statements.putAttachment.run({ id, ...message.attachment });
    if (isConversationKey(message.channel)) {
      const conversation = conversationIdOf(message.channel);
      statements.touchConversation.run({ id: conversation, time: message.time });
      if (!message.notice) statements.unhideMembers.run({ id: conversation });
    }
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
    searchUsers: (query, viewerId, time, limit) =>
      statements.searchUsers.all({ viewerId, time, limit, pattern: `${query.replace(/[\\%_]/g, "\\$&")}%` }),
    conversationInfo: (id) => statements.conversationInfo.get({ id }) ?? null,
    conversation: (id, userId) => {
      const row = statements.conversation.get({ id, userId });
      return row ? conversationOf(row, userId) : null;
    },
    conversations: (userId) => statements.userConversations.all({ userId }).map((row) => conversationOf(row, userId)),
    memberIds: (id) => statements.memberIds.all({ id }).map((row) => row.user_id),
    hiddenMembers: (id) => statements.hiddenMembers.all({ id }).map((row) => row.user_id),
    memberships: (userId) =>
      statements.memberships.all({ userId }).map((row) => ({ ...row, members: statements.memberIds.all({ id: row.id }).map((entry) => entry.user_id) })),
    groupCount: (userId) => statements.groupCount.get({ userId }).count,
    openDm: (userId, targetId, time) => openDm({ userId, targetId, time }),
    createGroup: (ownerId, name, memberIds, time) => createGroup({ ownerId, name, memberIds, time }),
    addMembers: (id, userIds, time) => addMembers({ id, userIds, time }),
    leaveGroup: (id, userId) => leaveConversation({ id, userId }),
    hideConversation: (id, userId) => statements.setHidden.run({ id, userId, hidden: 1 }).changes > 0,
    renameConversation: (id, name) => statements.renameConversation.run({ id, name: name || null }),
    markRead: (id, userId, messageId) => markRead({ id, userId, messageId }),
    close: () => db.close(),
  };
}
