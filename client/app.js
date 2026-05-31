// Main application logic
// Connects to WebSocket server and orchestrates all features

const WS_URL = `${
  location.protocol === 'https:' ? 'wss' : 'ws'
}://${location.host}`;

let ws         = null;
let identity   = null; // { publicKey, privateKey, pub }
let myUserId   = null;
let myUsername = null;

// State
let friends    = [];
let pendingFriendRequests = [];
let groups     = [];
let vchats     = [];
let currentChat = null; // {type:'dm'|'group', id, data}

let loggingOut = false;
let intentionalLogout = false;
// Panel map: panelId → {type, chatId}
const panelMap  = new Map();
// Reverse: `${type}_${chatId}` → panelId
const chatToPanel = new Map();

//Session helpers
const SESSION_KEY = 'securechat_session';

const pubKeyCache = new Map();
const PUB_KEY_TTL = 5 * 60 * 1000;

function saveSession(token) {
  localStorage.setItem(SESSION_KEY, token);
}

function loadSession() {
  return localStorage.getItem(SESSION_KEY);
}

function clearSession() {
  localStorage.removeItem(SESSION_KEY);
}

function chatKey(type, chatId) {
  return `${type}_${chatId}`;
}
let pendingMembersVchatId = null;

//other helpers
function hideLoadingScreen() {
  const el = document.getElementById(
    'loading-screen');
  if (el) el.style.display = 'none';
  // Remove the flag so auth screen can show
  // if needed
  delete document.documentElement
    .dataset.hasSession;
}

// ── WebSocket ──────────────────────────────────────────
function connect() {
  ws = new WebSocket(WS_URL);

  ws.onopen = async () => {
    SC.ui.setConnStatus('Connected', true);

    // Don't try session resume after explicit logout
    if (intentionalLogout) {
      intentionalLogout = false;
      hideLoadingScreen();
      return;
    }

    const token = loadSession();
    if (token) {
      if (!identity)
        identity =
          await SC.crypto.loadOrCreateIdentity();
      send({
        type:      'session_resume',
        token,
        publicKey: identity.pub
      });
    } else {
      hideLoadingScreen();
    }
  };

  ws.onclose = () => {
    // Don't show "disconnected" if we just logged out
    if (!intentionalLogout) {
      SC.ui.setConnStatus(
        'Disconnected — reconnecting...', false);
    }
    hideLoadingScreen();
    setTimeout(connect, 3000);
  };

  ws.onerror = () => {
    hideLoadingScreen();
    SC.ui.setConnStatus('Connection error', false);
  };

  ws.onmessage = (ev) => {
    let msg;
    try { msg = JSON.parse(ev.data); }
    catch { return; }
    handleMessage(msg);
  };
}

function send(msg) {
  if (ws?.readyState === 1)
    ws.send(JSON.stringify(msg));
}

// ── Key handler ────────────────────────────────────
async function getFreshPublicKey(userId) {
  const cached = pubKeyCache.get(userId);
  if (cached &&
      Date.now() - cached.fetchedAt < PUB_KEY_TTL)
    return cached.key;

  // Request fresh key from server
  return new Promise((resolve) => {
    const handler = (e) => {
      const msg = e.detail;
      if (msg.type === 'public_key_resp' &&
          msg.userId === userId) {
        document.removeEventListener(
          '_ws_msg', handler);
        const key = msg.publicKey ?? null;
        if (key)
          pubKeyCache.set(userId, {
            key, fetchedAt: Date.now()
          });
        resolve(key);
      }
    };
    document.addEventListener('_ws_msg', handler);
    send({ type: 'get_public_key', userId });

    // Timeout after 5s
    setTimeout(() => {
      document.removeEventListener(
        '_ws_msg', handler);
      // Fall back to cached friends list
      const f = friends.find(x => x.id === userId);
      resolve(f?.public_key ?? null);
    }, 5000);
  });
}

