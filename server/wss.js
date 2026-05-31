import { WebSocketServer } from 'ws';
import { v4 as uuid }      from 'uuid';
import { hashPassword, verifyPassword } from './auth.js';

// ── Online users ───────────────────────────────────────────
// Map<userId, ws>
const online = new Map();

// ── Active voice chats ─────────────────────────────────────
// Map<vchatId, Set<userId>>
const activeVChats = new Map();

// ── Rate limiting ──────────────────────────────────────────
// Map<ip, {count, resetAt}>
const loginAttempts = new Map();

function checkLoginRate(ip) {
  const now   = Date.now();
  const entry = loginAttempts.get(ip)
    ?? { count: 0, resetAt: now + 60_000 };

  if (now > entry.resetAt) {
    entry.count   = 0;
    entry.resetAt = now + 60_000;
  }
  entry.count++;
  loginAttempts.set(ip, entry);
  return entry.count <= 10;
}

// Clean stale rate-limit entries every 5 minutes
setInterval(() => {
  const now = Date.now();
  for (const [ip, entry] of loginAttempts)
    if (now > entry.resetAt)
      loginAttempts.delete(ip);
}, 300_000);

// ── Input validation ───────────────────────────────────────
function validUsername(s) {
  return typeof s === 'string' &&
    s.length >= 2 &&
    s.length <= 32 &&
    /^[a-zA-Z0-9_\-]+$/.test(s);
}

function validGroupName(s) {
  return typeof s === 'string' &&
    s.length >= 2 &&
    s.length <= 32 &&
    /^[a-zA-Z0-9_\- ]+$/.test(s);
}

function validPassword(s) {
  return typeof s === 'string' &&
    s.length >= 8 &&
    s.length <= 128;
}

// ── Helpers ────────────────────────────────────────────────
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

// ── Setup ──────────────────────────────────────────────────
export function setupWSS(server) {
  const wss = new WebSocketServer({
    server,
    verifyClient: ({ origin }, done) => {
      // Allow connections with no origin (native clients, tools)
      if (!origin) return done(true);

      // In production set ALLOWED_ORIGINS env var
      // e.g. ALLOWED_ORIGINS=https://yourdomain.com
      const allowed = process.env.ALLOWED_ORIGINS
        ? process.env.ALLOWED_ORIGINS.split(',').map(s => s.trim())
        : null;

      if (!allowed) return done(true); // dev: allow all

      if (allowed.includes(origin)) return done(true);

      console.warn(`[wss] Rejected origin: ${origin}`);
      done(false, 403, 'Forbidden');
    }
  });

  wss.on('connection', (ws, req) => {
    ws.userId   = null;
    ws.username = null;
    ws.authed   = false;
    ws._ip      = req.socket.remoteAddress;

    ws.on('message', (raw) => {
      let msg;
      try { msg = JSON.parse(raw); }
      catch { return; }
      if (!msg || typeof msg.type !== 'string') return;
      handleMessage(ws, msg);
    });

    ws.on('close', () => {
      if (!ws.authed || !ws.userId) return;
      online.delete(ws.userId);
      // Don't delete session on disconnect —
      // user may reconnect/refresh

      // Remove from active voice chats
      for (const [vid, members] of activeVChats) {
        if (members.has(ws.userId)) {
          members.delete(ws.userId);
          for (const uid of members) {
            const w = online.get(uid);
            if (w) send(w, {
              type:     'vchat_member_leave',
              vchatId:  vid,
              userId:   ws.userId,
              username: ws.username
            });
          }
        }
      }

      const friends = db.getFriends(ws.userId);
      broadcast(friends.map(f => f.id), {
        type:     'presence',
        userId:   ws.userId,
        username: ws.username,
        online:   false
      });
    });
  });
}

