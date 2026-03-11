const express = require('express');
const http = require('http');
const socketIo = require('socket.io');
const cors = require('cors');
const fs = require('fs');
const path = require('path');
const multer = require('multer');
const fsExtra = require('fs-extra');
const { v2: cloudinary } = require('cloudinary');
const bcrypt = require('bcryptjs');
const crypto = require('crypto');

// ΓöÇΓöÇΓöÇ Cloudinary config (set these in Render Environment Variables) ΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇ
// CLOUDINARY_CLOUD_NAME, CLOUDINARY_API_KEY, CLOUDINARY_API_SECRET
cloudinary.config({
    cloud_name: process.env.CLOUDINARY_CLOUD_NAME,
    api_key:    process.env.CLOUDINARY_API_KEY,
    api_secret: process.env.CLOUDINARY_API_SECRET,
});

const app = express();
app.use(cors());
// Remove Express body size limits for clip uploads (multer handles multipart directly)
app.use(express.json());
app.use(express.urlencoded({ extended: true }));
// Serve static assets from /public (sounds, uploads, etc.)
app.use(express.static(path.join(__dirname, 'public')));
// Serve root-level HTML files (chat.html, clips.html, settings.html, index.html)
app.use(express.static(path.join(__dirname)));

const server = http.createServer(app);
const io = socketIo(server, {
    cors: {
        origin: ["https://hatchat.blakrr.works", "http://hatchat.blakrr.works", "https://averrgy-github-io.onrender.com", "*"],
        methods: ["GET", "POST"]
    }
});

// ΓöÇΓöÇΓöÇ IMAGE UPLOAD (existing) ΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇ
const imageStorage = multer.diskStorage({
    destination: (req, file, cb) => cb(null, path.join(__dirname, 'public', 'uploads')),
    filename: (req, file, cb) => {
        const uniquePrefix = Date.now() + '-' + Math.round(Math.random() * 1E9);
        cb(null, uniquePrefix + path.extname(file.originalname));
    }
});

const imageUpload = multer({
    storage: imageStorage,
    fileFilter: (req, file, cb) => {
        file.mimetype.startsWith('image/')
            ? cb(null, true)
            : cb(new Error('Only image files are allowed!'), false);
    },
    limits: { fileSize: 5 * 1024 * 1024 }
});

app.post('/upload', imageUpload.single('image'), (req, res) => {
    try {
        if (!req.file) return res.status(400).json({ success: false, message: 'No file uploaded' });
        return res.status(200).json({ success: true, filePath: `/uploads/${req.file.filename}` });
    } catch (error) {
        console.error('Image upload error:', error);
        return res.status(500).json({ success: false, message: 'Server error' });
    }
});

// ΓöÇΓöÇΓöÇ CLIP UPLOAD ΓÇö Cloudinary ΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇ
// Files are stored in Cloudinary under the "hatchat-clips" folder.
// Cloudinary handles CDN delivery, so clips load fast everywhere.
// The original filename is preserved as the public_id so NVIDIA date-names sort correctly.

// NVIDIA filename pattern: "Game Name YYYY.MM.DD - HH.MM.SS.frames.ext"
const NVIDIA_PATTERN = /\d{4}\.\d{2}\.\d{2}\s*-\s*\d{2}\.\d{2}\.\d{2}/;

// No size limit on multer ΓÇö Cloudinary accepts any size and we compress on their end.
// We buffer each file in memory one at a time via the streaming uploader.
const clipMemStorage = multer.memoryStorage();

const clipUploadMW = multer({
    storage: clipMemStorage,
    fileFilter: (req, file, cb) => {
        if (!NVIDIA_PATTERN.test(file.originalname)) {
            return cb(new Error('Only NVIDIA GameDVR clips (with date in filename) are allowed.'), false);
        }
        const mimeOk = file.mimetype.startsWith('video/') || file.mimetype === 'application/octet-stream';
        const extOk  = /\.(mp4|webm|mov|avi|mkv)$/i.test(file.originalname);
        (mimeOk || extOk) ? cb(null, true) : cb(new Error('Only video files allowed'), false);
    },
    // No fileSize limit ΓÇö let Cloudinary handle oversized files
    limits: { files: 200 }
});