// ── Message handler ────────────────────────────────────
  async function handleMessage(msg) {
  // Internal pub/sub for promise-based handlers
  const ev = new CustomEvent('_ws_msg',
    { detail: msg });
  document.dispatchEvent(ev);

  switch (msg.type) {

    case 'session_resp':
      hideLoadingScreen();
      if (msg.ok) {
        myUserId   = msg.userId;
        myUsername = msg.username;
        if (msg.token) saveSession(msg.token);
        SC.ui.showApp(msg.username);
        loadFriends();
        loadGroups();
        loadVChats();
        send({ type: 'get_friend_requests' });
      } else {
        clearSession();
        SC.ui.showAuth();
        SC.ui.setConnStatus('Connected', true);
      }
      break;

    case 'login_resp':
      if (msg.ok) {
        myUserId   = msg.userId;
        myUsername = msg.username;
        if (msg.token) saveSession(msg.token);
        SC.ui.showApp(msg.username);
        loadFriends();
        loadGroups();
        loadVChats();
        send({ type: 'get_friend_requests' });
      } else {
        SC.ui.setAuthError('login', msg.msg);
      }
      break;

    case 'public_key_resp':
      // Handled by getFreshPublicKey listener
      // Also update local friends cache
      if (msg.publicKey) {
        const f = friends.find(
          x => x.id === msg.userId);
        if (f) f.public_key = msg.publicKey;
        pubKeyCache.set(msg.userId, {
          key:       msg.publicKey,
          fetchedAt: Date.now()
        });
      }
      break;

    case 'register_resp':
      if (msg.ok) {
        SC.ui.setAuthError('reg', '');
        // Auto-login after register
        doLogin(
          document.getElementById('reg-user').value,
          document.getElementById('reg-pass').value);
      } else {
        SC.ui.setAuthError('reg', msg.msg);
      }
      break;

    case 'kicked':
      logout();
      SC.ui.setAuthError('login',
        'Logged in from another location');
      break;

    case 'friend_list_resp':
      friends = msg.friends;
      SC.ui.renderFriends(
        friends, myUserId,
        openDMChat,
        (f) => {
          if (!confirm(
            `Remove ${f.username} as a friend?`))
            return;
          send({
            type:     'remove_friend',
            friendId: f.id
          });
        }
      );
      break;

    case 'add_friend_resp':
      if (msg.ok) {
        SC.ui.hideModal();
        loadFriends();
      }
      break;

    case 'friend_req_resp':
      if (msg.ok) {
        SC.ui.hideModal();
        SC.ui.appendSystemMsg?.(`✓ ${msg.msg}`);
      } else {
        const errEl = document.querySelector(
          '#modal-body .err');
        if (errEl) errEl.textContent = msg.msg;
      }
      break;

    case 'friend_requests_resp':
      pendingFriendRequests = msg.requests;
      SC.ui.setFriendRequestBadge(
        pendingFriendRequests.length);
      break;

    case 'friend_request_received':
      pendingFriendRequests.push({
        id:       msg.fromId,
        from_id:  msg.fromId,
        username: msg.fromUser
      });
      SC.ui.setFriendRequestBadge(
        pendingFriendRequests.length);
      playNotifSound();
      break;

    case 'friend_request_accepted':
      // Someone accepted our request —
      // refresh friend list
      loadFriends();
      break;

    case 'friend_req_action_resp':
      send({ type: 'get_friend_requests' });
      if (msg.action === 'accepted')
        loadFriends();
      break;

    case 'remove_friend_resp':
      if (msg.ok) loadFriends();
      break;

    case 'presence':
      SC.ui.updatePresence(msg.userId, msg.online);
      const f = friends.find(x => x.id === msg.userId);
      if (f) f.online = msg.online;
      break;

    case 'recv_msg':
      await onDMReceived(msg);
      break;

    case 'dm_history_resp':
      await renderDMHistory(msg);
      break;

    case 'msg_ack':
      break;

    case 'group_list_resp':
      groups = msg.groups;
      SC.ui.renderGroups(
        groups,
        myUserId,
        openGroupChat,
        // onInvite
        (g) => {
          SC.ui.showModal('Invite to Group',
            SC.ui.modalInput(
              'Username', 'Invite',
              (val, err) => {
                if (!val) {
                  err.textContent =
                    'Enter a username';
                  return;
                }
                send({
                  type:    'group_invite',
                  groupId: g.id,
                  username: val
                });
              }));
        },
        // onMembers
        (g) => {
          const wrap =
            document.createElement('div');
          wrap.style.cssText =
            'display:flex;flex-direction:' +
            'column;gap:4px';
          g.members?.forEach(m => {
            const row =
              document.createElement('div');
            row.className = 'member-row';
            row.innerHTML = `
              <span>${SC.esc(m.username)}</span>
              ${m.id === g.creator_id
                ? '<span style="color:var(--yellow)">creator</span>'
                : ''}
            `;
            wrap.appendChild(row);
          });
          SC.ui.showModal(
            `# ${g.name} — Members`, wrap);
        },
        // onLeave
        (g) => {
          if (!confirm(
            `Leave group "${g.name}"?`)) return;
          send({
            type:    'group_leave',
            groupId: g.id
          });
        },
        // onDelete
        (g) => {
          if (!confirm(
            `Delete group "${g.name}"?\n` +
            `This cannot be undone.`)) return;
          send({
            type:    'group_delete',
            groupId: g.id
          });
        }
      );
      break;

    case 'group_create_resp':
      if (msg.ok) {
        SC.ui.hideModal();
        loadGroups();
      }
      break;

    case 'group_invite_resp':
      if (msg.ok) {
        SC.ui.hideModal();
        SC.ui.appendSystemMsg(
          `User invited successfully`);
      } else {
        // Show error in modal
        const errEl = document.querySelector(
          '#modal-body .err');
        if (errEl) errEl.textContent = msg.msg;
      }
      break;

    case 'group_history_resp':
      await renderGroupHistory(msg);
      break;

    case 'group_invited':
      loadGroups();
      SC.ui.appendSystemMsg?.(
        `You were invited to group: ${msg.name}`);
      break;

    case 'group_recv_msg':
      await onGroupMsgReceived(msg);
      break;

    case 'group_msg_ack':
      break;

    case 'group_leave_resp':
      if (msg.ok) {
        currentChat = null;
        document.getElementById('chat-window')
          .classList.add('hidden');
        document.getElementById('welcome-screen')
          .classList.remove('hidden');
        loadGroups();
      }
      break;

    case 'group_kick_resp':
      if (msg.ok) { SC.ui.hideModal(); loadGroups(); }
      break;

    case 'kicked_from_group':
      SC.ui.appendSystemMsg(
        `You were kicked from: ${msg.name}`);
      if (currentChat?.type === 'group' &&
          currentChat.id === msg.groupId)
        currentChat = null;
      loadGroups();
      break;

    case 'file_shared':
      onFileShared(msg);
      break;

    case 'vchat_list_resp':
      vchats = msg.vchats;
      SC.ui.renderVChats(
        vchats,
        SC.voice.vchatId,
        myUserId,

        // onJoin — left click
        (v) => joinVChat(v),

        // onInvite
        (v) => {
          SC.ui.showModal('Invite to Voice Chat',
            SC.ui.modalInput('Username', 'Invite',
              (val, err) => {
                if (!val) {
                  err.textContent =
                    'Enter a username';
                  return;
                }
                send({ type: 'vchat_invite',
                       vchatId: v.id,
                       username: val });
                SC.ui.hideModal();
              }));
        },

        // onMembers
        (v) => {
          // Fetch fresh member list from server
          send({ type: 'vchat_members',
                 vchatId: v.id });
          // Store which vchat we requested
          pendingMembersVchatId = v.id;
        },

        // onAbandon — leave room permanently
        (v) => {
          if (!confirm(
            `Leave voice chat "${v.name}"?\n` +
            `You will need to be re-invited.`))
            return;
          // If currently in the call, disconnect first
          if (SC.voice.vchatId === v.id)
            send({ type: 'vchat_leave',
                   vchatId: v.id });
          send({ type: 'vchat_leave_room',
                 vchatId: v.id });
        },

        // onDelete
        (v) => {
          if (!confirm(
            `Delete voice chat "${v.name}"?\n` +
            `This cannot be undone.`)) return;
          send({ type: 'vchat_delete',
                 vchatId: v.id });
        }
      );
      break;

    case 'vchat_create_resp':
      if (msg.ok) {
        SC.ui.hideModal();
        loadVChats();
      }
      break;

    case 'vchat_members_resp': {
      const vchat = vchats.find(
        v => v.id === msg.vchatId);
      const name = vchat?.name ?? 'Voice Chat';
      const wrap =
        document.createElement('div');
      wrap.style.display = 'flex';
      wrap.style.flexDirection = 'column';
      wrap.style.gap = '4px';
      msg.members.forEach(m => {
        const row =
          document.createElement('div');
        row.className = 'member-row';
        row.innerHTML = `
          <span>${SC.esc(m.username)}</span>
          <span style="color:${
            m.inCall
              ? 'var(--green)'
              : 'var(--text-dim)'}">
            ${m.inCall ? '● in call' : '○ offline'}
          </span>
        `;
        wrap.appendChild(row);
      });
      SC.ui.showModal(
        `Members — ${name}`, wrap);
      pendingMembersVchatId = null;
      break;
    }

    case 'vchat_invite_resp':
      if (msg.ok) { SC.ui.hideModal(); }
      break;

    case 'vchat_invited':
      SC.ui.appendSystemMsg?.(
        `You were invited to voice chat: ${msg.name}`);
      loadVChats();
      break;

    case 'vchat_join_resp':
      if (msg.ok) await onVChatJoined(msg);
      break;

    case 'vchat_leave_resp':
      onVChatLeft();
      break;

    case 'vchat_leave_room_resp':
      if (msg.ok) loadVChats();
      break;

    case 'vchat_member_join':
      if (SC.voice.isActive()) {
        SC.voice.connectToPeer(
          msg.userId, msg.username, true);
      }
      break;

    case 'vchat_member_leave':
      SC.voice.disconnectPeer(msg.userId);
      break;

    case 'vchat_signal':
      if (SC.voice.isActive()) {
        await SC.voice.handleSignal(
          msg.fromId, msg.fromUser, msg.signal);
      }
      break;

    case 'vchat_state':
      SC.voice.updatePeerState(
        msg.userId, msg.username,
        msg.muted, msg.deafened);
      break;

    case 'vchat_deleted':
      if (SC.voice.vchatId === msg.vchatId)
        onVChatLeft();
      loadVChats();
      break;

    case 'vchat_delete_resp':
      if (msg.ok) {
        onVChatLeft();
        SC.ui.hideModal();
        loadVChats();
      }
      break;

    case 'unread_counts':
      if (msg.dms) {
        msg.dms.forEach(row => {
          const k = `dm_${row.from_id}`;
          unread.set(k, row.count);
          SC.ui.setBadge(row.from_id, row.count);
        });
      }
      if (msg.groups) {
        msg.groups.forEach(row => {
          const k = `grp_${row.group_id}`;
          unread.set(k, row.count);
          SC.ui.setGroupBadge(
            row.group_id, row.count);
        });
      }
      break;
  }
}

