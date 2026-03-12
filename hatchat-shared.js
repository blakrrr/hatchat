/**
 * hatchat-shared.js — v1.0.6.0
 * Shared: zoom (per-page, server-synced), notification bar, prefs helpers.
 */

const HATCHAT_VERSION = '1.0.6.0';
const SERVER = 'https://averrgy-github-io.onrender.com';

// ── Prefs: load from server on boot, save on change (debounced) ───────────
// All per-user settings live in users.json on the server.
// localStorage is used only as a fast local cache between page loads.
(function initPrefs() {
    let _prefSaveTimer = null;

    window.hcSavePrefs = function(prefs) {
        // Update local cache immediately
        Object.entries(prefs).forEach(([k, v]) => localStorage.setItem('hc_pref_' + k, v));
        // Debounce server write
        clearTimeout(_prefSaveTimer);
        _prefSaveTimer = setTimeout(async () => {
            const token = localStorage.getItem('hc_token');
            if (!token) return;
            try {
                await fetch(`${SERVER}/api/save-prefs`, {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify({ token, ...prefs })
                });
            } catch (_) {}
        }, 1500);
    };

    window.hcGetPref = function(key, defaultVal) {
        const v = localStorage.getItem('hc_pref_' + key);
        return v !== null ? v : defaultVal;
    };

    // On boot: pull fresh prefs from server and overwrite local cache
    document.addEventListener('DOMContentLoaded', async () => {
        const token = localStorage.getItem('hc_token');
        if (!token) return;
        try {
            const ctrl = new AbortController();
            const t = setTimeout(() => ctrl.abort(), 8000);
            const r = await fetch(`${SERVER}/api/me?token=${token}`, { signal: ctrl.signal });
            clearTimeout(t);
            if (!r.ok) return;
            const d = await r.json();
            if (!d.success) return;
            // Sync all pref fields to local cache
            if (d.zoom_chat  !== undefined) localStorage.setItem('hc_pref_zoom_chat',  d.zoom_chat);
            if (d.zoom_clips !== undefined) localStorage.setItem('hc_pref_zoom_clips', d.zoom_clips);
            if (d.dnd        !== undefined) localStorage.setItem('hc_dnd', d.dnd ? 'true' : 'false');
            // Re-apply zoom now that we have fresh values
            if (window._hcReapplyZoom) window._hcReapplyZoom();
        } catch (_) {}
    });
})();


// ── Zoom ──────────────────────────────────────────────────────────────────
// IMPORTANT: isClips is determined at DOMContentLoaded so body class is set.
// Using a separate localStorage key AND server pref per page type.
(function initZoom() {
    // We can't reliably read body class at parse time on all browsers,
    // so we store the page type in a variable and set it at DOMContentLoaded.
    let isClips = false;
    let ZOOM_KEY = 'hc_pref_zoom_chat'; // default, updated at DOMContentLoaded
    let zoom = 100;
    let widgetInjected = false;

    function getZoomKey() {
        return isClips ? 'hc_pref_zoom_clips' : 'hc_pref_zoom_chat';
    }

    function applyZoom(z, save) {
        zoom = Math.min(200, Math.max(10, z));
        if (save) {
            const key = getZoomKey();
            localStorage.setItem(key, zoom);
            const prefKey = isClips ? 'zoom_clips' : 'zoom_chat';
            if (window.hcSavePrefs) window.hcSavePrefs({ [prefKey]: zoom });
        }

        // Chat page: scale messages + user list only
        const chatMessages = document.getElementById('chat-messages');
        if (chatMessages) {
            chatMessages.style.zoom = zoom / 100;
            const userList = document.querySelector('.user-list');
            if (userList) userList.style.zoom = zoom / 100;
        }

        // Clips page: cols = zoom/10 (10%=1, 20%=2, 100%=10, etc.)
        if (isClips) {
            const cols = Math.max(1, Math.round(zoom / 10));
            const colStr = `repeat(${cols}, 1fr)`;
            // Flat grids (used by renderGrid)
            const ga = document.getElementById('clips-grid-all');
            const gu = document.getElementById('clips-grid-user');
            if (ga) ga.style.gridTemplateColumns = colStr;
            if (gu) gu.style.gridTemplateColumns = colStr;
            // Month sub-grids (built dynamically)
            document.querySelectorAll('.clips-month-grid').forEach(g => {
                g.style.gridTemplateColumns = colStr;
            });
        }

        const el = document.getElementById('hc-zoom-val');
        if (el) el.textContent = zoom + '%';
        const sl = document.getElementById('hc-zoom-slider');
        if (sl) sl.value = zoom;
    }

    // Expose so prefs boot can re-apply after server sync
    window._hcReapplyZoom = function() {
        const key = getZoomKey();
        const fresh = parseFloat(localStorage.getItem(key));
        if (!isNaN(fresh)) applyZoom(fresh, false);
    };

    // Ctrl +/- keybinds
    document.addEventListener('keydown', (e) => {
        if (!e.ctrlKey) return;
        if (e.key === '=' || e.key === '+') { e.preventDefault(); applyZoom(zoom + 10, true); }
        else if (e.key === '-')             { e.preventDefault(); applyZoom(zoom - 10, true); }
        else if (e.key === '0')             { e.preventDefault(); applyZoom(100, true); }
    });

    document.addEventListener('DOMContentLoaded', () => {
        // NOW we can read body class reliably
        isClips = document.body.classList.contains('clips-page');
        ZOOM_KEY = getZoomKey();
        zoom = parseFloat(localStorage.getItem(ZOOM_KEY)) || 100;

        applyZoom(zoom, false);

        if (widgetInjected) return;
        widgetInjected = true;

        const container = document.querySelector('.load-more-container') || null;
        const wrap = document.createElement('div');
        wrap.id = 'hc-zoom-wrap';
        wrap.title = 'Zoom (Ctrl +/-)';
        if (!container) wrap.classList.add('hc-zoom-standalone');
        wrap.innerHTML = `<span class="hc-zoom-label">zoom</span>
            <input id="hc-zoom-slider" type="range" min="10" max="200" step="5" value="${zoom}">
            <span id="hc-zoom-val">${zoom}%</span>`;
        wrap.querySelector('#hc-zoom-slider').addEventListener('input', (e) => {
            applyZoom(parseInt(e.target.value), true);
        });
        if (container) container.appendChild(wrap);
        else {
            const header = document.querySelector('header');
            if (header) header.insertAdjacentElement('afterend', wrap);
        }
    });
})();


