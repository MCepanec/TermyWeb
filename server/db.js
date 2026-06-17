import { DatabaseSync } from 'node:sqlite';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';
import * as DB from './db.js';

const __dir = dirname(fileURLToPath(import.meta.url));
const db = new DatabaseSync(
  join(__dir, '../securechat.db'));

db.exec(`PRAGMA journal_mode = WAL`);
db.exec(`PRAGMA foreign_keys = ON`);

db.exec(`

  CREATE TABLE IF NOT EXISTS sessions (
    token      TEXT    PRIMARY KEY,
    user_id    INTEGER NOT NULL REFERENCES users(id),
    created_at INTEGER NOT NULL,
    last_seen  INTEGER NOT NULL,
    expires_at INTEGER NOT NULL
  );

  CREATE TABLE IF NOT EXISTS users (
    id            INTEGER PRIMARY KEY AUTOINCREMENT,
    username      TEXT    UNIQUE NOT NULL,
    password_hash TEXT    NOT NULL,
    public_key    TEXT,
    created_at    DATETIME DEFAULT CURRENT_TIMESTAMP
  );

  CREATE TABLE IF NOT EXISTS friends (
    user_id   INTEGER NOT NULL REFERENCES users(id),
    friend_id INTEGER NOT NULL REFERENCES users(id),
    PRIMARY KEY(user_id, friend_id)
  );

  CREATE TABLE IF NOT EXISTS friend_requests (
    id         INTEGER PRIMARY KEY AUTOINCREMENT,
    from_id    INTEGER NOT NULL REFERENCES users(id),
    to_id      INTEGER NOT NULL REFERENCES users(id),
    status     TEXT NOT NULL DEFAULT 'pending',
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
    UNIQUE(from_id, to_id)
  );

  CREATE TABLE IF NOT EXISTS messages (
    id                INTEGER PRIMARY KEY AUTOINCREMENT,
    from_id           INTEGER NOT NULL REFERENCES users(id),
    to_id             INTEGER NOT NULL REFERENCES users(id),
    ciphertext        TEXT    NOT NULL,
    nonce             TEXT    NOT NULL,
    ephemeral_pub     TEXT    NOT NULL,
    self_ciphertext   TEXT,
    self_nonce        TEXT,
    self_ephemeral_pub TEXT,
    timestamp_unix    INTEGER NOT NULL,
    delivered         INTEGER NOT NULL DEFAULT 0
  );

  CREATE TABLE IF NOT EXISTS groups (
    id         INTEGER PRIMARY KEY AUTOINCREMENT,
    name       TEXT UNIQUE NOT NULL,
    creator_id INTEGER NOT NULL REFERENCES users(id),
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP
  );

  CREATE TABLE IF NOT EXISTS group_members (
    group_id INTEGER NOT NULL REFERENCES groups(id),
    user_id  INTEGER NOT NULL REFERENCES users(id),
    PRIMARY KEY(group_id, user_id)
  );

  CREATE TABLE IF NOT EXISTS group_messages (
    id            INTEGER PRIMARY KEY AUTOINCREMENT,
    group_id      INTEGER NOT NULL,
    from_id       INTEGER NOT NULL,
    from_username TEXT    NOT NULL,
    for_user_id   INTEGER NOT NULL,
    ciphertext    TEXT    NOT NULL,
    nonce         TEXT    NOT NULL,
    ephemeral_pub TEXT    NOT NULL,
    timestamp_unix INTEGER NOT NULL,
    delivered     INTEGER NOT NULL DEFAULT 0
  );

  CREATE TABLE IF NOT EXISTS file_transfers (
    transfer_id TEXT    PRIMARY KEY,
    sender_id   INTEGER NOT NULL,
    receiver_id INTEGER NOT NULL DEFAULT -1,
    group_id    INTEGER NOT NULL DEFAULT -1,
    filename    TEXT    NOT NULL,
    file_size   INTEGER NOT NULL,
    status      TEXT    NOT NULL DEFAULT 'pending'
  );

  CREATE TABLE IF NOT EXISTS offline_file_offers (
    id            INTEGER PRIMARY KEY AUTOINCREMENT,
    transfer_id   TEXT    NOT NULL,
    from_id       INTEGER NOT NULL,
    from_username TEXT    NOT NULL,
    filename      TEXT    NOT NULL,
    file_size     INTEGER NOT NULL,
    enc_key       TEXT    NOT NULL,
    for_user_id   INTEGER NOT NULL
  );

  CREATE TABLE IF NOT EXISTS vchats (
    id         INTEGER PRIMARY KEY AUTOINCREMENT,
    name       TEXT UNIQUE NOT NULL,
    creator_id INTEGER NOT NULL REFERENCES users(id)
  );

  CREATE TABLE IF NOT EXISTS vchat_members (
    vchat_id INTEGER NOT NULL REFERENCES vchats(id),
    user_id  INTEGER NOT NULL REFERENCES users(id),
    PRIMARY KEY(vchat_id, user_id)
  );
`);