// ── Auth ───────────────────────────────────────────────
async function doLogin(username, password) {
  if (!identity)
    identity =
      await SC.crypto.loadOrCreateIdentity();
  send({
    type:      'login',
    username,
    password,
    publicKey: identity.pub
  });
}

async function doRegister(username, password) {
  if (!identity) {
    identity = await SC.crypto.loadOrCreateIdentity();
  }
  send({ type: 'register', username, password,
         publicKey: identity.pub });
}

function logout() {
  intentionalLogout = true;
  loggingOut        = true;
  send({ type: 'logout' });
  clearSession();
  myUserId = myUsername = null;
  currentChat = null;
  friends = groups = vchats = [];
  pendingFriendRequests = [];
  SC.voice.leave();
  SC.ui.hideVoiceStatus?.();
  SC.ui.setFriendRequestBadge(0);
  // Show auth immediately — don't wait for server
  SC.ui.showAuth();
  SC.ui.setConnStatus('Connected', true);
  loggingOut = false;
}

// ── Friends & data loading ─────────────────────────────
function loadFriends() {
  send({ type: 'friend_list' });
}

function loadGroups() {
  send({ type: 'group_list' });
}

function loadVChats() {
  send({ type: 'vchat_list' });
}

// ── DM chat ────────────────────────────────────────────

