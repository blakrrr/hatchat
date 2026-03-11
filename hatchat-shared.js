/**
 * hatchat-shared.js — v1.0.3.0
 * Shared utilities: zoom adjuster, notification bar.
 */

const HATCHAT_VERSION = '1.0.3.0';

// ── Zoom ──────────────────────────────────────────────────────────────────
(function initZoom() {
    // Use a different localStorage key per page type so chat & clips zoom are independent
    const isClips = document.body && document.body.classList.contains('clips-page');
    const ZOOM_KEY = isClips ? 'hc_zoom_clips' : 'hc_zoom_chat';
    let zoom = parseFloat(localStorage.getItem(ZOOM_KEY)) || 100;

    function applyZoom(z) {
        zoom = Math.min(200, Math.max(10, z));
        localStorage.setItem(ZOOM_KEY, zoom);

        // Chat page: scale only messages + user list, keep typing bar pinned
        const chatMessages = document.getElementById('chat-messages');
        if (chatMessages) {
            chatMessages.style.zoom = zoom / 100;
            const userList = document.querySelector('.user-list');
            if (userList) userList.style.zoom = zoom / 100;
        }

        // Clips page: change grid column count (zoom = density)
        const clipsGridAll  = document.getElementById('clips-grid-all');
        const clipsGridUser = document.getElementById('clips-grid-user');
        if (clipsGridAll || clipsGridUser) {
            let cols = 3;
            if      (zoom < 50)  cols = 7;
            else if (zoom < 80)  cols = 5;
            else if (zoom < 120) cols = 3;
            else if (zoom < 160) cols = 2;
            else                 cols = 1;
            const colStr = `repeat(${cols}, 1fr)`;
            if (clipsGridAll)  clipsGridAll.style.gridTemplateColumns  = colStr;
            if (clipsGridUser) clipsGridUser.style.gridTemplateColumns = colStr;
        }

        const el = document.getElementById('hc-zoom-val');
        if (el) el.textContent = zoom + '%';
        const sl = document.getElementById('hc-zoom-slider');
        if (sl) sl.value = zoom;
    }

    // Ctrl +/- keybinds
    document.addEventListener('keydown', (e) => {
        if (!e.ctrlKey) return;
        if (e.key === '=' || e.key === '+') { e.preventDefault(); applyZoom(zoom + 10); }
        else if (e.key === '-')             { e.preventDefault(); applyZoom(zoom - 10); }
        else if (e.key === '0')             { e.preventDefault(); applyZoom(100); }
    });

    document.addEventListener('DOMContentLoaded', () => {
        applyZoom(zoom);

        const container = document.querySelector('.load-more-container') || null;
        const wrap = document.createElement('div');
        wrap.id = 'hc-zoom-wrap';
        wrap.title = 'Zoom (Ctrl +/-)';
        if (!container) wrap.classList.add('hc-zoom-standalone');
        wrap.innerHTML = `<span class="hc-zoom-label">zoom</span>
            <input id="hc-zoom-slider" type="range" min="10" max="200" step="5" value="${zoom}">
            <span id="hc-zoom-val">${zoom}%</span>`;
        wrap.querySelector('#hc-zoom-slider').addEventListener('input', (e) => {
            applyZoom(parseInt(e.target.value));
        });

        if (container) {
            container.appendChild(wrap);
        } else {
            const header = document.querySelector('header');
            if (header) header.insertAdjacentElement('afterend', wrap);
        }
    });
})();


// ── Notification bar ──────────────────────────────────────────────────────
(function initNotifBar() {
    const NOTIF_KEY = 'hc_last_notif';
    let notifTimeout = null;

    // DND check — shared across all pages
    function isDnd() {
        return localStorage.getItem('hc_dnd') === 'true';
    }

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
            display: inline-flex;
            align-items: center;
            gap: 6px;
            margin-left: 1rem;
            font-size: 0.75rem;
            color: #888;
            vertical-align: middle;
        }
        #hc-zoom-wrap.hc-zoom-standalone {
            display: flex;
            padding: 0.3rem 1rem;
            background: #0a0a0a;
            border-bottom: 1px solid #1e1e1e;
        }
        .hc-zoom-label { user-select: none; color: #666; }
        #hc-zoom-slider { width: 80px; accent-color: #555; cursor: pointer; }
        #hc-zoom-val { min-width: 3.5ch; text-align: right; color: #999; font-weight: bold; }

        /* ── Notification bar ── */
        #hc-notif-bar {
            position: fixed;
            right: 168px;
            top: 3.5rem;
            transform: translateY(-120%);
            background: #141414;
            border: 1px solid #2a2a2a;
            border-left: 3px solid #484848;
            color: #c8c8c8;
            padding: 0.55rem 1rem;
            border-radius: 3px;
            font-size: 0.82rem;
            font-family: 'DejaVu Sans Mono', monospace;
            box-shadow: 0 4px 16px rgba(0,0,0,0.8);
            z-index: 9999;
            white-space: nowrap;
            max-width: 300px;
            overflow: hidden;
            text-overflow: ellipsis;
            transition: transform 0.2s ease, opacity 0.2s ease;
            opacity: 0;
            pointer-events: none;
            min-width: 180px;
        }
        #hc-notif-bar.hc-notif-visible {
            transform: translateY(0);
            opacity: 1;
        }
        body:not(.chat-page) #hc-notif-bar {
            right: auto;
            left: 50%;
            top: 3.5rem;
            transform: translateX(-50%) translateY(-120%);
        }
        body:not(.chat-page) #hc-notif-bar.hc-notif-visible {
            transform: translateX(-50%) translateY(0);
        }
    `;
    document.head.appendChild(style);
})();
