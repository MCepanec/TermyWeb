// ── SecureChat Tiling Window Manager ─────────────────────────
// 2D grid layout: panels fill rows and columns.
// Drag column dividers → resize columns (all rows follow).
// Drag row dividers    → resize rows    (all cols follow).
// Each panel has a context menu on right-click (groups).
// Header buttons collapse to icons then hide as panel shrinks.

window.SC = window.SC || {};

// ─────────────────────────────────────────────────────────────
// Layout model
//
// panels: [{id, type, chatId, title, chatData, col, row}]
// cols:   [flex, flex, ...]   — column widths
// rows:   [flex, flex, ...]   — row heights
//
// Panels are placed into a virtual grid.
// When a new panel opens we try to fill empty cells first,
// then add a new column, then add a new row.
// Max grid: 3 columns × 3 rows = 9 panels.
// ─────────────────────────────────────────────────────────────

class TileManager {
  constructor(rootEl) {
    this.root   = rootEl;
    this.panels = [];   // {id,type,chatId,title,chatData,col,row}
    this.cols   = [];   // flex values per column
    this.rows   = [];   // flex values per row
    this.nextId = 1;

    // Context menu element shared across all panels
    this._ctxMenu = null;
    this._makeCtxMenu();

    // ResizeObserver to update button visibility
    this._ro = new ResizeObserver(
      entries => this._onResize(entries));
  }

  // ── Public API ───────────────────────────────────────────

  open(type, chatId, title, chatData) {
    const existing = this.panels.find(
      p => p.type === type && p.chatId === chatId);
    if (existing) {
      this._flash(existing.id);
      return existing.id;
    }

    const { col, row } = this._allocCell();
    const id = this.nextId++;
    this.panels.push({
      id, type, chatId, title, chatData, col, row
    });
    this._render();
    return id;
  }

  close(panelId) {
    const p = this.panels.find(x => x.id === panelId);
    if (!p) return;
    this.panels = this.panels.filter(
      x => x.id !== panelId);
    this._pruneGrid();
    this._render();
  }

  appendMessage(panelId, msg) {
    const el = this._msgEl(panelId);
    if (el) _appendMsg(el, msg);
  }

  appendFile(panelId, fileMsg) {
    const el = this._msgEl(panelId);
    if (el) _appendFile(el, fileMsg);
  }

  appendSystem(panelId, text) {
    this.appendMessage(panelId, {
      timestamp: Math.floor(Date.now() / 1000),
      author: '*', text, system: true
    });
  }

  findPanel(type, chatId) {
    return this.panels.find(
      p => p.type === type && p.chatId === chatId);
  }

  _flash(panelId) {
    const el = this.root.querySelector(
      `[data-pid="${panelId}"]`);
    if (!el) return;
    el.classList.add('t-flash');
    setTimeout(() =>
      el.classList.remove('t-flash'), 600);
  }

  _msgEl(panelId) {
    return this.root.querySelector(
      `[data-pid="${panelId}"] .t-messages`);
  }

  _foEl(panelId) {
    return this.root.querySelector(
      `[data-pid="${panelId}"] .t-file-offers`);
  }

  // ── Grid allocation ──────────────────────────────────────

  _allocCell() {
    const maxCols = 3, maxRows = 3;
    const occupied = new Set(
      this.panels.map(p => `${p.col},${p.row}`));

    const nCols = this.cols.length || 0;
    const nRows = this.rows.length || 0;

    if (nCols === 0) {
      this.cols.push(1);
    }
    if (nRows === 0) {
      this.rows.push(1);
    }

    // Find first empty cell in existing grid
    for (let r = 0; r < this.rows.length; r++) {
      for (let c = 0; c < this.cols.length; c++) {
        if (!occupied.has(`${c},${r}`)) {
          return { col: c, row: r };
        }
      }
    }

    // Add rows and columns in a balanced way
    if (this.cols.length >= this.rows.length &&
        this.rows.length < maxRows) {
      const newRow = this.rows.length;
      this.rows.push(1);
      this._normaliseFlex(this.rows);
      return { col: 0, row: newRow };
    }

    if (this.cols.length < maxCols) {
      const newCol = this.cols.length;
      this.cols.push(1);
      this._normaliseFlex(this.cols);
      return { col: newCol, row: 0 };
    }

    if (this.rows.length < maxRows) {
      const newRow = this.rows.length;
      this.rows.push(1);
      this._normaliseFlex(this.rows);
      return { col: 0, row: newRow };
    }

    // Grid full — keep panel in next available row
    return { col: 0, row: this.rows.length };
  }

