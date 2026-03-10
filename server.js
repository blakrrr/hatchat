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

// ─── Cloudinary config ─────────────────────────────────────────────
cloudinary.config({
    cloud_name: process.env.CLOUDINARY_CLOUD_NAME,
    api_key:    process.env.CLOUDINARY_API_KEY,
    api_secret: process.env.CLOUDINARY_API_SECRET,
});

const app = express();

app.use(cors());
app.use(express.json());
app.use(express.urlencoded({ extended: true }));

// ─── STATIC FILES ──────────────────────────────────────────────────
app.use(express.static(path.join(__dirname, 'public')));
app.use(express.static(path.join(__dirname)));

const server = http.createServer(app);

const io = socketIo(server, {
    cors: {
        origin: [
            "https://hatchat.blakrr.works",
            "http://hatchat.blakrr.works",
            "https://averrgy-github-io.onrender.com",
            "*"
        ],
        methods: ["GET", "POST"]
    }
});

// ─── IMAGE UPLOAD (existing) ───────────────────────────────────────────────
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

// ─── CLIP UPLOAD — Cloudinary ─────────────────────────────────────────────
// Files are stored in Cloudinary under the "hatchat-clips" folder.
// Cloudinary handles CDN delivery, so clips load fast everywhere.
// The original filename is preserved as the public_id so NVIDIA date-names sort correctly.

// NVIDIA filename pattern: "Game Name YYYY.MM.DD - HH.MM.SS.frames.ext"
const NVIDIA_PATTERN = /\d{4}\.\d{2}\.\d{2}\s*-\s*\d{2}\.\d{2}\.\d{2}/;

// No size limit on multer — Cloudinary accepts any size and we compress on their end.
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
    // No fileSize limit — let Cloudinary handle oversized files
    limits: { files: 200 }
});

// POST /upload-clip — ONE file per request.
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
                        transformation: [{
                            start_offset: '-30',
                            bit_rate:     '1m',
                            quality:      'auto:low',
                            fetch_format: 'mp4',
                        }],
                        tags:    [`uploader:${uploader}`],
                        context: `uploader=${uploader}`,
                    },
                    (error, result) => error ? reject(error) : resolve(result)
                );
                stream.end(file.buffer);
            });

            file.buffer = null; // free RAM immediately
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

// DELETE /api/purge-unknown — removes clips tagged uploader:unknown
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

// DELETE /api/purge-all — removes EVERY clip in hatchat-clips/
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

// DELETE /api/clips/:public_id — only the original uploader can delete their clip
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

// GET /api/clips — returns all clips from Cloudinary, grouped by uploader then sorted by date
app.get('/api/clips', async (req, res) => {
    try {
        const result = await cloudinary.api.resources({
            resource_type: 'video',
            type: 'upload',
            prefix: 'hatchat-clips/',
            max_results: 200,
            context: true,  // fetch uploader metadata
            tags: true,
        });
        const clips = result.resources.map(r => {
            let uploader = 'unknown';
            if (r.context && r.context.custom && r.context.custom.uploader) {
                uploader = r.context.custom.uploader;
            } else if (r.tags) {
                const tag = r.tags.find(t => t.startsWith('uploader:'));
                if (tag) uploader = tag.replace('uploader:', '');
            }
            // Use the Cloudinary URL directly — ingest transformation already
            // stored the compressed+trimmed version as the canonical file.
            return {
                filename:   path.basename(r.public_id) + '.' + r.format,
                url:        r.secure_url,
                public_id:  r.public_id,
                created_at: r.created_at,
                uploader,
            };
        });
        // Sort: by uploader name, then newest-first within each uploader
        clips.sort((a, b) => {
            const u = a.uploader.localeCompare(b.uploader);
            if (u !== 0) return u;
            return new Date(b.created_at) - new Date(a.created_at);
        });
        res.json({ success: true, clips });
    } catch (error) {
        console.error('Cloudinary list error:', error);
        res.status(500).json({ success: false, message: 'Could not list clips' });
    }
});

// ─── CHAT DATA ────────────────────────────────────────────────────────────
const onlineUsers = new Set();
const userColors = {};
let users = {};
const voiceMembers = {};

const disconnectTimers = {};

// ─── ACCOUNTS ─────────────────────────────────────────────────────────────
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
}

// POST /api/register — username + password + color, no email needed
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

// GET /api/me?token=xxx — validate a stored session token
app.get('/api/me', (req, res) => {
    const { token } = req.query;
    if (!token) return res.status(401).json({ success: false });
    const user = Object.values(registeredUsers).find(u => u.sessionTokens?.includes(token));
    if (!user) return res.status(401).json({ success: false });
    res.json({ success: true, username: user.username, color: user.color });
});