//unread message tracking
const unread = new Map();

function openDMChat(friend) {
  const key = chatKey('dm', friend.id);
  const existing = chatToPanel.get(key);
  if (existing) {
    SC.tiler._flash(existing);
    // Reload history
    send({ type: 'dm_history',
           withId: friend.id });
    return;
  }
  const panelId = SC.tiler.open(
    'dm', friend.id,
    friend.username, friend);

  panelMap.set(panelId,
    { type: 'dm', chatId: friend.id });
  chatToPanel.set(key, panelId);

  // Clear unread badge
  unread.delete(`dm_${friend.id}`);
  SC.ui.setBadge(friend.id, 0);

  send({ type: 'dm_history',
         withId: friend.id });
}

async function onDMReceived(msg) {
  let text;
  try {
    text = await SC.crypto.decrypt(
      msg.ciphertext,
      msg.nonce,
      msg.ephemeralPub,        
      identity.privateKey);
  } catch (e) {
    console.warn('Live DM decrypt failed:', e);
    text = '[decryption failed]';
  }

  const key     = chatKey('dm', msg.fromId);
  const panelId = chatToPanel.get(key);

  if (panelId != null) {
    SC.tiler.appendMessage(panelId, {
      timestamp: msg.timestamp,
      author:    msg.fromUser,
      text,
      isSelf:    false
    });
    // Only notify if this isn't a history replay
    if (!msg.isHistory) playNotifSound();
  } else if (!msg.isHistory) {
    // Auto-open chat when message arrives live
    if (msg.autoOpen) {
      const friend = friends.find(
        f => f.id === msg.fromId)
        ?? { id: msg.fromId,
              username: msg.fromUser,
              online: true,
              public_key: null };
      openDMChat(friend);
      // Message will appear via history load
    } else {
      // No auto-open — badge only
      const k = `dm_${msg.fromId}`;
      unread.set(k, (unread.get(k) ?? 0) + 1);
      SC.ui.setBadge(msg.fromId, unread.get(k));
      playNotifSound();
    }
  }
  // If isHistory=true and panel not open: silently ignore
}

async function sendDM(text) {
  if (!currentChat || currentChat.type !== 'dm')
    return;
  const friend = currentChat.data;
  if (!friend.public_key) {
    // Fetch latest key
    const f = friends.find(
      x => x.id === friend.id);
    if (!f?.public_key) return;
  }

  const bundle = await SC.crypto.encrypt(
    text, friend.public_key);

  const timestamp = Math.floor(Date.now() / 1000);
  send({
    type: 'send_msg',
    toId: friend.id,
    ...bundle,
    timestamp
  });

  SC.ui.appendMessage({
    timestamp, author: myUsername,
    text, isSelf: true
  });
}

async function renderDMHistory(msg) {
  const key     = chatKey('dm', msg.withId);
  const panelId = chatToPanel.get(key);
  if (panelId == null) return;

  const el = SC.tiler._msgEl(panelId);
  if (el) {
    el.innerHTML = '';
    delete el.dataset.lastDate;
  }

  for (const m of msg.messages) {
    const isSelf = m.from_id === myUserId;

    // Check if it's a file share message
    if (m.nonce === 'file') {
      try {
        const data = JSON.parse(m.ciphertext);
        if (data.fileShare) {
          SC.tiler.appendFile(panelId, {
            fromUser:  m.from_username,
            url:       data.url,
            filename:  data.filename,
            size:      data.size,
            mimetype:  data.mimetype,
            timestamp: m.timestamp_unix,
            isSelf
          });
          continue;
        }
      } catch {}
    }

    // Regular encrypted message
    let text;
    try {
      text = await SC.crypto.decrypt(
        m.ciphertext,
        m.nonce,
        m.ephemeral_pub,
        identity.privateKey);
    } catch (e) {
      console.warn('DM decrypt failed:', e);
      text = '[decryption failed]';
    }
    SC.tiler.appendMessage(panelId, {
      timestamp: m.timestamp_unix,
      author:    m.from_username,
      text,
      isSelf
    });
  }
}
// ── Group chat ─────────────────────────────────────────
function openGroupChat(group) {
  const key = chatKey('group', group.id);
  const existing = chatToPanel.get(key);
  if (existing) {
    SC.tiler._flash(existing);
    send({ type: 'group_history',
           groupId: group.id });
    return;
  }
  const panelId = SC.tiler.open(
    'group', group.id,
    group.name, group);

  panelMap.set(panelId,
    { type: 'group', chatId: group.id });
  chatToPanel.set(key, panelId);

  unread.delete(`grp_${group.id}`);
  SC.ui.setGroupBadge(group.id, 0);

  send({ type: 'group_history',
         groupId: group.id });
}