  _pruneGrid() {
    if (this.panels.length === 0) {
      this.cols = [];
      this.rows = [];
      return;
    }

    const usedCols = new Set(
      this.panels.map(p => p.col));
    const usedRows = new Set(
      this.panels.map(p => p.row));

    const maxCol = Math.max(...usedCols);
    const maxRow = Math.max(...usedRows);

    // Trim cols/rows arrays
    this.cols = this.cols.slice(0, maxCol + 1);
    this.rows = this.rows.slice(0, maxRow + 1);

    this._normaliseFlex(this.cols);
    this._normaliseFlex(this.rows);
  }

  _normaliseFlex(arr) {
    if (!arr.length) return;
    const n   = arr.length;
    const sum = arr.reduce((a, b) => a + b, 0);
    for (let i = 0; i < n; i++)
      arr[i] = (arr[i] / sum) * n;
  }

  // ── Rendering ────────────────────────────────────────────

  _render() {
    const root    = this.root;
    const welcome = document.getElementById(
      'welcome-screen');

    if (this.panels.length === 0) {
      // Disconnect ResizeObserver
      this._ro.disconnect();
      root.innerHTML    = '';
      root.style.display = 'none';
      if (welcome) welcome.classList.remove('hidden');
      return;
    }

    if (welcome) welcome.classList.add('hidden');
    root.style.display = 'grid';

    const nCols = this.cols.length;
    const nRows = this.rows.length;

    // Preserve message content per panel
    const saved = {};
    root.querySelectorAll('[data-pid]').forEach(el => {
      const pid = el.dataset.pid;
      const msgs  = el.querySelector('.t-messages');
      const fo    = el.querySelector('.t-file-offers');
      saved[pid] = {
        msgHTML:  msgs?.innerHTML  ?? '',
        foHTML:   fo?.innerHTML    ?? '',
        scroll:   msgs?.scrollTop  ?? 0,
        lastDate: msgs?.dataset.lastDate ?? ''
      };
    });

    this._ro.disconnect();
    root.innerHTML = '';

    // Build column dividers + cells using CSS grid
    // We build the grid as a flat list of elements
    // with explicit grid-column and grid-row placement.

    // Grid template: columns with dividers
    // col 1 | div | col 2 | div | col 3
    // Each actual col → 2 grid tracks: content + divider
    // Last col has no divider
    const colTracks = [];
    for (let c = 0; c < nCols; c++) {
      colTracks.push(`${this.cols[c]}fr`);
      if (c < nCols - 1) colTracks.push('4px');
    }

    const rowTracks = [];
    for (let r = 0; r < nRows; r++) {
      rowTracks.push(`${this.rows[r]}fr`);
      if (r < nRows - 1) rowTracks.push('4px');
    }

    root.style.gridTemplateColumns =
      colTracks.join(' ');
    root.style.gridTemplateRows =
      rowTracks.join(' ');

    // Track index: content col c → grid col 2c+1
    // divider between col c and c+1 → grid col 2c+2
    const gCol = c => 2 * c + 1;
    const gRow = r => 2 * r + 1;

    // Render panels
    this.panels.forEach(panel => {
      const el = document.createElement('div');
      el.className   = 't-panel';
      el.dataset.pid = panel.id;
      el.style.gridColumn = gCol(panel.col);
      el.style.gridRow    = gRow(panel.row);

      const typeTag =
        panel.type === 'dm'    ? '[dm]' :
        panel.type === 'group' ? '[grp]' : '[ch]';

      const isGroup  = panel.type === 'group';

      el.innerHTML = `
        <div class="t-header">
          <div class="t-header-left">
            <span class="t-type-tag">${typeTag}</span>
            <span class="t-title">
              ${esc(panel.title)}
            </span>
          </div>
          <div class="t-header-right">
            ${isGroup ? `
              <button class="t-hbtn t-hbtn--word"
                      data-action="members">
                Members
              </button>
              <button class="t-hbtn t-hbtn--word"
                      data-action="invite">
                Invite
              </button>
              <button class="t-hbtn t-hbtn--icon"
                      data-action="members"
                      title="Members">👥</button>
              <button class="t-hbtn t-hbtn--icon"
                      data-action="invite"
                      title="Invite">+</button>
            ` : ''}
            <button class="t-hbtn t-close-btn"
                    title="Close">✕</button>
          </div>
        </div>
        <div class="t-messages"></div>
        <div class="t-input-row">
          <input class="t-input" type="text"
                 placeholder="Message..."
                 autocomplete="off">
          <button class="t-file-btn"
                  title="Send file">📎</button>
          <button class="t-send-btn">Send</button>
        </div>
      `;

      // Restore content
      const s = saved[panel.id];
      if (s) {
        const msgs = el.querySelector('.t-messages');
        const fo   = el.querySelector('.t-file-offers');
        if (msgs) {
          msgs.innerHTML        = s.msgHTML;
          msgs.dataset.lastDate = s.lastDate;
          setTimeout(() =>
            msgs.scrollTop = s.scroll, 0);
        }
        if (fo) fo.innerHTML = s.foHTML;
      }

      // Wire close
      el.querySelector('.t-close-btn')
        .onclick = () => {
          if (window.SC.app?.onPanelClose)
            window.SC.app.onPanelClose(panel);
          this.close(panel.id);
        };

      // Wire file button
      el.querySelector('.t-file-btn')
        .onclick = () => {
          if (window.SC.app?.onSendFile)
            window.SC.app.onSendFile(panel);
        };

      // Wire header action buttons
      el.querySelectorAll('[data-action]')
        .forEach(btn => {
          btn.onclick = () => {
            if (window.SC.app?.onGroupAction)
              window.SC.app.onGroupAction(
                panel, btn.dataset.action);
          };
        });

      // Wire send
      const input   = el.querySelector('.t-input');
      const sendBtn = el.querySelector('.t-send-btn');
      const doSend  = () => {
        const text = input.value.trim();
        if (!text) return;
        input.value = '';
        window.SC.app?.onSendMessage(panel, text);
      };
      sendBtn.onclick    = doSend;
      input.onkeydown    = e => {
        if (e.key === 'Enter') doSend();
      };

    // Right-click context menu for groups
    if (isGroup) {
      // Header buttons (invite, members, kick)
      el.querySelectorAll(
        '.tile-hbtn[data-action]')
        .forEach(btn => {
          const action = btn.dataset.action;
          if (action === 'group-ctx') return;
          btn.addEventListener('click', e => {
            e.stopPropagation();
            window.SC.app?.onGroupAction(
              panel, action);
          });
        });

      // ⋮ button and right-click both
      // show the same context menu
      const buildGroupCtxItems = () => [
        { header: '# ' + panel.title },
        {
          icon:   '+',
          label:  'Invite',
          action: () =>
            window.SC.app?.onGroupAction(
              panel, 'invite')
        },
        {
          icon:   '👥',
          label:  'Members',
          action: () =>
            window.SC.app?.onGroupAction(
              panel, 'members')
        },
        {
          icon:   '✕',
          label:  'Kick Member',
          action: () =>
            window.SC.app?.onGroupAction(
              panel, 'kick')
        },
        { sep: true },
        {
          icon:   '→',
          label:  'Leave Group',
          cls:    'danger',
          action: () =>
            window.SC.app?.onGroupAction(
              panel, 'leave')
        },
        {
          icon:   '🗑',
          label:  'Delete Group',
          cls:    'danger',
          action: () =>
            window.SC.app?.onGroupAction(
              panel, 'delete')
        }
      ];

      const ctxBtn =
        el.querySelector('.tile-ctx-btn');
      if (ctxBtn) {
        ctxBtn.addEventListener('click', e => {
          e.stopPropagation();
          const r = ctxBtn.getBoundingClientRect();
          SC.ctx.show(
            r.left, r.bottom + 4,
            buildGroupCtxItems());
        });
      }

      // Right-click anywhere on panel
      // except message area
      el.addEventListener('contextmenu', e => {
        if (e.target.closest('.tile-messages'))
          return;
        e.preventDefault();
        e.stopPropagation();
        SC.ctx.show(
          e.clientX, e.clientY,
          buildGroupCtxItems());
      });
    }

      root.appendChild(el);
      this._ro.observe(el);
    });

    // Render column dividers
    for (let c = 0; c < nCols - 1; c++) {
      for (let r = 0; r < nRows; r++) {
        const div = document.createElement('div');
        div.className = 't-divider t-divider--col';
        div.style.gridColumn = gCol(c) + 1;
        div.style.gridRow    = gRow(r);
        this._bindColDivider(div, c);
        root.appendChild(div);
      }
    }

    // Render row dividers
    for (let r = 0; r < nRows - 1; r++) {
      for (let c = 0; c < nCols; c++) {
        const div = document.createElement('div');
        div.className = 't-divider t-divider--row';
        div.style.gridColumn = gCol(c);
        div.style.gridRow    = gRow(r) + 1;
        this._bindRowDivider(div, r);
        root.appendChild(div);
      }
    }

    // Also fill divider intersections
    for (let c = 0; c < nCols - 1; c++) {
      for (let r = 0; r < nRows - 1; r++) {
        const corner = document.createElement('div');
        corner.className = 't-divider-corner';
        corner.style.gridColumn = gCol(c) + 1;
        corner.style.gridRow    = gRow(r) + 1;
        root.appendChild(corner);
      }
    }
  }

