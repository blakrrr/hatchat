/**
 * hatchat-shared.js — v1.0.1.0
 * Shared utilities: zoom adjuster, notification bar.
 * Include this script in every HTML page.
 */

// ── Version ──────────────────────────────────────────────────────────────
const HATCHAT_VERSION = '1.0.1.0';

// ── Zoom ─────────────────────────────────────────────────────────────────
(function initZoom() {
    const ZOOM_KEY = 'hc_zoom';
    let zoom = parseFloat(localStorage.getItem(ZOOM_KEY)) || 100;

    function applyZoom(z) {
        zoom = Math.min(200, Math.max(10, z));
        document.body.style.zoom = (zoom / 100);
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

    // Inject zoom widget into header after DOM ready
    document.addEventListener('DOMContentLoaded', () => {
        applyZoom(zoom);

        const nav = document.querySelector('header nav');
        if (!nav) return;

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
        nav.parentNode.insertBefore(wrap, nav);
    });
})();

// ── Notification bar ─────────────────────────────────────────────────────
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
        // Store so other tabs see it
        localStorage.setItem(NOTIF_KEY, JSON.stringify({ msg, t: Date.now() }));
        // Clear immediately so same message can fire again
        setTimeout(() => localStorage.removeItem(NOTIF_KEY), 100);
    };
})();

// ── Shared CSS (injected into <head>) ────────────────────────────────────
(function injectSharedStyles() {
    const style = document.createElement('style');
    style.textContent = `
        /* Zoom widget */
        #hc-zoom-wrap {
            display: flex;
            align-items: center;
            gap: 6px;
            margin-right: 1rem;
            font-size: 0.75rem;
            color: #aaa;
        }
        .hc-zoom-label { user-select: none; }
        #hc-zoom-slider {
            width: 70px;
            accent-color: #7c6af7;
            cursor: pointer;
        }
        #hc-zoom-val {
            min-width: 3.5ch;
            text-align: right;
            color: #7c6af7;
            font-weight: bold;
        }

        /* Notification bar */
        #hc-notif-bar {
            position: fixed;
            bottom: 1.5rem;
            left: 50%;
            transform: translateX(-50%) translateY(120%);
            background: #1e1e2e;
            border: 1px solid #7c6af7;
            color: #e0e0e0;
            padding: 0.5rem 1.4rem;
            border-radius: 999px;
            font-size: 0.85rem;
            font-family: 'DejaVu Sans Mono', monospace;
            box-shadow: 0 4px 20px rgba(124,106,247,0.3);
            z-index: 9999;
            white-space: nowrap;
            transition: transform 0.3s ease, opacity 0.3s ease;
            opacity: 0;
            pointer-events: none;
        }
        #hc-notif-bar.hc-notif-visible {
            transform: translateX(-50%) translateY(0);
            opacity: 1;
        }
    `;
    document.head.appendChild(style);
})();
