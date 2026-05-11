import { WebSocketServer } from 'ws';
import { v4 as uuid } from 'uuid';
import { hashPassword, verifyPassword } from './auth.js';
import * as db from './db.js';

// online: Map<userId, ws>
const online = new Map();
// activeVChats: Map<vchatId, Set<userId>>
const activeVChats = new Map();

const MAX_FILE_SIZE = 1024 * 1024 * 1024; // 1GB

function send(ws, msg) {
  if (ws.readyState === 1)
    ws.send(JSON.stringify(msg));
}

function broadcast(userIds, msg, excludeId = null) {
  for (const uid of userIds) {
    if (uid === excludeId) continue;
    const ws = online.get(uid);
    if (ws) send(ws, msg);
  }
}

export function setupWSS(server) {
  const wss = new WebSocketServer({ server });

  wss.on('connection', (ws) => {
    ws.userId   = null;
    ws.username = null;
    ws.authed   = false;

    ws.on('message', (raw) => {
      let msg;
      try { msg = JSON.parse(raw); }
      catch { return; }
      handleMessage(ws, msg);
    });

    ws.on('close', () => {
      if (!ws.authed || !ws.userId) return;
      online.delete(ws.userId);
      // Remove from active voice chats
      for (const [vid, members] of activeVChats)
        members.delete(ws.userId);
      // Broadcast offline presence to friends
      const friends = db.getFriends(ws.userId);
      broadcast(
        friends.map(f => f.id),
        { type: 'presence', userId: ws.userId,
          username: ws.username, online: false }
      );
    });
  });
}