  // ── Divider dragging ─────────────────────────────────────

  _bindColDivider(el, colIdx) {
    el.addEventListener('mousedown', (e) => {
      e.preventDefault();
      el.classList.add('t-divider--active');
      const startX     = e.clientX;
      const startFlex  = [...this.cols];
      const totalW     = this.root.clientWidth;

      const onMove = (e) => {
        const dx    = e.clientX - startX;
        const delta = dx / totalW *
          this.cols.reduce((a, b) => a + b, 0);
        const minF  = 0.15 *
          this.cols.reduce((a, b) => a + b, 0);

        const newL = startFlex[colIdx]     + delta;
        const newR = startFlex[colIdx + 1] - delta;
        if (newL < minF || newR < minF) return;

        this.cols[colIdx]     = newL;
        this.cols[colIdx + 1] = newR;

        // Update grid template directly
        const tracks = [];
        for (let c = 0; c < this.cols.length; c++) {
          tracks.push(`${this.cols[c]}fr`);
          if (c < this.cols.length - 1)
            tracks.push('4px');
        }
        this.root.style.gridTemplateColumns =
          tracks.join(' ');
      };

      const onUp = () => {
        el.classList.remove('t-divider--active');
        document.removeEventListener(
          'mousemove', onMove);
        document.removeEventListener(
          'mouseup', onUp);
      };

      document.addEventListener('mousemove', onMove);
      document.addEventListener('mouseup', onUp);
    });
  }