// ── Notification bar ──────────────────────────────────────────────────────
(function initNotifBar() {
    const NOTIF_KEY = 'hc_last_notif';
    let notifTimeout = null;

    function isDnd() { return localStorage.getItem('hc_dnd') === 'true'; }

    function showNotif(msg) {
        if (isDnd()) return;
        let bar = document.getElementById('hc-notif-bar');
        if (!bar) {
            bar = document.createElement('div');
            bar.id = 'hc-notif-bar';
            document.body.appendChild(bar);
        }
        bar.textContent = msg;
        bar.classList.add('hc-notif-visible');
        clearTimeout(notifTimeout);
        notifTimeout = setTimeout(() => bar.classList.remove('hc-notif-visible'), 3000);
    }

    window.addEventListener('storage', (e) => {
        if (e.key === NOTIF_KEY && e.newValue) {
            try { showNotif(JSON.parse(e.newValue).msg); } catch (_) {}
        }
    });

    window.hcNotify = function(msg) {
        showNotif(msg);
        localStorage.setItem(NOTIF_KEY, JSON.stringify({ msg, t: Date.now() }));
        setTimeout(() => localStorage.removeItem(NOTIF_KEY), 100);
    };

    window.hcIsDnd = isDnd;
})();

// ── Online Users Panel (shared across pages) ──────────────────────────────
// Call window.hcInitOnlinePanel(socketInstance) after connecting a socket.
// Injects a fixed sidebar panel showing online/offline users.
(function initOnlinePanelStyles() {
    const style = document.createElement('style');
    style.textContent = `
        #hc-online-panel {
            position: fixed; top: 3.5rem; left: 0;
            width: 160px; height: calc(100vh - 3.5rem);
            background: #0d0d0d; border-right: 1px solid #1e1e1e;
            overflow-y: auto; z-index: 100; padding: 0.6rem 0.5rem;
            box-sizing: border-box; font-family: 'DejaVu Sans Mono', monospace;
            font-size: 0.75rem;
        }
        #hc-online-panel h4 {
            color: #555; font-size: 0.65rem; text-transform: uppercase;
            letter-spacing: 0.05em; margin: 0 0 0.5rem 0.2rem;
        }
        #hc-online-panel .user-item {
            display: flex; align-items: center; padding: 0.18rem 0.2rem;
            gap: 0.35rem;
        }
        #hc-online-panel .user-dot {
            width: 7px; height: 7px; border-radius: 50%;
            background: #4CAF50; flex-shrink: 0;
        }
        #hc-online-panel .user-dot-offline { background: #333; }
        #hc-online-panel .offline-divider {
            color: #333; font-size: 0.6rem; margin: 0.4rem 0;
            text-align: center;
        }
        /* push page content right to make room for the LEFT panel */
        body.has-online-panel .clips-main,
        body.has-online-panel .main-content {
            margin-left: 164px;
            margin-right: 0;
            box-sizing: border-box;
        }
        /* Theater fullscreen: cover everything including the panel */
        .theater-fs {
            z-index: 1000 !important;
        }
        /* Non-FS theater: stays within the content column */
        body.has-online-panel .clips-theater:not(.theater-fs) {
            max-width: 100%;
        }
    `;
    document.head.appendChild(style);
})();

