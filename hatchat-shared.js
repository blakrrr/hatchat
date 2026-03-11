/**
 * hatchat-shared.js — v1.0.2.0
 * Shared utilities: zoom adjuster, notification bar.
 * Include this script in every HTML page.
 */

// ── Version ───────────────────────────────────────────────────────────────
const HATCHAT_VERSION = '1.0.2.0';

// ── Zoom ──────────────────────────────────────────────────────────────────
(function initZoom() {
    const ZOOM_KEY = 'hc_zoom';
    let zoom = parseFloat(localStorage.getItem(ZOOM_KEY)) || 100;

    function applyZoom(z) {
        zoom = Math.min(200, Math.max(10, z));
        document.documentElement.style.setProperty('--hc-zoom', zoom / 100);
        // On chat page: zoom only the scrollable messages area, keep typing bar pinned
        const chatMessages = document.getElementById('chat-messages');
        const mainContent = document.querySelector('.main-content');
        if (chatMessages) {
            // Chat page — scale messages + user list but not the form/header
            chatMessages.style.zoom = zoom / 100;
            const userList = document.querySelector('.user-list');
            if (userList) userList.style.zoom = zoom / 100;
        } else {
            // Other pages — fallback to whole body
            document.body.style.zoom = zoom / 100;
        }
        localStorage.setItem(ZOOM_KEY, zoom);
        const el = document.getElementById('hc-zoom-val');
        if (el) el.textContent = zoom + '%';
        const sl = document.getElementById('hc-zoom-slider');
        if (sl) sl.value = zoom;
    }

    // Keyboard: Ctrl+= / Ctrl+- / Ctrl+0
    document.addEventListener('keydown', (e) => {
        if (!e.ctrlKey) return;
        if (e.key === '=' || e.key === '+') { e.preventDefault(); applyZoom(zoom + 10); }
        else if (e.key === '-')             { e.preventDefault(); applyZoom(zoom - 10); }
        else if (e.key === '0')             { e.preventDefault(); applyZoom(100); }
    });

    // Inject zoom widget into the load-more-container row after DOM ready
    document.addEventListener('DOMContentLoaded', () => {
        applyZoom(zoom);

        const loadMoreContainer = document.querySelector('.load-more-container');
        if (loadMoreContainer) {
            const wrap = document.createElement('div');
            wrap.id = 'hc-zoom-wrap';
            wrap.title = 'Page Zoom (Ctrl +/-)';
            wrap.innerHTML = `
                <span class="hc-zoom-label">zoom</span>
                <input id="hc-zoom-slider" type="range" min="10" max="200" step="5" value="${zoom}">
                <span id="hc-zoom-val">${zoom}%</span>
            `;
            wrap.querySelector('#hc-zoom-slider').addEventListener('input', (e) => {
                applyZoom(parseInt(e.target.value));
            });
            loadMoreContainer.appendChild(wrap);
        } else {
            // fallback: inject after header
            const header = document.querySelector('header');
            if (!header) return;
            const wrap = document.createElement('div');
            wrap.id = 'hc-zoom-wrap';
            wrap.classList.add('hc-zoom-standalone');
            wrap.title = 'Page Zoom (Ctrl +/-)';
            wrap.innerHTML = `
                <span class="hc-zoom-label">zoom</span>
                <input id="hc-zoom-slider" type="range" min="10" max="200" step="5" value="${zoom}">
                <span id="hc-zoom-val">${zoom}%</span>
            `;
            wrap.querySelector('#hc-zoom-slider').addEventListener('input', (e) => {
                applyZoom(parseInt(e.target.value));
            });
            header.insertAdjacentElement('afterend', wrap);
        }
    });
})();

// ── Notification bar ──────────────────────────────────────────────────────
(function initNotifBar() {
    const NOTIF_KEY = 'hc_last_notif';
    let notifTimeout = null;

    function showNotif(msg) {
        let bar = document.getElementById('hc-notif-bar');
        if (!bar) {
            bar = document.createElement('div');
            bar.id = 'hc-notif-bar';
            document.body.appendChild(bar);
        }
        bar.textContent = msg;
        bar.classList.add('hc-notif-visible');
        clearTimeout(notifTimeout);
        notifTimeout = setTimeout(() => {
            bar.classList.remove('hc-notif-visible');
        }, 3000);
    }

    // Listen for storage events from other tabs/pages
    window.addEventListener('storage', (e) => {
        if (e.key === NOTIF_KEY && e.newValue) {
            try {
                const n = JSON.parse(e.newValue);
                showNotif(n.msg);
            } catch (_) {}
        }
    });

    // Expose global function for pages to fire cross-page notifications
    window.hcNotify = function(msg) {
        showNotif(msg);
        localStorage.setItem(NOTIF_KEY, JSON.stringify({ msg, t: Date.now() }));
        setTimeout(() => localStorage.removeItem(NOTIF_KEY), 100);
    };
})();

// ── Shared CSS (injected into <head>) ─────────────────────────────────────
(function injectSharedStyles() {
    const style = document.createElement('style');
    style.textContent = `
        /* Zoom widget — lives in the load-more row */
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
        #hc-zoom-slider {
            width: 80px;
            accent-color: #555;
            cursor: pointer;
        }
        #hc-zoom-val {
            min-width: 3.5ch;
            text-align: right;
            color: #999;
            font-weight: bold;
        }

        /* Notification bar — boxy, greyscale, between chat messages and voice panel */
        #hc-notif-bar {
            position: fixed;
            right: 168px; /* clears the voice panel (160px + 8px gap) */
            bottom: 72px; /* clears the chat-form bar */
            transform: translateY(150%);
            background: #181818;
            border: 1px solid #2e2e2e;
            border-left: 3px solid #444;
            color: #bbb;
            padding: 0.5rem 0.8rem;
            border-radius: 3px;
            font-size: 0.76rem;
            font-family: 'DejaVu Sans Mono', monospace;
            box-shadow: 0 2px 10px rgba(0,0,0,0.7);
            z-index: 9999;
            white-space: nowrap;
            max-width: 260px;
            overflow: hidden;
            text-overflow: ellipsis;
            transition: transform 0.2s ease, opacity 0.2s ease;
            opacity: 0;
            pointer-events: none;
        }
        #hc-notif-bar.hc-notif-visible {
            transform: translateY(0);
            opacity: 1;
        }

        /* On non-chat pages (clips, settings) — center bottom */
        body:not(.chat-page) #hc-notif-bar {
            right: auto;
            left: 50%;
            bottom: 1.5rem;
            transform: translateX(-50%) translateY(150%);
        }
        body:not(.chat-page) #hc-notif-bar.hc-notif-visible {
            transform: translateX(-50%) translateY(0);
        }
    `;
    document.head.appendChild(style);
})();