  _bindRowDivider(el, rowIdx) {
    el.addEventListener('mousedown', (e) => {
      e.preventDefault();
      el.classList.add('t-divider--active');
      const startY    = e.clientY;
      const startFlex = [...this.rows];
      const totalH    = this.root.clientHeight;

      const onMove = (e) => {
        const dy    = e.clientY - startY;
        const delta = dy / totalH *
          this.rows.reduce((a, b) => a + b, 0);
        const minF  = 0.15 *
          this.rows.reduce((a, b) => a + b, 0);

        const newT = startFlex[rowIdx]     + delta;
        const newB = startFlex[rowIdx + 1] - delta;
        if (newT < minF || newB < minF) return;

        this.rows[rowIdx]     = newT;
        this.rows[rowIdx + 1] = newB;

        const tracks = [];
        for (let r = 0; r < this.rows.length; r++) {
          tracks.push(`${this.rows[r]}fr`);
          if (r < this.rows.length - 1)
            tracks.push('4px');
        }
        this.root.style.gridTemplateRows =
          tracks.join(' ');
      };

      const onUp = () => {
        el.classList.remove('t-divider--active');
        document.removeEventListener(
          'mousemove', onMove);
        document.removeEventListener(
          'mouseup', onUp);
      };

      document.addEventListener('mousemove', onMove);
      document.addEventListener('mouseup', onUp);
    });
  }