// ── Message handler ────────────────────────────────────────
async function handleMessage(ws, msg) {
  const { type } = msg;

  // ── Unauthenticated routes ───────────────────────────────
  if (type === 'register') {
    const ip = ws._ip;
    if (!checkLoginRate(ip))
      return send(ws, {
        type: 'register_resp', ok: false,
        msg:  'Too many attempts. Wait a minute.'
      });

    const { username, password, publicKey } = msg;

    if (!validUsername(username))
      return send(ws, {
        type: 'register_resp', ok: false,
        msg:  'Username must be 2-32 chars, ' +
              'letters/numbers/_ only'
      });

    if (!validPassword(password))
      return send(ws, {
        type: 'register_resp', ok: false,
        msg:  'Password must be 8-128 characters'
      });

    if (db.findUser(username))
      return send(ws, {
        type: 'register_resp', ok: false,
        msg:  'Username already taken'
      });

    const hash = await hashPassword(password);
    db.createUser(username, hash);
    const user = db.findUser(username);
    if (publicKey) db.setPublicKey(user.id, publicKey);

    return send(ws, {
      type: 'register_resp', ok: true,
      msg:  'Registered successfully'
    });
  }

  if (type === 'login') {
    const ip = ws._ip;
    if (!checkLoginRate(ip))
      return send(ws, {
        type: 'login_resp', ok: false,
        msg:  'Too many login attempts. ' +
              'Wait a minute.'
      });

    const { username, password, publicKey } = msg;
    if (!username || !password)
      return send(ws, {
        type: 'login_resp', ok: false,
        msg:  'Missing credentials'
      });

    const user = db.findUser(username);
    const dummyHash =
      '$2a$12$dummyhashtopreventtimingattack' +
      'onusernameenumeration000000';
    const hashToCheck = user
      ? user.password_hash : dummyHash;

    const valid = await verifyPassword(
      hashToCheck, password);

    if (!user || !valid)
      return send(ws, {
        type: 'login_resp', ok: false,
        msg:  'Invalid credentials'
      });

    // Kick existing session
    const existing = online.get(user.id);
    if (existing) {
      send(existing, {
        type: 'kicked',
        msg:  'Logged in from another location'
      });
      existing.authed = false;
    }

    // After setPublicKey in login handler:
    if (publicKey) {
      db.setPublicKey(user.id, publicKey);
      // Tell online friends the key may have changed
      const friends = db.getFriends(user.id);
      broadcast(friends.map(f => f.id), {
        type:      'public_key_resp',
        userId:    user.id,
        publicKey: publicKey
      });
    }

    // Create session token
    const token = uuid() + uuid(); // 72 char random token
    db.createSession(token, user.id);

    ws.userId    = user.id;
    ws.username  = user.username;
    ws.authed    = true;
    ws.sessionToken = token;
    online.set(user.id, ws);

    send(ws, {
      type:     'login_resp',
      ok:       true,
      userId:   user.id,
      username: user.username,
      token                     // send token to client
    });

    deliverOffline(ws, user.id);

    const pendingReqs = db.getFriendRequests(user.id);
    if (pendingReqs.length > 0)
      send(ws, {
        type:     'friend_requests_resp',
        requests: pendingReqs
      });

    const friends = db.getFriends(user.id);
    broadcast(friends.map(f => f.id), {
      type:     'presence',
      userId:   user.id,
      username: user.username,
      online:   true
    });
    return;
  }

  // ── Session resume (auto-login on refresh) ───────────
  if (type === 'session_resume') {
    const { token, publicKey } = msg;
    if (!token) return send(ws, {
      type: 'session_resp', ok: false
    });

    const session = db.getSession(token);
    if (!session) return send(ws, {
      type: 'session_resp', ok: false,
      msg:  'Session expired'
    });

    // Kick existing connection only if it's
    // a DIFFERENT socket (not same tab refreshing)
    const existing = online.get(session.user_id);
    if (existing && existing !== ws) {
      send(existing, {
        type: 'kicked',
        msg:  'Resumed from another tab'
      });
      existing.authed = false;
      existing.userId = null;
    }

    db.refreshSession(token);
    if (publicKey) {
      db.setPublicKey(user.id, publicKey);
      // Tell online friends the key may have changed
      const friends = db.getFriends(user.id);
      broadcast(friends.map(f => f.id), {
        type:      'public_key_resp',
        userId:    user.id,
        publicKey: publicKey
      });
    }

    ws.userId       = session.user_id;
    ws.username     = session.username;
    ws.authed       = true;
    ws.sessionToken = token;
    online.set(session.user_id, ws);

    send(ws, {
      type:     'session_resp',
      ok:       true,
      userId:   session.user_id,
      username: session.username,
      token
    });

    deliverOffline(ws, session.user_id);

    const pendingReqs =
      db.getFriendRequests(session.user_id);
    if (pendingReqs.length > 0)
      send(ws, {
        type:     'friend_requests_resp',
        requests: pendingReqs
      });

    const friends = db.getFriends(session.user_id);
    broadcast(friends.map(f => f.id), {
      type:     'presence',
      userId:   session.user_id,
      username: session.username,
      online:   true
    });
    return;
  }

  // ── All routes below require authentication ──────────────
  if (!ws.authed) {
    return send(ws, {
      type: 'error',
      msg:  'Not authenticated'
    });
  }

  if (type === 'logout') {
    if (ws.sessionToken)
      db.deleteSession(ws.sessionToken);

    if (ws.userId)
      online.delete(ws.userId);

    ws.authed       = false;
    ws.sessionToken = null;
    ws.userId       = null;
    ws.username     = null;

    return send(ws, {
      type: 'logout_resp', ok: true });
  }

  // ── Friends ──────────────────────────────────────────────
  if (type === 'friend_list') {
    const friends = db.getFriends(ws.userId).map(f => ({
      ...f, online: online.has(f.id)
    }));
    return send(ws, { type: 'friend_list_resp', friends });
  }

  // ── Friend requests ──────────────────────────────────────
  if (type === 'send_friend_request') {
    const target = db.findUser(msg.username);
    if (!target)
      return send(ws, {
        type: 'friend_req_resp', ok: false,
        msg:  'User not found'
      });
    if (target.id === ws.userId)
      return send(ws, {
        type: 'friend_req_resp', ok: false,
        msg:  'Cannot add yourself'
      });
    if (db.areFriends(ws.userId, target.id))
      return send(ws, {
        type: 'friend_req_resp', ok: false,
        msg:  'Already friends'
      });
    if (db.hasPendingRequest(ws.userId, target.id))
      return send(ws, {
        type: 'friend_req_resp', ok: false,
        msg:  'Request already sent'
      });

    db.sendFriendRequest(ws.userId, target.id);
    send(ws, {
      type: 'friend_req_resp', ok: true,
      msg:  `Friend request sent to ${msg.username}`
    });

    // Notify target if online
    const targetWs = online.get(target.id);
    if (targetWs)
      send(targetWs, {
        type:     'friend_request_received',
        fromId:   ws.userId,
        fromUser: ws.username
      });
    return;
  }

  if (type === 'get_public_key') {
    const targetUser = db.findUserById(msg.userId);
    return send(ws, {
      type:      'public_key_resp',
      userId:    msg.userId,
      publicKey: targetUser?.public_key ?? null
    });
  }

  if (type === 'get_friend_requests') {
    const reqs = db.getFriendRequests(ws.userId);
    return send(ws, {
      type:     'friend_requests_resp',
      requests: reqs
    });
  }

  if (type === 'accept_friend_request') {
    const req = db.acceptFriendRequest(
      msg.reqId, ws.userId);
    if (!req)
      return send(ws, {
        type: 'friend_req_action_resp', ok: false
      });

    send(ws, {
      type: 'friend_req_action_resp',
      ok:   true, action: 'accepted'
    });

    // Notify requester
    const fromWs = online.get(req.from_id);
    if (fromWs)
      send(fromWs, {
        type:   'friend_request_accepted',
        byId:   ws.userId,
        byUser: ws.username
      });
    return;
  }

  if (type === 'decline_friend_request') {
    db.declineFriendRequest(msg.reqId, ws.userId);
    return send(ws, {
      type: 'friend_req_action_resp',
      ok:   true, action: 'declined'
    });
  }

  if (type === 'remove_friend') {
    db.removeFriend(ws.userId, msg.friendId);
    return send(ws, {
      type:     'remove_friend_resp',
      ok:       true,
      friendId: msg.friendId
    });
  }

  // ── DM messages ──────────────────────────────────────────
  if (type === 'send_msg') {
    const { toId, ciphertext, nonce,
            ephemeralPub, timestamp,
            selfCiphertext, selfNonce,
            selfEphemeralPub } = msg;

    if (!toId || !ciphertext || !nonce || !ephemeralPub)
      return;

    const ts = timestamp ?? Math.floor(Date.now() / 1000);

    db.storeMessage(
      ws.userId, toId,
      ciphertext, nonce, ephemeralPub, ts,
      selfCiphertext, selfNonce, selfEphemeralPub);

    const targetWs = online.get(toId);
    if (targetWs)
      send(targetWs, {
        type:        'recv_msg',
        fromId:      ws.userId,
        fromUser:    ws.username,
        ciphertext, nonce, ephemeralPub,
        timestamp:   ts,
        autoOpen:    true
      });

    return send(ws, { type: 'msg_ack', ok: true });
  }

  if (type === 'dm_history') {
    // Mark messages as delivered when chat is opened
    db.markSpecificMessagesDelivered(
      ws.userId, msg.withId);

    const msgs = db.getDMHistory(
      ws.userId, msg.withId, 200);

    const mapped = msgs.map(m => {
      const isSender = m.from_id === ws.userId;
      if (isSender && m.self_ciphertext) {
        return {
          from_id:       m.from_id,
          from_username: m.from_username,
          ciphertext:    m.self_ciphertext,
          nonce:         m.self_nonce,
          ephemeral_pub: m.self_ephemeral_pub,
          timestamp_unix:m.timestamp_unix
        };
      }
      return {
        from_id:       m.from_id,
        from_username: m.from_username,
        ciphertext:    m.ciphertext,
        nonce:         m.nonce,
        ephemeral_pub: m.ephemeral_pub,
        timestamp_unix:m.timestamp_unix
      };
    });

    return send(ws, {
      type:     'dm_history_resp',
      withId:   msg.withId,
      messages: mapped
    });
  }

  // ── Groups ───────────────────────────────────────────────
  if (type === 'group_create') {
    if (!validGroupName(msg.name))
      return send(ws, {
        type: 'group_create_resp', ok: false,
        msg:  'Name must be 2-32 chars ' +
              '(letters, numbers, spaces, _ -)'
      });
    try {
      const id = db.createGroup(msg.name, ws.userId);
      send(ws, {
        type:    'group_create_resp',
        ok:      true,
        groupId: id,
        name:    msg.name
      });
    } catch {
      send(ws, {
        type: 'group_create_resp', ok: false,
        msg:  'Name already taken'
      });
    }
    return;
  }

  if (type === 'group_invite') {
    if (!db.isGroupMember(msg.groupId, ws.userId))
      return send(ws, {
        type: 'group_invite_resp', ok: false,
        msg:  'Not a member'
      });
    const target = db.findUser(msg.username);
    if (!target)
      return send(ws, {
        type: 'group_invite_resp', ok: false,
        msg:  'User not found'
      });
    db.addGroupMember(msg.groupId, target.id);
    send(ws, {
      type: 'group_invite_resp', ok: true,
      msg:  `${msg.username} invited`
    });
    const targetWs = online.get(target.id);
    if (targetWs)
      send(targetWs, {
        type:    'group_invited',
        groupId: msg.groupId,
        name:    db.getGroup(msg.groupId)?.name
      });
    return;
  }

  if (type === 'group_list') {
    const groups = db.getGroupsForUser(ws.userId)
      .map(g => ({
        ...g,
        members: db.getGroupMembers(g.id)
      }));
    return send(ws, { type: 'group_list_resp', groups });
  }

  if (type === 'group_leave') {
    db.removeGroupMember(msg.groupId, ws.userId);
    return send(ws, {
      type: 'group_leave_resp', ok: true
    });
  }

  if (type === 'group_kick') {
    const group = db.getGroup(msg.groupId);
    if (!group || group.creator_id !== ws.userId)
      return send(ws, {
        type: 'group_kick_resp', ok: false,
        msg:  'Not the group creator'
      });
    const target = db.findUser(msg.username);
    if (!target)
      return send(ws, {
        type: 'group_kick_resp', ok: false,
        msg:  'User not found'
      });
    db.removeGroupMember(msg.groupId, target.id);
    const targetWs = online.get(target.id);
    if (targetWs)
      send(targetWs, {
        type:    'kicked_from_group',
        groupId: msg.groupId,
        name:    group.name
      });
    return send(ws, {
      type: 'group_kick_resp', ok: true,
      msg:  `${msg.username} kicked`
    });
  }

  if (type === 'group_delete') {
    const group = db.getGroup(msg.groupId);
    if (!group || group.creator_id !== ws.userId)
      return send(ws, {
        type: 'group_delete_resp', ok: false,
        msg:  'Not the group creator'
      });
    const members = db.getGroupMembers(msg.groupId);
    db.deleteGroup(msg.groupId);
    // Notify all members
    for (const m of members) {
      if (m.id === ws.userId) continue;
      const mWs = online.get(m.id);
      if (mWs)
        send(mWs, {
          type:    'group_deleted',
          groupId: msg.groupId,
          name:    group.name
        });
    }
    return send(ws, {
      type:    'group_delete_resp',
      ok:      true,
      groupId: msg.groupId  // ← add this
    });
  }

  if (type === 'group_send_msg') {
    const { groupId, recipients, timestamp } = msg;
    if (!db.isGroupMember(groupId, ws.userId))
      return send(ws, {
        type: 'group_msg_ack', ok: false
      });

    const ts = timestamp ?? Math.floor(Date.now() / 1000);

    for (const r of recipients) {
      if (r.userId === ws.userId) continue;

      // Always store for history
      db.storeGroupMessage(
        groupId, ws.userId, ws.username, r.userId,
        r.ciphertext, r.nonce, r.ephemeralPub, ts);

      // Deliver immediately if online
      const targetWs = online.get(r.userId);
      if (targetWs)
        send(targetWs, {
          type:        'group_recv_msg',
          groupId,
          fromId:      ws.userId,
          fromUser:    ws.username,
          ciphertext:  r.ciphertext,
          nonce:       r.nonce,
          ephemeralPub:r.ephemeralPub,
          timestamp:   ts
        });
    }
    return send(ws, { type: 'group_msg_ack', ok: true });
  }

  if (type === 'group_history') {
    // getGroupHistory already filters by for_user_id
    // so each user only gets rows encrypted for them
    const msgs = db.getGroupHistory(
      msg.groupId, ws.userId, 200);

    // Normalise column names for client
    const mapped = msgs.map(m => ({
      from_id:       m.from_id,
      from_username: m.from_username,
      ciphertext:    m.ciphertext,
      nonce:         m.nonce,
      ephemeral_pub: m.ephemeral_pub,
      timestamp_unix:m.timestamp_unix,
      group_id:      m.group_id
    }));

    return send(ws, {
      type:     'group_history_resp',
      groupId:  msg.groupId,
      messages: mapped
    });
  }

  // ── File sharing ─────────────────────────────────────────
  if (type === 'file_share') {
    const { toId, groupId, url, filename,
            size, mimetype } = msg;

    // Basic validation
    if (!url || !filename || !size || !mimetype)
      return;

    // Sanitise — only allow our own /uploads/ URLs
    if (!url.startsWith('/uploads/'))
      return;

    const ts = Math.floor(Date.now() / 1000);
    const payload = {
      type:     'file_shared',
      fromId:   ws.userId,
      fromUser: ws.username,
      url, filename, size, mimetype,
      timestamp: ts
    };

    if (groupId) {
      if (!db.isGroupMember(groupId, ws.userId))
        return;
      const members = db.getGroupMembers(groupId);
      for (const m of members) {
        if (m.id === ws.userId) continue;
        const tw = online.get(m.id);
        if (tw) {
          send(tw, { ...payload, groupId });
        } else {
          // Store as offline message
          db.storeMessage(
            ws.userId, m.id,
            JSON.stringify({
              fileShare: true,
              url, filename, size, mimetype
            }),
            'file', 'file', ts);
        }
      }
    } else if (toId) {
      const tw = online.get(toId);
      if (tw) {
        send(tw, payload);
      } else {
        db.storeMessage(
          ws.userId, toId,
          JSON.stringify({
            fileShare: true,
            url, filename, size, mimetype
          }),
          'file', 'file', ts);
      }
    }
    return;
  }

  // ── Voice chats ──────────────────────────────────────────
  if (type === 'vchat_create') {
    if (!validGroupName(msg.name))
      return send(ws, {
        type: 'vchat_create_resp', ok: false,
        msg:  'Invalid name'
      });
    try {
      const id = db.createVChat(msg.name, ws.userId);
      send(ws, {
        type:    'vchat_create_resp',
        ok:      true,
        vchatId: id,
        name:    msg.name
      });
    } catch {
      send(ws, {
        type: 'vchat_create_resp', ok: false,
        msg:  'Name already taken'
      });
    }
    return;
  }

  if (type === 'vchat_invite') {
    if (!db.isVChatMember(msg.vchatId, ws.userId))
      return send(ws, {
        type: 'vchat_invite_resp', ok: false,
        msg:  'Not a member'
      });
    const target = db.findUser(msg.username);
    if (!target)
      return send(ws, {
        type: 'vchat_invite_resp', ok: false,
        msg:  'User not found'
      });
    db.addVChatMember(msg.vchatId, target.id);
    send(ws, {
      type: 'vchat_invite_resp', ok: true,
      msg:  `${msg.username} invited`
    });
    const targetWs = online.get(target.id);
    if (targetWs)
      send(targetWs, {
        type:    'vchat_invited',
        vchatId: msg.vchatId,
        name:    db.getVChat(msg.vchatId)?.name
      });
    return;
  }

  if (type === 'vchat_list') {
    const vchats = db.getVChatsForUser(ws.userId)
      .map(v => ({
        ...v,
        activeCount: activeVChats.get(v.id)?.size ?? 0
      }));
    return send(ws, { type: 'vchat_list_resp', vchats });
  }

  if (type === 'vchat_join') {
    if (!db.isVChatMember(msg.vchatId, ws.userId))
      return send(ws, {
        type: 'vchat_join_resp', ok: false,
        msg:  'Not a member'
      });

    if (!activeVChats.has(msg.vchatId))
      activeVChats.set(msg.vchatId, new Set());
    activeVChats.get(msg.vchatId).add(ws.userId);

    const members = db.getVChatMembers(msg.vchatId);
    const active  = [...(activeVChats.get(msg.vchatId))]
      .map(uid => members.find(m => m.id === uid))
      .filter(Boolean);

    send(ws, {
      type:    'vchat_join_resp',
      ok:      true,
      vchatId: msg.vchatId,
      name:    db.getVChat(msg.vchatId)?.name,
      active
    });

    // Notify others in the call
    for (const uid of activeVChats.get(msg.vchatId)) {
      if (uid === ws.userId) continue;
      const w = online.get(uid);
      if (w)
        send(w, {
          type:     'vchat_member_join',
          vchatId:  msg.vchatId,
          userId:   ws.userId,
          username: ws.username
        });
    }
    return;
  }

  if (type === 'vchat_leave') {
    const members = activeVChats.get(msg.vchatId);
    if (members) {
      members.delete(ws.userId);
      for (const uid of members) {
        const w = online.get(uid);
        if (w)
          send(w, {
            type:     'vchat_member_leave',
            vchatId:  msg.vchatId,
            userId:   ws.userId,
            username: ws.username
          });
      }
    }
    return send(ws, {
      type:    'vchat_leave_resp',
      ok:      true,
      vchatId: msg.vchatId
    });
  }

  if (type === 'vchat_leave_room') {
    // Disconnect from active call first if in it
    const members = activeVChats.get(msg.vchatId);
    if (members?.has(ws.userId)) {
      members.delete(ws.userId);
      for (const uid of members) {
        const w = online.get(uid);
        if (w)
          send(w, {
            type:     'vchat_member_leave',
            vchatId:  msg.vchatId,
            userId:   ws.userId,
            username: ws.username
          });
      }
    }
    // Remove from room membership entirely
    db.removeVChatMember(msg.vchatId, ws.userId);
    return send(ws, {
      type:    'vchat_leave_room_resp',
      ok:      true,
      vchatId: msg.vchatId
    });
  }

  if (type === 'vchat_delete') {
    const vchat = db.getVChat(msg.vchatId);
    if (!vchat || vchat.creator_id !== ws.userId)
      return send(ws, {
        type: 'vchat_delete_resp', ok: false,
        msg:  'Not the creator'
      });

    const inCall = activeVChats.get(msg.vchatId);
    if (inCall) {
      for (const uid of inCall) {
        const w = online.get(uid);
        if (w)
          send(w, {
            type:    'vchat_deleted',
            vchatId: msg.vchatId
          });
      }
      activeVChats.delete(msg.vchatId);
    }
    db.deleteVChat(msg.vchatId);
    return send(ws, {
      type: 'vchat_delete_resp', ok: true
    });
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

  // ── WebRTC signalling ────────────────────────────────────
  if (type === 'vchat_signal') {
    if (!msg.toId || !msg.signal) return;
    const targetWs = online.get(msg.toId);
    if (targetWs)
      send(targetWs, {
        type:     'vchat_signal',
        fromId:   ws.userId,
        fromUser: ws.username,
        signal:   msg.signal,
        vchatId:  msg.vchatId
      });
    return;
  }

  if (type === 'vchat_state') {
    const members = activeVChats.get(msg.vchatId);
    if (!members) return;
    for (const uid of members) {
      if (uid === ws.userId) continue;
      const w = online.get(uid);
      if (w)
        send(w, {
          type:     'vchat_state',
          vchatId:  msg.vchatId,
          userId:   ws.userId,
          username: ws.username,
          muted:    !!msg.muted,
          deafened: !!msg.deafened
        });
    }
    return;
  }
}

// ── Offline delivery ───────────────────────────────────────
function deliverOffline(ws, uid) {
  // Send unread counts per sender so badges
  // show correctly without duplicating history
  const unreadDMs = db.getUnreadDMCounts(uid);
  if (unreadDMs.length > 0)
    send(ws, {
      type:   'unread_counts',
      dms:    unreadDMs
    });

  const unreadGroups =
    db.getUnreadGroupCounts(uid);
  if (unreadGroups.length > 0)
    send(ws, {
      type:   'unread_counts',
      groups: unreadGroups
    });

  // File offers still need full delivery
  const offers = db.getOfflineFileOffers(uid);
  for (const o of offers) {
    send(ws, {
      type:      'file_offer',
      transferId:o.transfer_id,
      alias:     `file${o.id}`,
      fromId:    o.from_id,
      fromUser:  o.from_username,
      filename:  o.filename,
      fileSize:  o.file_size,
      encKey:    o.enc_key,
      isHistory: true
    });
  }
  if (offers.length) db.deleteOfflineFileOffers(uid);
}