// POST /upload-clip ΓÇö ONE file per request.
// The client sends files one at a time so a single failure never kills the batch.
app.post('/upload-clip', (req, res) => {
    req.setTimeout(10 * 60 * 1000); // 10 min per file
    res.setTimeout(10 * 60 * 1000);

    clipUploadMW.single('clip')(req, res, async (err) => {
        if (err) return res.status(400).json({ success: false, message: err.message });
        const file = req.file;
        if (!file) return res.status(400).json({ success: false, message: 'No file received' });

        const uploader = (req.body && req.body.uploader) ? req.body.uploader.trim() : 'unknown';
        const baseName = file.originalname.replace(/\.[^.]+$/, '');

        try {
            const uploadResult = await new Promise((resolve, reject) => {
                const stream = cloudinary.uploader.upload_stream(
                    {
                        resource_type: 'video',
                        folder: 'hatchat-clips',
                        public_id: baseName,
                        overwrite: false,
                        // No eager transformation — upload raw, play natively.
                        // Server-side transformations were causing slow uploads.
                        tags:    [`uploader:${uploader}`],
                        context: `uploader=${uploader}`,
                    },
                    (error, result) => error ? reject(error) : resolve(result)
                );
                stream.end(file.buffer);
            });

            file.buffer = null; // free RAM immediately
            // Broadcast clip upload notification to all connected clients
            io.emit('clip_uploaded', { uploader, filename: file.originalname });
            // NOTE: force_reload is NOT emitted here — client fires it after all batch uploads finish

            res.json({
                success:   true,
                filename:  file.originalname,
                url:       uploadResult.secure_url,
                public_id: uploadResult.public_id,
                uploader,
            });
        } catch (e) {
            file.buffer = null;
            console.error('Cloudinary upload error:', e.message);
            res.status(500).json({ success: false, filename: file.originalname, message: e.message });
        }
    });
});

// DELETE /api/purge-unknown ΓÇö removes clips tagged uploader:unknown
app.delete('/api/purge-unknown', async (req, res) => {
    try {
        const result = await cloudinary.api.resources({
            resource_type: 'video', type: 'upload',
            prefix: 'hatchat-clips/', max_results: 500,
            context: true, tags: true,
        });
        const toDelete = result.resources.filter(r => {
            let uploader = 'unknown';
            if (r.context?.custom?.uploader) uploader = r.context.custom.uploader;
            else if (r.tags) { const t = r.tags.find(t => t.startsWith('uploader:')); if (t) uploader = t.replace('uploader:', ''); }
            return uploader === 'unknown';
        });
        for (const r of toDelete)
            await cloudinary.uploader.destroy(r.public_id, { resource_type: 'video' });
        res.json({ success: true, deleted: toDelete.length });
    } catch (e) { res.status(500).json({ success: false, message: e.message }); }
});

// DELETE /api/purge-all ΓÇö removes EVERY clip in hatchat-clips/
app.delete('/api/purge-all', async (req, res) => {
    try {
        let deleted = 0;
        let nextCursor = undefined;
        do {
            const result = await cloudinary.api.resources({
                resource_type: 'video', type: 'upload',
                prefix: 'hatchat-clips/', max_results: 100,
                next_cursor: nextCursor,
            });
            const ids = result.resources.map(r => r.public_id);
            if (ids.length > 0) {
                await cloudinary.api.delete_resources(ids, { resource_type: 'video' });
                deleted += ids.length;
            }
            nextCursor = result.next_cursor;
        } while (nextCursor);
        res.json({ success: true, deleted });
    } catch (e) { res.status(500).json({ success: false, message: e.message }); }
});