  // ── Responsive header buttons ────────────────────────────

  _onResize(entries) {
    for (const entry of entries) {
      const el = entry.target;
      if (!el.classList.contains('t-panel')) continue;
      const w = entry.contentRect.width;

      // Word buttons: visible above 300px
      el.querySelectorAll('.t-hbtn--word')
        .forEach(b => {
          b.style.display = w > 300 ? '' : 'none';
        });

      // Icon buttons: visible 180–300px
      el.querySelectorAll('.t-hbtn--icon')
        .forEach(b => {
          b.style.display =
            (w > 180 && w <= 300) ? '' : 'none';
        });

      // Hide all group action buttons when too small
      if (w <= 180) {
        el.querySelectorAll('.t-hbtn')
          .forEach(b => { if (!b.classList.contains('t-close-btn'))
            b.style.display = 'none'; });
      }

      // Close always visible above 120px
      const closeBtn =
        el.querySelector('.t-close-btn');
      if (closeBtn)
        closeBtn.style.display =
          w > 120 ? '' : 'none';
    }
  }

  // ── Context menu ─────────────────────────────────────────

  _makeCtxMenu() {
    const m = document.createElement('div');
    m.id        = 't-ctx-menu';
    m.className = 'ctx-menu';
    m.style.display = 'none';
    document.body.appendChild(m);
    this._ctxMenu = m;

    // Dismiss on any click
    document.addEventListener('click', () => {
      m.style.display = 'none';
    });
    document.addEventListener('contextmenu', (e) => {
      if (!m.contains(e.target))
        m.style.display = 'none';
    });
  }

  _showGroupCtx(e, panel) {
    const m = this._ctxMenu;
    const group = window.SC.app
      ?._getGroup?.(panel.chatId);
    const isCreator = group?.creator_id ===
      window.SC.app?._myUserId?.();

    const items = [
      { label: '👥 Members', action: 'members' },
      { label: '+ Invite',   action: 'invite' },
      { label: '✕ Kick',     action: 'kick',
        cls: 'ctx-item-warn' },
      { sep: true },
      { label: 'Leave Group', action: 'leave',
        cls: 'ctx-item-danger' },
      ...(isCreator
        ? [{ label: 'Delete Group', action: 'delete',
             cls: 'ctx-item-danger' }]
        : [])
    ];

    m.innerHTML = '';
    items.forEach(item => {
      if (item.sep) {
        const s = document.createElement('div');
        s.className = 'ctx-sep';
        m.appendChild(s);
        return;
      }
      const btn = document.createElement('button');
      btn.className = 'ctx-item' +
        (item.cls ? ' ' + item.cls : '');
      btn.textContent = item.label;
      btn.onclick = (ev) => {
        ev.stopPropagation();
        m.style.display = 'none';
        window.SC.app?.onGroupAction(
          panel, item.action);
      };
      m.appendChild(btn);
    });

    // Position
    m.style.display = 'block';
    const rect = m.getBoundingClientRect();
    let x = e.clientX, y = e.clientY;
    if (x + 180 > window.innerWidth)
      x = window.innerWidth - 184;
    if (y + rect.height > window.innerHeight)
      y = window.innerHeight - rect.height - 4;
    m.style.left = x + 'px';
    m.style.top  = y + 'px';
  }
}

// ── Message rendering ─────────────────────────────────────