async function handleMessage(ws, msg) {
  const { type } = msg;

  // ── Auth ──────────────────────────────────────────────
  if (type === 'register') {
    const { username, password, publicKey } = msg;
    if (!username || !password)
      return send(ws, { type: 'register_resp',
                         ok: false, msg: 'Missing fields' });
    if (db.findUser(username))
      return send(ws, { type: 'register_resp',
                         ok: false, msg: 'Username taken' });
    const hash = await hashPassword(password);
    db.createUser(username, hash);
    const user = db.findUser(username);
    if (publicKey) db.setPublicKey(user.id, publicKey);
    return send(ws, { type: 'register_resp',
                       ok: true, msg: 'Registered' });
  }

  if (type === 'login') {
    const { username, password, publicKey } = msg;
    const user = db.findUser(username);
    if (!user) return send(ws, {
      type: 'login_resp', ok: false,
      msg: 'Invalid credentials' });
    const valid = await verifyPassword(password, user.password_hash);
    if (!valid) return send(ws, {
      type: 'login_resp', ok: false,
      msg: 'Invalid credentials' });

    // Kick existing session
    const existing = online.get(user.id);
    if (existing) {
      send(existing, { type: 'kicked',
        msg: 'Logged in from another location' });
      existing.authed = false;
    }

    if (publicKey) db.setPublicKey(user.id, publicKey);
    ws.userId   = user.id;
    ws.username = user.username;
    ws.authed   = true;
    online.set(user.id, ws);

    send(ws, { type: 'login_resp', ok: true,
                userId: user.id,
                username: user.username });

    // Deliver offline messages
    deliverOffline(ws, user.id);

    // Broadcast online presence
    const friends = db.getFriends(user.id);
    broadcast(
      friends.map(f => f.id),
      { type: 'presence', userId: user.id,
        username: user.username, online: true }
    );
    return;
  }

  if (!ws.authed) return;

  // ── Friends ───────────────────────────────────────────
  if (type === 'friend_list') {
    const friends = db.getFriends(ws.userId).map(f => ({
      ...f, online: online.has(f.id)
    }));
    return send(ws, { type: 'friend_list_resp', friends });
  }

  if (type === 'add_friend') {
    const target = db.findUser(msg.username);
    if (!target) return send(ws, {
      type: 'add_friend_resp', ok: false,
      msg: 'User not found' });
    db.addFriend(ws.userId, target.id);
    return send(ws, { type: 'add_friend_resp',
                       ok: true, msg: 'Friend added' });
  }

  // ── DM ────────────────────────────────────────────────
  if (type === 'send_msg') {
    const { toId, ciphertext, nonce,
            ephemeralPub, timestamp } = msg;

    // Always store — needed for history
    db.storeMessage(ws.userId, toId,
      ciphertext, nonce, ephemeralPub, timestamp);

    // Deliver immediately if online
    const targetWs = online.get(toId);
    if (targetWs) {
      send(targetWs, {
        type: 'recv_msg',
        fromId:      ws.userId,
        fromUser:    ws.username,
        ciphertext, nonce, ephemeralPub, timestamp
      });
    }
    return send(ws, { type: 'msg_ack', ok: true });
  }

  if (type === 'dm_history') {
    const msgs = db.getDMHistory(
      ws.userId, msg.withId, 200);
    return send(ws, {
      type: 'dm_history_resp',
      withId: msg.withId,
      messages: msgs
    });
  }

  // ── Groups ────────────────────────────────────────────
  if (type === 'group_create') {
    const { name } = msg;
    if (!name || name.length < 2 || name.length > 32)
      return send(ws, { type: 'group_create_resp',
        ok: false, msg: 'Name must be 2-32 chars' });
    try {
      const id = db.createGroup(name, ws.userId);
      send(ws, { type: 'group_create_resp',
        ok: true, groupId: id, name });
    } catch {
      send(ws, { type: 'group_create_resp',
        ok: false, msg: 'Name already taken' });
    }
    return;
  }

  if (type === 'group_invite') {
    const { groupId, username } = msg;
    if (!db.isGroupMember(groupId, ws.userId))
      return send(ws, { type: 'group_invite_resp',
        ok: false, msg: 'Not a member' });
    const target = db.findUser(username);
    if (!target) return send(ws, {
      type: 'group_invite_resp',
      ok: false, msg: 'User not found' });
    db.addGroupMember(groupId, target.id);
    send(ws, { type: 'group_invite_resp',
      ok: true, msg: `${username} invited` });
    const targetWs = online.get(target.id);
    if (targetWs) send(targetWs, {
      type: 'group_invited',
      groupId, name: db.getGroup(groupId)?.name });
    return;
  }

  if (type === 'group_list') {
    const groups = db.getGroupsForUser(ws.userId).map(g => ({
      ...g,
      members: db.getGroupMembers(g.id)
    }));
    return send(ws, { type: 'group_list_resp', groups });
  }

  if (type === 'group_leave') {
    db.removeGroupMember(msg.groupId, ws.userId);
    return send(ws, { type: 'group_leave_resp',
                       ok: true });
  }

  if (type === 'group_kick') {
    const group = db.getGroup(msg.groupId);
    if (!group || group.creator_id !== ws.userId)
      return send(ws, { type: 'group_kick_resp',
        ok: false, msg: 'Not creator' });
    const target = db.findUser(msg.username);
    if (!target) return send(ws, {
      type: 'group_kick_resp',
      ok: false, msg: 'User not found' });
    db.removeGroupMember(msg.groupId, target.id);
    const targetWs = online.get(target.id);
    if (targetWs) send(targetWs, {
      type: 'kicked_from_group',
      groupId: msg.groupId,
      name: group.name });
    return send(ws, { type: 'group_kick_resp',
      ok: true, msg: `${msg.username} kicked` });
  }

  if (type === 'group_send_msg') {
    const { groupId, recipients, timestamp } = msg;
    if (!db.isGroupMember(groupId, ws.userId))
      return send(ws, { type: 'group_msg_ack',
                         ok: false });
    for (const r of recipients) {
      if (r.userId === ws.userId) continue;

      // Always store for history
      db.storeGroupMessage(
        groupId, ws.userId, ws.username, r.userId,
        r.ciphertext, r.nonce, r.ephemeralPub, timestamp);

      // Deliver immediately if online
      const targetWs = online.get(r.userId);
      if (targetWs) {
        send(targetWs, {
          type:        'group_recv_msg',
          groupId,
          fromId:      ws.userId,
          fromUser:    ws.username,
          ciphertext:  r.ciphertext,
          nonce:       r.nonce,
          ephemeralPub:r.ephemeralPub,
          timestamp
        });
      }
    }
    return send(ws, { type: 'group_msg_ack', ok: true });
  }

  if (type === 'group_history') {
    const msgs = db.getGroupHistory(
      msg.groupId, ws.userId, 200);
    return send(ws, {
      type: 'group_history_resp',
      groupId: msg.groupId,
      messages: msgs
    });
  }

  // ── File transfer ─────────────────────────────────────
  if (type === 'file_offer') {
    const { filename, fileSize, toId, groupId,
            encKeys } = msg;
    if (fileSize > MAX_FILE_SIZE)
      return send(ws, { type: 'file_cancel',
        reason: 'File exceeds 1GB limit' });
    const tid = uuid();
    db.createFileTransfer(tid, ws.userId,
      toId ?? -1, groupId ?? -1, filename, fileSize);

    send(ws, { type: 'file_offer_sent',
                transferId: tid });

    const alias = `file${Date.now() % 9999}`;
    const recipients = groupId
      ? db.getGroupMembers(groupId)
          .filter(m => m.id !== ws.userId)
      : [{ id: toId }];

    for (const r of recipients) {
      const encKey = encKeys?.find(
        e => e.userId === r.id)?.encKey ?? '';
      const payload = {
        type: 'file_offer',
        transferId: tid,
        alias,
        fromId: ws.userId,
        fromUser: ws.username,
        filename, fileSize, encKey
      };
      const targetWs = online.get(r.id);
      if (targetWs) send(targetWs, payload);
      else db.storeOfflineFileOffer(
        tid, ws.userId, ws.username,
        filename, fileSize, encKey, r.id);
    }
    return;
  }

  if (type === 'file_offer_resp') {
    const { transferId, accept } = msg;
    const tf = db.getFileTransfer(transferId);
    if (!tf) return;
    if (!accept) {
      db.deleteFileTransfer(transferId);
      const senderWs = online.get(tf.sender_id);
      if (senderWs) send(senderWs, {
        type: 'file_cancel',
        transferId,
        reason: `${ws.username} rejected the file`
      });
      return;
    }
    db.updateFileTransferStatus(transferId, 'active');
    const senderWs = online.get(tf.sender_id);
    if (senderWs) send(senderWs, {
      type: 'file_accepted',
      transferId,
      receiverId: ws.userId,
      receiverUser: ws.username
    });
    return;
  }

  if (type === 'file_chunk') {
    const { transferId, receiverId,
            chunkIdx, data, nonce, isLast } = msg;
    const tf = db.getFileTransfer(transferId);
    if (!tf || tf.status !== 'active') return;
    const targetWs = online.get(receiverId);
    if (!targetWs) return;
    send(targetWs, {
      type: 'file_chunk',
      transferId, chunkIdx, data, nonce, isLast
    });
    if (isLast) {
      db.updateFileTransferStatus(transferId, 'done');
      send(ws, { type: 'file_complete',
                  transferId });
    }
    return;
  }

  if (type === 'file_chunk_ack') {
    const tf = db.getFileTransfer(msg.transferId);
    if (!tf) return;
    const senderWs = online.get(tf.sender_id);
    if (senderWs) send(senderWs, {
      type: 'file_chunk_ack',
      transferId: msg.transferId,
      chunkIdx: msg.chunkIdx
    });
    return;
  }

  if (type === 'file_cancel') {
    const tf = db.getFileTransfer(msg.transferId);
    if (!tf) return;
    const other = tf.sender_id === ws.userId
      ? tf.receiver_id : tf.sender_id;
    const otherWs = online.get(other);
    if (otherWs) send(otherWs, {
      type: 'file_cancel',
      transferId: msg.transferId,
      reason: `${ws.username} cancelled`
    });
    db.deleteFileTransfer(msg.transferId);
    return;
  }

  // ── Voice chat ────────────────────────────────────────
  if (type === 'vchat_create') {
    try {
      const id = db.createVChat(msg.name, ws.userId);
      send(ws, { type: 'vchat_create_resp',
        ok: true, vchatId: id, name: msg.name });
    } catch {
      send(ws, { type: 'vchat_create_resp',
        ok: false, msg: 'Name taken' });
    }
    return;
  }

  if (type === 'vchat_invite') {
    if (!db.isVChatMember(msg.vchatId, ws.userId))
      return send(ws, { type: 'vchat_invite_resp',
        ok: false, msg: 'Not a member' });
    const target = db.findUser(msg.username);
    if (!target) return send(ws, {
      type: 'vchat_invite_resp',
      ok: false, msg: 'User not found' });
    db.addVChatMember(msg.vchatId, target.id);
    send(ws, { type: 'vchat_invite_resp',
      ok: true, msg: `${msg.username} invited` });
    const targetWs = online.get(target.id);
    if (targetWs) send(targetWs, {
      type: 'vchat_invited',
      vchatId: msg.vchatId,
      name: db.getVChat(msg.vchatId)?.name });
    return;
  }

  if (type === 'vchat_list') {
    const vchats = db.getVChatsForUser(ws.userId).map(v => ({
      ...v,
      activeCount: activeVChats.get(v.id)?.size ?? 0
    }));
    return send(ws, { type: 'vchat_list_resp', vchats });
  }

  if (type === 'vchat_join') {
    if (!db.isVChatMember(msg.vchatId, ws.userId))
      return send(ws, { type: 'vchat_join_resp',
        ok: false, msg: 'Not a member' });
    if (!activeVChats.has(msg.vchatId))
      activeVChats.set(msg.vchatId, new Set());
    activeVChats.get(msg.vchatId).add(ws.userId);
    const members = db.getVChatMembers(msg.vchatId);
    const active = [...(activeVChats.get(msg.vchatId))]
      .map(uid => members.find(m => m.id === uid))
      .filter(Boolean);
    send(ws, { type: 'vchat_join_resp',
      ok: true, vchatId: msg.vchatId,
      name: db.getVChat(msg.vchatId)?.name,
      active });
    // Notify others
    for (const uid of activeVChats.get(msg.vchatId)) {
      if (uid === ws.userId) continue;
      const w = online.get(uid);
      if (w) send(w, { type: 'vchat_member_join',
        vchatId: msg.vchatId,
        userId: ws.userId, username: ws.username });
    }
    return;
  }

  if (type === 'vchat_leave') {
    const members = activeVChats.get(msg.vchatId);
    if (members) {
      members.delete(ws.userId);
      for (const uid of members) {
        const w = online.get(uid);
        if (w) send(w, { type: 'vchat_member_leave',
          vchatId: msg.vchatId,
          userId: ws.userId, username: ws.username });
      }
    }
    send(ws, { type: 'vchat_leave_resp',
                ok: true, vchatId: msg.vchatId });
    return;
  }

  if (type === 'vchat_leave_room') {
    db.removeVChatMember(msg.vchatId, ws.userId);
    return send(ws, {
      type: 'vchat_leave_room_resp',
      ok: true, vchatId: msg.vchatId
    });
  }

  if (type === 'vchat_delete') {
    const vchat = db.getVChat(msg.vchatId);
    if (!vchat || vchat.creator_id !== ws.userId)
      return send(ws, { type: 'vchat_delete_resp',
        ok: false, msg: 'Not creator' });
    const members = activeVChats.get(msg.vchatId);
    if (members) {
      for (const uid of members) {
        const w = online.get(uid);
        if (w) send(w, { type: 'vchat_deleted',
          vchatId: msg.vchatId });
      }
      activeVChats.delete(msg.vchatId);
    }
    db.deleteVChat(msg.vchatId);
    send(ws, { type: 'vchat_delete_resp', ok: true });
    return;
  }

  // WebRTC signalling for voice
  if (type === 'vchat_signal') {
    const targetWs = online.get(msg.toId);
    if (targetWs) send(targetWs, {
      type: 'vchat_signal',
      fromId: ws.userId,
      fromUser: ws.username,
      signal: msg.signal,
      vchatId: msg.vchatId
    });
    return;
  }

  if (type === 'vchat_members') {
    if (!db.isVChatMember(msg.vchatId, ws.userId))
      return;
    const members = db.getVChatMembers(msg.vchatId);
    const active  = activeVChats.get(msg.vchatId)
                    ?? new Set();
    return send(ws, {
      type:    'vchat_members_resp',
      vchatId: msg.vchatId,
      members: members.map(m => ({
        ...m,
        inCall: active.has(m.id)
      }))
    });
  }

  if (type === 'vchat_state') {
    const members = activeVChats.get(msg.vchatId);
    if (!members) return;
    for (const uid of members) {
      if (uid === ws.userId) continue;
      const w = online.get(uid);
      if (w) send(w, {
        type: 'vchat_state',
        vchatId: msg.vchatId,
        userId: ws.userId,
        username: ws.username,
        muted: msg.muted,
        deafened: msg.deafened
      });
    }
    return;
  }
}