async function onGroupMsgReceived(msg) {
  if (msg.fromId === myUserId) return;
  let text;
  try {
    text = await SC.crypto.decrypt(
      msg.ciphertext,
      msg.nonce,
      msg.ephemeralPub,        
      identity.privateKey);
  } catch (e) {
    console.warn('Live group decrypt failed:', e);
    text = '[decryption failed]';
  }

  const key     = chatKey('group', msg.groupId);
  const panelId = chatToPanel.get(key);

  if (panelId != null) {
    SC.tiler.appendMessage(panelId, {
      timestamp: msg.timestamp,
      author:    msg.fromUser,
      text,
      isSelf:    false
    });
    if (!msg.isHistory) playNotifSound();
  } else if (!msg.isHistory) {
    const k = `grp_${msg.groupId}`;
    unread.set(k, (unread.get(k) ?? 0) + 1);
    SC.ui.setGroupBadge(msg.groupId, unread.get(k));
    playNotifSound();
  }
}

async function sendGroupMessage(text) {
  if (!currentChat || currentChat.type !== 'group')
    return;
  const group = groups.find(
    g => g.id === currentChat.id);
  if (!group) return;

  const timestamp = Math.floor(Date.now() / 1000);
  const recipients = await Promise.all(
    group.members
      .filter(m => m.id !== myUserId &&
                   m.public_key)
      .map(async m => ({
        userId: m.id,
        ...await SC.crypto.encrypt(text, m.public_key)
      }))
  );

  send({
    type: 'group_send_msg',
    groupId: group.id,
    recipients, timestamp
  });

  SC.ui.appendMessage({
    timestamp, author: myUsername,
    text, isSelf: true
  });
}

async function renderGroupHistory(msg) {
  const key     = chatKey('group', msg.groupId);
  const panelId = chatToPanel.get(key);
  if (panelId == null) return;

  const el = SC.tiler._msgEl(panelId);
  if (el) {
    el.innerHTML = '';
    delete el.dataset.lastDate;
  }

  for (const m of msg.messages) {
    const isSelf = m.from_id === myUserId;

    // Check if it's a file share message
    if (m.nonce === 'file') {
      try {
        const data = JSON.parse(m.ciphertext);
        if (data.fileShare) {
          SC.tiler.appendFile(panelId, {
            fromUser:  m.from_username,
            url:       data.url,
            filename:  data.filename,
            size:      data.size,
            mimetype:  data.mimetype,
            timestamp: m.timestamp_unix,
            isSelf
          });
          continue;
        }
      } catch {}
    }

    let text;
    try {
      text = await SC.crypto.decrypt(
        m.ciphertext,
        m.nonce,
        m.ephemeral_pub,
        identity.privateKey);
    } catch (e) {
      console.warn('Group decrypt failed:', e);
      text = '[decryption failed]';
    }
    SC.tiler.appendMessage(panelId, {
      timestamp: m.timestamp_unix,
      author:    m.from_username,
      text,
      isSelf
    });
  }
}

// ── File transfer ──────────────────────────────────────
function onFileShared(msg) {
  const key = msg.groupId
    ? chatKey('group', msg.groupId)
    : chatKey('dm', msg.fromId);
  const panelId = chatToPanel.get(key);

  if (panelId != null) {
    SC.tiler.appendFile(panelId, {
      fromUser:  msg.fromUser,
      url:       msg.url,
      filename:  msg.filename,
      size:      msg.size,
      mimetype:  msg.mimetype,
      timestamp: msg.timestamp,
      isSelf:    msg.fromId === myUserId
    });
    if (!msg.isHistory) playNotifSound();
  } else if (!msg.isHistory) {
    // Badge
    const k = msg.groupId
      ? `grp_${msg.groupId}`
      : `dm_${msg.fromId}`;
    unread.set(k, (unread.get(k) ?? 0) + 1);
    if (msg.groupId)
      SC.ui.setGroupBadge(
        msg.groupId, unread.get(k));
    else
      SC.ui.setBadge(msg.fromId, unread.get(k));
    playNotifSound();
  }
}

// ── Voice chat ─────────────────────────────────────────
async function joinVChat(vchat) {
  if (SC.voice.isActive()) {
    alert('Already in a voice chat. Leave first.');
    return;
  }
  send({ type: 'vchat_join',
         vchatId: vchat.id });
}

async function onVChatJoined(msg) {
  await SC.voice.join(
    msg.vchatId, myUserId, myUsername, send);

  SC.ui.showVoiceStatus(msg.name);
  loadVChats();

  // Set up VU callback
  SC.voice.onVU = (speakers) => {
    SC.ui.updateVUMeters(speakers);
  };

  // Connect to existing members via WebRTC
  for (const member of msg.active ?? []) {
    if (member.id !== myUserId)
      await SC.voice.connectToPeer(
        member.id, member.username, true);
  }
}

function onVChatLeft() {
  SC.voice.leave();
  SC.ui.hideVoiceStatus();
  loadVChats();
}

function leaveVChat() {
  if (!SC.voice.isActive()) return;
  send({ type: 'vchat_leave',
         vchatId: SC.voice.vchatId });
}