function _appendMsg(el, msg) {
  const d    = new Date(msg.timestamp * 1000);
  const date = d.toLocaleDateString();

  if (el.dataset.lastDate !== date) {
    el.dataset.lastDate = date;
    const sep = document.createElement('div');
    sep.className   = 'date-sep';
    sep.textContent = date;
    el.appendChild(sep);
  }

  const row = document.createElement('div');
  row.className = 'msg' +
    (msg.system ? ' system' : '');
  const time = d.toLocaleTimeString([], {
    hour: '2-digit', minute: '2-digit' });
  row.innerHTML = `
    <span class="msg-time">${time}</span>
    <span class="msg-author
      ${msg.isSelf ? 'self' : 'other'}">
      ${esc(msg.author ?? '*')}
    </span>
    <span class="msg-text">${esc(msg.text)}</span>
  `;
  el.appendChild(row);
  el.scrollTop = el.scrollHeight;
}

function _appendFile(el, msg) {
  const d    = new Date((msg.timestamp ?? 0) * 1000);
  const date = d.toLocaleDateString();

  if (el.dataset.lastDate !== date) {
    el.dataset.lastDate = date;
    const sep = document.createElement('div');
    sep.className   = 'date-sep';
    sep.textContent = date;
    el.appendChild(sep);
  }

  const time = d.toLocaleTimeString([], {
    hour: '2-digit', minute: '2-digit' });

  const row = document.createElement('div');
  row.className = 'msg msg-file';

  const isImage = SC.ft.isImage(msg.mimetype);
  const isVideo = SC.ft.isVideo(msg.mimetype);
  const fullUrl = msg.url.startsWith('http')
    ? msg.url : location.origin + msg.url;

  let mediaHtml = '';

  if (isImage) {
    mediaHtml = `
      <div class="file-media">
        <img src="${fullUrl}"
             alt="${esc(msg.filename)}"
             class="file-img"
             loading="lazy"
             onclick="window.open('${fullUrl}','_blank')">
        <div class="file-dl">
          <a href="${fullUrl}"
             download="${esc(msg.filename)}"
             class="file-dl-btn">
            ↓ Download
          </a>
        </div>
      </div>
    `;
  } else if (isVideo) {
    mediaHtml = `
      <div class="file-media">
        <video controls
               class="file-video"
               preload="metadata">
          <source src="${fullUrl}"
                  type="${esc(msg.mimetype)}">
        </video>
        <div class="file-dl">
          <a href="${fullUrl}"
             download="${esc(msg.filename)}"
             class="file-dl-btn">
            ↓ Download
          </a>
        </div>
      </div>
    `;
  } else {
    // Generic file — download only
    mediaHtml = `
      <div class="file-attachment">
        <span class="file-icon">📄</span>
        <div class="file-info">
          <span class="file-name">
            ${esc(msg.filename)}
          </span>
          <span class="file-size">
            ${formatBytes(msg.size)}
          </span>
        </div>
        <a href="${fullUrl}"
           download="${esc(msg.filename)}"
           class="file-dl-btn">
          ↓ Download
        </a>
      </div>
    `;
  }

  row.innerHTML = `
    <span class="msg-time">${time}</span>
    <span class="msg-author
      ${msg.isSelf ? 'self' : 'other'}">
      ${esc(msg.fromUser)}
    </span>
    <span class="msg-text">${mediaHtml}</span>
  `;

  el.appendChild(row);
  el.scrollTop = el.scrollHeight;
}

// ── Utilities ─────────────────────────────────────────────

function esc(str) {
  return String(str ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

function formatBytes(b) {
  if (b < 1024)       return b + ' B';
  if (b < 1048576)    return (b/1024).toFixed(1) + ' KB';
  if (b < 1073741824) return (b/1048576).toFixed(1) + ' MB';
  return (b/1073741824).toFixed(2) + ' GB';
}

// ── Initialise ────────────────────────────────────────────
window.SC.tiler = new TileManager(
  document.getElementById('tile-root'));

// Expose esc and formatBytes for ui.js compatibility
window.SC.esc         = esc;
window.SC.formatBytes = formatBytes;