// DELETE /api/clips/:public_id ΓÇö only the original uploader can delete their clip
app.delete('/api/clips/:public_id(*)', async (req, res) => {
    const { public_id } = req.params;          // e.g. "hatchat-clips/Arc Raiders 2026..."
    const { uploader }  = req.body || {};

    if (!uploader) return res.status(400).json({ success: false, message: 'Missing uploader' });

    try {
        // Fetch the resource to verify ownership
        const info = await cloudinary.api.resource(public_id, {
            resource_type: 'video', context: true, tags: true
        });

        let owner = 'unknown';
        if (info.context && info.context.custom && info.context.custom.uploader) {
            owner = info.context.custom.uploader;
        } else if (info.tags) {
            const t = info.tags.find(t => t.startsWith('uploader:'));
            if (t) owner = t.replace('uploader:', '');
        }

        if (owner.toLowerCase() !== uploader.toLowerCase()) {
            return res.status(403).json({ success: false, message: 'You can only delete your own clips.' });
        }

        await cloudinary.uploader.destroy(public_id, { resource_type: 'video' });
        res.json({ success: true });
    } catch (error) {
        console.error('Delete error:', error);
        res.status(500).json({ success: false, message: error.message });
    }
});

// GET /api/clips — returns all clips from Cloudinary sorted by NVIDIA filename date (newest first)
// Each clip includes a month_key like "2026-03" for grouping in the client.
app.get('/api/clips', async (req, res) => {
    try {
        const result = await cloudinary.api.resources({
            resource_type: 'video',
            type: 'upload',
            prefix: 'hatchat-clips/',
            max_results: 200,
            context: true,
            tags: true,
        });

        // Extract NVIDIA date from filename: "Game YYYY.MM.DD - HH.MM.SS..."
        function parseNvidiaDate(filename) {
            const m = filename.match(/(\d{4})\.(\d{2})\.(\d{2})\s*-\s*(\d{2})\.(\d{2})\.(\d{2})/);
            if (!m) return null;
            // Build an ISO-style string for reliable sorting
            return `${m[1]}-${m[2]}-${m[3]}T${m[4]}:${m[5]}:${m[6]}`;
        }

        const clips = result.resources.map(r => {
            let uploader = 'unknown';
            if (r.context && r.context.custom && r.context.custom.uploader) {
                uploader = r.context.custom.uploader;
            } else if (r.tags) {
                const tag = r.tags.find(t => t.startsWith('uploader:'));
                if (tag) uploader = tag.replace('uploader:', '');
            }
            const filename = path.basename(r.public_id) + '.' + r.format;
            const nvidiaDate = parseNvidiaDate(filename);
            // month_key used by client to group under month headers (e.g. "march 2026")
            let month_key = null;
            if (nvidiaDate) {
                const d = new Date(nvidiaDate);
                month_key = `${d.getFullYear()}-${String(d.getMonth()+1).padStart(2,'0')}`;
            } else {
                const d = new Date(r.created_at);
                month_key = `${d.getFullYear()}-${String(d.getMonth()+1).padStart(2,'0')}`;
            }
            return {
                filename,
                url:        r.secure_url,
                public_id:  r.public_id,
                created_at: r.created_at,
                nvidia_date: nvidiaDate,
                month_key,
                uploader,
            };
        });

        // Sort by NVIDIA date (newest first); fall back to Cloudinary created_at
        clips.sort((a, b) => {
            const da = a.nvidia_date || a.created_at;
            const db = b.nvidia_date || b.created_at;
            return new Date(db) - new Date(da);
        });

        res.json({ success: true, clips });
    } catch (error) {
        console.error('Cloudinary list error:', error);
        res.status(500).json({ success: false, message: 'Could not list clips' });
    }
});

// ΓöÇΓöÇΓöÇ CHAT DATA ΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇ
const onlineUsers = new Set();
const userColors = {};
let users = {};
const voiceMembers = {};

