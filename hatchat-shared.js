/**
 * hatchat-shared.js — v1.0.4.0
 * Shared: zoom (per-page, server-synced), notification bar, prefs helpers.
 */

const HATCHAT_VERSION = '1.0.4.0';
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
            const r = await fetch(`${SERVER}/api/me?token=${token}`);
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

        // Clips page: set column count on ALL month grids + the flat grids
        if (isClips) {
            let cols = 3;
            if      (zoom < 50)  cols = 7;
            else if (zoom < 80)  cols = 5;
            else if (zoom < 120) cols = 3;
            else if (zoom < 160) cols = 2;
            else                 cols = 1;
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

// ── Shared CSS ────────────────────────────────────────────────────────────
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
            position: fixed; right: 180px; top: 3.8rem;
            transform: translateY(-130%);
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
        #hc-notif-bar.hc-notif-visible { transform: translateY(0); opacity: 1; }
        body:not(.chat-page) #hc-notif-bar {
            right: auto; left: 50%; top: 3.8rem;
            transform: translateX(-50%) translateY(-130%);
        }
        body:not(.chat-page) #hc-notif-bar.hc-notif-visible {
            transform: translateX(-50%) translateY(0);
        }
    `;
    document.head.appendChild(style);
})();
