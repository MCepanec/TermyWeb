// UI helpers — all DOM manipulation lives here

window.SC = window.SC || {};

const $ = id => document.getElementById(id);

SC.ui = {
  // ── Auth ─────────────────────────────────────────────
  showAuth() {
    $('auth-screen').classList.remove('hidden');
    $('app-screen').classList.add('hidden');
  },

  showApp(username) {
    $('auth-screen').classList.add('hidden');
    $('app-screen').classList.remove('hidden');
    $('my-username').textContent = username;
  },

  setConnStatus(text, ok) {
    const el = $('conn-status');
    el.textContent = text;
    el.style.color = ok ? 'var(--green)' : 'var(--red)';
  },

  setAuthError(form, msg) {
    $(`${form}-err`).textContent = msg;
  },

  // ── Badge ─────────────────────────────────────────────

  setBadge(userId, count) {
    const el = document.querySelector(
      `#friend-list [data-id="${userId}"]`);
    if (!el) return;
    let badge = el.querySelector('.list-item-badge');
    if (count > 0) {
      if (!badge) {
        badge = document.createElement('span');
        badge.className = 'list-item-badge';
        el.appendChild(badge);
      }
      badge.textContent = count;
    } else if (badge) {
      badge.remove();
    }
  },

  setGroupBadge(groupId, count) {
    const el = document.querySelector(
      `#group-list [data-gid="${groupId}"]`);
    if (!el) return;
    let badge = el.querySelector('.list-item-badge');
    if (count > 0) {
      if (!badge) {
        badge = document.createElement('span');
        badge.className = 'list-item-badge';
        el.appendChild(badge);
      }
      badge.textContent = count;
    } else if (badge) {
      badge.remove();
    }
  },

  // ── Friends ───────────────────────────────────────────
  renderFriends(friends, myId, onChat) {
    const el = $('friend-list');
    el.innerHTML = '';
    if (!friends.length) {
      el.innerHTML =
        '<div class="list-item" style="color:var(--text-dim);cursor:default">' +
        'No friends yet</div>';
      return;
    }
    friends.forEach(f => {
      const div = document.createElement('div');
      div.className = 'list-item';
      div.dataset.id = f.id;
      div.innerHTML = `
        <div class="presence-dot ${f.online ? 'online' : ''}"></div>
        <span class="list-item-name">${esc(f.username)}</span>
        <span class="list-item-sub">${f.online ? 'online' : 'offline'}</span>
      `;
      div.onclick = () => onChat(f);
      el.appendChild(div);
    });
  },

  updatePresence(userId, online) {
    const el = document.querySelector(
      `#friend-list [data-id="${userId}"]`);
    if (!el) return;
    const dot = el.querySelector('.presence-dot');
    const sub = el.querySelector('.list-item-sub');
    if (online) { dot.classList.add('online');
                  sub.textContent = 'online'; }
    else        { dot.classList.remove('online');
                  sub.textContent = 'offline'; }
  },

  setActiveListItem(id) {
    document.querySelectorAll('.list-item')
      .forEach(el => el.classList.remove('active'));
    const el = document.querySelector(
      `.list-item[data-id="${id}"]`);
    if (el) el.classList.add('active');
  },

  // ── Groups ────────────────────────────────────────────
  renderGroups(groups, onOpen) {
    const el = $('group-list');
    el.innerHTML = '';
    if (!groups.length) {
      el.innerHTML =
        '<div class="list-item" style="color:var(--text-dim);cursor:default">' +
        'No groups yet</div>';
      return;
    }
    groups.forEach(g => {
      const div = document.createElement('div');
      div.className = 'list-item';
      div.dataset.gid = g.id;
      div.innerHTML = `
        <span class="list-item-name"># ${esc(g.name)}</span>
        <span class="list-item-sub">${g.members?.length ?? 0} members</span>
      `;
      div.onclick = () => onOpen(g);
      el.appendChild(div);
    });
  },

  // ── Voice chats ───────────────────────────────────────
  renderVChats(vchats, activeVchatId, myUserId,
               onJoin, onInvite, onMembers,
               onAbandon, onDelete) {
    const el = $('vchat-list');
    el.innerHTML = '';

    // Remove any existing context menu
    const old = document.getElementById(
      'vchat-ctx-menu');
    if (old) old.remove();

    if (!vchats.length) {
      el.innerHTML =
        '<div class="list-item" ' +
        'style="color:var(--text-dim);' +
        'cursor:default">No voice chats</div>';
      return;
    }

    // Build one shared context menu element
    const menu = document.createElement('div');
    menu.id        = 'vchat-ctx-menu';
    menu.className = 'ctx-menu hidden';
    document.body.appendChild(menu);

    const hideMenu = () =>
      menu.classList.add('hidden');

    document.addEventListener('click', hideMenu,
      { once: false });
    document.addEventListener('contextmenu',
      hideMenu, { once: false });

    vchats.forEach(v => {
      const inCall   = v.id === activeVchatId;
      const isCreator = v.creator_id === myUserId;

      const div = document.createElement('div');
      div.className = 'list-item';
      div.dataset.vid = v.id;
      div.innerHTML = `
        <span class="presence-dot
          ${v.activeCount > 0 ? 'online' : ''}">
        </span>
        <span class="list-item-name
          ${inCall ? 'vchat-item-active' : ''}">
          ♪ ${esc(v.name)}
        </span>
        ${v.activeCount > 0
          ? `<span class="list-item-sub"
                   style="color:var(--green)">
               ${v.activeCount} in call
             </span>`
          : ''}
        ${inCall
          ? `<span class="list-item-sub"
                   style="color:var(--accent)">
               ● you
             </span>`
          : ''}
      `;

      // Left click → join
      div.addEventListener('click', (e) => {
        e.stopPropagation();
        hideMenu();
        if (!inCall) onJoin(v);
      });

      // Right click → context menu
      div.addEventListener('contextmenu', (e) => {
        e.preventDefault();
        e.stopPropagation();

        // Build menu items
        const items = [];

        if (!inCall) {
          items.push({
            label: '▶ Join',
            action: () => onJoin(v)
          });
        }

        items.push({
          label: '+ Invite',
          action: () => onInvite(v)
        });

        items.push({
          label: '👥 Members',
          action: () => onMembers(v)
        });

        items.push({ sep: true });

        items.push({
          label: '✕ Abandon',
          cls:   'danger',
          action: () => onAbandon(v)
        });

        if (isCreator) {
          items.push({
            label: '🗑 Delete',
            cls:   'danger',
            action: () => onDelete(v)
          });
        }

        // Populate menu
        menu.innerHTML = '';
        items.forEach(item => {
          if (item.sep) {
            const sep =
              document.createElement('div');
            sep.className = 'ctx-sep';
            menu.appendChild(sep);
            return;
          }
          const btn =
            document.createElement('button');
          btn.className =
            'ctx-item' +
            (item.cls ? ' ' + item.cls : '');
          btn.textContent = item.label;
          btn.onclick = (ev) => {
            ev.stopPropagation();
            hideMenu();
            item.action();
          };
          menu.appendChild(btn);
        });

        // Position near cursor
        menu.classList.remove('hidden');
        const rect =
          menu.getBoundingClientRect();
        let x = e.clientX;
        let y = e.clientY;
        if (x + 160 > window.innerWidth)
          x = window.innerWidth - 164;
        if (y + rect.height > window.innerHeight)
          y = window.innerHeight - rect.height - 4;
        menu.style.left = x + 'px';
        menu.style.top  = y + 'px';
      });

      el.appendChild(div);
    });
  },

  // ── Voice status panel ────────────────────────────────
  showVoiceStatus(name) {
    $('voice-status').classList.remove('hidden');
    $('voice-status-name').textContent =
      `[vc] ${name}`;
  },

  hideVoiceStatus() {
    $('voice-status').classList.add('hidden');
    $('vu-meters').innerHTML = '';
  },

  updateVUMeters(speakers) {
    const el = $('vu-meters');

    speakers.forEach(spk => {
      let row = el.querySelector(
        `[data-uid="${spk.userId}"]`);
      if (!row) {
        row = document.createElement('div');
        row.className   = 'vu-row';
        row.dataset.uid = spk.userId;
        row.innerHTML = `
          <span class="vu-name"></span>
          <div class="vu-bar-bg">
            <div class="vu-bar-fill"></div>
          </div>
          <span class="vu-tag"></span>
        `;
        el.appendChild(row);
      }

      row.querySelector('.vu-name')
         .textContent = spk.username;

      const fill = row.querySelector(
        '.vu-bar-fill');
      const tag  = row.querySelector('.vu-tag');
      const pct  = Math.round(spk.amp * 100);

      const isSilent = spk.muted || spk.deafened;

      if (isSilent) {
        fill.style.width      = '0%';
        fill.style.background = 'var(--text-dim)';
      } else {
        fill.style.width = pct + '%';
        fill.style.background =
          pct < 30 ? 'var(--green)' :
          pct < 70 ? 'var(--yellow)' :
                     'var(--red)';
      }

      // Tag: show for mute, deafen, or both
      if (spk.muted && spk.deafened) {
        tag.textContent = 'HK';
        tag.style.color = 'var(--text-dim)';
      } else if (spk.muted) {
        tag.textContent = 'MUTE';
        tag.style.color = 'var(--text-dim)';
      } else if (spk.deafened) {
        tag.textContent = 'DEAF';
        tag.style.color = 'var(--text-dim)';
      } else {
        tag.textContent = '';
      }
    });

    // Remove rows for speakers no longer present
    el.querySelectorAll('.vu-row').forEach(row => {
      if (!speakers.find(
          s => String(s.userId) ===
               row.dataset.uid))
        row.remove();
    });
  },

  // ── Chat window ───────────────────────────────────────
  openChat(title, subtitle, opts = {}) {
    $('welcome-screen').classList.add('hidden');
    $('chat-window').classList.remove('hidden');
    $('chat-title').textContent    = title;
    $('chat-subtitle').textContent = subtitle;
    $('messages').innerHTML        = '';
    // Clear file offers from previous chat
    this.clearFileOffers();

    const show = (id, val) => {
      const el = $(id);
      if (val) el.classList.remove('hidden');
      else     el.classList.add('hidden');
    };
    show('members-btn',     !!opts.isGroup);
    show('invite-btn',      !!opts.isGroup);
    show('kick-btn',        !!opts.isCreator);
    show('leave-group-btn', !!opts.isGroup);
  },

  appendMessage(msg) {
    const el = $('messages');
    // Date separator
    const d    = new Date(msg.timestamp * 1000);
    const date = d.toLocaleDateString();
    const last = el.dataset.lastDate;
    if (date !== last) {
      el.dataset.lastDate = date;
      const sep = document.createElement('div');
      sep.className   = 'date-sep';
      sep.textContent = date;
      el.appendChild(sep);
    }

    const row = document.createElement('div');
    row.className = 'msg' +
      (msg.system ? ' system' : '') +
      (msg.fileOffer ? ' file-offer' : '');

    const time = d.toLocaleTimeString([], {
      hour: '2-digit', minute: '2-digit' });

    row.innerHTML = `
      <span class="msg-time">${time}</span>
      <span class="msg-author ${msg.isSelf ? 'self' : 'other'}">
        ${esc(msg.author)}
      </span>
      <span class="msg-text">${esc(msg.text)}</span>
    `;
    el.appendChild(row);
    el.scrollTop = el.scrollHeight;
  },

  appendSystemMsg(text) {
    this.appendMessage({
      timestamp: Math.floor(Date.now() / 1000),
      author: '*', text, system: true
    });
  },

  // ── Modal ─────────────────────────────────────────────
  showModal(title, body) {
    $('modal-title').textContent = title;
    $('modal-body').innerHTML    = '';
    if (typeof body === 'string')
      $('modal-body').innerHTML  = body;
    else
      $('modal-body').appendChild(body);
    $('modal-overlay').classList.remove('hidden');
  },

  hideModal() {
    $('modal-overlay').classList.add('hidden');
  },

  modalInput(placeholder, btnText, onSubmit) {
    const wrap = document.createElement('div');
    wrap.innerHTML = `
      <input type="text" placeholder="${esc(placeholder)}"
             style="width:100%">
      <button>${esc(btnText)}</button>
      <div class="err"></div>
    `;
    const input = wrap.querySelector('input');
    const btn   = wrap.querySelector('button');
    const err   = wrap.querySelector('.err');
    btn.onclick = () => onSubmit(
      input.value.trim(), err);
    input.onkeydown = e => {
      if (e.key === 'Enter')
        onSubmit(input.value.trim(), err);
    };
    return wrap;
  },

  // ── File notifications ────────────────────────────────
  showFileOffer(offer, onAccept, onReject) {
    // Only show if a chat is open
    const container = document.getElementById(
      'chat-file-offers');
    if (!container) return;

    // Don't show duplicate
    if (container.querySelector(
        `[data-tid="${offer.transferId}"]`)) return;

    const div = document.createElement('div');
    div.className   = 'chat-file-offer';
    div.dataset.tid = offer.transferId;
    div.innerHTML = `
      <div class="chat-file-offer-info">
        <div class="chat-file-offer-from">
          [file offer] from ${esc(offer.fromUser)}
        </div>
        <div class="chat-file-offer-name">
          ${esc(offer.filename)}
        </div>
        <div class="chat-file-offer-size">
          ${formatBytes(offer.fileSize)}
        </div>
        <div class="chat-file-offer-progress
                    hidden">
          <div class="chat-file-offer-progress-fill">
          </div>
        </div>
      </div>
      <div class="chat-file-offer-actions">
        <button class="accept">Accept</button>
        <button class="reject">Reject</button>
      </div>
    `;

    div.querySelector('.accept').onclick = () => {
      div.querySelector('.accept').textContent =
        'Accepting...';
      div.querySelector('.accept').disabled = true;
      div.querySelector('.reject').disabled = true;
      div.querySelector(
        '.chat-file-offer-progress')
        .classList.remove('hidden');
      onAccept(offer, div);
    };

    div.querySelector('.reject').onclick = () => {
      onReject(offer);
      div.remove();
    };

    container.appendChild(div);
  },

  updateFileProgress(transferId, done, total) {
    const div = document.querySelector(
      `.chat-file-offer[data-tid="${transferId}"]`);
    if (!div) return;
    const fill = div.querySelector(
      '.chat-file-offer-progress-fill');
    if (!fill) return;
    const pct = total > 0
      ? Math.round(done * 100 / total) : 0;
    fill.style.width = pct + '%';
    if (pct >= 100) {
      setTimeout(() => div.remove(), 1500);
    }
  },

  showFileComplete(filename, blob) {
    // Trigger browser download
    const url = URL.createObjectURL(blob);
    const a   = document.createElement('a');
    a.href     = url;
    a.download = filename;
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
    setTimeout(() => URL.revokeObjectURL(url), 1000);

    this.appendSystemMsg(`✓ Downloaded: ${filename}`);
  },

  clearFileOffers() {
    const el = document.getElementById(
      'chat-file-offers');
    if (el) el.innerHTML = '';
  },

  updateFileProgress(transferId, done, total) {
    const div = document.querySelector(
      `.file-notif[data-tid="${transferId}"]`);
    if (!div) return;
    const prog = div.querySelector('.file-progress');
    const fill = div.querySelector('.file-progress-fill');
    prog.style.display = 'block';
    const pct = total > 0
      ? Math.round(done * 100 / total) : 0;
    fill.style.width = pct + '%';
    if (pct >= 100) {
      setTimeout(() => div.remove(), 2000);
    }
  },

  showFileComplete(filename, blob, autoOpen) {
    // Trigger browser download
    const url = URL.createObjectURL(blob);
    const a   = document.createElement('a');
    a.href     = url;
    a.download = filename;
    a.click();
    URL.revokeObjectURL(url);

    if (autoOpen) window.open(url, '_blank');

    this.appendSystemMsg(
      `File saved: ${filename}`);
  }
};

// ── Utilities ──────────────────────────────────────────
function esc(str) {
  return String(str ?? '')
    .replace(/&/g,'&amp;')
    .replace(/</g,'&lt;')
    .replace(/>/g,'&gt;')
    .replace(/"/g,'&quot;');
}

function formatBytes(bytes) {
  if (bytes < 1024) return bytes + ' B';
  if (bytes < 1024*1024)
    return (bytes/1024).toFixed(1) + ' KB';
  if (bytes < 1024*1024*1024)
    return (bytes/1024/1024).toFixed(1) + ' MB';
  return (bytes/1024/1024/1024).toFixed(2) + ' GB';
}

window.SC.esc         = esc;
window.SC.formatBytes = formatBytes;