// Track how many socket connections each username has (across ALL pages).
// Join is announced when count goes 0→1; leave when count goes 1→0.
// No timer needed — navigating between pages keeps count ≥ 1.
const userConnectionCount = {};

// ΓöÇΓöÇΓöÇ ACCOUNTS ΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇ
// users.json stores: { username: { passwordHash, color, sessionTokens[] } }
const USERS_FILE = path.join(__dirname, 'users.json');
let registeredUsers = {};
try {
    if (fs.existsSync(USERS_FILE)) {
        registeredUsers = JSON.parse(fs.readFileSync(USERS_FILE, 'utf8'));
    } else {
        fs.writeFileSync(USERS_FILE, '{}', 'utf8');
    }
} catch (e) { console.error('Error loading users:', e); }

function saveRegisteredUsers() {
    try { fs.writeFileSync(USERS_FILE, JSON.stringify(registeredUsers, null, 2), 'utf8'); }
    catch (e) { console.error('Error saving users:', e); }
    // Push to GitHub so accounts survive Render restarts (ephemeral disk)
    syncUsersToGitHub().catch(e => console.warn('GitHub sync failed:', e.message));
}

async function syncUsersToGitHub() {
    const token = process.env.GITHUB_TOKEN;
    const repo  = process.env.GITHUB_REPO; // e.g. "blakrrr/hatchat"
    if (!token || !repo) return;

    const content = Buffer.from(JSON.stringify(registeredUsers, null, 2)).toString('base64');
    const apiUrl  = `https://api.github.com/repos/${repo}/contents/users.json`;

    // Need the current SHA to update an existing file
    let sha;
    try {
        const get = await fetch(apiUrl, {
            headers: { Authorization: `Bearer ${token}`, 'User-Agent': 'hatchat-server' }
        });
        if (get.ok) { const j = await get.json(); sha = j.sha; }
    } catch (_) {}

    await fetch(apiUrl, {
        method: 'PUT',
        headers: {
            Authorization: `Bearer ${token}`,
            'Content-Type': 'application/json',
            'User-Agent': 'hatchat-server'
        },
        body: JSON.stringify({
            message: 'chore: sync users [skip ci]',
            content,
            ...(sha ? { sha } : {})
        })
    });
}

// POST /api/register ΓÇö username + password + color, no email needed
app.post('/api/register', async (req, res) => {
    const { username, password, color } = req.body || {};
    if (!username || !password) return res.status(400).json({ success: false, message: 'Missing fields' });
    if (username.length > 8) return res.status(400).json({ success: false, message: 'Username max 8 chars' });
    if (registeredUsers[username.toLowerCase()]) return res.status(409).json({ success: false, message: 'Username taken' });

    const passwordHash = await bcrypt.hash(password, 10);
    const token = crypto.randomBytes(32).toString('hex');

    registeredUsers[username.toLowerCase()] = {
        username, passwordHash,
        color: color || '#FFFFFF',
        sessionTokens: [token],
    };
    saveRegisteredUsers();

    res.json({ success: true, token, username, color: color || '#FFFFFF' });
});

// POST /api/login
app.post('/api/login', async (req, res) => {
    const { username, password } = req.body || {};
    const user = registeredUsers[username?.toLowerCase()];
    if (!user) return res.status(401).json({ success: false, message: 'Wrong username or password' });
    const match = await bcrypt.compare(password, user.passwordHash);
    if (!match) return res.status(401).json({ success: false, message: 'Wrong username or password' });

    // Issue a session token
    const token = crypto.randomBytes(32).toString('hex');
    user.sessionTokens = (user.sessionTokens || []).slice(-4); // keep last 5
    user.sessionTokens.push(token);
    saveRegisteredUsers();

    res.json({ success: true, token, username: user.username, color: user.color });
});