// ── Helpers ────────────────────────────────────────────
const stmt = (sql) => db.prepare(sql);

// ── Sessions ───────────────────────────────────────────
const SESSION_TTL = 30 * 24 * 60 * 60; // 30 days (seconds)

export const createSession = (token, userId) => {
  const now     = Math.floor(Date.now() / 1000);
  const expires = now + SESSION_TTL;
  stmt(`INSERT INTO sessions
        (token, user_id, created_at,
         last_seen, expires_at)
        VALUES(?,?,?,?,?)`)
    .run(token, userId, now, now, expires);
};

export const getSession = (token) => {
  const now = Math.floor(Date.now() / 1000);
  return stmt(`SELECT s.*, u.username,
                        u.password_hash,
                        u.public_key
               FROM sessions s
               JOIN users u ON u.id = s.user_id
               WHERE s.token = ?
                 AND s.expires_at > ?`)
    .get(token, now);
};

export const refreshSession = (token) => {
  const now     = Math.floor(Date.now() / 1000);
  const expires = now + SESSION_TTL;
  stmt(`UPDATE sessions
        SET last_seen=?, expires_at=?
        WHERE token=?`)
    .run(now, expires, token);
};

export const deleteSession = (token) =>
  stmt('DELETE FROM sessions WHERE token=?')
    .run(token);

export const deleteUserSessions = (userId) =>
  stmt('DELETE FROM sessions WHERE user_id=?')
    .run(userId);

export const cleanExpiredSessions = () => {
  const now = Math.floor(Date.now() / 1000);
  stmt('DELETE FROM sessions WHERE expires_at < ?')
    .run(now);
};

// ── Users ──────────────────────────────────────────────
export const findUser = (username) =>
  stmt('SELECT * FROM users WHERE username=?')
    .get(username);

export const findUserById = (id) =>
  stmt('SELECT * FROM users WHERE id=?').get(id);

export const createUser = (username, hash) =>
  stmt('INSERT INTO users(username,password_hash) VALUES(?,?)')
    .run(username, hash);

export const setPublicKey = (id, pub) =>
  stmt('UPDATE users SET public_key=? WHERE id=?')
    .run(pub, id);

// ── Friends ────────────────────────────────────────────
export const sendFriendRequest = (fromId, toId) =>
  stmt(`INSERT OR IGNORE INTO friend_requests
        (from_id, to_id) VALUES(?,?)`)
    .run(fromId, toId);

export const getFriendRequests = (toId) =>
  stmt(`SELECT fr.id, fr.from_id, u.username
        FROM friend_requests fr
        JOIN users u ON u.id = fr.from_id
        WHERE fr.to_id = ? AND fr.status = 'pending'`)
    .all(toId);

export const acceptFriendRequest = (reqId, userId) => {
  const req = stmt(
    `SELECT * FROM friend_requests WHERE id=?`)
    .get(reqId);
  if (!req || req.to_id !== userId) return false;
  stmt(`UPDATE friend_requests SET status='accepted'
        WHERE id=?`).run(reqId);
  // Add mutual friendship
  stmt('INSERT OR IGNORE INTO friends VALUES(?,?)')
    .run(req.from_id, req.to_id);
  stmt('INSERT OR IGNORE INTO friends VALUES(?,?)')
    .run(req.to_id, req.from_id);
  return req;
};

export const declineFriendRequest = (reqId, userId) => {
  const req = stmt(
    `SELECT * FROM friend_requests WHERE id=?`)
    .get(reqId);
  if (!req || req.to_id !== userId) return false;
  stmt(`UPDATE friend_requests SET status='declined'
        WHERE id=?`).run(reqId);
  return true;
};

export const removeFriend = (uid, fid) => {
  stmt(`DELETE FROM friends
        WHERE (user_id=? AND friend_id=?)
           OR (user_id=? AND friend_id=?)`)
    .run(uid, fid, fid, uid);
};

export const areFriends = (uid, fid) =>
  !!stmt(`SELECT 1 FROM friends
          WHERE user_id=? AND friend_id=?`)
    .get(uid, fid);

export const hasPendingRequest = (fromId, toId) =>
  !!stmt(`SELECT 1 FROM friend_requests
          WHERE from_id=? AND to_id=?
          AND status='pending'`)
    .get(fromId, toId);

export const addFriend = (uid, fid) => {
  stmt('INSERT OR IGNORE INTO friends VALUES(?,?)')
    .run(uid, fid);
  stmt('INSERT OR IGNORE INTO friends VALUES(?,?)')
    .run(fid, uid);
};