window.hcInitOnlinePanel = function(sock) {
    const panel = document.createElement('div');
    panel.id = 'hc-online-panel';
    panel.innerHTML = '<h4>hattingtons</h4><div id="hc-online-list"></div>';
    document.body.appendChild(panel);
    document.body.classList.add('has-online-panel');

    async function refresh() {
        try {
            const r = await fetch(`${SERVER}/api/all-users`);
            const d = await r.json();
            if (!d.success) return;
            const list = document.getElementById('hc-online-list');
            if (!list) return;
            list.innerHTML = '';
            const online  = d.users.filter(u => u.online);
            const offline = d.users.filter(u => !u.online);
            online.forEach(u => {
                const item = document.createElement('div'); item.className = 'user-item';
                const dot = document.createElement('span'); dot.className = 'user-dot';
                const lbl = document.createElement('span'); lbl.textContent = u.username;
                lbl.style.color = u.color || '#e0e0e0';
                item.appendChild(dot); item.appendChild(lbl); list.appendChild(item);
            });
            if (offline.length) {
                const div = document.createElement('div'); div.className = 'offline-divider';
                div.textContent = '── offline ──'; list.appendChild(div);
                offline.forEach(u => {
                    const item = document.createElement('div'); item.className = 'user-item';
                    const dot = document.createElement('span'); dot.className = 'user-dot user-dot-offline';
                    const lbl = document.createElement('span'); lbl.textContent = u.username;
                    lbl.style.color = '#555';
                    item.appendChild(dot); item.appendChild(lbl); list.appendChild(item);
                });
            }
        } catch(_) {}
    }

    refresh();
    sock.on('refresh_all_users', refresh);
    sock.on('update_users', refresh);
    sock.on('user_join',  refresh);
    sock.on('user_leave', refresh);
};

// ── Cross-page notification sound ─────────────────────────────────────────
// Plays the notif sound when a chat_message arrives via localStorage storage event
(function initCrossPageSound() {
    const SOUND_KEY = 'hc_last_chat_msg';
    const notifSound = new Audio('/public/sounds/notif.mp3');
    notifSound.onerror = () => { notifSound.src = '/public/sounds/notif.wav'; };

    function isDnd() { return localStorage.getItem('hc_dnd') === 'true'; }

    window.addEventListener('storage', (e) => {
        if (e.key !== SOUND_KEY || !e.newValue) return;
        if (isDnd()) return;
        try { notifSound.currentTime = 0; notifSound.play().catch(() => {}); } catch(_) {}
        // Also show the notification popup on this page
        try {
            const payload = JSON.parse(e.newValue);
            if (payload.msg && window.hcNotify) window.hcNotify(payload.msg);
        } catch(_) {}
    });

    // Chat page calls this when it receives a message from another user
    window.hcTriggerCrossPageSound = function(msg) {
        localStorage.setItem(SOUND_KEY, JSON.stringify({ msg: msg || '💬 new message', t: Date.now() }));
        setTimeout(() => localStorage.removeItem(SOUND_KEY), 200);
    };
})();
(function injectSharedStyles() {
    const style = document.createElement('style');
    style.textContent = `
        #hc-zoom-wrap {
            display: inline-flex; align-items: center;
            gap: 6px; margin-left: 1rem;
            font-size: 0.75rem; color: #888; vertical-align: middle;
        }
        #hc-zoom-wrap.hc-zoom-standalone {
            display: flex; padding: 0.3rem 1rem;
            background: #0a0a0a; border-bottom: 1px solid #1e1e1e;
        }
        .hc-zoom-label { user-select: none; color: #666; }
        #hc-zoom-slider { width: 80px; accent-color: #555; cursor: pointer; }
        #hc-zoom-val { min-width: 3.5ch; text-align: right; color: #999; font-weight: bold; }

        #hc-notif-bar {
            position: fixed; left: 50%; top: 3.8rem;
            transform: translateX(-50%) translateY(-130%);
            background: #141414; border: 1px solid #2a2a2a;
            border-left: 3px solid #484848; color: #c8c8c8;
            padding: 0.6rem 1.1rem; border-radius: 3px;
            font-size: 0.84rem; font-family: 'DejaVu Sans Mono', monospace;
            box-shadow: 0 4px 16px rgba(0,0,0,0.8); z-index: 9999;
            white-space: nowrap; max-width: 320px; min-width: 180px;
            overflow: hidden; text-overflow: ellipsis;
            transition: transform 0.2s ease, opacity 0.2s ease;
            opacity: 0; pointer-events: none;
        }
        #hc-notif-bar.hc-notif-visible {
            transform: translateX(-50%) translateY(0);
            opacity: 1;
        }
    `;
    document.head.appendChild(style);
})();