// POST /api/update-profile — change username and/or color for logged-in user
app.post('/api/update-profile', async (req, res) => {
    const { token, color, username: newDisplay } = req.body || {};
    if (!token) return res.status(401).json({ success: false, message: 'Not authenticated' });

    // Find the user record by token
    const userKey = Object.keys(registeredUsers).find(k => registeredUsers[k].sessionTokens?.includes(token));
    if (!userKey) return res.status(401).json({ success: false, message: 'Invalid session' });
    const user = registeredUsers[userKey];

    // Handle username rename
    if (newDisplay && newDisplay.trim() && newDisplay.trim() !== user.username) {
        const trimmed = newDisplay.trim().substring(0, 8);
        const newKey = trimmed.toLowerCase();
        if (newKey !== userKey && registeredUsers[newKey]) {
            return res.status(409).json({ success: false, message: 'Username already taken' });
        }
        // Move record to new key, update display name
        const oldUsername = user.username;
        user.username = trimmed;
        if (newKey !== userKey) {
            registeredUsers[newKey] = user;
            delete registeredUsers[userKey];
        }
        // Update color map
        if (userColors[oldUsername]) {
            userColors[trimmed] = userColors[oldUsername];
            delete userColors[oldUsername];
        }
        // Broadcast name change so chat updates live
        io.emit('user_renamed', { oldUsername, newUsername: trimmed });
    }

    if (color) user.color = color;
    saveRegisteredUsers();

    // Broadcast color change to all connected sockets
    userColors[user.username] = user.color;
    saveUserColors();
    io.emit('update_colors', { userColors });
    io.emit('refresh_all_users');
    // Tell all connected clients to hard-reload so names/colors propagate everywhere
    io.emit('force_reload', { reason: 'profile_update' });

    res.json({ success: true, username: user.username, color: user.color });
});

// GET /api/me?token=xxx — validate a stored session token, returns prefs too
app.get('/api/me', (req, res) => {
    const { token } = req.query;
    if (!token) return res.status(401).json({ success: false });
    const user = Object.values(registeredUsers).find(u => u.sessionTokens?.includes(token));
    if (!user) return res.status(401).json({ success: false });
    res.json({
        success: true,
        username: user.username,
        color: user.color,
        zoom_chat:  user.zoom_chat  ?? 100,
        zoom_clips: user.zoom_clips ?? 100,
        dnd:        user.dnd        ?? false,
    });
});

// POST /api/save-prefs — save per-user preferences (zoom, dnd, etc.)
app.post('/api/save-prefs', (req, res) => {
    const { token, zoom_chat, zoom_clips, dnd } = req.body || {};
    if (!token) return res.status(401).json({ success: false, message: 'Not authenticated' });
    const userKey = Object.keys(registeredUsers).find(k => registeredUsers[k].sessionTokens?.includes(token));
    if (!userKey) return res.status(401).json({ success: false, message: 'Invalid session' });
    const user = registeredUsers[userKey];
    if (zoom_chat  !== undefined) user.zoom_chat  = zoom_chat;
    if (zoom_clips !== undefined) user.zoom_clips = zoom_clips;
    if (dnd        !== undefined) user.dnd        = dnd;
    saveRegisteredUsers();
    res.json({ success: true });
});

// GET /api/all-users ΓÇö all registered users + online status (for the user panel)
app.get('/api/all-users', (req, res) => {
    const onlineUsernames = new Set(Object.values(users).map(u => u.username.toLowerCase()));
    const list = Object.values(registeredUsers).map(u => ({
        username: u.username,
        color:    u.color,
        online:   onlineUsernames.has(u.username.toLowerCase()),
    }));
    res.json({ success: true, users: list });
});

const MESSAGES_FILE = path.join(__dirname, 'chat_messages.json');
const USER_COLORS_FILE = path.join(__dirname, 'user_colors.json');
const CLOUDINARY_MESSAGES_PUBLIC_ID = 'hatchat-data/chat_messages';

let chatMessages = [];