// GET /api/all-users — all registered users + online status (for the user panel)
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

let chatMessages = [];
try {
    if (fs.existsSync(MESSAGES_FILE)) {
        chatMessages = JSON.parse(fs.readFileSync(MESSAGES_FILE, 'utf8'));
    } else {
        fs.writeFileSync(MESSAGES_FILE, JSON.stringify(chatMessages), 'utf8');
    }
} catch (e) { console.error('Error loading messages:', e); }

try {
    if (fs.existsSync(USER_COLORS_FILE)) {
        Object.assign(userColors, JSON.parse(fs.readFileSync(USER_COLORS_FILE, 'utf8')));
    } else {
        fs.writeFileSync(USER_COLORS_FILE, JSON.stringify(userColors), 'utf8');
    }
} catch (e) { console.error('Error loading user colors:', e); }

function saveMessages() {
    try { fs.writeFileSync(MESSAGES_FILE, JSON.stringify(chatMessages), 'utf8'); }
    catch (e) { console.error('Error saving messages:', e); }
}

function saveUserColors() {
    try { fs.writeFileSync(USER_COLORS_FILE, JSON.stringify(userColors), 'utf8'); }
    catch (e) { console.error('Error saving user colors:', e); }
}

// ─── SOCKET.IO ────────────────────────────────────────────────────────────
io.on('connection', (socket) => {
    const username = socket.handshake.query.username;
    const userColor = socket.handshake.query.color;

    if (!username) { socket.disconnect(); return; }

    if (userColor) { userColors[username] = userColor; saveUserColors(); }

    onlineUsers.add(username);
    users[socket.id] = { username, dnd: false };

    console.log(`User connected: ${username} (${socket.id})`);

    socket.on('user_join', (data) => {
        if (disconnectTimers[data.username]) {
            // User navigated between pages and reconnected quickly.
            // Cancel the pending "left" announcement and skip the "joined" one too.
            clearTimeout(disconnectTimers[data.username]);
            delete disconnectTimers[data.username];
            // Still refresh the user list so their dot shows up
            io.emit('update_users', { users: Object.values(users), userColors });
        } else {
            // Genuine fresh join — announce normally
            io.emit('user_join', { username: data.username, users: Object.values(users), userColors });
            chatMessages.push({ type: 'system', message: `${data.username} has joined the chat`, timestamp: new Date().toISOString() });
            saveMessages();
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
            // ── Reply support: store whatever the client sent, or null ──
            replyTo: data.replyTo || null
        };
        chatMessages.push(messageData);
        saveMessages();
        io.emit('chat_message', messageData);
    });

    socket.on('load_messages', (data) => {
        const page = data.page || 1;
        const pageSize = 20;
        const start = Math.max(0, chatMessages.length - (page * pageSize));
        const end = Math.max(0, chatMessages.length - ((page - 1) * pageSize));
        socket.emit('chat_history', {
            messages: chatMessages.slice(start, end).reverse(),
            page,
            totalMessages: chatMessages.length,
            userColors
        });
        // Tell the client to scroll to the bottom after the first page loads
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

    // ── Voice signalling ─────────────────────────────────────────────
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

        disconnectTimers[username] = setTimeout(() => {
            delete disconnectTimers[username];
            chatMessages.push({ type: 'system', message: `${username} has left the chat`, timestamp: new Date().toISOString() });
            saveMessages();
            io.emit('user_leave', { username, users: Object.values(users), userColors });
            io.emit('update_users', { users: Object.values(users) });
            // Notify all clients to refresh their all-users panel
            io.emit('refresh_all_users');
            if (voiceMembers[snapSocketId]) {
                delete voiceMembers[snapSocketId];
                io.emit('voice_user_left', { socketId: snapSocketId });
            }
        }, 5 * 60 * 1000);

        io.emit('update_users', { users: Object.values(users) });
        io.emit('refresh_all_users');
    });
});

// ─── STATIC PAGE ROUTES ───────────────────────────────────────────────────
app.get('/', (req, res) => res.sendFile(path.join(__dirname, 'index.html')));
app.get('/chat', (req, res) => res.sendFile(path.join(__dirname, 'chat.html')));
app.get('/clips', (req, res) => res.sendFile(path.join(__dirname, 'clips.html')));
app.get('/settings', (req, res) => res.sendFile(path.join(__dirname, 'settings.html')));

const PORT = process.env.PORT || 3000;
server.listen(PORT, () => console.log(`Server running on port ${PORT}`));
