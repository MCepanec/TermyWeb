// Main application logic
// Connects to WebSocket server and orchestrates all features

const WS_URL = `ws://${location.host}`;

let ws         = null;
let identity   = null; // { publicKey, privateKey, pub }
let myUserId   = null;
let myUsername = null;

// State
let friends    = [];
let groups     = [];
let vchats     = [];
let currentChat = null; // {type:'dm'|'group', id, data}
let fileAliasCounter = 1;
const fileAliases = new Map(); // alias → transferId
const pendingOffers = new Map(); // transferId → offer
// Panel map: panelId → {type, chatId}
const panelMap  = new Map();
// Reverse: `${type}_${chatId}` → panelId
const chatToPanel = new Map();

function chatKey(type, chatId) {
  return `${type}_${chatId}`;
}
let pendingMembersVchatId = null;

// ── WebSocket ──────────────────────────────────────────
function connect() {
  ws = new WebSocket(WS_URL);

  ws.onopen = () => {
    SC.ui.setConnStatus('Connected', true);
  };

  ws.onclose = () => {
    SC.ui.setConnStatus('Disconnected — reconnecting...', false);
    setTimeout(connect, 3000);
  };

  ws.onerror = () => {
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

// ── Message handler ────────────────────────────────────
async function handleMessage(msg) {
  switch (msg.type) {

    case 'login_resp':
      if (msg.ok) {
        myUserId   = msg.userId;
        myUsername = msg.username;
        SC.ui.showApp(msg.username);
        loadFriends();
        loadGroups();
        loadVChats();
      } else {
        SC.ui.setAuthError('login', msg.msg);
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
      SC.ui.renderFriends(friends, myUserId,
        openDMChat);
      break;

    case 'add_friend_resp':
      if (msg.ok) {
        SC.ui.hideModal();
        loadFriends();
      }
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
      SC.ui.renderGroups(groups, openGroupChat);
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

    case 'file_offer_sent':
      // Remap temp key → real transferId
      for (const [k, v] of pendingFiles.entries()) {
        if (k.startsWith('temp_')) {
          pendingFiles.set(msg.transferId, v);
          pendingFiles.delete(k);
          break;
        }
      }
      break;

    case 'file_offer':
      onFileOfferReceived(msg);
      break;

    case 'file_accepted':
      // Recipient accepted — start sending
      onFileAccepted(msg);
      break;

    case 'file_chunk':
      await onFileChunk(msg);
      break;

    case 'file_chunk_ack':
      SC.ft.onChunkAck(msg.transferId, msg.chunkIdx);
      break;

    case 'file_complete':
      SC.ui.updateFileProgress(
        msg.transferId, 1, 1);
      break;

    case 'file_cancel':
      SC.ui.appendSystemMsg(
        `Transfer cancelled: ${msg.reason}`);
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
  }
}

// ── Auth ───────────────────────────────────────────────
async function doLogin(username, password) {
  if (!identity) {
    identity = await SC.crypto.loadOrCreateIdentity();
  }
  send({ type: 'login', username, password,
         publicKey: identity.pub });
}

async function doRegister(username, password) {
  if (!identity) {
    identity = await SC.crypto.loadOrCreateIdentity();
  }
  send({ type: 'register', username, password,
         publicKey: identity.pub });
}

function logout() {
  myUserId = myUsername = null;
  currentChat = null;
  friends = groups = vchats = [];
  SC.voice.leave();
  SC.ui.showAuth();
  SC.ui.hideVoiceStatus();
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
      msg.ciphertext, msg.nonce,
      msg.ephemeralPub, identity.privateKey);
  } catch { text = '[decryption failed]'; }

  const key = chatKey('dm', msg.fromId);
  const panelId = chatToPanel.get(key);

  if (panelId != null) {
    SC.tiler.appendMessage(panelId, {
      timestamp: msg.timestamp,
      author:    msg.fromUser,
      text,
      isSelf:    false
    });
  } else {
    const k = `dm_${msg.fromId}`;
    unread.set(k, (unread.get(k) ?? 0) + 1);
    SC.ui.setBadge(msg.fromId, unread.get(k));
    playNotifSound();
  }
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
  const key = chatKey('dm', msg.withId);
  const panelId = chatToPanel.get(key);
  if (panelId == null) return;
  // Clear existing messages first
  const el = SC.tiler.root.querySelector(
    `[data-pid="${panelId}"] .t-messages`);
  if (el) { el.innerHTML = '';
             delete el.dataset.lastDate; }
  for (const m of msg.messages) {
    let text;
    try {
      text = await SC.crypto.decrypt(
        m.ciphertext, m.nonce,
        m.ephemeral_pub, identity.privateKey);
    } catch { text = '[decryption failed]'; }
    SC.tiler.appendMessage(panelId, {
      timestamp: m.timestamp_unix,
      author:    m.from_username,
      text,
      isSelf:    m.from_id === myUserId
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
      msg.ciphertext, msg.nonce,
      msg.ephemeralPub, identity.privateKey);
  } catch { text = '[decryption failed]'; }

  const key = chatKey('group', msg.groupId);
  const panelId = chatToPanel.get(key);

  if (panelId != null) {
    SC.tiler.appendMessage(panelId, {
      timestamp: msg.timestamp,
      author:    msg.fromUser,
      text,
      isSelf:    false
    });
  } else {
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
  const key = chatKey('group', msg.groupId);
  const panelId = chatToPanel.get(key);
  if (panelId == null) return;
  const el = SC.tiler.root.querySelector(
    `[data-pid="${panelId}"] .t-messages`);
  if (el) { el.innerHTML = '';
             delete el.dataset.lastDate; }
  for (const m of msg.messages) {
    let text;
    try {
      text = await SC.crypto.decrypt(
        m.ciphertext, m.nonce,
        m.ephemeral_pub, identity.privateKey);
    } catch { text = '[decryption failed]'; }
    SC.tiler.appendMessage(panelId, {
      timestamp: m.timestamp_unix,
      author:    m.from_username,
      text,
      isSelf:    m.from_id === myUserId
    });
  }
}

// ── File transfer ──────────────────────────────────────

function onFileOfferReceived(offer) {
  const alias = 'file' + (fileAliasCounter++);
  fileAliases.set(alias, offer.transferId);
  pendingOffers.set(offer.transferId, offer);

  // Find the panel for this sender
  const key = chatKey('dm', offer.fromId);
  const panelId = chatToPanel.get(key);

  const doShow = (pid) => {
    if (pid != null) {
      SC.tiler.showFileOffer(pid, offer,
        async (o, row) => {
          try {
            await SC.ft.acceptOffer(
              o.transferId, o.encKey,
              o.filename, identity.privateKey);
            send({ type: 'file_offer_resp',
                   transferId: o.transferId,
                   accept: true });
          } catch (err) {
            console.error('Accept error:', err);
          }
        },
        (o) => {
          send({ type: 'file_offer_resp',
                 transferId: o.transferId,
                 accept: false });
          pendingOffers.delete(o.transferId);
        }
      );
    } else {
      // No panel open — show badge
      SC.ui.setBadge(
        offer.fromId,
        (unread.get(`dm_${offer.fromId}`) ?? 0) + 1);
      playNotifSound();
    }
  };

  doShow(panelId);
}

function onFileAccepted(msg) {
  // Sender side: recipient accepted, start sending
  const file = pendingFiles.get(msg.transferId);
  if (!file) {
    // Try to find by temp key
    for (const [k, v] of pendingFiles.entries()) {
      if (k.startsWith('temp_')) {
        pendingFiles.set(msg.transferId, v);
        pendingFiles.delete(k);
        break;
      }
    }
  }
  const resolvedFile = pendingFiles.get(msg.transferId);
  if (!resolvedFile) return;

  if (!SC.ft.fileKeys.has(msg.transferId)) {
    for (const [k, v] of SC.ft.fileKeys.entries()) {
      if (k.startsWith('temp_')) {
        SC.ft.fileKeys.set(msg.transferId, v);
        SC.ft.fileKeys.delete(k);
        break;
      }
    }
  }

  SC.ft.onTransferAccepted(
    msg.transferId,
    msg.receiverId,
    resolvedFile,
    send,
    (done, total) => {
      SC.ui.updateFileProgress(
        msg.transferId, done, total);
    }
  );
}

async function onFileChunk(msg) {
  await SC.ft.onChunk(
    msg.transferId, msg.data, msg.nonce,
    msg.isLast, send,
    (done) => {
      const offer =
        pendingOffers.get(msg.transferId);
      SC.tiler.updateFileProgress(
        msg.transferId, done,
        offer?.fileSize ?? done);
    },
    (blob, filename) => {
      SC.ui.showFileComplete(filename, blob);
      pendingOffers.delete(msg.transferId);
    }
  );
}

// Track files pending send
const pendingFiles = new Map();

async function sendFileToPanel(file, panel) {
  let recipients;
  if (panel.type === 'dm') {
    const f = friends.find(
      x => x.id === panel.chatId);
    if (!f?.public_key) return;
    recipients = [f];
  } else {
    const g = groups.find(
      x => x.id === panel.chatId);
    if (!g) return;
    recipients = g.members.filter(
      m => m.id !== myUserId && m.public_key);
  }
  if (!recipients.length) return;

  const key    =
    await SC.crypto.generateFileKey();
  const keyB64 =
    await SC.crypto.exportFileKey(key);
  const encKeys = await Promise.all(
    recipients.map(async r => ({
      userId: r.id,
      encKey: JSON.stringify(
        await SC.crypto.encrypt(
          keyB64, r.public_key))
    }))
  );

  const tempId = 'temp_' + Date.now();
  pendingFiles.set(tempId, file);
  SC.ft.fileKeys.set(tempId, { key, file });

  send({
    type:     'file_offer',
    filename: file.name,
    fileSize: file.size,
    toId:     panel.type === 'dm'
              ? panel.chatId : undefined,
    groupId:  panel.type === 'group'
              ? panel.chatId : undefined,
    encKeys
  });

  SC.tiler.appendSystem(panel.id,
    `[sending] "${file.name}" ` +
    `(${SC.formatBytes(file.size)})`);
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
      SC.ui.showModal('Add Friend',
        SC.ui.modalInput('Username', 'Add',
          (val, err) => {
            if (!val) {
              err.textContent = 'Enter a username';
              return;
            }
            send({ type: 'add_friend',
                   username: val });
          }));
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
      if (file) {
        const panel = window._pendingSendPanel;
        if (panel)
          await sendFileToPanel(file, panel);
      }
      e.target.value = '';
      window._pendingSendPanel = null;
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
        const friend = friends.find(
          f => f.id === panel.chatId);
        if (!friend?.public_key) return;
        const bundle =
          await SC.crypto.encrypt(
            text, friend.public_key);
        const timestamp =
          Math.floor(Date.now() / 1000);
        send({ type: 'send_msg',
               toId: friend.id,
               ...bundle, timestamp });
        SC.tiler.appendMessage(panel.id, {
          timestamp, author: myUsername,
          text, isSelf: true
        });
      } else if (panel.type === 'group') {
        const group = groups.find(
          g => g.id === panel.chatId);
        if (!group) return;
        const timestamp =
          Math.floor(Date.now() / 1000);
        const recipients =
          await Promise.all(
            group.members
              .filter(m => m.id !== myUserId
                        && m.public_key)
              .map(async m => ({
                userId: m.id,
                ...await SC.crypto.encrypt(
                  text, m.public_key)
              }))
          );
        send({ type: 'group_send_msg',
               groupId: group.id,
               recipients, timestamp });
        SC.tiler.appendMessage(panel.id, {
          timestamp, author: myUsername,
          text, isSelf: true
        });
      }
    },

    onSendFile(panel) {
      // Store which panel triggered the send
      window._pendingSendPanel = panel;
      document.getElementById('file-input')
        .click();
    },

    onGroupAction(panel, action) {
      const group = groups.find(
        g => g.id === panel.chatId);
      if (!group) return;
      if (action === 'invite') {
        SC.ui.showModal('Invite to Group',
          SC.ui.modalInput('Username', 'Invite',
            (val, err) => {
              if (!val) return;
              send({ type: 'group_invite',
                     groupId: group.id,
                     username: val });
              SC.ui.hideModal();
            }));
      } else if (action === 'members') {
        const wrap =
          document.createElement('div');
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
      } else if (action === 'leave') {
        if (!confirm('Leave this group?')) return;
        send({ type: 'group_leave',
               groupId: group.id });
      } else if (action === 'delete') {
        if (!confirm('Delete this group?')) return;
        alert('Group delete is not implemented on the server yet.');
      }
    }
  }
});