// Boot: try Cloudinary first (persistent), fall back to local file
async function loadMessagesFromCloudinary() {
    try {
        const result = await cloudinary.api.resource(CLOUDINARY_MESSAGES_PUBLIC_ID, { resource_type: 'raw' });
        const resp = await fetch(result.secure_url + '?t=' + Date.now());
        if (resp.ok) {
            const text = await resp.text();
            chatMessages = JSON.parse(text);
            console.log(`Loaded ${chatMessages.length} messages from Cloudinary`);
            // Also write local copy for fast subsequent reads
            try { fs.writeFileSync(MESSAGES_FILE, text, 'utf8'); } catch (_) {}
            return;
        }
    } catch (e) {
        console.log('Cloudinary messages not found or error:', e.message);
    }
    // Fall back to local file
    try {
        if (fs.existsSync(MESSAGES_FILE)) {
            chatMessages = JSON.parse(fs.readFileSync(MESSAGES_FILE, 'utf8'));
            console.log(`Loaded ${chatMessages.length} messages from local file`);
        } else {
            fs.writeFileSync(MESSAGES_FILE, '[]', 'utf8');
        }
    } catch (e) { console.error('Error loading messages:', e); }
}

// Call once at startup (non-blocking — server still starts while this resolves)
loadMessagesFromCloudinary().catch(e => console.error('Boot message load failed:', e));

try {
    if (fs.existsSync(USER_COLORS_FILE)) {
        Object.assign(userColors, JSON.parse(fs.readFileSync(USER_COLORS_FILE, 'utf8')));
    } else {
        fs.writeFileSync(USER_COLORS_FILE, JSON.stringify(userColors), 'utf8');
    }
} catch (e) { console.error('Error loading user colors:', e); }

// Debounce saves — write local immediately, push to Cloudinary every 20s max
let _msgSyncTimer = null;
function saveMessages() {
    const json = JSON.stringify(chatMessages);
    // Write local immediately (fast, survives short restarts)
    try { fs.writeFileSync(MESSAGES_FILE, json, 'utf8'); } catch (e) { console.error('Local msg save error:', e); }
    // Debounce Cloudinary upload
    clearTimeout(_msgSyncTimer);
    _msgSyncTimer = setTimeout(() => saveMessagesToCloudinary(), 20000);
}

async function saveMessagesToCloudinary() {
    try {
        const json = JSON.stringify(chatMessages);
        // Upload as a raw file — this overwrites the same public_id every time
        await new Promise((resolve, reject) => {
            const stream = cloudinary.uploader.upload_stream(
                {
                    resource_type: 'raw',
                    public_id: CLOUDINARY_MESSAGES_PUBLIC_ID,
                    overwrite: true,
                    invalidate: true,
                },
                (err, result) => err ? reject(err) : resolve(result)
            );
            stream.end(Buffer.from(json, 'utf8'));
        });
        // Also mirror to GitHub as a backup
        syncMessagesToGitHub().catch(e => console.warn('GitHub msg sync failed:', e.message));
        console.log(`Messages saved to Cloudinary (${chatMessages.length} total)`);
    } catch (e) {
        console.error('Cloudinary message save error:', e.message);
        // Fall back to GitHub only
        syncMessagesToGitHub().catch(() => {});
    }
}

async function syncMessagesToGitHub() {
    const token = process.env.GITHUB_TOKEN;
    const repo  = process.env.GITHUB_REPO;
    if (!token || !repo) return;
    const content = Buffer.from(JSON.stringify(chatMessages)).toString('base64');
    const apiUrl  = `https://api.github.com/repos/${repo}/contents/chat_messages.json`;
    let sha;
    try {
        const get = await fetch(apiUrl, {
            headers: { Authorization: `Bearer ${token}`, 'User-Agent': 'hatchat-server' }
        });
        if (get.ok) { const j = await get.json(); sha = j.sha; }
    } catch (_) {}
    await fetch(apiUrl, {
        method: 'PUT',
        headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json', 'User-Agent': 'hatchat-server' },
        body: JSON.stringify({ message: 'chore: sync messages [skip ci]', content, ...(sha ? { sha } : {}) })
    });
}