function deliverOffline(ws, uid) {
  const msgs = db.getOfflineMessages(uid);
  for (const m of msgs) {
    send(ws, {
      type:        'recv_msg',
      fromId:      m.from_id,
      fromUser:    m.from_username,
      ciphertext:  m.ciphertext,
      nonce:       m.nonce,
      ephemeralPub:m.ephemeral_pub,
      timestamp:   m.timestamp_unix
    });
  }
  if (msgs.length) db.markMessagesDelivered(uid);

  const gmsgs = db.getGroupOfflineMessages(uid);
  for (const m of gmsgs) {
    send(ws, {
      type:        'group_recv_msg',
      groupId:     m.group_id,
      fromId:      m.from_id,
      fromUser:    m.from_username,
      ciphertext:  m.ciphertext,
      nonce:       m.nonce,
      ephemeralPub:m.ephemeral_pub,
      timestamp:   m.timestamp_unix
    });
  }
  if (gmsgs.length) db.markGroupMessagesDelivered(uid);

  const offers = db.getOfflineFileOffers(uid);
  for (const o of offers) {
    send(ws, {
      type:       'file_offer',
      transferId: o.transfer_id,
      alias:      `file${o.id}`,
      fromId:     o.from_id,
      fromUser:   o.from_username,
      filename:   o.filename,
      fileSize:   o.file_size,
      encKey:     o.enc_key
    });
  }
  if (offers.length) db.deleteOfflineFileOffers(uid);
}