// ── Sound notifications ────────────────────────────────
function playNotifSound() {
  try {
    const ctx = new AudioContext();
    const osc = ctx.createOscillator();
    const gain = ctx.createGain();
    osc.connect(gain);
    gain.connect(ctx.destination);
    osc.frequency.value = 880;
    gain.gain.setValueAtTime(0.1, ctx.currentTime);
    gain.gain.exponentialRampToValueAtTime(
      0.001, ctx.currentTime + 0.3);
    osc.start(ctx.currentTime);
    osc.stop(ctx.currentTime + 0.3);
  } catch {}
}

// ── UI event wiring ────────────────────────────────────
document.addEventListener('DOMContentLoaded', async () => {
  identity = await SC.crypto.loadOrCreateIdentity();
  connect();

  // Auth tabs
  document.querySelectorAll('.tab-btn')
    .forEach(btn => {
      btn.onclick = () => {
        document.querySelectorAll('.tab-btn')
          .forEach(b => b.classList.remove('active'));
        btn.classList.add('active');
        document.querySelectorAll('.auth-form')
          .forEach(f => f.classList.add('hidden'));
        document.getElementById(
          btn.dataset.tab + '-form')
          .classList.remove('hidden');
      };
    });

  // Login
  document.getElementById('login-btn').onclick = () => {
    const u = document.getElementById(
      'login-user').value.trim();
    const p = document.getElementById(
      'login-pass').value;
    if (!u || !p) {
      SC.ui.setAuthError('login', 'Fill all fields');
      return;
    }
    SC.ui.setAuthError('login', '');
    doLogin(u, p);
  };

  document.getElementById('login-pass')
    .onkeydown = e => {
      if (e.key === 'Enter')
        document.getElementById('login-btn').click();
    };

  // Register
  document.getElementById('reg-btn').onclick = () => {
    const u  = document.getElementById(
      'reg-user').value.trim();
    const p  = document.getElementById(
      'reg-pass').value;
    const p2 = document.getElementById(
      'reg-pass2').value;
    if (!u || !p) {
      SC.ui.setAuthError('reg', 'Fill all fields');
      return;
    }
    if (p !== p2) {
      SC.ui.setAuthError('reg',
        'Passwords do not match');
      return;
    }
    SC.ui.setAuthError('reg', '');
    doRegister(u, p);
  };

  // Add friend
  document.getElementById('add-friend-btn')
    .onclick = () => {
      SC.ui.showModal('Send Friend Request',
        SC.ui.modalInput('Username', 'Send Request',
          (val, err) => {
            if (!val) {
              err.textContent = 'Enter a username';
              return;
            }
            send({
              type:     'send_friend_request',
              username: val
            });
          }));
    };

  document.getElementById('friend-requests-btn')
    .onclick = () => {
      send({ type: 'get_friend_requests' });
      setTimeout(() => {
        SC.ui.showFriendRequests(
          pendingFriendRequests,
          (req) => {
            send({
              type:  'accept_friend_request',
              reqId: req.id
            });
            pendingFriendRequests =
              pendingFriendRequests.filter(
                r => r.id !== req.id);
            SC.ui.setFriendRequestBadge(
              pendingFriendRequests.length);
          },
          (req) => {
            send({
              type:  'decline_friend_request',
              reqId: req.id
            });
            pendingFriendRequests =
              pendingFriendRequests.filter(
                r => r.id !== req.id);
            SC.ui.setFriendRequestBadge(
              pendingFriendRequests.length);
          }
        );
      }, 300);
    };

  // Create group
  document.getElementById('create-group-btn')
    .onclick = () => {
      SC.ui.showModal('Create Group',
        SC.ui.modalInput('Group name', 'Create',
          (val, err) => {
            if (!val || val.length < 2) {
              err.textContent = 'Name too short';
              return;
            }
            send({ type: 'group_create', name: val });
          }));
    };

  // Create voice chat
  document.getElementById('create-vchat-btn')
    .onclick = () => {
      SC.ui.showModal('Create Voice Chat',
        SC.ui.modalInput('Voice chat name', 'Create',
          (val, err) => {
            if (!val || val.length < 2) {
              err.textContent = 'Name too short';
              return;
            }
            send({ type: 'vchat_create', name: val });
          }));
    };

  // Send message
  const sendMsg = async () => {
    const input = document.getElementById('msg-input');
    const text  = input.value.trim();
    if (!text || !currentChat) return;
    input.value = '';
    if (currentChat.type === 'dm')
      await sendDM(text);
    else
      await sendGroupMessage(text);
  };

  document.getElementById('send-btn')
    .onclick = sendMsg;
  document.getElementById('msg-input')
    .onkeydown = e => {
      if (e.key === 'Enter') sendMsg();
    };

  // Send file
  document.getElementById('send-file-btn')
    .onclick = () => {
      document.getElementById('file-input').click();
    };

document.getElementById('file-input')
    .onchange = async (e) => {
      const file = e.target.files[0];
      e.target.value = '';
      if (!file || !window._pendingSendPanel) return;

      const panel = window._pendingSendPanel;
      window._pendingSendPanel = null;

      // Show uploading indicator
      SC.tiler.appendSystem(panel.id,
        `Uploading "${file.name}"...`);

      try {
        const result = await SC.ft.upload(
          file,
          (done, total) => {
            // Could show progress here
          }
        );

        // Notify recipients via WebSocket
        send({
          type:     'file_share',
          toId:     panel.type === 'dm'
                    ? panel.chatId : undefined,
          groupId:  panel.type === 'group'
                    ? panel.chatId : undefined,
          url:      result.url,
          filename: result.filename,
          size:     result.size,
          mimetype: result.mimetype
        });

        // Show in sender's panel immediately
        SC.tiler.appendFile(panel.id, {
          fromUser:  myUsername,
          url:       result.url,
          filename:  result.filename,
          size:      result.size,
          mimetype:  result.mimetype,
          timestamp: Math.floor(Date.now() / 1000),
          isSelf:    true
        });

      } catch (err) {
        SC.tiler.appendSystem(panel.id,
          `Upload failed: ${err.message}`);
      }
    };

  // Group controls
  document.getElementById('invite-btn')
    .onclick = () => {
      if (!currentChat || currentChat.type !== 'group')
        return;
      SC.ui.showModal('Invite to Group',
        SC.ui.modalInput('Username', 'Invite',
          (val, err) => {
            if (!val) {
              err.textContent = 'Enter a username';
              return;
            }
            send({ type: 'group_invite',
                   groupId: currentChat.id,
                   username: val });
            // Close on success handled by group_invite_resp
          }));
    };

  document.getElementById('kick-btn')
    .onclick = () => {
      if (!currentChat || currentChat.type !== 'group')
        return;
      const group = groups.find(
        g => g.id === currentChat.id);
      if (!group) return;
      const wrap = document.createElement('div');
      group.members
        .filter(m => m.id !== myUserId)
        .forEach(m => {
          const row = document.createElement('div');
          row.className = 'member-row';
          row.innerHTML = `
            <span>${SC.esc(m.username)}</span>
            <button>Kick</button>
          `;
          row.querySelector('button').onclick = () => {
            send({ type: 'group_kick',
                   groupId: currentChat.id,
                   username: m.username });
          };
          wrap.appendChild(row);
        });
      SC.ui.showModal('Kick Member', wrap);
    };

  document.getElementById('members-btn')
    .onclick = () => {
      if (!currentChat || currentChat.type !== 'group')
        return;
      const group = groups.find(
        g => g.id === currentChat.id);
      if (!group) return;
      const list = group.members.map(m =>
        `<div class="member-row">
           <span>${SC.esc(m.username)}</span>
           ${m.id === group.creator_id
             ? '<span style="color:var(--yellow)">creator</span>'
             : ''}
         </div>`
      ).join('');
      SC.ui.showModal('Members', list);
    };

  document.getElementById('leave-group-btn')
    .onclick = () => {
      if (!currentChat || currentChat.type !== 'group')
        return;
      if (!confirm('Leave this group?')) return;
      send({ type: 'group_leave',
             groupId: currentChat.id });
    };

  // Voice controls
  document.getElementById('mute-btn').onclick = () => {
    const btn = document.getElementById('mute-btn');
    SC.voice.muted = !SC.voice.muted;
    SC.voice.setMuted(SC.voice.muted);
    btn.classList.toggle('active', SC.voice.muted);
    send({ type: 'vchat_state',
           vchatId: SC.voice.vchatId,
           muted:    SC.voice.muted,
           deafened: SC.voice.deafened });
  };

  document.getElementById('deaf-btn').onclick = () => {
    const btn = document.getElementById('deaf-btn');
    SC.voice.deafened = !SC.voice.deafened;
    SC.voice.setDeafened(SC.voice.deafened);
    btn.classList.toggle('active', SC.voice.deafened);
    send({ type: 'vchat_state',
           vchatId: SC.voice.vchatId,
           muted:    SC.voice.muted,
           deafened: SC.voice.deafened });
  };

  document.getElementById('hk-btn').onclick = () => {
    const bothOn =
      SC.voice.muted && SC.voice.deafened;
    SC.voice.muted    = !bothOn;
    SC.voice.deafened = !bothOn;
    SC.voice.setMuted(SC.voice.muted);
    SC.voice.setDeafened(SC.voice.deafened);
    document.getElementById('mute-btn')
      .classList.toggle('active', SC.voice.muted);
    document.getElementById('deaf-btn')
      .classList.toggle('active', SC.voice.deafened);
    send({ type: 'vchat_state',
           vchatId: SC.voice.vchatId,
           muted:    SC.voice.muted,
           deafened: SC.voice.deafened });
  };

  document.getElementById('leave-vc-btn')
    .onclick = leaveVChat;

  // Modal close
  document.getElementById('modal-close')
    .onclick = SC.ui.hideModal.bind(SC.ui);
  document.getElementById('modal-overlay')
    .onclick = (e) => {
      if (e.target.id === 'modal-overlay')
        SC.ui.hideModal();
    };

    // Settings button
  document.getElementById('settings-btn')
    .onclick = () => {
      document.getElementById('settings-overlay')
        .classList.remove('hidden');
    };

  document.getElementById('settings-close')
    .onclick = () => {
      document.getElementById('settings-overlay')
        .classList.add('hidden');
    };

  document.getElementById('settings-overlay')
    .onclick = (e) => {
      if (e.target.id === 'settings-overlay')
        document.getElementById('settings-overlay')
          .classList.add('hidden');
    };

  // Logout
  document.getElementById('logout-btn')
    .onclick = () => {
      document.getElementById('settings-overlay')
        .classList.add('hidden');
      logout();
    };

    window.SC.app = {

    onPanelClose(panel) {
      const key = chatKey(panel.type, panel.chatId);
      chatToPanel.delete(key);
      panelMap.delete(panel.id);
    },

    async onSendMessage(panel, text) {
      if (panel.type === 'dm') {
        const timestamp =
          Math.floor(Date.now() / 1000);

        // Always get fresh key before encrypting
        const pubKey = await getFreshPublicKey(
          panel.chatId);
        if (!pubKey) {
          SC.tiler.appendSystem(panel.id,
            '[error] Cannot encrypt: ' +
            'recipient has no public key. ' +
            'Ask them to log in first.');
          return;
        }

        const forRecipient =
          await SC.crypto.encrypt(text, pubKey);
        const forSelf =
          await SC.crypto.encrypt(
            text, identity.pub);

        send({
          type:             'send_msg',
          toId:             panel.chatId,
          ciphertext:       forRecipient.ciphertext,
          nonce:            forRecipient.nonce,
          ephemeralPub:     forRecipient.ephemeralPub,
          selfCiphertext:   forSelf.ciphertext,
          selfNonce:        forSelf.nonce,
          selfEphemeralPub: forSelf.ephemeralPub,
          timestamp
        });

        SC.tiler.appendMessage(panel.id, {
          timestamp,
          author: myUsername,
          text,
          isSelf: true
        });

      } else if (panel.type === 'group') {
        const group = groups.find(
          g => g.id === panel.chatId);
        if (!group) return;

        const timestamp =
          Math.floor(Date.now() / 1000);

        // Fetch fresh keys for all members
        const memberKeys = await Promise.all(
          group.members.map(async m => ({
            ...m,
            public_key: await getFreshPublicKey(m.id)
          }))
        );

        const allTargets = memberKeys.filter(
          m => m.public_key);

        const recipients = await Promise.all(
          allTargets.map(async m => ({
            userId: m.id,
            ...await SC.crypto.encrypt(
              text, m.public_key)
          }))
        );

        // Always include self
        if (!allTargets.find(
            m => m.id === myUserId)) {
          const forSelf =
            await SC.crypto.encrypt(
              text, identity.pub);
          recipients.push({
            userId: myUserId,
            ...forSelf
          });
        }

        send({
          type:       'group_send_msg',
          groupId:    group.id,
          recipients,
          timestamp
        });

        SC.tiler.appendMessage(panel.id, {
          timestamp,
          author: myUsername,
          text,
          isSelf: true
        });
      }
    },

    onSendFile(panel) {
      window._pendingSendPanel = panel;
      document.getElementById('file-input').click();
    },

    onGroupAction(panel, action) {
      const group = groups.find(
        g => g.id === panel.chatId);
      if (!group) return;

      switch (action) {
        case 'invite':
          SC.ui.showModal('Invite to Group',
            SC.ui.modalInput(
              'Username', 'Invite',
              (val, err) => {
                if (!val) {
                  err.textContent =
                    'Enter a username';
                  return;
                }
                send({
                  type:    'group_invite',
                  groupId: group.id,
                  username: val
                });
              }));
          break;

        case 'members': {
          const wrap =
            document.createElement('div');
          wrap.style.cssText =
            'display:flex;flex-direction:' +
            'column;gap:4px';
          group.members?.forEach(m => {
            const row =
              document.createElement('div');
            row.className = 'member-row';
            row.innerHTML = `
              <span>${SC.esc(m.username)}</span>
              ${m.id === group.creator_id
                ? '<span style="color:var(--yellow)">creator</span>'
                : ''}
            `;
            wrap.appendChild(row);
          });
          SC.ui.showModal(
            `# ${group.name} — Members`, wrap);
          break;
        }

        case 'kick': {
          const wrap =
            document.createElement('div');
          group.members
            ?.filter(m => m.id !== myUserId)
            .forEach(m => {
              const row =
                document.createElement('div');
              row.className = 'member-row';
              row.innerHTML = `
                <span>${SC.esc(m.username)}</span>
                <button style="background:none;
                  border:1px solid var(--red);
                  color:var(--red);
                  font-family:var(--font);
                  font-size:11px;padding:2px 8px;
                  cursor:pointer">
                  Kick
                </button>
              `;
              row.querySelector('button')
                 .addEventListener('click', () => {
                   send({
                     type:     'group_kick',
                     groupId:  group.id,
                     username: m.username
                   });
                   SC.ui.hideModal();
                 });
              wrap.appendChild(row);
            });
          SC.ui.showModal(
            `Kick from # ${group.name}`, wrap);
          break;
        }

        case 'leave':
          if (!confirm(
            `Leave group "${group.name}"?`))
            return;
          send({
            type:    'group_leave',
            groupId: group.id
          });
          break;

        case 'delete':
          if (!confirm(
            `Delete group "${group.name}"?\n` +
            `This cannot be undone.`)) return;
          send({
            type:    'group_delete',
            groupId: group.id
          });
          break;
      }
    },
  }
});