function saveUserColors() {
    try { fs.writeFileSync(USER_COLORS_FILE, JSON.stringify(userColors), 'utf8'); }
    catch (e) { console.error('Error saving user colors:', e); }
}

// ΓöÇΓöÇΓöÇ SOCKET.IO ΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇ
io.on('connection', (socket) => {
    const username = socket.handshake.query.username;
    const userColor = socket.handshake.query.color;

    if (!username) { socket.disconnect(); return; }

    if (userColor) { userColors[username] = userColor; saveUserColors(); }

    onlineUsers.add(username);
    users[socket.id] = { username, dnd: false };

    console.log(`User connected: ${username} (${socket.id})`);

    socket.on('user_join', (data) => {
        const uname = data.username;
        const prev = userConnectionCount[uname] || 0;
        userConnectionCount[uname] = prev + 1;

        if (prev === 0) {
            // Truly new arrival — announce and log it
            const ts = new Date().toISOString();
            const sysMsg = { type: 'system', message: `${uname} has joined the chat`, timestamp: ts };
            chatMessages.push(sysMsg);
            saveMessages();
            io.emit('user_join', { username: uname, users: Object.values(users), userColors, timestamp: ts });
        } else {
            // Just navigating between pages — silently refresh user list
            io.emit('update_users', { users: Object.values(users), userColors });
        }
        io.emit('refresh_all_users');
    });

    socket.on('chat_message', (data) => {
        const messageData = {
            type: 'message',
            username,
            message: data.message,
            timestamp: new Date().toISOString(),
            color: userColors[username],
            image: data.image || null,
            // ΓöÇΓöÇ Reply support: store whatever the client sent, or null ΓöÇΓöÇ
            replyTo: data.replyTo || null
        };
        chatMessages.push(messageData);
        saveMessages();
        io.emit('chat_message', messageData);
    });

    socket.on('load_messages', (data) => {
        const page = data.page || 1;
        const pageSize = 50;
        const start = Math.max(0, chatMessages.length - (page * pageSize));
        const end   = Math.max(0, chatMessages.length - ((page - 1) * pageSize));
        socket.emit('chat_history', {
            messages: chatMessages.slice(start, end).reverse(),
            page,
            totalMessages: chatMessages.length,
            hasMore: start > 0,
            userColors
        });
        if (page === 1) socket.emit('scroll_to_latest');
    });

    socket.on('update_color', (data) => {
        if (data.color) {
            userColors[username] = data.color;
            saveUserColors();
            io.emit('update_colors', { userColors });
        }
    });

    socket.on('dnd_toggle', (dndStatus) => {
        users[socket.id].dnd = dndStatus;
        io.emit('update_users', { users: Object.values(users) });
    });

    // ΓöÇΓöÇ Voice signalling ΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇ
    socket.on('voice_join', () => {
        const current = Object.entries(voiceMembers).map(([socketId, d]) => ({ socketId, username: d.username }));
        socket.emit('voice_current_members', current);
        voiceMembers[socket.id] = { username };
        socket.broadcast.emit('voice_user_joined', { socketId: socket.id, username });
    });

    socket.on('voice_leave', () => {
        delete voiceMembers[socket.id];
        io.emit('voice_user_left', { socketId: socket.id });
    });

    socket.on('voice_offer',  ({ to, offer })     => io.to(to).emit('voice_offer',  { from: socket.id, offer }));
    socket.on('voice_answer', ({ to, answer })    => io.to(to).emit('voice_answer', { from: socket.id, answer }));
    socket.on('voice_ice',    ({ to, candidate }) => io.to(to).emit('voice_ice',    { from: socket.id, candidate }));
    socket.on('voice_mute',   ({ muted })         => {
        if (voiceMembers[socket.id]) voiceMembers[socket.id].muted = muted;
        io.emit('voice_mute_update', { socketId: socket.id, muted });
    });

    io.emit('update_users', { users: Object.values(users) });

    socket.on('disconnect', () => {
        onlineUsers.delete(username);
        delete users[socket.id];
        console.log(`User disconnected: ${username}`);
        const snapSocketId = socket.id;

        // Decrement connection count for this username
        const prev = userConnectionCount[username] || 1;
        const next = prev - 1;
        if (next <= 0) {
            delete userConnectionCount[username];
            // Truly gone — announce leave
            const ts = new Date().toISOString();
            chatMessages.push({ type: 'system', message: `${username} has left the chat`, timestamp: ts });
            saveMessages();
            io.emit('user_leave', { username, users: Object.values(users), userColors, timestamp: ts });
            io.emit('refresh_all_users');
            if (voiceMembers[snapSocketId]) {
                delete voiceMembers[snapSocketId];
                io.emit('voice_user_left', { socketId: snapSocketId });
            }
        } else {
            userConnectionCount[username] = next;
            // Still on another page — just refresh user list silently
            io.emit('update_users', { users: Object.values(users) });
            io.emit('refresh_all_users');
        }
    });
});