export const getFriends = (uid) =>
  stmt(`SELECT u.id, u.username, u.public_key
        FROM users u
        JOIN friends f ON f.friend_id = u.id
        WHERE f.user_id = ?`).all(uid);

// ── Messages ───────────────────────────────────────────
export const storeMessage = (
    from, to, ct, nonce, ephem, ts,
    selfCt, selfNonce, selfEphem) =>
  stmt(`INSERT INTO messages
        (from_id, to_id, ciphertext, nonce,
         ephemeral_pub, self_ciphertext,
         self_nonce, self_ephemeral_pub,
         timestamp_unix)
        VALUES(?,?,?,?,?,?,?,?,?)`)
    .run(from, to, ct, nonce, ephem,
         selfCt ?? null, selfNonce ?? null,
         selfEphem ?? null, ts);

export const markSpecificMessagesDelivered =
    (toId, fromId) =>
  stmt(`UPDATE messages SET delivered=1
        WHERE to_id=? AND from_id=?
          AND delivered=0`)
    .run(toId, fromId);

export const getOfflineMessages = (uid) =>
  stmt(`SELECT m.*, u.username as from_username
        FROM messages m
        JOIN users u ON u.id = m.from_id
        WHERE m.to_id = ?
        ORDER BY m.timestamp_unix ASC`).all(uid);

export const getUnreadDMCounts = (uid) =>
  stmt(`SELECT from_id, COUNT(*) as count,
               u.username as from_username
        FROM messages m
        JOIN users u ON u.id = m.from_id
        WHERE m.to_id = ?
          AND m.delivered = 0
        GROUP BY m.from_id`)
    .all(uid);

export const getUnreadGroupCounts = (uid) =>
  stmt(`SELECT gm.group_id,
               COUNT(*) as count,
               g.name as group_name
        FROM group_messages gm
        JOIN groups g ON g.id = gm.group_id
        WHERE gm.for_user_id = ?
          AND gm.delivered = 0
        GROUP BY gm.group_id`)
    .all(uid);

export const getDMHistory = (uid1, uid2,
                              limit = 200) =>
  stmt(`SELECT m.*,
               u.username as from_username
        FROM messages m
        JOIN users u ON u.id = m.from_id
        WHERE (m.from_id=? AND m.to_id=?)
           OR (m.from_id=? AND m.to_id=?)
        ORDER BY m.timestamp_unix ASC
        LIMIT ?`)
    .all(uid1, uid2, uid2, uid1, limit);

export const getGroupHistory = (gid, uid, limit = 200) =>
  stmt(`SELECT DISTINCT m.group_id, m.from_id,
               m.from_username, m.ciphertext,
               m.nonce, m.ephemeral_pub,
               m.timestamp_unix
        FROM group_messages m
        WHERE m.group_id=? AND m.for_user_id=?
        ORDER BY m.timestamp_unix ASC
        LIMIT ?`).all(gid, uid, limit);

// ── Groups ─────────────────────────────────────────────
export const createGroup = (name, creatorId) => {
  const r = stmt(
    'INSERT INTO groups(name,creator_id) VALUES(?,?)')
    .run(name, creatorId);
  stmt('INSERT OR IGNORE INTO group_members VALUES(?,?)')
    .run(r.lastInsertRowid, creatorId);
  return r.lastInsertRowid;
};

export const deleteGroup = (gid) => {
  stmt('DELETE FROM group_members WHERE group_id=?').run(gid);
  stmt('DELETE FROM group_messages WHERE group_id=?').run(gid);
  stmt('DELETE FROM groups WHERE id=?').run(gid);
};

export const getGroup = (id) =>
  stmt('SELECT * FROM groups WHERE id=?').get(id);

export const getGroupByName = (name) =>
  stmt('SELECT * FROM groups WHERE name=?').get(name);

export const getGroupsForUser = (uid) =>
  stmt(`SELECT g.* FROM groups g
        JOIN group_members m ON m.group_id = g.id
        WHERE m.user_id = ?
        ORDER BY g.name`).all(uid);

export const getGroupMembers = (gid) =>
  stmt(`SELECT u.id, u.username, u.public_key
        FROM users u
        JOIN group_members m ON m.user_id = u.id
        WHERE m.group_id = ?`).all(gid);

export const isGroupMember = (gid, uid) =>
  !!stmt(`SELECT 1 FROM group_members
          WHERE group_id=? AND user_id=?`).get(gid, uid);

export const addGroupMember = (gid, uid) =>
  stmt('INSERT OR IGNORE INTO group_members VALUES(?,?)')
    .run(gid, uid);

export const removeGroupMember = (gid, uid) =>
  stmt(`DELETE FROM group_members
        WHERE group_id=? AND user_id=?`).run(gid, uid);