// GET /api/search?q=keyword&user=username  — message search
// ?q=    keyword search (message body only, no usernames)
// ?user= show all messages by that user (newest first)
app.get('/api/search', (req, res) => {
    const { q, user } = req.query;
    if (!q && !user) return res.status(400).json({ success: false, message: 'Provide q or user param' });
    let results = chatMessages.filter(m => m.type === 'message');
    if (user) {
        results = results.filter(m => m.username && m.username.toLowerCase() === user.toLowerCase());
        results = results.slice().reverse(); // newest first
    } else if (q) {
        const term = q.toLowerCase().trim();
        results = results.filter(m => m.message && m.message.toLowerCase().includes(term));
        results = results.slice().reverse();
    }
    res.json({ success: true, results: results.slice(0, 200) }); // cap at 200
});

// ── STATIC PAGE ROUTES ────────────────────────────────────────────────────
app.get('/', (req, res) => res.sendFile(path.join(__dirname, 'index.html')));
app.get('/chat', (req, res) => res.sendFile(path.join(__dirname, 'chat.html')));
app.get('/clips', (req, res) => res.sendFile(path.join(__dirname, 'clips.html')));
app.get('/settings', (req, res) => res.sendFile(path.join(__dirname, 'settings.html')));

const PORT = process.env.PORT || 3000;
server.listen(PORT, () => console.log(`Server running on port ${PORT}`));

// ADMIN: reassign all clips to a given uploader
// POST /api/admin/reassign  { adminKey, uploader }
app.post('/api/admin/reassign', async (req, res) => {
    const { adminKey, uploader } = req.body || {};
    if (!adminKey || adminKey !== process.env.ADMIN_KEY) {
        return res.status(403).json({ success: false, message: 'Forbidden' });
    }
    if (!uploader) return res.status(400).json({ success: false, message: 'Missing uploader' });
    try {
        let updated = 0, nextCursor;
        do {
            const result = await cloudinary.api.resources({
                resource_type: 'video', type: 'upload',
                prefix: 'hatchat-clips/', max_results: 100,
                context: true, tags: true,
                ...(nextCursor ? { next_cursor: nextCursor } : {})
            });
            for (const r of result.resources) {
                await cloudinary.uploader.explicit(r.public_id, {
                    resource_type: 'video', type: 'upload',
                    context: `uploader=${uploader}`,
                    tags: [`uploader:${uploader}`]
                });
                updated++;
            }
            nextCursor = result.next_cursor;
        } while (nextCursor);
        res.json({ success: true, updated });
    } catch (e) {
        console.error('Reassign error:', e);
        res.status(500).json({ success: false, message: e.message });
    }
});