export const storeGroupMessage = (gid, fromId,
    fromUser, forUid, ct, nonce, ephem, ts) =>
  stmt(`INSERT INTO group_messages
        (group_id,from_id,from_username,for_user_id,
         ciphertext,nonce,ephemeral_pub,timestamp_unix)
        VALUES(?,?,?,?,?,?,?,?)`)
    .run(gid, fromId, fromUser, forUid,
         ct, nonce, ephem, ts);

export const markGroupMessagesDelivered = (uid) =>
  stmt(`UPDATE group_messages SET delivered=1
        WHERE for_user_id=? AND delivered=0`).run(uid);

export const getGroupOfflineMessages = (uid) =>
  stmt(`SELECT * FROM group_messages
        WHERE for_user_id=?
        ORDER BY timestamp_unix ASC`).all(uid);

// ── File transfers ─────────────────────────────────────
export const isFileReferenced = (url) => {
  // Check DM messages (file shares stored as JSON
  // in ciphertext with nonce='file')
  const inDMs = stmt(`
    SELECT 1 FROM messages
    WHERE nonce='file'
      AND ciphertext LIKE ?
    LIMIT 1
  `).get(`%${url}%`);
  if (inDMs) return true;

  // Check group messages
  const inGroups = stmt(`
    SELECT 1 FROM group_messages
    WHERE nonce='file'
      AND ciphertext LIKE ?
    LIMIT 1
  `).get(`%${url}%`);
  if (inGroups) return true;

  return false;
};

export const createFileTransfer = (tid, senderId,
    receiverId, groupId, filename, size) =>
  stmt(`INSERT INTO file_transfers VALUES(?,?,?,?,?,?,?)`)
    .run(tid, senderId, receiverId, groupId,
         filename, size, 'pending');

export const getFileTransfer = (tid) =>
  stmt(`SELECT * FROM file_transfers
        WHERE transfer_id=?`).get(tid);

export const updateFileTransferStatus = (tid, status) =>
  stmt(`UPDATE file_transfers SET status=?
        WHERE transfer_id=?`).run(status, tid);

export const deleteFileTransfer = (tid) =>
  stmt('DELETE FROM file_transfers WHERE transfer_id=?')
    .run(tid);

export const storeOfflineFileOffer = (tid, fromId,
    fromUser, filename, size, encKey, forUid) =>
  stmt(`INSERT INTO offline_file_offers
        (transfer_id,from_id,from_username,filename,
         file_size,enc_key,for_user_id)
        VALUES(?,?,?,?,?,?,?)`)
    .run(tid, fromId, fromUser, filename,
         size, encKey, forUid);

export const getOfflineFileOffers = (uid) =>
  stmt(`SELECT * FROM offline_file_offers
        WHERE for_user_id=?`).all(uid);

export const deleteOfflineFileOffers = (uid) =>
  stmt(`DELETE FROM offline_file_offers
        WHERE for_user_id=?`).run(uid);

// ── Voice chats ────────────────────────────────────────
export const createVChat = (name, creatorId) => {
  const r = stmt(
    'INSERT INTO vchats(name,creator_id) VALUES(?,?)')
    .run(name, creatorId);
  stmt('INSERT OR IGNORE INTO vchat_members VALUES(?,?)')
    .run(r.lastInsertRowid, creatorId);
  return r.lastInsertRowid;
};

export const getVChat = (id) =>
  stmt('SELECT * FROM vchats WHERE id=?').get(id);

export const getVChatByName = (name) =>
  stmt('SELECT * FROM vchats WHERE name=?').get(name);

export const getVChatsForUser = (uid) =>
  stmt(`SELECT v.* FROM vchats v
        JOIN vchat_members m ON m.vchat_id = v.id
        WHERE m.user_id = ?
        ORDER BY v.name`).all(uid);

export const isVChatMember = (vid, uid) =>
  !!stmt(`SELECT 1 FROM vchat_members
          WHERE vchat_id=? AND user_id=?`).get(vid, uid);

export const addVChatMember = (vid, uid) =>
  stmt('INSERT OR IGNORE INTO vchat_members VALUES(?,?)')
    .run(vid, uid);

export const removeVChatMember = (vid, uid) =>
  stmt(`DELETE FROM vchat_members
        WHERE vchat_id=? AND user_id=?`).run(vid, uid);

export const getVChatMembers = (vid) =>
  stmt(`SELECT u.id, u.username FROM users u
        JOIN vchat_members m ON m.user_id = u.id
        WHERE m.vchat_id = ?`).all(vid);

export const deleteVChat = (vid) => {
  stmt('DELETE FROM vchat_members WHERE vchat_id=?')
    .run(vid);
  stmt('DELETE FROM vchats WHERE id=?').run(vid);
};

export default db;